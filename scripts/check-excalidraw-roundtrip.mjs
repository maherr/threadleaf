#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const appRoot = process.cwd();
const fixtureRoot = path.join(appRoot, "fixtures", "corpus", "excalidraw-roundtrip-v1");
const fixtureVault = path.join(fixtureRoot, "vault");
const sourceVaultOverride = process.env.THREADLEAF_EXCALIDRAW_SOURCE_VAULT?.trim();
const sourceVault = sourceVaultOverride ? path.resolve(sourceVaultOverride) : fixtureVault;
const pluginId = "obsidian-excalidraw-plugin";
const pluginVersion = "2.25.3";
const repository = "zsviczian/obsidian-excalidraw-plugin";
const pinnedPlugin = {
  id: pluginId,
  version: pluginVersion,
  manifestSha256: "43f18bc17c5c3f76af1a9a4191daa1c3566e2875aa4430561d57b7828785282e",
  mainSha256: "684cf6da43f6e3b2a7646d5a50d14f7a43eb5d859d073dc6a375c4a1b0990dd6",
  mainBytes: 4_898_048,
};
const electronPath = path.join(appRoot, "node_modules", ".bin", "electron");
const screenshotDirectoryOverride = process.env.THREADLEAF_EXCALIDRAW_SCREENSHOT_DIR;
const keepTemporaryRoot = process.env.THREADLEAF_EXCALIDRAW_KEEP_TEMP === "1";
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-excalidraw-e2e-"));
const vaultPath = path.join(testRoot, "vault");
const secondVaultPath = path.join(testRoot, "vault-two");
const pickerLink = path.join(testRoot, "picker-target");
const userDataPath = path.join(testRoot, "user-data");
const pluginPath = path.join(vaultPath, ".obsidian", "plugins", pluginId);
const screenshotDirectory = screenshotDirectoryOverride ?? path.join(testRoot, "screenshots");
const output = [];
const screenshots = [];
const cdpRequestTimeout = 15_000;
let child = null;
let cdp = null;
let pluginCdp = null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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
  assert(target.hit, `Pointer target is covered: ${selector}`);
  return target;
}

async function clickSelector(connection, selector) {
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

async function pressKey(connection, key, code, modifiers = 0) {
  const windowsVirtualKeyCode =
    key.length === 1
      ? key.toUpperCase().charCodeAt(0)
      : { Enter: 13, Escape: 27, ArrowLeft: 37, ArrowRight: 39 }[key];
  assert(windowsVirtualKeyCode, `Unsupported CDP key: ${key}`);
  await connection.send("Input.dispatchKeyEvent", {
    type: key.length === 1 ? "keyDown" : "rawKeyDown",
    code,
    key,
    modifiers,
    windowsVirtualKeyCode,
    nativeVirtualKeyCode: windowsVirtualKeyCode,
    text: key.length === 1 ? key : undefined,
  });
  await connection.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    code,
    key,
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
      sha256(plugin.manifestBytes) === pinnedPlugin.manifestSha256,
    `Excalidraw manifest bytes did not match pinned SHA-256 ${pinnedPlugin.manifestSha256}.`,
  );
  assert(
    Buffer.isBuffer(plugin.main) && plugin.main.length === pinnedPlugin.mainBytes,
    `Excalidraw main.js size did not match pinned ${pinnedPlugin.mainBytes} bytes.`,
  );
  assert(
    sha256(plugin.main) === pinnedPlugin.mainSha256,
    `Excalidraw main.js bytes did not match pinned SHA-256 ${pinnedPlugin.mainSha256}.`,
  );
}

