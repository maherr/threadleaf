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
  CanvasAttachmentResponse,
  CanvasLoadResponse,
  CanvasSaveResponse,
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
  NoteRestoreOutcome,
  NoteRestoreResponse,
  NoteSaveOutcome,
  NoteSaveResponse,
  PluginEditorContext,
  PluginMutationWaitOptions,
  RuntimeSnapshot,
  VaultAttachmentResponse,
  VaultGraphRequest,
  VaultGraphResponse,
  VaultImageResponse,
  VaultNoteEmbedResponse,
  VaultSearchResponse,
  VaultSelectionSource,
  VaultTrashResponse,
  WorkspaceCanvasSnapshot,
  WorkspaceCanvasSummary,
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
import {
  createDefaultVaultWorkspaceSettings,
  defaultNotePath,
  parseVaultWorkspaceSettings,
  type VaultWorkspaceSettings,
} from "../shared/workspace-settings";
import { ActionRegistry } from "./action-registry";
import { loadCanvasAttachment } from "./canvas-attachment-service";
import {
  isCanvasPath,
  loadJsonCanvas,
  saveJsonCanvas,
  titleForJsonCanvasPath,
} from "./canvas-service";
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
import {
  listTrashedMarkdownNotes,
  restoreTrashedMarkdownNote,
  trashMarkdownNote,
  vaultTrashDirectory,
} from "./note-trash";
import { loadVaultAttachment } from "./vault-attachment-service";
import { projectVaultGraph } from "./vault-graph";
import { loadVaultImage } from "./vault-image-service";
import {
  activeWorkspacePane,
  createWorkspaceLayout,
  maximumPersistedWorkspaceHistory,
  type PersistedWorkspacePane,
  type PersistedWorkspaceState,
  reorderWorkspaceTab,
  type WorkspaceNavigationHistory,
  type WorkspaceStateStore,
  workspaceStatesEqual,
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
  beforeWorkspaceStateRestore?: (vaultId: string) => Promise<void>;
  workspaceSettings?: VaultWorkspaceSettings;
  workspaceSettingsForVault?: (vaultId: string) => VaultWorkspaceSettings;
}

type SnapshotListener = (snapshot: RuntimeSnapshot) => void;

interface WorkspaceIndexProjection {
  generation: number;
  documents: Map<string, DocumentMetadataSnapshot>;
  backlinks: Map<string, string[]>;
  files: WorkspaceFileSummary[];
}

const MAX_DESKTOP_TRASH_ENTRIES = 500;

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
  activate?: boolean;
}

interface NavigateHistoryRequest {
  direction: "back" | "forward";
  paneId?: WorkspacePaneId;
  expectedVaultId: string;
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

interface ToggleTabPinRequest {
  path: string;
  paneId: WorkspacePaneId;
  expectedVaultId: string;
}

interface ReorderWorkspaceTabRequest {
  path: string;
  paneId: WorkspacePaneId;
  targetIndex: number;
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
    ("paneId" in payload && payload.paneId !== "primary" && payload.paneId !== "secondary") ||
    ("activate" in payload && typeof payload.activate !== "boolean")
  ) {
    throw new Error("Open note requires a vault-relative Markdown path and optional pane ID.");
  }
  const paneId = "paneId" in payload ? payload.paneId : undefined;
  const activate = "activate" in payload ? (payload as { activate?: unknown }).activate : undefined;
  return {
    path: payload.path,
    ...(paneId === "primary" || paneId === "secondary" ? { paneId } : {}),
    ...(typeof activate === "boolean" ? { activate } : {}),
  };
}

function parseNavigateHistoryRequest(payload: unknown): NavigateHistoryRequest {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("direction" in payload) ||
    (payload.direction !== "back" && payload.direction !== "forward") ||
    !("expectedVaultId" in payload) ||
    typeof payload.expectedVaultId !== "string" ||
    ("paneId" in payload && payload.paneId !== "primary" && payload.paneId !== "secondary")
  ) {
    throw new Error("Workspace history navigation requires a direction and vault identity.");
  }
  const paneId = "paneId" in payload ? payload.paneId : undefined;
  return {
    direction: payload.direction,
    expectedVaultId: payload.expectedVaultId,
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

function parseToggleTabPinRequest(payload: unknown): ToggleTabPinRequest {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("path" in payload) ||
    typeof payload.path !== "string" ||
    !("paneId" in payload) ||
    (payload.paneId !== "primary" && payload.paneId !== "secondary") ||
    !("expectedVaultId" in payload) ||
    typeof payload.expectedVaultId !== "string"
  ) {
    throw new Error("Toggle tab pin requires a path, pane, and vault identity.");
  }
  return {
    path: payload.path,
    paneId: payload.paneId,
    expectedVaultId: payload.expectedVaultId,
  };
}

