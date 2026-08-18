import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const appRoot = process.cwd();
const electronPath = path.join(appRoot, "node_modules", ".bin", "electron");
const fixtureVault = path.join(appRoot, "fixtures", "vaults", "basic");
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-workspace-panes-"));
const vaultPath = path.join(testRoot, "vault");
const userDataPath = path.join(testRoot, "user-data");
const screenshotDirectory = process.env.THREADLEAF_WORKSPACE_SCREENSHOT_DIR;
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

async function markedProcessIds() {
  const entries = await fs.readdir("/proc");
  const marker = Buffer.from(`THREADLEAF_WORKSPACE_PANES_RUN=${processMarker}\0`);
  const matches = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    const pid = Number.parseInt(entry, 10);
    try {
      const environment = await fs.readFile(`/proc/${pid}/environ`);
      if (environment.includes(marker)) {
        matches.push(pid);
      }
    } catch {
      // A process can exit between directory enumeration and the read.
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
      // Electron or its renderer is still starting.
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
      "--password-store=basic",
      ".",
    ],
    {
      cwd: appRoot,
      env: {
        ...process.env,
        ELECTRON_OZONE_PLATFORM_HINT: "x11",
        THREADLEAF_SAFE_PLUGINS: "1",
        THREADLEAF_VAULT_PATH: vaultPath,
        THREADLEAF_WORKSPACE_PANES_RUN: processMarker,
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
  return port;
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
  const current = await waitFor(async () => {
    const current = await snapshot();
    return current?.workspace?.state === "ready" && current?.vault?.path === vaultPath
      ? current
      : null;
  }, "The isolated writable vault did not become ready");
  await ensureFlatNavigator();
  return current;
}

// This suite exercises panes, not hierarchy. Keep its historical flat-list
// fixture explicit; check-navigator-tree owns the dedicated tree coverage.
async function ensureFlatNavigator() {
  const mode = await waitFor(async () => {
    const value = await evaluate('document.querySelector("#file-list")?.dataset.mode ?? null');
    return value === "tree" || value === "virtual" ? value : null;
  }, "The navigator did not render before pane checks");
  if (mode === "tree") await clickSelector("#navigator-view-toggle");
  await waitFor(
    async () =>
      (await evaluate('document.querySelector("#file-list")?.dataset.mode')) === "virtual"
        ? true
        : null,
    "The pane fixture could not select the flat navigator",
  );
}

async function paneState(paneId) {
  return evaluate(`(() => {
    const root = document.querySelector(${JSON.stringify(`[data-pane-id="${paneId}"]`)});
    if (!(root instanceof HTMLElement)) return null;
    return {
      active: root.dataset.active === "true",
      hidden: root.hidden,
      path: root.querySelector('[id^="note-path"]')?.textContent ?? "",
      text: [...root.querySelectorAll(".cm-content .cm-line")]
        .map((line) => line.textContent ?? "")
        .join("\\n"),
      editState: root.querySelector('[id^="edit-state"]')?.textContent ?? "",
      draftState: root.querySelector('[id^="edit-state"]')?.getAttribute("data-draft-state") ?? "",
    };
  })()`);
}

async function scrollPaneEditorToEnd(paneId) {
  const scrolled = await evaluate(`(() => {
    const root = document.querySelector(${JSON.stringify(`[data-pane-id="${paneId}"]`)});
    const scroller = root?.querySelector('.cm-scroller');
    if (!(scroller instanceof HTMLElement)) return false;
    scroller.scrollTop = scroller.scrollHeight;
    return true;
  })()`);
  assert(scrolled, `The ${paneId} editor could not reveal its recovered tail.`);
}

async function waitForThemeToggleReady() {
  await waitFor(
    () => evaluate("document.querySelector('#theme-toggle')?.disabled === false"),
    "The theme toggle did not become available after persistence",
  );
}

function paneTabPaths(snapshotValue, paneId) {
  return (
    snapshotValue.workspace?.panes
      .find((pane) => pane.id === paneId)
      ?.tabs.map((tab) => tab.path) ?? []
  );
}

async function clickSelector(selector) {
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
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const interactionRoot = element.closest('button, [role="button"], .cm-editor') ?? element;
    const interactionRect = interactionRoot.getBoundingClientRect();
    const left = Math.max(0, rect.left, interactionRect.left);
    const right = Math.min(innerWidth, rect.right, interactionRect.right);
    const top = Math.max(0, rect.top, interactionRect.top);
    const bottom = Math.min(innerHeight, rect.bottom, interactionRect.bottom);
    const x = interactionRoot.classList.contains("cm-editor")
      ? left + Math.min(24, Math.max(0, right - left) / 2)
      : left + Math.max(0, right - left) / 2;
    const y = top + Math.max(0, bottom - top) / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      disabled: element instanceof HTMLButtonElement ? element.disabled : false,
      error: null,
      height: bottom - top,
      hit: Boolean(hit && (hit === interactionRoot || interactionRoot.contains(hit))),
      hidden: element.hidden || style.display === "none" || style.visibility === "hidden",
      width: right - left,
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
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: target.x,
    y: target.y,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    clickCount: 1,
    x: target.x,
    y: target.y,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    clickCount: 1,
    x: target.x,
    y: target.y,
  });
}

