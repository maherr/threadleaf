import path from "node:path";

import { loadThreadleafNativeBindingForInternalUse } from "../private-state-lock/index.js";

export type NativeFilesystemCode =
  | "cross-device"
  | "exists"
  | "invalid"
  | "io"
  | "missing"
  | "unsupported";

export class NativeFilesystemError extends Error {
  readonly code: NativeFilesystemCode;

  constructor(code: NativeFilesystemCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "NativeFilesystemError";
    this.code = code;
  }
}

function assertPathInput(filePath: string): void {
  if (
    typeof filePath !== "string" ||
    filePath.length === 0 ||
    filePath.length > 32_768 ||
    filePath.includes("\u0000") ||
    !path.isAbsolute(filePath)
  ) {
    throw new NativeFilesystemError(
      "invalid",
      "Native filesystem paths must be absolute and contain no NUL bytes.",
    );
  }
}

function nativeCode(error: unknown): NativeFilesystemCode {
  if (!error || typeof error !== "object") return "io";
  const code = (error as { code?: unknown }).code;
  return code === "cross-device" ||
    code === "exists" ||
    code === "invalid" ||
    code === "io" ||
    code === "missing" ||
    code === "unsupported"
    ? code
    : "io";
}

function nativeFilesystemBinding() {
  try {
    return loadThreadleafNativeBindingForInternalUse();
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Threadleaf's native filesystem binding is unavailable.";
    throw new NativeFilesystemError(nativeCode(error), message, { cause: error });
  }
}

/** Proves that this runtime can attempt an atomic no-clobber rename. */
export function assertRenameNoReplaceAvailable(): void {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new NativeFilesystemError(
      "unsupported",
      "Atomic no-clobber rename is unavailable on this platform.",
    );
  }
  nativeFilesystemBinding();
}

/** Proves that this runtime can attempt strict no-clobber publication. */
export function assertAnonymousPublishAvailable(): void {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new NativeFilesystemError(
      "unsupported",
      "Strict no-clobber publication is unavailable on this platform.",
    );
  }
  nativeFilesystemBinding();
}

/**
 * Probes anonymous-inode create/write/durability on one held target
 * directory without linking or creating any pathname.
 */
export function probeAnonymousPublishNoName(targetDirectoryFd: number): void {
  if (
    !Number.isSafeInteger(targetDirectoryFd) ||
    targetDirectoryFd < 0 ||
    targetDirectoryFd > 0x7fffffff
  ) {
    throw new NativeFilesystemError(
      "invalid",
      "Anonymous publication probing requires an open directory descriptor.",
    );
  }
  assertAnonymousPublishAvailable();
  try {
    nativeFilesystemBinding().probeAnonymousPublishNoName(targetDirectoryFd);
  } catch (error) {
    if (error instanceof NativeFilesystemError) throw error;
    const message =
      error instanceof Error ? error.message : "Anonymous publication probe did not complete.";
    throw new NativeFilesystemError(nativeCode(error), message, { cause: error });
  }
}

/** Atomically move source to an absent target without replacing a claimant. */
export function renameNoReplace(sourcePath: string, targetPath: string): void {
  assertPathInput(sourcePath);
  assertPathInput(targetPath);
  assertRenameNoReplaceAvailable();
  try {
    nativeFilesystemBinding().renameNoReplace(sourcePath, targetPath);
  } catch (error) {
    if (error instanceof NativeFilesystemError) throw error;
    const message =
      error instanceof Error ? error.message : "Native no-clobber rename did not complete.";
    throw new NativeFilesystemError(nativeCode(error), message, { cause: error });
  }
}

function assertDescriptor(value: number, operation: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x7fffffff) {
    throw new NativeFilesystemError("invalid", `${operation} requires an open descriptor.`);
  }
}

function assertBasename(value: string, operation: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 32_768 ||
    value.includes("\u0000") ||
    value === "." ||
    value === ".." ||
    value.includes("/")
  ) {
    throw new NativeFilesystemError("invalid", `${operation} requires one safe basename.`);
  }
}

/** Open one real child directory relative to a held parent descriptor. */
export function openDirectoryNoFollowAt(parentDirectoryFd: number, name: string): number {
  assertDescriptor(parentDirectoryFd, "Contained directory open");
  assertBasename(name, "Contained directory open");
  try {
    return nativeFilesystemBinding().openDirectoryNoFollowAt(parentDirectoryFd, name);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Contained directory open failed.";
    throw new NativeFilesystemError(nativeCode(error), message, { cause: error });
  }
}

/** Open one non-symlink file relative to a held directory descriptor. */
export function openFileNoFollowAt(directoryFd: number, name: string, create: boolean): number {
  assertDescriptor(directoryFd, "Contained file open");
  assertBasename(name, "Contained file open");
  try {
    return nativeFilesystemBinding().openFileNoFollowAt(directoryFd, name, create);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Contained file open failed.";
    throw new NativeFilesystemError(nativeCode(error), message, { cause: error });
  }
}

/** Atomically rename one held-directory child without replacing a claimant. */
export function renameNoReplaceAt(
  sourceDirectoryFd: number,
  sourceName: string,
  targetDirectoryFd: number,
  targetName: string,
): void {
  assertDescriptor(sourceDirectoryFd, "Contained rename");
  assertDescriptor(targetDirectoryFd, "Contained rename");
  assertBasename(sourceName, "Contained rename");
  assertBasename(targetName, "Contained rename");
  assertRenameNoReplaceAvailable();
  try {
    nativeFilesystemBinding().renameNoReplaceAt(
      sourceDirectoryFd,
      sourceName,
      targetDirectoryFd,
      targetName,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Contained rename failed.";
    throw new NativeFilesystemError(nativeCode(error), message, { cause: error });
  }
}

/** Atomically publish exact bytes from an unnamed inode at an absent basename. */
export function publishBufferNoReplace(
  targetDirectoryFd: number,
  targetName: string,
  bytes: Buffer,
): void {
  if (
    !Number.isSafeInteger(targetDirectoryFd) ||
    targetDirectoryFd < 0 ||
    targetDirectoryFd > 0x7fffffff
  ) {
    throw new NativeFilesystemError(
      "invalid",
      "Anonymous publication requires an open directory descriptor.",
    );
  }
  if (
    typeof targetName !== "string" ||
    targetName.length === 0 ||
    targetName === "." ||
    targetName === ".." ||
    targetName.includes("/") ||
    targetName.includes("\u0000")
  ) {
    throw new NativeFilesystemError(
      "invalid",
      "Anonymous publication requires one non-empty target basename.",
    );
  }
  if (!Buffer.isBuffer(bytes)) {
    throw new NativeFilesystemError("invalid", "Anonymous publication content must be a Buffer.");
  }
  assertAnonymousPublishAvailable();
  try {
    nativeFilesystemBinding().publishBufferNoReplace(targetDirectoryFd, targetName, bytes);
  } catch (error) {
    if (error instanceof NativeFilesystemError) throw error;
    const message =
      error instanceof Error ? error.message : "Anonymous no-clobber publication failed.";
    throw new NativeFilesystemError(nativeCode(error), message, { cause: error });
  }
}
