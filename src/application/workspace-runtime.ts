import moment, { type Moment } from "moment";
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
  NotePropertyRemoveOutcome,
  NotePropertyRemoveResponse,
  NotePropertySetOutcome,
  NotePropertySetResponse,
  NotePropertyType,
  NoteSaveOutcome,
  NoteSaveResponse,
  PluginEditorContext,
  RuntimeSnapshot,
  VaultImageResponse,
  VaultNoteEmbedResponse,
  VaultSearchResponse,
  VaultSelectionSource,
  WorkspaceFileSummary,
  WorkspaceLinkSummary,
  WorkspaceNoteSnapshot,
  WorkspacePaneId,
  WorkspacePaneSnapshot,
  WorkspaceSplitDirection,
} from "../shared/contracts";
import {
  isNoteWorkflowTemplatePath,
  parseVaultNoteWorkflowSettings,
  type VaultNoteWorkflowSettings,
} from "../shared/note-workflows";
import { ActionRegistry } from "./action-registry";
import { createMarkdownNote } from "./note-creation";
import { type DailyNoteResult, openOrCreateDailyNote } from "./note-daily";
import { loadVaultNoteEmbed } from "./note-embed-service";
import { movedMarkdownPath, moveMarkdownNote } from "./note-move";
import {
  applyNotePropertyRemove,
  applyNotePropertySet,
  inspectMarkdownNoteProperties,
} from "./note-properties";
import {
  listNoteTemplates,
  noteTemplateTitle,
  type RenderedNoteTemplate,
  renderNoteTemplate,
} from "./note-template";
import { trashMarkdownNote, vaultTrashDirectory } from "./note-trash";
import { loadVaultImage } from "./vault-image-service";
import {
  activeWorkspacePane,
  createWorkspaceLayout,
  type PersistedWorkspacePane,
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

interface SetNotePropertyRequest {
  path: string;
  name: string;
  rawValue: string;
  type: NotePropertyType;
  expectedRevision: string;
  expectedVaultId: string;
}

interface RemoveNotePropertyRequest {
  path: string;
  name: string;
  expectedRevision: string;
  expectedVaultId: string;
}

interface CreateNoteRequest {
  path: string;
  content: string;
  expectedVaultId: string;
}

interface OpenDailyNoteRequest {
  expectedVaultId: string;
  settings: VaultNoteWorkflowSettings;
  now: Moment;
}

interface CloseNoteRequest {
  path: string;
  expectedVaultId: string;
  paneId?: WorkspacePaneId;
}

interface OpenNoteRequest {
  path: string;
  paneId?: WorkspacePaneId;
}

interface SplitWorkspaceRequest {
  direction: WorkspaceSplitDirection;
  expectedVaultId: string;
}

interface PaneRequest {
  paneId: WorkspacePaneId;
  expectedVaultId: string;
}

interface MoveNoteToPaneRequest {
  path: string;
  fromPaneId: WorkspacePaneId;
  toPaneId: WorkspacePaneId;
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
    typeof payload.expectedVaultId !== "string" ||
    ("paneId" in payload && payload.paneId !== "primary" && payload.paneId !== "secondary")
  ) {
    throw new Error("Close note requires string path and vault values.");
  }
  const paneId = "paneId" in payload ? payload.paneId : undefined;
  return {
    path: payload.path,
    expectedVaultId: payload.expectedVaultId,
    ...(paneId === "primary" || paneId === "secondary" ? { paneId } : {}),
  };
}

function parseOpenNoteRequest(payload: unknown): OpenNoteRequest {
  if (typeof payload === "string") {
    return { path: payload };
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("path" in payload) ||
    typeof payload.path !== "string" ||
    ("paneId" in payload && payload.paneId !== "primary" && payload.paneId !== "secondary")
  ) {
    throw new Error("Open note requires a vault-relative Markdown path and optional pane ID.");
  }
  const paneId = "paneId" in payload ? payload.paneId : undefined;
  return {
    path: payload.path,
    ...(paneId === "primary" || paneId === "secondary" ? { paneId } : {}),
  };
}

