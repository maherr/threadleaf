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
  type WebContents,
  type WebContentsView,
} from "electron";
import { AppSettingsController } from "../application/app-settings-controller";
import { AppUpdateController } from "../application/app-update-controller";
import { parseEditorDraft } from "../application/editor-draft";
import { parseVaultGraphRequest } from "../application/vault-graph";
import { WorkspaceController } from "../application/workspace-controller";
import { atomicWriteFile } from "../kernel/durability";
import { FixedStateRoot } from "../kernel/ports";
import { IsolatedPluginRuntime } from "../runtime/isolated-plugin-runtime";
import { RecoveringPluginRuntime } from "../runtime/recovering-plugin-runtime";
import { type AppearanceResponse, parseVaultAppearanceSettings } from "../shared/appearance";
import {
  type NotePropertyType,
  notePropertyTypes,
  type PluginPackageApplyResponse,
  type PluginSurfaceBounds,
  type PluginUpdateResponse,
} from "../shared/contracts";
import { ipcChannels } from "../shared/ipc-channels";
import type { AppSettings } from "../shared/key-bindings";
import { isShortcutTargetId } from "../shared/key-bindings";
import type { NativeMenuCommandId } from "../shared/native-menu";
import { parseVaultNoteWorkflowSettings } from "../shared/note-workflows";
import { parsePluginPackagePreviewRequest } from "../shared/plugin-packages";
import {
  parsePluginEditorContext,
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
import type { SupportBundleExportResponse } from "../shared/support-bundle";
import { createApplicationMenuTemplate } from "./application-menu";
import {
  readDevelopmentPickerOverride,
  readDevelopmentVaultPath,
} from "./development-picker-override";
import { ElectronPluginRuntime } from "./electron-plugin-runtime";
import { FileAppSettingsStore } from "./file-app-settings-store";
import { FileEditorDraftStore } from "./file-editor-draft-store";
import { FileVaultSelectionStore } from "./file-vault-selection-store";
import { FileWorkspaceStateStore } from "./file-workspace-state-store";
import { createGracefulShutdownHandler } from "./graceful-shutdown";
import { createMainRendererRecoveryHandler } from "./main-renderer-recovery";
import { loadObsidianMigrationPreview } from "./obsidian-migration-loader";
import { OpenPluginPackageSource } from "./open-plugin-package-source";
import { appUpdateDisabledReason, readPackageUpdateTrust } from "./package-update-trust";
import { PluginPackageManager } from "./plugin-package-manager";
import {
  createSupportBundleMarkdown,
  isSupportBundleTargetOutsideVault,
  readDevelopmentSupportBundlePath,
} from "./support-bundle";
import { loadVaultAppearance } from "./vault-appearance-loader";
import { discoverVaultPlugins, loadVaultPluginCatalog } from "./vault-plugin-loader";

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
let appUpdateController: AppUpdateController;
let editorDraftStore: FileEditorDraftStore;
let pluginPackageManager: PluginPackageManager;
let pluginOperationTail: Promise<void> = Promise.resolve();
let initialWorkspaceActivation: Promise<void> | null = null;
let attachedPluginView: WebContentsView | null = null;
const compatibilityPluginViews = new Set<WebContentsView>();
const compatibilityPluginWebContents = new Set<WebContents>();
const visiblePluginViews = new Set<WebContentsView>();
let pluginSurfaceBounds: PluginSurfaceBounds = { x: 0, y: 0, width: 0, height: 0 };
let pluginSurfaceCss = "";
const pluginSurfaceCssKeys = new Map<WebContents, string>();
let pluginSurfaceTheme: "dark" | "light" = "dark";
let pluginSurfacePresentationVisible = true;

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
  if (attachedPluginView && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.contentView.removeChildView(attachedPluginView);
  }
  attachedPluginView = null;
}

