import { describe, expect, it } from "vitest";
import { type AppSettings, createDefaultAppSettings } from "../shared/key-bindings";
import {
  createDefaultVaultWorkspaceSettings,
  type VaultWorkspaceSettings,
} from "../shared/workspace-settings";
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

interface PendingSave {
  settings: AppSettings;
  resolve: (settings: AppSettings) => void;
  reject: (error: unknown) => void;
}

class DelayedSettingsStore extends MemorySettingsStore {
  readonly pending: PendingSave[] = [];

  override save(settings: AppSettings): Promise<AppSettings> {
    return new Promise<AppSettings>((resolve, reject) => {
      this.pending.push({ settings, resolve, reject });
    });
  }

  releaseNext(): void {
    const pending = this.pending.shift();
    if (!pending) {
      throw new Error("No delayed settings save is pending.");
    }
    this.value = pending.settings;
    this.saved.push(pending.settings);
    pending.resolve(pending.settings);
  }

  rejectNext(error: unknown): void {
    const pending = this.pending.shift();
    if (!pending) {
      throw new Error("No delayed settings save is pending.");
    }
    pending.reject(error);
  }
}

async function waitForPendingSaves(store: DelayedSettingsStore, count: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (store.pending.length >= count) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(`Expected ${count} delayed settings saves, found ${store.pending.length}.`);
}