function parseSplitWorkspaceRequest(payload: unknown): SplitWorkspaceRequest {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("direction" in payload) ||
    (payload.direction !== "horizontal" && payload.direction !== "vertical") ||
    !("expectedVaultId" in payload) ||
    typeof payload.expectedVaultId !== "string"
  ) {
    throw new Error("Split workspace requires a direction and vault identity.");
  }
  return { direction: payload.direction, expectedVaultId: payload.expectedVaultId };
}

function parsePaneRequest(payload: unknown): PaneRequest {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("paneId" in payload) ||
    (payload.paneId !== "primary" && payload.paneId !== "secondary") ||
    !("expectedVaultId" in payload) ||
    typeof payload.expectedVaultId !== "string"
  ) {
    throw new Error("Workspace pane actions require a pane and vault identity.");
  }
  return { paneId: payload.paneId, expectedVaultId: payload.expectedVaultId };
}

function parseMoveNoteToPaneRequest(payload: unknown): MoveNoteToPaneRequest {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("path" in payload) ||
    typeof payload.path !== "string" ||
    !("fromPaneId" in payload) ||
    (payload.fromPaneId !== "primary" && payload.fromPaneId !== "secondary") ||
    !("toPaneId" in payload) ||
    (payload.toPaneId !== "primary" && payload.toPaneId !== "secondary") ||
    !("expectedVaultId" in payload) ||
    typeof payload.expectedVaultId !== "string"
  ) {
    throw new Error("Move tab requires a path, source pane, target pane, and vault identity.");
  }
  return {
    path: payload.path,
    fromPaneId: payload.fromPaneId,
    toPaneId: payload.toPaneId,
    expectedVaultId: payload.expectedVaultId,
  };
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

function parseOpenDailyNoteRequest(payload: unknown): OpenDailyNoteRequest {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("expectedVaultId" in payload) ||
    typeof payload.expectedVaultId !== "string" ||
    !("settings" in payload) ||
    !("now" in payload) ||
    typeof payload.now !== "string"
  ) {
    throw new Error("Open daily note requires vault, workflow settings, and timestamp values.");
  }
  const now = moment.parseZone(payload.now);
  if (!now.isValid()) {
    throw new Error("Open daily note requires a valid timestamp.");
  }
  return {
    expectedVaultId: payload.expectedVaultId,
    settings: parseVaultNoteWorkflowSettings(payload.settings),
    now,
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

function parseSetNotePropertyRequest(payload: unknown): SetNotePropertyRequest {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("path" in payload) ||
    typeof payload.path !== "string" ||
    !("name" in payload) ||
    typeof payload.name !== "string" ||
    !("rawValue" in payload) ||
    typeof payload.rawValue !== "string" ||
    !("type" in payload) ||
    !["text", "list", "number", "checkbox", "date", "datetime"].includes(String(payload.type)) ||
    !("expectedRevision" in payload) ||
    typeof payload.expectedRevision !== "string" ||
    !("expectedVaultId" in payload) ||
    typeof payload.expectedVaultId !== "string"
  ) {
    throw new Error(
      "Set property requires string path, name, value, type, revision, and vault values.",
    );
  }
  return {
    path: payload.path,
    name: payload.name,
    rawValue: payload.rawValue,
    type: payload.type as NotePropertyType,
    expectedRevision: payload.expectedRevision,
    expectedVaultId: payload.expectedVaultId,
  };
}

