import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const markerName = "THREADLEAF_PERF_RUN_MARKER";
const profilePrefix = "threadleaf-performance-seams-";
const termGraceMs = 750;
const quietPeriodMs = 500;

export { markerName };

export async function markedProcessIds(marker) {
  return (await markedProcesses(marker)).map((entry) => entry.pid);
}

async function markedProcesses(marker) {
  const entries = await fs.readdir("/proc");
  const matches = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    const pid = Number.parseInt(entry, 10);
    const identity = await markedProcessIdentity(pid, marker);
    if (identity) {
      matches.push(identity);
    }
  }
  return matches;
}

export async function cleanupPerformanceRun({ marker, profilePaths, timeoutMs = 5_000 }) {
  assert(
    typeof marker === "string" && /^[A-Za-z0-9_.-]{8,}$/.test(marker),
    `Invalid performance run marker: ${String(marker)}`,
  );
  assert(
    Number.isSafeInteger(timeoutMs) && timeoutMs >= 500,
    "Performance cleanup timeout is too short.",
  );
  const ownedProfilePaths = await Promise.all(profilePaths.map(assertOwnedProfilePath));
  const observedProcessIds = new Set();
  const terminationDeadline = Date.now() + timeoutMs;
  const forceAfter = terminationDeadline - termGraceMs;
  let remainingProcesses = await markedProcesses(marker);
  while (remainingProcesses.length > 0 && Date.now() < terminationDeadline) {
    for (const entry of remainingProcesses) {
      observedProcessIds.add(entry.pid);
      await signalMarkedProcess(entry, marker, Date.now() >= forceAfter ? "SIGKILL" : "SIGTERM");
    }
    await delay(50);
    remainingProcesses = await markedProcesses(marker);
  }
  if (remainingProcesses.length > 0) {
    for (const entry of remainingProcesses) {
      observedProcessIds.add(entry.pid);
      await signalMarkedProcess(entry, marker, "SIGKILL");
    }
    await delay(100);
    remainingProcesses = await markedProcesses(marker);
  }
  assert(
    remainingProcesses.length === 0,
    `Could not stop marked performance processes: ${remainingProcesses.map((entry) => entry.pid).join(", ")}`,
  );

  const lateSpawnDeadline = Date.now() + timeoutMs;
  let quietStartedAt = Date.now();
  while (Date.now() - quietStartedAt < quietPeriodMs && Date.now() < lateSpawnDeadline) {
    remainingProcesses = await markedProcesses(marker);
    if (remainingProcesses.length > 0) {
      quietStartedAt = Date.now();
      for (const entry of remainingProcesses) {
        observedProcessIds.add(entry.pid);
        await signalMarkedProcess(entry, marker, "SIGKILL");
      }
    }
    await delay(50);
  }
  remainingProcesses = await markedProcesses(marker);
  assert(
    remainingProcesses.length === 0 && Date.now() - quietStartedAt >= quietPeriodMs,
    `Performance cleanup did not reach a quiet process window: ${remainingProcesses.map((entry) => entry.pid).join(", ")}`,
  );
  for (const profilePath of ownedProfilePaths) {
    await assertOwnedProfilePath(profilePath);
    await fs.rm(profilePath, { recursive: true, force: true });
  }
  return {
    marker,
    observedProcessIds: [...observedProcessIds],
    remainingProcessIds: remainingProcesses.map((entry) => entry.pid),
    removedProfilePaths: ownedProfilePaths,
  };
}

export async function assertOwnedProfilePath(profilePath) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const absolutePath = path.resolve(profilePath);
  const relativePath = path.relative(temporaryRoot, absolutePath);
  assert(
    relativePath && relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`),
    `Performance cleanup path is outside the temporary directory: ${absolutePath}`,
  );
  assert(
    relativePath.split(path.sep)[0].startsWith(profilePrefix),
    `Performance cleanup path is not an owned profile: ${absolutePath}`,
  );
  let currentPath = temporaryRoot;
  for (const component of relativePath.split(path.sep)) {
    currentPath = path.join(currentPath, component);
    let stat;
    try {
      stat = await fs.lstat(currentPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        break;
      }
      throw error;
    }
    assert(
      !stat.isSymbolicLink(),
      `Performance cleanup path contains a symbolic link: ${currentPath}`,
    );
  }
  return absolutePath;
}

async function markedProcessIdentity(pid, marker) {
  const markerBytes = Buffer.from(`${markerName}=${marker}\0`);
  try {
    const [environment, stat] = await Promise.all([
      fs.readFile(`/proc/${pid}/environ`),
      fs.readFile(`/proc/${pid}/stat`, "utf8"),
    ]);
    if (!environment.includes(markerBytes)) {
      return null;
    }
    const afterCommand = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/u);
    const startTime = afterCommand[19];
    return startTime ? { pid, startTime } : null;
  } catch {
    return null;
  }
}

async function signalMarkedProcess(entry, marker, signal) {
  const current = await markedProcessIdentity(entry.pid, marker);
  if (!current || current.startTime !== entry.startTime) {
    return false;
  }
  try {
    process.kill(entry.pid, signal);
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
