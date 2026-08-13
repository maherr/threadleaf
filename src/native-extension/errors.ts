import type { NativeExtensionCapabilityId } from "./manifest";

export const nativeExtensionErrorCodes = [
  "invalid-manifest",
  "invalid-request",
  "not-installed",
  "grant-required",
  "stale-grant",
  "capability-denied",
  "capability-unavailable",
  "undeclared-capability",
  "cross-vault",
  "safe-mode",
  "revoked",
  "runtime-unavailable",
  "timeout",
  "teardown",
  "extension-failed",
  "host-closed",
] as const;

export type NativeExtensionErrorCode = (typeof nativeExtensionErrorCodes)[number];

export interface NativeExtensionErrorDetails {
  capability?: NativeExtensionCapabilityId;
  operation?: string;
  vaultId?: string;
}

/** Stable machine-readable failure for SDK and host callers. */
export class NativeExtensionError extends Error {
  readonly code: NativeExtensionErrorCode;
  readonly capability: NativeExtensionCapabilityId | null;
  readonly operation: string | null;
  readonly vaultId: string | null;

  constructor(
    code: NativeExtensionErrorCode,
    message: string,
    details: NativeExtensionErrorDetails = {},
  ) {
    super(message);
    this.name = "NativeExtensionError";
    this.code = code;
    this.capability = details.capability ?? null;
    this.operation = details.operation ?? null;
    this.vaultId = details.vaultId ?? null;
  }
}

export function isNativeExtensionError(value: unknown): value is NativeExtensionError {
  return value instanceof NativeExtensionError;
}

export function nativeExtensionError(
  code: NativeExtensionErrorCode,
  message: string,
  details: NativeExtensionErrorDetails = {},
): NativeExtensionError {
  return new NativeExtensionError(code, message, details);
}
