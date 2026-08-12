import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const appRoot = process.cwd();
const electronPath = path.join(appRoot, "node_modules", ".bin", "electron");
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-support-bundle-"));
const vaultPath = path.join(testRoot, "PRIVATE_VAULT_PATH_CANARY");
const userDataPath = path.join(testRoot, "user-data");
const reportPath = path.join(testRoot, "outside", "threadleaf-support.md");
const screenshotDirectory = process.env.THREADLEAF_SUPPORT_SCREENSHOT_DIR;
const noteName = "PRIVATE_NOTE_FILENAME_CANARY.md";
const noteContent = "# PRIVATE_NOTE_CONTENT_CANARY\n\nPrivate body text.\n";
const privateCanaries = [
  testRoot,
  vaultPath,
  path.basename(vaultPath),
  reportPath,
  noteName,
  "PRIVATE_NOTE_CONTENT_CANARY",
  "Private body text.",
];
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
        const main = targets.find(
          (target) =>
            target.type === "page" &&
            typeof target.url === "string" &&
            target.url.endsWith("/dist/renderer/index.html"),
        );
        if (main?.webSocketDebuggerUrl) {
          return main;
        }
      }
    } catch {
      // The debugging endpoint is not ready yet.
    }
    await delay(50);
  }
  throw new Error("Threadleaf did not expose its main renderer in time.");
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

async function waitFor(probe, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) {
      return last;
    }
    await delay(50);
  }
  throw new Error(`${message}. Last observation: ${JSON.stringify(last)}`);
}

async function openSupportSettings() {
  await evaluate(`(() => {
    document.querySelector('#settings-trigger')?.click();
    document.querySelector('#settings-nav-updates')?.click();
    return true;
  })()`);
  return waitFor(async () => {
    const state = await evaluate(`(() => ({
      dialogOpen: document.querySelector('#shortcut-settings')?.open ?? false,
      pageHidden: document.querySelector('[data-settings-page="updates"]')?.hidden ?? true,
      buttonDisabled: document.querySelector('#support-bundle-export')?.disabled ?? true,
      copy: (document.querySelector('.support-bundle-card')?.textContent ?? '')
        .replace(/\\s+/g, ' ')
        .trim(),
      status: document.querySelector('#support-bundle-status')?.textContent ?? '',
    }))()`);
    return state.dialogOpen && !state.pageHidden && !state.buttonDisabled ? state : null;
  }, "The support bundle control did not become reachable");
}

async function waitForSavedReport() {
  return waitFor(async () => {
    const state = await evaluate(`(() => ({
      status: document.querySelector('#support-bundle-status')?.textContent ?? '',
      kind: document.querySelector('#support-bundle-status')?.getAttribute('data-kind') ?? '',
    }))()`);
    return (await exists(reportPath)) && state.kind === "saved" ? state : null;
  }, "The support bundle did not save through the visible control");
}

async function captureSettings(theme, suffix = "") {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if ((await evaluate("document.documentElement.dataset.theme")) === theme) {
      const capture = await cdp.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      });
      const destination = path.join(screenshotDirectory, `support-bundle-${theme}${suffix}.png`);
      await fs.writeFile(destination, Buffer.from(capture.data, "base64"));
      return destination;
    }
    await evaluate('document.querySelector("#theme-toggle")?.click(); true');
    await delay(50);
  }
  throw new Error(`Threadleaf did not switch to ${theme} for the support bundle screenshot.`);
}

