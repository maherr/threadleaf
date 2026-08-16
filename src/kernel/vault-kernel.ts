import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { MAX_CANVAS_BYTES } from "../shared/json-canvas";
import {
  type AttachmentPublishCapability,
  AttachmentPublishCapabilityError,
  assertContainedAnonymousPublishCapability,
  assertContainedPublishCapability,
  atomicWriteFile,
  type ContainedRemovalHooks,
  durableCreate,
  durableCreateContainedFile,
  FILE_PUBLISH_CAPABILITY,
  type FileSnapshot,
  installContainedStagedFile,
  installStagedFile,
  moveContainedFileAside,
  pathExists,
  probeContainedPublishCapability,
  readContainedFile,
  readStableFile,
  readStableFileWithinLimit,
  removeExpectedContainedFile,
  removeExpectedFilePortably,
  removeIfPresent,
  revisionOf,
  syncDirectory,
} from "./durability";
import {
  type MoveWithWritesJournal,
  type MoveWithWritesJournalEntry,
  type MultiWriteJournal,
  type MultiWriteJournalEntry,
  parseTransactionJournal,
  type RenameJournal,
  type TransactionJournal,
  type WriteJournal,
} from "./journal";
import { VaultLinkResolver } from "./metadata-index";
import {
  canonicalizePotentialPath,
  hasHiddenVaultSegment,
  hasPrivateVaultSegment,
  isPathInside,
  normalizedVaultPathIdentity,
  normalizeVaultPath,
  VaultPathPolicy,
  type VisibleVaultPaths,
} from "./path-policy";
import type {
  MoveWithWritesRequest,
  MoveWithWritesResult,
  MultiWriteEntryResult,
  MultiWriteRequest,
  MultiWriteResult,
  StateRootPort,
  VaultAttachmentRelinkPreconditionFailure,
  VaultAttachmentRelinkPreconditions,
  VaultAttachmentRelinkWriteResult,
  VaultDirectoryCreateResult,
  VaultMarkdownCorpus,
  VaultMutationPort,
  VaultRenameResult,
  VaultTextSnapshot,
  VaultWriteResult,
} from "./ports";
import {
  type TransientAbsenceHandle,
  type TransientAbsenceRegistry,
  VaultTransientAbsences,
} from "./watch-protocol";

export type KernelFaultPoint =
  | "write:after-intent"
  | "write:after-stage"
  | "write:after-backup"
  | "write:before-final-check"
  | "write:after-prepare"
  | "write:after-move-aside"
  | "write:after-install"
  | "write:after-commit"
  | "rename:after-intent"
  | "rename:after-stage"
  | "rename:before-install"
  | "rename:after-install"
  | "rename:after-link"
  | "rename:before-publish"
  | "rename:after-publish"
  | "rename:after-source-check"
  | "rename:after-source-claim"
  | "rename:before-source-remove"
  | "rename:after-commit"
  | "rename:before-recovery-restore"
  | "rename:after-recovery-restore-copy"
  | "multi-write:after-intent"
  | "multi-write:after-entry"
  | "multi-write:after-commit"
  | "move-with-writes:after-intent"
  | "move-with-writes:after-corpus-preflight"
  | "move-with-writes:after-entry"
  | "move-with-writes:before-rename"
  | "move-with-writes:before-publish"
  | "move-with-writes:after-publish"
  | "move-with-writes:after-rename"
  | "move-with-writes:after-rollback-entry"
  | "move-with-writes:after-commit";

export type KernelFaultInjector = (point: KernelFaultPoint) => void | Promise<void>;

export interface VaultKernelOptions {
  vaultRoot: string;
  stateRoot: StateRootPort;
  readOnly?: boolean;
  faultInjector?: KernelFaultInjector;
  clock?: () => Date;
}

export type TextFileSnapshot = VaultTextSnapshot;

export interface BinaryFileSnapshot {
  path: string;
  bytes: Buffer;
  revision: string;
  size: number;
}

export type BinaryReadResult =
  | { status: "ready"; snapshot: BinaryFileSnapshot }
  | { status: "too-large"; path: string; size: number };

interface ExpectedRemovalOptions extends ContainedRemovalHooks {
  strictContainment?: boolean;
}

export type WriteResult = VaultWriteResult;
export type CreateResult =
  | { status: "committed"; path: string; revision: string; transactionId: string }
  | { status: "exists"; path: string; currentRevision: string }
  | {
      status: "conflict";
      path: string;
      currentRevision: string | null;
      conflictPath: string;
      transactionId: string;
    };
export type RenameResult = VaultRenameResult;
export type {
  MoveWithWritesRequest,
  MoveWithWritesResult,
  MultiWriteEntryResult,
  MultiWriteRequest,
  MultiWriteResult,
  VaultMarkdownCorpus,
} from "./ports";

export interface RecoveryAction {
  transactionId: string;
  kind: "write" | "rename" | "multi-write" | "move-with-writes";
  outcome:
    | "committed"
    | "published-source-retained"
    | "conflict-copy"
    | "rolled-back"
    | "manual-conflict";
  path: string;
  paths?: string[];
  conflictPath?: string;
}

export class VaultRecoveryError extends Error {
  readonly journalName: string;

  constructor(journalName: string, cause: unknown) {
    super(`Recovery is blocked by an invalid journal: ${journalName}`, { cause });
    this.name = "VaultRecoveryError";
    this.journalName = journalName;
  }
}

interface InternalWriteCommitted {
  status: "committed";
  revision: string;
  transactionId: string;
}

interface InternalWriteConflict {
  status: "conflict";
  currentRevision: string | null;
  conflictPath: string;
  transactionId: string;
}

type InternalWriteResult = InternalWriteCommitted | InternalWriteConflict;

interface InternalWritePreconditionFailure {
  status: "precondition-failed";
  reason: VaultAttachmentRelinkPreconditionFailure;
}

type WriteFinalPrecondition = () => Promise<VaultAttachmentRelinkPreconditionFailure | null>;

type StrictAttachmentTargetCheck =
  | { status: "ready"; targetAbsolute: string }
  | { status: "attachment-publish-unavailable" }
  | { status: "target-normalized-exists" };

interface MoveWithWritesBlobs {
  before: Buffer;
  next: Buffer;
}

const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const revisionPattern = /^[a-f0-9]{64}$/;

function revisionsMatch(snapshot: FileSnapshot | null, expectedRevision: string | null): boolean {
  return (snapshot?.revision ?? null) === expectedRevision;
}

function encodeJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sanitizeTimestamp(date: Date): string {
  return date.toISOString().replaceAll(/[-:.]/g, "");
}

function assertExpectedRevision(revision: string | null): void {
  if (revision !== null && !revisionPattern.test(revision)) {
    throw new Error("Expected revisions must be lowercase SHA-256 values or null.");
  }
}

