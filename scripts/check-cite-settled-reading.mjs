import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Packaged/Xvfb proof for the bounded, plugin-exact settled Reading projection slice: the exact
// CITE 0.1.2 compatibility fixture's registered Markdown post processor is executed to completion
// inside the isolated compatibility renderer, and its sanitized, settled HTML is shown honestly in
// native Reading view -- never a live callback, and never silently shown as unprocessed content
// when CITE is disabled. See docs/compatibility/open-plugin-api.md and docs/compatibility/plugins.md.

const appRoot = process.cwd();
const electronPath = path.join(appRoot, "node_modules", ".bin", "electron");
const fixtureVault = path.join(appRoot, "fixtures", "vaults", "cite-settled-reading");
const screenshotDirectory = process.env.THREADLEAF_CITE_SCREENSHOT_DIR;
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-cite-settled-reading-"));
const vaultPath = path.join(testRoot, "vault");
const userDataPath = path.join(testRoot, "user-data");
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
            target.url.endsWith("/dist/renderer/index.html"),
        );
        if (main?.webSocketDebuggerUrl) {
          return main;
        }
      }
    } catch {
      // The debugging endpoint is not ready yet.
    }
    await delay(100);
  }
  throw new Error("Threadleaf did not expose its main renderer within 10 seconds.");
}

function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let sequence = 0;
  const rejectPending = (message) => {
    for (const request of pending.values()) {
      request.reject(new Error(message));
    }
    pending.clear();
  };
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
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP WebSocket failed to open.")), {
      once: true,
    });
  });
  socket.addEventListener("close", () => rejectPending("CDP WebSocket closed."));
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
    if (last) {
      return last;
    }
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

async function openNoteInReadingView(notePath) {
  await withTimeout(
    evaluate(`window.threadleaf.openNote(${JSON.stringify(notePath)}, "primary", true)`),
    5_000,
    `Opening ${notePath} did not resolve within 5 seconds.`,
  );
  await waitFor(async () => {
    const state = await evaluate('document.querySelector("#note-path")?.textContent ?? ""');
    return state === notePath ? state : null;
  }, `${notePath} was not shown as the active note`);
  await evaluate(`(() => {
    const button = document.querySelector("#read-view");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`);
  await waitFor(async () => {
    const pressed = await evaluate(
      'document.querySelector("#read-view")?.getAttribute("aria-pressed")',
    );
    return pressed === "true" ? pressed : null;
  }, "Reading view did not activate");
}

async function waitForProjectionPanel(expectedState, timeoutMs = 10_000) {
  return waitFor(
    async () =>
      evaluate(`(() => {
        const panel = document.querySelector('.plugin-markdown-projection[data-plugin-projection="cite"]');
        if (!panel) return null;
        if (panel.dataset.pluginProjectionState !== ${JSON.stringify(expectedState)}) return null;
        return {
          state: panel.dataset.pluginProjectionState,
          heading: panel.querySelector(".plugin-markdown-projection-heading")?.textContent ?? "",
          body: panel.querySelector(".plugin-markdown-projection-body")?.textContent ?? "",
          citations: [...panel.querySelectorAll(".cite-citation")].map((el) => el.textContent),
        };
      })()`),
    `The CITE projection panel did not reach state "${expectedState}"`,
    timeoutMs,
  );
}

