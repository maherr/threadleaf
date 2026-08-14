import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";

// This check is intentionally run under an explicit X11 Xvfb command from the
// package script.  It owns a temporary profile and fixture vault, and uses CDP
// only against that isolated renderer.
const appRoot = process.cwd();
const executablePath = path.resolve(
  process.env.THREADLEAF_PACKAGED_EXECUTABLE ??
    path.join(appRoot, "release", "linux-unpacked", "threadleaf"),
);
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-packaged-attachments-"));
const screenshotDirectory = path.resolve(
  process.env.THREADLEAF_ATTACHMENT_SCREENSHOT_DIR ?? path.join(testRoot, "screenshots"),
);
const userDataPath = path.join(testRoot, "user-data");
const vaultPath = path.join(testRoot, "attachment-vault");
const notePath = path.join(vaultPath, "Attachment Desk.md");
const originalNote = [
  "# Attachment desk",
  "",
  "![[Assets/report.pdf|Report]]",
  "",
  "![[Assets/audio.mp3|Audio]]",
  "",
  "![[Assets/unknown.bin|Unknown bytes]]",
  "",
  "The body is a fixture and must remain byte-identical.",
].join("\n");
const attachmentPublishUnavailableMessage =
  "Threadleaf could not verify strict no-overwrite publication at that destination. Use an existing contained folder on this vault filesystem that supports attachment publication. Review both attachment paths; Markdown references were not updated.";
let child;
let cdp;
let exited;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function paethPredictor(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  if (aboveDistance <= upperLeftDistance) return above;
  return upperLeft;
}

function decodePng(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert(buffer.subarray(0, signature.length).equals(signature), "Screenshot was not a PNG.");
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const imageData = [];
  let offset = signature.length;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    assert(dataEnd + 4 <= buffer.length, `Truncated PNG ${type} chunk.`);
    const data = buffer.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      assert(
        data[12] === 0,
        "Interlaced PNG screenshots are not supported by the positive control.",
      );
    } else if (type === "IDAT") {
      imageData.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }
  assert(width > 0 && height > 0, "PNG screenshot dimensions were missing.");
  assert(
    bitDepth === 8 && (colorType === 2 || colorType === 6),
    "Unsupported PNG screenshot format.",
  );
  const channels = colorType === 6 ? 4 : 3;
  const rowBytes = width * channels;
  const decoded = inflateSync(Buffer.concat(imageData));
  assert(decoded.length >= height * (rowBytes + 1), "PNG screenshot pixel data was truncated.");
  const rgba = Buffer.alloc(width * height * 4);
  let sourceOffset = 0;
  let previous = Buffer.alloc(rowBytes);
  for (let y = 0; y < height; y += 1) {
    const filter = decoded[sourceOffset++];
    const row = Buffer.from(decoded.subarray(sourceOffset, sourceOffset + rowBytes));
    sourceOffset += rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const left = x >= channels ? row[x - channels] : 0;
      const above = previous[x] ?? 0;
      const upperLeft = x >= channels ? (previous[x - channels] ?? 0) : 0;
      if (filter === 1) row[x] = (row[x] + left) & 0xff;
      else if (filter === 2) row[x] = (row[x] + above) & 0xff;
      else if (filter === 3) row[x] = (row[x] + Math.floor((left + above) / 2)) & 0xff;
      else if (filter === 4) row[x] = (row[x] + paethPredictor(left, above, upperLeft)) & 0xff;
      else assert(filter === 0, `Unsupported PNG row filter ${filter}.`);
    }
    for (let x = 0; x < width; x += 1) {
      const source = x * channels;
      const target = (y * width + x) * 4;
      rgba[target] = row[source];
      rgba[target + 1] = row[source + 1];
      rgba[target + 2] = row[source + 2];
      rgba[target + 3] = channels === 4 ? row[source + 3] : 0xff;
    }
    previous = row;
  }
  return { width, height, rgba };
}

