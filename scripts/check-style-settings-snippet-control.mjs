#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { authorityJsonSha256 } from "../src/shared/authority-json-runtime.mjs";

const appRoot = process.cwd();
const pluginId = "obsidian-style-settings";
const pluginVersion = "1.0.9";
const workflowId = "style-settings.snippet-control-live-reload.v1";
const repository = "mgmeyers/obsidian-style-settings";
const authorityProfilePath = path.join(
  appRoot,
  "scripts",
  "compatibility",
  "trust",
  `${pluginId}-${pluginVersion}.authority-profile.json`,
);
const sourceOverride = process.env.THREADLEAF_STYLE_SETTINGS_SOURCE_DIR?.trim();
const artifactDirectoryOverride = process.env.THREADLEAF_STYLE_SETTINGS_ARTIFACT_DIR?.trim();
const retainArtifacts = process.env.THREADLEAF_STYLE_SETTINGS_RETAIN_ARTIFACTS === "1";
const electronPath = path.join(appRoot, "node_modules", ".bin", "electron");
const fixtureName = "threadleaf-style-settings-live.css";
const fixtureSnippetId = `obsidian-snippet:${encodeURIComponent(fixtureName)}`;
const fixtureClassId = "threadleaf-live-marker";
const fixtureVariableId = "threadleaf-live-width";
const fixtureCss = `/* @settings
name: Threadleaf live appearance fixture
id: threadleaf-live-fixture
collapsed: false
settings:
  - id: ${fixtureClassId}
    title: Live marker class
    description: Adds a visible marker to this isolated settings surface.
    type: class-toggle
    default: false
    addCommand: true
  - id: ${fixtureVariableId}
    title: Live marker width
    description: Controls the marker outline width in pixels.
    type: variable-number
    default: 2
    format: px
*/

body.${fixtureClassId} [data-id="${fixtureClassId}"] {
  border-left-style: solid;
  border-left-color: rgb(0, 114, 178);
  border-left-width: var(--${fixtureVariableId});
  padding-left: 12px;
}
`;
const siblingPluginId = "inspection-safe";
const siblingPackageRoot = path.join(appRoot, "fixtures", "plugin-packages", siblingPluginId);
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-style-settings-e2e-"));
const artifactDirectory = artifactDirectoryOverride
  ? path.resolve(artifactDirectoryOverride)
  : await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-style-settings-artifacts-"));
const screenshotDirectory = path.join(artifactDirectory, "screenshots");
const vaultPath = path.join(testRoot, "vault");
const userDataPath = path.join(testRoot, "user-data");
const pluginPath = path.join(vaultPath, ".obsidian", "plugins", pluginId);
const siblingPath = path.join(vaultPath, ".obsidian", "plugins", siblingPluginId);
const snippetPath = path.join(vaultPath, ".obsidian", "snippets", fixtureName);
const styleDataPath = path.join(pluginPath, "data.json");
const output = [];
const screenshots = [];
const sequences = [];
const cdpRequestTimeout = 15_000;
let child = null;
let mainCdp = null;
let styleCdp = null;
let siblingCdp = null;
let styleTargetId = null;
let siblingTargetId = null;
let mainTargetUrl = null;
let lastSummary = { workflowId, status: "running", artifactDirectory };
let siblingMainBytes = null;
let initialObsidianSnapshot = null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function snapshotTree(rootPath) {
  const entries = [];
  async function visit(directory, relativeDirectory) {
    const directoryEntries = await fs.readdir(directory, { withFileTypes: true });
    directoryEntries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of directoryEntries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        const bytes = await fs.readFile(absolutePath);
        entries.push({
          path: relativePath,
          type: "file",
          sha256: sha256(bytes),
          size: bytes.length,
        });
      } else if (entry.isSymbolicLink()) {
        entries.push({
          path: relativePath,
          type: "symlink",
          target: await fs.readlink(absolutePath),
        });
      }
    }
  }
  await visit(rootPath, "");
  return entries;
}

async function verifyObsidianMutation() {
  assert(initialObsidianSnapshot, "The initial .obsidian snapshot was not captured.");
  const finalSnapshot = await snapshotTree(path.join(vaultPath, ".obsidian"));
  const beforeByPath = new Map(initialObsidianSnapshot.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(finalSnapshot.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])].sort();
  const changes = paths
    .filter(
      (entryPath) =>
        JSON.stringify(beforeByPath.get(entryPath) ?? null) !==
        JSON.stringify(afterByPath.get(entryPath) ?? null),
    )
    .map((entryPath) => ({
      path: entryPath,
      before: beforeByPath.get(entryPath) ?? null,
      after: afterByPath.get(entryPath) ?? null,
    }));
  const expectedPluginDataPath = "plugins/obsidian-style-settings/data.json";
  const unexpectedChanges = changes.filter((change) => change.path !== expectedPluginDataPath);
  assert(
    unexpectedChanges.length === 0,
    `Threadleaf or the workflow mutated unexpected .obsidian state: ${JSON.stringify(unexpectedChanges)}`,
  );
  return {
    status: "passed",
    threadleafMutation: false,
    expectedPluginPersistence: changes.filter((change) => change.path === expectedPluginDataPath),
    unexpectedChanges,
  };
}

