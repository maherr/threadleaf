import { normalizeVaultPath } from "../kernel/path-policy";
import type { BinaryReadResult } from "../kernel/vault-kernel";
import { resolveCanvasAttachmentTarget } from "./canvas-attachment-service";
import type { CanvasDiagnostic, JsonCanvasDocument } from "./json-canvas";
import { MAX_CANVAS_BYTES, parseJsonCanvas } from "./json-canvas";

export const MAX_CANVAS_EMBED_DEPTH = 4;
export const MAX_CANVAS_EMBED_COUNT = 32;

export interface CanvasEmbedReader {
  readonly vaultId: string;
  resolveReadPath(relativePath: string): Promise<string>;
  readBinary(relativePath: string, maxBytes: number): Promise<BinaryReadResult>;
}

export interface CanvasEmbedItem {
  path: string;
  revision: string;
  depth: number;
  document: JsonCanvasDocument | null;
  diagnostics: CanvasDiagnostic[];
  readOnly: boolean;
}

export type CanvasEmbedResult =
  | {
      status: "ready";
      vaultId: string;
      rootPath: string;
      items: CanvasEmbedItem[];
      truncated: boolean;
    }
  | {
      status: "unavailable";
      vaultId: string;
      rootPath: string;
      reason: "invalid" | "missing" | "too-large" | "unreadable" | "stale-vault";
      message: string;
    };

function isCanvasPath(filePath: string): boolean {
  return filePath.toLocaleLowerCase("en-US").endsWith(".canvas");
}

function unavailable(
  vaultId: string,
  rootPath: string,
  reason: Exclude<CanvasEmbedResult, { status: "ready" }>["reason"],
  message: string,
): CanvasEmbedResult {
  return { status: "unavailable", vaultId, rootPath, reason, message };
}

export async function expandCanvasEmbeds(
  reader: CanvasEmbedReader,
  rootPath: string,
  expectedVaultId: string,
  options: {
    maxDepth?: number;
    maxCount?: number;
    maxBytes?: number;
  } = {},
): Promise<CanvasEmbedResult> {
  if (reader.vaultId !== expectedVaultId) {
    return unavailable(reader.vaultId, rootPath, "stale-vault", "The active vault changed.");
  }
  const maxDepth = Math.min(options.maxDepth ?? MAX_CANVAS_EMBED_DEPTH, MAX_CANVAS_EMBED_DEPTH);
  const maxCount = Math.min(options.maxCount ?? MAX_CANVAS_EMBED_COUNT, MAX_CANVAS_EMBED_COUNT);
  const maxBytes = Number.isFinite(options.maxBytes)
    ? Math.min(Math.max(Math.floor(options.maxBytes as number), 1), MAX_CANVAS_BYTES)
    : MAX_CANVAS_BYTES;
  if (!isCanvasPath(rootPath)) {
    return unavailable(
      reader.vaultId,
      rootPath,
      "invalid",
      "Canvas embeds require a .canvas path.",
    );
  }
  let normalizedRoot: string;
  try {
    normalizedRoot = normalizeVaultPath(rootPath);
  } catch {
    return unavailable(reader.vaultId, rootPath, "invalid", "Canvas path is invalid.");
  }
  const items: CanvasEmbedItem[] = [];
  const visited = new Set<string>();
  let truncated = false;

  const visit = async (rawPath: string, depth: number): Promise<void> => {
    if (items.length >= maxCount) {
      truncated = true;
      return;
    }
    if (depth > maxDepth) {
      truncated = true;
      return;
    }
    const candidate = rawPath;
    if (visited.has(candidate)) {
      truncated = true;
      return;
    }
    visited.add(candidate);
    let canonicalPath: string;
    try {
      canonicalPath = await reader.resolveReadPath(candidate);
    } catch {
      truncated = true;
      return;
    }
    let read: BinaryReadResult;
    try {
      read = await reader.readBinary(canonicalPath, maxBytes);
    } catch {
      truncated = true;
      return;
    }
    if (read.status === "too-large") {
      truncated = true;
      return;
    }
    const parsed = parseJsonCanvas(read.snapshot.bytes);
    items.push({
      path: candidate,
      revision: read.snapshot.revision,
      depth,
      document: parsed.document,
      diagnostics: parsed.diagnostics,
      readOnly: parsed.status !== "ready",
    });
    if (parsed.status !== "ready" || !parsed.document?.nodes) {
      return;
    }
    for (const node of parsed.document.nodes) {
      if (node.type !== "file" || typeof node.file !== "string" || !isCanvasPath(node.file)) {
        continue;
      }
      if (depth >= maxDepth) {
        truncated = true;
        break;
      }
      const target = resolveCanvasAttachmentTarget(candidate, node.file);
      if (target.status !== "resolved") {
        truncated = true;
        continue;
      }
      await visit(target.path, depth + 1);
      if (items.length >= maxCount) {
        truncated = true;
        break;
      }
    }
  };

  await visit(normalizedRoot, 0);
  return { status: "ready", vaultId: reader.vaultId, rootPath: normalizedRoot, items, truncated };
}
