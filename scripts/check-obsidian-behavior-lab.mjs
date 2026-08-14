import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIXTURE_ID,
  FIXTURE_PREDICATE,
  generateFixture,
  verifyFixtureManifest,
} from "./obsidian-behavior-lab/fixture.mjs";
import {
  snapshotAllowlistedProfile,
  snapshotTree,
  writeManifest,
} from "./obsidian-behavior-lab/manifest.mjs";
import {
  assertFlatpakContainmentArgs,
  assertMarkerAbsent,
  assertReferenceReceipt,
  assertRunPathContainment,
  captureChildOutput,
  markedProcesses,
  processPlatform,
  reservePort,
  terminateMarkedProcesses,
  waitForExit,
  writeHelperScript,
} from "./obsidian-behavior-lab/process.mjs";
import {
  receiptFor,
  runManifest,
  writeReceipt,
  writeRunManifest,
} from "./obsidian-behavior-lab/receipts.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flatpakId = "md.obsidian.Obsidian";
const declaredReferenceVersion = "1.13.7";
const viewport = { width: 800, height: 650, deviceScaleFactor: 1, pageScaleFactor: 1 };
const labScratchRoot = path.join(os.tmpdir(), "threadleaf-obsidian-lab");
const sourceEvidencePaths = [
  "scripts/check-obsidian-behavior-lab.mjs",
  "scripts/obsidian-behavior-lab/cdp.mjs",
  "scripts/obsidian-behavior-lab/fixture.mjs",
  "scripts/obsidian-behavior-lab/lab.test.mjs",
  "scripts/obsidian-behavior-lab/manifest.mjs",
  "scripts/obsidian-behavior-lab/process.mjs",
  "scripts/obsidian-behavior-lab/receipts.mjs",
  "scripts/obsidian-behavior-lab/sandbox-supervisor.py",
  "scripts/obsidian-behavior-lab/sandbox-supervisor.test.py",
  "compatibility/obsidian-lab-fixture.v1.json",
  "package.json",
];
const args = new Set(process.argv.slice(2));
const redControl = args.has("--red-control");
const keepRun = !args.has("--cleanup");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function commandResult(
  command,
  commandArgs,
  { cwd = appRoot, env = process.env, timeoutMs = 4_000 } = {},
) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      resolve({
        ...result,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    };
    child.once("error", (error) => finish({ code: null, signal: null, error: String(error) }));
    child.once("close", (code, signal) => finish({ code, signal }));
    setTimeout(() => {
      if (!finished) {
        child.kill("SIGTERM");
        finish({ code: null, signal: "timeout" });
      }
    }, timeoutMs).unref();
  });
}

async function flatpakReference() {
  const info = await commandResult("flatpak", ["info", flatpakId]);
  if (info.code !== 0) return null;
  const text = info.stdout.toString("utf8");
  const value = (label) =>
    new RegExp(`^\\s*${label}:\\s*(.+)$`, "mu").exec(text)?.[1]?.trim() ?? null;
  const [commit, runtime, location] = await Promise.all(
    ["--show-commit", "--show-runtime", "--show-location"].map(async (flag) => {
      const result = await commandResult("flatpak", ["info", flag, flatpakId]);
      return result.code === 0 ? result.stdout.toString("utf8").trim() : null;
    }),
  );
  return {
    version: value("Version"),
    commit,
    runtime,
    location,
    executable: "/app/obsidian",
  };
}

async function flatpakInstances() {
  const result = await commandResult("flatpak", ["ps", "-j"]);
  if (result.code !== 0)
    return { error: result.stderr.toString("utf8").slice(0, 1024), entries: [] };
  try {
    const entries = JSON.parse(result.stdout.toString("utf8"));
    return {
      entries: Array.isArray(entries)
        ? entries
            .filter((entry) => entry?.application === flatpakId)
            .map((entry) => ({
              instance: String(entry.instance ?? ""),
              pid: String(entry.pid ?? ""),
              application: flatpakId,
              runtime: String(entry.runtime ?? ""),
            }))
        : [],
    };
  } catch (error) {
    return { error: `flatpak ps JSON parse failed: ${String(error)}`, entries: [] };
  }
}

async function waitForFlatpakQuiescence(label, timeoutMs = 5_000) {
  const started = Date.now();
  const samples = [];
  let latest = await flatpakInstances();
  while (Date.now() - started <= timeoutMs) {
    samples.push({
      elapsedMs: Date.now() - started,
      entries: latest.entries,
      error: latest.error ?? null,
    });
    if (latest.error || latest.entries.length === 0) {
      return {
        status: latest.error ? "blocked" : "observed",
        label,
        timeoutMs,
        elapsedMs: Date.now() - started,
        samples: samples.slice(-16),
        latest,
      };
    }
    await delay(100);
    latest = await flatpakInstances();
  }
  return {
    status: "blocked",
    label,
    timeoutMs,
    elapsedMs: Date.now() - started,
    samples: samples.slice(-16),
    latest,
    reason: "Flatpak app instances did not quiesce before the bounded probe deadline.",
  };
}

async function memorySnapshot() {
  const result = await commandResult("free", ["-k"], { timeoutMs: 1_000 });
  const line = result.stdout
    .toString("utf8")
    .split("\n")
    .find((candidate) => /^Mem:\s+/u.test(candidate));
  const columns = line?.trim().split(/\s+/u) ?? [];
  const availableKiB = Number(columns[6]);
  const parsed = result.code === 0 && Number.isFinite(availableKiB);
  const availableBytes = parsed ? availableKiB * 1024 : 0;
  return {
    command: ["free", "-k"],
    stdout: result.stdout.toString("utf8").slice(0, 2048),
    stderr: result.stderr.toString("utf8").slice(0, 2048),
    exit: { code: result.code, signal: result.signal },
    availableKiB: Number.isFinite(availableKiB) ? availableKiB : null,
    availableBytes,
    minimumKiB: 8 * 1024 * 1024,
    sufficient: parsed && availableBytes >= 8 * 1024 * 1024 * 1024,
  };
}

