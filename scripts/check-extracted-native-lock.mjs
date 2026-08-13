import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const [nativePath, expectedPlatform = process.platform, expectedArchitecture = process.arch] =
  process.argv.slice(2);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

assert(
  nativePath && path.isAbsolute(nativePath),
  "An absolute extracted native addon path is required.",
);
assert(lstatSync(nativePath).isFile(), "The extracted native addon must be a regular file.");
assert(
  process.platform === expectedPlatform,
  `Native package verification requires ${expectedPlatform}; host is ${process.platform}.`,
);

const bytes = await readFile(nativePath);
if (expectedPlatform === "linux") {
  assert(
    bytes.length >= 20 &&
      bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
      bytes[4] === 2 &&
      bytes.readUInt16LE(18) === 62,
    "The extracted Linux native state-lock addon is not ELF x64.",
  );
} else if (expectedPlatform === "win32") {
  const peOffset = bytes.length >= 0x40 ? bytes.readUInt32LE(0x3c) : -1;
  assert(
    peOffset >= 0 &&
      bytes.length >= peOffset + 6 &&
      bytes.subarray(peOffset, peOffset + 4).equals(Buffer.from("PE\0\0", "ascii")) &&
      bytes.readUInt16LE(peOffset + 4) === 0x8664,
    "The extracted Windows native state-lock addon is not PE x64.",
  );
} else if (expectedPlatform === "darwin") {
  const lipo = spawnSync("lipo", ["-archs", nativePath], { encoding: "utf8" });
  assert(lipo.status === 0, `lipo could not inspect the extracted native addon: ${lipo.stderr}`);
  const actual = new Set(lipo.stdout.trim().split(/\s+/u).filter(Boolean));
  const expected = new Set(
    expectedArchitecture === "universal"
      ? ["arm64", "x86_64"]
      : [expectedArchitecture === "x64" ? "x86_64" : expectedArchitecture],
  );
  assert(
    actual.size === expected.size &&
      [...expected].every((architecture) => actual.has(architecture)),
    `The extracted macOS native state-lock addon has ${[...actual].join(", ")}; expected ${[
      ...expected,
    ].join(", ")}.`,
  );
} else {
  throw new Error(`Unsupported extracted native package platform: ${expectedPlatform}.`);
}

const addon = createRequire(import.meta.url)(nativePath);
assert(
  addon.napiVersion() === "10",
  "Extracted native addon did not report pinned N-API version 10.",
);
assert(
  typeof addon.renameNoReplace === "function",
  "Extracted native addon lacks atomic no-clobber rename.",
);
const addonPlatform = addon.platform();
const addonMechanism = addon.mechanism();
assert(
  (expectedPlatform === "win32" &&
    addonPlatform === "windows" &&
    addonMechanism === "LockFileEx") ||
    (expectedPlatform !== "win32" && addonPlatform === "posix" && addonMechanism === "flock"),
  `Extracted native addon reported the wrong platform mechanism: ${addonPlatform}/${addonMechanism}.`,
);

const childSource = String.raw`
const addon = require(process.argv[1]);
const mode = process.argv[2];
const lockPath = process.argv[3];
if (addon.napiVersion() !== "10") throw new Error("child addon ABI pin mismatch");
if (mode === "holder") {
  const lock = addon.acquire(lockPath);
  lock.assertPathIdentity();
  process.stdout.write("READY\n");
  process.stdin.resume();
  process.stdin.on("data", () => { lock.close(); process.exit(0); });
} else {
  try {
    const lock = addon.acquire(lockPath);
    lock.assertPathIdentity();
    lock.close();
    if (mode === "busy") throw new Error("expected busy but acquired");
    process.stdout.write("ACQUIRED\n");
  } catch (error) {
    if (mode === "busy" && error && error.code === "busy") {
      process.stdout.write("BUSY\n");
      process.exit(0);
    }
    throw error;
  }
}
`;

