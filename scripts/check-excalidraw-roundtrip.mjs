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
const pluginId = "obsidian-excalidraw-plugin";
const pluginVersion = "2.25.3";
const repository = "zsviczian/obsidian-excalidraw-plugin";
const electronPath = path.join(appRoot, "node_modules", ".bin", "electron");
const screenshotDirectoryOverride = process.env.THREADLEAF_EXCALIDRAW_SCREENSHOT_DIR;
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-excalidraw-e2e-"));
const vaultPath = path.join(testRoot, "vault");
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

async function fetchPublicPlugin() {
  const supplied = process.env.THREADLEAF_EXCALIDRAW_PLUGIN_PATH?.trim();
  if (supplied) {
    const base = path.resolve(supplied);
    const manifest = await fs.readFile(path.join(base, "manifest.json"), "utf8");
    const main = await fs.readFile(path.join(base, "main.js"));
    const styles = (await exists(path.join(base, "styles.css")))
      ? await fs.readFile(path.join(base, "styles.css"))
      : null;
    return { manifest: JSON.parse(manifest), main, styles, source: `local:${base}` };
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
    main,
    styles,
    source: `${releaseRoot}/manifest.json,main.js,styles.css`,
  };
}

async function writePluginFixture() {
  const plugin = await fetchPublicPlugin();
  assert(plugin.manifest.id === pluginId, `Expected ${pluginId}, got ${plugin.manifest.id}.`);
  assert(
    plugin.manifest.version === pluginVersion,
    `Expected Excalidraw ${pluginVersion}, got ${plugin.manifest.version}.`,
  );
  await fs.mkdir(pluginPath, { recursive: true });
  await fs.writeFile(
    path.join(pluginPath, "manifest.json"),
    JSON.stringify(plugin.manifest, null, 2),
  );
  await fs.writeFile(path.join(pluginPath, "main.js"), plugin.main);
  if (plugin.styles) await fs.writeFile(path.join(pluginPath, "styles.css"), plugin.styles);
  await fs.writeFile(
    path.join(pluginPath, "data.json"),
    JSON.stringify({
      compress: false,
      matchTheme: true,
      matchThemeAlways: true,
      matchThemeTrigger: true,
      onceOffCompressFlagReset: true,
      onceOffGPTVersionReset: true,
      previousRelease: pluginVersion,
      showReleaseNotes: false,
    }),
  );
  return { ...plugin, mainSha256: sha256(plugin.main) };
}

async function canonicalManifest() {
  const manifest = JSON.parse(await fs.readFile(path.join(fixtureRoot, "manifest.json"), "utf8"));
  const result = {};
  for (const entry of manifest.files) {
    const bytes = await fs.readFile(path.join(vaultPath, entry.path));
    result[entry.path] = { size: bytes.length, sha256: sha256(bytes) };
  }
  return { manifest, result };
}

function sceneEdit(content) {
  const opening = "```json\n";
  const start = content.indexOf(opening);
  const end = content.indexOf("\n```", start + opening.length);
  assert(start >= 0 && end > start, "The uncompressed Excalidraw fixture fence is missing.");
  const scene = JSON.parse(content.slice(start + opening.length, end));
  const text = scene.elements?.find((element) => element.id === "text-title");
  assert(text, "The deterministic Excalidraw text element is missing.");
  text.text = "Ébauche dessinée";
  text.originalText = "Ébauche dessinée";
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
  return `${content.slice(0, start + opening.length)}${payload}${content.slice(end + 1)}`;
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
  await fs.writeFile(
    path.join(userDataPath, "settings.json"),
    `${JSON.stringify(settings, null, 2)}\n`,
  );
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

async function openDrawing(filePath, vaultId) {
  await evaluate(cdp, `window.threadleaf.openNote(${JSON.stringify(filePath)})`);
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
  await evaluate(
    cdp,
    `(() => { const button = document.querySelector('#plugin-view'); if (!(button instanceof HTMLButtonElement)) throw new Error('Excalidraw control is unavailable.'); button.click(); return true; })()`,
  );
  await waitFor(
    cdp,
    `(async () => { const s = await window.threadleaf.getSnapshot(); const host = document.querySelector('#plugin-surface-host'); const button = document.querySelector('#plugin-view'); return s.pluginSurface?.viewType === 'excalidraw' && s.pluginSurface?.filePath === ${JSON.stringify(filePath)} && host instanceof HTMLElement && !host.hidden && button?.getAttribute('aria-pressed') === 'true'; })()`,
    `Excalidraw view ${filePath}`,
    20_000,
  );
  return vaultId;
}

async function connectPluginSurface(port) {
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

async function waitForVaultFile(relativePath, label) {
  const absolute = path.join(vaultPath, relativePath);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const bytes = await fs.readFile(absolute);
      if (bytes.length > 0) return bytes;
    } catch {
      // The plugin export is still writing through the compatibility vault.
    }
    await delay(80);
  }
  throw new Error(`${label} did not create ${relativePath}.`);
}

