import path from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import {
  App,
  type Command,
  CommandRegistry,
  Keymap,
  NoticeBus,
  Plugin,
  Vault,
} from "./obsidian-compat";
import { MarkdownView, Scope, WorkspaceLeaf } from "./obsidian-ui-compat";

const fixtureVault = path.resolve("fixtures/vaults/basic");

function createApp(): App {
  return new App(new Vault(fixtureVault), new CommandRegistry(), new NoticeBus(() => undefined));
}

function installDom(): { dom: JSDOM; restore(): void } {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://threadleaf.invalid/",
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
  });
  return {
    dom,
    restore: () => {
      if (previousWindow === undefined) {
        Reflect.deleteProperty(globalThis, "window");
      } else {
        Object.defineProperty(globalThis, "window", {
          configurable: true,
          value: previousWindow,
        });
      }
      if (previousDocument === undefined) {
        Reflect.deleteProperty(globalThis, "document");
      } else {
        Object.defineProperty(globalThis, "document", {
          configurable: true,
          value: previousDocument,
        });
      }
      dom.window.close();
    },
  };
}

function modEventInit(extra: KeyboardEventInit = {}): KeyboardEventInit {
  return {
    bubbles: true,
    cancelable: true,
    ctrlKey: process.platform !== "darwin",
    metaKey: process.platform === "darwin",
    ...extra,
  };
}

