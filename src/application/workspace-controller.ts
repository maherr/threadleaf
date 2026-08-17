import { basename } from "node:path";
import { hasHiddenVaultSegment } from "../kernel/path-policy";
import type {
  StateRootPort,
  VaultDirectoryCreateResult,
  VaultRenameResult,
  VaultWriteResult,
} from "../kernel/ports";
import type { PluginModuleResolver } from "../runtime/plugin-host";
import type { PluginRuntimeFactory } from "../runtime/plugin-runtime-port";
import type {
  AttachmentBatchInsertResponse,
  AttachmentInsertResponse,
  AttachmentMoveResponse,
  AttachmentOperation,
  AttachmentRelinkResponse,
  AttachmentRestoreResponse,
  CanvasAttachmentResponse,
  CanvasLoadResponse,
  CanvasSaveResponse,
  NoteCreateOutcome,
  NoteCreateResponse,
  NoteDeleteResponse,
  NoteMoveResponse,
  NotePropertyRemoveResponse,
  NotePropertySetResponse,
  NotePropertyType,
  NoteRestoreResponse,
  NoteSaveResponse,
  PluginEditorContext,
  PluginMarkdownProjectionResponse,
  PluginMutationWaitOptions,
  RuntimeSnapshot,
  VaultAttachmentResponse,
  VaultFilePreviewResponse,
  VaultGraphRequest,
  VaultGraphResponse,
  VaultImageResponse,
  VaultNoteEmbedResponse,
  VaultSearchResponse,
  VaultSelectionSource,
  VaultTrashResponse,
  WorkspaceFilePageRequest,
  WorkspaceFilePageResponse,
  WorkspacePaneId,
  WorkspaceSplitDirection,
  WorkspaceTagCatalogRequest,
  WorkspaceTagCatalogResponse,
  WorkspaceTreePageRequest,
  WorkspaceTreePageResponse,
  WorkspaceTreePathRequest,
  WorkspaceTreePathResponse,
} from "../shared/contracts";
import type { VaultNoteWorkflowSettings } from "../shared/note-workflows";
import type { PluginConstructionRequest } from "../shared/plugins";
import type { WorkspaceOpenDiagnostics } from "../shared/workspace-open-diagnostics";
import type { VaultWorkspaceSettings } from "../shared/workspace-settings";
import type { RenderedNoteTemplate } from "./note-template";
import { WorkspaceRuntime, type WorkspaceRuntimeOptions } from "./workspace-runtime";
import type { PersistedWorkspaceState, WorkspaceStateStore } from "./workspace-state";

function displaySafeVaultName(value: string): string {
  const basenameSafe = basename(value.replaceAll("\\", "/"));
  const cleaned = [...basenameSafe]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f ? " " : character;
    })
    .join("")
    .trim();
  return cleaned || "previous vault";
}

/**
 * Navigator-created folders become part of the public index/tree namespace.
 * Generic plugin folders retain their existing compatibility policy, so this
 * deliberately narrows only the workspace action before it reaches that route.
 */
function assertPublicWorkspaceFolderPath(folderPath: string): void {
  if (hasHiddenVaultSegment(folderPath)) {
    throw new Error("Workspace folders cannot use hidden vault path segments.");
  }
}

export interface VaultSelectionStore {
  load(): Promise<string | null>;
  save(vaultPath: string): Promise<void>;
}

