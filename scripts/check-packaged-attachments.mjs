import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
  "![[Restored/exact.bin|Restore target]]",
  "",
  "![[Restored/drop.bin|Drop target]]",
  "",
  "![[Restored/paste.bin|Paste target]]",
  "",
  "![[Missing/lost-report.pdf?download=1#page=2|Missing report]]",
  "",
  "The body is a fixture and must remain byte-identical.",
].join("\n");
const missingAttachmentPath = "Missing/lost-report.pdf";
const restoreAttachmentPath = "Restored/exact.bin";
const externalRestorePath = path.join(testRoot, "external-recovery.bin");
const externalRestoreBytes = Buffer.from([0x00, 0xff, 0x80, 0x42, 0xef, 0xbb, 0xbf, 0x0a]);
const dropAttachmentPath = "Restored/drop.bin";
const externalDropPath = path.join(testRoot, "external-drop.bin");
const externalDropBytes = Buffer.from([0x44, 0x00, 0xfe, 0x52, 0xef, 0xbb, 0xbf, 0x0a]);
const pasteAttachmentPath = "Restored/paste.bin";
const externalPasteName = "clipboard-recovery.bin";
const externalPasteBytes = Buffer.from([0x50, 0x00, 0xfd, 0x53, 0xef, 0xbb, 0xbf, 0x0a]);
const recoveredAttachmentPath = "Assets/recovered report.pdf";
const recoveredAttachmentBytes = Buffer.from("%PDF-1.7\nrecovered fixture\0", "binary");
const insertionPasteNotePath = "Notes/Paste Desk.md";
const insertionPasteNote = "Replace this entire note.";
const insertionPasteFileName = "pasted diagram.png";
const insertionPasteTargetPath = `Notes/${insertionPasteFileName}`;
const insertionPasteBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xfe,
]);
const insertionPasteReference = `![[${insertionPasteFileName}]]`;
const insertionDropNotePath = "Notes/Drop Desk.md";
const insertionDropNote = "before\nafter\n";
const externalInsertionDropPath = path.join(testRoot, "dropped-plan.pdf");
const insertionDropFileName = path.basename(externalInsertionDropPath);
const insertionDropTargetPath = `Notes/${insertionDropFileName}`;
const insertionDropBytes = Buffer.from("%PDF-1.7\neditor-drop-fixture\0", "binary");
const insertionDropReference = `![[${insertionDropFileName}]]`;
const originalAudioCanvas = `\uFEFF${[
  "{",
  '  "nodes": [',
  '    {"id": "audio-file", "type": "file", "file": "Assets/audio.mp3", "x": 0, "y": 0, "width": 320, "height": 180, "unknown": "Assets/audio.mp3"},',
  '    {"id": "audio-group", "type": "group", "background": "./Assets/audio.mp3", "backgroundStyle": "cover", "x": 360, "y": 0, "width": 320, "height": 180}',
  "  ],",
  '  "edges": [],',
  '  "threadleafFixture": {"numberSpelling": 1.00e+2, "pathLikeText": "Assets/audio.mp3"}',
  "}",
].join("\r\n")}\r\n`;
const renamedAudioCanvas = originalAudioCanvas
  .replace('"file": "Assets/audio.mp3"', '"file": "Archive/audio-renamed.mp3"')
  .replace('"background": "./Assets/audio.mp3"', '"background": "./Archive/audio-renamed.mp3"');
const unsafeAudioCanvas = '{"nodes":[{"id":"unsafe","type":"file","file":"Assets/audio.mp3"';
const attachmentPublishUnavailableMessage =
  "Threadleaf could not verify strict no-overwrite publication at that destination. Use an existing contained folder on this vault filesystem that supports attachment publication. Review both attachment paths; Markdown references were not updated.";
let child;
let cdp;
let exited;
let nativeReceiverOutput = "";
let restoreChangedPixels = 0;

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
  const listeners = new Map();
  let sequence = 0;
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP WebSocket failed to open.")), {
      once: true,
    });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (typeof message.method === "string") {
      for (const listener of listeners.get(message.method) ?? []) listener(message.params ?? {});
    }
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
    on(method, listener) {
      const methodListeners = listeners.get(method) ?? [];
      methodListeners.push(listener);
      listeners.set(method, methodListeners);
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
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
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

async function attachmentDropTarget(selector) {
  const target = await evaluate(`(() => {
    const selector = ${JSON.stringify(selector)};
    const element = document.querySelector(selector);
    if (!(element instanceof HTMLElement)) return { ok: false, reason: 'missing' };
    element.scrollIntoView({ block: 'center' });
    const rect = element.getBoundingClientRect();
    const x = Math.floor(rect.left + rect.width / 2);
    const y = Math.floor(rect.top + rect.height / 2);
    const hit = document.elementFromPoint(x, y);
    const style = getComputedStyle(element);
    return {
      ok: rect.width > 0 && rect.height > 0 && style.pointerEvents !== 'none',
      x,
      y,
      hit: hit instanceof Element && (hit === element || element.contains(hit)),
      reason: hit instanceof Element ? hit.tagName : 'empty',
    };
  })()`);
  assert(target?.ok, `Attachment drop target ${selector} is missing, hidden, or inert.`);
  assert(target.hit, `Attachment drop hit-target check failed for ${selector}: ${target.reason}.`);
  return target;
}

async function beginFileDrag(selector, sourcePath) {
  const target = await attachmentDropTarget(selector);
  const data = fileDragData([sourcePath]);
  await cdp.send("Input.dispatchDragEvent", {
    type: "dragEnter",
    x: target.x,
    y: target.y,
    data,
  });
  await cdp.send("Input.dispatchDragEvent", {
    type: "dragOver",
    x: target.x,
    y: target.y,
    data,
  });
  const state = await evaluate(`(() => {
    const card = document.querySelector(${JSON.stringify(selector)});
    return {
      active: card?.classList.contains('preview-attachment-drop-active') === true,
      hint: card?.querySelector('.preview-attachment-input-hint')?.textContent ?? '',
    };
  })()`);
  assert(
    state.active && state.hint.includes("Release to review this file"),
    `The card-scoped drop state was not visibly armed: ${JSON.stringify(state)}`,
  );
  return { target, data };
}

function fileDragData(sourcePaths) {
  const data = {
    items: sourcePaths.map((sourcePath) => ({
      mimeType: "application/octet-stream",
      data: "",
      title: path.basename(sourcePath),
      baseURL: "",
    })),
    files: sourcePaths,
    dragOperationsMask: 1,
  };
  return data;
}

async function cancelFileDrag(drag) {
  await cdp.send("Input.dispatchDragEvent", {
    type: "dragCancel",
    x: drag.target.x,
    y: drag.target.y,
    data: drag.data,
  });
}

async function finishFileDrop(drag) {
  await cdp.send("Input.dispatchDragEvent", {
    type: "drop",
    x: drag.target.x,
    y: drag.target.y,
    data: drag.data,
  });
}

async function dispatchRejectedCardDrop(selector, data) {
  const target = await attachmentDropTarget(selector);
  const beforeHref = await evaluate("location.href");
  for (const type of ["dragEnter", "dragOver"]) {
    await cdp.send("Input.dispatchDragEvent", {
      type,
      x: target.x,
      y: target.y,
      data,
    });
  }
  assert(
    !(await evaluate(
      `document.querySelector(${JSON.stringify(selector)})?.classList.contains('preview-attachment-drop-active') === true`,
    )),
    "A multi-file drag incorrectly armed the one-file drop state.",
  );
  await cdp.send("Input.dispatchDragEvent", {
    type: "drop",
    x: target.x,
    y: target.y,
    data,
  });
  await delay(150);
  return evaluate(`(() => ({
    sameDocument: location.href === ${JSON.stringify(beforeHref)},
    cardPresent: document.querySelector(${JSON.stringify(selector)}) !== null,
    dialogOpen: document.querySelector('#attachment-move-dialog')?.open === true,
  }))()`);
}

function textAndUrlDragData() {
  return {
    items: [
      {
        mimeType: "text/uri-list",
        data: "https://example.invalid/not-a-file",
        title: "",
        baseURL: "",
      },
      {
        mimeType: "text/plain",
        data: "not a file",
        title: "",
        baseURL: "",
      },
    ],
    files: [],
    dragOperationsMask: 1,
  };
}

async function waitForAttachmentRestoreDialog(message) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await evaluate("document.querySelector('#attachment-move-dialog')?.open === true")) return;
    await delay(40);
  }
  throw new Error(message);
}

