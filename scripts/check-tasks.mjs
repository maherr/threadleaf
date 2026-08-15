import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const appRoot = process.cwd();
const electronPath = path.join(appRoot, "node_modules", ".bin", "electron");
const scratchRoot = path.join(os.tmpdir(), "tl-scratch", "tasks-toggle");
await fs.mkdir(scratchRoot, { recursive: true });
const testRoot = await fs.mkdtemp(path.join(scratchRoot, "electron-"));
const vaultPath = path.join(testRoot, "vault");
const notePath = path.join(vaultPath, "Tasks.md");
const userDataPath = path.join(testRoot, "user-data");
const screenshotDirectory = process.env.THREADLEAF_TASKS_SCREENSHOT_DIR;
const output = [];
let child;
let childExit;
let cdp;
let phase = "setup";

const initialSource = [
  "\ufeff- [ ] reading open",
  "  - [x] nested complete",
  "> - [?] live custom",
  ">   1. [🟡] quoted unicode",
  "- [-] untouched custom",
  "",
].join("\r\n");
const afterLiveClick = initialSource.replace("[?]", "[ ]");
const afterCommand = afterLiveClick.replace("> - [ ] live custom", "> - [x] live custom");
const afterReadingClick = afterCommand.replace("[ ] reading open", "[x] reading open");
const afterLiveEditorText = afterLiveClick.replaceAll("\r\n", "\n").replace(/^\uFEFF/u, "");
const afterCommandEditorText = afterCommand.replaceAll("\r\n", "\n").replace(/^\uFEFF/u, "");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a loopback CDP port.");
  }
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitForMainTarget(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const renderer = targets.find(
          (target) =>
            target.type === "page" &&
            typeof target.url === "string" &&
            target.url.endsWith("/dist/renderer/index.html"),
        );
        if (renderer?.webSocketDebuggerUrl) {
          return renderer;
        }
      }
    } catch {
      // Electron is still starting.
    }
    await delay(50);
  }
  throw new Error("Threadleaf did not expose its isolated renderer in time.");
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

async function waitFor(probe, message, timeoutMs = 15_000) {
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

async function rendererCommandLines() {
  const entries = await fs.readdir("/proc");
  const commandLines = [];
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const commandLine = (await fs.readFile(`/proc/${entry}/cmdline`)).toString("utf8");
      if (
        commandLine.includes(`--user-data-dir=${userDataPath}`) &&
        commandLine.includes("--type=renderer")
      ) {
        commandLines.push(commandLine.replaceAll("\0", " ").trim());
      }
    } catch {
      // A renderer can exit between /proc enumeration and the read.
    }
  }
  return commandLines;
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
  childExit = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      output.push(String(chunk));
      if (output.length > 120) output.shift();
    });
  }
  const target = await waitForMainTarget(port);
  cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  const rendererArgs = await waitFor(async () => {
    const lines = await rendererCommandLines();
    return lines.length > 0 ? lines : null;
  }, "The isolated Electron renderer did not expose its argv");
  assert(
    rendererArgs.some((line) => line.includes("--ozone-platform=x11")),
    `Renderer argv did not prove explicit X11 mode: ${JSON.stringify(rendererArgs)}`,
  );
  assert(
    rendererArgs.every((line) => !line.includes("--ozone-platform=wayland")),
    `Renderer argv unexpectedly selected Wayland: ${JSON.stringify(rendererArgs)}`,
  );
}

async function closeApplication() {
  if (!child) return;
  try {
    await evaluate("setTimeout(() => window.close(), 20); true");
  } catch {
    // The renderer can disappear before the close response returns.
  }
  cdp?.close();
  cdp = undefined;
  const result = await Promise.race([
    childExit,
    delay(5_000).then(() => ({ code: null, signal: "timeout" })),
  ]);
  if (result.code !== 0 && child.pid) {
    child.kill("SIGKILL");
  }
  child = undefined;
  childExit = undefined;
}

