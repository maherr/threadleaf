import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Small, format-only helpers for Excalidraw Markdown documents.
 *
 * The plugin owns scene serialization. Threadleaf deliberately does not
 * implement the plugin's compressed-json codec. Compressed scenes therefore
 * have an exact-byte contract, while uncompressed JSON scenes can be compared
 * semantically after the plugin has reordered JSON object keys or whitespace.
 */

export const excalidrawRoundtripSchemaVersion = 1 as const;

export type ExcalidrawSceneEncoding = "json" | "compressed-json";

export interface ExcalidrawSceneRange {
  encoding: ExcalidrawSceneEncoding;
  fenceStart: number;
  payloadStart: number;
  payloadEnd: number;
  fenceEnd: number;
  payload: string;
}

export interface ExcalidrawMarkdownDocument {
  frontmatter: string | null;
  scene: ExcalidrawSceneRange;
  attachmentReferences: string[];
}

export interface ExcalidrawSemanticComparison {
  equal: boolean;
  kind: "byte-exact" | "semantic" | "different-encoding" | "unsupported-compressed-change";
  encoding: ExcalidrawSceneEncoding;
  nonSceneBytesEqual: boolean;
  beforeDigest: string;
  afterDigest: string;
  beforeSceneDigest?: string;
  afterSceneDigest?: string;
  reason?: string;
}

export interface ExcalidrawAttachmentManifestEntry {
  path: string;
  size: number;
  sha256: string;
  mime: string;
}

export interface ExcalidrawAttachmentManifest {
  schemaVersion: typeof excalidrawRoundtripSchemaVersion;
  entries: ExcalidrawAttachmentManifestEntry[];
}

const sceneFencePattern = /^```(compressed-json|json)\r?\n([\s\S]*?)^```[ \t]*$/gmu;
const generatedTextSectionPattern =
  /(^# Excalidraw Data[ \t]*\r?\n(?:\r?\n)?## Text Elements[ \t]*\r?\n)([\s\S]*?)(^%%[ \t]*\r?\n## Drawing[ \t]*\r?$)/mu;
const frontmatterPattern = /^(---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$))/u;
const markdownImagePattern = /!\[\[[^\]\n]+\]\]|!\[[^\]\n]*\]\([^\n)]+\)/gu;
const wikiTargetPattern = /^!\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]$/u;
const markdownTargetPattern = /^!\[[^\]]*\]\(([^)#]+)(?:#[^)]*)?(?:\s+"[^"]*")?\)$/u;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function assertSafeRelativePath(value: string): string {
  const normalized = normalizePath(value);
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(`Attachment path escapes the vault: ${value}`);
  }
  return normalized;
}

function mimeForPath(filePath: string): string {
  const extension = path.extname(filePath).toLocaleLowerCase("en-US");
  switch (extension) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".json":
      return "application/json";
    case ".txt":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findJsonScene(payload: string): boolean {
  try {
    const value: unknown = JSON.parse(payload);
    return isRecord(value) && value.type === "excalidraw";
  } catch {
    return false;
  }
}

function sceneRangeFromMatch(match: RegExpExecArray): ExcalidrawSceneRange {
  const fenceStart = match.index;
  const opening = match[0].slice(0, match[0].indexOf("\n") + 1);
  const payloadStart = fenceStart + opening.length;
  const payload = match[2] ?? "";
  const payloadEnd = payloadStart + payload.length;
  return {
    encoding: match[1] as ExcalidrawSceneEncoding,
    fenceStart,
    payloadStart,
    payloadEnd,
    fenceEnd: fenceStart + match[0].length,
    payload,
  };
}

function generatedTextSectionBodyRange(
  markdown: string,
): { start: number; end: number; lineEnding: "\n" | "\r\n" } | null {
  const match = generatedTextSectionPattern.exec(markdown);
  if (!match) return null;
  const header = match[1] ?? "";
  const body = match[2] ?? "";
  const start = match.index + header.length;
  return {
    start,
    end: start + body.length,
    lineEnding: header.includes("\r\n") ? "\r\n" : "\n",
  };
}

function textElementsFromScene(scene: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(scene.elements)) return [];
  return scene.elements.filter(
    (element): element is Record<string, unknown> =>
      isRecord(element) && element.type === "text" && element.isDeleted !== true,
  );
}

