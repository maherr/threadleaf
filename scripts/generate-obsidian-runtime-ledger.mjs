#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { API } from "typescript/unstable/sync";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const authorityHash = "ed358aa05694582597726321352494a9833b77c117991189e55761ced8326027";
const authorityBytes = 204_109;
const authorityLines = 8_498;
const authoritySourcePath = "public-api/obsidian.d.ts";
const authorityPath = path.join(
  repositoryRoot,
  "compatibility",
  "authority",
  "obsidian-1.13.7.d.ts",
);

const outputFiles = {
  source: path.join(repositoryRoot, "compatibility", "obsidian-runtime-ledger-source.v1.json"),
  ledger: path.join(repositoryRoot, "compatibility", "obsidian-runtime-ledger.v1.json"),
  testIndex: path.join(repositoryRoot, "compatibility", "obsidian-runtime-test-index.v1.json"),
  generated: path.join(repositoryRoot, "src", "generated", "obsidian-runtime-ledger.ts"),
  documentation: path.join(repositoryRoot, "docs", "compatibility", "obsidian-runtime-ledger.md"),
};

const allowedStatuses = new Set([
  "implemented",
  "partial",
  "unsupported",
  "missing",
  "internal-extra",
]);

function fail(message) {
  throw new Error(`Obsidian runtime ledger: ${message}`);
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`could not read JSON ${path.relative(repositoryRoot, filePath)}: ${String(error)}`);
  }
}

function writeOrCheck(filePath, content, check) {
  if (check) {
    const actual = existsSync(filePath) ? readFileSync(filePath, "utf8") : null;
    if (actual !== content) {
      fail(`generated output is stale: ${path.relative(repositoryRoot, filePath)}`);
    }
    return;
  }
  writeFileSync(filePath, content, "utf8");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedSignature(node, sourceFile) {
  // The declaration is selected and traversed through the TypeScript 7 AST. The small whitespace
  // normalization only makes the hash independent of declaration formatting; it is not a census
  // scanner and never decides which declarations exist.
  return node.getText(sourceFile).replace(/\s+/gu, " ").trim();
}

function parseAst(fileName, source) {
  const root = "/threadleaf-runtime-ledger";
  const virtualFileName = path.posix.join(root, path.basename(fileName));
  const files = {
    [`${root}/tsconfig.json`]: JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        target: "ES2023",
        skipLibCheck: true,
      },
      files: [path.basename(virtualFileName)],
    }),
    [virtualFileName]: source,
  };
  const api = new API({ cwd: root, fs: createVirtualFileSystem(files) });
  try {
    const project = api
      .updateSnapshot({ openProjects: [`${root}/tsconfig.json`] })
      .getProjects()[0];
    if (!project) {
      fail(`TypeScript did not create a project for ${fileName}`);
    }
    const sourceFile = project.program.getSourceFile(virtualFileName);
    if (!sourceFile) {
      fail(`TypeScript did not parse ${fileName}`);
    }
    return { api, sourceFile };
  } catch (error) {
    api.close();
    throw error;
  }
}

function isExported(node) {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
}

function nameOf(node, sourceFile) {
  if (node.name) {
    return node.name.getText(sourceFile);
  }
  if (ts.isVariableStatement(node)) {
    const declaration = node.declarationList.declarations[0];
    return declaration?.name.getText(sourceFile) ?? null;
  }
  return null;
}

function lineAndColumn(node, sourceFile) {
  const position = node.getStart(sourceFile);
  const location = sourceFile.getLineAndCharacterOfPosition(position);
  return { line: location.line + 1, column: location.character + 1 };
}

function visibilityOf(node) {
  const modifiers = node.modifiers ?? [];
  if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword)) {
    return "private";
  }
  if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ProtectedKeyword)) {
    return "protected";
  }
  return "public";
}

function modifierNames(node, sourceFile) {
  return [...(node.modifiers ?? [])].map((modifier) => modifier.getText(sourceFile));
}

function classMemberName(member, sourceFile) {
  if (ts.isConstructorDeclaration(member)) {
    return "constructor";
  }
  return member.name?.getText(sourceFile) ?? "<anonymous>";
}

