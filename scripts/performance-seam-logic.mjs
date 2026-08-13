export const performanceSeamSchemaVersion = 1;

function percentile(sorted, fraction) {
  if (sorted.length === 0) {
    throw new Error("Cannot calculate a percentile without samples.");
  }
  const rank = Math.max(1, Math.ceil(sorted.length * fraction));
  return sorted[Math.min(sorted.length - 1, rank - 1)];
}

function median(sorted) {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function metricKey(metric) {
  return `${metric.name}:${metric.mode}`;
}

export function performanceBaselineCompatibility(current, baseline) {
  const fields = [
    ["schemaVersion"],
    ["suite"],
    ["runtime", "platform"],
    ["runtime", "arch"],
    ["environment", "display"],
    ["environment", "ozonePlatform"],
    ["environment", "gpuDisabled"],
    ["environment", "cpuCount"],
    ["environment", "cpuModel"],
    ["environment", "memoryTotalBytes"],
  ];
  const read = (value, path) => path.reduce((entry, key) => entry?.[key], value);
  const mismatches = fields
    .filter((field) => !Object.is(read(current, field), read(baseline, field)))
    .map((field) => field.join("."));
  return { compatible: mismatches.length === 0, mismatches };
}

export function summarizePerformanceMetric(
  name,
  mode,
  unit,
  warmupCount,
  samples,
  details = undefined,
) {
  if (!Number.isSafeInteger(warmupCount) || warmupCount < 0) {
    throw new Error(`Performance metric ${name}/${mode} has an invalid warmup count.`);
  }
  if (!Array.isArray(samples) || samples.length < 1) {
    throw new Error(`Performance metric ${name}/${mode} needs at least one measured sample.`);
  }
  if (samples.some((sample) => !Number.isFinite(sample) || sample < 0)) {
    throw new Error(`Performance metric ${name}/${mode} contains an invalid sample.`);
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    name,
    mode,
    unit,
    warmupCount,
    sampleCount: samples.length,
    samples: [...samples],
    median: median(sorted),
    tail: percentile(sorted, 0.9),
    tailStatistic: "p90",
    minimum: sorted[0],
    maximum: sorted.at(-1),
    ...(details ? { details } : {}),
  };
}

export function evaluatePerformanceBudgets(metrics, baseline, rules) {
  const currentByKey = new Map(metrics.map((metric) => [metricKey(metric), metric]));
  const baselineByKey = new Map(baseline.metrics.map((metric) => [metricKey(metric), metric]));
  return rules.map((rule) => {
    const key = `${rule.metric}:${rule.mode}`;
    const current = currentByKey.get(key);
    const reference = baselineByKey.get(key);
    if (!current || !reference) {
      return {
        metric: rule.metric,
        mode: rule.mode,
        status: "skipped",
        reason: "Metric is absent from the current result or checked-in baseline.",
      };
    }
    if (current.sampleCount < rule.minimumSamples) {
      return {
        metric: rule.metric,
        mode: rule.mode,
        status: "skipped",
        reason: `Requires at least ${rule.minimumSamples} measured samples.`,
      };
    }
    if (reference.median <= 0 || reference.tail <= 0) {
      return {
        metric: rule.metric,
        mode: rule.mode,
        status: "skipped",
        reason: "Baseline does not contain positive performance values.",
      };
    }
    const medianRatio = current.median / reference.median;
    const tailRatio = current.tail / reference.tail;
    const passed = medianRatio <= rule.maxMedianMultiplier && tailRatio <= rule.maxTailMultiplier;
    return {
      metric: rule.metric,
      mode: rule.mode,
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

export function assertPerformanceCorrectness(checks) {
  const failed = checks.filter((check) => check.status !== "pass");
  if (failed.length > 0) {
    throw new Error(
      `Performance seam correctness failed: ${failed.map((check) => check.name).join(", ")}`,
    );
  }
}

export function assertPerformanceBudgets(checks) {
  const notPassing = checks.filter((check) => check.status !== "pass");
  if (notPassing.length > 0) {
    throw new Error(
      `Performance seam regression budget failed or was unavailable: ${notPassing
        .map((check) => `${check.metric}/${check.mode}`)
        .join(", ")}`,
    );
  }
}
