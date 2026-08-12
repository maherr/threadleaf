import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const appRoot = process.cwd();
const electronPath = path.join(appRoot, "node_modules", ".bin", "electron");
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-note-workflows-"));
const vaultPath = path.join(testRoot, "vault");
const userDataPath = path.join(testRoot, "user-data");
const screenshotDirectory = process.env.THREADLEAF_NOTE_WORKFLOW_SCREENSHOT_DIR;
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
      if (
        message.method === "Runtime.exceptionThrown" ||
        message.method === "Runtime.consoleAPICalled"
      ) {
        output.push(`[CDP ${message.method}] ${JSON.stringify(message.params)}\n`);
      }
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
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      output.push(String(chunk));
      if (output.length > 160) {
        output.shift();
      }
    });
  }
  const target = await waitForMainTarget(port);
  cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
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
  const result = await Promise.race([
    exited,
    delay(5_000).then(() => ({ code: null, signal: "timeout" })),
  ]);
  if (result.code !== 0 && child.pid) {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process already exited.
    }
  }
  child = undefined;
  exited = undefined;
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
      const parent = Number(/^PPid:\s+(\d+)$/m.exec(status)?.[1] ?? -1);
      processes.push({
        pid: Number(entry.name),
        parent,
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

async function targetCenter(selector) {
  const target = await evaluate(
    "(() => {" +
      "const element = document.querySelector(" +
      JSON.stringify(selector) +
      ");" +
      "if (!(element instanceof HTMLElement)) return { error: 'missing' };" +
      "const rect = element.getBoundingClientRect();" +
      "const x = rect.left + rect.width / 2;" +
      "const y = rect.top + rect.height / 2;" +
      "const hit = document.elementFromPoint(x, y);" +
      "return {" +
      "error: null, x, y, width: rect.width, height: rect.height," +
      "hit: Boolean(hit && (hit === element || element.contains(hit)))," +
      "hidden: element.hidden || getComputedStyle(element).display === 'none'," +
      "disabled: 'disabled' in element ? Boolean(element.disabled) : false" +
      "};" +
      "})()",
  );
  assert(target && !target.error, `Pointer target is unavailable: ${selector}`);
  assert(!target.hidden && !target.disabled, `Pointer target is not interactive: ${selector}`);
  assert(target.width > 0 && target.height > 0, `Pointer target has no geometry: ${selector}`);
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

const virtualKeyCodes = {
  ArrowDown: 40,
  End: 35,
  Enter: 13,
  Home: 36,
};

async function pressKey(key, code, modifiers = 0) {
  const windowsVirtualKeyCode =
    virtualKeyCodes[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : undefined);
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

async function fillInput(selector, value) {
  await clickSelector(selector);
  await pressKey("a", "KeyA", 2);
  await cdp.send("Input.insertText", { text: value });
  const observed = await evaluate(
    `document.querySelector(${JSON.stringify(selector)})?.value ?? null`,
  );
  assert(observed === value, `The visible input did not commit its requested value: ${selector}`);
}

async function runPaletteCommand(commandId) {
  await clickSelector("#command-trigger");
  await cdp.send("Input.insertText", { text: commandId });
  const selector = `[data-command-id="${commandId}"]`;
  await waitFor(
    async () =>
      (await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`))
        ? true
        : null,
    `The command palette did not expose ${commandId}`,
  );
  await clickSelector(selector);
}

async function captureScreenshot(name) {
  if (!screenshotDirectory) {
    return;
  }
  await fs.mkdir(screenshotDirectory, { recursive: true });
  const result = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  });
  await fs.writeFile(path.join(screenshotDirectory, `${name}.png`), result.data, "base64");
}

async function assertWorkflowLayout() {
  const layout = await evaluate(
    "(() => {" +
      "const page = document.querySelector('[data-settings-page=notes]');" +
      "const dialog = document.querySelector('#shortcut-settings');" +
      "if (!(page instanceof HTMLElement) || !(dialog instanceof HTMLElement)) return null;" +
      "const rect = dialog.getBoundingClientRect();" +
      "return {" +
      "pageOverflow: page.scrollWidth - page.clientWidth," +
      "left: rect.left, top: rect.top, right: innerWidth - rect.right, bottom: innerHeight - rect.bottom" +
      "};" +
      "})()",
  );
  assert(layout, "The note workflow settings page has no measurable layout.");
  assert(layout.pageOverflow <= 1, "The note workflow settings overflowed horizontally.");
  assert(
    layout.left >= 0 && layout.top >= 0 && layout.right >= 0 && layout.bottom >= 0,
    "The settings dialog escaped the virtual viewport.",
  );
}

try {
  if (process.platform !== "linux") {
    throw new Error("The note workflow integration check currently requires Linux and Xvfb.");
  }
  await fs.access(electronPath);
  await fs.mkdir(path.join(vaultPath, "Templates"), { recursive: true });
  await fs.writeFile(path.join(vaultPath, "Inbox.md"), "Inbox body.\n");
  await fs.writeFile(
    path.join(vaultPath, "Templates", "Daily.md"),
    "# {{title}}\n\n{{date}} {{time}}\n",
  );
  await fs.writeFile(
    path.join(vaultPath, "Templates", "Meeting.md"),
    "# {{title}}\n\n{{date}} {{time}}\n{{unknown}}\n",
  );

  phase = "isolated launch";
  await launchApplication();
  await waitFor(async () => {
    const snapshot = await evaluate("window.threadleaf.getSnapshot()");
    return snapshot?.workspace?.state === "ready" && snapshot?.vault?.path === vaultPath
      ? snapshot
      : null;
  }, "The isolated workflow vault did not become ready");
  await assertIsolatedX11Renderer();

  phase = "settings with virtual input";
  await clickSelector("#settings-trigger");
  await clickSelector("#settings-nav-notes");
  await waitFor(
    async () =>
      (await evaluate("document.querySelector('#workflow-template-count')?.textContent")) ===
      "2 templates found",
    "The settings page did not discover both templates",
  );
  await fillInput("#workflow-date-format", "[DATE]");
  await fillInput("#workflow-time-format", "[TIME]");
  await fillInput("#workflow-daily-folder", "Journal");
  await fillInput("#workflow-daily-format", "[Today]");
  await clickSelector("#workflow-daily-template");
  await pressKey("Home", "Home");
  await pressKey("ArrowDown", "ArrowDown");
  await pressKey("Enter", "Enter");
  const selectedDailyTemplate = await evaluate(
    "document.querySelector('#workflow-daily-template')?.value",
  );
  assert(
    selectedDailyTemplate === "Templates/Daily.md",
    `Virtual select input chose ${JSON.stringify(selectedDailyTemplate)}, not the daily-note template.`,
  );
  await clickSelector("#workflow-save");
  await waitFor(async () => {
    const response = await evaluate(
      "(async () => { const snapshot = await window.threadleaf.getSnapshot(); return window.threadleaf.getNoteWorkflows(snapshot.vault.id); })()",
    );
    return response?.status === "ready" &&
      response.settings.templateDateFormat === "[DATE]" &&
      response.settings.templateTimeFormat === "[TIME]" &&
      response.settings.dailyNoteFolder === "Journal" &&
      response.settings.dailyNoteDateFormat === "[Today]" &&
      response.settings.dailyNoteTemplate === "Templates/Daily.md"
      ? response
      : null;
  }, "The workflow preferences did not persist through the desktop bridge");
  await assertWorkflowLayout();
  await captureScreenshot("note-workflows-settings-dark");
  const outlined = await evaluate(
    "(() => {" +
      "const form = document.querySelector('#note-workflow-form');" +
      "if (!(form instanceof HTMLElement)) return false;" +
      "form.style.outline = '8px solid rgb(0, 114, 178)';" +
      "return getComputedStyle(form).outlineWidth === '8px';" +
      "})()",
  );
  assert(outlined, "The screenshot positive control did not reach the workflow form.");
  await captureScreenshot("note-workflows-positive-control");
  await evaluate(
    "document.querySelector('#note-workflow-form')?.style.removeProperty('outline'); true",
  );
  await clickSelector("#settings-done");

  phase = "template insertion";
  await clickSelector('[data-note-path="Inbox.md"]');
  await waitFor(
    async () =>
      (await evaluate("document.querySelector('#note-path')?.textContent")) === "Inbox.md",
    "Inbox.md did not open",
  );
  await runPaletteCommand("editor.insert-template");
  await waitFor(
    async () =>
      (await evaluate("document.querySelector('#template-picker-dialog')?.open")) === true,
    "The template picker did not open",
  );
  await clickSelector("#template-picker-select");
  await pressKey("End", "End");
  await pressKey("Enter", "Enter");
  const selectedMeetingTemplate = await evaluate(
    "document.querySelector('#template-picker-select')?.value",
  );
  assert(
    selectedMeetingTemplate === "Templates/Meeting.md",
    `Virtual select input chose ${JSON.stringify(selectedMeetingTemplate)}, not the meeting template.`,
  );
  await captureScreenshot("note-workflows-template-picker-dark");
  await clickSelector("#template-picker-insert");
  await waitFor(
    async () =>
      (await evaluate("document.querySelector('#edit-state')?.textContent")) === "Unsaved",
    "The expanded template did not enter the editor draft",
  );
  assert(
    (await fs.readFile(path.join(vaultPath, "Inbox.md"), "utf8")) === "Inbox body.\n",
    "Template insertion wrote the note before the explicit save.",
  );
  await runPaletteCommand("editor.insert-current-date");
  await waitFor(async () => {
    const state = await evaluate(
      "(() => { const text = document.querySelector('#note-editor .cm-content')?.textContent ?? ''; return { paletteOpen: document.querySelector('#command-palette')?.open, dateCount: text.split('DATE').length - 1 }; })()",
    );
    return !state.paletteOpen && state.dateCount >= 2 ? state : null;
  }, "The current date command did not finish inserting into the editor");
  await cdp.send("Input.insertText", { text: " " });
  await runPaletteCommand("editor.insert-current-time");
  await waitFor(async () => {
    const state = await evaluate(
      "(() => { const text = document.querySelector('#note-editor .cm-content')?.textContent ?? ''; const save = document.querySelector('#save-note'); return { paletteOpen: document.querySelector('#command-palette')?.open, timeCount: text.split('TIME').length - 1, saveDisabled: save instanceof HTMLButtonElement ? save.disabled : null }; })()",
    );
    return !state.paletteOpen && state.timeCount >= 2 && state.saveDisabled === false
      ? state
      : null;
  }, "The current time command did not finish inserting into the editor");
  await pressKey("s", "KeyS", 2);
  let observedSaveState;
  await waitFor(
    async () => {
      observedSaveState = await evaluate(
        "(() => ({ state: document.querySelector('#edit-state')?.textContent, saveDisabled: document.querySelector('#save-note')?.disabled, active: document.activeElement?.className ?? '' }))()",
      );
      return observedSaveState.state === "Saved" ? observedSaveState : null;
    },
    `The expanded template draft did not save: ${JSON.stringify(observedSaveState)}`,
  );
  const expectedInbox = "# Inbox\n\nDATE TIME\n{{unknown}}\nDATE TIMEInbox body.\n";
  assert(
    (await fs.readFile(path.join(vaultPath, "Inbox.md"), "utf8")) === expectedInbox,
    "Template, date, or time insertion changed unexpected Markdown bytes.",
  );

  phase = "daily note create and reopen";
  await runPaletteCommand("workspace.open-daily-note");
  await waitFor(
    async () =>
      (await evaluate("document.querySelector('#note-path')?.textContent")) === "Journal/Today.md",
    "Today's daily note did not open",
  );
  const expectedDaily = "# Today\n\nDATE TIME\n";
  assert(
    (await fs.readFile(path.join(vaultPath, "Journal", "Today.md"), "utf8")) === expectedDaily,
    "The daily note did not preserve its expanded template bytes.",
  );
  await captureScreenshot("note-workflows-daily-note-dark");
  await runPaletteCommand("workspace.open-daily-note");
  assert(
    (await fs.readFile(path.join(vaultPath, "Journal", "Today.md"), "utf8")) === expectedDaily,
    "Reopening today's note rewrote its existing Markdown.",
  );

  phase = "light theme";
  await clickSelector("#theme-toggle");
  await waitFor(
    async () => (await evaluate("document.documentElement.dataset.theme")) === "light",
    "The workflow surface did not switch to light mode",
  );
  await clickSelector("#settings-trigger");
  await clickSelector("#settings-nav-notes");
  await assertWorkflowLayout();
  await captureScreenshot("note-workflows-settings-light");
  await clickSelector("#settings-done");
  await runPaletteCommand("editor.insert-template");
  await captureScreenshot("note-workflows-template-picker-light");
  await clickSelector("#template-picker-cancel");
  await closeApplication();

  console.log(
    "Verified isolated X11 virtual input, workflow settings persistence, exact template/date/time insertion, recoverable daily-note creation, no-rewrite reopen behavior, and dark/light screenshots.",
  );
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  const logs = output.join("").trim();
  const phased = `Phase ${phase}: ${detail}`;
  throw new Error(logs ? `${phased}\nElectron output:\n${logs}` : phased, { cause: error });
} finally {
  cdp?.close();
  if (child?.pid) {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process already exited.
    }
  }
  await fs.rm(testRoot, { recursive: true, force: true });
}