async function sourceEvidence() {
  const entries = [];
  for (const relativePath of sourceEvidencePaths) {
    const bytes = await fs.readFile(path.join(appRoot, relativePath));
    entries.push({
      path: relativePath,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  const sourceTreeSha256 = createHash("sha256")
    .update(entries.map((entry) => `${entry.path}\0${entry.bytes}\0${entry.sha256}\n`).join(""))
    .digest("hex");
  const [head, tree] = await Promise.all(
    ["HEAD", "HEAD^{tree}"].map(async (revision) => {
      const result = await commandResult("git", ["rev-parse", revision], { cwd: appRoot });
      return result.code === 0 ? result.stdout.toString("utf8").trim() : null;
    }),
  );
  return {
    schemaVersion: 1,
    candidate: { gitHead: head, gitTree: tree },
    sourceTreeSha256,
    files: entries,
  };
}

function parseContainmentProbe(text) {
  const value = (name) => new RegExp(`^${name}=(.*)$`, "mu").exec(text)?.[1]?.trim() ?? null;
  const routeCount = Number(value("route-lines"));
  const devices = (value("devices") ?? "").split(",").filter(Boolean).sort();
  return {
    namespace: value("namespace"),
    routeCount: Number.isFinite(routeCount) ? routeCount : null,
    devices,
    noEgressEvidence: routeCount === 0 && JSON.stringify(devices) === JSON.stringify(["lo"]),
  };
}

async function runContainmentProbe(runRoot) {
  const hostNetworkNamespace = await fs.readlink("/proc/self/ns/net");
  const shellProbe =
    'printf "namespace=%s\\n" "$(readlink /proc/self/ns/net)"; printf "route-lines=%s\\n" "$(awk \'NR>1 && NF{n++} END{print n+0}\' /proc/net/route)"; printf "devices=%s\\n" "$(awk \'NR>2 && /:/{gsub(/^[ \\t]+|[ \\t]+$/, "", $1); sub(/:$/, "", $1); print $1}\' /proc/net/dev | sort | tr "\\n" ",")"';
  const commonArgs = [
    "run",
    "--sandbox",
    "--die-with-parent",
    "--unshare=network",
    "--nofilesystem=home",
    "--command=/usr/bin/sh",
    flatpakId,
    "-c",
    shellProbe,
  ];
  const isolatedArgs = [...commonArgs];
  const isolated = await commandResult("flatpak", isolatedArgs, {
    env: { ...process.env, TMPDIR: labScratchRoot },
  });
  const isolatedObservation = parseContainmentProbe(isolated.stdout.toString("utf8"));
  const isolatedQuiescence = await waitForFlatpakQuiescence("isolated containment probe");
  const parentArgs = [
    "run",
    "--sandbox",
    "--die-with-parent",
    `--parent-pid=${process.pid}`,
    "--parent-share-pids",
    "--parent-expose-pids",
    "--unshare=network",
    "--nofilesystem=home",
    "--command=/usr/bin/sh",
    flatpakId,
    "-c",
    shellProbe,
  ];
  const parentProbe = await commandResult("flatpak", parentArgs, {
    env: { ...process.env, TMPDIR: labScratchRoot },
  });
  const parentQuiescence = await waitForFlatpakQuiescence("parent-PID rejection probe");
  const result = {
    schemaVersion: 1,
    hostNetworkNamespace,
    noParent: {
      command: ["flatpak", ...isolatedArgs],
      exit: { code: isolated.code, signal: isolated.signal },
      observation: isolatedObservation,
      stdout: isolated.stdout.toString("utf8").slice(0, 2048),
      stderr: isolated.stderr.toString("utf8").slice(0, 2048),
      distinctNetworkNamespace: isolatedObservation.namespace !== hostNetworkNamespace,
      status:
        isolated.code === 0 &&
        isolatedObservation.namespace &&
        isolatedObservation.namespace !== hostNetworkNamespace &&
        isolatedObservation.noEgressEvidence
          ? "observed"
          : "blocked",
    },
    parentPidSharing: {
      command: ["flatpak", ...parentArgs],
      exit: { code: parentProbe.code, signal: parentProbe.signal },
      stdout: parentProbe.stdout.toString("utf8").slice(0, 2048),
      stderr: parentProbe.stderr.toString("utf8").slice(0, 2048),
      status: parentProbe.code === 0 ? "unexpectedly-observed" : "blocked-as-expected",
      expected: "host PID sharing is unavailable in this Flatpak/bwrap environment",
    },
    probeQuiescence: {
      isolated: isolatedQuiescence,
      parentPidSharing: parentQuiescence,
      status:
        isolatedQuiescence.status === "observed" && parentQuiescence.status === "observed"
          ? "observed"
          : "blocked",
    },
  };
  await writeManifest(path.join(runRoot, "harness", "containment-probe.v1.json"), result);
  return result;
}

function relativeArtifacts(runRoot, paths) {
  return paths
    .filter(Boolean)
    .map((filePath) => path.relative(runRoot, filePath).split(path.sep).join("/"));
}

function singleFileRoundtrip(before, after, targetPath, expectedBeforeSha256, expectedAfterSha256) {
  const allowedReferenceVaultPaths = new Map([
    [".obsidian/app.json", 4 * 1024],
    [".obsidian/appearance.json", 4 * 1024],
    [".obsidian/core-plugins.json", 64 * 1024],
    [".obsidian/workspace.json", 256 * 1024],
  ]);
  const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])].sort();
  const changedPaths = paths.filter(
    (entryPath) =>
      JSON.stringify(beforeByPath.get(entryPath)) !== JSON.stringify(afterByPath.get(entryPath)),
  );
  const targetBefore = beforeByPath.get(targetPath);
  const targetAfter = afterByPath.get(targetPath);
  const allowedMetadataPaths = changedPaths.filter((entryPath) => {
    const entry = afterByPath.get(entryPath);
    const maxBytes = allowedReferenceVaultPaths.get(entryPath);
    return (
      maxBytes !== undefined &&
      entry?.kind === "file" &&
      entry.bytes <= maxBytes &&
      (entry.mode === 0o600 || entry.mode === 0o644)
    );
  });
  const unexpectedPaths = changedPaths.filter(
    (entryPath) => entryPath !== targetPath && !allowedMetadataPaths.includes(entryPath),
  );
  const equal =
    unexpectedPaths.length === 0 &&
    targetBefore?.sha256 === expectedBeforeSha256 &&
    targetAfter?.sha256 === expectedAfterSha256 &&
    targetAfter?.mode === targetBefore?.mode &&
    targetAfter?.bytes > targetBefore?.bytes;
  return {
    equal,
    targetPath,
    changedPaths,
    allowedMetadataPaths,
    unexpectedPaths,
    beforeSha256: targetBefore?.sha256 ?? null,
    afterSha256: targetAfter?.sha256 ?? null,
    expectedBeforeSha256,
    expectedAfterSha256,
  };
}