async function exportPublicFixtures() {
  const drawingPath = "Drawings/Unicode Scene.excalidraw.md";
  await evaluate(cdp, `window.threadleaf.runCommand("export-image")`);
  await waitFor(
    pluginCdp,
    "document.body?.textContent?.includes('Export Drawing')",
    "Excalidraw export dialog",
  );
  await clickExportButton("PNG to Vault");
  const png = await waitForVaultFile("Drawings/Unicode Scene.excalidraw.png", "PNG export");
  assert(
    png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    "Plugin PNG export signature is invalid.",
  );

  await evaluate(cdp, `window.threadleaf.runCommand("export-image")`);
  await waitFor(
    pluginCdp,
    "document.body?.textContent?.includes('Export Drawing')",
    "second Excalidraw export dialog",
  );
  await clickExportButton("SVG to Vault");
  const svg = await waitForVaultFile("Drawings/Unicode Scene.excalidraw.svg", "SVG export");
  const svgText = svg.toString("utf8");
  assert(/^<svg[\s>]/u.test(svgText.trim()), "Plugin SVG export is not XML-shaped.");
  assert(svgText.includes("<svg"), "Plugin SVG export has no SVG root.");
  return {
    png: { path: "Drawings/Unicode Scene.excalidraw.png", sha256: sha256(png) },
    svg: { path: "Drawings/Unicode Scene.excalidraw.svg", sha256: sha256(svg) },
    source: drawingPath,
  };
}

async function unloadReload(vaultId) {
  await evaluate(cdp, `window.threadleaf.unloadPlugin(${JSON.stringify(pluginId)})`);
  await waitFor(
    cdp,
    `(async () => { const s = await window.threadleaf.getSnapshot(); return !(s.plugins ?? []).some((p) => p.id === ${JSON.stringify(pluginId)} && p.state === 'loaded'); })()`,
    "Excalidraw unload",
  );
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

async function run() {
  if (process.platform !== "linux")
    throw new Error("The packaged Excalidraw workflow currently requires Linux and Xvfb.");
  assert(await exists(electronPath), "Electron is not installed; packaged workflow is unverified.");
  await fs.cp(fixtureVault, vaultPath, { recursive: true });
  await fs.mkdir(userDataPath, { recursive: true });
  const before = await canonicalManifest();
  const pluginState = await writePluginFixture();
  const port = await availablePort();
  const first = await startApp(port, pluginState);
  const targetPort = port;
  await openDrawing("Drawings/Unicode Scene.excalidraw.md", first.vaultId);
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
  await drawEditGesture();
  await directSceneEdit(first.vaultId, "Drawings/Unicode Scene.excalidraw.md");
  await createAndEmbed(first.vaultId);
  const exports = await exportPublicFixtures();
  await unloadReload(first.vaultId);
  await closeApp();

  const restartPort = await availablePort();
  const restarted = await startApp(restartPort, pluginState);
  await openDrawing("Drawings/Created.excalidraw.md", restarted.vaultId);
  await connectPluginSurface(restartPort);
  await capture(pluginCdp, "excalidraw-restart", "dark");
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
  console.log(
    JSON.stringify(
      {
        status: "passed",
        plugin: {
          id: pluginId,
          version: pluginVersion,
          source: pluginState.source,
          mainSha256: pluginState.mainSha256,
        },
        workflows: [
          "create",
          "draw-edit",
          "embed",
          "svg-png-export",
          "note-switch",
          "unload-reload",
          "restart",
          "source-byte-and-attachment-manifest",
        ],
        screenshots,
        exports,
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
  await fs.rm(testRoot, { recursive: true, force: true });
}