export interface WorkspaceRuntimePort {
  readonly vaultId: string;
  readonly vaultPath: string;
  getSnapshot(): Promise<RuntimeSnapshot>;
  getWorkspaceFilePage(request: WorkspaceFilePageRequest): Promise<WorkspaceFilePageResponse>;
  getWorkspaceTreePage(request: WorkspaceTreePageRequest): Promise<WorkspaceTreePageResponse>;
  getWorkspaceTreePath(request: WorkspaceTreePathRequest): Promise<WorkspaceTreePathResponse>;
  getWorkspaceTagCatalog(request: WorkspaceTagCatalogRequest): Promise<WorkspaceTagCatalogResponse>;
  searchVault(query: string): Promise<VaultSearchResponse>;
  getVaultGraph(request: VaultGraphRequest, expectedVaultId: string): Promise<VaultGraphResponse>;
  loadVaultImage(
    sourceNotePath: string,
    target: string,
    expectedVaultId: string,
  ): Promise<VaultImageResponse>;
  loadVaultAttachment(
    sourceNotePath: string,
    target: string,
    expectedVaultId: string,
  ): Promise<VaultAttachmentResponse>;
  loadVaultFilePreview(
    path: string,
    expectedVaultId: string,
    expectedInventoryGeneration: string,
  ): Promise<VaultFilePreviewResponse>;
  loadVaultNoteEmbed(
    sourceNotePath: string,
    target: string,
    subpath: string | null,
    expectedVaultId: string,
  ): Promise<VaultNoteEmbedResponse>;
  renderPluginMarkdownProjection(
    pluginId: string,
    sourceNotePath: string,
    content: string,
    expectedVaultId: string,
  ): Promise<PluginMarkdownProjectionResponse>;
  loadCanvas?(filePath: string, expectedVaultId: string): Promise<CanvasLoadResponse>;
  loadCanvasAttachment?(
    sourceCanvasPath: string,
    target: string,
    expectedVaultId: string,
  ): Promise<CanvasAttachmentResponse>;
  saveCanvas?(
    filePath: string,
    content: string,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<CanvasSaveResponse>;
  openNote(
    filePath: string,
    paneId?: WorkspacePaneId,
    activate?: boolean,
  ): Promise<RuntimeSnapshot>;
  goBack(expectedVaultId: string, paneId?: WorkspacePaneId): Promise<RuntimeSnapshot>;
  goForward(expectedVaultId: string, paneId?: WorkspacePaneId): Promise<RuntimeSnapshot>;
  getWorkspaceSettings(): VaultWorkspaceSettings;
  setWorkspaceSettings(settings: VaultWorkspaceSettings, expectedVaultId: string): void;
  closeNote(
    filePath: string,
    expectedVaultId: string,
    paneId?: WorkspacePaneId,
  ): Promise<RuntimeSnapshot>;
  toggleTabPin(
    filePath: string,
    paneId: WorkspacePaneId,
    expectedVaultId: string,
  ): Promise<RuntimeSnapshot>;
  splitWorkspace(
    direction: WorkspaceSplitDirection,
    expectedVaultId: string,
  ): Promise<RuntimeSnapshot>;
  focusWorkspacePane(paneId: WorkspacePaneId, expectedVaultId: string): Promise<RuntimeSnapshot>;
  closeWorkspacePane(paneId: WorkspacePaneId, expectedVaultId: string): Promise<RuntimeSnapshot>;
  moveNoteToWorkspacePane(
    filePath: string,
    fromPaneId: WorkspacePaneId,
    toPaneId: WorkspacePaneId,
    expectedVaultId: string,
  ): Promise<RuntimeSnapshot>;
  getWorkspaceState?(expectedVaultId: string): Promise<PersistedWorkspaceState>;
  setWorkspaceState?(
    state: PersistedWorkspaceState,
    expectedVaultId: string,
    expectedCurrent?: PersistedWorkspaceState | null,
  ): Promise<RuntimeSnapshot>;
  reorderWorkspaceTab(
    filePath: string,
    paneId: WorkspacePaneId,
    targetIndex: number,
    expectedVaultId: string,
  ): Promise<RuntimeSnapshot>;
  moveNote(
    filePath: string,
    targetPath: string,
    expectedRevision: string,
    expectedVaultId: string,
    confirmationId?: string,
  ): Promise<NoteMoveResponse>;
  moveAttachment?(
    filePath: string,
    targetPath: string,
    expectedRevision: string,
    expectedVaultId: string,
    confirmationId?: string,
    operation?: AttachmentOperation,
  ): Promise<AttachmentMoveResponse>;
  relinkAttachment?(
    sourceNotePath: string,
    missingTarget: string,
    replacementPath: string,
    expectedSourceRevision: string,
    expectedVaultId: string,
    confirmationId?: string,
  ): Promise<AttachmentRelinkResponse>;
  restoreAttachment?(
    sourceNotePath: string,
    missingTarget: string,
    sourceFileName: string,
    bytes: Uint8Array,
    expectedSourceRevision: string,
    expectedVaultId: string,
    confirmationId?: string,
  ): Promise<AttachmentRestoreResponse>;
  insertAttachment?(
    sourceNotePath: string,
    targetPath: string,
    sourceFileName: string,
    bytes: Uint8Array,
    expectedSourceRevision: string,
    expectedVaultId: string,
    selectionStart: number,
    selectionEnd: number,
    confirmationId?: string,
  ): Promise<AttachmentInsertResponse>;
  insertAttachmentBatch?(
    sourceNotePath: string,
    items: Array<{
      targetPath: string;
      sourceFileName: string;
      bytes: Uint8Array;
      selectionStart: number;
      selectionEnd: number;
    }>,
    expectedSourceRevision: string,
    expectedVaultId: string,
    confirmationId?: string,
  ): Promise<AttachmentBatchInsertResponse>;
  deleteNote(
    filePath: string,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<NoteDeleteResponse>;
  getVaultTrash(expectedVaultId: string): Promise<VaultTrashResponse>;
  restoreNote(
    filePath: string,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<NoteRestoreResponse>;
  createNote(
    filePath: string,
    content: string,
    expectedVaultId: string,
  ): Promise<NoteCreateResponse>;
  openDailyNote(
    settings: VaultNoteWorkflowSettings,
    expectedVaultId: string,
  ): Promise<NoteCreateResponse>;
  listNoteTemplates(templateFolder: string, expectedVaultId: string): Promise<string[]>;
  renderNoteTemplate(
    templatePath: string,
    targetPath: string,
    settings: VaultNoteWorkflowSettings,
    expectedVaultId: string,
  ): Promise<RenderedNoteTemplate>;
  formatNoteWorkflowValue(
    value: "date" | "time",
    settings: VaultNoteWorkflowSettings,
    expectedVaultId: string,
  ): string;
  createPluginNote(
    filePath: string,
    content: string,
    expectedVaultId: string,
  ): Promise<NoteCreateOutcome>;
  createPluginFile(
    filePath: string,
    content: Uint8Array,
    expectedVaultId: string,
  ): Promise<NoteCreateOutcome>;
  writePluginFile(
    filePath: string,
    content: Uint8Array,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<VaultWriteResult>;
  renamePluginFile(
    filePath: string,
    targetPath: string,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<VaultRenameResult>;
  trashPluginFile(
    filePath: string,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<VaultRenameResult>;
  createPluginFolder(
    folderPath: string,
    expectedVaultId: string,
  ): Promise<VaultDirectoryCreateResult>;
  saveNote(
    filePath: string,
    content: string,
    expectedRevision: string,
    expectedVaultId: string,
    paneId?: WorkspacePaneId,
  ): Promise<NoteSaveResponse>;
  setNoteProperty(
    filePath: string,
    name: string,
    rawValue: string,
    type: NotePropertyType,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<NotePropertySetResponse>;
  removeNoteProperty(
    filePath: string,
    name: string,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<NotePropertyRemoveResponse>;
  runPluginCommand(
    commandId: string,
    editorContext?: PluginEditorContext,
  ): Promise<RuntimeSnapshot>;
  waitForPluginMutations(options?: PluginMutationWaitOptions): Promise<RuntimeSnapshot>;
  markPluginLayoutReady(): Promise<RuntimeSnapshot>;
  openPluginSettings(pluginId: string): Promise<RuntimeSnapshot>;
  openPluginView(viewType: string, filePath?: string): Promise<RuntimeSnapshot>;
  closePluginView(): Promise<RuntimeSnapshot>;
  loadPlugin(request: PluginConstructionRequest): Promise<RuntimeSnapshot>;
  reloadPlugin(request?: PluginConstructionRequest): Promise<RuntimeSnapshot>;
  unloadPlugin(pluginId?: string): Promise<RuntimeSnapshot>;
  unloadAllPlugins(): Promise<RuntimeSnapshot>;
  onSnapshot(listener: (snapshot: RuntimeSnapshot) => void): () => void;
  close(): Promise<void>;
}

export type WorkspaceRuntimeFactory = (
  options: WorkspaceRuntimeOptions,
) => Promise<WorkspaceRuntimePort>;

export interface WorkspaceControllerOptions {
  stateRoot: StateRootPort;
  selectionStore: VaultSelectionStore;
  fixtureVaultPath: string;
  fixturePluginConstructionRequest?: PluginConstructionRequest;
  configuredVaultPath?: string;
  configuredPluginConstructionRequest?: PluginConstructionRequest;
  deferInitialVault?: boolean;
  pluginModuleResolver?: PluginModuleResolver;
  pluginRuntimeFactory?: PluginRuntimeFactory;
  runtimeFactory?: WorkspaceRuntimeFactory;
  workspaceStateStore?: WorkspaceStateStore;
  beforeWorkspaceStateRestore?: (vaultId: string) => Promise<void>;
  workspaceSettingsForVault?: (vaultId: string) => VaultWorkspaceSettings;
  diagnostics?: WorkspaceOpenDiagnostics;
}

type SnapshotListener = (snapshot: RuntimeSnapshot) => void;

interface DeferredInitialVault {
  pluginConstructionRequest?: PluginConstructionRequest;
  source: Extract<VaultSelectionSource, "environment" | "restored">;
  vaultPath: string;
}

export type InitialVaultActivationOutcome =
  | { status: "activated" | "failed" | "not-pending"; snapshot: RuntimeSnapshot }
  | { status: "superseded"; snapshot: null };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runtimeOptions(
  vaultRoot: string,
  stateRoot: StateRootPort,
  selectionSource: VaultSelectionSource,
  warning: string | null,
  workspaceStateStore?: WorkspaceStateStore,
  pluginConstructionRequest?: PluginConstructionRequest,
  pluginModuleResolver?: PluginModuleResolver,
  pluginRuntimeFactory?: PluginRuntimeFactory,
  workspaceSettingsForVault?: (vaultId: string) => VaultWorkspaceSettings,
  beforeWorkspaceStateRestore?: (vaultId: string) => Promise<void>,
  diagnostics?: WorkspaceOpenDiagnostics,
): WorkspaceRuntimeOptions {
  return {
    vaultRoot,
    stateRoot,
    selectionSource,
    warning,
    ...(workspaceStateStore ? { workspaceStateStore } : {}),
    ...(pluginConstructionRequest ? { pluginConstructionRequest } : {}),
    ...(pluginModuleResolver ? { pluginModuleResolver } : {}),
    ...(pluginRuntimeFactory ? { pluginRuntimeFactory } : {}),
    ...(workspaceSettingsForVault ? { workspaceSettingsForVault } : {}),
    ...(beforeWorkspaceStateRestore ? { beforeWorkspaceStateRestore } : {}),
    ...(diagnostics ? { diagnostics } : {}),
    ...(selectionSource !== "bundled" ? { deferWorkspaceCensus: true } : {}),
  };
}

export class WorkspaceController {
  readonly #stateRoot: StateRootPort;
  readonly #selectionStore: VaultSelectionStore;
  readonly #workspaceStateStore: WorkspaceStateStore | undefined;
  readonly #runtimeFactory: WorkspaceRuntimeFactory;
  readonly #pluginModuleResolver: PluginModuleResolver | undefined;
  readonly #pluginRuntimeFactory: PluginRuntimeFactory | undefined;
  readonly #beforeWorkspaceStateRestore: ((vaultId: string) => Promise<void>) | undefined;
  readonly #workspaceSettingsForVault: ((vaultId: string) => VaultWorkspaceSettings) | undefined;
  readonly #diagnostics: WorkspaceOpenDiagnostics | undefined;
  readonly #listeners = new Set<SnapshotListener>();
  #runtime: WorkspaceRuntimePort;
  #releaseRuntimeListener: () => void;
  #deferredInitialVault: DeferredInitialVault | null;
  #activationGeneration = 0;
  #controllerWarning: string | null = null;

  private constructor(
    runtime: WorkspaceRuntimePort,
    options: WorkspaceControllerOptions,
    runtimeFactory: WorkspaceRuntimeFactory,
    deferredInitialVault: DeferredInitialVault | null = null,
  ) {
    this.#runtime = runtime;
    this.#stateRoot = options.stateRoot;
    this.#selectionStore = options.selectionStore;
    this.#workspaceStateStore = options.workspaceStateStore;
    this.#runtimeFactory = runtimeFactory;
    this.#pluginModuleResolver = options.pluginModuleResolver;
    this.#pluginRuntimeFactory = options.pluginRuntimeFactory;
    this.#beforeWorkspaceStateRestore = options.beforeWorkspaceStateRestore;
    this.#workspaceSettingsForVault = options.workspaceSettingsForVault;
    this.#diagnostics = options.diagnostics;
    this.#deferredInitialVault = deferredInitialVault;
    this.#releaseRuntimeListener = this.bindRuntime(runtime);
  }

  static async open(options: WorkspaceControllerOptions): Promise<WorkspaceController> {
    const runtimeFactory = options.runtimeFactory ?? WorkspaceRuntime.open;
    if (options.configuredVaultPath) {
      if (options.deferInitialVault) {
        const runtime = await runtimeFactory(
          runtimeOptions(
            options.fixtureVaultPath,
            options.stateRoot,
            "bundled",
            null,
            options.workspaceStateStore,
            undefined,
            options.pluginModuleResolver,
            undefined,
            options.workspaceSettingsForVault,
            undefined,
            options.diagnostics,
          ),
        );
        return new WorkspaceController(runtime, options, runtimeFactory, {
          vaultPath: options.configuredVaultPath,
          source: "environment",
          ...(options.configuredPluginConstructionRequest
            ? { pluginConstructionRequest: options.configuredPluginConstructionRequest }
            : {}),
        });
      }
      const runtime = await runtimeFactory(
        runtimeOptions(
          options.configuredVaultPath,
          options.stateRoot,
          "environment",
          null,
          options.workspaceStateStore,
          options.configuredPluginConstructionRequest,
          options.pluginModuleResolver,
          options.pluginRuntimeFactory,
          options.workspaceSettingsForVault,
          undefined,
          options.diagnostics,
        ),
      );
      return new WorkspaceController(runtime, options, runtimeFactory);
    }

    let restoredPath: string | null = null;
    let restoreWarning: string | null = null;
    try {
      restoredPath = await options.selectionStore.load();
    } catch (error) {
      restoreWarning = `Could not read the saved vault selection: ${errorMessage(error)}`;
    }

    if (restoredPath) {
      if (options.deferInitialVault) {
        const runtime = await runtimeFactory(
          runtimeOptions(
            options.fixtureVaultPath,
            options.stateRoot,
            "bundled",
            restoreWarning,
            options.workspaceStateStore,
            undefined,
            options.pluginModuleResolver,
            undefined,
            options.workspaceSettingsForVault,
            undefined,
            options.diagnostics,
          ),
        );
        return new WorkspaceController(runtime, options, runtimeFactory, {
          vaultPath: restoredPath,
          source: "restored",
        });
      }
      try {
        const runtime = await runtimeFactory(
          runtimeOptions(
            restoredPath,
            options.stateRoot,
            "restored",
            null,
            options.workspaceStateStore,
            undefined,
            options.pluginModuleResolver,
            options.pluginRuntimeFactory,
            options.workspaceSettingsForVault,
            undefined,
            options.diagnostics,
          ),
        );
        return new WorkspaceController(runtime, options, runtimeFactory);
      } catch (error) {
        restoreWarning = `Could not restore ${restoredPath}: ${errorMessage(error)} Opened the bundled vault instead.`;
      }
    }

    const runtime = await runtimeFactory(
      runtimeOptions(
        options.fixtureVaultPath,
        options.stateRoot,
        "bundled",
        restoreWarning,
        options.workspaceStateStore,
        options.deferInitialVault ? undefined : options.fixturePluginConstructionRequest,
        options.pluginModuleResolver,
        options.deferInitialVault ? undefined : options.pluginRuntimeFactory,
        options.workspaceSettingsForVault,
        undefined,
        options.diagnostics,
      ),
    );
    return new WorkspaceController(runtime, options, runtimeFactory);
  }

  get vaultId(): string {
    return this.#runtime.vaultId;
  }

  get vaultPath(): string {
    return this.#runtime.vaultPath;
  }

  getSnapshot(): Promise<RuntimeSnapshot> {
    return this.#runtime.getSnapshot().then((snapshot) => this.decorateSnapshot(snapshot));
  }

  async getWorkspaceFilePage(
    request: WorkspaceFilePageRequest,
  ): Promise<WorkspaceFilePageResponse> {
    const runtime = this.activeRuntime("load workspace files");
    if (runtime.vaultId !== request.expectedVaultId) {
      return { status: "stale-vault", vaultId: runtime.vaultId };
    }
    const response = await runtime.getWorkspaceFilePage(request);
    if (this.#runtime !== runtime || this.#runtime.vaultId !== request.expectedVaultId) {
      return { status: "stale-vault", vaultId: this.#runtime.vaultId };
    }
    return response;
  }

  async getWorkspaceTreePage(
    request: WorkspaceTreePageRequest,
  ): Promise<WorkspaceTreePageResponse> {
    const runtime = this.activeRuntime("load workspace tree entries");
    if (runtime.vaultId !== request.expectedVaultId) {
      return { status: "stale-vault", vaultId: runtime.vaultId };
    }
    const response = await runtime.getWorkspaceTreePage(request);
    if (this.#runtime !== runtime || this.#runtime.vaultId !== request.expectedVaultId) {
      return { status: "stale-vault", vaultId: this.#runtime.vaultId };
    }
    return response;
  }

  async getWorkspaceTagCatalog(
    request: WorkspaceTagCatalogRequest,
  ): Promise<WorkspaceTagCatalogResponse> {
    const runtime = this.activeRuntime("load workspace tags");
    if (runtime.vaultId !== request.expectedVaultId) {
      return { status: "stale-vault", vaultId: runtime.vaultId };
    }
    const response = await runtime.getWorkspaceTagCatalog(request);
    if (this.#runtime !== runtime || this.#runtime.vaultId !== request.expectedVaultId) {
      return { status: "stale-vault", vaultId: this.#runtime.vaultId };
    }
    return response;
  }

  async getWorkspaceTreePath(
    request: WorkspaceTreePathRequest,
  ): Promise<WorkspaceTreePathResponse> {
    const runtime = this.activeRuntime("locate a workspace tree entry");
    if (runtime.vaultId !== request.expectedVaultId) {
      return { status: "stale-vault", vaultId: runtime.vaultId };
    }
    const response = await runtime.getWorkspaceTreePath(request);
    if (this.#runtime !== runtime || this.#runtime.vaultId !== request.expectedVaultId) {
      return { status: "stale-vault", vaultId: this.#runtime.vaultId };
    }
    return response;
  }

  async activateDeferredInitialVault(): Promise<InitialVaultActivationOutcome> {
    const target = this.#deferredInitialVault;
    if (!target) {
      return { status: "not-pending", snapshot: await this.getSnapshot() };
    }

    const generation = ++this.#activationGeneration;
    this.publish(await this.getSnapshot());
    let nextRuntime: WorkspaceRuntimePort;
    try {
      nextRuntime = await this.#runtimeFactory(
        runtimeOptions(
          target.vaultPath,
          this.#stateRoot,
          target.source,
          null,
          this.#workspaceStateStore,
          target.pluginConstructionRequest,
          this.#pluginModuleResolver,
          this.#pluginRuntimeFactory,
          this.#workspaceSettingsForVault,
          this.#beforeWorkspaceStateRestore,
          this.#diagnostics,
        ),
      );
    } catch (error) {
      if (generation !== this.#activationGeneration || this.#deferredInitialVault !== target) {
        return { status: "superseded", snapshot: null };
      }
      this.#deferredInitialVault = null;
      this.#controllerWarning =
        target.source === "restored"
          ? `Could not restore ${target.vaultPath}: ${errorMessage(error)} Opened the bundled vault instead.`
          : `Could not open the configured vault ${target.vaultPath}: ${errorMessage(error)} Opened the bundled vault instead.`;
      const snapshot = await this.getSnapshot();
      this.publish(snapshot);
      return { status: "failed", snapshot };
    }

    let adopted = false;
    try {
      const snapshot = await nextRuntime.getSnapshot();
      if (generation !== this.#activationGeneration || this.#deferredInitialVault !== target) {
        await nextRuntime.close().catch(() => undefined);
        return { status: "superseded", snapshot: null };
      }
      this.#deferredInitialVault = null;
      this.#controllerWarning = null;
      const adoption = this.adoptRuntime(nextRuntime, snapshot);
      adopted = true;
      await adoption;
      return { status: "activated", snapshot };
    } catch (error) {
      if (!adopted) {
        await nextRuntime.close().catch(() => undefined);
      }
      throw error;
    }
  }

  searchVault(query: string): Promise<VaultSearchResponse> {
    return this.activeRuntime("search").searchVault(query);
  }

  async getVaultGraph(
    request: VaultGraphRequest,
    expectedVaultId: string,
  ): Promise<VaultGraphResponse> {
    const runtime = this.activeRuntime("open the graph");
    if (runtime.vaultId !== expectedVaultId) {
      return { status: "stale-vault", vaultId: runtime.vaultId };
    }
    const response = await runtime.getVaultGraph(request, expectedVaultId);
    if (this.#runtime !== runtime || this.#runtime.vaultId !== expectedVaultId) {
      return { status: "stale-vault", vaultId: this.#runtime.vaultId };
    }
    return response;
  }

  async loadVaultImage(
    sourceNotePath: string,
    target: string,
    expectedVaultId: string,
  ): Promise<VaultImageResponse> {
    const runtime = this.activeRuntime("load an image");
    if (runtime.vaultId !== expectedVaultId) {
      return { status: "stale-vault", vaultId: runtime.vaultId };
    }
    const response = await runtime.loadVaultImage(sourceNotePath, target, expectedVaultId);
    if (this.#runtime !== runtime || this.#runtime.vaultId !== expectedVaultId) {
      return { status: "stale-vault", vaultId: this.#runtime.vaultId };
    }
    return response;
  }

  async loadVaultAttachment(
    sourceNotePath: string,
    target: string,
    expectedVaultId: string,
  ): Promise<VaultAttachmentResponse> {
    const runtime = this.activeRuntime("load an attachment");
    if (runtime.vaultId !== expectedVaultId) {
      return { status: "stale-vault", vaultId: runtime.vaultId };
    }
    const response = await runtime.loadVaultAttachment(sourceNotePath, target, expectedVaultId);
    if (this.#runtime !== runtime || this.#runtime.vaultId !== expectedVaultId) {
      return { status: "stale-vault", vaultId: this.#runtime.vaultId };
    }
    return response;
  }

  async loadVaultFilePreview(
    path: string,
    expectedVaultId: string,
    expectedInventoryGeneration: string,
  ): Promise<VaultFilePreviewResponse> {
    const runtime = this.activeRuntime("preview a file");
    if (runtime.vaultId !== expectedVaultId) {
      return { status: "stale-vault", vaultId: runtime.vaultId };
    }
    const response = await runtime.loadVaultFilePreview(
      path,
      expectedVaultId,
      expectedInventoryGeneration,
    );
    if (this.#runtime !== runtime || this.#runtime.vaultId !== expectedVaultId) {
      return { status: "stale-vault", vaultId: this.#runtime.vaultId };
    }
    return response;
  }

  async loadVaultNoteEmbed(
    sourceNotePath: string,
    target: string,
    subpath: string | null,
    expectedVaultId: string,
  ): Promise<VaultNoteEmbedResponse> {
    const runtime = this.activeRuntime("load a note embed");
    if (runtime.vaultId !== expectedVaultId) {
      return { status: "stale-vault", vaultId: runtime.vaultId };
    }
    const response = await runtime.loadVaultNoteEmbed(
      sourceNotePath,
      target,
      subpath,
      expectedVaultId,
    );
    if (this.#runtime !== runtime || this.#runtime.vaultId !== expectedVaultId) {
      return { status: "stale-vault", vaultId: this.#runtime.vaultId };
    }
    return response;
  }

  async renderPluginMarkdownProjection(
    pluginId: string,
    sourceNotePath: string,
    content: string,
    expectedVaultId: string,
  ): Promise<PluginMarkdownProjectionResponse> {
    const runtime = this.activeRuntime("render a plugin Markdown projection");
    if (runtime.vaultId !== expectedVaultId) {
      return { status: "stale-vault", vaultId: runtime.vaultId };
    }
    const response = await runtime.renderPluginMarkdownProjection(
      pluginId,
      sourceNotePath,
      content,
      expectedVaultId,
    );
    if (this.#runtime !== runtime || this.#runtime.vaultId !== expectedVaultId) {
      return { status: "stale-vault", vaultId: this.#runtime.vaultId };
    }
    return response;
  }

  async loadCanvas(filePath: string, expectedVaultId: string): Promise<CanvasLoadResponse> {
    const runtime = this.activeRuntime("load a canvas");
    if (runtime.vaultId !== expectedVaultId) {
      return { status: "stale-vault", vaultId: runtime.vaultId };
    }
    if (!runtime.loadCanvas) {
      throw new Error("The active runtime does not provide Canvas support.");
    }
    const response = await runtime.loadCanvas(filePath, expectedVaultId);
    if (this.#runtime !== runtime || this.#runtime.vaultId !== expectedVaultId) {
      return { status: "stale-vault", vaultId: this.#runtime.vaultId };
    }
    return response;
  }

  async loadCanvasAttachment(
    sourceCanvasPath: string,
    target: string,
    expectedVaultId: string,
  ): Promise<CanvasAttachmentResponse> {
    const runtime = this.activeRuntime("load a canvas attachment");
    if (runtime.vaultId !== expectedVaultId) {
      return { status: "stale-vault", vaultId: runtime.vaultId };
    }
    if (!runtime.loadCanvasAttachment) {
      throw new Error("The active runtime does not provide Canvas attachment support.");
    }
    const response = await runtime.loadCanvasAttachment(sourceCanvasPath, target, expectedVaultId);
    if (this.#runtime !== runtime || this.#runtime.vaultId !== expectedVaultId) {
      return { status: "stale-vault", vaultId: this.#runtime.vaultId };
    }
    return response;
  }

  openNote(
    filePath: string,
    paneId?: WorkspacePaneId,
    activate?: boolean,
  ): Promise<RuntimeSnapshot> {
    return this.activeRuntime("open a note").openNote(filePath, paneId, activate);
  }

  goBack(expectedVaultId: string, paneId?: WorkspacePaneId): Promise<RuntimeSnapshot> {
    return this.activeRuntime("go back in note history").goBack(expectedVaultId, paneId);
  }

  goForward(expectedVaultId: string, paneId?: WorkspacePaneId): Promise<RuntimeSnapshot> {
    return this.activeRuntime("go forward in note history").goForward(expectedVaultId, paneId);
  }

  getWorkspaceSettings(): VaultWorkspaceSettings {
    return this.activeRuntime("read workspace preferences").getWorkspaceSettings();
  }

  setWorkspaceSettings(settings: VaultWorkspaceSettings, expectedVaultId: string): void {
    this.activeRuntime("apply workspace preferences").setWorkspaceSettings(
      settings,
      expectedVaultId,
    );
  }

  closeNote(
    filePath: string,
    expectedVaultId: string,
    paneId?: WorkspacePaneId,
  ): Promise<RuntimeSnapshot> {
    return this.activeRuntime("close a note").closeNote(filePath, expectedVaultId, paneId);
  }

  toggleTabPin(
    filePath: string,
    paneId: WorkspacePaneId,
    expectedVaultId: string,
  ): Promise<RuntimeSnapshot> {
    return this.activeRuntime("toggle a tab pin").toggleTabPin(filePath, paneId, expectedVaultId);
  }

  splitWorkspace(
    direction: WorkspaceSplitDirection,
    expectedVaultId: string,
  ): Promise<RuntimeSnapshot> {
    return this.activeRuntime("split the workspace").splitWorkspace(direction, expectedVaultId);
  }

  focusWorkspacePane(paneId: WorkspacePaneId, expectedVaultId: string): Promise<RuntimeSnapshot> {
    return this.activeRuntime("focus a workspace pane").focusWorkspacePane(paneId, expectedVaultId);
  }

  closeWorkspacePane(paneId: WorkspacePaneId, expectedVaultId: string): Promise<RuntimeSnapshot> {
    return this.activeRuntime("close a workspace pane").closeWorkspacePane(paneId, expectedVaultId);
  }

  moveNoteToWorkspacePane(
    filePath: string,
    fromPaneId: WorkspacePaneId,
    toPaneId: WorkspacePaneId,
    expectedVaultId: string,
  ): Promise<RuntimeSnapshot> {
    return this.activeRuntime("move a tab between panes").moveNoteToWorkspacePane(
      filePath,
      fromPaneId,
      toPaneId,
      expectedVaultId,
    );
  }

  getWorkspaceState(expectedVaultId: string): Promise<PersistedWorkspaceState> {
    const runtime = this.activeRuntime("read workspace migration state");
    if (!runtime.getWorkspaceState) {
      throw new Error("The active workspace does not support migration state reads.");
    }
    return runtime.getWorkspaceState(expectedVaultId);
  }

  setWorkspaceState(
    state: PersistedWorkspaceState,
    expectedVaultId: string,
    expectedCurrent?: PersistedWorkspaceState | null,
  ): Promise<RuntimeSnapshot> {
    const runtime = this.activeRuntime("apply workspace migration state");
    if (!runtime.setWorkspaceState) {
      throw new Error("The active workspace does not support migration state writes.");
    }
    return runtime.setWorkspaceState(state, expectedVaultId, expectedCurrent);
  }

  reorderWorkspaceTab(
    filePath: string,
    paneId: WorkspacePaneId,
    targetIndex: number,
    expectedVaultId: string,
  ): Promise<RuntimeSnapshot> {
    return this.activeRuntime("reorder a workspace tab").reorderWorkspaceTab(
      filePath,
      paneId,
      targetIndex,
      expectedVaultId,
    );
  }

  moveNote(
    filePath: string,
    targetPath: string,
    expectedRevision: string,
    expectedVaultId: string,
    confirmationId?: string,
  ): Promise<NoteMoveResponse> {
    return this.activeRuntime("move a note").moveNote(
      filePath,
      targetPath,
      expectedRevision,
      expectedVaultId,
      confirmationId,
    );
  }

  async moveAttachment(
    filePath: string,
    targetPath: string,
    expectedRevision: string,
    expectedVaultId: string,
    confirmationId?: string,
    operation: AttachmentOperation = "publish-copy",
  ): Promise<AttachmentMoveResponse> {
    const runtime = this.activeRuntime("move an attachment");
    if (!runtime.moveAttachment) {
      throw new Error("The active workspace does not support attachment file operations.");
    }
    if (runtime.vaultId !== expectedVaultId) {
      throw new Error(
        operation === "rename"
          ? "The active vault changed before this attachment could be renamed."
          : "The active vault changed before this attachment copy could be published.",
      );
    }
    const response = await runtime.moveAttachment(
      filePath,
      targetPath,
      expectedRevision,
      expectedVaultId,
      confirmationId,
      operation,
    );
    if (this.#runtime !== runtime || this.#runtime.vaultId !== expectedVaultId) {
      if (
        response.outcome.status === "published-source-retained" ||
        response.outcome.status === "committed"
      ) {
        const activeRuntime = this.#runtime;
        return {
          ...response,
          snapshot: await activeRuntime.getSnapshot(),
          committedVaultId: runtime.vaultId,
          committedVaultName: displaySafeVaultName(response.snapshot.vault.name),
        };
      }
      return {
        outcome: { status: "conflict", from: filePath, to: targetPath, reason: "stale-vault" },
        snapshot: await this.#runtime.getSnapshot(),
      };
    }
    return response;
  }

  async relinkAttachment(
    sourceNotePath: string,
    missingTarget: string,
    replacementPath: string,
    expectedSourceRevision: string,
    expectedVaultId: string,
    confirmationId?: string,
  ): Promise<AttachmentRelinkResponse> {
    const runtime = this.activeRuntime("relink a missing attachment");
    if (!runtime.relinkAttachment) {
      throw new Error("The active workspace does not support attachment relinking.");
    }
    if (runtime.vaultId !== expectedVaultId) {
      return {
        outcome: {
          status: "refused",
          sourceNotePath,
          missingPath: missingTarget,
          replacementPath,
          reason: "stale-vault",
          message: "The active vault changed before this attachment could be relinked.",
        },
        snapshot: await runtime.getSnapshot(),
      };
    }
    const response = await runtime.relinkAttachment(
      sourceNotePath,
      missingTarget,
      replacementPath,
      expectedSourceRevision,
      expectedVaultId,
      confirmationId,
    );
    if (this.#runtime !== runtime || this.#runtime.vaultId !== expectedVaultId) {
      if (response.outcome.status === "committed") {
        return {
          ...response,
          snapshot: await this.#runtime.getSnapshot(),
          committedVaultId: runtime.vaultId,
          committedVaultName: displaySafeVaultName(response.snapshot.vault.name),
        };
      }
      return {
        outcome: {
          status: "refused",
          sourceNotePath,
          missingPath: missingTarget,
          replacementPath,
          reason: "stale-vault",
          message: "The active vault changed before this attachment could be relinked.",
        },
        snapshot: await this.#runtime.getSnapshot(),
      };
    }
    return response;
  }

  async restoreAttachment(
    sourceNotePath: string,
    missingTarget: string,
    sourceFileName: string,
    bytes: Uint8Array,
    expectedSourceRevision: string,
    expectedVaultId: string,
    confirmationId?: string,
  ): Promise<AttachmentRestoreResponse> {
    const runtime = this.activeRuntime("restore a missing attachment");
    if (!runtime.restoreAttachment) {
      throw new Error("The active workspace does not support attachment restoration.");
    }
    const staleOutcome = () => ({
      status: "refused" as const,
      sourceNotePath,
      missingPath: missingTarget,
      sourceFileName,
      reason: "stale-vault" as const,
      message: "The active vault changed before this attachment could be restored.",
    });
    if (runtime.vaultId !== expectedVaultId) {
      return { outcome: staleOutcome(), snapshot: await runtime.getSnapshot() };
    }
    const response = await runtime.restoreAttachment(
      sourceNotePath,
      missingTarget,
      sourceFileName,
      bytes,
      expectedSourceRevision,
      expectedVaultId,
      confirmationId,
    );
    if (this.#runtime !== runtime || this.#runtime.vaultId !== expectedVaultId) {
      if (
        response.outcome.status === "committed" ||
        response.outcome.status === "manual-conflict"
      ) {
        return {
          ...response,
          snapshot: await this.#runtime.getSnapshot(),
          affectedVaultId: runtime.vaultId,
          affectedVaultName: displaySafeVaultName(response.snapshot.vault.name),
        };
      }
      return { outcome: staleOutcome(), snapshot: await this.#runtime.getSnapshot() };
    }
    return response;
  }

  async insertAttachment(
    sourceNotePath: string,
    targetPath: string,
    sourceFileName: string,
    bytes: Uint8Array,
    expectedSourceRevision: string,
    expectedVaultId: string,
    selectionStart: number,
    selectionEnd: number,
    confirmationId?: string,
  ): Promise<AttachmentInsertResponse> {
    const runtime = this.activeRuntime("insert an external attachment");
    if (!runtime.insertAttachment) {
      throw new Error("The active workspace does not support attachment insertion.");
    }
    const staleOutcome = () => ({
      status: "refused" as const,
      sourceNotePath,
      targetPath,
      sourceFileName,
      reason: "stale-vault" as const,
      message: "The active vault changed before this attachment could be inserted.",
    });
    if (runtime.vaultId !== expectedVaultId) {
      return { outcome: staleOutcome(), snapshot: await runtime.getSnapshot() };
    }
    const response = await runtime.insertAttachment(
      sourceNotePath,
      targetPath,
      sourceFileName,
      bytes,
      expectedSourceRevision,
      expectedVaultId,
      selectionStart,
      selectionEnd,
      confirmationId,
    );
    if (this.#runtime !== runtime || this.#runtime.vaultId !== expectedVaultId) {
      if (
        response.outcome.status === "committed" ||
        response.outcome.status === "conflict-copy" ||
        response.outcome.status === "manual-conflict"
      ) {
        return {
          ...response,
          snapshot: await this.#runtime.getSnapshot(),
          affectedVaultId: runtime.vaultId,
          affectedVaultName: displaySafeVaultName(response.snapshot.vault.name),
        };
      }
      return { outcome: staleOutcome(), snapshot: await this.#runtime.getSnapshot() };
    }
    return response;
  }

  async insertAttachmentBatch(
    sourceNotePath: string,
    items: Array<{
      targetPath: string;
      sourceFileName: string;
      bytes: Uint8Array;
      selectionStart: number;
      selectionEnd: number;
    }>,
    expectedSourceRevision: string,
    expectedVaultId: string,
    confirmationId?: string,
  ): Promise<AttachmentBatchInsertResponse> {
    const runtime = this.activeRuntime("insert an external attachment batch");
    if (!runtime.insertAttachmentBatch) {
      throw new Error("The active workspace does not support attachment batch insertion.");
    }
    const staleOutcome = () => ({
      status: "refused" as const,
      sourceNotePath,
      targetPaths: items.map((item) => item.targetPath),
      sourceFileNames: items.map((item) => item.sourceFileName),
      reason: "stale-vault" as const,
      message: "The active vault changed before this attachment batch could be inserted.",
    });
    if (runtime.vaultId !== expectedVaultId) {
      return { outcome: staleOutcome(), snapshot: await runtime.getSnapshot() };
    }
    const response = await runtime.insertAttachmentBatch(
      sourceNotePath,
      items,
      expectedSourceRevision,
      expectedVaultId,
      confirmationId,
    );
    if (this.#runtime !== runtime || this.#runtime.vaultId !== expectedVaultId) {
      if (
        response.outcome.status === "committed" ||
        response.outcome.status === "conflict-copy" ||
        response.outcome.status === "manual-conflict"
      ) {
        return {
          ...response,
          snapshot: await this.#runtime.getSnapshot(),
          affectedVaultId: runtime.vaultId,
          affectedVaultName: displaySafeVaultName(response.snapshot.vault.name),
        };
      }
      return { outcome: staleOutcome(), snapshot: await this.#runtime.getSnapshot() };
    }
    return response;
  }

  deleteNote(
    filePath: string,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<NoteDeleteResponse> {
    return this.activeRuntime("trash a note").deleteNote(
      filePath,
      expectedRevision,
      expectedVaultId,
    );
  }

  async getVaultTrash(expectedVaultId: string): Promise<VaultTrashResponse> {
    const runtime = this.activeRuntime("inspect recoverable trash");
    if (runtime.vaultId !== expectedVaultId) {
      return { status: "stale-vault", vaultId: runtime.vaultId };
    }
    const response = await runtime.getVaultTrash(expectedVaultId);
    if (this.#runtime !== runtime || this.#runtime.vaultId !== expectedVaultId) {
      return { status: "stale-vault", vaultId: this.#runtime.vaultId };
    }
    return response;
  }

  restoreNote(
    filePath: string,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<NoteRestoreResponse> {
    return this.activeRuntime("restore a note").restoreNote(
      filePath,
      expectedRevision,
      expectedVaultId,
    );
  }

  createNote(
    filePath: string,
    content: string,
    expectedVaultId: string,
  ): Promise<NoteCreateResponse> {
    return this.activeRuntime("create a note").createNote(filePath, content, expectedVaultId);
  }

  openDailyNote(
    settings: VaultNoteWorkflowSettings,
    expectedVaultId: string,
  ): Promise<NoteCreateResponse> {
    return this.activeRuntime("open today's daily note").openDailyNote(settings, expectedVaultId);
  }

  listNoteTemplates(templateFolder: string, expectedVaultId: string): Promise<string[]> {
    return this.activeRuntime("list note templates").listNoteTemplates(
      templateFolder,
      expectedVaultId,
    );
  }

  renderNoteTemplate(
    templatePath: string,
    targetPath: string,
    settings: VaultNoteWorkflowSettings,
    expectedVaultId: string,
  ): Promise<RenderedNoteTemplate> {
    return this.activeRuntime("render a note template").renderNoteTemplate(
      templatePath,
      targetPath,
      settings,
      expectedVaultId,
    );
  }

  formatNoteWorkflowValue(
    value: "date" | "time",
    settings: VaultNoteWorkflowSettings,
    expectedVaultId: string,
  ): string {
    return this.activeRuntime("format a template value").formatNoteWorkflowValue(
      value,
      settings,
      expectedVaultId,
    );
  }

  createPluginNote(
    filePath: string,
    content: string,
    expectedVaultId: string,
  ): Promise<NoteCreateOutcome> {
    return this.activeRuntime("create a plugin note").createPluginNote(
      filePath,
      content,
      expectedVaultId,
    );
  }

  createPluginFile(
    filePath: string,
    content: Uint8Array,
    expectedVaultId: string,
  ): Promise<NoteCreateOutcome> {
    return this.activeRuntime("create a plugin file").createPluginFile(
      filePath,
      content,
      expectedVaultId,
    );
  }

  writePluginFile(
    filePath: string,
    content: Uint8Array,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<VaultWriteResult> {
    return this.activeRuntime("write a plugin file").writePluginFile(
      filePath,
      content,
      expectedRevision,
      expectedVaultId,
    );
  }

  renamePluginFile(
    filePath: string,
    targetPath: string,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<VaultRenameResult> {
    return this.activeRuntime("rename a plugin file").renamePluginFile(
      filePath,
      targetPath,
      expectedRevision,
      expectedVaultId,
    );
  }

  trashPluginFile(
    filePath: string,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<VaultRenameResult> {
    return this.activeRuntime("trash a plugin file").trashPluginFile(
      filePath,
      expectedRevision,
      expectedVaultId,
    );
  }

  createPluginFolder(
    folderPath: string,
    expectedVaultId: string,
  ): Promise<VaultDirectoryCreateResult> {
    return this.activeRuntime("create a plugin folder").createPluginFolder(
      folderPath,
      expectedVaultId,
    );
  }

  async createWorkspaceFolder(
    folderPath: string,
    expectedVaultId: string,
  ): Promise<VaultDirectoryCreateResult> {
    assertPublicWorkspaceFolderPath(folderPath);
    return this.createPluginFolder(folderPath, expectedVaultId);
  }

  saveNote(
    filePath: string,
    content: string,
    expectedRevision: string,
    expectedVaultId: string,
    paneId?: WorkspacePaneId,
  ): Promise<NoteSaveResponse> {
    return this.activeRuntime("save a note").saveNote(
      filePath,
      content,
      expectedRevision,
      expectedVaultId,
      paneId,
    );
  }

  saveCanvas(
    filePath: string,
    content: string,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<CanvasSaveResponse> {
    const runtime = this.activeRuntime("save a canvas");
    if (!runtime.saveCanvas) {
      throw new Error("The active runtime does not provide Canvas support.");
    }
    return runtime.saveCanvas(filePath, content, expectedRevision, expectedVaultId);
  }

  setNoteProperty(
    filePath: string,
    name: string,
    rawValue: string,
    type: NotePropertyType,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<NotePropertySetResponse> {
    return this.activeRuntime("edit a note property").setNoteProperty(
      filePath,
      name,
      rawValue,
      type,
      expectedRevision,
      expectedVaultId,
    );
  }

  removeNoteProperty(
    filePath: string,
    name: string,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<NotePropertyRemoveResponse> {
    return this.activeRuntime("remove a note property").removeNoteProperty(
      filePath,
      name,
      expectedRevision,
      expectedVaultId,
    );
  }

  runPluginCommand(
    commandId: string,
    editorContext?: PluginEditorContext,
  ): Promise<RuntimeSnapshot> {
    return this.activeRuntime("run a plugin command").runPluginCommand(commandId, editorContext);
  }

  waitForPluginMutations(options?: PluginMutationWaitOptions): Promise<RuntimeSnapshot> {
    return this.activeRuntime("wait for plugin mutations").waitForPluginMutations(options);
  }

  markPluginLayoutReady(): Promise<RuntimeSnapshot> {
    return this.activeRuntime("mark plugin layout ready").markPluginLayoutReady();
  }

  openPluginSettings(pluginId: string): Promise<RuntimeSnapshot> {
    return this.activeRuntime("open plugin settings").openPluginSettings(pluginId);
  }

  openPluginView(viewType: string, filePath?: string): Promise<RuntimeSnapshot> {
    return this.activeRuntime("open a plugin view").openPluginView(viewType, filePath);
  }

  closePluginView(): Promise<RuntimeSnapshot> {
    return this.activeRuntime("close a plugin view").closePluginView();
  }

  loadPlugin(request: PluginConstructionRequest): Promise<RuntimeSnapshot> {
    return this.activeRuntime("load a plugin").loadPlugin(request);
  }

  reloadPlugin(request?: PluginConstructionRequest): Promise<RuntimeSnapshot> {
    return this.activeRuntime("reload a plugin").reloadPlugin(request);
  }

  unloadPlugin(pluginId?: string): Promise<RuntimeSnapshot> {
    return this.activeRuntime("unload a plugin").unloadPlugin(pluginId);
  }

  unloadAllPlugins(): Promise<RuntimeSnapshot> {
    return this.activeRuntime("unload plugins").unloadAllPlugins();
  }

  async switchVault(vaultPath: string): Promise<RuntimeSnapshot> {
    if (this.#deferredInitialVault) {
      this.#deferredInitialVault = null;
      this.#controllerWarning = null;
      this.#activationGeneration += 1;
      this.publish(await this.getSnapshot());
    }
    const nextRuntime = await this.#runtimeFactory(
      runtimeOptions(
        vaultPath,
        this.#stateRoot,
        "picked",
        null,
        this.#workspaceStateStore,
        undefined,
        this.#pluginModuleResolver,
        this.#pluginRuntimeFactory,
        this.#workspaceSettingsForVault,
      ),
    );
    let adopted = false;
    try {
      const snapshot = await nextRuntime.getSnapshot();
      await this.#selectionStore.save(nextRuntime.vaultPath);
      const adoption = this.adoptRuntime(nextRuntime, snapshot);
      adopted = true;
      await adoption;
      return snapshot;
    } catch (error) {
      if (!adopted) {
        await nextRuntime.close().catch(() => undefined);
      }
      throw error;
    }
  }

  onSnapshot(listener: SnapshotListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.#activationGeneration += 1;
    this.#deferredInitialVault = null;
    this.#releaseRuntimeListener();
    this.#listeners.clear();
    await this.#runtime.close();
  }

  private bindRuntime(runtime: WorkspaceRuntimePort): () => void {
    return runtime.onSnapshot((snapshot) => this.publish(this.decorateSnapshot(snapshot)));
  }

  private activeRuntime(operation: string): WorkspaceRuntimePort {
    if (this.#deferredInitialVault) {
      throw new Error(
        `Cannot ${operation} while ${basename(this.#deferredInitialVault.vaultPath)} is still opening.`,
      );
    }
    return this.#runtime;
  }

  private async adoptRuntime(
    nextRuntime: WorkspaceRuntimePort,
    snapshot: RuntimeSnapshot,
  ): Promise<void> {
    const previousRuntime = this.#runtime;
    this.#releaseRuntimeListener();
    this.#runtime = nextRuntime;
    this.#releaseRuntimeListener = this.bindRuntime(nextRuntime);
    this.publish(this.decorateSnapshot(snapshot));
    await previousRuntime.close();
  }

  private decorateSnapshot(snapshot: RuntimeSnapshot): RuntimeSnapshot {
    const warning = this.#controllerWarning ?? snapshot.vault.warning;
    const startup = this.#deferredInitialVault;
    return {
      ...snapshot,
      vault: warning === snapshot.vault.warning ? snapshot.vault : { ...snapshot.vault, warning },
      ...(startup
        ? {
            startup: {
              phase: "opening" as const,
              source: startup.source,
              targetName: basename(startup.vaultPath) || startup.vaultPath,
              targetPath: startup.vaultPath,
            },
          }
        : {}),
    };
  }

  private publish(snapshot: RuntimeSnapshot): void {
    for (const listener of this.#listeners) {
      listener(snapshot);
    }
  }
}
