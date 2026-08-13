import { contextBridge, ipcRenderer } from "electron";
import type {
  AccessibilityPreferences,
  AccessibilityPreferencesSnapshot,
  EffectiveAccessibilityPreferences,
} from "../shared/accessibility-preferences";
import type { AppUpdateSnapshot } from "../shared/app-updates";
import type { AppearanceResponse, AppearanceSnapshot } from "../shared/appearance";
import type {
  AppearancePackageApplyResponse,
  AppearancePackageInventoryResponse,
  AppearancePackageLocalPreviewResponse,
  AppearanceUpdateResponse,
  AttachmentMoveResponse,
  CanvasAttachmentResponse,
  CanvasLoadResponse,
  CanvasSaveResponse,
  EditorDraftClearResponse,
  EditorDraftReadResponse,
  EditorDraftSaveResponse,
  MigrationApplyResponse,
  MigrationRollbackUpdateResponse,
  NoteBookmarksResponse,
  NoteCreateResponse,
  NoteDeleteResponse,
  NoteMoveResponse,
  NotePropertyRemoveResponse,
  NotePropertySetResponse,
  NoteRestoreResponse,
  NoteSaveResponse,
  NoteTemplateRenderResponse,
  NoteWorkflowCatalogResponse,
  NoteWorkflowUpdateResponse,
  NoteWorkflowValueResponse,
  PluginPackageApplyResponse,
  PluginSurfaceBounds,
  PluginUpdateResponse,
  RuntimeSnapshot,
  ThreadleafBridge,
  VaultAttachmentResponse,
  VaultGraphRequest,
  VaultGraphResponse,
  VaultImageResponse,
  VaultNoteEmbedResponse,
  VaultOpenResponse,
  VaultSearchResponse,
  VaultTrashResponse,
  WorkspaceSettingsResponse,
  WorkspaceSettingsUpdateResponse,
} from "../shared/contracts";
import { ipcChannels } from "../shared/ipc-channels";
import type { AppSettingsSnapshot } from "../shared/key-bindings";
import type { MigrationApplyRequest, MigrationPreviewResponse } from "../shared/migration";
import type { NativeMenuCommandId } from "../shared/native-menu";
import type { VaultNoteWorkflowSettings } from "../shared/note-workflows";
import type {
  PluginPackageIndexResponse,
  PluginPackagePreviewRequest,
  PluginPackagePreviewResponse,
} from "../shared/plugin-packages";
import type { CompatibilityMode, PluginCatalogResponse } from "../shared/plugins";
import type { PublishNoteExportRequest, PublishNoteExportResponse } from "../shared/publish-export";
import type { SupportBundleExportResponse } from "../shared/support-bundle";
import type {
  AppearancePackageKind,
  AppearancePackagePreviewRequest,
  AppearancePackagePreviewResponse,
} from "../shared/theme-packages";
import type { WorkspaceDockId, WorkspaceLayoutSnapshot } from "../shared/workspace-layout";
import type { VaultWorkspaceMode, VaultWorkspaceSettings } from "../shared/workspace-settings";

