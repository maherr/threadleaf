import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const appRoot = process.cwd();
const electronPath = path.join(appRoot, "node_modules", ".bin", "electron");
const autoLinkTitleMode = process.env.THREADLEAF_AUTO_LINK_TITLE === "1";
const naturalDatesMode = process.env.THREADLEAF_NATURAL_DATES === "1";
const e2eColorScheme = process.env.THREADLEAF_E2E_COLOR_SCHEME === "light" ? "light" : "dark";
const pluginId = naturalDatesMode
  ? "nldates-obsidian"
  : autoLinkTitleMode
    ? "obsidian-auto-link-title"
    : "url-into-selection";
const pluginVersion = naturalDatesMode ? "0.6.2" : autoLinkTitleMode ? "1.5.5" : "1.11.4";
const sourcePluginPath = naturalDatesMode
  ? process.env.THREADLEAF_NATURAL_DATES_PLUGIN_DIR
  : autoLinkTitleMode
    ? process.env.THREADLEAF_AUTO_LINK_TITLE_PLUGIN_DIR
    : process.env.THREADLEAF_URL_SELECTION_PLUGIN_DIR;
const screenshotDirectory = process.env.THREADLEAF_URL_SELECTION_SCREENSHOT_DIR;
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-url-selection-"));
const vaultPath = path.join(testRoot, "vault");
const userDataPath = path.join(testRoot, "user-data");
const pluginPath = path.join(vaultPath, ".obsidian", "plugins", pluginId);
const output = [];
let child;
let cdp;
let exited;
let titleServer;

const officialAssets = naturalDatesMode
  ? [
      {
        name: "manifest.json",
        url: "https://github.com/argenos/nldates-obsidian/releases/download/0.6.2/manifest.json",
        sha256: "dfdcbdd8272d839ec0620af3a1fa7ab1f785ad3cdc6feed1f18ccb7b09621f29",
      },
      {
        name: "main.js",
        url: "https://github.com/argenos/nldates-obsidian/releases/download/0.6.2/main.js",
        sha256: "387d36a43412f761c0c69320655a7ec09aa9189ae2267550224cacc861e63fd6",
      },
    ]
  : autoLinkTitleMode
    ? [
        {
          name: "manifest.json",
          url: "https://github.com/zolrath/obsidian-auto-link-title/releases/download/1.5.5/manifest.json",
          sha256: "21916c8c8fa1996d38fc79e6064b61f41c6b34d5d4eaddaf36f18432b3f49a11",
        },
        {
          name: "main.js",
          url: "https://github.com/zolrath/obsidian-auto-link-title/releases/download/1.5.5/main.js",
          sha256: "eb27498bfd05dc5c3847dd072f555ed4c02aece24451042c2edb25fc961f38be",
        },
        {
          name: "styles.css",
          url: "https://github.com/zolrath/obsidian-auto-link-title/releases/download/1.5.5/styles.css",
          sha256: "040d99c787acf90dba4374c21b67417dde43acc59ed4ab9bcee510bfbc4508b2",
        },
      ]
    : [
        {
          name: "manifest.json",
          url: "https://github.com/denolehov/obsidian-url-into-selection/releases/download/1.11.4/manifest.json",
          sha256: "6573c0ef277b0eb366e19acd558445a46473a5fccf0b7e80b9e07dc95f8b0443",
        },
        {
          name: "main.js",
          url: "https://github.com/denolehov/obsidian-url-into-selection/releases/download/1.11.4/main.js",
          sha256: "377883d2fc2a1feeb96be868f7110782874206cb3065635281e89fdfdc6e6d77",
        },
      ];

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function tomorrowDate() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0"))
    .join("-");
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
            target.url.endsWith("/dist/renderer/index-trusted.html"),
        );
        if (main?.webSocketDebuggerUrl) return main;
      }
    } catch {
      // The debugging endpoint is not ready yet.
    }
    await delay(100);
  }
  throw new Error("Threadleaf did not expose its trusted renderer within 10 seconds.");
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

