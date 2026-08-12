import type { VaultAppearanceSettings } from "../shared/appearance";
import {
  type AppSettings,
  type AppSettingsSnapshot,
  appearanceForVault,
  createDefaultAppSettings,
  defaultKeyBindings,
  pluginsForVault,
  type ShortcutTargetId,
  updateKeyBinding,
  updateVaultAppearance,
  updateVaultPlugins,
} from "../shared/key-bindings";
import type { VaultPluginSettings } from "../shared/plugins";

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
    const candidate = updateKeyBinding(this.#snapshot.settings, targetId, binding);
    const settings = await this.#store.save(candidate);
    return this.adopt(settings);
  }

  async resetKeyBindings(): Promise<AppSettingsSnapshot> {
    const settings = await this.#store.save({
      ...this.#snapshot.settings,
      keyBindings: { ...defaultKeyBindings },
    });
    return this.adopt(settings);
  }

  getVaultAppearance(vaultId: string): VaultAppearanceSettings {
    return appearanceForVault(this.#snapshot.settings, vaultId);
  }

  async setVaultAppearance(
    vaultId: string,
    appearance: VaultAppearanceSettings,
  ): Promise<AppSettingsSnapshot> {
    const candidate = updateVaultAppearance(this.#snapshot.settings, vaultId, appearance);
    const settings = await this.#store.save(candidate);
    return this.adopt(settings);
  }

  getVaultPlugins(vaultId: string): VaultPluginSettings {
    return pluginsForVault(this.#snapshot.settings, vaultId);
  }

  async setVaultPlugins(
    vaultId: string,
    plugins: VaultPluginSettings,
  ): Promise<AppSettingsSnapshot> {
    const candidate = updateVaultPlugins(this.#snapshot.settings, vaultId, plugins);
    const settings = await this.#store.save(candidate);
    return this.adopt(settings);
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
}
