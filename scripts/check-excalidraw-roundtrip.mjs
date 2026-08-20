#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { authorityJsonSha256 } from "../src/shared/authority-json-runtime.mjs";

const appRoot = process.cwd();
const fixtureRoot = path.join(appRoot, "fixtures", "corpus", "excalidraw-roundtrip-v1");
const fixtureVault = path.join(fixtureRoot, "vault");
const sourceVaultOverride = process.env.THREADLEAF_EXCALIDRAW_SOURCE_VAULT?.trim();
const sourceVault = sourceVaultOverride ? path.resolve(sourceVaultOverride) : fixtureVault;
const installedPluginMatrixRoot = process.env.THREADLEAF_INSTALLED_PLUGIN_MATRIX_ROOT?.trim();
const installedThemeMatrixRoot = process.env.THREADLEAF_INSTALLED_THEME_MATRIX_ROOT?.trim();
const minimalSettingsPluginPath = process.env.THREADLEAF_MINIMAL_SETTINGS_PLUGIN_PATH?.trim();
const minimalSettingsPluginVersion =
  process.env.THREADLEAF_MINIMAL_SETTINGS_VERSION?.trim() || "8.2.3";
const templaterPluginPath = process.env.THREADLEAF_TEMPLATER_PLUGIN_PATH?.trim();
const advancedTablesPluginPath = process.env.THREADLEAF_ADVANCED_TABLES_PLUGIN_PATH?.trim();
const installedPluginMatrixClean = process.env.THREADLEAF_INSTALLED_PLUGIN_MATRIX_CLEAN === "1";
const pluginId = "obsidian-excalidraw-plugin";
const pluginVersion = process.env.THREADLEAF_EXCALIDRAW_VERSION?.trim() || "2.26.4";
const pluginProfileVariant = process.env.THREADLEAF_EXCALIDRAW_PROFILE_VARIANT?.trim() || "";
const repository = "zsviczian/obsidian-excalidraw-plugin";
const authorityProfilePath = path.join(
  appRoot,
  "scripts",
  "compatibility",
  "trust",
  `${pluginId}-${pluginVersion}${pluginProfileVariant}.authority-profile.json`,
);
const pinnedPlugin =
  pluginVersion === "2.25.3" && pluginProfileVariant === "-obsidian-installed"
    ? {
        id: pluginId,
        version: pluginVersion,
        manifestSha256: "43f18bc17c5c3f76af1a9a4191daa1c3566e2875aa4430561d57b7828785282e",
        manifestBytes: 463,
        mainSha256: "3baa63e288992c910fa5ac10e3811aaea4210211b29781446c07259b6df96391",
        mainBytes: 4_898_066,
        stylesSha256: "236a113fee3581ec59856af22c6cecf79faf3521afae66227a40f6ff6cd98969",
        stylesBytes: 205_354,
      }
    : {
        id: pluginId,
        version: pluginVersion,
        manifestSha256: "f6b817daea2fa2106671a62d7236cdc8d806f52465f1ff3ab5343231c020b703",
        manifestBytes: 463,
        mainSha256: "b26f3fc8cfa39cfefe8c11c82e43f80afdc642d8ca4d4ece3bdd817f72d4cf5a",
        mainBytes: 5_106_385,
        stylesSha256: "615b560c5193b2ca4ef3ff1844d2807913bc51c40333c79fdd08a840b0c42735",
        stylesBytes: 224_752,
      };
const electronPath = path.join(appRoot, "node_modules", ".bin", "electron");
const screenshotDirectoryOverride = process.env.THREADLEAF_EXCALIDRAW_SCREENSHOT_DIR;
const keepTemporaryRoot = process.env.THREADLEAF_EXCALIDRAW_KEEP_TEMP === "1";
const compatibilityTopology =
  process.env.THREADLEAF_EXCALIDRAW_TOPOLOGY === "trusted-workspace"
    ? "trusted-workspace"
    : "isolated";
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-excalidraw-e2e-"));
const vaultPath = path.join(testRoot, "vault");
const secondVaultPath = path.join(testRoot, "vault-two");
const pickerLink = path.join(testRoot, "picker-target");
const userDataPath = path.join(testRoot, "user-data");
const pluginPath = path.join(vaultPath, ".obsidian", "plugins", pluginId);
const installedMatrixPlugins = [
  { id: "calendar-beta", version: "2.0.0" },
  { id: "data-files-editor", version: "1.3.0" },
  { id: "obsidian-icon-folder", version: "2.14.7" },
  { id: "obsidian-minimal-settings", version: minimalSettingsPluginVersion },
  { id: "omnisearch", version: "1.30.1" },
  ...(advancedTablesPluginPath ? [{ id: "table-editor-obsidian", version: "0.22.1" }] : []),
  ...(templaterPluginPath ? [{ id: "templater-obsidian", version: "2.25.0" }] : []),
];
const screenshotDirectory = screenshotDirectoryOverride ?? path.join(testRoot, "screenshots");
const output = [];
const screenshots = [];
const cdpRequestTimeout = 15_000;
let child = null;
let cdp = null;
let pluginCdp = null;
let mainTargetId = null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function excalidrawSceneSemanticDigest(bytes) {
  const source = bytes.toString("utf8");
  const fence = /```json[ \t]*\r?\n([\s\S]*?)\r?\n```/u.exec(source);
  assert(fence, "The settings byte-preservation fixture has no uncompressed scene fence.");
  const scene = JSON.parse(fence[1]);
  const markdown = `${source.slice(0, fence.index)}<threadleaf-scene>${source.slice(
    fence.index + fence[0].length,
  )}`;
  return sha256(
    Buffer.from(
      JSON.stringify({
        markdown,
        scene: {
          type: scene.type,
          version: scene.version,
          source: scene.source,
          elements: scene.elements,
          files: scene.files,
        },
      }),
    ),
  );
}

async function waitForStableFileBytes(filePath, quietMs = 1_200, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let bytes = await fs.readFile(filePath);
  let digest = sha256(bytes);
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await delay(100);
    const candidate = await fs.readFile(filePath);
    const candidateDigest = sha256(candidate);
    if (candidateDigest !== digest) {
      bytes = candidate;
      digest = candidateDigest;
      stableSince = Date.now();
      continue;
    }
    if (Date.now() - stableSince >= quietMs) return bytes;
  }
  throw new Error(`File did not settle before the acceptance deadline: ${filePath}`);
}

async function waitForExactFileText(filePath, expected, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let observed = null;
  while (Date.now() < deadline) {
    observed = await fs.readFile(filePath, "utf8").catch(() => null);
    if (observed === expected) return observed;
    await delay(80);
  }
  throw new Error(
    `File did not reach the expected text before the acceptance deadline: ${JSON.stringify({ filePath, expected, observed })}`,
  );
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string", "Could not reserve the isolated CDP port.");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  const networkRequests = new Map();
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
      networkRequests.set(message.params.requestId, message.params.request?.url);
      return;
    }
    if (message.method === "Network.loadingFailed") {
      const url = networkRequests.get(message.params.requestId) ?? "<unknown>";
      const excalidrawFontFailure =
        url.includes("/excalidraw-assets/Xiaolai-Regular-") && url.endsWith(".woff2");
      if (
        !excalidrawFontFailure ||
        !output.some((line) => line.startsWith("[renderer:network-error] Excalidraw font assets"))
      ) {
        output.push(
          excalidrawFontFailure
            ? `[renderer:network-error] Excalidraw font assets ${message.params.errorText ?? "failed"} ${message.params.blockedReason ?? ""}\n`
            : `[renderer:network-error] ${url} ${message.params.errorText ?? "failed"} ${message.params.blockedReason ?? ""}\n`,
        );
      }
      while (output.length > 80) output.shift();
      networkRequests.delete(message.params.requestId);
      return;
    }
    if (message.method === "Runtime.consoleAPICalled") {
      const kind = message.params?.type ?? "log";
      const values = (message.params?.args ?? []).map((argument) => {
        const value = String(argument.value ?? argument.description ?? argument.type);
        return value.length > 2_000 ? `${value.slice(0, 2_000)}...[truncated]` : value;
      });
      output.push(`[renderer:${kind}] ${values.join(" ")}\n`);
      while (output.length > 80) output.shift();
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
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
      const id = ++sequence;
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

async function waitForTarget(port, predicate, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const target = (await cdpTargets(port)).find(predicate);
      if (target?.webSocketDebuggerUrl) return target;
    } catch {
      // Electron is still starting or replacing a plugin renderer.
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

async function waitFor(connection, predicate, label, timeout = 15_000) {
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
  const target = await evaluate(
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
        hitTag: hit?.tagName ?? null,
        hitClass: hit instanceof HTMLElement ? hit.className : null,
        targetTag: root.tagName,
        targetClass: root instanceof HTMLElement ? root.className : null,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        width: rect.width,
        height: rect.height,
      };
    })()`,
  );
  assert(target && !target.error, `Pointer target is unavailable: ${selector}`);
  assert(!target.disabled, `Pointer target is disabled: ${selector}`);
  assert(
    !target.hidden && target.width > 0 && target.height > 0,
    `Pointer target is hidden: ${selector}`,
  );
  assert(target.hit, `Pointer target is covered: ${selector}: ${JSON.stringify(target)}`);
  return target;
}

async function clickSelector(connection, selector) {
  await targetCenter(connection, selector);
  await evaluate(
    connection,
    "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
  const target = await targetCenter(connection, selector);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await connection.send("Input.dispatchMouseEvent", {
      type,
      button: type === "mouseMoved" ? "none" : "left",
      buttons: type === "mousePressed" ? 1 : 0,
      clickCount: type === "mouseMoved" ? 0 : 1,
      x: target.x,
      y: target.y,
    });
  }
}

async function closeVisibleSettingsSurface(label) {
  const state = await evaluate(
    cdp,
    `(() => {
      const dialog = document.querySelector('#shortcut-settings');
      const close = document.querySelector('#settings-close');
      const pluginHost = document.querySelector('#plugin-surface-host');
      return {
        threadleafSettings:
          dialog instanceof HTMLDialogElement &&
          dialog.open &&
          close instanceof HTMLButtonElement &&
          !close.hidden,
        pluginSettings:
          pluginHost instanceof HTMLElement &&
          !pluginHost.hidden &&
          Boolean(pluginHost.querySelector('.threadleaf-plugin-settings-surface')),
      };
    })()`,
  );
  if (state.threadleafSettings) {
    await clickSelector(cdp, "#settings-close");
    await waitFor(
      cdp,
      "document.querySelector('#shortcut-settings')?.open !== true",
      `${label} Threadleaf settings close`,
    );
    return "threadleaf-settings";
  }
  if (state.pluginSettings) {
    await waitFor(
      cdp,
      "document.querySelector('#edit-view')?.disabled === false",
      `${label} native note return`,
    );
    await clickSelector(cdp, "#edit-view");
    await waitFor(
      cdp,
      "document.querySelector('#plugin-surface-host')?.hidden === true",
      `${label} plugin settings close`,
    );
    return "plugin-settings";
  }
  return "already-closed";
}

async function clickRowAction(connection, containerSelector, label) {
  const selector = await evaluate(
    connection,
    `(() => {
      document.querySelectorAll('#threadleaf-e2e-row-action').forEach((candidate) => candidate.removeAttribute('id'));
      const container = document.querySelector(${JSON.stringify(containerSelector)});
      const button = [...(container?.querySelectorAll('button') ?? [])].find(
        (candidate) => candidate.textContent?.trim() === ${JSON.stringify(label)}
      );
      if (!(button instanceof HTMLButtonElement) || button.disabled) return null;
      button.id = 'threadleaf-e2e-row-action';
      return '#threadleaf-e2e-row-action';
    })()`,
  );
  assert(selector, `Row action is unavailable: ${label}`);
  await clickSelector(connection, selector);
}

async function pressKey(connection, key, code, modifiers = 0) {
  const eventKey = key.length === 1 && modifiers !== 0 ? key.toUpperCase() : key;
  const windowsVirtualKeyCode =
    eventKey.length === 1
      ? eventKey.charCodeAt(0)
      : { Enter: 13, Escape: 27, Home: 36, End: 35, ArrowLeft: 37, ArrowRight: 39 }[key];
  assert(windowsVirtualKeyCode, `Unsupported CDP key: ${key}`);
  await connection.send("Input.dispatchKeyEvent", {
    type: key.length === 1 && modifiers === 0 ? "keyDown" : "rawKeyDown",
    code,
    key: eventKey,
    modifiers,
    windowsVirtualKeyCode,
    nativeVirtualKeyCode: windowsVirtualKeyCode,
    text: key.length === 1 && modifiers === 0 ? key : undefined,
  });
  await connection.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    code,
    key: eventKey,
    modifiers,
    windowsVirtualKeyCode,
    nativeVirtualKeyCode: windowsVirtualKeyCode,
  });
}

async function measureResponse(connection, label) {
  const milliseconds = await evaluate(
    connection,
    `(async () => {
      const started = performance.now();
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      return performance.now() - started;
    })()`,
  );
  assert(
    typeof milliseconds === "number" && Number.isFinite(milliseconds) && milliseconds < 1_000,
    `${label} did not respond within 1 second: ${milliseconds}`,
  );
  return Math.round(milliseconds * 100) / 100;
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

async function isolatedElectronMainProcessId() {
  assert(child?.pid, "The isolated Electron process is unavailable for crash recovery.");
  const candidates = (await descendantProcesses(child.pid))
    .filter(
      (process) =>
        process.commandLine.includes("/electron/dist/electron ") &&
        !process.commandLine.includes("--type="),
    )
    .map((process) => process.pid);
  assert(candidates.length <= 1, `Found multiple isolated Electron main processes: ${candidates}`);
  return candidates[0] ?? null;
}

async function capture(connection, label, theme) {
  await fs.mkdir(screenshotDirectory, { recursive: true });
  const currentTheme = await evaluate(connection, "document.documentElement.dataset.theme");
  const hasThemeToggle = await evaluate(
    connection,
    "Boolean(document.querySelector('#theme-toggle'))",
  );
  if (hasThemeToggle) {
    if (currentTheme !== theme) {
      await evaluate(connection, "document.querySelector('#theme-toggle')?.click(); true");
    }
  } else {
    await evaluate(
      connection,
      `(() => { const dark = ${JSON.stringify(theme)} === 'dark'; document.documentElement.dataset.theme = ${JSON.stringify(theme)}; for (const target of [document.documentElement, document.body]) { target.classList.toggle('theme-dark', dark); target.classList.toggle('theme-light', !dark); } return true; })()`,
    );
  }
  await waitFor(
    connection,
    `document.documentElement.dataset.theme === ${JSON.stringify(theme)}`,
    `${label} ${theme} theme`,
  );
  await waitFor(
    connection,
    `(() => { const surface = document.querySelector('.excalidraw'); if (!surface) return true; const dark = surface.classList.contains('theme--dark'); return ${JSON.stringify(theme)} === 'dark' ? dark : !dark; })()`,
    `${label} ${theme} Excalidraw theme`,
  );
  const shot = await connection.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  const filePath = path.join(screenshotDirectory, `${label}-${theme}.png`);
  const bytes = Buffer.from(shot.data, "base64");
  await fs.writeFile(filePath, bytes);
  assert(bytes.length > 1_000, `${label} ${theme} screenshot is unexpectedly empty.`);
  screenshots.push(filePath);
  return { filePath, digest: sha256(bytes) };
}

async function captureCurrentTheme(connection, label) {
  const theme = await evaluate(connection, "document.documentElement.dataset.theme");
  assert(theme === "dark" || theme === "light", `${label} has no active screenshot theme.`);
  return capture(connection, label, theme);
}

async function fetchPublicPlugin() {
  const supplied = process.env.THREADLEAF_EXCALIDRAW_PLUGIN_PATH?.trim();
  if (supplied) {
    const base = path.resolve(supplied);
    const manifestBytes = await fs.readFile(path.join(base, "manifest.json"));
    const main = await fs.readFile(path.join(base, "main.js"));
    const styles = (await exists(path.join(base, "styles.css")))
      ? await fs.readFile(path.join(base, "styles.css"))
      : null;
    return {
      manifest: JSON.parse(manifestBytes.toString("utf8")),
      manifestBytes,
      main,
      styles,
      source: `local:${base}`,
    };
  }
  const releaseRoot = `https://github.com/${repository}/releases/download/${pluginVersion}`;
  async function get(filename, optional = false) {
    let failure = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(`${releaseRoot}/${filename}`, {
          headers: { "User-Agent": "Threadleaf Excalidraw round-trip gate" },
          redirect: "follow",
          signal: AbortSignal.timeout(20_000),
        });
        if (optional && response.status === 404) return null;
        assert(
          response.ok,
          `Public Excalidraw ${filename} download returned HTTP ${response.status}.`,
        );
        const finalUrl = new URL(response.url);
        assert(
          finalUrl.protocol === "https:" &&
            (finalUrl.hostname === "github.com" ||
              finalUrl.hostname.endsWith("githubusercontent.com")),
          `Public Excalidraw ${filename} redirected outside GitHub: ${finalUrl.hostname}`,
        );
        return Buffer.from(await response.arrayBuffer());
      } catch (error) {
        failure = error;
        if (attempt < 3) await delay(attempt * 250);
      }
    }
    const message = failure instanceof Error ? failure.message : String(failure);
    throw new Error(`Public Excalidraw ${filename} download failed after 3 attempts: ${message}`);
  }
  const manifestBytes = await get("manifest.json");
  const main = await get("main.js");
  const styles = await get("styles.css", true);
  return {
    manifest: JSON.parse(manifestBytes.toString("utf8")),
    manifestBytes,
    main,
    styles,
    source: `${releaseRoot}/manifest.json,main.js,styles.css`,
  };
}

function assertPinnedPlugin(plugin) {
  assert(
    plugin.manifest.id === pinnedPlugin.id,
    `Expected ${pinnedPlugin.id}, got ${plugin.manifest.id}.`,
  );
  assert(
    plugin.manifest.version === pinnedPlugin.version,
    `Expected Excalidraw ${pinnedPlugin.version}, got ${plugin.manifest.version}.`,
  );
  assert(
    Buffer.isBuffer(plugin.manifestBytes) &&
      plugin.manifestBytes.length === pinnedPlugin.manifestBytes &&
      sha256(plugin.manifestBytes) === pinnedPlugin.manifestSha256,
    `Excalidraw manifest bytes did not match pinned ${pinnedPlugin.manifestBytes}-byte SHA-256 ${pinnedPlugin.manifestSha256}.`,
  );
  assert(
    Buffer.isBuffer(plugin.main) && plugin.main.length === pinnedPlugin.mainBytes,
    `Excalidraw main.js size did not match pinned ${pinnedPlugin.mainBytes} bytes.`,
  );
  assert(
    sha256(plugin.main) === pinnedPlugin.mainSha256,
    `Excalidraw main.js bytes did not match pinned SHA-256 ${pinnedPlugin.mainSha256}.`,
  );
  assert(
    Buffer.isBuffer(plugin.styles) && plugin.styles.length === pinnedPlugin.stylesBytes,
    `Excalidraw styles.css size did not match pinned ${pinnedPlugin.stylesBytes} bytes.`,
  );
  assert(
    sha256(plugin.styles) === pinnedPlugin.stylesSha256,
    `Excalidraw styles.css bytes did not match pinned SHA-256 ${pinnedPlugin.stylesSha256}.`,
  );
}

