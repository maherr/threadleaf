import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const nativePath = path.join(projectRoot, "dist", "native", "threadleaf-state-lock.node");
const targetPlatform = process.env.THREADLEAF_NATIVE_TARGET_PLATFORM ?? process.platform;
const targetArchitecture = process.env.THREADLEAF_NATIVE_TARGET_ARCH ?? process.arch;
const packageData = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

assert(
  process.platform === targetPlatform,
  `Electron native target verification requires ${targetPlatform}; host is ${process.platform}.`,
);
if (targetArchitecture !== "universal") {
  assert(
    process.arch === targetArchitecture,
    `Electron native target verification requires ${targetArchitecture}; host is ${process.arch}.`,
  );
}

const electron = createRequire(import.meta.url)("electron");
assert(typeof electron === "string", "The Electron target executable is unavailable.");
const electronVersion = packageData.devDependencies?.electron ?? packageData.dependencies?.electron;
assert(
  typeof electronVersion === "string",
  "The Electron target version is not pinned in package.json.",
);
// Canonicalize the temp root: on macOS os.tmpdir() returns the /var -> /private/var symlink, and
// the native lock's assertPathIdentity() correctly rejects a non-canonical lock path. The app's
// real lock directory is not symlinked, so this only affects the probe's temp path.
const probeRoot = await realpath(
  await mkdtemp(path.join(os.tmpdir(), "threadleaf-electron-native-target-")),
);
const probePath = path.join(probeRoot, "probe.cjs");
const lockPath = path.join(probeRoot, "state.lock");
await writeFile(
  probePath,
  `const fs = require("node:fs");\nconst path = require("node:path");\nconst addon = require(process.env.THREADLEAF_NATIVE_PROBE_PATH);\nif (addon.napiVersion() !== "10") throw new Error("native addon did not report pinned Node-API version 10");\nif (typeof addon.renameNoReplace !== "function") throw new Error("native addon lacks no-clobber rename");\nconst targetPlatform = process.env.THREADLEAF_NATIVE_TARGET_PLATFORM;\nconst expected = targetPlatform === "win32" ? ["windows", "LockFileEx"] : ["posix", "flock"];\nif (addon.platform() !== expected[0] || addon.mechanism() !== expected[1]) throw new Error("native addon mechanism does not match the Electron target");\nfs.writeFileSync(process.env.THREADLEAF_NATIVE_PROBE_LOCK, "electron target probe\\n", { mode: 0o600 });\nconst lock = addon.acquire(process.env.THREADLEAF_NATIVE_PROBE_LOCK);\nlock.assertPathIdentity();\nlock.close();\nconst root = path.dirname(process.env.THREADLEAF_NATIVE_PROBE_LOCK);\nconst source = path.join(root, "rename-source");\nconst target = path.join(root, "rename-target");\nconst claimant = path.join(root, "rename-claimant");\nlet noClobberRename = "unsupported";\nlet collisionPreserved = false;\nif (targetPlatform === "linux") {\n  fs.writeFileSync(source, "source");\n  addon.renameNoReplace(source, target);\n  fs.writeFileSync(claimant, "claimant");\n  let collisionCode = null;\n  try { addon.renameNoReplace(claimant, target); } catch (error) { collisionCode = error && error.code; }\n  collisionPreserved = collisionCode === "exists" && fs.readFileSync(target, "utf8") === "source" && fs.readFileSync(claimant, "utf8") === "claimant" && !fs.existsSync(source);\n  if (!collisionPreserved) throw new Error("native no-clobber rename collision changed a claimant");\n  noClobberRename = "renameat2-noreplace";\n} else {\n  let unsupportedCode = null;\n  try { addon.renameNoReplace(source, target); } catch (error) { unsupportedCode = error && error.code; }\n  if (unsupportedCode !== "unsupported") throw new Error("non-Linux no-clobber rename did not fail closed");\n  collisionPreserved = true;\n}\nprocess.stdout.write(JSON.stringify({ loaded: true, acquired: true, asserted: true, released: true, napiVersion: addon.napiVersion(), noClobberRename, collisionPreserved }) + "\\n");\n`,
  "utf8",
);
const probeSource = (await readFile(probePath, "utf8"))
  .replace(
    "const addon = require(process.env.THREADLEAF_NATIVE_PROBE_PATH);\n",
    'const addon = require(process.env.THREADLEAF_NATIVE_PROBE_PATH);\nconst hostNapiVersion = Number(process.versions.napi);\nif (!Number.isInteger(hostNapiVersion) || hostNapiVersion < 10) throw new Error("Electron host does not provide Node-API version 10");\n',
  )
  .replace(
    "napiVersion: addon.napiVersion(), noClobberRename",
    "napiVersion: addon.napiVersion(), hostNapiVersion, noClobberRename",
  )
  .replace(
    'if (typeof addon.renameNoReplace !== "function") throw new Error("native addon lacks no-clobber rename");',
    'if (typeof addon.renameNoReplace !== "function") throw new Error("native addon lacks no-clobber rename");\nif (typeof addon.probeAnonymousPublishNoName !== "function") throw new Error("native addon lacks no-name anonymous publication probe");\nif (typeof addon.publishBufferNoReplace !== "function") throw new Error("native addon lacks anonymous no-clobber publication");',
  )
  .replace(
    'process.stdout.write(JSON.stringify({ loaded: true, acquired: true, asserted: true, released: true, napiVersion: addon.napiVersion(), hostNapiVersion, noClobberRename, collisionPreserved }) + "\\n");',
    `let anonymousPublish = "unsupported";
let anonymousExactBytes = false;
let anonymousCollisionPreserved = false;
let anonymousNoStage = false;
let anonymousProbe = "unsupported";
let anonymousProbeNoName = false;
if (targetPlatform === "linux") {
  const entriesBeforeProbe = fs.readdirSync(root);
  const probeDirectoryFd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    addon.probeAnonymousPublishNoName(probeDirectoryFd);
  } finally {
    fs.closeSync(probeDirectoryFd);
  }
  anonymousProbeNoName = JSON.stringify(fs.readdirSync(root)) === JSON.stringify(entriesBeforeProbe);
  if (!anonymousProbeNoName) throw new Error("anonymous publication probe created a vault pathname");
  anonymousProbe = "otmpfile-no-name";
  const publishBytes = Buffer.from([0, 1, 2, 255, 10]);
  const publishName = "anonymous-published.bin";
  const publishPath = path.join(root, publishName);
  const directoryFd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    addon.publishBufferNoReplace(directoryFd, publishName, publishBytes);
    let collisionCode = null;
    try { addon.publishBufferNoReplace(directoryFd, publishName, Buffer.from("claimant")); } catch (error) { collisionCode = error && error.code; }
    anonymousExactBytes = fs.readFileSync(publishPath).equals(publishBytes);
    anonymousCollisionPreserved = collisionCode === "exists" && anonymousExactBytes;
    anonymousNoStage = fs.readdirSync(root).every((entry) => !entry.startsWith(".threadleaf-attachment-stage-"));
  } finally {
    fs.closeSync(directoryFd);
  }
  if (!anonymousExactBytes || !anonymousCollisionPreserved || !anonymousNoStage) throw new Error("anonymous no-clobber publication proof failed");
  anonymousPublish = "otmpfile-linkat";
} else {
  let unsupportedCode = null;
  try { addon.probeAnonymousPublishNoName(0); } catch (error) { unsupportedCode = error && error.code; }
  if (unsupportedCode !== "unsupported") throw new Error("non-Linux anonymous publication probe did not fail closed");
  unsupportedCode = null;
  try { addon.publishBufferNoReplace(0, "anonymous-published.bin", Buffer.alloc(0)); } catch (error) { unsupportedCode = error && error.code; }
  if (unsupportedCode !== "unsupported") throw new Error("non-Linux anonymous publication did not fail closed");
  anonymousExactBytes = true;
  anonymousCollisionPreserved = true;
  anonymousNoStage = true;
  anonymousProbeNoName = true;
}
process.stdout.write(JSON.stringify({ loaded: true, acquired: true, asserted: true, released: true, napiVersion: addon.napiVersion(), hostNapiVersion, noClobberRename, collisionPreserved, anonymousProbe, anonymousProbeNoName, anonymousPublish, anonymousExactBytes, anonymousCollisionPreserved, anonymousNoStage }) + "\\n");`,
  );