function classMembers(classNode, sourceFile, exportId) {
  return classNode.members.map((member) => {
    const signature = normalizedSignature(member, sourceFile);
    const signatureHash = sha256(signature);
    const location = lineAndColumn(member, sourceFile);
    return {
      obligationId: `obligation:${exportId}:${signatureHash}`,
      name: classMemberName(member, sourceFile),
      kind: ts.SyntaxKind[member.kind],
      signature,
      signatureHash,
      visibility: visibilityOf(member),
      modifiers: modifierNames(member, sourceFile),
      static:
        member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ===
        true,
      optional: "questionToken" in member && member.questionToken !== undefined,
      location,
    };
  });
}

function heritageEdges(classNode, sourceFile, exportId) {
  const edges = [];
  for (const clause of classNode.heritageClauses ?? []) {
    for (const type of clause.types) {
      const signature = normalizedSignature(type, sourceFile);
      const signatureHash = sha256(signature);
      edges.push({
        edgeId: `heritage:${exportId}:${signatureHash}`,
        kind: ts.SyntaxKind[clause.token],
        target: signature,
        signatureHash,
        location: lineAndColumn(type, sourceFile),
      });
    }
  }
  return edges;
}

function publicRuntimeExports(sourceFile) {
  const entries = [];
  for (const statement of sourceFile.statements) {
    if (!isExported(statement)) {
      continue;
    }
    let kind = null;
    if (ts.isClassDeclaration(statement)) kind = "class";
    else if (ts.isFunctionDeclaration(statement)) kind = "function";
    else if (ts.isEnumDeclaration(statement)) kind = "enum";
    else if (ts.isVariableStatement(statement)) kind = "variable";
    if (!kind) {
      continue;
    }
    const declarations = ts.isVariableStatement(statement)
      ? [...statement.declarationList.declarations]
      : [statement];
    for (const declaration of declarations) {
      const name = nameOf(declaration, sourceFile);
      if (!name) {
        fail(
          `runtime export has no name at ${JSON.stringify(lineAndColumn(statement, sourceFile))}`,
        );
      }
      const signatureNode = ts.isVariableStatement(statement) ? statement : declaration;
      const signature = normalizedSignature(signatureNode, sourceFile);
      const signatureHash = sha256(signature);
      const exportId = `export:${kind}:${name}:${signatureHash}`;
      const entry = {
        exportId,
        name,
        kind,
        signature,
        signatureHash,
        location: lineAndColumn(statement, sourceFile),
        obligationIds: [],
        heritageEdgeIds: [],
      };
      if (ts.isClassDeclaration(statement)) {
        const obligations = classMembers(statement, sourceFile, exportId);
        const edges = heritageEdges(statement, sourceFile, exportId);
        entry.obligationIds = obligations.map(({ obligationId }) => obligationId);
        entry.heritageEdgeIds = edges.map(({ edgeId }) => edgeId);
        entry.obligations = obligations;
        entry.heritageEdges = edges;
      }
      entries.push(entry);
    }
  }
  return entries;
}

