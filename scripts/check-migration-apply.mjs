import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const appRoot = process.cwd();
const electronPath = path.join(appRoot, "node_modules", ".bin", "electron");
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-migration-apply-"));
const vaultPath = path.join(testRoot, "vault");
const userDataPath = path.join(testRoot, "user-data");
const crashUserDataPath = path.join(testRoot, "crash-user-data");
const screenshotDirectory =
  process.env.THREADLEAF_MIGRATION_SCREENSHOT_DIR ?? path.join(testRoot, "screenshots");
const output = [];
let child;
let exited;
let cdp;
let phase = "setup";
let rendererArgv = [];

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
  throw new Error("Threadleaf did not expose its renderer in time.");
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

async function waitFor(probe, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await probe();
    if (lastValue) {
      return lastValue;
    }
    await delay(50);
  }
  throw new Error(`${message}. Last observation: ${JSON.stringify(lastValue)}`);
}

async function descendantProcessRecords(rootPid) {
  const entries = await fs.readdir("/proc", { withFileTypes: true });
  const records = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
      .map(async (entry) => {
        const pid = Number(entry.name);
        try {
          const status = await fs.readFile(`/proc/${pid}/status`, "utf8");
          const parentLine = status.split("\n").find((line) => line.startsWith("PPid:"));
          const parentPid = Number(parentLine?.split(/\s+/u)[1] ?? "-1");
          const command = (await fs.readFile(`/proc/${pid}/cmdline`)).toString("utf8");
          const environment = (await fs.readFile(`/proc/${pid}/environ`))
            .toString("utf8")
            .split("\0")
            .filter(Boolean);
          return {
            pid,
            parentPid,
            command: command.replaceAll("\0", " ").trim(),
            environment,
          };
        } catch {
          return null;
        }
      }),
  );
  const byParent = new Map();
  for (const record of records) {
    if (!record) continue;
    const children = byParent.get(record.parentPid) ?? [];
    children.push(record);
    byParent.set(record.parentPid, children);
  }
  const descendants = [];
  const queue = [rootPid];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const parentPid = queue.shift();
    for (const record of byParent.get(parentPid) ?? []) {
      if (seen.has(record.pid)) continue;
      seen.add(record.pid);
      queue.push(record.pid);
      descendants.push(record);
    }
  }
  return descendants;
}

async function rendererCommandLines(rootPid) {
  return (await descendantProcessRecords(rootPid)).filter((record) =>
    record.command.includes("--type=renderer"),
  );
}

async function assertRendererUsesX11() {
  const renderers = await waitFor(
    async () => {
      const records = await rendererCommandLines(child.pid);
      return records.length > 0 ? records : null;
    },
    "Electron did not expose a renderer process for the X11 argv proof",
    10_000,
  );
  rendererArgv = renderers.map((record) => record.command);
  assert(rendererArgv.length > 0, "No Electron renderer process was found.");
  assert(
    rendererArgv.every(
      (command) =>
        command.includes("--ozone-platform=x11") && !command.includes("--ozone-platform=wayland"),
    ),
    `Renderer argv did not prove X11: ${JSON.stringify(rendererArgv)}`,
  );
  const browser = (await descendantProcessRecords(child.pid)).find(
    (record) =>
      record.command.includes("--remote-debugging-port=") && !record.command.includes("--type="),
  );
  assert(browser, "Electron did not expose its browser process for the Xvfb environment proof.");
  const displayEnvironment = browser.environment.filter(
    (entry) => entry.startsWith("DISPLAY=") || entry.startsWith("WAYLAND_DISPLAY="),
  );
  assert(
    displayEnvironment.some((entry) => /^DISPLAY=:\d+/u.test(entry)) &&
      !displayEnvironment.some((entry) => entry.startsWith("WAYLAND_DISPLAY=")),
    `Electron browser environment did not prove isolated Xvfb without Wayland: ${JSON.stringify(
      displayEnvironment,
    )}`,
  );
}

