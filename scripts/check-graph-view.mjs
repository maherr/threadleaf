import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const appRoot = process.cwd();
const electronPath = path.join(appRoot, "node_modules", ".bin", "electron");
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-graph-view-"));
const vaultPath = path.join(testRoot, "vault");
const userDataPath = path.join(testRoot, "user-data");
const screenshotDirectory = process.env.THREADLEAF_GRAPH_SCREENSHOT_DIR;
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
      "if (!(element instanceof Element)) return { error: 'missing' };" +
      "const rect = element.getBoundingClientRect();" +
      "const x = rect.left + rect.width / 2;" +
      "const y = rect.top + rect.height / 2;" +
      "const hit = document.elementFromPoint(x, y);" +
      "return {" +
      "error: null, x, y, width: rect.width, height: rect.height," +
      "hit: Boolean(hit && (hit === element || element.contains(hit)))," +
      "hidden: element instanceof HTMLElement ? element.hidden || getComputedStyle(element).display === 'none' : false," +
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
  ArrowLeft: 37,
  ArrowRight: 39,
  Enter: 13,
  Escape: 27,
  Home: 36,
  Tab: 9,
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

async function waitForGraphNodes(count) {
  return waitFor(async () => {
    const state = await evaluate(
      "(() => ({ open: document.querySelector('#graph-dialog')?.open === true, nodes: document.querySelectorAll('.graph-node').length, edges: document.querySelectorAll('.graph-edge').length, status: document.querySelector('#graph-status')?.textContent ?? '' }))()",
    );
    return state.open && state.nodes === count ? state : null;
  }, `The graph did not render ${count} notes`);
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
    throw new Error("The graph view integration check currently requires Linux and Xvfb.");
  }
  await fs.access(electronPath);
  await fs.mkdir(path.join(vaultPath, "Folder"), { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(vaultPath, "Alpha.md"),
      "# Alpha\n\n[[Beta]] [[Beta#Plan]] [[Folder/Gamma]] [[Delta]]\n\n#project\n",
    ),
    fs.writeFile(
      path.join(vaultPath, "Beta.md"),
      "# Beta\n\n[[Alpha]] [[Folder/Gamma]]\n\n## Plan\n",
    ),
    fs.writeFile(path.join(vaultPath, "Folder", "Gamma.md"), "# Gamma\n\n[[Beta]]\n"),
    fs.writeFile(path.join(vaultPath, "Delta.md"), "# Delta\n\n[[Echo]]\n"),
    fs.writeFile(path.join(vaultPath, "Echo.md"), "# Echo\n\n[[Delta]]\n"),
    fs.writeFile(path.join(vaultPath, "Orphan.md"), "# Orphan\n\n#project\n"),
  ]);

  phase = "isolated launch";
  await launchApplication();
  await waitFor(async () => {
    const snapshot = await evaluate("window.threadleaf.getSnapshot()");
    return snapshot?.workspace?.state === "ready" && snapshot?.vault?.path === vaultPath
      ? snapshot
      : null;
  }, "The isolated graph vault did not become ready");
  await assertIsolatedX11Renderer();
  await setTheme("dark");

  phase = "global graph with virtual input";
  await runPaletteCommand("workspace.open-graph-view");
  const globalGraph = await waitForGraphNodes(5);
  assert(globalGraph.edges === 8, `The global graph rendered ${globalGraph.edges} edges, not 8.`);
  const layout = await evaluate(
    "(() => { const dialog = document.querySelector('#graph-dialog'); const canvas = document.querySelector('#graph-canvas'); if (!(dialog instanceof HTMLElement) || !(canvas instanceof SVGElement)) return null; const rect = dialog.getBoundingClientRect(); return { left: rect.left, top: rect.top, right: innerWidth - rect.right, bottom: innerHeight - rect.bottom, width: canvas.getBoundingClientRect().width, height: canvas.getBoundingClientRect().height, overflow: dialog.scrollWidth - dialog.clientWidth }; })()",
  );
  assert(layout, "The graph view has no measurable layout.");
  assert(
    layout.left >= 0 && layout.top >= 0 && layout.right >= 0 && layout.bottom >= 0,
    "The graph dialog escaped the virtual viewport.",
  );
  assert(
    layout.width > 700 && layout.height > 500,
    "The graph canvas collapsed below desktop size.",
  );
  assert(layout.overflow <= 1, "The graph dialog overflowed horizontally.");
  const darkBaseline = await captureScreenshot("graph-global-dark");

  const outlined = await evaluate(
    "(() => { const canvas = document.querySelector('#graph-interaction'); if (!(canvas instanceof HTMLElement)) return false; canvas.style.boxShadow = 'inset 0 0 0 14px rgb(230, 159, 0)'; return getComputedStyle(canvas).boxShadow.includes('14px'); })()",
  );
  assert(outlined, "The screenshot positive control did not reach the graph canvas.");
  const positiveControl = await captureScreenshot("graph-positive-control");
  assert(positiveControl !== darkBaseline, "The screenshot positive control changed no pixels.");
  await evaluate(
    "document.querySelector('#graph-interaction')?.style.removeProperty('box-shadow'); true",
  );

  phase = "graph hover, pan, zoom, and keyboard";
  const alpha = await targetCenter('.graph-node[data-path="Alpha.md"] circle');
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    button: "none",
    x: alpha.x,
    y: alpha.y,
  });
  const highlighted = await waitFor(async () => {
    const state = await evaluate(
      "(() => ({ active: document.querySelectorAll('.graph-node.is-active').length, neighbors: document.querySelectorAll('.graph-node.is-neighbor').length, activeEdges: document.querySelectorAll('.graph-edge.is-active').length, dimmed: document.querySelectorAll('.graph-node.is-dimmed').length }))()",
    );
    return state.active === 1 && state.neighbors >= 3 && state.activeEdges >= 3 && state.dimmed >= 1
      ? state
      : null;
  }, "Hover did not reveal the active note neighborhood");
  assert(highlighted.dimmed > 0, "Hover did not create a non-colour opacity cue.");

  const background = await evaluate(
    "(() => { const svg = document.querySelector('#graph-canvas'); const surface = document.querySelector('#graph-pan-surface'); if (!(svg instanceof SVGElement) || !(surface instanceof SVGElement)) return null; const rect = svg.getBoundingClientRect(); for (const [fx, fy] of [[0.08,0.08],[0.9,0.08],[0.08,0.9],[0.9,0.9]]) { const x = rect.left + rect.width * fx; const y = rect.top + rect.height * fy; if (document.elementFromPoint(x, y) === surface) return { x, y, inert: true }; } return { inert: false }; })()",
  );
  assert(background?.inert, "No inert graph background point was available for pointer panning.");
  const transformBeforeDrag = await evaluate(
    "document.querySelector('#graph-scene')?.getAttribute('transform')",
  );
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    buttons: 1,
    clickCount: 1,
    x: background.x,
    y: background.y,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    button: "left",
    buttons: 1,
    x: background.x + 90,
    y: background.y + 44,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    buttons: 0,
    clickCount: 1,
    x: background.x + 90,
    y: background.y + 44,
  });
  const transformAfterDrag = await evaluate(
    "document.querySelector('#graph-scene')?.getAttribute('transform')",
  );
  assert(transformAfterDrag !== transformBeforeDrag, "Pointer drag did not pan the graph.");
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    button: "none",
    deltaX: 0,
    deltaY: -120,
    x: background.x,
    y: background.y,
  });
  await waitFor(
    async () =>
      (await evaluate("document.querySelector('#graph-zoom-value')?.textContent")) !== "100%",
    "The mouse wheel did not zoom the graph",
  );

  await clickSelector("#graph-reset-view");
  await clickSelector("#graph-search");
  let focusedNode = false;
  for (let index = 0; index < 30; index += 1) {
    await pressKey("Tab", "Tab");
    focusedNode = await evaluate(
      "document.activeElement?.classList.contains('graph-node') === true",
    );
    if (focusedNode) {
      break;
    }
  }
  assert(focusedNode, "Real Tab input did not reach the keyboard-operable graph nodes.");
  const transformBeforeKey = await evaluate(
    "document.querySelector('#graph-scene')?.getAttribute('transform')",
  );
  await pressKey("ArrowRight", "ArrowRight");
  const transformAfterKey = await evaluate(
    "document.querySelector('#graph-scene')?.getAttribute('transform')",
  );
  assert(
    transformAfterKey !== transformBeforeKey,
    "Arrow-key input did not pan the focused graph.",
  );
  await pressKey("Enter", "Enter");
  await waitFor(
    async () => (await evaluate("document.querySelector('#graph-dialog')?.open")) === false,
    "Enter on a graph node did not close the graph and open the note",
  );

  phase = "local graph depth and filter";
  await runPaletteCommand("workspace.open-local-graph");
  await waitForGraphNodes(4);
  const localRoot = await evaluate(
    "document.querySelector('.graph-node.is-root')?.getAttribute('data-path') ?? null",
  );
  assert(localRoot === "Alpha.md", `The local graph root was ${JSON.stringify(localRoot)}.`);
  await clickSelector("#graph-depth");
  await pressKey("Home", "Home");
  await pressKey("ArrowDown", "ArrowDown");
  await pressKey("Enter", "Enter");
  await waitForGraphNodes(5);
  await fillInput("#graph-search", "beta");
  await waitForGraphNodes(2);
  const filteredPaths = await evaluate(
    "[...document.querySelectorAll('.graph-node')].map((node) => node.getAttribute('data-path')).sort()",
  );
  assert(
    JSON.stringify(filteredPaths) === JSON.stringify(["Alpha.md", "Beta.md"]),
    `The local filter returned ${JSON.stringify(filteredPaths)}.`,
  );
  await captureScreenshot("graph-local-dark");
  await pressKey("Escape", "Escape");
  await waitFor(
    async () => (await evaluate("document.querySelector('#graph-dialog')?.open")) === false,
    "Escape did not close the graph while its filter retained focus",
  );

  phase = "light graph and persisted controls";
  await setTheme("light");
  await runPaletteCommand("workspace.open-graph-view");
  await waitForGraphNodes(5);
  await clickSelector("#graph-orphans");
  await waitForGraphNodes(6);
  assert(
    await evaluate("Boolean(document.querySelector('.graph-node[data-path=\"Orphan.md\"]'))"),
    "The global orphan control did not reveal Orphan.md.",
  );
  await clickSelector("#graph-arrows");
  assert(
    (await evaluate("document.querySelectorAll('.graph-edge[marker-end]').length")) === 0,
    "The direction control did not remove arrow markers.",
  );
  await captureScreenshot("graph-global-light");
  await pressKey("Escape", "Escape");
  await closeApplication();

  console.log(
    "Verified isolated X11 virtual input, bounded global/local graph projection, hover neighborhoods, pointer and keyboard navigation, persisted graph controls, note opening, and dark/light screenshots.",
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
