import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = path.join(
  rootPath,
  "docs/compatibility/extension-porting-report.v1.schema.json",
);
const goldenPath = path.join(rootPath, "fixtures/extension-porting/golden/measured-report.json");
const maxItems = 64;
const maxReportBytes = 100 * 1024;
const sha256Pattern = /^[a-f0-9]{64}$/u;

function fail(message) {
  throw new Error(`Extension porting contract: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    fail(
      `${path.relative(rootPath, filePath)} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertArray(value, label, maximum = maxItems) {
  assert(Array.isArray(value), `${label} must be an array`);
  assert(value.length <= maximum, `${label} exceeds ${maximum} items`);
}

function assertDigest(value, label) {
  assert(
    typeof value === "string" && sha256Pattern.test(value),
    `${label} is not a SHA-256 digest`,
  );
}

function assertUnique(values, label) {
  assert(new Set(values).size === values.length, `${label} contains duplicates`);
}

function walkStrings(value, label = "report") {
  if (typeof value === "string") {
    assert(!/[–—]/u.test(value), `${label} contains a public en/em dash`);
    assert(!value.includes("\u0000"), `${label} contains a NUL`);
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      walkStrings(item, `${label}[${index}]`);
    }
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      walkStrings(item, `${label}.${key}`);
    }
  }
}

function checkProvenance(value, label) {
  assert(isRecord(value), `${label} must be an object`);
  for (const key of [
    "kind",
    "pluginId",
    "version",
    "releaseTag",
    "sourceUrl",
    "releaseUrl",
    "indexUrl",
    "indexSha256",
  ]) {
    assert(Object.hasOwn(value, key), `${label} is missing ${key}`);
  }
  assert(["fixture", "local", "release"].includes(value.kind), `${label}.kind is invalid`);
  assert(
    typeof value.pluginId === "string" && value.pluginId.length <= 200,
    `${label}.pluginId is invalid`,
  );
  assert(
    typeof value.version === "string" && value.version.length <= 200,
    `${label}.version is invalid`,
  );
  assert(
    typeof value.releaseTag === "string" && value.releaseTag.length <= 200,
    `${label}.releaseTag is invalid`,
  );
  if (value.indexSha256 !== null) assertDigest(value.indexSha256, `${label}.indexSha256`);
}

function checkAssets(value, label, filenameKey) {
  assertArray(value, label, 3);
  assert(value.length >= 2, `${label} must include manifest and main assets`);
  const names = value.map((asset) => asset[filenameKey]);
  assertUnique(names, label);
  assert(names.includes("manifest.json"), `${label} omits manifest.json`);
  assert(names.includes("main.js"), `${label} omits main.js`);
  for (const [index, asset] of value.entries()) {
    assert(isRecord(asset), `${label}[${index}] must be an object`);
    assert(
      ["manifest.json", "main.js", "styles.css"].includes(asset[filenameKey]),
      `${label}[${index}] filename is invalid`,
    );
    assert(
      Number.isSafeInteger(asset.size) && asset.size >= 0,
      `${label}[${index}].size is invalid`,
    );
    assertDigest(asset.sha256, `${label}[${index}].sha256`);
  }
}

function assetMap(value, filenameKey) {
  return new Map(value.map((asset) => [asset[filenameKey], asset]));
}

