import path from "node:path";
import type {
  PluginEditorContext,
  PluginIntegrationSnapshot,
  PluginMutationWaitOptions,
  PluginResourceDiagnostic,
  PluginSummary,
  RuntimeEvent,
  RuntimeSnapshot,
} from "../shared/contracts";
import { parsePluginId } from "../shared/plugins";
import type { PluginRuntimePort } from "./plugin-runtime-port";

interface IsolatedPluginRuntimeOptions<T extends PluginRuntimePort> {
  create(): Promise<T>;
}

interface IdleRuntime<T extends PluginRuntimePort> {
  runtime: T;
  snapshot: RuntimeSnapshot;
}

interface PluginRuntimeSlot<T extends PluginRuntimePort> {
  directoryPath: string;
  expectedBundleSha256: string | undefined;
  generation: number;
  runtime: T;
  snapshot: RuntimeSnapshot;
}

function pluginList(snapshot: RuntimeSnapshot): PluginSummary[] {
  return snapshot.plugins ?? (snapshot.plugin ? [snapshot.plugin] : []);
}

function pluginFromSnapshot(snapshot: RuntimeSnapshot, pluginId: string): PluginSummary | null {
  return pluginList(snapshot).find(({ id }) => id === pluginId) ?? null;
}

function compareByNameThenId(
  left: { id: string; name: string },
  right: { id: string; name: string },
): number {
  return (
    left.name.localeCompare(right.name, "en-US", { numeric: true }) ||
    left.id.localeCompare(right.id, "en-US", { numeric: true })
  );
}

