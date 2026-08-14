import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const appRoot = process.cwd();
const electronPath = path.join(appRoot, "node_modules", ".bin", "electron");
const fixtureVault = path.join(appRoot, "fixtures", "vaults", "basic");
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-pinned-tabs-"));
const vaultPath = path.join(testRoot, "vault");
const userDataPath = path.join(testRoot, "user-data");
const screenshotDirectory = process.env.THREADLEAF_PINNED_TABS_SCREENSHOT_DIR;
const processMarker = randomUUID();
const output = [];
let child;
let exited;
let cdp;
let phase = "setup";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

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
  const marker = Buffer.from(`THREADLEAF_PINNED_TABS_RUN=${processMarker}\0`);
  const entries = await fs.readdir("/proc");
  const matches = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    try {
      const environment = await fs.readFile(`/proc/${entry}/environ`);
      if (environment.includes(marker)) {
        matches.push(Number.parseInt(entry, 10));
      }
    } catch {
      // A process can exit between enumeration and the read.
    }
  }
  return matches;
}

async function terminateMarkedProcesses(signals = ["SIGTERM", "SIGKILL"]) {
  for (const signal of signals) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const pids = await markedProcessIds();
      if (pids.length === 0) {
        return;
      }
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

async function waitForMainTarget(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const main = targets.find(
          (target) =>
            target.type === "page" &&
            typeof target.url === "string" &&
            target.url.endsWith("/dist/renderer/index.html"),
        );
        if (main?.webSocketDebuggerUrl) {
          return main;
        }
      }
    } catch {
      // Electron is still starting.
    }
    await delay(50);
  }
  throw new Error("Threadleaf did not expose its main renderer in time.");
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
  socket.addEventListener("close", () => {
    for (const request of pending.values()) {
      request.reject(new Error("CDP WebSocket closed."));
    }
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

async function launchApplication() {
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
        THREADLEAF_PINNED_TABS_RUN: processMarker,
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
      if (output.length > 160) {
        output.shift();
      }
    });
  }
  await started;
  const target = await waitForMainTarget(port);
  cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
}

async function descendantRendererCommandLines(rootPid) {
  const entries = await fs.readdir("/proc", { withFileTypes: true });
  const processes = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) {
      continue;
    }
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
      // A short-lived process disappeared between directory and metadata reads.
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
  return processes
    .filter(
      (process) => descendants.has(process.pid) && process.commandLine.includes("--type=renderer"),
    )
    .map((process) => process.commandLine);
}

async function assertIsolatedX11Renderer() {
  const commandLines = await waitFor(async () => {
    const lines = await descendantRendererCommandLines(child.pid);
    return lines.length > 0 ? lines : null;
  }, "The isolated launch did not expose a renderer process");
  assert(
    commandLines.every((line) => line.includes("--ozone-platform=x11")),
    "A renderer escaped the explicit X11 virtual-display contract.",
  );
  assert(
    commandLines.every((line) => !line.includes("--ozone-platform=wayland")),
    "A renderer attached to Wayland instead of the virtual X11 display.",
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

async function waitFor(probe, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) {
      return last;
    }
    await delay(50);
  }
  throw new Error(`${message}. Last observation: ${JSON.stringify(last)}`);
}

async function snapshot() {
  return evaluate("window.threadleaf.getSnapshot()");
}

async function waitForReady() {
  return waitFor(async () => {
    const current = await snapshot();
    return current?.workspace?.state === "ready" &&
      current?.vault?.path === vaultPath &&
      current.workspace.files.length === 3
      ? current
      : null;
  }, "The isolated writable vault did not become ready");
}

