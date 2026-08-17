import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { revisionOf } from "../kernel/durability";
import { testConstructionDispatch } from "../test-support/plugin-construction";
import { PluginHost } from "./plugin-host";

const fixtureVault = path.resolve("fixtures/vaults/basic");

async function withTestDocument<T>(callback: () => Promise<T>): Promise<T> {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://threadleaf.test/",
  });
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: dom.window.document,
    writable: true,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: dom.window,
    writable: true,
  });
  try {
    return await callback();
  } finally {
    if (previousDocument) {
      Object.defineProperty(globalThis, "document", previousDocument);
    } else {
      Reflect.deleteProperty(globalThis, "document");
    }
    if (previousWindow) {
      Object.defineProperty(globalThis, "window", previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
    dom.window.close();
  }
}

describe("Obsidian 1.13.7 runtime ledger evidence", () => {
  /** @compatibility-test-id obsidian-runtime.base-component.v1 */
  /** @compatibility-test-id obsidian-runtime.component.v1 */
  /** @compatibility-test-id obsidian-runtime.plugin.v1 */
  /** @compatibility-test-id obsidian-runtime.platform.v1 */
  /** @compatibility-test-id obsidian-runtime.api-version.v1 */
  /** @compatibility-test-id obsidian-runtime.normalize-path.v1 */
  it('delivers the bounded core slice through the real require("obsidian") binding', async () => {
    const sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-runtime-ledger-"));
    const vaultPath = path.join(sandboxPath, "vault");
    const pluginPath = path.join(vaultPath, ".obsidian", "plugins", "ledger-fixture");
    try {
      await fs.mkdir(pluginPath, { recursive: true });
      await fs.writeFile(
        path.join(pluginPath, "manifest.json"),
        JSON.stringify({ id: "ledger-fixture", name: "Ledger fixture", version: "1.0.0" }),
      );
      await fs.writeFile(
        path.join(pluginPath, "main.js"),
        [
          'const { apiVersion, BaseComponent, Component, Plugin, Platform, normalizePath, requireApiVersion } = require("obsidian");',
          "class LedgerPlugin extends Plugin {",
          "  async onload() {",
          "    const base = new BaseComponent().setDisabled(true);",
          "    const baseThenSelf = base.then((component) => component);",
          "    const child = new Component();",
          "    let released = false;",
          "    child.onunload = () => { released = true; };",
          "    const parent = new Component();",
          "    let parentLoaded = false;",
          "    let parentUnloaded = false;",
          "    parent.onload = () => { parentLoaded = true; };",
          "    parent.onunload = () => { parentUnloaded = true; };",
          "    let disposed = false;",
          "    parent.register(() => { disposed = true; });",
          "    let eventReleased = false;",
          "    parent.registerEvent({ off: () => { eventReleased = true; } });",
          "    const domTarget = {",
          "      added: 0,",
          "      removed: 0,",
          "      addEventListener() { this.added += 1; },",
          "      removeEventListener() { this.removed += 1; },",
          "    };",
          '    parent.registerDomEvent(domTarget, "click", () => {});',
          '    parent.registerDomEvent(domTarget, "keydown", () => {});',
          '    parent.registerDomEvent(domTarget, "input", () => {});',
          "    parent.registerInterval(setInterval(() => {}, 60_000));",
          "    parent.addChild(child);",
          "    const removable = new Component();",
          "    parent.addChild(removable);",
          "    const removed = parent.removeChild(removable) === removable;",
          "    parent.load();",
          "    parent.unload();",
          "    globalThis.__threadleafRuntimeLedgerProbe = {",
          "      baseThenSelf: baseThenSelf === base,",
          "      baseDisabled: base.disabled,",
          "      parentLoaded,",
          "      parentUnloaded,",
          "      childReleased: released,",
          "      removed,",
          "      disposed,",
          "      eventReleased,",
          "      domListeners: [domTarget.added, domTarget.removed],",
          "      componentIsComponent: parent instanceof Component,",
          "      pluginIsPlugin: this instanceof Plugin,",
          "      desktop: Platform.isDesktop === true,",
          "      desktopApp: Platform.isDesktopApp === true,",
          "      mobile: Platform.isMobile === false,",
          "      linux: Platform.isLinux === true,",
          "      apiVersion,",
          '      apiVersionEqual: requireApiVersion("1.13.7"),',
          '      apiVersionOlder: requireApiVersion("1.13.6"),',
          '      apiVersionFuture: requireApiVersion("1.13.8"),',
          '      apiVersionInvalid: requireApiVersion("not-a-version"),',
          '      normalized: normalizePath("\\\\Folder\\\\Note.md"),',
          '      normalizedLeading: normalizePath("//Folder/Note.md"),',
          '      normalizedEmpty: normalizePath(""),',
          '      normalizedAlready: normalizePath("Folder/Note.md"),',
          "    };",
          "  }",
          "}",
          "module.exports = LedgerPlugin;",
          "",
        ].join("\n"),
      );
      const host = new PluginHost(fixtureVault);
      try {
        await host.loadAuthorizedPlugin(await testConstructionDispatch(pluginPath));
        expect(
          (globalThis as { __threadleafRuntimeLedgerProbe?: unknown })
            .__threadleafRuntimeLedgerProbe,
        ).toEqual({
          baseThenSelf: true,
          baseDisabled: true,
          parentLoaded: true,
          parentUnloaded: true,
          childReleased: true,
          removed: true,
          disposed: true,
          eventReleased: true,
          domListeners: [3, 3],
          componentIsComponent: true,
          pluginIsPlugin: true,
          desktop: true,
          desktopApp: true,
          mobile: true,
          linux: true,
          apiVersion: "1.13.7",
          apiVersionEqual: true,
          apiVersionOlder: true,
          apiVersionFuture: false,
          apiVersionInvalid: false,
          normalized: "Folder/Note.md",
          normalizedLeading: "Folder/Note.md",
          normalizedEmpty: "",
          normalizedAlready: "Folder/Note.md",
        });
      } finally {
        await host.close();
      }
    } finally {
      Reflect.deleteProperty(globalThis, "__threadleafRuntimeLedgerProbe");
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });

  /** @compatibility-test-id obsidian-runtime.plugin-surface.v1 */
  it('proves the implemented Plugin surface through require("obsidian")', async () => {
    await withTestDocument(async () => {
      const sandboxPath = await fs.mkdtemp(
        path.join(os.tmpdir(), "threadleaf-runtime-ledger-plugin-surface-"),
      );
      const vaultPath = path.join(sandboxPath, "vault");
      const pluginPath = path.join(vaultPath, ".obsidian", "plugins", "plugin-ledger-fixture");
      try {
        await fs.mkdir(pluginPath, { recursive: true });
        await fs.writeFile(
          path.join(pluginPath, "manifest.json"),
          JSON.stringify({
            id: "plugin-ledger-fixture",
            name: "Plugin ledger fixture",
            version: "1.0.0",
          }),
        );
        await fs.writeFile(
          path.join(pluginPath, "main.js"),
          [
            'const { App, EditorSuggest, ItemView, Plugin, PluginSettingTab, addIcon } = require("obsidian");',
            "class LedgerPlugin extends Plugin {",
            "  async onload() {",
            "    await super.onload();",
            "    const userEnableResult = Plugin.prototype.onUserEnable.call(this);",
            "    const externalSettingsResult = Plugin.prototype.onExternalSettingsChange?.call(this);",
            "    const initialSettings = await this.loadData();",
            '    if (initialSettings !== null) throw new Error("fixture data should start empty");',
            "    this.settings = { enabled: true, runs: 1 };",
            "    await this.saveData(this.settings);",
            "    const persistedSettings = await this.loadData();",
            '    addIcon("plugin-ledger-icon", "<path d=\\"M0 0h1v1z\\"/>");',
            '    const ribbon = this.addRibbonIcon("plugin-ledger-icon", "Ledger", () => {});',
            "    const status = this.addStatusBarItem();",
            '    status.textContent = "Ready";',
            '    const removedCommand = this.addCommand({ id: "removed-command", name: "Removed command", callback() {} });',
            "    this.removeCommand(removedCommand.id);",
            '    const activeCommand = this.addCommand({ id: "active-command", name: "Active command", callback() {} });',
            "    const settingTab = new PluginSettingTab(this.app, this);",
            "    this.addSettingTab(settingTab);",
            '    this.registerView("plugin-ledger-view", (leaf) => new ItemView(leaf));',
            '    this.registerHoverLinkSource("plugin-ledger-hover", { display: "Plugin ledger", defaultMod: true });',
            '    const basesEnabled = this.registerBasesView("plugin-ledger-base", { name: "Ledger base", icon: "table", factory: () => ({}) });',
            '    this.registerObsidianProtocolHandler("plugin-ledger-open", (params) => "protocol:" + params.note);',
            '    this.registerCliHandler("plugin-ledger:check", "Run the ledger check", { path: { value: "<path>", description: "A vault path" } }, (params) => "cli:" + params.path);',
            '    this.registerExtensions([".ledger"], "plugin-ledger-view");',
            '    const postProcessor = (element) => { element.querySelector("h1")?.setAttribute("data-plugin-ledger-post", "yes"); };',
            "    const returnedPostProcessor = this.registerMarkdownPostProcessor(postProcessor, 3);",
            '    const returnedCodeProcessor = this.registerMarkdownCodeBlockProcessor("ledger", (source, element) => { element.textContent = "code:" + source; }, 4);',
            "    const editorExtension = { pluginLedgerExtension: true };",
            "    this.registerEditorExtension(editorExtension);",
            "    const editorSuggest = new (class extends EditorSuggest {})(this.app);",
            "    this.registerEditorSuggest(editorSuggest);",
            '    const protocolResult = this.app.compatibility.invokeObsidianProtocol({ action: "plugin-ledger-open", note: "Welcome.md" });',
            '    const cliResult = await this.app.compatibility.invokeCliHandler("plugin-ledger:check", { path: "Welcome.md" });',
            "    globalThis.__threadleafRuntimeLedgerPluginProbe = {",
            "      appIsApp: this.app instanceof App,",
            "      manifest: { id: this.manifest.id, name: this.manifest.name },",
            "      pluginHooks: { userEnableResult, externalSettingsResult },",
            "      settings: this.settings,",
            "      persistedSettings,",
            "      ribbon: { tagName: ribbon.tagName, title: ribbon.title, icon: ribbon.dataset.icon },",
            "      statusText: status.textContent,",
            "      activeCommand: { id: activeCommand.id, name: activeCommand.name },",
            "      returnedPostProcessor: returnedPostProcessor === postProcessor,",
            "      returnedCodeProcessor: returnedCodeProcessor.sortOrder === 4,",
            "      editorExtensionRegistered: this.app.compatibility.getEditorExtensions().includes(editorExtension),",
            "      editorSuggestApp: editorSuggest.app === this.app,",
            '      hoverLinkSource: this.app.compatibility.getHoverLinkSource("plugin-ledger-hover"),',
            "      basesEnabled,",
            "      protocolResult,",
            "      cliResult,",
            "    };",
            "  }",
            "}",
            "module.exports = LedgerPlugin;",
            "",
          ].join("\n"),
        );

        const host = new PluginHost(vaultPath);
        try {
          const loaded = await host.loadAuthorizedPlugin(
            await testConstructionDispatch(pluginPath),
          );
          expect(
            (globalThis as { __threadleafRuntimeLedgerPluginProbe?: unknown })
              .__threadleafRuntimeLedgerPluginProbe,
          ).toEqual({
            appIsApp: true,
            manifest: { id: "plugin-ledger-fixture", name: "Plugin ledger fixture" },
            pluginHooks: { userEnableResult: undefined, externalSettingsResult: undefined },
            settings: { enabled: true, runs: 1 },
            persistedSettings: { enabled: true, runs: 1 },
            ribbon: { tagName: "BUTTON", title: "Ledger", icon: "plugin-ledger-icon" },
            statusText: "Ready",
            activeCommand: {
              id: "plugin-ledger-fixture:active-command",
              name: "Plugin ledger fixture: Active command",
            },
            returnedPostProcessor: true,
            returnedCodeProcessor: true,
            editorExtensionRegistered: true,
            editorSuggestApp: true,
            hoverLinkSource: { display: "Plugin ledger", defaultMod: true },
            basesEnabled: false,
            protocolResult: "protocol:Welcome.md",
            cliResult: "cli:Welcome.md",
          });
          expect(host.app.compatibility.snapshot()).toEqual({
            editorSuggests: 1,
            extensions: [{ extension: "ledger", viewType: "plugin-ledger-view" }],
            markdownPostProcessors: 2,
            ribbonItems: 1,
            settingTabs: 1,
            settingTabPluginIds: ["plugin-ledger-fixture"],
            statusBarItems: 1,
            viewTypes: ["plugin-ledger-view"],
          });
          expect(loaded.commands.map(({ id }) => id)).toEqual([
            "plugin-ledger-fixture:active-command",
          ]);
          expect(
            loaded.events.some(({ message }) =>
              message.includes("Editor extensions are registered but unavailable"),
            ),
          ).toBe(true);
          expect(JSON.parse(await fs.readFile(path.join(pluginPath, "data.json"), "utf8"))).toEqual(
            { enabled: true, runs: 1 },
          );

          const projection = await host.renderMarkdownProjection(
            "plugin-ledger-fixture",
            "Welcome.md",
            "# Ledger\n\n```ledger\nhello\n```",
          );
          expect(projection.markdownProjection?.html).toContain("code:hello");
          expect(projection.markdownProjection?.html).toContain('data-plugin-ledger-post="yes"');

          await host.unloadPlugin();
          expect(host.app.compatibility.getHoverLinkSource("plugin-ledger-hover")).toBeNull();
          expect(() =>
            host.app.compatibility.invokeObsidianProtocol({
              action: "plugin-ledger-open",
              note: "Welcome.md",
            }),
          ).toThrow("Obsidian protocol action is not registered");
          await expect(
            host.app.compatibility.invokeCliHandler("plugin-ledger:check", {
              path: "Welcome.md",
            }),
          ).rejects.toThrow("CLI command is not registered");
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
          expect((await host.getSnapshot()).commands).toEqual([]);
        } finally {
          await host.close();
        }
      } finally {
        Reflect.deleteProperty(globalThis, "__threadleafRuntimeLedgerPluginProbe");
        await fs.rm(sandboxPath, { recursive: true, force: true });
      }
    });
  });

  /** @compatibility-test-id obsidian-runtime.app-context.v1 */
  it('proves App context, secret storage, theme, and local-storage behavior through require("obsidian")', async () => {
    await withTestDocument(async () => {
      const sandboxPath = await fs.mkdtemp(
        path.join(os.tmpdir(), "threadleaf-runtime-ledger-app-"),
      );
      const pluginPath = path.join(sandboxPath, "app-ledger-fixture");
      try {
        await fs.mkdir(pluginPath, { recursive: true });
        await fs.writeFile(
          path.join(pluginPath, "manifest.json"),
          JSON.stringify({
            id: "app-ledger-fixture",
            name: "App ledger fixture",
            version: "1.0.0",
          }),
        );
        await fs.writeFile(
          path.join(pluginPath, "main.js"),
          [
            'const { App, Events, Plugin, RenderContext, SecretStorage } = require("obsidian");',
            "class LedgerPlugin extends Plugin {",
            "  async onload() {",
            "    const changed = [];",
            '    const eventRef = this.app.secretStorage.on("changed", (id) => changed.push(id));',
            '    this.app.secretStorage.setSecret("ledger-token", "opaque-value");',
            '    this.app.secretStorage.setSecret("ledger-token", "rotated-value");',
            '    const secretValue = this.app.secretStorage.getSecret("ledger-token");',
            "    const secretListBeforeOff = this.app.secretStorage.listSecrets();",
            "    eventRef.off();",
            '    this.app.secretStorage.setSecret("ledger-after-off", "later");',
            "    let invalidSecretId = false;",
            "    try {",
            '      this.app.secretStorage.setSecret("Invalid ID", "rejected");',
            "    } catch {",
            "      invalidSecretId = true;",
            "    }",
            '    this.app.saveLocalStorage("ledger-settings", { enabled: true, count: 2 });',
            '    const localStorageValue = this.app.loadLocalStorage("ledger-settings");',
            '    this.app.saveLocalStorage("ledger-settings", null);',
            '    const localStorageCleared = this.app.loadLocalStorage("ledger-settings") === null;',
            "    let nonSerializable = false;",
            "    try {",
            '      this.app.saveLocalStorage("ledger-invalid", () => undefined);',
            "    } catch {",
            "      nonSerializable = true;",
            "    }",
            '    document.documentElement.dataset.theme = "dark";',
            '    document.documentElement.classList.add("theme-dark");',
            "    const dark = this.app.isDarkMode();",
            '    document.documentElement.dataset.theme = "light";',
            '    document.documentElement.classList.remove("theme-dark");',
            '    document.body.classList.remove("theme-dark");',
            "    const light = this.app.isDarkMode();",
            "    globalThis.__threadleafRuntimeLedgerAppProbe = {",
            "      appIsApp: this.app instanceof App,",
            "      renderContextIsPublicClass: this.app.renderContext instanceof RenderContext,",
            "      renderContextStartsEmpty: this.app.renderContext.hoverPopover === null,",
            "      secretStorageIsPublicClass: this.app.secretStorage instanceof SecretStorage,",
            "      secretStorageIsEvents: this.app.secretStorage instanceof Events,",
            '      secretValueWasRotated: secretValue === "rotated-value",',
            "      secretListBeforeOff,",
            "      secretEventsBeforeOff: changed,",
            "      secretEventsStopAfterOff: changed.length === 2,",
            "      secretListAfterOff: this.app.secretStorage.listSecrets(),",
            "      invalidSecretId,",
            "      localStorageValue,",
            "      localStorageCleared,",
            "      nonSerializable,",
            "      dark,",
            "      light,",
            "      lastEventStartsNull: this.app.lastEvent === null,",
            "    };",
            "  }",
            "}",
            "module.exports = LedgerPlugin;",
            "",
          ].join("\n"),
        );
        const host = new PluginHost(fixtureVault);
        try {
          await host.loadAuthorizedPlugin(await testConstructionDispatch(pluginPath));
          expect(
            (globalThis as { __threadleafRuntimeLedgerAppProbe?: unknown })
              .__threadleafRuntimeLedgerAppProbe,
          ).toEqual({
            appIsApp: true,
            renderContextIsPublicClass: true,
            renderContextStartsEmpty: true,
            secretStorageIsPublicClass: true,
            secretStorageIsEvents: true,
            secretValueWasRotated: true,
            secretListBeforeOff: ["ledger-token"],
            secretEventsBeforeOff: ["ledger-token", "ledger-token"],
            secretEventsStopAfterOff: true,
            secretListAfterOff: ["ledger-after-off", "ledger-token"],
            invalidSecretId: true,
            localStorageValue: { enabled: true, count: 2 },
            localStorageCleared: true,
            nonSerializable: true,
            dark: true,
            light: false,
            lastEventStartsNull: true,
          });
        } finally {
          await host.close();
        }
      } finally {
        Reflect.deleteProperty(globalThis, "__threadleafRuntimeLedgerAppProbe");
        await fs.rm(sandboxPath, { recursive: true, force: true });
      }
    });
  });

  /** @compatibility-test-id obsidian-runtime.workspace-parents.v1 */
  it('proves workspace item and leaf parent topology through require("obsidian")', async () => {
    await withTestDocument(async () => {
      const sandboxPath = await fs.mkdtemp(
        path.join(os.tmpdir(), "threadleaf-runtime-ledger-workspace-parents-"),
      );
      const pluginPath = path.join(sandboxPath, "workspace-parents-ledger-fixture");
      try {
        await fs.mkdir(pluginPath, { recursive: true });
        await fs.writeFile(
          path.join(pluginPath, "manifest.json"),
          JSON.stringify({
            id: "workspace-parents-ledger-fixture",
            name: "Workspace parents ledger fixture",
            version: "1.0.0",
          }),
        );
        await fs.writeFile(
          path.join(pluginPath, "main.js"),
          [
            'const { Plugin, WorkspaceItem, WorkspaceParent, WorkspaceSplit, WorkspaceTabs } = require("obsidian");',
            "class LedgerPlugin extends Plugin {",
            "  async onload() {",
            "    const leaf = this.app.workspace.getLeaf(false);",
            "    const root = this.app.workspace.rootSplit;",
            "    const tabs = leaf.parent;",
            "    const item = new WorkspaceItem();",
            "    item.parent = tabs;",
            "    const parent = new WorkspaceParent();",
            '    await leaf.setViewState({ type: "empty", state: { marker: true } });',
            "    leaf.togglePinned();",
            '    const other = this.app.workspace.getLeaf("split");',
            "    leaf.setGroupMember(other);",
            "    const leafState = leaf.getViewState();",
            "    globalThis.__threadleafRuntimeLedgerWorkspaceParentsProbe = {",
            "      rootIsWorkspaceSplit: root instanceof WorkspaceSplit,",
            "      leafIsWorkspaceItem: leaf instanceof WorkspaceItem,",
            "      parentIsWorkspaceItem: parent instanceof WorkspaceItem,",
            "      leafParentIsTabs: tabs instanceof WorkspaceTabs,",
            "      tabsParentIsRoot: tabs.parent === root,",
            "      leafParentContainsLeaf: tabs.children.includes(leaf),",
            "      leafRootIsRoot: leaf.getRoot() === root,",
            "      leafContainerIsRoot: leaf.getContainer() === root,",
            "      itemRootIsRoot: item.getRoot() === root,",
            "      hoverPopoverIsNull: leaf.hoverPopover === null,",
            '      viewStateIsEmpty: leafState.type === "empty",',
            "      viewStateStateIsPreserved: leafState.state.marker === true,",
            "      viewStateIsPinned: leafState.pinned === true,",
            "      viewStateGroupIsOther: leafState.group === other,",
            "    };",
            "  }",
            "}",
            "module.exports = LedgerPlugin;",
            "",
          ].join("\n"),
        );
        const host = new PluginHost(fixtureVault);
        try {
          await host.loadAuthorizedPlugin(await testConstructionDispatch(pluginPath));
          expect(
            (globalThis as { __threadleafRuntimeLedgerWorkspaceParentsProbe?: unknown })
              .__threadleafRuntimeLedgerWorkspaceParentsProbe,
          ).toEqual({
            rootIsWorkspaceSplit: true,
            leafIsWorkspaceItem: true,
            parentIsWorkspaceItem: true,
            leafParentIsTabs: true,
            tabsParentIsRoot: true,
            leafParentContainsLeaf: true,
            leafRootIsRoot: true,
            leafContainerIsRoot: true,
            itemRootIsRoot: true,
            hoverPopoverIsNull: true,
            viewStateIsEmpty: true,
            viewStateStateIsPreserved: true,
            viewStateIsPinned: true,
            viewStateGroupIsOther: true,
          });
        } finally {
          await host.close();
        }
      } finally {
        Reflect.deleteProperty(globalThis, "__threadleafRuntimeLedgerWorkspaceParentsProbe");
        await fs.rm(sandboxPath, { recursive: true, force: true });
      }
    });
  });

  /** @compatibility-test-id obsidian-runtime.utility-functions.v1 */
  /** @compatibility-test-id obsidian-runtime.reference-search-utilities.v1 */
  /** @compatibility-test-id obsidian-runtime.render-search-utilities.v1 */
  /** @compatibility-test-id obsidian-runtime.property-id.v1 */
  it('proves public link and search utilities through require("obsidian")', async () => {
    const sandboxPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "threadleaf-runtime-ledger-utils-"),
    );
    const pluginPath = path.join(sandboxPath, "utility-ledger-fixture");
    try {
      await fs.mkdir(pluginPath, { recursive: true });
      await fs.writeFile(
        path.join(pluginPath, "manifest.json"),
        JSON.stringify({
          id: "utility-ledger-fixture",
          name: "Utility ledger fixture",
          version: "1.0.0",
        }),
      );
      await fs.writeFile(
        path.join(pluginPath, "main.js"),
        [
          'const { Plugin, getLinkpath, iterateCacheRefs, iterateRefs, normalizePath, parseLinktext, parsePropertyId, prepareFuzzySearch, prepareSimpleSearch, renderMatches, renderResults, sortSearchResults } = require("obsidian");',
          "class LedgerPlugin extends Plugin {",
          "  async onload() {",
          '    const fuzzy = prepareFuzzySearch("dng");',
          '    const simple = prepareSimpleSearch("alpha beta");',
          '    const refs = [{ link: "one", original: "One" }, { link: "two", original: "Two" }];',
          "    const visitedRefs = [];",
          '    const refsStopped = iterateRefs(refs, (reference) => { visitedRefs.push(reference.link); return reference.link === "two"; });',
          "    const cacheVisited = [];",
          '    const cacheStopped = iterateCacheRefs({ links: [{ link: "link", original: "Link", position: {} }], embeds: [{ link: "embed", original: "Embed", position: {} }] }, (reference) => { cacheVisited.push(reference.link); });',
          "    const searchResults = [{ match: { score: 0.2, matches: [] } }, { match: { score: 0.9, matches: [] } }, { match: { score: 0.5, matches: [] } }];",
          "    sortSearchResults(searchResults);",
          '    const noteProperty = parsePropertyId("note.title");',
          '    const formulaProperty = parsePropertyId("formula.total.value");',
          '    const fileProperty = parsePropertyId("file");',
          '    const matchesElement = document.createElement("div");',
          '    renderMatches(matchesElement, "alpha beta", [[0, 5], [6, 10]]);',
          '    const offsetElement = document.createElement("div");',
          '    renderResults(offsetElement, "beta", { score: 1, matches: [[6, 10]] }, 6);',
          '    const plainElement = document.createElement("div");',
          '    renderMatches(plainElement, "plain", null);',
          "    globalThis.__threadleafRuntimeLedgerUtilityProbe = {",
          '      pathOnly: parseLinktext("Folder/Note"),',
          '      nestedSubpath: parseLinktext("Folder/Note#Heading#Nested"),',
          '      blockOnly: parseLinktext("#^block-id"),',
          '      linkpath: getLinkpath("Folder/Note#Heading"),',
          '      normalized: normalizePath("\\\\Folder\\\\Note.md"),',
          '      fuzzyMatches: fuzzy("Drawing").matches,',
          '      fuzzyNoMatch: fuzzy("Diagram") === null,',
          '      fuzzyEmpty: prepareFuzzySearch("")("Anything"),',
          '      simpleMatches: simple("alpha beta alpha").matches,',
          '      simpleNoMatch: simple("alpha only") === null,',
          '      simpleEmpty: prepareSimpleSearch("")("Anything"),',
          "      visitedRefs,",
          "      refsStopped,",
          "      cacheVisited,",
          "      cacheStopped,",
          "      sortedScores: searchResults.map((result) => result.match.score),",
          "      noteProperty,",
          "      formulaProperty,",
          "      fileProperty,",
          "      matchesHtml: matchesElement.innerHTML,",
          "      matchesText: matchesElement.textContent,",
          "      offsetHtml: offsetElement.innerHTML,",
          "      plainHtml: plainElement.innerHTML,",
          "    };",
          "  }",
          "}",
          "module.exports = LedgerPlugin;",
          "",
        ].join("\n"),
      );
      await withTestDocument(async () => {
        const host = new PluginHost(fixtureVault);
        try {
          await host.loadAuthorizedPlugin(await testConstructionDispatch(pluginPath));
          expect(
            (globalThis as { __threadleafRuntimeLedgerUtilityProbe?: unknown })
              .__threadleafRuntimeLedgerUtilityProbe,
          ).toEqual({
            pathOnly: { path: "Folder/Note", subpath: "" },
            nestedSubpath: { path: "Folder/Note", subpath: "#Heading#Nested" },
            blockOnly: { path: "", subpath: "#^block-id" },
            linkpath: "Folder/Note",
            normalized: "Folder/Note.md",
            fuzzyMatches: [
              [0, 1],
              [5, 7],
            ],
            fuzzyNoMatch: true,
            fuzzyEmpty: { score: 0, matches: [] },
            simpleMatches: [
              [0, 5],
              [6, 10],
              [11, 16],
            ],
            simpleNoMatch: true,
            simpleEmpty: { score: 0, matches: [] },
            visitedRefs: ["one", "two"],
            refsStopped: true,
            cacheVisited: ["link", "embed"],
            cacheStopped: false,
            sortedScores: [0.9, 0.5, 0.2],
            noteProperty: { type: "note", name: "title" },
            formulaProperty: { type: "formula", name: "total.value" },
            fileProperty: { type: "file", name: "" },
            matchesHtml:
              '<span class="search-result-file-matched-text">alpha</span> <span class="search-result-file-matched-text">beta</span>',
            matchesText: "alpha beta",
            offsetHtml: '<span class="search-result-file-matched-text">beta</span>',
            plainHtml: "plain",
          });
        } finally {
          await host.close();
        }
      });
    } finally {
      Reflect.deleteProperty(globalThis, "__threadleafRuntimeLedgerUtilityProbe");
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });

  /** @compatibility-test-id obsidian-runtime.binary-dom-utilities.v1 */
  it('proves binary, DOM, locale, Markdown, and YAML utilities through require("obsidian")', async () => {
    const sandboxPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "threadleaf-runtime-ledger-binary-dom-utilities-"),
    );
    const pluginPath = path.join(sandboxPath, "binary-dom-utilities-ledger-fixture");
    try {
      await fs.mkdir(pluginPath, { recursive: true });
      await fs.writeFile(
        path.join(pluginPath, "manifest.json"),
        JSON.stringify({
          id: "binary-dom-utilities-ledger-fixture",
          name: "Binary DOM utilities ledger fixture",
          version: "1.0.0",
        }),
      );
      await fs.writeFile(
        path.join(pluginPath, "main.js"),
        [
          'const { Plugin, arrayBufferToBase64, arrayBufferToHex, base64ToArrayBuffer, getLanguage, htmlToMarkdown, sanitizeHTMLToDom, stringifyYaml } = require("obsidian");',
          "class LedgerPlugin extends Plugin {",
          "  async onload() {",
          "    const input = new Uint8Array([0, 1, 2, 255]).buffer;",
          "    const encoded = arrayBufferToBase64(input);",
          '    const decoded = Array.from(new Uint8Array(base64ToArrayBuffer("AAEC/w==")));',
          '    const fragment = sanitizeHTMLToDom("<div onclick=\\"bad()\\"><script>bad</script><a href=\\"javascript:bad()\\">Safe</a><span>OK</span></div>");',
          '    const markdown = htmlToMarkdown("<h1>Title</h1><p>Body <strong>bold</strong></p>").trim();',
          '    const yaml = stringifyYaml({ title: "Example", tags: ["alpha", "beta"] }).trim();',
          '    const anchor = fragment.querySelector("a");',
          "    globalThis.__threadleafRuntimeLedgerBinaryDomUtilitiesProbe = {",
          "      base64: encoded,",
          "      hex: arrayBufferToHex(input),",
          "      decoded,",
          '      languageIsString: typeof getLanguage() === "string" && getLanguage().length > 0,',
          "      markdown,",
          '      scriptRemoved: fragment.querySelector("script") === null,',
          '      eventAttributeRemoved: fragment.querySelector("div").getAttribute("onclick") === null,',
          '      unsafeHrefRemoved: anchor?.getAttribute("href") === null,',
          '      textPreserved: fragment.textContent === "SafeOK",',
          "      yaml,",
          "    };",
          "  }",
          "}",
          "module.exports = LedgerPlugin;",
          "",
        ].join("\n"),
      );
      await withTestDocument(async () => {
        const host = new PluginHost(fixtureVault);
        try {
          await host.loadAuthorizedPlugin(await testConstructionDispatch(pluginPath));
          expect(
            (globalThis as { __threadleafRuntimeLedgerBinaryDomUtilitiesProbe?: unknown })
              .__threadleafRuntimeLedgerBinaryDomUtilitiesProbe,
          ).toEqual({
            base64: "AAEC/w==",
            hex: "000102ff",
            decoded: [0, 1, 2, 255],
            languageIsString: true,
            markdown: "# Title\n\nBody **bold**",
            scriptRemoved: true,
            eventAttributeRemoved: true,
            unsafeHrefRemoved: true,
            textPreserved: true,
            yaml: "title: Example\ntags:\n  - alpha\n  - beta",
          });
        } finally {
          await host.close();
        }
      });
    } finally {
      Reflect.deleteProperty(globalThis, "__threadleafRuntimeLedgerBinaryDomUtilitiesProbe");
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });

  /** @compatibility-test-id obsidian-runtime.frontmatter-utilities.v1 */
  it('proves frontmatter entry and tag utilities through require("obsidian")', async () => {
    const sandboxPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "threadleaf-runtime-ledger-frontmatter-utilities-"),
    );
    const pluginPath = path.join(sandboxPath, "frontmatter-utilities-ledger-fixture");
    try {
      await fs.mkdir(pluginPath, { recursive: true });
      await fs.writeFile(
        path.join(pluginPath, "manifest.json"),
        JSON.stringify({
          id: "frontmatter-utilities-ledger-fixture",
          name: "Frontmatter utilities ledger fixture",
          version: "1.0.0",
        }),
      );
      await fs.writeFile(
        path.join(pluginPath, "main.js"),
        [
          'const { Plugin, getAllTags, parseFrontMatterEntry, parseFrontMatterTags } = require("obsidian");',
          "class LedgerPlugin extends Plugin {",
          "  async onload() {",
          '    const frontmatter = { title: "Draft", status: "in-progress", tags: ["#Project/One", " invalid tag ", "##two/"] };',
          '    const cache = { frontmatter, tags: [{ tag: "#inline" }] };',
          "    globalThis.__threadleafRuntimeLedgerFrontmatterUtilitiesProbe = {",
          '      stringEntry: parseFrontMatterEntry(frontmatter, "title"),',
          "      regexEntry: parseFrontMatterEntry(frontmatter, /STATUS/i),",
          '      missingEntry: parseFrontMatterEntry(frontmatter, "missing"),',
          "      tagsFromArray: parseFrontMatterTags(frontmatter),",
          '      tagsFromString: parseFrontMatterTags({ tags: "one,two/" }),',
          '      tagsMissing: parseFrontMatterTags({ title: "Draft" }),',
          "      allTags: getAllTags(cache),",
          "      allTagsMissing: getAllTags({}),",
          "    };",
          "  }",
          "}",
          "module.exports = LedgerPlugin;",
          "",
        ].join("\n"),
      );
      const host = new PluginHost(fixtureVault);
      try {
        await host.loadAuthorizedPlugin(await testConstructionDispatch(pluginPath));
        expect(
          (globalThis as { __threadleafRuntimeLedgerFrontmatterUtilitiesProbe?: unknown })
            .__threadleafRuntimeLedgerFrontmatterUtilitiesProbe,
        ).toEqual({
          stringEntry: "Draft",
          regexEntry: "in-progress",
          missingEntry: null,
          tagsFromArray: ["#Project/One", "#two"],
          tagsFromString: ["#one", "#two"],
          tagsMissing: null,
          allTags: ["#Project/One", "#two", "#inline"],
          allTagsMissing: null,
        });
      } finally {
        await host.close();
      }
    } finally {
      Reflect.deleteProperty(globalThis, "__threadleafRuntimeLedgerFrontmatterUtilitiesProbe");
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });

  /** @compatibility-test-id obsidian-runtime.frontmatter-document-functions.v1 */
  it('proves frontmatter document and binary functions through require("obsidian")', async () => {
    const sandboxPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "threadleaf-runtime-ledger-frontmatter-document-functions-"),
    );
    const pluginPath = path.join(sandboxPath, "frontmatter-document-functions-ledger-fixture");
    try {
      await fs.mkdir(pluginPath, { recursive: true });
      await fs.writeFile(
        path.join(pluginPath, "manifest.json"),
        JSON.stringify({
          id: "frontmatter-document-functions-ledger-fixture",
          name: "Frontmatter document functions ledger fixture",
          version: "1.0.0",
        }),
      );
      await fs.writeFile(
        path.join(pluginPath, "main.js"),
        [
          'const { getBlobArrayBuffer, getFrontMatterInfo, hexToArrayBuffer, parseFrontMatterAliases, parseFrontMatterStringArray, parseYaml, Plugin } = require("obsidian");',
          "class LedgerPlugin extends Plugin {",
          "  async onload() {",
          '    const content = "---\\ntitle: Example\\n---\\n# Note\\n";',
          "    const info = getFrontMatterInfo(content);",
          '    const missing = getFrontMatterInfo("# Note\\n");',
          '    const aliases = parseFrontMatterAliases({ aliases: ["One", "Two"] });',
          '    const singularAlias = parseFrontMatterAliases({ alias: "Solo" });',
          '    const stringArray = parseFrontMatterStringArray({ Aliases: ["One", "Two"] }, /alias/i);',
          '    const parsedYaml = parseYaml("title: Example\\nitems:\\n  - one\\n  - two\\n");',
          '    const hexBytes = new Uint8Array(hexToArrayBuffer("000102ff"));',
          '    const blobBytes = new Uint8Array(await getBlobArrayBuffer(new Blob(["hello"])));',
          "    globalThis.__threadleafRuntimeLedgerFrontmatterDocumentFunctionsProbe = {",
          "      info,",
          "      missing,",
          "      aliases,",
          "      singularAlias,",
          "      stringArray,",
          "      parsedYaml,",
          "      hexBytes: [...hexBytes],",
          "      blobBytes: [...blobBytes],",
          "    };",
          "  }",
          "}",
          "module.exports = LedgerPlugin;",
          "",
        ].join("\n"),
      );
      const host = new PluginHost(fixtureVault);
      try {
        await host.loadAuthorizedPlugin(await testConstructionDispatch(pluginPath));
        expect(
          (globalThis as { __threadleafRuntimeLedgerFrontmatterDocumentFunctionsProbe?: unknown })
            .__threadleafRuntimeLedgerFrontmatterDocumentFunctionsProbe,
        ).toEqual({
          info: {
            exists: true,
            frontmatter: "title: Example\n",
            from: 4,
            to: 19,
            contentStart: 23,
          },
          missing: { exists: false, frontmatter: "", from: 0, to: 0, contentStart: 0 },
          aliases: ["One", "Two"],
          singularAlias: ["Solo"],
          stringArray: ["One", "Two"],
          parsedYaml: { title: "Example", items: ["one", "two"] },
          hexBytes: [0, 1, 2, 255],
          blobBytes: [104, 101, 108, 108, 111],
        });
      } finally {
        await host.close();
      }
    } finally {
      Reflect.deleteProperty(
        globalThis,
        "__threadleafRuntimeLedgerFrontmatterDocumentFunctionsProbe",
      );
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });

  /** @compatibility-test-id obsidian-runtime.markdown-render-family.v1 */
  it('proves the Markdown render family through require("obsidian")', async () => {
    await withTestDocument(async () => {
      const sandboxPath = await fs.mkdtemp(
        path.join(os.tmpdir(), "threadleaf-runtime-ledger-markdown-render-family-"),
      );
      const pluginPath = path.join(sandboxPath, "markdown-render-family-ledger-fixture");
      await fs.mkdir(pluginPath, { recursive: true });
      const manifestPath = path.join(pluginPath, "manifest.json");
      const bundlePath = path.join(pluginPath, "main.js");
      const previousManifest = await fs.readFile(manifestPath).catch(() => null);
      const previousBundle = await fs.readFile(bundlePath).catch(() => null);
      try {
        await fs.writeFile(
          manifestPath,
          JSON.stringify({
            id: "markdown-render-family-ledger-fixture",
            name: "Markdown render family ledger fixture",
            version: "1.0.0",
          }),
        );
        await fs.writeFile(
          bundlePath,
          [
            'const { Component, MarkdownPreviewRenderer, MarkdownRenderChild, MarkdownRenderer, Plugin, TFile } = require("obsidian");',
            "class LedgerRenderer extends MarkdownRenderer {",
            '  constructor(app, element) { super(element, app); this.fixtureFile = new TFile("Notes/Fixture.md", app.vault); }',
            "  get file() { return this.fixtureFile; }",
            "}",
            "class LedgerPlugin extends Plugin {",
            "  async onload() {",
            '    const markdown = "---\\ntitle: Example\\n---\\n```ThReAdLeAf\\nalpha\\n```\\n";',
            "    const calls = [];",
            '    const codeProcessor = MarkdownPreviewRenderer.createCodeBlockPostProcessor(" threadleaf ", async (source, element, context) => { element.dataset.code = source + "|" + context.sourcePath; });',
            '    const postProcessor = (element, context) => { calls.push(context.sourcePath + "|" + context.frontmatter.title); element.dataset.staticPost = "applied"; };',
            "    MarkdownPreviewRenderer.registerPostProcessor(codeProcessor, 10);",
            "    MarkdownPreviewRenderer.registerPostProcessor(postProcessor, 20);",
            '    const element = document.createElement("article");',
            '    await MarkdownRenderer.render(this.app, markdown, element, "Notes/Fixture.md", new Component());',
            '    const renderer = new LedgerRenderer(this.app, document.createElement("article"));',
            '    const deprecated = document.createElement("article");',
            "    MarkdownPreviewRenderer.unregisterPostProcessor(codeProcessor);",
            "    MarkdownPreviewRenderer.unregisterPostProcessor(postProcessor);",
            '    const afterUnregister = document.createElement("article");',
            '    await MarkdownRenderer.render(this.app, markdown, afterUnregister, "Notes/Fixture.md", new Component());',
            '    await MarkdownRenderer.renderMarkdown("**deprecated**", deprecated, "Notes/Deprecated.md", new Component());',
            "    globalThis.__threadleafRuntimeLedgerMarkdownRenderFamilyProbe = {",
            "      calls,",
            '      code: element.querySelector(".markdown-code-block")?.dataset.code,',
            '      codeClass: element.querySelector(".markdown-code-block")?.className,',
            "      staticPost: element.dataset.staticPost,",
            "      sortOrder: postProcessor.sortOrder,",
            '      afterUnregister: { staticPost: afterUnregister.dataset.staticPost, hasPre: afterUnregister.querySelector("pre") !== null },',
            "      deprecatedHtml: deprecated.innerHTML,",
            "      renderer: { app: renderer.app === this.app, file: renderer.file.path, hoverPopover: renderer.hoverPopover, child: renderer instanceof MarkdownRenderChild },",
            "    };",
            "  }",
            "}",
            "module.exports = LedgerPlugin;",
            "",
          ].join("\n"),
        );
        const host = new PluginHost(fixtureVault);
        try {
          await host.loadAuthorizedPlugin(await testConstructionDispatch(pluginPath));
          expect(
            (globalThis as { __threadleafRuntimeLedgerMarkdownRenderFamilyProbe?: unknown })
              .__threadleafRuntimeLedgerMarkdownRenderFamilyProbe,
          ).toEqual({
            calls: ["Notes/Fixture.md|Example"],
            code: "alpha|Notes/Fixture.md",
            codeClass: "markdown-code-block",
            staticPost: "applied",
            sortOrder: 20,
            afterUnregister: { staticPost: undefined, hasPre: true },
            deprecatedHtml: "<p><strong>deprecated</strong></p>\n",
            renderer: { app: true, file: "Notes/Fixture.md", hoverPopover: null, child: true },
          });
        } finally {
          await host.close();
        }
      } finally {
        if (previousManifest === null) {
          await fs.rm(manifestPath, { force: true });
        } else {
          await fs.writeFile(manifestPath, previousManifest);
        }
        if (previousBundle === null) {
          await fs.rm(bundlePath, { force: true });
        } else {
          await fs.writeFile(bundlePath, previousBundle);
        }
        await fs.rm(sandboxPath, { recursive: true, force: true });
      }
    });
    Reflect.deleteProperty(globalThis, "__threadleafRuntimeLedgerMarkdownRenderFamilyProbe");
  });

  /** @compatibility-test-id obsidian-runtime.utility-behaviors.v1 */
  it('proves debounce control and tooltip metadata through require("obsidian")', async () => {
    const sandboxPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "threadleaf-runtime-ledger-utility-behaviors-"),
    );
    const pluginPath = path.join(sandboxPath, "utility-behaviors-ledger-fixture");
    try {
      await fs.mkdir(pluginPath, { recursive: true });
      await fs.writeFile(
        path.join(pluginPath, "manifest.json"),
        JSON.stringify({
          id: "utility-behaviors-ledger-fixture",
          name: "Utility behaviors ledger fixture",
          version: "1.0.0",
        }),
      );
      await fs.writeFile(
        path.join(pluginPath, "main.js"),
        [
          'const { Plugin, debounce, setTooltip } = require("obsidian");',
          "class LedgerPlugin extends Plugin {",
          "  async onload() {",
          "    const delayedCalls = [];",
          "    const delayed = debounce((value) => { delayedCalls.push(value); return value; }, 1);",
          '    delayed("first");',
          '    delayed("second");',
          "    await new Promise((resolve) => setTimeout(resolve, 10));",
          "    const runCalls = [];",
          "    const runner = debounce((value) => { runCalls.push(value); return value; }, 100);",
          '    runner("run-now");',
          "    const runResult = runner.run();",
          "    const canceledCalls = [];",
          '    const canceled = debounce(() => canceledCalls.push("canceled"), 1);',
          "    canceled();",
          "    canceled.cancel();",
          "    await new Promise((resolve) => setTimeout(resolve, 10));",
          '    const element = document.createElement("button");',
          '    setTooltip(element, "Tooltip", { placement: "bottom", classes: ["one", "two"], gap: 4, delay: 7 });',
          "    globalThis.__threadleafRuntimeLedgerUtilityBehaviorsProbe = {",
          "      delayedCalls,",
          "      runCalls,",
          "      runResult,",
          "      canceledCalls,",
          "      title: element.title,",
          "      placement: element.dataset.tooltipPosition,",
          "      classes: element.dataset.tooltipClasses,",
          "      gap: element.dataset.tooltipGap,",
          "      delay: element.dataset.tooltipDelay,",
          '      ariaLabel: element.getAttribute("aria-label"),',
          "    };",
          "  }",
          "}",
          "module.exports = LedgerPlugin;",
          "",
        ].join("\n"),
      );
      await withTestDocument(async () => {
        const host = new PluginHost(fixtureVault);
        try {
          await host.loadAuthorizedPlugin(await testConstructionDispatch(pluginPath));
          expect(
            (globalThis as { __threadleafRuntimeLedgerUtilityBehaviorsProbe?: unknown })
              .__threadleafRuntimeLedgerUtilityBehaviorsProbe,
          ).toEqual({
            delayedCalls: ["second"],
            runCalls: ["run-now"],
            runResult: "run-now",
            canceledCalls: [],
            title: "Tooltip",
            placement: "bottom",
            classes: "one two",
            gap: "4",
            delay: "7",
            ariaLabel: "Tooltip",
          });
        } finally {
          await host.close();
        }
      });
    } finally {
      Reflect.deleteProperty(globalThis, "__threadleafRuntimeLedgerUtilityBehaviorsProbe");
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });

  /** @compatibility-test-id obsidian-runtime.icon-utilities.v1 */
  it('proves icon registration, lookup, rendering, listing, and removal through require("obsidian")', async () => {
    const sandboxPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "threadleaf-runtime-ledger-icon-utilities-"),
    );
    const pluginPath = path.join(sandboxPath, "icon-utilities-ledger-fixture");
    try {
      await fs.mkdir(pluginPath, { recursive: true });
      await fs.writeFile(
        path.join(pluginPath, "manifest.json"),
        JSON.stringify({
          id: "icon-utilities-ledger-fixture",
          name: "Icon utilities ledger fixture",
          version: "1.0.0",
        }),
      );
      await fs.writeFile(
        path.join(pluginPath, "main.js"),
        [
          'const { Plugin, addIcon, getIcon, getIconIds, removeIcon, setIcon } = require("obsidian");',
          "class LedgerPlugin extends Plugin {",
          "  async onload() {",
          '    addIcon("ledger-custom", "<path d=\\"M0 0h2v2z\\"/>");',
          '    const custom = getIcon("ledger-custom");',
          '    const builtIn = getIcon("check");',
          '    const parent = document.createElement("span");',
          '    setIcon(parent, "ledger-custom");',
          '    const missing = document.createElement("span");',
          '    setIcon(missing, "does-not-exist");',
          "    const ids = getIconIds();",
          '    removeIcon("ledger-custom");',
          "    globalThis.__threadleafRuntimeLedgerIconUtilitiesProbe = {",
          '      custom: { tag: custom?.tagName, dataIcon: custom?.dataset.icon, path: custom?.querySelector("path")?.getAttribute("d") },',
          '      builtIn: { tag: builtIn?.tagName, dataIcon: builtIn?.dataset.icon, hasPath: builtIn?.querySelector("path") !== null },',
          "      parent: { childTag: parent.firstElementChild?.tagName, dataIcon: parent.firstElementChild?.dataset.icon },",
          "      missing: { childCount: missing.childElementCount, dataIcon: missing.dataset.icon },",
          '      idsIncludeCustom: ids.includes("ledger-custom"),',
          '      removed: getIcon("ledger-custom") === null,',
          "    };",
          "  }",
          "}",
          "module.exports = LedgerPlugin;",
          "",
        ].join("\n"),
      );
      await withTestDocument(async () => {
        const host = new PluginHost(fixtureVault);
        try {
          await host.loadAuthorizedPlugin(await testConstructionDispatch(pluginPath));
          expect(
            (globalThis as { __threadleafRuntimeLedgerIconUtilitiesProbe?: unknown })
              .__threadleafRuntimeLedgerIconUtilitiesProbe,
          ).toEqual({
            custom: { tag: "svg", dataIcon: "ledger-custom", path: "M0 0h2v2z" },
            builtIn: { tag: "svg", dataIcon: "check", hasPath: true },
            parent: { childTag: "svg", dataIcon: "ledger-custom" },
            missing: { childCount: 0, dataIcon: "does-not-exist" },
            idsIncludeCustom: true,
            removed: true,
          });
        } finally {
          await host.close();
        }
      });
    } finally {
      Reflect.deleteProperty(globalThis, "__threadleafRuntimeLedgerIconUtilitiesProbe");
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });

  /** @compatibility-test-id obsidian-runtime.ui-interaction-classes.v1 */
  it('proves scope, menu, editor-suggest, fuzzy-modal, and render-child classes through require("obsidian")', async () => {
    const sandboxPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "threadleaf-runtime-ledger-ui-interaction-classes-"),
    );
    const pluginPath = path.join(sandboxPath, "ui-interaction-classes-ledger-fixture");
    try {
      await fs.mkdir(pluginPath, { recursive: true });
      await fs.writeFile(
        path.join(pluginPath, "manifest.json"),
        JSON.stringify({
          id: "ui-interaction-classes-ledger-fixture",
          name: "UI interaction classes ledger fixture",
          version: "1.0.0",
        }),
      );
      await fs.writeFile(
        path.join(pluginPath, "main.js"),
        [
          'const { EditorSuggest, FuzzySuggestModal, MarkdownRenderChild, Menu, Plugin, Scope } = require("obsidian");',
          "class TestEditorSuggest extends EditorSuggest {",
          '  onTrigger() { return { start: { line: 0, ch: 0 }, end: { line: 0, ch: 1 }, query: "@" }; }',
          '  getSuggestions() { return ["alpha"]; }',
          "}",
          "class TestFuzzySuggestModal extends FuzzySuggestModal {",
          '  getItems() { return ["Alpha", "Beta"]; }',
          "  getItemText(item) { return item; }",
          "  onChooseItem(item) { this.chosen = item; }",
          "}",
          "class LedgerPlugin extends Plugin {",
          "  async onload() {",
          "    const scope = new Scope();",
          "    const childScope = new Scope(scope);",
          "    const scopeCalls = [];",
          '    const handler = scope.register(["Ctrl"], "k", (event, context) => { scopeCalls.push([event.key, context.modifiers, context.vkey]); return "handled"; });',
          "    const KeyboardEvent = document.defaultView.KeyboardEvent;",
          '    const dispatched = scope.handleKeyEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));',
          "    scope.unregister(handler);",
          '    const afterUnregister = scope.handleKeyEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));',
          '    const childElement = document.createElement("div");',
          "    const renderChild = new MarkdownRenderChild(childElement);",
          "    let clickCount = 0;",
          "    let hideCount = 0;",
          "    const menu = new Menu();",
          "    const chained = menu.setNoIcon().setUseNativeMenu(true).setParentElement(document.body) === menu;",
          "    menu.onHide(() => hideCount += 1);",
          '    menu.addItem((item) => item.setTitle("Run").setIcon("check").setChecked(true).setDisabled(false).setWarning(true).setIsLabel(false).onClick(() => clickCount += 1).setSection("actions"));',
          "    menu.addSeparator();",
          "    menu.showAtPosition({ x: 10, y: 12, width: 120 }, document);",
          '    const renderedMenu = document.querySelector(".threadleaf-compat-menu");',
          '    const button = renderedMenu.querySelector(".menu-item");',
          '    const separator = renderedMenu.querySelector(".menu-separator");',
          '    const menuBeforeClick = { role: button.getAttribute("role"), checked: button.getAttribute("aria-checked"), warning: button.classList.contains("is-warning"), section: button.dataset.section, svg: button.querySelector("svg") !== null, disabled: button.disabled, native: renderedMenu.dataset.nativeRequested, width: renderedMenu.style.width, separatorRole: separator.getAttribute("role") };',
          "    button.click();",
          '    const forEventMenu = Menu.forEvent(new document.defaultView.MouseEvent("click", { clientX: 1, clientY: 2 }));',
          "    const forEventIsMenu = forEventMenu instanceof Menu;",
          "    forEventMenu.close();",
          "    const suggest = new TestEditorSuggest(this.app);",
          '    suggest.context = { query: "@" };',
          "    suggest.limit = 5;",
          '    suggest.setInstructions([{ command: "Enter", purpose: "choose" }]);',
          "    const trigger = suggest.onTrigger(null, null, null);",
          "    const suggestions = await suggest.getSuggestions({});",
          "    const instructions = suggest.getInstructions();",
          "    suggest.close();",
          "    const fuzzy = new TestFuzzySuggestModal(this.app);",
          '    const matches = fuzzy.getSuggestions("al");',
          '    const suggestionElement = document.createElement("div");',
          "    fuzzy.renderSuggestion(matches[0], suggestionElement);",
          '    fuzzy.onChooseSuggestion(matches[0], new document.defaultView.MouseEvent("click"));',
          "    globalThis.__threadleafRuntimeLedgerUiInteractionClassesProbe = {",
          "      scopeParentIsNull: scope.parent === null,",
          "      childScopeParent: childScope.parent === scope,",
          "      dispatched: { matched: dispatched.matched, result: dispatched.result },",
          "      afterUnregisterMatched: afterUnregister.matched,",
          "      scopeCalls,",
          "      renderChildContainer: renderChild.containerEl === childElement,",
          "      chained,",
          "      menuBeforeClick,",
          "      clickCount,",
          "      hideCount,",
          "      menuClosed: !document.body.contains(renderedMenu),",
          "      forEventIsMenu,",
          "      suggestApp: suggest.app === this.app,",
          "      suggestLimit: suggest.limit,",
          "      suggestContextAfterClose: suggest.context,",
          "      trigger,",
          "      suggestions,",
          "      instructions,",
          "      fuzzyMatches: matches.map((match) => ({ item: match.item, ranges: match.match.matches })),",
          "      fuzzyRendered: suggestionElement.textContent,",
          "      fuzzyChosen: fuzzy.chosen,",
          "    };",
          "  }",
          "}",
          "module.exports = LedgerPlugin;",
          "",
        ].join("\n"),
      );
      await withTestDocument(async () => {
        const host = new PluginHost(fixtureVault);
        try {
          await host.loadAuthorizedPlugin(await testConstructionDispatch(pluginPath));
          expect(
            (globalThis as { __threadleafRuntimeLedgerUiInteractionClassesProbe?: unknown })
              .__threadleafRuntimeLedgerUiInteractionClassesProbe,
          ).toEqual({
            scopeParentIsNull: true,
            childScopeParent: true,
            dispatched: { matched: true, result: "handled" },
            afterUnregisterMatched: false,
            scopeCalls: [["k", "Ctrl", "k"]],
            renderChildContainer: true,
            chained: true,
            menuBeforeClick: {
              role: "menuitemcheckbox",
              checked: "true",
              warning: true,
              section: "actions",
              svg: true,
              disabled: false,
              native: "true",
              width: "120px",
              separatorRole: "separator",
            },
            clickCount: 1,
            hideCount: 1,
            menuClosed: true,
            forEventIsMenu: true,
            suggestApp: true,
            suggestLimit: 5,
            suggestContextAfterClose: null,
            trigger: {
              start: { line: 0, ch: 0 },
              end: { line: 0, ch: 1 },
              query: "@",
            },
            suggestions: ["alpha"],
            instructions: [{ command: "Enter", purpose: "choose" }],
            fuzzyMatches: [{ item: "Alpha", ranges: [[0, 2]] }],
            fuzzyRendered: "Alpha",
            fuzzyChosen: "Alpha",
          });
        } finally {
          await host.close();
        }
      });
    } finally {
      Reflect.deleteProperty(globalThis, "__threadleafRuntimeLedgerUiInteractionClassesProbe");
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });

  /** @compatibility-test-id obsidian-runtime.modal-notice-keymap.v1 */
  it('proves modal, notice, suggest-modal, and keymap lifecycles through require("obsidian")', async () => {
    const sandboxPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "threadleaf-runtime-ledger-modal-notice-keymap-"),
    );
    const pluginPath = path.join(sandboxPath, "modal-notice-keymap-ledger-fixture");
    try {
      await fs.mkdir(pluginPath, { recursive: true });
      await fs.writeFile(
        path.join(pluginPath, "manifest.json"),
        JSON.stringify({
          id: "modal-notice-keymap-ledger-fixture",
          name: "Modal notice keymap ledger fixture",
          version: "1.0.0",
        }),
      );
      await fs.writeFile(
        path.join(pluginPath, "main.js"),
        [
          'const { Keymap, Modal, Notice, Plugin, Scope, SuggestModal } = require("obsidian");',
          "class FixtureModal extends Modal {",
          "  onOpen() { this.openCalls = (this.openCalls || 0) + 1; }",
          "  onClose() { this.closeCalls = (this.closeCalls || 0) + 1; }",
          "}",
          "class FixtureSuggestModal extends SuggestModal {",
          '  getSuggestions(query) { return ["alpha", "beta"].filter((value) => value.includes(query)); }',
          "  renderSuggestion(value, element) { element.textContent = value.toUpperCase(); }",
          "  onChooseSuggestion(value) { this.chosen = value; }",
          "  readInstructions() { return this.getInstructions(); }",
          "}",
          "class LedgerPlugin extends Plugin {",
          "  async onload() {",
          "    const keymap = new Keymap(document);",
          "    const scope = new Scope();",
          "    const keyCalls = [];",
          '    scope.register(["Ctrl"], "k", (event, context) => { keyCalls.push([event.key, context.modifiers, context.vkey]); return false; });',
          "    keymap.pushScope(scope);",
          '    const keyEvent = new document.defaultView.KeyboardEvent("keydown", { key: "k", ctrlKey: true, cancelable: true });',
          "    document.dispatchEvent(keyEvent);",
          "    keymap.popScope(scope);",
          '    const modEvent = new document.defaultView.KeyboardEvent("keydown", { key: "k", ctrlKey: true });',
          '    const splitEvent = new document.defaultView.KeyboardEvent("keydown", { key: "k", ctrlKey: true, altKey: true });',
          '    const windowEvent = new document.defaultView.KeyboardEvent("keydown", { key: "k", ctrlKey: true, altKey: true, shiftKey: true });',
          "    const modal = new FixtureModal(this.app);",
          '    const modalFragment = document.createDocumentFragment(); modalFragment.append("Fragment content");',
          "    let closeCallbackCalls = 0;",
          '    const modalChain = modal.setTitle("Ledger modal") === modal && modal.setContent("Text content") === modal && modal.setCloseCallback(() => closeCallbackCalls += 1) === modal;',
          "    modal.setContent(modalFragment);",
          "    modal.open();",
          "    const modalWhileOpen = document.body.contains(modal.containerEl);",
          "    const modalState = { app: modal.app === this.app, scope: modal.scope instanceof Scope, modalEl: modal.modalEl.className, title: modal.titleEl.textContent, content: modal.contentEl.textContent, shouldRestoreSelection: modal.shouldRestoreSelection, openCalls: modal.openCalls, modalChain };",
          "    modal.close();",
          "    const modalAfterClose = { inDocument: document.body.contains(modal.containerEl), closeCalls: modal.closeCalls, closeCallbackCalls };",
          "    const suggest = new FixtureSuggestModal(this.app);",
          '    suggest.setPlaceholder("Search ledger");',
          '    suggest.setInstructions([{ command: "Enter", purpose: "choose" }]);',
          '    const matches = await suggest.getSuggestions("a");',
          '    const renderedSuggestion = document.createElement("div");',
          "    suggest.renderSuggestion(matches[0], renderedSuggestion);",
          "    suggest.open();",
          '    suggest.inputEl.value = "b";',
          '    suggest.inputEl.dispatchEvent(new document.defaultView.Event("input", { bubbles: true }));',
          "    await new Promise((resolve) => setTimeout(resolve, 0));",
          '    const suggestionRows = [...suggest.resultContainerEl.querySelectorAll(".suggestion-item")].map((element) => element.textContent);',
          '    suggest.selectActiveSuggestion(new document.defaultView.MouseEvent("click"));',
          "    const noSuggestion = new FixtureSuggestModal(this.app);",
          "    noSuggestion.onNoSuggestion();",
          '    const noticeFragment = document.createDocumentFragment(); noticeFragment.append("Notice fragment");',
          "    const notice = new Notice(noticeFragment, 0);",
          "    const noticeInitial = { noticeEl: notice.noticeEl.className, containerEl: notice.containerEl.className, messageEl: notice.messageEl.textContent, connected: document.body.contains(notice.containerEl) };",
          '    notice.setMessage("Notice text");',
          "    const noticeAfterText = notice.messageEl.textContent;",
          '    const updatedNoticeFragment = document.createDocumentFragment(); updatedNoticeFragment.append("Updated fragment");',
          "    notice.setMessage(updatedNoticeFragment);",
          "    const noticeAfterFragment = notice.messageEl.textContent;",
          "    notice.hide();",
          "    globalThis.__threadleafRuntimeLedgerModalNoticeKeymapProbe = {",
          "      keyCalls,",
          "      keyEventPrevented: keyEvent.defaultPrevented,",
          '      modifier: Keymap.isModifier(modEvent, "Mod"),',
          "      modEvents: [Keymap.isModEvent(modEvent), Keymap.isModEvent(splitEvent), Keymap.isModEvent(windowEvent), Keymap.isModEvent(null)],",
          "      modalState,",
          "      modalWhileOpen,",
          "      modalAfterClose,",
          "      suggest: { limit: suggest.limit, emptyStateText: suggest.emptyStateText, inputPlaceholder: suggest.inputEl.placeholder, resultContainer: suggest.resultContainerEl.className, instructions: suggest.readInstructions(), matches, rendered: renderedSuggestion.textContent, rows: suggestionRows, chosen: suggest.chosen, closed: !document.body.contains(suggest.containerEl) },",
          "      noSuggestion: noSuggestion.resultContainerEl.textContent,",
          "      noticeInitial,",
          "      noticeAfterText,",
          "      noticeAfterFragment,",
          "      noticeBus: this.app.notices.list(),",
          "      noticeHidden: !document.body.contains(notice.containerEl),",
          "    };",
          "  }",
          "}",
          "module.exports = LedgerPlugin;",
          "",
        ].join("\n"),
      );
      await withTestDocument(async () => {
        const host = new PluginHost(fixtureVault);
        try {
          await host.loadAuthorizedPlugin(await testConstructionDispatch(pluginPath));
          expect(
            (globalThis as { __threadleafRuntimeLedgerModalNoticeKeymapProbe?: unknown })
              .__threadleafRuntimeLedgerModalNoticeKeymapProbe,
          ).toEqual({
            keyCalls: [["k", "Ctrl", "k"]],
            keyEventPrevented: true,
            modifier: true,
            modEvents: ["tab", "split", "window", false],
            modalState: {
              app: true,
              scope: true,
              modalEl: "modal",
              title: "Ledger modal",
              content: "Fragment content",
              shouldRestoreSelection: true,
              openCalls: 1,
              modalChain: true,
            },
            modalWhileOpen: true,
            modalAfterClose: { inDocument: false, closeCalls: 1, closeCallbackCalls: 1 },
            suggest: {
              limit: 100,
              emptyStateText: "No matches found.",
              inputPlaceholder: "Search ledger",
              resultContainer: "suggestion-container",
              instructions: [{ command: "Enter", purpose: "choose" }],
              matches: ["alpha", "beta"],
              rendered: "ALPHA",
              rows: ["BETA"],
              chosen: "beta",
              closed: true,
            },
            noSuggestion: "No matches found.",
            noticeInitial: {
              noticeEl: "notice",
              containerEl: "notice-container",
              messageEl: "Notice fragment",
              connected: true,
            },
            noticeAfterText: "Notice text",
            noticeAfterFragment: "Updated fragment",
            noticeBus: ["Notice fragment"],
            noticeHidden: true,
          });
        } finally {
          await host.close();
        }
      });
    } finally {
      Reflect.deleteProperty(globalThis, "__threadleafRuntimeLedgerModalNoticeKeymapProbe");
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });

  /** @compatibility-test-id obsidian-runtime.vault-mutations.v1 */
  /** @compatibility-test-id obsidian-runtime.file-manager-mutations.v1 */
  /** @compatibility-test-id obsidian-runtime.file-system-adapter-mutations.v1 */
  it('proves writable Vault mutations through require("obsidian")', async () => {
    await withTestDocument(async () => {
      const sandboxPath = await fs.mkdtemp(
        path.join(os.tmpdir(), "threadleaf-runtime-ledger-vault-"),
      );
      const vaultPath = path.join(sandboxPath, "vault");
      const pluginPath = path.join(vaultPath, ".obsidian", "plugins", "vault-ledger-fixture");
      const resolvePath = (relativePath: string): string => {
        const absolutePath = path.resolve(vaultPath, relativePath);
        const relative = path.relative(vaultPath, absolutePath);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          throw new Error(`Fixture writer path escaped the vault: ${relativePath}`);
        }
        return absolutePath;
      };
      let transactionSequence = 0;
      const committed = async (
        relativePath: string,
        bytes: Uint8Array,
        expectedRevision: string,
        kind: string,
      ) => {
        const absolutePath = resolvePath(relativePath);
        const current = await fs.readFile(absolutePath);
        if (revisionOf(current) !== expectedRevision) {
          return {
            status: "conflict" as const,
            path: relativePath,
            currentRevision: revisionOf(current),
            conflictPath: `${relativePath}.threadleaf-conflict`,
            transactionId: `${kind}-conflict`,
          };
        }
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, bytes);
        return {
          status: "committed" as const,
          path: relativePath,
          revision: revisionOf(bytes),
          transactionId: `${kind}-${++transactionSequence}`,
        };
      };
      const create = async (relativePath: string, bytes: Uint8Array, kind: string) => {
        const absolutePath = resolvePath(relativePath);
        try {
          const current = await fs.readFile(absolutePath);
          return {
            status: "exists" as const,
            path: relativePath,
            currentRevision: revisionOf(current),
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, bytes, { flag: "wx" });
        return {
          status: "committed" as const,
          path: relativePath,
          revision: revisionOf(bytes),
          transactionId: `${kind}-${++transactionSequence}`,
        };
      };
      try {
        await fs.cp(fixtureVault, vaultPath, { recursive: true });
        await fs.mkdir(pluginPath, { recursive: true });
        await fs.writeFile(
          path.join(pluginPath, "manifest.json"),
          JSON.stringify({
            id: "vault-ledger-fixture",
            name: "Vault ledger fixture",
            version: "1.0.0",
          }),
        );
        await fs.writeFile(
          path.join(pluginPath, "main.js"),
          [
            'const { Plugin } = require("obsidian");',
            "class LedgerPlugin extends Plugin {",
            "  async onload() {",
            "    const vault = this.app.vault;",
            "    const fileManager = this.app.fileManager;",
            '    const welcome = vault.getFileByPath("Welcome.md");',
            '    const linked = vault.getFileByPath("Linked Note.md");',
            '    const canvas = vault.getFileByPath("Boards/Overview.canvas");',
            '    const boards = vault.getFolderByPath("Boards");',
            '    if (!welcome || !linked || !canvas || !boards) throw new Error("Vault fixture files are missing");',
            '    const created = await vault.create("Mutation.md", "created");',
            '    await vault.modify(created, "modified");',
            '    const createdBinary = await vault.createBinary("Mutation.bin", Uint8Array.from([1, 2]).buffer);',
            "    await vault.modifyBinary(createdBinary, Uint8Array.from([3, 4]).buffer);",
            '    const managedBinary = await vault.createBinary("Managed.bin", Uint8Array.from([5]).buffer);',
            '    await vault.createFolder("Created folder");',
            '    await vault.append(welcome, "\\nappended");',
            '    const processed = await vault.process(welcome, (data) => data.replace("Welcome", "Ledger"));',
            '    await fileManager.processFrontMatter(welcome, (frontmatter) => { frontmatter.kind = "file-manager"; frontmatter.processed = true; });',
            "    const processedFrontmatterContent = await vault.read(welcome);",
            '    const processedFrontmatter = processedFrontmatterContent.includes("kind: file-manager") && processedFrontmatterContent.includes("processed: true");',
            '    const generatedLink = fileManager.generateMarkdownLink(linked, "Welcome.md", "#Project brief", "Linked");',
            "    await vault.appendBinary(canvas, Uint8Array.from([254, 253]).buffer);",
            '    const copiedFile = await vault.copy(welcome, "Copies/Welcome.md");',
            '    const copiedFolder = await vault.copy(boards, "Copies/Boards");',
            "    const adapter = vault.adapter;",
            "    const adapterName = adapter.getName();",
            "    const adapterBasePath = adapter.getBasePath();",
            '    const adapterFullPath = adapter.getFullPath("Welcome.md");',
            '    const adapterRead = await adapter.read("Welcome.md");',
            '    const adapterReadBinary = await adapter.readBinary("Mutation.bin");',
            '    await adapter.write("Adapter.md", "adapter");',
            '    const adapterWritten = await adapter.read("Adapter.md");',
            '    await adapter.writeBinary("Adapter.bin", Uint8Array.from([7, 8]).buffer);',
            '    await adapter.append("Adapter.md", "-append");',
            '    await adapter.appendBinary("Adapter.bin", Uint8Array.from([9]).buffer);',
            '    const adapterProcessed = await adapter.process("Adapter.md", (data) => data.toUpperCase());',
            '    const adapterResourcePath = adapter.getResourcePath("Adapter.md");',
            '    const adapterFilePath = adapter.getFilePath("Adapter.md");',
            '    const adapterExists = await adapter.exists("Adapter.md");',
            '    const adapterStat = await adapter.stat("Adapter.md");',
            '    const adapterList = await adapter.list("");',
            '    await adapter.mkdir("Adapter folder");',
            '    await adapter.copy("Adapter.bin", "Copies/Adapter.bin");',
            '    const adapterCopiedBinary = await adapter.readBinary("Copies/Adapter.bin");',
            '    await adapter.rename("Adapter.md", "Adapter renamed.md");',
            '    await adapter.trashLocal("Adapter renamed.md");',
            "    const bytesEqual = (value, expected) => { const bytes = new Uint8Array(value); return bytes.length === expected.length && expected.every((byte, index) => bytes[index] === byte); };",
            '    await vault.rename(created, "Renamed.md");',
            '    const attachmentPath = await fileManager.getAvailablePathForAttachment("Mutation.bin", "Welcome.md");',
            "    globalThis.confirm = () => true;",
            "    const prompted = await fileManager.promptForDeletion(created);",
            "    await fileManager.trashFile(managedBinary);",
            "    globalThis.__threadleafRuntimeLedgerVaultProbe = {",
            '      processed: processed.includes("Ledger") && processed.includes("appended"),',
            "      processedFrontmatter,",
            "      generatedLink,",
            "      copiedFile: copiedFile.path,",
            "      copiedFolder: copiedFolder.path,",
            '      createdFolder: vault.getFolderByPath("Created folder")?.path,',
            "      attachmentPath,",
            "      prompted,",
            '      adapter: { name: adapterName, basePath: adapterBasePath, fullPath: adapterFullPath, read: adapterRead, readBinary: bytesEqual(adapterReadBinary, [3, 4]), written: adapterWritten, processed: adapterProcessed, resourcePath: adapterResourcePath, filePath: adapterFilePath, exists: adapterExists, stat: adapterStat, listed: adapterList, copiedBinary: bytesEqual(adapterCopiedBinary, [7, 8, 9]), renamedTrashed: (await adapter.exists("Adapter renamed.md")) === false && (await adapter.exists(".trash/Adapter renamed.md")) === true },',
            '      trashed: vault.getFileByPath("Renamed.md") === null && vault.getFileByPath("Managed.bin") === null,',
            "    };",
            "  }",
            "}",
            "module.exports = LedgerPlugin;",
            "",
          ].join("\n"),
        );
        const writer = {
          createText: (relativePath: string, content: string) =>
            create(relativePath, Buffer.from(content, "utf8"), "create-text"),
          createBinary: (relativePath: string, content: Uint8Array) =>
            create(relativePath, content, "create-binary"),
          createFolder: async (relativePath: string) => {
            const absolutePath = resolvePath(relativePath);
            let created = false;
            try {
              await fs.stat(absolutePath);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
              }
              created = true;
            }
            await fs.mkdir(absolutePath, { recursive: true });
            return { path: relativePath, created };
          },
          writeText: (relativePath: string, content: string, expectedRevision: string) =>
            committed(relativePath, Buffer.from(content, "utf8"), expectedRevision, "write-text"),
          writeBinary: (relativePath: string, content: Uint8Array, expectedRevision: string) =>
            committed(relativePath, content, expectedRevision, "write-binary"),
          renameFile: async (sourcePath: string, targetPath: string, expectedRevision: string) => {
            const sourceAbsolutePath = resolvePath(sourcePath);
            const targetAbsolutePath = resolvePath(targetPath);
            const current = await fs.readFile(sourceAbsolutePath);
            if (revisionOf(current) !== expectedRevision) {
              return {
                status: "conflict" as const,
                from: sourcePath,
                to: targetPath,
                reason: "source-changed",
                conflictPaths: [],
              };
            }
            await fs.mkdir(path.dirname(targetAbsolutePath), { recursive: true });
            await fs.rename(sourceAbsolutePath, targetAbsolutePath);
            return {
              status: "committed" as const,
              from: sourcePath,
              to: targetPath,
              transactionId: `rename-${++transactionSequence}`,
            };
          },
          trashFile: async (sourcePath: string, expectedRevision: string) => {
            const sourceAbsolutePath = resolvePath(sourcePath);
            const targetPath = `.trash/${sourcePath}`;
            const targetAbsolutePath = resolvePath(targetPath);
            const current = await fs.readFile(sourceAbsolutePath);
            if (revisionOf(current) !== expectedRevision) {
              return {
                status: "conflict" as const,
                from: sourcePath,
                to: targetPath,
                reason: "source-changed",
                conflictPaths: [],
              };
            }
            await fs.mkdir(path.dirname(targetAbsolutePath), { recursive: true });
            await fs.rename(sourceAbsolutePath, targetAbsolutePath);
            return {
              status: "committed" as const,
              from: sourcePath,
              to: targetPath,
              transactionId: `trash-${++transactionSequence}`,
            };
          },
        };
        const host = new PluginHost(vaultPath, undefined, undefined, undefined, writer);
        try {
          await host.loadAuthorizedPlugin(await testConstructionDispatch(pluginPath));
          expect(
            (globalThis as { __threadleafRuntimeLedgerVaultProbe?: unknown })
              .__threadleafRuntimeLedgerVaultProbe,
          ).toMatchObject({
            processed: true,
            processedFrontmatter: true,
            generatedLink: "[[Linked Note#Project brief|Linked]]",
            copiedFile: "Copies/Welcome.md",
            copiedFolder: "Copies/Boards",
            createdFolder: "Created folder",
            attachmentPath: "Mutation 1.bin",
            prompted: true,
            adapter: {
              name: path.basename(vaultPath),
              basePath: vaultPath,
              fullPath: path.join(vaultPath, "Welcome.md"),
              read: expect.stringContaining("Ledger"),
              readBinary: true,
              written: "adapter",
              processed: "ADAPTER-APPEND",
              resourcePath: expect.stringMatching(/^file:/u),
              filePath: path.join(vaultPath, "Adapter.md"),
              exists: true,
              stat: expect.objectContaining({ type: "file", size: 14 }),
              listed: {
                files: expect.arrayContaining(["Adapter.bin", "Adapter.md"]),
                folders: expect.arrayContaining(["Boards", "Copies"]),
              },
              copiedBinary: true,
              renamedTrashed: true,
            },
            trashed: true,
          });
          await expect(fs.readFile(path.join(vaultPath, "Welcome.md"), "utf8")).resolves.toContain(
            "Ledger",
          );
          await expect(
            fs.readFile(path.join(vaultPath, "Boards/Overview.canvas")),
          ).resolves.toEqual(expect.any(Buffer));
          await expect(fs.readFile(path.join(vaultPath, "Mutation.bin"))).resolves.toEqual(
            Buffer.from([3, 4]),
          );
          await expect(
            fs.readFile(path.join(vaultPath, ".trash/Renamed.md"), "utf8"),
          ).resolves.toBe("modified");
          await expect(
            fs.readFile(path.join(vaultPath, "Copies/Boards/Overview.canvas")),
          ).resolves.toEqual(expect.any(Buffer));
          await expect(fs.readFile(path.join(vaultPath, "Adapter.bin"))).resolves.toEqual(
            Buffer.from([7, 8, 9]),
          );
          await expect(fs.readFile(path.join(vaultPath, "Copies/Adapter.bin"))).resolves.toEqual(
            Buffer.from([7, 8, 9]),
          );
          await expect(
            fs.readFile(path.join(vaultPath, ".trash/Adapter renamed.md"), "utf8"),
          ).resolves.toBe("ADAPTER-APPEND");
        } finally {
          await host.close();
        }
      } finally {
        Reflect.deleteProperty(globalThis, "__threadleafRuntimeLedgerVaultProbe");
        await fs.rm(sandboxPath, { recursive: true, force: true });
      }
    });
  });

  /** @compatibility-test-id obsidian-runtime.core-events-files-vault.v1 */
  /** @compatibility-test-id obsidian-runtime.workspace-core.v1 */
  /** @compatibility-test-id obsidian-runtime.editor-core.v1 */
  it('proves the core events, file identity, vault, and metadata bindings through require("obsidian")', async () => {
    const sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-runtime-ledger-core-"));
    const pluginPath = path.join(sandboxPath, "core-ledger-fixture");
    try {
      await fs.mkdir(pluginPath, { recursive: true });
      await fs.writeFile(
        path.join(pluginPath, "manifest.json"),
        JSON.stringify({
          id: "core-ledger-fixture",
          name: "Core ledger fixture",
          version: "1.0.0",
        }),
      );
      await fs.writeFile(
        path.join(pluginPath, "main.js"),
        [
          'const { Editor, Events, Plugin, TAbstractFile, TFile, TFolder, Vault, WorkspaceSplit } = require("obsidian");',
          "class LedgerPlugin extends Plugin {",
          "  async onload() {",
          "    const vault = this.app.vault;",
          "    const workspace = this.app.workspace;",
          '    const welcome = vault.getFileByPath("Welcome.md");',
          '    const linked = vault.getFileByPath("Linked Note.md");',
          '    const boards = vault.getFolderByPath("Boards");',
          '    const abstract = new TAbstractFile("Boards/Overview.canvas", vault);',
          '    const file = new TFile("Boards/Overview.canvas", vault, { ctime: 1, mtime: 2, size: 3 });',
          '    const folder = new TFolder("Boards", vault);',
          "    const root = vault.getRoot();",
          "    const welcomeRead = await vault.read(welcome);",
          "    const welcomeCachedRead = await vault.cachedRead(welcome);",
          "    const canvasBytes = await vault.readBinary(file);",
          "    const recursivePaths = [];",
          "    Vault.recurseChildren(root, (item) => recursivePaths.push(item.path));",
          "    const vaultEvents = [];",
          "    const vaultEventRefs = [",
          '      vault.on("create", (item) => vaultEvents.push(["create", item.path])),',
          '      vault.on("modify", (item) => vaultEvents.push(["modify", item.path])),',
          '      vault.on("delete", (item) => vaultEvents.push(["delete", item.path])),',
          '      vault.on("rename", (item, oldPath) => vaultEvents.push(["rename", item.path, oldPath])),',
          "    ];",
          '    vault.trigger("create", welcome);',
          '    vault.trigger("modify", welcome);',
          '    vault.trigger("delete", welcome);',
          '    vault.trigger("rename", welcome, "Old Welcome.md");',
          "    vaultEventRefs.forEach((ref) => ref.off());",
          "    const layoutCalls = [];",
          '    const layoutRef = workspace.on("layout-change", () => layoutCalls.push("layout"));',
          "    workspace.updateOptions();",
          "    workspace.offref(layoutRef);",
          "    const layout = workspace.getLayout();",
          "    const editorChanges = [];",
          "    const editor = new Editor((value) => editorChanges.push(value));",
          '    editor.setValue("alpha\\nbeta");',
          "    editor.setSelection({ line: 0, ch: 1 }, { line: 1, ch: 2 });",
          "    const selected = editor.getSelection();",
          '    const from = editor.getCursor("from");',
          '    const to = editor.getCursor("to");',
          '    editor.replaceSelection("X");',
          '    editor.setValue("one\\ntwo");',
          '    editor.replaceRange("T", { line: 1, ch: 0 }, { line: 1, ch: 1 });',
          "    editor.focus();",
          "    const advancedEditor = new Editor();",
          '    advancedEditor.setValue("alpha beta\\ngamma");',
          "    advancedEditor.refresh();",
          "    const advancedRange = advancedEditor.getRange({ line: 0, ch: 0 }, { line: 0, ch: 5 });",
          '    advancedEditor.setLine(1, "delta");',
          "    advancedEditor.undo();",
          "    advancedEditor.redo();",
          "    advancedEditor.setSelections([",
          "      { anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 5 } },",
          "      { anchor: { line: 1, ch: 0 } },",
          "    ], 1);",
          "    const advancedSelections = advancedEditor.listSelections();",
          "    advancedEditor.transaction({",
          '      changes: [{ from: { line: 0, ch: 6 }, to: { line: 0, ch: 10 }, text: "WORLD" }],',
          "      selection: { from: { line: 0, ch: 0 }, to: { line: 0, ch: 5 } },",
          "    });",
          "    const advancedWord = advancedEditor.wordAt({ line: 0, ch: 2 });",
          '    advancedEditor.exec("goEnd");',
          "    const advancedEnd = advancedEditor.getCursor();",
          '    advancedEditor.exec("goStart");',
          "    advancedEditor.scrollTo(4, 12);",
          "    const advancedScroll = advancedEditor.getScrollInfo();",
          "    advancedEditor.scrollIntoView({ from: { line: 1, ch: 0 }, to: { line: 1, ch: 1 } });",
          "    const advancedScrollAfterReveal = advancedEditor.getScrollInfo();",
          "    advancedEditor.focus();",
          "    advancedEditor.blur();",
          "    const advancedBlurred = advancedEditor.hasFocus() === false;",
          "    advancedEditor.processLines(",
          "      (_line, lineText) => lineText,",
          "      (line, lineText) => line === 0 ? {",
          "        from: { line, ch: 0 },",
          "        to: { line, ch: lineText.length },",
          "        text: lineText.toUpperCase(),",
          "      } : undefined,",
          "    );",
          "    const calls = [];",
          "    const events = new Events();",
          "    const callback = (...args) => calls.push(args);",
          '    const eventRef = events.on("sample", callback);',
          '    events.trigger("sample", "trigger");',
          '    events.tryTrigger(eventRef, ["try"]);',
          '    events.off("sample", callback);',
          '    events.trigger("sample", "after-off");',
          '    const releasedRef = events.on("released", callback);',
          "    events.offref(releasedRef);",
          '    events.tryTrigger(releasedRef, ["after-offref"]);',
          "    const metadata = this.app.metadataCache;",
          "    const cache = metadata.getFileCache(welcome);",
          '    const cacheByPath = metadata.getCache("Welcome.md");',
          '    const destination = metadata.getFirstLinkpathDest("Linked Note#Project brief", "Welcome.md");',
          '    const linktext = metadata.fileToLinktext(destination, "Welcome.md", true);',
          "    const resolved = metadata.resolvedLinks;",
          "    const unresolved = metadata.unresolvedLinks;",
          "    const metadataEvents = [];",
          "    const metadataEventRefs = [",
          '      metadata.on("changed", (file, data, cache) => metadataEvents.push(["changed", file.path, data, Boolean(cache)])),',
          '      metadata.on("deleted", (file, previous) => metadataEvents.push(["deleted", file.path, previous === null])),',
          '      metadata.on("resolve", (file) => metadataEvents.push(["resolve", file.path])),',
          '      metadata.on("resolved", () => metadataEvents.push(["resolved"])),',
          "    ];",
          '    metadata.trigger("changed", welcome, "metadata", cache);',
          '    metadata.trigger("deleted", welcome, null);',
          '    metadata.trigger("resolve", welcome);',
          '    metadata.trigger("resolved");',
          "    metadataEventRefs.forEach((ref) => ref.off());",
          "    globalThis.__threadleafRuntimeLedgerCoreProbe = {",
          "      events: calls,",
          "      vault: {",
          "        isVault: vault instanceof Vault,",
          "        adapterName: vault.adapter.getName(),",
          "        configDir: vault.configDir,",
          "        name: vault.getName(),",
          "        welcomeIsFile: welcome instanceof TFile,",
          "        linkedPath: linked.path,",
          "        boardsIsFolder: boards instanceof TFolder,",
          '        abstractIsFile: vault.getAbstractFileByPath("Boards/Overview.canvas") instanceof TFile,',
          "        rootIsFolder: vault.getRoot() instanceof TFolder,",
          '        resourceIsFileUrl: vault.getResourcePath(welcome).startsWith("file:"),',
          '        readMatches: welcomeRead === welcomeCachedRead && welcomeRead.includes("Welcome"),',
          "        binaryIsNonEmpty: canvasBytes.byteLength > 0,",
          "        recursivePaths,",
          "        vaultEvents,",
          "        fileCount: vault.getFiles().length,",
          "        markdownCount: vault.getMarkdownFiles().length,",
          "        folderPaths: vault.getAllFolders().map((item) => item.path),",
          "        loadedHasRoot: vault.getAllLoadedFiles().some((item) => item instanceof TFolder && item.isRoot),",
          "      },",
          "      workspace: {",
          "        isEvents: workspace instanceof Events,",
          "        rootSplitIsSplit: workspace.rootSplit instanceof WorkspaceSplit,",
          "        rootSplitParentIsNull: workspace.rootSplit.parent === null,",
          "        rootDirection: workspace.rootSplit.direction,",
          "        activeLeafIsNull: workspace.activeLeaf === null,",
          "        activeEditorIsNull: workspace.activeEditor === null,",
          "        layoutReady: workspace.layoutReady,",
          "        layoutMainChildren: layout.main.children.length,",
          "        mostRecentLeafIsNull: workspace.getMostRecentLeaf() === null,",
          "        activeFileIsNull: workspace.getActiveFile() === null,",
          '        markdownLeaves: workspace.getLeavesOfType("markdown").length,',
          "        layoutCalls,",
          "      },",
          "      editor: {",
          "        isEditor: editor instanceof Editor,",
          "        selected,",
          "        from,",
          "        to,",
          "        value: editor.getValue(),",
          "        line: editor.getLine(1),",
          "        lineCount: editor.lineCount(),",
          "        lastLine: editor.lastLine(),",
          "        selectionEmpty: editor.somethingSelected(),",
          "        offset: editor.posToOffset({ line: 1, ch: 1 }),",
          "        position: editor.offsetToPos(5),",
          "        focused: editor.hasFocus(),",
          "        editorChanges,",
          "        advanced: {",
          "          docIsSelf: advancedEditor.getDoc() === advancedEditor,",
          "          range: advancedRange,",
          "          selections: advancedSelections,",
          "          value: advancedEditor.getValue(),",
          "          selection: advancedEditor.getSelection(),",
          "          word: advancedWord,",
          "          end: advancedEnd,",
          "          scroll: advancedScroll,",
          "          scrollAfterReveal: advancedScrollAfterReveal,",
          "          blurred: advancedBlurred,",
          "        },",
          "      },",
          "      abstract: {",
          "        path: abstract.path,",
          "        name: abstract.name,",
          "        vaultMatches: abstract.vault === vault,",
          "        parentPath: abstract.parent && abstract.parent.path,",
          "      },",
          "      file: {",
          "        path: file.path,",
          "        name: file.name,",
          "        basename: file.basename,",
          "        extension: file.extension,",
          "        stat: file.stat,",
          "      },",
          "      folder: {",
          "        childPaths: folder.children.map((item) => item.path),",
          "        isRoot: folder.isRoot,",
          "        rootIsRoot: root.isRoot,",
          "      },",
          "      metadata: {",
          "        cacheFrontmatter: cache && cache.frontmatter,",
          "        cacheByPathFrontmatter: cacheByPath && cacheByPath.frontmatter,",
          "        destinationPath: destination && destination.path,",
          "        linktext,",
          "        resolvedCount: Object.keys(resolved).length,",
          "        unresolvedCount: Object.keys(unresolved).length,",
          "        events: metadataEvents,",
          "      },",
          "    };",
          "  }",
          "}",
          "module.exports = LedgerPlugin;",
          "",
        ].join("\n"),
      );
      const host = new PluginHost(fixtureVault);
      try {
        await host.loadAuthorizedPlugin(await testConstructionDispatch(pluginPath));
        expect(
          (globalThis as { __threadleafRuntimeLedgerCoreProbe?: unknown })
            .__threadleafRuntimeLedgerCoreProbe,
        ).toEqual({
          events: [["trigger"], ["try"]],
          vault: {
            isVault: true,
            adapterName: "basic",
            configDir: ".obsidian",
            name: "basic",
            welcomeIsFile: true,
            linkedPath: "Linked Note.md",
            boardsIsFolder: true,
            abstractIsFile: true,
            rootIsFolder: true,
            resourceIsFileUrl: true,
            readMatches: true,
            binaryIsNonEmpty: true,
            recursivePaths: ["Boards", "Boards/Overview.canvas", "Linked Note.md", "Welcome.md"],
            vaultEvents: [
              ["create", "Welcome.md"],
              ["modify", "Welcome.md"],
              ["delete", "Welcome.md"],
              ["rename", "Welcome.md", "Old Welcome.md"],
            ],
            fileCount: 3,
            markdownCount: 2,
            folderPaths: ["Boards"],
            loadedHasRoot: true,
          },
          workspace: {
            isEvents: true,
            rootSplitIsSplit: true,
            rootSplitParentIsNull: true,
            rootDirection: "vertical",
            activeLeafIsNull: true,
            activeEditorIsNull: true,
            layoutReady: false,
            layoutMainChildren: 0,
            mostRecentLeafIsNull: true,
            activeFileIsNull: true,
            markdownLeaves: 0,
            layoutCalls: ["layout"],
          },
          editor: {
            isEditor: true,
            selected: "lpha\nbe",
            from: { line: 0, ch: 1 },
            to: { line: 1, ch: 2 },
            value: "one\nTwo",
            line: "Two",
            lineCount: 2,
            lastLine: 1,
            selectionEmpty: false,
            offset: 5,
            position: { line: 1, ch: 1 },
            focused: true,
            editorChanges: ["alpha\nbeta", "aXta", "one\ntwo", "one\nTwo"],
            advanced: {
              docIsSelf: true,
              range: "alpha",
              selections: [
                { anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 5 } },
                { anchor: { line: 1, ch: 0 }, head: { line: 1, ch: 0 } },
              ],
              value: "ALPHA WORLD\ndelta",
              selection: "",
              word: {
                from: { line: 0, ch: 0 },
                to: { line: 0, ch: 5 },
              },
              end: { line: 0, ch: 11 },
              scroll: { left: 4, top: 12 },
              scrollAfterReveal: { left: 4, top: 1 },
              blurred: true,
            },
          },
          abstract: {
            path: "Boards/Overview.canvas",
            name: "Overview.canvas",
            vaultMatches: true,
            parentPath: "Boards",
          },
          file: {
            path: "Boards/Overview.canvas",
            name: "Overview.canvas",
            basename: "Overview",
            extension: "canvas",
            stat: { ctime: 1, mtime: 2, size: 3 },
          },
          folder: {
            childPaths: ["Boards/Overview.canvas"],
            isRoot: false,
            rootIsRoot: true,
          },
          metadata: {
            cacheFrontmatter: { kind: "compatibility-fixture" },
            cacheByPathFrontmatter: { kind: "compatibility-fixture" },
            destinationPath: "Linked Note.md",
            linktext: "Linked Note",
            resolvedCount: 2,
            unresolvedCount: 2,
            events: [
              ["changed", "Welcome.md", "metadata", true],
              ["deleted", "Welcome.md", true],
              ["resolve", "Welcome.md"],
              ["resolved"],
            ],
          },
        });
      } finally {
        await host.close();
      }
    } finally {
      Reflect.deleteProperty(globalThis, "__threadleafRuntimeLedgerCoreProbe");
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });

  /** @compatibility-test-id obsidian-runtime.workspace-extended.v1 */
  it('proves extended workspace navigation through require("obsidian")', async () => {
    await withTestDocument(async () => {
      const sandboxPath = await fs.mkdtemp(
        path.join(os.tmpdir(), "threadleaf-runtime-ledger-workspace-extended-"),
      );
      const pluginPath = path.join(sandboxPath, "workspace-extended-ledger-fixture");
      try {
        await fs.mkdir(pluginPath, { recursive: true });
        await fs.writeFile(
          path.join(pluginPath, "manifest.json"),
          JSON.stringify({
            id: "workspace-extended-ledger-fixture",
            name: "Workspace extended ledger fixture",
            version: "1.0.0",
          }),
        );
        await fs.writeFile(
          path.join(pluginPath, "main.js"),
          [
            'const { MarkdownView, Plugin, WorkspaceLeaf } = require("obsidian");',
            "class LedgerPlugin extends Plugin {",
            "  async onload() {",
            "    const workspace = this.app.workspace;",
            "    const layoutReadyCalls = [];",
            '    workspace.onLayoutReady(() => layoutReadyCalls.push("queued"));',
            '    const welcome = this.app.vault.getFileByPath("Welcome.md");',
            '    const linked = this.app.vault.getFileByPath("Linked Note.md");',
            "    const primary = workspace.getLeaf(false);",
            '    await primary.setViewState({ active: false, state: { seed: true }, type: "empty" });',
            '    const grouped = workspace.getLeaf("tab");',
            '    await grouped.setViewState({ active: false, state: { grouped: true }, type: "empty" });',
            "    grouped.setGroupMember(primary);",
            '    grouped.setGroup("shared");',
            '    const directSplit = workspace.createLeafBySplit(primary, "vertical", true);',
            '    await directSplit.setViewState({ active: false, state: { direct: true }, type: "empty" });',
            '    const duplicateTab = await workspace.duplicateLeaf(primary, "tab");',
            '    const duplicateSplit = await workspace.duplicateLeaf(primary, "horizontal");',
            '    const left = await workspace.ensureSideLeaf("markdown", "left", { active: false, reveal: false, state: { file: welcome.path } });',
            '    const right = await workspace.ensureSideLeaf("markdown", "right", { active: false, reveal: false, state: { file: linked.path } });',
            "    const rootLeaves = [];",
            "    workspace.iterateRootLeaves((leaf) => rootLeaves.push(leaf.id));",
            "    await primary.openFile(welcome);",
            "    await grouped.openFile(linked);",
            "    workspace.setActiveLeaf(primary);",
            "    workspace.setActiveLeaf(grouped, false, false);",
            "    const unpinnedLeaf = workspace.getUnpinnedLeaf();",
            '    const splitProbe = workspace.splitActiveLeaf("horizontal");',
            "    const splitActiveIsLeaf = splitProbe instanceof WorkspaceLeaf;",
            "    await splitProbe.detach();",
            "    const parentCreatedLeaf = workspace.createLeafInParent(workspace.rootSplit, 0);",
            "    const createLeafInParentIsLeaf = parentCreatedLeaf instanceof WorkspaceLeaf;",
            "    await parentCreatedLeaf.detach();",
            '    await workspace.openLinkText("Welcome", "Linked Note.md", false, { active: false });',
            "    const openedLinkPath = grouped.view instanceof MarkdownView && grouped.view.file ? grouped.view.file.path : null;",
            "    await grouped.openFile(linked, { active: false });",
            "    workspace.setActiveLeaf(primary);",
            "    await workspace.revealLeaf(grouped);",
            "    const activeMarkdownView = workspace.getActiveViewOfType(MarkdownView);",
            "    const allLeaves = [];",
            "    workspace.iterateAllLeaves((leaf) => allLeaves.push(leaf.id));",
            '    workspace.detachLeavesOfType("missing-view-type");',
            "    const menu = {};",
            "    const popup = {};",
            "    const event = {};",
            "    const markdown = grouped.view;",
            "    const editor = markdown instanceof MarkdownView ? markdown.editor : null;",
            "    const workspaceEvents = [];",
            "    const workspaceEventRefs = [",
            '      workspace.on("quick-preview", (file, data) => workspaceEvents.push(["quick-preview", file === welcome && data === "preview"])),',
            '      workspace.on("resize", () => workspaceEvents.push(["resize", true])),',
            '      workspace.on("active-leaf-change", (leaf) => workspaceEvents.push(["active-leaf-change", leaf === grouped])),',
            '      workspace.on("file-open", (file) => workspaceEvents.push(["file-open", file === linked])),',
            '      workspace.on("layout-change", () => workspaceEvents.push(["layout-change", true])),',
            '      workspace.on("window-open", (win, targetWindow) => workspaceEvents.push(["window-open", win === popup && targetWindow === window])),',
            '      workspace.on("window-close", (win, targetWindow) => workspaceEvents.push(["window-close", win === popup && targetWindow === window])),',
            '      workspace.on("css-change", () => workspaceEvents.push(["css-change", true])),',
            '      workspace.on("file-menu", (candidateMenu, file, source, leaf) => workspaceEvents.push(["file-menu", candidateMenu === menu && file === welcome && source === "file" && leaf === grouped])),',
            '      workspace.on("files-menu", (candidateMenu, files, source, leaf) => workspaceEvents.push(["files-menu", candidateMenu === menu && files[0] === welcome && source === "files" && leaf === grouped])),',
            '      workspace.on("url-menu", (candidateMenu, url) => workspaceEvents.push(["url-menu", candidateMenu === menu && url === "https://example.test"])),',
            '      workspace.on("editor-menu", (candidateMenu, candidateEditor, info) => workspaceEvents.push(["editor-menu", candidateMenu === menu && candidateEditor === editor && info === markdown])),',
            '      workspace.on("editor-change", (candidateEditor, info) => workspaceEvents.push(["editor-change", candidateEditor === editor && info === markdown])),',
            '      workspace.on("editor-paste", (candidateEvent, candidateEditor, info) => workspaceEvents.push(["editor-paste", candidateEvent === event && candidateEditor === editor && info === markdown])),',
            '      workspace.on("editor-drop", (candidateEvent, candidateEditor, info) => workspaceEvents.push(["editor-drop", candidateEvent === event && candidateEditor === editor && info === markdown])),',
            '      workspace.on("quit", (tasks) => workspaceEvents.push(["quit", tasks === event])),',
            "    ];",
            '    workspace.trigger("quick-preview", welcome, "preview");',
            '    workspace.trigger("resize");',
            '    workspace.trigger("active-leaf-change", grouped);',
            '    workspace.trigger("file-open", linked);',
            '    workspace.trigger("layout-change");',
            '    workspace.trigger("window-open", popup, window);',
            '    workspace.trigger("window-close", popup, window);',
            '    workspace.trigger("css-change");',
            '    workspace.trigger("file-menu", menu, welcome, "file", grouped);',
            '    workspace.trigger("files-menu", menu, [welcome], "files", grouped);',
            '    workspace.trigger("url-menu", menu, "https://example.test");',
            '    workspace.trigger("editor-menu", menu, editor, markdown);',
            '    workspace.trigger("editor-change", editor, markdown);',
            '    workspace.trigger("editor-paste", event, editor, markdown);',
            '    workspace.trigger("editor-drop", event, editor, markdown);',
            '    workspace.trigger("quit", event);',
            "    workspaceEventRefs.forEach((ref) => ref.off());",
            '    const groupLeaves = workspace.getGroupLeaves("shared");',
            "    globalThis.__threadleafRuntimeLedgerWorkspaceExtendedProbe = {",
            "      layoutReadyCalls,",
            '      registerImmediate: () => workspace.onLayoutReady(() => layoutReadyCalls.push("immediate")),',
            "      activeOverload: workspace.activeLeaf === grouped,",
            "      duplicateTabState: duplicateTab.getViewState().state.seed === true,",
            "      duplicateSplitState: duplicateSplit.getViewState().state.seed === true,",
            "      directSplitIsLeaf: directSplit instanceof WorkspaceLeaf,",
            "      splitActiveIsLeaf,",
            "      createLeafInParentIsLeaf,",
            "      unpinnedIsLeaf: unpinnedLeaf instanceof WorkspaceLeaf,",
            "      openedLinkPath,",
            "      activeViewIsMarkdown: activeMarkdownView === grouped.view,",
            "      allLeavesCount: allLeaves.length,",
            "      allLeavesIncludeSides: allLeaves.includes(left.id) && allLeaves.includes(right.id),",
            '      detachedUnknownType: workspace.getLeavesOfType("missing-view-type").length === 0,',
            "      workspaceEvents,",
            "      leftIsMarkdown: left.view instanceof MarkdownView,",
            "      rightIsMarkdown: right.view instanceof MarkdownView,",
            "      leftLookup: workspace.getLeftLeaf(false) === left,",
            "      rightLookup: workspace.getRightLeaf(false) === right,",
            "      rootLeaves,",
            "      rootExcludesSides: !rootLeaves.includes(left.id) && !rootLeaves.includes(right.id),",
            "      groupLeaves: groupLeaves.map((leaf) => leaf.id),",
            "      groupIncludesDuplicates: groupLeaves.includes(duplicateTab) && groupLeaves.includes(duplicateSplit),",
            "      mostRecentInRoot: workspace.getMostRecentLeaf(workspace.rootSplit) === grouped,",
            "      idLookup: workspace.getLeafById(grouped.id) === grouped,",
            "      lastOpenFiles: workspace.getLastOpenFiles(),",
            "      layout: { left: workspace.getLayout().left.children.length, main: workspace.getLayout().main.children.length, right: workspace.getLayout().right.children.length },",
            "    };",
            "  }",
            "}",
            "module.exports = LedgerPlugin;",
            "",
          ].join("\n"),
        );
        const host = new PluginHost(fixtureVault);
        try {
          await host.loadAuthorizedPlugin(await testConstructionDispatch(pluginPath));
          await host.markLayoutReady();
          const workspaceProbe = (
            globalThis as {
              __threadleafRuntimeLedgerWorkspaceExtendedProbe?: {
                registerImmediate?: () => void;
              };
            }
          ).__threadleafRuntimeLedgerWorkspaceExtendedProbe;
          workspaceProbe?.registerImmediate?.();
          expect(
            (globalThis as { __threadleafRuntimeLedgerWorkspaceExtendedProbe?: unknown })
              .__threadleafRuntimeLedgerWorkspaceExtendedProbe,
          ).toMatchObject({
            layoutReadyCalls: ["queued", "immediate"],
            activeOverload: true,
            duplicateTabState: true,
            duplicateSplitState: true,
            directSplitIsLeaf: true,
            splitActiveIsLeaf: true,
            createLeafInParentIsLeaf: true,
            unpinnedIsLeaf: true,
            openedLinkPath: "Welcome.md",
            activeViewIsMarkdown: true,
            allLeavesCount: 7,
            allLeavesIncludeSides: true,
            detachedUnknownType: true,
            workspaceEvents: [
              ["quick-preview", true],
              ["resize", true],
              ["active-leaf-change", true],
              ["file-open", true],
              ["layout-change", true],
              ["window-open", true],
              ["window-close", true],
              ["css-change", true],
              ["file-menu", true],
              ["files-menu", true],
              ["url-menu", true],
              ["editor-menu", true],
              ["editor-change", true],
              ["editor-paste", true],
              ["editor-drop", true],
              ["quit", true],
            ],
            leftIsMarkdown: true,
            rightIsMarkdown: true,
            leftLookup: true,
            rightLookup: true,
            rootExcludesSides: true,
            groupIncludesDuplicates: true,
            mostRecentInRoot: true,
            idLookup: true,
            lastOpenFiles: ["Linked Note.md", "Welcome.md"],
            layout: { left: 1, main: 5, right: 1 },
          });
        } finally {
          await host.close();
        }
      } finally {
        Reflect.deleteProperty(globalThis, "__threadleafRuntimeLedgerWorkspaceExtendedProbe");
        await fs.rm(sandboxPath, { recursive: true, force: true });
      }
    });
  });

  /** @compatibility-test-id obsidian-runtime.render-views.v1 */
  /** @compatibility-test-id obsidian-runtime.markdown-view-family.v1 */
  it('proves real workspace leaf and file-view bindings through require("obsidian")', async () => {
    const sandboxPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "threadleaf-runtime-ledger-views-"),
    );
    const pluginPath = path.join(sandboxPath, "render-views-ledger-fixture");
    try {
      await fs.mkdir(pluginPath, { recursive: true });
      await fs.writeFile(
        path.join(pluginPath, "manifest.json"),
        JSON.stringify({
          id: "render-views-ledger-fixture",
          name: "Render views ledger fixture",
          version: "1.0.0",
        }),
      );
      await fs.writeFile(
        path.join(pluginPath, "main.js"),
        [
          'const { Editor, FileView, ItemView, MarkdownEditView, MarkdownPreviewView, MarkdownView, Plugin, TextFileView, View, WorkspaceLeaf } = require("obsidian");',
          "class LedgerPlugin extends Plugin {",
          "  async onload() {",
          "    const vault = this.app.vault;",
          "    const workspace = this.app.workspace;",
          '    const welcome = vault.getFileByPath("Welcome.md");',
          "    const leaf = workspace.getLeaf(false);",
          "    await leaf.openFile(welcome);",
          "    const view = leaf.view;",
          "    const viewState = leaf.getViewState();",
          "    const actionCalls = [];",
          '    const action = view.addAction("document", "Ledger action", () => actionCalls.push("clicked"));',
          "    action.click();",
          "    view.onResize();",
          "    const originalViewData = view.getViewData();",
          '    view.setViewData("temporary", true);',
          "    const viewDataAfterSet = view.getViewData();",
          "    view.clear();",
          "    const viewDataAfterClear = view.getViewData();",
          "    view.setViewData(originalViewData, true);",
          "    const originalModify = vault.modify;",
          "    let saveCall = null;",
          "    vault.modify = async (file, data) => { saveCall = { path: file.path, data }; };",
          "    await view.save();",
          "    vault.modify = originalModify;",
          "    const savedViewData = view.getViewData();",
          "    const editMode = new MarkdownEditView(view);",
          '    editMode.set("Edited", true);',
          "    const editModeState = { class: editMode instanceof MarkdownEditView, data: editMode.get(), file: editMode.file.path, selection: editMode.getSelection() };",
          "    editMode.applyScroll(9);",
          "    const editScroll = editMode.getScroll();",
          "    editMode.clear();",
          "    const editAfterClear = editMode.get();",
          "    view.setViewData(originalViewData, true);",
          "    const initialMode = view.getMode();",
          "    const initialCurrentModeIsEdit = view.currentMode instanceof MarkdownEditView;",
          '    view.setMode("preview");',
          "    const previewModeState = { mode: view.getMode(), currentIsPreview: view.currentMode === view.previewMode, class: view.previewMode instanceof MarkdownPreviewView, container: view.previewMode.containerEl === view.contentEl, file: view.previewMode.file.path };",
          '    view.previewMode.set("Preview", true);',
          "    const previewData = view.previewMode.get();",
          "    view.previewMode.applyScroll(17);",
          "    const previewScroll = view.previewMode.getScroll();",
          "    view.previewMode.clear();",
          "    const previewAfterClear = view.previewMode.get();",
          "    view.previewMode.rerender();",
          '    view.setMode("source");',
          "    view.showSearch();",
          "    const searchMode = view.contentEl.dataset.searchMode;",
          "    view.showSearch(true);",
          "    const replaceMode = view.contentEl.dataset.searchMode;",
          "    const markdownViewMode = view.getMode();",
          "    await view.onRename(welcome);",
          "    const leafEvents = [];",
          '    const pinnedRef = leaf.on("pinned-change", (pinned) => leafEvents.push(["pinned", pinned]));',
          '    const groupRef = leaf.on("group-change", (group) => leafEvents.push(["group", group]));',
          "    leaf.setPinned(true);",
          '    leaf.setGroup("ledger-group");',
          "    leaf.setEphemeralState({ cursor: { from: { line: 1, ch: 2 } } });",
          "    await leaf.loadIfDeferred();",
          "    const ephemeralState = leaf.getEphemeralState();",
          "    const isDeferred = leaf.isDeferred;",
          "    const leafIcon = leaf.getIcon();",
          "    const leafDisplayText = leaf.getDisplayText();",
          "    leaf.onResize();",
          "    pinnedRef.off();",
          "    groupRef.off();",
          "    globalThis.__threadleafRuntimeLedgerViewsProbe = {",
          "      leafIsWorkspaceLeaf: leaf instanceof WorkspaceLeaf,",
          "      viewIsView: view instanceof View,",
          "      itemViewIsItemView: view instanceof ItemView,",
          "      fileViewIsFileView: view instanceof FileView,",
          "      textFileViewIsTextFileView: view instanceof TextFileView,",
          "      markdownViewIsMarkdownView: view instanceof MarkdownView,",
          "      viewType: view.getViewType(),",
          "      displayText: view.getDisplayText(),",
          "      filePath: view.file && view.file.path,",
          "      fileState: view.getState(),",
          "      allowNoFile: view.allowNoFile,",
          '      canAcceptMarkdown: view.canAcceptExtension("md"),',
          "      viewState,",
          "      viewData: view.getViewData(),",
          "      saveCall: saveCall && { path: saveCall.path, dataMatches: saveCall.data === originalViewData },",
          "      data: view.data,",
          '      requestSaveIsFunction: typeof view.requestSave === "function",',
          "      viewDataAfterSet,",
          "      viewDataAfterClear,",
          "      editorIsEditor: view.editor instanceof Editor,",
          "      ephemeralState,",
          "      isDeferred,",
          "      leafIcon,",
          "      leafDisplayText,",
          "      leafEvents,",
          "      navigation: view.navigation,",
          "      icon: view.getIcon(),",
          "      hoverPopoverIsNull: view.hoverPopover === null,",
          "      initialMode,",
          "      initialCurrentModeIsEdit,",
          "      markdownViewMode,",
          "      previewModeState,",
          "      previewData,",
          "      previewScroll,",
          "      previewAfterClear,",
          "      searchMode,",
          "      replaceMode,",
          "      editModeState,",
          "      editScroll,",
          "      editAfterClear,",
          "      contentClass: view.contentEl.className,",
          "      action: {",
          "        className: action.className,",
          "        title: action.title,",
          '        ariaLabel: action.getAttribute("aria-label"),',
          "        calls: actionCalls,",
          "      },",
          "      activeLeafMatches: workspace.activeLeaf === leaf,",
          "    };",
          "    await leaf.detach();",
          "  }",
          "}",
          "module.exports = LedgerPlugin;",
          "",
        ].join("\n"),
      );
      await withTestDocument(async () => {
        const host = new PluginHost(fixtureVault);
        try {
          await host.loadAuthorizedPlugin(await testConstructionDispatch(pluginPath));
          expect(
            (globalThis as { __threadleafRuntimeLedgerViewsProbe?: unknown })
              .__threadleafRuntimeLedgerViewsProbe,
          ).toEqual({
            leafIsWorkspaceLeaf: true,
            viewIsView: true,
            itemViewIsItemView: true,
            fileViewIsFileView: true,
            textFileViewIsTextFileView: true,
            markdownViewIsMarkdownView: true,
            viewType: "markdown",
            displayText: "Welcome",
            filePath: "Welcome.md",
            fileState: { file: "Welcome.md" },
            allowNoFile: false,
            canAcceptMarkdown: true,
            viewState: {
              type: "markdown",
              state: { file: "Welcome.md" },
            },
            viewData:
              "---\nkind: compatibility-fixture\n---\n\n# Welcome to Threadleaf\n\nThis synthetic vault proves that the runtime can discover ordinary Markdown without changing it.\n\nContinue to [[Linked Note]].\n\n## Quick start\n\nOpen any local folder, write in Source, then switch to Reading. Your Markdown remains the authority.\n\n## Compatibility in motion\n\nThe section below is transcluded from another ordinary note. Its nested section comes back here,\nwithout converting either file.\n\n![[Linked Note#Project brief]]\n",
            data: "---\nkind: compatibility-fixture\n---\n\n# Welcome to Threadleaf\n\nThis synthetic vault proves that the runtime can discover ordinary Markdown without changing it.\n\nContinue to [[Linked Note]].\n\n## Quick start\n\nOpen any local folder, write in Source, then switch to Reading. Your Markdown remains the authority.\n\n## Compatibility in motion\n\nThe section below is transcluded from another ordinary note. Its nested section comes back here,\nwithout converting either file.\n\n![[Linked Note#Project brief]]\n",
            saveCall: { path: "Welcome.md", dataMatches: true },
            requestSaveIsFunction: true,
            viewDataAfterSet: "temporary",
            viewDataAfterClear: "",
            editorIsEditor: true,
            ephemeralState: { cursor: { from: { line: 1, ch: 2 } } },
            isDeferred: false,
            leafIcon: "document",
            leafDisplayText: "Welcome",
            leafEvents: [
              ["pinned", true],
              ["group", "ledger-group"],
            ],
            navigation: true,
            icon: "document",
            hoverPopoverIsNull: true,
            initialMode: "source",
            initialCurrentModeIsEdit: true,
            markdownViewMode: "source",
            previewModeState: {
              mode: "preview",
              currentIsPreview: true,
              class: true,
              container: true,
              file: "Welcome.md",
            },
            previewData: "Preview",
            previewScroll: 17,
            previewAfterClear: "",
            searchMode: "search",
            replaceMode: "replace",
            editModeState: {
              class: true,
              data: "Edited",
              file: "Welcome.md",
              selection: "",
            },
            editScroll: 9,
            editAfterClear: "",
            contentClass: "view-content",
            action: {
              className: "view-action clickable-icon",
              title: "Ledger action",
              ariaLabel: "Ledger action",
              calls: ["clicked"],
            },
            activeLeafMatches: true,
          });
        } finally {
          await host.close();
        }
      });
    } finally {
      Reflect.deleteProperty(globalThis, "__threadleafRuntimeLedgerViewsProbe");
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });

  /** @compatibility-test-id obsidian-runtime.view-lifecycle.v1 */
  it('proves the base View lifecycle, state, ephemeral state, and pane menu contract through require("obsidian")', async () => {
    const sandboxPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "threadleaf-runtime-ledger-view-lifecycle-"),
    );
    const pluginPath = path.join(sandboxPath, "view-lifecycle-ledger-fixture");
    try {
      await fs.mkdir(pluginPath, { recursive: true });
      await fs.writeFile(
        path.join(pluginPath, "manifest.json"),
        JSON.stringify({
          id: "view-lifecycle-ledger-fixture",
          name: "View lifecycle ledger fixture",
          version: "1.0.0",
        }),
      );
      await fs.writeFile(
        path.join(pluginPath, "main.js"),
        [
          'const { Menu, Plugin, View, WorkspaceLeaf } = require("obsidian");',
          "class LedgerView extends View {",
          "  constructor(leaf) {",
          "    super(leaf);",
          "    this.calls = [];",
          '    this.state = { token: "initial" };',
          "    this.ephemeral = {};",
          "  }",
          '  async onOpen() { await super.onOpen(); this.calls.push("open"); }',
          '  async onClose() { await super.onClose(); this.calls.push("close"); }',
          '  getViewType() { return "ledger-view"; }',
          '  getDisplayText() { return "Ledger view"; }',
          "  getState() {",
          "    const base = super.getState();",
          '    this.calls.push(["getState", Object.keys(base)]);',
          "    return { ...base, token: this.state.token };",
          "  }",
          "  async setState(state, result) {",
          "    await super.setState(state, result);",
          '    this.calls.push(["setState", state, result]);',
          '    if (state && typeof state === "object") this.state = { ...state };',
          "  }",
          "  getEphemeralState() {",
          "    const base = super.getEphemeralState();",
          '    this.calls.push(["getEphemeralState", Object.keys(base)]);',
          "    return { ...base, ...this.ephemeral };",
          "  }",
          "  setEphemeralState(state) {",
          "    super.setEphemeralState(state);",
          '    this.calls.push(["setEphemeralState", state]);',
          '    if (state && typeof state === "object") this.ephemeral = { ...state };',
          "  }",
          "  onPaneMenu(menu, source) {",
          "    super.onPaneMenu(menu, source);",
          '    this.calls.push(["pane", menu instanceof Menu, source]);',
          "  }",
          "}",
          "class LedgerPlugin extends Plugin {",
          "  async onload() {",
          "    const leaf = this.app.workspace.getLeaf(false);",
          "    const view = new LedgerView(leaf);",
          "    const opened = await leaf.open(view);",
          "    const initialState = leaf.getViewState();",
          '    await view.setState({ token: "restored" }, { result: "accepted" });',
          "    const state = view.getState();",
          "    view.setEphemeralState({ cursor: { line: 2, ch: 3 } });",
          "    const ephemeral = view.getEphemeralState();",
          "    const menu = new Menu();",
          '    view.onPaneMenu(menu, "tab-header");',
          "    const callNamesBeforeClose = view.calls.map((call) => Array.isArray(call) ? call[0] : call);",
          '    const stateBaseKeys = view.calls.filter((call) => Array.isArray(call) && call[0] === "getState").map((call) => call[1]);',
          '    const ephemeralBaseKeys = view.calls.filter((call) => Array.isArray(call) && call[0] === "getEphemeralState").map((call) => call[1]);',
          '    const paneCall = view.calls.find((call) => Array.isArray(call) && call[0] === "pane");',
          "    const openState = {",
          "      openedIsView: opened === view,",
          "      leafIsWorkspaceLeaf: leaf instanceof WorkspaceLeaf,",
          "      viewIsView: view instanceof View,",
          "      leafContainerIsViewContainer: leaf.containerEl === view.containerEl,",
          "      leafViewBeforeClose: leaf.view === view,",
          "      viewType: view.getViewType(),",
          "      displayText: view.getDisplayText(),",
          "      initialState,",
          "      state,",
          "      ephemeral,",
          "      callNamesBeforeClose,",
          "      stateBaseKeys,",
          "      ephemeralBaseKeys,",
          "      paneCall,",
          "    };",
          "    await leaf.detach();",
          "    globalThis.__threadleafRuntimeLedgerViewLifecycleProbe = {",
          "      ...openState,",
          '      lifecycle: view.calls.filter((call) => typeof call === "string"),',
          "      leafViewAfterClose: leaf.view === null,",
          "    };",
          "  }",
          "}",
          "module.exports = LedgerPlugin;",
          "",
        ].join("\n"),
      );
      await withTestDocument(async () => {
        const host = new PluginHost(fixtureVault);
        try {
          await host.loadAuthorizedPlugin(await testConstructionDispatch(pluginPath));
          expect(
            (globalThis as { __threadleafRuntimeLedgerViewLifecycleProbe?: unknown })
              .__threadleafRuntimeLedgerViewLifecycleProbe,
          ).toEqual({
            openedIsView: true,
            leafIsWorkspaceLeaf: true,
            viewIsView: true,
            leafContainerIsViewContainer: true,
            leafViewBeforeClose: true,
            viewType: "ledger-view",
            displayText: "Ledger view",
            initialState: {
              type: "ledger-view",
              state: { token: "initial" },
            },
            state: { token: "restored" },
            ephemeral: { cursor: { line: 2, ch: 3 } },
            callNamesBeforeClose: [
              "open",
              "getState",
              "setState",
              "setState",
              "getState",
              "setEphemeralState",
              "getEphemeralState",
              "pane",
            ],
            stateBaseKeys: [[], []],
            ephemeralBaseKeys: [[]],
            paneCall: ["pane", true, "tab-header"],
            lifecycle: ["open", "close"],
            leafViewAfterClose: true,
          });
        } finally {
          await host.close();
        }
      });
    } finally {
      Reflect.deleteProperty(globalThis, "__threadleafRuntimeLedgerViewLifecycleProbe");
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });

  /** @compatibility-test-id obsidian-runtime.settings-components.v1 */
  it('proves DOM-backed settings components through require("obsidian")', async () => {
    const sandboxPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "threadleaf-runtime-ledger-settings-"),
    );
    const pluginPath = path.join(sandboxPath, "settings-ledger-fixture");
    try {
      await fs.mkdir(pluginPath, { recursive: true });
      await fs.writeFile(
        path.join(pluginPath, "manifest.json"),
        JSON.stringify({
          id: "settings-ledger-fixture",
          name: "Settings ledger fixture",
          version: "1.0.0",
        }),
      );
      await fs.writeFile(
        path.join(pluginPath, "main.js"),
        [
          'const { AbstractTextComponent, ButtonComponent, ColorComponent, DisplayValueComponent, DropdownComponent, ExtraButtonComponent, MomentFormatComponent, Plugin, ProgressBarComponent, SearchComponent, Setting, SliderComponent, TextAreaComponent, TextComponent, ToggleComponent } = require("obsidian");',
          "class LedgerPlugin extends Plugin {",
          "  async onload() {",
          '    const root = document.createElement("main");',
          "    document.body.append(root);",
          "    const textChanges = [];",
          "    const dropdownChanges = [];",
          "    const toggleChanges = [];",
          "    const sliderChanges = [];",
          "    let buttonClicks = 0;",
          "    let thenSame = false;",
          "    const setting = new Setting(root);",
          '    setting.setName("Initial name");',
          "    const nameFragment = document.createDocumentFragment();",
          '    nameFragment.append("Settings fixture");',
          "    setting.setName(nameFragment);",
          '    setting.setDesc("A settings fixture").setClass("fixture-setting").setTooltip("Setting tooltip").setHeading().setVisibility(true);',
          "    setting.then((value) => { thenSame = value === setting; });",
          "    let text, toggle, dropdown, slider, button, extra, display, settingSearch, settingTextArea, settingMoment, settingColor, settingProgress, generic;",
          '    setting.addText((component) => { text = component.setValue("draft").setPlaceholder("placeholder").onChange((value) => textChanges.push(value)); });',
          '    text.inputEl.value = "typed";',
          '    text.inputEl.dispatchEvent(new text.inputEl.ownerDocument.defaultView.Event("input", { bubbles: true }));',
          '    setting.addToggle((component) => { toggle = component.setValue(false).setTooltip("Toggle tooltip").onChange((value) => toggleChanges.push(value)); });',
          "    toggle.onClick();",
          '    setting.addDropdown((component) => { dropdown = component.addOption("one", "One").addOptions({ two: "Two" }).setValue("two").onChange((value) => dropdownChanges.push(value)); });',
          '    dropdown.selectEl.dispatchEvent(new dropdown.selectEl.ownerDocument.defaultView.Event("change", { bubbles: true }));',
          "    dropdown.setDisabled(true);",
          "    const dropdownDisabled = dropdown.selectEl.disabled;",
          "    dropdown.setDisabled(false);",
          '    setting.addSlider((component) => { slider = component.setLimits(0, 10, 1).setValue(3).setDisplayFormat((value) => "value=" + value).setInstant(true).setDynamicTooltip().onChange((value) => sliderChanges.push(value)); });',
          '    slider.sliderEl.value = "7";',
          '    slider.sliderEl.dispatchEvent(new slider.sliderEl.ownerDocument.defaultView.Event("input", { bubbles: true }));',
          "    slider.showTooltip();",
          '    setting.addButton((component) => { button = component.setButtonText("Run").setCta().setWarning().setTooltip("Button tooltip").setIcon("check").setClass("fixture-button").onClick(() => buttonClicks += 1); });',
          "    button.buttonEl.click();",
          "    button.removeCta();",
          "    button.setDestructive();",
          '    const destructiveClass = button.buttonEl.classList.contains("mod-warning");',
          "    button.removeDestructive();",
          '    const destructiveRemoved = !button.buttonEl.classList.contains("mod-warning");',
          "    button.setWarning();",
          "    button.setDisabled(true);",
          '    setting.addExtraButton((component) => { extra = component.setTooltip("Extra tooltip").setIcon("x").onClick(() => buttonClicks += 10); });',
          "    extra.extraSettingsEl.click();",
          '    setting.addDisplayValue((component) => { display = component.setValue("Configured").setStatus("warning"); });',
          '    setting.addSearch((component) => { settingSearch = component.setValue("filter"); });',
          '    setting.addTextArea((component) => { settingTextArea = component.setValue("details"); });',
          '    setting.addMomentFormat((component) => { settingMoment = component.setDefaultFormat("YYYY-MM-DD").setValue("2026"); });',
          '    setting.addColorPicker((component) => { settingColor = component.setValue("#123456"); });',
          "    setting.addProgressBar((component) => { settingProgress = component.setValue(8); });",
          '    setting.addComponent((element) => { generic = new TextComponent(element).setValue("generic"); return generic; });',
          '    setting.setErrorMessage("Invalid setting");',
          '    const directRoot = document.createElement("section");',
          "    root.append(directRoot);",
          '    const textArea = new TextAreaComponent(directRoot).setValue("long text").setPlaceholder("textarea placeholder");',
          "    const abstractChanges = [];",
          '    const abstractText = new AbstractTextComponent(document.createElement("input"));',
          "    abstractText.onChange((value) => abstractChanges.push(value));",
          '    abstractText.setValue("abstract").setPlaceholder("abstract placeholder");',
          "    abstractText.onChanged();",
          "    abstractText.setDisabled(true);",
          "    const abstractDisabled = abstractText.inputEl.disabled;",
          "    abstractText.setDisabled(false);",
          "    const searchChanges = [];",
          "    const search = new SearchComponent(directRoot).onChange((value) => searchChanges.push(value));",
          '    search.setValue("query");',
          "    search.onChanged();",
          "    search.clearButtonEl.click();",
          '    const moment = new MomentFormatComponent(directRoot).setDefaultFormat("YYYY-MM-DD").setValue("2026");',
          '    const sampleReplacement = document.createElement("span");',
          "    moment.setSampleEl(sampleReplacement);",
          "    moment.onChanged();",
          "    const colorChanges = [];",
          '    const color = new ColorComponent(directRoot).setValue("#abcdef").onChange((value) => colorChanges.push(value));',
          '    color.colorPickerEl.dispatchEvent(new color.colorPickerEl.ownerDocument.defaultView.Event("input", { bubbles: true }));',
          "    color.setDisabled(true);",
          "    const colorDisabled = color.colorPickerEl.disabled;",
          "    color.setDisabled(false);",
          "    const colorRgb = color.getValueRgb();",
          "    const colorHsl = color.getValueHsl();",
          "    const colorAfterRgb = color.setValueRgb({ r: 255, g: 0, b: 128 }).getValue();",
          "    const colorAfterHsl = color.setValueHsl({ h: 120, s: 100, l: 25 }).getValue();",
          "    const progress = new ProgressBarComponent(directRoot).setValue(42);",
          "    const beforeClear = {",
          "      settingIsSetting: setting instanceof Setting,",
          "      textIsText: text instanceof TextComponent,",
          "      toggleIsToggle: toggle instanceof ToggleComponent,",
          "      dropdownIsDropdown: dropdown instanceof DropdownComponent,",
          "      sliderIsSlider: slider instanceof SliderComponent,",
          "      buttonIsButton: button instanceof ButtonComponent,",
          "      extraIsExtra: extra instanceof ExtraButtonComponent,",
          "      displayIsDisplay: display instanceof DisplayValueComponent,",
          "      name: setting.nameEl.textContent,",
          "      desc: setting.descEl.textContent,",
          "      settingClass: setting.settingEl.className,",
          '      heading: setting.settingEl.classList.contains("setting-item-heading"),',
          "      hidden: setting.settingEl.hidden,",
          "      componentCount: setting.components.length,",
          "      textValue: text.getValue(),",
          "      textPlaceholder: text.inputEl.placeholder,",
          "      textChanges,",
          "      abstractIsAbstractText: abstractText instanceof AbstractTextComponent,",
          "      abstractValue: abstractText.getValue(),",
          "      abstractPlaceholder: abstractText.inputEl.placeholder,",
          "      abstractChanges,",
          "      abstractDisabled,",
          "      toggleValue: toggle.getValue(),",
          "      toggleTooltip: toggle.toggleEl.title,",
          "      toggleChanges,",
          "      dropdownValue: dropdown.getValue(),",
          "      dropdownOptions: [...dropdown.selectEl.options].map((option) => [option.value, option.textContent]),",
          "      dropdownDisabled,",
          "      dropdownChanges,",
          "      sliderValue: slider.getValue(),",
          "      sliderPretty: slider.getValuePretty(),",
          "      sliderDisplay: slider.sliderEl.nextElementSibling && slider.sliderEl.nextElementSibling.textContent,",
          "      sliderLimits: [slider.sliderEl.min, slider.sliderEl.max, slider.sliderEl.step],",
          "      sliderTooltip: slider.sliderEl.title,",
          "      sliderChanges,",
          "      buttonText: button.buttonEl.textContent,",
          "      buttonTitle: button.buttonEl.title,",
          "      buttonClass: button.buttonEl.className,",
          "      buttonDisabled: button.buttonEl.disabled,",
          "      destructiveClass,",
          "      destructiveRemoved,",
          "      extraClass: extra.extraSettingsEl.className,",
          "      extraTitle: extra.extraSettingsEl.title,",
          "      buttonClicks,",
          "      thenSame,",
          "      displayValue: display.valueEl.textContent,",
          "      displayStatus: display.valueEl.dataset.status,",
          '      displayWarning: display.valueEl.classList.contains("mod-warning"),',
          "      settingSearchValue: settingSearch.getValue(),",
          "      settingTextAreaValue: settingTextArea.getValue(),",
          "      settingMomentValue: settingMoment.getValue(),",
          "      settingColorValue: settingColor.getValue(),",
          "      settingProgressValue: settingProgress.getValue(),",
          "      genericValue: generic.getValue(),",
          "      errorMessage: setting.errorEl && setting.errorEl.textContent,",
          '      errorClass: setting.settingEl.classList.contains("is-invalid"),',
          "      textAreaIsTextArea: textArea instanceof TextAreaComponent,",
          "      textAreaValue: textArea.getValue(),",
          "      textAreaPlaceholder: textArea.inputEl.placeholder,",
          "      searchIsSearch: search instanceof SearchComponent,",
          "      searchValue: search.getValue(),",
          "      searchClearButtonClass: search.clearButtonEl.className,",
          "      searchChanges,",
          "      momentIsMoment: moment instanceof MomentFormatComponent,",
          "      momentSample: moment.sampleEl.textContent,",
          "      colorIsColor: color instanceof ColorComponent,",
          "      colorValue: color.getValue(),",
          "      colorRgb,",
          "      colorHsl,",
          "      colorChanges,",
          "      colorDisabled,",
          "      colorAfterRgb,",
          "      colorAfterHsl,",
          "      progressIsProgress: progress instanceof ProgressBarComponent,",
          "      progressValue: progress.getValue(),",
          "    };",
          "    setting.setDisabled(true);",
          '    const settingDisabled = setting.settingEl.classList.contains("is-disabled");',
          "    setting.setDisabled(false);",
          "    setting.clear();",
          "    globalThis.__threadleafRuntimeLedgerSettingsProbe = {",
          "      beforeClear,",
          "      settingDisabled,",
          "      afterClear: {",
          "        componentCount: setting.components.length,",
          "        name: setting.nameEl.textContent,",
          "        desc: setting.descEl.textContent,",
          "        controls: setting.controlEl.childElementCount,",
          "        error: setting.errorEl === null,",
          "      },",
          "    };",
          "  }",
          "}",
          "module.exports = LedgerPlugin;",
          "",
        ].join("\n"),
      );
      await withTestDocument(async () => {
        const host = new PluginHost(fixtureVault);
        try {
          await host.loadAuthorizedPlugin(await testConstructionDispatch(pluginPath));
          expect(
            (globalThis as { __threadleafRuntimeLedgerSettingsProbe?: unknown })
              .__threadleafRuntimeLedgerSettingsProbe,
          ).toEqual({
            beforeClear: {
              settingIsSetting: true,
              textIsText: true,
              toggleIsToggle: true,
              dropdownIsDropdown: true,
              sliderIsSlider: true,
              buttonIsButton: true,
              extraIsExtra: true,
              displayIsDisplay: true,
              name: "Settings fixture",
              desc: "A settings fixture",
              settingClass: "setting-item fixture-setting setting-item-heading is-invalid",
              heading: true,
              hidden: false,
              componentCount: 13,
              textValue: "typed",
              textPlaceholder: "placeholder",
              textChanges: ["typed"],
              abstractIsAbstractText: true,
              abstractValue: "abstract",
              abstractPlaceholder: "abstract placeholder",
              abstractChanges: ["abstract"],
              abstractDisabled: true,
              toggleValue: true,
              toggleTooltip: "Toggle tooltip",
              toggleChanges: [true],
              dropdownValue: "two",
              dropdownOptions: [
                ["one", "One"],
                ["two", "Two"],
              ],
              dropdownDisabled: true,
              dropdownChanges: ["two"],
              sliderValue: 7,
              sliderPretty: "value=7",
              sliderDisplay: "value=7",
              sliderLimits: ["0", "10", "1"],
              sliderTooltip: "value=7",
              sliderChanges: [7],
              buttonText: "",
              buttonTitle: "Button tooltip",
              buttonClass: "fixture-button mod-warning",
              buttonDisabled: true,
              destructiveClass: true,
              destructiveRemoved: true,
              extraClass: "clickable-icon extra-setting-button",
              extraTitle: "Extra tooltip",
              buttonClicks: 11,
              thenSame: true,
              displayValue: "Configured",
              displayStatus: "warning",
              displayWarning: true,
              settingSearchValue: "filter",
              settingTextAreaValue: "details",
              settingMomentValue: "2026",
              settingColorValue: "#123456",
              settingProgressValue: 8,
              genericValue: "generic",
              errorMessage: "Invalid setting",
              errorClass: true,
              textAreaIsTextArea: true,
              textAreaValue: "long text",
              textAreaPlaceholder: "textarea placeholder",
              searchIsSearch: true,
              searchValue: "",
              searchClearButtonClass: "search-input-clear-button",
              searchChanges: ["query", ""],
              momentIsMoment: true,
              momentSample: "2026",
              colorIsColor: true,
              colorValue: "#008000",
              colorRgb: { r: 171, g: 205, b: 239 },
              colorHsl: { h: 210, s: 68, l: 80 },
              colorChanges: ["#abcdef"],
              colorDisabled: true,
              colorAfterRgb: "#ff0080",
              colorAfterHsl: "#008000",
              progressIsProgress: true,
              progressValue: 42,
            },
            settingDisabled: true,
            afterClear: {
              componentCount: 0,
              name: "",
              desc: "",
              controls: 0,
              error: true,
            },
          });
        } finally {
          await host.close();
        }
      });
    } finally {
      Reflect.deleteProperty(globalThis, "__threadleafRuntimeLedgerSettingsProbe");
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });

  /** @compatibility-test-id obsidian-runtime.setting-tabs.v1 */
  it('proves setting-tab definition and plugin-settings behavior through require("obsidian")', async () => {
    const sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-runtime-ledger-tabs-"));
    const pluginPath = path.join(sandboxPath, "setting-tabs-ledger-fixture");
    try {
      await fs.mkdir(pluginPath, { recursive: true });
      await fs.writeFile(
        path.join(pluginPath, "manifest.json"),
        JSON.stringify({
          id: "setting-tabs-ledger-fixture",
          name: "Setting tabs ledger fixture",
          version: "1.0.0",
        }),
      );
      await fs.writeFile(
        path.join(pluginPath, "main.js"),
        [
          'const { Plugin, PluginSettingTab, SettingTab } = require("obsidian");',
          "class LedgerPlugin extends Plugin {",
          "  async onload() {",
          '    this.settings = { enabled: false, label: "draft" };',
          '    const definitions = [{ type: "control", key: "enabled" }];',
          "    class AppTab extends SettingTab {",
          "      getSettingDefinitions() { return definitions; }",
          "    }",
          "    const appTab = new AppTab(this.app);",
          "    const definitionsBeforeUpdate = appTab.getSettingDefinitions();",
          "    appTab.update();",
          "    const itemsAfterUpdate = appTab.settingItems;",
          '    appTab.containerEl.append(document.createElement("p"));',
          "    appTab.display();",
          "    const itemsAfterDisplay = appTab.settingItems;",
          "    appTab.refreshDomState();",
          '    const baseControlValue = appTab.getControlValue("missing");',
          '    let baseWriteError = "";',
          '    try { appTab.setControlValue("missing", true); } catch (error) { baseWriteError = error.message; }',
          "    appTab.hide();",
          "    const pluginTab = new PluginSettingTab(this.app, this);",
          "    const pluginDefinitions = pluginTab.getSettingDefinitions();",
          '    const pluginValueBefore = pluginTab.getControlValue("enabled");',
          '    await pluginTab.setControlValue("enabled", true);',
          '    const pluginValueAfter = pluginTab.getControlValue("enabled");',
          "    const savedSettings = await this.loadData();",
          "    globalThis.__threadleafRuntimeLedgerSettingTabsProbe = {",
          "      appTabIsSettingTab: appTab instanceof SettingTab,",
          "      pluginTabIsPluginSettingTab: pluginTab instanceof PluginSettingTab,",
          "      app: appTab.app === this.app,",
          "      icon: appTab.icon,",
          "      containerClass: appTab.containerEl.className,",
          "      definitionsBeforeUpdate,",
          "      itemsAfterUpdate,",
          "      updateCopiedDefinitions: itemsAfterUpdate !== definitionsBeforeUpdate,",
          "      itemsAfterDisplay,",
          "      displayCopiedDefinitions: itemsAfterDisplay !== definitions,",
          "      baseControlValue,",
          "      baseWriteError,",
          "      hiddenChildren: appTab.containerEl.childElementCount,",
          "      pluginDefinitions,",
          "      pluginValueBefore,",
          "      pluginValueAfter,",
          "      pluginSettings: this.settings,",
          "      savedSettings,",
          "    };",
          "  }",
          "}",
          "module.exports = LedgerPlugin;",
          "",
        ].join("\n"),
      );
      const testVaultPath = path.join(sandboxPath, "vault");
      await fs.mkdir(testVaultPath, { recursive: true });
      await withTestDocument(async () => {
        const host = new PluginHost(testVaultPath);
        try {
          await host.loadAuthorizedPlugin(await testConstructionDispatch(pluginPath));
          expect(
            (globalThis as { __threadleafRuntimeLedgerSettingTabsProbe?: unknown })
              .__threadleafRuntimeLedgerSettingTabsProbe,
          ).toEqual({
            appTabIsSettingTab: true,
            pluginTabIsPluginSettingTab: true,
            app: true,
            icon: "",
            containerClass: "vertical-tab-content",
            definitionsBeforeUpdate: [{ type: "control", key: "enabled" }],
            itemsAfterUpdate: [{ type: "control", key: "enabled" }],
            updateCopiedDefinitions: true,
            itemsAfterDisplay: [{ type: "control", key: "enabled" }],
            displayCopiedDefinitions: true,
            baseControlValue: undefined,
            baseWriteError:
              "SettingTab control writes require a kernel-owned vault configuration adapter.",
            hiddenChildren: 0,
            pluginDefinitions: [],
            pluginValueBefore: false,
            pluginValueAfter: true,
            pluginSettings: { enabled: true, label: "draft" },
            savedSettings: { enabled: true, label: "draft" },
          });
        } finally {
          await host.close();
        }
      });
    } finally {
      Reflect.deleteProperty(globalThis, "__threadleafRuntimeLedgerSettingTabsProbe");
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });

  /** @compatibility-test-id obsidian-runtime.suggest-components.v1 */
  it('proves popover and input-suggestion behavior through require("obsidian")', async () => {
    const sandboxPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "threadleaf-runtime-ledger-suggest-"),
    );
    const pluginPath = path.join(sandboxPath, "suggest-components-ledger-fixture");
    try {
      await fs.mkdir(pluginPath, { recursive: true });
      await fs.writeFile(
        path.join(pluginPath, "manifest.json"),
        JSON.stringify({
          id: "suggest-components-ledger-fixture",
          name: "Suggest components ledger fixture",
          version: "1.0.0",
        }),
      );
      await fs.writeFile(
        path.join(pluginPath, "main.js"),
        [
          'const { AbstractInputSuggest, Plugin, PopoverSuggest, Scope } = require("obsidian");',
          "class LedgerPlugin extends Plugin {",
          "  async onload() {",
          "    const popoverSelections = [];",
          "    class FixturePopover extends PopoverSuggest {",
          "      renderSuggestion(value, element) { element.textContent = value; }",
          "      selectSuggestion(value, event) { popoverSelections.push([value, event.type]); this.close(); }",
          "    }",
          "    const popoverScope = new Scope();",
          "    const popover = new FixturePopover(this.app, popoverScope);",
          '    const manualSuggestion = document.createElement("span");',
          '    popover.renderSuggestion("Manual", manualSuggestion);',
          "    popover.open();",
          "    const popoverOpen = document.body.contains(popover.suggestEl);",
          '    popover.selectSuggestion("Picked", { type: "click" });',
          "    const selectedValues = [];",
          "    class FixtureInputSuggest extends AbstractInputSuggest {",
          '      getSuggestions(query) { return ["Alpha", "Alpine", "Beta"].filter((value) => value.toLowerCase().startsWith(query.toLowerCase())); }',
          "      renderSuggestion(value, element) { element.textContent = value; }",
          "    }",
          '    const input = document.createElement("input");',
          "    document.body.append(input);",
          "    const inputSuggest = new FixtureInputSuggest(this.app, input);",
          "    inputSuggest.limit = 2;",
          "    inputSuggest.onSelect((value, event) => selectedValues.push([value, event.type]));",
          '    inputSuggest.setValue("Al");',
          '    input.dispatchEvent(new input.ownerDocument.defaultView.Event("input", { bubbles: true }));',
          "    await new Promise((resolve) => setTimeout(resolve, 0));",
          '    const suggestions = [...document.querySelectorAll(".suggestion-item")].map((element) => element.textContent);',
          '    input.dispatchEvent(new input.ownerDocument.defaultView.KeyboardEvent("keydown", { key: "ArrowDown" }));',
          '    input.dispatchEvent(new input.ownerDocument.defaultView.KeyboardEvent("keydown", { key: "Enter" }));',
          "    globalThis.__threadleafRuntimeLedgerSuggestProbe = {",
          "      popoverApp: popover.app === this.app,",
          "      popoverScope: popover.scope === popoverScope,",
          "      popoverIsPopover: popover instanceof PopoverSuggest,",
          "      manualText: manualSuggestion.textContent,",
          "      popoverOpen,",
          "      popoverClosed: !document.body.contains(popover.suggestEl),",
          "      popoverSelections,",
          "      inputIsInputSuggest: inputSuggest instanceof AbstractInputSuggest,",
          "      inputValue: inputSuggest.getValue(),",
          "      inputLimit: inputSuggest.limit,",
          "      suggestions,",
          "      selectedValues,",
          "      inputClosed: !document.body.contains(inputSuggest.suggestEl),",
          "    };",
          "  }",
          "}",
          "module.exports = LedgerPlugin;",
          "",
        ].join("\n"),
      );
      const testVaultPath = path.join(sandboxPath, "vault");
      await fs.mkdir(testVaultPath, { recursive: true });
      await withTestDocument(async () => {
        const host = new PluginHost(testVaultPath);
        try {
          await host.loadAuthorizedPlugin(await testConstructionDispatch(pluginPath));
          expect(
            (globalThis as { __threadleafRuntimeLedgerSuggestProbe?: unknown })
              .__threadleafRuntimeLedgerSuggestProbe,
          ).toEqual({
            popoverApp: true,
            popoverScope: true,
            popoverIsPopover: true,
            manualText: "Manual",
            popoverOpen: true,
            popoverClosed: true,
            popoverSelections: [["Picked", "click"]],
            inputIsInputSuggest: true,
            inputValue: "Al",
            inputLimit: 2,
            suggestions: ["Alpha", "Alpine"],
            selectedValues: [["Alpine", "keydown"]],
            inputClosed: true,
          });
        } finally {
          await host.close();
        }
      });
    } finally {
      Reflect.deleteProperty(globalThis, "__threadleafRuntimeLedgerSuggestProbe");
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });
});