async function waitFor(probe, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await delay(50);
  }
  throw new Error(`${message}: ${JSON.stringify(last)}`);
}

async function stagePluginPackage() {
  await fs.mkdir(pluginPath, { recursive: true });
  if (sourcePluginPath) {
    for (const name of ["manifest.json", "main.js", "styles.css", "data.json"]) {
      const source = path.join(sourcePluginPath, name);
      const bytes = await fs.readFile(source).catch(() => null);
      if (bytes) await fs.writeFile(path.join(pluginPath, name), bytes);
    }
  } else {
    for (const asset of officialAssets) {
      const response = await fetch(asset.url, { redirect: "follow" });
      assert(response.ok, `Could not fetch official ${asset.name}: HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert(
        sha256(bytes) === asset.sha256,
        `Official ${asset.name} did not match the pinned SHA-256.`,
      );
      await fs.writeFile(path.join(pluginPath, asset.name), bytes);
    }
  }
  const manifest = JSON.parse(await fs.readFile(path.join(pluginPath, "manifest.json"), "utf8"));
  assert(manifest.id === pluginId, "The staged package has the wrong plugin ID.");
  assert(manifest.version === pluginVersion, "The staged package has the wrong plugin version.");
  return sha256(await fs.readFile(path.join(pluginPath, "main.js")));
}

async function startTitleServer() {
  const port = await availablePort();
  titleServer = net.createServer((socket) => {
    socket.once("data", (request) => {
      const method = String(request).split(" ", 1)[0];
      const body =
        "<!doctype html><html><head><title>Threadleaf Compatibility Page</title></head><body>fixture</body></html>";
      socket.end(
        method === "HEAD"
          ? "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
          : `HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
    });
  });
  await new Promise((resolve, reject) => {
    titleServer.once("error", reject);
    titleServer.listen(port, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${port}/article`;
}

async function focusAndSelectAllEditor() {
  await evaluate(`(() => {
    const editor = document.querySelector('[data-pane-id="primary"] .cm-content');
    if (!(editor instanceof HTMLElement)) return false;
    editor.focus();
    return document.activeElement === editor;
  })()`);
  for (const type of ["keyDown", "keyUp"]) {
    await cdp.send("Input.dispatchKeyEvent", {
      type,
      key: "a",
      code: "KeyA",
      modifiers: 2,
      windowsVirtualKeyCode: 65,
    });
  }
}

async function dispatchTextPaste(text) {
  return evaluate(`(() => {
    const editor = document.querySelector('[data-pane-id="primary"] .cm-content');
    if (!(editor instanceof HTMLElement)) return { dispatched: false, reason: "missing" };
    const transfer = new DataTransfer();
    transfer.setData("text/plain", ${JSON.stringify(text)});
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    });
    const dispatchResult = editor.dispatchEvent(event);
    return {
      defaultPrevented: event.defaultPrevented,
      dispatched: true,
      dispatchResult,
      focused: document.activeElement === editor,
    };
  })()`);
}

async function editorText() {
  return evaluate(`[
    ...document.querySelectorAll('[data-pane-id="primary"] .cm-content .cm-line')
  ].map((line) => line.textContent ?? "").join("\\n")`);
}

async function dispatchEditorKey(key, code, windowsVirtualKeyCode, modifiers = 0) {
  for (const type of ["rawKeyDown", "keyUp"]) {
    await cdp.send("Input.dispatchKeyEvent", {
      type,
      key,
      code,
      modifiers,
      windowsVirtualKeyCode,
    });
  }
}

async function captureScreenshot(name) {
  if (!screenshotDirectory) return;
  await fs.mkdir(screenshotDirectory, { recursive: true });
  const screenshot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  });
  await fs.writeFile(path.join(screenshotDirectory, name), Buffer.from(screenshot.data, "base64"));
}

try {
  if (process.platform !== "linux") {
    throw new Error("The URL selection paste check currently requires Linux and Xvfb.");
  }
  await fs.access(electronPath);
  const bundleSha256 = await stagePluginPackage();
  const titleUrl = autoLinkTitleMode ? await startTitleServer() : "https://example.test/path";
  await fs.mkdir(userDataPath, { recursive: true });
  await fs.writeFile(
    path.join(vaultPath, "Welcome.md"),
    naturalDatesMode ? "tomorrow" : autoLinkTitleMode ? "" : "Threadleaf",
    "utf8",
  );
  const canonicalVaultPath = await fs.realpath(vaultPath);
  const vaultId = sha256(Buffer.from(canonicalVaultPath));
  await fs.writeFile(
    path.join(userDataPath, "settings.json"),
    `${JSON.stringify(
      {
        version: 4,
        keyBindings: {},
        appearanceByVault: {
          [vaultId]: { colorScheme: e2eColorScheme, themeId: null, enabledSnippetIds: [] },
        },
        pluginsByVault: {
          [vaultId]: {
            compatibilityMode: "enabled",
            compatibilityTopology: "trusted-workspace",
            enabledPluginIds: [pluginId],
            capabilityGrantsByPlugin: {},
          },
        },
        noteWorkflowsByVault: {},
        workspaceByVault: {
          [vaultId]: {
            defaultNoteFolder: "",
            attachmentFolder: "",
            linkStyle: "preserve",
            automaticLinkUpdates: "ask",
            confirmDelete: "always",
            newTabBehavior: "focus",
            editorMode: "source",
            documentView: "source",
            showInlineTitle: true,
            readableLineLength: true,
            showLineNumbers: false,
            spellcheck: true,
            tabSize: 2,
            showStatusBar: true,
            restorePolicy: "fresh",
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
      "-s",
      "-screen 0 1440x900x24 -nolisten tcp",
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
        THREADLEAF_PLUGIN_E2E_DIAGNOSTICS: "1",
        THREADLEAF_VAULT_PATH: canonicalVaultPath,
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
      if (output.length > 100) output.shift();
    });
  }
  const target = await waitForMainTarget(port);
  cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1180,
    height: 820,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const catalog = await waitFor(
    async () => {
      const state = await evaluate(`window.threadleaf.getSnapshot().then(async (snapshot) => ({
        snapshot,
        catalog: await window.threadleaf.getPlugins(snapshot.vault?.id),
      }))`);
      const plugin = state?.catalog?.catalog?.plugins?.find(({ id }) => id === pluginId);
      return !state?.snapshot?.startup &&
        state?.snapshot?.workspace?.state === "ready" &&
        plugin?.packageState === "ready"
        ? { plugin, vaultId: state.snapshot.vault.id }
        : null;
    },
    `The exact ${pluginId} package did not appear in the ready vault catalog`,
    15_000,
  );
  assert(
    catalog.plugin.capabilityReport?.bundleSha256 === bundleSha256,
    "The discovered package did not retain the staged main bundle identity.",
  );
  await evaluate(
    `window.threadleaf.setPluginCapabilityGrant(${JSON.stringify(catalog.vaultId)}, ${JSON.stringify(pluginId)}, ${JSON.stringify(bundleSha256)}, true)`,
  );
  try {
    await waitFor(
      () =>
        evaluate(`window.threadleaf.getSnapshot().then((snapshot) => ({
          loaded: snapshot.plugins?.some((plugin) =>
            plugin.id === ${JSON.stringify(pluginId)} &&
            plugin.state === "loaded" &&
            plugin.compatibilityLevel === 3
          ),
          pasteRegistered: snapshot.integrations?.workspaceEvents?.includes("editor-paste") === true,
          editorSuggests: snapshot.integrations?.editorSuggests ?? 0,
          commandCount: snapshot.commands?.filter((command) =>
            command.id.startsWith(${JSON.stringify(`${pluginId}:`)})
          ).length ?? 0,
        }))`).then(
          (state) =>
            state.loaded &&
            (naturalDatesMode
              ? state.editorSuggests === 1 && state.commandCount === 8
              : state.pasteRegistered),
        ),
      naturalDatesMode
        ? "The exact plugin did not load and register its commands and editor suggest"
        : "The exact plugin did not load and register editor-paste",
      20_000,
    );
  } catch (error) {
    const diagnostic = await evaluate(`window.threadleaf.getSnapshot().then(async (snapshot) => ({
      plugins: snapshot.plugins,
      events: snapshot.events.slice(-20),
      catalog: (await window.threadleaf.getPlugins(snapshot.vault?.id)).catalog?.plugins?.find(
        (plugin) => plugin.id === ${JSON.stringify(pluginId)}
      )
    }))`);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}: ${JSON.stringify(diagnostic)}`,
    );
  }

  if (naturalDatesMode) {
    await focusAndSelectAllEditor();
    const command = await evaluate(`(() => {
      const open = document.querySelector("#command-trigger");
      const query = document.querySelector("#palette-query");
      if (!(open instanceof HTMLButtonElement) || !(query instanceof HTMLInputElement)) {
        return { opened: false, selected: false };
      }
      open.click();
      query.value = "nldates-obsidian:nlp-dates";
      query.dispatchEvent(new Event("input", { bubbles: true }));
      const option = document.querySelector(
        '[data-command-id="plugin.command.nldates-obsidian:nlp-dates"]'
      );
      if (!(option instanceof HTMLButtonElement) || option.disabled) {
        return { opened: true, selected: false };
      }
      option.click();
      return { opened: true, selected: true };
    })()`);
    assert(
      command.opened && command.selected,
      `The Natural Language Dates command was not reachable in the command palette: ${JSON.stringify(command)}`,
    );
    const expected = `[[${tomorrowDate()}]]`;
    try {
      await waitFor(
        async () => (await editorText()) === expected,
        "Natural Language Dates did not parse the selected word through its visible command",
      );
    } catch (error) {
      const diagnostic = await evaluate(`window.threadleaf.getSnapshot().then((snapshot) => ({
        events: snapshot.events.slice(-20),
        editorUpdate: snapshot.editorUpdate,
        toast: document.querySelector("#toast")?.textContent ?? "",
        paletteOpen: document.querySelector("#command-palette")?.open ?? false
      }))`);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}: editor=${JSON.stringify(await editorText())} state=${JSON.stringify(diagnostic)}`,
      );
    }
    const naturalDatesState = await evaluate(`window.threadleaf.getSnapshot().then((snapshot) => ({
      commands: snapshot.commands.filter((command) =>
        command.id.startsWith("nldates-obsidian:")
      ).map((command) => command.id),
      editorSuggests: snapshot.integrations?.editorSuggests ?? 0,
      errors: snapshot.events.filter((event) => event.kind === "error").slice(-5),
      toast: document.querySelector("#toast")?.textContent ?? ""
    }))`);
    assert(
      naturalDatesState.commands.length === 8 &&
        naturalDatesState.editorSuggests === 1 &&
        naturalDatesState.errors.length === 0 &&
        !naturalDatesState.toast.includes("failed"),
      `Natural Language Dates exposed an incomplete registration or runtime failure: ${JSON.stringify(naturalDatesState)}`,
    );
    await captureScreenshot("natural-dates-command.png");

    await focusAndSelectAllEditor();
    for (const character of ["@", "t", "o"]) {
      await cdp.send("Input.insertText", { text: character });
      await delay(30);
    }
    let autosuggest;
    try {
      autosuggest = await waitFor(
        () =>
          evaluate(`(() => {
          const popover = document.querySelector(".plugin-editor-suggest");
          if (!(popover instanceof HTMLElement) || popover.hidden) return null;
          return {
            labels: [...popover.querySelectorAll(".plugin-editor-suggest-option")].map(
              (option) => option.textContent ?? ""
            ),
            instructions: popover.querySelector(".plugin-editor-suggest-instructions")?.textContent ?? "",
            selected: popover.querySelector('[aria-selected="true"]')?.textContent ?? "",
          };
        })()`),
        "Natural Language Dates did not expose its visible @to editor suggestions",
      );
    } catch (error) {
      const diagnostic = await evaluate(`window.threadleaf.getSnapshot().then((snapshot) => ({
        busy: [...document.querySelectorAll("button")].some((button) => button.disabled),
        editorSuggest: snapshot.editorSuggest,
        editorSuggests: snapshot.integrations?.editorSuggests ?? 0,
        errors: snapshot.events.filter((event) => event.kind === "error").slice(-10),
        focused: document.activeElement?.className ?? "",
        popover: document.querySelector(".plugin-editor-suggest")?.outerHTML ?? "",
        toast: document.querySelector("#toast")?.textContent ?? ""
      }))`);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}: editor=${JSON.stringify(await editorText())} state=${JSON.stringify(diagnostic)}`,
      );
    }
    assert(
      JSON.stringify(autosuggest.labels) === JSON.stringify(["Today", "Tomorrow"]) &&
        autosuggest.selected === "Today",
      `Natural Language Dates exposed unexpected editor suggestions: ${JSON.stringify(autosuggest)}`,
    );
    await captureScreenshot("natural-dates-autosuggest.png");
    await dispatchEditorKey("ArrowDown", "ArrowDown", 40);
    await dispatchEditorKey("Enter", "Enter", 13);
    try {
      await waitFor(
        async () => (await editorText()) === expected,
        "Natural Language Dates did not select Tomorrow through the visible editor suggestion",
      );
    } catch (error) {
      const diagnostic = await evaluate(`window.threadleaf.getSnapshot().then((snapshot) => ({
        editorSuggest: snapshot.editorSuggest,
        editorUpdate: snapshot.editorUpdate,
        errors: snapshot.events.filter((event) => event.kind === "error").slice(-10),
        popover: document.querySelector(".plugin-editor-suggest")?.outerHTML ?? "",
        toast: document.querySelector("#toast")?.textContent ?? ""
      }))`);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}: editor=${JSON.stringify(await editorText())} state=${JSON.stringify(diagnostic)}`,
      );
    }
    const autosuggestResult = await evaluate(`window.threadleaf.getSnapshot().then((snapshot) => ({
      editorSuggest: snapshot.editorSuggest,
      errors: snapshot.events.filter((event) => event.kind === "error").slice(-5),
      popoverHidden: document.querySelector(".plugin-editor-suggest")?.hidden ?? null,
      toast: document.querySelector("#toast")?.textContent ?? ""
    }))`);
    assert(
      autosuggestResult.editorSuggest === null &&
        autosuggestResult.errors.length === 0 &&
        autosuggestResult.popoverHidden === true &&
        !autosuggestResult.toast.includes("failed"),
      `Natural Language Dates left an incomplete suggestion session: ${JSON.stringify(autosuggestResult)}`,
    );
    await captureScreenshot("natural-dates-autosuggest-selected.png");
    console.log(
      JSON.stringify({
        verified: true,
        pluginId,
        version: pluginVersion,
        bundleSha256,
        source: sourcePluginPath ? "operator-package" : "official-release",
        colorScheme: e2eColorScheme,
        workflows: {
          naturalLanguageDateCommand: expected,
          naturalLanguageDateAutosuggest: {
            input: "@to",
            labels: autosuggest.labels,
            selected: expected,
          },
          commands: naturalDatesState.commands.length,
          editorSuggests: naturalDatesState.editorSuggests,
        },
      }),
    );
  } else {
    await focusAndSelectAllEditor();
    const urlPaste = await dispatchTextPaste(titleUrl);
    assert(
      urlPaste.dispatched && urlPaste.focused && urlPaste.defaultPrevented,
      `The URL paste did not enter the compatibility path: ${JSON.stringify(urlPaste)}`,
    );
    try {
      await waitFor(
        async () =>
          (await editorText()) ===
          (autoLinkTitleMode
            ? `[Threadleaf Compatibility Page](${titleUrl})`
            : "[Threadleaf](https://example.test/path)"),
        autoLinkTitleMode
          ? "The exact plugin did not replace its fetching placeholder with the remote title"
          : "The exact plugin did not wrap selected text with the pasted URL",
      );
    } catch (error) {
      const diagnostic = await evaluate(`window.threadleaf.getSnapshot().then((snapshot) => ({
      events: snapshot.events.slice(-20),
      editorUpdate: snapshot.editorUpdate,
      editorEvent: snapshot.editorEvent,
      toast: document.querySelector("#toast")?.textContent ?? ""
    }))`);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}: editor=${JSON.stringify(await editorText())} state=${JSON.stringify(diagnostic)}`,
      );
    }
    if (autoLinkTitleMode) {
      await captureScreenshot("auto-link-title-link.png");
    }

    for (const type of ["keyDown", "keyUp"]) {
      await cdp.send("Input.dispatchKeyEvent", {
        type,
        key: "z",
        code: "KeyZ",
        modifiers: 2,
        windowsVirtualKeyCode: 90,
      });
    }
    await waitFor(
      async () => (await editorText()) === (autoLinkTitleMode ? "" : "Threadleaf"),
      "Undo did not reset the editor",
    );
    await focusAndSelectAllEditor();
    const ordinaryPaste = await dispatchTextPaste("ordinary text");
    assert(
      ordinaryPaste.dispatched && ordinaryPaste.focused && ordinaryPaste.defaultPrevented,
      `The ordinary paste did not enter the compatibility fallback: ${JSON.stringify(ordinaryPaste)}`,
    );
    await waitFor(
      async () => (await editorText()) === "ordinary text",
      "An unhandled paste was swallowed instead of falling back to ordinary text",
    );
    const ordinaryState = await evaluate(`window.threadleaf.getSnapshot().then((snapshot) => ({
    errors: snapshot.events.filter((event) => event.kind === "error").slice(-5),
    toast: document.querySelector("#toast")?.textContent ?? "",
  }))`);
    assert(
      !ordinaryState.toast.includes("failed") && ordinaryState.errors.length === 0,
      `The ordinary fallback exposed a compatibility failure: ${JSON.stringify(ordinaryState)}`,
    );

    await captureScreenshot(
      autoLinkTitleMode ? "auto-link-title-paste-final.png" : "url-selection-paste-final.png",
    );
    console.log(
      JSON.stringify({
        verified: true,
        pluginId,
        version: pluginVersion,
        bundleSha256,
        source: sourcePluginPath ? "operator-package" : "official-release",
        colorScheme: e2eColorScheme,
        workflows: {
          selectedUrlPaste: autoLinkTitleMode
            ? `[Threadleaf Compatibility Page](${titleUrl})`
            : "[Threadleaf](https://example.test/path)",
          ordinaryPasteFallback: "ordinary text",
        },
      }),
    );
  }
} catch (error) {
  console.error(output.join(""));
  throw error;
} finally {
  if (cdp && child && exited) {
    await evaluate("setTimeout(function(){ window.close(); }, 100); true").catch(() => undefined);
    await Promise.race([exited, delay(5_000)]);
    if (child.exitCode === null) child.kill("SIGTERM");
    cdp.close();
  }
  if (titleServer) {
    await new Promise((resolve) => titleServer.close(resolve)).catch(() => undefined);
  }
  await fs.rm(testRoot, { recursive: true, force: true }).catch(() => undefined);
}
