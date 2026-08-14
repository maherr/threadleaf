import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { App, type Command, CommandRegistry, NoticeBus, Plugin, Vault } from "./obsidian-compat";
import { Scope } from "./obsidian-ui-compat";

const fixtureVault = path.resolve("fixtures/vaults/basic");

function createApp(): App {
  return new App(new Vault(fixtureVault), new CommandRegistry(), new NoticeBus(() => undefined));
}

function scopeStack(app: App): Scope[] {
  return (app.keymap as unknown as { scopeStack: Scope[] }).scopeStack;
}

describe("Obsidian command registry compatibility", () => {
  it("exposes commands as an ID-keyed record with complete consumer-facing definitions", () => {
    const registry = new CommandRegistry();
    const callback = vi.fn();
    const first: Command & { icon: string } = {
      id: "fixture:first",
      name: "First command",
      icon: "leaf",
      callback,
    };
    const second: Command = {
      id: "fixture:second",
      name: "Second command",
      checkCallback: () => true,
    };

    registry.register("fixture", first);
    registry.register("fixture", second);

    expect(Object.keys(registry.commands)).toEqual(["fixture:first", "fixture:second"]);
    expect(registry.commands["fixture:first"]).toEqual(first);
    expect(registry.commands["fixture:second"]).toEqual(second);
    expect(registry.commands["fixture:missing"]).toBeUndefined();
    expect(registry.commands["fixture:first"]).not.toHaveProperty("ownerId");
    expect(registry.commands["fixture:first"]).not.toHaveProperty("releaseAction");
  });

  it("executeCommandById returns a synchronous availability result and runs enabled commands", () => {
    const registry = new CommandRegistry();
    const callback = vi.fn();
    registry.register("fixture", {
      id: "fixture:run",
      name: "Run command",
      callback,
    });

    expect(registry.executeCommandById("fixture:missing")).toBe(false);
    expect(registry.executeCommandById("fixture:run")).toBe(true);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("executeCommandById checks dynamic availability before invoking a check callback", () => {
    const registry = new CommandRegistry();
    const calls: boolean[] = [];
    let enabled = false;
    registry.register("fixture", {
      id: "fixture:conditional",
      name: "Conditional command",
      checkCallback: (checking) => {
        calls.push(checking);
        return enabled;
      },
    });

    expect(registry.executeCommandById("fixture:conditional")).toBe(false);
    expect(calls).toEqual([true]);

    enabled = true;
    expect(registry.executeCommandById("fixture:conditional")).toBe(true);
    expect(calls).toEqual([true, true, false]);
  });

  it("gives checkCallback precedence over callback for availability and execution", async () => {
    const registry = new CommandRegistry();
    const callback = vi.fn();
    const calls: boolean[] = [];
    let enabled = false;
    registry.register("fixture", {
      id: "fixture:both-callbacks",
      name: "Both callbacks",
      callback,
      checkCallback: (checking) => {
        calls.push(checking);
        return enabled;
      },
    });

    expect(registry.executeCommandById("fixture:both-callbacks")).toBe(false);
    expect(await registry.canRun("fixture:both-callbacks")).toBe(false);
    expect(calls).toEqual([true, true]);
    expect(callback).not.toHaveBeenCalled();

    enabled = true;
    expect(registry.executeCommandById("fixture:both-callbacks")).toBe(true);
    expect(calls).toEqual([true, true, true, false]);
    expect(callback).not.toHaveBeenCalled();
  });

  it("keeps same-owner replacements current and rejects a duplicate ID from another owner", () => {
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
    expect(replacement).toHaveBeenCalledTimes(1);
    expect(() =>
      registry.register("another-plugin", {
        id: "fixture:replace",
        name: "Foreign duplicate",
        callback: vi.fn(),
      }),
    ).toThrow("Command already registered: fixture:replace");
  });

  it("removeCommand retires the current command and remains safe across replacement and unload", async () => {
    const app = createApp();
    const plugin = new Plugin(app, {
      id: "dynamic-command-fixture",
      name: "Dynamic command fixture",
      version: "0.1.0",
    });
    const first = vi.fn();
    const second = vi.fn();

    plugin.addCommand({ id: "dynamic-toggle", name: "First toggle", callback: first });
    app.commands.removeCommand("dynamic-toggle");
    expect(app.commands.executeCommandById("dynamic-toggle")).toBe(false);
    expect(app.commands.commands["dynamic-toggle"]).toBeUndefined();
    expect(app.commands.list()).toEqual([]);
    expect(app.commands.actions.list("plugin")).toEqual([]);

    plugin.addCommand({ id: "dynamic-toggle", name: "Second toggle", callback: second });
    expect(app.commands.executeCommandById("dynamic-toggle")).toBe(true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    expect(() => app.commands.removeCommand("missing-command")).not.toThrow();
    app.commands.removeCommand("dynamic-toggle");
    app.commands.removeCommand("dynamic-toggle");
    await plugin.__unload();

    expect(app.commands.executeCommandById("dynamic-toggle")).toBe(false);
    expect(app.commands.commands["dynamic-toggle"]).toBeUndefined();
    expect(app.commands.actions.list("plugin")).toEqual([]);
  });
});

describe("Obsidian keymap scope stack compatibility", () => {
  it("pushScope keeps scopes in activation order, including balanced duplicate pushes", () => {
    const app = createApp();
    const first = new Scope();
    const second = new Scope(first);

    app.keymap.pushScope(first);
    app.keymap.pushScope(second);
    app.keymap.pushScope(first);

    expect(scopeStack(app)).toEqual([first, second, first]);
  });

  it("popScope removes the most recent matching scope without disturbing the remaining order", () => {
    const app = createApp();
    const first = new Scope();
    const second = new Scope(first);
    const third = new Scope(second);

    app.keymap.pushScope(first);
    app.keymap.pushScope(second);
    app.keymap.pushScope(third);
    app.keymap.pushScope(second);

    app.keymap.popScope(second);
    expect(scopeStack(app)).toEqual([first, second, third]);
    app.keymap.popScope(second);
    expect(scopeStack(app)).toEqual([first, third]);
    app.keymap.popScope(third);
    expect(scopeStack(app)).toEqual([first]);

    expect(() => app.keymap.popScope(second)).not.toThrow();
    expect(scopeStack(app)).toEqual([first]);
  });
});
