import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// This check is intentionally run under an explicit X11 Xvfb command from the
// package script.  It owns a temporary profile and fixture vault, and uses CDP
// only against that isolated renderer.
const appRoot = process.cwd();
const executablePath = path.resolve(
  process.env.THREADLEAF_PACKAGED_EXECUTABLE ??
    path.join(appRoot, "release", "linux-unpacked", "threadleaf"),
);
const screenshotDirectory = process.env.THREADLEAF_ATTACHMENT_SCREENSHOT_DIR;
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-packaged-attachments-"));
const userDataPath = path.join(testRoot, "user-data");
const vaultPath = path.join(testRoot, "attachment-vault");
const notePath = path.join(vaultPath, "Attachment Desk.md");
const originalNote = [
  "# Attachment desk",
  "",
  "![[Assets/report.pdf|Report]]",
  "",
  "![[Assets/audio.mp3|Audio]]",
  "",
  "![[Assets/unknown.bin|Unknown bytes]]",
  "",
  "The body is a fixture and must remain byte-identical.",
].join("\n");
let child;
let cdp;
let exited;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

async function waitForTarget(port, deadline) {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find(
          (candidate) =>
            candidate.type === "page" &&
            typeof candidate.url === "string" &&
            candidate.url.endsWith("/dist/renderer/index.html"),
        );
        if (target?.webSocketDebuggerUrl) return target;
      }
    } catch {
      // The packaged renderer is still starting.
    }
    await delay(50);
  }
  throw new Error("The packaged attachment fixture did not expose its renderer in time.");
}

function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let sequence = 0;
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP WebSocket failed to open.")), {
      once: true,
    });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const request of pending.values()) request.reject(new Error("CDP WebSocket closed."));
    pending.clear();
  });
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

async function evaluate(expression) {
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

async function descendantCommandLines(rootPid) {
  const entries = await fs.readdir("/proc");
  const records = [];
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const status = await fs.readFile(`/proc/${entry}/status`, "utf8");
      const parent = /^PPid:\s+(\d+)/mu.exec(status)?.[1];
      const command = (await fs.readFile(`/proc/${entry}/cmdline`))
        .toString("utf8")
        .replaceAll("\0", " ")
        .trim();
      if (parent && command) records.push({ pid: Number(entry), parent: Number(parent), command });
    } catch {
      // A short-lived Chromium process may disappear during the snapshot.
    }
  }
  const children = new Map();
  for (const record of records) {
    const siblings = children.get(record.parent) ?? [];
    siblings.push(record);
    children.set(record.parent, siblings);
  }
  const result = [];
  const queue = [rootPid];
  const seen = new Set(queue);
  while (queue.length) {
    const parent = queue.shift();
    for (const record of children.get(parent) ?? []) {
      if (seen.has(record.pid)) continue;
      seen.add(record.pid);
      result.push(record.command);
      queue.push(record.pid);
    }
  }
  return result;
}

async function proveRendererX11() {
  const commands = await descendantCommandLines(child.pid);
  const renderers = commands.filter((command) => command.includes("--type=renderer"));
  assert(renderers.length > 0, "No Chromium renderer process was visible for argv verification.");
  assert(
    renderers.some((command) => command.includes("--ozone-platform=x11")),
    `Renderer argv did not prove explicit X11: ${JSON.stringify(renderers)}`,
  );
  assert(
    !renderers.some((command) => command.includes("--ozone-platform=wayland")),
    "A renderer advertised Wayland despite the explicit X11 launch.",
  );
  return renderers;
}

async function waitForFixture(deadline) {
  while (Date.now() < deadline) {
    const state = await evaluate(`(async () => {
      const snapshot = await window.threadleaf.getSnapshot();
      return {
        path: snapshot.workspace?.activeNote?.path ?? '',
        ready: document.querySelectorAll('.preview-attachment-card[data-threadleaf-attachment-status="ready"]').length,
        pending: document.querySelectorAll('.preview-attachment-placeholder').length,
        mode: snapshot.vault?.mode ?? '',
      };
    })()`);
    if (state.path === "Attachment Desk.md" && state.ready === 3 && state.pending === 0)
      return state;
    await delay(50);
  }
  throw new Error("The packaged attachment cards did not hydrate in time.");
}

async function waitForReady(deadline) {
  while (Date.now() < deadline) {
    const state = await evaluate(`(async () => ({
      runtime: document.querySelector('#runtime-state')?.textContent ?? '',
      snapshot: await window.threadleaf.getSnapshot(),
    }))()`);
    if (state.runtime === "Ready" && state.snapshot?.workspace?.state === "ready") return state;
    await delay(50);
  }
  throw new Error("The packaged attachment fixture did not reach Ready.");
}

async function setTheme(theme) {
  const current = await evaluate("document.documentElement.dataset.theme");
  if (current !== theme) {
    await evaluate("document.querySelector('#theme-toggle')?.click(); true");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if ((await evaluate("document.documentElement.dataset.theme")) === theme) break;
      await delay(30);
    }
    assert(
      (await evaluate("document.documentElement.dataset.theme")) === theme,
      `The packaged application did not switch to ${theme} mode.`,
    );
  }
}

async function capture(name) {
  const screenshot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  const destination = path.join(screenshotDirectory, name);
  await fs.writeFile(destination, Buffer.from(screenshot.data, "base64"));
  return destination;
}

