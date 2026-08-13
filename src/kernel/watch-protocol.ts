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
  | { id: string; kind: "delete"; path: string }
  | { id: string; kind: "rename"; from: string; to: string; revision: string }
  | {
      id: string;
      kind: "multi-write";
      writes: Array<{ path: string; revision: string }>;
    }
  | {
      id: string;
      kind: "move-with-writes";
      from: string;
      to: string;
      targetRevision: string;
      sourceRewritten: boolean;
      writes: Array<{ path: string; revision: string }>;
    };

export class WatchOperationLedger {
  readonly #operations = new Map<string, ExpectedVaultOperation>();
  #recentUnattributed: VaultChange[] = [];

  expect(operation: ExpectedVaultOperation): void {
    const recent = this.#recentUnattributed;
    this.normalizeMaterializedMove(operation, recent);
    if (this.match(operation, recent)) {
      this.#recentUnattributed = [];
      return;
    }
    this.#operations.set(operation.id, operation);
  }

  annotate(changes: readonly VaultChange[]): VaultChange[] {
    const annotated = changes.map((change) => ({ ...change }));
    for (const operation of this.#operations.values()) {
      this.normalizeMaterializedMove(operation, annotated);
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
    this.#recentUnattributed = annotated.filter((change) => change.operationId === undefined);
    return annotated;
  }

  get size(): number {
    return this.#operations.size;
  }

  clear(): void {
    this.#operations.clear();
    this.#recentUnattributed = [];
  }

  private normalizeMaterializedMove(
    operation: ExpectedVaultOperation,
    changes: VaultChange[],
  ): void {
    let move: { from: string; to: string; revision: string };
    if (operation.kind === "rename") {
      move = operation;
    } else if (operation.kind === "move-with-writes" && !operation.sourceRewritten) {
      move = { from: operation.from, to: operation.to, revision: operation.targetRevision };
    } else {
      return;
    }
    if (
      changes.some(
        (change) => change.kind === "move" && change.from === move.from && change.to === move.to,
      )
    ) {
      return;
    }

    const deleteIndex = changes.findIndex(
      (change) => change.kind === "delete" && change.path === move.from,
    );
    const upsertIndex = changes.findIndex(
      (change) =>
        change.kind === "upsert" &&
        change.state.path === move.to &&
        change.state.revision === move.revision,
    );
    if (deleteIndex === -1 || upsertIndex === -1) return;
    const firstIndex = Math.min(deleteIndex, upsertIndex);
    const secondIndex = Math.max(deleteIndex, upsertIndex);
    const target = changes[upsertIndex];
    if (target?.kind !== "upsert") return;
    const materializedMove: VaultChange = {
      kind: "move",
      from: move.from,
      to: move.to,
      state: target.state,
    };
    changes.splice(secondIndex, 1);
    changes.splice(firstIndex, 1, materializedMove);
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

    if (operation.kind === "rename") {
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

    if (operation.kind === "delete") {
      const deleteIndex = changes.findIndex(
        (change) =>
          change.kind === "delete" &&
          change.path === operation.path &&
          change.operationId === undefined,
      );
      return deleteIndex === -1 ? null : [deleteIndex];
    }

    const indexes: number[] = [];
    if (operation.kind === "move-with-writes") {
      if (operation.sourceRewritten) {
        const deleteIndex = changes.findIndex(
          (change) =>
            change.kind === "delete" &&
            change.path === operation.from &&
            change.operationId === undefined,
        );
        const targetIndex = changes.findIndex(
          (change) =>
            change.kind === "upsert" &&
            change.state.path === operation.to &&
            change.state.revision === operation.targetRevision &&
            change.operationId === undefined,
        );
        if (deleteIndex === -1 || targetIndex === -1) {
          return null;
        }
        indexes.push(deleteIndex, targetIndex);
      } else {
        const moveIndex = changes.findIndex(
          (change) =>
            change.kind === "move" &&
            change.from === operation.from &&
            change.to === operation.to &&
            change.state.revision === operation.targetRevision &&
            change.operationId === undefined,
        );
        if (moveIndex === -1) {
          return null;
        }
        indexes.push(moveIndex);
      }
    }
    for (const write of operation.writes) {
      const index = changes.findIndex(
        (change, candidateIndex) =>
          !indexes.includes(candidateIndex) &&
          change.kind === "upsert" &&
          change.state.path === write.path &&
          change.state.revision === write.revision &&
          change.operationId === undefined,
      );
      if (index === -1) {
        return null;
      }
      indexes.push(index);
    }
    return indexes;
  }
}
