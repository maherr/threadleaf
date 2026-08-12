import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  atomicWriteFile,
  durableCreate,
  type FileSnapshot,
  installStagedFile,
  pathExists,
  readStableFile,
  readStableFileWithinLimit,
  removeIfPresent,
  revisionOf,
  sameFile,
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
import {
  canonicalizePotentialPath,
  isPathInside,
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
  VaultDirectoryCreateResult,
  VaultMutationPort,
  VaultRenameResult,
  VaultTextSnapshot,
  VaultWriteResult,
} from "./ports";

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
  | "rename:after-link"
  | "rename:after-commit"
  | "multi-write:after-intent"
  | "multi-write:after-entry"
  | "multi-write:after-commit"
  | "move-with-writes:after-intent"
  | "move-with-writes:after-entry"
  | "move-with-writes:before-rename"
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

export type WriteResult = VaultWriteResult;
export type RenameResult = VaultRenameResult;
export type {
  MoveWithWritesRequest,
  MoveWithWritesResult,
  MultiWriteEntryResult,
  MultiWriteRequest,
  MultiWriteResult,
} from "./ports";

export interface RecoveryAction {
  transactionId: string;
  kind: "write" | "rename" | "multi-write" | "move-with-writes";
  outcome: "committed" | "conflict-copy" | "rolled-back" | "manual-conflict";
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

export class VaultKernel implements VaultMutationPort {
  readonly paths: VaultPathPolicy;
  readonly stateRoot: string;
  readonly vaultId: string;
  readonly readOnly: boolean;
  readonly startupRecoveryActions: RecoveryAction[] = [];

  private readonly faultInjector: KernelFaultInjector | undefined;
  private readonly clock: () => Date;
  private readonly journalDirectory: string;
  private readonly historyDirectory: string;
  private readonly recoveryDirectory: string;
  private readonly transactionDirectory: string;
  private mutationTail: Promise<void> = Promise.resolve();

  private constructor(
    paths: VaultPathPolicy,
    stateRoot: string,
    vaultId: string,
    options: VaultKernelOptions,
  ) {
    this.paths = paths;
    this.stateRoot = stateRoot;
    this.vaultId = vaultId;
    this.readOnly = options.readOnly ?? false;
    this.faultInjector = options.faultInjector;
    this.clock = options.clock ?? (() => new Date());
    this.journalDirectory = path.join(stateRoot, "journal");
    this.historyDirectory = path.join(stateRoot, "history");
    this.recoveryDirectory = path.join(stateRoot, "recovery");
    this.transactionDirectory = path.join(stateRoot, "transactions");
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
    const kernel = new VaultKernel(paths, stateRoot, vaultId, options);
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

  async createDirectory(relativeDirectory: string): Promise<VaultDirectoryCreateResult> {
    this.assertWritable();
    return this.withMutation(() => this.paths.createDirectory(relativeDirectory));
  }

  async renameFile(
    sourcePath: string,
    targetPath: string,
    expectedSourceRevision: string,
  ): Promise<RenameResult> {
    this.assertWritable();
    assertExpectedRevision(expectedSourceRevision);
    return this.withMutation(() =>
      this.performRename(sourcePath, targetPath, expectedSourceRevision),
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
  ): Promise<RenameResult> {
    const source = normalizeVaultPath(sourcePath);
    const target = normalizeVaultPath(targetPath);
    if (source === target) {
      return { status: "committed", from: source, to: target, transactionId: "no-op" };
    }

    const sourceAbsolute = await this.paths.resolveForWrite(source);
    const targetAbsolute = await this.paths.resolveForWrite(target, true);
    const [sourceSnapshot, targetSnapshot] = await Promise.all([
      readStableFile(sourceAbsolute),
      readStableFile(targetAbsolute),
    ]);

    if (!sourceSnapshot || sourceSnapshot.revision !== expectedSourceRevision) {
      return { status: "conflict", from: source, to: target, reason: "source-revision-changed" };
    }
    if (targetSnapshot) {
      return { status: "conflict", from: source, to: target, reason: "target-exists" };
    }

    const journal: RenameJournal = {
      version: 1,
      id: randomUUID(),
      vaultId: this.vaultId,
      kind: "rename",
      phase: "intent",
      sourcePath: source,
      targetPath: target,
      expectedRevision: expectedSourceRevision,
      createdAt: this.clock().toISOString(),
    };
    await this.writeJournal(journal);
    await this.inject("rename:after-intent");

    await this.paths.resolveForWrite(source);
    await this.paths.resolveForWrite(target);
    const finalSource = await readStableFile(sourceAbsolute);
    const finalTarget = await readStableFile(targetAbsolute);
    if (!finalSource || finalSource.revision !== expectedSourceRevision) {
      await this.archiveJournal(journal, "manual-conflict");
      return { status: "conflict", from: source, to: target, reason: "source-revision-changed" };
    }
    if (finalTarget) {
      await this.archiveJournal(journal, "manual-conflict");
      return { status: "conflict", from: source, to: target, reason: "target-created" };
    }

    try {
      await fs.link(sourceAbsolute, targetAbsolute);
      await syncDirectory(path.dirname(targetAbsolute));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        await this.archiveJournal(journal, "manual-conflict");
        return { status: "conflict", from: source, to: target, reason: "target-created" };
      }
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "EXDEV" || error.code === "EPERM" || error.code === "EOPNOTSUPP")
      ) {
        await this.archiveJournal(journal, "manual-conflict");
        return {
          status: "conflict",
          from: source,
          to: target,
          reason: "hard-link-rename-unsupported",
        };
      }
      throw error;
    }

