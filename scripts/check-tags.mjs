import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";

const appRoot = process.cwd();
const electronPath = path.join(appRoot, "node_modules", ".bin", "electron");
const scratchRoot = "/tmp/tl-scratch/tags";
const testRoot = path.join(scratchRoot, `run-${randomUUID()}`);
const vaultPath = path.join(testRoot, "vault");
const userDataPath = path.join(testRoot, "user-data");
const screenshotDirectory = process.env.THREADLEAF_TAGS_SCREENSHOT_DIR;
const browserGate = process.env.THREADLEAF_TAGS_BROWSER_GATE;
const processMarker = randomUUID();
const output = [];
let child;
let exited;
let cdp;
let cdpPort;
let phase = "setup";

const welcomeSource = `---
title: Tagged welcome
tags:
  - Project/Threadleaf
  - Alpha
---
# Tagged welcome

Reading view exposes #Résumé and #Project/Threadleaf/Parser plus #y2026.

Numeric #2026 stays plain. Inline \`#inline-code\` stays code.

[Linked #hidden](Other.md)

\`\`\`md
#fenced
\`\`\`
`;

const otherSource = `# Other

This note uses #project/threadleaf with source-preserved casing.
`;

const liveSource = `#Live/Tag
Second line
`;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function tagSelector(key) {
  return `.tag-tree-row[data-tag-key=${JSON.stringify(key)}]`;
}

function noteSelector(filePath) {
  return `#file-list [data-note-path=${JSON.stringify(filePath)}]`;
}

function treeNoteSelector(filePath) {
  return `.navigator-tree-row[data-tree-path=${JSON.stringify(filePath)}]`;
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
    throw new Error("Could not reserve an isolated loopback CDP port.");
  }
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitFor(probe, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await delay(50);
  }
  throw new Error(`${message}. Last observation: ${JSON.stringify(last)}`);
}

async function waitForMainTarget(port) {
  return waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (!response.ok) return null;
      const targets = await response.json();
      return targets.find(
        (target) =>
          target.type === "page" &&
          typeof target.url === "string" &&
          target.url.endsWith("/dist/renderer/index.html") &&
          target.webSocketDebuggerUrl,
      );
    } catch {
      return null;
    }
  }, "Threadleaf did not expose its isolated main renderer in time");
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
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const request of pending.values()) request.reject(new Error("CDP WebSocket closed."));
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

async function snapshot() {
  return evaluate("window.threadleaf.getSnapshot()");
}

async function targetCenter(selector) {
  const scrolled = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return false;
    element.scrollIntoView({ block: "center", inline: "center" });
    return true;
  })()`);
  assert(scrolled, `Pointer target is unavailable: ${selector}`);
  await delay(50);
  const target = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return { error: "missing" };
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const style = getComputedStyle(element);
    return {
      error: null,
      disabled: element instanceof HTMLButtonElement && element.disabled,
      hidden: element.hidden || style.display === "none" || style.visibility === "hidden",
      hit: Boolean(hit && (hit === element || element.contains(hit))),
      hitDescription:
        hit instanceof Element
          ? hit.tagName.toLowerCase() + "#" + hit.id + "." + [...hit.classList].join(".")
          : null,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      width: rect.width,
      height: rect.height,
    };
  })()`);
  assert(target && !target.error, `Pointer target is unavailable: ${selector}`);
  assert(!target.disabled, `Pointer target is disabled: ${selector}`);
  assert(
    !target.hidden && target.width > 0 && target.height > 0,
    `Pointer target is hidden: ${selector}`,
  );
  assert(target.hit, `Pointer target is covered: ${selector}; observed=${JSON.stringify(target)}`);
  return target;
}

async function clickSelector(selector) {
  const target = await targetCenter(selector);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await cdp.send("Input.dispatchMouseEvent", {
      type,
      button: type === "mouseMoved" ? "none" : "left",
      buttons: type === "mousePressed" ? 1 : 0,
      clickCount: type === "mouseMoved" ? 0 : 1,
      x: target.x,
      y: target.y,
    });
  }
}

