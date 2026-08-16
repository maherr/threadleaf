import {
  hasHiddenVaultSegment,
  hasPrivateVaultSegment,
  normalizeVaultPath,
  VaultPathError,
} from "../kernel/path-policy";
import type { BinaryReadResult } from "../kernel/vault-kernel";
import type {
  VaultAttachmentKind,
  VaultFilePreviewResponse,
  VaultFilePreviewUnavailableReason,
} from "../shared/contracts";
import { sniffVaultAttachment } from "./vault-attachment-service";

export const DEFAULT_VAULT_FILE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
export const MAX_VAULT_FILE_PREVIEW_TEXT_BYTES = 64 * 1024;
const maxPathLength = 4_096;

export interface VaultFilePreviewReader {
  readonly vaultId: string;
  resolveReadPath(relativePath: string): Promise<string>;
  readBinary(relativePath: string, maxBytes: number): Promise<BinaryReadResult>;
}

export interface VaultFilePreviewLoadOptions {
  /** The current physical inventory, expressed as normalized visible paths. */
  visiblePaths: readonly string[];
  /** The generation the caller used when it selected the path. */
  expectedInventoryGeneration?: string;
  /** The generation represented by `visiblePaths`. */
  inventoryGeneration?: string;
}

type FilePreviewPolicyReason = Extract<VaultFilePreviewUnavailableReason, "private" | "document">;

function unavailable(
  vaultId: string,
  reason: VaultFilePreviewUnavailableReason,
  message: string,
  pathValue?: string,
  size?: number,
): VaultFilePreviewResponse {
  return {
    status: "unavailable",
    vaultId,
    reason,
    message,
    ...(pathValue === undefined ? {} : { path: pathValue }),
    ...(size === undefined ? {} : { size }),
  };
}

