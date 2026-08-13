import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const appRoot = process.cwd();
const electronPath = path.join(appRoot, "node_modules", ".bin", "electron");
const fixtureVault = path.join(appRoot, "fixtures", "vaults", "basic");
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-json-canvas-ui-"));
const vaultPath = path.join(testRoot, "vault");
const userDataPath = path.join(testRoot, "user-data");
const screenshotDirectory =
  process.env.THREADLEAF_JSON_CANVAS_SCREENSHOT_DIR ??
  path.join(os.tmpdir(), "threadleaf-json-canvas-screenshots");
const marker = randomUUID();
let child;
let cdp;
let exited;

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
  if (!address || typeof address === "string") throw new Error("Could not reserve CDP port.");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitForTarget(port) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = response.ok ? await response.json() : [];
      const target = targets.find(
        (entry) => entry.type === "page" && entry.url.endsWith("/dist/renderer/index.html"),
      );
      if (target?.webSocketDebuggerUrl) return target;
    } catch {
      // Electron is still booting.
    }
    await delay(50);
  }
  throw new Error("Main renderer did not expose a CDP target.");
}

function connect(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let id = 0;
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP connection failed.")), {
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
  return {
    async send(method, params = {}) {
      await opened;
      const requestId = ++id;
      const result = new Promise((resolve, reject) => pending.set(requestId, { resolve, reject }));
      socket.send(JSON.stringify({ id: requestId, method, params }));
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

async function waitFor(probe, message) {
  const deadline = Date.now() + 10_000;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await delay(50);
  }
  throw new Error(`${message}: ${JSON.stringify(last)}`);
}

async function rendererCommandLines(rootPid) {
  const entries = await fs.readdir("/proc", { withFileTypes: true });
  const rows = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const stat = await fs.readFile(`/proc/${entry.name}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const ppid = Number(stat.slice(close + 2).split(" ")[1]);
      const command = (await fs.readFile(`/proc/${entry.name}/cmdline`))
        .toString("utf8")
        .replaceAll("\0", " ");
      if (command.includes("--type=renderer") && (ppid === rootPid || command.includes("electron")))
        rows.push(command);
    } catch {
      // Process exited during inspection.
    }
  }
  return rows;
}

async function screenshot(name) {
  const result = await cdp.send("Page.captureScreenshot", { format: "png" });
  const bytes = Buffer.from(result.data, "base64");
  assert(bytes.length > 1_000, `${name} screenshot was empty`);
  await fs.mkdir(screenshotDirectory, { recursive: true });
  await fs.writeFile(path.join(screenshotDirectory, `${name}.png`), bytes);
  return bytes.length;
}

async function launch() {
  await fs.cp(fixtureVault, vaultPath, { recursive: true });
  const port = await availablePort();
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
      env: {
        ...process.env,
        ELECTRON_OZONE_PLATFORM_HINT: "x11",
        THREADLEAF_SAFE_PLUGINS: "1",
        THREADLEAF_VAULT_PATH: vaultPath,
        THREADLEAF_JSON_CANVAS_UI_RUN: marker,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  const target = await waitForTarget(port);
  cdp = connect(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1024,
    height: 700,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send("Emulation.setEmulatedMedia", {
    media: "screen",
    features: [{ name: "prefers-color-scheme", value: "light" }],
  });
  return { rootPid: child.pid };
}

async function close() {
  try {
    await evaluate("window.close(); true");
  } catch {
    /* renderer may already be gone */
  }
  cdp?.close();
  await Promise.race([exited, delay(5_000)]);
  if (child?.pid) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already exited */
    }
  }
}

try {
  const { rootPid } = await launch();
  const ready = await waitFor(
    () =>
      evaluate("window.threadleaf.getSnapshot()").then((snapshot) =>
        snapshot?.workspace?.state === "ready" ? snapshot : null,
      ),
    "Workspace did not become ready",
  );
  assert(
    ready.workspace.canvasFiles.some((file) => file.path === "Boards/Overview.canvas"),
    "Canvas fixture was not listed",
  );
  const rendererCommands = await rendererCommandLines(rootPid);
  assert(
    rendererCommands.some(
      (command) => command.includes("--type=renderer") && command.includes("--ozone-platform=x11"),
    ),
    "Renderer argv did not prove explicit X11",
  );

  await evaluate(
    `document.querySelector('[data-canvas-path="Boards/Overview.canvas"]')?.click(); true`,
  );
  await waitFor(
    () =>
      evaluate(
        `document.querySelector('[data-canvas-path="Boards/Overview.canvas"]')?.getAttribute('aria-current') === 'true'`,
      ),
    "Canvas shelf control did not activate",
  );
  await waitFor(
    () =>
      evaluate("window.threadleaf.getSnapshot()").then((snapshot) =>
        snapshot?.workspace?.panes?.[0]?.activeNote === null &&
        snapshot?.workspace?.panes?.[0]?.activeCanvas
          ? snapshot
          : null,
      ),
    "Canvas did not open",
  );
  assert(
    await evaluate(
      "!document.querySelector('#canvas-view')?.hidden && document.querySelectorAll('.canvas-node').length >= 3",
    ),
    "Canvas board was not rendered",
  );
  assert(
    await evaluate(
      "['Add text', 'Add group', 'Add file', 'Add link', 'Connect first two', 'Save'].every((label) => [...document.querySelectorAll('#canvas-view button')].some((button) => button.textContent === label))",
    ),
    "Canvas editing controls were not reachable",
  );
  await screenshot("canvas-light-1024");

  await evaluate("document.querySelector('#theme-toggle')?.click(); true");
  await waitFor(
    () => evaluate("document.documentElement.dataset.theme === 'dark'"),
    "Dark theme did not apply",
  );
  await screenshot("canvas-dark-1024");

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1024,
    height: 700,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await evaluate(
    "document.body.style.zoom = '0.8'; document.body.dataset.jsonCanvasUiProof = 'positive-control'; true",
  );
  assert(
    await evaluate("document.body.dataset.jsonCanvasUiProof === 'positive-control'"),
    "Positive-control marker did not reach the live surface",
  );
  await screenshot("canvas-dark-hidpi-zoom");

  await evaluate("document.querySelector('#split-pane-right')?.click(); true");
  const split = await waitFor(
    () =>
      evaluate("window.threadleaf.getSnapshot()").then((snapshot) =>
        snapshot?.workspace?.panes?.length === 2 ? snapshot : null,
      ),
    "Two-pane split did not complete",
  );
  assert(split.workspace.panes.length === 2, "Canvas two-pane E2E did not produce two panes");
  await screenshot("canvas-two-pane");
  process.stdout.write(
    `${JSON.stringify({
      status: "ok",
      screenshots: screenshotDirectory,
      rendererCommands,
      panes: split.workspace.panes.length,
    })}\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await close();
  await fs.rm(testRoot, { recursive: true, force: true });
}