async function writePluginFixture() {
  const plugin = await fetchPublicPlugin();
  assertPinnedPlugin(plugin);
  await fs.mkdir(pluginPath, { recursive: true });
  await fs.writeFile(
    path.join(pluginPath, "manifest.json"),
    JSON.stringify(plugin.manifest, null, 2),
  );
  await fs.writeFile(path.join(pluginPath, "main.js"), plugin.main);
  if (plugin.styles) await fs.writeFile(path.join(pluginPath, "styles.css"), plugin.styles);
  await fs.writeFile(
    path.join(pluginPath, "data.json"),
    JSON.stringify(pluginFixtureSettings(false)),
  );
  return {
    ...plugin,
    manifestSha256: sha256(plugin.manifestBytes),
    mainSha256: sha256(plugin.main),
    mainBytes: plugin.main.length,
    stylesSha256: plugin.styles ? sha256(plugin.styles) : null,
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

function synchronizeTextElementMappings(content, scene) {
  const section =
    /(^# Excalidraw Data[ \t]*\r?\n(?:\r?\n)?## Text Elements[ \t]*\r?\n)([\s\S]*?)(^%%[ \t]*\r?\n## Drawing[ \t]*\r?$)/mu.exec(
      content,
    );
  assert(section, "The canonical Excalidraw Text Elements section is missing.");
  const lineEnding = section[1].includes("\r\n") ? "\r\n" : "\n";
  const ids = new Set();
  const entries = (scene.elements ?? [])
    .filter((element) => element?.type === "text" && element.isDeleted !== true)
    .map((element) => {
      assert(
        typeof element.id === "string" && /^[A-Za-z0-9_-]{8}$/u.test(element.id),
        "Excalidraw text element IDs must be eight public-format characters.",
      );
      assert(!ids.has(element.id), `Duplicate Excalidraw text element ID: ${element.id}`);
      ids.add(element.id);
      const raw = element.rawText ?? element.originalText ?? element.text ?? "";
      return `${String(raw).replace(/\r?\n/gu, lineEnding)} ^${element.id}`;
    });
  const body =
    entries.length === 0
      ? lineEnding
      : `${entries.join(`${lineEnding}${lineEnding}`)}${lineEnding}${lineEnding}`;
  const start = section.index + section[1].length;
  const end = start + section[2].length;
  return `${content.slice(0, start)}${body}${content.slice(end)}`;
}

function sceneEdit(content) {
  const opening = "```json\n";
  const start = content.indexOf(opening);
  const end = content.indexOf("\n```", start + opening.length);
  assert(start >= 0 && end > start, "The uncompressed Excalidraw fixture fence is missing.");
  const scene = JSON.parse(content.slice(start + opening.length, end));
  const text = scene.elements?.find((element) => element.id === "text1234");
  assert(text, "The deterministic Excalidraw text element is missing.");
  text.text = "Ébauche dessinée";
  text.originalText = "Ébauche dessinée";
  text.rawText = "Ébauche dessinée";
  const payload = `${JSON.stringify(
    {
      files: scene.files,
      appState: scene.appState,
      elements: scene.elements,
      version: scene.version,
      source: scene.source,
      type: scene.type,
    },
    null,
    2,
  )}\n`;
  const edited = `${content.slice(0, start + opening.length)}${payload}${content.slice(end + 1)}`;
  return synchronizeTextElementMappings(edited, scene);
}

async function startApp(port, pluginState) {
  const settings = {
    version: 5,
    keyBindings: {},
    appearanceByVault: {},
    pluginsByVault: {
      [sha256(Buffer.from(vaultPath))]: {
        compatibilityMode: "enabled",
        enabledPluginIds: [],
        capabilityGrantsByPlugin: {},
      },
    },
    noteWorkflowsByVault: {},
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
    (candidate) => candidate.type === "page" && candidate.url.includes("/dist/renderer/index.html"),
    "main renderer",
    20_000,
  );
  cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
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
  assert(plugin.capabilityReport, "The Excalidraw authority report was unavailable.");
  await evaluate(
    cdp,
    `window.threadleaf.setPluginCapabilityGrant(${JSON.stringify(vaultId)}, ${JSON.stringify(pluginId)}, ${JSON.stringify(plugin.capabilityReport.bundleSha256)}, true)`,
  );
  await evaluate(
    cdp,
    `window.threadleaf.setPluginEnabled(${JSON.stringify(vaultId)}, ${JSON.stringify(pluginId)}, true)`,
  );
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
  await clickSelector(cdp, selector);
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
    `(() => { const button = document.querySelector('#plugin-view'); return button instanceof HTMLButtonElement && !button.hidden && !button.disabled; })()`,
    `visible Excalidraw control for ${filePath}`,
  );
  const alreadyOpen = await evaluate(
    cdp,
    `(async () => { const s = await window.threadleaf.getSnapshot(); const button = document.querySelector('#plugin-view'); return s.pluginSurface?.viewType === 'excalidraw' && s.pluginSurface?.filePath === ${JSON.stringify(filePath)} && button?.getAttribute('aria-pressed') === 'true'; })()`,
  );
  if (!alreadyOpen) {
    const stalePressed = await evaluate(
      cdp,
      "document.querySelector('#plugin-view')?.getAttribute('aria-pressed') === 'true'",
    );
    if (stalePressed) {
      await clickSelector(cdp, "#plugin-view");
      await waitFor(
        cdp,
        `(async () => { const s = await window.threadleaf.getSnapshot(); return document.querySelector('#plugin-view')?.getAttribute('aria-pressed') === 'false' && s.pluginSurface === null; })()`,
        `stale Excalidraw view close before reopening ${filePath}`,
      );
    }
    await clickSelector(cdp, "#plugin-view");
  }
  await waitFor(
    cdp,
    `(async () => { const s = await window.threadleaf.getSnapshot(); const host = document.querySelector('#plugin-surface-host'); const button = document.querySelector('#plugin-view'); return s.pluginSurface?.viewType === 'excalidraw' && s.pluginSurface?.filePath === ${JSON.stringify(filePath)} && host instanceof HTMLElement && !host.hidden && button?.getAttribute('aria-pressed') === 'true'; })()`,
    `Excalidraw view ${filePath}`,
    20_000,
  );
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
  pluginCdp?.close();
  pluginCdp = null;
  const target = await waitForTarget(
    port,
    (candidate) => candidate.type === "page" && candidate.url.includes("plugin-host.html"),
    "compatibility plugin renderer",
    20_000,
  );
  pluginCdp = connectCdp(target.webSocketDebuggerUrl);
  await pluginCdp.send("Page.enable");
  await waitFor(pluginCdp, "document.readyState === 'complete'", "plugin renderer document");
  await waitFor(
    pluginCdp,
    "(() => { const canvas = document.querySelector('canvas'); if (!(canvas instanceof HTMLCanvasElement)) return false; const bounds = canvas.getBoundingClientRect(); return bounds.width > 0 && bounds.height > 0 ? { width: bounds.width, height: bounds.height } : false; })()",
    "Excalidraw canvas",
    30_000,
  );
  return target;
}

async function directSceneEdit(vaultId, filePath) {
  const snapshot = await evaluate(cdp, "window.threadleaf.getSnapshot()");
  const note = snapshot.workspace.activeNote;
  assert(note?.path === filePath, "The active note changed before the scene edit.");
  const edited = sceneEdit(note.content);
  const result = await evaluate(
    cdp,
    `window.threadleaf.saveNote(${JSON.stringify(filePath)}, ${JSON.stringify(edited)}, ${JSON.stringify(note.revision)}, ${JSON.stringify(vaultId)})`,
  );
  assert(
    result.outcome?.status === "committed",
    `The scene edit did not commit: ${JSON.stringify(result.outcome)}`,
  );
}

async function drawEditGesture() {
  const canvas = await evaluate(
    pluginCdp,
    `(() => { const canvas = document.querySelector('canvas'); if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Excalidraw canvas is missing for draw/edit'); const rect = canvas.getBoundingClientRect(); return { x: rect.left + Math.max(12, rect.width * 0.35), y: rect.top + Math.max(12, rect.height * 0.35), width: rect.width, height: rect.height }; })()`,
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
    await evaluate(pluginCdp, "Boolean(document.querySelector('canvas'))"),
    "Excalidraw canvas disappeared after the draw/edit gesture.",
  );
}

async function createAndEmbed(vaultId) {
  const createdContent = await fs.readFile(
    path.join(vaultPath, "Drawings/Unicode Scene.excalidraw.md"),
    "utf8",
  );
  const origin = await evaluate(cdp, "window.threadleaf.getSnapshot()");
  assert(
    origin.workspace.activeNote?.path === "Drawings/Unicode Scene.excalidraw.md",
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
    created.snapshot?.workspace?.activeNote?.path === "Drawings/Created.excalidraw.md",
    "The created drawing was not selected.",
  );
  await evaluate(cdp, "window.threadleaf.openNote('Notes/Source.md')");
  await waitFor(
    cdp,
    "document.querySelector('#note-path')?.textContent === 'Notes/Source.md'",
    "source-note switch",
  );
  const current = await evaluate(cdp, "window.threadleaf.getSnapshot()");
  const active = current.workspace.activeNote;
  assert(active?.path === "Notes/Source.md", "The source note was not active for embed insertion.");
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
  await evaluate(
    pluginCdp,
    `(() => { const button = [...document.querySelectorAll('button.excalidraw-export-button')].find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(label)}); if (!(button instanceof HTMLButtonElement) || button.disabled) throw new Error(${JSON.stringify(`${label} export button is unavailable.`)}); button.click(); return true; })()`,
  );
}

async function completeVaultExport(relativePath, label) {
  await evaluate(cdp, "window.threadleaf.waitForPluginMutations()");
  const absolute = path.join(vaultPath, relativePath);
  let bytes;
  try {
    bytes = await fs.readFile(absolute);
  } catch (error) {
    throw new Error(
      `${label} mutation completion returned without creating ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assert(bytes.length > 0, `${label} created an empty ${relativePath}.`);
  return bytes;
}

async function exportPublicFixtures() {
  const drawingPath = "Drawings/Unicode Scene.excalidraw.md";
  await evaluate(cdp, `window.threadleaf.runCommand("obsidian-excalidraw-plugin:export-image")`);
  await waitFor(
    pluginCdp,
    "document.body?.textContent?.includes('Export Drawing')",
    "Excalidraw export dialog",
  );
  await clickExportButton("PNG to Vault");
  const png = await completeVaultExport("Drawings/Unicode Scene.excalidraw.png", "PNG export");
  assert(
    png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    "Plugin PNG export signature is invalid.",
  );

  await evaluate(cdp, `window.threadleaf.runCommand("obsidian-excalidraw-plugin:export-image")`);
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
  return {
    png: { path: "Drawings/Unicode Scene.excalidraw.png", sha256: sha256(png) },
    svg: { path: "Drawings/Unicode Scene.excalidraw.svg", sha256: sha256(svg) },
    source: drawingPath,
  };
}

async function unloadPlugin() {
  await evaluate(cdp, `window.threadleaf.unloadPlugin(${JSON.stringify(pluginId)})`);
  await waitFor(
    cdp,
    `(async () => { const s = await window.threadleaf.getSnapshot(); return !(s.plugins ?? []).some((p) => p.id === ${JSON.stringify(pluginId)} && p.state === 'loaded'); })()`,
    "Excalidraw unload",
  );
}

async function reloadPlugin(vaultId) {
  await evaluate(cdp, `window.threadleaf.reloadPlugin(${JSON.stringify(pluginId)})`);
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
  await unloadPlugin();
  await reloadPlugin(vaultId);
}

async function reloadWithCompression(vaultId, compress) {
  await unloadPlugin();
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
  assert(
    chrome.popoutLabel ===
      (popoutState === "open" ? "Reattach plugin view" : "Pop out plugin view"),
    `Plugin pop-out toolbar action has the wrong ownership state: ${JSON.stringify(chrome)}`,
  );
  return chrome;
}

async function exerciseSettingsWhileDrawing(vaultId, filePath) {
  const sourcePath = path.join(vaultPath, filePath);
  const sourceBefore = await fs.readFile(sourcePath);
  await assertDrawingChrome(filePath);
  const canvasBefore = await evaluate(
    pluginCdp,
    `(() => {
      const surface = document.querySelector('.excalidraw');
      const canvas = document.querySelector('canvas');
      return {
        surface: surface instanceof HTMLElement && surface.getBoundingClientRect().width > 0,
        canvas: canvas instanceof HTMLCanvasElement && canvas.getBoundingClientRect().width > 0,
      };
    })()`,
  );
  assert(
    canvasBefore.surface && canvasBefore.canvas,
    "Excalidraw did not own a visible canvas before settings.",
  );

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
      return snapshot.workspace?.activeNote?.path === ${JSON.stringify(filePath)} &&
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
  const pluginSettingsResponseMs = await measureResponse(pluginCdp, "Excalidraw settings renderer");
  const pluginSettingsShots = [
    await capture(pluginCdp, "excalidraw-plugin-settings", "dark"),
    await capture(pluginCdp, "excalidraw-plugin-settings", "light"),
  ];
  assert(
    pluginSettingsShots[0].digest !== pluginSettingsShots[1].digest,
    "Excalidraw settings theme screenshots are identical.",
  );
  await clickSelector(cdp, "#plugin-view");
  await waitFor(
    cdp,
    `(async () => {
      const snapshot = await window.threadleaf.getSnapshot();
      return snapshot.pluginSurface === null &&
        snapshot.workspace?.activeNote?.path === ${JSON.stringify(filePath)}
        ? snapshot
        : null;
    })()`,
    "Excalidraw plugin-owned settings close",
  );
  await pressKey(cdp, "Escape", "Escape");
  await waitFor(
    cdp,
    "document.querySelector('#shortcut-settings')?.open !== true",
    "settings dialog close",
  );
  const sourceAfter = await fs.readFile(sourcePath);
  assert(
    sha256(sourceAfter) === sha256(sourceBefore),
    "Opening and closing settings changed Excalidraw source bytes.",
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
    "Excalidraw view reopen after settings",
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
  await assertDrawingChrome(filePath);
  return { responseMs, recoveredSurfaceResponseMs };
}

async function exercisePluginRendererCrash(vaultId, filePath, port) {
  let crashCommandError = null;
  try {
    await pluginCdp.send("Page.crash", {}, 3_000);
  } catch (error) {
    crashCommandError = error instanceof Error ? error.message : String(error);
    if (/wasn.t found|method.*not found|unknown command/iu.test(crashCommandError)) {
      return { induced: false, reason: `CDP Page.crash is unavailable: ${crashCommandError}` };
    }
  }
  pluginCdp.close();
  pluginCdp = null;
  const recoveryAttempt = await evaluate(
    cdp,
    `window.threadleaf.reloadPlugin(${JSON.stringify(pluginId)})`,
  );
  const recoveryAttemptPlugin = recoveryAttempt?.plugins?.find((plugin) => plugin.id === pluginId);
  output.push(
    `plugin renderer recovery attempt: ${JSON.stringify({
      state: recoveryAttemptPlugin?.state ?? null,
      surface: recoveryAttempt.pluginSurface?.viewType ?? null,
      notice: recoveryAttempt.notices?.at(-1) ?? null,
    })}\n`,
  );
  if (recoveryAttemptPlugin?.state !== "failed") {
    const reloaded = await evaluate(
      cdp,
      `window.threadleaf.reloadPlugin(${JSON.stringify(pluginId)})`,
    );
    output.push(
      `plugin renderer reload after inconclusive crash: ${JSON.stringify({
        state: reloaded?.plugins?.find((plugin) => plugin.id === pluginId)?.state ?? null,
        surface: reloaded?.pluginSurface?.viewType ?? null,
      })}\n`,
    );
    await openDrawing(filePath, vaultId);
    await connectPluginSurface(port);
    return {
      induced: false,
      reason: "CDP Page.crash did not expose a failed compatibility-plugin state safely.",
      observedState: recoveryAttemptPlugin?.state ?? null,
    };
  }
  const recovered = await waitFor(
    cdp,
    `(async () => {
      const snapshot = await window.threadleaf.getSnapshot();
      const plugin = snapshot.plugins?.find((candidate) => candidate.id === ${JSON.stringify(pluginId)});
      return snapshot.workspace?.state === 'ready' &&
        snapshot.pluginSurface === null &&
        plugin?.state === 'failed'
        ? snapshot
        : null;
    })()`,
    "Excalidraw compatibility renderer crash recovery",
    5_000,
  );
  assert(
    recovered.notices?.at(-1)?.includes("compatibility renderer recovered"),
    `Excalidraw renderer crash did not expose a recovery notice: ${JSON.stringify(recovered.notices)}`,
  );
  const responseMs = await measureResponse(cdp, "main renderer after Excalidraw renderer crash");
  await capture(cdp, "excalidraw-plugin-crash-recovered-main", "dark");
  await evaluate(cdp, `window.threadleaf.reloadPlugin(${JSON.stringify(pluginId)})`);
  await waitFor(
    cdp,
    `(async () => (await window.threadleaf.getSnapshot()).plugins?.some((plugin) => plugin.id === ${JSON.stringify(pluginId)} && plugin.state === 'loaded'))()`,
    "Excalidraw reload after renderer crash",
    60_000,
  );
  await openDrawing(filePath, vaultId);
  await connectPluginSurface(port);
  return { induced: true, responseMs, crashCommandError };
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
  const port = await availablePort();
  const first = await startApp(port, pluginState);
  const targetPort = port;
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
    "(() => { const target = document.querySelector('canvas'); if (!(target instanceof HTMLCanvasElement)) throw new Error('visual positive-control canvas missing'); target.dataset.visualPositiveControl='true'; target.style.outline='8px solid rgb(255,0,255)'; target.style.outlineOffset='-8px'; return true; })()",
  );
  const positiveAfter = await capture(pluginCdp, "excalidraw-positive-after", "dark");
  assert(
    positiveBefore.digest !== positiveAfter.digest,
    "Screenshot positive control did not change captured pixels.",
  );
  await evaluate(
    pluginCdp,
    "(() => { const target = document.querySelector('[data-visual-positive-control]'); target?.style.removeProperty('outline'); target?.style.removeProperty('outline-offset'); target?.removeAttribute('data-visual-positive-control'); return true; })()",
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
  await drawEditGesture();
  await directSceneEdit(first.vaultId, filePath);
  await createAndEmbed(first.vaultId);
  const exports = await exportPublicFixtures();
  await openDrawing(filePath, first.vaultId);
  await connectPluginSurface(port);
  const settings = await exerciseSettingsWhileDrawing(first.vaultId, filePath);
  const popout = await exercisePopout(port, filePath);
  const popoutCrash = await exercisePopoutCrash(port, filePath);
  const pluginCrash = await exercisePluginRendererCrash(first.vaultId, filePath, port);
  if (!pluginCrash.induced) {
    console.error(`Excalidraw plugin renderer crash was not inducible: ${pluginCrash.reason}`);
    await assertDrawingChrome(filePath);
  }

  await clickSelector(cdp, "#pop-out-plugin-view");
  await waitFor(
    cdp,
    "(async () => (await window.threadleaf.getSnapshot()).workspaceLayout?.popout.state === 'open')()",
    "Excalidraw pop-out before vault switch",
  );
  const firstSourceBeforeSwitch = sha256(await fs.readFile(path.join(vaultPath, filePath)));
  await fs.unlink(pickerLink);
  await fs.symlink(secondVaultPath, pickerLink);
  await clickSelector(cdp, "#open-vault");
  const switched = await waitFor(
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

  const restartSource = sha256(await fs.readFile(path.join(vaultPath, filePath)));
  await openDrawing(nativePath, returned.vault.id, { viaNavigator: true });
  await connectPluginSurface(port);
  const nativeRestartSource = sha256(await fs.readFile(path.join(vaultPath, nativePath)));
  await closeApp();

  const restartPort = await availablePort();
  const restarted = await startApp(restartPort, pluginState);
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
    after.result[filePath]?.sha256 === restartSource,
    "Restart changed the persisted Excalidraw source bytes.",
  );
  await measureResponse(cdp, "main renderer after Excalidraw restart");
  await measureResponse(pluginCdp, "Excalidraw renderer after restart");
  console.log(
    JSON.stringify(
      {
        status: "passed",
        plugin: {
          id: pluginId,
          version: pluginVersion,
          source: pluginState.source,
          manifestSha256: pluginState.manifestSha256,
          mainSha256: pluginState.mainSha256,
          mainBytes: pluginState.mainBytes,
          stylesSha256: pluginState.stylesSha256,
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
          "popout-detach-reattach",
          "popout-crash-degraded-recovery",
          ...(pluginCrash.induced ? ["plugin-renderer-crash-degraded-recovery"] : []),
          "vault-switch-popout-cleanup",
          "unload-reload",
          "native-scene-restart-recovery",
          "restart",
          "source-byte-and-attachment-manifest",
        ],
        screenshots,
        exports,
        responsivenessMs: {
          settingsMain: settings.settingsResponseMs,
          settingsPlugin: settings.pluginSettingsResponseMs,
          detachedMain: popout.mainResponseMs,
          detachedPlugin: popout.detachedResponseMs,
          popoutCrashMain: popoutCrash.responseMs,
          popoutCrashPlugin: popoutCrash.recoveredSurfaceResponseMs,
          ...(pluginCrash.induced ? { pluginCrashMain: pluginCrash.responseMs } : {}),
        },
        popoutSizes: {
          attached: popout.attachedSize,
          detached: popout.detachedSize,
          reattached: popout.reattachedSize,
        },
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
    await fs.rm(testRoot, { recursive: true, force: true });
  }
}
