import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const appRoot = process.cwd();
const packageData = JSON.parse(await fs.readFile(path.join(appRoot, "package.json"), "utf8"));
const executablePath = path.resolve(
  process.env.THREADLEAF_PACKAGED_EXECUTABLE ??
    path.join(appRoot, "release", "linux-unpacked", "threadleaf"),
);
const screenshotDirectory = process.env.THREADLEAF_PACKAGED_SCREENSHOT_DIR;
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-packaged-smoke-"));
const userDataPath = path.join(testRoot, "user-data");
const ignoredVaultPath = path.join(testRoot, "must-not-open");
const output = [];
let child;
let cdp;
let exited;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a loopback debugging port.");
  }
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitForMainTarget(port, deadline) {
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
        if (target?.webSocketDebuggerUrl) {
          return target;
        }
      }
    } catch {
      // The packaged renderer is still starting.
    }
    await delay(50);
  }
  throw new Error("The packaged application did not expose its renderer within 10 seconds.");
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
    if (!request) {
      return;
    }
    pending.delete(message.id);
    if (message.error) {
      request.reject(new Error(message.error.message));
    } else {
      request.resolve(message.result);
    }
  });
  socket.addEventListener("close", () => {
    for (const request of pending.values()) {
      request.reject(new Error("CDP WebSocket closed."));
    }
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

async function waitForReady(deadline) {
  while (Date.now() < deadline) {
    const state = await evaluate(`(async () => ({
      title: document.title,
      brand: document.querySelector(".brand strong")?.textContent ?? "",
      runtimeState: document.querySelector("#runtime-state")?.textContent ?? "",
      vaultName: document.querySelector("#vault-name")?.textContent ?? "",
      csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? "",
      snapshot: await window.threadleaf.getSnapshot(),
    }))()`);
    if (state.runtimeState === "Ready" && state.snapshot?.workspace?.state === "ready") {
      return state;
    }
    await delay(50);
  }
  throw new Error("The packaged application did not reach a ready bundled workspace.");
}

async function waitForTheme(theme, deadline) {
  while (Date.now() < deadline) {
    if ((await evaluate("document.documentElement.dataset.theme")) === theme) {
      return;
    }
    await delay(50);
  }
  throw new Error(`The packaged application did not switch to ${theme} mode.`);
}

async function captureTheme(theme) {
  const current = await evaluate("document.documentElement.dataset.theme");
  if (current !== theme) {
    await evaluate("document.querySelector('#theme-toggle').click(); true");
    await waitForTheme(theme, Date.now() + 5_000);
  }
  const capture = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  const destination = path.join(screenshotDirectory, `packaged-linux-${theme}.png`);
  await fs.writeFile(destination, Buffer.from(capture.data, "base64"));
  return destination;
}

async function openUpdateSettings() {
  await evaluate(`(() => {
    document.querySelector('#settings-trigger')?.click();
    document.querySelector('#settings-nav-updates')?.click();
    return true;
  })()`);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await evaluate(`(() => ({
      dialogOpen: document.querySelector('#shortcut-settings')?.open ?? false,
      pageHidden: document.querySelector('[data-settings-page="updates"]')?.hidden ?? true,
      updateState: document.querySelector('#app-update-state')?.textContent ?? '',
    }))()`);
    if (state.dialogOpen && !state.pageHidden && state.updateState !== "Loading") {
      return;
    }
    await delay(50);
  }
  throw new Error("The packaged update settings page did not become ready.");
}

async function captureUpdateSettings(theme, suffix = "") {
  await openUpdateSettings();
  const capture = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  const destination = path.join(
    screenshotDirectory,
    `packaged-linux-updates-${theme}${suffix}.png`,
  );
  await fs.writeFile(destination, Buffer.from(capture.data, "base64"));
  await evaluate("document.querySelector('#settings-close')?.click(); true");
  return destination;
}

async function captureVisualPositiveControl() {
  await openUpdateSettings();
  const outlined = await evaluate(`(() => {
    const card = document.querySelector('.app-update-card');
    if (!(card instanceof HTMLElement)) return false;
    card.style.outline = '12px solid rgb(255, 0, 255)';
    card.style.outlineOffset = '-12px';
    return getComputedStyle(card).outlineColor === 'rgb(255, 0, 255)';
  })()`);
  assert(outlined, "The visual positive control did not reach the update card.");
  const capture = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  const destination = path.join(screenshotDirectory, "packaged-linux-updates-positive-control.png");
  await fs.writeFile(destination, Buffer.from(capture.data, "base64"));
  await evaluate(`(() => {
    const card = document.querySelector('.app-update-card');
    if (card instanceof HTMLElement) {
      card.style.removeProperty('outline');
      card.style.removeProperty('outline-offset');
    }
    document.querySelector('#settings-close')?.click();
    return true;
  })()`);
  return destination;
}

try {
  assert(process.platform === "linux", "The packaged smoke test currently requires Linux.");
  await fs.access(executablePath);
  await fs.mkdir(ignoredVaultPath, { recursive: true });
  await fs.writeFile(path.join(ignoredVaultPath, "Must Not Open.md"), "# Wrong vault\n", "utf8");
  await fs.mkdir(userDataPath, { recursive: true });

  const version = spawnSync(executablePath, ["--version"], {
    encoding: "utf8",
    env: { ...process.env, ELECTRON_OZONE_PLATFORM_HINT: "x11" },
  });
  assert(version.status === 0, `Packaged --version exited ${version.status}.`);
  assert(version.stderr === "", `Packaged --version wrote stderr: ${version.stderr}`);
  assert(
    version.stdout === `${packageData.version}\n`,
    "Packaged version differs from package.json.",
  );

  const port = await availablePort();
  child = spawn(
    executablePath,
    [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataPath}`, "--disable-gpu"],
    {
      cwd: appRoot,
      env: {
        ...process.env,
        ELECTRON_OZONE_PLATFORM_HINT: "x11",
        THREADLEAF_VAULT_PATH: ignoredVaultPath,
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
      if (output.length > 100) {
        output.shift();
      }
    });
  }

  const deadline = Date.now() + 10_000;
  const target = await waitForMainTarget(port, deadline);
  cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  const state = await waitForReady(deadline);
  const paths = state.snapshot.workspace.files.map((file) => file.path);
  assert(state.title === "Threadleaf", "Packaged window title is not Threadleaf.");
  assert(state.brand === "Threadleaf", "Packaged renderer did not load the Threadleaf brand.");
  assert(
    state.vaultName === "Threadleaf Demo",
    "Fresh packaged app did not open the bundled workspace.",
  );
  assert(
    state.snapshot.vault.source === "bundled",
    "Development vault override reached a package.",
  );
  assert(
    state.snapshot.vault.mode === "synthetic-read-only",
    "The bundled package workspace is not visibly read-only.",
  );
  assert(
    state.snapshot.vault.path !== ignoredVaultPath,
    "Packaged build accepted a dev-only vault.",
  );
  assert(
    path.basename(state.snapshot.vault.path) === "bundled-vault" &&
      !state.snapshot.vault.path.includes("app.asar"),
    "Packaged workspace is not an external bundled resource.",
  );
  assert(
    JSON.stringify(paths) === JSON.stringify(["Linked Note.md", "Welcome.md"]),
    `Packaged fixture inventory was unexpected: ${JSON.stringify(paths)}`,
  );
  assert(state.csp.includes("connect-src 'none'"), "Packaged renderer lost its network CSP.");

  await Promise.all([
    fs.access(path.join(state.snapshot.vault.path, "Welcome.md")),
    fs.access(path.join(state.snapshot.vault.path, ".obsidian")),
    fs.access(path.join(path.dirname(state.snapshot.vault.path), "LICENSE.threadleaf.txt")),
  ]);
  const controls = await evaluate(`(() => ({
    source: document.querySelector('#vault-source')?.textContent ?? '',
    editState: document.querySelector('#edit-state')?.textContent ?? '',
    editorEditable: document.querySelector('#note-editor .cm-content')?.getAttribute('contenteditable'),
    newDisabled: document.querySelector('#new-note')?.disabled,
    moveDisabled: document.querySelector('#move-note')?.disabled,
    deleteDisabled: document.querySelector('#delete-note')?.disabled,
    saveDisabled: document.querySelector('#save-note')?.disabled,
    packageSearchDisabled: document.querySelector('#plugin-index-search')?.disabled,
  }))()`);
  assert(controls.source === "Bundled read-only demo", "Bundled mode lacks a visible label.");
  assert(controls.editState === "Read only", "Editor status does not say Read only.");
  assert(controls.editorEditable === "false", "Bundled editor is still content-editable.");
  assert(
    controls.newDisabled &&
      controls.moveDisabled &&
      controls.deleteDisabled &&
      controls.saveDisabled &&
      controls.packageSearchDisabled,
    `Bundled mutation controls are not all disabled: ${JSON.stringify(controls)}`,
  );
  const mutation = await evaluate(`window.threadleaf
    .createNote('Blocked.md', 'must not write', ${JSON.stringify(state.snapshot.vault.id)})
    .then(() => ({ accepted: true, message: '' }))
    .catch((error) => ({ accepted: false, message: String(error?.message ?? error) }))`);
  assert(!mutation.accepted, "Bundled backend accepted a note mutation.");
  assert(
    mutation.message.includes("Open a local vault"),
    `Bundled mutation failed for the wrong reason: ${mutation.message}`,
  );
  assert(
    !(await exists(path.join(state.snapshot.vault.path, "Blocked.md"))),
    "Rejected bundled mutation still created a note.",
  );

  await openUpdateSettings();
  const updateControls = await evaluate(`(async () => ({
    snapshot: await window.threadleaf.getAppUpdate(),
    heading: document.querySelector('#settings-page-title')?.textContent ?? '',
    state: document.querySelector('#app-update-state')?.textContent ?? '',
    message: document.querySelector('#app-update-message')?.textContent ?? '',
    policy: document.querySelector('#app-update-policy')?.textContent ?? '',
    installedVersion: document.querySelector('#app-update-current-version')?.textContent ?? '',
    checkDisabled: document.querySelector('#app-update-check')?.disabled,
    progressHidden: document.querySelector('#app-update-progress')?.hidden,
  }))()`);
  assert(updateControls.heading === "About and updates", "Update settings heading is incorrect.");
  assert(updateControls.state === "Disabled", "Linux update policy is not visibly disabled.");
  assert(
    updateControls.message.includes("Linux package manager"),
    "Linux update guidance is missing.",
  );
  assert(updateControls.policy === "System package manager", "Linux update policy is incorrect.");
  assert(
    updateControls.installedVersion === packageData.version,
    "Update settings version differs from package.json.",
  );
  assert(
    updateControls.snapshot?.disabledReason === "unsupported-platform" &&
      updateControls.snapshot?.canCheck === false,
    "Packaged Linux updater did not fail closed.",
  );
  assert(updateControls.checkDisabled, "Disabled updater exposed an enabled network action.");
  assert(updateControls.progressHidden, "Inactive updater exposed a progress indicator.");
  await evaluate("document.querySelector('#settings-close')?.click(); true");

  let screenshots = [];
  if (screenshotDirectory) {
    await fs.mkdir(screenshotDirectory, { recursive: true });
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1180,
      height: 820,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await delay(150);
    const fullViewport = await evaluate("({ width: innerWidth, height: innerHeight })");
    assert(
      fullViewport.width === 1180 && fullViewport.height === 820,
      `Full window bounds were not applied: ${JSON.stringify(fullViewport)}`,
    );
    screenshots = [
      await captureTheme("dark"),
      await captureUpdateSettings("dark"),
      await captureVisualPositiveControl(),
      await captureTheme("light"),
      await captureUpdateSettings("light"),
    ];
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 860,
      height: 640,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await delay(150);
    const compactViewport = await evaluate("({ width: innerWidth, height: innerHeight })");
    assert(
      compactViewport.width === 860 && compactViewport.height === 640,
      `Compact window bounds were not applied: ${JSON.stringify(compactViewport)}`,
    );
    screenshots.push(await captureUpdateSettings("light", "-compact"));
    await evaluate("document.querySelector('#theme-toggle').click(); true");
    await waitForTheme("dark", Date.now() + 5_000);
    screenshots.push(await captureUpdateSettings("dark", "-compact"));
  }

  await evaluate("setTimeout(() => window.close(), 0); true");
  const exit = await Promise.race([
    exited,
    delay(10_000).then(() => ({ code: null, signal: "timeout" })),
  ]);
  assert(exit.code === 0, `Packaged application did not exit cleanly: ${JSON.stringify(exit)}.`);
  console.log(
    JSON.stringify({
      executablePath,
      version: packageData.version,
      vaultSource: state.snapshot.vault.source,
      files: paths,
      screenshots,
    }),
  );
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  const logs = output.join("").trim();
  throw new Error(logs ? `${detail}\nPackaged output:\n${logs}` : detail, { cause: error });
} finally {
  cdp?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    if (exited) {
      await Promise.race([exited, delay(2_000)]);
    }
  }
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    if (exited) {
      await Promise.race([exited, delay(2_000)]);
    }
  }
  await fs.rm(testRoot, { recursive: true, force: true });
}
