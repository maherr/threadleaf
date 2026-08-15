import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";

const appRoot = process.cwd();
const matrixPath = path.join(appRoot, "visual", "matrix.v1.json");
const regionsPath = path.join(appRoot, "visual", "regions.v1.json");
const baselineRoot = path.join(appRoot, "visual", "baselines");
const electronPath = path.join(appRoot, "node_modules", ".bin", "electron");
const fixtureRoot = path.join(appRoot, "fixtures", "vaults", "visual-regression");
const args = new Set(process.argv.slice(2));
const integrityOnly = args.has("--integrity-only");
const positiveControl = args.has("--positive-control");
const redControl = args.has("--red-control") || process.env.THREADLEAF_VISUAL_RED_CONTROL === "1";
const updateRequested = args.has("--update") || process.env.THREADLEAF_VISUAL_UPDATE === "1";
const requiredVisual = process.env.THREADLEAF_VISUAL_REQUIRED === "1";
const runStartedAt = Date.now();

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const output = [];
let child;
let childExit;
let cdp;
let testRoot;
let runOutput;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string", "Could not reserve a loopback CDP port.");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function commandAvailable(command) {
  const probe = spawn(command, ["--help"], { stdio: "ignore" });
  return new Promise((resolve) => {
    probe.once("error", () => resolve(false));
    probe.once("exit", () => resolve(true));
  });
}

async function collectFixtureFiles(rootPath) {
  const files = [];
  async function visit(current, relative = "") {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      const entryRelative = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) {
        await visit(entryPath, entryRelative);
      } else if (entry.isFile()) {
        const bytes = await fs.readFile(entryPath);
        files.push({ path: entryRelative.split(path.sep).join("/"), sha256: sha256(bytes) });
      }
    }
  }
  await visit(rootPath);
  return files;
}

function fixtureTreeHash(files) {
  return sha256(files.map((file) => `${file.path}\0${file.sha256}\n`).join(""));
}

function validateViewport(viewport) {
  assert(
    Number.isInteger(viewport.width) && viewport.width >= 860,
    `Invalid viewport width: ${viewport.id}`,
  );
  assert(
    Number.isInteger(viewport.height) && viewport.height >= 640,
    `Invalid viewport height: ${viewport.id}`,
  );
  assert(
    Number.isFinite(viewport.deviceScaleFactor) && viewport.deviceScaleFactor >= 1,
    `Invalid device scale: ${viewport.id}`,
  );
  assert(Number.isFinite(viewport.zoom) && viewport.zoom > 0, `Invalid zoom: ${viewport.id}`);
}

function validateRegion(region, threshold) {
  for (const key of ["x", "y", "width", "height"]) {
    assert(Number.isFinite(region[key]), `Region ${region.id} has invalid ${key}.`);
  }
  assert(
    region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0,
    `Region ${region.id} has invalid bounds.`,
  );
  assert(
    region.x + region.width <= 1 && region.y + region.height <= 1,
    `Region ${region.id} escapes normalized capture bounds.`,
  );
  const maskArea = (region.masks ?? []).reduce((area, mask) => area + mask.width * mask.height, 0);
  assert(
    maskArea <= region.width * region.height * 0.15,
    `Region ${region.id} masks more than 15% of its area.`,
  );
  assert(threshold.maxMeanAbsoluteRgb < 0.5, `Region ${region.id} has a blanket visual tolerance.`);
}

