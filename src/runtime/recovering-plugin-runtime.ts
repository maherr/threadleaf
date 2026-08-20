import path from "node:path";
import type {
  PluginEditorContext,
  PluginMutationWaitOptions,
  PluginResourceDiagnostic,
  PluginSummary,
  RuntimeEvent,
  RuntimeSnapshot,
} from "../shared/contracts";
import { createPluginDiagnostic, type PluginDiagnosticCode } from "../shared/plugin-diagnostics";
import type { PluginRendererEnvironment } from "../shared/plugin-runtime-protocol";
import type { PluginConstructionRequest } from "../shared/plugins";
import {
  FatalPluginRuntimeError,
  isFatalPluginRuntimeError,
  type PluginRuntimePort,
} from "./plugin-runtime-port";

export type PluginFailureDescriptor = Pick<
  PluginSummary,
  "id" | "name" | "stylesheetDiscovered" | "version"
>;

interface RecoveringPluginRuntimeOptions<T extends PluginRuntimePort> {
  create(): Promise<T>;
  describePlugin?(pluginDirectory: string): Promise<PluginFailureDescriptor | null>;
  onRuntimeChange?(runtime: T): Promise<void> | void;
}

interface TrackedPlugin {
  request: PluginConstructionRequest;
  summary: PluginSummary;
}

interface OperationContext {
  operation: string;
  pluginDirectory?: string;
  pluginId?: string;
}

function pluginList(snapshot: RuntimeSnapshot): PluginSummary[] {
  return snapshot.plugins ?? (snapshot.plugin ? [snapshot.plugin] : []);
}

function fallbackDescriptor(pluginDirectory: string): PluginFailureDescriptor {
  const id = path.basename(pluginDirectory);
  return {
    id,
    name: id,
    version: "unknown",
    stylesheetDiscovered: false,
  };
}

function diagnosticCodeForOperation(operation: string): PluginDiagnosticCode {
  if (operation === "run-command") {
    return "runtime-command-failed";
  }
  if (operation === "open-view") {
    return "runtime-view-failed";
  }
  if (operation === "open-settings") {
    return "runtime-settings-failed";
  }
  if (operation === "unload-plugin" || operation === "unload-all" || operation === "close-view") {
    return "runtime-unload-failed";
  }
  if (operation === "recovery") {
    return "runtime-recovery-failed";
  }
  if (operation === "render-markdown") {
    return "runtime-render-failed";
  }
  return "runtime-load-failed";
}

function assertEnvironmentAcknowledgement(
  snapshot: RuntimeSnapshot,
  environment: PluginRendererEnvironment,
): void {
  const acknowledgement = snapshot.pluginEnvironment;
  if (
    acknowledgement?.status !== "applied" ||
    acknowledgement.vaultId !== environment.vaultId ||
    acknowledgement.vaultGeneration !== environment.vaultGeneration ||
    acknowledgement.sequence !== environment.sequence
  ) {
    throw new Error("The plugin renderer did not acknowledge the requested environment identity.");
  }
}

