import { describe, expect, it } from "vitest";
import { type AppSettings, createDefaultAppSettings } from "../shared/key-bindings";
import { AppSettingsController, type AppSettingsStore } from "./app-settings-controller";

class MemorySettingsStore implements AppSettingsStore {
  value: AppSettings | null;
  loadError: Error | null = null;
  saveError: Error | null = null;
  readonly saved: AppSettings[] = [];

  constructor(value: AppSettings | null = null) {
    this.value = value;
  }

  async load(): Promise<AppSettings | null> {
    if (this.loadError) {
      throw this.loadError;
    }
    return this.value;
  }

  async save(settings: AppSettings): Promise<AppSettings> {
    if (this.saveError) {
      throw this.saveError;
    }
    this.value = settings;
    this.saved.push(settings);
    return settings;
  }
}

describe("AppSettingsController", () => {
  it("uses defaults without writing when no settings exist", async () => {
    const store = new MemorySettingsStore();
    const controller = await AppSettingsController.open(store);

    expect(controller.getSnapshot()).toEqual({
      settings: createDefaultAppSettings(),
      warning: null,
    });
    expect(store.saved).toEqual([]);
  });

  it("fails loudly to defaults without overwriting malformed state", async () => {
    const store = new MemorySettingsStore();
    store.loadError = new Error("invalid settings document");
    const controller = await AppSettingsController.open(store);

    expect(controller.getSnapshot().settings).toEqual(createDefaultAppSettings());
    expect(controller.getSnapshot().warning).toContain("invalid settings document");
    expect(store.saved).toEqual([]);
  });

  it("persists a valid binding before publishing it", async () => {
    const store = new MemorySettingsStore();
    const controller = await AppSettingsController.open(store);
    const observed: string[] = [];
    controller.onSnapshot((snapshot) =>
      observed.push(snapshot.settings.keyBindings["editor.revert-note"] ?? "none"),
    );

    const snapshot = await controller.setKeyBinding("editor.revert-note", "Alt+R");

    expect(store.saved).toHaveLength(1);
    expect(snapshot.settings.keyBindings["editor.revert-note"]).toBe("Alt+R");
    expect(snapshot.warning).toBeNull();
    expect(observed).toEqual(["Alt+R"]);
  });

  it("keeps the active settings when persistence fails", async () => {
    const store = new MemorySettingsStore();
    const controller = await AppSettingsController.open(store);
    store.saveError = new Error("settings disk unavailable");

    await expect(controller.setKeyBinding("editor.revert-note", "Alt+R")).rejects.toThrow(
      "settings disk unavailable",
    );
    expect(controller.getSnapshot().settings).toEqual(createDefaultAppSettings());
  });

  it("resets bindings through the same durable adoption path", async () => {
    const customized = createDefaultAppSettings();
    customized.keyBindings["editor.revert-note"] = "Alt+R";
    customized.appearanceByVault["a".repeat(64)] = {
      colorScheme: "dark",
      themeId: "obsidian-theme:Minimal",
      enabledSnippetIds: [],
    };
    const store = new MemorySettingsStore(customized);
    const controller = await AppSettingsController.open(store);

    const reset = await controller.resetKeyBindings();

    expect(reset.settings.keyBindings).toEqual(createDefaultAppSettings().keyBindings);
    expect(reset.settings.appearanceByVault).toEqual(customized.appearanceByVault);
    expect(store.saved).toEqual([reset.settings]);
  });

  it("persists per-vault appearance without changing keyboard settings", async () => {
    const store = new MemorySettingsStore();
    const controller = await AppSettingsController.open(store);
    const vaultId = "b".repeat(64);

    const snapshot = await controller.setVaultAppearance(vaultId, {
      colorScheme: "light",
      themeId: "obsidian-theme:Paper",
      enabledSnippetIds: ["obsidian-snippet:spacing.css"],
    });

    expect(snapshot.settings.keyBindings).toEqual(createDefaultAppSettings().keyBindings);
    expect(controller.getVaultAppearance(vaultId)).toEqual({
      colorScheme: "light",
      themeId: "obsidian-theme:Paper",
      enabledSnippetIds: ["obsidian-snippet:spacing.css"],
    });
  });

  it("persists private per-vault plugin choices without changing appearance", async () => {
    const store = new MemorySettingsStore();
    const controller = await AppSettingsController.open(store);
    const vaultId = "c".repeat(64);

    const snapshot = await controller.setVaultPlugins(vaultId, {
      compatibilityMode: "enabled",
      enabledPluginIds: ["obsidian-excalidraw-plugin"],
      capabilityGrantsByPlugin: {
        "obsidian-excalidraw-plugin": {
          bundleSha256: "e".repeat(64),
          capabilities: ["vault-read", "vault-write"],
        },
      },
    });

    expect(snapshot.settings.appearanceByVault).toEqual({});
    expect(controller.getVaultPlugins(vaultId)).toEqual({
      compatibilityMode: "enabled",
      enabledPluginIds: ["obsidian-excalidraw-plugin"],
      capabilityGrantsByPlugin: {
        "obsidian-excalidraw-plugin": {
          bundleSha256: "e".repeat(64),
          capabilities: ["vault-read", "vault-write"],
        },
      },
    });
    expect(store.saved).toEqual([snapshot.settings]);
  });

  it("persists private per-vault daily note and template preferences", async () => {
    const store = new MemorySettingsStore();
    const controller = await AppSettingsController.open(store);
    const vaultId = "d".repeat(64);

    const snapshot = await controller.setVaultNoteWorkflows(vaultId, {
      templateFolder: "Work/Templates/",
      templateDateFormat: "YYYY.MM.DD",
      templateTimeFormat: "HH-mm",
      dailyNoteFolder: "Journal",
      dailyNoteDateFormat: "YYYY/MMMM/YYYY-MM-DD",
      dailyNoteTemplate: "Work/Templates/Daily",
    });

    expect(snapshot.settings.appearanceByVault).toEqual({});
    expect(snapshot.settings.pluginsByVault).toEqual({});
    expect(controller.getVaultNoteWorkflows(vaultId)).toEqual({
      templateFolder: "Work/Templates",
      templateDateFormat: "YYYY.MM.DD",
      templateTimeFormat: "HH-mm",
      dailyNoteFolder: "Journal",
      dailyNoteDateFormat: "YYYY/MMMM/YYYY-MM-DD",
      dailyNoteTemplate: "Work/Templates/Daily.md",
    });
    expect(store.saved).toEqual([snapshot.settings]);
  });

  it("refuses a reviewed replacement after a newer private settings write", async () => {
    const store = new MemorySettingsStore();
    const controller = await AppSettingsController.open(store);
    const reviewedBefore = controller.getSnapshot().settings;

    await controller.setKeyBinding("editor.revert-note", "Alt+R");

    await expect(
      controller.replaceSettings(createDefaultAppSettings(), reviewedBefore),
    ).rejects.toThrow("private settings changed");
    expect(controller.getSnapshot().settings.keyBindings["editor.revert-note"]).toBe("Alt+R");
  });
});
