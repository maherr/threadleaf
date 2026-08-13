import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";
import {
  appRoot,
  cachePath,
  readCommunityManifest,
  sha256,
  verifyCommunityCache,
} from "./community-theme-fixture.mjs";

const fixtureRoot = path.join(appRoot, "fixtures", "vaults", "visual-regression");
const electronPath = path.join(appRoot, "node_modules", ".bin", "electron");
const baselineRoot = path.join(appRoot, "visual", "community-baselines");
const requiredVisual = process.env.THREADLEAF_VISUAL_REQUIRED === "1";
const updateRequested =
  process.argv.includes("--update") || process.env.THREADLEAF_VISUAL_UPDATE === "1";
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const output = [];
let child;
let childExit;
let cdp;
let testRoot;
let runOutput;
let networkRequests = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
    if (message.method === "Network.requestWillBeSent") {
      networkRequests.push(message.params.request.url);
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
  assert(width > 0 && height > 0, `${label} has no dimensions.`);
  assert(
    bitDepth === 8 && (colourType === 6 || colourType === 2),
    `${label} uses unsupported PNG encoding.`,
  );
  const channels = colourType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  assert(raw.length === (stride + 1) * height, `${label} has an unexpected scanline size.`);
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
  return { width, height, pixels: rgba };
}

function compareImages(candidate, baseline) {
  assert(
    candidate.width === baseline.width && candidate.height === baseline.height,
    `Capture dimensions differ: ${candidate.width}x${candidate.height} versus ${baseline.width}x${baseline.height}.`,
  );
  let samples = 0;
  let changed = 0;
  let total = 0;
  const stride = Math.max(1, Math.ceil(Math.sqrt((candidate.width * candidate.height) / 160_000)));
  for (let y = 0; y < candidate.height; y += stride) {
    for (let x = 0; x < candidate.width; x += stride) {
      const index = (y * candidate.width + x) * 4;
      const difference =
        Math.abs(candidate.pixels[index] - baseline.pixels[index]) +
        Math.abs(candidate.pixels[index + 1] - baseline.pixels[index + 1]) +
        Math.abs(candidate.pixels[index + 2] - baseline.pixels[index + 2]);
      total += difference / 3 / 255;
      samples += 1;
      if (difference >= 24) changed += 1;
    }
  }
  return {
    meanAbsoluteRgb: total / Math.max(1, samples),
    changedPixelRatio: changed / Math.max(1, samples),
  };
}

function parseCssColor(value) {
  const numbers = value.match(/-?(?:\d*\.\d+|\d+)(?:e[+-]?\d+)?/giu)?.map(Number) ?? [];
  if (value.startsWith("color(srgb") && numbers.length >= 3) return numbers.slice(0, 3);
  if ((value.startsWith("rgb") || value.startsWith("rgba")) && numbers.length >= 3) {
    return numbers.slice(0, 3).map((channel) => channel / 255);
  }
  return null;
}

