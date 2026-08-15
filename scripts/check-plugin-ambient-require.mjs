import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronPath = path.join(projectRoot, "node_modules", ".bin", "electron");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "threadleaf-ambient-require-"));
const htmlPath = path.join(temporaryRoot, "plugin-host.html");
const mainPath = path.join(temporaryRoot, "probe-main.cjs");

const syntheticPluginSource = `
module.exports = (() => {
  const observed = {
    globalThisRequireType: typeof globalThis.require,
    windowRequireType: typeof window.require,
    globalRequireType: typeof global === "undefined" ? "undefined" : typeof global.require,
    childProcessResolved: false,
    childProcessSpawnType: null,
    errorName: null,
    errorMessage: null,
  };
  try {
    const childProcess = globalThis.require("node:child_process");
    observed.childProcessResolved = Boolean(childProcess);
    observed.childProcessSpawnType = typeof childProcess.spawn;
  } catch (error) {
    observed.errorName = error?.name ?? null;
    observed.errorMessage = error?.message ?? String(error);
  }
  return observed;
})();
`;

const rendererProbeSource = `
(() => {
  let sealedRequireCalls = 0;
  const sealedRequire = (request) => {
    sealedRequireCalls += 1;
    throw new Error("sealed require refused: " + request);
  };
  const moduleRecord = { exports: {} };
  const compiled = new Function(
    "exports",
    "require",
    "module",
    "__filename",
    "__dirname",
    ${JSON.stringify(syntheticPluginSource)},
  );
  compiled(
    moduleRecord.exports,
    sealedRequire,
    moduleRecord,
    "/synthetic/main.js",
    "/synthetic",
  );
  return { ...moduleRecord.exports, sealedRequireCalls };
})()
`;

const electronMainSource = `
const fs = require("node:fs");
const { app, BrowserWindow, WebContentsView } = require("electron");

app.commandLine.appendSwitch("ozone-platform", "x11");
app.commandLine.appendSwitch("disable-gpu");

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const view = new WebContentsView({
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: false,
      nodeIntegration: true,
      partition: "threadleaf-plugin-ambient-require-probe",
      sandbox: false,
      spellcheck: false,
      webviewTag: false,
    },
  });
  window.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
  await view.webContents.loadFile(process.env.THREADLEAF_AMBIENT_REQUIRE_HTML);

  const pluginResult = await view.webContents.executeJavaScript(
    ${JSON.stringify(rendererProbeSource)},
  );

  const rendererPid = view.webContents.getOSProcessId();
  const rendererCommandLine = fs
    .readFileSync(\`/proc/\${rendererPid}/cmdline\`)
    .toString("utf8")
    .split("\\0")
    .filter(Boolean);
  process.stdout.write(
    JSON.stringify({
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      webPreferences: {
        contextIsolation: false,
        nodeIntegration: true,
        sandbox: false,
      },
      rendererCommandLineHasX11: rendererCommandLine.some((argument) =>
        argument.includes("--ozone-platform=x11"),
      ),
      rendererCommandLineHasWayland: rendererCommandLine.some((argument) =>
        argument.includes("--ozone-platform=wayland"),
      ),
      rendererCommandLinePlatformArguments: rendererCommandLine.flatMap((argument) =>
        argument.split(" ").filter(
        (argument) => argument.includes("ozone") || argument.includes("platform"),
        ),
      ),
      pluginResult,
    }) + "\\n",
  );
  window.destroy();
  app.quit();
}).catch((error) => {
  process.stderr.write((error?.stack ?? String(error)) + "\\n");
  app.exit(1);
});
`;

async function runProbe() {
  await writeFile(htmlPath, '<!doctype html><meta charset="utf-8"><title>probe</title>\n');
  await writeFile(mainPath, electronMainSource);
  const child = spawn(
    "xvfb-run",
    [
      "-a",
      "-s",
      "-screen 0 1440x840x24 -nolisten tcp",
      electronPath,
      "--ozone-platform=x11",
      "--disable-gpu",
      `--user-data-dir=${path.join(temporaryRoot, "profile")}`,
      mainPath,
    ],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        ELECTRON_OZONE_PLATFORM_HINT: "x11",
        THREADLEAF_AMBIENT_REQUIRE_HTML: htmlPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const { code, signal } = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
  });
  assert.equal(
    code,
    0,
    `Ambient require Electron probe failed (${JSON.stringify({ code, signal })}): ${stderr || stdout}`,
  );
  const receiptLine = stdout
    .trim()
    .split("\n")
    .findLast((line) => line.startsWith("{"));
  assert(receiptLine, `Ambient require Electron probe emitted no JSON receipt: ${stdout}`);
  const receipt = JSON.parse(receiptLine);
  assert.equal(
    receipt.rendererCommandLineHasX11,
    true,
    `Renderer command line did not pin X11: ${JSON.stringify(receipt)}`,
  );
  assert.equal(receipt.rendererCommandLineHasWayland, false);
  assert.equal(receipt.pluginResult.sealedRequireCalls, 0);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

try {
  await runProbe();
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
