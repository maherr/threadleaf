import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  PluginEditorContext,
  PluginSummary,
  PluginSurfaceSnapshot,
  RuntimeSnapshot,
} from "../shared/contracts";
import type { PluginRendererEnvironment } from "../shared/plugin-runtime-protocol";
import type { PluginConstructionRequest } from "../shared/plugins";
import { IsolatedPluginRuntime } from "./isolated-plugin-runtime";
import type { PluginRuntimePort } from "./plugin-runtime-port";

const vault = {
  id: null,
  name: "vault",
  path: "/vault",
  markdownFileCount: 2,
  mode: "synthetic-read-only" as const,
  source: "direct" as const,
  warning: null,
};

function summary(id: string, state: PluginSummary["state"] = "loaded"): PluginSummary {
  return {
    id,
    name: `${id} plugin`,
    version: "1.0.0",
    state,
    compatibilityLevel: state === "loaded" ? 3 : 0,
    stylesheetDiscovered: false,
    error: null,
  };
}

function constructionRequest(
  pluginDirectory: string,
  digest = "a".repeat(64),
  constructionPath: PluginConstructionRequest["constructionPath"] = "first-load",
): PluginConstructionRequest {
  const pluginId = path.basename(pluginDirectory);
  const packageIdentity = {
    pluginId,
    manifestVersion: "1.0.0",
    distributionTag: "1.0.0",
    manifestSha256: digest,
    mainSha256: digest,
    stylesSha256: null,
    packageTreeSha256: digest,
  };
  return {
    constructionPath,
    pluginDirectory,
    packageIdentity,
    packageIdentityDigest: digest,
  };
}

class FakeIsolatedRuntime implements PluginRuntimePort {
  readonly close = vi.fn(async () => undefined);
  commandIdOverride: string | null = null;
  readonly loadCalls: Array<{
    constructionPath: PluginConstructionRequest["constructionPath"];
    directory: string;
    hash: string | undefined;
  }> = [];
  readonly markLayoutReady = vi.fn(async () => this.snapshot());
  readonly renderCalls: string[] = [];
  readonly runCalls: string[] = [];
  readonly environmentSequences: number[] = [];
  readonly vaultPathSeeds: string[][] = [];
  readonly trace: string[] = [];
  readonly waitForPluginMutations = vi.fn(async () => this.snapshot());
  readonly instanceId: number;
  pluginId: string | null = null;
  pluginState: PluginSummary["state"] = "empty";
  surface: PluginSurfaceSnapshot | null = null;

  constructor(instanceId: number) {
    this.instanceId = instanceId;
  }

  getSnapshot(): Promise<RuntimeSnapshot> {
    return Promise.resolve(this.snapshot());
  }

  async loadPlugin(request: PluginConstructionRequest): Promise<RuntimeSnapshot> {
    const pluginDirectory = request.pluginDirectory;
    this.pluginId = path.basename(pluginDirectory);
    this.pluginState = "loaded";
    this.trace.push(`load:${this.pluginId}`);
    this.loadCalls.push({
      constructionPath: request.constructionPath,
      directory: pluginDirectory,
      hash: request.packageIdentity.mainSha256,
    });
    return this.snapshot();
  }

  async applyEnvironment(environment: PluginRendererEnvironment): Promise<RuntimeSnapshot> {
    this.environmentSequences.push(environment.sequence);
    this.trace.push(`environment:${environment.sequence}`);
    return {
      ...this.snapshot(),
      pluginEnvironment: {
        status: "applied",
        vaultId: environment.vaultId,
        vaultGeneration: environment.vaultGeneration,
        sequence: environment.sequence,
        cssChangeTriggered: false,
      },
    };
  }

  async seedVaultMarkdownPaths(paths: readonly string[]): Promise<void> {
    this.vaultPathSeeds.push([...paths]);
  }

  reloadPlugin(): Promise<RuntimeSnapshot> {
    throw new Error("The pool must replace the renderer instead of reusing it.");
  }

