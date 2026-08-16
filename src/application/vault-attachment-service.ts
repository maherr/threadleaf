import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseMarkdownDestinationTarget } from "../kernel/markdown-links";
import { VaultLinkResolver } from "../kernel/metadata-index";
import { normalizeVaultPath, VaultPathError, type VisibleVaultPaths } from "../kernel/path-policy";
import type { BinaryReadResult } from "../kernel/vault-kernel";
import { sniffVaultImageMime } from "./vault-image-service";

export const DEFAULT_VAULT_ATTACHMENT_MAX_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MEDIA_PROBE_TIMEOUT_MS = 5_000;
const maxTargetLength = 4_096;
const maxSignatureBytes = 64 * 1024;

export type VaultAttachmentKind =
  | "image"
  | "pdf"
  | "audio"
  | "video"
  | "document"
  | "text"
  | "archive"
  | "unsupported";

export interface VaultAttachmentActions {
  open: boolean;
  reveal: boolean;
  rename: boolean;
  move: boolean;
  inline: false;
}

export interface VaultAttachmentMetadata {
  path: string;
  kind: VaultAttachmentKind;
  mimeType: string | null;
  size: number;
  revision: string;
  actions: VaultAttachmentActions;
}

export type VaultAttachmentResponse =
  | { status: "ready"; vaultId: string; attachment: VaultAttachmentMetadata }
  | {
      status: "unavailable";
      vaultId: string;
      reason:
        | "external"
        | "invalid"
        | "ambiguous"
        | "private"
        | "missing"
        | "outside-vault"
        | "too-large"
        | "unreadable";
      message: string;
      attachment?: Pick<VaultAttachmentMetadata, "path" | "actions">;
    }
  | { status: "stale-vault"; vaultId: string };

export interface VaultAttachmentReader {
  readonly vaultId: string;
  listVisiblePaths?(relativeDirectory?: string): Promise<VisibleVaultPaths>;
  resolveReadPath(relativePath: string): Promise<string>;
  readBinary(relativePath: string, maxBytes: number): Promise<BinaryReadResult>;
}

export interface VaultAttachmentLoadOptions {
  maxBytes?: number;
  visiblePaths?: readonly string[];
}

export interface SniffedAttachmentType {
  kind: VaultAttachmentKind;
  mimeType: string;
}

interface ResolvedAttachmentTarget {
  status: "resolved";
  path: string;
}

interface RejectedAttachmentTarget {
  status: "rejected";
  reason: "external" | "invalid" | "private" | "outside-vault";
  message: string;
  /** The normalized destination before a local safety policy rejected it. */
  parsed?: ParsedVaultAttachmentTarget;
}

export type AttachmentTargetResolution = ResolvedAttachmentTarget | RejectedAttachmentTarget;

export interface ParsedVaultAttachmentTarget {
  path: string;
  /** The exact source query/fragment suffix, retained by rewrite planning. */
  suffix: string;
  /** True when the destination path contains no directory separator. */
  bareName: boolean;
}

export type VaultAttachmentTargetParse =
  | ({ status: "local" } & ParsedVaultAttachmentTarget)
  | RejectedAttachmentTarget;

type VaultAttachmentTargetRejection = Extract<VaultAttachmentTargetParse, { status: "rejected" }>;

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

function rejectedTarget(
  reason: VaultAttachmentTargetRejection["reason"],
  message: string,
  parsed?: ParsedVaultAttachmentTarget,
): VaultAttachmentTargetRejection {
  return { status: "rejected", reason, message, ...(parsed ? { parsed } : {}) };
}

export function resolveVaultAttachmentTarget(
  sourceNotePath: string,
  rawTarget: string,
): AttachmentTargetResolution {
  const parsed = parseVaultAttachmentTarget(sourceNotePath, rawTarget);
  if (parsed.status === "local") return { status: "resolved", path: parsed.path };
  return parsed;
}

/**
 * Parses one local attachment destination for both bounded loading and
 * source-preserving rewrite planning. The suffix is deliberately not decoded.
 */