function returnObjectKeys(sourceFile) {
  let result = null;
  const visit = (node) => {
    if (
      ts.isReturnStatement(node) &&
      node.expression &&
      ts.isObjectLiteralExpression(node.expression)
    ) {
      result = node.expression;
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  if (!result) {
    fail("could not find the compatibility module return object");
  }
  const keys = [];
  for (const property of result.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      keys.push(property.name.getText(sourceFile));
      continue;
    }
    if (ts.isPropertyAssignment(property)) {
      keys.push(property.name.getText(sourceFile).replace(/^['"]|['"]$/gu, ""));
      continue;
    }
    fail(`unsupported compatibility module property: ${ts.SyntaxKind[property.kind]}`);
  }
  return keys;
}

function implementationBindings(sourcePath, sourceText) {
  const { api, sourceFile } = parseAst(sourcePath, sourceText);
  try {
    const bindings = new Map();
    for (const statement of sourceFile.statements) {
      if (!isExported(statement)) continue;
      if (ts.isClassDeclaration(statement) && statement.name) {
        bindings.set(statement.name.text, {
          kind: "class",
          members: new Set(statement.members.map((member) => classMemberName(member, sourceFile))),
        });
      } else if (ts.isFunctionDeclaration(statement) && statement.name) {
        bindings.set(statement.name.text, { kind: "function", members: new Set() });
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          const name = declaration.name.getText(sourceFile);
          bindings.set(name, { kind: "variable", members: new Set() });
        }
      }
    }
    return bindings;
  } finally {
    api.close();
  }
}

function markerIndex() {
  const markers = [];
  const roots = [path.join(repositoryRoot, "src"), path.join(repositoryRoot, "scripts")];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name.startsWith("."))
        continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (!/\.(?:ts|tsx|mjs|js)$/u.test(entry.name)) continue;
      const source = readFileSync(fullPath, "utf8");
      const pattern = /@compatibility-test-id\s+([a-z0-9][a-z0-9._-]*)/gu;
      for (const match of source.matchAll(pattern)) {
        const id = match[1];
        const offset = match.index ?? 0;
        const line = source.slice(0, offset).split("\n").length;
        markers.push({
          id,
          path: path.relative(repositoryRoot, fullPath).split(path.sep).join("/"),
          line,
        });
      }
    }
  };
  for (const root of roots) visit(root);
  markers.sort(
    (left, right) =>
      left.id.localeCompare(right.id) ||
      left.path.localeCompare(right.path) ||
      left.line - right.line,
  );
  const duplicates = new Set();
  for (const marker of markers) {
    if (duplicates.has(marker.id)) fail(`duplicate compatibility test marker: ${marker.id}`);
    duplicates.add(marker.id);
  }
  return markers;
}

function relativeRepositoryPath(value, label) {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value)) {
    fail(`${label} must be a non-empty repository-relative path`);
  }
  const normalized = value.split(path.sep).join("/");
  const resolved = path.resolve(repositoryRoot, normalized);
  if (resolved !== repositoryRoot && !resolved.startsWith(`${repositoryRoot}${path.sep}`)) {
    fail(`${label} escapes the repository: ${value}`);
  }
  return normalized;
}

function evidenceReferences(entry, label) {
  if (!Array.isArray(entry?.evidence) || entry.evidence.length === 0) {
    fail(`${label} requires at least one executable evidence reference`);
  }
  return entry.evidence.map((reference, index) => {
    if (!reference || typeof reference !== "object") {
      fail(`${label}.evidence[${index}] must contain an id and path`);
    }
    if (typeof reference.id !== "string" || reference.id.length === 0) {
      fail(`${label}.evidence[${index}].id must be a non-empty string`);
    }
    return {
      id: reference.id,
      path: relativeRepositoryPath(reference.path, `${label}.evidence[${index}].path`),
    };
  });
}