function uniqueBy<T>(values: readonly T[], keyOf: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = keyOf(value);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export class IsolatedPluginRuntime<T extends PluginRuntimePort = PluginRuntimePort>
  implements PluginRuntimePort
{
  private readonly eventLedger: RuntimeEvent[] = [];
  private eventSequence = 0;
  private readonly inactivePlugins = new Map<string, PluginSummary>();
  private idleRuntime: IdleRuntime<T> | null;
  private lastPluginId: string | null = null;
  private layoutReady = false;
  private nextGeneration = 0;
  private operationTail: Promise<void> = Promise.resolve();
  private readonly seenEvents = new Set<string>();
  private readonly slots = new Map<string, PluginRuntimeSlot<T>>();
  private closed = false;
  private closePromise: Promise<void> | null = null;

  private constructor(
    private readonly baseSnapshot: RuntimeSnapshot,
    idleRuntime: IdleRuntime<T>,
    private readonly options: IsolatedPluginRuntimeOptions<T>,
  ) {
    this.idleRuntime = idleRuntime;
    this.ingestEvents("runtime", 0, baseSnapshot);
  }

  static async open<T extends PluginRuntimePort>(
    options: IsolatedPluginRuntimeOptions<T>,
  ): Promise<IsolatedPluginRuntime<T>> {
    const runtime = await options.create();
    try {
      const snapshot = await runtime.getSnapshot();
      return new IsolatedPluginRuntime(snapshot, { runtime, snapshot }, options);
    } catch (error) {
      await runtime.close().catch(() => undefined);
      throw error;
    }
  }

  getSnapshot(): Promise<RuntimeSnapshot> {
    return this.enqueue(async () => this.mergeSnapshot());
  }

  loadPlugin(pluginDirectory: string, expectedBundleSha256?: string): Promise<RuntimeSnapshot> {
    return this.enqueue(async () => {
      const pluginId = parsePluginId(path.basename(pluginDirectory));
      await this.retireSlot(pluginId, false);
      this.inactivePlugins.delete(pluginId);
      return this.loadFreshSlot(pluginId, pluginDirectory, expectedBundleSha256);
    });
  }

  reloadPlugin(pluginId?: string): Promise<RuntimeSnapshot> {
    return this.enqueue(async () => {
      const targetId = pluginId ?? this.lastPluginId;
      if (!targetId) {
        throw new Error("No plugin has been loaded yet.");
      }
      const slot = this.slots.get(targetId);
      if (!slot) {
        throw new Error(`Plugin ${targetId} is not active.`);
      }
      const { directoryPath, expectedBundleSha256 } = slot;
      await this.retireSlot(targetId, false);
      return this.loadFreshSlot(targetId, directoryPath, expectedBundleSha256);
    });
  }

  runCommand(commandId: string, editorContext?: PluginEditorContext): Promise<RuntimeSnapshot> {
    return this.enqueue(async () => {
      const matches = [...this.slots.entries()].filter(([, slot]) =>
        slot.snapshot.commands.some(({ id }) => id === commandId),
      );
      if (matches.length === 0) {
        throw new Error(`Plugin command is not available: ${commandId}`);
      }
      if (matches.length > 1) {
        throw new Error(`Plugin command is ambiguous across isolated runtimes: ${commandId}`);
      }
      const match = matches[0];
      if (!match) {
        throw new Error(`Plugin command is not available: ${commandId}`);
      }
      const [ownerId, slot] = match;
      await this.closeOtherViews(ownerId);
      const snapshot = await slot.runtime.runCommand(commandId, editorContext);
      this.rememberSlotSnapshot(ownerId, snapshot);
      this.lastPluginId = ownerId;
      return this.mergeSnapshot(ownerId, snapshot);
    });
  }

  waitForPluginMutations(options?: PluginMutationWaitOptions): Promise<RuntimeSnapshot> {
    return this.enqueue(async () => {
      await this.updateEverySlot((slot) => slot.runtime.waitForPluginMutations(options));
      return this.mergeSnapshot();
    });
  }

  markLayoutReady(): Promise<RuntimeSnapshot> {
    return this.enqueue(async () => {
      this.layoutReady = true;
      await this.updateEverySlot((slot) => slot.runtime.markLayoutReady());
      return this.mergeSnapshot();
    });
  }

  openPluginSettings(pluginId: string): Promise<RuntimeSnapshot> {
    return this.enqueue(async () => {
      const slot = this.requireSlot(pluginId);
      await this.closeOtherViews(pluginId);
      const snapshot = await slot.runtime.openPluginSettings(pluginId);
      this.rememberSlotSnapshot(pluginId, snapshot);
      this.lastPluginId = pluginId;
      return this.mergeSnapshot(pluginId, snapshot);
    });
  }

  openPluginView(viewType: string, filePath?: string): Promise<RuntimeSnapshot> {
    return this.enqueue(async () => {
      const matches = [...this.slots.entries()].filter(([, slot]) => {
        const integrations = slot.snapshot.integrations;
        return (
          integrations?.viewTypes.includes(viewType) === true ||
          integrations?.extensions.some((extension) => extension.viewType === viewType) === true
        );
      });
      if (matches.length === 0) {
        throw new Error(`No isolated plugin runtime registered view: ${viewType}`);
      }
      if (matches.length > 1) {
        throw new Error(`Plugin view is ambiguous across isolated runtimes: ${viewType}`);
      }
      const match = matches[0];
      if (!match) {
        throw new Error(`No isolated plugin runtime registered view: ${viewType}`);
      }
      const [ownerId, slot] = match;
      await this.closeOtherViews(ownerId);
      const snapshot = await slot.runtime.openPluginView(viewType, filePath);
      this.rememberSlotSnapshot(ownerId, snapshot);
      this.lastPluginId = ownerId;
      return this.mergeSnapshot(ownerId, snapshot);
    });
  }

  closePluginView(): Promise<RuntimeSnapshot> {
    return this.enqueue(async () => {
      await this.updateEverySlot((slot) => slot.runtime.closePluginView());
      return this.mergeSnapshot();
    });
  }

  unloadPlugin(pluginId?: string): Promise<RuntimeSnapshot> {
    return this.enqueue(async () => {
      const targetId = pluginId ?? this.lastPluginId;
      if (!targetId) {
        throw new Error("No plugin has been loaded yet.");
      }
      if (!this.slots.has(targetId)) {
        this.inactivePlugins.delete(targetId);
        return this.mergeSnapshot();
      }
      await this.retireSlot(targetId, true);
      this.lastPluginId = targetId;
      return this.mergeSnapshot(targetId);
    });
  }

  unloadAllPlugins(): Promise<RuntimeSnapshot> {
    return this.enqueue(async () => {
      for (const pluginId of [...this.slots.keys()]) {
        await this.retireSlot(pluginId, true);
      }
      return this.mergeSnapshot();
    });
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closePromise = this.operationTail.then(async () => {
      this.closed = true;
      const runtimes = [
        ...(this.idleRuntime ? [this.idleRuntime.runtime] : []),
        ...[...this.slots.values()].map(({ runtime }) => runtime),
      ];
      this.idleRuntime = null;
      this.slots.clear();
      await Promise.allSettled(runtimes.map((runtime) => runtime.close()));
    });
    return this.closePromise;
  }

  private enqueue<R>(operation: () => Promise<R>): Promise<R> {
    const result = this.operationTail.then(
      async () => {
        if (this.closed) {
          throw new Error("Isolated plugin runtime is closed.");
        }
        return operation();
      },
      async () => {
        if (this.closed) {
          throw new Error("Isolated plugin runtime is closed.");
        }
        return operation();
      },
    );
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async takeRuntime(): Promise<IdleRuntime<T>> {
    if (this.idleRuntime) {
      const runtime = this.idleRuntime;
      this.idleRuntime = null;
      return runtime;
    }
    const runtime = await this.options.create();
    try {
      return { runtime, snapshot: await runtime.getSnapshot() };
    } catch (error) {
      await runtime.close().catch(() => undefined);
      throw error;
    }
  }

  private async loadFreshSlot(
    pluginId: string,
    pluginDirectory: string,
    expectedBundleSha256?: string,
  ): Promise<RuntimeSnapshot> {
    const idle = await this.takeRuntime();
    const slot: PluginRuntimeSlot<T> = {
      directoryPath: pluginDirectory,
      expectedBundleSha256,
      generation: ++this.nextGeneration,
      runtime: idle.runtime,
      snapshot: idle.snapshot,
    };
    this.slots.set(pluginId, slot);
    this.lastPluginId = pluginId;
    try {
      let snapshot = await slot.runtime.loadPlugin(pluginDirectory, expectedBundleSha256);
      this.rememberSlotSnapshot(pluginId, snapshot);
      if (this.layoutReady) {
        snapshot = await slot.runtime.markLayoutReady();
        this.rememberSlotSnapshot(pluginId, snapshot);
      }
      return this.mergeSnapshot(pluginId, snapshot);
    } catch (error) {
      try {
        this.rememberSlotSnapshot(pluginId, await slot.runtime.getSnapshot());
      } catch {
        // The owning recovery runtime keeps fatal failures available for explicit reload.
      }
      throw error;
    }
  }

  private requireSlot(pluginId: string): PluginRuntimeSlot<T> {
    const slot = this.slots.get(pluginId);
    if (!slot) {
      throw new Error(`Plugin ${pluginId} is not active.`);
    }
    return slot;
  }

  private async retireSlot(pluginId: string, retainSummary: boolean): Promise<void> {
    const slot = this.slots.get(pluginId);
    if (!slot) {
      return;
    }
    let finalSnapshot = slot.snapshot;
    try {
      finalSnapshot = await slot.runtime.unloadPlugin(pluginId);
      this.rememberSlotSnapshot(pluginId, finalSnapshot);
    } finally {
      await slot.runtime.close().catch(() => undefined);
      this.slots.delete(pluginId);
    }
    if (retainSummary) {
      const summary = pluginFromSnapshot(finalSnapshot, pluginId);
      if (summary) {
        this.inactivePlugins.set(pluginId, { ...summary, state: "unloaded" });
      }
    }
  }

  private async closeOtherViews(ownerId: string): Promise<void> {
    const entries = [...this.slots.entries()].filter(([pluginId]) => pluginId !== ownerId);
    const results = await Promise.allSettled(
      entries.map(async ([pluginId, slot]) => {
        const snapshot = await slot.runtime.closePluginView();
        this.rememberSlotSnapshot(pluginId, snapshot);
      }),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) {
      throw failure.reason;
    }
  }

  private async updateEverySlot(
    operation: (slot: PluginRuntimeSlot<T>) => Promise<RuntimeSnapshot>,
  ): Promise<void> {
    const entries = [...this.slots.entries()];
    const results = await Promise.allSettled(
      entries.map(async ([pluginId, slot]) => {
        const snapshot = await operation(slot);
        this.rememberSlotSnapshot(pluginId, snapshot);
      }),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) {
      throw failure.reason;
    }
  }

  private rememberSlotSnapshot(pluginId: string, snapshot: RuntimeSnapshot): void {
    const slot = this.slots.get(pluginId);
    if (!slot) {
      return;
    }
    slot.snapshot = snapshot;
    this.ingestEvents(pluginId, slot.generation, snapshot);
  }

  private ingestEvents(ownerId: string, generation: number, snapshot: RuntimeSnapshot): void {
    for (const event of snapshot.events) {
      const runtimeOpening = event.kind === "runtime" && event.message.startsWith("Opened ");
      const key = runtimeOpening
        ? `runtime:${event.kind}:${event.message}`
        : `${ownerId}:${generation}:${event.sequence}:${event.kind}:${event.message}`;
      if (this.seenEvents.has(key)) {
        continue;
      }
      this.seenEvents.add(key);
      this.eventLedger.push({ ...event, sequence: ++this.eventSequence });
    }
  }

  private mergeSnapshot(
    selectedId: string | null = this.lastPluginId,
    operationSnapshot?: RuntimeSnapshot,
  ): RuntimeSnapshot {
    const slotEntries = [...this.slots.entries()];
    const activeIds = new Set(slotEntries.map(([pluginId]) => pluginId));
    const plugins = [
      ...slotEntries.flatMap(([pluginId, slot]) => {
        const summary = pluginFromSnapshot(slot.snapshot, pluginId);
        return summary ? [summary] : [];
      }),
      ...[...this.inactivePlugins.entries()]
        .filter(([pluginId]) => !activeIds.has(pluginId))
        .map(([, summary]) => summary),
    ].sort(compareByNameThenId);
    const selectedPlugin = selectedId
      ? (plugins.find(({ id }) => id === selectedId) ?? null)
      : null;
    const orderedSnapshots = slotEntries
      .sort(([left], [right]) => {
        if (left === selectedId) {
          return 1;
        }
        if (right === selectedId) {
          return -1;
        }
        return left.localeCompare(right, "en-US", { numeric: true });
      })
      .map(([, slot]) => slot.snapshot);
    const integrations = this.mergeIntegrations(orderedSnapshots);
    const visibleSurface =
      operationSnapshot?.pluginSurface ??
      orderedSnapshots.find((snapshot) => snapshot.pluginSurface)?.pluginSurface ??
      null;
    const resourcePolicy =
      operationSnapshot?.resourcePolicy ?? orderedSnapshots.at(-1)?.resourcePolicy;
    const resourceDiagnostics = this.mergeResourceDiagnostics(orderedSnapshots);
    return {
      ...this.baseSnapshot,
      vault: operationSnapshot?.vault ?? orderedSnapshots.at(-1)?.vault ?? this.baseSnapshot.vault,
      plugin: selectedPlugin,
      plugins,
      commands: orderedSnapshots.flatMap(({ commands }) => commands).sort(compareByNameThenId),
      actions: orderedSnapshots.flatMap(({ actions }) => actions).sort(compareByNameThenId),
      notices: orderedSnapshots.flatMap(({ notices }) => notices),
      events: [...this.eventLedger],
      ...(integrations ? { integrations } : {}),
      editorUpdate: operationSnapshot?.editorUpdate ?? null,
      pluginSurface: visibleSurface,
      ...(resourceDiagnostics.length > 0 ? { resourceDiagnostics } : {}),
      ...(resourcePolicy ? { resourcePolicy } : {}),
    };
  }

  private mergeResourceDiagnostics(
    snapshots: readonly RuntimeSnapshot[],
  ): PluginResourceDiagnostic[] {
    const diagnostics = snapshots.flatMap((snapshot) => snapshot.resourceDiagnostics ?? []);
    const seen = new Set<string>();
    return diagnostics
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
      .slice(-100);
  }

  private mergeIntegrations(
    snapshots: readonly RuntimeSnapshot[],
  ): PluginIntegrationSnapshot | undefined {
    const integrations = snapshots.flatMap((snapshot) =>
      snapshot.integrations ? [snapshot.integrations] : [],
    );
    if (integrations.length === 0) {
      return undefined;
    }
    return {
      editorSuggests: integrations.reduce((total, item) => total + item.editorSuggests, 0),
      extensions: uniqueBy(
        integrations.flatMap(({ extensions }) => extensions),
        ({ extension, viewType }) => `${extension}\0${viewType}`,
      ),
      markdownPostProcessors: integrations.reduce(
        (total, item) => total + item.markdownPostProcessors,
        0,
      ),
      ribbonItems: integrations.reduce((total, item) => total + item.ribbonItems, 0),
      settingTabs: integrations.reduce((total, item) => total + item.settingTabs, 0),
      settingTabPluginIds: uniqueBy(
        integrations.flatMap(({ settingTabPluginIds }) => settingTabPluginIds ?? []),
        (pluginId) => pluginId,
      ),
      statusBarItems: integrations.reduce((total, item) => total + item.statusBarItems, 0),
      viewTypes: uniqueBy(
        integrations.flatMap(({ viewTypes }) => viewTypes),
        (viewType) => viewType,
      ),
    };
  }
}
