import { describe, expect, it } from "vitest";
import {
  type AccessibilityPreferences,
  createDefaultAccessibilityPreferences,
} from "../shared/accessibility-preferences";
import {
  AccessibilityPreferencesController,
  type AccessibilityPreferencesStore,
} from "./accessibility-preferences-controller";

class MemoryAccessibilityStore implements AccessibilityPreferencesStore {
  value: AccessibilityPreferences | null;
  loadError: Error | null = null;
  saveError: Error | null = null;
  readonly saved: AccessibilityPreferences[] = [];

  constructor(value: AccessibilityPreferences | null = null) {
    this.value = value;
  }

  async load(): Promise<AccessibilityPreferences | null> {
    if (this.loadError) throw this.loadError;
    return this.value;
  }

  async save(value: AccessibilityPreferences): Promise<AccessibilityPreferences> {
    if (this.saveError) throw this.saveError;
    this.value = value;
    this.saved.push(value);
    return value;
  }
}

describe("AccessibilityPreferencesController", () => {
  it("uses defaults without writing when the document is absent", async () => {
    const store = new MemoryAccessibilityStore();
    const controller = await AccessibilityPreferencesController.open(store);
    expect(controller.getSnapshot()).toEqual({
      preferences: createDefaultAccessibilityPreferences(),
      warning: null,
    });
    expect(store.saved).toEqual([]);
  });

  it("keeps malformed state and reports a warning", async () => {
    const store = new MemoryAccessibilityStore();
    store.loadError = new Error("invalid accessibility document");
    const controller = await AccessibilityPreferencesController.open(store);
    expect(controller.getSnapshot().preferences).toEqual(createDefaultAccessibilityPreferences());
    expect(controller.getSnapshot().warning).toContain("invalid accessibility document");
    expect(store.saved).toEqual([]);
  });

  it("publishes only after persistence and leaves active state on failure", async () => {
    const store = new MemoryAccessibilityStore();
    const controller = await AccessibilityPreferencesController.open(store);
    const seen: string[] = [];
    controller.onSnapshot((snapshot) => seen.push(snapshot.preferences.accent));
    await expect(
      controller.setPreferences({
        ...createDefaultAccessibilityPreferences(),
        accent: "teal",
      }),
    ).resolves.toMatchObject({ preferences: { accent: "teal" } });
    expect(seen).toEqual(["teal"]);
    store.saveError = new Error("settings disk unavailable");
    await expect(
      controller.setPreferences({
        ...createDefaultAccessibilityPreferences(),
        accent: "orange",
      }),
    ).rejects.toThrow("settings disk unavailable");
    expect(controller.getSnapshot().preferences.accent).toBe("teal");
  });

  it("resets through the same durable publication path", async () => {
    const store = new MemoryAccessibilityStore({
      ...createDefaultAccessibilityPreferences(),
      accent: "orange",
    });
    const controller = await AccessibilityPreferencesController.open(store);
    await controller.reset();
    expect(store.saved).toHaveLength(1);
    expect(controller.getSnapshot().preferences).toEqual(createDefaultAccessibilityPreferences());
  });
});
