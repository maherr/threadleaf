import { promises as fs } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

const rootPath = process.cwd();
const fixturePath = path.join(rootPath, "fixtures", "installer-lifecycle", "contract.json");
const packagePath = path.join(rootPath, "package.json");
const builderPath = path.join(rootPath, "electron-builder.yml");
const ciPath = path.join(rootPath, ".github", "workflows", "ci.yml");
const releasePath = path.join(rootPath, ".github", "workflows", "release.yml");
const lifecycleScriptPath = path.join(rootPath, "scripts", "check-installer-lifecycle.mjs");
const mainProcessPath = path.join(rootPath, "src", "main", "main.ts");
const packagedAttachmentsScriptPath = path.join(
  rootPath,
  "scripts",
  "check-packaged-attachments.mjs",
);
const linuxPackagesScriptPath = path.join(rootPath, "scripts", "check-linux-packages.mjs");
const msvcAction = "ilammy/msvc-dev-cmd@0b201ec74fa43914dc39ae48a89fd1d8cb592756";

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

function stepsFor(job, label) {
  assert(Array.isArray(job.steps), `${label} must define steps.`);
  return job.steps.map((step) => record(step, `${label} step`));
}

function stepContaining(steps, text, label) {
  const step = steps.find(
    (candidate) => typeof candidate.run === "string" && candidate.run.includes(text),
  );
  assert(step, `${label} is missing a step containing ${JSON.stringify(text)}.`);
  return step;
}

function stepWithExactRun(steps, command, label) {
  const matches = steps.filter((candidate) => candidate.run === command);
  assert(
    matches.length === 1,
    `${label} must have exactly one step with run ${JSON.stringify(command)}, found ${matches.length}.`,
  );
  return matches[0];
}

function assertMsvcBeforeBuild(steps, buildStep, label) {
  const actionIndex = steps.findIndex((step) => step.uses === msvcAction);
  const buildIndex = steps.indexOf(buildStep);
  assert(actionIndex >= 0, `${label} does not configure the Visual C++ toolchain.`);
  assert(
    steps[actionIndex].with?.arch === "x64",
    `${label} must configure the x64 Visual C++ toolchain.`,
  );
  assert(actionIndex < buildIndex, `${label} configures Visual C++ after its native build.`);
}

function assertFishBeforeCheck(steps, checkStep, label) {
  const installIndex = steps.findIndex(
    (step) => typeof step.run === "string" && step.run.includes("apt-get install"),
  );
  const checkIndex = steps.indexOf(checkStep);
  assert(installIndex >= 0, `${label} does not install its native test tools.`);
  assert(
    /(?:^|\s)fish(?:\s|$)/u.test(steps[installIndex].run),
    `${label} does not install the Fish completion runtime.`,
  );
  assert(installIndex < checkIndex, `${label} installs Fish after its full source check.`);
}

function verifyToolchainSteps(document, label) {
  const jobs = record(document.jobs, `${label} jobs`);
  const packageManager = String(packageData.packageManager ?? "");
  const pnpmVersion = packageManager.startsWith("pnpm@") ? packageManager.slice(5) : null;
  assert(pnpmVersion, "package.json must pin pnpm for hosted toolchains.");
  for (const [jobName, rawJob] of Object.entries(jobs)) {
    const job = record(rawJob, `${label} ${jobName} job`);
    assert(
      typeof job["runs-on"] === "string",
      `${label} ${jobName} job must declare an explicit runner or matrix expression.`,
    );
    assert(
      Number.isInteger(job["timeout-minutes"]) && job["timeout-minutes"] > 0,
      `${label} ${jobName} job must declare a positive timeout.`,
    );
    for (const step of stepsFor(job, `${label} ${jobName} job`)) {
      if (step.uses?.startsWith("pnpm/action-setup@")) {
        assert(
          step.with?.version === pnpmVersion,
          `${label} ${jobName} uses an unpinned pnpm toolchain.`,
        );
      }
      if (step.uses?.startsWith("actions/setup-node@")) {
        assert(
          step.with?.["node-version"] === "22.22.1",
          `${label} ${jobName} uses an unpinned Node.js toolchain.`,
        );
      }
    }
  }
}

