import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const appRoot = process.cwd();
const packageData = JSON.parse(await fs.readFile(path.join(appRoot, "package.json"), "utf8"));
const platform = process.platform;
const architecture = process.env.THREADLEAF_PACKAGE_ARCH ?? process.arch;
const releasePath = path.resolve(process.env.THREADLEAF_PACKAGE_OUTPUT ?? "release");
const evidencePath = path.resolve(
  process.env.THREADLEAF_LIFECYCLE_ARTIFACT_DIR ??
    path.join(os.tmpdir(), "threadleaf-lifecycle-evidence"),
);
// Both macOS (/var -> /private/var) and Windows (long names -> 8.3 aliases) may expose the
// platform temp directory through more than one lexical spelling. The packaged app correctly
// reports the canonical vault path, so seed every lifecycle path from that same identity.
const canonicalTemporaryDirectory = await fs.realpath(os.tmpdir());
const scratchPath = await fs.mkdtemp(
  path.join(canonicalTemporaryDirectory, "threadleaf-installer-lifecycle-"),
);
const baselineReleasePath = path.join(scratchPath, "baseline-release");
const installPath = path.join(scratchPath, "installed");
const vaultPath = path.join(scratchPath, "vault");
const isolatedHomePath = path.join(scratchPath, "home");
const isolatedAppDataPath =
  platform === "win32"
    ? path.join(scratchPath, "appdata", "roaming")
    : path.join(isolatedHomePath, "Library", "Application Support");
const isolatedLocalAppDataPath = path.join(scratchPath, "appdata", "local");
const userDataPath = path.join(isolatedAppDataPath, "Threadleaf");
const processMarker = randomUUID();
const processMarkerArgument = `--threadleaf-lifecycle-marker=${processMarker}`;
const candidateVersion = packageData.version;
const baselineVersion = process.env.THREADLEAF_LIFECYCLE_BASELINE_VERSION ?? "0.1.0-alpha.0";
const lifecycleNotePath = "Lifecycle.md";
const dailyNotePath = "Daily.md";
const initialLifecycleContent = "# Lifecycle\n\nThe baseline package created this note.\n";
const baselineEdit = "Baseline edit survives a restart.\n";
const candidateEdit = "Candidate edit survives an upgrade.\n";
const rollbackEdit = "Rollback edit remains writable.\n";
const linkedContent = "# Linked\n\nThis note must remain byte-for-byte unchanged.\n";
const commandLog = [];
const launchedProcesses = new Set();
let launchMarkerObserved = false;
let inPlaceReplacementChecks = 0;
let activeProbe = null;
let evidenceWritten = false;
let windowsShortcutPath = null;
const lifecycleEnvironment =
  platform === "win32"
    ? {
        APPDATA: isolatedAppDataPath,
        HOMEDRIVE: "C:",
        HOMEPATH: isolatedHomePath,
        LOCALAPPDATA: isolatedLocalAppDataPath,
        USERPROFILE: isolatedHomePath,
      }
    : {
        HOME: isolatedHomePath,
      };

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sanitize(value) {
  let result = String(value)
    .replaceAll(appRoot, "<repo>")
    .replaceAll(scratchPath, "<scratch>")
    .replaceAll(releasePath, "<release>");
  for (const [valueToHide, replacement] of [
    [process.env.HOME, "<home>"],
    [process.env.USERPROFILE, "<profile>"],
    [process.env.APPDATA, "<appdata>"],
    [process.env.LOCALAPPDATA, "<localappdata>"],
  ]) {
    if (valueToHide) {
      result = result.replaceAll(valueToHide, replacement);
    }
  }
  return result;
}

function commandName(command) {
  return path.basename(command).replace(/\.cmd$/u, "");
}

async function run(command, args, options = {}) {
  const output = [];
  commandLog.push(`${commandName(command)} ${args.map((value) => sanitize(value)).join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? appRoot,
      env: { ...process.env, ...options.env },
      stdio: options.capture === false ? "inherit" : ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: options.shell ?? false,
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${commandName(command)} timed out.`));
    }, options.timeout ?? 600_000);
    if (options.capture !== false) {
      child.stdout.on("data", (chunk) => output.push(String(chunk)));
      child.stderr.on("data", (chunk) => output.push(String(chunk)));
    }
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      const text = output.join("");
      if (code === 0) {
        resolve(text);
      } else {
        reject(
          new Error(`${commandName(command)} exited ${code ?? signal}.\n${sanitize(text)}`.trim()),
        );
      }
    });
  });
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function sha256(filePath) {
  const digest = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return digest.digest("hex");
}

async function digest(filePath, algorithm, encoding) {
  const hash = createHash(algorithm);
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest(encoding);
}

