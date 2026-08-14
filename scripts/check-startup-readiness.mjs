import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const appRoot = process.cwd();
const electronPath = path.join(appRoot, "node_modules", ".bin", "electron");
const fixtureVault = path.join(appRoot, "fixtures", "vaults", "basic");
const configuredVault = await fs.realpath(
  process.env.THREADLEAF_STARTUP_PROBE_VAULT ?? fixtureVault,
);
const budgetMs = Number.parseInt(process.env.THREADLEAF_STARTUP_BUDGET_MS ?? "5000", 10);
const readyBudgetMs = process.env.THREADLEAF_STARTUP_READY_BUDGET_MS
  ? Number.parseInt(process.env.THREADLEAF_STARTUP_READY_BUDGET_MS, 10)
  : null;
const screenshotDirectory = process.env.THREADLEAF_STARTUP_SCREENSHOT_DIR;
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-startup-readiness-"));
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
  throw new Error(`Threadleaf did not expose its main renderer within ${budgetMs} ms.`);
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

async function waitForRenderedVault(deadline) {
  const expectedName = path.basename(configuredVault) || configuredVault;
  while (Date.now() < deadline) {
    const state = await evaluate(`(async () => {
      const body = document.body;
      const vaultName = document.querySelector("#vault-name");
      const runtimeState = document.querySelector("#runtime-state");
      const indexStatus = document.querySelector("#index-status");
      const filterSummary = document.querySelector("#filter-summary");
      const openVault = document.querySelector("#open-vault");
      const newNote = document.querySelector("#new-note");
      const fileSearch = document.querySelector("#file-search");
      const statusShape = document.querySelector("#status-shape");
      return {
        bodyVisible: Boolean(body && body.getBoundingClientRect().width > 0),
        vaultName: vaultName?.textContent ?? "",
        runtimeState: runtimeState?.textContent ?? "",
        indexStatus: indexStatus?.textContent ?? "",
        filterSummary: filterSummary?.textContent ?? "",
        openVaultDisabled: Boolean(openVault?.disabled),
        newNoteDisabled: Boolean(newNote?.disabled),
        fileSearchDisabled: Boolean(fileSearch?.disabled),
        statusShape: statusShape?.getAttribute("data-state") ?? "",
        snapshot: await window.threadleaf.getSnapshot(),
      };
    })()`);
    const activePath = state.snapshot?.startup?.targetPath ?? state.snapshot?.vault?.path;
    if (state.bodyVisible && state.vaultName === expectedName && activePath === configuredVault) {
      return state;
    }
    await delay(25);
  }
  throw new Error(`Threadleaf did not render ${expectedName} within ${budgetMs} ms.`);
}

async function waitForReadyVault(deadline) {
  while (Date.now() < deadline) {
    const rendered = await evaluate(`(() => ({
      runtimeState: document.querySelector("#runtime-state")?.textContent ?? "",
      vaultPath: document.querySelector("#vault-identity")?.getAttribute("title") ?? "",
    }))()`);
    if (rendered.runtimeState === "Ready" && rendered.vaultPath === configuredVault) {
      return rendered;
    }
    await delay(50);
  }
  throw new Error(
    `Threadleaf did not fully activate ${path.basename(configuredVault) || configuredVault} within ${readyBudgetMs} ms.`,
  );
}

