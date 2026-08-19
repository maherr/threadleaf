import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { release as osRelease } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  type OpenDialogOptions,
  type SaveDialogOptions,
  screen,
  shell,
  type WebContents,
  type WebContentsView,
} from "electron";
import { AccessibilityPreferencesController } from "../application/accessibility-preferences-controller";
import { AppSettingsController } from "../application/app-settings-controller";
import { AppUpdateController } from "../application/app-update-controller";
import { parseEditorDraft } from "../application/editor-draft";
import { NoteBookmarkController } from "../application/note-bookmarks";
import {
  performVaultAttachmentNativeAction,
  type VaultAttachmentShellPort,
} from "../application/vault-attachment-native-action";
import { parseVaultGraphRequest } from "../application/vault-graph";
import { WorkspaceController } from "../application/workspace-controller";
import { atomicWriteFile, readStableFile } from "../kernel/durability";
import { VaultPathPolicy } from "../kernel/path-policy";
import { FixedStateRoot, type VaultReadPort } from "../kernel/ports";
import { acquireStateLock } from "../private-state-lock";
import { IsolatedPluginRuntime } from "../runtime/isolated-plugin-runtime";
import { PluginHost } from "../runtime/plugin-host";
import { isFatalPluginRuntimeError } from "../runtime/plugin-runtime-port";
import { RecoveringPluginRuntime } from "../runtime/recovering-plugin-runtime";
import {
  accessibilityAccentChoices,
  type EffectiveAccessibilityPreferences,
  parseAccessibilityPreferences,
} from "../shared/accessibility-preferences";
import {
  type AppearanceResponse,
  type AppearanceSnapshot,
  parseVaultAppearanceSettings,
} from "../shared/appearance";
import {
  MAX_VAULT_ATTACHMENT_BATCH_BYTES,
  MAX_VAULT_ATTACHMENT_BATCH_ITEMS,
  MAX_VAULT_ATTACHMENT_BYTES,
} from "../shared/attachment-limits";
import {
  type AutosaveFlushReason,
  type AutosaveFlushResult,
  isAutosaveFlushReason,
} from "../shared/autosave";
import {
  type AppearancePackageApplyResponse,
  type AttachmentOperation,
  type NotePropertyType,
  notePropertyTypes,
  type PluginPackageApplyResponse,
  type PluginSurfaceBounds,
  type PluginUpdateResponse,
  type RuntimeSnapshot,
  type VaultAttachmentNativeActionRequest,
} from "../shared/contracts";
import { ipcChannels } from "../shared/ipc-channels";
import type { AppSettings } from "../shared/key-bindings";
import { isShortcutTargetId } from "../shared/key-bindings";
import type { MigrationApplyRequest } from "../shared/migration";
import type { NativeMenuCommandId } from "../shared/native-menu";
import { parseVaultNoteWorkflowSettings } from "../shared/note-workflows";
import {
  attachedPluginDiagnosticCode,
  type PluginDiagnosticCode,
  type PluginDiagnosticSubject,
  pluginDiagnosticError,
} from "../shared/plugin-diagnostics";
import { parsePluginPackagePreviewRequest } from "../shared/plugin-packages";
import {
  type PluginRendererEnvironment,
  parsePluginEditorContext,
  parsePluginMutationWaitOptions,
  parsePluginVaultCreateBinaryRequest,
  parsePluginVaultCreateFolderRequest,
  parsePluginVaultCreateRequest,
  parsePluginVaultListMarkdownPathsRequest,
  parsePluginVaultReadTextRequest,
  parsePluginVaultRenameRequest,
  parsePluginVaultTrashRequest,
  parsePluginVaultWriteBinaryRequest,
  parsePluginVaultWriteRequest,
  pluginRendererChannels,
} from "../shared/plugin-runtime-protocol";
import {
  applyCompatibilityProfile,
  type CompatibilityMode,
  type CompatibilityProfile,
  compatibilityModes,
  compatibilityProfiles,
  isPluginConstructionRefusal,
  type PluginCapabilityGrantState,
  type PluginCatalogResponse,
  type PluginConstructionDispatch,
  type PluginConstructionPath,
  type PluginConstructionRequest,
  parsePluginId,
  pluginCapabilityGrantMatches,
  type VaultPluginSettings,
} from "../shared/plugins";
import {
  maximumPublishNoteHtmlBytes,
  type PublishNoteExportRequest,
  type PublishNoteExportResponse,
} from "../shared/publish-export";
import type { SupportBundleExportResponse } from "../shared/support-bundle";
import type { AppearancePackageKind } from "../shared/theme-packages";
import { parseAppearancePackagePreviewRequest } from "../shared/theme-packages";
import {
  restoreWorkspaceWindowBounds,
  type WorkspaceWindowBounds,
  workspaceWindowMinimumHeight,
  workspaceWindowMinimumWidth,
} from "../shared/workspace-layout";
import {
  WorkspaceOpenDiagnostics,
  type WorkspaceOpenTransferAcknowledgement,
  WorkspaceOpenTransferTracker,
} from "../shared/workspace-open-diagnostics";
import {
  createDefaultVaultWorkspaceSettings,
  parseVaultWorkspaceMode,
  parseVaultWorkspaceSettings,
} from "../shared/workspace-settings";
import {
  AppearanceWatcherLifecycle,
  type AppearanceWatchTarget,
} from "./appearance-watcher-lifecycle";
import { createApplicationMenuTemplate } from "./application-menu";
import {
  readDevelopmentPickerOverride,
  readDevelopmentVaultPath,
} from "./development-picker-override";
import { ElectronPluginRuntime } from "./electron-plugin-runtime";
import { FileAccessibilityPreferencesStore } from "./file-accessibility-preferences-store";
import { FileAppSettingsStore } from "./file-app-settings-store";
import { FileEditorDraftStore } from "./file-editor-draft-store";
import { FileNoteBookmarkStore } from "./file-note-bookmark-store";
import { FileVaultSelectionStore } from "./file-vault-selection-store";
import { FileWorkspaceLayoutStore } from "./file-workspace-layout-store";
import { FileWorkspaceStateStore } from "./file-workspace-state-store";
import { createGracefulShutdownHandler } from "./graceful-shutdown";
import { createMainRendererRecoveryHandler } from "./main-renderer-recovery";
import { installMainWindowNavigationGuards } from "./navigation-policy";
import { loadObsidianMigrationPreview } from "./obsidian-migration-loader";
import {
  applyMigrationSelections,
  buildMigrationPlan,
  type MigrationPrivateState,
  type MigrationTransactionPhase,
  ObsidianMigrationTransactionManager,
} from "./obsidian-migration-transaction";
import { OpenPluginPackageSource } from "./open-plugin-package-source";
import { OpenAppearancePackageSource } from "./open-theme-package-source";
import { appUpdateDisabledReason, readPackageUpdateTrust } from "./package-update-trust";
import {
  type PluginConstructionAuthoritySession,
  PluginConstructionAuthorityStore,
} from "./plugin-construction-authority-store";
import {
  capturePluginPackageTree,
  inspectCapturedPluginPackage,
  PluginConstructionPolicyResolver,
} from "./plugin-construction-policy";
import { assertMainRendererPluginIpcSender } from "./plugin-ipc-sender-guard";
import { PluginPackageManager } from "./plugin-package-manager";
import { PluginSurfaceEnvironmentBridge } from "./plugin-surface-environment";
import {
  ensureHtmlExtension,
  isPublishExportTargetOutsideVault,
  parsePublishNoteExportRequest,
  readDevelopmentPublishExportPath,
  suggestedPublishedNoteFilename,
} from "./publish-export";
import { RendererAutosaveFlushCoordinator } from "./renderer-autosave-flush";
import {
  createSupportBundleMarkdown,
  isSupportBundleTargetOutsideVault,
  readDevelopmentSupportBundlePath,
} from "./support-bundle";
import { ThemePackageManager } from "./theme-package-manager";
import { TrustedWorkspacePluginRuntime } from "./trusted-workspace-plugin-runtime";
import {
  trustedWorkspaceProbeArgument,
  trustedWorkspaceProbeEnabled,
} from "./trusted-workspace-probe";
import { loadVaultAppearance } from "./vault-appearance-loader";
import { VaultAppearanceWatcher } from "./vault-appearance-watcher";
import {
  type DiscoveredVaultPlugin,
  discoverVaultPlugins,
  loadVaultPluginCatalog,
} from "./vault-plugin-loader";
import { WorkspaceLayoutController } from "./workspace-layout-controller";

const applicationId = "org.threadleaf.Threadleaf";

app.setName("Threadleaf");
if (process.platform === "win32") {
  app.setAppUserModelId(applicationId);
}
if (process.argv.includes("--version")) {
  process.stdout.write(`${app.getVersion()}\n`);
  app.exit(0);
}
if (process.argv.includes("--update-trust")) {
  process.stdout.write(`${readPackageUpdateTrust(app.getAppPath()) ?? "none"}\n`);
  app.exit(0);
}
const nativeLockProbeIndex = process.argv.indexOf("--native-lock-probe");
if (nativeLockProbeIndex >= 0) {
  const lockPath = process.argv[nativeLockProbeIndex + 1];
  if (!lockPath) {
    process.stderr.write("--native-lock-probe requires an absolute lock path.\n");
    app.exit(2);
    throw new Error("--native-lock-probe requires an absolute lock path.");
  }
  try {
    const lock = acquireStateLock(lockPath);
    lock.assertPathIdentity();
    lock.close();
    process.stdout.write(
      `${JSON.stringify({
        imported: true,
        acquired: true,
        asserted: true,
        released: true,
      })}\n`,
    );
    app.exit(0);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    app.exit(1);
  }
}

// Early-exit CLI probes intentionally bypass the GUI profile gate. Every GUI launch
// must claim its profile before Electron readiness or any private-state object
// is constructed. This is GUI hardening only; the native state lock remains the
// authority for CLI writers, alternate profiles, and crash recovery.
const hasSingleInstanceLock = app.requestSingleInstanceLock();

let mainWindow: BrowserWindow | null = null;
let mainWindowTrustedWorkspace = false;
let applicationQuitAuthorized = false;
const rendererAutosaveFlush = new RendererAutosaveFlushCoordinator({
  send: (senderId, request) => {
    const window = mainWindow;
    if (
      !window ||
      window.isDestroyed() ||
      window.webContents.isDestroyed() ||
      window.webContents.id !== senderId
    ) {
      throw new Error("The main renderer is unavailable for autosave.");
    }
    window.webContents.send(ipcChannels.requestAutosaveFlush, request);
  },
});
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const window = mainWindow;
    if (!window || window.isDestroyed()) {
      return;
    }
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
  });
}
let workspaceController: WorkspaceController;
let settingsController: AppSettingsController;
let accessibilityPreferencesController: AccessibilityPreferencesController;
let appUpdateController: AppUpdateController;
let editorDraftStore: FileEditorDraftStore;
let noteBookmarkController: NoteBookmarkController;
let pluginPackageManager: PluginPackageManager;
let pluginConstructionAuthorityStore: PluginConstructionAuthorityStore;
const pluginConstructionAuthoritySessions = new Map<string, PluginConstructionAuthoritySession>();
let activeTrustedWorkspaceRuntime: TrustedWorkspacePluginRuntime | null = null;
let activeTrustedWorkspaceReadPort: (VaultReadPort & { vaultPath: string }) | null = null;
let appearancePackageSource: OpenAppearancePackageSource;
let themePackageManager: ThemePackageManager;
let workspaceLayoutController!: WorkspaceLayoutController;
let workspaceStateStore: FileWorkspaceStateStore;
let privateMutationTail: Promise<void> = Promise.resolve();
let mainWorkspaceTransition: Promise<void> | null = null;
let mainRendererRecovery: Promise<void> | null = null;
let initialWorkspaceActivation: Promise<void> | null = null;
let initialWorkspaceRecoveryPending = false;
let attachedPluginView: WebContentsView | null = null;
let attachedPluginHost: BrowserWindow | null = null;
let pluginPopoutWindow: BrowserWindow | null = null;
let pluginPopoutRendererMonitor: NodeJS.Timeout | undefined;
let closingPluginPopout = false;
let workspaceSnapshotSequence = 0;
const workspaceOpenDiagnostics =
  process.env.THREADLEAF_WORKSPACE_OPEN_DIAGNOSTICS === "1"
    ? new WorkspaceOpenDiagnostics()
    : undefined;
const workspaceOpenTransferTracker = workspaceOpenDiagnostics
  ? new WorkspaceOpenTransferTracker(workspaceOpenDiagnostics)
  : undefined;
const compatibilityPluginViews = new Set<WebContentsView>();
const visiblePluginViews = new Set<WebContentsView>();
let pluginSurfaceBounds: PluginSurfaceBounds = { x: 0, y: 0, width: 0, height: 0 };
let pluginSurfaceCss = "";
let pluginSurfaceAppearanceCss = "";

if (process.env.THREADLEAF_WORKSPACE_DOCKS_RUN) {
  process.on("SIGUSR2", () => {
    const popout = pluginPopoutWindow;
    if (popout && !popout.isDestroyed() && !popout.webContents.isDestroyed()) {
      popout.webContents.forcefullyCrashRenderer();
      void handlePluginPopoutClosed(popout, true);
    }
  });
}
let pluginSurfaceTheme: "dark" | "light" = "dark";
let pluginSurfacePresentationVisible = true;
let appearanceWatcherLifecycle: AppearanceWatcherLifecycle | null = null;
let pluginSurfaceAccessibility: EffectiveAccessibilityPreferences = {
  highContrast: false,
  accent: "blue",
  uiFontScale: 1,
  textFontScale: 1,
  editorFontSize: 15,
  editorLineHeight: 1.6,
  reducedMotion: false,
  reducedTransparency: false,
};
const pluginSurfaceEnvironmentBridges = new Map<string, PluginSurfaceEnvironmentBridge>();
let migrationTransactionManager: ObsidianMigrationTransactionManager | null = null;
const migrationStartupNotices = new Map<
  string,
  Awaited<ReturnType<ObsidianMigrationTransactionManager["recover"]>>
>();

function pluginAccessibilityCss(): string {
  return `
    :root[data-threadleaf-high-contrast="true"] {
      --background-primary: #ffffff !important;
      --background-primary-alt: #ffffff !important;
      --background-secondary: #ffffff !important;
      --background-secondary-alt: #ffffff !important;
      --background-modifier-border: #111111 !important;
      --background-modifier-border-hover: #000000 !important;
      --background-modifier-hover: #eeeeee !important;
      --text-normal: #111111 !important;
      --text-muted: #333333 !important;
      --text-faint: #444444 !important;
      --text-on-accent: #ffffff !important;
    }
    :root[data-theme="dark"][data-threadleaf-high-contrast="true"] {
      --background-primary: #000000 !important;
      --background-primary-alt: #000000 !important;
      --background-secondary: #000000 !important;
      --background-secondary-alt: #000000 !important;
      --background-modifier-border: #ffffff !important;
      --background-modifier-border-hover: #ffffff !important;
      --background-modifier-hover: #222222 !important;
      --text-normal: #ffffff !important;
      --text-muted: #eeeeee !important;
      --text-faint: #dddddd !important;
      --text-on-accent: #000000 !important;
    }
    :root[data-threadleaf-reduced-motion="true"] *,
    :root[data-threadleaf-reduced-motion="true"] *::before,
    :root[data-threadleaf-reduced-motion="true"] *::after {
      animation: none !important;
      transition: none !important;
      scroll-behavior: auto !important;
    }
    :root[data-threadleaf-reduced-transparency="true"] *,
    :root[data-threadleaf-reduced-transparency="true"] *::before,
    :root[data-threadleaf-reduced-transparency="true"] *::after {
      backdrop-filter: none !important;
    }
    :root[data-threadleaf-reduced-transparency="true"] dialog::backdrop {
      backdrop-filter: none !important;
      background: var(--background-primary) !important;
    }
    html[data-threadleaf-accessibility="true"] body {
      font-size: calc(1em * var(--threadleaf-ui-font-scale)) !important;
    }
    html[data-threadleaf-accessibility="true"][data-threadleaf-accent="blue"] {
      --interactive-accent: #1c5c8c !important;
      --interactive-accent-hover: #14486f !important;
      --text-accent: #1c5c8c !important;
    }
    html[data-theme="dark"][data-threadleaf-accessibility="true"][data-threadleaf-accent="blue"] {
      --interactive-accent: #85b2dc !important;
      --interactive-accent-hover: #a9cbe9 !important;
      --text-accent: #a9cbe9 !important;
    }
    html[data-threadleaf-accessibility="true"][data-threadleaf-accent="teal"] {
      --interactive-accent: #006b5d !important;
      --interactive-accent-hover: #004f46 !important;
      --text-accent: #006b5d !important;
    }
    html[data-theme="dark"][data-threadleaf-accessibility="true"][data-threadleaf-accent="teal"] {
      --interactive-accent: #62d4c3 !important;
      --interactive-accent-hover: #a0f1e3 !important;
      --text-accent: #a0f1e3 !important;
    }
    html[data-threadleaf-accessibility="true"][data-threadleaf-accent="orange"] {
      --interactive-accent: #9a4b00 !important;
      --interactive-accent-hover: #713400 !important;
      --text-accent: #9a4b00 !important;
    }
    html[data-theme="dark"][data-threadleaf-accessibility="true"][data-threadleaf-accent="orange"] {
      --interactive-accent: #ffb45f !important;
      --interactive-accent-hover: #ffd29a !important;
      --text-accent: #ffd29a !important;
    }
    html[data-threadleaf-accessibility="true"] .threadleaf-plugin-settings-surface {
      font-size: calc(1em * var(--threadleaf-text-font-scale)) !important;
    }
    html[data-threadleaf-accessibility="true"] .threadleaf-plugin-surface,
    html[data-threadleaf-accessibility="true"] .threadleaf-plugin-surface * {
      line-height: var(--threadleaf-editor-line-height) !important;
    }
  `;
}

function createPluginSurfaceEnvironmentBridge(): PluginSurfaceEnvironmentBridge {
  return new PluginSurfaceEnvironmentBridge({
    theme: pluginSurfaceTheme,
    appearanceCss: pluginSurfaceAppearanceCss,
    pluginCss: pluginSurfaceCss,
    accessibilityCss: pluginAccessibilityCss(),
    accessibility: pluginSurfaceAccessibility,
  });
}

function pluginSurfaceEnvironmentIdentity(): { vaultId: string; vaultGeneration: number } | null {
  const vaultId = workspaceController?.vaultId;
  if (!vaultId) {
    return null;
  }
  const session = pluginConstructionAuthoritySessions.get(vaultId);
  return session ? { vaultId, vaultGeneration: session.vaultGeneration } : null;
}

async function publishPluginSurfaceEnvironment(
  patch: Partial<PluginRendererEnvironment>,
): Promise<void> {
  const identity = pluginSurfaceEnvironmentIdentity();
  if (
    !identity &&
    [...pluginSurfaceEnvironmentBridges.values()].some((bridge) => bridge.targetCount > 0)
  ) {
    throw new Error("Live compatibility renderers have no active vault identity.");
  }
  if (!identity) return;
  const bridge = pluginSurfaceEnvironmentBridges.get(identity.vaultId);
  if (!bridge) return;
  await bridge.update({
    ...patch,
    ...identity,
  });
}

async function applyPluginSurfaceTheme(theme: "dark" | "light"): Promise<void> {
  pluginSurfaceTheme = theme;
  await publishPluginSurfaceEnvironment({ theme });
}

async function applyPluginSurfaceAccessibility(
  preferences: EffectiveAccessibilityPreferences,
): Promise<void> {
  pluginSurfaceAccessibility = preferences;
  await publishPluginSurfaceEnvironment({
    accessibility: preferences,
    accessibilityCss: pluginAccessibilityCss(),
  });
}

async function applyPluginSurfaceCss(css: string): Promise<void> {
  pluginSurfaceCss = css;
  await publishPluginSurfaceEnvironment({ pluginCss: css });
}

function detachPluginView(): void {
  if (attachedPluginView && attachedPluginHost && !attachedPluginHost.isDestroyed()) {
    attachedPluginHost.contentView.removeChildView(attachedPluginView);
  }
  attachedPluginView = null;
  attachedPluginHost = null;
}

function updatePluginViewBounds(): void {
  if (!attachedPluginView || pluginSurfaceBounds.width <= 0 || pluginSurfaceBounds.height <= 0) {
    return;
  }
  if (
    attachedPluginHost === pluginPopoutWindow &&
    pluginPopoutWindow &&
    !pluginPopoutWindow.isDestroyed()
  ) {
    const bounds = pluginPopoutWindow.getContentBounds();
    attachedPluginView.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
    return;
  }
  attachedPluginView.setBounds(pluginSurfaceBounds);
}