function checkReceipt(value, label) {
  assert(isRecord(value), `${label} must be an object`);
  assert(value.schemaVersion === 1, `${label}.schemaVersion is unsupported`);
  assert(value.tool?.id === "threadleaf-plugin-package-inspector", `${label}.tool.id is invalid`);
  assert(["pass", "fail", "blocked"].includes(value.overall), `${label}.overall is invalid`);
  checkProvenance(value.exactPackage?.provenance, `${label}.exactPackage.provenance`);
  for (const key of ["bundleSha256", "manifestSha256"])
    assertDigest(value.exactPackage?.[key], `${label}.exactPackage.${key}`);
  if (value.exactPackage?.stylesSha256 !== null)
    assertDigest(value.exactPackage?.stylesSha256, `${label}.exactPackage.stylesSha256`);
  checkAssets(value.assets, `${label}.assets`, "filename");
  const assets = assetMap(value.assets, "filename");
  assert(
    assets.get("main.js").sha256 === value.exactPackage.bundleSha256,
    `${label} bundle digest is not asset-bound`,
  );
  assert(
    assets.get("manifest.json").sha256 === value.exactPackage.manifestSha256,
    `${label} manifest digest is not asset-bound`,
  );
  assert(
    (assets.get("styles.css")?.sha256 ?? null) === value.exactPackage.stylesSha256,
    `${label} stylesheet digest is not asset-bound`,
  );
  assert(
    value.staticAuthority?.staticOnly === true,
    `${label}.staticAuthority must be static-only`,
  );
  assert(
    value.staticAuthority.bundleSha256 === value.exactPackage.bundleSha256,
    `${label} authority digest is not bundle-bound`,
  );
  assertArray(value.limitations, `${label}.limitations`);
}

function checkReport(report, rawBytes) {
  assert(rawBytes.byteLength <= maxReportBytes, `golden report exceeds ${maxReportBytes} bytes`);
  assert(isRecord(report), "golden report must be an object");
  assert(report.schemaVersion === 1, "report schemaVersion is unsupported");
  assert(report.tool?.id === "threadleaf-extension-porting", "report tool identity is invalid");
  checkProvenance(report.input?.provenance, "report.input.provenance");
  checkAssets(report.input?.assets, "report.input.assets", "name");
  assert(report.input?.contained === true, "report input is not marked contained");
  assertArray(report.diagnostics, "report.diagnostics");
  assertArray(report.limitations, "report.limitations");
  assertArray(report.api?.observed, "report.api.observed");
  assertArray(report.api?.differences, "report.api.differences");
  assertArray(report.authority?.observed, "report.authority.observed");
  assertArray(report.authority?.differences, "report.authority.differences");
  assertArray(report.packageInspection?.entries, "report.packageInspection.entries");
  assertArray(report.packageInspection?.stages, "report.packageInspection.stages", 16);
  assertArray(
    report.packageInspection?.unexpectedEntries,
    "report.packageInspection.unexpectedEntries",
  );
  assertUnique(
    report.packageInspection.entries.map((entry) => `${entry.path}\u0000${entry.kind}`),
    "package entries",
  );
  assertUnique(
    report.diagnostics.map(
      (item) => `${item.severity}\u0000${item.code}\u0000${item.evidencePath}`,
    ),
    "diagnostics",
  );
  const reportAssets = assetMap(report.input.assets, "name");
  assert(
    report.packageInspection.assets.every(
      (asset) => reportAssets.get(asset.name)?.sha256 === asset.sha256,
    ),
    "package inspection assets are not input-bound",
  );
  if (report.authorityReceipt !== null) {
    checkReceipt(report.authorityReceipt, "authorityReceipt");
    assert(
      report.authorityReceipt.exactPackage.bundleSha256 === reportAssets.get("main.js").sha256,
      "authority receipt is not input-bound",
    );
  }
  if (report.packageInspection.receipt.exactPackage !== null) {
    assert(
      report.packageInspection.receipt.exactPackage.bundleSha256 ===
        reportAssets.get("main.js").sha256,
      "package receipt is not input-bound",
    );
  }
  assert(
    report.ci?.variables?.pluginDirectory === "PLUGIN_DIR",
    "CI plugin directory variable drifted",
  );
  assert(
    report.ci.commands.includes('pnpm cli port ci "$PLUGIN_DIR" --json'),
    "CI command does not include port ci",
  );
}

/**
 * A small, dependency-free validator for the exact JSON Schema 2020-12 subset this repository's
 * schema documents use: object/array/string/integer/boolean/null types, $ref against local $defs,
 * const, enum, anyOf, pattern, minLength/maxLength, minimum/maximum, minItems/maxItems,
 * uniqueItems, required, and additionalProperties: false. This project has no Ajv dependency;
 * adding one only to validate one fixture is not worth the new dependency surface.
 */
