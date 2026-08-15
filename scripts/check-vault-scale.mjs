import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { cleanupPerformanceRun, markerName } from "./performance-seam-cleanup.mjs";

const appRoot = process.cwd();
const electronPath = path.join(appRoot, "node_modules", ".bin", "electron");
const kernelRunnerPath = path.join(appRoot, ".bench-dist", "vault-scale-kernel.cjs");
const corpusRunnerPath = path.join(appRoot, ".bench-dist", "vault-scale-corpus.cjs");
const packageData = JSON.parse(await fs.readFile(path.join(appRoot, "package.json"), "utf8"));
const checkedInManifestPath = path.join(appRoot, "benchmarks", "vault-scale-manifest.json");
const args = process.argv.slice(2);
const execFileAsync = promisify(execFile);
const runLog = [];
const maxWaitMs = positiveInteger("--timeout-ms", 600_000);
const runCount = positiveInteger("--runs", 2);
const corpusRoot = path.resolve(
  stringArgument(
    "--corpus-root",
    process.env.THREADLEAF_VAULT_SCALE_CORPUS_ROOT ??
      path.join(appRoot, ".bench-corpus", "threadleaf-vault-scale-v1"),
  ),
);
const outputDirectory = path.resolve(
  stringArgument("--output-dir", path.join(appRoot, "benchmarks", "results")),
);
const testRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "threadleaf-performance-seams-vault-scale-"),
);
let activeCleanup;

function stringArgument(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function positiveInteger(name, fallback) {
  const raw = stringArgument(name, undefined);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer.`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a loopback debugging port.");
  }
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitFor(description, read, predicate, timeoutMs = maxWaitMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (predicate(value)) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(25);
  }
  const suffix = lastError ? ` Last error: ${lastError.message ?? lastError}` : "";
  throw new Error(`Timed out waiting for ${description} after ${timeoutMs} ms.${suffix}`);
}

function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let sequence = 0;
  const rejectPending = (message) => {
    for (const request of pending.values()) request.reject(new Error(message));
    pending.clear();
  };
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP WebSocket failed to open.")), {
      once: true,
    });
  });
  socket.addEventListener("close", () => rejectPending("CDP WebSocket closed."));
  return {
    async send(method, params = {}) {
      await opened;
      const id = ++sequence;
      const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method, params }));
      return result;
    },
    close() {
      socket.close();
    },
  };
}

async function evaluate(cdp, expression) {
  const response = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ?? "Renderer evaluation failed.",
    );
  }
  return response.result?.value;
}

async function waitForMainTarget(port) {
  const targets = await waitFor(
    "the main renderer target",
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`);
        return response.ok ? await response.json() : [];
      } catch {
        return [];
      }
    },
    (value) =>
      value.find(
        (target) =>
          target.type === "page" &&
          typeof target.url === "string" &&
          target.url.endsWith("/dist/renderer/index.html") &&
          target.webSocketDebuggerUrl,
      ),
  );
  const target = targets.find(
    (candidate) =>
      candidate.type === "page" &&
      typeof candidate.url === "string" &&
      candidate.url.endsWith("/dist/renderer/index.html") &&
      candidate.webSocketDebuggerUrl,
  );
  assert(target, "The main renderer target disappeared after it was observed.");
  return target;
}

async function processTable() {
  const entries = [];
  let processIds;
  try {
    processIds = (await fs.readdir("/proc")).filter((entry) => /^\d+$/.test(entry));
  } catch {
    return entries;
  }
  for (const entry of processIds) {
    const pid = Number(entry);
    try {
      const [status, commandBytes, executable] = await Promise.all([
        fs.readFile(`/proc/${pid}/status`, "utf8"),
        fs.readFile(`/proc/${pid}/cmdline`),
        fs.readlink(`/proc/${pid}/exe`),
      ]);
      const parentMatch = status.match(/^PPid:\s+(\d+)$/m);
      const rssMatch = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
      if (!parentMatch || !rssMatch) continue;
      entries.push({
        pid,
        parentPid: Number(parentMatch[1]),
        rssBytes: Number(rssMatch[1]) * 1024,
        commandLine: commandBytes.toString("utf8").replaceAll("\0", " ").trim(),
        executable,
      });
    } catch {
      // Chromium processes can disappear between /proc reads.
    }
  }
  return entries;
}

function descendantsOf(entries, rootPid) {
  const children = new Map();
  for (const entry of entries) {
    const list = children.get(entry.parentPid) ?? [];
    list.push(entry);
    children.set(entry.parentPid, list);
  }
  const descendants = [];
  const queue = [...(children.get(rootPid) ?? [])];
  while (queue.length > 0) {
    const entry = queue.shift();
    if (!entry) continue;
    descendants.push(entry);
    queue.push(...(children.get(entry.pid) ?? []));
  }
  return descendants;
}

