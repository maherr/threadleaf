import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const rootPath = process.cwd();
const inspector = require(path.join(rootPath, "dist", "main", "plugin-inspection.cjs"));
const fixtureRoot = path.join(rootPath, "fixtures", "plugin-packages");
const temporaryPrefix = "threadleaf-plugin-inspection-";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function fixtureInput(name) {
  return inspector.exactInputFromDirectory(path.join(fixtureRoot, name), {
    kind: "fixture",
    sourceUrl: `fixture://${name}`,
    releaseUrl: null,
    indexUrl: null,
    indexSha256: null,
  });
}

const before = new Set(
  (await fs.readdir(os.tmpdir())).filter((entry) => entry.startsWith(temporaryPrefix)),
);
try {
  const safe = await inspector.inspectPluginPackage(await fixtureInput("inspection-safe"));
  assert(safe.overall === "pass", "The safe exact package did not pass inspection.");
  assert(
    safe.candidate?.compatibilityLevel === 3,
    "Inspection claimed an unverified workflow level.",
  );
  assert(
    safe.stages.length === inspector.pluginPackageInspectionStageIds.length &&
      safe.stages.every((stage) => stage.status === "pass"),
    "The safe package did not produce one passing result for every required stage.",
  );

  const tampered = await fixtureInput("inspection-safe");
  tampered.hashes.mainSha256 = "0".repeat(64);
  const tamperedReport = await inspector.inspectPluginPackage(tampered);
  assert(tamperedReport.overall === "fail", "A tampered exact bundle was accepted.");
  assert(
    tamperedReport.candidate === null,
    "A failed exact package received a registry candidate.",
  );

  const escapeReport = await inspector.inspectPluginPackage(
    await fixtureInput("inspection-escape"),
  );
  assert(escapeReport.overall === "fail", "An undeclared authority package was accepted.");
  assert(
    escapeReport.stages.find(({ id }) => id === "activation")?.status === "blocked",
    "Static authority failure did not block activation.",
  );

  const runaway = await inspector.inspectPluginPackage(await fixtureInput("inspection-runaway"), {
    timeoutMs: 10,
  });
  assert(runaway.overall === "fail", "A bounded activation timeout became a pass.");
  assert(
    runaway.stages.find(({ id }) => id === "timeout")?.status === "fail",
    "The timeout stage did not record the runaway fixture.",
  );

  const teardown = await inspector.inspectPluginPackage(await fixtureInput("inspection-teardown"));
  assert(teardown.overall === "fail", "A teardown failure became a pass.");
  assert(
    teardown.stages.find(({ id }) => id === "cleanup")?.status === "fail",
    "The cleanup stage did not record the teardown fixture.",
  );

  const network = await inspector.inspectPluginPackage(await fixtureInput("inspection-network"));
  assert(network.overall === "blocked", "Denied network authority was activated.");
} finally {
  const after = new Set(
    (await fs.readdir(os.tmpdir())).filter((entry) => entry.startsWith(temporaryPrefix)),
  );
  assert(
    [...after].every((entry) => before.has(entry)),
    "Inspection left a materialized disposable package behind.",
  );
  delete globalThis.__threadleafInspectionFixtureGlobal;
}

process.stdout.write("Plugin package inspection e2e: PASS\n");
