import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PluginEditorContext, PluginSummary, RuntimeSnapshot } from "../shared/contracts";
import { FatalPluginRuntimeError, type PluginRuntimePort } from "./plugin-runtime-port";
import { RecoveringPluginRuntime } from "./recovering-plugin-runtime";

const vault = {
  id: null,
  name: "vault",
  path: "/vault",
  markdownFileCount: 0,
  mode: "synthetic-read-only" as const,
  source: "direct" as const,
  warning: null,
};

function plugin(id: string, state: PluginSummary["state"] = "loaded"): PluginSummary {
  return {
    id,
    name: `${id} name`,
    version: "1.0.0",
    state,
    compatibilityLevel: state === "loaded" ? 3 : 0,
    stylesheetDiscovered: false,
    error: null,
  };
}

function snapshot(plugins: PluginSummary[] = [], selectedId?: string): RuntimeSnapshot {
  const selected = selectedId ? (plugins.find(({ id }) => id === selectedId) ?? null) : null;
  return {
    vault,
    plugin: selected,
    plugins,
    commands: plugins
      .filter(({ state }) => state === "loaded")
      .map(({ id }) => ({ id: `${id}-command`, name: `${id} command`, ownerId: id })),
    actions: [],
    notices: [],
    events: [],
    pluginSurface: null,
  };
}

class FakePluginRuntime implements PluginRuntimePort {
  fatalClose = false;
  readonly close = vi.fn(async () => {
    if (this.fatalClose) {
      throw new FatalPluginRuntimeError("close", "Timed out while closing.");
    }
  });
  readonly loaded = new Map<string, PluginSummary>();
  fatalLoadId: string | null = null;
  fatalCommandId: string | null = null;
  ordinaryLoadError: Error | null = null;

  closePluginView(): Promise<RuntimeSnapshot> {
    return this.getSnapshot();
  }

  getSnapshot(): Promise<RuntimeSnapshot> {
    return Promise.resolve(snapshot([...this.loaded.values()]));
  }

  async loadPlugin(pluginDirectory: string): Promise<RuntimeSnapshot> {
    const id = path.basename(pluginDirectory);
    if (this.ordinaryLoadError) {
      throw this.ordinaryLoadError;
    }
    if (this.fatalLoadId === id) {
      throw new FatalPluginRuntimeError("load-plugin", `Timed out while loading ${id}.`);
    }
    const summary = plugin(id);
    this.loaded.set(id, summary);
    return snapshot([...this.loaded.values()], id);
  }

  markLayoutReady(): Promise<RuntimeSnapshot> {
    return this.getSnapshot();
  }

  openPluginSettings(): Promise<RuntimeSnapshot> {
    return this.getSnapshot();
  }

  openPluginView(): Promise<RuntimeSnapshot> {
    return this.getSnapshot();
  }

  reloadPlugin(pluginId?: string): Promise<RuntimeSnapshot> {
    return pluginId ? this.loadPlugin(`/vault/.obsidian/plugins/${pluginId}`) : this.getSnapshot();
  }

  async runCommand(
    commandId: string,
    _editorContext?: PluginEditorContext,
  ): Promise<RuntimeSnapshot> {
    if (this.fatalCommandId === commandId) {
      throw new FatalPluginRuntimeError("run-command", `Timed out while running ${commandId}.`);
    }
    return this.getSnapshot();
  }

  waitForPluginMutations(): Promise<RuntimeSnapshot> {
    return this.getSnapshot();
  }

  async unloadAllPlugins(): Promise<RuntimeSnapshot> {
    this.loaded.clear();
    return this.getSnapshot();
  }

  async unloadPlugin(pluginId?: string): Promise<RuntimeSnapshot> {
    if (pluginId) {
      this.loaded.delete(pluginId);
    }
    return this.getSnapshot();
  }
}

