import { contextBridge, ipcRenderer } from "electron";
import type { AppearanceResponse } from "../shared/appearance";
import type {
  AppearanceUpdateResponse,
  NoteCreateResponse,
  NoteDeleteResponse,
  NoteMoveResponse,
  NoteSaveResponse,
  PluginSurfaceBounds,
  PluginUpdateResponse,
  RuntimeSnapshot,
  ThreadleafBridge,
  VaultImageResponse,
  VaultOpenResponse,
  VaultSearchResponse,
} from "../shared/contracts";
import { ipcChannels } from "../shared/ipc-channels";
import type { AppSettingsSnapshot } from "../shared/key-bindings";
import type { CompatibilityMode, PluginCatalogResponse } from "../shared/plugins";

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
  getPlugins: (expectedVaultId) =>
    ipcRenderer.invoke(ipcChannels.plugins, expectedVaultId) as Promise<PluginCatalogResponse>,
  setCompatibilityMode: (expectedVaultId, mode: CompatibilityMode) =>
    ipcRenderer.invoke(
      ipcChannels.setCompatibilityMode,
      expectedVaultId,
      mode,
    ) as Promise<PluginUpdateResponse>,
  setPluginEnabled: (expectedVaultId, pluginId, enabled) =>
    ipcRenderer.invoke(
      ipcChannels.setPluginEnabled,
      expectedVaultId,
      pluginId,
      enabled,
    ) as Promise<PluginUpdateResponse>,
  reloadPlugins: (expectedVaultId) =>
    ipcRenderer.invoke(ipcChannels.reloadPlugins, expectedVaultId) as Promise<PluginUpdateResponse>,
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
  runCommand: (commandId, editorContext) =>
    ipcRenderer.invoke(
      ipcChannels.runCommand,
      commandId,
      editorContext,
    ) as Promise<RuntimeSnapshot>,
  reloadPlugin: (pluginId) =>
    ipcRenderer.invoke(ipcChannels.reloadPlugin, pluginId) as Promise<RuntimeSnapshot>,
  unloadPlugin: (pluginId) =>
    ipcRenderer.invoke(ipcChannels.unloadPlugin, pluginId) as Promise<RuntimeSnapshot>,
  markPluginLayoutReady: () =>
    ipcRenderer.invoke(ipcChannels.markPluginLayoutReady) as Promise<RuntimeSnapshot>,
  openPluginView: (viewType, filePath) =>
    ipcRenderer.invoke(ipcChannels.openPluginView, viewType, filePath) as Promise<RuntimeSnapshot>,
  closePluginView: () =>
    ipcRenderer.invoke(ipcChannels.closePluginView) as Promise<RuntimeSnapshot>,
  setPluginSurfaceBounds: (bounds: PluginSurfaceBounds) =>
    ipcRenderer.invoke(ipcChannels.setPluginSurfaceBounds, bounds) as Promise<void>,
  setPluginSurfaceVisible: (visible: boolean) =>
    ipcRenderer.invoke(ipcChannels.setPluginSurfaceVisible, visible) as Promise<void>,
  setPluginSurfaceTheme: (theme: "dark" | "light") =>
    ipcRenderer.invoke(ipcChannels.setPluginSurfaceTheme, theme) as Promise<void>,
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
