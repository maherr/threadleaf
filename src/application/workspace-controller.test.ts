import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FixedStateRoot } from "../kernel/ports";
import type { PluginRuntimeFactory } from "../runtime/plugin-runtime-port";
import type {
  AttachmentMoveResponse,
  NoteCreateOutcome,
  NoteCreateResponse,
  NoteDeleteResponse,
  NoteMoveResponse,
  NotePropertyRemoveResponse,
  NotePropertySetResponse,
  NotePropertyType,
  NoteRestoreResponse,
  NoteSaveResponse,
  PluginMarkdownProjectionResponse,
  RuntimeSnapshot,
  VaultAttachmentResponse,
  VaultGraphRequest,
  VaultGraphResponse,
  VaultImageResponse,
  VaultNoteEmbedResponse,
  VaultSearchResponse,
  VaultTrashResponse,
  WorkspaceFilePageRequest,
  WorkspaceFilePageResponse,
  WorkspaceTagCatalogRequest,
  WorkspaceTagCatalogResponse,
  WorkspaceTreePageRequest,
  WorkspaceTreePageResponse,
  WorkspaceTreePathRequest,
  WorkspaceTreePathResponse,
} from "../shared/contracts";
import {
  createDefaultVaultWorkspaceSettings,
  type VaultWorkspaceSettings,
} from "../shared/workspace-settings";
import {
  type VaultSelectionStore,
  WorkspaceController,
  type WorkspaceRuntimeFactory,
  type WorkspaceRuntimePort,
} from "./workspace-controller";
import type { WorkspaceRuntimeOptions } from "./workspace-runtime";
import type { WorkspaceStateStore } from "./workspace-state";

class MemorySelectionStore implements VaultSelectionStore {
  value: string | null;
  readonly saved: string[] = [];
  loadError: Error | null = null;
  saveError: Error | null = null;
  loadCount = 0;

  constructor(value: string | null = null) {
    this.value = value;
  }

  async load(): Promise<string | null> {
    this.loadCount += 1;
    if (this.loadError) {
      throw this.loadError;
    }
    return this.value;
  }

  async save(vaultPath: string): Promise<void> {
    if (this.saveError) {
      throw this.saveError;
    }
    this.value = vaultPath;
    this.saved.push(vaultPath);
  }
}

function snapshotFor(options: WorkspaceRuntimeOptions, vaultPath: string, vaultId: string) {
  return {
    vault: {
      id: vaultId,
      name: path.basename(vaultPath),
      path: vaultPath,
      markdownFileCount: 0,
      mode: "kernel-backed",
      source: options.selectionSource ?? "direct",
      warning: options.warning ?? null,
    },
    plugin: null,
    commands: [],
    actions: [],
    notices: [],
    events: [],
  } satisfies RuntimeSnapshot;
}

class FakeRuntime implements WorkspaceRuntimePort {
  readonly vaultId: string;
  readonly vaultPath: string;
  readonly options: WorkspaceRuntimeOptions;
  readonly #snapshot: RuntimeSnapshot;
  workspaceSettings: VaultWorkspaceSettings = createDefaultVaultWorkspaceSettings();
  readonly #listeners = new Set<(snapshot: RuntimeSnapshot) => void>();
  imageLoader: (() => Promise<VaultImageResponse>) | null = null;
  attachmentLoader: (() => Promise<VaultAttachmentResponse>) | null = null;
  noteEmbedLoader: (() => Promise<VaultNoteEmbedResponse>) | null = null;
  renderedMarkdownProjection: {
    pluginId: string;
    sourceNotePath: string;
    content: string;
    expectedVaultId: string;
  } | null = null;
  markdownProjectionLoader: (() => Promise<PluginMarkdownProjectionResponse>) | null = null;
  closedNote: { filePath: string; expectedVaultId: string } | null = null;
  toggledTabPin: {
    filePath: string;
    paneId: "primary" | "secondary";
    expectedVaultId: string;
  } | null = null;
  movedNote: {
    filePath: string;
    targetPath: string;
    expectedRevision: string;
    expectedVaultId: string;
    confirmationId?: string;
  } | null = null;
  attachmentMoveLoader: (() => Promise<AttachmentMoveResponse>) | null = null;
  deletedNote: {
    filePath: string;
    expectedRevision: string;
    expectedVaultId: string;
  } | null = null;
  restoredNote: {
    filePath: string;
    expectedRevision: string;
    expectedVaultId: string;
  } | null = null;
  createdPluginFolder: { folderPath: string; expectedVaultId: string } | null = null;
  createdPluginNote: {
    filePath: string;
    content: string;
    expectedVaultId: string;
  } | null = null;
  renamedPluginFile: {
    filePath: string;
    targetPath: string;
    expectedRevision: string;
    expectedVaultId: string;
  } | null = null;
  trashedPluginFile: {
    filePath: string;
    expectedRevision: string;
    expectedVaultId: string;
  } | null = null;
  closed = false;

  constructor(options: WorkspaceRuntimeOptions) {
    this.options = options;
    this.vaultPath = path.resolve(options.vaultRoot);
    this.vaultId = `vault:${this.vaultPath}`;
    this.#snapshot = snapshotFor(options, this.vaultPath, this.vaultId);
  }

  async getSnapshot(): Promise<RuntimeSnapshot> {
    return this.#snapshot;
  }

  async getWorkspaceFilePage(
    request: WorkspaceFilePageRequest,
  ): Promise<WorkspaceFilePageResponse> {
    if (request.expectedVaultId !== this.vaultId) {
      return { status: "stale-vault", vaultId: this.vaultId };
    }
    return {
      status: "ready",
      vaultId: this.vaultId,
      page: {
        generation: request.generation,
        offset: request.offset,
        limit: request.limit,
        total: 0,
        complete: true,
      },
      files: [],
    };
  }