function resolveSchemaRef(root, ref) {
  const segments = ref.replace(/^#\//u, "").split("/");
  let node = root;
  for (const segment of segments) {
    node = node?.[segment];
  }
  if (node === undefined) {
    fail(`schema $ref ${ref} does not resolve`);
  }
  return node;
}

function schemaTypeMatches(schema, value) {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  return types.some((type) => {
    if (type === "integer") {
      return typeof value === "number" && Number.isInteger(value);
    }
    return type === actual;
  });
}

function validateAgainstSchema(root, schema, value, location, errors) {
  if (schema.$ref) {
    validateAgainstSchema(root, resolveSchemaRef(root, schema.$ref), value, location, errors);
    return;
  }
  if (schema.anyOf) {
    const matches = schema.anyOf.some((candidate) => {
      const candidateErrors = [];
      validateAgainstSchema(root, candidate, value, location, candidateErrors);
      return candidateErrors.length === 0;
    });
    if (!matches) {
      errors.push(`${location}: matched none of the schema's anyOf alternatives`);
    }
    return;
  }
  if (schema.const !== undefined) {
    if (value !== schema.const) {
      errors.push(`${location}: expected const ${JSON.stringify(schema.const)}`);
    }
    return;
  }
  if (schema.enum) {
    if (!schema.enum.includes(value)) {
      errors.push(`${location}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
    }
    return;
  }
  if (schema.type && !schemaTypeMatches(schema, value)) {
    errors.push(`${location}: expected type ${JSON.stringify(schema.type)}`);
    return;
  }
  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) {
      errors.push(`${location}: does not match pattern ${schema.pattern}`);
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${location}: shorter than minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${location}: longer than maxLength ${schema.maxLength}`);
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${location}: below minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${location}: above maximum ${schema.maximum}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${location}: fewer than minItems ${schema.minItems}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${location}: more than maxItems ${schema.maxItems}`);
    }
    if (schema.uniqueItems) {
      const seen = new Set();
      for (const item of value) {
        const key = JSON.stringify(item);
        if (seen.has(key)) {
          errors.push(`${location}: duplicate item under uniqueItems`);
          break;
        }
        seen.add(key);
      }
    }
    if (schema.items) {
      value.forEach((item, index) =>
        validateAgainstSchema(root, schema.items, item, `${location}[${index}]`, errors),
      );
    }
    return;
  }
  if (isRecord(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) {
        errors.push(`${location}: missing required property ${key}`);
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
          errors.push(`${location}: unexpected property ${key}`);
        }
      }
    }
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) {
        validateAgainstSchema(root, propertySchema, value[key], `${location}.${key}`, errors);
      }
    }
  }
}

function validateReport(schema, report) {
  const errors = [];
  validateAgainstSchema(schema, schema, report, "$", errors);
  return errors;
}

const schema = await readJson(schemaPath);
assert(schema.$schema === "https://json-schema.org/draft/2020-12/schema", "schema draft drifted");
assert(schema.$id === "urn:threadleaf:spec:v1:extension-porting-report", "schema id drifted");
assert(schema.additionalProperties === false, "schema must reject unknown root fields");
const raw = await fs.readFile(goldenPath);
const report = JSON.parse(raw);
assert(
  validateReport(schema, report).length === 0,
  `golden report does not validate against its JSON schema: ${validateReport(schema, report).join("; ")}`,
);
const oversized = structuredClone(report);
oversized.limitations = Array.from({ length: maxItems + 1 }, (_, index) => `adversarial-${index}`);
assert(
  validateReport(schema, oversized).length > 0,
  "schema accepted an over-bounded adversarial report",
);
const unknownField = structuredClone(report);
unknownField.untrustedRawReceipt = "javascript:alert(1)";
assert(
  validateReport(schema, unknownField).length > 0,
  "schema accepted an unknown raw-receipt field",
);
walkStrings(report);
checkReport(report, raw);
process.stdout.write(
  `Extension porting contract: PASS (${path.relative(rootPath, goldenPath)}, ${raw.byteLength} bytes)\n`,
);
