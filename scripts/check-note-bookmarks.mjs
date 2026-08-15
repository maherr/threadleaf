import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const appRoot = process.cwd();
const electronPath = path.join(appRoot, "node_modules", ".bin", "electron");
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-note-bookmarks-"));
const vaultPath = path.join(testRoot, "vault");
const userDataPath = path.join(testRoot, "user-data");
const screenshotDirectory = process.env.THREADLEAF_BOOKMARK_SCREENSHOT_DIR;
const output = [];
const colourAudit = {};
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
  assert(result.code === 0, `Electron did not exit cleanly: ${JSON.stringify(result)}`);
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

async function targetCenter(selector) {
  const target = await evaluate(
    "(() => {" +
      "const element = document.querySelector(" +
      JSON.stringify(selector) +
      ");" +
      "if (!(element instanceof Element)) return { error: 'missing' };" +
      "const rect = element.getBoundingClientRect();" +
      "const x = rect.left + rect.width / 2;" +
      "const y = rect.top + rect.height / 2;" +
      "const hit = document.elementFromPoint(x, y);" +
      "return { error: null, x, y, width: rect.width, height: rect.height," +
      "hit: Boolean(hit && (hit === element || element.contains(hit)))," +
      "hidden: element instanceof HTMLElement ? element.hidden || getComputedStyle(element).display === 'none' : false," +
      "disabled: 'disabled' in element ? Boolean(element.disabled) : false };" +
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

const virtualKeyCodes = { Backspace: 8 };

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
  if (value) {
    await cdp.send("Input.insertText", { text: value });
  } else {
    await pressKey("Backspace", "Backspace");
  }
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
  const result = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  });
  if (screenshotDirectory) {
    await fs.mkdir(screenshotDirectory, { recursive: true });
    await fs.writeFile(path.join(screenshotDirectory, `${name}.png`), result.data, "base64");
  }
  return result.data;
}

async function waitForReady() {
  const state = await waitFor(async () => {
    const state = await evaluate(
      "(async () => { const snapshot = await window.threadleaf.getSnapshot(); return { ready: snapshot.workspace?.state === 'ready', path: snapshot.vault?.path ?? '', count: snapshot.workspace?.files?.length ?? 0, bookmarkDisabled: document.querySelector('#bookmark-note')?.disabled ?? true }; })()",
    );
    return state.ready && state.path === vaultPath && state.count === 2 ? state : null;
  }, "The isolated bookmark vault did not become ready");
  await ensureFlatNavigator();
  return state;
}

// Bookmark assertions intentionally retain their flat-list fixture. The
// folder tree itself is exercised in check-navigator-tree.
async function ensureFlatNavigator() {
  const mode = await waitFor(async () => {
    const value = await evaluate('document.querySelector("#file-list")?.dataset.mode ?? null');
    return value === "tree" || value === "virtual" ? value : null;
  }, "The navigator did not render before bookmark checks");
  if (mode === "tree") await clickSelector("#navigator-view-toggle");
  await waitFor(
    async () =>
      (await evaluate('document.querySelector("#file-list")?.dataset.mode')) === "virtual"
        ? true
        : null,
    "The bookmark fixture could not select the flat navigator",
  );
}

async function ensureTreeNavigator() {
  const mode = await waitFor(async () => {
    const value = await evaluate('document.querySelector("#file-list")?.dataset.mode ?? null');
    return value === "tree" || value === "virtual" ? value : null;
  }, "The navigator did not render before the narrow bookmark check");
  if (mode === "virtual") await clickSelector("#navigator-view-toggle");
  await waitFor(
    async () =>
      (await evaluate('document.querySelector("#file-list")?.dataset.mode')) === "tree"
        ? true
        : null,
    "The narrow bookmark check could not restore the tree navigator",
  );
}

async function bookmarkState() {
  return evaluate(
    "(() => ({ shelfHidden: document.querySelector('#bookmark-shelf')?.hidden ?? true, count: Number(document.querySelector('#bookmark-count')?.textContent ?? '-1'), paths: [...document.querySelectorAll('.bookmark-row')].map((row) => row.getAttribute('data-note-path')), missing: [...document.querySelectorAll('.bookmark-row[data-missing=\"true\"]')].map((row) => row.getAttribute('data-note-path')), pressed: document.querySelector('#bookmark-note')?.getAttribute('aria-pressed') ?? null, disabled: document.querySelector('#bookmark-note')?.disabled ?? true }))()",
  );
}

