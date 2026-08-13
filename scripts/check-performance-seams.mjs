import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
import { cleanupPerformanceRun, markerName } from "./performance-seam-cleanup.mjs";
import {
  assertPerformanceBudgets,
  assertPerformanceCorrectness,
  evaluatePerformanceBudgets,
  performanceBaselineCompatibility,
  performanceSeamSchemaVersion,
  summarizePerformanceMetric,
} from "./performance-seam-logic.mjs";

const appRoot = process.cwd();
const electronPath = path.join(appRoot, "node_modules", ".bin", "electron");
const fixtureVault = path.join(appRoot, "fixtures", "vaults", "basic");
const packageJson = JSON.parse(await fs.readFile(path.join(appRoot, "package.json"), "utf8"));
const baselinePath = path.join(appRoot, "benchmarks", "performance-baseline.json");
const argumentsList = process.argv.slice(2);
const outputLog = [];
const pluginId = "threadleaf-performance-fixture";
const pluginCommandId = "probe";
const imageNotePath = "Performance Images.md";
const editorNotePath = "Performance Input.md";
const imageNames = ["one.png", "two.png", "three.png", "four.png"];
const imageWidth = 256;
const imageHeight = 256;
const editorNoteContent =
  "# Performance input\n\nThis note is replaced only in the disposable benchmark renderer.\n";
const editorNoteDomText = editorNoteContent.replaceAll("\n", "");
const execFileAsync = promisify(execFile);

const warmups = readPositiveIntegerArgument("--warmups", 1, 1);
const samples = readPositiveIntegerArgument("--samples", 5, 1);
const outputPath = readStringArgument("--output", process.env.THREADLEAF_PERFORMANCE_OUTPUT);
const enforceBudgets =
  argumentsList.includes("--enforce-budgets") || process.env.THREADLEAF_PERFORMANCE_ENFORCE === "1";
const maxWaitMs = readPositiveIntegerArgument("--timeout-ms", 15_000, 1_000);
let activeRunCleanup;
let shutdownPromise;

if (process.platform !== "linux") {
  throw new Error(
    "Electron performance seams currently require Linux with Xvfb and explicit X11. Windows and macOS are unsupported until equivalent process, display, and input probes are implemented.",
  );
}
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-performance-seams-"));

for (const [signal, exitCode] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
]) {
  process.on(signal, () => {
    if (shutdownPromise) {
      return;
    }
    shutdownPromise = (async () => {
      try {
        await activeRunCleanup?.();
      } catch (error) {
        process.stderr.write(`Performance seam signal cleanup failed: ${error.message ?? error}\n`);
      } finally {
        await fs.rm(testRoot, { recursive: true, force: true });
        process.exit(exitCode);
      }
    })();
  });
}

function readStringArgument(name, fallback) {
  const index = argumentsList.indexOf(name);
  if (index < 0) {
    return fallback;
  }
  const value = argumentsList[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function readPositiveIntegerArgument(name, fallback, minimum) {
  const raw = readStringArgument(name, undefined);
  const value =
    raw === undefined || !/^\d+$/u.test(raw) ? (raw === undefined ? fallback : NaN) : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}.`);
  }
  return value;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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
      if (predicate(value)) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(40);
  }
  const suffix = lastError ? ` Last error: ${lastError.message ?? lastError}` : "";
  throw new Error(`Timed out waiting for ${description}.${suffix}`);
}

function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let sequence = 0;
  const rejectPending = (message) => {
    for (const request of pending.values()) {
      request.reject(new Error(message));
    }
    pending.clear();
  };
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const request = pending.get(message.id);
    if (!request) {
      return;
    }
    pending.delete(message.id);
    if (message.error) {
      request.reject(new Error(message.error.message));
    } else {
      request.resolve(message.result);
    }
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

async function waitForMainTarget(port) {
  const targets = await waitFor(
    "the main renderer target",
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`);
        if (!response.ok) {
          return [];
        }
        return await response.json();
      } catch {
        return [];
      }
    },
    (targets) =>
      targets.find(
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

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, body) {
  const typeBytes = Buffer.from(type, "ascii");
  const payload = Buffer.concat([typeBytes, body]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(payload), 0);
  return Buffer.concat([length, payload, checksum]);
}

function createPng(width, height, color) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const row = Buffer.alloc(1 + width * 4);
  row[0] = 0;
  for (let x = 0; x < width; x += 1) {
    row.set(color, 1 + x * 4);
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function gitMetadata() {
  const [{ stdout: head }, { stdout: status }] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: appRoot, encoding: "utf8" }),
    execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=normal"], {
      cwd: appRoot,
      encoding: "utf8",
    }),
  ]);
  const gitHead = head.trim();
  assert(/^[0-9a-f]{40}$/u.test(gitHead), `Invalid Git HEAD: ${gitHead}`);
  return { gitHead, gitDirty: status.trim().length > 0 };
}

