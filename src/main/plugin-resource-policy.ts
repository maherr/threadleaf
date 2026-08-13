import type {
  PluginResourceDiagnostic,
  PluginResourceMetricsSnapshot,
  PluginResourcePolicySnapshot,
} from "../shared/contracts";
import {
  createPluginResourcePolicy,
  type PluginResourceDiagnosticReason,
  type PluginResourceMetric,
  type PluginResourcePolicy,
  type PluginResourcePolicyOverrides,
} from "../shared/plugin-resource-policy";
import type { PluginRendererOperation } from "../shared/plugin-runtime-protocol";

export interface PluginRendererMetrics {
  memoryBytes?: number | null;
  cpuPercent?: number | null;
}

export interface PluginResourceMetricsProvider {
  sample(rendererPid: number): PluginRendererMetrics | null | Promise<PluginRendererMetrics | null>;
}

export interface PluginResourceClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

const systemClock: PluginResourceClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface PluginResourceMonitorOptions {
  clock?: PluginResourceClock;
  metricsProvider?: PluginResourceMetricsProvider;
  onDiagnostic?(diagnostic: PluginResourceDiagnostic): void;
  onBreach?(diagnostic: PluginResourceDiagnostic): void;
}

interface MonitorMetricState {
  available: boolean;
  value: number | null;
}

function isoTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function validMetric(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value) && value >= 0;
}

function metricBudget(
  policy: PluginResourcePolicy,
  metric: PluginResourceMetric,
): { value: number; unit: "bytes" | "percent" } {
  return metric === "memory"
    ? { value: policy.memoryCeilingBytes, unit: "bytes" }
    : { value: policy.cpuBudgetPercent, unit: "percent" };
}

function unavailableDiagnostic(
  policy: PluginResourcePolicy,
  metric: PluginResourceMetric,
  now: number,
): PluginResourceDiagnostic {
  const budget = metricBudget(policy, metric);
  return {
    reason: "metrics-unavailable",
    metric,
    operation: null,
    available: false,
    measuredValue: null,
    configuredBudget: budget.value,
    unit: budget.unit,
    sampleCount: null,
    startedAt: isoTimestamp(now),
    observedAt: isoTimestamp(now),
  };
}

function breachDiagnostic(
  policy: PluginResourcePolicy,
  metric: PluginResourceMetric,
  measuredValue: number,
  sampleCount: number,
  startedAt: number,
  observedAt: number,
): PluginResourceDiagnostic {
  const budget = metricBudget(policy, metric);
  return {
    reason: metric === "memory" ? "memory-ceiling" : "cpu-budget",
    metric,
    operation: null,
    available: true,
    measuredValue,
    configuredBudget: budget.value,
    unit: budget.unit,
    sampleCount,
    startedAt: isoTimestamp(startedAt),
    observedAt: isoTimestamp(observedAt),
  };
}

export class PluginResourceMonitor {
  readonly policy: PluginResourcePolicy;
  private readonly clock: PluginResourceClock;
  private readonly metricsProvider: PluginResourceMetricsProvider | undefined;
  private readonly onDiagnostic: ((diagnostic: PluginResourceDiagnostic) => void) | undefined;
  private readonly onBreach: ((diagnostic: PluginResourceDiagnostic) => void) | undefined;
  private rendererPid: number | null = null;
  private startedAt = 0;
  private intervalHandle: unknown = null;
  private stopped = true;
  private samplingGeneration: number | null = null;
  private generation = 0;
  private cpuBreaches = 0;
  private cpuBreachStartedAt = 0;
  private lastSampledAt: number | null = null;
  private readonly diagnostics: PluginResourceDiagnostic[] = [];
  private readonly unavailableReported = new Set<PluginResourceMetric>();
  private memory: MonitorMetricState = { available: false, value: null };
  private cpu: MonitorMetricState = { available: false, value: null };

  constructor(
    overrides: PluginResourcePolicyOverrides = {},
    options: PluginResourceMonitorOptions = {},
  ) {
    this.policy = createPluginResourcePolicy(overrides);
    this.clock = options.clock ?? systemClock;
    this.metricsProvider = options.metricsProvider;
    this.onDiagnostic = options.onDiagnostic;
    this.onBreach = options.onBreach;
  }

  start(rendererPid: number): void {
    this.stop();
    this.rendererPid = Number.isSafeInteger(rendererPid) && rendererPid > 0 ? rendererPid : null;
    this.startedAt = this.clock.now();
    this.stopped = false;
    this.generation += 1;
    this.cpuBreaches = 0;
    this.cpuBreachStartedAt = 0;
    this.lastSampledAt = null;
    this.memory = { available: false, value: null };
    this.cpu = { available: false, value: null };
    this.unavailableReported.clear();
    const generation = this.generation;
    this.intervalHandle = this.clock.setInterval(() => {
      if (generation !== this.generation || this.stopped) {
        return;
      }
      void this.sampleNow(generation);
    }, this.policy.cpuSampleIntervalMs);
    void this.sampleNow(generation);
  }

