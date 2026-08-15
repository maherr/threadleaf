import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs, watch as watchFile } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const appRoot = process.cwd();
const electronPath = path.join(appRoot, "node_modules", ".bin", "electron");
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-navigator-tree-"));
const vaultPath = path.join(testRoot, "vault");
const userDataPath = path.join(testRoot, "user-data");
const screenshotDirectory = process.env.THREADLEAF_NAVIGATOR_TREE_SCREENSHOT_DIR;
const processMarker = randomUUID();
const output = [];
const outsidePath = path.join(testRoot, "outside");
const symlinkParentPath = path.join(vaultPath, "Symlink parent");
const fileParentPath = path.join(vaultPath, "File parent");
const absoluteBlockedFolderPath = path.join(outsidePath, "Absolute workspace folder");
let child;
let exited;
let cdp;
let phase = "setup";

const longActiveName =
  "Active note with an intentionally very long label that must visibly truncate inside the narrow navigator row";
const activeNotePath = `Projects/Deep/${longActiveName}.md`;
const deepRevealSegments = Array.from(
  { length: 128 },
  (_, index) => `Deep reveal ${String(index).padStart(3, "0")}`,
);
const deepRevealActivePath = `${deepRevealSegments.join("/")}/Target.md`;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function treeSelector(treePath) {
  return `.navigator-tree-row[data-tree-path=${JSON.stringify(treePath)}]`;
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
    throw new Error("Could not reserve an isolated loopback CDP port.");
  }
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
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
  }, "Threadleaf did not expose its isolated main renderer in time");
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

async function snapshot() {
  return evaluate("window.threadleaf.getSnapshot()");
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
      hitDescription:
        hit instanceof Element
          ? hit.tagName.toLowerCase() + "#" + hit.id + "." + [...hit.classList].join(".")
          : null,
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
  assert(target.hit, `Pointer target is covered: ${selector}; observed=${JSON.stringify(target)}`);
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

async function rightClickSelector(selector) {
  const target = await targetCenter(selector);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    button: "none",
    buttons: 0,
    x: target.x,
    y: target.y,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "right",
    buttons: 2,
    clickCount: 1,
    x: target.x,
    y: target.y,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "right",
    buttons: 0,
    clickCount: 1,
    x: target.x,
    y: target.y,
  });
}

async function pressKey(key, code, modifiers = 0) {
  const virtualKey = {
    ArrowDown: 40,
    ArrowLeft: 37,
    ArrowRight: 39,
    ArrowUp: 38,
    Backspace: 8,
    End: 35,
    Enter: 13,
    Home: 36,
  }[key];
  await cdp.send("Input.dispatchKeyEvent", {
    type: key.length === 1 ? "keyDown" : "rawKeyDown",
    code,
    key,
    modifiers,
    windowsVirtualKeyCode: virtualKey,
    nativeVirtualKeyCode: virtualKey,
    ...(key.length === 1 ? { text: key } : {}),
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    code,
    key,
    modifiers,
    windowsVirtualKeyCode: virtualKey,
    nativeVirtualKeyCode: virtualKey,
  });
}

async function fillInput(selector, value) {
  await clickSelector(selector);
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    code: "KeyA",
    key: "a",
    modifiers: 2,
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    code: "KeyA",
    key: "a",
    modifiers: 2,
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
  });
  await pressKey("Backspace", "Backspace");
  await cdp.send("Input.insertText", { text: value });
  const observed = await evaluate(
    `document.querySelector(${JSON.stringify(selector)})?.value ?? null`,
  );
  assert(observed === value, `The visible input did not commit ${JSON.stringify(value)}.`);
}

async function captureScreenshot(name) {
  const result = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  if (screenshotDirectory) {
    await fs.mkdir(screenshotDirectory, { recursive: true });
    await fs.writeFile(path.join(screenshotDirectory, `${name}.png`), result.data, "base64");
  }
  return result.data;
}

