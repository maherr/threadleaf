import { join, resolve } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type OpenDialogOptions,
  type WebContents,
  type WebContentsView,
} from "electron";
import { AppSettingsController } from "../application/app-settings-controller";
import { WorkspaceController } from "../application/workspace-controller";
import { FixedStateRoot } from "../kernel/ports";
import { RecoveringPluginRuntime } from "../runtime/recovering-plugin-runtime";
import { type AppearanceResponse, parseVaultAppearanceSettings } from "../shared/appearance";
import type { PluginSurfaceBounds, PluginUpdateResponse } from "../shared/contracts";
import { ipcChannels } from "../shared/ipc-channels";
import { isShortcutTargetId } from "../shared/key-bindings";
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
} from "../shared/plugins";
import {
  readDevelopmentPickerOverride,
  readDevelopmentVaultPath,
} from "./development-picker-override";
import { ElectronPluginRuntime } from "./electron-plugin-runtime";
import { FileAppSettingsStore } from "./file-app-settings-store";
import { FileVaultSelectionStore } from "./file-vault-selection-store";
import { FileWorkspaceStateStore } from "./file-workspace-state-store";
import { createGracefulShutdownHandler } from "./graceful-shutdown";
import { loadObsidianMigrationPreview } from "./obsidian-migration-loader";
import { loadVaultAppearance } from "./vault-appearance-loader";
import { discoverVaultPlugins, loadVaultPluginCatalog } from "./vault-plugin-loader";

let mainWindow: BrowserWindow | null = null;
let workspaceController: WorkspaceController;
let settingsController: AppSettingsController;
let pluginOperationTail: Promise<void> = Promise.resolve();
let attachedPluginView: WebContentsView | null = null;
let compatibilityPluginView: WebContentsView | null = null;
let pluginSurfaceBounds: PluginSurfaceBounds = { x: 0, y: 0, width: 0, height: 0 };
let pluginSurfaceCss = "";
let pluginSurfaceCssKey: string | null = null;
let pluginSurfaceCssWebContents: WebContents | null = null;
let compatibilityPluginWebContents: WebContents | null = null;
let pluginSurfaceTheme: "dark" | "light" = "dark";
let pluginSurfacePresentationVisible = true;
let pluginRuntimeSurfaceVisible = false;

async function applyPluginSurfaceTheme(
  theme: "dark" | "light",
  webContents = compatibilityPluginWebContents,
): Promise<void> {
  pluginSurfaceTheme = theme;
  if (!webContents || webContents.isDestroyed()) {
    return;
  }
  await webContents.executeJavaScript(`
    (() => {
      const theme = ${JSON.stringify(theme)};
      document.documentElement.dataset.theme = theme;
      for (const target of [document.documentElement, document.body]) {
        target.classList.toggle("theme-dark", theme === "dark");
        target.classList.toggle("theme-light", theme === "light");
      }
    })()
  `);
}

