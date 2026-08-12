import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const appRoot = process.cwd();
const electronPath = path.join(appRoot, "node_modules", ".bin", "electron");
const fixtureVault = path.join(appRoot, "fixtures", "vaults", "basic");
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-editor-reliability-"));
const vaultPath = path.join(testRoot, "vault");
const userDataPath = path.join(testRoot, "user-data");
const screenshotDirectory = process.env.THREADLEAF_EDITOR_SCREENSHOT_DIR;
const output = [];
let child;
let cdp;
let exited;
let phase = "setup";
const processMarker = randomUUID();

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function markedProcessIds() {
  const entries = await fs.readdir("/proc");
  const marker = Buffer.from(`THREADLEAF_EDITOR_RELIABILITY_RUN=${processMarker}\0`);
  const matches = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    const pid = Number.parseInt(entry, 10);
    try {
      const environment = await fs.readFile(`/proc/${pid}/environ`);
      if (environment.includes(marker)) {
        matches.push(pid);
      }
    } catch {
      // Processes can leave between directory enumeration and the read.
    }
  }
  return matches;
}

async function terminateMarkedProcesses() {
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const pids = await markedProcessIds();
      if (pids.length === 0) {
        return;
      }
      for (const pid of pids) {
        try {
          process.kill(pid, signal);
        } catch {
          // The process already exited.
        }
      }
      await delay(100);
    }
  }
  const remaining = await markedProcessIds();
  assert(remaining.length === 0, `Could not stop test processes: ${remaining.join(", ")}`);
}

async function findMainRendererPid() {
  const entries = await fs.readdir("/proc");
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    const pid = Number.parseInt(entry, 10);
    try {
      const commandLine = await fs.readFile(`/proc/${pid}/cmdline`, "utf8");
      if (
        commandLine.includes(`--user-data-dir=${userDataPath}`) &&
        commandLine.includes("--type=renderer") &&
        !commandLine.includes("--no-sandbox")
      ) {
        return pid;
      }
    } catch {
      // The process already exited.
    }
  }
  return null;
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
      // The renderer or debugging endpoint is still restarting.
    }
    await delay(50);
  }
  throw new Error("Threadleaf did not expose its main renderer in time.");
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

async function waitForLiveMainCdp(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    let candidate;
    try {
      const target = await waitForMainTarget(port, Math.min(1_000, deadline - Date.now()));
      candidate = connectCdp(target.webSocketDebuggerUrl);
      const response = await Promise.race([
        candidate.send("Runtime.evaluate", {
          expression: "document.readyState",
          returnByValue: true,
        }),
        delay(500).then(() => {
          throw new Error("The candidate renderer did not answer CDP.");
        }),
      ]);
      if (response.result?.value) {
        return candidate;
      }
    } catch (error) {
      lastError = error;
      candidate?.close();
      await delay(50);
    }
  }
  throw new Error(
    `Threadleaf did not expose a live replacement renderer: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
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

const editorStateExpression = `(() => {
  const root = document.querySelector('[data-pane-id="primary"]');
  if (!(root instanceof HTMLElement)) return null;
  return {
    path: root.querySelector('[id^="note-path"]')?.textContent ?? "",
    text: [...root.querySelectorAll(".cm-content .cm-line")]
      .map((line) => line.textContent ?? "")
      .join("\\n"),
    editState: root.querySelector('[id^="edit-state"]')?.textContent ?? "",
    draftState: root.querySelector('[id^="edit-state"]')?.getAttribute("data-draft-state") ?? "",
    noticeTitle: root.querySelector('[id^="edit-notice-title"]')?.textContent ?? "",
    theme: document.documentElement.dataset.theme ?? "",
    ready: document.querySelector("#runtime-state")?.textContent === "Ready",
  };
})()`;

async function editorState() {
  return evaluate(editorStateExpression);
}

async function waitForNote(notePath) {
  return waitFor(async () => {
    const state = await editorState();
    return state.ready && state.path === notePath ? state : null;
  }, `Threadleaf did not render ${notePath}`);
}

async function openNote(notePath) {
  await evaluate(`window.threadleaf.openNote(${JSON.stringify(notePath)})`);
  return waitForNote(notePath);
}

async function focusEditor() {
  await evaluate(`(() => {
    const editor = document.querySelector('[data-pane-id="primary"] .cm-content');
    if (!(editor instanceof HTMLElement)) throw new Error("CodeMirror content is unavailable.");
    editor.focus();
  })()`);
}

async function pressKey(key, code, modifiers = 0) {
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code,
    modifiers,
    windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : undefined,
  });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
}

async function insertText(text) {
  await cdp.send("Input.insertText", { text });
}

async function composeText(text) {
  await cdp.send("Input.imeSetComposition", {
    text,
    selectionStart: text.length,
    selectionEnd: text.length,
  });
  await cdp.send("Input.insertText", { text });
}

async function waitForDraftSaved(expectedText) {
  let lastState;
  try {
    return await waitFor(async () => {
      const state = await editorState();
      lastState = state;
      return state.text === expectedText && state.draftState === "saved" ? state : null;
    }, "The exact editor draft was not protected");
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} Expected ${JSON.stringify(expectedText)}, observed ${JSON.stringify(lastState)}.`,
      { cause: error },
    );
  }
}