async function setTheme(theme) {
  if ((await evaluate("document.documentElement.dataset.theme")) !== theme) {
    await clickSelector("#theme-toggle");
  }
  await waitFor(
    async () =>
      (await evaluate("document.documentElement.dataset.theme")) === theme ? true : null,
    `Threadleaf did not switch to ${theme} mode`,
  );
}

async function markedProcessIds() {
  const marker = Buffer.from(`THREADLEAF_NAVIGATOR_TREE_RUN=${processMarker}\0`);
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

async function terminateMarkedProcesses() {
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const processIds = await markedProcessIds();
      if (processIds.length === 0) return;
      for (const processId of processIds) {
        try {
          process.kill(processId, signal);
        } catch {
          // The process already exited.
        }
      }
      await delay(100);
    }
  }
  const remaining = await markedProcessIds();
  assert(remaining.length === 0, `Could not stop navigator-tree test processes: ${remaining}`);
}

async function descendantRendererCommandLines(rootProcessId) {
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
        processId: Number(entry.name),
        parentProcessId: Number(/^PPid:\s+(\d+)$/m.exec(status)?.[1] ?? -1),
        commandLine: commandLine.toString("utf8").replaceAll("\0", " "),
      });
    } catch {
      // A short-lived process disappeared between reads.
    }
  }
  const descendants = new Set([rootProcessId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes) {
      if (!descendants.has(process.processId) && descendants.has(process.parentProcessId)) {
        descendants.add(process.processId);
        changed = true;
      }
    }
  }
  return processes
    .filter(
      (process) =>
        descendants.has(process.processId) && process.commandLine.includes("--type=renderer"),
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
    "A navigator-tree renderer escaped the X11 virtual display.",
  );
  assert(
    commandLines.every((line) => !line.includes("--ozone-platform=wayland")),
    "A navigator-tree renderer selected Wayland instead of X11.",
  );
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
        THREADLEAF_NAVIGATOR_TREE_RUN: processMarker,
        THREADLEAF_SAFE_PLUGINS: "1",
        THREADLEAF_VAULT_PATH: vaultPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      output.push(String(chunk));
      if (output.length > 160) output.shift();
    });
  }
  const target = await waitForMainTarget(port);
  cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
}

async function closeApplication() {
  if (!child) return;
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
  if (result.code !== 0) await terminateMarkedProcesses();
  child = undefined;
  exited = undefined;
}

async function waitForReady() {
  return waitFor(
    async () => {
      const current = await snapshot();
      return current?.workspace?.state === "ready" &&
        current?.vault?.path === vaultPath &&
        current?.workspace?.census?.indexed >= 1_005
        ? current
        : null;
    },
    "The navigator-tree fixture vault did not become ready",
    30_000,
  );
}

async function waitForTreePath(treePath) {
  try {
    return await waitFor(
      async () =>
        (await evaluate(
          `(() => { const item = document.querySelector(${JSON.stringify(treeSelector(treePath))}); return item instanceof HTMLElement ? { expanded: item.getAttribute("aria-expanded"), current: item.getAttribute("aria-current"), selected: item.getAttribute("aria-selected") } : null; })()`,
        )) ?? null,
      `The tree did not render ${treePath}`,
    );
  } catch (error) {
    const observed = await evaluate(`(() => {
      const list = document.querySelector("#file-list");
      if (!(list instanceof HTMLElement)) return null;
      return {
        busy: list.getAttribute("aria-busy"),
        scrollTop: list.scrollTop,
        scrollHeight: list.scrollHeight,
        clientHeight: list.clientHeight,
        rows: [...list.querySelectorAll(".navigator-tree-row")].map((row) => row.getAttribute("data-tree-path")),
      };
    })()`);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}. Observed virtual tree: ${JSON.stringify(observed)}`,
      { cause: error },
    );
  }
}

async function waitForFocusedTreePath(treePath) {
  try {
    return await waitFor(
      async () =>
        await evaluate(
          `document.activeElement?.getAttribute("data-tree-path") === ${JSON.stringify(treePath)} ? true : null`,
        ),
      `Tree focus did not reach ${treePath}`,
    );
  } catch (error) {
    const observed = await evaluate(`(() => ({
      active: document.activeElement?.getAttribute("data-tree-path") ?? null,
      rendered: [...document.querySelectorAll(".navigator-tree-row")].map((row) => ({
        path: row.getAttribute("data-tree-path"),
        tabIndex: row.getAttribute("tabindex"),
      })),
    }))()`);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; observed=${JSON.stringify(observed)}`,
      { cause: error },
    );
  }
}

