import path from "node:path";
import { hasHiddenVaultSegment, hasPrivateVaultSegment, normalizeVaultPath } from "./path-policy";
import type { VaultAttachmentIngressAuthorization, VaultMarkdownCorpus } from "./ports";

export type WritePhase = "intent" | "staged" | "backed-up" | "prepared" | "installed" | "committed";
export type RenamePhase = "intent" | "staged" | "linked" | "published" | "committed";
export type MultiWritePhase = "intent" | "applying" | "committed";
export type MoveWithWritesPhase =
  | "intent"
  | "publishing"
  | "published"
  | "applying"
  | "renaming"
  | "rolling-back"
  | "committed";
export type AttachmentIngressPhase = "intent" | "staged" | "published" | "committed";

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
  strictContainment?: boolean;
}

export interface RenameJournal extends JournalBase {
  kind: "rename";
  phase: RenamePhase;
  sourcePath: string;
  targetPath: string;
  expectedRevision: string;
  /** Optional for journals written before corpus-bound attachment moves. */
  expectedMarkdownCorpus?: VaultMarkdownCorpus | null;
  strictContainment?: boolean;
  /** Attachment publication creates a new target but deliberately retains the source. */
  sourceRetained?: boolean;
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
  /** Corpus observed before any child rewrite was allowed to start. */
  expectedMarkdownCorpusBeforeWrites?: VaultMarkdownCorpus | null;
  /** Corpus expected after the journal's rewrite entries have been applied. */
  expectedMarkdownCorpus?: VaultMarkdownCorpus | null;
  strictContainment?: boolean;
  /** Attachment publication creates a new target but deliberately retains the source. */
  sourceRetained?: boolean;
}

export interface AttachmentIngressJournal extends JournalBase {
  kind: "attachment-ingress";
  phase: AttachmentIngressPhase;
  targetPath: string;
  contentRevision: string;
  byteLength: number;
  authorization: VaultAttachmentIngressAuthorization;
}

