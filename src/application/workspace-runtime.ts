import { SearchQueryError } from "../kernel/full-text-search";
import { type DocumentMetadataSnapshot, VaultIndexReactor } from "../kernel/metadata-index";
import { captureVaultBootstrap, NodeVaultWatcher } from "../kernel/node-vault-watcher";
import { displayTitleFromVaultPath, normalizeMarkdownNotePath } from "../kernel/note-path";
import { hasPrivateVaultSegment, normalizeVaultPath } from "../kernel/path-policy";
import type {
  StateRootPort,
  VaultDirectoryCreateResult,
  VaultRenameResult,
  VaultWriteResult,
} from "../kernel/ports";
import { VaultKernel } from "../kernel/vault-kernel";
import type { VaultChangeBatch } from "../kernel/watch-protocol";
import { PluginHost, type PluginModuleResolver } from "../runtime/plugin-host";
import type { PluginRuntimeFactory, PluginRuntimePort } from "../runtime/plugin-runtime-port";
import type {
  NoteCreateOutcome,
  NoteCreateResponse,
  NoteDeleteOutcome,
  NoteDeleteResponse,
  NoteMoveOutcome,
  NoteMoveResponse,
  NoteSaveOutcome,
  NoteSaveResponse,
  PluginEditorContext,
  RuntimeSnapshot,
  VaultImageResponse,
  VaultSearchResponse,
  VaultSelectionSource,
  WorkspaceFileSummary,
  WorkspaceLinkSummary,
  WorkspaceNoteSnapshot,
} from "../shared/contracts";
import { ActionRegistry } from "./action-registry";
import { createMarkdownNote } from "./note-creation";
import { movedMarkdownPath, moveMarkdownNote } from "./note-move";
import { trashMarkdownNote, vaultTrashDirectory } from "./note-trash";
import { loadVaultImage } from "./vault-image-service";
import {
  createWorkspaceState,
  type PersistedWorkspaceState,
  type WorkspaceStateStore,
} from "./workspace-state";

export interface WorkspaceRuntimeOptions {
  vaultRoot: string;
  stateRoot: StateRootPort;
  pluginDirectory?: string;
  pluginModuleResolver?: PluginModuleResolver;
  pluginRuntimeFactory?: PluginRuntimeFactory;
  selectionSource?: VaultSelectionSource;
  warning?: string | null;
  workspaceStateStore?: WorkspaceStateStore;
}

type SnapshotListener = (snapshot: RuntimeSnapshot) => void;

interface WorkspaceIndexProjection {
  generation: number;
  documents: Map<string, DocumentMetadataSnapshot>;
  backlinks: Map<string, string[]>;
  files: WorkspaceFileSummary[];
}

interface SaveNoteRequest {
  path: string;
  content: string;
  expectedRevision: string;
  expectedVaultId: string;
}

interface CreateNoteRequest {
  path: string;
  content: string;
  expectedVaultId: string;
}

interface CloseNoteRequest {
  path: string;
  expectedVaultId: string;
}

interface MoveNoteRequest {
  path: string;
  targetPath: string;
  expectedRevision: string;
  expectedVaultId: string;
  confirmationId: string | null;
}

interface DeleteNoteRequest {
  path: string;
  expectedRevision: string;
  expectedVaultId: string;
}

function parseDeleteNoteRequest(payload: unknown): DeleteNoteRequest {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("path" in payload) ||
    typeof payload.path !== "string" ||
    !("expectedRevision" in payload) ||
    typeof payload.expectedRevision !== "string" ||
    !("expectedVaultId" in payload) ||
    typeof payload.expectedVaultId !== "string"
  ) {
    throw new Error("Delete note requires string path, revision, and vault values.");
  }
  return {
    path: payload.path,
    expectedRevision: payload.expectedRevision,
    expectedVaultId: payload.expectedVaultId,
  };
}

function parseMoveNoteRequest(payload: unknown): MoveNoteRequest {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("path" in payload) ||
    typeof payload.path !== "string" ||
    !("targetPath" in payload) ||
    typeof payload.targetPath !== "string" ||
    !("expectedRevision" in payload) ||
    typeof payload.expectedRevision !== "string" ||
    !("expectedVaultId" in payload) ||
    typeof payload.expectedVaultId !== "string" ||
    ("confirmationId" in payload &&
      !(payload.confirmationId === null || typeof payload.confirmationId === "string"))
  ) {
    throw new Error(
      "Move note requires string path, target, revision, and vault values with an optional confirmation.",
    );
  }
  return {
    path: payload.path,
    targetPath: payload.targetPath,
    expectedRevision: payload.expectedRevision,
    expectedVaultId: payload.expectedVaultId,
    confirmationId:
      "confirmationId" in payload && typeof payload.confirmationId === "string"
        ? payload.confirmationId
        : null,
  };
}

function parseCloseNoteRequest(payload: unknown): CloseNoteRequest {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("path" in payload) ||
    typeof payload.path !== "string" ||
    !("expectedVaultId" in payload) ||
    typeof payload.expectedVaultId !== "string"
  ) {
    throw new Error("Close note requires string path and vault values.");
  }
  return { path: payload.path, expectedVaultId: payload.expectedVaultId };
}

