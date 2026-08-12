import { basename } from "node:path";
import type {
  StateRootPort,
  VaultDirectoryCreateResult,
  VaultRenameResult,
  VaultWriteResult,
} from "../kernel/ports";
import type { PluginModuleResolver } from "../runtime/plugin-host";
import type { PluginRuntimeFactory } from "../runtime/plugin-runtime-port";
import type {
  NoteCreateOutcome,
  NoteCreateResponse,
  NoteDeleteResponse,
  NoteMoveResponse,
  NoteSaveResponse,
  PluginEditorContext,
  RuntimeSnapshot,
  VaultImageResponse,
  VaultSearchResponse,
  VaultSelectionSource,
} from "../shared/contracts";
import { WorkspaceRuntime, type WorkspaceRuntimeOptions } from "./workspace-runtime";
import type { WorkspaceStateStore } from "./workspace-state";

export interface VaultSelectionStore {
  load(): Promise<string | null>;
  save(vaultPath: string): Promise<void>;
}

export interface WorkspaceRuntimePort {
  readonly vaultId: string;
  readonly vaultPath: string;
  getSnapshot(): Promise<RuntimeSnapshot>;
  searchVault(query: string): Promise<VaultSearchResponse>;
  loadVaultImage(
    sourceNotePath: string,
    target: string,
    expectedVaultId: string,
  ): Promise<VaultImageResponse>;
  openNote(filePath: string): Promise<RuntimeSnapshot>;
  closeNote(filePath: string, expectedVaultId: string): Promise<RuntimeSnapshot>;
  moveNote(
    filePath: string,
    targetPath: string,
    expectedRevision: string,
    expectedVaultId: string,
    confirmationId?: string,
  ): Promise<NoteMoveResponse>;
  deleteNote(
    filePath: string,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<NoteDeleteResponse>;
  createNote(
    filePath: string,
    content: string,
    expectedVaultId: string,
  ): Promise<NoteCreateResponse>;
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
  ): Promise<NoteSaveResponse>;
  runPluginCommand(
    commandId: string,
    editorContext?: PluginEditorContext,
  ): Promise<RuntimeSnapshot>;
  markPluginLayoutReady(): Promise<RuntimeSnapshot>;
  openPluginSettings(pluginId: string): Promise<RuntimeSnapshot>;
  openPluginView(viewType: string, filePath?: string): Promise<RuntimeSnapshot>;
  closePluginView(): Promise<RuntimeSnapshot>;
  loadPlugin(pluginDirectory: string, expectedBundleSha256?: string): Promise<RuntimeSnapshot>;
  reloadPlugin(pluginId?: string): Promise<RuntimeSnapshot>;
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
  fixturePluginDirectory?: string;
  configuredVaultPath?: string;
  configuredPluginDirectory?: string;
  deferInitialVault?: boolean;
  pluginModuleResolver?: PluginModuleResolver;
  pluginRuntimeFactory?: PluginRuntimeFactory;
  runtimeFactory?: WorkspaceRuntimeFactory;
  workspaceStateStore?: WorkspaceStateStore;
}

type SnapshotListener = (snapshot: RuntimeSnapshot) => void;

interface DeferredInitialVault {
  pluginDirectory?: string;
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
  pluginDirectory?: string,
  pluginModuleResolver?: PluginModuleResolver,
  pluginRuntimeFactory?: PluginRuntimeFactory,
): WorkspaceRuntimeOptions {
  return {
    vaultRoot,
    stateRoot,
    selectionSource,
    warning,
    ...(workspaceStateStore ? { workspaceStateStore } : {}),
    ...(pluginDirectory ? { pluginDirectory } : {}),
    ...(pluginModuleResolver ? { pluginModuleResolver } : {}),
    ...(pluginRuntimeFactory ? { pluginRuntimeFactory } : {}),
  };
}

export class WorkspaceController {
  readonly #stateRoot: StateRootPort;
  readonly #selectionStore: VaultSelectionStore;
  readonly #workspaceStateStore: WorkspaceStateStore | undefined;
  readonly #runtimeFactory: WorkspaceRuntimeFactory;
  readonly #pluginModuleResolver: PluginModuleResolver | undefined;
  readonly #pluginRuntimeFactory: PluginRuntimeFactory | undefined;
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
          ),
        );
        return new WorkspaceController(runtime, options, runtimeFactory, {
          vaultPath: options.configuredVaultPath,
          source: "environment",
          ...(options.configuredPluginDirectory
            ? { pluginDirectory: options.configuredPluginDirectory }
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
          options.configuredPluginDirectory,
          options.pluginModuleResolver,
          options.pluginRuntimeFactory,
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
        options.fixturePluginDirectory,
        options.pluginModuleResolver,
        options.pluginRuntimeFactory,
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
          target.pluginDirectory,
          this.#pluginModuleResolver,
          this.#pluginRuntimeFactory,
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

  openNote(filePath: string): Promise<RuntimeSnapshot> {
    return this.activeRuntime("open a note").openNote(filePath);
  }

  closeNote(filePath: string, expectedVaultId: string): Promise<RuntimeSnapshot> {
    return this.activeRuntime("close a note").closeNote(filePath, expectedVaultId);
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

  createNote(
    filePath: string,
    content: string,
    expectedVaultId: string,
  ): Promise<NoteCreateResponse> {
    return this.activeRuntime("create a note").createNote(filePath, content, expectedVaultId);
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

  saveNote(
    filePath: string,
    content: string,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<NoteSaveResponse> {
    return this.activeRuntime("save a note").saveNote(
      filePath,
      content,
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

  loadPlugin(pluginDirectory: string, expectedBundleSha256?: string): Promise<RuntimeSnapshot> {
    return this.activeRuntime("load a plugin").loadPlugin(pluginDirectory, expectedBundleSha256);
  }

  reloadPlugin(pluginId?: string): Promise<RuntimeSnapshot> {
    return this.activeRuntime("reload a plugin").reloadPlugin(pluginId);
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