describe("RecoveringPluginRuntime", () => {
  it("replaces a wedged renderer and keeps failed plugins available for explicit reload", async () => {
    const first = new FakePluginRuntime();
    first.fatalLoadId = "bad";
    const replacement = new FakePluginRuntime();
    const runtimes = [first, replacement];
    const onRuntimeChange = vi.fn();
    const runtime = await RecoveringPluginRuntime.open({
      create: async () => {
        const next = runtimes.shift();
        if (!next) {
          throw new Error("No fake renderer remains.");
        }
        return next;
      },
      describePlugin: async (directory) => ({
        id: path.basename(directory),
        name: path.basename(directory) === "bad" ? "Bad plugin" : "Good plugin",
        version: "2.0.0",
        stylesheetDiscovered: false,
      }),
      onRuntimeChange,
    });

    await runtime.loadPlugin("/vault/.obsidian/plugins/good");
    const recovered = await runtime.loadPlugin("/vault/.obsidian/plugins/bad");

    expect(first.close).toHaveBeenCalledOnce();
    expect(onRuntimeChange).toHaveBeenCalledTimes(2);
    expect(recovered.commands).toEqual([]);
    expect(recovered.plugin).toMatchObject({ id: "bad", name: "Bad plugin", state: "failed" });
    expect(recovered.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "bad", state: "failed" }),
        expect.objectContaining({ id: "good", state: "failed" }),
      ]),
    );
    expect(recovered.events.at(-1)).toMatchObject({
      kind: "error",
      message: expect.stringContaining("Recovered the compatibility renderer"),
    });
    expect(recovered.notices.at(-1)).toContain("plugin operation was stopped");

    const goodReloaded = await runtime.reloadPlugin("good");
    expect(goodReloaded.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "bad", state: "failed" }),
        expect.objectContaining({ id: "good", state: "loaded" }),
      ]),
    );

    const bothReloaded = await runtime.reloadPlugin("bad");
    expect(bothReloaded.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "bad", state: "loaded" }),
        expect.objectContaining({ id: "good", state: "loaded" }),
      ]),
    );
    await runtime.close();
    expect(replacement.close).toHaveBeenCalledOnce();
  });

  it("attributes a fatal command to its owner and stops every plugin in the shared renderer", async () => {
    const first = new FakePluginRuntime();
    first.fatalCommandId = "second-command";
    const replacement = new FakePluginRuntime();
    const runtimes = [first, replacement];
    const runtime = await RecoveringPluginRuntime.open({
      create: async () => runtimes.shift() ?? replacement,
    });
    await runtime.loadPlugin("/vault/.obsidian/plugins/first");
    await runtime.loadPlugin("/vault/.obsidian/plugins/second");

    const recovered = await runtime.runCommand("second-command");

    expect(recovered.plugin).toMatchObject({
      id: "second",
      state: "failed",
      error: expect.stringContaining("Timed out while running second-command"),
    });
    expect(recovered.plugins?.find(({ id }) => id === "first")?.error).toContain(
      "Reload to reactivate this plugin",
    );
    await runtime.close();
  });

  it("preserves ordinary plugin errors without restarting a healthy renderer", async () => {
    const current = new FakePluginRuntime();
    current.ordinaryLoadError = new Error("Plugin rejected its own configuration.");
    const create = vi.fn(async () => current);
    const runtime = await RecoveringPluginRuntime.open({ create });

    await expect(runtime.loadPlugin("/vault/.obsidian/plugins/ordinary")).rejects.toThrow(
      "Plugin rejected its own configuration",
    );
    expect(create).toHaveBeenCalledOnce();
    expect(current.close).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("finishes shutdown when the low-level close timeout has already killed the renderer", async () => {
    const current = new FakePluginRuntime();
    current.fatalClose = true;
    const runtime = await RecoveringPluginRuntime.open({ create: async () => current });

    await expect(runtime.close()).resolves.toBeUndefined();
    expect(current.close).toHaveBeenCalledOnce();
  });

  it("interrupts an in-flight renderer request instead of queuing shutdown behind it", async () => {
    let rejectSnapshot: ((error: Error) => void) | undefined;
    let markSnapshotStarted: (() => void) | undefined;
    const snapshotStarted = new Promise<void>((resolve) => {
      markSnapshotStarted = resolve;
    });
    const getSnapshot = vi.fn(
      () =>
        new Promise<RuntimeSnapshot>((_resolve, reject) => {
          rejectSnapshot = reject;
          markSnapshotStarted?.();
        }),
    );
    const close = vi.fn(async () => {
      rejectSnapshot?.(new FatalPluginRuntimeError("close", "Renderer closed."));
    });
    const current: PluginRuntimePort = {
      close,
      closePluginView: getSnapshot,
      getSnapshot,
      loadPlugin: getSnapshot,
      markLayoutReady: getSnapshot,
      openPluginSettings: getSnapshot,
      openPluginView: getSnapshot,
      reloadPlugin: getSnapshot,
      runCommand: getSnapshot,
      waitForPluginMutations: getSnapshot,
      unloadAllPlugins: getSnapshot,
      unloadPlugin: getSnapshot,
    };
    const runtime = await RecoveringPluginRuntime.open({ create: async () => current });
    const pendingSnapshot = runtime.getSnapshot();
    await snapshotStarted;

    await expect(runtime.close()).resolves.toBeUndefined();
    await expect(pendingSnapshot).rejects.toThrow("Plugin compatibility runtime is closed");
    expect(close).toHaveBeenCalledOnce();
  });
});