async function exactReviewedIdentity(plugin) {
  const profile = JSON.parse(await fs.readFile(authorityProfilePath, "utf8"));
  const files = [
    {
      path: "manifest.json",
      sha256: sha256(plugin.manifestBytes),
      size: plugin.manifestBytes.length,
    },
    { path: "main.js", sha256: sha256(plugin.main), size: plugin.main.length },
    { path: "styles.css", sha256: sha256(plugin.styles), size: plugin.styles.length },
  ].sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  const packageIdentity = {
    pluginId,
    manifestVersion: pluginVersion,
    distributionTag: profile.packageIdentity.distributionTag,
    manifestSha256: pinnedPlugin.manifestSha256,
    mainSha256: pinnedPlugin.mainSha256,
    stylesSha256: pinnedPlugin.stylesSha256,
    packageTreeSha256: authorityJsonSha256({ schemaVersion: 1, files }),
  };
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
  const packageIdentityDigest = authorityJsonSha256(packageIdentity);
  assert(
    profile.profileId === `${pluginId}-${pluginVersion}${pluginProfileVariant}` &&
      profile.packageIdentityDigest === packageIdentityDigest &&
      authorityJsonSha256(profile.packageIdentity) === packageIdentityDigest,
    "The Excalidraw release bytes did not match the exact reviewed package identity.",
  );
  assert(
    authorityJsonSha256(authorityPayload) === profile.authorityDigest,
    "The Excalidraw reviewed authority profile digest was stale.",
  );
  return {
    profileId: profile.profileId,
    profileRevision: profile.profileRevision,
    authorityDigest: profile.authorityDigest,
    packageIdentity,
    packageIdentityDigest,
  };
}

async function writePluginFixture() {
  const plugin = await fetchPublicPlugin();
  assertPinnedPlugin(plugin);
  const reviewedIdentity = await exactReviewedIdentity(plugin);
  await fs.mkdir(pluginPath, { recursive: true });
  await fs.writeFile(path.join(pluginPath, "manifest.json"), plugin.manifestBytes);
  await fs.writeFile(path.join(pluginPath, "main.js"), plugin.main);
  if (plugin.styles) await fs.writeFile(path.join(pluginPath, "styles.css"), plugin.styles);
  await fs.writeFile(
    path.join(pluginPath, "data.json"),
    JSON.stringify(pluginFixtureSettings(false)),
  );
  return {
    ...plugin,
    ...reviewedIdentity,
    manifestSha256: sha256(plugin.manifestBytes),
    mainSha256: sha256(plugin.main),
    mainBytes: plugin.main.length,
    stylesSha256: plugin.styles ? sha256(plugin.styles) : null,
  };
}

async function prepareInstalledPluginMatrix() {
  if (!installedPluginMatrixRoot) return;
  for (const plugin of installedMatrixPlugins) {
    const source =
      plugin.id === "obsidian-minimal-settings" && minimalSettingsPluginPath
        ? path.resolve(minimalSettingsPluginPath)
        : plugin.id === "templater-obsidian" && templaterPluginPath
          ? path.resolve(templaterPluginPath)
          : plugin.id === "table-editor-obsidian" && advancedTablesPluginPath
            ? path.resolve(advancedTablesPluginPath)
            : path.join(path.resolve(installedPluginMatrixRoot), plugin.id);
    const target = path.join(vaultPath, ".obsidian", "plugins", plugin.id);
    assert(await exists(source), `Installed matrix source is missing: ${plugin.id}`);
    await fs.cp(source, target, { recursive: true });
  }
  const installedIconsRoot = path.join(
    path.dirname(path.resolve(installedPluginMatrixRoot)),
    "icons",
  );
  if (!installedPluginMatrixClean && (await exists(installedIconsRoot))) {
    await fs.cp(installedIconsRoot, path.join(vaultPath, ".obsidian", "icons"), {
      recursive: true,
    });
  }
  if (installedThemeMatrixRoot) {
    const source = path.resolve(installedThemeMatrixRoot);
    const target = path.join(vaultPath, ".obsidian", "themes", "Minimal");
    assert(await exists(source), "Installed Minimal theme matrix source is missing.");
    await fs.cp(source, target, { recursive: true });
  }
  await fs.mkdir(path.join(vaultPath, "Data"), { recursive: true });
  await fs.writeFile(
    path.join(vaultPath, "Data", "sample.json"),
    `${JSON.stringify({ project: "Threadleaf", status: "matrix", count: 3 }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(vaultPath, "Data", "sample.yaml"),
    "project: Threadleaf\nstatus: matrix\ncount: 3\n",
  );
  await fs.mkdir(path.join(vaultPath, "Journal"), { recursive: true });
  await fs.mkdir(path.join(vaultPath, "Templates"), { recursive: true });
  await fs.writeFile(
    path.join(vaultPath, "Templates", "Daily.md"),
    "# {{date:dddd, MMMM D, YYYY}}\n\nCalendar fixture.\n",
  );
  if (templaterPluginPath) {
    await fs.writeFile(
      path.join(vaultPath, "Templates", "Hotkey.md"),
      "Templater hotkey works in <% tp.file.title %>.\n",
    );
    await fs.writeFile(path.join(vaultPath, "Notes", "Templater Target.md"), "Before\n");
    await fs.writeFile(path.join(vaultPath, "Notes", "Templater Restart.md"), "Restart\n");
  }
  if (advancedTablesPluginPath) {
    const malformedTable = "| Name|Count |\n|---|---|\n| Alpha|1|\n| Longer name|22|\n";
    await fs.writeFile(path.join(vaultPath, "Notes", "Advanced Tables.md"), malformedTable);
    await fs.writeFile(path.join(vaultPath, "Notes", "Advanced Tables Restart.md"), malformedTable);
  }
}

async function grantAndEnableInstalledPlugin(candidate) {
  const installedRow = `.plugin-row[data-plugin-id=${JSON.stringify(candidate.id)}]`;
  await waitFor(
    cdp,
    `Boolean(document.querySelector(${JSON.stringify(installedRow)}))`,
    `${candidate.id} installed row`,
  );
  const version = await evaluate(
    cdp,
    `(() => {
      const row = document.querySelector(${JSON.stringify(installedRow)});
      return {
        text: row?.textContent ?? '',
        actions: [...(row?.querySelectorAll('button') ?? [])].map((button) => ({
          label: button.textContent?.trim() ?? '',
          disabled: button.disabled,
        })),
      };
    })()`,
  );
  assert(
    version.text.includes(candidate.version),
    `${candidate.id} exact version was not visible.`,
  );
  await waitFor(
    cdp,
    `(() => [...(document.querySelector(${JSON.stringify(installedRow)})?.querySelectorAll('button') ?? [])].some((button) => button.textContent?.trim() === 'Review authority' && !button.disabled))()`,
    `${candidate.id} authority action was unavailable: ${JSON.stringify(version)}`,
    30_000,
  );
  await evaluate(
    cdp,
    `(() => {
      const button = [...(document.querySelector(${JSON.stringify(installedRow)})?.querySelectorAll('button') ?? [])]
        .find((candidate) => candidate.textContent?.trim() === 'Review authority');
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.click();
      return true;
    })()`,
  );
  await waitFor(
    cdp,
    "document.querySelector('#plugin-authority-review-dialog')?.open === true",
    `${candidate.id} authority review`,
  );
  await clickSelector(cdp, "#plugin-authority-review-grant");
  await waitFor(
    cdp,
    `document.querySelector(${JSON.stringify(installedRow)})?.textContent?.includes('Exact bundle granted')`,
    `${candidate.id} exact authority grant`,
  );
  await waitFor(
    cdp,
    `(() => { const toggle = document.querySelector(${JSON.stringify(`${installedRow} .plugin-toggle input`)}); return toggle instanceof HTMLInputElement && !toggle.disabled && !toggle.checked; })()`,
    `${candidate.id} enabled toggle readiness`,
    30_000,
  );
  const stabilityMarker = `threadleaf-e2e-${candidate.id}-${Date.now()}`;
  const stabilityDeadline = Date.now() + 15_000;
  let stableToggle = false;
  while (Date.now() < stabilityDeadline) {
    await evaluate(
      cdp,
      `(() => { const toggle = document.querySelector(${JSON.stringify(`${installedRow} .plugin-toggle input`)}); if (!(toggle instanceof HTMLInputElement) || toggle.disabled || toggle.checked) return false; toggle.dataset.threadleafE2eStability = ${JSON.stringify(stabilityMarker)}; return true; })()`,
    );
    await delay(600);
    stableToggle = await evaluate(
      cdp,
      `document.querySelector(${JSON.stringify(`${installedRow} .plugin-toggle input`)})?.getAttribute('data-threadleaf-e2e-stability') === ${JSON.stringify(stabilityMarker)}`,
    );
    if (stableToggle) break;
  }
  assert(stableToggle, `${candidate.id} toggle never reached a stable rendered interval.`);
  await clickSelector(cdp, `${installedRow} .plugin-toggle-track`);
  const activation = await waitFor(
    cdp,
    `(async () => {
      const snapshot = await window.threadleaf.getSnapshot();
      const plugin = snapshot.plugins?.find((item) => item.id === ${JSON.stringify(candidate.id)});
      return plugin?.state === 'loaded' || plugin?.state === 'failed'
        ? { plugin, events: snapshot.events?.slice(-30), integrations: snapshot.integrations }
        : null;
    })()`,
    `${candidate.id} visible activation`,
    30_000,
  ).catch(async (error) => {
    const snapshot = await evaluate(cdp, "window.threadleaf.getSnapshot()");
    const row = await evaluate(
      cdp,
      `document.querySelector(${JSON.stringify(installedRow)})?.textContent ?? null`,
    );
    const interfaceState = await evaluate(
      cdp,
      `({ pluginStatus: document.querySelector('#plugin-status')?.textContent ?? null, pluginStatusKind: document.querySelector('#plugin-status')?.getAttribute('data-kind') ?? null, toast: document.querySelector('#toast')?.textContent ?? null, toggle: (() => { const input = document.querySelector(${JSON.stringify(`${installedRow} .plugin-toggle input`)}); return input instanceof HTMLInputElement ? { checked: input.checked, disabled: input.disabled } : null; })() })`,
    );
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}: ${JSON.stringify({
        plugin: snapshot.plugins?.find((item) => item.id === candidate.id),
        events: snapshot.events?.slice(-50),
        integrations: snapshot.integrations,
        row,
        interfaceState,
      })}`,
    );
  });
  assert(
    activation.plugin.state === "loaded",
    `${candidate.id} activation failed: ${JSON.stringify(activation)}`,
  );
  return activation;
}

async function verifyInstalledPluginMatrixRestart(vaultId, port) {
  let snapshot;
  try {
    snapshot = await waitFor(
      cdp,
      `(async () => { const snapshot = await window.threadleaf.getSnapshot(); const ids = ${JSON.stringify(installedMatrixPlugins.map(({ id }) => id))}; return snapshot.vault.id === ${JSON.stringify(vaultId)} && ids.every((id) => snapshot.plugins?.some((plugin) => plugin.id === id && plugin.state === 'loaded')) && !snapshot.events.some((event) => event.kind === 'error') ? snapshot : null; })()`,
      "installed plugin matrix restart activation",
      60_000,
    );
  } catch (error) {
    const diagnostic = await evaluate(
      cdp,
      `(async () => { const snapshot = await window.threadleaf.getSnapshot(); const catalog = await window.threadleaf.getPlugins(snapshot.vault.id); return { vault: snapshot.vault, workspace: snapshot.workspace?.state, plugins: snapshot.plugins, events: snapshot.events.slice(-60), enabled: (await window.threadleaf.getSettings()).pluginsByVault?.[snapshot.vault.id]?.enabledPluginIds, catalog: catalog.catalog?.plugins?.filter((plugin) => ${JSON.stringify(installedMatrixPlugins.map(({ id }) => id))}.includes(plugin.id)) }; })()`,
    ).catch(() => null);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}: ${JSON.stringify(diagnostic)}`,
    );
  }

  const calendarSurface = await connectPluginSurfaceBySelector(
    port,
    "#calendar-container .calendar",
    "restarted Calendar right-dock view",
    45_000,
  );
  let calendar;
  try {
    calendar = await waitFor(
      calendarSurface.connection,
      `(() => { const today = document.querySelector('#calendar-container .today'); return today && today.querySelectorAll('.dot').length > 0 ? { today: today.textContent?.trim() ?? '', dots: today.querySelectorAll('.dot').length } : null; })()`,
      "restarted Calendar daily-note marker",
      30_000,
    );
    const dock = await waitFor(
      cdp,
      `(() => { const host = document.querySelector('#plugin-dock-surface-host'); const note = document.querySelector('#note-view'); if (!(host instanceof HTMLElement) || !(note instanceof HTMLElement)) return null; const bounds = host.getBoundingClientRect(); return !host.hidden && !note.hidden && bounds.width >= 240 && bounds.height >= 400 ? { width: bounds.width, height: bounds.height } : null; })()`,
      "restarted Calendar physical dock",
      20_000,
    );
    calendar = { ...calendar, dock };
  } finally {
    calendarSurface.connection.close();
  }

  await openNavigatorPluginDocument("Data/sample.json");
  const dataSurface = await connectPluginSurfaceBySelector(
    port,
    ".datafile-source-view .cm-editor",
    "restarted Data Files Editor JSON view",
  );
  try {
    await waitFor(
      dataSurface.connection,
      "document.querySelector('.datafile-source-view .cm-content')?.textContent?.includes('edited-through-plugin') === true",
      "restarted Data Files Editor content",
      20_000,
    );
  } finally {
    dataSurface.connection.close();
  }

  await evaluate(cdp, 'window.threadleaf.openNote("Notes/Source.md")');
  await waitFor(
    cdp,
    `(async () => (await window.threadleaf.getSnapshot()).navigatorDecorations?.some((decoration) => decoration.path === 'Notes/Source.md' && decoration.text === '🌟') === true)()`,
    "restarted Iconize navigator projection",
    30_000,
  );
  await clickSelector(cdp, "#reveal-active-note");
  await waitFor(
    cdp,
    `document.querySelector('.navigator-tree-row[data-tree-path="Notes/Source.md"] .navigator-plugin-decoration')?.textContent === '🌟'`,
    "restarted Iconize native navigator decoration",
    20_000,
  );

  let minimal;
  try {
    minimal = await waitFor(
      cdp,
      `(() => { const font = getComputedStyle(document.querySelector('.cm-content')).fontSize; const value = getComputedStyle(document.body).getPropertyValue('--font-text-size').trim(); return document.body.classList.contains('minimal-theme') && value === '16.5px' && font === '16.5px' ? { font, value } : null; })()`,
      "restarted Minimal native appearance",
      30_000,
    );
  } catch (error) {
    const diagnostic = await evaluate(
      cdp,
      `(async () => { const snapshot = await window.threadleaf.getSnapshot(); const body = getComputedStyle(document.body); const editor = document.querySelector('.cm-content'); return { pluginAppearance: snapshot.pluginAppearance, bodyClasses: [...document.body.classList], bodyFontVariable: body.getPropertyValue('--font-text-size').trim(), editorFont: editor ? getComputedStyle(editor).fontSize : null, plugin: snapshot.plugins?.find((item) => item.id === 'obsidian-minimal-settings'), events: snapshot.events.slice(-30) }; })()`,
    ).catch(() => null);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}: ${JSON.stringify(diagnostic)}`,
    );
  }
  const omnisearch = await verifyOmnisearchWorkflow(vaultId, port);
  const advancedTables = advancedTablesPluginPath
    ? await verifyAdvancedTablesRestartWorkflow(vaultId)
    : undefined;
  const templater = templaterPluginPath ? await verifyTemplaterRestartWorkflow(vaultId) : undefined;
  return {
    pluginStates: installedMatrixPlugins.map(({ id }) => ({
      id,
      state: snapshot.plugins.find((plugin) => plugin.id === id)?.state ?? "missing",
    })),
    calendar,
    dataFile: "Data/sample.json",
    icon: "🌟",
    minimal,
    omnisearch,
    ...(advancedTables ? { advancedTables } : {}),
    ...(templater ? { templater } : {}),
  };
}

