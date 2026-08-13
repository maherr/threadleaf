import { createHash } from "node:crypto";

export const benchmarkResultSchemaVersion = 1;

export type BenchmarkMetricUnit = "milliseconds" | "bytes";
export type BenchmarkStatistic = "p50" | "p90";

export interface BenchmarkMetricSummary {
  name: string;
  unit: BenchmarkMetricUnit;
  warmupCount: number;
  sampleCount: number;
  samples: number[];
  median: number;
  tail: number;
  tailStatistic: BenchmarkStatistic;
  minimum: number;
  maximum: number;
  details?: Record<string, number | string | boolean>;
}

export interface BenchmarkBudgetRule {
  metric: string;
  baselineMetric: string;
  maxMedianMultiplier: number;
  maxTailMultiplier: number;
  minimumSamples: number;
}

export interface BenchmarkBudgetResult {
  metric: string;
  status: "pass" | "fail" | "skipped";
  reason?: string;
  medianRatio?: number;
  tailRatio?: number;
}

export interface BenchmarkCorrectnessCheck {
  name: string;
  status: "pass" | "fail";
  details: string;
}

export interface BenchmarkResult {
  schemaVersion: typeof benchmarkResultSchemaVersion;
  generatedAt: string;
  profile: string;
  corpus: {
    seed: number;
    noteCount: number;
    attachmentCount: number;
    totalBytes: number;
    manifestHash: string;
  };
  runtime: {
    node: string;
    platform: string;
    arch: string;
    cpuCount: number;
    electron: string | null;
  };
  configuration: {
    warmups: number;
    samples: number;
    tailStatistic: BenchmarkStatistic;
  };
  correctness: BenchmarkCorrectnessCheck[];
  metrics: BenchmarkMetricSummary[];
  memoryObservation: {
    rssBytes: number;
    heapUsedBytes: number;
    note: string;
  };
  budgets: {
    evaluated: boolean;
    baselineHash: string | null;
    checks: BenchmarkBudgetResult[];
  };
  limitations: string[];
}

export interface BenchmarkBaseline {
  schemaVersion: typeof benchmarkResultSchemaVersion;
  profile: string;
  source: string;
  host: {
    node: string;
    platform: string;
    arch: string;
  };
  metrics: BenchmarkMetricSummary[];
}

export function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) {
    throw new Error("Cannot calculate a percentile without samples.");
  }
  const rank = Math.max(1, Math.ceil(sorted.length * fraction));
  const value = sorted[Math.min(sorted.length - 1, rank - 1)];
  if (value === undefined) {
    throw new Error("Percentile calculation produced no value.");
  }
  return value;
}

function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function summarizeMetric(
  name: string,
  unit: BenchmarkMetricUnit,
  warmupSamples: readonly number[],
  samples: readonly number[],
  details?: Record<string, number | string | boolean>,
): BenchmarkMetricSummary {
  if (samples.length < 2) {
    throw new Error(`Benchmark metric ${name} needs at least two measured samples.`);
  }
  if (samples.some((sample) => !Number.isFinite(sample) || sample < 0)) {
    throw new Error(`Benchmark metric ${name} contains an invalid sample.`);
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    name,
    unit,
    warmupCount: warmupSamples.length,
    sampleCount: samples.length,
    samples: [...samples],
    median: median(sorted),
    tail: percentile(sorted, 0.9),
    tailStatistic: "p90",
    minimum: sorted[0] ?? 0,
    maximum: sorted.at(-1) ?? 0,
    ...(details ? { details } : {}),
  };
}

export function evaluateBudgets(
  metrics: readonly BenchmarkMetricSummary[],
  baseline: BenchmarkBaseline,
  rules: readonly BenchmarkBudgetRule[],
): BenchmarkBudgetResult[] {
  const currentByName = new Map(metrics.map((metric) => [metric.name, metric]));
  const baselineByName = new Map(baseline.metrics.map((metric) => [metric.name, metric]));
  return rules.map((rule) => {
    const current = currentByName.get(rule.metric);
    const reference = baselineByName.get(rule.baselineMetric);
    if (!current || !reference) {
      return {
        metric: rule.metric,
        status: "skipped",
        reason: "Metric is absent from the current result or checked-in baseline.",
      };
    }
    if (current.sampleCount < rule.minimumSamples) {
      return {
        metric: rule.metric,
        status: "skipped",
        reason: `Requires at least ${rule.minimumSamples} measured samples.`,
      };
    }
    if (reference.median <= 0 || reference.tail <= 0) {
      return {
        metric: rule.metric,
        status: "skipped",
        reason: "Baseline does not contain positive timing values.",
      };
    }
    const medianRatio = current.median / reference.median;
    const tailRatio = current.tail / reference.tail;
    const passed = medianRatio <= rule.maxMedianMultiplier && tailRatio <= rule.maxTailMultiplier;
    return {
      metric: rule.metric,
      status: passed ? "pass" : "fail",
      ...(passed
        ? {}
        : {
            reason: `Relative budget exceeded (median ${medianRatio.toFixed(2)}x, tail ${tailRatio.toFixed(2)}x).`,
          }),
      medianRatio,
      tailRatio,
    };
  });
}

export function assertCorrectness(checks: readonly BenchmarkCorrectnessCheck[]): void {
  const failed = checks.filter((check) => check.status === "fail");
  if (failed.length > 0) {
    throw new Error(
      `Benchmark correctness failed: ${failed.map((check) => check.name).join(", ")}`,
    );
  }
}

export function assertBudgetPasses(checks: readonly BenchmarkBudgetResult[]): void {
  const notPassing = checks.filter((check) => check.status !== "pass");
  if (notPassing.length > 0) {
    throw new Error(
      `Benchmark regression budget failed or was unavailable: ${notPassing
        .map((check) => check.metric)
        .join(", ")}`,
    );
  }
}