function updatePluginViewBounds(): void {
  if (!attachedPluginView || pluginSurfaceBounds.width <= 0 || pluginSurfaceBounds.height <= 0) {
    return;
  }
  attachedPluginView.setBounds(pluginSurfaceBounds);
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
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (attachedPluginView && attachedPluginView !== view) {
    detachPluginView();
  }
  if (attachedPluginView !== view) {
    mainWindow.contentView.addChildView(view);
    attachedPluginView = view;
  }
  updatePluginViewBounds();
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
  });
  await Promise.all([
    applyPluginSurfaceTheme(pluginSurfaceTheme, webContents),
    applyPluginSurfaceCss(pluginSurfaceCss, view),
  ]);
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
  const vaultPath = workspaceController.vaultPath;
  const preview = await loadObsidianMigrationPreview({
    vaultPath,
    vaultId: expectedVaultId,
    selectedPluginIds: settingsController.getVaultPlugins(expectedVaultId).enabledPluginIds,
  });
  if (
    workspaceController.vaultId !== expectedVaultId ||
    workspaceController.vaultPath !== vaultPath
  ) {
    return { status: "stale-vault", vaultId: workspaceController.vaultId } as const;
  }
  return { status: "ready", preview } as const;
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
    workspaceStateStore: new FileWorkspaceStateStore(join(userDataPath, "workspaces")),
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
  const outcome = await workspaceController.activateDeferredInitialVault();
  if (outcome.status === "superseded") {
    return;
  }
  const expectedVaultId = outcome.snapshot.vault.id;
  if (expectedVaultId && workspaceController.vaultId === expectedVaultId) {
    await serializePluginOperation(() => reconcileCompatibilityPlugins(expectedVaultId));
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
  ipcMain.handle(ipcChannels.snapshot, () => workspaceController.getSnapshot());
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
  ipcMain.handle(ipcChannels.settings, () => settingsController.getSnapshot());
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
  ipcMain.handle(ipcChannels.migrationPreview, (_event, expectedVaultId: unknown) => {
    if (typeof expectedVaultId !== "string") {
      throw new Error("Migration preview requires a string vault identity.");
    }
    return currentMigrationPreview(expectedVaultId);
  });
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
        snapshot: await serializePluginOperation(async () => {
          const opened = await workspaceController.switchVault(selectedPath);
          return reconcileCompatibilityPlugins(opened.vault.id ?? workspaceController.vaultId);
        }),
      } as const;
    } catch (error) {
      return {
        status: "failed",
        message: describeVaultOpenFailure(error),
        snapshot: await workspaceController.getSnapshot(),
      } as const;
    }
  });
  ipcMain.handle(ipcChannels.openNote, (_event, filePath: unknown, paneId: unknown) => {
    if (
      typeof filePath !== "string" ||
      !(paneId === undefined || paneId === "primary" || paneId === "secondary")
    ) {
      throw new Error("Open note requires a string path and optional pane ID.");
    }
    return workspaceController.openNote(filePath, paneId);
  });
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
    ipcChannels.moveNote,
    (
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
      return workspaceController.moveNote(
        filePath,
        targetPath,
        expectedRevision,
        expectedVaultId,
        confirmationId,
      );
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
  ipcMain.handle(ipcChannels.closePluginView, () =>
    serializePluginOperation(() => workspaceController.closePluginView()),
  );
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
  workspaceController.onSnapshot((snapshot) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(ipcChannels.snapshotChanged, snapshot);
    }
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
}

async function createWindow(): Promise<void> {
  detachPluginView();
  const window = new BrowserWindow({
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
  mainWindow = window;

  window.once("ready-to-show", () => window.show());
  window.webContents.on("render-process-gone", (_event, details) => {
    recoverMainRenderer({ reason: details.reason, exitCode: details.exitCode });
  });
  window.on("unresponsive", () => {
    console.error("Threadleaf main window became unresponsive");
  });
  window.once("closed", () => {
    if (mainWindow === window) {
      attachedPluginView = null;
      mainWindow = null;
    }
  });
  await window.loadFile(join(__dirname, "..", "renderer", "index.html"));
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
  prepare: detachPluginView,
  close: () => workspaceController?.close(),
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
  settingsController = await AppSettingsController.open(
    new FileAppSettingsStore(join(app.getPath("userData"), "settings.json")),
  );
  installApplicationMenu(settingsController.getSnapshot().settings);
  editorDraftStore = new FileEditorDraftStore(join(app.getPath("userData"), "editor-drafts"));
  workspaceController = await createWorkspaceController();
  registerIpcHandlers();
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