async function targetCenter(selector) {
  const target = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return { error: "missing" };
    const rect = element.getBoundingClientRect();
    const points = [0.25, 0.5, 0.75].flatMap((xRatio) =>
      [0.25, 0.5, 0.75].map((yRatio) => ({
        x: rect.left + rect.width * xRatio,
        y: rect.top + rect.height * yRatio,
      })),
    );
    const point = points.find(({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      return hit === element || element.contains(hit);
    }) ?? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const hit = document.elementFromPoint(point.x, point.y);
    return {
      error: null,
      x: point.x,
      y: point.y,
      width: rect.width,
      height: rect.height,
      hit: hit === element || element.contains(hit),
      hidden: element.hidden || getComputedStyle(element).display === "none",
      disabled: element instanceof HTMLInputElement || element instanceof HTMLButtonElement ? element.disabled : false,
    };
  })()`);
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

async function pressControlL() {
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "l",
    code: "KeyL",
    modifiers: 2,
    windowsVirtualKeyCode: 76,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "l",
    code: "KeyL",
    modifiers: 2,
    windowsVirtualKeyCode: 76,
  });
}

async function screenshot(name) {
  const image = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  const bytes = Buffer.from(image.data, "base64");
  assert(
    bytes.length > 512 && bytes.subarray(1, 4).toString("ascii") === "PNG",
    "Screenshot was not a PNG.",
  );
  if (screenshotDirectory) {
    await fs.mkdir(screenshotDirectory, { recursive: true });
    await fs.writeFile(path.join(screenshotDirectory, `${name}.png`), bytes);
  }
}

async function editorText() {
  return evaluate(`(() => [...document.querySelectorAll("#note-editor .cm-line")]
    .map((line) => line.textContent ?? "")
    .join("\\n"))()`);
}

try {
  if (process.platform !== "linux") {
    throw new Error("The task integration check requires Linux and Xvfb.");
  }
  await fs.access(electronPath);
  await fs.mkdir(vaultPath, { recursive: true });
  await fs.writeFile(notePath, initialSource, "utf8");

  phase = "isolated Xvfb launch";
  await launch();
  await waitFor(
    async () =>
      (await evaluate('document.querySelector("#runtime-state")?.textContent')) === "Ready"
        ? true
        : null,
    "The task fixture vault did not become ready",
  );

  phase = "open synthetic task note";
  await evaluate('window.threadleaf.openNote("Tasks.md")');
  await waitFor(
    async () =>
      (await evaluate('document.querySelector("#note-path")?.textContent')) === "Tasks.md"
        ? true
        : null,
    "The synthetic task note did not open",
  );

  phase = "Live Preview custom click";
  await clickSelector("#edit-view");
  await waitFor(
    async () =>
      (await evaluate('document.querySelector("#note-view")?.dataset.view')) === "live"
        ? true
        : null,
    "Threadleaf did not enter Live Preview",
  );
  const liveTask = await waitFor(
    async () =>
      evaluate(`(() => {
        const input = document.querySelector('.tl-live-task[data-task="?"]');
        const line = input?.closest(".cm-line");
        return input instanceof HTMLInputElement && line instanceof HTMLElement
          ? { checked: input.checked, lineTask: line.dataset.task ?? "" }
          : null;
      })()`),
    "Live Preview did not render the custom task",
  );
  assert(
    liveTask.checked && liveTask.lineTask === "?",
    `Custom task state was not public: ${JSON.stringify(liveTask)}`,
  );
  await screenshot("tasks-live-before-click");
  await clickSelector('.tl-live-task[data-task="?"]');
  await waitFor(
    async () => ((await fs.readFile(notePath, "utf8")) === afterLiveClick ? true : null),
    "Live Preview click did not autosave the exact custom-marker change",
  );

  phase = "Ctrl/Cmd+L command";
  await clickSelector("#source-view");
  await waitFor(
    async () =>
      (await evaluate('document.querySelector("#note-view")?.dataset.view')) === "source"
        ? true
        : null,
    "Threadleaf did not enter Source mode",
  );
  let sourceAfterLive = "";
  try {
    await waitFor(async () => {
      sourceAfterLive = await editorText();
      return sourceAfterLive === afterLiveEditorText ? true : null;
    }, "Source mode did not show the exact Live Preview edit");
  } catch (error) {
    throw new Error(
      `Source mode did not show the exact Live Preview edit. Expected ${JSON.stringify(afterLiveEditorText)}, observed ${JSON.stringify(sourceAfterLive)}.`,
      { cause: error },
    );
  }
  await clickSelector("#note-editor .cm-line:nth-child(3)");
  await pressControlL();
  await waitFor(
    async () => ((await fs.readFile(notePath, "utf8")) === afterCommand ? true : null),
    "Ctrl/Cmd+L did not autosave the cursor-line task toggle",
  );
  await waitFor(
    async () => ((await editorText()) === afterCommandEditorText ? true : null),
    "Source mode did not show the command change",
  );

  phase = "Reading view click";
  await clickSelector("#read-view");
  await waitFor(
    async () =>
      (await evaluate('document.querySelector("#note-view")?.dataset.view')) === "reading"
        ? true
        : null,
    "Threadleaf did not enter Reading view",
  );
  const readingTask = await waitFor(
    async () =>
      evaluate(`(() => {
        const item = document.querySelector('li.task-list-item[data-source-line="1"]');
        const input = item?.querySelector('input[data-threadleaf-task="true"]');
        return item instanceof HTMLElement && input instanceof HTMLInputElement
          ? { task: item.getAttribute("data-task"), checked: input.checked, disabled: input.disabled }
          : null;
      })()`),
    "Reading view did not render the first task checkbox",
  );
  assert(
    readingTask.task === "" && !readingTask.checked && !readingTask.disabled,
    `Reading task did not expose the open state: ${JSON.stringify(readingTask)}`,
  );
  await screenshot("tasks-reading-before-click");
  await clickSelector('li.task-list-item[data-source-line="1"] input[data-threadleaf-task="true"]');
  await waitFor(
    async () => ((await fs.readFile(notePath, "utf8")) === afterReadingClick ? true : null),
    "Reading view click did not autosave the exact task change",
  );
  const toggledReadingTask = await waitFor(
    async () =>
      evaluate(
        `(() => document.querySelector('li.task-list-item[data-source-line="1"] input[data-threadleaf-task="true"]') instanceof HTMLInputElement && document.querySelector('li.task-list-item[data-source-line="1"] input[data-threadleaf-task="true"]').checked ? true : null)()`,
      ),
    "Reading view did not re-render the checked source marker",
  );
  assert(toggledReadingTask, "Reading view did not show the checked task.");
  await screenshot("tasks-reading-after-click");

  assert(
    (await fs.readFile(notePath, "utf8")) === afterReadingClick,
    "Task check changed bytes outside the intended status markers.",
  );
  console.log("TASKS_OK live-click command reading-click autosave CRLF unicode");
} catch (error) {
  console.error(`TASKS_FAILED phase=${phase}`);
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  if (output.length > 0) {
    console.error(output.join(""));
  }
  process.exitCode = 1;
} finally {
  await closeApplication();
  await fs.rm(testRoot, { recursive: true, force: true });
}
