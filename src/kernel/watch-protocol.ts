import { randomUUID } from "node:crypto";

export interface WatchedPathState {
  path: string;
  identity: string;
  revision: string;
  size: number;
  modifiedNs: string;
  changedNs: string;
}

export type VaultChange =
  | { kind: "upsert"; state: WatchedPathState; operationId?: string }
  | { kind: "delete"; path: string; operationId?: string }
  | { kind: "move"; from: string; to: string; state: WatchedPathState; operationId?: string };

export type RescanReason =
  | "startup"
  | "backend-error"
  | "overflow"
  | "ambiguous-rename"
  | "sequence-gap"
  | "stream-restarted";

export interface RescanRequest {
  scope: "subtree" | "vault";
  reason: RescanReason;
  path?: string;
}

export interface VaultChangeBatch {
  streamId: string;
  sequence: number;
  observedAt: string;
  changes: VaultChange[];
  rescan?: RescanRequest;
}

export interface PendingChangeBatch {
  changes?: VaultChange[];
  rescan?: RescanRequest;
}

export interface WatchBatchDecision {
  accepted: boolean;
  batch: VaultChangeBatch;
  rescan?: RescanRequest;
}

export class WatchBatchSequencer {
  readonly streamId: string;
  readonly #clock: () => Date;
  #sequence = 0;

  constructor(options: { streamId?: string; clock?: () => Date } = {}) {
    this.streamId = options.streamId ?? randomUUID();
    this.#clock = options.clock ?? (() => new Date());
  }

  next(pending: PendingChangeBatch): VaultChangeBatch {
    this.#sequence += 1;
    return {
      streamId: this.streamId,
      sequence: this.#sequence,
      observedAt: this.#clock().toISOString(),
      changes: pending.changes ?? [],
      ...(pending.rescan ? { rescan: pending.rescan } : {}),
    };
  }
}

export class WatchSequenceGate {
  #streamId: string | undefined;
  #sequence = 0;

  accept(batch: VaultChangeBatch): WatchBatchDecision {
    if (this.#streamId === undefined) {
      this.#streamId = batch.streamId;
      this.#sequence = batch.sequence;
      if (batch.sequence !== 1) {
        return {
          accepted: false,
          batch,
          rescan: { scope: "vault", reason: "sequence-gap" },
        };
      }
      return { accepted: true, batch, ...(batch.rescan ? { rescan: batch.rescan } : {}) };
    }

    if (batch.streamId !== this.#streamId) {
      this.#streamId = batch.streamId;
      this.#sequence = batch.sequence;
      return {
        accepted: false,
        batch,
        rescan: { scope: "vault", reason: "stream-restarted" },
      };
    }

    const expected = this.#sequence + 1;
    this.#sequence = Math.max(this.#sequence, batch.sequence);
    if (batch.sequence !== expected) {
      return {
        accepted: false,
        batch,
        rescan: { scope: "vault", reason: "sequence-gap" },
      };
    }
    return { accepted: true, batch, ...(batch.rescan ? { rescan: batch.rescan } : {}) };
  }
}

export type ExpectedVaultOperation =
  | { id: string; kind: "write"; path: string; revision: string }
  | { id: string; kind: "rename"; from: string; to: string; revision: string };

export class WatchOperationLedger {
  readonly #operations = new Map<string, ExpectedVaultOperation>();

  expect(operation: ExpectedVaultOperation): void {
    this.#operations.set(operation.id, operation);
  }

  annotate(changes: readonly VaultChange[]): VaultChange[] {
    const annotated = changes.map((change) => ({ ...change }));
    for (const operation of this.#operations.values()) {
      const indexes = this.match(operation, annotated);
      if (!indexes) {
        continue;
      }
      for (const index of indexes) {
        const change = annotated[index];
        if (change) {
          annotated[index] = { ...change, operationId: operation.id };
        }
      }
      this.#operations.delete(operation.id);
    }
    return annotated;
  }

  get size(): number {
    return this.#operations.size;
  }

  clear(): void {
    this.#operations.clear();
  }

  private match(
    operation: ExpectedVaultOperation,
    changes: readonly VaultChange[],
  ): number[] | null {
    if (operation.kind === "write") {
      const index = changes.findIndex(
        (change) =>
          change.kind === "upsert" &&
          change.state.path === operation.path &&
          change.state.revision === operation.revision &&
          change.operationId === undefined,
      );
      return index === -1 ? null : [index];
    }

    const moveIndex = changes.findIndex(
      (change) =>
        change.kind === "move" &&
        change.from === operation.from &&
        change.to === operation.to &&
        change.state.revision === operation.revision &&
        change.operationId === undefined,
    );
    return moveIndex === -1 ? null : [moveIndex];
  }
}
