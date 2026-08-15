import { describe, expect, it } from "vitest";
import { buildVaultScaleManifest } from "./vault-scale-corpus";
import { createIncrementalMutationPlan, incrementalMutationCount } from "./vault-scale-kernel";

describe("vault-scale incremental mutation plan", () => {
  it("allocates deterministic touch, add, and delete sets of one hundred notes", () => {
    const plan = createIncrementalMutationPlan(buildVaultScaleManifest("full"));

    expect(incrementalMutationCount).toBe(100);
    expect(plan.touchPaths).toHaveLength(100);
    expect(plan.additionPaths).toHaveLength(100);
    expect(plan.deletePaths).toHaveLength(100);
    expect(plan.deletePaths).toEqual(plan.touchPaths);
    expect(new Set([...plan.touchPaths, ...plan.additionPaths]).size).toBe(200);
    expect(plan.additionPaths).toEqual(
      expect.arrayContaining([
        "threadleaf-performance-incremental/added-001.md",
        "threadleaf-performance-incremental/added-100.md",
      ]),
    );
  }, 30_000);
});