function parseReorderWorkspaceTabRequest(payload: unknown): ReorderWorkspaceTabRequest {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("path" in payload) ||
    typeof payload.path !== "string" ||
    !("paneId" in payload) ||
    (payload.paneId !== "primary" && payload.paneId !== "secondary") ||
    !("targetIndex" in payload) ||
    typeof payload.targetIndex !== "number" ||
    !Number.isFinite(payload.targetIndex) ||
    !("expectedVaultId" in payload) ||
    typeof payload.expectedVaultId !== "string"
  ) {
    throw new Error(
      "Reordering a tab requires a path, pane, insertion target, and vault identity.",
    );
  }
  return {
    path: payload.path,
    paneId: payload.paneId,
    targetIndex: payload.targetIndex,
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

function cloneNavigationHistory(
  history: WorkspaceNavigationHistory | undefined,
): WorkspaceNavigationHistory | undefined {
  return history ? { back: [...history.back], forward: [...history.forward] } : undefined;
}

function navigationHistoryForPaths(
  history: WorkspaceNavigationHistory | undefined,
  availablePaths: ReadonlySet<string>,
  excludedPath?: string | null,
): WorkspaceNavigationHistory | undefined {
  if (!history) {
    return undefined;
  }
  const seen = new Set<string>();
  const take = (paths: readonly string[]): string[] => {
    const result: string[] = [];
    for (const filePath of paths) {
      if (
        result.length >= maximumPersistedWorkspaceHistory ||
        filePath === excludedPath ||
        !availablePaths.has(filePath) ||
        seen.has(filePath)
      ) {
        continue;
      }
      seen.add(filePath);
      result.push(filePath);
    }
    return result;
  };
  const back = take(history.back);
  const forward = take(history.forward);
  return { back, forward };
}

function remapNavigationHistoryPath(
  history: WorkspaceNavigationHistory | undefined,
  from: string,
  to: string,
): WorkspaceNavigationHistory | undefined {
  if (!history) {
    return undefined;
  }
  const remapped = navigationHistoryForPaths(
    {
      back: history.back.map((filePath) => (filePath === from ? to : filePath)),
      forward: history.forward.map((filePath) => (filePath === from ? to : filePath)),
    },
    new Set([...history.back, ...history.forward, to]),
  );
  return remapped ?? { back: [], forward: [] };
}

function navigationHistoryEqual(
  left: WorkspaceNavigationHistory | undefined,
  right: WorkspaceNavigationHistory | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  return Boolean(
    left &&
      right &&
      left.back.length === right.back.length &&
      left.back.every((filePath, index) => filePath === right.back[index]) &&
      left.forward.length === right.forward.length &&
      left.forward.every((filePath, index) => filePath === right.forward[index]),
  );
}

function recordNavigation(
  history: WorkspaceNavigationHistory | undefined,
  from: string,
  to: string,
): WorkspaceNavigationHistory {
  const back = [from, ...(history?.back ?? [])].filter(
    (filePath, index, paths) => filePath !== to && paths.indexOf(filePath) === index,
  );
  return {
    back: back.slice(0, maximumPersistedWorkspaceHistory),
    forward: [],
  };
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
  #workspaceSettings: VaultWorkspaceSettings;

  #panes: PersistedWorkspacePane[] = [
    { id: "primary", openPaths: [], pinnedPaths: [], activePath: null },
  ];
  #activePaneId: WorkspacePaneId = "primary";
  #splitDirection: WorkspaceSplitDirection | null = null;
  // Automatic persistence may race a reviewed migration in the same vault. Keep the last
  // observed private state as a compare-and-save receipt so a stale reactor cannot clobber it.
  #workspacePersistedState: PersistedWorkspaceState | null | undefined;
  #workspacePersistenceTail: Promise<void> = Promise.resolve();
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
    workspacePersistedState: PersistedWorkspaceState | null | undefined,
    workspaceLoadWarning: string | null,
    workspaceSettings: VaultWorkspaceSettings,
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
    this.#workspacePersistedState = workspacePersistedState;
    this.#workspaceSettings = workspaceSettings;
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
        id: "workspace.go-back",
        name: "Go back in note history",
        source: "workspace",
        execute: (payload) =>
          this.navigateHistoryThroughState(parseNavigateHistoryRequest(payload)),
      }),
      this.actions.register("threadleaf-workspace", {
        id: "workspace.go-forward",
        name: "Go forward in note history",
        source: "workspace",
        execute: (payload) =>
          this.navigateHistoryThroughState(parseNavigateHistoryRequest(payload)),
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
        id: "workspace.toggle-tab-pin",
        name: "Toggle tab pin",
        source: "workspace",
        execute: (payload) => this.toggleTabPinThroughState(parseToggleTabPinRequest(payload)),
      }),
      this.actions.register("threadleaf-workspace", {
        id: "workspace.reorder-tab",
        name: "Reorder workspace tab",
        source: "workspace",
        execute: (payload) =>
          this.reorderWorkspaceTabThroughState(parseReorderWorkspaceTabRequest(payload)),
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
    await options.beforeWorkspaceStateRestore?.(kernel.vaultId);
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
    let persistedWorkspace: PersistedWorkspaceState | null = null;
    let restoredWorkspace: PersistedWorkspaceState | null = null;
    let workspaceLoadWarning: string | null = null;
    let workspaceStateReadable = true;
    const workspaceSettings = parseVaultWorkspaceSettings(
      options.workspaceSettingsForVault?.(kernel.vaultId) ??
        options.workspaceSettings ??
        createDefaultVaultWorkspaceSettings(),
    );
    // The restart policy is intentionally scoped to note panes and tabs. Docks, window bounds,
    // and pop-out metadata live in the separate main-process layout controller. Load the private
    // note workspace even under the fresh policy so later persistence retains revision authority,
    // but only restore its panes when the policy explicitly requests it.
    if (options.workspaceStateStore) {
      try {
        persistedWorkspace = await options.workspaceStateStore.load(kernel.vaultId);
        if (workspaceSettings.restorePolicy === "restore") {
          restoredWorkspace = persistedWorkspace;
        }
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
      workspaceStateReadable ? persistedWorkspace : undefined,
      workspaceLoadWarning,
      workspaceSettings,
    );

    if (restoredWorkspace) {
      const visible = await kernel.listVisiblePaths();
      const availablePaths = new Set([
        ...indexReactor.index.snapshot().documents.map((document) => document.path),
        ...visible.files.filter(isCanvasPath),
      ]);
      const panes = restoredWorkspace.panes.map((pane) => {
        const openPaths = pane.openPaths.filter((filePath) => availablePaths.has(filePath));
        const activePath =
          pane.activePath && openPaths.includes(pane.activePath)
            ? pane.activePath
            : (openPaths.at(-1) ?? null);
        const navigationHistory = navigationHistoryForPaths(
          pane.navigationHistory,
          availablePaths,
          activePath,
        );
        return {
          id: pane.id,
          openPaths,
          pinnedPaths: pane.pinnedPaths.filter((filePath) => openPaths.includes(filePath)),
          activePath,
          ...(navigationHistory ? { navigationHistory } : {}),
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
        runtime.activatePath(firstPath, "primary", false);
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

  async openNote(
    filePath: string,
    paneId?: WorkspacePaneId,
    activate = true,
  ): Promise<RuntimeSnapshot> {
    await this.actions.dispatch("workspace.open-note", {
      path: filePath,
      ...(paneId ? { paneId } : {}),
      activate,
    });
    return this.publishSnapshot();
  }

  async goBack(expectedVaultId: string, paneId?: WorkspacePaneId): Promise<RuntimeSnapshot> {
    await this.actions.dispatch("workspace.go-back", {
      direction: "back",
      expectedVaultId,
      ...(paneId ? { paneId } : {}),
    });
    return this.publishSnapshot();
  }

  async goForward(expectedVaultId: string, paneId?: WorkspacePaneId): Promise<RuntimeSnapshot> {
    await this.actions.dispatch("workspace.go-forward", {
      direction: "forward",
      expectedVaultId,
      ...(paneId ? { paneId } : {}),
    });
    return this.publishSnapshot();
  }

  getWorkspaceSettings(): VaultWorkspaceSettings {
    return { ...this.#workspaceSettings };
  }

  setWorkspaceSettings(settings: VaultWorkspaceSettings, expectedVaultId: string): void {
    if (expectedVaultId !== this.kernel.vaultId) {
      throw new Error("The active vault changed before workspace preferences could be applied.");
    }
    this.#workspaceSettings = parseVaultWorkspaceSettings(settings);
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

  async getWorkspaceState(expectedVaultId: string): Promise<PersistedWorkspaceState> {
    if (expectedVaultId !== this.kernel.vaultId) {
      throw new Error("Workspace migration state belongs to a different vault.");
    }
    return this.currentWorkspaceState();
  }

  async setWorkspaceState(
    state: PersistedWorkspaceState,
    expectedVaultId: string,
    expectedCurrent?: PersistedWorkspaceState | null,
  ): Promise<RuntimeSnapshot> {
    if (expectedVaultId !== this.kernel.vaultId) {
      throw new Error("Workspace migration state belongs to a different vault.");
    }
    if (
      expectedCurrent !== undefined &&
      (expectedCurrent === null ||
        !workspaceStatesEqual(this.currentWorkspaceState(), expectedCurrent))
    ) {
      throw new Error("Threadleaf workspace state changed during migration review.");
    }
    const normalized = createWorkspaceLayout(
      this.kernel.vaultId,
      state.panes,
      state.activePaneId,
      state.splitDirection,
    );
    await this.adoptWorkspaceState(normalized, true);
    return this.publishSnapshot();
  }

  async toggleTabPin(
    filePath: string,
    paneId: WorkspacePaneId,
    expectedVaultId: string,
  ): Promise<RuntimeSnapshot> {
    await this.actions.dispatch("workspace.toggle-tab-pin", {
      path: filePath,
      paneId,
      expectedVaultId,
    });
    return this.publishSnapshot();
  }

  async reorderWorkspaceTab(
    filePath: string,
    paneId: WorkspacePaneId,
    targetIndex: number,
    expectedVaultId: string,
  ): Promise<RuntimeSnapshot> {
    await this.actions.dispatch("workspace.reorder-tab", {
      path: filePath,
      paneId,
      targetIndex,
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

  async getVaultTrash(expectedVaultId: string): Promise<VaultTrashResponse> {
    if (this.kernel.vaultId !== expectedVaultId) {
      return { status: "stale-vault", vaultId: this.kernel.vaultId };
    }
    const trash = await listTrashedMarkdownNotes(this.kernel, MAX_DESKTOP_TRASH_ENTRIES);
    return {
      status: "ready",
      vaultId: this.kernel.vaultId,
      total: trash.total,
      truncated: trash.total > trash.entries.length,
      entries: trash.entries,
    };
  }

  async restoreNote(
    filePath: string,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<NoteRestoreResponse> {
    if (this.kernel.vaultId !== expectedVaultId) {
      throw new Error("The active vault changed before this note could be restored.");
    }
    this.assertWritable("restore notes from trash");
    const outcome: NoteRestoreOutcome = await restoreTrashedMarkdownNote(
      this.kernel,
      filePath,
      expectedRevision,
    );
    if (outcome.status === "committed") {
      const restored = await this.kernel.readText(outcome.to);
      this.watcher.operations.expect({
        id: outcome.transactionId,
        kind: "write",
        path: outcome.to,
        revision: restored.revision,
      });
      await this.indexReactor.index.refresh(this.kernel, outcome.to);
    }
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

  async getVaultGraph(
    request: VaultGraphRequest,
    expectedVaultId: string,
  ): Promise<VaultGraphResponse> {
    if (this.kernel.vaultId !== expectedVaultId) {
      return { status: "stale-vault", vaultId: this.kernel.vaultId };
    }
    const projection = projectVaultGraph(this.indexReactor.index.snapshot(), request);
    return {
      status: "ready",
      vaultId: this.kernel.vaultId,
      indexGeneration: this.indexReactor.index.generation,
      ...projection,
    };
  }

  loadVaultImage(
    sourceNotePath: string,
    target: string,
    expectedVaultId: string,
  ): Promise<VaultImageResponse> {
    return loadVaultImage(this.kernel, sourceNotePath, target, expectedVaultId);
  }

  loadVaultAttachment(
    sourceNotePath: string,
    target: string,
    expectedVaultId: string,
  ): Promise<VaultAttachmentResponse> {
    return loadVaultAttachment(this.kernel, sourceNotePath, target, expectedVaultId);
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

  loadCanvas(filePath: string, expectedVaultId: string): Promise<CanvasLoadResponse> {
    return loadJsonCanvas(this.kernel, filePath, expectedVaultId, { readOnly: this.readOnly });
  }

  loadCanvasAttachment(
    sourceCanvasPath: string,
    target: string,
    expectedVaultId: string,
  ): Promise<CanvasAttachmentResponse> {
    return loadCanvasAttachment(this.kernel, sourceCanvasPath, target, expectedVaultId);
  }

  async saveCanvas(
    filePath: string,
    content: string,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<CanvasSaveResponse> {
    if (this.readOnly) {
      return {
        outcome: { status: "read-only", path: filePath },
        snapshot: await this.publishSnapshot(),
      };
    }
    const outcome = await saveJsonCanvas(
      this.kernel,
      filePath,
      content,
      expectedRevision,
      expectedVaultId,
    );
    if (outcome.status === "committed") {
      this.watcher.operations.expect({
        id: outcome.transactionId,
        kind: "write",
        path: outcome.path,
        revision: outcome.revision,
      });
    } else if (outcome.status === "conflict") {
      const conflict = await this.kernel.readBinary(outcome.conflictPath, 8 * 1024 * 1024);
      if (conflict.status === "ready") {
        this.watcher.operations.expect({
          id: outcome.transactionId,
          kind: "write",
          path: outcome.conflictPath,
          revision: conflict.snapshot.revision,
        });
      }
    }
    return { outcome, snapshot: await this.publishSnapshot() };
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
    if (normalizedSource.toLowerCase().endsWith(".md")) {
      this.assertNoPinnedWorkspaceTabsForRemoval(normalizedSource);
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

  async waitForPluginMutations(options?: PluginMutationWaitOptions): Promise<RuntimeSnapshot> {
    return this.publishSnapshot(await this.pluginHost.waitForPluginMutations(options));
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
    this.#panes = state.panes.map((pane) => {
      const navigationHistory = cloneNavigationHistory(pane.navigationHistory);
      return {
        id: pane.id,
        openPaths: [...pane.openPaths],
        pinnedPaths: [...pane.pinnedPaths],
        activePath: pane.activePath,
        ...(navigationHistory ? { navigationHistory } : {}),
      };
    });
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
    const expectedCurrent = this.currentWorkspaceState();
    if (workspaceStatesEqual(expectedCurrent, state)) {
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
      const persisted = await this.#workspaceStateStore.save(state, expectedCurrent);
      this.#workspacePersistedState = persisted;
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
    const workspaceStateStore = this.#workspaceStateStore;
    if (!workspaceStateStore || this.#workspacePersistedState === undefined) {
      return;
    }
    const operation = this.#workspacePersistenceTail
      .catch(() => undefined)
      .then(async () => {
        const state = this.currentWorkspaceState();
        const expectedCurrent = this.#workspacePersistedState;
        if (expectedCurrent && workspaceStatesEqual(state, expectedCurrent)) {
          return;
        }
        try {
          const persisted = await workspaceStateStore.save(state, expectedCurrent);
          this.#workspacePersistedState = persisted;
          this.#workspaceLoadWarning = null;
          this.#workspaceSaveWarning = null;
        } catch (error) {
          this.#workspaceSaveWarning = `Could not save workspace state: ${errorMessage(error)}`;
        }
      });
    this.#workspacePersistenceTail = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
  }

  private async selectNote(request: OpenNoteRequest): Promise<void> {
    const filePath = normalizeVaultPath(request.path);
    if (isCanvasPath(filePath)) {
      const visible = await this.kernel.listVisiblePaths();
      if (!visible.files.includes(filePath)) {
        throw new Error(`Canvas is not present in the active vault: ${filePath}`);
      }
      await this.kernel.readBinary(filePath, 8 * 1024 * 1024);
    } else {
      const exists = this.indexReactor.index
        .snapshot()
        .documents.some((document) => document.path === filePath);
      if (!exists) {
        throw new Error(`Markdown note is not indexed in the active vault: ${filePath}`);
      }
      await this.kernel.readText(filePath);
    }
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
    if (request.activate !== false) {
      if (pane.activePath && pane.activePath !== filePath) {
        pane.navigationHistory = recordNavigation(
          pane.navigationHistory,
          pane.activePath,
          filePath,
        );
      }
      pane.activePath = filePath;
    }
    const activePaneId = request.activate === false ? state.activePaneId : paneId;
    await this.adoptWorkspaceState(
      createWorkspaceLayout(this.kernel.vaultId, state.panes, activePaneId, state.splitDirection),
      true,
    );
  }

  private async navigateHistoryThroughState(request: NavigateHistoryRequest): Promise<void> {
    if (request.expectedVaultId !== this.kernel.vaultId) {
      throw new Error("The active vault changed before note history could be traversed.");
    }
    const paneId = request.paneId ?? this.#activePaneId;
    this.workspacePane(paneId);
    const state = this.currentWorkspaceState();
    const pane = state.panes.find(({ id }) => id === paneId);
    if (!pane) {
      throw new Error(`Workspace pane is not open: ${paneId}`);
    }
    const visible = await this.kernel.listVisiblePaths();
    const availablePaths = new Set([
      ...this.indexReactor.index.snapshot().documents.map((document) => document.path),
      ...visible.files.filter(isCanvasPath),
    ]);
    const reconciledHistory = navigationHistoryForPaths(
      pane.navigationHistory,
      availablePaths,
      pane.activePath,
    );
    const history = reconciledHistory ?? { back: [], forward: [] };
    const source = request.direction === "back" ? history.back : history.forward;
    const target = source.shift();
    const currentHistory = cloneNavigationHistory(pane.navigationHistory) ?? {
      back: [],
      forward: [],
    };
    if (!target) {
      if (!navigationHistoryEqual(currentHistory, reconciledHistory)) {
        if (reconciledHistory) {
          pane.navigationHistory = reconciledHistory;
        } else {
          delete pane.navigationHistory;
        }
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
      return;
    }
    const opposite = request.direction === "back" ? history.forward : history.back;
    if (pane.activePath && pane.activePath !== target) {
      opposite.unshift(pane.activePath);
    }
    const seen = new Set<string>();
    const dedupe = (paths: string[]): string[] =>
      paths.filter((filePath) => {
        if (seen.has(filePath)) {
          return false;
        }
        seen.add(filePath);
        return true;
      });
    const nextHistory: WorkspaceNavigationHistory = {
      back: dedupe(request.direction === "back" ? history.back : opposite).slice(
        0,
        maximumPersistedWorkspaceHistory,
      ),
      forward: dedupe(request.direction === "back" ? opposite : history.forward).slice(
        0,
        maximumPersistedWorkspaceHistory,
      ),
    };
    if (!pane.openPaths.includes(target)) {
      pane.openPaths.push(target);
    }
    pane.activePath = target;
    pane.navigationHistory = nextHistory;
    await this.adoptWorkspaceState(
      createWorkspaceLayout(this.kernel.vaultId, state.panes, paneId, state.splitDirection),
      true,
    );
  }

  private activatePath(
    filePath: string,
    paneId = this.#activePaneId,
    recordHistory = true,
  ): boolean {
    const pane = this.workspacePane(paneId);
    const previousPath = pane.activePath;
    let changed = this.#activePaneId !== paneId || pane.activePath !== filePath;
    if (!pane.openPaths.includes(filePath)) {
      pane.openPaths.push(filePath);
      changed = true;
    }
    if (recordHistory && previousPath && previousPath !== filePath) {
      pane.navigationHistory = recordNavigation(pane.navigationHistory, previousPath, filePath);
    }
    pane.activePath = filePath;
    this.#activePaneId = paneId;
    return changed;
  }

  private removeOpenPath(filePath: string): boolean {
    let changed = false;
    for (const pane of this.#panes) {
      if (pane.navigationHistory) {
        const nextHistory: WorkspaceNavigationHistory = {
          back: pane.navigationHistory.back.filter((path) => path !== filePath),
          forward: pane.navigationHistory.forward.filter((path) => path !== filePath),
        };
        if (!navigationHistoryEqual(pane.navigationHistory, nextHistory)) {
          pane.navigationHistory = nextHistory;
          changed = true;
        }
      }
      const index = pane.openPaths.indexOf(filePath);
      if (index === -1) {
        continue;
      }
      pane.openPaths.splice(index, 1);
      pane.pinnedPaths = pane.pinnedPaths.filter((pinnedPath) => pinnedPath !== filePath);
      if (pane.activePath === filePath) {
        pane.activePath = pane.openPaths[index] ?? pane.openPaths[index - 1] ?? null;
      }
      if (pane.navigationHistory && pane.activePath) {
        pane.navigationHistory = {
          back: pane.navigationHistory.back.filter((path) => path !== pane.activePath),
          forward: pane.navigationHistory.forward.filter((path) => path !== pane.activePath),
        };
      }
      changed = true;
    }
    return changed;
  }

  private assertNoPinnedWorkspaceTabsForRemoval(filePath: string): void {
    if (this.#panes.some((pane) => pane.pinnedPaths.includes(filePath))) {
      throw new Error("Unpin this tab before closing it.");
    }
  }

  private moveOpenPath(from: string, to: string): boolean {
    let changed = false;
    for (const pane of this.#panes) {
      const nextHistory = remapNavigationHistoryPath(pane.navigationHistory, from, to);
      if (!navigationHistoryEqual(pane.navigationHistory, nextHistory)) {
        if (nextHistory) {
          pane.navigationHistory = nextHistory;
        } else {
          delete pane.navigationHistory;
        }
        changed = true;
      }
      const sourceIndex = pane.openPaths.indexOf(from);
      if (sourceIndex === -1) {
        continue;
      }
      const targetIndex = pane.openPaths.indexOf(to);
      if (targetIndex === -1) {
        pane.openPaths[sourceIndex] = to;
        pane.pinnedPaths = pane.pinnedPaths.map((pinnedPath) =>
          pinnedPath === from ? to : pinnedPath,
        );
      } else {
        pane.openPaths.splice(sourceIndex, 1);
        pane.pinnedPaths = pane.pinnedPaths.filter((pinnedPath) => pinnedPath !== from);
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
    if (pane.pinnedPaths.includes(normalizedPath)) {
      throw new Error("Unpin this tab before closing it.");
    }
    const state = this.currentWorkspaceState();
    const nextPane = state.panes.find(({ id }) => id === paneId);
    if (!nextPane) {
      throw new Error(`Workspace pane is not open: ${paneId}`);
    }
    const openPaths = nextPane.openPaths.filter((filePath) => filePath !== normalizedPath);
    nextPane.openPaths = openPaths;
    nextPane.pinnedPaths = nextPane.pinnedPaths.filter(
      (pinnedPath) => pinnedPath !== normalizedPath,
    );
    nextPane.activePath =
      nextPane.activePath === normalizedPath
        ? (openPaths[index] ?? openPaths[index - 1] ?? null)
        : nextPane.activePath;
    if (nextPane.navigationHistory && nextPane.activePath) {
      nextPane.navigationHistory = {
        back: nextPane.navigationHistory.back.filter((path) => path !== nextPane.activePath),
        forward: nextPane.navigationHistory.forward.filter((path) => path !== nextPane.activePath),
      };
    }
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
      pinnedPaths: activePath && sourcePane.pinnedPaths.includes(activePath) ? [activePath] : [],
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
    const closingPane = state.panes.find(({ id }) => id === request.paneId);
    if (!survivor || !closingPane) {
      throw new Error("The remaining or closing workspace pane is missing.");
    }
    const survivorPaths = new Set(survivor.openPaths);
    const survivorPinnedPaths = [...survivor.pinnedPaths];
    const closingPinnedPaths = closingPane.pinnedPaths.filter(
      (filePath) => !survivorPaths.has(filePath),
    );
    const survivorOrdinaryPaths = survivor.openPaths.filter(
      (filePath) => !survivorPinnedPaths.includes(filePath),
    );
    const closingOrdinaryPaths = closingPane.openPaths.filter(
      (filePath) => !closingPane.pinnedPaths.includes(filePath) && !survivorPaths.has(filePath),
    );
    const activePath =
      state.activePaneId === request.paneId
        ? (closingPane.activePath ?? survivor.activePath)
        : survivor.activePath;
    await this.adoptWorkspaceState(
      createWorkspaceLayout(
        this.kernel.vaultId,
        [
          {
            id: "primary",
            openPaths: [
              ...survivorPinnedPaths,
              ...closingPinnedPaths,
              ...survivorOrdinaryPaths,
              ...closingOrdinaryPaths,
            ],
            pinnedPaths: [...survivorPinnedPaths, ...closingPinnedPaths],
            activePath,
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
    const sourceWasPinned = source.pinnedPaths.includes(normalizedPath);
    source.openPaths.splice(sourceIndex, 1);
    source.pinnedPaths = source.pinnedPaths.filter((pinnedPath) => pinnedPath !== normalizedPath);
    if (source.activePath === normalizedPath) {
      source.activePath =
        source.openPaths[sourceIndex] ?? source.openPaths[sourceIndex - 1] ?? null;
    }
    if (!target.openPaths.includes(normalizedPath)) {
      target.openPaths.push(normalizedPath);
    }
    if (sourceWasPinned && !target.pinnedPaths.includes(normalizedPath)) {
      target.pinnedPaths.push(normalizedPath);
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

  private async toggleTabPinThroughState(request: ToggleTabPinRequest): Promise<void> {
    if (request.expectedVaultId !== this.kernel.vaultId) {
      throw new Error("The active vault changed before this tab pin could be updated.");
    }
    const normalizedPath = normalizeVaultPath(request.path);
    this.workspacePane(request.paneId);
    const state = this.currentWorkspaceState();
    const pane = state.panes.find(({ id }) => id === request.paneId);
    if (!pane?.openPaths.includes(normalizedPath)) {
      throw new Error(`The workspace pane does not contain this tab: ${normalizedPath}`);
    }
    const currentlyPinned = pane.pinnedPaths.includes(normalizedPath);
    if (currentlyPinned) {
      const pinnedPaths = pane.pinnedPaths.filter((filePath) => filePath !== normalizedPath);
      const ordinaryPaths = pane.openPaths.filter(
        (filePath) => filePath !== normalizedPath && !pinnedPaths.includes(filePath),
      );
      pane.pinnedPaths = pinnedPaths;
      pane.openPaths = [...pinnedPaths, normalizedPath, ...ordinaryPaths];
    } else {
      const pinnedPaths = [...pane.pinnedPaths, normalizedPath];
      const pinnedPathSet = new Set(pinnedPaths);
      pane.pinnedPaths = pinnedPaths;
      pane.openPaths = [
        ...pinnedPaths,
        ...pane.openPaths.filter((filePath) => !pinnedPathSet.has(filePath)),
      ];
    }
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

  private async reorderWorkspaceTabThroughState(
    request: ReorderWorkspaceTabRequest,
  ): Promise<void> {
    if (request.expectedVaultId !== this.kernel.vaultId) {
      throw new Error("The active vault changed before this tab could be reordered.");
    }
    const normalizedPath = normalizeVaultPath(request.path);
    const state = reorderWorkspaceTab(
      this.currentWorkspaceState(),
      request.paneId,
      normalizedPath,
      request.targetIndex,
    );
    await this.adoptWorkspaceState(state, true);
  }

  private async moveNoteThroughKernel(request: MoveNoteRequest): Promise<NoteMoveOutcome> {
    if (request.expectedVaultId !== this.kernel.vaultId) {
      throw new Error("The active vault changed before this note could be moved.");
    }
    this.assertWritable("move notes");
    const sourcePath = normalizeVaultPath(request.path);
    const targetPath = movedMarkdownPath(sourcePath, request.targetPath);
    if (this.#workspaceSettings.automaticLinkUpdates === "never") {
      const source = await this.kernel.readText(sourcePath);
      if (source.revision !== request.expectedRevision) {
        return {
          status: "conflict",
          from: sourcePath,
          to: targetPath,
          reason: "source-revision-changed",
        };
      }
      const result = await this.kernel.renameFile(sourcePath, targetPath, source.revision);
      if (result.status === "conflict") {
        return result;
      }
      const target = await this.kernel.readText(result.to);
      this.watcher.operations.expect({
        id: result.transactionId,
        kind: "rename",
        from: result.from,
        to: result.to,
        revision: target.revision,
      });
      this.indexReactor.index.remove(result.from);
      await this.indexReactor.index.refresh(this.kernel, result.to);
      if (this.moveOpenPath(result.from, result.to)) {
        await this.persistWorkspaceStateBestEffort();
      }
      return { ...result, rewrites: [], writes: [] };
    }
    const outcome = await moveMarkdownNote(
      this.kernel,
      sourcePath,
      targetPath,
      request.expectedRevision,
      {
        ...(request.confirmationId ? { confirmationId: request.confirmationId } : {}),
        automaticLinkUpdates: this.#workspaceSettings.automaticLinkUpdates,
        linkStyle: this.#workspaceSettings.linkStyle,
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
    const normalizedPath = normalizeVaultPath(request.path);
    this.assertNoPinnedWorkspaceTabsForRemoval(normalizedPath);
    const outcome = await trashMarkdownNote(this.kernel, normalizedPath, request.expectedRevision);
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
    applyDefaultFolder = true,
  ): Promise<NoteCreateOutcome> {
    if (request.expectedVaultId !== this.kernel.vaultId) {
      throw new Error("The active vault changed before this note could be created.");
    }
    this.assertWritable("create notes");
    const requestedPath = applyDefaultFolder
      ? defaultNotePath(this.#workspaceSettings.defaultNoteFolder, request.path)
      : request.path;
    const outcome = await createMarkdownNote(this.kernel, requestedPath, request.content);
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
    const visible = await this.kernel.listVisiblePaths();
    const canvasPaths = visible.files.filter(isCanvasPath);
    const canvasFiles: WorkspaceCanvasSummary[] = canvasPaths.map((filePath) => ({
      path: filePath,
      title: titleForJsonCanvasPath(filePath),
    }));
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
    const availablePaths = new Set([...documents.keys(), ...canvasPaths]);
    const reconciledPanes = this.#panes.map((pane) => {
      const openPaths = pane.openPaths.filter((filePath) => availablePaths.has(filePath));
      const activePath =
        pane.activePath && openPaths.includes(pane.activePath)
          ? pane.activePath
          : (openPaths.at(-1) ?? null);
      const navigationHistory = navigationHistoryForPaths(
        pane.navigationHistory,
        availablePaths,
        activePath,
      );
      return {
        id: pane.id,
        openPaths,
        pinnedPaths: pane.pinnedPaths.filter((filePath) => openPaths.includes(filePath)),
        activePath,
        ...(navigationHistory ? { navigationHistory } : {}),
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
    const canvasSnapshots = new Map<string, Promise<WorkspaceCanvasSnapshot>>();
    const loadCanvasSnapshot = (filePath: string): Promise<WorkspaceCanvasSnapshot> => {
      const cached = canvasSnapshots.get(filePath);
      if (cached) {
        return cached;
      }
      const pending = loadJsonCanvas(this.kernel, filePath, this.kernel.vaultId, {
        readOnly: this.readOnly,
      }).then((response) => {
        if (response.status !== "ready") {
          throw new Error(
            response.status === "unavailable" ? response.message : "The active vault changed.",
          );
        }
        return response.canvas;
      });
      canvasSnapshots.set(filePath, pending);
      return pending;
    };
    const snapshotState = reconciledState;
    const panes: WorkspacePaneSnapshot[] = await Promise.all(
      snapshotState.panes.map(async (pane) => {
        const activeCanvas =
          pane.activePath && isCanvasPath(pane.activePath)
            ? await loadCanvasSnapshot(pane.activePath)
            : null;
        const activeNote =
          pane.activePath && !activeCanvas ? await loadNoteSnapshot(pane.activePath) : null;
        return {
          id: pane.id,
          active: pane.id === snapshotState.activePaneId,
          tabs: pane.openPaths.map((filePath) => ({
            path: filePath,
            title: isCanvasPath(filePath)
              ? titleForJsonCanvasPath(filePath)
              : displayTitleFromVaultPath(filePath),
            active: filePath === pane.activePath,
            pinned: pane.pinnedPaths.includes(filePath),
          })),
          activeNote,
          canGoBack: Boolean(pane.navigationHistory?.back.length),
          canGoForward: Boolean(pane.navigationHistory?.forward.length),
          ...(activeCanvas ? { activeCanvas } : {}),
        };
      }),
    );
    const activePane = panes.find(({ id }) => id === snapshotState.activePaneId);
    if (!activePane) {
      throw new Error("The active workspace pane is missing from its snapshot.");
    }
    return {
      state: this.#watcherError ? "degraded" : "ready",
      indexGeneration: this.indexReactor.index.generation,
      files,
      ...(canvasFiles.length > 0 ? { canvasFiles } : {}),
      panes,
      activePaneId: snapshotState.activePaneId,
      splitDirection: snapshotState.splitDirection,
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