function attachPluginViewToWindow(view: WebContentsView, target: BrowserWindow): void {
  if (target.isDestroyed()) {
    return;
  }
  if (attachedPluginView === view && attachedPluginHost === target) {
    updatePluginViewBounds();
    return;
  }
  detachPluginView();
  target.contentView.addChildView(view);
  attachedPluginView = view;
  attachedPluginHost = target;
  updatePluginViewBounds();
}

function setPluginViewVisibility(view: WebContentsView, visible: boolean): void {
  if (!visible) {
    visiblePluginViews.delete(view);
    if (attachedPluginView === view) {
      detachPluginView();
    }
    return;
  }
  visiblePluginViews.delete(view);
  visiblePluginViews.add(view);
  if (!pluginSurfacePresentationVisible || !compatibilityPluginViews.has(view)) {
    return;
  }
  const targetWindow = pluginPopoutWindow ?? mainWindow;
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }
  attachPluginViewToWindow(view, targetWindow);
}

function setPluginSurfacePresentationVisible(visible: boolean): void {
  pluginSurfacePresentationVisible = visible;
  if (!visible) {
    detachPluginView();
    return;
  }
  const view = [...visiblePluginViews].findLast(
    (candidate) => compatibilityPluginViews.has(candidate) && !candidate.webContents.isDestroyed(),
  );
  if (view) {
    setPluginViewVisibility(view, true);
  }
}

async function registerCompatibilityPluginView(runtime: ElectronPluginRuntime): Promise<void> {
  const view = runtime.view;
  const webContents = view.webContents;
  compatibilityPluginViews.add(view);
  webContents.once("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    queueMicrotask(() => {
      void workspaceController
        .getSnapshot()
        .then((snapshot) => broadcastWorkspaceSnapshot(snapshot))
        .catch((error) =>
          console.error("Could not publish compatibility renderer recovery:", error),
        );
    });
  });
  webContents.once("destroyed", () => {
    compatibilityPluginViews.delete(view);
    visiblePluginViews.delete(view);
    if (attachedPluginView === view) {
      detachPluginView();
    }
    const popout = pluginPopoutWindow;
    if (popout && !popout.isDestroyed()) {
      closingPluginPopout = true;
      popout.close();
      pluginPopoutWindow = null;
      closingPluginPopout = false;
      void workspaceLayoutController
        .reattachPopout(
          workspaceController.vaultId,
          "The plugin view unloaded; its pop-out was reattached safely.",
        )
        .catch((error) => console.error("Could not persist unloaded plugin reattachment:", error));
    }
  });
}

function workspaceDisplayAreas(): Array<{ x: number; y: number; width: number; height: number }> {
  return screen.getAllDisplays().map((display) => ({
    x: display.workArea.x,
    y: display.workArea.y,
    width: display.workArea.width,
    height: display.workArea.height,
  }));
}

function windowBounds(window: BrowserWindow): WorkspaceWindowBounds {
  const bounds = window.getBounds();
  const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
  return {
    x: bounds.x,
    y: bounds.y,
    width: Math.max(workspaceWindowMinimumWidth, bounds.width),
    height: Math.max(workspaceWindowMinimumHeight, bounds.height),
    scaleFactor: display?.scaleFactor ?? 1,
  };
}

async function workspaceSnapshotWithLayout(snapshot: RuntimeSnapshot): Promise<RuntimeSnapshot> {
  if (snapshot.vault.id && workspaceLayoutController.vaultId !== snapshot.vault.id) {
    const previousVaultId = workspaceLayoutController.vaultId;
    const popout = pluginPopoutWindow;
    if (popout && !popout.isDestroyed()) {
      closingPluginPopout = true;
      popout.close();
      pluginPopoutWindow = null;
      closingPluginPopout = false;
      const currentView = [...visiblePluginViews].find((view) => !view.webContents.isDestroyed());
      if (currentView && mainWindow && !mainWindow.isDestroyed()) {
        attachPluginViewToWindow(currentView, mainWindow);
      }
      await workspaceLayoutController
        .reattachPopout(previousVaultId)
        .catch((error) => console.error("Could not persist vault-switch reattachment:", error));
    }
    await workspaceLayoutController.activateVault(snapshot.vault.id);
  }
  return { ...snapshot, workspaceLayout: workspaceLayoutController.snapshot() };
}

async function handlePluginPopoutClosed(window: BrowserWindow, crashed: boolean): Promise<void> {
  if (pluginPopoutRendererMonitor !== undefined) {
    clearInterval(pluginPopoutRendererMonitor);
    pluginPopoutRendererMonitor = undefined;
  }
  if (pluginPopoutWindow !== window) {
    return;
  }
  pluginPopoutWindow = null;
  if (closingPluginPopout) {
    closingPluginPopout = false;
    return;
  }
  const currentView = [...visiblePluginViews].find((view) => !view.webContents.isDestroyed());
  if (currentView && mainWindow && !mainWindow.isDestroyed()) {
    attachPluginViewToWindow(currentView, mainWindow);
  }
  if (crashed && !window.isDestroyed()) {
    window.destroy();
  }
  const warning = crashed
    ? "The pop-out window crashed; its view was reattached to the main window."
    : null;
  await workspaceLayoutController
    .reattachPopout(workspaceController.vaultId, warning)
    .catch((error) => {
      console.error("Could not persist pop-out reattachment:", error);
    });
}

async function popOutPluginView(
  expectedVaultId: string,
): Promise<ReturnType<WorkspaceLayoutController["snapshot"]>> {
  if (workspaceController.vaultId !== expectedVaultId) {
    throw new Error("The active vault changed before the plugin view could pop out.");
  }
  const snapshot = await workspaceController.getSnapshot();
  if (!snapshot.pluginSurface) {
    throw new Error("Open a supported plugin view before popping it out.");
  }
  if (pluginPopoutWindow && !pluginPopoutWindow.isDestroyed()) {
    pluginPopoutWindow.focus();
    return workspaceLayoutController.snapshot();
  }
  const previous = workspaceLayoutController.snapshot().popout.bounds;
  const fallback: WorkspaceWindowBounds = {
    x: 120,
    y: 90,
    width: 820,
    height: 620,
    scaleFactor: 1,
  };
  const bounds = restoreWorkspaceWindowBounds(previous, workspaceDisplayAreas(), fallback);
  const popout = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: workspaceWindowMinimumWidth,
    minHeight: workspaceWindowMinimumHeight,
    title: `Threadleaf · ${snapshot.pluginSurface.displayText}`,
    show: false,
    backgroundColor: "#11151c",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  pluginPopoutWindow = popout;
  let popoutBoundsTimer: NodeJS.Timeout | undefined;
  let popoutRendererFailed = false;
  const persistPopoutBounds = (): void => {
    updatePluginViewBounds();
    if (popoutBoundsTimer !== undefined) {
      clearTimeout(popoutBoundsTimer);
    }
    popoutBoundsTimer = setTimeout(() => {
      popoutBoundsTimer = undefined;
      if (popout.isDestroyed() || pluginPopoutWindow !== popout) {
        return;
      }
      const layout = workspaceLayoutController.snapshot();
      if (layout.popout.state !== "open" || !layout.popout.viewType) {
        return;
      }
      void workspaceLayoutController
        .setPopout({ ...layout.popout, bounds: windowBounds(popout) }, workspaceController.vaultId)
        .catch((error) => console.error("Could not persist pop-out bounds:", error));
    }, 150);
  };
  popout.on("move", persistPopoutBounds);
  popout.on("resize", persistPopoutBounds);
  popout.once("ready-to-show", () => {
    const currentView = [...visiblePluginViews].find((view) => !view.webContents.isDestroyed());
    if (currentView) {
      attachPluginViewToWindow(currentView, popout);
    }
    popout.show();
  });
  popout.on("closed", () => {
    if (popoutBoundsTimer !== undefined) {
      clearTimeout(popoutBoundsTimer);
      popoutBoundsTimer = undefined;
    }
    setTimeout(() => {
      void handlePluginPopoutClosed(popout, popoutRendererFailed);
    }, 100);
  });
  popout.webContents.on("render-process-gone", (_event, details) => {
    popoutRendererFailed = details.reason !== "clean-exit";
    void handlePluginPopoutClosed(popout, popoutRendererFailed);
  });
  let popoutLoadTimer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      app.isPackaged || process.env.THREADLEAF_TEST_PLUGIN_POPOUT_LOAD_FAILURE !== "1"
        ? popout.loadURL("about:blank")
        : popout.loadFile(join(__dirname, "missing-plugin-popout-test-fixture.html")),
      new Promise<never>((_, reject) => {
        popoutLoadTimer = setTimeout(
          () => reject(new Error("The plugin pop-out timed out while loading.")),
          10_000,
        );
      }),
    ]);
  } catch {
    if (popoutLoadTimer !== undefined) {
      clearTimeout(popoutLoadTimer);
      popoutLoadTimer = undefined;
    }
    if (pluginPopoutRendererMonitor !== undefined) {
      clearInterval(pluginPopoutRendererMonitor);
      pluginPopoutRendererMonitor = undefined;
    }
    if (pluginPopoutWindow === popout) {
      closingPluginPopout = true;
      if (!popout.isDestroyed()) {
        popout.close();
      }
      pluginPopoutWindow = null;
      closingPluginPopout = false;
    }
    const currentView = [...visiblePluginViews].find((view) => !view.webContents.isDestroyed());
    if (currentView && mainWindow && !mainWindow.isDestroyed()) {
      attachPluginViewToWindow(currentView, mainWindow);
    }
    const warning =
      "The plugin pop-out could not be opened. Its view was reattached to the main window.";
    const layout = workspaceLayoutController.snapshot();
    try {
      return await workspaceLayoutController.setPopout(
        {
          state: "degraded",
          viewType: snapshot.pluginSurface.viewType,
          filePath: snapshot.pluginSurface.filePath,
          bounds: layout.popout.bounds ?? bounds,
          warning,
        },
        expectedVaultId,
      );
    } catch (cleanupError) {
      console.error("Could not persist pop-out load cleanup:", cleanupError);
      throw new Error("The plugin pop-out could not be opened and recovery could not be saved.");
    }
  } finally {
    if (popoutLoadTimer !== undefined) {
      clearTimeout(popoutLoadTimer);
      popoutLoadTimer = undefined;
    }
  }
  if (popout.isDestroyed() || pluginPopoutWindow !== popout) {
    throw new Error("The plugin pop-out closed before it finished opening.");
  }
  try {
    await workspaceLayoutController.setPopout(
      {
        state: "open",
        viewType: snapshot.pluginSurface.viewType,
        filePath: snapshot.pluginSurface.filePath,
        bounds,
        warning: null,
      },
      expectedVaultId,
    );
  } catch (error) {
    if (pluginPopoutWindow === popout) {
      closingPluginPopout = true;
      if (!popout.isDestroyed()) {
        popout.close();
      }
      pluginPopoutWindow = null;
      closingPluginPopout = false;
    }
    const currentView = [...visiblePluginViews].find((view) => !view.webContents.isDestroyed());
    if (currentView && mainWindow && !mainWindow.isDestroyed()) {
      attachPluginViewToWindow(currentView, mainWindow);
    }
    throw error;
  }
  const rendererPid = popout.webContents.getOSProcessId();
  pluginPopoutRendererMonitor = setInterval(() => {
    if (popout.isDestroyed() || pluginPopoutWindow !== popout) {
      if (pluginPopoutRendererMonitor !== undefined) {
        clearInterval(pluginPopoutRendererMonitor);
        pluginPopoutRendererMonitor = undefined;
      }
      return;
    }
    try {
      process.kill(rendererPid, 0);
    } catch {
      if (pluginPopoutRendererMonitor !== undefined) {
        clearInterval(pluginPopoutRendererMonitor);
        pluginPopoutRendererMonitor = undefined;
      }
      void handlePluginPopoutClosed(popout, true);
    }
  }, 250);
  return workspaceLayoutController.snapshot();
}

async function reattachPluginView(
  expectedVaultId: string,
): Promise<ReturnType<WorkspaceLayoutController["snapshot"]>> {
  if (workspaceController.vaultId !== expectedVaultId) {
    throw new Error("The active vault changed before the plugin view could be reattached.");
  }
  const popout = pluginPopoutWindow;
  if (popout && !popout.isDestroyed()) {
    closingPluginPopout = true;
    popout.close();
    pluginPopoutWindow = null;
    closingPluginPopout = false;
  }
  const currentView = [...visiblePluginViews].find((view) => !view.webContents.isDestroyed());
  if (currentView && mainWindow && !mainWindow.isDestroyed()) {
    attachPluginViewToWindow(currentView, mainWindow);
  }
  const result = await workspaceLayoutController.reattachPopout(expectedVaultId);
  return result;
}

async function closeCompatibilityPluginView(): Promise<RuntimeSnapshot> {
  const expectedVaultId = workspaceController.vaultId;
  if (
    pluginPopoutWindow !== null ||
    workspaceLayoutController.snapshot().popout.state !== "closed"
  ) {
    await reattachPluginView(expectedVaultId);
  }
  return workspaceController.closePluginView();
}

function isCompatibilityPluginSender(webContents: WebContents): boolean {
  return (
    !webContents.isDestroyed() &&
    [...compatibilityPluginViews].some((view) => view.webContents === webContents)
  );
}

function isMainRendererSender(webContents: WebContents): boolean {
  return Boolean(
    mainWindow &&
      !mainWindow.isDestroyed() &&
      !mainWindow.webContents.isDestroyed() &&
      webContents === mainWindow.webContents,
  );
}

function handleMainRendererIpc<Arguments extends unknown[], Result>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: Arguments) => Result,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isMainRendererSender(event.sender)) {
      throw new Error("Threadleaf IPC requires the active main renderer.");
    }
    return listener(event, ...(args as Arguments));
  });
}

function isTrustedWorkspaceRendererSender(webContents: WebContents): boolean {
  return mainWindowTrustedWorkspace && isMainRendererSender(webContents);
}

function isPluginRuntimeSender(webContents: WebContents): boolean {
  return isCompatibilityPluginSender(webContents) || isTrustedWorkspaceRendererSender(webContents);
}

function createVaultAttachmentShellPort(): VaultAttachmentShellPort {
  const diagnosticReceiver =
    !app.isPackaged &&
    process.env.THREADLEAF_TEST_NATIVE_ATTACHMENT_RECEIVER === "stdout-v1" &&
    process.argv.some((argument) => argument.startsWith("--remote-debugging-port="));
  if (diagnosticReceiver) {
    const report = (action: "open" | "reveal", absolutePath: string): void => {
      console.log(
        `THREADLEAF_NATIVE_ATTACHMENT_RECEIVER ${JSON.stringify({
          version: 1,
          action,
          pathSha256: createHash("sha256").update(absolutePath, "utf8").digest("hex"),
        })}`,
      );
    };
    return {
      openPath: async (absolutePath) => {
        report("open", absolutePath);
        return "";
      },
      showItemInFolder: (absolutePath) => report("reveal", absolutePath),
    };
  }
  return {
    openPath: async (absolutePath) => {
      if (process.platform !== "linux") return shell.openPath(absolutePath);
      try {
        await shell.openExternal(pathToFileURL(absolutePath).toString());
        return "";
      } catch (error) {
        return error instanceof Error ? error.message : "Failed to open path";
      }
    },
    showItemInFolder: (absolutePath) => shell.showItemInFolder(absolutePath),
  };
}

const vaultAttachmentShell = createVaultAttachmentShellPort();

function parseAutosaveFlushResult(value: unknown): AutosaveFlushResult {
  if (
    typeof value !== "object" ||
    value === null ||
    !("requestId" in value) ||
    typeof value.requestId !== "string" ||
    !("status" in value) ||
    (value.status !== "flushed" && value.status !== "failed") ||
    (value.status === "failed" && (!("message" in value) || typeof value.message !== "string"))
  ) {
    throw new Error("Renderer autosave acknowledgement is malformed.");
  }
  return value as AutosaveFlushResult;
}

function requestWindowAutosaveFlush(
  window: BrowserWindow | null,
  reason: AutosaveFlushReason,
): Promise<void> {
  if (!isAutosaveFlushReason(reason)) {
    return Promise.reject(new Error("Autosave flush reason is unsupported."));
  }
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    return Promise.resolve();
  }
  return rendererAutosaveFlush.request(window.webContents.id, reason);
}

function dispatchApplicationMenuCommand(commandId: NativeMenuCommandId): void {
  const targetWindow = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (!targetWindow || targetWindow.isDestroyed() || targetWindow.webContents.isDestroyed()) {
    return;
  }
  targetWindow.webContents.send(ipcChannels.menuCommand, commandId);
}

function installApplicationMenu(settings: AppSettings): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      createApplicationMenuTemplate({
        dispatch: dispatchApplicationMenuCommand,
        platform: process.platform,
        settings,
      }),
    ),
  );
}

async function exportSupportBundle(): Promise<SupportBundleExportResponse> {
  try {
    let targetPath = readDevelopmentSupportBundlePath(app.isPackaged, process.env);
    if (!targetPath) {
      const dateStamp = new Date().toISOString().slice(0, 10);
      const options: SaveDialogOptions = {
        title: "Save a privacy-safe support bundle",
        buttonLabel: "Save support bundle",
        defaultPath: join(app.getPath("downloads"), `threadleaf-support-${dateStamp}.md`),
        filters: [{ name: "Markdown", extensions: ["md"] }],
        properties: ["createDirectory", "showOverwriteConfirmation"],
      };
      const result = mainWindow
        ? await dialog.showSaveDialog(mainWindow, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) {
        return { status: "cancelled" } as const;
      }
      targetPath = result.filePath;
    }

    if (!(await isSupportBundleTargetOutsideVault(workspaceController.vaultPath, targetPath))) {
      return {
        status: "failed",
        message: "Choose a location outside the active vault so the report cannot become a note.",
      } as const;
    }

    const report = createSupportBundleMarkdown({
      appearanceSafeMode: appearanceSafeMode(),
      environment: {
        appVersion: app.getVersion(),
        architecture: process.arch,
        chromiumVersion: process.versions.chrome ?? "unknown",
        electronVersion: process.versions.electron ?? "unknown",
        nodeVersion: process.versions.node,
        osRelease: osRelease(),
        packaged: app.isPackaged,
        platform: process.platform,
        updateTrust: readPackageUpdateTrust(app.getAppPath()) ?? "none",
      },
      generatedAt: new Date().toISOString(),
      pluginSafeMode: pluginSafeMode(),
      runtime: await workspaceController.getSnapshot(),
      settings: settingsController.getSnapshot(),
      update: appUpdateController.getSnapshot(),
    });
    await atomicWriteFile(targetPath, Buffer.from(report, "utf8"));
    return { status: "saved" } as const;
  } catch (error) {
    console.error("Could not export a Threadleaf support bundle:", error);
    return {
      status: "failed",
      message: "Threadleaf could not save the support bundle. Choose another location and retry.",
    } as const;
  }
}

async function publishRequestMatchesCurrentDiskNote(
  request: PublishNoteExportRequest,
): Promise<boolean> {
  if (workspaceController.vaultId !== request.expectedVaultId) {
    return false;
  }
  const snapshot = await workspaceController.getSnapshot();
  const note = snapshot.workspace?.activeNote;
  if (
    snapshot.vault.id !== request.expectedVaultId ||
    note?.path !== request.sourcePath ||
    note.revision !== request.expectedRevision
  ) {
    return false;
  }
  const pathPolicy = await VaultPathPolicy.open(workspaceController.vaultPath);
  let sourcePath: string;
  try {
    sourcePath = await pathPolicy.resolveForRead(request.sourcePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  const source = await readStableFile(sourcePath);
  return source?.revision === request.expectedRevision;
}

async function exportPublishedNote(value: unknown): Promise<PublishNoteExportResponse> {
  try {
    const request = parsePublishNoteExportRequest(value);
    if (!(await publishRequestMatchesCurrentDiskNote(request))) {
      return {
        status: "stale-note",
        message: "The active note changed before export. Review it and export again.",
      } as const;
    }

    let targetPath = readDevelopmentPublishExportPath(app.isPackaged, process.env);
    if (!targetPath) {
      const options: SaveDialogOptions = {
        title: "Export a standalone HTML note",
        buttonLabel: "Export HTML",
        defaultPath: join(
          app.getPath("downloads"),
          suggestedPublishedNoteFilename(request.sourcePath),
        ),
        filters: [{ name: "Standalone HTML", extensions: ["html"] }],
        properties: ["createDirectory", "showOverwriteConfirmation"],
      };
      const result = mainWindow
        ? await dialog.showSaveDialog(mainWindow, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) {
        return { status: "cancelled" } as const;
      }
      targetPath = ensureHtmlExtension(result.filePath);
    }

    if (!(await isPublishExportTargetOutsideVault(workspaceController.vaultPath, targetPath))) {
      return {
        status: "failed",
        message: "Choose a location outside the active vault so the export cannot become a note.",
      } as const;
    }
    if (!(await publishRequestMatchesCurrentDiskNote(request))) {
      return {
        status: "stale-note",
        message: "The active note changed while choosing a destination. Nothing was exported.",
      } as const;
    }

    const bytes = Buffer.from(request.html, "utf8");
    if (bytes.length > maximumPublishNoteHtmlBytes) {
      return {
        status: "failed",
        message:
          "This standalone export is too large. Reduce the note's embedded images and retry.",
      } as const;
    }
    await atomicWriteFile(targetPath, bytes);
    return { status: "saved" } as const;
  } catch (error) {
    console.error("Could not export a standalone Threadleaf note:", error);
    return {
      status: "failed",
      message:
        "Threadleaf could not save the standalone HTML note. Choose another location and retry.",
    } as const;
  }
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

function appearanceSafeMode(): boolean {
  return (
    process.argv.includes("--safe-appearance") || process.env.THREADLEAF_SAFE_APPEARANCE === "1"
  );
}

function appearanceWatchTarget(snapshot: RuntimeSnapshot): AppearanceWatchTarget | null {
  return snapshot.vault.mode === "kernel-backed" && snapshot.vault.id
    ? { vaultId: snapshot.vault.id, vaultPath: snapshot.vault.path }
    : null;
}

function broadcastAppearance(appearance: AppearanceSnapshot): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(ipcChannels.appearanceChanged, appearance);
    }
  }
}