async function writeFixtureVault() {
  await fs.mkdir(path.join(vaultPath, "Projects", "Deep"), { recursive: true });
  await fs.mkdir(path.join(vaultPath, "Library"), { recursive: true });
  await fs.mkdir(path.join(vaultPath, ...deepRevealSegments), { recursive: true });
  await fs.mkdir(outsidePath, { recursive: true });
  await fs.symlink(outsidePath, symlinkParentPath, "dir");
  await Promise.all([
    fs.writeFile(path.join(vaultPath, "Welcome.md"), "# Welcome\n", "utf8"),
    fs.writeFile(
      path.join(
        vaultPath,
        "A root note with an intentionally very long navigator label for truncation coverage.md",
      ),
      "# Root long label\n",
      "utf8",
    ),
    fs.writeFile(path.join(vaultPath, "Projects", "Reference.md"), "# Reference\n", "utf8"),
    fs.writeFile(path.join(vaultPath, activeNotePath), "# Active deep note\n", "utf8"),
    fs.writeFile(path.join(vaultPath, deepRevealActivePath), "# Deep reveal target\n", "utf8"),
    fs.writeFile(fileParentPath, "not a folder\n", "utf8"),
  ]);
  const children = Array.from({ length: 1_001 }, (_, index) => {
    const name = `Child-${String(index).padStart(4, "0")}.md`;
    return fs.writeFile(path.join(vaultPath, "Library", name), `# ${name}\n`, "utf8");
  });
  for (let index = 0; index < children.length; index += 64) {
    await Promise.all(children.slice(index, index + 64));
  }
}

