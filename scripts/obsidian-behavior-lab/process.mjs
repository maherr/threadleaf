import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readProcessField(pid, name, encoding = "utf8") {
  try {
    return await fs.readFile(path.join("/proc", String(pid), name), encoding);
  } catch {
    return null;
  }
}

function pidsFromProc(entries) {
  return entries
    .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
    .map((entry) => Number(entry.name));
}

export async function markedProcesses(marker) {
  assert(/^[A-Za-z0-9._:-]+$/u.test(marker), "Run marker contains unsafe characters.");
  const entries = await fs.readdir("/proc", { withFileTypes: true });
  const processes = [];
  for (const pid of pidsFromProc(entries)) {
    const environ = await readProcessField(pid, "environ", null);
    if (!environ?.includes(`${marker}=1\0`)) continue;
    const [status, commandLine, executable, networkNamespace] = await Promise.all([
      readProcessField(pid, "status"),
      readProcessField(pid, "cmdline", null),
      fs.readlink(path.join("/proc", String(pid), "exe")).catch(() => null),
      fs.readlink(path.join("/proc", String(pid), "ns/net")).catch(() => null),
    ]);
    processes.push({
      pid,
      parentPid: Number(/^PPid:\s+(\d+)$/mu.exec(status ?? "")?.[1] ?? -1),
      commandLine: commandLine ? commandLine.toString("utf8").replaceAll("\0", " ").trim() : "",
      executable,
      networkNamespace,
    });
  }
  return processes.sort((left, right) => left.pid - right.pid);
}

export async function assertMarkerAbsent(marker, label = "run marker") {
  const processes = await markedProcesses(marker);
  assert(processes.length === 0, `${label} was already present: ${JSON.stringify(processes)}`);
  return processes;
}

export async function terminateMarkedProcesses(marker, { timeoutMs = 4_000 } = {}) {
  const signals = ["SIGTERM", "SIGKILL"];
  const attempted = [];
  for (const signal of signals) {
    const processes = await markedProcesses(marker);
    for (const process of processes) {
      if (process.pid === process.parentPid) continue;
      try {
        processKill(process.pid, signal);
        attempted.push({ pid: process.pid, signal });
      } catch {
        // The process may have exited between the scan and the signal.
      }
    }
    const deadline = Date.now() + (signal === "SIGTERM" ? timeoutMs : 1_000);
    while (Date.now() < deadline) {
      if ((await markedProcesses(marker)).length === 0) return { attempted, clean: true };
      await delay(50);
    }
  }
  return { attempted, clean: (await markedProcesses(marker)).length === 0 };
}

function processKill(pid, signal) {
  process.kill(pid, signal);
}

export async function waitForExit(child, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => finish({ code: null, signal: "timeout" }), timeoutMs);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.once("exit", (code, signal) => finish({ code, signal }));
    child.once("error", (error) => finish({ code: null, signal: null, error: String(error) }));
  });
}

export function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a loopback port."));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

export function captureChildOutput(child, stdoutPath, stderrPath) {
  const stdout = [];
  const stderr = [];
  const cap = (chunks, chunk) => {
    const bytes = Buffer.from(chunk);
    const current = Buffer.concat(chunks);
    if (current.length < 4 * 1024 * 1024)
      chunks.push(bytes.subarray(0, 4 * 1024 * 1024 - current.length));
  };
  child.stdout?.on("data", (chunk) => cap(stdout, chunk));
  child.stderr?.on("data", (chunk) => cap(stderr, chunk));
  return async () => {
    await fs.writeFile(stdoutPath, Buffer.concat(stdout), { mode: 0o600 });
    await fs.writeFile(stderrPath, Buffer.concat(stderr), { mode: 0o600 });
  };
}

export function processPlatform() {
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    hostname: os.hostname(),
  };
}

export async function processNamespaceProof(marker) {
  const processes = await markedProcesses(marker);
  const hostNamespace = await fs.readlink("/proc/self/ns/net").catch(() => null);
  const networkProcesses = processes.filter((entry) => entry.networkNamespace);
  const isolated = networkProcesses.filter((entry) => entry.networkNamespace !== hostNamespace);
  const rendererProcesses = processes.filter((entry) =>
    entry.commandLine.includes("--type=renderer"),
  );
  return {
    hostNamespace,
    processes,
    rendererProcesses,
    isolatedPids: isolated.map((entry) => entry.pid),
    networkNamespaceIsolated: Boolean(hostNamespace && isolated.length > 0),
  };
}

export function assertRendererX11(processes, label = "renderer") {
  assert(processes.length > 0, `${label} process was not observable through /proc.`);
  assert(
    processes.every((commandLine) => commandLine.includes("--ozone-platform=x11")),
    `${label} omitted explicit --ozone-platform=x11: ${JSON.stringify(processes)}`,
  );
  assert(
    processes.every((commandLine) => !commandLine.includes("--ozone-platform=wayland")),
    `${label} selected Wayland: ${JSON.stringify(processes)}`,
  );
}