async function reloadAppearanceFromWatcher(target: AppearanceWatchTarget): Promise<void> {
  const response = await currentAppearance(target.vaultId);
  if (
    response.status !== "ready" ||
    workspaceController.vaultId !== target.vaultId ||
    workspaceController.vaultPath !== target.vaultPath
  ) {
    return;
  }
  broadcastAppearance(response.appearance);
}

function reconcileAppearanceWatcher(snapshot: RuntimeSnapshot): void {
  appearanceWatcherLifecycle?.reconcile(appearanceWatchTarget(snapshot));
}

function broadcastWorkspaceSnapshot(snapshot: RuntimeSnapshot): void {
  reconcileAppearanceWatcher(snapshot);
  if (snapshot.vault.id && snapshot.vault.id !== workspaceController.vaultId) {
    return;
  }
  const sequence = ++workspaceSnapshotSequence;
  void workspaceSnapshotWithLayout(snapshot)
    .then((enriched) => {
      if (
        sequence !== workspaceSnapshotSequence ||
        enriched.vault.id !== workspaceController.vaultId
      ) {
        return;
      }
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
          window.webContents.send(
            ipcChannels.snapshotChanged,
            workspaceOpenTransferTracker
              ? workspaceOpenTransferTracker.prepare(enriched)
              : enriched,
          );
        }
      }
    })
    .catch((error) => console.error("Could not publish workspace layout snapshot:", error));
}

function createAppearanceWatcherLifecycle(): AppearanceWatcherLifecycle {
  return new AppearanceWatcherLifecycle({
    createWatcher: (target, onInvalidation) =>
      VaultAppearanceWatcher.open({
        vaultPath: target.vaultPath,
        onInvalidation,
        onError: (error) => console.error("Threadleaf appearance watcher error:", error),
      }),
    reload: reloadAppearanceFromWatcher,
    reportError: (error) => console.error("Threadleaf appearance watcher lifecycle failed:", error),
  });
}

function pluginSafeMode(): boolean {
  return process.argv.includes("--safe-plugins") || process.env.THREADLEAF_SAFE_PLUGINS === "1";
}

function trustedWorkspaceEnabledForPreference(preference: VaultPluginSettings): boolean {
  return (
    preference.compatibilityMode === "enabled" &&
    preference.compatibilityTopology === "trusted-workspace" &&
    !pluginSafeMode()
  );
}

function trustedWorkspaceEnabledForVault(vaultId: string): boolean {
  return trustedWorkspaceEnabledForPreference(settingsController.getVaultPlugins(vaultId));
}

async function ensureMainWindowTopology(
  trustedWorkspace: boolean,
  forceRecreate = false,
): Promise<void> {
  const current = mainWindow;
  if (
    current &&
    !current.isDestroyed() &&
    !current.webContents.isDestroyed() &&
    mainWindowTrustedWorkspace === trustedWorkspace &&
    !forceRecreate
  ) {
    return;
  }
  if (!current || current.isDestroyed()) {
    await createWindow(trustedWorkspace);
    return;
  }
  await createWindow(trustedWorkspace);
  if (!current.isDestroyed()) {
    current.destroy();
  }
}

function activePluginConstructionAuthoritySession(
  expectedVaultId: string,
): PluginConstructionAuthoritySession {
  if (workspaceController.vaultId !== expectedVaultId) {
    throw new Error("The active vault changed before plugin authority resolution.");
  }
  const session = pluginConstructionAuthoritySessions.get(expectedVaultId);
  if (!session) {
    throw new Error("The active vault has no plugin construction authority session.");
  }
  return session;
}

async function preparePluginConstructionRequest(
  session: PluginConstructionAuthoritySession,
  plugin: DiscoveredVaultPlugin,
  constructionPath: PluginConstructionPath,
): Promise<PluginConstructionRequest> {
  const report = plugin.summary.capabilityReport;
  if (plugin.summary.packageState !== "ready" || !report) {
    throw new Error(`Plugin ${plugin.summary.id} is not a reviewable construction package.`);
  }
  return session.prepareConstructionRequest({
    pluginDirectory: plugin.directoryPath,
    reportedMainSha256: report.bundleSha256,
    constructionPath,
  });
}

async function attachTrustedPackageFiles(
  dispatch: PluginConstructionDispatch,
): Promise<PluginConstructionDispatch> {
  const captured = await capturePluginPackageTree(dispatch.pluginDirectory);
  if (captured.canonicalRoot !== dispatch.pluginDirectory) {
    throw new Error("Trusted plugin construction resolved a different package root.");
  }
  const inspected = inspectCapturedPluginPackage(
    captured,
    dispatch.policy.packageIdentity.distributionTag,
  );
  if (
    inspected.identityDigest !== dispatch.policy.packageIdentityDigest ||
    inspected.identity.packageTreeSha256 !== dispatch.policy.packageIdentity.packageTreeSha256
  ) {
    throw new Error("Trusted plugin package bytes changed after the main-process allow decision.");
  }
  return {
    ...dispatch,
    packageFiles: captured.files.map((file) => {
      const bytes = captured.bytesByPath.get(file.path);
      if (!bytes) {
        throw new Error(`Trusted plugin package capture omitted ${file.path}.`);
      }
      return {
        ...file,
        bytes: Uint8Array.from(bytes).buffer,
      };
    }),
  };
}

async function resolvePluginCatalogAuthority(
  session: PluginConstructionAuthoritySession,
  plugin: DiscoveredVaultPlugin,
  legacyState: PluginCapabilityGrantState,
): Promise<{ grantState: PluginCapabilityGrantState; stylesheetPath: string | null }> {
  const request = await preparePluginConstructionRequest(session, plugin, "first-load");
  const grantState = await session.grantState(request, legacyState);
  if (grantState !== "granted") {
    return { grantState, stylesheetPath: null };
  }
  const snapshot = await session.readAuthoritySnapshot(request);
  if (!snapshot.sealedPackage) {
    return { grantState: "stale", stylesheetPath: null };
  }
  return {
    grantState,
    stylesheetPath:
      request.packageIdentity.stylesSha256 === null
        ? null
        : join(snapshot.sealedPackage.sealedPackageRootPath, "styles.css"),
  };
}

function developmentPluginOperationTimeout(): number | undefined {
  if (app.isPackaged) {
    return undefined;
  }
  const raw = process.env.THREADLEAF_PLUGIN_OPERATION_TIMEOUT_MS;
  if (raw === undefined) {
    return undefined;
  }
  const timeout = Number(raw);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : undefined;
}

function developmentWorkspaceSettingsDelay(): number | undefined {
  if (app.isPackaged) {
    return undefined;
  }
  const raw = process.env.THREADLEAF_WORKSPACE_SETTINGS_DELAY_MS;
  if (raw === undefined) {
    return undefined;
  }
  const delay = Number(raw);
  return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}

function developmentWorkspaceSettingsShouldFail(): boolean {
  return !app.isPackaged && process.env.THREADLEAF_WORKSPACE_SETTINGS_ERROR === "1";
}

function developmentSettingsDelay(): number | undefined {
  if (app.isPackaged) {
    return undefined;
  }
  const raw = process.env.THREADLEAF_SETTINGS_DELAY_MS;
  if (raw === undefined) {
    return undefined;
  }
  const delay = Number(raw);
  return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}

function developmentMigrationInterruptPhase(): MigrationTransactionPhase | null {
  if (app.isPackaged) {
    return null;
  }
  const value = process.env.THREADLEAF_MIGRATION_INTERRUPT_PHASE;
  return ["prepared", "settings-committed", "workspace-committed", "committed"].includes(
    value ?? "",
  )
    ? (value as MigrationTransactionPhase)
    : null;
}

function developmentMigrationFaultPhase(): MigrationTransactionPhase | null {
  if (app.isPackaged) {
    return null;
  }
  const value = process.env.THREADLEAF_MIGRATION_FAULT_PHASE;
  return ["prepared", "settings-committed", "workspace-committed", "committed"].includes(
    value ?? "",
  )
    ? (value as MigrationTransactionPhase)
    : null;
}

function serializePrivateMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = privateMutationTail.then(operation, operation);
  privateMutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function serializePluginOperation<T>(operation: () => Promise<T>): Promise<T> {
  return serializePrivateMutation(operation);
}

function serializePluginCatalogOperation<T>(
  operation: () => Promise<T>,
  code: PluginDiagnosticCode,
  subject: PluginDiagnosticSubject = {},
): Promise<T> {
  // Never wait for startup activation while holding the private-mutation queue.
  // Depending on renderer timing, activation may itself be queued behind this
  // catalog request. Snapshotting the barrier before enqueueing keeps both
  // event orders serial without creating a circular wait.
  const startupActivation = initialWorkspaceActivation;
  const run = () => serializePluginOperation(operation);
  const queuedOperation = startupActivation ? startupActivation.then(run) : run();
  return queuedOperation.catch((error: unknown) => {
    // Keep the original exception in the main-process log/cause only. IPC receives the
    // bounded category and validated subject needed for a useful Settings action.
    console.error("Threadleaf plugin catalog operation failed:", error);
    if (isFatalPluginRuntimeError(error)) {
      throw error;
    }
    throw pluginDiagnosticError(attachedPluginDiagnosticCode(error) ?? code, subject, error);
  });
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
  pluginSurfaceAppearanceCss = appearance.css;
  const authoritySession = pluginConstructionAuthoritySessions.get(expectedVaultId);
  if (authoritySession) {
    await publishPluginSurfaceEnvironment({
      vaultId: expectedVaultId,
      vaultGeneration: authoritySession.vaultGeneration,
      appearanceCss: appearance.css,
    });
  }
  return { status: "ready", appearance };
}

async function currentAppearancePackages(expectedVaultId: string) {
  if (workspaceController.vaultId !== expectedVaultId) {
    return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
  }
  const activeSnapshot = await workspaceController.getSnapshot();
  if (activeSnapshot.vault.mode === "synthetic-read-only") {
    return {
      status: "ready" as const,
      inventory: { vaultId: expectedVaultId, packages: [], recoveryNotices: [] },
    };
  }
  const vaultPath = workspaceController.vaultPath;
  const packages = await themePackageManager.getManagedPackages(vaultPath, expectedVaultId);
  const recoveryNotices = themePackageManager.takeRecoveryNotices(expectedVaultId);
  if (
    workspaceController.vaultId !== expectedVaultId ||
    workspaceController.vaultPath !== vaultPath
  ) {
    return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
  }
  return {
    status: "ready" as const,
    inventory: { vaultId: expectedVaultId, packages, recoveryNotices },
  };
}

async function currentPluginCatalog(expectedVaultId: string): Promise<PluginCatalogResponse> {
  if (workspaceController.vaultId !== expectedVaultId) {
    return { status: "stale-vault", vaultId: workspaceController.vaultId };
  }
  const vaultPath = workspaceController.vaultPath;
  const managedPackages = await pluginPackageManager.getManagedPackages(vaultPath, expectedVaultId);
  const blockedPluginIds = new Set(
    managedPackages
      .filter((managed) => managed.integrity === "changed")
      .map((managed) => managed.pluginId),
  );
  const authoritySession = pluginConstructionAuthoritySessions.get(expectedVaultId);
  const catalog = await loadVaultPluginCatalog({
    vaultPath,
    vaultId: expectedVaultId,
    preference: settingsController.getVaultPlugins(expectedVaultId),
    safeMode: pluginSafeMode(),
    blockedPluginIds,
    resolveConstructionAuthority: authoritySession
      ? (plugin, legacyState) =>
          resolvePluginCatalogAuthority(authoritySession, plugin, legacyState)
      : async () => ({ grantState: "unavailable", stylesheetPath: null }),
  });
  catalog.managedPackages = managedPackages;
  catalog.warnings.unshift(...pluginPackageManager.takeRecoveryNotices(expectedVaultId));
  if (
    workspaceController.vaultId !== expectedVaultId ||
    workspaceController.vaultPath !== vaultPath
  ) {
    return { status: "stale-vault", vaultId: workspaceController.vaultId };
  }
  await applyPluginSurfaceCss(catalog.css);
  if (
    workspaceController.vaultId !== expectedVaultId ||
    workspaceController.vaultPath !== vaultPath
  ) {
    return { status: "stale-vault", vaultId: workspaceController.vaultId };
  }
  return { status: "ready", catalog };
}

async function currentMigrationPreview(expectedVaultId: string) {
  if (workspaceController.vaultId !== expectedVaultId) {
    return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
  }
  const workspaceReady = await waitForMigrationWorkspace(expectedVaultId);
  if (!workspaceReady) {
    return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
  }
  const vaultPath = workspaceController.vaultPath;
  const recoveryNotices = migrationTransactionManager
    ? await migrationTransactionManager.recover(expectedVaultId, () =>
        currentMigrationState(expectedVaultId),
      )
    : [];
  const current = await currentMigrationState(expectedVaultId);
  const preview = await loadObsidianMigrationPreview({
    vaultPath,
    vaultId: expectedVaultId,
    selectedPluginIds: settingsController.getVaultPlugins(expectedVaultId).enabledPluginIds,
    capabilityGrantsByPlugin:
      settingsController.getVaultPlugins(expectedVaultId).capabilityGrantsByPlugin,
  });
  preview.warnings.unshift(
    ...(migrationStartupNotices.get(expectedVaultId) ?? []).map((notice) => notice.message),
    ...recoveryNotices.map((notice) => notice.message),
  );
  const plan = buildMigrationPlan(preview, current);
  if (
    workspaceController.vaultId !== expectedVaultId ||
    workspaceController.vaultPath !== vaultPath
  ) {
    return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
  }
  return {
    status: "ready",
    preview,
    plan,
    rollbackTransactionId: migrationTransactionManager
      ? await migrationTransactionManager.latestRollbackTransaction(expectedVaultId)
      : null,
  } as const;
}

async function waitForMigrationWorkspace(expectedVaultId: string): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (workspaceController.vaultId !== expectedVaultId) {
      return false;
    }
    const snapshot = await workspaceController.getSnapshot();
    if (!snapshot.startup) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Cannot read workspace migration state while vault is still opening.");
}

async function currentMigrationState(expectedVaultId: string): Promise<MigrationPrivateState> {
  if (workspaceController?.vaultId === expectedVaultId) {
    return {
      settings: settingsController.getSnapshot().settings,
      workspace: await workspaceController.getWorkspaceState(expectedVaultId),
    };
  }
  return {
    settings: settingsController.getSnapshot().settings,
    workspace: await workspaceStateStore.load(expectedVaultId),
  };
}

function parseMigrationApplyRequest(value: unknown): MigrationApplyRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    !("planId" in value) ||
    !("sourceDigest" in value) ||
    !("selectedItemIds" in value) ||
    typeof value.planId !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.planId) ||
    typeof value.sourceDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sourceDigest) ||
    !Array.isArray(value.selectedItemIds) ||
    value.selectedItemIds.length > 512 ||
    value.selectedItemIds.some((item) => typeof item !== "string" || item.length > 300)
  ) {
    throw new Error("Migration apply requires a bounded reviewed plan and item selection.");
  }
  return {
    planId: value.planId,
    sourceDigest: value.sourceDigest,
    selectedItemIds: [...value.selectedItemIds],
  };
}