function envValue(step, name, label) {
  const environment = record(step.env ?? {}, `${label} environment`);
  return environment[name];
}

function collectUses(value, result = []) {
  if (Array.isArray(value)) {
    for (const child of value) collectUses(child, result);
    return result;
  }
  if (!value || typeof value !== "object") return result;
  for (const [key, child] of Object.entries(value)) {
    if (key === "uses" && typeof child === "string") result.push(child);
    else collectUses(child, result);
  }
  return result;
}

function workflowOn(document) {
  return document.on ?? document[true];
}

const [
  fixtureText,
  packageText,
  builderText,
  ciText,
  releaseText,
  lifecycleScriptText,
  mainProcessText,
  packagedAttachmentsScriptText,
  linuxPackagesScriptText,
] = await Promise.all([
  fs.readFile(fixturePath, "utf8"),
  fs.readFile(packagePath, "utf8"),
  fs.readFile(builderPath, "utf8"),
  fs.readFile(ciPath, "utf8"),
  fs.readFile(releasePath, "utf8"),
  fs.readFile(lifecycleScriptPath, "utf8"),
  fs.readFile(mainProcessPath, "utf8"),
  fs.readFile(packagedAttachmentsScriptPath, "utf8"),
  fs.readFile(linuxPackagesScriptPath, "utf8"),
]);
const fixture = record(JSON.parse(fixtureText), "installer lifecycle fixture");
const packageData = record(JSON.parse(packageText), "package.json");
const builder = record(parse(builderText), "electron-builder.yml");
const ci = record(parse(ciText), "ci.yml");
const release = record(parse(releaseText), "release.yml");
const ciJobs = record(ci.jobs, "CI jobs");
verifyToolchainSteps(ci, "CI");
verifyToolchainSteps(release, "release");

