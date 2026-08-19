import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const appRoot = process.cwd();
const electronPath = path.join(appRoot, "node_modules", ".bin", "electron");
const fixtureVault = path.join(appRoot, "fixtures", "vaults", "basic");
const fixturePlugin = path.join(
  appRoot,
  "fixtures",
  "plugin-packages",
  "threadleaf-workspace-docks-fixture",
);
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-workspace-docks-"));
const vaultPath = path.join(testRoot, "vault-one");
const secondVaultPath = path.join(testRoot, "vault-two");
const pickerLink = path.join(testRoot, "picker-target");
const userDataPath = path.join(testRoot, "user-data");
const screenshotDirectory = process.env.THREADLEAF_WORKSPACE_DOCKS_SCREENSHOT_DIR;
const processMarker = randomUUID();
const output = [];
let child;
let exited;
let cdp;
let phase = "setup";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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

async function markedProcessIds() {
  const marker = Buffer.from(`THREADLEAF_WORKSPACE_DOCKS_RUN=${processMarker}\0`);
  const entries = await fs.readdir("/proc");
  const matches = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const environment = await fs.readFile(`/proc/${entry}/environ`);
      if (environment.includes(marker)) matches.push(Number.parseInt(entry, 10));
    } catch {
      // The process can exit between enumeration and the read.
    }
  }
  return matches;
}

async function isolatedElectronMainProcessId() {
  assert(child, "The isolated application is not running.");
  const candidates = (await descendantProcesses(child.pid))
    .filter(
      (process) =>
        process.commandLine.includes("/electron/dist/electron ") &&
        !process.commandLine.includes("--type="),
    )
    .map((process) => process.pid);
  assert(candidates.length <= 1, `Found multiple marked Electron main processes: ${candidates}`);
  return candidates[0] ?? null;
}

async function terminateMarkedProcesses() {
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const pids = await markedProcessIds();
      if (pids.length === 0) return;
      for (const pid of pids) {
        try {
          process.kill(pid, signal);
        } catch {
          // The process already exited.
        }
      }
      await delay(100);
    }
  }
  const remaining = await markedProcessIds();
  assert(remaining.length === 0, `Could not stop test processes: ${remaining.join(", ")}`);
}

async function makeTestTreeRemovable(rootPath) {
  let stat;
  try {
    stat = await fs.lstat(rootPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) {
    await fs.chmod(rootPath, 0o600);
    return;
  }
  await fs.chmod(rootPath, 0o700);
  for (const name of await fs.readdir(rootPath)) {
    await makeTestTreeRemovable(path.join(rootPath, name));
  }
}

async function waitFor(probe, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await delay(50);
  }
  throw new Error(`${message}. Last observation: ${JSON.stringify(last)}`);
}

async function setTheme(expected) {
  if ((await evaluate("document.documentElement.dataset.theme")) !== expected) {
    await clickSelector("#theme-toggle");
  }
  await waitFor(
    async () =>
      (await evaluate("document.documentElement.dataset.theme")) === expected ? true : null,
    `The ${expected} scheme did not apply`,
  );
}

async function waitForMainTarget(port) {
  return waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (!response.ok) return null;
      const targets = await response.json();
      return targets.find(
        (target) =>
          target.type === "page" &&
          typeof target.url === "string" &&
          target.url.endsWith("/dist/renderer/index.html") &&
          target.webSocketDebuggerUrl,
      );
    } catch {
      return null;
    }
  }, "Threadleaf did not expose its main renderer in time");
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

async function targets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  return response.json();
}

async function launchApplication(environment = {}) {
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
      "--password-store=basic",
      ".",
    ],
    {
      cwd: appRoot,
      env: {
        ...process.env,
        ELECTRON_OZONE_PLATFORM_HINT: "x11",
        THREADLEAF_VAULT_PATH: vaultPath,
        THREADLEAF_TEST_PICKER_PATH: pickerLink,
        THREADLEAF_WORKSPACE_DOCKS_RUN: processMarker,
        ...environment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const started = new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      output.push(String(chunk));
      if (output.length > 160) output.shift();
    });
  }
  await started;
  const target = await waitForMainTarget(port);
  cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  return port;
}

async function descendantProcesses(rootPid) {
  const entries = await fs.readdir("/proc", { withFileTypes: true });
  const processes = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const [status, commandLine] = await Promise.all([
        fs.readFile(path.join("/proc", entry.name, "status"), "utf8"),
        fs.readFile(path.join("/proc", entry.name, "cmdline")),
      ]);
      processes.push({
        pid: Number(entry.name),
        parent: Number(/^PPid:\s+(\d+)$/m.exec(status)?.[1] ?? -1),
        commandLine: commandLine.toString("utf8").replaceAll("\0", " "),
      });
    } catch {
      // A short-lived process disappeared between metadata reads.
    }
  }
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes) {
      if (!descendants.has(process.pid) && descendants.has(process.parent)) {
        descendants.add(process.pid);
        changed = true;
      }
    }
  }
  return processes.filter((process) => descendants.has(process.pid));
}

