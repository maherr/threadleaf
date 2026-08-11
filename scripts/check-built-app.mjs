import { spawnSync } from "node:child_process";
import { access, cp, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
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
const cliGraphResult = spawnSync(
  process.execPath,
  [
    cliPath,
    "--vault",
    path.join(projectRoot, "fixtures", "vaults", "basic"),
    "--json",
    "links",
    "path=Welcome.md",
  ],
  { encoding: "utf8" },
);
if (cliGraphResult.status !== 0 || cliGraphResult.stderr !== "") {
  throw new Error(
    `Built CLI graph smoke test failed: ${cliGraphResult.stderr || `exit ${cliGraphResult.status}`}`,
  );
}
const cliGraphEnvelope = JSON.parse(cliGraphResult.stdout);
if (
  cliGraphEnvelope.schemaVersion !== 1 ||
  cliGraphEnvelope.ok !== true ||
  cliGraphEnvelope.command !== "links" ||
  cliGraphEnvelope.data?.path !== "Welcome.md" ||
  cliGraphEnvelope.data?.total !== 1 ||
  cliGraphEnvelope.data?.links?.[0]?.resolution?.path !== "Linked Note.md"
) {
  throw new Error("Built CLI returned an unexpected graph envelope.");
}

async function verifyBuiltCliRecovery() {
  const scratchPath = await mkdtemp(path.join(os.tmpdir(), "threadleaf-built-cli-"));
  try {
    const vaultPath = path.join(scratchPath, "vault");
    await cp(path.join(projectRoot, "fixtures", "vaults", "basic"), vaultPath, {
      recursive: true,
    });
    const statePath = path.join(scratchPath, "state");
    const originalPath = path.join(vaultPath, "Linked Note.md");
    const trashPath = path.join(vaultPath, ".trash", "Linked Note.md");
    const original = await readFile(originalPath);
    const environment = { ...process.env, XDG_STATE_HOME: statePath };

    const deleted = spawnSync(
      process.execPath,
      [cliPath, "--vault", vaultPath, "--json", "delete", "path=Linked Note.md"],
      { encoding: "utf8", env: environment },
    );
    if (deleted.status !== 0 || deleted.stderr !== "") {
      throw new Error(
        `Built CLI delete smoke test failed: ${deleted.stderr || `exit ${deleted.status}`}`,
      );
    }
    const deleteEnvelope = JSON.parse(deleted.stdout);
    if (
      deleteEnvelope.command !== "delete" ||
      deleteEnvelope.data?.from !== "Linked Note.md" ||
      deleteEnvelope.data?.to !== ".trash/Linked Note.md" ||
      !original.equals(await readFile(trashPath))
    ) {
      throw new Error("Built CLI did not preserve exact bytes in recoverable trash.");
    }

    const listed = spawnSync(
      process.execPath,
      [cliPath, "--vault", vaultPath, "--json", "trash:list"],
      { encoding: "utf8", env: environment },
    );
    const listEnvelope = listed.status === 0 ? JSON.parse(listed.stdout) : null;
    if (
      listed.stderr !== "" ||
      listEnvelope?.command !== "trash.list" ||
      listEnvelope.data?.entries?.[0]?.path !== "Linked Note.md"
    ) {
      throw new Error(
        `Built CLI trash-list smoke test failed: ${listed.stderr || `exit ${listed.status}`}`,
      );
    }

    const restored = spawnSync(
      process.execPath,
      [cliPath, "--vault", vaultPath, "--json", "restore", "Linked Note.md"],
      { encoding: "utf8", env: environment },
    );
    if (restored.status !== 0 || restored.stderr !== "") {
      throw new Error(
        `Built CLI restore smoke test failed: ${restored.stderr || `exit ${restored.status}`}`,
      );
    }
    const restoreEnvelope = JSON.parse(restored.stdout);
    if (
      restoreEnvelope.command !== "restore" ||
      restoreEnvelope.data?.to !== "Linked Note.md" ||
      !original.equals(await readFile(originalPath))
    ) {
      throw new Error("Built CLI did not restore exact bytes to the original path.");
    }
    try {
      await access(trashPath);
      throw new Error("Built CLI restore left the trash entry behind.");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  } finally {
    await rm(scratchPath, { recursive: true, force: true });
  }
}

await verifyBuiltCliRecovery();
try {
  await access(path.join(projectRoot, "fixtures", "vaults", ".threadleaf-cli-read-only-state"));
  throw new Error("Built read-only CLI created a state directory.");
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
    throw error;
  }
}

console.log(
  `Verified Electron entry points, headless CLI graph and recovery behavior, and ${assetPaths.length} relative renderer assets.`,
);