async function targetCenter(selector) {
  const target = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return { error: "missing" };
    const interactionRoot = element.closest("button, [role=button]") ?? element;
    const rect = interactionRoot.getBoundingClientRect();
    const style = getComputedStyle(interactionRoot);
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      disabled: interactionRoot instanceof HTMLButtonElement && interactionRoot.disabled,
      error: null,
      hidden: interactionRoot.hidden || style.display === "none" || style.visibility === "hidden",
      hit: Boolean(hit && (hit === interactionRoot || interactionRoot.contains(hit))),
      height: rect.height,
      width: rect.width,
      x,
      y,
    };
  })()`);
  assert(target && !target.error, `Pointer target is unavailable: ${selector}`);
  assert(!target.disabled, `Pointer target is disabled: ${selector}`);
  assert(
    !target.hidden && target.width > 0 && target.height > 0,
    `Pointer target is hidden: ${selector}`,
  );
  assert(target.hit, `Pointer target is covered at its center: ${selector}`);
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
  const windowsVirtualKeyCode = key.length === 1 ? key.toUpperCase().charCodeAt(0) : undefined;
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    code,
    key,
    modifiers,
    windowsVirtualKeyCode,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    code,
    key,
    modifiers,
    windowsVirtualKeyCode,
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

async function closeApplication() {
  if (!child) {
    return;
  }
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
  if (result.code !== 0) {
    await terminateMarkedProcesses();
  }
  child = undefined;
  exited = undefined;
}

function paneTabs(current) {
  return current.workspace?.panes.find((pane) => pane.id === "primary")?.tabs ?? [];
}

async function waitForTabs(expected) {
  return waitFor(
    async () => {
      const current = await snapshot();
      const actual = paneTabs(current).map((tab) => ({ path: tab.path, pinned: tab.pinned }));
      return JSON.stringify(actual) === JSON.stringify(expected) ? current : null;
    },
    `Tabs did not reach ${JSON.stringify(expected)}`,
  );
}

async function waitForNoteToolbarLabel(expected) {
  return waitFor(
    async () => {
      const rendered = await evaluate(`(() => ({
        activePath: document.querySelector('.note-tab[data-active="true"] .note-tab-activate')?.dataset.notePath ?? null,
        toolbarLabel: document.querySelector("#note-path")?.textContent ?? null,
      }))()`);
      return rendered.activePath === expected && rendered.toolbarLabel === expected ? true : null;
    },
    `The note toolbar did not retain ${JSON.stringify(expected)} after the available-note render`,
  );
}

async function setTheme(theme) {
  const current = await evaluate("document.documentElement.dataset.theme");
  if (current !== theme) {
    await clickSelector("#theme-toggle");
    await waitFor(
      async () => (await evaluate("document.documentElement.dataset.theme")) === theme,
      `Threadleaf did not switch to ${theme} mode`,
    );
  }
}

try {
  if (process.platform !== "linux") {
    throw new Error("The pinned-tab integration check currently requires Linux and Xvfb.");
  }
  await fs.access(electronPath);
  await fs.cp(fixtureVault, vaultPath, { recursive: true });
  await fs.writeFile(
    path.join(vaultPath, "Third Note.md"),
    "# Third Note\n\nPinned tab fixture.\n",
  );
  await fs.mkdir(userDataPath, { recursive: true });
  const canonicalVaultPath = await fs.realpath(vaultPath);
  const vaultId = createHash("sha256").update(canonicalVaultPath).digest("hex");
  const workspaceStatePath = path.join(userDataPath, "workspaces", `${vaultId}.json`);
  await fs.writeFile(
    path.join(userDataPath, "settings.json"),
    `${JSON.stringify(
      {
        version: 5,
        keyBindings: { "workspace.toggle-tab-pin": "Alt+P" },
        appearanceByVault: {},
        pluginsByVault: {
          [vaultId]: {
            compatibilityMode: "restricted",
            enabledPluginIds: [],
            capabilityGrantsByPlugin: {},
          },
        },
        noteWorkflowsByVault: {},
      },
      null,
      2,
    )}\n`,
  );

  phase = "isolated X11 launch";
  await launchApplication();
  await waitForReady();
  await assertIsolatedX11Renderer();

  phase = "pointer tab opening and pinning";
  await clickSelector('#file-list [data-note-path="Welcome.md"]');
  await waitForTabs([
    { path: "Linked Note.md", pinned: false },
    { path: "Welcome.md", pinned: false },
  ]);
  phase = "available-note toolbar render ordering";
  await waitForNoteToolbarLabel("Welcome.md");
  phase = "pointer tab opening and pinning";
  await clickSelector('#file-list [data-note-path="Third Note.md"]');
  await waitForTabs([
    { path: "Linked Note.md", pinned: false },
    { path: "Welcome.md", pinned: false },
    { path: "Third Note.md", pinned: false },
  ]);
  await clickSelector('.note-tab-pin[data-note-path="Welcome.md"]');
  await waitForTabs([
    { path: "Welcome.md", pinned: true },
    { path: "Linked Note.md", pinned: false },
    { path: "Third Note.md", pinned: false },
  ]);
  await clickSelector('.note-tab-pin[data-note-path="Third Note.md"]');
  await waitForTabs([
    { path: "Welcome.md", pinned: true },
    { path: "Third Note.md", pinned: true },
    { path: "Linked Note.md", pinned: false },
  ]);
  assert(
    (await evaluate('document.querySelector(".note-tabs-pin-divider")?.getAttribute("role")')) ===
      "separator",
    "The visible pinned-tab boundary is missing its semantic separator.",
  );
  assert(
    (await evaluate(
      'document.querySelector(".note-tab[data-pinned=\\"true\\"] .note-tab-mark")?.textContent',
    )) === "PIN",
    "Pinned state is not exposed by a non-color text marker.",
  );

  phase = "visible close refusal";
  await clickSelector('.note-tab-close[data-note-path="Third Note.md"]');
  await waitFor(
    async () =>
      (await evaluate('document.querySelector("#toast")?.textContent')) ===
      "Unpin this tab before closing it."
        ? true
        : null,
    "Closing a pinned tab did not visibly refuse",
  );
  await waitForTabs([
    { path: "Welcome.md", pinned: true },
    { path: "Third Note.md", pinned: true },
    { path: "Linked Note.md", pinned: false },
  ]);

  phase = "keyboard command palette";
  await pressKey("k", "KeyK", 2);
  await waitFor(
    async () => (await evaluate('document.querySelector("#command-palette")?.open')) === true,
    "The keyboard shortcut did not open the command palette",
  );
  await cdp.send("Input.insertText", { text: "Unpin current tab" });
  await waitFor(
    async () =>
      (await evaluate(
        'document.querySelector("[data-command-id=\\"workspace.toggle-tab-pin\\"]")?.textContent?.includes("Unpin current tab")',
      ))
        ? true
        : null,
    "The command palette did not expose the active tab pin action",
  );
  await pressKey("Enter", "Enter");
  await waitForTabs([
    { path: "Welcome.md", pinned: true },
    { path: "Third Note.md", pinned: false },
    { path: "Linked Note.md", pinned: false },
  ]);

  phase = "remappable pin target";
  await pressKey("p", "KeyP", 1);
  await waitForTabs([
    { path: "Welcome.md", pinned: true },
    { path: "Third Note.md", pinned: true },
    { path: "Linked Note.md", pinned: false },
  ]);

  phase = "dark visual surface";
  await setTheme("dark");
  const darkBaseline = await captureScreenshot("pinned-tabs-dark");
  const positiveControlReached = await evaluate(`(() => {
    const region = document.querySelector(".note-tab[data-pinned=\\"true\\"]");
    if (!(region instanceof HTMLElement)) return false;
    region.style.boxShadow = "inset 0 0 0 12px rgb(230, 159, 0)";
    return getComputedStyle(region).boxShadow.includes("12px");
  })()`);
  assert(positiveControlReached, "The visual positive control did not reach a pinned tab.");
  const positiveControl = await captureScreenshot("pinned-tabs-positive-control");
  assert(
    positiveControl !== darkBaseline,
    "The visual positive control changed no captured pixels.",
  );
  await evaluate(
    'document.querySelector(".note-tab[data-pinned=\\"true\\"]")?.style.removeProperty("box-shadow"); true',
  );

  phase = "light and minimum-width surfaces";
  await setTheme("light");
  await captureScreenshot("pinned-tabs-light");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 860,
    height: 640,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const narrowLayout = await waitFor(async () => {
    const layout = await evaluate(`(() => {
      const tabs = document.querySelector(".note-tabs");
      const divider = document.querySelector(".note-tabs-pin-divider");
      if (!(tabs instanceof HTMLElement) || !(divider instanceof HTMLElement)) return null;
      const rect = tabs.getBoundingClientRect();
      return { width: innerWidth, left: rect.left, right: innerWidth - rect.right, dividerHeight: divider.getBoundingClientRect().height };
    })()`);
    return layout?.width === 860 ? layout : null;
  }, "The minimum-width viewport did not apply");
  assert(
    narrowLayout.left >= 0 && narrowLayout.right >= 0 && narrowLayout.dividerHeight > 0,
    `Pinned tabs escaped the minimum-width surface: ${JSON.stringify(narrowLayout)}`,
  );
  await captureScreenshot("pinned-tabs-minimum-width-light");
  await cdp.send("Emulation.clearDeviceMetricsOverride");

  phase = "private persistence and restart";
  const persisted = JSON.parse(await fs.readFile(workspaceStatePath, "utf8"));
  assert(
    persisted.version === 1 &&
      persisted.layoutVersion === 2 &&
      JSON.stringify(persisted.openPaths) ===
        JSON.stringify(["Welcome.md", "Third Note.md", "Linked Note.md"]) &&
      JSON.stringify(persisted.panes?.[0]?.pinnedPaths) ===
        JSON.stringify(["Welcome.md", "Third Note.md"]),
    "Pinned tabs were not explicitly persisted in the compatible private workspace document.",
  );
  await closeApplication();
  await launchApplication();
  await waitForReady();
  await assertIsolatedX11Renderer();
  await waitForTabs([
    { path: "Welcome.md", pinned: true },
    { path: "Third Note.md", pinned: true },
    { path: "Linked Note.md", pinned: false },
  ]);
  await closeApplication();

  console.log(
    "Verified isolated X11 pinned tabs with real per-tab pointer input, available-note toolbar retention, keyboard command palette input, a remappable target, visible close refusal, private compatible persistence, restart recovery, and dark, light, minimum-width screenshots.",
  );
  console.log("VISUAL_POSITIVE_CONTROL=pinned-tabs-positive-control");
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  const logs = output.join("").trim();
  const phased = `Phase ${phase}: ${detail}`;
  throw new Error(logs ? `${phased}\nElectron output:\n${logs}` : phased, { cause: error });
} finally {
  cdp?.close();
  await terminateMarkedProcesses();
  await fs.rm(testRoot, { recursive: true, force: true });
}
