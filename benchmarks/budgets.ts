import type { BenchmarkBudgetRule } from "./results";

/**
 * These are relative budgets against the checked-in reference run, not universal SLAs.
 * Keep the reference and this policy together when a deliberate implementation change lands.
 */
export const benchmarkBudgetRules: readonly BenchmarkBudgetRule[] = [
  {
    metric: "metadata-index-rebuild",
    baselineMetric: "metadata-index-rebuild",
    maxMedianMultiplier: 1.75,
    maxTailMultiplier: 2.25,
    minimumSamples: 5,
  },
  {
    metric: "workspace-runtime-activation",
    baselineMetric: "workspace-runtime-activation",
    maxMedianMultiplier: 1.75,
    maxTailMultiplier: 2.25,
    minimumSamples: 5,
  },
  {
    metric: "watcher-burst-incremental-index",
    baselineMetric: "watcher-burst-incremental-index",
    maxMedianMultiplier: 2,
    maxTailMultiplier: 2.5,
    minimumSamples: 5,
  },
  {
    metric: "search-rare-query",
    baselineMetric: "search-rare-query",
    maxMedianMultiplier: 2,
    maxTailMultiplier: 2.5,
    minimumSamples: 5,
  },
  {
    metric: "search-broad-query",
    baselineMetric: "search-broad-query",
    maxMedianMultiplier: 2,
    maxTailMultiplier: 2.5,
    minimumSamples: 5,
  },
];
