import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(projectRoot, "package.json"));
const lockApi = require(path.join(projectRoot, "dist", "main", "private-state-lock.cjs"));
const nativeAddon = require(path.join(projectRoot, "dist", "native", "threadleaf-state-lock.node"));
const childPath = path.join(projectRoot, "scripts", "state-lock-child.mjs");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function waitForLine(child, expected) {
  return new Promise((resolve, reject) => {
    let output = "";
    const onData = (chunk) => {
      output += String(chunk);
      if (output.split(/\r?\n/u).includes(expected)) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`Child exited before ${expected}: ${code ?? signal}; ${output}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for child line ${expected}: ${output}`));
    }, 5_000);
    function cleanup() {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
    }
    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });
}

async function runChild(mode, lockPath) {
  const child = spawn(process.execPath, [childPath, mode, lockPath], {
    cwd: os.tmpdir(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Child ${mode} timed out: ${stdout}${stderr}`));
    }, 5_000);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  return { ...result, stdout, stderr };
}

async function main() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "threadleaf-state-lock-")));
  const lockPath = path.join(root, "state.lock");
  const legacyPath = path.join(root, "legacy.lock");
  const replacementPath = path.join(root, "replacement.lock");
  try {
    const platform = lockApi.nativeStateLockPlatform();
    const mechanism = lockApi.nativeStateLockMechanism();
    assert(platform === "posix" || platform === "windows", "Platform mapping is invalid.");
    assert(
      (platform === "posix" && mechanism === "flock") ||
        (platform === "windows" && mechanism === "LockFileEx"),
      `Unexpected platform mechanism mapping: ${platform} ${mechanism}`,
    );

    const holder = spawn(process.execPath, [childPath, "hold", lockPath], {
      cwd: os.tmpdir(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    await waitForLine(holder, "READY");
    await stat(lockPath);
    const [probeB, probeC, asyncProbe] = await Promise.all([
      runChild("probe", lockPath),
      runChild("probe", lockPath),
      runChild("async-probe", lockPath),
    ]);
    for (const [label, result] of [
      ["B", probeB],
      ["C", probeC],
      ["async", asyncProbe],
    ]) {
      assert(result.code === 0, `${label} contention child failed: ${result.stderr}`);
      assert(
        result.stdout.trim() === "BUSY",
        `${label} did not report typed busy: ${result.stdout}`,
      );
    }
    holder.kill("SIGKILL");
    await new Promise((resolve, reject) => {
      holder.once("exit", resolve);
      holder.once("error", reject);
    });
    const afterCrash = lockApi.acquireStateLock(lockPath);
    afterCrash.assertPathIdentity();
    afterCrash.close();
    await stat(lockPath);

    const permissionsPath = path.join(root, "permissions.lock");
    await writeFile(permissionsPath, "broad mode", { mode: 0o644 });
    const permissionsLock = lockApi.acquireStateLock(permissionsPath);
    permissionsLock.assertPathIdentity();
    permissionsLock.close();
    if (platform === "posix") {
      assert(
        ((await stat(permissionsPath)).mode & 0o777) === 0o600,
        "Pre-existing broad POSIX lock permissions were not repaired to 0600.",
      );
    }

    if (platform === "posix") {
      const realParent = path.join(root, "real-parent");
      const symlinkParent = path.join(root, "symlink-parent");
      await mkdir(realParent);
      await symlink(realParent, symlinkParent);
      let symlinkError;
      try {
        lockApi.acquireStateLock(path.join(symlinkParent, "ancestor.lock"));
      } catch (error) {
        symlinkError = error;
      }
      assert(
        symlinkError?.code === "compromised",
        "A symlink ancestor was not rejected as compromised.",
      );
    }

    const replacement = lockApi.acquireStateLock(lockPath);
    await rename(lockPath, replacementPath);
    await writeFile(lockPath, "replacement", { mode: 0o600 });
    let replacementError;
    try {
      replacement.assertPathIdentity();
    } catch (error) {
      replacementError = error;
    }
    assert(
      replacementError?.code === "compromised",
      "Path replacement did not abort as compromised.",
    );
    replacement.close();
    await rm(lockPath, { force: true });
    await rename(replacementPath, lockPath);
    await stat(lockPath);

    const operationErrorPath = path.join(root, "operation-error.lock");
    let operationError;
    try {
      await lockApi.withStateLock(operationErrorPath, async (lock) => {
        lock.assertPathIdentity();
        throw new Error("synthetic transaction failure");
      });
    } catch (error) {
      operationError = error;
    }
    assert(operationError?.message === "synthetic transaction failure", "Operation error changed.");
    const afterError = lockApi.acquireStateLock(operationErrorPath);
    afterError.close();
    await stat(operationErrorPath);

    await mkdirLegacy(legacyPath);
    let migrationError;
    try {
      lockApi.acquireStateLock(legacyPath);
    } catch (error) {
      migrationError = error;
    }
    assert(
      migrationError?.code === "migration-required",
      "Legacy directory lock was not rejected.",
    );
    assert(
      migrationError?.state === "quiescent",
      "Legacy directory lock did not enter quiescent state.",
    );
    assert((await stat(legacyPath)).isDirectory(), "Legacy directory lock was changed.");

    const asyncPath = path.join(root, "async.lock");
    const asyncHolder = lockApi.acquireStateLock(asyncPath);
    let asyncBusy;
    try {
      await lockApi.acquireStateLockAsync(asyncPath, { timeoutMs: 45, pollIntervalMs: 10 });
    } catch (error) {
      asyncBusy = error;
    }
    assert(asyncBusy?.code === "busy", "Async bounded contention did not report busy.");
    asyncHolder.close();
    const asyncAfterRelease = await lockApi.acquireStateLockAsync(asyncPath, {
      timeoutMs: 100,
      pollIntervalMs: 10,
    });
    asyncAfterRelease.close();
    await stat(asyncPath);

    let noClobberRename = "unsupported";
    let collisionPreserved = false;
    const moveSource = path.join(root, "move-source");
    const moveTarget = path.join(root, "move-target");
    const moveClaimant = path.join(root, "move-claimant");
    if (process.platform === "linux") {
      await writeFile(moveSource, "source", "utf8");
      nativeAddon.renameNoReplace(moveSource, moveTarget);
      await writeFile(moveClaimant, "claimant", "utf8");
      let collisionCode;
      try {
        nativeAddon.renameNoReplace(moveClaimant, moveTarget);
      } catch (error) {
        collisionCode = error?.code;
      }
      collisionPreserved =
        collisionCode === "exists" &&
        (await readFile(moveTarget, "utf8")) === "source" &&
        (await readFile(moveClaimant, "utf8")) === "claimant";
      assert(collisionPreserved, "Native no-clobber rename changed a claimant.");
      noClobberRename = "renameat2-noreplace";
    } else {
      let unsupportedCode;
      try {
        nativeAddon.renameNoReplace(moveSource, moveTarget);
      } catch (error) {
        unsupportedCode = error?.code;
      }
      assert(unsupportedCode === "unsupported", "Non-Linux no-clobber rename did not fail closed.");
      collisionPreserved = true;
    }

    assert(
      typeof nativeAddon.publishBufferNoReplace === "function",
      "Native addon lacks anonymous no-clobber publication.",
    );
    assert(
      typeof nativeAddon.probeAnonymousPublishNoName === "function",
      "Native addon lacks the no-name anonymous publication probe.",
    );
    let anonymousProbe = "unsupported";
    let anonymousProbeNoName = false;
    if (process.platform === "linux") {
      const entriesBeforeProbe = await readdir(root);
      const probeDirectory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        nativeAddon.probeAnonymousPublishNoName(probeDirectory.fd);
      } finally {
        await probeDirectory.close();
      }
      anonymousProbeNoName =
        JSON.stringify(await readdir(root)) === JSON.stringify(entriesBeforeProbe);
      assert(anonymousProbeNoName, "Anonymous publication probe created a vault pathname.");
      anonymousProbe = "otmpfile-no-name";
    } else {
      let unsupportedCode;
      try {
        nativeAddon.probeAnonymousPublishNoName(0);
      } catch (error) {
        unsupportedCode = error?.code;
      }
      assert(
        unsupportedCode === "unsupported",
        "Non-Linux anonymous publication probe did not fail closed.",
      );
      anonymousProbeNoName = true;
    }
    let anonymousPublish = "unsupported";
    let anonymousExactBytes = false;
    let anonymousCollisionPreserved = false;
    let anonymousNoStage = false;
    if (process.platform === "linux") {
      const publishBytes = Buffer.from([0, 1, 2, 255, 10]);
      const publishName = "anonymous-published.bin";
      const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        nativeAddon.publishBufferNoReplace(directory.fd, publishName, publishBytes);
        let collisionCode;
        try {
          nativeAddon.publishBufferNoReplace(directory.fd, publishName, Buffer.from("claimant"));
        } catch (error) {
          collisionCode = error?.code;
        }
        anonymousExactBytes = (await readFile(path.join(root, publishName))).equals(publishBytes);
        anonymousCollisionPreserved = collisionCode === "exists" && anonymousExactBytes;
        anonymousNoStage = (await readdir(root)).every(
          (entry) => !entry.startsWith(".threadleaf-attachment-stage-"),
        );
      } finally {
        await directory.close();
      }
      assert(anonymousExactBytes, "Anonymous publication changed the requested bytes.");
      assert(
        anonymousCollisionPreserved,
        "Anonymous publication did not preserve an existing target claimant.",
      );
      assert(anonymousNoStage, "Anonymous publication exposed a target-side stage name.");
      anonymousPublish = "otmpfile-linkat";
    } else {
      let unsupportedCode;
      try {
        nativeAddon.publishBufferNoReplace(0, "anonymous-published.bin", Buffer.alloc(0));
      } catch (error) {
        unsupportedCode = error?.code;
      }
      assert(
        unsupportedCode === "unsupported",
        "Non-Linux anonymous publication did not fail closed.",
      );
      anonymousExactBytes = true;
      anonymousCollisionPreserved = true;
      anonymousNoStage = true;
    }

    const entries = await readdir(root);
    assert(entries.includes("state.lock"), "Persistent lock path disappeared.");
    assert(entries.includes("legacy.lock"), "Legacy lock directory disappeared.");
    console.log(
      JSON.stringify({
        verified: true,
        platform,
        mechanism,
        separateChildren: ["busy-B", "busy-C", "busy-async", "kernel-close"],
        pathPersistent: true,
        replacement: "compromised",
        legacyDirectory: "migration-required/quiescent",
        noClobberRename,
        collisionPreserved,
        anonymousProbe,
        anonymousProbeNoName,
        anonymousPublish,
        anonymousExactBytes,
        anonymousCollisionPreserved,
        anonymousNoStage,
        localRuntimeOnly: platform === "posix",
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function mkdirLegacy(directoryPath) {
  await mkdir(directoryPath);
}

await main();
