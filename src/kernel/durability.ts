import { createHash, randomUUID } from "node:crypto";
import {
  type BigIntStats,
  close as closeDescriptor,
  constants,
  promises as fs,
  readFile as readDescriptor,
  fstat as statDescriptor,
  fsync as syncDescriptor,
  writeFile as writeDescriptor,
} from "node:fs";
import path from "node:path";

import * as nativeFilesystem from "../native-filesystem/index.js";

// Linux exposes held-directory children through /proc/self/fd. Darwin does
// not provide equivalent child traversal through /dev/fd, so the native
// boundary uses openat and renameatx_np against the same held descriptors.
const descriptorRoot = process.platform === "linux" ? "/proc/self/fd" : null;
const descriptorDirectoryFlags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0);
const descriptorNoFollow = constants.O_NOFOLLOW ?? 0;

export const strictContainmentSupported =
  (process.platform === "linux" || process.platform === "darwin") &&
  Boolean(constants.O_DIRECTORY && constants.O_NOFOLLOW);

/** Stable contract name for strict, source-retaining attachment publication. */
export const FILE_PUBLISH_CAPABILITY = "FILE-PUBLISH-CAP-02" as const;

export type AttachmentPublishCapabilityCode =
  | "unsupported-platform"
  | "anonymous-publication-unsupported"
  | "cross-device"
  | "durability";

export type AttachmentPublishCapability =
  | {
      status: "supported";
      device: string;
      contract: typeof FILE_PUBLISH_CAPABILITY;
    }
  | {
      status: "unsupported";
      code: AttachmentPublishCapabilityCode;
      contract: typeof FILE_PUBLISH_CAPABILITY;
      detail: string;
    };

export class AttachmentPublishCapabilityError extends Error {
  readonly code: AttachmentPublishCapabilityCode;
  readonly contract = FILE_PUBLISH_CAPABILITY;
  readonly detail: string;

  constructor(capability: Extract<AttachmentPublishCapability, { status: "unsupported" }>) {
    super(`${FILE_PUBLISH_CAPABILITY}: ${capability.code}: ${capability.detail}`);
    this.name = "AttachmentPublishCapabilityError";
    this.code = capability.code;
    this.detail = capability.detail;
  }
}

/** Strict containment is deliberately opt-in for attachment transactions. */
export class ContainedDurabilityError extends Error {
  constructor(operation: string) {
    super(
      `${operation} requires descriptor-relative no-follow support; ` +
        `strict attachment mutation is unavailable on ${process.platform}`,
    );
    this.name = "ContainedDurabilityError";
  }
}

function requireDescriptorContainment(operation: string): void {
  if (!strictContainmentSupported) {
    throw new ContainedDurabilityError(operation);
  }
}

function unsupportedPublishCapability(
  code: AttachmentPublishCapabilityCode,
  detail: string,
): Extract<AttachmentPublishCapability, { status: "unsupported" }> {
  return { status: "unsupported", code, contract: FILE_PUBLISH_CAPABILITY, detail };
}

function classifyPublishCapabilityFailure(
  error: unknown,
): Extract<AttachmentPublishCapability, { status: "unsupported" }> {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  if (code === "cross-device" || code === "EXDEV") {
    return unsupportedPublishCapability(
      "cross-device",
      "no-clobber publication crossed filesystem devices",
    );
  }
  if (
    code === "unsupported" ||
    code === "EOPNOTSUPP" ||
    code === "ENOTSUP" ||
    code === "ENOSYS" ||
    code === "EINVAL" ||
    code === "EPERM" ||
    code === "EACCES"
  ) {
    return unsupportedPublishCapability(
      "anonymous-publication-unsupported",
      `the runtime or filesystem rejected anonymous no-clobber publication (${String(code)})`,
    );
  }
  return unsupportedPublishCapability(
    "durability",
    error instanceof Error ? error.message : "the filesystem probe did not complete",
  );
}

function descriptorEntry(root: string, descriptor: number, name: string): string {
  return path.join(root, String(descriptor), name);
}

function statRawDescriptor(descriptor: number): Promise<BigIntStats> {
  return new Promise((resolve, reject) => {
    statDescriptor(descriptor, { bigint: true }, (error, stats) => {
      if (error) reject(error);
      else resolve(stats);
    });
  });
}