export class RecoveringPluginRuntime<T extends PluginRuntimePort = PluginRuntimePort>
  implements PluginRuntimePort
{
  private readonly activePlugins = new Map<string, TrackedPlugin>();
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private current: T;
  private eventSequence = 0;
  private readonly eventLedger: RuntimeEvent[] = [];
  private readonly resourceDiagnostics: PluginResourceDiagnostic[] = [];
  private readonly failedPlugins = new Map<string, PluginSummary>();
  private lastFailureId: string | null = null;
  private lastPluginId: string | null = null;
  private lastSnapshot: RuntimeSnapshot | null = null;
  private readonly knownRequests = new Map<string, PluginConstructionRequest>();
  private operationTail: Promise<void> = Promise.resolve();
  private readonly seenRuntimeEventSequences = new Set<number>();
  private environment: PluginRendererEnvironment | null = null;
  private vaultMarkdownPaths: string[] | null = null;

  private constructor(
    current: T,
    private readonly options: RecoveringPluginRuntimeOptions<T>,
  ) {
    this.current = current;
  }

  static async open<T extends PluginRuntimePort>(
    options: RecoveringPluginRuntimeOptions<T>,
  ): Promise<RecoveringPluginRuntime<T>> {
    const current = await options.create();
    const runtime = new RecoveringPluginRuntime(current, options);
    try {
      await options.onRuntimeChange?.(current);
      return runtime;
    } catch (error) {
      await current.close().catch(() => undefined);
      throw error;
    }
  }

  getSnapshot(): Promise<RuntimeSnapshot> {
    return this.runSnapshot({ operation: "get-snapshot" }, (runtime) => runtime.getSnapshot());
  }

  applyEnvironment(environment: PluginRendererEnvironment): Promise<RuntimeSnapshot> {
    return this.runSnapshot(
      { operation: "apply-environment" },
      (runtime) => {
        if (!runtime.applyEnvironment) {
          throw new Error("The active plugin runtime does not support environment replacement.");
        }
        return runtime.applyEnvironment(environment);
      },
      (snapshot) => {
        assertEnvironmentAcknowledgement(snapshot, environment);
        this.environment = structuredClone(environment);
      },
    );
  }

  seedVaultMarkdownPaths(paths: readonly string[]): Promise<void> {
    const seeded = [...paths];
    return this.runSnapshot(
      { operation: "seed-vault-markdown-paths" },
      async (runtime) => {
        if (!runtime.seedVaultMarkdownPaths) {
          throw new Error("The active plugin runtime does not support vault inventory seeding.");
        }
        await runtime.seedVaultMarkdownPaths(seeded);
        return runtime.getSnapshot();
      },
      () => {
        this.vaultMarkdownPaths = seeded;
      },
    ).then(() => undefined);
  }

  closePluginView(): Promise<RuntimeSnapshot> {
    return this.runSnapshot({ operation: "close-view" }, (runtime) => runtime.closePluginView());
  }

  loadPlugin(request: PluginConstructionRequest): Promise<RuntimeSnapshot> {
    const pluginDirectory = request.pluginDirectory;
    this.knownRequests.set(request.packageIdentity.pluginId, structuredClone(request));
    return this.runSnapshot(
      { operation: "load-plugin", pluginDirectory, pluginId: request.packageIdentity.pluginId },
      (runtime) => runtime.loadPlugin(request),
      (snapshot) => {
        this.trackLoadedPlugin(snapshot, request);
      },
    );
  }

  markLayoutReady(): Promise<RuntimeSnapshot> {
    return this.runSnapshot({ operation: "mark-layout-ready" }, (runtime) =>
      runtime.markLayoutReady(),
    );
  }

  openPluginSettings(pluginId: string): Promise<RuntimeSnapshot> {
    return this.runSnapshot({ operation: "open-settings", pluginId }, (runtime) =>
      runtime.openPluginSettings(pluginId),
    );
  }

  openPluginView(viewType: string, filePath?: string): Promise<RuntimeSnapshot> {
    return this.runSnapshot({ operation: "open-view" }, (runtime) =>
      runtime.openPluginView(viewType, filePath),
    );
  }

  reloadPlugin(request?: PluginConstructionRequest): Promise<RuntimeSnapshot> {
    const targetId = request?.packageIdentity.pluginId ?? this.lastPluginId ?? undefined;
    const knownRequest = request ?? (targetId ? this.knownRequests.get(targetId) : undefined);
    const reloadRequest = knownRequest
      ? { ...knownRequest, constructionPath: "explicit-reload" as const }
      : undefined;
    return this.runSnapshot(
      { operation: "reload-plugin", ...(targetId ? { pluginId: targetId } : {}) },
      (runtime) => {
        if (!reloadRequest) {
          throw new Error("Plugin reload requires an exact package construction request.");
        }
        return targetId && !this.activePlugins.has(targetId)
          ? runtime.loadPlugin(reloadRequest)
          : runtime.reloadPlugin(reloadRequest);
      },
      (snapshot) => {
        if (reloadRequest) {
          this.trackLoadedPlugin(snapshot, reloadRequest);
        } else {
          this.rememberRuntimePlugins(snapshot);
        }
      },
    );
  }

  runCommand(commandId: string, editorContext?: PluginEditorContext): Promise<RuntimeSnapshot> {
    const ownerId = this.lastSnapshot?.commands.find(({ id }) => id === commandId)?.ownerId;
    return this.runSnapshot(
      { operation: "run-command", ...(ownerId ? { pluginId: ownerId } : {}) },
      (runtime) => runtime.runCommand(commandId, editorContext),
    );
  }

  runPluginEditorPaste(
    editorContext: PluginEditorContext,
    clipboardText: string,
  ): Promise<RuntimeSnapshot> {
    return this.runSnapshot({ operation: "run-editor-paste" }, (runtime) => {
      if (!runtime.runPluginEditorPaste) {
        throw new Error("The active plugin runtime does not support editor paste delivery.");
      }
      return runtime.runPluginEditorPaste(editorContext, clipboardText);
    });
  }

  queryPluginEditorSuggest(editorContext: PluginEditorContext): Promise<RuntimeSnapshot> {
    return this.runSnapshot({ operation: "query-editor-suggest" }, (runtime) => {
      if (!runtime.queryPluginEditorSuggest) {
        throw new Error("The active plugin runtime does not support editor suggestions.");
      }
      return runtime.queryPluginEditorSuggest(editorContext);
    });
  }

  selectPluginEditorSuggest(
    editorContext: PluginEditorContext,
    sessionId: string,
    itemIndex: number,
    shiftKey: boolean,
  ): Promise<RuntimeSnapshot> {
    return this.runSnapshot({ operation: "select-editor-suggest" }, (runtime) => {
      if (!runtime.selectPluginEditorSuggest) {
        throw new Error("The active plugin runtime does not support editor suggestions.");
      }
      return runtime.selectPluginEditorSuggest(editorContext, sessionId, itemIndex, shiftKey);
    });
  }

  waitForPluginMutations(options?: PluginMutationWaitOptions): Promise<RuntimeSnapshot> {
    return this.runSnapshot({ operation: "wait-for-mutations" }, (runtime) =>
      runtime.waitForPluginMutations(options),
    );
  }

  renderMarkdownProjection(
    pluginId: string,
    sourcePath: string,
    content: string,
  ): Promise<RuntimeSnapshot> {
    return this.runSnapshot({ operation: "render-markdown", pluginId }, (runtime) => {
      if (!runtime.renderMarkdownProjection) {
        throw new Error("The active plugin runtime does not support settled Markdown projections.");
      }
      return runtime.renderMarkdownProjection(pluginId, sourcePath, content);
    });
  }

  unloadAllPlugins(): Promise<RuntimeSnapshot> {
    return this.runSnapshot(
      { operation: "unload-all" },
      (runtime) => runtime.unloadAllPlugins(),
      () => {
        this.activePlugins.clear();
        this.failedPlugins.clear();
        this.lastFailureId = null;
      },
    );
  }

  unloadPlugin(pluginId?: string): Promise<RuntimeSnapshot> {
    const targetId = pluginId ?? this.lastPluginId ?? undefined;
    return this.runSnapshot(
      { operation: "unload-plugin", ...(targetId ? { pluginId: targetId } : {}) },
      async (runtime) => {
        if (targetId && this.failedPlugins.has(targetId) && !this.activePlugins.has(targetId)) {
          this.failedPlugins.delete(targetId);
          if (this.lastFailureId === targetId) {
            this.lastFailureId = null;
          }
          return runtime.getSnapshot();
        }
        return runtime.unloadPlugin(targetId);
      },
      (snapshot) => {
        const unloadedId = targetId ?? snapshot.plugin?.id;
        if (unloadedId) {
          this.activePlugins.delete(unloadedId);
          this.failedPlugins.delete(unloadedId);
        }
      },
    );
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closed = true;
    this.activePlugins.clear();
    this.failedPlugins.clear();
    const current = this.current;
    this.closePromise = (async () => {
      try {
        await current.close();
      } catch (error) {
        if (!isFatalPluginRuntimeError(error)) {
          throw error;
        }
      }
    })();
    return this.closePromise;
  }

  private runSnapshot(
    context: OperationContext,
    operation: (runtime: T) => Promise<RuntimeSnapshot>,
    onSuccess?: (snapshot: RuntimeSnapshot) => void,
  ): Promise<RuntimeSnapshot> {
    return this.enqueue(async () => {
      if (this.closed) {
        throw new Error("Plugin compatibility runtime is closed.");
      }
      try {
        const snapshot = await operation(this.current);
        if (this.closed) {
          throw new Error("Plugin compatibility runtime is closed.");
        }
        onSuccess?.(snapshot);
        return this.rememberSnapshot(snapshot);
      } catch (error) {
        if (this.closed) {
          throw new Error("Plugin compatibility runtime is closed.", { cause: error });
        }
        if (!isFatalPluginRuntimeError(error)) {
          throw error;
        }
        this.rememberResourceDiagnostic(error.resourceDiagnostic);
        return this.recover(context, error);
      }
    });
  }

  private enqueue<R>(operation: () => Promise<R>): Promise<R> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async recover(context: OperationContext, failure: Error): Promise<RuntimeSnapshot> {
    if (this.closed) {
      throw new Error("Plugin compatibility runtime is closed.", { cause: failure });
    }
    const activeBeforeRecovery = [...this.activePlugins.values()];
    let culpritDescriptor: PluginFailureDescriptor | null = null;
    if (context.pluginDirectory) {
      culpritDescriptor =
        (await this.options.describePlugin?.(context.pluginDirectory).catch(() => null)) ??
        fallbackDescriptor(context.pluginDirectory);
      context.pluginId = culpritDescriptor.id;
    }

    for (const tracked of activeBeforeRecovery) {
      const isCulprit = tracked.summary.id === context.pluginId;
      const code = isCulprit
        ? diagnosticCodeForOperation(context.operation)
        : "runtime-recovery-failed";
      this.failedPlugins.set(tracked.summary.id, {
        ...tracked.summary,
        state: "failed",
        error: isCulprit
          ? `${createPluginDiagnostic(code, { pluginId: tracked.summary.id }).message} The compatibility renderer recovered; reload the plugin to reactivate it.`
          : `${createPluginDiagnostic(code, { pluginId: tracked.summary.id }).message} Reload the plugin to reactivate it.`,
        errorCode: code,
      });
    }
    if (culpritDescriptor && !this.failedPlugins.has(culpritDescriptor.id)) {
      const code = diagnosticCodeForOperation(context.operation);
      this.failedPlugins.set(culpritDescriptor.id, {
        ...culpritDescriptor,
        state: "failed",
        compatibilityLevel: 0,
        error: `${createPluginDiagnostic(code, { pluginId: culpritDescriptor.id }).message} The compatibility renderer recovered; reload the plugin to reactivate it.`,
        errorCode: code,
      });
    }
    this.lastFailureId = context.pluginId ?? activeBeforeRecovery.at(-1)?.summary.id ?? null;
    this.activePlugins.clear();

    const previous = this.current;
    await previous.close().catch(() => undefined);
    if (this.closed) {
      throw new Error("Plugin compatibility runtime is closed.", { cause: failure });
    }
    let replacement: T | null = null;
    try {
      replacement = await this.options.create();
      if (this.closed) {
        await replacement.close().catch(() => undefined);
        throw new Error("Plugin compatibility runtime is closed.", { cause: failure });
      }
      this.current = replacement;
      if (this.vaultMarkdownPaths) {
        if (!replacement.seedVaultMarkdownPaths) {
          throw new Error("The replacement plugin runtime cannot restore its vault inventory.");
        }
        await replacement.seedVaultMarkdownPaths(this.vaultMarkdownPaths);
      }
      if (this.environment) {
        if (!replacement.applyEnvironment) {
          throw new Error("The replacement plugin runtime cannot restore its environment.");
        }
        const environmentSnapshot = await replacement.applyEnvironment(this.environment);
        assertEnvironmentAcknowledgement(environmentSnapshot, this.environment);
      }
      await this.options.onRuntimeChange?.(replacement);
    } catch (recoveryError) {
      await replacement?.close().catch(() => undefined);
      this.closed = true;
      throw new AggregateError(
        [failure, recoveryError],
        `Plugin compatibility renderer recovery failed after ${context.operation}.`,
      );
    }

    this.seenRuntimeEventSequences.clear();
    this.eventLedger.push({
      sequence: ++this.eventSequence,
      kind: "error",
      message: `Recovered the compatibility renderer after ${context.operation} failed. Loaded plugins were stopped and can be reloaded safely.`,
    });
    const recoveryNotice =
      "The plugin operation was stopped. The compatibility renderer recovered; reload plugins to reactivate them.";
    try {
      let recoveredSnapshot = await replacement.getSnapshot();
      if (failure instanceof FatalPluginRuntimeError && failure.operation === "renderer-exit") {
        return this.rememberSnapshot(recoveredSnapshot, recoveryNotice);
      }
      const recoveryPath = "automatic-recovery";
      for (const tracked of activeBeforeRecovery) {
        const recoveryRequest = {
          ...tracked.request,
          constructionPath: recoveryPath as "automatic-recovery" | "renderer-death-restoration",
        };
        recoveredSnapshot = await replacement.loadPlugin(recoveryRequest);
        this.trackLoadedPlugin(recoveredSnapshot, recoveryRequest);
      }
      return this.rememberSnapshot(recoveredSnapshot, recoveryNotice);
    } catch (recoveryError) {
      await replacement.close().catch(() => undefined);
      this.closed = true;
      throw new AggregateError(
        [failure, recoveryError],
        `Plugin compatibility renderer recovery failed after ${context.operation}.`,
      );
    }
  }

  private trackLoadedPlugin(snapshot: RuntimeSnapshot, request: PluginConstructionRequest): void {
    const fallbackId = request.packageIdentity.pluginId;
    const summary = snapshot.plugin ?? pluginList(snapshot).find(({ id }) => id === fallbackId);
    if (!summary) {
      return;
    }
    this.lastPluginId = summary.id;
    this.knownRequests.set(summary.id, structuredClone(request));
    this.failedPlugins.delete(summary.id);
    if (summary.state === "loaded") {
      this.activePlugins.set(summary.id, {
        request: structuredClone(request),
        summary: { ...summary },
      });
    } else {
      this.activePlugins.delete(summary.id);
    }
  }

  private rememberRuntimePlugins(snapshot: RuntimeSnapshot): void {
    for (const plugin of pluginList(snapshot)) {
      const tracked = this.activePlugins.get(plugin.id);
      if (tracked) {
        if (plugin.state === "loaded") {
          tracked.summary = { ...plugin };
        } else {
          this.activePlugins.delete(plugin.id);
        }
      }
      if (plugin.state === "loaded") {
        this.failedPlugins.delete(plugin.id);
      }
    }
  }

  private rememberSnapshot(snapshot: RuntimeSnapshot, transientNotice?: string): RuntimeSnapshot {
    this.rememberRuntimePlugins(snapshot);
    this.lastSnapshot = snapshot;
    if (snapshot.plugin) {
      this.lastPluginId = snapshot.plugin.id;
    }
    return this.decorate(snapshot, transientNotice);
  }

  private decorate(snapshot: RuntimeSnapshot, transientNotice?: string): RuntimeSnapshot {
    for (const event of snapshot.events) {
      if (this.seenRuntimeEventSequences.has(event.sequence)) {
        continue;
      }
      this.seenRuntimeEventSequences.add(event.sequence);
      this.eventLedger.push({ ...event, sequence: ++this.eventSequence });
    }
    const pluginsById = new Map(pluginList(snapshot).map((plugin) => [plugin.id, { ...plugin }]));
    for (const [pluginId, failure] of this.failedPlugins) {
      if (!pluginsById.has(pluginId)) {
        pluginsById.set(pluginId, { ...failure });
      }
    }
    const plugins = [...pluginsById.values()].sort((left, right) =>
      left.name.localeCompare(right.name, "en-US", { numeric: true }),
    );
    const selectedPluginId = snapshot.plugin?.id ?? this.lastFailureId;
    const plugin = selectedPluginId
      ? (plugins.find(({ id }) => id === selectedPluginId) ?? null)
      : null;
    const resourceDiagnostics = this.mergeResourceDiagnostics(snapshot.resourceDiagnostics);
    return {
      ...snapshot,
      plugin,
      plugins,
      notices: transientNotice ? [...snapshot.notices, transientNotice] : [...snapshot.notices],
      events: this.eventLedger.map((event) => ({ ...event })),
      ...(resourceDiagnostics.length > 0 ? { resourceDiagnostics } : {}),
    };
  }

  private rememberResourceDiagnostic(diagnostic: PluginResourceDiagnostic | null): void {
    if (!diagnostic) {
      return;
    }
    this.resourceDiagnostics.push({ ...diagnostic });
    if (this.resourceDiagnostics.length > 50) {
      this.resourceDiagnostics.splice(0, this.resourceDiagnostics.length - 50);
    }
  }

  private mergeResourceDiagnostics(
    current: readonly PluginResourceDiagnostic[] | undefined,
  ): PluginResourceDiagnostic[] {
    const merged = [...this.resourceDiagnostics, ...(current ?? [])];
    const seen = new Set<string>();
    return merged
      .filter((diagnostic) => {
        const key = [
          diagnostic.pluginId ?? "",
          diagnostic.reason,
          diagnostic.metric ?? "",
          diagnostic.operation ?? "",
          diagnostic.startedAt,
          diagnostic.observedAt,
        ].join("\0");
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      })
      .slice(-50);
  }
}
