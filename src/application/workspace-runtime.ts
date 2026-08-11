import path from "node:path";
import { VaultIndexReactor } from "../kernel/metadata-index";
import { NodeVaultWatcher } from "../kernel/node-vault-watcher";
import type { StateRootPort } from "../kernel/ports";
import { VaultKernel } from "../kernel/vault-kernel";
import type { VaultChangeBatch } from "../kernel/watch-protocol";
import { PluginHost } from "../runtime/plugin-host";
import type {
  RuntimeSnapshot,
  WorkspaceFileSummary,
  WorkspaceLinkSummary,
  WorkspaceNoteSnapshot,
} from "../shared/contracts";
import { ActionRegistry } from "./action-registry";

export interface WorkspaceRuntimeOptions {
  vaultRoot: string;
  stateRoot: StateRootPort;
  pluginDirectory?: string;
}

type SnapshotListener = (snapshot: RuntimeSnapshot) => void;

export class WorkspaceRuntime {
  readonly actions: ActionRegistry;
  readonly kernel: VaultKernel;
  readonly watcher: NodeVaultWatcher;
  readonly indexReactor: VaultIndexReactor;
  readonly pluginHost: PluginHost;

  #activePath: string | null = null;
  #watcherError: string | null = null;
  #lastWatchSequence = 0;
  #lastRescanReason: string | null = null;
  readonly #listeners = new Set<SnapshotListener>();
  readonly #releaseActions: Array<() => void> = [];

  private constructor(
    actions: ActionRegistry,
    kernel: VaultKernel,
    watcher: NodeVaultWatcher,
    indexReactor: VaultIndexReactor,
    pluginHost: PluginHost,
  ) {
    this.actions = actions;
    this.kernel = kernel;
    this.watcher = watcher;
    this.indexReactor = indexReactor;
    this.pluginHost = pluginHost;
    this.#releaseActions.push(
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
    );
  }

  static async open(options: WorkspaceRuntimeOptions): Promise<WorkspaceRuntime> {
    const actions = new ActionRegistry();
    const kernel = await VaultKernel.open({
      vaultRoot: options.vaultRoot,
      stateRoot: options.stateRoot,
    });
    let runtime: WorkspaceRuntime | undefined;
    const watcher = await NodeVaultWatcher.open(kernel.paths.rootPath, {
      onError: (error) => runtime?.recordWatcherError(error),
    });
    const indexReactor = await VaultIndexReactor.open(kernel);
    const pluginHost = new PluginHost(kernel.paths.rootPath, kernel, actions);
    runtime = new WorkspaceRuntime(actions, kernel, watcher, indexReactor, pluginHost);

    const firstPath = indexReactor.index.snapshot().documents[0]?.path;
    runtime.#activePath = firstPath ?? null;
    if (options.pluginDirectory) {
      await pluginHost.loadPlugin(options.pluginDirectory);
    }
    watcher.start((batch) => runtime?.handleWatchBatch(batch));
    return runtime;
  }

  async getSnapshot(): Promise<RuntimeSnapshot> {
    const [pluginSnapshot, workspace] = await Promise.all([
      this.pluginHost.getSnapshot(),
      this.getWorkspaceSnapshot(),
    ]);
    return {
      ...pluginSnapshot,
      vault: { ...pluginSnapshot.vault, mode: "kernel-backed-fixture" },
      actions: this.actions.list(),
      workspace,
    };
  }

  async openNote(filePath: string): Promise<RuntimeSnapshot> {
    await this.actions.dispatch("workspace.open-note", filePath);
    return this.publishSnapshot();
  }

  async runPluginCommand(commandId: string): Promise<RuntimeSnapshot> {
    await this.pluginHost.runCommand(commandId);
    return this.publishSnapshot();
  }

  async reloadPlugin(): Promise<RuntimeSnapshot> {
    await this.pluginHost.reloadPlugin();
    return this.publishSnapshot();
  }

  async unloadPlugin(): Promise<RuntimeSnapshot> {
    await this.pluginHost.unloadPlugin();
    return this.publishSnapshot();
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
    await this.watcher.close();
    await this.pluginHost.unloadPlugin();
    for (const release of this.#releaseActions.reverse()) {
      release();
    }
    this.#releaseActions.length = 0;
    this.#listeners.clear();
  }

  private async selectNote(filePath: string): Promise<void> {
    const exists = this.indexReactor.index
      .snapshot()
      .documents.some((document) => document.path === filePath);
    if (!exists) {
      throw new Error(`Markdown note is not indexed in the active vault: ${filePath}`);
    }
    await this.kernel.readText(filePath);
    this.#activePath = filePath;
  }

  private async handleWatchBatch(batch: VaultChangeBatch, publish = true): Promise<void> {
    const result = await this.indexReactor.accept(batch);
    this.#lastWatchSequence = batch.sequence;
    this.#lastRescanReason = result.mode === "rebuild" ? (result.reason ?? "unknown") : null;
    if (publish) {
      await this.publishSnapshot();
    }
  }

  private recordWatcherError(error: unknown): void {
    this.#watcherError = error instanceof Error ? error.message : String(error);
  }

  private async publishSnapshot(): Promise<RuntimeSnapshot> {
    const snapshot = await this.getSnapshot();
    for (const listener of this.#listeners) {
      listener(snapshot);
    }
    return snapshot;
  }

  private async getWorkspaceSnapshot(): Promise<NonNullable<RuntimeSnapshot["workspace"]>> {
    const index = this.indexReactor.index.snapshot();
    const documents = new Map(index.documents.map((document) => [document.path, document]));
    if (!this.#activePath || !documents.has(this.#activePath)) {
      this.#activePath = index.documents[0]?.path ?? null;
    }
    const backlinks = new Map(index.backlinks.map((entry) => [entry.path, entry.sources]));
    const files: WorkspaceFileSummary[] = index.documents.map((document) => ({
      path: document.path,
      title: path.posix.basename(document.path, path.posix.extname(document.path)),
      tags: document.tags,
      backlinkCount: backlinks.get(document.path)?.length ?? 0,
      outgoingCount: document.links.length,
      unresolvedCount: document.links.filter((link) => link.resolution.status !== "resolved")
        .length,
    }));

    let activeNote: WorkspaceNoteSnapshot | null = null;
    const activeMetadata = this.#activePath ? documents.get(this.#activePath) : undefined;
    if (this.#activePath && activeMetadata) {
      const note = await this.kernel.readText(this.#activePath);
      activeNote = {
        path: note.path,
        title: path.posix.basename(note.path, path.posix.extname(note.path)),
        content: note.content,
        revision: note.revision,
        tags: activeMetadata.tags,
        headings: activeMetadata.headings,
        outgoing: activeMetadata.links.map(
          (link): WorkspaceLinkSummary => ({
            label: link.alias ?? `${link.target}${link.subpath ?? ""}`,
            status: link.resolution.status,
            ...(link.resolution.path ? { path: link.resolution.path } : {}),
          }),
        ),
        backlinks: backlinks.get(note.path) ?? [],
      };
    }

    return {
      state: this.#watcherError ? "degraded" : "ready",
      files,
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