async function dispatchFilePaste(selector, sourceFileName, bytes) {
  await clickPointer(selector);
  const result = await evaluate(`(() => {
    const control = document.querySelector(${JSON.stringify(selector)});
    if (!(control instanceof HTMLButtonElement)) return { dispatched: false, reason: 'missing' };
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(${JSON.stringify([...bytes])})], ${JSON.stringify(sourceFileName)}, {
      type: 'application/octet-stream',
    }));
    const event = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    });
    const dispatchResult = control.dispatchEvent(event);
    return {
      dispatched: true,
      focused: document.activeElement === control,
      defaultPrevented: event.defaultPrevented,
      dispatchResult,
    };
  })()`);
  assert(
    result?.dispatched &&
      result.focused &&
      result.defaultPrevented &&
      result.dispatchResult === false,
    `The file-backed clipboard event did not enter the focused Paste file control: ${JSON.stringify(result)}`,
  );
  await waitForAttachmentRestoreDialog(
    "The file-backed clipboard event did not reach the attachment restore workbench.",
  );
}

async function dispatchTextOnlyPaste(selector) {
  await clickPointer(selector);
  return evaluate(`(() => {
    const control = document.querySelector(${JSON.stringify(selector)});
    if (!(control instanceof HTMLButtonElement)) return { dispatched: false, reason: 'missing' };
    const transfer = new DataTransfer();
    transfer.setData('text/plain', 'https://example.invalid/not-a-file');
    transfer.setData('text/html', '<strong>not a file</strong>');
    const event = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    });
    const dispatchResult = control.dispatchEvent(event);
    return {
      dispatched: true,
      focused: document.activeElement === control,
      defaultPrevented: event.defaultPrevented,
      dispatchResult,
      dialogOpen: document.querySelector('#attachment-move-dialog')?.open === true,
    };
  })()`);
}

async function waitForAttachmentInsertDialog(message) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await evaluate("document.querySelector('#attachment-insert-dialog')?.open === true"))
      return;
    await delay(40);
  }
  throw new Error(message);
}

async function openEditorNote(notePath) {
  await evaluate(`(async () => {
    await window.threadleaf.openNote(${JSON.stringify(notePath)}, 'primary', true);
    return true;
  })()`);
  const openDeadline = Date.now() + 8_000;
  while (Date.now() < openDeadline) {
    const state = await evaluate(`(async () => {
      const snapshot = await window.threadleaf.getSnapshot();
      return {
        path: snapshot.workspace?.activeNote?.path ?? '',
        renderedPath: document.querySelector('[data-pane-id="primary"] [id^="note-path"]')?.textContent ?? '',
      };
    })()`);
    if (state.path === notePath && state.renderedPath === notePath) break;
    await delay(40);
  }
  const opened = await evaluate(`(async () => {
    const snapshot = await window.threadleaf.getSnapshot();
    return snapshot.workspace?.activeNote?.path === ${JSON.stringify(notePath)} &&
      document.querySelector('[data-pane-id="primary"] [id^="note-path"]')?.textContent === ${JSON.stringify(notePath)};
  })()`);
  assert(opened, `The packaged application did not open ${notePath}.`);
  if (
    (await evaluate("document.querySelector('#note-view')?.getAttribute('data-view')")) !== "live"
  ) {
    await clickPointer("#edit-view");
  }
  const editorDeadline = Date.now() + 8_000;
  while (Date.now() < editorDeadline) {
    const state = await evaluate(`(() => ({
      view: document.querySelector('#note-view')?.getAttribute('data-view') ?? '',
      mounted: document.querySelector('[data-pane-id="primary"] .cm-content[contenteditable="true"]') !== null,
    }))()`);
    if (state.view === "live" && state.mounted) return;
    await delay(40);
  }
  throw new Error(`The packaged application did not mount the live editor for ${notePath}.`);
}

async function focusAndSelectAllEditor() {
  await clickPointer('[data-pane-id="primary"] .cm-content');
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
}

async function dispatchEditorFilePaste(sourceFileName, bytes) {
  await focusAndSelectAllEditor();
  const result = await evaluate(`(() => {
    const editor = document.querySelector('[data-pane-id="primary"] .cm-content');
    if (!(editor instanceof HTMLElement)) return { dispatched: false, reason: 'missing' };
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(${JSON.stringify([...bytes])})], ${JSON.stringify(sourceFileName)}, {
      type: 'application/octet-stream',
    }));
    const event = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    });
    const dispatchResult = editor.dispatchEvent(event);
    return {
      dispatched: true,
      focused: document.activeElement === editor,
      defaultPrevented: event.defaultPrevented,
      dispatchResult,
    };
  })()`);
  assert(
    result?.dispatched &&
      result.focused &&
      result.defaultPrevented &&
      result.dispatchResult === false,
    `The file-backed clipboard event did not enter the focused editor: ${JSON.stringify(result)}`,
  );
  await waitForAttachmentInsertDialog(
    "The file-backed clipboard event did not reach the editor attachment workbench.",
  );
}

async function editorDropTarget(lineIndex = 0) {
  const target = await evaluate(`(() => {
    const editor = document.querySelector('[data-pane-id="primary"] .cm-content');
    const lines = editor ? [...editor.querySelectorAll('.cm-line')] : [];
    const line = lines[${lineIndex}];
    if (!(editor instanceof HTMLElement) || !(line instanceof HTMLElement)) {
      return { ok: false, reason: 'missing' };
    }
    line.scrollIntoView({ block: 'center' });
    const rect = line.getBoundingClientRect();
    const x = Math.floor(rect.left + 2);
    const y = Math.floor(rect.top + rect.height / 2);
    const hit = document.elementFromPoint(x, y);
    return {
      ok: rect.width > 0 && rect.height > 0,
      x,
      y,
      hit: hit instanceof Element && (hit === editor || editor.contains(hit)),
      reason: hit instanceof Element ? hit.tagName : 'empty',
    };
  })()`);
  assert(target?.ok, "The editor drop line is missing or hidden.");
  assert(target.hit, `The editor drop hit-target check failed: ${target.reason}.`);
  return target;
}

async function beginEditorFileDrag(sourcePaths, lineIndex = 0) {
  const target = await editorDropTarget(lineIndex);
  const data = fileDragData(sourcePaths);
  for (const type of ["dragEnter", "dragOver"]) {
    await cdp.send("Input.dispatchDragEvent", {
      type,
      x: target.x,
      y: target.y,
      data,
    });
  }
  const state = await evaluate(`(() => ({
    active: document.querySelector('[data-pane-id="primary"] .cm-editor')?.getAttribute('data-attachment-drop-active') ?? '',
    dialogOpen: document.querySelector('#attachment-insert-dialog')?.open === true,
  }))()`);
  assert(
    sourcePaths.length === 1
      ? state.active === "true" && !state.dialogOpen
      : state.active !== "true" && !state.dialogOpen,
    `The editor drag state did not match the transfer cardinality: ${JSON.stringify(state)}`,
  );
  return { target, data };
}

async function dispatchRejectedEditorDrop(sourcePaths, lineIndex = 0) {
  const target = await editorDropTarget(lineIndex);
  const beforeHref = await evaluate("location.href");
  const sourceFileNames = sourcePaths.map((sourcePath) => path.basename(sourcePath));
  return evaluate(`(() => {
    const editor = document.querySelector('[data-pane-id="primary"] .cm-content');
    if (!(editor instanceof HTMLElement)) return { dispatched: false, reason: 'missing' };
    const transfer = new DataTransfer();
    for (const [index, fileName] of ${JSON.stringify(sourceFileNames)}.entries()) {
      transfer.items.add(new File([Uint8Array.from([index + 1])], fileName, {
        type: 'application/octet-stream',
      }));
    }
    const events = ['dragenter', 'dragover', 'drop'].map((type) => {
      const event = new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
        clientX: ${target.x},
        clientY: ${target.y},
      });
      const dispatchResult = editor.dispatchEvent(event);
      return { type, defaultPrevented: event.defaultPrevented, dispatchResult };
    });
    return {
      dispatched: true,
      owned: events.every((event) => event.defaultPrevented && event.dispatchResult === false),
      events,
      sameDocument: location.href === ${JSON.stringify(beforeHref)},
      dialogOpen: document.querySelector('#attachment-insert-dialog')?.open === true,
      editorPresent: document.querySelector('[data-pane-id="primary"] .cm-content') !== null,
      active: document.querySelector('[data-pane-id="primary"] .cm-editor')?.getAttribute('data-attachment-drop-active') ?? '',
      toast: document.querySelector('#toast')?.textContent?.trim() ?? '',
    };
  })()`);
}

