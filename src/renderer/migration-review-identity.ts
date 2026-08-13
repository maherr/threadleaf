export type MigrationReviewOperation =
  | {
      kind: "apply";
      requestId: number;
      vaultId: string;
      planId: string;
    }
  | {
      kind: "rollback";
      requestId: number;
      vaultId: string;
      transactionId: string;
    };

export interface MigrationReviewIdentityState {
  requestId: number;
  vaultId: string | null;
  planId: string | null;
  transactionId: string | null;
}

/**
 * A renderer response may arrive after a vault switch or a newer preview. Such a
 * response must not mutate the newer review state or clear its selection.
 */
export function migrationReviewOperationIsCurrent(
  operation: MigrationReviewOperation,
  current: MigrationReviewIdentityState,
): boolean {
  if (operation.requestId !== current.requestId || operation.vaultId !== current.vaultId) {
    return false;
  }
  return operation.kind === "apply"
    ? operation.planId === current.planId
    : operation.transactionId === current.transactionId;
}
