import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { revisionOf } from "../kernel/durability";
import { installObsidianDomCompatibility } from "../runtime/obsidian-dom";
import type {
  PluginRendererRequest,
  PluginVaultWriteRequest,
} from "../shared/plugin-runtime-protocol";
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
        `const { MarkdownRenderer, Notice, Plugin, TextFileView, WorkspaceSplit, moment } = require("obsidian");
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
    this.registerView("renderer-view", (leaf) => new RendererView(leaf));
    this.registerExtensions(["drawing"], "renderer-view");
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
      const createdFolders: string[] = [];
      const createdFiles: string[] = [];
      const service = new PluginRendererService({
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
      expect(initialized?.vault.path).toBe(path.resolve(vaultPath));
      expect(dom.window.eval("app.vault.getName()")).toBe("vault");
      expect(dom.window.eval("typeof moment")).toBe("function");

      const loaded = await service.handle(request("load-plugin", { pluginDirectory: pluginPath }));
      expect(loaded?.plugin).toMatchObject({
        id: "renderer-fixture",
        state: "loaded",
        compatibilityLevel: 3,
      });
      expect(loaded?.actions.map(({ id }) => id)).toEqual(["renderer-create", "renderer-command"]);
      expect(loaded?.integrations).toMatchObject({
        extensions: [{ extension: "drawing", viewType: "renderer-view" }],
        viewTypes: ["renderer-view"],
      });
      expect(dom.window.eval('app.plugins.plugins["renderer-fixture"].manifest.id')).toBe(
        "renderer-fixture",
      );

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
        request("run-command", { commandId: "renderer-create" }),
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

      const ready = await service.handle(request("mark-layout-ready"));
      expect(ready?.notices).toContain("Renderer layout ready.");

      const closed = await service.handle(request("close-view"));
      expect(closed?.pluginSurface).toBeNull();
      expect(dom.window.document.querySelector("#threadleaf-plugin-surface")).toBeNull();

      const ran = await service.handle(request("run-command", { commandId: "renderer-command" }));
      expect(ran?.notices).toContain("Renderer command ran.");
      expect(ran?.plugin?.compatibilityLevel).toBe(4);

      const unloaded = await service.handle(request("unload-all"));
      expect(unloaded?.plugin?.state).toBe("unloaded");
      expect(unloaded?.commands).toEqual([]);
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
});