async function applyPluginSurfaceCss(
  css: string,
  view = compatibilityPluginView,
  webContents = compatibilityPluginWebContents,
): Promise<void> {
  pluginSurfaceCss = css;
  const previousWebContents = pluginSurfaceCssWebContents;
  const previousKey = pluginSurfaceCssKey;
  pluginSurfaceCssWebContents = null;
  pluginSurfaceCssKey = null;
  if (previousWebContents && previousKey && !previousWebContents.isDestroyed()) {
    await previousWebContents.removeInsertedCSS(previousKey).catch(() => undefined);
  }
  if (!view || !webContents || webContents.isDestroyed() || !css) {
    return;
  }
  const key = await webContents.insertCSS(css, { cssOrigin: "author" });
  if (webContents.isDestroyed() || view !== compatibilityPluginView) {
    if (!webContents.isDestroyed()) {
      await webContents.removeInsertedCSS(key).catch(() => undefined);
    }
    return;
  }
  pluginSurfaceCssWebContents = webContents;
  pluginSurfaceCssKey = key;
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
  if (view === compatibilityPluginView) {
    pluginRuntimeSurfaceVisible = visible;
  }
  if (!visible) {
    if (attachedPluginView === view) {
      detachPluginView();
    }
    return;
  }
  if (!pluginSurfacePresentationVisible || view !== compatibilityPluginView) {
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
  const view = compatibilityPluginView;
  if (view && pluginRuntimeSurfaceVisible) {
    setPluginViewVisibility(view, true);
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
  const catalog = await loadVaultPluginCatalog({
    vaultPath,
    vaultId: expectedVaultId,
    preference: settingsController.getVaultPlugins(expectedVaultId),
    safeMode: pluginSafeMode(),
  });
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

async function reconcileCompatibilityPlugins(expectedVaultId: string, forceReload = false) {
  if (workspaceController.vaultId !== expectedVaultId) {
    throw new Error("The active vault changed before plugin reconciliation.");
  }
  const vaultPath = workspaceController.vaultPath;
  const preference = settingsController.getVaultPlugins(expectedVaultId);
  const discovery = await discoverVaultPlugins(vaultPath);
  const packagesById = new Map(discovery.plugins.map((plugin) => [plugin.summary.id, plugin]));
  const pluginsAllowed = preference.compatibilityMode === "enabled" && !pluginSafeMode();
  const targetIds = new Set(
    pluginsAllowed
      ? preference.enabledPluginIds.filter(
          (pluginId) => packagesById.get(pluginId)?.summary.packageState === "ready",
        )
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
    if (!installed) {
      continue;
    }
    const runtimePlugin = (snapshot.plugins ?? []).find((plugin) => plugin.id === pluginId);
    if (!forceReload && runtimePlugin?.state === "loaded") {
      continue;
    }
    try {
      snapshot = await workspaceController.loadPlugin(installed.directoryPath);
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
  const fixtureVaultPath = join(app.getAppPath(), "fixtures", "vaults", "basic");
  const userDataPath = app.getPath("userData");
  return WorkspaceController.open({
    fixtureVaultPath,
    stateRoot: new FixedStateRoot(userDataPath),
    selectionStore: new FileVaultSelectionStore(join(userDataPath, "workspace-selection.json")),
    workspaceStateStore: new FileWorkspaceStateStore(join(userDataPath, "workspaces")),
    pluginRuntimeFactory: async (vaultPath) => {
      const pluginOperationTimeout = developmentPluginOperationTimeout();
      return RecoveringPluginRuntime.open({
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
        onRuntimeChange: async (runtime) => {
          if (attachedPluginView === compatibilityPluginView) {
            detachPluginView();
          }
          pluginRuntimeSurfaceVisible = false;
          compatibilityPluginView = runtime.view;
          compatibilityPluginWebContents = runtime.view.webContents;
          await applyPluginSurfaceTheme(pluginSurfaceTheme, compatibilityPluginWebContents);
          await applyPluginSurfaceCss(
            pluginSurfaceCss,
            runtime.view,
            compatibilityPluginWebContents,
          );
        },
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

function registerIpcHandlers(): void {
  ipcMain.handle(pluginRendererChannels.vaultCreate, async (event, value: unknown) => {
    const pluginWebContents = compatibilityPluginWebContents;
    if (
      !pluginWebContents ||
      pluginWebContents.isDestroyed() ||
      event.sender !== pluginWebContents
    ) {
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
    const pluginWebContents = compatibilityPluginWebContents;
    if (
      !pluginWebContents ||
      pluginWebContents.isDestroyed() ||
      event.sender !== pluginWebContents
    ) {
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
    const pluginWebContents = compatibilityPluginWebContents;
    if (
      !pluginWebContents ||
      pluginWebContents.isDestroyed() ||
      event.sender !== pluginWebContents
    ) {
      throw new Error("Plugin vault folder creates require the active compatibility renderer.");
    }
    const request = parsePluginVaultCreateFolderRequest(value);
    if (resolve(request.vaultPath) !== resolve(workspaceController.vaultPath)) {
      throw new Error("The active vault changed before the plugin folder could be created.");
    }
    return workspaceController.createPluginFolder(request.folderPath, workspaceController.vaultId);
  });
  ipcMain.handle(pluginRendererChannels.vaultRename, async (event, value: unknown) => {
    const pluginWebContents = compatibilityPluginWebContents;
    if (
      !pluginWebContents ||
      pluginWebContents.isDestroyed() ||
      event.sender !== pluginWebContents
    ) {
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
    const pluginWebContents = compatibilityPluginWebContents;
    if (
      !pluginWebContents ||
      pluginWebContents.isDestroyed() ||
      event.sender !== pluginWebContents
    ) {
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
    const pluginWebContents = compatibilityPluginWebContents;
    if (
      !pluginWebContents ||
      pluginWebContents.isDestroyed() ||
      event.sender !== pluginWebContents
    ) {
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
    const pluginWebContents = compatibilityPluginWebContents;
    if (
      !pluginWebContents ||
      pluginWebContents.isDestroyed() ||
      event.sender !== pluginWebContents
    ) {
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
        if (enabled) {
          const discovery = await discoverVaultPlugins(workspaceController.vaultPath);
          const plugin = discovery.plugins.find((candidate) => candidate.summary.id === pluginId);
          if (plugin?.summary.packageState !== "ready") {
            throw new Error(`Plugin ${pluginId} is not installed as a valid package.`);
          }
        }
        const current = settingsController.getVaultPlugins(expectedVaultId);
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
  ipcMain.handle(ipcChannels.openNote, (_event, filePath: unknown) => {
    if (typeof filePath !== "string") {
      throw new Error("Open note requires a string path.");
    }
    return workspaceController.openNote(filePath);
  });
  ipcMain.handle(ipcChannels.closeNote, (_event, filePath: unknown, expectedVaultId: unknown) => {
    if (typeof filePath !== "string" || typeof expectedVaultId !== "string") {
      throw new Error("Close note requires string path and vault values.");
    }
    return workspaceController.closeNote(filePath, expectedVaultId);
  });
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
    return serializePluginOperation(() => workspaceController.reloadPlugin(pluginId));
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
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(ipcChannels.settingsChanged, snapshot);
    }
  });
}

async function createWindow(): Promise<void> {
  detachPluginView();
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
  mainWindow.once("closed", () => {
    attachedPluginView = null;
    mainWindow = null;
  });
  await mainWindow.loadFile(join(__dirname, "..", "renderer", "index.html"));
}

app.whenReady().then(async () => {
  settingsController = await AppSettingsController.open(
    new FileAppSettingsStore(join(app.getPath("userData"), "settings.json")),
  );
  workspaceController = await createWorkspaceController();
  registerIpcHandlers();
  await createWindow();
  void activateInitialWorkspace().catch((error: unknown) => {
    console.error("Initial vault activation failed", error);
  });

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on(
  "before-quit",
  createGracefulShutdownHandler({
    prepare: detachPluginView,
    close: () => workspaceController?.close(),
    finalize: () => {
      compatibilityPluginView = null;
      compatibilityPluginWebContents = null;
      pluginSurfaceCssWebContents = null;
      pluginSurfaceCssKey = null;
    },
    quit: () => app.quit(),
    reportError: (error) => console.error("Threadleaf shutdown cleanup failed:", error),
  }),
);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