async function pressKey(key, code, modifiers = 0) {
  const virtualKey = {
    ArrowDown: 40,
    ArrowLeft: 37,
    ArrowRight: 39,
    Backspace: 8,
    End: 35,
    Enter: 13,
    Home: 36,
  }[key];
  await cdp.send("Input.dispatchKeyEvent", {
    type: key.length === 1 ? "keyDown" : "rawKeyDown",
    code,
    key,
    modifiers,
    windowsVirtualKeyCode: virtualKey,
    nativeVirtualKeyCode: virtualKey,
    ...(key.length === 1 ? { text: key } : {}),
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    code,
    key,
    modifiers,
    windowsVirtualKeyCode: virtualKey,
    nativeVirtualKeyCode: virtualKey,
  });
}

async function fillInput(selector, value) {
  await clickSelector(selector);
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    code: "KeyA",
    key: "a",
    modifiers: 2,
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    code: "KeyA",
    key: "a",
    modifiers: 2,
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
  });
  await pressKey("Backspace", "Backspace");
  await cdp.send("Input.insertText", { text: value });
  const observed = await evaluate(
    `document.querySelector(${JSON.stringify(selector)})?.value ?? null`,
  );
  assert(observed === value, `The visible input did not commit ${JSON.stringify(value)}.`);
}

async function captureScreenshot(name) {
  const result = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  if (screenshotDirectory) {
    const resolved = path.resolve(screenshotDirectory);
    assert(
      resolved === scratchRoot || resolved.startsWith(`${scratchRoot}${path.sep}`),
      `Tag screenshots must stay under ${scratchRoot}.`,
    );
    await fs.mkdir(resolved, { recursive: true });
    await fs.writeFile(path.join(resolved, `${name}.png`), result.data, "base64");
  }
  return result.data;
}

async function setTheme(theme) {
  if ((await evaluate("document.documentElement.dataset.theme")) !== theme) {
    await clickSelector("#theme-toggle");
  }
  await waitFor(
    async () =>
      (await evaluate("document.documentElement.dataset.theme")) === theme ? true : null,
    `Threadleaf did not switch to ${theme} mode`,
  );
}

async function showTagPane() {
  await waitFor(
    async () =>
      (await evaluate(
        'document.querySelector("#navigator-tag-toggle")?.disabled === false ? true : null',
      )) ?? null,
    "The Tags control stayed disabled",
  );
  if (
    (await evaluate(
      'document.querySelector("#navigator-tag-toggle")?.getAttribute("aria-pressed")',
    )) !== "true"
  ) {
    await clickSelector("#navigator-tag-toggle");
  }
  await waitFor(
    async () =>
      (await evaluate(
        'document.querySelector("#file-list")?.dataset.mode === "tags" ? true : null',
      )) ?? null,
    "The Tags navigator did not become visible",
  );
}

async function showNotesPane() {
  await waitFor(
    async () =>
      (await evaluate(
        'document.querySelector("#navigator-tag-toggle")?.disabled === false ? true : null',
      )) ?? null,
    "The Notes control stayed disabled",
  );
  if (
    (await evaluate(
      'document.querySelector("#navigator-tag-toggle")?.getAttribute("aria-pressed")',
    )) === "true"
  ) {
    await clickSelector("#navigator-tag-toggle");
  }
}

async function waitForOpenNote(filePath) {
  return waitFor(
    async () =>
      (await evaluate('document.querySelector("#note-path")?.textContent ?? ""')) === filePath
        ? true
        : null,
    `Threadleaf did not open ${filePath}`,
  );
}

async function openSearchResult(filePath) {
  await waitFor(
    async () =>
      (await evaluate(
        `Boolean(document.querySelector(${JSON.stringify(noteSelector(filePath))}))`,
      )) || null,
    `Search did not render ${filePath}`,
  );
  await clickSelector(noteSelector(filePath));
  await waitForOpenNote(filePath);
}