function workspaceSettings(
  overrides: Partial<VaultWorkspaceSettings> = {},
): VaultWorkspaceSettings {
  return { ...createDefaultVaultWorkspaceSettings(), ...overrides };
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

  it("persists private per-vault workspace preferences before publishing them", async () => {
    const store = new MemorySettingsStore();
    const controller = await AppSettingsController.open(store);
    const vaultId = "f".repeat(64);
    const workspace = {
      defaultNoteFolder: "Notes",
      linkStyle: "markdown" as const,
      automaticLinkUpdates: "always" as const,
      confirmDelete: "when-linked" as const,
      newTabBehavior: "background" as const,
      editorMode: "source" as const,
      documentView: "reading" as const,
      restorePolicy: "fresh" as const,
    };
    const observed: string[] = [];
    controller.onSnapshot((snapshot) =>
      observed.push(snapshot.settings.workspaceByVault[vaultId]?.linkStyle ?? "missing"),
    );

    const snapshot = await controller.setVaultWorkspaceSettings(vaultId, workspace);

    expect(store.saved).toEqual([snapshot.settings]);
    expect(observed).toEqual(["markdown"]);
    expect(controller.getVaultWorkspaceSettings(vaultId)).toEqual(workspace);
    expect(snapshot.settings.appearanceByVault).toEqual({});
    expect(snapshot.settings.noteWorkflowsByVault).toEqual({});
  });

  it("resets only one vault workspace entry back to validated defaults", async () => {
    const firstVault = "a".repeat(64);
    const secondVault = "b".repeat(64);
    const customized = createDefaultAppSettings();
    customized.workspaceByVault[firstVault] = {
      defaultNoteFolder: "Notes",
      linkStyle: "markdown",
      automaticLinkUpdates: "always",
      confirmDelete: "when-linked",
      newTabBehavior: "background",
      editorMode: "source",
      documentView: "reading",
      restorePolicy: "fresh",
    };
    customized.workspaceByVault[secondVault] = { ...customized.workspaceByVault[firstVault] };
    const store = new MemorySettingsStore(customized);
    const controller = await AppSettingsController.open(store);

    const snapshot = await controller.resetVaultWorkspaceSettings(firstVault);

    expect(controller.getVaultWorkspaceSettings(firstVault)).toEqual(
      createDefaultVaultWorkspaceSettings(),
    );
    expect(controller.getVaultWorkspaceSettings(secondVault)).toEqual(
      customized.workspaceByVault[secondVault],
    );
    expect(snapshot.settings.workspaceByVault[firstVault]).toBeUndefined();
    expect(store.saved).toEqual([snapshot.settings]);
  });

  it("serializes concurrent key and two-vault workspace changes from the latest snapshot", async () => {
    const store = new DelayedSettingsStore();
    const controller = await AppSettingsController.open(store);
    const firstVault = "c".repeat(64);
    const secondVault = "d".repeat(64);

    const key = controller.setKeyBinding("editor.revert-note", "Alt+R");
    const firstWorkspace = controller.setVaultWorkspaceSettings(
      firstVault,
      workspaceSettings({ defaultNoteFolder: "First", linkStyle: "markdown" }),
    );
    const secondWorkspace = controller.setVaultWorkspaceSettings(
      secondVault,
      workspaceSettings({ defaultNoteFolder: "Second", linkStyle: "wikilink" }),
    );

    await waitForPendingSaves(store, 1);
    expect(store.pending[0]?.settings.keyBindings["editor.revert-note"]).toBe("Alt+R");
    store.releaseNext();
    await waitForPendingSaves(store, 1);
    expect(store.pending[0]?.settings.keyBindings["editor.revert-note"]).toBe("Alt+R");
    expect(store.pending[0]?.settings.workspaceByVault[firstVault]?.defaultNoteFolder).toBe(
      "First",
    );
    store.releaseNext();
    await waitForPendingSaves(store, 1);
    expect(store.pending[0]?.settings.keyBindings["editor.revert-note"]).toBe("Alt+R");
    expect(store.pending[0]?.settings.workspaceByVault[firstVault]?.defaultNoteFolder).toBe(
      "First",
    );
    expect(store.pending[0]?.settings.workspaceByVault[secondVault]?.defaultNoteFolder).toBe(
      "Second",
    );
    store.releaseNext();

    const [keySnapshot, firstSnapshot, secondSnapshot] = await Promise.all([
      key,
      firstWorkspace,
      secondWorkspace,
    ]);
    expect(keySnapshot.settings.keyBindings["editor.revert-note"]).toBe("Alt+R");
    expect(firstSnapshot.settings.workspaceByVault[firstVault]?.defaultNoteFolder).toBe("First");
    expect(firstSnapshot.settings.workspaceByVault[secondVault]).toBeUndefined();
    expect(secondSnapshot.settings.workspaceByVault[firstVault]?.defaultNoteFolder).toBe("First");
    expect(secondSnapshot.settings.workspaceByVault[secondVault]?.defaultNoteFolder).toBe("Second");
    expect(secondSnapshot.settings.keyBindings["editor.revert-note"]).toBe("Alt+R");
  });

  it("serializes a vault reset before a different-vault set without restoring stale state", async () => {
    const firstVault = "e".repeat(64);
    const secondVault = "f".repeat(64);
    const customized = createDefaultAppSettings();
    customized.workspaceByVault[firstVault] = workspaceSettings({
      defaultNoteFolder: "Old",
      linkStyle: "markdown",
    });
    const store = new DelayedSettingsStore(customized);
    const controller = await AppSettingsController.open(store);

    const reset = controller.resetVaultWorkspaceSettings(firstVault);
    const set = controller.setVaultWorkspaceSettings(
      secondVault,
      workspaceSettings({ defaultNoteFolder: "New", linkStyle: "wikilink" }),
    );

    await waitForPendingSaves(store, 1);
    expect(store.pending[0]?.settings.workspaceByVault[firstVault]).toBeUndefined();
    store.releaseNext();
    await waitForPendingSaves(store, 1);
    expect(store.pending[0]?.settings.workspaceByVault[firstVault]).toBeUndefined();
    expect(store.pending[0]?.settings.workspaceByVault[secondVault]?.defaultNoteFolder).toBe("New");
    store.releaseNext();

    const [resetSnapshot, setSnapshot] = await Promise.all([reset, set]);
    expect(resetSnapshot.settings.workspaceByVault[firstVault]).toBeUndefined();
    expect(setSnapshot.settings.workspaceByVault[firstVault]).toBeUndefined();
    expect(setSnapshot.settings.workspaceByVault[secondVault]?.defaultNoteFolder).toBe("New");
    expect(controller.getVaultWorkspaceSettings(firstVault)).toEqual(
      createDefaultVaultWorkspaceSettings(),
    );
  });

  it("recovers the save queue after a failed write", async () => {
    const store = new DelayedSettingsStore();
    const controller = await AppSettingsController.open(store);
    const vaultId = "1".repeat(64);
    const failure = new Error("settings disk unavailable");

    const key = controller.setKeyBinding("editor.revert-note", "Alt+R");
    const workspace = controller.setVaultWorkspaceSettings(
      vaultId,
      workspaceSettings({ defaultNoteFolder: "Recovered" }),
    );

    await waitForPendingSaves(store, 1);
    store.rejectNext(failure);
    await expect(key).rejects.toThrow("settings disk unavailable");
    await waitForPendingSaves(store, 1);
    expect(store.pending[0]?.settings.keyBindings["editor.revert-note"]).toBeNull();
    expect(store.pending[0]?.settings.workspaceByVault[vaultId]?.defaultNoteFolder).toBe(
      "Recovered",
    );
    store.releaseNext();

    const snapshot = await workspace;
    expect(snapshot.settings.keyBindings["editor.revert-note"]).toBeNull();
    expect(snapshot.settings.workspaceByVault[vaultId]?.defaultNoteFolder).toBe("Recovered");
    expect(controller.getSnapshot()).toEqual(snapshot);
  });
});