async function descendantRendererProcesses(rootPid) {
  return (await descendantProcesses(rootPid)).filter((process) =>
    process.commandLine.includes("--type=renderer"),
  );
}

async function descendantRendererCommandLines(rootPid) {
  return (await descendantRendererProcesses(rootPid)).map((process) => process.commandLine);
}

async function assertIsolatedX11Renderer() {
  const lines = await waitFor(async () => {
    const commandLines = await descendantRendererCommandLines(child.pid);
    return commandLines.length > 0 ? commandLines : null;
  }, "The isolated launch did not expose a renderer process");
  assert(
    lines.every((line) => line.includes("--ozone-platform=x11")),
    "A renderer escaped X11.",
  );
  assert(
    lines.every((line) => !line.includes("--ozone-platform=wayland")),
    "A renderer selected Wayland instead of X11.",
  );
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

async function snapshot() {
  return evaluate("window.threadleaf.getSnapshot()");
}

async function waitForReady(expectedPath = vaultPath, minimumFiles = 4) {
  const current = await waitFor(async () => {
    const current = await snapshot();
    return current?.workspace?.state === "ready" &&
      current?.vault?.path === expectedPath &&
      current.workspace.files.length >= minimumFiles
      ? current
      : null;
  }, `Vault did not become ready: ${expectedPath}`);
  await ensureFlatNavigator();
  return current;
}

// This suite verifies dock and pop-out behavior. It deliberately uses the
// legacy flat-list fixture, while check-navigator-tree covers the tree mode.
async function ensureFlatNavigator() {
  const mode = await waitFor(async () => {
    const value = await evaluate('document.querySelector("#file-list")?.dataset.mode ?? null');
    return value === "tree" || value === "virtual" ? value : null;
  }, "The navigator did not render before dock checks");
  if (mode === "tree") {
    const toggleVisible = await evaluate(`(() => {
      const toggle = document.querySelector("#navigator-view-toggle");
      if (!(toggle instanceof HTMLElement)) return false;
      const style = getComputedStyle(toggle);
      const bounds = toggle.getBoundingClientRect();
      return !toggle.hidden && style.display !== "none" && style.visibility !== "hidden" && bounds.width > 0;
    })()`);
    // A deliberately collapsed left dock has no file-picker interaction to
    // exercise during pop-out recovery, so it cannot select either mode.
    if (!toggleVisible) return;
    await clickSelector("#navigator-view-toggle");
  }
  await waitFor(
    async () =>
      (await evaluate('document.querySelector("#file-list")?.dataset.mode')) === "virtual"
        ? true
        : null,
    "The dock fixture could not select the flat navigator",
  );
}

async function targetCenter(selector) {
  const scrolled = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return false;
    element.scrollIntoView({ block: "center", inline: "center" });
    return true;
  })()`);
  assert(scrolled, `Pointer target is unavailable: ${selector}`);
  await delay(50);
  const target = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return { error: "missing" };
    const root = element.closest("button, [role=button]") ?? element;
    const rect = root.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const style = getComputedStyle(root);
    return {
      error: null,
      disabled: root instanceof HTMLButtonElement && root.disabled,
      hidden: root.hidden || style.display === "none" || style.visibility === "hidden",
      hit: Boolean(hit && (hit === root || root.contains(hit))),
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      width: rect.width,
      height: rect.height,
    };
  })()`);
  assert(target && !target.error, `Pointer target is unavailable: ${selector}`);
  assert(!target.disabled, `Pointer target is disabled: ${selector}`);
  assert(
    !target.hidden && target.width > 0 && target.height > 0,
    `Pointer target is hidden: ${selector}`,
  );
  assert(target.hit, `Pointer target is covered: ${selector}`);
  return target;
}

async function clickSelector(selector) {
  const target = await targetCenter(selector);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await cdp.send("Input.dispatchMouseEvent", {
      type,
      button: type === "mouseMoved" ? "none" : "left",
      buttons: type === "mousePressed" ? 1 : 0,
      clickCount: type === "mouseMoved" ? 0 : 1,
      x: target.x,
      y: target.y,
    });
  }
}

async function pressKey(key, code, modifiers = 0) {
  const windowsVirtualKeyCode =
    key.length === 1
      ? key.toUpperCase().charCodeAt(0)
      : { Enter: 13, ArrowLeft: 37, ArrowRight: 39 }[key];
  await cdp.send("Input.dispatchKeyEvent", {
    type: key.length === 1 ? "keyDown" : "rawKeyDown",
    code,
    key,
    modifiers,
    windowsVirtualKeyCode,
    nativeVirtualKeyCode: windowsVirtualKeyCode,
    text: key.length === 1 ? key : undefined,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    code,
    key,
    modifiers,
    windowsVirtualKeyCode,
    nativeVirtualKeyCode: windowsVirtualKeyCode,
  });
}

async function captureScreenshot(name) {
  const result = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  if (screenshotDirectory) {
    await fs.mkdir(screenshotDirectory, { recursive: true });
    await fs.writeFile(path.join(screenshotDirectory, `${name}.png`), result.data, "base64");
  }
  return result.data;
}

