import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const appRoot = process.cwd();
const electronPath = path.join(appRoot, "node_modules", ".bin", "electron");
const fixtureVault = path.join(appRoot, "fixtures", "vaults", "basic");
const fixturePackages = path.join(appRoot, "fixtures", "plugin-packages");
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-trusted-workspace-"));
const vaultPath = path.join(testRoot, "vault-one");
const secondVaultPath = path.join(testRoot, "vault-two");
const pickerLink = path.join(testRoot, "picker-target");
const userDataPath = path.join(testRoot, "user-data");
const screenshotDirectory = process.env.THREADLEAF_TRUSTED_WORKSPACE_SCREENSHOT_DIR;
const processMarker = randomUUID();
const output = [];
const pluginDefinitions = [
  {
    id: "threadleaf-trusted-state-fixture",
    capabilities: ["editor-extension"],
  },
  {
    id: "threadleaf-trusted-view-fixture",
    capabilities: ["editor-extension"],
  },
  {
    id: "inspection-safe",
    capabilities: ["workspace-ui"],
  },
];

let child;
let exited;
let cdp;
let mainTarget;
let port;
let phase = "setup";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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
    throw new Error("Could not reserve the trusted-workspace CDP port.");
  }
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function markedProcessIds() {
  const marker = Buffer.from(`THREADLEAF_TRUSTED_WORKSPACE_RUN=${processMarker}\0`);
  const entries = await fs.readdir("/proc");
  const matches = [];
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const environment = await fs.readFile(`/proc/${entry}/environ`);
      if (environment.includes(marker)) matches.push(Number(entry));
    } catch {
      // A process can exit between enumeration and environment capture.
    }
  }
  return matches;
}

async function terminateMarkedProcesses() {
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const pids = await markedProcessIds();
      if (pids.length === 0) return;
      for (const pid of pids) {
        try {
          process.kill(pid, signal);
        } catch {
          // The process exited between enumeration and the signal.
        }
      }
      await delay(100);
    }
  }
  const remaining = await markedProcessIds();
  assert(
    remaining.length === 0,
    `Could not stop trusted-workspace processes: ${remaining.join(", ")}`,
  );
}

async function targets() {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  assert(response.ok, `CDP target list returned HTTP ${response.status}.`);
  return response.json();
}

function isMainTarget(target) {
  return (
    target?.type === "page" &&
    typeof target.url === "string" &&
    (target.url.endsWith("/dist/renderer/index.html") ||
      target.url.endsWith("/dist/renderer/index-trusted.html")) &&
    typeof target.webSocketDebuggerUrl === "string"
  );
}

async function waitForMainTarget(previousWebSocketUrl = null, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastTargets = [];
  while (Date.now() < deadline) {
    try {
      lastTargets = await targets();
      const candidate = lastTargets.find(
        (target) => isMainTarget(target) && target.webSocketDebuggerUrl !== previousWebSocketUrl,
      );
      if (candidate) return candidate;
    } catch {
      // Electron is still replacing or starting its renderer.
    }
    await delay(50);
  }
  throw new Error(
    `Threadleaf did not expose a replacement main renderer. Targets: ${JSON.stringify(lastTargets)}`,
  );
}

function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let sequence = 0;
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("Trusted-workspace CDP open failed.")),
      {
        once: true,
      },
    );
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
    for (const request of pending.values()) request.reject(new Error("renderer-dead"));
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

async function bindMainTarget(target) {
  mainTarget = target;
  cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
}

async function evaluate(expression) {
  assert(cdp, "The main renderer CDP connection is unavailable.");
  const response = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ??
        "Trusted-workspace renderer evaluation failed.",
    );
  }
  return response.result?.value;
}

async function waitFor(probe, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await probe();
      if (last) return last;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await delay(50);
  }
  throw new Error(`${message}. Last observation: ${JSON.stringify(last)}`);
}

async function snapshot() {
  return evaluate("window.threadleaf.getSnapshot()");
}

async function waitForReady(expectedPath = vaultPath, expectedPluginIds = []) {
  return waitFor(async () => {
    const current = await snapshot();
    const loaded = expectedPluginIds.every((pluginId) =>
      current?.plugins?.some((plugin) => plugin.id === pluginId && plugin.state === "loaded"),
    );
    return current?.workspace?.state === "ready" && current?.vault?.path === expectedPath && loaded
      ? current
      : null;
  }, `Vault did not become ready with the expected plugin state: ${expectedPath}`);
}

