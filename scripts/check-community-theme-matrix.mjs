import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";
import {
  appRoot,
  assertSafeCacheRoot,
  assertValidManifest,
  CACHE_FILE_LIMITS,
  COMMUNITY_FIXTURE_REQUIRED_FILES,
  COMMUNITY_FIXTURE_TREE_SHA256,
  readCommunityCacheFile,
  readCommunityManifest,
  sha256,
  verifyCommunityCache,
} from "./community-theme-fixture.mjs";

const fixtureRoot = path.join(appRoot, "fixtures", "vaults", "visual-regression");
const electronPath = path.join(appRoot, "node_modules", ".bin", "electron");
const baselineRoot = path.join(appRoot, "visual", "community-baselines");
const requiredVisual = process.env.THREADLEAF_VISUAL_REQUIRED === "1";
const args = new Set(process.argv.slice(2));
const integrityOnly = args.has("--integrity-only");
const positiveControl = args.has("--positive-control");
const redControl =
  args.has("--red-control") || process.env.THREADLEAF_COMMUNITY_THEME_RED_CONTROL === "1";
const updateRequested = args.has("--update") || process.env.THREADLEAF_VISUAL_UPDATE === "1";
const CI_MARKERS = Object.freeze(["CI", "GITHUB_ACTIONS", "BUILDKITE", "GITLAB_CI", "JENKINS_URL"]);
const REQUIRED_THEME_CASES = Object.freeze([
  { id: "dark-laptop", scheme: "dark", viewport: "laptop", highContrast: false },
  { id: "light-laptop", scheme: "light", viewport: "laptop", highContrast: false },
  { id: "light-minimum", scheme: "light", viewport: "minimum", highContrast: false },
  { id: "dark-high-contrast", scheme: "dark", viewport: "laptop", highContrast: true },
  { id: "light-high-contrast", scheme: "light", viewport: "laptop", highContrast: true },
]);

function isCiEnvironment(environment = process.env) {
  return CI_MARKERS.some(
    (name) => typeof environment[name] === "string" && environment[name].length > 0,
  );
}

const isCi = isCiEnvironment();
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

async function assertFixtureTree(manifest) {
  const fixtureFiles = await collectFixtureFiles(fixtureRoot);
  const fixtureNames = new Set(fixtureFiles.map((file) => file.path));
  for (const required of COMMUNITY_FIXTURE_REQUIRED_FILES) {
    assert(fixtureNames.has(required), `Community theme fixture is missing ${required}.`);
  }
  assert(
    JSON.stringify(manifest.fixture.requiredFiles) ===
      JSON.stringify(COMMUNITY_FIXTURE_REQUIRED_FILES),
    "Community theme manifest required fixture files drifted.",
  );
  const actualTreeSha256 = fixtureTreeHash(fixtureFiles);
  assert(
    actualTreeSha256 === COMMUNITY_FIXTURE_TREE_SHA256,
    `Community theme fixture bytes drifted from the verified tree: ${actualTreeSha256}.`,
  );
  process.stdout.write(
    `COMMUNITY_THEME_FIXTURE_TREE PASS files=${fixtureFiles.length} sha256=${actualTreeSha256}\n`,
  );
  return actualTreeSha256;
}