async function validateIntegrity(matrix, regionManifest, environment) {
  assert(matrix.schemaVersion === 1, "Visual matrix schema version is unsupported.");
  assert(regionManifest.schemaVersion === 1, "Visual region schema version is unsupported.");
  assert(matrix.renderer.display === "xvfb-x11", "Visual matrix must pin the Xvfb X11 display.");
  assert(
    environment.schemaVersion === 1,
    "Visual environment metadata schema version is unsupported.",
  );
  assert(environment.platform === "linux-x64", "Visual environment metadata must pin Linux x64.");
  assert(
    environment.electron === matrix.renderer.electron,
    "Visual environment Electron version does not match the matrix.",
  );
  assert(
    environment.display.server === "Xvfb" && environment.display.compositor === "X11",
    "Visual environment is not pinned to Xvfb X11.",
  );
  assert(
    environment.display.electronArgv.includes("--ozone-platform=x11"),
    "Visual environment does not pin explicit X11 Electron argv.",
  );
  assert(
    environment.capture.captureBeyondViewport === false && environment.capture.fromSurface === true,
    "Visual capture metadata permits full-page or non-surface captures.",
  );
  assert(
    environment.fonts.networkFetch === false && environment.fonts.proprietaryAssets === false,
    "Visual environment permits unpinned external or proprietary assets.",
  );
  assert(
    matrix.renderer.window.width === 1180 && matrix.renderer.window.height === 820,
    "The ordinary laptop viewport drifted.",
  );
  const viewportIds = new Set();
  for (const viewport of matrix.viewports) {
    validateViewport(viewport);
    assert(!viewportIds.has(viewport.id), `Duplicate viewport id: ${viewport.id}`);
    viewportIds.add(viewport.id);
  }
  const caseIds = new Set();
  const screenshots = new Set();
  for (const testCase of matrix.cases) {
    assert(!caseIds.has(testCase.id), `Duplicate visual case id: ${testCase.id}`);
    caseIds.add(testCase.id);
    assert(
      viewportIds.has(testCase.viewport),
      `Case ${testCase.id} references an unknown viewport.`,
    );
    assert(
      matrix.themes.includes(testCase.theme),
      `Case ${testCase.id} references an unknown theme.`,
    );
    assert(
      !screenshots.has(testCase.screenshot),
      `Duplicate screenshot name: ${testCase.screenshot}`,
    );
    screenshots.add(testCase.screenshot);
    const definition = regionManifest.cases[testCase.id];
    assert(definition, `Case ${testCase.id} has no region definition.`);
    assert(
      Array.isArray(definition.requiredSelectors) && definition.requiredSelectors.length > 0,
      `Case ${testCase.id} has no structural selectors.`,
    );
    assert(
      Array.isArray(definition.regions) && definition.regions.length > 0,
      `Case ${testCase.id} has no perceptual regions.`,
    );
    for (const region of definition.regions) {
      validateRegion(region, { ...regionManifest.defaultThreshold, ...(region.threshold ?? {}) });
    }
  }
  for (const unsupported of matrix.unsupported) {
    assert(
      typeof unsupported.reason === "string" && unsupported.reason.trim(),
      `Unsupported case ${unsupported.id} has no reason.`,
    );
    assert(
      !caseIds.has(unsupported.id),
      `Unsupported case ${unsupported.id} is also marked supported.`,
    );
  }
  const fixtureFiles = await collectFixtureFiles(fixtureRoot);
  const fixtureNames = new Set(fixtureFiles.map((file) => file.path));
  for (const required of matrix.fixture.requiredFiles) {
    assert(fixtureNames.has(required), `Visual fixture is missing ${required}.`);
  }
  assert(matrix.fixture.treeSha256 !== "TO_BE_FILLED", "Visual fixture tree hash is not pinned.");
  assert(
    fixtureTreeHash(fixtureFiles) === matrix.fixture.treeSha256,
    "Visual fixture bytes drifted from the pinned tree hash.",
  );
  const baselineManifestPath = path.join(baselineRoot, "manifest.v1.json");
  let baselineManifest;
  try {
    baselineManifest = await readJson(baselineManifestPath);
  } catch (error) {
    if (!updateRequested) throw error;
    baselineManifest = {
      schemaVersion: 1,
      renderer: { electron: matrix.renderer.electron },
      fixtureTreeSha256: matrix.fixture.treeSha256,
      cases: {},
    };
  }
  assert(baselineManifest.schemaVersion === 1, "Visual baseline schema version is unsupported.");
  assert(
    baselineManifest.renderer?.electron === matrix.renderer.electron,
    "Baseline Electron version does not match the matrix.",
  );
  assert(
    baselineManifest.fixtureTreeSha256 === matrix.fixture.treeSha256,
    "Baseline fixture hash does not match the matrix.",
  );
  const environmentSha256 = sha256(JSON.stringify(environment));
  if (!updateRequested) {
    assert(
      baselineManifest.environmentSha256 === environmentSha256,
      "Baseline environment metadata drifted.",
    );
  }
  if (!updateRequested) {
    for (const testCase of matrix.cases) {
      const baseline = baselineManifest.cases?.[testCase.id];
      assert(baseline, `Baseline is missing case ${testCase.id}.`);
      assert(baseline.path === testCase.screenshot, `Baseline path drifted for ${testCase.id}.`);
      const baselinePath = path.join(baselineRoot, baseline.path);
      const bytes = await fs.readFile(baselinePath);
      assert(bytes.length > 1024, `Baseline ${testCase.id} is unexpectedly small.`);
      assert(sha256(bytes) === baseline.sha256, `Baseline hash mismatch for ${testCase.id}.`);
      const image = decodePng(bytes, `baseline ${testCase.id}`);
      assert(image.width > 0 && image.height > 0, `Baseline ${testCase.id} has no dimensions.`);
      assert(
        image.nonTransparentPixels > image.width * image.height * 0.05,
        `Baseline ${testCase.id} is blank.`,
      );
    }
  }
  return { fixtureFiles, baselineManifest };
}

function decodePng(bytes, label) {
  assert(
    Buffer.isBuffer(bytes) && bytes.subarray(0, 8).equals(PNG_SIGNATURE),
    `${label} is not a PNG.`,
  );
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  const idat = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    assert(dataEnd + 4 <= bytes.length, `${label} has a truncated PNG chunk.`);
    if (type === "IHDR") {
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      bitDepth = bytes[dataStart + 8];
      colourType = bytes[dataStart + 9];
    } else if (type === "IDAT") {
      idat.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }
  assert(width > 0 && height > 0, `${label} has no IHDR dimensions.`);
  assert(
    bitDepth === 8 && (colourType === 6 || colourType === 2),
    `${label} uses unsupported PNG encoding.`,
  );
  const channels = colourType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  assert(raw.length === (stride + 1) * height, `${label} has an unexpected PNG scanline size.`);
  const rgba = Buffer.alloc(width * height * 4);
  let sourceOffset = 0;
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[sourceOffset++];
    const row = Buffer.from(raw.subarray(sourceOffset, sourceOffset + stride));
    sourceOffset += stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? row[x - channels] : 0;
      const above = previous[x] ?? 0;
      const upperLeft = x >= channels ? (previous[x - channels] ?? 0) : 0;
      if (filter === 1) row[x] = (row[x] + left) & 255;
      else if (filter === 2) row[x] = (row[x] + above) & 255;
      else if (filter === 3) row[x] = (row[x] + Math.floor((left + above) / 2)) & 255;
      else if (filter === 4) {
        const p = left + above - upperLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - above);
        const pc = Math.abs(p - upperLeft);
        row[x] = (row[x] + (pa <= pb && pa <= pc ? left : pb <= pc ? above : upperLeft)) & 255;
      } else assert(filter === 0, `${label} uses an unsupported PNG filter.`);
    }
    for (let x = 0; x < width; x += 1) {
      const source = x * channels;
      const target = (y * width + x) * 4;
      rgba[target] = row[source];
      rgba[target + 1] = row[source + 1];
      rgba[target + 2] = row[source + 2];
      rgba[target + 3] = colourType === 6 ? row[source + 3] : 255;
    }
    previous = row;
  }
  let nonTransparentPixels = 0;
  for (let index = 3; index < rgba.length; index += 4) {
    if (rgba[index] > 0) nonTransparentPixels += 1;
  }
  return { width, height, pixels: rgba, nonTransparentPixels };
}