async function reconcileCompatibilityPlugins(
  expectedVaultId: string,
  forceReload = false,
  reloadPluginId?: string,
  requestedConstructionPath?: PluginConstructionPath,
) {
  if (workspaceController.vaultId !== expectedVaultId) {
    throw new Error("The active vault changed before plugin reconciliation.");
  }
  const vaultPath = workspaceController.vaultPath;
  const preference = settingsController.getVaultPlugins(expectedVaultId);
  const discovery = await discoverVaultPlugins(vaultPath);
  const managedPackages = await pluginPackageManager.getManagedPackages(vaultPath, expectedVaultId);
  const changedManagedIds = new Set(
    managedPackages
      .filter((managed) => managed.integrity === "changed")
      .map((managed) => managed.pluginId),
  );
  const packagesById = new Map(discovery.plugins.map((plugin) => [plugin.summary.id, plugin]));
  const pluginsAllowed = preference.compatibilityMode === "enabled" && !pluginSafeMode();
  const targetIds = new Set<string>();
  const constructionRequests = new Map<string, PluginConstructionRequest>();
  const authoritySession = pluginsAllowed
    ? activePluginConstructionAuthoritySession(expectedVaultId)
    : null;
  if (pluginsAllowed) {
    if (!authoritySession) {
      throw new Error("Plugin construction authority is unavailable for the active vault.");
    }
    for (const pluginId of preference.enabledPluginIds) {
      const installed = packagesById.get(pluginId);
      const report = installed?.summary.capabilityReport;
      if (
        changedManagedIds.has(pluginId) ||
        installed?.summary.packageState !== "ready" ||
        !report ||
        !pluginCapabilityGrantMatches(report, preference.capabilityGrantsByPlugin[pluginId])
      ) {
        continue;
      }
      const reloadThisPlugin = forceReload && (!reloadPluginId || reloadPluginId === pluginId);
      const constructionPath =
        requestedConstructionPath ?? (reloadThisPlugin ? "explicit-reload" : "first-load");
      try {
        const request = await preparePluginConstructionRequest(
          authoritySession,
          installed,
          constructionPath,
        );
        if ((await authoritySession.grantState(request, "granted")) !== "granted") {
          continue;
        }
        targetIds.add(pluginId);
        constructionRequests.set(pluginId, request);
      } catch (error) {
        console.error(
          `Plugin construction authority for ${pluginId} could not be verified.`,
          error,
        );
      }
    }
  }

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
    const request = constructionRequests.get(pluginId);
    if (!request) {
      continue;
    }
    const runtimePlugin = (snapshot.plugins ?? []).find((plugin) => plugin.id === pluginId);
    const reloadThisPlugin = forceReload && (!reloadPluginId || reloadPluginId === pluginId);
    if (runtimePlugin?.state === "loaded" && !reloadThisPlugin) {
      continue;
    }
    if (reloadPluginId && reloadPluginId !== pluginId) {
      continue;
    }
    try {
      snapshot = await workspaceController.loadPlugin(request);
    } catch (error) {
      if (isFatalPluginRuntimeError(error)) {
        throw error;
      }
      const code = isPluginConstructionRefusal(error)
        ? error.code
        : (attachedPluginDiagnosticCode(error) ?? "runtime-load-failed");
      console.error(`Plugin construction for ${pluginId} stopped [${code}].`);
      snapshot = await workspaceController.getSnapshot();
    }
  }

  if (
    workspaceController.vaultId !== expectedVaultId ||
    workspaceController.vaultPath !== vaultPath
  ) {
    throw new Error("The active vault changed during plugin reconciliation.");
  }
  try {
    snapshot = await workspaceController.markPluginLayoutReady();
  } catch {
    snapshot = await workspaceController.getSnapshot();
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

async function updateCompatibilitySettings(
  expectedVaultId: string,
  nextSettings: VaultPluginSettings,
): Promise<PluginUpdateResponse> {
  if (workspaceController.vaultId !== expectedVaultId) {
    return { status: "stale-vault", vaultId: workspaceController.vaultId };
  }
  const previousTrustedWorkspace = trustedWorkspaceEnabledForVault(expectedVaultId);
  const nextTrustedWorkspace = trustedWorkspaceEnabledForPreference(nextSettings);
  const operation = async (): Promise<PluginUpdateResponse> => {
    if (previousTrustedWorkspace !== nextTrustedWorkspace) {
      await requestWindowAutosaveFlush(mainWindow, "vault-switch");
    }
    const settings = await settingsController.setVaultPlugins(expectedVaultId, nextSettings);
    if (previousTrustedWorkspace !== nextTrustedWorkspace) {
      const vaultPath = workspaceController.vaultPath;
      const opened = await workspaceController.switchVault(vaultPath);
      if (opened.vault.mode === "kernel-backed" && opened.vault.id) {
        await themePackageManager.recoverVault(workspaceController.vaultPath, opened.vault.id);
      }
    }
    return pluginUpdateResponse(expectedVaultId, settings);
  };

  if (previousTrustedWorkspace === nextTrustedWorkspace) {
    return operation();
  }

  mainWorkspaceTransition = Promise.resolve();
  const transition = operation();
  const settledTransition = transition.then(
    () => undefined,
    () => undefined,
  );
  mainWorkspaceTransition = settledTransition;
  try {
    return await transition;
  } finally {
    if (mainWorkspaceTransition === settledTransition) {
      mainWorkspaceTransition = null;
    }
  }
}

async function createWorkspaceController(): Promise<WorkspaceController> {
  const configuredPath = readDevelopmentVaultPath(app.isPackaged, process.env);
  const fixtureVaultPath = app.isPackaged
    ? join(process.resourcesPath, "bundled-vault")
    : join(app.getAppPath(), "fixtures", "vaults", "basic");
  const userDataPath = app.getPath("userData");
  return WorkspaceController.open({
    fixtureVaultPath,
    stateRoot: new FixedStateRoot(userDataPath),
    selectionStore: new FileVaultSelectionStore(join(userDataPath, "workspace-selection.json")),
    workspaceStateStore,
    ...(workspaceOpenDiagnostics ? { diagnostics: workspaceOpenDiagnostics } : {}),
    beforeWorkspaceStateRestore: async (vaultId) => {
      const recoveryNotices = migrationTransactionManager
        ? await migrationTransactionManager.recover(vaultId, () => currentMigrationState(vaultId))
        : [];
      if (recoveryNotices.length > 0) {
        migrationStartupNotices.set(vaultId, recoveryNotices);
      }
    },
    workspaceSettingsForVault: (vaultId) => settingsController.getVaultWorkspaceSettings(vaultId),
    pluginRuntimeFactory: async (vaultPath, actions, vault) => {
      // Safe mode is a process recovery boundary. It must not depend on the hidden compatibility
      // renderer that the user is explicitly bypassing to regain access to the vault.
      if (pluginSafeMode()) {
        if (!vault) {
          throw new Error("Plugin safe mode requires the kernel vault port.");
        }
        return new PluginHost(vaultPath, vault, actions, undefined, vault);
      }
      const pluginOperationTimeout = developmentPluginOperationTimeout();
      const canonicalVaultPath = await fs.realpath(vaultPath);
      const vaultIdentityPath =
        process.platform === "win32" ? canonicalVaultPath.toLowerCase() : canonicalVaultPath;
      const vaultId = createHash("sha256").update(vaultIdentityPath).digest("hex");
      const authoritySession = await pluginConstructionAuthorityStore.activateVault(
        vaultId,
        canonicalVaultPath,
        pluginSafeMode(),
      );
      pluginConstructionAuthoritySessions.set(vaultId, authoritySession);
      const constructionPolicyResolver = new PluginConstructionPolicyResolver({
        readAuthoritySnapshot: (request) => authoritySession.readAuthoritySnapshot(request),
      });
      const trustedWorkspace = trustedWorkspaceEnabledForVault(vaultId);
      await ensureMainWindowTopology(trustedWorkspace, trustedWorkspace);
      if (trustedWorkspace) {
        if (!vault) {
          throw new Error("Trusted workspace compatibility requires the kernel read port.");
        }
        activeTrustedWorkspaceReadPort = {
          vaultPath,
          getName: () => vault.getName(),
          listMarkdownPaths: (relativeDirectory) => vault.listMarkdownPaths(relativeDirectory),
          readText: (relativePath) => vault.readText(relativePath),
        };
        if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
          throw new Error("Trusted workspace compatibility requires a live main renderer.");
        }
        try {
          const runtime = await TrustedWorkspacePluginRuntime.open(mainWindow.webContents, {
            attachTrustedPackageFiles,
            constructionPolicyResolver,
            hostFactoryPath: join(__dirname, "trusted-plugin-host.cjs"),
            packageJsonPath: join(app.getAppPath(), "package.json"),
            vaultPath,
            ...(pluginOperationTimeout ? { operationTimeoutMs: pluginOperationTimeout } : {}),
          });
          activeTrustedWorkspaceRuntime = runtime;
          return runtime;
        } catch (error) {
          activeTrustedWorkspaceReadPort = null;
          throw error;
        }
      }
      activeTrustedWorkspaceRuntime = null;
      activeTrustedWorkspaceReadPort = null;
      const managedPackages = await pluginPackageManager.getManagedPackages(vaultPath, vaultId);
      const blockedPluginIds = new Set(
        managedPackages
          .filter((managed) => managed.integrity === "changed")
          .map((managed) => managed.pluginId),
      );
      const appearance = await loadVaultAppearance({
        vaultPath,
        vaultId,
        preference: settingsController.getVaultAppearance(vaultId),
        safeMode: appearanceSafeMode(),
      });
      const surfaceCatalog = await loadVaultPluginCatalog({
        vaultPath,
        vaultId,
        preference: settingsController.getVaultPlugins(vaultId),
        safeMode: pluginSafeMode(),
        blockedPluginIds,
        resolveConstructionAuthority: (plugin, legacyState) =>
          resolvePluginCatalogAuthority(authoritySession, plugin, legacyState),
      });
      pluginSurfaceAppearanceCss = appearance.css;
      pluginSurfaceCss = surfaceCatalog.css;
      const pluginSurfaceEnvironmentBridge = createPluginSurfaceEnvironmentBridge();
      pluginSurfaceEnvironmentBridge.setSources({
        appearanceCss: appearance.css,
        pluginCss: surfaceCatalog.css,
      });
      pluginSurfaceEnvironmentBridges.set(vaultId, pluginSurfaceEnvironmentBridge);
      const isolatedRuntime = await IsolatedPluginRuntime.open({
        create: () =>
          RecoveringPluginRuntime.open({
            create: () =>
              ElectronPluginRuntime.open({
                hostHtmlPath: join(__dirname, "..", "renderer", "plugin-host.html"),
                constructionPolicyResolver,
                onSurfaceVisibilityChange: setPluginViewVisibility,
                packageJsonPath: join(app.getAppPath(), "package.json"),
                vaultPath,
                ...(pluginOperationTimeout ? { operationTimeoutMs: pluginOperationTimeout } : {}),
              }),
            describePlugin: async (pluginDirectory) => {
              const discovery = await discoverVaultPlugins(vaultPath);
              const installed = discovery.plugins.find(
                (plugin) => plugin.directoryPath === pluginDirectory,
              );
              return installed
                ? {
                    id: installed.summary.id,
                    name: installed.summary.name,
                    version: installed.summary.version,
                    stylesheetDiscovered: installed.summary.stylesheetDiscovered,
                  }
                : null;
            },
            onRuntimeChange: async (runtime) => registerCompatibilityPluginView(runtime),
          }),
      });
      try {
        await pluginSurfaceEnvironmentBridge.register(
          {
            id: `runtime:${vaultId}`,
            isDestroyed: () => isolatedRuntime.isClosed(),
            applyEnvironment: (environment) => isolatedRuntime.applyEnvironment(environment),
          },
          { vaultId, vaultGeneration: authoritySession.vaultGeneration },
        );
      } catch (error) {
        await isolatedRuntime.close().catch(() => undefined);
        throw error;
      }
      return isolatedRuntime;
    },
    deferInitialVault: true,
    ...(configuredPath ? { configuredVaultPath: configuredPath } : {}),
  });
}

async function activateInitialWorkspace(): Promise<void> {
  return serializePrivateMutation(async () => {
    initialWorkspaceRecoveryPending = true;
    try {
      const outcome = await workspaceController.activateDeferredInitialVault();
      if (outcome.status === "superseded") {
        return;
      }
      const expectedVaultId = outcome.snapshot.vault.id;
      if (!expectedVaultId || workspaceController.vaultId !== expectedVaultId) {
        return;
      }
      if (outcome.snapshot.vault.mode === "kernel-backed") {
        await themePackageManager.recoverVault(workspaceController.vaultPath, expectedVaultId);
      }
      const recoveryNotices = migrationTransactionManager
        ? await migrationTransactionManager.recover(expectedVaultId, () =>
            currentMigrationState(expectedVaultId),
          )
        : [];
      if (recoveryNotices.length > 0) {
        migrationStartupNotices.set(expectedVaultId, recoveryNotices);
      }
      const startupRecoveryNotices = migrationStartupNotices.get(expectedVaultId) ?? [];
      if (
        ![...startupRecoveryNotices, ...recoveryNotices].some(
          (notice) => notice.status === "conflict",
        )
      ) {
        await reconcileCompatibilityPlugins(
          expectedVaultId,
          false,
          undefined,
          "app-restart-reconstruction",
        );
      }
    } finally {
      initialWorkspaceRecoveryPending = false;
      broadcastWorkspaceSnapshot(await workspaceController.getSnapshot());
    }
  });
}

function startInitialWorkspaceActivation(): void {
  if (initialWorkspaceActivation) {
    return;
  }
  initialWorkspaceActivation = activateInitialWorkspace().catch((error: unknown) => {
    console.error("Initial vault activation failed", error);
  });
}

async function createAppUpdateController(): Promise<AppUpdateController> {
  const currentVersion = app.getVersion();
  const disabledReason = appUpdateDisabledReason({
    isPackaged: app.isPackaged,
    platform: process.platform,
    updateTrust: readPackageUpdateTrust(app.getAppPath()),
  });
  if (disabledReason) {
    return new AppUpdateController({ currentVersion, disabledReason });
  }
  try {
    const { createElectronUpdateProvider } = await import("./electron-update-provider");
    return new AppUpdateController({
      currentVersion,
      provider: createElectronUpdateProvider(),
      reportError: (error) => console.error("Threadleaf update operation failed:", error),
    });
  } catch (error) {
    console.error("Threadleaf update service initialization failed:", error);
    return new AppUpdateController({ currentVersion, disabledReason: "updater-unavailable" });
  }
}