async function makeDisposableTreeRemovable(candidatePath) {
  const stat = await fs.lstat(candidatePath).catch(() => null);
  if (!stat || stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) {
    if (stat.isFile()) await fs.chmod(candidatePath, 0o600);
    return;
  }
  await fs.chmod(candidatePath, 0o700);
  for (const entry of await fs.readdir(candidatePath)) {
    await makeDisposableTreeRemovable(path.join(candidatePath, entry));
  }
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string", "Could not reserve an isolated CDP port.");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let requestId = 0;
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
      if (message.method === "Runtime.consoleAPICalled") {
        output.push(`[CDP console] ${JSON.stringify(message.params)}\n`);
      } else if (message.method === "Runtime.exceptionThrown") {
        output.push(`[CDP exception] ${JSON.stringify(message.params)}\n`);
      }
      return;
    }
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error("CDP WebSocket closed."));
    }
    pending.clear();
  });
  return {
    async send(method, params = {}, timeout = cdpRequestTimeout) {
      await opened;
      const id = ++requestId;
      const result = new Promise((resolve, reject) => {
        const requestTimeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP ${method} timed out after ${timeout}ms.`));
        }, timeout);
        pending.set(id, { resolve, reject, timeout: requestTimeout });
      });
      socket.send(JSON.stringify({ id, method, params }));
      return result;
    },
    close() {
      socket.close();
    },
  };
}

async function cdpTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  assert(response.ok, `The isolated CDP endpoint returned HTTP ${response.status}.`);
  return response.json();
}

async function waitForTarget(port, predicate, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const target = (await cdpTargets(port)).find(predicate);
      if (target?.webSocketDebuggerUrl) return target;
    } catch {
      // Electron is still starting or replacing a renderer.
    }
    await delay(80);
  }
  throw new Error(`${label} did not appear on the isolated CDP endpoint.`);
}

async function evaluate(connection, expression) {
  const response = await connection.send("Runtime.evaluate", {
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

async function evaluatePending(connection, expression) {
  const response = await connection.send("Runtime.evaluate", {
    expression,
    awaitPromise: false,
    returnByValue: false,
  });
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ?? "Renderer evaluation failed.",
    );
  }
}

async function waitFor(connection, predicate, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await evaluate(connection, predicate);
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(80);
  }
  throw new Error(`${label} did not become true${lastError ? `: ${lastError.message}` : "."}`);
}

async function targetCenter(connection, selector) {
  const result = await evaluate(
    connection,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) return { error: "missing" };
      element.scrollIntoView({ block: "center", inline: "center" });
      const root = element.closest("button, [role=button], input, select, textarea") ?? element;
      const rect = root.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const style = getComputedStyle(root);
      return {
        error: null,
        disabled: root instanceof HTMLButtonElement || root instanceof HTMLInputElement || root instanceof HTMLSelectElement || root instanceof HTMLTextAreaElement ? root.disabled : false,
        hidden: root.hidden || style.display === "none" || style.visibility === "hidden",
        hit: Boolean(hit && (hit === root || root.contains(hit))),
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        width: rect.width,
        height: rect.height,
      };
    })()`,
  );
  assert(result && !result.error, `Pointer target is unavailable: ${selector}`);
  assert(!result.disabled, `Pointer target is disabled: ${selector}`);
  assert(
    !result.hidden && result.width > 0 && result.height > 0,
    `Pointer target is hidden: ${selector}`,
  );
  assert(result.hit, `Pointer target is covered: ${selector}`);
  return result;
}

async function clickSelector(connection, selector) {
  const target = await targetCenter(connection, selector);
  await connection.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    button: "none",
    buttons: 0,
    x: target.x,
    y: target.y,
  });
  await connection.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    buttons: 1,
    clickCount: 1,
    x: target.x,
    y: target.y,
  });
  await connection.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    buttons: 0,
    clickCount: 1,
    x: target.x,
    y: target.y,
  });
}

function keyCode(key) {
  if (key.length === 1) return key.toUpperCase().charCodeAt(0);
  return { Backspace: 8, Enter: 13, Escape: 27, Tab: 9, ArrowLeft: 37, ArrowRight: 39 }[key];
}

async function pressKey(connection, key, code, modifiers = 0) {
  const virtualKey = keyCode(key);
  assert(virtualKey, `Unsupported CDP key: ${key}`);
  await connection.send("Input.dispatchKeyEvent", {
    type: key.length === 1 ? "keyDown" : "rawKeyDown",
    code,
    key,
    modifiers,
    windowsVirtualKeyCode: virtualKey,
    nativeVirtualKeyCode: virtualKey,
    text: key.length === 1 && modifiers === 0 ? key : undefined,
  });
  await connection.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    code,
    key,
    modifiers,
    windowsVirtualKeyCode: virtualKey,
    nativeVirtualKeyCode: virtualKey,
  });
}

async function typeInto(connection, selector, value) {
  await clickSelector(connection, selector);
  await pressKey(connection, "a", "KeyA", 2);
  await pressKey(connection, "Backspace", "Backspace");
  for (const character of String(value)) {
    await pressKey(connection, character, `Digit${character}`);
  }
  await pressKey(connection, "Tab", "Tab");
}

async function descendantProcesses(rootPid) {
  const entries = await fs.readdir("/proc", { withFileTypes: true });
  const processes = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    try {
      const [status, commandLine] = await Promise.all([
        fs.readFile(path.join("/proc", entry.name, "status"), "utf8"),
        fs.readFile(path.join("/proc", entry.name, "cmdline")),
      ]);
      processes.push({
        pid: Number(entry.name),
        parent: Number(/^PPid:\s+(\d+)$/mu.exec(status)?.[1] ?? -1),
        commandLine: commandLine.toString("utf8").replaceAll("\0", " "),
      });
    } catch {
      // A short-lived process disappeared between metadata reads.
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
  return processes.filter((process) => descendants.has(process.pid));
}

async function x11CommandEvidence() {
  assert(child?.pid, "The isolated Electron process is unavailable for X11 verification.");
  const processes = await descendantProcesses(child.pid);
  const rendererCommands = processes
    .filter((process) => process.commandLine.includes("--type=renderer"))
    .map((process) => process.commandLine);
  const x11Renderer = rendererCommands.find(
    (commandLine) =>
      commandLine.includes("--ozone-platform=x11") &&
      !commandLine.includes("--ozone-platform=wayland"),
  );
  assert(x11Renderer, `No renderer command line proved X11: ${JSON.stringify(rendererCommands)}`);
  return { rendererCommands, x11Renderer };
}

async function preparePackageSource() {
  const profile = JSON.parse(await fs.readFile(authorityProfilePath, "utf8"));
  const expected = profile.packageIdentity;
  let source = sourceOverride ? path.resolve(sourceOverride) : null;
  async function readSource(directory) {
    const manifestBytes = await fs.readFile(path.join(directory, "manifest.json"));
    const main = await fs.readFile(path.join(directory, "main.js"));
    const styles = await fs.readFile(path.join(directory, "styles.css"));
    return { manifestBytes, main, styles, source: `local:${directory}` };
  }
  if (!source) {
    const downloadRoot = path.join(testRoot, "exact-release");
    await fs.mkdir(downloadRoot, { recursive: true });
    const releaseRoot = `https://github.com/${repository}/releases/download/${pluginVersion}`;
    for (const filename of ["manifest.json", "main.js", "styles.css"]) {
      let failure = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const response = await fetch(`${releaseRoot}/${filename}`, {
            headers: { "User-Agent": "Threadleaf exact Style Settings workflow" },
            redirect: "follow",
            signal: AbortSignal.timeout(20_000),
          });
          assert(
            response.ok,
            `Official Style Settings ${filename} returned HTTP ${response.status}.`,
          );
          const finalUrl = new URL(response.url);
          assert(
            finalUrl.protocol === "https:" &&
              (finalUrl.hostname === "github.com" ||
                finalUrl.hostname.endsWith("githubusercontent.com")),
            `Official Style Settings ${filename} redirected outside GitHub: ${finalUrl.hostname}`,
          );
          await fs.writeFile(
            path.join(downloadRoot, filename),
            Buffer.from(await response.arrayBuffer()),
          );
          failure = null;
          break;
        } catch (error) {
          failure = error;
          if (attempt < 3) await delay(attempt * 300);
        }
      }
      if (failure)
        throw new Error(`Official Style Settings ${filename} download failed: ${failure}`);
    }
    source = downloadRoot;
  }
  const packageSource = await readSource(source);
  const manifest = JSON.parse(packageSource.manifestBytes.toString("utf8"));
  assert(
    manifest.id === pluginId && manifest.version === pluginVersion,
    "Exact package manifest identity failed.",
  );
  const fileEntries = [
    { path: "main.js", sha256: sha256(packageSource.main), size: packageSource.main.length },
    {
      path: "manifest.json",
      sha256: sha256(packageSource.manifestBytes),
      size: packageSource.manifestBytes.length,
    },
    { path: "styles.css", sha256: sha256(packageSource.styles), size: packageSource.styles.length },
  ].sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  const packageTreeSha256 = authorityJsonSha256({ schemaVersion: 1, files: fileEntries });
  const packageIdentity = {
    pluginId,
    manifestVersion: pluginVersion,
    distributionTag: pluginVersion,
    manifestSha256: sha256(packageSource.manifestBytes),
    mainSha256: sha256(packageSource.main),
    stylesSha256: sha256(packageSource.styles),
    packageTreeSha256,
  };
  const packageIdentityDigest = authorityJsonSha256(packageIdentity);
  assert(
    authorityJsonSha256(packageIdentity) === profile.packageIdentityDigest,
    "Exact package identity digest did not match the reviewed profile.",
  );
  assert(
    JSON.stringify(packageIdentity) === JSON.stringify(expected),
    "Exact package identity fields did not match the reviewed profile.",
  );
  const authorityPayload = {
    schemaVersion: profile.schemaVersion,
    profileId: profile.profileId,
    profileRevision: profile.profileRevision,
    packageIdentity: profile.packageIdentity,
    packageIdentityDigest: profile.packageIdentityDigest,
    expectedStaticCapabilities: profile.expectedStaticCapabilities,
    requiredAuthorities: profile.requiredAuthorities,
    executionProfile: profile.executionProfile,
    allowedPlatforms: profile.allowedPlatforms,
  };
  assert(
    authorityJsonSha256(authorityPayload) === profile.authorityDigest,
    "Reviewed authority profile digest was stale.",
  );
  return {
    ...packageSource,
    manifest,
    profileId: profile.profileId,
    profileRevision: profile.profileRevision,
    authorityDigest: profile.authorityDigest,
    packageIdentity,
    packageIdentityDigest,
  };
}