function regionBounds(image, region) {
  const x = Math.max(0, Math.min(image.width - 1, Math.floor(region.x * image.width)));
  const y = Math.max(0, Math.min(image.height - 1, Math.floor(region.y * image.height)));
  const right = Math.max(
    x + 1,
    Math.min(image.width, Math.ceil((region.x + region.width) * image.width)),
  );
  const bottom = Math.max(
    y + 1,
    Math.min(image.height, Math.ceil((region.y + region.height) * image.height)),
  );
  return { x, y, width: right - x, height: bottom - y };
}

function compareRegion(candidate, baseline, region, threshold) {
  assert(
    candidate.width === baseline.width && candidate.height === baseline.height,
    `Capture dimensions differ: ${candidate.width}x${candidate.height} versus ${baseline.width}x${baseline.height}.`,
  );
  const bounds = regionBounds(candidate, region);
  let samples = 0;
  let changedPixels = 0;
  let totalDifference = 0;
  const stride = Math.max(1, Math.ceil(Math.sqrt((bounds.width * bounds.height) / 160_000)));
  for (let y = bounds.y; y < bounds.y + bounds.height; y += stride) {
    for (let x = bounds.x; x < bounds.x + bounds.width; x += stride) {
      const index = (y * candidate.width + x) * 4;
      const difference =
        Math.abs(candidate.pixels[index] - baseline.pixels[index]) +
        Math.abs(candidate.pixels[index + 1] - baseline.pixels[index + 1]) +
        Math.abs(candidate.pixels[index + 2] - baseline.pixels[index + 2]);
      totalDifference += difference / 3;
      samples += 1;
      if (difference >= threshold.changedPixelDelta) changedPixels += 1;
    }
  }
  const meanAbsoluteRgb = samples ? totalDifference / samples / 255 : 1;
  const changedPixelRatio = samples ? changedPixels / samples : 1;
  return {
    pass:
      meanAbsoluteRgb <= threshold.maxMeanAbsoluteRgb &&
      changedPixelRatio <= threshold.maxChangedPixelRatio,
    meanAbsoluteRgb,
    changedPixelRatio,
    samples,
  };
}

async function connectTarget(port, deadline) {
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
      // Electron is still starting.
    }
    await delay(50);
  }
  throw new Error("Electron did not expose its main renderer CDP target.");
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
      const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method, params }));
      return response;
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
    if (last) return last;
    await delay(50);
  }
  throw new Error(`${message}. Last observation: ${JSON.stringify(last)}`);
}

async function descendantRendererCommandLines(rootPid) {
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
        pid: Number(entry.name),
        parent: Number(/^PPid:\s+(\d+)$/m.exec(status)?.[1] ?? -1),
        commandLine: commandLine.toString("utf8").replaceAll("\0", " "),
      });
    } catch {
      // A short-lived process disappeared while reading /proc.
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
  const lines = await waitFor(async () => {
    const commandLines = await descendantRendererCommandLines(child.pid);
    return commandLines.length ? commandLines : null;
  }, "The isolated Electron launch did not expose a renderer process");
  assert(
    lines.every((line) => line.includes("--ozone-platform=x11")),
    "A renderer escaped the explicit X11 argv contract.",
  );
  assert(
    lines.every((line) => !line.includes("--ozone-platform=wayland")),
    "A renderer selected Wayland despite the X11 contract.",
  );
  return lines;
}

async function targetCenter(selector) {
  const target = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return { error: "missing" };
    const root = element.closest("button, [role=button], input, select") ?? element;
    const rect = root.getBoundingClientRect();
    const style = getComputedStyle(root);
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      error: null,
      x,
      y,
      width: rect.width,
      height: rect.height,
      hidden: root.hidden || style.display === "none" || style.visibility === "hidden",
      disabled: root instanceof HTMLButtonElement || root instanceof HTMLInputElement || root instanceof HTMLSelectElement ? root.disabled : false,
      hit: Boolean(hit && (hit === root || root.contains(hit))),
      hitTag: hit?.tagName ?? null,
      hitId: hit?.id ?? null,
      rootTag: root.tagName,
      rootId: root.id,
      rootPointerEvents: getComputedStyle(root).pointerEvents,
    };
  })()`);
  assert(target && !target.error, `Pointer target is unavailable: ${selector}`);
  assert(
    !target.hidden && !target.disabled,
    `Pointer target is not interactive: ${selector}: ${JSON.stringify(target)}`,
  );
  assert(
    target.width > 0 && target.height > 0 && target.hit,
    `Pointer target is covered or has no geometry: ${selector}: ${JSON.stringify(target)}`,
  );
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

async function scrollSelectorIntoView(selector) {
  const scrolled = await evaluate(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!(target instanceof HTMLElement)) return false;
    target.scrollIntoView({ block: "center", inline: "nearest" });
    return true;
  })()`);
  assert(scrolled, `Could not scroll missing selector into view: ${selector}`);
}

