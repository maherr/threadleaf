import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const appRoot = process.cwd();
const electronPath = path.join(appRoot, "node_modules", ".bin", "electron");
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-appearance-watcher-"));
const vaultPath = path.join(testRoot, "vault");
const userDataPath = path.join(testRoot, "user-data");
const screenshotDirectory =
  process.env.THREADLEAF_APPEARANCE_WATCH_SCREENSHOT_DIR ?? path.join(testRoot, "screenshots");
const output = [];
let child;
let exited;
let cdp;
let phase = "setup";

const initialTheme = "#vault-name { color: rgb(0, 114, 178); }\n";
const changedTheme = "#vault-name { color: rgb(0, 158, 115); }\n";
const restoredTheme = "#vault-name { color: rgb(0, 114, 178); }\n";
const initialSnippet = "#theme-toggle { border-color: rgb(230, 159, 0); }\n";
const changedSnippet = "#theme-toggle { border-color: rgb(0, 114, 178); }\n";
const restoredSnippet = "#theme-toggle { border-color: rgb(230, 159, 0); }\n";
const noteBytes = Buffer.from(
  "# Appearance Watch Fixture\n\nThis note must remain byte-exact.\n",
  "utf8",
);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
    throw new Error("Could not reserve an isolated CDP port.");
  }
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitForMainTarget(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
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
      // Electron is still starting.
    }
    await delay(50);
  }
  throw new Error("Threadleaf did not expose its isolated Electron renderer in time.");
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
      if (message.method === "Runtime.exceptionThrown") {
        output.push(`[CDP ${message.method}] ${JSON.stringify(message.params)}\n`);
      }
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
        THREADLEAF_SAFE_PLUGINS: "1",
        THREADLEAF_VAULT_PATH: vaultPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      output.push(String(chunk));
      if (output.length > 160) {
        output.shift();
      }
    });
  }
  const target = await waitForMainTarget(port);
  cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
}

async function closeApplication() {
  if (!child) {
    return;
  }
  try {
    await evaluate("setTimeout(() => window.close(), 50); true");
  } catch {
    // The renderer can disappear before CDP returns.
  }
  cdp?.close();
  cdp = undefined;
  const result = await Promise.race([
    exited,
    delay(5_000).then(() => ({ code: null, signal: "timeout" })),
  ]);
  assert(result.code === 0, `Electron did not exit cleanly: ${JSON.stringify(result)}`);
  child = undefined;
  exited = undefined;
}

async function captureScreenshot(name) {
  const screenshot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  });
  const targetPath = path.join(screenshotDirectory, `${name}.png`);
  await fs.mkdir(screenshotDirectory, { recursive: true });
  await fs.writeFile(targetPath, Buffer.from(screenshot.data, "base64"));
  const stat = await fs.stat(targetPath);
  assert(stat.size > 1_000, `Captured screenshot ${name} is unexpectedly small.`);
  return targetPath;
}

async function waitForReady() {
  return waitFor(async () => {
    const state = await evaluate(
      "(async () => { const snapshot = await window.threadleaf.getSnapshot(); return { ready: snapshot.workspace?.state === 'ready', path: snapshot.vault?.path ?? '', id: snapshot.vault?.id ?? null }; })()",
    );
    return state.ready && state.path === vaultPath && state.id ? state : null;
  }, "The disposable appearance vault did not become ready");
}

async function readAppearance() {
  return evaluate(
    "(() => ({" +
      "theme: getComputedStyle(document.querySelector('#vault-name')).color," +
      "snippet: getComputedStyle(document.querySelector('#theme-toggle')).borderTopColor," +
      "warnings: [...document.querySelectorAll('#appearance-warnings li')].map((item) => item.textContent ?? '')," +
      "message: document.querySelector('#appearance-status')?.textContent ?? ''," +
      "scheme: document.documentElement.dataset.theme ?? ''" +
      "}))()",
  );
}

async function atomicWrite(targetPath, content) {
  const temporaryPath = `${targetPath}.atomic-save`;
  await fs.writeFile(temporaryPath, content, "utf8");
  await fs.rename(temporaryPath, targetPath);
}

async function fileMap(rootPath) {
  const files = new Map();
  async function walk(currentPath, relativePath = "") {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const childRelativePath = relativePath ? path.join(relativePath, entry.name) : entry.name;
      const childPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(childPath, childRelativePath);
      } else if (entry.isFile()) {
        files.set(childRelativePath.replaceAll(path.sep, "/"), await fs.readFile(childPath));
      }
    }
  }
  await walk(rootPath);
  return files;
}