await writeFile(probePath, `${probeSource}process.exit(0);\n`, "utf8");

try {
  const result = await new Promise((resolve, reject) => {
    const runAsNode = targetPlatform !== "linux";
    const electronArguments = [
      ...(targetPlatform === "linux"
        ? ["--no-sandbox", "--disable-gpu", "--ozone-platform=x11", "--password-store=basic"]
        : []),
      probePath,
    ];
    const child = spawn(electron, electronArguments, {
      cwd: projectRoot,
      env: {
        ...process.env,
        // The probe is pure Node (loads the Node-API addon, exercises fs locking) and needs no
        // GUI. On non-Linux hosts run Electron's bundled Node directly, so a headless build host
        // (no window server, e.g. macOS over SSH) verifies the addon instead of hanging on a GUI
        // launch. Node-API is identical in both modes, so the verification is equivalent.
        ...(runAsNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        THREADLEAF_NATIVE_PROBE_PATH: nativePath,
        THREADLEAF_NATIVE_PROBE_LOCK: lockPath,
        THREADLEAF_NATIVE_TARGET_PLATFORM: targetPlatform,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      resolve({ code, signal, stdout: stdout.join(""), stderr: stderr.join("") }),
    );
  });
  assert(
    result.code === 0,
    `Electron ${electronVersion} native target probe failed: ${result.stderr || result.stdout}`,
  );
  const receipt = JSON.parse(result.stdout.trim());
  assert(
    receipt.loaded &&
      receipt.acquired &&
      receipt.asserted &&
      receipt.released &&
      receipt.hostNapiVersion >= 10 &&
      receipt.collisionPreserved &&
      receipt.anonymousProbeNoName &&
      receipt.anonymousExactBytes &&
      receipt.anonymousCollisionPreserved &&
      receipt.anonymousNoStage,
    "Electron target probe did not complete the lock lifecycle.",
  );
  console.log(
    JSON.stringify({
      verified: true,
      electronVersion,
      target: `${targetPlatform}/${targetArchitecture}`,
      napiVersion: receipt.napiVersion,
      hostNapiVersion: receipt.hostNapiVersion,
      lifecycle: "import-acquire-assert-release",
      noClobberRename: receipt.noClobberRename,
      anonymousProbe: receipt.anonymousProbe,
      anonymousPublish: receipt.anonymousPublish,
    }),
  );
} finally {
  await rm(probeRoot, { recursive: true, force: true });
}
