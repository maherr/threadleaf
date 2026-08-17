import { randomUUID } from "node:crypto";
import type { IpcMainEvent, RenderProcessGoneDetails, WebContents } from "electron";
import {
  FatalPluginRuntimeError,
  type PluginConstructionPolicyResolverPort,
  type PluginRuntimePort,
} from "../runtime/plugin-runtime-port";
import type {
  PluginEditorContext,
  PluginMutationWaitOptions,
  RuntimeSnapshot,
} from "../shared/contracts";
import {
  type PluginRendererOperation,
  type PluginRendererRequest,
  type PluginRendererResponse,
  parsePluginRendererResponse,
  pluginRendererChannels,
} from "../shared/plugin-runtime-protocol";
import type { PluginConstructionDispatch, PluginConstructionRequest } from "../shared/plugins";

export interface TrustedWorkspacePluginRuntimeOptions {
  attachTrustedPackageFiles(
    dispatch: PluginConstructionDispatch,
  ): Promise<PluginConstructionDispatch>;
  constructionPolicyResolver: PluginConstructionPolicyResolverPort;
  hostFactoryPath: string;
  operationTimeoutMs?: number;
  packageJsonPath: string;
  vaultPath: string;
}

interface PendingRequest {
  reject(error: Error): void;
  resolve(value: RuntimeSnapshot | null): void;
  timeout: ReturnType<typeof setTimeout>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The trusted topology deliberately has no child WebContents or resource monitor. The page's
 * main renderer owns the native editors and the plugin globals, while this adapter keeps the
 * construction decision and lifecycle authority in the main process.
 */
export class TrustedWorkspacePluginRuntime implements PluginRuntimePort {
  private readonly pending = new Map<string, PendingRequest>();
  private ready = false;
  private closed = false;
  private rendererDead = false;
  private webContents: WebContents;

  private constructor(
    webContents: WebContents,
    private readonly options: TrustedWorkspacePluginRuntimeOptions,
  ) {
    this.webContents = webContents;
    this.webContents.on("ipc-message", this.handleIpcMessage);
    this.webContents.on("render-process-gone", this.handleRendererGone);
  }

  static async open(
    webContents: WebContents,
    options: TrustedWorkspacePluginRuntimeOptions,
  ): Promise<TrustedWorkspacePluginRuntime> {
    const runtime = new TrustedWorkspacePluginRuntime(webContents, options);
    try {
      await runtime.initialize();
      return runtime;
    } catch (error) {
      await runtime.close().catch(() => undefined);
      throw error;
    }
  }

  async rebind(webContents: WebContents): Promise<void> {
    if (this.closed) {
      throw new Error("Trusted workspace compatibility runtime is closed.");
    }
    this.detach(this.webContents);
    this.rejectPending(
      new FatalPluginRuntimeError("renderer-rebind", "Trusted workspace renderer was replaced."),
    );
    this.webContents = webContents;
    this.ready = false;
    this.rendererDead = false;
    this.webContents.on("ipc-message", this.handleIpcMessage);
    this.webContents.on("render-process-gone", this.handleRendererGone);
    await this.initialize();
  }

  getSnapshot(): Promise<RuntimeSnapshot> {
    return this.requestSnapshot("get-snapshot");
  }

  closePluginView(): Promise<RuntimeSnapshot> {
    return this.requestSnapshot("close-view");
  }

  async loadPlugin(request: PluginConstructionRequest): Promise<RuntimeSnapshot> {
    const dispatch = await this.options.constructionPolicyResolver.resolveAndConsume(request);
    return this.requestSnapshot("load-plugin", {
      dispatch: await this.options.attachTrustedPackageFiles(dispatch),
    });
  }

  async reloadPlugin(request?: PluginConstructionRequest): Promise<RuntimeSnapshot> {
    if (!request) {
      throw new Error("Plugin reload requires an exact package construction request.");
    }
    const dispatch = await this.options.constructionPolicyResolver.resolveAndConsume(request);
    return this.requestSnapshot("reload-plugin", {
      dispatch: await this.options.attachTrustedPackageFiles(dispatch),
    });
  }