function renderGeneratedTextSectionBody(
  scene: Record<string, unknown>,
  lineEnding: "\n" | "\r\n",
): string {
  const ids = new Set<string>();
  const entries = textElementsFromScene(scene).map((element) => {
    const id = element.id;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{8}$/u.test(id)) {
      throw new Error("Excalidraw text element IDs must be eight public-format characters.");
    }
    if (ids.has(id)) {
      throw new Error(`Excalidraw Text Elements contains a duplicate ID: ${id}`);
    }
    ids.add(id);
    const raw =
      typeof element.rawText === "string"
        ? element.rawText
        : typeof element.originalText === "string"
          ? element.originalText
          : typeof element.text === "string"
            ? element.text
            : "";
    const normalized = raw.replace(/\r?\n/gu, lineEnding);
    return `${normalized} ^${id}`;
  });
  return entries.length === 0
    ? lineEnding
    : `${entries.join(`${lineEnding}${lineEnding}`)}${lineEnding}${lineEnding}`;
}

function generatedTextSectionMatchesScene(
  markdown: string,
  scene: Record<string, unknown>,
): boolean {
  const range = generatedTextSectionBodyRange(markdown);
  if (!range) return true;
  try {
    return (
      markdown.slice(range.start, range.end) ===
      renderGeneratedTextSectionBody(scene, range.lineEnding)
    );
  } catch {
    return false;
  }
}

/** Rebuild the official generated text map from the current uncompressed scene. */
export function synchronizeExcalidrawTextElementMappings(
  markdown: string,
  scene: Record<string, unknown>,
): string {
  const range = generatedTextSectionBodyRange(markdown);
  if (!range) {
    throw new Error("Excalidraw Markdown does not contain the canonical Text Elements section.");
  }
  const body = renderGeneratedTextSectionBody(scene, range.lineEnding);
  return `${markdown.slice(0, range.start)}${body}${markdown.slice(range.end)}`;
}

/** Parse the first Excalidraw scene fence without rewriting any source bytes. */
export function parseExcalidrawMarkdown(markdown: string): ExcalidrawMarkdownDocument {
  const frontmatter = markdown.match(frontmatterPattern)?.[1] ?? null;
  sceneFencePattern.lastIndex = 0;
  let match: RegExpExecArray | null = null;
  let jsonCandidate: ExcalidrawSceneRange | null = null;
  while (true) {
    match = sceneFencePattern.exec(markdown);
    if (match === null) break;
    const candidate = sceneRangeFromMatch(match);
    if (candidate.encoding === "compressed-json") {
      return {
        frontmatter,
        scene: candidate,
        attachmentReferences: extractExcalidrawAttachmentReferences(markdown),
      };
    }
    if (findJsonScene(candidate.payload)) {
      jsonCandidate = candidate;
      break;
    }
  }
  if (!jsonCandidate) {
    throw new Error("Excalidraw Markdown does not contain a valid compressed-json or JSON scene.");
  }
  return {
    frontmatter,
    scene: jsonCandidate,
    attachmentReferences: extractExcalidrawAttachmentReferences(markdown),
  };
}

/** Replace only the scene payload, retaining the frontmatter, fence, links, and line endings. */
export function replaceExcalidrawScene(markdown: string, payload: string): string {
  const document = parseExcalidrawMarkdown(markdown);
  const lineEnding = document.scene.payload.includes("\r\n") ? "\r\n" : "\n";
  const normalizedPayload = payload.endsWith(lineEnding) ? payload : `${payload}${lineEnding}`;
  return `${markdown.slice(0, document.scene.payloadStart)}${normalizedPayload}${markdown.slice(document.scene.payloadEnd)}`;
}