  async getWorkspaceTreePage(
    request: WorkspaceTreePageRequest,
  ): Promise<WorkspaceTreePageResponse> {
    if (request.expectedVaultId !== this.vaultId) {
      return { status: "stale-vault", vaultId: this.vaultId };
    }
    return {
      status: "ready",
      vaultId: this.vaultId,
      page: {
        generation: request.generation,
        parentPath: request.parentPath,
        offset: request.offset,
        limit: request.limit,
        total: 0,
        complete: true,
      },
      entries: [],
    };
  }

  async getWorkspaceTreePath(
    request: WorkspaceTreePathRequest,
  ): Promise<WorkspaceTreePathResponse> {
    if (request.expectedVaultId !== this.vaultId) {
      return { status: "stale-vault", vaultId: this.vaultId };
    }
    return { status: "missing", vaultId: this.vaultId };
  }

  async getWorkspaceTagCatalog(
    request: WorkspaceTagCatalogRequest,
  ): Promise<WorkspaceTagCatalogResponse> {
    if (request.expectedVaultId !== this.vaultId) {
      return { status: "stale-vault", vaultId: this.vaultId };
    }
    return {
      status: "ready",
      vaultId: this.vaultId,
      generation: request.generation,
      tags: [],
    };
  }

  async markPluginLayoutReady(): Promise<RuntimeSnapshot> {
    return this.#snapshot;
  }

  async openPluginSettings(): Promise<RuntimeSnapshot> {
    return this.#snapshot;
  }

  async openPluginView(): Promise<RuntimeSnapshot> {
    return this.#snapshot;
  }

  async closePluginView(): Promise<RuntimeSnapshot> {
    return this.#snapshot;
  }

