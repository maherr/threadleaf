import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedStateRoot } from "../kernel/ports";
import type { PluginRuntimePort } from "../runtime/plugin-runtime-port";
import type { RuntimeSnapshot } from "../shared/contracts";
import type { PluginConstructionRequest } from "../shared/plugins";
import { WorkspaceRuntime } from "./workspace-runtime";
import {
  createWorkspaceLayout,
  type PersistedWorkspaceState,
  type WorkspaceStateStore,
} from "./workspace-state";

let sandboxPath: string;
let vaultPath: string;
let runtime: WorkspaceRuntime | undefined;

function filePluginConstructionRequest(): PluginConstructionRequest {
  const digest = "a".repeat(64);
  return {
    constructionPath: "test-execution",
    pluginDirectory: "fixture-plugin",
    packageIdentity: {
      pluginId: "drawing-fixture",
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

const canvas = `${JSON.stringify(
  {
    future: { keep: "yes" },
    nodes: [{ id: "text", type: "text", x: 0, y: 0, width: 160, height: 90, text: "Hello" }],
    edges: [],
  },
  null,
  2,
)}\n`;

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-workspace-canvas-"));
  vaultPath = path.join(sandboxPath, "vault");
  await fs.mkdir(vaultPath, { recursive: true });
  await fs.writeFile(path.join(vaultPath, "Welcome.md"), "# Welcome\n", "utf8");
  await fs.writeFile(path.join(vaultPath, "Board.canvas"), canvas, "utf8");
});

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

async function openRuntime(selectionSource?: "bundled" | "direct"): Promise<WorkspaceRuntime> {
  runtime = await WorkspaceRuntime.open({
    vaultRoot: vaultPath,
    stateRoot: new FixedStateRoot(path.join(sandboxPath, "state")),
    ...(selectionSource ? { selectionSource } : {}),
  });
  return runtime;
}

class MemoryWorkspaceStateStore implements WorkspaceStateStore {
  value: PersistedWorkspaceState | null = null;

  async load(vaultId: string): Promise<PersistedWorkspaceState | null> {
    return this.value?.vaultId === vaultId ? this.value : null;
  }

  async save(state: PersistedWorkspaceState): Promise<PersistedWorkspaceState> {
    this.value = createWorkspaceLayout(
      state.vaultId,
      state.panes,
      state.activePaneId,
      state.splitDirection,
    );
    return this.value;
  }
}

function registeredFilePluginRuntime(initiallyLoaded = true): PluginRuntimePort {
  let pluginSurface: NonNullable<RuntimeSnapshot["pluginSurface"]> | null = null;
  let loaded = initiallyLoaded;
  const snapshot = (): RuntimeSnapshot => ({
    vault: {
      id: null,
      name: "vault",
      path: vaultPath,
      markdownFileCount: 1,
      mode: "synthetic-read-only",
      source: "direct",
      warning: null,
    },
    plugin: loaded
      ? {
          id: "drawing-fixture",
          name: "Drawing fixture",
          version: "1.0.0",
          state: "loaded",
          compatibilityLevel: 3,
          stylesheetDiscovered: false,
          error: null,
        }
      : null,
    commands: [],
    actions: [],
    notices: [],
    events: [],
    integrations: {
      editorSuggests: 0,
      extensions: loaded
        ? [
            { extension: "drawing", viewType: "drawing-view" },
            { extension: "excalidraw", viewType: "excalidraw" },
          ]
        : [],
      markdownPostProcessors: 0,
      ribbonItems: 0,
      settingTabs: 0,
      statusBarItems: 0,
      viewTypes: loaded ? ["drawing-view", "excalidraw"] : [],
    },
    pluginSurface,
  });
  return {
    close: async () => undefined,
    closePluginView: async () => {
      pluginSurface = null;
      return snapshot();
    },
    getSnapshot: async () => snapshot(),
    loadPlugin: async () => {
      loaded = true;
      return snapshot();
    },
    markLayoutReady: async () => snapshot(),
    openPluginSettings: async () => snapshot(),
    openPluginView: async (viewType, filePath) => {
      pluginSurface = {
        displayText: filePath ?? viewType,
        filePath: filePath ?? null,
        viewType,
      };
      return snapshot();
    },
    reloadPlugin: async () => {
      loaded = true;
      return snapshot();
    },
    runCommand: async () => snapshot(),
    waitForPluginMutations: async () => snapshot(),
    unloadAllPlugins: async () => {
      loaded = false;
      pluginSurface = null;
      return snapshot();
    },
    unloadPlugin: async () => {
      loaded = false;
      pluginSurface = null;
      return snapshot();
    },
  };
}

describe("WorkspaceRuntime JSON Canvas surface", () => {
  it("opens a registered native file as a plugin document without indexing it as Markdown", async () => {
    const nativeScene = '{"type":"excalidraw","version":2,"elements":[]}\n';
    await fs.writeFile(path.join(vaultPath, "Native Scene.excalidraw"), nativeScene, "utf8");
    await fs.writeFile(path.join(vaultPath, "Registered.drawing"), "opaque\n", "utf8");
    await fs.writeFile(path.join(vaultPath, "Ordinary.json"), "{}\n", "utf8");
    runtime = await WorkspaceRuntime.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(path.join(sandboxPath, "state")),
      pluginRuntimeFactory: async () => registeredFilePluginRuntime(),
    });

    const opened = await runtime.openNote("Native Scene.excalidraw");
    expect(opened.workspace?.files.map((file) => file.path)).toEqual(["Welcome.md"]);
    expect(opened.workspace?.activeNote).toBeNull();
    expect(opened.workspace?.panes[0]?.activeCanvas ?? null).toBeNull();
    expect(opened.workspace?.panes[0]?.activePluginFile).toMatchObject({
      path: "Native Scene.excalidraw",
      title: "Native Scene",
      viewType: "excalidraw",
    });
    expect(opened.workspace?.tabs).toContainEqual(
      expect.objectContaining({ path: "Native Scene.excalidraw", active: true }),
    );

    const pluginView = await runtime.openPluginView("excalidraw", "Native Scene.excalidraw");
    expect(pluginView.pluginSurface).toMatchObject({
      filePath: "Native Scene.excalidraw",
      viewType: "excalidraw",
    });
    await expect(
      fs.readFile(path.join(vaultPath, "Native Scene.excalidraw"), "utf8"),
    ).resolves.toBe(nativeScene);
    await expect(runtime.openNote("Ordinary.json")).rejects.toThrow(
      "Workspace tabs do not support this ordinary file type",
    );
    await expect(runtime.openNote("Registered.drawing")).rejects.toThrow(
      "Workspace tabs do not support this ordinary file type",
    );
  });

  it("loads plugin registration before restoring a persisted native scene", async () => {
    const nativeScene = '{"type":"excalidraw","version":2,"elements":[]}\n';
    await fs.writeFile(path.join(vaultPath, "Native Scene.excalidraw"), nativeScene, "utf8");
    const store = new MemoryWorkspaceStateStore();
    const openPersistedRuntime = () =>
      WorkspaceRuntime.open({
        vaultRoot: vaultPath,
        stateRoot: new FixedStateRoot(path.join(sandboxPath, "state")),
        pluginConstructionRequest: filePluginConstructionRequest(),
        pluginRuntimeFactory: async () => registeredFilePluginRuntime(false),
        workspaceStateStore: store,
      });

    runtime = await openPersistedRuntime();
    await runtime.openNote("Native Scene.excalidraw");
    expect(store.value?.panes[0]?.activePath).toBe("Native Scene.excalidraw");
    await runtime.close();
    runtime = undefined;

    runtime = await openPersistedRuntime();
    const restored = await runtime.getSnapshot();
    expect(restored.workspace?.activeNote).toBeNull();
    expect(restored.workspace?.activePluginFile).toMatchObject({
      path: "Native Scene.excalidraw",
      viewType: "excalidraw",
    });
    expect(restored.workspace?.tabs).toContainEqual(
      expect.objectContaining({ path: "Native Scene.excalidraw", active: true }),
    );
  });

  it("preserves native scenes through per-pane Back and Forward history", async () => {
    await fs.writeFile(
      path.join(vaultPath, "Native Scene.excalidraw"),
      '{"type":"excalidraw","version":2,"elements":[]}\n',
      "utf8",
    );
    runtime = await WorkspaceRuntime.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(path.join(sandboxPath, "state")),
      pluginRuntimeFactory: async () => registeredFilePluginRuntime(),
    });

    await runtime.openNote("Native Scene.excalidraw");
    await runtime.openNote("Welcome.md");
    const back = await runtime.goBack(runtime.vaultId);
    expect(back.workspace?.activeNote).toBeNull();
    expect(back.workspace?.activePluginFile?.path).toBe("Native Scene.excalidraw");
    expect(back.workspace?.panes[0]).toMatchObject({ canGoBack: false, canGoForward: true });

    const forward = await runtime.goForward(runtime.vaultId);
    expect(forward.workspace?.activeNote?.path).toBe("Welcome.md");
    expect(forward.workspace?.activePluginFile ?? null).toBeNull();
    expect(forward.workspace?.panes[0]).toMatchObject({ canGoBack: true, canGoForward: false });
  });

  it("removes live native-view eligibility on unload and restores it on reload", async () => {
    await fs.writeFile(
      path.join(vaultPath, "Native Scene.excalidraw"),
      '{"type":"excalidraw","version":2,"elements":[]}\n',
      "utf8",
    );
    runtime = await WorkspaceRuntime.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(path.join(sandboxPath, "state")),
      pluginRuntimeFactory: async () => registeredFilePluginRuntime(),
    });
    await runtime.openNote("Native Scene.excalidraw");

    const unloaded = await runtime.unloadPlugin();
    expect(unloaded.workspace?.activePluginFile ?? null).toBeNull();
    expect(unloaded.workspace?.activeNote).toBeNull();
    expect(unloaded.workspace?.activeUnavailable?.path).toBe("Native Scene.excalidraw");
    expect(unloaded.workspace?.tabs).toContainEqual(
      expect.objectContaining({ path: "Native Scene.excalidraw", active: true }),
    );

    const reloaded = await runtime.reloadPlugin();
    expect(reloaded.workspace?.activeUnavailable ?? null).toBeNull();
    expect(reloaded.workspace?.activePluginFile).toMatchObject({
      path: "Native Scene.excalidraw",
      viewType: "excalidraw",
    });
  });

  it("lists and opens Canvas files without putting them in the Markdown index", async () => {
    const workspace = await openRuntime();
    const initial = await workspace.getSnapshot();
    expect(initial.workspace?.files.map((file) => file.path)).toEqual(["Welcome.md"]);
    expect(initial.workspace?.canvasFiles).toEqual([{ path: "Board.canvas", title: "Board" }]);
    const opened = await workspace.openNote("Board.canvas");
    expect(opened.workspace?.activeNote).toBeNull();
    expect(opened.workspace?.panes[0]?.activeCanvas).toMatchObject({
      path: "Board.canvas",
      readOnly: false,
      document: { future: { keep: "yes" } },
    });
  });

  it("saves through the kernel and reports external-edit conflicts", async () => {
    const workspace = await openRuntime();
    const opened = await workspace.openNote("Board.canvas");
    const active = opened.workspace?.panes[0]?.activeCanvas;
    if (!active) throw new Error("Expected Board.canvas to open.");
    const edited = JSON.stringify({ nodes: [], edges: [], future: { keep: "changed" } });
    const saved = await workspace.saveCanvas(
      "Board.canvas",
      edited,
      active.revision,
      workspace.vaultId,
    );
    expect(saved.outcome.status).toBe("committed");
    await fs.writeFile(
      path.join(vaultPath, "Board.canvas"),
      '{"nodes":[],"edges":[],"external":true}\n',
      "utf8",
    );
    const conflict = await workspace.saveCanvas(
      "Board.canvas",
      edited.replace("changed", "proposal"),
      saved.outcome.status === "committed" ? saved.outcome.revision : active.revision,
      workspace.vaultId,
    );
    expect(conflict.outcome.status).toBe("conflict");
    if (conflict.outcome.status === "conflict") {
      expect(conflict.outcome.conflictPath).toContain("Board.threadleaf-conflict-");
      await expect(
        fs.readFile(path.join(vaultPath, conflict.outcome.conflictPath), "utf8"),
      ).resolves.toContain("proposal");
    }
  });

  it("keeps malformed canvases visible but non-writable", async () => {
    await fs.writeFile(path.join(vaultPath, "Broken.canvas"), "{oops", "utf8");
    const workspace = await openRuntime("bundled");
    const opened = await workspace.openNote("Broken.canvas");
    const active = opened.workspace?.panes[0]?.activeCanvas;
    expect(active).toMatchObject({ readOnly: true, diagnostics: [{ code: "invalid-json" }] });
    if (!active) throw new Error("Expected malformed canvas snapshot.");
    await expect(
      workspace.saveCanvas("Broken.canvas", canvas, active.revision, workspace.vaultId),
    ).resolves.toMatchObject({ outcome: { status: "read-only" } });
    await expect(fs.readFile(path.join(vaultPath, "Broken.canvas"), "utf8")).resolves.toBe("{oops");
  });

  it("keeps valid bundled canvases read-only before the writer is reached", async () => {
    const workspace = await openRuntime("bundled");
    const opened = await workspace.openNote("Board.canvas");
    const active = opened.workspace?.panes[0]?.activeCanvas;
    if (!active) throw new Error("Expected Board.canvas to open.");
    const saved = await workspace.saveCanvas(
      "Board.canvas",
      canvas.replace("Hello", "Would not write"),
      active.revision,
      workspace.vaultId,
    );
    expect(saved.outcome).toEqual({ status: "read-only", path: "Board.canvas" });
    await expect(fs.readFile(path.join(vaultPath, "Board.canvas"), "utf8")).resolves.toBe(canvas);
  });
});
