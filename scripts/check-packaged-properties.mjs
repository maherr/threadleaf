import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const appRoot = process.cwd();
const executablePath = path.resolve(
  process.env.THREADLEAF_PACKAGED_EXECUTABLE ??
    path.join(appRoot, "release", "linux-unpacked", "threadleaf"),
);
const screenshotDirectory = process.env.THREADLEAF_PROPERTY_SCREENSHOT_DIR;
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-packaged-properties-"));
const userDataPath = path.join(testRoot, "user-data");
const vaultPath = path.join(testRoot, "property-vault");
const notePath = path.join(vaultPath, "Property Desk.md");
const output = [];
let child;
let cdp;
let exited;

const originalNote = [
  "---",
  "# Preserve this comment exactly",
  'status: "draft"',
  "aliases:",
  '  - "Alpha"',
  "priority: 2",
  "published: false",
  "due: 2026-08-30",
  "meeting: 2026-08-30T13:45:00",
  "unchanged: keep # exact inline comment",
  "---",
  "# Property desk",
  "",
  "This body must stay byte-for-byte unchanged.",
].join("\n");

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
        const target = targets.find(
          (candidate) =>
            candidate.type === "page" &&
            typeof candidate.url === "string" &&
            candidate.url.endsWith("/dist/renderer/index.html"),
        );
        if (target?.webSocketDebuggerUrl) {
          return target;
        }
      }
    } catch {
      // The packaged renderer is still starting.
    }
    await delay(50);
  }
  throw new Error("The packaged property test did not expose its renderer in time.");
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

async function waitForWorkspace(deadline) {
  let lastState = null;
  while (Date.now() < deadline) {
    const state = await evaluate(`(async () => ({
      runtimeState: document.querySelector('#runtime-state')?.textContent ?? '',
      addDisabled: document.querySelector('#property-add')?.disabled ?? true,
      snapshot: await window.threadleaf.getSnapshot(),
    }))()`);
    lastState = state;
    if (
      state.runtimeState === "Ready" &&
      state.snapshot?.workspace?.state === "ready" &&
      state.snapshot?.vault?.source === "restored" &&
      state.snapshot?.workspace?.activeNote?.path === "Property Desk.md" &&
      !state.addDisabled
    ) {
      return state.snapshot;
    }
    await delay(50);
  }
  throw new Error(
    `The packaged application did not restore the writable property fixture: ${JSON.stringify(lastState)}`,
  );
}

async function waitForDialog(open, deadline) {
  let lastState = null;
  while (Date.now() < deadline) {
    const state = await evaluate(`(() => ({
      open: document.querySelector('#property-dialog')?.open ?? false,
      busy: document.querySelector('#property-form')?.getAttribute('aria-busy') ?? '',
      error: document.querySelector('#property-error')?.textContent ?? '',
    }))()`);
    lastState = state;
    if (state.open === open && (!open || state.busy !== "true")) {
      return state;
    }
    await delay(25);
  }
  throw new Error(
    `The property dialog did not become ${open ? "open" : "closed"}: ${JSON.stringify(lastState)}.`,
  );
}

async function waitForFocus(elementId, deadline) {
  while (Date.now() < deadline) {
    if ((await evaluate("document.activeElement?.id ?? ''")) === elementId) {
      return;
    }
    await delay(25);
  }
  throw new Error(`The property dialog did not focus ${elementId}.`);
}

async function currentProperties() {
  return evaluate(`(async () => {
    const snapshot = await window.threadleaf.getSnapshot();
    return snapshot.workspace?.activeNote?.properties ?? [];
  })()`);
}

async function waitForProperty(name, expectedType, expectedValue, deadline) {
  while (Date.now() < deadline) {
    const properties = await currentProperties();
    const property = properties.find((candidate) => candidate.name === name);
    if (
      property?.type === expectedType &&
      JSON.stringify(property.value) === JSON.stringify(expectedValue)
    ) {
      return property;
    }
    await delay(25);
  }
  throw new Error(
    `Property ${name} did not reach ${expectedType} ${JSON.stringify(expectedValue)}.`,
  );
}