export function assertFlatpakContainmentArgs(args, { runRoot } = {}) {
  const required = [
    "run",
    "--sandbox",
    "--die-with-parent",
    "--unshare=network",
    "--nofilesystem=home",
    "--socket=x11",
    "--nosocket=wayland",
    "--command=/usr/bin/python3",
  ];
  for (const flag of required) {
    assert(args.includes(flag), `Flatpak containment flag is missing: ${flag}`);
  }
  assert(!args.includes("--share=network"), "Flatpak launch explicitly shares network access.");
  assert(
    !args.some((flag) => flag === "--filesystem=home" || flag === "--filesystem=/"),
    "Flatpak launch grants a broad host filesystem path.",
  );
  assert(
    !args.some((flag) => flag === "--device=all" || flag === "--share=host"),
    "Flatpak launch grants a broad host device or namespace share.",
  );
  assert(
    !args.includes("--parent-share-pids") && !args.includes("--parent-expose-pids"),
    "Flatpak launch shares host PID visibility; containment must be proved inside the sandbox.",
  );
  const filesystemGrants = args.filter((flag) => flag.startsWith("--filesystem="));
  assert(filesystemGrants.length === 1, "Flatpak launch must have exactly one filesystem grant.");
  if (runRoot) {
    assert(
      filesystemGrants[0] === `--filesystem=${path.resolve(runRoot)}:rw`,
      `Flatpak launch filesystem grant is not the dedicated run root: ${filesystemGrants[0]}`,
    );
  }
  assert(
    args.filter((flag) => flag.startsWith("--socket=")).every((flag) => flag === "--socket=x11"),
    "Flatpak launch grants an unexpected host socket.",
  );
  assert(
    args
      .filter((flag) => flag.startsWith("--nosocket="))
      .every((flag) => flag === "--nosocket=wayland"),
    "Flatpak launch changes the explicit Wayland socket denylist.",
  );
  assert(
    !args.some((flag) => flag === "--filesystem=home" || flag === "--filesystem=/"),
    "Flatpak launch grants a broad host filesystem path.",
  );
  return true;
}