async function evaluateTarget(target, expression) {
  assert(target?.webSocketDebuggerUrl, "The requested CDP target is unavailable.");
  const connection = connectCdp(target.webSocketDebuggerUrl);
  try {
    await connection.send("Runtime.enable");
    const response = await connection.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ?? "Target evaluation failed.",
      );
    }
    return response.result?.value;
  } finally {
    connection.close();
  }
}

async function captureTargetScreenshot(target, name) {
  assert(target?.webSocketDebuggerUrl, "The requested screenshot target is unavailable.");
  const connection = connectCdp(target.webSocketDebuggerUrl);
  try {
    await connection.send("Page.enable");
    const result = await connection.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
    });
    if (screenshotDirectory) {
      await fs.mkdir(screenshotDirectory, { recursive: true });
      await fs.writeFile(path.join(screenshotDirectory, `${name}.png`), result.data, "base64");
    }
    return result.data;
  } finally {
    connection.close();
  }
}

async function closeTarget(target) {
  assert(target?.webSocketDebuggerUrl, "The requested close target is unavailable.");
  const connection = connectCdp(target.webSocketDebuggerUrl);
  try {
    await connection.send("Page.enable");
    const closeRequest = connection.send("Page.close").catch(() => undefined);
    await Promise.race([closeRequest, delay(500)]);
  } finally {
    connection.close();
  }
}

async function closeApplication() {
  if (!child) return;
  try {
    await evaluate("setTimeout(() => window.close(), 50); true");
  } catch {
    // The renderer can disappear before the response returns.
  }
  cdp?.close();
  cdp = undefined;
  const result = exited
    ? await Promise.race([exited, delay(5_000).then(() => ({ code: null, signal: "timeout" }))])
    : { code: null, signal: "missing" };
  if (result.code !== 0) await terminateMarkedProcesses();
  child = undefined;
  exited = undefined;
}

async function crashApplication() {
  assert(child, "No Threadleaf process is available for crash recovery testing.");
  cdp?.close();
  cdp = undefined;
  const previousExit = exited;
  const pids = await markedProcessIds();
  assert(pids.length > 0, "The marked Threadleaf process tree disappeared before the crash.");
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // A child can exit after its marked process identity is captured.
    }
  }
  await waitFor(
    async () => ((await markedProcessIds()).length === 0 ? true : null),
    "The crashed Threadleaf process tree did not exit",
    5_000,
  );
  if (previousExit) {
    await Promise.race([previousExit, delay(1_000)]);
  }
  child = undefined;
  exited = undefined;
}