async function copyFixture(packageSource) {
  const siblingManifestBytes = await fs.readFile(path.join(siblingPackageRoot, "manifest.json"));
  siblingMainBytes = await fs.readFile(path.join(siblingPackageRoot, "main.js"));
  const siblingStylesBytes = await fs.readFile(path.join(siblingPackageRoot, "styles.css"));
  await fs.mkdir(path.dirname(snippetPath), { recursive: true });
  await fs.mkdir(pluginPath, { recursive: true });
  await fs.mkdir(siblingPath, { recursive: true });
  await fs.writeFile(snippetPath, fixtureCss);
  await fs.writeFile(path.join(pluginPath, "manifest.json"), packageSource.manifestBytes);
  await fs.writeFile(path.join(pluginPath, "main.js"), packageSource.main);
  await fs.writeFile(path.join(pluginPath, "styles.css"), packageSource.styles);
  await fs.writeFile(path.join(pluginPath, "data.json"), "{}\n");
  await fs.writeFile(path.join(siblingPath, "manifest.json"), siblingManifestBytes);
  await fs.writeFile(path.join(siblingPath, "main.js"), siblingMainBytes);
  await fs.writeFile(path.join(siblingPath, "styles.css"), siblingStylesBytes);
  await fs.writeFile(path.join(vaultPath, "Welcome.md"), "# Style Settings live workflow\n");
}

function pngDecode(bytes, label) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert(bytes.subarray(0, 8).equals(signature), `${label} is not a PNG.`);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
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
      colorType = bytes[dataStart + 9];
    } else if (type === "IDAT") idat.push(bytes.subarray(dataStart, dataEnd));
    else if (type === "IEND") break;
    offset = dataEnd + 4;
  }
  assert(
    width > 0 && height > 0 && bitDepth === 8 && (colorType === 2 || colorType === 6),
    `${label} uses unsupported PNG encoding.`,
  );
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  assert(raw.length === (stride + 1) * height, `${label} has unexpected PNG scanline data.`);
  const pixels = Buffer.alloc(width * height * 4);
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
      pixels[target] = row[source];
      pixels[target + 1] = row[source + 1];
      pixels[target + 2] = row[source + 2];
      pixels[target + 3] = colorType === 6 ? row[source + 3] : 255;
    }
    previous = row;
  }
  return { width, height, pixels };
}

function pixelDifference(before, after) {
  assert(
    before.width === after.width && before.height === after.height,
    "Screenshot dimensions changed during the positive control.",
  );
  let samples = 0;
  let changed = 0;
  let total = 0;
  for (let index = 0; index < before.pixels.length; index += 4) {
    const difference =
      Math.abs(before.pixels[index] - after.pixels[index]) +
      Math.abs(before.pixels[index + 1] - after.pixels[index + 1]) +
      Math.abs(before.pixels[index + 2] - after.pixels[index + 2]);
    total += difference;
    samples += 1;
    if (difference >= 24) changed += 1;
  }
  return {
    changedPixelRatio: changed / samples,
    meanAbsoluteRgb: total / samples / 3 / 255,
  };
}

