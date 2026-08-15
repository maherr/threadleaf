import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const appRoot = process.cwd();
const electronPath = path.join(appRoot, "node_modules", ".bin", "electron");
const fixtureVault = path.join(appRoot, "fixtures", "vaults", "basic");
const hangFixture = path.join(appRoot, "fixtures", "plugins", "threadleaf-hang");
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-plugin-recovery-"));
const vaultPath = path.join(testRoot, "vault");
const userDataPath = path.join(testRoot, "user-data");
const output = [];
let child;
let cdp;
let exited;
const execFileAsync = promisify(execFile);

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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitForReadyPlugins(vaultPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await withTimeout(
      evaluate("window.threadleaf.getSnapshot()"),
      2_000,
      "A workspace snapshot did not resolve within 2 seconds.",
    );
    const commandIds = new Set(snapshot?.commands?.map(({ id }) => id) ?? []);
    if (
      !snapshot?.startup &&
      snapshot?.vault?.path === vaultPath &&
      snapshot?.workspace?.state === "ready" &&
      commandIds.has("threadleaf-hang:hang") &&
      commandIds.has("threadleaf-fixture:threadleaf-fixture-confirm")
    ) {
      return snapshot;
    }
    await delay(50);
  }
  throw new Error("The target vault and both recovery fixtures were not ready in time.");
}

async function runHangCommandThroughPalette(timeoutMs) {
  const invoked = await evaluate(`(() => {
    document.querySelector("#command-trigger")?.click();
    const query = document.querySelector("#palette-query");
    if (!(query instanceof HTMLInputElement)) return false;
    query.value = "hang";
    query.dispatchEvent(new Event("input", { bubbles: true }));
    const option = document.querySelector(
      '[data-command-id="plugin.command.threadleaf-hang:hang"]',
    );
    if (!(option instanceof HTMLButtonElement) || option.disabled) return false;
    option.click();
    return true;
  })()`);
  if (!invoked) {
    throw new Error("The hang command was not reachable through the command palette.");
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await withTimeout(
      evaluate("window.threadleaf.getSnapshot()"),
      2_000,
      "A recovered workspace snapshot did not resolve within 2 seconds.",
    );
    if (
      snapshot?.plugins?.find(({ id }) => id === "threadleaf-hang")?.state === "failed" &&
      snapshot?.resourceDiagnostics?.some(
        ({ reason, operation }) => reason === "operation-deadline" && operation === "run-command",
      )
    ) {
      return snapshot;
    }
    await delay(50);
  }
  throw new Error("The palette command did not recover within its deadline.");
}

async function waitForResourceWarning(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    lastState = await evaluate(`(() => {
      const trigger = document.querySelector("#settings-trigger");
      const dialog = document.querySelector("#shortcut-settings");
      if (trigger instanceof HTMLButtonElement && !trigger.disabled && !dialog?.open) {
        trigger.click();
      }
      if (dialog?.open) {
        document.querySelector("#settings-nav-plugins")?.click();
      }
      return {
        dialogOpen: Boolean(dialog?.open),
        triggerDisabled: trigger instanceof HTMLButtonElement ? trigger.disabled : null,
        warning: document.querySelector("#plugin-warnings")?.textContent?.trim() ?? "",
      };
    })()`);
    if (lastState.warning.includes("run-command exceeded")) {
      return lastState.warning;
    }
    await delay(50);
  }
  throw new Error(
    `The structured resource diagnostic did not reach plugin settings: ${JSON.stringify(lastState)}`,
  );
}

async function rendererProcessIds(rootPid) {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,args="], {
    maxBuffer: 4 * 1024 * 1024,
  });
  const rows = stdout
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/u))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), args: match[3] }));
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  return rows
    .filter((row) => descendants.has(row.pid) && row.args.includes("--type=renderer"))
    .map(({ pid }) => pid)
    .sort((left, right) => left - right);
}

async function waitForRendererProcesses(rootPid, expectedCount, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const processIds = await rendererProcessIds(rootPid);
    if (processIds.length >= expectedCount) {
      return processIds;
    }
    await delay(50);
  }
  throw new Error(`Expected at least ${expectedCount} isolated renderer processes.`);
}