async function verifyVirtualFileWindow() {
  const inspect = () => `(async () => {
    const list = document.querySelector("#file-list");
    const rows = [...document.querySelectorAll("#file-list .virtual-file-row")];
    const positions = rows.map((row) => Number(row.getAttribute("aria-posinset")));
    const total = Number(rows[0]?.getAttribute("aria-setsize") ?? 0);
    return {
      mode: list?.getAttribute("data-mode") ?? "",
      rowCount: rows.length,
      first: positions[0] ?? null,
      last: positions.at(-1) ?? null,
      positions,
      total,
    };
  })()`;
  const before = await evaluate(inspect());
  if (before.total <= 100) {
    return before;
  }
  assert(before.mode === "virtual", "Large-vault file navigation did not enter virtual mode.");
  assert(
    before.rowCount > 0 && before.rowCount <= 64,
    `Large-vault file navigation mounted ${before.rowCount} rows.`,
  );
  assert(
    before.positions.every((position, index) => position === before.first + index),
    "Virtual file rows did not expose consecutive absolute positions.",
  );
  await evaluate(`(async () => {
    const list = document.querySelector("#file-list");
    list.scrollTop = list.scrollHeight;
    list.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
  const after = await evaluate(inspect());
  assert(after.rowCount > 0 && after.rowCount <= 64, "Virtual row count grew after scrolling.");
  assert(after.first > before.first, "Virtual file window did not advance after scrolling.");
  assert(after.last === after.total, "Virtual file window did not reach the final note.");
  assert(
    after.positions.every((position, index) => position === after.first + index),
    "Scrolled virtual rows lost consecutive absolute positions.",
  );
  await evaluate(`(async () => {
    const list = document.querySelector("#file-list");
    list.scrollTop = 0;
    list.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
  return { ...before, scrolledFirst: after.first, scrolledLast: after.last };
}

async function captureTheme(theme, stateName) {
  const themeDeadline = Date.now() + 2_000;
  while (Date.now() < themeDeadline) {
    const current = await evaluate("document.documentElement.dataset.theme");
    if (current === theme) {
      const capture = await cdp.send("Page.captureScreenshot", { format: "png" });
      const outputPath = path.join(screenshotDirectory, `startup-${stateName}-${theme}.png`);
      await fs.writeFile(outputPath, Buffer.from(capture.data, "base64"));
      return outputPath;
    }
    await evaluate('document.querySelector("#theme-toggle")?.click(); true');
    await delay(50);
  }
  throw new Error(`Threadleaf did not switch to ${theme} mode for visual verification.`);
}

try {
  if (process.platform !== "linux") {
    throw new Error("The startup readiness integration check currently requires Linux and Xvfb.");
  }
  assert(Number.isFinite(budgetMs) && budgetMs > 0, "Startup budget must be a positive number.");
  assert(
    readyBudgetMs === null || (Number.isFinite(readyBudgetMs) && readyBudgetMs > 0),
    "Full-ready budget must be a positive number when configured.",
  );
  await fs.access(electronPath);
  await fs.mkdir(userDataPath, { recursive: true });
  const port = await availablePort();
  const startedAt = Date.now();
  const deadline = startedAt + budgetMs;
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
        THREADLEAF_VAULT_PATH: configuredVault,
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

  const target = await waitForMainTarget(port, deadline);
  cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  const state = await waitForRenderedVault(deadline);
  const readyMs = Date.now() - startedAt;
  const opening = state.snapshot?.startup?.phase === "opening";
  if (opening) {
    assert(state.runtimeState === "Opening", "Opening workspace lacked its visible state label.");
    assert(state.indexStatus === "Indexing", "Opening workspace lacked its index progress label.");
    assert(
      state.filterSummary === "Building vault index",
      "Opening workspace exposed fixture file state instead of progress.",
    );
    assert(state.statusShape === "opening", "Opening workspace lacked its non-color status shape.");
    assert(state.newNoteDisabled, "New note remained writable against the bootstrap vault.");
    assert(
      state.fileSearchDisabled,
      "Vault search remained enabled before the target index existed.",
    );
    assert(
      !state.openVaultDisabled,
      "Open vault must remain available to supersede a slow startup.",
    );
  } else {
    assert(
      state.snapshot?.vault?.path === configuredVault,
      "A completed startup rendered a vault other than the configured target.",
    );
  }

  let screenshots = [];
  if (screenshotDirectory) {
    await fs.mkdir(screenshotDirectory, { recursive: true });
    const stateName = opening ? "opening" : "ready";
    screenshots = [await captureTheme("dark", stateName), await captureTheme("light", stateName)];
  }

  let fullReadyMs = opening ? null : readyMs;
  if (readyBudgetMs !== null && opening) {
    await waitForReadyVault(startedAt + readyBudgetMs);
    fullReadyMs = Date.now() - startedAt;
    if (screenshotDirectory) {
      screenshots.push(await captureTheme("dark", "ready"), await captureTheme("light", "ready"));
    }
  }
  const virtualFiles = fullReadyMs === null ? null : await verifyVirtualFileWindow();

  console.log(
    JSON.stringify({
      budgetMs,
      readyBudgetMs,
      readyMs,
      fullReadyMs,
      state: opening ? "opening" : "ready",
      targetName: path.basename(configuredVault) || configuredVault,
      screenshots,
      virtualFiles,
    }),
  );
  await evaluate("setTimeout(() => window.close(), 0); true");
  const exit = await Promise.race([
    exited,
    delay(10_000).then(() => ({ code: null, signal: "timeout" })),
  ]);
  assert(
    exit.code === 0,
    `Electron did not exit cleanly: ${JSON.stringify(exit)}\n${output.join("")}`,
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