async function openAddDialog() {
  const opened = await evaluate(`(() => {
    const button = document.querySelector('#property-add');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.focus();
    button.click();
    return true;
  })()`);
  assert(opened, "The visible Add property control was not reachable.");
  await waitForDialog(true, Date.now() + 5_000);
  await waitForFocus("property-name", Date.now() + 1_000);
  const state = await evaluate(`(() => ({
    title: document.querySelector('#property-dialog-title')?.textContent ?? '',
    focused: document.activeElement?.id ?? '',
    nameDisabled: document.querySelector('#property-name')?.disabled ?? true,
  }))()`);
  assert(state.title === "Add note property", "The Add property dialog title is incorrect.");
  assert(state.focused === "property-name", "The Add property dialog did not focus its name.");
  assert(!state.nameDisabled, "The Add property name is unexpectedly disabled.");
}

async function setDialogValue({ name, type, value }) {
  const prepared = await evaluate(`(() => {
    const nameInput = document.querySelector('#property-name');
    const typeSelect = document.querySelector('#property-type');
    const valueInput = document.querySelector('#property-value');
    const checkboxSelect = document.querySelector('#property-checkbox-value');
    const submit = document.querySelector('#property-submit');
    if (!(nameInput instanceof HTMLInputElement) ||
        !(typeSelect instanceof HTMLSelectElement) ||
        !(valueInput instanceof HTMLInputElement) ||
        !(checkboxSelect instanceof HTMLSelectElement) ||
        !(submit instanceof HTMLButtonElement)) return false;
    if (!nameInput.disabled) {
      nameInput.value = ${JSON.stringify(name ?? "")};
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    typeSelect.value = ${JSON.stringify(type)};
    typeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    if (${JSON.stringify(type)} === 'checkbox') {
      checkboxSelect.value = ${JSON.stringify(value)};
      checkboxSelect.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      valueInput.value = ${JSON.stringify(value)};
      valueInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    submit.click();
    return true;
  })()`);
  assert(prepared, "The typed property form controls were not reachable.");
}

async function addProperty(name, type, rawValue, expectedValue) {
  await openAddDialog();
  await setDialogValue({ name, type, value: rawValue });
  const state = await waitForDialog(false, Date.now() + 5_000);
  assert(!state.error, `Adding ${name} left an inline error: ${state.error}`);
  await waitForProperty(name, type, expectedValue, Date.now() + 5_000);
}