    const [linkedSource, linkedTarget] = await Promise.all([
      readStableFile(sourceAbsolute),
      readStableFile(targetAbsolute),
    ]);
    if (
      !linkedSource ||
      !linkedTarget ||
      linkedSource.revision !== expectedSourceRevision ||
      linkedTarget.revision !== expectedSourceRevision ||
      !(await sameFile(sourceAbsolute, targetAbsolute))
    ) {
      if (await sameFile(sourceAbsolute, targetAbsolute)) {
        await removeIfPresent(targetAbsolute);
        await syncDirectory(path.dirname(targetAbsolute));
      }
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
    await fs.unlink(sourceAbsolute);
    await syncDirectory(path.dirname(sourceAbsolute));
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
      fs.mkdir(this.transactionDirectory, { recursive: true }),
    ]);
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

  private async performMoveWithWrites(
    request: MoveWithWritesRequest,
  ): Promise<MoveWithWritesResult> {
    const sourcePath = normalizeVaultPath(request.sourcePath);
    const targetPath = normalizeVaultPath(request.targetPath);
    if (sourcePath === targetPath) {
      throw new Error("A compound move requires different source and destination paths.");
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

    const sourceAbsolute = await this.paths.resolveForWrite(sourcePath);
    const targetAbsolute = await this.paths.resolveForWrite(targetPath, true);
    const [source, target] = await Promise.all([
      readStableFile(sourceAbsolute),
      readStableFile(targetAbsolute),
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
      const absolutePath = await this.paths.resolveForWrite(item.targetPath, true);
      const current = await readStableFile(absolutePath);
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
        await durableCreate(this.getTransactionBlobPath(id, index, "before"), current.bytes);
        await durableCreate(this.getTransactionBlobPath(id, index, "next"), item.nextBytes);
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
      phase: "intent",
      sourcePath,
      targetPath,
      expectedSourceRevision: request.expectedSourceRevision,
      renameRevision: sourceWrite
        ? revisionOf(sourceWrite.nextBytes)
        : request.expectedSourceRevision,
      reason: null,
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
      const result = this.committedMoveWithWritesResult(journal);
      await this.archiveJournal(journal, "committed");
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

    journal.phase = "applying";
    await this.writeJournal(journal);
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

      const current = await this.readMoveWithWritesTarget(entry.targetPath);
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
        const result = await this.performWrite(
          entry.targetPath,
          entryBlobs.next,
          entry.beforeRevision,
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
      const current = await this.readMoveWithWritesTarget(entry.targetPath);
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

    journal.phase = "renaming";
    journal.reason = null;
    await this.writeJournal(journal);
    await this.inject("move-with-writes:before-rename");
    const rename = await this.performRename(
      journal.sourcePath,
      journal.targetPath,
      journal.renameRevision,
    );
    if (rename.status === "conflict") {
      return this.beginMoveWithWritesRollback(journal, blobs, `rename-${rename.reason}`);
    }
    await this.inject("move-with-writes:after-rename");
    return this.commitMoveWithWrites(journal);
  }

  private async resumeMoveWithWritesRename(
    journal: MoveWithWritesJournal,
    blobs: Map<number, MoveWithWritesBlobs>,
  ): Promise<MoveWithWritesResult | null> {
    const sourceAbsolute = await this.paths.resolveForWrite(journal.sourcePath);
    const targetAbsolute = await this.paths.resolveForWrite(journal.targetPath, true);
    const [source, target] = await Promise.all([
      readStableFile(sourceAbsolute),
      readStableFile(targetAbsolute),
    ]);
    if (!source && target?.revision === journal.renameRevision) {
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

  private async commitMoveWithWrites(
    journal: MoveWithWritesJournal,
  ): Promise<MoveWithWritesResult> {
    journal.phase = "committed";
    journal.reason = null;
    await this.writeJournal(journal);
    await this.inject("move-with-writes:after-commit");
    const result = this.committedMoveWithWritesResult(journal);
    await this.archiveJournal(journal, "committed");
    return result;
  }

  private committedMoveWithWritesResult(journal: MoveWithWritesJournal): MoveWithWritesResult {
    return {
      status: "committed",
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
      const current = await this.readMoveWithWritesTarget(entry.targetPath);
      if (current?.revision === entry.beforeRevision) {
        entry.status = "rolled-back";
        entry.currentRevision = entry.beforeRevision;
      } else {
        const result = await this.performWrite(
          entry.targetPath,
          entryBlobs.before,
          entry.nextRevision,
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
    const outcome = reason.startsWith("rollback-conflict:")
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
    const result = await this.performWrite(entry.targetPath, bytes, expectedRevision);
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

  private async readMoveWithWritesTarget(targetPath: string): Promise<FileSnapshot | null> {
    const absolutePath = await this.paths.resolveForWrite(targetPath, true);
    return readStableFile(absolutePath);
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
    for (let index = 0; index < journal.entries.length; index += 1) {
      const entry = journal.entries[index];
      if (!entry) {
        throw new Error(`Missing compound move journal entry ${index}.`);
      }
      const beforePath = this.getTransactionBlobPath(journal.id, index, "before");
      const nextPath = this.getTransactionBlobPath(journal.id, index, "next");
      const [beforeStat, nextStat] = await Promise.all([fs.lstat(beforePath), fs.lstat(nextPath)]);
      if (
        !beforeStat.isFile() ||
        beforeStat.isSymbolicLink() ||
        !nextStat.isFile() ||
        nextStat.isSymbolicLink()
      ) {
        throw new Error(`Compound move blobs are not regular files: ${index}`);
      }
      const [before, next] = await Promise.all([
        readStableFile(beforePath),
        readStableFile(nextPath),
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

  private async performWrite(
    targetPath: string,
    bytes: Buffer,
    expectedRevision: string | null,
  ): Promise<InternalWriteResult> {
    const targetAbsolute = await this.paths.resolveForWrite(targetPath, true);
    const initial = await readStableFile(targetAbsolute);
    if (!revisionsMatch(initial, expectedRevision)) {
      const conflictPath = await this.createConflictCopy(targetPath, bytes);
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
      createdAt: this.clock().toISOString(),
    };
    const temporaryAbsolute = await this.paths.resolveForWrite(temporaryPath);
    const rollbackAbsolute = await this.paths.resolveForWrite(rollbackPath);

    await this.writeJournal(journal);
    await this.inject("write:after-intent");
    await durableCreate(temporaryAbsolute, bytes);
    journal.phase = "staged";
    await this.writeJournal(journal);
    await this.inject("write:after-stage");

    if (initial) {
      await durableCreate(this.getRecoveryPath(id), initial.bytes);
    }
    journal.phase = "backed-up";
    await this.writeJournal(journal);
    await this.inject("write:after-backup");
    await this.inject("write:before-final-check");

    await this.paths.resolveForWrite(targetPath);
    const finalSnapshot = await readStableFile(targetAbsolute);
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

    if (finalSnapshot) {
      const movedAside = await installStagedFile(targetAbsolute, rollbackAbsolute);
      if (!movedAside) {
        await this.preserveRollback(journal, rollbackAbsolute);
        const conflictPath = await this.promoteTemporaryToConflict(journal);
        await this.archiveJournal(journal, "conflict-copy");
        return {
          status: "conflict",
          currentRevision: (await readStableFile(targetAbsolute))?.revision ?? null,
          conflictPath,
          transactionId: id,
        };
      }
      const rollbackSnapshot = await readStableFile(rollbackAbsolute);
      if (!rollbackSnapshot || rollbackSnapshot.revision !== expectedRevision) {
        if (rollbackSnapshot) {
          await atomicWriteFile(this.getRecoveryPath(id), rollbackSnapshot.bytes);
        }
        if (!(await pathExists(targetAbsolute))) {
          const restored = await installStagedFile(rollbackAbsolute, targetAbsolute);
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

      const latestRollback = await readStableFile(rollbackAbsolute);
      if (!latestRollback || latestRollback.revision !== expectedRevision) {
        if (latestRollback) {
          await atomicWriteFile(this.getRecoveryPath(id), latestRollback.bytes);
        }
        if (!(await pathExists(targetAbsolute))) {
          const restored = await installStagedFile(rollbackAbsolute, targetAbsolute);
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
      installed = await installStagedFile(temporaryAbsolute, targetAbsolute);
    } catch (error) {
      if ((await pathExists(rollbackAbsolute)) && !(await pathExists(targetAbsolute))) {
        await installStagedFile(rollbackAbsolute, targetAbsolute);
      }
      throw error;
    }
    if (!installed) {
      if (await pathExists(rollbackAbsolute)) {
        await this.preserveRollback(journal, rollbackAbsolute);
      }
      const conflictPath = await this.promoteTemporaryToConflict(journal);
      await this.archiveJournal(journal, "conflict-copy");
      return {
        status: "conflict",
        currentRevision: (await readStableFile(targetAbsolute))?.revision ?? null,
        conflictPath,
        transactionId: id,
      };
    }

    journal.phase = "installed";
    await this.writeJournal(journal);
    await this.inject("write:after-install");
    await this.preserveRollback(journal, rollbackAbsolute);
    journal.phase = "committed";
    await this.writeJournal(journal);
    await this.inject("write:after-commit");
    await this.archiveJournal(journal, "committed");
    return { status: "committed", revision: journal.nextRevision, transactionId: id };
  }

  private async createConflictCopy(
    targetPath: string,
    bytes: Buffer,
  ): Promise<{ path: string; transactionId: string }> {
    const conflictPath = this.buildConflictPath(targetPath, randomUUID());
    const result = await this.performWrite(conflictPath, bytes, null);
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
      if (await installStagedFile(temporaryAbsolute, conflictAbsolute)) {
        return conflictPath;
      }
    }
    throw new Error(`Could not preserve staged content for ${journal.targetPath}`);
  }

  private async recoverWrite(journal: WriteJournal): Promise<RecoveryAction> {
    const targetAbsolute = await this.paths.resolveForWrite(journal.targetPath);
    const temporaryAbsolute = await this.paths.resolveForWrite(journal.temporaryPath);
    const rollbackAbsolute = await this.paths.resolveForWrite(journal.rollbackPath);
    const target = await readStableFile(targetAbsolute);

    if (target?.revision === journal.nextRevision) {
      await this.preserveRollback(journal, rollbackAbsolute);
      const temporary = await readStableFile(temporaryAbsolute);
      let conflictPath: string | undefined;
      if (temporary && temporary.revision !== journal.nextRevision) {
        conflictPath = await this.promoteTemporaryToConflict(journal);
      } else {
        await removeIfPresent(temporaryAbsolute);
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
      const temporary = await readStableFile(temporaryAbsolute);
      if (temporary?.revision === journal.nextRevision) {
        const installed = await installStagedFile(temporaryAbsolute, targetAbsolute);
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

    if (!(await pathExists(targetAbsolute)) && (await pathExists(rollbackAbsolute))) {
      const restored = await installStagedFile(rollbackAbsolute, targetAbsolute);
      if (!restored) {
        await this.preserveRollback(journal, rollbackAbsolute);
      }
    } else {
      await this.preserveRollback(journal, rollbackAbsolute);
    }

    let conflictPath: string | undefined;
    if (await pathExists(temporaryAbsolute)) {
      conflictPath = await this.promoteTemporaryToConflict(journal);
    }
    const finalTarget = await readStableFile(targetAbsolute);
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
    const sourceAbsolute = await this.paths.resolveForWrite(journal.sourcePath);
    const targetAbsolute = await this.paths.resolveForWrite(journal.targetPath);
    const [source, target] = await Promise.all([
      readStableFile(sourceAbsolute),
      readStableFile(targetAbsolute),
    ]);

    if (source && target) {
      const linked = await sameFile(sourceAbsolute, targetAbsolute);
      if (
        !linked ||
        source.revision !== journal.expectedRevision ||
        target.revision !== journal.expectedRevision
      ) {
        if (linked) {
          await removeIfPresent(targetAbsolute);
          await syncDirectory(path.dirname(targetAbsolute));
        }
        return this.archiveRenameConflict(journal);
      }
      await fs.unlink(sourceAbsolute);
      await syncDirectory(path.dirname(sourceAbsolute));
    } else if (source) {
      if (source.revision !== journal.expectedRevision) {
        return this.archiveRenameConflict(journal);
      }
      try {
        await fs.link(sourceAbsolute, targetAbsolute);
        await syncDirectory(path.dirname(targetAbsolute));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") {
          return this.archiveRenameConflict(journal);
        }
        throw error;
      }
      const linkedTarget = await readStableFile(targetAbsolute);
      if (
        !linkedTarget ||
        linkedTarget.revision !== journal.expectedRevision ||
        !(await sameFile(sourceAbsolute, targetAbsolute))
      ) {
        if (await sameFile(sourceAbsolute, targetAbsolute)) {
          await removeIfPresent(targetAbsolute);
          await syncDirectory(path.dirname(targetAbsolute));
        }
        return this.archiveRenameConflict(journal);
      }
      await fs.unlink(sourceAbsolute);
      await syncDirectory(path.dirname(sourceAbsolute));
    } else if (!target || target.revision !== journal.expectedRevision) {
      return this.archiveRenameConflict(journal);
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
    if (result.status === "committed") {
      return {
        transactionId: journal.id,
        kind: "move-with-writes",
        outcome: "committed",
        path: journal.targetPath,
        paths: journal.entries.map((entry) => entry.targetPath),
      };
    }
    const manual =
      result.reason.startsWith("rollback-conflict:") ||
      result.reason === "rename-state-diverged" ||
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
    const rollback = await readStableFile(rollbackAbsolute);
    if (rollback) {
      await atomicWriteFile(this.getRecoveryPath(journal.id), rollback.bytes);
    }
    await removeIfPresent(rollbackAbsolute);
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
  }

  private async inject(point: KernelFaultPoint): Promise<void> {
    await this.faultInjector?.(point);
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
}
