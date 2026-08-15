import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testSupportPath = "src/test-support/plugin-construction.ts";
const forbiddenMarkers = [
  "test-support/plugin-construction",
  "testConstructionRequest",
  "testConstructionDispatch",
  "testPluginRuntimeFactory",
  "test-grant-",
  "test-sealed-",
];

class CheckFailure extends Error {}

function fail(message) {
  throw new CheckFailure(`[plugin-construction-build-artifact] ${message}`);
}

async function filesBelow(relativeDirectory, accept) {
  const root = path.join(appRoot, relativeDirectory);
  const files = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      fail(
        `cannot read ${path.relative(appRoot, directory)}: ${error instanceof Error ? error.message : error}`,
      );
    }
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        const relativePath = path.relative(appRoot, absolutePath).split(path.sep).join("/");
        if (accept(relativePath)) {
          files.push(relativePath);
        }
      }
    }
  }
  await visit(root);
  return files.sort();
}

async function read(relativePath) {
  try {
    return await fs.readFile(path.join(appRoot, relativePath), "utf8");
  } catch (error) {
    fail(`cannot read ${relativePath}: ${error instanceof Error ? error.message : error}`);
  }
}

async function assertNoMarkers(paths, scope) {
  for (const relativePath of paths) {
    const content = await read(relativePath);
    for (const marker of forbiddenMarkers) {
      if (content.includes(marker)) {
        fail(`${scope} ${relativePath} contains test-only construction material: ${marker}`);
      }
    }
  }
}

async function main() {
  const productionSources = await filesBelow(
    "src",
    (relativePath) =>
      relativePath.endsWith(".ts") &&
      !relativePath.endsWith(".test.ts") &&
      !relativePath.endsWith(".bench.ts") &&
      !relativePath.startsWith("src/test-support/"),
  );
  if (productionSources.length === 0) {
    fail("no production TypeScript sources were discovered");
  }
  await assertNoMarkers(productionSources, "production source");

  const tsupConfig = await read("tsup.config.ts");
  const packageJson = await read("package.json");
  for (const content of [tsupConfig, packageJson]) {
    if (content.includes(testSupportPath)) {
      fail(`${testSupportPath} is configured as a production entry or export`);
    }
  }

  const builtArtifacts = [
    ...(await filesBelow(
      "dist/main",
      (relativePath) => relativePath.endsWith(".cjs") || relativePath.endsWith(".cjs.map"),
    )),
    ...(await filesBelow(
      "dist/renderer",
      (relativePath) => relativePath.endsWith(".js") || relativePath.endsWith(".js.map"),
    )),
  ];
  if (builtArtifacts.length === 0) {
    fail("no built JavaScript artifacts were discovered");
  }
  await assertNoMarkers(builtArtifacts, "built artifact");

  console.log(
    `plugin construction build artifact gate passed over ${productionSources.length} production sources and ${builtArtifacts.length} built artifacts`,
  );
}

try {
  await main();
} catch (error) {
  process.exitCode = 1;
  console.error(
    error instanceof CheckFailure
      ? error.message
      : `[plugin-construction-build-artifact] unexpected failure: ${error instanceof Error ? (error.stack ?? error.message) : error}`,
  );
}