const bridge: ThreadleafBridge = {
  exportSupportBundle: () =>
    ipcRenderer.invoke(ipcChannels.exportSupportBundle) as Promise<SupportBundleExportResponse>,
  publishNote: (request: PublishNoteExportRequest) =>
    ipcRenderer.invoke(ipcChannels.publishNote, request) as Promise<PublishNoteExportResponse>,
  getAppUpdate: () => ipcRenderer.invoke(ipcChannels.appUpdate) as Promise<AppUpdateSnapshot>,
  checkForAppUpdate: () =>
    ipcRenderer.invoke(ipcChannels.checkForAppUpdate) as Promise<AppUpdateSnapshot>,
  downloadAppUpdate: () =>
    ipcRenderer.invoke(ipcChannels.downloadAppUpdate) as Promise<AppUpdateSnapshot>,
  installAppUpdate: () =>
    ipcRenderer.invoke(ipcChannels.installAppUpdate) as Promise<AppUpdateSnapshot>,
  getSnapshot: () => ipcRenderer.invoke(ipcChannels.snapshot) as Promise<RuntimeSnapshot>,
  getWorkspaceLayout: (expectedVaultId?: string) =>
    ipcRenderer.invoke(
      ipcChannels.workspaceLayout,
      expectedVaultId,
    ) as Promise<WorkspaceLayoutSnapshot>,
  setWorkspaceDockCollapsed: (
    dockId: WorkspaceDockId,
    collapsed: boolean,
    expectedVaultId: string,
  ) =>
    ipcRenderer.invoke(
      ipcChannels.setWorkspaceDockCollapsed,
      dockId,
      collapsed,
      expectedVaultId,
    ) as Promise<WorkspaceLayoutSnapshot>,
  popOutPluginView: (expectedVaultId: string) =>
    ipcRenderer.invoke(
      ipcChannels.popOutPluginView,
      expectedVaultId,
    ) as Promise<WorkspaceLayoutSnapshot>,
  reattachPluginView: (expectedVaultId: string) =>
    ipcRenderer.invoke(
      ipcChannels.reattachPluginView,
      expectedVaultId,
    ) as Promise<WorkspaceLayoutSnapshot>,
  markStartupShellReady: () => ipcRenderer.send(ipcChannels.startupShellReady),
  getSettings: () => ipcRenderer.invoke(ipcChannels.settings) as Promise<AppSettingsSnapshot>,
  getAppearance: (expectedVaultId) =>
    ipcRenderer.invoke(ipcChannels.appearance, expectedVaultId) as Promise<AppearanceResponse>,
  onAppearance: (listener) => {
    const subscription = (_event: Electron.IpcRendererEvent, snapshot: AppearanceSnapshot) => {
      listener(snapshot);
    };
    ipcRenderer.on(ipcChannels.appearanceChanged, subscription);
    return () => ipcRenderer.removeListener(ipcChannels.appearanceChanged, subscription);
  },
  setVaultAppearance: (expectedVaultId, appearance) =>
    ipcRenderer.invoke(
      ipcChannels.setVaultAppearance,
      expectedVaultId,
      appearance,
    ) as Promise<AppearanceUpdateResponse>,
  getAppearancePackages: (expectedVaultId) =>
    ipcRenderer.invoke(
      ipcChannels.appearancePackages,
      expectedVaultId,
    ) as Promise<AppearancePackageInventoryResponse>,
  previewAppearancePackage: (expectedVaultId, request: AppearancePackagePreviewRequest) =>
    ipcRenderer.invoke(
      ipcChannels.previewAppearancePackage,
      expectedVaultId,
      request,
    ) as Promise<AppearancePackagePreviewResponse>,
  previewLocalAppearancePackage: (expectedVaultId, kind: AppearancePackageKind) =>
    ipcRenderer.invoke(
      ipcChannels.previewLocalAppearancePackage,
      expectedVaultId,
      kind,
    ) as Promise<AppearancePackageLocalPreviewResponse>,
  applyAppearancePackage: (expectedVaultId, reviewId) =>
    ipcRenderer.invoke(
      ipcChannels.applyAppearancePackage,
      expectedVaultId,
      reviewId,
    ) as Promise<AppearancePackageApplyResponse>,
  cancelAppearancePackageReview: (expectedVaultId, reviewId) =>
    ipcRenderer.invoke(
      ipcChannels.cancelAppearancePackageReview,
      expectedVaultId,
      reviewId,
    ) as Promise<void>,
  getPlugins: (expectedVaultId) =>
    ipcRenderer.invoke(ipcChannels.plugins, expectedVaultId) as Promise<PluginCatalogResponse>,
  searchPluginPackages: (expectedVaultId, query) =>
    ipcRenderer.invoke(
      ipcChannels.searchPluginPackages,
      expectedVaultId,
      query,
    ) as Promise<PluginPackageIndexResponse>,
  previewPluginPackage: (expectedVaultId, request: PluginPackagePreviewRequest) =>
    ipcRenderer.invoke(
      ipcChannels.previewPluginPackage,
      expectedVaultId,
      request,
    ) as Promise<PluginPackagePreviewResponse>,
  applyPluginPackage: (expectedVaultId, reviewId) =>
    ipcRenderer.invoke(
      ipcChannels.applyPluginPackage,
      expectedVaultId,
      reviewId,
    ) as Promise<PluginPackageApplyResponse>,
  cancelPluginPackageReview: (expectedVaultId, reviewId) =>
    ipcRenderer.invoke(
      ipcChannels.cancelPluginPackageReview,
      expectedVaultId,
      reviewId,
    ) as Promise<void>,
  setCompatibilityMode: (expectedVaultId, mode: CompatibilityMode) =>
    ipcRenderer.invoke(
      ipcChannels.setCompatibilityMode,
      expectedVaultId,
      mode,
    ) as Promise<PluginUpdateResponse>,
  setPluginCapabilityGrant: (expectedVaultId, pluginId, expectedBundleSha256, granted) =>
    ipcRenderer.invoke(
      ipcChannels.setPluginCapabilityGrant,
      expectedVaultId,
      pluginId,
      expectedBundleSha256,
      granted,
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
  getMigrationPreview: (expectedVaultId) =>
    ipcRenderer.invoke(
      ipcChannels.migrationPreview,
      expectedVaultId,
    ) as Promise<MigrationPreviewResponse>,
  applyMigration: (expectedVaultId, request: MigrationApplyRequest) =>
    ipcRenderer.invoke(
      ipcChannels.migrationApply,
      expectedVaultId,
      request,
    ) as Promise<MigrationApplyResponse>,
  rollbackMigration: (expectedVaultId, transactionId) =>
    ipcRenderer.invoke(
      ipcChannels.migrationRollback,
      expectedVaultId,
      transactionId,
    ) as Promise<MigrationRollbackUpdateResponse>,
  searchVault: (query) =>
    ipcRenderer.invoke(ipcChannels.searchVault, query) as Promise<VaultSearchResponse>,
  getVaultGraph: (request: VaultGraphRequest, expectedVaultId) =>
    ipcRenderer.invoke(
      ipcChannels.vaultGraph,
      request,
      expectedVaultId,
    ) as Promise<VaultGraphResponse>,
  getVaultTrash: (expectedVaultId) =>
    ipcRenderer.invoke(ipcChannels.vaultTrash, expectedVaultId) as Promise<VaultTrashResponse>,
  restoreNote: (path, expectedRevision, expectedVaultId) =>
    ipcRenderer.invoke(
      ipcChannels.restoreNote,
      path,
      expectedRevision,
      expectedVaultId,
    ) as Promise<NoteRestoreResponse>,
  getNoteBookmarks: (expectedVaultId) =>
    ipcRenderer.invoke(
      ipcChannels.noteBookmarks,
      expectedVaultId,
    ) as Promise<NoteBookmarksResponse>,
  setNoteBookmark: (path, bookmarked, expectedVaultId) =>
    ipcRenderer.invoke(
      ipcChannels.setNoteBookmark,
      path,
      bookmarked,
      expectedVaultId,
    ) as Promise<NoteBookmarksResponse>,
  loadVaultImage: (sourceNotePath, target, expectedVaultId) =>
    ipcRenderer.invoke(
      ipcChannels.loadVaultImage,
      sourceNotePath,
      target,
      expectedVaultId,
    ) as Promise<VaultImageResponse>,
  loadVaultAttachment: (sourceNotePath, target, expectedVaultId) =>
    ipcRenderer.invoke(
      ipcChannels.loadVaultAttachment,
      sourceNotePath,
      target,
      expectedVaultId,
    ) as Promise<VaultAttachmentResponse>,
  loadVaultNoteEmbed: (sourceNotePath, target, subpath, expectedVaultId) =>
    ipcRenderer.invoke(
      ipcChannels.loadVaultNoteEmbed,
      sourceNotePath,
      target,
      subpath,
      expectedVaultId,
    ) as Promise<VaultNoteEmbedResponse>,
  loadCanvas: (filePath, expectedVaultId) =>
    ipcRenderer.invoke(
      ipcChannels.loadCanvas,
      filePath,
      expectedVaultId,
    ) as Promise<CanvasLoadResponse>,
  loadCanvasAttachment: (sourceCanvasPath, target, expectedVaultId) =>
    ipcRenderer.invoke(
      ipcChannels.loadCanvasAttachment,
      sourceCanvasPath,
      target,
      expectedVaultId,
    ) as Promise<CanvasAttachmentResponse>,
  setKeyBinding: (targetId, binding) =>
    ipcRenderer.invoke(
      ipcChannels.setKeyBinding,
      targetId,
      binding,
    ) as Promise<AppSettingsSnapshot>,
  resetKeyBindings: () =>
    ipcRenderer.invoke(ipcChannels.resetKeyBindings) as Promise<AppSettingsSnapshot>,
  getNoteWorkflows: (expectedVaultId) =>
    ipcRenderer.invoke(
      ipcChannels.noteWorkflows,
      expectedVaultId,
    ) as Promise<NoteWorkflowCatalogResponse>,
  setNoteWorkflows: (expectedVaultId, settings: VaultNoteWorkflowSettings) =>
    ipcRenderer.invoke(
      ipcChannels.setNoteWorkflows,
      expectedVaultId,
      settings,
    ) as Promise<NoteWorkflowUpdateResponse>,
  getWorkspaceSettings: (expectedVaultId) =>
    ipcRenderer.invoke(
      ipcChannels.workspaceSettings,
      expectedVaultId,
    ) as Promise<WorkspaceSettingsResponse>,
  setWorkspaceSettings: (expectedVaultId, settings: VaultWorkspaceSettings) =>
    ipcRenderer.invoke(
      ipcChannels.setWorkspaceSettings,
      expectedVaultId,
      settings,
    ) as Promise<WorkspaceSettingsUpdateResponse>,
  setWorkspaceMode: (expectedVaultId, mode: VaultWorkspaceMode) =>
    ipcRenderer.invoke(
      ipcChannels.setWorkspaceMode,
      expectedVaultId,
      mode,
    ) as Promise<WorkspaceSettingsUpdateResponse>,
  resetWorkspaceSettings: (expectedVaultId) =>
    ipcRenderer.invoke(
      ipcChannels.resetWorkspaceSettings,
      expectedVaultId,
    ) as Promise<WorkspaceSettingsUpdateResponse>,
  openDailyNote: (expectedVaultId) =>
    ipcRenderer.invoke(ipcChannels.openDailyNote, expectedVaultId) as Promise<NoteCreateResponse>,
  renderNoteTemplate: (templatePath, targetPath, expectedVaultId) =>
    ipcRenderer.invoke(
      ipcChannels.renderNoteTemplate,
      templatePath,
      targetPath,
      expectedVaultId,
    ) as Promise<NoteTemplateRenderResponse>,
  formatNoteWorkflowValue: (value, expectedVaultId) =>
    ipcRenderer.invoke(
      ipcChannels.formatNoteWorkflowValue,
      value,
      expectedVaultId,
    ) as Promise<NoteWorkflowValueResponse>,
  chooseVault: () => ipcRenderer.invoke(ipcChannels.chooseVault) as Promise<VaultOpenResponse>,
  openNote: (filePath, paneId, activate) =>
    ipcRenderer.invoke(
      ipcChannels.openNote,
      filePath,
      paneId,
      activate,
    ) as Promise<RuntimeSnapshot>,
  goBack: (expectedVaultId, paneId) =>
    ipcRenderer.invoke(ipcChannels.goBack, expectedVaultId, paneId) as Promise<RuntimeSnapshot>,
  goForward: (expectedVaultId, paneId) =>
    ipcRenderer.invoke(ipcChannels.goForward, expectedVaultId, paneId) as Promise<RuntimeSnapshot>,
  closeNote: (filePath, expectedVaultId, paneId) =>
    ipcRenderer.invoke(
      ipcChannels.closeNote,
      filePath,
      expectedVaultId,
      paneId,
    ) as Promise<RuntimeSnapshot>,
  toggleTabPin: (filePath, paneId, expectedVaultId) =>
    ipcRenderer.invoke(
      ipcChannels.toggleTabPin,
      filePath,
      paneId,
      expectedVaultId,
    ) as Promise<RuntimeSnapshot>,
  splitWorkspace: (direction, expectedVaultId) =>
    ipcRenderer.invoke(
      ipcChannels.splitWorkspace,
      direction,
      expectedVaultId,
    ) as Promise<RuntimeSnapshot>,
  focusWorkspacePane: (paneId, expectedVaultId) =>
    ipcRenderer.invoke(
      ipcChannels.focusWorkspacePane,
      paneId,
      expectedVaultId,
    ) as Promise<RuntimeSnapshot>,
  closeWorkspacePane: (paneId, expectedVaultId) =>
    ipcRenderer.invoke(
      ipcChannels.closeWorkspacePane,
      paneId,
      expectedVaultId,
    ) as Promise<RuntimeSnapshot>,
  moveNoteToWorkspacePane: (filePath, fromPaneId, toPaneId, expectedVaultId) =>
    ipcRenderer.invoke(
      ipcChannels.moveNoteToWorkspacePane,
      filePath,
      fromPaneId,
      toPaneId,
      expectedVaultId,
    ) as Promise<RuntimeSnapshot>,
  reorderWorkspaceTab: (filePath, paneId, targetIndex, expectedVaultId) =>
    ipcRenderer.invoke(
      ipcChannels.reorderWorkspaceTab,
      filePath,
      paneId,
      targetIndex,
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
  moveAttachment: (filePath, targetPath, expectedRevision, expectedVaultId, confirmationId) =>
    ipcRenderer.invoke(
      ipcChannels.moveAttachment,
      filePath,
      targetPath,
      expectedRevision,
      expectedVaultId,
      confirmationId,
    ) as Promise<AttachmentMoveResponse>,
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
  saveCanvas: (filePath, content, expectedRevision, expectedVaultId) =>
    ipcRenderer.invoke(
      ipcChannels.saveCanvas,
      filePath,
      content,
      expectedRevision,
      expectedVaultId,
    ) as Promise<CanvasSaveResponse>,
  setNoteProperty: (filePath, name, rawValue, type, expectedRevision, expectedVaultId) =>
    ipcRenderer.invoke(
      ipcChannels.setNoteProperty,
      filePath,
      name,
      rawValue,
      type,
      expectedRevision,
      expectedVaultId,
    ) as Promise<NotePropertySetResponse>,
  removeNoteProperty: (filePath, name, expectedRevision, expectedVaultId) =>
    ipcRenderer.invoke(
      ipcChannels.removeNoteProperty,
      filePath,
      name,
      expectedRevision,
      expectedVaultId,
    ) as Promise<NotePropertyRemoveResponse>,
  getEditorDraft: (expectedVaultId, paneId) =>
    ipcRenderer.invoke(
      ipcChannels.getEditorDraft,
      expectedVaultId,
      paneId,
    ) as Promise<EditorDraftReadResponse>,
  saveEditorDraft: (draft) =>
    ipcRenderer.invoke(ipcChannels.saveEditorDraft, draft) as Promise<EditorDraftSaveResponse>,
  clearEditorDraft: (expectedVaultId, draftId, paneId) =>
    ipcRenderer.invoke(
      ipcChannels.clearEditorDraft,
      expectedVaultId,
      draftId,
      paneId,
    ) as Promise<EditorDraftClearResponse>,
  onMenuCommand: (listener) => {
    const subscription = (_event: Electron.IpcRendererEvent, commandId: NativeMenuCommandId) => {
      listener(commandId);
    };
    ipcRenderer.on(ipcChannels.menuCommand, subscription);
    return () => ipcRenderer.removeListener(ipcChannels.menuCommand, subscription);
  },
  runCommand: (commandId, editorContext) =>
    ipcRenderer.invoke(
      ipcChannels.runCommand,
      commandId,
      editorContext,
    ) as Promise<RuntimeSnapshot>,
  waitForPluginMutations: (options) =>
    ipcRenderer.invoke(ipcChannels.waitForPluginMutations, options) as Promise<RuntimeSnapshot>,
  reloadPlugin: (pluginId) =>
    ipcRenderer.invoke(ipcChannels.reloadPlugin, pluginId) as Promise<RuntimeSnapshot>,
  unloadPlugin: (pluginId) =>
    ipcRenderer.invoke(ipcChannels.unloadPlugin, pluginId) as Promise<RuntimeSnapshot>,
  markPluginLayoutReady: () =>
    ipcRenderer.invoke(ipcChannels.markPluginLayoutReady) as Promise<RuntimeSnapshot>,
  openPluginSettings: (pluginId) =>
    ipcRenderer.invoke(ipcChannels.openPluginSettings, pluginId) as Promise<RuntimeSnapshot>,
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
  setPluginSurfaceAccessibility: (preferences: EffectiveAccessibilityPreferences) =>
    ipcRenderer.invoke(ipcChannels.setPluginSurfaceAccessibility, preferences) as Promise<void>,
  getAccessibilityPreferences: () =>
    ipcRenderer.invoke(
      ipcChannels.accessibilityPreferences,
    ) as Promise<AccessibilityPreferencesSnapshot>,
  setAccessibilityPreferences: (preferences: AccessibilityPreferences) =>
    ipcRenderer.invoke(
      ipcChannels.setAccessibilityPreferences,
      preferences,
    ) as Promise<AccessibilityPreferencesSnapshot>,
  resetAccessibilityPreferences: () =>
    ipcRenderer.invoke(
      ipcChannels.resetAccessibilityPreferences,
    ) as Promise<AccessibilityPreferencesSnapshot>,
  onSnapshot: (listener) => {
    const subscription = (_event: Electron.IpcRendererEvent, snapshot: RuntimeSnapshot) => {
      listener(snapshot);
    };
    ipcRenderer.on(ipcChannels.snapshotChanged, subscription);
    return () => ipcRenderer.removeListener(ipcChannels.snapshotChanged, subscription);
  },
  onWorkspaceLayout: (listener: (snapshot: WorkspaceLayoutSnapshot) => void) => {
    const subscription = (_event: Electron.IpcRendererEvent, snapshot: WorkspaceLayoutSnapshot) => {
      listener(snapshot);
    };
    ipcRenderer.on(ipcChannels.workspaceLayoutChanged, subscription);
    return () => ipcRenderer.removeListener(ipcChannels.workspaceLayoutChanged, subscription);
  },
  onSettings: (listener) => {
    const subscription = (_event: Electron.IpcRendererEvent, snapshot: AppSettingsSnapshot) => {
      listener(snapshot);
    };
    ipcRenderer.on(ipcChannels.settingsChanged, subscription);
    return () => ipcRenderer.removeListener(ipcChannels.settingsChanged, subscription);
  },
  onAccessibilityPreferences: (listener) => {
    const subscription = (
      _event: Electron.IpcRendererEvent,
      snapshot: AccessibilityPreferencesSnapshot,
    ) => {
      listener(snapshot);
    };
    ipcRenderer.on(ipcChannels.accessibilityPreferencesChanged, subscription);
    return () =>
      ipcRenderer.removeListener(ipcChannels.accessibilityPreferencesChanged, subscription);
  },
  onAppUpdate: (listener) => {
    const subscription = (_event: Electron.IpcRendererEvent, snapshot: AppUpdateSnapshot) => {
      listener(snapshot);
    };
    ipcRenderer.on(ipcChannels.appUpdateChanged, subscription);
    return () => ipcRenderer.removeListener(ipcChannels.appUpdateChanged, subscription);
  },
};

contextBridge.exposeInMainWorld("threadleaf", bridge);