export function parseVaultAttachmentTarget(
  sourceNotePath: string,
  rawTarget: string,
): VaultAttachmentTargetParse {
  let sourcePath: string;
  try {
    sourcePath = normalizeVaultPath(sourceNotePath);
  } catch {
    return rejectedTarget("invalid", "The source path is not a valid vault path.");
  }
  if (!sourcePath.toLocaleLowerCase("en-US").endsWith(".md")) {
    return rejectedTarget("invalid", "Local attachments must be requested from a Markdown note.");
  }
  if (!rawTarget.trim() || rawTarget.length > maxTargetLength || rawTarget.includes("\0")) {
    return rejectedTarget("invalid", "The attachment target is empty, malformed, or too long.");
  }
  const parsed = parseMarkdownDestinationTarget(rawTarget);
  if (!parsed?.path || parsed.path.includes("\0") || /^[a-z]:\//iu.test(parsed.path)) {
    return rejectedTarget("invalid", "The attachment target is not a portable vault path.");
  }
  if (/^[a-z][a-z0-9+.-]*:/iu.test(parsed.path) || parsed.path.startsWith("//")) {
    return rejectedTarget(
      "external",
      "Remote attachments remain disabled in offline reading view.",
    );
  }
  const rooted = parsed.path.startsWith("/");
  const candidate = rooted
    ? parsed.path.replace(/^\/+/, "")
    : path.posix.join(path.posix.dirname(sourcePath), parsed.path);
  let resolvedPath: string;
  try {
    resolvedPath = normalizeVaultPath(candidate);
  } catch {
    return rejectedTarget(
      "outside-vault",
      "The attachment target leaves the active vault.",
      parsed,
    );
  }
  if (isPrivateVaultPath(resolvedPath)) {
    return rejectedTarget(
      "private",
      "Private application and transaction paths are never exposed as attachments.",
      { ...parsed, path: resolvedPath },
    );
  }
  return { status: "local", path: resolvedPath, suffix: parsed.suffix, bareName: parsed.bareName };
}

function startsWithAscii(bytes: Uint8Array, signature: string): boolean {
  const encoded = Buffer.from(signature, "ascii");
  return bytes.length >= encoded.length && encoded.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, start = 0, end = bytes.length): string {
  return Buffer.from(bytes.slice(start, Math.min(end, bytes.length))).toString("ascii");
}

function isIsoBaseMedia(bytes: Uint8Array): boolean {
  if (bytes.length < 12 || ascii(bytes, 4, 8) !== "ftyp") return false;
  const brands = ascii(bytes, 8, Math.min(bytes.length, 64));
  return /(?:isom|iso2|mp41|mp42|avc1|hvc1|hev1|av01|qt {2}|M4V\s|3g)/u.test(brands);
}

function isOfficeZip(bytes: Uint8Array): boolean {
  if (!startsWithAscii(bytes, "PK\x03\x04")) return false;
  const readUint16 = (offset: number): number =>
    (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
  const readUint32 = (offset: number): number =>
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24);
  const isOfficeEntry = (name: string): boolean =>
    name === "[Content_Types].xml" || /^(?:word|xl|ppt)\//u.test(name);
  let offset = 0;
  let inspected = 0;
  while (offset + 30 <= Math.min(bytes.length, maxSignatureBytes) && inspected < 128) {
    const signature = ascii(bytes, offset, offset + 4);
    if (signature === "PK\x03\x04") {
      const nameLength = readUint16(offset + 26);
      const extraLength = readUint16(offset + 28);
      const nameStart = offset + 30;
      const nameEnd = nameStart + nameLength;
      if (nameEnd > bytes.length) return false;
      if (isOfficeEntry(ascii(bytes, nameStart, nameEnd))) return true;
      const compressedSize = readUint32(offset + 18) >>> 0;
      offset = nameEnd + extraLength + compressedSize;
    } else if (signature === "PK\x01\x02") {
      const nameLength = readUint16(offset + 28);
      const extraLength = readUint16(offset + 30);
      const commentLength = readUint16(offset + 32);
      const nameStart = offset + 46;
      const nameEnd = nameStart + nameLength;
      if (nameEnd > bytes.length) return false;
      if (isOfficeEntry(ascii(bytes, nameStart, nameEnd))) return true;
      offset = nameEnd + extraLength + commentLength;
    } else {
      break;
    }
    inspected += 1;
  }
  // Deflated Office files may use a data descriptor, leaving the local header's
  // compressed-size field at zero.  The central directory still carries the
  // uncompressed entry name, so scan only bounded bytes for that signature.
  for (let index = 4; index + 46 <= Math.min(bytes.length, maxSignatureBytes); index += 1) {
    if (ascii(bytes, index - 4, index) !== "PK\x01\x02") continue;
    const nameLength = readUint16(index + 24);
    const extraLength = readUint16(index + 26);
    const commentLength = readUint16(index + 28);
    const nameStart = index + 42;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.length) continue;
    if (isOfficeEntry(ascii(bytes, nameStart, nameEnd))) return true;
    index = nameEnd + extraLength + commentLength;
  }
  return false;
}

function validUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Detects an attachment from bounded bytes. The filename is deliberately not an input. */
export function sniffVaultAttachment(bytes: Uint8Array): SniffedAttachmentType | null {
  const sample = bytes.slice(0, maxSignatureBytes);
  const raster = sniffVaultImageMime(sample);
  if (raster) return { kind: "image", mimeType: raster };
  if (startsWithAscii(sample, "%PDF-")) return { kind: "pdf", mimeType: "application/pdf" };
  if (startsWithAscii(sample, "{\\rtf")) return { kind: "document", mimeType: "application/rtf" };
  if (
    sample.length >= 8 &&
    sample[0] === 0xd0 &&
    sample[1] === 0xcf &&
    sample[2] === 0x11 &&
    sample[3] === 0xe0 &&
    sample[4] === 0xa1 &&
    sample[5] === 0xb1 &&
    sample[6] === 0x1a &&
    sample[7] === 0xe1
  ) {
    return { kind: "document", mimeType: "application/vnd.ms-office" };
  }
  if (isOfficeZip(sample)) return { kind: "document", mimeType: "application/zip" };
  if (startsWithAscii(sample, "PK\x03\x04"))
    return { kind: "archive", mimeType: "application/zip" };
  if (startsWithAscii(sample, "ID3") || startsWithAscii(sample, "fLaC")) {
    return {
      kind: "audio",
      mimeType: startsWithAscii(sample, "fLaC") ? "audio/flac" : "audio/mpeg",
    };
  }
  if (startsWithAscii(sample, "OggS")) return { kind: "audio", mimeType: "audio/ogg" };
  if (startsWithAscii(sample, "RIFF") && ascii(sample, 8, 12) === "WAVE") {
    return { kind: "audio", mimeType: "audio/wav" };
  }
  if (startsWithAscii(sample, "RIFF") && ascii(sample, 8, 12) === "AVI ") {
    return { kind: "video", mimeType: "video/x-msvideo" };
  }
  if (
    sample.length >= 2 &&
    sample[0] === 0xff &&
    sample[1] !== undefined &&
    (sample[1] & 0xe0) === 0xe0
  ) {
    return { kind: "audio", mimeType: "audio/mpeg" };
  }
  if (startsWithAscii(sample, "\x1a\x45\xdf\xa3")) {
    return { kind: "video", mimeType: "video/webm" };
  }
  if (isIsoBaseMedia(sample)) {
    const brands = ascii(sample, 8, Math.min(sample.length, 64));
    return /(?:M4A\s|M4B\s|M4P\s)/u.test(brands)
      ? { kind: "audio", mimeType: "audio/mp4" }
      : { kind: "video", mimeType: "video/mp4" };
  }
  if (validUtf8Text(sample)) return { kind: "text", mimeType: "text/plain" };
  return null;
}