async function markedProcessIds() {
  const marker = Buffer.from(`THREADLEAF_TAGS_RUN=${processMarker}\0`);
  const entries = await fs.readdir("/proc");
  const matches = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const environment = await fs.readFile(`/proc/${entry}/environ`);
      if (environment.includes(marker)) matches.push(Number.parseInt(entry, 10));
    } catch {
      // The process can exit between enumeration and the read.
    }
  }
  return matches;
}

async function terminateMarkedProcesses() {
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const processIds = await markedProcessIds();
      if (processIds.length === 0) return;
      for (const processId of processIds) {
        try {
          process.kill(processId, signal);
        } catch {
          // The process already exited.
        }
      }
      await delay(100);
    }
  }
  const remaining = await markedProcessIds();
  assert(remaining.length === 0, `Could not stop tag test processes: ${remaining}`);
}

async function descendantRendererCommandLines(rootProcessId) {
  const entries = await fs.readdir("/proc", { withFileTypes: true });
  const processes = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const [status, commandLine] = await Promise.all([
        fs.readFile(path.join("/proc", entry.name, "status"), "utf8"),
        fs.readFile(path.join("/proc", entry.name, "cmdline")),
      ]);
      processes.push({
        processId: Number(entry.name),
        parentProcessId: Number(/^PPid:\s+(\d+)$/m.exec(status)?.[1] ?? -1),
        commandLine: commandLine.toString("utf8").replaceAll("\0", " "),
      });
    } catch {
      // A short-lived process disappeared between reads.
    }
  }
  const descendants = new Set([rootProcessId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes) {
      if (!descendants.has(process.processId) && descendants.has(process.parentProcessId)) {
        descendants.add(process.processId);
        changed = true;
      }
    }
  }
  return processes
    .filter(
      (process) =>
        descendants.has(process.processId) && process.commandLine.includes("--type=renderer"),
    )
    .map((process) => process.commandLine);
}

async function assertIsolatedX11Renderer() {
  const commandLines = await waitFor(async () => {
    const lines = await descendantRendererCommandLines(child.pid);
    return lines.length > 0 ? lines : null;
  }, "The isolated launch did not expose a renderer process");
  assert(
    commandLines.every((line) => line.includes("--ozone-platform=x11")),
    "A tag-test renderer escaped the X11 virtual display.",
  );
  assert(
    commandLines.every((line) => !line.includes("--ozone-platform=wayland")),
    "A tag-test renderer selected Wayland instead of X11.",
  );
}

async function launchApplication() {
  cdpPort = await availablePort();
  child = spawn(
    "xvfb-run",
    [
      "-a",
      "-s",
      "-screen 0 1440x900x24 -nolisten tcp",
      electronPath,
      "--ozone-platform=x11",
      `--remote-debugging-port=${cdpPort}`,
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
        THREADLEAF_TAGS_RUN: processMarker,
        THREADLEAF_SAFE_PLUGINS: "1",
        THREADLEAF_VAULT_PATH: vaultPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      output.push(String(chunk));
      if (output.length > 160) output.shift();
    });
  }
  const target = await waitForMainTarget(cdpPort);
  cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
}

async function closeApplication() {
  if (!child) return;
  try {
    await evaluate("setTimeout(() => window.close(), 50); true");
  } catch {
    // The renderer can disappear before the close response returns.
  }
  cdp?.close();
  cdp = undefined;
  const result = exited
    ? await Promise.race([exited, delay(5_000).then(() => ({ code: null, signal: "timeout" }))])
    : { code: null, signal: "missing" };
  if (result.code !== 0) await terminateMarkedProcesses();
  child = undefined;
  exited = undefined;
}

async function writeFixtureVault() {
  await fs.mkdir(vaultPath, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(vaultPath, "Welcome.md"), welcomeSource, "utf8"),
    fs.writeFile(path.join(vaultPath, "Other.md"), otherSource, "utf8"),
    fs.writeFile(path.join(vaultPath, "Live.md"), liveSource, "utf8"),
  ]);
}

async function waitForReady() {
  return waitFor(
    async () => {
      const current = await snapshot();
      return current?.workspace?.state === "ready" &&
        current?.vault?.path === vaultPath &&
        current?.workspace?.census?.indexed === 3
        ? current
        : null;
    },
    "The tag fixture vault did not become ready",
    30_000,
  );
}

