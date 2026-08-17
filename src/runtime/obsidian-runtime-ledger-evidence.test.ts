import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
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
          'const { BaseComponent, Component, Plugin, Platform, normalizePath } = require("obsidian");',
          "class LedgerPlugin extends Plugin {",
          "  async onload() {",
          "    const base = new BaseComponent().setDisabled(true);",
          "    const child = new Component();",
          "    let released = false;",
          "    child.onunload = () => { released = true; };",
          "    const parent = new Component();",
          "    parent.addChild(child);",
          "    parent.load();",
          "    parent.unload();",
          "    globalThis.__threadleafRuntimeLedgerProbe = {",
          "      baseDisabled: base.disabled,",
          "      childReleased: released,",
          "      componentIsComponent: parent instanceof Component,",
          "      pluginIsPlugin: this instanceof Plugin,",
          "      desktop: Platform.isDesktop === true,",
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
          baseDisabled: true,
          childReleased: true,
          componentIsComponent: true,
          pluginIsPlugin: true,
          desktop: true,
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

  /** @compatibility-test-id obsidian-runtime.utility-functions.v1 */
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
          'const { Plugin, getLinkpath, normalizePath, parseLinktext, prepareFuzzySearch, prepareSimpleSearch } = require("obsidian");',
          "class LedgerPlugin extends Plugin {",
          "  async onload() {",
          '    const fuzzy = prepareFuzzySearch("dng");',
          '    const simple = prepareSimpleSearch("alpha beta");',
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
        });
      } finally {
        await host.close();
      }
    } finally {
      Reflect.deleteProperty(globalThis, "__threadleafRuntimeLedgerUtilityProbe");
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
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
          "        fileCount: vault.getFiles().length,",
          "        markdownCount: vault.getMarkdownFiles().length,",
          "        folderPaths: vault.getAllFolders().map((item) => item.path),",
          "        loadedHasRoot: vault.getAllLoadedFiles().some((item) => item instanceof TFolder && item.isRoot),",
          "      },",
          "      workspace: {",
          "        isEvents: workspace instanceof Events,",
          "        rootSplitIsSplit: workspace.rootSplit instanceof WorkspaceSplit,",
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
            fileCount: 3,
            markdownCount: 2,
            folderPaths: ["Boards"],
            loadedHasRoot: true,
          },
          workspace: {
            isEvents: true,
            rootSplitIsSplit: true,
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

  /** @compatibility-test-id obsidian-runtime.render-views.v1 */
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
          'const { Editor, FileView, ItemView, MarkdownView, Plugin, TextFileView, View, WorkspaceLeaf } = require("obsidian");',
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
          'const { ButtonComponent, ColorComponent, DropdownComponent, ExtraButtonComponent, MomentFormatComponent, Plugin, ProgressBarComponent, SearchComponent, Setting, SliderComponent, TextAreaComponent, TextComponent, ToggleComponent } = require("obsidian");',
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
          "    let text, toggle, dropdown, slider, button, extra;",
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
          "    setting.addSlider((component) => { slider = component.setLimits(0, 10, 1).setValue(3).setInstant(true).setDynamicTooltip().onChange((value) => sliderChanges.push(value)); });",
          '    slider.sliderEl.value = "7";',
          '    slider.sliderEl.dispatchEvent(new slider.sliderEl.ownerDocument.defaultView.Event("input", { bubbles: true }));',
          "    slider.showTooltip();",
          '    setting.addButton((component) => { button = component.setButtonText("Run").setCta().setWarning().setTooltip("Button tooltip").setIcon("check").setClass("fixture-button").onClick(() => buttonClicks += 1); });',
          "    button.buttonEl.click();",
          "    button.removeCta();",
          "    button.setDisabled(true);",
          '    setting.addExtraButton((component) => { extra = component.setTooltip("Extra tooltip").setIcon("x").onClick(() => buttonClicks += 10); });',
          "    extra.extraSettingsEl.click();",
          '    const directRoot = document.createElement("section");',
          "    root.append(directRoot);",
          '    const textArea = new TextAreaComponent(directRoot).setValue("long text").setPlaceholder("textarea placeholder");',
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
          "    const progress = new ProgressBarComponent(directRoot).setValue(42);",
          "    const beforeClear = {",
          "      settingIsSetting: setting instanceof Setting,",
          "      textIsText: text instanceof TextComponent,",
          "      toggleIsToggle: toggle instanceof ToggleComponent,",
          "      dropdownIsDropdown: dropdown instanceof DropdownComponent,",
          "      sliderIsSlider: slider instanceof SliderComponent,",
          "      buttonIsButton: button instanceof ButtonComponent,",
          "      extraIsExtra: extra instanceof ExtraButtonComponent,",
          "      name: setting.nameEl.textContent,",
          "      desc: setting.descEl.textContent,",
          "      settingClass: setting.settingEl.className,",
          '      heading: setting.settingEl.classList.contains("setting-item-heading"),',
          "      hidden: setting.settingEl.hidden,",
          "      componentCount: setting.components.length,",
          "      textValue: text.getValue(),",
          "      textPlaceholder: text.inputEl.placeholder,",
          "      textChanges,",
          "      toggleValue: toggle.getValue(),",
          "      toggleTooltip: toggle.toggleEl.title,",
          "      toggleChanges,",
          "      dropdownValue: dropdown.getValue(),",
          "      dropdownOptions: [...dropdown.selectEl.options].map((option) => [option.value, option.textContent]),",
          "      dropdownDisabled,",
          "      dropdownChanges,",
          "      sliderValue: slider.getValue(),",
          "      sliderPretty: slider.getValuePretty(),",
          "      sliderLimits: [slider.sliderEl.min, slider.sliderEl.max, slider.sliderEl.step],",
          "      sliderTooltip: slider.sliderEl.title,",
          "      sliderChanges,",
          "      buttonText: button.buttonEl.textContent,",
          "      buttonTitle: button.buttonEl.title,",
          "      buttonClass: button.buttonEl.className,",
          "      buttonDisabled: button.buttonEl.disabled,",
          "      extraClass: extra.extraSettingsEl.className,",
          "      extraTitle: extra.extraSettingsEl.title,",
          "      buttonClicks,",
          "      thenSame,",
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
          "      colorChanges,",
          "      colorDisabled,",
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
              name: "Settings fixture",
              desc: "A settings fixture",
              settingClass: "setting-item fixture-setting setting-item-heading",
              heading: true,
              hidden: false,
              componentCount: 6,
              textValue: "typed",
              textPlaceholder: "placeholder",
              textChanges: ["typed"],
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
              sliderPretty: "7",
              sliderLimits: ["0", "10", "1"],
              sliderTooltip: "7",
              sliderChanges: [7],
              buttonText: "",
              buttonTitle: "Button tooltip",
              buttonClass: "mod-warning fixture-button",
              buttonDisabled: true,
              extraClass: "clickable-icon extra-setting-button",
              extraTitle: "Extra tooltip",
              buttonClicks: 11,
              thenSame: true,
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
              colorValue: "#abcdef",
              colorChanges: ["#abcdef"],
              colorDisabled: true,
              progressIsProgress: true,
              progressValue: 42,
            },
            settingDisabled: true,
            afterClear: {
              componentCount: 0,
              name: "",
              desc: "",
              controls: 0,
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
});
