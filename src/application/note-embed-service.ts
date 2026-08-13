import MarkdownIt from "markdown-it";
import { maskMarkdownCodeAndComments, parseMarkdownLinks } from "../kernel/markdown-links";
import { type DocumentMetadataSnapshot, VaultLinkResolver } from "../kernel/metadata-index";
import { hasPrivateVaultSegment, normalizeVaultPath, VaultPathError } from "../kernel/path-policy";
import type { BinaryReadResult } from "../kernel/vault-kernel";
import type {
  VaultNoteEmbedResponse,
  VaultNoteEmbedUnavailableReason,
  WorkspaceLinkSummary,
} from "../shared/contracts";

export const DEFAULT_VAULT_NOTE_EMBED_MAX_BYTES = 2 * 1024 * 1024;
const maxTargetLength = 4_096;
const maxSubpathLength = 512;
const blockIdPattern = /^[\p{L}\p{N}-]+$/u;
const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export interface VaultNoteEmbedReader {
  readonly vaultId: string;
  resolveReadPath(relativePath: string): Promise<string>;
  readBinary(relativePath: string, maxBytes: number): Promise<BinaryReadResult>;
}

export interface VaultNoteEmbedLoadOptions {
  maxBytes?: number;
}

interface ExtractedEmbed {
  content: string;
  endLine: number;
  kind: "note" | "heading" | "block";
  startLine: number;
  subpath: string | null;
}

interface ResolvedEmbedTarget {
  path: string;
  resolver: VaultLinkResolver;
}

interface RejectedEmbedTarget {
  message: string;
  reason: VaultNoteEmbedUnavailableReason;
}

interface NoteSourceLine {
  text: string;
  ending: "" | "lf" | "crlf" | "cr";
}

function sourceLines(content: string): NoteSourceLine[] {
  const lines: NoteSourceLine[] = [];
  let start = 0;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index] ?? "";
    if (character !== "\r" && character !== "\n") continue;
    const ending =
      character === "\r" && content[index + 1] === "\n" ? "crlf" : character === "\r" ? "cr" : "lf";
    lines.push({ text: content.slice(start, index), ending });
    index += ending === "crlf" ? 1 : 0;
    start = index + 1;
  }
  lines.push({ text: content.slice(start), ending: "" });
  return lines;
}

function endingBytes(ending: NoteSourceLine["ending"]): string {
  return ending === "crlf" ? "\r\n" : ending === "cr" ? "\r" : ending === "lf" ? "\n" : "";
}

function joinSourceLines(lines: readonly NoteSourceLine[]): string {
  return lines
    .map((line, index) => `${line.text}${index + 1 < lines.length ? endingBytes(line.ending) : ""}`)
    .join("");
}

function unavailable(
  vaultId: string,
  reason: VaultNoteEmbedUnavailableReason,
  message: string,
): VaultNoteEmbedResponse {
  return { status: "unavailable", vaultId, reason, message };
}

function decodePortableTarget(rawTarget: string): string | null {
  const trimmed = rawTarget.trim();
  const unwrapped =
    trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1).trim() : trimmed;
  try {
    return decodeURIComponent(unwrapped).replaceAll("\\", "/");
  } catch {
    return null;
  }
}

function normalizeSourcePath(sourceNotePath: string): string | null {
  try {
    const normalized = normalizeVaultPath(sourceNotePath);
    return normalized.toLocaleLowerCase("en-US").endsWith(".md") &&
      !hasPrivateVaultSegment(normalized)
      ? normalized
      : null;
  } catch {
    return null;
  }
}

export function resolveVaultNoteEmbedTarget(
  documents: readonly Pick<DocumentMetadataSnapshot, "path">[],
  sourceNotePath: string,
  rawTarget: string,
): ResolvedEmbedTarget | RejectedEmbedTarget {
  const sourcePath = normalizeSourcePath(sourceNotePath);
  if (!sourcePath) {
    return {
      reason: "invalid",
      message: "The source note path is not a visible Markdown note.",
    };
  }
  const paths = documents.map(({ path }) => path);
  if (!paths.includes(sourcePath)) {
    return {
      reason: "missing",
      message: "The source note is no longer present in the current vault index.",
    };
  }
  if (rawTarget.length > maxTargetLength || rawTarget.includes("\0")) {
    return {
      reason: "invalid",
      message: "The embedded note target is malformed or too long.",
    };
  }
  const target = decodePortableTarget(rawTarget);
  if (target === null || target.includes("#") || target.includes("^")) {
    return {
      reason: "invalid",
      message: "The embedded note target is not a valid portable note identity.",
    };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) {
    return {
      reason: "external",
      message: "External documents are never loaded as note transclusions.",
    };
  }

  const resolver = new VaultLinkResolver(paths);
  const resolution = resolver.resolve(sourcePath, target);
  if (resolution.status === "ambiguous") {
    return {
      reason: "ambiguous",
      message: "The embedded note target has more than one possible destination.",
    };
  }
  if (resolution.status !== "resolved" || !resolution.path) {
    return {
      reason: "missing",
      message: "The embedded note target does not resolve in the current vault index.",
    };
  }
  if (hasPrivateVaultSegment(resolution.path)) {
    return {
      reason: "private",
      message: "Application configuration and transaction files are never transcluded.",
    };
  }
  return { path: resolution.path, resolver };
}