function parseCreateNoteRequest(payload: unknown): CreateNoteRequest {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("path" in payload) ||
    typeof payload.path !== "string" ||
    !("content" in payload) ||
    typeof payload.content !== "string" ||
    !("expectedVaultId" in payload) ||
    typeof payload.expectedVaultId !== "string"
  ) {
    throw new Error("Create note requires string path, content, and vault values.");
  }
  return {
    path: payload.path,
    content: payload.content,
    expectedVaultId: payload.expectedVaultId,
  };
}

function parseSaveNoteRequest(payload: unknown): SaveNoteRequest {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("path" in payload) ||
    typeof payload.path !== "string" ||
    !("content" in payload) ||
    typeof payload.content !== "string" ||
    !("expectedRevision" in payload) ||
    typeof payload.expectedRevision !== "string" ||
    !("expectedVaultId" in payload) ||
    typeof payload.expectedVaultId !== "string"
  ) {
    throw new Error("Save note requires string path, content, revision, and vault values.");
  }
  return {
    path: payload.path,
    content: payload.content,
    expectedRevision: payload.expectedRevision,
    expectedVaultId: payload.expectedVaultId,
  };
}

function isWorkspaceNoteLink(link: { syntax: "wiki" | "markdown"; embed: boolean }): boolean {
  return link.syntax !== "markdown" || !link.embed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function workspaceStatesEqual(
  left: PersistedWorkspaceState,
  right: PersistedWorkspaceState,
): boolean {
  return (
    left.vaultId === right.vaultId &&
    left.activePath === right.activePath &&
    left.openPaths.length === right.openPaths.length &&
    left.openPaths.every((filePath, index) => filePath === right.openPaths[index])
  );
}

export class WorkspaceRuntime {
  readonly actions: ActionRegistry;
  readonly kernel: VaultKernel;
  readonly watcher: NodeVaultWatcher;
  readonly indexReactor: VaultIndexReactor;
  readonly pluginHost: PluginRuntimePort;
  readonly selectionSource: VaultSelectionSource;
  readonly readOnly: boolean;
  readonly #baseWarning: string | null;
  readonly #workspaceStateStore: WorkspaceStateStore | undefined;

  #activePath: string | null = null;
  #openPaths: string[] = [];
  #workspaceLoadWarning: string | null;
  #workspaceSaveWarning: string | null = null;
  #watcherError: string | null = null;
  #lastWatchSequence = 0;
  #lastRescanReason: string | null = null;
  #indexProjection: WorkspaceIndexProjection | null = null;
  readonly #listeners = new Set<SnapshotListener>();
  readonly #releaseActions: Array<() => void> = [];

  get vaultId(): string {
    return this.kernel.vaultId;
  }

  get vaultPath(): string {
    return this.kernel.paths.rootPath;
  }

  get warning(): string | null {
    const warnings = [this.#baseWarning, this.#workspaceLoadWarning, this.#workspaceSaveWarning]
      .filter((warning): warning is string => Boolean(warning))
      .join(" ");
    return warnings || null;
  }

  private constructor(
    actions: ActionRegistry,
    kernel: VaultKernel,
    watcher: NodeVaultWatcher,
    indexReactor: VaultIndexReactor,
    pluginHost: PluginRuntimePort,
    selectionSource: VaultSelectionSource,
    warning: string | null,
    workspaceStateStore: WorkspaceStateStore | undefined,
    workspaceLoadWarning: string | null,
  ) {
    this.actions = actions;
    this.kernel = kernel;
    this.watcher = watcher;
    this.indexReactor = indexReactor;
    this.pluginHost = pluginHost;
    this.selectionSource = selectionSource;
    this.readOnly = selectionSource === "bundled";
    this.#baseWarning = warning;
    this.#workspaceStateStore = workspaceStateStore;
    this.#workspaceLoadWarning = workspaceLoadWarning;
    this.#releaseActions.push(
      this.actions.register("threadleaf-workspace", {
        id: "workspace.create-note",
        name: "Create note",
        source: "workspace",
        execute: (payload) => this.createNoteThroughKernel(parseCreateNoteRequest(payload)),
      }),
      this.actions.register("threadleaf-workspace", {
        id: "workspace.open-note",
        name: "Open note",
        source: "workspace",
        execute: async (payload) => {
          if (typeof payload !== "string") {
            throw new Error("Open note requires a vault-relative Markdown path.");
          }
          await this.selectNote(payload);
        },
      }),
      this.actions.register("threadleaf-workspace", {
        id: "workspace.close-note",
        name: "Close note",
        source: "workspace",
        execute: (payload) => this.closeNoteThroughWorkspace(parseCloseNoteRequest(payload)),
      }),
      this.actions.register("threadleaf-workspace", {
        id: "workspace.move-note",
        name: "Move or rename note",
        source: "workspace",
        execute: (payload) => this.moveNoteThroughKernel(parseMoveNoteRequest(payload)),
      }),
      this.actions.register("threadleaf-workspace", {
        id: "workspace.delete-note",
        name: "Move note to trash",
        source: "workspace",
        execute: (payload) => this.deleteNoteThroughKernel(parseDeleteNoteRequest(payload)),
      }),
      this.actions.register("threadleaf-workspace", {
        id: "workspace.save-note",
        name: "Save note",
        source: "workspace",
        execute: (payload) => this.saveNoteThroughKernel(parseSaveNoteRequest(payload)),
      }),
    );
  }

  static async open(options: WorkspaceRuntimeOptions): Promise<WorkspaceRuntime> {
    const actions = new ActionRegistry();
    const kernel = await VaultKernel.open({
      vaultRoot: options.vaultRoot,
      stateRoot: options.stateRoot,
    });
    let runtime: WorkspaceRuntime | undefined;
    const bootstrap = await captureVaultBootstrap(kernel.paths);
    const watcher = NodeVaultWatcher.fromSnapshot(kernel.paths, bootstrap.snapshot, {
      onError: (error) => runtime?.recordWatcherError(error),
    });
    const indexReactor = await VaultIndexReactor.fromSnapshotsAsync(kernel, bootstrap.documents);
    bootstrap.documents.length = 0;
    const pluginHost = options.pluginRuntimeFactory
      ? await options.pluginRuntimeFactory(kernel.paths.rootPath, actions)
      : new PluginHost(
          kernel.paths.rootPath,
          kernel,
          actions,
          options.pluginModuleResolver,
          kernel,
        );
    let restoredWorkspace: PersistedWorkspaceState | null = null;
    let workspaceLoadWarning: string | null = null;
    let workspaceStateReadable = true;
    if (options.workspaceStateStore) {
      try {
        restoredWorkspace = await options.workspaceStateStore.load(kernel.vaultId);
      } catch (error) {
        workspaceStateReadable = false;
        workspaceLoadWarning = `Could not read saved workspace state: ${errorMessage(error)} The file was not changed.`;
      }
    }
    runtime = new WorkspaceRuntime(
      actions,
      kernel,
      watcher,
      indexReactor,
      pluginHost,
      options.selectionSource ?? "direct",
      options.warning ?? null,
      options.workspaceStateStore,
      workspaceLoadWarning,
    );

    if (restoredWorkspace) {
      const availablePaths = new Set(
        indexReactor.index.snapshot().documents.map((document) => document.path),
      );
      const openPaths = restoredWorkspace.openPaths.filter((filePath) =>
        availablePaths.has(filePath),
      );
      const activePath =
        restoredWorkspace.activePath && openPaths.includes(restoredWorkspace.activePath)
          ? restoredWorkspace.activePath
          : (openPaths.at(-1) ?? null);
      const restored = createWorkspaceState(kernel.vaultId, openPaths, activePath);
      runtime.applyWorkspaceState(restored);
      if (!workspaceStatesEqual(restoredWorkspace, restored)) {
        await runtime.persistWorkspaceStateBestEffort();
      }
    } else {
      const firstPath = indexReactor.index.snapshot().documents[0]?.path;
      if (firstPath) {
        runtime.activatePath(firstPath);
      }
      if (options.workspaceStateStore && workspaceStateReadable) {
        await runtime.persistWorkspaceStateBestEffort();
      }
    }
    if (options.pluginDirectory) {
      await pluginHost.loadPlugin(options.pluginDirectory);
    }
    if (!runtime.readOnly) {
      watcher.start((batch) => runtime?.handleWatchBatch(batch));
    }
    return runtime;
  }

  async getSnapshot(): Promise<RuntimeSnapshot> {
    return this.snapshotWithPluginState(await this.pluginHost.getSnapshot());
  }

  private async snapshotWithPluginState(pluginSnapshot: RuntimeSnapshot): Promise<RuntimeSnapshot> {
    const workspace = await this.getWorkspaceSnapshot();
    return {
      ...pluginSnapshot,
      vault: {
        ...pluginSnapshot.vault,
        id: this.kernel.vaultId,
        name: this.readOnly ? "Threadleaf Demo" : pluginSnapshot.vault.name,
        path: this.kernel.paths.rootPath,
        mode: this.readOnly ? "synthetic-read-only" : "kernel-backed",
        source: this.selectionSource,
        warning: this.warning,
      },
      actions: [
        ...this.actions.list(),
        ...pluginSnapshot.actions.filter(
          (pluginAction) => !this.actions.list().some((action) => action.id === pluginAction.id),
        ),
      ],
      workspace,
    };
  }

  async openNote(filePath: string): Promise<RuntimeSnapshot> {
    await this.actions.dispatch("workspace.open-note", filePath);
    return this.publishSnapshot();
  }

  async closeNote(filePath: string, expectedVaultId: string): Promise<RuntimeSnapshot> {
    await this.actions.dispatch("workspace.close-note", {
      path: filePath,
      expectedVaultId,
    });
    return this.publishSnapshot();
  }

  async moveNote(
    filePath: string,
    targetPath: string,
    expectedRevision: string,
    expectedVaultId: string,
    confirmationId?: string,
  ): Promise<NoteMoveResponse> {
    const outcome = await this.actions.dispatch<NoteMoveOutcome>("workspace.move-note", {
      path: filePath,
      targetPath,
      expectedRevision,
      expectedVaultId,
      confirmationId: confirmationId ?? null,
    });
    return { outcome, snapshot: await this.publishSnapshot() };
  }

  async deleteNote(
    filePath: string,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<NoteDeleteResponse> {
    const outcome = await this.actions.dispatch<NoteDeleteOutcome>("workspace.delete-note", {
      path: filePath,
      expectedRevision,
      expectedVaultId,
    });
    return { outcome, snapshot: await this.publishSnapshot() };
  }

  async searchVault(query: string): Promise<VaultSearchResponse> {
    try {
      const page = this.indexReactor.index.search(query);
      const { generation: indexGeneration, ...search } = page;
      return {
        vaultId: this.kernel.vaultId,
        indexGeneration,
        error: null,
        ...search,
        results: search.results.map((result) => ({
          ...result,
          title: displayTitleFromVaultPath(result.path),
        })),
      };
    } catch (error) {
      if (!(error instanceof SearchQueryError)) {
        throw error;
      }
      return {
        vaultId: this.kernel.vaultId,
        indexGeneration: this.indexReactor.index.generation,
        error: error.message,
        query,
        terms: [],
        total: 0,
        truncated: false,
        results: [],
      };
    }
  }

  loadVaultImage(
    sourceNotePath: string,
    target: string,
    expectedVaultId: string,
  ): Promise<VaultImageResponse> {
    return loadVaultImage(this.kernel, sourceNotePath, target, expectedVaultId);
  }

  async saveNote(
    filePath: string,
    content: string,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<NoteSaveResponse> {
    const outcome = await this.actions.dispatch<NoteSaveOutcome>("workspace.save-note", {
      path: filePath,
      content,
      expectedRevision,
      expectedVaultId,
    });
    return { outcome, snapshot: await this.publishSnapshot() };
  }

  async createNote(
    filePath: string,
    content: string,
    expectedVaultId: string,
  ): Promise<NoteCreateResponse> {
    const outcome = await this.actions.dispatch<NoteCreateOutcome>("workspace.create-note", {
      path: filePath,
      content,
      expectedVaultId,
    });
    return { outcome, snapshot: await this.publishSnapshot() };
  }

  async createPluginNote(
    filePath: string,
    content: string,
    expectedVaultId: string,
  ): Promise<NoteCreateOutcome> {
    const outcome = await this.createNoteThroughKernel(
      { path: filePath, content, expectedVaultId },
      false,
    );
    await this.publishSnapshot();
    return outcome;
  }

  async createPluginFile(
    filePath: string,
    content: Uint8Array,
    expectedVaultId: string,
  ): Promise<NoteCreateOutcome> {
    if (expectedVaultId !== this.kernel.vaultId) {
      throw new Error("The active vault changed before this plugin file could be created.");
    }
    this.assertWritable("create plugin files");
    const normalizedPath = normalizeVaultPath(filePath);
    if (hasPrivateVaultSegment(normalizedPath)) {
      throw new Error(`Plugin file creation cannot target private application paths: ${filePath}`);
    }
    const outcome = await this.kernel.createBinary(normalizedPath, content);
    const isMarkdown = normalizedPath.toLowerCase().endsWith(".md");
    if (outcome.status === "committed") {
      if (isMarkdown) {
        this.watcher.operations.expect({
          id: outcome.transactionId,
          kind: "write",
          path: outcome.path,
          revision: outcome.revision,
        });
      }
      await this.indexReactor.index.refresh(this.kernel, outcome.path);
    } else if (outcome.status === "conflict") {
      if (isMarkdown) {
        const conflictCopy = await this.kernel.readText(outcome.conflictPath);
        this.watcher.operations.expect({
          id: outcome.transactionId,
          kind: "write",
          path: conflictCopy.path,
          revision: conflictCopy.revision,
        });
      }
      if (outcome.currentRevision === null) {
        this.indexReactor.index.remove(outcome.path);
      } else {
        await this.indexReactor.index.refresh(this.kernel, outcome.path);
      }
      await this.indexReactor.index.refresh(this.kernel, outcome.conflictPath);
    }
    await this.publishSnapshot();
    return outcome;
  }

  async writePluginFile(
    filePath: string,
    content: Uint8Array,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<VaultWriteResult> {
    if (expectedVaultId !== this.kernel.vaultId) {
      throw new Error("The active vault changed before this plugin file could be saved.");
    }
    this.assertWritable("save plugin files");
    const normalizedPath = normalizeVaultPath(filePath);
    if (hasPrivateVaultSegment(normalizedPath)) {
      throw new Error(`Plugin file saves cannot target private application paths: ${filePath}`);
    }
    const outcome = await this.kernel.writeBinary(normalizedPath, content, expectedRevision);
    const isMarkdown = normalizedPath.toLowerCase().endsWith(".md");
    if (outcome.status === "committed") {
      if (isMarkdown) {
        this.watcher.operations.expect({
          id: outcome.transactionId,
          kind: "write",
          path: outcome.path,
          revision: outcome.revision,
        });
      }
      await this.indexReactor.index.refresh(this.kernel, outcome.path);
    } else {
      if (isMarkdown) {
        const conflictCopy = await this.kernel.readText(outcome.conflictPath);
        this.watcher.operations.expect({
          id: outcome.transactionId,
          kind: "write",
          path: conflictCopy.path,
          revision: conflictCopy.revision,
        });
      }
      if (outcome.currentRevision === null) {
        this.indexReactor.index.remove(outcome.path);
      } else {
        await this.indexReactor.index.refresh(this.kernel, outcome.path);
      }
      await this.indexReactor.index.refresh(this.kernel, outcome.conflictPath);
    }
    await this.publishSnapshot();
    return outcome;
  }

  async renamePluginFile(
    filePath: string,
    targetPath: string,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<VaultRenameResult> {
    if (expectedVaultId !== this.kernel.vaultId) {
      throw new Error("The active vault changed before this plugin file could be renamed.");
    }
    this.assertWritable("rename plugin files");
    const normalizedSource = normalizeVaultPath(filePath);
    const normalizedTarget = normalizeVaultPath(targetPath);
    if (hasPrivateVaultSegment(normalizedSource) || hasPrivateVaultSegment(normalizedTarget)) {
      throw new Error(
        `Plugin file renames cannot target private application paths: ${filePath} to ${targetPath}`,
      );
    }
    const outcome = await this.kernel.renameFile(
      normalizedSource,
      normalizedTarget,
      expectedRevision,
    );
    if (outcome.status === "committed") {
      this.watcher.operations.expect({
        id: outcome.transactionId,
        kind: "rename",
        from: outcome.from,
        to: outcome.to,
        revision: expectedRevision,
      });
      this.indexReactor.index.remove(outcome.from);
      await this.indexReactor.index.refresh(this.kernel, outcome.to);
      if (this.moveOpenPath(outcome.from, outcome.to)) {
        await this.persistWorkspaceStateBestEffort();
      }
    } else {
      await this.indexReactor.index.rebuild(this.kernel);
    }
    await this.publishSnapshot();
    return outcome;
  }

  async trashPluginFile(
    filePath: string,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<VaultRenameResult> {
    if (expectedVaultId !== this.kernel.vaultId) {
      throw new Error("The active vault changed before this plugin file could be moved to trash.");
    }
    this.assertWritable("move plugin files to trash");
    const normalizedSource = normalizeVaultPath(filePath);
    if (hasPrivateVaultSegment(normalizedSource)) {
      throw new Error(`Plugin trash cannot target private application paths: ${filePath}`);
    }
    const outcome = await this.kernel.renameFile(
      normalizedSource,
      `${vaultTrashDirectory}/${normalizedSource}`,
      expectedRevision,
    );
    if (outcome.status === "committed") {
      this.watcher.operations.expect({
        id: outcome.transactionId,
        kind: "delete",
        path: outcome.from,
      });
      this.indexReactor.index.remove(outcome.from);
      if (this.removeOpenPath(outcome.from)) {
        await this.persistWorkspaceStateBestEffort();
      }
    } else {
      await this.indexReactor.index.rebuild(this.kernel);
    }
    await this.publishSnapshot();
    return outcome;
  }

  async createPluginFolder(
    folderPath: string,
    expectedVaultId: string,
  ): Promise<VaultDirectoryCreateResult> {
    if (expectedVaultId !== this.kernel.vaultId) {
      throw new Error("The active vault changed before this folder could be created.");
    }
    this.assertWritable("create plugin folders");
    return this.kernel.createDirectory(folderPath);
  }

  async runPluginCommand(
    commandId: string,
    editorContext?: PluginEditorContext,
  ): Promise<RuntimeSnapshot> {
    return this.publishSnapshot(await this.pluginHost.runCommand(commandId, editorContext));
  }

  async markPluginLayoutReady(): Promise<RuntimeSnapshot> {
    return this.publishSnapshot(await this.pluginHost.markLayoutReady());
  }

  async openPluginSettings(pluginId: string): Promise<RuntimeSnapshot> {
    return this.publishSnapshot(await this.pluginHost.openPluginSettings(pluginId));
  }

  async openPluginView(viewType: string, filePath?: string): Promise<RuntimeSnapshot> {
    return this.publishSnapshot(await this.pluginHost.openPluginView(viewType, filePath));
  }

  async closePluginView(): Promise<RuntimeSnapshot> {
    return this.publishSnapshot(await this.pluginHost.closePluginView());
  }

  async loadPlugin(
    pluginDirectory: string,
    expectedBundleSha256?: string,
  ): Promise<RuntimeSnapshot> {
    return this.publishSnapshot(
      await this.pluginHost.loadPlugin(pluginDirectory, expectedBundleSha256),
    );
  }

  async reloadPlugin(pluginId?: string): Promise<RuntimeSnapshot> {
    return this.publishSnapshot(await this.pluginHost.reloadPlugin(pluginId));
  }

  async unloadPlugin(pluginId?: string): Promise<RuntimeSnapshot> {
    return this.publishSnapshot(await this.pluginHost.unloadPlugin(pluginId));
  }

  async unloadAllPlugins(): Promise<RuntimeSnapshot> {
    return this.publishSnapshot(await this.pluginHost.unloadAllPlugins());
  }

  async reconcileNow(): Promise<RuntimeSnapshot> {
    const batch = await this.watcher.scanNow();
    if (batch) {
      await this.handleWatchBatch(batch, false);
    }
    return this.getSnapshot();
  }

  onSnapshot(listener: SnapshotListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    await Promise.all([this.watcher.close(), this.pluginHost.close()]);
    for (const release of this.#releaseActions.reverse()) {
      release();
    }
    this.#releaseActions.length = 0;
    this.#listeners.clear();
  }

  private currentWorkspaceState(): PersistedWorkspaceState {
    return createWorkspaceState(this.kernel.vaultId, this.#openPaths, this.#activePath);
  }

  private applyWorkspaceState(state: PersistedWorkspaceState): void {
    this.#openPaths = [...state.openPaths];
    this.#activePath = state.activePath;
  }

  private async adoptWorkspaceState(
    state: PersistedWorkspaceState,
    persistBeforeAdopting: boolean,
  ): Promise<void> {
    if (workspaceStatesEqual(this.currentWorkspaceState(), state)) {
      return;
    }
    if (!this.#workspaceStateStore) {
      this.applyWorkspaceState(state);
      return;
    }
    if (!persistBeforeAdopting) {
      this.applyWorkspaceState(state);
      await this.persistWorkspaceStateBestEffort();
      return;
    }
    try {
      const persisted = await this.#workspaceStateStore.save(state);
      this.#workspaceLoadWarning = null;
      this.#workspaceSaveWarning = null;
      this.applyWorkspaceState(persisted);
    } catch (error) {
      const message = `Could not save workspace state: ${errorMessage(error)}`;
      this.#workspaceSaveWarning = message;
      throw new Error(message, { cause: error });
    }
  }

  private async persistWorkspaceStateBestEffort(): Promise<void> {
    if (!this.#workspaceStateStore) {
      return;
    }
    try {
      await this.#workspaceStateStore.save(this.currentWorkspaceState());
      this.#workspaceLoadWarning = null;
      this.#workspaceSaveWarning = null;
    } catch (error) {
      this.#workspaceSaveWarning = `Could not save workspace state: ${errorMessage(error)}`;
    }
  }

  private async selectNote(filePath: string): Promise<void> {
    const exists = this.indexReactor.index
      .snapshot()
      .documents.some((document) => document.path === filePath);
    if (!exists) {
      throw new Error(`Markdown note is not indexed in the active vault: ${filePath}`);
    }
    await this.kernel.readText(filePath);
    const openPaths = this.#openPaths.includes(filePath)
      ? [...this.#openPaths]
      : [...this.#openPaths, filePath];
    await this.adoptWorkspaceState(
      createWorkspaceState(this.kernel.vaultId, openPaths, filePath),
      true,
    );
  }

  private activatePath(filePath: string): boolean {
    const wasActive = this.#activePath === filePath;
    let changed = !wasActive;
    if (!this.#openPaths.includes(filePath)) {
      this.#openPaths.push(filePath);
      changed = true;
    }
    this.#activePath = filePath;
    return changed;
  }

  private removeOpenPath(filePath: string): boolean {
    const index = this.#openPaths.indexOf(filePath);
    if (index === -1) {
      return false;
    }
    this.#openPaths.splice(index, 1);
    if (this.#activePath === filePath) {
      this.#activePath = this.#openPaths[index] ?? this.#openPaths[index - 1] ?? null;
    }
    return true;
  }

  private moveOpenPath(from: string, to: string): boolean {
    const sourceIndex = this.#openPaths.indexOf(from);
    if (sourceIndex === -1) {
      return false;
    }
    const targetIndex = this.#openPaths.indexOf(to);
    if (targetIndex === -1) {
      this.#openPaths[sourceIndex] = to;
    } else {
      this.#openPaths.splice(sourceIndex, 1);
    }
    if (this.#activePath === from) {
      this.#activePath = to;
    }
    return true;
  }

  private async closeNoteThroughWorkspace(request: CloseNoteRequest): Promise<void> {
    if (request.expectedVaultId !== this.kernel.vaultId) {
      throw new Error("The active vault changed before this tab could be closed.");
    }
    const normalizedPath = normalizeVaultPath(request.path);
    const index = this.#openPaths.indexOf(normalizedPath);
    if (index === -1) {
      return;
    }
    const openPaths = this.#openPaths.filter((filePath) => filePath !== normalizedPath);
    const activePath =
      this.#activePath === normalizedPath
        ? (openPaths[index] ?? openPaths[index - 1] ?? null)
        : this.#activePath;
    await this.adoptWorkspaceState(
      createWorkspaceState(this.kernel.vaultId, openPaths, activePath),
      true,
    );
  }

  private async moveNoteThroughKernel(request: MoveNoteRequest): Promise<NoteMoveOutcome> {
    if (request.expectedVaultId !== this.kernel.vaultId) {
      throw new Error("The active vault changed before this note could be moved.");
    }
    this.assertWritable("move notes");
    const sourcePath = normalizeVaultPath(request.path);
    const targetPath = movedMarkdownPath(sourcePath, request.targetPath);
    const outcome = await moveMarkdownNote(
      this.kernel,
      sourcePath,
      targetPath,
      request.expectedRevision,
      {
        ...(request.confirmationId ? { confirmationId: request.confirmationId } : {}),
        indexSnapshot: this.indexReactor.index.snapshot(),
      },
    );
    if (outcome.status !== "committed") {
      return outcome;
    }

    const target = await this.kernel.readText(outcome.to);
    if (outcome.writes.length === 0) {
      this.watcher.operations.expect({
        id: outcome.transactionId,
        kind: "rename",
        from: outcome.from,
        to: outcome.to,
        revision: target.revision,
      });
    } else {
      const sourceWrite = outcome.writes.find((write) => write.path === outcome.from);
      this.watcher.operations.expect({
        id: outcome.transactionId,
        kind: "move-with-writes",
        from: outcome.from,
        to: outcome.to,
        targetRevision: target.revision,
        sourceRewritten: sourceWrite !== undefined,
        writes: outcome.writes
          .filter((write) => write.path !== outcome.from)
          .map((write) => ({ path: write.resultPath, revision: write.revision })),
      });
    }
    this.indexReactor.index.remove(outcome.from);
    const refreshPaths = new Set([outcome.to, ...outcome.writes.map((write) => write.resultPath)]);
    for (const refreshPath of refreshPaths) {
      await this.indexReactor.index.refresh(this.kernel, refreshPath);
    }
    if (this.moveOpenPath(outcome.from, outcome.to)) {
      await this.persistWorkspaceStateBestEffort();
    }
    return outcome;
  }

  private async deleteNoteThroughKernel(request: DeleteNoteRequest): Promise<NoteDeleteOutcome> {
    if (request.expectedVaultId !== this.kernel.vaultId) {
      throw new Error("The active vault changed before this note could be moved to trash.");
    }
    this.assertWritable("move notes to trash");
    const outcome = await trashMarkdownNote(this.kernel, request.path, request.expectedRevision);
    if (outcome.status !== "committed") {
      return outcome;
    }

    this.watcher.operations.expect({
      id: outcome.transactionId,
      kind: "delete",
      path: outcome.from,
    });
    this.indexReactor.index.remove(outcome.from);
    if (this.removeOpenPath(outcome.from)) {
      await this.persistWorkspaceStateBestEffort();
    }
    return outcome;
  }

  private async saveNoteThroughKernel(request: SaveNoteRequest): Promise<NoteSaveOutcome> {
    if (request.expectedVaultId !== this.kernel.vaultId) {
      throw new Error("The active vault changed before this edit could be saved.");
    }
    this.assertWritable("save notes");
    const normalizedPath = normalizeVaultPath(request.path);
    if (!normalizedPath.toLowerCase().endsWith(".md")) {
      throw new Error("The workspace editor can save only Markdown notes.");
    }
    normalizeMarkdownNotePath(normalizedPath);

    const outcome = await this.kernel.writeText(
      normalizedPath,
      request.content,
      request.expectedRevision,
    );
    if (outcome.status === "committed") {
      this.watcher.operations.expect({
        id: outcome.transactionId,
        kind: "write",
        path: outcome.path,
        revision: outcome.revision,
      });
      await this.indexReactor.index.refresh(this.kernel, outcome.path);
      if (this.activatePath(outcome.path)) {
        await this.persistWorkspaceStateBestEffort();
      }
      return outcome;
    }

    const conflictCopy = await this.kernel.readText(outcome.conflictPath);
    this.watcher.operations.expect({
      id: outcome.transactionId,
      kind: "write",
      path: conflictCopy.path,
      revision: conflictCopy.revision,
    });
    if (outcome.currentRevision === null) {
      this.indexReactor.index.remove(outcome.path);
    } else {
      await this.indexReactor.index.refresh(this.kernel, outcome.path);
    }
    await this.indexReactor.index.refresh(this.kernel, conflictCopy.path);
    if (this.activatePath(conflictCopy.path)) {
      await this.persistWorkspaceStateBestEffort();
    }
    return outcome;
  }

  private async createNoteThroughKernel(
    request: CreateNoteRequest,
    activate = true,
  ): Promise<NoteCreateOutcome> {
    if (request.expectedVaultId !== this.kernel.vaultId) {
      throw new Error("The active vault changed before this note could be created.");
    }
    this.assertWritable("create notes");
    const outcome = await createMarkdownNote(this.kernel, request.path, request.content);
    if (outcome.status === "exists") {
      return outcome;
    }
    if (outcome.status === "committed") {
      this.watcher.operations.expect({
        id: outcome.transactionId,
        kind: "write",
        path: outcome.path,
        revision: outcome.revision,
      });
      await this.indexReactor.index.refresh(this.kernel, outcome.path);
      if (activate && this.activatePath(outcome.path)) {
        await this.persistWorkspaceStateBestEffort();
      }
      return outcome;
    }

    const conflictCopy = await this.kernel.readText(outcome.conflictPath);
    this.watcher.operations.expect({
      id: outcome.transactionId,
      kind: "write",
      path: conflictCopy.path,
      revision: conflictCopy.revision,
    });
    if (outcome.currentRevision !== null) {
      await this.indexReactor.index.refresh(this.kernel, outcome.path);
    }
    await this.indexReactor.index.refresh(this.kernel, conflictCopy.path);
    if (activate && this.activatePath(conflictCopy.path)) {
      await this.persistWorkspaceStateBestEffort();
    }
    return outcome;
  }

  private assertWritable(operation: string): void {
    if (this.readOnly) {
      throw new Error(`Open a local vault before you can ${operation}.`);
    }
  }

  private async handleWatchBatch(batch: VaultChangeBatch, publish = true): Promise<void> {
    const result = await this.indexReactor.accept(batch);
    let workspaceChanged = false;
    if (result.mode === "incremental") {
      for (const change of batch.changes) {
        if (change.kind === "move") {
          workspaceChanged = this.moveOpenPath(change.from, change.to) || workspaceChanged;
        } else if (change.kind === "delete") {
          workspaceChanged = this.removeOpenPath(change.path) || workspaceChanged;
        }
      }
    }
    if (workspaceChanged) {
      await this.persistWorkspaceStateBestEffort();
    }
    this.#lastWatchSequence = batch.sequence;
    this.#lastRescanReason = result.mode === "rebuild" ? (result.reason ?? "unknown") : null;
    if (publish) {
      await this.publishSnapshot();
    }
  }

  private recordWatcherError(error: unknown): void {
    this.#watcherError = error instanceof Error ? error.message : String(error);
  }

  private async publishSnapshot(pluginSnapshot?: RuntimeSnapshot): Promise<RuntimeSnapshot> {
    const snapshot = pluginSnapshot
      ? await this.snapshotWithPluginState(pluginSnapshot)
      : await this.getSnapshot();
    for (const listener of this.#listeners) {
      listener(snapshot);
    }
    return snapshot;
  }

  private async getWorkspaceSnapshot(): Promise<NonNullable<RuntimeSnapshot["workspace"]>> {
    const index = this.indexReactor.index.snapshot();
    let projection = this.#indexProjection;
    if (!projection || projection.generation !== this.indexReactor.index.generation) {
      const documents = new Map(index.documents.map((document) => [document.path, document]));
      const backlinks = new Map(index.backlinks.map((entry) => [entry.path, entry.sources]));
      const files: WorkspaceFileSummary[] = index.documents.map((document) => {
        const noteLinks = document.links.filter(isWorkspaceNoteLink);
        return {
          path: document.path,
          title: displayTitleFromVaultPath(document.path),
          tags: document.tags,
          backlinkCount: backlinks.get(document.path)?.length ?? 0,
          outgoingCount: noteLinks.length,
          unresolvedCount: noteLinks.filter((link) => link.resolution.status !== "resolved").length,
        };
      });
      projection = {
        generation: this.indexReactor.index.generation,
        documents,
        backlinks,
        files,
      };
      this.#indexProjection = projection;
    }
    const { documents, backlinks, files } = projection;
    const openPaths = this.#openPaths.filter((filePath) => documents.has(filePath));
    const activePath =
      this.#activePath && openPaths.includes(this.#activePath)
        ? this.#activePath
        : (openPaths.at(-1) ?? null);
    const reconciledState = createWorkspaceState(this.kernel.vaultId, openPaths, activePath);
    if (!workspaceStatesEqual(this.currentWorkspaceState(), reconciledState)) {
      this.applyWorkspaceState(reconciledState);
      await this.persistWorkspaceStateBestEffort();
    }

    let activeNote: WorkspaceNoteSnapshot | null = null;
    const activeMetadata = this.#activePath ? documents.get(this.#activePath) : undefined;
    if (this.#activePath && activeMetadata) {
      const note = await this.kernel.readText(this.#activePath);
      activeNote = {
        path: note.path,
        title: displayTitleFromVaultPath(note.path),
        content: note.content,
        revision: note.revision,
        tags: activeMetadata.tags,
        headings: activeMetadata.headings,
        outgoing: activeMetadata.links.filter(isWorkspaceNoteLink).map(
          (link): WorkspaceLinkSummary => ({
            label: link.alias ?? `${link.target}${link.subpath ?? ""}`,
            status: link.resolution.status,
            target: link.target,
            subpath: link.subpath,
            embed: link.embed,
            syntax: link.syntax,
            ...(link.resolution.path ? { path: link.resolution.path } : {}),
          }),
        ),
        backlinks: backlinks.get(note.path) ?? [],
      };
    }
    return {
      state: this.#watcherError ? "degraded" : "ready",
      indexGeneration: this.indexReactor.index.generation,
      files,
      tabs: this.#openPaths.map((filePath) => ({
        path: filePath,
        title: displayTitleFromVaultPath(filePath),
        active: filePath === this.#activePath,
      })),
      activeNote,
      recoveryActionCount: this.kernel.startupRecoveryActions.length,
      watcher: {
        lastSequence: this.#lastWatchSequence,
        lastRescanReason: this.#lastRescanReason,
        error: this.#watcherError,
      },
    };
  }
}
