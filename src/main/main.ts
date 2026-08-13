import { release as osRelease } from "node:os";
import { join, resolve } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type OpenDialogOptions,
  type SaveDialogOptions,
  screen,
  type WebContents,
  type WebContentsView,
} from "electron";
import { AccessibilityPreferencesController } from "../application/accessibility-preferences-controller";
import { AppSettingsController } from "../application/app-settings-controller";
import { AppUpdateController } from "../application/app-update-controller";
import { parseEditorDraft } from "../application/editor-draft";
import { NoteBookmarkController } from "../application/note-bookmarks";
import { parseVaultGraphRequest } from "../application/vault-graph";
import { WorkspaceController } from "../application/workspace-controller";
import { atomicWriteFile, readStableFile } from "../kernel/durability";
import { VaultPathPolicy } from "../kernel/path-policy";
import { FixedStateRoot } from "../kernel/ports";
import { IsolatedPluginRuntime } from "../runtime/isolated-plugin-runtime";
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
  type AppearancePackageApplyResponse,
  type NotePropertyType,
  notePropertyTypes,
  type PluginPackageApplyResponse,
  type PluginSurfaceBounds,
  type PluginUpdateResponse,
  type RuntimeSnapshot,
} from "../shared/contracts";
import { ipcChannels } from "../shared/ipc-channels";
import type { AppSettings } from "../shared/key-bindings";
import { isShortcutTargetId } from "../shared/key-bindings";
import type { MigrationApplyRequest } from "../shared/migration";
import type { NativeMenuCommandId } from "../shared/native-menu";
import { parseVaultNoteWorkflowSettings } from "../shared/note-workflows";
import { parsePluginPackagePreviewRequest } from "../shared/plugin-packages";
import {
  parsePluginEditorContext,
  parsePluginMutationWaitOptions,
  parsePluginVaultCreateBinaryRequest,
  parsePluginVaultCreateFolderRequest,
  parsePluginVaultCreateRequest,
  parsePluginVaultRenameRequest,
  parsePluginVaultTrashRequest,
  parsePluginVaultWriteBinaryRequest,
  parsePluginVaultWriteRequest,
  pluginRendererChannels,
} from "../shared/plugin-runtime-protocol";
import {
  type CompatibilityMode,
  compatibilityModes,
  type PluginCatalogResponse,
  parsePluginId,
  pluginCapabilityGrantMatches,
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
import { PluginPackageManager } from "./plugin-package-manager";
import {
  ensureHtmlExtension,
  isPublishExportTargetOutsideVault,
  parsePublishNoteExportRequest,
  readDevelopmentPublishExportPath,
  suggestedPublishedNoteFilename,
} from "./publish-export";
import {
  createSupportBundleMarkdown,
  isSupportBundleTargetOutsideVault,
  readDevelopmentSupportBundlePath,
} from "./support-bundle";
import { ThemePackageManager } from "./theme-package-manager";
import { loadVaultAppearance } from "./vault-appearance-loader";
import { VaultAppearanceWatcher } from "./vault-appearance-watcher";
import { discoverVaultPlugins, loadVaultPluginCatalog } from "./vault-plugin-loader";
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

let mainWindow: BrowserWindow | null = null;
let workspaceController: WorkspaceController;
let settingsController: AppSettingsController;
let accessibilityPreferencesController: AccessibilityPreferencesController;
let appUpdateController: AppUpdateController;
let editorDraftStore: FileEditorDraftStore;
let noteBookmarkController: NoteBookmarkController;
let pluginPackageManager: PluginPackageManager;
let appearancePackageSource: OpenAppearancePackageSource;
let themePackageManager: ThemePackageManager;
let workspaceLayoutController!: WorkspaceLayoutController;
let workspaceStateStore: FileWorkspaceStateStore;
let pluginOperationTail: Promise<void> = Promise.resolve();
let initialWorkspaceActivation: Promise<void> | null = null;
let initialWorkspaceRecoveryPending = false;
let attachedPluginView: WebContentsView | null = null;
let attachedPluginHost: BrowserWindow | null = null;
let pluginPopoutWindow: BrowserWindow | null = null;
let pluginPopoutRendererMonitor: NodeJS.Timeout | undefined;
let closingPluginPopout = false;
let workspaceSnapshotSequence = 0;
const compatibilityPluginViews = new Set<WebContentsView>();
const compatibilityPluginWebContents = new Set<WebContents>();
const visiblePluginViews = new Set<WebContentsView>();
let pluginSurfaceBounds: PluginSurfaceBounds = { x: 0, y: 0, width: 0, height: 0 };
let pluginSurfaceCss = "";
const pluginSurfaceCssKeys = new Map<WebContents, string>();

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
let migrationTransactionManager: ObsidianMigrationTransactionManager | null = null;
const migrationStartupNotices = new Map<
  string,
  Awaited<ReturnType<ObsidianMigrationTransactionManager["recover"]>>
>();

async function applyPluginSurfaceTheme(
  theme: "dark" | "light",
  webContents?: WebContents,
): Promise<void> {
  pluginSurfaceTheme = theme;
  const targets = webContents ? [webContents] : [...compatibilityPluginWebContents];
  const results = await Promise.allSettled(
    targets.map(async (target) => {
      if (target.isDestroyed()) {
        return;
      }
      await target.executeJavaScript(`
        (() => {
          const theme = ${JSON.stringify(theme)};
          document.documentElement.dataset.theme = theme;
          for (const target of [document.documentElement, document.body]) {
            target.classList.toggle("theme-dark", theme === "dark");
            target.classList.toggle("theme-light", theme === "light");
          }
        })()
      `);
    }),
  );
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("Could not apply the theme to an isolated plugin renderer:", result.reason);
    }
  }
}

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
      --interactive-accent: #005a8c !important;
      --interactive-accent-hover: #003f66 !important;
      --text-accent: #005a8c !important;
    }
    html[data-theme="dark"][data-threadleaf-accessibility="true"][data-threadleaf-accent="blue"] {
      --interactive-accent: #76c7f0 !important;
      --interactive-accent-hover: #a8e0fa !important;
      --text-accent: #a8e0fa !important;
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

async function applyPluginSurfaceAccessibility(
  preferences: EffectiveAccessibilityPreferences,
  webContents?: WebContents,
): Promise<void> {
  pluginSurfaceAccessibility = preferences;
  const targets = webContents ? [webContents] : [...compatibilityPluginWebContents];
  const css = pluginAccessibilityCss();
  const results = await Promise.allSettled(
    targets.map(async (target) => {
      if (target.isDestroyed()) return;
      await target.executeJavaScript(`
        (() => {
          const root = document.documentElement;
          const body = document.body;
          const state = ${JSON.stringify(preferences)};
          root.dataset.threadleafAccessibility = "true";
          root.dataset.threadleafHighContrast = String(state.highContrast);
          root.dataset.threadleafReducedMotion = String(state.reducedMotion);
          root.dataset.threadleafReducedTransparency = String(state.reducedTransparency);
          root.dataset.threadleafAccent = state.accent;
          for (const target of [root, body]) {
            target.style.setProperty("--threadleaf-ui-font-scale", String(state.uiFontScale), "important");
            target.style.setProperty("--threadleaf-text-font-scale", String(state.textFontScale), "important");
            target.style.setProperty("--threadleaf-editor-font-size", String(state.editorFontSize) + "px", "important");
            target.style.setProperty("--threadleaf-editor-line-height", String(state.editorLineHeight), "important");
          }
          let style = document.getElementById("threadleaf-accessibility-protection");
          if (!style) {
            style = document.createElement("style");
            style.id = "threadleaf-accessibility-protection";
            document.head.append(style);
          }
          style.textContent = ${JSON.stringify(css)};
        })()
      `);
    }),
  );
  for (const result of results) {
    if (result.status === "rejected") {
      console.error(
        "Could not apply accessibility preferences to an isolated plugin renderer:",
        result.reason,
      );
    }
  }
}

async function applyPluginSurfaceCss(css: string, view?: WebContentsView): Promise<void> {
  pluginSurfaceCss = css;
  const targets = view ? [view] : [...compatibilityPluginViews];
  const results = await Promise.allSettled(
    targets.map(async (target) => {
      const webContents = target.webContents;
      const previousKey = pluginSurfaceCssKeys.get(webContents);
      pluginSurfaceCssKeys.delete(webContents);
      if (previousKey && !webContents.isDestroyed()) {
        await webContents.removeInsertedCSS(previousKey).catch(() => undefined);
      }
      if (webContents.isDestroyed() || !css) {
        return;
      }
      const key = await webContents.insertCSS(css, { cssOrigin: "author" });
      if (webContents.isDestroyed() || !compatibilityPluginViews.has(target)) {
        if (!webContents.isDestroyed()) {
          await webContents.removeInsertedCSS(key).catch(() => undefined);
        }
        return;
      }
      pluginSurfaceCssKeys.set(webContents, key);
    }),
  );
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("Could not apply CSS to an isolated plugin renderer:", result.reason);
    }
  }
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