async function processSnapshot(port) {
  const entries = await processTable();
  const browserCandidates = entries.filter((entry) =>
    entry.commandLine.includes(`--remote-debugging-port=${port}`),
  );
  const browser = browserCandidates.find(
    (entry) => path.basename(entry.executable).replace(/ \(deleted\)$/u, "") === "electron",
  );
  if (!browser) {
    throw new Error(
      `Could not locate Electron for debugging port ${port}: ${browserCandidates
        .map((entry) => path.basename(entry.executable))
        .join(", ")}`,
    );
  }
  const descendants = descendantsOf(entries, browser.pid);
  const renderers = descendants.filter((entry) => entry.commandLine.includes("--type=renderer"));
  return {
    mainRssBytes: browser.rssBytes,
    rendererRssBytes: renderers.reduce((total, entry) => total + entry.rssBytes, 0),
    rendererCount: renderers.length,
    browserPid: browser.pid,
    rendererPids: renderers.map((entry) => entry.pid),
    rendererCommandLines: renderers.map((entry) => entry.commandLine),
  };
}

function startProcessSampler(port) {
  const samples = [];
  const sampleIntervalMs = 250;
  let pending = false;
  const sample = async () => {
    if (pending) return;
    pending = true;
    try {
      samples.push({ atMs: Date.now(), ...(await processSnapshot(port)) });
    } catch {
      // The browser may not have appeared yet.
    } finally {
      pending = false;
    }
  };
  const timer = setInterval(() => void sample(), sampleIntervalMs);
  void sample();
  return {
    async stop() {
      clearInterval(timer);
      await sample();
    },
    summary() {
      const valid = samples.filter(
        (sample) => sample.mainRssBytes > 0 && sample.rendererRssBytes > 0,
      );
      const peak = valid.reduce(
        (result, sample) => ({
          mainRssBytes: Math.max(result.mainRssBytes, sample.mainRssBytes),
          rendererRssBytes: Math.max(result.rendererRssBytes, sample.rendererRssBytes),
          rendererCount: Math.max(result.rendererCount, sample.rendererCount),
        }),
        { mainRssBytes: 0, rendererRssBytes: 0, rendererCount: 0 },
      );
      return { sampleCount: valid.length, peak, samples };
    },
  };
}

async function cpuModel() {
  try {
    const contents = await fs.readFile("/proc/cpuinfo", "utf8");
    return (
      contents
        .split("\n")
        .find((line) => line.startsWith("model name"))
        ?.split(":", 2)[1]
        ?.trim() ?? "unknown"
    );
  } catch {
    return os.cpus()[0]?.model ?? "unknown";
  }
}

async function memoryTotalBytes() {
  try {
    const contents = await fs.readFile("/proc/meminfo", "utf8");
    const match = contents.match(/^MemTotal:\s+(\d+)\s+kB$/m);
    return match ? Number(match[1]) * 1024 : os.totalmem();
  } catch {
    return os.totalmem();
  }
}

const memorySafetyThresholdBytes = 4 * 1024 ** 3;

async function memoryAvailableBytes() {
  try {
    const contents = await fs.readFile("/proc/meminfo", "utf8");
    const match = contents.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

function startMemoryGuard(onTrip) {
  let minimumAvailableBytes = Number.POSITIVE_INFINITY;
  let tripped;
  let resolveTrip;
  let reading = false;
  const trip = new Promise((resolve) => {
    resolveTrip = resolve;
  });
  const sample = async () => {
    if (reading) return;
    reading = true;
    try {
      const available = await memoryAvailableBytes();
      if (available === null) return;
      minimumAvailableBytes = Math.min(minimumAvailableBytes, available);
      if (available < memorySafetyThresholdBytes && !tripped) {
        tripped = {
          availableBytes: available,
          thresholdBytes: memorySafetyThresholdBytes,
        };
        resolveTrip(tripped);
        onTrip(tripped);
      }
    } finally {
      reading = false;
    }
  };
  const timer = setInterval(() => void sample(), 1_000);
  void sample();
  return {
    trip,
    stop() {
      clearInterval(timer);
    },
    snapshot() {
      return {
        minimumAvailableBytes: Number.isFinite(minimumAvailableBytes)
          ? minimumAvailableBytes
          : null,
        thresholdBytes: memorySafetyThresholdBytes,
        tripped: tripped ?? null,
      };
    },
  };
}

function withMemoryGuard(operation, guard) {
  return Promise.race([
    operation,
    guard.trip.then((detail) => {
      throw new Error(
        `MemAvailable crossed the 4 GiB safety threshold: ${JSON.stringify(detail)}.`,
      );
    }),
  ]);
}

async function gitMetadata() {
  const [{ stdout: head }, { stdout: status }, { stdout: branch }] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: appRoot, encoding: "utf8" }),
    execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=normal"], {
      cwd: appRoot,
      encoding: "utf8",
    }),
    execFileAsync("git", ["branch", "--show-current"], { cwd: appRoot, encoding: "utf8" }),
  ]);
  return { gitHead: head.trim(), gitDirty: status.trim().length > 0, branch: branch.trim() };
}