function closeRawDescriptor(descriptor: number): Promise<void> {
  return new Promise((resolve, reject) => {
    closeDescriptor(descriptor, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function syncRawDescriptor(descriptor: number): Promise<void> {
  return new Promise((resolve, reject) => {
    syncDescriptor(descriptor, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function readRawDescriptor(descriptor: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    readDescriptor(descriptor, (error, bytes) => {
      if (error) reject(error);
      else resolve(bytes);
    });
  });
}

function writeRawDescriptor(descriptor: number, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    writeDescriptor(descriptor, bytes, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function rawFileHandle(descriptor: number) {
  let closed = false;
  return {
    fd: descriptor,
    stat: (_options: { bigint: true }) => statRawDescriptor(descriptor),
    readFile: () => readRawDescriptor(descriptor),
    writeFile: (bytes: Uint8Array) => writeRawDescriptor(descriptor, bytes),
    sync: () => syncRawDescriptor(descriptor),
    close: async () => {
      if (closed) return;
      await closeRawDescriptor(descriptor);
      closed = true;
    },
  };
}

type ContainedHandle = Awaited<ReturnType<typeof fs.open>> | ReturnType<typeof rawFileHandle>;

function openDirectoryChild(parentDescriptor: number, name: string) {
  if (process.platform === "darwin") {
    return Promise.resolve(
      rawFileHandle(nativeFilesystem.openDirectoryNoFollowAt(parentDescriptor, name)),
    );
  }
  const root = descriptorRoot;
  if (!root) throw new ContainedDurabilityError("Contained directory open");
  return fs.open(
    descriptorEntry(root, parentDescriptor, name),
    descriptorDirectoryFlags | descriptorNoFollow,
  );
}

function openFileChild(directoryDescriptor: number, name: string, create: boolean) {
  if (process.platform === "darwin") {
    return Promise.resolve(
      rawFileHandle(nativeFilesystem.openFileNoFollowAt(directoryDescriptor, name, create)),
    );
  }
  const root = descriptorRoot;
  if (!root) throw new ContainedDurabilityError("Contained file open");
  return fs.open(
    descriptorEntry(root, directoryDescriptor, name),
    create
      ? constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | descriptorNoFollow
      : constants.O_RDONLY | descriptorNoFollow,
    0o600,
  );
}

function claimQuarantinePath(filePath: string): string {
  return path.join(path.dirname(filePath), `.threadleaf-claim-${randomUUID()}.tmp`);
}

async function openContainedDirectory(directoryPath: string) {
  requireDescriptorContainment("Contained directory access");
  const absolute = path.resolve(directoryPath);
  const filesystemRoot = path.parse(absolute).root;
  let current: ContainedHandle = await fs.open(
    filesystemRoot,
    descriptorDirectoryFlags | descriptorNoFollow,
  );
  try {
    for (const segment of path.relative(filesystemRoot, absolute).split(path.sep).filter(Boolean)) {
      const next = await openDirectoryChild(current.fd, segment);
      await current.close();
      current = next;
    }
    return current;
  } catch (error) {
    await current.close().catch(() => undefined);
    throw error;
  }
}

async function hasRealDirectoryChain(directoryPath: string): Promise<boolean> {
  const absolute = path.resolve(directoryPath);
  const filesystemRoot = path.parse(absolute).root;
  let current = filesystemRoot;
  for (const segment of path.relative(filesystemRoot, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  }
  return true;
}

type ContainedDirectory = Awaited<ReturnType<typeof openContainedDirectory>>;

async function readContainedFileAt(
  directory: ContainedDirectory,
  fileName: string,
): Promise<FileSnapshot | null> {
  requireDescriptorContainment("Contained file read");
  let file: ContainedHandle;
  try {
    file = await openFileChild(directory.fd, fileName, false);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "missing")
    ) {
      return null;
    }
    throw error;
  }
  try {
    const before = await file.stat({ bigint: true });
    const bytes = await file.readFile();
    const after = await file.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error(`Contained file changed while it was read: ${fileName}`);
    }
    return { bytes, revision: revisionOf(bytes), size: bytes.length };
  } finally {
    await file.close();
  }
}

async function createContainedFileAt(
  directory: ContainedDirectory,
  fileName: string,
  bytes: Uint8Array,
): Promise<void> {
  requireDescriptorContainment("Contained file create");
  const file = await openFileChild(directory.fd, fileName, true);
  try {
    await file.writeFile(bytes);
    await file.sync();
    await directory.sync();
  } finally {
    await file.close();
  }
}

async function renameContainedAt(
  directory: ContainedDirectory,
  sourceName: string,
  targetName: string,
): Promise<void> {
  requireDescriptorContainment("Contained file claim");
  nativeFilesystem.renameNoReplaceAt(directory.fd, sourceName, directory.fd, targetName);
  await directory.sync();
}

/**
 * Preflight strict attachment publication without creating or deleting vault
 * names. The host binding and descriptor-relative root are checked here; the
 * exact destination filesystem remains authoritatively gated when an unnamed
 * inode is linked at the absent target before any Markdown rewrite begins.
 */
export async function probeContainedPublishCapability(
  vaultRoot: string,
): Promise<AttachmentPublishCapability> {
  if (!strictContainmentSupported) {
    return unsupportedPublishCapability(
      "unsupported-platform",
      `descriptor-relative no-follow support is unavailable on ${process.platform}`,
    );
  }

  let directory: ContainedDirectory | undefined;
  let result: AttachmentPublishCapability = unsupportedPublishCapability(
    "durability",
    "attachment publication preflight did not complete",
  );
  try {
    nativeFilesystem.assertAnonymousPublishAvailable();
    directory = await openContainedDirectory(vaultRoot);
    const device = (await directory.stat({ bigint: true })).dev.toString();
    result = { status: "supported", device, contract: FILE_PUBLISH_CAPABILITY };
  } catch (error) {
    result = classifyPublishCapabilityFailure(error);
  } finally {
    if (directory) {
      await directory.close().catch((error) => {
        result = unsupportedPublishCapability(
          "durability",
          `attachment publication preflight close failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
  }
  return result;
}

export async function assertContainedPublishCapability(
  capability: AttachmentPublishCapability,
  targetDirectory: string,
): Promise<void> {
  if (capability.status !== "supported") {
    throw new AttachmentPublishCapabilityError(capability);
  }
  const directory = await openContainedDirectory(targetDirectory);
  try {
    const device = (await directory.stat({ bigint: true })).dev.toString();
    if (device !== capability.device) {
      throw new AttachmentPublishCapabilityError(
        unsupportedPublishCapability(
          "cross-device",
          "the attachment destination parent is on a different filesystem device",
        ),
      );
    }
  } finally {
    await directory.close();
  }
}

/**
 * Prove anonymous-inode create/write/durability on the exact held attachment
 * target parent without linking or creating a vault name. This is intentionally
 * narrower than the device-only receipt used for rewrite parents and private
 * rollback evidence: final linkat at the requested basename remains the
 * authoritative no-clobber publication check.
 */
export async function assertContainedAnonymousPublishCapability(
  capability: AttachmentPublishCapability,
  targetDirectory: string,
): Promise<void> {
  let directory: ContainedDirectory | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    await assertContainedPublishCapability(capability, targetDirectory);
    directory = await openContainedDirectory(targetDirectory);
    nativeFilesystem.probeAnonymousPublishNoName(directory.fd);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  let closeError: unknown;
  if (directory) {
    try {
      await directory.close();
    } catch (error) {
      closeError = error;
    }
  }
  if (operationFailed) {
    if (operationError instanceof AttachmentPublishCapabilityError) throw operationError;
    throw new AttachmentPublishCapabilityError(classifyPublishCapabilityFailure(operationError));
  }
  if (closeError !== undefined) {
    throw new AttachmentPublishCapabilityError(classifyPublishCapabilityFailure(closeError));
  }
}

/**
 * Preserve a strict claim without replacing a retention claimant. A
 * same-filesystem no-clobber rename consumes the claim and is verified at its
 * new name. Cross-device retention copies and verifies the evidence but leaves
 * the source claim in place because no generation-conditional unlink exists.
 */
async function retainContainedClaim(
  sourceDirectory: ContainedDirectory,
  claimName: string,
  expectedRevision: string,
  retentionDirectory: string | undefined,
): Promise<boolean> {
  if (!retentionDirectory) return true;
  await fs.mkdir(retentionDirectory, { recursive: true, mode: 0o700 });
  const destinationDirectory = await openContainedDirectory(retentionDirectory);
  requireDescriptorContainment("Contained claim retention");
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const retainedName = `.threadleaf-retained-${randomUUID()}.bin`;
      try {
        nativeFilesystem.renameNoReplaceAt(
          sourceDirectory.fd,
          claimName,
          destinationDirectory.fd,
          retainedName,
        );
        await sourceDirectory.sync();
        await destinationDirectory.sync();
        const retained = await readContainedFileAt(destinationDirectory, retainedName);
        return retained?.revision === expectedRevision;
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error.code === "cross-device" || error.code === "EXDEV")
        ) {
          // A vault and its private state may be on different devices. Copy
          // the already-claimed bytes into an exclusive private evidence file
          // and then verify the destination and source claim. A failed copy
          // or changed claim leaves residue recoverable in the original
          // directory; the EXDEV path never removes the user-vault claim by
          // pathname because no generation-conditional unlink exists.
          const claimed = await readContainedFileAt(sourceDirectory, claimName);
          if (!claimed || claimed.revision !== expectedRevision) return false;
          await createContainedFileAt(destinationDirectory, retainedName, claimed.bytes);
          const retained = await readContainedFileAt(destinationDirectory, retainedName);
          if (!retained || retained.revision !== claimed.revision) {
            throw new Error("Cross-device claim retention verification failed.");
          }
          const stillClaimed = await readContainedFileAt(sourceDirectory, claimName);
          if (!stillClaimed || stillClaimed.revision !== claimed.revision) {
            return false;
          }
          // There is no portable generation-conditional unlink. The source
          // parent is user-vault state, so never remove this pathname after a
          // cross-device copy: a same-UID replacement could win between the
          // final read and unlink. Leave the claim beside the original name
          // as recoverable evidence and make the caller surface a conflict.
          return false;
        }
        if (
          error instanceof Error &&
          "code" in error &&
          (error.code === "missing" || error.code === "ENOENT")
        ) {
          return false;
        }
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            (error.code === "exists" || error.code === "EEXIST")
          )
        ) {
          throw error;
        }
      }
    }
    throw new Error("Could not reserve a private claim-retention name.");
  } finally {
    await destinationDirectory.close();
  }
}

async function settleContainedClaim(
  directory: ContainedDirectory,
  claimName: string,
  expectedRevision: string,
  hooks: ContainedRemovalHooks,
): Promise<boolean> {
  const claim = await readContainedFileAt(directory, claimName);
  // A same-UID claimant may have replaced the quarantine name. Leave that
  // evidence untouched rather than unlinking an uncertain pathname.
  if (!claim || claim.revision !== expectedRevision) {
    return false;
  }
  // This barrier is deliberately after the final validation and immediately
  // before settlement. Tests and callers can model an editor winning this
  // exact window; the second read then refuses to move the winner.
  await hooks.beforeCleanup?.();
  const afterBarrier = await readContainedFileAt(directory, claimName);
  if (!afterBarrier || afterBarrier.revision !== expectedRevision) {
    return false;
  }
  if (hooks.retentionDirectory) {
    return retainContainedClaim(directory, claimName, expectedRevision, hooks.retentionDirectory);
  }
  // Strict vault paths never unlink a mutable claim name, including a
  // high-entropy app-private one. Without an explicit retention destination,
  // leave the claim as recoverable evidence and report that removal did not
  // settle.
  return false;
}

async function openContainedFile(
  filePath: string,
  flags: number,
  _mode?: number,
): Promise<{
  file: ContainedHandle;
  directory: ContainedDirectory;
}> {
  requireDescriptorContainment("Contained file access");
  const directory = await openContainedDirectory(path.dirname(filePath));
  try {
    const create = Boolean(flags & constants.O_CREAT);
    const file = await openFileChild(directory.fd, path.basename(filePath), create);
    return { file, directory };
  } catch (error) {
    await directory.close().catch(() => undefined);
    throw error;
  }
}

export async function readContainedFile(filePath: string): Promise<FileSnapshot | null> {
  let opened: Awaited<ReturnType<typeof openContainedFile>>;
  try {
    opened = await openContainedFile(filePath, constants.O_RDONLY);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "missing")
    ) {
      return null;
    }
    throw error;
  }
  try {
    const before = await opened.file.stat({ bigint: true });
    const bytes = await opened.file.readFile();
    const after = await opened.file.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error(`Contained file changed while it was read: ${filePath}`);
    }
    return { bytes, revision: revisionOf(bytes), size: bytes.length };
  } finally {
    await opened.file.close();
    await opened.directory.close();
  }
}

async function createContainedFile(filePath: string, bytes: Uint8Array): Promise<void> {
  const opened = await openContainedFile(
    filePath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    await opened.file.writeFile(bytes);
    await opened.file.sync();
    await opened.directory.sync();
  } finally {
    await opened.file.close();
    await opened.directory.close();
  }
}

export async function durableCreateContainedFile(
  filePath: string,
  bytes: Uint8Array,
): Promise<void> {
  await createContainedFile(filePath, bytes);
}

/**
 * Reserve a rollback name and claim the expected target while keeping its
 * parent descriptor open for the whole sequence. This is the strict sibling
 * of the portable write rollback path: an ancestor replacement cannot move
 * the read, exclusive create, or claim to a different directory generation.
 */
export async function moveContainedFileAside(
  targetPath: string,
  rollbackPath: string,
  expectedRevision: string,
  retentionDirectory: string | undefined,
  hooks: Omit<ContainedRemovalHooks, "retentionDirectory"> = {},
): Promise<boolean> {
  const targetDirectoryPath = path.dirname(targetPath);
  if (path.resolve(targetDirectoryPath) !== path.resolve(path.dirname(rollbackPath))) {
    throw new Error("Contained rollback requires one directory.");
  }
  const directory = await openContainedDirectory(targetDirectoryPath);
  try {
    const targetName = path.basename(targetPath);
    const rollbackName = path.basename(rollbackPath);
    const target = await readContainedFileAt(directory, targetName);
    if (!target || target.revision !== expectedRevision) return false;
    try {
      await createContainedFileAt(directory, rollbackName, target.bytes);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "EEXIST" || error.code === "exists")
      ) {
        return false;
      }
      throw error;
    }
    const rollback = await readContainedFileAt(directory, rollbackName);
    if (!rollback || rollback.revision !== expectedRevision) return false;
    const removed = await removeExpectedContainedFileInternal(
      targetPath,
      expectedRevision,
      {
        ...hooks,
        // Direct callers default to vault authority. The kernel's rollback
        // path opts into private authority only after it has copied the exact
        // bytes into its private recovery record.
        claimAuthority: hooks.claimAuthority ?? "vault",
        cleanupClaim: hooks.cleanupClaim ?? false,
        ...(retentionDirectory ? { retentionDirectory } : {}),
      },
      directory,
    );
    return removed;
  } finally {
    await directory.close();
  }
}

export interface FileSnapshot {
  bytes: Buffer;
  revision: string;
  size: number;
}

export type BoundedFileSnapshot =
  | { status: "ready"; snapshot: FileSnapshot }
  | { status: "too-large"; size: number };

export function revisionOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function readStableFile(filePath: string): Promise<FileSnapshot | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try {
      handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }

    try {
      const before = await handle.stat({ bigint: true });
      const bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      if (
        before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeNs === after.mtimeNs &&
        before.ctimeNs === after.ctimeNs
      ) {
        return { bytes, revision: revisionOf(bytes), size: bytes.length };
      }
    } finally {
      await handle.close();
    }
  }

  throw new Error(`File kept changing while it was read: ${filePath}`);
}

export async function readStableFileWithinLimit(
  filePath: string,
  maxBytes: number,
): Promise<BoundedFileSnapshot | null> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("A stable file read limit must be a positive safe integer.");
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try {
      handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }

    try {
      const before = await handle.stat({ bigint: true });
      if (before.size > BigInt(maxBytes)) {
        return {
          status: "too-large",
          size:
            before.size > BigInt(Number.MAX_SAFE_INTEGER)
              ? Number.MAX_SAFE_INTEGER
              : Number(before.size),
        };
      }
      const capacity = Math.min(maxBytes + 1, Number(before.size) + 1);
      const boundedBuffer = Buffer.allocUnsafe(capacity);
      let offset = 0;
      while (offset < boundedBuffer.length) {
        const { bytesRead } = await handle.read(
          boundedBuffer,
          offset,
          boundedBuffer.length - offset,
          null,
        );
        if (bytesRead === 0) {
          break;
        }
        offset += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (
        before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeNs === after.mtimeNs &&
        before.ctimeNs === after.ctimeNs
      ) {
        if (offset > maxBytes) {
          return { status: "too-large", size: offset };
        }
        const bytes = Buffer.from(boundedBuffer.subarray(0, offset));
        return {
          status: "ready",
          snapshot: { bytes, revision: revisionOf(bytes), size: bytes.length },
        };
      }
    } finally {
      await handle.close();
    }
  }

  throw new Error(`File kept changing while it was read: ${filePath}`);
}

export async function durableCreate(filePath: string, bytes: Uint8Array): Promise<void> {
  const handle = await fs.open(
    filePath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(filePath));
}

export async function atomicWriteFile(filePath: string, bytes: Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  try {
    await durableCreate(temporaryPath, bytes);
    await fs.rename(temporaryPath, filePath);
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    await removeIfPresent(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function installStagedFile(stagedPath: string, targetPath: string): Promise<boolean> {
  const staged = await readStableFile(stagedPath);
  if (!staged) {
    throw new Error(`Staged file does not exist: ${stagedPath}`);
  }

  // The staged bytes are deliberately copied into a fresh inode. A hard link
  // would make a later editor of either name mutate the other name, which is
  // unsafe for rename/recovery and also lets a concurrent winner change the
  // transaction's evidence in place.
  const targetDirectory = path.dirname(targetPath);
  if (!(await hasRealDirectoryChain(targetDirectory))) {
    throw new Error(`Staged target parent changed through a symbolic link: ${targetPath}`);
  }

  try {
    await durableCreate(targetPath, staged.bytes);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return false;
    }
    throw error;
  }

  const installed = await readStableFile(targetPath);
  if (!installed || installed.revision !== staged.revision) {
    // Keep the staged proposal available to the caller as conflict evidence.
    return false;
  }
  // Claim the staged name through the same claim-and-verify primitive. A
  // concurrent replacement of the temporary name must remain recoverable,
  // even for ordinary cross-platform writers.
  try {
    return await removeExpectedFilePortably(stagedPath, staged.revision, {
      claimAuthority: "private",
      cleanupClaim: true,
    });
  } catch {
    // The destination is already durable. Keep the private staged bytes and
    // report an explicit install conflict so a journal can recover; never
    // turn post-publication cleanup failure into a false success or overwrite.
    return false;
  }
}

/**
 * Strict attachment installation. Every ancestor is opened no-follow from a
 * held descriptor. The native boundary writes the exact bytes into an
 * anonymous target-filesystem inode and atomically links it at an absent
 * basename. No target-side staging pathname exists for another process to
 * replace. Windows and other unsupported platforms fail only when an
 * attachment requests strict containment.
 */
export async function installContainedStagedFile(
  stagedPath: string,
  targetPath: string,
): Promise<boolean> {
  const stagedDirectory = await openContainedDirectory(path.dirname(stagedPath));
  let targetDirectory: ContainedDirectory;
  try {
    targetDirectory = await openContainedDirectory(path.dirname(targetPath));
  } catch (error) {
    await stagedDirectory.close().catch(() => undefined);
    throw error;
  }
  try {
    const staged = await readContainedFileAt(stagedDirectory, path.basename(stagedPath));
    if (!staged) throw new Error(`Staged file does not exist: ${stagedPath}`);
    try {
      nativeFilesystem.publishBufferNoReplace(
        targetDirectory.fd,
        path.basename(targetPath),
        staged.bytes,
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "exists") return false;
      throw new AttachmentPublishCapabilityError(classifyPublishCapabilityFailure(error));
    }
    const installed = await readContainedFileAt(targetDirectory, path.basename(targetPath));
    if (!installed || installed.revision !== staged.revision) return false;
    return true;
  } finally {
    await targetDirectory.close();
    await stagedDirectory.close();
  }
}

export interface ContainedRemovalHooks {
  afterValidation?: () => Promise<void>;
  afterClaim?: () => Promise<void>;
  /** Barrier immediately after final claim validation and before cleanup. */
  beforeCleanup?: () => Promise<void>;
  /** Private, app-owned directory where claimed bytes remain recoverable. */
  retentionDirectory?: string;
  /** Whether the claimed name is an app-private generated stage or vault state. */
  claimAuthority?: "private" | "vault";
  /** Portable private writers may clean an exact claim under their documented threat model. */
  cleanupClaim?: boolean;
}

/**
 * Atomically claims a name into a same-directory quarantine before deciding
 * whether it is safe to retire. A replacement that wins before the claim is
 * moved into quarantine, verified as a different revision, and recreated at
 * the original name with exclusive create. A replacement that appears after
 * the claim remains at the original name while the claimed expected bytes are
 * retained through the explicit evidence hook or left as recoverable residue.
 * In neither window is a winner or an uncertain generation unlinked by name.
 */
export async function removeExpectedContainedFile(
  filePath: string,
  expectedRevision: string,
  hooks: ContainedRemovalHooks = {},
): Promise<boolean> {
  return removeExpectedContainedFileInternal(filePath, expectedRevision, {
    ...hooks,
    // Strict callers operate on user-vault paths by default. A caller must
    // explicitly name a private app-owned stage before cleanup is allowed.
    claimAuthority: hooks.claimAuthority ?? "vault",
    cleanupClaim: hooks.cleanupClaim ?? false,
  });
}

async function removeExpectedContainedFileInternal(
  filePath: string,
  expectedRevision: string,
  hooks: ContainedRemovalHooks,
  existingDirectory?: ContainedDirectory,
): Promise<boolean> {
  const directory = existingDirectory ?? (await openContainedDirectory(path.dirname(filePath)));
  const ownsDirectory = !existingDirectory;
  const sourceName = path.basename(filePath);
  const quarantineName = path.basename(claimQuarantinePath(filePath));
  try {
    const current = await readContainedFileAt(directory, sourceName);
    if (!current || current.revision !== expectedRevision) return false;
    await hooks.afterValidation?.();

    try {
      await renameContainedAt(directory, sourceName, quarantineName);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "missing" || error.code === "exists" || error.code === "ENOENT")
      ) {
        return false;
      }
      throw error;
    }

    let claimed = await readContainedFileAt(directory, quarantineName);
    try {
      await hooks.afterClaim?.();
    } catch (error) {
      const claimAfterFailure = await readContainedFileAt(directory, quarantineName);
      const sourceAfterFailure = await readContainedFileAt(directory, sourceName);
      if (claimAfterFailure) {
        if (!sourceAfterFailure) {
          try {
            await createContainedFileAt(directory, sourceName, claimAfterFailure.bytes);
          } catch (restoreError) {
            if (
              !(
                restoreError instanceof Error &&
                "code" in restoreError &&
                (restoreError.code === "EEXIST" || restoreError.code === "exists")
              )
            ) {
              throw restoreError;
            }
          }
        }
        await settleContainedClaim(directory, quarantineName, expectedRevision, hooks);
      }
      throw error;
    }

    if (!claimed || claimed.revision !== expectedRevision) {
      if (claimed) {
        if (!(await readContainedFileAt(directory, sourceName))) {
          try {
            await createContainedFileAt(directory, sourceName, claimed.bytes);
          } catch (error) {
            if (
              !(
                error instanceof Error &&
                "code" in error &&
                (error.code === "EEXIST" || error.code === "exists")
              )
            ) {
              throw error;
            }
          }
        }
        await settleContainedClaim(directory, quarantineName, expectedRevision, hooks);
      }
      return false;
    }

    const sourceAfterClaim = await readContainedFileAt(directory, sourceName);
    claimed = await readContainedFileAt(directory, quarantineName);
    if (sourceAfterClaim || !claimed || claimed.revision !== expectedRevision) {
      if (claimed) {
        if (!sourceAfterClaim) {
          try {
            await createContainedFileAt(directory, sourceName, claimed.bytes);
          } catch (error) {
            if (
              !(
                error instanceof Error &&
                "code" in error &&
                (error.code === "EEXIST" || error.code === "exists")
              )
            ) {
              throw error;
            }
          }
        }
        await settleContainedClaim(directory, quarantineName, expectedRevision, hooks);
      }
      return false;
    }

    // The claim is ours, and its bytes were revalidated through the held
    // parent descriptor. Strict callers either retain it in an explicit
    // private evidence directory or leave it recoverable beside the source.
    const settled = await settleContainedClaim(directory, quarantineName, expectedRevision, hooks);
    return settled;
  } finally {
    if (ownsDirectory) await directory.close();
  }
}

/**
 * Cross-platform claim-then-verify removal for ordinary private writers. It
 * avoids unlinking a name after a separate validation read while retaining the
 * existing cross-platform writer implementation. An unchanged generated
 * claim is cleaned immediately; only an uncertain replacement remains as
 * recoverable residue. Attachment transactions use the descriptor-relative
 * variant above so ancestor replacement is covered as well.
 */
export async function removeExpectedFilePortably(
  filePath: string,
  expectedRevision: string,
  hooks: ContainedRemovalHooks = {},
): Promise<boolean> {
  const removalHooks: ContainedRemovalHooks = {
    ...hooks,
    claimAuthority: hooks.claimAuthority ?? "private",
    cleanupClaim: hooks.cleanupClaim ?? true,
  };
  const current = await readStableFile(filePath);
  if (!current || current.revision !== expectedRevision) return false;
  await removalHooks.afterValidation?.();

  const quarantine = claimQuarantinePath(filePath);
  try {
    await fs.rename(filePath, quarantine);
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }

  const claimed = await readStableFile(quarantine);
  try {
    await removalHooks.afterClaim?.();
  } catch (error) {
    const claimedAfterFailure = await readStableFile(quarantine);
    if (claimedAfterFailure) {
      const sourceAfterFailure = await readStableFile(filePath);
      if (!sourceAfterFailure) {
        try {
          await durableCreate(filePath, claimedAfterFailure.bytes);
        } catch (cleanupError) {
          if (
            !(
              cleanupError instanceof Error &&
              "code" in cleanupError &&
              cleanupError.code === "EEXIST"
            )
          ) {
            throw cleanupError;
          }
        }
      }
      await settlePortableClaim(quarantine, expectedRevision, removalHooks);
    }
    throw error;
  }
  if (!claimed || claimed.revision !== expectedRevision) {
    if (claimed) {
      if (!(await readStableFile(filePath))) {
        try {
          await durableCreate(filePath, claimed.bytes);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        }
      }
      await settlePortableClaim(quarantine, expectedRevision, removalHooks);
    }
    return false;
  }

  const sourceAfterClaim = await readStableFile(filePath);
  const claimAfterHook = await readStableFile(quarantine);
  if (sourceAfterClaim || !claimAfterHook || claimAfterHook.revision !== expectedRevision) {
    if (claimAfterHook) {
      if (!sourceAfterClaim) {
        try {
          await durableCreate(filePath, claimAfterHook.bytes);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        }
      }
      await settlePortableClaim(quarantine, expectedRevision, removalHooks);
    }
    return false;
  }

  const settled = await settlePortableClaim(quarantine, expectedRevision, removalHooks);
  return settled;
}

async function retainPortableClaim(
  quarantinePath: string,
  retentionDirectory: string | undefined,
): Promise<boolean> {
  if (!retentionDirectory) return true;
  await fs.mkdir(retentionDirectory, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const retainedPath = path.join(retentionDirectory, `.threadleaf-retained-${randomUUID()}.bin`);
    try {
      await fs.rename(quarantinePath, retainedPath);
      await syncDirectory(path.dirname(quarantinePath));
      await syncDirectory(retentionDirectory);
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EXDEV") {
        const claimed = await readStableFile(quarantinePath);
        if (!claimed) return false;
        await durableCreate(retainedPath, claimed.bytes);
        const retained = await readStableFile(retainedPath);
        if (!retained || retained.revision !== claimed.revision) {
          throw new Error("Cross-device portable claim retention verification failed.");
        }
        const stillClaimed = await readStableFile(quarantinePath);
        if (!stillClaimed || stillClaimed.revision !== claimed.revision) {
          return false;
        }
        // There is no portable generation-conditional unlink. This claim
        // originated in a user-vault directory, so preserve it after an
        // EXDEV copy rather than risking deletion of a same-UID replacement
        // that wins between the final read and unlink. The false result is
        // an explicit recoverable conflict, not a successful cleanup.
        return false;
      }
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return false;
      }
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  }
  throw new Error("Could not reserve a private claim-retention name.");
}

async function settlePortableClaim(
  quarantinePath: string,
  expectedRevision: string,
  hooks: ContainedRemovalHooks,
): Promise<boolean> {
  const claim = await readStableFile(quarantinePath);
  // Leave a changed claimant as evidence; only an exact re-read authorizes
  // cleanup of this generated quarantine name.
  if (!claim || claim.revision !== expectedRevision) return false;
  // Keep an explicit barrier between final validation and the cleanup
  // attempt. The post-barrier re-read catches a claimant injected at this
  // boundary; a same-UID process can still race the unlink syscall itself.
  await hooks.beforeCleanup?.();
  const afterBarrier = await readStableFile(quarantinePath);
  if (!afterBarrier || afterBarrier.revision !== expectedRevision) return false;
  if (hooks.retentionDirectory) {
    return retainPortableClaim(quarantinePath, hooks.retentionDirectory);
  }
  if (hooks.claimAuthority !== "private" || !hooks.cleanupClaim) return false;
  try {
    await fs.unlink(quarantinePath);
    await syncDirectory(path.dirname(quarantinePath));
    return true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
    return false;
  }
}

export async function removeIfPresent(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (
      !(
        process.platform === "win32" &&
        error instanceof Error &&
        "code" in error &&
        (error.code === "EISDIR" || error.code === "EPERM" || error.code === "EINVAL")
      )
    ) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}