function changedPixelsInRegion(before, after, region) {
  assert(
    before.width === after.width && before.height === after.height,
    "Screenshot dimensions changed.",
  );
  const left = Math.max(0, Math.floor(region.x));
  const top = Math.max(0, Math.floor(region.y));
  const right = Math.min(before.width, Math.ceil(region.x + region.width));
  const bottom = Math.min(before.height, Math.ceil(region.y + region.height));
  let changed = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * before.width + x) * 4;
      if (
        before.rgba[offset] !== after.rgba[offset] ||
        before.rgba[offset + 1] !== after.rgba[offset + 1] ||
        before.rgba[offset + 2] !== after.rgba[offset + 2] ||
        before.rgba[offset + 3] !== after.rgba[offset + 3]
      ) {
        changed += 1;
      }
    }
  }
  return changed;
}

function countPerimeterColorPixels(image, region, color, border = 12) {
  const left = Math.max(0, Math.floor(region.x));
  const top = Math.max(0, Math.floor(region.y));
  const right = Math.min(image.width, Math.ceil(region.x + region.width));
  const bottom = Math.min(image.height, Math.ceil(region.y + region.height));
  const counts = { top: 0, right: 0, bottom: 0, left: 0 };
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * image.width + x) * 4;
      if (
        image.rgba[offset] !== color.r ||
        image.rgba[offset + 1] !== color.g ||
        image.rgba[offset + 2] !== color.b ||
        image.rgba[offset + 3] !== color.a
      ) {
        continue;
      }
      if (y < top + border) counts.top += 1;
      if (x >= right - border) counts.right += 1;
      if (y >= bottom - border) counts.bottom += 1;
      if (x < left + border) counts.left += 1;
    }
  }
  return counts;
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

async function waitForTarget(port, deadline) {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find(
          (candidate) =>
            candidate.type === "page" &&
            typeof candidate.url === "string" &&
            candidate.url.endsWith("/dist/renderer/index.html"),
        );
        if (target?.webSocketDebuggerUrl) return target;
      }
    } catch {
      // The packaged renderer is still starting.
    }
    await delay(50);
  }
  throw new Error("The packaged attachment fixture did not expose its renderer in time.");
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

async function clickPointer(selector) {
  const target = await evaluate(`(() => {
    const selector = ${JSON.stringify(selector)};
    const element = document.querySelector(selector);
    if (!(element instanceof HTMLElement)) return { ok: false, reason: 'missing' };
    const rect = element.getBoundingClientRect();
    const x = Math.floor(rect.left + rect.width / 2);
    const y = Math.floor(rect.top + rect.height / 2);
    const hit = document.elementFromPoint(x, y);
    const style = getComputedStyle(element);
    return {
      ok: rect.width > 0 && rect.height > 0 && style.pointerEvents !== 'none',
      x,
      y,
      hit: hit instanceof Element && (hit === element || hit.closest(selector) === element),
      reason: hit instanceof Element ? hit.tagName : 'empty',
    };
  })()`);
  assert(target?.ok, `Pointer target ${selector} is missing, hidden, or inert.`);
  assert(target.hit, `Pointer hit-target check failed for ${selector}: ${target.reason}.`);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: target.x,
    y: target.y,
    button: "none",
    buttons: 0,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: target.x,
    y: target.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: target.x,
    y: target.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

async function replaceInput(selector, value) {
  await clickPointer(selector);
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "a",
    code: "KeyA",
    modifiers: 2,
    windowsVirtualKeyCode: 65,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    modifiers: 2,
    windowsVirtualKeyCode: 65,
  });
  await cdp.send("Input.insertText", { text: value });
  const actual = await evaluate(`document.querySelector(${JSON.stringify(selector)})?.value ?? ''`);
  assert(actual === value, `CDP input did not commit the expected value for ${selector}.`);
}

async function descendantCommandLines(rootPid) {
  const entries = await fs.readdir("/proc");
  const records = [];
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const status = await fs.readFile(`/proc/${entry}/status`, "utf8");
      const parent = /^PPid:\s+(\d+)/mu.exec(status)?.[1];
      const command = (await fs.readFile(`/proc/${entry}/cmdline`))
        .toString("utf8")
        .replaceAll("\0", " ")
        .trim();
      if (parent && command) records.push({ pid: Number(entry), parent: Number(parent), command });
    } catch {
      // A short-lived Chromium process may disappear during the snapshot.
    }
  }
  const children = new Map();
  for (const record of records) {
    const siblings = children.get(record.parent) ?? [];
    siblings.push(record);
    children.set(record.parent, siblings);
  }
  const result = [];
  const queue = [rootPid];
  const seen = new Set(queue);
  while (queue.length) {
    const parent = queue.shift();
    for (const record of children.get(parent) ?? []) {
      if (seen.has(record.pid)) continue;
      seen.add(record.pid);
      result.push(record.command);
      queue.push(record.pid);
    }
  }
  return result;
}

