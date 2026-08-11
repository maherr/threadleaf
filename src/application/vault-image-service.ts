import path from "node:path";
import { normalizeVaultPath, VaultPathError } from "../kernel/path-policy";
import type { BinaryReadResult } from "../kernel/vault-kernel";
import type {
  VaultImageMimeType,
  VaultImageResponse,
  VaultImageUnavailableReason,
} from "../shared/contracts";

export const DEFAULT_VAULT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const maxTargetLength = 4_096;

export interface VaultImageReader {
  readonly vaultId: string;
  resolveReadPath(relativePath: string): Promise<string>;
  readBinary(relativePath: string, maxBytes: number): Promise<BinaryReadResult>;
}

export interface VaultImageLoadOptions {
  maxBytes?: number;
}

interface ResolvedImageTarget {
  status: "resolved";
  path: string;
}

interface RejectedImageTarget {
  status: "rejected";
  reason: VaultImageUnavailableReason;
  message: string;
}

type ImageTargetResolution = ResolvedImageTarget | RejectedImageTarget;

function unavailable(
  vaultId: string,
  reason: VaultImageUnavailableReason,
  message: string,
): VaultImageResponse {
  return { status: "unavailable", vaultId, reason, message };
}

function isPrivateVaultPath(relativePath: string): boolean {
  return relativePath.split("/").some((segment) => {
    const folded = segment.toLocaleLowerCase("en-US");
    return folded === ".obsidian" || folded === ".git" || folded.startsWith(".threadleaf-");
  });
}

function stripAngleBrackets(target: string): string {
  return target.startsWith("<") && target.endsWith(">") ? target.slice(1, -1).trim() : target;
}

export function resolveVaultImageTarget(
  sourceNotePath: string,
  rawTarget: string,
): ImageTargetResolution {
  let sourcePath: string;
  try {
    sourcePath = normalizeVaultPath(sourceNotePath);
  } catch {
    return {
      status: "rejected",
      reason: "invalid",
      message: "The source note path is not a valid vault path.",
    };
  }
  if (!sourcePath.toLocaleLowerCase("en-US").endsWith(".md")) {
    return {
      status: "rejected",
      reason: "invalid",
      message: "Local images must be requested from a Markdown note.",
    };
  }

  const trimmed = stripAngleBrackets(rawTarget.trim());
  if (!trimmed || trimmed.length > maxTargetLength || trimmed.includes("\0")) {
    return {
      status: "rejected",
      reason: "invalid",
      message: "The image target is empty, malformed, or too long.",
    };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) {
    return {
      status: "rejected",
      reason: "external",
      message: "External images remain disabled in reading view.",
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
      message: "The image target contains invalid URL encoding.",
    };
  }
  if (!decodedPath || decodedPath.includes("\0") || /^[a-z]:\//i.test(decodedPath)) {
    return {
      status: "rejected",
      reason: "invalid",
      message: "The image target is not a portable vault path.",
    };
  }

  const rooted = decodedPath.startsWith("/");
  const candidate = rooted
    ? decodedPath.replace(/^\/+/, "")
    : path.posix.join(path.posix.dirname(sourcePath), decodedPath);
  let resolvedPath: string;
  try {
    resolvedPath = normalizeVaultPath(candidate);
  } catch {
    return {
      status: "rejected",
      reason: "outside-vault",
      message: "The image target leaves the active vault.",
    };
  }
  if (isPrivateVaultPath(resolvedPath)) {
    return {
      status: "rejected",
      reason: "private",
      message: "Application configuration and transaction files are never rendered as images.",
    };
  }
  return { status: "resolved", path: resolvedPath };
}

export function sniffVaultImageMime(bytes: Uint8Array): VaultImageMimeType | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6) {
    const signature = String.fromCharCode(...bytes.slice(0, 6));
    if (signature === "GIF87a" || signature === "GIF89a") {
      return "image/gif";
    }
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function unavailableFromReadError(vaultId: string, error: unknown): VaultImageResponse {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    return unavailable(vaultId, "missing", "The local image no longer exists.");
  }
  if (error instanceof VaultPathError) {
    const outside = /outside|escape/i.test(error.message);
    return unavailable(
      vaultId,
      outside ? "outside-vault" : "invalid",
      outside
        ? "The local image resolves outside the active vault."
        : "The local image path is invalid.",
    );
  }
  return unavailable(vaultId, "unreadable", "The local image could not be read safely.");
}

export async function loadVaultImage(
  reader: VaultImageReader,
  sourceNotePath: string,
  rawTarget: string,
  expectedVaultId: string,
  options: VaultImageLoadOptions = {},
): Promise<VaultImageResponse> {
  if (expectedVaultId !== reader.vaultId) {
    return { status: "stale-vault", vaultId: reader.vaultId };
  }
  const resolution = resolveVaultImageTarget(sourceNotePath, rawTarget);
  if (resolution.status === "rejected") {
    return unavailable(reader.vaultId, resolution.reason, resolution.message);
  }
  const maxBytes = options.maxBytes ?? DEFAULT_VAULT_IMAGE_MAX_BYTES;
  let canonicalPath: string;
  try {
    canonicalPath = await reader.resolveReadPath(resolution.path);
  } catch (error) {
    return unavailableFromReadError(reader.vaultId, error);
  }
  if (isPrivateVaultPath(canonicalPath)) {
    return unavailable(
      reader.vaultId,
      "private",
      "Application configuration and transaction files are never rendered as images.",
    );
  }
  let result: BinaryReadResult;
  try {
    result = await reader.readBinary(canonicalPath, maxBytes);
  } catch (error) {
    return unavailableFromReadError(reader.vaultId, error);
  }
  if (expectedVaultId !== reader.vaultId) {
    return { status: "stale-vault", vaultId: reader.vaultId };
  }
  if (result.status === "too-large") {
    return unavailable(
      reader.vaultId,
      "too-large",
      `The local image is larger than the ${Math.floor(maxBytes / (1024 * 1024))} MiB reading-view limit.`,
    );
  }
  const mimeType = sniffVaultImageMime(result.snapshot.bytes);
  if (!mimeType) {
    return unavailable(
      reader.vaultId,
      "unsupported",
      "Only sniffed PNG, JPEG, GIF, and WebP images are rendered.",
    );
  }
  return {
    status: "ready",
    vaultId: reader.vaultId,
    path: resolution.path,
    mimeType,
    size: result.snapshot.size,
    revision: result.snapshot.revision,
    base64: result.snapshot.bytes.toString("base64"),
  };
}
