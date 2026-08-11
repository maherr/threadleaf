import path from "node:path";
import { normalizeVaultPath } from "./path-policy";

export type WritePhase = "intent" | "staged" | "backed-up" | "prepared" | "installed" | "committed";
export type RenamePhase = "intent" | "linked" | "committed";

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

export type TransactionJournal = WriteJournal | RenameJournal;

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

  throw new Error("Journal kind is invalid.");
}