async function capture(connection, label) {
  await fs.mkdir(screenshotDirectory, { recursive: true });
  const response = await connection.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  const bytes = Buffer.from(response.data, "base64");
  const image = pngDecode(bytes, label);
  assert(
    image.width > 0 && image.height > 0 && bytes.length > 1_000,
    `${label} screenshot was empty.`,
  );
  const filePath = path.join(screenshotDirectory, `${label}.png`);
  await fs.writeFile(filePath, bytes);
  const result = {
    label,
    path: filePath,
    sha256: sha256(bytes),
    width: image.width,
    height: image.height,
    bytes: bytes.length,
    image,
  };
  screenshots.push({ ...result, image: undefined });
  return result;
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
      "--password-store=basic",
      ".",
    ],
    {
      cwd: appRoot,
      env: {
        ...process.env,
        ELECTRON_OZONE_PLATFORM_HINT: "x11",
        THREADLEAF_VAULT_PATH: vaultPath,
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk) => {
      output.push(String(chunk));
      while (output.length > 120) output.shift();
    });
  }
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  assert(
    child.spawnargs.includes("--ozone-platform=x11"),
    "Electron was not launched with explicit X11.",
  );
  const mainTarget = await waitForTarget(
    port,
    (target) => target.type === "page" && target.url.includes("/dist/renderer/index.html"),
    "main renderer",
  );
  mainTargetUrl = mainTarget.url;
  mainCdp = connectCdp(mainTarget.webSocketDebuggerUrl);
  await mainCdp.send("Runtime.enable");
  await mainCdp.send("Page.enable");
  await waitFor(mainCdp, "document.readyState === 'complete'", "main renderer document");
  try {
    await waitFor(
      mainCdp,
      `(async () => { const snapshot = await window.threadleaf.getSnapshot(); return snapshot.workspace?.state === 'ready' && snapshot.vault?.path === ${JSON.stringify(vaultPath)} ? snapshot : null; })()`,
      "disposable vault readiness",
      30_000,
    );
  } catch (error) {
    const probe = await evaluate(
      mainCdp,
      `(() => ({ href: location.href, readyState: document.readyState, shellReady: document.documentElement.dataset.threadleafShellReady ?? null, bodyText: document.body?.innerText?.slice(0, 500) ?? '' }))()`,
    ).catch((probeError) => ({ error: String(probeError) }));
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} Startup probe: ${JSON.stringify(probe)} Output tail: ${output.slice(-8).join("")}`,
    );
  }
  const commandEvidence = await x11CommandEvidence();
  return { port, mainTarget, commandEvidence };
}

async function closeApplication() {
  for (const connection of [styleCdp, siblingCdp, mainCdp]) connection?.close();
  styleCdp = null;
  siblingCdp = null;
  mainCdp = null;
  if (!child) return;
  const current = child;
  child = null;
  const exited =
    current.exitCode !== null || current.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => current.once("exit", resolve));
  try {
    if (current.pid) process.kill(-current.pid, "SIGTERM");
    else current.kill("SIGTERM");
  } catch {
    current.kill("SIGTERM");
  }
  await Promise.race([
    exited,
    delay(7_000).then(() => {
      try {
        if (current.pid) process.kill(-current.pid, "SIGKILL");
        else current.kill("SIGKILL");
      } catch {
        current.kill("SIGKILL");
      }
    }),
  ]);
}

async function assertMainOrigin() {
  const href = await evaluate(mainCdp, "location.href");
  assert(
    typeof href === "string" && href.includes("/dist/renderer/index.html"),
    `Unexpected main renderer origin: ${href}`,
  );
  return href;
}

async function assertPluginOrigin(connection) {
  const href = await evaluate(connection, "location.href");
  assert(
    typeof href === "string" && href.includes("plugin-host.html"),
    `Unexpected plugin renderer origin: ${href}`,
  );
  return href;
}

async function getSnapshot() {
  await assertMainOrigin();
  return evaluate(mainCdp, "window.threadleaf.getSnapshot()");
}

async function openSettingsPage(page) {
  await assertMainOrigin();
  const dialogOpen = await evaluate(
    mainCdp,
    "document.querySelector('#shortcut-settings')?.open === true",
  );
  if (!dialogOpen) {
    await clickSelector(mainCdp, "#settings-trigger");
    await waitFor(
      mainCdp,
      "document.querySelector('#shortcut-settings')?.open === true",
      "Threadleaf settings dialog",
    );
  }
  const selector = `#settings-nav-${page}`;
  await clickSelector(mainCdp, selector);
  await waitFor(
    mainCdp,
    `document.querySelector('[data-settings-page="${page}"]')?.hidden === false`,
    `${page} settings page`,
  );
}

async function closePluginSurface() {
  const snapshot = await getSnapshot();
  if (snapshot.pluginSurface) {
    await clickSelector(mainCdp, "#plugin-view");
    await waitFor(
      mainCdp,
      "(async () => (await window.threadleaf.getSnapshot()).pluginSurface === null)()",
      "plugin surface close",
    );
  }
}

async function findPluginTarget(port, probe, label, timeout = 20_000, excludedTargetId = null) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const targets = await cdpTargets(port).catch(() => []);
    for (const target of targets.filter(
      (candidate) =>
        candidate.id !== excludedTargetId &&
        candidate.type === "page" &&
        candidate.url.includes("plugin-host.html"),
    )) {
      const connection = connectCdp(target.webSocketDebuggerUrl);
      try {
        await connection.send("Runtime.enable");
        await connection.send("Page.enable");
        if (await evaluate(connection, probe)) return { target, connection };
      } catch {
        // A renderer can disappear while its replacement is being attached.
      }
      connection.close();
    }
    await delay(80);
  }
  throw new Error(`${label} did not appear on the isolated CDP endpoint.`);
}

async function styleState(connection = styleCdp) {
  return evaluate(
    connection,
    `(() => {
      const row = document.querySelector('[data-id="${fixtureClassId}"]');
      const classInput = row?.querySelector('input[type="checkbox"]');
      const numberInput = document.querySelector('[data-id="${fixtureVariableId}"] input');
      const target = row instanceof HTMLElement ? row : null;
      const sources = [...document.head.querySelectorAll('style')].map((style) => ({
        id: style.id,
        text: style.textContent ?? '',
        isSource: style.id.startsWith('threadleaf-compat-'),
      }));
      return {
        href: location.href,
        theme: document.documentElement.dataset.theme ?? null,
        controls: {
          classPresent: Boolean(row),
          classChecked: classInput instanceof HTMLInputElement ? classInput.checked : null,
          numberPresent: numberInput instanceof HTMLInputElement,
          numberValue: numberInput instanceof HTMLInputElement ? numberInput.value : null,
          names: row?.textContent?.trim() ?? '',
        },
        bodyClass: document.body.classList.contains('${fixtureClassId}'),
        bodyVariable: getComputedStyle(document.body).getPropertyValue('--${fixtureVariableId}').trim(),
        borderLeftWidth: target ? getComputedStyle(target).borderLeftWidth : null,
        cssSettingsManager: document.getElementById('css-settings-manager')?.textContent ?? null,
        sourceDiscovery: [...document.styleSheets].map((sheet) => ({
          id: sheet.ownerNode?.id ?? null,
          text: sheet.ownerNode?.textContent ?? '',
        })),
        sources,
        activeWindow: globalThis.activeWindow === window,
        activeWindowDescriptor: (() => {
          const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'activeWindow');
          return descriptor
            ? {
                enumerable: descriptor.enumerable,
                configurable: descriptor.configurable,
                writable: descriptor.writable,
                valueIsWindow: descriptor.value === window,
              }
            : null;
        })(),
      };
    })()`,
  );
}

async function recordSequence(label, expectedMinimum = 1) {
  const snapshot = await getSnapshot();
  const environment = snapshot.pluginEnvironment;
  assert(environment?.status === "applied", `${label} had no applied environment acknowledgement.`);
  assert(environment.sequence >= expectedMinimum, `${label} environment sequence did not advance.`);
  sequences.push({ label, ...environment });
  return environment;
}

async function readSavedData() {
  const parsed = JSON.parse(await fs.readFile(styleDataPath, "utf8"));
  return parsed;
}

async function waitForSavedData(expected) {
  const deadline = Date.now() + 8_000;
  let current = null;
  while (Date.now() < deadline) {
    current = await readSavedData().catch(() => null);
    if (
      current?.[`threadleaf-live-fixture@@${fixtureClassId}`] === expected.classValue &&
      current?.[`threadleaf-live-fixture@@${fixtureVariableId}`] === expected.variableValue
    )
      return current;
    await delay(80);
  }
  throw new Error(`Style Settings data did not persist: ${JSON.stringify(current)}`);
}

