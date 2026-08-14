import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { captureSurface, cdpTargets, connectCdp, evaluate } from "./cdp.mjs";
import { snapshotTree, writeManifest } from "./manifest.mjs";
import {
  assertMarkerAbsent,
  captureChildOutput,
  markedProcesses,
  reservePort,
  terminateMarkedProcesses,
  waitForExit,
} from "./process.mjs";

export const THREADLEAF_CELL_ID = "THREADLEAF-01";
export const THREADLEAF_EDIT = "THREADLEAF_OBSIDIAN_LAB_CANDIDATE_EDIT_V1";
export const THREADLEAF_MUTATION = Object.freeze({
  REMOVE_EDITOR: "remove-editor",
  REMOVE_THEN_REINSERT_EDITOR: "remove-then-reinsert-editor",
});
export const THREADLEAF_EDITOR_UNAVAILABLE = "Threadleaf CodeMirror editor is unavailable.";

const fixtureNote = "00 Overview.md";
const viewport = { width: 800, height: 650, deviceScaleFactor: 1, pageScale: 1 };
const targetSuffix = "/dist/renderer/index.html";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function strictDescendant(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== "..";
}

function bounded(promise, label, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)),
      timeoutMs,
    );
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function pngDimensions(bytes) {
  assert(
    bytes.subarray(0, 8).equals(Buffer.from("\x89PNG\r\n\x1a\n", "binary")),
    "Candidate surface is not a PNG.",
  );
  assert(bytes.length >= 24, "Candidate PNG was truncated before its IHDR dimensions.");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

export function threadleafLaunchArgs({ electronPath, userDataPath, cdpPort }) {
  return [
    "-a",
    "-s",
    "-screen 0 1440x840x24 -nolisten tcp",
    electronPath,
    "--ozone-platform=x11",
    "--disable-gpu",
    "--disable-background-networking",
    "--disable-component-update",
    "--no-first-run",
    `--window-size=${viewport.width},${viewport.height}`,
    `--remote-debugging-port=${cdpPort}`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-allow-origins=http://127.0.0.1:${cdpPort}`,
    `--user-data-dir=${userDataPath}`,
    "--password-store=basic",
    ".",
  ];
}

export function assertThreadleafLaunchArgs(args, { runRoot, electronPath, userDataPath, cdpPort }) {
  assert(Array.isArray(args), "Threadleaf launch arguments must be an array.");
  assert(
    strictDescendant(runRoot, userDataPath),
    "Threadleaf profile escaped the dedicated run root.",
  );
  // Keep this oracle independently written from threadleafLaunchArgs(). If the
  // generator and this assertion shared one value, a weakened launch policy
  // could make both drift together and still pass its own check.
  const expected = [
    "-a",
    "-s",
    "-screen 0 1440x840x24 -nolisten tcp",
    electronPath,
    "--ozone-platform=x11",
    "--disable-gpu",
    "--disable-background-networking",
    "--disable-component-update",
    "--no-first-run",
    `--window-size=${viewport.width},${viewport.height}`,
    `--remote-debugging-port=${cdpPort}`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-allow-origins=http://127.0.0.1:${cdpPort}`,
    `--user-data-dir=${userDataPath}`,
    "--password-store=basic",
    ".",
  ];
  assert(
    args.length === expected.length,
    `Threadleaf launch argument count changed: expected ${expected.length}, got ${args.length}.`,
  );
  for (const [index, value] of expected.entries()) {
    assert(
      args[index] === value,
      `Threadleaf launch argument ${index} changed: expected ${JSON.stringify(value)}, got ${JSON.stringify(args[index])}.`,
    );
  }
  assert(
    !args.includes("--no-sandbox"),
    "Threadleaf candidate launch disabled Chromium sandboxing.",
  );
  assert(
    !args.some(
      (argument) =>
        String(argument).startsWith("--remote-debugging-address=") &&
        argument !== "--remote-debugging-address=127.0.0.1",
    ),
    "Threadleaf candidate CDP endpoint escaped loopback.",
  );
  return true;
}

async function waitForThreadleafCdp(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "CDP target was not available";
  while (Date.now() < deadline) {
    let cdp;
    try {
      const target = (await cdpTargets(port)).find(
        (candidate) =>
          candidate.type === "page" &&
          typeof candidate.url === "string" &&
          candidate.url.includes(targetSuffix) &&
          typeof candidate.webSocketDebuggerUrl === "string",
      );
      if (!target) {
        lastError = "Threadleaf renderer target was not listed";
      } else {
        cdp = connectCdp(target.webSocketDebuggerUrl);
        const readyState = await bounded(
          evaluate(cdp, "document.readyState"),
          "Threadleaf renderer readiness",
          1_000,
        );
        if (readyState) return { cdp, target };
        lastError = "Threadleaf renderer did not report a ready state";
      }
    } catch (error) {
      lastError = String(error);
    }
    cdp?.close();
    await delay(100);
  }
  throw new Error(`Threadleaf did not expose its production renderer: ${lastError}`);
}

const candidateStateExpression = `(() => {
  const pane = document.querySelector('[data-pane-id="primary"]');
  const editor = pane?.querySelector('.cm-content[contenteditable="true"]');
  const notePath = pane?.querySelector('[id^="note-path"]')?.textContent ?? '';
  const editState = pane?.querySelector('[id^="edit-state"]');
  const visibleText = (document.body?.innerText ?? '').slice(0, 2400);
  return {
    ready: document.querySelector('#runtime-state')?.textContent === 'Ready',
    path: notePath,
    editorPresent: editor instanceof HTMLElement,
    fixtureEntryPresent:
      document.querySelector('[data-note-path="00 Overview.md"]') instanceof HTMLElement,
    editorText: [...(editor?.querySelectorAll('.cm-line') ?? [])]
      .map((line) => line.textContent ?? '')
      .join('\\n')
      .slice(0, 8192),
    editState: editState?.textContent ?? '',
    draftState: editState?.getAttribute('data-draft-state') ?? '',
    visibleText,
    viewport: {
      width: innerWidth,
      height: innerHeight,
      deviceScaleFactor: devicePixelRatio,
      pageScale: visualViewport?.scale ?? 1,
    },
  };
})()`;

async function candidateState(cdp) {
  const state = await bounded(evaluate(cdp, candidateStateExpression), "Threadleaf visible state");
  assert(
    state && typeof state === "object",
    "Threadleaf returned no bounded visible-state projection.",
  );
  return state;
}

async function waitForCandidate(cdp, { requireEdit = false, requireNote = true } = {}) {
  const deadline = Date.now() + 20_000;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const state = await candidateState(cdp);
      last = state;
      if (
        state.ready === true &&
        state.editorPresent === true &&
        state.fixtureEntryPresent === true &&
        (!requireNote ||
          (state.path === fixtureNote &&
            state.visibleText.includes("THREADLEAF_OBSIDIAN_LAB_FIXTURE_V1"))) &&
        (!requireEdit || state.visibleText.includes(THREADLEAF_EDIT))
      ) {
        return state;
      }
    } catch (error) {
      last = { error: String(error) };
    }
    await delay(100);
  }
  throw new Error(`Threadleaf fixture predicate did not stabilize: ${JSON.stringify(last)}`);
}