async function runInstalledPluginMatrix(vaultId, port, pluginState) {
  await clickSelector(cdp, "#settings-trigger");
  await waitFor(
    cdp,
    "document.querySelector('#shortcut-settings')?.open === true",
    "installed plugin matrix settings",
  );
  await clickSelector(cdp, "#settings-nav-plugins");
  const activations = [];
  for (const candidate of installedMatrixPlugins) {
    activations.push({ id: candidate.id, ...(await grantAndEnableInstalledPlugin(candidate)) });
  }
  const snapshot = await evaluate(cdp, "window.threadleaf.getSnapshot()");
  for (const candidate of installedMatrixPlugins) {
    const plugin = snapshot.plugins?.find((item) => item.id === candidate.id);
    assert(
      plugin?.state === "loaded",
      `${candidate.id} did not remain loaded after the combined matrix: ${JSON.stringify(plugin)}`,
    );
  }
  const registrationSummary = installedMatrixPlugins.map((candidate) => ({
    id: candidate.id,
    commandCount: (snapshot.commands ?? []).filter((command) => command.ownerId === candidate.id)
      .length,
    commandIds: (snapshot.commands ?? [])
      .filter((command) => command.ownerId === candidate.id)
      .map((command) => command.id),
    hasSettings: (snapshot.integrations?.settingTabPluginIds ?? []).includes(candidate.id),
  }));
  for (const registration of registrationSummary) {
    assert(registration.hasSettings, `${registration.id} did not expose its settings surface.`);
  }
  if (installedThemeMatrixRoot) {
    await clickSelector(cdp, "#settings-nav-appearance");
    const minimalThemeId = await waitFor(
      cdp,
      `(() => { const select = document.querySelector('#appearance-theme'); if (!(select instanceof HTMLSelectElement) || select.disabled) return null; return [...select.options].find((option) => option.textContent?.startsWith('Minimal'))?.value ?? null; })()`,
      "installed Minimal theme option",
      20_000,
    );
    await evaluate(
      cdp,
      `(() => { const select = document.querySelector('#appearance-theme'); if (!(select instanceof HTMLSelectElement)) return false; select.value = ${JSON.stringify(minimalThemeId)}; select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
    );
    await waitFor(
      cdp,
      `document.querySelector('#appearance-theme')?.value === ${JSON.stringify(minimalThemeId)} && document.body.classList.contains('minimal-theme')`,
      "installed Minimal theme activation",
      20_000,
    );
  }
  await waitFor(
    cdp,
    "document.querySelector('#settings-close')?.disabled === false",
    "installed plugin matrix settings completion",
  );
  await closeVisibleSettingsSurface("installed plugin matrix");
  const workflowSummary = [
    await verifyCalendarWorkflow(vaultId, port),
    await verifyDataFilesEditorWorkflow(vaultId, port),
    await verifyIconizeWorkflow(vaultId, port),
    await verifyMinimalSettingsWorkflow(vaultId, port),
    await verifyOmnisearchWorkflow(vaultId, port),
    ...(advancedTablesPluginPath ? [await verifyAdvancedTablesWorkflow(vaultId)] : []),
    ...(templaterPluginPath ? [await verifyTemplaterWorkflow(vaultId)] : []),
  ];
  await closeApp();
  const restartPort = await availablePort();
  const restarted = await startApp(restartPort, pluginState, { prepareAuthority: false });
  assert(
    restarted.vaultId === vaultId,
    "Installed plugin matrix restart changed the vault identity.",
  );
  const restart = await verifyInstalledPluginMatrixRestart(restarted.vaultId, restartPort);
  console.log(
    JSON.stringify(
      {
        status: "activation-matrix-passed",
        vaultId,
        plugins: registrationSummary,
        integrations: snapshot.integrations,
        workflows: workflowSummary,
        restart,
      },
      null,
      2,
    ),
  );
}

async function connectPluginSurfaceBySelector(
  port,
  selector,
  label,
  timeout = 30_000,
  requirePointerHit = true,
) {
  if (compatibilityTopology === "trusted-workspace") {
    const bounds = await waitFor(
      cdp,
      `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLElement)) return null; const bounds = element.getBoundingClientRect(); if (!${JSON.stringify(requirePointerHit)}) return { width: bounds.width, height: bounds.height }; const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2); return bounds.width > 0 && bounds.height > 0 && hit ? { width: bounds.width, height: bounds.height } : null; })()`,
      label,
      timeout,
    );
    return {
      connection: { close: () => undefined, send: (...args) => cdp.send(...args) },
      target: { id: mainTargetId, url: "trusted-workspace" },
      bounds,
    };
  }
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const targets = (await cdpTargets(port).catch(() => [])).filter(
      (candidate) => candidate.type === "page" && candidate.url.includes("plugin-host.html"),
    );
    for (const target of targets) {
      const candidate = connectCdp(target.webSocketDebuggerUrl);
      try {
        await candidate.send("Page.enable", {}, 2_000);
        await candidate.send("Runtime.enable", {}, 2_000);
        const matched = await evaluate(
          candidate,
          `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLElement)) return null; const bounds = element.getBoundingClientRect(); if (!${JSON.stringify(requirePointerHit)}) return { width: bounds.width, height: bounds.height }; const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2); return bounds.width > 0 && bounds.height > 0 && hit ? { width: bounds.width, height: bounds.height } : null; })()`,
        );
        if (matched) return { connection: candidate, target, bounds: matched };
      } catch {
        // The candidate may still be loading or may belong to another isolated plugin.
      }
      candidate.close();
    }
    await delay(80);
  }
  throw new Error(`${label} did not expose ${selector} in an isolated plugin renderer.`);
}

async function replaceFocusedText(selector, text) {
  const focused = await evaluate(
    cdp,
    `(() => { const input = document.querySelector(${JSON.stringify(selector)}); if (!(input instanceof HTMLInputElement)) return false; input.focus(); input.select(); return true; })()`,
  );
  assert(focused, `Could not focus the text control: ${selector}`);
  await pressKey(cdp, "a", "KeyA", 2);
  await cdp.send("Input.insertText", { text });
}

async function markTemplaterSettingControl(name, controlSelector = "input") {
  return evaluate(
    cdp,
    `(() => {
      document.querySelector('#threadleaf-e2e-templater-control')?.removeAttribute('id');
      const item = [...document.querySelectorAll('.setting-item')].find((candidate) =>
        candidate.querySelector('.setting-item-name')?.textContent?.trim() === ${JSON.stringify(name)}
      );
      const control = item?.querySelector(${JSON.stringify(controlSelector)}) ?? item;
      if (!(control instanceof HTMLElement)) return null;
      control.id = 'threadleaf-e2e-templater-control';
      return '#threadleaf-e2e-templater-control';
    })()`,
  );
}

async function waitForTemplaterData(predicate, label, timeout = 20_000) {
  const filePath = path.join(vaultPath, ".obsidian", "plugins", "templater-obsidian", "data.json");
  const deadline = Date.now() + timeout;
  let observed = null;
  while (Date.now() < deadline) {
    observed = await fs
      .readFile(filePath, "utf8")
      .then((source) => JSON.parse(source))
      .catch(() => null);
    if (observed && predicate(observed)) return observed;
    await delay(80);
  }
  throw new Error(`${label} did not settle: ${JSON.stringify(observed)}`);
}

const advancedTablesInitial = "| Name|Count |\n|---|---|\n| Alpha|1|\n| Longer name|22|\n";
const advancedTablesExpected =
  "| Name        | Count |\n| ----------- | ----- |\n| Alpha       | 1     |\n| Longer name | 22    |\n";

async function runAdvancedTablesFormat(vaultId, notePath) {
  const filePath = path.join(vaultPath, notePath);
  assert(
    (await fs.readFile(filePath, "utf8")) === advancedTablesInitial,
    `Advanced Tables fixture was not pristine before formatting: ${notePath}`,
  );
  await evaluate(
    cdp,
    `(async () => { await window.threadleaf.closePluginView(); return window.threadleaf.openNote(${JSON.stringify(notePath)}); })()`,
  );
  await waitFor(
    cdp,
    `(async () => { const snapshot = await window.threadleaf.getSnapshot(); return snapshot.vault.id === ${JSON.stringify(vaultId)} && snapshot.workspace?.activeNote?.path === ${JSON.stringify(notePath)}; })()`,
    `Advanced Tables target note ${notePath}`,
  );
  await waitFor(
    cdp,
    "(() => { const editor = document.querySelector('.workspace-pane[data-active=\"true\"] .cm-content'); if (!(editor instanceof HTMLElement)) return false; const bounds = editor.getBoundingClientRect(); return bounds.width > 100 && bounds.height > 20; })()",
    `Advanced Tables native editor ${notePath}`,
  );
  await clickSelector(cdp, '.workspace-pane[data-active="true"] .cm-content');
  await pressKey(cdp, "Home", "Home", 2);
  const commandId = "table-editor-obsidian:format-table";
  await waitFor(
    cdp,
    `(async () => (await window.threadleaf.getSnapshot()).commands.some((command) => command.id === ${JSON.stringify(commandId)}))()`,
    "Advanced Tables format command",
  );
  await runPaletteCommand(commandId, "format table", `plugin.command.${commandId}`);
  const content = await waitForExactFileText(filePath, advancedTablesExpected, 30_000);
  await evaluate(cdp, `window.threadleaf.openNote(${JSON.stringify(notePath)})`);
  await waitFor(
    cdp,
    `(async () => {
      const snapshot = await window.threadleaf.getSnapshot();
      const editor = document.querySelector('.workspace-pane[data-active="true"] .cm-content');
      if (!(editor instanceof HTMLElement)) return false;
      const bounds = editor.getBoundingClientRect();
      const text = editor.textContent ?? '';
      return snapshot.workspace?.activeNote?.path === ${JSON.stringify(notePath)} &&
        snapshot.workspace.activeNote.content === ${JSON.stringify(advancedTablesExpected)} &&
        document.querySelector('#note-path')?.textContent === ${JSON.stringify(notePath)} &&
        bounds.width > 100 && bounds.height > 20 &&
        text.includes('Name        | Count') &&
        text.includes('Longer name | 22');
    })()`,
    `Advanced Tables persisted editor surface ${notePath}`,
    20_000,
  );
  const snapshot = await evaluate(cdp, "window.threadleaf.getSnapshot()");
  assert(
    !snapshot.events.some(
      (event) => event.kind === "error" && event.message.toLowerCase().includes("advanced tables"),
    ),
    `Advanced Tables emitted a runtime error: ${JSON.stringify(snapshot.events.slice(-30))}`,
  );
  return {
    notePath,
    commandId,
    content,
    revision: sha256(Buffer.from(content)),
  };
}

async function verifyAdvancedTablesOptions(captureThemes) {
  await clickSelector(cdp, "#settings-trigger");
  await waitFor(
    cdp,
    "document.querySelector('#shortcut-settings')?.open === true",
    "Advanced Tables settings window",
  );
  await clickSelector(cdp, "#settings-nav-plugins");
  await clickRowAction(cdp, '.plugin-row[data-plugin-id="table-editor-obsidian"]', "Options");
  const names = await waitFor(
    cdp,
    `(() => {
      const names = [...document.querySelectorAll('.setting-item-name')].map((item) => item.textContent?.trim() ?? '');
      const expected = ${JSON.stringify([
        "Bind enter to table navigation",
        "Bind tab to table navigation",
        "Pad cell width using spaces",
        "Show icon in sidebar",
      ])};
      return expected.every((name) => names.includes(name)) ? names : null;
    })()`,
    "Advanced Tables four-control settings surface",
    30_000,
  );
  const settingsScreenshots = captureThemes
    ? [
        await capture(cdp, "advanced-tables-settings", "dark"),
        await capture(cdp, "advanced-tables-settings", "light"),
      ]
    : [];
  await closeVisibleSettingsSurface("Advanced Tables");
  return {
    names,
    screenshots: settingsScreenshots.map(({ filePath }) => filePath),
  };
}

async function verifyAdvancedTablesWorkflow(vaultId) {
  return {
    pluginId: "table-editor-obsidian",
    workflow: "format-table-through-command-palette",
    settings: await verifyAdvancedTablesOptions(true),
    note: await runAdvancedTablesFormat(vaultId, "Notes/Advanced Tables.md"),
  };
}

async function verifyAdvancedTablesRestartWorkflow(vaultId) {
  return {
    pluginId: "table-editor-obsidian",
    workflow: "format-table-after-application-restart",
    settings: await verifyAdvancedTablesOptions(false),
    note: await runAdvancedTablesFormat(vaultId, "Notes/Advanced Tables Restart.md"),
  };
}

async function runTemplaterHotkeyOnNote(vaultId, notePath, initialText) {
  await evaluate(
    cdp,
    `(async () => { await window.threadleaf.closePluginView(); return window.threadleaf.openNote(${JSON.stringify(notePath)}); })()`,
  );
  await waitFor(
    cdp,
    `(async () => { const snapshot = await window.threadleaf.getSnapshot(); return snapshot.vault.id === ${JSON.stringify(vaultId)} && snapshot.workspace?.activeNote?.path === ${JSON.stringify(notePath)}; })()`,
    `Templater target note ${notePath}`,
  );
  const noteTab = `.note-tab-activate[data-note-path=${JSON.stringify(notePath)}]`;
  await waitFor(
    cdp,
    `Boolean(document.querySelector(${JSON.stringify(noteTab)}))`,
    `Templater note tab ${notePath}`,
  );
  const alternateTab = await evaluate(
    cdp,
    `(() => { const tab = [...document.querySelectorAll('.note-tab-activate')].find((candidate) => candidate.dataset.notePath !== ${JSON.stringify(notePath)} && candidate.dataset.notePath?.endsWith('.md') && !candidate.dataset.notePath.endsWith('.excalidraw.md')); if (!(tab instanceof HTMLButtonElement)) return null; tab.id = 'threadleaf-e2e-templater-alternate-tab'; return '#threadleaf-e2e-templater-alternate-tab'; })()`,
  );
  if (alternateTab) {
    await clickSelector(cdp, alternateTab);
    await waitFor(
      cdp,
      `(() => { const tab = document.querySelector(${JSON.stringify(noteTab)}); return tab instanceof HTMLButtonElement && !tab.disabled; })()`,
      `Templater target tab readiness ${notePath}`,
    );
  }
  await clickSelector(cdp, noteTab);
  await waitFor(
    cdp,
    "(() => { const editor = document.querySelector('.cm-content'); if (!(editor instanceof HTMLElement)) return false; const bounds = editor.getBoundingClientRect(); return bounds.width > 100 && bounds.height > 20; })()",
    `Templater native editor surface ${notePath}`,
  );
  await clickSelector(cdp, ".cm-content");
  await waitFor(
    cdp,
    "document.activeElement?.classList.contains('cm-content') === true",
    `Templater target editor focus ${notePath}`,
  );
  await delay(120);
  await pressKey(cdp, "End", "End", 2);
  await pressKey(cdp, "t", "KeyT", 1);
  const expected = `${initialText}Templater hotkey works in ${path.basename(notePath, ".md")}.\n`;
  await waitForExactFileText(path.join(vaultPath, notePath), expected, 30_000);
  return {
    notePath,
    content: expected,
    revision: sha256(Buffer.from(expected)),
  };
}

async function verifyTemplaterWorkflow(vaultId) {
  await clickSelector(cdp, "#settings-trigger");
  await waitFor(
    cdp,
    "document.querySelector('#shortcut-settings')?.open === true",
    "Templater settings",
  );
  await clickSelector(cdp, "#settings-nav-plugins");
  await clickRowAction(cdp, '.plugin-row[data-plugin-id="templater-obsidian"]', "Options");
  await waitFor(
    cdp,
    `([...document.querySelectorAll('.setting-item-name')].some((item) => item.textContent?.trim() === 'Template folder location'))`,
    "Templater declarative options",
  );
  const folderControl = await markTemplaterSettingControl("Template folder location");
  assert(folderControl, "Templater template-folder control was unavailable.");
  await replaceFocusedText(folderControl, "Templates");
  await waitForTemplaterData(
    (data) => data.templates_folder === "Templates",
    "Templater template folder",
  );

  const hotkeyPageOpened = await evaluate(
    cdp,
    `(() => { const item = [...document.querySelectorAll('.setting-item')].find((candidate) => candidate.querySelector('.setting-item-name')?.textContent?.trim() === 'Template hotkeys'); if (!(item instanceof HTMLElement)) return false; item.click(); return true; })()`,
  );
  assert(hotkeyPageOpened, "Templater hotkey page was unavailable.");
  await waitFor(
    cdp,
    "document.querySelector('.setting-page-titlebar')?.textContent?.includes('Template hotkeys') === true",
    "Templater hotkey page",
  );
  const addButton = await evaluate(
    cdp,
    `(() => { const button = document.querySelector('button[title="Add template hotkey"]'); if (!(button instanceof HTMLButtonElement)) return null; button.id = 'threadleaf-e2e-templater-add'; return '#threadleaf-e2e-templater-add'; })()`,
  );
  assert(addButton, "Templater add-hotkey control was unavailable.");
  await clickSelector(cdp, addButton);
  await waitFor(
    cdp,
    "Boolean(document.querySelector('.modal-container input'))",
    "Templater template picker",
  );
  const pickerInput = await evaluate(
    cdp,
    `(() => { const input = document.querySelector('.modal-container input'); if (!(input instanceof HTMLInputElement)) return null; input.id = 'threadleaf-e2e-templater-picker'; return '#threadleaf-e2e-templater-picker'; })()`,
  );
  assert(pickerInput, "Templater template picker input was unavailable.");
  await replaceFocusedText(pickerInput, "Templates/Hotkey.md");
  const doneButton = await evaluate(
    cdp,
    `(() => { const button = [...document.querySelectorAll('.modal-container button')].find((candidate) => candidate.textContent?.trim() === 'Done'); if (!(button instanceof HTMLButtonElement) || button.disabled) return null; button.id = 'threadleaf-e2e-templater-done'; return '#threadleaf-e2e-templater-done'; })()`,
  );
  assert(doneButton, "Templater template picker did not expose Done.");
  await clickSelector(cdp, doneButton);
  await waitForTemplaterData(
    (data) => data.enabled_templates_hotkeys?.includes("Templates/Hotkey.md"),
    "Templater dynamic command persistence",
  );
  const commandId = "templater-obsidian:Templates/Hotkey.md";
  await waitFor(
    cdp,
    `(async () => (await window.threadleaf.getSnapshot()).commands.some((command) => command.id === ${JSON.stringify(commandId)} && command.name === 'Insert Hotkey'))()`,
    "Templater dynamic Insert Hotkey command",
  );

  await clickSelector(cdp, "#settings-trigger");
  await waitFor(
    cdp,
    "document.querySelector('#shortcut-settings')?.open === true",
    "Threadleaf Hotkeys settings",
  );
  await clickSelector(cdp, "#settings-nav-hotkeys");
  const targetId = `plugin.command:${encodeURIComponent(commandId)}`;
  const bindingButton = await waitFor(
    cdp,
    `(() => { const button = document.querySelector('.binding-capture[data-shortcut-target=${JSON.stringify(targetId)}]'); if (!(button instanceof HTMLButtonElement) || button.disabled) return null; button.id = 'threadleaf-e2e-templater-binding'; return '#threadleaf-e2e-templater-binding'; })()`,
    "Templater Hotkeys binding row",
  );
  await clickSelector(cdp, bindingButton);
  await pressKey(cdp, "t", "KeyT", 1);
  await waitFor(
    cdp,
    `(async () => (await window.threadleaf.getSettings()).settings.keyBindings[${JSON.stringify(targetId)}] === 'Alt+T')()`,
    "Templater persisted Alt+T binding",
  );
  await clickSelector(cdp, "#settings-close");
  const note = await runTemplaterHotkeyOnNote(vaultId, "Notes/Templater Target.md", "Before\n");
  return { pluginId: "templater-obsidian", commandId, binding: "Alt+T", note };
}

async function verifyTemplaterRestartWorkflow(vaultId) {
  const commandId = "templater-obsidian:Templates/Hotkey.md";
  const targetId = `plugin.command:${encodeURIComponent(commandId)}`;
  await waitFor(
    cdp,
    `(async () => { const [snapshot, settings] = await Promise.all([window.threadleaf.getSnapshot(), window.threadleaf.getSettings()]); return snapshot.commands.some((command) => command.id === ${JSON.stringify(commandId)}) && settings.settings.keyBindings[${JSON.stringify(targetId)}] === 'Alt+T'; })()`,
    "restarted Templater command and binding",
    30_000,
  );
  const note = await runTemplaterHotkeyOnNote(vaultId, "Notes/Templater Restart.md", "Restart\n");
  return { commandId, binding: "Alt+T", note };
}

async function verifyCalendarWorkflow(vaultId, port) {
  const commandId = "calendar-beta:show-calendar-view";
  const calendarAlreadyOpen = await evaluate(
    cdp,
    `(async () => (await window.threadleaf.getSnapshot()).pluginSurfaces?.some((surface) => surface.viewType === 'calendar' && surface.region === 'right-dock') === true)()`,
  );
  if (!calendarAlreadyOpen) {
    await runPaletteCommand(commandId, "show calendar view", `plugin.command.${commandId}`);
  }
  const surface = await connectPluginSurfaceBySelector(
    port,
    "#calendar-container .calendar",
    "Calendar right-dock view",
    45_000,
  ).catch(async (error) => {
    const snapshot = await evaluate(cdp, "window.threadleaf.getSnapshot()").catch(() => null);
    const mainSurface = await evaluate(
      cdp,
      `(() => {
        const main = document.querySelector('#plugin-surface-host');
        const dock = document.querySelector('#plugin-dock-surface-host');
        const describe = (element) => {
          if (!(element instanceof HTMLElement)) return null;
          const bounds = element.getBoundingClientRect();
          return { hidden: element.hidden, bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, display: getComputedStyle(element).display };
        };
        return { main: describe(main), dock: describe(dock), right: document.querySelector('#workspace-root')?.getAttribute('data-right-plugin-surface') };
      })()`,
    ).catch(() => null);
    const targets = await cdpTargets(port).catch(() => []);
    const pluginTargets = [];
    for (const target of targets.filter(
      (candidate) => candidate.type === "page" && candidate.url.includes("plugin-host.html"),
    )) {
      const connection = connectCdp(target.webSocketDebuggerUrl);
      try {
        pluginTargets.push({
          id: target.id,
          state: await evaluate(
            connection,
            `(() => { const calendar = document.querySelector('#calendar-container .calendar'); const bounds = calendar?.getBoundingClientRect(); return { calendar: Boolean(calendar), calendarBounds: bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : null, hit: bounds ? document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)?.className ?? null : null }; })()`,
          ),
        });
      } catch {
        pluginTargets.push({ id: target.id, state: null });
      } finally {
        connection.close();
      }
    }
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}: ${JSON.stringify({ pluginSurface: snapshot?.pluginSurface, mainSurface, events: snapshot?.events?.slice(-30), pluginTargets })}`,
    );
  });
  try {
    const rendered = await waitFor(
      surface.connection,
      `(() => {
        const calendar = document.querySelector('#calendar-container .calendar');
        const days = [...document.querySelectorAll('#calendar-container .day')];
        const today = document.querySelector('#calendar-container .today');
        return calendar instanceof HTMLElement && days.length >= 28 && today instanceof HTMLElement
          ? { dayCount: days.length, todayText: today.textContent?.trim() ?? '' }
          : null;
      })()`,
      "Calendar visible month grid",
      30_000,
    );
    const snapshot = await evaluate(cdp, "window.threadleaf.getSnapshot()");
    assert(
      snapshot.vault.id === vaultId && snapshot.pluginSurface?.viewType === "calendar",
      `Calendar did not project a physical compatibility surface: ${JSON.stringify(snapshot.pluginSurface)}`,
    );
    const dock = await waitFor(
      cdp,
      `(() => {
        const host = document.querySelector('#plugin-dock-surface-host');
        const note = document.querySelector('#note-view');
        if (!(host instanceof HTMLElement) || !(note instanceof HTMLElement)) return null;
        const bounds = host.getBoundingClientRect();
        return !host.hidden && !note.hidden && bounds.width >= 240 && bounds.height >= 400
          ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
          : null;
      })()`,
      "Calendar physical right dock beside the active note",
      20_000,
    );
    const calendarShots = [
      await capture(surface.connection, "calendar-right-dock", "dark"),
      await capture(surface.connection, "calendar-right-dock", "light"),
    ];
    assert(
      calendarShots[0].digest !== calendarShots[1].digest,
      "Calendar light and dark screenshots are identical.",
    );
    await clickSelector(surface.connection, "#calendar-container .today");
    await waitFor(
      surface.connection,
      `document.querySelector('.modal-container .modal') instanceof HTMLElement`,
      "Calendar daily-note confirmation",
      20_000,
    );
    const createSelector = await evaluate(
      surface.connection,
      `(() => {
        document.querySelector('#threadleaf-calendar-create')?.removeAttribute('id');
        const button = [...document.querySelectorAll('.modal-button-container button')]
          .find((candidate) => candidate.textContent?.trim() === 'Create');
        if (!(button instanceof HTMLButtonElement) || button.disabled) return null;
        button.id = 'threadleaf-calendar-create';
        return '#threadleaf-calendar-create';
      })()`,
    );
    assert(createSelector, "Calendar confirmation did not expose its Create action.");
    await clickSelector(surface.connection, createSelector);
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const dailyPath = `Journal/${today}.md`;
    const dailyFile = path.join(vaultPath, dailyPath);
    let dailyBytes = null;
    const dailyDeadline = Date.now() + 20_000;
    while (Date.now() < dailyDeadline) {
      dailyBytes = await fs.readFile(dailyFile, "utf8").catch(() => null);
      if (dailyBytes?.includes("Calendar fixture.") && !dailyBytes.includes("{{")) break;
      await delay(80);
    }
    assert(
      dailyBytes?.includes("Calendar fixture.") && !dailyBytes.includes("{{"),
      `Calendar did not create the configured daily note from its template: ${dailyPath}`,
    );
    await waitFor(
      surface.connection,
      `document.querySelectorAll('#calendar-container .today .dot').length > 0`,
      "Calendar created-note marker",
      20_000,
    );
    return {
      pluginId: "calendar-beta",
      workflow: "right-dock-create-templated-daily-note",
      rendered,
      dock,
      dailyPath,
      screenshots: calendarShots.map(({ filePath }) => filePath),
    };
  } finally {
    surface.connection.close();
  }
}

