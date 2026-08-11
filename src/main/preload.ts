import { contextBridge, ipcRenderer } from "electron";
import type { RuntimeSnapshot, ThreadleafBridge } from "../shared/contracts";

const channels = {
  snapshot: "threadleaf:snapshot",
  runCommand: "threadleaf:run-command",
  reloadPlugin: "threadleaf:reload-plugin",
  unloadPlugin: "threadleaf:unload-plugin",
} as const;

const bridge: ThreadleafBridge = {
  getSnapshot: () => ipcRenderer.invoke(channels.snapshot) as Promise<RuntimeSnapshot>,
  runCommand: (commandId) =>
    ipcRenderer.invoke(channels.runCommand, commandId) as Promise<RuntimeSnapshot>,
  reloadPlugin: () => ipcRenderer.invoke(channels.reloadPlugin) as Promise<RuntimeSnapshot>,
  unloadPlugin: () => ipcRenderer.invoke(channels.unloadPlugin) as Promise<RuntimeSnapshot>,
};

contextBridge.exposeInMainWorld("threadleaf", bridge);