async function assertAttachmentInsertWorkbench({
  sourceNotePath,
  sourceFileName,
  targetPath,
  bytes,
  reference,
}) {
  const initial = await evaluate(`(() => {
    const dialog = document.querySelector('#attachment-insert-dialog');
    return {
      open: dialog?.open === true,
      title: document.querySelector('#attachment-insert-title')?.textContent ?? '',
      description: document.querySelector('#attachment-insert-description')?.textContent ?? '',
      source: document.querySelector('#attachment-insert-source')?.textContent ?? '',
      file: document.querySelector('#attachment-insert-file')?.textContent ?? '',
      target: document.querySelector('#attachment-insert-target')?.value ?? '',
      submit: document.querySelector('#attachment-insert-submit')?.textContent?.trim() ?? '',
      body: dialog?.textContent ?? '',
      html: dialog?.outerHTML ?? '',
    };
  })()`);
  assert(
    initial.open &&
      initial.title === "Insert external attachment" &&
      initial.description.includes("publish the selected file's exact bytes first") &&
      initial.description.includes("Nothing is written until") &&
      initial.source === sourceNotePath &&
      initial.file === `${sourceFileName} · ${bytes.byteLength} B` &&
      initial.target === targetPath &&
      initial.submit === "Review insertion" &&
      !initial.html.includes(testRoot) &&
      !initial.html.includes(vaultPath),
    `The editor attachment workbench was not truthful or path-private: ${JSON.stringify(initial)}`,
  );
  await clickPointer("#attachment-insert-submit");
  const previewDeadline = Date.now() + 8_000;
  let preview = null;
  while (Date.now() < previewDeadline) {
    preview = await evaluate(`(() => ({
      open: document.querySelector('#attachment-insert-dialog')?.open === true,
      message: document.querySelector('#attachment-insert-preview-message')?.textContent ?? '',
      proof: document.querySelector('#attachment-insert-proof')?.textContent ?? '',
      hashTitle: document.querySelector('#attachment-insert-proof .move-note-blocker-origin')?.getAttribute('title') ?? '',
      submit: document.querySelector('#attachment-insert-submit')?.textContent?.trim() ?? '',
    }))()`);
    if (
      preview.open &&
      preview.message.includes("Review the exact byte identity") &&
      preview.submit === "Insert file and reference"
    ) {
      break;
    }
    await delay(50);
  }
  assert(
    preview?.open &&
      preview.message.includes("Submit again to commit both parts") &&
      preview.proof.includes(sourceFileName) &&
      preview.proof.includes(targetPath) &&
      preview.proof.includes(reference) &&
      /^SHA-256 [a-f0-9]{64}$/u.test(preview.hashTitle) &&
      preview.submit === "Insert file and reference",
    `The editor attachment preview omitted its compound proof: ${JSON.stringify(preview)}`,
  );
  return preview;
}

async function confirmAttachmentInsert({ sourceNotePath, expectedNote, targetPath, bytes }) {
  await clickPointer("#attachment-insert-submit");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const targetExists = await fs
      .stat(path.join(vaultPath, targetPath))
      .then(() => true)
      .catch(() => false);
    const state = await evaluate(`(async () => {
      const snapshot = await window.threadleaf.getSnapshot();
      return {
        dialogOpen: document.querySelector('#attachment-insert-dialog')?.open === true,
        toast: document.querySelector('#toast')?.textContent?.trim() ?? '',
        path: snapshot.workspace?.activeNote?.path ?? '',
        outgoingCount: snapshot.workspace?.activeNote?.outgoing.length ?? -1,
        editorText: [...document.querySelectorAll('[data-pane-id="primary"] .cm-content .cm-line')]
          .map((line) => line.textContent ?? '')
          .join('\\n'),
        editorFocused: document.activeElement?.classList.contains('cm-content') === true,
      };
    })()`);
    if (
      targetExists &&
      !state.dialogOpen &&
      state.toast.includes(`Inserted ${targetPath} and added one reference.`) &&
      state.path === sourceNotePath &&
      state.outgoingCount === 0 &&
      state.editorText === expectedNote &&
      state.editorFocused
    ) {
      break;
    }
    await delay(60);
  }
  assert(
    (await fs.readFile(path.join(vaultPath, targetPath))).equals(bytes),
    `The confirmed editor insertion changed the exact bytes for ${targetPath}.`,
  );
  assert(
    (await fs.readFile(path.join(vaultPath, sourceNotePath), "utf8")) === expectedNote,
    `The confirmed editor insertion did not write the expected reference in ${sourceNotePath}.`,
  );
  const terminal = await evaluate(`(async () => {
    const snapshot = await window.threadleaf.getSnapshot();
    return {
      dialogOpen: document.querySelector('#attachment-insert-dialog')?.open === true,
      toast: document.querySelector('#toast')?.textContent?.trim() ?? '',
      path: snapshot.workspace?.activeNote?.path ?? '',
      outgoingCount: snapshot.workspace?.activeNote?.outgoing.length ?? -1,
      editorText: [...document.querySelectorAll('[data-pane-id="primary"] .cm-content .cm-line')]
        .map((line) => line.textContent ?? '')
        .join('\\n'),
      editorFocused: document.activeElement?.classList.contains('cm-content') === true,
    };
  })()`);
  assert(
    !terminal.dialogOpen &&
      terminal.toast.includes(`Inserted ${targetPath} and added one reference.`) &&
      terminal.path === sourceNotePath &&
      terminal.outgoingCount === 0 &&
      terminal.editorText === expectedNote &&
      terminal.editorFocused,
    `The committed editor insertion did not reconcile and focus the visible note: ${JSON.stringify(terminal)}`,
  );
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

