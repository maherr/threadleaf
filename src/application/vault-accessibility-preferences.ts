import {
  type AccessibilityPreferences,
  type AccessibilityPreferencesSnapshot,
  accessibilityPreferencesMaxDocumentBytes,
  parseAccessibilityPreferences,
} from "../shared/accessibility-preferences";

/**
 * Vault-scoped accessibility preference overrides.
 *
 * Threadleaf's global accessibility document (`../shared/accessibility-preferences`,
 * persisted by `../main/file-accessibility-preferences-store.ts`) is a single
 * application-wide fallback and is untouched by this module. A vault may
 * additionally record its own override of that document, keyed by the same
 * lowercase SHA-256 vault identity every other private per-vault document in
 * Threadleaf uses (the `identityPath` hash in `src/kernel/vault-kernel.ts`,
 * reused the same way by `src/main/file-workspace-layout-store.ts` and
 * `src/main/theme-package-manager.ts`). A vault with no recorded override
 * resolves to the global document without ever writing to the override
 * store: reading a vault can never materialize an entry for it.
 */

export const vaultAccessibilityPreferencesVersion = 1 as const;

/** Matches every other lowercase SHA-256 vault identity check in this codebase
 * (see `src/main/file-workspace-layout-store.ts`, `src/main/theme-package-manager.ts`,
 * `src/main/plugin-package-manager.ts`, `src/application/editor-draft.ts`). Kept as
 * a local constant rather than a shared export, matching how each of those
 * modules already defines its own copy. */
export const vaultIdPattern = /^[a-f0-9]{64}$/u;

/**
 * Mirrors `RuntimeSnapshot["vault"]["mode"]` in `src/shared/contracts.ts`.
 * Duplicated locally, matching this codebase's existing convention of
 * repeating small local type aliases (see `vaultIdPattern` above) rather than
 * centralizing them, so this module needs no edit access to that shared
 * contracts file.
 */
export type AccessibilityVaultMode = "synthetic-read-only" | "kernel-backed";

export type VaultAccessibilityPreferencesMap = Record<string, AccessibilityPreferences>;

export interface VaultAccessibilityPreferencesSnapshot extends AccessibilityPreferencesSnapshot {
  /**
   * "vault" when a stored override is active for the requested vault,
   * "global" when the application-wide fallback is in effect (either because
   * no vault was requested or because the requested vault has no stored
   * override).
   */
  readonly scope: "vault" | "global";
}

/**
 * Persistence port for the vault override map. Implemented in `src/main` by a
 * store that never receives a vault path directly (see
 * `src/main/accessibility-preferences-vault-store.ts`), matching how
 * `VaultSelectionStore` in `src/application/workspace-controller.ts` is
 * implemented by `src/main/file-vault-selection-store.ts`.
 */
export interface VaultAccessibilityPreferencesStore {
  load(): Promise<VaultAccessibilityPreferencesMap | null>;
  save(value: VaultAccessibilityPreferencesMap): Promise<VaultAccessibilityPreferencesMap>;
}

export type VaultAccessibilityPreferencesUpdateResponse =
  | { status: "stale-vault"; vaultId: string }
  | { status: "updated"; snapshot: VaultAccessibilityPreferencesSnapshot };

const maxVaultAccessibilityPreferences = 128;
export const vaultAccessibilityPreferencesMaxDocumentBytes =
  accessibilityPreferencesMaxDocumentBytes * maxVaultAccessibilityPreferences;

export function isVaultAccessibilityPreferencesDocumentWithinLimit(bytes: number): boolean {
  return (
    Number.isSafeInteger(bytes) &&
    bytes >= 0 &&
    bytes <= vaultAccessibilityPreferencesMaxDocumentBytes
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clonePreferences(preferences: AccessibilityPreferences): AccessibilityPreferences {
  return { ...preferences };
}

export function cloneVaultAccessibilityPreferencesMap(
  value: VaultAccessibilityPreferencesMap,
): VaultAccessibilityPreferencesMap {
  return Object.fromEntries(
    Object.entries(value).map(([vaultId, preferences]) => [vaultId, clonePreferences(preferences)]),
  );
}

/**
 * Validate an on-disk or in-memory candidate. Rejects an unversioned
 * document, too many vaults, a malformed vault identity, or a malformed
 * preferences value for any vault; never silently drops or repairs an entry.
 */
export function parseVaultAccessibilityPreferencesMap(
  value: unknown,
): VaultAccessibilityPreferencesMap {
  if (!isRecord(value) || value.version !== vaultAccessibilityPreferencesVersion) {
    throw new Error(
      `Vault accessibility preferences must use version ${vaultAccessibilityPreferencesVersion}.`,
    );
  }
  if (!isRecord(value.byVault)) {
    throw new Error("Vault accessibility preferences must contain a byVault object.");
  }
  const entries = Object.entries(value.byVault);
  if (entries.length > maxVaultAccessibilityPreferences) {
    throw new Error("Vault accessibility preferences contain too many vaults.");
  }
  const byVault: VaultAccessibilityPreferencesMap = {};
  for (const [vaultId, preferences] of entries) {
    if (!vaultIdPattern.test(vaultId)) {
      throw new Error(
        "Vault accessibility preferences require lowercase SHA-256 vault identities.",
      );
    }
    byVault[vaultId] = parseAccessibilityPreferences(preferences);
  }
  return byVault;
}

export function normalizeVaultAccessibilityPreferencesMap(
  value: VaultAccessibilityPreferencesMap,
): VaultAccessibilityPreferencesMap {
  return parseVaultAccessibilityPreferencesMap({
    version: vaultAccessibilityPreferencesVersion,
    byVault: value,
  });
}

/**
 * Resolve the effective preferences for a vault. Pure and read-only: it never
 * calls into a store, so resolving a vault with no stored override can never
 * materialize one. Scope semantics: a stored override always wins; otherwise
 * the caller's current global preferences apply and are reported as
 * "global".
 */
export function resolveVaultAccessibilityPreferences(
  global: AccessibilityPreferences,
  override: AccessibilityPreferences | null | undefined,
): { preferences: AccessibilityPreferences; scope: "vault" | "global" } {
  return override
    ? { preferences: clonePreferences(override), scope: "vault" }
    : { preferences: clonePreferences(global), scope: "global" };
}
