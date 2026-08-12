import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const appRoot = process.cwd();
const packageData = JSON.parse(await fs.readFile(path.join(appRoot, "package.json"), "utf8"));
const baselineCommit = "f142aec538b6925fecd4d9fdbbe374c3a68889cf";
const baselineVersion = "0.1.0-alpha.0";
const candidateVersion = packageData.version;
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-upgrade-rollback-"));
const baselineSource = path.join(testRoot, "baseline-source");
const baselineRelease = path.join(testRoot, "baseline-release");
const candidateRelease = path.join(testRoot, "candidate-release");
const vaultPath = path.join(testRoot, "vault");
const userDataPath = path.join(testRoot, "user-data");
const processMarker = randomUUID();
const dailyPath = "Daily.md";
const linkedPath = "Linked.md";
const initialDaily = "# Daily\n\nPackage rehearsal begins here.";
const linkedContent = "# Linked\n\nThis note must remain byte-for-byte unchanged.";
const baselineMarker = "\n\n- Baseline package wrote this line.";
const candidateMarker = "\n- Candidate package wrote this line.";
const rollbackMarker = "\n- Rolled-back package remains writable.";
const customPaletteBinding = "Mod+Shift+P";
const output = [];
let activeProbe = null;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? appRoot,
      env: { ...process.env, ...options.env },
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    const stdout = [];
    const stderr = [];
    if (options.capture) {
      child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
      child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve({ stdout: stdout.join(""), stderr: stderr.join("") });
      } else {
        reject(
          new Error(
            `${command} exited ${code ?? signal}.\n${stdout.join("")}${stderr.join("")}`.trim(),
          ),
        );
      }
    });
  });
}

async function capture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? appRoot,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      const result = { stdout: stdout.join(""), stderr: stderr.join("") };
      if (code === 0) {
        resolve(result);
      } else {
        reject(
          new Error(
            `${command} exited ${code ?? signal}.\n${result.stdout}${result.stderr}`.trim(),
          ),
        );
      }
    });
  });
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
      // AppImage extraction and the renderer are still starting.
    }
    await delay(75);
  }
  throw new Error("The packaged application did not expose its renderer in time.");
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