function errorCode(error: unknown): string | null {
  if (!(error instanceof Error) || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function unavailableFromReadError(
  vaultId: string,
  error: unknown,
  pathValue: string,
): VaultFilePreviewResponse {
  if (errorCode(error) === "ENOENT") {
    return unavailable(vaultId, "missing", "The ordinary file no longer exists.", pathValue);
  }
  if (error instanceof VaultPathError) {
    const outside = /outside|escape|traversal|relative/iu.test(error.message);
    return unavailable(
      vaultId,
      outside ? "outside-vault" : "invalid",
      outside
        ? "The ordinary file resolves outside the active vault."
        : "The ordinary file path is invalid.",
      pathValue,
    );
  }
  return unavailable(
    vaultId,
    "unreadable",
    "The ordinary file could not be read safely.",
    pathValue,
  );
}

function policyReason(relativePath: string): FilePreviewPolicyReason | null {
  if (hasPrivateVaultSegment(relativePath) || hasHiddenVaultSegment(relativePath)) {
    return "private";
  }
  const folded = relativePath.toLocaleLowerCase("en-US");
  if (folded.endsWith(".md") || folded.endsWith(".canvas")) return "document";
  return null;
}

function policyMessage(reason: FilePreviewPolicyReason): string {
  return reason === "private"
    ? "Private and hidden application paths are never exposed as file previews."
    : "Markdown and JSON Canvas documents use their own document surfaces.";
}

function normalizeRequestedPath(
  rawPath: string,
):
  | { status: "ready"; path: string }
  | { status: "unavailable"; reason: "invalid" | "outside-vault"; message: string } {
  if (rawPath.length > maxPathLength) {
    return {
      status: "unavailable",
      reason: "invalid",
      message: "The ordinary file path is too long.",
    };
  }
  try {
    return { status: "ready", path: normalizeVaultPath(rawPath) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const outside = /outside|escape|traversal|relative/iu.test(message);
    return {
      status: "unavailable",
      reason: outside ? "outside-vault" : "invalid",
      message: outside
        ? "The ordinary file path leaves the active vault."
        : "The ordinary file path is invalid.",
    };
  }
}

function exactVisiblePathSet(visiblePaths: readonly string[]): Set<string> {
  const normalized = new Set<string>();
  for (const visiblePath of visiblePaths) {
    try {
      normalized.add(normalizeVaultPath(visiblePath));
    } catch {
      // A malformed injected inventory entry cannot authorize a read.
    }
  }
  return normalized;
}

function decodeUtf8NoNul(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function trimUtf8Preview(bytes: Uint8Array): { text: string; truncated: boolean } {
  let end = Math.min(bytes.byteLength, MAX_VAULT_FILE_PREVIEW_TEXT_BYTES);
  let text = "";
  while (end >= 0) {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
      break;
    } catch {
      end -= 1;
    }
  }
  return { text, truncated: end < bytes.byteLength };
}

function metadataResponse(
  vaultId: string,
  pathValue: string,
  size: number,
  revision: string,
  kind: VaultAttachmentKind,
  mimeType: string | null,
): VaultFilePreviewResponse {
  if (kind === "image" || kind === "text") {
    return unavailable(
      vaultId,
      "unreadable",
      "The ordinary file did not produce a safe preview.",
      pathValue,
      size,
    );
  }
  return {
    status: "ready",
    vaultId,
    path: pathValue,
    kind,
    mimeType,
    preview: "metadata",
    size,
    revision,
  };
}

export async function loadVaultFilePreview(
  reader: VaultFilePreviewReader,
  rawPath: string,
  expectedVaultId: string,
  options: VaultFilePreviewLoadOptions,
): Promise<VaultFilePreviewResponse> {
  if (expectedVaultId !== reader.vaultId) {
    return { status: "stale-vault", vaultId: reader.vaultId };
  }

  const normalized = normalizeRequestedPath(rawPath);
  if (normalized.status === "unavailable") {
    return unavailable(reader.vaultId, normalized.reason, normalized.message);
  }
  const requestedPath = normalized.path;
  const requestedPolicyReason = policyReason(requestedPath);
  if (requestedPolicyReason) {
    return unavailable(
      reader.vaultId,
      requestedPolicyReason,
      policyMessage(requestedPolicyReason),
      requestedPath,
    );
  }

  if (
    options.expectedInventoryGeneration !== undefined &&
    options.expectedInventoryGeneration !== options.inventoryGeneration
  ) {
    return unavailable(
      reader.vaultId,
      "stale-inventory",
      "The Files inventory changed before this preview could be opened.",
      requestedPath,
    );
  }

  if (!exactVisiblePathSet(options.visiblePaths).has(requestedPath)) {
    return unavailable(
      reader.vaultId,
      "not-visible",
      "The ordinary file is not present in the current visible-vault inventory.",
      requestedPath,
    );
  }

  let canonicalPath: string;
  try {
    canonicalPath = normalizeVaultPath(await reader.resolveReadPath(requestedPath));
  } catch (error) {
    return unavailableFromReadError(reader.vaultId, error, requestedPath);
  }
  const canonicalPolicyReason = policyReason(canonicalPath);
  if (canonicalPolicyReason) {
    return unavailable(
      reader.vaultId,
      canonicalPolicyReason,
      policyMessage(canonicalPolicyReason),
      requestedPath,
    );
  }

  let result: BinaryReadResult;
  try {
    result = await reader.readBinary(canonicalPath, DEFAULT_VAULT_FILE_PREVIEW_MAX_BYTES);
  } catch (error) {
    return unavailableFromReadError(reader.vaultId, error, requestedPath);
  }
  if (expectedVaultId !== reader.vaultId) {
    return { status: "stale-vault", vaultId: reader.vaultId };
  }
  if (result.status === "too-large") {
    return unavailable(
      reader.vaultId,
      "too-large",
      "The ordinary file is larger than the 10 MiB preview limit.",
      requestedPath,
      result.size,
    );
  }

  const { snapshot } = result;
  const sniffed = sniffVaultAttachment(snapshot.bytes);
  if (sniffed?.kind === "image") {
    return {
      status: "ready",
      vaultId: reader.vaultId,
      path: requestedPath,
      kind: "image",
      mimeType: sniffed.mimeType,
      preview: "image",
      size: snapshot.size,
      revision: snapshot.revision,
      base64: snapshot.bytes.toString("base64"),
    };
  }

  if (sniffed && sniffed.kind !== "text") {
    return metadataResponse(
      reader.vaultId,
      requestedPath,
      snapshot.size,
      snapshot.revision,
      sniffed.kind,
      sniffed.mimeType,
    );
  }

  const text = decodeUtf8NoNul(snapshot.bytes);
  if (text !== null) {
    const bounded = trimUtf8Preview(snapshot.bytes);
    return {
      status: "ready",
      vaultId: reader.vaultId,
      path: requestedPath,
      kind: "text",
      mimeType: "text/plain",
      preview: "text",
      size: snapshot.size,
      revision: snapshot.revision,
      text: bounded.text,
      truncated: bounded.truncated,
    };
  }

  return metadataResponse(
    reader.vaultId,
    requestedPath,
    snapshot.size,
    snapshot.revision,
    sniffed?.kind ?? "unsupported",
    sniffed?.mimeType ?? null,
  );
}