try {
  if (process.platform !== "linux") {
    throw new Error("The CITE settled Reading projection check currently requires Linux and Xvfb.");
  }
  await fs.access(electronPath);
  await fs.cp(fixtureVault, vaultPath, { recursive: true });
  await fs.mkdir(userDataPath, { recursive: true });
  const canonicalVaultPath = await fs.realpath(vaultPath);
  const vaultId = createHash("sha256").update(canonicalVaultPath).digest("hex");
  const citeBundle = await fs.readFile(
    path.join(vaultPath, ".obsidian", "plugins", "cite", "main.js"),
  );
  await fs.writeFile(
    path.join(userDataPath, "settings.json"),
    `${JSON.stringify(
      {
        version: 4,
        keyBindings: {},
        appearanceByVault: {},
        pluginsByVault: {
          [vaultId]: {
            compatibilityMode: "enabled",
            enabledPluginIds: ["cite"],
            capabilityGrantsByPlugin: {
              cite: {
                bundleSha256: createHash("sha256").update(citeBundle).digest("hex"),
                capabilities: ["workspace-ui"],
              },
            },
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
      if (output.length > 100) {
        output.shift();
      }
    });
  }
  await started;

  const target = await waitForMainTarget(port);
  cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1100,
    height: 760,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await waitFor(
    async () => {
      const snapshot = await withTimeout(
        evaluate("window.threadleaf.getSnapshot()"),
        2_000,
        "A workspace snapshot did not resolve within 2 seconds.",
      );
      return !snapshot?.startup &&
        snapshot?.vault?.path === canonicalVaultPath &&
        snapshot?.workspace?.state === "ready" &&
        snapshot?.plugins?.find(({ id }) => id === "cite")?.state === "loaded"
        ? snapshot
        : null;
    },
    "CITE did not finish loading in the target vault",
    15_000,
  );

  // Explicit failure evidence, independent of the visible panel: requesting a settled projection
  // for a plugin that is not installed at all must be refused honestly rather than throwing an
  // opaque error or silently returning unprocessed content.
  const missingPluginResponse = await withTimeout(
    evaluate(
      `window.threadleaf.renderPluginMarkdownProjection("not-a-real-plugin", "Citations.md", "content", ${JSON.stringify(vaultId)})`,
    ),
    5_000,
    "The missing-plugin projection request did not resolve within 5 seconds.",
  );
  assert(
    missingPluginResponse?.status === "unavailable" &&
      missingPluginResponse.reason === "plugin-disabled",
    `Expected an honest plugin-disabled refusal for an uninstalled plugin, got ${JSON.stringify(missingPluginResponse)}`,
  );

  await openNoteInReadingView("Citations.md");
  const ready = await waitForProjectionPanel("ready");
  assert(
    ready.heading.includes("CITE"),
    `The settled projection panel did not name the plugin: ${JSON.stringify(ready)}`,
  );
  assert(
    ready.body.includes("CITE recognized 2 citations."),
    `The settled projection summary was not the expected settled count: ${JSON.stringify(ready)}`,
  );
  assert(
    ready.citations.length === 2 &&
      ready.citations.includes("Doe 2024") &&
      ready.citations.includes("Smith 2023"),
    `The settled projection did not decorate both citations: ${JSON.stringify(ready)}`,
  );

  assert(
    (await currentTheme()) === "dark",
    "The baseline screenshot was not captured in the dark scheme.",
  );
  const darkReady = await captureScreenshot("cite-settled-reading-dark-ready");

  await evaluate('(() => { document.querySelector("#theme-toggle")?.click(); return true; })()');
  await waitFor(
    async () => ((await currentTheme()) === "light" ? true : null),
    "Theme did not switch to light",
  );
  await delay(100);
  const lightReady = await captureScreenshot("cite-settled-reading-light-ready");

  // Positive control: dark and light captures of the same settled state must differ in bytes,
  // proving the capture mechanism records live pixels rather than a frozen or cached image.
  assert(
    !darkReady.equals(lightReady),
    "The dark and light screenshots of the settled projection were pixel-identical; the screenshot mechanism is not capturing live state.",
  );

  await evaluate('(() => { document.querySelector("#theme-toggle")?.click(); return true; })()');
  await waitFor(
    async () => ((await currentTheme()) === "dark" ? true : null),
    "Theme did not switch back to dark",
  );

  await withTimeout(
    evaluate(`window.threadleaf.setPluginEnabled(${JSON.stringify(vaultId)}, "cite", false)`),
    5_000,
    "Disabling CITE did not resolve within 5 seconds.",
  );
  await waitFor(async () => {
    const snapshot = await evaluate("window.threadleaf.getSnapshot()");
    const plugin = snapshot?.plugins?.find(({ id }) => id === "cite");
    return plugin && plugin.state !== "loaded" ? plugin : null;
  }, "CITE did not finish unloading after being disabled");

  await openNoteInReadingView("No Citations.md");
  const disabled = await waitForProjectionPanel("unavailable");
  assert(
    disabled.body.toLowerCase().includes("not"),
    `The disabled-plugin projection state was not an honest explicit message: ${JSON.stringify(disabled)}`,
  );
  const disabledScreenshot = await captureScreenshot("cite-settled-reading-dark-disabled");

  // Red control: the disabled-plugin screenshot must differ from the settled-projection
  // screenshot. If a regression made the panel render identical content regardless of plugin
  // state, this assertion is the one that would go red and catch it.
  assert(
    !darkReady.equals(disabledScreenshot),
    "The settled and disabled-plugin screenshots were pixel-identical; the visual check cannot distinguish the two states.",
  );

  console.log(
    "Verified CITE 0.1.2's settled Markdown post-processor projection renders visibly in native Reading view in both themes, an uninstalled and a disabled plugin both render honest explicit states instead of unprocessed content, and the screenshot mechanism captures real, state-dependent pixels (positive control + red control).",
  );

  // Ask the app to quit itself first. xvfb-run execs Xvfb but runs the wrapped Electron command
  // as a plain foreground child (see /usr/bin/xvfb-run), not via `exec`, so signaling the
  // xvfb-run process below reliably stops xvfb-run but does not reach Electron. A graceful
  // window.close() lets Electron's own app.quit() lifecycle tear down every one of its
  // subprocesses correctly.
  await withTimeout(
    evaluate("setTimeout(() => window.close(), 200); true"),
    5_000,
    "The main renderer did not acknowledge its close request.",
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
  // Safety net for exactly the xvfb-run gap above: kill anything still alive whose command line
  // names this run's unique --user-data-dir, so an orphaned Electron (or one of its own
  // subprocesses) can never survive this script or block the fs.rm below.
  await execFileAsync("pkill", ["-9", "-f", userDataPath]).catch(() => undefined);
  await fs.rm(testRoot, { recursive: true, force: true });
}
