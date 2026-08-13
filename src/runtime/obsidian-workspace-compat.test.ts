import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import type { App } from "./obsidian-compat";
import { ItemView, WorkspaceLeaf } from "./obsidian-ui-compat";
import { CompatibilityIntegrationRegistry, Workspace } from "./obsidian-workspace-compat";

describe("Obsidian compatibility workspace lifecycle", () => {
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
        id,
        view: { getViewType: () => viewType },
        detach: () => {
          detached.push(id);
          release();
        },
      };
      release = workspace.registerLeaf(leaf);
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