try {
  assert(
    process.platform === "linux",
    "The appearance watcher integration check requires Linux/Xvfb.",
  );
  await fs.access(electronPath);
  const themePath = path.join(vaultPath, ".obsidian", "themes", "Live", "theme.css");
  const snippetPath = path.join(vaultPath, ".obsidian", "snippets", "live.css");
  await fs.mkdir(path.dirname(themePath), { recursive: true });
  await fs.mkdir(path.dirname(snippetPath), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(vaultPath, "Welcome.md"), noteBytes),
    fs.writeFile(themePath, initialTheme, "utf8"),
    fs.writeFile(snippetPath, initialSnippet, "utf8"),
  ]);

  phase = "isolated X11 launch";
  await launchApplication();
  const runtime = await waitForReady();
  const vaultId = runtime.id;
  const setAppearance = async (colorScheme) =>
    evaluate(
      `(async () => window.threadleaf.setVaultAppearance(${JSON.stringify(vaultId)}, ${JSON.stringify(
        {
          colorScheme,
          themeId: "obsidian-theme:Live",
          enabledSnippetIds: ["obsidian-snippet:live.css"],
        },
      )}))()`,
    );

  phase = "selected appearance setup";
  await setAppearance("dark");
  await waitFor(async () => {
    const appearance = await readAppearance();
    return appearance.theme === "rgb(0, 114, 178)" && appearance.snippet === "rgb(230, 159, 0)"
      ? appearance
      : null;
  }, "The selected theme and snippet were not initially applied");

  phase = "live external theme and snippet edits";
  await atomicWrite(themePath, changedTheme);
  await atomicWrite(snippetPath, changedSnippet);
  await waitFor(async () => {
    const appearance = await readAppearance();
    return appearance.theme === "rgb(0, 158, 115)" && appearance.snippet === "rgb(0, 114, 178)"
      ? appearance
      : null;
  }, "External CSS edits did not reach computed styles without pressing Reload");

  phase = "selected theme deletion diagnostic";
  await fs.rm(themePath);
  await waitFor(async () => {
    const appearance = await readAppearance();
    return appearance.warnings.some((warning) => warning.includes("selected custom theme"))
      ? appearance
      : null;
  }, "Deleting the selected theme did not surface its existing diagnostic");
  const settingsAfterDelete = await evaluate("window.threadleaf.getSettings()");
  assert(
    settingsAfterDelete.settings.appearanceByVault[vaultId]?.themeId === "obsidian-theme:Live",
    "Theme deletion rewrote the private selection instead of preserving it.",
  );

  phase = "invalid selected snippet diagnostic";
  await atomicWrite(snippetPath, '@import url("https://example.test/blocked.css");');
  await waitFor(async () => {
    const appearance = await readAppearance();
    return appearance.warnings.some((warning) => warning.includes("Snippet live was not applied"))
      ? appearance
      : null;
  }, "Invalid selected snippet did not surface its existing diagnostic");

  phase = "self-healing restoration";
  await atomicWrite(themePath, restoredTheme);
  await atomicWrite(snippetPath, restoredSnippet);
  await waitFor(async () => {
    const appearance = await readAppearance();
    return appearance.theme === "rgb(0, 114, 178)" &&
      appearance.snippet === "rgb(230, 159, 0)" &&
      appearance.warnings.length === 0
      ? appearance
      : null;
  }, "Restored valid appearance files did not self-heal");

  phase = "dark and light visual captures";
  await setAppearance("dark");
  await waitFor(
    async () => ((await readAppearance()).scheme === "dark" ? true : null),
    "Dark scheme failed",
  );
  const darkScreenshot = await captureScreenshot("appearance-watch-dark");
  await setAppearance("light");
  await waitFor(
    async () => ((await readAppearance()).scheme === "light" ? true : null),
    "Light scheme failed",
  );
  const lightScreenshot = await captureScreenshot("appearance-watch-light");
  assert(
    darkScreenshot !== lightScreenshot,
    "Dark and light screenshots used the same output path.",
  );

  phase = "vault byte and private-state boundary";
  const actualFiles = await fileMap(vaultPath);
  const expectedFiles = new Map([
    ["Welcome.md", noteBytes],
    [".obsidian/themes/Live/theme.css", Buffer.from(restoredTheme, "utf8")],
    [".obsidian/snippets/live.css", Buffer.from(restoredSnippet, "utf8")],
  ]);
  assert(
    JSON.stringify([...actualFiles.keys()].sort()) ===
      JSON.stringify([...expectedFiles.keys()].sort()),
    `Appearance watching wrote an unexpected vault file: ${JSON.stringify([...actualFiles.keys()].sort())}`,
  );
  for (const [relativePath, expectedBytes] of expectedFiles) {
    assert(
      Buffer.compare(actualFiles.get(relativePath), expectedBytes) === 0,
      `Unexpected bytes in ${relativePath}.`,
    );
  }
  assert(
    ![...actualFiles.keys()].some((relativePath) => relativePath.includes(".threadleaf")),
    "Threadleaf-private state appeared inside the disposable vault.",
  );

  await closeApplication();
  process.stdout.write(
    `Appearance watcher Electron check passed. Screenshots: ${darkScreenshot}, ${lightScreenshot}\n`,
  );
} catch (error) {
  process.stderr.write(
    `Appearance watcher Electron check failed during ${phase}: ${
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    }\n${output.join("")}\n`,
  );
  process.exitCode = 1;
  try {
    await closeApplication();
  } catch (closeError) {
    process.stderr.write(`Could not close Electron: ${String(closeError)}\n`);
  }
} finally {
  await fs.rm(testRoot, { recursive: true, force: true });
}
