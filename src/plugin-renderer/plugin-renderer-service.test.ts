import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { revisionOf } from "../kernel/durability";
import type { Vault } from "../runtime/obsidian-compat";
import { installObsidianDomCompatibility } from "../runtime/obsidian-dom";
import type {
  PluginRendererRequest,
  PluginVaultCreateBinaryRequest,
  PluginVaultRenameRequest,
  PluginVaultTrashRequest,
  PluginVaultWriteBinaryRequest,
  PluginVaultWriteRequest,
} from "../shared/plugin-runtime-protocol";
import { testConstructionDispatch } from "../test-support/plugin-construction";
import { PluginRendererService } from "./plugin-renderer-service";

const previousGlobals = new Map<string, PropertyDescriptor | undefined>();

function exposeDom(dom: JSDOM): void {
  for (const [name, value] of Object.entries({
    DocumentFragment: dom.window.DocumentFragment,
    Element: dom.window.Element,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    MouseEvent: dom.window.MouseEvent,
    SVGSVGElement: dom.window.SVGSVGElement,
    document: dom.window.document,
    window: dom.window,
  })) {
    previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
  }
}

afterEach(() => {
  for (const [name, descriptor] of previousGlobals) {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, name);
    }
  }
  previousGlobals.clear();
});

function request(
  operation: PluginRendererRequest["operation"],
  payload?: Record<string, unknown>,
): PluginRendererRequest {
  return { id: `${operation}-request`, operation, ...(payload ? { payload } : {}) };
}