const keyCodes = {
  ArrowDown: 40,
  Backspace: 8,
  Escape: 27,
  Enter: 13,
};

async function pressKey(key, code, modifiers = 0) {
  const windowsVirtualKeyCode =
    keyCodes[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : undefined);
  for (const type of ["keyDown", "keyUp"]) {
    await cdp.send("Input.dispatchKeyEvent", {
      type,
      code,
      key,
      modifiers,
      windowsVirtualKeyCode,
    });
  }
}

async function selectNextOption(selector, expectedValue) {
  await clickSelector(selector);
  await pressKey("ArrowDown", "ArrowDown");
  await pressKey("Enter", "Enter");
  await waitFor(
    async () =>
      (await evaluate(`document.querySelector(${JSON.stringify(selector)})?.value`)) ===
      expectedValue,
    `Control ${selector} did not commit ${expectedValue}`,
  );
}

async function capture(name) {
  const result = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const destination = path.join(runOutput, `${name}.png`);
  const bytes = Buffer.from(result.data, "base64");
  assert(bytes.length > 1024, `Capture ${name} is unexpectedly small.`);
  const image = decodePng(bytes, `capture ${name}`);
  assert(
    image.nonTransparentPixels > image.width * image.height * 0.05,
    `Capture ${name} is blank.`,
  );
  await fs.writeFile(destination, bytes);
  const stat = await fs.stat(destination);
  assert(stat.mtimeMs >= runStartedAt, `Capture ${name} is stale.`);
  return { path: destination, bytes, image };
}

async function setTheme(theme) {
  const current = await evaluate("document.documentElement.dataset.theme");
  if (current !== theme) {
    await evaluate("document.querySelector('#theme-toggle')?.click(); true");
    await waitFor(
      async () => (await evaluate("document.documentElement.dataset.theme")) === theme,
      `Theme did not become ${theme}`,
    );
  }
}

async function setViewport(viewport) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor,
    mobile: false,
  });
  await waitFor(async () => {
    const dimensions = await evaluate(
      "({ width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio })",
    );
    return dimensions.width === viewport.width && dimensions.height === viewport.height
      ? dimensions
      : null;
  }, `Viewport ${viewport.id} did not apply`);
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: viewport.zoom });
  await delay(80);
}

async function clearViewport() {
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
}

async function openNote(notePath) {
  await clickSelector(navigatorNoteSelector(notePath));
  await waitFor(
    async () =>
      (await evaluate("document.querySelector('#note-path')?.textContent ?? ''")) === notePath,
    `Note ${notePath} did not open`,
  );
}

function navigatorNoteSelector(notePath) {
  const pathSelector = JSON.stringify(notePath);
  return [
    `#file-list[data-mode="tree"] [data-tree-path=${pathSelector}]`,
    `#file-list:not([data-mode="tree"]) [data-note-path=${pathSelector}]`,
  ].join(", ");
}