try {
  assert(
    process.platform === "linux",
    "The navigator-tree integration check requires Linux and Xvfb.",
  );
  await fs.access(electronPath);
  await writeFixtureVault();

  phase = "isolated X11 launch";
  await launchApplication();
  await waitForReady();
  await assertIsolatedX11Renderer();

  phase = "initial collapsed tree";
  const initialTree = await waitFor(async () => {
    const tree = await evaluate(`(() => {
      const list = document.querySelector("#file-list");
      const rows = [...document.querySelectorAll(".navigator-tree-row")];
      return list?.getAttribute("role") === "tree" &&
        document.querySelector(${JSON.stringify(treeSelector("Projects"))}) &&
        document.querySelector(${JSON.stringify(treeSelector("Library"))}) &&
        rows.every((row) => !row.getAttribute("data-tree-path")?.includes("/"))
        ? { rows: rows.length, toggle: document.querySelector("#navigator-view-toggle")?.getAttribute("aria-pressed") }
        : null;
    })()`);
    return tree?.toggle === "true" ? tree : null;
  }, "The tree did not start with only top-level entries visible");
  assert(initialTree.rows < 12, "The initial navigator eagerly rendered nested entries.");

  phase = "keyboard hierarchy traversal";
  await evaluate(
    `document.querySelector(${JSON.stringify(treeSelector("Projects"))})?.focus(); true`,
  );
  await waitForFocusedTreePath("Projects");
  await pressKey("ArrowRight", "ArrowRight");
  await waitFor(async () => {
    const item = await waitForTreePath("Projects");
    return item.expanded === "true" ? item : null;
  }, "ArrowRight did not expand Projects");
  await waitForFocusedTreePath("Projects");
  await pressKey("ArrowRight", "ArrowRight");
  await waitForFocusedTreePath("Projects/Deep");
  await pressKey("ArrowRight", "ArrowRight");
  await waitFor(async () => {
    const item = await waitForTreePath("Projects/Deep");
    return item.expanded === "true" ? item : null;
  }, "ArrowRight did not expand the deep folder");
  await waitForFocusedTreePath("Projects/Deep");
  await pressKey("ArrowDown", "ArrowDown");
  await waitForFocusedTreePath(activeNotePath);
  await pressKey("ArrowUp", "ArrowUp");
  await waitForFocusedTreePath("Projects/Deep");
  await pressKey("Enter", "Enter");
  await waitFor(async () => {
    const item = await waitForTreePath("Projects/Deep");
    return item.expanded === "false" ? item : null;
  }, "Enter did not collapse the deep folder");
  await pressKey("Enter", "Enter");
  await waitForTreePath(activeNotePath);
  await pressKey("ArrowLeft", "ArrowLeft");
  await waitFor(async () => {
    const item = await waitForTreePath("Projects/Deep");
    return item.expanded === "false" ? item : null;
  }, "ArrowLeft did not collapse the deep folder");
  await pressKey("ArrowLeft", "ArrowLeft");
  await waitForFocusedTreePath("Projects");
  await pressKey("ArrowRight", "ArrowRight");
  await waitForTreePath("Projects/Deep");
  await pressKey("ArrowRight", "ArrowRight");
  await waitFor(async () => {
    const item = await waitForTreePath("Projects/Deep");
    return item.expanded === "true" ? item : null;
  }, "The deep folder did not reopen");

  const firstTreePath = await evaluate(
    'document.querySelector(".navigator-tree-row")?.getAttribute("data-tree-path") ?? null',
  );
  const lastTreePath = await evaluate(
    '[...document.querySelectorAll(".navigator-tree-row")].at(-1)?.getAttribute("data-tree-path") ?? null',
  );
  assert(
    lastTreePath && lastTreePath !== firstTreePath,
    "The keyboard fixture needs distinct endpoints.",
  );
  await pressKey("Home", "Home");
  await waitForFocusedTreePath(firstTreePath);
  await pressKey("End", "End");
  await waitForFocusedTreePath(lastTreePath);

  phase = "context actions and guarded folder creation";
  await rightClickSelector(treeSelector("Projects"));
  await waitFor(
    async () =>
      await evaluate(
        'document.querySelector("#navigator-context-menu")?.hidden === false ? true : null',
      ),
    "Folder context menu did not open",
  );
  await clickSelector("#navigator-context-new-note");
  await waitFor(
    async () =>
      await evaluate(
        'document.querySelector("#new-note-dialog")?.open && document.querySelector("#new-note-path")?.value === "Projects/" ? true : null',
      ),
    "New note here did not prefill the existing note dialog",
  );
  await clickSelector("#new-note-cancel");

  await rightClickSelector(treeSelector("Projects"));
  await clickSelector("#navigator-context-new-folder");
  await waitFor(
    async () =>
      await evaluate(
        'document.querySelector("#new-folder-dialog")?.open && document.querySelector("#new-folder-path")?.value === "Projects/" ? true : null',
      ),
    "New folder did not prefill its guarded folder dialog",
  );
  await fillInput("#new-folder-path", "Projects/.navigator-hidden");
  await clickSelector("#new-folder-create");
  const hiddenFolderUi = await waitFor(async () => {
    const state = await evaluate(`(() => ({
      open: document.querySelector("#new-folder-dialog")?.open === true,
      error: document.querySelector("#new-folder-error")?.textContent ?? "",
      toast: document.querySelector("#toast")?.textContent ?? "",
    }))()`);
    return state.open && state.error.includes("hidden") ? state : null;
  }, "The folder dialog did not surface the hidden-path rejection");
  assert(
    !hiddenFolderUi.toast.includes("Created Projects/.navigator-hidden"),
    `A rejected hidden folder announced a success toast: ${JSON.stringify(hiddenFolderUi)}`,
  );
  await fillInput("#new-folder-path", "Projects/Created from navigator");
  await clickSelector("#new-folder-create");
  await waitFor(
    async () =>
      await fs
        .access(path.join(vaultPath, "Projects", "Created from navigator"))
        .then(() => true)
        .catch(() => null),
    "New folder did not use the guarded workspace directory creation path",
  );
  await waitFor(
    async () =>
      await evaluate('document.querySelector("#new-folder-dialog")?.open === false ? true : null'),
    "The committed folder dialog did not close",
  );

  phase = "workspace folder containment rejections";
  const rejectedFolderPaths = [
    ".navigator-hidden",
    "Projects/.navigator-hidden",
    "..",
    absoluteBlockedFolderPath,
    ".obsidian/Workspace blocked",
    ".git/Workspace blocked",
    ".trash/Workspace blocked",
    ".threadleaf-private/Workspace blocked",
    "Symlink parent/Workspace blocked",
    "File parent/Workspace blocked",
  ];
  const folderCreateResponses = await evaluate(`(async () => {
    const snapshot = await window.threadleaf.getSnapshot();
    const paths = ${JSON.stringify(rejectedFolderPaths)};
    const results = [];
    for (const folderPath of paths) {
      try {
        const response = await window.threadleaf.createWorkspaceFolder(folderPath, snapshot.vault.id);
        results.push({ folderPath, status: "resolved", response });
      } catch (error) {
        results.push({
          folderPath,
          status: "rejected",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    try {
      const response = await window.threadleaf.createWorkspaceFolder(
        "Stale identity folder",
        String(snapshot.vault.id) + "-stale",
      );
      results.push({ folderPath: "<stale identity>", status: "resolved", response });
    } catch (error) {
      results.push({
        folderPath: "<stale identity>",
        status: "rejected",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return results;
  })()`);
  assert(
    folderCreateResponses.every((response) => response.status === "rejected"),
    `Workspace folder containment allowed a rejected case: ${JSON.stringify(folderCreateResponses)}`,
  );
  const rejectedWritePaths = [
    path.join(vaultPath, ".navigator-hidden"),
    path.join(vaultPath, "Projects", ".navigator-hidden"),
    absoluteBlockedFolderPath,
    path.join(vaultPath, ".obsidian", "Workspace blocked"),
    path.join(vaultPath, ".git", "Workspace blocked"),
    path.join(vaultPath, ".trash", "Workspace blocked"),
    path.join(vaultPath, ".threadleaf-private", "Workspace blocked"),
    path.join(outsidePath, "Workspace blocked"),
    path.join(vaultPath, "Stale identity folder"),
  ];
  for (const rejectedPath of rejectedWritePaths) {
    const exists = await fs
      .access(rejectedPath)
      .then(() => true)
      .catch(() => false);
    assert(!exists, `A rejected workspace folder was created: ${rejectedPath}`);
  }
  assert(
    (await fs.lstat(symlinkParentPath)).isSymbolicLink(),
    "The rejected symlink-parent folder attempt changed its parent.",
  );
  assert(
    (await fs.stat(fileParentPath)).isFile(),
    "The rejected file-parent folder attempt changed its parent.",
  );

  phase = "reveal active note and truncated active row";
  await clickSelector(treeSelector(activeNotePath));
  await waitFor(
    async () =>
      await evaluate(
        `document.querySelector(${JSON.stringify(treeSelector(activeNotePath))})?.getAttribute("aria-current") === "page" ? true : null`,
      ),
    "Opening a tree note did not mark it active",
  );
  await clickSelector(treeSelector("Projects/Deep"));
  await clickSelector(treeSelector("Projects"));
  await waitFor(async () => {
    const projects = await waitForTreePath("Projects");
    return projects.expanded === "false" ? projects : null;
  }, "The active note ancestor did not collapse");
  await clickSelector("#reveal-active-note");
  await waitForTreePath(activeNotePath);
  const activeVisual = await evaluate(`(() => {
    const item = document.querySelector(${JSON.stringify(treeSelector(activeNotePath))});
    const label = item?.querySelector("strong");
    if (!(item instanceof HTMLElement) || !(label instanceof HTMLElement)) return null;
    const style = getComputedStyle(item);
    return {
      current: item.getAttribute("aria-current"),
      selected: item.getAttribute("aria-selected"),
      boxShadow: style.boxShadow,
      background: style.backgroundColor,
      truncated: label.scrollWidth > label.clientWidth,
      visible: item.getBoundingClientRect().top >= 0 && item.getBoundingClientRect().bottom <= innerHeight,
    };
  })()`);
  assert(
    activeVisual?.current === "page" &&
      activeVisual.selected === "true" &&
      activeVisual.boxShadow !== "none" &&
      activeVisual.truncated &&
      activeVisual.visible,
    `The revealed active row is not visibly selected and truncated: ${JSON.stringify(activeVisual)}`,
  );

  phase = "dark screenshots and screenshot positive control";
  await setTheme("dark");
  const darkActive = await captureScreenshot("navigator-tree-active-dark");
  const positiveControlReached = await evaluate(`(() => {
    const item = document.querySelector(${JSON.stringify(treeSelector(activeNotePath))});
    if (!(item instanceof HTMLElement)) return false;
    item.style.outline = "8px solid rgb(230, 159, 0)";
    return getComputedStyle(item).outlineWidth === "8px";
  })()`);
  assert(
    positiveControlReached,
    "The screenshot positive control did not reach the active tree row.",
  );
  const darkPositive = await captureScreenshot("navigator-tree-positive-control-dark");
  assert(darkActive !== darkPositive, "The screenshot positive control changed no pixels.");
  await evaluate(`(() => {
    const item = document.querySelector(${JSON.stringify(treeSelector(activeNotePath))});
    item?.style.removeProperty("outline");
    return true;
  })()`);

  phase = "one-thousand-child virtualization";
  await clickSelector(treeSelector("Library"));
  await waitForTreePath("Library/Child-0000.md");
  const libraryVisual = await evaluate(`(() => {
    const folder = document.querySelector(${JSON.stringify(treeSelector("Library"))});
    const list = document.querySelector("#file-list");
    if (!(folder instanceof HTMLElement) || !(list instanceof HTMLElement)) return null;
    return {
      summary: folder.querySelector("small")?.textContent ?? "",
      rows: document.querySelectorAll(".navigator-tree-row").length,
      scrollHeight: list.scrollHeight,
      expectedHeight: 1_001 * 40,
    };
  })()`);
  assert(
    libraryVisual?.summary === "1,001 items" &&
      libraryVisual.rows < 100 &&
      libraryVisual.scrollHeight >= libraryVisual.expectedHeight,
    `The 1,001-child folder did not stay virtualized: ${JSON.stringify(libraryVisual)}`,
  );
  const darkLibrary = await captureScreenshot("navigator-tree-library-dark");

  phase = "light screenshots";
  await setTheme("light");
  const lightLibrary = await captureScreenshot("navigator-tree-library-light");
  await clickSelector("#reveal-active-note");
  await waitForTreePath(activeNotePath);
  const lightActive = await captureScreenshot("navigator-tree-active-light");
  assert(
    darkActive !== lightActive && darkLibrary !== lightLibrary,
    "Dark and light navigator screenshots are pixel-identical.",
  );

  phase = "flat list and flat search reachability";
  await fillInput("#file-search", "Reference");
  await waitFor(
    async () =>
      await evaluate(
        'document.querySelector("#file-list")?.dataset.mode === "search" && document.querySelector("#file-list")?.getAttribute("role") === null && document.querySelector(".file-item") ? true : null',
      ),
    "Search did not remain a flat result list",
  );
  await fillInput("#file-search", "");
  await clickSelector("#navigator-view-toggle");
  await waitFor(
    async () =>
      await evaluate(
        'document.querySelector("#file-list")?.dataset.mode === "virtual" && document.querySelector("#file-list")?.getAttribute("role") === null ? true : null',
      ),
    "The alternate flat navigator list is unreachable",
  );
  await clickSelector("#navigator-view-toggle");
  await waitFor(
    async () =>
      await evaluate(
        'document.querySelector("#file-list")?.dataset.mode === "tree" && document.querySelector("#file-list")?.getAttribute("role") === "tree" ? true : null',
      ),
    "The folder-tree navigator did not return from the alternate flat list",
  );
  await clickSelector("#reveal-active-note");
  await waitForTreePath("Projects");

  phase = "batched 128-level active reveal";
  await fillInput("#file-search", "Target");
  await waitFor(
    async () =>
      (await evaluate(
        `Boolean(document.querySelector(${JSON.stringify(`[data-note-path=${JSON.stringify(deepRevealActivePath)}]`)}))`,
      ))
        ? true
        : null,
    "The deep reveal target did not appear in flat search",
  );
  await clickSelector(`[data-note-path=${JSON.stringify(deepRevealActivePath)}]`);
  await waitFor(
    async () =>
      (await evaluate('document.querySelector("#note-path")?.textContent ?? ""')) ===
      deepRevealActivePath
        ? true
        : null,
    "The deep reveal target did not open from flat search",
  );
  await fillInput("#file-search", "");
  await waitFor(
    async () =>
      (await evaluate('document.querySelector("#file-list")?.dataset.mode')) === "tree"
        ? true
        : null,
    "Clearing search did not restore the folder tree before deep reveal",
  );
  const deepCanonicalVaultPath = await fs.realpath(vaultPath);
  const deepVaultId = createHash("sha256").update(deepCanonicalVaultPath).digest("hex");
  const deepLayoutPath = path.join(userDataPath, "workspace-layouts", `${deepVaultId}.json`);
  await fs.access(deepLayoutPath);
  await delay(100);
  const deepLayoutEvents = [];
  const deepLayoutWatcher = watchFile(
    path.dirname(deepLayoutPath),
    { persistent: false },
    (event, name) => {
      if (String(name) === path.basename(deepLayoutPath)) deepLayoutEvents.push(event);
    },
  );
  const deepRevealStarted = Date.now();
  let deepReveal;
  try {
    await clickSelector("#reveal-active-note");
    deepReveal = await waitFor(
      async () => {
        const item = await evaluate(`(() => {
        const row = document.querySelector(${JSON.stringify(treeSelector(deepRevealActivePath))});
        return row instanceof HTMLElement ? { current: row.getAttribute("aria-current") } : null;
      })()`);
        return item?.current === "page" ? { elapsedMs: Date.now() - deepRevealStarted } : null;
      },
      "The deep active note did not reveal through its complete ancestor chain",
      3_000,
    );
    await delay(200);
  } finally {
    deepLayoutWatcher.close();
  }
  assert(
    deepReveal.elapsedMs < 1_000,
    `The 128-level active reveal exceeded its latency ceiling: ${JSON.stringify(deepReveal)}`,
  );
  assert(
    deepLayoutEvents.length === 1,
    `The deep active reveal wrote the workspace layout ${deepLayoutEvents.length} times: ${JSON.stringify(deepLayoutEvents)}`,
  );

  phase = "per-workspace persistence";
  const canonicalVaultPath = await fs.realpath(vaultPath);
  const vaultId = createHash("sha256").update(canonicalVaultPath).digest("hex");
  const layoutPath = path.join(userDataPath, "workspace-layouts", `${vaultId}.json`);
  const persisted = await waitFor(async () => {
    try {
      return JSON.parse(await fs.readFile(layoutPath, "utf8"));
    } catch {
      return null;
    }
  }, "Navigator expansion state was not persisted outside the vault");
  assert(
    persisted.version === 2 &&
      persisted.navigator?.expandedFolderPaths?.includes("Projects") &&
      persisted.navigator?.expandedFolderPaths?.includes("Library") &&
      persisted.navigator?.expandedFolderPaths?.includes(deepRevealSegments.join("/")),
    `The versioned workspace layout did not persist expanded folders: ${JSON.stringify(persisted)}`,
  );
  await closeApplication();
  await launchApplication();
  await waitForReady();
  await assertIsolatedX11Renderer();
  await waitFor(
    async () =>
      await evaluate(
        'document.querySelector("#file-list")?.dataset.mode === "tree" && document.querySelector("#file-list")?.getAttribute("role") === "tree" ? true : null',
      ),
    "The persisted navigator did not restore in tree mode",
  );
  const restoredRevealRoot = await waitForTreePath(deepRevealSegments[0]);
  assert(
    restoredRevealRoot.expanded === "true",
    `The persisted deep reveal root did not restore expanded: ${JSON.stringify(restoredRevealRoot)}`,
  );
  await clickSelector(treeSelector(deepRevealSegments[0]));
  await waitFor(async () => {
    const item = await waitForTreePath(deepRevealSegments[0]);
    return item.expanded === "false" ? item : null;
  }, "The restored deep reveal root did not collapse");
  const restoredLibrary = await waitForTreePath("Library");
  assert(
    restoredLibrary.expanded === "true",
    `The persisted Library folder did not restore expanded: ${JSON.stringify(restoredLibrary)}`,
  );
  await waitForTreePath("Library/Child-0000.md");
  await clickSelector(treeSelector("Library"));
  await waitFor(async () => {
    const item = await waitForTreePath("Library");
    return item.expanded === "false" ? item : null;
  }, "The restored Library folder did not collapse");
  const restoredProjects = await waitForTreePath("Projects");
  assert(
    restoredProjects.expanded === "true",
    `The persisted Projects folder did not restore expanded: ${JSON.stringify(restoredProjects)}`,
  );
  const restoredDeep = await waitForTreePath("Projects/Deep");
  assert(
    restoredDeep.expanded === "true",
    `The persisted deep folder did not restore expanded: ${JSON.stringify(restoredDeep)}`,
  );
  await closeApplication();

  console.log(`NAVIGATOR_TREE_LIVE_MOUNTED_ROWS=${libraryVisual.rows}`);
  console.log(
    `NAVIGATOR_TREE_DEEP_REVEAL elapsed_ms=${deepReveal.elapsedMs} layout_writes=${deepLayoutEvents.length}`,
  );
  console.log(
    "Verified isolated X11 navigator tree: initial collapse, ARIA hierarchy, keyboard traversal, guarded folder rejections, batched deep reveal, context creation, per-vault layout persistence, flat search/list fallback, dark/light screenshots, truncation, active highlight, and 1,001-child virtualization.",
  );
  if (screenshotDirectory) {
    console.log(`NAVIGATOR_TREE_SCREENSHOTS=${screenshotDirectory}`);
  }
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  const logs = output.join("").trim();
  const phased = `Phase ${phase}: ${detail}`;
  throw new Error(logs ? `${phased}\nElectron output:\n${logs}` : phased, { cause: error });
} finally {
  cdp?.close();
  await terminateMarkedProcesses().catch(() => undefined);
  await fs.rm(testRoot, { recursive: true, force: true });
}
