import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicSpecPath = path.join(rootPath, "public-spec");
const sourcePath = path.join(publicSpecPath, "v1");
const dataPath = path.join(publicSpecPath, "data");
const schemaPath = path.join(publicSpecPath, "schemas");
const sitePath = path.join(publicSpecPath, "site");
const siteDataPath = path.join(sitePath, "data");
const siteSchemaPath = path.join(sitePath, "schemas");
const templatePath = path.join(publicSpecPath, "template.html");
const stylePath = path.join(publicSpecPath, "styles.css");
const scriptPath = path.join(publicSpecPath, "site.js");
const checkOnly = process.argv.includes("--check");

const packagePath = path.join(rootPath, "package.json");
const registrySourcePath = path.join(rootPath, "compatibility", "registry.v1.json");
const pluginEvidencePath = path.join(rootPath, "compatibility", "plugin-evidence.v1.json");
const pluginSourcePath = path.join(rootPath, "src", "shared", "plugins.ts");
const appearanceSourcePath = path.join(rootPath, "src", "shared", "appearance.ts");
const themeContractSourcePath = path.join(rootPath, "src", "shared", "theme-contract.ts");
const appearanceLoaderPath = path.join(rootPath, "src", "main", "vault-appearance-loader.ts");
const themePackageManagerPath = path.join(rootPath, "src", "main", "theme-package-manager.ts");
const cliSourcePath = path.join(rootPath, "src", "cli", "command-line.ts");
const cliSchemaSourcePath = path.join(rootPath, "src", "cli", "schema.ts");
const cliSchemaTestPath = path.join(rootPath, "src", "cli", "schema.test.ts");
const cliGuidePath = path.join(rootPath, "docs", "cli.md");
const contractPath = path.join(rootPath, "docs", "compatibility", "contract.md");
const migrationPath = path.join(rootPath, "docs", "compatibility", "migration.md");
const themeContractPath = path.join(rootPath, "docs", "compatibility", "themes.md");
const livePreviewPath = path.join(rootPath, "docs", "compatibility", "live-preview.md");
const markdownExtensionsPath = path.join(rootPath, "src", "renderer", "markdown-extensions.ts");
const jsonCanvasSourcePath = path.join(rootPath, "src", "application", "json-canvas.ts");
const jsonCanvasDocPath = path.join(rootPath, "docs", "compatibility", "contract.md");
const workspaceDocPath = path.join(rootPath, "docs", "architecture.md");
const markdownProcessorsPath = path.join(rootPath, "docs", "compatibility", "open-plugin-api.md");
const packageInspectionPath = path.join(rootPath, "docs", "compatibility", "package-inspection.md");
const nativeExtensionPath = path.join(rootPath, "docs", "compatibility", "native-extensions.md");
const excalidrawDocPath = path.join(rootPath, "docs", "compatibility", "excalidraw-roundtrip.md");
const corpusDefinitions = [
  {
    id: "threadleaf.same-vault.v1",
    directory: "same-vault-v1",
    manifestPath: path.join(rootPath, "fixtures", "corpus", "same-vault-v1", "manifest.json"),
    casesPath: path.join(rootPath, "fixtures", "corpus", "same-vault-v1", "cases.json"),
    provenancePath: path.join(rootPath, "fixtures", "corpus", "same-vault-v1", "PROVENANCE.md"),
    licensePath: path.join(rootPath, "fixtures", "corpus", "same-vault-v1", "LICENSE"),
  },
  {
    id: "threadleaf.excalidraw-roundtrip.v1",
    directory: "excalidraw-roundtrip-v1",
    manifestPath: path.join(
      rootPath,
      "fixtures",
      "corpus",
      "excalidraw-roundtrip-v1",
      "manifest.json",
    ),
    casesPath: path.join(rootPath, "fixtures", "corpus", "excalidraw-roundtrip-v1", "cases.json"),
    provenancePath: path.join(
      rootPath,
      "fixtures",
      "corpus",
      "excalidraw-roundtrip-v1",
      "PROVENANCE.md",
    ),
    licensePath: path.join(rootPath, "fixtures", "corpus", "excalidraw-roundtrip-v1", "LICENSE"),
    observationPath: path.join(
      rootPath,
      "fixtures",
      "corpus",
      "excalidraw-roundtrip-v1",
      "observations",
      "obsidian-roundtrip.v1.json",
    ),
  },
];
const sameVaultDefinition = corpusDefinitions[0];
const excalidrawDefinition = corpusDefinitions[1];

const generatedDataNames = [
  "index.v1.json",
  "api.v1.json",
  "cli.v1.json",
  "themes.v1.json",
  "fixtures.v1.json",
  "conformance.v1.json",
  "registry.v1.json",
];
const schemaNames = [
  "index.v1.schema.json",
  "api.v1.schema.json",
  "cli.v1.schema.json",
  "theme.v1.schema.json",
  "fixture.v1.schema.json",
  "conformance.v1.schema.json",
  "registry.v1.schema.json",
  "case.v1.schema.json",
];
const observationStatuses = new Set(["unverified", "observed"]);