async function openStyleSettingsSurface() {
  await openSettingsPage("plugins");
  const optionsSelector = `.plugin-row[data-plugin-id=${JSON.stringify(pluginId)}] .plugin-options-button`;
  await waitFor(
    mainCdp,
    `(() => { const button = document.querySelector(${JSON.stringify(optionsSelector)}); return button instanceof HTMLButtonElement && !button.hidden && !button.disabled; })()`,
    "Style Settings Options control",
  );
  await clickSelector(mainCdp, optionsSelector);
  await waitFor(
    mainCdp,
    `(async () => { const snapshot = await window.threadleaf.getSnapshot(); return !document.querySelector('#shortcut-settings')?.open && snapshot.pluginSurface?.viewType === 'threadleaf-plugin-settings' ? snapshot : null; })()`,
    "Style Settings Options route",
    30_000,
  );
  await waitFor(
    styleCdp,
    `Boolean(document.querySelector('[data-id="${fixtureClassId}"] input[type="checkbox"]') && document.querySelector('[data-id="${fixtureVariableId}"] input'))`,
    "Style Settings real controls",
    30_000,
  );
  await waitFor(styleCdp, "document.readyState === 'complete'", "Style Settings renderer document");
  await assertPluginOrigin(styleCdp);
  return styleState();
}

async function enablePackageFromCatalog() {
  await assertMainOrigin();
  const catalog = await waitFor(
    mainCdp,
    `(async () => { const result = await window.threadleaf.getPlugins(${JSON.stringify(vaultId)}); return result.status === 'ready' && result.catalog?.plugins?.some((plugin) => plugin.id === ${JSON.stringify(pluginId)}) ? result : null; })()`,
    "exact Style Settings catalog",
    30_000,
  );
  const plugin = catalog.catalog.plugins.find((candidate) => candidate.id === pluginId);
  assert(
    plugin?.version === pluginVersion && plugin.packageState === "ready",
    `Exact Style Settings package was not ready: ${JSON.stringify(plugin)}`,
  );
  assert(
    plugin.capabilityReport?.bundleSha256 === packageSource.packageIdentity.mainSha256,
    "Style Settings capability report did not bind main.js.",
  );
  const grant = await evaluate(
    mainCdp,
    `window.threadleaf.setPluginCapabilityGrant(${JSON.stringify(vaultId)}, ${JSON.stringify(pluginId)}, ${JSON.stringify(plugin.capabilityReport.bundleSha256)}, true)`,
  );
  assert(grant.status === "updated", "Exact Style Settings authority grant did not commit.");
  const pendingEnable = evaluatePending(
    mainCdp,
    `window.threadleaf.setPluginEnabled(${JSON.stringify(vaultId)}, ${JSON.stringify(pluginId)}, true)`,
  );
  const initialProbe = await findPluginTarget(
    currentPort,
    `(() => {
      const source = document.getElementById('threadleaf-compat-appearance-source');
      const plugin = document.getElementById('threadleaf-compat-plugin-source');
      return Boolean(source?.textContent?.includes(${JSON.stringify(fixtureCss)}) && plugin && !document.getElementById('css-settings-manager'));
    })()`,
    "initial environment before Style Settings dynamic style",
    30_000,
  );
  styleTargetId = initialProbe.target.id;
  styleCdp = initialProbe.connection;
  const initialState = await styleState();
  assert(
    initialState.sources.some(
      (source) =>
        source.id === "threadleaf-compat-appearance-source" && source.text.includes(fixtureCss),
    ),
    "Initial source node did not expose the exact fixture declaration text.",
  );
  assert(
    !initialState.cssSettingsManager,
    "Style Settings dynamic CSS existed before the initial environment probe completed.",
  );
  await pendingEnable;
  await waitFor(
    mainCdp,
    `(async () => (await window.threadleaf.getSnapshot()).plugins?.some((plugin) => plugin.id === ${JSON.stringify(pluginId)} && plugin.state === 'loaded'))()`,
    "Style Settings plugin load",
    60_000,
  );
  return {
    plugin,
    initialProbe: { targetId: styleTargetId, url: initialProbe.target.url },
    initialState,
  };
}

async function enableSiblingRenderer() {
  const catalog = await evaluate(
    mainCdp,
    `window.threadleaf.getPlugins(${JSON.stringify(vaultId)})`,
  );
  const plugin = catalog.catalog.plugins.find((candidate) => candidate.id === siblingPluginId);
  assert(
    plugin?.packageState === "ready" && plugin.capabilityReport?.bundleSha256,
    "Sibling fixture package was not reviewable.",
  );
  const grant = await evaluate(
    mainCdp,
    `window.threadleaf.setPluginCapabilityGrant(${JSON.stringify(vaultId)}, ${JSON.stringify(siblingPluginId)}, ${JSON.stringify(plugin.capabilityReport.bundleSha256)}, true)`,
  );
  assert(grant.status === "updated", "Sibling fixture authority grant did not commit.");
  await evaluate(
    mainCdp,
    `window.threadleaf.setPluginEnabled(${JSON.stringify(vaultId)}, ${JSON.stringify(siblingPluginId)}, true)`,
  );
  const found = await findPluginTarget(
    currentPort,
    "Boolean(document.getElementById('threadleaf-compat-appearance-source'))",
    "separately constructed sibling plugin renderer",
    30_000,
    styleTargetId,
  );
  siblingTargetId = found.target.id;
  siblingCdp = found.connection;
  await assertPluginOrigin(siblingCdp);
  const state = await evaluate(
    siblingCdp,
    `({ classPresent: document.body.classList.contains(${JSON.stringify(fixtureClassId)}), variable: getComputedStyle(document.body).getPropertyValue('--${fixtureVariableId}').trim(), dynamic: Boolean(document.getElementById('css-settings-manager')), href: location.href })`,
  );
  assert(
    !state.classPresent && !state.variable && !state.dynamic,
    `Sibling renderer leaked Style Settings state: ${JSON.stringify(state)}`,
  );
  return { targetId: siblingTargetId, url: found.target.url, state };
}

async function setNonDefaultValues() {
  const before = await styleState();
  const classSelector = `[data-id="${fixtureClassId}"] input[type="checkbox"]`;
  const numberSelector = `[data-id="${fixtureVariableId}"] input`;
  if (!before.controls.classChecked) await clickSelector(styleCdp, classSelector);
  await typeInto(styleCdp, numberSelector, "11");
  await waitFor(
    styleCdp,
    `(() => { const row = document.querySelector('[data-id="${fixtureClassId}"]'); const input = document.querySelector('[data-id="${fixtureVariableId}"] input'); return document.body.classList.contains('${fixtureClassId}') && input instanceof HTMLInputElement && input.value === '11' && row instanceof HTMLElement && getComputedStyle(row).borderLeftWidth === '11px'; })()`,
    "non-default Style Settings computed effect",
    20_000,
  );
  const saved = await waitForSavedData({ classValue: true, variableValue: 11 });
  const state = await styleState();
  assert(
    state.bodyClass && state.bodyVariable.includes("11px") && state.borderLeftWidth === "11px",
    `Non-default computed state was not settled: ${JSON.stringify(state)}`,
  );
  const snapshot = await recordSequence("non-default-controls");
  return { before, state, saved, sequence: snapshot.sequence };
}

