import assert from "node:assert/strict";
import {
  assertPerformanceBudgets,
  assertPerformanceCorrectness,
  evaluatePerformanceBudgets,
  performanceBaselineCompatibility,
  summarizePerformanceMetric,
} from "./performance-seam-logic.mjs";

const summary = summarizePerformanceMetric("paint", "cold", "milliseconds", 2, [9, 1, 5, 3]);
assert.deepEqual(summary, {
  name: "paint",
  mode: "cold",
  unit: "milliseconds",
  warmupCount: 2,
  sampleCount: 4,
  samples: [9, 1, 5, 3],
  median: 4,
  tail: 9,
  tailStatistic: "p90",
  minimum: 1,
  maximum: 9,
});
assert.throws(
  () => summarizePerformanceMetric("paint", "cold", "milliseconds", -1, [1]),
  /invalid warmup count/u,
);
assert.throws(
  () => summarizePerformanceMetric("paint", "cold", "milliseconds", 1, [Number.NaN]),
  /invalid sample/u,
);

const baseline = {
  metrics: [summarizePerformanceMetric("paint", "cold", "milliseconds", 1, [4, 5, 6])],
};
const rules = [
  {
    metric: "paint",
    mode: "cold",
    maxMedianMultiplier: 1.5,
    maxTailMultiplier: 1.5,
    minimumSamples: 3,
  },
  {
    metric: "missing",
    mode: "warm",
    maxMedianMultiplier: 1.5,
    maxTailMultiplier: 1.5,
    minimumSamples: 3,
  },
];
const passing = evaluatePerformanceBudgets(
  [summarizePerformanceMetric("paint", "cold", "milliseconds", 1, [5, 6, 7])],
  baseline,
  rules,
);
assert.equal(passing[0]?.status, "pass");
assert.equal(passing[1]?.status, "skipped");

const failing = evaluatePerformanceBudgets(
  [summarizePerformanceMetric("paint", "cold", "milliseconds", 1, [8, 9, 10])],
  baseline,
  rules.slice(0, 1),
);
assert.equal(failing[0]?.status, "fail");
assert.throws(() => assertPerformanceBudgets(failing), /regression budget failed/u);
assert.throws(
  () => assertPerformanceCorrectness([{ name: "red-control", status: "fail" }]),
  /correctness failed/u,
);

const profile = {
  schemaVersion: 1,
  suite: "electron-performance-seams",
  runtime: { platform: "linux", arch: "x64" },
  environment: {
    display: "xvfb",
    ozonePlatform: "x11",
    gpuDisabled: true,
    cpuCount: 8,
    cpuModel: "fixture cpu",
    memoryTotalBytes: 1024,
  },
};
assert.deepEqual(performanceBaselineCompatibility(profile, structuredClone(profile)), {
  compatible: true,
  mismatches: [],
});
const foreignProfile = structuredClone(profile);
foreignProfile.environment.cpuModel = "other cpu";
foreignProfile.environment.memoryTotalBytes = 2048;
assert.deepEqual(performanceBaselineCompatibility(profile, foreignProfile), {
  compatible: false,
  mismatches: ["environment.cpuModel", "environment.memoryTotalBytes"],
});

process.stdout.write("Performance seam logic checks passed.\n");