/** Parse the uncompressed public scene JSON. Compressed-json is intentionally opaque here. */
export function parseUncompressedExcalidrawScene(markdown: string): Record<string, unknown> {
  const document = parseExcalidrawMarkdown(markdown);
  if (document.scene.encoding !== "json") {
    throw new Error("Compressed Excalidraw scenes require the unchanged plugin codec.");
  }
  const value: unknown = JSON.parse(document.scene.payload.trim());
  if (!isRecord(value) || value.type !== "excalidraw") {
    throw new Error("Excalidraw JSON scene has an invalid type.");
  }
  return value;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalValue(item));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right, "en"))
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

/** Stable semantic bytes for a JSON scene. Array order remains meaningful. */
export function canonicalizeExcalidrawScene(value: unknown): string {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

export function canonicalExcalidrawSceneDigest(value: unknown): string {
  return sha256(Buffer.from(canonicalizeExcalidrawScene(value), "utf8"));
}

function sourceWithoutGeneratedSceneBytes(
  markdown: string,
  document: ExcalidrawMarkdownDocument,
): string {
  const ranges = [
    { start: document.scene.payloadStart, end: document.scene.payloadEnd },
    generatedTextSectionBodyRange(markdown),
  ]
    .filter((range): range is { start: number; end: number } => range !== null)
    .sort((left, right) => right.start - left.start);
  let result = markdown;
  for (const range of ranges) {
    result = `${result.slice(0, range.start)}${result.slice(range.end)}`;
  }
  return result;
}

/**
 * Compare two plugin saves. Byte equality is preferred. For an uncompressed JSON save,
 * surrounding Markdown must stay byte-identical and only canonical scene semantics may vary.
 */
export function compareExcalidrawMarkdown(
  beforeMarkdown: string,
  afterMarkdown: string,
): ExcalidrawSemanticComparison {
  const beforeBytes = Buffer.from(beforeMarkdown, "utf8");
  const afterBytes = Buffer.from(afterMarkdown, "utf8");
  const beforeDocument = parseExcalidrawMarkdown(beforeMarkdown);
  const afterDocument = parseExcalidrawMarkdown(afterMarkdown);
  const beforeDigest = sha256(beforeBytes);
  const afterDigest = sha256(afterBytes);
  if (beforeDigest === afterDigest) {
    return {
      equal: true,
      kind: "byte-exact",
      encoding: beforeDocument.scene.encoding,
      nonSceneBytesEqual: true,
      beforeDigest,
      afterDigest,
    };
  }
  if (beforeDocument.scene.encoding !== afterDocument.scene.encoding) {
    return {
      equal: false,
      kind: "different-encoding",
      encoding: beforeDocument.scene.encoding,
      nonSceneBytesEqual: false,
      beforeDigest,
      afterDigest,
      reason: "The plugin changed the scene encoding; no cross-encoding equivalence is claimed.",
    };
  }
  const nonSceneBytesEqual =
    sourceWithoutGeneratedSceneBytes(beforeMarkdown, beforeDocument) ===
    sourceWithoutGeneratedSceneBytes(afterMarkdown, afterDocument);
  if (beforeDocument.scene.encoding === "compressed-json") {
    return {
      equal: false,
      kind: "unsupported-compressed-change",
      encoding: "compressed-json",
      nonSceneBytesEqual,
      beforeDigest,
      afterDigest,
      reason: "Compressed-json is opaque to Threadleaf and requires the unchanged plugin codec.",
    };
  }
  const beforeScene = parseUncompressedExcalidrawScene(beforeMarkdown);
  const afterScene = parseUncompressedExcalidrawScene(afterMarkdown);
  const beforeSceneDigest = canonicalExcalidrawSceneDigest(beforeScene);
  const afterSceneDigest = canonicalExcalidrawSceneDigest(afterScene);
  const generatedTextSectionsMatch =
    generatedTextSectionMatchesScene(beforeMarkdown, beforeScene) &&
    generatedTextSectionMatchesScene(afterMarkdown, afterScene);
  return {
    equal:
      nonSceneBytesEqual && beforeSceneDigest === afterSceneDigest && generatedTextSectionsMatch,
    kind: "semantic",
    encoding: "json",
    nonSceneBytesEqual,
    beforeDigest,
    afterDigest,
    beforeSceneDigest,
    afterSceneDigest,
    ...(nonSceneBytesEqual && beforeSceneDigest === afterSceneDigest && generatedTextSectionsMatch
      ? {}
      : {
          reason:
            "Non-scene Markdown bytes, generated text mappings, or canonical scene semantics changed.",
        }),
  };
}

/** Extract only Markdown image embeds; ordinary note links are not attachment claims. */
export function extractExcalidrawAttachmentReferences(markdown: string): string[] {
  const references = new Set<string>();
  for (const match of markdown.matchAll(markdownImagePattern)) {
    const raw = match[0];
    const wiki = raw.match(wikiTargetPattern);
    const markdownLink = raw.match(markdownTargetPattern);
    const target = wiki?.[1] ?? markdownLink?.[1];
    if (target) {
      references.add(normalizePath(target.trim()));
    }
  }
  return [...references].sort((left, right) => left.localeCompare(right, "en"));
}

/** Rewrite one exact attachment target in Markdown image embeds. Other text remains untouched. */
export function rewriteExcalidrawAttachmentReference(
  markdown: string,
  fromPath: string,
  toPath: string,
): { markdown: string; replacements: number } {
  const from = normalizePath(fromPath);
  const to = normalizePath(toPath);
  let replacements = 0;
  const rewritten = markdown.replace(markdownImagePattern, (raw) => {
    const wiki = raw.match(wikiTargetPattern);
    if (wiki?.[1] && normalizePath(wiki[1].trim()) === from) {
      replacements += 1;
      return raw.replace(wiki[1], to);
    }
    const markdownLink = raw.match(markdownTargetPattern);
    if (markdownLink?.[1] && normalizePath(markdownLink[1].trim()) === from) {
      replacements += 1;
      return raw.replace(markdownLink[1], to);
    }
    return raw;
  });
  return { markdown: rewritten, replacements };
}

export async function createExcalidrawAttachmentManifest(
  vaultRoot: string,
  relativePaths: readonly string[],
): Promise<ExcalidrawAttachmentManifest> {
  const entries = await Promise.all(
    [...new Set(relativePaths.map(assertSafeRelativePath))]
      .sort((left, right) => left.localeCompare(right, "en"))
      .map(async (relative) => {
        const bytes = await fs.readFile(path.join(vaultRoot, relative));
        return {
          path: relative,
          size: bytes.byteLength,
          sha256: sha256(bytes),
          mime: mimeForPath(relative),
        } satisfies ExcalidrawAttachmentManifestEntry;
      }),
  );
  return { schemaVersion: excalidrawRoundtripSchemaVersion, entries };
}

export function compareExcalidrawAttachmentManifests(
  expected: ExcalidrawAttachmentManifest,
  actual: ExcalidrawAttachmentManifest,
): { equal: boolean; missing: string[]; changed: string[]; unexpected: string[] } {
  const expectedByPath = new Map(expected.entries.map((entry) => [entry.path, entry]));
  const actualByPath = new Map(actual.entries.map((entry) => [entry.path, entry]));
  const missing = [...expectedByPath.keys()].filter((entry) => !actualByPath.has(entry));
  const unexpected = [...actualByPath.keys()].filter((entry) => !expectedByPath.has(entry));
  const changed = [...expectedByPath.keys()].filter((entry) => {
    const left = expectedByPath.get(entry);
    const right = actualByPath.get(entry);
    return right !== undefined && JSON.stringify(left) !== JSON.stringify(right);
  });
  return {
    equal: missing.length === 0 && changed.length === 0 && unexpected.length === 0,
    missing: missing.sort((left, right) => left.localeCompare(right, "en")),
    changed: changed.sort((left, right) => left.localeCompare(right, "en")),
    unexpected: unexpected.sort((left, right) => left.localeCompare(right, "en")),
  };
}
