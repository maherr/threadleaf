import { type PluginRendererOperation, pluginRendererOperations } from "./plugin-runtime-protocol";

export { pluginRendererOperations } from "./plugin-runtime-protocol";

/** Bumped when the compatibility-host resource contract changes shape or meaning. */
export const pluginResourcePolicyVersion = 1 as const;

export type PluginResourceMetric = "memory" | "cpu";

export type PluginResourceDiagnosticReason =
  | "operation-deadline"
  | "memory-ceiling"
  | "cpu-budget"
  | "metrics-unavailable";

export interface PluginResourcePolicy {
  version: typeof pluginResourcePolicyVersion;
  operationDeadlinesMs: Readonly<Record<PluginRendererOperation, number>>;
  memoryCeilingBytes: number;
  cpuBudgetPercent: number;
  cpuSampleIntervalMs: number;
  cpuStartupQuietWindowMs: number;
  cpuConsecutiveSamples: number;
}

export interface PluginResourcePolicyOverrides {
  operationDeadlinesMs?: Partial<Record<PluginRendererOperation, number>>;
  memoryCeilingBytes?: number;
  cpuBudgetPercent?: number;
  cpuSampleIntervalMs?: number;
  cpuStartupQuietWindowMs?: number;
  cpuConsecutiveSamples?: number;
}

/**
 * These defaults are deliberately process-lifetime guardrails, not a sandbox. They leave enough
 * room for a large compatibility view while ensuring a plugin cannot hold a renderer forever.
 * `initialize` bounds the initialization request and `close` bounds graceful shutdown.
 */
export const defaultPluginResourcePolicy: PluginResourcePolicy = {
  version: pluginResourcePolicyVersion,
  operationDeadlinesMs: {
    close: 1_000,
    "close-view": 5_000,
    "get-snapshot": 5_000,
    initialize: 10_000,
    "apply-environment": 10_000,
    "load-plugin": 30_000,
    "mark-layout-ready": 5_000,
    "open-settings": 10_000,
    "open-view": 15_000,
    "reload-plugin": 30_000,
    "render-markdown": 15_000,
    "run-command": 30_000,
    "run-editor-paste": 30_000,
    "seed-vault-markdown-paths": 30_000,
    "unload-all": 10_000,
    "unload-plugin": 10_000,
    "wait-for-mutations": 10_000,
  },
  memoryCeilingBytes: 512 * 1024 * 1024,
  cpuBudgetPercent: 60,
  cpuSampleIntervalMs: 1_000,
  cpuStartupQuietWindowMs: 5_000,
  cpuConsecutiveSamples: 3,
};

function isPositiveFinite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

function finiteAtLeastZero(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

function finitePercent(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0 && value <= 100;
}

function positiveInteger(value: number | undefined): value is number {
  return isPositiveFinite(value) && Number.isSafeInteger(value);
}

/** Normalize test/development overrides without permitting an inert or unbounded policy. */
export function createPluginResourcePolicy(
  overrides: PluginResourcePolicyOverrides = {},
): PluginResourcePolicy {
  const operationDeadlinesMs = { ...defaultPluginResourcePolicy.operationDeadlinesMs };
  for (const operation of pluginRendererOperations) {
    const override = overrides.operationDeadlinesMs?.[operation];
    if (isPositiveFinite(override)) {
      operationDeadlinesMs[operation] = Math.max(1, Math.round(override));
    }
  }
  return {
    version: pluginResourcePolicyVersion,
    operationDeadlinesMs,
    memoryCeilingBytes: finiteAtLeastZero(overrides.memoryCeilingBytes)
      ? Math.max(1, Math.round(overrides.memoryCeilingBytes))
      : defaultPluginResourcePolicy.memoryCeilingBytes,
    cpuBudgetPercent: finitePercent(overrides.cpuBudgetPercent)
      ? overrides.cpuBudgetPercent
      : defaultPluginResourcePolicy.cpuBudgetPercent,
    cpuSampleIntervalMs: positiveInteger(overrides.cpuSampleIntervalMs)
      ? overrides.cpuSampleIntervalMs
      : defaultPluginResourcePolicy.cpuSampleIntervalMs,
    cpuStartupQuietWindowMs: finiteAtLeastZero(overrides.cpuStartupQuietWindowMs)
      ? Math.round(overrides.cpuStartupQuietWindowMs)
      : defaultPluginResourcePolicy.cpuStartupQuietWindowMs,
    cpuConsecutiveSamples: positiveInteger(overrides.cpuConsecutiveSamples)
      ? Math.max(2, overrides.cpuConsecutiveSamples)
      : defaultPluginResourcePolicy.cpuConsecutiveSamples,
  };
}

export function operationDeadlineMs(
  policy: PluginResourcePolicy,
  operation: PluginRendererOperation,
): number {
  return policy.operationDeadlinesMs[operation];
}