function assertCiControls() {
  assert(!isCiEnvironment({}), "CI marker control unexpectedly detected an empty environment.");
  for (const marker of CI_MARKERS) {
    for (const value of ["false", "0", "https://ci.example.test/job/1"]) {
      assert(
        isCiEnvironment({ [marker]: value }),
        `CI marker control did not detect nonempty ${marker}=${value}.`,
      );
    }
  }
  process.stdout.write(`COMMUNITY_THEME_CI_CONTROLS PASS markers=${CI_MARKERS.join(",")}\n`);
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

async function runCommand(command, commandArgs) {
  const processHandle = spawn(command, commandArgs, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  processHandle.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  processHandle.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  return new Promise((resolve) => {
    processHandle.once("error", (error) => resolve({ code: null, stdout, stderr, error }));
    processHandle.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
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

async function assertServedBundleHash(targetUrl) {
  const rendererRoot = path.join(appRoot, "dist", "renderer");
  const html = await fs.readFile(path.join(rendererRoot, "index.html"), "utf8");
  const scripts = [...html.matchAll(/<script[^>]+src="(\.\/assets\/[^" ]+\.js)"/gu)].map(
    ([, source]) => source,
  );
  assert(scripts.length > 0, "Fresh renderer build has no JavaScript bundle receipt.");
  const source = scripts[0];
  const relativeAsset = source.slice("./".length).split("/").join(path.sep);
  const localAsset = path.resolve(rendererRoot, relativeAsset);
  assert(
    path.relative(rendererRoot, localAsset) === relativeAsset,
    `Renderer bundle path escapes the fresh build: ${source}`,
  );
  const localBytes = await fs.readFile(localAsset);
  const expectedHash = sha256(localBytes);
  const expectedUrl = new URL(source, targetUrl).href;
  const resource = await waitFor(async () => {
    const tree = await cdp.send("Page.getResourceTree");
    const resources = tree.frameTree?.resources ?? [];
    return resources.find((candidate) => candidate.url === expectedUrl) ?? null;
  }, `Fresh renderer bundle was not served: ${source}`);
  const frameId = (await cdp.send("Page.getResourceTree")).frameTree?.frame?.id;
  assert(frameId, "Renderer resource tree has no main frame.");
  const content = await cdp.send("Page.getResourceContent", { frameId, url: resource.url });
  const servedBytes = Buffer.from(content.content, content.base64Encoded ? "base64" : "utf8");
  const servedHash = sha256(servedBytes);
  assert(
    servedHash === expectedHash,
    `Served renderer bundle hash drifted from the fresh build: ${servedHash} versus ${expectedHash}.`,
  );
  return { source, sha256: expectedHash };
}

async function assertLiveRuntimeVersions(manifest) {
  const environmentPath = path.join(appRoot, "visual", "environment.v1.json");
  const environment = await readJson(environmentPath);
  assert(
    environment.electron === manifest.renderer.electron &&
      environment.nodeMajor === manifest.renderer.nodeMajor,
    "Pinned community theme renderer and environment metadata disagree.",
  );
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  assert(
    nodeMajor === environment.nodeMajor,
    `Live checker Node ${process.versions.node} is not pinned Node ${environment.nodeMajor}.x.`,
  );
  const electronVersion = await runCommand(electronPath, ["--version"]);
  const reportedElectron = electronVersion.stdout.trim().replace(/^v/u, "");
  assert(
    electronVersion.code === 0 && reportedElectron === environment.electron,
    `Live Electron binary is ${electronVersion.stdout.trim() || electronVersion.stderr.trim()}, expected ${environment.electron}.`,
  );
  const runtime = await evaluate("({ userAgent: navigator.userAgent })");
  assert(
    typeof runtime?.userAgent === "string" &&
      runtime.userAgent.includes(`Electron/${environment.electron}`),
    `Live renderer user agent is not Electron/${environment.electron}: ${runtime?.userAgent ?? "(missing)"}.`,
  );
  process.stdout.write(
    `COMMUNITY_THEME_RUNTIME PASS electron=${environment.electron} node=${process.versions.node}\n`,
  );
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
    };
  })()`);
  assert(target && !target.error, `Pointer target is unavailable: ${selector}`);
  assert(!target.hidden && !target.disabled, `Pointer target is not interactive: ${selector}`);
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

const keyCodes = {
  ArrowDown: 40,
  Enter: 13,
  Escape: 27,
  Home: 36,
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

const deutanMatrices = new Map([
  [
    0.6,
    [
      [0.498864, 0.674741, -0.173604],
      [0.205199, 0.754872, 0.039929],
      [-0.011131, 0.030969, 0.980162],
    ],
  ],
  [
    0.8,
    [
      [0.422823, 0.781057, -0.203881],
      [0.245752, 0.709602, 0.044646],
      [-0.011843, 0.037423, 0.974421],
    ],
  ],
]);

function toLinear(channel) {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function toSrgb(channel) {
  const bounded = Math.max(0, Math.min(1, channel));
  return bounded <= 0.0031308 ? bounded * 12.92 : 1.055 * bounded ** (1 / 2.4) - 0.055;
}

function deuteranomaly(colour, severity) {
  const matrix = deutanMatrices.get(severity);
  assert(matrix, `Unsupported Machado deuteranomaly severity ${severity}.`);
  const linear = colour.map(toLinear);
  return matrix.map((row) =>
    toSrgb(row.reduce((sum, coefficient, index) => sum + coefficient * linear[index], 0)),
  );
}

function lab(colour) {
  const linear = colour.map(toLinear);
  const x = linear[0] * 0.4124564 + linear[1] * 0.3575761 + linear[2] * 0.1804375;
  const y = linear[0] * 0.2126729 + linear[1] * 0.7151522 + linear[2] * 0.072175;
  const z = linear[0] * 0.0193339 + linear[1] * 0.119192 + linear[2] * 0.9503041;
  const f = (value) => (value > 216 / 24389 ? value ** (1 / 3) : (841 / 108) * value + 4 / 29);
  const fx = f(x / 0.95047);
  const fy = f(y);
  const fz = f(z / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function ciede2000(left, right) {
  const [l1, a1, b1] = lab(left);
  const [l2, a2, b2] = lab(right);
  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const cBar = (c1 + c2) / 2;
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1p = Math.hypot(a1p, b1);
  const c2p = Math.hypot(a2p, b2);
  const hue = (a, b) => ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  const h1p = hue(a1p, b1);
  const h2p = hue(a2p, b2);
  const deltaLp = l2 - l1;
  const deltaCp = c2p - c1p;
  let deltaHp;
  if (c1p * c2p === 0) deltaHp = 0;
  else {
    let dh = h2p - h1p;
    if (dh > 180) dh -= 360;
    if (dh < -180) dh += 360;
    deltaHp = 2 * Math.sqrt(c1p * c2p) * Math.sin((dh * Math.PI) / 180 / 2);
  }
  const lBar = (l1 + l2) / 2;
  const cBarP = (c1p + c2p) / 2;
  let hBarP;
  if (c1p * c2p === 0) hBarP = h1p + h2p;
  else {
    const difference = Math.abs(h1p - h2p);
    if (difference <= 180) hBarP = (h1p + h2p) / 2;
    else hBarP = (h1p + h2p + (h1p + h2p < 360 ? 360 : -360)) / 2;
  }
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const t =
    1 -
    0.17 * Math.cos(toRadians(hBarP - 30)) +
    0.24 * Math.cos(toRadians(2 * hBarP)) +
    0.32 * Math.cos(toRadians(3 * hBarP + 6)) -
    0.2 * Math.cos(toRadians(4 * hBarP - 63));
  const deltaTheta = 30 * Math.exp(-(((hBarP - 275) / 25) ** 2));
  const rc = 2 * Math.sqrt(cBarP ** 7 / (cBarP ** 7 + 25 ** 7));
  const sl = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2);
  const sc = 1 + 0.045 * cBarP;
  const sh = 1 + 0.015 * cBarP * t;
  const rt = -Math.sin(toRadians(2 * deltaTheta)) * rc;
  const dl = deltaLp / sl;
  const dc = deltaCp / sc;
  const dh = deltaHp / sh;
  return Math.sqrt(dl ** 2 + dc ** 2 + dh ** 2 + rt * dc * dh);
}

function pairwiseDeutanDistance(left, right) {
  return Object.fromEntries(
    [...deutanMatrices.keys()].map((severity) => [
      severity,
      ciede2000(deuteranomaly(left, severity), deuteranomaly(right, severity)),
    ]),
  );
}

// Workspace deuteranomaly doctrine (root CLAUDE.md): simulate Machado 2009 deutan at 0.6
// moderate / 0.8 stress, then compare CIEDE2000 between every measured pair. A distance below
// CIEDE_FAIL_THRESHOLD is an outright failure. A distance at or above CIEDE_PASS_THRESHOLD is an
// outright pass. Between the two is "thin", a distinct state, neither pass nor fail on its own.
const CIEDE_FAIL_THRESHOLD = 7;
const CIEDE_PASS_THRESHOLD = 11;

function iteratePairs(pairs, category) {
  assert(
    Array.isArray(pairs) && pairs.length >= 2,
    `Fewer than two ${category} colours were measured.`,
  );
  const entries = [];
  for (let leftIndex = 0; leftIndex < pairs.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < pairs.length; rightIndex += 1) {
      const left = pairs[leftIndex];
      const right = pairs[rightIndex];
      assert(left.label && right.label, `${category} pair labels are required.`);
      assert(left.colour && right.colour, `${category} pair colours are required.`);
      const distances = pairwiseDeutanDistance(left.colour, right.colour);
      const minimumDistance = Math.min(...Object.values(distances));
      entries.push({
        left,
        right,
        distances,
        minimumDistance,
        pairLabel: `${left.label}/${right.label}`,
      });
    }
  }
  assert(entries.length > 0, `No ${category} colour pairs were measured.`);
  return entries;
}

function evaluateRedundantCue(cue, forPairLabel) {
  assert(
    cue?.left?.label && cue?.right?.label && cue.left.colour && cue.right.colour,
    `Thin pair ${forPairLabel} declared a redundant cue with no labelled colours.`,
  );
  const distances = pairwiseDeutanDistance(cue.left.colour, cue.right.colour);
  const measuredDe = Math.min(...Object.values(distances));
  return { pair: `${cue.left.label}/${cue.right.label}`, measuredDe };
}

// Categorical roles are the workspace's "strong ink" signals: a plain minimum-7 pass/fail bar,
// unchanged from the original implementation.
function assertCategoricalPairwise(pairs) {
  const entries = iteratePairs(pairs, "categorical");
  for (const entry of entries) {
    assert(
      entry.minimumDistance >= CIEDE_FAIL_THRESHOLD,
      `categorical pair ${entry.pairLabel} has CIEDE2000 ${entry.minimumDistance.toFixed(2)} under ` +
        `Machado deuteranomaly (minimum ${CIEDE_FAIL_THRESHOLD}). Measured colours: ` +
        `${entry.left.label}=${JSON.stringify(entry.left.colour)} ${entry.right.label}=${JSON.stringify(entry.right.colour)}.`,
    );
  }
  return entries.map((entry) => ({
    labels: [entry.left.label, entry.right.label],
    distances: entry.distances,
  }));
}

// Thin-state roles are the workspace's "pale tint" signals and get the full three-tier gate: a
// measurement inside the thin band only passes when the same live case also carries a declared,
// independently-measured redundant cue that itself clears CIEDE_PASS_THRESHOLD. Every such pass
// is returned in thinPasses so callers can record it in the run receipt.
function assertThinStatePairwise(pairs, redundantCues) {
  const entries = iteratePairs(pairs, "thin-state");
  const thinPasses = [];
  for (const entry of entries) {
    assert(
      entry.minimumDistance >= CIEDE_FAIL_THRESHOLD,
      `thin-state pair ${entry.pairLabel} has CIEDE2000 ${entry.minimumDistance.toFixed(2)} under ` +
        `Machado deuteranomaly (fails below ${CIEDE_FAIL_THRESHOLD}). Measured colours: ` +
        `${entry.left.label}=${JSON.stringify(entry.left.colour)} ${entry.right.label}=${JSON.stringify(entry.right.colour)}.`,
    );
    if (entry.minimumDistance >= CIEDE_PASS_THRESHOLD) continue;
    const cue = redundantCues?.[entry.pairLabel];
    assert(
      cue,
      `thin-state pair ${entry.pairLabel} is thin (CIEDE2000 ${entry.minimumDistance.toFixed(2)}, ` +
        `between ${CIEDE_FAIL_THRESHOLD} and ${CIEDE_PASS_THRESHOLD}) with no declared redundant cue.`,
    );
    const redundant = evaluateRedundantCue(cue, entry.pairLabel);
    assert(
      redundant.measuredDe >= CIEDE_PASS_THRESHOLD,
      `thin-state pair ${entry.pairLabel} is thin (CIEDE2000 ${entry.minimumDistance.toFixed(2)}) and ` +
        `its redundant cue ${redundant.pair} only measures ${redundant.measuredDe.toFixed(2)} ` +
        `(needs >= ${CIEDE_PASS_THRESHOLD}).`,
    );
    thinPasses.push({
      pair: entry.pairLabel,
      measuredDe: Number(entry.minimumDistance.toFixed(2)),
      redundantCue: { pair: redundant.pair, measuredDe: Number(redundant.measuredDe.toFixed(2)) },
    });
  }
  return {
    results: entries.map((entry) => ({
      labels: [entry.left.label, entry.right.label],
      distances: entry.distances,
    })),
    thinPasses,
  };
}

function assertColourPairwise(probe) {
  const categorical = assertCategoricalPairwise(probe.categorical);
  const { results: thinState, thinPasses } = assertThinStatePairwise(
    probe.thinState,
    probe.redundantCues,
  );
  return { categorical, thinState, thinPasses };
}

function assertDeuteranomalyCue(probe) {
  const focus = probe.focus.color;
  const background = probe.focus.backgroundColor;
  assert(
    focus && background,
    `Focus cue colors were not parseable: ${JSON.stringify(probe.focus)}`,
  );
  assert(
    probe.focus.outlineStyle !== "none" && probe.focus.outlineWidth >= 2,
    "Focus cue lost its non-color outline.",
  );
  const ratios = [...deutanMatrices.keys()].map((severity) =>
    contrastRatio(deuteranomaly(focus, severity), deuteranomaly(background, severity)),
  );
  assert(
    Math.min(...ratios) >= 1.5,
    `Focus cue is too weak under deuteranomaly: ${ratios.join(", ")}`,
  );
  const colourPairs = assertColourPairwise(probe);
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
  return { stressRatios: ratios, focusColor: focus, backgroundColor: background, colourPairs };
}

function verifiedCacheBytes(verification, themeId, relativePath) {
  const receipt = verification.files?.[themeId]?.[relativePath];
  assert(
    receipt && Buffer.isBuffer(receipt.bytes),
    `Verified cache snapshot is missing ${themeId}/${relativePath}.`,
  );
  assert(
    receipt.byteLength === receipt.bytes.length && sha256(receipt.bytes) === receipt.sha256,
    `Verified cache snapshot changed before copy: ${themeId}/${relativePath}.`,
  );
  return Buffer.from(receipt.bytes);
}

async function atomicWriteBytes(targetPath, bytes) {
  const temporaryPath = `${targetPath}.community-theme-update-${process.pid}`;
  await fs.writeFile(temporaryPath, bytes, { mode: 0o600 });
  await fs.rename(temporaryPath, targetPath);
}

async function launch(theme, verification) {
  testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-community-theme-"));
  runOutput = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-community-theme-captures-"));
  const vaultPath = path.join(testRoot, "vault");
  const userDataPath = path.join(testRoot, "user-data");
  await fs.cp(fixtureRoot, vaultPath, { recursive: true });
  const themePath = path.join(vaultPath, ".obsidian", "themes", theme.folder);
  await fs.mkdir(themePath, { recursive: true });
  for (const filename of ["theme.css", "manifest.json"]) {
    const bytes = verifiedCacheBytes(verification, theme.id, filename);
    await fs.writeFile(path.join(themePath, filename), bytes, { mode: 0o600 });
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
  await assertLiveRuntimeVersions(currentManifest);
  await assertServedBundleHash(target.url);
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
  await clickSelector("#settings-trigger");
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
  await clickSelector("#settings-close");
  await waitFor(
    async () =>
      (await evaluate("document.querySelector('#shortcut-settings')?.open !== true")) ? true : null,
    "Settings did not close",
  );
}

async function setControlValue(selector, value) {
  const optionIndex = await evaluate(`(() => {
    const control = document.querySelector(${JSON.stringify(selector)});
    if (!(control instanceof HTMLSelectElement)) return -1;
    return [...control.options].findIndex((option) => option.value === ${JSON.stringify(value)});
  })()`);
  assert(optionIndex >= 0, `Missing option ${value} in control ${selector}`);
  await clickSelector(selector);
  await pressKey("Home", "Home");
  for (let index = 0; index < optionIndex; index += 1) {
    await pressKey("ArrowDown", "ArrowDown");
  }
  await pressKey("Enter", "Enter");
  await waitFor(
    async () =>
      (await evaluate(`document.querySelector(${JSON.stringify(selector)})?.value`)) === value,
    `Control ${selector} did not commit ${value}`,
  );
}

async function applyTheme(theme, verification) {
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
  const source = verifiedCacheBytes(verification, theme.id, "theme.css").toString("utf8");
  assert(!/@import\b/iu.test(source), `${theme.name} contains a forbidden @import.`);
  assert(!/url\(\s*["']?https?:/iu.test(source), `${theme.name} contains a direct remote URL.`);
  await closeSettings();
  return { themeId };
}

async function setScheme(scheme) {
  await openSettings();
  await clickSelector("#settings-nav-appearance");
  await waitFor(
    async () =>
      (await evaluate(
        "document.querySelector('[data-settings-page=appearance]')?.hidden === false",
      ))
        ? true
        : null,
    "Appearance settings did not open",
  );
  await clickSelector(`#scheme-${scheme}`);
  await waitFor(
    async () => (await evaluate("document.documentElement.dataset.theme")) === scheme,
    `Color scheme did not become ${scheme}`,
  );
  await closeSettings();
}

async function setHighContrast(enabled) {
  await openSettings();
  await clickSelector("#settings-nav-accessibility");
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
  await clickSelector("#file-search");
  const probe = await evaluate(`(() => {
    const parse = (value) => {
      const numbers = value.match(/-?(?:\\d*\\.\\d+|\\d+)(?:e[+-]?\\d+)?/giu)?.map(Number) ?? [];
      if (value.startsWith('color(srgb') && numbers.length >= 3) {
        return [...numbers.slice(0, 3), numbers.length >= 4 ? numbers[3] : 1];
      }
      if ((value.startsWith('rgb') || value.startsWith('rgba')) && numbers.length >= 3) {
        return [numbers[0] / 255, numbers[1] / 255, numbers[2] / 255, numbers.length >= 4 ? numbers[3] : 1];
      }
      return null;
    };
    const over = (foreground, background) => {
      if (!foreground) return background;
      if (!background || foreground[3] >= 0.999) return foreground.slice(0, 3);
      const alpha = Math.max(0, Math.min(1, foreground[3]));
      return foreground.slice(0, 3).map((channel, index) => channel * alpha + background[index] * (1 - alpha));
    };
    const paintedBackground = (element) => {
      const layers = [];
      for (let current = element; current instanceof HTMLElement; current = current.parentElement) {
        const background = parse(getComputedStyle(current).backgroundColor);
        if (background) layers.push(background);
      }
      let result = [1, 1, 1];
      for (const layer of layers.reverse()) result = over(layer, result);
      return result;
    };
    const style = (element) => {
      const computed = getComputedStyle(element);
      const backgroundColor = paintedBackground(element);
      return {
        backgroundColor,
        color: over(parse(computed.color), backgroundColor),
        borderColor: over(parse(computed.borderLeftColor), backgroundColor),
        borderStyle: computed.borderLeftStyle,
        borderWidth: computed.borderLeftWidth,
      };
    };
    const active = document.querySelector('#file-list [aria-current="page"]');
    const inactive = [...document.querySelectorAll('#file-list .file-item')].find((candidate) => candidate !== active);
    const input = document.querySelector('#file-search');
    if (!(active instanceof HTMLElement) || !(inactive instanceof HTMLElement) || !(input instanceof HTMLElement)) return null;
    const focusStyle = getComputedStyle(input);
    const focusBackground = paintedBackground(input);
    const roleSelectors = [
      ['section-heading', '#files-heading', 'color'],
      ['signal-accent', '.toast', 'borderColor'],
    ];
    const roleStyles = roleSelectors.map(([label, selector, property]) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) return null;
      const computed = style(element);
      return { label, colour: computed[property] };
    }).filter((entry) => entry?.colour);
    const activeStyle = style(active);
    const inactiveStyle = style(inactive);
    const controls = [...document.querySelectorAll('button, a, input, select, textarea, [role="button"], [role="tab"], [role="option"]')];
    const accessibleName = (element) => {
      const labelledBy = element.getAttribute('aria-labelledby');
      if (labelledBy) {
        const text = labelledBy.split(/\\s+/u).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
        if (text) return text;
      }
      const aria = element.getAttribute('aria-label')?.trim();
      if (aria) return aria;
      const labels = element.labels?.[0]?.textContent?.trim();
      if (labels) return labels;
      const content = element.textContent?.trim();
      if (content) return content;
      return element.getAttribute('title')?.trim() ?? '';
    };
    return {
      active: { ...activeStyle, ariaCurrent: active.getAttribute('aria-current'), glyph: active.querySelector('.file-glyph')?.textContent ?? '' },
      inactive: { ...inactiveStyle, ariaCurrent: inactive.getAttribute('aria-current') },
      focus: {
        color: over(parse(focusStyle.outlineColor), focusBackground),
        backgroundColor: focusBackground,
        outlineStyle: focusStyle.outlineStyle,
        outlineWidth: Number.parseFloat(focusStyle.outlineWidth) || 0,
      },
      categorical: roleStyles,
      thinState: [
        { label: 'active-file-background', colour: activeStyle.backgroundColor },
        { label: 'inactive-file-background', colour: inactiveStyle.backgroundColor },
      ],
      redundantCues: {
        'active-file-background/inactive-file-background': {
          left: { label: 'active-file-border', colour: activeStyle.borderColor },
          right: { label: 'active-file-background', colour: activeStyle.backgroundColor },
        },
      },
      accessibleNames: controls.filter((element) => !accessibleName(element)).map((element) => ({
        tag: element.tagName.toLowerCase(), id: element.id, role: element.getAttribute('role'),
      })),
    };
  })()`);
  assert(probe, "Could not locate the file navigation and focus probe controls.");
  assert(
    probe.accessibleNames.length === 0,
    `Community theme fixture has unnamed interactive controls: ${JSON.stringify(probe.accessibleNames)}`,
  );
  return { probe, audit: assertDeuteranomalyCue(probe) };
}

async function probeViewportGeometry(viewport) {
  const geometry = await evaluate(`(() => {
    const selectors = ['#file-list', '#main-content', '.note-editor .cm-scroller', '.reading-view'];
    return {
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      body: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
      scrollers: selectors.map((selector) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) return { selector, missing: true };
        const computed = getComputedStyle(element);
        const thumb = getComputedStyle(element, '::-webkit-scrollbar');
        return {
          selector,
          missing: false,
          clientWidth: element.clientWidth,
          offsetWidth: element.offsetWidth,
          clientHeight: element.clientHeight,
          offsetHeight: element.offsetHeight,
          scrollWidth: element.scrollWidth,
          scrollHeight: element.scrollHeight,
          overflowX: computed.overflowX,
          overflowY: computed.overflowY,
          scrollbarGutter: computed.scrollbarGutter,
          scrollbarWidth: computed.scrollbarWidth,
          thumbWidth: thumb.width,
        };
      }),
    };
  })()`);
  assert(
    geometry.viewport.width === viewport.width && geometry.viewport.height === viewport.height,
    `Viewport geometry drifted from the real capture size: ${JSON.stringify(geometry.viewport)}.`,
  );
  assert(
    geometry.body.scrollWidth <= geometry.body.clientWidth,
    `Viewport has horizontal page overflow: ${JSON.stringify(geometry.body)}.`,
  );
  for (const scroller of geometry.scrollers.filter((candidate) => !candidate.missing)) {
    if (scroller.scrollHeight > scroller.clientHeight) {
      assert(
        ["auto", "scroll"].includes(scroller.overflowY),
        `${scroller.selector} clips content without vertical overflow affordance.`,
      );
      assert(
        scroller.offsetWidth >= scroller.clientWidth &&
          (scroller.offsetWidth > scroller.clientWidth ||
            scroller.scrollbarGutter.includes("stable")),
        `${scroller.selector} has no measurable scrollbar gutter: ${JSON.stringify(scroller)}.`,
      );
    }
  }
  const forced = await evaluate(`(() => {
    const host = document.createElement("div");
    const child = document.createElement("div");
    host.style.cssText = "position:fixed;left:-10000px;top:0;width:120px;height:80px;overflow:auto;scrollbar-gutter:stable both-edges;opacity:0;pointer-events:none;";
    child.style.cssText = "width:240px;height:400px;";
    host.append(child);
    document.body.append(host);
    const computed = getComputedStyle(host);
    const thumb = getComputedStyle(host, "::-webkit-scrollbar");
    const result = {
      clientWidth: host.clientWidth,
      offsetWidth: host.offsetWidth,
      clientHeight: host.clientHeight,
      offsetHeight: host.offsetHeight,
      scrollWidth: host.scrollWidth,
      scrollHeight: host.scrollHeight,
      overflowY: computed.overflowY,
      scrollbarGutter: computed.scrollbarGutter,
      scrollbarWidth: computed.scrollbarWidth,
      thumbWidth: thumb.width,
    };
    host.remove();
    return result;
  })()`);
  assert(
    forced.scrollHeight > forced.clientHeight && forced.scrollWidth > forced.clientWidth,
    `Forced overflow control did not create scrollable content: ${JSON.stringify(forced)}.`,
  );
  assert(
    ["auto", "scroll"].includes(forced.overflowY),
    `Forced overflow control lost vertical overflow: ${JSON.stringify(forced)}.`,
  );
  assert(
    forced.scrollbarWidth !== "none" && forced.thumbWidth !== "0px",
    `Forced overflow control has hidden scrollbar geometry: ${JSON.stringify(forced)}.`,
  );
  assert(
    forced.offsetWidth > forced.clientWidth || forced.scrollbarGutter.includes("stable"),
    `Forced overflow control has no measurable gutter: ${JSON.stringify(forced)}.`,
  );
  geometry.forcedOverflow = forced;
  return geometry;
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

async function exerciseThemeWatcher(theme, themePath, verification, themeId) {
  const sourceBytes = verifiedCacheBytes(verification, theme.id, "theme.css");
  const marker = `threadleaf-community-watcher-${theme.id}-${process.pid}`;
  const updatedBytes = Buffer.concat([
    sourceBytes,
    Buffer.from(`\n/* ${marker} */\n:root { --${marker}: 1; }\n`),
  ]);
  const themeCssPath = path.join(themePath, "theme.css");
  await atomicWriteBytes(themeCssPath, updatedBytes);
  await waitFor(
    async () => {
      const appearance = await evaluate(
        "(async () => { const snapshot = await window.threadleaf.getSnapshot(); return window.threadleaf.getAppearance(snapshot.vault.id); })()",
      );
      return appearance?.status === "ready" && appearance.appearance.css.includes(marker)
        ? appearance
        : null;
    },
    `Theme ${theme.name} filesystem watcher did not reload the updated theme.css`,
    15_000,
  );
  await atomicWriteBytes(themeCssPath, sourceBytes);
  await waitFor(
    async () => {
      const appearance = await evaluate(
        "(async () => { const snapshot = await window.threadleaf.getSnapshot(); return window.threadleaf.getAppearance(snapshot.vault.id); })()",
      );
      return appearance?.status === "ready" && !appearance.appearance.css.includes(marker)
        ? appearance
        : null;
    },
    `Theme ${theme.name} filesystem watcher did not reload the restored theme.css`,
    15_000,
  );
  const restoredBytes = await fs.readFile(themeCssPath);
  assert(
    sha256(restoredBytes) === sha256(sourceBytes),
    `Theme ${theme.name} watcher exercise did not restore the verified source bytes.`,
  );
  return { themeId, marker };
}

async function runTheme(theme, verification, baselineManifest) {
  networkRequests = [];
  const captures = [];
  const audits = [];
  try {
    await launch(theme, verification);
    const snapshot = await evaluate("window.threadleaf.getSnapshot()");
    assert(snapshot?.vault?.id, `Theme ${theme.id} fixture has no vault id.`);
    const appearance = await applyTheme(theme, verification);
    await exerciseThemeWatcher(
      theme,
      path.join(snapshot.vault.path, ".obsidian", "themes", theme.folder),
      verification,
      appearance.themeId,
    );
    const themeCases = themeCasesInRequiredOrder(currentManifest, theme.id);
    for (const testCase of themeCases) {
      process.stdout.write(`COMMUNITY_THEME_CASE_START ${theme.id} ${testCase.id}\n`);
      await setScheme(testCase.scheme);
      await setHighContrast(Boolean(testCase.highContrast));
      const viewport = currentManifest.viewports.find(
        (candidate) => candidate.id === testCase.viewport,
      );
      assert(viewport, `Missing viewport ${testCase.viewport}.`);
      await setViewport(viewport);
      const audit = await probeCues();
      for (const thinPass of audit.audit.colourPairs.thinPasses ?? []) {
        process.stdout.write(
          `COMMUNITY_THEME_THIN_PASS ${theme.id} ${testCase.id} pair=${thinPass.pair} ` +
            `dE=${thinPass.measuredDe} redundantCue=${thinPass.redundantCue.pair} ` +
            `redundantDe=${thinPass.redundantCue.measuredDe}\n`,
        );
      }
      const geometry = await probeViewportGeometry(viewport);
      audits.push({ case: testCase.id, ...audit.audit, geometry });
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
      if (updateRequested) {
        const baselinePath = path.join(
          baselineRoot,
          baseline?.path ?? `${captureResult.key.replace(":", "-")}.png`,
        );
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
        baseline && !baseline.pending,
        `No committed baseline for ${captureResult.key}. Dynamic renderer proof is pending; run with THREADLEAF_VISUAL_UPDATE=1.`,
      );
      const baselinePath = path.join(baselineRoot, baseline.path);
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

function assertExactThemeCaseSet(manifest) {
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
    const themeCases = manifest.cases.filter((testCase) => testCase.theme === themeId);
    const ids = new Set(themeCases.map((testCase) => testCase.id));
    assert(ids.size === themeCases.length, `Theme ${themeId} has duplicate matrix case ids.`);
    assert(
      themeCases.length === REQUIRED_THEME_CASES.length,
      `Theme ${themeId} must have exactly the required five visual cases.`,
    );
    for (const expected of REQUIRED_THEME_CASES) {
      const actual = themeCases.find((testCase) => testCase.id === expected.id);
      assert(actual, `Theme ${themeId} is missing required case ${expected.id}.`);
      assert(
        actual.scheme === expected.scheme &&
          actual.viewport === expected.viewport &&
          Boolean(actual.highContrast) === expected.highContrast,
        `Theme ${themeId} case ${expected.id} does not match the required matrix combination.`,
      );
    }
  }
  process.stdout.write(
    `COMMUNITY_THEME_CASE_SET PASS themes=${themeIds.size} casesPerTheme=${REQUIRED_THEME_CASES.length}\n`,
  );
}

function themeCasesInRequiredOrder(manifest, themeId) {
  return REQUIRED_THEME_CASES.map((expected) =>
    manifest.cases.find((testCase) => testCase.theme === themeId && testCase.id === expected.id),
  );
}

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
    manifest.cache.shippedThirdPartyAssets === false,
    "Community theme assets must not be shipped.",
  );
  assertCiControls();
  assert(
    manifest.sourceUpdate?.watcherPath === ".obsidian/themes/<folder>/theme.css" &&
      manifest.sourceUpdate.watcherEvent === "filesystem-event" &&
      manifest.sourceUpdate.reload === "complete-appearance-rescan",
    "Community theme source-update/watcher seam drifted.",
  );
  const checkerSource = await fs.readFile(import.meta.filename, "utf8");
  const forbiddenCaptureFlag = ["--hide", "scrollbars"].join("-");
  assert(
    checkerSource.includes("captureBeyondViewport: false") &&
      !checkerSource.includes(forbiddenCaptureFlag),
    "Community theme captures must stay viewport-bounded with native scrollbar geometry.",
  );
  assert(
    manifest.themes.length >= 3 && manifest.themes.length <= 5,
    "Community theme matrix is not a small representative set.",
  );
  assertExactThemeCaseSet(manifest);
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

function expectedCaseKey(testCase) {
  return `${testCase.theme}:${testCase.id}`;
}

async function assertBaselineIntegrity(manifest, baselineManifest, actualFixtureTreeSha256) {
  assert(baselineManifest?.schemaVersion === 1, "Community theme baseline schema is unsupported.");
  assert(baselineManifest.matrix === manifest.id, "Community theme baseline matrix drifted.");
  assert(
    baselineManifest.fixtureTreeSha256 === actualFixtureTreeSha256 &&
      actualFixtureTreeSha256 === COMMUNITY_FIXTURE_TREE_SHA256,
    "Community theme baselines are not bound to the recomputed fixture tree.",
  );
  assert(
    JSON.stringify(baselineManifest.renderer) === JSON.stringify(manifest.renderer),
    "Community theme baselines are not bound to the pinned renderer environment.",
  );
  const environmentPath = path.resolve(appRoot, baselineManifest.environment?.path ?? "");
  assert(
    environmentPath === path.resolve(appRoot, "visual", "environment.v1.json"),
    "Community theme baseline environment path drifted.",
  );
  const environmentBytes = await fs.readFile(environmentPath);
  assert(
    sha256(environmentBytes) === baselineManifest.environment.sha256,
    "Community theme baseline environment receipt drifted.",
  );
  const sourceReceipts = Object.fromEntries(
    manifest.themes.map((theme) => [
      theme.id,
      Object.fromEntries(theme.files.map((file) => [file.path, file.sha256])),
    ]),
  );
  assert(
    JSON.stringify(baselineManifest.sourceReceipts) === JSON.stringify(sourceReceipts),
    "Community theme baselines are not bound to exact source receipts.",
  );
  const expectedCases = new Map(
    manifest.cases.map((testCase) => [expectedCaseKey(testCase), testCase]),
  );
  const actualKeys = Object.keys(baselineManifest.cases ?? {});
  assert(
    actualKeys.length === expectedCases.size && actualKeys.every((key) => expectedCases.has(key)),
    "Community theme baseline cases do not exactly match the declared matrix.",
  );
  for (const [key, testCase] of expectedCases) {
    const baseline = baselineManifest.cases[key];
    const viewport = manifest.viewports.find((candidate) => candidate.id === testCase.viewport);
    assert(viewport, `Missing viewport ${testCase.viewport} for ${key}.`);
    assert(
      Array.isArray(baseline.dimensions) &&
        baseline.dimensions.length === 2 &&
        baseline.dimensions[0] === viewport.width &&
        baseline.dimensions[1] === viewport.height,
      `Baseline ${key} dimensions do not match declared viewport ${testCase.viewport}.`,
    );
    if (baseline.pending) {
      assert(
        baseline.pending === "dynamic-renderer-proof" && !baseline.path && !baseline.sha256,
        `Baseline ${key} has an invalid pending declaration.`,
      );
      continue;
    }
    assert(
      typeof baseline.path === "string" &&
        !path.isAbsolute(baseline.path) &&
        !baseline.path.split("/").includes("..") &&
        /^[^/]+\.png$/u.test(baseline.path),
      `Baseline ${key} path is not a contained PNG.`,
    );
    assert(
      /^[a-f0-9]{64}$/u.test(baseline.sha256),
      `Baseline ${key} has no exact SHA-256 receipt.`,
    );
    const baselinePath = path.resolve(baselineRoot, baseline.path);
    assert(
      path.relative(baselineRoot, baselinePath) === baseline.path,
      `Baseline ${key} path escapes the baseline root.`,
    );
    const bytes = await fs.readFile(baselinePath);
    assert(sha256(bytes) === baseline.sha256, `Baseline hash mismatch for ${key}.`);
    const image = decodePng(bytes, `baseline ${key}`);
    assert(
      image.width === baseline.dimensions[0] && image.height === baseline.dimensions[1],
      `Baseline ${key} decoded dimensions differ from its declaration.`,
    );
  }
}

// Every theme in the matrix must carry an explicit, structurally-validated live-verification
// status: "verified" (its baselines are proven against a live capture on current main) or
// "pending" with a non-empty reason (a named, tracked gap). This is a distinct axis from
// per-case baseline "pending": a theme can have real, hash-verified PNGs from an earlier capture
// while its live-verification status is still "pending" because nothing has re-proven them
// against the current renderer. An undeclared or malformed status fails loudly rather than
// silently defaulting either way.
function assertLiveVerificationStatus(manifest, baselineManifest) {
  const declared = baselineManifest.liveVerification;
  assert(
    declared && typeof declared === "object" && !Array.isArray(declared),
    "Baseline manifest has no liveVerification status.",
  );
  const verified = [];
  const pending = [];
  for (const theme of manifest.themes) {
    const entry = declared[theme.id];
    assert(
      entry && typeof entry === "object" && !Array.isArray(entry),
      `Theme ${theme.id} has no declared live verification status.`,
    );
    if (entry.status === "verified") {
      verified.push(theme.id);
    } else if (entry.status === "pending") {
      assert(
        typeof entry.reason === "string" && entry.reason.trim().length > 0,
        `Theme ${theme.id} is pending live verification with no reason.`,
      );
      pending.push(theme.id);
    } else {
      throw new Error(
        `Theme ${theme.id} has an unknown live verification status: ${JSON.stringify(entry.status)}.`,
      );
    }
  }
  return { verified, pending, declared };
}

function assertStaticColourControls(manifest) {
  const validColours = {
    categorical: [
      { label: "community:blue", colour: [0.0588, 0.3137, 0.7451] },
      { label: "community:orange", colour: [0.902, 0.4706, 0.0392] },
      { label: "community:teal", colour: [0, 0.6078, 0.4706] },
    ],
    thinState: [
      { label: "community:ink", colour: [0.04, 0.05, 0.06] },
      { label: "community:paper", colour: [0.98, 0.98, 0.96] },
    ],
  };
  assertColourPairwise(validColours);

  // Positive demonstration of the thin tier's success branch: this pair measures inside the
  // thin band (~9.0) on its own, but a declared redundant cue clears the pass threshold
  // (~92.0), so the gate must accept it and record exactly one thin-pass receipt.
  const thinPairLabel = "community:thin-active/community:thin-background";
  const thinWithCue = {
    categorical: validColours.categorical,
    thinState: [
      { label: "community:thin-active", colour: [0.7851, 0.8337, 0.8476] },
      { label: "community:thin-background", colour: [0.945, 0.933, 0.91] },
    ],
    redundantCues: {
      [thinPairLabel]: {
        left: { label: "community:thin-border", colour: [0.05, 0.05, 0.05] },
        right: { label: "community:thin-active", colour: [0.95, 0.95, 0.95] },
      },
    },
  };
  const thinWithCueResult = assertColourPairwise(thinWithCue);
  assert(
    thinWithCueResult.thinPasses.length === 1 &&
      thinWithCueResult.thinPasses[0].pair === thinPairLabel,
    `Thin pair with a valid redundant cue was not recorded as a thin-pass: ${JSON.stringify(thinWithCueResult.thinPasses)}.`,
  );
  process.stdout.write(
    `COMMUNITY_THEME_STATIC_THIN_PASS PASS ${JSON.stringify(thinWithCueResult.thinPasses[0])}\n`,
  );

  // Three independent red controls, one per failure tier the gate can produce.
  const rejectedCases = {
    "categorical below 7": {
      categorical: [
        { label: "community:red-control", colour: [220 / 255, 140 / 255, 80 / 255] },
        { label: "community:green-control", colour: [120 / 255, 180 / 255, 80 / 255] },
      ],
      thinState: validColours.thinState,
    },
    "thin-state below 7": {
      categorical: validColours.categorical,
      thinState: [
        { label: "community:red-control", colour: [220 / 255, 140 / 255, 80 / 255] },
        { label: "community:green-control", colour: [120 / 255, 180 / 255, 80 / 255] },
      ],
    },
    "thin-state 7-11 without a redundant cue": {
      categorical: validColours.categorical,
      thinState: thinWithCue.thinState,
      // redundantCues intentionally omitted: the ~9.0 measurement must fail closed.
    },
  };
  for (const [label, rejected] of Object.entries(rejectedCases)) {
    let rejectedAsExpected = false;
    try {
      assertColourPairwise(rejected);
    } catch (error) {
      rejectedAsExpected = true;
      process.stdout.write(
        `COMMUNITY_THEME_STATIC_RED_CONTROL PASS (${label}) ` +
          `${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    assert(
      rejectedAsExpected,
      `Community theme colour red control did not fail the pairwise gate: ${label}.`,
    );
  }
  process.stdout.write(
    `COMMUNITY_THEME_STATIC_CONTROLS PASS themes=${manifest.themes.map((theme) => theme.id).join(",")}\n`,
  );
}

function assertManifestNegativeControls(manifest) {
  const mutations = {
    repository: (candidate) => {
      candidate.themes[0].repository += "/";
    },
    commitUrl: (candidate) => {
      candidate.themes[0].commitUrl = candidate.themes[0].repository;
    },
    licenseUrl: (candidate) => {
      candidate.themes[0].licenseUrl = "https://example.invalid/LICENSE";
    },
    name: (candidate) => {
      candidate.themes[0].name = "";
    },
    version: (candidate) => {
      candidate.themes[0].release = "latest";
    },
    folder: (candidate) => {
      candidate.themes[0].folder = "../escape";
    },
    shippedThirdPartyAssets: (candidate) => {
      candidate.themes[0].shippedThirdPartyAssets = true;
    },
    path: (candidate) => {
      candidate.themes[0].files[0].path = "../theme.css";
    },
  };
  for (const [label, mutate] of Object.entries(mutations)) {
    const candidate = structuredClone(manifest);
    mutate(candidate);
    let rejected = false;
    try {
      assertValidManifest(candidate);
    } catch {
      rejected = true;
    }
    assert(rejected, `Community theme manifest negative control was accepted: ${label}.`);
  }
  process.stdout.write(
    `COMMUNITY_THEME_MANIFEST_CONTROLS PASS ${Object.keys(mutations).join(",")}\n`,
  );
}

async function assertStaticCacheControls(manifest) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-community-cache-controls-"));
  const safeRoot = path.join(root, "safe-root");
  const outside = path.join(root, "outside");
  const theme = manifest.themes[0];
  const themeRoot = path.join(safeRoot, theme.id);
  const outsideFile = path.join(outside, "theme.css");
  await fs.mkdir(themeRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(outside, { recursive: true, mode: 0o700 });
  await fs.writeFile(outsideFile, "outside", { mode: 0o600 });
  const expectRejected = async (operation, label) => {
    let rejected = false;
    try {
      await operation();
    } catch {
      rejected = true;
    }
    assert(rejected, `Community cache safety control did not reject ${label}.`);
  };
  try {
    await assertSafeCacheRoot(safeRoot);
    await expectRejected(() => assertSafeCacheRoot(appRoot), "a checkout cache root");

    const rootLink = path.join(root, "root-link");
    await fs.symlink(safeRoot, rootLink, "dir");
    await expectRejected(
      () => readCommunityCacheFile(rootLink, theme.id, "theme.css"),
      "a symlinked cache root",
    );
    await fs.rm(rootLink, { force: true });

    const themeLink = path.join(safeRoot, `${theme.id}-link`);
    await fs.symlink(outside, themeLink, "dir");
    await expectRejected(
      () => readCommunityCacheFile(safeRoot, `${theme.id}-link`, "theme.css"),
      "a symlinked theme parent",
    );
    await fs.rm(themeLink, { force: true });

    const target = path.join(themeRoot, "theme.css");
    await fs.symlink(outsideFile, target);
    await expectRejected(
      () => readCommunityCacheFile(safeRoot, theme.id, "theme.css"),
      "a symlinked receipt",
    );
    await fs.rm(target, { force: true });

    await fs.writeFile(target, Buffer.alloc(CACHE_FILE_LIMITS["theme.css"] + 1, 0x61));
    await expectRejected(
      () => readCommunityCacheFile(safeRoot, theme.id, "theme.css"),
      "an oversized receipt before whole-body read",
    );
    await fs.rm(target, { force: true });

    const acquisitionSource = await fs.readFile(
      path.join(appRoot, "scripts", "acquire-community-theme-fixtures.mjs"),
      "utf8",
    );
    for (const required of [
      "response.body.getReader()",
      "O_NOFOLLOW",
      "O_EXCL",
      "fs.rename(",
      "AbortController",
      "signal: controller.signal",
      "setTimeout(() => controller.abort()",
    ]) {
      assert(
        acquisitionSource.includes(required),
        `Acquisition safety primitive is missing: ${required}`,
      );
    }
    process.stdout.write(
      "COMMUNITY_THEME_CACHE_CONTROLS PASS symlink-containment=nofollow atomic-write=bounded-stream\n",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function runCommunityPositiveControl(baselineManifest) {
  const candidate = Object.entries(baselineManifest.cases).find(([, value]) => !value.pending);
  assert(candidate, "Community theme positive control has no committed PNG baseline.");
  const [key, baseline] = candidate;
  const bytes = await fs.readFile(path.join(baselineRoot, baseline.path));
  const image = decodePng(bytes, `baseline ${key}`);
  const tampered = { ...image, pixels: Buffer.from(image.pixels) };
  for (let y = 0; y < tampered.height; y += 1) {
    for (let x = 0; x < tampered.width; x += 1) {
      const index = (y * tampered.width + x) * 4;
      tampered.pixels[index] = 255;
      tampered.pixels[index + 1] = 0;
      tampered.pixels[index + 2] = 255;
    }
  }
  const comparison = compareImages(tampered, image);
  assert(
    comparison.meanAbsoluteRgb > 0.5 && comparison.changedPixelRatio > 0.9,
    `Community theme positive control was not rejected: ${JSON.stringify(comparison)}`,
  );
  process.stdout.write(
    `COMMUNITY_THEME_POSITIVE_CONTROL PASS ${key} rejected tampered baseline ${JSON.stringify(comparison)}\n`,
  );
}

async function main() {
  if (updateRequested && isCi) {
    throw new Error("Refusing to update community theme baselines in CI.");
  }
  currentManifest = await readCommunityManifest();
  await assertStaticManifest(currentManifest);
  const actualFixtureTreeSha256 = await assertFixtureTree(currentManifest);
  assertManifestNegativeControls(currentManifest);
  assertStaticColourControls(currentManifest);
  await assertStaticCacheControls(currentManifest);
  const baselineManifestPath = path.join(baselineRoot, "manifest.v1.json");
  let baselineManifest;
  try {
    baselineManifest = await readJson(baselineManifestPath);
  } catch (error) {
    if (!updateRequested) throw error;
    baselineManifest = {
      schemaVersion: 1,
      matrix: currentManifest.id,
      fixtureTreeSha256: actualFixtureTreeSha256,
      renderer: currentManifest.renderer,
      environment: {
        path: "visual/environment.v1.json",
        sha256: sha256(await fs.readFile(path.join(appRoot, "visual", "environment.v1.json"))),
      },
      sourceReceipts: Object.fromEntries(
        currentManifest.themes.map((theme) => [
          theme.id,
          Object.fromEntries(theme.files.map((file) => [file.path, file.sha256])),
        ]),
      ),
      liveVerification: {},
      cases: {},
    };
  }
  if (Object.keys(baselineManifest.cases ?? {}).length > 0) {
    await assertBaselineIntegrity(currentManifest, baselineManifest, actualFixtureTreeSha256);
  } else if (integrityOnly || !updateRequested) {
    throw new Error("Community theme baseline manifest is missing its declared cases.");
  }
  const liveStatus = assertLiveVerificationStatus(currentManifest, baselineManifest);
  if (integrityOnly) {
    process.stdout.write(
      `COMMUNITY_THEME_INTEGRITY PASS cases=${currentManifest.cases.length} ` +
        `pending=${Object.values(baselineManifest.cases ?? {}).filter((entry) => entry.pending).length}\n`,
    );
    process.stdout.write(
      `COMMUNITY_THEME_LIVE_STATUS verified=${liveStatus.verified.join(",")} ` +
        `pending=${liveStatus.pending.join(",")}\n`,
    );
    if (positiveControl || redControl) await runCommunityPositiveControl(baselineManifest);
    if (redControl) {
      throw new Error(
        "COMMUNITY_THEME_RED_CONTROL_EXPECTED_FAILURE: tampered community baseline was rejected.",
      );
    }
    return;
  }
  if (positiveControl) {
    await runCommunityPositiveControl(baselineManifest);
    return;
  }
  if (redControl) {
    await runCommunityPositiveControl(baselineManifest);
    throw new Error(
      "COMMUNITY_THEME_RED_CONTROL_EXPECTED_FAILURE: tampered community baseline was rejected.",
    );
  }
  const verification = await verifyCommunityCache(currentManifest);
  if (!verification.complete) {
    const message =
      `COMMUNITY_THEME_VISUAL_SKIP cache incomplete: ${verification.missing.join(", ")}. ` +
      "Run `pnpm run community-theme:acquire` to opt in to network acquisition.";
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
  const capturedThemes = [];
  for (const theme of currentManifest.themes) {
    if (liveStatus.pending.includes(theme.id)) {
      process.stdout.write(
        `COMMUNITY_THEME_LIVE_PENDING ${theme.id}: ${liveStatus.declared[theme.id].reason}\n`,
      );
      continue;
    }
    const result = await runTheme(theme, verification, baselineManifest);
    process.stdout.write(
      `COMMUNITY_THEME_VISUAL_PASS ${theme.id} cases=${result.captures} deutan=${JSON.stringify(result.audits)}\n`,
    );
    capturedThemes.push(theme.id);
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
  // A run with any pending theme is never a full pass, even though every theme it actually
  // attempted succeeded: exit code 2 is reserved for this known, tracked, non-silent gap, kept
  // distinct from exit code 1 (an actual thrown failure via the top-level catch below) so
  // automation can tell "incomplete by design" apart from "broken."
  if (liveStatus.pending.length > 0) {
    process.stdout.write(
      `COMMUNITY_THEME_LIVE_INCOMPLETE verified=${capturedThemes.join(",")} ` +
        `pending=${liveStatus.pending.join(",")}\n`,
    );
    process.exitCode = 2;
  } else {
    process.stdout.write(`COMMUNITY_THEME_LIVE_COMPLETE verified=${capturedThemes.join(",")}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(
    `COMMUNITY_THEME_VISUAL_FAIL ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