describe("Obsidian command registry compatibility", () => {
  // Public Command callback precedence and hotkeys:
  // https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts#L1632-L1759
  it("exposes one stable live command record that controls execution", () => {
    const registry = new CommandRegistry();
    const original = vi.fn();
    const replacement = vi.fn();
    const replacedRecordCallback = vi.fn();
    const command: Command = {
      id: "fixture:mutable",
      name: "Mutable command",
      callback: original,
    };
    const release = registry.register("fixture", command);

    const commands = registry.commands;
    expect(registry.commands).toBe(commands);
    expect(commands[command.id]).toBe(command);

    const registered = commands[command.id];
    expect(registered).toBeDefined();
    if (!registered) throw new Error("Expected registered command.");
    registered.callback = replacement;
    expect(registry.executeCommandById(command.id)).toBe(true);
    expect(replacement).toHaveBeenCalledOnce();
    expect(original).not.toHaveBeenCalled();

    commands[command.id] = { ...registered, callback: replacedRecordCallback };
    expect(registry.executeCommandById(command.id)).toBe(true);
    expect(replacedRecordCallback).toHaveBeenCalledOnce();

    Reflect.deleteProperty(commands, command.id);
    expect(registry.executeCommandById(command.id)).toBe(false);
    expect(registry.list()).toEqual([]);
    release();
    expect(commands[command.id]).toBeUndefined();
  });

  it("returns the action-stage result without a speculative checking pass", async () => {
    const registry = new CommandRegistry();
    const calls: boolean[] = [];
    registry.register("fixture", {
      id: "fixture:execute-check",
      name: "Execution check",
      checkCallback: (checking) => {
        calls.push(checking);
        return checking;
      },
    });

    expect(registry.executeCommandById("fixture:execute-check")).toBe(false);
    expect(calls).toEqual([false]);
    expect(await registry.canRun("fixture:execute-check")).toBe(true);
    expect(calls).toEqual([false, true]);
  });

  it("propagates callback false and synchronous errors while accepting async invocation", async () => {
    const registry = new CommandRegistry();
    let asyncRan = false;
    registry.register("fixture", {
      id: "fixture:false",
      name: "False callback",
      callback: () => false,
    });
    registry.register("fixture", {
      id: "fixture:error",
      name: "Throwing callback",
      callback: () => {
        throw new Error("callback failed");
      },
    });
    registry.register("fixture", {
      id: "fixture:async",
      name: "Async callback",
      callback: async () => {
        await Promise.resolve();
        asyncRan = true;
      },
    });

    expect(registry.executeCommandById("fixture:false")).toBe(false);
    expect(() => registry.executeCommandById("fixture:error")).toThrow("callback failed");
    expect(registry.executeCommandById("fixture:async")).toBe(true);
    await Promise.resolve();
    expect(asyncRan).toBe(true);
  });

  it("uses editorCheckCallback then editorCallback before global callbacks in an editor", async () => {
    const { restore } = installDom();
    let leaf: WorkspaceLeaf | null = null;
    try {
      const app = createApp();
      leaf = new WorkspaceLeaf(app, document.createElement("div"));
      await leaf.setViewState({ type: "markdown", state: { file: "Welcome.md" } });
      expect(leaf.view).toBeInstanceOf(MarkdownView);
      const view = leaf.view as MarkdownView;
      const editorChecks: boolean[] = [];
      const editorCallback = vi.fn();
      const checkCallback = vi.fn(() => true);
      const callback = vi.fn();
      app.commands.register("fixture", {
        id: "fixture:editor-priority",
        name: "Editor priority",
        editorCheckCallback: (checking, editor, context) => {
          editorChecks.push(checking);
          expect(editor).toBe(view.editor);
          expect(context).toBe(view);
          return true;
        },
        editorCallback,
        checkCallback,
        callback,
      });

      expect(await app.commands.canRun("fixture:editor-priority")).toBe(true);
      expect(app.commands.executeCommandById("fixture:editor-priority")).toBe(true);
      expect(editorChecks).toEqual([true, false]);
      expect(editorCallback).not.toHaveBeenCalled();
      expect(checkCallback).not.toHaveBeenCalled();
      expect(callback).not.toHaveBeenCalled();

      const registered = app.commands.commands["fixture:editor-priority"];
      expect(registered).toBeDefined();
      if (!registered) throw new Error("Expected registered editor command.");
      Reflect.deleteProperty(registered, "editorCheckCallback");
      expect(app.commands.executeCommandById("fixture:editor-priority")).toBe(true);
      expect(editorCallback).toHaveBeenCalledWith(view.editor, view);

      Reflect.deleteProperty(registered, "editorCallback");
      expect(app.commands.executeCommandById("fixture:editor-priority")).toBe(true);
      expect(checkCallback).toHaveBeenCalledWith(false);
      expect(callback).not.toHaveBeenCalled();
    } finally {
      await leaf?.detach();
      restore();
    }
  });

  it("keeps same-owner replacements current and rejects foreign duplicate IDs", () => {
    const registry = new CommandRegistry();
    const first = vi.fn();
    const replacement = vi.fn();
    const releaseFirst = registry.register("fixture", {
      id: "fixture:replace",
      name: "Original command",
      callback: first,
    });

    registry.register("fixture", {
      id: "fixture:replace",
      name: "Replacement command",
      callback: replacement,
    });
    releaseFirst();
    expect(registry.commands["fixture:replace"]?.name).toBe("Replacement command");
    expect(registry.executeCommandById("fixture:replace")).toBe(true);
    expect(first).not.toHaveBeenCalled();
    expect(replacement).toHaveBeenCalledOnce();
    expect(() =>
      registry.register("another-plugin", {
        id: "fixture:replace",
        name: "Foreign duplicate",
        callback: vi.fn(),
      }),
    ).toThrow("Command already registered: fixture:replace");
  });

  // Public Plugin ownership and prefixing contract:
  // https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts#L4741-L4754
  it("prefixes plugin commands and removes them through the owning Plugin", async () => {
    const app = createApp();
    const plugin = new Plugin(app, {
      id: "fixture-plugin",
      name: "Fixture Plugin",
      version: "0.1.0",
    });
    const first = vi.fn();
    const second = vi.fn();
    const command = plugin.addCommand({
      id: "local-action",
      name: "Local action",
      callback: first,
    });

    expect(command).toMatchObject({
      id: "fixture-plugin:local-action",
      name: "Fixture Plugin: Local action",
    });
    expect(app.commands.commands[command.id]).toBe(command);
    expect(app.commands.commands["local-action"]).toBeUndefined();
    expect(app.commands.executeCommandById(command.id)).toBe(true);
    expect(first).toHaveBeenCalledOnce();

    plugin.removeCommand("local-action");
    plugin.removeCommand("local-action");
    expect(app.commands.executeCommandById(command.id)).toBe(false);
    expect(app.commands.actions.list("plugin")).toEqual([]);

    const replacement = plugin.addCommand({
      id: "local-action",
      name: "Replacement action",
      callback: second,
    });
    expect(app.commands.executeCommandById(replacement.id)).toBe(true);
    expect(second).toHaveBeenCalledOnce();
    await plugin.__unload();
    expect(app.commands.commands[replacement.id]).toBeUndefined();
    expect(app.commands.actions.list("plugin")).toEqual([]);
  });
});