async function cpuModel() {
  try {
    const contents = await fs.readFile("/proc/cpuinfo", "utf8");
    const line = contents.split("\n").find((candidate) => candidate.startsWith("model name"));
    return line?.split(":", 2)[1]?.trim() ?? os.cpus()[0]?.model ?? "unknown";
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
      if (!parentMatch || !rssMatch) {
        continue;
      }
      entries.push({
        pid,
        parentPid: Number(parentMatch[1]),
        rssBytes: Number(rssMatch[1]) * 1024,
        commandLine: commandBytes.toString("utf8").replaceAll("\0", " ").trim(),
        executable,
      });
    } catch {
      // A short-lived Chromium process may disappear between the two reads.
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
    if (!entry) {
      continue;
    }
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
      `Could not locate the Electron browser executable for debugging port ${port}: ${browserCandidates
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
    browserExecutable: path.basename(browser.executable).replace(/ \(deleted\)$/u, ""),
    rendererPids: renderers.map((entry) => entry.pid),
    rendererCommandLines: renderers.map((entry) => entry.commandLine),
  };
}

async function fixtureData() {
  const vaultPath = path.join(testRoot, "vault");
  await fs.cp(fixtureVault, vaultPath, { recursive: true });
  const imageDirectory = path.join(vaultPath, "images");
  await fs.mkdir(imageDirectory, { recursive: true });
  const colors = [
    [32, 104, 176, 255],
    [224, 128, 32, 255],
    [0, 156, 122, 255],
    [112, 88, 176, 255],
  ];
  let imageBytes = 0;
  for (const [index, name] of imageNames.entries()) {
    const bytes = createPng(imageWidth, imageHeight, colors[index]);
    imageBytes += bytes.length;
    await fs.writeFile(path.join(imageDirectory, name), bytes);
  }
  await fs.writeFile(path.join(vaultPath, editorNotePath), editorNoteContent);
  await fs.writeFile(
    path.join(vaultPath, imageNotePath),
    `# Performance images\n\n${imageNames.map((name) => `![](images/${name})`).join("\n\n")}\n`,
  );
  const pluginDirectory = path.join(vaultPath, ".obsidian", "plugins", pluginId);
  await fs.mkdir(pluginDirectory, { recursive: true });
  const pluginMain = `const { Plugin } = require("obsidian");
module.exports = class PerformanceFixture extends Plugin {
  onload() {
    this.addCommand({ id: "probe", name: "Performance seam probe", callback() {} });
  }
};
`;
  await fs.writeFile(
    path.join(pluginDirectory, "manifest.json"),
    `${JSON.stringify({ id: pluginId, name: "Threadleaf performance fixture", version: "1.0.0", minAppVersion: "0.1.0" }, null, 2)}\n`,
  );
  await fs.writeFile(path.join(pluginDirectory, "main.js"), pluginMain);
  const canonicalVaultPath = await fs.realpath(vaultPath);
  const vaultId = createHash("sha256").update(canonicalVaultPath).digest("hex");
  const pluginBytes = await fs.readFile(path.join(pluginDirectory, "main.js"));
  const pluginSha256 = createHash("sha256").update(pluginBytes).digest("hex");
  return { vaultPath, vaultId, pluginSha256, imageBytes };
}

