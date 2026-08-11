import { join } from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { WorkspaceRuntime } from "../application/workspace-runtime";
import { FixedStateRoot } from "../kernel/ports";
import { ipcChannels } from "../shared/ipc-channels";

let mainWindow: BrowserWindow | null = null;
let workspaceRuntime: WorkspaceRuntime;

async function createWorkspaceRuntime(): Promise<WorkspaceRuntime> {
  const vaultPath = join(app.getAppPath(), "fixtures", "vaults", "basic");
  const pluginPath = join(vaultPath, ".obsidian", "plugins", "threadleaf-fixture");
  return WorkspaceRuntime.open({
    vaultRoot: vaultPath,
    stateRoot: new FixedStateRoot(app.getPath("userData")),
    pluginDirectory: pluginPath,
  });
}

function registerIpcHandlers(): void {
  ipcMain.handle(ipcChannels.snapshot, () => workspaceRuntime.getSnapshot());
  ipcMain.handle(ipcChannels.openNote, (_event, filePath: unknown) => {
    if (typeof filePath !== "string") {
      throw new Error("Open note requires a string path.");
    }
    return workspaceRuntime.openNote(filePath);
  });
  ipcMain.handle(ipcChannels.runCommand, (_event, commandId: unknown) => {
    if (typeof commandId !== "string") {
      throw new Error("Run command requires a string identifier.");
    }
    return workspaceRuntime.runPluginCommand(commandId);
  });
  ipcMain.handle(ipcChannels.reloadPlugin, () => workspaceRuntime.reloadPlugin());
  ipcMain.handle(ipcChannels.unloadPlugin, () => workspaceRuntime.unloadPlugin());
  workspaceRuntime.onSnapshot((snapshot) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(ipcChannels.snapshotChanged, snapshot);
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
  workspaceRuntime = await createWorkspaceRuntime();
  registerIpcHandlers();
  await createWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on("will-quit", () => {
  void workspaceRuntime?.close();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