function validateSource(source, runtimeExports, factoryKeys, implementationMap, markers) {
  if (source?.schemaVersion !== 1 || typeof source.exports !== "object") {
    fail("manual source must have schemaVersion 1 and an exports object");
  }
  if (
    JSON.stringify(source.authority) !==
    JSON.stringify({
      version: "Obsidian 1.13.7",
      source: authoritySourcePath,
      sha256: authorityHash,
      bytes: authorityBytes,
      lines: authorityLines,
    })
  ) {
    fail("manual source authority metadata drifted");
  }
  for (const [name, entry] of Object.entries(source.exports)) {
    const declared = runtimeExports.find((candidate) => candidate.name === name);
    if (!declared) fail(`manual source targets unknown public export: ${name}`);
    if (!entry || typeof entry !== "object") fail(`manual source entry is invalid: ${name}`);
    if (entry.implementation) {
      const sourcePath = relativeRepositoryPath(
        entry.implementation.source,
        `${name}.implementation.source`,
      );
      if (!existsSync(path.join(repositoryRoot, sourcePath)))
        fail(`implementation source does not exist: ${sourcePath}`);
      const binding = implementationMap.get(name);
      if (!binding || binding.kind !== declared.kind)
        fail(`implementation binding kind mismatch for ${name}`);
      if (entry.implementation.exportName !== name)
        fail(`implementation exportName must equal ${name}`);
    }
    for (const reference of evidenceReferences(entry, name)) {
      const marker = markers.find((candidate) => candidate.id === reference.id);
      if (!marker) fail(`evidence marker is missing: ${reference.id}`);
      if (marker.path !== reference.path) {
        fail(
          `evidence marker path drifted for ${reference.id}: expected ${reference.path}, found ${marker.path}`,
        );
      }
    }
    if (!allowedStatuses.has(entry.status ?? "missing")) {
      fail(`manual source uses an invalid status for ${name}`);
    }
    const derivedStatus = deriveStatus(
      declared,
      entry,
      factoryKeys,
      implementationMap,
      new Set(markers.map((marker) => marker.id)),
    );
    if (entry.status && entry.status !== derivedStatus) {
      fail(`manual status for ${name} does not match executable derivation`);
    }
  }
  const extras = source.extras ?? {};
  for (const [name, entry] of Object.entries(extras)) {
    if (runtimeExports.some((candidate) => candidate.name === name))
      fail(`extra is a public export: ${name}`);
    if (entry?.status !== "internal-extra") fail(`extra ${name} must be internal-extra`);
    if (!factoryKeys.includes(name)) fail(`documented extra is not in the factory: ${name}`);
    for (const reference of evidenceReferences(entry, `extra ${name}`)) {
      const marker = markers.find((candidate) => candidate.id === reference.id);
      if (!marker) fail(`extra evidence marker is missing: ${reference.id}`);
      if (marker.path !== reference.path) {
        fail(
          `extra evidence marker path drifted for ${reference.id}: expected ${reference.path}, found ${marker.path}`,
        );
      }
    }
  }
  const factoryExtras = factoryKeys.filter(
    (key) => !runtimeExports.some((entry) => entry.name === key),
  );
  const documentedExtras = Object.keys(extras);
  if (factoryExtras.join("\n") !== documentedExtras.join("\n")) {
    fail("factory extras and documented internal extras drifted");
  }
}

function deriveStatus(declared, entry, factoryKeys, implementationMap, markerIds) {
  if (
    !entry?.implementation ||
    !factoryKeys.includes(declared.name) ||
    !implementationMap.has(declared.name)
  ) {
    return "missing";
  }
  const evidenceReady = entry.evidence.every((reference) => markerIds.has(reference.id));
  if (!evidenceReady) return "missing";
  const binding = implementationMap.get(declared.name);
  if (declared.kind !== binding.kind) return "missing";
  if (declared.kind !== "class") return "implemented";
  const declaredMembers = new Set(declared.obligations.map((obligation) => obligation.name));
  const coveredMembers = [...declaredMembers].filter((name) => binding.members.has(name));
  if (coveredMembers.length === 0) return "missing";
  return coveredMembers.length === declaredMembers.size ? "implemented" : "partial";
}