async function clickPropertyAction(name, action) {
  const opened = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.property-row')]
      .find((candidate) => candidate.dataset.propertyName === ${JSON.stringify(name)});
    const button = row?.querySelector('[data-property-action=${action}]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.focus();
    button.click();
    return true;
  })()`);
  assert(opened, `${action} for ${name} was not reachable.`);
  await waitForDialog(true, Date.now() + 5_000);
}

async function editProperty(name, type, rawValue, expectedValue) {
  await clickPropertyAction(name, "edit");
  const state = await evaluate(`(() => ({
    title: document.querySelector('#property-dialog-title')?.textContent ?? '',
    name: document.querySelector('#property-name')?.value ?? '',
    nameDisabled: document.querySelector('#property-name')?.disabled ?? false,
  }))()`);
  assert(state.title === "Edit note property", "The Edit property dialog title is incorrect.");
  assert(state.name === name && state.nameDisabled, "Editing did not lock the property identity.");
  await setDialogValue({ name: null, type, value: rawValue });
  await waitForDialog(false, Date.now() + 5_000);
  await waitForProperty(name, type, expectedValue, Date.now() + 5_000);
}

async function removeProperty(name) {
  await clickPropertyAction(name, "remove");
  await waitForFocus("property-submit", Date.now() + 1_000);
  const state = await evaluate(`(() => ({
    title: document.querySelector('#property-dialog-title')?.textContent ?? '',
    focused: document.activeElement?.id ?? '',
    fieldsHidden: document.querySelector('#property-fields')?.hidden ?? false,
    summaryHidden: document.querySelector('#property-remove-summary')?.hidden ?? true,
    fieldsDisplay: getComputedStyle(document.querySelector('#property-fields')).display,
    summaryDisplay: getComputedStyle(document.querySelector('#property-remove-summary')).display,
    summaryName: document.querySelector('#property-remove-name')?.textContent ?? '',
  }))()`);
  assert(state.title === "Remove note property?", "The removal dialog is not explicit.");
  assert(state.focused === "property-submit", "Removal did not focus its explicit action.");
  assert(
    state.fieldsHidden &&
      !state.summaryHidden &&
      state.fieldsDisplay === "none" &&
      state.summaryDisplay !== "none",
    "Removal did not visibly replace editing controls.",
  );
  assert(state.summaryName === name, "Removal dialog named the wrong property.");
  await evaluate("document.querySelector('#property-submit')?.click(); true");
  await waitForDialog(false, Date.now() + 5_000);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await currentProperties()).some((property) => property.name === name)) {
      return;
    }
    await delay(25);
  }
  throw new Error(`Property ${name} remained after explicit removal.`);
}

async function waitForTheme(theme, deadline) {
  while (Date.now() < deadline) {
    if ((await evaluate("document.documentElement.dataset.theme")) === theme) {
      return;
    }
    await delay(25);
  }
  throw new Error(`The packaged property surface did not switch to ${theme}.`);
}

async function setTheme(theme) {
  if ((await evaluate("document.documentElement.dataset.theme")) !== theme) {
    await evaluate("document.querySelector('#theme-toggle')?.click(); true");
    await waitForTheme(theme, Date.now() + 5_000);
  }
}

async function readResolvedColors(theme) {
  await setTheme(theme);
  return evaluate(`(() => {
    const probe = document.createElement('span');
    probe.style.position = 'fixed';
    probe.style.visibility = 'hidden';
    document.body.append(probe);
    const resolve = (token, property) => {
      probe.style.setProperty(property, 'var(' + token + ')');
      const value = getComputedStyle(probe).getPropertyValue(property);
      probe.style.removeProperty(property);
      return value;
    };
    const result = {
      accent: resolve('--accent-strong', 'color'),
      signal: resolve('--signal', 'color'),
      ink: resolve('--ink', 'color'),
      inkSoft: resolve('--ink-soft', 'color'),
      inkMuted: resolve('--ink-muted', 'color'),
      surface: resolve('--surface', 'background-color'),
      surfaceRaised: resolve('--surface-raised', 'background-color'),
      surfaceSunken: resolve('--surface-sunken', 'background-color'),
      accentSoft: resolve('--accent-soft', 'background-color'),
      signalSoft: resolve('--signal-soft', 'background-color'),
    };
    probe.remove();
    return result;
  })()`);
}

async function capture(name) {
  const result = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  const destination = path.join(screenshotDirectory, `${name}.png`);
  await fs.writeFile(destination, Buffer.from(result.data, "base64"));
  return destination;
}

async function capturePropertyViews(theme, suffix = "") {
  await setTheme(theme);
  const screenshots = [await capture(`packaged-properties-${theme}${suffix}`)];
  await clickPropertyAction("status", "edit");
  const visibility = await evaluate(`(() => ({
    fields: getComputedStyle(document.querySelector('#property-fields')).display,
    value: getComputedStyle(document.querySelector('#property-value-field')).display,
    checkbox: getComputedStyle(document.querySelector('#property-checkbox-field')).display,
    removal: getComputedStyle(document.querySelector('#property-remove-summary')).display,
  }))()`);
  assert(
    visibility.fields !== "none" &&
      visibility.value !== "none" &&
      visibility.checkbox === "none" &&
      visibility.removal === "none",
    `Edit property visibility is incorrect: ${JSON.stringify(visibility)}`,
  );
  screenshots.push(await capture(`packaged-properties-dialog-${theme}${suffix}`));
  await evaluate("document.querySelector('#property-cancel')?.click(); true");
  await waitForDialog(false, Date.now() + 5_000);
  await clickPropertyAction("reviewed", "remove");
  screenshots.push(await capture(`packaged-properties-remove-${theme}${suffix}`));
  await evaluate("document.querySelector('#property-cancel')?.click(); true");
  await waitForDialog(false, Date.now() + 5_000);
  return screenshots;
}

async function capturePositiveControl() {
  await clickPropertyAction("status", "edit");
  const outlined = await evaluate(`(() => {
    const shell = document.querySelector('#property-dialog .new-note-shell');
    if (!(shell instanceof HTMLElement)) return false;
    shell.style.outline = '12px solid rgb(255, 0, 255)';
    shell.style.outlineOffset = '-12px';
    return getComputedStyle(shell).outlineColor === 'rgb(255, 0, 255)';
  })()`);
  assert(outlined, "The visual positive control did not reach the property dialog.");
  const destination = await capture("packaged-properties-positive-control");
  await evaluate(`(() => {
    const shell = document.querySelector('#property-dialog .new-note-shell');
    if (shell instanceof HTMLElement) {
      shell.style.removeProperty('outline');
      shell.style.removeProperty('outline-offset');
    }
    document.querySelector('#property-cancel')?.click();
    return true;
  })()`);
  await waitForDialog(false, Date.now() + 5_000);
  return destination;
}

try {
  assert(process.platform === "linux", "The packaged property test currently requires Linux.");
  await fs.access(executablePath);
  await fs.mkdir(path.join(vaultPath, ".obsidian"), { recursive: true });
  await fs.mkdir(userDataPath, { recursive: true });
  await fs.writeFile(notePath, originalNote, "utf8");
  await fs.writeFile(
    path.join(userDataPath, "workspace-selection.json"),
    `${JSON.stringify({ version: 1, vaultPath }, null, 2)}\n`,
    "utf8",
  );

  const port = await availablePort();
  child = spawn(
    executablePath,
    [
      "--ozone-platform=x11",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataPath}`,
      "--disable-gpu",
    ],
    {
      cwd: appRoot,
      env: { ...process.env, ELECTRON_OZONE_PLATFORM_HINT: "x11" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
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

  const deadline = Date.now() + 12_000;
  const target = await waitForMainTarget(port, deadline);
  cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  const initial = await waitForWorkspace(deadline);
  assert(initial.vault.path === vaultPath, "The restored property fixture path is incorrect.");
  assert(initial.vault.mode === "kernel-backed", "The property fixture is not writable.");
  assert(initial.workspace.activeNote.propertyEditor.editable, "Simple frontmatter is read-only.");
  assert(initial.workspace.activeNote.properties.length === 7, "Initial property count is wrong.");
  assert(
    JSON.stringify(initial.workspace.activeNote.properties.map((property) => property.type)) ===
      JSON.stringify(["text", "list", "number", "checkbox", "date", "datetime", "text"]),
    "Initial property types or source order are wrong.",
  );

  const palette = await evaluate(`(() => {
    document.querySelector('#command-trigger')?.click();
    const input = document.querySelector('#palette-query');
    if (!(input instanceof HTMLInputElement)) return null;
    input.value = 'Add note property';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const option = [...document.querySelectorAll('.palette-option')]
      .find((candidate) => candidate.textContent?.includes('Add note property'));
    return option instanceof HTMLButtonElement
      ? { disabled: option.disabled, text: option.textContent ?? '' }
      : null;
  })()`);
  assert(palette && !palette.disabled, "Add note property is missing from the command palette.");
  await evaluate("document.querySelector('#palette-close')?.click(); true");

  await openAddDialog();
  await evaluate("document.querySelector('#property-cancel')?.click(); true");
  await waitForDialog(false, Date.now() + 5_000);
  assert(
    (await evaluate("document.activeElement?.id")) === "property-add",
    "Closing Properties did not restore focus to its trigger.",
  );

  await addProperty("owner", "text", "Local author", "Local author");
  await addProperty("topics", "list", '["open","local"]', ["open", "local"]);
  await addProperty("score", "number", "4.5", 4.5);
  await addProperty("complete", "checkbox", "true", true);
  await addProperty("reviewed", "date", "2026-09-01", "2026-09-01");
  await addProperty("updated", "datetime", "2026-09-01T08:30:15", "2026-09-01T08:30:15");
  await clickPropertyAction("complete", "edit");
  const checkboxVisibility = await evaluate(`(() => ({
    value: getComputedStyle(document.querySelector('#property-value-field')).display,
    checkbox: getComputedStyle(document.querySelector('#property-checkbox-field')).display,
    removal: getComputedStyle(document.querySelector('#property-remove-summary')).display,
  }))()`);
  assert(
    checkboxVisibility.value === "none" &&
      checkboxVisibility.checkbox !== "none" &&
      checkboxVisibility.removal === "none",
    `Checkbox property visibility is incorrect: ${JSON.stringify(checkboxVisibility)}`,
  );
  await evaluate("document.querySelector('#property-cancel')?.click(); true");
  await waitForDialog(false, Date.now() + 5_000);
  await editProperty("status", "list", '["draft","review"]', ["draft", "review"]);
  await removeProperty("due");

  const expectedNote = [
    "---",
    "# Preserve this comment exactly",
    "status:",
    '  - "draft"',
    '  - "review"',
    "aliases:",
    '  - "Alpha"',
    "priority: 2",
    "published: false",
    "meeting: 2026-08-30T13:45:00",
    "unchanged: keep # exact inline comment",
    'owner: "Local author"',
    "topics:",
    '  - "open"',
    '  - "local"',
    "score: 4.5",
    "complete: true",
    "reviewed: 2026-09-01",
    "updated: 2026-09-01T08:30:15",
    "---",
    "# Property desk",
    "",
    "This body must stay byte-for-byte unchanged.",
  ].join("\n");
  assert(
    (await fs.readFile(notePath, "utf8")) === expectedNote,
    "The packaged UI did not preserve exact unrelated Markdown bytes.",
  );
  const properties = await currentProperties();
  assert(properties.length === 12, `Final property count was ${properties.length}, expected 12.`);
  const resolvedColors = {
    dark: await readResolvedColors("dark"),
    light: await readResolvedColors("light"),
  };

  const screenshots = [];
  if (screenshotDirectory) {
    const toastDeadline = Date.now() + 4_000;
    while (Date.now() < toastDeadline) {
      if (await evaluate("document.querySelector('#toast')?.hidden ?? true")) {
        break;
      }
      await delay(50);
    }
    assert(
      await evaluate("document.querySelector('#toast')?.hidden ?? true"),
      "The completed property toast did not clear before visual verification.",
    );
    await fs.mkdir(screenshotDirectory, { recursive: true });
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1180,
      height: 820,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await delay(150);
    screenshots.push(...(await capturePropertyViews("dark")));
    screenshots.push(await capturePositiveControl());
    screenshots.push(...(await capturePropertyViews("light")));

    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 860,
      height: 640,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await delay(150);
    const compact = await evaluate(`(() => ({
      width: innerWidth,
      height: innerHeight,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }))()`);
    assert(
      compact.width === 860 && compact.height === 640 && compact.overflow <= 1,
      `Compact property geometry regressed: ${JSON.stringify(compact)}`,
    );
    screenshots.push(...(await capturePropertyViews("dark", "-compact")));
    screenshots.push(...(await capturePropertyViews("light", "-compact")));
  }

  // Leave enough time for Runtime.evaluate's response to cross CDP before closing the
  // renderer. A zero-delay close can win that race on a fast or CPU-constrained runner and
  // turn an intentional clean shutdown into a false "CDP WebSocket closed" failure.
  await evaluate("setTimeout(() => window.close(), 200); true");
  const exit = await Promise.race([
    exited,
    delay(10_000).then(() => ({ code: null, signal: "timeout" })),
  ]);
  assert(
    exit.code === 0,
    `Packaged property application did not exit cleanly: ${JSON.stringify(exit)}.`,
  );
  console.log(
    JSON.stringify({
      executablePath,
      vaultPath,
      finalPropertyCount: properties.length,
      exactBytes: true,
      resolvedColors,
      screenshots,
    }),
  );
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  const logs = output.join("").trim();
  throw new Error(logs ? `${detail}\nPackaged output:\n${logs}` : detail, { cause: error });
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