  async runCommand(
    commandId: string,
    _editorContext?: PluginEditorContext,
  ): Promise<RuntimeSnapshot> {
    this.runCalls.push(commandId);
    return this.snapshot([`${this.pluginId} command completed in renderer ${this.instanceId}.`]);
  }

  async renderMarkdownProjection(
    pluginId: string,
    sourcePath: string,
    _content: string,
  ): Promise<RuntimeSnapshot> {
    this.renderCalls.push(pluginId);
    return {
      ...this.snapshot(),
      markdownProjection: {
        contentSha256: "a".repeat(64),
        html: "<p>settled</p>",
        pluginId,
        postProcessorCount: 1,
        sourcePath,
      },
    };
  }

  openPluginSettings(pluginId: string): Promise<RuntimeSnapshot> {
    this.surface = {
      displayText: `${pluginId} settings`,
      filePath: null,
      viewType: "threadleaf-plugin-settings",
    };
    return Promise.resolve(this.snapshot());
  }

  openPluginView(viewType: string, filePath?: string): Promise<RuntimeSnapshot> {
    this.surface = { displayText: viewType, filePath: filePath ?? null, viewType };
    return Promise.resolve(this.snapshot());
  }

  closePluginView(): Promise<RuntimeSnapshot> {
    this.surface = null;
    return Promise.resolve(this.snapshot());
  }

  unloadPlugin(): Promise<RuntimeSnapshot> {
    this.pluginState = "unloaded";
    this.surface = null;
    return Promise.resolve(this.snapshot());
  }

  unloadAllPlugins(): Promise<RuntimeSnapshot> {
    return this.unloadPlugin();
  }

  private snapshot(notices: string[] = []): RuntimeSnapshot {
    const plugin = this.pluginId ? summary(this.pluginId, this.pluginState) : null;
    const loaded = plugin?.state === "loaded";
    return {
      vault,
      plugin,
      plugins: plugin ? [plugin] : [],
      commands: loaded
        ? [
            {
              id: this.commandIdOverride ?? `${this.pluginId}:command`,
              name: `${this.pluginId} command`,
              ownerId: this.pluginId as string,
            },
          ]
        : [],
      actions: [],
      notices,
      events: this.pluginId
        ? [
            {
              sequence: 1,
              kind: "plugin",
              message: `${this.pluginId} renderer ${this.instanceId}`,
            },
          ]
        : [{ sequence: 1, kind: "runtime", message: "Opened synthetic vault vault." }],
      ...(loaded
        ? {
            integrations: {
              editorSuggests: 0,
              extensions: [
                { extension: this.pluginId as string, viewType: `${this.pluginId}-view` },
              ],
              markdownPostProcessors: 0,
              ribbonItems: 0,
              settingTabs: 1,
              settingTabPluginIds: [this.pluginId as string],
              statusBarItems: 0,
              viewTypes: [`${this.pluginId}-view`],
            },
          }
        : {}),
      pluginSurface: this.surface,
    };
  }
}

