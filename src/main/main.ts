import { createRequire } from "node:module";
import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from "electron";
import { AppSettingsController } from "../application/app-settings-controller";
import { WorkspaceController } from "../application/workspace-controller";
import { FixedStateRoot } from "../kernel/ports";
import { type AppearanceResponse, parseVaultAppearanceSettings } from "../shared/appearance";
import type { PluginUpdateResponse } from "../shared/contracts";
import { ipcChannels } from "../shared/ipc-channels";
import { isShortcutTargetId } from "../shared/key-bindings";
import {
  type CompatibilityMode,
  compatibilityModes,
  type PluginCatalogResponse,
  parsePluginId,
} from "../shared/plugins";
import {
  readDevelopmentPickerOverride,
  readDevelopmentVaultPath,
} from "./development-picker-override";
import { FileAppSettingsStore } from "./file-app-settings-store";
import { FileVaultSelectionStore } from "./file-vault-selection-store";
import { FileWorkspaceStateStore } from "./file-workspace-state-store";
import { loadVaultAppearance } from "./vault-appearance-loader";
import { discoverVaultPlugins, loadVaultPluginCatalog } from "./vault-plugin-loader";

let mainWindow: BrowserWindow | null = null;
let workspaceController: WorkspaceController;
let settingsController: AppSettingsController;
let pluginOperationTail: Promise<void> = Promise.resolve();

function describeVaultOpenFailure(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "ENOENT") {
    return "Could not open that folder because it is no longer available.";
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `Could not open that folder: ${detail}`;
}

function appearanceSafeMode(): boolean {
  return (
    process.argv.includes("--safe-appearance") || process.env.THREADLEAF_SAFE_APPEARANCE === "1"
  );
}

function pluginSafeMode(): boolean {
  return process.argv.includes("--safe-plugins") || process.env.THREADLEAF_SAFE_PLUGINS === "1";
}

function serializePluginOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = pluginOperationTail.then(operation, operation);
  pluginOperationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function currentAppearance(expectedVaultId: string): Promise<AppearanceResponse> {
  if (workspaceController.vaultId !== expectedVaultId) {
    return { status: "stale-vault", vaultId: workspaceController.vaultId };
  }
  const vaultPath = workspaceController.vaultPath;
  const appearance = await loadVaultAppearance({
    vaultPath,
    vaultId: expectedVaultId,
    preference: settingsController.getVaultAppearance(expectedVaultId),
    safeMode: appearanceSafeMode(),
  });
  if (
    workspaceController.vaultId !== expectedVaultId ||
    workspaceController.vaultPath !== vaultPath
  ) {
    return { status: "stale-vault", vaultId: workspaceController.vaultId };
  }
  return { status: "ready", appearance };
}

async function currentPluginCatalog(expectedVaultId: string): Promise<PluginCatalogResponse> {
  if (workspaceController.vaultId !== expectedVaultId) {
    return { status: "stale-vault", vaultId: workspaceController.vaultId };
  }
  const vaultPath = workspaceController.vaultPath;
  const catalog = await loadVaultPluginCatalog({
    vaultPath,
    vaultId: expectedVaultId,
    preference: settingsController.getVaultPlugins(expectedVaultId),
    safeMode: pluginSafeMode(),
  });
  if (
    workspaceController.vaultId !== expectedVaultId ||
    workspaceController.vaultPath !== vaultPath
  ) {
    return { status: "stale-vault", vaultId: workspaceController.vaultId };
  }
  return { status: "ready", catalog };
}

async function reconcileCompatibilityPlugins(expectedVaultId: string, forceReload = false) {
  if (workspaceController.vaultId !== expectedVaultId) {
    throw new Error("The active vault changed before plugin reconciliation.");
  }
  const vaultPath = workspaceController.vaultPath;
  const preference = settingsController.getVaultPlugins(expectedVaultId);
  const discovery = await discoverVaultPlugins(vaultPath);
  const packagesById = new Map(discovery.plugins.map((plugin) => [plugin.summary.id, plugin]));
  const pluginsAllowed = preference.compatibilityMode === "enabled" && !pluginSafeMode();
  const targetIds = new Set(
    pluginsAllowed
      ? preference.enabledPluginIds.filter(
          (pluginId) => packagesById.get(pluginId)?.summary.packageState === "ready",
        )
      : [],
  );

  let snapshot = await workspaceController.getSnapshot();
  const runtimePlugins = snapshot.plugins ?? (snapshot.plugin ? [snapshot.plugin] : []);
  for (const plugin of runtimePlugins) {
    if (!targetIds.has(plugin.id) && plugin.state !== "unloaded") {
      snapshot = await workspaceController.unloadPlugin(plugin.id);
    }
  }

  for (const pluginId of preference.enabledPluginIds) {
    if (!targetIds.has(pluginId)) {
      continue;
    }
    const installed = packagesById.get(pluginId);
    if (!installed) {
      continue;
    }
    const runtimePlugin = (snapshot.plugins ?? []).find((plugin) => plugin.id === pluginId);
    if (!forceReload && runtimePlugin?.state === "loaded") {
      continue;
    }
    try {
      snapshot = await workspaceController.loadPlugin(installed.directoryPath);
    } catch {
      snapshot = await workspaceController.getSnapshot();
    }
  }

  if (
    workspaceController.vaultId !== expectedVaultId ||
    workspaceController.vaultPath !== vaultPath
  ) {
    throw new Error("The active vault changed during plugin reconciliation.");
  }
  return snapshot;
}