function registerIpcHandlers(): void {
  handleMainRendererIpc(ipcChannels.exportSupportBundle, (event) => {
    if (!isMainRendererSender(event.sender)) {
      throw new Error("Support bundle export requires the active Threadleaf window.");
    }
    return exportSupportBundle();
  });
  handleMainRendererIpc(ipcChannels.publishNote, (event, value: unknown) => {
    if (!isMainRendererSender(event.sender)) {
      throw new Error("Published-note export requires the active Threadleaf window.");
    }
    return exportPublishedNote(value);
  });
  handleMainRendererIpc(ipcChannels.appUpdate, () => appUpdateController.getSnapshot());
  handleMainRendererIpc(ipcChannels.checkForAppUpdate, () => appUpdateController.checkForUpdates());
  handleMainRendererIpc(ipcChannels.downloadAppUpdate, () => appUpdateController.downloadUpdate());
  handleMainRendererIpc(ipcChannels.installAppUpdate, () => appUpdateController.installUpdate());
  ipcMain.handle(pluginRendererChannels.vaultCreate, async (event, value: unknown) => {
    if (!isPluginRuntimeSender(event.sender)) {
      throw new Error("Plugin vault creates require the active compatibility runtime.");
    }
    const request = parsePluginVaultCreateRequest(value);
    if (resolve(request.vaultPath) !== resolve(workspaceController.vaultPath)) {
      throw new Error("The active vault changed before the plugin file could be created.");
    }
    return workspaceController.createPluginFile(
      request.filePath,
      Buffer.from(request.content, "utf8"),
      workspaceController.vaultId,
    );
  });
  ipcMain.handle(pluginRendererChannels.vaultCreateBinary, async (event, value: unknown) => {
    if (!isPluginRuntimeSender(event.sender)) {
      throw new Error("Plugin binary vault creates require the active compatibility runtime.");
    }
    const request = parsePluginVaultCreateBinaryRequest(value);
    if (resolve(request.vaultPath) !== resolve(workspaceController.vaultPath)) {
      throw new Error("The active vault changed before the plugin binary file could be created.");
    }
    return workspaceController.createPluginFile(
      request.filePath,
      new Uint8Array(request.content),
      workspaceController.vaultId,
    );
  });
  ipcMain.handle(pluginRendererChannels.vaultCreateFolder, async (event, value: unknown) => {
    if (!isPluginRuntimeSender(event.sender)) {
      throw new Error("Plugin vault folder creates require the active compatibility runtime.");
    }
    const request = parsePluginVaultCreateFolderRequest(value);
    if (resolve(request.vaultPath) !== resolve(workspaceController.vaultPath)) {
      throw new Error("The active vault changed before the plugin folder could be created.");
    }
    return workspaceController.createPluginFolder(request.folderPath, workspaceController.vaultId);
  });
  ipcMain.handle(pluginRendererChannels.vaultListMarkdownPaths, async (event, value: unknown) => {
    if (!isPluginRuntimeSender(event.sender)) {
      throw new Error("Plugin vault reads require the active compatibility runtime.");
    }
    const request = parsePluginVaultListMarkdownPathsRequest(value);
    const readPort = activeTrustedWorkspaceReadPort;
    if (!readPort || resolve(request.vaultPath) !== resolve(readPort.vaultPath)) {
      throw new Error("Plugin vault reads may target only the active vault.");
    }
    return readPort.listMarkdownPaths(request.relativeDirectory);
  });
  ipcMain.handle(pluginRendererChannels.vaultReadText, async (event, value: unknown) => {
    if (!isPluginRuntimeSender(event.sender)) {
      throw new Error("Plugin vault reads require the active compatibility runtime.");
    }
    const request = parsePluginVaultReadTextRequest(value);
    const readPort = activeTrustedWorkspaceReadPort;
    if (!readPort || resolve(request.vaultPath) !== resolve(readPort.vaultPath)) {
      throw new Error("Plugin vault reads may target only the active vault.");
    }
    return readPort.readText(request.filePath);
  });
  ipcMain.handle(pluginRendererChannels.vaultRename, async (event, value: unknown) => {
    if (!isPluginRuntimeSender(event.sender)) {
      throw new Error("Plugin vault renames require the active compatibility runtime.");
    }
    const request = parsePluginVaultRenameRequest(value);
    if (resolve(request.vaultPath) !== resolve(workspaceController.vaultPath)) {
      throw new Error("The active vault changed before the plugin file could be renamed.");
    }
    return workspaceController.renamePluginFile(
      request.sourcePath,
      request.targetPath,
      request.expectedRevision,
      workspaceController.vaultId,
    );
  });
  ipcMain.handle(pluginRendererChannels.vaultTrash, async (event, value: unknown) => {
    if (!isPluginRuntimeSender(event.sender)) {
      throw new Error("Plugin vault trash requires the active compatibility runtime.");
    }
    const request = parsePluginVaultTrashRequest(value);
    if (resolve(request.vaultPath) !== resolve(workspaceController.vaultPath)) {
      throw new Error("The active vault changed before the plugin file could be moved to trash.");
    }
    return workspaceController.trashPluginFile(
      request.filePath,
      request.expectedRevision,
      workspaceController.vaultId,
    );
  });
  ipcMain.handle(pluginRendererChannels.vaultWrite, async (event, value: unknown) => {
    if (!isPluginRuntimeSender(event.sender)) {
      throw new Error("Plugin vault writes require the active compatibility runtime.");
    }
    const request = parsePluginVaultWriteRequest(value);
    if (resolve(request.vaultPath) !== resolve(workspaceController.vaultPath)) {
      throw new Error("The active vault changed before the plugin edit could be saved.");
    }
    return workspaceController.writePluginFile(
      request.filePath,
      Buffer.from(request.content, "utf8"),
      request.expectedRevision,
      workspaceController.vaultId,
    );
  });
  ipcMain.handle(pluginRendererChannels.vaultWriteBinary, async (event, value: unknown) => {
    if (!isPluginRuntimeSender(event.sender)) {
      throw new Error("Plugin binary vault writes require the active compatibility runtime.");
    }
    const request = parsePluginVaultWriteBinaryRequest(value);
    if (resolve(request.vaultPath) !== resolve(workspaceController.vaultPath)) {
      throw new Error("The active vault changed before the plugin binary edit could be saved.");
    }
    return workspaceController.writePluginFile(
      request.filePath,
      new Uint8Array(request.content),
      request.expectedRevision,
      workspaceController.vaultId,
    );
  });
  handleMainRendererIpc(ipcChannels.snapshot, async () => {
    if (initialWorkspaceRecoveryPending && initialWorkspaceActivation) {
      await initialWorkspaceActivation;
    }
    const transitions = [mainWorkspaceTransition, mainRendererRecovery].filter(
      (value): value is Promise<void> => value !== null,
    );
    await Promise.all(transitions);
    const snapshot = await workspaceSnapshotWithLayout(await workspaceController.getSnapshot());
    return workspaceOpenTransferTracker ? workspaceOpenTransferTracker.prepare(snapshot) : snapshot;
  });
  ipcMain.on(ipcChannels.workspaceOpenDiagnostics, (event, value: unknown) => {
    if (!isMainRendererSender(event.sender) || !workspaceOpenTransferTracker) {
      return;
    }
    if (
      typeof value !== "object" ||
      value === null ||
      !("phase" in value) ||
      !("transferId" in value) ||
      (value.phase !== "received" && value.phase !== "rendered") ||
      typeof value.transferId !== "number" ||
      (value.phase === "rendered" &&
        (!("durationMs" in value) ||
          typeof value.durationMs !== "number" ||
          !("objectCount" in value) ||
          typeof value.objectCount !== "number"))
    ) {
      return;
    }
    const acknowledgement = value as WorkspaceOpenTransferAcknowledgement;
    if (!workspaceOpenTransferTracker.acknowledge(acknowledgement)) {
      return;
    }
    if (acknowledgement.phase === "rendered" && workspaceOpenDiagnostics) {
      console.info(
        `THREADLEAF_WORKSPACE_OPEN_DIAGNOSTICS ${JSON.stringify(workspaceOpenDiagnostics.snapshot())}`,
      );
    }
  });
  handleMainRendererIpc(ipcChannels.workspaceLayout, async (event, expectedVaultId: unknown) => {
    if (!isMainRendererSender(event.sender)) {
      throw new Error("Workspace layout loading requires the active Threadleaf window.");
    }
    if (expectedVaultId !== undefined && typeof expectedVaultId !== "string") {
      throw new Error("Workspace layout loading requires an optional vault identity.");
    }
    if (typeof expectedVaultId === "string" && workspaceController.vaultId !== expectedVaultId) {
      throw new Error("The active vault changed before the workspace layout could be read.");
    }
    return workspaceLayoutController.snapshot();
  });
  handleMainRendererIpc(ipcChannels.workspaceFilePage, (event, request: unknown) => {
    if (!isMainRendererSender(event.sender)) {
      throw new Error("Workspace file pages require the active Threadleaf window.");
    }
    if (typeof request !== "object" || request === null) {
      throw new Error("Workspace file pages require a page request.");
    }
    return workspaceController.getWorkspaceFilePage(
      request as Parameters<WorkspaceController["getWorkspaceFilePage"]>[0],
    );
  });
  handleMainRendererIpc(ipcChannels.workspaceTreePage, (event, request: unknown) => {
    if (!isMainRendererSender(event.sender)) {
      throw new Error("Workspace tree pages require the active Threadleaf window.");
    }
    if (typeof request !== "object" || request === null) {
      throw new Error("Workspace tree pages require a page request.");
    }
    return workspaceController.getWorkspaceTreePage(
      request as Parameters<WorkspaceController["getWorkspaceTreePage"]>[0],
    );
  });
  handleMainRendererIpc(ipcChannels.workspaceTreePath, (event, request: unknown) => {
    if (!isMainRendererSender(event.sender)) {
      throw new Error("Workspace tree paths require the active Threadleaf window.");
    }
    if (typeof request !== "object" || request === null) {
      throw new Error("Workspace tree paths require a path request.");
    }
    return workspaceController.getWorkspaceTreePath(
      request as Parameters<WorkspaceController["getWorkspaceTreePath"]>[0],
    );
  });
  handleMainRendererIpc(ipcChannels.workspaceTagCatalog, (event, request: unknown) => {
    if (!isMainRendererSender(event.sender)) {
      throw new Error("Workspace tags require the active Threadleaf window.");
    }
    if (typeof request !== "object" || request === null) {
      throw new Error("Workspace tags require a catalog request.");
    }
    return workspaceController.getWorkspaceTagCatalog(
      request as Parameters<WorkspaceController["getWorkspaceTagCatalog"]>[0],
    );
  });
  handleMainRendererIpc(
    ipcChannels.setWorkspaceDockCollapsed,
    (event, dockId: unknown, collapsed: unknown, expectedVaultId: unknown) => {
      if (!isMainRendererSender(event.sender)) {
        throw new Error("Dock updates require the active Threadleaf window.");
      }
      if (
        (dockId !== "left" && dockId !== "right") ||
        typeof collapsed !== "boolean" ||
        typeof expectedVaultId !== "string"
      ) {
        throw new Error(
          "Dock updates require a left or right dock, boolean state, and vault identity.",
        );
      }
      return workspaceLayoutController
        .setDockCollapsed(dockId, collapsed, expectedVaultId)
        .then((snapshot) => snapshot);
    },
  );
  handleMainRendererIpc(
    ipcChannels.setWorkspaceNavigatorExpandedPaths,
    (event, paths: unknown, expectedVaultId: unknown) => {
      if (!isMainRendererSender(event.sender)) {
        throw new Error("Navigator updates require the active Threadleaf window.");
      }
      if (
        !Array.isArray(paths) ||
        !paths.every((candidate) => typeof candidate === "string") ||
        typeof expectedVaultId !== "string"
      ) {
        throw new Error("Navigator updates require string paths and a vault identity.");
      }
      return workspaceLayoutController
        .setNavigatorExpandedPaths(paths, expectedVaultId)
        .then((snapshot) => snapshot);
    },
  );
  handleMainRendererIpc(ipcChannels.popOutPluginView, (event, expectedVaultId: unknown) => {
    assertMainRendererPluginIpcSender(isMainRendererSender(event.sender), "Plugin pop-outs");
    if (typeof expectedVaultId !== "string") {
      throw new Error("Popping out a plugin view requires a vault identity.");
    }
    return popOutPluginView(expectedVaultId);
  });
  handleMainRendererIpc(ipcChannels.reattachPluginView, (event, expectedVaultId: unknown) => {
    assertMainRendererPluginIpcSender(
      isMainRendererSender(event.sender),
      "Plugin pop-out reattachment",
    );
    if (typeof expectedVaultId !== "string") {
      throw new Error("Reattaching a plugin view requires a vault identity.");
    }
    return reattachPluginView(expectedVaultId);
  });
  ipcMain.on(ipcChannels.startupShellReady, (event) => {
    if (
      !mainWindow ||
      mainWindow.isDestroyed() ||
      mainWindow.webContents.isDestroyed() ||
      event.sender !== mainWindow.webContents
    ) {
      return;
    }
    startInitialWorkspaceActivation();
  });
  ipcMain.on(ipcChannels.completeAutosaveFlush, (event, value: unknown) => {
    if (!isMainRendererSender(event.sender)) {
      return;
    }
    try {
      rendererAutosaveFlush.complete(event.sender.id, parseAutosaveFlushResult(value));
    } catch (error) {
      console.error("Rejected malformed renderer autosave acknowledgement:", error);
    }
  });
  handleMainRendererIpc(ipcChannels.settings, async () => {
    const delay = developmentSettingsDelay();
    if (delay !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return settingsController.getSnapshot();
  });
  handleMainRendererIpc(ipcChannels.accessibilityPreferences, () =>
    accessibilityPreferencesController.getSnapshot(),
  );
  handleMainRendererIpc(ipcChannels.setAccessibilityPreferences, async (_event, value: unknown) => {
    const preferences = parseAccessibilityPreferences(value);
    return serializePrivateMutation(() =>
      accessibilityPreferencesController.setPreferences(preferences),
    );
  });
  handleMainRendererIpc(ipcChannels.resetAccessibilityPreferences, async () => {
    return serializePrivateMutation(() => accessibilityPreferencesController.reset());
  });
  handleMainRendererIpc(ipcChannels.appearance, (_event, expectedVaultId: unknown) => {
    if (typeof expectedVaultId !== "string") {
      throw new Error("Appearance loading requires a string vault identity.");
    }
    return currentAppearance(expectedVaultId);
  });
  handleMainRendererIpc(
    ipcChannels.setVaultAppearance,
    async (_event, expectedVaultId: unknown, appearanceValue: unknown) => {
      if (typeof expectedVaultId !== "string") {
        throw new Error("Appearance updates require a string vault identity.");
      }
      const appearance = parseVaultAppearanceSettings(appearanceValue);
      return serializePrivateMutation(async () => {
        if (workspaceController.vaultId !== expectedVaultId) {
          return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
        }
        const settings = await settingsController.setVaultAppearance(expectedVaultId, appearance);
        const response = await currentAppearance(expectedVaultId);
        return response.status === "ready"
          ? { status: "updated", settings, appearance: response.appearance }
          : response;
      });
    },
  );
  handleMainRendererIpc(ipcChannels.appearancePackages, (_event, expectedVaultId: unknown) => {
    if (typeof expectedVaultId !== "string") {
      throw new Error("Appearance package inventory requires a string vault identity.");
    }
    return serializePluginOperation(() => currentAppearancePackages(expectedVaultId));
  });
  handleMainRendererIpc(
    ipcChannels.previewAppearancePackage,
    (_event, expectedVaultId: unknown, requestValue: unknown) => {
      if (typeof expectedVaultId !== "string") {
        throw new Error("Appearance package review requires a vault identity.");
      }
      const request = parseAppearancePackagePreviewRequest(requestValue);
      return serializePluginOperation(async () => {
        if (workspaceController.vaultId !== expectedVaultId) {
          return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
        }
        const activeSnapshot = await workspaceController.getSnapshot();
        if (activeSnapshot.vault.mode === "synthetic-read-only") {
          throw new Error("Open a local vault before changing appearance packages.");
        }
        const vaultPath = workspaceController.vaultPath;
        const review = await themePackageManager.preview(vaultPath, expectedVaultId, request);
        return workspaceController.vaultId === expectedVaultId &&
          workspaceController.vaultPath === vaultPath
          ? ({ status: "ready", review } as const)
          : ({ status: "stale-vault", vaultId: workspaceController.vaultId } as const);
      });
    },
  );
  handleMainRendererIpc(
    ipcChannels.previewLocalAppearancePackage,
    (_event, expectedVaultId: unknown, kindValue: unknown) => {
      if (
        typeof expectedVaultId !== "string" ||
        (kindValue !== "theme" && kindValue !== "snippet")
      ) {
        throw new Error("Local appearance review requires a vault identity and package kind.");
      }
      const kind = kindValue as AppearancePackageKind;
      return serializePluginOperation(async () => {
        if (workspaceController.vaultId !== expectedVaultId) {
          return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
        }
        const activeSnapshot = await workspaceController.getSnapshot();
        if (activeSnapshot.vault.mode === "synthetic-read-only") {
          throw new Error("Open a local vault before changing appearance packages.");
        }
        const result = mainWindow
          ? await dialog.showOpenDialog(mainWindow, {
              title: `Choose a local ${kind} package archive`,
              buttonLabel: "Review package",
              properties: ["openFile", "dontAddToRecent"],
              filters: [
                { name: "Appearance package archives", extensions: ["zip"] },
                { name: "All files", extensions: ["*"] },
              ],
            })
          : await dialog.showOpenDialog({
              title: `Choose a local ${kind} package archive`,
              buttonLabel: "Review package",
              properties: ["openFile", "dontAddToRecent"],
              filters: [
                { name: "Appearance package archives", extensions: ["zip"] },
                { name: "All files", extensions: ["*"] },
              ],
            });
        if (result.canceled || !result.filePaths[0]) {
          return { status: "cancelled" } as const;
        }
        const vaultPath = workspaceController.vaultPath;
        const pkg = await appearancePackageSource.openLocalPackage(result.filePaths[0], kind);
        const review = await themePackageManager.previewLocal(vaultPath, expectedVaultId, pkg);
        return workspaceController.vaultId === expectedVaultId &&
          workspaceController.vaultPath === vaultPath
          ? ({ status: "ready", review } as const)
          : ({ status: "stale-vault", vaultId: workspaceController.vaultId } as const);
      });
    },
  );
  handleMainRendererIpc(
    ipcChannels.applyAppearancePackage,
    (
      _event,
      expectedVaultId: unknown,
      reviewId: unknown,
    ): Promise<AppearancePackageApplyResponse> => {
      if (typeof expectedVaultId !== "string" || typeof reviewId !== "string") {
        throw new Error("Appearance package apply requires a vault identity and review identity.");
      }
      return serializePluginOperation(async () => {
        if (workspaceController.vaultId !== expectedVaultId) {
          return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
        }
        const activeSnapshot = await workspaceController.getSnapshot();
        if (activeSnapshot.vault.mode === "synthetic-read-only") {
          throw new Error("Open a local vault before changing appearance packages.");
        }
        const vaultPath = workspaceController.vaultPath;
        const review = themePackageManager.reviewForApply(expectedVaultId, reviewId);
        const outcome = await themePackageManager.apply(
          vaultPath,
          expectedVaultId,
          review.reviewId,
        );
        const appearanceResponse = await currentAppearance(expectedVaultId);
        const inventoryResponse = await currentAppearancePackages(expectedVaultId);
        if (
          appearanceResponse.status !== "ready" ||
          inventoryResponse.status !== "ready" ||
          workspaceController.vaultId !== expectedVaultId ||
          workspaceController.vaultPath !== vaultPath
        ) {
          return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
        }
        broadcastAppearance(appearanceResponse.appearance);
        return {
          status: "updated",
          appearance: appearanceResponse.appearance,
          inventory: inventoryResponse.inventory,
          outcome,
        } as const;
      });
    },
  );
  handleMainRendererIpc(
    ipcChannels.cancelAppearancePackageReview,
    (_event, expectedVaultId: unknown, reviewId: unknown) => {
      if (typeof expectedVaultId !== "string" || typeof reviewId !== "string") {
        throw new Error("Appearance package review cancellation requires string identities.");
      }
      return serializePluginOperation(() =>
        themePackageManager.cancelReview(expectedVaultId, reviewId),
      );
    },
  );
  handleMainRendererIpc(ipcChannels.plugins, (event, expectedVaultId: unknown) => {
    assertMainRendererPluginIpcSender(isMainRendererSender(event.sender), "Plugin catalog loading");
    if (typeof expectedVaultId !== "string") {
      throw new Error("Plugin catalog loading requires a string vault identity.");
    }
    return serializePluginCatalogOperation(
      () => currentPluginCatalog(expectedVaultId),
      "package-inventory-invalid",
    );
  });
  handleMainRendererIpc(
    ipcChannels.searchPluginPackages,
    (event, expectedVaultId: unknown, query: unknown) => {
      assertMainRendererPluginIpcSender(
        isMainRendererSender(event.sender),
        "Plugin registry search",
      );
      if (typeof expectedVaultId !== "string" || typeof query !== "string") {
        throw new Error("Plugin registry search requires a vault identity and string query.");
      }
      return serializePluginCatalogOperation(async () => {
        if (workspaceController.vaultId !== expectedVaultId) {
          return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
        }
        const vaultPath = workspaceController.vaultPath;
        const index = await pluginPackageManager.search(vaultPath, expectedVaultId, query);
        return workspaceController.vaultId === expectedVaultId &&
          workspaceController.vaultPath === vaultPath
          ? ({ status: "ready", index } as const)
          : ({ status: "stale-vault", vaultId: workspaceController.vaultId } as const);
      }, "registry-index-invalid");
    },
  );
  handleMainRendererIpc(
    ipcChannels.previewPluginPackage,
    (event, expectedVaultId: unknown, requestValue: unknown) => {
      assertMainRendererPluginIpcSender(
        isMainRendererSender(event.sender),
        "Plugin package review",
      );
      if (typeof expectedVaultId !== "string") {
        throw new Error("Plugin package review requires a vault identity.");
      }
      const request = parsePluginPackagePreviewRequest(requestValue);
      return serializePluginCatalogOperation(
        async () => {
          if (workspaceController.vaultId !== expectedVaultId) {
            return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
          }
          const activeSnapshot = await workspaceController.getSnapshot();
          if (activeSnapshot.vault.mode === "synthetic-read-only") {
            throw new Error("Open a local vault before changing plugin packages.");
          }
          const vaultPath = workspaceController.vaultPath;
          const review = await pluginPackageManager.preview(vaultPath, expectedVaultId, request);
          return workspaceController.vaultId === expectedVaultId &&
            workspaceController.vaultPath === vaultPath
            ? ({ status: "ready", review } as const)
            : ({ status: "stale-vault", vaultId: workspaceController.vaultId } as const);
        },
        "package-operation-failed",
        { pluginId: request.pluginId },
      );
    },
  );
  handleMainRendererIpc(
    ipcChannels.applyPluginPackage,
    (event, expectedVaultId: unknown, reviewId: unknown): Promise<PluginPackageApplyResponse> => {
      assertMainRendererPluginIpcSender(isMainRendererSender(event.sender), "Plugin package apply");
      if (typeof expectedVaultId !== "string" || typeof reviewId !== "string") {
        throw new Error("Plugin package apply requires a vault identity and review identity.");
      }
      return serializePluginCatalogOperation(async () => {
        if (workspaceController.vaultId !== expectedVaultId) {
          return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
        }
        const activeSnapshot = await workspaceController.getSnapshot();
        if (activeSnapshot.vault.mode === "synthetic-read-only") {
          throw new Error("Open a local vault before changing plugin packages.");
        }
        const vaultPath = workspaceController.vaultPath;
        const review = pluginPackageManager.reviewForApply(expectedVaultId, reviewId);
        const current = settingsController.getVaultPlugins(expectedVaultId);
        const settings = await settingsController.setVaultPlugins(expectedVaultId, {
          ...current,
          enabledPluginIds: current.enabledPluginIds.filter(
            (pluginId) => pluginId !== review.pluginId,
          ),
        });
        await reconcileCompatibilityPlugins(expectedVaultId);
        if (
          workspaceController.vaultId !== expectedVaultId ||
          workspaceController.vaultPath !== vaultPath
        ) {
          return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
        }
        const outcome = await pluginPackageManager.apply(vaultPath, expectedVaultId, reviewId);
        const response = await pluginUpdateResponse(expectedVaultId, settings);
        return response.status === "updated" ? { ...response, outcome } : response;
      }, "package-operation-failed");
    },
  );
  handleMainRendererIpc(
    ipcChannels.cancelPluginPackageReview,
    (event, expectedVaultId: unknown, reviewId: unknown) => {
      assertMainRendererPluginIpcSender(
        isMainRendererSender(event.sender),
        "Plugin package review cancellation",
      );
      if (typeof expectedVaultId !== "string" || typeof reviewId !== "string") {
        throw new Error("Plugin package review cancellation requires string identities.");
      }
      return serializePluginCatalogOperation(
        () => pluginPackageManager.cancelReview(expectedVaultId, reviewId),
        "package-operation-failed",
      );
    },
  );
  handleMainRendererIpc(
    ipcChannels.setCompatibilityMode,
    (event, expectedVaultId: unknown, mode: unknown) => {
      assertMainRendererPluginIpcSender(
        isMainRendererSender(event.sender),
        "Compatibility mode changes",
      );
      if (
        typeof expectedVaultId !== "string" ||
        typeof mode !== "string" ||
        !compatibilityModes.includes(mode as CompatibilityMode)
      ) {
        throw new Error("Compatibility mode requires a vault identity and restricted or enabled.");
      }
      return serializePluginCatalogOperation(async () => {
        if (workspaceController.vaultId !== expectedVaultId) {
          return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
        }
        const current = settingsController.getVaultPlugins(expectedVaultId);
        return updateCompatibilitySettings(expectedVaultId, {
          ...current,
          compatibilityMode: mode as CompatibilityMode,
        });
      }, "package-operation-failed");
    },
  );
  handleMainRendererIpc(
    ipcChannels.setCompatibilityProfile,
    (event, expectedVaultId: unknown, profile: unknown) => {
      assertMainRendererPluginIpcSender(
        isMainRendererSender(event.sender),
        "Compatibility profile changes",
      );
      if (
        typeof expectedVaultId !== "string" ||
        typeof profile !== "string" ||
        !compatibilityProfiles.includes(profile as CompatibilityProfile)
      ) {
        throw new Error(
          "Compatibility profile requires a vault identity and off, isolated, or trusted-workspace.",
        );
      }
      return serializePluginCatalogOperation(async () => {
        if (workspaceController.vaultId !== expectedVaultId) {
          return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
        }
        const current = settingsController.getVaultPlugins(expectedVaultId);
        return updateCompatibilitySettings(
          expectedVaultId,
          applyCompatibilityProfile(current, profile as CompatibilityProfile),
        );
      }, "package-operation-failed");
    },
  );
  handleMainRendererIpc(
    ipcChannels.setPluginCapabilityGrant,
    (
      event,
      expectedVaultId: unknown,
      pluginIdValue: unknown,
      expectedBundleSha256: unknown,
      granted: unknown,
    ) => {
      assertMainRendererPluginIpcSender(
        isMainRendererSender(event.sender),
        "Plugin authority review",
      );
      if (
        typeof expectedVaultId !== "string" ||
        typeof pluginIdValue !== "string" ||
        typeof expectedBundleSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(expectedBundleSha256) ||
        typeof granted !== "boolean"
      ) {
        throw new Error(
          "Plugin authority review requires vault, plugin, exact bundle SHA-256, and decision values.",
        );
      }
      const pluginId = parsePluginId(pluginIdValue);
      return serializePluginCatalogOperation(
        async () => {
          if (workspaceController.vaultId !== expectedVaultId) {
            return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
          }
          const current = settingsController.getVaultPlugins(expectedVaultId);
          const capabilityGrantsByPlugin = { ...current.capabilityGrantsByPlugin };
          let enabledPluginIds = [...current.enabledPluginIds];
          const authoritySession = activePluginConstructionAuthoritySession(expectedVaultId);
          let constructionRequest: PluginConstructionRequest | null = null;
          if (granted) {
            const changedManagedPackage = (
              await pluginPackageManager.getManagedPackages(
                workspaceController.vaultPath,
                expectedVaultId,
              )
            ).find((managed) => managed.pluginId === pluginId && managed.integrity === "changed");
            if (changedManagedPackage) {
              throw new Error(
                `Managed plugin ${pluginId} changed after its recorded SHA-256 review and cannot receive an authority grant.`,
              );
            }
            const discovery = await discoverVaultPlugins(workspaceController.vaultPath);
            const plugin = discovery.plugins.find((candidate) => candidate.summary.id === pluginId);
            const report = plugin?.summary.capabilityReport;
            if (plugin?.summary.packageState !== "ready" || !report) {
              throw new Error(`Plugin ${pluginId} is not installed as a valid reviewable package.`);
            }
            if (report.bundleSha256 !== expectedBundleSha256) {
              throw new Error(
                `Plugin ${pluginId} changed after the authority report opened. Review the current exact bundle.`,
              );
            }
            constructionRequest = await preparePluginConstructionRequest(
              authoritySession,
              plugin,
              "first-load",
            );
            capabilityGrantsByPlugin[pluginId] = {
              bundleSha256: report.bundleSha256,
              capabilities: [...report.capabilities],
            };
          } else {
            await authoritySession.revokePlugin(pluginId);
            await workspaceController.unloadPlugin(pluginId);
            await applyPluginSurfaceCss("");
            delete capabilityGrantsByPlugin[pluginId];
            enabledPluginIds = enabledPluginIds.filter((candidate) => candidate !== pluginId);
          }
          const settings = await settingsController.setVaultPlugins(expectedVaultId, {
            ...current,
            enabledPluginIds,
            capabilityGrantsByPlugin,
          });
          if (constructionRequest) {
            await authoritySession.issueGrant(constructionRequest);
          }
          return pluginUpdateResponse(expectedVaultId, settings);
        },
        "package-operation-failed",
        { pluginId },
      );
    },
  );
  handleMainRendererIpc(
    ipcChannels.setPluginEnabled,
    (event, expectedVaultId: unknown, pluginIdValue: unknown, enabled: unknown) => {
      assertMainRendererPluginIpcSender(isMainRendererSender(event.sender), "Plugin enablement");
      if (
        typeof expectedVaultId !== "string" ||
        typeof pluginIdValue !== "string" ||
        typeof enabled !== "boolean"
      ) {
        throw new Error("Plugin enablement requires string vault and plugin values and a boolean.");
      }
      const pluginId = parsePluginId(pluginIdValue);
      return serializePluginCatalogOperation(
        async () => {
          if (workspaceController.vaultId !== expectedVaultId) {
            return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
          }
          const current = settingsController.getVaultPlugins(expectedVaultId);
          if (enabled) {
            const changedManagedPackage = (
              await pluginPackageManager.getManagedPackages(
                workspaceController.vaultPath,
                expectedVaultId,
              )
            ).find((managed) => managed.pluginId === pluginId && managed.integrity === "changed");
            if (changedManagedPackage) {
              throw new Error(
                `Managed plugin ${pluginId} changed after its recorded SHA-256 review and cannot be enabled.`,
              );
            }
            const discovery = await discoverVaultPlugins(workspaceController.vaultPath);
            const plugin = discovery.plugins.find((candidate) => candidate.summary.id === pluginId);
            if (plugin?.summary.packageState !== "ready") {
              throw new Error(`Plugin ${pluginId} is not installed as a valid package.`);
            }
            if (
              !plugin.summary.capabilityReport ||
              !pluginCapabilityGrantMatches(
                plugin.summary.capabilityReport,
                current.capabilityGrantsByPlugin[pluginId],
              )
            ) {
              throw pluginDiagnosticError("authority-grant-required", { pluginId });
            }
            const authoritySession = activePluginConstructionAuthoritySession(expectedVaultId);
            const request = await preparePluginConstructionRequest(
              authoritySession,
              plugin,
              "first-load",
            );
            if ((await authoritySession.grantState(request, "granted")) !== "granted") {
              throw pluginDiagnosticError("authority-grant-required", { pluginId });
            }
          }
          const enabledPluginIds = enabled
            ? [...new Set([...current.enabledPluginIds, pluginId])]
            : current.enabledPluginIds.filter((candidate) => candidate !== pluginId);
          const settings = await settingsController.setVaultPlugins(expectedVaultId, {
            ...current,
            enabledPluginIds,
          });
          return pluginUpdateResponse(expectedVaultId, settings);
        },
        "package-operation-failed",
        { pluginId },
      );
    },
  );
  handleMainRendererIpc(ipcChannels.reloadPlugins, (event, expectedVaultId: unknown) => {
    assertMainRendererPluginIpcSender(isMainRendererSender(event.sender), "Plugin catalog reload");
    if (typeof expectedVaultId !== "string") {
      throw new Error("Plugin reload requires a string vault identity.");
    }
    return serializePluginCatalogOperation(
      () => pluginUpdateResponse(expectedVaultId, settingsController.getSnapshot(), true),
      "package-operation-failed",
    );
  });
  handleMainRendererIpc(ipcChannels.migrationPreview, (event, expectedVaultId: unknown) => {
    if (!isMainRendererSender(event.sender)) {
      throw new Error("Migration preview requires the active Threadleaf window.");
    }
    if (typeof expectedVaultId !== "string") {
      throw new Error("Migration preview requires a string vault identity.");
    }
    return serializePluginOperation(() => currentMigrationPreview(expectedVaultId));
  });
  handleMainRendererIpc(
    ipcChannels.migrationApply,
    (event, expectedVaultId: unknown, requestValue: unknown) => {
      if (!isMainRendererSender(event.sender)) {
        throw new Error("Migration apply requires the active Threadleaf window.");
      }
      if (typeof expectedVaultId !== "string") {
        throw new Error("Migration apply requires a string vault identity.");
      }
      const request = parseMigrationApplyRequest(requestValue);
      return serializePluginOperation(async () => {
        if (workspaceController.vaultId !== expectedVaultId) {
          return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
        }
        const snapshot = await workspaceController.getSnapshot();
        if (snapshot.vault.mode === "synthetic-read-only") {
          throw new Error("Open a local vault before applying reviewed migration state.");
        }
        if (!migrationTransactionManager) {
          throw new Error("Migration transactions are not initialized.");
        }
        const firstReview = await currentMigrationPreview(expectedVaultId);
        if (firstReview.status !== "ready") {
          return firstReview;
        }
        if (request.planId !== firstReview.plan.planId) {
          throw new Error("Migration review is stale. Refresh the preview and review it again.");
        }
        const current = await currentMigrationState(expectedVaultId);
        const next = applyMigrationSelections(firstReview.plan, request, current);
        const finalReview = await currentMigrationPreview(expectedVaultId);
        if (finalReview.status !== "ready" || finalReview.plan.planId !== firstReview.plan.planId) {
          throw new Error(
            "Obsidian metadata or private state changed during review. Refresh the preview.",
          );
        }
        const reviewedVaultPath = workspaceController.vaultPath;
        const outcome = await migrationTransactionManager.apply({
          plan: finalReview.plan,
          request,
          sourceDigest: finalReview.preview.sourceDigest,
          current,
          next,
          validateReview: async () => {
            if (
              workspaceController.vaultId !== expectedVaultId ||
              reviewedVaultPath !== workspaceController.vaultPath
            ) {
              throw new Error("The active vault changed before migration commit.");
            }
            const pluginPreference = settingsController.getVaultPlugins(expectedVaultId);
            const refreshedPreview = await loadObsidianMigrationPreview({
              vaultPath: reviewedVaultPath,
              vaultId: expectedVaultId,
              selectedPluginIds: pluginPreference.enabledPluginIds,
              capabilityGrantsByPlugin: pluginPreference.capabilityGrantsByPlugin,
            });
            const refreshedCurrent = await currentMigrationState(expectedVaultId);
            const refreshedPlan = buildMigrationPlan(refreshedPreview, refreshedCurrent);
            return {
              planId: refreshedPlan.planId,
              sourceDigest: refreshedPlan.sourceDigest,
              privateStateRevision: refreshedPlan.privateStateRevision,
            };
          },
        });
        const runtimeWarnings = [
          outcome.recovered
            ? "Migration was committed and recovered after a journal hook fault. Its recovery receipt was retained."
            : null,
          outcome.before.enabledPluginIds.join("\n") === outcome.after.enabledPluginIds.join("\n")
            ? null
            : "Plugin runtime changes are intentionally deferred. Reload plugins explicitly or restart Threadleaf.",
        ].filter((warning): warning is string => warning !== null);
        return {
          status: "updated",
          settings: settingsController.getSnapshot(),
          snapshot: await workspaceController.getSnapshot(),
          outcome,
          runtimeWarning: runtimeWarnings.length > 0 ? runtimeWarnings.join(" ") : null,
        } as const;
      });
    },
  );
  handleMainRendererIpc(
    ipcChannels.migrationRollback,
    (event, expectedVaultId: unknown, transactionId: unknown) => {
      if (!isMainRendererSender(event.sender)) {
        throw new Error("Migration rollback requires the active Threadleaf window.");
      }
      if (typeof expectedVaultId !== "string" || typeof transactionId !== "string") {
        throw new Error("Migration rollback requires vault and transaction identities.");
      }
      return serializePluginOperation(async () => {
        if (workspaceController.vaultId !== expectedVaultId) {
          return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
        }
        if (!migrationTransactionManager) {
          throw new Error("Migration transactions are not initialized.");
        }
        const current = await currentMigrationState(expectedVaultId);
        const outcome = await migrationTransactionManager.rollback(
          expectedVaultId,
          transactionId,
          current,
        );
        if (outcome.status === "conflict") {
          return { status: "conflict", outcome } as const;
        }
        const runtimeWarning =
          outcome.before.enabledPluginIds.join("\n") === outcome.after.enabledPluginIds.join("\n")
            ? null
            : "Plugin runtime changes are intentionally deferred. Reload plugins explicitly or restart Threadleaf.";
        return {
          status: "updated",
          settings: settingsController.getSnapshot(),
          snapshot: await workspaceController.getSnapshot(),
          outcome,
          runtimeWarning,
        } as const;
      });
    },
  );
  handleMainRendererIpc(ipcChannels.searchVault, (_event, query: unknown) => {
    if (typeof query !== "string") {
      throw new Error("Vault search requires a string query.");
    }
    return workspaceController.searchVault(query);
  });
  handleMainRendererIpc(
    ipcChannels.vaultGraph,
    (_event, requestValue: unknown, expectedVaultId: unknown) => {
      if (typeof expectedVaultId !== "string") {
        throw new Error("Vault graph requires a string vault identity.");
      }
      return workspaceController.getVaultGraph(
        parseVaultGraphRequest(requestValue),
        expectedVaultId,
      );
    },
  );
  handleMainRendererIpc(ipcChannels.vaultTrash, (_event, expectedVaultId: unknown) => {
    if (typeof expectedVaultId !== "string") {
      throw new Error("Vault trash inspection requires a string vault identity.");
    }
    return workspaceController.getVaultTrash(expectedVaultId);
  });
  handleMainRendererIpc(
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
  handleMainRendererIpc(
    ipcChannels.loadVaultAttachment,
    (_event, sourceNotePath: unknown, target: unknown, expectedVaultId: unknown) => {
      if (
        typeof sourceNotePath !== "string" ||
        typeof target !== "string" ||
        typeof expectedVaultId !== "string"
      ) {
        throw new Error("Load vault attachment requires string note, target, and vault values.");
      }
      return workspaceController.loadVaultAttachment(sourceNotePath, target, expectedVaultId);
    },
  );
  handleMainRendererIpc(ipcChannels.vaultAttachmentNativeAction, (event, request: unknown) => {
    if (!isMainRendererSender(event.sender)) {
      throw new Error("Native attachment actions are available only to the owned main renderer.");
    }
    if (
      typeof request !== "object" ||
      request === null ||
      !("action" in request) ||
      (request.action !== "open" && request.action !== "reveal") ||
      !("path" in request) ||
      typeof request.path !== "string" ||
      !("expectedRevision" in request) ||
      typeof request.expectedRevision !== "string" ||
      !("expectedVaultId" in request) ||
      typeof request.expectedVaultId !== "string"
    ) {
      throw new Error(
        "Native attachment action requires typed action, path, revision, and vault values.",
      );
    }
    const vaultId = workspaceController.vaultId;
    const vaultPath = workspaceController.vaultPath;
    return performVaultAttachmentNativeAction(
      {
        vaultId,
        vaultPath,
        getActiveVault: () => ({
          vaultId: workspaceController.vaultId,
          vaultPath: workspaceController.vaultPath,
        }),
      },
      request as VaultAttachmentNativeActionRequest,
      vaultAttachmentShell,
    );
  });
  handleMainRendererIpc(
    ipcChannels.loadVaultFilePreview,
    (event, filePath: unknown, expectedVaultId: unknown, expectedInventoryGeneration: unknown) => {
      if (!isMainRendererSender(event.sender)) {
        throw new Error("File previews are available only to the owned main renderer.");
      }
      if (
        typeof filePath !== "string" ||
        typeof expectedVaultId !== "string" ||
        typeof expectedInventoryGeneration !== "string"
      ) {
        throw new Error("File preview requires string path, vault, and inventory values.");
      }
      return workspaceController.loadVaultFilePreview(
        filePath,
        expectedVaultId,
        expectedInventoryGeneration,
      );
    },
  );
  handleMainRendererIpc(
    ipcChannels.loadVaultNoteEmbed,
    (
      _event,
      sourceNotePath: unknown,
      target: unknown,
      subpath: unknown,
      expectedVaultId: unknown,
    ) => {
      if (
        typeof sourceNotePath !== "string" ||
        typeof target !== "string" ||
        (subpath !== null && typeof subpath !== "string") ||
        typeof expectedVaultId !== "string"
      ) {
        throw new Error(
          "Load vault note embed requires string note, target, vault, and string or null subpath values.",
        );
      }
      return workspaceController.loadVaultNoteEmbed(
        sourceNotePath,
        target,
        subpath,
        expectedVaultId,
      );
    },
  );
  handleMainRendererIpc(
    ipcChannels.renderPluginMarkdownProjection,
    (
      event,
      pluginIdValue: unknown,
      sourceNotePath: unknown,
      content: unknown,
      expectedVaultId: unknown,
    ) => {
      assertMainRendererPluginIpcSender(
        isMainRendererSender(event.sender),
        "Plugin Markdown projection",
      );
      if (
        typeof pluginIdValue !== "string" ||
        typeof sourceNotePath !== "string" ||
        typeof content !== "string" ||
        typeof expectedVaultId !== "string"
      ) {
        throw new Error(
          "Rendering a plugin Markdown projection requires string plugin, note, content, and vault values.",
        );
      }
      const pluginId = parsePluginId(pluginIdValue);
      return serializePluginCatalogOperation(
        () =>
          workspaceController.renderPluginMarkdownProjection(
            pluginId,
            sourceNotePath,
            content,
            expectedVaultId,
          ),
        "runtime-render-failed",
        { pluginId },
      );
    },
  );
  handleMainRendererIpc(
    ipcChannels.loadCanvas,
    (_event, filePath: unknown, expectedVaultId: unknown) => {
      if (typeof filePath !== "string" || typeof expectedVaultId !== "string") {
        throw new Error("Load canvas requires string path and vault values.");
      }
      return workspaceController.loadCanvas(filePath, expectedVaultId);
    },
  );
  handleMainRendererIpc(
    ipcChannels.loadCanvasAttachment,
    (_event, sourceCanvasPath: unknown, target: unknown, expectedVaultId: unknown) => {
      if (
        typeof sourceCanvasPath !== "string" ||
        typeof target !== "string" ||
        typeof expectedVaultId !== "string"
      ) {
        throw new Error("Load canvas attachment requires string source, target, and vault values.");
      }
      return workspaceController.loadCanvasAttachment(sourceCanvasPath, target, expectedVaultId);
    },
  );
  handleMainRendererIpc(
    ipcChannels.setKeyBinding,
    (_event, targetId: unknown, binding: unknown) => {
      if (
        typeof targetId !== "string" ||
        !isShortcutTargetId(targetId) ||
        (binding !== null && typeof binding !== "string")
      ) {
        throw new Error("Set key binding requires a known target and a string or null binding.");
      }
      return serializePrivateMutation(() => settingsController.setKeyBinding(targetId, binding));
    },
  );
  handleMainRendererIpc(ipcChannels.resetKeyBindings, () =>
    serializePrivateMutation(() => settingsController.resetKeyBindings()),
  );
  handleMainRendererIpc(ipcChannels.noteWorkflows, async (_event, expectedVaultId: unknown) => {
    if (typeof expectedVaultId !== "string") {
      throw new Error("Note workflow loading requires a string vault identity.");
    }
    if (workspaceController.vaultId !== expectedVaultId) {
      return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
    }
    const settings = settingsController.getVaultNoteWorkflows(expectedVaultId);
    const templates = await workspaceController.listNoteTemplates(
      settings.templateFolder,
      expectedVaultId,
    );
    return workspaceController.vaultId === expectedVaultId
      ? ({ status: "ready", vaultId: expectedVaultId, settings, templates } as const)
      : ({ status: "stale-vault", vaultId: workspaceController.vaultId } as const);
  });
  handleMainRendererIpc(
    ipcChannels.setNoteWorkflows,
    async (_event, expectedVaultId: unknown, settingsValue: unknown) => {
      if (typeof expectedVaultId !== "string") {
        throw new Error("Note workflow updates require a string vault identity.");
      }
      const settings = parseVaultNoteWorkflowSettings(settingsValue);
      return serializePrivateMutation(async () => {
        if (workspaceController.vaultId !== expectedVaultId) {
          return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
        }
        const appSettings = await settingsController.setVaultNoteWorkflows(
          expectedVaultId,
          settings,
        );
        const templates = await workspaceController.listNoteTemplates(
          settings.templateFolder,
          expectedVaultId,
        );
        return workspaceController.vaultId === expectedVaultId
          ? ({
              status: "updated",
              vaultId: expectedVaultId,
              appSettings,
              settings,
              templates,
            } as const)
          : ({ status: "stale-vault", vaultId: workspaceController.vaultId } as const);
      });
    },
  );
  handleMainRendererIpc(ipcChannels.workspaceSettings, async (_event, expectedVaultId: unknown) => {
    if (typeof expectedVaultId !== "string") {
      throw new Error("Workspace preference loading requires a string vault identity.");
    }
    const delay = developmentWorkspaceSettingsDelay();
    if (delay !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    if (developmentWorkspaceSettingsShouldFail()) {
      throw new Error("Test workspace preference refresh failure.");
    }
    if (workspaceController.vaultId !== expectedVaultId) {
      return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
    }
    return {
      status: "ready" as const,
      vaultId: expectedVaultId,
      settings: workspaceController.getWorkspaceSettings(),
    };
  });
  handleMainRendererIpc(
    ipcChannels.setWorkspaceSettings,
    async (_event, expectedVaultId: unknown, settingsValue: unknown) => {
      if (typeof expectedVaultId !== "string") {
        throw new Error("Workspace preference updates require a string vault identity.");
      }
      const settings = parseVaultWorkspaceSettings(settingsValue);
      return serializePrivateMutation(async () => {
        if (workspaceController.vaultId !== expectedVaultId) {
          return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
        }
        const appSettings = await settingsController.setVaultWorkspaceSettings(
          expectedVaultId,
          settings,
        );
        if (workspaceController.vaultId !== expectedVaultId) {
          return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
        }
        workspaceController.setWorkspaceSettings(settings, expectedVaultId);
        return {
          status: "updated" as const,
          vaultId: expectedVaultId,
          settings: workspaceController.getWorkspaceSettings(),
          appSettings,
        };
      });
    },
  );
  handleMainRendererIpc(
    ipcChannels.setWorkspaceMode,
    async (_event, expectedVaultId: unknown, modeValue: unknown) => {
      if (typeof expectedVaultId !== "string") {
        throw new Error("Workspace mode updates require a string vault identity.");
      }
      const mode = parseVaultWorkspaceMode(modeValue);
      return serializePrivateMutation(async () => {
        if (workspaceController.vaultId !== expectedVaultId) {
          return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
        }
        const appSettings = await settingsController.setVaultWorkspaceMode(expectedVaultId, mode);
        const settings = settingsController.getVaultWorkspaceSettings(expectedVaultId);
        workspaceController.setWorkspaceSettings(settings, expectedVaultId);
        return {
          status: "updated" as const,
          vaultId: expectedVaultId,
          settings: workspaceController.getWorkspaceSettings(),
          appSettings,
        };
      });
    },
  );
  handleMainRendererIpc(
    ipcChannels.resetWorkspaceSettings,
    async (_event, expectedVaultId: unknown) => {
      if (typeof expectedVaultId !== "string") {
        throw new Error("Workspace preference reset requires a string vault identity.");
      }
      return serializePrivateMutation(async () => {
        if (workspaceController.vaultId !== expectedVaultId) {
          return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
        }
        const appSettings = await settingsController.resetVaultWorkspaceSettings(expectedVaultId);
        if (workspaceController.vaultId !== expectedVaultId) {
          return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
        }
        const settings = createDefaultVaultWorkspaceSettings();
        workspaceController.setWorkspaceSettings(settings, expectedVaultId);
        return {
          status: "updated" as const,
          vaultId: expectedVaultId,
          settings,
          appSettings,
        };
      });
    },
  );
  handleMainRendererIpc(ipcChannels.openDailyNote, (_event, expectedVaultId: unknown) => {
    if (typeof expectedVaultId !== "string") {
      throw new Error("Opening today's daily note requires a string vault identity.");
    }
    return workspaceController.openDailyNote(
      settingsController.getVaultNoteWorkflows(expectedVaultId),
      expectedVaultId,
    );
  });
  handleMainRendererIpc(
    ipcChannels.renderNoteTemplate,
    (_event, templatePath: unknown, targetPath: unknown, expectedVaultId: unknown) => {
      if (
        typeof templatePath !== "string" ||
        typeof targetPath !== "string" ||
        typeof expectedVaultId !== "string"
      ) {
        throw new Error("Template rendering requires template, target, and vault strings.");
      }
      if (workspaceController.vaultId !== expectedVaultId) {
        return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
      }
      return workspaceController
        .renderNoteTemplate(
          templatePath,
          targetPath,
          settingsController.getVaultNoteWorkflows(expectedVaultId),
          expectedVaultId,
        )
        .then((rendered) => ({
          status: "ready" as const,
          vaultId: expectedVaultId,
          ...rendered,
        }));
    },
  );
  handleMainRendererIpc(
    ipcChannels.formatNoteWorkflowValue,
    (_event, value: unknown, expectedVaultId: unknown) => {
      if ((value !== "date" && value !== "time") || typeof expectedVaultId !== "string") {
        throw new Error("Template value formatting requires date or time and a vault string.");
      }
      if (workspaceController.vaultId !== expectedVaultId) {
        return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
      }
      return {
        status: "ready" as const,
        vaultId: expectedVaultId,
        value: workspaceController.formatNoteWorkflowValue(
          value,
          settingsController.getVaultNoteWorkflows(expectedVaultId),
          expectedVaultId,
        ),
      };
    },
  );
  handleMainRendererIpc(ipcChannels.chooseVault, async () => {
    const developmentOverride = readDevelopmentPickerOverride(app.isPackaged, process.env);
    if (developmentOverride?.status === "cancelled") {
      return {
        status: "cancelled",
        snapshot: await workspaceSnapshotWithLayout(await workspaceController.getSnapshot()),
      } as const;
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
        return {
          status: "cancelled",
          snapshot: await workspaceSnapshotWithLayout(await workspaceController.getSnapshot()),
        } as const;
      }
    }
    try {
      const previousVaultId = workspaceController.vaultId;
      const transition = serializePluginOperation(async () => {
        await requestWindowAutosaveFlush(mainWindow, "vault-switch");
        const opened = await workspaceController.switchVault(selectedPath);
        if (previousVaultId !== opened.vault.id) {
          pluginSurfaceEnvironmentBridges.get(previousVaultId)?.clear();
          pluginSurfaceEnvironmentBridges.delete(previousVaultId);
        }
        if (opened.vault.mode === "kernel-backed" && opened.vault.id) {
          await themePackageManager.recoverVault(workspaceController.vaultPath, opened.vault.id);
        }
        const snapshot = await reconcileCompatibilityPlugins(
          opened.vault.id ?? workspaceController.vaultId,
        );
        return workspaceSnapshotWithLayout(snapshot);
      });
      const settledTransition = transition.then(
        () => undefined,
        () => undefined,
      );
      mainWorkspaceTransition = settledTransition;
      try {
        return {
          status: "opened",
          snapshot: await transition,
        } as const;
      } finally {
        if (mainWorkspaceTransition === settledTransition) {
          mainWorkspaceTransition = null;
        }
      }
    } catch (error) {
      return {
        status: "failed",
        message: describeVaultOpenFailure(error),
        snapshot: await workspaceSnapshotWithLayout(await workspaceController.getSnapshot()),
      } as const;
    }
  });
  handleMainRendererIpc(
    ipcChannels.openNote,
    (_event, filePath: unknown, paneId: unknown, activate: unknown) => {
      if (
        typeof filePath !== "string" ||
        !(paneId === undefined || paneId === "primary" || paneId === "secondary") ||
        !(activate === undefined || typeof activate === "boolean")
      ) {
        throw new Error("Open note requires a string path, optional pane ID, and activation flag.");
      }
      return workspaceController.openNote(filePath, paneId, activate);
    },
  );
  handleMainRendererIpc(ipcChannels.goBack, (_event, expectedVaultId: unknown, paneId: unknown) => {
    if (
      typeof expectedVaultId !== "string" ||
      !(paneId === undefined || paneId === "primary" || paneId === "secondary")
    ) {
      throw new Error("Going back requires a vault identity and optional pane ID.");
    }
    return workspaceController.goBack(expectedVaultId, paneId);
  });
  handleMainRendererIpc(
    ipcChannels.goForward,
    (_event, expectedVaultId: unknown, paneId: unknown) => {
      if (
        typeof expectedVaultId !== "string" ||
        !(paneId === undefined || paneId === "primary" || paneId === "secondary")
      ) {
        throw new Error("Going forward requires a vault identity and optional pane ID.");
      }
      return workspaceController.goForward(expectedVaultId, paneId);
    },
  );
  handleMainRendererIpc(
    ipcChannels.closeNote,
    (_event, filePath: unknown, expectedVaultId: unknown, paneId: unknown) => {
      if (
        typeof filePath !== "string" ||
        typeof expectedVaultId !== "string" ||
        !(paneId === undefined || paneId === "primary" || paneId === "secondary")
      ) {
        throw new Error("Close note requires string path, vault, and optional pane ID values.");
      }
      return workspaceController.closeNote(filePath, expectedVaultId, paneId);
    },
  );
  handleMainRendererIpc(
    ipcChannels.toggleTabPin,
    (_event, filePath: unknown, paneId: unknown, expectedVaultId: unknown) => {
      if (
        typeof filePath !== "string" ||
        (paneId !== "primary" && paneId !== "secondary") ||
        typeof expectedVaultId !== "string"
      ) {
        throw new Error("Toggle tab pin requires a string path, pane, and vault identity.");
      }
      return workspaceController.toggleTabPin(filePath, paneId, expectedVaultId);
    },
  );
  handleMainRendererIpc(
    ipcChannels.splitWorkspace,
    (_event, direction: unknown, expectedVaultId: unknown) => {
      if (
        (direction !== "horizontal" && direction !== "vertical") ||
        typeof expectedVaultId !== "string"
      ) {
        throw new Error("Split workspace requires a direction and vault identity.");
      }
      return workspaceController.splitWorkspace(direction, expectedVaultId);
    },
  );
  handleMainRendererIpc(
    ipcChannels.focusWorkspacePane,
    (_event, paneId: unknown, expectedVaultId: unknown) => {
      if ((paneId !== "primary" && paneId !== "secondary") || typeof expectedVaultId !== "string") {
        throw new Error("Focus workspace pane requires a pane and vault identity.");
      }
      return workspaceController.focusWorkspacePane(paneId, expectedVaultId);
    },
  );
  handleMainRendererIpc(
    ipcChannels.closeWorkspacePane,
    (_event, paneId: unknown, expectedVaultId: unknown) => {
      if ((paneId !== "primary" && paneId !== "secondary") || typeof expectedVaultId !== "string") {
        throw new Error("Close workspace pane requires a pane and vault identity.");
      }
      return workspaceController.closeWorkspacePane(paneId, expectedVaultId);
    },
  );
  handleMainRendererIpc(
    ipcChannels.moveNoteToWorkspacePane,
    (
      _event,
      filePath: unknown,
      fromPaneId: unknown,
      toPaneId: unknown,
      expectedVaultId: unknown,
    ) => {
      if (
        typeof filePath !== "string" ||
        (fromPaneId !== "primary" && fromPaneId !== "secondary") ||
        (toPaneId !== "primary" && toPaneId !== "secondary") ||
        typeof expectedVaultId !== "string"
      ) {
        throw new Error("Move tab requires a path, source pane, target pane, and vault identity.");
      }
      return workspaceController.moveNoteToWorkspacePane(
        filePath,
        fromPaneId,
        toPaneId,
        expectedVaultId,
      );
    },
  );
  handleMainRendererIpc(
    ipcChannels.reorderWorkspaceTab,
    (
      _event,
      filePath: unknown,
      paneId: unknown,
      targetIndex: unknown,
      expectedVaultId: unknown,
    ) => {
      if (
        typeof filePath !== "string" ||
        (paneId !== "primary" && paneId !== "secondary") ||
        typeof targetIndex !== "number" ||
        !Number.isFinite(targetIndex) ||
        typeof expectedVaultId !== "string"
      ) {
        throw new Error(
          "Reordering a tab requires a path, pane, insertion target, and vault identity.",
        );
      }
      return workspaceController.reorderWorkspaceTab(
        filePath,
        paneId,
        targetIndex,
        expectedVaultId,
      );
    },
  );
  handleMainRendererIpc(
    ipcChannels.moveNote,
    async (
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
      const response = await workspaceController.moveNote(
        filePath,
        targetPath,
        expectedRevision,
        expectedVaultId,
        confirmationId,
      );
      if (response.outcome.status === "committed") {
        try {
          await noteBookmarkController.remap(
            expectedVaultId,
            response.outcome.from,
            response.outcome.to,
          );
        } catch (error) {
          console.error("Could not remap the moved note bookmark:", error);
          return {
            ...response,
            bookmarkWarning: `Moved the note to ${response.outcome.to}, but its private bookmark could not be updated. Remove the missing bookmark and add it again.`,
          };
        }
      }
      return response;
    },
  );
  handleMainRendererIpc(
    ipcChannels.moveAttachment,
    (
      _event,
      filePath: unknown,
      targetPath: unknown,
      expectedRevision: unknown,
      expectedVaultId: unknown,
      confirmationId: unknown,
      operation: unknown,
    ) => {
      if (
        typeof filePath !== "string" ||
        typeof targetPath !== "string" ||
        typeof expectedRevision !== "string" ||
        typeof expectedVaultId !== "string" ||
        !(confirmationId === undefined || typeof confirmationId === "string") ||
        !(operation === undefined || operation === "publish-copy" || operation === "rename")
      ) {
        throw new Error(
          "Move attachment requires string path, target, revision, and vault values with optional confirmation and operation values.",
        );
      }
      return workspaceController.moveAttachment(
        filePath,
        targetPath,
        expectedRevision,
        expectedVaultId,
        confirmationId,
        operation as AttachmentOperation | undefined,
      );
    },
  );
  handleMainRendererIpc(
    ipcChannels.relinkAttachment,
    (
      event,
      sourceNotePath: unknown,
      missingTarget: unknown,
      replacementPath: unknown,
      expectedSourceRevision: unknown,
      expectedVaultId: unknown,
      confirmationId: unknown,
    ) => {
      if (!isMainRendererSender(event.sender)) {
        throw new Error("Attachment relinking is available only to the owned main renderer.");
      }
      if (
        typeof sourceNotePath !== "string" ||
        typeof missingTarget !== "string" ||
        typeof replacementPath !== "string" ||
        typeof expectedSourceRevision !== "string" ||
        typeof expectedVaultId !== "string" ||
        !(confirmationId === undefined || typeof confirmationId === "string") ||
        sourceNotePath.length > 4_096 ||
        missingTarget.length > 4_096 ||
        replacementPath.length > 4_096 ||
        expectedSourceRevision.length > 128 ||
        expectedVaultId.length > 128 ||
        (typeof confirmationId === "string" && confirmationId.length > 128)
      ) {
        throw new Error(
          "Relink attachment requires bounded string note, missing target, replacement, revision, and vault values with an optional confirmation.",
        );
      }
      return workspaceController.relinkAttachment(
        sourceNotePath,
        missingTarget,
        replacementPath,
        expectedSourceRevision,
        expectedVaultId,
        confirmationId,
      );
    },
  );
  handleMainRendererIpc(
    ipcChannels.restoreAttachment,
    (
      event,
      sourceNotePath: unknown,
      missingTarget: unknown,
      sourceFileName: unknown,
      bytes: unknown,
      expectedSourceRevision: unknown,
      expectedVaultId: unknown,
      confirmationId: unknown,
    ) => {
      if (!isMainRendererSender(event.sender)) {
        throw new Error("Attachment restoration is available only to the owned main renderer.");
      }
      if (
        typeof sourceNotePath !== "string" ||
        typeof missingTarget !== "string" ||
        typeof sourceFileName !== "string" ||
        !(bytes instanceof ArrayBuffer) ||
        typeof expectedSourceRevision !== "string" ||
        typeof expectedVaultId !== "string" ||
        !(confirmationId === undefined || typeof confirmationId === "string") ||
        sourceNotePath.length > 4_096 ||
        missingTarget.length > 4_096 ||
        Buffer.byteLength(sourceFileName, "utf8") > 255 ||
        bytes.byteLength > MAX_VAULT_ATTACHMENT_BYTES ||
        expectedSourceRevision.length > 128 ||
        expectedVaultId.length > 128 ||
        (typeof confirmationId === "string" && confirmationId.length > 128)
      ) {
        throw new Error(
          "Restore attachment requires bounded string note, missing target, file name, revision, and vault values plus an ArrayBuffer payload and an optional confirmation.",
        );
      }
      return workspaceController.restoreAttachment(
        sourceNotePath,
        missingTarget,
        sourceFileName,
        new Uint8Array(bytes.slice(0)),
        expectedSourceRevision,
        expectedVaultId,
        confirmationId,
      );
    },
  );
  handleMainRendererIpc(
    ipcChannels.insertAttachment,
    (
      event,
      sourceNotePath: unknown,
      targetPath: unknown,
      sourceFileName: unknown,
      bytes: unknown,
      expectedSourceRevision: unknown,
      expectedVaultId: unknown,
      selectionStart: unknown,
      selectionEnd: unknown,
      confirmationId: unknown,
    ) => {
      if (!isMainRendererSender(event.sender)) {
        throw new Error("Attachment insertion is available only to the owned main renderer.");
      }
      if (
        typeof sourceNotePath !== "string" ||
        typeof targetPath !== "string" ||
        typeof sourceFileName !== "string" ||
        !(bytes instanceof ArrayBuffer) ||
        typeof expectedSourceRevision !== "string" ||
        typeof expectedVaultId !== "string" ||
        !Number.isSafeInteger(selectionStart) ||
        (selectionStart as number) < 0 ||
        !Number.isSafeInteger(selectionEnd) ||
        (selectionEnd as number) < 0 ||
        !(confirmationId === undefined || typeof confirmationId === "string") ||
        sourceNotePath.length > 4_096 ||
        targetPath.length > 4_096 ||
        Buffer.byteLength(sourceFileName, "utf8") > 255 ||
        bytes.byteLength > MAX_VAULT_ATTACHMENT_BYTES ||
        expectedSourceRevision.length > 128 ||
        expectedVaultId.length > 128 ||
        (typeof confirmationId === "string" && confirmationId.length > 128)
      ) {
        throw new Error(
          "Insert attachment requires bounded string note, target, file name, revision, and vault values plus an ArrayBuffer payload, non-negative selection offsets, and an optional confirmation.",
        );
      }
      return workspaceController.insertAttachment(
        sourceNotePath,
        targetPath,
        sourceFileName,
        new Uint8Array(bytes.slice(0)),
        expectedSourceRevision,
        expectedVaultId,
        selectionStart as number,
        selectionEnd as number,
        confirmationId,
      );
    },
  );
  handleMainRendererIpc(
    ipcChannels.insertAttachmentBatch,
    (
      event,
      sourceNotePath: unknown,
      items: unknown,
      expectedSourceRevision: unknown,
      expectedVaultId: unknown,
      confirmationId: unknown,
    ) => {
      if (!isMainRendererSender(event.sender)) {
        throw new Error("Attachment batch insertion is available only to the owned main renderer.");
      }
      if (
        typeof sourceNotePath !== "string" ||
        !Array.isArray(items) ||
        items.length === 0 ||
        items.length > MAX_VAULT_ATTACHMENT_BATCH_ITEMS ||
        typeof expectedSourceRevision !== "string" ||
        typeof expectedVaultId !== "string" ||
        !(confirmationId === undefined || typeof confirmationId === "string") ||
        sourceNotePath.length > 4_096 ||
        expectedSourceRevision.length > 128 ||
        expectedVaultId.length > 128 ||
        (typeof confirmationId === "string" && confirmationId.length > 128)
      ) {
        throw new Error(
          "Attachment batch insertion requires bounded note, revision, vault, and confirmation values plus 1-32 items.",
        );
      }
      let totalByteLength = 0;
      const copiedItems: Array<{
        targetPath: string;
        sourceFileName: string;
        bytes: Uint8Array;
        selectionStart: number;
        selectionEnd: number;
      }> = [];
      for (const item of items) {
        if (
          typeof item !== "object" ||
          item === null ||
          !("targetPath" in item) ||
          typeof item.targetPath !== "string" ||
          !("sourceFileName" in item) ||
          typeof item.sourceFileName !== "string" ||
          !("bytes" in item) ||
          !(item.bytes instanceof ArrayBuffer) ||
          !("selectionStart" in item) ||
          !Number.isSafeInteger(item.selectionStart) ||
          (item.selectionStart as number) < 0 ||
          !("selectionEnd" in item) ||
          !Number.isSafeInteger(item.selectionEnd) ||
          (item.selectionEnd as number) < 0 ||
          item.targetPath.length > 4_096 ||
          Buffer.byteLength(item.sourceFileName, "utf8") > 255 ||
          item.bytes.byteLength > MAX_VAULT_ATTACHMENT_BYTES
        ) {
          throw new Error(
            "Each attachment batch item requires bounded strings, an ArrayBuffer, and non-negative selection offsets.",
          );
        }
        totalByteLength += item.bytes.byteLength;
        if (totalByteLength > MAX_VAULT_ATTACHMENT_BATCH_BYTES) {
          throw new Error("Attachment batch bytes exceed the combined payload limit.");
        }
        copiedItems.push({
          targetPath: item.targetPath,
          sourceFileName: item.sourceFileName,
          bytes: new Uint8Array(item.bytes.slice(0)),
          selectionStart: item.selectionStart as number,
          selectionEnd: item.selectionEnd as number,
        });
      }
      return workspaceController.insertAttachmentBatch(
        sourceNotePath,
        copiedItems,
        expectedSourceRevision,
        expectedVaultId,
        confirmationId,
      );
    },
  );
  handleMainRendererIpc(
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
  handleMainRendererIpc(
    ipcChannels.restoreNote,
    (_event, filePath: unknown, expectedRevision: unknown, expectedVaultId: unknown) => {
      if (
        typeof filePath !== "string" ||
        typeof expectedRevision !== "string" ||
        typeof expectedVaultId !== "string"
      ) {
        throw new Error("Restore note requires string path, revision, and vault values.");
      }
      return workspaceController.restoreNote(filePath, expectedRevision, expectedVaultId);
    },
  );
  handleMainRendererIpc(ipcChannels.noteBookmarks, async (_event, expectedVaultId: unknown) => {
    if (typeof expectedVaultId !== "string") {
      throw new Error("Bookmark loading requires a string vault identity.");
    }
    if (workspaceController.vaultId !== expectedVaultId) {
      return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
    }
    const bookmarks = await noteBookmarkController.get(expectedVaultId);
    return workspaceController.vaultId === expectedVaultId
      ? { status: "ready", vaultId: expectedVaultId, paths: bookmarks.paths }
      : ({ status: "stale-vault", vaultId: workspaceController.vaultId } as const);
  });
  handleMainRendererIpc(
    ipcChannels.setNoteBookmark,
    async (_event, filePath: unknown, bookmarked: unknown, expectedVaultId: unknown) => {
      if (
        typeof filePath !== "string" ||
        typeof bookmarked !== "boolean" ||
        typeof expectedVaultId !== "string"
      ) {
        throw new Error(
          "Bookmark updates require a string path, boolean state, and vault identity.",
        );
      }
      if (workspaceController.vaultId !== expectedVaultId) {
        return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
      }
      const bookmarks = await noteBookmarkController.set(expectedVaultId, filePath, bookmarked);
      return workspaceController.vaultId === expectedVaultId
        ? { status: "ready", vaultId: expectedVaultId, paths: bookmarks.paths }
        : ({ status: "stale-vault", vaultId: workspaceController.vaultId } as const);
    },
  );
  handleMainRendererIpc(
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
  handleMainRendererIpc(
    ipcChannels.createWorkspaceFolder,
    (event, folderPath: unknown, expectedVaultId: unknown) => {
      if (!isMainRendererSender(event.sender)) {
        throw new Error("Workspace folder creates require the active Threadleaf window.");
      }
      if (typeof folderPath !== "string" || typeof expectedVaultId !== "string") {
        throw new Error("Workspace folder creates require a string path and vault identity.");
      }
      return workspaceController.createWorkspaceFolder(folderPath, expectedVaultId);
    },
  );
  handleMainRendererIpc(
    ipcChannels.saveNote,
    (
      _event,
      filePath: unknown,
      content: unknown,
      expectedRevision: unknown,
      expectedVaultId: unknown,
      paneId: unknown,
    ) => {
      if (
        typeof filePath !== "string" ||
        typeof content !== "string" ||
        typeof expectedRevision !== "string" ||
        typeof expectedVaultId !== "string" ||
        (paneId !== undefined && paneId !== "primary" && paneId !== "secondary")
      ) {
        throw new Error("Save note requires string path, content, revision, and vault values.");
      }
      return workspaceController.saveNote(
        filePath,
        content,
        expectedRevision,
        expectedVaultId,
        paneId as "primary" | "secondary" | undefined,
      );
    },
  );
  handleMainRendererIpc(
    ipcChannels.saveCanvas,
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
        throw new Error("Save canvas requires string path, content, revision, and vault values.");
      }
      return workspaceController.saveCanvas(filePath, content, expectedRevision, expectedVaultId);
    },
  );
  handleMainRendererIpc(
    ipcChannels.setNoteProperty,
    (
      _event,
      filePath: unknown,
      name: unknown,
      rawValue: unknown,
      type: unknown,
      expectedRevision: unknown,
      expectedVaultId: unknown,
    ) => {
      if (
        typeof filePath !== "string" ||
        typeof name !== "string" ||
        typeof rawValue !== "string" ||
        typeof type !== "string" ||
        !notePropertyTypes.includes(type as NotePropertyType) ||
        typeof expectedRevision !== "string" ||
        typeof expectedVaultId !== "string"
      ) {
        throw new Error(
          "Set property requires string path, name, value, type, revision, and vault values.",
        );
      }
      return workspaceController.setNoteProperty(
        filePath,
        name,
        rawValue,
        type as NotePropertyType,
        expectedRevision,
        expectedVaultId,
      );
    },
  );
  handleMainRendererIpc(
    ipcChannels.removeNoteProperty,
    (
      _event,
      filePath: unknown,
      name: unknown,
      expectedRevision: unknown,
      expectedVaultId: unknown,
    ) => {
      if (
        typeof filePath !== "string" ||
        typeof name !== "string" ||
        typeof expectedRevision !== "string" ||
        typeof expectedVaultId !== "string"
      ) {
        throw new Error("Remove property requires string path, name, revision, and vault values.");
      }
      return workspaceController.removeNoteProperty(
        filePath,
        name,
        expectedRevision,
        expectedVaultId,
      );
    },
  );
  handleMainRendererIpc(
    ipcChannels.getEditorDraft,
    async (_event, expectedVaultId: unknown, paneId: unknown) => {
      if (
        typeof expectedVaultId !== "string" ||
        !(paneId === undefined || paneId === "primary" || paneId === "secondary")
      ) {
        throw new Error("Load editor draft requires a string vault and optional pane identity.");
      }
      const vaultId = workspaceController.vaultId;
      if (expectedVaultId !== vaultId) {
        return { status: "stale-vault", vaultId } as const;
      }
      const draft = await editorDraftStore.load(vaultId, paneId);
      return draft ? ({ status: "ready", draft } as const) : ({ status: "empty" } as const);
    },
  );
  handleMainRendererIpc(ipcChannels.saveEditorDraft, async (_event, value: unknown) => {
    if (
      typeof value !== "object" ||
      value === null ||
      !("vaultId" in value) ||
      typeof value.vaultId !== "string"
    ) {
      throw new Error("Save editor draft requires a versioned draft document.");
    }
    const vaultId = workspaceController.vaultId;
    if (value.vaultId !== vaultId) {
      return { status: "stale-vault", vaultId } as const;
    }
    const draft = await editorDraftStore.save(parseEditorDraft(value, vaultId));
    return { status: "saved", draft } as const;
  });
  handleMainRendererIpc(
    ipcChannels.clearEditorDraft,
    async (_event, expectedVaultId: unknown, draftId: unknown, paneId: unknown) => {
      if (
        typeof expectedVaultId !== "string" ||
        typeof draftId !== "string" ||
        !(paneId === undefined || paneId === "primary" || paneId === "secondary")
      ) {
        throw new Error(
          "Clear editor draft requires string vault, draft, and optional pane identities.",
        );
      }
      const vaultId = workspaceController.vaultId;
      if (expectedVaultId !== vaultId) {
        return { status: "stale-vault", vaultId } as const;
      }
      return {
        status: "cleared",
        cleared: await editorDraftStore.clear(vaultId, draftId, paneId),
      } as const;
    },
  );
  handleMainRendererIpc(
    ipcChannels.runCommand,
    (event, commandId: unknown, editorContext: unknown) => {
      assertMainRendererPluginIpcSender(
        isMainRendererSender(event.sender),
        "Plugin command execution",
      );
      if (typeof commandId !== "string" || commandId.length === 0) {
        throw new Error("Run command requires a string identifier.");
      }
      return serializePluginCatalogOperation(
        () =>
          workspaceController.runPluginCommand(
            commandId,
            editorContext === undefined ? undefined : parsePluginEditorContext(editorContext),
          ),
        "runtime-command-failed",
      );
    },
  );
  handleMainRendererIpc(ipcChannels.waitForPluginMutations, (event, optionsValue: unknown) => {
    assertMainRendererPluginIpcSender(
      isMainRendererSender(event.sender),
      "Waiting for plugin mutations",
    );
    const options = parsePluginMutationWaitOptions(optionsValue);
    return serializePluginOperation(() => workspaceController.waitForPluginMutations(options));
  });
  handleMainRendererIpc(ipcChannels.reloadPlugin, (event, pluginId: unknown) => {
    assertMainRendererPluginIpcSender(isMainRendererSender(event.sender), "Plugin reload");
    if (pluginId !== undefined && typeof pluginId !== "string") {
      throw new Error("Plugin reload requires an optional string identifier.");
    }
    return serializePluginCatalogOperation(
      () => {
        const parsedPluginId = pluginId === undefined ? undefined : parsePluginId(pluginId);
        return reconcileCompatibilityPlugins(workspaceController.vaultId, true, parsedPluginId);
      },
      "runtime-load-failed",
      typeof pluginId === "string" ? { pluginId } : {},
    );
  });
  handleMainRendererIpc(ipcChannels.unloadPlugin, (event, pluginId: unknown) => {
    assertMainRendererPluginIpcSender(isMainRendererSender(event.sender), "Plugin unload");
    if (pluginId !== undefined && typeof pluginId !== "string") {
      throw new Error("Plugin unload requires an optional string identifier.");
    }
    return serializePluginCatalogOperation(
      () => workspaceController.unloadPlugin(pluginId),
      "runtime-unload-failed",
      typeof pluginId === "string" ? { pluginId } : {},
    );
  });
  handleMainRendererIpc(ipcChannels.markPluginLayoutReady, (event) => {
    assertMainRendererPluginIpcSender(
      isMainRendererSender(event.sender),
      "Plugin layout readiness",
    );
    return serializePluginCatalogOperation(
      () => workspaceController.markPluginLayoutReady(),
      "runtime-load-failed",
    );
  });
  handleMainRendererIpc(ipcChannels.openPluginSettings, (event, pluginId: unknown) => {
    assertMainRendererPluginIpcSender(
      isMainRendererSender(event.sender),
      "Opening plugin settings",
    );
    if (typeof pluginId !== "string" || pluginId.length === 0) {
      throw new Error("Opening plugin settings requires a plugin identifier.");
    }
    return serializePluginCatalogOperation(
      () => workspaceController.openPluginSettings(pluginId),
      "runtime-settings-failed",
      { pluginId },
    );
  });
  handleMainRendererIpc(
    ipcChannels.openPluginView,
    (event, viewType: unknown, filePath: unknown) => {
      assertMainRendererPluginIpcSender(
        isMainRendererSender(event.sender),
        "Opening a plugin view",
      );
      if (
        typeof viewType !== "string" ||
        viewType.length === 0 ||
        !(filePath === undefined || (typeof filePath === "string" && filePath.length > 0))
      ) {
        throw new Error("Opening a plugin view requires a view type and optional file path.");
      }
      return serializePluginCatalogOperation(
        () => workspaceController.openPluginView(viewType, filePath),
        "runtime-view-failed",
      );
    },
  );
  handleMainRendererIpc(ipcChannels.closePluginView, (event) => {
    assertMainRendererPluginIpcSender(isMainRendererSender(event.sender), "Closing a plugin view");
    return serializePluginCatalogOperation(
      () => closeCompatibilityPluginView(),
      "runtime-unload-failed",
    );
  });
  handleMainRendererIpc(ipcChannels.setPluginSurfaceBounds, (event, value: unknown) => {
    assertMainRendererPluginIpcSender(
      isMainRendererSender(event.sender),
      "Plugin surface bounds updates",
    );
    if (!value || typeof value !== "object") {
      throw new Error("Plugin surface bounds must be an object.");
    }
    const candidate = value as Record<string, unknown>;
    const fields = [candidate.x, candidate.y, candidate.width, candidate.height];
    if (
      fields.some((field) => typeof field !== "number" || !Number.isFinite(field)) ||
      (candidate.width as number) < 0 ||
      (candidate.height as number) < 0
    ) {
      throw new Error("Plugin surface bounds must contain finite non-negative dimensions.");
    }
    pluginSurfaceBounds = {
      x: Math.max(0, Math.round(candidate.x as number)),
      y: Math.max(0, Math.round(candidate.y as number)),
      width: Math.max(0, Math.round(candidate.width as number)),
      height: Math.max(0, Math.round(candidate.height as number)),
    };
    updatePluginViewBounds();
  });
  handleMainRendererIpc(ipcChannels.setPluginSurfaceVisible, (event, visible: unknown) => {
    assertMainRendererPluginIpcSender(
      isMainRendererSender(event.sender),
      "Plugin surface visibility updates",
    );
    if (typeof visible !== "boolean") {
      throw new Error("Plugin surface visibility must be a boolean.");
    }
    setPluginSurfacePresentationVisible(visible);
  });
  handleMainRendererIpc(ipcChannels.setPluginSurfaceTheme, async (event, theme: unknown) => {
    assertMainRendererPluginIpcSender(
      isMainRendererSender(event.sender),
      "Plugin surface theme updates",
    );
    if (theme !== "dark" && theme !== "light") {
      throw new Error("Plugin surface theme must be dark or light.");
    }
    await applyPluginSurfaceTheme(theme);
  });
  handleMainRendererIpc(
    ipcChannels.setPluginSurfaceAccessibility,
    async (event, value: unknown) => {
      assertMainRendererPluginIpcSender(
        isMainRendererSender(event.sender),
        "Plugin surface accessibility updates",
      );
      if (!value || typeof value !== "object") {
        throw new Error("Plugin surface accessibility state must be an object.");
      }
      const state = value as Record<string, unknown>;
      if (
        typeof state.highContrast !== "boolean" ||
        typeof state.reducedMotion !== "boolean" ||
        typeof state.reducedTransparency !== "boolean" ||
        typeof state.accent !== "string" ||
        typeof state.uiFontScale !== "number" ||
        typeof state.textFontScale !== "number" ||
        typeof state.editorFontSize !== "number" ||
        typeof state.editorLineHeight !== "number"
      ) {
        throw new Error("Plugin surface accessibility state is malformed.");
      }
      if (
        !accessibilityAccentChoices.includes(
          state.accent as (typeof accessibilityAccentChoices)[number],
        )
      ) {
        throw new Error("Plugin surface accessibility accent is unsupported.");
      }
      if (
        state.uiFontScale < 0.8 ||
        state.uiFontScale > 1.6 ||
        state.textFontScale < 0.8 ||
        state.textFontScale > 1.8 ||
        state.editorFontSize < 11 ||
        state.editorFontSize > 32 ||
        state.editorLineHeight < 1.2 ||
        state.editorLineHeight > 2.4 ||
        !Number.isFinite(state.uiFontScale) ||
        !Number.isFinite(state.textFontScale) ||
        !Number.isFinite(state.editorFontSize) ||
        !Number.isFinite(state.editorLineHeight)
      ) {
        throw new Error("Plugin surface accessibility numeric values are out of range.");
      }
      await applyPluginSurfaceAccessibility(value as EffectiveAccessibilityPreferences);
    },
  );
  workspaceController.onSnapshot((snapshot) => {
    if (initialWorkspaceRecoveryPending) {
      return;
    }
    broadcastWorkspaceSnapshot(snapshot);
  });
  settingsController.onSnapshot((snapshot) => {
    installApplicationMenu(snapshot.settings);
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(ipcChannels.settingsChanged, snapshot);
    }
  });
  appUpdateController.onSnapshot((snapshot) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(ipcChannels.appUpdateChanged, snapshot);
    }
  });
  accessibilityPreferencesController.onSnapshot((snapshot) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(ipcChannels.accessibilityPreferencesChanged, snapshot);
    }
  });
}