async function verifyDataFilesEditorWorkflow(vaultId, port) {
  const filePath = "Data/sample.json";
  const expected = `${JSON.stringify(
    { project: "Threadleaf", status: "edited-through-plugin", count: 4 },
    null,
    2,
  )}\n`;
  await openNavigatorPluginDocument(filePath);
  await waitFor(
    cdp,
    `(async () => { const snapshot = await window.threadleaf.getSnapshot(); return snapshot.vault.id === ${JSON.stringify(vaultId)} && snapshot.pluginSurface?.viewType === 'json' && snapshot.pluginSurface?.filePath === ${JSON.stringify(filePath)}; })()`,
    "Data Files Editor JSON view",
    30_000,
  );
  const surface = await connectPluginSurfaceBySelector(
    port,
    ".datafile-source-view .cm-editor",
    "Data Files Editor JSON view",
  ).catch(async (error) => {
    const snapshot = await evaluate(cdp, "window.threadleaf.getSnapshot()").catch(() => null);
    const hosts = await evaluate(
      cdp,
      `(() => Object.fromEntries(['plugin-surface-host','plugin-dock-surface-host'].map((id) => { const element = document.getElementById(id); const bounds = element?.getBoundingClientRect(); return [id, element && bounds ? { hidden: element.hidden, width: bounds.width, height: bounds.height } : null]; })))()`,
    ).catch(() => null);
    const targets = [];
    for (const target of (await cdpTargets(port).catch(() => [])).filter(
      (candidate) => candidate.type === "page" && candidate.url.includes("plugin-host.html"),
    )) {
      const connection = connectCdp(target.webSocketDebuggerUrl);
      try {
        targets.push(
          await evaluate(
            connection,
            `(() => { const data = document.querySelector('.datafile-source-view .cm-editor'); const calendar = document.querySelector('#calendar-container .calendar'); const describe = (element) => { const bounds = element?.getBoundingClientRect(); return bounds ? { width: bounds.width, height: bounds.height } : null; }; return { data: describe(data), calendar: describe(calendar) }; })()`,
          ),
        );
      } finally {
        connection.close();
      }
    }
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}: ${JSON.stringify({ pluginSurface: snapshot?.pluginSurface, pluginSurfaces: snapshot?.pluginSurfaces, hosts, targets })}`,
    );
  });
  const concurrentCalendar = await connectPluginSurfaceBySelector(
    port,
    "#calendar-container .calendar",
    "Calendar beside Data Files Editor",
    30_000,
  );
  let concurrentSurfaces;
  try {
    concurrentSurfaces = await waitFor(
      cdp,
      `(async () => {
        const snapshot = await window.threadleaf.getSnapshot();
        const regions = new Set((snapshot.pluginSurfaces ?? []).map((surface) => surface.region));
        const main = document.querySelector('#plugin-surface-host');
        const dock = document.querySelector('#plugin-dock-surface-host');
        if (!(main instanceof HTMLElement) || !(dock instanceof HTMLElement)) return null;
        const mainBounds = main.getBoundingClientRect();
        const dockBounds = dock.getBoundingClientRect();
        return regions.has('main-document') && regions.has('right-dock') &&
          !main.hidden && !dock.hidden && mainBounds.width > 0 && dockBounds.width > 0
          ? { regions: [...regions], mainWidth: mainBounds.width, dockWidth: dockBounds.width }
          : null;
      })()`,
      "simultaneous main-document and right-dock plugin surfaces",
      30_000,
    );
    assert(
      await evaluate(
        concurrentCalendar.connection,
        `document.querySelector('#calendar-container .calendar')?.getBoundingClientRect().width > 0`,
      ),
      "Calendar became hidden while Data Files Editor owned the main document.",
    );
  } finally {
    concurrentCalendar.connection.close();
  }
  try {
    await clickSelector(surface.connection, ".datafile-source-view .cm-content");
    const focus = await evaluate(
      surface.connection,
      `(() => { const content = document.querySelector('.datafile-source-view .cm-content'); if (!(content instanceof HTMLElement)) return null; content.focus(); return { active: document.activeElement === content, contenteditable: content.getAttribute('contenteditable'), text: content.textContent }; })()`,
    );
    assert(
      focus?.active && focus.contenteditable === "true",
      `Data Files Editor did not expose a focusable CodeMirror input: ${JSON.stringify(focus)}`,
    );
    await pressKey(surface.connection, "a", "KeyA", 2);
    await surface.connection.send("Input.insertText", { text: expected });
    await waitFor(
      surface.connection,
      `document.querySelector('.datafile-source-view .cm-content')?.textContent?.includes('edited-through-plugin') === true`,
      "Data Files Editor CodeMirror input",
      10_000,
    );
    await evaluate(cdp, "window.threadleaf.waitForPluginMutations()", 30_000);
    await waitForExactFileText(path.join(vaultPath, filePath), expected);
  } finally {
    surface.connection.close();
  }
  return {
    pluginId: "data-files-editor",
    workflow: "open-edit-autosave-json",
    filePath,
    concurrentSurfaces,
  };
}

async function verifyIconizeWorkflow(vaultId, port) {
  const filePath = "Notes/Source.md";
  await evaluate(cdp, `window.threadleaf.openNote(${JSON.stringify(filePath)})`);
  await waitFor(
    cdp,
    `(async () => { const snapshot = await window.threadleaf.getSnapshot(); return snapshot.vault.id === ${JSON.stringify(vaultId)} && snapshot.workspace?.activeNote?.path === ${JSON.stringify(filePath)}; })()`,
    "Iconize active Markdown file",
  );
  const commandId = "obsidian-icon-folder:iconize:set-icon-for-file";
  await runPaletteCommand(commandId, "set icon for file", `plugin.command.${commandId}`);
  await waitFor(
    cdp,
    `(async () => { const snapshot = await window.threadleaf.getSnapshot(); const host = document.querySelector('#plugin-surface-host'); if (!(host instanceof HTMLElement)) return false; const bounds = host.getBoundingClientRect(); return snapshot.pluginSurface?.viewType === 'threadleaf-plugin-modal' && !host.hidden && bounds.width > 0 && bounds.height > 0; })()`,
    "Iconize visible isolated modal surface",
    30_000,
  );
  const surface = await connectPluginSurfaceBySelector(
    port,
    ".modal-container .prompt-input",
    "Iconize picker",
  );
  try {
    await clickSelector(surface.connection, ".modal-container .prompt-input");
    await surface.connection.send("Input.insertText", { text: "star" });
    await waitFor(
      surface.connection,
      "document.querySelectorAll('.iconize-modal .suggestion-item').length > 0",
      "Iconize star suggestions",
      20_000,
    );
    await pressKey(surface.connection, "Enter", "Enter");
    await waitFor(
      surface.connection,
      "!document.querySelector('.iconize-modal')",
      "Iconize picker close",
      20_000,
    );
  } finally {
    surface.connection.close();
  }
  const dataPath = path.join(
    vaultPath,
    ".obsidian",
    "plugins",
    "obsidian-icon-folder",
    "data.json",
  );
  const deadline = Date.now() + 20_000;
  let iconName = null;
  while (Date.now() < deadline) {
    const data = JSON.parse(await fs.readFile(dataPath, "utf8"));
    if (typeof data[filePath] === "string" && data[filePath].length > 0) {
      iconName = data[filePath];
      break;
    }
    await delay(80);
  }
  assert(iconName, "Iconize did not persist the icon selected through its ordinary modal.");
  assert(
    await exists(path.join(vaultPath, ".obsidian", "icons")),
    "Iconize did not create its clean-install .obsidian/icons directory.",
  );
  await waitFor(
    cdp,
    `(async () => (await window.threadleaf.getSnapshot()).navigatorDecorations?.some((decoration) => decoration.path === ${JSON.stringify(filePath)} && decoration.text === ${JSON.stringify(iconName)}) === true)()`,
    "Iconize navigator decoration projection",
    20_000,
  );
  await clickSelector(cdp, "#reveal-active-note");
  await waitFor(
    cdp,
    `(() => { const row = document.querySelector(${JSON.stringify(`.navigator-tree-row[data-tree-path="${filePath}"]`)}); return row?.getAttribute('data-plugin-decorated') === 'true' && row.querySelector('.navigator-plugin-decoration')?.textContent === ${JSON.stringify(iconName)}; })()`,
    "Iconize visible native navigator decoration",
    20_000,
  );
  const navigatorShots = [
    await capture(cdp, "iconize-navigator", "dark"),
    await capture(cdp, "iconize-navigator", "light"),
  ];
  assert(
    navigatorShots[0].digest !== navigatorShots[1].digest,
    "Iconize navigator theme screenshots are identical.",
  );
  return {
    pluginId: "obsidian-icon-folder",
    workflow: "command-picker-select-persist-render",
    filePath,
    iconName,
    screenshots: navigatorShots.map(({ filePath: screenshotPath }) => screenshotPath),
  };
}

async function verifyMinimalSettingsWorkflow(vaultId, port) {
  const surface = await connectPluginSurfaceBySelector(
    port,
    "body.minimal-theme",
    "Minimal Settings runtime",
    30_000,
    false,
  );
  const commandId = "obsidian-minimal-settings:increase-body-font-size";
  try {
    await runPaletteCommand(commandId, "increase body font size", `plugin.command.${commandId}`);
    const appliedSize = await waitFor(
      surface.connection,
      "document.documentElement.style.getPropertyValue('--font-text-size') === '16.5px' && document.body.style.getPropertyValue('--font-text-size') === '16.5px' ? '16.5px' : null",
      "Minimal body font command",
      20_000,
    );
    assert(appliedSize === "16.5px", "Minimal body font command returned an invalid size.");
  } finally {
    surface.connection.close();
  }
  const nativeAppearance = await waitFor(
    cdp,
    `(() => { const value = getComputedStyle(document.body).getPropertyValue('--font-text-size').trim(); const editorFontSize = getComputedStyle(document.querySelector('.cm-content')).fontSize; return document.body.classList.contains('minimal-theme') && value === '16.5px' && editorFontSize === '16.5px' ? { value, editorFontSize } : null; })()`,
    "Minimal native appearance projection",
    20_000,
  );
  const appSettingsPath = path.join(vaultPath, ".obsidian", "app.json");
  const pluginSettingsPath = path.join(
    vaultPath,
    ".obsidian",
    "plugins",
    "obsidian-minimal-settings",
    "data.json",
  );
  const deadline = Date.now() + 20_000;
  let persisted = null;
  while (Date.now() < deadline) {
    const appSettings = JSON.parse(await fs.readFile(appSettingsPath, "utf8").catch(() => "{}"));
    const pluginSettings = JSON.parse(
      await fs.readFile(pluginSettingsPath, "utf8").catch(() => "{}"),
    );
    if (appSettings.baseFontSize === 16.5 && pluginSettings.textNormal === 16.5) {
      persisted = { appSettings, pluginSettings };
      break;
    }
    await delay(80);
  }
  assert(persisted, "Minimal Settings did not persist its body font setting through both APIs.");
  const appearanceShots = [
    await capture(cdp, "minimal-settings-native", "dark"),
    await capture(cdp, "minimal-settings-native", "light"),
  ];
  assert(
    appearanceShots[0].digest !== appearanceShots[1].digest,
    "Minimal Settings native theme screenshots are identical.",
  );
  return {
    pluginId: "obsidian-minimal-settings",
    workflow: "command-config-css-persist",
    vaultId,
    fontSize: 16.5,
    nativeEditorFontSize: nativeAppearance.editorFontSize,
    screenshots: appearanceShots.map(({ filePath }) => filePath),
  };
}

async function verifyOmnisearchWorkflow(vaultId, port) {
  await evaluate(cdp, 'window.threadleaf.openNote("Notes/External.md")');
  await waitFor(
    cdp,
    "document.querySelector('#note-path')?.textContent === 'Notes/External.md'",
    "Omnisearch navigation origin",
  );
  const commandId = "omnisearch:show-modal";
  await runPaletteCommand(commandId, "omnisearch", `plugin.command.${commandId}`);
  await waitFor(
    cdp,
    `(async () => { const snapshot = await window.threadleaf.getSnapshot(); const host = document.querySelector('#plugin-surface-host'); if (!(host instanceof HTMLElement)) return false; const bounds = host.getBoundingClientRect(); return snapshot.pluginSurface?.viewType === 'threadleaf-plugin-modal' && !host.hidden && bounds.width > 0 && bounds.height > 0; })()`,
    "Omnisearch visible isolated modal surface",
    45_000,
  );
  const surface = await connectPluginSurfaceBySelector(
    port,
    ".omnisearch-modal .prompt-input",
    "Omnisearch vault modal",
    45_000,
  );
  try {
    await clickSelector(surface.connection, ".omnisearch-modal .prompt-input");
    await surface.connection.send("Input.insertText", { text: "Unicode scene" });
    const resultSelector = '[data-result-id="Notes/Source.md"]';
    await waitFor(
      surface.connection,
      `document.querySelector(${JSON.stringify(resultSelector)}) instanceof HTMLElement`,
      "Omnisearch indexed Source result",
      45_000,
    );
    await clickSelector(surface.connection, resultSelector);
    await waitFor(
      surface.connection,
      "!document.querySelector('.omnisearch-modal')",
      "Omnisearch result activation",
      20_000,
    );
  } finally {
    surface.connection.close();
  }
  await waitFor(
    cdp,
    `(async () => { const snapshot = await window.threadleaf.getSnapshot(); return snapshot.vault.id === ${JSON.stringify(vaultId)} && snapshot.workspace?.activeNote?.path === 'Notes/Source.md' && document.querySelector('#note-path')?.textContent === 'Notes/Source.md'; })()`,
    "Omnisearch native note navigation",
    30_000,
  );
  return {
    pluginId: "omnisearch",
    workflow: "command-query-result-native-open",
    query: "Unicode scene",
    resultPath: "Notes/Source.md",
  };
}

function pluginFixtureSettings(compress) {
  return {
    compress,
    matchTheme: true,
    matchThemeAlways: true,
    matchThemeTrigger: true,
    onceOffCompressFlagReset: true,
    onceOffGPTVersionReset: true,
    previousRelease: pluginVersion,
    showReleaseNotes: false,
  };
}

async function canonicalManifest(root = vaultPath) {
  const manifest = JSON.parse(await fs.readFile(path.join(fixtureRoot, "manifest.json"), "utf8"));
  const result = {};
  for (const entry of manifest.files) {
    const bytes = await fs.readFile(path.join(root, entry.path));
    result[entry.path] = { size: bytes.length, sha256: sha256(bytes) };
  }
  return { manifest, result };
}

async function startApp(port, pluginState, { prepareAuthority = true } = {}) {
  const settings = {
    version: 5,
    keyBindings: {},
    appearanceByVault: {},
    pluginsByVault: {
      [sha256(Buffer.from(vaultPath))]: {
        compatibilityMode: "enabled",
        compatibilityTopology,
        enabledPluginIds: [],
        capabilityGrantsByPlugin: {},
      },
      [sha256(Buffer.from(secondVaultPath))]: {
        compatibilityMode: "enabled",
        compatibilityTopology,
        enabledPluginIds: [],
        capabilityGrantsByPlugin: {},
      },
    },
    noteWorkflowsByVault: {
      [sha256(Buffer.from(vaultPath))]: {
        templateFolder: "Templates",
        templateDateFormat: "YYYY-MM-DD",
        templateTimeFormat: "HH:mm",
        dailyNoteFolder: "Journal",
        dailyNoteDateFormat: "YYYY-MM-DD",
        dailyNoteTemplate: "Templates/Daily.md",
      },
    },
  };
  await fs.mkdir(userDataPath, { recursive: true });
  const settingsPath = path.join(userDataPath, "settings.json");
  if (!(await exists(settingsPath))) {
    await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  }
  child = spawn(
    "xvfb-run",
    [
      "-a",
      "-s",
      "-screen 0 1440x900x24 -nolisten tcp",
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
        THREADLEAF_TEST_PICKER_PATH: pickerLink,
        THREADLEAF_WORKSPACE_DOCKS_RUN: "threadleaf-excalidraw-roundtrip",
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk) => {
      output.push(String(chunk));
      while (output.length > 80) output.shift();
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
  const target = await waitForTarget(
    port,
    (candidate) =>
      candidate.type === "page" &&
      candidate.url.includes(
        compatibilityTopology === "trusted-workspace"
          ? "/dist/renderer/index-trusted.html"
          : "/dist/renderer/index.html",
      ),
    "main renderer",
    20_000,
  );
  mainTargetId = target.id;
  cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await waitFor(cdp, "document.readyState === 'complete'", "main renderer document");
  const ready = await waitFor(
    cdp,
    `(async () => { const s = await window.threadleaf.getSnapshot(); return s.workspace?.state === 'ready' && s.vault?.path === ${JSON.stringify(vaultPath)} ? s : null; })()`,
    "copied fixture vault",
    20_000,
  );
  const vaultId = ready.vault.id;
  assert(typeof vaultId === "string", "The fixture vault did not expose an identity.");

  const catalog = await evaluate(cdp, `window.threadleaf.getPlugins(${JSON.stringify(vaultId)})`);
  assert(catalog.status === "ready", "The Excalidraw catalog was not ready.");
  const plugin = catalog.catalog.plugins.find((candidate) => candidate.id === pluginId);
  assert(plugin, "The public Excalidraw package was not discovered.");
  assert(
    plugin.version === pluginVersion && plugin.packageState === "ready",
    `The discovered Excalidraw package was not the ready exact ${pluginVersion} release.`,
  );
  assert(plugin.capabilityReport, "The Excalidraw authority report was unavailable.");
  assert(
    plugin.capabilityReport.bundleSha256 === pinnedPlugin.mainSha256,
    "The discovered Excalidraw authority report did not bind the pinned main.js bytes.",
  );
  if (prepareAuthority) {
    await evaluate(cdp, `window.threadleaf.openNote("Notes/Source.md")`);
    await waitFor(
      cdp,
      "document.querySelector('#note-path')?.textContent === 'Notes/Source.md'",
      "ordinary note before Excalidraw enablement",
    );
    // Exercise the same visible authority and enablement path a user gets. Calling the preload
    // methods directly returns a fresh snapshot to the test but bypasses the renderer's render(),
    // which can leave commands absent from the actual palette while an API-only assertion passes.
    await clickSelector(cdp, "#settings-trigger");
    await waitFor(
      cdp,
      "document.querySelector('#shortcut-settings')?.open === true",
      "settings dialog for Excalidraw enablement",
    );
    await clickSelector(cdp, "#settings-nav-plugins");
    const installedRow = `.plugin-row[data-plugin-id=${JSON.stringify(pluginId)}]`;
    await waitFor(
      cdp,
      `Boolean(document.querySelector(${JSON.stringify(installedRow)}))`,
      "installed Excalidraw settings row",
    );
    await clickRowAction(cdp, installedRow, "Review authority");
    await waitFor(
      cdp,
      "document.querySelector('#plugin-authority-review-dialog')?.open === true",
      "Excalidraw authority review",
    );
    await clickSelector(cdp, "#plugin-authority-review-grant");
    await waitFor(
      cdp,
      `document.querySelector(${JSON.stringify(installedRow)})?.textContent?.includes('Exact bundle granted')`,
      "visible Excalidraw authority grant",
    );
    await waitFor(
      cdp,
      `document.querySelector(${JSON.stringify(`${installedRow} input[type='checkbox']`)})?.disabled === false`,
      "visible Excalidraw enable control",
    );
    await evaluate(
      cdp,
      `(() => {
        window.__threadleafE2EPluginToggleChange = null;
        const checkbox = document.querySelector(${JSON.stringify(`${installedRow} input[type='checkbox']`)});
        checkbox?.addEventListener('change', () => {
          window.__threadleafE2EPluginToggleChange = { checked: checkbox.checked, at: Date.now() };
        }, { once: true });
        return true;
      })()`,
    );
    await clickSelector(cdp, `${installedRow} .plugin-toggle-track`);
    const toggleDispatched = await waitFor(
      cdp,
      `window.__threadleafE2EPluginToggleChange?.checked === true || document.querySelector(${JSON.stringify(`${installedRow} input[type='checkbox']`)})?.checked === true`,
      "visible Excalidraw toggle input event",
      3_000,
    ).catch(() => false);
    if (!toggleDispatched) {
      await clickSelector(cdp, `${installedRow} .plugin-toggle-track`);
    }
    let visibleToggle;
    try {
      visibleToggle = await waitFor(
        cdp,
        `document.querySelector(${JSON.stringify(`${installedRow} input[type='checkbox']`)})?.checked === true`,
        "visible Excalidraw enable toggle",
        45_000,
      );
    } catch (error) {
      const diagnostic = await evaluate(
        cdp,
        `(async () => {
          const checkbox = document.querySelector(${JSON.stringify(`${installedRow} input[type='checkbox']`)});
          const snapshot = await window.threadleaf.getSnapshot();
          const settings = await window.threadleaf.getSettings();
          return {
            change: window.__threadleafE2EPluginToggleChange ?? null,
            checkbox: checkbox ? { checked: checkbox.checked, disabled: checkbox.disabled, ariaLabel: checkbox.ariaLabel } : null,
            rowText: document.querySelector(${JSON.stringify(installedRow)})?.textContent ?? null,
            plugin: snapshot.plugins?.find((candidate) => candidate.id === ${JSON.stringify(pluginId)}) ?? null,
            preference: settings.pluginsByVault?.[${JSON.stringify(vaultId)}] ?? null,
            status: document.querySelector('#plugin-status')?.textContent ?? null,
          };
        })()`,
      );
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}: ${JSON.stringify(diagnostic)}`,
      );
    }
    assert(visibleToggle === true, "Visible Excalidraw toggle returned an invalid state.");
    const visibleActivation = await waitFor(
      cdp,
      `(async () => {
        const snapshot = await window.threadleaf.getSnapshot();
        const candidate = snapshot.plugins?.find((item) => item.id === ${JSON.stringify(pluginId)});
        return candidate?.state === 'loaded' || candidate?.state === 'failed' ? candidate : null;
      })()`,
      "visible Excalidraw enablement",
      120_000,
    );
    assert(
      visibleActivation.state === "loaded",
      `Visible Excalidraw enablement failed: ${JSON.stringify(visibleActivation)}`,
    );
    await waitFor(
      cdp,
      "document.querySelector('#settings-close')?.disabled === false",
      "settings completion after Excalidraw enablement",
    );
    await clickSelector(cdp, "#settings-close");
    await waitFor(
      cdp,
      "document.querySelector('#shortcut-settings')?.open !== true",
      "settings close after Excalidraw enablement",
    );
  } else {
    assert(
      plugin.capabilityGrantState === "granted",
      "The restarted application did not reconstruct the persisted exact-package grant.",
    );
  }
  const activationDeadline = Date.now() + 60_000;
  let pluginSummary = null;
  while (Date.now() < activationDeadline) {
    const snapshot = await evaluate(cdp, "window.threadleaf.getSnapshot()").catch(() => null);
    pluginSummary = snapshot?.plugins?.find((candidate) => candidate.id === pluginId) ?? null;
    if (pluginSummary?.state === "loaded") break;
    if (pluginSummary?.state === "failed") {
      throw new Error(
        `unchanged Excalidraw plugin activation failed: ${JSON.stringify(pluginSummary)}`,
      );
    }
    await delay(80);
  }
  assert(pluginSummary?.state === "loaded", "unchanged Excalidraw plugin activation timed out.");
  pluginState.runtimeHash = plugin.capabilityReport.bundleSha256;
  return { vaultId, plugin };
}

