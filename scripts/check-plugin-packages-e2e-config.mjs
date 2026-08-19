import { promises as fs } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

const rootPath = process.cwd();

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function record(value, label) {
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object.`,
  );
  return value;
}

function assertLinuxWorkflowGate(document, label) {
  const jobs = record(document.jobs, `${label} jobs`);
  const linux = record(jobs.linux, `${label} Linux job`);
  assert(linux["runs-on"] === "ubuntu-24.04", `${label} plugin E2E must stay on Linux.`);
  assert(Array.isArray(linux.steps), `${label} Linux job must define steps.`);
  const runs = linux.steps.map((step) => record(step, `${label} Linux step`).run);
  const prepareIndex = runs.indexOf("pnpm run release:linux:prepare");
  const buildIndex = runs.indexOf("pnpm run release:linux:verify");
  const e2eIndex = runs.indexOf("pnpm run test:plugin-packages-e2e:built");
  assert(prepareIndex >= 0, `${label} Linux job must build the unpacked package first.`);
  assert(buildIndex >= 0, `${label} Linux job must build and verify packages.`);
  assert(buildIndex > prepareIndex, `${label} Linux job must verify after its unpacked build.`);
  assert(e2eIndex > buildIndex, `${label} Linux job must run plugin E2E after the verified build.`);
  assert(
    runs.filter((run) => run === "pnpm run test:plugin-packages-e2e:built").length === 1,
    `${label} Linux job must run the built plugin E2E exactly once.`,
  );
  const nativeTools = runs.find(
    (run) => typeof run === "string" && run.includes("apt-get install"),
  );
  assert(nativeTools?.includes("xvfb"), `${label} Linux job must install Xvfb for plugin E2E.`);
}

const [packageText, ciText, releaseText] = await Promise.all([
  fs.readFile(path.join(rootPath, "package.json"), "utf8"),
  fs.readFile(path.join(rootPath, ".github", "workflows", "ci.yml"), "utf8"),
  fs.readFile(path.join(rootPath, ".github", "workflows", "release.yml"), "utf8"),
]);
const packageData = record(JSON.parse(packageText), "package.json");
assert(
  packageData.scripts?.["test:plugin-packages-e2e"] ===
    "pnpm run build && pnpm run test:plugin-packages-e2e:built",
  "The source plugin E2E command must build before delegating to the built-artifact gate.",
);
assert(
  packageData.scripts?.["test:plugin-packages-e2e:built"] ===
    "node scripts/check-plugin-packages-e2e.mjs",
  "package.json must expose the built-artifact plugin E2E gate.",
);
assertLinuxWorkflowGate(record(parse(ciText), "CI workflow"), "CI");
assertLinuxWorkflowGate(record(parse(releaseText), "release workflow"), "Release");

process.stdout.write(
  "Plugin package E2E is pinned after Linux builds in CI and release workflows.\n",
);