async function openFixtureNote(cdp) {
  const hitTarget = await bounded(
    evaluate(
      cdp,
      `(() => {
        const entry = document.querySelector('[data-note-path="00 Overview.md"]');
        if (!(entry instanceof HTMLElement)) return { present: false };
        const rect = entry.getBoundingClientRect();
        const x = Math.round(rect.left + rect.width / 2);
        const y = Math.round(rect.top + rect.height / 2);
        const hit = document.elementFromPoint(x, y);
        return {
          present: true,
          x,
          y,
          clickable:
            rect.width > 0 &&
            rect.height > 0 &&
            (hit === entry || entry.contains(hit)),
        };
      })()`,
    ),
    "Threadleaf fixture-note target",
  );
  assert(
    hitTarget?.present === true && hitTarget.clickable === true,
    "Threadleaf fixture note was not reachable through its visible navigation target.",
  );
  for (const type of ["mousePressed", "mouseReleased"]) {
    await bounded(
      cdp.send("Input.dispatchMouseEvent", {
        type,
        x: hitTarget.x,
        y: hitTarget.y,
        button: "left",
        buttons: type === "mousePressed" ? 1 : 0,
        clickCount: 1,
      }),
      `Threadleaf fixture-note ${type}`,
    );
  }
}

async function focusEditor(cdp) {
  const focused = await bounded(
    evaluate(
      cdp,
      `(() => {
        const editor = document.querySelector('[data-pane-id="primary"] .cm-content[contenteditable="true"]');
        if (!(editor instanceof HTMLElement)) throw new Error(${JSON.stringify(THREADLEAF_EDITOR_UNAVAILABLE)});
        editor.focus();
        return document.activeElement === editor;
      })()`,
    ),
    "Threadleaf editor focus",
  );
  assert(focused === true, "Threadleaf production editor did not accept focus.");
}