assert(fixture.schemaVersion === 1, "Installer lifecycle fixture schema is unsupported.");
assert(
  fixture.applicationId === builder.appId,
  "Fixture application identity differs from electron-builder.",
);
assert(
  fixture.lifecycleScript === "scripts/check-installer-lifecycle.mjs",
  "Fixture lifecycle script is stale.",
);
assert(
  packageData.scripts?.["test:installer-lifecycle"] ===
    "node scripts/check-installer-lifecycle.mjs",
  "package.json does not expose the lifecycle verifier.",
);
assert(
  packageData.scripts?.["test:installer-lifecycle-config"] ===
    "node scripts/check-installer-lifecycle-config.mjs",
  "package.json does not expose the lifecycle config gate.",
);
assert(
  packageData.scripts?.["release:linux"] ===
    "pnpm run release:linux:prepare && pnpm run release:linux:verify" &&
    packageData.scripts?.["release:linux:prepare"] === "pnpm run check && pnpm run pack:dir" &&
    packageData.scripts?.["pack:linux:built"] ===
      "electron-builder --prepackaged release/linux-unpacked --linux AppImage rpm --x64 --publish never" &&
    packageData.scripts?.["release:linux:verify"] ===
      "pnpm run test:packaged-attachments:built && pnpm run pack:linux:built && pnpm run test:linux-packages && node scripts/package-reproducible-linux.mjs --write" &&
    packageData.scripts?.["test:packaged-attachments"] ===
      "pnpm run pack:dir && pnpm run test:packaged-attachments:built",
  "Linux release scripts must expose one unpacked-build boundary before packaged verification.",
);
assert(builder.appId === "org.threadleaf.Threadleaf", "Electron application identity changed.");
assert(builder.productName === "Threadleaf", "Electron product name changed.");
assert(
  packageData.productName === builder.productName,
  "Packaged metadata and Electron Builder must agree on the display product name.",
);
assert(
  lifecycleScriptText.includes("path.join(isolatedAppDataPath, packageData.name)"),
  "Lifecycle state must use the package-name-derived path inside its isolated app-data root.",
);
assert(
  builder.nsis?.deleteAppDataOnUninstall === false,
  "Windows uninstall contract must preserve app data.",
);
assert(
  lifecycleScriptText.includes('platform === "win32" || platform === "darwin"'),
  "Native lifecycle verifier lost its explicit Windows/macOS gate.",
);
assert(
  lifecycleScriptText.includes("processMarkerArgument") &&
    lifecycleScriptText.includes("observeLaunchMarker") &&
    lifecycleScriptText.includes("markedProcessTree") &&
    lifecycleScriptText.includes("forceStopPackageRoot") &&
    lifecycleScriptText.includes('probe.child.kill("SIGKILL")') &&
    lifecycleScriptText.includes("trackedPids") &&
    lifecycleScriptText.includes("quietSamples") &&
    lifecycleScriptText.includes("cleanupMarkedProcesses(forcedTree)"),
  "Native lifecycle verifier must stop its marked root before cleaning tracked descendants through a quiet window.",
);
assert(
  lifecycleScriptText.includes('if (!force && platform !== "darwin")') &&
    lifecycleScriptText.includes(
      "Sending\n      // SIGTERM directly exercises Electron's before-quit autosave and cleanup path",
    ),
  "macOS lifecycle shutdown must not race a window-close preflight against app termination.",
);
assert(
  lifecycleScriptText.includes("THREADLEAF_LIFECYCLE_RUN") &&
    lifecycleScriptText.includes("THREADLEAF_LIFECYCLE_ARTIFACT_DIR"),
  "Native lifecycle verifier lost its isolated marker/evidence contract.",
);
assert(
  packagedAttachmentsScriptText.includes(
    'process.env.CHROME_DEVEL_SANDBOX ? [] : ["--disable-setuid-sandbox"]',
  ) && !packagedAttachmentsScriptText.includes('"--no-sandbox"'),
  "Packaged Linux attachment verification must use the installed helper when available and never disable Chromium sandboxing.",
);
assert(
  linuxPackagesScriptText.includes(
    'await verifyExtractedNative(extractedNative, appImagePath, "AppImage")',
  ) && !linuxPackagesScriptText.includes('path.join(extractedRoot, "threadleaf")'),
  "AppImage native verification must launch the mounted artifact, not a user-owned extracted sandbox helper.",
);
assert(
  lifecycleScriptText.includes("const packageReadyTimeoutMs = 90_000") &&
    lifecycleScriptText.includes('THREADLEAF_WORKSPACE_OPEN_DIAGNOSTICS: "1"') &&
    lifecycleScriptText.includes("renderedStateTransitions") &&
    lifecycleScriptText.includes("packageReadyTimeoutMs,"),
  "Native lifecycle verification must keep a bounded 90-second readiness gate with rendered progress evidence.",
);
assert(
  lifecycleScriptText.includes("const remainingMs = Math.max(1, deadline - Date.now())") &&
    lifecycleScriptText.includes("Observation exceeded the remaining readiness deadline.") &&
    lifecycleScriptText.includes("last = await Promise.race(["),
  "Native lifecycle readiness must bound each observation, not only the delay between observations.",
);
const serializedCatalogStart = mainProcessText.indexOf(
  "function serializePluginCatalogOperation<T>",
);
const serializedCatalogEnd = mainProcessText.indexOf(
  "async function currentAppearance",
  serializedCatalogStart,
);
const currentCatalogStart = mainProcessText.indexOf("async function currentPluginCatalog");
const currentCatalogEnd = mainProcessText.indexOf(
  "async function currentMigrationPreview",
  currentCatalogStart,
);
assert(
  serializedCatalogStart >= 0 && serializedCatalogEnd > serializedCatalogStart,
  "Main process lost the serialized plugin catalog boundary.",
);
assert(
  currentCatalogStart >= 0 && currentCatalogEnd > currentCatalogStart,
  "Main process lost the current plugin catalog boundary.",
);
const serializedCatalogText = mainProcessText.slice(serializedCatalogStart, serializedCatalogEnd);
const currentCatalogText = mainProcessText.slice(currentCatalogStart, currentCatalogEnd);
assert(
  serializedCatalogText.includes("const startupActivation = initialWorkspaceActivation") &&
    serializedCatalogText.includes(
      "const queuedOperation = startupActivation ? startupActivation.then(run) : run()",
    ) &&
    !currentCatalogText.includes("await initialWorkspaceActivation"),
  "Plugin catalog startup readiness must wait outside the private-mutation queue to prevent a circular wait.",
);
assert(
  lifecycleScriptText.includes("await fs.realpath(os.tmpdir())"),
  "Native lifecycle verifier must seed package state from a canonical temp identity.",
);
assert(
  lifecycleScriptText.includes("async function detachMacDmg") &&
    lifecycleScriptText.includes('["detach", mountPath, "-force", "-quiet"]'),
  "macOS lifecycle verifier must retry and force-detach its DMG.",
);
assert(
  lifecycleScriptText.includes("windowsShortcutPath") &&
    lifecycleScriptText.includes("Windows uninstaller left the desktop shortcut behind"),
  "Native lifecycle verifier lost its measured Windows desktop-shortcut check.",
);
assert(
  !lifecycleScriptText.includes("fs.rm(target") &&
    lifecycleScriptText.includes("userDataArgument") &&
    lifecycleScriptText.includes("--user-data-dir=") &&
    lifecycleScriptText.includes("inPlaceReplacementChecks") &&
    lifecycleScriptText.includes('mode: "explicit-isolated"'),
  "Installer lifecycle must preserve the target and use explicit isolated app data.",
);
assert(
  lifecycleScriptText.includes('path.join(userDataPath, "settings.json")') &&
    !lifecycleScriptText.includes("did not create its platform-default private app-data directory"),
  "Installer lifecycle must measure app-written app-data contents, not just directory presence.",
);
assert(
  !lifecycleScriptText.includes("bytes: 0") &&
    lifecycleScriptText.includes("verifyWindowsZip") &&
    lifecycleScriptText.includes("metadata.files?.length === 1"),
  "Lifecycle package evidence must measure app bytes and verify the Windows ZIP/update split.",
);
assert(
  lifecycleScriptText.includes("nonEmptyOutputLines") &&
    lifecycleScriptText.includes('replaceAll("\\r\\n", "\\n")') &&
    lifecycleScriptText.includes('.filter((line) => line !== "")'),
  "Windows lifecycle version proof must normalize CRLF and ignore Electron's blank framing lines.",
);

