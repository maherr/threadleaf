import path from "node:path";
import { normalizeVaultPath, VaultPathError } from "../kernel/path-policy";
import type { BinaryReadResult } from "../kernel/vault-kernel";
import type {
  CanvasAttachmentMimeType,
  CanvasAttachmentResponse,
  CanvasAttachmentUnavailableReason,
} from "../shared/contracts";
import { sniffVaultImageMime } from "./vault-image-service";

export const DEFAULT_CANVAS_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const MAX_CANVAS_ATTACHMENT_TEXT_BYTES = 64 * 1024;
const maxTargetLength = 4_096;

export interface CanvasAttachmentReader {
  readonly vaultId: string;
  resolveReadPath(relativePath: string): Promise<string>;
  readBinary(relativePath: string, maxBytes: number): Promise<BinaryReadResult>;
}

type AttachmentTargetResolution =
  | { status: "resolved"; path: string }
  | {
      status: "rejected";
      reason: CanvasAttachmentUnavailableReason;
      message: string;
    };

function isPrivateVaultPath(relativePath: string): boolean {
  return relativePath.split("/").some((segment) => {
    const folded = segment.toLocaleLowerCase("en-US");
    return (
      folded === ".obsidian" ||
      folded === ".git" ||
      folded === ".trash" ||
      folded.startsWith(".threadleaf-")
    );
  });
}

function stripAngleBrackets(target: string): string {
  return target.startsWith("<") && target.endsWith(">") ? target.slice(1, -1).trim() : target;
}

export function resolveCanvasAttachmentTarget(
  sourceCanvasPath: string,
  rawTarget: string,
): AttachmentTargetResolution {
  let sourcePath: string;
  try {
    sourcePath = normalizeVaultPath(sourceCanvasPath);
  } catch {
    return {
      status: "rejected",
      reason: "invalid",
      message: "The source canvas path is not a valid vault path.",
    };
  }
  if (!sourcePath.toLocaleLowerCase("en-US").endsWith(".canvas")) {
    return {
      status: "rejected",
      reason: "invalid",
      message: "Canvas attachments must be requested from a JSON Canvas file.",
    };
  }
  const trimmed = stripAngleBrackets(rawTarget.trim());
  if (!trimmed || trimmed.length > maxTargetLength || trimmed.includes("\0")) {
    return {
      status: "rejected",
      reason: "invalid",
      message: "The attachment target is empty, malformed, or too long.",
    };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) {
    return {
      status: "rejected",
      reason: "external",
      message: "External canvas attachments remain disabled.",
    };
  }
  const delimiterAt = [trimmed.indexOf("?"), trimmed.indexOf("#")]
    .filter((index) => index >= 0)
    .reduce((lowest, index) => Math.min(lowest, index), trimmed.length);
  const encodedPath = trimmed.slice(0, delimiterAt);
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(encodedPath).replaceAll("\\", "/");
  } catch {
    return {
      status: "rejected",
      reason: "invalid",
      message: "The attachment target contains invalid URL encoding.",
    };
  }
  if (!decodedPath || decodedPath.includes("\0") || /^[a-z]:\//i.test(decodedPath)) {
    return {
      status: "rejected",
      reason: "invalid",
      message: "The attachment target is not a portable vault path.",
    };
  }
  // JSON Canvas file nodes are vault-root-relative by contract. Keep an
  // explicit ./ or ../ escape as a narrowly-scoped convenience for hand-made
  // files, while still passing it through the vault path policy.
  const rooted = decodedPath.startsWith("/");
  const sourceRelative =
    decodedPath === "." ||
    decodedPath === ".." ||
    decodedPath.startsWith("./") ||
    decodedPath.startsWith("../");
  const candidate =
    rooted || !sourceRelative
      ? decodedPath.replace(/^\/+/, "")
      : path.posix.join(path.posix.dirname(sourcePath), decodedPath);
  let resolvedPath: string;
  try {
    resolvedPath = normalizeVaultPath(candidate);
  } catch {
    return {
      status: "rejected",
      reason: "outside-vault",
      message: "The attachment target leaves the active vault.",
    };
  }
  if (isPrivateVaultPath(resolvedPath)) {
    return {
      status: "rejected",
      reason: "private",
      message: "Application configuration and transaction files are never rendered.",
    };
  }
  return { status: "resolved", path: resolvedPath };
}

function sniffPdf(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-";
}

function isUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) {
    return false;
  }
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return !decoded.includes("\ufffd");
  } catch {
    return false;
  }
}