async function createWindow(trustedWorkspace = false): Promise<void> {
  detachPluginView();
  const restoredBounds = restoreWorkspaceWindowBounds(
    workspaceLayoutController.snapshot().mainWindowBounds,
    workspaceDisplayAreas(),
    { x: 120, y: 70, width: 1180, height: 820, scaleFactor: 1 },
  );
  const window = new BrowserWindow({
    x: restoredBounds.x,
    y: restoredBounds.y,
    width: Math.max(860, restoredBounds.width),
    height: Math.max(640, restoredBounds.height),
    minWidth: 860,
    minHeight: 640,
    backgroundColor: "#11151c",
    title: "Threadleaf",
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: !trustedWorkspace,
      nodeIntegration: trustedWorkspace,
      sandbox: !trustedWorkspace,
      ...(trustedWorkspace
        ? {
            additionalArguments: [
              "--threadleaf-trusted-workspace",
              ...(trustedWorkspaceProbeEnabled(app.isPackaged, process.env)
                ? [trustedWorkspaceProbeArgument]
                : []),
            ],
          }
        : {}),
    },
  });
  mainWindow = window;
  mainWindowTrustedWorkspace = trustedWorkspace;
  const rendererId = window.webContents.id;
  installMainWindowNavigationGuards(window.webContents);
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );

  let boundsTimer: NodeJS.Timeout | undefined;
  let autosaveBridgeReady = false;
  let closeAfterAutosave = false;
  let closeAutosavePending = false;
  window.webContents.on("did-start-loading", () => {
    autosaveBridgeReady = false;
  });
  window.webContents.on("did-finish-load", () => {
    autosaveBridgeReady = true;
  });
  const persistBounds = (): void => {
    if (boundsTimer !== undefined) {
      clearTimeout(boundsTimer);
    }
    const expectedVaultId = workspaceController.vaultId;
    boundsTimer = setTimeout(() => {
      boundsTimer = undefined;
      if (window.isDestroyed()) {
        return;
      }
      void workspaceLayoutController
        .setMainWindowBounds(windowBounds(window), expectedVaultId)
        .catch((error) => console.error("Could not persist main window bounds:", error));
    }, 150);
  };
  window.on("move", persistBounds);
  window.on("resize", persistBounds);
  window.on("blur", () => {
    if (
      mainWindow !== window ||
      !autosaveBridgeReady ||
      applicationQuitAuthorized ||
      mainWorkspaceTransition
    ) {
      return;
    }
    void requestWindowAutosaveFlush(window, "window-blur").catch((error) =>
      console.error("Threadleaf could not flush autosave on window blur:", error),
    );
  });
  window.on("close", (event) => {
    if (applicationQuitAuthorized || closeAfterAutosave || !autosaveBridgeReady) {
      return;
    }
    event.preventDefault();
    if (closeAutosavePending) return;
    closeAutosavePending = true;
    void requestWindowAutosaveFlush(window, "window-close")
      .then(() => {
        if (window.isDestroyed()) return;
        closeAfterAutosave = true;
        window.close();
      })
      .catch((error) =>
        console.error("Threadleaf kept the window open after autosave failed:", error),
      )
      .finally(() => {
        closeAutosavePending = false;
      });
  });

  window.once("ready-to-show", () => window.show());
  window.webContents.on("render-process-gone", (_event, details) => {
    rendererAutosaveFlush.cancelSender(rendererId);
    if (applicationQuitAuthorized || closeAfterAutosave) {
      return;
    }
    if (mainWindow !== window) {
      return;
    }
    recoverMainRenderer({ reason: details.reason, exitCode: details.exitCode });
  });
  window.on("unresponsive", () => {
    console.error("Threadleaf main window became unresponsive");
  });
  window.once("closed", () => {
    rendererAutosaveFlush.cancelSender(rendererId);
    if (boundsTimer !== undefined) {
      clearTimeout(boundsTimer);
      boundsTimer = undefined;
    }
    if (mainWindow === window) {
      attachedPluginView = null;
      mainWindow = null;
      mainWindowTrustedWorkspace = false;
    }
  });
  await window.loadFile(
    join(__dirname, "..", "renderer", trustedWorkspace ? "index-trusted.html" : "index.html"),
  );
  setPluginSurfacePresentationVisible(true);
}

