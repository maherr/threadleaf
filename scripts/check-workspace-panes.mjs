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
  return waitFor(async () => {
    const current = await snapshot();
    return current?.workspace?.state === "ready" && current?.vault?.path === vaultPath
      ? current
      : null;
  }, "The isolated writable vault did not become ready");
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

async function clickSelector(selector) {
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
    return;
  }
  await fs.mkdir(screenshotDirectory, { recursive: true });
  const result = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  await fs.writeFile(path.join(screenshotDirectory, `${name}.png`), result.data, "base64");
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

  phase = "pointer-driven split";
  await clickSelector('[data-note-path="Welcome.md"]');
  await waitFor(
    async () => (await paneState("primary"))?.path === "Welcome.md",
    "Welcome.md did not open in the primary pane",
  );
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

  phase = "independent pane editing";
  const primaryMarker = "THREADLEAF-PRIMARY-DRAFT";
  const secondaryMarker = "THREADLEAF-SECONDARY-DRAFT";
  await appendToPane("primary", `\n\n${primaryMarker}`);
  await appendToPane("secondary", `\n\n${secondaryMarker}`);
  let primary = await paneState("primary");
  let secondary = await paneState("secondary");
  assert(primary.text.includes(primaryMarker), "The primary editor lost its own draft.");
  assert(
    !primary.text.includes(secondaryMarker),
    "The secondary draft leaked into the primary editor.",
  );
  assert(secondary.text.includes(secondaryMarker), "The secondary editor lost its own draft.");
  assert(
    !secondary.text.includes(primaryMarker),
    "The primary draft leaked into the secondary editor.",
  );
  await Promise.all([
    waitForDraft(vaultId, "primary", primaryMarker),
    waitForDraft(vaultId, "secondary", secondaryMarker),
  ]);

  phase = "pane-local undo";
  await focusPaneEditor("primary");
  await pressKey("z", "KeyZ", 2);
  await waitFor(
    async () => !(await paneState("primary"))?.text.includes(primaryMarker),
    "Undo did not stay in the primary editor",
  );
  assert(
    (await paneState("secondary")).text.includes(secondaryMarker),
    "Primary undo changed the secondary editor.",
  );
  await pressKey("Z", "KeyZ", 2 | 8);
  await waitFor(
    async () => (await paneState("primary"))?.text.includes(primaryMarker),
    "Redo did not restore the primary draft",
  );
  await waitForDraft(vaultId, "primary", primaryMarker);
  await focusPaneEditor("secondary");
  await captureScreenshot("workspace-two-pane-drafts");

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

  phase = "two-draft recovery";
  await waitFor(
    async () => {
      primary = await paneState("primary");
      secondary = await paneState("secondary");
      return primary?.text.includes(primaryMarker) &&
        primary.draftState === "saved" &&
        secondary?.text.includes(secondaryMarker) &&
        secondary.draftState === "saved"
        ? { primary, secondary }
        : null;
    },
    "Both independent drafts were not restored after the crash",
    15_000,
  );
  assert(
    (await paneState("secondary")).active,
    "Recovered focus is not visible on the secondary pane.",
  );
  await captureScreenshot("workspace-two-pane-recovered");

  phase = "independent save";
  await focusPaneEditor("secondary");
  await pressKey("s", "KeyS", 2);
  await waitFor(async () => {
    const state = await paneState("secondary");
    return state?.editState === "Saved" && (await readDraft(vaultId, "secondary")) === null;
  }, "The secondary recovered draft did not save and clear");
  await focusPaneEditor("primary");
  await pressKey("s", "KeyS", 2);
  await waitFor(async () => {
    const state = await paneState("primary");
    return state?.editState === "Saved" && (await readDraft(vaultId, "primary")) === null;
  }, "The primary recovered draft did not save and clear");
  assert(
    (await fs.readFile(path.join(vaultPath, "Welcome.md"), "utf8")).includes(primaryMarker),
    "The primary saved bytes are missing.",
  );
  assert(
    (await fs.readFile(path.join(vaultPath, "Linked Note.md"), "utf8")).includes(secondaryMarker),
    "The secondary saved bytes are missing.",
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
  await evaluate(`window.threadleaf.focusWorkspacePane("primary", ${JSON.stringify(vaultId)})`);
  await waitFor(
    async () => (await snapshot()).workspace?.activePaneId === "primary",
    "The primary pane did not accept focus before closing",
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
    "The collapsed pane lost the moved active tab.",
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
    "Verified isolated virtual input, two-pane layout persistence, independent editors and undo histories, two protected crash drafts, clean saves, tab transfer, pane collapse, restart recovery, and non-destructive malformed-state fallback.",
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