async function captureTree(rootPath) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const files = new Map();
    const visit = async (directory, relative = "") => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const nextRelative = relative ? path.join(relative, entry.name) : entry.name;
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(fullPath, nextRelative);
        } else if (entry.isFile()) {
          const bytes = await fs.readFile(fullPath);
          files.set(nextRelative.split(path.sep).join("/"), {
            bytes: bytes.byteLength,
            sha256: sha256(bytes),
          });
        }
      }
    };
    try {
      await visit(rootPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await delay(25);
      continue;
    }
    const transient = [...files.keys()].some((filePath) =>
      /(?:^|\/)\.threadleaf-(?:write|rollback|claim)-[^/]+\.tmp$/iu.test(filePath),
    );
    if (transient) {
      await delay(25);
      continue;
    }
    return Object.fromEntries(
      [...files.entries()].sort(([left], [right]) => left.localeCompare(right)),
    );
  }
  throw new Error(`Vault tree did not settle while capturing ${rootPath}.`);
}

async function pluginHashes() {
  const hashes = {};
  for (const definition of pluginDefinitions) {
    const mainBytes = await fs.readFile(path.join(fixturePackages, definition.id, "main.js"));
    hashes[definition.id] = {
      bundleSha256: sha256(mainBytes),
      capabilities: definition.capabilities,
    };
  }
  const commandBytes = await fs.readFile(path.join(fixturePackages, "inspection-safe", "main.js"));
  hashes["inspection-safe"] = {
    bundleSha256: sha256(commandBytes),
    capabilities: ["workspace-ui"],
  };
  return hashes;
}