const ciOn = record(workflowOn(ci), "CI triggers");
assert(
  Object.keys(ciOn).sort().join(",") === "pull_request,push,workflow_dispatch",
  "CI triggers changed unexpectedly.",
);
assert(
  JSON.stringify(ci.permissions) === JSON.stringify({ contents: "read" }),
  "CI must have read-only repository authority.",
);
assert(ciJobs.integrity, "CI needs a non-skippable local lifecycle integrity job.");
assert(
  record(ciJobs.integrity, "CI integrity job").if === undefined,
  "CI lifecycle integrity job cannot be conditionally skipped.",
);
const integritySteps = stepsFor(record(ciJobs.integrity, "CI integrity job"), "CI integrity job");
assert(
  record(ciJobs.integrity, "CI integrity job")["runs-on"] === "ubuntu-24.04",
  "Integrity job runner is not pinned.",
);
assert(
  integritySteps.some((step) => step.run === "pnpm run test:installer-lifecycle-config"),
  "Integrity job does not run the local lifecycle fixture.",
);

const linuxJob = record(ciJobs.linux, "Linux CI job");
const linuxSteps = stepsFor(linuxJob, "Linux CI job");
const linuxPrepare = stepWithExactRun(
  linuxSteps,
  "pnpm run release:linux:prepare",
  "Linux source and unpacked build",
);
const linuxCheck = stepWithExactRun(
  linuxSteps,
  "pnpm run release:linux:verify",
  "Linux packaged verification",
);
const linuxSandbox = stepContaining(
  linuxSteps,
  "threadleaf-chrome-sandbox",
  "Linux packaged Chromium sandbox preparation",
);
assert(
  linuxSandbox.run
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .join("\n") ===
    'sudo install -o root -g root -m 4755 release/linux-unpacked/chrome-sandbox /usr/local/sbin/threadleaf-chrome-sandbox\nsudo chown root:root release/linux-unpacked/chrome-sandbox\nsudo chmod 4755 release/linux-unpacked/chrome-sandbox\ntest "$(stat -c \'%u:%g:%a\' release/linux-unpacked/chrome-sandbox)" = "0:0:4755"',
  "Linux CI must install the helper and repair the exact unpacked helper used by Electron.",
);
assert(
  linuxSteps.indexOf(linuxPrepare) < linuxSteps.indexOf(linuxSandbox) &&
    linuxSteps.indexOf(linuxSandbox) < linuxSteps.indexOf(linuxCheck),
  "Linux CI must build the unpacked app, prepare its helper, then run packaged checks without rebuilding first.",
);
assert(
  envValue(linuxCheck, "CHROME_DEVEL_SANDBOX", "Linux build and source check") ===
    "/usr/local/sbin/threadleaf-chrome-sandbox",
  "Linux packaged checks must use the prepared Chromium sandbox helper.",
);
assertFishBeforeCheck(linuxSteps, linuxCheck, "Linux CI");