async function disableSnippetThroughAppearance() {
  await closePluginSurface();
  await openSettingsPage("appearance");
  const selector = `#appearance-snippets input[value=${JSON.stringify(fixtureSnippetId)}]`;
  await waitFor(
    mainCdp,
    `document.querySelector(${JSON.stringify(selector)})?.checked === true`,
    "enabled fixture snippet control",
  );
  const before = await recordSequence("before-snippet-disable");
  await clickSelector(mainCdp, selector);
  const after = await waitFor(
    mainCdp,
    `(async () => { const snapshot = await window.threadleaf.getSnapshot(); const input = document.querySelector(${JSON.stringify(selector)}); return input?.checked === false && snapshot.pluginEnvironment?.status === 'applied' && snapshot.pluginEnvironment.sequence > ${before.sequence} ? snapshot : null; })()`,
    "snippet disable environment acknowledgement",
    30_000,
  );
  sequences.push({ label: "snippet-disabled", ...after.pluginEnvironment });
  await waitFor(
    styleCdp,
    `(() => { const row = document.querySelector('[data-id="${fixtureClassId}"]'); return !row && !document.body.classList.contains('${fixtureClassId}') && !getComputedStyle(document.body).getPropertyValue('--${fixtureVariableId}').trim() && (!document.getElementById('css-settings-manager') || !document.getElementById('css-settings-manager').textContent?.includes('--${fixtureVariableId}')) && !document.head.querySelector('style#css-settings-manager')?.textContent?.includes('${fixtureVariableId}'); })()`,
    "disabled snippet Style Settings cleanup",
    30_000,
  );
  const commandSnapshot = await getSnapshot();
  assert(
    !commandSnapshot.commands.some(
      ({ id }) => id === `style-settings-class-toggle-threadleaf-live-fixture-${fixtureClassId}`,
    ),
    "Dynamic Style Settings command survived snippet disable.",
  );
  return {
    beforeSequence: before.sequence,
    afterSequence: after.pluginEnvironment.sequence,
    state: await styleState(),
    commandCount: commandSnapshot.commands.length,
  };
}

async function reenableSnippetThroughAppearance() {
  const selector = `#appearance-snippets input[value=${JSON.stringify(fixtureSnippetId)}]`;
  await clickSelector(mainCdp, selector);
  const after = await waitFor(
    mainCdp,
    `(async () => { const snapshot = await window.threadleaf.getSnapshot(); const input = document.querySelector(${JSON.stringify(selector)}); return input?.checked === true && snapshot.pluginEnvironment?.status === 'applied' && snapshot.pluginEnvironment.sequence > ${sequences.at(-1).sequence} ? snapshot : null; })()`,
    "snippet re-enable environment acknowledgement",
    30_000,
  );
  sequences.push({ label: "snippet-reenabled", ...after.pluginEnvironment });
  if (await evaluate(mainCdp, "document.querySelector('#shortcut-settings')?.open === true")) {
    await waitFor(
      mainCdp,
      "(() => { const button = document.querySelector('#settings-close'); return button instanceof HTMLButtonElement && !button.disabled; })()",
      "settings dialog close control",
    );
    await clickSelector(mainCdp, "#settings-close");
    await waitFor(
      mainCdp,
      "document.querySelector('#shortcut-settings')?.open !== true",
      "settings dialog close before re-open",
    );
  }
  const reopened = await openStyleSettingsSurface();
  const restored = await setNonDefaultValues();
  return { sequence: after.pluginEnvironment.sequence, reopened, restored };
}

async function captureSettledThemes() {
  async function closeSettingsDialogIfOpen() {
    if (await evaluate(mainCdp, "document.querySelector('#shortcut-settings')?.open === true")) {
      await waitFor(
        mainCdp,
        "(() => { const button = document.querySelector('#settings-close'); return button instanceof HTMLButtonElement && !button.disabled; })()",
        "settings dialog close control",
      );
      await clickSelector(mainCdp, "#settings-close");
      await waitFor(
        mainCdp,
        "document.querySelector('#shortcut-settings')?.open !== true",
        "settings dialog close",
      );
    }
  }

  async function setThemeThroughAppearance(theme) {
    await closePluginSurface();
    await openSettingsPage("appearance");
    const selector = `#scheme-${theme}`;
    const before = await recordSequence(`before-${theme}-theme`);
    await waitFor(
      mainCdp,
      `(() => { const input = document.querySelector(${JSON.stringify(selector)}); return input instanceof HTMLInputElement && !input.disabled; })()`,
      `${theme} appearance control`,
    );
    const alreadySelected = await evaluate(
      mainCdp,
      `document.querySelector(${JSON.stringify(selector)})?.checked === true`,
    );
    if (!alreadySelected) {
      await clickSelector(mainCdp, selector);
      await waitFor(
        mainCdp,
        `(async () => { const snapshot = await window.threadleaf.getSnapshot(); const input = document.querySelector(${JSON.stringify(selector)}); return document.documentElement.dataset.theme === ${JSON.stringify(theme)} && input?.checked === true && snapshot.pluginEnvironment?.status === 'applied' && snapshot.pluginEnvironment.sequence > ${before.sequence} ? snapshot : null; })()`,
        `${theme} main theme`,
        30_000,
      );
    } else {
      await waitFor(
        mainCdp,
        `document.documentElement.dataset.theme === ${JSON.stringify(theme)}`,
        `${theme} main theme`,
      );
    }
    await waitFor(
      styleCdp,
      `document.documentElement.dataset.theme === ${JSON.stringify(theme)}`,
      `${theme} plugin environment`,
    );
    await closeSettingsDialogIfOpen();
    const reopened = await openStyleSettingsSurface();
    await waitFor(
      styleCdp,
      `document.documentElement.dataset.theme === ${JSON.stringify(theme)}`,
      `${theme} reopened plugin theme`,
    );
    return { beforeSequence: before.sequence, reopened };
  }

  const dark = await setThemeThroughAppearance("dark");
  const darkCapture = await capture(styleCdp, "style-settings-dark");
  const light = await setThemeThroughAppearance("light");
  const lightCapture = await capture(styleCdp, "style-settings-light");
  assert(
    darkCapture.sha256 !== lightCapture.sha256,
    "Dark and light Style Settings screenshots were identical.",
  );
  const restored = await setThemeThroughAppearance("dark");
  return {
    dark: {
      path: darkCapture.path,
      sha256: darkCapture.sha256,
      width: darkCapture.width,
      height: darkCapture.height,
    },
    light: {
      path: lightCapture.path,
      sha256: lightCapture.sha256,
      width: lightCapture.width,
      height: lightCapture.height,
    },
    transitions: { dark, light, restored },
  };
}