async function proveRendererX11() {
  const commands = await descendantCommandLines(child.pid);
  const renderers = commands.filter((command) => command.includes("--type=renderer"));
  assert(renderers.length > 0, "No Chromium renderer process was visible for argv verification.");
  assert(
    renderers.some((command) => command.includes("--ozone-platform=x11")),
    `Renderer argv did not prove explicit X11: ${JSON.stringify(renderers)}`,
  );
  assert(
    !renderers.some((command) => command.includes("--ozone-platform=wayland")),
    "A renderer advertised Wayland despite the explicit X11 launch.",
  );
  return renderers;
}

async function waitForFixture(deadline) {
  while (Date.now() < deadline) {
    const state = await evaluate(`(async () => {
      const snapshot = await window.threadleaf.getSnapshot();
      return {
        path: snapshot.workspace?.activeNote?.path ?? '',
        ready: document.querySelectorAll('.preview-attachment-card[data-threadleaf-attachment-status="ready"]').length,
        pending: document.querySelectorAll('.preview-attachment-placeholder').length,
        mode: snapshot.vault?.mode ?? '',
      };
    })()`);
    if (state.path === "Attachment Desk.md" && state.ready === 3 && state.pending === 0)
      return state;
    await delay(50);
  }
  throw new Error("The packaged attachment cards did not hydrate in time.");
}

async function waitForReady(deadline) {
  while (Date.now() < deadline) {
    const state = await evaluate(`(async () => ({
      runtime: document.querySelector('#runtime-state')?.textContent ?? '',
      snapshot: await window.threadleaf.getSnapshot(),
    }))()`);
    if (state.runtime === "Ready" && state.snapshot?.workspace?.state === "ready") return state;
    await delay(50);
  }
  throw new Error("The packaged attachment fixture did not reach Ready.");
}

async function setTheme(theme) {
  const current = await evaluate("document.documentElement.dataset.theme");
  if (current !== theme) {
    const dialogOpen = await evaluate(
      "document.querySelector('#attachment-move-dialog')?.open === true",
    );
    if (dialogOpen) {
      await clickPointer("#attachment-move-cancel");
      const closeDeadline = Date.now() + 5_000;
      while (Date.now() < closeDeadline) {
        if (!(await evaluate("document.querySelector('#attachment-move-dialog')?.open === true")))
          break;
        await delay(30);
      }
      assert(
        !(await evaluate("document.querySelector('#attachment-move-dialog')?.open === true")),
        "The attachment publication workbench could not close before switching theme.",
      );
    }
    await clickPointer("#theme-toggle");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if ((await evaluate("document.documentElement.dataset.theme")) === theme) break;
      await delay(30);
    }
    assert(
      (await evaluate("document.documentElement.dataset.theme")) === theme,
      `The packaged application did not switch to ${theme} mode.`,
    );
    if (dialogOpen) {
      await clickPointer(
        '[data-threadleaf-attachment-path="Assets/report.pdf"] [data-threadleaf-attachment-action="move"]',
      );
      const openDeadline = Date.now() + 5_000;
      while (Date.now() < openDeadline) {
        if (await evaluate("document.querySelector('#attachment-move-dialog')?.open === true"))
          break;
        await delay(40);
      }
      assert(
        await evaluate("document.querySelector('#attachment-move-dialog')?.open === true"),
        "The attachment publication workbench could not reopen after switching theme.",
      );
      await replaceInput("#attachment-move-target", "Archive/report-renamed.pdf");
      await clickPointer("#attachment-move-submit");
      const previewDeadline = Date.now() + 8_000;
      while (Date.now() < previewDeadline) {
        const preview = await evaluate(
          "document.querySelector('#attachment-move-preview-message')?.textContent ?? ''",
        );
        if (preview.length > 0) break;
        await delay(50);
      }
      assert(
        (
          await evaluate(
            "document.querySelector('#attachment-move-preview-message')?.textContent ?? ''",
          )
        ).length > 0,
        "The attachment publication preview could not be restored after switching theme.",
      );
    }
  }
}

