import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PluginEditorContext, PluginSummary, RuntimeSnapshot } from "../shared/contracts";
import type { PluginRendererEnvironment } from "../shared/plugin-runtime-protocol";
import type { PluginConstructionRequest } from "../shared/plugins";
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

function constructionRequest(pluginDirectory: string): PluginConstructionRequest {
  const id = path.basename(pluginDirectory);
  const digest = id.padEnd(64, "0").slice(0, 64);
  return {
    constructionPath: "first-load",
    pluginDirectory,
    packageIdentity: {
      pluginId: id,
      manifestVersion: "1.0.0",
      distributionTag: "1.0.0",
      manifestSha256: digest,
      mainSha256: digest,
      stylesSha256: null,
      packageTreeSha256: digest,
    },
    packageIdentityDigest: digest,
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
  fatalLoadOperation = "load-plugin";
  fatalCommandId: string | null = null;
  ordinaryLoadError: Error | null = null;
  environmentAcknowledgementOverrides: Partial<NonNullable<RuntimeSnapshot["pluginEnvironment"]>> =
    {};
  readonly constructionPaths: string[] = [];
  readonly environmentSequences: number[] = [];
  readonly vaultPathSeeds: string[][] = [];
  readonly trace: string[] = [];

  closePluginView(): Promise<RuntimeSnapshot> {
    return this.getSnapshot();
  }

  getSnapshot(): Promise<RuntimeSnapshot> {
    return Promise.resolve(snapshot([...this.loaded.values()]));
  }

  async loadPlugin(request: PluginConstructionRequest): Promise<RuntimeSnapshot> {
    const id = request.packageIdentity.pluginId;
    this.trace.push(`load:${id}`);
    this.constructionPaths.push(request.constructionPath);
    if (this.ordinaryLoadError) {
      throw this.ordinaryLoadError;
    }
    if (this.fatalLoadId === id) {
      throw new FatalPluginRuntimeError(this.fatalLoadOperation, `Timed out while loading ${id}.`);
    }
    const summary = plugin(id);
    this.loaded.set(id, summary);
    return snapshot([...this.loaded.values()], id);
  }

  async applyEnvironment(environment: PluginRendererEnvironment): Promise<RuntimeSnapshot> {
    this.environmentSequences.push(environment.sequence);
    this.trace.push(`environment:${environment.sequence}`);
    return {
      ...snapshot([...this.loaded.values()]),
      pluginEnvironment: {
        status: "applied",
        vaultId: environment.vaultId,
        vaultGeneration: environment.vaultGeneration,
        sequence: environment.sequence,
        cssChangeTriggered: false,
        ...this.environmentAcknowledgementOverrides,
      },
    };
  }

  async seedVaultMarkdownPaths(paths: readonly string[]): Promise<void> {
    this.vaultPathSeeds.push([...paths]);
    this.trace.push(`seed:${paths.length}`);
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

  reloadPlugin(request?: PluginConstructionRequest): Promise<RuntimeSnapshot> {
    return request ? this.loadPlugin(request) : this.getSnapshot();
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
  const environment: PluginRendererEnvironment = {
    vaultId: "e".repeat(64),
    vaultGeneration: 9,
    sequence: 4,
    theme: "dark",
    appearanceCss: ".appearance {}",
    pluginCss: ".plugin {}",
    accessibilityCss: ":root {}",
    accessibility: {
      highContrast: false,
      accent: "blue",
      uiFontScale: 1,
      textFontScale: 1,
      editorFontSize: 15,
      editorLineHeight: 1.6,
      reducedMotion: false,
      reducedTransparency: false,
    },
    noteWorkflows: {
      templateFolder: "Templates",
      templateDateFormat: "YYYY-MM-DD",
      templateTimeFormat: "HH:mm",
      dailyNoteFolder: "",
      dailyNoteDateFormat: "YYYY-MM-DD",
      dailyNoteTemplate: null,
    },
  };

  it("restores the authoritative vault census before the environment and plugin replay", async () => {
    const first = new FakePluginRuntime();
    first.fatalLoadId = "bad";
    const replacement = new FakePluginRuntime();
    const runtimes = [first, replacement];
    const runtime = await RecoveringPluginRuntime.open({
      create: async () => runtimes.shift() ?? replacement,
    });
    await runtime.seedVaultMarkdownPaths(["Notes/One.md", "Notes/Two.md"]);
    await runtime.applyEnvironment(environment);
    await runtime.loadPlugin(constructionRequest("/vault/.obsidian/plugins/good"));
    await runtime.loadPlugin(constructionRequest("/vault/.obsidian/plugins/bad"));

    expect(replacement.vaultPathSeeds).toEqual([["Notes/One.md", "Notes/Two.md"]]);
    expect(replacement.trace.slice(0, 3)).toEqual(["seed:2", "environment:4", "load:good"]);
    await runtime.close();
  });

  it("restores the last acknowledged environment before replaying plugins", async () => {
    const first = new FakePluginRuntime();
    first.fatalLoadId = "bad";
    const replacement = new FakePluginRuntime();
    const runtimes = [first, replacement];
    const runtime = await RecoveringPluginRuntime.open({
      create: async () => runtimes.shift() ?? replacement,
    });
    await runtime.applyEnvironment(environment);
    await runtime.loadPlugin(constructionRequest("/vault/.obsidian/plugins/good"));
    await runtime.loadPlugin(constructionRequest("/vault/.obsidian/plugins/bad"));

    expect(replacement.environmentSequences).toEqual([4]);
    expect(replacement.trace[0]).toBe("environment:4");
    expect(replacement.trace.slice(1)).toEqual(["load:good"]);
    await runtime.close();
  });

  it.each([
    ["vaultId", { vaultId: "wrong-vault" }],
    ["vaultGeneration", { vaultGeneration: 10 }],
    ["status", { status: "stale" as const }],
    ["sequence", { sequence: 5 }],
  ])(
    "does not cache an acknowledgement with a mismatched %s for later recovery",
    async (_field, override) => {
      const first = new FakePluginRuntime();
      first.environmentAcknowledgementOverrides = override;
      const replacement = new FakePluginRuntime();
      const runtimes = [first, replacement];
      const runtime = await RecoveringPluginRuntime.open({
        create: async () => runtimes.shift() ?? replacement,
      });

      await expect(runtime.applyEnvironment(environment)).rejects.toThrow("environment identity");
      await runtime.loadPlugin(constructionRequest("/vault/.obsidian/plugins/good"));
      first.fatalLoadId = "bad";

      const recovered = await runtime.loadPlugin(
        constructionRequest("/vault/.obsidian/plugins/bad"),
      );

      expect(replacement.environmentSequences).toEqual([]);
      expect(recovered.plugins).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "good", state: "loaded" })]),
      );
      await runtime.close();
    },
  );

  it.each([
    ["vaultId", { vaultId: "wrong-vault" }],
    ["vaultGeneration", { vaultGeneration: 10 }],
    ["status", { status: "stale" as const }],
    ["sequence", { sequence: 5 }],
  ])("fails closed when a replacement acknowledges the wrong %s", async (_field, override) => {
    const first = new FakePluginRuntime();
    const replacement = new FakePluginRuntime();
    replacement.environmentAcknowledgementOverrides = override;
    first.fatalLoadId = "bad";
    const runtimes = [first, replacement];
    const runtime = await RecoveringPluginRuntime.open({
      create: async () => runtimes.shift() ?? replacement,
    });

    await runtime.applyEnvironment(environment);
    await runtime.loadPlugin(constructionRequest("/vault/.obsidian/plugins/good"));

    await expect(
      runtime.loadPlugin(constructionRequest("/vault/.obsidian/plugins/bad")),
    ).rejects.toThrow("recovery failed");
    expect(first.close).toHaveBeenCalledOnce();
    expect(replacement.close).toHaveBeenCalledOnce();
    expect(replacement.constructionPaths).toEqual([]);
    await expect(runtime.getSnapshot()).rejects.toThrow("Plugin compatibility runtime is closed");
  });

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

    await runtime.loadPlugin(constructionRequest("/vault/.obsidian/plugins/good"));
    const recovered = await runtime.loadPlugin(constructionRequest("/vault/.obsidian/plugins/bad"));

    expect(first.close).toHaveBeenCalledOnce();
    expect(onRuntimeChange).toHaveBeenCalledTimes(2);
    expect(recovered.commands.map(({ id }) => id)).toEqual(["good-command"]);
    expect(recovered.plugin).toMatchObject({ id: "good", state: "loaded" });
    expect(recovered.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "bad", state: "failed" }),
        expect.objectContaining({ id: "good", state: "loaded" }),
      ]),
    );
    expect(recovered.events.at(-1)).toMatchObject({
      kind: "error",
      message: expect.stringContaining("Recovered the compatibility renderer"),
    });
    expect(recovered.notices.at(-1)).toContain("plugin operation was stopped");

    expect(replacement.constructionPaths).toContain("automatic-recovery");
    const goodReloaded = await runtime.reloadPlugin(
      constructionRequest("/vault/.obsidian/plugins/good"),
    );
    expect(goodReloaded.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "bad", state: "failed" }),
        expect.objectContaining({ id: "good", state: "loaded" }),
      ]),
    );

    const bothReloaded = await runtime.reloadPlugin(
      constructionRequest("/vault/.obsidian/plugins/bad"),
    );
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
    await runtime.loadPlugin(constructionRequest("/vault/.obsidian/plugins/first"));
    await runtime.loadPlugin(constructionRequest("/vault/.obsidian/plugins/second"));

    const recovered = await runtime.runCommand("second-command");

    expect(recovered.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "first", state: "loaded" }),
        expect.objectContaining({ id: "second", state: "loaded" }),
      ]),
    );
    expect(replacement.constructionPaths).toEqual(["automatic-recovery", "automatic-recovery"]);
    await runtime.close();
  });

  it("leaves plugins stopped after renderer exit until an explicit reload", async () => {
    const first = new FakePluginRuntime();
    first.fatalLoadId = "bad";
    first.fatalLoadOperation = "renderer-exit";
    const replacement = new FakePluginRuntime();
    const runtimes = [first, replacement];
    const runtime = await RecoveringPluginRuntime.open({
      create: async () => runtimes.shift() ?? replacement,
    });
    await runtime.loadPlugin(constructionRequest("/vault/.obsidian/plugins/good"));
    const recovered = await runtime.loadPlugin(constructionRequest("/vault/.obsidian/plugins/bad"));
    expect(replacement.constructionPaths).toEqual([]);
    expect(recovered.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "bad", state: "failed" }),
        expect.objectContaining({ id: "good", state: "failed" }),
      ]),
    );
    await runtime.close();
  });

  it("preserves ordinary plugin errors without restarting a healthy renderer", async () => {
    const current = new FakePluginRuntime();
    current.ordinaryLoadError = new Error("Plugin rejected its own configuration.");
    const create = vi.fn(async () => current);
    const runtime = await RecoveringPluginRuntime.open({ create });

    await expect(
      runtime.loadPlugin(constructionRequest("/vault/.obsidian/plugins/ordinary")),
    ).rejects.toThrow("Plugin rejected its own configuration");
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