function fail(message) {
  throw new Error(`Public specification: ${message}`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function text(value, label, maximum = 4_000) {
  assert(typeof value === "string", `${label} must be a string`);
  assert(value.length > 0 && value.length <= maximum, `${label} has an invalid length`);
  assert(value.trim() === value, `${label} must be trimmed`);
  assert(!/[\r\n\t]/u.test(value), `${label} must be one line`);
  assert(!/[\u2013\u2014]/u.test(value), `${label} contains a forbidden dash`);
  return value;
}

async function readText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    fail(
      `cannot read ${path.relative(rootPath, filePath)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    fail(
      `cannot parse ${path.relative(rootPath, filePath)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function existsFile(relativePath) {
  const filePath = path.join(rootPath, relativePath);
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function relativeSource(filePath) {
  return path.relative(rootPath, filePath).replaceAll(path.sep, "/");
}

function sourceRef(filePath, suffix = "") {
  return `${relativeSource(filePath)}${suffix}`;
}

function balancedBlock(source, marker, opening) {
  const markerIndex = source.indexOf(marker);
  assert(markerIndex >= 0, `could not find ${marker}`);
  const start = source.indexOf(opening, markerIndex + marker.length);
  assert(start >= 0, `could not find ${opening} after ${marker}`);
  const closing = opening === "[" ? "]" : "}";
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === opening) depth += 1;
    if (character === closing) {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  fail(`unclosed ${opening} block after ${marker}`);
}

function stringLiterals(block) {
  return [...block.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/gu)].map((match) =>
    JSON.parse(`"${match[1]}"`),
  );
}

function parseThemeContract(source) {
  const version = Number(source.match(/themeContractVersion\s*=\s*(\d+)/u)?.[1] ?? 0);
  const uri = source.match(/themeContractUri\s*=\s*"([^"\\]*(?:\\.[^"\\]*)*)"/u)?.[1];
  assert(Number.isInteger(version) && version > 0, "theme contract version is missing");
  assert(uri, "theme contract URI is missing");
  const tokenBlock = balancedBlock(source, "themeContractTokens", "[");
  const tokens = [...tokenBlock.matchAll(/\[\s*"([^"\\]+)"\s*,\s*"([^"\\]+)"\s*\]/gu)].map(
    (match) => ({ name: match[1], role: match[2] }),
  );
  const cueBlock = balancedBlock(source, "themeContractStateCues", "[");
  const stateCues = [
    ...cueBlock.matchAll(/\[\s*"([^"\\]+)"\s*,\s*"([^"\\]*(?:\\.[^"\\]*)*)"\s*\]/gu),
  ].map((match) => ({ state: match[1], cue: JSON.parse(`"${match[2]}"`) }));
  const schemeBlock = balancedBlock(source, "themeContractSchemes", "[");
  const schemes = stringLiterals(schemeBlock);
  assert(tokens.length > 0, "theme contract token list is empty");
  assert(stateCues.length > 0, "theme contract state cue list is empty");
  assert(schemes.length > 0, "theme contract scheme list is empty");
  return {
    version,
    uri: JSON.parse(`"${uri}"`),
    tokens,
    stateCues,
    schemes,
    source: sourceRef(themeContractSourcePath),
  };
}

function parseCapabilityDefinitions(source) {
  const block = balancedBlock(source, "pluginCapabilityDefinitions", "{");
  const definitions = [];
  const pattern =
    /(?:^|\n)\s*(?:"([A-Za-z0-9-]+)"|([A-Za-z0-9-]+)):\s*\{\s*label:\s*"([^"\\]*(?:\\.[^"\\]*)*)",\s*description:\s*"([^"\\]*(?:\\.[^"\\]*)*)",/gu;
  for (const match of block.matchAll(pattern)) {
    const id = match[1] ?? match[2];
    definitions.push({
      id,
      label: JSON.parse(`"${match[3]}"`),
      description: JSON.parse(`"${match[4]}"`),
      source: sourceRef(pluginSourcePath, "#pluginCapabilityDefinitions"),
    });
  }
  assert(definitions.length > 0, "plugin capability definitions are empty");
  return definitions;
}

function parseCliCommands(source, guide) {
  const marker = "type CliCommandId =";
  const start = source.indexOf(marker);
  assert(start >= 0, "CLI command ID union is missing");
  const end = source.indexOf(";", start);
  assert(end >= 0, "CLI command ID union is not terminated");
  const ids = [...source.slice(start, end).matchAll(/"([^"\n]+)"/gu)].map((match) => match[1]);
  assert(ids.length > 0, "CLI command ID union is empty");

  const guideRows = new Map();
  for (const line of guide.split("\n")) {
    if (!line.startsWith("|") || line.includes("---")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 3 || cells[0] === "Command") continue;
    const syntax = [...cells[0].matchAll(/`([^`]+)`/gu)].map((match) => match[1]);
    const output = cells[1].replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const authority = cells[2];
    for (const item of syntax) {
      guideRows.set(item, { syntax, output, authority });
    }
  }
  return ids.map((id) => {
    const guideRow = guideRows.get(id) ?? guideRows.get(id.replace(".", ":"));
    return {
      id,
      syntax: guideRow?.syntax ?? [],
      output: guideRow?.output ?? "See the CLI contract for the native projection.",
      authority: guideRow?.authority ?? "Native CLI contract",
      status: "implemented",
      source: sourceRef(cliSchemaSourcePath, "#CliCommandId"),
      documentation: sourceRef(cliGuidePath, "#current-commands"),
    };
  });
}

function parseNumberExpression(expression, label) {
  const normalized = expression.replaceAll(" ", "");
  const match = normalized.match(/^(\d+)(?:\*1024){0,2}$/u);
  assert(match, `${label} has an unsupported numeric expression`);
  return Number(match[1]) * 1024 ** (normalized.match(/\*1024/g) ?? []).length;
}

function parseAppearanceLimits(source) {
  const names = [
    ["themeCssBytes", "maxThemeBytes"],
    ["snippetCssBytes", "maxSnippetBytes"],
    ["manifestBytes", "maxManifestBytes"],
    ["combinedActiveCssBytes", "maxCombinedCssBytes"],
    ["catalogEntries", "maxCatalogEntries"],
  ];
  return names.map(([id, constant]) => {
    const match = source.match(new RegExp(`const ${constant}\\s*=\\s*([^;]+);`, "u"));
    assert(match, `appearance limit ${constant} is missing`);
    return {
      id,
      bytes: parseNumberExpression(match[1], constant),
      unit: id === "catalogEntries" ? "entries" : "bytes",
      source: sourceRef(appearanceLoaderPath, `#${constant}`),
    };
  });
}

function markdownAnchor(value) {
  return value
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .trim()
    .replace(/\s+/gu, "-");
}

function gate(pathValue, command, purpose) {
  return {
    path: text(pathValue, `${purpose}.path`, 500),
    command: text(command, `${purpose}.command`, 500),
  };
}

async function validateGateList(gates, label) {
  assert(Array.isArray(gates) && gates.length > 0, `${label} must have a gate`);
  for (const [index, item] of gates.entries()) {
    assert(isRecord(item), `${label}[${index}] must be an object`);
    assert(await existsFile(item.path), `${label}[${index}] references missing ${item.path}`);
    assert(
      !path.isAbsolute(item.path) && !item.path.split("/").includes(".."),
      `${label}[${index}] escapes the repository`,
    );
  }
}

async function buildFixtureData(definitions) {
  const fixtures = [];
  for (const definition of definitions) {
    const corpusManifest = await readJson(definition.manifestPath);
    const corpusCases = await readJson(definition.casesPath);
    const fixtureRoot = path.join(rootPath, "fixtures", "corpus", definition.directory);
    const fileEntries = [];
    async function walk(directory, relative = "") {
      const entries = await fs.readdir(path.join(directory, relative), { withFileTypes: true });
      for (const entry of entries.sort((left, right) =>
        left.name.localeCompare(right.name, "en"),
      )) {
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        const childPath = path.join(directory, childRelative);
        if (entry.isDirectory()) {
          await walk(directory, childRelative);
        } else {
          assert(entry.isFile(), `fixture entry ${childRelative} is not a regular file`);
          const bytes = await fs.readFile(childPath);
          fileEntries.push({ path: childRelative, bytes: bytes.length, sha256: sha256(bytes) });
        }
      }
    }
    await walk(fixtureRoot);
    const canonicalEntries = fileEntries.filter((entry) => entry.path.startsWith("vault/"));
    const declaredEntries = corpusManifest.files.map((entry) => ({
      path: `vault/${entry.path}`,
      bytes: entry.size,
      sha256: entry.sha256,
    }));
    assert(
      JSON.stringify(canonicalEntries) === JSON.stringify(declaredEntries),
      `${definition.directory} corpus manifest is stale`,
    );
    const license = await readText(definition.licensePath);
    const provenance = await readText(definition.provenancePath);
    const fixture = {
      id: corpusManifest.corpusId,
      root: `fixtures/corpus/${definition.directory}`,
      canonicalRoot: corpusManifest.root,
      schemaVersion: corpusManifest.schemaVersion,
      license: corpusCases.license,
      licensePath: relativeSource(definition.licensePath),
      licenseSha256: sha256(Buffer.from(license)),
      provenancePath: relativeSource(definition.provenancePath),
      provenanceSha256: sha256(Buffer.from(provenance)),
      manifestPath: relativeSource(definition.manifestPath),
      manifestSha256: sha256(Buffer.from(await fs.readFile(definition.manifestPath))),
      casesPath: relativeSource(definition.casesPath),
      casesSha256: sha256(Buffer.from(await fs.readFile(definition.casesPath))),
      cases: corpusCases.cases.map((entry) => ({
        id: text(entry.id, "fixture case id"),
        category: text(entry.category, "fixture case category"),
        support: entry.support,
      })),
      files: canonicalEntries,
      source: [
        sourceRef(definition.manifestPath),
        sourceRef(definition.casesPath),
        sourceRef(definition.provenancePath),
        sourceRef(definition.licensePath),
      ],
    };
    if (definition.observationPath) {
      const observation = await readJson(definition.observationPath);
      const observationStatus = text(observation.status, "observation status");
      assert(
        observationStatuses.has(observationStatus),
        "observation status must be unverified or observed",
      );
      fixture.observation = {
        path: relativeSource(definition.observationPath),
        sha256: sha256(Buffer.from(await fs.readFile(definition.observationPath))),
        status: observationStatus,
        method: text(observation.method, "observation method"),
        source: text(observation.source, "observation source"),
      };
      fixture.source.push(sourceRef(definition.observationPath));
    }
    fixtures.push(fixture);
  }
  return {
    schemaVersion: 1,
    uri: "urn:threadleaf:spec:v1:fixtures",
    fixtures,
  };
}

function buildConformanceData(version, registry) {
  const claims = [
    {
      id: "same-vault-corpus",
      title: "Same-vault behavior corpus",
      status: "verified",
      label: "normative",
      scope:
        "The checked-in corpus cases marked supported run through public kernel, application, and CLI surfaces.",
      threadleafVersion: version,
      evidence: [
        sourceRef(sameVaultDefinition.manifestPath),
        sourceRef(sameVaultDefinition.casesPath),
        sourceRef(sameVaultDefinition.provenancePath),
        sourceRef(sameVaultDefinition.licensePath),
      ],
      gates: [gate("src/corpus/same-vault-corpus.ts", "pnpm corpus:check", "same-vault corpus")],
      fixtures: ["threadleaf.same-vault.v1"],
      limitations: ["An unsupported case remains unsupported and is not counted as a pass."],
    },
    {
      id: "excalidraw-roundtrip-corpus",
      title: "Excalidraw format and round-trip corpus",
      status: "verified",
      label: "normative",
      scope:
        "Native scenes, Markdown scene fences, opaque compressed payloads, attachments, and revision conflicts have explicit byte or semantic contracts.",
      threadleafVersion: version,
      evidence: [
        sourceRef(excalidrawDefinition.manifestPath),
        sourceRef(excalidrawDefinition.casesPath),
        sourceRef(excalidrawDefinition.provenancePath),
        sourceRef(excalidrawDefinition.licensePath),
        sourceRef(excalidrawDefinition.observationPath),
        sourceRef(excalidrawDocPath),
      ],
      gates: [
        gate("src/corpus/excalidraw-roundtrip-corpus.ts", "pnpm corpus:check", "Excalidraw corpus"),
        gate("src/kernel/excalidraw-roundtrip.test.ts", "pnpm test", "Excalidraw format boundary"),
        gate(
          "scripts/check-excalidraw-roundtrip.mjs",
          "pnpm test:excalidraw-roundtrip",
          "Excalidraw packaged workflow",
        ),
      ],
      fixtures: ["threadleaf.excalidraw-roundtrip.v1"],
      limitations: [
        "The official Obsidian round-trip is an observed external oracle, not an executable Threadleaf gate, and is not counted as an executable pass.",
        "The packaged plugin workflow is an exact release observation, not universal Excalidraw parity.",
      ],
    },
    {
      id: "plugin-compatibility-registry",
      title: "Exact-version plugin evidence registry",
      status: "verified",
      label: "normative",
      scope:
        "Only exact plugin and Threadleaf versions in the generated registry carry a measured level.",
      threadleafVersion: version,
      evidence: [sourceRef(pluginEvidencePath), sourceRef(registrySourcePath)],
      gates: [
        gate(
          "scripts/generate-plugin-compatibility-registry.mjs",
          "pnpm compatibility:check",
          "plugin registry",
        ),
        gate("src/runtime/plugin-host.test.ts", "pnpm test", "plugin lifecycle"),
      ],
      fixtures: [],
      limitations: [
        "A package without an exact production-path fixture remains discovered at level 0.",
      ],
    },
    {
      id: "theme-catalog-and-loader",
      title: "Theme and snippet catalog",
      status: "verified",
      label: "normative",
      scope:
        "Contained theme and snippet discovery, bounded loading, CSS rejection, and watcher behavior.",
      threadleafVersion: version,
      evidence: [
        sourceRef(themeContractPath),
        sourceRef(appearanceSourcePath),
        sourceRef(appearanceLoaderPath),
        sourceRef(themePackageManagerPath),
      ],
      gates: [
        gate("src/main/vault-appearance-loader.test.ts", "pnpm test", "theme loader"),
        gate(
          "scripts/check-appearance-watcher.mjs",
          "pnpm test:appearance-watcher",
          "appearance watcher",
        ),
        gate("src/main/theme-package-manager.test.ts", "pnpm test", "appearance package lifecycle"),
      ],
      fixtures: [],
      limitations: [
        "Package lifecycle is offline and local-file-only; no network theme store or remote package source is claimed.",
      ],
    },
    {
      id: "native-cli",
      title: "Native command-line contract",
      status: "verified",
      label: "normative",
      scope:
        "The current versioned native CLI command IDs, syntax aliases, exit codes, and output contracts are executable without Electron or network access.",
      threadleafVersion: version,
      evidence: [
        sourceRef(cliSourcePath),
        sourceRef(cliSchemaSourcePath),
        sourceRef(cliSchemaTestPath),
        sourceRef(cliGuidePath),
      ],
      gates: [
        gate("src/cli/command-line.test.ts", "pnpm test", "CLI contract"),
        gate("src/cli/schema.test.ts", "pnpm test -- src/cli/schema.test.ts", "CLI shell runtime"),
      ],
      fixtures: ["threadleaf.same-vault.v1"],
      limitations: [
        "Familiar external CLI spellings are separate compatibility targets and may remain unsupported.",
      ],
    },
    {
      id: "migration-preview-and-apply",
      title: "Reviewed migration apply, recovery, and rollback",
      status: "verified",
      label: "normative",
      scope:
        "Migration preview is bounded and read-only; reviewed selections apply only private Threadleaf state through a journal with interruption recovery and rollback conflict checks.",
      threadleafVersion: version,
      evidence: [
        sourceRef(migrationPath),
        sourceRef(path.join(rootPath, "src", "main", "obsidian-migration-transaction.ts")),
      ],
      gates: [
        gate("src/main/obsidian-migration-loader.test.ts", "pnpm test", "migration preview"),
        gate(
          "src/main/obsidian-migration-transaction.test.ts",
          "pnpm test",
          "migration transaction",
        ),
        gate(
          "scripts/check-migration-apply.mjs",
          "pnpm test:migration-apply",
          "migration apply workflow",
        ),
      ],
      fixtures: [],
      limitations: [
        "Apply and rollback never write .obsidian or vault Markdown bytes, and plugin code is not executed inside the transaction.",
      ],
    },
    {
      id: "live-preview-source-mapping",
      title: "Live Preview and source mapping",
      status: "not-verified",
      label: "normative",
      scope:
        "Live, Source, and Read modes share canonical Markdown bytes, bounded UTF-16 source mappings, reveal rules, and explicit source fallbacks.",
      threadleafVersion: version,
      evidence: [
        sourceRef(livePreviewPath),
        sourceRef(path.join(rootPath, "src", "renderer", "live-preview.ts")),
        sourceRef(markdownExtensionsPath),
      ],
      gates: [
        gate("src/renderer/live-preview.test.ts", "pnpm test", "Live Preview mapping"),
        gate(
          "scripts/check-live-preview.mjs",
          "pnpm test:live-preview",
          "Live Preview packaged workflow",
        ),
      ],
      fixtures: [],
      limitations: [
        "Duplicate or malformed footnotes, malformed or ambiguous tables, unknown or malformed math, HTML, diagrams, and inline Live Preview processors remain source-visible.",
        "Canonical Electron Live Preview workflow proof is pending; local unit and static checks do not establish this public conformance claim.",
      ],
    },
    {
      id: "json-canvas",
      title: "JSON Canvas byte and editing boundary",
      status: "verified",
      label: "normative",
      scope:
        "Canvas documents are parsed, rendered, edited, and saved through the recoverable vault boundary while preserving unrelated JSON structure and file bytes on no-op round trips.",
      threadleafVersion: version,
      evidence: [
        sourceRef(jsonCanvasSourcePath),
        sourceRef(path.join(rootPath, "src", "shared", "json-canvas.ts")),
        sourceRef(jsonCanvasDocPath),
      ],
      gates: [
        gate("src/application/json-canvas.test.ts", "pnpm test", "JSON Canvas application"),
        gate(
          "scripts/check-json-canvas.mjs",
          "pnpm test:json-canvas",
          "JSON Canvas packaged workflow",
        ),
      ],
      fixtures: ["threadleaf.same-vault.v1"],
      limitations: [
        "Canvas editing is not a claim about arbitrary proprietary canvas extensions or unsupported node types.",
      ],
    },
    {
      id: "workspace-docks-settings",
      title: "Workspace panes, docks, pop-outs, and settings",
      status: "verified",
      label: "normative",
      scope:
        "Per-vault workspace panes, pinned tabs, docks, plugin pop-outs, application settings, and key bindings persist outside the vault with revision and recovery checks.",
      threadleafVersion: version,
      evidence: [
        sourceRef(workspaceDocPath),
        sourceRef(path.join(rootPath, "src", "shared", "workspace-layout.ts")),
        sourceRef(path.join(rootPath, "src", "shared", "workspace-settings.ts")),
      ],
      gates: [
        gate("scripts/check-workspace-panes.mjs", "pnpm test:workspace-panes", "workspace panes"),
        gate(
          "scripts/check-workspace-docks-popouts.mjs",
          "pnpm test:workspace-docks-popouts",
          "workspace docks and pop-outs",
        ),
        gate("src/shared/workspace-settings.test.ts", "pnpm test", "workspace settings"),
      ],
      fixtures: [],
      limitations: [
        "Private application state is not a portable vault format and is not written into .obsidian.",
      ],
    },
    {
      id: "markdown-processors",
      title: "Markdown processor compatibility",
      status: "verified",
      label: "normative",
      scope:
        "Trusted desktop plugins can register bounded fenced-code and post-processing callbacks with deterministic ordering, context, failure, and child lifecycle behavior.",
      threadleafVersion: version,
      evidence: [
        sourceRef(markdownProcessorsPath),
        sourceRef(path.join(rootPath, "src", "runtime", "obsidian-markdown-processors.ts")),
      ],
      gates: [
        gate(
          "src/runtime/obsidian-markdown-processors.test.ts",
          "pnpm test",
          "Markdown processor compatibility",
        ),
      ],
      fixtures: [],
      limitations: [
        "Inline Live Preview processors, arbitrary section partitioning, and plugin-owned network or filesystem adapters are unsupported.",
      ],
    },
    {
      id: "plugin-package-inspection",
      title: "Exact plugin package inspection",
      status: "verified",
      label: "normative",
      scope:
        "Exact package bytes and manifests are checked before activation, including static authority evidence, bounded trusted activation, registration inventory, cleanup, timeout, and disposable-root diffs.",
      threadleafVersion: version,
      evidence: [
        sourceRef(packageInspectionPath),
        sourceRef(path.join(rootPath, "src", "main", "plugin-package-inspection.ts")),
      ],
      gates: [
        gate(
          "src/main/plugin-package-inspection.test.ts",
          "pnpm test",
          "plugin package inspection",
        ),
        gate(
          "scripts/check-plugin-package-inspection-e2e.mjs",
          "pnpm test:plugin-package-inspection",
          "plugin package inspection e2e",
        ),
      ],
      fixtures: [],
      limitations: [
        "Inspection and cleanup are not an OS sandbox; synchronous code, unobserved paths, and host authority outside the disposable root remain outside coverage.",
      ],
    },
    {
      id: "native-extension-foundation",
      title: "Native extension capability foundation",
      status: "verified",
      label: "normative",
      scope:
        "Versioned manifests, exact bundle and authority digests, per-vault grants, typed capability ports, revocation, safe mode, deadlines, teardown, and cross-vault checks form the native foundation.",
      threadleafVersion: version,
      evidence: [
        sourceRef(nativeExtensionPath),
        sourceRef(path.join(rootPath, "src", "native-extension", "host.ts")),
      ],
      gates: [
        gate(
          "src/native-extension/native-extension.test.ts",
          "pnpm test",
          "native extension capability foundation",
        ),
      ],
      fixtures: [],
      limitations: [
        "The first host is in-process and reports sandboxed: false; production bundle evaluation and OS process isolation are not wired into this foundation.",
        "Desktop navigation, subprocess, secrets, and dynamic-code ports are trusted desktop escapes, not portable sandboxed capabilities.",
      ],
    },
    {
      id: "public-spec-build",
      title: "Public specification build",
      status: "verified",
      label: "normative",
      scope:
        "Generated tables, schemas, local links, anchors, fixture hashes, exact versions, and offline assets are checked together.",
      threadleafVersion: version,
      evidence: [sourceRef(templatePath), sourceRef(stylePath), sourceRef(scriptPath)],
      gates: [
        gate("scripts/check-public-spec.mjs", "pnpm public-spec:check", "public specification"),
      ],
      fixtures: [],
      limitations: ["Publishing the generated site remains a maintainer-authorized operation."],
    },
  ];
  const gaps = [
    {
      id: "native-extension-production-wiring",
      title: "Native extension production bundle wiring",
      status: "not-verified",
      label: "informative",
      reason:
        "The native capability host is exercised through a typed fixture entrypoint; production bundle evaluation and OS process isolation are not wired into this foundation.",
      source: sourceRef(nativeExtensionPath, `#${markdownAnchor("Lifecycle and trust")}`),
    },
    {
      id: "trusted-plugin-sandbox",
      title: "Trusted community plugin sandbox",
      status: "not-verified",
      label: "informative",
      reason:
        "Community plugin inspection and grants make trust explicit but do not sandbox Node-capable plugin code or prove absence of omitted authority.",
      source: sourceRef(contractPath, `#${markdownAnchor("Compatibility-host resource policy")}`),
    },
    {
      id: "universal-plugin-parity",
      title: "Universal community plugin parity",
      status: "not-verified",
      label: "informative",
      reason:
        "Compatibility is measured per exact release and named workflow; discovery, static inspection, or one plugin pass is not universal parity.",
      source: sourceRef(contractPath, `#${markdownAnchor("Evidence sources")}`),
    },
  ];
  return {
    schemaVersion: 1,
    uri: "urn:threadleaf:spec:v1:conformance",
    threadleafVersion: version,
    terminology: {
      normative: "A normative requirement uses MUST or MUST NOT and is eligible for conformance.",
      informative: "An informative note explains scope or a gap and is not an acceptance claim.",
      verified: "A verified claim has at least one executable gate and exact Threadleaf version.",
      notVerified: "A not-verified claim is visible context and cannot be presented as passing.",
    },
    claims,
    gaps,
    registryEntries: registry.entries.map((entry) => ({
      id: entry.plugin.id,
      version: entry.plugin.version,
      threadleafVersion: entry.threadleafVersion,
      compatibilityLevel: entry.compatibilityLevel,
    })),
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function inlineCode(value) {
  return `<code>${escapeHtml(value)}</code>`;
}

function linkToRepo(relativePath, label = relativePath) {
  return `<a href="../../${escapeHtml(relativePath)}">${escapeHtml(label)}</a>`;
}

function statusBadge(status) {
  const icon =
    status === "verified" || status === "passed" ? "✓" : status === "not-verified" ? "?" : "!";
  return `<span class="status status-${escapeHtml(status)}"><span aria-hidden="true">${icon}</span> ${escapeHtml(status)}</span>`;
}

function renderConformanceRows(conformance) {
  return conformance.claims
    .map((claim) => {
      const gates = claim.gates
        .map((item) => `${inlineCode(item.command)} via ${linkToRepo(item.path)}`)
        .join("<br />");
      const limitations = claim.limitations.map(escapeHtml).join(" ");
      return `<tr><th scope="row">${escapeHtml(claim.title)}</th><td>${statusBadge(claim.status)}</td><td>${inlineCode(claim.threadleafVersion)}</td><td>${gates}</td><td>${limitations}</td></tr>`;
    })
    .join("\n");
}

function renderRegistryRows(registry) {
  return registry.entries
    .map(
      (entry) =>
        `<tr><th scope="row">${escapeHtml(entry.plugin.name)}</th><td>${inlineCode(entry.plugin.version)}</td><td>${inlineCode(entry.threadleafVersion)}</td><td><span class="level">L${entry.compatibilityLevel}</span></td><td>${escapeHtml(entry.evidenceMode)}</td><td>${escapeHtml(entry.lastTested)}</td></tr>`,
    )
    .join("\n");
}

function renderApiRows(api) {
  return api.capabilities
    .map(
      (capability) =>
        `<tr><th scope="row">${inlineCode(capability.id)}</th><td>${escapeHtml(capability.label)}</td><td>${escapeHtml(capability.description)}</td><td>${linkToRepo(capability.source.split("#")[0])}</td></tr>`,
    )
    .join("\n");
}

function renderThemeRows(themes) {
  return themes.limits
    .map(
      (limit) =>
        `<tr><th scope="row">${escapeHtml(limit.id)}</th><td>${escapeHtml(limit.display)}</td><td>${linkToRepo(limit.source.split("#")[0])}</td></tr>`,
    )
    .join("\n");
}

function renderCliRows(cli) {
  return cli.commands
    .map(
      (command) =>
        `<tr><th scope="row">${inlineCode(command.id)}</th><td>${command.syntax.map(inlineCode).join("<br />") || '<span class="muted">native form</span>'}</td><td>${escapeHtml(command.authority)}</td></tr>`,
    )
    .join("\n");
}

function renderFixtureRows(fixtures) {
  return fixtures.fixtures
    .map(
      (fixture) =>
        `<tr><th scope="row">${escapeHtml(fixture.id)}</th><td>${escapeHtml(fixture.license)}</td><td>${fixture.cases.length}</td><td>${linkToRepo(fixture.manifestPath)}<br />${inlineCode(fixture.manifestSha256)}</td><td>${linkToRepo(fixture.casesPath)}<br />${inlineCode(fixture.casesSha256)}</td></tr>`,
    )
    .join("\n");
}

function renderGapRows(conformance) {
  return conformance.gaps
    .map(
      (gap) =>
        `<tr><th scope="row">${escapeHtml(gap.title)}</th><td>${statusBadge(gap.status)}</td><td>${escapeHtml(gap.reason)}</td><td>${linkToRepo(gap.source.split("#")[0])}</td></tr>`,
    )
    .join("\n");
}

function renderTemplate(template, context) {
  let output = template;
  for (const [key, value] of Object.entries(context)) {
    output = output.replaceAll(`@@${key}@@`, value);
  }
  const leftovers = output.match(/@@[A-Z0-9_]+@@/gu);
  assert(!leftovers, `site template has unresolved placeholders: ${leftovers?.join(", ")}`);
  return output;
}

async function buildModel() {
  const packageJson = await readJson(packagePath);
  assert(
    isRecord(packageJson) && typeof packageJson.version === "string",
    "package version is missing",
  );
  const version = text(packageJson.version, "package version", 100);
  const pluginSource = await readText(pluginSourcePath);
  const appearanceSource = await readText(appearanceSourcePath);
  const themeContractSource = await readText(themeContractSourcePath);
  const appearanceLoader = await readText(appearanceLoaderPath);
  const cliSource = await readText(cliSourcePath);
  const cliSchemaSource = await readText(cliSchemaSourcePath);
  const cliGuide = await readText(cliGuidePath);
  const registry = await readJson(registrySourcePath);
  const pluginEvidence = await readJson(pluginEvidencePath);
  assert(registry.threadleafVersion === version, "plugin registry version is stale");
  assert(pluginEvidence.schemaVersion === 1, "plugin evidence schema is unsupported");

  const api = {
    schemaVersion: 1,
    uri: "urn:threadleaf:spec:v1:api",
    threadleafVersion: version,
    implementationClassifications: [
      {
        id: "portable-native",
        label: "Portable native",
        source: sourceRef(contractPath, "#Evidence sources"),
      },
      {
        id: "desktop-compatibility-only",
        label: "Desktop compatibility only",
        source: sourceRef(contractPath, "#Levels"),
      },
      { id: "unavailable", label: "Unavailable", source: sourceRef(contractPath, "#Levels") },
    ],
    compatibilityLevels: [
      { level: 0, name: "Discovered", evidence: "Valid manifest and bundle found." },
      { level: 1, name: "Loaded", evidence: "Bundle evaluated and plugin instance constructed." },
      { level: 2, name: "Activated", evidence: "onload completed without an uncaught error." },
      {
        level: 3,
        name: "Integrated",
        evidence: "Commands, events, views, or processors registered as expected.",
      },
      {
        level: 4,
        name: "Workflow verified",
        evidence: "A representative user workflow passed end to end.",
      },
    ],
    capabilities: parseCapabilityDefinitions(pluginSource),
    surfaces: [
      {
        id: "vault-kernel",
        classification: "portable-native",
        status: "measured",
        source: sourceRef(contractPath, "#Same-vault behavior corpus"),
      },
      {
        id: "cli",
        classification: "portable-native",
        status: "measured",
        source: sourceRef(cliGuidePath, "#JSON-contract"),
      },
      {
        id: "theme-loader",
        classification: "desktop-compatibility-only",
        status: "measured",
        source: sourceRef(themeContractPath, "#Loader-boundaries"),
      },
      {
        id: "community-plugin-runtime",
        classification: "desktop-compatibility-only",
        status: "measured",
        source: sourceRef(contractPath, "#Compatibility-host-resource-policy"),
      },
      {
        id: "migration-preview",
        classification: "desktop-compatibility-only",
        status: "measured",
        source: sourceRef(migrationPath, "#Source-boundary"),
      },
      {
        id: "migration-apply-recovery-rollback",
        classification: "desktop-compatibility-only",
        status: "measured",
        source: sourceRef(migrationPath, "#Evidence"),
      },
      {
        id: "excalidraw-roundtrip",
        classification: "portable-native",
        status: "measured",
        source: sourceRef(excalidrawDocPath, "#Round-trip claims"),
      },
      {
        id: "live-preview",
        classification: "portable-native",
        status: "measured",
        source: sourceRef(livePreviewPath, "#Source/decorated mapping"),
      },
      {
        id: "json-canvas",
        classification: "portable-native",
        status: "measured",
        source: sourceRef(contractPath, "#Same-vault behavior corpus"),
      },
      {
        id: "workspace-docks-settings",
        classification: "desktop-compatibility-only",
        status: "measured",
        source: sourceRef(workspaceDocPath, "#Workspace panes, tabs, and draft ownership"),
      },
      {
        id: "markdown-processors",
        classification: "desktop-compatibility-only",
        status: "measured",
        source: sourceRef(markdownProcessorsPath, "#Observable behavior"),
      },
      {
        id: "plugin-package-inspection",
        classification: "desktop-compatibility-only",
        status: "measured",
        source: sourceRef(packageInspectionPath),
      },
      {
        id: "native-extension-foundation",
        classification: "portable-native",
        status: "measured",
        source: sourceRef(nativeExtensionPath, "#Enforced ports"),
      },
    ],
  };

  const limits = parseAppearanceLimits(appearanceLoader).map((limit) => ({
    ...limit,
    display: `${limit.bytes.toLocaleString("en-US")} ${limit.unit}`,
  }));
  const colorSchemeBlock = balancedBlock(appearanceSource, "colorSchemePreferences", "[");
  const themeContract = parseThemeContract(themeContractSource);
  const themes = {
    schemaVersion: 1,
    uri: "urn:threadleaf:spec:v1:themes",
    threadleafVersion: version,
    colorSchemes: stringLiterals(colorSchemeBlock),
    themeContract,
    assetIds: [
      {
        kind: "theme",
        prefix: "obsidian-theme:",
        source: sourceRef(appearanceSourcePath, "#appearanceAssetIdPatterns"),
      },
      {
        kind: "snippet",
        prefix: "obsidian-snippet:",
        source: sourceRef(appearanceSourcePath, "#appearanceAssetIdPatterns"),
      },
    ],
    limits,
    cascade: [
      {
        order: 1,
        layer: "Threadleaf baseline",
        source: sourceRef(themeContractPath, "#Cascade-order"),
      },
      { order: 2, layer: "Selected theme", source: sourceRef(themeContractPath, "#Cascade-order") },
      {
        order: 3,
        layer: "Enabled snippets in persisted order",
        source: sourceRef(themeContractPath, "#Cascade-order"),
      },
    ],
    gates: [
      gate("src/shared/theme-contract.test.ts", "pnpm test", "theme token contract"),
      gate("src/main/vault-appearance-loader.test.ts", "pnpm test", "theme loader"),
      gate(
        "scripts/check-appearance-watcher.mjs",
        "pnpm test:appearance-watcher",
        "appearance watcher",
      ),
    ],
  };

  const cli = {
    schemaVersion: 1,
    uri: "urn:threadleaf:spec:v1:cli",
    threadleafVersion: version,
    cliSchemaVersion: Number(cliSource.match(/export const cliSchemaVersion = (\d+);/u)?.[1] ?? 0),
    commands: parseCliCommands(cliSchemaSource, cliGuide),
    shellRuntime: {
      shells: ["bash", "zsh", "fish", "powershell"],
      authority: "Static shell generators and parser metadata share src/cli/schema.ts.",
      source: [sourceRef(cliSchemaSourcePath), sourceRef(cliSchemaTestPath)],
      fallback:
        "Bash and Fish execute installed-shell fixtures; Zsh and PowerShell use deterministic static checks when unavailable, while PowerShell runs TabExpansion2 when installed.",
      gates: [
        gate("src/cli/schema.test.ts", "pnpm test -- src/cli/schema.test.ts", "CLI shell runtime"),
        gate("src/cli/schema.ts", "pnpm typecheck", "CLI shell generator"),
      ],
    },
    exitCodes: [
      { name: "success", code: 0 },
      { name: "internal", code: 1 },
      { name: "usage", code: 2 },
      { name: "vault", code: 3 },
      { name: "query", code: 4 },
      { name: "conflict", code: 5 },
    ],
    outputFormats: ["human-readable", "json", "tsv", "csv"],
    gates: [
      gate("src/cli/command-line.test.ts", "pnpm test", "CLI contract"),
      gate("src/cli/schema.test.ts", "pnpm test -- src/cli/schema.test.ts", "CLI shell runtime"),
    ],
    source: [sourceRef(cliSourcePath), sourceRef(cliSchemaSourcePath), sourceRef(cliGuidePath)],
  };

  const fixtures = await buildFixtureData(corpusDefinitions);
  const conformance = buildConformanceData(version, registry);
  const index = {
    schemaVersion: 1,
    uri: "urn:threadleaf:spec:v1",
    threadleafVersion: version,
    versionPolicy: {
      specification: "v1",
      compatibility:
        "Exact Threadleaf version and exact fixture or bundle release are required for a verified claim.",
      uri: "urn:threadleaf:spec:v1",
    },
    labels: {
      normative: "Normative requirements are eligible for conformance and use MUST or MUST NOT.",
      informative: "Informative context explains scope, provenance, or an explicit gap.",
    },
    datasets: generatedDataNames.filter((name) => name !== "index.v1.json"),
    schemas: schemaNames,
    sources: [
      sourceRef(contractPath),
      sourceRef(cliGuidePath),
      sourceRef(themeContractPath),
      sourceRef(themeContractSourcePath),
      sourceRef(migrationPath),
      sourceRef(livePreviewPath),
      sourceRef(excalidrawDocPath),
      sourceRef(markdownProcessorsPath),
      sourceRef(packageInspectionPath),
      sourceRef(nativeExtensionPath),
      sourceRef(pluginEvidencePath),
      ...corpusDefinitions.flatMap((definition) => [
        sourceRef(definition.manifestPath),
        sourceRef(definition.casesPath),
        sourceRef(definition.provenancePath),
        sourceRef(definition.licensePath),
        ...(definition.observationPath ? [sourceRef(definition.observationPath)] : []),
      ]),
    ],
    generatedBy: "scripts/generate-public-spec.mjs",
  };
  const model = { index, api, cli, themes, fixtures, conformance, registry };
  for (const value of Object.values(model)) {
    const serialized = JSON.stringify(value);
    assert(!/[\u2013\u2014]/u.test(serialized), "generated model contains a forbidden dash");
  }
  await validateGateList(themes.gates, "themes.gates");
  await validateGateList(cli.gates, "cli.gates");
  for (const claim of conformance.claims) await validateGateList(claim.gates, `${claim.id}.gates`);
  for (const entry of registry.entries) {
    for (const workflow of entry.workflows) {
      await validateGateList(workflow.gates, `${entry.plugin.id}.${workflow.id}.gates`);
    }
  }
  return model;
}

function schemaFor(name) {
  const common = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    additionalProperties: false,
  };
  const stringArray = { type: "array", items: { type: "string" }, uniqueItems: true };
  const gateSchema = {
    type: "object",
    additionalProperties: false,
    required: ["path", "command"],
    properties: {
      path: { type: "string", pattern: "^[^/][^\\n]*$" },
      command: { type: "string", minLength: 1 },
    },
  };
  if (name === "index.v1.schema.json") {
    return {
      ...common,
      $id: "urn:threadleaf:spec:v1:index-schema",
      type: "object",
      required: [
        "schemaVersion",
        "uri",
        "threadleafVersion",
        "versionPolicy",
        "labels",
        "datasets",
        "schemas",
        "sources",
        "generatedBy",
      ],
      properties: {
        schemaVersion: { const: 1 },
        uri: { const: "urn:threadleaf:spec:v1" },
        threadleafVersion: { type: "string" },
        versionPolicy: {
          type: "object",
          required: ["specification", "compatibility", "uri"],
          properties: {
            specification: { const: "v1" },
            compatibility: { type: "string" },
            uri: { const: "urn:threadleaf:spec:v1" },
          },
          additionalProperties: false,
        },
        labels: {
          type: "object",
          required: ["normative", "informative"],
          properties: { normative: { type: "string" }, informative: { type: "string" } },
          additionalProperties: false,
        },
        datasets: stringArray,
        schemas: stringArray,
        sources: stringArray,
        generatedBy: { type: "string" },
      },
    };
  }
  if (name === "api.v1.schema.json") {
    return {
      ...common,
      $id: "urn:threadleaf:spec:v1:api-schema",
      type: "object",
      required: [
        "schemaVersion",
        "uri",
        "threadleafVersion",
        "implementationClassifications",
        "compatibilityLevels",
        "capabilities",
        "surfaces",
      ],
      properties: {
        schemaVersion: { const: 1 },
        uri: { const: "urn:threadleaf:spec:v1:api" },
        threadleafVersion: { type: "string" },
        implementationClassifications: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "label", "source"],
            properties: {
              id: { type: "string" },
              label: { type: "string" },
              source: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        compatibilityLevels: {
          type: "array",
          minItems: 5,
          items: {
            type: "object",
            required: ["level", "name", "evidence"],
            properties: {
              level: { type: "integer", minimum: 0, maximum: 4 },
              name: { type: "string" },
              evidence: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        capabilities: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "label", "description", "source"],
            properties: {
              id: { type: "string" },
              label: { type: "string" },
              description: { type: "string" },
              source: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        surfaces: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "classification", "status", "source"],
            properties: {
              id: { type: "string" },
              classification: { type: "string" },
              status: { type: "string" },
              source: { type: "string" },
            },
            additionalProperties: false,
          },
        },
      },
    };
  }
  if (name === "cli.v1.schema.json") {
    return {
      ...common,
      $id: "urn:threadleaf:spec:v1:cli-schema",
      type: "object",
      required: [
        "schemaVersion",
        "uri",
        "threadleafVersion",
        "cliSchemaVersion",
        "commands",
        "shellRuntime",
        "exitCodes",
        "outputFormats",
        "gates",
        "source",
      ],
      properties: {
        schemaVersion: { const: 1 },
        uri: { const: "urn:threadleaf:spec:v1:cli" },
        threadleafVersion: { type: "string" },
        cliSchemaVersion: { type: "integer" },
        commands: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "syntax", "output", "authority", "status", "source", "documentation"],
            properties: {
              id: { type: "string" },
              syntax: stringArray,
              output: { type: "string" },
              authority: { type: "string" },
              status: { type: "string" },
              source: { type: "string" },
              documentation: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        shellRuntime: {
          type: "object",
          required: ["shells", "authority", "source", "fallback", "gates"],
          properties: {
            shells: { const: ["bash", "zsh", "fish", "powershell"] },
            authority: { type: "string" },
            source: stringArray,
            fallback: { type: "string" },
            gates: { type: "array", items: gateSchema },
          },
          additionalProperties: false,
        },
        exitCodes: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "code"],
            properties: { name: { type: "string" }, code: { type: "integer" } },
            additionalProperties: false,
          },
        },
        outputFormats: stringArray,
        gates: { type: "array", items: gateSchema },
        source: stringArray,
      },
    };
  }
  if (name === "theme.v1.schema.json") {
    return {
      ...common,
      $id: "urn:threadleaf:spec:v1:theme-schema",
      type: "object",
      required: [
        "schemaVersion",
        "uri",
        "threadleafVersion",
        "colorSchemes",
        "themeContract",
        "assetIds",
        "limits",
        "cascade",
        "gates",
      ],
      properties: {
        schemaVersion: { const: 1 },
        uri: { const: "urn:threadleaf:spec:v1:themes" },
        threadleafVersion: { type: "string" },
        colorSchemes: stringArray,
        themeContract: {
          type: "object",
          required: ["version", "uri", "tokens", "stateCues", "schemes", "source"],
          properties: {
            version: { type: "integer", minimum: 1 },
            uri: { type: "string", pattern: "^urn:threadleaf:theme:v[0-9]+$" },
            tokens: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                required: ["name", "role"],
                properties: {
                  name: { type: "string", pattern: "^--[a-z0-9-]+$" },
                  role: { type: "string", minLength: 1 },
                },
                additionalProperties: false,
              },
            },
            stateCues: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                required: ["state", "cue"],
                properties: {
                  state: { type: "string", minLength: 1 },
                  cue: { type: "string", minLength: 1 },
                },
                additionalProperties: false,
              },
            },
            schemes: stringArray,
            source: { type: "string" },
          },
          additionalProperties: false,
        },
        assetIds: {
          type: "array",
          items: {
            type: "object",
            required: ["kind", "prefix", "source"],
            properties: {
              kind: { type: "string" },
              prefix: { type: "string" },
              source: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        limits: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "bytes", "unit", "display", "source"],
            properties: {
              id: { type: "string" },
              bytes: { type: "integer", minimum: 0 },
              unit: { enum: ["bytes", "entries"] },
              display: { type: "string" },
              source: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        cascade: {
          type: "array",
          items: {
            type: "object",
            required: ["order", "layer", "source"],
            properties: {
              order: { type: "integer" },
              layer: { type: "string" },
              source: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        gates: { type: "array", items: gateSchema },
      },
    };
  }
  if (name === "fixture.v1.schema.json") {
    return {
      ...common,
      $id: "urn:threadleaf:spec:v1:fixture-schema",
      type: "object",
      required: ["schemaVersion", "uri", "fixtures"],
      properties: {
        schemaVersion: { const: 1 },
        uri: { const: "urn:threadleaf:spec:v1:fixtures" },
        fixtures: {
          type: "array",
          items: {
            type: "object",
            required: [
              "id",
              "root",
              "canonicalRoot",
              "schemaVersion",
              "license",
              "licensePath",
              "licenseSha256",
              "provenancePath",
              "provenanceSha256",
              "manifestPath",
              "manifestSha256",
              "casesPath",
              "casesSha256",
              "cases",
              "files",
              "source",
            ],
            properties: {
              id: { type: "string" },
              root: { type: "string" },
              canonicalRoot: { type: "string" },
              schemaVersion: { const: 1 },
              license: { type: "string" },
              licensePath: { type: "string" },
              licenseSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
              provenancePath: { type: "string" },
              provenanceSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
              manifestPath: { type: "string" },
              manifestSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
              casesPath: { type: "string" },
              casesSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
              cases: {
                type: "array",
                items: {
                  type: "object",
                  required: ["id", "category", "support"],
                  properties: {
                    id: { type: "string" },
                    category: { type: "string" },
                    support: { enum: ["supported", "unsupported"] },
                  },
                  additionalProperties: false,
                },
              },
              files: {
                type: "array",
                items: {
                  type: "object",
                  required: ["path", "bytes", "sha256"],
                  properties: {
                    path: { type: "string" },
                    bytes: { type: "integer", minimum: 0 },
                    sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
                  },
                  additionalProperties: false,
                },
              },
              observation: {
                type: "object",
                required: ["path", "sha256", "status", "method", "source"],
                properties: {
                  path: { type: "string" },
                  sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
                  status: { enum: ["unverified", "observed"] },
                  method: { type: "string" },
                  source: { type: "string" },
                },
                additionalProperties: false,
              },
              source: stringArray,
            },
            additionalProperties: false,
          },
        },
      },
    };
  }
  if (name === "conformance.v1.schema.json") {
    return {
      ...common,
      $id: "urn:threadleaf:spec:v1:conformance-schema",
      type: "object",
      required: [
        "schemaVersion",
        "uri",
        "threadleafVersion",
        "terminology",
        "claims",
        "gaps",
        "registryEntries",
      ],
      properties: {
        schemaVersion: { const: 1 },
        uri: { const: "urn:threadleaf:spec:v1:conformance" },
        threadleafVersion: { type: "string" },
        terminology: {
          type: "object",
          required: ["normative", "informative", "verified", "notVerified"],
          properties: {
            normative: { type: "string" },
            informative: { type: "string" },
            verified: { type: "string" },
            notVerified: { type: "string" },
          },
          additionalProperties: false,
        },
        claims: {
          type: "array",
          items: {
            type: "object",
            required: [
              "id",
              "title",
              "status",
              "label",
              "scope",
              "threadleafVersion",
              "evidence",
              "gates",
              "fixtures",
              "limitations",
            ],
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              status: { enum: ["verified", "not-verified", "unsupported"] },
              label: { enum: ["normative", "informative"] },
              scope: { type: "string" },
              threadleafVersion: { type: "string" },
              evidence: stringArray,
              gates: { type: "array", items: gateSchema },
              fixtures: stringArray,
              limitations: stringArray,
            },
            additionalProperties: false,
          },
        },
        gaps: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "title", "status", "label", "reason", "source"],
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              status: { enum: ["verified", "not-verified", "unsupported"] },
              label: { enum: ["normative", "informative"] },
              reason: { type: "string" },
              source: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        registryEntries: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "version", "threadleafVersion", "compatibilityLevel"],
            properties: {
              id: { type: "string" },
              version: { type: "string" },
              threadleafVersion: { type: "string" },
              compatibilityLevel: { type: "integer", minimum: 0, maximum: 4 },
            },
            additionalProperties: false,
          },
        },
      },
    };
  }
  if (name === "registry.v1.schema.json") {
    const plugin = {
      type: "object",
      additionalProperties: false,
      required: ["id", "name", "version", "repository", "license", "bundleSha256"],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        version: { type: "string" },
        repository: { type: "string", format: "uri" },
        license: { type: "string" },
        bundleSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      },
    };
    const platform = {
      type: "object",
      additionalProperties: false,
      required: ["id", "status", "limits"],
      properties: {
        id: { type: "string" },
        status: { type: "string" },
        limits: stringArray,
      },
    };
    const workflow = {
      type: "object",
      additionalProperties: false,
      required: ["id", "name", "status", "gates"],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        status: { enum: ["passed", "not-verified", "unsupported"] },
        gates: { type: "array", items: gateSchema },
      },
    };
    return {
      ...common,
      $id: "urn:threadleaf:spec:v1:registry-schema",
      type: "object",
      required: ["schemaVersion", "generatedBy", "threadleafVersion", "entries"],
      properties: {
        schemaVersion: { const: 1 },
        generatedBy: { type: "string" },
        threadleafVersion: { type: "string" },
        entries: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "plugin",
              "threadleafVersion",
              "lastTested",
              "compatibilityLevel",
              "summary",
              "evidenceMode",
              "requiredCapabilities",
              "platforms",
              "workflows",
              "failures",
              "limitations",
            ],
            properties: {
              plugin,
              threadleafVersion: { type: "string" },
              lastTested: { type: "string", format: "date" },
              compatibilityLevel: { type: "integer", minimum: 0, maximum: 4 },
              summary: { type: "string" },
              evidenceMode: { type: "string" },
              requiredCapabilities: stringArray,
              platforms: { type: "array", items: platform },
              workflows: { type: "array", items: workflow },
              failures: { type: "array", items: { type: "string" } },
              limitations: stringArray,
            },
          },
        },
      },
    };
  }
  if (name === "case.v1.schema.json") {
    return {
      ...common,
      $id: "urn:threadleaf:spec:v1:case-schema",
      type: "object",
      required: ["schemaVersion", "corpusId", "license", "canonicalRoot", "manifest", "cases"],
      properties: {
        schemaVersion: { const: 1 },
        corpusId: { type: "string" },
        license: { type: "string", minLength: 1 },
        canonicalRoot: { type: "string" },
        manifest: { type: "string" },
        cases: {
          type: "array",
          items: {
            type: "object",
            required: [
              "id",
              "category",
              "support",
              "surface",
              "source",
              "operation",
              "expected",
              "allowedVariance",
            ],
            properties: {
              id: { type: "string" },
              category: { type: "string" },
              support: { enum: ["supported", "unsupported"] },
              surface: { type: "string" },
              source: { type: "object" },
              operation: { type: "object" },
              expected: { type: "object" },
              allowedVariance: stringArray,
            },
            additionalProperties: false,
          },
        },
      },
    };
  }
  fail(`unknown schema ${name}`);
}

