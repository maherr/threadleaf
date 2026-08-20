import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { App, CommandRegistry, NoticeBus, Vault } from "./obsidian-compat";
import { Menu } from "./obsidian-menu-compat";
import { ItemView, MarkdownView, WorkspaceLeaf } from "./obsidian-ui-compat";
import { CompatibilityIntegrationRegistry, Workspace } from "./obsidian-workspace-compat";

describe("Obsidian compatibility workspace lifecycle", () => {
  it("orders editor extensions by active plugin and then registration sequence", () => {
    const compatibility = new CompatibilityIntegrationRegistry();
    const firstA = { id: "first-a" };
    const firstB = { id: "first-b" };
    const second = { id: "second" };
    compatibility.registerEditorExtension("first", firstA);
    compatibility.registerEditorExtension("second", second);
    compatibility.registerEditorExtension("first", firstB);

    compatibility.setEditorExtensionOwnerOrder(["first", "second"]);
    expect(compatibility.getEditorExtensions()).toEqual([firstA, firstB, second]);
    compatibility.setEditorExtensionOwnerOrder(["second", "first"]);
    expect(compatibility.getEditorExtensions()).toEqual([second, firstA, firstB]);
  });

  it("tracks Templater editor extensions while withholding incompatible native delivery", () => {
    const compatibility = new CompatibilityIntegrationRegistry();
    const templater = { id: "templater" };
    const iconize = { id: "iconize" };
    const ordinary = { id: "ordinary" };

    compatibility.registerEditorExtension("templater-obsidian", templater);
    compatibility.registerEditorExtension("obsidian-icon-folder", iconize);
    compatibility.registerEditorExtension("ordinary-plugin", ordinary);

    expect(compatibility.getEditorExtensions()).toEqual([ordinary]);
    expect(compatibility.hasUnavailableEditorExtensions("templater-obsidian")).toBe(true);
    expect(compatibility.hasUnavailableEditorExtensions("obsidian-icon-folder")).toBe(true);
    expect(compatibility.hasUnavailableEditorExtensions("ordinary-plugin")).toBe(false);
  });

  it("dispatches startup callbacks and immediately runs callbacks registered after readiness", async () => {
    const workspace = new Workspace();
    const events: string[] = [];
    workspace.onLayoutReady(() => {
      events.push("initial");
    });

    await workspace.markLayoutReady();
    expect(events).toEqual(["initial"]);

    workspace.onLayoutReady(() => {
      events.push("late");
    });

    expect(events).toEqual(["initial", "late"]);
  });

  it("does not let a never-settling callback block layout readiness or healthy callbacks", async () => {
    const workspace = new Workspace();
    const events: string[] = [];
    workspace.onLayoutReady(async () => {
      events.push("first-started");
      await new Promise(() => undefined);
    });
    workspace.onLayoutReady(() => {
      events.push("second-started");
    });

    await Promise.race([
      workspace.markLayoutReady(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("layout readiness remained pending")), 50),
      ),
    ]);

    expect(events).toEqual(["first-started", "second-started"]);
  });

  it("exposes the debounced layout signal and explicit unsupported layout boundaries", async () => {
    const workspace = new Workspace();
    const events: string[] = [];
    workspace.on("layout-change", () => events.push("layout-change"));

    workspace.requestSaveLayout();
    workspace.requestSaveLayout.run();
    expect(events).toEqual(["layout-change"]);
    await expect(workspace.changeLayout({})).rejects.toThrow(
      "Workspace layout replacement is not supported",
    );
    expect(() => workspace.openPopoutLeaf()).toThrow("Workspace popout windows are not supported");
    expect(() => workspace.moveLeafToPopout({} as WorkspaceLeaf)).toThrow(
      "Workspace popout windows are not supported",
    );
  });

  it("treats absent and already-released workspace event references as no-ops", () => {
    const workspace = new Workspace();
    let calls = 0;
    const eventRef = workspace.on("layout-change", () => {
      calls += 1;
    });

    expect(() => workspace.offref(undefined)).not.toThrow();
    workspace.offref(eventRef);
    expect(() => workspace.offref(eventRef)).not.toThrow();
    workspace.trigger("layout-change");
    expect(calls).toBe(0);
  });

  it("reports synchronous and asynchronous callback failures without poisoning readiness", async () => {
    const workspace = new Workspace();
    const failures: string[] = [];
    workspace.setLayoutReadyErrorHandler((error) => {
      failures.push(error instanceof Error ? error.message : String(error));
    });
    workspace.onLayoutReady(() => {
      throw new Error("synchronous fixture failure");
    });
    workspace.onLayoutReady(async () => {
      throw new Error("asynchronous fixture failure");
    });

    await expect(workspace.markLayoutReady()).resolves.toBeUndefined();
    await Promise.resolve();

    let lateCallbackRan = false;
    workspace.onLayoutReady(() => {
      lateCallbackRan = true;
    });
    expect(lateCallbackRan).toBe(true);
    expect(failures).toEqual(["synchronous fixture failure", "asynchronous fixture failure"]);
  });

  it("defers callbacks registered during dispatch without extending readiness", async () => {
    const workspace = new Workspace();
    const events: string[] = [];
    workspace.onLayoutReady(() => {
      events.push("outer");
      workspace.onLayoutReady(async () => {
        events.push("nested");
        await new Promise(() => undefined);
      });
    });

    await Promise.race([
      workspace.markLayoutReady(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("nested callback extended readiness")), 50),
      ),
    ]);
    expect(events).toEqual(["outer", "nested"]);
  });

  it("detaches every leaf of one view type without touching other views", () => {
    const workspace = new Workspace();
    const detached: string[] = [];
    const createLeaf = (id: string, viewType: string) => {
      let release = () => {};
      const leaf = {
        app: null as unknown as App,
        containerEl: new EventTarget() as HTMLElement,
        getViewState: () => ({ state: {}, type: viewType }),
        id,
        openFile: async () => undefined,
        view: { getViewType: () => viewType },
        detach: () => {
          detached.push(id);
          release();
        },
      };
      release = workspace.registerLeaf(leaf as unknown as WorkspaceLeaf);
      return leaf;
    };
    createLeaf("drawing-one", "excalidraw");
    createLeaf("markdown", "markdown");
    createLeaf("drawing-two", "excalidraw");

    workspace.detachLeavesOfType("excalidraw");

    expect(detached).toEqual(["drawing-one", "drawing-two"]);
    expect(workspace.getLeavesOfType("excalidraw")).toEqual([]);
    expect(workspace.getLeavesOfType("markdown")).toHaveLength(1);
  });

  it("awaits view open, state, close, and component lifecycle hooks in order", async () => {
    const dom = new JSDOM("<!doctype html><body><main></main></body>", {
      url: "https://threadleaf.invalid/",
    });
    const previousDocument = globalThis.document;
    try {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: dom.window.document,
        writable: true,
      });
      const events: string[] = [];
      const workspace = new Workspace();
      const compatibility = new CompatibilityIntegrationRegistry();
      const app = { compatibility, workspace } as unknown as App;
      class LifecycleView extends ItemView {
        override getViewType(): string {
          return "lifecycle-fixture";
        }

        override getDisplayText(): string {
          return "Lifecycle fixture";
        }

        override onload(): void {
          events.push("component-load");
        }

        protected override async onOpen(): Promise<void> {
          await Promise.resolve();
          events.push("view-open");
          this.contentEl.textContent = "Opened";
        }

        override async setState(): Promise<void> {
          events.push("state");
        }

        protected override async onClose(): Promise<void> {
          await Promise.resolve();
          expect(this.containerEl.dataset.pluginAlive).toBe("true");
          events.push("view-close");
          delete this.containerEl.dataset.pluginAlive;
        }

        override onunload(): void {
          this.containerEl.dataset.pluginAlive = "true";
          events.push("component-unload");
        }
      }
      compatibility.registerView(
        "fixture-plugin",
        "lifecycle-fixture",
        (leaf) => new LifecycleView(leaf as WorkspaceLeaf),
      );
      const container = dom.window.document.querySelector<HTMLElement>("main");
      expect(container).not.toBeNull();
      if (!container) {
        return;
      }
      const leaf = new WorkspaceLeaf(app, container);

      await leaf.setViewState({ type: "lifecycle-fixture" });
      expect(events).toEqual(["component-load", "view-open", "state"]);
      expect(container.textContent).toContain("Opened");

      await leaf.detach();
      expect(events).toEqual([
        "component-load",
        "view-open",
        "state",
        "component-unload",
        "view-close",
      ]);
      expect(container.isConnected).toBe(false);
    } finally {
      if (previousDocument === undefined) {
        Reflect.deleteProperty(globalThis, "document");
      } else {
        Object.defineProperty(globalThis, "document", {
          configurable: true,
          value: previousDocument,
          writable: true,
        });
      }
      dom.window.close();
    }
  });

  /** @compatibility-test-id obsidian-runtime.workspace-link-context-menu.v1 */
  it("adds a working context-menu action for a resolvable internal link", async () => {
    const dom = new JSDOM("<!doctype html><body></body>", {
      url: "https://threadleaf.invalid/",
    });
    const previousDocument = globalThis.document;
    try {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: dom.window.document,
        writable: true,
      });
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-workspace-link-menu-"));
      await fs.mkdir(path.join(root, "Notes"), { recursive: true });
      await fs.writeFile(path.join(root, "Notes", "Source.md"), "source");
      await fs.writeFile(path.join(root, "Notes", "Target.md"), "target");
      try {
        const vault = new Vault(root);
        const app = new App(vault, new CommandRegistry(), new NoticeBus(() => undefined));
        app.workspace.setLeafFactory((containerEl) => new WorkspaceLeaf(app, containerEl));
        const source = vault.getFileByPath("Notes/Source.md");
        if (!source) throw new Error("Link-menu source fixture was not discovered.");
        const leaf = app.workspace.getLeaf(false);
        await leaf.openFile(source);

        const menu = new Menu();
        expect(
          app.workspace.handleLinkContextMenu(menu, "Target#Heading", "Notes/Source.md", leaf),
        ).toBe(true);
        expect(app.workspace.handleLinkContextMenu(new Menu(), "Missing", "Notes/Source.md")).toBe(
          false,
        );
        menu.showAtPosition({ x: 8, y: 8 }, dom.window.document);
        const action = dom.window.document.querySelector<HTMLButtonElement>(".menu-item");
        expect(action?.textContent).toContain("Open Target.md");
        action?.click();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(leaf.view).toBeInstanceOf(MarkdownView);
        expect((leaf.view as MarkdownView).file?.path).toBe("Notes/Target.md");
        expect(leaf.getViewState()).toMatchObject({ state: { subpath: "#Heading" } });
        expect(app.workspace.activeLeaf).toBe(leaf);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    } finally {
      if (previousDocument === undefined) {
        Reflect.deleteProperty(globalThis, "document");
      } else {
        Object.defineProperty(globalThis, "document", {
          configurable: true,
          value: previousDocument,
          writable: true,
        });
      }
      dom.window.close();
    }
  });

  /** @compatibility-test-id obsidian-runtime.workspace-leaf-open.v1 */
  it("opens a preconstructed view in its owning leaf and publishes its state", async () => {
    const dom = new JSDOM("<!doctype html><body><main></main></body>", {
      url: "https://threadleaf.invalid/",
    });
    const previousDocument = globalThis.document;
    try {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: dom.window.document,
        writable: true,
      });
      const workspace = new Workspace();
      const compatibility = new CompatibilityIntegrationRegistry();
      const app = { compatibility, workspace } as unknown as App;
      class OpenView extends ItemView {
        override getViewType(): string {
          return "open-fixture";
        }

        override getDisplayText(): string {
          return "Open fixture";
        }

        override getState(): Record<string, unknown> {
          return { opened: true };
        }
      }
      const container = dom.window.document.querySelector<HTMLElement>("main");
      expect(container).not.toBeNull();
      if (!container) {
        return;
      }
      const leaf = new WorkspaceLeaf(app, container);
      const view = new OpenView(leaf);

      await expect(leaf.open(view)).resolves.toBe(view);
      expect(leaf.view).toBe(view);
      expect(leaf.getViewState()).toEqual({
        type: "open-fixture",
        state: { opened: true },
      });
      expect(leaf.getDisplayText()).toBe("Open fixture");
      expect(leaf.getIcon()).toBe("document");
      expect(workspace.activeLeaf).toBe(leaf);

      await leaf.detach();
      expect(container.isConnected).toBe(false);
    } finally {
      if (previousDocument === undefined) {
        Reflect.deleteProperty(globalThis, "document");
      } else {
        Object.defineProperty(globalThis, "document", {
          configurable: true,
          value: previousDocument,
          writable: true,
        });
      }
      dom.window.close();
    }
  });

  it("still unloads and detaches a view when its close hook fails", async () => {
    const dom = new JSDOM("<!doctype html><body><main></main></body>", {
      url: "https://threadleaf.invalid/",
    });
    const previousDocument = globalThis.document;
    try {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: dom.window.document,
        writable: true,
      });
      const events: string[] = [];
      const workspace = new Workspace();
      const compatibility = new CompatibilityIntegrationRegistry();
      const app = { compatibility, workspace } as unknown as App;
      class FailingCloseView extends ItemView {
        override getViewType(): string {
          return "failing-close-fixture";
        }

        override getDisplayText(): string {
          return "Failing close fixture";
        }

        protected override async onClose(): Promise<void> {
          events.push("view-close");
          throw new Error("fixture close failure");
        }

        override onunload(): void {
          events.push("component-unload");
        }
      }
      compatibility.registerView(
        "fixture-plugin",
        "failing-close-fixture",
        (leaf) => new FailingCloseView(leaf as WorkspaceLeaf),
      );
      const container = dom.window.document.querySelector<HTMLElement>("main");
      expect(container).not.toBeNull();
      if (!container) {
        return;
      }
      const leaf = new WorkspaceLeaf(app, container);
      await leaf.setViewState({ type: "failing-close-fixture" });

      await expect(leaf.detach()).rejects.toThrow("fixture close failure");
      expect(events).toEqual(["component-unload", "view-close"]);
      expect(container.isConnected).toBe(false);
    } finally {
      if (previousDocument === undefined) {
        Reflect.deleteProperty(globalThis, "document");
      } else {
        Object.defineProperty(globalThis, "document", {
          configurable: true,
          value: previousDocument,
          writable: true,
        });
      }
      dom.window.close();
    }
  });
});