async function capture(name) {
  const screenshot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  const destination = path.join(screenshotDirectory, name);
  await fs.writeFile(destination, Buffer.from(screenshot.data, "base64"));
  const stats = await fs.stat(destination);
  assert(stats.size > 1_000, `Captured screenshot ${name} is unexpectedly small.`);
  return destination;
}

async function openAttachmentMoveWorkbench() {
  await clickPointer(
    '[data-threadleaf-attachment-path="Assets/report.pdf"] [data-threadleaf-attachment-action="move"]',
  );
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await evaluate("document.querySelector('#attachment-move-dialog')?.open === true")) break;
    await delay(40);
  }
  assert(
    await evaluate("document.querySelector('#attachment-move-dialog')?.open === true"),
    "The packaged attachment card did not reach the publication workbench.",
  );
}

async function previewAttachmentPublication(targetPath) {
  await replaceInput("#attachment-move-target", targetPath);
  await clickPointer("#attachment-move-submit");
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const state = await evaluate(`(() => ({
      open: document.querySelector('#attachment-move-dialog')?.open === true,
      message: document.querySelector('#attachment-move-preview-message')?.textContent ?? '',
      refs: document.querySelectorAll('#attachment-move-blocker-list li').length,
    }))()`);
    if (state.open && state.message.length > 0 && state.refs > 0) break;
    await delay(50);
  }
  const state = await evaluate(`(() => ({
    open: document.querySelector('#attachment-move-dialog')?.open === true,
    message: document.querySelector('#attachment-move-preview-message')?.textContent ?? '',
    list: document.querySelector('#attachment-move-blocker-list')?.textContent ?? '',
  }))()`);
  assert(
    state.open && state.message.length > 0,
    `The attachment publication preview did not render for ${targetPath}.`,
  );
  assert(
    state.list.includes("Attachment Desk.md") && state.list.includes(targetPath),
    `The attachment publication preview omitted its exact local reference update for ${targetPath}.`,
  );
  return state;
}

async function confirmAttachmentPublishUnavailable() {
  await clickPointer("#attachment-move-submit");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await evaluate(`(() => {
      const error = document.querySelector('#attachment-move-error');
      if (!(error instanceof HTMLElement)) return null;
      const rect = error.getBoundingClientRect();
      const style = getComputedStyle(error);
      return {
        open: document.querySelector('#attachment-move-dialog')?.open === true,
        text: error.textContent ?? '',
        role: error.getAttribute('role') ?? '',
        visible:
          !error.hidden &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect.width > 0 &&
          rect.height > 0,
        region: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      };
    })()`);
    if (
      state?.open &&
      state.text === attachmentPublishUnavailableMessage &&
      state.role === "alert" &&
      state.visible
    ) {
      return state;
    }
    await delay(60);
  }
  const state = await evaluate(`(() => {
    const error = document.querySelector('#attachment-move-error');
    if (!(error instanceof HTMLElement)) return null;
    const rect = error.getBoundingClientRect();
    const style = getComputedStyle(error);
    return {
      open: document.querySelector('#attachment-move-dialog')?.open === true,
      text: error.textContent ?? '',
      role: error.getAttribute('role') ?? '',
      visible:
        !error.hidden &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0,
      region: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    };
  })()`);
  assert(
    state?.open &&
      state.text === attachmentPublishUnavailableMessage &&
      state.role === "alert" &&
      state.visible,
    `The strict attachment publication failure was not visibly rendered: ${JSON.stringify(state)}`,
  );
  return state;
}

async function assertMissingPublicationAttemptDidNotMutateFixture() {
  assert(
    (await fs.readFile(notePath, "utf8")) === originalNote,
    "The missing-parent attachment attempt changed Markdown bytes.",
  );
  assert(
    (await fs.readFile(path.join(vaultPath, "Assets", "report.pdf"))).equals(
      Buffer.from("%PDF-1.7\nfixture\0", "binary"),
    ),
    "The missing-parent attachment attempt changed source bytes.",
  );
  assert(
    !(await fs
      .stat(path.join(vaultPath, "Missing"))
      .then(() => true)
      .catch(() => false)),
    "The missing-parent attachment attempt created Missing/.",
  );
  assert(
    !(await fs
      .stat(path.join(vaultPath, "Missing", "report.pdf"))
      .then(() => true)
      .catch(() => false)),
    "The missing-parent attachment attempt created its destination.",
  );
}