async function closeApp() {
  pluginCdp?.close();
  pluginCdp = null;
  cdp?.close();
  cdp = null;
  mainTargetId = null;
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
    delay(5_000).then(() => {
      try {
        if (current.pid) process.kill(-current.pid, "SIGKILL");
        else current.kill("SIGKILL");
      } catch {
        current.kill("SIGKILL");
      }
    }),
  ]);
}

async function reconnectMainRenderer(port) {
  const previousTargetId = mainTargetId;
  if (pluginCdp && pluginCdp !== cdp) pluginCdp.close();
  pluginCdp = null;
  cdp?.close();
  cdp = null;
  const target = await waitForTarget(
    port,
    (candidate) =>
      candidate.type === "page" &&
      candidate.id !== previousTargetId &&
      candidate.url.includes(
        compatibilityTopology === "trusted-workspace"
          ? "/dist/renderer/index-trusted.html"
          : "/dist/renderer/index.html",
      ),
    "replacement main renderer",
    30_000,
  );
  mainTargetId = target.id;
  cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await waitFor(cdp, "document.readyState === 'complete'", "replacement main renderer document");
  if (compatibilityTopology === "trusted-workspace") pluginCdp = cdp;
}

async function openNavigatorPluginDocument(filePath) {
  await waitFor(
    cdp,
    "document.querySelector('#file-list')?.dataset.mode === 'tree'",
    "Files navigator tree mode",
  );
  const segments = filePath.split("/");
  for (let depth = 1; depth < segments.length; depth += 1) {
    const folderPath = segments.slice(0, depth).join("/");
    const selector = `#file-list [data-tree-path=${JSON.stringify(folderPath)}]`;
    await waitFor(
      cdp,
      `document.querySelector(${JSON.stringify(selector)}) instanceof HTMLButtonElement`,
      `navigator folder ${folderPath}`,
    );
    const expanded = await evaluate(
      cdp,
      `document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-expanded') === 'true'`,
    );
    if (!expanded) await clickSelector(cdp, selector);
  }
  const selector = `#file-list [data-tree-path=${JSON.stringify(filePath)}]`;
  await waitFor(
    cdp,
    `(() => { const row = document.querySelector(${JSON.stringify(selector)}); return row instanceof HTMLButtonElement && row.dataset.kind === 'file'; })()`,
    `native plugin document row ${filePath}`,
  );
  for (let stable = 0; stable < 5; stable += 1) {
    await waitFor(
      cdp,
      `(() => { const row = document.querySelector(${JSON.stringify(selector)}); return row instanceof HTMLButtonElement && row.dataset.kind === 'file'; })()`,
      `stable native plugin document row ${filePath}`,
    );
    await delay(100);
  }
  await clickSelector(cdp, selector);
}

async function runPaletteCommand(commandId, query = commandId, paletteId = commandId) {
  await clickSelector(cdp, "#command-trigger");
  await waitFor(
    cdp,
    "document.querySelector('#command-palette')?.open === true",
    "command palette",
  );
  const rowsBeforeQuery = await evaluate(
    cdp,
    "[...document.querySelectorAll('[data-command-id]')].slice(0, 120).map((row) => ({ id: row.getAttribute('data-command-id'), text: row.textContent }))",
  );
  await cdp.send("Input.insertText", { text: query });
  const selector = `[data-command-id=${JSON.stringify(paletteId)}]`;
  await delay(100);
  const paletteState = await evaluate(
    cdp,
    `({ query: document.querySelector('#palette-query')?.value ?? null, rows: [...document.querySelectorAll('[data-command-id]')].slice(0, 30).map((row) => ({ id: row.getAttribute('data-command-id'), text: row.textContent })) })`,
  );
  assert(
    paletteState.rows.some(({ id }) => id === paletteId),
    `The command palette did not expose ${commandId}: ${JSON.stringify({ rowsBeforeQuery, paletteState })}`,
  );
  await clickSelector(cdp, selector);
}

async function createDrawingThroughOrdinaryPalette(vaultId, targetPort) {
  const commandId = "obsidian-excalidraw-plugin:excalidraw-autocreate-newtab";
  const before = await waitFor(
    cdp,
    `(async () => {
      const snapshot = await window.threadleaf.getSnapshot();
      return snapshot.commands?.some((command) => command.id === ${JSON.stringify(commandId)})
        ? snapshot
        : null;
    })()`,
    "Excalidraw ordinary create command registration",
    30_000,
  ).catch(async (error) => {
    const snapshot = await evaluate(cdp, "window.threadleaf.getSnapshot()");
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}: ${JSON.stringify({ plugins: snapshot.plugins, commands: snapshot.commands, events: snapshot.events?.slice(-20), integrations: snapshot.integrations })}`,
    );
  });
  const pluginCommands = (before.commands ?? []).filter(({ id }) => id.startsWith(`${pluginId}:`));
  assert(
    pluginCommands.some(({ id }) => id === commandId),
    `The loaded Excalidraw runtime did not register its ordinary create command: ${JSON.stringify({ commands: pluginCommands.slice(0, 20), plugins: before.plugins, events: before.events?.slice(-20), integrations: before.integrations })}`,
  );
  const existing = (before.workspace?.tabs ?? []).map(({ path: filePath }) => filePath);
  await runPaletteCommand(commandId, "new drawing", `plugin.command.${commandId}`);
  const created = await waitFor(
    cdp,
    `(async () => {
      const snapshot = await window.threadleaf.getSnapshot();
      const prior = new Set(${JSON.stringify(existing)});
      const tab = snapshot.workspace?.tabs.find(
        (candidate) => candidate.path.toLowerCase().endsWith('.excalidraw.md') && !prior.has(candidate.path)
      );
      const activePath = snapshot.workspace?.activePluginFile?.path ?? snapshot.workspace?.activeNote?.path;
      return tab && activePath === tab.path
        ? { path: tab.path, snapshot }
        : null;
    })()`,
    "ordinary command-palette drawing creation",
    45_000,
  ).catch(async (error) => {
    const snapshot = await evaluate(cdp, "window.threadleaf.getSnapshot()");
    const surface = await evaluate(
      cdp,
      `(() => ({
        notePath: document.querySelector('#note-path')?.textContent ?? null,
        pluginButton: document.querySelector('#plugin-view')?.outerHTML ?? null,
        toast: document.querySelector('#toast')?.textContent ?? null,
      }))()`,
    );
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}: ${JSON.stringify({ commandCount: snapshot.commands?.filter(({ id }) => id.startsWith(`${pluginId}:`)).length ?? 0, commands: snapshot.commands?.filter(({ id }) => id.startsWith(`${pluginId}:`)).slice(0, 20), events: snapshot.events?.slice(-30), integrations: snapshot.integrations, pluginSurface: snapshot.pluginSurface, plugins: snapshot.plugins, surface, workspace: snapshot.workspace })}`,
    );
  });
  assert(created.snapshot.vault.id === vaultId, "Creating a drawing changed the active vault.");
  await waitFor(
    cdp,
    `(async () => {
      const snapshot = await window.threadleaf.getSnapshot();
      return snapshot.pluginSurface?.viewType === 'excalidraw' &&
        snapshot.pluginSurface?.filePath === ${JSON.stringify(created.path)};
    })()`,
    "created drawing Excalidraw surface authority",
    20_000,
  );
  await connectPluginSurface(targetPort);
  await waitForExcalidrawCanvas(pluginCdp, "command-palette Excalidraw canvas");
  await assertVisibleExcalidrawSurface(pluginCdp, "command-palette Excalidraw canvas");
  return created.path;
}

async function openDrawing(filePath, vaultId, options = {}) {
  if (options.viaNavigator) await openNavigatorPluginDocument(filePath);
  else await evaluate(cdp, `window.threadleaf.openNote(${JSON.stringify(filePath)})`);
  await waitFor(
    cdp,
    `document.querySelector('#note-path')?.textContent === ${JSON.stringify(filePath)}`,
    `open ${filePath}`,
  );
  await waitFor(
    cdp,
    `(() => { const button = document.querySelector('#plugin-view'); return button instanceof HTMLButtonElement && !button.hidden; })()`,
    `visible Excalidraw control for ${filePath}`,
  ).catch(async (error) => {
    const diagnostic = await evaluate(
      cdp,
      `(async () => {
        const snapshot = await window.threadleaf.getSnapshot();
        const button = document.querySelector('#plugin-view');
        return {
          button: button instanceof HTMLButtonElement ? { disabled: button.disabled, hidden: button.hidden, pressed: button.getAttribute('aria-pressed'), title: button.title } : null,
          events: snapshot.events?.slice(-30),
          integrations: snapshot.integrations,
          pluginSurface: snapshot.pluginSurface,
          plugins: snapshot.plugins,
          workspace: snapshot.workspace,
        };
      })()`,
    );
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}: ${JSON.stringify(diagnostic)}`,
    );
  });
  await waitFor(
    cdp,
    `(async () => { const s = await window.threadleaf.getSnapshot(); const host = document.querySelector('#plugin-surface-host'); const button = document.querySelector('#plugin-view'); return s.pluginSurface?.viewType === 'excalidraw' && s.pluginSurface?.filePath === ${JSON.stringify(filePath)} && host instanceof HTMLElement && !host.hidden && button?.getAttribute('aria-pressed') === 'true'; })()`,
    `automatic Excalidraw view ${filePath}`,
    30_000,
  ).catch(async (error) => {
    const diagnostic = await evaluate(
      cdp,
      `(async () => {
        const snapshot = await window.threadleaf.getSnapshot();
        const host = document.querySelector('#plugin-surface-host');
        const button = document.querySelector('#plugin-view');
        return {
          button: button instanceof HTMLButtonElement ? { disabled: button.disabled, hidden: button.hidden, pressed: button.getAttribute('aria-pressed'), title: button.title } : null,
          events: snapshot.events?.slice(-40),
          host: host instanceof HTMLElement ? { hidden: host.hidden, childCount: host.childElementCount, text: host.textContent?.slice(0, 500) } : null,
          integrations: snapshot.integrations,
          pluginSurface: snapshot.pluginSurface,
          plugins: snapshot.plugins,
          workspace: snapshot.workspace,
        };
      })()`,
    );
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}: ${JSON.stringify(diagnostic)}`,
    );
  });
  if (options.viaNavigator) {
    const selector = `#file-list [data-tree-path=${JSON.stringify(filePath)}]`;
    await waitFor(
      cdp,
      `document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-current') === 'page'`,
      `selected native plugin document row ${filePath}`,
    );
  }
  return vaultId;
}

async function assertRestoredNativeDrawing(filePath, vaultId) {
  const selector = `#file-list [data-tree-path=${JSON.stringify(filePath)}]`;
  const restored = await waitFor(
    cdp,
    `(async () => {
      const snapshot = await window.threadleaf.getSnapshot();
      const pane = snapshot.workspace?.panes.find((candidate) => candidate.id === snapshot.workspace?.activePaneId);
      const row = document.querySelector(${JSON.stringify(selector)});
      const host = document.querySelector('#plugin-surface-host');
      const button = document.querySelector('#plugin-view');
      return snapshot.vault.id === ${JSON.stringify(vaultId)} &&
        snapshot.workspace?.activeNote === null &&
        snapshot.workspace?.activePluginFile?.path === ${JSON.stringify(filePath)} &&
        pane?.activePluginFile?.path === ${JSON.stringify(filePath)} &&
        pane.tabs.some((tab) => tab.path === ${JSON.stringify(filePath)} && tab.active) &&
        snapshot.pluginSurface?.viewType === 'excalidraw' &&
        snapshot.pluginSurface.filePath === ${JSON.stringify(filePath)} &&
        document.querySelector('#note-path')?.textContent === ${JSON.stringify(filePath)} &&
        row instanceof HTMLButtonElement && row.getAttribute('aria-current') === 'page' &&
        host instanceof HTMLElement && !host.hidden &&
        button instanceof HTMLButtonElement && button.getAttribute('aria-pressed') === 'true'
        ? snapshot
        : null;
    })()`,
    `restored native plugin document ${filePath}`,
    30_000,
  );
  assert(
    restored.workspace.activePluginFile.viewType === "excalidraw",
    `Restored native document lost its live view type: ${JSON.stringify(restored.workspace.activePluginFile)}`,
  );
  return restored;
}