async function evaluate(probe, expression) {
  const response = await probe.cdp.send("Runtime.evaluate", {
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

async function waitFor(operation, message, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await operation();
    if (last) {
      return last;
    }
    await delay(75);
  }
  throw new Error(`${message}. Last observation: ${JSON.stringify(last)}`);
}

function packageStateExpression() {
  return `(async () => {
    const [snapshot, settings, update] = await Promise.all([
      window.threadleaf.getSnapshot(),
      window.threadleaf.getSettings(),
      window.threadleaf.getAppUpdate(),
    ]);
    const vaultId = snapshot.vault.id;
    return {
      ready: document.querySelector('#runtime-state')?.textContent === 'Ready' &&
        snapshot.workspace?.state === 'ready',
      vaultPath: snapshot.vault.path,
      activePath: snapshot.workspace?.activeNote?.path ?? null,
      tabs: snapshot.workspace?.tabs.map((tab) => tab.path) ?? [],
      version: update.currentVersion,
      theme: document.documentElement.dataset.theme ?? '',
      savedTheme: vaultId ? settings.settings.appearanceByVault[vaultId]?.colorScheme ?? 'system' : '',
      paletteBinding: settings.settings.keyBindings['ui.command-palette'] ?? null,
      supportControl: Boolean(document.querySelector('#support-bundle-export')),
    };
  })()`;
}

async function launchPackage(executablePath, expectedVersion) {
  const port = await availablePort();
  const child = spawn(
    "xvfb-run",
    [
      "-a",
      executablePath,
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataPath}`,
      "--disable-gpu",
      "--safe-plugins",
    ],
    {
      cwd: appRoot,
      env: {
        ...process.env,
        ELECTRON_OZONE_PLATFORM_HINT: "x11",
        THREADLEAF_UPGRADE_ROLLBACK_RUN: processMarker,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const started = new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      output.push(String(chunk));
      if (output.length > 160) {
        output.shift();
      }
    });
  }
  await started;
  const target = await waitForMainTarget(port, Date.now() + 30_000);
  const probe = { cdp: connectCdp(target.webSocketDebuggerUrl), child, exited };
  await probe.cdp.send("Page.enable");
  const state = await waitFor(
    async () => {
      const observed = await evaluate(probe, packageStateExpression());
      return observed.ready && observed.vaultPath === vaultPath ? observed : null;
    },
    `Threadleaf ${expectedVersion} did not restore the selected vault`,
    30_000,
  );
  assert(
    state.version === expectedVersion,
    `Expected package ${expectedVersion}, observed ${state.version}.`,
  );
  activeProbe = probe;
  return { probe, state };
}

async function closePackage(probe) {
  try {
    await evaluate(probe, "setTimeout(() => window.close(), 0); true");
  } catch {
    // The final CDP response can race a clean window close.
  }
  const exit = await Promise.race([
    probe.exited,
    delay(20_000).then(() => ({ code: null, signal: "timeout" })),
  ]);
  probe.cdp.close();
  assert(exit.code === 0, `Packaged Threadleaf did not exit cleanly: ${JSON.stringify(exit)}.`);
  activeProbe = null;
}

async function openNote(probe, notePath) {
  await evaluate(probe, `window.threadleaf.openNote(${JSON.stringify(notePath)})`);
  return waitFor(async () => {
    const state = await evaluate(probe, packageStateExpression());
    return state.activePath === notePath ? state : null;
  }, `Threadleaf did not open ${notePath}`);
}

async function pressKey(probe, key, code, modifiers = 0) {
  await probe.cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code,
    modifiers,
    windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : undefined,
  });
  await probe.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
}

async function appendAndSave(probe, marker, expectedBytes) {
  await evaluate(
    probe,
    `(() => {
    const editor =
      document.querySelector('[data-pane-id="primary"] .cm-content') ??
      document.querySelector('.cm-content');
    if (!(editor instanceof HTMLElement)) throw new Error('CodeMirror content is unavailable.');
    editor.focus();
    return true;
  })()`,
  );
  await pressKey(probe, "End", "End", 2);
  await probe.cdp.send("Input.insertText", { text: marker });
  await waitFor(async () => {
    const state = await evaluate(
      probe,
      `(() => ({
        editState: document.querySelector('#edit-state')?.textContent ?? '',
        draftState: document.querySelector('#edit-state')?.getAttribute('data-draft-state') ?? '',
      }))()`,
    );
    return state.editState === "Unsaved" && state.draftState === "saved" ? state : null;
  }, "The package transition edit was not protected before save");
  await pressKey(probe, "s", "KeyS", 2);
  await waitFor(
    async () =>
      (await evaluate(probe, "document.querySelector('#edit-state')?.textContent ?? ''")) ===
      "Saved",
    "The package transition edit did not save",
  );
  assert(
    (await fs.readFile(path.join(vaultPath, dailyPath), "utf8")) === expectedBytes,
    "The saved note bytes differ from the package transition edit.",
  );
}

async function switchTheme(probe, expectedTheme) {
  await evaluate(probe, "document.querySelector('#theme-toggle')?.click(); true");
  return waitFor(async () => {
    const state = await evaluate(probe, packageStateExpression());
    return state.theme === expectedTheme && state.savedTheme === expectedTheme ? state : null;
  }, `Threadleaf did not persist ${expectedTheme} appearance`);
}

async function readPrivateState(vaultId, expectedTheme) {
  const [settingsText, selectionText, workspaceText] = await Promise.all([
    fs.readFile(path.join(userDataPath, "settings.json"), "utf8"),
    fs.readFile(path.join(userDataPath, "workspace-selection.json"), "utf8"),
    fs.readFile(path.join(userDataPath, "workspaces", `${vaultId}.json`), "utf8"),
  ]);
  const settings = JSON.parse(settingsText);
  const selection = JSON.parse(selectionText);
  const workspace = JSON.parse(workspaceText);
  assert(settings.version === 4, "Private settings lost their schema version.");
  assert(
    settings.keyBindings["ui.command-palette"] === customPaletteBinding,
    "The custom command-palette binding was lost.",
  );
  assert(
    settings.appearanceByVault[vaultId]?.colorScheme === expectedTheme,
    `Private appearance settings did not retain ${expectedTheme}.`,
  );
  assert(
    settings.pluginsByVault[vaultId]?.compatibilityMode === "restricted",
    "Private plugin mode was lost.",
  );
  assert(
    selection.version === 1 && selection.vaultPath === vaultPath,
    "The selected vault was not preserved.",
  );
  assert(workspace.version === 1 && workspace.vaultId === vaultId, "Workspace state was lost.");
  for (const filePath of [
    path.join(userDataPath, "settings.json"),
    path.join(userDataPath, "workspace-selection.json"),
    path.join(userDataPath, "workspaces", `${vaultId}.json`),
  ]) {
    const mode = (await fs.stat(filePath)).mode & 0o777;
    assert(mode === 0o600, `Private state mode was ${mode.toString(8)} instead of 600.`);
  }
  return workspace;
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const input = createReadStream(filePath);
    input.on("data", (chunk) => hash.update(chunk));
    input.once("error", reject);
    input.once("end", resolve);
  });
  return hash.digest("hex");
}

async function soleAppImage(directory) {
  const names = (await fs.readdir(directory)).filter((name) => name.endsWith(".AppImage"));
  assert(names.length === 1, `Expected one AppImage in the package output, found ${names.length}.`);
  const executablePath = path.join(directory, names[0]);
  const stat = await fs.stat(executablePath);
  assert(stat.isFile() && (stat.mode & 0o111) !== 0, "The AppImage is missing or not executable.");
  return executablePath;
}

async function assertPackageVersion(executablePath, expectedVersion) {
  const result = await capture("xvfb-run", ["-a", executablePath, "--version"], {
    env: { ELECTRON_OZONE_PLATFORM_HINT: "x11" },
  });
  assert(
    result.stdout === `${expectedVersion}\n`,
    `AppImage version was ${JSON.stringify(result.stdout.trim())}, expected ${expectedVersion}.`,
  );
}

async function buildPackages() {
  await run("git", ["cat-file", "-e", `${baselineCommit}^{commit}`], { capture: true });
  await fs.mkdir(baselineSource, { recursive: true, mode: 0o700 });
  const archivePath = path.join(testRoot, "baseline.tar");
  await run("git", ["archive", "--format=tar", `--output=${archivePath}`, baselineCommit], {
    capture: true,
  });
  await run("tar", ["-xf", archivePath, "-C", baselineSource], { capture: true });
  await fs.unlink(archivePath);
  await fs.symlink(path.join(appRoot, "node_modules"), path.join(baselineSource, "node_modules"));

  await run(path.join(appRoot, "node_modules", ".bin", "tsup"), [], { cwd: baselineSource });
  await run(path.join(appRoot, "node_modules", ".bin", "vite"), ["build"], {
    cwd: baselineSource,
  });
  await run(process.execPath, [path.join(baselineSource, "scripts", "check-built-app.mjs")], {
    cwd: baselineSource,
  });
  const electronBuilder = path.join(appRoot, "node_modules", ".bin", "electron-builder");
  await run(
    electronBuilder,
    [
      "--linux",
      "AppImage",
      "--x64",
      "--publish",
      "never",
      `--config.directories.output=${baselineRelease}`,
      `--config.extraMetadata.version=${baselineVersion}`,
    ],
    { cwd: baselineSource },
  );

  await run("pnpm", ["run", "build"]);
  await run(electronBuilder, [
    "--linux",
    "AppImage",
    "--x64",
    "--publish",
    "never",
    `--config.directories.output=${candidateRelease}`,
  ]);

  const [baselineAppImage, candidateAppImage] = await Promise.all([
    soleAppImage(baselineRelease),
    soleAppImage(candidateRelease),
  ]);
  await Promise.all([
    assertPackageVersion(baselineAppImage, baselineVersion),
    assertPackageVersion(candidateAppImage, candidateVersion),
  ]);
  assert(
    (await sha256(baselineAppImage)) !== (await sha256(candidateAppImage)),
    "The baseline and candidate AppImages are byte-identical.",
  );
  return { baselineAppImage, candidateAppImage };
}

async function markedProcessIds() {
  const entries = await fs.readdir("/proc");
  const marker = Buffer.from(`THREADLEAF_UPGRADE_ROLLBACK_RUN=${processMarker}\0`);
  const ids = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    try {
      if ((await fs.readFile(`/proc/${entry}/environ`)).includes(marker)) {
        ids.push(Number(entry));
      }
    } catch {
      // Processes can leave while /proc is being inspected.
    }
  }
  return ids;
}

async function terminateMarkedProcesses() {
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const ids = await markedProcessIds();
      if (ids.length === 0) {
        return;
      }
      for (const id of ids) {
        try {
          process.kill(id, signal);
        } catch {
          // The process already exited.
        }
      }
      await delay(100);
    }
  }
  assert(
    (await markedProcessIds()).length === 0,
    "Could not stop the package rehearsal processes.",
  );
}

try {
  assert(process.platform === "linux", "The upgrade and rollback rehearsal requires Linux.");
  assert(process.arch === "x64", "The upgrade and rollback rehearsal currently requires x64.");
  assert(candidateVersion !== baselineVersion, "Baseline and candidate versions must differ.");
  await fs.access(path.join(appRoot, "node_modules", ".bin", "electron-builder"));
  await Promise.all([
    fs.mkdir(vaultPath, { recursive: true, mode: 0o700 }),
    fs.mkdir(userDataPath, { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(vaultPath, dailyPath), initialDaily, { mode: 0o600 }),
    fs.writeFile(path.join(vaultPath, linkedPath), linkedContent, { mode: 0o600 }),
  ]);
  const canonicalVaultPath = await fs.realpath(vaultPath);
  assert(
    canonicalVaultPath === vaultPath,
    "The rehearsal vault path did not canonicalize exactly.",
  );
  const vaultId = createHash("sha256").update(canonicalVaultPath).digest("hex");
  await Promise.all([
    fs.writeFile(
      path.join(userDataPath, "workspace-selection.json"),
      `${JSON.stringify({ version: 1, vaultPath }, null, 2)}\n`,
      { mode: 0o600 },
    ),
    fs.writeFile(
      path.join(userDataPath, "settings.json"),
      `${JSON.stringify(
        {
          version: 4,
          keyBindings: { "ui.command-palette": customPaletteBinding },
          appearanceByVault: {
            [vaultId]: { colorScheme: "dark", themeId: null, enabledSnippetIds: [] },
          },
          pluginsByVault: {
            [vaultId]: {
              compatibilityMode: "restricted",
              enabledPluginIds: [],
              capabilityGrantsByPlugin: {},
            },
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    ),
  ]);

  const { baselineAppImage, candidateAppImage } = await buildPackages();

  const baseline = await launchPackage(baselineAppImage, baselineVersion);
  assert(!baseline.state.supportControl, "The baseline unexpectedly contains candidate UI.");
  assert(baseline.state.theme === "dark", "The baseline did not restore the dark appearance.");
  assert(
    baseline.state.paletteBinding === customPaletteBinding,
    "The baseline did not load the custom hotkey.",
  );
  await openNote(baseline.probe, dailyPath);
  const afterBaseline = `${initialDaily}${baselineMarker}`;
  await appendAndSave(baseline.probe, baselineMarker, afterBaseline);
  await switchTheme(baseline.probe, "light");
  await closePackage(baseline.probe);
  let workspace = await readPrivateState(vaultId, "light");
  assert(workspace.activePath === dailyPath, "Baseline workspace did not retain the active note.");

  const candidate = await launchPackage(candidateAppImage, candidateVersion);
  assert(
    candidate.state.supportControl,
    "The candidate package did not expose its new support UI.",
  );
  assert(candidate.state.activePath === dailyPath, "Upgrade did not restore the active note.");
  assert(candidate.state.tabs.includes(dailyPath), "Upgrade did not restore the open tab.");
  assert(candidate.state.theme === "light", "Upgrade did not preserve the light appearance.");
  assert(
    candidate.state.paletteBinding === customPaletteBinding,
    "Upgrade did not preserve the custom hotkey.",
  );
  const afterCandidate = `${afterBaseline}${candidateMarker}`;
  await appendAndSave(candidate.probe, candidateMarker, afterCandidate);
  await openNote(candidate.probe, linkedPath);
  await switchTheme(candidate.probe, "dark");
  await closePackage(candidate.probe);
  workspace = await readPrivateState(vaultId, "dark");
  assert(
    workspace.activePath === linkedPath,
    "Candidate workspace did not retain its active note.",
  );

  const rollback = await launchPackage(baselineAppImage, baselineVersion);
  assert(!rollback.state.supportControl, "Rollback did not restore the baseline package behavior.");
  assert(
    rollback.state.activePath === linkedPath,
    "Rollback did not restore the candidate workspace.",
  );
  assert(
    rollback.state.tabs.includes(dailyPath) && rollback.state.tabs.includes(linkedPath),
    "Rollback did not preserve the candidate tab set.",
  );
  assert(rollback.state.theme === "dark", "Rollback did not preserve the candidate appearance.");
  assert(
    rollback.state.paletteBinding === customPaletteBinding,
    "Rollback did not preserve the custom hotkey.",
  );
  await openNote(rollback.probe, dailyPath);
  const finalDaily = `${afterCandidate}${rollbackMarker}`;
  await appendAndSave(rollback.probe, rollbackMarker, finalDaily);
  await closePackage(rollback.probe);
  workspace = await readPrivateState(vaultId, "dark");

  assert(
    (await fs.readFile(path.join(vaultPath, dailyPath), "utf8")) === finalDaily,
    "Final daily-note bytes were not preserved.",
  );
  assert(
    (await fs.readFile(path.join(vaultPath, linkedPath), "utf8")) === linkedContent,
    "The untouched linked note changed during package transitions.",
  );
  assert(
    JSON.stringify((await fs.readdir(vaultPath)).sort()) ===
      JSON.stringify([dailyPath, linkedPath].sort()),
    "Threadleaf added an application-private path to the vault.",
  );
  assert(workspace.activePath === dailyPath, "Rollback did not remain workspace-writable.");

  console.log(
    JSON.stringify({
      verified: true,
      sequence: [baselineVersion, candidateVersion, baselineVersion],
      distinctPackages: true,
      noteWrites: 3,
      unchangedNotes: 1,
      selectedVaultPreserved: true,
      privateSettingsPreserved: true,
      workspacePreserved: true,
      rollbackWritable: true,
      vaultPrivateEntries: 0,
    }),
  );
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  const logs = output.join("").trim();
  throw new Error(logs ? `${detail}\nElectron output:\n${logs}` : detail, { cause: error });
} finally {
  if (activeProbe) {
    activeProbe.cdp.close();
    activeProbe.child.kill("SIGTERM");
  }
  await terminateMarkedProcesses();
  await fs.rm(testRoot, { recursive: true, force: true });
}