async function pluginUpdateResponse(
  expectedVaultId: string,
  settings: ReturnType<AppSettingsController["getSnapshot"]>,
  forceReload = false,
): Promise<PluginUpdateResponse> {
  if (workspaceController.vaultId !== expectedVaultId) {
    return { status: "stale-vault", vaultId: workspaceController.vaultId };
  }
  const snapshot = await reconcileCompatibilityPlugins(expectedVaultId, forceReload);
  const response = await currentPluginCatalog(expectedVaultId);
  return response.status === "ready"
    ? { status: "updated", settings, catalog: response.catalog, snapshot }
    : response;
}

async function createWorkspaceController(): Promise<WorkspaceController> {
  const configuredPath = readDevelopmentVaultPath(app.isPackaged, process.env);
  const fixtureVaultPath = join(app.getAppPath(), "fixtures", "vaults", "basic");
  const userDataPath = app.getPath("userData");
  return WorkspaceController.open({
    fixtureVaultPath,
    stateRoot: new FixedStateRoot(userDataPath),
    selectionStore: new FileVaultSelectionStore(join(userDataPath, "workspace-selection.json")),
    workspaceStateStore: new FileWorkspaceStateStore(join(userDataPath, "workspaces")),
    pluginModuleResolver: createRequire(join(app.getAppPath(), "package.json")),
    ...(configuredPath ? { configuredVaultPath: configuredPath } : {}),
  });
}