function spawnProbe(mode, lockPath) {
  return spawn(process.execPath, ["-e", childSource, nativePath, mode, lockPath], {
    cwd: os.tmpdir(),
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function waitForOutput(child, expected, label) {
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out.`)), 10_000);
    child.stdout.on("data", () => {
      if (stdout.join("").includes(expected)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (!stdout.join("").includes(expected)) {
        clearTimeout(timer);
        reject(new Error(`${label} exited ${code ?? signal}: ${stderr.join("")}`));
      }
    });
  });
  return { stdout: stdout.join(""), stderr: stderr.join("") };
}

async function waitForExit(child, label) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not exit.`)), 10_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const root = mkdtempSync(path.join(os.tmpdir(), "threadleaf-extracted-state-lock-"));
try {
  const parent = path.join(root, "private");
  mkdirSync(parent);
  const lockPath = path.join(parent, "state.lock");
  writeFileSync(lockPath, "legacy\n", { mode: 0o644 });
  const initialIdentity = statSync(lockPath);

  const holder = spawnProbe("holder", lockPath);
  await waitForOutput(holder, "READY\n", "CLI-LOCK-01 holder");
  const busy = spawnProbe("busy", lockPath);
  await waitForOutput(busy, "BUSY\n", "CLI-LOCK-01 contention");
  await waitForExit(busy, "CLI-LOCK-01 contention probe");
  holder.kill("SIGKILL");
  await waitForExit(holder, "CLI-LOCK-01 killed holder");

  const successor = spawnProbe("acquired", lockPath);
  await waitForOutput(successor, "ACQUIRED\n", "CLI-LOCK-01 successor");
  await waitForExit(successor, "CLI-LOCK-01 successor");
  const finalIdentity = statSync(lockPath);
  assert(
    initialIdentity.dev === finalIdentity.dev && initialIdentity.ino === finalIdentity.ino,
    "CLI-LOCK-01 path identity changed or the former holder deleted the successor pathname.",
  );
  if (expectedPlatform !== "win32") {
    assert(
      (finalIdentity.mode & 0o777) === 0o600,
      "Extracted native lock did not enforce mode 0600.",
    );
  } else {
    const acl = spawnSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$acl = Get-Acl -LiteralPath $env:THREADLEAF_STATE_LOCK_PROBE; $acl.AccessToString",
      ],
      { encoding: "utf8", env: { ...process.env, THREADLEAF_STATE_LOCK_PROBE: lockPath } },
    );
    assert(acl.status === 0, `Could not inspect the Windows state-lock DACL: ${acl.stderr}`);
    assert(
      !/(Everyone|BUILTIN\\Users|Authenticated Users|INTERACTIVE)/iu.test(acl.stdout),
      "Windows state-lock DACL grants access to a broad principal.",
    );
  }
  let noClobberRename = "unsupported";
  let collisionPreserved = false;
  const moveSource = path.join(parent, "move-source");
  const moveTarget = path.join(parent, "move-target");
  const moveClaimant = path.join(parent, "move-claimant");
  if (expectedPlatform === "linux") {
    writeFileSync(moveSource, "source");
    addon.renameNoReplace(moveSource, moveTarget);
    writeFileSync(moveClaimant, "claimant");
    let collisionCode = null;
    try {
      addon.renameNoReplace(moveClaimant, moveTarget);
    } catch (error) {
      collisionCode = error?.code;
    }
    collisionPreserved =
      collisionCode === "exists" &&
      !existsSync(moveSource) &&
      readFileSync(moveTarget, "utf8") === "source" &&
      readFileSync(moveClaimant, "utf8") === "claimant";
    assert(collisionPreserved, "Extracted no-clobber rename changed a target claimant.");
    noClobberRename = "renameat2-noreplace";
  } else {
    let unsupportedCode = null;
    try {
      addon.renameNoReplace(moveSource, moveTarget);
    } catch (error) {
      unsupportedCode = error?.code;
    }
    assert(
      unsupportedCode === "unsupported",
      "Non-Linux extracted no-clobber rename did not fail closed.",
    );
    collisionPreserved = true;
  }
  console.log(
    JSON.stringify({
      verified: true,
      nativePath,
      platform: addonPlatform,
      mechanism: addonMechanism,
      architecture: expectedArchitecture,
      napiVersion: addon.napiVersion(),
      imported: true,
      acquired: true,
      asserted: true,
      released: true,
      cliLock01: "independent-process contention, killed-holder release, persistent pathname",
      noClobberRename,
      collisionPreserved,
      permissions: expectedPlatform === "win32" ? "owner-only DACL" : "0600",
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