try {
  assert(process.platform === "linux", "The packaged attachment check currently requires Linux.");
  await fs.access(executablePath);
  await fs.mkdir(path.join(vaultPath, ".obsidian"), { recursive: true });
  await fs.mkdir(path.join(vaultPath, "Assets"), { recursive: true });
  await fs.mkdir(path.join(vaultPath, "Archive"), { recursive: true });
  await fs.mkdir(userDataPath, { recursive: true });
  await fs.writeFile(notePath, originalNote, "utf8");
  await fs.writeFile(
    path.join(vaultPath, "Assets", "report.pdf"),
    Buffer.from("%PDF-1.7\nfixture\0", "binary"),
  );
  await fs.writeFile(
    path.join(vaultPath, "Assets", "audio.mp3"),
    Buffer.from("ID3\x04\0\0fixture", "binary"),
  );
  await fs.writeFile(
    path.join(vaultPath, "Assets", "unknown.bin"),
    Buffer.from([0xff, 0x00, 0x91, 0x22, 0x00]),
  );
  await fs.writeFile(
    path.join(userDataPath, "workspace-selection.json"),
    `${JSON.stringify({ version: 1, vaultPath }, null, 2)}\n`,
    "utf8",
  );

  const port = await availablePort();
  child = spawn(
    executablePath,
    [
      "--ozone-platform=x11",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataPath}`,
      "--disable-gpu",
    ],
    {
      cwd: appRoot,
      env: { ...process.env, ELECTRON_OZONE_PLATFORM_HINT: "x11" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  const output = [];
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      output.push(String(chunk));
      if (output.length > 100) output.shift();
    });
  }

  const deadline = Date.now() + 15_000;
  const target = await waitForTarget(port, deadline);
  cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  const renderers = await proveRendererX11();
  const initial = await waitForReady(deadline);
  assert(
    initial.snapshot.vault.path === vaultPath,
    "The packaged attachment fixture opened the wrong vault.",
  );
  assert(
    initial.snapshot.vault.mode === "kernel-backed",
    "The attachment fixture is not writable.",
  );

  await clickPointer("#read-view");
  await waitForFixture(deadline);
  const screenshots = [];
  await fs.mkdir(screenshotDirectory, { recursive: true });
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1180,
    height: 820,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const cardState =
    await evaluate(`(() => [...document.querySelectorAll('.preview-attachment-card')].map((card) => ({
    text: card.textContent ?? '',
    path: card.getAttribute('data-threadleaf-attachment-path') ?? '',
    actionCount: card.querySelectorAll('.preview-attachment-action').length,
  })))()`);
  assert(
    cardState.length === 3 && cardState.every((card) => card.actionCount === 3),
    "Attachment cards lost open/reveal/publication metadata.",
  );
  assert(
    cardState.every((card) => card.text.includes("Publish copy")),
    "Attachment cards did not expose truthful source-retaining publication controls.",
  );
  assert(
    cardState.some((card) => card.text.includes("unsupported")),
    "The unsupported binary did not retain a safe metadata card.",
  );
  assert(
    (await evaluate(
      "document.querySelectorAll('.preview-attachment-card img, .preview-attachment-card iframe, .preview-attachment-card video, .preview-attachment-card audio').length",
    )) === 0,
    "The attachment card exposed an inline executable/media element.",
  );
  await clickPointer(
    '[data-threadleaf-attachment-path="Assets/report.pdf"] [data-threadleaf-attachment-action="open"]',
  );
  assert(
    (await evaluate("document.querySelector('#toast')?.textContent ?? ''")).includes(
      "Opening local attachments is not enabled yet",
    ),
    "The packaged Open attachment affordance was not inert.",
  );
  assert(
    (await fs.readFile(notePath, "utf8")) === originalNote,
    "Reading view changed fixture Markdown bytes.",
  );
  assert(
    (await fs.readFile(path.join(vaultPath, "Assets", "report.pdf"))).equals(
      Buffer.from("%PDF-1.7\nfixture\0", "binary"),
    ),
    "Attachment bytes changed during metadata loading.",
  );
  await evaluate(
    "document.querySelector('.preview-attachment-card')?.scrollIntoView({ block: 'center' }); true",
  );
  await setTheme("dark");
  screenshots.push(await capture("packaged-attachment-cards-dark.png"));
  await setTheme("light");
  screenshots.push(await capture("packaged-attachment-cards-light.png"));
  await setTheme("dark");

  await openAttachmentMoveWorkbench();
  const workbenchDom = await evaluate(`(() => {
    const html = document.querySelector('#attachment-move-dialog')?.outerHTML ?? '';
    const needle = ${JSON.stringify(vaultPath)};
    const index = html.indexOf(needle);
    return { index, context: index < 0 ? '' : html.slice(Math.max(0, index - 160), index + needle.length + 220) };
  })()`);
  assert(
    workbenchDom?.index < 0,
    `The attachment workbench leaked the absolute vault path into the renderer DOM: ${JSON.stringify(workbenchDom)}`,
  );
  await previewAttachmentPublication("Missing/report.pdf");
  await assertMissingPublicationAttemptDidNotMutateFixture();
  const unavailableDarkState = await confirmAttachmentPublishUnavailable();
  await assertMissingPublicationAttemptDidNotMutateFixture();
  const unavailableDarkPath = await capture("packaged-attachment-unavailable-dark.png");
  screenshots.push(unavailableDarkPath);
  const unavailablePositive = await evaluate(`(() => {
    const error = document.querySelector('#attachment-move-error');
    if (!(error instanceof HTMLElement)) return false;
    error.style.outline = '12px solid rgb(255, 0, 255)';
    error.style.outlineOffset = '-12px';
    return getComputedStyle(error).outlineColor === 'rgb(255, 0, 255)';
  })()`);
  assert(
    unavailablePositive,
    "The unavailable-publication visual positive control did not reach the visible error.",
  );
  const unavailablePositivePath = await capture(
    "packaged-attachment-unavailable-positive-control.png",
  );
  screenshots.push(unavailablePositivePath);
  const changedPixels = changedPixelsInRegion(
    decodePng(await fs.readFile(unavailableDarkPath)),
    decodePng(await fs.readFile(unavailablePositivePath)),
    unavailableDarkState.region,
  );
  assert(
    changedPixels > 0,
    "The unavailable-publication visual positive control changed no error pixels.",
  );
  const positiveImage = decodePng(await fs.readFile(unavailablePositivePath));
  const outlinePixels = countPerimeterColorPixels(positiveImage, unavailableDarkState.region, {
    r: 255,
    g: 0,
    b: 255,
    a: 255,
  });
  assert(
    Object.values(outlinePixels).every((count) => count > 0),
    `The decoded PNG did not contain the expected magenta outline on every unavailable-publication error side: ${JSON.stringify(outlinePixels)}`,
  );
  await evaluate(
    "document.querySelector('#attachment-move-error')?.style.removeProperty('outline'); document.querySelector('#attachment-move-error')?.style.removeProperty('outline-offset'); true",
  );
  await clickPointer("#attachment-move-cancel");
  const unavailableCloseDeadline = Date.now() + 5_000;
  while (Date.now() < unavailableCloseDeadline) {
    if (!(await evaluate("document.querySelector('#attachment-move-dialog')?.open === true")))
      break;
    await delay(40);
  }
  assert(
    !(await evaluate("document.querySelector('#attachment-move-dialog')?.open === true")),
    "The unavailable-publication workbench did not close before the light-theme retry.",
  );
  await setTheme("light");
  await openAttachmentMoveWorkbench();
  await previewAttachmentPublication("Missing/report.pdf");
  await assertMissingPublicationAttemptDidNotMutateFixture();
  await confirmAttachmentPublishUnavailable();
  await assertMissingPublicationAttemptDidNotMutateFixture();
  screenshots.push(await capture("packaged-attachment-unavailable-light.png"));

  await previewAttachmentPublication("Archive/report-renamed.pdf");
  assert(
    !(await evaluate(
      `(document.querySelector('#attachment-move-dialog')?.outerHTML ?? '').includes(${JSON.stringify(vaultPath)})`,
    )),
    "The attachment publication preview leaked the absolute vault path into its workbench DOM.",
  );
  assert(
    (await fs.readFile(notePath, "utf8")) === originalNote,
    "The attachment preview changed Markdown before confirmation.",
  );
  assert(
    (await fs.readFile(path.join(vaultPath, "Assets", "report.pdf"))).equals(
      Buffer.from("%PDF-1.7\nfixture\0", "binary"),
    ),
    "The attachment preview changed bytes before confirmation.",
  );
  assert(
    !(await fs
      .stat(path.join(vaultPath, "Archive", "report-renamed.pdf"))
      .then(() => true)
      .catch(() => false)),
    "The attachment preview created its destination before confirmation.",
  );

  await setTheme("dark");
  screenshots.push(await capture("packaged-attachments-dark.png"));
  await setTheme("light");
  screenshots.push(await capture("packaged-attachments-light.png"));

  await clickPointer("#attachment-move-submit");
  const commitDeadline = Date.now() + 10_000;
  while (Date.now() < commitDeadline) {
    const targetExists = await fs
      .stat(path.join(vaultPath, "Archive", "report-renamed.pdf"))
      .then(() => true)
      .catch(() => false);
    const terminalUi = await evaluate(`(() => ({
      dialogOpen: document.querySelector('#attachment-move-dialog')?.open === true,
      toast: document.querySelector('#toast')?.textContent?.trim() ?? '',
    }))()`);
    if (
      targetExists &&
      !terminalUi.dialogOpen &&
      terminalUi.toast.includes("Published a copy at")
    ) {
      break;
    }
    await delay(60);
  }
  assert(
    await fs
      .stat(path.join(vaultPath, "Archive", "report-renamed.pdf"))
      .then(() => true)
      .catch(() => false),
    "The confirmed attachment publication did not create its destination.",
  );
  assert(
    await fs
      .stat(path.join(vaultPath, "Assets", "report.pdf"))
      .then(() => true)
      .catch(() => false),
    "The confirmed attachment publication did not retain its source file.",
  );
  assert(
    (await fs.readFile(path.join(vaultPath, "Assets", "report.pdf"))).equals(
      Buffer.from("%PDF-1.7\nfixture\0", "binary"),
    ),
    "The confirmed attachment publication changed the retained source bytes.",
  );
  assert(
    (await fs.readFile(path.join(vaultPath, "Archive", "report-renamed.pdf"))).equals(
      Buffer.from("%PDF-1.7\nfixture\0", "binary"),
    ),
    "The confirmed attachment publication changed the copied bytes.",
  );
  assert(
    (await fs.readFile(notePath, "utf8")) ===
      originalNote.replaceAll("Assets/report.pdf", "Archive/report-renamed.pdf"),
    "The confirmed attachment publication did not rewrite the expected local references.",
  );
  const toastText = await evaluate("document.querySelector('#toast')?.textContent?.trim() ?? ''");
  assert(
    toastText.includes("Published a copy at Archive/report-renamed.pdf") &&
      toastText.includes("the original remains at Assets/report.pdf") &&
      !toastText.includes("Moved attachment"),
    `The attachment publication toast was not source-retention truthful: ${toastText}`,
  );
  const closedDeadline = Date.now() + 5_000;
  while (Date.now() < closedDeadline) {
    if (!(await evaluate("document.querySelector('#attachment-move-dialog')?.open === true")))
      break;
    await delay(40);
  }
  assert(
    !(await evaluate("document.querySelector('#attachment-move-dialog')?.open === true")),
    "The attachment publication workbench remained open after commit.",
  );
  await setTheme("dark");
  screenshots.push(await capture("packaged-attachment-move-dark.png"));
  await setTheme("light");
  screenshots.push(await capture("packaged-attachment-move-light.png"));

  await evaluate("setTimeout(() => window.close(), 0); true");
  const exit = await Promise.race([
    exited,
    delay(10_000).then(() => ({ code: null, signal: "timeout" })),
  ]);
  assert(
    exit.code === 0,
    `Packaged attachment application did not exit cleanly: ${JSON.stringify(exit)}`,
  );
  console.log(
    JSON.stringify({
      executablePath,
      vaultPath,
      renderers,
      exactBytes: true,
      attachmentMove: true,
      changedPixels,
      outlinePixels,
      screenshots,
    }),
  );
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  throw new Error(detail, { cause: error });
} finally {
  cdp?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    if (exited) await Promise.race([exited, delay(2_000)]);
  }
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    if (exited) await Promise.race([exited, delay(2_000)]);
  }
  await fs.rm(testRoot, { recursive: true, force: true });
}