function createLedger(source, runtimeExports, factoryKeys, implementationMap, markers) {
  const markerIds = new Set(markers.map((marker) => marker.id));
  const exports = runtimeExports.map((declared) => {
    const manual = source.exports[declared.name] ?? null;
    const status = deriveStatus(declared, manual, factoryKeys, implementationMap, markerIds);
    return {
      exportId: declared.exportId,
      name: declared.name,
      kind: declared.kind,
      status,
      signatureHash: declared.signatureHash,
      location: declared.location,
      evidence: manual?.evidence ?? [],
      implementation: manual?.implementation ?? null,
      obligationIds: declared.obligationIds,
      heritageEdgeIds: declared.heritageEdgeIds,
    };
  });
  const classes = runtimeExports
    .filter((entry) => entry.kind === "class")
    .map((entry) => {
      const exportRecord = exports.find((candidate) => candidate.exportId === entry.exportId);
      return {
        exportId: entry.exportId,
        name: entry.name,
        status: exportRecord.status,
        obligations: entry.obligations,
        heritageEdges: entry.heritageEdges,
      };
    });
  const obligations = classes.flatMap((entry) => entry.obligations);
  const heritageEdges = classes.flatMap((entry) => entry.heritageEdges);
  const counts = {
    runtimeExports: exports.length,
    classes: exports.filter((entry) => entry.kind === "class").length,
    functions: exports.filter((entry) => entry.kind === "function").length,
    enums: exports.filter((entry) => entry.kind === "enum").length,
    variables: exports.filter((entry) => entry.kind === "variable").length,
    implemented: exports.filter((entry) => entry.status === "implemented").length,
    partial: exports.filter((entry) => entry.status === "partial").length,
    unsupported: exports.filter((entry) => entry.status === "unsupported").length,
    missing: exports.filter((entry) => entry.status === "missing").length,
    ownMembers: obligations.length,
    instanceMembers: obligations.filter((entry) => !entry.static).length,
    staticMembers: obligations.filter((entry) => entry.static).length,
    heritageEdges: heritageEdges.length,
    implementedObligations: obligations.filter((obligation) => {
      const owner = classes.find((entry) =>
        entry.obligations.some((candidate) => candidate.obligationId === obligation.obligationId),
      );
      return owner?.status === "implemented";
    }).length,
  };
  return {
    schemaVersion: 1,
    authority: {
      version: "Obsidian 1.13.7",
      source: authoritySourcePath,
      sha256: authorityHash,
      bytes: authorityBytes,
      lines: authorityLines,
    },
    counts,
    factory: {
      keys: factoryKeys,
      publicKeys: factoryKeys.filter((key) => runtimeExports.some((entry) => entry.name === key)),
      internalExtras: factoryKeys.filter(
        (key) => !runtimeExports.some((entry) => entry.name === key),
      ),
    },
    exports,
    classes,
    extras: source.extras ?? {},
  };
}

function generatedTypeScript(ledger) {
  return `/* Generated by scripts/generate-obsidian-runtime-ledger.mjs. Do not edit. */\nexport const obsidianRuntimeLedger = ${JSON.stringify(ledger, null, 2)} as const;\n\nexport type ObsidianRuntimeLedger = typeof obsidianRuntimeLedger;\n`;
}

function generatedMarkdown(ledger) {
  const rows = ledger.exports
    .map(
      (entry) =>
        `| ${entry.name} | ${entry.kind} | ${entry.status} | ${entry.signatureHash.slice(0, 16)} |`,
    )
    .join("\n");
  const obligationRows = ledger.classes
    .flatMap((entry) =>
      entry.obligations.map(
        (obligation) =>
          `| ${entry.name} | ${obligation.name} | ${obligation.kind} | ${obligation.static ? "static" : "instance"} | ${obligation.visibility} | ${obligation.signatureHash.slice(0, 16)} |`,
      ),
    )
    .join("\n");
  return `# Obsidian 1.13.7 runtime ledger\n\nThis file is generated from the pinned MIT declaration and the checked-in manual evidence source. The declaration is an authority for public shape, while executable Threadleaf tests determine status.\n\n## Authority and census\n\n- Authority: \`${ledger.authority.source}\`\n- SHA-256: \`${ledger.authority.sha256}\`\n- Runtime-valued exports: ${ledger.counts.runtimeExports} (${ledger.counts.classes} classes, ${ledger.counts.functions} functions, ${ledger.counts.enums} enum, ${ledger.counts.variables} variables)\n- Own class-member obligations: ${ledger.counts.ownMembers} (${ledger.counts.instanceMembers} instance, ${ledger.counts.staticMembers} static)\n- Heritage edges: ${ledger.counts.heritageEdges}\n- Factory keys: ${ledger.factory.keys.length} (${ledger.factory.publicKeys.length} public, ${ledger.factory.internalExtras.length} internal extra)\n\n## Export status\n\n| Export | Kind | Status | Signature |\n| --- | --- | --- | --- |\n${rows}\n\n## Class obligations\n\nEach row is one declaration-owned obligation. Overloads retain separate full-signature hashes. Inherited obligations are represented by heritage edges and are not double-counted.\n\n| Class | Member | AST kind | Staticness | Visibility | Signature |\n| --- | --- | --- | --- | --- | --- |\n${obligationRows}\n\n## Evidence policy\n\nThe allowed statuses are \`implemented\`, \`partial\`, \`unsupported\`, \`missing\`, and \`internal-extra\`. An implemented status requires a factory binding, an implementation binding, all declaration-owned member names for a class, and every referenced executable evidence marker.\n`;
}