export function sniffCanvasAttachmentMime(bytes: Uint8Array): {
  mimeType: CanvasAttachmentMimeType;
  preview: "image" | "text" | "binary";
} {
  const imageMime = sniffVaultImageMime(bytes);
  if (imageMime) {
    return { mimeType: imageMime, preview: "image" };
  }
  if (sniffPdf(bytes)) {
    return { mimeType: "application/pdf", preview: "binary" };
  }
  if (isUtf8Text(bytes)) {
    return { mimeType: "text/plain", preview: "text" };
  }
  return { mimeType: "application/octet-stream", preview: "binary" };
}

function unavailable(
  vaultId: string,
  reason: CanvasAttachmentUnavailableReason,
  message: string,
): CanvasAttachmentResponse {
  return { status: "unavailable", vaultId, reason, message };
}

function unavailableFromReadError(vaultId: string, error: unknown): CanvasAttachmentResponse {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    return unavailable(vaultId, "missing", "The attachment no longer exists.");
  }
  if (error instanceof VaultPathError) {
    const outside = /outside|escape/i.test(error.message);
    return unavailable(
      vaultId,
      outside ? "outside-vault" : "invalid",
      outside
        ? "The attachment resolves outside the active vault."
        : "The attachment path is invalid.",
    );
  }
  return unavailable(vaultId, "unreadable", "The attachment could not be read safely.");
}

export interface CanvasAttachmentLoadOptions {
  maxBytes?: number;
}

export async function loadCanvasAttachment(
  reader: CanvasAttachmentReader,
  sourceCanvasPath: string,
  rawTarget: string,
  expectedVaultId: string,
  options: CanvasAttachmentLoadOptions = {},
): Promise<CanvasAttachmentResponse> {
  if (reader.vaultId !== expectedVaultId) {
    return { status: "stale-vault", vaultId: reader.vaultId };
  }
  const resolution = resolveCanvasAttachmentTarget(sourceCanvasPath, rawTarget);
  if (resolution.status === "rejected") {
    return unavailable(reader.vaultId, resolution.reason, resolution.message);
  }
  const maxBytes = Number.isFinite(options.maxBytes)
    ? Math.min(
        Math.max(Math.floor(options.maxBytes as number), 1),
        DEFAULT_CANVAS_ATTACHMENT_MAX_BYTES,
      )
    : DEFAULT_CANVAS_ATTACHMENT_MAX_BYTES;
  let canonicalPath: string;
  try {
    canonicalPath = await reader.resolveReadPath(resolution.path);
  } catch (error) {
    return unavailableFromReadError(reader.vaultId, error);
  }
  if (isPrivateVaultPath(canonicalPath)) {
    return unavailable(reader.vaultId, "private", "Private application files are never rendered.");
  }
  let result: BinaryReadResult;
  try {
    result = await reader.readBinary(canonicalPath, maxBytes);
  } catch (error) {
    return unavailableFromReadError(reader.vaultId, error);
  }
  if (reader.vaultId !== expectedVaultId) {
    return { status: "stale-vault", vaultId: reader.vaultId };
  }
  if (result.status === "too-large") {
    return unavailable(
      reader.vaultId,
      "too-large",
      `The attachment is larger than the ${Math.floor(maxBytes / (1024 * 1024))} MiB safety limit.`,
    );
  }
  const { mimeType, preview } = sniffCanvasAttachmentMime(result.snapshot.bytes);
  if (preview === "image") {
    return {
      status: "ready",
      vaultId: reader.vaultId,
      path: resolution.path,
      mimeType,
      preview,
      size: result.snapshot.size,
      revision: result.snapshot.revision,
      base64: result.snapshot.bytes.toString("base64"),
    };
  }
  if (preview === "text") {
    const textBytes = result.snapshot.bytes.slice(0, MAX_CANVAS_ATTACHMENT_TEXT_BYTES);
    return {
      status: "ready",
      vaultId: reader.vaultId,
      path: resolution.path,
      mimeType,
      preview,
      size: result.snapshot.size,
      revision: result.snapshot.revision,
      text: new TextDecoder().decode(textBytes),
      truncated: result.snapshot.bytes.length > textBytes.length,
    };
  }
  return {
    status: "ready",
    vaultId: reader.vaultId,
    path: resolution.path,
    mimeType,
    preview,
    size: result.snapshot.size,
    revision: result.snapshot.revision,
  };
}