async function click(selector) {
  await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLButtonElement) || element.disabled) {
      throw new Error("Button is missing or disabled: " + ${JSON.stringify(selector)});
    }
    element.click();
    return true;
  })()`);
}

async function setTheme(theme) {
  await evaluate(`(() => {
    document.documentElement.dataset.theme = ${JSON.stringify(theme)};
    document.documentElement.classList.toggle("theme-light", ${JSON.stringify(theme)} === "light");
    document.documentElement.classList.toggle("theme-dark", ${JSON.stringify(theme)} === "dark");
    document.body.classList.toggle("theme-light", ${JSON.stringify(theme)} === "light");
    document.body.classList.toggle("theme-dark", ${JSON.stringify(theme)} === "dark");
    return document.documentElement.dataset.theme;
  })()`);
}

async function captureScreenshot(name, theme) {
  await setTheme(theme);
  await fs.mkdir(screenshotDirectory, { recursive: true });
  const capture = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  const outputPath = path.join(screenshotDirectory, `${name}-${theme}.png`);
  await fs.writeFile(outputPath, Buffer.from(capture.data, "base64"));
  const stat = await fs.stat(outputPath);
  assert(stat.size > 1_000, `Captured screenshot ${name}-${theme} is unexpectedly small.`);
  return outputPath;
}

async function launchApplication(options = {}) {
  const profilePath = options.profilePath ?? userDataPath;
  const port = await availablePort();
  const childEnvironment = {
    ...process.env,
    ELECTRON_OZONE_PLATFORM_HINT: "x11",
    THREADLEAF_SAFE_PLUGINS: "1",
    THREADLEAF_VAULT_PATH: vaultPath,
  };
  if (options.interruptPhase) {
    childEnvironment.THREADLEAF_MIGRATION_INTERRUPT_PHASE = options.interruptPhase;
  } else {
    delete childEnvironment.THREADLEAF_MIGRATION_INTERRUPT_PHASE;
  }
  delete childEnvironment.WAYLAND_DISPLAY;
  child = spawn(
    "xvfb-run",
    [
      "-a",
      "-s",
      "-screen 0 1440x840x24 -nolisten tcp",
      electronPath,
      "--ozone-platform=x11",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profilePath}`,
      "--disable-gpu",
      ".",
    ],
    {
      cwd: appRoot,
      env: childEnvironment,
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
  await assertRendererUsesX11();
  cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
}

async function waitForApplicationCrash() {
  cdp?.close();
  cdp = undefined;
  const result = await Promise.race([
    exited,
    delay(10_000).then(() => ({ code: null, signal: "timeout" })),
  ]);
  assert(
    result.signal !== "timeout" && (result.code !== 0 || result.signal !== null),
    `Electron did not terminate at the injected interruption: ${JSON.stringify(result)}`,
  );
  child = undefined;
  exited = undefined;
}

async function closeApplication() {
  if (!child) {
    return;
  }
  const forcedClose = !cdp;
  if (cdp) {
    try {
      await evaluate("setTimeout(() => window.close(), 50); true");
    } catch {
      // The renderer can disappear before CDP returns.
    }
  } else {
    child.kill("SIGTERM");
  }
  cdp?.close();
  cdp = undefined;
  let result = await Promise.race([
    exited,
    delay(5_000).then(() => ({ code: null, signal: "timeout" })),
  ]);
  if (result.signal === "timeout") {
    child.kill("SIGKILL");
    result = await exited;
  }
  assert(
    result.code === 0 ||
      (forcedClose && (result.signal === "SIGTERM" || result.signal === "SIGKILL")),
    `Electron did not exit cleanly: ${JSON.stringify(result)}`,
  );
  child = undefined;
  exited = undefined;
}

async function treeManifest(rootPath) {
  const records = new Map();
  async function walk(currentPath, relativePath = "") {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const childRelativePath = relativePath ? path.join(relativePath, entry.name) : entry.name;
      const childPath = path.join(currentPath, entry.name);
      const key = childRelativePath.replaceAll(path.sep, "/");
      if (entry.isDirectory()) {
        records.set(key, { type: "directory" });
        await walk(childPath, childRelativePath);
      } else if (entry.isFile()) {
        records.set(key, { type: "file", bytes: await fs.readFile(childPath) });
      } else if (entry.isSymbolicLink()) {
        records.set(key, { type: "symlink", target: await fs.readlink(childPath) });
      } else {
        records.set(key, { type: "other" });
      }
    }
  }
  await walk(rootPath);
  return records;
}