async function sendKey(cdp, key, code, windowsVirtualKeyCode, modifiers = 0) {
  await bounded(
    cdp.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key,
      code,
      modifiers,
      windowsVirtualKeyCode,
      nativeVirtualKeyCode: windowsVirtualKeyCode,
    }),
    `Threadleaf key-down ${key}`,
  );
  await bounded(
    cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      modifiers,
      windowsVirtualKeyCode,
      nativeVirtualKeyCode: windowsVirtualKeyCode,
    }),
    `Threadleaf key-up ${key}`,
  );
}

async function waitForExactBytes(notePath, expectedBytes) {
  const deadline = Date.now() + 10_000;
  let actual = null;
  while (Date.now() < deadline) {
    actual = await fs.readFile(notePath).catch(() => null);
    if (actual?.equals(expectedBytes)) return;
    await delay(100);
  }
  throw new Error(
    `Threadleaf did not commit the exact candidate bytes: expected ${sha256(expectedBytes)}, observed ${actual ? sha256(actual) : "missing"}.`,
  );
}

async function closeThreadleaf(instance) {
  try {
    await bounded(instance.cdp.send("Browser.close"), "Threadleaf Browser.close", 2_000);
  } catch {
    // Browser.close commonly races the renderer's WebSocket close. The process receipt decides.
  }
  instance.cdp.close();
  let exit = await instance.exitPromise;
  if (exit.code === null && exit.signal === "timeout") {
    if (instance.child.exitCode === null && instance.child.signalCode === null)
      instance.child.kill("SIGTERM");
    exit =
      instance.child.exitCode === null && instance.child.signalCode === null
        ? await waitForExit(instance.child, 5_000)
        : { code: instance.child.exitCode, signal: instance.child.signalCode };
  }
  await instance.flushOutput();
  assert(exit.code === 0, `Threadleaf process did not exit cleanly: ${JSON.stringify(exit)}.`);
  instance.closed = true;
  return exit;
}

function exactSingleFileDelta(
  before,
  after,
  targetPath,
  expectedBeforeSha256,
  expectedAfterSha256,
) {
  const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])].sort();
  const changedPaths = paths.filter(
    (entryPath) =>
      JSON.stringify(beforeByPath.get(entryPath)) !== JSON.stringify(afterByPath.get(entryPath)),
  );
  const targetBefore = beforeByPath.get(targetPath);
  const targetAfter = afterByPath.get(targetPath);
  return {
    equal:
      JSON.stringify(changedPaths) === JSON.stringify([targetPath]) &&
      targetBefore?.sha256 === expectedBeforeSha256 &&
      targetAfter?.sha256 === expectedAfterSha256 &&
      targetBefore?.mode === targetAfter?.mode,
    targetPath,
    changedPaths,
    beforeSha256: targetBefore?.sha256 ?? null,
    afterSha256: targetAfter?.sha256 ?? null,
    expectedBeforeSha256,
    expectedAfterSha256,
  };
}

