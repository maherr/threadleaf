import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertBudgetPasses, evaluateBudgets, summarizeMetric } from "./results";

function metric(name: string, samples: number[]) {
  return summarizeMetric(name, "milliseconds", [samples[0] ?? 1], samples);
}

const baseline = {
  schemaVersion: 1 as const,
  profile: "fixture",
  source: "checked-in fixture baseline",
  host: { node: "node-test", platform: "test", arch: "test" },
  metrics: [metric("fixture-operation", [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10])],
};

describe("benchmark result budgets", () => {
  it("ships a parseable versioned result schema for every emitted top-level field", () => {
    const schema = JSON.parse(
      readFileSync(new URL("./result-schema.json", import.meta.url), "utf8"),
    ) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    const required = schema.required ?? [];
    expect(required).toEqual([
      "schemaVersion",
      "generatedAt",
      "profile",
      "corpus",
      "runtime",
      "configuration",
      "correctness",
      "metrics",
      "memoryObservation",
      "budgets",
      "limitations",
    ]);
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([...required].sort());
  });

  it("uses a robust p90 tail so one noisy sample does not fail a configured budget", () => {
    const current = metric("fixture-operation", [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10_000]);
    const [result] = evaluateBudgets(current ? [current] : [], baseline, [
      {
        metric: "fixture-operation",
        baselineMetric: "fixture-operation",
        maxMedianMultiplier: 1.1,
        maxTailMultiplier: 1.1,
        minimumSamples: 5,
      },
    ]);
    expect(result).toMatchObject({ status: "pass", medianRatio: 1, tailRatio: 1 });
  });

  it("turns red for a genuine configured regression", () => {
    const current = metric("fixture-operation", [30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40]);
    const [result] = evaluateBudgets([current], baseline, [
      {
        metric: "fixture-operation",
        baselineMetric: "fixture-operation",
        maxMedianMultiplier: 1.5,
        maxTailMultiplier: 1.5,
        minimumSamples: 5,
      },
    ]);
    expect(result?.status).toBe("fail");
  });

  it("skips rather than inventing a budget when a metric or baseline is missing", () => {
    const [result] = evaluateBudgets([metric("other-operation", [1, 1, 1])], baseline, [
      {
        metric: "missing-operation",
        baselineMetric: "missing-operation",
        maxMedianMultiplier: 1.5,
        maxTailMultiplier: 1.5,
        minimumSamples: 5,
      },
    ]);
    expect(result).toMatchObject({ status: "skipped" });
    if (!result) {
      throw new Error("Expected the missing benchmark metric to produce a skipped result.");
    }
    expect(() => assertBudgetPasses([result])).toThrow("failed or was unavailable");
  });
});
