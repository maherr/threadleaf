import { describe, expect, it } from "vitest";
import type {
  AccessibilityVaultMode,
  VaultAccessibilityPreferencesSnapshot,
} from "../application/vault-accessibility-preferences";
import {
  type AccessibilityPreferences,
  createDefaultAccessibilityPreferences,
} from "../shared/accessibility-preferences";
import {
  type AccessibilityPreferencesMutationPort,
  resetAccessibilityPreferencesForVault,
  setAccessibilityPreferencesForVault,
} from "./accessibility-preferences-ipc";

const vaultA = "a".repeat(64);
const vaultB = "b".repeat(64);

class MutationHarness implements AccessibilityPreferencesMutationPort {
  activeVaultId = vaultA;
  private mode: AccessibilityVaultMode = "kernel-backed";
  preferences = createDefaultAccessibilityPreferences();
  calls: Array<{ vaultId: string; preferences: AccessibilityPreferences | null }> = [];
  switchDuringMutation = false;
  switchDuringModeLookup = false;

  get activeVaultMode(): AccessibilityVaultMode {
    if (this.switchDuringModeLookup) {
      this.switchDuringModeLookup = false;
      this.mode = "synthetic-read-only";
    }
    return this.mode;
  }

  set activeVaultMode(value: AccessibilityVaultMode) {
    this.mode = value;
  }

  async setVaultAccessibilityPreferences(
    vaultId: string,
    preferences: AccessibilityPreferences | null,
  ): Promise<VaultAccessibilityPreferencesSnapshot> {
    this.calls.push({ vaultId, preferences });
    this.preferences = preferences ?? createDefaultAccessibilityPreferences();
    if (this.switchDuringMutation) {
      this.activeVaultId = vaultB;
    }
    return {
      preferences: this.preferences,
      scope: preferences ? "vault" : "global",
      warning: null,
    };
  }
}

describe("vault-bound accessibility IPC", () => {
  it("returns the updated snapshot for the active vault", async () => {
    const harness = new MutationHarness();
    const preferences = { ...createDefaultAccessibilityPreferences(), accent: "teal" as const };

    await expect(
      setAccessibilityPreferencesForVault(harness, vaultA, preferences),
    ).resolves.toEqual({
      status: "updated",
      snapshot: { preferences, scope: "vault", warning: null },
    });
  });

  it("resolves to the global scope on reset", async () => {
    const harness = new MutationHarness();
    await expect(resetAccessibilityPreferencesForVault(harness, vaultA)).resolves.toEqual({
      status: "updated",
      snapshot: {
        preferences: createDefaultAccessibilityPreferences(),
        scope: "global",
        warning: null,
      },
    });
    expect(harness.calls).toEqual([{ vaultId: vaultA, preferences: null }]);
  });

  it("rejects a synthetic demo write before persistence", async () => {
    const harness = new MutationHarness();
    harness.activeVaultMode = "synthetic-read-only";

    await expect(
      setAccessibilityPreferencesForVault(harness, vaultA, {
        ...createDefaultAccessibilityPreferences(),
        accent: "teal",
      }),
    ).rejects.toThrow("Threadleaf Demo is read-only");
    await expect(resetAccessibilityPreferencesForVault(harness, vaultA)).rejects.toThrow(
      "Threadleaf Demo is read-only",
    );
    expect(harness.calls).toEqual([]);
  });

  it("rejects a stale A request after switching to B before set", async () => {
    const harness = new MutationHarness();
    harness.activeVaultId = vaultB;

    await expect(
      setAccessibilityPreferencesForVault(harness, vaultA, {
        ...createDefaultAccessibilityPreferences(),
        accent: "teal",
      }),
    ).resolves.toEqual({ status: "stale-vault", vaultId: vaultB });
    expect(harness.calls).toEqual([]);
  });

  it("rejects reset for A after the active vault switches to B", async () => {
    const harness = new MutationHarness();
    await setAccessibilityPreferencesForVault(harness, vaultA, {
      ...createDefaultAccessibilityPreferences(),
      accent: "orange",
    });
    harness.activeVaultId = vaultB;

    await expect(resetAccessibilityPreferencesForVault(harness, vaultA)).resolves.toEqual({
      status: "stale-vault",
      vaultId: vaultB,
    });
    expect(harness.calls).toHaveLength(1);
    expect(harness.preferences.accent).toBe("orange");
  });

  it("returns stale when the vault switches during the serialized reset", async () => {
    const harness = new MutationHarness();
    harness.switchDuringMutation = true;

    await expect(resetAccessibilityPreferencesForVault(harness, vaultA)).resolves.toEqual({
      status: "stale-vault",
      vaultId: vaultB,
    });
    expect(harness.calls).toEqual([{ vaultId: vaultA, preferences: null }]);
  });

  it("returns stale when the vault switches during the serialized set", async () => {
    const harness = new MutationHarness();
    harness.switchDuringMutation = true;
    const preferences = { ...createDefaultAccessibilityPreferences(), accent: "teal" as const };

    await expect(
      setAccessibilityPreferencesForVault(harness, vaultA, preferences),
    ).resolves.toEqual({
      status: "stale-vault",
      vaultId: vaultB,
    });
    expect(harness.calls).toEqual([{ vaultId: vaultA, preferences }]);
  });

  it("rejects when the mode lookup resolves to a synthetic vault", async () => {
    const harness = new MutationHarness();
    harness.switchDuringModeLookup = true;

    await expect(
      setAccessibilityPreferencesForVault(harness, vaultA, {
        ...createDefaultAccessibilityPreferences(),
        accent: "teal",
      }),
    ).rejects.toThrow("Threadleaf Demo is read-only");
    expect(harness.calls).toEqual([]);
  });
});