async function waitForFixture(deadline, { expectedReady = 6, expectedUnavailable = 1 } = {}) {
  while (Date.now() < deadline) {
    const state = await evaluate(`(async () => {
      const snapshot = await window.threadleaf.getSnapshot();
      return {
        path: snapshot.workspace?.activeNote?.path ?? '',
        ready: document.querySelectorAll('.preview-attachment-card[data-threadleaf-attachment-status="ready"]').length,
        unavailable: document.querySelectorAll('.preview-attachment-unavailable').length,
        pending: document.querySelectorAll('.preview-attachment-placeholder').length,
        mode: snapshot.vault?.mode ?? '',
      };
    })()`);
    if (
      state.path === "Attachment Desk.md" &&
      state.ready === expectedReady &&
      state.unavailable === expectedUnavailable &&
      state.pending === 0
    )
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

async function waitForToast(fragment, deadline) {
  while (Date.now() < deadline) {
    const text = await evaluate("document.querySelector('#toast')?.textContent ?? ''");
    if (text.includes(fragment)) return text;
    await delay(25);
  }
  throw new Error(`The packaged attachment toast did not include ${JSON.stringify(fragment)}.`);
}

function nativeReceiverEvents() {
  return nativeReceiverOutput
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("THREADLEAF_NATIVE_ATTACHMENT_RECEIVER "))
    .map((line) => JSON.parse(line.slice("THREADLEAF_NATIVE_ATTACHMENT_RECEIVER ".length)));
}

async function waitForNativeReceiver(action, absolutePath, deadline) {
  const pathSha256 = createHash("sha256").update(absolutePath, "utf8").digest("hex");
  while (Date.now() < deadline) {
    const event = nativeReceiverEvents().find(
      (candidate) =>
        candidate.version === 1 &&
        candidate.action === action &&
        candidate.pathSha256 === pathSha256,
    );
    if (event) return event;
    await delay(25);
  }
  throw new Error(
    `The packaged main process did not receive ${action} for the exact canonical attachment path.`,
  );
}

async function setTheme(theme) {
  const current = await evaluate("document.documentElement.dataset.theme");
  if (current !== theme) {
    const dialogOpen = await evaluate(
      "document.querySelector('#attachment-move-dialog')?.open === true",
    );
    const dialogState = dialogOpen
      ? await evaluate(`(() => ({
          source: document.querySelector('#attachment-move-current-path')?.textContent ?? '',
          target: document.querySelector('#attachment-move-target')?.value ?? '',
          action: (document.querySelector('#attachment-move-title')?.textContent ?? '').includes('Relink')
            ? 'relink'
            : (document.querySelector('#attachment-move-title')?.textContent ?? '').includes('Rename')
              ? 'rename'
              : 'move',
          previewed: (document.querySelector('#attachment-move-preview-message')?.textContent ?? '').length > 0,
          blocked: (document.querySelector('#attachment-move-error')?.textContent ?? '').length > 0,
        }))()`)
      : null;
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
    if (dialogState) {
      await openAttachmentMoveWorkbench(dialogState.source, dialogState.action);
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
      await replaceInput("#attachment-move-target", dialogState.target);
      if (dialogState.previewed || dialogState.blocked) {
        await clickPointer("#attachment-move-submit");
        const restoreDeadline = Date.now() + 8_000;
        while (Date.now() < restoreDeadline) {
          const restored = await evaluate(`(() => ({
            preview: document.querySelector('#attachment-move-preview-message')?.textContent ?? '',
            error: document.querySelector('#attachment-move-error')?.textContent ?? '',
          }))()`);
          if (
            (dialogState.previewed && restored.preview.length > 0) ||
            (dialogState.blocked && restored.error.length > 0)
          ) {
            break;
          }
          await delay(50);
        }
        const restored = await evaluate(`(() => ({
          preview: document.querySelector('#attachment-move-preview-message')?.textContent ?? '',
          error: document.querySelector('#attachment-move-error')?.textContent ?? '',
        }))()`);
        assert(
          dialogState.previewed ? restored.preview.length > 0 : restored.error.length > 0,
          "The attachment operation state could not be restored after switching theme.",
        );
      }
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

async function openAttachmentMoveWorkbench(attachmentPath = "Assets/report.pdf", action = "move") {
  const selector =
    action === "relink"
      ? `[data-threadleaf-attachment-action="relink"][data-threadleaf-attachment-path="${attachmentPath}"]`
      : `[data-threadleaf-attachment-path="${attachmentPath}"] [data-threadleaf-attachment-action="${action}"]`;
  await clickPointer(selector);
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

async function openAttachmentRestoreWorkbench(attachmentPath, selectedFilePath) {
  let resolveChooser;
  const chooserOpened = new Promise((resolve) => {
    resolveChooser = resolve;
  });
  cdp.on("Page.fileChooserOpened", (event) => resolveChooser?.(event));
  await cdp.send("Page.setInterceptFileChooserDialog", { enabled: true });
  await clickPointer(
    `[data-threadleaf-attachment-action="restore"][data-threadleaf-attachment-path="${attachmentPath}"]`,
  );
  const chooser = await Promise.race([chooserOpened, delay(5_000).then(() => null)]);
  assert(chooser?.backendNodeId, "The Restore file control did not open its renderer file picker.");
  await cdp.send("DOM.setFileInputFiles", {
    files: [selectedFilePath],
    backendNodeId: chooser.backendNodeId,
  });
  await cdp.send("Page.setInterceptFileChooserDialog", { enabled: false });
  await waitForAttachmentRestoreDialog(
    "The selected restore file did not reach the attachment workbench.",
  );
}

async function previewAttachmentRestore(targetPath, sourceFileName) {
  await clickPointer("#attachment-move-submit");
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const state = await evaluate(`(() => ({
      open: document.querySelector('#attachment-move-dialog')?.open === true,
      message: document.querySelector('#attachment-move-preview-message')?.textContent ?? '',
      list: document.querySelector('#attachment-move-blocker-list')?.textContent ?? '',
      hashTitle: document.querySelector('#attachment-move-blocker-list .move-note-blocker-origin')?.getAttribute('title') ?? '',
    }))()`);
    if (
      state.open &&
      state.message.length > 0 &&
      state.list.includes(sourceFileName) &&
      state.list.includes(targetPath) &&
      /^SHA-256 [a-f0-9]{64}$/u.test(state.hashTitle)
    ) {
      return state;
    }
    await delay(50);
  }
  throw new Error(`The exact-byte attachment restore preview did not render for ${targetPath}.`);
}

async function assertAdapterRestoreWorkbench({
  targetPath,
  sourceFileName,
  bytes,
  forbiddenSourcePath,
}) {
  const state = await evaluate(`(() => ({
    title: document.querySelector('#attachment-move-title')?.textContent ?? '',
    description: document.querySelector('#attachment-move-description')?.textContent ?? '',
    currentPath: document.querySelector('#attachment-move-current-path')?.textContent ?? '',
    targetValue: document.querySelector('#attachment-move-target')?.value ?? '',
    targetReadOnly: document.querySelector('#attachment-move-target')?.readOnly === true,
    bodyText: document.querySelector('#attachment-move-dialog')?.textContent ?? '',
    dialogHtml: document.querySelector('#attachment-move-dialog')?.outerHTML ?? '',
  }))()`);
  assert(
    state.title === "Restore this missing attachment" &&
      state.description.includes("exact bytes") &&
      state.description.includes("leaves the source note unchanged") &&
      state.currentPath === targetPath &&
      state.targetValue === `${sourceFileName} · ${bytes.byteLength} B` &&
      state.targetReadOnly &&
      !state.bodyText.includes(forbiddenSourcePath) &&
      !state.bodyText.includes(vaultPath) &&
      !state.dialogHtml.includes(forbiddenSourcePath) &&
      !state.dialogHtml.includes(vaultPath),
    `The external-file adapter workbench was not target-bound or path-private: ${JSON.stringify(state)}`,
  );
  const preview = await previewAttachmentRestore(targetPath, sourceFileName);
  assert(
    (await fs.readFile(notePath, "utf8")) === originalNote,
    `The ${targetPath} adapter preview changed the source note.`,
  );
  assert(
    !(await fs
      .stat(path.join(vaultPath, targetPath))
      .then(() => true)
      .catch(() => false)),
    `The ${targetPath} adapter published bytes before confirmation.`,
  );
  return preview;
}

async function confirmAdapterRestore({
  targetPath,
  sourceFileName,
  bytes,
  expectedReady,
  expectedUnavailable,
}) {
  await clickPointer("#attachment-move-submit");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const targetExists = await fs
      .stat(path.join(vaultPath, targetPath))
      .then(() => true)
      .catch(() => false);
    const terminalUi = await evaluate(`(() => ({
      dialogOpen: document.querySelector('#attachment-move-dialog')?.open === true,
      toast: document.querySelector('#toast')?.textContent?.trim() ?? '',
    }))()`);
    if (
      targetExists &&
      !terminalUi.dialogOpen &&
      terminalUi.toast.includes(`Restored ${targetPath} from ${sourceFileName}.`)
    ) {
      break;
    }
    await delay(60);
  }
  assert(
    (await fs.readFile(path.join(vaultPath, targetPath))).equals(bytes),
    `The confirmed ${targetPath} adapter did not preserve external bytes exactly.`,
  );
  assert(
    (await fs.readFile(notePath, "utf8")) === originalNote,
    `The confirmed ${targetPath} adapter rewrote the source note.`,
  );
  await waitForFixture(Date.now() + 8_000, { expectedReady, expectedUnavailable });
  assert(
    (await evaluate(
      `(() => {
        const card = document.querySelector('[data-threadleaf-attachment-path=${JSON.stringify(targetPath)}][data-threadleaf-attachment-status="ready"]');
        return card !== null && card.querySelector('[data-threadleaf-attachment-action="restore"], [data-threadleaf-attachment-action="paste"], [data-threadleaf-attachment-action="relink"]') === null;
      })()`,
    )) === true,
    `The restored ${targetPath} card did not become ready or retained stale recovery controls.`,
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
  await fs.mkdir(path.join(vaultPath, "Restored"), { recursive: true });
  await fs.mkdir(path.join(vaultPath, "Notes"), { recursive: true });
  await fs.mkdir(userDataPath, { recursive: true });
  await fs.writeFile(notePath, originalNote, "utf8");
  await fs.writeFile(path.join(vaultPath, insertionPasteNotePath), insertionPasteNote, "utf8");
  await fs.writeFile(path.join(vaultPath, insertionDropNotePath), insertionDropNote, "utf8");
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
  await fs.writeFile(path.join(vaultPath, recoveredAttachmentPath), recoveredAttachmentBytes);
  await fs.writeFile(externalRestorePath, externalRestoreBytes);
  await fs.writeFile(externalDropPath, externalDropBytes);
  await fs.writeFile(externalInsertionDropPath, insertionDropBytes);
  await fs.writeFile(path.join(vaultPath, "Audio Board.canvas"), originalAudioCanvas, "utf8");
  await fs.writeFile(path.join(vaultPath, "Unsafe Audio.canvas"), unsafeAudioCanvas, "utf8");
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
      env: {
        ...process.env,
        ELECTRON_OZONE_PLATFORM_HINT: "x11",
        THREADLEAF_TEST_NATIVE_ATTACHMENT_RECEIVER: "stdout-v1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  const output = [];
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      const text = String(chunk);
      output.push(text);
      if (output.length > 100) output.shift();
      nativeReceiverOutput = `${nativeReceiverOutput}${text}`.slice(-64 * 1024);
    });
  }

  const deadline = Date.now() + 15_000;
  const target = await waitForTarget(port, deadline);
  cdp = connectCdp(target.webSocketDebuggerUrl);
  const rendererErrors = [];
  cdp.on("Runtime.exceptionThrown", (event) => {
    rendererErrors.push(
      event.exceptionDetails?.exception?.description ??
        event.exceptionDetails?.text ??
        "Unknown renderer exception",
    );
  });
  cdp.on("Log.entryAdded", (event) => {
    if (event.entry?.level === "error")
      rendererErrors.push(event.entry.text ?? "Unknown log error");
  });
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
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
  await waitForFixture(deadline, { expectedReady: 3, expectedUnavailable: 4 });
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
    status: card.getAttribute('data-threadleaf-attachment-status') ?? '',
    actionCount: card.querySelectorAll('.preview-attachment-action').length,
  })))()`);
  const readyCards = cardState.filter((card) => card.status === "ready");
  const missingCards = cardState.filter((card) => card.status === "missing");
  assert(
    cardState.length === 7 &&
      readyCards.length === 3 &&
      readyCards.find((card) => card.path === "Assets/report.pdf")?.actionCount === 4 &&
      readyCards.find((card) => card.path === "Assets/audio.mp3")?.actionCount === 4 &&
      readyCards.find((card) => card.path === "Assets/unknown.bin")?.actionCount === 3 &&
      missingCards.length === 4 &&
      missingCards.every(
        (card) =>
          card.actionCount === 3 &&
          card.text.includes("Restore file") &&
          card.text.includes("Paste file") &&
          card.text.includes("Drop one file here") &&
          card.text.includes("Relink"),
      ),
    "Attachment cards lost open/reveal/rename/publication metadata.",
  );
  assert(
    readyCards.every((card) => card.text.includes("Publish copy")),
    "Attachment cards did not expose truthful source-retaining publication controls.",
  );
  assert(
    readyCards.every((card) => card.text.includes("Rename or move")),
    "Attachment cards did not expose the explicit source-removing operation.",
  );
  assert(
    cardState.some((card) => card.text.includes("unsupported")),
    "The unsupported binary did not retain a safe metadata card.",
  );
  assert(
    (await evaluate(
      `document.querySelector('[data-threadleaf-attachment-path="Assets/unknown.bin"] [data-threadleaf-attachment-action="open"]') === null`,
    )) === true &&
      (await evaluate(
        `document.querySelector('[data-threadleaf-attachment-path="Assets/unknown.bin"] [data-threadleaf-attachment-action="reveal"]') !== null`,
      )) === true,
    "Unknown bytes were not restricted to the safe native Reveal action.",
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
  await waitForToast("Opened Assets/report.pdf.", Date.now() + 5_000);
  await waitForNativeReceiver(
    "open",
    await fs.realpath(path.join(vaultPath, "Assets", "report.pdf")),
    Date.now() + 5_000,
  );
  await clickPointer(
    '[data-threadleaf-attachment-path="Assets/unknown.bin"] [data-threadleaf-attachment-action="reveal"]',
  );
  await waitForToast("Asked your file manager to reveal Assets/unknown.bin.", Date.now() + 5_000);
  await waitForNativeReceiver(
    "reveal",
    await fs.realpath(path.join(vaultPath, "Assets", "unknown.bin")),
    Date.now() + 5_000,
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

  await openAttachmentRestoreWorkbench(restoreAttachmentPath, externalRestorePath);
  const restoreWorkbench = await evaluate(`(() => ({
    title: document.querySelector('#attachment-move-title')?.textContent ?? '',
    description: document.querySelector('#attachment-move-description')?.textContent ?? '',
    currentLabel: document.querySelector('#attachment-move-current-label')?.textContent ?? '',
    currentPath: document.querySelector('#attachment-move-current-path')?.textContent ?? '',
    targetLabel: document.querySelector('#attachment-move-target-label')?.textContent ?? '',
    targetValue: document.querySelector('#attachment-move-target')?.value ?? '',
    targetReadOnly: document.querySelector('#attachment-move-target')?.readOnly === true,
    closeLabel: document.querySelector('#attachment-move-close')?.getAttribute('aria-label') ?? '',
    bodyText: document.body.textContent ?? '',
  }))()`);
  assert(
    restoreWorkbench.title === "Restore this missing attachment" &&
      restoreWorkbench.description.includes("exact bytes") &&
      restoreWorkbench.description.includes("leaves the source note unchanged") &&
      restoreWorkbench.currentLabel === "Missing target" &&
      restoreWorkbench.currentPath === restoreAttachmentPath &&
      restoreWorkbench.targetLabel === "Selected external file" &&
      restoreWorkbench.targetValue === "external-recovery.bin · 8 B" &&
      restoreWorkbench.targetReadOnly &&
      restoreWorkbench.closeLabel === "Cancel attachment restore" &&
      !restoreWorkbench.bodyText.includes(externalRestorePath) &&
      !restoreWorkbench.bodyText.includes(vaultPath),
    `The exact-byte restore workbench was not truthful or path-private: ${JSON.stringify(restoreWorkbench)}`,
  );
  await previewAttachmentRestore(restoreAttachmentPath, "external-recovery.bin");
  assert(
    (await fs.readFile(notePath, "utf8")) === originalNote,
    "The restore preview changed the source note.",
  );
  assert(
    !(await fs
      .stat(path.join(vaultPath, restoreAttachmentPath))
      .then(() => true)
      .catch(() => false)),
    "The restore preview published bytes before confirmation.",
  );
  const restoreDarkPath = await capture("packaged-attachment-restore-preview-dark.png");
  screenshots.push(restoreDarkPath);
  const restorePositiveState = await evaluate(`(() => {
    const dialog = document.querySelector('#attachment-move-dialog');
    if (!(dialog instanceof HTMLDialogElement)) return null;
    const rect = dialog.getBoundingClientRect();
    dialog.style.outline = '12px solid rgb(255, 0, 255)';
    dialog.style.outlineOffset = '-12px';
    return { region: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } };
  })()`);
  assert(restorePositiveState, "The restore preview positive control could not reach its dialog.");
  const restorePositivePath = await capture(
    "packaged-attachment-restore-preview-positive-control.png",
  );
  screenshots.push(restorePositivePath);
  restoreChangedPixels = changedPixelsInRegion(
    decodePng(await fs.readFile(restoreDarkPath)),
    decodePng(await fs.readFile(restorePositivePath)),
    restorePositiveState.region,
  );
  assert(
    restoreChangedPixels > 0,
    "The restore preview visual positive control changed no dialog pixels.",
  );
  await evaluate(
    "document.querySelector('#attachment-move-dialog')?.style.removeProperty('outline'); document.querySelector('#attachment-move-dialog')?.style.removeProperty('outline-offset'); true",
  );
  await clickPointer("#attachment-move-cancel");
  const restoreDarkCloseDeadline = Date.now() + 5_000;
  while (Date.now() < restoreDarkCloseDeadline) {
    if (!(await evaluate("document.querySelector('#attachment-move-dialog')?.open === true"))) {
      break;
    }
    await delay(40);
  }
  await setTheme("light");
  await openAttachmentRestoreWorkbench(restoreAttachmentPath, externalRestorePath);
  await previewAttachmentRestore(restoreAttachmentPath, "external-recovery.bin");
  screenshots.push(await capture("packaged-attachment-restore-preview-light.png"));
  assert(
    (await fs.readFile(notePath, "utf8")) === originalNote &&
      !(await fs
        .stat(path.join(vaultPath, restoreAttachmentPath))
        .then(() => true)
        .catch(() => false)),
    "The light-theme restore preview mutated the fixture before confirmation.",
  );
  await clickPointer("#attachment-move-submit");
  const restoreDeadline = Date.now() + 10_000;
  while (Date.now() < restoreDeadline) {
    const targetExists = await fs
      .stat(path.join(vaultPath, restoreAttachmentPath))
      .then(() => true)
      .catch(() => false);
    const terminalUi = await evaluate(`(() => ({
      dialogOpen: document.querySelector('#attachment-move-dialog')?.open === true,
      toast: document.querySelector('#toast')?.textContent?.trim() ?? '',
    }))()`);
    if (
      targetExists &&
      !terminalUi.dialogOpen &&
      terminalUi.toast.includes("Restored Restored/exact.bin from external-recovery.bin.")
    ) {
      break;
    }
    await delay(60);
  }
  assert(
    (await fs.readFile(path.join(vaultPath, restoreAttachmentPath))).equals(externalRestoreBytes),
    "The confirmed restore did not preserve the selected external bytes exactly.",
  );
  assert(
    (await fs.readFile(notePath, "utf8")) === originalNote,
    "The confirmed exact-path restore rewrote the source note.",
  );
  await waitForFixture(Date.now() + 8_000, { expectedReady: 4, expectedUnavailable: 3 });
  assert(
    (await evaluate(
      `(() => {
        const card = document.querySelector('[data-threadleaf-attachment-path=${JSON.stringify(restoreAttachmentPath)}][data-threadleaf-attachment-status="ready"]');
        return card !== null && card.querySelector('[data-threadleaf-attachment-action="restore"], [data-threadleaf-attachment-action="paste"], [data-threadleaf-attachment-action="relink"]') === null;
      })()`,
    )) === true,
    "The restored Reading-view card did not become ready or retained stale recovery controls.",
  );
  screenshots.push(await capture("packaged-attachment-restored-light.png"));
  await setTheme("dark");
  screenshots.push(await capture("packaged-attachment-restored-dark.png"));

  const dropCardSelector = `.preview-attachment-card[data-threadleaf-attachment-path="${dropAttachmentPath}"][data-threadleaf-attachment-external-input="true"]`;
  const textAndUrlDrop = await dispatchRejectedCardDrop(dropCardSelector, textAndUrlDragData());
  assert(
    textAndUrlDrop?.sameDocument && textAndUrlDrop.cardPresent && !textAndUrlDrop.dialogOpen,
    `A refused text/URL drop escaped the card boundary: ${JSON.stringify(textAndUrlDrop)}`,
  );
  await waitForToast("does not contain one file", Date.now() + 5_000);
  const multiFileDrop = await dispatchRejectedCardDrop(
    dropCardSelector,
    fileDragData([externalRestorePath, externalDropPath]),
  );
  assert(
    multiFileDrop?.sameDocument && multiFileDrop.cardPresent && !multiFileDrop.dialogOpen,
    `A refused multi-file drop escaped the card boundary: ${JSON.stringify(multiFileDrop)}`,
  );
  await waitForToast("Restore one file at a time", Date.now() + 5_000);
  assert(
    (await fs.readFile(notePath, "utf8")) === originalNote &&
      !(await fs
        .stat(path.join(vaultPath, dropAttachmentPath))
        .then(() => true)
        .catch(() => false)),
    "The multi-file drop refusal mutated the source note or missing target.",
  );
  screenshots.push(await capture("packaged-attachment-drop-multiple-refused-dark.png"));
  const darkDrag = await beginFileDrag(dropCardSelector, externalDropPath);
  screenshots.push(await capture("packaged-attachment-drop-target-dark.png"));
  await cancelFileDrag(darkDrag);
  await setTheme("light");
  const lightDrag = await beginFileDrag(dropCardSelector, externalDropPath);
  screenshots.push(await capture("packaged-attachment-drop-target-light.png"));
  await finishFileDrop(lightDrag);
  await waitForAttachmentRestoreDialog(
    "The trusted CDP file drop did not reach the attachment restore workbench.",
  );
  await assertAdapterRestoreWorkbench({
    targetPath: dropAttachmentPath,
    sourceFileName: path.basename(externalDropPath),
    bytes: externalDropBytes,
    forbiddenSourcePath: externalDropPath,
  });
  screenshots.push(await capture("packaged-attachment-drop-preview-light.png"));
  await confirmAdapterRestore({
    targetPath: dropAttachmentPath,
    sourceFileName: path.basename(externalDropPath),
    bytes: externalDropBytes,
    expectedReady: 5,
    expectedUnavailable: 2,
  });

  await setTheme("dark");
  const pasteActionSelector = `[data-threadleaf-attachment-action="paste"][data-threadleaf-attachment-path="${pasteAttachmentPath}"]`;
  await dispatchFilePaste(pasteActionSelector, externalPasteName, externalPasteBytes);
  await assertAdapterRestoreWorkbench({
    targetPath: pasteAttachmentPath,
    sourceFileName: externalPasteName,
    bytes: externalPasteBytes,
    forbiddenSourcePath: testRoot,
  });
  screenshots.push(await capture("packaged-attachment-paste-preview-dark.png"));
  await confirmAdapterRestore({
    targetPath: pasteAttachmentPath,
    sourceFileName: externalPasteName,
    bytes: externalPasteBytes,
    expectedReady: 6,
    expectedUnavailable: 1,
  });

  await setTheme("light");
  const remainingPasteActionSelector = `[data-threadleaf-attachment-action="paste"][data-threadleaf-attachment-path="${missingAttachmentPath}"]`;
  const textPaste = await dispatchTextOnlyPaste(remainingPasteActionSelector);
  assert(
    textPaste?.dispatched &&
      textPaste.focused &&
      textPaste.defaultPrevented === false &&
      textPaste.dispatchResult === true &&
      textPaste.dialogOpen === false,
    `Text-only clipboard input was not left untouched: ${JSON.stringify(textPaste)}`,
  );
  await waitForToast("does not contain one file", Date.now() + 5_000);
  assert(
    (await fs.readFile(notePath, "utf8")) === originalNote &&
      !(await fs
        .stat(path.join(vaultPath, missingAttachmentPath))
        .then(() => true)
        .catch(() => false)),
    "The text-only clipboard negative control mutated the source note or missing target.",
  );
  assert(
    (await evaluate(
      `document.querySelector('[data-threadleaf-attachment-action="paste"][data-threadleaf-attachment-path=${JSON.stringify(missingAttachmentPath)}]') !== null`,
    )) === true,
    "The text-only clipboard negative control removed the authorized missing card.",
  );
  screenshots.push(await capture("packaged-attachment-paste-text-refused-light.png"));

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

  await waitForFixture(Date.now() + 8_000);
  await setTheme("dark");
  await openAttachmentMoveWorkbench("Assets/audio.mp3", "rename");
  const renameWorkbench = await evaluate(`(() => ({
    title: document.querySelector('#attachment-move-title')?.textContent ?? '',
    description: document.querySelector('#attachment-move-description')?.textContent ?? '',
    targetLabel: document.querySelector('#attachment-move-target-label')?.textContent ?? '',
    closeLabel: document.querySelector('#attachment-move-close')?.getAttribute('aria-label') ?? '',
  }))()`);
  assert(
    renameWorkbench.title === "Rename or move this attachment" &&
      renameWorkbench.description.includes("remove the original path") &&
      renameWorkbench.description.includes("Canvas") &&
      renameWorkbench.targetLabel === "New path" &&
      renameWorkbench.closeLabel === "Cancel attachment rename",
    `The source-removing workbench was not explicit about its semantics: ${JSON.stringify(renameWorkbench)}`,
  );
  await replaceInput("#attachment-move-target", "Archive/audio-renamed.mp3");
  await clickPointer("#attachment-move-submit");
  const canvasBlockDeadline = Date.now() + 8_000;
  let canvasBlockState = null;
  while (Date.now() < canvasBlockDeadline) {
    canvasBlockState = await evaluate(`(() => ({
      open: document.querySelector('#attachment-move-dialog')?.open === true,
      error: document.querySelector('#attachment-move-error')?.textContent ?? '',
      list: document.querySelector('#attachment-move-blocker-list')?.textContent ?? '',
    }))()`);
    if (
      canvasBlockState.open &&
      canvasBlockState.error.includes("Rename blocked") &&
      canvasBlockState.list.includes("Unsafe Audio.canvas")
    ) {
      break;
    }
    await delay(50);
  }
  assert(
    canvasBlockState?.open &&
      canvasBlockState.error.includes("Rename blocked") &&
      canvasBlockState.list.includes("Canvas $") &&
      canvasBlockState.list.includes("Canvas could not be verified safely"),
    `The unsafe Canvas blocker was not visible and specific: ${JSON.stringify(canvasBlockState)}`,
  );
  assert(
    await fs
      .stat(path.join(vaultPath, "Assets", "audio.mp3"))
      .then(() => true)
      .catch(() => false),
    "The unsafe-Canvas-blocked attachment rename removed its source.",
  );
  assert(
    (await fs.readFile(path.join(vaultPath, "Audio Board.canvas"), "utf8")) === originalAudioCanvas,
    "The unsafe-Canvas-blocked attachment rename changed the valid Canvas bytes.",
  );
  screenshots.push(await capture("packaged-attachment-rename-unsafe-canvas-block-dark.png"));
  await setTheme("light");
  screenshots.push(await capture("packaged-attachment-rename-unsafe-canvas-block-light.png"));
  await clickPointer("#attachment-move-cancel");
  const canvasBlockCloseDeadline = Date.now() + 5_000;
  while (Date.now() < canvasBlockCloseDeadline) {
    if (!(await evaluate("document.querySelector('#attachment-move-dialog')?.open === true"))) {
      break;
    }
    await delay(40);
  }
  await fs.unlink(path.join(vaultPath, "Unsafe Audio.canvas"));
  await delay(500);
  await setTheme("dark");
  await openAttachmentMoveWorkbench("Assets/audio.mp3", "rename");
  const renamePreview = await previewAttachmentPublication("Archive/audio-renamed.mp3");
  assert(
    renamePreview.list.includes("Audio Board.canvas") &&
      renamePreview.list.includes("Canvas $.nodes[0].file") &&
      renamePreview.list.includes("Canvas $.nodes[1].background") &&
      renamePreview.list.includes("Assets/audio.mp3") &&
      renamePreview.list.includes("Archive/audio-renamed.mp3") &&
      renamePreview.list.includes("./Assets/audio.mp3") &&
      renamePreview.list.includes("./Archive/audio-renamed.mp3"),
    `The attachment rename preview omitted its exact Canvas reference updates: ${JSON.stringify(renamePreview)}`,
  );
  assert(
    await fs
      .stat(path.join(vaultPath, "Assets", "audio.mp3"))
      .then(() => true)
      .catch(() => false),
    "The attachment rename preview removed its source before confirmation.",
  );
  assert(
    !(await fs
      .stat(path.join(vaultPath, "Archive", "audio-renamed.mp3"))
      .then(() => true)
      .catch(() => false)),
    "The attachment rename preview created its destination before confirmation.",
  );
  assert(
    (await fs.readFile(path.join(vaultPath, "Audio Board.canvas"), "utf8")) === originalAudioCanvas,
    "The attachment rename preview changed Canvas bytes before confirmation.",
  );
  screenshots.push(await capture("packaged-attachment-rename-canvas-preview-dark.png"));
  await setTheme("light");
  screenshots.push(await capture("packaged-attachment-rename-canvas-preview-light.png"));

  await clickPointer("#attachment-move-submit");
  const renameDeadline = Date.now() + 10_000;
  while (Date.now() < renameDeadline) {
    const sourceExists = await fs
      .stat(path.join(vaultPath, "Assets", "audio.mp3"))
      .then(() => true)
      .catch(() => false);
    const targetExists = await fs
      .stat(path.join(vaultPath, "Archive", "audio-renamed.mp3"))
      .then(() => true)
      .catch(() => false);
    const terminalUi = await evaluate(`(() => ({
      dialogOpen: document.querySelector('#attachment-move-dialog')?.open === true,
      toast: document.querySelector('#toast')?.textContent?.trim() ?? '',
    }))()`);
    if (
      !sourceExists &&
      targetExists &&
      !terminalUi.dialogOpen &&
      terminalUi.toast.includes("Moved the attachment to")
    ) {
      break;
    }
    await delay(60);
  }
  assert(
    !(await fs
      .stat(path.join(vaultPath, "Assets", "audio.mp3"))
      .then(() => true)
      .catch(() => false)),
    "The confirmed attachment rename retained its source file.",
  );
  assert(
    (await fs.readFile(path.join(vaultPath, "Archive", "audio-renamed.mp3"))).equals(
      Buffer.from("ID3\x04\0\0fixture", "binary"),
    ),
    "The confirmed attachment rename changed the exact source bytes.",
  );
  assert(
    (await fs.readFile(notePath, "utf8")) ===
      originalNote
        .replaceAll("Assets/report.pdf", "Archive/report-renamed.pdf")
        .replaceAll("Assets/audio.mp3", "Archive/audio-renamed.mp3"),
    "The confirmed attachment rename did not rewrite the expected local reference.",
  );
  assert(
    (await fs.readFile(path.join(vaultPath, "Audio Board.canvas"), "utf8")) === renamedAudioCanvas,
    "The confirmed attachment rename did not preserve and rewrite the exact Canvas bytes.",
  );
  const renameToast = await evaluate("document.querySelector('#toast')?.textContent?.trim() ?? ''");
  assert(
    renameToast.includes("Moved the attachment to Archive/audio-renamed.mp3") &&
      renameToast.includes("updated 3 references") &&
      renameToast.includes("the original path Assets/audio.mp3 was removed") &&
      !renameToast.includes("original remains"),
    `The attachment rename toast was not source-removal truthful: ${renameToast}`,
  );
  await setTheme("dark");
  screenshots.push(await capture("packaged-attachment-renamed-dark.png"));
  await setTheme("light");
  screenshots.push(await capture("packaged-attachment-renamed-light.png"));

  const beforeRelink = originalNote
    .replaceAll("Assets/report.pdf", "Archive/report-renamed.pdf")
    .replaceAll("Assets/audio.mp3", "Archive/audio-renamed.mp3");
  await waitForFixture(Date.now() + 8_000);
  await setTheme("dark");
  await openAttachmentMoveWorkbench(missingAttachmentPath, "relink");
  const relinkWorkbench = await evaluate(`(() => ({
    title: document.querySelector('#attachment-move-title')?.textContent ?? '',
    description: document.querySelector('#attachment-move-description')?.textContent ?? '',
    currentLabel: document.querySelector('#attachment-move-current-label')?.textContent ?? '',
    currentPath: document.querySelector('#attachment-move-current-path')?.textContent ?? '',
    targetLabel: document.querySelector('#attachment-move-target-label')?.textContent ?? '',
    closeLabel: document.querySelector('#attachment-move-close')?.getAttribute('aria-label') ?? '',
  }))()`);
  assert(
    relinkWorkbench.title === "Relink this missing attachment" &&
      relinkWorkbench.description.includes("exactly one proven missing attachment target") &&
      relinkWorkbench.description.includes("does not copy, move, delete, or overwrite") &&
      relinkWorkbench.currentLabel === "Missing target" &&
      relinkWorkbench.currentPath === missingAttachmentPath &&
      relinkWorkbench.targetLabel === "Existing attachment path" &&
      relinkWorkbench.closeLabel === "Cancel attachment relink",
    `The missing-attachment relink workbench was not explicit about its semantics: ${JSON.stringify(relinkWorkbench)}`,
  );
  const relinkPreview = await previewAttachmentPublication(recoveredAttachmentPath);
  assert(
    relinkPreview.list.includes("Attachment Desk.md") &&
      relinkPreview.list.includes("Missing/lost-report.pdf?download=1") &&
      relinkPreview.list.includes("Assets/recovered report.pdf?download=1"),
    `The relink preview omitted its exact one-token target replacement: ${JSON.stringify(relinkPreview)}`,
  );
  assert(
    (await fs.readFile(notePath, "utf8")) === beforeRelink,
    "The relink preview changed the source note before confirmation.",
  );
  assert(
    (await fs.readFile(path.join(vaultPath, recoveredAttachmentPath))).equals(
      recoveredAttachmentBytes,
    ),
    "The relink preview changed the existing candidate bytes.",
  );
  assert(
    !(await fs
      .stat(path.join(vaultPath, missingAttachmentPath))
      .then(() => true)
      .catch(() => false)),
    "The relink preview created the missing attachment path.",
  );
  screenshots.push(await capture("packaged-attachment-relink-preview-dark.png"));
  await setTheme("light");
  screenshots.push(await capture("packaged-attachment-relink-preview-light.png"));

  await clickPointer("#attachment-move-submit");
  const afterRelink = beforeRelink.replace(
    "Missing/lost-report.pdf?download=1",
    "Assets/recovered report.pdf?download=1",
  );
  const relinkDeadline = Date.now() + 10_000;
  while (Date.now() < relinkDeadline) {
    const terminalUi = await evaluate(`(() => ({
      dialogOpen: document.querySelector('#attachment-move-dialog')?.open === true,
      toast: document.querySelector('#toast')?.textContent?.trim() ?? '',
    }))()`);
    if (
      (await fs.readFile(notePath, "utf8")) === afterRelink &&
      !terminalUi.dialogOpen &&
      terminalUi.toast.includes("Relinked the missing attachment")
    ) {
      break;
    }
    await delay(60);
  }
  assert(
    (await fs.readFile(notePath, "utf8")) === afterRelink,
    "The confirmed relink did not rewrite exactly the missing attachment target.",
  );
  assert(
    (await fs.readFile(path.join(vaultPath, recoveredAttachmentPath))).equals(
      recoveredAttachmentBytes,
    ),
    "The confirmed relink changed the existing candidate bytes.",
  );
  assert(
    !(await fs
      .stat(path.join(vaultPath, missingAttachmentPath))
      .then(() => true)
      .catch(() => false)),
    "The confirmed relink created the formerly missing attachment path.",
  );
  const relinkToast = await evaluate("document.querySelector('#toast')?.textContent?.trim() ?? ''");
  assert(
    relinkToast.includes(`Relinked the missing attachment to ${recoveredAttachmentPath}.`),
    `The relink toast did not identify the existing candidate path: ${relinkToast}`,
  );
  await waitForFixture(Date.now() + 8_000, { expectedReady: 7, expectedUnavailable: 0 });
  assert(
    (await evaluate(
      `document.querySelector('[data-threadleaf-attachment-path=${JSON.stringify(recoveredAttachmentPath)}][data-threadleaf-attachment-status="ready"]') !== null && document.querySelector('[data-threadleaf-attachment-action="restore"], [data-threadleaf-attachment-action="paste"], [data-threadleaf-attachment-action="relink"]') === null`,
    )) === true,
    "The relinked Reading-view card did not become ready or retained a stale Relink action.",
  );
  screenshots.push(await capture("packaged-attachment-relinked-light.png"));
  await setTheme("dark");
  screenshots.push(await capture("packaged-attachment-relinked-dark.png"));

  await openEditorNote(insertionPasteNotePath);
  await setTheme("dark");
  await dispatchEditorFilePaste(insertionPasteFileName, insertionPasteBytes);
  await assertAttachmentInsertWorkbench({
    sourceNotePath: insertionPasteNotePath,
    sourceFileName: insertionPasteFileName,
    targetPath: insertionPasteTargetPath,
    bytes: insertionPasteBytes,
    reference: insertionPasteReference,
  });
  assert(
    (await fs.readFile(path.join(vaultPath, insertionPasteNotePath), "utf8")) ===
      insertionPasteNote &&
      !(await fs
        .stat(path.join(vaultPath, insertionPasteTargetPath))
        .then(() => true)
        .catch(() => false)),
    "The editor paste preview mutated the note or published bytes before confirmation.",
  );
  screenshots.push(await capture("packaged-editor-attachment-paste-preview-dark.png"));
  await clickPointer("#attachment-insert-cancel");
  const pasteCancelDeadline = Date.now() + 5_000;
  while (Date.now() < pasteCancelDeadline) {
    if (!(await evaluate("document.querySelector('#attachment-insert-dialog')?.open === true")))
      break;
    await delay(40);
  }
  assert(
    !(await evaluate("document.querySelector('#attachment-insert-dialog')?.open === true")),
    "The editor paste preview did not close before the light-theme pass.",
  );
  await setTheme("light");
  await dispatchEditorFilePaste(insertionPasteFileName, insertionPasteBytes);
  await assertAttachmentInsertWorkbench({
    sourceNotePath: insertionPasteNotePath,
    sourceFileName: insertionPasteFileName,
    targetPath: insertionPasteTargetPath,
    bytes: insertionPasteBytes,
    reference: insertionPasteReference,
  });
  screenshots.push(await capture("packaged-editor-attachment-paste-preview-light.png"));
  await confirmAttachmentInsert({
    sourceNotePath: insertionPasteNotePath,
    expectedNote: insertionPasteReference,
    targetPath: insertionPasteTargetPath,
    bytes: insertionPasteBytes,
  });

  await openEditorNote(insertionDropNotePath);
  await setTheme("dark");
  const rejectedEditorDrop = await dispatchRejectedEditorDrop(
    [externalInsertionDropPath, externalDropPath],
    1,
  );
  assert(
    rejectedEditorDrop?.dispatched &&
      rejectedEditorDrop.owned &&
      rejectedEditorDrop.sameDocument &&
      !rejectedEditorDrop.dialogOpen &&
      rejectedEditorDrop.editorPresent &&
      rejectedEditorDrop.active !== "true" &&
      rejectedEditorDrop.toast.includes("Insert one file at a time"),
    `A refused multi-file editor drop escaped its owned boundary: ${JSON.stringify(rejectedEditorDrop)}`,
  );
  assert(
    (await fs.readFile(path.join(vaultPath, insertionDropNotePath), "utf8")) ===
      insertionDropNote &&
      !(await fs
        .stat(path.join(vaultPath, insertionDropTargetPath))
        .then(() => true)
        .catch(() => false)),
    "The multi-file editor drop refusal mutated the note or attachment namespace.",
  );
  const darkEditorDrag = await beginEditorFileDrag([externalInsertionDropPath], 1);
  screenshots.push(await capture("packaged-editor-attachment-drop-target-dark.png"));
  await cancelFileDrag(darkEditorDrag);
  await setTheme("light");
  const lightEditorDrag = await beginEditorFileDrag([externalInsertionDropPath], 1);
  screenshots.push(await capture("packaged-editor-attachment-drop-target-light.png"));
  await finishFileDrop(lightEditorDrag);
  await waitForAttachmentInsertDialog(
    "The trusted CDP file drop did not reach the editor attachment workbench.",
  );
  await assertAttachmentInsertWorkbench({
    sourceNotePath: insertionDropNotePath,
    sourceFileName: insertionDropFileName,
    targetPath: insertionDropTargetPath,
    bytes: insertionDropBytes,
    reference: insertionDropReference,
  });
  assert(
    (await fs.readFile(path.join(vaultPath, insertionDropNotePath), "utf8")) ===
      insertionDropNote &&
      !(await fs
        .stat(path.join(vaultPath, insertionDropTargetPath))
        .then(() => true)
        .catch(() => false)),
    "The editor drop preview mutated the note or published bytes before confirmation.",
  );
  screenshots.push(await capture("packaged-editor-attachment-drop-preview-light.png"));
  await confirmAttachmentInsert({
    sourceNotePath: insertionDropNotePath,
    expectedNote: `before\n${insertionDropReference}after\n`,
    targetPath: insertionDropTargetPath,
    bytes: insertionDropBytes,
  });
  await setTheme("dark");
  screenshots.push(await capture("packaged-editor-attachment-inserted-dark.png"));
  await setTheme("light");
  screenshots.push(await capture("packaged-editor-attachment-inserted-light.png"));
  assert(
    rendererErrors.length === 0,
    `The packaged attachment workflow emitted renderer errors: ${JSON.stringify(rendererErrors)}`,
  );

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
      attachmentRename: true,
      attachmentRelink: true,
      attachmentRestore: true,
      unsupportedDropRefusal: true,
      multiFileDropRefusal: true,
      attachmentDropRestore: true,
      attachmentPasteRestore: true,
      editorAttachmentPasteInsert: true,
      editorAttachmentDropInsert: true,
      editorAttachmentMultiFileRefusal: true,
      unsupportedExternalInput: true,
      nativeAttachmentOpen: true,
      nativeAttachmentRevealDispatch: true,
      canvasReferenceRewrite: true,
      unsafeCanvasBlocker: true,
      changedPixels,
      restoreChangedPixels,
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
