import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";

const appRoot = process.cwd();
const electronPath = path.join(appRoot, "node_modules", ".bin", "electron");
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-live-preview-"));
const vaultPath = path.join(testRoot, "vault");
const userDataPath = path.join(testRoot, "user-data");
const screenshotDirectory = process.env.THREADLEAF_LIVE_PREVIEW_SCREENSHOT_DIR;
const output = [];
let child;
let exited;
let cdp;
let phase = "setup";

const showcaseSource = `---
project: atlas
status: active
---
# Live Preview

This is **strong**, *emphasis*, ~~strike~~, and \`inline code\`.

Open [[Linked Note|linked note]], [Markdown link](Linked%20Note.md), and [the web](https://example.com).

#threadleaf #project/atlas

- [ ] open task
- [x] completed task

> [!note]+ Source-backed callout
> Exact Markdown returns when the cursor enters this line.

![[pixel.png|fixture image]]

![[Linked Note#Details]]

\`\`\`ts
const source = "canonical";
\`\`\`

| Field | Value |
| --- | --- |
| mode | live |
`;

const linkedSource = `# Linked Note

## Details

This ordinary Markdown note is a real internal-link target.
`;

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function fixturePng(width = 240, height = 96) {
  const stride = width * 4 + 1;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    pixels[y * stride] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = y * stride + 1 + x * 4;
      const accent = (x + y) % 32 < 16;
      const upper = y < height / 2;
      const color = upper
        ? accent
          ? [0, 114, 178]
          : [66, 146, 198]
        : accent
          ? [230, 159, 0]
          : [244, 195, 78];
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

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

async function targetCenter(selector, rootSelector = null) {
  const target = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return { error: "missing" };
    const root = ${rootSelector ? `document.querySelector(${JSON.stringify(rootSelector)})` : "element"};
    if (!(root instanceof HTMLElement)) return { error: "missing-root" };
    const rect = element.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const x = Math.max(rect.left, rootRect.left) + Math.min(rect.width, rootRect.width) / 2;
    const y = Math.max(rect.top, rootRect.top) + Math.min(rect.height, rootRect.height) / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      error: null,
      x,
      y,
      width: rect.width,
      height: rect.height,
      hit: Boolean(hit && (hit === element || element.contains(hit))),
      hidden: element.hidden || getComputedStyle(element).display === "none",
      disabled: element instanceof HTMLButtonElement ? element.disabled : false,
    };
  })()`);
  assert(target && !target.error, `Pointer target is unavailable: ${selector}`);
  assert(!target.hidden && !target.disabled, `Pointer target is not interactive: ${selector}`);
  assert(target.width > 0 && target.height > 0, `Pointer target has no geometry: ${selector}`);
  assert(target.hit, `Pointer target is covered at its center: ${selector}`);
  return target;
}

async function clickSelector(selector, modifiers = 0, rootSelector = null) {
  const target = await targetCenter(selector, rootSelector);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await cdp.send("Input.dispatchMouseEvent", {
      type,
      button: type === "mouseMoved" ? "none" : "left",
      buttons: type === "mousePressed" ? 1 : 0,
      clickCount: type === "mouseMoved" ? 0 : 1,
      modifiers,
      x: target.x,
      y: target.y,
    });
  }
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

async function waitForShowcase() {
  return waitFor(async () => {
    const state = await evaluate(`(() => ({
      ready: document.querySelector("#runtime-state")?.textContent === "Ready",
      path: document.querySelector("#note-path")?.textContent ?? "",
      mode: document.querySelector("#note-view")?.dataset.view ?? "",
      livePressed: document.querySelector("#edit-view")?.getAttribute("aria-pressed"),
      sourcePressed: document.querySelector("#source-view")?.getAttribute("aria-pressed"),
    }))()`);
    return state.ready && state.path === "Showcase.md" ? state : null;
  }, "The Live Preview showcase did not open");
}

async function liveSurfaceState() {
  return evaluate(`(() => ({
    mode: document.querySelector("#note-view")?.dataset.view ?? "",
    heading: document.querySelectorAll(".tl-live-heading").length,
    strong: document.querySelectorAll(".tl-live-strong").length,
    emphasis: document.querySelectorAll(".tl-live-emphasis").length,
    strike: document.querySelectorAll(".tl-live-strikethrough").length,
    code: document.querySelectorAll(".tl-live-inline-code").length,
    links: document.querySelectorAll(".tl-live-link").length,
    tags: document.querySelectorAll(".tl-live-tag").length,
    tasks: document.querySelectorAll(".tl-live-task").length,
    checkedTasks: document.querySelectorAll(".tl-live-task:checked").length,
    callouts: document.querySelectorAll(".tl-live-callout").length,
    embeds: document.querySelectorAll(".tl-live-embed").length,
    images: document.querySelectorAll(".tl-live-image").length,
    readyImages: document.querySelectorAll('.tl-live-image[data-status="ready"] img').length,
    imageState: (() => {
      const image = document.querySelector(".tl-live-image");
      return image instanceof HTMLElement
        ? {
            status: image.dataset.status ?? "",
            reason: image.dataset.reason ?? "",
            title: image.title,
            text: image.textContent,
          }
        : null;
    })(),
    codeLines: document.querySelectorAll(".tl-live-code-line").length,
    tableLines: document.querySelectorAll(".tl-live-table-line").length,
    frontmatterLines: document.querySelectorAll(".tl-live-frontmatter-line").length,
    activeText: document.querySelector(".cm-activeLine")?.textContent ?? "",
    overflow: (() => {
      const shell = document.querySelector("#note-editor-shell");
      return shell instanceof HTMLElement ? shell.scrollWidth - shell.clientWidth : 0;
    })(),
  }))()`);
}

try {
  if (process.platform !== "linux") {
    throw new Error("The Live Preview integration check currently requires Linux and Xvfb.");
  }
  await fs.access(electronPath);
  await fs.mkdir(vaultPath, { recursive: true });
  await fs.writeFile(path.join(vaultPath, "Showcase.md"), showcaseSource);
  await fs.writeFile(path.join(vaultPath, "Linked Note.md"), linkedSource);
  await fs.writeFile(path.join(vaultPath, "pixel.png"), fixturePng());

  phase = "isolated launch";
  await launchApplication();
  await waitFor(async () => {
    const snapshot = await evaluate("window.threadleaf.getSnapshot()");
    return snapshot?.workspace?.state === "ready" && snapshot?.vault?.path === vaultPath
      ? snapshot
      : null;
  }, "The isolated vault did not become ready");

  phase = "default Live mode";
  await waitFor(async () => {
    const state = await evaluate(`(() => ({
        target: Boolean(document.querySelector('[data-note-path="Showcase.md"]')),
        count: document.querySelector("#file-count")?.textContent ?? "",
        list: document.querySelector("#file-list")?.textContent ?? "",
        runtime: document.querySelector("#runtime-state")?.textContent ?? "",
      }))()`);
    return state.target ? state : null;
  }, "The Showcase note did not appear in the virtual file list");
  await clickSelector('[data-note-path="Showcase.md"]');
  let opened = await waitForShowcase();
  assert(opened.mode === "live", `A fresh profile opened in ${opened.mode}, not Live mode.`);
  assert(opened.livePressed === "true", "The Live mode control did not expose pressed state.");
  assert(opened.sourcePressed === "false", "The Source control falsely exposed pressed state.");
  const imageProbe = await evaluate(`(async () => {
    const snapshot = await window.threadleaf.getSnapshot();
    const response = await window.threadleaf.loadVaultImage(
      "Showcase.md",
      "pixel.png",
      snapshot.vault.id,
    );
    if (response.status !== "ready") return response;
    const decode = await new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve({ status: "loaded", width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => resolve({ status: "error" });
      image.src = \`data:\${response.mimeType};base64,\${response.base64}\`;
    });
    return { status: response.status, vaultId: response.vaultId, path: response.path, size: response.size, decode };
  })()`);

  phase = "rich rendering";
  let observedSurface;
  let surface;
  try {
    surface = await waitFor(async () => {
      const candidate = await liveSurfaceState();
      observedSurface = candidate;
      return candidate.heading >= 1 &&
        candidate.strong >= 1 &&
        candidate.emphasis >= 1 &&
        candidate.strike >= 1 &&
        candidate.code >= 1 &&
        candidate.links >= 3 &&
        candidate.tags === 2 &&
        candidate.tasks === 2 &&
        candidate.checkedTasks === 1 &&
        candidate.callouts === 1 &&
        candidate.embeds === 1 &&
        candidate.readyImages === 1 &&
        candidate.codeLines >= 3 &&
        candidate.tableLines >= 3 &&
        candidate.frontmatterLines >= 4
        ? candidate
        : null;
    }, "The rich Live Preview corpus did not finish rendering");
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} ${JSON.stringify({ observedSurface, imageProbe })}`,
    );
  }
  assert(surface.overflow <= 1, `Live Preview overflowed horizontally by ${surface.overflow}px.`);
  await captureScreenshot("live-preview-dark");
  await evaluate(`(() => {
    const scroller = document.querySelector("#note-editor .cm-scroller");
    if (!(scroller instanceof HTMLElement)) return false;
    scroller.scrollTop = scroller.scrollHeight;
    return true;
  })()`);
  await delay(100);
  await captureScreenshot("live-preview-dark-lower");
  await evaluate(`(() => {
    const scroller = document.querySelector("#note-editor .cm-scroller");
    if (!(scroller instanceof HTMLElement)) return false;
    scroller.scrollTop = 0;
    return true;
  })()`);
  await delay(100);

  phase = "cursor-proximate source reveal";
  await clickSelector(".tl-live-strong", 0, ".cm-content");
  let observedReveal;
  try {
    surface = await waitFor(async () => {
      const candidate = await liveSurfaceState();
      observedReveal = candidate;
      return candidate.activeText.includes("**strong**") ? candidate : null;
    }, "Clicking rendered emphasis did not reveal exact source");
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} ${JSON.stringify(observedReveal)}`,
    );
  }
  await clickSelector(".tl-live-heading-1", 0, ".cm-content");
  await waitFor(async () => {
    const candidate = await liveSurfaceState();
    return candidate.strong >= 1 && !candidate.activeText.includes("**strong**") ? candidate : null;
  }, "Leaving the source line did not restore its rendering");

  phase = "task source mutation and undo";
  await clickSelector(".tl-live-task:not(:checked)", 0, ".cm-content");
  await waitFor(async () => {
    const candidate = await liveSurfaceState();
    const state = await evaluate('document.querySelector("#edit-state")?.textContent ?? ""');
    return candidate.checkedTasks === 2 && state === "Unsaved" ? candidate : null;
  }, "The task widget did not enter the normal dirty path");
  await pressKey("z", "KeyZ", 2);
  await waitFor(async () => (await liveSurfaceState()).checkedTasks === 1, "Task undo failed");
  await pressKey("Z", "KeyZ", 2 | 8);
  await waitFor(async () => (await liveSurfaceState()).checkedTasks === 2, "Task redo failed");

  phase = "Source round trip";
  await clickSelector("#source-view");
  const sourceMode = await waitFor(async () => {
    const candidate = await evaluate(`(() => ({
      mode: document.querySelector("#note-view")?.dataset.view ?? "",
      text: [...document.querySelectorAll("#note-editor .cm-line")].map((line) => line.textContent ?? "").join("\\n"),
      liveWidgets: document.querySelectorAll("#note-editor .tl-live-task, #note-editor .tl-live-link").length,
    }))()`);
    return candidate.mode === "source" ? candidate : null;
  }, "The Source control did not enter exact-source mode");
  assert(sourceMode.text.includes("- [x] open task"), "Source mode did not expose the task edit.");
  assert(
    sourceMode.text.includes("[[Linked Note|linked note]]"),
    "Source mode hid wikilink bytes.",
  );
  assert(sourceMode.liveWidgets === 0, "Live widgets remained in Source mode.");
  await clickSelector("#edit-view");
  await waitFor(async () => (await liveSurfaceState()).mode === "live", "Live mode did not return");

  phase = "exact save bytes";
  await pressKey("s", "KeyS", 2);
  await waitFor(
    async () =>
      (await evaluate('document.querySelector("#edit-state")?.textContent ?? ""')) === "Saved",
    "The Live Preview task edit did not save",
  );
  const savedSource = await fs.readFile(path.join(vaultPath, "Showcase.md"), "utf8");
  assert(
    savedSource === showcaseSource.replace("- [ ] open task", "- [x] open task"),
    "Live Preview changed bytes beyond the exact task marker.",
  );

  phase = "internal link activation";
  await clickSelector(".tl-live-link-internal", 2, ".cm-content");
  await waitFor(
    async () =>
      (await evaluate('document.querySelector("#note-path")?.textContent ?? ""')) ===
      "Linked Note.md",
    "Modifier-clicking an internal Live Preview link did not navigate",
  );
  await clickSelector('[data-note-path="Showcase.md"]');
  await waitForShowcase();

  phase = "pane-local modes";
  await clickSelector("#split-pane-right");
  await waitFor(async () => {
    const snapshot = await evaluate("window.threadleaf.getSnapshot()");
    return snapshot.workspace?.panes.length === 2 ? snapshot : null;
  }, "The Live Preview document could not be split");
  await clickSelector('[data-note-path="Linked Note.md"]');
  await clickSelector("#source-view-secondary");
  await clickSelector(
    '[data-pane-id="primary"] .tl-live-heading-1',
    0,
    '[data-pane-id="primary"] .cm-content',
  );
  const paneModes = await waitFor(async () => {
    const candidate = await evaluate(`(() => ({
      active: document.querySelector('[data-pane-id="primary"]')?.dataset.active,
      primary: document.querySelector("#note-view")?.dataset.view,
      secondary: document.querySelector("#note-view-secondary")?.dataset.view,
    }))()`);
    return candidate.active === "true" ? candidate : null;
  }, "The primary pane did not regain focus");
  assert(
    paneModes.primary === "live" && paneModes.secondary === "source",
    `Pane modes leaked across editors: ${JSON.stringify(paneModes)}`,
  );

  phase = "light-theme visual";
  await clickSelector("#theme-toggle");
  await waitFor(
    async () => (await evaluate("document.documentElement.dataset.theme")) === "light",
    "The isolated surface did not switch to light mode",
  );
  await captureScreenshot("live-preview-light-split");

  phase = "preferred mode restart";
  await clickSelector("#edit-view");
  await closeApplication();
  await launchApplication();
  opened = await waitForShowcase();
  assert(opened.mode === "live", "The preferred Live editing mode did not survive restart.");
  await closeApplication();

  console.log(
    "Verified isolated virtual input and screenshots for default Live Preview, rich Markdown rendering, exact cursor reveal, task edit/undo/redo/save bytes, Source round trip, internal-link activation, pane-local modes, both themes, and restart persistence.",
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
