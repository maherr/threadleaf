import {
  type AccessibilityPreferences,
  normalizeAccessibilityPreferences,
} from "../shared/accessibility-preferences";
import {
  cloneVaultAccessibilityPreferencesMap,
  resolveVaultAccessibilityPreferences,
  type VaultAccessibilityPreferencesMap,
  type VaultAccessibilityPreferencesSnapshot,
  type VaultAccessibilityPreferencesStore,
  vaultIdPattern,
} from "./vault-accessibility-preferences";

/**
 * The slice of the existing global `AccessibilityPreferencesController`
 * (`./accessibility-preferences-controller.ts`, unmodified by this module)
 * that this controller needs for fallback resolution. Narrowed to keep this
 * module testable without constructing a real global controller, and to keep
 * the coupling to exactly "read the current global snapshot".
 */
export interface GlobalAccessibilityPreferencesSource {
  getSnapshot(): { preferences: AccessibilityPreferences; warning: string | null };
}

type VaultOverridesListener = (
  vaultId: string,
  snapshot: VaultAccessibilityPreferencesSnapshot,
) => void;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Owns the vault-local accessibility override map and resolves it against the
 * existing global controller's live snapshot. Never caches the global
 * fallback: every resolution reads `globalSource.getSnapshot()` fresh, so a
 * global preference change is immediately visible to every vault that has no
 * override of its own, with no extra wiring required between the two
 * controllers.
 *
 * Deliberately does not track a "current vault" itself; the caller (the
 * accessibility IPC seam, `../main/accessibility-preferences-ipc.ts`) owns
 * that and passes the vault identity on every call. A vault switch is
 * therefore just the next call naming a different vault identity: there is
 * no internal "active vault" state here to reconcile or get out of sync.
 */
export class VaultAccessibilityPreferencesController {
  readonly #globalSource: GlobalAccessibilityPreferencesSource;
  readonly #store: VaultAccessibilityPreferencesStore;
  readonly #listeners = new Set<VaultOverridesListener>();
  #overrides: VaultAccessibilityPreferencesMap;
  #warning: string | null;
  #writeTail: Promise<void> = Promise.resolve();

  private constructor(
    globalSource: GlobalAccessibilityPreferencesSource,
    store: VaultAccessibilityPreferencesStore,
    overrides: VaultAccessibilityPreferencesMap,
    warning: string | null,
  ) {
    this.#globalSource = globalSource;
    this.#store = store;
    this.#overrides = cloneVaultAccessibilityPreferencesMap(overrides);
    this.#warning = warning;
  }

  static async open(
    globalSource: GlobalAccessibilityPreferencesSource,
    store: VaultAccessibilityPreferencesStore,
  ): Promise<VaultAccessibilityPreferencesController> {
    let overrides: VaultAccessibilityPreferencesMap = {};
    let warning: string | null = null;
    try {
      overrides = (await store.load()) ?? {};
    } catch (error) {
      warning = `Could not read saved vault accessibility preferences: ${errorMessage(error)} The global fallback remains active for every vault; the file was not changed.`;
    }
    return new VaultAccessibilityPreferencesController(globalSource, store, overrides, warning);
  }

  /**
   * Resolve the effective preferences for one vault, or the global document
   * when `vaultId` is null. Read-only: never touches the store, so calling
   * this for a vault with no stored override can never materialize one.
   */
  getSnapshot(vaultId: string | null): VaultAccessibilityPreferencesSnapshot {
    const global = this.#globalSource.getSnapshot();
    const override = vaultId ? this.#overrides[vaultId] : undefined;
    const resolved = resolveVaultAccessibilityPreferences(global.preferences, override ?? null);
    return {
      preferences: resolved.preferences,
      scope: resolved.scope,
      warning: [global.warning, this.#warning].filter(Boolean).join(" ") || null,
    };
  }

  /**
   * The raw stored override, or null when the vault has none. Distinct from
   * `getSnapshot`, which always resolves to something displayable even when
   * no override is stored.
   */
  getVaultOverride(vaultId: string): AccessibilityPreferences | null {
    const override = this.#overrides[vaultId];
    return override ? { ...override } : null;
  }

  async setVaultPreferences(
    vaultId: string,
    preferences: AccessibilityPreferences | null,
  ): Promise<VaultAccessibilityPreferencesSnapshot> {
    if (!vaultIdPattern.test(vaultId)) {
      throw new Error(
        "Vault accessibility preferences require a lowercase SHA-256 vault identity.",
      );
    }
    const candidate = preferences ? normalizeAccessibilityPreferences(preferences) : null;
    // Serialize writes even when two vault-scoped changes arrive in quick
    // succession (including for two different vaults): the map is a single
    // document, so an unserialized read-modify-write could drop one vault's
    // change under the other's.
    const operation = this.#writeTail.then(
      () => this.#persist(vaultId, candidate),
      () => this.#persist(vaultId, candidate),
    );
    this.#writeTail = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
    this.#warning = null;
    const snapshot = this.getSnapshot(vaultId);
    for (const listener of this.#listeners) {
      listener(vaultId, snapshot);
    }
    return snapshot;
  }

  /**
   * Clears a vault's override, restoring inheritance from the global
   * document. Used both for an explicit user reset and to prune a vault's
   * entry when the vault is deleted or replaced, so a stale identity can
   * never resurrect a preference for a different vault that later reuses it.
   */
  resetVaultPreferences(vaultId: string): Promise<VaultAccessibilityPreferencesSnapshot> {
    return this.setVaultPreferences(vaultId, null);
  }

  onOverridesChanged(listener: VaultOverridesListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async #persist(vaultId: string, candidate: AccessibilityPreferences | null): Promise<void> {
    const next = cloneVaultAccessibilityPreferencesMap(this.#overrides);
    if (candidate) {
      next[vaultId] = { ...candidate };
    } else {
      delete next[vaultId];
    }
    const saved = await this.#store.save(next);
    this.#overrides = cloneVaultAccessibilityPreferencesMap(saved);
  }
}