function contrastRatio(left, right) {
  const luminance = (colour) => {
    const linear = colour.map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const a = luminance(left);
  const b = luminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function deuteranomaly(colour, matrix) {
  return matrix.map((row) =>
    Math.max(
      0,
      Math.min(
        1,
        row.reduce((sum, coefficient, index) => sum + coefficient * colour[index], 0),
      ),
    ),
  );
}

// Machado 2009 deutan simulation matrices at moderate (0.6) and stress (0.8) severity.
const deutanMatrices = [
  [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
];

function assertDeuteranomalyCue(probe) {
  const focus = parseCssColor(probe.focus.color);
  const background = parseCssColor(probe.focus.backgroundColor);
  assert(
    focus && background,
    `Focus cue colors were not parseable: ${JSON.stringify(probe.focus)}`,
  );
  assert(
    probe.focus.outlineStyle !== "none" && probe.focus.outlineWidth >= 2,
    "Focus cue lost its non-color outline.",
  );
  const ratios = deutanMatrices.map((matrix) =>
    contrastRatio(deuteranomaly(focus, matrix), deuteranomaly(background, matrix)),
  );
  assert(
    Math.min(...ratios) >= 1.5,
    `Focus cue is too weak under deuteranomaly: ${ratios.join(", ")}`,
  );
  assert(probe.active.ariaCurrent === "page", "Active file state lost aria-current semantics.");
  assert(
    probe.active.glyph && probe.active.glyph.trim().length > 0,
    "Active file state lost its shape/text cue.",
  );
  assert(
    probe.active.borderStyle !== probe.inactive.borderStyle ||
      probe.active.borderWidth !== probe.inactive.borderWidth ||
      probe.active.ariaCurrent !== probe.inactive.ariaCurrent,
    "Active file state has no non-color distinction from an inactive row.",
  );
  return { stressRatios: ratios, focusColor: focus, backgroundColor: background };
}

async function launch(theme, cacheRoot) {
  testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-community-theme-"));
  runOutput = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-community-theme-captures-"));
  const vaultPath = path.join(testRoot, "vault");
  const userDataPath = path.join(testRoot, "user-data");
  await fs.cp(fixtureRoot, vaultPath, { recursive: true });
  const themePath = path.join(vaultPath, ".obsidian", "themes", theme.folder);
  await fs.mkdir(themePath, { recursive: true });
  for (const filename of ["theme.css", "manifest.json"]) {
    await fs.copyFile(cachePath(cacheRoot, theme.id, filename), path.join(themePath, filename));
  }
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
  await cdp.send("Network.enable");
  const expectedPath = await fs.realpath(vaultPath);
  await waitFor(
    async () => {
      const snapshot = await evaluate("window.threadleaf.getSnapshot()");
      return snapshot?.workspace?.state === "ready" && snapshot.vault?.path === expectedPath
        ? snapshot
        : null;
    },
    `Fixture did not become ready for ${theme.id}`,
    20_000,
  );
  await assertIsolatedX11Renderer();
  return { vaultPath, themePath };
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
    "Renderer escaped explicit X11 argv.",
  );
  assert(
    lines.every((line) => !line.includes("--ozone-platform=wayland")),
    "Renderer selected Wayland.",
  );
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

async function openSettings() {
  await evaluate("document.querySelector('#settings-trigger')?.click(); true");
  await waitFor(
    async () =>
      (await evaluate("document.querySelector('#shortcut-settings')?.open === true")) ? true : null,
    "Settings did not open",
  );
}

async function closeSettings() {
  await waitFor(
    async () =>
      (await evaluate("document.querySelector('#settings-close')?.disabled === false"))
        ? true
        : null,
    "Settings close control remained busy",
  );
  await evaluate("document.querySelector('#settings-close')?.click(); true");
  await waitFor(
    async () =>
      (await evaluate("document.querySelector('#shortcut-settings')?.open !== true")) ? true : null,
    "Settings did not close",
  );
}

async function setControlValue(selector, value) {
  const changed = await evaluate(`(() => {
    const control = document.querySelector(${JSON.stringify(selector)});
    if (!(control instanceof HTMLSelectElement || control instanceof HTMLInputElement)) return false;
    control.value = ${JSON.stringify(value)};
    control.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  assert(changed, `Missing control ${selector}`);
  await waitFor(
    async () =>
      (await evaluate(`document.querySelector(${JSON.stringify(selector)})?.value`)) === value,
    `Control ${selector} did not commit ${value}`,
  );
}

async function applyTheme(theme) {
  await openSettings();
  const themeId = `obsidian-theme:${encodeURIComponent(theme.folder)}`;
  const themeOptionSelector = `#appearance-theme option[value=${JSON.stringify(themeId)}]`;
  await waitFor(
    async () =>
      (await evaluate(`Boolean(document.querySelector(${JSON.stringify(themeOptionSelector)}))`))
        ? true
        : null,
    `Theme ${theme.name} was not exposed by the appearance catalog`,
  );
  await setControlValue("#appearance-theme", themeId);
  let lastAppearance;
  await waitFor(
    async () => {
      const appearance = await evaluate(
        "(async () => { const snapshot = await window.threadleaf.getSnapshot(); return window.threadleaf.getAppearance(snapshot.vault.id); })()",
      );
      lastAppearance = appearance;
      if (appearance?.status === "ready" && appearance.appearance.activeThemeId !== themeId) {
        if (appearance.appearance.warnings.length > 0) {
          throw new Error(
            `Theme ${theme.name} loader warnings: ${appearance.appearance.warnings.join(" | ")}`,
          );
        }
      }
      return appearance?.status === "ready" &&
        appearance.appearance.activeThemeId === themeId &&
        appearance.appearance.css.length > 1000
        ? appearance.appearance
        : null;
    },
    `Theme ${theme.name} did not load through the contained appearance loader: ${JSON.stringify(lastAppearance)}`,
    15_000,
  );
  const source = await fs.readFile(cachePath(currentCacheRoot, theme.id, "theme.css"), "utf8");
  assert(!/@import\b/iu.test(source), `${theme.name} contains a forbidden @import.`);
  assert(!/url\(\s*["']?https?:/iu.test(source), `${theme.name} contains a direct remote URL.`);
  await closeSettings();
  return { themeId };
}

async function setScheme(scheme) {
  await openSettings();
  await evaluate(`document.querySelector('#scheme-${scheme}')?.click(); true`);
  await waitFor(
    async () => (await evaluate("document.documentElement.dataset.theme")) === scheme,
    `Color scheme did not become ${scheme}`,
  );
  await closeSettings();
}

async function setHighContrast(enabled) {
  await openSettings();
  await evaluate("document.querySelector('#settings-nav-accessibility')?.click(); true");
  await waitFor(
    async () =>
      (await evaluate(
        "document.querySelector('[data-settings-page=accessibility]')?.hidden === false",
      ))
        ? true
        : null,
    "Accessibility settings did not open",
  );
  await setControlValue("#accessibility-high-contrast", enabled ? "on" : "system");
  await waitFor(
    async () =>
      (await evaluate("document.documentElement.dataset.threadleafHighContrast")) ===
      String(enabled),
    `High contrast did not become ${enabled}`,
  );
  await closeSettings();
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
  await delay(100);
}

async function probeCues() {
  const probe = await evaluate(`(() => {
    const active = document.querySelector('#file-list [aria-current="page"]');
    const inactive = [...document.querySelectorAll('#file-list .file-item')].find((candidate) => candidate !== active);
    const input = document.querySelector('#file-search');
    if (!(active instanceof HTMLElement) || !(inactive instanceof HTMLElement) || !(input instanceof HTMLElement)) return null;
    input.focus({ focusVisible: true });
    const style = (element) => {
      const computed = getComputedStyle(element);
      return {
        backgroundColor: computed.backgroundColor,
        borderStyle: computed.borderLeftStyle,
        borderWidth: computed.borderLeftWidth,
        color: computed.color,
      };
    };
    const focusStyle = getComputedStyle(input);
    let focusBackground = focusStyle.backgroundColor;
    if (focusBackground === "rgba(0, 0, 0, 0)" || focusBackground === "transparent") {
      for (const selector of [".app-frame", "#main-content", "body", "html"]) {
        const candidate = document.querySelector(selector);
        if (!(candidate instanceof HTMLElement)) continue;
        const background = getComputedStyle(candidate).backgroundColor;
        if (background !== "rgba(0, 0, 0, 0)" && background !== "transparent") {
          focusBackground = background;
          break;
        }
      }
    }
    return {
      active: { ...style(active), ariaCurrent: active.getAttribute('aria-current'), glyph: active.querySelector('.file-glyph')?.textContent ?? '' },
      inactive: { ...style(inactive), ariaCurrent: inactive.getAttribute('aria-current') },
      focus: { color: focusStyle.outlineColor, backgroundColor: focusBackground, outlineStyle: focusStyle.outlineStyle, outlineWidth: Number.parseFloat(focusStyle.outlineWidth) || 0 },
    };
  })()`);
  assert(probe, "Could not locate the file navigation and focus probe controls.");
  return { probe, audit: assertDeuteranomalyCue(probe) };
}

async function capture(theme, caseId, outputName) {
  const result = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const bytes = Buffer.from(result.data, "base64");
  assert(bytes.length > 1024, `Capture ${outputName} is unexpectedly small.`);
  const image = decodePng(bytes, `capture ${outputName}`);
  await fs.writeFile(path.join(runOutput, outputName), bytes);
  return { bytes, image, path: path.join(runOutput, outputName), key: `${theme.id}:${caseId}` };
}

async function runTheme(theme, cacheRoot, baselineManifest) {
  networkRequests = [];
  const captures = [];
  const audits = [];
  await launch(theme, cacheRoot);
  try {
    const snapshot = await evaluate("window.threadleaf.getSnapshot()");
    assert(snapshot?.vault?.id, `Theme ${theme.id} fixture has no vault id.`);
    await applyTheme(theme);
    const themeCases = currentManifest.cases.filter((testCase) => testCase.theme === theme.id);
    assert(
      themeCases.length === 4,
      `Theme ${theme.id} does not have the four committed matrix cases.`,
    );
    for (const testCase of themeCases) {
      await setScheme(testCase.scheme);
      await setHighContrast(Boolean(testCase.highContrast));
      const viewport = currentManifest.viewports.find(
        (candidate) => candidate.id === testCase.viewport,
      );
      assert(viewport, `Missing viewport ${testCase.viewport}.`);
      await setViewport(viewport);
      const audit = await probeCues();
      audits.push({ case: testCase.id, ...audit.audit });
      const outputName = `${theme.id}-${testCase.id}.png`;
      captures.push(await capture(theme, testCase.id, outputName));
    }
    const externalRequests = networkRequests.filter((url) => /^https?:/iu.test(url));
    assert(
      externalRequests.length === 0,
      `Theme ${theme.id} made remote runtime requests: ${externalRequests.join(", ")}`,
    );
    for (const captureResult of captures) {
      const baseline = baselineManifest.cases?.[captureResult.key];
      const baselinePath = path.join(
        baselineRoot,
        baseline?.path ?? `${captureResult.key.replace(":", "-")}.png`,
      );
      if (updateRequested) {
        await fs.mkdir(path.dirname(baselinePath), { recursive: true });
        await fs.copyFile(captureResult.path, baselinePath);
        baselineManifest.cases[captureResult.key] = {
          path: path.relative(baselineRoot, baselinePath),
          sha256: sha256(captureResult.bytes),
          dimensions: [captureResult.image.width, captureResult.image.height],
        };
        continue;
      }
      assert(
        baselinePath,
        `No committed baseline for ${captureResult.key}. Run with THREADLEAF_VISUAL_UPDATE=1.`,
      );
      const baselineBytes = await fs.readFile(baselinePath);
      assert(
        sha256(baselineBytes) === baseline.sha256,
        `Baseline hash mismatch for ${captureResult.key}.`,
      );
      const comparison = compareImages(
        captureResult.image,
        decodePng(baselineBytes, `baseline ${captureResult.key}`),
      );
      assert(
        comparison.meanAbsoluteRgb <= 0.012 && comparison.changedPixelRatio <= 0.08,
        `Community theme visual drift ${captureResult.key}: ${JSON.stringify(comparison)}`,
      );
    }
    return { captures: captures.length, audits };
  } finally {
    await closeApplication();
    const cleanupPaths = [testRoot, runOutput].filter(Boolean);
    testRoot = undefined;
    runOutput = undefined;
    await Promise.all(
      cleanupPaths.map((cleanupPath) => fs.rm(cleanupPath, { recursive: true, force: true })),
    );
  }
}

let currentManifest;
let currentCacheRoot;

async function assertStaticManifest(manifest) {
  assert(manifest.schemaVersion === 1, "Community theme manifest schema is unsupported.");
  assert(manifest.renderer.display === "xvfb-x11", "Community theme matrix must pin Xvfb X11.");
  assert(
    manifest.cache.networkPolicy === "acquisition-only",
    "Community theme acquisition must be explicit.",
  );
  assert(
    manifest.cache.runtimeNetwork === "forbidden",
    "Community theme runtime network policy drifted.",
  );
  assert(
    manifest.themes.length >= 3 && manifest.themes.length <= 5,
    "Community theme matrix is not a small representative set.",
  );
  assert(Array.isArray(manifest.cases), "Community theme matrix has no explicit cases.");
  const themeIds = new Set(manifest.themes.map((theme) => theme.id));
  for (const testCase of manifest.cases) {
    assert(themeIds.has(testCase.theme), `Case ${testCase.id} references an unknown theme.`);
    assert(
      ["dark", "light"].includes(testCase.scheme),
      `Case ${testCase.id} has an invalid scheme.`,
    );
    assert(
      ["laptop", "minimum"].includes(testCase.viewport),
      `Case ${testCase.id} has an invalid viewport.`,
    );
  }
  for (const themeId of themeIds) {
    assert(
      manifest.cases.filter((testCase) => testCase.theme === themeId).length === 4,
      `Theme ${themeId} must have four explicit visual cases.`,
    );
  }
  for (const theme of manifest.themes) {
    assert(/^[a-z0-9-]+$/u.test(theme.id), `Invalid community theme id ${theme.id}.`);
    assert(
      /^[0-9a-f]{40}$/u.test(theme.commit),
      `Theme ${theme.id} is not pinned to a full commit.`,
    );
    assert(theme.license === "MIT", `Theme ${theme.id} is not in the permissive MIT set.`);
    assert(
      theme.files.some((file) => file.path === "theme.css"),
      `Theme ${theme.id} has no CSS receipt.`,
    );
    assert(
      theme.files.some((file) => file.path.startsWith("LICENSE")),
      `Theme ${theme.id} has no license receipt.`,
    );
    for (const file of theme.files) {
      assert(
        /^[a-f0-9]{64}$/u.test(file.sha256),
        `Theme ${theme.id}/${file.path} has no SHA-256 receipt.`,
      );
      assert(
        /^https:\/\/raw\.githubusercontent\.com\//u.test(file.url),
        `Theme ${theme.id}/${file.path} is not acquired from its pinned raw URL.`,
      );
    }
  }
}

async function main() {
  currentManifest = await readCommunityManifest();
  await assertStaticManifest(currentManifest);
  currentCacheRoot = (await verifyCommunityCache(currentManifest)).cacheRoot;
  const verification = await verifyCommunityCache(currentManifest, currentCacheRoot);
  if (!verification.complete) {
    const message =
      `COMMUNITY_THEME_VISUAL_SKIP cache incomplete: ${verification.missing.join(", ")}. ` +
      "Run `pnpm community-theme:acquire` to opt in to network acquisition.";
    process.stderr.write(`${message}\n`);
    if (requiredVisual) process.exitCode = 1;
    return;
  }
  if (!(await commandAvailable("xvfb-run"))) {
    const message = "COMMUNITY_THEME_VISUAL_SKIP xvfb-run is unavailable.";
    process.stderr.write(`${message}\n`);
    if (requiredVisual) process.exitCode = 1;
    return;
  }
  assert(await fs.stat(electronPath), "Electron executable is missing; run pnpm install.");
  const baselineManifestPath = path.join(baselineRoot, "manifest.v1.json");
  let baselineManifest;
  try {
    baselineManifest = await readJson(baselineManifestPath);
  } catch (error) {
    if (!updateRequested) throw error;
    baselineManifest = { schemaVersion: 1, matrix: currentManifest.id, cases: {} };
  }
  assert(baselineManifest.schemaVersion === 1, "Community theme baseline schema is unsupported.");
  assert(
    baselineManifest.matrix === currentManifest.id,
    "Community theme baseline matrix drifted.",
  );
  for (const theme of currentManifest.themes) {
    const result = await runTheme(theme, currentCacheRoot, baselineManifest);
    process.stdout.write(
      `COMMUNITY_THEME_VISUAL_PASS ${theme.id} cases=${result.captures} deutan=${JSON.stringify(result.audits)}\n`,
    );
  }
  if (updateRequested) {
    await fs.mkdir(baselineRoot, { recursive: true });
    await fs.writeFile(
      baselineManifestPath,
      `${JSON.stringify({ ...baselineManifest, generatedBy: "scripts/check-community-theme-matrix.mjs --update" }, null, 2)}\n`,
      "utf8",
    );
    process.stdout.write(`COMMUNITY_THEME_VISUAL_BASELINES_UPDATED ${baselineManifestPath}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(
    `COMMUNITY_THEME_VISUAL_FAIL ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
