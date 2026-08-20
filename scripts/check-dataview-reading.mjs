import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const appRoot = process.cwd();
const electronPath = path.join(appRoot, "node_modules", ".bin", "electron");
const screenshotDirectory = process.env.THREADLEAF_DATAVIEW_SCREENSHOT_DIR;
const installedPluginSource = process.env.THREADLEAF_DATAVIEW_PLUGIN_PATH?.trim();
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-dataview-reading-"));
const vaultPath = path.join(testRoot, "vault");
const userDataPath = path.join(testRoot, "user-data");
const pluginPath = path.join(vaultPath, ".obsidian", "plugins", "dataview");
const output = [];
let child;
let cdp;
let exited;

const officialAssets = [
  {
    name: "manifest.json",
    url: "https://github.com/blacksmithgu/obsidian-dataview/releases/download/0.5.68/manifest.json",
    sha256: "9235db47112da81b85591c79ecb9ae2574e5e72207056e976472f90616286185",
  },
  {
    name: "main.js",
    url: "https://github.com/blacksmithgu/obsidian-dataview/releases/download/0.5.68/main.js",
    sha256: "794e9eaede73920bb8d54b0eda4f5de2182d698cc638774500f24f14bcd4da0b",
  },
  {
    name: "styles.css",
    url: "https://github.com/blacksmithgu/obsidian-dataview/releases/download/0.5.68/styles.css",
    sha256: "3306dd9032e00f989ba7233a37fd255bc4d3f4340cee661762e952f3f6aa1de9",
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

async function makeDisposableTreeRemovable(candidatePath) {
  const stat = await fs.lstat(candidatePath).catch(() => null);
  if (!stat || stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) {
    if (stat.isFile()) await fs.chmod(candidatePath, 0o600).catch(() => undefined);
    return;
  }
  await fs.chmod(candidatePath, 0o700).catch(() => undefined);
  for (const entry of await fs.readdir(candidatePath).catch(() => [])) {
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

async function withTimeout(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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

async function captureScreenshot(name) {
  const result = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  const bytes = Buffer.from(result.data, "base64");
  if (screenshotDirectory) {
    await fs.mkdir(screenshotDirectory, { recursive: true });
    await fs.writeFile(path.join(screenshotDirectory, `${name}.png`), bytes);
  }
  return bytes;
}

async function currentTheme() {
  return evaluate("document.documentElement.dataset.theme");
}

async function openReadingView() {
  await withTimeout(
    evaluate('window.threadleaf.openNote("Welcome.md", "primary", true)'),
    5_000,
    "Opening the Dataview fixture did not resolve within 5 seconds.",
  );
  await evaluate(`(() => {
    const button = document.querySelector("#read-view");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`);
  await waitFor(
    async () =>
      (await evaluate('document.querySelector("#read-view")?.getAttribute("aria-pressed")')) ===
      "true",
    "Reading view did not activate",
  );
}

async function fetchOfficialPackage() {
  await fs.mkdir(pluginPath, { recursive: true });
  for (const asset of officialAssets) {
    const response = await fetch(asset.url, { redirect: "follow" });
    assert(response.ok, `Could not fetch official Dataview ${asset.name}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert(
      sha256(bytes) === asset.sha256,
      `Official Dataview ${asset.name} did not match the pinned SHA-256.`,
    );
    await fs.writeFile(path.join(pluginPath, asset.name), bytes);
  }
}

async function prepareDataviewPackage() {
  if (!installedPluginSource) {
    await fetchOfficialPackage();
    return;
  }
  await fs.cp(path.resolve(installedPluginSource), pluginPath, { recursive: true });
  for (const asset of officialAssets) {
    const bytes = await fs.readFile(path.join(pluginPath, asset.name));
    assert(
      sha256(bytes) === asset.sha256,
      `Installed Dataview ${asset.name} did not match the pinned 0.5.68 SHA-256.`,
    );
  }
}

try {
  if (process.platform !== "linux") {
    throw new Error("The Dataview Reading check currently requires Linux and Xvfb.");
  }
  await fs.access(electronPath);
  await prepareDataviewPackage();
  await fs.mkdir(userDataPath, { recursive: true });
  await fs.writeFile(
    path.join(vaultPath, "Welcome.md"),
    [
      "---",
      "kind: parity-fixture",
      "score: 7",
      "---",
      "",
      "# Dataview parity fixture",
      "",
      "```dataview",
      'TABLE score WHERE kind = "parity-fixture"',
      "```",
      "",
    ].join("\n"),
  );
  await fs.writeFile(path.join(vaultPath, "Other.md"), "# Rerender control\n");
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
            enabledPluginIds: ["dataview"],
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
            editorMode: "live",
            documentView: "reading",
            showInlineTitle: true,
            readableLineLength: true,
            showLineNumbers: false,
            spellcheck: true,
            tabSize: 2,
            showStatusBar: true,
            restorePolicy: "restore",
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
  const started = new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      output.push(String(chunk));
      if (output.length > 100) output.shift();
    });
  }
  await started;

  const target = await waitForMainTarget(port);
  cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1180,
    height: 820,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const initialCatalog = await waitFor(
    async () => {
      const state = await evaluate(`window.threadleaf.getSnapshot().then(async (snapshot) => ({
        snapshot,
        catalog: await window.threadleaf.getPlugins(snapshot.vault?.id),
      }))`);
      const plugin = state?.catalog?.catalog?.plugins?.find(({ id }) => id === "dataview");
      return !state?.snapshot?.startup &&
        state?.snapshot?.vault?.path === canonicalVaultPath &&
        state?.snapshot?.workspace?.state === "ready" &&
        plugin?.packageState === "ready"
        ? { vaultId: state.snapshot.vault.id, plugin }
        : null;
    },
    "The official Dataview package did not appear in the ready vault catalog",
    15_000,
  );
  assert(
    initialCatalog.plugin.capabilityReport?.bundleSha256 ===
      officialAssets.find(({ name }) => name === "main.js").sha256,
    "The discovered Dataview package did not retain the pinned main bundle identity.",
  );
  await withTimeout(
    evaluate(
      `window.threadleaf.setPluginCapabilityGrant(${JSON.stringify(initialCatalog.vaultId)}, "dataview", ${JSON.stringify(officialAssets.find(({ name }) => name === "main.js").sha256)}, true)`,
    ),
    10_000,
    "The reviewed Dataview authority grant did not resolve within 10 seconds.",
  );
  let lastReadiness = null;
  await waitFor(
    async () => {
      const state = await withTimeout(
        evaluate(`(() => {
          const plugin = window.DataviewAPI;
          return Promise.all([window.threadleaf.getSnapshot(), window.threadleaf.getSettings()]).then(async ([snapshot, settings]) => ({
            ready: !snapshot.startup && snapshot.vault?.path === ${JSON.stringify(canonicalVaultPath)} && snapshot.workspace?.state === "ready",
            vaultId: snapshot.vault?.id,
            savedPluginPreference: settings.settings?.pluginsByVault?.[snapshot.vault?.id],
            catalog: await window.threadleaf.getPlugins(snapshot.vault?.id),
            pluginState: snapshot.plugins?.find(({ id }) => id === "dataview")?.state,
            plugins: snapshot.plugins?.map(({ id, state, error }) => ({ id, state, error })),
            notices: snapshot.notices,
            initialized: plugin?.index?.initialized === true,
            score: plugin?.page?.("Welcome.md")?.score,
            codeMirrorVersion: window.CodeMirror?.version,
          }));
        })()`),
        2_000,
        "The Dataview readiness probe did not resolve within 2 seconds.",
      );
      lastReadiness = state;
      return state?.ready &&
        state.pluginState === "loaded" &&
        state.initialized &&
        state.score === 7 &&
        state.codeMirrorVersion === "5.65.21"
        ? state
        : null;
    },
    "Official Dataview did not load, index frontmatter, and expose CodeMirror 5",
    20_000,
  ).catch((error) => {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; last state: ${JSON.stringify(lastReadiness)}`,
      { cause: error },
    );
  });
  const csp = await evaluate(
    'document.querySelector("meta[http-equiv=Content-Security-Policy]")?.content ?? ""',
  );
  assert(
    csp.includes("worker-src 'self' blob:"),
    `The trusted renderer did not explicitly admit reviewed Blob workers: ${csp}`,
  );

  await openReadingView();
  const ready = await waitFor(
    () =>
      evaluate(`(() => {
        const result = document.querySelector('.threadleaf-dataview-result[data-plugin-projection-state="ready"]');
        const link = result?.querySelector('a[data-threadleaf-link="wiki"]');
        const score = result?.querySelector("tbody td:last-child")?.textContent?.trim();
        if (!result || !link || score !== "7") return null;
        return {
          score,
          linkText: link.textContent?.trim(),
          linkPath: link.dataset.threadleafPath,
          linkStatus: link.dataset.linkStatus,
          fontSize: getComputedStyle(result.querySelector("table")).fontSize,
          rawFence: Boolean(document.querySelector("pre > code.language-dataview")),
        };
      })()`),
    "Dataview did not replace the native query fence with a settled table",
    15_000,
  );
  assert(
    ready.linkText === "Welcome" &&
      ready.linkPath === "Welcome.md" &&
      ready.linkStatus === "resolved" &&
      ready.fontSize === "13px" &&
      ready.rawFence === false,
    `The in-place Dataview result was incomplete: ${JSON.stringify(ready)}`,
  );
  await evaluate('document.querySelector(".threadleaf-dataview-result a")?.click(); true');
  await waitFor(
    async () =>
      (await evaluate('document.querySelector("#note-path")?.textContent')) === "Welcome.md",
    "The Dataview file link did not follow native note navigation",
  );

  assert((await currentTheme()) === "dark", "The baseline was not in the dark theme.");
  const darkReady = await captureScreenshot("dataview-reading-dark-ready");
  await evaluate('document.querySelector("#theme-toggle")?.click(); true');
  await waitFor(async () => (await currentTheme()) === "light", "Theme did not switch to light");
  await delay(100);
  const lightReady = await captureScreenshot("dataview-reading-light-ready");
  assert(
    !darkReady.equals(lightReady),
    "Dark and light Dataview screenshots were identical; the visual capture is not live.",
  );
  await evaluate('document.querySelector("#theme-toggle")?.click(); true');
  await waitFor(async () => (await currentTheme()) === "dark", "Theme did not return to dark");

  await withTimeout(
    evaluate(`window.threadleaf.setPluginEnabled(${JSON.stringify(vaultId)}, "dataview", false)`),
    5_000,
    "Disabling Dataview did not resolve within 5 seconds.",
  );
  await waitFor(async () => {
    const snapshot = await evaluate("window.threadleaf.getSnapshot()");
    return snapshot?.plugins?.find(({ id }) => id === "dataview")?.state !== "loaded";
  }, "Dataview did not unload");
  await withTimeout(
    evaluate('window.threadleaf.openNote("Other.md", "primary", true)'),
    5_000,
    "Opening the rerender control note did not resolve within 5 seconds.",
  );
  await waitFor(
    async () =>
      (await evaluate('document.querySelector("#note-path")?.textContent')) === "Other.md",
    "The rerender control note did not become active",
  );
  await openReadingView();
  const disabled = await waitFor(
    () =>
      evaluate(`(() => {
        const panel = document.querySelector('.plugin-markdown-projection[data-plugin-projection="dataview"]');
        return panel?.dataset.pluginProjectionState === "unavailable" && document.querySelector("pre > code.language-dataview")
          ? panel.textContent
          : null;
      })()`),
    "Disabled Dataview did not keep the raw query visible with an explicit unavailable state",
  );
  assert(
    disabled.includes("Dataview") && disabled.toLowerCase().includes("not currently active"),
    `Disabled Dataview reported an unexpected state: ${disabled}`,
  );
  const darkDisabled = await captureScreenshot("dataview-reading-dark-disabled");
  assert(
    !darkReady.equals(darkDisabled),
    "Ready and disabled screenshots of the same note were identical; the red control failed.",
  );

  console.log(
    "Verified official Dataview 0.5.68 loads with reviewed Blob-worker and CodeMirror 5 support, indexes frontmatter, renders an in-place linked table in native Reading view in both themes, and degrades explicitly when disabled.",
  );
  await withTimeout(
    evaluate("setTimeout(() => window.close(), 200); true"),
    5_000,
    "The renderer did not acknowledge its close request.",
  ).catch(() => undefined);
  await Promise.race([exited, delay(5_000)]);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  const logs = output.join("").trim();
  throw new Error(logs ? `${detail}\nElectron output:\n${logs}` : detail, { cause: error });
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
  await execFileAsync("pkill", ["-9", "-f", userDataPath]).catch(() => undefined);
  await makeDisposableTreeRemovable(testRoot);
  await fs.rm(testRoot, { recursive: true, force: true });
}
