import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertOwnedProfilePath,
  cleanupPerformanceRun,
  markedProcessIds,
} from "./performance-seam-cleanup.mjs";

if (process.platform !== "linux") {
  process.stdout.write("Skipped Linux-only Electron performance cleanup fixture.\n");
  process.exit(0);
}

const token = randomUUID();
const marker = `threadleaf-performance-seams-${token}`;
const profilePath = path.join(os.tmpdir(), marker);
const symlinkRoot = path.join(os.tmpdir(), `threadleaf-performance-seams-symlink-${token}`);
const symlinkVictim = path.join(os.tmpdir(), `threadleaf-performance-victim-${token}`);
const markerEnvironment = {
  ...process.env,
  THREADLEAF_PERF_RUN_MARKER: marker,
};

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function inotifyCount() {
  let count = 0;
  for (const entry of await fs.readdir("/proc")) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    try {
      const descriptors = await fs.readdir(`/proc/${entry}/fd`);
      for (const descriptor of descriptors) {
        try {
          if ((await fs.readlink(`/proc/${entry}/fd/${descriptor}`)) === "anon_inode:inotify") {
            count += 1;
          }
        } catch {
          // The descriptor can close while it is being inspected.
        }
      }
    } catch {
      // The process can exit while /proc is being inspected.
    }
  }
  return count;
}

async function markedInotifyCount(marker) {
  let count = 0;
  for (const pid of await markedProcessIds(marker)) {
    try {
      const descriptors = await fs.readdir(`/proc/${pid}/fd`);
      for (const descriptor of descriptors) {
        try {
          if ((await fs.readlink(`/proc/${pid}/fd/${descriptor}`)) === "anon_inode:inotify") {
            count += 1;
          }
        } catch {
          // The descriptor can close while it is being inspected.
        }
      }
    } catch {
      // The marked process can exit while /proc is being inspected.
    }
  }
  return count;
}

async function waitFor(description, read, predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (predicate(value)) {
      return value;
    }
    await delay(40);
  }
  throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(value)}`);
}

async function main() {
  const victimPayload = path.join(symlinkVictim, "payload");
  const victimFile = path.join(victimPayload, "keep.txt");
  const symlinkPath = path.join(symlinkRoot, "outside");
  await fs.mkdir(victimPayload, { recursive: true });
  await fs.writeFile(victimFile, "owned by the symlink red control");
  await fs.mkdir(symlinkRoot, { recursive: true });
  await fs.symlink(symlinkVictim, symlinkPath, "dir");
  let symlinkError;
  try {
    await cleanupPerformanceRun({
      marker: `${marker}-symlink`,
      profilePaths: [path.join(symlinkPath, "payload")],
    });
  } catch (error) {
    symlinkError = error;
  }
  assert(
    symlinkError instanceof Error && symlinkError.message.includes("symbolic link"),
    `Symlinked cleanup path was not rejected: ${String(symlinkError)}`,
  );
  assert(
    (await fs.readFile(victimFile, "utf8")) === "owned by the symlink red control",
    "Symlinked cleanup path removed or changed the outside victim.",
  );

  await assertOwnedProfilePath(profilePath);
  await fs.mkdir(profilePath, { recursive: true });
  const baselineInotify = await inotifyCount();
  const watcherCode = `const fs = require("node:fs"); fs.watch(${JSON.stringify(profilePath)}, () => {}); setInterval(() => {}, 1000);`;
  const childCode = `const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", ${JSON.stringify(watcherCode)}], { detached: true, stdio: "ignore" }); child.unref();`;
  const launcher = spawn(process.execPath, ["-e", childCode], {
    env: markerEnvironment,
    stdio: "ignore",
  });
  const lateChildCode = `const { spawn } = require("node:child_process"); setTimeout(() => { const child = spawn(process.execPath, ["-e", ${JSON.stringify(watcherCode)}], { detached: true, stdio: "ignore", env: { ...process.env, THREADLEAF_PERF_RUN_MARKER: ${JSON.stringify(marker)} } }); child.unref(); }, 180);`;
  const lateLauncher = spawn(process.execPath, ["-e", lateChildCode], {
    detached: true,
    stdio: "ignore",
  });
  lateLauncher.unref();
  await new Promise((resolve, reject) => {
    launcher.once("error", reject);
    launcher.once("exit", resolve);
  });
  const markedBeforeCleanup = await waitFor(
    "the reparented marked watcher",
    () => markedProcessIds(marker),
    (pids) => pids.length > 0,
  );
  const inotifyBeforeCleanup = await waitFor(
    "the marked inotify watcher",
    inotifyCount,
    (count) => count > baselineInotify,
  );
  const markedInotifyBeforeCleanup = await waitFor(
    "the marked inotify descriptor",
    () => markedInotifyCount(marker),
    (count) => count > 0,
  );
  const cleanup = await cleanupPerformanceRun({ marker, profilePaths: [profilePath] });
  const remaining = await markedProcessIds(marker);
  const markedInotifyAfter = await markedInotifyCount(marker);
  const afterInotify = await inotifyCount();
  const profileExists = await fs
    .stat(profilePath)
    .then(() => true)
    .catch(() => false);
  const report = {
    baselineInotify,
    inotifyBeforeCleanup,
    markedInotifyBeforeCleanup,
    markedInotifyAfter,
    afterInotify,
    markedBeforeCleanup,
    cleanup,
    remaining,
    profileExists,
    symlinkTraversalRejected: true,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  assert(remaining.length === 0, `Marked processes leaked: ${remaining.join(", ")}`);
  assert(markedInotifyAfter === 0, `Marked inotify instances leaked: ${markedInotifyAfter}`);
  assert(!profileExists, `Owned profile leaked: ${profilePath}`);
  assert(
    cleanup.observedProcessIds.length >= 2,
    `Late marked process was not observed: ${JSON.stringify(cleanup.observedProcessIds)}`,
  );
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await fs.rm(profilePath, { recursive: true, force: true });
  await fs.rm(symlinkRoot, { recursive: true, force: true });
  await fs.rm(symlinkVictim, { recursive: true, force: true });
}