async function writeInitialSettings(userDataPath, fixture) {
  await fs.mkdir(userDataPath, { recursive: true });
  await fs.writeFile(
    path.join(userDataPath, "settings.json"),
    `${JSON.stringify(
      {
        version: 5,
        keyBindings: {},
        appearanceByVault: {},
        pluginsByVault: {
          [fixture.vaultId]: {
            compatibilityMode: "enabled",
            enabledPluginIds: [],
            capabilityGrantsByPlugin: {
              [pluginId]: {
                bundleSha256: fixture.pluginSha256,
                capabilities: ["workspace-ui"],
              },
            },
          },
        },
        noteWorkflowsByVault: {},
      },
      null,
      2,
    )}\n`,
  );
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

async function waitForShellReady(cdp, startedAt) {
  const result = await waitFor(
    "the renderer shell-ready mark",
    () =>
      evaluate(
        cdp,
        `(() => {
          const mark = performance.getEntriesByName("threadleaf:shell-ready").at(-1);
          return mark ? {
            startTime: mark.startTime,
            timeOrigin: performance.timeOrigin,
            bodyVisible: Boolean(document.body && document.body.getBoundingClientRect().width > 0),
            shellReady: document.documentElement.dataset.threadleafShellReady === "true"
          } : null;
        })()`,
      ),
    (value) => value?.bodyVisible === true && value?.shellReady === true,
  );
  const wallClockMs = result.timeOrigin + result.startTime - startedAt;
  assert(
    Number.isFinite(wallClockMs) && wallClockMs > 0,
    `Invalid shell-ready wall time: ${wallClockMs}`,
  );
  return wallClockMs;
}

async function waitForReady(cdp, fixture) {
  return waitFor(
    "the disposable vault to become ready",
    () => evaluate(cdp, "window.threadleaf.getSnapshot()"),
    (snapshot) =>
      snapshot?.workspace?.state === "ready" &&
      snapshot?.vault?.id === fixture.vaultId &&
      snapshot?.vault?.path === fixture.vaultPath,
  );
}

async function assertIsolatedX11(port) {
  const snapshot = await waitFor(
    "an isolated X11 renderer process",
    () => processSnapshot(port),
    (value) => value.rendererCount >= 1,
  );
  assert(
    snapshot.rendererCommandLines.every((line) => line.includes("--ozone-platform=x11")),
    `A renderer escaped explicit X11: ${JSON.stringify(snapshot.rendererCommandLines)}`,
  );
  assert(
    snapshot.rendererCommandLines.every((line) => !line.includes("--ozone-platform=wayland")),
    "A renderer selected Wayland despite the explicit X11 probe.",
  );
  return snapshot;
}

async function focusEditor(cdp) {
  await evaluate(
    cdp,
    `(() => {
      const content = document.querySelector("#note-editor .cm-content");
      if (!(content instanceof HTMLElement)) return false;
      content.focus();
      return document.activeElement === content;
    })()`,
  );
  await waitFor(
    "the CodeMirror editor focus",
    () => evaluate(cdp, "document.activeElement?.classList.contains('cm-content') === true"),
    Boolean,
  );
}

async function pressKey(cdp, key, code) {
  const virtualKeyCode = key.toUpperCase().charCodeAt(0);
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    code,
    key,
    ...(key.length === 1 ? { text: key, unmodifiedText: key } : {}),
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    code,
    key,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
  });
}

async function resetEditor(cdp) {
  await focusEditor(cdp);
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    modifiers: 2,
    code: "KeyA",
    key: "a",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    modifiers: 2,
    code: "KeyA",
    key: "a",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
  });
  const backspaceKeyCode = 8;
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    code: "Backspace",
    key: "Backspace",
    windowsVirtualKeyCode: backspaceKeyCode,
    nativeVirtualKeyCode: backspaceKeyCode,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    code: "Backspace",
    key: "Backspace",
    windowsVirtualKeyCode: backspaceKeyCode,
    nativeVirtualKeyCode: backspaceKeyCode,
  });
  await waitFor(
    "the disposable editor reset",
    () => evaluate(cdp, "document.querySelector('#note-editor .cm-content')?.textContent === ''"),
    Boolean,
  );
}

async function measureEditorInput(cdp) {
  await evaluate(
    cdp,
    `(() => {
      const content = document.querySelector("#note-editor .cm-content");
      if (!(content instanceof HTMLElement)) throw new Error("CodeMirror content is unavailable.");
      const state = { expected: "", samples: [] };
      content.addEventListener("input", (event) => {
        if (!(event instanceof InputEvent) || event.inputType !== "insertText" || !event.data) return;
        state.expected += event.data;
        const started = performance.now();
        requestAnimationFrame(() => {
          const text = content.textContent ?? "";
          state.samples.push({
            data: event.data,
            durationMs: performance.now() - started,
            committed: text.endsWith(state.expected)
          });
        });
      }, { capture: true });
      window.__threadleafPerformanceInput = state;
      return true;
    })()`,
  );
  await resetEditor(cdp);
  const keys = ["a", "b", "c", "d", "e"];
  const samplesForKeys = [];
  for (const [index, key] of keys.entries()) {
    await pressKey(cdp, key, `Key${key.toUpperCase()}`);
    const sample = await waitFor(
      `editor input sample ${index + 1}`,
      () =>
        evaluate(
          cdp,
          `(() => {
            const samples = window.__threadleafPerformanceInput?.samples ?? [];
            return samples.length > ${index} ? samples[${index}] : null;
          })()`,
        ),
      (value) => value !== null,
    );
    samplesForKeys.push(sample);
  }
  assert(
    samplesForKeys.every((sample, index) => sample.data === keys[index] && sample.committed),
    `Editor input correctness failed: ${JSON.stringify(samplesForKeys)}`,
  );
  return samplesForKeys.map((sample) => sample.durationMs);
}

