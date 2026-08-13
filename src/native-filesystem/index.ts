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

/** Atomically move source to an absent target without replacing a claimant. */
export function renameNoReplace(sourcePath: string, targetPath: string): void {
  assertPathInput(sourcePath);
  assertPathInput(targetPath);
  try {
    loadThreadleafNativeBindingForInternalUse().renameNoReplace(sourcePath, targetPath);
  } catch (error) {
    if (error instanceof NativeFilesystemError) throw error;
    const message =
      error instanceof Error ? error.message : "Native no-clobber rename did not complete.";
    throw new NativeFilesystemError(nativeCode(error), message, { cause: error });
  }
}
