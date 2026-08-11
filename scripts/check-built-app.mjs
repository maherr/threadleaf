import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const rendererDirectory = path.join(projectRoot, "dist", "renderer");
const indexPath = path.join(rendererDirectory, "index.html");
const html = await readFile(indexPath, "utf8");

if (html.includes('="/assets/')) {
  throw new Error("Renderer assets must be relative so Electron can load them over file://.");
}

const assetPaths = [...html.matchAll(/(?:href|src)="(\.\/assets\/[^"]+)"/g)].map(
  ([, assetPath]) => assetPath,
);

if (assetPaths.length < 2) {
  throw new Error("Built renderer must reference its JavaScript and CSS assets.");
}

await Promise.all([
  access(path.join(projectRoot, "dist", "main", "cli.cjs")),
  access(path.join(projectRoot, "dist", "main", "main.cjs")),
  access(path.join(projectRoot, "dist", "main", "preload.cjs")),
  ...assetPaths.map((assetPath) => access(path.resolve(rendererDirectory, assetPath))),
]);

const cliPath = path.join(projectRoot, "dist", "main", "cli.cjs");
const cliSource = await readFile(cliPath, "utf8");
if (!cliSource.startsWith("#!/usr/bin/env node")) {
  throw new Error("Built CLI must retain its portable Node.js shebang.");
}
const cliResult = spawnSync(
  process.execPath,
  [
    cliPath,
    "--vault",
    path.join(projectRoot, "fixtures", "vaults", "basic"),
    "--json",
    "vault",
    "info",
  ],
  { encoding: "utf8" },
);
if (cliResult.status !== 0 || cliResult.stderr !== "") {
  throw new Error(`Built CLI smoke test failed: ${cliResult.stderr || `exit ${cliResult.status}`}`);
}
const cliEnvelope = JSON.parse(cliResult.stdout);
if (
  cliEnvelope.schemaVersion !== 1 ||
  cliEnvelope.ok !== true ||
  cliEnvelope.command !== "vault.info" ||
  cliEnvelope.data?.markdownFiles !== 2
) {
  throw new Error("Built CLI returned an unexpected vault info envelope.");
}
try {
  await access(path.join(projectRoot, "fixtures", "vaults", ".threadleaf-cli-read-only-state"));
  throw new Error("Built read-only CLI created a state directory.");
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
    throw error;
  }
}

console.log(
  `Verified Electron entry points, headless CLI, and ${assetPaths.length} relative renderer assets.`,
);