function decodeSubpath(subpath: string): string | null {
  try {
    return decodeURIComponent(subpath).normalize("NFC");
  } catch {
    return null;
  }
}

function normalizedHeading(value: string): string {
  return value
    .replace(/\s+#+\s*$/, "")
    .trim()
    .normalize("NFC")
    .toLocaleLowerCase("en-US");
}

function extractHeading(content: string, decodedSubpath: string): ExtractedEmbed | null {
  const target = normalizedHeading(decodedSubpath.slice(1));
  if (!target) {
    return null;
  }
  const lines = sourceLines(content);
  const maskedLines = sourceLines(maskMarkdownCodeAndComments(content));
  const headings: Array<{ index: number; level: number; text: string }> = [];
  for (let index = 0; index < maskedLines.length; index += 1) {
    const searchableLine = (maskedLines[index]?.text ?? "").replace(/^\uFEFF/u, "");
    const match = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(searchableLine);
    if (match?.[1] && match[2]) {
      headings.push({ index, level: match[1].length, text: match[2] });
    }
  }
  const headingIndex = headings.findIndex(({ text }) => normalizedHeading(text) === target);
  const heading = headings[headingIndex];
  if (!heading) {
    return null;
  }
  const next = headings.slice(headingIndex + 1).find(({ level }) => level <= heading.level);
  let endIndex = next?.index ?? lines.length;
  while (endIndex > heading.index + 1 && (lines[endIndex - 1]?.text ?? "").trim() === "") {
    endIndex -= 1;
  }
  return {
    content: joinSourceLines(lines.slice(heading.index, endIndex)),
    startLine: heading.index + 1,
    endLine: Math.max(heading.index + 1, endIndex),
    kind: "heading",
    subpath: decodedSubpath,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractBlock(content: string, decodedSubpath: string): ExtractedEmbed | null {
  const blockId = decodedSubpath.slice(1);
  if (!blockIdPattern.test(blockId)) {
    return null;
  }
  const lines = sourceLines(content);
  const masked = maskMarkdownCodeAndComments(content);
  const maskedLines = sourceLines(masked);
  const marker = new RegExp(`(?:^|\\s)\\^${escapeRegExp(blockId)}\\s*$`, "u");
  const matchingLines = maskedLines
    .map((line, index) => (marker.test(line.text) ? index : -1))
    .filter((index) => index >= 0);
  if (matchingLines.length !== 1) {
    return null;
  }
  const lineIndex = matchingLines[0] ?? 0;
  // Markdown-it accepts LF as the portable line separator, while source
  // lines may be CR-only or mixed.  Parse a line-equivalent projection so
  // token maps still identify the original line numbers; return the original
  // bytes below.
  const parserSource = maskedLines.map((line) => line.text).join("\n");
  const candidates = markdown
    .parse(parserSource, {})
    .filter(
      (token) =>
        token.map &&
        token.map[0] <= lineIndex &&
        lineIndex < token.map[1] &&
        (token.nesting === 1 || token.type === "fence" || token.type === "code_block"),
    )
    .map((token) => token.map as [number, number])
    .sort((left, right) => left[1] - left[0] - (right[1] - right[0]));
  const [startIndex, endIndex] = candidates[0] ?? [lineIndex, lineIndex + 1];
  const fragmentLines = lines.slice(startIndex, endIndex);
  const relativeLine = lineIndex - startIndex;
  const matchingLine = fragmentLines[relativeLine];
  if (matchingLine) {
    matchingLine.text = matchingLine.text.replace(marker, "").trimEnd();
  }
  while (fragmentLines.at(-1)?.text.trim() === "") {
    fragmentLines.pop();
  }
  return {
    content: joinSourceLines(fragmentLines),
    startLine: startIndex + 1,
    endLine: Math.max(startIndex + 1, endIndex),
    kind: "block",
    subpath: decodedSubpath,
  };
}

export function extractVaultNoteEmbed(content: string, subpath: string | null): ExtractedEmbed {
  if (subpath === null || subpath.trim() === "") {
    return {
      content,
      startLine: 1,
      endLine: Math.max(1, sourceLines(content).length),
      kind: "note",
      subpath: null,
    };
  }
  if (subpath.length > maxSubpathLength || (!subpath.startsWith("#") && !subpath.startsWith("^"))) {
    throw new Error("invalid-subpath");
  }
  const decodedSubpath = decodeSubpath(subpath);
  if (!decodedSubpath || decodedSubpath.length > maxSubpathLength) {
    throw new Error("invalid-subpath");
  }
  const extracted = decodedSubpath.startsWith("#")
    ? extractHeading(content, decodedSubpath)
    : extractBlock(content, decodedSubpath);
  if (!extracted) {
    throw new Error("missing-subpath");
  }
  return extracted;
}

function unavailableFromReadError(vaultId: string, error: unknown): VaultNoteEmbedResponse {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    return unavailable(vaultId, "missing", "The embedded note no longer exists.");
  }
  if (error instanceof VaultPathError) {
    const outside = /outside|escape/i.test(error.message);
    return unavailable(
      vaultId,
      outside ? "outside-vault" : "invalid",
      outside
        ? "The embedded note resolves outside the active vault."
        : "The embedded note path is invalid.",
    );
  }
  return unavailable(vaultId, "unreadable", "The embedded note could not be read safely.");
}

function summarizeLinks(
  content: string,
  sourcePath: string,
  resolver: VaultLinkResolver,
): WorkspaceLinkSummary[] {
  return parseMarkdownLinks(content).map((link) => {
    const resolution = resolver.resolve(sourcePath, link.target);
    return {
      label: link.alias ?? `${link.target}${link.subpath ?? ""}`,
      status: resolution.status,
      target: link.target,
      subpath: link.subpath,
      embed: link.embed,
      syntax: link.syntax,
      ...(resolution.path ? { path: resolution.path } : {}),
    };
  });
}

export async function loadVaultNoteEmbed(
  reader: VaultNoteEmbedReader,
  documents: readonly DocumentMetadataSnapshot[],
  sourceNotePath: string,
  rawTarget: string,
  subpath: string | null,
  expectedVaultId: string,
  options: VaultNoteEmbedLoadOptions = {},
): Promise<VaultNoteEmbedResponse> {
  if (expectedVaultId !== reader.vaultId) {
    return { status: "stale-vault", vaultId: reader.vaultId };
  }
  const resolution = resolveVaultNoteEmbedTarget(documents, sourceNotePath, rawTarget);
  if (!("path" in resolution)) {
    return unavailable(reader.vaultId, resolution.reason, resolution.message);
  }

  let canonicalPath: string;
  try {
    canonicalPath = await reader.resolveReadPath(resolution.path);
  } catch (error) {
    return unavailableFromReadError(reader.vaultId, error);
  }
  if (hasPrivateVaultSegment(canonicalPath)) {
    return unavailable(
      reader.vaultId,
      "private",
      "Application configuration and transaction files are never transcluded.",
    );
  }

  let result: BinaryReadResult;
  try {
    result = await reader.readBinary(
      canonicalPath,
      options.maxBytes ?? DEFAULT_VAULT_NOTE_EMBED_MAX_BYTES,
    );
  } catch (error) {
    return unavailableFromReadError(reader.vaultId, error);
  }
  if (expectedVaultId !== reader.vaultId) {
    return { status: "stale-vault", vaultId: reader.vaultId };
  }
  if (result.status === "too-large") {
    const limit = options.maxBytes ?? DEFAULT_VAULT_NOTE_EMBED_MAX_BYTES;
    return unavailable(
      reader.vaultId,
      "too-large",
      `The embedded note is larger than the ${Math.floor(limit / (1024 * 1024))} MiB transclusion limit.`,
    );
  }

  let source: string;
  try {
    source = textDecoder.decode(result.snapshot.bytes);
  } catch {
    return unavailable(reader.vaultId, "invalid", "The embedded note is not valid UTF-8 text.");
  }
  let extracted: ExtractedEmbed;
  try {
    extracted = extractVaultNoteEmbed(source, subpath);
  } catch (error) {
    const missing = error instanceof Error && error.message === "missing-subpath";
    return unavailable(
      reader.vaultId,
      missing ? "subpath-missing" : "invalid",
      missing
        ? "The requested heading or block is not present in the embedded note."
        : "The embedded note subpath is invalid or too long.",
    );
  }
  return {
    status: "ready",
    vaultId: reader.vaultId,
    path: resolution.path,
    revision: result.snapshot.revision,
    sourceSize: result.snapshot.size,
    contentBytes: Buffer.byteLength(extracted.content, "utf8"),
    content: extracted.content,
    startLine: extracted.startLine,
    endLine: extracted.endLine,
    kind: extracted.kind,
    subpath: extracted.subpath,
    links: summarizeLinks(extracted.content, resolution.path, resolution.resolver),
  };
}