const windowsJob = record(ciJobs.windows, "Windows CI job");
assert(windowsJob.if === undefined, "Windows lifecycle job cannot be conditionally skipped.");
assert(
  windowsJob["runs-on"] === fixture.platforms["windows-x64"].runner,
  "Windows runner differs from the lifecycle fixture.",
);
const windowsSteps = stepsFor(windowsJob, "Windows CI job");
const windowsBuild = stepContaining(windowsSteps, "pack:windows", "Windows package build");
assertMsvcBeforeBuild(windowsSteps, windowsBuild, "Windows CI");
assert(
  envValue(windowsBuild, "CSC_IDENTITY_AUTO_DISCOVERY", "Windows package build") === "false",
  "Windows CI must make unsigned status explicit.",
);
const windowsLifecycle = stepWithExactRun(
  windowsSteps,
  "pnpm run test:installer-lifecycle",
  "Windows lifecycle gate",
);
assert(
  windowsLifecycle.if === undefined,
  "Windows lifecycle gate cannot be conditionally skipped.",
);
assert(
  envValue(windowsLifecycle, "THREADLEAF_PACKAGE_ARCH", "Windows lifecycle gate") === "x64",
  "Windows lifecycle gate must pin x64.",
);
assert(
  envValue(windowsLifecycle, "THREADLEAF_LIFECYCLE_ARTIFACT_DIR", "Windows lifecycle gate") ===
    "lifecycle-artifacts/windows-x64",
  "Windows lifecycle evidence path is not fixed.",
);
assert(
  !JSON.stringify(windowsLifecycle).includes("THREADLEAF_REQUIRE_SIGNED"),
  "Unsigned Windows CI cannot require signing.",
);
const windowsEvidence = windowsSteps.find(
  (step) =>
    step.uses?.startsWith("actions/upload-artifact@") &&
    String(step.with?.path).includes("lifecycle-artifacts/windows-x64"),
);
assert(
  windowsEvidence?.if?.includes("always()") &&
    String(windowsEvidence.with?.path).includes("lifecycle-artifacts/windows-x64"),
  "Windows lifecycle evidence is not retained on failure.",
);

