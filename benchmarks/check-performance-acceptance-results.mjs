import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const benchmarkRoot = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(benchmarkRoot, "performance-acceptance-result-schema.json");
const resultsDirectory = path.join(benchmarkRoot, "results");
const schemaOnly = process.argv.includes("--schema-only");

async function loadAjv2020() {
  try {
    const loaded = await import("ajv/dist/2020.js");
    return loaded.default?.default ?? loaded.default ?? loaded.Ajv2020;
  } catch {
    const storeDirectory = path.join(process.cwd(), "node_modules", ".pnpm");
    const entries = await fs.readdir(storeDirectory);
    const candidate = entries
      .filter((entry) => /^ajv@8\./u.test(entry))
      .sort()
      .at(-1);
    if (!candidate) throw new Error("ajv 8 is not installed; run pnpm install before this check.");
    const loaded = await import(
      path.join(storeDirectory, candidate, "node_modules", "ajv", "dist", "2020.js")
    );
    return loaded.default?.default ?? loaded.default ?? loaded.Ajv2020;
  }
}

const schema = JSON.parse(await fs.readFile(schemaPath, "utf8"));
const Ajv2020 = await loadAjv2020();
if (typeof Ajv2020 !== "function") throw new Error("Resolved ajv lacks a 2020-12 constructor.");
const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
ajv.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/u);
const validate = ajv.compile(schema);

if (!schemaOnly) {
  const entries = (await fs.readdir(resultsDirectory))
    .filter((entry) => /^threadleaf-performance-acceptance-.*\.json$/u.test(entry))
    .sort();
  if (entries.length === 0)
    throw new Error("No machine-written performance acceptance result was found.");
  for (const entry of entries) {
    const value = JSON.parse(await fs.readFile(path.join(resultsDirectory, entry), "utf8"));
    if (!validate(value))
      throw new Error(`${entry} fails schema validation: ${ajv.errorsText(validate.errors)}`);
  }
  process.stdout.write(`Validated ${entries.length} performance acceptance result file(s).\n`);
} else {
  process.stdout.write("Performance acceptance result schema compiles.\n");
}