async function connectPluginSurface(port) {
  if (pluginCdp && pluginCdp !== cdp) pluginCdp.close();
  pluginCdp = null;
  if (compatibilityTopology === "trusted-workspace") {
    pluginCdp = cdp;
    await waitForExcalidrawCanvas(pluginCdp, "trusted-workspace Excalidraw canvas").catch(
      async (error) => {
        const snapshot = await evaluate(cdp, "window.threadleaf.getSnapshot()");
        const dom = await evaluate(
          cdp,
          `(() => {
            const surface = document.querySelector('#threadleaf-plugin-surface');
            const host = document.querySelector('#plugin-surface-host');
            const canvas = Array.from(document.querySelectorAll('.excalidraw canvas')).find((candidate) => {
              const bounds = candidate.getBoundingClientRect();
              return bounds.width > 0 && bounds.height > 0;
            }) ?? document.querySelector('.excalidraw canvas');
            const describe = (element) => {
              if (!(element instanceof HTMLElement)) return null;
              const bounds = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              return {
                bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
                childCount: element.childElementCount,
                className: element.className,
                display: style.display,
                hidden: element.hidden,
                position: style.position,
                text: element.textContent?.slice(0, 300) ?? '',
                visibility: style.visibility,
              };
            };
            return {
              bodyChildren: Array.from(document.body.children).map((element) => ({ id: element.id, className: element.className })),
              canvas: describe(canvas),
              excalidrawCount: document.querySelectorAll('.excalidraw').length,
              host: describe(host),
              surface: describe(surface),
            };
          })()`,
        );
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}: ${JSON.stringify({ dom, pluginSurface: snapshot.pluginSurface, events: snapshot.events?.slice(-30), workspace: snapshot.workspace })}`,
        );
      },
    );
    return null;
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const targets = (await cdpTargets(port).catch(() => [])).filter(
      (candidate) => candidate.type === "page" && candidate.url.includes("plugin-host.html"),
    );
    for (const target of targets) {
      const candidate = connectCdp(target.webSocketDebuggerUrl);
      try {
        await candidate.send("Page.enable", {}, 2_000);
        await candidate.send("Runtime.enable", {}, 2_000);
        await candidate.send("Network.enable", {}, 2_000);
        await evaluate(
          candidate,
          `(() => {
            if (window.__threadleafConsoleErrorCaptureInstalled) return true;
            window.__threadleafConsoleErrorCaptureInstalled = true;
            window.__threadleafConsoleErrors = [];
            const original = console.error.bind(console);
            console.error = (...args) => {
              const serialized = args.map((value) => {
                try {
                  return JSON.parse(JSON.stringify(value, (_key, candidate) =>
                    candidate instanceof Error
                      ? { name: candidate.name, message: candidate.message, stack: candidate.stack }
                      : candidate));
                } catch {
                  return String(value);
                }
              });
              window.__threadleafConsoleErrors.push(serialized);
              if (window.__threadleafConsoleErrors.length > 80) window.__threadleafConsoleErrors.shift();
              original(...args);
            };
            return true;
          })()`,
        );
        const state = await evaluate(
          candidate,
          `(() => {
            const canvas = Array.from(document.querySelectorAll('.excalidraw canvas')).find((candidate) => {
              const bounds = candidate.getBoundingClientRect();
              return bounds.width > 0 && bounds.height > 0;
            });
            if (!(canvas instanceof HTMLCanvasElement)) return null;
            const bounds = canvas.getBoundingClientRect();
            return bounds.width > 0 && bounds.height > 0
              ? { width: bounds.width, height: bounds.height, visibility: document.visibilityState }
              : null;
          })()`,
        );
        if (state) {
          pluginCdp = candidate;
          await waitForExcalidrawCanvas(pluginCdp, "Excalidraw canvas");
          return target;
        }
      } catch {
        // A crashed renderer may remain in /json/list briefly; only a live canvas can win.
      }
      candidate.close();
    }
    await delay(80);
  }
  throw new Error("A live Excalidraw compatibility renderer did not appear.");
}

async function waitForExcalidrawCanvas(connection, label, timeoutMs = 30_000) {
  await waitFor(
    connection,
    "(() => { const canvas = Array.from(document.querySelectorAll('.excalidraw canvas')).find((candidate) => { const bounds = candidate.getBoundingClientRect(); return bounds.width > 100 && bounds.height > 100; }); if (!(canvas instanceof HTMLCanvasElement)) return false; const bounds = canvas.getBoundingClientRect(); return { width: bounds.width, height: bounds.height }; })()",
    label,
    timeoutMs,
  );
}

async function assertVisibleExcalidrawSurface(connection, label) {
  const layout = await evaluate(
    connection,
    `(() => {
      const describe = (element) => {
        if (!(element instanceof HTMLElement)) return null;
        const bounds = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
          childCount: element.childElementCount,
          className: element.className,
          display: style.display,
          hidden: element.hidden,
          opacity: style.opacity,
          overflow: style.overflow,
          position: style.position,
          visibility: style.visibility,
          zIndex: style.zIndex,
        };
      };
      const surface = Array.from(document.querySelectorAll('.excalidraw')).find((candidate) => {
        const bounds = candidate.getBoundingClientRect();
        return bounds.width > 100 && bounds.height > 100;
      });
      const visibleControls = surface instanceof HTMLElement
        ? Array.from(surface.querySelectorAll('button, input, [role="button"]')).filter((candidate) => {
          const bounds = candidate.getBoundingClientRect();
          const style = getComputedStyle(candidate);
            return bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.right > 0 &&
              bounds.top < innerHeight && bounds.left < innerWidth && style.visibility !== 'hidden' &&
              style.display !== 'none' && Number.parseFloat(style.opacity || '1') > 0;
          })
        : [];
      const ancestors = [];
      let ancestor = surface;
      while (ancestor instanceof HTMLElement && ancestors.length < 8) {
        ancestors.push({ id: ancestor.id, ...describe(ancestor) });
        ancestor = ancestor.parentElement;
      }
      return {
        ancestors,
        canvas: describe(surface?.querySelector('canvas')),
        hostChildren: Array.from(document.querySelector('#plugin-surface-host')?.children ?? []).map((child) => ({
          id: child.id,
          ...describe(child),
        })),
        surface: describe(surface),
        visibleControlCount: visibleControls.length,
        visibleControls: visibleControls.slice(0, 12).map((control) => {
          const bounds = control.getBoundingClientRect();
          const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
          return {
            ariaLabel: control.getAttribute('aria-label'),
            className: control.className,
            hit: hit ? { id: hit.id, className: hit.className, tagName: hit.tagName } : null,
            hitOwned: hit ? control === hit || control.contains(hit) : false,
            text: control.textContent?.trim().slice(0, 80) ?? '',
            ...describe(control),
          };
        }),
      };
    })()`,
  );
  assert(
    layout.surface &&
      layout.visibleControlCount >= 5 &&
      layout.visibleControls.filter((control) => control.hitOwned).length >= 5,
    `${label} has no visibly painted interaction surface: ${JSON.stringify(layout)}`,
  );
  return layout;
}

async function drawEditGesture(filePath) {
  const sourcePath = path.join(vaultPath, filePath);
  const sourceBefore = sha256(await fs.readFile(sourcePath));
  const canvas = await evaluate(
    pluginCdp,
    `(() => { const canvas = Array.from(document.querySelectorAll('.excalidraw canvas')).find((candidate) => { const bounds = candidate.getBoundingClientRect(); return bounds.width > 0 && bounds.height > 0; }); if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Excalidraw canvas is missing for draw/edit'); const rect = canvas.getBoundingClientRect(); return { x: rect.left + Math.max(12, rect.width * 0.35), y: rect.top + Math.max(12, rect.height * 0.35), width: rect.width, height: rect.height }; })()`,
  );
  assert(canvas.width > 0 && canvas.height > 0, "Excalidraw canvas has no drawable bounds.");
  await pluginCdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: canvas.x,
    y: canvas.y,
    button: "left",
    clickCount: 1,
  });
  await pluginCdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: canvas.x + 72,
    y: canvas.y + 36,
    button: "left",
  });
  await pluginCdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: canvas.x + 72,
    y: canvas.y + 36,
    button: "left",
    clickCount: 1,
  });
  assert(
    await evaluate(
      pluginCdp,
      "Array.from(document.querySelectorAll('.excalidraw canvas')).some((canvas) => { const bounds = canvas.getBoundingClientRect(); return bounds.width > 0 && bounds.height > 0; })",
    ),
    "Excalidraw canvas disappeared after the draw/edit gesture.",
  );
  await pressKey(pluginCdp, "s", "KeyS", 2);
  await evaluate(cdp, "window.threadleaf.waitForPluginMutations()");
  const deadline = Date.now() + 30_000;
  let sourceAfter = sourceBefore;
  while (Date.now() < deadline && sourceAfter === sourceBefore) {
    await delay(80);
    sourceAfter = sha256(await fs.readFile(sourcePath));
  }
  assert(sourceAfter !== sourceBefore, "Excalidraw Ctrl+S did not persist the canvas edit.");
}

async function createAndEmbed(vaultId) {
  const createdContent = await fs.readFile(
    path.join(vaultPath, "Drawings/Unicode Scene.excalidraw.md"),
    "utf8",
  );
  const origin = await evaluate(cdp, "window.threadleaf.getSnapshot()");
  assert(
    (origin.workspace.activePluginFile?.path ?? origin.workspace.activeNote?.path) ===
      "Drawings/Unicode Scene.excalidraw.md",
    "The create flow did not begin from the drawing note.",
  );
  const created = await evaluate(
    cdp,
    `window.threadleaf.createNote('Drawings/Created.excalidraw.md', ${JSON.stringify(createdContent)}, ${JSON.stringify(vaultId)})`,
  );
  assert(
    created.outcome?.status === "committed",
    `Creating a drawing failed: ${JSON.stringify(created.outcome)}`,
  );
  assert(
    (created.snapshot?.workspace?.activePluginFile?.path ??
      created.snapshot?.workspace?.activeNote?.path) === "Drawings/Created.excalidraw.md",
    "The created drawing was not selected.",
  );
  const sourceTab = `.note-tab-activate[data-note-path=${JSON.stringify("Notes/Source.md")}]`;
  await waitFor(
    cdp,
    `(() => { const tab = document.querySelector(${JSON.stringify(sourceTab)}); return tab instanceof HTMLButtonElement && !tab.disabled; })()`,
    "source-note workspace tab",
  );
  await clickSelector(cdp, sourceTab);
  await waitFor(
    cdp,
    "document.querySelector('#note-path')?.textContent === 'Notes/Source.md'",
    "source-note switch",
  );
  const current = await evaluate(cdp, "window.threadleaf.getSnapshot()");
  const active = current.workspace.activeNote;
  assert(
    active?.path === "Notes/Source.md",
    `The source note was not active for embed insertion: ${JSON.stringify({
      activeNote: active?.path ?? null,
      activeCanvas: current.workspace.activeCanvas?.path ?? null,
      activePluginFile: current.workspace.activePluginFile?.path ?? null,
      activeUnavailable: current.workspace.activeUnavailable?.path ?? null,
    })}`,
  );
  const embedded = `${active.content}\n![[../Drawings/Created.excalidraw.md]]\n`;
  const saved = await evaluate(
    cdp,
    `window.threadleaf.saveNote('Notes/Source.md', ${JSON.stringify(embedded)}, ${JSON.stringify(active.revision)}, ${JSON.stringify(vaultId)})`,
  );
  assert(
    saved.outcome?.status === "committed",
    `Embed insertion failed: ${JSON.stringify(saved.outcome)}`,
  );
}

async function clickExportButton(label) {
  await waitFor(
    pluginCdp,
    `Boolean([...document.querySelectorAll('button.excalidraw-export-button')].find((button) => button.textContent?.trim() === ${JSON.stringify(label)}))`,
    `${label} export button`,
  );
  const inspectTarget = () =>
    evaluate(
      pluginCdp,
      `(() => {
        const button = [...document.querySelectorAll('button.excalidraw-export-button')].find(
          (candidate) => candidate.textContent?.trim() === ${JSON.stringify(label)}
        );
        if (!(button instanceof HTMLButtonElement)) return null;
        const rect = button.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        const scrollParent = [...(function* () { let node = button.parentElement; while (node) { yield node; node = node.parentElement; } })()].find((node) => {
          const style = getComputedStyle(node);
          return node.scrollHeight > node.clientHeight && (style.overflowY === 'auto' || style.overflowY === 'scroll');
        });
        const scrollRect = scrollParent?.getBoundingClientRect();
        const active = document.activeElement;
        return {
          activeClass: active instanceof HTMLElement ? active.className : null,
          activeTag: active?.tagName ?? null,
          activeText: active?.textContent?.trim().slice(0, 80) ?? null,
          disabled: button.disabled,
          height: rect.height,
          hit: Boolean(hit && (hit === button || button.contains(hit))),
          hitClass: hit instanceof HTMLElement ? hit.className : null,
          hitTag: hit?.tagName ?? null,
          hitText: hit?.textContent?.trim().slice(0, 80) ?? null,
          scroller: scrollRect ? {
            x: scrollRect.left + scrollRect.width / 2,
            y: scrollRect.top + scrollRect.height / 2,
            scrollTop: scrollParent.scrollTop,
            scrollHeight: scrollParent.scrollHeight,
            clientHeight: scrollParent.clientHeight,
          } : null,
          width: rect.width,
          x,
          y,
        };
      })()`,
    );
  let target = await inspectTarget();
  assert(target, `${label} export button is unavailable.`);
  if (!target.hit) {
    assert(target.scroller, `${label} export button is outside the viewport without a scroller.`);
    await pluginCdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      button: "none",
      x: target.scroller.x,
      y: target.scroller.y,
    });
    for (let attempt = 0; attempt < 8 && !target.hit; attempt += 1) {
      await pluginCdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        button: "none",
        deltaX: 0,
        deltaY: Math.max(120, Math.min(420, target.y - target.scroller.y)),
        x: target.scroller.x,
        y: target.scroller.y,
      });
      await delay(80);
      target = await inspectTarget();
      if (!target) {
        await captureCurrentTheme(
          pluginCdp,
          `excalidraw-export-dialog-${label.toLowerCase().replaceAll(" ", "-")}-lost`,
        );
      }
      assert(target, `${label} export button disappeared while scrolling.`);
    }
  }
  assert(!target.disabled, `${label} export button is disabled.`);
  assert(target.width > 0 && target.height > 0, `${label} export button is hidden.`);
  assert(target.hit, `${label} export button is covered: ${JSON.stringify(target)}`);
  await pluginCdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    button: "none",
    x: target.x,
    y: target.y,
  });
  await delay(40);
  target = await inspectTarget();
  assert(target?.hit, `${label} export button moved before pointer activation.`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await pluginCdp.send("Input.dispatchMouseEvent", {
      type,
      button: "left",
      buttons: type === "mousePressed" ? 1 : 0,
      clickCount: 1,
      x: target.x,
      y: target.y,
    });
  }
}