function assertTreeEqual(expected, actual, action) {
  assert(
    expected.size === actual.size,
    `${action} changed the .obsidian tree size: ${expected.size} vs ${actual.size}.`,
  );
  for (const [relativePath, expectedRecord] of expected) {
    const actualRecord = actual.get(relativePath);
    assert(actualRecord, `${action} removed .obsidian/${relativePath}.`);
    assert(
      actualRecord.type === expectedRecord.type,
      `${action} changed the type of .obsidian/${relativePath}.`,
    );
    if (expectedRecord.type === "file") {
      assert(
        Buffer.compare(expectedRecord.bytes, actualRecord.bytes) === 0,
        `${action} changed .obsidian/${relativePath}.`,
      );
    } else if (expectedRecord.type === "symlink") {
      assert(
        expectedRecord.target === actualRecord.target,
        `${action} changed the target of .obsidian/${relativePath}.`,
      );
    }
  }
}

async function readSettings() {
  return evaluate("window.threadleaf.getSettings()");
}

try {
  assert(process.platform === "linux", "The migration apply rehearsal requires Linux/Xvfb.");
  await fs.access(electronPath);
  const obsidianRoot = path.join(vaultPath, ".obsidian");
  await fs.mkdir(path.join(obsidianRoot, "plugins", "threadleaf-fixture"), { recursive: true });
  await fs.mkdir(path.join(obsidianRoot, "snippets"), { recursive: true });
  await fs.mkdir(path.join(obsidianRoot, "themes", "Threadleaf Fixture"), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(vaultPath, "Welcome.md"), "# Migration fixture\n", "utf8"),
    fs.writeFile(path.join(vaultPath, "Present.md"), "# Present\n", "utf8"),
    fs.writeFile(path.join(vaultPath, "Recovery Target.md"), "# Recovery target\n", "utf8"),
    fs.writeFile(path.join(obsidianRoot, "community-plugins.json"), '["threadleaf-fixture"]\n'),
    fs.writeFile(
      path.join(obsidianRoot, "appearance.json"),
      '{"theme":"obsidian","cssTheme":"","enabledCssSnippets":["fixture-spacing"]}\n',
    ),
    fs.writeFile(
      path.join(obsidianRoot, "hotkeys.json"),
      '{"command-palette:open":[{"modifiers":["Mod","Shift"],"key":"P"}]}\n',
    ),
    fs.writeFile(
      path.join(obsidianRoot, "workspace.json"),
      '{"active":"recovery-target","main":{"type":"tabs","children":[{"type":"leaf","id":"recovery-target","state":{"type":"markdown","state":{"file":"Recovery Target.md","mode":"source"}}}]},"left":{"type":"tabs","children":[]},"right":{"type":"tabs","children":[]}}\n',
    ),
    fs.copyFile(
      path.join(
        appRoot,
        "fixtures/vaults/basic/.obsidian/plugins/threadleaf-fixture/manifest.json",
      ),
      path.join(obsidianRoot, "plugins/threadleaf-fixture/manifest.json"),
    ),
    fs.copyFile(
      path.join(appRoot, "fixtures/vaults/basic/.obsidian/plugins/threadleaf-fixture/main.js"),
      path.join(obsidianRoot, "plugins/threadleaf-fixture/main.js"),
    ),
    fs.copyFile(
      path.join(appRoot, "fixtures/vaults/basic/.obsidian/plugins/threadleaf-fixture/styles.css"),
      path.join(obsidianRoot, "plugins/threadleaf-fixture/styles.css"),
    ),
    fs.writeFile(path.join(obsidianRoot, "snippets/fixture-spacing.css"), "#theme-toggle {}\n"),
    fs.writeFile(path.join(obsidianRoot, "themes/Threadleaf Fixture/theme.css"), "body {}\n"),
  ]);
  const beforeObsidian = await treeManifest(obsidianRoot);

  phase = "injected process interruption";
  await launchApplication({
    profilePath: crashUserDataPath,
    interruptPhase: "workspace-committed",
  });
  const crashRuntime = await waitFor(async () => {
    const snapshot = await evaluate("window.threadleaf.getSnapshot()");
    return snapshot.workspace?.state === "ready" && snapshot.vault?.path === vaultPath
      ? snapshot
      : null;
  }, "The disposable crash-recovery vault did not become ready");
  const crashVaultId = crashRuntime.vault.id;
  const crashWorkspaceBefore = await evaluate('window.threadleaf.openNote("Welcome.md")');
  assert(
    crashWorkspaceBefore.workspace?.activeNote?.path === "Welcome.md",
    "The crash-recovery fixture could not establish a distinct before workspace.",
  );
  const crashReview = await evaluate(
    `window.threadleaf.getMigrationPreview(${JSON.stringify(crashVaultId)})`,
  );
  assert(crashReview.status === "ready", "The crash-recovery migration preview was not ready.");
  const crashSelectedIds = ["hotkey:ui.command-palette", "workspace:tabs"];
  assert(
    crashSelectedIds.every((candidateId) =>
      crashReview.plan.candidates.some(
        (candidate) => candidate.id === candidateId && candidate.status === "ready",
      ),
    ),
    `The crash-recovery fixture did not expose ready settings and workspace candidates: ${JSON.stringify(
      crashReview.plan.candidates,
    )}`,
  );
  const crashRequest = {
    planId: crashReview.plan.planId,
    sourceDigest: crashReview.plan.sourceDigest,
    selectedItemIds: crashSelectedIds,
  };
  await evaluate(`(() => {
    void window.threadleaf.applyMigration(${JSON.stringify(crashVaultId)}, ${JSON.stringify(
      crashRequest,
    )});
    return true;
  })()`);
  await waitForApplicationCrash();
  assertTreeEqual(
    beforeObsidian,
    await treeManifest(obsidianRoot),
    "Injected migration interruption",
  );
  await fs.rm(path.join(vaultPath, "Recovery Target.md"));

  phase = "startup recovery gate";
  await launchApplication({ profilePath: crashUserDataPath });
  const recoveredRuntime = await waitFor(async () => {
    const snapshot = await evaluate("window.threadleaf.getSnapshot()");
    return snapshot.workspace?.state === "ready" && snapshot.vault?.path === vaultPath
      ? snapshot
      : null;
  }, "Startup did not recover the interrupted migration before exposing the vault");
  assert(
    recoveredRuntime.workspace.activeNote === null && recoveredRuntime.workspace.tabs.length === 0,
    "Startup did not prune the deleted target only after the pending workspace phase was recovered.",
  );
  const recoveredSettings = await readSettings();
  assert(
    recoveredSettings.settings.keyBindings["ui.command-palette"] === "Mod+Shift+P",
    "Startup recovery did not retain the committed settings phase.",
  );
  const recoveredJournalDirectory = path.join(
    crashUserDataPath,
    "migration",
    "transactions",
    crashVaultId,
  );
  const recoveredJournalNames = (await fs.readdir(recoveredJournalDirectory)).filter((name) =>
    name.endsWith(".json"),
  );
  assert(recoveredJournalNames.length === 1, "Startup recovery left an unexpected journal count.");
  const recoveredJournal = JSON.parse(
    await fs.readFile(path.join(recoveredJournalDirectory, recoveredJournalNames[0]), "utf8"),
  );
  assert(
    recoveredJournal.phase === "committed",
    `Startup recovery did not commit the journal receipt: ${recoveredJournal.phase}`,
  );
  await closeApplication();
  assertTreeEqual(beforeObsidian, await treeManifest(obsidianRoot), "Startup recovery");

  phase = "isolated X11 launch and preview";
  await launchApplication();
  const runtime = await waitFor(async () => {
    const snapshot = await evaluate("window.threadleaf.getSnapshot()");
    return snapshot.workspace?.state === "ready" && snapshot.vault?.path === vaultPath
      ? snapshot
      : null;
  }, "The disposable migration vault did not become ready");
  const vaultId = runtime.vault.id;
  assert(/^[a-f0-9]{64}$/u.test(vaultId), "The live vault identity was not a SHA-256 value.");

  await click("#settings-trigger");
  await waitFor(
    () => evaluate('document.querySelector("#shortcut-settings")?.open === true'),
    "Settings dialog did not open",
  );
  await click("#settings-nav-migration");
  await waitFor(
    () =>
      evaluate(
        'document.querySelector("#migration-review-summary")?.textContent?.includes("ready") && document.querySelector("#migration-refresh")?.disabled === false',
      ),
    "Reviewed migration plan did not render",
  );
  await delay(750);
  const renderedPlanId = await evaluate(
    'document.querySelector("#migration-review-receipt")?.dataset.planId ?? ""',
  );
  const liveReview = await evaluate(
    `window.threadleaf.getMigrationPreview(${JSON.stringify(vaultId)})`,
  );
  assert(liveReview.status === "ready", "The live migration preview was not ready before apply.");
  assert(
    renderedPlanId === liveReview.plan.planId,
    `The rendered plan drifted before apply: ${renderedPlanId} vs ${liveReview.plan.planId}`,
  );
  const candidates =
    await evaluate(`([...document.querySelectorAll(".migration-candidate")]).map((row) => ({
    id: row.dataset.candidateId,
    state: row.dataset.state,
    text: row.textContent ?? "",
    disabled: row.querySelector("input")?.disabled ?? true,
  }))`);
  const hotkey = candidates.find((candidate) => candidate.id === "hotkey:ui.command-palette");
  const plugin = candidates.find((candidate) => candidate.id === "plugin:threadleaf-fixture");
  assert(
    hotkey?.state === "ready" && hotkey.disabled === false,
    "Ready hotkey candidate was not selectable.",
  );
  assert(
    plugin?.state === "conflict" && plugin.disabled === true,
    "Plugin grant conflict was not visible or locked.",
  );
  const settingsBefore = await readSettings();
  assert(
    !JSON.stringify(candidates).includes("apiToken") &&
      !JSON.stringify(candidates).includes("private"),
    "Migration candidate UI exposed a private plugin setting value.",
  );
  await evaluate(`(() => {
    const input = document.querySelector('[data-candidate-id="hotkey:ui.command-palette"] input');
    if (!(input instanceof HTMLInputElement)) throw new Error("Hotkey checkbox missing.");
    input.focus();
    return true;
  })()`);
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: " ",
    code: "Space",
    windowsVirtualKeyCode: 32,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: " ",
    code: "Space",
    windowsVirtualKeyCode: 32,
  });
  await waitFor(
    () =>
      evaluate(
        'document.querySelector("[data-candidate-id=\\"hotkey:ui.command-palette\\"] input")?.checked === true',
      ),
    "Keyboard selection did not check the hotkey candidate",
  );
  assert(
    (await evaluate("document.activeElement?.dataset?.candidateId ?? null")) ===
      "hotkey:ui.command-palette",
    "Migration selection did not restore keyboard focus after rendering.",
  );
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
  });
  const secondCandidateId = await waitFor(
    () => evaluate("document.activeElement?.dataset?.candidateId ?? null"),
    "Tab did not reach a second ready migration candidate",
  );
  assert(
    secondCandidateId !== "hotkey:ui.command-palette",
    "Tab remained on the first migration candidate.",
  );
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: " ",
    code: "Space",
    windowsVirtualKeyCode: 32,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: " ",
    code: "Space",
    windowsVirtualKeyCode: 32,
  });
  await waitFor(
    () =>
      evaluate(
        `document.querySelector('input[data-candidate-id=${JSON.stringify(secondCandidateId)}]')?.checked === true`,
      ),
    "Keyboard selection did not check the second migration candidate",
  );
  await evaluate(
    'document.querySelector("#migration-candidate-list")?.scrollIntoView({ block: "start" }); true',
  );
  const screenshots = [
    await captureScreenshot("migration-review", "dark"),
    await captureScreenshot("migration-review", "light"),
  ];
  const positiveControlPath = path.join(
    screenshotDirectory,
    "migration-review-positive-control-dark.png",
  );
  await setTheme("dark");
  await evaluate(`(() => {
    const target = document.querySelector('[data-candidate-id="hotkey:ui.command-palette"]');
    if (!(target instanceof HTMLElement)) throw new Error("Migration visual positive-control target missing.");
    target.dataset.visualPositiveControl = "true";
    target.style.outline = "8px solid rgb(255, 0, 255)";
    target.style.outlineOffset = "-8px";
    return true;
  })()`);
  await fs.mkdir(screenshotDirectory, { recursive: true });
  const positiveControlCapture = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  });
  await fs.writeFile(positiveControlPath, Buffer.from(positiveControlCapture.data, "base64"));
  const baselineBytes = await fs.readFile(screenshots[0]);
  const positiveControlBytes = await fs.readFile(positiveControlPath);
  assert(
    Buffer.compare(baselineBytes, positiveControlBytes) !== 0,
    "Migration visual positive control did not change the captured pixels.",
  );
  screenshots.push(positiveControlPath);
  await evaluate(`(() => {
    const target = document.querySelector('[data-visual-positive-control="true"]');
    target?.removeAttribute("style");
    target?.removeAttribute("data-visual-positive-control");
    return true;
  })()`);
  await evaluate(`(() => {
    window.resizeTo(860, 640);
    const content = document.querySelector(".settings-content");
    if (content instanceof HTMLElement) content.scrollTop = content.scrollHeight;
    return true;
  })()`);
  await waitFor(
    () =>
      evaluate(`(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        rollbackVisible: Boolean(document.querySelector("#migration-rollback")?.getBoundingClientRect().height),
      }))()`),
    "Minimum-size migration view did not produce viewport metrics",
  );
  const minimumViewport = await evaluate(`(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    rollbackVisible: Boolean(document.querySelector("#migration-rollback")?.getBoundingClientRect().height),
  }))()`);
  assert(minimumViewport.width <= 860, "Minimum-size migration viewport did not resize.");
  assert(
    minimumViewport.overflow === false,
    "Minimum-size migration view overflowed horizontally.",
  );
  assert(minimumViewport.rollbackVisible, "Rollback control was unreachable at minimum size.");
  screenshots.push(
    await captureScreenshot("migration-review-minimum", "dark"),
    await captureScreenshot("migration-review-minimum", "light"),
  );
  await evaluate("window.resizeTo(1280, 760); true");

  phase = "reviewed apply and byte boundary";
  await click("#migration-apply");
  await waitFor(
    () =>
      evaluate(
        'document.querySelector("#migration-apply-status")?.textContent?.includes("private") === false && document.querySelector("#migration-review-receipt")?.textContent?.startsWith("Transaction")',
      ),
    "Reviewed migration apply did not finish",
    45_000,
  );
  const settingsAfterApply = await readSettings();
  assert(
    settingsAfterApply.settings.keyBindings["ui.command-palette"] === "Mod+Shift+P",
    "Reviewed hotkey selection did not update private settings.",
  );
  assert(
    JSON.stringify(settingsAfterApply).includes("Mod+Shift+P") &&
      !JSON.stringify(settingsAfterApply).includes("apiToken"),
    "Apply returned an unsafe settings payload.",
  );
  const afterApplyObsidian = await treeManifest(obsidianRoot);
  assertTreeEqual(beforeObsidian, afterApplyObsidian, "Apply");

  phase = "restart recovery and rollback";
  await closeApplication();
  await launchApplication();
  await waitFor(async () => {
    const snapshot = await evaluate("window.threadleaf.getSnapshot()");
    return snapshot.workspace?.state === "ready" && snapshot.vault?.path === vaultPath
      ? snapshot
      : null;
  }, "The migration vault did not recover after restart");
  await click("#settings-trigger");
  await waitFor(
    () => evaluate('document.querySelector("#shortcut-settings")?.open === true'),
    "Settings dialog did not reopen",
  );
  await click("#settings-nav-migration");
  await waitFor(
    () => evaluate('document.querySelector("#migration-rollback")?.disabled === false'),
    "Committed migration rollback was not restored after restart",
  );
  await click("#migration-rollback");
  await waitFor(
    async () => {
      const settings = await readSettings();
      return settings.settings.keyBindings["ui.command-palette"] === "Mod+K" ? settings : null;
    },
    "Rollback did not restore the before snapshot",
    45_000,
  );
  const afterRollbackObsidian = await treeManifest(obsidianRoot);
  assertTreeEqual(beforeObsidian, afterRollbackObsidian, "Rollback");
  const settingsAfterRollback = await readSettings();
  assert(
    settingsAfterRollback.settings.appearanceByVault[vaultId] === undefined,
    "Rollback did not restore untouched appearance state.",
  );
  assert(
    settingsBefore.settings.keyBindings["ui.command-palette"] ===
      settingsAfterRollback.settings.keyBindings["ui.command-palette"],
    "Rollback did not match the original private settings.",
  );
  screenshots.push(
    await captureScreenshot("migration-rollback", "dark"),
    await captureScreenshot("migration-rollback", "light"),
  );

  console.log(
    JSON.stringify({
      vaultId,
      rendererArgv,
      candidates,
      selectedViaKeyboard: true,
      pluginConflictLocked: true,
      appliedAndRestarted: true,
      rolledBack: true,
      obsidianBytesPreserved: true,
      screenshots,
    }),
  );
  await closeApplication();
} catch (error) {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(
    `Migration apply Electron check failed during ${phase}: ${detail}\n${output.join("")}\n`,
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