function dataForModel(model) {
  return new Map([
    ["index.v1.json", model.index],
    ["api.v1.json", model.api],
    ["cli.v1.json", model.cli],
    ["themes.v1.json", model.themes],
    ["fixtures.v1.json", model.fixtures],
    ["conformance.v1.json", model.conformance],
    ["registry.v1.json", model.registry],
  ]);
}

function formatJson(fileName, value) {
  const binary = path.join(rootPath, "node_modules", ".bin", "biome");
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  const result = spawnSync(binary, ["format", "--stdin-file-path", fileName], {
    cwd: rootPath,
    input: raw,
    encoding: "utf8",
  });
  assert(
    result.status === 0,
    `Biome could not format ${fileName}: ${result.stderr || result.stdout}`,
  );
  return result.stdout;
}

async function writeOrCheck(filePath, expected) {
  const relative = path.relative(rootPath, filePath);
  if (checkOnly) {
    let actual;
    try {
      actual = await fs.readFile(filePath, "utf8");
    } catch (error) {
      fail(`${relative} is missing: ${error instanceof Error ? error.message : String(error)}`);
    }
    assert(actual === expected, `${relative} is stale; run pnpm public-spec:build`);
  } else {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, expected, "utf8");
  }
}

async function writeBinaryOrCheck(filePath, expected) {
  const relative = path.relative(rootPath, filePath);
  if (checkOnly) {
    let actual;
    try {
      actual = await fs.readFile(filePath);
    } catch (error) {
      fail(`${relative} is missing: ${error instanceof Error ? error.message : String(error)}`);
    }
    assert(
      Buffer.compare(actual, expected) === 0,
      `${relative} is stale; run pnpm public-spec:build`,
    );
  } else {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, expected);
  }
}

