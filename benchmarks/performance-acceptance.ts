import { type ChildProcess, execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import {
  buildVaultScaleManifest,
  type VaultScaleManifest,
  type VaultScaleVariant,
  verifyVaultScaleCorpus,
  writeVaultScaleCorpus,
} from "./vault-scale-corpus";

const execFileAsync = promisify(execFile);
const appRoot = process.cwd();
const electronPath = path.join(appRoot, "node_modules", ".bin", "electron");
const kernelRunnerPath = path.join(appRoot, ".bench-dist", "vault-scale-kernel.cjs");
const resultPath = path.join(
  appRoot,
  "benchmarks",
  "results",
  "threadleaf-performance-acceptance-full.json",
);

export const performanceAcceptanceHardTimeoutMs = 25 * 60 * 1_000;
export const performanceAcceptanceDefaultTimeoutMs = 20 * 60 * 1_000;
export const performanceAcceptanceMinimumMemAvailableKiB = 8_388_608;

interface AcceptanceOptions {
  corpusRoot: string;
  outputPath: string;
  timeoutMs: number;
  requireHeavyGate: boolean;
  variant: Extract<VaultScaleVariant, "full" | "smoke">;
  forceElectronTimeout: boolean;
}

interface MachineState {
  capturedAt: string;
  memAvailableBytes: number | null;
  loadAverage: readonly number[];
  cpuCount: number;
  cpuModel: string;
  kernel: string;
  memoryTotalBytes: number;
}

interface RssSample {
  elapsedMs: number;
  mainRssBytes: number;
  rendererRssBytes: number;
  rendererCount: number;
}

interface CdpClient {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

export interface ElectronClosePort {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

type KernelSuccess = {
  status: "complete";
  startedAt: string;
  completedAt: string;
  timeoutMs: number;
  machineBefore: MachineState;
  machineAfter: MachineState;
  timings: Record<string, number>;
  memory: Record<string, number>;
  responsiveness: Record<string, unknown>;
  incremental: Record<string, unknown>;
  [key: string]: unknown;
};

type KernelAbort = {
  status: "aborted";
  startedAt: string;
  completedAt: string;
  timeoutMs: number;
  machineBefore: MachineState;
  machineAfter: MachineState;
  reason: string;
  code: string | number | null;
  signal: string | null;
  timedOut: boolean;
  stderrTail: string;
};

interface ElectronSurface {
  bodyVisible: boolean;
  shellReady: boolean;
  shellMark: number | null;
  shellTimeOrigin: number | null;
  targetPath: string;
  runtimeState: string;
  indexStatus: string;
  indexedMarkdownCount: number | null;
  watcherError: string | null;
}

interface ElectronWorkspaceLeg {
  status: "complete" | "aborted";
  startedAt: string;
  completedAt: string;
  timeoutMs: number;
  machine: MachineState;
  usableShellMs: number | null;
  backgroundCompletionMs: number | null;
  indexingWindowMs?: number;
  responsivenessProbes: Array<Record<string, unknown>>;
  runtimeDiagnostics: string[];
  rss: {
    samples: RssSample[];
    peakMainRssBytes: number;
    peakRendererRssBytes: number;
  };
  finalSurface: ElectronSurface | null;
  reason?: string;
}

function stringArgument(argv: readonly string[], name: string, fallback: string): string {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

export function parsePerformanceAcceptanceOptions(argv: readonly string[]): AcceptanceOptions {
  const timeoutMs = Number(
    stringArgument(argv, "--timeout-ms", String(performanceAcceptanceDefaultTimeoutMs)),
  );
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > performanceAcceptanceHardTimeoutMs
  ) {
    throw new Error(
      `--timeout-ms must be a positive integer no greater than ${performanceAcceptanceHardTimeoutMs}.`,
    );
  }
  const variant = stringArgument(argv, "--variant", "full");
  if (variant !== "full" && variant !== "smoke") {
    throw new Error("--variant must be full or smoke.");
  }
  return {
    corpusRoot: path.resolve(
      stringArgument(
        argv,
        "--corpus-root",
        path.join(appRoot, ".bench-corpus", "threadleaf-performance-acceptance-v1"),
      ),
    ),
    outputPath: path.resolve(stringArgument(argv, "--output", resultPath)),
    timeoutMs,
    requireHeavyGate: argv.includes("--require-heavy-gate"),
    variant,
    forceElectronTimeout: argv.includes("--force-electron-timeout"),
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, description: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${description} timed out after ${timeoutMs} ms.`)),
      timeoutMs,
    );
    void operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function memInfo(): Promise<{ availableBytes: number | null; totalBytes: number }> {
  try {
    const contents = await fs.readFile("/proc/meminfo", "utf8");
    const numberAt = (name: string): number | null => {
      const match = contents.match(new RegExp(`^${name}:\\s+(\\d+)\\s+kB$`, "m"));
      return match ? Number(match[1]) * 1_024 : null;
    };
    return {
      availableBytes: numberAt("MemAvailable"),
      totalBytes: numberAt("MemTotal") ?? os.totalmem(),
    };
  } catch {
    return { availableBytes: null, totalBytes: os.totalmem() };
  }
}

async function cpuModel(): Promise<string> {
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

async function machineState(): Promise<MachineState> {
  const memory = await memInfo();
  return {
    capturedAt: new Date().toISOString(),
    memAvailableBytes: memory.availableBytes,
    loadAverage: os.loadavg(),
    cpuCount: os.cpus().length,
    cpuModel: await cpuModel(),
    kernel: os.release(),
    memoryTotalBytes: memory.totalBytes,
  };
}

async function gitMetadata(): Promise<Record<string, string | boolean>> {
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

async function ensureCorpus(
  corpusRoot: string,
  variant: Extract<VaultScaleVariant, "full" | "smoke">,
) {
  const expected = buildVaultScaleManifest(variant);
  const outputDirectory = path.join(corpusRoot, variant);
  const exists = await fs
    .stat(outputDirectory)
    .then((stat) => stat.isDirectory())
    .catch(() => false);
  if (!exists) await writeVaultScaleCorpus(outputDirectory, variant);
  const manifest = await verifyVaultScaleCorpus(outputDirectory, expected);
  return { outputDirectory, vaultPath: path.join(outputDirectory, "vault"), manifest };
}

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a loopback debugging port.");
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function connectCdp(webSocketUrl: string): CdpClient {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >();
  let sequence = 0;
  const rejectPending = (message: string) => {
    for (const request of pending.values()) request.reject(new Error(message));
    pending.clear();
  };
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      error?: { message?: string };
      result?: unknown;
    };
    if (message.id === undefined) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message ?? "CDP request failed."));
    else request.resolve(message.result);
  });
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP WebSocket failed to open.")), {
      once: true,
    });
  });
  socket.addEventListener("close", () => rejectPending("CDP WebSocket closed."));
  return {
    async send(method, params = {}) {
      await opened;
      const id = ++sequence;
      const result = new Promise<unknown>((resolve, reject) =>
        pending.set(id, { resolve, reject }),
      );
      socket.send(JSON.stringify({ id, method, params }));
      return result;
    },
    close() {
      socket.close();
    },
  };
}

async function evaluate<T>(cdp: CdpClient, expression: string): Promise<T> {
  const response = (await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })) as { exceptionDetails?: { exception?: { description?: string } }; result?: { value?: T } };
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ?? "Renderer evaluation failed.",
    );
  }
  return response.result?.value as T;
}

async function waitForMainTarget(port: number, deadline: number): Promise<string> {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = (response.ok ? await response.json() : []) as Array<{
        type?: string;
        url?: string;
        webSocketDebuggerUrl?: string;
      }>;
      const target = targets.find(
        (candidate) =>
          candidate.type === "page" &&
          candidate.url?.endsWith("/dist/renderer/index.html") &&
          candidate.webSocketDebuggerUrl,
      );
      if (target?.webSocketDebuggerUrl) return target.webSocketDebuggerUrl;
    } catch {
      // Electron has not published its CDP target yet.
    }
    await delay(100);
  }
  throw new Error(
    "Electron did not publish its renderer debugging target before the hard timeout.",
  );
}

async function processEntries(): Promise<
  Array<{
    pid: number;
    parentPid: number;
    rssBytes: number;
    commandLine: string;
    executable: string;
  }>
> {
  const entries: Array<{
    pid: number;
    parentPid: number;
    rssBytes: number;
    commandLine: string;
    executable: string;
  }> = [];
  for (const entry of await fs.readdir("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    const pid = Number(entry);
    try {
      const [status, commandBytes, executable] = await Promise.all([
        fs.readFile(`/proc/${pid}/status`, "utf8"),
        fs.readFile(`/proc/${pid}/cmdline`),
        fs.readlink(`/proc/${pid}/exe`),
      ]);
      const parent = status.match(/^PPid:\s+(\d+)$/m);
      const rss = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
      if (!parent || !rss) continue;
      entries.push({
        pid,
        parentPid: Number(parent[1]),
        rssBytes: Number(rss[1]) * 1_024,
        commandLine: commandBytes.toString("utf8").replaceAll("\0", " "),
        executable,
      });
    } catch {
      // Processes can disappear while /proc is sampled.
    }
  }
  return entries;
}

function descendantsOf<T extends { pid: number; parentPid: number }>(
  entries: readonly T[],
  rootPid: number,
): T[] {
  const children = new Map<number, T[]>();
  for (const entry of entries) {
    const list = children.get(entry.parentPid) ?? [];
    list.push(entry);
    children.set(entry.parentPid, list);
  }
  const descendants: T[] = [];
  const queue = [...(children.get(rootPid) ?? [])];
  while (queue.length > 0) {
    const entry = queue.shift();
    if (!entry) continue;
    descendants.push(entry);
    queue.push(...(children.get(entry.pid) ?? []));
  }
  return descendants;
}

async function rssSnapshot(port: number): Promise<Omit<RssSample, "elapsedMs"> | null> {
  const entries = await processEntries();
  const browser = entries.find(
    (entry) =>
      entry.commandLine.includes(`--remote-debugging-port=${port}`) &&
      path.basename(entry.executable).replace(/ \(deleted\)$/u, "") === "electron",
  );
  if (!browser) return null;
  const renderers = descendantsOf(entries, browser.pid).filter((entry) =>
    entry.commandLine.includes("--type=renderer"),
  );
  return {
    mainRssBytes: browser.rssBytes,
    rendererRssBytes: renderers.reduce((total, entry) => total + entry.rssBytes, 0),
    rendererCount: renderers.length,
  };
}

function startRssSampler(
  port: number,
  startedAt: number,
  onSample: (() => Promise<void>) | undefined,
) {
  const samples: RssSample[] = [];
  let reading = false;
  const sample = async () => {
    if (reading) return;
    reading = true;
    try {
      const snapshot = await rssSnapshot(port);
      if (snapshot) {
        samples.push({ elapsedMs: Date.now() - startedAt, ...snapshot });
        await onSample?.();
      }
    } finally {
      reading = false;
    }
  };
  const timer = setInterval(() => void sample(), 1_000);
  void sample();
  return {
    async stop() {
      clearInterval(timer);
      await sample();
    },
    summary() {
      return {
        samples,
        peakMainRssBytes: Math.max(0, ...samples.map((sample) => sample.mainRssBytes)),
        peakRendererRssBytes: Math.max(0, ...samples.map((sample) => sample.rendererRssBytes)),
      };
    },
  };
}

async function readElectronSurface(cdp: CdpClient): Promise<ElectronSurface> {
  return evaluate<ElectronSurface>(
    cdp,
    `(() => ({
      bodyVisible: Boolean(document.body && document.body.getBoundingClientRect().width > 0),
      shellReady: document.documentElement.dataset.threadleafShellReady === "true",
      shellMark: performance.getEntriesByName("threadleaf:shell-ready").at(-1)?.startTime ?? null,
      shellTimeOrigin: performance.timeOrigin,
      targetPath: document.querySelector("#vault-identity")?.getAttribute("title") ?? "",
      runtimeState: document.querySelector("#runtime-state")?.textContent ?? "",
      indexStatus: document.querySelector("#index-status")?.textContent ?? "",
      indexedMarkdownCount: window.threadleaf ? null : null,
      watcherError: null,
    }))()`,
  );
}

async function readReadySnapshot(cdp: CdpClient) {
  return evaluate<{
    vaultPath: string | null;
    vaultState: string | null;
    censusState: string | null;
    indexedMarkdownCount: number | null;
    watcherError: string | null;
  }>(
    cdp,
    `(async () => {
      const snapshot = await window.threadleaf.getSnapshot();
      return {
        vaultPath: snapshot.vault?.path ?? null,
        vaultState: snapshot.workspace?.state ?? null,
        censusState: snapshot.workspace?.census?.state ?? null,
        indexedMarkdownCount: snapshot.workspace?.census?.indexed ?? null,
        watcherError: snapshot.workspace?.watcher?.error ?? null,
      };
    })()`,
  );
}

async function probeSearchLatency(cdp: CdpClient, elapsedMs: number) {
  const started = performance.now();
  try {
    const response = await withTimeout(
      evaluate<{ resultCount?: number; indexGeneration?: number }>(
        cdp,
        `(async () => {
          const result = await window.threadleaf.searchVault("threadleaf-scale");
          return {
            resultCount: result.results?.length ?? 0,
            indexGeneration: result.indexGeneration ?? null,
          };
        })()`,
      ),
      5_000,
      "Renderer search probe",
    );
    return {
      elapsedMs,
      status: "complete" as const,
      latencyMs: performance.now() - started,
      resultCount: response.resultCount ?? 0,
      indexGeneration: response.indexGeneration ?? null,
    };
  } catch (error) {
    return {
      elapsedMs,
      status: "aborted" as const,
      latencyMs: performance.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
    if (child.exitCode !== null) {
      child.off("exit", onExit);
      clearTimeout(timer);
      resolve(true);
    }
  });
}

async function stopChild(child: ChildProcess | undefined, gracefulWaitMs = 0): Promise<void> {
  if (!child?.pid || child.exitCode !== null) return;
  if (gracefulWaitMs > 0 && (await waitForChildExit(child, gracefulWaitMs))) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(10_000),
  ]);
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
}

export async function closeElectronGracefully(
  cdp: ElectronClosePort | undefined,
): Promise<boolean> {
  if (!cdp) return false;
  try {
    await withTimeout(
      cdp.send("Runtime.evaluate", {
        expression: "window.close(); true",
        returnByValue: true,
      }),
      5_000,
      "Electron window close",
    );
    return true;
  } catch {
    // The child-kill fallback below owns a browser that has already stopped responding.
    return false;
  }
}

interface ElectronObserverOptions {
  vaultPath: string;
  expectedMarkdownCount: number;
  timeoutMs: number;
  outputPath: string;
  forceElectronTimeout: boolean;
  mode: "cold" | "warm";
  userDataPath: string;
}

async function runElectronWorkspaceOpen(
  options: ElectronObserverOptions,
  checkpoint: (leg: ElectronWorkspaceLeg) => Promise<void>,
): Promise<ElectronWorkspaceLeg> {
  const { vaultPath, expectedMarkdownCount, timeoutMs, forceElectronTimeout } = options;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const port = await availablePort();
  const userDataPath = options.userDataPath;
  await fs.mkdir(userDataPath, { recursive: true, mode: 0o700 });
  let child: ChildProcess | undefined;
  let cdp: CdpClient | undefined;
  let sampler: ReturnType<typeof startRssSampler> | undefined;
  let lastSurface: ElectronSurface | null = null;
  let shellReadyMs: number | null = null;
  let readyMs: number | null = null;
  const probes: Array<Record<string, unknown>> = [];
  const runtimeDiagnostics: string[] = [];
  const recordRuntimeDiagnostics = (chunk: Buffer | string): void => {
    for (const rawLine of String(chunk).split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (!line || !/threadleaf|error|warn|fail/iu.test(line)) continue;
      runtimeDiagnostics.push(
        line
          .replaceAll(appRoot, "<app-root>")
          .replaceAll(vaultPath, "<corpus-vault>")
          .replace(/\/tmp\/threadleaf-[^\s:]*/gu, "<threadleaf-temp>"),
      );
      while (runtimeDiagnostics.length > 80) runtimeDiagnostics.shift();
    }
  };
  const machine = await machineState();
  const snapshot = (status: "complete" | "aborted", reason?: string): ElectronWorkspaceLeg => {
    const rss = sampler?.summary() ?? {
      samples: [],
      peakMainRssBytes: 0,
      peakRendererRssBytes: 0,
    };
    return {
      status,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      timeoutMs,
      machine,
      usableShellMs: shellReadyMs,
      backgroundCompletionMs: readyMs,
      ...(status === "complete" && readyMs !== null
        ? { indexingWindowMs: Math.max(0, readyMs - (shellReadyMs ?? readyMs)) }
        : {}),
      responsivenessProbes: [...probes],
      // Keep this array live through the finally block so shutdown-time cache diagnostics become
      // part of the observer's returned receipt, not only an earlier ready checkpoint.
      runtimeDiagnostics,
      rss,
      finalSurface: lastSurface
        ? {
            ...lastSurface,
            targetPath:
              lastSurface.targetPath === vaultPath ? "<corpus-vault>" : "<non-corpus-target>",
          }
        : null,
      ...(reason ? { reason } : {}),
    };
  };
  let checkpointWrite = Promise.resolve();
  const persist = async (leg: ElectronWorkspaceLeg): Promise<void> => {
    checkpointWrite = checkpointWrite.catch(() => undefined).then(() => checkpoint(leg));
    await checkpointWrite;
  };
  try {
    child = spawn(
      "xvfb-run",
      [
        "-a",
        "-s",
        "-screen 0 1440x840x24 -nolisten tcp",
        electronPath,
        "--ozone-platform=x11",
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataPath}`,
        "--disable-gpu",
        ".",
      ],
      {
        cwd: appRoot,
        detached: true,
        env: {
          ...process.env,
          ELECTRON_OZONE_PLATFORM_HINT: "x11",
          THREADLEAF_VAULT_PATH: vaultPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout?.on("data", recordRuntimeDiagnostics);
    child.stderr?.on("data", recordRuntimeDiagnostics);
    sampler = startRssSampler(port, startedAt, () =>
      persist(snapshot("aborted", "Electron observation checkpoint is still in progress.")),
    );
    await persist(snapshot("aborted", "Electron observation checkpoint is still in progress."));
    const webSocketUrl = await waitForMainTarget(port, deadline);
    cdp = connectCdp(webSocketUrl);
    await cdp.send("Page.enable");
    const probeSchedule = [1_000, Math.floor(timeoutMs / 2), Math.max(1_000, timeoutMs - 5_000)];
    let nextProbe = 0;
    while (Date.now() < deadline) {
      const elapsedMs = Date.now() - startedAt;
      lastSurface = await withTimeout(readElectronSurface(cdp), 5_000, "Renderer surface poll");
      if (lastSurface.shellReady && shellReadyMs === null) {
        shellReadyMs =
          lastSurface.shellMark === null || lastSurface.shellTimeOrigin === null
            ? elapsedMs
            : lastSurface.shellTimeOrigin + lastSurface.shellMark - startedAt;
        await persist(snapshot("aborted", "Electron observation checkpoint is still in progress."));
      }
      const activeSnapshot =
        lastSurface.targetPath === vaultPath
          ? await withTimeout(readReadySnapshot(cdp), 5_000, "Active vault snapshot")
          : null;
      const scheduledProbeAt = probeSchedule[nextProbe];
      if (
        shellReadyMs !== null &&
        activeSnapshot?.vaultPath === vaultPath &&
        scheduledProbeAt !== undefined &&
        elapsedMs >= scheduledProbeAt
      ) {
        probes.push(await probeSearchLatency(cdp, elapsedMs));
        nextProbe += 1;
      }
      if (lastSurface.targetPath === vaultPath && lastSurface.runtimeState === "Ready") {
        const readySnapshot =
          activeSnapshot ?? (await withTimeout(readReadySnapshot(cdp), 5_000, "Ready snapshot"));
        if (
          readySnapshot.vaultPath === vaultPath &&
          readySnapshot.vaultState === "ready" &&
          readySnapshot.censusState === "current" &&
          readySnapshot.indexedMarkdownCount === expectedMarkdownCount &&
          readySnapshot.watcherError === null
        ) {
          lastSurface = {
            ...lastSurface,
            indexedMarkdownCount: readySnapshot.indexedMarkdownCount,
          };
          if (!forceElectronTimeout) {
            readyMs = Date.now() - startedAt;
            await persist(
              snapshot("aborted", "Electron observation checkpoint is still in progress."),
            );
            break;
          }
        }
      }
      await delay(250);
    }
    if (forceElectronTimeout) {
      throw new Error(`Electron abort validation forced after ${timeoutMs} ms.`);
    }
    if (readyMs === null) {
      throw new Error(`Threadleaf did not reach full workspace readiness within ${timeoutMs} ms.`);
    }
    while (probes.length < 3) {
      probes.push({
        elapsedMs: readyMs,
        status: "not-applicable",
        reason: "Background indexing completed before this scheduled probe point.",
      });
    }
    await sampler.stop();
    const result = snapshot("complete");
    sampler = undefined;
    await persist(result);
    return result;
  } catch (error) {
    if (sampler) {
      await sampler.stop();
    }
    const result = snapshot("aborted", error instanceof Error ? error.message : String(error));
    sampler = undefined;
    await persist(result);
    return result;
  } finally {
    const gracefulCloseRequested = await closeElectronGracefully(cdp);
    cdp?.close();
    if (sampler) await sampler.stop();
    // A renderer window close reaches Electron's window-all-closed and before-quit lifecycle.
    // Browser.close bypassed that lifecycle and made the required warm leg silently cold.
    await stopChild(child, gracefulCloseRequested ? 120_000 : 0);
  }
}

async function runKernelCold(
  vaultPath: string,
  stateRoot: string,
  timeoutMs: number,
  variant: Extract<VaultScaleVariant, "full" | "smoke">,
): Promise<KernelSuccess | KernelAbort> {
  const startedAt = Date.now();
  const before = await machineState();
  try {
    const operation = execFileAsync(
      process.execPath,
      [kernelRunnerPath, "--variant", variant, "--vault", vaultPath, "--state-root", stateRoot],
      {
        cwd: appRoot,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      },
    );
    const { stdout } = await operation;
    const result = JSON.parse(stdout) as Record<string, unknown>;
    return {
      status: "complete" as const,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      timeoutMs,
      machineBefore: before,
      machineAfter: await machineState(),
      ...result,
    } as KernelSuccess;
  } catch (error) {
    const failure = error as {
      code?: string | number | null;
      signal?: string | null;
      stderr?: unknown;
    };
    return {
      status: "aborted" as const,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      timeoutMs,
      machineBefore: before,
      machineAfter: await machineState(),
      reason: error instanceof Error ? error.message : String(error),
      code: failure.code ?? null,
      signal: failure.signal ?? null,
      timedOut: failure.code === "ETIMEDOUT",
      stderrTail: String(failure.stderr ?? "").slice(-4_000),
    };
  }
}

async function writeResultAtomically(outputPath: string, result: unknown): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  const temporary = `${outputPath}.tmp-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, outputPath);
}

function initialElectronLeg(timeoutMs: number, machine: MachineState): ElectronWorkspaceLeg {
  const capturedAt = new Date().toISOString();
  return {
    status: "aborted",
    startedAt: capturedAt,
    completedAt: capturedAt,
    timeoutMs,
    machine,
    reason: "The isolated Electron observer has not deposited a checkpoint yet.",
    usableShellMs: null,
    backgroundCompletionMs: null,
    responsivenessProbes: [],
    runtimeDiagnostics: [],
    rss: { samples: [], peakMainRssBytes: 0, peakRendererRssBytes: 0 },
    finalSurface: null,
  };
}

function initialKernelLeg(timeoutMs: number, machine: MachineState): KernelAbort {
  const capturedAt = new Date().toISOString();
  return {
    status: "aborted",
    startedAt: capturedAt,
    completedAt: capturedAt,
    timeoutMs,
    machineBefore: machine,
    machineAfter: machine,
    reason: "The cold kernel leg has not started yet.",
    code: null,
    signal: null,
    timedOut: false,
    stderrTail: "",
  };
}

async function writeElectronCheckpoint(
  outputPath: string,
  electron: ElectronWorkspaceLeg,
  mode: "cold" | "warm",
): Promise<void> {
  const result = JSON.parse(await fs.readFile(outputPath, "utf8")) as {
    generatedAt: string;
    status: "complete" | "aborted";
    legs: Record<string, unknown>;
  };
  result.generatedAt = new Date().toISOString();
  result.status = "aborted";
  if (mode === "warm") {
    result.legs.warmPersistedIndex = electron;
    await writeResultAtomically(outputPath, result);
    return;
  }
  result.legs.electronWorkspaceOpen = electron;
  result.legs.timeToUsableShell = {
    status: electron.usableShellMs === null ? "aborted" : "complete",
    timeoutMs: electron.timeoutMs,
    machine: electron.machine,
    valueMs: electron.usableShellMs,
  };
  result.legs.backgroundCompletion = {
    status: electron.backgroundCompletionMs === null ? "aborted" : "complete",
    timeoutMs: electron.timeoutMs,
    machine: electron.machine,
    valueMs: electron.backgroundCompletionMs,
    kernelReadinessMs: null,
  };
  result.legs.memory = {
    status: "aborted",
    timeoutMs: electron.timeoutMs,
    machine: electron.machine,
    kernelPeakRssBytes: null,
    kernelSettledRssBytes: null,
    electronPeakMainRssBytes: electron.rss.peakMainRssBytes,
    electronPeakRendererRssBytes: electron.rss.peakRendererRssBytes,
  };
  result.legs.responsiveness = {
    status: "aborted",
    timeoutMs: electron.timeoutMs,
    machine: electron.machine,
    kernel: {},
    electronSearchProbes: electron.responsivenessProbes,
  };
  await writeResultAtomically(outputPath, result);
}

function parseElectronObserverOptions(argv: readonly string[]): ElectronObserverOptions {
  const expectedMarkdownCount = Number(stringArgument(argv, "--expected-markdown-count", ""));
  const timeoutMs = Number(stringArgument(argv, "--timeout-ms", ""));
  if (!Number.isSafeInteger(expectedMarkdownCount) || expectedMarkdownCount < 1) {
    throw new Error("--expected-markdown-count must be a positive integer.");
  }
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > performanceAcceptanceHardTimeoutMs
  ) {
    throw new Error("--timeout-ms must be a supported positive integer.");
  }
  const vaultPath = stringArgument(argv, "--vault", "");
  const outputPath = stringArgument(argv, "--output", "");
  const userDataPath = stringArgument(argv, "--user-data", "");
  const mode = stringArgument(argv, "--mode", "");
  if (!vaultPath || !outputPath || !userDataPath) {
    throw new Error("--vault, --output, and --user-data are required.");
  }
  if (mode !== "cold" && mode !== "warm") throw new Error("--mode must be cold or warm.");
  return {
    vaultPath: path.resolve(vaultPath),
    expectedMarkdownCount,
    timeoutMs,
    outputPath: path.resolve(outputPath),
    forceElectronTimeout: argv.includes("--force-electron-timeout"),
    mode,
    userDataPath: path.resolve(userDataPath),
  };
}

async function waitForExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function stopIsolatedObserver(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await Promise.race([waitForExit(child), delay(10_000)]);
  if (child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  await waitForExit(child);
}

async function readElectronCheckpoint(
  outputPath: string,
  fallback: ElectronWorkspaceLeg,
  mode: "cold" | "warm",
): Promise<ElectronWorkspaceLeg> {
  try {
    const result = JSON.parse(await fs.readFile(outputPath, "utf8")) as {
      legs?: {
        electronWorkspaceOpen?: ElectronWorkspaceLeg;
        warmPersistedIndex?: ElectronWorkspaceLeg;
      };
    };
    return (
      (mode === "warm" ? result.legs?.warmPersistedIndex : result.legs?.electronWorkspaceOpen) ??
      fallback
    );
  } catch {
    return fallback;
  }
}

async function runElectronObserverIsolated(
  options: ElectronObserverOptions,
): Promise<ElectronWorkspaceLeg> {
  const entrypoint = process.argv[1];
  const fallback = initialElectronLeg(options.timeoutMs, await machineState());
  if (!entrypoint) {
    return { ...fallback, reason: "Electron observer could not locate its bundled entrypoint." };
  }
  const child = spawn(
    process.execPath,
    [
      entrypoint,
      "--electron-observer",
      "--vault",
      options.vaultPath,
      "--expected-markdown-count",
      String(options.expectedMarkdownCount),
      "--timeout-ms",
      String(options.timeoutMs),
      "--output",
      options.outputPath,
      "--mode",
      options.mode,
      "--user-data",
      options.userDataPath,
      ...(options.forceElectronTimeout ? ["--force-electron-timeout"] : []),
    ],
    { cwd: appRoot, detached: true, env: process.env, stdio: "ignore" },
  );
  let exit: { code: number | null; signal: NodeJS.Signals | null };
  try {
    exit = await withTimeout(
      waitForExit(child),
      options.timeoutMs + 30_000,
      "Electron observer supervision",
    );
  } catch {
    await stopIsolatedObserver(child);
    const checkpoint = await readElectronCheckpoint(options.outputPath, fallback, options.mode);
    return {
      ...checkpoint,
      status: "aborted",
      completedAt: new Date().toISOString(),
      reason: `Electron observer exceeded its ${options.timeoutMs + 30_000} ms supervision window.`,
    };
  }
  const checkpoint = await readElectronCheckpoint(options.outputPath, fallback, options.mode);
  if (exit.code === 0 || checkpoint.status === "aborted") return checkpoint;
  return {
    ...checkpoint,
    status: "aborted",
    completedAt: new Date().toISOString(),
    reason: `Electron observer exited before its final checkpoint (code=${exit.code}, signal=${exit.signal}).`,
  };
}

async function runElectronObserverMain(): Promise<void> {
  const options = parseElectronObserverOptions(process.argv.slice(2));
  const electron = await runElectronWorkspaceOpen(options, (leg) =>
    writeElectronCheckpoint(options.outputPath, leg, options.mode),
  );
  process.stdout.write(
    `${JSON.stringify({ status: electron.status, outputPath: options.outputPath })}\n`,
  );
  if (electron.status === "aborted") process.exitCode = 1;
}

function initialResult(
  options: AcceptanceOptions,
  manifest: VaultScaleManifest,
  machine: MachineState,
) {
  const electron = initialElectronLeg(options.timeoutMs, machine);
  const coldKernel = initialKernelLeg(options.timeoutMs, machine);
  const notStarted = (reason: string) => ({
    status: "aborted" as const,
    timeoutMs: options.timeoutMs,
    machine,
    reason,
  });
  return {
    schemaVersion: 1,
    suite: "threadleaf-performance-acceptance",
    generatedAt: new Date().toISOString(),
    status: "aborted" as const,
    runtime: {},
    corpus: {
      schemaVersion: manifest.schemaVersion,
      variant: manifest.variant,
      generatorVersion: manifest.generatorVersion,
      seed: manifest.seed,
      manifestHash: manifest.manifestHash,
      sampleHash: manifest.sampleHash,
      fileCount: manifest.fileCount,
      visibleFileCount: manifest.visibleFileCount,
      hiddenFileCount: manifest.hiddenFileCount,
      markdownFileCount: manifest.markdownFileCount,
      ballastFileCount: manifest.ballastFileCount,
      totalBytes: manifest.totalBytes,
      depthProfile: manifest.depthProfile,
      noteSizeDistribution: manifest.noteSizeDistribution,
      extensionCounts: manifest.extensionCounts,
    },
    configuration: { checkpointedElectronObserver: true },
    legs: {
      electronWorkspaceOpen: electron,
      coldKernel,
      warmPersistedIndex: {
        ...initialElectronLeg(options.timeoutMs, machine),
        reason: "The persisted-index warm restart has not started yet.",
      },
      incremental: notStarted("The cold kernel leg has not started yet."),
      timeToUsableShell: {
        ...notStarted("The isolated Electron observer has not deposited a checkpoint yet."),
        valueMs: null,
      },
      backgroundCompletion: {
        ...notStarted("The isolated Electron observer has not deposited a checkpoint yet."),
        valueMs: null,
        kernelReadinessMs: null,
      },
      memory: {
        ...notStarted("The cold kernel leg has not started yet."),
        kernelPeakRssBytes: null,
        kernelSettledRssBytes: null,
        electronPeakMainRssBytes: 0,
        electronPeakRendererRssBytes: 0,
      },
      responsiveness: {
        ...notStarted("The cold kernel leg has not started yet."),
        kernel: {},
        electronSearchProbes: [],
      },
    },
    limitations: [
      "This is an in-progress checkpoint. A later atomic snapshot replaces it after each Electron observation and after the kernel leg.",
    ],
  };
}

async function main(): Promise<void> {
  const options = parsePerformanceAcceptanceOptions(process.argv.slice(2));
  const available = (await memInfo()).availableBytes;
  if (options.requireHeavyGate) {
    if (process.env.THREADLEAF_PERFORMANCE_HEAVY_GATE !== "primary") {
      throw new Error("--require-heavy-gate requires the primary flock wrapper.");
    }
    if (available === null || available < performanceAcceptanceMinimumMemAvailableKiB * 1_024) {
      throw new Error(
        `MemAvailable must be at least ${performanceAcceptanceMinimumMemAvailableKiB} KiB before the heavy Electron leg.`,
      );
    }
  }
  await fs.access(electronPath);
  await fs.access(kernelRunnerPath);
  const corpus = await ensureCorpus(options.corpusRoot, options.variant);
  const initialMachine = await machineState();
  await writeResultAtomically(
    options.outputPath,
    initialResult(options, corpus.manifest, initialMachine),
  );
  const electronUserDataPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "threadleaf-performance-acceptance-profile-"),
  );
  const electronOptions = {
    vaultPath: corpus.vaultPath,
    expectedMarkdownCount: corpus.manifest.markdownFileCount,
    timeoutMs: options.timeoutMs,
    outputPath: options.outputPath,
    userDataPath: electronUserDataPath,
  };
  let electron: ElectronWorkspaceLeg;
  let warmPersistedIndex: ElectronWorkspaceLeg;
  try {
    electron = await runElectronObserverIsolated({
      ...electronOptions,
      mode: "cold",
      forceElectronTimeout: options.forceElectronTimeout,
    });
    warmPersistedIndex =
      electron.status === "complete"
        ? await runElectronObserverIsolated({
            ...electronOptions,
            mode: "warm",
            forceElectronTimeout: false,
          })
        : {
            ...initialElectronLeg(options.timeoutMs, await machineState()),
            reason:
              "The cold Electron launch aborted, so the persisted-index restart could not begin.",
          };
  } finally {
    await fs.rm(electronUserDataPath, { recursive: true, force: true });
  }
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "threadleaf-performance-acceptance-state-"),
  );
  const coldKernel = await runKernelCold(
    corpus.vaultPath,
    stateRoot,
    options.timeoutMs,
    options.variant,
  );
  await fs.rm(stateRoot, { recursive: true, force: true });
  const kernelComplete = coldKernel.status === "complete";
  const timings = kernelComplete
    ? (coldKernel.timings as Record<string, number>)
    : ({} as Record<string, number>);
  const memory = kernelComplete
    ? (coldKernel.memory as Record<string, number>)
    : ({} as Record<string, number>);
  const responsiveness = kernelComplete
    ? (coldKernel.responsiveness as Record<string, unknown>)
    : ({} as Record<string, unknown>);
  const incremental = kernelComplete ? (coldKernel.incremental as Record<string, unknown>) : null;
  const complete =
    electron.status === "complete" && warmPersistedIndex.status === "complete" && kernelComplete;
  const result = {
    schemaVersion: 1,
    suite: "threadleaf-performance-acceptance",
    generatedAt: new Date().toISOString(),
    status: complete ? ("complete" as const) : ("aborted" as const),
    runtime: {
      node: process.version,
      electron: (
        JSON.parse(await fs.readFile(path.join(appRoot, "package.json"), "utf8")) as {
          devDependencies?: Record<string, string>;
        }
      ).devDependencies?.electron,
      platform: process.platform,
      arch: process.arch,
      ...(await gitMetadata()),
    },
    corpus: {
      schemaVersion: corpus.manifest.schemaVersion,
      variant: corpus.manifest.variant,
      generatorVersion: corpus.manifest.generatorVersion,
      seed: corpus.manifest.seed,
      manifestHash: corpus.manifest.manifestHash,
      sampleHash: corpus.manifest.sampleHash,
      fileCount: corpus.manifest.fileCount,
      visibleFileCount: corpus.manifest.visibleFileCount,
      hiddenFileCount: corpus.manifest.hiddenFileCount,
      markdownFileCount: corpus.manifest.markdownFileCount,
      ballastFileCount: corpus.manifest.ballastFileCount,
      totalBytes: corpus.manifest.totalBytes,
      depthProfile: corpus.manifest.depthProfile,
      noteSizeDistribution: corpus.manifest.noteSizeDistribution,
      extensionCounts: corpus.manifest.extensionCounts,
    },
    configuration: {
      heavyGate: options.requireHeavyGate ? "primary-flock" : "not-required",
      minimumMemAvailableKiB: performanceAcceptanceMinimumMemAvailableKiB,
      hardTimeoutMs: options.timeoutMs,
      order: [
        "electron-workspace-open",
        "electron-persisted-index-restart",
        "kernel-cold-and-incremental",
      ],
      coldDefinition: "Fresh Node process and empty private state root.",
      warmDefinition:
        "A second Electron process reopens the first launch's user-data profile and persisted derived-index cache.",
      incrementalDefinition:
        "The cold kernel process independently touches, adds, and deletes exactly 100 notes per mutation kind, observes and indexes each delta, then restores the corpus bytes.",
    },
    legs: {
      electronWorkspaceOpen: electron,
      coldKernel,
      warmPersistedIndex,
      incremental: kernelComplete
        ? {
            status: "complete",
            timeoutMs: options.timeoutMs,
            machine: coldKernel.machineAfter,
            values: incremental,
          }
        : {
            status: "aborted",
            timeoutMs: options.timeoutMs,
            machine: coldKernel.machineAfter,
            reason:
              "Cold kernel start did not complete, so its sequential incremental leg could not begin.",
          },
      timeToUsableShell: {
        status: electron.usableShellMs === null ? "aborted" : "complete",
        timeoutMs: options.timeoutMs,
        machine: electron.machine,
        valueMs: electron.usableShellMs,
      },
      backgroundCompletion: {
        status: electron.backgroundCompletionMs === null ? "aborted" : "complete",
        timeoutMs: options.timeoutMs,
        machine: electron.machine,
        valueMs: electron.backgroundCompletionMs,
        kernelReadinessMs: timings.readinessMs ?? null,
      },
      memory: {
        status: kernelComplete ? "complete" : "aborted",
        timeoutMs: options.timeoutMs,
        machine: coldKernel.machineAfter,
        kernelPeakRssBytes: memory.nodePeakRssBytes ?? null,
        kernelSettledRssBytes: memory.nodeSettledRssBytes ?? null,
        electronPeakMainRssBytes: electron.rss.peakMainRssBytes,
        electronPeakRendererRssBytes: electron.rss.peakRendererRssBytes,
      },
      responsiveness: {
        status: kernelComplete ? "complete" : "aborted",
        timeoutMs: options.timeoutMs,
        machine: coldKernel.machineAfter,
        kernel: responsiveness,
        electronSearchProbes: electron.responsivenessProbes,
      },
    },
    limitations: [
      "The corpus is synthetic and the real daily-driver vault is never read.",
      "Cold here means fresh Threadleaf private state and process. The operating-system filesystem cache is intentionally not flushed.",
      "The Electron workspace-open leg uses Linux/Xvfb with GPU disabled and is not a cross-platform desktop SLA.",
      "The warm leg reuses the cold Electron profile and derived-index cache. The operating-system filesystem cache is intentionally not flushed.",
      "Electron RSS is Linux /proc VmRSS for the browser plus descendants. Kernel RSS is Node process RSS, not a JavaScript-heap proof.",
    ],
  };
  await writeResultAtomically(options.outputPath, result);
  process.stdout.write(
    `${JSON.stringify({ status: result.status, outputPath: options.outputPath, manifestHash: corpus.manifest.manifestHash })}\n`,
  );
  if (result.status === "aborted") process.exitCode = 1;
}

if (
  process.argv[1]?.endsWith("performance-acceptance.cjs") ||
  process.argv[1]?.endsWith("performance-acceptance.ts")
) {
  const command = process.argv.includes("--electron-observer") ? runElectronObserverMain() : main();
  command.catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
