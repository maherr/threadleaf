import { normalizeVaultPath, VaultPathError } from "../kernel/path-policy";
import type { VaultWriteResult } from "../kernel/ports";
import type { BinaryReadResult, VaultKernel } from "../kernel/vault-kernel";
import type {
  CanvasLoadResponse,
  CanvasSaveOutcome,
  CanvasUnavailableReason,
  WorkspaceCanvasSnapshot,
} from "../shared/contracts";
import { type JsonCanvasDocument, MAX_CANVAS_BYTES, parseJsonCanvas } from "./json-canvas";

export interface CanvasReader {
  readonly vaultId: string;
  resolveReadPath(relativePath: string): Promise<string>;
  readBinary(relativePath: string, maxBytes: number): Promise<BinaryReadResult>;
}

export interface CanvasWriter extends CanvasReader {
  readonly readOnly?: boolean;
  writeBinary(
    relativePath: string,
    content: Uint8Array,
    expectedRevision: string | null,
  ): Promise<VaultWriteResult>;
}

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

function unavailable(
  vaultId: string,
  path: string,
  reason: CanvasUnavailableReason,
  message: string,
): CanvasLoadResponse {
  return { status: "unavailable", vaultId, path, reason, message };
}

function normalizeCanvasPath(rawPath: string): string {
  const normalized = normalizeVaultPath(rawPath);
  if (!normalized.toLocaleLowerCase("en-US").endsWith(".canvas")) {
    throw new Error("Canvas paths must use the .canvas extension.");
  }
  if (isPrivateVaultPath(normalized)) {
    throw new Error("Private application paths are not canvases.");
  }
  return normalized;
}

function errorResponse(vaultId: string, path: string, error: unknown): CanvasLoadResponse {
  if (error instanceof Error && /private application paths/i.test(error.message)) {
    return unavailable(vaultId, path, "private", "Private application files are never canvases.");
  }
  if (
    error instanceof Error &&
    /\.canvas extension|canvas paths must|valid vault path/i.test(error.message)
  ) {
    return unavailable(vaultId, path, "invalid", "The canvas path is invalid.");
  }
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    return unavailable(vaultId, path, "missing", "The canvas no longer exists.");
  }
  if (error instanceof VaultPathError) {
    const outside = /outside|escape/i.test(error.message);
    return unavailable(
      vaultId,
      path,
      outside ? "outside-vault" : "invalid",
      outside ? "The canvas resolves outside the active vault." : "The canvas path is invalid.",
    );
  }
  return unavailable(vaultId, path, "unreadable", "The canvas could not be read safely.");
}

function titleForCanvasPath(filePath: string): string {
  return (
    filePath
      .split("/")
      .at(-1)
      ?.replace(/\.canvas$/iu, "") || filePath
  );
}

export async function loadJsonCanvas(
  reader: CanvasReader,
  rawPath: string,
  expectedVaultId: string,
  options: { maxBytes?: number; readOnly?: boolean } = {},
): Promise<CanvasLoadResponse> {
  if (reader.vaultId !== expectedVaultId) {
    return { status: "stale-vault", vaultId: reader.vaultId };
  }
  let normalizedPath: string;
  try {
    normalizedPath = normalizeCanvasPath(rawPath);
  } catch (error) {
    return errorResponse(reader.vaultId, rawPath, error);
  }
  const maxBytes = Number.isFinite(options.maxBytes)
    ? Math.min(Math.max(Math.floor(options.maxBytes as number), 1), MAX_CANVAS_BYTES)
    : MAX_CANVAS_BYTES;
  let canonicalPath: string;
  try {
    canonicalPath = await reader.resolveReadPath(normalizedPath);
  } catch (error) {
    return errorResponse(reader.vaultId, normalizedPath, error);
  }
  if (isPrivateVaultPath(canonicalPath)) {
    return unavailable(
      reader.vaultId,
      normalizedPath,
      "private",
      "Private files are never canvases.",
    );
  }
  let result: BinaryReadResult;
  try {
    result = await reader.readBinary(canonicalPath, maxBytes);
  } catch (error) {
    return errorResponse(reader.vaultId, normalizedPath, error);
  }
  if (reader.vaultId !== expectedVaultId) {
    return { status: "stale-vault", vaultId: reader.vaultId };
  }
  if (result.status === "too-large") {
    return unavailable(
      reader.vaultId,
      normalizedPath,
      "too-large",
      `The canvas is larger than the ${Math.floor(maxBytes / (1024 * 1024))} MiB safety limit.`,
    );
  }
  const parsed = parseJsonCanvas(result.snapshot.bytes);
  const canvas: WorkspaceCanvasSnapshot = {
    path: normalizedPath,
    title: titleForCanvasPath(normalizedPath),
    revision: result.snapshot.revision,
    document: parsed.document,
    diagnostics: parsed.diagnostics,
    readOnly: options.readOnly === true || parsed.status !== "ready",
  };
  return { status: "ready", vaultId: reader.vaultId, canvas };
}

export async function saveJsonCanvas(
  writer: CanvasWriter,
  rawPath: string,
  content: string,
  expectedRevision: string,
  expectedVaultId: string,
): Promise<CanvasSaveOutcome> {
  let normalizedPath: string;
  try {
    normalizedPath = normalizeCanvasPath(rawPath);
  } catch {
    return { status: "read-only", path: rawPath };
  }
  if (writer.vaultId !== expectedVaultId) {
    return { status: "read-only", path: normalizedPath };
  }
  if (writer.readOnly) {
    return { status: "read-only", path: normalizedPath };
  }
  let current: BinaryReadResult;
  try {
    current = await writer.readBinary(normalizedPath, MAX_CANVAS_BYTES);
  } catch {
    return { status: "read-only", path: normalizedPath };
  }
  if (current.status !== "ready" || parseJsonCanvas(current.snapshot.bytes).status !== "ready") {
    return { status: "read-only", path: normalizedPath };
  }
  const parsed = parseJsonCanvas(content);
  if (parsed.status !== "ready") {
    return { status: "read-only", path: normalizedPath };
  }
  let result: VaultWriteResult;
  try {
    result = await writer.writeBinary(
      normalizedPath,
      new TextEncoder().encode(content),
      expectedRevision,
    );
  } catch (error) {
    if (writer.readOnly || (error instanceof Error && /read.?only/i.test(error.message))) {
      return { status: "read-only", path: normalizedPath };
    }
    throw error;
  }
  if (result.status === "committed") {
    return {
      status: "committed",
      path: normalizedPath,
      revision: result.revision,
      transactionId: result.transactionId,
    };
  }
  return {
    status: "conflict",
    path: normalizedPath,
    currentRevision: result.currentRevision,
    conflictPath: result.conflictPath,
    transactionId: result.transactionId,
  };
}

export function isCanvasPath(filePath: string): boolean {
  return filePath.toLocaleLowerCase("en-US").endsWith(".canvas");
}

export function titleForJsonCanvasPath(filePath: string): string {
  return titleForCanvasPath(filePath);
}

export function jsonCanvasDocumentToBytes(document: JsonCanvasDocument): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`);
}

export function asVaultKernelCanvasReader(kernel: VaultKernel): CanvasReader {
  return kernel;
}