describe("Obsidian keymap and scope compatibility", () => {
  // Public Keymap and Scope contracts:
  // https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts#L3477-L3537
  // https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts#L5293-L5315
  it("dispatches to the active scope, then restores the previous receiver after popScope", () => {
    const { dom, restore } = installDom();
    try {
      const app = createApp();
      const root = app.scope;
      const modal = new Scope(root);
      const rootHandler = vi.fn(() => false as const);
      const modalHandler = vi.fn(() => false as const);
      root.register(["Mod"], "k", rootHandler);
      modal.register(["Mod"], "k", modalHandler);

      app.keymap.pushScope(modal);
      app.keymap.pushScope(modal);
      const modalEvent = new dom.window.KeyboardEvent("keydown", {
        key: "k",
        ...modEventInit(),
      });
      dom.window.document.dispatchEvent(modalEvent);
      expect(modalHandler).toHaveBeenCalledOnce();
      expect(rootHandler).not.toHaveBeenCalled();
      expect(modalEvent.defaultPrevented).toBe(true);

      app.keymap.popScope(modal);
      dom.window.document.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key: "k", ...modEventInit() }),
      );
      expect(modalHandler).toHaveBeenCalledTimes(2);
      expect(rootHandler).not.toHaveBeenCalled();

      app.keymap.popScope(modal);
      const rootEvent = new dom.window.KeyboardEvent("keydown", {
        key: "k",
        ...modEventInit(),
      });
      dom.window.document.dispatchEvent(rootEvent);
      expect(rootHandler).toHaveBeenCalledOnce();
      expect(rootEvent.defaultPrevented).toBe(true);
    } finally {
      restore();
    }
  });

  it("consults parent scopes, supports wildcards, and unregisters by handler identity", () => {
    const { dom, restore } = installDom();
    try {
      const app = createApp();
      const parent = new Scope();
      const child = new Scope(parent);
      const parentHandler = vi.fn(() => true);
      const wildcard = vi.fn(() => true);
      parent.register(["Alt"], "x", parentHandler);
      const registration = child.register(null, null, wildcard);
      expect(registration).toMatchObject({
        scope: child,
        modifiers: null,
        key: null,
      });

      app.keymap.pushScope(child);
      dom.window.document.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { altKey: true, bubbles: true, key: "z" }),
      );
      expect(wildcard).toHaveBeenCalledOnce();
      expect(parentHandler).not.toHaveBeenCalled();

      child.unregister(registration);
      dom.window.document.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { altKey: true, bubbles: true, key: "x" }),
      );
      expect(wildcard).toHaveBeenCalledOnce();
      expect(parentHandler).toHaveBeenCalledOnce();
    } finally {
      restore();
    }
  });

  it("registers command hotkeys, looks up live commands, resolves collisions, and cleans up", async () => {
    const { dom, restore } = installDom();
    try {
      const app = createApp();
      expect(app.scope).toBe(app.keymap.getRootScope());
      const first = new Plugin(app, { id: "first", name: "First", version: "0.1.0" });
      const second = new Plugin(app, { id: "second", name: "Second", version: "0.1.0" });
      const firstCallback = vi.fn();
      const secondCallback = vi.fn();
      const liveSecondCallback = vi.fn();
      first.addCommand({
        id: "run",
        name: "Run",
        callback: firstCallback,
        hotkeys: [{ modifiers: ["Mod"], key: "k" }],
      });
      const secondCommand = second.addCommand({
        id: "run",
        name: "Run",
        callback: secondCallback,
        hotkeys: [{ modifiers: ["Mod"], key: "k" }],
      });
      const liveSecondCommand = app.commands.commands[secondCommand.id];
      if (!liveSecondCommand) throw new Error("Expected the qualified hotkey command to be live.");
      liveSecondCommand.callback = liveSecondCallback;

      const collisionEvent = new dom.window.KeyboardEvent("keydown", {
        key: "k",
        ...modEventInit(),
      });
      dom.window.document.dispatchEvent(collisionEvent);
      expect(liveSecondCallback).toHaveBeenCalledOnce();
      expect(secondCallback).not.toHaveBeenCalled();
      expect(firstCallback).not.toHaveBeenCalled();
      expect(collisionEvent.defaultPrevented).toBe(true);

      second.removeCommand("run");
      dom.window.document.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key: "k", ...modEventInit() }),
      );
      expect(firstCallback).toHaveBeenCalledOnce();

      dom.window.document.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "k",
          ...modEventInit({ repeat: true }),
        }),
      );
      expect(firstCallback).toHaveBeenCalledOnce();

      await first.__unload();
      dom.window.document.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key: "k", ...modEventInit() }),
      );
      expect(firstCallback).toHaveBeenCalledOnce();
      expect(app.commands.commands["first:run"]).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("implements modifier and Mod-event helpers", () => {
    const { dom, restore } = installDom();
    try {
      const modEvent = new dom.window.KeyboardEvent("keydown", modEventInit({ key: "k" }));
      const splitEvent = new dom.window.KeyboardEvent(
        "keydown",
        modEventInit({ altKey: true, key: "k" }),
      );
      const windowEvent = new dom.window.KeyboardEvent(
        "keydown",
        modEventInit({ altKey: true, key: "k", shiftKey: true }),
      );
      expect(Keymap.isModifier(modEvent, "Mod")).toBe(true);
      expect(Keymap.isModEvent(modEvent)).toBe("tab");
      expect(Keymap.isModEvent(splitEvent)).toBe("split");
      expect(Keymap.isModEvent(windowEvent)).toBe("window");
      expect(Keymap.isModEvent(new dom.window.KeyboardEvent("keydown", { key: "k" }))).toBe(false);
      expect(Keymap.isModEvent(new dom.window.MouseEvent("mousedown", { button: 1 }))).toBe("tab");
      expect(Keymap.isModEvent(null)).toBe(false);
    } finally {
      restore();
    }
  });
});
