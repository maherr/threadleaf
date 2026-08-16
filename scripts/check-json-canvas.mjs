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
const overviewPath = path.join(vaultPath, "Boards", "Overview.canvas");
const brokenPath = path.join(vaultPath, "Boards", "Broken.canvas");
const conflictPath = path.join(vaultPath, "Boards", "Conflict.canvas");
const screenshotDirectory =
  process.env.THREADLEAF_JSON_CANVAS_SCREENSHOT_DIR ??
  path.join(os.tmpdir(), "threadleaf-json-canvas-screenshots");
const marker = randomUUID();
const pixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlL8AAAAASUVORK5CYII=",
  "base64",
);
let child;
let cdp;
let exited;
let phase = "setup";

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

async function clickSelector(selector) {
  const scrolled = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return false;
    element.scrollIntoView({ block: "center", inline: "nearest" });
    return true;
  })()`);
  assert(scrolled, `Pointer target is unavailable: ${selector}`);
  await delay(50);
  const target = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return { error: "missing" };
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const left = Math.max(0, rect.left);
    const right = Math.min(innerWidth, rect.right);
    const top = Math.max(0, rect.top);
    const bottom = Math.min(innerHeight, rect.bottom);
    const x = left + Math.max(0, right - left) / 2;
    const y = top + Math.max(0, bottom - top) / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      disabled: element instanceof HTMLButtonElement ? element.disabled : false,
      error: null,
      height: bottom - top,
      hidden: element.hidden || style.display === "none" || style.visibility === "hidden",
      hit: Boolean(hit && (hit === element || element.contains(hit))),
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

async function clickButton(label, rootSelector = "#canvas-view") {
  const prepared = await evaluate(`(() => {
    document.querySelectorAll('[data-json-canvas-proof-action]').forEach((element) =>
      element.removeAttribute('data-json-canvas-proof-action')
    );
    const root = document.querySelector(${JSON.stringify(rootSelector)});
    if (!(root instanceof HTMLElement)) return false;
    const button = [...root.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === ${JSON.stringify(label)}
    );
    if (!(button instanceof HTMLButtonElement)) return false;
    button.dataset.jsonCanvasProofAction = "true";
    return true;
  })()`);
  assert(prepared, `Canvas button was unavailable: ${rootSelector} ${label}`);
  await clickSelector('[data-json-canvas-proof-action="true"]');
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

async function replaceText(selector, text) {
  await clickSelector(selector);
  await pressKey("a", "KeyA", 2);
  await cdp.send("Input.insertText", { text });
  await pressKey("Tab", "Tab");
  await waitFor(
    () =>
      evaluate(
        `document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(text)}`,
      ),
    `Real keyboard input did not update ${selector}`,
  );
}

async function waitForCanvas(canvasPath) {
  return waitFor(
    () =>
      evaluate("window.threadleaf.getSnapshot()").then((snapshot) =>
        snapshot?.workspace?.panes?.[0]?.activeCanvas?.path === canvasPath ? snapshot : null,
      ),
    `Canvas did not become active: ${canvasPath}`,
  );
}

async function rendererCommandLines() {
  const entries = await fs.readdir("/proc", { withFileTypes: true });
  const rows = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const command = (await fs.readFile(`/proc/${entry.name}/cmdline`))
        .toString("utf8")
        .replaceAll("\0", " ");
      if (
        command.includes("--type=renderer") &&
        command.includes(`--user-data-dir=${userDataPath}`) &&
        command.includes(`--app-path=${appRoot}`)
      ) {
        rows.push(command);
      }
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

async function prepareVault() {
  await fs.cp(fixtureVault, vaultPath, { recursive: true });
  await fs.mkdir(path.join(vaultPath, "assets"), { recursive: true });
  const overview = JSON.parse(await fs.readFile(overviewPath, "utf8"));
  const welcome = overview.nodes.find((node) => node.id === "welcome");
  const firstEdge = overview.edges.find((edge) => edge.id === "welcome-to-note");
  assert(welcome && firstEdge, "Canvas fixture did not expose its preservation controls");
  welcome.futureNodeField = ["preserve", { nested: true }];
  firstEdge.futureEdgeField = { preserve: true };
  overview.nodes.push(
    {
      id: "image-attachment",
      type: "file",
      x: 760,
      y: 40,
      width: 240,
      height: 140,
      file: "assets/pixel.unknown",
    },
    {
      id: "text-attachment",
      type: "file",
      x: 760,
      y: 220,
      width: 280,
      height: 160,
      file: "assets/readme.bin",
    },
    {
      id: "binary-attachment",
      type: "file",
      x: 760,
      y: 420,
      width: 280,
      height: 140,
      file: "assets/document.unknown",
    },
    {
      id: "missing-attachment",
      type: "file",
      x: 420,
      y: 500,
      width: 280,
      height: 140,
      file: "assets/missing.bin",
    },
  );
  await fs.writeFile(overviewPath, `${JSON.stringify(overview, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(vaultPath, "assets", "pixel.unknown"), pixelPng);
  await fs.writeFile(
    path.join(vaultPath, "assets", "readme.bin"),
    "Canvas attachment text <script>must stay inert</script>\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(vaultPath, "assets", "document.unknown"),
    Buffer.from("%PDF-1.7\ncanvas binary fixture\n", "ascii"),
  );
  await fs.writeFile(brokenPath, "{oops", "utf8");
  await fs.writeFile(
    conflictPath,
    `${JSON.stringify(
      {
        futureDocumentField: { preserve: "conflict" },
        nodes: [
          {
            id: "conflict-text",
            type: "text",
            x: 80,
            y: 80,
            width: 300,
            height: 120,
            text: "Conflict baseline",
            futureNodeField: ["preserve"],
          },
        ],
        edges: [],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function launch() {
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
}

async function close() {
  if (!child) return;
  try {
    await evaluate("setTimeout(() => window.close(), 20); true");
  } catch {
    /* renderer may already be gone */
  }
  cdp?.close();
  cdp = undefined;
  const result = exited
    ? await Promise.race([exited, delay(5_000).then(() => ({ code: null, signal: "timeout" }))])
    : { code: null, signal: "missing" };
  if (result.code !== 0 && child.pid) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already exited */
    }
  }
  child = undefined;
  exited = undefined;
}

try {
  if (process.platform !== "linux") {
    throw new Error("The JSON Canvas integration check currently requires Linux and Xvfb.");
  }
  await fs.access(electronPath);
  phase = "fixture preparation";
  await prepareVault();

  phase = "initial isolated launch";
  await launch();
  let ready = await waitFor(
    () =>
      evaluate("window.threadleaf.getSnapshot()").then((snapshot) => {
        const paths = snapshot?.workspace?.canvasFiles?.map((file) => file.path) ?? [];
        return snapshot?.workspace?.state === "ready" &&
          ["Boards/Broken.canvas", "Boards/Conflict.canvas", "Boards/Overview.canvas"].every(
            (path) => paths.includes(path),
          )
          ? snapshot
          : null;
      }),
    "Workspace and Canvas shelf did not converge",
  );
  const listedCanvases = ready.workspace.canvasFiles.map((file) => file.path).sort();
  assert(
    ["Boards/Broken.canvas", "Boards/Conflict.canvas", "Boards/Overview.canvas"].every((path) =>
      listedCanvases.includes(path),
    ),
    `Canvas fixtures were not all listed: ${JSON.stringify(listedCanvases)}`,
  );
  const rendererCommands = await rendererCommandLines();
  assert(
    rendererCommands.some(
      (command) => command.includes("--type=renderer") && command.includes("--ozone-platform=x11"),
    ),
    "Renderer argv did not prove explicit X11",
  );

  phase = "Overview reachability and attachment previews";
  await clickSelector('[data-canvas-path="Boards/Overview.canvas"]');
  await waitForCanvas("Boards/Overview.canvas");
  assert(
    await evaluate(
      "!document.querySelector('#canvas-view')?.hidden && document.querySelectorAll('#canvas-view .canvas-node').length >= 8",
    ),
    "Canvas board was not rendered",
  );
  assert(
    await evaluate(
      "['Add text', 'Add group', 'Add file', 'Add link', 'Connect first two', 'Save'].every((label) => [...document.querySelectorAll('#canvas-view button')].some((button) => button.textContent === label))",
    ),
    "Canvas editing controls were not reachable",
  );
  const attachmentState = await waitFor(
    () =>
      evaluate(`(() => {
        const image = document.querySelector('[data-node-id="image-attachment"] .canvas-attachment-preview img');
        const text = document.querySelector('[data-node-id="text-attachment"] .canvas-attachment-preview pre');
        const binary = document.querySelector('[data-node-id="binary-attachment"] .canvas-attachment-preview');
        const missing = document.querySelector('[data-node-id="missing-attachment"] .canvas-attachment-preview');
        const state = {
          image: image instanceof HTMLImageElement && image.src.startsWith('data:image/png;base64,'),
          imageAlt: image instanceof HTMLImageElement ? image.alt : '',
          text: text?.textContent ?? '',
          textScripts: text?.querySelectorAll('script').length ?? -1,
          binary: binary?.textContent ?? '',
          missing: missing?.textContent ?? '',
          externalAnchors: document.querySelectorAll('.canvas-node-link a[href]').length,
        };
        return state.image && state.text.includes('must stay inert') &&
          state.binary.includes('application/pdf') && state.missing.includes('no longer exists')
          ? state
          : null;
      })()`),
    "Canvas attachment previews did not settle",
  );
  assert(
    attachmentState.imageAlt === "pixel.unknown attachment" &&
      attachmentState.textScripts === 0 &&
      attachmentState.externalAnchors === 0,
    `Canvas attachment or inactive-link safety regressed: ${JSON.stringify(attachmentState)}`,
  );
  await evaluate(`(() => {
    const scroller = document.querySelector('#canvas-view .canvas-board-scroller');
    if (!(scroller instanceof HTMLElement)) return false;
    scroller.scrollLeft = 700;
    scroller.scrollTop = 0;
    return true;
  })()`);
  await delay(100);
  await screenshot("canvas-light-attachment-previews");
  await evaluate(`(() => {
    const scroller = document.querySelector('#canvas-view .canvas-board-scroller');
    if (!(scroller instanceof HTMLElement)) return false;
    scroller.scrollLeft = 0;
    return true;
  })()`);
  await delay(100);
  await screenshot("canvas-light-overview");

  phase = "Canvas file-node navigation";
  await clickButton("Open file", '[data-node-id="linked-note"]');
  await waitFor(
    () =>
      evaluate("window.threadleaf.getSnapshot()").then((snapshot) =>
        snapshot?.workspace?.panes?.[0]?.activeNote?.path === "Linked Note.md" ? snapshot : null,
      ),
    "Canvas file node did not open its Markdown target",
  );
  await clickSelector('[data-canvas-path="Boards/Overview.canvas"]');
  await waitForCanvas("Boards/Overview.canvas");

  phase = "Canvas mutation and save";
  await replaceText('textarea[aria-label="Text for welcome"]', "Daily-driver Canvas edit");
  await waitFor(
    () =>
      evaluate(
        "document.querySelector('#canvas-view .canvas-status')?.textContent === 'Unsaved changes'",
      ),
    "Canvas text editing did not enter the dirty state",
  );
  await clickButton("Move right", '[data-node-id="welcome"]');
  await clickButton("Make larger", '[data-node-id="welcome"]');
  await clickButton("Add group");
  await clickButton("Add file");
  await clickButton("Add text");
  await clickButton("Connect first two");
  await clickButton("+");
  await waitFor(
    () =>
      evaluate(
        "document.querySelector('#canvas-view .canvas-zoom-label')?.textContent === 'Zoom 110%'",
      ),
    "Canvas zoom-in control did not update the board scale",
  );
  await clickButton("100%");
  await clickButton("Save");
  await waitFor(
    () =>
      evaluate(`(() => {
        const save = [...document.querySelectorAll('#canvas-view button')].find((button) => button.textContent === 'Save');
        return document.querySelector('#canvas-view .canvas-status')?.textContent === 'Saved' &&
          save instanceof HTMLButtonElement && save.disabled;
      })()`),
    "Canvas save did not settle in a clean disabled state",
  );
  const savedOverview = JSON.parse(await fs.readFile(overviewPath, "utf8"));
  const savedWelcome = savedOverview.nodes.find((node) => node.id === "welcome");
  const savedEdge = savedOverview.edges.find((edge) => edge.id === "welcome-to-note");
  assert(
    savedWelcome?.text === "Daily-driver Canvas edit" &&
      savedWelcome.x === 100 &&
      savedWelcome.width === 280,
    `Canvas mutation bytes were incomplete: ${JSON.stringify(savedWelcome)}`,
  );
  assert(
    JSON.stringify(savedOverview.threadleafFixture) ===
      JSON.stringify({ unknownField: "preserve me" }) &&
      JSON.stringify(savedWelcome.futureNodeField) ===
        JSON.stringify(["preserve", { nested: true }]) &&
      JSON.stringify(savedEdge?.futureEdgeField) === JSON.stringify({ preserve: true }),
    "Canvas save dropped an unknown document, node, or edge field",
  );
  assert(
    savedOverview.nodes.some((node) => node.type === "group" && node.id !== "group") &&
      savedOverview.nodes.some((node) => node.type === "file" && node.id.startsWith("file-")) &&
      savedOverview.nodes.some((node) => node.type === "text" && node.id.startsWith("text-")) &&
      savedOverview.edges.length === 2,
    "Canvas add/connect controls did not persist their full mutation set",
  );
  await screenshot("canvas-light-saved");

  phase = "saved Canvas restart";
  await close();
  await launch();
  ready = await waitFor(
    () =>
      evaluate("window.threadleaf.getSnapshot()").then((snapshot) =>
        snapshot?.workspace?.state === "ready" ? snapshot : null,
      ),
    "Workspace did not become ready after Canvas restart",
  );
  await waitForCanvas("Boards/Overview.canvas");
  const restoredState = await waitFor(
    () =>
      evaluate(`(() => {
        const editor = document.querySelector('textarea[aria-label="Text for welcome"]');
        const save = [...document.querySelectorAll('#canvas-view button')].find((button) => button.textContent === 'Save');
        return {
          text: editor instanceof HTMLTextAreaElement ? editor.value : '',
          addedGroup: Boolean(document.querySelector('[data-node-id^="group-"]')),
          status: document.querySelector('#canvas-view .canvas-status')?.textContent ?? '',
          saveDisabled: save instanceof HTMLButtonElement && save.disabled,
        };
      })()`),
    "Restored Canvas surface did not render",
  );
  assert(
    restoredState.text === "Daily-driver Canvas edit" &&
      restoredState.addedGroup &&
      restoredState.status === "Ready" &&
      restoredState.saveDisabled,
    `Canvas did not restore its saved model cleanly: ${JSON.stringify(restoredState)}`,
  );
  const restartedRendererCommands = await rendererCommandLines();
  assert(
    restartedRendererCommands.some(
      (command) => command.includes("--type=renderer") && command.includes("--ozone-platform=x11"),
    ),
    "Restarted renderer argv did not prove explicit X11",
  );
  await clickSelector("#theme-toggle");
  await waitFor(
    () => evaluate("document.documentElement.dataset.theme === 'dark'"),
    "Dark theme did not apply",
  );
  await screenshot("canvas-dark-reloaded");

  phase = "malformed Canvas refusal";
  await clickSelector('[data-canvas-path="Boards/Broken.canvas"]');
  const broken = await waitForCanvas("Boards/Broken.canvas");
  assert(
    broken.workspace.panes[0].activeCanvas.readOnly === true &&
      broken.workspace.panes[0].activeCanvas.diagnostics.some(
        (diagnostic) => diagnostic.code === "invalid-json" && diagnostic.path === "$",
      ),
    `Malformed Canvas diagnostics were incomplete: ${JSON.stringify(broken.workspace.panes[0].activeCanvas)}`,
  );
  assert(
    await evaluate(`(() => {
      const tools = [...document.querySelectorAll('#canvas-view .canvas-edit-tool, #canvas-view .canvas-save-tool')];
      return tools.length === 6 && tools.every((tool) => tool instanceof HTMLButtonElement && tool.disabled) &&
        document.querySelector('#canvas-view .canvas-diagnostics')?.textContent.includes('validation issues') &&
        document.querySelector('#canvas-view .canvas-empty')?.textContent.includes('original file remains untouched');
    })()`),
    "Malformed Canvas was not visibly read-only",
  );
  await screenshot("canvas-dark-malformed");
  assert((await fs.readFile(brokenPath, "utf8")) === "{oops", "Malformed Canvas bytes changed");

  phase = "external-edit conflict preservation";
  await clickSelector('[data-canvas-path="Boards/Conflict.canvas"]');
  const conflictOpened = await waitForCanvas("Boards/Conflict.canvas");
  const conflictRevision = conflictOpened.workspace.panes[0].activeCanvas.revision;
  await replaceText(
    'textarea[aria-label="Text for conflict-text"]',
    "Local Canvas conflict proposal",
  );
  const externalCanvas = JSON.parse(await fs.readFile(conflictPath, "utf8"));
  externalCanvas.nodes[0].text = "External Canvas winner";
  externalCanvas.externalVersion = { preserve: true };
  const externalText = `${JSON.stringify(externalCanvas, null, 2)}\n`;
  const externalStage = path.join(vaultPath, "Boards", "Conflict.canvas.external-stage");
  await fs.writeFile(externalStage, externalText, "utf8");
  await fs.rename(externalStage, conflictPath);
  await waitFor(
    () =>
      evaluate("window.threadleaf.getSnapshot()").then((snapshot) => {
        const active = snapshot?.workspace?.panes?.[0]?.activeCanvas;
        const textNode = active?.document?.nodes?.find((node) => node.id === "conflict-text");
        return active?.revision !== conflictRevision && textNode?.text === "External Canvas winner"
          ? snapshot
          : null;
      }),
    "Canvas runtime did not observe the external replacement",
  );
  assert(
    (await evaluate(
      "document.querySelector('textarea[aria-label=\"Text for conflict-text\"]')?.value",
    )) === "Local Canvas conflict proposal",
    "External Canvas refresh displaced the dirty local model",
  );
  await clickButton("Save");
  const conflictStatus = await waitFor(
    () =>
      evaluate("document.querySelector('#canvas-view .canvas-status')?.textContent ?? ''").then(
        (status) => (status.startsWith("Conflict preserved at ") ? status : null),
      ),
    "Canvas conflict did not become visible",
  );
  const conflictFiles = await waitFor(async () => {
    const files = (await fs.readdir(path.join(vaultPath, "Boards"))).filter(
      (name) => name.startsWith("Conflict.threadleaf-conflict-") && name.endsWith(".canvas"),
    );
    return files.length === 1 ? files : null;
  }, "Canvas conflict copy was not created exactly once");
  assert(
    (await fs.readFile(conflictPath, "utf8")) === externalText,
    "Canvas conflict overwrote the external winner",
  );
  const conflictProposal = JSON.parse(
    await fs.readFile(path.join(vaultPath, "Boards", conflictFiles[0]), "utf8"),
  );
  assert(
    conflictProposal.nodes[0].text === "Local Canvas conflict proposal" &&
      JSON.stringify(conflictProposal.futureDocumentField) ===
        JSON.stringify({ preserve: "conflict" }) &&
      JSON.stringify(conflictProposal.nodes[0].futureNodeField) === JSON.stringify(["preserve"]),
    "Canvas conflict copy lost the local proposal or unknown fields",
  );
  assert(
    conflictStatus.includes(conflictFiles[0]),
    `Canvas conflict status did not name its recovery file: ${conflictStatus}`,
  );
  await screenshot("canvas-dark-conflict");

  phase = "high-DPI, zoom, and two-pane Canvas";
  await clickSelector('[data-canvas-path="Boards/Overview.canvas"]');
  await waitForCanvas("Boards/Overview.canvas");
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
  await evaluate("document.body.style.zoom = ''; true");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1024,
    height: 700,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await delay(100);
  await clickSelector("#split-pane-right");
  const split = await waitFor(
    () =>
      evaluate("window.threadleaf.getSnapshot()").then((snapshot) =>
        snapshot?.workspace?.panes?.length === 2 ? snapshot : null,
      ),
    "Two-pane split did not complete",
  );
  assert(
    split.workspace.panes.some((pane) => pane.activeCanvas?.path === "Boards/Overview.canvas"),
    `Canvas disappeared from both panes after splitting: ${JSON.stringify(split.workspace.panes)}`,
  );
  assert(
    await evaluate("document.querySelectorAll('.canvas-view:not([hidden])').length >= 1"),
    "No visible Canvas surface remained after splitting",
  );
  await screenshot("canvas-two-pane");
  process.stdout.write(
    `${JSON.stringify({
      status: "ok",
      screenshots: screenshotDirectory,
      rendererProcesses: {
        initial: rendererCommands.length,
        restarted: restartedRendererCommands.length,
      },
      x11: true,
      panes: split.workspace.panes.length,
      savedNodes: savedOverview.nodes.length,
      attachmentPreviews: ["image", "text", "binary", "missing"],
      conflictPath: conflictFiles[0],
    })}\n`,
  );
} catch (error) {
  const detail = error instanceof Error ? error.stack : String(error);
  process.stderr.write(`Phase ${phase}: ${detail}\n`);
  process.exitCode = 1;
} finally {
  await close();
  await fs.rm(testRoot, { recursive: true, force: true });
}