describe("PluginRendererService", () => {
  it("owns a DOM plugin lifecycle behind the renderer protocol", async () => {
    const sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-renderer-service-"));
    const vaultPath = path.join(sandboxPath, "vault");
    const pluginPath = path.join(vaultPath, ".obsidian", "plugins", "renderer-fixture");
    const dom = new JSDOM("<!doctype html><body></body>", {
      url: "https://threadleaf.invalid/",
    });
    installObsidianDomCompatibility(dom.window);
    exposeDom(dom);
    try {
      await fs.mkdir(pluginPath, { recursive: true });
      await fs.writeFile(
        path.join(pluginPath, "manifest.json"),
        JSON.stringify({ id: "renderer-fixture", name: "Renderer fixture", version: "0.1.0" }),
        "utf8",
      );
      await fs.writeFile(
        path.join(pluginPath, "main.js"),
        `const { FileSystemAdapter, MarkdownRenderer, Menu, Notice, Platform, Plugin, PluginSettingTab, Setting, TextFileView, WorkspaceSplit, arrayBufferToBase64, base64ToArrayBuffer, debounce, htmlToMarkdown, moment, prepareFuzzySearch, setTooltip } = require("obsidian");
class RendererView extends TextFileView {
  constructor(leaf) {
    super(leaf);
    this.addAction("link", "Copy drawing link", () => new Notice("Drawing link copied."));
  }
  getViewType() { return "renderer-view"; }
  getDisplayText() { return this.file?.basename ?? "Renderer view"; }
  setViewData(data, clear) {
    super.setViewData(data, clear);
    this.contentEl.setText(data);
  }
  clear() {
    super.clear();
    this.contentEl.empty();
  }
}
module.exports = class RendererFixture extends Plugin {
  async onload() {
    if (moment.utc("2026-08-12").format("YYYY-MM-DD") !== "2026-08-12") throw new Error("Module moment missing");
    if (window.moment.utc("2026-08-12").format("YYYY-MM-DD") !== "2026-08-12") throw new Error("Global moment missing");
    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) throw new Error("Desktop adapter missing");
    if (this.app.vault.adapter.basePath !== this.app.vault.adapter.getBasePath()) throw new Error("Adapter base path mismatch");
    const canvasFile = this.app.vault.getFileByPath("Canvas.drawing");
    if (!this.app.vault.getResourcePath(canvasFile).startsWith("file:")) throw new Error("Resource URL missing");
    if (arrayBufferToBase64(base64ToArrayBuffer("AAH/")) !== "AAH/") throw new Error("Binary codec mismatch");
    if (htmlToMarkdown("<h2>Renderer</h2>") !== "## Renderer") throw new Error("HTML conversion mismatch");
    if (JSON.stringify(prepareFuzzySearch("rdr")("Renderer")?.matches) !== JSON.stringify([[0,1],[3,4],[5,6]])) throw new Error("Fuzzy search mismatch");
    if (!Platform.isDesktopApp || Platform.isMobile) throw new Error("Desktop platform flags missing");
    let deferredValue = "";
    const deferred = debounce((value) => deferredValue = value, 100, true);
    deferred("ready").run();
    if (deferredValue !== "ready") throw new Error("Debouncer controls missing");
    const tooltipTarget = document.createElement("button");
    setTooltip(tooltipTarget, "Renderer tooltip", { placement: "bottom" });
    if (tooltipTarget.title !== "Renderer tooltip" || tooltipTarget.dataset.tooltipPosition !== "bottom") throw new Error("Tooltip metadata missing");
    let menuRan = false;
    const menu = new Menu().addItem((item) => item.setTitle("Renderer menu").setIcon("leaf").onClick(() => menuRan = true));
    menu.showAtPosition({ x: 12, y: 12 });
    const menuItem = document.querySelector(".threadleaf-compat-menu .menu-item");
    if (!menuItem) throw new Error("Menu surface missing");
    menuItem.click();
    if (!menuRan || document.querySelector(".threadleaf-compat-menu")) throw new Error("Menu click lifecycle missing");
    if (this.app.vault.getConfig("propertiesInDocument") !== undefined) throw new Error("Unexpected compatibility config");
    this.addRibbonIcon("leaf", "Renderer action", () => new Notice("Renderer action ran."));
    this.addCommand({ id: "renderer-command", name: "Superseded command", callback: () => new Notice("Superseded command ran.") });
    this.addCommand({ id: "renderer-command", name: "Renderer command", callback: () => new Notice("Renderer command ran.") });
    this.addCommand({
      id: "renderer-create",
      name: "Create renderer drawing",
      callback: async () => {
        await this.app.vault.createFolder("Drawings");
        const file = await this.app.vault.create("Drawings/New.drawing", "new drawing content");
        await this.app.workspace.getLeaf(false).openFile(file);
      },
    });
    this.addCommand({
      id: "renderer-binary",
      name: "Create renderer binary",
      callback: async () => {
        await this.app.vault.createFolder("Binary");
        const file = await this.app.vault.createBinary("Binary/Preview.png", Uint8Array.from([137, 80, 78, 71, 0, 255]).buffer);
        await this.app.vault.modifyBinary(file, Uint8Array.from([137, 80, 78, 71, 1, 2, 3, 0, 255]).buffer);
        await this.app.fileManager.renameFile(file, "Binary/Renamed.png");
        await this.app.fileManager.trashFile(file);
      },
    });
    this.registerView("renderer-view", (leaf) => new RendererView(leaf));
    this.registerExtensions(["drawing"], "renderer-view");
    this.addSettingTab(new (class extends PluginSettingTab {
      display() {
        this.containerEl.empty();
        this.containerEl.createEl("h2", { text: "Renderer fixture settings" });
        new Setting(this.containerEl).setName("Render links").setDesc("Keep drawing links visible.").addToggle((toggle) => toggle.setValue(true));
      }
    })(this.app, this));
    this.registerEditorExtension([]);
    this.registerMarkdownCodeBlockProcessor("renderer", () => {});
    this.registerEvent(this.app.vault.on("modify", () => {}));
    const clickHandler = () => {};
    this.app.workspace.containerEl.addEventListener("click", clickHandler);
    this.register(() => this.app.workspace.containerEl.removeEventListener("click", clickHandler));
    let optionUpdates = 0;
    this.registerEvent(this.app.workspace.on("layout-change", () => optionUpdates++));
    this.app.workspace.updateOptions();
    if (optionUpdates !== 1) throw new Error("Workspace options did not update");
    const rendered = document.createElement("div");
    rendered.id = "renderer-markdown";
    await MarkdownRenderer.render(this.app, "**Release notes** [Guide](https://example.com) <div class='release-callout'>Welcome</div>", rendered, "", this);
    document.body.append(rendered);
    this.app.workspace.onLayoutReady(() => {
      const split = new WorkspaceSplit(this.app.workspace, "vertical");
      const leaf = this.app.workspace.createLeafInParent(split, 0);
      const canvas = this.app.internalPlugins.plugins.canvas.views.canvas(leaf).canvas;
      const node = canvas.createFileNode({ file: this.app.vault.getFileByPath("Canvas.drawing") });
      canvas.removeNode(node);
      const scope = this.app.keymap.getRootScope();
      const key = scope.register(["Mod"], "k", () => true);
      scope.unregister(key);
      new Notice("Renderer layout ready.");
    });
  }
};
`,
        "utf8",
      );
      await fs.writeFile(
        path.join(vaultPath, "Canvas.drawing"),
        "renderer surface content",
        "utf8",
      );

      const writes: PluginVaultWriteRequest[] = [];
      const binaryCreates: PluginVaultCreateBinaryRequest[] = [];
      const binaryRenames: PluginVaultRenameRequest[] = [];
      const binaryTrashes: PluginVaultTrashRequest[] = [];
      const binaryWrites: PluginVaultWriteBinaryRequest[] = [];
      const createdFolders: string[] = [];
      const createdFiles: string[] = [];
      const service = new PluginRendererService({
        createBinary: async (createRequest) => {
          binaryCreates.push(createRequest);
          const bytes = new Uint8Array(createRequest.content);
          await fs.writeFile(path.join(createRequest.vaultPath, createRequest.filePath), bytes, {
            flag: "wx",
          });
          return {
            status: "committed",
            path: createRequest.filePath,
            revision: revisionOf(bytes),
            transactionId: "renderer-test-binary-create",
          };
        },
        createFolder: async (createRequest) => {
          const absolutePath = path.join(createRequest.vaultPath, createRequest.folderPath);
          let created = false;
          try {
            await fs.mkdir(absolutePath);
            created = true;
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
              throw error;
            }
          }
          createdFolders.push(createRequest.folderPath);
          return { path: createRequest.folderPath, created };
        },
        createText: async (createRequest) => {
          const absolutePath = path.join(createRequest.vaultPath, createRequest.filePath);
          await fs.writeFile(absolutePath, createRequest.content, { encoding: "utf8", flag: "wx" });
          createdFiles.push(createRequest.filePath);
          return {
            status: "committed",
            path: createRequest.filePath,
            revision: revisionOf(Buffer.from(createRequest.content, "utf8")),
            transactionId: "renderer-test-create",
          };
        },
        renameFile: async (renameRequest) => {
          binaryRenames.push(renameRequest);
          await fs.rename(
            path.join(renameRequest.vaultPath, renameRequest.sourcePath),
            path.join(renameRequest.vaultPath, renameRequest.targetPath),
          );
          return {
            status: "committed",
            from: renameRequest.sourcePath,
            to: renameRequest.targetPath,
            transactionId: "renderer-test-binary-rename",
          };
        },
        trashFile: async (trashRequest) => {
          binaryTrashes.push(trashRequest);
          const targetPath = `.trash/${trashRequest.filePath}`;
          await fs.mkdir(path.dirname(path.join(trashRequest.vaultPath, targetPath)), {
            recursive: true,
          });
          await fs.rename(
            path.join(trashRequest.vaultPath, trashRequest.filePath),
            path.join(trashRequest.vaultPath, targetPath),
          );
          return {
            status: "committed",
            from: trashRequest.filePath,
            to: targetPath,
            transactionId: "renderer-test-binary-trash",
          };
        },
        writeBinary: async (writeRequest) => {
          binaryWrites.push(writeRequest);
          const bytes = new Uint8Array(writeRequest.content);
          await fs.writeFile(path.join(writeRequest.vaultPath, writeRequest.filePath), bytes);
          return {
            status: "committed",
            path: writeRequest.filePath,
            revision: revisionOf(bytes),
            transactionId: "renderer-test-binary-write",
          };
        },
        writeText: async (writeRequest) => {
          writes.push({ ...writeRequest });
          const absolutePath = path.join(writeRequest.vaultPath, writeRequest.filePath);
          await fs.writeFile(absolutePath, writeRequest.content, "utf8");
          return {
            status: "committed",
            path: writeRequest.filePath,
            revision: revisionOf(Buffer.from(writeRequest.content, "utf8")),
            transactionId: "renderer-test-write",
          };
        },
      });
      const initialized = await service.handle(
        request("initialize", {
          vaultPath,
          packageJsonPath: path.resolve("package.json"),
        }),
      );
      expect(initialized?.vault.path).toBe(await fs.realpath(vaultPath));
      expect(dom.window.eval("app.vault.getName()")).toBe("vault");
      expect(dom.window.eval("typeof moment")).toBe("function");

      const loaded = await service.handle(
        request("load-plugin", { dispatch: await testConstructionDispatch(pluginPath) }),
      );
      expect(loaded?.plugin).toMatchObject({
        id: "renderer-fixture",
        state: "loaded",
        compatibilityLevel: 3,
      });
      expect(loaded?.actions.map(({ id }) => id)).toEqual([
        "renderer-fixture:renderer-binary",
        "renderer-fixture:renderer-create",
        "renderer-fixture:renderer-command",
      ]);
      expect(loaded?.integrations).toMatchObject({
        extensions: [{ extension: "drawing", viewType: "renderer-view" }],
        settingTabPluginIds: ["renderer-fixture"],
        viewTypes: ["renderer-view"],
      });
      expect(dom.window.eval('app.plugins.plugins["renderer-fixture"].manifest.id')).toBe(
        "renderer-fixture",
      );

      const settings = await service.handle(
        request("open-settings", { pluginId: "renderer-fixture" }),
      );
      expect(settings?.pluginSurface).toEqual({
        displayText: "Renderer fixture settings",
        filePath: null,
        viewType: "threadleaf-plugin-settings",
      });
      expect(dom.window.document.querySelector(".vertical-tab-content h2")?.textContent).toBe(
        "Renderer fixture settings",
      );
      expect(dom.window.document.querySelector(".setting-item-name")?.textContent).toBe(
        "Render links",
      );
      await service.handle(request("close-view"));
      expect(dom.window.document.querySelector("#threadleaf-plugin-surface")).toBeNull();

      const opened = await service.handle(
        request("open-view", { viewType: "renderer-view", filePath: "Canvas.drawing" }),
      );
      expect(opened?.pluginSurface).toEqual({
        displayText: "Canvas",
        filePath: "Canvas.drawing",
        viewType: "renderer-view",
      });
      expect(dom.window.document.querySelector(".view-content")?.textContent).toBe(
        "renderer surface content",
      );
      expect(dom.window.document.querySelector(".view-header-title")?.textContent).toBe(
        "Canvas.drawing",
      );
      expect(dom.window.document.querySelector(".view-action")?.getAttribute("title")).toBe(
        "Copy drawing link",
      );
      expect(
        dom.window.document.querySelector('.view-action svg[data-icon="link"]'),
      ).not.toBeNull();
      expect(dom.window.document.querySelector("#renderer-markdown strong")?.textContent).toBe(
        "Release notes",
      );
      expect(dom.window.document.querySelector("#renderer-markdown a")?.getAttribute("href")).toBe(
        "#",
      );
      expect(
        (dom.window.document.querySelector("#renderer-markdown a") as HTMLElement | null)?.dataset
          .href,
      ).toBe("https://example.com");
      expect(
        dom.window.document.querySelector("#renderer-markdown .release-callout")?.textContent,
      ).toBe("Welcome");
      expect(opened?.events.at(-1)?.message).toContain("Opened plugin view renderer-view");

      const view = dom.window.eval('app.workspace.getLeavesOfType("renderer-view")[0].view') as {
        save(): Promise<void>;
        setViewData(data: string, clear: boolean): void;
      };
      view.setViewData("saved renderer surface", false);
      await view.save();
      expect(writes).toEqual([
        {
          vaultPath,
          filePath: "Canvas.drawing",
          content: "saved renderer surface",
          expectedRevision: revisionOf(Buffer.from("renderer surface content", "utf8")),
        },
      ]);
      expect(await fs.readFile(path.join(vaultPath, "Canvas.drawing"), "utf8")).toBe(
        "saved renderer surface",
      );

      await service.handle(request("close-view"));
      await service.handle(
        request("open-view", { viewType: "renderer-view", filePath: "Canvas.drawing" }),
      );
      expect(dom.window.document.querySelector(".view-content")?.textContent).toBe(
        "saved renderer surface",
      );

      const created = await service.handle(
        request("run-command", { commandId: "renderer-fixture:renderer-create" }),
      );
      expect(created?.pluginSurface).toEqual({
        displayText: "New",
        filePath: "Drawings/New.drawing",
        viewType: "renderer-view",
      });
      expect(createdFolders).toEqual(["Drawings"]);
      expect(createdFiles).toEqual(["Drawings/New.drawing"]);
      expect(await fs.readFile(path.join(vaultPath, "Drawings", "New.drawing"), "utf8")).toBe(
        "new drawing content",
      );

      await service.handle(
        request("run-command", { commandId: "renderer-fixture:renderer-binary" }),
      );
      expect(binaryCreates).toHaveLength(1);
      expect(new Uint8Array(binaryCreates[0]?.content ?? new ArrayBuffer(0))).toEqual(
        Uint8Array.from([137, 80, 78, 71, 0, 255]),
      );
      expect(binaryWrites).toHaveLength(1);
      expect(binaryWrites[0]?.expectedRevision).toBe(
        revisionOf(Uint8Array.from([137, 80, 78, 71, 0, 255])),
      );
      expect(binaryRenames).toEqual([
        {
          vaultPath,
          sourcePath: "Binary/Preview.png",
          targetPath: "Binary/Renamed.png",
          expectedRevision: revisionOf(Uint8Array.from([137, 80, 78, 71, 1, 2, 3, 0, 255])),
        },
      ]);
      expect(binaryTrashes).toEqual([
        {
          vaultPath,
          filePath: "Binary/Renamed.png",
          expectedRevision: revisionOf(Uint8Array.from([137, 80, 78, 71, 1, 2, 3, 0, 255])),
        },
      ]);
      await expect(
        fs.readFile(path.join(vaultPath, "Binary", "Preview.png")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        fs.readFile(path.join(vaultPath, "Binary", "Renamed.png")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        fs.readFile(path.join(vaultPath, ".trash", "Binary", "Renamed.png")),
      ).resolves.toEqual(Buffer.from([137, 80, 78, 71, 1, 2, 3, 0, 255]));

      const ready = await service.handle(request("mark-layout-ready"));
      expect(ready?.notices).toContain("Renderer layout ready.");

      const closed = await service.handle(request("close-view"));
      expect(closed?.pluginSurface).toBeNull();
      expect(dom.window.document.querySelector("#threadleaf-plugin-surface")).toBeNull();

      const ran = await service.handle(
        request("run-command", { commandId: "renderer-fixture:renderer-command" }),
      );
      expect(ran?.notices).toContain("Renderer command ran.");
      expect(ran?.plugin?.compatibilityLevel).toBe(3);

      await service.handle(request("open-settings", { pluginId: "renderer-fixture" }));
      const unloaded = await service.handle(request("unload-all"));
      expect(unloaded?.plugin?.state).toBe("unloaded");
      expect(unloaded?.pluginSurface).toBeNull();
      expect(unloaded?.commands).toEqual([]);
      expect(dom.window.document.querySelector("#threadleaf-plugin-surface")).toBeNull();
      expect(dom.window.eval('app.plugins.plugins["renderer-fixture"]')).toBeUndefined();

      await service.handle(request("close"));
      expect(Object.hasOwn(dom.window, "app")).toBe(false);
      expect(Object.hasOwn(dom.window, "moment")).toBe(false);
      await expect(service.handle(request("get-snapshot"))).rejects.toThrow(
        "has not been initialized",
      );
    } finally {
      dom.window.close();
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });

  it("waits for fire-and-forget binary writes and preserves conflict copies", async () => {
    const sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-renderer-barrier-"));
    const vaultPath = path.join(sandboxPath, "vault");
    const filePath = "Exports/Drawing.png";
    const absoluteFilePath = path.join(vaultPath, filePath);
    const initialBytes = Uint8Array.from([137, 80, 78, 71, 0, 1]);
    const updatedBytes = Uint8Array.from([137, 80, 78, 71, 2, 3, 4]);
    const conflictBytes = Uint8Array.from([137, 80, 78, 71, 5, 6, 7]);
    const conflictPath = "Exports/Drawing.threadleaf-conflict.png";
    const dom = new JSDOM("<!doctype html><body></body>", {
      url: "https://threadleaf.invalid/",
    });
    installObsidianDomCompatibility(dom.window);
    exposeDom(dom);
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let writeStarted!: () => void;
    const writeStartedSignal = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    let writeMode: "delayed" | "conflict" = "delayed";
    const service = new PluginRendererService({
      createFolder: async ({ folderPath }) => ({ path: folderPath, created: false }),
      createText: async () => {
        throw new Error("The barrier fixture does not create text files.");
      },
      writeText: async () => {
        throw new Error("The barrier fixture does not write text files.");
      },
      writeBinary: async ({
        content,
        expectedRevision,
        filePath: requestedPath,
        vaultPath: root,
      }) => {
        const bytes = new Uint8Array(content);
        if (writeMode === "delayed") {
          writeStarted();
          await writeGate;
          await fs.writeFile(path.join(root, requestedPath), bytes);
          writeMode = "conflict";
          return {
            status: "committed" as const,
            path: requestedPath,
            revision: revisionOf(bytes),
            transactionId: "barrier-write",
          };
        }
        await fs.writeFile(path.join(root, conflictPath), bytes);
        return {
          status: "conflict" as const,
          path: requestedPath,
          currentRevision: expectedRevision,
          conflictPath,
          transactionId: "barrier-conflict",
        };
      },
    });
    try {
      await fs.mkdir(path.dirname(absoluteFilePath), { recursive: true });
      await fs.writeFile(absoluteFilePath, initialBytes);
      await service.handle(
        request("initialize", {
          vaultPath,
          packageJsonPath: path.resolve("package.json"),
        }),
      );
      const app = (globalThis as unknown as { app: { vault: Vault } }).app;
      const file = app.vault.getFileByPath(filePath);
      if (!file) {
        throw new Error("Barrier fixture file was not discovered.");
      }
      await app.vault.readBinary(file);
      const mutation = app.vault.modifyBinary(file, updatedBytes.buffer);
      await writeStartedSignal;
      const barrier = service.handle(request("wait-for-mutations", { quietMs: 1, timeoutMs: 250 }));
      await expect(
        Promise.race([barrier.then(() => "settled"), Promise.resolve("pending")]),
      ).resolves.toBe("pending");
      releaseWrite();
      await mutation;
      const completed = await barrier;
      if (!completed) {
        throw new Error("Mutation barrier returned no renderer snapshot.");
      }
      expect(completed.vault?.path).toBe(await fs.realpath(vaultPath));
      await expect(fs.readFile(absoluteFilePath)).resolves.toEqual(Buffer.from(updatedBytes));

      await expect(app.vault.modifyBinary(file, conflictBytes.buffer)).rejects.toThrow(
        conflictPath,
      );
      await expect(fs.readFile(absoluteFilePath)).resolves.toEqual(Buffer.from(updatedBytes));
      await expect(fs.readFile(path.join(vaultPath, conflictPath))).resolves.toEqual(
        Buffer.from(conflictBytes),
      );
    } finally {
      releaseWrite();
      await service.close();
      dom.window.close();
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });
});
