import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

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
  await fs.writeFile(
    path.join(userDataPath, "settings.json"),
    `${JSON.stringify(
      {
        version: 3,
        keyBindings: {},
        appearanceByVault: {},
        pluginsByVault: {
          [vaultId]: {
            compatibilityMode: "enabled",
            enabledPluginIds: ["threadleaf-fixture", "threadleaf-hang"],
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
  const before = await withTimeout(
    evaluate("window.threadleaf.getSnapshot()"),
    5_000,
    "The initial workspace snapshot did not resolve within 5 seconds.",
  );
  const recovered = await withTimeout(
    evaluate('window.threadleaf.runCommand("hang")'),
    10_000,
    "The timed-out command did not recover within 10 seconds.",
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
  const result = { before, recovered, after, reloaded };

  assert(result, "Renderer probe returned no result.");
  assert(
    result.before.commands.some(({ id }) => id === "hang"),
    "Hang command did not load.",
  );
  assert(
    result.before.commands.length === 2,
    "Both disposable plugins must load before the probe.",
  );
  assert(result.recovered.commands.length === 0, "Recovered renderer retained stale commands.");
  assert(
    result.recovered.plugins.length === 2 &&
      result.recovered.plugins.every(({ state }) => state === "failed"),
    "Stopped plugins were not retained as failed diagnostics.",
  );
  assert(
    result.recovered.notices.at(-1)?.includes("plugin operation was stopped"),
    "The timed-out command did not return an explicit recovery notice.",
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
    evaluate("setTimeout(() => window.close(), 0); true"),
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
    "Verified forced plugin-renderer termination, clean replacement, failed-plugin diagnostics, native-workspace responsiveness, and explicit reload recovery.",
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