async function restoreEditor(cdp) {
  await focusEditor(cdp);
  for (let index = 0; index < 6; index += 1) {
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      modifiers: 2,
      code: "KeyZ",
      key: "z",
      windowsVirtualKeyCode: 90,
      nativeVirtualKeyCode: 90,
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers: 2,
      code: "KeyZ",
      key: "z",
      windowsVirtualKeyCode: 90,
      nativeVirtualKeyCode: 90,
    });
  }
  try {
    await waitFor(
      "the editor's original content after undo",
      () => evaluate(cdp, "document.querySelector('#note-editor .cm-content')?.textContent ?? ''"),
      (value) => value === editorNoteDomText,
    );
  } catch (error) {
    const actual = await evaluate(
      cdp,
      "document.querySelector('#note-editor .cm-content')?.textContent ?? ''",
    );
    throw new Error(`${error.message}; actual=${JSON.stringify(actual)}`);
  }
}

async function measureImageDecode(cdp) {
  await evaluate(
    cdp,
    `(async () => {
      const probe = { startedAt: null, observer: null };
      const observeFirstImage = () => {
        const notePath = document.querySelector("#note-path")?.textContent ?? "";
        const reading = document.querySelector("#note-view")?.getAttribute("data-view") === "reading";
        const image = document.querySelector("#note-preview img.preview-local-image");
        if (notePath.includes(${JSON.stringify(imageNotePath)}) && reading && image && !Number.isFinite(probe.startedAt)) {
          probe.startedAt = performance.now();
          probe.observer?.disconnect();
        }
      };
      probe.observer = new MutationObserver(observeFirstImage);
      probe.observer.observe(document.documentElement, { childList: true, subtree: true });
      window.__threadleafImageProbe = probe;
      await window.threadleaf.openNote(${JSON.stringify(imageNotePath)}, "primary", true);
      document.querySelector("#read-view")?.click();
      observeFirstImage();
      return true;
    })()`,
  );
  return waitFor(
    "all bounded image decodes",
    () =>
      evaluate(
        cdp,
        `(async () => {
          const root = document.querySelector("#note-preview");
          const expected = ${JSON.stringify(imageNames)};
          const images = root ? [...root.querySelectorAll("img.preview-local-image")] : [];
          const paths = images.map((image) => image.dataset.threadleafAsset ?? "");
          const probe = window.__threadleafImageProbe ?? (window.__threadleafImageProbe = { startedAt: null });
          const pathsMatch = expected.every((name) => paths.some((candidate) => candidate === name || candidate.endsWith("/" + name)));
          const notePath = document.querySelector("#note-path")?.textContent ?? "";
          const reading = document.querySelector("#note-view")?.getAttribute("data-view") === "reading";
          if (notePath.includes(${JSON.stringify(imageNotePath)}) && reading && images.length === expected.length && pathsMatch && !Number.isFinite(probe.startedAt)) {
            probe.startedAt = performance.now();
            probe.observer?.disconnect();
          }
          if (pathsMatch && images.length === expected.length && !probe.decodeStatus) {
            probe.decodeStatus = "pending";
            let timer;
            probe.decodePromise = Promise.race([
              Promise.all(images.map((image) => image.decode())),
              new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error("image.decode timeout")), 2_000);
              }),
            ])
              .then(() => {
                probe.decodeStatus = "fulfilled";
                probe.decodedAt = performance.now();
              })
              .catch((error) => {
                probe.decodeStatus = "rejected";
                probe.decodeError = error instanceof Error ? error.message : String(error);
              })
              .finally(() => clearTimeout(timer));
          }
          await probe.decodePromise;
          const decoded = images.map((image) => ({
            path: image.dataset.threadleafAsset ?? "",
            width: image.naturalWidth,
            height: image.naturalHeight,
            complete: image.complete,
          }));
          return {
            ready: pathsMatch && probe.decodeStatus === "fulfilled" && Number.isFinite(probe.startedAt) && Number.isFinite(probe.decodedAt) && decoded.length === expected.length && decoded.every((image) => image.width === ${imageWidth} && image.height === ${imageHeight} && image.complete),
            decodeStatus: probe.decodeStatus ?? null,
            decodeError: probe.decodeError ?? null,
            decoded,
            imageCount: images.length,
            placeholders: root?.querySelectorAll(".preview-asset-placeholder").length ?? 0,
            notePath,
            view: document.querySelector("#note-view")?.getAttribute("data-view") ?? "",
            durationMs: Number.isFinite(probe.startedAt) && Number.isFinite(probe.decodedAt) ? probe.decodedAt - probe.startedAt : null,
          };
        })()`,
      ),
    (value) => {
      if (value?.decodeStatus === "rejected") {
        throw new Error(`Image decode rejected: ${value.decodeError ?? "unknown error"}`);
      }
      return value?.ready === true;
    },
  );
}