function unavailableFromReadError(vaultId: string, error: unknown): VaultAttachmentResponse {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    return {
      status: "unavailable",
      vaultId,
      reason: "missing",
      message: "The attachment no longer exists.",
    };
  }
  if (error instanceof VaultPathError) {
    const outside = /outside|escape/iu.test(error.message);
    return {
      status: "unavailable",
      vaultId,
      reason: outside ? "outside-vault" : "invalid",
      message: outside
        ? "The attachment resolves outside the active vault."
        : "The attachment path is invalid.",
    };
  }
  return {
    status: "unavailable",
    vaultId,
    reason: "unreadable",
    message: "The attachment could not be read safely.",
  };
}

export async function loadVaultAttachment(
  reader: VaultAttachmentReader,
  sourceNotePath: string,
  rawTarget: string,
  expectedVaultId: string,
  options: VaultAttachmentLoadOptions = {},
): Promise<VaultAttachmentResponse> {
  if (expectedVaultId !== reader.vaultId) return { status: "stale-vault", vaultId: reader.vaultId };
  const resolution = parseVaultAttachmentTarget(sourceNotePath, rawTarget);
  if (resolution.status === "rejected") {
    return {
      status: "unavailable",
      vaultId: reader.vaultId,
      reason: resolution.reason,
      message: resolution.message,
    };
  }
  let attachmentPath = resolution.path;
  try {
    const visiblePaths =
      options.visiblePaths ?? (await reader.listVisiblePaths?.(""))?.files ?? null;
    if (visiblePaths) {
      const destination = parseMarkdownDestinationTarget(rawTarget)?.path ?? rawTarget;
      const resolver = new VaultLinkResolver(
        visiblePaths.filter(
          (filePath) =>
            !filePath.toLocaleLowerCase("en-US").endsWith(".md") && !isPrivateVaultPath(filePath),
        ),
      );
      const linkResolution = resolver.resolve(normalizeVaultPath(sourceNotePath), destination);
      if (linkResolution.status === "ambiguous") {
        return {
          status: "unavailable",
          vaultId: reader.vaultId,
          reason: "ambiguous",
          message: "The attachment target has more than one possible destination.",
        };
      }
      if (linkResolution.status !== "resolved" || !linkResolution.path) {
        return {
          status: "unavailable",
          vaultId: reader.vaultId,
          reason: "missing",
          message: "The attachment target does not resolve in the active vault.",
        };
      }
      attachmentPath = linkResolution.path;
    }
  } catch (error) {
    return unavailableFromReadError(reader.vaultId, error);
  }
  let canonicalPath: string;
  try {
    canonicalPath = await reader.resolveReadPath(attachmentPath);
  } catch (error) {
    return unavailableFromReadError(reader.vaultId, error);
  }
  if (isPrivateVaultPath(canonicalPath)) {
    return {
      status: "unavailable",
      vaultId: reader.vaultId,
      reason: "private",
      message: "Private paths are never exposed as attachments.",
    };
  }
  const maxBytes = options.maxBytes ?? DEFAULT_VAULT_ATTACHMENT_MAX_BYTES;
  let result: BinaryReadResult;
  try {
    result = await reader.readBinary(canonicalPath, maxBytes);
  } catch (error) {
    return unavailableFromReadError(reader.vaultId, error);
  }
  if (expectedVaultId !== reader.vaultId) return { status: "stale-vault", vaultId: reader.vaultId };
  if (result.status === "too-large") {
    return {
      status: "unavailable",
      vaultId: reader.vaultId,
      reason: "too-large",
      message: `The attachment is larger than the ${Math.floor(maxBytes / (1024 * 1024))} MiB bounded-read limit.`,
    };
  }
  const sniffed = sniffVaultAttachment(result.snapshot.bytes);
  const attachment: VaultAttachmentMetadata = {
    path: attachmentPath,
    kind: sniffed?.kind ?? "unsupported",
    mimeType: sniffed?.mimeType ?? null,
    size: result.snapshot.size,
    revision: result.snapshot.revision,
    actions: { open: true, reveal: true, rename: true, move: true, inline: false },
  };
  return { status: "ready", vaultId: reader.vaultId, attachment };
}

