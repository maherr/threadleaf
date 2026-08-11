import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from "electron";
import { AppSettingsController } from "../application/app-settings-controller";
import { WorkspaceController } from "../application/workspace-controller";
import { FixedStateRoot } from "../kernel/ports";
import { ipcChannels } from "../shared/ipc-channels";
import { isShortcutTargetId } from "../shared/key-bindings";
import {
  readDevelopmentPickerOverride,
  readDevelopmentVaultPath,
} from "./development-picker-override";
import { FileAppSettingsStore } from "./file-app-settings-store";
import { FileVaultSelectionStore } from "./file-vault-selection-store";

let mainWindow: BrowserWindow | null = null;
let workspaceController: WorkspaceController;
let settingsController: AppSettingsController;

function fixturePluginDirectory(vaultPath: string): string | undefined {
  const pluginPath = join(vaultPath, ".obsidian", "plugins", "threadleaf-fixture");
  return existsSync(join(pluginPath, "manifest.json")) ? pluginPath : undefined;
}

function describeVaultOpenFailure(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "ENOENT") {
    return "Could not open that folder because it is no longer available.";
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `Could not open that folder: ${detail}`;
}

async function createWorkspaceController(): Promise<WorkspaceController> {
  const configuredPath = readDevelopmentVaultPath(app.isPackaged, process.env);
  const fixtureVaultPath = join(app.getAppPath(), "fixtures", "vaults", "basic");
  const fixturePlugin = fixturePluginDirectory(fixtureVaultPath);
  const configuredPlugin = configuredPath ? fixturePluginDirectory(configuredPath) : undefined;
  const userDataPath = app.getPath("userData");
  return WorkspaceController.open({
    fixtureVaultPath,
    ...(fixturePlugin ? { fixturePluginDirectory: fixturePlugin } : {}),
    stateRoot: new FixedStateRoot(userDataPath),
    selectionStore: new FileVaultSelectionStore(join(userDataPath, "workspace-selection.json")),
    ...(configuredPath
      ? {
          configuredVaultPath: configuredPath,
          ...(configuredPlugin ? { configuredPluginDirectory: configuredPlugin } : {}),
        }
      : {}),
  });
}

function registerIpcHandlers(): void {
  ipcMain.handle(ipcChannels.snapshot, () => workspaceController.getSnapshot());
  ipcMain.handle(ipcChannels.settings, () => settingsController.getSnapshot());
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
        snapshot: await workspaceController.switchVault(selectedPath),
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
  ipcMain.handle(ipcChannels.reloadPlugin, () => workspaceController.reloadPlugin());
  ipcMain.handle(ipcChannels.unloadPlugin, () => workspaceController.unloadPlugin());
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
