import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const appRoot = process.cwd();
const electronPath = path.join(appRoot, "node_modules", ".bin", "electron");
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-publish-export-"));
const vaultPath = path.join(testRoot, "vault");
const userDataPath = path.join(testRoot, "user-data");
const exportPath = path.join(testRoot, "outside", "Published fixture.html");
const screenshotDirectory = process.env.THREADLEAF_PUBLISH_SCREENSHOT_DIR;
const notePath = "Publish Me.md";
const referencePath = "Reference.md";
const imagePath = "assets/pixel.png";
const noteContent = [
  "---",
  "private: FRONTMATTER_MUST_NOT_EXPORT",
  "---",
  "",
  "# Publish Fixture",
  "",
  "A standalone note with **safe Markdown**.",
  "",
  "![Embedded pixel](assets/pixel.png)",
  "",
  "[Official documentation](https://example.com/docs?fixture=1)",
  "",
  "[[Reference|Vault-only reference]]",
  "",
  "![[Reference]]",
  "",
  '<div onclick="alert(1)">Unsafe attribute removed</div>',
  "<script>ACTIVE_SCRIPT_MUST_NOT_EXPORT</script>",
].join("\n");
const referenceContent = "## Embedded Reference\n\nEMBEDDED_BODY_CANARY\n";
const imageBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const output = [];
let child;
let exited;
let cdp;
let phase = "setup";

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
      // Electron or its renderer is still starting.
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
      if (
        message.method === "Runtime.exceptionThrown" ||
        message.method === "Runtime.consoleAPICalled"
      ) {
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

async function descendantRendererCommandLines(rootPid) {
  const entries = await fs.readdir("/proc", { withFileTypes: true });
  const processes = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) {
      continue;
    }
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
      // A short-lived process disappeared between directory and metadata reads.
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

async function assertIsolatedX11Renderer() {
  const commandLines = await waitFor(async () => {
    const lines = await descendantRendererCommandLines(child.pid);
    return lines.length > 0 ? lines : null;
  }, "The isolated launch did not expose a renderer process");
  assert(
    commandLines.every((line) => line.includes("--ozone-platform=x11")),
    "A renderer escaped the explicit X11 virtual-display contract.",
  );
  assert(
    commandLines.every((line) => !line.includes("--ozone-platform=wayland")),
    "A renderer attached to Wayland instead of the virtual X11 display.",
  );
}

async function targetCenter(selector) {
  const target = await evaluate(
    "(() => {" +
      `const element = document.querySelector(${JSON.stringify(selector)});` +
      "if (!(element instanceof Element)) return { error: 'missing' };" +
      "const rect = element.getBoundingClientRect();" +
      "const x = rect.left + rect.width / 2;" +
      "const y = rect.top + rect.height / 2;" +
      "const hit = document.elementFromPoint(x, y);" +
      "return { error: null, x, y, width: rect.width, height: rect.height," +
      "hit: Boolean(hit && (hit === element || element.contains(hit)))," +
      "hidden: element instanceof HTMLElement ? element.hidden || getComputedStyle(element).display === 'none' : false," +
      "disabled: 'disabled' in element ? Boolean(element.disabled) : false };" +
      "})()",
  );
  assert(target && !target.error, `Pointer target is unavailable: ${selector}`);
  assert(!target.hidden && !target.disabled, `Pointer target is not interactive: ${selector}`);
  assert(target.width > 0 && target.height > 0, `Pointer target has no geometry: ${selector}`);
  assert(target.hit, `Pointer target is covered at its center: ${selector}`);
  return target;
}

async function clickSelector(selector) {
  const target = await targetCenter(selector);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await cdp.send("Input.dispatchMouseEvent", {
      type,
      button: type === "mouseMoved" ? "none" : "left",
      buttons: type === "mousePressed" ? 1 : 0,
      clickCount: type === "mouseMoved" ? 0 : 1,
      x: target.x,
      y: target.y,
    });
  }
}

