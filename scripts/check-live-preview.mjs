import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";

const appRoot = process.cwd();
const electronPath = path.join(appRoot, "node_modules", ".bin", "electron");
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-live-preview-"));
const vaultAPath = path.join(testRoot, "vault-a");
const vaultBPath = path.join(testRoot, "vault-b");
let activeVaultPath = vaultAPath;
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

> [!note]+ Source-backed **callout**
> Exact Markdown returns when the cursor enters this line.
>
> > [!tip] Nested callout
> > The nested body remains part of the outer callout.

> [!warning]- Collapsed by default
> This body is hidden until its title is activated.

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

async function rendererCommandLines() {
  const entries = await fs.readdir("/proc");
  const commandLines = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    try {
      const commandLine = (await fs.readFile(`/proc/${entry}/cmdline`)).toString("utf8");
      if (
        commandLine.includes(`--user-data-dir=${userDataPath}`) &&
        commandLine.includes("--type=renderer") &&
        !commandLine.includes("--no-sandbox")
      ) {
        commandLines.push(commandLine.replaceAll("\u0000", " ").trim());
      }
    } catch {
      // A Chromium child can exit between /proc enumeration and the read.
    }
  }
  return commandLines;
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

async function launchApplication(options = {}) {
  const { vaultPath = activeVaultPath, env = {} } = options;
  activeVaultPath = vaultPath;
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
        ...env,
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
  const rendererArgs = await waitFor(async () => {
    const lines = await rendererCommandLines();
    return lines.length > 0 ? lines : null;
  }, "The isolated Electron renderer did not expose an argv record");
  assert(
    rendererArgs.some((line) => line.includes("--ozone-platform=x11")),
    `Renderer argv did not prove explicit X11 mode: ${JSON.stringify(rendererArgs)}`,
  );
  await ensureFlatNavigator();
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
    const left = Math.max(rect.left, rootRect.left);
    const top = Math.max(rect.top, rootRect.top);
    const width = Math.min(rect.right, rootRect.right) - left;
    const height = Math.min(rect.bottom, rootRect.bottom) - top;
    const points = [0.2, 0.5, 0.8].flatMap((xRatio) =>
      [0.2, 0.5, 0.8].map((yRatio) => ({
        x: left + width * xRatio,
        y: top + height * yRatio,
      })),
    );
    const point = points.find(({ x, y }) => {
      const candidate = document.elementFromPoint(x, y);
      return Boolean(candidate && (candidate === element || element.contains(candidate)));
    }) ?? { x: left + width / 2, y: top + height / 2 };
    const hit = document.elementFromPoint(point.x, point.y);
    return {
      error: null,
      x: point.x,
      y: point.y,
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

// Live Preview intentionally keeps the flat file-picker fixture. Tree behavior
// is separately covered by check-navigator-tree, including its isolated UI run.
async function ensureFlatNavigator() {
  const mode = await waitFor(async () => {
    const value = await evaluate('document.querySelector("#file-list")?.dataset.mode ?? null');
    return value === "tree" || value === "virtual" ? value : null;
  }, "The navigator did not render before Live Preview checks");
  if (mode === "tree") await clickSelector("#navigator-view-toggle");
  await waitFor(
    async () =>
      (await evaluate('document.querySelector("#file-list")?.dataset.mode')) === "virtual"
        ? true
        : null,
    "The Live Preview fixture could not select the flat navigator",
  );
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

async function composeText(text) {
  await cdp.send("Input.imeSetComposition", {
    text,
    selectionStart: text.length,
    selectionEnd: text.length,
  });
  await cdp.send("Input.insertText", { text });
}

async function captureScreenshot(name) {
  const result = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  });
  const bytes = Buffer.from(result.data, "base64");
  if (screenshotDirectory) {
    await fs.mkdir(screenshotDirectory, { recursive: true });
    await fs.writeFile(path.join(screenshotDirectory, `${name}.png`), bytes);
  }
  return bytes;
}

function pngDimensions(bytes) {
  if (bytes.length < 24 || bytes.toString("ascii", 1, 4) !== "PNG") {
    return { width: 0, height: 0 };
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function waitForShowcase() {
  return waitFor(async () => {
    const state = await evaluate(`(() => ({
      ready: document.querySelector("#runtime-state")?.textContent === "Ready",
      path: document.querySelector("#note-path")?.textContent ?? "",
      mode: document.querySelector("#note-view")?.dataset.view ?? "",
      noteHidden: document.querySelector("#note-view")?.hidden ?? true,
      livePressed: document.querySelector("#edit-view")?.getAttribute("aria-pressed"),
      sourcePressed: document.querySelector("#source-view")?.getAttribute("aria-pressed"),
    }))()`);
    return state.ready && state.path === "Showcase.md" ? state : null;
  }, "The Live Preview showcase did not open");
}

async function waitForPersistedMode(vaultId, expected) {
  return waitFor(
    async () => {
      const snapshot = await evaluate("window.threadleaf.getSettings()");
      const mode = snapshot?.settings?.workspaceByVault?.[vaultId];
      return mode?.editorMode === expected.editorMode &&
        mode?.documentView === expected.documentView
        ? mode
        : null;
    },
    `Vault ${vaultId} did not persist ${JSON.stringify(expected)}`,
  );
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
    callouts: document.querySelectorAll(".tl-live-callout-block .callout").length,
    calloutState: (() => {
      const outer = document.querySelector('.tl-live-callout-block .callout[data-callout="note"]');
      const nested = document.querySelector('.tl-live-callout-block .callout[data-callout="tip"]');
      const collapsed = document.querySelector('.tl-live-callout-block .callout[data-callout="warning"]');
      const title = outer?.querySelector(".callout-title-inner");
      const icon = outer?.querySelector(".callout-icon");
      const collapsedContent = collapsed?.querySelector(".callout-content");
      return {
        outerDataCallout: outer instanceof HTMLElement ? outer.dataset.callout ?? "" : "",
        titleText: title?.textContent?.replace(/\\s+/gu, " ").trim() ?? "",
        icon: icon instanceof HTMLElement ? getComputedStyle(icon, "::before").content : "",
        nested: nested instanceof HTMLElement,
        outerCollapsed: outer instanceof HTMLElement && outer.classList.contains("is-collapsed"),
        outerBodyHidden:
          outer?.querySelector(".callout-content") instanceof HTMLElement &&
          getComputedStyle(outer.querySelector(".callout-content")).display === "none",
        collapsed: collapsed instanceof HTMLElement && collapsed.classList.contains("is-collapsed"),
        collapsedBodyHidden:
          collapsedContent instanceof HTMLElement && getComputedStyle(collapsedContent).display === "none",
      };
    })(),
    embeds: document.querySelectorAll(".tl-live-embed").length,
    embedState: (() => {
      const embed = document.querySelector(".tl-live-embed");
      return embed instanceof HTMLElement
        ? {
            status: embed.dataset.tlTransclusionStatus ?? "",
            owner: embed.dataset.tlSourceOwner ?? "",
            target: embed.dataset.tlTransclusionPath ?? "",
          }
        : null;
    })(),
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
    tableRows: document.querySelectorAll(".tl-live-table-widget").length,
    tableCells: document.querySelectorAll(".tl-live-table-cell").length,
    tableText: [...document.querySelectorAll(".tl-live-table-widget")]
      .map((row) => row.textContent ?? "")
      .join("|")
      .replace(/\\s+/gu, " ")
      .trim(),
    tableGeometry: (() => {
      const row = document.querySelector(".tl-live-table-row-header");
      const cells = row ? [...row.querySelectorAll(".tl-live-table-cell")] : [];
      const style = row instanceof HTMLElement ? getComputedStyle(row) : null;
      return {
        display: style?.display ?? "",
        columns: style?.gridTemplateColumns ?? "",
        rowWidth: row instanceof HTMLElement ? row.getBoundingClientRect().width : 0,
        cellWidths: cells.map((cell) => (cell instanceof HTMLElement ? cell.getBoundingClientRect().width : 0)),
        cellLefts: cells.map((cell) => (cell instanceof HTMLElement ? cell.getBoundingClientRect().left : 0)),
      };
    })(),
    frontmatterLines: document.querySelectorAll(".tl-live-frontmatter-line").length,
    activeText: document.querySelector(".cm-activeLine")?.textContent ?? "",
    overflow: (() => {
      const shell = document.querySelector("#note-editor-shell");
      return shell instanceof HTMLElement ? shell.scrollWidth - shell.clientWidth : 0;
    })(),
  }))()`);
}

async function calloutContrastState(rootSelector) {
  return evaluate(`(() => {
    const root = document.querySelector(${JSON.stringify(rootSelector)});
    const callout = root?.querySelector('.callout[data-callout="note"]');
    const title = callout?.querySelector(".callout-title");
    const icon = callout?.querySelector(".callout-icon");
    if (!(title instanceof HTMLElement) || !(icon instanceof HTMLElement)) {
      return { available: false };
    }
    const parse = (value) => {
      const rgb = /^rgba?\\(\\s*([\\d.]+)[, ]+\\s*([\\d.]+)[, ]+\\s*([\\d.]+)(?:[, /]+\\s*([\\d.]+))?\\s*\\)$/u.exec(value);
      if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), Number(rgb[4] ?? 1)];
      const srgb = /^color\\(srgb\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)(?:\\s*\\/\\s*([\\d.]+))?\\)$/u.exec(value);
      if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, Number(srgb[4] ?? 1)];
      return null;
    };
    const luminance = (channels) => {
      const linear = channels.slice(0, 3).map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    };
    const ratio = (foreground, background) => {
      if (!foreground || !background || foreground[3] !== 1 || background[3] !== 1) return null;
      const left = luminance(foreground);
      const right = luminance(background);
      return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
    };
    const contrast = (current) => {
      const currentTitle = current.querySelector(".callout-title");
      const currentIcon = current.querySelector(".callout-icon");
      if (!(currentTitle instanceof HTMLElement) || !(currentIcon instanceof HTMLElement)) return null;
      const style = getComputedStyle(currentTitle);
      const iconStyle = getComputedStyle(currentIcon);
      return {
        titleContrast: ratio(parse(style.color), parse(style.backgroundColor)),
        iconContrast: ratio(parse(iconStyle.color), parse(style.backgroundColor)),
        titleColor: style.color,
        titleBackground: style.backgroundColor,
        iconColor: iconStyle.color,
      };
    };
    const note = contrast(callout);
    const probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText = "position: fixed; left: -10000px; top: 0; width: 1px; pointer-events: none;";
    const types = ["note", "abstract", "info", "todo", "tip", "success", "question", "warning", "failure", "danger", "bug", "example", "quote"];
    for (const type of types) {
      const item = document.createElement("div");
      item.className = "callout";
      item.dataset.callout = type;
      item.dataset.calloutStyle = type;
      item.innerHTML = '<div class="callout-title"><div class="callout-icon"></div><div class="callout-title-inner">' + type + '</div></div>';
      probe.append(item);
    }
    root.append(probe);
    const byType = Object.fromEntries(
      [...probe.querySelectorAll(".callout")].map((item) => [item.dataset.calloutStyle, contrast(item)]),
    );
    probe.remove();
    return {
      available: true,
      ...note,
      byType,
    };
  })()`);
}

function hasAccessibleCalloutContrast(state) {
  return (
    state.available &&
    state.titleContrast >= 4.5 &&
    state.iconContrast >= 3 &&
    Object.values(state.byType ?? {}).every(
      (contrast) => contrast?.titleContrast >= 4.5 && contrast?.iconContrast >= 3,
    )
  );
}

try {
  if (process.platform !== "linux") {
    throw new Error("The Live Preview integration check currently requires Linux and Xvfb.");
  }
  await fs.access(electronPath);
  for (const vaultPath of [vaultAPath, vaultBPath]) {
    await fs.mkdir(vaultPath, { recursive: true });
    await fs.writeFile(path.join(vaultPath, "Showcase.md"), showcaseSource);
    await fs.writeFile(path.join(vaultPath, "Linked Note.md"), linkedSource);
    await fs.writeFile(path.join(vaultPath, "pixel.png"), fixturePng());
  }

  phase = "isolated launch";
  await launchApplication({ vaultPath: vaultAPath });
  const firstReadySnapshot = await waitFor(async () => {
    const snapshot = await evaluate("window.threadleaf.getSnapshot()");
    return snapshot?.workspace?.state === "ready" && snapshot?.vault?.path === vaultAPath
      ? snapshot
      : null;
  }, "The isolated vault did not become ready");
  const vaultAId = firstReadySnapshot.vault.id;

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
        candidate.callouts === 3 &&
        candidate.embeds === 1 &&
        candidate.embedState?.status === "ready" &&
        candidate.embedState.owner === "Showcase.md" &&
        candidate.embedState.target === "Linked Note.md" &&
        candidate.readyImages === 1 &&
        candidate.codeLines >= 3 &&
        candidate.tableRows >= 3 &&
        candidate.tableCells >= 4 &&
        candidate.tableGeometry?.display === "grid" &&
        candidate.tableGeometry.rowWidth > 0 &&
        candidate.tableGeometry.cellWidths.length >= 2 &&
        candidate.tableGeometry.cellWidths.every((width) => width > 0) &&
        candidate.tableGeometry.cellLefts[1] > candidate.tableGeometry.cellLefts[0] &&
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
  assert(
    surface.tableText.includes("Field") && surface.tableText.includes("Value"),
    "Live table header text was not visible.",
  );
  assert(
    surface.tableText.includes("modelive") || surface.tableText.includes("mode live"),
    "Live table body text was not visible.",
  );
  assert(
    surface.calloutState?.outerDataCallout === "note" &&
      surface.calloutState.titleText.includes("Source-backed callout") &&
      surface.calloutState.icon.length > 0 &&
      surface.calloutState.nested &&
      surface.calloutState.collapsed &&
      surface.calloutState.collapsedBodyHidden,
    `Live Preview callout contract was incomplete: ${JSON.stringify(surface.calloutState)}`,
  );

  phase = "callouts in Reading view";
  await clickSelector("#read-view");
  await waitFor(async () => {
    const candidate = await evaluate(`(() => {
      const root = document.querySelector("#note-preview");
      const outer = root?.querySelector('.callout[data-callout="note"]');
      const nested = root?.querySelector('.callout[data-callout="tip"]');
      const collapsed = root?.querySelector('.callout[data-callout="warning"]');
      const title = outer?.querySelector(".callout-title-inner");
      return {
        mode: document.querySelector("#note-view")?.dataset.view ?? "",
        count: root?.querySelectorAll(".callout").length ?? 0,
        outer: outer instanceof HTMLElement ? outer.dataset.callout ?? "" : "",
        title: title?.textContent?.replace(/\\s+/gu, " ").trim() ?? "",
        nested: nested instanceof HTMLElement,
        collapsed: collapsed instanceof HTMLElement && collapsed.classList.contains("is-collapsed"),
      };
    })()`);
    return candidate.mode === "reading" &&
      candidate.count === 3 &&
      candidate.outer === "note" &&
      candidate.title.includes("Source-backed callout") &&
      candidate.nested &&
      candidate.collapsed
      ? candidate
      : null;
  }, "Reading view did not render the full nested callout contract");
  await captureScreenshot("callouts-reading-dark-expanded");
  await clickSelector(
    '#note-preview .callout[data-callout="note"] .callout-title',
    0,
    "#note-preview",
  );
  await waitFor(async () => {
    const candidate = await evaluate(`(() => {
      const callout = document.querySelector('#note-preview .callout[data-callout="note"]');
      const title = callout?.querySelector(".callout-title");
      return {
        collapsed: callout instanceof HTMLElement && callout.classList.contains("is-collapsed"),
        expanded: title instanceof HTMLElement ? title.getAttribute("aria-expanded") : null,
      };
    })()`);
    return candidate.collapsed && candidate.expanded === "false" ? candidate : null;
  }, "Reading callout title did not toggle its view-only fold state");
  const darkCalloutContrast = await calloutContrastState("#note-preview");
  assert(
    hasAccessibleCalloutContrast(darkCalloutContrast),
    `Dark Reading callout contrast was insufficient: ${JSON.stringify(darkCalloutContrast)}`,
  );
  await captureScreenshot("callouts-reading-dark");
  await clickSelector("#theme-toggle");
  await waitFor(
    async () => (await evaluate("document.documentElement.dataset.theme")) === "light",
    "The isolated surface did not switch to light for Reading callout verification",
  );
  const lightCalloutContrast = await calloutContrastState("#note-preview");
  assert(
    hasAccessibleCalloutContrast(lightCalloutContrast),
    `Light Reading callout contrast was insufficient: ${JSON.stringify(lightCalloutContrast)}`,
  );
  await captureScreenshot("callouts-reading-light");
  await clickSelector("#theme-toggle");
  await waitFor(
    async () => (await evaluate("document.documentElement.dataset.theme")) === "dark",
    "The isolated surface did not restore dark mode after Reading callout verification",
  );
  await clickSelector("#edit-view");
  surface = await waitFor(async () => {
    const candidate = await liveSurfaceState();
    return candidate.mode === "live" && candidate.callouts === 3 ? candidate : null;
  }, "Live Preview did not return after Reading callout verification");

  phase = "callouts in Live Preview";
  await clickSelector(
    '.tl-live-callout-block .callout[data-callout="note"] .callout-title',
    0,
    "#note-editor .cm-scroller",
  );
  surface = await waitFor(async () => {
    const candidate = await liveSurfaceState();
    return candidate.calloutState?.outerCollapsed === true &&
      candidate.calloutState?.outerBodyHidden
      ? candidate
      : null;
  }, "Live Preview callout title did not toggle collapse without revealing source");
  await clickSelector(
    '.tl-live-callout-block .callout[data-callout="note"] .callout-title',
    0,
    "#note-editor .cm-scroller",
  );
  await waitFor(async () => {
    const candidate = await evaluate(`(() => {
      const callout = document.querySelector('.tl-live-callout-block .callout[data-callout="note"]');
      const title = callout?.querySelector(".callout-title");
      return {
        collapsed: callout instanceof HTMLElement && callout.classList.contains("is-collapsed"),
        expanded: title instanceof HTMLElement ? title.getAttribute("aria-expanded") : null,
      };
    })()`);
    return !candidate.collapsed && candidate.expanded === "true" ? candidate : null;
  }, "Live Preview callout did not expand again");
  await captureScreenshot("live-preview-dark-rendered-callouts");
  assert(
    await evaluate(`(() => {
      const content = document.querySelector('.tl-live-callout-block .callout[data-callout="note"] .callout-content');
      if (!(content instanceof HTMLElement)) return false;
      content.scrollIntoView({ block: "center", inline: "nearest" });
      return true;
    })()`),
    "The rendered Live Preview callout body was unavailable for source-reveal verification.",
  );
  await delay(100);
  await clickSelector(
    '.tl-live-callout-block .callout[data-callout="note"] .callout-content',
    0,
    "#note-editor .cm-scroller",
  );
  await waitFor(
    async () =>
      (await evaluate('document.querySelector(".cm-activeLine")?.textContent ?? ""')).includes(
        "[!note]+ Source-backed",
      )
        ? true
        : null,
    "Clicking a rendered Live Preview callout did not reveal its exact source line",
  );
  const darkBaseline = await captureScreenshot("live-preview-dark");
  assert(
    (await evaluate("document.documentElement.dataset.theme")) === "dark",
    "The baseline Live Preview screenshot was not captured in the dark scheme.",
  );
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

  phase = "zoom and high DPI";
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height: 760,
    deviceScaleFactor: 2,
    scale: 1,
    mobile: false,
  });
  await waitFor(
    async () => (await evaluate("window.devicePixelRatio >= 2")) === true,
    "The isolated renderer did not apply the 2x device scale factor",
  );
  const hidpiBaseline = await captureScreenshot("live-preview-dark-hidpi");
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1.2 });
  await delay(100);
  let zoomed = await captureScreenshot("live-preview-dark-hidpi-zoom");
  const hidpiSize = pngDimensions(hidpiBaseline);
  let zoomedSize = pngDimensions(zoomed);
  if (hidpiBaseline.equals(zoomed)) {
    // Electron's desktop compositor may keep pageScaleFactor at 1 for a
    // non-mobile target. A narrower 2x viewport is the deterministic fallback
    // for exercising the same responsive/zoomed rendering path.
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1000,
      height: 760,
      deviceScaleFactor: 2,
      scale: 1,
      mobile: false,
    });
    await delay(100);
    zoomed = await captureScreenshot("live-preview-dark-hidpi-zoom-fallback");
    zoomedSize = pngDimensions(zoomed);
  }
  assert(
    hidpiSize.width !== zoomedSize.width ||
      hidpiSize.height !== zoomedSize.height ||
      !hidpiBaseline.equals(zoomed),
    `The isolated renderer zoom positive control changed no pixels: ${JSON.stringify({ hidpiSize, zoomedSize })}`,
  );
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height: 760,
    deviceScaleFactor: 2,
    scale: 1,
    mobile: false,
  });
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
  await cdp.send("Emulation.clearDeviceMetricsOverride");
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
  const sourcePositiveControl = await captureScreenshot("live-preview-dark-source-positive");
  assert(
    darkBaseline && !darkBaseline.equals(sourcePositiveControl),
    "The Live Preview screenshot positive control changed no pixels.",
  );
  phase = "IME composition on a mapped line";
  const compositionBefore = await evaluate(
    'document.querySelector(".cm-activeLine")?.textContent ?? ""',
  );
  await composeText("日本語");
  await waitFor(
    async () =>
      (await evaluate('document.querySelector(".cm-activeLine")?.textContent ?? ""')).includes(
        "日本語",
      ),
    "IME composition did not enter the active source line",
  );
  await pressKey("z", "KeyZ", 2);
  await waitFor(
    async () =>
      (await evaluate('document.querySelector(".cm-activeLine")?.textContent ?? ""')) ===
      compositionBefore,
    "Undo did not restore the exact pre-composition source bytes",
  );
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
    return candidate.checkedTasks === 2 && ["Saving soon", "Saving", "Saved"].includes(state)
      ? candidate
      : null;
  }, "The task widget did not enter the autosave path");
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

  phase = "exact autosave bytes";
  await waitFor(
    async () =>
      (await evaluate('document.querySelector("#edit-state")?.textContent ?? ""')) === "Saved",
    "The Live Preview task edit did not autosave",
  );
  const savedSource = await fs.readFile(path.join(vaultAPath, "Showcase.md"), "utf8");
  assert(
    savedSource === showcaseSource.replace("- [ ] open task", "- [x] open task"),
    "Live Preview autosave changed bytes beyond the exact task marker.",
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
  await clickSelector("#source-view-secondary", 0, '[data-pane-id="secondary"]');
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
  await evaluate(`(() => {
    const scroller = document.querySelector('[data-pane-id="primary"] .cm-scroller');
    if (scroller instanceof HTMLElement) scroller.scrollTop = scroller.scrollHeight;
    return true;
  })()`);
  await delay(100);
  await captureScreenshot("live-preview-light-lower");

  phase = "explicit persisted Source preference";
  // At the intentionally narrow split width the primary toolbar can be
  // covered by its neighboring action. The control was already exercised by
  // a real pointer click before splitting; here use its semantic click path
  // after asserting it remains visible and enabled.
  const editControl = await evaluate(`(() => {
    const element = document.querySelector("#edit-view");
    if (!(element instanceof HTMLButtonElement)) return { available: false };
    const rect = element.getBoundingClientRect();
    return { available: true, hidden: element.hidden, disabled: element.disabled, width: rect.width, height: rect.height };
  })()`);
  assert(
    editControl.available &&
      !editControl.hidden &&
      !editControl.disabled &&
      editControl.width > 0 &&
      editControl.height > 0,
    `The primary Live control was not semantically available at split width: ${JSON.stringify(editControl)}`,
  );
  await evaluate('document.querySelector("#source-view")?.click(); true');
  const sourcePreference = await waitFor(async () => {
    const candidate = await waitForShowcase();
    return candidate.mode === "source" ? candidate : null;
  }, "The explicit Source mode change did not reach the primary pane");
  assert(
    sourcePreference.sourcePressed === "true",
    "The Source control did not expose pressed state.",
  );
  await waitForPersistedMode(vaultAId, { editorMode: "source", documentView: "source" });
  const seededStaleMode = await evaluate(`(() => {
    localStorage.setItem("threadleaf-document-view", "reading");
    localStorage.setItem("threadleaf-editing-view", "reading");
    return {
      documentView: localStorage.getItem("threadleaf-document-view"),
      editingView: localStorage.getItem("threadleaf-editing-view"),
    };
  })()`);
  assert(
    seededStaleMode.documentView === "reading" && seededStaleMode.editingView === "reading",
    `Could not seed stale localStorage mode: ${JSON.stringify(seededStaleMode)}`,
  );
  await captureScreenshot("live-preview-light-vault-a-source");
  await closeApplication();

  phase = "vault A delayed settings restart";
  await launchApplication({
    vaultPath: vaultAPath,
    env: {
      THREADLEAF_SETTINGS_DELAY_MS: "750",
      THREADLEAF_WORKSPACE_SETTINGS_DELAY_MS: "750",
    },
  });
  await waitFor(async () => {
    const snapshot = await evaluate("window.threadleaf.getSnapshot()");
    return snapshot?.workspace?.state === "ready" && snapshot?.vault?.path === vaultAPath
      ? snapshot
      : null;
  }, "Vault A did not become ready after the delayed restart");
  const delayedA = await waitForShowcase();
  assert(
    delayedA.mode !== "live",
    `Vault A flashed the transient Live mode before settings arrived: ${JSON.stringify(delayedA)}`,
  );
  opened = await waitFor(async () => {
    const candidate = await waitForShowcase();
    return candidate.mode === "source" ? candidate : null;
  }, "Vault A did not restore its persisted Source mode after delayed settings refresh");
  assert(!opened.noteHidden, "Vault A remained hidden after its persisted mode loaded.");
  assert(
    opened.livePressed === "false" && opened.sourcePressed === "true",
    "Vault A mode controls disagreed after restart.",
  );
  const restartStaleStorage = await evaluate(`({
    documentView: localStorage.getItem("threadleaf-document-view"),
    editingView: localStorage.getItem("threadleaf-editing-view"),
  })`);
  assert(
    restartStaleStorage.documentView === "reading" && restartStaleStorage.editingView === "reading",
    "The seeded stale localStorage values were not present during the restart check.",
  );
  await captureScreenshot("live-preview-light-vault-a-source-restart");
  await closeApplication();

  phase = "vault B delayed refresh isolation";
  await launchApplication({
    vaultPath: vaultBPath,
    env: { THREADLEAF_WORKSPACE_SETTINGS_DELAY_MS: "750" },
  });
  const secondReadySnapshot = await waitFor(async () => {
    const snapshot = await evaluate("window.threadleaf.getSnapshot()");
    return snapshot?.workspace?.state === "ready" && snapshot?.vault?.path === vaultBPath
      ? snapshot
      : null;
  }, "Vault B did not become ready");
  const vaultBId = secondReadySnapshot.vault.id;
  await waitFor(async () => {
    const state = await evaluate(`(() => ({
        target: Boolean(document.querySelector('[data-note-path="Showcase.md"]')),
        runtime: document.querySelector("#runtime-state")?.textContent ?? "",
      }))()`);
    return state.target && state.runtime === "Ready" ? state : null;
  }, "Vault B Showcase did not appear in the virtual file list");
  await clickSelector('[data-note-path="Showcase.md"]');
  opened = await waitForShowcase();
  assert(opened.mode === "live", `Vault B inherited Vault A's mode: ${JSON.stringify(opened)}`);
  assert(
    opened.livePressed === "true" && opened.sourcePressed === "false",
    "Vault B Live controls were not reachable.",
  );
  await delay(900);
  opened = await waitForShowcase();
  assert(opened.mode === "live", "Vault B changed mode when delayed workspace settings arrived.");
  const vaultBSettings = await evaluate("window.threadleaf.getSettings()");
  assert(
    vaultBSettings?.settings?.workspaceByVault?.[vaultBId] === undefined,
    "Opening Vault B unexpectedly created a persisted mode entry.",
  );
  await closeApplication();

  phase = "vault B settings refresh error isolation";
  await launchApplication({
    vaultPath: vaultBPath,
    env: { THREADLEAF_WORKSPACE_SETTINGS_ERROR: "1" },
  });
  await waitFor(async () => {
    const snapshot = await evaluate("window.threadleaf.getSnapshot()");
    return snapshot?.workspace?.state === "ready" && snapshot?.vault?.path === vaultBPath
      ? snapshot
      : null;
  }, "Vault B did not become ready after the refresh-error restart");
  await clickSelector('[data-note-path="Showcase.md"]');
  opened = await waitForShowcase();
  assert(
    opened.mode === "live",
    `Vault B fell back to an invalid mode after refresh failure: ${JSON.stringify(opened)}`,
  );
  await delay(500);
  opened = await waitForShowcase();
  assert(opened.mode === "live", "Vault B changed mode after a failed workspace settings refresh.");
  await closeApplication();

  phase = "vault A persisted restart and reachable controls";
  await launchApplication({ vaultPath: vaultAPath });
  await waitFor(async () => {
    const snapshot = await evaluate("window.threadleaf.getSnapshot()");
    return snapshot?.workspace?.state === "ready" && snapshot?.vault?.path === vaultAPath
      ? snapshot
      : null;
  }, "Vault A did not become ready after Vault B");
  opened = await waitForShowcase();
  assert(
    opened.mode === "source",
    `Vault A lost its persisted Source mode after Vault B: ${JSON.stringify(opened)}`,
  );
  for (const selector of ["#edit-view", "#source-view", "#read-view"]) {
    const control = await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLButtonElement)) return { available: false };
      const rect = element.getBoundingClientRect();
      return { available: true, hidden: element.hidden, disabled: element.disabled, width: rect.width, height: rect.height };
    })()`);
    assert(
      control.available &&
        !control.hidden &&
        !control.disabled &&
        control.width > 0 &&
        control.height > 0,
      `Mode control was not reachable after vault isolation: ${selector} ${JSON.stringify(control)}`,
    );
  }
  await evaluate('document.querySelector("#read-view")?.click(); true');
  await waitFor(
    async () => (await liveSurfaceState()).mode === "reading",
    "Reading mode control did not respond",
  );
  await evaluate('document.querySelector("#source-view")?.click(); true');
  opened = await waitFor(async () => {
    const candidate = await waitForShowcase();
    return candidate.mode === "source" ? candidate : null;
  }, "Source mode control did not restore the persisted editing surface");
  assert(
    opened.sourcePressed === "true",
    "Source mode was not pressed after the reachable-control check.",
  );

  phase = "keyboard callout source reveal";
  await evaluate('document.querySelector("#edit-view")?.click(); true');
  await waitFor(async () => (await liveSurfaceState()).mode === "live", "Live mode did not return");
  const keyboardCallout = await evaluate(`(() => {
    const frame = [...document.querySelectorAll('.tl-live-callout-block')].find((candidate) =>
      candidate.querySelector('.callout[data-callout="warning"]')
    );
    if (!(frame instanceof HTMLElement)) return null;
    frame.scrollIntoView({ block: "center", inline: "nearest" });
    frame.focus();
    return {
      active: document.activeElement === frame,
      label: frame.getAttribute('aria-label'),
      shortcuts: frame.getAttribute('aria-keyshortcuts'),
    };
  })()`);
  assert(
    keyboardCallout?.active === true &&
      keyboardCallout.label?.startsWith("Warning callout. Press Enter or Space") &&
      keyboardCallout.shortcuts === "Enter Space",
    `The rendered warning callout did not expose its keyboard source action: ${JSON.stringify(keyboardCallout)}`,
  );
  await pressKey("Enter", "Enter");
  await waitFor(
    async () =>
      (await evaluate('document.querySelector(".cm-activeLine")?.textContent ?? ""')).includes(
        "[!warning]- Collapsed",
      )
        ? true
        : null,
    "Enter on a rendered Live Preview callout did not reveal its exact source line",
  );
  await evaluate('document.querySelector("#source-view")?.click(); true');
  await waitFor(
    async () => (await liveSurfaceState()).mode === "source",
    "Source mode did not return after the keyboard callout proof",
  );
  await closeApplication();

  console.log(
    "Verified isolated virtual input and screenshots for default Live Preview, rich Markdown rendering, pointer and keyboard exact-source reveal, task edit/undo/redo/autosave bytes, Source round trip, internal-link activation, pane-local modes, A/B vault mode isolation, seeded stale localStorage, delayed/error refreshes, both themes, restart persistence, and reachable mode controls.",
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
  if (exited) {
    await Promise.race([exited, delay(2_000)]);
  }
  await fs.rm(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