export interface MediaProbeResult {
  status: "ready" | "unsupported" | "timeout" | "failed";
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  sampledSeconds: number[];
  message?: string;
}

export interface MediaProbeOptions {
  timeoutMs?: number;
  binary?: string;
  run?: (binary: string, args: readonly string[], timeoutMs: number) => Promise<string>;
}

async function runFfprobe(
  binary: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("media-probe-timeout"));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 256 * 1024) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 64 * 1024) child.kill("SIGKILL");
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `ffprobe exited with status ${code ?? "unknown"}`));
    });
  });
}

/**
 * Probe only metadata and one-second samples. `-ss` precedes `-i`, and `-read_intervals` prevents
 * a long recording from turning a metadata request into a full decode. The runner is injectable so
 * tests can assert the kill deadline and argument order without invoking a host codec.
 */
export async function probeMediaFile(
  filePath: string,
  options: MediaProbeOptions = {},
): Promise<MediaProbeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_MEDIA_PROBE_TIMEOUT_MS;
  const binary = options.binary ?? "ffprobe";
  const args = [
    "-v",
    "error",
    "-ss",
    "0",
    "-read_intervals",
    "%+#1",
    "-i",
    filePath,
    "-select_streams",
    "v:0",
    "-show_entries",
    "format=duration:stream=width,height",
    "-of",
    "json",
  ];
  try {
    const output = await (options.run ?? runFfprobe)(binary, args, timeoutMs);
    const parsed = JSON.parse(output) as {
      format?: { duration?: string };
      streams?: Array<{ width?: number; height?: number }>;
    };
    const stream = parsed.streams?.[0];
    const duration = Number(parsed.format?.duration);
    return {
      status: "ready",
      durationSeconds: Number.isFinite(duration) ? duration : null,
      width: Number.isFinite(stream?.width) ? (stream?.width ?? null) : null,
      height: Number.isFinite(stream?.height) ? (stream?.height ?? null) : null,
      sampledSeconds: [0],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: message === "media-probe-timeout" ? "timeout" : "failed",
      durationSeconds: null,
      width: null,
      height: null,
      sampledSeconds: [],
      message:
        message === "media-probe-timeout"
          ? "Media probing exceeded its kill deadline."
          : "Media metadata could not be read safely.",
    };
  }
}

export async function probeVaultMedia(
  reader: VaultAttachmentReader,
  sourceNotePath: string,
  rawTarget: string,
  expectedVaultId: string,
  options: VaultAttachmentLoadOptions & MediaProbeOptions = {},
): Promise<MediaProbeResult | { status: "unavailable"; reason: string; message: string }> {
  const attachment = await loadVaultAttachment(
    reader,
    sourceNotePath,
    rawTarget,
    expectedVaultId,
    options,
  );
  if (attachment.status !== "ready") {
    return {
      status: "unavailable",
      reason: attachment.status === "stale-vault" ? "stale-vault" : attachment.reason,
      message:
        attachment.status === "stale-vault"
          ? "The active vault changed before media probing."
          : attachment.message,
    };
  }
  if (attachment.attachment.kind !== "audio" && attachment.attachment.kind !== "video") {
    return {
      status: "unavailable",
      reason: "unsupported",
      message: "Only sniffed audio and video attachments can be probed.",
    };
  }
  let canonicalPath: string;
  try {
    canonicalPath = await reader.resolveReadPath(attachment.attachment.path);
  } catch {
    return {
      status: "unavailable",
      reason: "unreadable",
      message: "The media attachment could not be resolved safely.",
    };
  }
  return probeMediaFile(canonicalPath, options);
}

export async function readAttachmentBytesForTest(
  filePath: string,
  maxBytes: number,
): Promise<Buffer> {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const length = Math.min(stat.size, maxBytes);
    const bytes = Buffer.alloc(length);
    await handle.read(bytes, 0, length, 0);
    return bytes;
  } finally {
    await handle.close();
  }
}
