import path from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { App, CommandRegistry, NoticeBus, Vault } from "./obsidian-compat";
import { installObsidianDomCompatibility } from "./obsidian-dom";

const fixtureVault = path.resolve("fixtures/vaults/basic");
const previousGlobals = new Map<string, PropertyDescriptor | undefined>();

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

  it("deduplicates starred as an alias of bookmarks without inventing a second capability", () => {
    const internalPlugins = createApp().internalPlugins;

    expect(internalPlugins.plugins.starred).toBe(internalPlugins.plugins.bookmarks);
    expect(internalPlugins.getPluginById("starred")).toBe(
      internalPlugins.getPluginById("bookmarks"),
    );
    expect(internalPlugins.getEnabledPluginById("starred")).toBeNull();
  });

  it("uses null for unknown and disabled enabled-plugin lookups", () => {
    const internalPlugins = createApp().internalPlugins;

    expect(internalPlugins.getPluginById("not-a-core-plugin")).toBeNull();
    expect(internalPlugins.getEnabledPluginById("not-a-core-plugin")).toBeNull();
    expect(internalPlugins.getEnabledPluginById("daily-notes")).toBeNull();
  });

  it("preserves the implemented canvas instance and direct views surface", () => {
    const dom = new JSDOM("<!doctype html><body></body>");
    installObsidianDomCompatibility(dom.window);
    exposeDom(dom);
    const app = createApp();
    const canvasEntry = app.internalPlugins.plugins.canvas;

    expect(canvasEntry.enabled).toBe(true);
    expect(canvasEntry._loaded).toBe(true);
    expect(app.internalPlugins.getPluginById("canvas")).toBe(canvasEntry);
    expect(app.internalPlugins.getEnabledPluginById("canvas")).toBe(canvasEntry.instance);
    expect(canvasEntry.views).toBe(canvasEntry.instance.views);

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
});
