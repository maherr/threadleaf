import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { type IpcMainEvent, type RenderProcessGoneDetails, WebContentsView } from "electron";
import type { PluginRuntimePort } from "../runtime/plugin-runtime-port";
import type { PluginEditorContext, RuntimeSnapshot } from "../shared/contracts";
import {
  type PluginRendererOperation,
  type PluginRendererRequest,
  type PluginRendererResponse,
  parsePluginRendererResponse,
  pluginRendererChannels,
} from "../shared/plugin-runtime-protocol";

interface ElectronPluginRuntimeOptions {
  hostHtmlPath: string;
  onSurfaceVisibilityChange?(view: WebContentsView, visible: boolean): void;
  packageJsonPath: string;
  vaultPath: string;
}

interface PendingRequest {
  reject(error: Error): void;
  resolve(value: RuntimeSnapshot | null): void;
  timeout: NodeJS.Timeout;
}

const startupTimeoutMs = 10_000;
const operationTimeoutMs = 30_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ElectronPluginRuntime implements PluginRuntimePort {
  readonly view: WebContentsView;
  private readonly pending = new Map<string, PendingRequest>();
  private ready = false;
  private closed = false;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private readonly onSurfaceVisibilityChange:
    | ((view: WebContentsView, visible: boolean) => void)
    | undefined;
  private surfaceVisible = false;

  private constructor(
    view: WebContentsView,
    onSurfaceVisibilityChange?: (view: WebContentsView, visible: boolean) => void,
  ) {
    this.view = view;
    this.onSurfaceVisibilityChange = onSurfaceVisibilityChange;
    view.webContents.on("ipc-message", this.handleIpcMessage);
    view.webContents.on("render-process-gone", this.handleRendererGone);
  }

  static async open(options: ElectronPluginRuntimeOptions): Promise<ElectronPluginRuntime> {
    const partition = `threadleaf-plugin-${randomUUID()}`;
    const view = new WebContentsView({
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: false,
        nodeIntegration: true,
        partition,
        sandbox: false,
        spellcheck: false,
        webviewTag: false,
      },
    });
    view.webContents.session.setPermissionCheckHandler(() => false);
    view.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false);
    });
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const hostUrl = pathToFileURL(options.hostHtmlPath).toString();
    view.webContents.on("will-navigate", (event, url) => {
      if (url !== hostUrl) {
        event.preventDefault();
      }
    });

    const runtime = new ElectronPluginRuntime(view, options.onSurfaceVisibilityChange);
    try {
      const ready = runtime.waitUntilReady();
      await Promise.all([view.webContents.loadFile(options.hostHtmlPath), ready]);
      await runtime.requestSnapshot("initialize", {
        packageJsonPath: options.packageJsonPath,
        vaultPath: options.vaultPath,
      });
      return runtime;
    } catch (error) {
      await runtime.destroy(errorMessage(error));
      throw error;
    }
  }

  getSnapshot(): Promise<RuntimeSnapshot> {
    return this.requestSnapshot("get-snapshot");
  }

  closePluginView(): Promise<RuntimeSnapshot> {
    return this.requestSnapshot("close-view");
  }

  loadPlugin(pluginDirectory: string): Promise<RuntimeSnapshot> {
    return this.requestSnapshot("load-plugin", { pluginDirectory });
  }

  reloadPlugin(pluginId?: string): Promise<RuntimeSnapshot> {
    return this.requestSnapshot("reload-plugin", pluginId ? { pluginId } : undefined);
  }

  runCommand(commandId: string, editorContext?: PluginEditorContext): Promise<RuntimeSnapshot> {
    return this.requestSnapshot("run-command", {
      commandId,
      ...(editorContext ? { editorContext } : {}),
    });
  }

  unloadAllPlugins(): Promise<RuntimeSnapshot> {
    return this.requestSnapshot("unload-all");
  }

  unloadPlugin(pluginId?: string): Promise<RuntimeSnapshot> {
    return this.requestSnapshot("unload-plugin", pluginId ? { pluginId } : undefined);
  }

  markLayoutReady(): Promise<RuntimeSnapshot> {
    return this.requestSnapshot("mark-layout-ready");
  }

  openPluginView(viewType: string, filePath?: string): Promise<RuntimeSnapshot> {
    return this.requestSnapshot("open-view", {
      viewType,
      ...(filePath ? { filePath } : {}),
    });
  }

  private setSurfaceVisible(visible: boolean): void {
    if (this.surfaceVisible === visible) {
      return;
    }
    this.surfaceVisible = visible;
    this.onSurfaceVisibilityChange?.(this.view, visible);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    try {
      await this.request("close", undefined, 5_000);
    } catch {
      // Closing the WebContents remains the final cleanup boundary.
    }
    await this.destroy("Plugin compatibility renderer closed.");
  }

  private waitUntilReady(): Promise<void> {
    if (this.ready) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.ready) {
          this.readyResolve = null;
          this.readyReject = null;
          reject(new Error("Plugin compatibility renderer did not become ready in time."));
        }
      }, startupTimeoutMs);
      this.readyResolve = () => {
        clearTimeout(timeout);
        resolve();
      };
      this.readyReject = (error) => {
        clearTimeout(timeout);
        reject(error);
      };
    });
  }

  private requestSnapshot(
    operation: PluginRendererOperation,
    payload?: Record<string, unknown>,
  ): Promise<RuntimeSnapshot> {
    return this.request(operation, payload).then((snapshot) => {
      if (!snapshot) {
        throw new Error(`Plugin renderer ${operation} returned no snapshot.`);
      }
      this.setSurfaceVisible(snapshot.pluginSurface !== null);
      return snapshot;
    });
  }

  private request(
    operation: PluginRendererOperation,
    payload?: Record<string, unknown>,
    timeoutMs = operationTimeoutMs,
  ): Promise<RuntimeSnapshot | null> {
    if (!this.ready || this.closed || this.view.webContents.isDestroyed()) {
      return Promise.reject(new Error("Plugin compatibility renderer is not available."));
    }
    const id = randomUUID();
    const request: PluginRendererRequest = { id, operation, ...(payload ? { payload } : {}) };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Plugin renderer operation timed out: ${operation}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.view.webContents.send(pluginRendererChannels.request, request);
    });
  }

  private readonly handleIpcMessage = (
    _event: IpcMainEvent,
    channel: string,
    ...args: unknown[]
  ): void => {
    if (channel === pluginRendererChannels.ready) {
      this.ready = true;
      this.readyResolve?.();
      this.readyResolve = null;
      this.readyReject = null;
      return;
    }
    if (channel !== pluginRendererChannels.response) {
      return;
    }
    let response: PluginRendererResponse;
    try {
      response = parsePluginRendererResponse(args[0]);
    } catch (error) {
      this.rejectAll(errorMessage(error));
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(response.id);
    if (response.ok) {
      pending.resolve(response.value);
    } else {
      pending.reject(new Error(response.error));
    }
  };

  private readonly handleRendererGone = (
    _event: Electron.Event,
    details: RenderProcessGoneDetails,
  ): void => {
    const message = `Plugin compatibility renderer stopped (${details.reason}, exit ${details.exitCode}).`;
    this.setSurfaceVisible(false);
    this.readyReject?.(new Error(message));
    this.rejectAll(message);
    this.closed = true;
  };

  private rejectAll(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }

  private async destroy(reason: string): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.setSurfaceVisible(false);
    this.ready = false;
    this.readyReject?.(new Error(reason));
    this.readyResolve = null;
    this.readyReject = null;
    this.rejectAll(reason);
    this.view.webContents.removeListener("ipc-message", this.handleIpcMessage);
    this.view.webContents.removeListener("render-process-gone", this.handleRendererGone);
    if (!this.view.webContents.isDestroyed()) {
      this.view.webContents.close();
    }
  }
}