describe("IsolatedPluginRuntime", () => {
  it("seeds the idle renderer and every fresh isolated slot before plugin evaluation", async () => {
    const runtimes: FakeIsolatedRuntime[] = [];
    const runtime = await IsolatedPluginRuntime.open({
      create: async () => {
        const created = new FakeIsolatedRuntime(runtimes.length + 1);
        runtimes.push(created);
        return created;
      },
    });

    await runtime.seedVaultMarkdownPaths(["Notes/One.md", "Notes/Two.md"]);
    await runtime.loadPlugin(constructionRequest("/vault/.obsidian/plugins/alpha"));
    await runtime.loadPlugin(constructionRequest("/vault/.obsidian/plugins/beta"));

    expect(runtimes).toHaveLength(2);
    expect(runtimes.map(({ vaultPathSeeds }) => vaultPathSeeds)).toEqual([
      [["Notes/One.md", "Notes/Two.md"]],
      [["Notes/One.md", "Notes/Two.md"]],
    ]);
    expect(runtimes[0]?.trace[0]).toBe("load:alpha");
    expect(runtimes[1]?.trace[0]).toBe("load:beta");
    await runtime.close();
  });

  it("acknowledges the environment before each fresh slot evaluates a plugin", async () => {
    const environment: PluginRendererEnvironment = {
      vaultId: "e".repeat(64),
      vaultGeneration: 3,
      sequence: 8,
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
    };
    const created: FakeIsolatedRuntime[] = [];
    const runtime = await IsolatedPluginRuntime.open({
      create: async () => {
        const instance = new FakeIsolatedRuntime(created.length + 1);
        created.push(instance);
        return instance;
      },
    });

    await runtime.applyEnvironment(environment);
    await runtime.loadPlugin(constructionRequest("/vault/.obsidian/plugins/alpha"));
    await runtime.loadPlugin(constructionRequest("/vault/.obsidian/plugins/beta", "b".repeat(64)));

    expect(created[0]?.trace).toEqual(["environment:8", "load:alpha"]);
    expect(created[1]?.trace).toEqual(["environment:8", "load:beta"]);
    expect((await runtime.getSnapshot()).pluginEnvironment).toMatchObject({
      status: "applied",
      vaultId: environment.vaultId,
      vaultGeneration: environment.vaultGeneration,
      sequence: environment.sequence,
    });
    await runtime.close();
  });

  it("gives each plugin its own replaceable runtime and aggregates user-facing state", async () => {
    const created: FakeIsolatedRuntime[] = [];
    const runtime = await IsolatedPluginRuntime.open({
      create: async () => {
        const instance = new FakeIsolatedRuntime(created.length + 1);
        created.push(instance);
        return instance;
      },
    });

    expect(created).toHaveLength(1);
    await runtime.loadPlugin(constructionRequest("/vault/.obsidian/plugins/alpha"));
    const loaded = await runtime.loadPlugin(
      constructionRequest("/vault/.obsidian/plugins/beta", "b".repeat(64)),
    );

    expect(created).toHaveLength(2);
    expect(created[0]?.pluginId).toBe("alpha");
    expect(created[1]?.pluginId).toBe("beta");
    expect(created[0]?.loadCalls[0]?.constructionPath).toBe("first-load");
    expect(created[1]?.loadCalls[0]?.constructionPath).toBe("first-load");
    expect(loaded.plugins).toMatchObject([
      { id: "alpha", state: "loaded" },
      { id: "beta", state: "loaded" },
    ]);
    expect(loaded.commands.map(({ id }) => id)).toEqual(["alpha:command", "beta:command"]);
    expect(loaded.integrations?.viewTypes).toEqual(["alpha-view", "beta-view"]);

    const ran = await runtime.runCommand("alpha:command");
    expect(created[0]?.runCalls).toEqual(["alpha:command"]);
    expect(created[1]?.runCalls).toEqual([]);
    expect(ran.notices.at(-1)).toContain("renderer 1");

    await runtime.openPluginView("alpha-view", "Drawing.alpha");
    const betaView = await runtime.openPluginView("beta-view", "Drawing.beta");
    expect(created[0]?.surface).toBeNull();
    expect(betaView.pluginSurface).toMatchObject({
      filePath: "Drawing.beta",
      viewType: "beta-view",
    });

    await runtime.markLayoutReady();
    expect(created[0]?.markLayoutReady).toHaveBeenCalledOnce();
    expect(created[1]?.markLayoutReady).toHaveBeenCalledOnce();

    const reloaded = await runtime.reloadPlugin(
      constructionRequest("/vault/.obsidian/plugins/alpha"),
    );
    expect(created).toHaveLength(3);
    expect(created[0]?.close).toHaveBeenCalledOnce();
    expect(created[2]?.loadCalls).toEqual([
      {
        constructionPath: "explicit-reload",
        directory: "/vault/.obsidian/plugins/alpha",
        hash: "a".repeat(64),
      },
    ]);
    expect(created[2]?.markLayoutReady).toHaveBeenCalledOnce();
    expect(reloaded.plugins?.find(({ id }) => id === "beta")?.state).toBe("loaded");

    const unloaded = await runtime.unloadPlugin("beta");
    expect(created[1]?.close).toHaveBeenCalledOnce();
    expect(unloaded.plugins?.find(({ id }) => id === "beta")?.state).toBe("unloaded");
    expect(unloaded.commands.map(({ id }) => id)).toEqual(["alpha:command"]);

    await runtime.close();
    expect(created[2]?.close).toHaveBeenCalledOnce();
  });

  it("refreshes slot liveness before serving a snapshot", async () => {
    const created: FakeIsolatedRuntime[] = [];
    const runtime = await IsolatedPluginRuntime.open({
      create: async () => {
        const instance = new FakeIsolatedRuntime(created.length + 1);
        created.push(instance);
        return instance;
      },
    });
    await runtime.loadPlugin(constructionRequest("/vault/.obsidian/plugins/alpha"));
    const slot = created[0];
    if (!slot) throw new Error("The isolated runtime fixture did not create its first slot.");

    slot.pluginState = "failed";
    const refreshed = await runtime.getSnapshot();

    expect(refreshed.plugins).toMatchObject([{ id: "alpha", state: "failed" }]);
    expect(refreshed.commands).toEqual([]);
    await runtime.close();
  });

  it("rejects cross-plugin command ambiguity instead of guessing an owner", async () => {
    let created = 0;
    const runtime = await IsolatedPluginRuntime.open({
      create: async () => {
        created += 1;
        const instance = new FakeIsolatedRuntime(created);
        if (created === 2) {
          instance.commandIdOverride = "alpha:command";
        }
        return instance;
      },
    });
    await runtime.loadPlugin(constructionRequest("/vault/.obsidian/plugins/alpha"));
    await runtime.loadPlugin(constructionRequest("/vault/.obsidian/plugins/beta"));
    const snapshot = await runtime.getSnapshot();
    const alpha = snapshot.commands.find(({ ownerId }) => ownerId === "alpha");
    if (!alpha) {
      throw new Error("Fixture command inventory was not created.");
    }

    await expect(runtime.runCommand(alpha.id)).rejects.toThrow(
      "ambiguous across isolated runtimes",
    );
    await runtime.close();
  });

  it("does not let an ambient settled-projection render retarget a later no-arg unload/reload", async () => {
    const created: FakeIsolatedRuntime[] = [];
    const runtime = await IsolatedPluginRuntime.open({
      create: async () => {
        const instance = new FakeIsolatedRuntime(created.length + 1);
        created.push(instance);
        return instance;
      },
    });
    await runtime.loadPlugin(constructionRequest("/vault/.obsidian/plugins/alpha"));
    await runtime.loadPlugin(constructionRequest("/vault/.obsidian/plugins/cite", "b".repeat(64)));

    // A deliberate user action naming "alpha" is the last thing that should determine a later
    // no-arg target.
    await runtime.runCommand("alpha:command");
    expect(created[0]?.runCalls).toEqual(["alpha:command"]);

    // Reading view opening a note whose plugin happens to be "cite" fires this ambiently; it must
    // not silently redirect subsequent no-arg plugin operations to "cite".
    await runtime.renderMarkdownProjection("cite", "Notes/Fixture.md", "[cite: Doe 2024]");
    expect(created[1]?.renderCalls).toEqual(["cite"]);

    const unloaded = await runtime.unloadPlugin();

    expect(created[0]?.close).toHaveBeenCalledOnce();
    expect(created[1]?.close).not.toHaveBeenCalled();
    expect(unloaded.plugins?.find(({ id }) => id === "alpha")?.state).toBe("unloaded");
    expect(unloaded.plugins?.find(({ id }) => id === "cite")?.state).toBe("loaded");

    await runtime.close();
  });
});