async function replaceMainWindowAfterCrash(): Promise<void> {
  if (mainRendererRecovery) {
    await mainRendererRecovery;
    return;
  }
  let resolveRecovery!: () => void;
  let rejectRecovery!: (error: unknown) => void;
  const recovery = new Promise<void>((resolve, reject) => {
    resolveRecovery = resolve;
    rejectRecovery = reject;
  });
  mainRendererRecovery = recovery;
  try {
    const stoppedWindow = mainWindow;
    if (!stoppedWindow || stoppedWindow.isDestroyed()) {
      throw new Error("The stopped main window is no longer available.");
    }
    const trustedWorkspace = mainWindowTrustedWorkspace;
    await createWindow(trustedWorkspace);
    stoppedWindow.destroy();
    if (trustedWorkspace && activeTrustedWorkspaceRuntime && mainWindow) {
      await activeTrustedWorkspaceRuntime.rebind(mainWindow.webContents);
      await reconcileCompatibilityPlugins(
        workspaceController.vaultId,
        false,
        undefined,
        "renderer-death-restoration",
      );
    }
    resolveRecovery();
  } catch (error) {
    rejectRecovery(error);
    throw error;
  } finally {
    if (mainRendererRecovery === recovery) {
      mainRendererRecovery = null;
    }
  }
}