export function assertThreadleafReceipt(receipt, { runRoot, vaultPath }) {
  assert(receipt?.status === "observed", "Threadleaf production receipt is not observed.");
  assert(
    receipt.paths?.runRoot === path.resolve(runRoot) &&
      receipt.paths?.vault === path.resolve(vaultPath) &&
      ["profile", "home", "xdgConfig", "xdgCache", "xdgData", "temporary"].every((key) =>
        strictDescendant(runRoot, receipt.paths?.[key] ?? ""),
      ),
    "Threadleaf candidate paths escaped the dedicated run root.",
  );
  assert(
    Array.isArray(receipt.launches) &&
      receipt.launches.length === 2 &&
      receipt.launches.every(
        (launch) => launch.exit?.code === 0 && launch.target?.address === "127.0.0.1",
      ),
    "Threadleaf did not complete two clean loopback production launches.",
  );
  assert(
    receipt.roundtrip?.exact === true &&
      receipt.roundtrip?.reopenedSha256 === receipt.roundtrip?.mutatedSha256 &&
      receipt.roundtrip?.expectedMutatedSha256 === receipt.roundtrip?.mutatedSha256,
    "Threadleaf did not retain the exact edit through restart.",
  );
  assert(
    receipt.vaultRoundtrip?.equal === true,
    `Threadleaf changed vault bytes outside ${fixtureNote}: ${JSON.stringify(receipt.vaultRoundtrip)}.`,
  );
  assert(
    receipt.visible?.initial?.visibleText?.includes("THREADLEAF_OBSIDIAN_LAB_FIXTURE_V1") &&
      receipt.visible?.reopened?.visibleText?.includes(THREADLEAF_EDIT),
    "Threadleaf did not visibly render the fixture and saved candidate edit.",
  );
  assert(
    receipt.screenshot?.fromSurface === true &&
      receipt.screenshot?.captureBeyondViewport === false &&
      receipt.visible?.reopened?.viewport?.deviceScaleFactor === 1 &&
      receipt.visible?.reopened?.viewport?.pageScale === 1 &&
      receipt.screenshot?.pngWidth === receipt.visible?.reopened?.viewport?.width &&
      receipt.screenshot?.pngHeight === receipt.visible?.reopened?.viewport?.height &&
      receipt.screenshot?.path === `ui/${THREADLEAF_CELL_ID}.png` &&
      /^[a-f0-9]{64}$/u.test(receipt.screenshot?.sha256 ?? ""),
    "Threadleaf candidate surface capture was incomplete or had the wrong viewport.",
  );
  assert(
    receipt.cleanup?.clean === true &&
      receipt.cleanup?.temporary?.removed === true &&
      receipt.cleanup?.finalMarked?.length === 0,
    "Threadleaf candidate processes survived cleanup.",
  );
  return true;
}

function normalizeThreadleafMutation(mutation) {
  if (mutation == null || mutation === false) return null;
  if (mutation === true) return THREADLEAF_MUTATION.REMOVE_EDITOR;
  assert(
    Object.values(THREADLEAF_MUTATION).includes(mutation),
    `Unknown Threadleaf behavior mutation: ${JSON.stringify(mutation)}.`,
  );
  return mutation;
}

