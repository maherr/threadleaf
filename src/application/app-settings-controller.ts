import type { VaultAppearanceSettings } from "../shared/appearance";
import {
  type AppSettings,
  type AppSettingsSnapshot,
  appearanceForVault,
  createDefaultAppSettings,
  defaultKeyBindings,
  noteWorkflowsForVault,
  pluginsForVault,
  type ShortcutTargetId,
  updateKeyBinding,
  updateVaultAppearance,
  updateVaultNoteWorkflows,
  updateVaultPlugins,
  updateVaultWorkspaceSettings,
  workspaceSettingsForVault,
} from "../shared/key-bindings";
import type { VaultNoteWorkflowSettings } from "../shared/note-workflows";
import type { VaultPluginSettings } from "../shared/plugins";
import type { VaultWorkspaceSettings } from "../shared/workspace-settings";

export interface AppSettingsStore {
  load(): Promise<AppSettings | null>;
  save(settings: AppSettings): Promise<AppSettings>;
}

type SettingsListener = (snapshot: AppSettingsSnapshot) => void;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AppSettingsController {
  readonly #store: AppSettingsStore;
  readonly #listeners = new Set<SettingsListener>();
  #snapshot: AppSettingsSnapshot;
  #writeTail: Promise<void> = Promise.resolve();

  private constructor(store: AppSettingsStore, snapshot: AppSettingsSnapshot) {
    this.#store = store;
    this.#snapshot = snapshot;
  }

  static async open(store: AppSettingsStore): Promise<AppSettingsController> {
    try {
      const settings = (await store.load()) ?? createDefaultAppSettings();
      return new AppSettingsController(store, { settings, warning: null });
    } catch (error) {
      return new AppSettingsController(store, {
        settings: createDefaultAppSettings(),
        warning: `Could not read saved settings: ${errorMessage(error)} Defaults are active; the file was not changed.`,
      });
    }
  }

  getSnapshot(): AppSettingsSnapshot {
    return this.#snapshot;
  }

  async setKeyBinding(
    targetId: ShortcutTargetId,
    binding: string | null,
  ): Promise<AppSettingsSnapshot> {
    return this.enqueueSave((settings) => updateKeyBinding(settings, targetId, binding));
  }

  async resetKeyBindings(): Promise<AppSettingsSnapshot> {
    return this.enqueueSave((settings) => ({
      ...settings,
      keyBindings: { ...defaultKeyBindings },
    }));
  }

  getVaultAppearance(vaultId: string): VaultAppearanceSettings {
    return appearanceForVault(this.#snapshot.settings, vaultId);
  }

  async setVaultAppearance(
    vaultId: string,
    appearance: VaultAppearanceSettings,
  ): Promise<AppSettingsSnapshot> {
    return this.enqueueSave((settings) => updateVaultAppearance(settings, vaultId, appearance));
  }

  getVaultPlugins(vaultId: string): VaultPluginSettings {
    return pluginsForVault(this.#snapshot.settings, vaultId);
  }

  async setVaultPlugins(
    vaultId: string,
    plugins: VaultPluginSettings,
  ): Promise<AppSettingsSnapshot> {
    return this.enqueueSave((settings) => updateVaultPlugins(settings, vaultId, plugins));
  }

  /** Replace the complete validated private settings snapshot for a recoverable transaction. */
  async replaceSettings(
    settings: AppSettings,
    expectedCurrent?: AppSettings,
  ): Promise<AppSettingsSnapshot> {
    return this.enqueueSave(() => settings, expectedCurrent);
  }

  getVaultNoteWorkflows(vaultId: string): VaultNoteWorkflowSettings {
    return noteWorkflowsForVault(this.#snapshot.settings, vaultId);
  }

  async setVaultNoteWorkflows(
    vaultId: string,
    noteWorkflows: VaultNoteWorkflowSettings,
  ): Promise<AppSettingsSnapshot> {
    return this.enqueueSave((settings) =>
      updateVaultNoteWorkflows(settings, vaultId, noteWorkflows),
    );
  }

  getVaultWorkspaceSettings(vaultId: string): VaultWorkspaceSettings {
    return workspaceSettingsForVault(this.#snapshot.settings, vaultId);
  }

  async setVaultWorkspaceSettings(
    vaultId: string,
    workspace: VaultWorkspaceSettings,
  ): Promise<AppSettingsSnapshot> {
    return this.enqueueSave((settings) =>
      updateVaultWorkspaceSettings(settings, vaultId, workspace),
    );
  }

  async resetVaultWorkspaceSettings(vaultId: string): Promise<AppSettingsSnapshot> {
    return this.enqueueSave((settings) => {
      if (!/^[a-f0-9]{64}$/.test(vaultId)) {
        throw new Error("Workspace preferences require a lowercase SHA-256 vault identity.");
      }
      const workspaceByVault = { ...settings.workspaceByVault };
      delete workspaceByVault[vaultId];
      return {
        ...settings,
        workspaceByVault,
      };
    });
  }

  onSnapshot(listener: SettingsListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  private adopt(settings: AppSettings): AppSettingsSnapshot {
    this.#snapshot = { settings, warning: null };
    for (const listener of this.#listeners) {
      listener(this.#snapshot);
    }
    return this.#snapshot;
  }

  private enqueueSave(
    build: (settings: AppSettings) => AppSettings,
    expectedCurrent?: AppSettings,
  ): Promise<AppSettingsSnapshot> {
    const operation = this.#writeTail
      .catch(() => undefined)
      .then(async () => {
        if (expectedCurrent && this.#snapshot.settings !== expectedCurrent) {
          throw new Error("Threadleaf private settings changed during migration review.");
        }
        const saved = await this.#store.save(build(this.#snapshot.settings));
        return this.adopt(saved);
      });
    this.#writeTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}