async function registerCompatibilityPluginView(view: WebContentsView): Promise<void> {
  const webContents = view.webContents;
  compatibilityPluginViews.add(view);
  compatibilityPluginWebContents.add(webContents);
  webContents.once("destroyed", () => {
    compatibilityPluginViews.delete(view);
    compatibilityPluginWebContents.delete(webContents);
    visiblePluginViews.delete(view);
    pluginSurfaceCssKeys.delete(webContents);
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
  await Promise.all([
    applyPluginSurfaceTheme(pluginSurfaceTheme, webContents),
    applyPluginSurfaceCss(pluginSurfaceCss, view),
    applyPluginSurfaceAccessibility(pluginSurfaceAccessibility, webContents),
  ]);
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
  return compatibilityPluginWebContents.has(webContents) && !webContents.isDestroyed();
}

function isMainRendererSender(webContents: WebContents): boolean {
  return Boolean(
    mainWindow &&
      !mainWindow.isDestroyed() &&
      !mainWindow.webContents.isDestroyed() &&
      webContents === mainWindow.webContents,
  );
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
          window.webContents.send(ipcChannels.snapshotChanged, enriched);
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
  const catalog = await loadVaultPluginCatalog({
    vaultPath,
    vaultId: expectedVaultId,
    preference: settingsController.getVaultPlugins(expectedVaultId),
    safeMode: pluginSafeMode(),
    blockedPluginIds,
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
  const targetIds = new Set(
    pluginsAllowed
      ? preference.enabledPluginIds.filter((pluginId) => {
          const plugin = packagesById.get(pluginId);
          const report = plugin?.summary.capabilityReport;
          return (
            !changedManagedIds.has(pluginId) &&
            plugin?.summary.packageState === "ready" &&
            report !== null &&
            report !== undefined &&
            pluginCapabilityGrantMatches(report, preference.capabilityGrantsByPlugin[pluginId])
          );
        })
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
    const report = installed?.summary.capabilityReport;
    if (!installed || !report) {
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
      snapshot = await workspaceController.loadPlugin(installed.directoryPath, report.bundleSha256);
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
    beforeWorkspaceStateRestore: async (vaultId) => {
      const recoveryNotices = migrationTransactionManager
        ? await migrationTransactionManager.recover(vaultId, () => currentMigrationState(vaultId))
        : [];
      if (recoveryNotices.length > 0) {
        migrationStartupNotices.set(vaultId, recoveryNotices);
      }
    },
    workspaceSettingsForVault: (vaultId) => settingsController.getVaultWorkspaceSettings(vaultId),
    pluginRuntimeFactory: async (vaultPath) => {
      const pluginOperationTimeout = developmentPluginOperationTimeout();
      return IsolatedPluginRuntime.open({
        create: () =>
          RecoveringPluginRuntime.open({
            create: () =>
              ElectronPluginRuntime.open({
                hostHtmlPath: join(__dirname, "..", "renderer", "plugin-host.html"),
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
            onRuntimeChange: async (runtime) => registerCompatibilityPluginView(runtime.view),
          }),
      });
    },
    deferInitialVault: true,
    ...(configuredPath ? { configuredVaultPath: configuredPath } : {}),
  });
}

async function activateInitialWorkspace(): Promise<void> {
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
      await serializePluginOperation(() => reconcileCompatibilityPlugins(expectedVaultId));
    }
  } finally {
    initialWorkspaceRecoveryPending = false;
    broadcastWorkspaceSnapshot(await workspaceController.getSnapshot());
  }
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
  ipcMain.handle(ipcChannels.exportSupportBundle, (event) => {
    if (!isMainRendererSender(event.sender)) {
      throw new Error("Support bundle export requires the active Threadleaf window.");
    }
    return exportSupportBundle();
  });
  ipcMain.handle(ipcChannels.publishNote, (event, value: unknown) => {
    if (!isMainRendererSender(event.sender)) {
      throw new Error("Published-note export requires the active Threadleaf window.");
    }
    return exportPublishedNote(value);
  });
  ipcMain.handle(ipcChannels.appUpdate, () => appUpdateController.getSnapshot());
  ipcMain.handle(ipcChannels.checkForAppUpdate, () => appUpdateController.checkForUpdates());
  ipcMain.handle(ipcChannels.downloadAppUpdate, () => appUpdateController.downloadUpdate());
  ipcMain.handle(ipcChannels.installAppUpdate, () => appUpdateController.installUpdate());
  ipcMain.handle(pluginRendererChannels.vaultCreate, async (event, value: unknown) => {
    if (!isCompatibilityPluginSender(event.sender)) {
      throw new Error("Plugin vault creates require the active compatibility renderer.");
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
    if (!isCompatibilityPluginSender(event.sender)) {
      throw new Error("Plugin binary vault creates require the active compatibility renderer.");
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
    if (!isCompatibilityPluginSender(event.sender)) {
      throw new Error("Plugin vault folder creates require the active compatibility renderer.");
    }
    const request = parsePluginVaultCreateFolderRequest(value);
    if (resolve(request.vaultPath) !== resolve(workspaceController.vaultPath)) {
      throw new Error("The active vault changed before the plugin folder could be created.");
    }
    return workspaceController.createPluginFolder(request.folderPath, workspaceController.vaultId);
  });
  ipcMain.handle(pluginRendererChannels.vaultRename, async (event, value: unknown) => {
    if (!isCompatibilityPluginSender(event.sender)) {
      throw new Error("Plugin vault renames require the active compatibility renderer.");
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
    if (!isCompatibilityPluginSender(event.sender)) {
      throw new Error("Plugin vault trash requires the active compatibility renderer.");
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
    if (!isCompatibilityPluginSender(event.sender)) {
      throw new Error("Plugin vault writes require the active compatibility renderer.");
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
    if (!isCompatibilityPluginSender(event.sender)) {
      throw new Error("Plugin binary vault writes require the active compatibility renderer.");
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
  ipcMain.handle(ipcChannels.snapshot, async () => {
    if (initialWorkspaceRecoveryPending && initialWorkspaceActivation) {
      await initialWorkspaceActivation;
    }
    return workspaceSnapshotWithLayout(await workspaceController.getSnapshot());
  });
  ipcMain.handle(ipcChannels.workspaceLayout, async (event, expectedVaultId: unknown) => {
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
  ipcMain.handle(
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
  ipcMain.handle(ipcChannels.popOutPluginView, (event, expectedVaultId: unknown) => {
    if (!isMainRendererSender(event.sender)) {
      throw new Error("Plugin pop-outs require the active Threadleaf window.");
    }
    if (typeof expectedVaultId !== "string") {
      throw new Error("Popping out a plugin view requires a vault identity.");
    }
    return popOutPluginView(expectedVaultId);
  });
  ipcMain.handle(ipcChannels.reattachPluginView, (event, expectedVaultId: unknown) => {
    if (!isMainRendererSender(event.sender)) {
      throw new Error("Plugin pop-out reattachment requires the active Threadleaf window.");
    }
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
  ipcMain.handle(ipcChannels.settings, async () => {
    const delay = developmentSettingsDelay();
    if (delay !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return settingsController.getSnapshot();
  });
  ipcMain.handle(ipcChannels.accessibilityPreferences, () =>
    accessibilityPreferencesController.getSnapshot(),
  );
  ipcMain.handle(ipcChannels.setAccessibilityPreferences, async (_event, value: unknown) => {
    const preferences = parseAccessibilityPreferences(value);
    return accessibilityPreferencesController.setPreferences(preferences);
  });
  ipcMain.handle(ipcChannels.resetAccessibilityPreferences, async () => {
    return accessibilityPreferencesController.reset();
  });
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
  ipcMain.handle(ipcChannels.appearancePackages, (_event, expectedVaultId: unknown) => {
    if (typeof expectedVaultId !== "string") {
      throw new Error("Appearance package inventory requires a string vault identity.");
    }
    return serializePluginOperation(() => currentAppearancePackages(expectedVaultId));
  });
  ipcMain.handle(
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
  ipcMain.handle(
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
  ipcMain.handle(
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
  ipcMain.handle(
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
  ipcMain.handle(ipcChannels.plugins, (_event, expectedVaultId: unknown) => {
    if (typeof expectedVaultId !== "string") {
      throw new Error("Plugin catalog loading requires a string vault identity.");
    }
    return serializePluginOperation(() => currentPluginCatalog(expectedVaultId));
  });
  ipcMain.handle(
    ipcChannels.searchPluginPackages,
    (_event, expectedVaultId: unknown, query: unknown) => {
      if (typeof expectedVaultId !== "string" || typeof query !== "string") {
        throw new Error("Plugin registry search requires a vault identity and string query.");
      }
      return serializePluginOperation(async () => {
        if (workspaceController.vaultId !== expectedVaultId) {
          return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
        }
        const vaultPath = workspaceController.vaultPath;
        const index = await pluginPackageManager.search(vaultPath, expectedVaultId, query);
        return workspaceController.vaultId === expectedVaultId &&
          workspaceController.vaultPath === vaultPath
          ? ({ status: "ready", index } as const)
          : ({ status: "stale-vault", vaultId: workspaceController.vaultId } as const);
      });
    },
  );
  ipcMain.handle(
    ipcChannels.previewPluginPackage,
    (_event, expectedVaultId: unknown, requestValue: unknown) => {
      if (typeof expectedVaultId !== "string") {
        throw new Error("Plugin package review requires a vault identity.");
      }
      const request = parsePluginPackagePreviewRequest(requestValue);
      return serializePluginOperation(async () => {
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
      });
    },
  );
  ipcMain.handle(
    ipcChannels.applyPluginPackage,
    (_event, expectedVaultId: unknown, reviewId: unknown): Promise<PluginPackageApplyResponse> => {
      if (typeof expectedVaultId !== "string" || typeof reviewId !== "string") {
        throw new Error("Plugin package apply requires a vault identity and review identity.");
      }
      return serializePluginOperation(async () => {
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
      });
    },
  );
  ipcMain.handle(
    ipcChannels.cancelPluginPackageReview,
    (_event, expectedVaultId: unknown, reviewId: unknown) => {
      if (typeof expectedVaultId !== "string" || typeof reviewId !== "string") {
        throw new Error("Plugin package review cancellation requires string identities.");
      }
      return serializePluginOperation(() =>
        pluginPackageManager.cancelReview(expectedVaultId, reviewId),
      );
    },
  );
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
    ipcChannels.setPluginCapabilityGrant,
    (
      _event,
      expectedVaultId: unknown,
      pluginIdValue: unknown,
      expectedBundleSha256: unknown,
      granted: unknown,
    ) => {
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
      return serializePluginOperation(async () => {
        if (workspaceController.vaultId !== expectedVaultId) {
          return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
        }
        const pluginId = parsePluginId(pluginIdValue);
        const current = settingsController.getVaultPlugins(expectedVaultId);
        const capabilityGrantsByPlugin = { ...current.capabilityGrantsByPlugin };
        let enabledPluginIds = [...current.enabledPluginIds];
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
          capabilityGrantsByPlugin[pluginId] = {
            bundleSha256: report.bundleSha256,
            capabilities: [...report.capabilities],
          };
        } else {
          delete capabilityGrantsByPlugin[pluginId];
          enabledPluginIds = enabledPluginIds.filter((candidate) => candidate !== pluginId);
        }
        const settings = await settingsController.setVaultPlugins(expectedVaultId, {
          ...current,
          enabledPluginIds,
          capabilityGrantsByPlugin,
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
            throw new Error(
              `Plugin ${pluginId} requires a current exact-bundle authority grant before enablement.`,
            );
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
  ipcMain.handle(ipcChannels.migrationPreview, (event, expectedVaultId: unknown) => {
    if (!isMainRendererSender(event.sender)) {
      throw new Error("Migration preview requires the active Threadleaf window.");
    }
    if (typeof expectedVaultId !== "string") {
      throw new Error("Migration preview requires a string vault identity.");
    }
    return serializePluginOperation(() => currentMigrationPreview(expectedVaultId));
  });
  ipcMain.handle(
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
  ipcMain.handle(
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
  ipcMain.handle(ipcChannels.searchVault, (_event, query: unknown) => {
    if (typeof query !== "string") {
      throw new Error("Vault search requires a string query.");
    }
    return workspaceController.searchVault(query);
  });
  ipcMain.handle(
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
  ipcMain.handle(ipcChannels.vaultTrash, (_event, expectedVaultId: unknown) => {
    if (typeof expectedVaultId !== "string") {
      throw new Error("Vault trash inspection requires a string vault identity.");
    }
    return workspaceController.getVaultTrash(expectedVaultId);
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
  ipcMain.handle(
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
  ipcMain.handle(
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
  ipcMain.handle(ipcChannels.loadCanvas, (_event, filePath: unknown, expectedVaultId: unknown) => {
    if (typeof filePath !== "string" || typeof expectedVaultId !== "string") {
      throw new Error("Load canvas requires string path and vault values.");
    }
    return workspaceController.loadCanvas(filePath, expectedVaultId);
  });
  ipcMain.handle(
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
  ipcMain.handle(ipcChannels.noteWorkflows, async (_event, expectedVaultId: unknown) => {
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
  ipcMain.handle(
    ipcChannels.setNoteWorkflows,
    async (_event, expectedVaultId: unknown, settingsValue: unknown) => {
      if (typeof expectedVaultId !== "string") {
        throw new Error("Note workflow updates require a string vault identity.");
      }
      if (workspaceController.vaultId !== expectedVaultId) {
        return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
      }
      const settings = parseVaultNoteWorkflowSettings(settingsValue);
      const appSettings = await settingsController.setVaultNoteWorkflows(expectedVaultId, settings);
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
    },
  );
  ipcMain.handle(ipcChannels.workspaceSettings, async (_event, expectedVaultId: unknown) => {
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
  ipcMain.handle(
    ipcChannels.setWorkspaceSettings,
    async (_event, expectedVaultId: unknown, settingsValue: unknown) => {
      if (typeof expectedVaultId !== "string") {
        throw new Error("Workspace preference updates require a string vault identity.");
      }
      if (workspaceController.vaultId !== expectedVaultId) {
        return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
      }
      const settings = parseVaultWorkspaceSettings(settingsValue);
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
    },
  );
  ipcMain.handle(
    ipcChannels.setWorkspaceMode,
    async (_event, expectedVaultId: unknown, modeValue: unknown) => {
      if (typeof expectedVaultId !== "string") {
        throw new Error("Workspace mode updates require a string vault identity.");
      }
      if (workspaceController.vaultId !== expectedVaultId) {
        return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
      }
      const mode = parseVaultWorkspaceMode(modeValue);
      const appSettings = await settingsController.setVaultWorkspaceMode(expectedVaultId, mode);
      const settings = settingsController.getVaultWorkspaceSettings(expectedVaultId);
      workspaceController.setWorkspaceSettings(settings, expectedVaultId);
      return {
        status: "updated" as const,
        vaultId: expectedVaultId,
        settings: workspaceController.getWorkspaceSettings(),
        appSettings,
      };
    },
  );
  ipcMain.handle(ipcChannels.resetWorkspaceSettings, async (_event, expectedVaultId: unknown) => {
    if (typeof expectedVaultId !== "string") {
      throw new Error("Workspace preference reset requires a string vault identity.");
    }
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
      settings: workspaceController.getWorkspaceSettings(),
      appSettings,
    };
  });
  ipcMain.handle(ipcChannels.openDailyNote, (_event, expectedVaultId: unknown) => {
    if (typeof expectedVaultId !== "string") {
      throw new Error("Opening today's daily note requires a string vault identity.");
    }
    return workspaceController.openDailyNote(
      settingsController.getVaultNoteWorkflows(expectedVaultId),
      expectedVaultId,
    );
  });
  ipcMain.handle(
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
  ipcMain.handle(
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
  ipcMain.handle(ipcChannels.chooseVault, async () => {
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
      return {
        status: "opened",
        snapshot: await serializePluginOperation(async () => {
          const opened = await workspaceController.switchVault(selectedPath);
          if (opened.vault.mode === "kernel-backed" && opened.vault.id) {
            await themePackageManager.recoverVault(workspaceController.vaultPath, opened.vault.id);
          }
          const snapshot = await reconcileCompatibilityPlugins(
            opened.vault.id ?? workspaceController.vaultId,
          );
          return workspaceSnapshotWithLayout(snapshot);
        }),
      } as const;
    } catch (error) {
      return {
        status: "failed",
        message: describeVaultOpenFailure(error),
        snapshot: await workspaceSnapshotWithLayout(await workspaceController.getSnapshot()),
      } as const;
    }
  });
  ipcMain.handle(
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
  ipcMain.handle(
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
  ipcMain.handle(
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
  ipcMain.handle(
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
  ipcMain.handle(
    ipcChannels.focusWorkspacePane,
    (_event, paneId: unknown, expectedVaultId: unknown) => {
      if ((paneId !== "primary" && paneId !== "secondary") || typeof expectedVaultId !== "string") {
        throw new Error("Focus workspace pane requires a pane and vault identity.");
      }
      return workspaceController.focusWorkspacePane(paneId, expectedVaultId);
    },
  );
  ipcMain.handle(
    ipcChannels.closeWorkspacePane,
    (_event, paneId: unknown, expectedVaultId: unknown) => {
      if ((paneId !== "primary" && paneId !== "secondary") || typeof expectedVaultId !== "string") {
        throw new Error("Close workspace pane requires a pane and vault identity.");
      }
      return workspaceController.closeWorkspacePane(paneId, expectedVaultId);
    },
  );
  ipcMain.handle(
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
  ipcMain.handle(
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
  ipcMain.handle(
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
  ipcMain.handle(ipcChannels.noteBookmarks, async (_event, expectedVaultId: unknown) => {
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
  ipcMain.handle(
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
  ipcMain.handle(
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
  ipcMain.handle(
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
  ipcMain.handle(
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
  ipcMain.handle(
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
  ipcMain.handle(ipcChannels.saveEditorDraft, async (_event, value: unknown) => {
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
  ipcMain.handle(
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
  ipcMain.handle(ipcChannels.runCommand, (_event, commandId: unknown, editorContext: unknown) => {
    if (typeof commandId !== "string" || commandId.length === 0) {
      throw new Error("Run command requires a string identifier.");
    }
    return workspaceController.runPluginCommand(
      commandId,
      editorContext === undefined ? undefined : parsePluginEditorContext(editorContext),
    );
  });
  ipcMain.handle(ipcChannels.waitForPluginMutations, (event, optionsValue: unknown) => {
    if (!isMainRendererSender(event.sender)) {
      throw new Error("Waiting for plugin mutations requires the active Threadleaf window.");
    }
    const options = parsePluginMutationWaitOptions(optionsValue);
    return serializePluginOperation(() => workspaceController.waitForPluginMutations(options));
  });
  ipcMain.handle(ipcChannels.reloadPlugin, (_event, pluginId: unknown) => {
    if (pluginId !== undefined && typeof pluginId !== "string") {
      throw new Error("Plugin reload requires an optional string identifier.");
    }
    const parsedPluginId = pluginId === undefined ? undefined : parsePluginId(pluginId);
    return serializePluginOperation(() =>
      reconcileCompatibilityPlugins(workspaceController.vaultId, true, parsedPluginId),
    );
  });
  ipcMain.handle(ipcChannels.unloadPlugin, (_event, pluginId: unknown) => {
    if (pluginId !== undefined && typeof pluginId !== "string") {
      throw new Error("Plugin unload requires an optional string identifier.");
    }
    return serializePluginOperation(() => workspaceController.unloadPlugin(pluginId));
  });
  ipcMain.handle(ipcChannels.markPluginLayoutReady, () =>
    serializePluginOperation(() => workspaceController.markPluginLayoutReady()),
  );
  ipcMain.handle(ipcChannels.openPluginSettings, (_event, pluginId: unknown) => {
    if (typeof pluginId !== "string" || pluginId.length === 0) {
      throw new Error("Opening plugin settings requires a plugin identifier.");
    }
    return serializePluginOperation(() => workspaceController.openPluginSettings(pluginId));
  });
  ipcMain.handle(ipcChannels.openPluginView, (_event, viewType: unknown, filePath: unknown) => {
    if (
      typeof viewType !== "string" ||
      viewType.length === 0 ||
      !(filePath === undefined || (typeof filePath === "string" && filePath.length > 0))
    ) {
      throw new Error("Opening a plugin view requires a view type and optional file path.");
    }
    return serializePluginOperation(() => workspaceController.openPluginView(viewType, filePath));
  });
  ipcMain.handle(ipcChannels.closePluginView, (event) => {
    if (!isMainRendererSender(event.sender)) {
      throw new Error("Closing a plugin view requires the active Threadleaf window.");
    }
    return serializePluginOperation(() => closeCompatibilityPluginView());
  });
  ipcMain.handle(ipcChannels.setPluginSurfaceBounds, (_event, value: unknown) => {
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
  ipcMain.handle(ipcChannels.setPluginSurfaceVisible, (_event, visible: unknown) => {
    if (typeof visible !== "boolean") {
      throw new Error("Plugin surface visibility must be a boolean.");
    }
    setPluginSurfacePresentationVisible(visible);
  });
  ipcMain.handle(ipcChannels.setPluginSurfaceTheme, async (_event, theme: unknown) => {
    if (theme !== "dark" && theme !== "light") {
      throw new Error("Plugin surface theme must be dark or light.");
    }
    await applyPluginSurfaceTheme(theme);
  });
  ipcMain.handle(ipcChannels.setPluginSurfaceAccessibility, async (_event, value: unknown) => {
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
  });
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

async function createWindow(): Promise<void> {
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
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;

  let boundsTimer: NodeJS.Timeout | undefined;
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

  window.once("ready-to-show", () => window.show());
  window.webContents.on("render-process-gone", (_event, details) => {
    recoverMainRenderer({ reason: details.reason, exitCode: details.exitCode });
  });
  window.on("unresponsive", () => {
    console.error("Threadleaf main window became unresponsive");
  });
  window.once("closed", () => {
    if (boundsTimer !== undefined) {
      clearTimeout(boundsTimer);
      boundsTimer = undefined;
    }
    if (mainWindow === window) {
      attachedPluginView = null;
      mainWindow = null;
    }
  });
  await window.loadFile(join(__dirname, "..", "renderer", "index.html"));
  setPluginSurfacePresentationVisible(true);
}

async function replaceMainWindowAfterCrash(): Promise<void> {
  const stoppedWindow = mainWindow;
  if (!stoppedWindow || stoppedWindow.isDestroyed()) {
    throw new Error("The stopped main window is no longer available.");
  }
  await createWindow();
  stoppedWindow.destroy();
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
    compatibilityPluginWebContents.clear();
    visiblePluginViews.clear();
    pluginSurfaceCssKeys.clear();
  },
  quit: () => app.quit(),
  reportError: (error) => console.error("Threadleaf shutdown cleanup failed:", error),
});

app.whenReady().then(async () => {
  appUpdateController = await createAppUpdateController();
  pluginPackageManager = new PluginPackageManager(
    join(app.getPath("userData"), "plugin-packages"),
    new OpenPluginPackageSource(),
  );
  await pluginPackageManager.initialize();
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
  let migrationInterrupted = false;
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
    migrationInterruptPhase
      ? {
          afterPhase: (phase) => {
            if (phase === migrationInterruptPhase && !migrationInterrupted) {
              migrationInterrupted = true;
              process.kill(process.pid, "SIGKILL");
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
      await createWindow();
    }
  });
});

app.on("before-quit", gracefulShutdownHandler);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