async function capturePositiveControl() {
  const before = await capture(styleCdp, "style-settings-positive-before");
  const applied = await evaluate(
    styleCdp,
    `(() => { const body = document.body; if (!(body instanceof HTMLElement)) return false; body.dataset.visualPositiveControl = 'true'; body.style.setProperty('background-color', 'rgb(230, 159, 0)', 'important'); body.style.setProperty('box-shadow', 'inset 0 0 0 20px rgb(0, 114, 178)', 'important'); return getComputedStyle(body).backgroundColor === 'rgb(230, 159, 0)' && getComputedStyle(body).boxShadow.includes('rgb(0, 114, 178)'); })()`,
  );
  assert(applied, "Screenshot positive control could not apply its visible mutation.");
  await waitFor(
    styleCdp,
    `(() => { const body = document.body; return body instanceof HTMLElement && getComputedStyle(body).backgroundColor === 'rgb(230, 159, 0)'; })()`,
    "screenshot positive control paint",
  );
  await delay(80);
  const after = await capture(styleCdp, "style-settings-positive-after");
  const metric = pixelDifference(before.image, after.image);
  assert(
    metric.changedPixelRatio > 0.002 && metric.meanAbsoluteRgb > 0.001,
    `Screenshot positive control did not trip its pixel metric: ${JSON.stringify(metric)}`,
  );
  await evaluate(
    styleCdp,
    `(() => { const body = document.body; body?.style.removeProperty('background-color'); body?.style.removeProperty('box-shadow'); body?.removeAttribute('data-visual-positive-control'); return true; })()`,
  );
  return {
    before: before.path,
    after: after.path,
    beforeSha256: before.sha256,
    afterSha256: after.sha256,
    metric,
    red: true,
  };
}

async function sourceAndRealmEvidence() {
  const state = await styleState();
  const sourceIds = state.sources.map(({ id }) => id);
  const appearanceIndex = sourceIds.indexOf("threadleaf-compat-appearance-source");
  const pluginIndex = sourceIds.indexOf("threadleaf-compat-plugin-source");
  const dynamicIndex = sourceIds.indexOf("css-settings-manager");
  const accessibilityIndex = sourceIds.indexOf("threadleaf-compat-accessibility");
  assert(
    appearanceIndex >= 0 &&
      pluginIndex > appearanceIndex &&
      dynamicIndex > pluginIndex &&
      accessibilityIndex > dynamicIndex,
    `Exact cascade order was not observed: ${JSON.stringify(sourceIds)}`,
  );
  assert(
    state.sourceDiscovery.some(
      ({ id, text }) => id === "threadleaf-compat-appearance-source" && text.includes(fixtureCss),
    ),
    "Style Settings did not discover fixture text through ownerNode.textContent.",
  );
  assert(
    state.activeWindow &&
      state.activeWindowDescriptor?.writable === false &&
      state.activeWindowDescriptor?.configurable === false &&
      state.activeWindowDescriptor?.valueIsWindow === true,
    "Isolated activeWindow identity or descriptor was not immutable.",
  );
  const mainRealm = await evaluate(
    mainCdp,
    `({ classPresent: document.body.classList.contains(${JSON.stringify(fixtureClassId)}), variable: getComputedStyle(document.body).getPropertyValue('--${fixtureVariableId}').trim(), dynamic: Boolean(document.getElementById('css-settings-manager')) })`,
  );
  assert(
    !mainRealm.classPresent && !mainRealm.variable && !mainRealm.dynamic,
    `Style Settings state leaked into Threadleaf main renderer: ${JSON.stringify(mainRealm)}`,
  );
  const siblingRealm = siblingCdp
    ? await evaluate(
        siblingCdp,
        `({ classPresent: document.body.classList.contains(${JSON.stringify(fixtureClassId)}), variable: getComputedStyle(document.body).getPropertyValue('--${fixtureVariableId}').trim(), dynamic: Boolean(document.getElementById('css-settings-manager')) })`,
      )
    : null;
  if (siblingRealm)
    assert(
      !siblingRealm.classPresent && !siblingRealm.variable && !siblingRealm.dynamic,
      `Style Settings state leaked into sibling renderer: ${JSON.stringify(siblingRealm)}`,
    );
  return {
    sourceIds,
    mainRealm,
    siblingRealm,
    styleState: {
      ...state,
      sourceDiscovery: state.sourceDiscovery.map(({ id, text }) => ({
        id,
        textLength: text.length,
      })),
    },
  };
}

async function recoverInProcess(port) {
  const oldTargetId = styleTargetId;
  let crashError = null;
  try {
    await styleCdp.send("Page.crash", {}, 3_000);
  } catch (error) {
    crashError = error instanceof Error ? error.message : String(error);
    if (!/closed|crash|target/iu.test(crashError))
      throw new Error(`CDP Page.crash did not induce renderer replacement: ${crashError}`);
  }
  styleCdp.close();
  styleCdp = null;
  await evaluate(mainCdp, `window.threadleaf.openPluginSettings(${JSON.stringify(pluginId)})`);
  await waitFor(
    mainCdp,
    `(async () => { const snapshot = await window.threadleaf.getSnapshot(); const plugin = snapshot.plugins?.find((candidate) => candidate.id === ${JSON.stringify(pluginId)}); return plugin?.state === 'loaded' && snapshot.notices?.some((notice) => notice.includes('compatibility renderer recovered')); })()`,
    "in-process Style Settings renderer reload",
    60_000,
  );
  const replacement = await findPluginTarget(
    port,
    `(() => Boolean(document.getElementById('threadleaf-compat-appearance-source')?.textContent?.includes(${JSON.stringify(fixtureCss)}) && document.getElementById('css-settings-manager')))()`,
    "replacement Style Settings renderer",
    30_000,
  );
  styleTargetId = replacement.target.id;
  styleCdp = replacement.connection;
  assert(
    styleTargetId !== oldTargetId,
    `Renderer replacement reused the crashed target id ${oldTargetId}.`,
  );
  await openStyleSettingsSurface();
  const state = await styleState();
  const saved = await waitForSavedData({ classValue: true, variableValue: 11 });
  assert(
    state.bodyClass && state.bodyVariable.includes("11px") && state.borderLeftWidth === "11px",
    `In-process renderer recovery did not reconstruct saved Style Settings state: ${JSON.stringify(state)}`,
  );
  const environment = await recordSequence("in-process-recovery");
  return { oldTargetId, newTargetId: styleTargetId, crashError, state, saved, environment };
}

