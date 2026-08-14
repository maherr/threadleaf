import type {
  AccessibilityVaultMode,
  VaultAccessibilityPreferencesSnapshot,
  VaultAccessibilityPreferencesUpdateResponse,
} from "../application/vault-accessibility-preferences";
import {
  type AccessibilityPreferences,
  parseAccessibilityPreferences,
} from "../shared/accessibility-preferences";

/**
 * Main-process seam for vault-bound accessibility mutations.
 *
 * Mirrors the existing vault-mutation staleness pattern already used for
 * every other vault-scoped write in `src/main/main.ts` (guarded on
 * `RuntimeSnapshot.vault.mode === "kernel-backed" && RuntimeSnapshot.vault.id`,
 * `src/shared/contracts.ts`): the active-vault identity and mode are
 * re-checked after every await, including after the serialized store write,
 * so a request that crossed an A/B vault switch mid-flight can never be
 * presented to the renderer as a successful update for the vault it named.
 */
export interface AccessibilityPreferencesMutationPort {
  readonly activeVaultId: string;
  readonly activeVaultMode: AccessibilityVaultMode | Promise<AccessibilityVaultMode>;
  setVaultAccessibilityPreferences(
    vaultId: string,
    preferences: AccessibilityPreferences | null,
  ): Promise<VaultAccessibilityPreferencesSnapshot>;
}

function demoReadOnlyError(): Error {
  return new Error(
    "Accessibility preferences can only be changed for a local vault; Threadleaf Demo is read-only.",
  );
}

async function mutateVaultAccessibilityPreferences(
  port: AccessibilityPreferencesMutationPort,
  expectedVaultId: string,
  preferences: AccessibilityPreferences | null,
): Promise<VaultAccessibilityPreferencesUpdateResponse> {
  if (port.activeVaultId !== expectedVaultId) {
    return { status: "stale-vault", vaultId: port.activeVaultId };
  }
  if ((await port.activeVaultMode) !== "kernel-backed") {
    throw demoReadOnlyError();
  }
  if (port.activeVaultId !== expectedVaultId) {
    return { status: "stale-vault", vaultId: port.activeVaultId };
  }
  const snapshot = await port.setVaultAccessibilityPreferences(expectedVaultId, preferences);
  if (port.activeVaultId !== expectedVaultId) {
    return { status: "stale-vault", vaultId: port.activeVaultId };
  }
  if ((await port.activeVaultMode) !== "kernel-backed") {
    throw demoReadOnlyError();
  }
  return { status: "updated", snapshot };
}

export function setAccessibilityPreferencesForVault(
  port: AccessibilityPreferencesMutationPort,
  expectedVaultId: string,
  value: unknown,
): Promise<VaultAccessibilityPreferencesUpdateResponse> {
  if (port.activeVaultId !== expectedVaultId) {
    return Promise.resolve({ status: "stale-vault", vaultId: port.activeVaultId });
  }
  return mutateVaultAccessibilityPreferences(
    port,
    expectedVaultId,
    parseAccessibilityPreferences(value),
  );
}

export function resetAccessibilityPreferencesForVault(
  port: AccessibilityPreferencesMutationPort,
  expectedVaultId: string,
): Promise<VaultAccessibilityPreferencesUpdateResponse> {
  return mutateVaultAccessibilityPreferences(port, expectedVaultId, null);
}
