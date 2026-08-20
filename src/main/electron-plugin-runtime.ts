import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  app as electronApp,
  type IpcMainEvent,
  type RenderProcessGoneDetails,
  WebContentsView,
} from "electron";
import {
  FatalPluginRuntimeError,
  type PluginConstructionPolicyResolverPort,
  type PluginRuntimePort,
} from "../runtime/plugin-runtime-port";
import type {
  PluginEditorContext,
  PluginMutationWaitOptions,
  PluginResourceDiagnostic,
  PluginSurfaceSnapshot,
  RuntimeSnapshot,
} from "../shared/contracts";
import {
  createPluginResourcePolicy,
  operationDeadlineMs,
  type PluginResourcePolicy,
  type PluginResourcePolicyOverrides,
  pluginRendererOperations,
} from "../shared/plugin-resource-policy";
import {
  type PluginRendererEnvironment,
  type PluginRendererOperation,
  type PluginRendererRequest,
  type PluginRendererResponse,
  parsePluginRendererResponse,
  pluginRendererChannels,
} from "../shared/plugin-runtime-protocol";
import type { PluginConstructionRequest } from "../shared/plugins";
import {
  type PluginRendererMetrics,
  type PluginResourceClock,
  type PluginResourceMetricsProvider,
  PluginResourceMonitor,
  resourceDiagnosticForDeadline,
} from "./plugin-resource-policy";

export interface ElectronPluginRuntimeOptions {
  constructionPolicyResolver?: PluginConstructionPolicyResolverPort;
  hostHtmlPath: string;
  onSurfaceVisibilityChange?(view: WebContentsView, surface: PluginSurfaceSnapshot | null): void;
  operationTimeoutMs?: number;
  resourcePolicy?: PluginResourcePolicy | PluginResourcePolicyOverrides;
  metricsProvider?: PluginResourceMetricsProvider;
  clock?: PluginResourceClock;
  packageJsonPath: string;
  vaultPath: string;
}

interface PendingRequest {
  reject(error: Error): void;
  resolve(value: RuntimeSnapshot | null): void;
  timeout: unknown;
  startedAt: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultMetricsProvider(): PluginResourceMetricsProvider {
  return {
    sample(rendererPid: number): PluginRendererMetrics | null {
      const electronAppValue = electronApp as unknown as
        | { getAppMetrics?: () => unknown[] }
        | undefined;
      const getAppMetrics = electronAppValue?.getAppMetrics;
      if (typeof getAppMetrics !== "function") {
        return null;
      }
      let metrics: unknown[];
      try {
        metrics = getAppMetrics.call(electronAppValue);
      } catch {
        return null;
      }
      const processMetric = metrics.find(
        (candidate): candidate is Record<string, unknown> =>
          Boolean(candidate && typeof candidate === "object" && "pid" in candidate) &&
          (candidate as Record<string, unknown>).pid === rendererPid,
      );
      if (!processMetric) {
        return null;
      }
      const cpu = processMetric.cpu;
      const memory = processMetric.memory;
      const cpuPercent =
        cpu &&
        typeof cpu === "object" &&
        typeof (cpu as Record<string, unknown>).percentCPUUsage === "number"
          ? ((cpu as Record<string, unknown>).percentCPUUsage as number)
          : null;
      const workingSetSize =
        memory &&
        typeof memory === "object" &&
        typeof (memory as Record<string, unknown>).workingSetSize === "number"
          ? ((memory as Record<string, unknown>).workingSetSize as number)
          : null;
      return {
        cpuPercent,
        memoryBytes:
          workingSetSize !== null && Number.isFinite(workingSetSize) && workingSetSize >= 0
            ? workingSetSize * 1024
            : null,
      };
    },
  };
}

function resolvePolicy(
  configured: PluginResourcePolicy | PluginResourcePolicyOverrides | undefined,
  operationTimeoutMs: number | undefined,
): PluginResourcePolicy {
  const overrides: PluginResourcePolicyOverrides =
    configured && "version" in configured
      ? {
          operationDeadlinesMs: { ...configured.operationDeadlinesMs },
          memoryCeilingBytes: configured.memoryCeilingBytes,
          cpuBudgetPercent: configured.cpuBudgetPercent,
          cpuSampleIntervalMs: configured.cpuSampleIntervalMs,
          cpuStartupQuietWindowMs: configured.cpuStartupQuietWindowMs,
          cpuConsecutiveSamples: configured.cpuConsecutiveSamples,
        }
      : (configured ?? {});
  if (Number.isFinite(operationTimeoutMs) && (operationTimeoutMs ?? 0) > 0) {
    overrides.operationDeadlinesMs = Object.fromEntries(
      pluginRendererOperations.map((operation) => [operation, operationTimeoutMs as number]),
    ) as PluginResourcePolicy["operationDeadlinesMs"];
  }
  return createPluginResourcePolicy(overrides);
}

export class ElectronPluginRuntime implements PluginRuntimePort {
  readonly view: WebContentsView;
  private readonly pending = new Map<string, PendingRequest>();
  private ready = false;
  private closed = false;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private readonly onSurfaceVisibilityChange:
    | ((view: WebContentsView, surface: PluginSurfaceSnapshot | null) => void)
    | undefined;
  private surfaceVisible = false;
  private readonly policy: PluginResourcePolicy;
  private readonly clock: PluginResourceClock;
  private readonly resourceMonitor: PluginResourceMonitor;
  private readonly resourceDiagnostics: PluginResourceDiagnostic[] = [];
  private activePluginId: string | undefined;
  private lastFatalError: FatalPluginRuntimeError | null = null;
  private readonly constructionPolicyResolver: PluginConstructionPolicyResolverPort;