const recoverMainRenderer = createMainRendererRecoveryHandler({
  prepare: () => {
    detachPluginView();
    setPluginSurfacePresentationVisible(false);
  },
  recover: replaceMainWindowAfterCrash,
  report: (message, details) => console.error(message, details ?? ""),
  schedule: (operation, delayMs) => setTimeout(operation, delayMs),
});

const gracefulShutdownHandler = createGracefulShutdownHandler({
  preflight: () => requestWindowAutosaveFlush(mainWindow, "app-quit"),
  prepare: () => {
    detachPluginView();
    appearanceWatcherLifecycle?.reconcile(null);
  },
  close: async () => {
    await appearanceWatcherLifecycle?.close();
    await workspaceController?.close();
  },
  finalize: () => {
    compatibilityPluginViews.clear();
    for (const bridge of pluginSurfaceEnvironmentBridges.values()) bridge.clear();
    pluginSurfaceEnvironmentBridges.clear();
    visiblePluginViews.clear();
  },
  quit: () => {
    applicationQuitAuthorized = true;
    app.quit();
  },
  reportError: (error) => console.error("Threadleaf shutdown cleanup failed:", error),
});

async function startApplicationWhenReady(): Promise<void> {
  appUpdateController = await createAppUpdateController();
  pluginPackageManager = new PluginPackageManager(
    join(app.getPath("userData"), "plugin-packages"),
    new OpenPluginPackageSource(),
  );
  await pluginPackageManager.initialize();
  pluginConstructionAuthorityStore = new PluginConstructionAuthorityStore(
    join(app.getPath("userData"), "plugin-construction-authority"),
  );
  await pluginConstructionAuthorityStore.initialize();
  appearancePackageSource = new OpenAppearancePackageSource();
  themePackageManager = new ThemePackageManager(
    join(app.getPath("userData"), "appearance-packages"),
    appearancePackageSource,
  );
  await themePackageManager.initialize();
  settingsController = await AppSettingsController.open(
    new FileAppSettingsStore(join(app.getPath("userData"), "settings.json")),
  );
  accessibilityPreferencesController = await AccessibilityPreferencesController.open(
    new FileAccessibilityPreferencesStore(
      join(app.getPath("userData"), "accessibility-preferences.json"),
    ),
  );
  installApplicationMenu(settingsController.getSnapshot().settings);
  editorDraftStore = new FileEditorDraftStore(join(app.getPath("userData"), "editor-drafts"));
  noteBookmarkController = new NoteBookmarkController(
    new FileNoteBookmarkStore(join(app.getPath("userData"), "bookmarks")),
  );
  workspaceStateStore = new FileWorkspaceStateStore(join(app.getPath("userData"), "workspaces"));
  const migrationInterruptPhase = developmentMigrationInterruptPhase();
  const migrationFaultPhase = developmentMigrationFaultPhase();
  let migrationInterrupted = false;
  let migrationFaulted = false;
  migrationTransactionManager = new ObsidianMigrationTransactionManager(
    join(app.getPath("userData"), "migration"),
    {
      writeSettings: async (settings, expectedCurrent) => {
        await settingsController.replaceSettings(settings, expectedCurrent);
      },
      writeWorkspace: async (state, expectedCurrent) => {
        if (!state) {
          throw new Error("The active workspace cannot be cleared by a migration transaction.");
        }
        if (workspaceController?.vaultId === state.vaultId) {
          await workspaceController.setWorkspaceState(state, state.vaultId, expectedCurrent);
          return;
        }
        await workspaceStateStore.save(state, expectedCurrent);
      },
    },
    () => new Date(),
    migrationInterruptPhase || migrationFaultPhase
      ? {
          afterPhase: (phase) => {
            if (phase === migrationInterruptPhase && !migrationInterrupted) {
              migrationInterrupted = true;
              process.kill(process.pid, "SIGKILL");
            }
            if (phase === migrationFaultPhase && !migrationFaulted) {
              migrationFaulted = true;
              throw new Error(`Injected migration hook fault at ${phase}.`);
            }
          },
        }
      : {},
  );
  await migrationTransactionManager.initialize();
  workspaceController = await createWorkspaceController();
  workspaceLayoutController = new WorkspaceLayoutController({
    store: new FileWorkspaceLayoutStore(join(app.getPath("userData"), "workspace-layouts")),
    supportedPopoutViewTypes: [
      "drawing",
      "renderer-view",
      "excalidraw",
      "threadleaf-plugin-settings",
    ],
  });
  await workspaceLayoutController.activateVault(workspaceController.vaultId);
  workspaceLayoutController.onSnapshot((snapshot) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(ipcChannels.workspaceLayoutChanged, snapshot);
      }
    }
  });
  appearanceWatcherLifecycle = createAppearanceWatcherLifecycle();
  registerIpcHandlers();
  reconcileAppearanceWatcher(await workspaceController.getSnapshot());
  await createWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow(trustedWorkspaceEnabledForVault(workspaceController.vaultId));
    }
  });
}

if (hasSingleInstanceLock) {
  app.whenReady().then(startApplicationWhenReady);
}

app.on("before-quit", gracefulShutdownHandler);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