  async searchVault(query: string): Promise<VaultSearchResponse> {
    return {
      vaultId: this.vaultId,
      indexGeneration: "test:1:1",
      census: this.#snapshot.workspace?.census ?? {
        state: "current",
        generation: 1,
        discovered: 0,
        indexed: 0,
        total: 0,
        error: null,
      },
      error: null,
      query,
      terms: query ? [query] : [],
      total: 0,
      truncated: false,
      results: [],
    };
  }

  async getVaultGraph(
    request: VaultGraphRequest,
    expectedVaultId: string,
  ): Promise<VaultGraphResponse> {
    if (expectedVaultId !== this.vaultId) {
      return { status: "stale-vault", vaultId: this.vaultId };
    }
    return {
      status: "ready",
      vaultId: this.vaultId,
      indexGeneration: "test:1:1",
      census: this.#snapshot.workspace?.census ?? {
        state: "current",
        generation: 1,
        discovered: 0,
        indexed: 0,
        total: 0,
        error: null,
      },
      ...request,
      totalNodes: 0,
      totalEdges: 0,
      truncated: false,
      nodes: [],
      edges: [],
    };
  }

  async getVaultTrash(expectedVaultId: string): Promise<VaultTrashResponse> {
    if (expectedVaultId !== this.vaultId) {
      return { status: "stale-vault", vaultId: this.vaultId };
    }
    return {
      status: "ready",
      vaultId: this.vaultId,
      total: 1,
      truncated: false,
      entries: [
        {
          path: "Notes/Recovered.md",
          trashPath: ".trash/Notes/Recovered.md",
          revision: "c".repeat(64),
          size: 9,
        },
      ],
    };
  }

  async loadVaultImage(): Promise<VaultImageResponse> {
    if (this.imageLoader) {
      return this.imageLoader();
    }
    return {
      status: "ready",
      vaultId: this.vaultId,
      path: "image.png",
      mimeType: "image/png",
      size: 1,
      revision: "a".repeat(64),
      base64: "AA==",
    };
  }

  async loadVaultAttachment(): Promise<VaultAttachmentResponse> {
    if (this.attachmentLoader) {
      return this.attachmentLoader();
    }
    return {
      status: "ready",
      vaultId: this.vaultId,
      attachment: {
        path: "report.pdf",
        kind: "pdf",
        mimeType: "application/pdf",
        size: 1,
        revision: "b".repeat(64),
        actions: { open: true, reveal: true, move: true, inline: false },
      },
    };
  }

  async loadVaultNoteEmbed(): Promise<VaultNoteEmbedResponse> {
    if (this.noteEmbedLoader) {
      return this.noteEmbedLoader();
    }
    return {
      status: "ready",
      vaultId: this.vaultId,
      path: "Embedded.md",
      revision: "a".repeat(64),
      sourceSize: 10,
      contentBytes: 10,
      content: "# Embedded",
      startLine: 1,
      endLine: 1,
      kind: "note",
      subpath: null,
      links: [],
    };
  }

  async renderPluginMarkdownProjection(
    pluginId: string,
    sourceNotePath: string,
    content: string,
    expectedVaultId: string,
  ): Promise<PluginMarkdownProjectionResponse> {
    this.renderedMarkdownProjection = { pluginId, sourceNotePath, content, expectedVaultId };
    if (this.markdownProjectionLoader) {
      return this.markdownProjectionLoader();
    }
    if (expectedVaultId !== this.vaultId) {
      return { status: "stale-vault", vaultId: this.vaultId };
    }
    return {
      status: "unavailable",
      vaultId: this.vaultId,
      pluginId,
      reason: "plugin-disabled",
      message: `${pluginId} is not currently active in the compatibility runtime.`,
    };
  }

  async openNote(): Promise<RuntimeSnapshot> {
    return this.#snapshot;
  }

  async goBack(): Promise<RuntimeSnapshot> {
    return this.#snapshot;
  }

  async goForward(): Promise<RuntimeSnapshot> {
    return this.#snapshot;
  }

  getWorkspaceSettings(): VaultWorkspaceSettings {
    return { ...this.workspaceSettings };
  }

  setWorkspaceSettings(settings: VaultWorkspaceSettings): void {
    this.workspaceSettings = { ...settings };
  }

  async closeNote(filePath: string, expectedVaultId: string): Promise<RuntimeSnapshot> {
    this.closedNote = { filePath, expectedVaultId };
    return this.#snapshot;
  }

  async toggleTabPin(
    filePath: string,
    paneId: "primary" | "secondary",
    expectedVaultId: string,
  ): Promise<RuntimeSnapshot> {
    this.toggledTabPin = { filePath, paneId, expectedVaultId };
    return this.#snapshot;
  }

  async splitWorkspace(): Promise<RuntimeSnapshot> {
    return this.#snapshot;
  }

  async focusWorkspacePane(): Promise<RuntimeSnapshot> {
    return this.#snapshot;
  }

  async closeWorkspacePane(): Promise<RuntimeSnapshot> {
    return this.#snapshot;
  }

  async moveNoteToWorkspacePane(): Promise<RuntimeSnapshot> {
    return this.#snapshot;
  }

  async reorderWorkspaceTab(): Promise<RuntimeSnapshot> {
    return this.#snapshot;
  }

  async moveNote(
    filePath: string,
    targetPath: string,
    expectedRevision: string,
    expectedVaultId: string,
    confirmationId?: string,
  ): Promise<NoteMoveResponse> {
    this.movedNote = {
      filePath,
      targetPath,
      expectedRevision,
      expectedVaultId,
      ...(confirmationId ? { confirmationId } : {}),
    };
    return {
      outcome: {
        status: "committed",
        from: filePath,
        to: targetPath,
        transactionId: "move",
        rewrites: [],
        writes: [],
      },
      snapshot: this.#snapshot,
    };
  }

  async moveAttachment(
    filePath: string,
    targetPath: string,
    expectedRevision: string,
    expectedVaultId: string,
    confirmationId?: string,
  ): Promise<AttachmentMoveResponse> {
    if (this.attachmentMoveLoader) return this.attachmentMoveLoader();
    return {
      outcome: {
        status: "published-source-retained",
        from: filePath,
        to: targetPath,
        transactionId: "attachment-move",
        rewrites: [],
        writes: [],
      },
      snapshot: this.#snapshot,
    };
  }

  async deleteNote(
    filePath: string,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<NoteDeleteResponse> {
    this.deletedNote = { filePath, expectedRevision, expectedVaultId };
    return {
      outcome: {
        status: "committed",
        from: filePath,
        to: `.trash/${filePath}`,
        transactionId: "delete",
      },
      snapshot: this.#snapshot,
    };
  }

  async restoreNote(
    filePath: string,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<NoteRestoreResponse> {
    this.restoredNote = { filePath, expectedRevision, expectedVaultId };
    return {
      outcome: {
        status: "committed",
        from: `.trash/${filePath}`,
        to: filePath,
        transactionId: "restore",
      },
      snapshot: this.#snapshot,
    };
  }

  async createNote(
    filePath: string,
    _content: string,
    _expectedVaultId: string,
  ): Promise<NoteCreateResponse> {
    return {
      outcome: {
        status: "committed",
        path: filePath,
        revision: "a".repeat(64),
        transactionId: "create",
      },
      snapshot: this.#snapshot,
    };
  }

  async openDailyNote(): Promise<NoteCreateResponse> {
    return {
      outcome: {
        status: "committed",
        path: "2026-08-12.md",
        revision: "a".repeat(64),
        transactionId: "daily",
      },
      snapshot: this.#snapshot,
    };
  }

  async listNoteTemplates(): Promise<string[]> {
    return ["Templates/Daily.md"];
  }

  async renderNoteTemplate() {
    return {
      content: "rendered template",
      sourcePath: "Templates/Daily.md",
      sourceRevision: "a".repeat(64),
      size: 17,
    };
  }

  formatNoteWorkflowValue(value: "date" | "time"): string {
    return value === "date" ? "2026-08-12" : "18:07";
  }

  async createPluginNote(
    filePath: string,
    content: string,
    expectedVaultId: string,
  ): Promise<NoteCreateOutcome> {
    this.createdPluginNote = { filePath, content, expectedVaultId };
    return {
      status: "committed",
      path: filePath,
      revision: "a".repeat(64),
      transactionId: "plugin-create",
    };
  }

  async createPluginFile(
    filePath: string,
    _content: Uint8Array,
    _expectedVaultId: string,
  ): Promise<NoteCreateOutcome> {
    return {
      status: "committed",
      path: filePath,
      revision: "a".repeat(64),
      transactionId: "plugin-file-create",
    };
  }

  async writePluginFile(
    filePath: string,
    _content: Uint8Array,
    _expectedRevision: string,
    _expectedVaultId: string,
  ) {
    return {
      status: "committed" as const,
      path: filePath,
      revision: "a".repeat(64),
      transactionId: "plugin-file-write",
    };
  }

  async renamePluginFile(
    filePath: string,
    targetPath: string,
    expectedRevision: string,
    expectedVaultId: string,
  ) {
    this.renamedPluginFile = { filePath, targetPath, expectedRevision, expectedVaultId };
    return {
      status: "committed" as const,
      from: filePath,
      to: targetPath,
      transactionId: "plugin-file-rename",
    };
  }

  async trashPluginFile(filePath: string, expectedRevision: string, expectedVaultId: string) {
    this.trashedPluginFile = { filePath, expectedRevision, expectedVaultId };
    return {
      status: "committed" as const,
      from: filePath,
      to: `.trash/${filePath}`,
      transactionId: "plugin-file-trash",
    };
  }

  async createPluginFolder(folderPath: string, expectedVaultId: string) {
    this.createdPluginFolder = { folderPath, expectedVaultId };
    return { path: folderPath, created: true };
  }

  async saveNote(
    filePath: string,
    _content: string,
    _expectedRevision: string,
    _expectedVaultId: string,
  ): Promise<NoteSaveResponse> {
    return {
      outcome: {
        status: "committed",
        path: filePath,
        revision: "a".repeat(64),
        transactionId: "save",
      },
      snapshot: this.#snapshot,
    };
  }

  async setNoteProperty(
    filePath: string,
    name: string,
    _rawValue: string,
    type: NotePropertyType,
    _expectedRevision: string,
    _expectedVaultId: string,
  ): Promise<NotePropertySetResponse> {
    return {
      outcome: {
        status: "committed",
        path: filePath,
        revision: "a".repeat(64),
        transactionId: "set-property",
        name,
        type,
        value: "value",
      },
      snapshot: this.#snapshot,
    };
  }

  async removeNoteProperty(
    filePath: string,
    name: string,
    _expectedRevision: string,
    _expectedVaultId: string,
  ): Promise<NotePropertyRemoveResponse> {
    return {
      outcome: {
        status: "committed",
        path: filePath,
        revision: "a".repeat(64),
        transactionId: "remove-property",
        name,
      },
      snapshot: this.#snapshot,
    };
  }

  async runPluginCommand(): Promise<RuntimeSnapshot> {
    return this.#snapshot;
  }

  async waitForPluginMutations(): Promise<RuntimeSnapshot> {
    return this.#snapshot;
  }

  async loadPlugin(): Promise<RuntimeSnapshot> {
    return this.#snapshot;
  }

  async reloadPlugin(): Promise<RuntimeSnapshot> {
    return this.#snapshot;
  }

  async unloadPlugin(): Promise<RuntimeSnapshot> {
    return this.#snapshot;
  }

  async unloadAllPlugins(): Promise<RuntimeSnapshot> {
    return this.#snapshot;
  }

  onSnapshot(listener: (snapshot: RuntimeSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(): void {
    for (const listener of this.#listeners) {
      listener(this.#snapshot);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.#listeners.clear();
  }
}

function runtimeHarness(failingPaths: string[] = []) {
  const runtimes: FakeRuntime[] = [];
  const optionsSeen: WorkspaceRuntimeOptions[] = [];
  const runtimeFactory: WorkspaceRuntimeFactory = async (options) => {
    optionsSeen.push(options);
    if (
      failingPaths
        .map((candidate) => path.resolve(candidate))
        .includes(path.resolve(options.vaultRoot))
    ) {
      throw new Error(`Unavailable vault: ${options.vaultRoot}`);
    }
    const runtime = new FakeRuntime(options);
    runtimes.push(runtime);
    return runtime;
  };
  return { runtimeFactory, runtimes, optionsSeen };
}

const fixtureVaultPath = "/fixtures/basic";
const stateRoot = new FixedStateRoot("/state");

describe("WorkspaceController", () => {
  it("returns the bundled runtime before a configured vault begins its deferred open", async () => {
    const store = new MemorySelectionStore("/restored/vault");
    const harness = runtimeHarness();
    const pluginRuntimeFactory: PluginRuntimeFactory = async () => {
      throw new Error("The controller harness should only preserve this factory.");
    };
    const beforeWorkspaceStateRestore = async (): Promise<void> => undefined;
    const controller = await WorkspaceController.open({
      stateRoot,
      selectionStore: store,
      fixtureVaultPath,
      fixturePluginDirectory: "/fixtures/basic/.obsidian/plugins/fixture",
      configuredVaultPath: "/configured/vault",
      configuredPluginDirectory: "/configured/vault/.obsidian/plugins/fixture",
      deferInitialVault: true,
      pluginRuntimeFactory,
      beforeWorkspaceStateRestore,
      runtimeFactory: harness.runtimeFactory,
    });

    expect(store.loadCount).toBe(0);
    expect(store.saved).toEqual([]);
    expect(harness.optionsSeen).toHaveLength(1);
    expect(harness.optionsSeen[0]).toMatchObject({
      vaultRoot: fixtureVaultPath,
      selectionSource: "bundled",
    });
    expect(harness.optionsSeen[0]?.pluginDirectory).toBeUndefined();
    expect(harness.optionsSeen[0]?.pluginRuntimeFactory).toBeUndefined();
    expect(harness.optionsSeen[0]?.beforeWorkspaceStateRestore).toBeUndefined();
    expect(await controller.getSnapshot()).toMatchObject({
      vault: { path: path.resolve(fixtureVaultPath), source: "bundled" },
      startup: {
        phase: "opening",
        source: "environment",
        targetName: "vault",
        targetPath: "/configured/vault",
      },
    });
    expect(() => controller.searchVault("fixture")).toThrow("vault is still opening");
    expect(() =>
      controller.createNote("Bootstrap.md", "must not write", controller.vaultId),
    ).toThrow("vault is still opening");

    const outcome = await controller.activateDeferredInitialVault();

    expect(outcome).toMatchObject({
      status: "activated",
      snapshot: {
        vault: { path: path.resolve("/configured/vault"), source: "environment" },
      },
    });
    expect(outcome.snapshot?.startup).toBeUndefined();
    expect(harness.optionsSeen[1]).toMatchObject({
      vaultRoot: "/configured/vault",
      selectionSource: "environment",
      pluginDirectory: "/configured/vault/.obsidian/plugins/fixture",
    });
    expect(harness.optionsSeen[1]?.pluginRuntimeFactory).toBe(pluginRuntimeFactory);
    expect(harness.optionsSeen[1]?.beforeWorkspaceStateRestore).toBe(beforeWorkspaceStateRestore);
    expect(store.saved).toEqual([]);
    expect(harness.runtimes[0]?.closed).toBe(true);
    await expect(controller.searchVault("configured")).resolves.toMatchObject({
      vaultId: controller.vaultId,
      query: "configured",
    });
    await controller.close();
  });

  it("reports deferred restoration failure without replacing the bundled runtime", async () => {
    const store = new MemorySelectionStore("/missing/vault");
    const harness = runtimeHarness(["/missing/vault"]);
    const controller = await WorkspaceController.open({
      stateRoot,
      selectionStore: store,
      fixtureVaultPath,
      deferInitialVault: true,
      runtimeFactory: harness.runtimeFactory,
    });
    const fixtureRuntime = harness.runtimes[0];

    const outcome = await controller.activateDeferredInitialVault();

    expect(outcome.status).toBe("failed");
    expect(outcome.snapshot).toMatchObject({
      vault: {
        path: path.resolve(fixtureVaultPath),
        source: "bundled",
        warning: expect.stringContaining("Could not restore /missing/vault"),
      },
    });
    expect(outcome.snapshot?.startup).toBeUndefined();
    expect(controller.vaultPath).toBe(path.resolve(fixtureVaultPath));
    expect(fixtureRuntime?.closed).toBe(false);
    expect(store.saved).toEqual([]);
    await controller.close();
  });

  it("does not let a deferred restore replace a vault picked while it was opening", async () => {
    const store = new MemorySelectionStore("/restored/vault");
    const optionsSeen: WorkspaceRuntimeOptions[] = [];
    const runtimes: FakeRuntime[] = [];
    let releaseRestore: (() => void) | undefined;
    const restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    const runtimeFactory: WorkspaceRuntimeFactory = async (options) => {
      optionsSeen.push(options);
      if (path.resolve(options.vaultRoot) === path.resolve("/restored/vault")) {
        await restoreGate;
      }
      const runtime = new FakeRuntime(options);
      runtimes.push(runtime);
      return runtime;
    };
    const controller = await WorkspaceController.open({
      stateRoot,
      selectionStore: store,
      fixtureVaultPath,
      deferInitialVault: true,
      runtimeFactory,
    });

    const activation = controller.activateDeferredInitialVault();
    for (let attempt = 0; attempt < 5 && optionsSeen.length < 2; attempt += 1) {
      await Promise.resolve();
    }
    expect(optionsSeen.at(-1)?.vaultRoot).toBe("/restored/vault");

    const picked = await controller.switchVault("/picked/vault");
    releaseRestore?.();
    const outcome = await activation;

    expect(picked.vault).toMatchObject({ path: "/picked/vault", source: "picked" });
    expect(outcome).toEqual({ status: "superseded", snapshot: null });
    expect(controller.vaultPath).toBe(path.resolve("/picked/vault"));
    expect(store.saved).toEqual(["/picked/vault"]);
    const restoredRuntime = runtimes.find(
      (runtime) => runtime.vaultPath === path.resolve("/restored/vault"),
    );
    expect(restoredRuntime?.closed).toBe(true);
    await controller.close();
  });

  it("gives an explicit environment vault priority without persisting it", async () => {
    const store = new MemorySelectionStore("/restored/vault");
    const harness = runtimeHarness();
    const controller = await WorkspaceController.open({
      stateRoot,
      selectionStore: store,
      fixtureVaultPath,
      fixturePluginDirectory: "/fixtures/basic/.obsidian/plugins/fixture",
      configuredVaultPath: "/configured/vault",
      configuredPluginDirectory: "/configured/vault/.obsidian/plugins/fixture",
      runtimeFactory: harness.runtimeFactory,
    });

    expect(store.loadCount).toBe(0);
    expect(store.saved).toEqual([]);
    expect(harness.optionsSeen[0]).toMatchObject({
      vaultRoot: "/configured/vault",
      selectionSource: "environment",
      pluginDirectory: "/configured/vault/.obsidian/plugins/fixture",
    });
    expect((await controller.getSnapshot()).vault.source).toBe("environment");
    await controller.close();
  });

  it("restores a saved vault without auto-loading a compatibility plugin", async () => {
    const store = new MemorySelectionStore("/restored/vault");
    const harness = runtimeHarness();
    const controller = await WorkspaceController.open({
      stateRoot,
      selectionStore: store,
      fixtureVaultPath,
      fixturePluginDirectory: "/fixtures/basic/.obsidian/plugins/fixture",
      runtimeFactory: harness.runtimeFactory,
    });

    expect(harness.optionsSeen[0]).toMatchObject({
      vaultRoot: "/restored/vault",
      selectionSource: "restored",
    });
    expect(harness.optionsSeen[0]?.pluginDirectory).toBeUndefined();
    expect((await controller.getSnapshot()).vault.warning).toBeNull();
    await controller.close();
  });

  it("fails loudly back to the bundled vault when restoration is unavailable", async () => {
    const store = new MemorySelectionStore("/missing/vault");
    const harness = runtimeHarness(["/missing/vault"]);
    const controller = await WorkspaceController.open({
      stateRoot,
      selectionStore: store,
      fixtureVaultPath,
      fixturePluginDirectory: "/fixtures/basic/.obsidian/plugins/fixture",
      runtimeFactory: harness.runtimeFactory,
    });

    const snapshot = await controller.getSnapshot();
    expect(harness.optionsSeen).toHaveLength(2);
    expect(snapshot.vault).toMatchObject({
      path: path.resolve(fixtureVaultPath),
      source: "bundled",
    });
    expect(snapshot.vault.warning).toContain("Could not restore /missing/vault");
    expect(store.value).toBe("/missing/vault");
    await controller.close();
  });

  it("fails loudly back to the bundled vault when saved selection state is malformed", async () => {
    const store = new MemorySelectionStore();
    store.loadError = new Error("invalid selection document");
    const harness = runtimeHarness();
    const controller = await WorkspaceController.open({
      stateRoot,
      selectionStore: store,
      fixtureVaultPath,
      fixturePluginDirectory: "/fixtures/basic/.obsidian/plugins/fixture",
      runtimeFactory: harness.runtimeFactory,
    });

    const snapshot = await controller.getSnapshot();
    expect(snapshot.vault).toMatchObject({
      path: path.resolve(fixtureVaultPath),
      source: "bundled",
    });
    expect(snapshot.vault.warning).toContain(
      "Could not read the saved vault selection: invalid selection document",
    );
    await controller.close();
  });

  it("validates and persists a picked vault before adopting it", async () => {
    const store = new MemorySelectionStore();
    const harness = runtimeHarness();
    const workspaceStateStore: WorkspaceStateStore = {
      load: async () => null,
      save: async (state) => state,
    };
    const pluginModuleResolver = createRequire(path.resolve("package.json"));
    const pluginRuntimeFactory: PluginRuntimeFactory = async () => {
      throw new Error("The controller harness should only preserve this factory.");
    };
    const controller = await WorkspaceController.open({
      stateRoot,
      selectionStore: store,
      fixtureVaultPath,
      workspaceStateStore,
      pluginModuleResolver,
      pluginRuntimeFactory,
      runtimeFactory: harness.runtimeFactory,
    });
    const previous = harness.runtimes[0];
    const observed: string[] = [];
    controller.onSnapshot((snapshot) => observed.push(snapshot.vault.path));

    const switched = await controller.switchVault("/picked/vault");

    expect(switched.vault).toMatchObject({
      path: "/picked/vault",
      source: "picked",
      warning: null,
    });
    expect(store.saved).toEqual(["/picked/vault"]);
    expect(harness.optionsSeen[0]?.workspaceStateStore).toBe(workspaceStateStore);
    expect(harness.optionsSeen[1]?.workspaceStateStore).toBe(workspaceStateStore);
    expect(harness.optionsSeen[0]?.pluginModuleResolver).toBe(pluginModuleResolver);
    expect(harness.optionsSeen[1]?.pluginModuleResolver).toBe(pluginModuleResolver);
    expect(harness.optionsSeen[0]?.pluginRuntimeFactory).toBe(pluginRuntimeFactory);
    expect(harness.optionsSeen[1]?.pluginRuntimeFactory).toBe(pluginRuntimeFactory);
    expect(previous?.closed).toBe(true);
    expect(observed).toEqual(["/picked/vault"]);
    harness.runtimes[1]?.emit();
    expect(observed).toEqual(["/picked/vault", "/picked/vault"]);
    previous?.emit();
    expect(observed).toEqual(["/picked/vault", "/picked/vault"]);
    await controller.close();
  });

  it("keeps the current runtime when persistence of a picked vault fails", async () => {
    const store = new MemorySelectionStore();
    store.saveError = new Error("selection store unavailable");
    const harness = runtimeHarness();
    const controller = await WorkspaceController.open({
      stateRoot,
      selectionStore: store,
      fixtureVaultPath,
      runtimeFactory: harness.runtimeFactory,
    });

    await expect(controller.switchVault("/picked/vault")).rejects.toThrow(
      "selection store unavailable",
    );
    expect(controller.vaultPath).toBe(path.resolve(fixtureVaultPath));
    expect(harness.runtimes[0]?.closed).toBe(false);
    expect(harness.runtimes[1]?.closed).toBe(true);
    await controller.close();
  });

  it("keeps the current runtime when a picked vault cannot open", async () => {
    const store = new MemorySelectionStore();
    const harness = runtimeHarness(["/missing/vault"]);
    const controller = await WorkspaceController.open({
      stateRoot,
      selectionStore: store,
      fixtureVaultPath,
      runtimeFactory: harness.runtimeFactory,
    });

    await expect(controller.switchVault("/missing/vault")).rejects.toThrow("Unavailable vault");
    expect(controller.vaultPath).toBe(path.resolve(fixtureVaultPath));
    expect(store.saved).toEqual([]);
    expect(harness.runtimes).toHaveLength(1);
    await controller.close();
  });

  it("forwards tab closure with the active vault identity", async () => {
    const store = new MemorySelectionStore();
    const harness = runtimeHarness();
    const controller = await WorkspaceController.open({
      stateRoot,
      selectionStore: store,
      fixtureVaultPath,
      runtimeFactory: harness.runtimeFactory,
    });
    const expectedVaultId = controller.vaultId;

    await controller.closeNote("Notes/Current.md", expectedVaultId);

    expect(harness.runtimes[0]?.closedNote).toEqual({
      filePath: "Notes/Current.md",
      expectedVaultId,
    });
    await controller.close();
  });

  it("forwards a settled Markdown projection request with exact arguments and returns the runtime's result verbatim", async () => {
    const store = new MemorySelectionStore();
    const harness = runtimeHarness();
    const controller = await WorkspaceController.open({
      stateRoot,
      selectionStore: store,
      fixtureVaultPath,
      runtimeFactory: harness.runtimeFactory,
    });
    const expectedVaultId = controller.vaultId;
    const firstRuntime = harness.runtimes[0];
    if (!firstRuntime) {
      throw new Error("Expected the initial runtime.");
    }
    const distinctiveResult: PluginMarkdownProjectionResponse = {
      status: "ready",
      vaultId: expectedVaultId,
      pluginId: "cite",
      sourcePath: "Notes/Citations.md",
      contentSha256: "b".repeat(64),
      html: "<p>distinctive settled markup</p>",
      postProcessorCount: 1,
    };
    firstRuntime.markdownProjectionLoader = () => Promise.resolve(distinctiveResult);

    const response = await controller.renderPluginMarkdownProjection(
      "cite",
      "Notes/Citations.md",
      "[cite: Doe 2024]",
      expectedVaultId,
    );

    expect(firstRuntime.renderedMarkdownProjection).toEqual({
      pluginId: "cite",
      sourceNotePath: "Notes/Citations.md",
      content: "[cite: Doe 2024]",
      expectedVaultId,
    });
    expect(response).toBe(distinctiveResult);
    await controller.close();
  });

  it("forwards a tab pin toggle with its pane membership and active vault identity", async () => {
    const store = new MemorySelectionStore();
    const harness = runtimeHarness();
    const controller = await WorkspaceController.open({
      stateRoot,
      selectionStore: store,
      fixtureVaultPath,
      runtimeFactory: harness.runtimeFactory,
    });
    const expectedVaultId = controller.vaultId;

    await controller.toggleTabPin("Notes/Current.md", "secondary", expectedVaultId);

    expect(harness.runtimes[0]?.toggledTabPin).toEqual({
      filePath: "Notes/Current.md",
      paneId: "secondary",
      expectedVaultId,
    });
    await controller.close();
  });

  it("forwards a note move with its revision and active vault identity", async () => {
    const store = new MemorySelectionStore();
    const harness = runtimeHarness();
    const controller = await WorkspaceController.open({
      stateRoot,
      selectionStore: store,
      fixtureVaultPath,
      runtimeFactory: harness.runtimeFactory,
    });
    const expectedVaultId = controller.vaultId;
    const expectedRevision = "a".repeat(64);
    const confirmationId = "b".repeat(64);

    await controller.moveNote(
      "Notes/Current.md",
      "Archive/Current.md",
      expectedRevision,
      expectedVaultId,
      confirmationId,
    );

    expect(harness.runtimes[0]?.movedNote).toEqual({
      filePath: "Notes/Current.md",
      targetPath: "Archive/Current.md",
      expectedRevision,
      expectedVaultId,
      confirmationId,
    });
    await controller.close();
  });

  it("reports a source-retaining attachment publication from a runtime replaced before its reply", async () => {
    const store = new MemorySelectionStore();
    const harness = runtimeHarness();
    const controller = await WorkspaceController.open({
      stateRoot,
      selectionStore: store,
      fixtureVaultPath,
      runtimeFactory: harness.runtimeFactory,
    });
    const oldRuntime = harness.runtimes[0];
    if (!oldRuntime) throw new Error("Expected the bundled runtime.");
    const oldVaultId = controller.vaultId;
    oldRuntime.attachmentMoveLoader = async () => {
      await controller.switchVault("/replacement/vault");
      return {
        outcome: {
          status: "published-source-retained",
          from: "Assets/report.pdf",
          to: "Archive/report.pdf",
          transactionId: "attachment-move",
          rewrites: [],
          writes: [],
        },
        snapshot: await oldRuntime.getSnapshot(),
      };
    };

    const response = await controller.moveAttachment(
      "Assets/report.pdf",
      "Archive/report.pdf",
      "a".repeat(64),
      oldVaultId,
    );

    expect(response).toMatchObject({
      outcome: { status: "published-source-retained", to: "Archive/report.pdf" },
      snapshot: { vault: { path: path.resolve("/replacement/vault") } },
      committedVaultId: oldVaultId,
      committedVaultName: path.basename(path.resolve(fixtureVaultPath)),
    });
    await controller.close();
  });

  it("forwards a recoverable note deletion with its revision and active vault identity", async () => {
    const store = new MemorySelectionStore();
    const harness = runtimeHarness();
    const controller = await WorkspaceController.open({
      stateRoot,
      selectionStore: store,
      fixtureVaultPath,
      runtimeFactory: harness.runtimeFactory,
    });
    const expectedVaultId = controller.vaultId;
    const expectedRevision = "a".repeat(64);

    await controller.deleteNote("Notes/Current.md", expectedRevision, expectedVaultId);

    expect(harness.runtimes[0]?.deletedNote).toEqual({
      filePath: "Notes/Current.md",
      expectedRevision,
      expectedVaultId,
    });
    await controller.close();
  });

  it("guards trash inspection by vault identity and forwards exact restore evidence", async () => {
    const store = new MemorySelectionStore();
    const harness = runtimeHarness();
    const controller = await WorkspaceController.open({
      stateRoot,
      selectionStore: store,
      fixtureVaultPath,
      runtimeFactory: harness.runtimeFactory,
    });
    const expectedVaultId = controller.vaultId;
    const expectedRevision = "c".repeat(64);

    await expect(controller.getVaultTrash("stale-vault")).resolves.toEqual({
      status: "stale-vault",
      vaultId: expectedVaultId,
    });
    await expect(controller.getVaultTrash(expectedVaultId)).resolves.toMatchObject({
      status: "ready",
      total: 1,
      entries: [{ path: "Notes/Recovered.md", revision: expectedRevision }],
    });
    await controller.restoreNote("Notes/Recovered.md", expectedRevision, expectedVaultId);

    expect(harness.runtimes[0]?.restoredNote).toEqual({
      filePath: "Notes/Recovered.md",
      expectedRevision,
      expectedVaultId,
    });
    await controller.close();
  });

  it("forwards plugin file mutations with the active vault identity", async () => {
    const store = new MemorySelectionStore();
    const harness = runtimeHarness();
    const controller = await WorkspaceController.open({
      stateRoot,
      selectionStore: store,
      fixtureVaultPath,
      runtimeFactory: harness.runtimeFactory,
    });
    const expectedVaultId = controller.vaultId;
    const expectedRevision = "b".repeat(64);

    await controller.createPluginFolder("Excalidraw", expectedVaultId);
    await controller.createPluginNote(
      "Excalidraw/Drawing.excalidraw.md",
      "drawing bytes",
      expectedVaultId,
    );
    await controller.renamePluginFile(
      "Excalidraw/Drawing.png",
      "Assets/Drawing.png",
      expectedRevision,
      expectedVaultId,
    );
    await controller.trashPluginFile("Assets/Drawing.png", expectedRevision, expectedVaultId);

    expect(harness.runtimes[0]?.createdPluginFolder).toEqual({
      folderPath: "Excalidraw",
      expectedVaultId,
    });
    expect(harness.runtimes[0]?.createdPluginNote).toEqual({
      filePath: "Excalidraw/Drawing.excalidraw.md",
      content: "drawing bytes",
      expectedVaultId,
    });
    expect(harness.runtimes[0]?.renamedPluginFile).toEqual({
      filePath: "Excalidraw/Drawing.png",
      targetPath: "Assets/Drawing.png",
      expectedRevision,
      expectedVaultId,
    });
    expect(harness.runtimes[0]?.trashedPluginFile).toEqual({
      filePath: "Assets/Drawing.png",
      expectedRevision,
      expectedVaultId,
    });
    await controller.close();
  });

  it("rejects hidden workspace folders without tightening the generic plugin folder route", async () => {
    const store = new MemorySelectionStore();
    const harness = runtimeHarness();
    const controller = await WorkspaceController.open({
      stateRoot,
      selectionStore: store,
      fixtureVaultPath,
      runtimeFactory: harness.runtimeFactory,
    });
    const expectedVaultId = controller.vaultId;

    await expect(
      controller.createWorkspaceFolder("Projects/.navigator-hidden", expectedVaultId),
    ).rejects.toThrow("hidden");
    await expect(
      controller.createWorkspaceFolder(".navigator-hidden", expectedVaultId),
    ).rejects.toThrow("hidden");
    expect(harness.runtimes[0]?.createdPluginFolder).toBeNull();

    await controller.createPluginFolder("Projects/.plugin-private", expectedVaultId);
    expect(harness.runtimes[0]?.createdPluginFolder).toEqual({
      folderPath: "Projects/.plugin-private",
      expectedVaultId,
    });
    await controller.close();
  });

  it("rejects an image response that completes after the active vault changes", async () => {
    const store = new MemorySelectionStore();
    const harness = runtimeHarness();
    const controller = await WorkspaceController.open({
      stateRoot,
      selectionStore: store,
      fixtureVaultPath,
      runtimeFactory: harness.runtimeFactory,
    });
    const firstRuntime = harness.runtimes[0];
    if (!firstRuntime) {
      throw new Error("Expected the initial runtime.");
    }
    let releaseImage: ((response: VaultImageResponse) => void) | undefined;
    firstRuntime.imageLoader = () =>
      new Promise<VaultImageResponse>((resolve) => {
        releaseImage = resolve;
      });

    const pending = controller.loadVaultImage("Current.md", "image.png", firstRuntime.vaultId);
    await controller.switchVault("/picked/vault");
    releaseImage?.({
      status: "ready",
      vaultId: firstRuntime.vaultId,
      path: "image.png",
      mimeType: "image/png",
      size: 1,
      revision: "b".repeat(64),
      base64: "AA==",
    });

    await expect(pending).resolves.toEqual({
      status: "stale-vault",
      vaultId: harness.runtimes[1]?.vaultId,
    });
    await controller.close();
  });

  it("rejects a note embed response that completes after the active vault changes", async () => {
    const store = new MemorySelectionStore();
    const harness = runtimeHarness();
    const controller = await WorkspaceController.open({
      stateRoot,
      selectionStore: store,
      fixtureVaultPath,
      runtimeFactory: harness.runtimeFactory,
    });
    const firstRuntime = harness.runtimes[0];
    if (!firstRuntime) {
      throw new Error("Expected the initial runtime.");
    }
    let releaseEmbed: ((response: VaultNoteEmbedResponse) => void) | undefined;
    firstRuntime.noteEmbedLoader = () =>
      new Promise<VaultNoteEmbedResponse>((resolve) => {
        releaseEmbed = resolve;
      });

    const pending = controller.loadVaultNoteEmbed(
      "Current.md",
      "Embedded",
      null,
      firstRuntime.vaultId,
    );
    await controller.switchVault("/picked/vault");
    releaseEmbed?.({
      status: "ready",
      vaultId: firstRuntime.vaultId,
      path: "Embedded.md",
      revision: "b".repeat(64),
      sourceSize: 10,
      contentBytes: 10,
      content: "# Embedded",
      startLine: 1,
      endLine: 1,
      kind: "note",
      subpath: null,
      links: [],
    });

    await expect(pending).resolves.toEqual({
      status: "stale-vault",
      vaultId: harness.runtimes[1]?.vaultId,
    });
    await controller.close();
  });
});
