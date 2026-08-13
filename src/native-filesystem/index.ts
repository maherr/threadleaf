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

/** Proves that this runtime can attempt Linux's atomic no-clobber rename. */
export function assertRenameNoReplaceAvailable(): void {
  if (process.platform !== "linux") {
    throw new NativeFilesystemError(
      "unsupported",
      "Atomic no-clobber rename is currently available only on Linux.",
    );
  }
  nativeFilesystemBinding();
}

/** Proves that this runtime can attempt Linux anonymous-inode publication. */
export function assertAnonymousPublishAvailable(): void {
  if (process.platform !== "linux") {
    throw new NativeFilesystemError(
      "unsupported",
      "Anonymous no-clobber publication is currently available only on Linux.",
    );
  }
  nativeFilesystemBinding();
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
