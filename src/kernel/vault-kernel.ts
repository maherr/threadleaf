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
  removeIfPresent,
  revisionOf,
  sameFile,
  syncDirectory,
} from "./durability";
import {
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
} from "./path-policy";
import type { StateRootPort } from "./ports";

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
  | "rename:after-commit";

export type KernelFaultInjector = (point: KernelFaultPoint) => void | Promise<void>;

export interface VaultKernelOptions {
  vaultRoot: string;
  stateRoot: StateRootPort;
  readOnly?: boolean;
  faultInjector?: KernelFaultInjector;
  clock?: () => Date;
}

export interface TextFileSnapshot {
  path: string;
  content: string;
  revision: string;
  size: number;
}

export type WriteResult =
  | {
      status: "committed";
      path: string;
      revision: string;
      transactionId: string;
    }
  | {
      status: "conflict";
      path: string;
      currentRevision: string | null;
      conflictPath: string;
      transactionId: string;
    };

export type RenameResult =
  | { status: "committed"; from: string; to: string; transactionId: string }
  | { status: "conflict"; from: string; to: string; reason: string };

export interface RecoveryAction {
  transactionId: string;
  kind: "write" | "rename";
  outcome: "committed" | "conflict-copy" | "rolled-back" | "manual-conflict";
  path: string;
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

const textDecoder = new TextDecoder("utf-8", { fatal: true });

function revisionsMatch(snapshot: FileSnapshot | null, expectedRevision: string | null): boolean {
  return (snapshot?.revision ?? null) === expectedRevision;
}

function encodeJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sanitizeTimestamp(date: Date): string {
  return date.toISOString().replaceAll(/[-:.]/g, "");
}

export class VaultKernel {
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
    await kernel.initializeState();
    const realizedStateRoot = await fs.realpath(kernel.stateRoot);
    if (isPathInside(paths.rootPath, realizedStateRoot)) {
      throw new Error("Threadleaf state must be stored outside the vault.");
    }
    if (!kernel.readOnly) {
      kernel.startupRecoveryActions.push(...(await kernel.recover()));
    }
    return kernel;
  }

  getName(): string {
    return this.paths.getName();
  }

  async listMarkdownPaths(): Promise<string[]> {
    return this.paths.listMarkdownPaths();
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

  async writeText(
    relativePath: string,
    content: string,
    expectedRevision: string | null,
  ): Promise<WriteResult> {
    this.assertWritable();
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

  async renameFile(
    sourcePath: string,
    targetPath: string,
    expectedSourceRevision: string,
  ): Promise<RenameResult> {
    this.assertWritable();
    return this.withMutation(() =>
      this.performRename(sourcePath, targetPath, expectedSourceRevision),
    );
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

    for (const journal of journals) {
      actions.push(
        journal.kind === "write"
          ? await this.recoverWrite(journal)
          : await this.recoverRename(journal),
      );
    }
    return actions;
  }

  private async initializeState(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.journalDirectory, { recursive: true }),
      fs.mkdir(this.historyDirectory, { recursive: true }),
      fs.mkdir(this.recoveryDirectory, { recursive: true }),
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
