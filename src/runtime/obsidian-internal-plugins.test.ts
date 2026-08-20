import path from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { App, CommandRegistry, NoticeBus, Vault } from "./obsidian-compat";
import { installObsidianDomCompatibility } from "./obsidian-dom";

const fixtureVault = path.resolve("fixtures/vaults/basic");
const previousGlobals = new Map<string, PropertyDescriptor | undefined>();

/*
 * Obsidian 1.13.7's public but unofficial typings define `getPluginById()` as
 * returning the registration wrapper and `getEnabledPluginById()` as returning
 * its instance. `views` is wrapper-only, while Canvas instance fields include
 * `app`, `defaultOn`, `plugin`, `createNewCanvasFile`, and `getNewFileParent`.
 * Sources:
 * https://raw.githubusercontent.com/obsidian-typings/obsidian-typings/refs/heads/release/obsidian-public/1.13.7/src/obsidian/internals/internal-plugins/InternalPlugins.d.ts
 * https://raw.githubusercontent.com/obsidian-typings/obsidian-typings/refs/heads/release/obsidian-public/1.13.7/src/obsidian/internals/internal-plugins/InternalPlugin.d.ts
 * https://raw.githubusercontent.com/obsidian-typings/obsidian-typings/refs/heads/release/obsidian-public/1.13.7/src/obsidian/internals/internal-plugins/canvas/CanvasPluginInstance.d.ts
 * https://raw.githubusercontent.com/obsidian-typings/obsidian-typings/refs/heads/release/obsidian-public/1.13.7/src/obsidian/internals/internal-plugins/InternalPluginNamePluginsMapping.d.ts
 */

function createApp(): App {
  return new App(new Vault(fixtureVault), new CommandRegistry(), new NoticeBus(() => undefined));
}

function exposeDom(dom: JSDOM): void {
  for (const [name, value] of Object.entries({
    DocumentFragment: dom.window.DocumentFragment,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
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

describe("internal plugin compatibility", () => {
  it.each(["daily-notes", "bookmarks", "file-explorer", "outline"] as const)(
    "exposes %s as an honest disabled entry",
    (pluginId) => {
      const internalPlugins = createApp().internalPlugins;
      const entry = internalPlugins.getPluginById(pluginId);

      expect(entry).toBe(internalPlugins.plugins[pluginId]);
      expect(entry).toEqual({ enabled: false });
      expect(entry && "instance" in entry).toBe(false);
      expect(internalPlugins.getEnabledPluginById(pluginId)).toBeNull();
    },
  );

  it("returns null for unknown core-plugin IDs, including starred", () => {
    const internalPlugins = createApp().internalPlugins;

    expect("starred" in internalPlugins.plugins).toBe(false);
    expect(internalPlugins.getPluginById("starred")).toBeNull();
    expect(internalPlugins.getEnabledPluginById("starred")).toBeNull();
    expect(internalPlugins.getPluginById("not-a-core-plugin")).toBeNull();
    expect(internalPlugins.getEnabledPluginById("not-a-core-plugin")).toBeNull();
  });

  it("projects Threadleaf daily-note settings through the enabled core-plugin facade", () => {
    const app = createApp();
    app.setDailyNoteOptions({
      folder: "Journal",
      format: "YYYY/MM/YYYY-MM-DD",
      template: "Templates/Daily.md",
    });

    expect(app.internalPlugins.getPluginById("daily-notes")).toEqual({
      enabled: true,
      instance: {
        options: {
          folder: "Journal",
          format: "YYYY/MM/YYYY-MM-DD",
          template: "Templates/Daily.md",
        },
      },
    });
    expect(app.internalPlugins.getEnabledPluginById("daily-notes")).toEqual({
      options: {
        folder: "Journal",
        format: "YYYY/MM/YYYY-MM-DD",
        template: "Templates/Daily.md",
      },
    });
  });

  it("keeps the direct Canvas view adapter out of the enabled-instance lookup", () => {
    const dom = new JSDOM("<!doctype html><body></body>");
    installObsidianDomCompatibility(dom.window);
    exposeDom(dom);
    const app = createApp();
    const canvasEntry = app.internalPlugins.plugins.canvas;

    expect(canvasEntry.enabled).toBe(false);
    expect(canvasEntry._loaded).toBe(true);
    expect(app.internalPlugins.getPluginById("canvas")).toBe(canvasEntry);
    expect("instance" in canvasEntry).toBe(false);
    expect(app.internalPlugins.getEnabledPluginById("canvas")).toBeNull();

    const file = app.vault.getFileByPath("Boards/Overview.canvas");
    expect(file).not.toBeNull();
    if (!file) {
      throw new Error("Canvas fixture is missing.");
    }
    const canvas = canvasEntry.views.canvas().canvas;
    const node = canvas.createFileNode({ file });
    dom.window.document.body.append(node.containerEl);
    expect(node.containerEl.isConnected).toBe(true);

    canvas.removeNode(node);
    expect(node.containerEl.isConnected).toBe(false);
    dom.window.close();
  });

  it("returns a backed instance, never its registration wrapper, through the enabled lookup", () => {
    const app = createApp();
    const canvasEntry = app.internalPlugins.plugins.canvas;
    const instance = {
      app,
      createNewCanvasFile: async () => undefined,
      defaultOn: true,
      getNewFileParent: () => app.vault.getRoot(),
      plugin: canvasEntry,
    };

    Object.assign(canvasEntry, { enabled: true, instance });

    const enabled = app.internalPlugins.getEnabledPluginById("canvas");
    expect(enabled).toBe(instance);
    expect(enabled).toMatchObject({ app, defaultOn: true, plugin: canvasEntry });
    expect(enabled).toHaveProperty("createNewCanvasFile", expect.any(Function));
    expect(enabled).toHaveProperty("getNewFileParent", expect.any(Function));
    expect(enabled).not.toHaveProperty("views");
    expect(canvasEntry).toHaveProperty("views", expect.any(Object));
  });

  it("returns null, never undefined, for an enabled entry whose instance is unbacked", () => {
    // getEnabledPluginById() promises an instance or null; a present-but-undefined
    // `instance` property must not leak `undefined` past a `result === null` check.
    const app = createApp();
    Object.assign(app.internalPlugins.plugins.canvas, {
      enabled: true,
      instance: undefined,
    });

    expect(app.internalPlugins.getEnabledPluginById("canvas")).toBeNull();
  });
});
