import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.dirname(root);
const schemaDirectory = path.join(appRoot, "docs", "compatibility");
const fixtureDirectory = path.join(appRoot, "fixtures", "native-extensions", "signed-distribution");

class CheckFailure extends Error {}

function fail(message) {
  throw new CheckFailure(`[native-extension-distribution-schema] ${message}`);
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    fail(`cannot read ${path.relative(appRoot, filePath)}: ${error.message}`);
  }
}

/**
 * ajv is a transitive dependency, so it is not resolvable by bare specifier under the strict pnpm
 * layout. Resolve it explicitly and fail loudly if it is gone: a validator that cannot be found is
 * the same silence this check exists to remove.
 */
async function loadAjv2020() {
  try {
    const hoisted = await import("ajv/dist/2020.js");
    return hoisted.default?.default ?? hoisted.default ?? hoisted.Ajv2020;
  } catch {
    // Fall through to the pnpm store.
  }
  const storeDirectory = path.join(appRoot, "node_modules", ".pnpm");
  let entries;
  try {
    entries = await fs.readdir(storeDirectory);
  } catch (error) {
    fail(`cannot read the pnpm store to resolve ajv: ${error.message}`);
  }
  const candidates = entries.filter((entry) => /^ajv@8\./.test(entry)).sort();
  const candidate = candidates.at(-1);
  if (candidate === undefined) {
    fail("ajv 8 is not installed; run pnpm install before this check");
  }
  const modulePath = path.join(storeDirectory, candidate, "node_modules", "ajv", "dist", "2020.js");
  const loaded = await import(pathToFileURL(modulePath).href);
  return loaded.default?.default ?? loaded.default ?? loaded.Ajv2020;
}

function clone(value) {
  return structuredClone(value);
}

async function main() {
  const distributionSchemaPath = path.join(
    schemaDirectory,
    "native-extension-distribution.v1.schema.json",
  );
  const manifestSchemaPath = path.join(schemaDirectory, "native-extension-manifest.v1.schema.json");
  const distributionSchema = await readJson(distributionSchemaPath);
  const manifestSchema = await readJson(manifestSchemaPath);

  const Ajv2020 = await loadAjv2020();
  if (typeof Ajv2020 !== "function") {
    fail("resolved ajv does not export a 2020-12 constructor");
  }

  // `strictTypes` is relaxed only because the shared publisher-key definitions are reused across
  // documents; every other strict check stays on.
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
  // The distribution schema constrains timestamps with an exact pattern as well, so this format is
  // a second gate rather than the only one.
  ajv.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/u);

  let validate;
  try {
    ajv.addSchema(manifestSchema);
    validate = ajv.compile(distributionSchema);
  } catch (error) {
    fail(`the distribution schema does not compile: ${error.message}`);
  }

  // A standalone compile with only the sibling preloaded is the shape a consumer actually has.
  const standalone = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
  standalone.addFormat(
    "date-time",
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/u,
  );
  try {
    standalone.addSchema(manifestSchema);
    standalone.compile(distributionSchema);
  } catch (error) {
    fail(`the distribution schema does not compile with the sibling preloaded: ${error.message}`);
  }

  const signedManifest = await readJson(
    path.join(fixtureDirectory, "signed-manifest.example.json"),
  );
  const catalog = await readJson(path.join(fixtureDirectory, "catalog.example.json"));
  const trustAnchors = await readJson(path.join(fixtureDirectory, "trust-anchors.example.json"));

  const accepted = [
    ["signed-manifest.example.json", signedManifest],
    ["catalog.example.json", catalog],
    ["trust-anchors.example.json", trustAnchors],
  ];
  for (const [name, document] of accepted) {
    if (!validate(document)) {
      fail(`${name} does not validate against the schema: ${ajv.errorsText(validate.errors)}`);
    }
  }

  // Negative controls. Without these a schema that accepts everything would pass this check.
  const rejected = [
    [
      "signed manifest with an unknown field",
      (() => {
        const value = clone(signedManifest);
        value.unexpectedField = 1;
        return value;
      })(),
    ],
    [
      "signed manifest with a malformed fingerprint",
      (() => {
        const value = clone(signedManifest);
        value.publisher.fingerprint = "sha256:not-a-digest";
        return value;
      })(),
    ],
    [
      // This one proves the manifest $ref resolves to the real sibling schema and not to some
      // permissive placeholder. It is the exact defect that made the schema uncompilable.
      "signed manifest whose embedded manifest breaks the manifest schema",
      (() => {
        const value = clone(signedManifest);
        value.manifest.manifestVersion = 2;
        return value;
      })(),
    ],
    [
      "signed manifest whose embedded manifest has an unknown field",
      (() => {
        const value = clone(signedManifest);
        value.manifest.somethingElse = true;
        return value;
      })(),
    ],
    [
      "catalog missing its entry digest",
      (() => {
        const value = clone(catalog);
        delete value.entriesSha256;
        return value;
      })(),
    ],
    [
      "trust anchor set with an unknown field",
      (() => {
        const value = clone(trustAnchors);
        value.trustEverything = true;
        return value;
      })(),
    ],
    [
      "trust anchor set with a malformed revocation timestamp",
      (() => {
        const value = clone(trustAnchors);
        value.publishers[0].revokedAt = "2026-01-01";
        return value;
      })(),
    ],
    ["a document that is none of the three shapes", { hello: "world" }],
  ];
  for (const [name, document] of rejected) {
    if (validate(document)) {
      fail(`the schema accepted ${name}, so it does not constrain what it claims to`);
    }
  }

  console.log(
    `native extension distribution schema compiled and validated ${accepted.length} real fixtures with ${rejected.length} negative controls`,
  );
}

try {
  await main();
} catch (error) {
  process.exitCode = 1;
  console.error(
    error instanceof CheckFailure
      ? error.message
      : `[native-extension-distribution-schema] unexpected failure: ${error instanceof Error ? (error.stack ?? error.message) : error}`,
  );
}