  runCommand(commandId: string, editorContext?: PluginEditorContext): Promise<RuntimeSnapshot> {
    return this.requestSnapshot("run-command", {
      commandId,
      ...(editorContext ? { editorContext } : {}),
    });
  }

  renderMarkdownProjection(
    pluginId: string,
    sourcePath: string,
    content: string,
  ): Promise<RuntimeSnapshot> {
    return this.requestSnapshot("render-markdown", { pluginId, sourcePath, content });
  }

  waitForPluginMutations(options?: PluginMutationWaitOptions): Promise<RuntimeSnapshot> {
    return this.requestSnapshot(
      "wait-for-mutations",
      options && Object.keys(options).length > 0 ? { ...options } : undefined,
    );
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

  openPluginSettings(pluginId: string): Promise<RuntimeSnapshot> {
    return this.requestSnapshot("open-settings", { pluginId });
  }

  openPluginView(viewType: string, filePath?: string): Promise<RuntimeSnapshot> {
    return this.requestSnapshot("open-view", {
      viewType,
      ...(filePath ? { filePath } : {}),
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    if (this.ready && !this.webContents.isDestroyed()) {
      await this.request("close", undefined, false).catch(() => undefined);
    }
    this.closed = true;
    this.detach(this.webContents);
    this.rejectPending(new Error("Trusted workspace compatibility runtime closed."));
  }

  private async initialize(): Promise<void> {
    const snapshot = await this.request(
      "initialize",
      {
        hostFactoryPath: this.options.hostFactoryPath,
        packageJsonPath: this.options.packageJsonPath,
        vaultPath: this.options.vaultPath,
      },
      true,
    );
    if (!snapshot) {
      throw new Error("Trusted workspace plugin host returned no initialization snapshot.");
    }
    this.ready = true;
  }

  private requestSnapshot(
    operation: PluginRendererOperation,
    payload?: Record<string, unknown>,
  ): Promise<RuntimeSnapshot> {
    return this.request(operation, payload).then((snapshot) => {
      if (!snapshot) {
        throw new FatalPluginRuntimeError(
          operation,
          `Trusted workspace plugin host returned no snapshot for ${operation}.`,
        );
      }
      return snapshot;
    });
  }

  private request(
    operation: PluginRendererOperation,
    payload?: Record<string, unknown>,
    allowBeforeReady = false,
  ): Promise<RuntimeSnapshot | null> {
    if (
      this.closed ||
      (!allowBeforeReady && !this.ready) ||
      this.rendererDead ||
      this.webContents.isDestroyed()
    ) {
      return Promise.reject(
        new FatalPluginRuntimeError(operation, "Trusted workspace renderer is not available."),
      );
    }
    const id = randomUUID();
    const request: PluginRendererRequest = { id, operation, ...(payload ? { payload } : {}) };
    const timeoutMs = this.options.operationTimeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new FatalPluginRuntimeError(
            operation,
            `Trusted workspace plugin operation timed out: ${operation}.`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.webContents.send(pluginRendererChannels.request, request);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(
          new FatalPluginRuntimeError(
            operation,
            `Trusted workspace plugin request could not be sent: ${errorMessage(error)}`,
          ),
        );
      }
    });
  }

  private readonly handleIpcMessage = (
    event: IpcMainEvent,
    channel: string,
    ...args: unknown[]
  ): void => {
    if (event.sender !== this.webContents || channel !== pluginRendererChannels.response) {
      return;
    }
    let response: PluginRendererResponse;
    try {
      response = parsePluginRendererResponse(args[0]);
    } catch (error) {
      this.failRenderer(
        new FatalPluginRuntimeError(
          "response",
          `Trusted workspace plugin host returned an invalid response: ${errorMessage(error)}`,
        ),
      );
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
    if (this.closed) {
      return;
    }
    this.failRenderer(
      new FatalPluginRuntimeError(
        "renderer-exit",
        `Trusted workspace renderer stopped (${details.reason}, exit ${details.exitCode}).`,
      ),
    );
  };

  private failRenderer(error: FatalPluginRuntimeError): void {
    this.ready = false;
    this.rendererDead = true;
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private detach(webContents: WebContents): void {
    webContents.removeListener("ipc-message", this.handleIpcMessage);
    webContents.removeListener("render-process-gone", this.handleRendererGone);
  }
}