try {
  assert(process.platform === "linux", "The packaged attachment check currently requires Linux.");
  await fs.access(executablePath);
  await fs.mkdir(path.join(vaultPath, ".obsidian"), { recursive: true });
  await fs.mkdir(path.join(vaultPath, "Assets"), { recursive: true });
  await fs.mkdir(userDataPath, { recursive: true });
  await fs.writeFile(notePath, originalNote, "utf8");
  await fs.writeFile(
    path.join(vaultPath, "Assets", "report.pdf"),
    Buffer.from("%PDF-1.7\nfixture\0", "binary"),
  );
  await fs.writeFile(
    path.join(vaultPath, "Assets", "audio.mp3"),
    Buffer.from("ID3\x04\0\0fixture", "binary"),
  );
  await fs.writeFile(
    path.join(vaultPath, "Assets", "unknown.bin"),
    Buffer.from([0xff, 0x00, 0x91, 0x22, 0x00]),
  );
  await fs.writeFile(
    path.join(userDataPath, "workspace-selection.json"),
    `${JSON.stringify({ version: 1, vaultPath }, null, 2)}\n`,
    "utf8",
  );

  const port = await availablePort();
  child = spawn(
    executablePath,
    [
      "--ozone-platform=x11",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataPath}`,
      "--disable-gpu",
    ],
    {
      cwd: appRoot,
      env: { ...process.env, ELECTRON_OZONE_PLATFORM_HINT: "x11" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  const output = [];
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      output.push(String(chunk));
      if (output.length > 100) output.shift();
    });
  }

  const deadline = Date.now() + 15_000;
  const target = await waitForTarget(port, deadline);
  cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  const renderers = await proveRendererX11();
  const initial = await waitForReady(deadline);
  assert(
    initial.snapshot.vault.path === vaultPath,
    "The packaged attachment fixture opened the wrong vault.",
  );
  assert(
    initial.snapshot.vault.mode === "kernel-backed",
    "The attachment fixture is not writable.",
  );

  await evaluate("document.querySelector('#read-view')?.click(); true");
  await waitForFixture(deadline);
  const cardState =
    await evaluate(`(() => [...document.querySelectorAll('.preview-attachment-card')].map((card) => ({
    text: card.textContent ?? '',
    path: card.getAttribute('data-threadleaf-attachment-path') ?? '',
    actionCount: card.querySelectorAll('.preview-attachment-action').length,
  })))()`);
  assert(
    cardState.length === 3 && cardState.every((card) => card.actionCount === 2),
    "Attachment cards lost open/reveal metadata.",
  );
  assert(
    cardState.some((card) => card.text.includes("unsupported")),
    "The unsupported binary did not retain a safe metadata card.",
  );
  assert(
    (await evaluate(
      "document.querySelectorAll('.preview-attachment-card img, .preview-attachment-card iframe, .preview-attachment-card video, .preview-attachment-card audio').length",
    )) === 0,
    "The attachment card exposed an inline executable/media element.",
  );
  assert(
    (await fs.readFile(notePath, "utf8")) === originalNote,
    "Reading view changed fixture Markdown bytes.",
  );
  assert(
    (await fs.readFile(path.join(vaultPath, "Assets", "report.pdf"))).equals(
      Buffer.from("%PDF-1.7\nfixture\0", "binary"),
    ),
    "Attachment bytes changed during metadata loading.",
  );

  const screenshots = [];
  if (screenshotDirectory) {
    await fs.mkdir(screenshotDirectory, { recursive: true });
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1180,
      height: 820,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await evaluate(
      "document.querySelector('.preview-attachment-card')?.scrollIntoView({ block: 'center' }); true",
    );
    await delay(120);
    await setTheme("dark");
    screenshots.push(await capture("packaged-attachments-dark.png"));
    const positive = await evaluate(`(() => {
      const card = document.querySelector('.preview-attachment-card');
      if (!(card instanceof HTMLElement)) return false;
      card.style.outline = '12px solid rgb(255, 0, 255)';
      card.style.outlineOffset = '-12px';
      return getComputedStyle(card).outlineColor === 'rgb(255, 0, 255)';
    })()`);
    assert(positive, "The attachment visual positive control did not reach a card.");
    screenshots.push(await capture("packaged-attachments-positive-control.png"));
    await evaluate(
      "document.querySelector('.preview-attachment-card')?.style.removeProperty('outline'); document.querySelector('.preview-attachment-card')?.style.removeProperty('outline-offset'); true",
    );
    await setTheme("light");
    screenshots.push(await capture("packaged-attachments-light.png"));
  }

  await evaluate("setTimeout(() => window.close(), 0); true");
  const exit = await Promise.race([
    exited,
    delay(10_000).then(() => ({ code: null, signal: "timeout" })),
  ]);
  assert(
    exit.code === 0,
    `Packaged attachment application did not exit cleanly: ${JSON.stringify(exit)}`,
  );
  console.log(
    JSON.stringify({ executablePath, vaultPath, renderers, exactBytes: true, screenshots }),
  );
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  throw new Error(detail, { cause: error });
} finally {
  cdp?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    if (exited) await Promise.race([exited, delay(2_000)]);
  }
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    if (exited) await Promise.race([exited, delay(2_000)]);
  }
  await fs.rm(testRoot, { recursive: true, force: true });
}