async function waitForGenerationAfter(previousGeneration, message) {
  const started = performance.now();
  const current = await waitFor(
    async () => {
      const candidate = await snapshot();
      return candidate?.workspace?.state === "ready" &&
        candidate.workspace.indexGeneration !== previousGeneration
        ? candidate
        : null;
    },
    message,
    20_000,
  );
  return { snapshot: current, elapsedMs: performance.now() - started };
}

async function browserInspectionGate() {
  if (!browserGate) return;
  const gatePath = path.resolve(browserGate);
  assert(
    gatePath.startsWith(`${scratchRoot}${path.sep}`),
    `The browser inspection gate must stay under ${scratchRoot}.`,
  );
  await fs.mkdir(path.dirname(gatePath), { recursive: true });
  await fs.writeFile(`${gatePath}.port`, String(cdpPort), "utf8");
  console.log(`THREADLEAF_TAGS_BROWSER_CDP=http://127.0.0.1:${cdpPort}`);
  await waitFor(
    async () =>
      fs
        .access(gatePath)
        .then(() => true)
        .catch(() => null),
    "The browser-use inspection gate was not released",
    180_000,
  );
  await fs.rm(gatePath, { force: true });
  await fs.rm(`${gatePath}.port`, { force: true });
}

try {
  assert(process.platform === "linux", "The tag integration check requires Linux and Xvfb.");
  await fs.access(electronPath);
  await fs.mkdir(scratchRoot, { recursive: true });
  await writeFixtureVault();

  phase = "isolated X11 launch";
  await launchApplication();
  const initial = await waitForReady();
  await assertIsolatedX11Renderer();
  await browserInspectionGate();

  phase = "open fixture note";
  await waitFor(
    async () =>
      (await evaluate(
        `Boolean(document.querySelector(${JSON.stringify(treeNoteSelector("Welcome.md"))}))`,
      )) || null,
    "The initial tree did not render Welcome.md",
  );
  await clickSelector(treeNoteSelector("Welcome.md"));
  await waitForOpenNote("Welcome.md");

  phase = "lazy hierarchy and counts";
  const catalogStarted = performance.now();
  await showTagPane();
  await waitFor(
    async () =>
      (await evaluate(
        `Boolean(document.querySelector(${JSON.stringify(tagSelector("project/threadleaf/parser"))}))`,
      )) || null,
    "The tag hierarchy did not render its nested leaf",
  );
  const catalogRenderMs = performance.now() - catalogStarted;
  const hierarchy = await evaluate(`(() => {
    const rows = [...document.querySelectorAll(".tag-tree-row")];
    return {
      mode: document.querySelector("#file-list")?.dataset.mode,
      role: document.querySelector("#file-list")?.getAttribute("role"),
      heading: document.querySelector("#files-heading")?.textContent,
      searchHidden: document.querySelector("#navigator-search-field")?.hidden,
      canvasHidden: document.querySelector("#canvas-shelf")?.hidden,
      rows: rows.map((row) => ({
        key: row.getAttribute("data-tag-key"),
        level: row.getAttribute("aria-level"),
        expanded: row.getAttribute("aria-expanded"),
        count: row.querySelector(".tag-tree-count")?.textContent,
        detail: row.querySelector("small")?.textContent,
      })),
    };
  })()`);
  const project = hierarchy.rows.find((row) => row.key === "project");
  const threadleaf = hierarchy.rows.find((row) => row.key === "project/threadleaf");
  const parser = hierarchy.rows.find((row) => row.key === "project/threadleaf/parser");
  assert(
    hierarchy.mode === "tags" &&
      hierarchy.role === "tree" &&
      hierarchy.heading === "Tags" &&
      hierarchy.searchHidden === true &&
      hierarchy.canvasHidden === true &&
      project?.level === "1" &&
      project.count === "3" &&
      project.detail === "0 direct · 3 with children" &&
      threadleaf?.level === "2" &&
      threadleaf.count === "3" &&
      threadleaf.detail === "2 direct · 3 with children" &&
      parser?.level === "3" &&
      parser.count === "1" &&
      !hierarchy.rows.some((row) => row.key === "2026"),
    `Tag hierarchy or nested counts are wrong: ${JSON.stringify(hierarchy)}`,
  );

  phase = "tag keyboard navigation";
  await evaluate(
    `document.querySelector(${JSON.stringify(tagSelector("project"))})?.focus(); true`,
  );
  await pressKey("ArrowLeft", "ArrowLeft");
  await waitFor(
    async () =>
      (await evaluate(
        `!document.querySelector(${JSON.stringify(tagSelector("project/threadleaf"))}) && document.querySelector(${JSON.stringify(tagSelector("project"))})?.getAttribute("aria-expanded") === "false" ? true : null`,
      )) ?? null,
    "ArrowLeft did not collapse the parent tag",
  );
  await pressKey("ArrowRight", "ArrowRight");
  await waitFor(
    async () =>
      (await evaluate(
        `Boolean(document.querySelector(${JSON.stringify(tagSelector("project/threadleaf"))}))`,
      )) || null,
    "ArrowRight did not expand the parent tag",
  );
  await pressKey("ArrowRight", "ArrowRight");
  await waitFor(
    async () =>
      (await evaluate("document.activeElement?.getAttribute('data-tag-key')")) ===
      "project/threadleaf"
        ? true
        : null,
    "ArrowRight did not move focus to the first child tag",
  );
  await pressKey("Enter", "Enter");
  const scopedSearch = await waitFor(async () => {
    const search = await evaluate(`(() => ({
        query: document.querySelector("#file-search")?.value,
        mode: document.querySelector("#file-list")?.dataset.mode,
        busy: document.querySelector("#file-list")?.getAttribute("aria-busy"),
        paths: [...document.querySelectorAll("#file-list [data-note-path]")].map((item) => item.getAttribute("data-note-path")).sort(),
      }))()`);
    return search.query?.startsWith("tag:#") && search.mode === "search" && search.busy === "false"
      ? search
      : null;
  }, "Activating a tag did not run the existing search surface");
  assert(
    scopedSearch.query.toLocaleLowerCase("en-US") === "tag:#project/threadleaf" &&
      JSON.stringify(scopedSearch.paths) === JSON.stringify(["Other.md", "Welcome.md"]),
    `Tag search returned the wrong scope: ${JSON.stringify(scopedSearch)}`,
  );

  phase = "reading anchors and property pills";
  await openSearchResult("Welcome.md");
  await clickSelector("#read-view");
  await waitFor(
    async () =>
      (await evaluate(
        `document.querySelector("#note-preview")?.hidden === false && document.querySelector(${JSON.stringify('#note-preview a.tag[data-threadleaf-tag="Résumé"]')}) ? true : null`,
      )) ?? null,
    "Reading view did not render its tag anchors",
  );
  const reading = await evaluate(`(() => ({
    anchors: [...document.querySelectorAll("#note-preview a.tag")].map((anchor) => ({
      text: anchor.textContent,
      href: anchor.getAttribute("href"),
      tag: anchor.getAttribute("data-threadleaf-tag"),
      name: anchor.getAttribute("data-tag-name"),
    })),
    properties: [...document.querySelectorAll("#property-list a.property-tag")].map((anchor) => anchor.textContent),
    header: [...document.querySelectorAll("#note-tags a.tag")].map((anchor) => anchor.textContent),
    code: document.querySelector("#note-preview code")?.textContent,
  }))()`);
  assert(
    reading.anchors.some(
      (anchor) =>
        anchor.text === "#Résumé" &&
        anchor.href === "#Résumé" &&
        anchor.tag === "Résumé" &&
        anchor.name === "#Résumé",
    ) &&
      reading.anchors.some((anchor) => anchor.text === "#Project/Threadleaf/Parser") &&
      !reading.anchors.some((anchor) => anchor.text === "#2026") &&
      reading.properties.includes("#Project/Threadleaf") &&
      reading.properties.includes("#Alpha") &&
      reading.header.includes("#Project/Threadleaf") &&
      reading.code === "#inline-code",
    `Reading tags or frontmatter pills are incomplete: ${JSON.stringify(reading)}`,
  );

  phase = "both-theme reading screenshots and positive control";
  await showTagPane();
  await setTheme("dark");
  const readingDark = await captureScreenshot("tags-reading-dark");
  const positiveReached = await evaluate(`(() => {
    const row = document.querySelector(${JSON.stringify(tagSelector("project"))});
    if (!(row instanceof HTMLElement)) return false;
    row.style.outline = "8px solid rgb(230, 159, 0)";
    return getComputedStyle(row).outlineWidth === "8px";
  })()`);
  assert(positiveReached, "The tag screenshot positive control did not reach its target row.");
  const readingPositive = await captureScreenshot("tags-positive-control-dark");
  assert(readingPositive !== readingDark, "The tag screenshot positive control changed no pixels.");
  await evaluate(`(() => {
    document.querySelector(${JSON.stringify(tagSelector("project"))})?.style.removeProperty("outline");
    return true;
  })()`);
  await setTheme("light");
  const readingLight = await captureScreenshot("tags-reading-light");
  assert(readingLight !== readingDark, "Reading tag screenshots are identical across themes.");

  phase = "live preview anchors, source reveal, and autosave indexing";
  await showNotesPane();
  await fillInput("#file-search", "Live");
  await openSearchResult("Live.md");
  await clickSelector("#source-view");
  await waitFor(
    async () =>
      (await evaluate(
        'document.querySelector("#source-view")?.getAttribute("aria-pressed") === "true" ? true : null',
      )) ?? null,
    "Source view did not activate before the autosave edit",
  );
  await clickSelector("#note-editor .cm-content");
  await pressKey("End", "End", 2);
  await cdp.send("Input.insertText", { text: " #Autosaved/Child" });
  await waitFor(
    async () =>
      fs
        .readFile(path.join(vaultPath, "Live.md"), "utf8")
        .then((content) => (content.includes("#Autosaved/Child") ? true : null))
        .catch(() => null),
    "The source edit did not reach disk through continuous autosave",
  );
  await clickSelector("#edit-view");
  await waitFor(
    async () =>
      (
        await evaluate(`(() => ({
        anchor: document.querySelector("a.tag.tl-live-tag[data-threadleaf-tag='Live/Tag']")?.getAttribute("href"),
        source: [...document.querySelectorAll(".tl-live-tag-source")].map((node) => node.textContent),
      }))()`)
      )?.source?.some((text) => text === "#Autosaved/Child")
        ? await evaluate(`(() => ({
            anchor: document.querySelector("a.tag.tl-live-tag[data-threadleaf-tag='Live/Tag']")?.getAttribute("href"),
            source: [...document.querySelectorAll(".tl-live-tag-source")].map((node) => node.textContent),
          }))()`)
        : null,
    "Live Preview did not keep the active tag as source while rendering the inactive tag",
  ).then((live) => {
    assert(
      live.anchor === "#Live/Tag" && live.source.includes("#Autosaved/Child"),
      `Live Preview tag state is wrong: ${JSON.stringify(live)}`,
    );
  });
  await showTagPane();
  await waitFor(
    async () =>
      (await evaluate(
        `Boolean(document.querySelector(${JSON.stringify(tagSelector("autosaved/child"))}))`,
      )) || null,
    "The autosaved tag did not enter the incremental catalog",
  );
  await setTheme("light");
  const liveLight = await captureScreenshot("tags-live-light");
  await setTheme("dark");
  const liveDark = await captureScreenshot("tags-live-dark");
  assert(liveLight !== liveDark, "Live Preview tag screenshots are identical across themes.");
  await clickSelector('a.tag.tl-live-tag[data-threadleaf-tag="Live/Tag"]');
  await waitFor(
    async () =>
      (await evaluate('document.querySelector("#file-search")?.value')) === "tag:#Live/Tag"
        ? true
        : null,
    "Clicking a Live Preview tag did not run tag-scoped search",
  );

  phase = "external create, rename, and delete";
  const beforeCreate = (await snapshot()).workspace.indexGeneration;
  const createStarted = performance.now();
  await fs.writeFile(
    path.join(vaultPath, "External.md"),
    "# External\n\n#External/Child\n",
    "utf8",
  );
  const created = await waitForGenerationAfter(
    beforeCreate,
    "The watcher did not index the externally created note",
  );
  await showTagPane();
  await waitFor(
    async () =>
      (await evaluate(
        `Boolean(document.querySelector(${JSON.stringify(tagSelector("external/child"))}))`,
      )) || null,
    "The external tag did not appear in the visible catalog",
  );
  const createMs = performance.now() - createStarted;

  const beforeRename = created.snapshot.workspace.indexGeneration;
  const renameStarted = performance.now();
  await fs.rename(path.join(vaultPath, "External.md"), path.join(vaultPath, "Renamed.md"));
  const renamed = await waitForGenerationAfter(
    beforeRename,
    "The watcher did not index the external rename",
  );
  await waitFor(
    async () =>
      (await evaluate(
        `Boolean(document.querySelector(${JSON.stringify(tagSelector("external/child"))}))`,
      )) || null,
    "The external tag did not survive its note rename",
  );
  await clickSelector(tagSelector("external/child"));
  await waitFor(
    async () =>
      (await evaluate(
        `Boolean(document.querySelector(${JSON.stringify(noteSelector("Renamed.md"))}))`,
      )) &&
      !(await evaluate(
        `Boolean(document.querySelector(${JSON.stringify(noteSelector("External.md"))}))`,
      ))
        ? true
        : null,
    "Tag search did not replace the renamed path",
  );
  const renameMs = performance.now() - renameStarted;

  const beforeDelete = renamed.snapshot.workspace.indexGeneration;
  const deleteStarted = performance.now();
  await fs.rm(path.join(vaultPath, "Renamed.md"));
  await waitForGenerationAfter(beforeDelete, "The watcher did not index the external delete");
  await showTagPane();
  await waitFor(
    async () =>
      (
        await evaluate(`(() => ({
        busy: document.querySelector("#file-list")?.getAttribute("aria-busy"),
        present: Boolean(document.querySelector(${JSON.stringify(tagSelector("external/child"))})),
      }))()`)
      )?.busy === "false"
        ? await evaluate(`(() => ({
            busy: document.querySelector("#file-list")?.getAttribute("aria-busy"),
            present: Boolean(document.querySelector(${JSON.stringify(tagSelector("external/child"))})),
          }))()`)
        : null,
    "The tag catalog did not settle after the external delete",
  ).then((catalog) => {
    assert(!catalog.present, `Deleted tag remained in the catalog: ${JSON.stringify(catalog)}`);
  });
  const deleteMs = performance.now() - deleteStarted;

  await closeApplication();
  console.log(`TAG_CATALOG_RENDER_MS=${catalogRenderMs.toFixed(1)}`);
  console.log(
    `TAG_WATCHER_MS create=${createMs.toFixed(1)} rename=${renameMs.toFixed(1)} delete=${deleteMs.toFixed(1)}`,
  );
  console.log(
    "Verified isolated X11 tags: grammar, nested counts, keyboard hierarchy, scoped search, Reading anchors, frontmatter pills, Live Preview source reveal, autosave, external create/rename/delete, and both themes.",
  );
  if (screenshotDirectory) console.log(`TAG_SCREENSHOTS=${screenshotDirectory}`);
  assert(
    initial.workspace.census.indexed === 3,
    "The initial fixture census changed unexpectedly.",
  );
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  const logs = output.join("").trim();
  const phased = `Phase ${phase}: ${detail}`;
  throw new Error(logs ? `${phased}\nElectron output:\n${logs}` : phased, { cause: error });
} finally {
  cdp?.close();
  await terminateMarkedProcesses().catch(() => undefined);
  await fs.rm(testRoot, { recursive: true, force: true });
}
