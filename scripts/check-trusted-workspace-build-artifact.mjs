import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostBundlePath = path.join(appRoot, "dist", "main", "trusted-plugin-host.cjs");
const hostMapPath = `${hostBundlePath}.map`;

class CheckFailure extends Error {}

function fail(message) {
  throw new CheckFailure(`[trusted-workspace-build-artifact] ${message}`);
}

async function read(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    fail(
      `cannot read ${path.relative(appRoot, filePath)}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

async function main() {
  const hostModulesSource = await read(
    path.join(appRoot, "src", "renderer", "trusted-host-modules.ts"),
  );
  const approvedRoots = [
    ...hostModulesSource.matchAll(/^import \* as \w+ from "(@(?:codemirror|lezer)\/[^"]+)";/gmu),
  ].map((match) => match[1]);
  if (approvedRoots.length === 0) {
    fail("the renderer-owned CodeMirror/Lezer table has no discoverable roots");
  }
  const tsupConfig = await read(path.join(appRoot, "tsup.config.ts"));
  for (const root of approvedRoots) {
    if (!tsupConfig.includes(`"${root}"`)) {
      fail(`the trusted build does not declare ${root} as renderer-owned`);
    }
  }

  const bundle = await read(hostBundlePath);
  const sourceMap = JSON.parse(await read(hostMapPath));
  if (!Array.isArray(sourceMap.sources)) {
    fail("the trusted host sourcemap has no sources list");
  }
  const copiedRealmSources = sourceMap.sources.filter(
    (source) =>
      typeof source === "string" &&
      (source.includes("/@codemirror/") || source.includes("/@lezer/")),
  );
  if (copiedRealmSources.length > 0) {
    fail(
      `the trusted host copied renderer-owned realm modules: ${copiedRealmSources.slice(0, 5).join(", ")}`,
    );
  }
  for (const root of ["@codemirror/state", "@codemirror/view"]) {
    if (!bundle.includes(`require("${root}")`)) {
      fail(`the trusted host does not resolve ${root} through the renderer-owned require table`);
    }
  }

  console.log(
    `trusted workspace build artifact gate passed for ${approvedRoots.length} renderer-owned module roots`,
  );
}

try {
  await main();
} catch (error) {
  process.exitCode = 1;
  console.error(
    error instanceof CheckFailure
      ? error.message
      : `[trusted-workspace-build-artifact] unexpected failure: ${error instanceof Error ? (error.stack ?? error.message) : error}`,
  );
}
