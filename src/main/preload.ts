import { contextBridge, ipcRenderer } from "electron";
import type { AppearanceResponse } from "../shared/appearance";
import type {
  AppearanceUpdateResponse,
  NoteCreateResponse,
  NoteDeleteResponse,
  NoteMoveResponse,
  NoteSaveResponse,
  RuntimeSnapshot,
  ThreadleafBridge,
  VaultImageResponse,
  VaultOpenResponse,
  VaultSearchResponse,
} from "../shared/contracts";
import { ipcChannels } from "../shared/ipc-channels";
import type { AppSettingsSnapshot } from "../shared/key-bindings";

const bridge: ThreadleafBridge = {
  getSnapshot: () => ipcRenderer.invoke(ipcChannels.snapshot) as Promise<RuntimeSnapshot>,
  getSettings: () => ipcRenderer.invoke(ipcChannels.settings) as Promise<AppSettingsSnapshot>,
  getAppearance: (expectedVaultId) =>
    ipcRenderer.invoke(ipcChannels.appearance, expectedVaultId) as Promise<AppearanceResponse>,
  setVaultAppearance: (expectedVaultId, appearance) =>
    ipcRenderer.invoke(
      ipcChannels.setVaultAppearance,
      expectedVaultId,
      appearance,
    ) as Promise<AppearanceUpdateResponse>,
  searchVault: (query) =>
    ipcRenderer.invoke(ipcChannels.searchVault, query) as Promise<VaultSearchResponse>,
  loadVaultImage: (sourceNotePath, target, expectedVaultId) =>
    ipcRenderer.invoke(
      ipcChannels.loadVaultImage,
      sourceNotePath,
      target,
      expectedVaultId,
    ) as Promise<VaultImageResponse>,
  setKeyBinding: (targetId, binding) =>
    ipcRenderer.invoke(
      ipcChannels.setKeyBinding,
      targetId,
      binding,
    ) as Promise<AppSettingsSnapshot>,
  resetKeyBindings: () =>
    ipcRenderer.invoke(ipcChannels.resetKeyBindings) as Promise<AppSettingsSnapshot>,
  chooseVault: () => ipcRenderer.invoke(ipcChannels.chooseVault) as Promise<VaultOpenResponse>,
  openNote: (filePath) =>
    ipcRenderer.invoke(ipcChannels.openNote, filePath) as Promise<RuntimeSnapshot>,
  closeNote: (filePath, expectedVaultId) =>
    ipcRenderer.invoke(
      ipcChannels.closeNote,
      filePath,
      expectedVaultId,
    ) as Promise<RuntimeSnapshot>,
  moveNote: (filePath, targetPath, expectedRevision, expectedVaultId, confirmationId) =>
    ipcRenderer.invoke(
      ipcChannels.moveNote,
      filePath,
      targetPath,
      expectedRevision,
      expectedVaultId,
      confirmationId,
    ) as Promise<NoteMoveResponse>,
  deleteNote: (filePath, expectedRevision, expectedVaultId) =>
    ipcRenderer.invoke(
      ipcChannels.deleteNote,
      filePath,
      expectedRevision,
      expectedVaultId,
    ) as Promise<NoteDeleteResponse>,
  createNote: (filePath, content, expectedVaultId) =>
    ipcRenderer.invoke(
      ipcChannels.createNote,
      filePath,
      content,
      expectedVaultId,
    ) as Promise<NoteCreateResponse>,
  saveNote: (filePath, content, expectedRevision, expectedVaultId) =>
    ipcRenderer.invoke(
      ipcChannels.saveNote,
      filePath,
      content,
      expectedRevision,
      expectedVaultId,
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
  onSettings: (listener) => {
    const subscription = (_event: Electron.IpcRendererEvent, snapshot: AppSettingsSnapshot) => {
      listener(snapshot);
    };
    ipcRenderer.on(ipcChannels.settingsChanged, subscription);
    return () => ipcRenderer.removeListener(ipcChannels.settingsChanged, subscription);
  },
};

contextBridge.exposeInMainWorld("threadleaf", bridge);