async function waitForBookmarks(expectedPaths) {
  return waitFor(
    async () => {
      const state = await bookmarkState();
      return JSON.stringify(state.paths) === JSON.stringify(expectedPaths) ? state : null;
    },
    `Bookmark shelf did not reach ${JSON.stringify(expectedPaths)}`,
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

async function bookmarkColours() {
  return evaluate(
    "(() => {" +
      "const current = document.querySelector('.bookmark-row[data-current=\"true\"]');" +
      "const normal = document.querySelector('.bookmark-row:not([data-missing=\"true\"]) .bookmark-open-mark');" +
      "const missing = document.querySelector('.bookmark-row[data-missing=\"true\"] .bookmark-open-mark');" +
      "const missingRow = document.querySelector('.bookmark-row[data-missing=\"true\"]');" +
      "const shelf = document.querySelector('#bookmark-shelf');" +
      "if (!(current instanceof HTMLElement) || !(normal instanceof HTMLElement) || !(missing instanceof HTMLElement) || !(missingRow instanceof HTMLElement) || !(shelf instanceof HTMLElement)) return null;" +
      "return { currentSoft: getComputedStyle(current).backgroundColor, accentStrong: getComputedStyle(normal).color, signalStrong: getComputedStyle(missing).color, signalEdge: getComputedStyle(missingRow).borderLeftColor, ground: getComputedStyle(shelf).backgroundColor };" +
      "})()",
  );
}

async function readPersistedBookmarks() {
  const directoryPath = path.join(userDataPath, "bookmarks");
  const entries = await fs.readdir(directoryPath);
  assert(entries.length === 1, `Expected one private bookmark file, found ${entries.length}.`);
  const filePath = path.join(directoryPath, entries[0]);
  const [raw, stat] = await Promise.all([fs.readFile(filePath, "utf8"), fs.stat(filePath)]);
  return { filePath, value: JSON.parse(raw), mode: stat.mode & 0o777 };
}

try {
  assert(process.platform === "linux", "The bookmark integration check requires Linux and Xvfb.");
  await fs.access(electronPath);
  await fs.mkdir(path.join(vaultPath, "Folder"), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(vaultPath, "Welcome.md"), "# Welcome\n\nPrivate bookmark fixture.\n"),
    fs.writeFile(path.join(vaultPath, "Folder", "Second.md"), "# Second\n\nMove me.\n"),
  ]);

  phase = "isolated launch";
  await launchApplication();
  await waitForReady();
  await assertIsolatedX11Renderer();
  await setTheme("dark");

  phase = "toolbar and command bookmarking";
  await clickSelector('#file-list [data-note-path="Welcome.md"]');
  await waitFor(
    async () =>
      (await evaluate("document.querySelector('#note-path')?.textContent")) === "Welcome.md",
    "The real pointer did not open Welcome.md",
  );
  await clickSelector("#bookmark-note");
  let state = await waitForBookmarks(["Welcome.md"]);
  assert(
    !state.shelfHidden && state.count === 1 && state.pressed === "true",
    "The toolbar did not expose its persisted pressed state.",
  );

  await clickSelector('#file-list [data-note-path="Folder/Second.md"]');
  await waitFor(
    async () =>
      (await evaluate("document.querySelector('#note-path')?.textContent")) === "Folder/Second.md",
    "The real pointer did not open Folder/Second.md",
  );
  await runPaletteCommand("workspace.toggle-note-bookmark");
  state = await waitForBookmarks(["Welcome.md", "Folder/Second.md"]);
  assert(state.pressed === "true", "The command palette did not update the toolbar state.");

  phase = "secondary pane bookmark control";
  await clickSelector("#split-pane-right");
  await waitFor(
    async () =>
      (await evaluate(
        "(() => { const pane = document.querySelector('#workspace-pane-secondary'); const button = document.querySelector('#bookmark-note-secondary'); return pane instanceof HTMLElement && !pane.hidden && pane.dataset.active === 'true' && button?.getAttribute('aria-pressed') === 'true'; })()",
      )) === true,
    "The secondary pane did not expose the active note bookmark control",
  );
  await clickSelector("#bookmark-note-secondary");
  await waitForBookmarks(["Welcome.md"]);
  await clickSelector("#bookmark-note-secondary");
  await waitForBookmarks(["Welcome.md", "Folder/Second.md"]);
  await clickSelector("#close-pane-secondary");
  await waitFor(
    async () =>
      (await evaluate("document.querySelector('#workspace-pane-secondary')?.hidden")) === true,
    "The secondary pane did not close after its bookmark control passed",
  );

  const persistedBeforeMove = await readPersistedBookmarks();
  assert(persistedBeforeMove.mode === 0o600, "Private bookmark state is not owner-only.");
  assert(
    JSON.stringify(persistedBeforeMove.value.paths) ===
      JSON.stringify(["Welcome.md", "Folder/Second.md"]),
    "Private bookmark storage did not preserve insertion order.",
  );
  const vaultRootEntries = await fs.readdir(vaultPath);
  assert(
    !vaultRootEntries.some((entry) => entry === ".obsidian" || entry.startsWith(".threadleaf")),
    "Bookmarking wrote application state into the vault.",
  );

  phase = "move-safe remap";
  await clickSelector("#move-note");
  await fillInput("#move-note-target", "Folder/Renamed.md");
  await clickSelector("#move-note-submit");
  await waitForBookmarks(["Welcome.md", "Folder/Renamed.md"]);
  await waitFor(
    async () => (await evaluate("document.querySelector('#move-note-dialog')?.open")) === false,
    "The committed move did not close its dialog",
  );
  await fs.access(path.join(vaultPath, "Folder", "Renamed.md"));
  await fs
    .access(path.join(vaultPath, "Folder", "Second.md"))
    .then(() => {
      throw new Error("The old note path survived the committed move.");
    })
    .catch((error) => {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    });
  const persistedAfterMove = await readPersistedBookmarks();
  assert(
    JSON.stringify(persistedAfterMove.value.paths) ===
      JSON.stringify(["Welcome.md", "Folder/Renamed.md"]),
    "The internal move did not remap the private bookmark.",
  );

  phase = "restart persistence";
  await closeApplication();
  await launchApplication();
  await waitForReady();
  await assertIsolatedX11Renderer();
  await setTheme("dark");
  await waitForBookmarks(["Welcome.md", "Folder/Renamed.md"]);

  phase = "missing bookmark";
  await clickSelector('#file-list [data-note-path="Welcome.md"]');
  await fs.unlink(path.join(vaultPath, "Folder", "Renamed.md"));
  state = await waitFor(async () => {
    const next = await bookmarkState();
    return next.missing.includes("Folder/Renamed.md") ? next : null;
  }, "The deleted note did not remain as an explicit missing bookmark");
  assert(state.count === 2, "The watcher silently discarded a missing bookmark.");
  colourAudit.dark = await bookmarkColours();
  await captureScreenshot("bookmarks-missing-dark");

  const baseline = await captureScreenshot("bookmarks-dark-baseline");
  const positiveControlReached = await evaluate(
    "(() => { const shelf = document.querySelector('#bookmark-shelf'); if (!(shelf instanceof HTMLElement)) return false; shelf.style.boxShadow = 'inset 0 0 0 10px rgb(230, 159, 0)'; return getComputedStyle(shelf).boxShadow.includes('10px'); })()",
  );
  assert(
    positiveControlReached,
    "The screenshot positive control did not reach the bookmark shelf.",
  );
  const positiveControl = await captureScreenshot("bookmarks-positive-control");
  assert(positiveControl !== baseline, "The screenshot positive control changed no pixels.");
  await evaluate(
    "document.querySelector('#bookmark-shelf')?.style.removeProperty('box-shadow'); true",
  );

  phase = "light and narrow layouts";
  await setTheme("light");
  colourAudit.light = await bookmarkColours();
  await captureScreenshot("bookmarks-missing-light");
  await ensureTreeNavigator();
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 640,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const narrowLayout = await waitFor(async () => {
    const value = await evaluate(
      "(() => { const shelf = document.querySelector('#bookmark-shelf'); const navigator = document.querySelector('.navigator'); if (!(shelf instanceof HTMLElement) || !(navigator instanceof HTMLElement)) return null; const rect = shelf.getBoundingClientRect(); return { width: innerWidth, left: rect.left, right: innerWidth - rect.right, shelfOverflow: shelf.scrollWidth - shelf.clientWidth, navigatorOverflow: navigator.scrollWidth - navigator.clientWidth }; })()",
    );
    return value?.width === 640 ? value : null;
  }, "The narrow bookmark viewport did not apply");
  assert(
    narrowLayout.left >= 0 &&
      narrowLayout.right >= 0 &&
      narrowLayout.shelfOverflow <= 1 &&
      narrowLayout.navigatorOverflow <= 1,
    `The bookmark shelf did not fit the narrow viewport: ${JSON.stringify(narrowLayout)}`,
  );
  await captureScreenshot("bookmarks-narrow-light");
  await cdp.send("Emulation.clearDeviceMetricsOverride");

  phase = "explicit removal";
  await clickSelector('.bookmark-row[data-note-path="Folder/Renamed.md"] .bookmark-remove');
  await waitForBookmarks(["Welcome.md"]);
  const persistedAfterRemoval = await readPersistedBookmarks();
  assert(
    JSON.stringify(persistedAfterRemoval.value.paths) === JSON.stringify(["Welcome.md"]),
    "Removing a missing bookmark did not update private storage.",
  );
  await closeApplication();

  console.log(
    "Verified isolated X11 note bookmarks, real toolbar and command input, private persistence, move remapping, explicit missing state, removal, and dark, light, and narrow layouts.",
  );
  console.log(`BOOKMARK_COLOURS=${JSON.stringify(colourAudit)}`);
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