async function pressKey(key, code, modifiers = 0) {
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    code,
    key,
    modifiers,
    windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : undefined,
  });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", code, key, modifiers });
}

async function focusPaneEditor(paneId) {
  await clickSelector(`[data-pane-id="${paneId}"] .cm-content`);
  await waitFor(
    async () => (await snapshot()).workspace?.activePaneId === paneId,
    `Pane ${paneId} did not receive focus`,
  );
}

async function appendToPane(paneId, text) {
  await focusPaneEditor(paneId);
  await pressKey("End", "End", 2);
  await cdp.send("Input.insertText", { text });
  return waitFor(async () => {
    const current = await paneState(paneId);
    return current?.text.includes(text.trim()) && current.draftState === "saved" ? current : null;
  }, `Pane ${paneId} did not protect its draft`);
}

function draftPath(vaultId, paneId) {
  return path.join(
    userDataPath,
    "editor-drafts",
    paneId === "primary" ? `${vaultId}.json` : `${vaultId}.secondary.json`,
  );
}

async function readDraft(vaultId, paneId) {
  try {
    return JSON.parse(await fs.readFile(draftPath(vaultId, paneId), "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function waitForDraft(vaultId, paneId, marker) {
  return waitFor(async () => {
    const draft = await readDraft(vaultId, paneId);
    return draft?.paneId === paneId && draft.content.includes(marker) ? draft : null;
  }, `The ${paneId} pane draft file was not written`);
}

async function captureScreenshot(name) {
  if (!screenshotDirectory) {
    return null;
  }
  await fs.mkdir(screenshotDirectory, { recursive: true });
  const result = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  const bytes = Buffer.from(result.data, "base64");
  await fs.writeFile(path.join(screenshotDirectory, `${name}.png`), bytes);
  return createHash("sha256").update(bytes).digest("hex");
}

async function crashApplication() {
  cdp?.close();
  cdp = undefined;
  await terminateMarkedProcesses(["SIGKILL"]);
  if (exited) {
    await Promise.race([exited, delay(2_000)]);
  }
  child = undefined;
  exited = undefined;
}

async function closeApplication() {
  if (!child) {
    return;
  }
  try {
    await evaluate("setTimeout(() => window.close(), 50); true");
  } catch {
    // The renderer can disappear before the close response returns.
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

try {
  if (process.platform !== "linux") {
    throw new Error("The workspace pane integration check currently requires Linux and Xvfb.");
  }
  await fs.access(electronPath);
  await fs.cp(fixtureVault, vaultPath, { recursive: true });
  await fs.mkdir(userDataPath, { recursive: true });
  const canonicalVaultPath = await fs.realpath(vaultPath);
  const vaultId = createHash("sha256").update(canonicalVaultPath).digest("hex");
  const workspaceStatePath = path.join(userDataPath, "workspaces", `${vaultId}.json`);
  await fs.writeFile(
    path.join(userDataPath, "settings.json"),
    `${JSON.stringify(
      {
        version: 4,
        keyBindings: {},
        appearanceByVault: {},
        pluginsByVault: {
          [vaultId]: {
            compatibilityMode: "restricted",
            enabledPluginIds: [],
            capabilityGrantsByPlugin: {},
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  phase = "isolated launch";
  await launchApplication();
  let current = await waitForReady();
  assert(current.workspace.panes.length === 1, "A fresh workspace did not start with one pane.");
  assert(
    current.workspace.panes[0].tabs.length === 1,
    `A fresh workspace did not auto-open exactly one fixture note: ${JSON.stringify(current.workspace.panes[0].tabs)}`,
  );
  const repeatedActionTargets = await evaluate(`(() => {
    const close = document.querySelector('[data-pane-id="primary"] .note-tab-close');
    const modes = [...document.querySelectorAll('[data-pane-id="primary"] .document-view-switch button')]
      .filter((mode) =>
        mode instanceof HTMLButtonElement && !mode.hidden && getComputedStyle(mode).display !== 'none'
      );
    if (!(close instanceof HTMLElement) || modes.length === 0) return null;
    const closeBounds = close.getBoundingClientRect();
    return {
      close: { width: closeBounds.width, height: closeBounds.height },
      modes: modes.map((mode) => {
        const bounds = mode.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height };
      }),
    };
  })()`);
  assert(
    repeatedActionTargets &&
      repeatedActionTargets.close.width >= 24 &&
      repeatedActionTargets.close.height >= 24 &&
      repeatedActionTargets.modes.every((target) => target.width >= 24 && target.height >= 24),
    `Repeated document controls missed the 24px target floor: ${JSON.stringify(repeatedActionTargets)}`,
  );

  phase = "deterministic empty workspace";
  await clickSelector('[data-pane-id="primary"] .note-tab-close');
  await waitFor(
    async () => (await snapshot()).workspace?.panes[0]?.tabs.length === 0,
    "The startup tab did not close through the visible tab control",
  );

  phase = "vault-bound workspace settings";
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1180,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await clickSelector("#settings-trigger");
  await clickSelector("#settings-nav-workspace");
  await waitFor(
    () =>
      evaluate(`(() => {
        const dialog = document.querySelector('#shortcut-settings');
        const page = document.querySelector('[data-settings-page="workspace"]');
        const save = document.querySelector('#workspace-settings-save');
        return dialog instanceof HTMLDialogElement && dialog.open &&
          page instanceof HTMLElement && !page.hidden &&
          save instanceof HTMLButtonElement && !save.disabled &&
          document.querySelector('#workspace-settings-state')?.textContent === 'Ready';
      })()`),
    "The workspace settings page did not become ready",
  );
  await clickSelector("#workspace-default-folder");
  await pressKey("a", "KeyA", 2);
  await cdp.send("Input.insertText", { text: "Notes" });
  assert(
    (await evaluate("document.querySelector('#workspace-default-folder')?.value")) === "Notes",
    "The visible default-folder field did not record real keyboard input.",
  );
  await clickSelector("#workspace-settings-save");
  await waitFor(
    () =>
      evaluate(
        "document.querySelector('#settings-status')?.textContent === 'Workspace preferences saved privately for this vault.'",
      ),
    "The workspace settings form did not report a durable save",
  );
  const recordedWorkspaceSettings = await evaluate(
    `window.threadleaf.getWorkspaceSettings(${JSON.stringify(vaultId)})`,
  );
  assert(
    recordedWorkspaceSettings?.status === "ready" &&
      recordedWorkspaceSettings.settings?.defaultNoteFolder === "Notes",
    "The application did not publish the workspace preference it saved.",
  );
  const persistedSettings = JSON.parse(
    await fs.readFile(path.join(userDataPath, "settings.json"), "utf8"),
  );
  assert(
    persistedSettings.workspaceByVault?.[vaultId]?.defaultNoteFolder === "Notes",
    "The private app-settings document did not persist the vault-bound workspace preference.",
  );
  assert(
    await evaluate(`(() => {
      const content = document.querySelector('.settings-content');
      if (!(content instanceof HTMLElement)) return false;
      content.scrollTop = 0;
      return content.scrollTop === 0;
    })()`),
    "The dark workspace-settings baseline could not return to the top of the page.",
  );
  await delay(50);
  assert(
    (await evaluate("document.documentElement.dataset.theme")) === "dark",
    "The workspace-settings visual baseline did not start in dark mode.",
  );
  const darkSettingsDigest = await captureScreenshot("workspace-settings-dark");
  const positiveControlReached = await evaluate(`(() => {
    const page = document.querySelector('[data-settings-page="workspace"]');
    if (!(page instanceof HTMLElement)) return false;
    page.style.outline = '12px solid rgb(255, 0, 255)';
    page.style.outlineOffset = '-12px';
    return getComputedStyle(page).outlineColor === 'rgb(255, 0, 255)';
  })()`);
  assert(
    positiveControlReached,
    "The workspace-settings screenshot control did not reach the page.",
  );
  const positiveSettingsDigest = await captureScreenshot("workspace-settings-positive-control");
  if (darkSettingsDigest && positiveSettingsDigest) {
    assert(
      darkSettingsDigest !== positiveSettingsDigest,
      "The workspace-settings screenshot positive control changed no captured pixels.",
    );
  }
  await evaluate(`(() => {
    const page = document.querySelector('[data-settings-page="workspace"]');
    if (!(page instanceof HTMLElement)) return false;
    page.style.removeProperty('outline');
    page.style.removeProperty('outline-offset');
    return true;
  })()`);
  await clickSelector("#settings-close");
  await waitForThemeToggleReady();
  await clickSelector("#theme-toggle");
  await waitFor(
    () => evaluate("document.documentElement.dataset.theme === 'light'"),
    "The light theme did not become active for workspace settings",
  );
  await clickSelector("#settings-trigger");
  await clickSelector("#settings-nav-workspace");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 900,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await waitFor(
    () =>
      evaluate(`(() => {
        const dialog = document.querySelector('#shortcut-settings');
        const page = document.querySelector('[data-settings-page="workspace"]');
        return dialog instanceof HTMLDialogElement && dialog.open &&
          page instanceof HTMLElement && !page.hidden &&
          dialog.scrollWidth <= dialog.clientWidth;
      })()`),
    "The compact light workspace settings page overflowed horizontally",
  );
  assert(
    await evaluate(`(() => {
      const content = document.querySelector('.settings-content');
      if (!(content instanceof HTMLElement)) return false;
      content.scrollTop = 0;
      return content.scrollTop === 0;
    })()`),
    "The compact workspace-settings baseline could not return to the top of the page.",
  );
  await delay(50);
  await captureScreenshot("workspace-settings-light-compact");
  await clickSelector("#settings-close");
  await waitForThemeToggleReady();
  await clickSelector("#theme-toggle");
  await waitFor(
    () => evaluate("document.documentElement.dataset.theme === 'dark'"),
    "The dark theme was not restored after workspace-settings verification",
  );
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 840,
    deviceScaleFactor: 1,
    mobile: false,
  });

  phase = "pointer-driven split";
  await clickSelector('[data-note-path="Welcome.md"]');
  await waitFor(
    async () => (await paneState("primary"))?.path === "Welcome.md",
    "Welcome.md did not open in the primary pane",
  );

  phase = "note history and quick switcher real input";
  await clickSelector('[data-note-path="Linked Note.md"]');
  await waitFor(
    async () => (await paneState("primary"))?.path === "Linked Note.md",
    "Linked Note.md did not open in the primary pane for history",
  );
  current = await snapshot();
  assert(
    current.workspace.panes[0].canGoBack === true,
    "Opening a second note did not expose per-pane back history.",
  );
  await clickSelector("#navigate-back");
  await waitFor(
    async () => (await paneState("primary"))?.path === "Welcome.md",
    "The visible back control did not return to the previous note",
  );
  current = await snapshot();
  assert(
    current.workspace.panes[0].canGoForward === true,
    "Back navigation did not expose a forward entry.",
  );

  await pressKey("O", "KeyO", 2 | 8);
  await waitFor(
    () => evaluate("document.querySelector('#quick-switcher')?.open === true"),
    "The quick switcher hotkey did not open its dialog",
  );
  const quickSwitcherFocus = await evaluate(`(() => {
    const input = document.querySelector('#quick-switcher-query');
    const frame = document.querySelector('.quick-switcher-search');
    if (!(input instanceof HTMLInputElement) || !(frame instanceof HTMLElement)) return null;
    const style = getComputedStyle(frame);
    return {
      active: document.activeElement === input,
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
    };
  })()`);
  assert(
    quickSwitcherFocus?.active === true &&
      quickSwitcherFocus.outlineStyle === "solid" &&
      quickSwitcherFocus.outlineWidth >= 2,
    `The quick switcher did not expose its focused query with a visible frame: ${JSON.stringify(quickSwitcherFocus)}`,
  );
  await captureScreenshot("workspace-quick-switcher-dark");
  assert(
    await evaluate(
      "document.querySelector('#quick-switcher-query')?.getAttribute('role') === 'combobox'",
    ),
    "The quick switcher query is not exposed as an accessible combobox.",
  );
  await cdp.send("Input.insertText", { text: "Linked" });
  await waitFor(
    () =>
      evaluate(
        "document.querySelector('[data-note-path=\"Linked Note.md\"]')?.textContent?.includes('Linked')",
      ),
    "The quick switcher did not rank a matching indexed note",
  );
  await pressKey("Enter", "Enter");
  await waitFor(
    async () => (await paneState("primary"))?.path === "Linked Note.md",
    "Enter did not open the selected quick-switcher note",
  );

  await pressKey("k", "KeyK", 2);
  await waitFor(
    () => evaluate("document.querySelector('#command-palette')?.open === true"),
    "The command palette hotkey did not open its dialog",
  );
  const commandPaletteFocus = await evaluate(`(() => {
    const input = document.querySelector('#palette-query');
    const frame = document.querySelector('.palette-search');
    if (!(input instanceof HTMLInputElement) || !(frame instanceof HTMLElement)) return null;
    const style = getComputedStyle(frame);
    return {
      active: document.activeElement === input,
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
    };
  })()`);
  assert(
    commandPaletteFocus?.active === true &&
      commandPaletteFocus.outlineStyle === "solid" &&
      commandPaletteFocus.outlineWidth >= 2,
    `The command palette did not expose its focused query with a visible frame: ${JSON.stringify(commandPaletteFocus)}`,
  );
  await captureScreenshot("workspace-command-palette-dark");
  await pressKey("Escape", "Escape");
  await waitFor(
    () => evaluate("document.querySelector('#command-palette')?.open === false"),
    "The command palette did not close after focus verification",
  );

  assert(
    await evaluate(`(() => {
      const dialog = document.querySelector('#appearance-package-review-dialog');
      if (!(dialog instanceof HTMLDialogElement)) return false;
      dialog.showModal();
      return dialog.open;
    })()`),
    "The appearance review modal guard could not be armed.",
  );
  await pressKey("O", "KeyO", 2 | 8);
  await delay(100);
  assert(
    (await evaluate("document.querySelector('#quick-switcher')?.open === true")) === false,
    "The quick-switcher hotkey opened over appearance package review.",
  );
  assert(
    await evaluate(`(() => {
      const dialog = document.querySelector('#appearance-package-review-dialog');
      if (!(dialog instanceof HTMLDialogElement) || !dialog.open) return false;
      dialog.close();
      return !dialog.open;
    })()`),
    "The synthetic appearance review modal could not be disarmed.",
  );

  const closeTabMarker = "THREADLEAF-CLOSE-TAB-AUTOSAVE";
  await appendToPane("primary", `\n\n${closeTabMarker}`);
  await clickSelector('[data-pane-id="primary"] .note-tab-close[data-note-path="Linked Note.md"]');
  await waitFor(async () => {
    const state = await paneState("primary");
    const candidate = await snapshot();
    return state?.path === "Welcome.md" &&
      paneTabPaths(candidate, "primary").join("\n") === "Welcome.md"
      ? candidate
      : null;
  }, "Closing the edited tab did not flush it and select the neighboring note");
  assert(
    (await fs.readFile(path.join(vaultPath, "Linked Note.md"), "utf8")).includes(closeTabMarker),
    "Closing a tab mid-edit did not autosave its pending bytes.",
  );
  await clickSelector('[data-note-path="Linked Note.md"]');
  await waitFor(
    async () => (await paneState("primary"))?.path === "Linked Note.md",
    "The close-tab autosave fixture could not reopen Linked Note.md",
  );
  await pressKey("[", "BracketLeft", 2);
  await waitFor(
    async () => (await paneState("primary"))?.path === "Welcome.md",
    "The history hotkey did not traverse back to Welcome.md",
  );
  await clickSelector('[data-pane-id="primary"] .note-tab-close[data-note-path="Linked Note.md"]');
  await waitFor(async () => {
    const candidate = await snapshot();
    return paneTabPaths(candidate, "primary").join("\n") === "Welcome.md" ? candidate : null;
  }, "The temporary history tab did not close before the pane-layout checks");
  const historyDraftMarker = "THREADLEAF-HISTORY-AUTOSAVE";
  await appendToPane("primary", `\n\n${historyDraftMarker}`);
  assert(
    await evaluate("document.querySelector('#navigate-forward')?.disabled === false"),
    "The forward control was blocked while autosave was pending.",
  );
  await pressKey("]", "BracketRight", 2);
  await waitFor(
    async () => (await paneState("primary"))?.path === "Linked Note.md",
    "History navigation did not flush the pending edit and move forward.",
  );
  assert(
    (await fs.readFile(path.join(vaultPath, "Welcome.md"), "utf8")).includes(historyDraftMarker),
    "History navigation did not autosave the pending Welcome.md bytes.",
  );
  await pressKey("[", "BracketLeft", 2);
  await waitFor(
    async () => (await paneState("primary"))?.path === "Welcome.md",
    "History navigation did not return to Welcome.md after the autosave check.",
  );
  await clickSelector('[data-pane-id="primary"] .note-tab-close[data-note-path="Linked Note.md"]');
  await waitFor(async () => {
    const candidate = await snapshot();
    return paneTabPaths(candidate, "primary").join("\n") === "Welcome.md" ? candidate : null;
  }, "The autosave history tab did not close before pane-layout checks");

  await waitForThemeToggleReady();
  await clickSelector("#theme-toggle");
  await waitFor(
    () => evaluate("document.documentElement.dataset.theme === 'light'"),
    "The light theme did not become active for quick-switcher verification",
  );
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 900,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await pressKey("O", "KeyO", 2 | 8);
  await waitFor(
    () => evaluate("document.querySelector('#quick-switcher')?.open === true"),
    "The quick switcher did not reopen in the compact light viewport",
  );
  assert(
    await evaluate(`(() => {
      const dialog = document.querySelector('#quick-switcher');
      return dialog instanceof HTMLElement && dialog.scrollWidth <= dialog.clientWidth;
    })()`),
    "The quick switcher overflowed horizontally at the minimum viewport.",
  );
  await captureScreenshot("workspace-quick-switcher-light-minimum");
  await pressKey("Escape", "Escape");
  await waitForThemeToggleReady();
  await clickSelector("#theme-toggle");
  await waitFor(
    () => evaluate("document.documentElement.dataset.theme === 'dark'"),
    "The dark theme was not restored after quick-switcher verification",
  );
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 840,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await clickSelector("#split-pane-right");
  current = await waitFor(async () => {
    const candidate = await snapshot();
    return candidate.workspace?.panes.length === 2 &&
      candidate.workspace?.splitDirection === "vertical" &&
      candidate.workspace?.activePaneId === "secondary"
      ? candidate
      : null;
  }, "The right split did not create and focus a secondary pane");
  assert(
    (await evaluate('document.querySelector("#workspace-panes")?.dataset.splitDirection')) ===
      "vertical",
    "The persisted split was not visible in the renderer layout.",
  );
  await clickSelector('[data-note-path="Linked Note.md"]');
  await waitFor(
    async () => (await paneState("secondary"))?.path === "Linked Note.md",
    "Linked Note.md did not open in the secondary pane",
  );
  current = await snapshot();
  assert(
    paneTabPaths(current, "primary").join("\n") === "Welcome.md",
    `Opening the secondary note changed the primary tab set: ${JSON.stringify(current.workspace?.panes)}`,
  );

  phase = "inactive pane autosave independence";
  const inactiveDraftMarker = "THREADLEAF-INACTIVE-AUTOSAVE";
  await appendToPane("primary", `\n\n${inactiveDraftMarker}`);
  await focusPaneEditor("secondary");
  await waitFor(
    async () =>
      (await fs.readFile(path.join(vaultPath, "Welcome.md"), "utf8")).includes(inactiveDraftMarker),
    "Switching panes did not flush the inactive pane edit.",
  );
  assert(
    await evaluate(`(() => {
      const back = document.querySelector('[data-pane-id="secondary"] [id^="navigate-back"]');
      return back instanceof HTMLButtonElement && !back.disabled;
    })()`),
    "Autosaving an inactive pane disabled history in the active pane.",
  );
  await pressKey("O", "KeyO", 2 | 8);
  await waitFor(
    () => evaluate("document.querySelector('#quick-switcher')?.open === true"),
    "Autosaving an inactive pane blocked the active pane quick switcher",
  );
  await captureScreenshot("workspace-clean-pane-after-inactive-autosave");
  await pressKey("Escape", "Escape");

  phase = "independent pane editing";
  const primaryMarker = "THREADLEAF-PRIMARY-AUTOSAVE";
  const secondaryMarker = "THREADLEAF-SECONDARY-CRASH-DRAFT";
  const secondaryBeforePrimaryUndo = (await paneState("secondary")).text;
  await appendToPane("primary", `\n\n${primaryMarker}`);
  let primary = await paneState("primary");
  assert(primary.text.includes(primaryMarker), "The primary editor lost its own draft.");

  phase = "pane-local undo";
  await pressKey("z", "KeyZ", 2);
  await waitFor(
    async () => !(await paneState("primary"))?.text.includes(primaryMarker),
    "Undo did not stay in the primary editor",
  );
  assert(
    (await paneState("secondary")).text === secondaryBeforePrimaryUndo,
    "Primary undo changed the secondary editor.",
  );
  await pressKey("Z", "KeyZ", 2 | 8);
  await waitFor(
    async () => (await paneState("primary"))?.text.includes(primaryMarker),
    "Redo did not restore the primary draft",
  );
  await waitForDraft(vaultId, "primary", primaryMarker);
  await appendToPane("secondary", `\n\n${secondaryMarker}`);
  let secondary = await paneState("secondary");
  primary = await paneState("primary");
  assert(primary.text.includes(primaryMarker), "The primary editor lost its own autosaved edit.");
  assert(
    !primary.text.includes(secondaryMarker),
    "The secondary draft leaked into the primary editor.",
  );
  assert(secondary.text.includes(secondaryMarker), "The secondary editor lost its own draft.");
  assert(
    !secondary.text.includes(primaryMarker),
    "The primary edit leaked into the secondary editor.",
  );
  await waitFor(
    async () =>
      (await fs.readFile(path.join(vaultPath, "Welcome.md"), "utf8")).includes(primaryMarker),
    "Switching to the secondary pane did not autosave the primary edit.",
  );
  await waitForDraft(vaultId, "secondary", secondaryMarker);
  assert(
    (await readDraft(vaultId, "primary")) === null,
    "The autosaved primary pane retained a stale private draft.",
  );
  await captureScreenshot("workspace-autosaved-primary-with-secondary-crash-draft");

  phase = "full process crash";
  await crashApplication();
  await launchApplication();
  current = await waitForReady();
  assert(current.workspace.panes.length === 2, "The split layout did not survive process restart.");
  assert(
    current.workspace.splitDirection === "vertical",
    "The split direction did not survive restart.",
  );
  assert(
    current.workspace.activePaneId === "secondary",
    "The active pane did not survive restart.",
  );

  phase = "canonical and crash-draft recovery";
  await scrollPaneEditorToEnd("primary");
  await scrollPaneEditorToEnd("secondary");
  await delay(100);
  let recoveryObservation = null;
  try {
    await waitFor(
      async () => {
        primary = await paneState("primary");
        secondary = await paneState("secondary");
        recoveryObservation = {
          primary: primary
            ? {
                path: primary.path,
                hasMarker: primary.text.includes(primaryMarker),
                draftState: primary.draftState,
                editState: primary.editState,
              }
            : null,
          secondary: secondary
            ? {
                path: secondary.path,
                hasMarker: secondary.text.includes(secondaryMarker),
                draftState: secondary.draftState,
                editState: secondary.editState,
              }
            : null,
        };
        const secondaryRecoverySettled =
          secondary?.draftState === "saved" ||
          (secondary?.editState === "Saved" && (await readDraft(vaultId, "secondary")) === null);
        return primary?.text.includes(primaryMarker) &&
          secondary?.text.includes(secondaryMarker) &&
          secondaryRecoverySettled
          ? recoveryObservation
          : null;
      },
      "The canonical primary edit and secondary crash draft were not restored",
      15_000,
    );
  } catch (error) {
    const drafts = {
      primary: (await readDraft(vaultId, "primary")) !== null,
      secondary: (await readDraft(vaultId, "secondary")) !== null,
    };
    throw new Error(`Recovery observation: ${JSON.stringify({ recoveryObservation, drafts })}`, {
      cause: error,
    });
  }
  assert(
    (await paneState("secondary")).active,
    "Recovered focus is not visible on the secondary pane.",
  );
  current = await snapshot();
  assert(
    paneTabPaths(current, "primary").join("\n") === "Welcome.md",
    `Draft recovery changed the primary tab set: ${JSON.stringify(current.workspace?.panes)}`,
  );
  await captureScreenshot("workspace-canonical-and-crash-draft-recovered");

  phase = "independent autosave";
  await focusPaneEditor("primary");
  await waitFor(async () => {
    const state = await paneState("secondary");
    return state?.editState === "Saved" && (await readDraft(vaultId, "secondary")) === null;
  }, "The secondary recovered draft did not autosave and clear");
  await waitFor(async () => {
    const state = await paneState("primary");
    return state?.editState === "Saved" && (await readDraft(vaultId, "primary")) === null;
  }, "The primary autosaved edit did not remain clean");
  assert(
    (await fs.readFile(path.join(vaultPath, "Welcome.md"), "utf8")).includes(primaryMarker),
    "The primary autosaved bytes are missing.",
  );
  assert(
    (await fs.readFile(path.join(vaultPath, "Linked Note.md"), "utf8")).includes(secondaryMarker),
    "The secondary autosaved bytes are missing.",
  );
  current = await snapshot();
  assert(
    paneTabPaths(current, "primary").join("\n") === "Welcome.md",
    `Independent autosave changed the primary tab set: ${JSON.stringify(current.workspace?.panes)}`,
  );

  phase = "move tab and collapse pane";
  await clickSelector("#move-tab-pane");
  current = await waitFor(async () => {
    const candidate = await snapshot();
    const first = candidate.workspace?.panes.find((pane) => pane.id === "primary");
    const second = candidate.workspace?.panes.find((pane) => pane.id === "secondary");
    return first?.tabs.every((tab) => tab.path !== "Welcome.md") &&
      second?.tabs.some((tab) => tab.path === "Welcome.md" && tab.active)
      ? candidate
      : null;
  }, "The active tab did not move from primary to secondary");
  assert(
    current.workspace.panes.find((pane) => pane.id === "primary")?.tabs.length === 0,
    `The source pane retained tabs after moving its only tab: ${JSON.stringify(current.workspace.panes)}`,
  );
  await clickSelector('[data-pane-id="primary"]');
  await waitFor(
    async () =>
      (await snapshot()).workspace?.activePaneId === "primary" &&
      (await evaluate(
        `document.querySelector('[data-pane-id="primary"]')?.dataset.active === 'true'`,
      )),
    "The primary pane did not accept and visibly render focus before closing",
  );
  await clickSelector("#close-pane");
  current = await waitFor(async () => {
    const candidate = await snapshot();
    return candidate.workspace?.panes.length === 1 &&
      candidate.workspace?.activePaneId === "primary" &&
      candidate.workspace?.splitDirection === null
      ? candidate
      : null;
  }, "Closing the empty pane did not collapse the surviving pane");
  assert(
    current.workspace.panes[0].tabs.some((tab) => tab.path === "Welcome.md" && tab.active),
    `The collapsed pane lost the moved active tab: ${JSON.stringify(current.workspace.panes[0].tabs)}`,
  );
  const persistedCollapsed = JSON.parse(await fs.readFile(workspaceStatePath, "utf8"));
  assert(
    persistedCollapsed.version === 1 &&
      persistedCollapsed.layoutVersion === 2 &&
      persistedCollapsed.panes.length === 1 &&
      persistedCollapsed.panes[0].id === "primary" &&
      persistedCollapsed.splitDirection === null,
    "The collapsed layout was not durably persisted.",
  );

  phase = "collapsed layout restart";
  await closeApplication();
  await launchApplication();
  current = await waitForReady();
  assert(
    current.workspace.panes.length === 1 &&
      current.workspace.panes[0].activeNote?.path === "Welcome.md",
    "The collapsed layout did not survive a clean restart.",
  );
  await closeApplication();

  phase = "malformed layout recovery";
  const malformed = `${JSON.stringify(
    {
      version: 2,
      vaultId,
      panes: [
        { id: "primary", openPaths: ["Welcome.md"], activePath: "Welcome.md" },
        { id: "secondary", openPaths: ["Linked Note.md"], activePath: "Linked Note.md" },
      ],
      activePaneId: "secondary",
      splitDirection: null,
    },
    null,
    2,
  )}\n`;
  await fs.writeFile(workspaceStatePath, malformed, "utf8");
  await launchApplication();
  const fallback = await waitFor(async () => {
    const candidate = await snapshot();
    return candidate.workspace?.state === "ready" && candidate.vault?.warning ? candidate : null;
  }, "Malformed layout state did not produce a visible fallback warning");
  assert(fallback.workspace.panes.length === 1, "Malformed state did not fall back to one pane.");
  assert(
    fallback.vault.warning.includes("two panes require one") &&
      fallback.vault.warning.includes("file was not changed"),
    `Malformed state warning was not explanatory: ${fallback.vault.warning}`,
  );
  assert(
    (await evaluate('document.querySelector("#runtime-state")?.textContent')) === "Needs attention",
    "Malformed state recovery was not visible in the application chrome.",
  );
  assert(
    (await evaluate('document.querySelector("#watch-message")?.textContent'))?.includes(
      "file was not changed",
    ),
    "The visible recovery detail did not promise non-destructive handling.",
  );
  assert(
    (await fs.readFile(workspaceStatePath, "utf8")) === malformed,
    "Opening malformed layout state rewrote the source file.",
  );
  await captureScreenshot("workspace-malformed-state-recovery");
  await closeApplication();

  console.log(
    "Verified isolated virtual input, per-pane autosave across history and focus transitions, keyboard quick switching, light/dark minimum-viewport rendering, two-pane layout persistence, independent editors and undo histories, crash-draft recovery, clean autosaves, tab transfer, pane collapse, restart recovery, and non-destructive malformed-state fallback.",
  );
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