async function artifactInventory(current, relative = "") {
  const entries = [];
  const children = await fs.readdir(current, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    const childPath = path.join(current, child.name);
    const childRelative = relative ? path.join(relative, child.name) : child.name;
    const normalized = childRelative.split(path.sep).join("/");
    if (child.isDirectory()) {
      entries.push(...(await artifactInventory(childPath, normalized)));
      continue;
    }
    if (child.isSymbolicLink()) {
      const target = await fs.readlink(childPath);
      const targetBytes = Buffer.from(target, "utf8");
      entries.push({
        path: normalized,
        kind: "symlink",
        bytes: targetBytes.length,
        sha256: createHash("sha256").update(targetBytes).digest("hex"),
        target: target.slice(0, 1024),
        mode: (await fs.lstat(childPath)).mode & 0o777,
      });
      continue;
    }
    if (!child.isFile())
      throw new Error(`Artifact inventory encountered unsupported path: ${normalized}`);
    const bytes = await fs.readFile(childPath);
    entries.push({
      path: normalized,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mode: (await fs.stat(childPath)).mode & 0o777,
    });
  }
  return entries;
}

async function runHarnessIntegrity(runRoot, marker) {
  const helperOutput = path.join(runRoot, "harness", "helper-result.json");
  const helperPath = await writeHelperScript(runRoot);
  const stdoutPath = path.join(runRoot, "process", "harness-stdout.bin");
  const stderrPath = path.join(runRoot, "process", "harness-stderr.bin");
  await fs.mkdir(path.dirname(stdoutPath), { recursive: true, mode: 0o700 });
  const harnessEnvironment = { ...process.env, [marker]: "1", TMPDIR: labScratchRoot };
  delete harnessEnvironment.WAYLAND_DISPLAY;
  const child = spawn(
    "xvfb-run",
    ["-a", "-s", "-screen 0 1440x840x24 -nolisten tcp", process.execPath, helperPath, helperOutput],
    {
      cwd: appRoot,
      env: harnessEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const flushOutput = captureChildOutput(child, stdoutPath, stderrPath);
  const exit = await waitForExit(child, 8_000);
  await flushOutput();
  let helperResult = null;
  try {
    helperResult = JSON.parse(await fs.readFile(helperOutput, "utf8"));
  } catch {
    // The receipt below explains the failed positive control.
  }
  const markedBeforeCleanup = await markedProcesses(marker);
  const cleanup = await terminateMarkedProcesses(marker);
  const markedAfterCleanup = await markedProcesses(marker);
  assert(exit.code === 0, `Harness helper exited unexpectedly: ${JSON.stringify(exit)}`);
  assert(helperResult?.display?.startsWith(":"), "Harness helper did not run under Xvfb.");
  assert(markedBeforeCleanup.length > 0, "Harness helper did not produce a marked detached child.");
  assert(
    cleanup.clean && markedAfterCleanup.length === 0,
    "Marked harness child survived cleanup.",
  );
  return {
    status: "observed",
    output: {
      display: helperResult.display,
      detachedChildPid: helperResult.childPid,
      exit,
      markedBeforeCleanup,
      cleanup,
      markedAfterCleanup,
      networkGate: "reference-launch-required",
      process: processPlatform(),
    },
    artifacts: relativeArtifacts(runRoot, [helperOutput, stdoutPath, stderrPath]),
  };
}

export function flatpakArgs(
  runRoot,
  profilePath,
  vaultPath,
  cdpPort,
  marker,
  { hostNetworkNamespace, referenceVersion, referenceRuntime, referenceCommit },
) {
  const supervisorPath = path.join(runRoot, "harness", "sandbox-supervisor.py");
  const busPath = path.join(runRoot, "bus");
  return [
    "run",
    "--sandbox",
    "--die-with-parent",
    "--unshare=network",
    "--nofilesystem=home",
    `--filesystem=${runRoot}:rw`,
    "--socket=x11",
    "--nosocket=wayland",
    `--env=${marker}=1`,
    `--env=DBUS_SESSION_BUS_ADDRESS=unix:path=${busPath}`,
    "--command=/usr/bin/python3",
    flatpakId,
    supervisorPath,
    "--run-root",
    runRoot,
    "--profile",
    profilePath,
    "--vault",
    vaultPath,
    "--cdp-port",
    String(cdpPort),
    "--marker",
    marker,
    "--host-network-namespace",
    hostNetworkNamespace,
    "--reference-version",
    referenceVersion,
    "--reference-runtime",
    referenceRuntime,
    "--reference-commit",
    referenceCommit,
    "--screenshot",
    path.join(runRoot, "ui", "UI-01.png"),
    "--result",
    path.join(runRoot, "harness", "supervisor-result.v1.json"),
  ];
}

async function launchReference(runRoot, profilePath, vaultPath, marker, referenceMetadata) {
  const preInstances = await flatpakInstances();
  const preMarked = await markedProcesses(marker);
  assert(
    !preInstances.error,
    `Could not establish a safe Flatpak instance baseline: ${preInstances.error}`,
  );
  assert(
    preInstances.entries.length === 0,
    `An installed Obsidian Flatpak instance is already running; refusing to touch it: ${JSON.stringify(preInstances.entries)}`,
  );
  assert(
    preMarked.length === 0,
    `A reference marker instance is already running; refusing to touch it: ${JSON.stringify(preMarked)}`,
  );
  const cdpPort = await reservePort();
  const hostNetworkNamespace = await fs.readlink("/proc/self/ns/net");
  const launchPath = path.join(runRoot, "launch.json");
  const stdoutPath = path.join(runRoot, "process", "stdout.bin");
  const stderrPath = path.join(runRoot, "process", "stderr.bin");
  const launchArgs = flatpakArgs(runRoot, profilePath, vaultPath, cdpPort, marker, {
    hostNetworkNamespace,
    referenceVersion: referenceMetadata?.version ?? "unknown",
    referenceRuntime: referenceMetadata?.runtime ?? "unknown",
    referenceCommit: referenceMetadata?.commit ?? "unknown",
  });
  assertFlatpakContainmentArgs(launchArgs, { runRoot });
  const launchConfigPath = path.join(runRoot, "harness", "flatpak-argv.json");
  const launcherPath = path.join(runRoot, "harness", "flatpak-launcher.mjs");
  const supervisorSource = path.join(
    appRoot,
    "scripts",
    "obsidian-behavior-lab",
    "sandbox-supervisor.py",
  );
  const supervisorPath = path.join(runRoot, "harness", "sandbox-supervisor.py");
  await fs.mkdir(path.dirname(launcherPath), { recursive: true, mode: 0o700 });
  await Promise.all([
    fs.mkdir(path.join(runRoot, "xdg-config"), { recursive: true, mode: 0o700 }),
    fs.mkdir(path.join(runRoot, "xdg-cache"), { recursive: true, mode: 0o700 }),
    fs.mkdir(path.join(runRoot, "xdg-data"), { recursive: true, mode: 0o700 }),
    fs.copyFile(supervisorSource, supervisorPath),
  ]);
  await fs.chmod(supervisorPath, 0o600);
  const busPath = path.join(runRoot, "bus");
  await fs.writeFile(
    launchConfigPath,
    `${JSON.stringify({ args: launchArgs, busPath, hostNetworkNamespace }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const launcherSource = `import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { once } from "node:events";
const config = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
const busAddress = \`unix:path=\${config.busPath}\`;
const environment = { ...process.env, DBUS_SESSION_BUS_ADDRESS: busAddress };
const bus = spawn("dbus-daemon", ["--session", \`--address=\${busAddress}\`, "--nofork"], {
  stdio: "ignore",
  env: environment,
});
const waitForSocket = async () => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const info = await fs.stat(config.busPath);
      if (info.isSocket()) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("private session bus did not become ready");
};
let child;
try {
  await waitForSocket();
  child = spawn("flatpak", config.args, { stdio: "inherit", env: environment });
  child.once("error", (error) => { console.error(error); process.exitCode = 127; });
  const [code, signal] = await once(child, "exit");
  bus.kill("SIGTERM");
  if (signal) process.kill(process.pid, signal); else process.exit(code ?? 1);
} catch (error) {
  console.error(error);
  if (child && child.exitCode === null) child.kill("SIGTERM");
  bus.kill("SIGTERM");
  process.exitCode = 1;
}
`;
  await fs.writeFile(launcherPath, launcherSource, { mode: 0o600 });
  await fs.chmod(launcherPath, 0o600);
  const launchEnvironment = {
    ...process.env,
    [marker]: "1",
    ELECTRON_OZONE_PLATFORM_HINT: "x11",
    LANG: "en_CA.UTF-8",
    LC_ALL: "en_CA.UTF-8",
    TZ: "America/Toronto",
    TMPDIR: labScratchRoot,
  };
  delete launchEnvironment.WAYLAND_DISPLAY;
  const child = spawn(
    "xvfb-run",
    [
      "-a",
      "-s",
      "-screen 0 1440x840x24 -nolisten tcp",
      process.execPath,
      launcherPath,
      launchConfigPath,
    ],
    {
      cwd: appRoot,
      env: launchEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const flushOutput = captureChildOutput(child, stdoutPath, stderrPath);
  await writeManifest(launchPath, {
    schemaVersion: 1,
    product: flatpakId,
    executable: "installed Flatpak public launcher",
    argv: ["xvfb-run", ...launchArgs],
    environment: {
      display: "xvfb-x11",
      viewport,
      locale: "en-CA",
      timezone: "America/Toronto",
      network: "flatpak --unshare=network",
      profile: path.relative(runRoot, profilePath).split(path.sep).join("/"),
      vault: path.relative(runRoot, vaultPath).split(path.sep).join("/"),
      processVisibility: "in-sandbox supervisor; host PID namespace is not shared",
      hostNetworkNamespace,
    },
  });
  return {
    child,
    cdpPort,
    launchArgs,
    stdoutPath,
    stderrPath,
    flushOutput,
    preInstances,
    preMarked,
    hostNetworkNamespace,
    referenceVersion: referenceMetadata?.version ?? "unknown",
    referenceCommit: referenceMetadata?.commit ?? "unknown",
    exitPromise: waitForExit(child, 45_000),
  };
}

async function captureReference(runRoot, launch, marker, expected) {
  const exit = await launch.exitPromise;
  await launch.flushOutput();
  if (exit.code === null && exit.signal === "timeout") launch.child.kill("SIGTERM");
  const supervisorPath = path.join(runRoot, "harness", "supervisor-result.v1.json");
  let supervisor = null;
  let supervisorError = null;
  try {
    supervisor = JSON.parse(await fs.readFile(supervisorPath, "utf8"));
  } catch (error) {
    supervisorError = String(error);
  }
  const cleanup = await terminateMarkedProcesses(marker);
  const finalMarked = await markedProcesses(marker);
  let flatpakAfter = await flatpakInstances();
  const flatpakDeadline = Date.now() + 5_000;
  while (!flatpakAfter.error && flatpakAfter.entries.length > 0 && Date.now() < flatpakDeadline) {
    await delay(100);
    flatpakAfter = await flatpakInstances();
  }
  const hostCleanup = {
    marker: cleanup,
    markerBefore: launch.preMarked,
    finalMarked,
    flatpakBefore: launch.preInstances,
    flatpakAfter,
    clean:
      cleanup.clean &&
      finalMarked.length === 0 &&
      !flatpakAfter.error &&
      flatpakAfter.entries.length === 0,
  };
  if (!supervisor) {
    return {
      status: "blocked",
      reason: `In-sandbox supervisor receipt was unavailable: ${supervisorError}`,
      exit,
      hostCleanup,
      stderrPreview: (await fs.readFile(launch.stderrPath).catch(() => Buffer.alloc(0)))
        .toString("utf8")
        .slice(0, 2048),
    };
  }
  const observed = { ...supervisor, hostCleanup };
  if (supervisor.status !== "observed") {
    return {
      status: "blocked",
      reason: supervisor.reason ?? "In-sandbox supervisor blocked the reference observation.",
      observed,
      exit,
      hostCleanup,
    };
  }
  try {
    assertReferenceReceipt(observed, {
      ...expected,
      profileAfterTreeSha256: supervisor.pathsAfterCleanup?.profile?.treeSha256,
      vaultAfterTreeSha256: supervisor.pathsAfterCleanup?.vault?.treeSha256,
    });
  } catch (error) {
    return {
      status: "blocked",
      reason: String(error),
      observed,
      exit,
      hostCleanup,
    };
  }
  if (!hostCleanup.clean || exit.code !== 0) {
    return {
      status: "blocked",
      reason: "In-sandbox observation completed, but host-side launcher cleanup was not complete.",
      observed,
      exit,
      hostCleanup,
    };
  }
  return {
    status: "observed",
    observed,
    exit,
    hostCleanup,
  };
}

async function blockedCliReceipt(_runRoot) {
  return receiptFor("CLI-01", "blocked", {
    reason:
      "The installed Flatpak exposes a GUI launcher only for this isolated lane; no separately authorized, isolated public CLI binary was reached. No guessed command was executed.",
    input: { argv: "not-run", stdin: "empty", cwd: "outside-vault" },
    output: { attempted: false },
    artifacts: [],
    tolerance: { classification: "blocked is not a pass" },
    redControl: {
      id: "RC-CLI-01",
      expected: "A guessed GUI flag must never be recorded as CLI evidence.",
    },
    threadleafSeam: ["src/cli/command-line.ts"],
  });
}

async function run() {
  await fs.mkdir(labScratchRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(labScratchRoot, 0o700);
  const runRoot = await fs.mkdtemp(path.join(labScratchRoot, "run-"));
  await fs.chmod(runRoot, 0o700);
  const marker = `THREADLEAF_OBSIDIAN_LAB_RUN_${path
    .basename(runRoot)
    .replace(/[^A-Za-z0-9]/gu, "")
    .slice(-12)}`;
  const vaultPath = path.join(runRoot, "vault-data");
  const profilePath = path.join(runRoot, "profile-data");
  const fixtureManifestPath = path.join(runRoot, "fixture-manifest.v1.json");
  const committedFixtureManifestPath = path.join(
    appRoot,
    "compatibility",
    "obsidian-lab-fixture.v1.json",
  );
  const profileBeforePath = path.join(runRoot, "profile", "before.manifest.json");
  const profileAfterPath = path.join(runRoot, "profile", "after.manifest.json");
  await fs.mkdir(path.join(runRoot, "process"), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(runRoot, "ui"), { recursive: true, mode: 0o700 });
  await fs.mkdir(profilePath, { recursive: true, mode: 0o700 });
  assertRunPathContainment(
    { scratchRoot: labScratchRoot, runRoot, profilePath, vaultPath },
    "Observer run",
  );
  const generated = await generateFixture(vaultPath, { manifestPath: fixtureManifestPath });
  const source = await sourceEvidence();
  const vaultId = createHash("sha256").update(vaultPath).digest("hex").slice(0, 16);
  await fs.writeFile(
    path.join(profilePath, "obsidian.json"),
    `${JSON.stringify({ vaults: { [vaultId]: { path: vaultPath, ts: Date.now(), open: true } } }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(profilePath, `${vaultId}.json`),
    `${JSON.stringify({ x: 0, y: 0, width: viewport.width, height: viewport.height, isMaximized: false, devTools: false, zoom: 0 }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const generatedManifest = JSON.parse(await fs.readFile(fixtureManifestPath, "utf8"));
  const fixtureManifest = JSON.parse(await fs.readFile(committedFixtureManifestPath, "utf8"));
  assert(
    JSON.stringify(generatedManifest) === JSON.stringify(fixtureManifest),
    "Generated fixture does not match the committed fixture manifest.",
  );
  await verifyFixtureManifest(vaultPath, fixtureManifest);
  await assertMarkerAbsent(marker, "reference run marker");
  const vaultBefore = await snapshotTree(vaultPath, { label: "FILE-01 before" });
  const profileBeforeTree = await snapshotTree(profilePath, { label: "profile tree before" });
  const profileBefore = await snapshotAllowlistedProfile(profilePath, {
    label: "profile before",
    extraCapturedFiles: [`${vaultId}.json`],
  });
  await writeManifest(path.join(runRoot, "vault", "before.manifest.json"), vaultBefore);
  await writeManifest(
    path.join(runRoot, "profile", "before.tree.manifest.json"),
    profileBeforeTree,
  );
  await writeManifest(profileBeforePath, profileBefore);
  if (redControl) {
    await fs.appendFile(path.join(vaultPath, "00 Overview.md"), "RED-CONTROL\n");
    let rejected = false;
    try {
      await verifyFixtureManifest(vaultPath, fixtureManifest);
    } catch {
      rejected = true;
    }
    assert(rejected, "RC-FILE-01 did not reject a mutated fixture byte.");
    process.stdout.write(
      `${JSON.stringify({ runRoot, redControl: "RC-FILE-01 observed" }, null, 2)}\n`,
    );
    return;
  }

  const referenceMetadata = await flatpakReference();
  const referenceVersion = referenceMetadata?.version ?? null;
  const referenceRuntime = referenceMetadata?.runtime ?? null;
  const memoryGates = [];
  const base = runManifest({
    runId: path.basename(runRoot),
    reference: {
      product: "Obsidian",
      flatpakId,
      version: referenceVersion,
      commit: referenceMetadata?.commit ?? null,
      runtime: referenceRuntime,
      location: referenceMetadata?.location ?? null,
      executable: referenceMetadata?.executable ?? null,
      platform: `${process.platform}-${process.arch}`,
      build: "installed Flatpak public release",
    },
    environment: {
      display: "Xvfb 1440x840x24 X11",
      viewport,
      locale: "en-CA",
      timezone: "America/Toronto",
      network: "denied by Flatpak --unshare=network",
      fixtureId: FIXTURE_ID,
      profile: "fresh-per-run",
      scratchRoot: labScratchRoot,
      memoryFloor: "free -k MemAvailable >= 8388608 KiB immediately before every dynamic launch",
    },
    fixtureId: FIXTURE_ID,
    profile: path.relative(runRoot, profilePath).split(path.sep).join("/"),
  });
  const receipts = [];
  base.environment.fixturePredicate = FIXTURE_PREDICATE;
  let containmentProbe;
  const containmentMemory = await memorySnapshot();
  memoryGates.push({ launch: "flatpak containment probe", ...containmentMemory });
  if (!containmentMemory.sufficient) {
    containmentProbe = {
      schemaVersion: 1,
      status: "blocked",
      reason:
        "Available memory is below the 8 GiB Flatpak probe floor; no Flatpak launch was attempted.",
      memory: containmentMemory,
      hostNetworkNamespace: await fs.readlink("/proc/self/ns/net").catch(() => null),
    };
  } else {
    try {
      containmentProbe = await runContainmentProbe(runRoot);
    } catch (error) {
      containmentProbe = {
        schemaVersion: 1,
        status: "blocked",
        reason: String(error),
        hostNetworkNamespace: await fs.readlink("/proc/self/ns/net").catch(() => null),
      };
    }
  }
  await writeManifest(path.join(runRoot, "harness", "containment-probe.v1.json"), containmentProbe);
  const harnessMemory = await memorySnapshot();
  memoryGates.push({ launch: "Xvfb harness", ...harnessMemory });
  const harness = !harnessMemory.sufficient
    ? {
        status: "blocked",
        reason:
          "Available memory is below the 8 GiB Xvfb harness floor; no Xvfb launch was attempted.",
        output: { memory: harnessMemory },
        artifacts: [],
      }
    : await runHarnessIntegrity(runRoot, marker).catch((error) => ({
        status: "blocked",
        reason: String(error),
        output: {},
        artifacts: [],
      }));
  const harnessReceipt = receiptFor("HARNESS-00", harness.status, {
    reason: harness.reason,
    input: {
      fixtureId: FIXTURE_ID,
      display: "xvfb-run -a -s '-screen 0 1440x840x24 -nolisten tcp'",
      network: "reference launch is required for the namespace proof",
    },
    output: { ...harness.output, containmentProbe },
    artifacts: [...(harness.artifacts ?? []), "harness/containment-probe.v1.json"],
    tolerance: { marker: "exact", x11: "explicit", pids: "dynamic", pathRoot: "run-root only" },
    redControl: {
      id: "RC-HARNESS-00",
      expected: "byte mutation, missing X11 flag, or leaked marked child fails loudly",
    },
    threadleafSeam: ["visual/README.md", "scripts/check-visual-regression.mjs"],
  });
  receipts.push(harnessReceipt);

  const cliReceipt = await blockedCliReceipt(runRoot);
  receipts.push(cliReceipt);

  let referenceReceipt;
  if (harness.status !== "observed") {
    referenceReceipt = {
      status: "blocked",
      reason: "HARNESS-00 containment positive control failed.",
    };
  } else if (!referenceVersion) {
    referenceReceipt = {
      status: "blocked",
      reason:
        "Installed Flatpak version could not be resolved; exact executable/version binding is required.",
      details: { flatpakId, version: referenceVersion },
    };
  } else if (referenceVersion !== declaredReferenceVersion) {
    referenceReceipt = {
      status: "blocked",
      reason: `Installed Flatpak version ${referenceVersion} does not match the declared ${declaredReferenceVersion} lab release.`,
      details: {
        flatpakId,
        expectedVersion: declaredReferenceVersion,
        actualVersion: referenceVersion,
      },
    };
  } else if (!referenceRuntime) {
    referenceReceipt = {
      status: "blocked",
      reason:
        "Installed Flatpak runtime could not be resolved; exact app/runtime binding is required.",
      details: { flatpakId, runtime: referenceRuntime },
    };
  } else if (!referenceMetadata.commit) {
    referenceReceipt = {
      status: "blocked",
      reason: "Installed Flatpak commit could not be resolved; exact app provenance is required.",
      details: { flatpakId, commit: referenceMetadata.commit },
    };
  } else {
    const referenceMemory = await memorySnapshot();
    memoryGates.push({ launch: "Obsidian Flatpak reference", ...referenceMemory });
    if (!referenceMemory.sufficient) {
      referenceReceipt = {
        status: "blocked",
        reason:
          "Available memory is below the 8 GiB launch floor; Flatpak/Electron launch was not attempted.",
        details: { memory: referenceMemory },
      };
    } else if (
      containmentProbe.noParent?.status !== "observed" ||
      containmentProbe.parentPidSharing?.status !== "blocked-as-expected" ||
      containmentProbe.probeQuiescence?.status !== "observed"
    ) {
      referenceReceipt = {
        status: "blocked",
        reason:
          "Flatpak containment did not prove a distinct no-egress namespace without host PID sharing.",
        details: { containmentProbe },
      };
    } else {
      let launch;
      try {
        launch = await launchReference(runRoot, profilePath, vaultPath, marker, referenceMetadata);
        referenceReceipt = await captureReference(runRoot, launch, marker, {
          runRoot,
          profilePath,
          vaultPath,
          vaultTreeSha256: generated.manifest.treeSha256,
          profileBeforeTreeSha256: profileBeforeTree.treeSha256,
          referenceVersion,
          referenceRuntime,
          referenceCommit: referenceMetadata.commit,
          hostNetworkNamespace: launch.hostNetworkNamespace,
        });
      } catch (error) {
        if (launch) {
          try {
            launch.child.kill("SIGTERM");
          } catch {
            // The launcher may have exited before the containment failure was observed.
          }
        }
        const exit = launch ? await launch.exitPromise : null;
        if (launch) await launch.flushOutput();
        const stderr = launch
          ? await fs.readFile(launch.stderrPath).catch(() => Buffer.alloc(0))
          : Buffer.alloc(0);
        const cleanup = await terminateMarkedProcesses(marker);
        referenceReceipt = {
          status: "blocked",
          reason: String(error),
          details: {
            exit,
            stderrPreview: stderr.toString("utf8").slice(0, 1024),
            cleanup,
            flatpakAfter: await flatpakInstances(),
          },
        };
      }
    }
  }
  if (referenceReceipt?.status !== "observed") {
    harnessReceipt.status = "blocked";
    harnessReceipt.provenance = "blocked";
    harnessReceipt.reason =
      referenceReceipt?.reason ?? "Reference containment precondition failed.";
    harnessReceipt.output = {
      ...harnessReceipt.output,
      referenceLaunch: referenceReceipt,
    };
  }

  const vaultAfter = await snapshotTree(vaultPath, { label: "FILE-01 after" });
  const profileAfterTree = await snapshotTree(profilePath, { label: "profile tree after" });
  const profileAfter = await snapshotAllowlistedProfile(profilePath, {
    label: "profile after",
    extraCapturedFiles: [`${vaultId}.json`],
  });
  if (
    referenceReceipt?.status === "observed" &&
    referenceReceipt.observed?.pathsAfterCleanup?.profile?.treeSha256 !==
      profileAfterTree.treeSha256
  ) {
    referenceReceipt = {
      ...referenceReceipt,
      status: "blocked",
      reason: "Host profile after-tree hash disagreed with the in-sandbox cleanup receipt.",
    };
    harnessReceipt.status = "blocked";
    harnessReceipt.provenance = "blocked";
    harnessReceipt.reason = referenceReceipt.reason;
  }
  if (
    referenceReceipt?.status === "observed" &&
    referenceReceipt.observed?.pathsAfterCleanup?.vault?.treeSha256 !== vaultAfter.treeSha256
  ) {
    referenceReceipt = {
      ...referenceReceipt,
      status: "blocked",
      reason: "Host vault after-tree hash disagreed with the in-sandbox exact-save receipt.",
    };
    harnessReceipt.status = "blocked";
    harnessReceipt.provenance = "blocked";
    harnessReceipt.reason = referenceReceipt.reason;
  }
  await writeManifest(path.join(runRoot, "vault", "after.manifest.json"), vaultAfter);
  await writeManifest(path.join(runRoot, "vault", "byte-diff.json"), {
    schemaVersion: 1,
    before: vaultBefore.treeSha256,
    after: vaultAfter.treeSha256,
    equal: vaultBefore.treeSha256 === vaultAfter.treeSha256,
  });
  await writeManifest(path.join(runRoot, "profile", "after.tree.manifest.json"), profileAfterTree);
  await writeManifest(profileAfterPath, profileAfter);
  const roundtrip = referenceReceipt?.observed?.roundtrip;
  const vaultRoundtrip = singleFileRoundtrip(
    vaultBefore,
    vaultAfter,
    "00 Overview.md",
    roundtrip?.beforeSha256,
    roundtrip?.mutatedSha256,
  );
  const profileSafe = profileAfter.safe;
  const fileReceipt = receiptFor(
    "FILE-01",
    referenceReceipt?.status === "observed" && profileSafe && vaultRoundtrip.equal
      ? "observed"
      : "blocked",
    {
      reason:
        referenceReceipt?.status === "observed" && profileSafe && vaultRoundtrip.equal
          ? undefined
          : !vaultRoundtrip.equal
            ? "Synthetic vault did not show the exact single-note edit/save/exit/reopen delta."
            : (referenceReceipt?.reason ??
              (!profileSafe
                ? "Fresh profile produced a path outside the explicit profile allowlist."
                : "Reference launch did not satisfy containment/CDP preconditions.")),
      input: {
        fixtureId: FIXTURE_ID,
        predicate: FIXTURE_PREDICATE,
        action: "open fixture note, synthetic edit/save, exit, reopen; no host URI handler",
      },
      output: {
        vaultBefore: vaultBefore.treeSha256,
        vaultAfter: vaultAfter.treeSha256,
        vaultEqual: vaultBefore.treeSha256 === vaultAfter.treeSha256,
        vaultRoundtrip,
        profileSafe,
        profileUnexpected: profileAfter.unexpected,
        profileBeforeTree: profileBeforeTree.treeSha256,
        profileAfterTree: profileAfterTree.treeSha256,
        reference: referenceReceipt,
      },
      artifacts: relativeArtifacts(runRoot, [
        path.join(runRoot, "vault", "before.manifest.json"),
        path.join(runRoot, "vault", "after.manifest.json"),
        path.join(runRoot, "vault", "byte-diff.json"),
        profileBeforePath,
        profileAfterPath,
        path.join(runRoot, "profile", "before.tree.manifest.json"),
        path.join(runRoot, "profile", "after.tree.manifest.json"),
      ]),
      tolerance: {
        vault:
          "exact path/bytes/mode except the one synthetic note edit and bounded reference app-state files under .obsidian",
        profile: "captured allowlist exact; ephemeral metadata-only",
      },
      redControl: {
        id: "RC-FILE-01",
        expected: "mutating a seeded note byte fails the exact vault manifest gate",
      },
      threadleafSeam: ["src/kernel/vault-kernel.ts", "src/kernel/durability.ts"],
    },
  );
  receipts.push(fileReceipt);

  const uiStatus =
    referenceReceipt?.status === "observed" && referenceReceipt.observed?.screenshot
      ? "observed"
      : "blocked";
  const uiArtifacts = [path.join(runRoot, "launch.json")];
  if (referenceReceipt?.observed?.screenshot)
    uiArtifacts.push(path.join(runRoot, "ui", "UI-01.png"));
  const uiReceipt = receiptFor("UI-01", uiStatus, {
    reason:
      uiStatus === "observed"
        ? undefined
        : (referenceReceipt?.reason ??
          referenceReceipt?.observed?.cdpError ??
          "CDP surface was not reached."),
    input: {
      fixtureId: FIXTURE_ID,
      predicate: FIXTURE_PREDICATE,
      viewport,
      themes: ["system/default"],
      action: "fixture note after synthetic edit/save/exit/reopen",
    },
    output: referenceReceipt?.observed ?? {},
    artifacts: relativeArtifacts(runRoot, uiArtifacts),
    tolerance: {
      screenshot: "surface PNG, exact dimensions/hash retained privately",
      geometry: "descriptive until semantic selectors are available",
    },
    redControl: {
      id: "RC-UI-01",
      expected: "missing CDP target or a blank surface is blocked, never a pass",
    },
    threadleafSeam: ["visual/matrix.v1.json", "scripts/check-visual-regression.mjs"],
  });
  receipts.push(uiReceipt);

  for (const receipt of receipts) {
    await writeReceipt(runRoot, receipt);
  }
  base.cells = receipts;
  base.environment.memoryGates = memoryGates;
  base.sourceEvidence = source;
  const inventory = await artifactInventory(runRoot);
  base.artifacts = {
    fixtureManifest: "fixture-manifest.v1.json",
    runRootMode: "0700",
    retainedUnder: "temporary run root only",
    inventorySchemaVersion: 1,
    inventoryExcludes: ["manifest.v1.json"],
    inventory,
  };
  const manifestPath = await writeRunManifest(runRoot, base);
  const manifestBytes = await fs.readFile(manifestPath);
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  const inventorySha256 = createHash("sha256").update(JSON.stringify(inventory)).digest("hex");
  process.stdout.write(
    `${JSON.stringify(
      {
        runRoot,
        statuses: Object.fromEntries(receipts.map((receipt) => [receipt.cellId, receipt.status])),
        fixtureTreeSha256: generated.manifest.treeSha256,
        candidate: source.candidate,
        sourceTreeSha256: source.sourceTreeSha256,
        sourceFileHashes: source.files,
        artifactInventorySha256: inventorySha256,
        manifestSha256,
      },
      null,
      2,
    )}\n`,
  );
  // CLI-01 is unconditionally "blocked" (see blockedCliReceipt): a documented capability gap,
  // not a failure, because this lane has no separately authorized, isolated public CLI binary.
  // Every other cell must be "observed" or the run is not clean.
  const unobservedFailures = receipts.filter(
    (receipt) => receipt.status !== "observed" && receipt.cellId !== "CLI-01",
  );
  if (unobservedFailures.length > 0) process.exitCode = 1;
  if (!keepRun) {
    process.stdout.write(
      "cleanup requested, but the receipt root is retained for independent sealing verification\n",
    );
  }
}

// Guard the real Flatpak lab run behind an entry-point check so this module
// can be imported elsewhere (for example, to reuse flatpakArgs() in tests)
// without side-effecting a live launch.
const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  await run();
}