async function captureScreenshot(name) {
  if (!screenshotDirectory) {
    return;
  }
  await fs.mkdir(screenshotDirectory, { recursive: true });
  const result = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  await fs.writeFile(path.join(screenshotDirectory, `${name}.png`), result.data, "base64");
}

try {
  if (process.platform !== "linux") {
    throw new Error("The editor reliability integration check currently requires Linux and Xvfb.");
  }
  await fs.access(electronPath);
  await fs.cp(fixtureVault, vaultPath, { recursive: true });
  await fs.mkdir(userDataPath, { recursive: true });
  const canonicalVaultPath = await fs.realpath(vaultPath);
  const vaultId = createHash("sha256").update(canonicalVaultPath).digest("hex");
  await fs.writeFile(
    path.join(userDataPath, "settings.json"),
    `${JSON.stringify(
      {
        version: 4,
        keyBindings: {},
        appearanceByVault: {},
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
        THREADLEAF_EDITOR_RELIABILITY_RUN: processMarker,
        THREADLEAF_SAFE_PLUGINS: "1",
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
      if (output.length > 120) {
        output.shift();
      }
    });
  }
  await started;
  cdp = await waitForLiveMainCdp(port);
  phase = "vault readiness";
  await waitFor(async () => {
    const snapshot = await evaluate("window.threadleaf.getSnapshot()");
    return snapshot?.workspace?.state === "ready" && snapshot?.vault?.path === canonicalVaultPath;
  }, "The writable fixture vault did not become ready");

  phase = "Unicode composition";
  await openNote("Welcome.md");
  await focusEditor();
  await pressKey("End", "End", 2);
  const prefix = "\n\nComposition: ";
  await insertText(prefix);
  const compositionBase = (await editorState()).text;
  await composeText("日本語");
  const composed = `${compositionBase}日本語`;
  await waitForDraftSaved(composed);

  await delay(700);
  await insertText(" undo-marker");
  const withUndoMarker = `${composed} undo-marker`;
  await waitForDraftSaved(withUndoMarker);
  phase = "undo and redo";
  await pressKey("z", "KeyZ", 2);
  await delay(100);
  const undoState = await editorState();
  assert(
    undoState.text === composed,
    `Undo did not restore the prior Unicode editor state: ${JSON.stringify(undoState)}.`,
  );
  await pressKey("Z", "KeyZ", 2 | 8);
  await waitForDraftSaved(withUndoMarker);

  phase = "save selection";
  await pressKey("s", "KeyS", 2);
  await waitFor(async () => {
    const state = await editorState();
    return state.editState === "Saved" && state.text === withUndoMarker ? state : null;
  }, "Saving reset or failed to commit the editor");
  await pressKey("ArrowLeft", "ArrowLeft");
  await pressKey("ArrowLeft", "ArrowLeft");
  await pressKey("ArrowLeft", "ArrowLeft");
  await pressKey("ArrowLeft", "ArrowLeft");
  await insertText("[CURSOR]");
  const cursorExpected = `${withUndoMarker.slice(0, -4)}[CURSOR]${withUndoMarker.slice(-4)}`;
  await waitForDraftSaved(cursorExpected);
  await pressKey("z", "KeyZ", 2);
  await waitFor(async () => {
    const state = await editorState();
    return state.editState === "Saved" && state.text === withUndoMarker ? state : null;
  }, "Undoing to the saved baseline did not clear dirty state");

  phase = "cross-note history";
  const linkedBefore = await fs.readFile(path.join(vaultPath, "Linked Note.md"), "utf8");
  await openNote("Linked Note.md");
  await focusEditor();
  await pressKey("z", "KeyZ", 2);
  assert(
    (await editorState()).text === linkedBefore,
    "Undo history crossed from Welcome.md into Linked Note.md.",
  );

  phase = "external conflict";
  await openNote("Welcome.md");
  await focusEditor();
  await pressKey("End", "End", 2);
  await insertText("\nlocal-conflict");
  const localConflict = `${withUndoMarker}\nlocal-conflict`;
  await waitForDraftSaved(localConflict);
  await evaluate(`
    document.querySelector('[data-note-path="Linked Note.md"]')?.click();
    true;
  `);
  await delay(150);
  assert(
    (await editorState()).path === "Welcome.md" && (await editorState()).text === localConflict,
    "Dirty note navigation discarded or hid the protected editor state.",
  );
  const externalWelcome = `${withUndoMarker}\nexternal-change`;
  await fs.writeFile(path.join(vaultPath, "Welcome.md"), externalWelcome, "utf8");
  await waitFor(
    async () => (await editorState()).editState === "Unsaved, disk changed",
    "An external edit did not produce a visible dirty conflict",
  );
  await pressKey("s", "KeyS", 2);
  const conflictState = await waitFor(async () => {
    const state = await editorState();
    return state.editState === "Saved" && state.path !== "Welcome.md" ? state : null;
  }, "Saving a stale draft did not activate a preserved conflict note");
  assert(conflictState.text === localConflict, "The conflict note did not preserve local bytes.");
  assert(
    (await fs.readFile(path.join(vaultPath, "Welcome.md"), "utf8")) === externalWelcome,
    "The stale save overwrote the external disk version.",
  );

  phase = "protected crash draft";
  await focusEditor();
  await pressKey("End", "End", 2);
  await insertText("\ncrash-draft-TAIL");
  await pressKey("ArrowLeft", "ArrowLeft");
  await pressKey("ArrowLeft", "ArrowLeft");
  await pressKey("ArrowLeft", "ArrowLeft");
  await pressKey("ArrowLeft", "ArrowLeft");
  const beforeCrash = `${localConflict}\ncrash-draft-TAIL`;
  await waitForDraftSaved(beforeCrash);
  await captureScreenshot("draft-protected-dark");

  phase = "renderer crash";
  const mainRendererPid = await waitFor(
    findMainRendererPid,
    "Could not identify the sandboxed main renderer process",
  );
  process.kill(mainRendererPid, "SIGKILL");
  cdp.close();
  await delay(200);
  phase = "replacement renderer attachment";
  cdp = await waitForLiveMainCdp(port);
  phase = "draft recovery";
  const recovered = await waitFor(
    async () => {
      const state = await editorState();
      return state.ready && state.draftState === "saved" && state.text === beforeCrash
        ? state
        : null;
    },
    "The reloaded renderer did not recover the exact protected draft",
    15_000,
  );
  assert(
    recovered.noticeTitle.startsWith("Recovered"),
    "Recovered draft state did not explain itself visibly.",
  );
  await focusEditor();
  await insertText("[HERE]");
  const recoveredSelectionExpected = `${localConflict}\ncrash-draft-[HERE]TAIL`;
  await waitForDraftSaved(recoveredSelectionExpected);
  assert(
    (await editorState()).text === recoveredSelectionExpected,
    "The recovered CodeMirror selection moved.",
  );
  await captureScreenshot("draft-recovered-dark");
  await evaluate("document.querySelector('#theme-toggle')?.click(); true");
  await waitFor(async () => (await editorState()).theme === "light", "Light theme did not apply");
  await captureScreenshot("draft-recovered-light");

  phase = "recovered draft save";
  await pressKey("s", "KeyS", 2);
  const finalState = await waitFor(async () => {
    const state = await editorState();
    return state.editState === "Saved" && state.text === recoveredSelectionExpected ? state : null;
  }, "The recovered draft did not save cleanly");
  assert(
    (await fs.readFile(path.join(vaultPath, finalState.path), "utf8")) ===
      recoveredSelectionExpected,
    "The saved recovered draft does not match the editor bytes.",
  );
  await waitFor(async () => {
    try {
      const entries = await fs.readdir(path.join(userDataPath, "editor-drafts"));
      return entries.length === 0;
    } catch (error) {
      return error instanceof Error && "code" in error && error.code === "ENOENT";
    }
  }, "The committed private draft was not cleared");

  phase = "clean exit";
  await evaluate("setTimeout(() => window.close(), 250); true");
  const exit = await Promise.race([
    exited,
    delay(10_000).then(() => ({ code: null, signal: "timeout" })),
  ]);
  assert(exit.code === 0, `Electron did not exit cleanly: ${JSON.stringify(exit)}`);
  console.log(
    "Verified Unicode composition, undo/redo, save selection, cross-note history isolation, external conflict preservation, renderer-crash draft recovery, selection recovery, and clean save/reopen bytes.",
  );
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  const logs = output.join("").trim();
  const phased = `Phase ${phase}: ${detail}`;
  throw new Error(logs ? `${phased}\nElectron output:\n${logs}` : phased, { cause: error });
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
  await terminateMarkedProcesses();
  await fs.rm(testRoot, { recursive: true, force: true });
}