async function ensureEditorNote(cdp) {
  await evaluate(
    cdp,
    `window.threadleaf.openNote(${JSON.stringify(editorNotePath)}, "primary", true)`,
  );
  await waitFor(
    "the editor note",
    () =>
      evaluate(
        cdp,
        `(() => document.querySelector("#note-path")?.textContent?.includes(${JSON.stringify(editorNotePath)}))()`,
      ),
    Boolean,
  );
  await waitFor(
    "the mounted CodeMirror editor",
    () => evaluate(cdp, "Boolean(document.querySelector('#note-editor .cm-content'))"),
    Boolean,
  );
  await evaluate(cdp, "document.querySelector('#source-view')?.click(); true");
  await focusEditor(cdp);
}

async function measurePluginActivation(cdp, fixture) {
  const value = await evaluate(
    cdp,
    `(async () => {
      const startedAt = performance.now();
      const response = await window.threadleaf.setPluginEnabled(${JSON.stringify(fixture.vaultId)}, ${JSON.stringify(pluginId)}, true);
      const plugin = response.status === "updated" ? (response.snapshot.plugins ?? []).find((candidate) => candidate.id === ${JSON.stringify(pluginId)}) : null;
      const command = response.status === "updated" ? response.snapshot.commands.find((candidate) => candidate.id === ${JSON.stringify(pluginCommandId)}) : null;
      return { status: response.status, durationMs: performance.now() - startedAt, plugin, command };
    })()`,
  );
  assert(value.status === "updated", `Plugin activation returned ${JSON.stringify(value)}`);
  assert(
    value.plugin?.state === "loaded",
    `Plugin activation did not load the fixture: ${JSON.stringify(value)}`,
  );
  assert(
    value.command?.id === pluginCommandId,
    `Plugin command registration was not observed: ${JSON.stringify(value)}`,
  );
  return value.durationMs;
}

async function disablePlugin(cdp, fixture) {
  const value = await evaluate(
    cdp,
    `window.threadleaf.setPluginEnabled(${JSON.stringify(fixture.vaultId)}, ${JSON.stringify(pluginId)}, false)`,
  );
  assert(value.status === "updated", `Plugin disable returned ${JSON.stringify(value)}`);
  assert(
    !(value.snapshot.plugins ?? []).some(
      (candidate) => candidate.id === pluginId && candidate.state === "loaded",
    ),
    `Plugin remained loaded after disable: ${JSON.stringify(value.snapshot.plugins)}`,
  );
}