async function runPaletteCommand(commandId) {
  await clickSelector("#command-trigger");
  await cdp.send("Input.insertText", { text: commandId });
  const selector = `[data-command-id="${commandId}"]`;
  await waitFor(
    async () =>
      (await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`))
        ? true
        : null,
    `The command palette did not expose ${commandId}`,
  );
  await clickSelector(selector);
}

async function captureScreenshot(name) {
  const result = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  });
  const destination = screenshotDirectory ? path.join(screenshotDirectory, `${name}.png`) : null;
  if (destination) {
    await fs.mkdir(screenshotDirectory, { recursive: true });
    await fs.writeFile(destination, result.data, "base64");
  }
  return { data: result.data, path: destination };
}

async function setTheme(theme) {
  const current = await evaluate("document.documentElement.dataset.theme");
  if (current !== theme) {
    await clickSelector("#theme-toggle");
    await waitFor(
      async () => (await evaluate("document.documentElement.dataset.theme")) === theme,
      `Threadleaf did not switch to ${theme} mode`,
    );
  }
}

async function exportUiState() {
  return evaluate(`(() => {
    const button = document.querySelector('#export-note');
    const controls = document.querySelector('.editor-controls');
    const toolbar = document.querySelector('.note-toolbar');
    if (!(button instanceof HTMLButtonElement) || !(controls instanceof HTMLElement) || !(toolbar instanceof HTMLElement)) return null;
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      disabled: button.disabled,
      label: button.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
      title: button.title,
      hit: Boolean(hit && (hit === button || button.contains(hit))),
      controlsOverflow: controls.scrollWidth - controls.clientWidth,
      toolbarOverflow: toolbar.scrollWidth - toolbar.clientWidth,
      width: innerWidth,
    };
  })()`);
}

async function waitForExport() {
  return waitFor(async () => {
    if (!(await exists(exportPath))) {
      return null;
    }
    const toast = await evaluate("document.querySelector('#toast')?.textContent ?? ''");
    return toast.includes("Standalone HTML export saved") ? toast : null;
  }, "The standalone HTML export did not finish");
}

async function vaultDigest() {
  const files = [notePath, referencePath, imagePath];
  const values = await Promise.all(
    files.map(async (filePath) => {
      const bytes = await fs.readFile(path.join(vaultPath, filePath));
      return [filePath, createHash("sha256").update(bytes).digest("hex")];
    }),
  );
  return Object.fromEntries(values);
}

try {
  assert(process.platform === "linux", "The publish export check requires Linux and Xvfb.");
  await fs.access(electronPath);
  await Promise.all([
    fs.mkdir(path.join(vaultPath, "assets"), { recursive: true }),
    fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(path.dirname(exportPath), { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(vaultPath, notePath), noteContent, "utf8"),
    fs.writeFile(path.join(vaultPath, referencePath), referenceContent, "utf8"),
    fs.writeFile(path.join(vaultPath, imagePath), imageBytes),
  ]);
  const beforeVault = await vaultDigest();

  phase = "isolated launch";
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
        THREADLEAF_PUBLISH_EXPORT_PATH: exportPath,
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
  await assertIsolatedX11Renderer();
  const ready = await waitFor(async () => {
    const state = await evaluate(`(async () => {
      const snapshot = await window.threadleaf.getSnapshot();
      return {
        ready: snapshot.workspace?.state === 'ready',
        vaultId: snapshot.vault.id,
        vaultPath: snapshot.vault.path,
        activePath: snapshot.workspace?.activeNote?.path ?? null,
        revision: snapshot.workspace?.activeNote?.revision ?? null,
      };
    })()`);
    return state.ready && state.vaultPath === vaultPath && state.activePath === notePath
      ? state
      : null;
  }, "The publish fixture note did not become ready");

  phase = "toolbar export";
  const initialUi = await exportUiState();
  assert(initialUi && !initialUi.disabled, "The visible export control was not enabled.");
  assert(initialUi.label.includes("Export"), "The visible export control lacked its text label.");
  await clickSelector("#export-note");
  await waitForExport();

  phase = "export assertions";
  const [html, stat] = await Promise.all([fs.readFile(exportPath, "utf8"), fs.stat(exportPath)]);
  assert((stat.mode & 0o777) === 0o600, "The exported HTML was not owner-only mode 0600.");
  assert(html.startsWith("<!doctype html>"), "The export is not a standalone HTML document.");
  assert(
    html.includes("Content-Security-Policy") && html.includes("default-src 'none'"),
    "The export lacks its restrictive content policy.",
  );
  assert(html.includes("data:image/png;base64,"), "The local image was not embedded.");
  assert(
    html.includes('href="https://example.com/docs?fixture=1"'),
    "The safe external link was not preserved.",
  );
  assert(
    html.includes("Vault-only reference") && html.includes('class="vault-link"'),
    "The internal vault link was not retained as an honest inert reference.",
  );
  assert(
    html.includes("EMBEDDED_BODY_CANARY"),
    "The embedded note was not frozen into the export.",
  );
  assert(!html.includes(referencePath), "The export leaked an app-added embedded-note path.");
  assert(!html.includes("FRONTMATTER_MUST_NOT_EXPORT"), "Frontmatter leaked into the export.");
  assert(!html.includes("ACTIVE_SCRIPT_MUST_NOT_EXPORT"), "A raw script leaked into the export.");
  assert(!/<script\b/iu.test(html), "The export contains an executable script element.");
  assert(!/\son[a-z]+=/iu.test(html), "The export contains an inline event handler.");
  assert(!/<button\b/iu.test(html), "App-only controls leaked into the export.");
  assert(!html.includes(testRoot), "The export leaked its temporary filesystem root.");
  assert(!html.includes(vaultPath), "The export leaked the active vault path.");
  assert(!html.includes(ready.vaultId), "The export leaked the private vault identity.");
  assert(!html.includes(".obsidian"), "The export leaked Obsidian-private state.");
  assert(
    JSON.stringify(await vaultDigest()) === JSON.stringify(beforeVault),
    "Publishing changed bytes inside the canonical vault.",
  );

  phase = "dirty-note guard";
  await clickSelector(".cm-content");
  await cdp.send("Input.insertText", { text: "x" });
  await waitFor(async () => {
    const state = await exportUiState();
    return state?.disabled ? state : null;
  }, "The export control did not fail closed for an unsaved draft");
  await clickSelector("#revert-note");
  await waitFor(async () => {
    const state = await exportUiState();
    return state && !state.disabled ? state : null;
  }, "The export control did not recover after reverting the draft");

  phase = "stale revision guard";
  await fs.unlink(exportPath);
  const staleResponse = await evaluate(`window.threadleaf.publishNote({
    version: 1,
    expectedVaultId: ${JSON.stringify(ready.vaultId)},
    sourcePath: ${JSON.stringify(notePath)},
    expectedRevision: ${JSON.stringify("0".repeat(64))},
    html: '<!doctype html><html data-threadleaf-publish-version="1"><body>stale</body></html>'
  })`);
  assert(
    staleResponse?.status === "stale-note",
    "The main process accepted a stale note revision.",
  );
  assert(!(await exists(exportPath)), "A stale published-note request created an output file.");

  phase = "command palette export";
  await runPaletteCommand("workspace.export-note-html");
  await waitForExport();

  phase = "app visual verification";
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 840,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await setTheme("dark");
  const darkApp = await captureScreenshot("publish-export-app-dark");
  await setTheme("light");
  const lightApp = await captureScreenshot("publish-export-app-light");
  await evaluate(
    "document.querySelector('#export-note')?.style.setProperty('box-shadow', 'inset 0 0 0 8px rgb(230, 159, 0)'); true",
  );
  const positiveControl = await captureScreenshot("publish-export-positive-control");
  assert(
    positiveControl.data !== lightApp.data,
    "The publish export screenshot positive control did not change captured pixels.",
  );
  await evaluate(
    "document.querySelector('#export-note')?.style.removeProperty('box-shadow'); true",
  );
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 900,
    height: 640,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const narrowUi = await waitFor(async () => {
    const state = await exportUiState();
    return state?.width === 900 ? state : null;
  }, "The narrow publish-export viewport did not apply");
  assert(narrowUi.hit, "The export button was covered in the narrow layout.");
  assert(narrowUi.controlsOverflow <= 0, "The editor controls overflowed in the narrow layout.");
  assert(narrowUi.toolbarOverflow <= 0, "The note toolbar overflowed in the narrow layout.");
  const narrowApp = await captureScreenshot("publish-export-app-narrow");

  phase = "exported document visual verification";
  await cdp.send("Page.navigate", { url: pathToFileURL(exportPath).href });
  await waitFor(
    async () =>
      (await evaluate("Boolean(document.querySelector('.published-shell'))")) ? true : null,
    "The standalone exported document did not render",
  );
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1100,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send("Emulation.setEmulatedMedia", {
    media: "screen",
    features: [{ name: "prefers-color-scheme", value: "light" }],
  });
  const lightDocument = await captureScreenshot("publish-export-document-light");
  await cdp.send("Emulation.setEmulatedMedia", {
    media: "screen",
    features: [{ name: "prefers-color-scheme", value: "dark" }],
  });
  const darkDocument = await captureScreenshot("publish-export-document-dark");
  assert(lightDocument.data !== darkDocument.data, "The standalone document ignored color scheme.");

  phase = "clean exit";
  await evaluate("setTimeout(() => window.close(), 50); true");
  const exit = await Promise.race([
    exited,
    delay(5_000).then(() => ({ code: null, signal: "timeout" })),
  ]);
  assert(exit.code === 0, `Electron did not exit cleanly: ${JSON.stringify(exit)}`);
  child = undefined;

  console.log(
    JSON.stringify({
      mode: (stat.mode & 0o777).toString(8),
      bytes: Buffer.byteLength(html),
      embeddedImage: true,
      embeddedNote: true,
      dirtyGuard: true,
      toolbarControl: true,
      commandPaletteControl: true,
      isolatedX11: true,
      screenshots: [
        darkApp.path,
        lightApp.path,
        narrowApp.path,
        lightDocument.path,
        darkDocument.path,
      ].filter(Boolean),
    }),
  );
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  const logs = output.join("").trim();
  throw new Error(`${phase}: ${logs ? `${detail}\nElectron output:\n${logs}` : detail}`, {
    cause: error,
  });
} finally {
  cdp?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await Promise.race([exited, delay(2_000)]).catch(() => undefined);
  }
  await fs.rm(testRoot, { recursive: true, force: true });
}
