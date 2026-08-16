import { promises as fs } from "node:fs";
import { readStableFileWithinLimit } from "../kernel/durability";
import {
  hasHiddenVaultSegment,
  normalizeVaultPath,
  VaultPathError,
  VaultPathPolicy,
} from "../kernel/path-policy";
import type {
  VaultAttachmentNativeActionRequest,
  VaultAttachmentNativeActionResponse,
  VaultAttachmentNativeActionUnavailableReason,
} from "../shared/contracts";
import {
  DEFAULT_VAULT_ATTACHMENT_MAX_BYTES,
  isVaultAttachmentNativeOpenEligible,
  sniffVaultAttachment,
} from "./vault-attachment-service";

const revisionPattern = /^[a-f0-9]{64}$/u;

export interface VaultAttachmentShellPort {
  openPath(absolutePath: string): Promise<string>;
  showItemInFolder(absolutePath: string): void;
}

export interface VaultAttachmentNativeActionContext {
  readonly vaultId: string;
  readonly vaultPath: string;
  readonly maxBytes?: number;
  getActiveVault(): { vaultId: string; vaultPath: string };
}

function unavailable(
  vaultId: string,
  reason: VaultAttachmentNativeActionUnavailableReason,
  message: string,
): VaultAttachmentNativeActionResponse {
  return { status: "unavailable", vaultId, reason, message };
}

function staleIfChanged(
  context: VaultAttachmentNativeActionContext,
): Extract<VaultAttachmentNativeActionResponse, { status: "stale-vault" }> | null {
  const active = context.getActiveVault();
  return active.vaultId === context.vaultId && active.vaultPath === context.vaultPath
    ? null
    : { status: "stale-vault", vaultId: active.vaultId };
}

function readFailure(vaultId: string, error: unknown): VaultAttachmentNativeActionResponse {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    return unavailable(vaultId, "missing", "The attachment no longer exists.");
  }
  if (error instanceof VaultPathError) {
    return /outside|escape/iu.test(error.message)
      ? unavailable(vaultId, "outside-vault", "The attachment resolves outside the active vault.")
      : unavailable(vaultId, "invalid", "The attachment path is invalid.");
  }
  return unavailable(vaultId, "unreadable", "The attachment could not be read safely.");
}

/**
 * Revalidates a renderer card at the main-process boundary and dispatches only
 * a canonical, contained file path. The revision read is a bounded preflight,
 * not an atomic lock against an unrelated writer replacing the file after it.
 */
export async function performVaultAttachmentNativeAction(
  context: VaultAttachmentNativeActionContext,
  request: VaultAttachmentNativeActionRequest,
  shell: VaultAttachmentShellPort,
): Promise<VaultAttachmentNativeActionResponse> {
  if (request.expectedVaultId !== context.vaultId) {
    return { status: "stale-vault", vaultId: context.vaultId };
  }
  const initiallyStale = staleIfChanged(context);
  if (initiallyStale) return initiallyStale;
  if (!revisionPattern.test(request.expectedRevision)) {
    return unavailable(context.vaultId, "invalid", "The attachment revision is invalid.");
  }

  let normalizedPath: string;
  try {
    normalizedPath = normalizeVaultPath(request.path);
  } catch {
    return unavailable(context.vaultId, "invalid", "The attachment path is invalid.");
  }
  if (normalizedPath !== request.path) {
    return unavailable(context.vaultId, "invalid", "The attachment path is not canonical.");
  }
  if (hasHiddenVaultSegment(normalizedPath)) {
    return unavailable(context.vaultId, "private", "Hidden and private paths cannot be opened.");
  }

  let policy: VaultPathPolicy;
  let absolutePath: string;
  let canonicalPath: string;
  try {
    policy = await VaultPathPolicy.open(context.vaultPath);
    absolutePath = await policy.resolveForRead(normalizedPath);
    canonicalPath = policy.toVaultPath(absolutePath);
  } catch (error) {
    return readFailure(context.vaultId, error);
  }
  if (hasHiddenVaultSegment(canonicalPath)) {
    return unavailable(context.vaultId, "private", "Hidden and private paths cannot be opened.");
  }

  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) {
      return unavailable(context.vaultId, "not-file", "The attachment target is not a file.");
    }
  } catch (error) {
    return readFailure(context.vaultId, error);
  }

  let read: Awaited<ReturnType<typeof readStableFileWithinLimit>>;
  try {
    read = await readStableFileWithinLimit(
      absolutePath,
      context.maxBytes ?? DEFAULT_VAULT_ATTACHMENT_MAX_BYTES,
    );
  } catch (error) {
    return readFailure(context.vaultId, error);
  }
  if (!read) {
    return unavailable(context.vaultId, "missing", "The attachment no longer exists.");
  }
  if (read.status === "too-large") {
    return unavailable(
      context.vaultId,
      "too-large",
      "The attachment is larger than the bounded native-action limit.",
    );
  }
  if (read.snapshot.revision !== request.expectedRevision) {
    return unavailable(
      context.vaultId,
      "stale-revision",
      "The attachment changed after this card was loaded. Refresh Reading view and try again.",
    );
  }
  const detected = request.action === "open" ? sniffVaultAttachment(read.snapshot.bytes) : null;
  if (
    request.action === "open" &&
    (!isVaultAttachmentNativeOpenEligible(normalizedPath, detected) ||
      !isVaultAttachmentNativeOpenEligible(canonicalPath, detected))
  ) {
    return unavailable(
      context.vaultId,
      "unsupported",
      "This attachment can be revealed, but its bytes and filename are not approved for native Open.",
    );
  }

  const finallyStale = staleIfChanged(context);
  if (finallyStale) return finallyStale;
  if (request.action === "open") {
    try {
      const error = await shell.openPath(absolutePath);
      return error === ""
        ? { status: "opened", vaultId: context.vaultId, path: normalizedPath }
        : unavailable(
            context.vaultId,
            "native-failed",
            "The operating system could not open this attachment.",
          );
    } catch {
      return unavailable(
        context.vaultId,
        "native-failed",
        "The operating system could not open this attachment.",
      );
    }
  }

  try {
    shell.showItemInFolder(absolutePath);
    return { status: "reveal-dispatched", vaultId: context.vaultId, path: normalizedPath };
  } catch {
    return unavailable(
      context.vaultId,
      "native-failed",
      "The operating system could not reveal this attachment.",
    );
  }
}