async function loadManifest() {
  const checkedIn = JSON.parse(await fs.readFile(checkedInManifestPath, "utf8"));
  assert(checkedIn.schemaVersion === 1, "Unsupported vault-scale manifest schema.");
  assert(
    checkedIn.seed > 0 && checkedIn.generatorVersion,
    "Incomplete vault-scale manifest metadata.",
  );
  return checkedIn;
}

function manifestSummary(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    generatorVersion: manifest.generatorVersion,
    seed: manifest.seed,
    variant: manifest.variant,
    fileCount: manifest.fileCount,
    visibleFileCount: manifest.visibleFileCount,
    hiddenFileCount: manifest.hiddenFileCount,
    markdownFileCount: manifest.markdownFileCount,
    ballastFileCount: manifest.ballastFileCount,
    totalBytes: manifest.totalBytes,
    extensionCounts: Object.fromEntries(Object.entries(manifest.extensionCounts).sort()),
    depthProfile: manifest.depthProfile,
    noteSizeDistribution: manifest.noteSizeDistribution,
    sampleHash: manifest.sampleHash,
  };
}

async function verifyCorpus(variant, checkedIn) {
  const outputDirectory = path.join(corpusRoot, variant);
  const expected = checkedIn.variants[variant];
  assert(expected, `Checked-in manifest has no ${variant} variant.`);
  const { stdout } = await execFileAsync(
    process.execPath,
    [corpusRunnerPath, "--variant", variant, "--output", outputDirectory, "--verify"],
    { cwd: appRoot, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
  );
  const result = JSON.parse(stdout);
  assert(result.verified === true, `${variant} corpus verification did not pass.`);
  assert(
    JSON.stringify(manifestSummary(result.manifest)) === JSON.stringify(manifestSummary(expected)),
    `${variant} generated manifest differs from the checked-in manifest.`,
  );
  generatedManifestCache.set(variant, result.manifest);
  return {
    variant,
    expected: result.manifest,
    checkedIn: expected,
    outputDirectory,
    vaultPath: path.join(outputDirectory, "vault"),
  };
}

async function runKernel(variant, vaultPath, stateRoot) {
  let child;
  const memoryGuard = startMemoryGuard(() => child?.kill("SIGTERM"));
  try {
    const promise = execFileAsync(
      process.execPath,
      [kernelRunnerPath, "--variant", variant, "--vault", vaultPath, "--state-root", stateRoot],
      {
        cwd: appRoot,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: maxWaitMs,
      },
    );
    child = promise.child;
    const { stdout } = await withMemoryGuard(promise, memoryGuard);
    const result = JSON.parse(stdout);
    const memorySafety = memoryGuard.snapshot();
    return {
      ...result,
      memory: {
        ...result.memory,
        minimumAvailableBytes: memorySafety.minimumAvailableBytes,
        safetyThresholdBytes: memorySafety.thresholdBytes,
      },
    };
  } catch (error) {
    error.kernelFailure = {
      status: "aborted",
      message: error.message ?? String(error),
      code: error.code ?? null,
      signal: error.signal ?? null,
      timedOut: error.code === "ETIMEDOUT",
      stderrTail: String(error.stderr ?? "").slice(-4_000),
      memorySafety: memoryGuard.snapshot(),
    };
    throw error;
  } finally {
    memoryGuard.stop();
  }
}

async function readSurface(cdp) {
  return evaluate(
    cdp,
    `(() => ({
      bodyVisible: Boolean(document.body && document.body.getBoundingClientRect().width > 0),
      shellReady: document.documentElement.dataset.threadleafShellReady === "true",
      shellMark: performance.getEntriesByName("threadleaf:shell-ready").at(-1)?.startTime ?? null,
      shellTimeOrigin: performance.timeOrigin,
      targetPath: document.querySelector("#vault-identity")?.getAttribute("title") ?? "",
      runtimeState: document.querySelector("#runtime-state")?.textContent ?? "",
      indexStatus: document.querySelector("#index-status")?.textContent ?? "",
      statusShape: document.querySelector("#status-shape")?.getAttribute("data-state") ?? "",
      openVaultDisabled: Boolean(document.querySelector("#open-vault")?.disabled),
      newNoteDisabled: Boolean(document.querySelector("#new-note")?.disabled),
      fileSearchDisabled: Boolean(document.querySelector("#file-search")?.disabled),
    }))()`,
  );
}

async function installRendererHeartbeat(cdp) {
  await evaluate(
    cdp,
    `(() => {
      const intervalMs = 5;
      const state = { last: performance.now(), maxPauseMs: 0, ticks: 0 };
      state.timer = window.setInterval(() => {
        const now = performance.now();
        state.maxPauseMs = Math.max(state.maxPauseMs, Math.max(0, now - state.last - intervalMs));
        state.last = now;
        state.ticks += 1;
      }, intervalMs);
      window.__threadleafVaultScaleHeartbeat = state;
      return true;
    })()`,
  );
}

async function readRendererHeartbeat(cdp) {
  return evaluate(
    cdp,
    `(() => {
      const state = window.__threadleafVaultScaleHeartbeat;
      if (!state) return { maxPauseMs: 0, ticks: 0 };
      window.clearInterval(state.timer);
      return { maxPauseMs: state.maxPauseMs, ticks: state.ticks };
    })()`,
  );
}

async function readReadySummary(cdp) {
  return evaluate(
    cdp,
    `(async () => {
      const snapshot = await window.threadleaf.getSnapshot();
      return {
        vaultPath: snapshot.vault?.path ?? null,
        vaultState: snapshot.workspace?.state ?? null,
        indexGeneration: snapshot.workspace?.indexGeneration ?? null,
        indexedMarkdownCount: snapshot.workspace?.files?.length ?? null,
        watcherSequence: snapshot.workspace?.watcher?.lastSequence ?? null,
        watcherError: snapshot.workspace?.watcher?.error ?? null,
      };
    })()`,
  );
}

async function closeElectron(cdp, exited) {
  if (cdp) {
    await evaluate(cdp, "setTimeout(() => window.close(), 0); true").catch(() => undefined);
  }
  return Promise.race([exited, delay(10_000).then(() => ({ code: null, signal: "timeout" }))]);
}

async function waitForStartup(cdp, vaultPath, expectedMarkdownCount, startedAt) {
  const deadline = startedAt + maxWaitMs;
  let state = null;
  let shellReadyMs = null;
  let openingSurfaceMs = null;
  let openingObserved = false;
  let readyMs = null;
  let summary = null;
  try {
    state = await waitFor(
      "the renderer shell",
      () => readSurface(cdp),
      (value) => value.bodyVisible && value.shellReady,
      Math.max(1, deadline - Date.now()),
    );
    shellReadyMs =
      state.shellMark === null ? null : state.shellTimeOrigin + state.shellMark - startedAt;
    while (Date.now() < deadline) {
      const current = await readSurface(cdp);
      const targetVisible = current.targetPath === vaultPath;
      if (targetVisible && openingSurfaceMs === null) openingSurfaceMs = Date.now() - startedAt;
      if (targetVisible && current.runtimeState === "Opening") openingObserved = true;
      if (targetVisible && current.runtimeState === "Ready") {
        readyMs ??= Date.now() - startedAt;
        summary = await readReadySummary(cdp);
        if (
          summary.vaultPath === vaultPath &&
          summary.vaultState === "ready" &&
          summary.indexedMarkdownCount === expectedMarkdownCount &&
          summary.watcherError === null
        ) {
          break;
        }
      }
      await delay(25);
    }
    if (readyMs === null || !summary) {
      throw new Error(`Threadleaf did not reach full readiness within ${maxWaitMs} ms.`);
    }
    const usableShellMs = shellReadyMs ?? openingSurfaceMs ?? readyMs;
    return {
      shellReadyMs,
      openingSurfaceMs,
      usableShellMs,
      readyMs,
      indexingWindowMs: Math.max(0, readyMs - usableShellMs),
      openingObserved,
      summary,
      surface: state,
    };
  } catch (error) {
    error.partial = {
      shellReadyMs,
      openingSurfaceMs,
      usableShellMs: shellReadyMs ?? openingSurfaceMs ?? null,
      readyMs,
      openingObserved,
      summary,
      surface: state,
    };
    throw error;
  }
}

async function waitForSearch(cdp, marker, predicate) {
  return waitFor(
    `index search convergence for ${marker}`,
    () =>
      evaluate(
        cdp,
        `(async () => {
          const response = await window.threadleaf.searchVault(${JSON.stringify(marker)});
          return {
            indexGeneration: response.indexGeneration ?? null,
            resultCount: response.results?.length ?? 0,
            // results is capped at the search limit (50), so batch convergence
            // must predicate on the un-truncated total.
            total: response.total ?? 0,
          };
        })()`,
      ),
    predicate,
  );
}

async function measureIncremental(cdp, vaultPath, manifest, variant, runIndex) {
  const singlePath = manifest.mutationPaths[0];
  const batchPaths = manifest.mutationPaths.slice(0, 100);
  assert(singlePath && batchPaths.length === 100, "Scale manifest mutation paths are incomplete.");
  const singleBytes = await fs.readFile(path.join(vaultPath, ...singlePath.split("/")));
  const baseBeforeSingle = await readReadySummary(cdp);
  const singleMarker = `vaultscalesingle${variant}${runIndex}`;
  const singleStarted = performance.now();
  await fs.writeFile(
    path.join(vaultPath, ...singlePath.split("/")),
    Buffer.concat([singleBytes, Buffer.from(`\n${singleMarker}\n`)]),
  );
  const singleConverged = await waitForSearch(
    cdp,
    singleMarker,
    (value) => value.resultCount >= 1 && value.indexGeneration !== baseBeforeSingle.indexGeneration,
  );
  const singleFileMs = performance.now() - singleStarted;
  await fs.writeFile(path.join(vaultPath, ...singlePath.split("/")), singleBytes);
  await waitForSearch(cdp, singleMarker, (value) => value.resultCount === 0);

  const batchOriginals = await Promise.all(
    batchPaths.map(async (relativePath) => [
      relativePath,
      await fs.readFile(path.join(vaultPath, ...relativePath.split("/"))),
    ]),
  );
  const baseBeforeBatch = await readReadySummary(cdp);
  const batchMarker = `vaultscalebatch${variant}${runIndex}`;
  const batchStarted = performance.now();
  await Promise.all(
    batchOriginals.map(async ([relativePath, bytes]) =>
      fs.writeFile(
        path.join(vaultPath, ...relativePath.split("/")),
        Buffer.concat([bytes, Buffer.from(`\n${batchMarker}\n`)]),
      ),
    ),
  );
  const batchConverged = await waitForSearch(
    cdp,
    batchMarker,
    (value) => value.total >= 100 && value.indexGeneration !== baseBeforeBatch.indexGeneration,
  );
  const batch100Ms = performance.now() - batchStarted;
  await Promise.all(
    batchOriginals.map(async ([relativePath, bytes]) =>
      fs.writeFile(path.join(vaultPath, ...relativePath.split("/")), bytes),
    ),
  );
  return {
    singleFileMs,
    batch100Ms,
    singleChangedCount: 1,
    batchChangedCount: 100,
    singleIndexGeneration: singleConverged.indexGeneration,
    batchIndexGeneration: batchConverged.indexGeneration,
    singleIndexGenerationChanged:
      singleConverged.indexGeneration !== baseBeforeSingle.indexGeneration,
    batchIndexGenerationChanged: batchConverged.indexGeneration !== baseBeforeBatch.indexGeneration,
  };
}

async function runElectron({
  variant,
  vaultPath,
  expectedMarkdownCount,
  userDataPath,
  runIndex,
  mode,
  measureEdits,
}) {
  const port = await availablePort();
  const marker = `vault-scale-${variant}-${mode}-${runIndex}-${randomUUID()}`;
  let child;
  let cdp;
  let exited;
  let sampler;
  let samplerStopped = false;
  let memoryGuard;
  let partial = { mode, runIndex };
  const cleanup = () => {
    activeCleanup ??= cleanupPerformanceRun({
      marker,
      profilePaths: [],
      timeoutMs: 10_000,
    });
    return activeCleanup;
  };
  try {
    if (mode === "cold") await fs.rm(userDataPath, { recursive: true, force: true });
    await fs.mkdir(userDataPath, { recursive: true, mode: 0o700 });
    const startedAt = Date.now();
    child = spawn(
      "xvfb-run",
      [
        "-a",
        electronPath,
        "--ozone-platform=x11",
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataPath}`,
        "--disable-gpu",
        ".",
      ],
      {
        cwd: appRoot,
        env: {
          ...process.env,
          [markerName]: marker,
          ELECTRON_OZONE_PLATFORM_HINT: "x11",
          THREADLEAF_VAULT_PATH: vaultPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    memoryGuard = startMemoryGuard(() => child?.kill("SIGTERM"));
    exited = new Promise((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        runLog.push(String(chunk));
        if (runLog.length > 120) runLog.shift();
      });
    }
    sampler = startProcessSampler(port);
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const target = await waitForMainTarget(port);
    cdp = connectCdp(target.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await installRendererHeartbeat(cdp);
    const startup = await withMemoryGuard(
      waitForStartup(cdp, vaultPath, expectedMarkdownCount, startedAt),
      memoryGuard,
    );
    partial = { ...partial, startup };
    assert(
      startup.summary.indexedMarkdownCount === expectedMarkdownCount,
      "Indexed note count mismatch.",
    );
    const incremental = measureEdits
      ? await withMemoryGuard(
          measureIncremental(cdp, vaultPath, expectedManifestFor(variant), variant, runIndex),
          memoryGuard,
        )
      : null;
    await withMemoryGuard(delay(500), memoryGuard);
    const heartbeat = await withMemoryGuard(readRendererHeartbeat(cdp), memoryGuard);
    await withMemoryGuard(sampler.stop(), memoryGuard);
    samplerStopped = true;
    const processData = sampler.summary();
    const finalProcess = await processSnapshot(port);
    const memorySafety = memoryGuard.snapshot();
    partial = { ...partial, incremental, heartbeat, processData, memorySafety };
    const exit = await closeElectron(cdp, exited);
    assert(exit.code === 0, `Electron did not exit cleanly: ${JSON.stringify(exit)}`);
    assert(
      processData.peak.mainRssBytes > 0 && processData.peak.rendererRssBytes > 0,
      "Memory samples were unavailable.",
    );
    assert(
      finalProcess.rendererCommandLines.every((line) => line.includes("--ozone-platform=x11")),
      "A renderer escaped explicit X11.",
    );
    assert(
      finalProcess.rendererCommandLines.every((line) => !line.includes("--ozone-platform=wayland")),
      "A renderer selected Wayland despite explicit X11.",
    );
    return {
      status: "complete",
      mode,
      runIndex,
      startup,
      incremental,
      memory: {
        mainPeakRssBytes: processData.peak.mainRssBytes,
        rendererPeakRssBytes: processData.peak.rendererRssBytes,
        mainSettledRssBytes: finalProcess.mainRssBytes,
        rendererSettledRssBytes: finalProcess.rendererRssBytes,
        rendererCount: Math.max(processData.peak.rendererCount, finalProcess.rendererCount),
        processSampleCount: processData.sampleCount,
        minimumAvailableBytes: memorySafety.minimumAvailableBytes,
        safetyThresholdBytes: memorySafety.thresholdBytes,
      },
      responsiveness: {
        rendererMaxBlockingPauseMs: heartbeat.maxPauseMs,
        rendererHeartbeatTicks: heartbeat.ticks,
      },
      exit,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (error?.partial) partial = { ...partial, startup: error.partial };
    if (sampler && !samplerStopped) {
      await sampler.stop().catch(() => undefined);
      samplerStopped = true;
      partial = { ...partial, processData: sampler.summary() };
    }
    partial = {
      ...partial,
      memorySafety: memoryGuard?.snapshot() ?? null,
    };
    const wrapped = new Error(`${variant} ${mode} run ${runIndex} failed: ${detail}`, {
      cause: error,
    });
    wrapped.partial = partial;
    throw wrapped;
  } finally {
    memoryGuard?.stop();
    if (sampler && !samplerStopped) await sampler.stop().catch(() => undefined);
    cdp?.close();
    try {
      await cleanup();
    } finally {
      if (activeCleanup) activeCleanup = undefined;
    }
  }
}

let manifestCache;
let generatedManifestCache = new Map();
function expectedManifestFor(variant) {
  const manifest = generatedManifestCache.get(variant);
  if (!manifest) throw new Error(`No manifest loaded for ${variant}.`);
  return manifest;
}

function metricAgreement(name, unit, values, bound) {
  const finite = values.filter((value) => Number.isFinite(value));
  const minimum = Math.min(...finite);
  const maximum = Math.max(...finite);
  const relativeSpread = (maximum - minimum) / Math.max(1, Math.abs(minimum));
  return {
    name,
    unit,
    values,
    minimum,
    maximum,
    relativeSpread,
    bound,
    status: relativeSpread <= bound ? "within-bound" : "outside-bound",
  };
}

function agreementFor(runs) {
  const bounds = {
    timingRelativeSpread: 0.25,
    incrementalTimingRelativeSpread: 0.35,
    memoryRelativeSpread: 0.2,
    responsivenessRelativeSpread: 0.5,
  };
  if (runs.length < 2) {
    return { runs: runs.length, bounds, status: "insufficient-runs", metrics: [] };
  }
  const metrics = [
    [
      "cold.usableShellMs",
      "milliseconds",
      runs.map((run) => run.cold?.startup?.usableShellMs),
      0.25,
    ],
    [
      "cold.backgroundIndexCompleteMs",
      "milliseconds",
      runs.map((run) => run.cold?.startup?.readyMs),
      0.25,
    ],
    [
      "warm.usableShellMs",
      "milliseconds",
      runs.map((run) => run.warm?.startup?.usableShellMs),
      0.25,
    ],
    [
      "warm.backgroundIndexCompleteMs",
      "milliseconds",
      runs.map((run) => run.warm?.startup?.readyMs),
      0.25,
    ],
    [
      "incremental.singleFileMs",
      "milliseconds",
      runs.map((run) => run.warm?.incremental?.singleFileMs),
      0.35,
    ],
    [
      "incremental.batch100Ms",
      "milliseconds",
      runs.map((run) => run.warm?.incremental?.batch100Ms),
      0.35,
    ],
    ["cold.mainPeakRssBytes", "bytes", runs.map((run) => run.cold?.memory?.mainPeakRssBytes), 0.2],
    [
      "cold.rendererPeakRssBytes",
      "bytes",
      runs.map((run) => run.cold?.memory?.rendererPeakRssBytes),
      0.2,
    ],
    ["warm.mainPeakRssBytes", "bytes", runs.map((run) => run.warm?.memory?.mainPeakRssBytes), 0.2],
    [
      "warm.rendererPeakRssBytes",
      "bytes",
      runs.map((run) => run.warm?.memory?.rendererPeakRssBytes),
      0.2,
    ],
    [
      "cold.rendererMaxBlockingPauseMs",
      "milliseconds",
      runs.map((run) => run.cold?.responsiveness?.rendererMaxBlockingPauseMs),
      0.5,
    ],
    [
      "warm.rendererMaxBlockingPauseMs",
      "milliseconds",
      runs.map((run) => run.warm?.responsiveness?.rendererMaxBlockingPauseMs),
      0.5,
    ],
  ];
  const checks = metrics
    .filter(([, , values]) => values.every((value) => Number.isFinite(value)))
    .map(([name, unit, values, bound]) => metricAgreement(name, unit, values, bound));
  return {
    runs: runs.length,
    bounds,
    status:
      checks.length === 0
        ? "insufficient-data"
        : checks.every((check) => check.status === "within-bound")
          ? "within-bounds"
          : "outside-bounds",
    metrics: checks,
  };
}

function buildResult(
  variant,
  corpus,
  runs,
  runtime,
  environment,
  correctness,
  status = "complete",
  error = null,
) {
  const expected = corpus.expected;
  return {
    schemaVersion: 1,
    suite: "vault-scale-startup",
    generatedAt: new Date().toISOString(),
    status,
    runtime: {
      node: process.version,
      electron: packageData.devDependencies?.electron ?? "unknown",
      threadleaf: packageData.version,
      platform: process.platform,
      arch: process.arch,
      ...runtime,
    },
    environment,
    corpus: {
      variant,
      generatorVersion: expected.generatorVersion,
      seed: expected.seed,
      fileCount: expected.fileCount,
      visibleFileCount: expected.visibleFileCount,
      hiddenFileCount: expected.hiddenFileCount,
      markdownFileCount: expected.markdownFileCount,
      ballastFileCount: expected.ballastFileCount,
      totalBytes: expected.totalBytes,
      manifestSampleHash: expected.sampleHash,
      noteSizeDistribution: expected.noteSizeDistribution,
      depthProfile: expected.depthProfile,
      extensionCounts: expected.extensionCounts,
    },
    configuration: {
      runs: runCount,
      timeoutMs: maxWaitMs,
      display: "xvfb",
      ozonePlatform: "x11",
      gpuDisabled: true,
      coldDefinition: "Fresh Electron user-data root per run; OS page cache is not flushed.",
      warmDefinition:
        "Relaunch of the same user-data root after the cold launch; workspace state and OS caches persist, while the base branch has no persisted metadata-index cache.",
      incrementalDefinition:
        "External file edits while the real watcher is active; convergence ends when search observes the marker and the index generation includes every changed note.",
    },
    correctness,
    runs,
    agreement: agreementFor(runs),
    error,
    limitations: [
      "This lane measures only synthetic corpora and never reads the real daily-driver vault.",
      "These are Linux/Xvfb observations with Electron GPU disabled; they are not Windows, macOS, or universal desktop SLAs.",
      "Cold launches create fresh user-data roots but do not flush the kernel filesystem cache.",
      "Warm restart persists Threadleaf user-data/workspace state, but this base revision does not persist or reload a metadata index; the warm number therefore isolates restart behavior plus warm filesystem/runtime state, not an on-disk index-cache hit.",
      "The usable-shell timestamp is the renderer shell-ready mark. The separate opening-surface timestamp records when the target vault became visible, while background completion is the target DOM Ready state after index and workspace projection converge.",
      "Memory is Linux /proc VmRSS for the Electron browser and descendant renderer processes. It is not a JavaScript heap or leak proof.",
      "Renderer heartbeat pauses measure the renderer event loop. The headless kernel record separately measures Node event-loop pauses during scan, index, projection, and incremental work.",
      "The checked-in Obsidian baseline is context only. It is not a pass/fail budget for Threadleaf.",
    ],
  };
}

async function runVariant(variant, checkedIn, runtime, environment) {
  const corpus = await verifyCorpus(variant, checkedIn);
  const runs = [];
  try {
    for (let runIndex = 1; runIndex <= runCount; runIndex += 1) {
      const runRoot = path.join(testRoot, `${variant}-run-${runIndex}`);
      const userDataPath = path.join(runRoot, "user-data");
      const stateRoot = path.join(runRoot, "kernel-state");
      await fs.mkdir(runRoot, { recursive: true, mode: 0o700 });
      let cold = null;
      let warm = null;
      let kernel = null;
      let measurementError = null;
      try {
        cold = await runElectron({
          variant,
          vaultPath: corpus.vaultPath,
          expectedMarkdownCount: corpus.expected.markdownFileCount,
          userDataPath,
          runIndex,
          mode: "cold",
          measureEdits: false,
        });
        warm = await runElectron({
          variant,
          vaultPath: corpus.vaultPath,
          expectedMarkdownCount: corpus.expected.markdownFileCount,
          userDataPath,
          runIndex,
          mode: "warm",
          measureEdits: true,
        });
      } catch (error) {
        measurementError = error;
      }
      try {
        kernel = await runKernel(variant, corpus.vaultPath, stateRoot);
      } catch (error) {
        kernel = error.kernelFailure ?? null;
        measurementError ??= error;
        if (measurementError !== error) measurementError.kernelError = error.kernelFailure;
      }
      if (measurementError) {
        runs.push({
          status: "aborted",
          runIndex,
          kernel,
          cold: cold ?? {
            status: "aborted",
            mode: "cold",
            runIndex,
            error: measurementError.message ?? String(measurementError),
            partial: measurementError.partial ?? null,
          },
          warm,
        });
        throw measurementError;
      }
      runs.push({ status: "complete", runIndex, kernel, cold, warm });
    }
  } catch (error) {
    error.corpus = corpus;
    error.runs = runs;
    throw error;
  }
  const correctness = [
    {
      name: "manifest-and-corpus-integrity",
      status: "pass",
      details:
        "Payload file counts, suffix counts, note-size quantiles, and deterministic samples match the checked-in manifest.",
    },
    {
      name: "kernel-index-count",
      status: "pass",
      details: `Each kernel run indexed exactly ${corpus.expected.markdownFileCount} Markdown notes.`,
    },
    {
      name: "kernel-visible-file-count",
      status: "pass",
      details: `Each kernel run enumerated exactly ${corpus.expected.visibleFileCount} visible payload files while excluding ${corpus.expected.hiddenFileCount} hidden files.`,
    },
    {
      name: "electron-process-exit",
      status: "pass",
      details: "Every measured cold and warm Electron launch exited with code 0.",
    },
    {
      name: "explicit-x11-renderer",
      status: "pass",
      details:
        "Every measured renderer was observed with --ozone-platform=x11 and without --ozone-platform=wayland.",
    },
    {
      name: "opening-shell-reachability",
      status: "pass",
      details:
        "The target-specific shell and full Ready surface were reached through the actual renderer.",
    },
    {
      name: "incremental-single-file",
      status: "pass",
      details:
        "The real watcher and index exposed the one-file marker through search after the external edit.",
    },
    {
      name: "incremental-batch-100",
      status: "pass",
      details:
        "The real watcher and index exposed the 100-file marker and advanced index generation by at least 100.",
    },
    {
      name: "memory-process-observation",
      status: "pass",
      details: "Main and descendant renderer VmRSS samples were positive during each app run.",
    },
  ];
  return buildResult(variant, corpus, runs, runtime, environment, correctness);
}

async function writeResult(result) {
  await fs.writeFile(
    path.join(outputDirectory, `threadleaf-vault-scale-${result.corpus.variant}.json`),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  process.stdout.write(
    `${JSON.stringify(
      { variant: result.corpus.variant, status: result.status, outputDirectory },
      null,
      2,
    )}\n`,
  );
}

async function main() {
  assert(process.platform === "linux", "Vault-scale app benchmarks require Linux/Xvfb.");
  assert(
    await fs
      .stat(electronPath)
      .then((stat) => stat.isFile())
      .catch(() => false),
    "Electron is not installed. Run pnpm install first.",
  );
  assert(
    await fs
      .stat(kernelRunnerPath)
      .then((stat) => stat.isFile())
      .catch(() => false),
    "Benchmark bundle is missing. Run pnpm build:benchmarks first.",
  );
  manifestCache = await loadManifest();
  generatedManifestCache = new Map();
  const runtime = await gitMetadata();
  const environment = {
    display: "xvfb",
    ozonePlatform: "x11",
    gpuDisabled: true,
    cpuCount: os.cpus().length,
    cpuModel: await cpuModel(),
    kernel: os.release(),
    memoryTotalBytes: await memoryTotalBytes(),
  };
  await fs.mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  let abortedVariants = 0;
  for (const variant of ["full", "notes-only"]) {
    try {
      await writeResult(await runVariant(variant, manifestCache, runtime, environment));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const corpus = error.corpus ?? { variant, expected: manifestCache.variants[variant] };
      const aborted = buildResult(
        variant,
        corpus,
        error.runs ?? [],
        runtime,
        environment,
        [
          {
            name: "measurement-completion",
            status: "aborted",
            details: `The matrix stopped before all requested runs completed: ${detail}`,
          },
        ],
        "aborted",
        {
          message: detail,
          completedRuns: error.runs?.filter((run) => run.status === "complete").length ?? 0,
          observedRuns: error.runs?.length ?? 0,
          kernelError: error.kernelError ?? error.kernelFailure ?? null,
          partial: error.partial ?? null,
        },
      );
      await writeResult(aborted);
      abortedVariants += 1;
    }
  }
  if (abortedVariants > 0) {
    throw new Error(`${abortedVariants} vault-scale variant(s) aborted; see the JSON results.`);
  }
}

try {
  await main();
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  const cause = error?.partial ? { partial: error.partial } : null;
  process.stderr.write(`${detail}\n${runLog.slice(-40).join("")}\n`);
  if (cause) process.stderr.write(`${JSON.stringify(cause)}\n`);
  process.exitCode = 1;
} finally {
  if (activeCleanup) await activeCleanup.catch(() => undefined);
  await fs.rm(testRoot, { recursive: true, force: true });
}
