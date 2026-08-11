import { contextBridge, ipcRenderer } from "electron";
import type { NoteSaveResponse, RuntimeSnapshot, ThreadleafBridge } from "../shared/contracts";
import { ipcChannels } from "../shared/ipc-channels";

const bridge: ThreadleafBridge = {
  getSnapshot: () => ipcRenderer.invoke(ipcChannels.snapshot) as Promise<RuntimeSnapshot>,
  openNote: (filePath) =>
    ipcRenderer.invoke(ipcChannels.openNote, filePath) as Promise<RuntimeSnapshot>,
  saveNote: (filePath, content, expectedRevision) =>
    ipcRenderer.invoke(
      ipcChannels.saveNote,
      filePath,
      content,
      expectedRevision,
    ) as Promise<NoteSaveResponse>,
  runCommand: (commandId) =>
    ipcRenderer.invoke(ipcChannels.runCommand, commandId) as Promise<RuntimeSnapshot>,
  reloadPlugin: () => ipcRenderer.invoke(ipcChannels.reloadPlugin) as Promise<RuntimeSnapshot>,
  unloadPlugin: () => ipcRenderer.invoke(ipcChannels.unloadPlugin) as Promise<RuntimeSnapshot>,
  onSnapshot: (listener) => {
    const subscription = (_event: Electron.IpcRendererEvent, snapshot: RuntimeSnapshot) => {
      listener(snapshot);
    };
    ipcRenderer.on(ipcChannels.snapshotChanged, subscription);
    return () => ipcRenderer.removeListener(ipcChannels.snapshotChanged, subscription);
  },
};

contextBridge.exposeInMainWorld("threadleaf", bridge);