function main() {
  const check = process.argv.includes("--check");
  if (!existsSync(authorityPath)) {
    fail(`authority declaration is missing at ${path.relative(repositoryRoot, authorityPath)}`);
  }
  const authoritySource = readFileSync(authorityPath, "utf8");
  const actualHash = sha256(authoritySource);
  if (actualHash !== authorityHash) fail(`authority SHA-256 mismatch: ${actualHash}`);
  if (Buffer.byteLength(authoritySource, "utf8") !== authorityBytes)
    fail("authority byte count drifted");
  const authorityLineCount = authoritySource.endsWith("\n")
    ? authoritySource.split("\n").length - 1
    : authoritySource.split("\n").length;
  if (authorityLineCount !== authorityLines) fail("authority line count drifted");

  const source = readJson(outputFiles.source);
  const declarationAst = parseAst(authoritySourcePath, authoritySource);
  const runtimeExports = publicRuntimeExports(declarationAst.sourceFile);
  declarationAst.api.close();
  const factoryAst = parseAst(
    "src/runtime/obsidian-compat.ts",
    readFileSync(path.join(repositoryRoot, "src/runtime/obsidian-compat.ts"), "utf8"),
  );
  const factoryKeys = returnObjectKeys(factoryAst.sourceFile);
  factoryAst.api.close();
  const implementationMap = new Map();
  const implementationPaths = new Set(
    Object.values(source.exports ?? {})
      .map((entry) => entry?.implementation?.source)
      .filter(Boolean),
  );
  for (const relativePath of implementationPaths) {
    const fullPath = path.join(repositoryRoot, relativePath);
    if (!existsSync(fullPath)) fail(`implementation source does not exist: ${relativePath}`);
    const bindings = implementationBindings(relativePath, readFileSync(fullPath, "utf8"));
    for (const [name, binding] of bindings) implementationMap.set(name, binding);
  }
  const markers = markerIndex();
  validateSource(source, runtimeExports, factoryKeys, implementationMap, markers);

  if (runtimeExports.length !== 158)
    fail(`runtime export census is ${runtimeExports.length}, expected 158`);
  if (runtimeExports.filter((entry) => entry.kind === "class").length !== 102)
    fail("class census drifted");
  if (runtimeExports.filter((entry) => entry.kind === "function").length !== 47)
    fail("function census drifted");
  if (runtimeExports.filter((entry) => entry.kind === "enum").length !== 1)
    fail("enum census drifted");
  if (runtimeExports.filter((entry) => entry.kind === "variable").length !== 8)
    fail("variable census drifted");
  const ownMembers = runtimeExports
    .filter((entry) => entry.kind === "class")
    .reduce((total, entry) => total + entry.obligations.length, 0);
  if (ownMembers !== 700) fail(`own-member census is ${ownMembers}, expected 700`);
  if (factoryKeys.length !== 74) fail(`factory census is ${factoryKeys.length}, expected 74`);
  if (
    factoryKeys.filter((key) => !runtimeExports.some((entry) => entry.name === key)).join(",") !==
    "sleep"
  )
    fail("factory extras drifted");

  const ledger = createLedger(source, runtimeExports, factoryKeys, implementationMap, markers);
  const testIndex = { schemaVersion: 1, markers };
  const outputs = [
    [outputFiles.ledger, `${JSON.stringify(ledger, null, 2)}\n`],
    [outputFiles.testIndex, `${JSON.stringify(testIndex, null, 2)}\n`],
    [outputFiles.generated, generatedTypeScript(ledger)],
    [outputFiles.documentation, generatedMarkdown(ledger)],
  ];
  for (const [filePath, content] of outputs) writeOrCheck(filePath, content, check);
  if (!check) {
    process.stdout.write(`Generated ${outputs.length} Obsidian runtime ledger outputs.\n`);
  }
}

main();