const macJob = record(ciJobs.macos, "macOS CI job");
assert(macJob.if === undefined, "macOS lifecycle job cannot be conditionally skipped.");
const macMatrix = record(record(macJob.strategy, "macOS strategy").matrix, "macOS matrix");
assert(Array.isArray(macMatrix.include), "macOS matrix must enumerate native runner images.");
const intel = macMatrix.include.find((entry) => entry.arch === "x64");
assert(
  intel && intel.runner === fixture.platforms["macos-x64"].runner,
  "Intel macOS runner differs from the lifecycle fixture.",
);
const macSteps = stepsFor(macJob, "macOS CI job");
const macBuild = stepContaining(macSteps, "pack:mac:", "macOS package build");
assert(
  envValue(macBuild, "CSC_IDENTITY_AUTO_DISCOVERY", "macOS package build") === "false",
  "macOS CI must make unsigned status explicit.",
);
const macLifecycle = stepWithExactRun(
  macSteps,
  "pnpm run test:installer-lifecycle",
  "macOS lifecycle gate",
);
assert(
  String(macLifecycle.if).includes("matrix.arch") && String(macLifecycle.if).includes("x64"),
  "macOS lifecycle gate must be limited to Intel x64.",
);
assert(
  envValue(macLifecycle, "THREADLEAF_PACKAGE_ARCH", "macOS lifecycle gate") === "x64",
  "macOS lifecycle gate must pin x64.",
);
assert(
  envValue(macLifecycle, "THREADLEAF_LIFECYCLE_ARTIFACT_DIR", "macOS lifecycle gate") ===
    "lifecycle-artifacts/macos-x64",
  "macOS lifecycle evidence path is not fixed.",
);
assert(
  !JSON.stringify(macLifecycle).includes("THREADLEAF_REQUIRE_SIGNED"),
  "Unsigned macOS CI cannot require signing.",
);
const macEvidence = macSteps.find(
  (step) =>
    step.uses?.startsWith("actions/upload-artifact@") &&
    String(step.with?.path).includes("lifecycle-artifacts/macos-x64"),
);
assert(
  macEvidence?.if?.includes("always()") &&
    String(macEvidence.with?.path).includes("lifecycle-artifacts/macos-x64"),
  "macOS lifecycle evidence is not retained on failure.",
);

