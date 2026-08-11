import path from "node:path";
import { normalizeVaultPath } from "./path-policy";

export type WritePhase = "intent" | "staged" | "backed-up" | "prepared" | "installed" | "committed";
export type RenamePhase = "intent" | "linked" | "committed";
export type MultiWritePhase = "intent" | "applying" | "committed";
export type MoveWithWritesPhase = "intent" | "applying" | "renaming" | "rolling-back" | "committed";

interface JournalBase {
  version: 1;
  id: string;
  vaultId: string;
  createdAt: string;
}

export interface WriteJournal extends JournalBase {
  kind: "write";
  phase: WritePhase;
  targetPath: string;
  temporaryPath: string;
  rollbackPath: string;
  expectedRevision: string | null;
  beforeRevision: string | null;
  nextRevision: string;
}

export interface RenameJournal extends JournalBase {
  kind: "rename";
  phase: RenamePhase;
  sourcePath: string;
  targetPath: string;
  expectedRevision: string;
}

export type MultiWriteEntryStatus = "pending" | "committed" | "conflict";

export interface MultiWriteJournalEntry {
  targetPath: string;
  expectedRevision: string | null;
  nextRevision: string;
  status: MultiWriteEntryStatus;
  currentRevision: string | null;
  conflictPath: string | null;
}

export interface MultiWriteJournal extends JournalBase {
  kind: "multi-write";
  phase: MultiWritePhase;
  entries: MultiWriteJournalEntry[];
}

export type MoveWithWritesEntryStatus = "pending" | "applied" | "rolled-back" | "conflict";

export interface MoveWithWritesJournalEntry {
  targetPath: string;
  beforeRevision: string;
  nextRevision: string;
  status: MoveWithWritesEntryStatus;
  currentRevision: string | null;
  conflictPath: string | null;
}

export interface MoveWithWritesJournal extends JournalBase {
  kind: "move-with-writes";
  phase: MoveWithWritesPhase;
  sourcePath: string;
  targetPath: string;
  expectedSourceRevision: string;
  renameRevision: string;
  reason: string | null;
  entries: MoveWithWritesJournalEntry[];
}

export type TransactionJournal =
  | WriteJournal
  | RenameJournal
  | MultiWriteJournal
  | MoveWithWritesJournal;

const revisionPattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const writePhases = new Set<WritePhase>([
  "intent",
  "staged",
  "backed-up",
  "prepared",
  "installed",
  "committed",
]);
const renamePhases = new Set<RenamePhase>(["intent", "linked", "committed"]);
const multiWritePhases = new Set<MultiWritePhase>(["intent", "applying", "committed"]);
const multiWriteStatuses = new Set<MultiWriteEntryStatus>(["pending", "committed", "conflict"]);
const moveWithWritesPhases = new Set<MoveWithWritesPhase>([
  "intent",
  "applying",
  "renaming",
  "rolling-back",
  "committed",
]);
const moveWithWritesStatuses = new Set<MoveWithWritesEntryStatus>([
  "pending",
  "applied",
  "rolled-back",
  "conflict",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRevision(value: unknown): value is string {
  return typeof value === "string" && revisionPattern.test(value);
}

function isNullableRevision(value: unknown): value is string | null {
  return value === null || isRevision(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function auxiliaryWritePaths(
  targetPath: string,
  id: string,
): {
  temporaryPath: string;
  rollbackPath: string;
} {
  const directory = path.posix.dirname(targetPath);
  const prefix = directory === "." ? "" : `${directory}/`;
  return {
    temporaryPath: `${prefix}.threadleaf-write-${id}.tmp`,
    rollbackPath: `${prefix}.threadleaf-rollback-${id}.tmp`,
  };
}

function assertBase(
  value: Record<string, unknown>,
  expectedVaultId: string,
  expectedFileId: string,
): asserts value is Record<string, unknown> & JournalBase {
  if (
    value.version !== 1 ||
    typeof value.id !== "string" ||
    !uuidPattern.test(value.id) ||
    value.id !== expectedFileId ||
    value.vaultId !== expectedVaultId ||
    !isIsoTimestamp(value.createdAt)
  ) {
    throw new Error("Journal identity or version is invalid.");
  }
}

export function parseTransactionJournal(
  input: unknown,
  expectedVaultId: string,
  expectedFileId: string,
): TransactionJournal {
  if (!isRecord(input)) {
    throw new Error("Journal must be a JSON object.");
  }
  assertBase(input, expectedVaultId, expectedFileId);

  if (input.kind === "write") {
    const expectedKeys = [
      "version",
      "id",
      "vaultId",
      "createdAt",
      "kind",
      "phase",
      "targetPath",
      "temporaryPath",
      "rollbackPath",
      "expectedRevision",
      "beforeRevision",
      "nextRevision",
    ] as const;
    if (
      !hasExactKeys(input, expectedKeys) ||
      typeof input.phase !== "string" ||
      !writePhases.has(input.phase as WritePhase) ||
      typeof input.targetPath !== "string" ||
      typeof input.temporaryPath !== "string" ||
      typeof input.rollbackPath !== "string" ||
      !isNullableRevision(input.expectedRevision) ||
      !isNullableRevision(input.beforeRevision) ||
      !isRevision(input.nextRevision)
    ) {
      throw new Error("Write journal shape is invalid.");
    }
    const targetPath = normalizeVaultPath(input.targetPath);
    const expectedAuxiliary = auxiliaryWritePaths(targetPath, input.id);
    if (
      input.targetPath !== targetPath ||
      input.temporaryPath !== expectedAuxiliary.temporaryPath ||
      input.rollbackPath !== expectedAuxiliary.rollbackPath ||
      input.beforeRevision !== input.expectedRevision
    ) {
      throw new Error("Write journal paths or revisions are inconsistent.");
    }
    return input as unknown as WriteJournal;
  }

  if (input.kind === "rename") {
    const expectedKeys = [
      "version",
      "id",
      "vaultId",
      "createdAt",
      "kind",
      "phase",
      "sourcePath",
      "targetPath",
      "expectedRevision",
    ] as const;
    if (
      !hasExactKeys(input, expectedKeys) ||
      typeof input.phase !== "string" ||
      !renamePhases.has(input.phase as RenamePhase) ||
      typeof input.sourcePath !== "string" ||
      typeof input.targetPath !== "string" ||
      !isRevision(input.expectedRevision)
    ) {
      throw new Error("Rename journal shape is invalid.");
    }
    const sourcePath = normalizeVaultPath(input.sourcePath);
    const targetPath = normalizeVaultPath(input.targetPath);
    if (
      input.sourcePath !== sourcePath ||
      input.targetPath !== targetPath ||
      sourcePath === targetPath
    ) {
      throw new Error("Rename journal paths are inconsistent.");
    }
    return input as unknown as RenameJournal;
  }

  if (input.kind === "multi-write") {
    const expectedKeys = [
      "version",
      "id",
      "vaultId",
      "createdAt",
      "kind",
      "phase",
      "entries",
    ] as const;
    if (
      !hasExactKeys(input, expectedKeys) ||
      typeof input.phase !== "string" ||
      !multiWritePhases.has(input.phase as MultiWritePhase) ||
      !Array.isArray(input.entries) ||
      input.entries.length === 0
    ) {
      throw new Error("Multi-write journal shape is invalid.");
    }
    const seenPaths = new Set<string>();
    for (const entry of input.entries) {
      if (
        !isRecord(entry) ||
        !hasExactKeys(entry, [
          "targetPath",
          "expectedRevision",
          "nextRevision",
          "status",
          "currentRevision",
          "conflictPath",
        ]) ||
        typeof entry.targetPath !== "string" ||
        !isNullableRevision(entry.expectedRevision) ||
        !isRevision(entry.nextRevision) ||
        typeof entry.status !== "string" ||
        !multiWriteStatuses.has(entry.status as MultiWriteEntryStatus) ||
        !isNullableRevision(entry.currentRevision) ||
        !(entry.conflictPath === null || typeof entry.conflictPath === "string")
      ) {
        throw new Error("Multi-write journal entry is invalid.");
      }
      const targetPath = normalizeVaultPath(entry.targetPath);
      if (targetPath !== entry.targetPath || seenPaths.has(targetPath)) {
        throw new Error("Multi-write journal paths are invalid or duplicated.");
      }
      seenPaths.add(targetPath);
      if (entry.conflictPath !== null) {
        const conflictPath = normalizeVaultPath(entry.conflictPath);
        if (conflictPath !== entry.conflictPath) {
          throw new Error("Multi-write conflict path is invalid.");
        }
      }
      if (
        (entry.status === "pending" &&
          (entry.currentRevision !== null || entry.conflictPath !== null)) ||
        (entry.status === "committed" &&
          (entry.currentRevision !== entry.nextRevision || entry.conflictPath !== null)) ||
        (entry.status === "conflict" && entry.conflictPath === null)
      ) {
        throw new Error("Multi-write journal progress is inconsistent.");
      }
    }
    if (
      (input.phase === "intent" && input.entries.some((entry) => entry.status !== "pending")) ||
      (input.phase === "committed" && input.entries.some((entry) => entry.status === "pending"))
    ) {
      throw new Error("Multi-write journal phase is inconsistent with its entries.");
    }
    return input as unknown as MultiWriteJournal;
  }

  if (input.kind === "move-with-writes") {
    const expectedKeys = [
      "version",
      "id",
      "vaultId",
      "createdAt",
      "kind",
      "phase",
      "sourcePath",
      "targetPath",
      "expectedSourceRevision",
      "renameRevision",
      "reason",
      "entries",
    ] as const;
    if (
      !hasExactKeys(input, expectedKeys) ||
      typeof input.phase !== "string" ||
      !moveWithWritesPhases.has(input.phase as MoveWithWritesPhase) ||
      typeof input.sourcePath !== "string" ||
      typeof input.targetPath !== "string" ||
      !isRevision(input.expectedSourceRevision) ||
      !isRevision(input.renameRevision) ||
      !(input.reason === null || typeof input.reason === "string") ||
      !Array.isArray(input.entries) ||
      input.entries.length === 0
    ) {
      throw new Error("Move-with-writes journal shape is invalid.");
    }
    const sourcePath = normalizeVaultPath(input.sourcePath);
    const targetPath = normalizeVaultPath(input.targetPath);
    if (
      sourcePath !== input.sourcePath ||
      targetPath !== input.targetPath ||
      sourcePath === targetPath
    ) {
      throw new Error("Move-with-writes paths are inconsistent.");
    }
    const seenPaths = new Set<string>();
    let sourceEntry: MoveWithWritesJournalEntry | undefined;
    for (const entry of input.entries) {
      if (
        !isRecord(entry) ||
        !hasExactKeys(entry, [
          "targetPath",
          "beforeRevision",
          "nextRevision",
          "status",
          "currentRevision",
          "conflictPath",
        ]) ||
        typeof entry.targetPath !== "string" ||
        !isRevision(entry.beforeRevision) ||
        !isRevision(entry.nextRevision) ||
        typeof entry.status !== "string" ||
        !moveWithWritesStatuses.has(entry.status as MoveWithWritesEntryStatus) ||
        !isNullableRevision(entry.currentRevision) ||
        !(entry.conflictPath === null || typeof entry.conflictPath === "string")
      ) {
        throw new Error("Move-with-writes journal entry is invalid.");
      }
      const entryPath = normalizeVaultPath(entry.targetPath);
      if (entryPath !== entry.targetPath || entryPath === targetPath || seenPaths.has(entryPath)) {
        throw new Error("Move-with-writes entry paths are invalid or duplicated.");
      }
      seenPaths.add(entryPath);
      if (entryPath === sourcePath) {
        sourceEntry = entry as unknown as MoveWithWritesJournalEntry;
      }
      if (entry.conflictPath !== null) {
        const conflictPath = normalizeVaultPath(entry.conflictPath);
        if (conflictPath !== entry.conflictPath) {
          throw new Error("Move-with-writes conflict path is invalid.");
        }
      }
      if (
        (entry.status === "pending" &&
          (entry.currentRevision !== null || entry.conflictPath !== null)) ||
        (entry.status === "applied" &&
          (entry.currentRevision !== entry.nextRevision || entry.conflictPath !== null)) ||
        (entry.status === "rolled-back" &&
          (entry.currentRevision !== entry.beforeRevision || entry.conflictPath !== null)) ||
        (entry.status === "conflict" && entry.conflictPath === null)
      ) {
        throw new Error("Move-with-writes journal progress is inconsistent.");
      }
    }
    const expectedRenameRevision = sourceEntry?.nextRevision ?? input.expectedSourceRevision;
    if (
      input.renameRevision !== expectedRenameRevision ||
      (sourceEntry !== undefined && sourceEntry.beforeRevision !== input.expectedSourceRevision) ||
      (input.phase === "intent" && input.entries.some((entry) => entry.status !== "pending")) ||
      (input.phase === "committed" && input.entries.some((entry) => entry.status !== "applied")) ||
      (input.phase === "rolling-back" && input.reason === null) ||
      (input.phase === "committed" && input.reason !== null)
    ) {
      throw new Error("Move-with-writes journal state is inconsistent.");
    }
    return input as unknown as MoveWithWritesJournal;
  }

  throw new Error("Journal kind is invalid.");
}