try {
  if (process.platform !== "linux") {
    throw new Error("The support bundle integration check currently requires Linux and Xvfb.");
  }
  await fs.access(electronPath);
  await Promise.all([
    fs.mkdir(vaultPath, { recursive: true }),
    fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(path.dirname(reportPath), { recursive: true }),
  ]);
  await fs.writeFile(path.join(vaultPath, noteName), noteContent, "utf8");

  const port = await availablePort();
  child = spawn(
    "xvfb-run",
    [
      "-a",
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
        THREADLEAF_SUPPORT_BUNDLE_PATH: reportPath,
        THREADLEAF_VAULT_PATH: vaultPath,
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
      if (output.length > 100) {
        output.shift();
      }
    });
  }
  await started;

  const target = await waitForMainTarget(port, Date.now() + 10_000);
  cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await waitFor(
    async () =>
      evaluate(`(async () => {
        const snapshot = await window.threadleaf.getSnapshot();
        return snapshot.workspace?.state === 'ready' && snapshot.vault.path === ${JSON.stringify(vaultPath)};
      })()`),
    "The private-canary vault did not become ready",
  );

  const supportUi = await openSupportSettings();
  assert(supportUi.copy.includes("Nothing is uploaded"), "The support UI lacks upload guidance.");
  assert(
    supportUi.copy.includes("excludes note text") && supportUi.copy.includes("plugin identities"),
    "The support UI lacks its concrete privacy boundary.",
  );
  for (const canary of privateCanaries) {
    assert(!supportUi.copy.includes(canary), `The visible support UI leaked ${canary}.`);
  }

  await evaluate('document.querySelector("#support-bundle-export")?.click(); true');
  const firstSave = await waitForSavedReport();
  assert(firstSave.status.includes("Nothing was uploaded"), "Saved state lost upload guidance.");

  const report = await fs.readFile(reportPath, "utf8");
  assert(report.includes("# Threadleaf beta support bundle"), "Support report lacks its title.");
  assert(report.includes('"aggregateOnly": true'), "Support report lacks its privacy marker.");
  assert(report.includes('"noteCount": 1'), "Support report lacks the aggregate note count.");
  for (const canary of privateCanaries) {
    assert(!report.includes(canary), `Support report leaked private canary ${canary}.`);
  }
  const mode = (await fs.stat(reportPath)).mode & 0o777;
  assert(mode === 0o600, `Support report mode was ${mode.toString(8)} instead of 600.`);
  assert(
    JSON.stringify((await fs.readdir(vaultPath)).sort()) === JSON.stringify([noteName]),
    "Support export wrote into or otherwise changed the active vault.",
  );

  await fs.unlink(reportPath);
  await evaluate(`(() => {
    document.querySelector('#settings-close')?.click();
    document.querySelector('#command-trigger')?.click();
    const query = document.querySelector('#palette-query');
    query.value = 'support bundle';
    query.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const paletteState = await waitFor(async () => {
    const state = await evaluate(`(() => {
      const option = document.querySelector('[data-command-id="support.export-bundle"]');
      return {
        open: document.querySelector('#command-palette')?.open ?? false,
        present: Boolean(option),
        disabled: option?.disabled ?? true,
        label: option?.textContent ?? '',
      };
    })()`);
    return state.open && state.present ? state : null;
  }, "The support command did not appear in the command palette");
  assert(!paletteState.disabled, "The support command was unexpectedly disabled.");
  assert(paletteState.label.includes("Save privacy-safe"), "The support command label is unclear.");
  await evaluate(
    "document.querySelector('[data-command-id=\"support.export-bundle\"]')?.click(); true",
  );
  await waitFor(() => exists(reportPath), "The command-palette support export did not save");

  let screenshots = [];
  if (screenshotDirectory) {
    await fs.mkdir(screenshotDirectory, { recursive: true });
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1180,
      height: 820,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await openSupportSettings();
    screenshots = [await captureSettings("dark"), await captureSettings("light")];
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 860,
      height: 640,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await evaluate(`(() => {
      const content = document.querySelector('.settings-content');
      if (content) content.scrollTop = content.scrollHeight;
      return { width: innerWidth, height: innerHeight };
    })()`);
    await delay(150);
    screenshots.push(
      await captureSettings("light", "-compact"),
      await captureSettings("dark", "-compact"),
    );
  }

  await evaluate("setTimeout(() => window.close(), 0); true");
  const exit = await Promise.race([
    exited,
    delay(10_000).then(() => ({ code: null, signal: "timeout" })),
  ]);
  assert(exit.code === 0, `Electron did not exit cleanly: ${JSON.stringify(exit)}.`);
  console.log(
    JSON.stringify({
      reportMode: mode.toString(8),
      reportBytes: Buffer.byteLength(report),
      noteCount: 1,
      settingsControl: true,
      commandPaletteControl: true,
      screenshots,
    }),
  );
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  const logs = output.join("").trim();
  throw new Error(logs ? `${detail}\nElectron output:\n${logs}` : detail, { cause: error });
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