const releaseTextEncoded = JSON.stringify(release);
assert(
  releaseTextEncoded.includes("pack:mac:universal"),
  "Signed release lost the macOS package command.",
);
assert(
  releaseTextEncoded.includes("pack:windows:signed"),
  "Signed release lost the Windows package command.",
);
assert(
  releaseTextEncoded.includes("THREADLEAF_REQUIRE_SIGNED"),
  "Signed release does not require signed package verification.",
);
const releaseJobs = record(release.jobs, "release jobs");
const releasePreflight = record(releaseJobs.preflight, "release preflight job");
const releaseLinux = record(releaseJobs.linux, "Linux release candidate job");
const releaseMac = record(releaseJobs.macos, "signed macOS release job");
const releaseWindows = record(releaseJobs.windows, "signed Windows release job");
for (const [job, label] of [
  [releasePreflight, "release preflight job"],
  [releaseLinux, "Linux release candidate job"],
  [releaseMac, "signed macOS release job"],
  [releaseWindows, "signed Windows release job"],
]) {
  assert(job.if === undefined, `${label} cannot be conditionally skipped.`);
  assert(
    !JSON.stringify(job).includes("continue-on-error"),
    `${label} cannot turn a failed release gate into success.`,
  );
}
const releaseLinuxSteps = stepsFor(releaseLinux, "Linux release candidate job");
const releaseLinuxPrepare = stepWithExactRun(
  releaseLinuxSteps,
  "pnpm run release:linux:prepare",
  "Linux release source and unpacked build",
);
const releaseLinuxVerify = stepWithExactRun(
  releaseLinuxSteps,
  "pnpm run release:linux:verify",
  "Linux release build and verify",
);
const releaseLinuxSandbox = stepContaining(
  releaseLinuxSteps,
  "threadleaf-chrome-sandbox",
  "Linux release Chromium sandbox preparation",
);
assert(
  releaseLinuxSteps.indexOf(releaseLinuxPrepare) < releaseLinuxSteps.indexOf(releaseLinuxSandbox) &&
    releaseLinuxSteps.indexOf(releaseLinuxSandbox) < releaseLinuxSteps.indexOf(releaseLinuxVerify),
  "Linux release must prepare the exact unpacked sandbox helper before packaged verification.",
);
assert(
  envValue(releaseLinuxVerify, "CHROME_DEVEL_SANDBOX", "Linux release build and verify") ===
    "/usr/local/sbin/threadleaf-chrome-sandbox",
  "Linux release packaged checks must use the prepared Chromium sandbox helper.",
);
assertFishBeforeCheck(releaseLinuxSteps, releaseLinuxVerify, "Linux release");
assert(
  releaseLinuxVerify.if === undefined,
  "Linux release build and verify cannot be conditionally skipped.",
);
assert(
  releaseLinuxVerify["continue-on-error"] === undefined,
  "Linux release build and verify cannot turn a failed release gate into success.",
);
const releaseMacSteps = stepsFor(releaseMac, "signed macOS release job");
const releaseWindowsSteps = stepsFor(releaseWindows, "signed Windows release job");
const releaseWindowsBuild = stepContaining(
  releaseWindowsSteps,
  "pack:windows:signed",
  "signed Windows package build",
);
assertMsvcBeforeBuild(releaseWindowsSteps, releaseWindowsBuild, "signed Windows release");
const releaseMacVerify = stepWithExactRun(
  releaseMacSteps,
  "pnpm run test:macos-package",
  "signed macOS verification",
);
const releaseWindowsVerify = stepWithExactRun(
  releaseWindowsSteps,
  "pnpm run test:windows-package",
  "signed Windows verification",
);
assert(
  releaseMacVerify.if === undefined,
  "Signed macOS verification cannot be conditionally skipped.",
);
assert(
  releaseWindowsVerify.if === undefined,
  "Signed Windows verification cannot be conditionally skipped.",
);
assert(
  envValue(releaseMacVerify, "THREADLEAF_REQUIRE_SIGNED", "signed macOS verification") === "1",
  "Signed macOS verification must require signing.",
);
assert(
  envValue(releaseWindowsVerify, "THREADLEAF_REQUIRE_SIGNED", "signed Windows verification") ===
    "1",
  "Signed Windows verification must require signing.",
);
const publication = record(releaseJobs["publish-draft"], "publication job");
assert(
  publication.if === `\${{ inputs.publish }}`,
  "Publication must remain manual and fail closed when a required gate fails.",
);
const releaseCandidateJobs = ["preflight", "linux", "macos", "windows"];
assert(Array.isArray(publication.needs), "Publication needs must be a list of jobs.");
assert(
  publication.needs.length === releaseCandidateJobs.length &&
    new Set(publication.needs).size === releaseCandidateJobs.length &&
    releaseCandidateJobs.every((job) => publication.needs.includes(job)),
  "Publication must require exactly every release candidate job, no more and no fewer.",
);
for (const secret of [...fixture.signedRelease.windows, ...fixture.signedRelease.macos]) {
  assert(releaseText.includes(`secrets.${secret}`), `Signed release is missing ${secret}.`);
}
assert(
  packageText.includes(fixture.signedRelease.trustMarker),
  "Signed release trust marker is not configured.",
);

const uses = [...collectUses(ci), ...collectUses(release)];
assert(uses.length > 0, "No workflow actions were found.");
for (const action of uses) {
  assert(
    /^[a-z0-9_.-]+\/[a-z0-9_.-]+@[a-f0-9]{40}$/u.test(action),
    `Workflow action is not pinned: ${action}`,
  );
}
assert(
  !ciText.includes("continue-on-error"),
  "Native CI cannot turn lifecycle failures into success.",
);
assert(
  ciText.includes("windows-2025") && ciText.includes("macos-15-intel"),
  "Native lifecycle runners are not explicit.",
);
assert(
  fixture.unsignedCi.updateTrust === "none" && fixture.unsignedCi.requiresSigning === false,
  "Unsigned fixture policy changed.",
);

process.stdout.write(
  `${JSON.stringify({
    verified: true,
    fixture: "fixtures/installer-lifecycle/contract.json",
    runners: { windows: windowsJob["runs-on"], macosIntel: intel.runner },
    lifecycleScript: fixture.lifecycleScript,
    unsigned: true,
    signedReleaseFailClosed: true,
    pinnedActions: uses.length,
  })}\n`,
);
