import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { installObsidianDomCompatibility } from "./obsidian-dom";
import { PluginHost } from "./plugin-host";

const fixtureVault = path.resolve("fixtures/vaults/basic");
const fixturePlugin = path.join(fixtureVault, ".obsidian", "plugins", "threadleaf-fixture");

async function readFixtureBytes(): Promise<Map<string, Buffer>> {
  const relativePaths = [
    "Welcome.md",
    "Linked Note.md",
    ".obsidian/plugins/threadleaf-fixture/manifest.json",
    ".obsidian/plugins/threadleaf-fixture/main.js",
    ".obsidian/plugins/threadleaf-fixture/styles.css",
  ];
  return new Map(
    await Promise.all(
      relativePaths.map(
        async (relativePath) =>
          [relativePath, await fs.readFile(path.join(fixtureVault, relativePath))] as const,
      ),
    ),
  );
}

describe("PluginHost", () => {
  it("builds synchronous frontmatter and link metadata from canonical vault files", () => {
    const host = new PluginHost(fixtureVault);
    const welcome = host.vault.getFileByPath("Welcome.md");

    expect(host.app.metadataCache.getFileCache(welcome)?.frontmatter).toEqual({
      kind: "compatibility-fixture",
    });
    expect(host.app.metadataCache.getCachedFiles()).toEqual([
      "Boards/Overview.canvas",
      "Linked Note.md",
      "Welcome.md",
    ]);
    const linked = host.app.metadataCache.getFirstLinkpathDest("Linked Note#Heading", "Welcome.md");
    expect(linked?.path).toBe("Linked Note.md");
    expect(linked && host.app.metadataCache.fileToLinktext(linked, "Welcome.md", true)).toBe(
      "Linked Note",
    );

    const changed: string[] = [];
    const eventRef = host.app.metadataCache.on("changed", (file) => {
      changed.push((file as { path: string }).path);
    });
    host.app.metadataCache.trigger("changed", welcome);
    host.app.metadataCache.offref(eventRef);
    host.app.metadataCache.trigger("changed", welcome);
    expect(changed).toEqual(["Welcome.md"]);
  });

  it("loads an unchanged CommonJS plugin and verifies its command workflow", async () => {
    const before = await readFixtureBytes();
    const host = new PluginHost(fixtureVault);

    const loaded = await host.loadPlugin(fixturePlugin);
    expect(loaded.vault.markdownFileCount).toBe(2);
    expect(loaded.plugin).toMatchObject({
      id: "threadleaf-fixture",
      state: "loaded",
      compatibilityLevel: 3,
      stylesheetDiscovered: true,
    });
    expect(host.app.plugins.getPlugin("threadleaf-fixture")?._loaded).toBe(true);
    expect(loaded.commands).toEqual([
      {
        id: "threadleaf-fixture-confirm",
        name: "Confirm compatibility bridge",
        ownerId: "threadleaf-fixture",
      },
    ]);

    const verified = await host.runCommand("threadleaf-fixture-confirm");
    expect(verified.plugin?.compatibilityLevel).toBe(4);
    expect(verified.notices).toContain("Fixture command crossed the compatibility bridge.");

    const after = await readFixtureBytes();
    expect(after).toEqual(before);
  });

  it("rechecks the exact bundle bytes immediately before plugin execution", async () => {
    const bundleBytes = await fs.readFile(path.join(fixturePlugin, "main.js"));
    const bundleSha256 = createHash("sha256").update(bundleBytes).digest("hex");
    const blockedHost = new PluginHost(fixtureVault);

    await expect(blockedHost.loadPlugin(fixturePlugin, "0".repeat(64))).rejects.toThrow(
      "[managed-package-changed].",
    );
    const blocked = await blockedHost.getSnapshot();
    expect(blocked.plugin).toMatchObject({
      id: "threadleaf-fixture",
      state: "failed",
      compatibilityLevel: 0,
      error: expect.stringContaining("[managed-package-changed]."),
    });
    expect(blocked.commands).toEqual([]);
    expect(blocked.notices).toEqual([]);
    expect(blocked.events.some(({ message }) => message.includes("Injected"))).toBe(false);
    await blockedHost.close();

    const allowedHost = new PluginHost(fixtureVault);
    const allowed = await allowedHost.loadPlugin(fixturePlugin, bundleSha256);
    expect(allowed.plugin).toMatchObject({
      id: "threadleaf-fixture",
      state: "loaded",
      compatibilityLevel: 3,
    });
    await allowedHost.close();
  });

  it("releases command registrations on unload and recreates them on reload", async () => {
    const host = new PluginHost(fixtureVault);
    await host.loadPlugin(fixturePlugin);

    const unloaded = await host.unloadPlugin();
    expect(unloaded.plugin?.state).toBe("unloaded");
    expect(unloaded.commands).toEqual([]);

    const reloaded = await host.reloadPlugin();
    expect(reloaded.plugin?.state).toBe("loaded");
    expect(reloaded.commands).toHaveLength(1);
    expect(reloaded.events.filter(({ message }) => message.startsWith("Unloaded "))).toHaveLength(
      1,
    );
  });

  it("closes plugin-owned modals on unload without duplicating them after reload", async () => {
    const sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-plugin-modal-"));
    const vaultPath = path.join(sandboxPath, "vault");
    const pluginPath = path.join(vaultPath, ".obsidian", "plugins", "modal-fixture");
    const otherPluginPath = path.join(vaultPath, ".obsidian", "plugins", "other-modal-fixture");
    const dom = new JSDOM("<!doctype html><body></body>", {
      url: "https://threadleaf.invalid/",
    });
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    try {
      installObsidianDomCompatibility(dom.window);
      Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
      });
      const pluginSource = `const { Modal, Plugin } = require("obsidian");
class FixtureModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }
  onOpen() { this.containerEl.addClass(this.plugin.manifest.id); }
}
module.exports = class ModalFixture extends Plugin {
  async onload() { new FixtureModal(this.app, this).open(); }
};
`;
      for (const [directoryPath, manifest] of [
        [pluginPath, { id: "modal-fixture", name: "Modal fixture", version: "0.1.0" }],
        [
          otherPluginPath,
          { id: "other-modal-fixture", name: "Other modal fixture", version: "0.1.0" },
        ],
      ] as const) {
        await fs.mkdir(directoryPath, { recursive: true });
        await fs.writeFile(
          path.join(directoryPath, "manifest.json"),
          JSON.stringify(manifest),
          "utf8",
        );
        await fs.writeFile(path.join(directoryPath, "main.js"), pluginSource, "utf8");
      }

      const host = new PluginHost(vaultPath);
      await host.loadPlugin(pluginPath);
      await host.loadPlugin(otherPluginPath);
      expect(dom.window.document.querySelectorAll(".modal-fixture")).toHaveLength(1);
      expect(dom.window.document.querySelectorAll(".other-modal-fixture")).toHaveLength(1);

      await host.unloadPlugin("modal-fixture");
      expect(dom.window.document.querySelectorAll(".modal-fixture")).toHaveLength(0);
      expect(dom.window.document.querySelectorAll(".other-modal-fixture")).toHaveLength(1);

      await host.reloadPlugin("modal-fixture");
      expect(dom.window.document.querySelectorAll(".modal-fixture")).toHaveLength(1);
      expect(dom.window.document.querySelectorAll(".other-modal-fixture")).toHaveLength(1);
    } finally {
      if (previousWindow === undefined) {
        Reflect.deleteProperty(globalThis, "window");
      } else {
        globalThis.window = previousWindow;
      }
      if (previousDocument === undefined) {
        Reflect.deleteProperty(globalThis, "document");
      } else {
        globalThis.document = previousDocument;
      }
      dom.window.close();
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });

  it("persists plugin data across reloads and host restarts", async () => {
    const sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-plugin-data-"));
    const vaultPath = path.join(sandboxPath, "vault");
    const pluginPath = path.join(vaultPath, ".obsidian", "plugins", "data-fixture");
    try {
      await fs.mkdir(pluginPath, { recursive: true });
      await fs.writeFile(
        path.join(pluginPath, "manifest.json"),
        JSON.stringify({ id: "data-fixture", name: "Data fixture", version: "0.1.0" }),
        "utf8",
      );
      await fs.writeFile(
        path.join(pluginPath, "main.js"),
        `const { Plugin } = require("obsidian");
module.exports = class DataFixture extends Plugin {
  async onload() {
    const data = (await this.loadData()) ?? { loads: 0 };
    data.loads += 1;
    await this.saveData(data);
    this.addCommand({ id: "data-fixture-command", name: "Data fixture command", callback() {} });
  }
};
`,
        "utf8",
      );

      const host = new PluginHost(vaultPath);
      await host.loadPlugin(pluginPath);
      await expect(fs.readFile(path.join(pluginPath, "data.json"), "utf8")).resolves.toContain(
        '"loads": 1',
      );

      await host.reloadPlugin("data-fixture");
      await expect(fs.readFile(path.join(pluginPath, "data.json"), "utf8")).resolves.toContain(
        '"loads": 2',
      );

      const restartedHost = new PluginHost(vaultPath);
      await restartedHost.loadPlugin(pluginPath);
      await expect(fs.readFile(path.join(pluginPath, "data.json"), "utf8")).resolves.toContain(
        '"loads": 3',
      );
    } finally {
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });

  it("owns multiple plugin lifecycles independently", async () => {
    const sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-plugin-host-"));
    const vaultPath = path.join(sandboxPath, "vault");
    try {
      await fs.cp(fixtureVault, vaultPath, { recursive: true });
      const secondPlugin = path.join(vaultPath, ".obsidian", "plugins", "threadleaf-secondary");
      await fs.mkdir(secondPlugin, { recursive: true });
      await fs.writeFile(
        path.join(secondPlugin, "manifest.json"),
        JSON.stringify({
          id: "threadleaf-secondary",
          name: "Threadleaf Secondary Fixture",
          version: "0.1.0",
        }),
        "utf8",
      );
      await fs.writeFile(
        path.join(secondPlugin, "main.js"),
        `const { Plugin } = require("obsidian");
module.exports = class SecondaryPlugin extends Plugin {
  async onload() {
    this.addCommand({ id: "threadleaf-secondary-confirm", name: "Confirm second plugin", callback() {} });
  }
};
`,
        "utf8",
      );
      const host = new PluginHost(vaultPath);
      await host.loadPlugin(path.join(vaultPath, ".obsidian", "plugins", "threadleaf-fixture"));
      const bothLoaded = await host.loadPlugin(secondPlugin);

      expect(bothLoaded.plugins).toMatchObject([
        { id: "threadleaf-fixture", state: "loaded", compatibilityLevel: 3 },
        { id: "threadleaf-secondary", state: "loaded", compatibilityLevel: 3 },
      ]);
      expect(bothLoaded.commands.map(({ id, ownerId }) => ({ id, ownerId }))).toEqual([
        { id: "threadleaf-fixture-confirm", ownerId: "threadleaf-fixture" },
        { id: "threadleaf-secondary-confirm", ownerId: "threadleaf-secondary" },
      ]);

      const oneUnloaded = await host.unloadPlugin("threadleaf-secondary");
      expect(oneUnloaded.commands.map(({ id }) => id)).toEqual(["threadleaf-fixture-confirm"]);
      expect(oneUnloaded.plugins?.find(({ id }) => id === "threadleaf-fixture")?.state).toBe(
        "loaded",
      );

      const allUnloaded = await host.unloadAllPlugins();
      expect(allUnloaded.commands).toEqual([]);
      expect(allUnloaded.plugins?.every(({ state }) => state === "unloaded")).toBe(true);
    } finally {
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });

  it("continues unloading every plugin when one onunload hook fails", async () => {
    const sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-plugin-unload-"));
    const vaultPath = path.join(sandboxPath, "vault");
    try {
      await fs.cp(fixtureVault, vaultPath, { recursive: true });
      const failingPlugin = path.join(vaultPath, ".obsidian", "plugins", "failing-unload");
      await fs.mkdir(failingPlugin, { recursive: true });
      await fs.writeFile(
        path.join(failingPlugin, "manifest.json"),
        JSON.stringify({ id: "failing-unload", name: "Failing unload", version: "0.1.0" }),
        "utf8",
      );
      await fs.writeFile(
        path.join(failingPlugin, "main.js"),
        `const { Plugin } = require("obsidian");
module.exports = class FailingUnloadPlugin extends Plugin {
  async onload() {
    this.addCommand({ id: "failing-unload-command", name: "Failing unload command", callback() {} });
  }
  async onunload() {
    throw new Error("fixture onunload failure");
  }
};
`,
        "utf8",
      );

      const host = new PluginHost(vaultPath);
      await host.loadPlugin(failingPlugin);
      await host.loadPlugin(path.join(vaultPath, ".obsidian", "plugins", "threadleaf-fixture"));

      const unloaded = await host.unloadAllPlugins();

      expect(unloaded.commands).toEqual([]);
      expect(unloaded.plugins?.every(({ state }) => state === "unloaded")).toBe(true);
      expect(unloaded.plugins?.find(({ id }) => id === "failing-unload")?.error).toContain(
        "[runtime-unload-failed].",
      );
      expect(
        unloaded.events.some(({ message }) => message.includes("[runtime-unload-failed].")),
      ).toBe(true);
    } finally {
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });

  it("provides declared host modules to plugins copied outside the application tree", async () => {
    const sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-plugin-modules-"));
    const vaultPath = path.join(sandboxPath, "vault");
    try {
      await fs.mkdir(path.join(vaultPath, ".obsidian", "plugins"), { recursive: true });
      const pluginPath = path.join(vaultPath, ".obsidian", "plugins", "host-module-fixture");
      await fs.mkdir(pluginPath, { recursive: true });
      await fs.writeFile(
        path.join(pluginPath, "manifest.json"),
        JSON.stringify({
          id: "host-module-fixture",
          name: "Host module fixture",
          version: "0.1.0",
        }),
        "utf8",
      );
      await fs.writeFile(
        path.join(pluginPath, "main.js"),
        `const { EditorView } = require("@codemirror/view");
const { getLanguage, Notice, Plugin } = require("obsidian");
module.exports = class HostModulePlugin extends Plugin {
  async onload() {
    if (typeof EditorView !== "function") throw new Error("EditorView host module missing");
    if (!getLanguage()) throw new Error("Host language missing");
    this.addCommand({
      id: "confirm-host-module",
      name: "Confirm host module",
      callback: () => new Notice(EditorView.name + ":" + getLanguage()),
    });
  }
};
`,
        "utf8",
      );
      const host = new PluginHost(
        vaultPath,
        undefined,
        undefined,
        createRequire(path.resolve("package.json")),
      );

      const loaded = await host.loadPlugin(pluginPath);
      expect(loaded.plugin).toMatchObject({ state: "loaded", compatibilityLevel: 3 });

      const verified = await host.runCommand("confirm-host-module");
      expect(verified.notices.some((message) => message.startsWith("EditorView:"))).toBe(true);
    } finally {
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });

  it("provides UI base classes and releases registered integrations on unload", async () => {
    const sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-plugin-ui-api-"));
    const vaultPath = path.join(sandboxPath, "vault");
    const dom = new JSDOM("<!doctype html><body></body>", {
      url: "https://threadleaf.invalid/",
    });
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousElement = globalThis.Element;
    const previousMouseEvent = globalThis.MouseEvent;
    try {
      installObsidianDomCompatibility(dom.window);
      Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        Element: dom.window.Element,
        MouseEvent: dom.window.MouseEvent,
      });
      const pluginPath = path.join(vaultPath, ".obsidian", "plugins", "ui-api-fixture");
      await fs.mkdir(pluginPath, { recursive: true });
      await fs.writeFile(
        path.join(pluginPath, "manifest.json"),
        JSON.stringify({ id: "ui-api-fixture", name: "UI API fixture", version: "0.1.0" }),
        "utf8",
      );
      await fs.writeFile(
        path.join(pluginPath, "main.js"),
        `const {
  AbstractInputSuggest, BaseComponent, ButtonComponent, Component, DropdownComponent, EditorSuggest, FileView,
  FuzzySuggestModal, ItemView, MarkdownView, Modal, Notice, Plugin, PluginSettingTab,
  PopoverSuggest, Scope, Setting, SettingTab, SliderComponent, SuggestModal, TextFileView,
  ToggleComponent, View, Workspace, WorkspaceLeaf, addIcon, normalizePath, sanitizeHTMLToDom
} = require("obsidian");
if (![AbstractInputSuggest, BaseComponent, ButtonComponent, Component, DropdownComponent, EditorSuggest, FileView,
  FuzzySuggestModal, ItemView, MarkdownView, Modal, PluginSettingTab, Scope, Setting,
  PopoverSuggest, SettingTab, SliderComponent, SuggestModal, TextFileView, ToggleComponent, View,
  Workspace, WorkspaceLeaf].every((value) => typeof value === "function")) {
  throw new Error("UI base class export missing");
}
module.exports = class UiApiPlugin extends Plugin {
  async onload() {
    if (normalizePath("/Folder\\\\Note.md") !== "Folder/Note.md") throw new Error("normalizePath failed");
    if (normalizePath("") !== "") throw new Error("normalizePath root failed");
    const safe = sanitizeHTMLToDom("<strong>safe</strong><script>unsafe()</script><a href='javascript:unsafe()'>link</a>");
    if (safe.querySelector("script") || safe.querySelector("a").hasAttribute("href") || safe.textContent !== "safelink") {
      throw new Error("sanitizeHTMLToDom failed");
    }
    addIcon("ui-api-icon", "<path d='M0 0h1v1z'/>");
    this.registerView("ui-api-view", (leaf) => new ItemView(leaf));
    this.registerExtensions(["drawing"], "ui-api-view");
    this.addRibbonIcon("ui-api-icon", "Open drawing", () => {});
    this.addStatusBarItem().setText("Ready");
    this.addSettingTab(new (class extends PluginSettingTab {
      display() {
        window.__threadleafSettingsDisplays = (window.__threadleafSettingsDisplays || 0) + 1;
        this.containerEl.textContent = "UI API settings";
      }
      hide() {
        window.__threadleafSettingsHides = (window.__threadleafSettingsHides || 0) + 1;
        super.hide();
      }
    })(this.app, this));
    this.registerMarkdownPostProcessor(() => {});
    this.registerEditorSuggest(new (class extends EditorSuggest {})(this.app));
    this.app.workspace.onLayoutReady(() => new Notice("Fixture layout became ready."));
  }
};
`,
        "utf8",
      );

      const host = new PluginHost(vaultPath);
      const loaded = await host.loadPlugin(pluginPath);
      expect(loaded.plugin).toMatchObject({ state: "loaded", compatibilityLevel: 2 });
      expect(host.app.compatibility.snapshot()).toEqual({
        editorSuggests: 1,
        extensions: [{ extension: "drawing", viewType: "ui-api-view" }],
        markdownPostProcessors: 1,
        ribbonItems: 1,
        settingTabs: 1,
        settingTabPluginIds: ["ui-api-fixture"],
        statusBarItems: 1,
        viewTypes: ["ui-api-view"],
      });
      expect(loaded.notices).not.toContain("Fixture layout became ready.");

      await host.app.workspace.markLayoutReady();
      expect((await host.getSnapshot()).notices).toContain("Fixture layout became ready.");

      const settingsSnapshot = await host.openPluginSettings("ui-api-fixture");
      expect(settingsSnapshot.pluginSurface).toEqual({
        displayText: "UI API fixture settings",
        filePath: null,
        viewType: "threadleaf-plugin-settings",
      });
      expect(dom.window.document.querySelector(".vertical-tab-content")?.textContent).toBe(
        "UI API settings",
      );
      expect(dom.window.eval("window.__threadleafSettingsDisplays")).toBe(1);
      await host.closePluginView();
      expect(dom.window.eval("window.__threadleafSettingsHides")).toBe(1);
      expect(dom.window.document.querySelector("#threadleaf-plugin-surface")).toBeNull();

      const viewSnapshot = await host.openPluginView("ui-api-view", "Drawing.drawing");
      expect(viewSnapshot.pluginSurface).toMatchObject({
        filePath: null,
        viewType: "empty",
      });
      expect(host.app.workspace.getLayout()).toEqual({
        floating: { children: [], direction: "vertical", type: "split" },
        left: { children: [], direction: "vertical", type: "split" },
        main: {
          children: [
            {
              id: expect.stringMatching(/^threadleaf-leaf-/),
              state: {
                state: { file: "Drawing.drawing" },
                type: "ui-api-view",
              },
              type: "leaf",
            },
          ],
          direction: "vertical",
          type: "split",
        },
        right: { children: [], direction: "vertical", type: "split" },
      });

      const originalLeaf = host.app.workspace.activeLeaf;
      const splitLeaf = host.app.workspace.createLeafBySplit(originalLeaf);
      expect(splitLeaf).not.toBeNull();
      expect(host.app.workspace.getLayout().main.children).toHaveLength(2);
      expect((splitLeaf as { containerEl: HTMLElement }).containerEl.hidden).toBe(true);
      host.app.workspace.setActiveLeaf(splitLeaf);
      expect((splitLeaf as { containerEl: HTMLElement }).containerEl.hidden).toBe(false);
      expect((originalLeaf as { containerEl: HTMLElement }).containerEl.hidden).toBe(true);
      await fs.writeFile(path.join(vaultPath, "Drawing.md"), "# Drawing\n", "utf8");
      await (
        splitLeaf as {
          openFile(file: ReturnType<typeof host.app.createFile>): Promise<void>;
          view: { getViewType(): string } | null;
        }
      ).openFile(host.app.createFile("Drawing.md"));
      expect(
        (
          splitLeaf as {
            view: { getViewType(): string } | null;
          }
        ).view?.getViewType(),
      ).toBe("markdown");

      await host.unloadPlugin();
      expect(host.app.compatibility.snapshot()).toEqual({
        editorSuggests: 0,
        extensions: [],
        markdownPostProcessors: 0,
        ribbonItems: 0,
        settingTabs: 0,
        settingTabPluginIds: [],
        statusBarItems: 0,
        viewTypes: [],
      });
    } finally {
      if (previousWindow === undefined) {
        Reflect.deleteProperty(globalThis, "window");
      } else {
        globalThis.window = previousWindow;
      }
      if (previousDocument === undefined) {
        Reflect.deleteProperty(globalThis, "document");
      } else {
        globalThis.document = previousDocument;
      }
      if (previousElement === undefined) {
        Reflect.deleteProperty(globalThis, "Element");
      } else {
        globalThis.Element = previousElement;
      }
      if (previousMouseEvent === undefined) {
        Reflect.deleteProperty(globalThis, "MouseEvent");
      } else {
        globalThis.MouseEvent = previousMouseEvent;
      }
      dom.window.close();
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });

  it("runs check-callback commands against a native Markdown editor context", async () => {
    const sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-plugin-editor-"));
    const vaultPath = path.join(sandboxPath, "vault");
    const dom = new JSDOM("<!doctype html><body></body>", {
      url: "https://threadleaf.invalid/",
    });
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    try {
      installObsidianDomCompatibility(dom.window);
      Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
      });
      await fs.mkdir(vaultPath, { recursive: true });
      await fs.writeFile(path.join(vaultPath, "Welcome.md"), "alpha\nomega", "utf8");
      const pluginPath = path.join(vaultPath, ".obsidian", "plugins", "editor-fixture");
      await fs.mkdir(pluginPath, { recursive: true });
      await fs.writeFile(
        path.join(pluginPath, "manifest.json"),
        JSON.stringify({ id: "editor-fixture", name: "Editor fixture", version: "0.1.0" }),
        "utf8",
      );
      await fs.writeFile(
        path.join(pluginPath, "main.js"),
        `const { MarkdownView, Plugin } = require("obsidian");
module.exports = class EditorFixture extends Plugin {
  async onload() {
    this.addCommand({
      id: "insert-embed",
      name: "Insert drawing embed",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return false;
        if (checking) return true;
        view.editor.replaceSelection("![[Drawing.excalidraw.md]]");
        view.editor.focus();
        return true;
      },
    });
  }
};
`,
        "utf8",
      );

      const host = new PluginHost(vaultPath);
      await host.loadPlugin(pluginPath);
      await expect(host.runCommand("insert-embed")).rejects.toThrow("[runtime-command-failed].");

      const revision = "d".repeat(64);
      const snapshot = await host.runCommand("insert-embed", {
        path: "Welcome.md",
        content: "alpha\nomega",
        revision,
        selection: { anchor: 6, head: 6 },
      });

      expect(snapshot.editorUpdate).toEqual({
        baseContent: "alpha\nomega",
        content: "alpha\n![[Drawing.excalidraw.md]]omega",
        focused: true,
        id: "threadleaf-plugin-editor-1",
        path: "Welcome.md",
        revision,
        selection: { anchor: 32, head: 32 },
      });
      expect(snapshot.pluginSurface).toBeNull();
      expect(snapshot.plugin?.compatibilityLevel).toBe(4);
      await expect(fs.readFile(path.join(vaultPath, "Welcome.md"), "utf8")).resolves.toBe(
        "alpha\nomega",
      );

      const secondSnapshot = await host.runCommand("insert-embed", {
        path: "Welcome.md",
        content: "fresh content",
        revision: "e".repeat(64),
        selection: { anchor: 5, head: 5 },
      });
      expect(secondSnapshot.editorUpdate).toMatchObject({
        baseContent: "fresh content",
        content: "fresh![[Drawing.excalidraw.md]] content",
        revision: "e".repeat(64),
      });
    } finally {
      if (previousWindow === undefined) {
        Reflect.deleteProperty(globalThis, "window");
      } else {
        globalThis.window = previousWindow;
      }
      if (previousDocument === undefined) {
        Reflect.deleteProperty(globalThis, "document");
      } else {
        globalThis.document = previousDocument;
      }
      dom.window.close();
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });

  it("rejects plugin directories outside the active vault", async () => {
    const host = new PluginHost(fixtureVault);
    await expect(host.loadPlugin(path.resolve("fixtures"))).rejects.toThrow(
      "[package-path-escape].",
    );
  });
});