async function restartAndReconstruct() {
  await closePluginSurface();
  const oldTargetId = styleTargetId;
  const oldMainUrl = mainTargetUrl;
  await closeApplication();
  const launch = await launchApplication();
  currentPort = launch.port;
  const sourceTarget = await findPluginTarget(
    currentPort,
    `Boolean(document.getElementById('threadleaf-compat-appearance-source')?.textContent?.includes(${JSON.stringify(fixtureCss)}) && document.getElementById('css-settings-manager'))`,
    "restarted Style Settings renderer",
    40_000,
  );
  styleTargetId = sourceTarget.target.id;
  styleCdp = sourceTarget.connection;
  assert(
    styleTargetId !== oldTargetId,
    "Application restart reused the previous plugin renderer target id.",
  );
  await openStyleSettingsSurface();
  const state = await styleState();
  const saved = await waitForSavedData({ classValue: true, variableValue: 11 });
  assert(
    state.bodyClass && state.bodyVariable.includes("11px") && state.borderLeftWidth === "11px",
    `Application restart did not reconstruct saved Style Settings state: ${JSON.stringify(state)}`,
  );
  const environment = await recordSequence("application-restart");
  return {
    oldTargetId,
    newTargetId: styleTargetId,
    oldMainUrl,
    newMainUrl: mainTargetUrl,
    state,
    saved,
    environment,
    commandEvidence: launch.commandEvidence,
  };
}

let packageSource = null;
let vaultId = null;
let currentPort = null;

async function run() {
  assert(
    process.platform === "linux",
    "The exact Style Settings workflow requires Linux and Xvfb.",
  );
  assert(
    await exists(electronPath),
    "Electron is not installed; the built workflow is unverified.",
  );
  await fs.mkdir(artifactDirectory, { recursive: true });
  packageSource = await preparePackageSource();
  await copyFixture(packageSource);
  initialObsidianSnapshot = await snapshotTree(path.join(vaultPath, ".obsidian"));
  const canonicalVaultPath = await fs.realpath(vaultPath);
  vaultId = sha256(Buffer.from(canonicalVaultPath));
  assert(siblingMainBytes, "The reviewed sibling fixture package was not copied.");
  const siblingSha256 = sha256(siblingMainBytes);
  await fs.mkdir(userDataPath, { recursive: true });
  await fs.writeFile(
    path.join(userDataPath, "settings.json"),
    `${JSON.stringify(
      {
        version: 5,
        keyBindings: {},
        appearanceByVault: {
          [vaultId]: {
            colorScheme: "dark",
            themeId: null,
            enabledSnippetIds: [fixtureSnippetId],
          },
        },
        pluginsByVault: {
          [vaultId]: {
            compatibilityMode: "enabled",
            enabledPluginIds: [],
            capabilityGrantsByPlugin: {},
          },
        },
        noteWorkflowsByVault: {},
      },
      null,
      2,
    )}\n`,
  );
  const launch = await launchApplication();
  currentPort = launch.port;
  const initial = await enablePackageFromCatalog();
  const sibling = await enableSiblingRenderer();
  const opened = await openStyleSettingsSurface();
  assert(
    opened.controls.classPresent && opened.controls.numberPresent,
    "Both real Style Settings controls were not present.",
  );
  const changed = await setNonDefaultValues();
  const disabled = await disableSnippetThroughAppearance();
  const reenabled = await reenableSnippetThroughAppearance();
  const themeScreenshots = await captureSettledThemes();
  const positiveControl = await capturePositiveControl();
  const realm = await sourceAndRealmEvidence();
  const recovered = await recoverInProcess(currentPort);
  const realmAfterRecovery = await sourceAndRealmEvidence();
  const restarted = await restartAndReconstruct();
  const realmAfterRestart = await sourceAndRealmEvidence();
  const obsidianMutation = await verifyObsidianMutation();
  const summary = {
    workflowId,
    status: "passed",
    artifactDirectory,
    package: {
      id: pluginId,
      version: pluginVersion,
      source: packageSource.source,
      manifestSha256: packageSource.packageIdentity.manifestSha256,
      mainSha256: packageSource.packageIdentity.mainSha256,
      stylesSha256: packageSource.packageIdentity.stylesSha256,
      packageTreeSha256: packageSource.packageIdentity.packageTreeSha256,
      packageIdentityDigest: packageSource.packageIdentityDigest,
      authorityProfileId: packageSource.profileId,
      authorityProfileRevision: packageSource.profileRevision,
      authorityDigest: packageSource.authorityDigest,
    },
    fixture: {
      name: fixtureName,
      snippetId: fixtureSnippetId,
      sha256: sha256(Buffer.from(fixtureCss)),
      classId: fixtureClassId,
      variableId: fixtureVariableId,
      siblingPluginId,
      siblingMainSha256: siblingSha256,
    },
    renderer: {
      initialStyleTargetId: initial.initialProbe.targetId,
      initialStyleTargetUrl: initial.initialProbe.url,
      siblingTargetId: sibling.targetId,
      mainTargetUrl,
      initialSourceBeforeDynamicStyle: true,
      initialEnvironmentState: initial.initialState,
      commandLine: launch.commandEvidence,
    },
    controls: { opened, changed, disabled, reenabled },
    screenshots: themeScreenshots,
    positiveControl,
    sourceAndRealm: {
      settled: realm,
      afterRecovery: realmAfterRecovery,
      afterRestart: realmAfterRestart,
    },
    recovery: recovered,
    restart: restarted,
    obsidianMutation,
    sequences,
    screenshotsDirectory: screenshotDirectory,
    outputTail: output.slice(-20),
  };
  await fs.writeFile(
    path.join(artifactDirectory, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  lastSummary = summary;
  console.log(JSON.stringify(summary, null, 2));
}

try {
  await run();
} catch (error) {
  const failure = {
    ...lastSummary,
    status: "failed",
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    outputTail: output.slice(-40),
  };
  await fs.mkdir(artifactDirectory, { recursive: true }).catch(() => undefined);
  await fs
    .writeFile(
      path.join(artifactDirectory, "summary.json"),
      `${JSON.stringify(failure, null, 2)}\n`,
    )
    .catch(() => undefined);
  console.error(JSON.stringify(failure, null, 2));
  process.exitCode = 1;
} finally {
  await closeApplication().catch((error) =>
    console.error(`Style Settings app cleanup failed: ${error}`),
  );
  await makeDisposableTreeRemovable(testRoot).catch((error) =>
    console.error(`Style Settings scratch permission repair failed: ${error}`),
  );
  await fs
    .rm(testRoot, { recursive: true, force: true })
    .catch((error) => console.error(`Style Settings scratch cleanup failed: ${error}`));
  if (!retainArtifacts && !artifactDirectoryOverride) {
    await fs
      .rm(artifactDirectory, { recursive: true, force: true })
      .catch((error) => console.error(`Style Settings artifact cleanup failed: ${error}`));
  }
}