function parseRemoveNotePropertyRequest(payload: unknown): RemoveNotePropertyRequest {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("path" in payload) ||
    typeof payload.path !== "string" ||
    !("name" in payload) ||
    typeof payload.name !== "string" ||
    !("expectedRevision" in payload) ||
    typeof payload.expectedRevision !== "string" ||
    !("expectedVaultId" in payload) ||
    typeof payload.expectedVaultId !== "string"
  ) {
    throw new Error("Remove property requires string path, name, revision, and vault values.");
  }
  return {
    path: payload.path,
    name: payload.name,
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
    left.activePaneId === right.activePaneId &&
    left.splitDirection === right.splitDirection &&
    left.panes.length === right.panes.length &&
    left.panes.every((pane, paneIndex) => {
      const other = right.panes[paneIndex];
      return (
        other !== undefined &&
        pane.id === other.id &&
        pane.activePath === other.activePath &&
        pane.openPaths.length === other.openPaths.length &&
        pane.openPaths.every((filePath, pathIndex) => filePath === other.openPaths[pathIndex])
      );
    })
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

  #panes: PersistedWorkspacePane[] = [{ id: "primary", openPaths: [], activePath: null }];
  #activePaneId: WorkspacePaneId = "primary";
  #splitDirection: WorkspaceSplitDirection | null = null;
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
        id: "workspace.open-daily-note",
        name: "Open today's daily note",
        source: "workspace",
        execute: (payload) => this.openDailyNoteThroughKernel(parseOpenDailyNoteRequest(payload)),
      }),
      this.actions.register("threadleaf-workspace", {
        id: "workspace.open-note",
        name: "Open note",
        source: "workspace",
        execute: (payload) => this.selectNote(parseOpenNoteRequest(payload)),
      }),
      this.actions.register("threadleaf-workspace", {
        id: "workspace.close-note",
        name: "Close note",
        source: "workspace",
        execute: (payload) => this.closeNoteThroughWorkspace(parseCloseNoteRequest(payload)),
      }),
      this.actions.register("threadleaf-workspace", {
        id: "workspace.split",
        name: "Split workspace",
        source: "workspace",
        execute: (payload) => this.splitWorkspaceThroughState(parseSplitWorkspaceRequest(payload)),
      }),
      this.actions.register("threadleaf-workspace", {
        id: "workspace.focus-pane",
        name: "Focus workspace pane",
        source: "workspace",
        execute: (payload) => this.focusPaneThroughState(parsePaneRequest(payload)),
      }),
      this.actions.register("threadleaf-workspace", {
        id: "workspace.close-pane",
        name: "Close workspace pane",
        source: "workspace",
        execute: (payload) => this.closePaneThroughState(parsePaneRequest(payload)),
      }),
      this.actions.register("threadleaf-workspace", {
        id: "workspace.move-note-to-pane",
        name: "Move note to workspace pane",
        source: "workspace",
        execute: (payload) => this.moveNoteToPaneThroughState(parseMoveNoteToPaneRequest(payload)),
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
      this.actions.register("threadleaf-workspace", {
        id: "workspace.set-note-property",
        name: "Set note property",
        source: "workspace",
        execute: (payload) =>
          this.setNotePropertyThroughKernel(parseSetNotePropertyRequest(payload)),
      }),
      this.actions.register("threadleaf-workspace", {
        id: "workspace.remove-note-property",
        name: "Remove note property",
        source: "workspace",
        execute: (payload) =>
          this.removeNotePropertyThroughKernel(parseRemoveNotePropertyRequest(payload)),
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
      const panes = restoredWorkspace.panes.map((pane) => {
        const openPaths = pane.openPaths.filter((filePath) => availablePaths.has(filePath));
        return {
          id: pane.id,
          openPaths,
          activePath:
            pane.activePath && openPaths.includes(pane.activePath)
              ? pane.activePath
              : (openPaths.at(-1) ?? null),
        };
      });
      const restored = createWorkspaceLayout(
        kernel.vaultId,
        panes,
        restoredWorkspace.activePaneId,
        restoredWorkspace.splitDirection,
      );
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

  async openNote(filePath: string, paneId?: WorkspacePaneId): Promise<RuntimeSnapshot> {
    await this.actions.dispatch("workspace.open-note", {
      path: filePath,
      ...(paneId ? { paneId } : {}),
    });
    return this.publishSnapshot();
  }

  async closeNote(
    filePath: string,
    expectedVaultId: string,
    paneId?: WorkspacePaneId,
  ): Promise<RuntimeSnapshot> {
    await this.actions.dispatch("workspace.close-note", {
      path: filePath,
      expectedVaultId,
      ...(paneId ? { paneId } : {}),
    });
    return this.publishSnapshot();
  }

  async splitWorkspace(
    direction: WorkspaceSplitDirection,
    expectedVaultId: string,
  ): Promise<RuntimeSnapshot> {
    await this.actions.dispatch("workspace.split", { direction, expectedVaultId });
    return this.publishSnapshot();
  }

  async focusWorkspacePane(
    paneId: WorkspacePaneId,
    expectedVaultId: string,
  ): Promise<RuntimeSnapshot> {
    await this.actions.dispatch("workspace.focus-pane", { paneId, expectedVaultId });
    return this.publishSnapshot();
  }

  async closeWorkspacePane(
    paneId: WorkspacePaneId,
    expectedVaultId: string,
  ): Promise<RuntimeSnapshot> {
    await this.actions.dispatch("workspace.close-pane", { paneId, expectedVaultId });
    return this.publishSnapshot();
  }

  async moveNoteToWorkspacePane(
    filePath: string,
    fromPaneId: WorkspacePaneId,
    toPaneId: WorkspacePaneId,
    expectedVaultId: string,
  ): Promise<RuntimeSnapshot> {
    await this.actions.dispatch("workspace.move-note-to-pane", {
      path: filePath,
      fromPaneId,
      toPaneId,
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

  loadVaultNoteEmbed(
    sourceNotePath: string,
    target: string,
    subpath: string | null,
    expectedVaultId: string,
  ): Promise<VaultNoteEmbedResponse> {
    return loadVaultNoteEmbed(
      this.kernel,
      this.indexReactor.index.snapshot().documents,
      sourceNotePath,
      target,
      subpath,
      expectedVaultId,
    );
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

  async setNoteProperty(
    filePath: string,
    name: string,
    rawValue: string,
    type: NotePropertyType,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<NotePropertySetResponse> {
    const outcome = await this.actions.dispatch<NotePropertySetOutcome>(
      "workspace.set-note-property",
      {
        path: filePath,
        name,
        rawValue,
        type,
        expectedRevision,
        expectedVaultId,
      },
    );
    return { outcome, snapshot: await this.publishSnapshot() };
  }

  async removeNoteProperty(
    filePath: string,
    name: string,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<NotePropertyRemoveResponse> {
    const outcome = await this.actions.dispatch<NotePropertyRemoveOutcome>(
      "workspace.remove-note-property",
      {
        path: filePath,
        name,
        expectedRevision,
        expectedVaultId,
      },
    );
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

  async openDailyNote(
    settings: VaultNoteWorkflowSettings,
    expectedVaultId: string,
    now: Moment = moment(),
  ): Promise<NoteCreateResponse> {
    const outcome = await this.actions.dispatch<DailyNoteResult>("workspace.open-daily-note", {
      settings,
      expectedVaultId,
      now: now.format(),
    });
    return { outcome: outcome.outcome, snapshot: await this.publishSnapshot() };
  }

  async listNoteTemplates(templateFolder: string, expectedVaultId: string): Promise<string[]> {
    if (expectedVaultId !== this.kernel.vaultId) {
      throw new Error("The active vault changed before templates could be listed.");
    }
    return listNoteTemplates(this.kernel, templateFolder);
  }

  async renderNoteTemplate(
    templatePath: string,
    targetPath: string,
    settings: VaultNoteWorkflowSettings,
    expectedVaultId: string,
    now: Moment = moment(),
  ): Promise<RenderedNoteTemplate> {
    if (expectedVaultId !== this.kernel.vaultId) {
      throw new Error("The active vault changed before this template could be rendered.");
    }
    const normalizedSettings = parseVaultNoteWorkflowSettings(settings);
    if (!isNoteWorkflowTemplatePath(templatePath, normalizedSettings)) {
      throw new Error("Template insertion is limited to the configured template folder.");
    }
    return renderNoteTemplate(this.kernel, templatePath, {
      title: noteTemplateTitle(targetPath),
      now,
      dateFormat: normalizedSettings.templateDateFormat,
      timeFormat: normalizedSettings.templateTimeFormat,
    });
  }

  formatNoteWorkflowValue(
    value: "date" | "time",
    settings: VaultNoteWorkflowSettings,
    expectedVaultId: string,
    now: Moment = moment(),
  ): string {
    if (expectedVaultId !== this.kernel.vaultId) {
      throw new Error("The active vault changed before this value could be formatted.");
    }
    const normalizedSettings = parseVaultNoteWorkflowSettings(settings);
    return now.format(
      value === "date"
        ? normalizedSettings.templateDateFormat
        : normalizedSettings.templateTimeFormat,
    );
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
    return createWorkspaceLayout(
      this.kernel.vaultId,
      this.#panes,
      this.#activePaneId,
      this.#splitDirection,
    );
  }

  private applyWorkspaceState(state: PersistedWorkspaceState): void {
    this.#panes = state.panes.map((pane) => ({
      id: pane.id,
      openPaths: [...pane.openPaths],
      activePath: pane.activePath,
    }));
    this.#activePaneId = state.activePaneId;
    this.#splitDirection = state.splitDirection;
  }

  private workspacePane(paneId: WorkspacePaneId): PersistedWorkspacePane {
    const pane = this.#panes.find(({ id }) => id === paneId);
    if (!pane) {
      throw new Error(`Workspace pane is not open: ${paneId}`);
    }
    return pane;
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

  private async selectNote(request: OpenNoteRequest): Promise<void> {
    const filePath = normalizeVaultPath(request.path);
    const exists = this.indexReactor.index
      .snapshot()
      .documents.some((document) => document.path === filePath);
    if (!exists) {
      throw new Error(`Markdown note is not indexed in the active vault: ${filePath}`);
    }
    await this.kernel.readText(filePath);
    const paneId = request.paneId ?? this.#activePaneId;
    this.workspacePane(paneId);
    const state = this.currentWorkspaceState();
    const pane = state.panes.find(({ id }) => id === paneId);
    if (!pane) {
      throw new Error(`Workspace pane is not open: ${paneId}`);
    }
    if (!pane.openPaths.includes(filePath)) {
      pane.openPaths.push(filePath);
    }
    pane.activePath = filePath;
    await this.adoptWorkspaceState(
      createWorkspaceLayout(this.kernel.vaultId, state.panes, paneId, state.splitDirection),
      true,
    );
  }

  private activatePath(filePath: string, paneId = this.#activePaneId): boolean {
    const pane = this.workspacePane(paneId);
    let changed = this.#activePaneId !== paneId || pane.activePath !== filePath;
    if (!pane.openPaths.includes(filePath)) {
      pane.openPaths.push(filePath);
      changed = true;
    }
    pane.activePath = filePath;
    this.#activePaneId = paneId;
    return changed;
  }

  private removeOpenPath(filePath: string): boolean {
    let changed = false;
    for (const pane of this.#panes) {
      const index = pane.openPaths.indexOf(filePath);
      if (index === -1) {
        continue;
      }
      pane.openPaths.splice(index, 1);
      if (pane.activePath === filePath) {
        pane.activePath = pane.openPaths[index] ?? pane.openPaths[index - 1] ?? null;
      }
      changed = true;
    }
    return changed;
  }

  private moveOpenPath(from: string, to: string): boolean {
    let changed = false;
    for (const pane of this.#panes) {
      const sourceIndex = pane.openPaths.indexOf(from);
      if (sourceIndex === -1) {
        continue;
      }
      const targetIndex = pane.openPaths.indexOf(to);
      if (targetIndex === -1) {
        pane.openPaths[sourceIndex] = to;
      } else {
        pane.openPaths.splice(sourceIndex, 1);
      }
      if (pane.activePath === from) {
        pane.activePath = to;
      }
      changed = true;
    }
    return changed;
  }

  private async closeNoteThroughWorkspace(request: CloseNoteRequest): Promise<void> {
    if (request.expectedVaultId !== this.kernel.vaultId) {
      throw new Error("The active vault changed before this tab could be closed.");
    }
    const normalizedPath = normalizeVaultPath(request.path);
    const paneId = request.paneId ?? this.#activePaneId;
    const pane = this.workspacePane(paneId);
    const index = pane.openPaths.indexOf(normalizedPath);
    if (index === -1) {
      return;
    }
    const state = this.currentWorkspaceState();
    const nextPane = state.panes.find(({ id }) => id === paneId);
    if (!nextPane) {
      throw new Error(`Workspace pane is not open: ${paneId}`);
    }
    const openPaths = nextPane.openPaths.filter((filePath) => filePath !== normalizedPath);
    nextPane.openPaths = openPaths;
    nextPane.activePath =
      nextPane.activePath === normalizedPath
        ? (openPaths[index] ?? openPaths[index - 1] ?? null)
        : nextPane.activePath;
    await this.adoptWorkspaceState(
      createWorkspaceLayout(
        this.kernel.vaultId,
        state.panes,
        state.activePaneId,
        state.splitDirection,
      ),
      true,
    );
  }

  private async splitWorkspaceThroughState(request: SplitWorkspaceRequest): Promise<void> {
    if (request.expectedVaultId !== this.kernel.vaultId) {
      throw new Error("The active vault changed before the workspace could be split.");
    }
    const state = this.currentWorkspaceState();
    if (state.panes.length === 2) {
      await this.adoptWorkspaceState(
        createWorkspaceLayout(
          this.kernel.vaultId,
          state.panes,
          state.activePaneId,
          request.direction,
        ),
        true,
      );
      return;
    }
    const sourcePane = activeWorkspacePane(state);
    const activePath = sourcePane.activePath;
    state.panes.push({
      id: "secondary",
      openPaths: activePath ? [activePath] : [],
      activePath,
    });
    await this.adoptWorkspaceState(
      createWorkspaceLayout(this.kernel.vaultId, state.panes, "secondary", request.direction),
      true,
    );
  }

  private async focusPaneThroughState(request: PaneRequest): Promise<void> {
    if (request.expectedVaultId !== this.kernel.vaultId) {
      throw new Error("The active vault changed before this pane could be focused.");
    }
    this.workspacePane(request.paneId);
    const state = this.currentWorkspaceState();
    await this.adoptWorkspaceState(
      createWorkspaceLayout(this.kernel.vaultId, state.panes, request.paneId, state.splitDirection),
      true,
    );
  }

  private async closePaneThroughState(request: PaneRequest): Promise<void> {
    if (request.expectedVaultId !== this.kernel.vaultId) {
      throw new Error("The active vault changed before this pane could be closed.");
    }
    this.workspacePane(request.paneId);
    const state = this.currentWorkspaceState();
    if (state.panes.length === 1) {
      return;
    }
    const survivor = state.panes.find(({ id }) => id !== request.paneId);
    if (!survivor) {
      throw new Error("The remaining workspace pane is missing.");
    }
    await this.adoptWorkspaceState(
      createWorkspaceLayout(
        this.kernel.vaultId,
        [
          {
            id: "primary",
            openPaths: [...survivor.openPaths],
            activePath: survivor.activePath,
          },
        ],
        "primary",
        null,
      ),
      true,
    );
  }

  private async moveNoteToPaneThroughState(request: MoveNoteToPaneRequest): Promise<void> {
    if (request.expectedVaultId !== this.kernel.vaultId) {
      throw new Error("The active vault changed before this tab could be moved.");
    }
    if (request.fromPaneId === request.toPaneId) {
      return;
    }
    const normalizedPath = normalizeVaultPath(request.path);
    this.workspacePane(request.fromPaneId);
    this.workspacePane(request.toPaneId);
    const state = this.currentWorkspaceState();
    const source = state.panes.find(({ id }) => id === request.fromPaneId);
    const target = state.panes.find(({ id }) => id === request.toPaneId);
    if (!source || !target) {
      throw new Error("The source or target workspace pane is missing.");
    }
    const sourceIndex = source.openPaths.indexOf(normalizedPath);
    if (sourceIndex === -1) {
      throw new Error(`The source pane does not contain this tab: ${normalizedPath}`);
    }
    source.openPaths.splice(sourceIndex, 1);
    if (source.activePath === normalizedPath) {
      source.activePath =
        source.openPaths[sourceIndex] ?? source.openPaths[sourceIndex - 1] ?? null;
    }
    if (!target.openPaths.includes(normalizedPath)) {
      target.openPaths.push(normalizedPath);
    }
    target.activePath = normalizedPath;
    await this.adoptWorkspaceState(
      createWorkspaceLayout(
        this.kernel.vaultId,
        state.panes,
        request.toPaneId,
        state.splitDirection,
      ),
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
    await this.reconcileNoteWrite(outcome);
    return outcome;
  }

  private async setNotePropertyThroughKernel(
    request: SetNotePropertyRequest,
  ): Promise<NotePropertySetOutcome> {
    if (request.expectedVaultId !== this.kernel.vaultId) {
      throw new Error("The active vault changed before this property could be saved.");
    }
    this.assertWritable("edit note properties");
    const normalizedPath = normalizeMarkdownNotePath(normalizeVaultPath(request.path));
    const existing = await this.kernel.readText(normalizedPath);
    if (existing.revision !== request.expectedRevision) {
      await this.indexReactor.index.refresh(this.kernel, normalizedPath);
      return {
        status: "stale",
        path: normalizedPath,
        currentRevision: existing.revision,
        name: request.name,
      };
    }
    const proposal = applyNotePropertySet(
      existing.content,
      request.name,
      request.rawValue,
      request.type,
    );
    const outcome = await this.kernel.writeText(
      normalizedPath,
      proposal.content,
      existing.revision,
    );
    await this.reconcileNoteWrite(outcome);
    return {
      ...outcome,
      name: request.name,
      type: request.type,
      value: proposal.value,
    };
  }

  private async removeNotePropertyThroughKernel(
    request: RemoveNotePropertyRequest,
  ): Promise<NotePropertyRemoveOutcome> {
    if (request.expectedVaultId !== this.kernel.vaultId) {
      throw new Error("The active vault changed before this property could be removed.");
    }
    this.assertWritable("edit note properties");
    const normalizedPath = normalizeMarkdownNotePath(normalizeVaultPath(request.path));
    const existing = await this.kernel.readText(normalizedPath);
    if (existing.revision !== request.expectedRevision) {
      await this.indexReactor.index.refresh(this.kernel, normalizedPath);
      return {
        status: "stale",
        path: normalizedPath,
        currentRevision: existing.revision,
        name: request.name,
      };
    }
    const proposal = applyNotePropertyRemove(existing.content, request.name);
    if (!proposal.removed) {
      return {
        status: "missing",
        path: normalizedPath,
        revision: existing.revision,
        name: request.name,
      };
    }
    const outcome = await this.kernel.writeText(
      normalizedPath,
      proposal.content,
      existing.revision,
    );
    await this.reconcileNoteWrite(outcome);
    return { ...outcome, name: request.name };
  }

  private async reconcileNoteWrite(outcome: VaultWriteResult): Promise<void> {
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
      return;
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
    await this.integrateNoteCreateOutcome(outcome, activate, false);
    return outcome;
  }

  private async openDailyNoteThroughKernel(
    request: OpenDailyNoteRequest,
  ): Promise<DailyNoteResult> {
    if (request.expectedVaultId !== this.kernel.vaultId) {
      throw new Error("The active vault changed before today's daily note could be opened.");
    }
    this.assertWritable("open today's daily note");
    const result = await openOrCreateDailyNote(this.kernel, request.settings, request.now);
    await this.integrateNoteCreateOutcome(result.outcome, true, true);
    return result;
  }

  private async integrateNoteCreateOutcome(
    outcome: NoteCreateOutcome,
    activate: boolean,
    activateExisting: boolean,
  ): Promise<void> {
    if (outcome.status === "exists") {
      if (activate && activateExisting) {
        await this.indexReactor.index.refresh(this.kernel, outcome.path);
        if (this.activatePath(outcome.path)) {
          await this.persistWorkspaceStateBestEffort();
        }
      }
      return;
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
      return;
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
    const reconciledPanes = this.#panes.map((pane) => {
      const openPaths = pane.openPaths.filter((filePath) => documents.has(filePath));
      return {
        id: pane.id,
        openPaths,
        activePath:
          pane.activePath && openPaths.includes(pane.activePath)
            ? pane.activePath
            : (openPaths.at(-1) ?? null),
      };
    });
    const reconciledState = createWorkspaceLayout(
      this.kernel.vaultId,
      reconciledPanes,
      this.#activePaneId,
      this.#splitDirection,
    );
    if (!workspaceStatesEqual(this.currentWorkspaceState(), reconciledState)) {
      this.applyWorkspaceState(reconciledState);
      await this.persistWorkspaceStateBestEffort();
    }

    const noteSnapshots = new Map<string, Promise<WorkspaceNoteSnapshot>>();
    const loadNoteSnapshot = (filePath: string): Promise<WorkspaceNoteSnapshot> => {
      const cached = noteSnapshots.get(filePath);
      if (cached) {
        return cached;
      }
      const activeMetadata = documents.get(filePath);
      if (!activeMetadata) {
        throw new Error(`Active workspace note is not indexed: ${filePath}`);
      }
      const pending = this.kernel.readText(filePath).then((note) => {
        const propertyInspection = inspectMarkdownNoteProperties(
          note.content,
          activeMetadata.properties,
        );
        return {
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
          properties: propertyInspection.properties,
          propertyEditor: propertyInspection.editor,
        };
      });
      noteSnapshots.set(filePath, pending);
      return pending;
    };
    const panes: WorkspacePaneSnapshot[] = await Promise.all(
      this.#panes.map(async (pane) => ({
        id: pane.id,
        active: pane.id === this.#activePaneId,
        tabs: pane.openPaths.map((filePath) => ({
          path: filePath,
          title: displayTitleFromVaultPath(filePath),
          active: filePath === pane.activePath,
        })),
        activeNote: pane.activePath ? await loadNoteSnapshot(pane.activePath) : null,
      })),
    );
    const activePane = panes.find(({ id }) => id === this.#activePaneId);
    if (!activePane) {
      throw new Error("The active workspace pane is missing from its snapshot.");
    }
    return {
      state: this.#watcherError ? "degraded" : "ready",
      indexGeneration: this.indexReactor.index.generation,
      files,
      panes,
      activePaneId: this.#activePaneId,
      splitDirection: this.#splitDirection,
      tabs: activePane.tabs,
      activeNote: activePane.activeNote,
      recoveryActionCount: this.kernel.startupRecoveryActions.length,
      watcher: {
        lastSequence: this.#lastWatchSequence,
        lastRescanReason: this.#lastRescanReason,
        error: this.#watcherError,
      },
    };
  }
}
