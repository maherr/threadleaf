import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const appRoot = process.cwd();
const electronPath = path.join(appRoot, "node_modules", ".bin", "electron");
const sourcePluginPath = process.env.THREADLEAF_URL_SELECTION_PLUGIN_DIR;
const screenshotDirectory = process.env.THREADLEAF_URL_SELECTION_SCREENSHOT_DIR;
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-url-selection-"));
const vaultPath = path.join(testRoot, "vault");
const userDataPath = path.join(testRoot, "user-data");
const pluginPath = path.join(vaultPath, ".obsidian", "plugins", "url-into-selection");
const output = [];
let child;
let cdp;
let exited;

const officialAssets = [
  {
    name: "manifest.json",
    url: "https://github.com/denolehov/obsidian-url-into-selection/releases/download/1.11.4/manifest.json",
    sha256: "6573c0ef277b0eb366e19acd558445a46473a5fccf0b7e80b9e07dc95f8b0443",
  },
  {
    name: "main.js",
    url: "https://github.com/denolehov/obsidian-url-into-selection/releases/download/1.11.4/main.js",
    sha256: "377883d2fc2a1feeb96be868f7110782874206cb3065635281e89fdfdc6e6d77",
  },
];

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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

async function waitForMainTarget(port) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const main = targets.find(
          (target) =>
            target.type === "page" &&
            typeof target.url === "string" &&
            target.url.endsWith("/dist/renderer/index-trusted.html"),
        );
        if (main?.webSocketDebuggerUrl) return main;
      }
    } catch {
      // The debugging endpoint is not ready yet.
    }
    await delay(100);
  }
  throw new Error("Threadleaf did not expose its trusted renderer within 10 seconds.");
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

async function waitFor(probe, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await delay(50);
  }
  throw new Error(`${message}: ${JSON.stringify(last)}`);
}

