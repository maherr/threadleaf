import path from "node:path";
import type {
  PluginEditorContext,
  PluginSummary,
  RuntimeEvent,
  RuntimeSnapshot,
} from "../shared/contracts";
import { isFatalPluginRuntimeError, type PluginRuntimePort } from "./plugin-runtime-port";

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
  directoryPath: string;
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  private readonly failedPlugins = new Map<string, PluginSummary>();
  private lastFailureId: string | null = null;
  private lastPluginId: string | null = null;
  private lastSnapshot: RuntimeSnapshot | null = null;
  private readonly knownDirectories = new Map<string, string>();
  private operationTail: Promise<void> = Promise.resolve();
  private readonly seenRuntimeEventSequences = new Set<number>();

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

  closePluginView(): Promise<RuntimeSnapshot> {
    return this.runSnapshot({ operation: "close-view" }, (runtime) => runtime.closePluginView());
  }

  loadPlugin(pluginDirectory: string): Promise<RuntimeSnapshot> {
    const fallback = fallbackDescriptor(pluginDirectory);
    this.knownDirectories.set(fallback.id, pluginDirectory);
    return this.runSnapshot(
      { operation: "load-plugin", pluginDirectory, pluginId: fallback.id },
      (runtime) => runtime.loadPlugin(pluginDirectory),
      (snapshot) => this.trackLoadedPlugin(snapshot, pluginDirectory),
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

  reloadPlugin(pluginId?: string): Promise<RuntimeSnapshot> {
    const targetId = pluginId ?? this.lastPluginId ?? undefined;
    const knownDirectory = targetId ? this.knownDirectories.get(targetId) : undefined;
    return this.runSnapshot(
      { operation: "reload-plugin", ...(targetId ? { pluginId: targetId } : {}) },
      (runtime) =>
        targetId && !this.activePlugins.has(targetId) && knownDirectory
          ? runtime.loadPlugin(knownDirectory)
          : runtime.reloadPlugin(targetId),
      (snapshot) => {
        if (knownDirectory) {
          this.trackLoadedPlugin(snapshot, knownDirectory);
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
      this.knownDirectories.set(culpritDescriptor.id, context.pluginDirectory);
      context.pluginId = culpritDescriptor.id;
    }

    for (const tracked of activeBeforeRecovery) {
      const isCulprit = tracked.summary.id === context.pluginId;
      this.failedPlugins.set(tracked.summary.id, {
        ...tracked.summary,
        state: "failed",
        error: isCulprit
          ? `${messageOf(failure)} The compatibility renderer was terminated and restarted.`
          : `The compatibility renderer restarted after ${context.operation} failed. Reload to reactivate this plugin.`,
      });
    }
    if (culpritDescriptor && !this.failedPlugins.has(culpritDescriptor.id)) {
      this.failedPlugins.set(culpritDescriptor.id, {
        ...culpritDescriptor,
        state: "failed",
        compatibilityLevel: 0,
        error: `${messageOf(failure)} The compatibility renderer was terminated and restarted.`,
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
      return this.rememberSnapshot(await replacement.getSnapshot(), recoveryNotice);
    } catch (recoveryError) {
      await replacement.close().catch(() => undefined);
      this.closed = true;
      throw new AggregateError(
        [failure, recoveryError],
        `Plugin compatibility renderer recovery failed after ${context.operation}.`,
      );
    }
  }

  private trackLoadedPlugin(snapshot: RuntimeSnapshot, directoryPath: string): void {
    const fallbackId = path.basename(directoryPath);
    const summary = snapshot.plugin ?? pluginList(snapshot).find(({ id }) => id === fallbackId);
    if (!summary) {
      return;
    }
    this.lastPluginId = summary.id;
    this.knownDirectories.set(summary.id, directoryPath);
    this.failedPlugins.delete(summary.id);
    if (summary.state === "loaded") {
      this.activePlugins.set(summary.id, { directoryPath, summary: { ...summary } });
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
    return {
      ...snapshot,
      plugin,
      plugins,
      notices: transientNotice ? [...snapshot.notices, transientNotice] : [...snapshot.notices],
      events: this.eventLedger.map((event) => ({ ...event })),
    };
  }
}