async function writeVaultSettings(topology, hashes, firstVaultId, secondVaultId) {
  const grants = Object.fromEntries(
    Object.entries(hashes).map(([pluginId, value]) => [pluginId, value]),
  );
  await fs.mkdir(userDataPath, { recursive: true });
  await fs.writeFile(
    path.join(userDataPath, "settings.json"),
    `${JSON.stringify(
      {
        version: 5,
        keyBindings: {},
        appearanceByVault: {},
        pluginsByVault: {
          [firstVaultId]: {
            compatibilityMode: "enabled",
            compatibilityTopology: topology,
            enabledPluginIds: Object.keys(hashes),
            capabilityGrantsByPlugin: grants,
          },
          [secondVaultId]: {
            compatibilityMode: "restricted",
            compatibilityTopology: "isolated",
            enabledPluginIds: [],
            capabilityGrantsByPlugin: {},
          },
        },
        noteWorkflowsByVault: {},
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

async function copyFixtureVaults() {
  await fs.cp(fixtureVault, vaultPath, { recursive: true });
  await fs.cp(fixtureVault, secondVaultPath, { recursive: true });
  for (const root of [vaultPath, secondVaultPath]) {
    const pluginsPath = path.join(root, ".obsidian", "plugins");
    await fs.rm(pluginsPath, { recursive: true, force: true });
    await fs.mkdir(pluginsPath, { recursive: true });
  }
  for (const pluginId of [
    "threadleaf-trusted-state-fixture",
    "threadleaf-trusted-view-fixture",
    "inspection-safe",
  ]) {
    await fs.cp(
      path.join(fixturePackages, pluginId),
      path.join(vaultPath, ".obsidian", "plugins", pluginId),
      { recursive: true },
    );
  }
  await fs.writeFile(path.join(secondVaultPath, "Second Vault.md"), "# Second vault\n", "utf8");
}

async function launchApplication(expectedTopology) {
  port = await availablePort();
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
        THREADLEAF_TEST_PICKER_PATH: pickerLink,
        THREADLEAF_TRUSTED_WORKSPACE_RUN: processMarker,
        THREADLEAF_TRUSTED_WORKSPACE_TEST: "1",
        THREADLEAF_WORKSPACE_SETTINGS_DELAY_MS: "10000",
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
      while (output.length > 160) output.shift();
    });
  }
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const initialTarget = await waitForMainTarget();
  await bindMainTarget(initialTarget);
  if (
    expectedTopology === "trusted-workspace" &&
    initialTarget.url.endsWith("/dist/renderer/index.html")
  ) {
    await bindMainTarget(await waitForMainTarget(initialTarget.webSocketDebuggerUrl));
  }
  await waitFor(async () => {
    const current = await snapshot();
    return current?.workspace?.state === "ready" ? current : null;
  }, "The trusted-workspace renderer did not become ready");
}

async function closeApplication() {
  if (!child) return;
  try {
    await evaluate("setTimeout(() => window.close(), 50); true");
  } catch {
    // Renderer replacement or crash already closed the CDP request.
  }
  cdp?.close();
  cdp = undefined;
  mainTarget = undefined;
  const result = exited
    ? await Promise.race([exited, delay(5_000).then(() => ({ code: null, signal: "timeout" }))])
    : { code: null, signal: "missing" };
  if (result.code !== 0) await terminateMarkedProcesses();
  child = undefined;
  exited = undefined;
}

async function makeTreeWritable(rootPath) {
  const visit = async (current) => {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(target);
        await fs.chmod(target, 0o700).catch(() => undefined);
      } else if (entry.isFile()) {
        await fs.chmod(target, 0o600).catch(() => undefined);
      }
    }
  };
  await visit(rootPath);
  await fs.chmod(rootPath, 0o700).catch(() => undefined);
}

async function removeTestRoot() {
  await makeTreeWritable(testRoot);
  await fs.rm(testRoot, { recursive: true, force: true });
}

async function reconnectAfterRendererReplacement(previousWebSocketUrl) {
  cdp?.close();
  cdp = undefined;
  const replacement = await waitForMainTarget(previousWebSocketUrl);
  await bindMainTarget(replacement);
  return replacement;
}

async function exposeCompatibilityProfileControl() {
  const exposed = await evaluate(`(() => {
    const dialog = document.querySelector('#shortcut-settings');
    const trigger = document.querySelector('#settings-trigger');
    const navigation = document.querySelector('#settings-nav-plugins');
    if (!(dialog instanceof HTMLDialogElement) || !(trigger instanceof HTMLElement) || !(navigation instanceof HTMLElement)) {
      return false;
    }
    if (!dialog.open) trigger.click();
    navigation.click();
    return true;
  })()`);
  assert(exposed === true, "The community-plugin settings page was not reachable.");
  return waitFor(
    async () =>
      evaluate(`(() => {
        const dialog = document.querySelector('#shortcut-settings');
        const page = document.querySelector('[data-settings-page="plugins"]');
        const select = document.querySelector('#plugin-compatibility-profile');
        return Boolean(dialog?.open && page && !page.hidden && select);
      })()`),
    "The community-plugin compatibility profile control did not become visible",
  );
}

async function chooseCompatibilityProfile(profile) {
  phase = `user-facing compatibility profile: ${profile}`;
  await exposeCompatibilityProfileControl();
  const previousWebSocketUrl = mainTarget?.webSocketDebuggerUrl ?? null;
  const changed = await evaluate(`(() => {
    const select = document.querySelector('#plugin-compatibility-profile');
    if (!(select instanceof HTMLSelectElement)) return false;
    select.value = ${JSON.stringify(profile)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  assert(changed === true, "The compatibility profile control was not reachable.");
  await reconnectAfterRendererReplacement(previousWebSocketUrl);
  await waitFor(
    async () =>
      (await evaluate("document.querySelector('#plugin-compatibility-profile')?.value ?? null")) ===
      profile,
    `The compatibility profile control did not settle on ${profile}`,
  );
}

async function pointPickerAt(expectedPath) {
  await fs.rm(pickerLink, { force: true });
  await fs.symlink(expectedPath, pickerLink);
}

async function chooseVault(expectedPath) {
  const previousWebSocketUrl = mainTarget?.webSocketDebuggerUrl ?? null;
  await pointPickerAt(expectedPath);
  let settled = false;
  const responsePromise = evaluate("window.threadleaf.chooseVault()")
    .then((value) => {
      settled = true;
      return value;
    })
    .catch((error) => {
      settled = true;
      return { status: "renderer-replaced", error: String(error) };
    });
  let replacement = null;
  const deadline = Date.now() + 15_000;
  while (!settled && Date.now() < deadline) {
    const candidates = await targets().catch(() => []);
    replacement = candidates.find(
      (target) => isMainTarget(target) && target.webSocketDebuggerUrl !== previousWebSocketUrl,
    );
    if (replacement) break;
    await delay(50);
  }
  const response = await responsePromise;
  if (replacement) {
    await reconnectAfterRendererReplacement(previousWebSocketUrl);
  } else if (response.status !== "opened") {
    throw new Error(`Vault switch failed: ${JSON.stringify(response)}`);
  }
  await waitFor(async () => {
    const current = await snapshot();
    return current?.vault?.path === expectedPath ? current : null;
  }, `Vault did not switch to ${expectedPath}`);
}

async function grantPlugins(vaultId, hashes) {
  for (const [pluginId, value] of Object.entries(hashes)) {
    const response = await evaluate(
      `window.threadleaf.setPluginCapabilityGrant(${JSON.stringify(vaultId)}, ${JSON.stringify(pluginId)}, ${JSON.stringify(value.bundleSha256)}, true)`,
    );
    assert(
      response?.status === "updated",
      `Authority grant failed for ${pluginId}: ${JSON.stringify(response)}`,
    );
  }
  const catalog = await evaluate(`window.threadleaf.getPlugins(${JSON.stringify(vaultId)})`);
  assert(
    catalog?.status === "ready",
    `Final plugin catalog was not ready: ${JSON.stringify(catalog)}`,
  );
  assert(
    !catalog.catalog.warnings.some((warning) =>
      warning.includes("exact bundle authority review is stale"),
    ),
    `Final plugin catalog retained a stale authority warning: ${JSON.stringify(catalog.catalog.warnings)}`,
  );
}

async function editorSurfaceCounts() {
  return evaluate(`(() => ({
    primaryState: document.querySelectorAll('[data-pane-id="primary"] .cm-editor.threadleaf-trusted-state-fixture').length,
    secondaryState: document.querySelectorAll('[data-pane-id="secondary"] .cm-editor.threadleaf-trusted-state-fixture').length,
    primaryView: document.querySelectorAll('[data-pane-id="primary"] .cm-editor.threadleaf-trusted-view-fixture').length,
    secondaryView: document.querySelectorAll('[data-pane-id="secondary"] .cm-editor.threadleaf-trusted-view-fixture').length,
    stateMarker: document.documentElement.dataset.threadleafTrustedStateFixture ?? null,
  }))()`);
}

async function assertTrustedRealm(vaultId) {
  phase = "trusted shared realm and CodeMirror identity";
  const gate = await waitFor(
    async () => evaluate("window.__threadleafTrustedGate ?? null"),
    "Trusted plugins did not execute in the main renderer realm",
  );
  assert(gate.state?.realm?.globalIsWindow === true, "State plugin globalThis is not window.");
  assert(
    gate.state?.realm?.documentIsWindowDocument === true,
    "State plugin document is not the main window document.",
  );
  assert(gate.view?.realm?.globalIsWindow === true, "View plugin globalThis is not window.");
  assert(
    gate.view?.realm?.documentIsWindowDocument === true,
    "View plugin document is not the main window document.",
  );
  for (const [name, value] of Object.entries({
    stateNamespaceIsHostTable: gate.state?.realm?.namespaceIsHostTable,
    stateEditorStateIsHostTable: gate.state?.realm?.editorStateIsHostTable,
    stateFieldIsHostTable: gate.state?.realm?.stateFieldIsHostTable,
    viewNamespaceIsHostTable: gate.view?.realm?.namespaceIsHostTable,
    viewEditorViewIsHostTable: gate.view?.realm?.editorViewIsHostTable,
    viewPluginIsHostTable: gate.view?.realm?.viewPluginIsHostTable,
  })) {
    assert(value === true, `CodeMirror identity proof failed: ${name}.`);
  }
  const tableProbe = await evaluate(`(() => {
    const table = window.__threadleafTrustedHostModules;
    const state = table?.["@codemirror/state"];
    const view = table?.["@codemirror/view"];
    return {
      hasTable: Boolean(table),
      hasStateConstructors: Boolean(state?.EditorState && state?.StateField && state?.Facet && state?.Compartment),
      hasViewConstructors: Boolean(view?.EditorView && view?.ViewPlugin),
    };
  })()`);
  assert(
    tableProbe.hasTable && tableProbe.hasStateConstructors && tableProbe.hasViewConstructors,
    "The trusted renderer CodeMirror host table is incomplete.",
  );
  const probe = await evaluate("window.__threadleafTrustedWorkspaceTest ?? null");
  assert(
    typeof probe?.rendererIdentity === "string",
    "The trusted renderer identity probe is missing.",
  );
  assert(
    typeof probe?.dispatch === "undefined",
    "The renderer probe leaked a serialized dispatch function.",
  );
  const initialCounts = await editorSurfaceCounts();
  assert(
    JSON.stringify(initialCounts) ===
      JSON.stringify({
        primaryState: 1,
        secondaryState: 1,
        primaryView: 1,
        secondaryView: 1,
        stateMarker: "loaded",
      }),
    `Trusted extensions did not mount once in both native editors: ${JSON.stringify(initialCounts)}`,
  );
  const current = await snapshot();
  assert(
    current.plugins?.every((plugin) => plugin.state === "loaded"),
    `Trusted plugin state was not fully loaded: ${JSON.stringify(current.plugins)}`,
  );
  assert(
    current.commands?.some((command) => command.id === "inspection-safe:inspection-safe-command"),
    "The unchanged ordinary command plugin did not register.",
  );
  const commandResult = await evaluate(
    `window.threadleaf.runCommand("inspection-safe:inspection-safe-command")`,
  );
  assert(
    commandResult?.notices?.some((notice) => notice.includes("Inspection fixture command ran.")),
    "The unchanged ordinary command plugin did not execute.",
  );
  assert(vaultId === current.vault.id, "Trusted realm assertion used a stale vault identity.");
}

async function dispatchNativeEditors() {
  phase = "real native editor dispatch delivery";
  const before = await evaluate("window.__threadleafTrustedGate.state.transitions");
  await evaluate('window.__threadleafTrustedWorkspaceDispatch("primary", "trusted-primary")');
  await evaluate('window.__threadleafTrustedWorkspaceDispatch("secondary", "trusted-secondary")');
  await waitFor(async () => {
    const gate = await evaluate("window.__threadleafTrustedGate");
    const panes = new Set(
      (gate.view?.updates ?? [])
        .filter((update) => update.type === "doc-change")
        .map((update) => update.pane),
    );
    return gate.state?.transitions >= before + 2 && panes.has("primary") && panes.has("secondary")
      ? gate
      : null;
  }, "A native EditorView.dispatch did not reach both plugin callbacks");
}

async function unloadAndReloadOwner(vaultId) {
  phase = "owner-scoped unload and reload";
  await evaluate(
    `window.threadleaf.setPluginEnabled(${JSON.stringify(vaultId)}, "threadleaf-trusted-state-fixture", false)`,
  );
  await waitFor(async () => {
    const current = await snapshot();
    const counts = await editorSurfaceCounts();
    return current.plugins?.some(
      (plugin) => plugin.id === "threadleaf-trusted-state-fixture" && plugin.state === "unloaded",
    ) &&
      counts.stateMarker === null &&
      counts.primaryView === 1 &&
      counts.secondaryView === 1
      ? current
      : null;
  }, "Unloading the state plugin did not remove only its owner resources");
  await evaluate(
    `window.threadleaf.setPluginEnabled(${JSON.stringify(vaultId)}, "threadleaf-trusted-state-fixture", true)`,
  );
  await waitFor(async () => {
    const gate = await evaluate("window.__threadleafTrustedGate");
    const counts = await editorSurfaceCounts();
    return gate.state?.loadCount >= 2 &&
      counts.stateMarker === "loaded" &&
      counts.primaryView === 1 &&
      counts.secondaryView === 1
      ? gate
      : null;
  }, "Re-enabling the state plugin did not restore its extensions without duplicating the view owner");
  await evaluate(`window.threadleaf.reloadPlugins(${JSON.stringify(vaultId)})`);
  await waitFor(async () => {
    const gate = await evaluate("window.__threadleafTrustedGate");
    const counts = await editorSurfaceCounts();
    return gate.state?.loadCount >= 3 &&
      gate.view?.loadCount >= 2 &&
      counts.primaryState === 1 &&
      counts.secondaryState === 1 &&
      counts.primaryView === 1 &&
      counts.secondaryView === 1
      ? gate
      : null;
  }, "Explicit plugin reload did not restore each extension exactly once");
}

async function assertNavigationAndPermissionGuards() {
  phase = "trusted navigation, popup, and permission guards";
  const before = await evaluate("location.href");
  const result = await evaluate(`(async () => {
    const popup = window.open("https://example.com/threadleaf-denied-popup");
    const link = document.createElement("a");
    link.href = "https://example.com/threadleaf-denied-navigation";
    link.target = "_self";
    document.body.append(link);
    link.click();
    link.remove();
    let permission = "denied";
    try {
      permission = (await navigator.permissions.query({ name: "geolocation" })).state;
    } catch {
      permission = "denied";
    }
    return { popupDenied: popup === null, permission, url: location.href };
  })()`);
  assert(result.popupDenied === true, "A remote popup was not denied.");
  assert(
    result.permission === "denied",
    `A remote permission was not denied: ${result.permission}`,
  );
  assert(
    result.url === before && result.url.startsWith("file:"),
    `Remote navigation escaped the local document: ${result.url}`,
  );
  await delay(150);
  assert(
    !(await targets()).some(
      (target) => typeof target.url === "string" && target.url.startsWith("https:"),
    ),
    "A remote navigation or popup target appeared after the guard check.",
  );
}

async function captureThemes() {
  phase = "trusted theme screenshots";
  const captures = {};
  for (const theme of ["dark", "light"]) {
    await waitFor(async () => {
      const current = await evaluate("document.documentElement.dataset.theme");
      return current === theme ? true : null;
    }, `The ${theme} theme did not apply`);
    const result = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const bytes = Buffer.from(result.data, "base64");
    assert(bytes.length > 1_024, `${theme} screenshot was unexpectedly small.`);
    captures[theme] = sha256(bytes);
    if (screenshotDirectory) {
      await fs.mkdir(screenshotDirectory, { recursive: true });
      await fs.writeFile(path.join(screenshotDirectory, `trusted-workspace-${theme}.png`), bytes, {
        mode: 0o600,
      });
    }
    if (theme === "dark") {
      await evaluate("document.querySelector('#theme-toggle')?.click(); true");
      await waitFor(
        async () => (await evaluate("document.documentElement.dataset.theme")) === "light",
        "The light theme toggle did not apply",
      );
    }
  }
  assert(captures.dark !== captures.light, "The trusted theme screenshots were byte-identical.");
  return captures;
}

async function captureProfileSurface() {
  phase = "trusted compatibility profile screenshot";
  const visible = await exposeCompatibilityProfileControl();
  assert(visible === true, "The trusted compatibility profile settings page was not visible.");
  const result = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const bytes = Buffer.from(result.data, "base64");
  assert(
    bytes.length > 1_024,
    "The trusted compatibility profile screenshot was unexpectedly small.",
  );
  if (screenshotDirectory) {
    await fs.mkdir(screenshotDirectory, { recursive: true });
    await fs.writeFile(path.join(screenshotDirectory, "trusted-workspace-profile.png"), bytes, {
      mode: 0o600,
    });
  }
  return sha256(bytes);
}

async function crashTrustedRenderer(vaultId) {
  phase = "trusted main renderer crash and rebind";
  const previousWebSocketUrl = mainTarget.webSocketDebuggerUrl;
  await evaluate("window.__threadleafTrustedGate.holdNextLoad = true; true");
  const pendingReload = evaluate(`window.threadleaf.reloadPlugins(${JSON.stringify(vaultId)})`);
  await waitFor(
    async () => evaluate("window.__threadleafTrustedGate.pendingLoadStarted === true"),
    "The trusted plugin reload did not create pending work before the crash",
  );
  try {
    await cdp.send("Page.crash");
  } catch {
    // Page.crash may close the transport before its command response arrives.
  }
  let pendingError = null;
  try {
    await pendingReload;
  } catch (error) {
    pendingError = String(error);
  }
  assert(
    pendingError !== null,
    "Pending trusted plugin work incorrectly completed after renderer death.",
  );
  assert(
    /renderer-dead/iu.test(pendingError),
    `Pending renderer work lacked a renderer-dead rejection: ${pendingError}`,
  );
  cdp = undefined;
  const replacement = await reconnectAfterRendererReplacement(previousWebSocketUrl);
  assert(
    replacement.webSocketDebuggerUrl !== previousWebSocketUrl,
    "Main renderer recovery reused the dead renderer identity.",
  );
  const recovered = await waitForReady(vaultPath, [
    "threadleaf-trusted-state-fixture",
    "threadleaf-trusted-view-fixture",
    "inspection-safe",
  ]);
  const identity = await evaluate(
    "window.__threadleafTrustedWorkspaceTest?.rendererIdentity ?? null",
  );
  assert(typeof identity === "string", "The recovered renderer identity probe is missing.");
  const counts = await editorSurfaceCounts();
  assert(
    counts.primaryState === 1 &&
      counts.secondaryState === 1 &&
      counts.primaryView === 1 &&
      counts.secondaryView === 1,
    `Crash recovery did not remount both native extensions once: ${JSON.stringify(counts)}`,
  );
  assert(
    recovered.plugins?.every((plugin) => plugin.state === "loaded"),
    `Crash recovery did not reconstruct every plugin: ${JSON.stringify(recovered.plugins)}`,
  );
}

async function descendantRendererCommandLines(rootPid) {
  const entries = await fs.readdir("/proc", { withFileTypes: true });
  const processes = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    try {
      const [status, commandLine] = await Promise.all([
        fs.readFile(path.join("/proc", entry.name, "status"), "utf8"),
        fs.readFile(path.join("/proc", entry.name, "cmdline"), "utf8"),
      ]);
      processes.push({
        pid: Number(entry.name),
        parent: Number(/^PPid:\s+(\d+)$/mu.exec(status)?.[1] ?? -1),
        commandLine: commandLine.replaceAll("\0", " "),
      });
    } catch {
      // A short-lived renderer disappeared between proc reads.
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

async function assertIsolatedMode() {
  phase = "isolated sandbox and renderer regression";
  const current = await waitForReady(vaultPath, [
    "threadleaf-trusted-state-fixture",
    "threadleaf-trusted-view-fixture",
    "inspection-safe",
  ]);
  assert(
    !(await evaluate("window.__threadleafTrustedGate")),
    "Isolated mode leaked the trusted plugin global into the main renderer.",
  );
  assert(
    !(await evaluate("window.__threadleafTrustedWorkspaceTest")),
    "Isolated mode exposed the trusted renderer probe.",
  );
  assert(
    !(await evaluate("window.__threadleafTrustedWorkspaceDispatch")),
    "Isolated mode exposed the trusted editor dispatch probe.",
  );
  const counts = await editorSurfaceCounts();
  assert(
    counts.primaryState === 0 &&
      counts.secondaryState === 0 &&
      counts.primaryView === 0 &&
      counts.secondaryView === 0 &&
      counts.stateMarker === null,
    `Isolated mode delivered editor extensions into native editors: ${JSON.stringify(counts)}`,
  );
  assert(
    current.events?.some((event) =>
      event.message.includes(
        "Editor extensions are registered but unavailable in isolated compatibility mode.",
      ),
    ),
    "Isolated mode did not report registered-but-unavailable editor extensions.",
  );
  const pluginTargets = (await targets()).filter(
    (target) =>
      target.type === "page" &&
      typeof target.url === "string" &&
      target.url.endsWith("/plugin-host.html"),
  );
  assert(
    pluginTargets.length >= 3,
    `Isolated mode did not create separate plugin renderers: ${pluginTargets.length}`,
  );
  const rendererLines = await waitFor(async () => {
    const lines = await descendantRendererCommandLines(child.pid);
    return lines.length >= 4 ? lines : null;
  }, "Isolated mode did not expose the sandboxed main and separate plugin renderer processes");
  assert(
    rendererLines.some((line) => line.includes("--enable-sandbox")),
    "The isolated main renderer was not sandboxed.",
  );
  assert(
    current.plugins?.every((plugin) => plugin.state === "loaded"),
    `Isolated plugin control state was not loaded: ${JSON.stringify(current.plugins)}`,
  );
}

async function main() {
  if (process.platform !== "linux") {
    throw new Error("The trusted-workspace compatibility E2E requires Linux and Xvfb.");
  }
  await fs.access(electronPath);
  const hashes = await pluginHashes();
  await copyFixtureVaults();
  const canonicalVaultPath = await fs.realpath(vaultPath);
  const canonicalSecondVaultPath = await fs.realpath(secondVaultPath);
  const firstVaultId = sha256(Buffer.from(canonicalVaultPath));
  const secondVaultId = sha256(Buffer.from(canonicalSecondVaultPath));
  await writeVaultSettings("trusted-workspace", hashes, firstVaultId, secondVaultId);
  await fs.symlink(secondVaultPath, pickerLink);

  phase = "trusted launch";
  await launchApplication("trusted-workspace");
  const initial = await waitForReady(vaultPath);
  await grantPlugins(initial.vault.id, hashes);
  await waitForReady(vaultPath, Object.keys(hashes));
  await waitFor(
    async () => evaluate("document.querySelector('#toast')?.hidden === true"),
    "The trusted launch left a plugin warning toast visible after authority settled",
  );
  await assertTrustedRealm(initial.vault.id);
  await dispatchNativeEditors();
  await waitFor(
    async () =>
      (await fs.readFile(path.join(vaultPath, "Linked Note.md"), "utf8")) === "trusted-primary"
        ? true
        : null,
    "The native editor dispatch did not settle its required fixture edit",
  );
  const vaultBytesBefore = await captureTree(vaultPath);
  await unloadAndReloadOwner(initial.vault.id);
  await assertNavigationAndPermissionGuards();
  await waitFor(
    async () => evaluate("document.querySelector('#toast')?.hidden === true"),
    "The trusted compatibility surface did not settle its startup notification",
  );

  await chooseCompatibilityProfile("isolated");
  await assertIsolatedMode();
  await chooseCompatibilityProfile("trusted-workspace");
  await waitForReady(vaultPath, Object.keys(hashes));
  await assertTrustedRealm(firstVaultId);
  const trustedProfileScreenshot = await captureProfileSurface();
  await waitFor(
    async () => evaluate("document.querySelector('#settings-close')?.disabled === false"),
    "The compatibility settings dialog stayed busy after the profile settled",
  );
  await evaluate("document.querySelector('#settings-close')?.click(); true");
  await waitFor(
    async () => evaluate("document.querySelector('#shortcut-settings')?.open !== true"),
    "The compatibility settings dialog did not close before theme capture",
  );
  const trustedScreenshots = await captureThemes();

  phase = "trusted vault switch to isolated second vault";
  await chooseVault(secondVaultPath);
  const second = await waitForReady(secondVaultPath);
  assert(
    second.plugins?.every((plugin) => plugin.state !== "loaded"),
    "Vault switch retained an old loaded plugin owner.",
  );
  assert(
    JSON.stringify(await editorSurfaceCounts()) ===
      JSON.stringify({
        primaryState: 0,
        secondaryState: 0,
        primaryView: 0,
        secondaryView: 0,
        stateMarker: null,
      }),
    "Vault switch retained an old native editor extension effect.",
  );
  await chooseVault(vaultPath);
  await waitForReady(vaultPath, Object.keys(hashes));
  const vaultBytesAfterSwitch = await captureTree(vaultPath);
  assert(
    JSON.stringify(vaultBytesAfterSwitch) === JSON.stringify(vaultBytesBefore),
    `Vault bytes changed across trusted owner teardown and vault switching: ${JSON.stringify({
      before: vaultBytesBefore,
      after: vaultBytesAfterSwitch,
    })}`,
  );
  await crashTrustedRenderer(firstVaultId);
  assert(
    JSON.stringify(await captureTree(vaultPath)) === JSON.stringify(vaultBytesBefore),
    "Vault or plugin bytes changed across trusted renderer crash recovery.",
  );
  await closeApplication();

  phase = "isolated launch";
  await writeVaultSettings("isolated", hashes, firstVaultId, secondVaultId);
  await launchApplication("isolated");
  await assertIsolatedMode();
  console.log(
    JSON.stringify({
      status: "passed",
      trustedScreenshots,
      trustedProfileScreenshot,
      trustedRenderer: "shared-main-world",
      isolatedPluginRenderers: (await targets()).filter((target) =>
        target.url?.endsWith("/plugin-host.html"),
      ).length,
      vaultBytesPreserved: true,
    }),
  );
}

try {
  await main();
} catch (error) {
  console.error(
    `[trusted-workspace] phase=${phase} ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  if (output.length > 0) {
    console.error(`[trusted-workspace] electron-output\n${output.join("")}`);
  }
  process.exitCode = 1;
} finally {
  try {
    await closeApplication();
  } finally {
    await removeTestRoot();
  }
}
