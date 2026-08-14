import { describe, expect, it } from "vitest";
import {
  type AccessibilityPreferences,
  createDefaultAccessibilityPreferences,
} from "../shared/accessibility-preferences";
import type { VaultAccessibilityPreferencesMap } from "./vault-accessibility-preferences";
import {
  type GlobalAccessibilityPreferencesSource,
  VaultAccessibilityPreferencesController,
} from "./vault-accessibility-preferences-controller";

const vaultA = "a".repeat(64);
const vaultB = "b".repeat(64);

function preferencesWithAccent(
  accent: AccessibilityPreferences["accent"],
): AccessibilityPreferences {
  return { ...createDefaultAccessibilityPreferences(), accent };
}

class FakeGlobalSource implements GlobalAccessibilityPreferencesSource {
  preferences: AccessibilityPreferences = createDefaultAccessibilityPreferences();
  warning: string | null = null;

  getSnapshot(): { preferences: AccessibilityPreferences; warning: string | null } {
    return { preferences: this.preferences, warning: this.warning };
  }
}

class MemoryVaultStore {
  value: VaultAccessibilityPreferencesMap | null = null;
  loadError: Error | null = null;
  saveError: Error | null = null;
  readonly saveCalls: VaultAccessibilityPreferencesMap[] = [];

  async load(): Promise<VaultAccessibilityPreferencesMap | null> {
    if (this.loadError) throw this.loadError;
    return this.value;
  }

  async save(next: VaultAccessibilityPreferencesMap): Promise<VaultAccessibilityPreferencesMap> {
    if (this.saveError) throw this.saveError;
    this.value = next;
    this.saveCalls.push(structuredClone(next));
    return next;
  }
}