  stop(): void {
    if (this.intervalHandle !== null) {
      this.clock.clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.stopped = true;
    this.generation += 1;
    this.samplingGeneration = null;
    this.rendererPid = null;
    this.cpuBreaches = 0;
    this.cpuBreachStartedAt = 0;
  }

  async sampleNow(expectedGeneration = this.generation): Promise<void> {
    if (
      this.stopped ||
      this.samplingGeneration !== null ||
      expectedGeneration !== this.generation
    ) {
      return;
    }
    this.samplingGeneration = expectedGeneration;
    const rendererPid = this.rendererPid;
    try {
      let metrics: PluginRendererMetrics | null = null;
      if (this.metricsProvider && rendererPid !== null) {
        try {
          metrics = await this.metricsProvider.sample(rendererPid);
        } catch {
          metrics = null;
        }
      }
      if (this.stopped || expectedGeneration !== this.generation) {
        return;
      }
      const sampledAt = this.clock.now();
      this.lastSampledAt = sampledAt;
      this.updateMetric("memory", metrics?.memoryBytes, sampledAt);
      this.updateMetric("cpu", metrics?.cpuPercent, sampledAt);
      if (
        validMetric(metrics?.memoryBytes) &&
        metrics.memoryBytes > this.policy.memoryCeilingBytes
      ) {
        const diagnostic = breachDiagnostic(
          this.policy,
          "memory",
          metrics.memoryBytes,
          1,
          sampledAt,
          sampledAt,
        );
        this.recordDiagnostic(diagnostic);
        this.stop();
        this.onBreach?.(diagnostic);
        return;
      }
      if (!validMetric(metrics?.cpuPercent)) {
        this.cpuBreaches = 0;
        this.cpuBreachStartedAt = 0;
        return;
      }
      if (sampledAt - this.startedAt < this.policy.cpuStartupQuietWindowMs) {
        this.cpuBreaches = 0;
        this.cpuBreachStartedAt = 0;
        return;
      }
      if (metrics.cpuPercent <= this.policy.cpuBudgetPercent) {
        this.cpuBreaches = 0;
        this.cpuBreachStartedAt = 0;
        return;
      }
      if (this.cpuBreaches === 0) {
        this.cpuBreachStartedAt = sampledAt;
      }
      this.cpuBreaches += 1;
      if (this.cpuBreaches < this.policy.cpuConsecutiveSamples) {
        return;
      }
      const diagnostic = breachDiagnostic(
        this.policy,
        "cpu",
        metrics.cpuPercent,
        this.cpuBreaches,
        this.cpuBreachStartedAt || sampledAt,
        sampledAt,
      );
      this.recordDiagnostic(diagnostic);
      this.stop();
      this.onBreach?.(diagnostic);
    } finally {
      if (this.samplingGeneration === expectedGeneration) {
        this.samplingGeneration = null;
      }
    }
  }

  snapshot(): {
    policy: PluginResourcePolicySnapshot;
    diagnostics: PluginResourceDiagnostic[];
  } {
    const now = this.clock.now();
    const metrics: PluginResourceMetricsSnapshot = {
      sampledAt: this.lastSampledAt === null ? null : isoTimestamp(this.lastSampledAt),
      memoryBytes: this.memory.value,
      memoryAvailable: this.memory.available,
      cpuPercent: this.cpu.value,
      cpuAvailable: this.cpu.available,
      cpuBreaches: this.cpuBreaches,
      inStartupQuietWindow:
        !this.stopped && now - this.startedAt < this.policy.cpuStartupQuietWindowMs,
    };
    return {
      policy: {
        version: this.policy.version,
        operationDeadlinesMs: { ...this.policy.operationDeadlinesMs },
        memoryCeilingBytes: this.policy.memoryCeilingBytes,
        cpuBudgetPercent: this.policy.cpuBudgetPercent,
        cpuSampleIntervalMs: this.policy.cpuSampleIntervalMs,
        cpuStartupQuietWindowMs: this.policy.cpuStartupQuietWindowMs,
        cpuConsecutiveSamples: this.policy.cpuConsecutiveSamples,
        state: this.stopped ? "stopped" : "monitoring",
        metrics,
      },
      diagnostics: this.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    };
  }

  private updateMetric(
    metric: PluginResourceMetric,
    value: number | null | undefined,
    observedAt: number,
  ): void {
    const available = validMetric(value);
    const state = { available, value: available ? value : null };
    if (metric === "memory") {
      this.memory = state;
    } else {
      this.cpu = state;
    }
    if (!available && !this.unavailableReported.has(metric)) {
      this.unavailableReported.add(metric);
      this.recordDiagnostic(unavailableDiagnostic(this.policy, metric, observedAt));
    }
  }

  private recordDiagnostic(diagnostic: PluginResourceDiagnostic): void {
    this.diagnostics.push({ ...diagnostic });
    if (this.diagnostics.length > 50) {
      this.diagnostics.splice(0, this.diagnostics.length - 50);
    }
    this.onDiagnostic?.({ ...diagnostic });
  }
}

export function resourceDiagnosticForDeadline(
  policy: PluginResourcePolicy,
  operation: PluginRendererOperation,
  elapsedMs: number,
  startedAt: number,
  observedAt: number,
): PluginResourceDiagnostic {
  return {
    reason: "operation-deadline",
    metric: null,
    operation,
    available: true,
    measuredValue: elapsedMs,
    configuredBudget: policy.operationDeadlinesMs[operation],
    unit: "milliseconds",
    sampleCount: null,
    startedAt: isoTimestamp(startedAt),
    observedAt: isoTimestamp(observedAt),
  };
}

export {
  createPluginResourcePolicy,
  defaultPluginResourcePolicy,
  operationDeadlineMs,
  pluginRendererOperations,
  pluginResourcePolicyVersion,
} from "../shared/plugin-resource-policy";
export type { PluginResourceDiagnosticReason, PluginResourceMetric, PluginResourcePolicy };