async function waitForTabOrder(expected) {
  try {
    return await waitFor(
      async () => {
        const current = await snapshot();
        const tabs = current.workspace?.panes.find((pane) => pane.id === "primary")?.tabs ?? [];
        const actual = tabs.map((tab) => ({ path: tab.path, pinned: tab.pinned }));
        return JSON.stringify(actual) === JSON.stringify(expected) ? current : null;
      },
      `Tabs did not reach ${JSON.stringify(expected)}`,
    );
  } catch (error) {
    const current = await snapshot().catch(() => null);
    const actual = current?.workspace?.panes.find((pane) => pane.id === "primary")?.tabs ?? [];
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; actual=${JSON.stringify(actual)}`,
    );
  }
}

async function mainTargets(port) {
  return (await targets(port)).filter((target) => target.type === "page");
}

try {
  if (process.platform !== "linux") {
    throw new Error("The workspace-docks integration check requires Linux and Xvfb.");
  }
  await fs.access(electronPath);
  await fs.cp(fixtureVault, vaultPath, { recursive: true });
  await fs.cp(fixtureVault, secondVaultPath, { recursive: true });
  await fs.writeFile(path.join(vaultPath, "Third Note.md"), "# Third Note\n\nDrag target.\n");
  await fs.writeFile(
    path.join(vaultPath, "Drawing.excalidraw.md"),
    "# Drawing\n\nPop-out target.\n",
  );
  const pluginsPath = path.join(vaultPath, ".obsidian", "plugins");
  await fs.rm(pluginsPath, { recursive: true, force: true });
  await fs.mkdir(pluginsPath, { recursive: true });
  await fs.cp(fixturePlugin, path.join(pluginsPath, "threadleaf-workspace-docks-fixture"), {
    recursive: true,
  });
  await fs.mkdir(userDataPath, { recursive: true });
  await fs.symlink(vaultPath, pickerLink);
  const canonicalVaultPath = await fs.realpath(vaultPath);
  const vaultId = createHash("sha256").update(canonicalVaultPath).digest("hex");
  const fixtureBundle = await fs.readFile(
    path.join(pluginsPath, "threadleaf-workspace-docks-fixture", "main.js"),
  );
  await fs.writeFile(
    path.join(userDataPath, "settings.json"),
    `${JSON.stringify(
      {
        version: 5,
        keyBindings: {},
        appearanceByVault: {},
        pluginsByVault: {
          [vaultId]: {
            compatibilityMode: "enabled",
            enabledPluginIds: ["threadleaf-workspace-docks-fixture"],
            capabilityGrantsByPlugin: {
              "threadleaf-workspace-docks-fixture": {
                bundleSha256: createHash("sha256").update(fixtureBundle).digest("hex"),
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

  phase = "isolated X11 launch";
  let port = await launchApplication();
  const initial = await waitForReady();
  await assertIsolatedX11Renderer();
  const authorityReview = await evaluate(
    `window.threadleaf.setPluginCapabilityGrant(${JSON.stringify(initial.vault.id)}, "threadleaf-workspace-docks-fixture", ${JSON.stringify(createHash("sha256").update(fixtureBundle).digest("hex"))}, true)`,
  );
  assert(
    authorityReview?.status === "updated",
    `The reviewed workspace fixture could not be enabled: ${JSON.stringify(authorityReview)}`,
  );
  await waitFor(
    async () => ((await snapshot()).integrations?.viewTypes.includes("excalidraw") ? true : null),
    "The reviewed workspace fixture did not register",
  );

  phase = "keyboard tab movement and pointer cancellation";
  await clickSelector('[data-note-path="Welcome.md"]');
  await waitForTabOrder([
    { path: "Drawing.excalidraw.md", pinned: false },
    { path: "Welcome.md", pinned: false },
  ]);
  await clickSelector('[data-note-path="Third Note.md"]');
  await waitForTabOrder([
    { path: "Drawing.excalidraw.md", pinned: false },
    { path: "Welcome.md", pinned: false },
    { path: "Third Note.md", pinned: false },
  ]);
  await evaluate(
    'document.querySelector(".note-tab-activate[data-note-path=\\"Third Note.md\\"]")?.focus(); true',
  );
  await pressKey("ArrowLeft", "ArrowLeft", 1);
  await waitForTabOrder([
    { path: "Drawing.excalidraw.md", pinned: false },
    { path: "Third Note.md", pinned: false },
    { path: "Welcome.md", pinned: false },
  ]);
  await evaluate(
    'document.querySelector(".note-tab-pin[data-note-path=\\"Welcome.md\\"]")?.click(); true',
  );
  await waitForTabOrder([
    { path: "Welcome.md", pinned: true },
    { path: "Drawing.excalidraw.md", pinned: false },
    { path: "Third Note.md", pinned: false },
  ]);
  await evaluate(
    'document.querySelector(".note-tab-activate[data-note-path=\\"Third Note.md\\"]")?.focus(); true',
  );
  await pressKey("ArrowLeft", "ArrowLeft", 1);
  await waitForTabOrder([
    { path: "Welcome.md", pinned: true },
    { path: "Third Note.md", pinned: false },
    { path: "Drawing.excalidraw.md", pinned: false },
  ]);
  await delay(250);
  const beforeCancel = await snapshot();
  const third = await targetCenter('.note-tab-activate[data-note-path="Third Note.md"]');
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    buttons: 1,
    clickCount: 1,
    x: third.x,
    y: third.y,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    button: "none",
    buttons: 1,
    x: third.x + 80,
    y: third.y + 200,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    buttons: 0,
    clickCount: 1,
    x: third.x + 80,
    y: third.y + 200,
  });
  await waitForTabOrder([
    { path: "Welcome.md", pinned: true },
    { path: "Third Note.md", pinned: false },
    { path: "Drawing.excalidraw.md", pinned: false },
  ]);
  assert(
    (await snapshot()).workspace.panes[0].tabs.length ===
      beforeCancel.workspace.panes[0].tabs.length,
    "A cancelled drag lost a tab.",
  );

  phase = "keyboard and pointer pane transfer";
  const transferSnapshot = await snapshot();
  await evaluate(
    `(async () => window.threadleaf.splitWorkspace("vertical", ${JSON.stringify(transferSnapshot.vault.id)}))()`,
  );
  await waitFor(
    async () => ((await snapshot()).workspace?.panes.length === 2 ? true : null),
    "Workspace did not split for pane transfer",
  );
  await evaluate(
    `(async () => window.threadleaf.focusWorkspacePane("primary", ${JSON.stringify(transferSnapshot.vault.id)}))()`,
  );
  await waitFor(
    async () => ((await snapshot()).workspace?.activePaneId === "primary" ? true : null),
    "Primary pane did not become active for keyboard transfer",
  );
  await evaluate(
    'document.querySelector("#note-tabs .note-tab-activate[data-note-path=\\"Drawing.excalidraw.md\\"]")?.focus(); true',
  );
  await pressKey("ArrowRight", "ArrowRight", 9);
  await waitFor(async () => {
    const current = await snapshot();
    const primary = current.workspace?.panes.find((pane) => pane.id === "primary");
    const secondary = current.workspace?.panes.find((pane) => pane.id === "secondary");
    return primary?.tabs.some((tab) => tab.path === "Drawing.excalidraw.md") === false &&
      secondary?.tabs.some((tab) => tab.path === "Drawing.excalidraw.md") === true
      ? true
      : null;
  }, "Alt+Shift+Arrow did not transfer the tab to the other pane");
  await delay(300);
  const transferSource = await targetCenter(
    '#note-tabs-secondary .note-tab-activate[data-note-path="Drawing.excalidraw.md"]',
  );
  const transferTarget = await targetCenter(
    '#note-tabs .note-tab-activate[data-note-path="Third Note.md"]',
  );
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    buttons: 1,
    clickCount: 1,
    x: transferSource.x,
    y: transferSource.y,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    button: "none",
    buttons: 1,
    x: transferTarget.x,
    y: transferTarget.y,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    buttons: 0,
    clickCount: 1,
    x: transferTarget.x,
    y: transferTarget.y,
  });
  try {
    await waitFor(async () => {
      const current = await snapshot();
      const primary = current.workspace?.panes.find((pane) => pane.id === "primary");
      const secondary = current.workspace?.panes.find((pane) => pane.id === "secondary");
      return primary?.tabs.some((tab) => tab.path === "Drawing.excalidraw.md") === true &&
        secondary?.tabs.some((tab) => tab.path === "Drawing.excalidraw.md") === false
        ? true
        : null;
    }, "Pointer drag did not transfer the tab back to the primary pane");
  } catch (error) {
    const current = await snapshot().catch(() => null);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; panes=${JSON.stringify(current?.workspace?.panes)}`,
    );
  }
  await delay(300);

  phase = "keyboard dock collapse and visual schemes";
  await setTheme("dark");
  await captureScreenshot("workspace-docks-expanded-dark");
  await evaluate('document.querySelector("#collapse-left-dock")?.focus(); true');
  await pressKey("Enter", "Enter");
  await delay(300);
  await waitFor(
    async () =>
      (await evaluate('document.querySelector("#workspace-root")?.dataset.leftDockCollapsed')) ===
      "true"
        ? true
        : null,
    "Left dock did not collapse",
  );
  await evaluate('document.querySelector("#collapse-right-dock")?.focus(); true');
  await pressKey("Enter", "Enter");
  await delay(300);
  await waitFor(
    async () =>
      (await evaluate('document.querySelector("#workspace-root")?.dataset.rightDockCollapsed')) ===
      "true"
        ? true
        : null,
    "Right dock did not collapse",
  );
  const dark = await captureScreenshot("workspace-docks-dark");
  const positiveControl = await evaluate(`(() => {
    const element = document.querySelector("#workspace-root");
    if (!(element instanceof HTMLElement)) return false;
    element.style.outline = "12px solid rgb(230, 159, 0)";
    element.style.outlineOffset = "-12px";
    return getComputedStyle(element).outlineWidth === "12px";
  })()`);
  assert(positiveControl, "The screenshot positive control did not reach the workspace.");
  const positive = await captureScreenshot("workspace-docks-positive-control");
  assert(positive !== dark, "The screenshot positive control changed no pixels.");
  await evaluate(`(() => {
    const element = document.querySelector("#workspace-root");
    if (!(element instanceof HTMLElement)) return false;
    element.style.removeProperty("outline");
    element.style.removeProperty("outline-offset");
    return true;
  })()`);
  await setTheme("light");
  await captureScreenshot("workspace-docks-light");

  phase = "native plugin pop-out close and renderer crash recovery";
  await clickSelector('.note-tab-activate[data-note-path="Drawing.excalidraw.md"]');
  await waitFor(
    async () =>
      (await evaluate('document.querySelector("#note-path")?.textContent')) ===
      "Drawing.excalidraw.md"
        ? true
        : null,
    "Drawing tab did not become active",
  );
  let pluginRegistrationSnapshot;
  try {
    await waitFor(async () => {
      const current = await snapshot();
      pluginRegistrationSnapshot = current;
      return current.integrations?.viewTypes.includes("excalidraw") ? true : null;
    }, "Supported plugin view did not register");
  } catch (error) {
    const pluginCatalog = pluginRegistrationSnapshot?.vault?.id
      ? await evaluate(
          `(async () => window.threadleaf.getPlugins(${JSON.stringify(pluginRegistrationSnapshot.vault.id)}))()`,
        ).catch(() => null)
      : null;
    const pluginDirectories = await fs
      .readdir(path.join(vaultPath, ".obsidian", "plugins"))
      .catch(() => []);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; observed=${JSON.stringify({ vault: pluginRegistrationSnapshot?.vault, startup: pluginRegistrationSnapshot?.startup, workspaceLayout: pluginRegistrationSnapshot?.workspaceLayout, plugins: pluginRegistrationSnapshot?.plugins, integrations: pluginRegistrationSnapshot?.integrations, notices: pluginRegistrationSnapshot?.notices, events: pluginRegistrationSnapshot?.events, toast: await evaluate('document.querySelector("#toast")?.textContent ?? null'), pluginDirectories, pluginCatalog })}`,
      { cause: error },
    );
  }
  await clickSelector("#plugin-view");
  await waitFor(
    async () => ((await snapshot()).pluginSurface?.viewType === "excalidraw" ? true : null),
    "Plugin view did not open",
  );
  assert(
    (await evaluate('document.querySelector("#plugin-surface-status")?.textContent')) ===
      "Plugin view is open in the main window.",
    "A healthy main-window plugin view still appeared to be opening.",
  );
  await clickSelector("#pop-out-plugin-view");
  await waitFor(
    async () => ((await snapshot()).workspaceLayout?.popout.state === "open" ? true : null),
    "Plugin view did not pop out",
  );
  let pageTargets = await mainTargets(port);
  const popoutTarget = pageTargets.find((target) => target.url === "about:blank");
  const pluginSurfaceTarget = pageTargets.find((target) =>
    target.url.endsWith("/plugin-host.html"),
  );
  assert(
    popoutTarget?.webSocketDebuggerUrl,
    `No native pop-out target appeared: ${pageTargets.map((target) => target.url).join(", ")}`,
  );
  assert(
    pluginSurfaceTarget?.webSocketDebuggerUrl,
    "No compatibility-plugin surface target appeared.",
  );
  assert(
    (await evaluateTarget(pluginSurfaceTarget, "document.body.textContent"))?.includes(
      "Threadleaf drawing fixture",
    ),
    "The detached native view did not retain its live plugin surface.",
  );
  const detachedPluginSurfaceSize = await evaluateTarget(
    pluginSurfaceTarget,
    "({ width: window.innerWidth, height: window.innerHeight })",
  );
  assert(
    detachedPluginSurfaceSize?.width >= 640 && detachedPluginSurfaceSize?.height >= 480,
    `The detached plugin surface did not receive native window bounds: ${JSON.stringify(detachedPluginSurfaceSize)}`,
  );
  assert(
    (await evaluate(
      'document.querySelector("#pop-out-plugin-view")?.getAttribute("aria-label")',
    )) === "Reattach plugin view",
    "The visible plugin pop-out control did not switch to its reattach state.",
  );
  assert(
    (await evaluate('document.querySelector("#plugin-surface-status")?.textContent')) ===
      "Plugin view is open in a separate window.",
    "The main workspace did not explain where the detached plugin view moved.",
  );
  await captureScreenshot("workspace-plugin-popout-open");
  const detachedSurface = await captureTargetScreenshot(
    pluginSurfaceTarget,
    "workspace-plugin-popout-surface",
  );
  assert(
    await evaluateTarget(
      pluginSurfaceTarget,
      `(() => {
        document.body.style.boxShadow = "inset 0 0 0 12px rgb(230, 159, 0)";
        return getComputedStyle(document.body).boxShadow.includes("12px");
      })()`,
    ),
    "The plugin-surface screenshot positive control did not apply.",
  );
  const detachedSurfacePositive = await captureTargetScreenshot(
    pluginSurfaceTarget,
    "workspace-plugin-popout-surface-positive-control",
  );
  assert(
    detachedSurfacePositive !== detachedSurface,
    "The plugin-surface screenshot positive control changed no pixels.",
  );
  await evaluateTarget(
    pluginSurfaceTarget,
    'document.body.style.removeProperty("box-shadow"); true',
  );

  phase = "native plugin pop-out window close";
  await closeTarget(popoutTarget);
  await waitFor(
    async () => ((await snapshot()).workspaceLayout?.popout.state === "closed" ? true : null),
    "Closing the native pop-out did not restore closed layout state",
  );
  await waitFor(
    async () =>
      (await mainTargets(port)).some((target) => target.url === "about:blank") ? null : true,
    "The closed native pop-out target remained alive",
  );
  const closedLayout = (await snapshot()).workspaceLayout.popout;
  assert(
    closedLayout.warning === null &&
      (await evaluate(
        'document.querySelector("#pop-out-plugin-view")?.getAttribute("aria-label")',
      )) === "Pop out plugin view" &&
      (await evaluate('document.querySelector("#plugin-surface-status")?.textContent')) ===
        "Plugin view is open in the main window.",
    `Native close left a degraded or misleading state: ${JSON.stringify(closedLayout)}`,
  );
  await clickSelector("#pop-out-plugin-view");
  await waitFor(
    async () => ((await snapshot()).workspaceLayout?.popout.state === "open" ? true : null),
    "Plugin view did not reopen after native-window close",
  );

  phase = "stale pop-out restart recovery";
  await crashApplication();
  port = await launchApplication();
  await waitForReady();
  await assertIsolatedX11Renderer();
  const restartedLayout = (await snapshot()).workspaceLayout;
  assert(
    restartedLayout.popout.state === "degraded" &&
      restartedLayout.popout.warning?.includes("Threadleaf restarted"),
    `A stale persisted pop-out was reported as live: ${JSON.stringify(restartedLayout.popout)}`,
  );
  pageTargets = await mainTargets(port);
  assert(
    !pageTargets.some((target) => target.url === "about:blank"),
    "Restart recovery claimed a native pop-out window that did not survive the process.",
  );
  await waitFor(
    async () => ((await snapshot()).integrations?.viewTypes.includes("excalidraw") ? true : null),
    "Supported plugin view did not register after restart",
  );
  await clickSelector('.note-tab-activate[data-note-path="Drawing.excalidraw.md"]');
  await clickSelector("#plugin-view");
  await waitFor(
    async () => ((await snapshot()).pluginSurface?.viewType === "excalidraw" ? true : null),
    "Plugin view did not reopen in the main workspace after restart",
  );
  assert(
    (await evaluate(
      'document.querySelector("#pop-out-plugin-view")?.getAttribute("aria-label")',
    )) === "Pop out plugin view",
    "A recovered plugin view still exposed a false reattach action.",
  );
  assert(
    (await evaluate('document.querySelector("#plugin-surface-status")?.textContent')) ===
      "Plugin pop-out unavailable; plugin view is open in the main window.",
    "The recovered plugin surface did not report its main-window state.",
  );

  phase = "plugin-view close while popped out";
  await clickSelector("#pop-out-plugin-view");
  await waitFor(
    async () => ((await snapshot()).workspaceLayout?.popout.state === "open" ? true : null),
    "Recovered plugin view did not pop out again",
  );
  await clickSelector("#plugin-view");
  await waitFor(async () => {
    const current = await snapshot();
    return current.workspaceLayout?.popout.state === "closed" && current.pluginSurface === null
      ? current
      : null;
  }, "Closing the plugin view left its native pop-out alive");
  await waitFor(
    async () =>
      (await mainTargets(port)).some((target) => target.url === "about:blank") ? null : true,
    "Closing the plugin view left a blank native window",
  );
  await clickSelector("#plugin-view");
  await waitFor(
    async () => ((await snapshot()).pluginSurface?.viewType === "excalidraw" ? true : null),
    "Plugin view did not reopen after closing its detached surface",
  );
  assert(
    (await evaluate('document.querySelector("#plugin-surface-status")?.textContent')) ===
      "Plugin view is open in the main window.",
    "Reopened plugin view did not return to a healthy main-window state.",
  );

  phase = "explicit reattachment and renderer crash recovery";
  await clickSelector("#pop-out-plugin-view");
  await waitFor(
    async () => ((await snapshot()).workspaceLayout?.popout.state === "open" ? true : null),
    "Plugin view did not reopen in a native window",
  );
  await clickSelector("#pop-out-plugin-view");
  await waitFor(
    async () => ((await snapshot()).workspaceLayout?.popout.state === "closed" ? true : null),
    "Explicit reattachment did not close the native pop-out",
  );
  await clickSelector("#pop-out-plugin-view");
  await waitFor(
    async () => ((await snapshot()).workspaceLayout?.popout.state === "open" ? true : null),
    "Plugin view did not reopen for renderer crash recovery",
  );
  pageTargets = await mainTargets(port);
  const popoutCrashTarget = pageTargets.find((target) => target.url === "about:blank");
  assert(popoutCrashTarget?.webSocketDebuggerUrl, "No pop-out target appeared for crash recovery.");
  const electronMainPid = await waitFor(
    isolatedElectronMainProcessId,
    "The isolated Electron main process was unavailable for renderer crash injection",
  );
  process.kill(electronMainPid, "SIGUSR2");
  await waitFor(
    async () => ((await snapshot()).workspaceLayout?.popout.state === "degraded" ? true : null),
    "Crashed pop-out did not record degraded reattachment",
  );
  assert(
    (await snapshot()).workspaceLayout.popout.warning.includes("crashed"),
    "Crash recovery warning was not visible.",
  );
  await waitFor(async () => {
    const toast = await evaluate(`(() => {
        const element = document.querySelector("#toast");
        return element instanceof HTMLElement
          ? { hidden: element.hidden, text: element.textContent }
          : null;
      })()`);
    return toast && !toast.hidden && toast.text?.includes("crashed") ? toast : null;
  }, "Crash recovery did not expose its warning in the main workspace");
  assert(
    (await evaluate(
      'document.querySelector("#pop-out-plugin-view")?.getAttribute("aria-label")',
    )) === "Pop out plugin view",
    "A crash-recovered plugin view still exposed a false reattach action.",
  );
  assert(
    (await evaluate('document.querySelector("#plugin-surface-status")?.textContent')) ===
      "Plugin pop-out unavailable; plugin view is open in the main window.",
    "Crash recovery did not return the plugin surface to its main-window state.",
  );
  await waitFor(
    async () =>
      (await mainTargets(port)).some((target) => target.url === "about:blank") ? null : true,
    "The crashed native pop-out target remained alive",
  );
  pageTargets = await mainTargets(port);
  const recoveredPluginSurfaceTarget = pageTargets.find((target) =>
    target.url.endsWith("/plugin-host.html"),
  );
  assert(
    recoveredPluginSurfaceTarget?.webSocketDebuggerUrl &&
      (await evaluateTarget(recoveredPluginSurfaceTarget, "document.body.textContent"))?.includes(
        "Threadleaf drawing fixture",
      ),
    "Crash recovery lost the live compatibility-plugin surface.",
  );
  const recoveredPluginSurfaceSize = await evaluateTarget(
    recoveredPluginSurfaceTarget,
    "({ width: window.innerWidth, height: window.innerHeight })",
  );
  assert(
    recoveredPluginSurfaceSize?.width > 0 &&
      recoveredPluginSurfaceSize?.height > 0 &&
      recoveredPluginSurfaceSize.width < detachedPluginSurfaceSize.width,
    `Crash recovery did not rebind the plugin surface to the main pane: ${JSON.stringify({ detachedPluginSurfaceSize, recoveredPluginSurfaceSize })}`,
  );
  await captureScreenshot("workspace-plugin-popout-recovered");
  await captureTargetScreenshot(
    recoveredPluginSurfaceTarget,
    "workspace-plugin-popout-recovered-surface",
  );

  phase = "vault switch and restart restoration";
  await clickSelector("#pop-out-plugin-view");
  await waitFor(
    async () => ((await snapshot()).workspaceLayout?.popout.state === "open" ? true : null),
    "Plugin view did not reopen before vault-switch cleanup",
  );
  await fs.unlink(pickerLink);
  await fs.symlink(secondVaultPath, pickerLink);
  const switched = await evaluate("window.threadleaf.chooseVault()");
  assert(switched.status === "opened", `Vault switch failed: ${JSON.stringify(switched)}`);
  await waitForReady(secondVaultPath, 2);
  assert(
    (await snapshot()).workspaceLayout.popout.state === "closed",
    "Vault switch retained an unsafe pop-out host.",
  );
  await fs.unlink(pickerLink);
  await fs.symlink(vaultPath, pickerLink);
  const returned = await evaluate("window.threadleaf.chooseVault()");
  assert(returned.status === "opened", `Vault return failed: ${JSON.stringify(returned)}`);
  await waitForReady(vaultPath, 4);
  const returnedPopout = (await snapshot()).workspaceLayout.popout;
  assert(
    returnedPopout.state === "closed" && returnedPopout.warning === null,
    `Intentional vault-switch cleanup left stale degraded state: ${JSON.stringify(returnedPopout)}`,
  );
  await closeApplication();
  port = await launchApplication();
  await waitForReady();
  await assertIsolatedX11Renderer();
  const restored = await snapshot();
  assert(
    restored.workspaceLayout.docks.left.collapsed,
    "Left dock collapse did not restore privately.",
  );
  assert(
    restored.workspaceLayout.docks.right.collapsed,
    "Right dock collapse did not restore privately.",
  );
  await closeApplication();

  phase = "native plugin pop-out load failure";
  port = await launchApplication({ THREADLEAF_TEST_PLUGIN_POPOUT_LOAD_FAILURE: "1" });
  await waitForReady();
  await assertIsolatedX11Renderer();
  await waitFor(
    async () => ((await snapshot()).integrations?.viewTypes.includes("excalidraw") ? true : null),
    "Supported plugin view did not register for load-failure recovery",
  );
  await clickSelector('.note-tab-activate[data-note-path="Drawing.excalidraw.md"]');
  await clickSelector("#plugin-view");
  await waitFor(
    async () => ((await snapshot()).pluginSurface?.viewType === "excalidraw" ? true : null),
    "Plugin view did not open before pop-out load failure",
  );
  await clickSelector("#pop-out-plugin-view");
  const failedPopout = await waitFor(async () => {
    const current = await snapshot();
    return current.workspaceLayout?.popout.state === "degraded" &&
      current.workspaceLayout.popout.warning?.includes("could not be opened")
      ? current.workspaceLayout.popout
      : null;
  }, "A failed native pop-out load did not degrade safely");
  assert(
    failedPopout.viewType === "excalidraw" &&
      failedPopout.filePath === null &&
      !(await mainTargets(port)).some((target) => target.url === "about:blank") &&
      (await evaluate('document.querySelector("#plugin-surface-status")?.textContent')) ===
        "Plugin pop-out unavailable; plugin view is open in the main window.",
    `Failed pop-out load lost its live main-window view: ${JSON.stringify(failedPopout)}`,
  );
  const failedPopoutToast = await waitFor(async () => {
    const toast = await evaluate(`(() => {
        const element = document.querySelector("#toast");
        return element instanceof HTMLElement
          ? { hidden: element.hidden, text: element.textContent }
          : null;
      })()`);
    return toast && !toast.hidden && toast.text?.includes("could not be opened") ? toast : null;
  }, "A failed native pop-out load did not expose its generic recovery warning");
  assert(
    !failedPopoutToast.text.includes("file://") && !failedPopoutToast.text.includes(appRoot),
    `The native pop-out recovery warning exposed a local path: ${failedPopoutToast.text}`,
  );
  await captureScreenshot("workspace-plugin-popout-load-failure");
  await closeApplication();
  console.log(
    "Verified X11 renderer argv, keyboard and pointer tab moves with cancellation and pane transfer, pinned-region safety, keyboard dock collapse, both schemes and screenshot positive controls, native pop-out surface continuity, actual window close, plugin-view close, explicit and crash reattachment, stale-session and load-failure recovery, vault-switch cleanup, and restart restoration.",
  );
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  const logs = output.join("").trim();
  throw new Error(
    logs ? `Phase ${phase}: ${detail}\nElectron output:\n${logs}` : `Phase ${phase}: ${detail}`,
    { cause: error },
  );
} finally {
  try {
    await closeApplication();
  } finally {
    await makeTestTreeRemovable(testRoot);
    await fs.rm(testRoot, { recursive: true, force: true });
  }
}
