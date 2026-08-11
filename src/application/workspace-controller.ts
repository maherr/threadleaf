import type { StateRootPort } from "../kernel/ports";
import type {
  NoteCreateResponse,
  NoteDeleteResponse,
  NoteMoveResponse,
  NoteSaveResponse,
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
  saveNote(
    filePath: string,
    content: string,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<NoteSaveResponse>;
  runPluginCommand(commandId: string): Promise<RuntimeSnapshot>;
  reloadPlugin(): Promise<RuntimeSnapshot>;
  unloadPlugin(): Promise<RuntimeSnapshot>;
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
  runtimeFactory?: WorkspaceRuntimeFactory;
  workspaceStateStore?: WorkspaceStateStore;
}

type SnapshotListener = (snapshot: RuntimeSnapshot) => void;

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
): WorkspaceRuntimeOptions {
  return {
    vaultRoot,
    stateRoot,
    selectionSource,
    warning,
    ...(workspaceStateStore ? { workspaceStateStore } : {}),
    ...(pluginDirectory ? { pluginDirectory } : {}),
  };
}

export class WorkspaceController {
  readonly #stateRoot: StateRootPort;
  readonly #selectionStore: VaultSelectionStore;
  readonly #workspaceStateStore: WorkspaceStateStore | undefined;
  readonly #runtimeFactory: WorkspaceRuntimeFactory;
  readonly #listeners = new Set<SnapshotListener>();
  #runtime: WorkspaceRuntimePort;
  #releaseRuntimeListener: () => void;

  private constructor(
    runtime: WorkspaceRuntimePort,
    options: WorkspaceControllerOptions,
    runtimeFactory: WorkspaceRuntimeFactory,
  ) {
    this.#runtime = runtime;
    this.#stateRoot = options.stateRoot;
    this.#selectionStore = options.selectionStore;
    this.#workspaceStateStore = options.workspaceStateStore;
    this.#runtimeFactory = runtimeFactory;
    this.#releaseRuntimeListener = this.bindRuntime(runtime);
  }

  static async open(options: WorkspaceControllerOptions): Promise<WorkspaceController> {
    const runtimeFactory = options.runtimeFactory ?? WorkspaceRuntime.open;
    if (options.configuredVaultPath) {
      const runtime = await runtimeFactory(
        runtimeOptions(
          options.configuredVaultPath,
          options.stateRoot,
          "environment",
          null,
          options.workspaceStateStore,
          options.configuredPluginDirectory,
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
      try {
        const runtime = await runtimeFactory(
          runtimeOptions(
            restoredPath,
            options.stateRoot,
            "restored",
            null,
            options.workspaceStateStore,
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
    return this.#runtime.getSnapshot();
  }

  searchVault(query: string): Promise<VaultSearchResponse> {
    return this.#runtime.searchVault(query);
  }

  async loadVaultImage(
    sourceNotePath: string,
    target: string,
    expectedVaultId: string,
  ): Promise<VaultImageResponse> {
    const runtime = this.#runtime;
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
    return this.#runtime.openNote(filePath);
  }

  closeNote(filePath: string, expectedVaultId: string): Promise<RuntimeSnapshot> {
    return this.#runtime.closeNote(filePath, expectedVaultId);
  }

  moveNote(
    filePath: string,
    targetPath: string,
    expectedRevision: string,
    expectedVaultId: string,
    confirmationId?: string,
  ): Promise<NoteMoveResponse> {
    return this.#runtime.moveNote(
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
    return this.#runtime.deleteNote(filePath, expectedRevision, expectedVaultId);
  }

  createNote(
    filePath: string,
    content: string,
    expectedVaultId: string,
  ): Promise<NoteCreateResponse> {
    return this.#runtime.createNote(filePath, content, expectedVaultId);
  }

  saveNote(
    filePath: string,
    content: string,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<NoteSaveResponse> {
    return this.#runtime.saveNote(filePath, content, expectedRevision, expectedVaultId);
  }

  runPluginCommand(commandId: string): Promise<RuntimeSnapshot> {
    return this.#runtime.runPluginCommand(commandId);
  }

  reloadPlugin(): Promise<RuntimeSnapshot> {
    return this.#runtime.reloadPlugin();
  }

  unloadPlugin(): Promise<RuntimeSnapshot> {
    return this.#runtime.unloadPlugin();
  }

  async switchVault(vaultPath: string): Promise<RuntimeSnapshot> {
    const nextRuntime = await this.#runtimeFactory(
      runtimeOptions(vaultPath, this.#stateRoot, "picked", null, this.#workspaceStateStore),
    );
    let adopted = false;
    try {
      const snapshot = await nextRuntime.getSnapshot();
      await this.#selectionStore.save(nextRuntime.vaultPath);

      const previousRuntime = this.#runtime;
      this.#releaseRuntimeListener();
      this.#runtime = nextRuntime;
      this.#releaseRuntimeListener = this.bindRuntime(nextRuntime);
      adopted = true;
      this.publish(snapshot);
      await previousRuntime.close();
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
    this.#releaseRuntimeListener();
    this.#listeners.clear();
    await this.#runtime.close();
  }

  private bindRuntime(runtime: WorkspaceRuntimePort): () => void {
    return runtime.onSnapshot((snapshot) => this.publish(snapshot));
  }

  private publish(snapshot: RuntimeSnapshot): void {
    for (const listener of this.#listeners) {
      listener(snapshot);
    }
  }
}