async function stagePluginPackage() {
  await fs.mkdir(pluginPath, { recursive: true });
  if (sourcePluginPath) {
    for (const name of ["manifest.json", "main.js", "data.json"]) {
      const source = path.join(sourcePluginPath, name);
      const bytes = await fs.readFile(source).catch(() => null);
      if (bytes) await fs.writeFile(path.join(pluginPath, name), bytes);
    }
  } else {
    for (const asset of officialAssets) {
      const response = await fetch(asset.url, { redirect: "follow" });
      assert(response.ok, `Could not fetch official ${asset.name}: HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert(
        sha256(bytes) === asset.sha256,
        `Official ${asset.name} did not match the pinned SHA-256.`,
      );
      await fs.writeFile(path.join(pluginPath, asset.name), bytes);
    }
  }
  const manifest = JSON.parse(await fs.readFile(path.join(pluginPath, "manifest.json"), "utf8"));
  assert(manifest.id === "url-into-selection", "The staged package has the wrong plugin ID.");
  assert(manifest.version === "1.11.4", "The staged package has the wrong plugin version.");
  return sha256(await fs.readFile(path.join(pluginPath, "main.js")));
}

async function focusAndSelectAllEditor() {
  await evaluate(`(() => {
    const editor = document.querySelector('[data-pane-id="primary"] .cm-content');
    if (!(editor instanceof HTMLElement)) return false;
    editor.focus();
    return document.activeElement === editor;
  })()`);
  for (const type of ["keyDown", "keyUp"]) {
    await cdp.send("Input.dispatchKeyEvent", {
      type,
      key: "a",
      code: "KeyA",
      modifiers: 2,
      windowsVirtualKeyCode: 65,
    });
  }
}

async function dispatchTextPaste(text) {
  return evaluate(`(() => {
    const editor = document.querySelector('[data-pane-id="primary"] .cm-content');
    if (!(editor instanceof HTMLElement)) return { dispatched: false, reason: "missing" };
    const transfer = new DataTransfer();
    transfer.setData("text/plain", ${JSON.stringify(text)});
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    });
    const dispatchResult = editor.dispatchEvent(event);
    return {
      defaultPrevented: event.defaultPrevented,
      dispatched: true,
      dispatchResult,
      focused: document.activeElement === editor,
    };
  })()`);
}

async function editorText() {
  return evaluate(`[
    ...document.querySelectorAll('[data-pane-id="primary"] .cm-content .cm-line')
  ].map((line) => line.textContent ?? "").join("\\n")`);
}

try {
  if (process.platform !== "linux") {
    throw new Error("The URL selection paste check currently requires Linux and Xvfb.");
  }
  await fs.access(electronPath);
  const bundleSha256 = await stagePluginPackage();
  await fs.mkdir(userDataPath, { recursive: true });
  await fs.writeFile(path.join(vaultPath, "Welcome.md"), "Threadleaf", "utf8");
  const canonicalVaultPath = await fs.realpath(vaultPath);
  const vaultId = sha256(Buffer.from(canonicalVaultPath));
  await fs.writeFile(
    path.join(userDataPath, "settings.json"),
    `${JSON.stringify(
      {
        version: 4,
        keyBindings: {},
        appearanceByVault: {
          [vaultId]: { colorScheme: "dark", themeId: null, enabledSnippetIds: [] },
        },
        pluginsByVault: {
          [vaultId]: {
            compatibilityMode: "enabled",
            compatibilityTopology: "trusted-workspace",
            enabledPluginIds: ["url-into-selection"],
            capabilityGrantsByPlugin: {},
          },
        },
        noteWorkflowsByVault: {},
        workspaceByVault: {
          [vaultId]: {
            defaultNoteFolder: "",
            attachmentFolder: "",
            linkStyle: "preserve",
            automaticLinkUpdates: "ask",
            confirmDelete: "always",
            newTabBehavior: "focus",
            editorMode: "source",
            documentView: "source",
            showInlineTitle: true,
            readableLineLength: true,
            showLineNumbers: false,
            spellcheck: true,
            tabSize: 2,
            showStatusBar: true,
            restorePolicy: "fresh",
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  const port = await availablePort();
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
        THREADLEAF_PLUGIN_E2E_DIAGNOSTICS: "1",
        THREADLEAF_VAULT_PATH: canonicalVaultPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      output.push(String(chunk));
      if (output.length > 100) output.shift();
    });
  }
  const target = await waitForMainTarget(port);
  cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1180,
    height: 820,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const catalog = await waitFor(
    async () => {
      const state = await evaluate(`window.threadleaf.getSnapshot().then(async (snapshot) => ({
        snapshot,
        catalog: await window.threadleaf.getPlugins(snapshot.vault?.id),
      }))`);
      const plugin = state?.catalog?.catalog?.plugins?.find(
        ({ id }) => id === "url-into-selection",
      );
      return !state?.snapshot?.startup &&
        state?.snapshot?.workspace?.state === "ready" &&
        plugin?.packageState === "ready"
        ? { plugin, vaultId: state.snapshot.vault.id }
        : null;
    },
    "The exact URL selection package did not appear in the ready vault catalog",
    15_000,
  );
  assert(
    catalog.plugin.capabilityReport?.bundleSha256 === bundleSha256,
    "The discovered package did not retain the staged main bundle identity.",
  );
  await evaluate(
    `window.threadleaf.setPluginCapabilityGrant(${JSON.stringify(catalog.vaultId)}, "url-into-selection", ${JSON.stringify(bundleSha256)}, true)`,
  );
  await waitFor(
    () =>
      evaluate(`window.threadleaf.getSnapshot().then((snapshot) => ({
        loaded: snapshot.plugins?.some((plugin) =>
          plugin.id === "url-into-selection" &&
          plugin.state === "loaded" &&
          plugin.compatibilityLevel === 3
        ),
        pasteRegistered: snapshot.integrations?.workspaceEvents?.includes("editor-paste") === true,
      }))`).then((state) => state.loaded && state.pasteRegistered),
    "The exact plugin did not load and register editor-paste",
    20_000,
  );

  await focusAndSelectAllEditor();
  const urlPaste = await dispatchTextPaste("https://example.test/path");
  assert(
    urlPaste.dispatched && urlPaste.focused && urlPaste.defaultPrevented,
    `The URL paste did not enter the compatibility path: ${JSON.stringify(urlPaste)}`,
  );
  await waitFor(
    async () => (await editorText()) === "[Threadleaf](https://example.test/path)",
    "The exact plugin did not wrap selected text with the pasted URL",
  );

  for (const type of ["keyDown", "keyUp"]) {
    await cdp.send("Input.dispatchKeyEvent", {
      type,
      key: "z",
      code: "KeyZ",
      modifiers: 2,
      windowsVirtualKeyCode: 90,
    });
  }
  await waitFor(async () => (await editorText()) === "Threadleaf", "Undo did not reset the editor");
  await focusAndSelectAllEditor();
  const ordinaryPaste = await dispatchTextPaste("ordinary text");
  assert(
    ordinaryPaste.dispatched && ordinaryPaste.focused && ordinaryPaste.defaultPrevented,
    `The ordinary paste did not enter the compatibility fallback: ${JSON.stringify(ordinaryPaste)}`,
  );
  await waitFor(
    async () => (await editorText()) === "ordinary text",
    "An unhandled paste was swallowed instead of falling back to ordinary text",
  );
  const ordinaryState = await evaluate(`window.threadleaf.getSnapshot().then((snapshot) => ({
    errors: snapshot.events.filter((event) => event.kind === "error").slice(-5),
    toast: document.querySelector("#toast")?.textContent ?? "",
  }))`);
  assert(
    !ordinaryState.toast.includes("failed") && ordinaryState.errors.length === 0,
    `The ordinary fallback exposed a compatibility failure: ${JSON.stringify(ordinaryState)}`,
  );

  if (screenshotDirectory) {
    await fs.mkdir(screenshotDirectory, { recursive: true });
    const screenshot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
    });
    await fs.writeFile(
      path.join(screenshotDirectory, "url-selection-paste-final.png"),
      Buffer.from(screenshot.data, "base64"),
    );
  }
  console.log(
    JSON.stringify({
      verified: true,
      pluginId: "url-into-selection",
      version: "1.11.4",
      bundleSha256,
      source: sourcePluginPath ? "operator-package" : "official-release",
      workflows: {
        selectedUrlPaste: "[Threadleaf](https://example.test/path)",
        ordinaryPasteFallback: "ordinary text",
      },
    }),
  );
} catch (error) {
  console.error(output.join(""));
  throw error;
} finally {
  if (cdp && child && exited) {
    await evaluate("setTimeout(function(){ window.close(); }, 100); true").catch(() => undefined);
    await Promise.race([exited, delay(5_000)]);
    if (child.exitCode === null) child.kill("SIGTERM");
    cdp.close();
  }
  await fs.rm(testRoot, { recursive: true, force: true }).catch(() => undefined);
}