async function completeVaultExport(relativePath, label) {
  const absolute = path.join(vaultPath, relativePath);
  const deadline = Date.now() + 30_000;
  let bytes = null;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      bytes = await fs.readFile(absolute);
      break;
    } catch (error) {
      lastError = error;
      await delay(80);
    }
  }
  assert(
    bytes,
    `${label} did not create ${relativePath}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
  await evaluate(cdp, "window.threadleaf.waitForPluginMutations()");
  assert(bytes.length > 0, `${label} created an empty ${relativePath}.`);
  return bytes;
}

async function exportPublicFixtures() {
  const drawingPath = "Drawings/Unicode Scene.excalidraw.md";
  await runPaletteCommand(
    "obsidian-excalidraw-plugin:export-image",
    "export image",
    "plugin.command.obsidian-excalidraw-plugin:export-image",
  );
  await waitFor(
    pluginCdp,
    "document.body?.textContent?.includes('Export Drawing')",
    "Excalidraw export dialog",
  );
  await waitFor(
    pluginCdp,
    `(() => {
      const modal = [...document.querySelectorAll('.modal')].find((candidate) =>
        candidate.textContent?.includes('Export Drawing'),
      );
      if (!(modal instanceof HTMLElement)) return false;
      const bounds = modal.getBoundingClientRect();
      return bounds.width > 0 &&
        bounds.height > 0 &&
        bounds.top >= 0 &&
        bounds.left >= 0 &&
        bounds.bottom <= window.innerHeight &&
        bounds.right <= window.innerWidth;
    })()`,
    "visible Excalidraw export dialog",
  );
  await captureCurrentTheme(pluginCdp, "excalidraw-export-dialog-png");
  await clickExportButton("PNG to Vault");
  const png = await completeVaultExport("Drawings/Unicode Scene.excalidraw.png", "PNG export");
  assert(
    png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    "Plugin PNG export signature is invalid.",
  );

  await runPaletteCommand(
    "obsidian-excalidraw-plugin:export-image",
    "export image",
    "plugin.command.obsidian-excalidraw-plugin:export-image",
  );
  await waitFor(
    pluginCdp,
    "document.body?.textContent?.includes('Export Drawing')",
    "second Excalidraw export dialog",
  );
  await clickExportButton("SVG to Vault");
  const svg = await completeVaultExport("Drawings/Unicode Scene.excalidraw.svg", "SVG export");
  const svgText = svg.toString("utf8");
  assert(/^<svg[\s>]/u.test(svgText.trim()), "Plugin SVG export is not XML-shaped.");
  assert(svgText.includes("<svg"), "Plugin SVG export has no SVG root.");
  await runPaletteCommand(
    "obsidian-excalidraw-plugin:export-image",
    "export image",
    "plugin.command.obsidian-excalidraw-plugin:export-image",
  );
  await waitFor(
    pluginCdp,
    "document.body?.textContent?.includes('Export Drawing')",
    "dismissible Excalidraw export dialog",
  );
  await pluginCdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
  });
  await pluginCdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
  });
  await waitFor(
    pluginCdp,
    "!document.body?.textContent?.includes('Export Drawing')",
    "Escape-dismissed Excalidraw export dialog",
  );
  return {
    png: { path: "Drawings/Unicode Scene.excalidraw.png", sha256: sha256(png) },
    svg: { path: "Drawings/Unicode Scene.excalidraw.svg", sha256: sha256(svg) },
    source: drawingPath,
  };
}

async function reloadPlugin(vaultId) {
  await waitFor(
    cdp,
    "document.querySelector('#reload-plugin')?.disabled === false",
    "visible Excalidraw reload control",
  );
  await clickSelector(cdp, "#reload-plugin");
  await waitFor(
    cdp,
    `(async () => { const s = await window.threadleaf.getSnapshot(); return (s.plugins ?? []).some((p) => p.id === ${JSON.stringify(pluginId)} && p.state === 'loaded'); })()`,
    "Excalidraw reload",
    60_000,
  );
  assert(
    (await evaluate(
      cdp,
      "(async () => (await window.threadleaf.getSnapshot()).workspace?.state)()",
    )) === "ready",
    "Native workspace stopped responding after reload.",
  );
  assert(vaultId, "Vault identity was lost across plugin reload.");
}

async function unloadReload(vaultId) {
  await reloadPlugin(vaultId);
}

async function reloadWithCompression(vaultId, compress) {
  const dataPath = path.join(pluginPath, "data.json");
  const settings = JSON.parse(await fs.readFile(dataPath, "utf8"));
  await fs.writeFile(dataPath, JSON.stringify({ ...settings, compress }));
  await reloadPlugin(vaultId);
}

async function assertDrawingChrome(filePath, popoutState = "closed") {
  const chrome = await evaluate(
    cdp,
    `(() => {
      const toolbar = document.querySelector('.note-toolbar');
      const noteTitle = document.querySelector('#note-title');
      const noteView = document.querySelector('#note-view');
      const host = document.querySelector('#plugin-surface-host');
      const status = document.querySelector('#plugin-surface-status');
      const popout = document.querySelector('#pop-out-plugin-view');
      return {
        path: document.querySelector('#note-path')?.textContent ?? null,
        toolbarVisible: toolbar instanceof HTMLElement && !toolbar.hidden,
        noteViewHidden: noteView instanceof HTMLElement && noteView.hidden,
        noteTitleHidden: noteTitle instanceof HTMLElement && (noteTitle.hidden || noteView?.hidden === true),
        hostVisible: host instanceof HTMLElement && !host.hidden,
        hostPopoutState: host instanceof HTMLElement ? host.dataset.popoutState ?? null : null,
        status: status?.textContent ?? null,
        popoutLabel: popout?.getAttribute('aria-label') ?? null,
        popoutHidden: popout instanceof HTMLElement ? popout.hidden : null,
      };
    })()`,
  );
  assert(
    chrome.path === filePath,
    `The Threadleaf filename chrome changed: ${JSON.stringify(chrome)}`,
  );
  assert(
    chrome.toolbarVisible,
    "Threadleaf toolbar chrome disappeared while Excalidraw was active.",
  );
  assert(chrome.noteTitleHidden, "The ordinary Markdown title leaked into the plugin-owned view.");
  assert(chrome.hostVisible, "The plugin surface host was hidden while Excalidraw was active.");
  assert(
    chrome.hostPopoutState === popoutState,
    `Plugin surface host ownership drifted: ${JSON.stringify(chrome)}`,
  );
  if (compatibilityTopology === "trusted-workspace") {
    assert(
      chrome.popoutHidden === true,
      `Trusted-workspace plugin pop-out action exposed an unsupported transition: ${JSON.stringify(chrome)}`,
    );
  } else {
    assert(
      chrome.popoutLabel ===
        (popoutState === "open" ? "Reattach plugin view" : "Pop out plugin view"),
      `Plugin pop-out toolbar action has the wrong ownership state: ${JSON.stringify(chrome)}`,
    );
  }
  return chrome;
}

async function exerciseSettingsWhileDrawing(vaultId, filePath) {
  const sourcePath = path.join(vaultPath, filePath);
  const sourceBefore = await waitForStableFileBytes(sourcePath);
  const semanticSourceBefore = excalidrawSceneSemanticDigest(sourceBefore);
  await assertDrawingChrome(filePath);
  await waitForExcalidrawCanvas(pluginCdp, "visible Excalidraw canvas before settings");

  await clickSelector(cdp, "#settings-trigger");
  await waitFor(
    cdp,
    "document.querySelector('#shortcut-settings')?.open === true",
    "settings dialog",
  );
  const settingsSnapshot = await waitFor(
    cdp,
    `(async () => {
      const snapshot = await window.threadleaf.getSnapshot();
      return (snapshot.workspace?.activePluginFile?.path ?? snapshot.workspace?.activeNote?.path) === ${JSON.stringify(filePath)} &&
        snapshot.pluginSurface === null &&
        snapshot.workspace?.state === 'ready'
        ? snapshot
        : null;
    })()`,
    "settings closed the active plugin leaf safely",
  );
  assert(settingsSnapshot.vault.id === vaultId, "Settings changed the active vault identity.");
  const settingsResponseMs = await measureResponse(cdp, "main renderer with settings open");
  const settingsShots = [
    await capture(cdp, "excalidraw-settings", "dark"),
    await capture(cdp, "excalidraw-settings", "light"),
  ];
  assert(
    settingsShots[0].digest !== settingsShots[1].digest,
    "Settings theme screenshots are identical.",
  );
  const settingsPositiveBefore = await capture(cdp, "excalidraw-settings-positive-before", "dark");
  const positiveApplied = await evaluate(
    cdp,
    `(() => {
      const target = document.querySelector('#shortcut-settings');
      if (!(target instanceof HTMLElement)) return false;
      target.dataset.visualPositiveControl = 'true';
      target.style.outline = '10px solid rgb(255, 0, 255)';
      target.style.outlineOffset = '-10px';
      return getComputedStyle(target).outlineColor === 'rgb(255, 0, 255)';
    })()`,
  );
  assert(positiveApplied, "Main settings screenshot positive control did not apply.");
  const settingsPositiveAfter = await capture(cdp, "excalidraw-settings-positive-after", "dark");
  assert(
    settingsPositiveBefore.digest !== settingsPositiveAfter.digest,
    "Main settings screenshot positive control changed no pixels.",
  );
  await evaluate(
    cdp,
    `(() => {
      const target = document.querySelector('[data-visual-positive-control="true"]');
      target?.style.removeProperty('outline');
      target?.style.removeProperty('outline-offset');
      target?.removeAttribute('data-visual-positive-control');
      return true;
    })()`,
  );
  await clickSelector(cdp, "#settings-close");
  await waitFor(
    cdp,
    `(async () => {
      const snapshot = await window.threadleaf.getSnapshot();
      return document.querySelector('#shortcut-settings')?.open !== true &&
        snapshot.pluginSurface?.viewType === 'excalidraw' &&
        snapshot.pluginSurface?.filePath === ${JSON.stringify(filePath)}
        ? snapshot
        : null;
    })()`,
    "Excalidraw drawing restore after main settings",
  );
  await waitForExcalidrawCanvas(pluginCdp, "visible Excalidraw canvas after main settings");
  await clickSelector(cdp, "#settings-trigger");
  await waitFor(
    cdp,
    "document.querySelector('#shortcut-settings')?.open === true",
    "settings dialog reopen before plugin options",
  );
  await clickSelector(cdp, "#settings-nav-plugins");
  await waitFor(
    cdp,
    "document.querySelector('[data-settings-page=\"plugins\"]')?.hidden === false",
    "community plugin settings page",
  );
  const optionsSelector = `.plugin-row[data-plugin-id=${JSON.stringify(pluginId)}] .plugin-options-button`;
  await waitFor(
    cdp,
    `(() => { const button = document.querySelector(${JSON.stringify(optionsSelector)}); return button instanceof HTMLButtonElement && !button.hidden && !button.disabled; })()`,
    "Excalidraw options control",
  );
  await clickSelector(cdp, optionsSelector);
  await waitFor(
    cdp,
    `(async () => {
      const snapshot = await window.threadleaf.getSnapshot();
      return !document.querySelector('#shortcut-settings')?.open &&
        snapshot.pluginSurface?.viewType === 'threadleaf-plugin-settings'
        ? snapshot
        : null;
    })()`,
    "Excalidraw plugin-owned settings surface",
  );
  const pluginSettingsHealth = await evaluate(
    pluginCdp,
    `(() => ({
      text: document.body.innerText,
      errors: window.__threadleafConsoleErrors ?? [],
      brokenImages: [...document.images]
        .filter((image) => {
          const bounds = image.getBoundingClientRect();
          const intersectsViewport = bounds.bottom > 0 && bounds.right > 0 &&
            bounds.top < innerHeight && bounds.left < innerWidth;
          const source = image.currentSrc || image.getAttribute('src') || '';
          return Boolean(source) && !/^https?:/u.test(source) && intersectsViewport &&
            image.complete && image.naturalWidth === 0;
        })
        .map((image) => ({ src: image.getAttribute('src'), alt: image.getAttribute('alt') })),
      remoteMediaWarnings: [...document.images]
        .filter((image) => {
          const bounds = image.getBoundingClientRect();
          const source = image.currentSrc || image.getAttribute('src') || '';
          return /^https?:/u.test(source) && bounds.bottom > 0 && bounds.right > 0 &&
            bounds.top < innerHeight && bounds.left < innerWidth && image.complete &&
            image.naturalWidth === 0;
        })
        .map((image) => ({ src: image.getAttribute('src'), alt: image.getAttribute('alt') })),
    }))()`,
  );
  assert(
    !/WARNING: Excalidraw ran into an unknown problem!/u.test(pluginSettingsHealth.text),
    `Excalidraw settings rendered its recovery notice: ${JSON.stringify(pluginSettingsHealth)}`,
  );
  assert(
    pluginSettingsHealth.brokenImages.length === 0,
    `Excalidraw settings rendered broken images: ${JSON.stringify(pluginSettingsHealth.brokenImages)}`,
  );
  const pluginSettingsResponseMs = await measureResponse(pluginCdp, "Excalidraw settings renderer");
  const pluginSettingsShots = [
    await capture(pluginCdp, "excalidraw-plugin-settings", "dark"),
    await capture(pluginCdp, "excalidraw-plugin-settings", "light"),
  ];
  assert(
    pluginSettingsShots[0].digest !== pluginSettingsShots[1].digest,
    "Excalidraw settings theme screenshots are identical.",
  );
  await waitFor(
    cdp,
    "document.querySelector('#plugin-view') instanceof HTMLButtonElement && document.querySelector('#plugin-view').disabled === false",
    "enabled Excalidraw settings close control",
  );
  await clickSelector(cdp, "#plugin-view");
  await waitFor(
    cdp,
    `(async () => {
      const snapshot = await window.threadleaf.getSnapshot();
      return snapshot.pluginSurface?.viewType === 'excalidraw' &&
        snapshot.pluginSurface?.filePath === ${JSON.stringify(filePath)}
        ? snapshot
        : null;
    })()`,
    "Excalidraw drawing restore after plugin-owned settings",
  );
  await waitForExcalidrawCanvas(pluginCdp, "visible Excalidraw canvas after plugin-owned settings");
  await evaluate(cdp, "window.threadleaf.waitForPluginMutations()");
  const sourceAfter = await waitForStableFileBytes(sourcePath);
  assert(
    excalidrawSceneSemanticDigest(sourceAfter) === semanticSourceBefore,
    "Opening and closing settings changed Excalidraw scene content or surrounding Markdown.",
  );
  return {
    settingsResponseMs,
    pluginSettingsResponseMs,
    settingsThemes: settingsShots.map(({ filePath: shotPath }) => shotPath),
    pluginSettingsThemes: pluginSettingsShots.map(({ filePath: shotPath }) => shotPath),
  };
}

async function exercisePopout(port, filePath) {
  await assertDrawingChrome(filePath);
  await waitForExcalidrawCanvas(pluginCdp, "attached Excalidraw canvas before pop-out");
  const attachedSize = await evaluate(
    pluginCdp,
    "({ width: innerWidth, height: innerHeight, canvas: document.querySelector('canvas')?.getBoundingClientRect().toJSON() ?? null })",
  );
  await clickSelector(cdp, "#pop-out-plugin-view");
  await waitFor(
    cdp,
    "(async () => (await window.threadleaf.getSnapshot()).workspaceLayout?.popout.state === 'open')()",
    "Excalidraw pop-out",
  );
  const pageTargets = await cdpTargets(port);
  const popoutTarget = pageTargets.find(
    (target) => target.type === "page" && target.url === "about:blank",
  );
  const pluginSurfaceTarget = pageTargets.find(
    (target) => target.type === "page" && target.url.includes("plugin-host.html"),
  );
  assert(popoutTarget?.webSocketDebuggerUrl, "Excalidraw native pop-out target did not appear.");
  assert(
    pluginSurfaceTarget?.webSocketDebuggerUrl,
    "Excalidraw detached plugin surface did not appear.",
  );
  await waitForExcalidrawCanvas(pluginCdp, "detached Excalidraw canvas");
  const detachedSize = await evaluate(
    pluginCdp,
    "({ width: innerWidth, height: innerHeight, canvas: document.querySelector('canvas')?.getBoundingClientRect().toJSON() ?? null })",
  );
  assert(
    detachedSize.width >= 640 && detachedSize.height >= 480,
    `Detached Excalidraw surface did not receive native bounds: ${JSON.stringify(detachedSize)}`,
  );
  assert(
    detachedSize.width > attachedSize.width || detachedSize.height > attachedSize.height,
    `Detached Excalidraw surface did not grow beyond the main pane: ${JSON.stringify({ attachedSize, detachedSize })}`,
  );
  await assertDrawingChrome(filePath, "open");
  const mainResponseMs = await measureResponse(cdp, "main renderer with detached Excalidraw");
  const detachedResponseMs = await measureResponse(pluginCdp, "detached Excalidraw renderer");
  const mainShots = [
    await capture(cdp, "excalidraw-popout-main", "dark"),
    await capture(cdp, "excalidraw-popout-main", "light"),
  ];
  const detachedShots = [
    await capture(pluginCdp, "excalidraw-detached", "dark"),
    await capture(pluginCdp, "excalidraw-detached", "light"),
  ];
  assert(
    mainShots[0].digest !== mainShots[1].digest,
    "Detached-state main screenshots are identical.",
  );
  assert(
    detachedShots[0].digest !== detachedShots[1].digest,
    "Detached Excalidraw screenshots are identical.",
  );
  const mainPositiveBefore = await capture(cdp, "excalidraw-popout-main-positive-before", "dark");
  await evaluate(
    cdp,
    `(() => {
      const target = document.querySelector('#workspace-root');
      if (!(target instanceof HTMLElement)) return false;
      target.dataset.visualPositiveControl = 'true';
      target.style.outline = '10px solid rgb(230, 159, 0)';
      target.style.outlineOffset = '-10px';
      return getComputedStyle(target).outlineColor === 'rgb(230, 159, 0)';
    })()`,
  );
  const mainPositiveAfter = await capture(cdp, "excalidraw-popout-main-positive-after", "dark");
  assert(
    mainPositiveBefore.digest !== mainPositiveAfter.digest,
    "Main detached-state positive control changed no pixels.",
  );
  await evaluate(
    cdp,
    `(() => {
      const target = document.querySelector('[data-visual-positive-control="true"]');
      target?.style.removeProperty('outline');
      target?.style.removeProperty('outline-offset');
      target?.removeAttribute('data-visual-positive-control');
      return true;
    })()`,
  );
  const detachedPositiveBefore = await capture(
    pluginCdp,
    "excalidraw-detached-positive-before",
    "dark",
  );
  await evaluate(
    pluginCdp,
    `(() => {
      const target = document.createElement('div');
      target.id = 'detached-visual-positive-control';
      target.style.cssText = 'position:fixed; inset:8px; z-index:2147483647; border:10px solid rgb(255, 0, 255); pointer-events:none;';
      document.body.append(target);
      return getComputedStyle(target).borderTopColor === 'rgb(255, 0, 255)';
    })()`,
  );
  const detachedPositiveAfter = await capture(
    pluginCdp,
    "excalidraw-detached-positive-after",
    "dark",
  );
  assert(
    detachedPositiveBefore.digest !== detachedPositiveAfter.digest,
    "Detached Excalidraw positive control changed no pixels.",
  );
  await evaluate(
    pluginCdp,
    `(() => {
      document.querySelector('#detached-visual-positive-control')?.remove();
      return true;
    })()`,
  );
  await clickSelector(cdp, "#pop-out-plugin-view");
  await waitFor(
    cdp,
    `(async () => {
      const snapshot = await window.threadleaf.getSnapshot();
      return snapshot.workspaceLayout?.popout.state === 'closed' && snapshot.pluginSurface?.viewType === 'excalidraw'
        ? snapshot
        : null;
    })()`,
    "Excalidraw pop-out reattach",
  );
  await waitForExcalidrawCanvas(pluginCdp, "reattached Excalidraw canvas");
  await waitFor(
    cdp,
    "document.querySelector('#pop-out-plugin-view')?.getAttribute('aria-label') === 'Pop out plugin view'",
    "Excalidraw reattached toolbar ownership",
  );
  await assertDrawingChrome(filePath);
  const reattachedSize = await evaluate(pluginCdp, "({ width: innerWidth, height: innerHeight })");
  assert(
    reattachedSize.width < detachedSize.width || reattachedSize.height < detachedSize.height,
    `Reattached Excalidraw surface retained detached bounds: ${JSON.stringify({ detachedSize, reattachedSize })}`,
  );
  return {
    mainResponseMs,
    detachedResponseMs,
    attachedSize,
    detachedSize,
    reattachedSize,
    screenshots: [...mainShots, ...detachedShots].map(({ filePath: shotPath }) => shotPath),
  };
}

async function exercisePopoutCrash(port, filePath) {
  await clickSelector(cdp, "#pop-out-plugin-view");
  await waitFor(
    cdp,
    "(async () => (await window.threadleaf.getSnapshot()).workspaceLayout?.popout.state === 'open')()",
    "Excalidraw pop-out before crash",
  );
  const mainPid = await isolatedElectronMainProcessId();
  assert(mainPid, "The isolated Electron main process was unavailable for pop-out crash recovery.");
  process.kill(mainPid, "SIGUSR2");
  const recovered = await waitFor(
    cdp,
    `(async () => {
      const snapshot = await window.threadleaf.getSnapshot();
      return snapshot.workspaceLayout?.popout.state === 'degraded' &&
        snapshot.workspaceLayout.popout.warning?.includes('crashed') &&
        snapshot.pluginSurface?.viewType === 'excalidraw' &&
        snapshot.workspace?.state === 'ready'
        ? snapshot
        : null;
    })()`,
    "Excalidraw pop-out crash recovery",
    30_000,
  );
  assert(
    recovered.workspaceLayout.popout.filePath === filePath,
    `Pop-out crash recovery lost the drawing identity: ${JSON.stringify(recovered.workspaceLayout.popout)}`,
  );
  assert(
    (await cdpTargets(port)).every((target) => target.url !== "about:blank"),
    "The crashed Excalidraw pop-out target remained alive.",
  );
  assert(
    (await evaluate(cdp, "document.querySelector('#plugin-surface-status')?.textContent")) ===
      "Plugin pop-out unavailable; plugin view is open in the main window.",
    "Excalidraw crash recovery did not restore main-window ownership.",
  );
  await assertDrawingChrome(filePath, "degraded");
  await waitForExcalidrawCanvas(pluginCdp, "crash-recovered Excalidraw canvas");
  const responseMs = await measureResponse(cdp, "main renderer after Excalidraw pop-out crash");
  const recoveredSurfaceResponseMs = await measureResponse(
    pluginCdp,
    "Excalidraw surface after pop-out crash",
  );
  await capture(cdp, "excalidraw-popout-crash-recovered-main", "dark");
  await capture(pluginCdp, "excalidraw-popout-crash-recovered-surface", "dark");
  await clickSelector(cdp, "#pop-out-plugin-view");
  await waitFor(
    cdp,
    "(async () => (await window.threadleaf.getSnapshot()).workspaceLayout?.popout.state === 'open')()",
    "Excalidraw pop-out reopen after crash",
  );
  await waitForExcalidrawCanvas(pluginCdp, "reopened Excalidraw pop-out canvas");
  await clickSelector(cdp, "#pop-out-plugin-view");
  await waitFor(
    cdp,
    `(async () => {
      const snapshot = await window.threadleaf.getSnapshot();
      return snapshot.workspaceLayout?.popout.state === 'closed' && snapshot.workspaceLayout.popout.warning === null
        ? snapshot
        : null;
    })()`,
    "Excalidraw pop-out warning cleanup",
  );
  await waitForExcalidrawCanvas(pluginCdp, "post-crash reattached Excalidraw canvas");
  await assertDrawingChrome(filePath);
  return { responseMs, recoveredSurfaceResponseMs };
}

async function exercisePluginRendererCrash(vaultId, filePath, port) {
  const pluginTargets = (await cdpTargets(port)).filter(
    (target) => target.type === "page" && target.url.includes("plugin-host.html"),
  );
  assert(pluginTargets.length > 0, "No Excalidraw compatibility renderer existed to crash.");
  for (const target of pluginTargets) {
    const connection = connectCdp(target.webSocketDebuggerUrl);
    try {
      await connection.send(
        "Runtime.evaluate",
        { expression: "process.kill(process.pid, 'SIGKILL')" },
        2_000,
      );
    } catch (error) {
      assert(
        /closed|timed out/iu.test(error instanceof Error ? error.message : String(error)),
        `Excalidraw renderer crash trigger failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      connection.close();
    }
  }
  pluginCdp.close();
  pluginCdp = null;
  let recovered;
  try {
    recovered = await waitFor(
      cdp,
      `(async () => {
        const snapshot = await window.threadleaf.getSnapshot();
        const plugin = snapshot.plugins?.find((candidate) => candidate.id === ${JSON.stringify(pluginId)});
        return snapshot.workspace?.state === 'ready' &&
          snapshot.pluginSurface === null &&
          plugin?.state === 'failed' &&
          snapshot.events?.some((event) => event.message.includes('Recovered the compatibility renderer'))
          ? snapshot
          : null;
      })()`,
      "Excalidraw compatibility renderer crash recovery",
      30_000,
    );
  } catch (error) {
    const observed = await evaluate(cdp, "window.threadleaf.getSnapshot()").catch(() => null);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}: ${JSON.stringify({ workspaceState: observed?.workspace?.state, plugin: observed?.plugins?.find((candidate) => candidate.id === pluginId), pluginSurface: observed?.pluginSurface, notice: observed?.notices?.at(-1), popout: observed?.workspaceLayout?.popout })}`,
    );
  }
  assert(
    recovered.events?.some((event) =>
      event.message.includes("Recovered the compatibility renderer"),
    ),
    `Excalidraw renderer crash did not expose a durable recovery event: ${JSON.stringify(recovered.events)}`,
  );
  const responseMs = await measureResponse(cdp, "main renderer after Excalidraw renderer crash");
  await capture(cdp, "excalidraw-plugin-crash-recovered-main", "dark");
  await waitFor(
    cdp,
    "document.querySelector('#reload-plugin')?.disabled === false",
    "visible plugin reload after renderer crash",
  );
  await clickSelector(cdp, "#reload-plugin");
  await waitFor(
    cdp,
    `(async () => (await window.threadleaf.getSnapshot()).plugins?.some((plugin) => plugin.id === ${JSON.stringify(pluginId)} && plugin.state === 'loaded'))()`,
    "Excalidraw reload after renderer crash",
    60_000,
  );
  await openDrawing(filePath, vaultId);
  await connectPluginSurface(port);
  return {
    induced: true,
    responseMs,
    trigger: "isolated-plugin-renderer-self-sigkill",
    rendererCount: pluginTargets.length,
  };
}

async function run() {
  if (process.platform !== "linux")
    throw new Error("The packaged Excalidraw workflow currently requires Linux and Xvfb.");
  assert(await exists(electronPath), "Electron is not installed; packaged workflow is unverified.");
  assert(await exists(sourceVault), `The Excalidraw source vault is missing: ${sourceVault}`);
  await fs.cp(sourceVault, vaultPath, { recursive: true });
  await fs.cp(fixtureVault, secondVaultPath, { recursive: true });
  await fs.symlink(vaultPath, pickerLink);
  await fs.mkdir(userDataPath, { recursive: true });
  const before = await canonicalManifest();
  const secondBefore = await canonicalManifest(secondVaultPath);
  const pluginState = await writePluginFixture();
  await prepareInstalledPluginMatrix();
  const port = await availablePort();
  const first = await startApp(port, pluginState);
  if (installedPluginMatrixRoot) {
    await runInstalledPluginMatrix(first.vaultId, port, pluginState);
    return;
  }
  const targetPort = port;
  const paletteCreatedPath = await createDrawingThroughOrdinaryPalette(first.vaultId, targetPort);
  await captureCurrentTheme(cdp, "excalidraw-command-created-app");
  await captureCurrentTheme(pluginCdp, "excalidraw-command-created-canvas");
  const filePath = "Drawings/Unicode Scene.excalidraw.md";
  const compressedPath = "Drawings/Compressed Scene.excalidraw.md";
  const nativePath = "Drawings/Native Scene.excalidraw";
  const representationPreservationPaths = [compressedPath, nativePath];
  await openDrawing(filePath, first.vaultId);
  await connectPluginSurface(targetPort);
  const appShots = [
    await capture(cdp, "excalidraw-app", "dark"),
    await capture(cdp, "excalidraw-app", "light"),
  ];
  const pluginShots = [
    await capture(pluginCdp, "excalidraw-canvas", "dark"),
    await capture(pluginCdp, "excalidraw-canvas", "light"),
  ];
  assert(appShots[0].digest !== appShots[1].digest, "App theme screenshots are identical.");
  assert(
    pluginShots[0].digest !== pluginShots[1].digest,
    "Excalidraw theme screenshots are identical.",
  );
  const positiveBefore = await capture(pluginCdp, "excalidraw-positive-before", "dark");
  await evaluate(
    pluginCdp,
    "(() => { const target = document.querySelector('#plugin-surface-host:not([hidden])') ?? Array.from(document.querySelectorAll('.excalidraw')).find((surface) => { const bounds = surface.getBoundingClientRect(); return bounds.width > 0 && bounds.height > 0; }); if (!(target instanceof HTMLElement)) throw new Error('visual positive-control surface missing'); target.dataset.visualPositiveControl='true'; target.style.filter='invert(1)'; return true; })()",
  );
  const positiveAfter = await capture(pluginCdp, "excalidraw-positive-after", "dark");
  assert(
    positiveBefore.digest !== positiveAfter.digest,
    "Screenshot positive control did not change captured pixels.",
  );
  await evaluate(
    pluginCdp,
    "(() => { const target = document.querySelector('[data-visual-positive-control]'); target?.style.removeProperty('filter'); target?.removeAttribute('data-visual-positive-control'); return true; })()",
  );
  const compressedSource = await fs.readFile(path.join(vaultPath, compressedPath), "utf8");
  const compressedSetting = /^```compressed-json[ \t]*$/mu.test(compressedSource);
  assert(
    compressedSetting || /^```json[ \t]*$/mu.test(compressedSource),
    "The compressed-scene fixture has no supported Excalidraw scene fence.",
  );
  await reloadWithCompression(first.vaultId, compressedSetting);
  await openDrawing(compressedPath, first.vaultId);
  await connectPluginSurface(targetPort);
  await captureCurrentTheme(pluginCdp, "excalidraw-compressed-canvas");
  assert(
    sha256(await fs.readFile(path.join(vaultPath, compressedPath))) ===
      before.result[compressedPath]?.sha256,
    "Opening the compressed scene under its matching setting changed source bytes.",
  );
  const compressedTabCloseSelector = `.note-tab-close[data-note-path=${JSON.stringify(compressedPath)}]`;
  await waitFor(
    cdp,
    `(() => { const button = document.querySelector(${JSON.stringify(compressedTabCloseSelector)}); return button instanceof HTMLButtonElement && !button.disabled; })()`,
    "compressed scene tab close control",
  );
  await clickSelector(cdp, compressedTabCloseSelector);
  await waitFor(
    cdp,
    `(async () => !(await window.threadleaf.getSnapshot()).workspace?.tabs.some((tab) => tab.path === ${JSON.stringify(compressedPath)}))()`,
    "compressed scene tab close",
  );

  await reloadWithCompression(first.vaultId, false);
  assert(
    sha256(await fs.readFile(path.join(vaultPath, compressedPath))) ===
      before.result[compressedPath]?.sha256,
    "Unloading the compressed scene under its matching setting changed source bytes.",
  );
  await openDrawing(nativePath, first.vaultId, { viaNavigator: true });
  await connectPluginSurface(targetPort);
  await captureCurrentTheme(cdp, "excalidraw-native-app");
  await captureCurrentTheme(pluginCdp, "excalidraw-native-canvas");
  await openDrawing(filePath, first.vaultId);
  await connectPluginSurface(targetPort);
  await drawEditGesture(filePath);
  await createAndEmbed(first.vaultId);
  await openDrawing(filePath, first.vaultId);
  await connectPluginSurface(targetPort);
  const exports = await exportPublicFixtures();
  await openDrawing(filePath, first.vaultId);
  await connectPluginSurface(port);
  const settings = await exerciseSettingsWhileDrawing(first.vaultId, filePath);
  const detachedSurfaceSupported = compatibilityTopology === "isolated";
  const popout = detachedSurfaceSupported ? await exercisePopout(port, filePath) : null;
  const popoutCrash = detachedSurfaceSupported ? await exercisePopoutCrash(port, filePath) : null;
  const pluginCrash = detachedSurfaceSupported
    ? await exercisePluginRendererCrash(first.vaultId, filePath, port)
    : { induced: false, reason: "trusted-workspace-shared-renderer" };
  if (detachedSurfaceSupported && !pluginCrash.induced) {
    console.error(`Excalidraw plugin renderer crash was not inducible: ${pluginCrash.reason}`);
    await assertDrawingChrome(filePath);
  }

  if (detachedSurfaceSupported) {
    await clickSelector(cdp, "#pop-out-plugin-view");
    await waitFor(
      cdp,
      "(async () => (await window.threadleaf.getSnapshot()).workspaceLayout?.popout.state === 'open')()",
      "Excalidraw pop-out before vault switch",
    );
  }
  const firstSourceBeforeSwitch = sha256(await fs.readFile(path.join(vaultPath, filePath)));
  await fs.unlink(pickerLink);
  await fs.symlink(secondVaultPath, pickerLink);
  await evaluate(
    cdp,
    `(() => {
      window.__threadleafE2EOpenVaultClicks = [];
      document.querySelector('#open-vault')?.addEventListener('click', (event) => {
        window.__threadleafE2EOpenVaultClicks.push({
          at: Date.now(),
          disabled: event.currentTarget instanceof HTMLButtonElement ? event.currentTarget.disabled : null,
        });
      });
      return true;
    })()`,
  );
  for (let stable = 0; stable < 5; stable += 1) {
    await waitFor(
      cdp,
      "document.querySelector('#open-vault')?.disabled === false",
      "stable vault-open control",
    );
    await delay(100);
  }
  await clickSelector(cdp, "#open-vault");
  if (compatibilityTopology === "trusted-workspace") {
    await reconnectMainRenderer(targetPort);
  }
  let switched;
  try {
    switched = await waitFor(
      cdp,
      `(async () => {
        const snapshot = await window.threadleaf.getSnapshot();
        return snapshot.vault?.path === ${JSON.stringify(secondVaultPath)} &&
          snapshot.workspace?.state === 'ready' &&
          snapshot.pluginSurface === null &&
          snapshot.workspaceLayout?.popout.state === 'closed'
          ? snapshot
          : null;
      })()`,
      "vault switch from detached Excalidraw",
      30_000,
    );
  } catch (error) {
    const observed = await evaluate(cdp, "window.threadleaf.getSnapshot()").catch(() => null);
    const rendererDiagnostic = await evaluate(
      cdp,
      `({
        toast: document.querySelector('#toast')?.textContent ?? null,
        toastHidden: document.querySelector('#toast')?.hidden ?? null,
        runtimeState: document.querySelector('#runtime-state')?.textContent ?? null,
        openDisabled: document.querySelector('#open-vault')?.disabled ?? null,
        clicks: window.__threadleafE2EOpenVaultClicks ?? null,
      })`,
    ).catch(() => null);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}: ${JSON.stringify({ vault: observed?.vault, workspaceState: observed?.workspace?.state, pluginSurface: observed?.pluginSurface, popout: observed?.workspaceLayout?.popout, rendererDiagnostic })}`,
    );
  }
  assert(
    switched.workspaceLayout.popout.warning === null,
    `Vault switch left an unsafe pop-out warning: ${JSON.stringify(switched.workspaceLayout.popout)}`,
  );
  const secondAfterSwitch = await canonicalManifest(secondVaultPath);
  for (const entry of secondBefore.manifest.files) {
    assert(
      secondAfterSwitch.result[entry.path]?.sha256 === secondBefore.result[entry.path]?.sha256,
      `Vault switch changed second-vault bytes for ${entry.path}.`,
    );
  }
  await measureResponse(cdp, "main renderer after vault switch");
  await fs.unlink(pickerLink);
  await fs.symlink(vaultPath, pickerLink);
  await clickSelector(cdp, "#open-vault");
  if (compatibilityTopology === "trusted-workspace") {
    await reconnectMainRenderer(targetPort);
  }
  const returned = await waitFor(
    cdp,
    `(async () => {
      const snapshot = await window.threadleaf.getSnapshot();
      const plugin = snapshot.plugins?.find((candidate) => candidate.id === ${JSON.stringify(pluginId)});
      return snapshot.vault?.path === ${JSON.stringify(vaultPath)} &&
        snapshot.workspace?.state === 'ready' &&
        plugin?.state === 'loaded' &&
        snapshot.workspaceLayout?.popout.state === 'closed'
        ? snapshot
        : null;
    })()`,
    "return to Excalidraw vault",
    60_000,
  );
  assert(
    returned.vault.id === first.vaultId,
    "Returning to the Excalidraw vault changed its identity.",
  );
  await openDrawing(filePath, returned.vault.id);
  await connectPluginSurface(port);
  assert(
    sha256(await fs.readFile(path.join(vaultPath, filePath))) === firstSourceBeforeSwitch,
    "Vault switch changed the active Excalidraw source bytes.",
  );
  await unloadReload(returned.vault.id);
  await openDrawing(filePath, returned.vault.id);
  await connectPluginSurface(port);

  const restartSource = excalidrawSceneSemanticDigest(
    await waitForStableFileBytes(path.join(vaultPath, filePath)),
  );
  await openDrawing(nativePath, returned.vault.id, { viaNavigator: true });
  await connectPluginSurface(port);
  const nativeRestartSource = sha256(await fs.readFile(path.join(vaultPath, nativePath)));
  await closeApp();

  const restartPort = await availablePort();
  const restarted = await startApp(restartPort, pluginState, { prepareAuthority: false });
  await assertRestoredNativeDrawing(nativePath, restarted.vaultId);
  await connectPluginSurface(restartPort);
  await captureCurrentTheme(cdp, "excalidraw-restart-native-app");
  await captureCurrentTheme(pluginCdp, "excalidraw-restart-native-canvas");
  assert(
    sha256(await fs.readFile(path.join(vaultPath, nativePath))) === nativeRestartSource,
    "Restarting with the native scene active changed its source bytes.",
  );
  await openDrawing(filePath, restarted.vaultId);
  await connectPluginSurface(restartPort);
  await capture(pluginCdp, "excalidraw-restart", "dark");
  await openDrawing("Drawings/Created.excalidraw.md", restarted.vaultId);
  await connectPluginSurface(restartPort);
  await capture(pluginCdp, "excalidraw-restart-created", "dark");
  const after = await canonicalManifest();
  for (const entry of before.manifest.files) {
    if (entry.path.includes("Attachments/") || entry.path.startsWith("Assets/")) {
      assert(
        after.result[entry.path]?.sha256 === entry.sha256,
        `Attachment manifest changed for ${entry.path}.`,
      );
    }
  }
  assert(
    after.result["Drawings/Unicode Scene.excalidraw.md"]?.sha256 !==
      before.result["Drawings/Unicode Scene.excalidraw.md"]?.sha256,
    "The intentional scene edit did not change source bytes.",
  );
  assert(
    after.result["Notes/Source.md"]?.sha256 !== before.result["Notes/Source.md"]?.sha256,
    "The intentional embed edit did not change source bytes.",
  );
  for (const representationPath of representationPreservationPaths) {
    assert(
      after.result[representationPath]?.sha256 === before.result[representationPath]?.sha256,
      `Opening and restarting changed ${representationPath}.`,
    );
  }
  assert(
    excalidrawSceneSemanticDigest(await waitForStableFileBytes(path.join(vaultPath, filePath))) ===
      restartSource,
    "Restart changed the persisted Excalidraw scene content or surrounding Markdown.",
  );
  await measureResponse(cdp, "main renderer after Excalidraw restart");
  await measureResponse(pluginCdp, "Excalidraw renderer after restart");
  console.log(
    JSON.stringify(
      {
        status: "passed",
        compatibilityTopology,
        plugin: {
          id: pluginId,
          version: pluginVersion,
          source: pluginState.source,
          manifestSha256: pluginState.manifestSha256,
          mainSha256: pluginState.mainSha256,
          mainBytes: pluginState.mainBytes,
          stylesSha256: pluginState.stylesSha256,
          packageTreeSha256: pluginState.packageIdentity.packageTreeSha256,
          packageIdentityDigest: pluginState.packageIdentityDigest,
          authorityProfileId: pluginState.profileId,
          authorityProfileRevision: pluginState.profileRevision,
          authorityDigest: pluginState.authorityDigest,
        },
        workflows: [
          "create",
          "draw-edit",
          "compressed-and-native-scene-open",
          "embed",
          "svg-png-export",
          "note-switch",
          "settings-open-close-while-drawing-active",
          "plugin-owned-settings-open-close",
          "ordinary-command-palette-create-and-open",
          ...(detachedSurfaceSupported
            ? ["popout-detach-reattach", "popout-crash-degraded-recovery"]
            : []),
          ...(pluginCrash.induced ? ["plugin-renderer-crash-degraded-recovery"] : []),
          "vault-switch-popout-cleanup",
          "unload-reload",
          "native-scene-restart-recovery",
          "restart",
          "source-byte-and-attachment-manifest",
        ],
        screenshots,
        exports,
        paletteCreatedPath,
        responsivenessMs: {
          settingsMain: settings.settingsResponseMs,
          settingsPlugin: settings.pluginSettingsResponseMs,
          ...(popout
            ? {
                detachedMain: popout.mainResponseMs,
                detachedPlugin: popout.detachedResponseMs,
              }
            : {}),
          ...(popoutCrash
            ? {
                popoutCrashMain: popoutCrash.responseMs,
                popoutCrashPlugin: popoutCrash.recoveredSurfaceResponseMs,
              }
            : {}),
          ...(pluginCrash.induced ? { pluginCrashMain: pluginCrash.responseMs } : {}),
        },
        ...(popout
          ? {
              popoutSizes: {
                attached: popout.attachedSize,
                detached: popout.detachedSize,
                reattached: popout.reattachedSize,
              },
            }
          : {}),
        pluginRendererCrash: pluginCrash,
        screenshotThemes: [
          ...new Set(
            appShots
              .concat(pluginShots)
              .map((shot) => (shot.filePath.includes("-dark") ? "dark" : "light")),
          ),
        ],
      },
      null,
      2,
    ),
  );
}

try {
  await run();
} catch (error) {
  console.error(
    `Excalidraw packaged workflow: ${error instanceof Error ? error.message : String(error)}`,
  );
  if (output.length) console.error(output.join(""));
  process.exitCode = 1;
} finally {
  await closeApp().catch(() => undefined);
  if (keepTemporaryRoot) {
    console.error(`Excalidraw packaged workflow retained temporary root: ${testRoot}`);
  } else {
    await makeDisposableTreeRemovable(testRoot);
    await fs.rm(testRoot, { recursive: true, force: true });
  }
}
