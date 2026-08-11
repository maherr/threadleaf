import { join } from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { PluginHost } from "../runtime/plugin-host";

const channels = {
  snapshot: "threadleaf:snapshot",
  runCommand: "threadleaf:run-command",
  reloadPlugin: "threadleaf:reload-plugin",
  unloadPlugin: "threadleaf:unload-plugin",
} as const;

let mainWindow: BrowserWindow | null = null;
let pluginHost: PluginHost;

async function createPluginHost(): Promise<PluginHost> {
  const vaultPath = join(app.getAppPath(), "fixtures", "vaults", "basic");
  const pluginPath = join(vaultPath, ".obsidian", "plugins", "threadleaf-fixture");
  const host = new PluginHost(vaultPath);
  await host.loadPlugin(pluginPath);
  return host;
}

function registerIpcHandlers(): void {
  ipcMain.handle(channels.snapshot, () => pluginHost.getSnapshot());
  ipcMain.handle(channels.runCommand, (_event, commandId: string) =>
    pluginHost.runCommand(commandId),
  );
  ipcMain.handle(channels.reloadPlugin, () => pluginHost.reloadPlugin());
  ipcMain.handle(channels.unloadPlugin, () => pluginHost.unloadPlugin());
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
  pluginHost = await createPluginHost();
  registerIpcHandlers();
  await createWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