try {
  if (process.platform !== "linux") {
    throw new Error("The plugin recovery integration check currently requires Linux and Xvfb.");
  }
  await fs.access(electronPath);
  await fs.cp(fixtureVault, vaultPath, { recursive: true });
  await fs.mkdir(path.join(vaultPath, ".obsidian", "plugins"), { recursive: true });
  await fs.cp(hangFixture, path.join(vaultPath, ".obsidian", "plugins", "threadleaf-hang"), {
    recursive: true,
  });
  await fs.mkdir(userDataPath, { recursive: true });
  const canonicalVaultPath = await fs.realpath(vaultPath);
  const vaultId = createHash("sha256").update(canonicalVaultPath).digest("hex");
  const fixtureBundle = await fs.readFile(
    path.join(vaultPath, ".obsidian", "plugins", "threadleaf-fixture", "main.js"),
  );
  const hangBundle = await fs.readFile(
    path.join(vaultPath, ".obsidian", "plugins", "threadleaf-hang", "main.js"),
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
            enabledPluginIds: ["threadleaf-fixture", "threadleaf-hang"],
            capabilityGrantsByPlugin: {
              "threadleaf-fixture": {
                bundleSha256: createHash("sha256").update(fixtureBundle).digest("hex"),
                capabilities: ["workspace-ui"],
              },
              "threadleaf-hang": {
                bundleSha256: createHash("sha256").update(hangBundle).digest("hex"),
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
      "--password-store=basic",
      ".",
    ],
    {
      cwd: appRoot,
      env: {
        ...process.env,
        ELECTRON_OZONE_PLATFORM_HINT: "x11",
        THREADLEAF_PLUGIN_OPERATION_TIMEOUT_MS: "350",
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
  const before = await waitForReadyPlugins(canonicalVaultPath, 15_000);
  const rendererPidsBefore = await waitForRendererProcesses(child.pid, 3, 5_000);
  const recovered = await runHangCommandThroughPalette(10_000);
  const resourceWarning = await waitForResourceWarning(5_000);
  const rendererPidsAfter = await waitForRendererProcesses(child.pid, 3, 5_000);
  const survivor = await withTimeout(
    evaluate('window.threadleaf.runCommand("threadleaf-fixture:threadleaf-fixture-confirm")'),
    5_000,
    "The healthy plugin command stopped responding after its sibling timed out.",
  );
  const after = await withTimeout(
    evaluate("window.threadleaf.getSnapshot()"),
    5_000,
    "The recovered workspace snapshot did not resolve within 5 seconds.",
  );
  const reloaded = await withTimeout(
    evaluate(`window.threadleaf.reloadPlugins(${JSON.stringify(before?.vault?.id)})`),
    10_000,
    "Explicit plugin reload did not resolve within 10 seconds.",
  );
  const result = {
    before,
    recovered,
    survivor,
    after,
    reloaded,
    resourceWarning,
    rendererPidsBefore,
    rendererPidsAfter,
  };

  assert(result, "Renderer probe returned no result.");
  assert(
    result.before.commands.some(({ id }) => id === "threadleaf-hang:hang"),
    "Hang command did not load.",
  );
  assert(
    result.before.commands.length === 2,
    "Both disposable plugins must load before the probe.",
  );
  assert(
    result.rendererPidsBefore.length >= 3,
    "The two plugins did not receive separate renderer processes.",
  );
  assert(
    result.rendererPidsAfter.some((pid) => !result.rendererPidsBefore.includes(pid)),
    "The timed-out plugin renderer process was not replaced.",
  );
  assert(
    result.rendererPidsBefore.filter((pid) => result.rendererPidsAfter.includes(pid)).length >= 2,
    "The main and healthy plugin renderer processes did not survive the isolated failure.",
  );
  assert(
    result.recovered.commands.length === 1 &&
      result.recovered.commands[0]?.id === "threadleaf-fixture:threadleaf-fixture-confirm",
    "The isolated recovery did not preserve the healthy plugin command.",
  );
  assert(
    result.recovered.plugins.find(({ id }) => id === "threadleaf-hang")?.state === "failed" &&
      result.recovered.plugins.find(({ id }) => id === "threadleaf-fixture")?.state === "loaded",
    "The isolated recovery did not fail only the culprit plugin.",
  );
  assert(
    result.recovered.notices.at(-1)?.includes("plugin operation was stopped"),
    "The timed-out command did not return an explicit recovery notice.",
  );
  assert(
    result.recovered.resourceDiagnostics?.some(
      ({ reason, operation, configuredBudget }) =>
        reason === "operation-deadline" && operation === "run-command" && configuredBudget === 350,
    ),
    "The non-default run-command deadline was not preserved as a structured diagnostic.",
  );
  assert(
    result.resourceWarning.includes(
      "threadleaf-hang: Compatibility run-command exceeded its 350 ms deadline",
    ),
    "The resource diagnostic did not render with culprit and policy evidence in settings.",
  );
  assert(
    result.survivor.notices.at(-1) === "Fixture command crossed the compatibility bridge.",
    "The healthy plugin did not execute after its sibling timed out.",
  );
  assert(
    result.after.events.some(({ message }) =>
      message.includes("Recovered the compatibility renderer"),
    ),
    "Recovery event did not survive the replacement renderer snapshot.",
  );
  assert(result.after.workspace?.state === "ready", "Native workspace stopped responding.");
  assert(result.reloaded.status === "updated", "Reload all did not return an updated snapshot.");
  assert(
    result.reloaded.snapshot.commands.length === 2 &&
      result.reloaded.snapshot.plugins.every(({ state }) => state === "loaded"),
    "Explicit reload did not reactivate both plugins cleanly.",
  );

  await withTimeout(
    evaluate("setTimeout(() => window.close(), 1000); true"),
    5_000,
    "The main renderer did not acknowledge its close request.",
  );
  const exit = await Promise.race([
    exited,
    delay(10_000).then(() => ({ code: null, signal: "timeout" })),
  ]);
  assert(
    exit.code === 0,
    `Electron did not exit cleanly: ${JSON.stringify(exit)}\n${output.join("")}`,
  );
  console.log(
    "Verified command-palette reachability, one renderer process per plugin, culprit-only timeout recovery, healthy-plugin continuity, native-workspace responsiveness, settings diagnostics, and explicit reload recovery.",
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