export function classifyThreadleafMutation({ mutation, evidence, failure, failureStage }) {
  if (!mutation) return null;
  const failureText = failure ? String(failure) : null;
  const caughtAtFocusBoundary =
    failureText?.includes(THREADLEAF_EDITOR_UNAVAILABLE) &&
    failureStage === "focus-editor" &&
    evidence?.removed === true &&
    evidence?.editorPresentBeforeFocus === false;
  if (caughtAtFocusBoundary) {
    return {
      status: "blocked",
      outcome: "mutation-caught",
      control: "passed",
      reason:
        "RC-THREADLEAF-01 mutation caught: the production focus/input boundary was blocked because the editor remained unavailable.",
    };
  }
  if (!failure) {
    return {
      status: "failed",
      outcome: "mutation-not-caught",
      control: "failed",
      reason:
        "RC-THREADLEAF-01 mutation not caught: mutation unexpectedly completed the production path.",
    };
  }
  return {
    status: "blocked",
    outcome: "mutation-indeterminate",
    control: "inconclusive",
    reason: `RC-THREADLEAF-01 could not prove the mutation was caught at the production focus/input boundary (failed at ${failureStage ?? "unknown stage"}: ${failureText}).`,
  };
}

export async function runThreadleafRoundtrip({
  appRoot,
  runRoot,
  vaultPath,
  marker,
  mutation = null,
}) {
  const mutationMode = normalizeThreadleafMutation(mutation);
  const electronPath = path.join(appRoot, "node_modules", ".bin", "electron");
  const userDataPath = path.join(runRoot, "threadleaf-profile");
  const homePath = path.join(runRoot, "threadleaf-home");
  const xdgConfigPath = path.join(runRoot, "threadleaf-xdg-config");
  const xdgCachePath = path.join(runRoot, "threadleaf-xdg-cache");
  const xdgDataPath = path.join(runRoot, "threadleaf-xdg-data");
  const temporaryPath = path.join(runRoot, "threadleaf-tmp");
  const processDirectory = path.join(runRoot, "threadleaf-process");
  const screenshotPath = path.join(runRoot, "ui", `${THREADLEAF_CELL_ID}.png`);
  const notePath = path.join(vaultPath, fixtureNote);
  const instances = [];
  let before = null;
  let after = null;
  let profile = null;
  let initialBytes = null;
  let expectedBytes = null;
  let reopenedBytes = null;
  let initialVisible = null;
  let reopenedVisible = null;
  let screenshot = null;
  let mutationEvidence = null;
  let failure = null;
  let failureStage = "setup";
  let receipt = null;
  let temporaryCleanup = null;

  const paths = {
    runRoot: path.resolve(runRoot),
    vault: path.resolve(vaultPath),
    profile: path.resolve(userDataPath),
    home: path.resolve(homePath),
    xdgConfig: path.resolve(xdgConfigPath),
    xdgCache: path.resolve(xdgCachePath),
    xdgData: path.resolve(xdgDataPath),
    temporary: path.resolve(temporaryPath),
  };

  const start = async (phase) => {
    const cdpPort = await reservePort();
    const args = threadleafLaunchArgs({ electronPath, userDataPath, cdpPort });
    assertThreadleafLaunchArgs(args, { runRoot, electronPath, userDataPath, cdpPort });
    const stdoutPath = path.join(processDirectory, `${phase}-stdout.bin`);
    const stderrPath = path.join(processDirectory, `${phase}-stderr.bin`);
    const environment = {
      ...process.env,
      [marker]: "1",
      ELECTRON_OZONE_PLATFORM_HINT: "x11",
      HOME: homePath,
      XDG_CONFIG_HOME: xdgConfigPath,
      XDG_CACHE_HOME: xdgCachePath,
      XDG_DATA_HOME: xdgDataPath,
      TMPDIR: temporaryPath,
      THREADLEAF_SAFE_PLUGINS: "1",
      THREADLEAF_VAULT_PATH: path.resolve(vaultPath),
    };
    delete environment.WAYLAND_DISPLAY;
    delete environment.DBUS_SESSION_BUS_ADDRESS;
    const child = spawn("xvfb-run", args, {
      cwd: appRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const instance = {
      phase,
      child,
      cdpPort,
      args,
      stdoutPath,
      stderrPath,
      flushOutput: captureChildOutput(child, stdoutPath, stderrPath),
      exitPromise: waitForExit(child, 30_000),
      cdp: null,
      target: null,
      closed: false,
    };
    instances.push(instance);
    await writeManifest(path.join(runRoot, "threadleaf", `${phase}-launch.v1.json`), {
      schemaVersion: 1,
      phase,
      executable: "current Threadleaf production Electron build",
      argv: ["xvfb-run", ...args],
      environment: {
        display: "xvfb-x11",
        viewport,
        network: "Electron background networking disabled; CDP is loopback-only",
        profile: path.relative(runRoot, userDataPath).split(path.sep).join("/"),
        vault: path.relative(runRoot, vaultPath).split(path.sep).join("/"),
        home: path.relative(runRoot, homePath).split(path.sep).join("/"),
      },
    });
    const attached = await waitForThreadleafCdp(cdpPort);
    instance.cdp = attached.cdp;
    instance.target = {
      type: attached.target.type,
      address: "127.0.0.1",
      port: cdpPort,
      url: String(attached.target.url ?? "").slice(0, 512),
    };
    return instance;
  };

  try {
    assert(
      process.platform === "linux",
      "Threadleaf behavior comparison currently requires Linux and Xvfb.",
    );
    assert(
      strictDescendant(runRoot, vaultPath),
      "Threadleaf candidate vault escaped the run root.",
    );
    await Promise.all([
      fs.access(electronPath),
      fs.access(path.join(appRoot, "dist", "main", "main.cjs")),
      fs.access(path.join(appRoot, "dist", "renderer", "index.html")),
      fs.mkdir(userDataPath, { recursive: true, mode: 0o700 }),
      fs.mkdir(homePath, { recursive: true, mode: 0o700 }),
      fs.mkdir(xdgConfigPath, { recursive: true, mode: 0o700 }),
      fs.mkdir(xdgCachePath, { recursive: true, mode: 0o700 }),
      fs.mkdir(xdgDataPath, { recursive: true, mode: 0o700 }),
      fs.mkdir(temporaryPath, { recursive: true, mode: 0o700 }),
      fs.mkdir(processDirectory, { recursive: true, mode: 0o700 }),
    ]);
    await assertMarkerAbsent(marker, "Threadleaf candidate marker");
    before = await snapshotTree(vaultPath, { label: "THREADLEAF-01 before" });
    initialBytes = await fs.readFile(notePath);
    assert(
      initialBytes.toString("utf8").includes("THREADLEAF_OBSIDIAN_LAB_FIXTURE_V1"),
      "Threadleaf candidate fixture did not contain the required external-oracle predicate.",
    );

    failureStage = "initial-launch";
    const initial = await start("initial");
    failureStage = "initial-visible-state";
    await waitForCandidate(initial.cdp, { requireNote: false });
    await openFixtureNote(initial.cdp);
    initialVisible = await waitForCandidate(initial.cdp);
    if (mutationMode) {
      const reinsertEditor = mutationMode === THREADLEAF_MUTATION.REMOVE_THEN_REINSERT_EDITOR;
      failureStage = "apply-mutation";
      mutationEvidence = await bounded(
        evaluate(
          initial.cdp,
          `(() => {
            const editor = document.querySelector('[data-pane-id="primary"] .cm-content[contenteditable="true"]');
            if (!(editor instanceof HTMLElement)) return { removed: false, reason: 'editor-missing' };
            const parent = editor.parentElement;
            const nextSibling = editor.nextSibling;
            editor.remove();
            const removed = document.querySelector('[data-pane-id="primary"] .cm-content[contenteditable="true"]') === null;
            const reinsertRequested = ${reinsertEditor};
            if (reinsertRequested && parent) parent.insertBefore(editor, nextSibling);
            const current = document.querySelector('[data-pane-id="primary"] .cm-content[contenteditable="true"]');
            return {
              removed,
              reinsertRequested,
              reinserted: reinsertRequested && current === editor && editor.isConnected,
              editorPresentBeforeFocus: current instanceof HTMLElement,
            };
          })()`,
        ),
        "Threadleaf behavior mutation",
      );
      assert(
        mutationEvidence?.removed === true,
        "Threadleaf behavior mutation did not remove the production editor.",
      );
      if (reinsertEditor) {
        assert(
          mutationEvidence?.reinserted === true &&
            mutationEvidence.editorPresentBeforeFocus === true,
          "Threadleaf behavior mutation did not reinsert the production editor before focus/input.",
        );
      }
    }
    failureStage = "focus-editor";
    await focusEditor(initial.cdp);
    failureStage = "position-editor";
    await sendKey(initial.cdp, "End", "End", 35, 2);
    expectedBytes = Buffer.concat([initialBytes, Buffer.from(`${THREADLEAF_EDIT}\n`, "utf8")]);
    failureStage = "insert-text";
    await bounded(
      initial.cdp.send("Input.insertText", { text: `${THREADLEAF_EDIT}\n` }),
      "Threadleaf candidate edit input",
    );
    failureStage = "verify-visible-edit";
    await waitForCandidate(initial.cdp, { requireEdit: true });
    failureStage = "save-edit";
    await sendKey(initial.cdp, "s", "KeyS", 83, 2);
    failureStage = "verify-saved-bytes";
    await waitForExactBytes(notePath, expectedBytes);
    failureStage = "close-initial";
    await closeThreadleaf(initial);

    failureStage = "reopen-launch";
    const reopened = await start("reopen");
    failureStage = "verify-reopened-visible-state";
    reopenedVisible = await waitForCandidate(reopened.cdp, { requireEdit: true });
    failureStage = "verify-reopened-bytes";
    reopenedBytes = await fs.readFile(notePath);
    assert(
      reopenedBytes.equals(expectedBytes),
      "Threadleaf reopened note bytes differed from the saved candidate bytes.",
    );
    failureStage = "capture-surface";
    const surface = await bounded(
      captureSurface(reopened.cdp, screenshotPath),
      "Threadleaf surface capture",
    );
    const dimensions = pngDimensions(surface.bytes);
    screenshot = {
      fromSurface: true,
      captureBeyondViewport: false,
      bytes: surface.bytes.length,
      sha256: surface.sha256,
      pngWidth: dimensions.width,
      pngHeight: dimensions.height,
      path: path.relative(runRoot, screenshotPath).split(path.sep).join("/"),
    };
    failureStage = "close-reopened";
    await closeThreadleaf(reopened);
    failureStage = "complete";
  } catch (error) {
    failure = error;
  } finally {
    for (const instance of instances) {
      instance.cdp?.close();
      if (
        !instance.closed &&
        instance.child.exitCode === null &&
        instance.child.signalCode === null
      ) {
        instance.child.kill("SIGTERM");
        await waitForExit(instance.child, 5_000);
      }
      await instance.flushOutput().catch(() => {});
    }
    const cleanup = await terminateMarkedProcesses(marker);
    const finalMarked = await markedProcesses(marker);
    await fs.rm(temporaryPath, { recursive: true, force: true });
    const temporaryExists = await fs
      .lstat(temporaryPath)
      .then(() => true)
      .catch(() => false);
    assert(
      temporaryExists === false,
      "Threadleaf private temporary directory survived candidate cleanup.",
    );
    temporaryCleanup = { removed: true };
    after = await snapshotTree(vaultPath, { label: "THREADLEAF-01 after" }).catch(() => null);
    profile = await snapshotTree(userDataPath, { label: "THREADLEAF-01 private profile" }).catch(
      () => null,
    );
    const mutationResult = classifyThreadleafMutation({
      mutation: mutationMode,
      evidence: mutationEvidence,
      failure,
      failureStage,
    });
    receipt = {
      schemaVersion: 1,
      status: mutationResult?.status ?? "blocked",
      reason: mutationResult?.reason ?? (failure ? String(failure) : null),
      paths,
      launches: instances.map((instance) => ({
        phase: instance.phase,
        target: instance.target,
        argv: instance.args,
        exit: {
          code: instance.child.exitCode,
          signal: instance.child.signalCode,
        },
        artifacts: [
          path.relative(runRoot, instance.stdoutPath).split(path.sep).join("/"),
          path.relative(runRoot, instance.stderrPath).split(path.sep).join("/"),
          `threadleaf/${instance.phase}-launch.v1.json`,
        ],
      })),
      roundtrip:
        initialBytes && expectedBytes && after
          ? {
              fixtureNote,
              beforeSha256: sha256(initialBytes),
              mutatedSha256:
                after.entries.find((entry) => entry.path === fixtureNote)?.sha256 ?? null,
              expectedMutatedSha256: sha256(expectedBytes),
              reopenedSha256: reopenedBytes ? sha256(reopenedBytes) : null,
              exact:
                after.entries.find((entry) => entry.path === fixtureNote)?.sha256 ===
                  sha256(expectedBytes) &&
                reopenedBytes?.equals(expectedBytes) === true &&
                reopenedVisible?.visibleText.includes(THREADLEAF_EDIT) === true,
            }
          : null,
      vaultRoundtrip:
        before && after && initialBytes && expectedBytes
          ? exactSingleFileDelta(
              before,
              after,
              fixtureNote,
              sha256(initialBytes),
              sha256(expectedBytes),
            )
          : null,
      visible: { initial: initialVisible, reopened: reopenedVisible },
      screenshot,
      mutation: mutationMode
        ? {
            id: "RC-THREADLEAF-01",
            action:
              mutationMode === THREADLEAF_MUTATION.REMOVE_THEN_REINSERT_EDITOR
                ? "removed then reinserted the live production CodeMirror editor before focus/input"
                : "removed the live production CodeMirror editor before focus/input",
            applied: mutationEvidence,
            outcome: mutationResult.outcome,
            control: mutationResult.control,
            failureStage,
            failure: failure ? String(failure) : null,
          }
        : null,
      profile: profile
        ? {
            treeSha256: profile.treeSha256,
            entries: profile.entries.length,
          }
        : null,
      cleanup: {
        marker: cleanup,
        finalMarked,
        temporary: temporaryCleanup,
        clean: cleanup.clean && finalMarked.length === 0 && temporaryCleanup?.removed === true,
      },
    };
    if (!failure && !mutationMode) {
      try {
        receipt.status = "observed";
        assertThreadleafReceipt(receipt, { runRoot, vaultPath });
      } catch (error) {
        receipt.status = "blocked";
        receipt.reason = String(error);
      }
    }
  }
  return receipt;
}

export function threadleafBehaviorMatch(reference, candidate) {
  const referenceRoundtrip = reference?.observed?.roundtrip;
  assert(reference?.status === "observed", "Obsidian external-oracle FILE-01 was not observed.");
  assert(
    referenceRoundtrip?.status === "observed" && referenceRoundtrip.exact === true,
    "Obsidian external-oracle FILE-01 did not retain its exact edit through reopen.",
  );
  assert(
    referenceRoundtrip.reopenedSha256 === referenceRoundtrip.mutatedSha256,
    "Obsidian external-oracle FILE-01 reopened bytes did not equal the saved bytes.",
  );
  assertThreadleafReceipt(candidate, {
    runRoot: candidate?.paths?.runRoot,
    vaultPath: candidate?.paths?.vault,
  });
  return {
    behavior: "open fixture note, append a synthetic UTF-8 marker, save, exit, reopen",
    referenceCell: "FILE-01",
    candidateCell: THREADLEAF_CELL_ID,
    referenceExactReopen: referenceRoundtrip.reopenedSha256 === referenceRoundtrip.mutatedSha256,
    candidateExactReopen: candidate.roundtrip.reopenedSha256 === candidate.roundtrip.mutatedSha256,
    candidatePreservedEveryOtherVaultPath: candidate.vaultRoundtrip.equal,
  };
}