describe("VaultAccessibilityPreferencesController scope semantics", () => {
  it("inherits the global document without writing when a vault has no stored override", async () => {
    const global = new FakeGlobalSource();
    global.preferences = preferencesWithAccent("teal");
    const store = new MemoryVaultStore();
    const controller = await VaultAccessibilityPreferencesController.open(global, store);

    expect(controller.getSnapshot(vaultA)).toEqual({
      preferences: preferencesWithAccent("teal"),
      scope: "global",
      warning: null,
    });
    // No materialization: resolving a vault with no override must never write.
    expect(store.saveCalls).toEqual([]);
    expect(controller.getVaultOverride(vaultA)).toBeNull();
    // A second read is equally inert.
    controller.getSnapshot(vaultA);
    expect(store.saveCalls).toEqual([]);
  });

  it("isolates one vault's override from another vault and from the global document", async () => {
    const global = new FakeGlobalSource();
    global.preferences = preferencesWithAccent("blue");
    const store = new MemoryVaultStore();
    const controller = await VaultAccessibilityPreferencesController.open(global, store);

    await controller.setVaultPreferences(vaultA, preferencesWithAccent("orange"));

    expect(controller.getSnapshot(vaultA)).toMatchObject({
      preferences: { accent: "orange" },
      scope: "vault",
    });
    // Vault B was never given an override: it must still see the global
    // value, never vault A's override.
    expect(controller.getSnapshot(vaultB)).toEqual({
      preferences: preferencesWithAccent("blue"),
      scope: "global",
      warning: null,
    });
    // The global document itself is unaffected by a vault-scoped write.
    expect(controller.getSnapshot(null)).toMatchObject({
      preferences: { accent: "blue" },
      scope: "global",
    });
  });

  it("applies the target vault's preferences on every call, modeling a vault switch", async () => {
    const global = new FakeGlobalSource();
    const store = new MemoryVaultStore();
    const controller = await VaultAccessibilityPreferencesController.open(global, store);
    await controller.setVaultPreferences(vaultA, preferencesWithAccent("orange"));
    await controller.setVaultPreferences(vaultB, preferencesWithAccent("teal"));

    // The IPC seam calls getSnapshot with whichever vault is currently
    // active; simulate switching from A to B and back and confirm each call
    // reflects only the vault it names, immediately, with no stale carryover.
    expect(controller.getSnapshot(vaultA).preferences.accent).toBe("orange");
    expect(controller.getSnapshot(vaultB).preferences.accent).toBe("teal");
    expect(controller.getSnapshot(vaultA).preferences.accent).toBe("orange");
  });

  it("does not orphan or misapply a preference after a vault is pruned", async () => {
    const global = new FakeGlobalSource();
    global.preferences = preferencesWithAccent("blue");
    const store = new MemoryVaultStore();
    const controller = await VaultAccessibilityPreferencesController.open(global, store);
    await controller.setVaultPreferences(vaultA, preferencesWithAccent("orange"));

    // Vault A is deleted/renamed: a delete/rename handler must prune its
    // override explicitly so a stale identity cannot resurrect a preference
    // later (renaming changes the vault's root path, which changes its
    // SHA-256 identity per src/kernel/vault-kernel.ts, so the old entry would
    // otherwise sit forever unreachable by the renamed vault and would still
    // be misapplied if that exact identity string were ever reused).
    await controller.resetVaultPreferences(vaultA);

    expect(controller.getVaultOverride(vaultA)).toBeNull();
    expect(controller.getSnapshot(vaultA)).toEqual({
      preferences: preferencesWithAccent("blue"),
      scope: "global",
      warning: null,
    });

    // The pruned entry is gone from the persisted map too, not just hidden in
    // memory, so a fresh controller opened from the same store cannot
    // resurrect it either.
    const reopened = await VaultAccessibilityPreferencesController.open(global, store);
    expect(reopened.getVaultOverride(vaultA)).toBeNull();
    expect(reopened.getSnapshot(vaultA).scope).toBe("global");
  });

  it("keeps a second vault's override untouched when a different vault is pruned", async () => {
    const global = new FakeGlobalSource();
    const store = new MemoryVaultStore();
    const controller = await VaultAccessibilityPreferencesController.open(global, store);
    await controller.setVaultPreferences(vaultA, preferencesWithAccent("orange"));
    await controller.setVaultPreferences(vaultB, preferencesWithAccent("teal"));

    await controller.resetVaultPreferences(vaultA);

    expect(controller.getVaultOverride(vaultA)).toBeNull();
    expect(controller.getVaultOverride(vaultB)).toEqual(preferencesWithAccent("teal"));
  });

  it("reflects a global preference change immediately for a vault with no override", async () => {
    const global = new FakeGlobalSource();
    global.preferences = preferencesWithAccent("blue");
    const store = new MemoryVaultStore();
    const controller = await VaultAccessibilityPreferencesController.open(global, store);

    expect(controller.getSnapshot(vaultA).preferences.accent).toBe("blue");
    global.preferences = preferencesWithAccent("orange");
    expect(controller.getSnapshot(vaultA).preferences.accent).toBe("orange");
  });

  it("keeps a failed load from writing and reports a visible warning", async () => {
    const global = new FakeGlobalSource();
    const store = new MemoryVaultStore();
    store.loadError = new Error("vault accessibility file is corrupt");
    const controller = await VaultAccessibilityPreferencesController.open(global, store);

    expect(controller.getSnapshot(vaultA).warning).toContain("vault accessibility file is corrupt");
    expect(controller.getSnapshot(vaultA).scope).toBe("global");
    expect(store.saveCalls).toEqual([]);
  });

  it("rejects a malformed vault identity before it reaches the store", async () => {
    const global = new FakeGlobalSource();
    const store = new MemoryVaultStore();
    const controller = await VaultAccessibilityPreferencesController.open(global, store);

    await expect(
      controller.setVaultPreferences("not-a-vault-id", preferencesWithAccent("teal")),
    ).rejects.toThrow("lowercase SHA-256");
    expect(store.saveCalls).toEqual([]);
  });

  it("leaves the prior override active when a save fails", async () => {
    const global = new FakeGlobalSource();
    const store = new MemoryVaultStore();
    const controller = await VaultAccessibilityPreferencesController.open(global, store);
    await controller.setVaultPreferences(vaultA, preferencesWithAccent("orange"));

    store.saveError = new Error("disk unavailable");
    await expect(
      controller.setVaultPreferences(vaultA, preferencesWithAccent("teal")),
    ).rejects.toThrow("disk unavailable");
    expect(controller.getVaultOverride(vaultA)).toEqual(preferencesWithAccent("orange"));
  });

  it("notifies listeners with the vault identity and resolved snapshot", async () => {
    const global = new FakeGlobalSource();
    const store = new MemoryVaultStore();
    const controller = await VaultAccessibilityPreferencesController.open(global, store);
    const seen: Array<{ vaultId: string; accent: string }> = [];
    controller.onOverridesChanged((vaultId, snapshot) =>
      seen.push({ vaultId, accent: snapshot.preferences.accent }),
    );

    await controller.setVaultPreferences(vaultA, preferencesWithAccent("orange"));
    await controller.setVaultPreferences(vaultB, preferencesWithAccent("teal"));

    expect(seen).toEqual([
      { vaultId: vaultA, accent: "orange" },
      { vaultId: vaultB, accent: "teal" },
    ]);
  });
});
