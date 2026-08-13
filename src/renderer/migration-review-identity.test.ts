import { describe, expect, it } from "vitest";
import {
  type MigrationReviewIdentityState,
  migrationReviewOperationIsCurrent,
} from "./migration-review-identity";

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const initial: MigrationReviewIdentityState = {
  requestId: 1,
  vaultId: "vault-a",
  planId: "plan-a",
  transactionId: "transaction-a",
};

describe("migration review response identity", () => {
  it("ignores a deferred apply rejection after a newer preview and selection exist", async () => {
    const response = deferred<never>();
    const operation = {
      kind: "apply" as const,
      requestId: initial.requestId,
      vaultId: "vault-a",
      planId: "plan-a",
    };
    const newer: MigrationReviewIdentityState = {
      ...initial,
      requestId: 2,
      planId: "plan-b",
    };
    let newerPlanId: string | null = newer.planId;
    const newerSelection = new Set(["candidate-b"]);
    const applyRejection = response.promise.catch(() => {
      if (migrationReviewOperationIsCurrent(operation, newer)) {
        newerPlanId = null;
        newerSelection.clear();
        return true;
      }
      return false;
    });

    response.reject(new Error("stale apply"));
    await expect(applyRejection).resolves.toBe(false);
    expect(newerPlanId).toBe("plan-b");
    expect(newerSelection).toEqual(new Set(["candidate-b"]));
  });

  it("ignores a deferred rollback rejection after the active vault changes", async () => {
    const response = deferred<never>();
    const operation = {
      kind: "rollback" as const,
      requestId: initial.requestId,
      vaultId: "vault-a",
      transactionId: "transaction-a",
    };
    const newer: MigrationReviewIdentityState = {
      ...initial,
      requestId: 2,
      vaultId: "vault-b",
      planId: "plan-b",
      transactionId: null,
    };
    const rollbackRejection = response.promise.catch(() =>
      migrationReviewOperationIsCurrent(operation, newer),
    );

    response.reject(new Error("stale rollback"));
    await expect(rollbackRejection).resolves.toBe(false);
    expect(newer.vaultId).toBe("vault-b");
  });

  it("accepts a response only for the exact request, vault, and operation identity", () => {
    expect(
      migrationReviewOperationIsCurrent(
        {
          kind: "apply",
          requestId: 1,
          vaultId: "vault-a",
          planId: "plan-a",
        },
        initial,
      ),
    ).toBe(true);
    expect(
      migrationReviewOperationIsCurrent(
        {
          kind: "rollback",
          requestId: 1,
          vaultId: "vault-a",
          transactionId: "transaction-a",
        },
        initial,
      ),
    ).toBe(true);
    expect(
      migrationReviewOperationIsCurrent(
        {
          kind: "rollback",
          requestId: 1,
          vaultId: "vault-a",
          transactionId: "transaction-old",
        },
        initial,
      ),
    ).toBe(false);
  });
});