function registerIpcHandlers(): void {
  ipcMain.handle(ipcChannels.snapshot, () => workspaceController.getSnapshot());
  ipcMain.handle(ipcChannels.settings, () => settingsController.getSnapshot());
  ipcMain.handle(ipcChannels.appearance, (_event, expectedVaultId: unknown) => {
    if (typeof expectedVaultId !== "string") {
      throw new Error("Appearance loading requires a string vault identity.");
    }
    return currentAppearance(expectedVaultId);
  });
  ipcMain.handle(
    ipcChannels.setVaultAppearance,
    async (_event, expectedVaultId: unknown, appearanceValue: unknown) => {
      if (typeof expectedVaultId !== "string") {
        throw new Error("Appearance updates require a string vault identity.");
      }
      if (workspaceController.vaultId !== expectedVaultId) {
        return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
      }
      const appearance = parseVaultAppearanceSettings(appearanceValue);
      const settings = await settingsController.setVaultAppearance(expectedVaultId, appearance);
      const response = await currentAppearance(expectedVaultId);
      return response.status === "ready"
        ? { status: "updated", settings, appearance: response.appearance }
        : response;
    },
  );
  ipcMain.handle(ipcChannels.plugins, (_event, expectedVaultId: unknown) => {
    if (typeof expectedVaultId !== "string") {
      throw new Error("Plugin catalog loading requires a string vault identity.");
    }
    return serializePluginOperation(() => currentPluginCatalog(expectedVaultId));
  });
  ipcMain.handle(
    ipcChannels.setCompatibilityMode,
    (_event, expectedVaultId: unknown, mode: unknown) => {
      if (
        typeof expectedVaultId !== "string" ||
        typeof mode !== "string" ||
        !compatibilityModes.includes(mode as CompatibilityMode)
      ) {
        throw new Error("Compatibility mode requires a vault identity and restricted or enabled.");
      }
      return serializePluginOperation(async () => {
        if (workspaceController.vaultId !== expectedVaultId) {
          return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
        }
        const current = settingsController.getVaultPlugins(expectedVaultId);
        const settings = await settingsController.setVaultPlugins(expectedVaultId, {
          ...current,
          compatibilityMode: mode as CompatibilityMode,
        });
        return pluginUpdateResponse(expectedVaultId, settings);
      });
    },
  );
  ipcMain.handle(
    ipcChannels.setPluginEnabled,
    (_event, expectedVaultId: unknown, pluginIdValue: unknown, enabled: unknown) => {
      if (
        typeof expectedVaultId !== "string" ||
        typeof pluginIdValue !== "string" ||
        typeof enabled !== "boolean"
      ) {
        throw new Error("Plugin enablement requires string vault and plugin values and a boolean.");
      }
      return serializePluginOperation(async () => {
        if (workspaceController.vaultId !== expectedVaultId) {
          return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
        }
        const pluginId = parsePluginId(pluginIdValue);
        if (enabled) {
          const discovery = await discoverVaultPlugins(workspaceController.vaultPath);
          const plugin = discovery.plugins.find((candidate) => candidate.summary.id === pluginId);
          if (plugin?.summary.packageState !== "ready") {
            throw new Error(`Plugin ${pluginId} is not installed as a valid package.`);
          }
        }
        const current = settingsController.getVaultPlugins(expectedVaultId);
        const enabledPluginIds = enabled
          ? [...new Set([...current.enabledPluginIds, pluginId])]
          : current.enabledPluginIds.filter((candidate) => candidate !== pluginId);
        const settings = await settingsController.setVaultPlugins(expectedVaultId, {
          ...current,
          enabledPluginIds,
        });
        return pluginUpdateResponse(expectedVaultId, settings);
      });
    },
  );
  ipcMain.handle(ipcChannels.reloadPlugins, (_event, expectedVaultId: unknown) => {
    if (typeof expectedVaultId !== "string") {
      throw new Error("Plugin reload requires a string vault identity.");
    }
    return serializePluginOperation(() =>
      pluginUpdateResponse(expectedVaultId, settingsController.getSnapshot(), true),
    );
  });
  ipcMain.handle(ipcChannels.searchVault, (_event, query: unknown) => {
    if (typeof query !== "string") {
      throw new Error("Vault search requires a string query.");
    }
    return workspaceController.searchVault(query);
  });
  ipcMain.handle(
    ipcChannels.loadVaultImage,
    (_event, sourceNotePath: unknown, target: unknown, expectedVaultId: unknown) => {
      if (
        typeof sourceNotePath !== "string" ||
        typeof target !== "string" ||
        typeof expectedVaultId !== "string"
      ) {
        throw new Error("Load vault image requires string note, target, and vault values.");
      }
      return workspaceController.loadVaultImage(sourceNotePath, target, expectedVaultId);
    },
  );
  ipcMain.handle(ipcChannels.setKeyBinding, (_event, targetId: unknown, binding: unknown) => {
    if (
      typeof targetId !== "string" ||
      !isShortcutTargetId(targetId) ||
      (binding !== null && typeof binding !== "string")
    ) {
      throw new Error("Set key binding requires a known target and a string or null binding.");
    }
    return settingsController.setKeyBinding(targetId, binding);
  });
  ipcMain.handle(ipcChannels.resetKeyBindings, () => settingsController.resetKeyBindings());
  ipcMain.handle(ipcChannels.chooseVault, async () => {
    const developmentOverride = readDevelopmentPickerOverride(app.isPackaged, process.env);
    if (developmentOverride?.status === "cancelled") {
      return { status: "cancelled", snapshot: await workspaceController.getSnapshot() } as const;
    }
    let selectedPath =
      developmentOverride?.status === "selected" ? developmentOverride.path : undefined;
    if (!selectedPath) {
      const options: OpenDialogOptions = {
        title: "Open a Markdown vault",
        buttonLabel: "Open vault",
        properties: ["openDirectory", "createDirectory", "dontAddToRecent"],
      };
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
      selectedPath = result.filePaths[0];
      if (result.canceled || !selectedPath) {
        return { status: "cancelled", snapshot: await workspaceController.getSnapshot() } as const;
      }
    }
    try {
      return {
        status: "opened",
        snapshot: await serializePluginOperation(async () => {
          const opened = await workspaceController.switchVault(selectedPath);
          return reconcileCompatibilityPlugins(opened.vault.id ?? workspaceController.vaultId);
        }),
      } as const;
    } catch (error) {
      return {
        status: "failed",
        message: describeVaultOpenFailure(error),
        snapshot: await workspaceController.getSnapshot(),
      } as const;
    }
  });
  ipcMain.handle(ipcChannels.openNote, (_event, filePath: unknown) => {
    if (typeof filePath !== "string") {
      throw new Error("Open note requires a string path.");
    }
    return workspaceController.openNote(filePath);
  });
  ipcMain.handle(ipcChannels.closeNote, (_event, filePath: unknown, expectedVaultId: unknown) => {
    if (typeof filePath !== "string" || typeof expectedVaultId !== "string") {
      throw new Error("Close note requires string path and vault values.");
    }
    return workspaceController.closeNote(filePath, expectedVaultId);
  });
  ipcMain.handle(
    ipcChannels.moveNote,
    (
      _event,
      filePath: unknown,
      targetPath: unknown,
      expectedRevision: unknown,
      expectedVaultId: unknown,
      confirmationId: unknown,
    ) => {
      if (
        typeof filePath !== "string" ||
        typeof targetPath !== "string" ||
        typeof expectedRevision !== "string" ||
        typeof expectedVaultId !== "string" ||
        !(confirmationId === undefined || typeof confirmationId === "string")
      ) {
        throw new Error(
          "Move note requires string path, target, revision, and vault values with an optional confirmation.",
        );
      }
      return workspaceController.moveNote(
        filePath,
        targetPath,
        expectedRevision,
        expectedVaultId,
        confirmationId,
      );
    },
  );
  ipcMain.handle(
    ipcChannels.deleteNote,
    (_event, filePath: unknown, expectedRevision: unknown, expectedVaultId: unknown) => {
      if (
        typeof filePath !== "string" ||
        typeof expectedRevision !== "string" ||
        typeof expectedVaultId !== "string"
      ) {
        throw new Error("Delete note requires string path, revision, and vault values.");
      }
      return workspaceController.deleteNote(filePath, expectedRevision, expectedVaultId);
    },
  );
  ipcMain.handle(
    ipcChannels.createNote,
    (_event, filePath: unknown, content: unknown, expectedVaultId: unknown) => {
      if (
        typeof filePath !== "string" ||
        typeof content !== "string" ||
        typeof expectedVaultId !== "string"
      ) {
        throw new Error("Create note requires string path, content, and vault values.");
      }
      return workspaceController.createNote(filePath, content, expectedVaultId);
    },
  );
  ipcMain.handle(
    ipcChannels.saveNote,
    (
      _event,
      filePath: unknown,
      content: unknown,
      expectedRevision: unknown,
      expectedVaultId: unknown,
    ) => {
      if (
        typeof filePath !== "string" ||
        typeof content !== "string" ||
        typeof expectedRevision !== "string" ||
        typeof expectedVaultId !== "string"
      ) {
        throw new Error("Save note requires string path, content, revision, and vault values.");
      }
      return workspaceController.saveNote(filePath, content, expectedRevision, expectedVaultId);
    },
  );
  ipcMain.handle(ipcChannels.runCommand, (_event, commandId: unknown) => {
    if (typeof commandId !== "string") {
      throw new Error("Run command requires a string identifier.");
    }
    return workspaceController.runPluginCommand(commandId);
  });
  ipcMain.handle(ipcChannels.reloadPlugin, (_event, pluginId: unknown) => {
    if (pluginId !== undefined && typeof pluginId !== "string") {
      throw new Error("Plugin reload requires an optional string identifier.");
    }
    return serializePluginOperation(() => workspaceController.reloadPlugin(pluginId));
  });
  ipcMain.handle(ipcChannels.unloadPlugin, (_event, pluginId: unknown) => {
    if (pluginId !== undefined && typeof pluginId !== "string") {
      throw new Error("Plugin unload requires an optional string identifier.");
    }
    return serializePluginOperation(() => workspaceController.unloadPlugin(pluginId));
  });
  workspaceController.onSnapshot((snapshot) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(ipcChannels.snapshotChanged, snapshot);
    }
  });
  settingsController.onSnapshot((snapshot) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(ipcChannels.settingsChanged, snapshot);
    }
  });
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 860,
    minHeight: 640,
    backgroundColor: "#11151c",
    title: "Threadleaf",
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  await mainWindow.loadFile(join(__dirname, "..", "renderer", "index.html"));
}

app.whenReady().then(async () => {
  settingsController = await AppSettingsController.open(
    new FileAppSettingsStore(join(app.getPath("userData"), "settings.json")),
  );
  workspaceController = await createWorkspaceController();
  await serializePluginOperation(() => reconcileCompatibilityPlugins(workspaceController.vaultId));
  registerIpcHandlers();
  await createWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on("will-quit", () => {
  void workspaceController?.close();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