async function build() {
  const model = await buildModel();
  const data = dataForModel(model);
  const dataStrings = new Map();
  for (const [name, value] of data)
    dataStrings.set(name, formatJson(`public-spec/data/${name}`, value));
  const schemas = new Map(
    schemaNames.map((name) => [name, formatJson(`public-spec/schemas/${name}`, schemaFor(name))]),
  );
  const template = await readText(templatePath);
  const generatedHtml = renderTemplate(template, {
    SPEC_VERSION: escapeHtml(model.index.versionPolicy.specification),
    THREADLEAF_VERSION: escapeHtml(model.index.threadleafVersion),
    GENERATED_BY: escapeHtml(model.index.generatedBy),
    CONFORMANCE_ROWS: renderConformanceRows(model.conformance),
    REGISTRY_ROWS: renderRegistryRows(model.registry),
    API_ROWS: renderApiRows(model.api),
    THEME_ROWS: renderThemeRows(model.themes),
    CLI_ROWS: renderCliRows(model.cli),
    FIXTURE_ROWS: renderFixtureRows(model.fixtures),
    GAP_ROWS: renderGapRows(model.conformance),
    CASE_COUNT: escapeHtml(model.fixtures.fixtures[0]?.cases.length ?? 0),
    CAPABILITY_COUNT: escapeHtml(model.api.capabilities.length),
    COMMAND_COUNT: escapeHtml(model.cli.commands.length),
    REGISTRY_COUNT: escapeHtml(model.registry.entries.length),
  });
  const style = await fs.readFile(stylePath);
  const script = await fs.readFile(scriptPath);
  const sourceReadme = await readText(path.join(sourcePath, "index.md"));
  const sourceContributing = await readText(path.join(sourcePath, "contributing.md"));
  const sourceChangelog = await readText(path.join(sourcePath, "changelog.md"));
  const specification = sourceReadme
    .replaceAll("../../docs/", "../docs/")
    .replaceAll("](../data/", "](data/")
    .replaceAll("](contributing.md)", "](v1/contributing.md)");
  const siteReadme = sourceReadme
    .replaceAll("](../data/", "](data/")
    .replaceAll("(contributing.md)", "(CONTRIBUTING.md)");

  await fs.mkdir(sitePath, { recursive: true });
  await writeOrCheck(path.join(sitePath, "index.html"), generatedHtml);
  await writeBinaryOrCheck(path.join(sitePath, "styles.css"), style);
  await writeBinaryOrCheck(path.join(sitePath, "site.js"), script);
  await writeOrCheck(path.join(sitePath, "README.md"), siteReadme);
  await writeOrCheck(path.join(sitePath, "CONTRIBUTING.md"), sourceContributing);
  await writeOrCheck(path.join(sitePath, "CHANGELOG.md"), sourceChangelog);
  for (const [name, value] of dataStrings) {
    await writeOrCheck(path.join(dataPath, name), value);
    await writeOrCheck(path.join(siteDataPath, name), value);
  }
  for (const [name, value] of schemas) {
    await writeOrCheck(path.join(schemaPath, name), value);
    await writeOrCheck(path.join(siteSchemaPath, name), value);
  }
  await writeOrCheck(path.join(publicSpecPath, "SPECIFICATION.md"), specification);
}

await build();
process.stdout.write(
  `${checkOnly ? "Verified" : "Generated"} public specification v1 for Threadleaf ${JSON.stringify((await readJson(packagePath)).version)}.\n`,
);