async function runPaletteCommand(commandId) {
  await clickSelector("#command-trigger");
  await waitFor(
    async () =>
      (await evaluate("document.querySelector('#command-palette')?.open === true")) ? true : null,
    "Command palette did not open",
  );
  await cdp.send("Input.insertText", { text: commandId });
  const selector = `[data-command-id=${JSON.stringify(commandId)}]`;
  await waitFor(
    async () =>
      (await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`))
        ? true
        : null,
    `Command palette did not expose ${commandId}`,
  );
  await clickSelector(selector);
}

async function closeOpenDialogs() {
  await evaluate(`(() => {
    for (const selector of ["#command-palette", "#shortcut-settings", "#graph-dialog", "#recovery-dialog"]) {
      const dialog = document.querySelector(selector);
      if (dialog?.open) dialog.close();
    }
    return true;
  })()`);
  await delay(50);
}

async function clearAllTabs() {
  const snapshot = await evaluate("window.threadleaf.getSnapshot()");
  const vaultId = snapshot?.vault?.id;
  assert(
    typeof vaultId === "string" && vaultId.length > 0,
    "The visual fixture has no vault identity for tab cleanup.",
  );
  const tabs = snapshot.workspace?.panes?.find((pane) => pane.id === "primary")?.tabs ?? [];
  for (const tab of tabs.filter((candidate) => candidate.pinned)) {
    await evaluate(
      `window.threadleaf.toggleTabPin(${JSON.stringify(tab.path)}, "primary", ${JSON.stringify(vaultId)})`,
    );
  }
  for (const tab of tabs) {
    await evaluate(
      `window.threadleaf.closeNote(${JSON.stringify(tab.path)}, ${JSON.stringify(vaultId)}, "primary")`,
    );
  }
  await delay(200);
  const remaining = await evaluate(`(async () => ({
    count: document.querySelectorAll('#workspace-pane-primary .note-tab').length,
    paths: [...document.querySelectorAll('#workspace-pane-primary .note-tab')].map((tab) => tab.textContent),
    snapshot: (await window.threadleaf.getSnapshot()).workspace?.panes?.map((pane) => ({ id: pane.id, tabs: pane.tabs.map((tab) => ({ path: tab.path, pinned: tab.pinned, active: tab.active })) })),
  }))()`);
  assert(
    remaining.count === 0,
    `Could not clear the visual fixture tabs for the empty state: ${JSON.stringify(remaining)}`,
  );
}

async function structuralSnapshot(testCase, regionDefinition) {
  const result = await evaluate(`(() => {
    const required = ${JSON.stringify(regionDefinition.requiredSelectors)};
    const visible = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement) && !(element instanceof SVGElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return !element.hidden && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const overflow = [...document.querySelectorAll("#main-content, #file-list, #note-view, #note-editor-shell, #note-preview, #shortcut-settings, #graph-dialog, #recovery-dialog")]
      .filter((element) => element instanceof HTMLElement)
      .map((element) => ({ id: element.id, overflow: element.scrollWidth - element.clientWidth }))
      .filter((entry) => entry.overflow > 1);
    return {
      url: location.href,
      title: document.title,
      theme: document.documentElement.dataset.theme,
      viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio },
      required: Object.fromEntries(required.map((selector) => [selector, visible(selector)])),
      overflow,
      openDialogs: [...document.querySelectorAll("dialog[open]")].map((dialog) => dialog.id),
      bodyTextLength: document.body.textContent?.length ?? 0,
    };
  })()`);
  for (const [selector, present] of Object.entries(result.required)) {
    assert(present, `Case ${testCase.id} is missing visible selector ${selector}.`);
  }
  assert(
    result.overflow.length === 0,
    `Case ${testCase.id} overflowed: ${JSON.stringify(result.overflow)}`,
  );
  assert(
    result.bodyTextLength > 80,
    `Case ${testCase.id} rendered an unexpectedly empty document.`,
  );
  return result;
}

async function launch() {
  testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-visual-regression-"));
  const vaultPath = path.join(testRoot, "vault");
  const userDataPath = path.join(testRoot, "user-data");
  await fs.cp(fixtureRoot, vaultPath, { recursive: true });
  await fs.mkdir(path.join(vaultPath, ".trash", "Recovered"), { recursive: true });
  await fs.writeFile(
    path.join(vaultPath, ".trash", "Recovered", "02 Empty Note.md"),
    "# Recovered empty note\n\nRecovery fixture.\n",
    "utf8",
  );
  await fs.mkdir(userDataPath, { recursive: true });
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
  childExit = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      output.push(String(chunk));
      if (output.length > 120) output.shift();
    });
  }
  const target = await connectTarget(port, Date.now() + 15_000);
  cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await waitFor(
    async () => {
      const snapshot = await evaluate("window.threadleaf.getSnapshot()");
      return snapshot?.workspace?.state === "ready" &&
        snapshot.vault?.path === (await fs.realpath(vaultPath))
        ? snapshot
        : null;
    },
    "Visual fixture did not become ready",
    20_000,
  );
  await assertIsolatedX11Renderer();
  return { vaultPath, userDataPath };
}

async function closeApplication() {
  try {
    await evaluate("setTimeout(() => window.close(), 0); true");
  } catch {
    // The renderer may already be gone after a failed capture.
  }
  cdp?.close();
  cdp = undefined;
  if (childExit) {
    const result = await Promise.race([
      childExit,
      delay(8_000).then(() => ({ code: null, signal: "timeout" })),
    ]);
    if (result.code !== 0)
      throw new Error(
        `Electron did not exit cleanly: ${JSON.stringify(result)}\n${output.join("")}`,
      );
  }
  child = undefined;
  childExit = undefined;
}

async function captureCase(matrixCase, matrix, regionManifest, captures, structural) {
  const viewport = matrix.viewports.find((candidate) => candidate.id === matrixCase.viewport);
  assert(viewport, `Case ${matrixCase.id} references a missing viewport.`);
  await setViewport(viewport);
  await setTheme(matrixCase.theme);
  const definition = regionManifest.cases[matrixCase.id];
  const state = await structuralSnapshot(matrixCase, definition);
  const captured = await capture(matrixCase.id);
  captures[matrixCase.id] = { ...captured, matrixCase, definition, viewport };
  structural[matrixCase.id] = state;
}

async function runVisualCases(matrix, regionManifest) {
  runOutput = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-visual-captures-"));
  const captures = {};
  const structural = {};
  try {
    await launch();
    await openNote("00 Overview.md");
    await setTheme("dark");
    await captureCase(
      matrix.cases.find((testCase) => testCase.id === "workspace-live-dark"),
      matrix,
      regionManifest,
      captures,
      structural,
    );
    await setTheme("light");
    await clickSelector("#source-view");
    await waitFor(
      async () =>
        (await evaluate("document.querySelector('#source-view')?.getAttribute('aria-pressed')")) ===
        "true",
      "Source view did not become active",
    );
    await captureCase(
      matrix.cases.find((testCase) => testCase.id === "workspace-source-light"),
      matrix,
      regionManifest,
      captures,
      structural,
    );
    await clickSelector("#read-view");
    await waitFor(
      async () =>
        (await evaluate("document.querySelector('#read-view')?.getAttribute('aria-pressed')")) ===
        "true",
      "Reading view did not become active",
    );
    await captureCase(
      matrix.cases.find((testCase) => testCase.id === "workspace-reading-light"),
      matrix,
      regionManifest,
      captures,
      structural,
    );

    await setTheme("dark");
    await closeOpenDialogs();
    await evaluate("document.querySelector('#settings-trigger')?.click(); true");
    await waitFor(
      async () =>
        (await evaluate("document.querySelector('#shortcut-settings')?.open === true"))
          ? true
          : null,
      "Settings did not open",
    );
    await captureCase(
      matrix.cases.find((testCase) => testCase.id === "settings-appearance-dark"),
      matrix,
      regionManifest,
      captures,
      structural,
    );
    await setTheme("light");
    await clickSelector("#settings-nav-plugins");
    await waitFor(
      async () =>
        (await evaluate(
          "document.querySelector('[data-settings-page=\"plugins\"]')?.hidden === false",
        ))
          ? true
          : null,
      "Plugin settings did not open",
    );
    await captureCase(
      matrix.cases.find((testCase) => testCase.id === "settings-plugin-diagnostics-light"),
      matrix,
      regionManifest,
      captures,
      structural,
    );

    await setTheme("dark");
    await clickSelector("#settings-nav-accessibility");
    await waitFor(
      async () =>
        (await evaluate(
          "document.querySelector('[data-settings-page=\"accessibility\"]')?.hidden === false",
        ))
          ? true
          : null,
      "Accessibility settings did not open",
    );
    for (const selector of [
      "#accessibility-high-contrast",
      "#accessibility-reduced-motion",
      "#accessibility-reduced-transparency",
    ]) {
      await selectNextOption(selector, "on");
      await waitFor(
        async () =>
          (await evaluate("document.querySelector('#accessibility-status')?.textContent")) ===
          "Accessibility preferences saved.",
        `Accessibility preference ${selector} did not report a durable save`,
      );
    }
    await waitFor(
      async () =>
        (
          await evaluate(`(() => ({
          highContrast: document.documentElement.dataset.threadleafHighContrast,
          reducedMotion: document.documentElement.dataset.threadleafReducedMotion,
          reducedTransparency: document.documentElement.dataset.threadleafReducedTransparency,
        }))()`)
        ).highContrast === "true" &&
        (await evaluate("document.documentElement.dataset.threadleafReducedMotion")) === "true" &&
        (await evaluate("document.documentElement.dataset.threadleafReducedTransparency")) ===
          "true",
      "Explicit accessibility preferences did not reach live root attributes",
    );
    await evaluate(`(() => {
      const content = document.querySelector('.settings-content');
      if (!(content instanceof HTMLElement)) return false;
      content.scrollTop = 0;
      return true;
    })()`);
    await captureCase(
      matrix.cases.find((testCase) => testCase.id === "accessibility-high-contrast-dark"),
      matrix,
      regionManifest,
      captures,
      structural,
    );
    await scrollSelectorIntoView("#accessibility-reset");
    await clickSelector("#accessibility-reset");
    await waitFor(
      async () =>
        (await evaluate("document.querySelector('#accessibility-status')?.textContent")) ===
        "Accessibility preferences reset to system defaults.",
      "Accessibility preferences did not reset after their isolated capture",
    );
    await waitFor(async () => {
      const state = await evaluate(`(() => ({
          controls: [
            document.querySelector('#accessibility-high-contrast')?.value,
            document.querySelector('#accessibility-reduced-motion')?.value,
            document.querySelector('#accessibility-reduced-transparency')?.value,
          ],
          highContrast: document.documentElement.dataset.threadleafHighContrast,
          reducedMotion: document.documentElement.dataset.threadleafReducedMotion,
          reducedTransparency: document.documentElement.dataset.threadleafReducedTransparency,
        }))()`);
      return (
        state.controls.every((value) => value === "system") &&
        state.highContrast === "false" &&
        state.reducedMotion === "false" &&
        state.reducedTransparency === "false"
      );
    }, "Accessibility capture overrides leaked into later visual cases");
    await clickSelector("#settings-close");

    await setTheme("light");
    await evaluate("document.querySelector('#command-trigger')?.click(); true");
    await waitFor(
      async () =>
        (await evaluate("document.querySelector('#command-palette')?.open === true")) ? true : null,
      "Command palette did not open",
    );
    await captureCase(
      matrix.cases.find((testCase) => testCase.id === "command-palette-light"),
      matrix,
      regionManifest,
      captures,
      structural,
    );
    await pressKey("Escape", "Escape");

    await setTheme("dark");
    await openNote("01 Linked Note.md");
    await openNote("00 Overview.md");
    const pinBefore = await evaluate(`(() => ({
      count: document.querySelectorAll('.note-tab-pin').length,
      target: document.querySelector('.note-tab-pin[data-note-path="00 Overview.md"]')?.outerHTML ?? null,
      tabs: [...document.querySelectorAll('.note-tab')].map((tab) => tab.getAttribute('data-note-path')),
    }))()`);
    assert(
      pinBefore.count > 0 && pinBefore.target,
      `Pinned-tab target was not rendered: ${JSON.stringify(pinBefore)}`,
    );
    await evaluate(
      "document.querySelector('.note-tab-pin[data-note-path=\"00 Overview.md\"]')?.click(); true",
    );
    await delay(100);
    const pinAfter = await evaluate(`(() => {
      const pin = document.querySelector('.note-tab-pin[data-note-path="00 Overview.md"]');
      return {
        pinned: pin?.dataset.pinned ?? null,
        pinText: pin?.textContent ?? null,
        pinDisabled: pin?.disabled ?? null,
        tabHtml: pin?.closest('.note-tab')?.outerHTML ?? null,
        pinHtml: pin?.outerHTML ?? null,
        pinParent: pin?.parentElement?.outerHTML ?? null,
      };
    })()`);
    assert(
      pinAfter.pinned === "true",
      `Pinned tab did not become visible: ${JSON.stringify(pinAfter)}`,
    );
    await clickSelector("#split-pane-right");
    await waitFor(
      async () =>
        (await evaluate("document.querySelector('#workspace-pane-secondary')?.hidden === false"))
          ? true
          : null,
      "Split pane did not open",
    );
    await captureCase(
      matrix.cases.find((testCase) => testCase.id === "split-pinned-dark"),
      matrix,
      regionManifest,
      captures,
      structural,
    );
    await evaluate("document.querySelector('#close-pane-secondary')?.click(); true");
    await waitFor(
      async () =>
        (await evaluate("document.querySelector('#workspace-pane-secondary')?.hidden === true"))
          ? true
          : null,
      "Split pane did not close",
    );
    await closeOpenDialogs();

    await runPaletteCommand("workspace.open-graph-view");
    await waitFor(
      async () =>
        (await evaluate("document.querySelector('#graph-dialog')?.open === true")) ? true : null,
      "Graph dialog did not open",
    );
    await waitFor(
      async () =>
        (await evaluate("document.querySelectorAll('.graph-node').length")) >= 3 ? true : null,
      "Graph did not render fixture nodes",
    );
    await captureCase(
      matrix.cases.find((testCase) => testCase.id === "graph-dark"),
      matrix,
      regionManifest,
      captures,
      structural,
    );
    await pressKey("Escape", "Escape");

    await setTheme("light");
    await runPaletteCommand("workspace.open-file-recovery");
    await waitFor(
      async () =>
        (await evaluate("document.querySelector('#recovery-dialog')?.open === true")) ? true : null,
      "Recovery dialog did not open",
    );
    await waitFor(
      async () =>
        (await evaluate("document.querySelectorAll('.recovery-row').length")) >= 1 ? true : null,
      "Recovery fixture did not render a row",
    );
    await captureCase(
      matrix.cases.find((testCase) => testCase.id === "recovery-light"),
      matrix,
      regionManifest,
      captures,
      structural,
    );
    await pressKey("Escape", "Escape");

    await clearAllTabs();
    await setTheme("light");
    await waitFor(
      async () =>
        (await evaluate("document.querySelector('#note-empty')?.hidden === false")) ? true : null,
      "Empty note state did not render",
    );
    await captureCase(
      matrix.cases.find((testCase) => testCase.id === "empty-note-light"),
      matrix,
      regionManifest,
      captures,
      structural,
    );

    await openNote("03 Missing Target.md");
    await setTheme("dark");
    await waitFor(
      async () =>
        (await evaluate(
          "document.querySelector('#outgoing-list')?.textContent?.includes('No Such Note')",
        ))
          ? true
          : null,
      "Missing-link diagnostic did not render",
    );
    await captureCase(
      matrix.cases.find((testCase) => testCase.id === "missing-link-dark"),
      matrix,
      regionManifest,
      captures,
      structural,
    );

    await openNote("04 Long Text.md");
    await setTheme("dark");
    await clickSelector("#read-view");
    await waitFor(
      async () =>
        (await evaluate("document.querySelector('#note-preview')?.hidden === false")) ? true : null,
      "Long note reading view did not render",
    );
    await captureCase(
      matrix.cases.find((testCase) => testCase.id === "long-text-dark"),
      matrix,
      regionManifest,
      captures,
      structural,
    );

    await setTheme("light");
    await setViewport(matrix.viewports.find((viewport) => viewport.id === "minimum"));
    await openNote("00 Overview.md");
    await captureCase(
      matrix.cases.find((testCase) => testCase.id === "minimum-light"),
      matrix,
      regionManifest,
      captures,
      structural,
    );

    await setTheme("dark");
    await setViewport(matrix.viewports.find((viewport) => viewport.id === "high-dpi"));
    await captureCase(
      matrix.cases.find((testCase) => testCase.id === "high-dpi-dark"),
      matrix,
      regionManifest,
      captures,
      structural,
    );

    await setTheme("light");
    await setViewport(matrix.viewports.find((viewport) => viewport.id === "zoom-125"));
    await captureCase(
      matrix.cases.find((testCase) => testCase.id === "zoom-125-light"),
      matrix,
      regionManifest,
      captures,
      structural,
    );
  } finally {
    await clearViewport().catch(() => undefined);
    await closeApplication().catch((error) => output.push(`Close error: ${String(error)}\n`));
    await fs.rm(testRoot, { recursive: true, force: true });
  }
  return { captures, structural, runOutput };
}

async function compareVisuals(matrix, regionManifest, baselineManifest, result, shouldUpdate) {
  const observed = {};
  for (const testCase of matrix.cases) {
    const capture = result.captures[testCase.id];
    assert(capture, `Visual run did not produce case ${testCase.id}.`);
    const candidateBytes = await fs.readFile(capture.path);
    const candidateImage = decodePng(candidateBytes, `candidate ${testCase.id}`);
    const baseline = baselineManifest.cases?.[testCase.id];
    const baselinePath = path.join(baselineRoot, baseline?.path ?? testCase.screenshot);
    if (shouldUpdate) {
      await fs.copyFile(capture.path, baselinePath);
    } else {
      assert(baseline, `No baseline metadata for ${testCase.id}.`);
      const baselineImage = decodePng(await fs.readFile(baselinePath), `baseline ${testCase.id}`);
      const definition = regionManifest.cases[testCase.id];
      const thresholdBase = regionManifest.defaultThreshold;
      const regions = {};
      for (const region of definition.regions) {
        const threshold = { ...thresholdBase, ...(region.threshold ?? {}) };
        const comparison = compareRegion(candidateImage, baselineImage, region, threshold);
        regions[region.id] = comparison;
        assert(
          comparison.pass,
          `Visual region ${testCase.id}/${region.id} exceeded threshold: ${JSON.stringify(comparison)}`,
        );
      }
      observed[testCase.id] = {
        sha256: sha256(candidateBytes),
        dimensions: [candidateImage.width, candidateImage.height],
        regions,
      };
    }
  }
  return observed;
}

async function writeBaselineManifest(matrix, environment, result) {
  await fs.mkdir(baselineRoot, { recursive: true });
  const cases = {};
  for (const testCase of matrix.cases) {
    const capture = result.captures[testCase.id];
    const bytes = await fs.readFile(capture.path);
    cases[testCase.id] = {
      path: testCase.screenshot,
      sha256: sha256(bytes),
      dimensions: [capture.image.width, capture.image.height],
    };
  }
  await fs.writeFile(
    path.join(baselineRoot, "manifest.v1.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        renderer: {
          electron: matrix.renderer.electron,
          nodeMajor: matrix.renderer.nodeMajor,
          display: matrix.renderer.display,
        },
        fixtureTreeSha256: matrix.fixture.treeSha256,
        environmentSha256: sha256(JSON.stringify(environment)),
        generatedBy: "scripts/check-visual-regression.mjs --update",
        cases,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function runPositiveControl(matrix, regionManifest, baselineManifest) {
  const firstCase = matrix.cases[0];
  const baseline = baselineManifest.cases[firstCase.id];
  const image = decodePng(
    await fs.readFile(path.join(baselineRoot, baseline.path)),
    `baseline ${firstCase.id}`,
  );
  const tampered = { ...image, pixels: Buffer.from(image.pixels) };
  const region = regionManifest.cases[firstCase.id].regions[0];
  const bounds = regionBounds(tampered, region);
  for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) {
    for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
      const index = (y * tampered.width + x) * 4;
      tampered.pixels[index] = 255;
      tampered.pixels[index + 1] = 0;
      tampered.pixels[index + 2] = 255;
    }
  }
  const comparison = compareRegion(tampered, image, region, regionManifest.defaultThreshold);
  assert(!comparison.pass, `Positive control was not rejected: ${JSON.stringify(comparison)}`);
  console.log(
    `VISUAL_POSITIVE_CONTROL PASS: ${firstCase.id}/${region.id} rejected a tampered region (${JSON.stringify(comparison)})`,
  );
}

async function skipLoudly(reason) {
  const message = `VISUAL_SKIP: ${reason}. Integrity and manifest checks passed; no visual verdict was reported.`;
  console.error(message);
  if (requiredVisual) process.exitCode = 1;
}

try {
  const [matrix, regionManifest] = await Promise.all([readJson(matrixPath), readJson(regionsPath)]);
  const environment = await readJson(path.join(appRoot, matrix.environment));
  const integrity = await validateIntegrity(matrix, regionManifest, environment);
  if (integrityOnly) {
    console.log(
      `VISUAL_INTEGRITY PASS: ${matrix.cases.length} cases, ${matrix.unsupported.length} explicit unsupported surfaces, fixture ${matrix.fixture.treeSha256}`,
    );
    for (const unsupported of matrix.unsupported)
      console.log(`VISUAL_UNSUPPORTED ${unsupported.id}: ${unsupported.reason}`);
    if (positiveControl || redControl)
      await runPositiveControl(matrix, regionManifest, integrity.baselineManifest);
    process.exit(0);
  }
  if (positiveControl) {
    await runPositiveControl(matrix, regionManifest, integrity.baselineManifest);
    process.exit(0);
  }
  if (redControl) {
    await runPositiveControl(matrix, regionManifest, integrity.baselineManifest);
    throw new Error(
      "RED_CONTROL_EXPECTED_FAILURE: the known tampered region was rejected by the judge.",
    );
  }
  if (process.platform !== "linux") {
    await skipLoudly("the pinned visual renderer currently requires Linux");
    process.exit(0);
  }
  if (!(await commandAvailable("xvfb-run"))) {
    await skipLoudly("xvfb-run is unavailable");
    process.exit(0);
  }
  try {
    await fs.access(electronPath);
  } catch {
    await skipLoudly("the pinned Electron dependency is unavailable");
    process.exit(0);
  }
  if (updateRequested && process.env.CI === "true") {
    throw new Error("Refusing to update visual baselines in CI.");
  }
  const result = await runVisualCases(matrix, regionManifest);
  if (updateRequested) {
    await compareVisuals(matrix, regionManifest, integrity.baselineManifest, result, true);
    await writeBaselineManifest(matrix, environment, result);
    console.log(`VISUAL_BASELINE_UPDATED: ${matrix.cases.length} screenshots in ${baselineRoot}`);
  } else {
    const observations = await compareVisuals(
      matrix,
      regionManifest,
      integrity.baselineManifest,
      result,
      false,
    );
    console.log(
      `VISUAL_CHECK PASS: ${Object.keys(observations).length} cases compared by structural assertions and region thresholds.`,
    );
  }
  for (const unsupported of matrix.unsupported)
    console.log(`VISUAL_UNSUPPORTED ${unsupported.id}: ${unsupported.reason}`);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  const logs = output.join("").trim();
  console.error(
    logs
      ? `VISUAL_CHECK FAIL: ${detail}\nElectron output:\n${logs}`
      : `VISUAL_CHECK FAIL: ${detail}`,
  );
  process.exitCode = 1;
} finally {
  cdp?.close();
  if (child?.pid && child.exitCode === null) child.kill("SIGKILL");
  if (runOutput) {
    await fs.rm(runOutput, { recursive: true, force: true }).catch(() => undefined);
    runOutput = undefined;
  }
}
