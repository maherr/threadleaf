import { describe, expect, it } from "vitest";
import { createDefaultAccessibilityPreferences } from "../shared/accessibility-preferences";
import {
  parseVaultAccessibilityPreferencesMap,
  resolveVaultAccessibilityPreferences,
  vaultAccessibilityPreferencesVersion,
} from "./vault-accessibility-preferences";

const vaultA = "a".repeat(64);

describe("vault accessibility preferences map", () => {
  it("parses a versioned byVault document", () => {
    const document = {
      version: vaultAccessibilityPreferencesVersion,
      byVault: { [vaultA]: createDefaultAccessibilityPreferences() },
    };
    expect(parseVaultAccessibilityPreferencesMap(document)).toEqual({
      [vaultA]: createDefaultAccessibilityPreferences(),
    });
  });

  it("rejects an unversioned document", () => {
    expect(() => parseVaultAccessibilityPreferencesMap({ byVault: {} })).toThrow("version 1");
  });

  it("rejects a missing byVault object", () => {
    expect(() =>
      parseVaultAccessibilityPreferencesMap({ version: vaultAccessibilityPreferencesVersion }),
    ).toThrow("byVault");
  });

  it("rejects a vault identity that is not a lowercase SHA-256 hash", () => {
    expect(() =>
      parseVaultAccessibilityPreferencesMap({
        version: vaultAccessibilityPreferencesVersion,
        byVault: { "not-a-hash": createDefaultAccessibilityPreferences() },
      }),
    ).toThrow("lowercase SHA-256");
  });

  it("rejects an uppercase vault identity even though the hash characters are valid", () => {
    expect(() =>
      parseVaultAccessibilityPreferencesMap({
        version: vaultAccessibilityPreferencesVersion,
        byVault: { [vaultA.toUpperCase()]: createDefaultAccessibilityPreferences() },
      }),
    ).toThrow("lowercase SHA-256");
  });

  it("rejects more vaults than the bound allows", () => {
    const byVault: Record<string, unknown> = {};
    for (let i = 0; i < 129; i += 1) {
      byVault[i.toString(16).padStart(64, "0")] = createDefaultAccessibilityPreferences();
    }
    expect(() =>
      parseVaultAccessibilityPreferencesMap({
        version: vaultAccessibilityPreferencesVersion,
        byVault,
      }),
    ).toThrow("too many vaults");
  });

  it("rejects a malformed preferences value for one vault instead of dropping it", () => {
    expect(() =>
      parseVaultAccessibilityPreferencesMap({
        version: vaultAccessibilityPreferencesVersion,
        byVault: { [vaultA]: { ...createDefaultAccessibilityPreferences(), accent: "purple" } },
      }),
    ).toThrow("accent");
  });
});

describe("resolveVaultAccessibilityPreferences", () => {
  it("prefers a stored override over the global document", () => {
    const global = createDefaultAccessibilityPreferences();
    const override = { ...createDefaultAccessibilityPreferences(), accent: "teal" as const };
    expect(resolveVaultAccessibilityPreferences(global, override)).toEqual({
      preferences: override,
      scope: "vault",
    });
  });

  it("falls back to the global document when there is no override, without mutating either input", () => {
    const global = { ...createDefaultAccessibilityPreferences(), accent: "orange" as const };
    const frozenGlobal = { ...global };
    const result = resolveVaultAccessibilityPreferences(global, null);
    expect(result).toEqual({ preferences: global, scope: "global" });
    expect(global).toEqual(frozenGlobal);
    // The returned object must be a copy, not the same reference, so a
    // caller mutating the resolved preferences cannot corrupt the global
    // document held elsewhere.
    expect(result.preferences).not.toBe(global);
  });

  it("treats undefined the same as null (no override)", () => {
    const global = createDefaultAccessibilityPreferences();
    expect(resolveVaultAccessibilityPreferences(global, undefined)).toEqual({
      preferences: global,
      scope: "global",
    });
  });
});