async function treeDigest(rootPath) {
  const digest = createHash("sha256");
  let bytes = 0;
  async function visit(currentPath, relativePath) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const childRelativePath = path.join(relativePath, entry.name).replaceAll(path.sep, "/");
      const childPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        digest.update(`dir\0${childRelativePath}\0`);
        await visit(childPath, childRelativePath);
      } else if (entry.isFile()) {
        digest.update(`file\0${childRelativePath}\0`);
        const contents = await fs.readFile(childPath);
        bytes += contents.byteLength;
        digest.update(contents);
      } else if (entry.isSymbolicLink()) {
        digest.update(`link\0${childRelativePath}\0${await fs.readlink(childPath)}\0`);
      } else {
        throw new Error(`Unsupported package entry type at ${childRelativePath}.`);
      }
    }
  }
  await visit(rootPath, "");
  return { sha256: digest.digest("hex"), bytes };
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string", "Could not reserve a loopback CDP port.");
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
          (entry) =>
            entry.type === "page" &&
            typeof entry.url === "string" &&
            entry.url.endsWith("/dist/renderer/index.html"),
        );
        if (target?.webSocketDebuggerUrl) {
          return target;
        }
      }
    } catch {
      // The native package is still starting.
    }
    await delay(100);
  }
  throw new Error("The packaged renderer did not expose a CDP target.");
}

async function processRows() {
  if (platform === "win32") {
    const powershell =
      "$ErrorActionPreference = 'Stop'; " +
      "Get-CimInstance Win32_Process | " +
      "Select-Object ProcessId, ParentProcessId, CommandLine | " +
      "ConvertTo-Json -Compress";
    const output = await run(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", powershell],
      { timeout: 30_000 },
    );
    const parsed = JSON.parse(output);
    return (Array.isArray(parsed) ? parsed : [parsed])
      .filter((row) => Number.isInteger(row?.ProcessId))
      .map((row) => ({
        pid: row.ProcessId,
        ppid: Number.isInteger(row.ParentProcessId) ? row.ParentProcessId : null,
        command: String(row.CommandLine ?? ""),
      }));
  }

  const output = await run("ps", ["-eww", "-A", "-o", "pid=,ppid=,command="], {
    timeout: 30_000,
  });
  return output
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/u))
    .filter((match) => match !== null)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }));
}

function descendantPids(rows, roots) {
  const descendants = new Set(roots.filter((pid) => Number.isInteger(pid)));
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (row.ppid !== null && descendants.has(row.ppid) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  return [...descendants];
}

async function cleanupMarkedProcesses() {
  const knownRoots = () =>
    [...launchedProcesses]
      .filter((child) => child.exitCode === null && child.signalCode === null)
      .map((child) => child.pid)
      .filter(Boolean);
  let markerObserved = false;
  const killed = new Set();
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    const rows = await processRows();
    const markerRoots = rows
      .filter(
        (row) => row.command.includes(processMarkerArgument) || row.command.includes(processMarker),
      )
      .map((row) => row.pid);
    markerObserved ||= markerRoots.length > 0;
    launchMarkerObserved ||= markerObserved;
    const pids = descendantPids(rows, [...new Set([...knownRoots(), ...markerRoots])]);
    if (pids.length === 0) {
      return { markerObserved, killed: [...killed] };
    }
    for (const pid of pids.sort((left, right) => right - left)) {
      if (pid === process.pid) {
        continue;
      }
      if (platform === "win32") {
        await run("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 30_000 }).catch(
          () => undefined,
        );
      } else {
        try {
          process.kill(pid, signal);
        } catch {
          // The process exited between the process table read and the signal.
        }
      }
      killed.add(pid);
    }
    await delay(signal === "SIGTERM" ? 250 : 100);
  }
  const remaining = (await processRows()).filter(
    (row) => row.command.includes(processMarkerArgument) || row.command.includes(processMarker),
  );
  assert(remaining.length === 0, `Lifecycle launch marker left ${remaining.length} process(es).`);
  return { markerObserved, killed: [...killed] };
}

async function observeLaunchMarker() {
  const rows = await processRows();
  const observed = rows.some(
    (row) => row.command.includes(processMarkerArgument) || row.command.includes(processMarker),
  );
  assert(observed, "Packaged process did not expose its lifecycle launch marker.");
  launchMarkerObserved = true;
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
      response.exceptionDetails.exception?.description ?? "Packaged renderer evaluation failed.",
    );
  }
  return response.result?.value;
}