function isStrictDescendant(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function assertRunPathContainment(
  { scratchRoot, runRoot, profilePath, vaultPath },
  label = "run paths",
) {
  assert(isStrictDescendant(scratchRoot, runRoot), `${label} escaped the dedicated scratch root.`);
  assert(isStrictDescendant(runRoot, profilePath), `${label} profile is not below the run root.`);
  assert(isStrictDescendant(runRoot, vaultPath), `${label} vault is not below the run root.`);
  const home = path.resolve(os.homedir());
  const forbidden = [
    path.join(home, ".var", "app", "md.obsidian.Obsidian"),
    path.join(home, ".config", "obsidian"),
    path.join(home, ".local", "share", "obsidian"),
    path.join(home, "MEGA"),
  ];
  for (const candidate of [profilePath, vaultPath]) {
    assert(
      !forbidden.some(
        (root) => path.resolve(candidate) === root || isStrictDescendant(root, candidate),
      ),
      `${label} points at a live application or workspace path: ${candidate}`,
    );
  }
  return true;
}

export function assertReferenceReceipt(
  receipt,
  {
    runRoot,
    profilePath,
    vaultPath,
    vaultTreeSha256,
    profileBeforeTreeSha256,
    profileAfterTreeSha256,
    referenceVersion,
    referenceRuntime,
    referenceCommit,
    hostNetworkNamespace,
    vaultAfterTreeSha256,
    expectedViewport = { width: 800, height: 650, deviceScaleFactor: 1, pageScaleFactor: 1 },
    expectedUserAgentToken = "obsidian/1.13.7",
  },
) {
  assert(receipt?.status === "observed", "Reference receipt is not observed.");
  const app = receipt.appProcess;
  const targetPort = receipt.target?.port;
  assert(
    path.relative(path.resolve(runRoot), path.resolve(profilePath)) !== "" &&
      !path.relative(path.resolve(runRoot), path.resolve(profilePath)).startsWith("..") &&
      path.relative(path.resolve(runRoot), path.resolve(vaultPath)) !== "" &&
      !path.relative(path.resolve(runRoot), path.resolve(vaultPath)).startsWith(".."),
    "Reference receipt profile/vault paths escaped the run root.",
  );
  assert(Number.isInteger(app?.pid) && app.pid > 0, "Reference receipt has no app PID.");
  assert(
    Number.isFinite(app?.start?.epochSeconds) && app.start.epochSeconds > 0,
    "Reference receipt has no app start time.",
  );
  assert(app.executable === "/app/obsidian", `Unexpected app executable: ${app.executable}`);
  assert(
    app.parentPid === receipt.supervisorPid,
    "Reference app process was not the direct child of the in-sandbox supervisor.",
  );
  assert(
    app.networkNamespace === receipt.network?.namespace,
    "Reference app process escaped the isolated network namespace.",
  );
  assert(Array.isArray(app.argv) && app.argv[0] === "/app/obsidian", "App argv was not captured.");
  assert(
    app.argv.includes("--ozone-platform=x11") &&
      !app.argv.includes("--ozone-platform=wayland") &&
      app.argv.includes("--disable-gpu") &&
      app.argv.includes("--no-first-run") &&
      app.argv.includes(`--window-size=${expectedViewport.width},${expectedViewport.height}`) &&
      app.argv.includes(`--remote-debugging-port=${targetPort}`) &&
      app.argv.includes("--remote-debugging-address=127.0.0.1") &&
      app.argv.includes(`--remote-allow-origins=http://127.0.0.1:${targetPort}`) &&
      app.argv.includes(`--user-data-dir=${profilePath}`) &&
      app.argv.includes(vaultPath) &&
      app.argv.includes(
        `obsidian://open?path=${encodeURIComponent(`${vaultPath}/00 Overview.md`)}`,
      ),
    "App argv did not bind the exact X11/CDP/profile/vault/fixture launch.",
  );
  const uriDispatch = receipt.uriDispatch;
  assert(
    uriDispatch?.parentPid === receipt.supervisorPid &&
      uriDispatch.private === true &&
      uriDispatch.accepted === true &&
      uriDispatch.source === "in-sandbox initial app argv" &&
      Array.isArray(uriDispatch.argv) &&
      uriDispatch.argv[0] === "/app/obsidian" &&
      uriDispatch.argv.includes(vaultPath) &&
      uriDispatch.argv.includes(`--user-data-dir=${profilePath}`) &&
      uriDispatch.argv.includes(
        `obsidian://open?path=${encodeURIComponent(`${vaultPath}/00 Overview.md`)}`,
      ),
    "Fixture URI was not dispatched wholly inside the isolated Flatpak supervisor.",
  );
  assert(
    receipt.reference?.flatpakId === "md.obsidian.Obsidian" &&
      receipt.reference?.version === referenceVersion &&
      receipt.reference?.runtime === referenceRuntime &&
      receipt.reference?.commit === referenceCommit,
    "Reference receipt did not bind the exact installed Flatpak app/runtime version.",
  );
  assert(
    receipt.paths?.profile?.realpath === path.resolve(profilePath) &&
      receipt.paths?.vault?.realpath === path.resolve(vaultPath),
    "Reference receipt profile/vault realpaths do not match the synthetic inputs.",
  );
  assert(
    receipt.paths?.profile?.treeSha256 &&
      receipt.pathsAfterCleanup?.profile?.treeSha256 &&
      receipt.paths?.profile?.treeSha256 === profileBeforeTreeSha256 &&
      receipt.pathsAfterCleanup?.profile?.treeSha256 === profileAfterTreeSha256 &&
      receipt.paths?.vault?.treeSha256 === vaultTreeSha256 &&
      receipt.pathsAfterCleanup?.vault?.treeSha256 === vaultAfterTreeSha256,
    "Reference receipt does not bind before/after profile and vault hashes.",
  );
  const network = receipt.network;
  assert(
    network?.namespace &&
      network.namespace !== hostNetworkNamespace &&
      network.hostNamespace === hostNetworkNamespace &&
      network.noEgressEvidence === true &&
      Array.isArray(network.routes) &&
      network.routes.length === 0 &&
      JSON.stringify(network.devices) === JSON.stringify(["lo"]),
    "Reference receipt did not prove the distinct no-egress network namespace.",
  );
  assert(
    receipt.display?.value?.startsWith(":") && receipt.display.wayland == null,
    "Reference receipt did not prove the isolated X11 display.",
  );
  assert(
    Array.isArray(receipt.rendererProcesses) && receipt.rendererProcesses.length > 0,
    "Reference receipt has no renderer process record.",
  );
  for (const renderer of receipt.rendererProcesses) {
    assert(
      Number.isInteger(renderer.pid) && renderer.start?.epochSeconds > 0,
      "Renderer PID/start missing.",
    );
    assert(
      renderer.commandLine.includes("--type=renderer"),
      "Renderer argv omitted --type=renderer.",
    );
    assert(
      renderer.parentPid === app.pid,
      "Renderer was not a direct child of the captured app process.",
    );
    assert(
      Array.isArray(renderer.argv) &&
        renderer.argv[0] === "/app/obsidian" &&
        renderer.argv.includes("--type=renderer") &&
        renderer.argv.includes(`--user-data-dir=${profilePath}`) &&
        renderer.argv.includes(`--remote-debugging-port=${targetPort}`),
      "Renderer argv did not bind the exact app profile/CDP launch.",
    );
    assert(renderer.commandLine.includes("--ozone-platform=x11"), "Renderer argv omitted X11.");
    assert(
      !renderer.commandLine.includes("--ozone-platform=wayland"),
      "Renderer selected Wayland.",
    );
    assert(
      renderer.networkNamespace === network.namespace,
      "Renderer escaped the isolated network namespace.",
    );
  }
  assert(
    receipt.target?.type === "page" &&
      receipt.target.address === "127.0.0.1" &&
      receipt.target.port === targetPort &&
      Number.isInteger(receipt.target.port) &&
      receipt.target.port > 0 &&
      typeof receipt.target.webSocketDebuggerUrl === "string" &&
      receipt.target.webSocketDebuggerUrl.startsWith(`ws://127.0.0.1:${targetPort}/`),
    "Reference receipt did not bind a loopback CDP page target.",
  );
  assert(
    typeof receipt.cdp?.browserVersion?.product === "string" &&
      receipt.cdp.browserVersion.product.includes("Chrome/") &&
      typeof receipt.cdp.browserVersion.userAgent === "string" &&
      receipt.cdp.browserVersion.userAgent.toLowerCase().includes(expectedUserAgentToken),
    "Reference receipt did not bind the expected Obsidian browser user agent.",
  );
  assert(
    receipt.visible?.viewport?.width === expectedViewport.width &&
      receipt.visible?.viewport?.height === expectedViewport.height &&
      receipt.visible?.viewport?.deviceScaleFactor === expectedViewport.deviceScaleFactor &&
      receipt.visible?.viewport?.pageScale === expectedViewport.pageScaleFactor,
    `Reference receipt did not prove the measured ${expectedViewport.width}x${expectedViewport.height} viewport.`,
  );
  assert(
    receipt.roundtrip?.status === "observed" &&
      receipt.roundtrip.exact === true &&
      receipt.roundtrip.reopenedSha256 === receipt.roundtrip.mutatedSha256,
    "Reference receipt did not prove an exact edit/save/exit/reopen roundtrip.",
  );
  const screenshot = receipt.screenshot;
  assert(
    screenshot?.complete === true &&
      screenshot.fromSurface === true &&
      screenshot.captureBeyondViewport === false &&
      Number.isInteger(screenshot.bytes) &&
      screenshot.bytes > 1024 &&
      /^[a-f0-9]{64}$/u.test(screenshot.sha256 ?? "") &&
      Number.isInteger(screenshot.pngWidth) &&
      Number.isInteger(screenshot.pngHeight) &&
      screenshot.pngWidth === expectedViewport.width &&
      screenshot.pngHeight === expectedViewport.height,
    "Reference receipt rejected no truncated/partial surface capture.",
  );
  assert(
    receipt.cleanup?.clean === true &&
      Array.isArray(receipt.processesAfterCleanup) &&
      receipt.processesAfterCleanup.length === 0 &&
      Array.isArray(receipt.appProcessesAfterCleanup) &&
      receipt.appProcessesAfterCleanup.length === 0 &&
      Array.isArray(receipt.referenceProcessesAfterCleanup) &&
      receipt.referenceProcessesAfterCleanup.length === 0 &&
      Array.isArray(receipt.hostCleanup?.markerBefore) &&
      receipt.hostCleanup.markerBefore.length === 0 &&
      Array.isArray(receipt.hostCleanup?.finalMarked) &&
      receipt.hostCleanup.finalMarked.length === 0 &&
      !receipt.hostCleanup?.flatpakBefore?.error &&
      !receipt.hostCleanup?.flatpakAfter?.error &&
      receipt.hostCleanup?.flatpakBefore?.entries?.length === 0 &&
      receipt.hostCleanup?.flatpakAfter?.entries?.length === 0 &&
      receipt.hostCleanup?.clean === true,
    "Reference receipt did not prove complete cleanup.",
  );
  return true;
}

export async function writeHelperScript(rootPath) {
  const helperPath = path.join(rootPath, "harness", "marked-child.mjs");
  await fs.mkdir(path.dirname(helperPath), { recursive: true, mode: 0o700 });
  const source = [
    'import { promises as fs } from "node:fs";',
    'import { spawn } from "node:child_process";',
    "const output = process.argv[2];",
    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { detached: true, stdio: "ignore" });',
    "child.unref();",
    'await fs.writeFile(output, JSON.stringify({ display: process.env.DISPLAY ?? null, childPid: child.pid }) + "\\n", { mode: 0o600 });',
  ].join("\n");
  await fs.writeFile(helperPath, `${source}\n`, { mode: 0o600 });
  await fs.chmod(helperPath, 0o600);
  return helperPath;
}