async function runElectron(fixture, mode, index, userDataPath, resetUserData = false) {
  let child;
  let cdp;
  let exited;
  const runMarker = `${path.basename(testRoot)}-${mode}-${index}-${randomUUID()}`;
  let cleanupPromise;
  const cleanup = () => {
    cleanupPromise ??= cleanupPerformanceRun({
      marker: runMarker,
      profilePaths: mode === "cold" ? [userDataPath] : [],
    });
    return cleanupPromise;
  };
  activeRunCleanup = cleanup;
  const port = await availablePort();
  if (mode === "cold" || resetUserData) {
    await fs.rm(userDataPath, { recursive: true, force: true });
    await writeInitialSettings(userDataPath, fixture);
  }
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
        [markerName]: runMarker,
        ELECTRON_OZONE_PLATFORM_HINT: "x11",
        THREADLEAF_VAULT_PATH: fixture.vaultPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      outputLog.push(String(chunk));
      if (outputLog.length > 100) outputLog.shift();
    });
  }
  try {
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const target = await waitForMainTarget(port);
    cdp = connectCdp(target.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    const firstPaintMs = await waitForShellReady(cdp, startedAt);
    const snapshot = await waitForReady(cdp, fixture);
    const processBefore = await assertIsolatedX11(port);
    const catalog = await evaluate(
      cdp,
      `window.threadleaf.getPlugins(${JSON.stringify(fixture.vaultId)})`,
    );
    const packageSummary =
      catalog.status === "ready"
        ? catalog.catalog.plugins?.find((plugin) => plugin.id === pluginId)
        : undefined;
    assert(
      packageSummary?.packageState === "ready",
      `Performance plugin package was not ready: ${JSON.stringify(packageSummary)}`,
    );
    assert(
      packageSummary.capabilityGrantState === "granted",
      `Performance plugin grant was not accepted: ${JSON.stringify(packageSummary)}`,
    );
    assert(
      !(snapshot.plugins ?? []).some(
        (plugin) => plugin.id === pluginId && plugin.state === "loaded",
      ),
      "Fixture plugin unexpectedly activated during startup.",
    );

    await ensureEditorNote(cdp);
    const editorSamples = await measureEditorInput(cdp);
    await restoreEditor(cdp);
    const imageFirstUse = await measureImageDecode(cdp);
    assert(
      imageFirstUse.ready === true,
      `First-use image decode failed: ${JSON.stringify(imageFirstUse)}`,
    );

    const pluginFirstActivationMs = await measurePluginActivation(cdp, fixture);
    const processAfterPlugin = await processSnapshot(port);
    await disablePlugin(cdp, fixture);
    const processAfter = await processSnapshot(port);
    assert(
      processAfter.mainRssBytes > 0 && processAfter.rendererRssBytes > 0,
      "Memory process samples were unavailable.",
    );
    assert(
      processAfterPlugin.mainRssBytes > 0 && processAfterPlugin.rendererRssBytes > 0,
      "Post-plugin memory process sample was unavailable.",
    );

    await evaluate(cdp, "setTimeout(() => window.close(), 0); true");
    const exit = await Promise.race([
      exited,
      delay(10_000).then(() => ({ code: null, signal: "timeout" })),
    ]);
    assert(exit.code === 0, `Electron did not exit cleanly: ${JSON.stringify(exit)}`);
    return {
      firstPaintMs,
      editorSamples,
      imageFirstUseMs: imageFirstUse.durationMs,
      pluginFirstActivationMs,
      memoryBaseline: processBefore,
      memoryPostPlugin: processAfterPlugin,
      memoryFinal: processAfter,
      imageBytes: fixture.imageBytes,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${mode} run ${index + 1} failed: ${detail}`, { cause: error });
  } finally {
    cdp?.close();
    try {
      await cleanup();
    } finally {
      if (activeRunCleanup === cleanup) {
        activeRunCleanup = undefined;
      }
    }
  }
}

function performanceBudgetRules() {
  return [
    ["electron-first-paint", "cold", 1.5, 2.0],
    ["electron-first-paint", "warm", 1.5, 2.0],
    ["editor-input-to-frame", "cold", 1.75, 2.25],
    ["editor-input-to-frame", "warm", 1.75, 2.25],
    ["plugin-activation", "cold", 1.75, 2.25],
    ["plugin-activation", "warm", 1.75, 2.25],
    ["image-decode", "cold", 2.0, 2.5],
    ["image-decode", "warm", 2.0, 2.5],
    ["main-rss", "baseline", 1.35, 1.5],
    ["renderer-rss", "baseline", 1.5, 1.75],
    ["main-rss", "post-plugin", 1.35, 1.5],
    ["renderer-rss", "post-plugin", 1.5, 1.75],
  ].map(([metric, mode, maxMedianMultiplier, maxTailMultiplier]) => ({
    metric,
    mode,
    maxMedianMultiplier,
    maxTailMultiplier,
    minimumSamples: samples,
  }));
}

async function baselineHash(baseline) {
  return createHash("sha256").update(JSON.stringify(baseline)).digest("hex");
}

async function main() {
  assert(
    await fs
      .stat(electronPath)
      .then((stat) => stat.isFile())
      .catch(() => false),
    "Electron is not installed. Run pnpm install first.",
  );
  const fixture = await fixtureData();
  const coldRuns = [];
  const warmRuns = [];
  const coldUserDataRoot = path.join(testRoot, "cold-user-data");
  const warmUserDataPath = path.join(testRoot, "warm-user-data");
  const warmProfileMarkerPath = path.join(warmUserDataPath, ".threadleaf-performance-profile");
  const warmProfileMarker = randomUUID();
  for (let index = 0; index < warmups; index += 1) {
    await runElectron(fixture, "cold", index, path.join(coldUserDataRoot, `warmup-${index}`));
    if (index > 0) {
      assert(
        (await fs.readFile(warmProfileMarkerPath, "utf8")) === warmProfileMarker,
        "Warm profile continuity was lost between discarded launches.",
      );
    }
    await runElectron(fixture, "warm", index, warmUserDataPath, index === 0);
    if (index === 0) {
      await fs.writeFile(warmProfileMarkerPath, warmProfileMarker);
    }
  }
  for (let index = 0; index < samples; index += 1) {
    coldRuns.push(
      await runElectron(fixture, "cold", index, path.join(coldUserDataRoot, `sample-${index}`)),
    );
  }
  for (let index = 0; index < samples; index += 1) {
    assert(
      (await fs.readFile(warmProfileMarkerPath, "utf8")) === warmProfileMarker,
      "Warm profile continuity was lost before a measured launch.",
    );
    warmRuns.push(await runElectron(fixture, "warm", index, warmUserDataPath));
  }

  const metricDetails = {
    editor: {
      event: "input",
      completion: "next animation frame",
      syntheticInput: "CDP Input.dispatchKeyEvent",
      keyCount: 5,
    },
    images: {
      imageCount: imageNames.length,
      width: imageWidth,
      height: imageHeight,
      fixtureBytes: fixture.imageBytes,
      completion: "HTMLImageElement.complete + natural dimensions after a bounded decode wait",
    },
    plugin: {
      pluginId,
      commandId: pluginCommandId,
      completion: "loaded plugin plus registered command",
    },
    mainMemory: {
      source: "/proc/<pid>/status VmRSS",
      processClasses: "Electron browser process only",
    },
    rendererMemory: {
      source: "/proc/<pid>/status VmRSS",
      processClasses: "Sum of all descendant Electron renderer processes",
    },
  };
  const metrics = [
    summarizePerformanceMetric(
      "electron-first-paint",
      "cold",
      "milliseconds",
      warmups,
      coldRuns.map((run) => run.firstPaintMs),
      {
        event: "threadleaf:shell-ready",
        completion: "initial snapshot render plus the next animation frame",
      },
    ),
    summarizePerformanceMetric(
      "electron-first-paint",
      "warm",
      "milliseconds",
      warmups,
      warmRuns.map((run) => run.firstPaintMs),
      {
        event: "threadleaf:shell-ready",
        completion: "initial snapshot render plus the next animation frame",
      },
    ),
    summarizePerformanceMetric(
      "editor-input-to-frame",
      "cold",
      "milliseconds",
      warmups,
      coldRuns.flatMap((run) => run.editorSamples),
      metricDetails.editor,
    ),
    summarizePerformanceMetric(
      "editor-input-to-frame",
      "warm",
      "milliseconds",
      warmups,
      warmRuns.flatMap((run) => run.editorSamples),
      metricDetails.editor,
    ),
    summarizePerformanceMetric(
      "plugin-activation",
      "cold",
      "milliseconds",
      warmups,
      coldRuns.map((run) => run.pluginFirstActivationMs),
      metricDetails.plugin,
    ),
    summarizePerformanceMetric(
      "plugin-activation",
      "warm",
      "milliseconds",
      warmups,
      warmRuns.map((run) => run.pluginFirstActivationMs),
      metricDetails.plugin,
    ),
    summarizePerformanceMetric(
      "image-decode",
      "cold",
      "milliseconds",
      warmups,
      coldRuns.map((run) => run.imageFirstUseMs),
      metricDetails.images,
    ),
    summarizePerformanceMetric(
      "image-decode",
      "warm",
      "milliseconds",
      warmups,
      warmRuns.map((run) => run.imageFirstUseMs),
      metricDetails.images,
    ),
    summarizePerformanceMetric(
      "main-rss",
      "baseline",
      "bytes",
      warmups,
      coldRuns.map((run) => run.memoryBaseline.mainRssBytes),
      metricDetails.mainMemory,
    ),
    summarizePerformanceMetric(
      "renderer-rss",
      "baseline",
      "bytes",
      warmups,
      coldRuns.map((run) => run.memoryBaseline.rendererRssBytes),
      metricDetails.rendererMemory,
    ),
    summarizePerformanceMetric(
      "main-rss",
      "post-plugin",
      "bytes",
      warmups,
      coldRuns.map((run) => run.memoryPostPlugin.mainRssBytes),
      metricDetails.mainMemory,
    ),
    summarizePerformanceMetric(
      "renderer-rss",
      "post-plugin",
      "bytes",
      warmups,
      coldRuns.map((run) => run.memoryPostPlugin.rendererRssBytes),
      metricDetails.rendererMemory,
    ),
  ];

  const correctness = [
    {
      name: "electron-process-exit",
      status: "pass",
      details:
        "Every measured Electron launch exited with code 0 after the probe closed the window.",
    },
    {
      name: "explicit-x11-renderer",
      status: "pass",
      details:
        "Every observed renderer command line contained --ozone-platform=x11 and no Wayland platform.",
    },
    {
      name: "warm-profile-continuity",
      status: "pass",
      details:
        "Every measured warm launch reused the same marked Electron user-data directory after the configured discarded launches.",
    },
    {
      name: "shell-ready-event",
      status: "pass",
      details:
        "The app-defined shell-ready event was a visible DOM shell after a renderer requestAnimationFrame.",
    },
    {
      name: "editor-input-commit",
      status: "pass",
      details:
        "All five CDP key events produced one input event and committed text by the next animation frame.",
    },
    {
      name: "plugin-activation",
      status: "pass",
      details:
        "The exact fixture plugin reached loaded state and registered its probe command on cold and warm activation.",
    },
    {
      name: "bounded-image-decode",
      status: "pass",
      details: `All ${imageNames.length} sniffed ${imageWidth}x${imageHeight} PNGs decoded with natural dimensions and complete=true.`,
    },
    {
      name: "memory-process-observation",
      status: "pass",
      details:
        "The /proc executable identity was electron, and browser plus descendant renderer VmRSS samples were positive before and after plugin activation.",
    },
  ];
  assertPerformanceCorrectness(correctness);

  const environment = {
    display: "xvfb",
    ozonePlatform: "x11",
    gpuDisabled: true,
    cpuCount: os.cpus().length,
    cpuModel: await cpuModel(),
    kernel: os.release(),
    memoryTotalBytes: await memoryTotalBytes(),
  };
  const currentProfile = {
    schemaVersion: performanceSeamSchemaVersion,
    suite: "electron-performance-seams",
    runtime: { platform: process.platform, arch: process.arch },
    environment,
  };
  let baseline = null;
  try {
    baseline = JSON.parse(await fs.readFile(baselinePath, "utf8"));
  } catch {
    if (enforceBudgets)
      throw new Error(`No checked-in performance baseline is available at ${baselinePath}.`);
  }
  const rules = performanceBudgetRules();
  const compatibility = baseline
    ? performanceBaselineCompatibility(currentProfile, baseline)
    : { compatible: false, mismatches: [] };
  if (baseline && !compatibility.compatible && enforceBudgets) {
    throw new Error(
      `Checked-in performance baseline is not comparable: ${compatibility.mismatches.join(", ")}`,
    );
  }
  const budgetChecks =
    baseline && compatibility.compatible
      ? evaluatePerformanceBudgets(metrics, baseline, rules)
      : rules.map((rule) => ({
          metric: rule.metric,
          mode: rule.mode,
          status: "skipped",
          reason: baseline
            ? `Checked-in baseline is not comparable: ${compatibility.mismatches.join(", ")}.`
            : "No checked-in baseline is available.",
        }));
  if (enforceBudgets) {
    assertPerformanceBudgets(budgetChecks);
  }
  const source = await gitMetadata();
  const result = {
    schemaVersion: performanceSeamSchemaVersion,
    suite: "electron-performance-seams",
    generatedAt: new Date().toISOString(),
    runtime: {
      node: process.version,
      electron: packageJson.devDependencies?.electron ?? "unknown",
      threadleaf: packageJson.version,
      platform: process.platform,
      arch: process.arch,
      ...source,
    },
    environment,
    configuration: {
      warmups,
      samples,
      tailStatistic: "p90",
      coldDefinition:
        "Fresh Electron user-data directory and fresh renderer process for each measured launch; OS filesystem caches are not flushed.",
      warmDefinition:
        "The same marked Electron user-data directory is relaunched after the configured discarded warm launches; renderer and OS cache state remain host-dependent.",
    },
    correctness,
    metrics,
    budgets: {
      evaluated: Boolean(baseline && compatibility.compatible),
      enforced: enforceBudgets,
      baselineHash: baseline ? await baselineHash(baseline) : null,
      checks: budgetChecks,
    },
    limitations: [
      "These are Linux x64 Xvfb observations with Electron GPU disabled, not universal desktop SLAs.",
      "First paint is the app-defined threadleaf:shell-ready marker after the initial renderer snapshot and requestAnimationFrame; it is not a compositor swap timestamp or a human-perceived paint measure.",
      "Editor latency is CDP Input.dispatchKeyEvent to the mounted CodeMirror content's next requestAnimationFrame; it excludes a physical keyboard, OS input stack, and display scanout.",
      "Plugin activation measures the first real setPluginEnabled IPC/lifecycle response after each cold or warm launch for a tiny fixture plugin; it is not representative of every community bundle or workflow.",
      "Image timing measures the first decode after each cold or warm launch, beginning when the image elements are observed in the reading-view DOM and ending after complete natural dimensions plus a bounded HTMLImageElement.decode wait; vault read and IPC time are intentionally separate and not included.",
      "Memory is Linux /proc VmRSS for the Electron browser plus descendant renderer processes. Renderer RSS includes the compatibility plugin renderer after activation and is not a JS heap measurement.",
      "Windows and macOS are explicitly unsupported by this seam until equivalent X11-independent display, input, process, and memory probes exist.",
      "Relative budgets compare against the checked-in same-host profile only. They are opt-in and must not be converted into cross-machine claims.",
    ],
  };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) {
    await fs.writeFile(outputPath, serialized);
  }
  process.stdout.write(serialized);
}

try {
  await main();
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  const logs = outputLog.join("").trim();
  process.stderr.write(logs ? `${detail}\nElectron output:\n${logs}\n` : `${detail}\n`);
  process.exitCode = 1;
} finally {
  await fs.rm(testRoot, { recursive: true, force: true });
}