async function waitFor(operation, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await operation();
    if (last) {
      return last;
    }
    await delay(100);
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
    return {
      ready: snapshot.workspace?.state === "ready" && document.querySelector("#runtime-state")?.textContent === "Ready",
      vaultPath: snapshot.vault.path,
      vaultId: snapshot.vault.id,
      activePath: snapshot.workspace?.activeNote?.path ?? null,
      activeRevision: snapshot.workspace?.activeNote?.revision ?? null,
      tabs: snapshot.workspace?.tabs.map((tab) => tab.path) ?? [],
      version: update.currentVersion,
      updateDisabledReason: update.disabledReason,
      paletteBinding: settings.settings.keyBindings["ui.command-palette"] ?? null,
      appearance: snapshot.vault.id ? settings.settings.appearanceByVault[snapshot.vault.id]?.colorScheme ?? "system" : "",
      supportControl: Boolean(document.querySelector("#support-bundle-export")),
    };
  })()`;
}

async function captureScreenshot(probe, name) {
  if (!probe) {
    return;
  }
  try {
    await fs.mkdir(evidencePath, { recursive: true, mode: 0o700 });
    const screenshot = await probe.cdp.send("Page.captureScreenshot", { format: "png" });
    if (screenshot.data) {
      await fs.writeFile(
        path.join(evidencePath, `${name}.png`),
        Buffer.from(screenshot.data, "base64"),
        {
          mode: 0o600,
        },
      );
    }
  } catch (error) {
    commandLog.push(`screenshot ${name} unavailable: ${sanitize(error)}`);
  }
}

function executableFor(appPath) {
  return platform === "win32"
    ? path.join(appPath, "Threadleaf.exe")
    : path.join(appPath, "Contents", "MacOS", "Threadleaf");
}

function expectedCandidatePaths(rootPath) {
  if (platform === "win32") {
    const stem = `Threadleaf-${candidateVersion}-win-x64`;
    return {
      installer: path.join(rootPath, `${stem}.exe`),
      zip: path.join(rootPath, `${stem}.zip`),
      app: path.join(rootPath, "win-unpacked"),
    };
  }
  const stem = `Threadleaf-${candidateVersion}-mac-x64`;
  return {
    dmg: path.join(rootPath, `${stem}.dmg`),
    zip: path.join(rootPath, `${stem}.zip`),
    app: path.join(rootPath, "mac-x64", "Threadleaf.app"),
  };
}

function expectedBaselinePaths(rootPath) {
  if (platform === "win32") {
    const stem = `Threadleaf-${baselineVersion}-win-x64`;
    return {
      installer: path.join(rootPath, `${stem}.exe`),
      zip: path.join(rootPath, `${stem}.zip`),
      app: path.join(rootPath, "win-unpacked"),
    };
  }
  const stem = `Threadleaf-${baselineVersion}-mac-x64`;
  return {
    dmg: path.join(rootPath, `${stem}.dmg`),
    zip: path.join(rootPath, `${stem}.zip`),
    app: path.join(rootPath, "mac-x64", "Threadleaf.app"),
  };
}

async function findMacApplication(rootPath) {
  const candidates = [
    path.join(rootPath, "mac", "Threadleaf.app"),
    path.join(rootPath, "mac-x64", "Threadleaf.app"),
  ];
  const matches = [];
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      matches.push(candidate);
    }
  }
  assert(matches.length === 1, `Expected one unpacked macOS application, found ${matches.length}.`);
  return matches[0];
}

async function buildBaseline() {
  await fs.mkdir(baselineReleasePath, { recursive: true, mode: 0o700 });
  const builder = path.join(
    appRoot,
    "node_modules",
    ".bin",
    `electron-builder${platform === "win32" ? ".cmd" : ""}`,
  );
  const args =
    platform === "win32"
      ? [
          "--win",
          "nsis",
          "zip",
          "--x64",
          "--publish",
          "never",
          `--config.directories.output=${baselineReleasePath}`,
          `--config.extraMetadata.version=${baselineVersion}`,
        ]
      : [
          "--mac",
          "dmg",
          "zip",
          "--x64",
          "--publish",
          "never",
          "--config.mac.identity=null",
          "--config.mac.hardenedRuntime=false",
          `--config.directories.output=${baselineReleasePath}`,
          `--config.extraMetadata.version=${baselineVersion}`,
        ];
  await run(builder, args, {
    env: { CSC_IDENTITY_AUTO_DISCOVERY: "false" },
    shell: platform === "win32",
    timeout: 900_000,
  });
  const paths = expectedBaselinePaths(baselineReleasePath);
  if (platform === "darwin") {
    paths.app = await findMacApplication(baselineReleasePath);
  }
  const required =
    platform === "win32"
      ? [paths.installer, paths.zip, paths.app]
      : [paths.dmg, paths.zip, paths.app];
  for (const requiredPath of required) {
    assert(
      await exists(requiredPath),
      `Baseline package is missing ${path.basename(requiredPath)}.`,
    );
  }
  return paths;
}

async function verifyWindowsZip(zipPath, version) {
  const expandedPath = path.join(scratchPath, `zip-${version}`);
  const powershellLiteral = (value) => `'${value.replaceAll("'", "''")}'`;
  await run(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -LiteralPath ${powershellLiteral(zipPath)} -DestinationPath ${powershellLiteral(expandedPath)} -Force`,
    ],
    { timeout: 180_000 },
  );
  const executablePath = path.join(expandedPath, "Threadleaf.exe");
  const requiredPaths = [
    executablePath,
    path.join(expandedPath, "resources", "app.asar"),
    path.join(expandedPath, "resources", "app-update.yml"),
    path.join(expandedPath, "resources", "LICENSE.threadleaf.txt"),
    path.join(expandedPath, "resources", "bundled-vault", "Welcome.md"),
    path.join(
      expandedPath,
      "resources",
      "bundled-vault",
      ".obsidian",
      "plugins",
      "threadleaf-fixture",
      "manifest.json",
    ),
  ];
  for (const requiredPath of requiredPaths) {
    assert(
      await exists(requiredPath),
      `${version} Windows ZIP is missing ${path.basename(requiredPath)}.`,
    );
  }
  const versionResult = await run(executablePath, ["--version"], {
    env: lifecycleEnvironment,
    timeout: 30_000,
  });
  assert(
    versionResult === `${version}\n`,
    `${version} Windows ZIP executable reports the wrong version.`,
  );
  const update = parseYaml(
    await fs.readFile(path.join(expandedPath, "resources", "app-update.yml"), "utf8"),
  );
  assert(update.provider === "github", `${version} Windows ZIP update provider is not GitHub.`);
  assert(update.owner === "maherr", `${version} Windows ZIP update owner is not maherr.`);
  assert(
    update.repo === "threadleaf",
    `${version} Windows ZIP update repository is not threadleaf.`,
  );
  const app = await treeDigest(expandedPath);
  return {
    filename: path.basename(zipPath),
    bytes: (await fs.stat(zipPath)).size,
    sha256: await sha256(zipPath),
    extractedApp: app,
  };
}

async function verifyArtifactSet(paths, version, rootPath) {
  const required = platform === "win32" ? [paths.installer, paths.zip] : [paths.dmg, paths.zip];
  for (const requiredPath of required) {
    assert(
      await exists(requiredPath),
      `${version} package is missing ${path.basename(requiredPath)}.`,
    );
  }
  if (platform === "darwin") {
    paths.app = await findMacApplication(rootPath);
  }
  assert(await exists(paths.app), `${version} unpacked app is missing.`);
  const metadataPath = path.join(rootPath, platform === "win32" ? "latest.yml" : "latest-mac.yml");
  assert(
    await exists(metadataPath),
    `${version} package is missing ${path.basename(metadataPath)}.`,
  );
  const metadata = parseYaml(await fs.readFile(metadataPath, "utf8"));
  assert(metadata?.version === version, `${version} update metadata has the wrong version.`);
  const metadataArtifacts = platform === "win32" ? [paths.installer] : [paths.dmg, paths.zip];
  for (const artifactPath of metadataArtifacts) {
    const filename = path.basename(artifactPath);
    const entry = metadata.files?.find((candidate) => candidate.url === filename);
    assert(entry, `${version} update metadata is missing ${filename}.`);
    assert(
      entry.size === (await fs.stat(artifactPath)).size,
      `${version} update metadata has the wrong size for ${filename}.`,
    );
    assert(
      entry.sha512 === (await digest(artifactPath, "sha512", "base64")),
      `${version} update metadata has the wrong digest for ${filename}.`,
    );
  }
  if (platform === "win32") {
    assert(
      metadata.path === path.basename(paths.installer),
      `${version} Windows update metadata must point to the NSIS installer.`,
    );
    assert(
      metadata.files?.length === 1 && metadata.files[0]?.url === path.basename(paths.installer),
      `${version} Windows update metadata contains an unexpected artifact list.`,
    );
  }
  const app = await treeDigest(paths.app);
  const appInfo = {
    filename: path.relative(rootPath, paths.app).replaceAll(path.sep, "/"),
    bytes: app.bytes,
    sha256: app.sha256,
  };
  const checksumFiles = [...required, metadataPath];
  const checksumEntries = [];
  for (const filePath of checksumFiles) {
    checksumEntries.push(`${await sha256(filePath)}  ${path.basename(filePath)}`);
  }
  const checksumPath = path.join(
    rootPath,
    `${path.basename(required[0], path.extname(required[0]))}.sha256`,
  );
  await fs.writeFile(checksumPath, `${checksumEntries.join("\n")}\n`, { mode: 0o600 });
  return {
    version,
    files: await Promise.all(
      required.map(async (filePath) => ({
        filename: path.relative(rootPath, filePath).replaceAll(path.sep, "/"),
        bytes: (await fs.stat(filePath)).size,
        sha256: await sha256(filePath),
      })),
    ),
    metadata: {
      filename: path.basename(metadataPath),
      bytes: (await fs.stat(metadataPath)).size,
      sha256: await sha256(metadataPath),
    },
    checksum: {
      filename: path.basename(checksumPath),
      bytes: (await fs.stat(checksumPath)).size,
      sha256: await sha256(checksumPath),
    },
    app: appInfo,
    ...(platform === "win32" ? { zip: await verifyWindowsZip(paths.zip, version) } : {}),
  };
}

async function installWindows(installer, target) {
  const replacing = await exists(target);
  if (replacing) {
    assert(
      await exists(path.join(target, "Threadleaf.exe")),
      "Windows replacement target is missing the baseline executable.",
    );
  }
  await run(installer, ["/S", `/D=${target}`], {
    env: lifecycleEnvironment,
    timeout: 180_000,
  });
  assert(
    await exists(target),
    `${replacing ? "Windows in-place replacement" : "Windows installer"} removed its target directory.`,
  );
  assert(
    await exists(path.join(target, "Threadleaf.exe")),
    "Windows installer did not create Threadleaf.exe.",
  );
  assert(
    await exists(path.join(target, "Uninstall Threadleaf.exe")),
    "Windows installer did not create an uninstaller.",
  );
  const profile = process.env.USERPROFILE;
  if (profile) {
    for (const candidate of [
      path.join(profile, "Desktop", "Threadleaf.lnk"),
      path.join(profile, "OneDrive", "Desktop", "Threadleaf.lnk"),
    ]) {
      if (await exists(candidate)) {
        windowsShortcutPath = candidate;
        break;
      }
    }
  }
}

async function mountMacDmg(dmgPath, target) {
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  await run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", target, dmgPath], {
    timeout: 180_000,
  });
  const entries = await fs.readdir(target, { withFileTypes: true });
  const appEntry = entries.find((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
  assert(appEntry, "macOS DMG did not contain an application bundle.");
  return path.join(target, appEntry.name);
}

async function detachMacDmg(mountPath) {
  let lastError = null;
  for (const args of [
    ["detach", mountPath, "-quiet"],
    ["detach", mountPath, "-force", "-quiet"],
  ]) {
    try {
      await run("hdiutil", args, { timeout: 60_000 });
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    const info = await run("hdiutil", ["info"], { timeout: 30_000 });
    if (!info.includes(mountPath)) {
      return;
    }
    await delay(250);
  }
  throw new Error(`macOS DMG remained mounted at ${mountPath}: ${lastError ?? "unknown error"}`);
}

async function installMac(dmgPath, target) {
  const mountPath = path.join(scratchPath, `mount-${randomUUID()}`);
  let mountedApp;
  try {
    const replacing = await exists(target);
    if (replacing) {
      assert(
        await exists(executableFor(target)),
        "macOS replacement target is missing the baseline executable.",
      );
    }
    mountedApp = await mountMacDmg(dmgPath, mountPath);
    await run("ditto", ["--rsrc", "--extattr", "--qtn", mountedApp, target], { timeout: 180_000 });
    assert(await exists(target), "macOS in-place replacement removed its application target.");
  } finally {
    await detachMacDmg(mountPath);
  }
  assert(
    await exists(executableFor(target)),
    "macOS DMG install did not create the application executable.",
  );
}

async function installPackage(paths, target, replacementExpected) {
  assert(
    (await exists(target)) === replacementExpected,
    `Installer replacement precondition mismatch: expected target ${replacementExpected ? "to exist" : "to be absent"}.`,
  );
  const before = replacementExpected ? await fs.stat(target) : null;
  if (platform === "win32") {
    await installWindows(paths.installer, target);
  } else {
    await installMac(paths.dmg, target);
  }
  if (before) {
    const after = await fs.stat(target);
    if (before.ino > 0 && after.ino > 0) {
      assert(
        before.dev === after.dev && before.ino === after.ino,
        "Installer replacement recreated the target directory instead of updating in place.",
      );
      inPlaceReplacementChecks += 1;
    }
  }
}

async function launchPackage(executablePath, expectedVersion, stage) {
  const port = await availablePort();
  const child = spawn(
    executablePath,
    [
      `--remote-debugging-port=${port}`,
      processMarkerArgument,
      "--disable-gpu",
      "--password-store=basic",
      "--safe-plugins",
    ],
    {
      cwd: scratchPath,
      env: {
        ...process.env,
        ...lifecycleEnvironment,
        THREADLEAF_LIFECYCLE_RUN: processMarker,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  launchedProcesses.add(child);
  const output = [];
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => output.push(sanitize(chunk)));
  }
  const exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  const target = await waitForMainTarget(port, Date.now() + 45_000);
  await observeLaunchMarker();
  const probe = { cdp: connectCdp(target.webSocketDebuggerUrl), child, exited, output, stage };
  await probe.cdp.send("Page.enable");
  await waitFor(async () => {
    const observed = await evaluate(probe, packageStateExpression());
    return observed.ready && observed.vaultPath === vaultPath ? observed : null;
  }, `${expectedVersion} package did not restore the disposable vault`);
  const state = await evaluate(probe, packageStateExpression());
  assert(
    state.version === expectedVersion,
    `Expected ${expectedVersion}, observed ${state.version}.`,
  );
  assert(
    state.updateDisabledReason === "unsigned-package",
    "Unsigned package did not fail closed for updates.",
  );
  await captureScreenshot(probe, stage);
  activeProbe = probe;
  return { probe, state };
}

async function stopPackage(probe, force = false) {
  if (!probe) {
    return;
  }
  if (!force) {
    try {
      await evaluate(probe, "setTimeout(() => window.close(), 0); true");
    } catch {
      // A renderer that is already closing does not need another close request.
    }
  }
  if (force) {
    const wasRunning = probe.child.exitCode === null && probe.child.signalCode === null;
    const cleanup = await cleanupMarkedProcesses();
    assert(
      !wasRunning || cleanup.markerObserved,
      "Forced lifecycle cleanup did not observe its launch marker.",
    );
  }
  probe.cdp.close();
  try {
    probe.child.kill(force ? "SIGKILL" : "SIGTERM");
  } catch {
    // The process already exited.
  }
  const result = await Promise.race([
    probe.exited,
    delay(30_000).then(() => ({ code: null, signal: "timeout" })),
  ]);
  if (result.code === null) {
    try {
      probe.child.kill("SIGKILL");
    } catch {
      // The process already exited.
    }
  }
  await cleanupMarkedProcesses();
  launchedProcesses.delete(probe.child);
  if (activeProbe === probe) {
    activeProbe = null;
  }
  assert(
    result.code === 0 || result.signal === "SIGTERM" || force,
    `Packaged ${probe.stage} process did not exit cleanly.`,
  );
}

async function readState(probe) {
  return evaluate(probe, packageStateExpression());
}

async function createAndEdit(probe, content, edit, expectedFinal) {
  const initial = await readState(probe);
  const created = await evaluate(
    probe,
    `(async () => window.threadleaf.createNote(${JSON.stringify(lifecycleNotePath)}, ${JSON.stringify(content)}, ${JSON.stringify(initial.vaultId)}))()`,
  );
  assert(
    created?.outcome?.status === "committed",
    "Packaged createNote did not commit the lifecycle note.",
  );
  await evaluate(probe, `window.threadleaf.openNote(${JSON.stringify(lifecycleNotePath)})`);
  const opened = await waitFor(async () => {
    const state = await readState(probe);
    return state.activePath === lifecycleNotePath ? state : null;
  }, "Packaged lifecycle note did not open");
  const saved = await evaluate(
    probe,
    `(async () => window.threadleaf.saveNote(${JSON.stringify(lifecycleNotePath)}, ${JSON.stringify(
      `${content}${edit}`,
    )}, ${JSON.stringify(opened.activeRevision)}, ${JSON.stringify(opened.vaultId)}))()`,
  );
  assert(
    saved?.outcome?.status === "committed",
    "Packaged saveNote did not commit the lifecycle edit.",
  );
  assert(
    (await fs.readFile(path.join(vaultPath, lifecycleNotePath), "utf8")) === expectedFinal,
    "Lifecycle note bytes differ after save.",
  );
  await evaluate(
    probe,
    `(async () => {
      const vaultId = (await window.threadleaf.getSnapshot()).vault.id;
      await window.threadleaf.setKeyBinding("ui.command-palette", "Mod+Shift+P");
      await window.threadleaf.setVaultAppearance(vaultId, { colorScheme: "dark", themeId: null, enabledSnippetIds: [] });
      return true;
    })()`,
  );
}

async function editExisting(probe, edit, expectedFinal) {
  await evaluate(probe, `window.threadleaf.openNote(${JSON.stringify(lifecycleNotePath)})`);
  await waitFor(async () => {
    const state = await readState(probe);
    return state.activePath === lifecycleNotePath ? state : null;
  }, "Packaged lifecycle note did not reopen");
  const current = await evaluate(
    probe,
    `(async () => {
      const snapshot = await window.threadleaf.getSnapshot();
      const note = snapshot.workspace.activeNote;
      return { content: note.content, revision: note.revision, vaultId: snapshot.vault.id };
    })()`,
  );
  const result = await evaluate(
    probe,
    `(async () => window.threadleaf.saveNote(${JSON.stringify(lifecycleNotePath)}, ${JSON.stringify(
      `${current.content}${edit}`,
    )}, ${JSON.stringify(current.revision)}, ${JSON.stringify(current.vaultId)}))()`,
  );
  assert(
    result?.outcome?.status === "committed",
    "Packaged saveNote did not commit the upgrade edit.",
  );
  assert(
    (await fs.readFile(path.join(vaultPath, lifecycleNotePath), "utf8")) === expectedFinal,
    "Lifecycle note bytes differ after upgrade.",
  );
}

async function seedVault() {
  await fs.mkdir(vaultPath, { recursive: true, mode: 0o700 });
  await fs.mkdir(userDataPath, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(vaultPath, dailyNotePath), "# Daily\n\nInstaller lifecycle.\n", {
    mode: 0o600,
  });
  await fs.writeFile(path.join(vaultPath, "Linked.md"), linkedContent, { mode: 0o600 });
  await fs.writeFile(
    path.join(userDataPath, "workspace-selection.json"),
    `${JSON.stringify({ version: 1, vaultPath }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

async function privateStateManifest(vaultId) {
  const relativePaths = [
    "settings.json",
    "workspace-selection.json",
    path.join("workspaces", `${vaultId}.json`),
  ];
  const manifest = [];
  for (const relativePath of relativePaths) {
    const statePath = path.join(userDataPath, relativePath);
    const bytes = await fs.readFile(statePath);
    const stat = await fs.stat(statePath);
    manifest.push({
      path: relativePath.replaceAll(path.sep, "/"),
      mode: stat.mode & 0o777,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return manifest;
}

async function uninstallPackage() {
  if (platform === "win32") {
    const uninstaller = path.join(installPath, "Uninstall Threadleaf.exe");
    assert(await exists(uninstaller), "Installed Windows package has no uninstaller.");
    await run(uninstaller, ["/S"], { env: lifecycleEnvironment, timeout: 180_000 });
    await waitFor(
      async () => (!(await exists(installPath)) ? true : null),
      "Windows uninstaller left installation residue",
      30_000,
    );
    if (windowsShortcutPath) {
      assert(
        !(await exists(windowsShortcutPath)),
        "Windows uninstaller left the desktop shortcut behind.",
      );
    }
  } else {
    await fs.rm(installPath, { recursive: true, force: true });
    assert(!(await exists(installPath)), "macOS package removal left application residue.");
  }
}

async function writeEvidence(payload) {
  if (evidenceWritten) {
    return;
  }
  evidenceWritten = true;
  await fs.mkdir(evidencePath, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(evidencePath, "lifecycle.log"),
    `${commandLog.map(sanitize).join("\n")}\n`,
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(evidencePath, "lifecycle.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
}

async function runLifecycle() {
  assert(
    platform === "win32" || platform === "darwin",
    "Installer lifecycle requires native Windows or macOS.",
  );
  assert(architecture === "x64", `Installer lifecycle requires x64, observed ${architecture}.`);
  assert(
    path.relative(vaultPath, userDataPath).startsWith(".."),
    "The isolated private app-data root must remain outside the vault.",
  );
  assert(
    candidateVersion !== baselineVersion,
    "Baseline and candidate package versions must differ.",
  );
  assert(
    !(process.env.THREADLEAF_REQUIRE_SIGNED === "1"),
    "Unsigned lifecycle CI cannot require signing.",
  );
  await fs.access(
    path.join(
      appRoot,
      "node_modules",
      ".bin",
      `electron-builder${platform === "win32" ? ".cmd" : ""}`,
    ),
  );
  await seedVault();

  const candidatePaths = expectedCandidatePaths(releasePath);
  const candidateManifest = await verifyArtifactSet(candidatePaths, candidateVersion, releasePath);
  const baselinePaths = await buildBaseline();
  const baselineManifest = await verifyArtifactSet(
    baselinePaths,
    baselineVersion,
    baselineReleasePath,
  );
  assert(
    baselineManifest.files.find((entry) =>
      entry.filename.endsWith(platform === "win32" ? ".exe" : ".dmg"),
    )?.sha256 !==
      candidateManifest.files.find((entry) =>
        entry.filename.endsWith(platform === "win32" ? ".exe" : ".dmg"),
      )?.sha256,
    "Baseline and candidate installer artifacts are byte-identical.",
  );

  await installPackage(baselinePaths, installPath, false);
  const baselineExecutable = executableFor(installPath);
  const baseline = await launchPackage(baselineExecutable, baselineVersion, "baseline");
  await createAndEdit(
    baseline.probe,
    initialLifecycleContent,
    baselineEdit,
    `${initialLifecycleContent}${baselineEdit}`,
  );
  assert(
    await exists(path.join(userDataPath, "settings.json")),
    "Packaged application did not persist settings into its isolated platform-default app-data directory.",
  );
  await stopPackage(baseline.probe, true);

  const restartedBaseline = await launchPackage(baselineExecutable, baselineVersion, "restart");
  const restartState = await readState(restartedBaseline.probe);
  assert(
    restartState.activePath === lifecycleNotePath,
    "Restart did not restore the lifecycle note.",
  );
  assert(restartState.paletteBinding === "Mod+Shift+P", "Restart lost private key-binding state.");
  assert(restartState.appearance === "dark", "Restart lost private appearance state.");
  await stopPackage(restartedBaseline.probe);

  await installPackage(candidatePaths, installPath, true);
  const candidateExecutable = executableFor(installPath);
  const candidate = await launchPackage(candidateExecutable, candidateVersion, "candidate");
  assert(
    candidate.state.activePath === lifecycleNotePath,
    "Upgrade did not restore the lifecycle note.",
  );
  await editExisting(
    candidate.probe,
    candidateEdit,
    `${initialLifecycleContent}${baselineEdit}${candidateEdit}`,
  );
  await stopPackage(candidate.probe);

  await installPackage(baselinePaths, installPath, true);
  assert(
    inPlaceReplacementChecks === 2,
    "Native installer replacement did not provide stable target identity for both upgrade and rollback.",
  );
  const rollback = await launchPackage(baselineExecutable, baselineVersion, "rollback");
  assert(
    rollback.state.activePath === lifecycleNotePath,
    "Rollback did not restore the lifecycle note.",
  );
  await editExisting(
    rollback.probe,
    rollbackEdit,
    `${initialLifecycleContent}${baselineEdit}${candidateEdit}${rollbackEdit}`,
  );
  await stopPackage(rollback.probe);
  const privateStateBeforeUninstall = await privateStateManifest(rollback.state.vaultId);

  await uninstallPackage();
  assert(await exists(userDataPath), "Uninstall removed the private state root.");
  assert(
    await exists(path.join(userDataPath, "workspace-selection.json")),
    "Uninstall removed vault selection state.",
  );
  assert(
    JSON.stringify(await privateStateManifest(rollback.state.vaultId)) ===
      JSON.stringify(privateStateBeforeUninstall),
    "Uninstall changed private state bytes or permissions.",
  );
  assert(
    (await fs.readFile(path.join(vaultPath, lifecycleNotePath), "utf8")) ===
      `${initialLifecycleContent}${baselineEdit}${candidateEdit}${rollbackEdit}`,
    "Uninstall changed lifecycle note bytes.",
  );
  assert(
    (await fs.readFile(path.join(vaultPath, "Linked.md"), "utf8")) === linkedContent,
    "Uninstall changed an untouched vault note.",
  );
  const vaultEntries = (await fs.readdir(vaultPath)).sort();
  assert(
    JSON.stringify(vaultEntries) === JSON.stringify(["Daily.md", "Lifecycle.md", "Linked.md"]),
    "Package state leaked into the vault.",
  );

  await writeEvidence({
    verified: true,
    platform,
    architecture,
    applicationId: "org.threadleaf.Threadleaf",
    sequence: [baselineVersion, baselineVersion, candidateVersion, baselineVersion],
    distinctPackages: true,
    unsigned: true,
    updatePolicy: "unsigned-package",
    createEditRestart: true,
    forcedProcessRecovery: true,
    upgrade: true,
    rollback: true,
    inPlaceReplacementChecks,
    uninstall: platform === "win32" ? "nsis-silent" : "manual-app-removal",
    stateRootPreserved: true,
    appData: {
      mode: "platform-default",
      root: path.relative(scratchPath, userDataPath).replaceAll(path.sep, "/"),
      isolated: true,
      outsideVault: true,
    },
    vaultBytesPreserved: true,
    shortcut: windowsShortcutPath ? "created-and-removed" : "not-created-by-installer",
    descendantCleanup: "launch-marker",
    launchMarkerObserved,
    macDmgDetach: platform === "darwin" ? "verified-unmounted" : "not-applicable",
    candidate: candidateManifest,
    baseline: baselineManifest,
  });
}

try {
  await runLifecycle();
  process.stdout.write(
    `${JSON.stringify({ verified: true, platform, architecture, evidence: "lifecycle.json" })}\n`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await captureScreenshot(activeProbe, "failure");
  await writeEvidence({
    verified: false,
    platform,
    architecture,
    error: sanitize(message),
    rendererOutput: activeProbe?.output?.slice(-100).map(sanitize) ?? [],
  });
  throw new Error(sanitize(message));
} finally {
  if (activeProbe) {
    await stopPackage(activeProbe, true).catch(() => undefined);
  }
  for (const child of launchedProcesses) {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process already exited.
    }
  }
  await cleanupMarkedProcesses();
  await fs.rm(scratchPath, { recursive: true, force: true });
}