export type TransactionJournal =
  | WriteJournal
  | RenameJournal
  | MultiWriteJournal
  | MoveWithWritesJournal
  | AttachmentIngressJournal;

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
const renamePhases = new Set<RenamePhase>(["intent", "staged", "linked", "published", "committed"]);
const multiWritePhases = new Set<MultiWritePhase>(["intent", "applying", "committed"]);
const multiWriteStatuses = new Set<MultiWriteEntryStatus>(["pending", "committed", "conflict"]);
const moveWithWritesPhases = new Set<MoveWithWritesPhase>([
  "intent",
  "publishing",
  "published",
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
const attachmentIngressPhases = new Set<AttachmentIngressPhase>([
  "intent",
  "staged",
  "published",
  "committed",
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

function isMarkdownCorpus(value: unknown): value is VaultMarkdownCorpus {
  if (
    !isRecord(value) ||
    (!hasExactKeys(value, ["paths", "revisions", "generation"]) &&
      !hasExactKeys(value, ["paths", "revisions", "generation", "scope"]))
  ) {
    return false;
  }
  if (
    typeof value.generation !== "string" ||
    value.generation.length === 0 ||
    ("scope" in value && value.scope !== "references") ||
    !Array.isArray(value.paths) ||
    !Array.isArray(value.revisions) ||
    value.paths.some((entry) => typeof entry !== "string")
  ) {
    return false;
  }
  const paths = new Set<string>();
  for (const entry of value.paths) {
    try {
      if (normalizeVaultPath(entry) !== entry || paths.has(entry)) return false;
    } catch {
      return false;
    }
    paths.add(entry);
  }
  if (value.revisions.length !== value.paths.length) return false;
  const revisionPaths = new Set<string>();
  for (const entry of value.revisions) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ["path", "revision"]) ||
      typeof entry.path !== "string" ||
      !isRevision(entry.revision) ||
      !paths.has(entry.path) ||
      revisionPaths.has(entry.path)
    ) {
      return false;
    }
    revisionPaths.add(entry.path);
  }
  return revisionPaths.size === paths.size;
}

function isOptionalMarkdownCorpus(value: unknown): value is VaultMarkdownCorpus | null {
  return value === null || isMarkdownCorpus(value);
}

function isAttachmentIngressAuthorization(
  value: unknown,
  targetPath: string,
): value is VaultAttachmentIngressAuthorization {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "operation",
      "sourceNotePath",
      "sourceNoteRevision",
      "missingPath",
      "missingResolverTarget",
    ]) ||
    value.operation !== "restore-missing" ||
    typeof value.sourceNotePath !== "string" ||
    typeof value.missingPath !== "string" ||
    typeof value.missingResolverTarget !== "string" ||
    value.missingResolverTarget.length === 0 ||
    value.missingResolverTarget.length > 4_096 ||
    !isRevision(value.sourceNoteRevision)
  ) {
    return false;
  }
  try {
    const sourceNotePath = normalizeVaultPath(value.sourceNotePath);
    const missingPath = normalizeVaultPath(value.missingPath);
    return (
      sourceNotePath === value.sourceNotePath &&
      sourceNotePath.toLocaleLowerCase("en-US").endsWith(".md") &&
      !hasHiddenVaultSegment(sourceNotePath) &&
      !hasPrivateVaultSegment(sourceNotePath) &&
      missingPath === value.missingPath &&
      missingPath === targetPath &&
      !hasHiddenVaultSegment(missingPath) &&
      !hasPrivateVaultSegment(missingPath)
    );
  } catch {
    return false;
  }
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
    const hasStrict = hasExactKeys(input, [...expectedKeys, "strictContainment"]);
    if (
      (!hasExactKeys(input, expectedKeys) && !hasStrict) ||
      typeof input.phase !== "string" ||
      !writePhases.has(input.phase as WritePhase) ||
      typeof input.targetPath !== "string" ||
      typeof input.temporaryPath !== "string" ||
      typeof input.rollbackPath !== "string" ||
      !isNullableRevision(input.expectedRevision) ||
      !isNullableRevision(input.beforeRevision) ||
      !isRevision(input.nextRevision) ||
      (hasStrict && input.strictContainment !== true)
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
    const hasBase = hasExactKeys(input, expectedKeys);
    const hasCorpus = hasExactKeys(input, [...expectedKeys, "expectedMarkdownCorpus"]);
    const hasStrict = hasExactKeys(input, [...expectedKeys, "strictContainment"]);
    const hasCorpusAndStrict = hasExactKeys(input, [
      ...expectedKeys,
      "expectedMarkdownCorpus",
      "strictContainment",
    ]);
    const hasStrictAndRetained = hasExactKeys(input, [
      ...expectedKeys,
      "strictContainment",
      "sourceRetained",
    ]);
    const hasCorpusStrictAndRetained = hasExactKeys(input, [
      ...expectedKeys,
      "expectedMarkdownCorpus",
      "strictContainment",
      "sourceRetained",
    ]);
    const includesCorpus = hasCorpus || hasCorpusAndStrict || hasCorpusStrictAndRetained;
    const includesStrict =
      hasStrict || hasCorpusAndStrict || hasStrictAndRetained || hasCorpusStrictAndRetained;
    const includesRetained = hasStrictAndRetained || hasCorpusStrictAndRetained;
    if (
      (!hasBase &&
        !hasCorpus &&
        !hasStrict &&
        !hasCorpusAndStrict &&
        !hasStrictAndRetained &&
        !hasCorpusStrictAndRetained) ||
      typeof input.phase !== "string" ||
      !renamePhases.has(input.phase as RenamePhase) ||
      typeof input.sourcePath !== "string" ||
      typeof input.targetPath !== "string" ||
      !isRevision(input.expectedRevision) ||
      (includesCorpus && !isOptionalMarkdownCorpus(input.expectedMarkdownCorpus)) ||
      (includesStrict && input.strictContainment !== true) ||
      (includesRetained && input.sourceRetained !== true) ||
      (includesRetained && input.strictContainment !== true)
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
    if (input.sourceRetained === true && input.strictContainment !== true) {
      throw new Error("Source-retained attachment journals require strict containment.");
    }
    if (input.phase === "published" && input.sourceRetained !== true) {
      throw new Error("Published rename journals must retain the source.");
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
    const hasBase = hasExactKeys(input, expectedKeys);
    const hasCorpus = hasExactKeys(input, [...expectedKeys, "expectedMarkdownCorpus"]);
    const hasStrict = hasExactKeys(input, [...expectedKeys, "strictContainment"]);
    const hasCorpusAndStrict = hasExactKeys(input, [
      ...expectedKeys,
      "expectedMarkdownCorpus",
      "strictContainment",
    ]);
    const hasBeforeAndAfterCorpus = hasExactKeys(input, [
      ...expectedKeys,
      "expectedMarkdownCorpusBeforeWrites",
      "expectedMarkdownCorpus",
    ]);
    const hasBeforeAfterAndStrict = hasExactKeys(input, [
      ...expectedKeys,
      "expectedMarkdownCorpusBeforeWrites",
      "expectedMarkdownCorpus",
      "strictContainment",
    ]);
    const hasStrictAndRetained = hasExactKeys(input, [
      ...expectedKeys,
      "strictContainment",
      "sourceRetained",
    ]);
    const hasBeforeAfterStrictAndRetained = hasExactKeys(input, [
      ...expectedKeys,
      "expectedMarkdownCorpusBeforeWrites",
      "expectedMarkdownCorpus",
      "strictContainment",
      "sourceRetained",
    ]);
    const hasCorpusStrictAndRetained = hasExactKeys(input, [
      ...expectedKeys,
      "expectedMarkdownCorpus",
      "strictContainment",
      "sourceRetained",
    ]);
    const includesCorpus =
      hasCorpus ||
      hasCorpusAndStrict ||
      hasBeforeAndAfterCorpus ||
      hasBeforeAfterAndStrict ||
      hasCorpusStrictAndRetained ||
      hasBeforeAfterStrictAndRetained;
    const includesBeforeCorpus =
      hasBeforeAndAfterCorpus || hasBeforeAfterAndStrict || hasBeforeAfterStrictAndRetained;
    const includesStrict =
      hasStrict ||
      hasCorpusAndStrict ||
      hasBeforeAfterAndStrict ||
      hasStrictAndRetained ||
      hasCorpusStrictAndRetained ||
      hasBeforeAfterStrictAndRetained;
    const includesRetained =
      hasStrictAndRetained || hasCorpusStrictAndRetained || hasBeforeAfterStrictAndRetained;
    if (
      (!hasBase &&
        !hasCorpus &&
        !hasStrict &&
        !hasCorpusAndStrict &&
        !hasBeforeAndAfterCorpus &&
        !hasBeforeAfterAndStrict &&
        !hasStrictAndRetained &&
        !hasCorpusStrictAndRetained &&
        !hasBeforeAfterStrictAndRetained) ||
      typeof input.phase !== "string" ||
      !moveWithWritesPhases.has(input.phase as MoveWithWritesPhase) ||
      typeof input.sourcePath !== "string" ||
      typeof input.targetPath !== "string" ||
      !isRevision(input.expectedSourceRevision) ||
      !isRevision(input.renameRevision) ||
      !(input.reason === null || typeof input.reason === "string") ||
      !Array.isArray(input.entries) ||
      input.entries.length === 0 ||
      (includesCorpus && !isOptionalMarkdownCorpus(input.expectedMarkdownCorpus)) ||
      (includesBeforeCorpus &&
        !isOptionalMarkdownCorpus(input.expectedMarkdownCorpusBeforeWrites)) ||
      (includesStrict && input.strictContainment !== true) ||
      (includesRetained && input.sourceRetained !== true) ||
      (includesRetained && input.strictContainment !== true)
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
    if (input.sourceRetained === true && input.strictContainment !== true) {
      throw new Error("Source-retained attachment journals require strict containment.");
    }
    if (
      (input.phase === "publishing" || input.phase === "published") &&
      input.sourceRetained !== true
    ) {
      throw new Error("Publishing move journals must retain the source.");
    }
    return input as unknown as MoveWithWritesJournal;
  }

  if (input.kind === "attachment-ingress") {
    const expectedKeys = [
      "version",
      "id",
      "vaultId",
      "createdAt",
      "kind",
      "phase",
      "targetPath",
      "contentRevision",
      "byteLength",
      "authorization",
    ] as const;
    if (
      !hasExactKeys(input, expectedKeys) ||
      typeof input.phase !== "string" ||
      !attachmentIngressPhases.has(input.phase as AttachmentIngressPhase) ||
      typeof input.targetPath !== "string" ||
      !isRevision(input.contentRevision) ||
      !Number.isSafeInteger(input.byteLength) ||
      (input.byteLength as number) < 0
    ) {
      throw new Error("Attachment-ingress journal shape is invalid.");
    }
    const targetPath = normalizeVaultPath(input.targetPath);
    if (
      targetPath !== input.targetPath ||
      hasHiddenVaultSegment(targetPath) ||
      hasPrivateVaultSegment(targetPath) ||
      !isAttachmentIngressAuthorization(input.authorization, targetPath)
    ) {
      throw new Error("Attachment-ingress journal authorization is invalid.");
    }
    return input as unknown as AttachmentIngressJournal;
  }

  throw new Error("Journal kind is invalid.");
}
