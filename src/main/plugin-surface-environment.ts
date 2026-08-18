import type { PluginEnvironmentSnapshot, RuntimeSnapshot } from "../shared/contracts";
import type { PluginRendererEnvironment } from "../shared/plugin-runtime-protocol";

export interface PluginSurfaceEnvironmentSources {
  theme: "dark" | "light";
  appearanceCss: string;
  pluginCss: string;
  accessibilityCss: string;
  accessibility: PluginRendererEnvironment["accessibility"];
}

export interface PluginSurfaceEnvironmentIdentity {
  vaultId: string;
  vaultGeneration: number;
}

export interface PluginSurfaceEnvironmentPatch extends Partial<PluginSurfaceEnvironmentSources> {
  vaultId?: string;
  vaultGeneration?: number;
}

export interface PluginSurfaceEnvironmentTarget {
  id: string;
  isDestroyed(): boolean;
  applyEnvironment(environment: PluginRendererEnvironment): Promise<RuntimeSnapshot>;
}

function acknowledgement(snapshot: RuntimeSnapshot): PluginEnvironmentSnapshot | null {
  return snapshot.pluginEnvironment ?? null;
}

function assertAcknowledgement(
  snapshot: RuntimeSnapshot,
  environment: PluginRendererEnvironment,
  targetId: string,
): void {
  const applied = acknowledgement(snapshot);
  if (applied?.status !== "applied") {
    throw new Error(
      `Compatibility renderer ${targetId} did not acknowledge environment sequence ${environment.sequence}. Observed: ${JSON.stringify(applied)}.`,
    );
  }
  if (
    applied.vaultId !== environment.vaultId ||
    applied.vaultGeneration !== environment.vaultGeneration ||
    applied.sequence !== environment.sequence
  ) {
    throw new Error(
      `Compatibility renderer ${targetId} did not acknowledge environment sequence ${environment.sequence}. Observed: ${JSON.stringify(applied)}.`,
    );
  }
}

/**
 * Serializes every main-process environment source update and waits for every
 * live compatibility renderer to acknowledge the same full replacement.
 */
export class PluginSurfaceEnvironmentBridge {
  private sources: PluginSurfaceEnvironmentSources;
  private environment: PluginRendererEnvironment | null = null;
  private readonly targets = new Map<string, PluginSurfaceEnvironmentTarget>();
  private operationTail: Promise<void> = Promise.resolve();

  constructor(sources: PluginSurfaceEnvironmentSources) {
    this.sources = structuredClone(sources);
  }

  get currentEnvironment(): PluginRendererEnvironment | null {
    return this.environment ? structuredClone(this.environment) : null;
  }

  get targetCount(): number {
    return this.targets.size;
  }

  setSources(patch: Partial<PluginSurfaceEnvironmentSources>): void {
    this.sources = structuredClone({ ...this.sources, ...patch });
  }

  async register(
    target: PluginSurfaceEnvironmentTarget,
    identity: PluginSurfaceEnvironmentIdentity,
  ): Promise<void> {
    await this.enqueue(async () => {
      for (const [targetId, existing] of this.targets) {
        if (existing.isDestroyed()) {
          this.targets.delete(targetId);
        }
      }
      const hadOtherTargets = this.targets.size > 0;
      this.targets.set(target.id, target);
      try {
        if (
          this.environment &&
          (this.environment.vaultId !== identity.vaultId ||
            this.environment.vaultGeneration !== identity.vaultGeneration)
        ) {
          if (hadOtherTargets) {
            throw new Error(
              "Cannot bind a new compatibility renderer to a different vault while an older renderer is live.",
            );
          }
          this.environment = null;
        }
        const environment = this.environment ?? this.buildEnvironment(identity, 1);
        this.environment = environment;
        await this.applyToTarget(target, environment, true);
      } catch (error) {
        this.targets.delete(target.id);
        throw error;
      }
    });
  }

  unregister(targetId: string): void {
    this.targets.delete(targetId);
  }

  clear(): void {
    this.targets.clear();
    this.environment = null;
  }

  update(patch: PluginSurfaceEnvironmentPatch): Promise<PluginRendererEnvironment | null> {
    return this.enqueue(async () => {
      const sourcePatch: Partial<PluginSurfaceEnvironmentSources> = {};
      if (patch.theme !== undefined) sourcePatch.theme = patch.theme;
      if (patch.appearanceCss !== undefined) sourcePatch.appearanceCss = patch.appearanceCss;
      if (patch.pluginCss !== undefined) sourcePatch.pluginCss = patch.pluginCss;
      if (patch.accessibilityCss !== undefined) {
        sourcePatch.accessibilityCss = patch.accessibilityCss;
      }
      if (patch.accessibility !== undefined) sourcePatch.accessibility = patch.accessibility;
      this.setSources(sourcePatch);
      const currentIdentity = this.environment
        ? {
            vaultId: this.environment.vaultId,
            vaultGeneration: this.environment.vaultGeneration,
          }
        : null;
      const vaultId = patch.vaultId ?? currentIdentity?.vaultId;
      const vaultGeneration = patch.vaultGeneration ?? currentIdentity?.vaultGeneration;
      if (typeof vaultId !== "string" || typeof vaultGeneration !== "number") {
        if (this.targets.size > 0) {
          throw new Error("Live compatibility renderers require a bound vault environment.");
        }
        return null;
      }
      const identity = { vaultId, vaultGeneration };
      const sameIdentity =
        this.environment?.vaultId === identity.vaultId &&
        this.environment.vaultGeneration === identity.vaultGeneration;
      const next = this.buildEnvironment(
        identity,
        sameIdentity ? (this.environment?.sequence ?? 0) + 1 : 1,
      );
      this.environment = next;
      await this.applyToTargets(next);
      return structuredClone(next);
    });
  }

  private buildEnvironment(
    identity: PluginSurfaceEnvironmentIdentity,
    sequence: number,
  ): PluginRendererEnvironment {
    return {
      ...structuredClone(this.sources),
      ...identity,
      sequence,
    };
  }

  private async applyToTarget(
    target: PluginSurfaceEnvironmentTarget,
    environment: PluginRendererEnvironment,
    allowStale = false,
  ): Promise<void> {
    const snapshot = await target.applyEnvironment(environment);
    if (allowStale && snapshot.pluginEnvironment?.status === "stale") {
      const stale = snapshot.pluginEnvironment;
      if (
        stale.vaultId === environment.vaultId &&
        stale.vaultGeneration === environment.vaultGeneration &&
        stale.sequence === environment.sequence
      ) {
        return;
      }
    }
    assertAcknowledgement(snapshot, environment, target.id);
  }

  private async applyToTargets(environment: PluginRendererEnvironment): Promise<void> {
    const liveTargets = [...this.targets.values()].filter((target) => {
      if (!target.isDestroyed()) {
        return true;
      }
      this.targets.delete(target.id);
      return false;
    });
    const results = await Promise.allSettled(
      liveTargets.map((target) => this.applyToTarget(target, environment)),
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `One or more compatibility renderers rejected environment sequence ${environment.sequence}.`,
      );
    }
  }

  private enqueue<R>(operation: () => Promise<R>): Promise<R> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
