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
  const developmentSandboxIndex = runs.findIndex(
    (run) =>
      typeof run === "string" &&
      run.includes("electron_sandbox") &&
      run.includes("node -p 'require(\"electron\")'"),
  );
  const e2eIndex = runs.indexOf("pnpm run test:plugin-packages-e2e:built");
  assert(prepareIndex >= 0, `${label} Linux job must build the unpacked package first.`);
  assert(buildIndex >= 0, `${label} Linux job must build and verify packages.`);
  assert(buildIndex > prepareIndex, `${label} Linux job must verify after its unpacked build.`);
  assert(
    developmentSandboxIndex > buildIndex && e2eIndex > developmentSandboxIndex,
    `${label} Linux job must repair the development helper after package verification and before plugin E2E.`,
  );
  assert(
    runs.filter((run) => run === "pnpm run test:plugin-packages-e2e:built").length === 1,
    `${label} Linux job must run the built plugin E2E exactly once.`,
  );
  const developmentSandboxRun = runs[developmentSandboxIndex];
  assert(
    developmentSandboxRun
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .join("\n") ===
      'electron_path="$(node -p \'require("electron")\')"\n' +
        'electron_sandbox="$(dirname "$electron_path")/chrome-sandbox"\n' +
        'sudo chown root:root "$electron_sandbox"\n' +
        'sudo chmod 4755 "$electron_sandbox"\n' +
        'test "$(stat -c \'%u:%g:%a\' "$electron_sandbox")" = "0:0:4755"',
    `${label} plugin E2E must repair and assert Electron's exact adjacent sandbox helper.`,
  );
  const nativeTools = runs.find(
    (run) =>
      typeof run === "string" &&
      run.includes("install_missing_tools") &&
      run.includes("sudo apt-get"),
  );
  assert(
    nativeTools?.includes("command -v Xvfb"),
    `${label} Linux job must assert the runner's Xvfb before plugin E2E.`,
  );
  assert(
    nativeTools?.includes("command -v rpm"),
    `${label} Linux job must assert the runner's RPM inspector.`,
  );
  assert(
    nativeTools?.includes("timeout --signal=TERM --kill-after=15s 120s") &&
      nativeTools.includes("Acquire::Retries=3") &&
      nativeTools.includes("Acquire::http::Timeout=15") &&
      nativeTools.includes("Acquire::https::Timeout=15"),
    `${label} Linux package acquisition must be bounded and retry transient mirror failures.`,
  );
  assert(
    nativeTools.includes("install -y --no-install-recommends fish libfuse2t64") &&
      nativeTools.includes("ldconfig -p | grep -F 'libfuse.so.2'"),
    `${label} Linux job must install and assert Fish plus the AppImage FUSE 2 runtime.`,
  );
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