function markdownCorpusGeneration(
  paths: readonly string[],
  revisions: readonly { path: string; revision: string }[],
): string {
  const sortedPaths = [...paths].sort((left, right) => left.localeCompare(right));
  const sortedRevisions = [...revisions]
    .map((entry) => ({ path: entry.path, revision: entry.revision }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return createHash("sha256")
    .update(JSON.stringify({ paths: sortedPaths, revisions: sortedRevisions }), "utf8")
    .digest("hex");
}

function changedMarkdownCorpusPaths(
  expected: VaultMarkdownCorpus,
  actual: VaultMarkdownCorpus,
): string[] {
  const changed = new Set<string>();
  const expectedPaths = new Set(expected.paths);
  const actualPaths = new Set(actual.paths);
  for (const entry of expectedPaths) if (!actualPaths.has(entry)) changed.add(entry);
  for (const entry of actualPaths) if (!expectedPaths.has(entry)) changed.add(entry);
  const expectedRevisions = new Map(
    expected.revisions.map((entry) => [entry.path, entry.revision]),
  );
  for (const entry of actual.revisions) {
    if (expectedRevisions.get(entry.path) !== entry.revision) changed.add(entry.path);
  }
  return [...changed].sort((left, right) => left.localeCompare(right));
}

function markdownCorpusConflictPaths(
  expected: VaultMarkdownCorpus,
  actual: VaultMarkdownCorpus,
): string[] {
  const changed = changedMarkdownCorpusPaths(expected, actual);
  if (
    changed.length > 0 ||
    expected.generation !== actual.generation ||
    (expected.scope ?? null) !== (actual.scope ?? null)
  ) {
    return changed.length > 0 ? changed : [...expected.paths];
  }
  return [];
}

export class VaultKernel implements VaultMutationPort {
  readonly paths: VaultPathPolicy;
  readonly stateRoot: string;
  readonly vaultId: string;
  readonly readOnly: boolean;
  readonly startupRecoveryActions: RecoveryAction[] = [];
  readonly attachmentPublishCapability: AttachmentPublishCapability;

  private readonly faultInjector: KernelFaultInjector | undefined;
  private readonly clock: () => Date;
  private readonly journalDirectory: string;
  private readonly historyDirectory: string;
  private readonly recoveryDirectory: string;
  private readonly rollbackClaimsDirectory: string;
  private readonly transactionDirectory: string;
  private mutationTail: Promise<void> = Promise.resolve();
  readonly #transientAbsences = new VaultTransientAbsences();

  private constructor(
    paths: VaultPathPolicy,
    stateRoot: string,
    vaultId: string,
    attachmentPublishCapability: AttachmentPublishCapability,
    options: VaultKernelOptions,
  ) {
    this.paths = paths;
    this.stateRoot = stateRoot;
    this.vaultId = vaultId;
    this.attachmentPublishCapability = attachmentPublishCapability;
    this.readOnly = options.readOnly ?? false;
    this.faultInjector = options.faultInjector;
    this.clock = options.clock ?? (() => new Date());
    this.journalDirectory = path.join(stateRoot, "journal");
    this.historyDirectory = path.join(stateRoot, "history");
    this.recoveryDirectory = path.join(stateRoot, "recovery");
    this.rollbackClaimsDirectory = path.join(this.recoveryDirectory, "rollback-claims");
    this.transactionDirectory = path.join(stateRoot, "transactions");
  }

  /**
   * The paths this kernel currently holds aside mid-write. A watcher that scans
   * inside such a window sees a deletion for a file that is coming back, and
   * this is how it can tell that reading apart from a real removal.
   */
  get transientAbsences(): TransientAbsenceRegistry {
    return this.#transientAbsences;
  }

  static async open(options: VaultKernelOptions): Promise<VaultKernel> {
    const paths = await VaultPathPolicy.open(options.vaultRoot);
    const configuredStateRoot = path.resolve(await options.stateRoot.getPath());
    const canonicalStateRoot = await canonicalizePotentialPath(configuredStateRoot);
    if (
      isPathInside(paths.rootPath, configuredStateRoot) ||
      isPathInside(paths.rootPath, canonicalStateRoot)
    ) {
      throw new Error("Threadleaf state must be stored outside the vault.");
    }

    const identityPath =
      process.platform === "win32" ? paths.rootPath.toLowerCase() : paths.rootPath;
    const vaultId = createHash("sha256").update(identityPath).digest("hex");
    const stateRoot = path.join(canonicalStateRoot, "vaults", vaultId);
    const attachmentPublishCapability = options.readOnly
      ? {
          status: "unsupported" as const,
          code: "unsupported-platform" as const,
          contract: FILE_PUBLISH_CAPABILITY,
          detail: "read-only vault",
        }
      : await probeContainedPublishCapability(paths.rootPath);
    const kernel = new VaultKernel(paths, stateRoot, vaultId, attachmentPublishCapability, options);
    if (kernel.readOnly) {
      return kernel;
    }
    await kernel.initializeState();
    const realizedStateRoot = await fs.realpath(kernel.stateRoot);
    if (isPathInside(paths.rootPath, realizedStateRoot)) {
      throw new Error("Threadleaf state must be stored outside the vault.");
    }
    kernel.startupRecoveryActions.push(...(await kernel.recover()));
    return kernel;
  }

  getName(): string {
    return this.paths.getName();
  }

  async listMarkdownPaths(relativeDirectory = ""): Promise<string[]> {
    return this.paths.listMarkdownPaths(relativeDirectory);
  }

  private async readStableCorpus(
    listPaths: () => Promise<string[]>,
    readRevision: (relativePath: string) => Promise<string>,
    scope?: "references",
  ): Promise<VaultMarkdownCorpus> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const paths = (await listPaths()).sort((left, right) => left.localeCompare(right));
      const revisions: Array<{ path: string; revision: string }> = [];
      let retry = false;
      for (const relativePath of paths) {
        try {
          revisions.push({ path: relativePath, revision: await readRevision(relativePath) });
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("File does not exist:")) {
            retry = true;
            break;
          }
          throw error;
        }
      }
      if (retry) continue;
      const finalPaths = (await listPaths()).sort((left, right) => left.localeCompare(right));
      if (
        finalPaths.length !== paths.length ||
        finalPaths.some((relativePath, index) => relativePath !== paths[index])
      ) {
        continue;
      }
      const finalRevisions: Array<{ path: string; revision: string }> = [];
      for (const relativePath of finalPaths) {
        try {
          finalRevisions.push({
            path: relativePath,
            revision: await readRevision(relativePath),
          });
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("File does not exist:")) {
            retry = true;
            break;
          }
          throw error;
        }
      }
      if (
        retry ||
        finalRevisions.some((entry, index) => entry.revision !== revisions[index]?.revision)
      ) {
        continue;
      }
      return {
        paths,
        revisions,
        generation: markdownCorpusGeneration(paths, revisions),
        ...(scope ? { scope } : {}),
      };
    }
    throw new Error("Reference corpus kept changing while it was read.");
  }

  async readMarkdownCorpus(): Promise<VaultMarkdownCorpus> {
    return this.readStableCorpus(
      () => this.listMarkdownPaths(),
      async (relativePath) => (await this.readText(relativePath)).revision,
    );
  }

  async readReferenceCorpus(): Promise<VaultMarkdownCorpus> {
    return this.readStableCorpus(
      async () => {
        const listing = await this.listVisiblePaths("");
        if (!listing.exists) return [];
        return listing.files.filter((relativePath) => {
          const folded = relativePath.toLocaleLowerCase("en-US");
          return folded.endsWith(".md") || folded.endsWith(".canvas");
        });
      },
      async (relativePath) => {
        if (!relativePath.toLocaleLowerCase("en-US").endsWith(".canvas")) {
          return (await this.readText(relativePath)).revision;
        }
        const result = await this.readBinary(relativePath, MAX_CANVAS_BYTES);
        if (result.status !== "ready") {
          throw new Error(`Canvas exceeds the bounded reference-corpus limit: ${relativePath}`);
        }
        return result.snapshot.revision;
      },
      "references",
    );
  }

  private async verifyMarkdownCorpus(
    expected: VaultMarkdownCorpus,
  ): Promise<{ ok: true } | { ok: false; conflictPaths: string[] }> {
    try {
      const actual =
        expected.scope === "references"
          ? await this.readReferenceCorpus()
          : await this.readMarkdownCorpus();
      const conflictPaths = markdownCorpusConflictPaths(expected, actual);
      return conflictPaths.length === 0 ? { ok: true } : { ok: false, conflictPaths };
    } catch {
      return { ok: false, conflictPaths: [...expected.paths] };
    }
  }

  async listVisiblePaths(relativeDirectory = ""): Promise<VisibleVaultPaths> {
    return this.paths.listVisiblePaths(relativeDirectory);
  }

  async readText(relativePath: string): Promise<TextFileSnapshot> {
    const normalized = normalizeVaultPath(relativePath);
    const absolutePath = await this.paths.resolveForRead(normalized);
    const snapshot = await readStableFile(absolutePath);
    if (!snapshot) {
      throw new Error(`File does not exist: ${normalized}`);
    }
    return {
      path: normalized,
      content: textDecoder.decode(snapshot.bytes),
      revision: snapshot.revision,
      size: snapshot.size,
    };
  }

  async resolveReadPath(relativePath: string): Promise<string> {
    const normalized = normalizeVaultPath(relativePath);
    const absolutePath = await this.paths.resolveForRead(normalized);
    return this.paths.toVaultPath(absolutePath);
  }

  async readBinary(relativePath: string, maxBytes: number): Promise<BinaryReadResult> {
    const normalized = normalizeVaultPath(relativePath);
    const absolutePath = await this.paths.resolveForRead(normalized);
    const result = await readStableFileWithinLimit(absolutePath, maxBytes);
    if (!result) {
      throw new Error(`File does not exist: ${normalized}`);
    }
    if (result.status === "too-large") {
      return { status: "too-large", path: normalized, size: result.size };
    }
    return {
      status: "ready",
      snapshot: {
        path: normalized,
        bytes: result.snapshot.bytes,
        revision: result.snapshot.revision,
        size: result.snapshot.size,
      },
    };
  }

  async writeText(
    relativePath: string,
    content: string,
    expectedRevision: string | null,
  ): Promise<WriteResult> {
    this.assertWritable();
    assertExpectedRevision(expectedRevision);
    return this.withMutation(async () => {
      const normalized = normalizeVaultPath(relativePath);
      const bytes = Buffer.from(content, "utf8");
      const result = await this.performWrite(normalized, bytes, expectedRevision);

      if (result.status === "committed") {
        return {
          status: "committed",
          path: normalized,
          revision: result.revision,
          transactionId: result.transactionId,
        };
      }
      return {
        status: "conflict",
        path: normalized,
        currentRevision: result.currentRevision,
        conflictPath: result.conflictPath,
        transactionId: result.transactionId,
      };
    });
  }

  async writeTextWithAttachmentPreconditions(
    relativePath: string,
    content: string,
    expectedRevision: string,
    preconditions: VaultAttachmentRelinkPreconditions,
  ): Promise<VaultAttachmentRelinkWriteResult> {
    this.assertWritable();
    assertExpectedRevision(expectedRevision);
    assertExpectedRevision(preconditions.replacementRevision);
    if (
      !Number.isSafeInteger(preconditions.maxReplacementBytes) ||
      preconditions.maxReplacementBytes <= 0
    ) {
      throw new Error("Attachment relink byte limits must be positive safe integers.");
    }
    return this.withMutation(async () => {
      const normalized = normalizeVaultPath(relativePath);
      const normalizedPreconditions: VaultAttachmentRelinkPreconditions = {
        ...preconditions,
        sourceNotePath: normalizeVaultPath(preconditions.sourceNotePath),
        missingPath: normalizeVaultPath(preconditions.missingPath),
        replacementPath: normalizeVaultPath(preconditions.replacementPath),
        replacementCanonicalPath: normalizeVaultPath(preconditions.replacementCanonicalPath),
      };
      const validate = () => this.checkAttachmentRelinkPreconditions(normalizedPreconditions);
      const initialFailure = await validate();
      if (initialFailure) {
        return { status: "precondition-failed", reason: initialFailure };
      }
      const bytes = Buffer.from(content, "utf8");
      const result = await this.performWrite(normalized, bytes, expectedRevision, false, validate);
      if (result.status === "precondition-failed") return result;
      if (result.status === "committed") {
        return {
          status: "committed",
          path: normalized,
          revision: result.revision,
          transactionId: result.transactionId,
        };
      }
      return {
        status: "conflict",
        path: normalized,
        currentRevision: result.currentRevision,
        conflictPath: result.conflictPath,
        transactionId: result.transactionId,
      };
    });
  }

  async writeBinary(
    relativePath: string,
    content: Uint8Array,
    expectedRevision: string | null,
  ): Promise<WriteResult> {
    this.assertWritable();
    assertExpectedRevision(expectedRevision);
    return this.withMutation(async () => {
      const normalized = normalizeVaultPath(relativePath);
      const result = await this.performWrite(normalized, Buffer.from(content), expectedRevision);

      if (result.status === "committed") {
        return {
          status: "committed",
          path: normalized,
          revision: result.revision,
          transactionId: result.transactionId,
        };
      }
      return {
        status: "conflict",
        path: normalized,
        currentRevision: result.currentRevision,
        conflictPath: result.conflictPath,
        transactionId: result.transactionId,
      };
    });
  }

  async createBinary(relativePath: string, content: Uint8Array): Promise<CreateResult> {
    this.assertWritable();
    return this.withMutation(async () => {
      const normalized = normalizeVaultPath(relativePath);
      const targetAbsolute = await this.paths.resolveForWrite(normalized, true);
      const existing = await readStableFile(targetAbsolute);
      if (existing) {
        return {
          status: "exists",
          path: normalized,
          currentRevision: existing.revision,
        };
      }
      const result = await this.performWrite(normalized, Buffer.from(content), null);
      if (result.status === "committed") {
        return {
          status: "committed",
          path: normalized,
          revision: result.revision,
          transactionId: result.transactionId,
        };
      }
      return {
        status: "conflict",
        path: normalized,
        currentRevision: result.currentRevision,
        conflictPath: result.conflictPath,
        transactionId: result.transactionId,
      };
    });
  }

  async createDirectory(relativeDirectory: string): Promise<VaultDirectoryCreateResult> {
    this.assertWritable();
    return this.withMutation(() => this.paths.createDirectory(relativeDirectory));
  }

  async renameFile(
    sourcePath: string,
    targetPath: string,
    expectedSourceRevision: string,
    expectedMarkdownCorpus?: VaultMarkdownCorpus,
    options: { strictContainment?: boolean } = {},
  ): Promise<RenameResult> {
    this.assertWritable();
    assertExpectedRevision(expectedSourceRevision);
    return this.withMutation(() =>
      this.performRename(
        sourcePath,
        targetPath,
        expectedSourceRevision,
        expectedMarkdownCorpus,
        options.strictContainment === true,
      ),
    );
  }

  async writeMany(requests: readonly MultiWriteRequest[]): Promise<MultiWriteResult> {
    this.assertWritable();
    if (requests.length === 0) {
      throw new Error("A multi-write transaction requires at least one file.");
    }
    return this.withMutation(() => this.performMultiWrite(requests));
  }

  async moveWithWrites(request: MoveWithWritesRequest): Promise<MoveWithWritesResult> {
    this.assertWritable();
    assertExpectedRevision(request.expectedSourceRevision);
    if (request.writes.length === 0) {
      throw new Error("A compound move requires at least one rewritten file.");
    }
    return this.withMutation(() => this.performMoveWithWrites(request));
  }

  private async performRename(
    sourcePath: string,
    targetPath: string,
    expectedSourceRevision: string,
    expectedMarkdownCorpus?: VaultMarkdownCorpus,
    strictContainment = false,
  ): Promise<RenameResult> {
    const source = normalizeVaultPath(sourcePath);
    const target = normalizeVaultPath(targetPath);
    if (source === target) {
      return { status: "committed", from: source, to: target, transactionId: "no-op" };
    }

    if (expectedMarkdownCorpus) {
      const verification = await this.verifyMarkdownCorpus(expectedMarkdownCorpus);
      if (!verification.ok) {
        return {
          status: "conflict",
          from: source,
          to: target,
          reason: "markdown-corpus-changed",
          conflictPaths: verification.conflictPaths,
        };
      }
    }

    const sourceAbsolute = await this.paths.resolveForWrite(source);
    let targetAbsolute: string;
    if (strictContainment) {
      const targetCheck = await this.checkStrictAttachmentTarget(target);
      if (targetCheck.status !== "ready") {
        return { status: "conflict", from: source, to: target, reason: targetCheck.status };
      }
      targetAbsolute = targetCheck.targetAbsolute;
    } else {
      targetAbsolute = await this.paths.resolveForWrite(target, true);
    }
    const [sourceSnapshot, targetSnapshot] = await Promise.all([
      this.readMutationFile(sourceAbsolute, strictContainment),
      this.readMutationFile(targetAbsolute, strictContainment),
    ]);

    if (!sourceSnapshot || sourceSnapshot.revision !== expectedSourceRevision) {
      return { status: "conflict", from: source, to: target, reason: "source-revision-changed" };
    }
    if (targetSnapshot) {
      return { status: "conflict", from: source, to: target, reason: "target-exists" };
    }

    const id = randomUUID();
    const blobDirectory = this.getTransactionBlobDirectory(id);
    await fs.mkdir(blobDirectory);
    await syncDirectory(this.transactionDirectory);
    const journal: RenameJournal = {
      version: 1,
      id,
      vaultId: this.vaultId,
      kind: "rename",
      phase: "intent",
      sourcePath: source,
      targetPath: target,
      expectedRevision: expectedSourceRevision,
      expectedMarkdownCorpus: expectedMarkdownCorpus ?? null,
      ...(strictContainment ? { strictContainment: true } : {}),
      ...(strictContainment ? { sourceRetained: true } : {}),
      createdAt: this.clock().toISOString(),
    };
    await this.writeJournal(journal);
    await this.inject("rename:after-intent");

    // Revalidate the no-follow paths after the durable intent. The initial
    // receipt only protects preparation; a replaced parent or source must
    // never be followed by a later transaction phase.
    await this.paths.resolveForWrite(source);
    await this.paths.resolveForWrite(target);
    const finalSource = await this.readMutationFile(sourceAbsolute, strictContainment);
    const finalTarget = await this.readMutationFile(targetAbsolute, strictContainment);
    if (!finalSource || finalSource.revision !== expectedSourceRevision) {
      await this.archiveJournal(journal, "manual-conflict");
      return { status: "conflict", from: source, to: target, reason: "source-revision-changed" };
    }
    if (finalTarget) {
      await this.archiveJournal(journal, "manual-conflict");
      return { status: "conflict", from: source, to: target, reason: "target-created" };
    }

    // Recheck after the journal and final source/destination reads. The
    // earlier receipt protects preparation; this is the last corpus gate
    // before durable source bytes are staged.
    if (expectedMarkdownCorpus) {
      const verification = await this.verifyMarkdownCorpus(expectedMarkdownCorpus);
      if (!verification.ok) {
        await this.archiveJournal(journal, "manual-conflict");
        return {
          status: "conflict",
          from: source,
          to: target,
          reason: "markdown-corpus-changed",
          conflictPaths: verification.conflictPaths,
        };
      }
    }

    const stagedPath = this.getRenameBlobPath(id);
    await this.createMutationFile(stagedPath, finalSource.bytes, strictContainment);
    await this.createMutationFile(this.getRecoveryPath(id), finalSource.bytes, strictContainment);
    journal.phase = "staged";
    await this.writeJournal(journal);
    await this.inject("rename:after-stage");

    // Stage first, then revalidate both names before installing the
    // independently materialized destination. A destination race is a
    // conflict, not an overwrite.
    await this.paths.resolveForWrite(source);
    await this.paths.resolveForWrite(target);
    const stagedSource = await this.readMutationFile(sourceAbsolute, strictContainment);
    const stagedTarget = await this.readMutationFile(targetAbsolute, strictContainment);
    if (!stagedSource || stagedSource.revision !== expectedSourceRevision) {
      await this.archiveJournal(journal, "manual-conflict");
      return {
        status: "conflict",
        from: source,
        to: target,
        reason: "source-changed-during-rename",
      };
    }
    if (stagedTarget) {
      await this.archiveJournal(journal, "manual-conflict");
      return { status: "conflict", from: source, to: target, reason: "target-created" };
    }

    await this.inject("rename:before-install");
    if (strictContainment) {
      await this.inject("rename:before-publish");
      const targetCheck = await this.checkStrictAttachmentTarget(target);
      if (targetCheck.status !== "ready") {
        await this.archiveJournal(journal, "manual-conflict");
        return { status: "conflict", from: source, to: target, reason: targetCheck.status };
      }
      targetAbsolute = targetCheck.targetAbsolute;
    }
    let installed: boolean;
    try {
      installed = await this.installPreparedFile(stagedPath, targetAbsolute, strictContainment);
    } catch (error) {
      if (strictContainment && error instanceof AttachmentPublishCapabilityError) {
        // A final native publication failure happens after durable intent and
        // source evidence exist. Preserve that private state for manual
        // recovery and report the same typed conflict as target preflight;
        // Markdown has not been touched on this direct publication path.
        await this.archiveJournal(journal, "manual-conflict");
        return {
          status: "conflict",
          from: source,
          to: target,
          reason: "attachment-publish-unavailable",
        };
      }
      throw error;
    }
    if (!installed) {
      await this.archiveJournal(journal, "manual-conflict");
      return { status: "conflict", from: source, to: target, reason: "target-created" };
    }
    await this.inject("rename:after-install");

    const [linkedSource, linkedTarget] = await Promise.all([
      this.readMutationFile(sourceAbsolute, strictContainment),
      this.readMutationFile(targetAbsolute, strictContainment),
    ]);
    if (
      !linkedSource ||
      !linkedTarget ||
      linkedSource.revision !== expectedSourceRevision ||
      linkedTarget.revision !== expectedSourceRevision
    ) {
      await this.archiveJournal(journal, "manual-conflict");
      return {
        status: "conflict",
        from: source,
        to: target,
        reason: "source-changed-during-rename",
      };
    }

    journal.phase = "linked";
    await this.writeJournal(journal);
    await this.inject("rename:after-link");

    if (strictContainment) {
      const targetCheck = await this.checkStrictAttachmentTarget(target);
      if (targetCheck.status !== "ready") {
        await this.archiveJournal(journal, "manual-conflict");
        return { status: "conflict", from: source, to: target, reason: targetCheck.status };
      }
      targetAbsolute = targetCheck.targetAbsolute;
      // Attachment publication is deliberately not a rename: the source is
      // user-owned evidence and remains at its original name. Both names are
      // independently verified before the durable terminal record is written.
      if (expectedMarkdownCorpus) {
        const verification = await this.verifyMarkdownCorpus(expectedMarkdownCorpus);
        if (!verification.ok) {
          await this.archiveJournal(journal, "manual-conflict");
          return {
            status: "conflict",
            from: source,
            to: target,
            reason: "markdown-corpus-changed",
            conflictPaths: verification.conflictPaths,
          };
        }
      }
      // Keep the old observable barriers as source-snapshot checks for
      // callers that already use them. They no longer authorize deletion:
      // either barrier can only turn publication into a conflict.
      await this.inject("rename:after-source-check");
      await this.inject("rename:after-source-claim");
      // The publication receipt must precede the historical after-publish
      // barrier. If that barrier crashes, recovery can distinguish our
      // verified target from an exact-byte external claimant; the final
      // source/target read below still converts any post-receipt mutation
      // into a manual conflict.
      journal.phase = "published";
      await this.writeJournal(journal);
      await this.inject("rename:after-publish");
      const finalTargetCheck = await this.checkStrictAttachmentTarget(target);
      if (finalTargetCheck.status !== "ready") {
        await this.archiveJournal(journal, "manual-conflict");
        return { status: "conflict", from: source, to: target, reason: finalTargetCheck.status };
      }
      targetAbsolute = finalTargetCheck.targetAbsolute;
      const retainedSource = await this.readMutationFile(sourceAbsolute, true);
      const publishedTarget = await this.readMutationFile(targetAbsolute, true);
      if (
        !retainedSource ||
        retainedSource.revision !== expectedSourceRevision ||
        !publishedTarget ||
        publishedTarget.revision !== expectedSourceRevision
      ) {
        await this.archiveJournal(journal, "manual-conflict");
        return {
          status: "conflict",
          from: source,
          to: target,
          reason: "source-changed-during-publish",
        };
      }
      journal.phase = "committed";
      await this.writeJournal(journal);
      await this.inject("rename:after-commit");
      await this.archiveJournal(journal, "published-source-retained");
      return {
        status: "published-source-retained",
        from: source,
        to: target,
        transactionId: journal.id,
      };
    }

    // Keep both independent copies until every receipt is clean. If a
    // concurrent editor changes either name, leave both versions and report a
    // conflict rather than deleting a winner.
    if (expectedMarkdownCorpus) {
      const verification = await this.verifyMarkdownCorpus(expectedMarkdownCorpus);
      if (!verification.ok) {
        await this.removeExpectedFile(targetAbsolute, expectedSourceRevision, {
          strictContainment,
        });
        await this.archiveJournal(journal, "manual-conflict");
        return {
          status: "conflict",
          from: source,
          to: target,
          reason: "markdown-corpus-changed",
          conflictPaths: verification.conflictPaths,
        };
      }
    }

    await this.inject("rename:before-source-remove");
    await this.paths.resolveForWrite(source);
    await this.paths.resolveForWrite(target);
    const beforeSourceRemoval = await this.readMutationFile(sourceAbsolute, strictContainment);
    const beforeSourceRemovalTarget = await this.readMutationFile(
      targetAbsolute,
      strictContainment,
    );
    if (
      !beforeSourceRemoval ||
      beforeSourceRemoval.revision !== expectedSourceRevision ||
      !beforeSourceRemovalTarget ||
      beforeSourceRemovalTarget.revision !== expectedSourceRevision
    ) {
      await this.archiveJournal(journal, "manual-conflict");
      return {
        status: "conflict",
        from: source,
        to: target,
        reason: "source-changed-during-rename",
      };
    }
    if (
      !(await this.removeExpectedFile(sourceAbsolute, expectedSourceRevision, {
        strictContainment,
        afterValidation: async () => {
          await this.inject("rename:after-source-check");
        },
        afterClaim: async () => {
          await this.inject("rename:after-source-claim");
        },
      }))
    ) {
      await this.archiveJournal(journal, "manual-conflict");
      return {
        status: "conflict",
        from: source,
        to: target,
        reason: "source-changed-during-rename",
      };
    }
    const sourceAfterRemoval = await this.readMutationFile(sourceAbsolute, strictContainment);
    if (sourceAfterRemoval) {
      // A concurrent creator won the old name. Keep both names and surface a
      // manual conflict rather than deleting or repointing that winner.
      await this.archiveJournal(journal, "manual-conflict");
      return {
        status: "conflict",
        from: source,
        to: target,
        reason: "source-created-during-rename",
      };
    }
    const targetAfterRemoval = await this.readMutationFile(targetAbsolute, strictContainment);
    if (!targetAfterRemoval || targetAfterRemoval.revision !== expectedSourceRevision) {
      const evidence = await this.readMutationFile(this.getRecoveryPath(id), strictContainment);
      if (!evidence || evidence.revision !== expectedSourceRevision) {
        await this.archiveJournal(journal, "manual-conflict");
        return {
          status: "conflict",
          from: source,
          to: target,
          reason: "target-changed-during-rename",
        };
      }
      if (
        !(await this.installPreparedFile(
          this.getRecoveryPath(id),
          sourceAbsolute,
          strictContainment,
        ))
      ) {
        await this.archiveJournal(journal, "manual-conflict");
        return {
          status: "conflict",
          from: source,
          to: target,
          reason: "target-changed-during-rename",
        };
      }
      await this.archiveJournal(journal, "manual-conflict");
      return {
        status: "conflict",
        from: source,
        to: target,
        reason: "target-changed-during-rename",
      };
    }
    journal.phase = "committed";
    await this.writeJournal(journal);
    await this.inject("rename:after-commit");
    await this.archiveJournal(journal, "committed");
    return { status: "committed", from: source, to: target, transactionId: journal.id };
  }

  async recover(): Promise<RecoveryAction[]> {
    this.assertWritable();
    return this.withMutation(() => this.recoverUnlocked());
  }

  private async recoverUnlocked(): Promise<RecoveryAction[]> {
    const actions: RecoveryAction[] = [];
    const entries = (await fs.readdir(this.journalDirectory)).filter((entry) =>
      entry.endsWith(".json"),
    );
    entries.sort();

    const journals: TransactionJournal[] = [];
    for (const entry of entries) {
      try {
        const match = /^([a-f0-9-]+)\.json$/i.exec(entry);
        if (!match?.[1]) {
          throw new Error("Journal filename is invalid.");
        }
        const journalPath = path.join(this.journalDirectory, entry);
        const parsed: unknown = JSON.parse(await fs.readFile(journalPath, "utf8"));
        journals.push(parseTransactionJournal(parsed, this.vaultId, match[1]));
      } catch (error) {
        throw new VaultRecoveryError(entry, error);
      }
    }

    const recoveryPriority: Record<TransactionJournal["kind"], number> = {
      write: 0,
      rename: 1,
      "multi-write": 2,
      "move-with-writes": 3,
    };
    journals.sort(
      (left, right) =>
        recoveryPriority[left.kind] - recoveryPriority[right.kind] ||
        left.id.localeCompare(right.id),
    );

    const preparedMultiWriteBlobs = new Map<string, Map<number, Buffer>>();
    const preparedMoveWithWritesBlobs = new Map<string, Map<number, MoveWithWritesBlobs>>();
    for (const journal of journals) {
      try {
        if (journal.kind === "multi-write") {
          preparedMultiWriteBlobs.set(journal.id, await this.loadPendingMultiWriteBlobs(journal));
        } else if (journal.kind === "move-with-writes") {
          preparedMoveWithWritesBlobs.set(journal.id, await this.loadMoveWithWritesBlobs(journal));
        }
      } catch (error) {
        throw new VaultRecoveryError(`${journal.id}.json`, error);
      }
    }

    for (const journal of journals) {
      try {
        if (journal.kind === "write") {
          actions.push(await this.recoverWrite(journal));
        } else if (journal.kind === "rename") {
          actions.push(await this.recoverRename(journal));
        } else if (journal.kind === "multi-write") {
          actions.push(
            await this.recoverMultiWrite(
              journal,
              preparedMultiWriteBlobs.get(journal.id) ?? new Map(),
            ),
          );
        } else {
          actions.push(
            await this.recoverMoveWithWrites(
              journal,
              preparedMoveWithWritesBlobs.get(journal.id) ?? new Map(),
            ),
          );
        }
      } catch (error) {
        throw new VaultRecoveryError(`${journal.id}.json`, error);
      }
    }
    return actions;
  }

  private async initializeState(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.journalDirectory, { recursive: true }),
      fs.mkdir(this.historyDirectory, { recursive: true }),
      fs.mkdir(this.recoveryDirectory, { recursive: true }),
      fs.mkdir(this.rollbackClaimsDirectory, { recursive: true }),
      fs.mkdir(this.transactionDirectory, { recursive: true }),
    ]);
    await this.cleanupTerminalRollbackClaims();
    const identityPath = path.join(this.stateRoot, "vault.json");
    const identity = {
      version: 1,
      vaultId: this.vaultId,
      canonicalPath: this.paths.rootPath,
    } as const;
    try {
      await durableCreate(identityPath, encodeJson(identity));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
      const stat = await fs.lstat(identityPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("Vault state identity is not a regular file.");
      }
      const existing: unknown = JSON.parse(await fs.readFile(identityPath, "utf8"));
      if (
        typeof existing !== "object" ||
        existing === null ||
        Array.isArray(existing) ||
        Object.keys(existing).sort().join(",") !== "canonicalPath,vaultId,version" ||
        !("version" in existing) ||
        existing.version !== identity.version ||
        !("vaultId" in existing) ||
        existing.vaultId !== identity.vaultId ||
        !("canonicalPath" in existing) ||
        existing.canonicalPath !== identity.canonicalPath
      ) {
        throw new Error("Vault state identity does not match this vault.");
      }
    }
  }

  /**
   * Rollback claims are private evidence only while their transaction is
   * live. A terminal committed history receipt permits bounded cleanup of
   * that app-owned directory; an absent or malformed receipt leaves it for
   * recovery instead of guessing ownership from a pathname.
   */
  private async cleanupTerminalRollbackClaims(): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(this.rollbackClaimsDirectory, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const historyPath = path.join(this.historyDirectory, `${entry.name}.json`);
      const journalPath = path.join(this.journalDirectory, `${entry.name}.json`);
      try {
        await fs.lstat(journalPath);
        continue;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) continue;
      }
      let history: unknown;
      try {
        history = JSON.parse(await fs.readFile(historyPath, "utf8"));
      } catch {
        continue;
      }
      if (
        typeof history !== "object" ||
        history === null ||
        Array.isArray(history) ||
        !("outcome" in history) ||
        history.outcome !== "committed"
      ) {
        continue;
      }
      await fs.rm(path.join(this.rollbackClaimsDirectory, entry.name), {
        recursive: true,
        force: true,
      });
      await syncDirectory(this.rollbackClaimsDirectory).catch(() => undefined);
    }
  }

  private async performMoveWithWrites(
    request: MoveWithWritesRequest,
  ): Promise<MoveWithWritesResult> {
    const sourcePath = normalizeVaultPath(request.sourcePath);
    const targetPath = normalizeVaultPath(request.targetPath);
    if (sourcePath === targetPath) {
      throw new Error("A compound move requires different source and destination paths.");
    }

    // This receipt is checked while the kernel's mutation lane is held and
    // before any journal/blob is created. A note created after application
    // preview but immediately before this call therefore conflicts instead of
    // permitting an attachment-only or partial move.
    if (request.expectedMarkdownCorpus) {
      const verification = await this.verifyMarkdownCorpus(request.expectedMarkdownCorpus);
      if (!verification.ok) {
        return {
          status: "conflict",
          from: sourcePath,
          to: targetPath,
          reason: "markdown-corpus-changed",
          conflictPaths: verification.conflictPaths,
        };
      }
    }

    const seenPaths = new Set<string>();
    const prepared = request.writes.map((write) => {
      const target = normalizeVaultPath(write.path);
      if (target === targetPath) {
        throw new Error("A compound move cannot rewrite its unoccupied destination path.");
      }
      if (seenPaths.has(target)) {
        throw new Error(`A compound move cannot rewrite a path twice: ${target}`);
      }
      if (write.expectedRevision === null) {
        throw new Error("A compound move can rewrite only existing revision-bound files.");
      }
      assertExpectedRevision(write.expectedRevision);
      seenPaths.add(target);
      return {
        targetPath: target,
        expectedRevision: write.expectedRevision,
        nextBytes: Buffer.from(write.content, "utf8"),
      };
    });

    let expectedMarkdownCorpusAfterWrites: VaultMarkdownCorpus | null = null;
    if (request.expectedMarkdownCorpus) {
      const expectedRevisions = new Map(
        request.expectedMarkdownCorpus.revisions.map((entry) => [entry.path, entry.revision]),
      );
      for (const item of prepared) {
        if (!expectedRevisions.has(item.targetPath)) {
          return {
            status: "conflict",
            from: sourcePath,
            to: targetPath,
            reason: "markdown-corpus-changed",
            conflictPaths: [item.targetPath],
          };
        }
        expectedRevisions.set(item.targetPath, revisionOf(item.nextBytes));
      }
      const revisions = request.expectedMarkdownCorpus.revisions.map((entry) => ({
        path: entry.path,
        revision: expectedRevisions.get(entry.path) ?? entry.revision,
      }));
      expectedMarkdownCorpusAfterWrites = {
        paths: [...request.expectedMarkdownCorpus.paths],
        revisions,
        generation: markdownCorpusGeneration(request.expectedMarkdownCorpus.paths, revisions),
        ...(request.expectedMarkdownCorpus.scope
          ? { scope: request.expectedMarkdownCorpus.scope }
          : {}),
      };
    }

    const sourceAbsolute = await this.paths.resolveForWrite(sourcePath);
    let targetAbsolute: string;
    if (request.strictContainment === true) {
      const targetCheck = await this.checkStrictAttachmentTarget(targetPath);
      if (targetCheck.status !== "ready") {
        return {
          status: "conflict",
          from: sourcePath,
          to: targetPath,
          reason: targetCheck.status,
          conflictPaths: [],
        };
      }
      targetAbsolute = targetCheck.targetAbsolute;
      try {
        await assertContainedPublishCapability(
          this.attachmentPublishCapability,
          this.rollbackClaimsDirectory,
        );
        for (const item of prepared) {
          const writeAbsolute = await this.paths.resolveForWrite(item.targetPath);
          await assertContainedPublishCapability(
            this.attachmentPublishCapability,
            path.dirname(writeAbsolute),
          );
        }
      } catch {
        return {
          status: "conflict",
          from: sourcePath,
          to: targetPath,
          reason: "attachment-publish-unavailable",
          conflictPaths: [],
        };
      }
    } else {
      targetAbsolute = await this.paths.resolveForWrite(targetPath, true);
    }
    const [source, target] = await Promise.all([
      this.readMutationFile(sourceAbsolute, request.strictContainment === true),
      this.readMutationFile(targetAbsolute, request.strictContainment === true),
    ]);
    if (!source || source.revision !== request.expectedSourceRevision) {
      return {
        status: "conflict",
        from: sourcePath,
        to: targetPath,
        reason: "source-revision-changed",
        conflictPaths: [],
      };
    }
    if (target) {
      return {
        status: "conflict",
        from: sourcePath,
        to: targetPath,
        reason: "target-exists",
        conflictPaths: [],
      };
    }

    const currentByPath = new Map<string, FileSnapshot>();
    for (const item of prepared) {
      const absolutePath = await this.paths.resolveForWrite(
        item.targetPath,
        request.strictContainment !== true,
      );
      const current = await this.readMutationFile(absolutePath, request.strictContainment === true);
      if (!current || current.revision !== item.expectedRevision) {
        return {
          status: "conflict",
          from: sourcePath,
          to: targetPath,
          reason: `write-revision-changed:${item.targetPath}`,
          conflictPaths: [],
        };
      }
      currentByPath.set(item.targetPath, current);
    }
    const sourceWrite = prepared.find((item) => item.targetPath === sourcePath);
    if (sourceWrite && sourceWrite.expectedRevision !== request.expectedSourceRevision) {
      throw new Error("The source rewrite revision must match the compound move revision.");
    }

    const id = randomUUID();
    const blobDirectory = this.getTransactionBlobDirectory(id);
    await fs.mkdir(blobDirectory);
    await syncDirectory(this.transactionDirectory);
    try {
      for (let index = 0; index < prepared.length; index += 1) {
        const item = prepared[index];
        if (!item) {
          continue;
        }
        const current = currentByPath.get(item.targetPath);
        if (!current) {
          throw new Error(`Compound move lost prepared bytes for ${item.targetPath}.`);
        }
        await this.createMutationFile(
          this.getTransactionBlobPath(id, index, "before"),
          current.bytes,
          request.strictContainment === true,
        );
        await this.createMutationFile(
          this.getTransactionBlobPath(id, index, "next"),
          item.nextBytes,
          request.strictContainment === true,
        );
      }
      if (request.strictContainment) {
        // Attachment publication has its own exact source evidence. The
        // private blob is durable before the journal can ask the vault to
        // create the destination, so a crash never turns a source read into
        // an unaccounted copy.
        await this.createMutationFile(this.getRenameBlobPath(id), source.bytes, true);
        await this.createMutationFile(this.getRecoveryPath(id), source.bytes, true);
      }
    } catch (error) {
      await fs.rm(blobDirectory, { recursive: true, force: true });
      await syncDirectory(this.transactionDirectory);
      throw error;
    }

    const journal: MoveWithWritesJournal = {
      version: 1,
      id,
      vaultId: this.vaultId,
      kind: "move-with-writes",
      phase: request.strictContainment ? "publishing" : "intent",
      sourcePath,
      targetPath,
      expectedSourceRevision: request.expectedSourceRevision,
      renameRevision: sourceWrite
        ? revisionOf(sourceWrite.nextBytes)
        : request.expectedSourceRevision,
      reason: null,
      expectedMarkdownCorpusBeforeWrites: request.expectedMarkdownCorpus ?? null,
      expectedMarkdownCorpus: expectedMarkdownCorpusAfterWrites,
      ...(request.strictContainment ? { strictContainment: true } : {}),
      ...(request.strictContainment ? { sourceRetained: true } : {}),
      createdAt: this.clock().toISOString(),
      entries: prepared.map((item) => ({
        targetPath: item.targetPath,
        beforeRevision: item.expectedRevision,
        nextRevision: revisionOf(item.nextBytes),
        status: "pending",
        currentRevision: null,
        conflictPath: null,
      })),
    };
    await this.writeJournal(journal);
    await this.inject("move-with-writes:after-intent");
    return this.continueMoveWithWrites(journal, await this.loadMoveWithWritesBlobs(journal));
  }

  private async continueMoveWithWrites(
    journal: MoveWithWritesJournal,
    blobs: Map<number, MoveWithWritesBlobs>,
  ): Promise<MoveWithWritesResult> {
    if (journal.phase === "committed") {
      if (journal.sourceRetained === true) {
        const published = await this.ensurePublishedAttachment(journal);
        if (!published) {
          return this.archivePublishedAttachmentConflict(
            journal,
            journal.reason ?? "publish-state-diverged",
          );
        }
      }
      const result = this.committedMoveWithWritesResult(journal);
      await this.archiveJournal(
        journal,
        journal.sourceRetained === true ? "published-source-retained" : "committed",
      );
      return result;
    }
    if (journal.phase === "rolling-back") {
      return this.rollbackMoveWithWrites(journal, blobs);
    }
    if (journal.phase === "renaming") {
      const resumed = await this.resumeMoveWithWritesRename(journal, blobs);
      if (resumed) {
        return resumed;
      }
    }

    if (journal.sourceRetained === true) {
      const published = await this.ensurePublishedAttachment(journal);
      if (!published) {
        return this.archivePublishedAttachmentConflict(
          journal,
          journal.reason ?? "publish-state-diverged",
        );
      }
    }

    journal.phase = "applying";
    await this.writeJournal(journal);
    const allEntriesPending = journal.entries.every((entry) => entry.status === "pending");
    let checkedCorpusBeforeFirstWrite = false;
    for (let index = 0; index < journal.entries.length; index += 1) {
      const entry = journal.entries[index];
      const entryBlobs = blobs.get(index);
      if (!entry || !entryBlobs) {
        throw new Error(`Missing compound move entry ${index}.`);
      }
      if (entry.status === "conflict") {
        return this.beginMoveWithWritesRollback(
          journal,
          blobs,
          journal.reason ?? `write-conflict:${entry.targetPath}`,
        );
      }
      if (entry.status === "rolled-back") {
        return this.beginMoveWithWritesRollback(
          journal,
          blobs,
          journal.reason ?? `write-diverged:${entry.targetPath}`,
        );
      }

      const current = await this.readMoveWithWritesTarget(
        entry.targetPath,
        journal.strictContainment === true,
      );
      if (entry.status === "applied") {
        if (current?.revision !== entry.nextRevision) {
          await this.recordMoveWithWritesConflict(
            journal,
            entry,
            entryBlobs.next,
            entry.nextRevision,
            `write-diverged:${entry.targetPath}`,
          );
          await this.writeJournal(journal);
          return this.beginMoveWithWritesRollback(
            journal,
            blobs,
            journal.reason ?? `write-diverged:${entry.targetPath}`,
          );
        }
        continue;
      }

      if (current?.revision === entry.nextRevision) {
        entry.status = "applied";
        entry.currentRevision = entry.nextRevision;
      } else {
        // The entry receipt may have aged while blobs and the intent journal
        // were staged. For a fresh transaction, take the authoritative corpus
        // receipt at the first child-write boundary, before any canonical note
        // can be changed. Once an entry is already applied, the after-write
        // receipt below is the relevant recovery boundary.
        if (allEntriesPending && !checkedCorpusBeforeFirstWrite) {
          checkedCorpusBeforeFirstWrite = true;
          if (journal.expectedMarkdownCorpusBeforeWrites) {
            const verification = await this.verifyMarkdownCorpus(
              journal.expectedMarkdownCorpusBeforeWrites,
            );
            if (!verification.ok) {
              return this.beginMoveWithWritesRollback(
                journal,
                blobs,
                "markdown-corpus-changed-before-writes",
              );
            }
            await this.inject("move-with-writes:after-corpus-preflight");
          }
        }
        const result = await this.performWrite(
          entry.targetPath,
          entryBlobs.next,
          entry.beforeRevision,
          journal.strictContainment === true,
        );
        if (result.status === "committed") {
          entry.status = "applied";
          entry.currentRevision = result.revision;
        } else {
          entry.status = "conflict";
          entry.currentRevision = result.currentRevision;
          entry.conflictPath = result.conflictPath;
          journal.reason = `write-conflict:${entry.targetPath}`;
        }
      }
      await this.writeJournal(journal);
      await this.inject("move-with-writes:after-entry");
      if (entry.status === "conflict") {
        return this.beginMoveWithWritesRollback(
          journal,
          blobs,
          journal.reason ?? `write-conflict:${entry.targetPath}`,
        );
      }
    }

    for (let index = 0; index < journal.entries.length; index += 1) {
      const entry = journal.entries[index];
      const entryBlobs = blobs.get(index);
      if (!entry || !entryBlobs) {
        throw new Error(`Missing compound move verification entry ${index}.`);
      }
      const current = await this.readMoveWithWritesTarget(
        entry.targetPath,
        journal.strictContainment === true,
      );
      if (current?.revision === entry.nextRevision) {
        continue;
      }
      await this.recordMoveWithWritesConflict(
        journal,
        entry,
        entryBlobs.next,
        entry.nextRevision,
        `write-diverged:${entry.targetPath}`,
      );
      await this.writeJournal(journal);
      return this.beginMoveWithWritesRollback(
        journal,
        blobs,
        journal.reason ?? `write-diverged:${entry.targetPath}`,
      );
    }

    if (journal.expectedMarkdownCorpus) {
      const verification = await this.verifyMarkdownCorpus(journal.expectedMarkdownCorpus);
      if (!verification.ok) {
        return this.beginMoveWithWritesRollback(journal, blobs, "markdown-corpus-changed");
      }
    }

    if (journal.sourceRetained === true) {
      // Retain the historical boundary as the final pre-commit claimant
      // control. It must run before the last source/target receipt, otherwise
      // a target claimant injected at this point could be mistaken for a
      // successful publication.
      await this.inject("move-with-writes:before-rename");
      const sourceAbsolute = await this.paths.resolveForWrite(journal.sourcePath);
      const targetCheck = await this.checkStrictAttachmentTarget(journal.targetPath);
      if (targetCheck.status !== "ready") {
        return this.beginMoveWithWritesRollback(journal, blobs, targetCheck.status);
      }
      const targetAbsolute = targetCheck.targetAbsolute;
      const [source, target] = await Promise.all([
        this.readMutationFile(sourceAbsolute, true),
        this.readMutationFile(targetAbsolute, true),
      ]);
      if (
        !source ||
        source.revision !== journal.expectedSourceRevision ||
        !target ||
        target.revision !== journal.expectedSourceRevision
      ) {
        return this.beginMoveWithWritesRollback(journal, blobs, "source-changed-during-publish");
      }
      await this.inject("rename:after-commit");
      // Keep the historical post-rename interruption point meaningful for
      // callers and crash tests. Publication already happened; a failure here
      // leaves the journal and both attachment names for recovery, while the
      // Markdown writes remain receipt-bound.
      await this.inject("move-with-writes:after-rename");
      return this.commitMoveWithWrites(journal);
    }

    journal.phase = "renaming";
    journal.reason = null;
    await this.writeJournal(journal);
    await this.inject("move-with-writes:before-rename");
    const rename = await this.performRename(
      journal.sourcePath,
      journal.targetPath,
      journal.renameRevision,
      journal.expectedMarkdownCorpus ?? undefined,
      journal.strictContainment === true,
    );
    if (rename.status === "conflict") {
      return this.beginMoveWithWritesRollback(journal, blobs, `rename-${rename.reason}`);
    }
    await this.inject("move-with-writes:after-rename");
    return this.commitMoveWithWrites(journal);
  }

  /**
   * Publish the exact attachment snapshot before any Markdown rewrite. The
   * source name is intentionally never retired. A target winner, changed
   * source, missing evidence blob, or containment error is a manual conflict;
   * recovery leaves every externally visible byte in place.
   */
  private async ensurePublishedAttachment(journal: MoveWithWritesJournal): Promise<boolean> {
    let sourceAbsolute: string;
    try {
      sourceAbsolute = await this.paths.resolveForWrite(journal.sourcePath);
    } catch {
      return false;
    }
    let targetCheck = await this.checkStrictAttachmentTarget(journal.targetPath);
    if (targetCheck.status !== "ready") {
      journal.reason = targetCheck.status;
      return false;
    }
    let targetAbsolute = targetCheck.targetAbsolute;

    const source = await this.readMutationFile(sourceAbsolute, true);
    if (!source || source.revision !== journal.expectedSourceRevision) return false;
    let target = await this.readMutationFile(targetAbsolute, true);
    if (target && target.revision !== journal.expectedSourceRevision) return false;
    // Before the durable publication receipt, even an exact-byte target may
    // be an external claimant. Do not treat it as our publication or rewrite
    // Markdown on that ambiguous state.
    if (target && journal.phase === "publishing") return false;

    if (!target) {
      // A durable committed receipt is not permission to reconstruct a
      // vanished target. Reopen must verify the exact retained publication,
      // not convert an external deletion into a fresh success.
      if (journal.phase === "committed") return false;
      const stagedPath = this.getRenameBlobPath(journal.id);
      const evidencePath = this.getRecoveryPath(journal.id);
      const staged = await this.readMutationFile(stagedPath, true);
      const evidence = staged ? null : await this.readMutationFile(evidencePath, true);
      const candidate = staged ?? evidence;
      if (!candidate || candidate.revision !== journal.expectedSourceRevision) return false;
      await this.inject("move-with-writes:before-publish");
      targetCheck = await this.checkStrictAttachmentTarget(journal.targetPath);
      if (targetCheck.status !== "ready") {
        journal.reason = targetCheck.status;
        return false;
      }
      targetAbsolute = targetCheck.targetAbsolute;
      let installed: boolean;
      try {
        installed = await this.installPreparedFile(
          staged ? stagedPath : evidencePath,
          targetAbsolute,
          true,
        );
      } catch (error) {
        if (error instanceof AttachmentPublishCapabilityError) {
          journal.reason = "attachment-publish-unavailable";
        }
        return false;
      }
      if (!installed) {
        // A false install includes a post-publication cleanup or verification
        // failure. Even if the target now happens to contain the expected
        // bytes, this invocation did not obtain a clean publication receipt;
        // let recovery/archive surface an explicit conflict instead of
        // rewriting Markdown on an ambiguous stage owner.
        return false;
      }
      target = await this.readMutationFile(targetAbsolute, true);
      const retainedBeforeReceipt = await this.readMutationFile(sourceAbsolute, true);
      if (
        !target ||
        target.revision !== journal.expectedSourceRevision ||
        !retainedBeforeReceipt ||
        retainedBeforeReceipt.revision !== journal.expectedSourceRevision
      ) {
        return false;
      }
      journal.phase = "published";
      await this.writeJournal(journal);
      await this.inject("move-with-writes:after-publish");
      // Keep the historical post-link barrier at the new publication seam.
      // It is still useful for separate-process tests that create a Markdown
      // claimant or crash immediately after the target becomes durable.
      await this.inject("rename:after-link");
    }

    targetCheck = await this.checkStrictAttachmentTarget(journal.targetPath);
    if (targetCheck.status !== "ready") {
      journal.reason = targetCheck.status;
      return false;
    }
    targetAbsolute = targetCheck.targetAbsolute;

    target = await this.readMutationFile(targetAbsolute, true);
    const retained = await this.readMutationFile(sourceAbsolute, true);
    if (
      !target ||
      target.revision !== journal.expectedSourceRevision ||
      !retained ||
      retained.revision !== journal.expectedSourceRevision
    ) {
      return false;
    }
    return true;
  }

  private async archivePublishedAttachmentConflict(
    journal: MoveWithWritesJournal,
    reason: string,
  ): Promise<MoveWithWritesResult> {
    return this.archiveMoveWithWritesManualConflict(journal, reason, [
      journal.sourcePath,
      journal.targetPath,
    ]);
  }

  private async resumeMoveWithWritesRename(
    journal: MoveWithWritesJournal,
    blobs: Map<number, MoveWithWritesBlobs>,
  ): Promise<MoveWithWritesResult | null> {
    let sourceAbsolute: string;
    let targetAbsolute: string;
    try {
      sourceAbsolute = await this.paths.resolveForWrite(journal.sourcePath);
      targetAbsolute = await this.paths.resolveForWrite(
        journal.targetPath,
        journal.strictContainment !== true,
      );
    } catch {
      return this.archiveMoveWithWritesManualConflict(journal, "rename-path-replaced", [
        journal.sourcePath,
        journal.targetPath,
      ]);
    }
    const [source, target] = await Promise.all([
      this.readMutationFile(sourceAbsolute, journal.strictContainment === true),
      this.readMutationFile(targetAbsolute, journal.strictContainment === true),
    ]);
    if (source && source.revision !== journal.renameRevision) {
      // The source path is owned by a different winner. Never roll back
      // Markdown to this path, even when the destination still has the old
      // bytes: that would repoint links at the winner.
      return this.archiveMoveWithWritesManualConflict(journal, "rename-state-diverged", [
        journal.sourcePath,
        ...(target ? [journal.targetPath] : []),
      ]);
    }
    if (!source && target?.revision === journal.renameRevision) {
      if (journal.expectedMarkdownCorpus) {
        const verification = await this.verifyMarkdownCorpus(journal.expectedMarkdownCorpus);
        if (!verification.ok) {
          const restored = await this.restoreRenameSource(
            sourceAbsolute,
            targetAbsolute,
            journal.renameRevision,
            journal.id,
            journal.strictContainment === true,
          );
          if (!restored) {
            return this.archiveMoveWithWritesManualConflict(journal, "rename-state-diverged", [
              journal.sourcePath,
              journal.targetPath,
            ]);
          }
          return this.beginMoveWithWritesRollback(journal, blobs, "markdown-corpus-changed");
        }
      }
      return this.commitMoveWithWrites(journal);
    }
    if (!source) {
      journal.reason = target ? "rename-state-diverged" : "source-missing";
      await this.writeJournal(journal);
      const conflictPaths = journal.entries
        .map((entry) => entry.conflictPath)
        .filter((entry): entry is string => entry !== null);
      await this.archiveJournal(journal, "manual-conflict");
      return {
        status: "conflict",
        from: journal.sourcePath,
        to: journal.targetPath,
        reason: journal.reason,
        conflictPaths,
      };
    }
    if (target) {
      return this.beginMoveWithWritesRollback(journal, blobs, "rename-target-exists");
    }
    return null;
  }

  private async removeExpectedFile(
    absolutePath: string,
    expectedRevision: string,
    options: ExpectedRemovalOptions = {},
  ): Promise<boolean> {
    const removalOptions: ExpectedRemovalOptions = {
      ...options,
      claimAuthority: options.claimAuthority ?? (options.strictContainment ? "vault" : "private"),
      cleanupClaim: options.cleanupClaim ?? !options.strictContainment,
    };
    if (options.strictContainment) {
      return removeExpectedContainedFile(absolutePath, expectedRevision, removalOptions);
    }
    return removeExpectedFilePortably(absolutePath, expectedRevision, removalOptions);
  }

  private async retainStrictWriteClaim(
    journal: WriteJournal,
    absolutePath: string,
    expectedRevision: string,
  ): Promise<boolean> {
    return this.removeExpectedFile(absolutePath, expectedRevision, {
      strictContainment: true,
      retentionDirectory: path.join(this.rollbackClaimsDirectory, journal.id),
      claimAuthority: "private",
      cleanupClaim: false,
    });
  }

  private async installPreparedFile(
    stagedPath: string,
    targetPath: string,
    strictContainment = false,
  ): Promise<boolean> {
    return strictContainment
      ? installContainedStagedFile(stagedPath, targetPath)
      : installStagedFile(stagedPath, targetPath);
  }

  private async readMutationFile(
    filePath: string,
    strictContainment = false,
  ): Promise<FileSnapshot | null> {
    return strictContainment ? readContainedFile(filePath) : readStableFile(filePath);
  }

  private async createMutationFile(
    filePath: string,
    bytes: Uint8Array,
    strictContainment = false,
  ): Promise<void> {
    if (strictContainment) {
      await durableCreateContainedFile(filePath, bytes);
    } else {
      await durableCreate(filePath, bytes);
    }
  }

  private async mutationFileExists(filePath: string, strictContainment = false): Promise<boolean> {
    return strictContainment
      ? (await this.readMutationFile(filePath, true)) !== null
      : pathExists(filePath);
  }

  private async restoreRenameSource(
    sourceAbsolute: string,
    targetAbsolute: string,
    expectedRevision: string,
    transactionId: string,
    strictContainment = false,
  ): Promise<boolean> {
    try {
      await this.inject("rename:before-recovery-restore");
      const [sourceBefore, targetBefore] = await Promise.all([
        this.readMutationFile(sourceAbsolute, strictContainment),
        this.readMutationFile(targetAbsolute, strictContainment),
      ]);
      if (sourceBefore || !targetBefore || targetBefore.revision !== expectedRevision) {
        return false;
      }

      const stagedPath = this.getRenameRestoreBlobPath(transactionId);
      const stagedExisting = await this.readMutationFile(stagedPath, strictContainment);
      if (stagedExisting && stagedExisting.revision !== expectedRevision) {
        return false;
      }
      if (!stagedExisting) {
        await this.createMutationFile(stagedPath, targetBefore.bytes, strictContainment);
      }

      await this.paths.resolveForWrite(
        path.relative(this.paths.rootPath, sourceAbsolute).split(path.sep).join("/"),
      );
      if ((await this.installPreparedFile(stagedPath, sourceAbsolute, strictContainment)) === false)
        return false;
      const restoredSource = await this.readMutationFile(sourceAbsolute, strictContainment);
      if (!restoredSource || restoredSource.revision !== expectedRevision) return false;

      await this.inject("rename:after-recovery-restore-copy");
      const targetAfterCopy = await this.readMutationFile(targetAbsolute, strictContainment);
      if (!targetAfterCopy || targetAfterCopy.revision !== expectedRevision) return false;
      return await this.removeExpectedFile(targetAbsolute, expectedRevision, {
        strictContainment,
      });
    } catch {
      return false;
    }
  }

  private async archiveMoveWithWritesManualConflict(
    journal: MoveWithWritesJournal,
    reason: string,
    conflictPaths: string[],
  ): Promise<MoveWithWritesResult> {
    journal.reason = reason;
    await this.writeJournal(journal);
    await this.archiveJournal(journal, "manual-conflict");
    return {
      status: "conflict",
      from: journal.sourcePath,
      to: journal.targetPath,
      reason,
      conflictPaths: [...new Set(conflictPaths)],
    };
  }

  private async commitMoveWithWrites(
    journal: MoveWithWritesJournal,
  ): Promise<MoveWithWritesResult> {
    journal.phase = "committed";
    journal.reason = null;
    await this.writeJournal(journal);
    await this.inject("move-with-writes:after-commit");
    const result = this.committedMoveWithWritesResult(journal);
    await this.archiveJournal(
      journal,
      journal.sourceRetained === true ? "published-source-retained" : "committed",
    );
    return result;
  }

  private committedMoveWithWritesResult(journal: MoveWithWritesJournal): MoveWithWritesResult {
    return {
      status: journal.sourceRetained === true ? "published-source-retained" : "committed",
      from: journal.sourcePath,
      to: journal.targetPath,
      transactionId: journal.id,
      writes: journal.entries.map((entry) => ({
        path: entry.targetPath,
        revision: entry.nextRevision,
      })),
    };
  }

  private async beginMoveWithWritesRollback(
    journal: MoveWithWritesJournal,
    blobs: Map<number, MoveWithWritesBlobs>,
    reason: string,
  ): Promise<MoveWithWritesResult> {
    journal.phase = "rolling-back";
    journal.reason = reason;
    await this.writeJournal(journal);
    return this.rollbackMoveWithWrites(journal, blobs);
  }

  private async rollbackMoveWithWrites(
    journal: MoveWithWritesJournal,
    blobs: Map<number, MoveWithWritesBlobs>,
  ): Promise<MoveWithWritesResult> {
    for (let index = journal.entries.length - 1; index >= 0; index -= 1) {
      const entry = journal.entries[index];
      const entryBlobs = blobs.get(index);
      if (!entry || !entryBlobs || entry.status === "rolled-back" || entry.status === "conflict") {
        continue;
      }
      const current = await this.readMoveWithWritesTarget(
        entry.targetPath,
        journal.strictContainment === true,
      );
      if (current?.revision === entry.beforeRevision) {
        entry.status = "rolled-back";
        entry.currentRevision = entry.beforeRevision;
      } else {
        const result = await this.performWrite(
          entry.targetPath,
          entryBlobs.before,
          entry.nextRevision,
          journal.strictContainment === true,
        );
        if (result.status === "committed") {
          entry.status = "rolled-back";
          entry.currentRevision = result.revision;
          entry.conflictPath = null;
        } else {
          entry.status = "conflict";
          entry.currentRevision = result.currentRevision;
          entry.conflictPath = result.conflictPath;
          journal.reason = `rollback-conflict:${entry.targetPath}`;
        }
      }
      await this.writeJournal(journal);
      await this.inject("move-with-writes:after-rollback-entry");
    }

    const conflictPaths = journal.entries
      .map((entry) => entry.conflictPath)
      .filter((entry): entry is string => entry !== null);
    const reason = journal.reason ?? "compound-move-conflict";
    const outcome =
      reason.startsWith("rollback-conflict:") || reason === "rename-state-diverged"
        ? "manual-conflict"
        : conflictPaths.length > 0
          ? "conflict-copy"
          : "rolled-back";
    await this.archiveJournal(journal, outcome);
    return {
      status: "conflict",
      from: journal.sourcePath,
      to: journal.targetPath,
      reason,
      conflictPaths,
    };
  }

  private async recordMoveWithWritesConflict(
    journal: MoveWithWritesJournal,
    entry: MoveWithWritesJournalEntry,
    bytes: Buffer,
    expectedRevision: string,
    reason: string,
  ): Promise<void> {
    const result = await this.performWrite(
      entry.targetPath,
      bytes,
      expectedRevision,
      journal.strictContainment === true,
    );
    if (result.status === "committed") {
      entry.status = "applied";
      entry.currentRevision = result.revision;
      entry.conflictPath = null;
      return;
    }
    entry.status = "conflict";
    entry.currentRevision = result.currentRevision;
    entry.conflictPath = result.conflictPath;
    journal.reason = reason;
  }

  private async readMoveWithWritesTarget(
    targetPath: string,
    strictContainment = false,
  ): Promise<FileSnapshot | null> {
    const absolutePath = await this.paths.resolveForWrite(targetPath, !strictContainment);
    return this.readMutationFile(absolutePath, strictContainment);
  }

  private async performMultiWrite(
    requests: readonly MultiWriteRequest[],
  ): Promise<MultiWriteResult> {
    const id = randomUUID();
    const seenPaths = new Set<string>();
    const prepared = requests.map((request) => {
      const targetPath = normalizeVaultPath(request.path);
      if (seenPaths.has(targetPath)) {
        throw new Error(`A multi-write transaction cannot target a path twice: ${targetPath}`);
      }
      seenPaths.add(targetPath);
      assertExpectedRevision(request.expectedRevision);
      const bytes = Buffer.from(request.content, "utf8");
      return { targetPath, expectedRevision: request.expectedRevision, bytes };
    });
    const blobDirectory = this.getTransactionBlobDirectory(id);
    await fs.mkdir(blobDirectory);
    await syncDirectory(this.transactionDirectory);
    try {
      for (let index = 0; index < prepared.length; index += 1) {
        const item = prepared[index];
        if (!item) {
          continue;
        }
        await durableCreate(this.getTransactionBlobPath(id, index), item.bytes);
      }
    } catch (error) {
      await fs.rm(blobDirectory, { recursive: true, force: true });
      await syncDirectory(this.transactionDirectory);
      throw error;
    }

    const journal: MultiWriteJournal = {
      version: 1,
      id,
      vaultId: this.vaultId,
      kind: "multi-write",
      phase: "intent",
      createdAt: this.clock().toISOString(),
      entries: prepared.map((item) => ({
        targetPath: item.targetPath,
        expectedRevision: item.expectedRevision,
        nextRevision: revisionOf(item.bytes),
        status: "pending",
        currentRevision: null,
        conflictPath: null,
      })),
    };
    await this.writeJournal(journal);
    await this.inject("multi-write:after-intent");
    journal.phase = "applying";
    await this.writeJournal(journal);
    const blobs = await this.loadPendingMultiWriteBlobs(journal);
    for (let index = 0; index < journal.entries.length; index += 1) {
      const entry = journal.entries[index];
      if (entry?.status !== "pending") {
        continue;
      }
      const bytes = blobs.get(index);
      if (!bytes) {
        throw new Error(`Missing prepared bytes for multi-write entry ${index}.`);
      }
      await this.applyMultiWriteEntry(entry, bytes);
      await this.writeJournal(journal);
      await this.inject("multi-write:after-entry");
    }
    journal.phase = "committed";
    await this.writeJournal(journal);
    await this.inject("multi-write:after-commit");
    const result = this.multiWriteResult(journal);
    await this.archiveJournal(journal, result.status);
    return result;
  }

  private async applyMultiWriteEntry(entry: MultiWriteJournalEntry, bytes: Buffer): Promise<void> {
    const targetAbsolute = await this.paths.resolveForWrite(entry.targetPath, true);
    const current = await readStableFile(targetAbsolute);
    if (current?.revision === entry.nextRevision) {
      entry.status = "committed";
      entry.currentRevision = entry.nextRevision;
      entry.conflictPath = null;
      return;
    }

    const result = await this.performWrite(entry.targetPath, bytes, entry.expectedRevision);
    if (result.status === "committed") {
      entry.status = "committed";
      entry.currentRevision = result.revision;
      entry.conflictPath = null;
    } else {
      entry.status = "conflict";
      entry.currentRevision = result.currentRevision;
      entry.conflictPath = result.conflictPath;
    }
  }

  private async loadPendingMultiWriteBlobs(
    journal: MultiWriteJournal,
  ): Promise<Map<number, Buffer>> {
    const blobs = new Map<number, Buffer>();
    for (let index = 0; index < journal.entries.length; index += 1) {
      const entry = journal.entries[index];
      if (entry?.status !== "pending") {
        continue;
      }
      const blobPath = this.getTransactionBlobPath(journal.id, index);
      const stat = await fs.lstat(blobPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Multi-write blob is not a regular file: ${index}`);
      }
      const blob = await readStableFile(blobPath);
      if (!blob || blob.revision !== entry.nextRevision) {
        throw new Error(`Multi-write blob failed its revision check: ${index}`);
      }
      blobs.set(index, blob.bytes);
    }
    return blobs;
  }

  private async loadMoveWithWritesBlobs(
    journal: MoveWithWritesJournal,
  ): Promise<Map<number, MoveWithWritesBlobs>> {
    const blobs = new Map<number, MoveWithWritesBlobs>();
    const strictContainment = journal.strictContainment === true;
    for (let index = 0; index < journal.entries.length; index += 1) {
      const entry = journal.entries[index];
      if (!entry) {
        throw new Error(`Missing compound move journal entry ${index}.`);
      }
      const beforePath = this.getTransactionBlobPath(journal.id, index, "before");
      const nextPath = this.getTransactionBlobPath(journal.id, index, "next");
      if (!strictContainment) {
        const [beforeStat, nextStat] = await Promise.all([
          fs.lstat(beforePath),
          fs.lstat(nextPath),
        ]);
        if (
          !beforeStat.isFile() ||
          beforeStat.isSymbolicLink() ||
          !nextStat.isFile() ||
          nextStat.isSymbolicLink()
        ) {
          throw new Error(`Compound move blobs are not regular files: ${index}`);
        }
      }
      const [before, next] = await Promise.all([
        this.readMutationFile(beforePath, strictContainment),
        this.readMutationFile(nextPath, strictContainment),
      ]);
      if (!before || before.revision !== entry.beforeRevision) {
        throw new Error(`Compound move before blob failed its revision check: ${index}`);
      }
      if (!next || next.revision !== entry.nextRevision) {
        throw new Error(`Compound move next blob failed its revision check: ${index}`);
      }
      blobs.set(index, { before: before.bytes, next: next.bytes });
    }
    return blobs;
  }

  private multiWriteResult(journal: MultiWriteJournal): MultiWriteResult {
    const entries: MultiWriteEntryResult[] = journal.entries.map((entry) => {
      if (entry.status === "committed") {
        return { status: "committed", path: entry.targetPath, revision: entry.nextRevision };
      }
      if (entry.status === "conflict" && entry.conflictPath) {
        return {
          status: "conflict",
          path: entry.targetPath,
          currentRevision: entry.currentRevision,
          conflictPath: entry.conflictPath,
        };
      }
      throw new Error(`Multi-write entry did not reach a terminal state: ${entry.targetPath}`);
    });
    return {
      status: entries.some((entry) => entry.status === "conflict") ? "conflict" : "committed",
      transactionId: journal.id,
      entries,
    };
  }

  private getTransactionBlobDirectory(transactionId: string): string {
    return path.join(this.transactionDirectory, transactionId);
  }

  private getTransactionBlobPath(
    transactionId: string,
    index: number,
    version: "before" | "next" = "next",
  ): string {
    return path.join(this.getTransactionBlobDirectory(transactionId), `${index}.${version}`);
  }

  private getRenameBlobPath(transactionId: string): string {
    return path.join(this.getTransactionBlobDirectory(transactionId), "rename-source");
  }

  private getRenameRestoreBlobPath(transactionId: string): string {
    return path.join(this.getTransactionBlobDirectory(transactionId), "rename-restore");
  }

  private async performWrite(
    targetPath: string,
    bytes: Buffer,
    expectedRevision: string | null,
    strictContainment?: boolean,
  ): Promise<InternalWriteResult>;
  private async performWrite(
    targetPath: string,
    bytes: Buffer,
    expectedRevision: string | null,
    strictContainment: boolean,
    finalPrecondition: WriteFinalPrecondition,
  ): Promise<InternalWriteResult | InternalWritePreconditionFailure>;
  private async performWrite(
    targetPath: string,
    bytes: Buffer,
    expectedRevision: string | null,
    strictContainment = false,
    finalPrecondition?: WriteFinalPrecondition,
  ): Promise<InternalWriteResult | InternalWritePreconditionFailure> {
    // Replacing an existing file leaves the target genuinely missing between its
    // move-aside and the install that restores it. The claim is taken inside the
    // transaction, once the file is actually aside, and released here so every
    // exit path clears it: commit, conflict, rollback, and thrown failure alike.
    const absence = this.#transientAbsences.reserve(targetPath);
    try {
      return await this.performWriteTransaction(
        targetPath,
        bytes,
        expectedRevision,
        strictContainment,
        absence,
        finalPrecondition,
      );
    } finally {
      absence.release();
    }
  }

  private async performWriteTransaction(
    targetPath: string,
    bytes: Buffer,
    expectedRevision: string | null,
    strictContainment: boolean,
    absence: TransientAbsenceHandle,
    finalPrecondition?: WriteFinalPrecondition,
  ): Promise<InternalWriteResult | InternalWritePreconditionFailure> {
    const targetAbsolute = await this.paths.resolveForWrite(targetPath, !strictContainment);
    const initial = await this.readMutationFile(targetAbsolute, strictContainment);
    if (!revisionsMatch(initial, expectedRevision)) {
      const conflictPath = await this.createConflictCopy(targetPath, bytes, strictContainment);
      return {
        status: "conflict",
        currentRevision: initial?.revision ?? null,
        conflictPath: conflictPath.path,
        transactionId: conflictPath.transactionId,
      };
    }

    const id = randomUUID();
    const directory = path.posix.dirname(targetPath);
    const prefix = directory === "." ? "" : `${directory}/`;
    const temporaryPath = `${prefix}.threadleaf-write-${id}.tmp`;
    const rollbackPath = `${prefix}.threadleaf-rollback-${id}.tmp`;
    const journal: WriteJournal = {
      version: 1,
      id,
      vaultId: this.vaultId,
      kind: "write",
      phase: "intent",
      targetPath,
      temporaryPath,
      rollbackPath,
      expectedRevision,
      beforeRevision: initial?.revision ?? null,
      nextRevision: revisionOf(bytes),
      ...(strictContainment ? { strictContainment: true } : {}),
      createdAt: this.clock().toISOString(),
    };
    const temporaryAbsolute = await this.paths.resolveForWrite(temporaryPath);
    const rollbackAbsolute = await this.paths.resolveForWrite(rollbackPath);

    await this.writeJournal(journal);
    await this.inject("write:after-intent");
    if (strictContainment) {
      await durableCreateContainedFile(temporaryAbsolute, bytes);
    } else {
      await durableCreate(temporaryAbsolute, bytes);
    }
    journal.phase = "staged";
    await this.writeJournal(journal);
    await this.inject("write:after-stage");

    if (initial) {
      await this.createMutationFile(this.getRecoveryPath(id), initial.bytes, strictContainment);
    }
    journal.phase = "backed-up";
    await this.writeJournal(journal);
    await this.inject("write:after-backup");
    await this.inject("write:before-final-check");

    await this.paths.resolveForWrite(targetPath);
    const finalSnapshot = await this.readMutationFile(targetAbsolute, strictContainment);
    if (!revisionsMatch(finalSnapshot, expectedRevision)) {
      const conflictPath = await this.promoteTemporaryToConflict(journal);
      await this.archiveJournal(journal, "conflict-copy");
      return {
        status: "conflict",
        currentRevision: finalSnapshot?.revision ?? null,
        conflictPath,
        transactionId: id,
      };
    }

    journal.phase = "prepared";
    await this.writeJournal(journal);
    await this.inject("write:after-prepare");

    // Keep cross-file authorization as close as possible to the first source
    // mutation. Nothing at the source path has moved before this point.
    const preconditionFailure = await finalPrecondition?.();
    if (preconditionFailure) {
      const retired = await this.removeExpectedFile(temporaryAbsolute, journal.nextRevision, {
        claimAuthority: "private",
        cleanupClaim: true,
      });
      if (!retired) {
        throw new Error(
          `Attachment relink staged bytes could not be retired safely: ${journal.targetPath}`,
        );
      }
      await removeIfPresent(this.getRecoveryPath(id));
      await this.archiveJournal(journal, "rolled-back");
      return { status: "precondition-failed", reason: preconditionFailure };
    }

    if (finalSnapshot) {
      // Claimed before the move rather than after it, so the window a watcher
      // can scan through is covered from its first instant. A move-aside that
      // fails leaves the file where it is, which makes the claim inert.
      absence.hold(id);
      const movedAside = await this.moveExistingTargetAside(
        targetAbsolute,
        rollbackAbsolute,
        strictContainment,
        finalSnapshot?.revision,
        strictContainment ? path.join(this.rollbackClaimsDirectory, id) : undefined,
      );
      if (!movedAside) {
        await this.preserveRollback(journal, rollbackAbsolute);
        const conflictPath = await this.promoteTemporaryToConflict(journal);
        await this.archiveJournal(journal, "conflict-copy");
        return {
          status: "conflict",
          currentRevision:
            (await this.readMutationFile(targetAbsolute, strictContainment))?.revision ?? null,
          conflictPath,
          transactionId: id,
        };
      }
      const rollbackSnapshot = await this.readMutationFile(rollbackAbsolute, strictContainment);
      if (!rollbackSnapshot || rollbackSnapshot.revision !== expectedRevision) {
        if (rollbackSnapshot) {
          await atomicWriteFile(this.getRecoveryPath(id), rollbackSnapshot.bytes);
        }
        if (!(await this.mutationFileExists(targetAbsolute, strictContainment))) {
          const restored = await this.installPreparedFile(
            rollbackAbsolute,
            targetAbsolute,
            strictContainment,
          );
          if (!restored) {
            await this.preserveRollback(journal, rollbackAbsolute);
          }
        } else {
          await this.preserveRollback(journal, rollbackAbsolute);
        }
        const conflictPath = await this.promoteTemporaryToConflict(journal);
        await this.archiveJournal(journal, "conflict-copy");
        return {
          status: "conflict",
          currentRevision: rollbackSnapshot?.revision ?? null,
          conflictPath,
          transactionId: id,
        };
      }
      await atomicWriteFile(this.getRecoveryPath(id), rollbackSnapshot.bytes);
      await this.inject("write:after-move-aside");

      const latestRollback = await this.readMutationFile(rollbackAbsolute, strictContainment);
      if (!latestRollback || latestRollback.revision !== expectedRevision) {
        if (latestRollback) {
          await atomicWriteFile(this.getRecoveryPath(id), latestRollback.bytes);
        }
        if (!(await this.mutationFileExists(targetAbsolute, strictContainment))) {
          const restored = await this.installPreparedFile(
            rollbackAbsolute,
            targetAbsolute,
            strictContainment,
          );
          if (!restored) {
            await this.preserveRollback(journal, rollbackAbsolute);
          }
        } else {
          await this.preserveRollback(journal, rollbackAbsolute);
        }
        const conflictPath = await this.promoteTemporaryToConflict(journal);
        await this.archiveJournal(journal, "conflict-copy");
        return {
          status: "conflict",
          currentRevision: latestRollback?.revision ?? null,
          conflictPath,
          transactionId: id,
        };
      }
    }

    let installed: boolean;
    try {
      installed = await this.installPreparedFile(
        temporaryAbsolute,
        targetAbsolute,
        strictContainment,
      );
    } catch (error) {
      if (
        (await this.mutationFileExists(rollbackAbsolute, strictContainment)) &&
        !(await this.mutationFileExists(targetAbsolute, strictContainment))
      ) {
        await this.installPreparedFile(rollbackAbsolute, targetAbsolute, strictContainment);
      }
      throw error;
    }
    if (!installed) {
      if (await this.mutationFileExists(rollbackAbsolute, strictContainment)) {
        await this.preserveRollback(journal, rollbackAbsolute);
      }
      const conflictPath = await this.promoteTemporaryToConflict(journal);
      await this.archiveJournal(journal, "conflict-copy");
      return {
        status: "conflict",
        currentRevision:
          (await this.readMutationFile(targetAbsolute, strictContainment))?.revision ?? null,
        conflictPath,
        transactionId: id,
      };
    }

    journal.phase = "installed";
    await this.writeJournal(journal);
    await this.inject("write:after-install");
    await this.preserveRollback(journal, rollbackAbsolute);
    if (strictContainment) {
      const temporary = await this.readMutationFile(temporaryAbsolute, true);
      if (temporary && temporary.revision !== journal.nextRevision) {
        throw new Error(`Strict staged content changed after installation: ${journal.targetPath}`);
      }
      if (
        temporary &&
        !(await this.retainStrictWriteClaim(journal, temporaryAbsolute, journal.nextRevision))
      ) {
        throw new Error(`Strict staged content could not be retained: ${journal.targetPath}`);
      }
    }
    journal.phase = "committed";
    await this.writeJournal(journal);
    await this.inject("write:after-commit");
    await this.archiveJournal(journal, "committed");
    return { status: "committed", revision: journal.nextRevision, transactionId: id };
  }

  private async createConflictCopy(
    targetPath: string,
    bytes: Buffer,
    strictContainment = false,
  ): Promise<{ path: string; transactionId: string }> {
    const conflictPath = this.buildConflictPath(targetPath, randomUUID());
    const result = await this.performWrite(conflictPath, bytes, null, strictContainment);
    if (result.status === "committed") {
      return { path: conflictPath, transactionId: result.transactionId };
    }
    return { path: result.conflictPath, transactionId: result.transactionId };
  }

  private buildConflictPath(targetPath: string, id: string): string {
    const extension = path.posix.extname(targetPath);
    const stem = extension ? targetPath.slice(0, -extension.length) : targetPath;
    return `${stem}.threadleaf-conflict-${sanitizeTimestamp(this.clock())}-${id.slice(0, 8)}${extension}`;
  }

  private async promoteTemporaryToConflict(journal: WriteJournal): Promise<string> {
    const temporaryAbsolute = await this.paths.resolveForWrite(journal.temporaryPath);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const conflictPath = this.buildConflictPath(journal.targetPath, randomUUID());
      const conflictAbsolute = await this.paths.resolveForWrite(conflictPath, true);
      if (
        await this.installPreparedFile(
          temporaryAbsolute,
          conflictAbsolute,
          journal.strictContainment === true,
        )
      ) {
        return conflictPath;
      }
    }
    throw new Error(`Could not preserve staged content for ${journal.targetPath}`);
  }

  private async moveExistingTargetAside(
    targetAbsolute: string,
    rollbackAbsolute: string,
    strictContainment = false,
    expectedRevision?: string,
    retentionDirectory?: string,
  ): Promise<boolean> {
    if (strictContainment) {
      if (!expectedRevision) return false;
      return moveContainedFileAside(
        targetAbsolute,
        rollbackAbsolute,
        expectedRevision,
        retentionDirectory,
        {
          // The rollback claim is retained in an app-owned transaction
          // directory until the committed receipt permits bounded cleanup.
          claimAuthority: "vault",
          cleanupClaim: false,
        },
      );
    }
    const target = await this.readMutationFile(targetAbsolute, strictContainment);
    if (!target) return false;
    try {
      // Reserve the rollback name with a fresh inode. A plain rename would
      // replace a claimant that won the rollback name between validation and
      // the move. EEXIST is an explicit conflict and leaves that claimant.
      if (strictContainment) {
        await durableCreateContainedFile(rollbackAbsolute, target.bytes);
      } else {
        await durableCreate(rollbackAbsolute, target.bytes);
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
      throw error;
    }
    const rollback = await this.readMutationFile(rollbackAbsolute, strictContainment);
    if (!rollback || rollback.revision !== target.revision) return false;
    return this.removeExpectedFile(targetAbsolute, target.revision, {
      strictContainment,
    });
  }

  private async recoverWrite(journal: WriteJournal): Promise<RecoveryAction> {
    const targetAbsolute = await this.paths.resolveForWrite(journal.targetPath);
    const temporaryAbsolute = await this.paths.resolveForWrite(journal.temporaryPath);
    const rollbackAbsolute = await this.paths.resolveForWrite(journal.rollbackPath);
    const target = await this.readMutationFile(targetAbsolute, journal.strictContainment === true);

    if (target?.revision === journal.nextRevision) {
      await this.preserveRollback(journal, rollbackAbsolute);
      const temporary = await this.readMutationFile(
        temporaryAbsolute,
        journal.strictContainment === true,
      );
      let conflictPath: string | undefined;
      if (temporary && temporary.revision !== journal.nextRevision) {
        conflictPath = await this.promoteTemporaryToConflict(journal);
      } else if (temporary) {
        const removed =
          journal.strictContainment === true
            ? await this.retainStrictWriteClaim(journal, temporaryAbsolute, temporary.revision)
            : await this.removeExpectedFile(temporaryAbsolute, temporary.revision);
        if (!removed) {
          await this.archiveJournal(journal, "manual-conflict");
          return {
            transactionId: journal.id,
            kind: "write",
            outcome: "manual-conflict",
            path: journal.targetPath,
          };
        }
      }
      await this.archiveJournal(
        journal,
        conflictPath ? "committed-with-conflict-copy" : "committed",
      );
      return {
        transactionId: journal.id,
        kind: "write",
        outcome: "committed",
        path: journal.targetPath,
        ...(conflictPath ? { conflictPath } : {}),
      };
    }

    if (journal.beforeRevision === null && !target) {
      const temporary = await this.readMutationFile(
        temporaryAbsolute,
        journal.strictContainment === true,
      );
      if (temporary?.revision === journal.nextRevision) {
        const installed = await this.installPreparedFile(
          temporaryAbsolute,
          targetAbsolute,
          journal.strictContainment === true,
        );
        if (installed) {
          journal.phase = "committed";
          await this.writeJournal(journal);
          await this.archiveJournal(journal, "committed");
          return {
            transactionId: journal.id,
            kind: "write",
            outcome: "committed",
            path: journal.targetPath,
          };
        }
      }
    }

    if (
      !(await this.mutationFileExists(targetAbsolute, journal.strictContainment === true)) &&
      (await this.mutationFileExists(rollbackAbsolute, journal.strictContainment === true))
    ) {
      const restored = await this.installPreparedFile(
        rollbackAbsolute,
        targetAbsolute,
        journal.strictContainment === true,
      );
      if (!restored) {
        await this.preserveRollback(journal, rollbackAbsolute);
      }
    } else {
      await this.preserveRollback(journal, rollbackAbsolute);
    }

    let conflictPath: string | undefined;
    if (await this.mutationFileExists(temporaryAbsolute, journal.strictContainment === true)) {
      conflictPath = await this.promoteTemporaryToConflict(journal);
    }
    const finalTarget = await this.readMutationFile(
      targetAbsolute,
      journal.strictContainment === true,
    );
    const rolledBack = revisionsMatch(finalTarget, journal.beforeRevision);
    const outcome = conflictPath ? "conflict-copy" : rolledBack ? "rolled-back" : "manual-conflict";
    await this.archiveJournal(journal, outcome);
    return {
      transactionId: journal.id,
      kind: "write",
      outcome,
      path: journal.targetPath,
      ...(conflictPath ? { conflictPath } : {}),
    };
  }

  private async recoverRename(journal: RenameJournal): Promise<RecoveryAction> {
    let sourceAbsolute: string;
    let targetAbsolute: string;
    try {
      sourceAbsolute = await this.paths.resolveForWrite(journal.sourcePath);
      targetAbsolute = await this.paths.resolveForWrite(
        journal.targetPath,
        journal.strictContainment !== true,
      );
    } catch {
      return this.archiveRenameConflict(journal);
    }

    if (journal.sourceRetained === true) {
      return this.recoverPublishedRename(journal, sourceAbsolute, targetAbsolute);
    }

    let source = await this.readMutationFile(sourceAbsolute, journal.strictContainment === true);
    let target = await this.readMutationFile(targetAbsolute, journal.strictContainment === true);
    if (
      (source && source.revision !== journal.expectedRevision) ||
      (target && target.revision !== journal.expectedRevision)
    ) {
      return this.archiveRenameConflict(journal);
    }
    if (journal.expectedMarkdownCorpus) {
      const verification = await this.verifyMarkdownCorpus(journal.expectedMarkdownCorpus);
      if (!verification.ok) {
        if (!source && target?.revision === journal.expectedRevision) {
          const restored = await this.restoreRenameSource(
            sourceAbsolute,
            targetAbsolute,
            journal.expectedRevision,
            journal.id,
            journal.strictContainment === true,
          );
          if (!restored) return this.archiveRenameConflict(journal);
        } else if (source && target) {
          await this.removeExpectedFile(targetAbsolute, journal.expectedRevision, {
            strictContainment: journal.strictContainment === true,
          });
        }
        return this.archiveRenameConflict(journal);
      }
    }

    if (!source && !target) return this.archiveRenameConflict(journal);

    if (source && !target) {
      const stagedPath = this.getRenameBlobPath(journal.id);
      const staged = await this.readMutationFile(stagedPath, journal.strictContainment === true);
      if (staged && staged.revision !== journal.expectedRevision) {
        return this.archiveRenameConflict(journal);
      }
      if (!staged) {
        await this.createMutationFile(stagedPath, source.bytes, journal.strictContainment === true);
      }
      journal.phase = "staged";
      await this.writeJournal(journal);
      try {
        await this.paths.resolveForWrite(journal.sourcePath);
        targetAbsolute = await this.paths.resolveForWrite(
          journal.targetPath,
          journal.strictContainment !== true,
        );
        if (
          !(await this.installPreparedFile(
            stagedPath,
            targetAbsolute,
            journal.strictContainment === true,
          ))
        ) {
          return this.archiveRenameConflict(journal);
        }
      } catch {
        return this.archiveRenameConflict(journal);
      }
      target = await this.readMutationFile(targetAbsolute, journal.strictContainment === true);
      source = await this.readMutationFile(sourceAbsolute, journal.strictContainment === true);
      if (
        !target ||
        target.revision !== journal.expectedRevision ||
        !source ||
        source.revision !== journal.expectedRevision
      ) {
        return this.archiveRenameConflict(journal);
      }
    }

    if (!target || target.revision !== journal.expectedRevision) {
      return this.archiveRenameConflict(journal);
    }
    if (source) {
      const evidencePath = this.getRecoveryPath(journal.id);
      const evidence = await this.readMutationFile(
        evidencePath,
        journal.strictContainment === true,
      );
      if (evidence && evidence.revision !== journal.expectedRevision) {
        return this.archiveRenameConflict(journal);
      }
      if (!evidence) {
        await this.createMutationFile(
          evidencePath,
          source.bytes,
          journal.strictContainment === true,
        );
      }
      if (
        !(await this.removeExpectedFile(sourceAbsolute, journal.expectedRevision, {
          strictContainment: journal.strictContainment === true,
        }))
      ) {
        return this.archiveRenameConflict(journal);
      }
      const targetAfterRemoval = await this.readMutationFile(
        targetAbsolute,
        journal.strictContainment === true,
      );
      if (!targetAfterRemoval || targetAfterRemoval.revision !== journal.expectedRevision) {
        const recoveryBytes = await this.readMutationFile(
          evidencePath,
          journal.strictContainment === true,
        );
        if (recoveryBytes?.revision === journal.expectedRevision) {
          await this.installPreparedFile(
            evidencePath,
            sourceAbsolute,
            journal.strictContainment === true,
          );
        }
        return this.archiveRenameConflict(journal);
      }
      source = null;
    }

    journal.phase = "committed";
    await this.archiveJournal(journal, "committed");
    return {
      transactionId: journal.id,
      kind: "rename",
      outcome: "committed",
      path: journal.targetPath,
    };
  }

  private async recoverPublishedRename(
    journal: RenameJournal,
    sourceAbsolute: string,
    targetAbsolute: string,
  ): Promise<RecoveryAction> {
    let targetCheck = await this.checkStrictAttachmentTarget(journal.targetPath);
    if (targetCheck.status !== "ready") {
      return this.archiveRenameConflict(journal);
    }
    targetAbsolute = targetCheck.targetAbsolute;
    const source = await this.readMutationFile(sourceAbsolute, true);
    let target = await this.readMutationFile(targetAbsolute, true);
    if (
      (source && source.revision !== journal.expectedRevision) ||
      (target && target.revision !== journal.expectedRevision)
    ) {
      return this.archiveRenameConflict(journal);
    }
    if (journal.phase === "committed" && !target) {
      // A committed source-retained publication is receipt verification only.
      // Do not turn a later external deletion into a fresh success by
      // reconstructing the destination from our staged or recovery bytes.
      return this.archiveRenameConflict(journal);
    }
    if (target && journal.phase !== "published" && journal.phase !== "committed") {
      // An exact-byte target without a durable publication receipt is still
      // an ambiguous claimant. Preserve it and require manual recovery.
      return this.archiveRenameConflict(journal);
    }
    if (journal.expectedMarkdownCorpus) {
      const verification = await this.verifyMarkdownCorpus(journal.expectedMarkdownCorpus);
      if (!verification.ok) return this.archiveRenameConflict(journal);
    }
    if (!source) return this.archiveRenameConflict(journal);
    if (!target) {
      const stagedPath = this.getRenameBlobPath(journal.id);
      const evidencePath = this.getRecoveryPath(journal.id);
      const staged = await this.readMutationFile(stagedPath, true);
      const evidence = staged ? null : await this.readMutationFile(evidencePath, true);
      const candidate = staged ?? evidence;
      if (!candidate || candidate.revision !== journal.expectedRevision) {
        return this.archiveRenameConflict(journal);
      }
      targetCheck = await this.checkStrictAttachmentTarget(journal.targetPath);
      if (targetCheck.status !== "ready") {
        return this.archiveRenameConflict(journal);
      }
      targetAbsolute = targetCheck.targetAbsolute;
      try {
        if (
          !(await this.installPreparedFile(
            staged ? stagedPath : evidencePath,
            targetAbsolute,
            true,
          ))
        ) {
          // A false install includes a collision or post-publication cleanup
          // uncertainty. Do not infer ownership from an exact target that
          // appeared without a receipt.
          return this.archiveRenameConflict(journal);
        }
      } catch {
        return this.archiveRenameConflict(journal);
      }
    }
    targetCheck = await this.checkStrictAttachmentTarget(journal.targetPath);
    if (targetCheck.status !== "ready") {
      return this.archiveRenameConflict(journal);
    }
    targetAbsolute = targetCheck.targetAbsolute;
    target = await this.readMutationFile(targetAbsolute, true);
    const retainedSource = await this.readMutationFile(sourceAbsolute, true);
    if (
      !target ||
      target.revision !== journal.expectedRevision ||
      !retainedSource ||
      retainedSource.revision !== journal.expectedRevision
    ) {
      return this.archiveRenameConflict(journal);
    }
    journal.phase = "committed";
    await this.archiveJournal(journal, "published-source-retained");
    return {
      transactionId: journal.id,
      kind: "rename",
      outcome: "published-source-retained",
      path: journal.targetPath,
    };
  }

  private async archiveRenameConflict(journal: RenameJournal): Promise<RecoveryAction> {
    await this.archiveJournal(journal, "manual-conflict");
    return {
      transactionId: journal.id,
      kind: "rename",
      outcome: "manual-conflict",
      path: journal.targetPath,
    };
  }

  private async recoverMultiWrite(
    journal: MultiWriteJournal,
    blobs: Map<number, Buffer>,
  ): Promise<RecoveryAction> {
    journal.phase = "applying";
    await this.writeJournal(journal);
    for (let index = 0; index < journal.entries.length; index += 1) {
      const entry = journal.entries[index];
      if (entry?.status !== "pending") {
        continue;
      }
      const bytes = blobs.get(index);
      if (!bytes) {
        throw new Error(`Missing prepared bytes for multi-write recovery entry ${index}.`);
      }
      await this.applyMultiWriteEntry(entry, bytes);
      await this.writeJournal(journal);
    }
    journal.phase = "committed";
    await this.writeJournal(journal);
    const result = this.multiWriteResult(journal);
    await this.archiveJournal(journal, result.status);
    const firstConflict = result.entries.find((entry) => entry.status === "conflict");
    return {
      transactionId: journal.id,
      kind: "multi-write",
      outcome: result.status === "committed" ? "committed" : "conflict-copy",
      path: journal.entries[0]?.targetPath ?? "",
      paths: journal.entries.map((entry) => entry.targetPath),
      ...(firstConflict ? { conflictPath: firstConflict.conflictPath } : {}),
    };
  }

  private async recoverMoveWithWrites(
    journal: MoveWithWritesJournal,
    blobs: Map<number, MoveWithWritesBlobs>,
  ): Promise<RecoveryAction> {
    const result = await this.continueMoveWithWrites(journal, blobs);
    if (result.status === "committed" || result.status === "published-source-retained") {
      return {
        transactionId: journal.id,
        kind: "move-with-writes",
        outcome: result.status,
        path: journal.targetPath,
        paths: journal.entries.map((entry) => entry.targetPath),
      };
    }
    const manual =
      result.reason.startsWith("rollback-conflict:") ||
      result.reason === "rename-state-diverged" ||
      result.reason === "publish-state-diverged" ||
      result.reason === "attachment-publish-unavailable" ||
      result.reason === "target-normalized-exists" ||
      result.reason === "source-missing";
    return {
      transactionId: journal.id,
      kind: "move-with-writes",
      outcome: manual
        ? "manual-conflict"
        : result.conflictPaths.length > 0
          ? "conflict-copy"
          : "rolled-back",
      path: journal.sourcePath,
      paths: journal.entries.map((entry) => entry.targetPath),
      ...(result.conflictPaths[0] ? { conflictPath: result.conflictPaths[0] } : {}),
    };
  }

  private async preserveRollback(journal: WriteJournal, rollbackAbsolute: string): Promise<void> {
    const rollback = await this.readMutationFile(
      rollbackAbsolute,
      journal.strictContainment === true,
    );
    if (rollback) {
      await atomicWriteFile(this.getRecoveryPath(journal.id), rollback.bytes);
      if (journal.beforeRevision !== null && rollback.revision === journal.beforeRevision) {
        const removed =
          journal.strictContainment === true
            ? await this.retainStrictWriteClaim(journal, rollbackAbsolute, journal.beforeRevision)
            : await this.removeExpectedFile(rollbackAbsolute, journal.beforeRevision);
        if (!removed && journal.strictContainment === true) {
          throw new Error(`Strict rollback evidence could not be retained: ${journal.targetPath}`);
        }
      }
      return;
    }
  }

  private getRecoveryPath(transactionId: string): string {
    return path.join(this.recoveryDirectory, `${transactionId}.before`);
  }

  private async writeJournal(journal: TransactionJournal): Promise<void> {
    await atomicWriteFile(
      path.join(this.journalDirectory, `${journal.id}.json`),
      encodeJson(journal),
    );
  }

  private async archiveJournal(journal: TransactionJournal, outcome: string): Promise<void> {
    await atomicWriteFile(
      path.join(this.historyDirectory, `${journal.id}.json`),
      encodeJson({ ...journal, outcome, finishedAt: this.clock().toISOString() }),
    );
    await removeIfPresent(path.join(this.journalDirectory, `${journal.id}.json`));
    if (outcome === "committed") {
      // The history receipt is durable before private rollback claims are
      // collected. A crash between these steps is repaired by the bounded
      // startup sweep, while conflicts retain their evidence for review.
      await fs
        .rm(path.join(this.rollbackClaimsDirectory, journal.id), {
          recursive: true,
          force: true,
        })
        .catch(() => undefined);
      await syncDirectory(this.rollbackClaimsDirectory).catch(() => undefined);
    }
  }

  private async inject(point: KernelFaultPoint): Promise<void> {
    await this.faultInjector?.(point);
  }

  private async checkAttachmentRelinkPreconditions(
    preconditions: VaultAttachmentRelinkPreconditions,
  ): Promise<VaultAttachmentRelinkPreconditionFailure | null> {
    const initialMissingState = await this.attachmentRelinkMissingPathState(
      preconditions.missingPath,
    );
    if (initialMissingState === "present") return "missing-target-present";
    if (initialMissingState === "unsafe") return "missing-target-unsafe";
    if (
      hasHiddenVaultSegment(preconditions.replacementPath) ||
      hasPrivateVaultSegment(preconditions.replacementPath) ||
      hasHiddenVaultSegment(preconditions.replacementCanonicalPath) ||
      hasPrivateVaultSegment(preconditions.replacementCanonicalPath)
    ) {
      return "replacement-unreadable";
    }

    let firstCanonicalAbsolute: string;
    try {
      firstCanonicalAbsolute = await this.paths.resolveForRead(preconditions.replacementPath);
      if (
        this.paths.toVaultPath(firstCanonicalAbsolute) !== preconditions.replacementCanonicalPath
      ) {
        return "replacement-changed";
      }
      const first = await readStableFileWithinLimit(
        firstCanonicalAbsolute,
        preconditions.maxReplacementBytes,
      );
      if (
        first?.status !== "ready" ||
        first.snapshot.revision !== preconditions.replacementRevision
      ) {
        return "replacement-changed";
      }
      const secondCanonicalAbsolute = await this.paths.resolveForRead(
        preconditions.replacementPath,
      );
      if (secondCanonicalAbsolute !== firstCanonicalAbsolute) return "replacement-changed";
      const second = await readStableFileWithinLimit(
        secondCanonicalAbsolute,
        preconditions.maxReplacementBytes,
      );
      if (
        second?.status !== "ready" ||
        second.snapshot.revision !== preconditions.replacementRevision
      ) {
        return "replacement-changed";
      }
      if (
        (await this.paths.resolveForRead(preconditions.replacementPath)) !== firstCanonicalAbsolute
      ) {
        return "replacement-changed";
      }
    } catch {
      return "replacement-unreadable";
    }

    const finalMissingState = await this.attachmentRelinkMissingPathState(
      preconditions.missingPath,
    );
    if (finalMissingState === "present") return "missing-target-present";
    if (finalMissingState === "unsafe") return "missing-target-unsafe";
    let visiblePaths: VisibleVaultPaths;
    try {
      visiblePaths = await this.paths.listVisiblePaths("");
    } catch {
      return "replacement-unreadable";
    }
    const visibleFiles = visiblePaths.files.filter(
      (filePath) =>
        !hasHiddenVaultSegment(filePath) &&
        !hasPrivateVaultSegment(filePath) &&
        !filePath.toLocaleLowerCase("en-US").endsWith(".md"),
    );
    const missingResolution = new VaultLinkResolver(visibleFiles).resolve(
      preconditions.sourceNotePath,
      preconditions.missingResolverTarget,
    );
    if (missingResolution.status === "resolved") return "missing-target-present";
    if (missingResolution.status === "ambiguous") return "missing-target-ambiguous";
    const replacementMatches = visibleFiles.filter(
      (candidate) =>
        normalizedVaultPathIdentity(candidate) ===
        normalizedVaultPathIdentity(preconditions.replacementPath),
    );
    if (
      replacementMatches.length !== 1 ||
      replacementMatches[0] !== preconditions.replacementPath
    ) {
      return "replacement-changed";
    }
    return null;
  }

  private async attachmentRelinkMissingPathState(
    relativePath: string,
  ): Promise<"missing" | "present" | "unsafe"> {
    if (hasHiddenVaultSegment(relativePath) || hasPrivateVaultSegment(relativePath))
      return "unsafe";
    const normalized = normalizeVaultPath(relativePath);
    let current = this.paths.rootPath;
    const segments = normalized.split("/");
    for (let index = 0; index < segments.length; index += 1) {
      current = path.join(current, segments[index] as string);
      let entry: Awaited<ReturnType<typeof fs.lstat>>;
      try {
        entry = await fs.lstat(current);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return "missing";
        }
        return "unsafe";
      }
      if (index === segments.length - 1) return "present";
      if (entry.isSymbolicLink() || !entry.isDirectory()) return "unsafe";
      try {
        const canonical = await fs.realpath(current);
        if (
          path.resolve(canonical) !== path.resolve(current) ||
          !isPathInside(this.paths.rootPath, canonical)
        ) {
          return "unsafe";
        }
      } catch {
        return "unsafe";
      }
    }
    return "unsafe";
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.mutationTail = current;
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  private assertWritable(): void {
    if (this.readOnly) {
      throw new Error("Vault kernel is open in read-only mode.");
    }
  }

  /**
   * Strict attachment publication needs a real, contained parent before any
   * transaction state is created. The namespace scan detects names Linux's
   * exact-basename no-clobber primitive cannot reserve (case/NFC variants).
   */
  private async checkStrictAttachmentTarget(
    targetPath: string,
  ): Promise<StrictAttachmentTargetCheck> {
    try {
      const target = normalizeVaultPath(targetPath);
      const targetKey = normalizedVaultPathIdentity(target);
      const claimants = await this.paths.listNamespaceClaimants();
      const aliasClaimant = claimants.some(
        (candidate) => candidate !== target && normalizedVaultPathIdentity(candidate) === targetKey,
      );
      if (aliasClaimant) {
        return { status: "target-normalized-exists" };
      }
      const exactTarget = await fs
        .lstat(this.paths.resolveLexical(target))
        .catch((error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
          throw error;
        });
      if (exactTarget && !exactTarget.isFile() && !exactTarget.isSymbolicLink()) {
        return { status: "target-normalized-exists" };
      }
    } catch {
      return { status: "attachment-publish-unavailable" };
    }

    let targetAbsolute: string;
    try {
      targetAbsolute = await this.paths.resolveForWrite(targetPath);
      await this.assertAttachmentPublishAvailable(targetAbsolute);
    } catch {
      return { status: "attachment-publish-unavailable" };
    }
    return { status: "ready", targetAbsolute };
  }

  private async assertAttachmentPublishAvailable(targetAbsolute: string): Promise<void> {
    await assertContainedAnonymousPublishCapability(
      this.attachmentPublishCapability,
      path.dirname(targetAbsolute),
    );
  }
}