  private constructor(
    view: WebContentsView,
    onSurfaceVisibilityChange?: (
      view: WebContentsView,
      surface: PluginSurfaceSnapshot | null,
    ) => void,
    policy = createPluginResourcePolicy(),
    metricsProvider = defaultMetricsProvider(),
    clock?: PluginResourceClock,
    constructionPolicyResolver?: PluginConstructionPolicyResolverPort,
  ) {
    this.view = view;
    this.onSurfaceVisibilityChange = onSurfaceVisibilityChange;
    this.policy = policy;
    this.clock = clock ?? {
      now: () => Date.now(),
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    };
    this.resourceMonitor = new PluginResourceMonitor(
      {
        operationDeadlinesMs: { ...this.policy.operationDeadlinesMs },
        memoryCeilingBytes: this.policy.memoryCeilingBytes,
        cpuBudgetPercent: this.policy.cpuBudgetPercent,
        cpuSampleIntervalMs: this.policy.cpuSampleIntervalMs,
        cpuStartupQuietWindowMs: this.policy.cpuStartupQuietWindowMs,
        cpuConsecutiveSamples: this.policy.cpuConsecutiveSamples,
      },
      {
        clock: this.clock,
        metricsProvider,
        onDiagnostic: (diagnostic) => this.recordResourceDiagnostic(diagnostic),
        onBreach: (diagnostic) => this.handleResourceBreach(diagnostic),
      },
    );
    this.constructionPolicyResolver =
      constructionPolicyResolver ??
      ({
        resolveAndConsume: async () => {
          throw new Error("Electron plugin runtime has no main-process construction resolver.");
        },
      } satisfies PluginConstructionPolicyResolverPort);
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

    const runtime = new ElectronPluginRuntime(
      view,
      options.onSurfaceVisibilityChange,
      resolvePolicy(options.resourcePolicy, options.operationTimeoutMs),
      options.metricsProvider,
      options.clock,
      options.constructionPolicyResolver,
    );
    try {
      const ready = runtime.waitUntilReady();
      await Promise.all([view.webContents.loadFile(options.hostHtmlPath), ready]);
      runtime.startResourceMonitoring();
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

  async seedVaultMarkdownPaths(paths: readonly string[]): Promise<void> {
    await this.requestSnapshot("seed-vault-markdown-paths", { paths: [...paths] });
  }

  applyEnvironment(environment: PluginRendererEnvironment): Promise<RuntimeSnapshot> {
    return this.requestSnapshot("apply-environment", { environment });
  }

  closePluginView(): Promise<RuntimeSnapshot> {
    return this.requestSnapshot("close-view");
  }

  async loadPlugin(request: PluginConstructionRequest): Promise<RuntimeSnapshot> {
    const dispatch = await this.constructionPolicyResolver.resolveAndConsume(request);
    return this.requestSnapshot("load-plugin", {
      dispatch,
    });
  }

  async reloadPlugin(request?: PluginConstructionRequest): Promise<RuntimeSnapshot> {
    if (!request) {
      throw new Error("Plugin reload requires an exact package construction request.");
    }
    const dispatch = await this.constructionPolicyResolver.resolveAndConsume(request);
    return this.requestSnapshot("reload-plugin", { dispatch });
  }

  runCommand(commandId: string, editorContext?: PluginEditorContext): Promise<RuntimeSnapshot> {
    return this.requestSnapshot("run-command", {
      commandId,
      ...(editorContext ? { editorContext } : {}),
    });
  }

  runPluginEditorPaste(
    editorContext: PluginEditorContext,
    clipboardText: string,
  ): Promise<RuntimeSnapshot> {
    return this.requestSnapshot("run-editor-paste", { editorContext, clipboardText });
  }

  queryPluginEditorSuggest(editorContext: PluginEditorContext): Promise<RuntimeSnapshot> {
    return this.requestSnapshot("query-editor-suggest", { editorContext });
  }

  selectPluginEditorSuggest(
    editorContext: PluginEditorContext,
    sessionId: string,
    itemIndex: number,
    shiftKey: boolean,
  ): Promise<RuntimeSnapshot> {
    return this.requestSnapshot("select-editor-suggest", {
      editorContext,
      sessionId,
      itemIndex,
      shiftKey,
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

  private setSurface(surface: PluginSurfaceSnapshot | null): void {
    const visible = surface !== null;
    if (this.surfaceVisible === visible && !visible) {
      return;
    }
    this.surfaceVisible = visible;
    this.onSurfaceVisibilityChange?.(this.view, surface ? { ...surface } : null);
  }

  private startResourceMonitoring(): void {
    const rendererPid = this.view.webContents.getProcessId?.() ?? 0;
    this.resourceMonitor.start(rendererPid);
  }

  private handleResourceBreach(diagnostic: PluginResourceDiagnostic): void {
    const resourceDiagnostic = this.decorateResourceDiagnostic(diagnostic);
    const reason =
      diagnostic.reason === "memory-ceiling"
        ? "memory ceiling"
        : diagnostic.reason === "cpu-budget"
          ? "sustained CPU budget"
          : "resource budget";
    const error = new FatalPluginRuntimeError(
      "resource-monitor",
      `Plugin renderer exceeded its ${reason}.`,
      resourceDiagnostic,
    );
    this.terminate(error);
  }

  private recordResourceDiagnostic(diagnostic: PluginResourceDiagnostic): void {
    const decorated = this.decorateResourceDiagnostic(diagnostic);
    this.resourceDiagnostics.push(decorated);
    if (this.resourceDiagnostics.length > 50) {
      this.resourceDiagnostics.splice(0, this.resourceDiagnostics.length - 50);
    }
  }

  private decorateResourceDiagnostic(
    diagnostic: PluginResourceDiagnostic,
  ): PluginResourceDiagnostic {
    return {
      ...diagnostic,
      ...(this.activePluginId ? { pluginId: this.activePluginId } : {}),
    };
  }

  private decorateResourceSnapshot(snapshot: RuntimeSnapshot): RuntimeSnapshot {
    const monitor = this.resourceMonitor.snapshot();
    return {
      ...snapshot,
      resourcePolicy: monitor.policy,
      resourceDiagnostics: this.resourceDiagnostics.map((diagnostic) => ({ ...diagnostic })),
    };
  }

  private unavailableError(operation: PluginRendererOperation): FatalPluginRuntimeError {
    if (this.lastFatalError) {
      return this.lastFatalError;
    }
    return new FatalPluginRuntimeError(
      operation,
      "Plugin compatibility renderer is not available.",
      this.resourceDiagnostics.at(-1) ?? null,
    );
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    try {
      await this.request("close", undefined, false);
    } catch {
      // A busy plugin renderer must not hold application shutdown open.
    }
    await this.destroy("Plugin compatibility renderer closed.");
  }

  private waitUntilReady(): Promise<void> {
    if (this.ready) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timeout = this.clock.setTimeout(
        () => {
          if (!this.ready) {
            this.readyResolve = null;
            this.readyReject = null;
            reject(new Error("Plugin compatibility renderer did not become ready in time."));
          }
        },
        operationDeadlineMs(this.policy, "initialize"),
      );
      this.readyResolve = () => {
        this.clock.clearTimeout(timeout);
        resolve();
      };
      this.readyReject = (error) => {
        this.clock.clearTimeout(timeout);
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
        const error = new FatalPluginRuntimeError(
          operation,
          `Plugin renderer ${operation} returned no snapshot.`,
        );
        this.terminate(error);
        throw error;
      }
      this.activePluginId =
        snapshot.plugin?.id ??
        snapshot.plugins?.find(({ state }) => state === "loaded")?.id ??
        this.activePluginId;
      this.setSurface(snapshot.pluginSurface ?? null);
      return this.decorateResourceSnapshot(snapshot);
    });
  }

  private request(
    operation: PluginRendererOperation,
    payload?: Record<string, unknown>,
    terminateOnFailure = true,
  ): Promise<RuntimeSnapshot | null> {
    if (!this.ready || this.closed || this.view.webContents.isDestroyed()) {
      return Promise.reject(this.unavailableError(operation));
    }
    const id = randomUUID();
    const request: PluginRendererRequest = { id, operation, ...(payload ? { payload } : {}) };
    return new Promise((resolve, reject) => {
      const startedAt = this.clock.now();
      const timeout = this.clock.setTimeout(
        () => {
          this.pending.delete(id);
          const observedAt = this.clock.now();
          const diagnostic = resourceDiagnosticForDeadline(
            this.policy,
            operation,
            Math.max(0, observedAt - startedAt),
            startedAt,
            observedAt,
          );
          this.recordResourceDiagnostic(diagnostic);
          const error = new FatalPluginRuntimeError(
            operation,
            `Plugin renderer operation timed out: ${operation}.`,
            this.decorateResourceDiagnostic(diagnostic),
          );
          reject(error);
          if (terminateOnFailure) {
            this.terminate(error);
          }
        },
        operationDeadlineMs(this.policy, operation),
      );
      this.pending.set(id, { resolve, reject, timeout, startedAt });
      try {
        this.view.webContents.send(pluginRendererChannels.request, request);
      } catch (error) {
        this.clock.clearTimeout(timeout);
        this.pending.delete(id);
        const fatalError = new FatalPluginRuntimeError(
          operation,
          `Plugin renderer request could not be sent: ${errorMessage(error)}`,
        );
        reject(fatalError);
        if (terminateOnFailure) {
          this.terminate(fatalError);
        }
      }
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
      this.terminate(
        new FatalPluginRuntimeError(
          "response",
          `Plugin renderer returned an invalid response: ${errorMessage(error)}`,
        ),
      );
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    this.clock.clearTimeout(pending.timeout);
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
    this.terminate(
      new FatalPluginRuntimeError(
        "renderer-exit",
        `Plugin compatibility renderer stopped (${details.reason}, exit ${details.exitCode}).`,
      ),
      false,
    );
  };

  private rejectAll(error: Error | string): void {
    const failure = typeof error === "string" ? new Error(error) : error;
    for (const pending of this.pending.values()) {
      this.clock.clearTimeout(pending.timeout);
      pending.reject(failure);
    }
    this.pending.clear();
  }

  private markUnavailable(error: Error): void {
    this.closed = true;
    this.ready = false;
    this.setSurface(null);
    this.readyReject?.(error);
    this.readyResolve = null;
    this.readyReject = null;
    this.resourceMonitor.stop();
    if (error instanceof FatalPluginRuntimeError) {
      this.lastFatalError = error;
    }
    this.rejectAll(error);
  }

  private terminate(error: FatalPluginRuntimeError, crashRenderer = true): void {
    if (this.closed) {
      return;
    }
    this.markUnavailable(error);
    this.view.webContents.removeListener("ipc-message", this.handleIpcMessage);
    this.view.webContents.removeListener("render-process-gone", this.handleRendererGone);
    if (!this.view.webContents.isDestroyed()) {
      if (crashRenderer) {
        try {
          this.view.webContents.forcefullyCrashRenderer();
        } catch {
          // Closing the WebContents remains the final cleanup boundary.
        }
      }
      try {
        this.view.webContents.close();
      } catch {
        // A renderer that already exited has no remaining resources to preserve.
      }
    }
  }

  private async destroy(reason: string): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.resourceMonitor.stop();
    this.setSurface(null);
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
