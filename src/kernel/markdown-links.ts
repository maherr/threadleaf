import MarkdownIt, { type Env, type StateBlock, type StateInline } from "markdown-it";
import { scanFrontmatter } from "./markdown-frontmatter";

interface ParsedMarkdownLinkBase {
  target: string;
  subpath: string | null;
  alias: string | null;
  embed: boolean;
  syntax: "wiki" | "markdown";
  position: number;
  end: number;
  targetStart: number;
  targetEnd: number;
  line: number;
}

/**
 * Parser-only source semantics. The public metadata snapshot intentionally
 * retains its stable `wiki` / `markdown` syntax contract.
 */
export type ParsedMarkdownLink =
  | (ParsedMarkdownLinkBase & { sourceKind: "wiki" })
  | (ParsedMarkdownLinkBase & { sourceKind: "markdown-inline" })
  | (ParsedMarkdownLinkBase & { sourceKind: "markdown-reference-definition" });

export interface MarkdownDestinationTarget {
  path: string;
  /** The source-preserved query/fragment suffix, beginning at `?` or `#`. */
  suffix: string;
  bareName: boolean;
}

export interface SplitMarkdownDestinationTarget {
  target: string;
  subpath: string | null;
}

/** A visible reference-style link or image usage, without resolving its definition. */
export interface ParsedMarkdownReferenceUsage {
  label: string;
  embed: boolean;
  position: number;
  end: number;
  line: number;
  /** Exact source fragments for a renderer-derived, multi-line usage. */
  sourceRanges?: MaskRange[];
  /** Exact source fragments that supply the normalized reference label. */
  labelSourceRanges?: MaskRange[];
  /** False when a renderer-live usage has no reliable source-fragment map. */
  sourceMappable?: boolean;
}

/** A visible reference definition and whether its destination is syntactically usable. */
export interface ParsedMarkdownReferenceDefinition {
  label: string;
  valid: boolean;
  external: boolean;
  line: number;
}

/**
 * A reference-definition candidate, including source-only frontmatter evidence
 * that a mutation planner must retain without treating it as a visible link.
 */
export interface ParsedMarkdownReferenceDefinitionCandidate
  extends ParsedMarkdownReferenceDefinition {
  /** The parsed local or external destination when the definition is valid. */
  target: string | null;
  /** The exact raw destination token, or remaining source after `:` when opaque. */
  rawTarget: string;
  /** Exact source range for a valid destination; null for an opaque definition. */
  targetStart: number | null;
  targetEnd: number | null;
  /** Offset of the definition marker in the original Markdown source. */
  position: number;
  /** True only for a definition inside YAML frontmatter. */
  sourceOnly: boolean;
  /** True for a one-line definition head with an unsupported destination continuation. */
  multilineContinuation?: boolean;
}

const markdownEscapes = "\\!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

export function normalizeMarkdownReferenceLabel(value: string): string {
  return unescapeMarkdownDestination(value).trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function unescapeMarkdownDestination(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const next = value[index + 1];
    if (
      character === "\\" &&
      next !== undefined &&
      (next.trim() === "" || markdownEscapes.includes(next))
    ) {
      result += next;
      index += 1;
    } else {
      result += character;
    }
  }
  return result;
}

/** Normalizes a Markdown destination without deciding whether it is local. */
export function normalizeMarkdownDestination(value: string): string {
  const trimmed = value.trim();
  const unwrapped =
    trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1).trim() : trimmed;
  try {
    return unescapeMarkdownDestination(decodeURIComponent(unwrapped)).replaceAll("\\", "/");
  } catch {
    return unescapeMarkdownDestination(unwrapped).replaceAll("\\", "/");
  }
}

function unescapedDelimiterIndex(value: string, delimiters: readonly string[]): number {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\\") {
      index += 1;
      continue;
    }
    if (delimiters.includes(value[index] ?? "")) return index;
  }
  return -1;
}

/**
 * Splits one source destination into a normalized path and an untouched
 * query/fragment suffix. Escaped `\\?` and `\\#` are filename bytes, not
 * delimiters. The caller supplies only the destination token, not a title.
 */
export function parseMarkdownDestinationTarget(value: string): MarkdownDestinationTarget | null {
  const trimmed = value.trim();
  const unwrapped =
    trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1).trim() : trimmed;
  if (!unwrapped) return null;
  const separator = unescapedDelimiterIndex(unwrapped, ["?", "#"]);
  const rawPath = separator === -1 ? unwrapped : unwrapped.slice(0, separator);
  const normalizedPath = normalizeMarkdownDestination(rawPath).trim();
  if (!normalizedPath) return null;
  return {
    path: normalizedPath,
    suffix: separator === -1 ? "" : unwrapped.slice(separator),
    bareName: !normalizedPath.replace(/^\/+/, "").includes("/"),
  };
}

/** Splits a destination for renderer navigation while honoring escaped `#`/`^`. */
export function splitMarkdownDestinationTarget(value: string): SplitMarkdownDestinationTarget {
  const trimmed = value.trim();
  const unwrapped =
    trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1).trim() : trimmed;
  const marker = unescapedDelimiterIndex(unwrapped, ["#", "^"]);
  const targetToken = marker === -1 ? unwrapped : unwrapped.slice(0, marker);
  const parsed = parseMarkdownDestinationTarget(targetToken) ?? {
    path: normalizeMarkdownDestination(targetToken).trim(),
  };
  return {
    target: parsed.path,
    subpath: marker === -1 ? null : unwrapped.slice(marker).trim() || null,
  };
}

function normalizeLinkTarget(value: string): string {
  return normalizeMarkdownDestination(value);
}

function normalizeSubpath(value: string): string | null {
  if (!value.trim()) return null;
  try {
    return decodeURIComponent(value).trim() || null;
  } catch {
    return value.trim() || null;
  }
}

function isExternalLink(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/iu.test(value) || value.startsWith("//");
}

function subpathOffset(value: string): number {
  return unescapedDelimiterIndex(value, ["#", "^"]);
}

function trimmedRange(value: string): { start: number; end: number } {
  const start = value.length - value.trimStart().length;
  const end = value.trimEnd().length;
  return { start, end: Math.max(start, end) };
}

interface ScannedDestination {
  targetStart: number;
  targetEnd: number;
  end: number;
}

function skipWhitespace(value: string, index: number): number {
  let cursor = index;
  while (cursor < value.length && /\s/u.test(value[cursor] ?? "")) cursor += 1;
  return cursor;
}

function scanTitle(value: string, index: number): number | null {
  const opener = value[index];
  if (opener !== '"' && opener !== "'" && opener !== "(") return null;
  const closer = opener === "(" ? ")" : opener;
  let depth = opener === "(" ? 1 : 0;
  for (let cursor = index + 1; cursor < value.length; cursor += 1) {
    const character = value[cursor];
    if (character === "\\") {
      cursor += 1;
      continue;
    }
    if (opener === "(" && character === "(") {
      depth += 1;
      continue;
    }
    if (character === closer) {
      if (opener === "(" && --depth > 0) continue;
      return cursor + 1;
    }
  }
  return null;
}

/** Scans an inline `(destination "optional title")` source range. */
function scanInlineDestination(value: string, openParen: number): ScannedDestination | null {
  let cursor = skipWhitespace(value, openParen + 1);
  if (cursor >= value.length) return null;

  if (value[cursor] === "<") {
    const targetStart = cursor + 1;
    cursor = targetStart;
    while (cursor < value.length) {
      const character = value[cursor];
      if (character === "\\") {
        cursor += 2;
        continue;
      }
      if (character === ">") {
        const targetEnd = cursor;
        const afterDestination = skipWhitespace(value, cursor + 1);
        if (value[afterDestination] === ")") {
          return { targetStart, targetEnd, end: afterDestination + 1 };
        }
        const afterTitle = scanTitle(value, afterDestination);
        const close = afterTitle === null ? -1 : skipWhitespace(value, afterTitle);
        return close >= 0 && value[close] === ")"
          ? { targetStart, targetEnd, end: close + 1 }
          : null;
      }
      if (character === "<") return null;
      cursor += 1;
    }
    return null;
  }

  const targetStart = cursor;
  let depth = 0;
  while (cursor < value.length) {
    const character = value[cursor];
    if (character === "\\") {
      cursor += 2;
      continue;
    }
    if (character === "(") {
      depth += 1;
      cursor += 1;
      continue;
    }
    if (character === ")") {
      if (depth === 0) {
        if (cursor === targetStart) return null;
        return { targetStart, targetEnd: cursor, end: cursor + 1 };
      }
      depth -= 1;
      cursor += 1;
      continue;
    }
    if (/\s/u.test(character ?? "") && depth === 0) break;
    cursor += 1;
  }
  if (cursor >= value.length || depth !== 0 || cursor === targetStart) return null;
  const afterTitle = scanTitle(value, skipWhitespace(value, cursor));
  const close = afterTitle === null ? -1 : skipWhitespace(value, afterTitle);
  return close >= 0 && value[close] === ")"
    ? { targetStart, targetEnd: cursor, end: close + 1 }
    : null;
}

/** Scans a reference definition destination up to the end of one source line. */
function scanDefinitionDestination(value: string, start: number): ScannedDestination | null {
  let cursor = skipWhitespace(value, start);
  if (cursor >= value.length) return null;
  if (value[cursor] === "<") {
    const targetStart = cursor + 1;
    cursor = targetStart;
    while (cursor < value.length) {
      const character = value[cursor];
      if (character === "\\") {
        cursor += 2;
        continue;
      }
      if (character === ">") {
        const targetEnd = cursor;
        const afterDestination = skipWhitespace(value, cursor + 1);
        if (afterDestination >= value.length) {
          return { targetStart, targetEnd, end: value.length };
        }
        const afterTitle = scanTitle(value, afterDestination);
        const end = afterTitle === null ? -1 : skipWhitespace(value, afterTitle);
        return end >= 0 && end === value.length ? { targetStart, targetEnd, end } : null;
      }
      if (character === "<") return null;
      cursor += 1;
    }
    return null;
  }

  const targetStart = cursor;
  let depth = 0;
  while (cursor < value.length) {
    const character = value[cursor];
    if (character === "\\") {
      cursor += 2;
      continue;
    }
    if (character === "(") {
      depth += 1;
      cursor += 1;
      continue;
    }
    if (character === ")" && depth > 0) {
      depth -= 1;
      cursor += 1;
      continue;
    }
    if (/\s/u.test(character ?? "") && depth === 0) break;
    cursor += 1;
  }
  if (cursor === targetStart || depth !== 0) return null;
  const afterWhitespace = skipWhitespace(value, cursor);
  if (afterWhitespace === value.length) {
    return { targetStart, targetEnd: cursor, end: value.length };
  }
  const afterTitle = scanTitle(value, afterWhitespace);
  const end = afterTitle === null ? -1 : skipWhitespace(value, afterTitle);
  return end === value.length ? { targetStart, targetEnd: cursor, end } : null;
}

/** Finds a nested bracket close for inline link text or alt text. */
function findClosingInlineBracket(value: string, start: number): number {
  let escaped = false;
  let nested = 0;
  for (let cursor = start; cursor < value.length; cursor += 1) {
    const character = value[cursor];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "[") {
      nested += 1;
    } else if (character === "]") {
      if (nested === 0) return cursor;
      nested -= 1;
    }
  }
  return -1;
}

/**
 * Reference labels are flat. A raw nested opener is not a valid label, even
 * though inline link text may contain nested brackets.
 */
function findClosingReferenceLabel(value: string, start: number): number {
  let escaped = false;
  for (let cursor = start; cursor < value.length; cursor += 1) {
    const character = value[cursor];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "[") {
      return -1;
    } else if (character === "]") {
      return cursor;
    }
  }
  return -1;
}

function hasOddBackslashEscape(value: string, index: number): boolean {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    count += 1;
  }
  return count % 2 === 1;
}

function parseWikiLinks(
  sourceLine: string,
  searchableLine: string,
  lineStart: number,
  lineNumber: number,
): ParsedMarkdownLink[] {
  const links: ParsedMarkdownLink[] = [];
  let cursor = 0;
  while (cursor < searchableLine.length) {
    const markerStart = searchableLine.indexOf("[[", cursor);
    if (markerStart === -1) break;
    if (hasOddBackslashEscape(searchableLine, markerStart)) {
      cursor = markerStart + 2;
      continue;
    }
    const close = sourceLine.indexOf("]]", markerStart + 2);
    if (close === -1) break;

    const escapedEmbedMarker =
      markerStart > 0 &&
      searchableLine[markerStart - 1] === "!" &&
      hasOddBackslashEscape(searchableLine, markerStart - 1);
    const embed = markerStart > 0 && searchableLine[markerStart - 1] === "!" && !escapedEmbedMarker;
    const localStart = embed ? markerStart - 1 : markerStart;
    // The preview rule takes the first `]]` on the source line. A raw single
    // `]` is therefore body text, not a reason to reject an otherwise visible
    // wiki link.
    const inner = sourceLine.slice(markerStart + 2, close);
    if (!inner.trim()) {
      cursor = close + 2;
      continue;
    }
    const aliasAt = inner.indexOf("|");
    const rawTarget = aliasAt === -1 ? inner : inner.slice(0, aliasAt);
    const subpathAt = subpathOffset(rawTarget);
    const rawTargetOnly = subpathAt === -1 ? rawTarget : rawTarget.slice(0, subpathAt);
    const targetRange = trimmedRange(rawTargetOnly);
    const position = lineStart + localStart;
    const innerStart = lineStart + markerStart + 2;
    links.push({
      target: normalizeLinkTarget(rawTargetOnly).trim(),
      subpath: normalizeSubpath(subpathAt === -1 ? "" : rawTarget.slice(subpathAt)),
      alias: aliasAt === -1 ? null : inner.slice(aliasAt + 1).trim() || null,
      embed,
      syntax: "wiki",
      sourceKind: "wiki",
      position,
      end: lineStart + close + 2,
      targetStart: innerStart + targetRange.start,
      targetEnd: innerStart + targetRange.end,
      line: lineNumber,
    });
    cursor = close + 2;
  }
  return links;
}

function maskParsedLinkRanges(
  value: string,
  links: readonly Pick<ParsedMarkdownLink, "position" | "end">[],
  lineStart: number,
): string {
  return applyMaskRanges(
    value,
    links.map((link) => ({
      start: link.position - lineStart,
      end: link.end - lineStart,
    })),
  );
}

function parseReferenceDefinition(
  definition: ParsedMarkdownReferenceDefinitionCandidate,
  end: number,
): ParsedMarkdownLink | null {
  if (
    !definition.valid ||
    definition.external ||
    !definition.target ||
    definition.targetStart === null ||
    definition.targetEnd === null
  ) {
    return null;
  }
  const subpathAt = subpathOffset(definition.rawTarget);
  return {
    target: definition.target,
    subpath: normalizeSubpath(subpathAt === -1 ? "" : definition.rawTarget.slice(subpathAt)),
    alias: null,
    embed: false,
    syntax: "markdown",
    sourceKind: "markdown-reference-definition",
    position: definition.position,
    end,
    targetStart: definition.targetStart,
    targetEnd: definition.targetEnd,
    line: definition.line,
  };
}

function parseInlineLinks(
  sourceLine: string,
  searchableLine: string,
  lineStart: number,
  lineNumber: number,
): ParsedMarkdownLink[] {
  const links: ParsedMarkdownLink[] = [];
  let cursor = 0;
  while (cursor < searchableLine.length) {
    const marker = searchableLine.indexOf("[", cursor);
    if (marker === -1) break;
    const embed =
      marker > 0 &&
      searchableLine[marker - 1] === "!" &&
      !hasOddBackslashEscape(searchableLine, marker - 1);
    const position = embed ? marker - 1 : marker;
    if (hasOddBackslashEscape(searchableLine, position)) {
      cursor = marker + 1;
      continue;
    }
    const closeBracket = findClosingInlineBracket(searchableLine, marker + 1);
    if (closeBracket === -1 || searchableLine[closeBracket + 1] !== "(") {
      cursor = marker + 1;
      continue;
    }
    const destination = scanInlineDestination(searchableLine, closeBracket + 1);
    if (!destination) {
      cursor = closeBracket + 2;
      continue;
    }
    const rawDestination = sourceLine.slice(destination.targetStart, destination.targetEnd);
    const subpathAt = subpathOffset(rawDestination);
    const rawTargetOnly = subpathAt === -1 ? rawDestination : rawDestination.slice(0, subpathAt);
    const targetRange = trimmedRange(rawTargetOnly);
    const normalizedTarget = normalizeLinkTarget(rawTargetOnly).trim();
    if ((!normalizedTarget && subpathAt === -1) || isExternalLink(normalizedTarget)) {
      cursor = destination.end;
      continue;
    }
    links.push({
      target: normalizedTarget,
      subpath: normalizeSubpath(subpathAt === -1 ? "" : rawDestination.slice(subpathAt)),
      alias: null,
      embed,
      syntax: "markdown",
      sourceKind: "markdown-inline",
      position: lineStart + position,
      end: lineStart + destination.end,
      targetStart: lineStart + destination.targetStart + targetRange.start,
      targetEnd: lineStart + destination.targetStart + targetRange.end,
      line: lineNumber,
    });
    cursor = destination.end;
  }
  return links;
}

function angleTokenEnd(value: string, start: number): number {
  let quote: '"' | "'" | null = null;
  for (let cursor = start + 1; cursor < value.length; cursor += 1) {
    const character = value[cursor];
    if (quote) {
      if (character === "\\") {
        cursor += 1;
      } else if (character === quote) {
        quote = null;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return cursor + 1;
    } else if (character === "\r" || character === "\n") {
      break;
    }
  }
  return -1;
}

function isInlineAngleToken(value: string): boolean {
  const body = value.slice(1, -1);
  const autolink = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>]*$/u;
  const emailAutolink = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u;
  const htmlTag = /^\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[^<>]*)?\/?$/u;
  return autolink.test(body) || emailAutolink.test(body) || htmlTag.test(body);
}

/** Masks inline autolinks and raw HTML tags without masking their text content. */
function maskInlineAngleTokens(value: string): string {
  const ranges: MaskRange[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf("<", cursor);
    if (start === -1) break;
    const end = angleTokenEnd(value, start);
    if (end === -1) {
      cursor = start + 1;
      continue;
    }
    if (isInlineAngleToken(value.slice(start, end))) ranges.push({ start, end });
    cursor = end;
  }
  return applyMaskRanges(value, ranges);
}

function parseLine(
  sourceLine: string,
  searchableLine: string,
  lineStart: number,
  lineNumber: number,
): ParsedMarkdownLink[] {
  const inlineSearchable = maskInlineAngleTokens(searchableLine);
  const wikiLinks = parseWikiLinks(sourceLine, inlineSearchable, lineStart, lineNumber);
  const nonWikiSearchable = maskParsedLinkRanges(inlineSearchable, wikiLinks, lineStart);
  return [...wikiLinks, ...parseInlineLinks(sourceLine, nonWikiSearchable, lineStart, lineNumber)];
}

interface MaskRange {
  start: number;
  end: number;
}

function mergeMaskRanges(ranges: readonly MaskRange[]): MaskRange[] {
  const sorted = [...ranges].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const merged: MaskRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else if (range.end > range.start) merged.push({ ...range });
  }
  return merged;
}

function applyMaskRanges(content: string, ranges: readonly MaskRange[]): string {
  const merged = mergeMaskRanges(ranges);
  if (merged.length === 0) return content;
  const chunks: string[] = [];
  let cursor = 0;
  for (const range of merged) {
    chunks.push(content.slice(cursor, range.start));
    // Source offsets are UTF-16 offsets. Do not use the Unicode flag here:
    // an astral code point occupies two source code units and must become two spaces.
    chunks.push(content.slice(range.start, range.end).replace(/[^\r\n]/g, " "));
    cursor = range.end;
  }
  chunks.push(content.slice(cursor));
  return chunks.join("");
}

function yamlFrontmatterRanges(content: string): MaskRange[] {
  const scan = scanFrontmatter(content);
  if (scan.status === "none") return [];
  if (scan.status === "unresolved") return [{ start: 0, end: content.length }];
  const ranges: MaskRange[] = [];
  const lines = content.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? [];
  let offset = 0;
  for (let index = 0; index < (scan.closingLine ?? 0); index += 1) {
    const full = lines[index] ?? "";
    ranges.push({ start: offset, end: offset + full.length });
    offset += full.length;
  }
  return ranges;
}

const markdownBlockClassifier = new MarkdownIt({
  breaks: false,
  html: true,
  linkify: false,
  typographer: false,
});

const opaqueMarkdownBlockTypes = new Set(["code_block", "fence", "html_block"]);

/** Uses the preview engine's block grammar while retaining original byte offsets. */
function rendererOpaqueBlockRanges(content: string): MaskRange[] {
  const lineStarts = [0];
  for (const match of content.matchAll(/\r\n|\r|\n/gu)) {
    lineStarts.push((match.index ?? 0) + match[0].length);
  }
  if (lineStarts.at(-1) !== content.length) lineStarts.push(content.length);

  const ranges: MaskRange[] = [];
  for (const token of markdownBlockClassifier.parse(content, {})) {
    if (!opaqueMarkdownBlockTypes.has(token.type) || !token.map) continue;
    const start = lineStarts[token.map[0]];
    const end = lineStarts[token.map[1]] ?? content.length;
    if (start !== undefined) ranges.push({ start, end });
  }
  return ranges;
}

function classifyThreadleafMathBlock(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  const beginning = state.bMarks[startLine] ?? 0;
  const end = state.eMarks[startLine] ?? beginning;
  const marker = state.src.slice(beginning, end).trim();
  const closing = marker === "$$" ? "$$" : marker === "\\[" ? "\\]" : null;
  if (!closing) return false;

  let closingLine = -1;
  for (
    let nextLine = startLine + 1;
    nextLine < endLine && nextLine - startLine <= 256;
    nextLine += 1
  ) {
    const nextStart = state.bMarks[nextLine] ?? 0;
    const nextEnd = state.eMarks[nextLine] ?? nextStart;
    if (state.src.slice(nextStart, nextEnd).trim() === closing) {
      closingLine = nextLine;
      break;
    }
  }
  if (closingLine < 0) return false;
  if (silent) return true;

  const token = state.push("threadleaf_math_block", "div", 0);
  token.block = true;
  token.map = [startLine, closingLine + 1];
  state.line = closingLine + 1;
  return true;
}

const markdownMathBlockClassifier = new MarkdownIt({
  breaks: false,
  html: true,
  linkify: false,
  typographer: false,
});

markdownMathBlockClassifier.block.ruler.before(
  "fence",
  "threadleaf_math_block",
  classifyThreadleafMathBlock,
);

interface RendererReferenceContext {
  /** Physical source line where MarkdownIt's renderer rule began. */
  line: number;
  /** Exclusive physical source line after MarkdownIt's accepted construct. */
  endLine: number;
  /** Exact original-source range for the first logical source segment. */
  start: number;
  /** Exact original-source range for the last logical source segment. */
  end: number;
  /** Logical source segments consumed by MarkdownIt's renderer rule. */
  segments: MaskRange[];
}

interface RendererReferenceDefinitionContext extends RendererReferenceContext {}

interface RendererReferenceUsageToken {
  label: string;
  embed: boolean;
}

interface RendererReferenceUsageContext extends RendererReferenceContext {
  /** Final inline source accepted by MarkdownIt's core inline pass. */
  content: string;
  usages: RendererReferenceUsageToken[];
}

interface RendererReferenceUsageCandidateContext extends RendererReferenceContext {
  /** The block-stage inline token; core `inline` fills its children later. */
  token: {
    type: string;
    content: string;
    children?: readonly { type: string; meta?: unknown }[] | null;
  };
}

interface RendererReferenceDefinitionEnvironment extends Env {
  threadleafReferenceDefinitionContexts: RendererReferenceDefinitionContext[];
  threadleafReferenceUsageCandidateContexts: RendererReferenceUsageCandidateContext[];
  threadleafReferenceUsageContexts: RendererReferenceUsageContext[];
  /** Maps a MarkdownIt-normalized source boundary back to the original source. */
  threadleafReferenceSourceOffsets: readonly number[];
}

interface NormalizedReferenceSource {
  content: string;
  /** Original offset at each normalized-string boundary. */
  sourceOffsets: number[];
}

/**
 * MarkdownIt normalizes CRLF and CR to LF before its block rules see them.
 * Keep that renderer behavior explicit here, while retaining a boundary map
 * for exact ranges in the unnormalized note source.
 */
function normalizeReferenceSource(content: string): NormalizedReferenceSource {
  let normalized = "";
  const sourceOffsets = [0];
  let sourceOffset = 0;
  while (sourceOffset < content.length) {
    const character = content[sourceOffset] ?? "";
    if (character === "\r") {
      normalized += "\n";
      sourceOffset += content[sourceOffset + 1] === "\n" ? 2 : 1;
    } else {
      normalized += character;
      sourceOffset += 1;
    }
    sourceOffsets.push(sourceOffset);
  }
  return { content: normalized, sourceOffsets };
}

function rendererSourceSegments(
  state: StateBlock,
  startLine: number,
  endLine: number,
  sourceOffsets: readonly number[],
): MaskRange[] {
  const segments: MaskRange[] = [];
  for (let line = startLine; line < endLine; line += 1) {
    const normalizedStart = state.bMarks[line];
    const normalizedEnd = state.eMarks[line];
    if (normalizedStart === undefined || normalizedEnd === undefined) continue;
    const start = sourceOffsets[normalizedStart];
    const end = sourceOffsets[normalizedEnd];
    if (start === undefined || end === undefined) continue;
    segments.push({ start, end });
  }
  return segments;
}

/**
 * This classifier deliberately wraps MarkdownIt's own reference block rule
 * instead of recognizing definitions from isolated physical lines.  The
 * renderer makes that rule responsible for paragraph interruption, blockquote
 * and list container prefixes, and continued title/destination lines.  Its
 * `bMarks`/`eMarks` values retain exact original offsets after those prefixes.
 */
const markdownReferenceDefinitionClassifier = new MarkdownIt({
  breaks: false,
  html: true,
  linkify: false,
  typographer: false,
});

markdownReferenceDefinitionClassifier.block.ruler.before(
  "fence",
  "threadleaf_math_block",
  classifyThreadleafMathBlock,
);

/**
 * Keep the parser-side renderer probe aligned with Reading view: a complete,
 * unescaped one-line wiki span is consumed before MarkdownIt's reference-link
 * rule has a chance to reinterpret its inner brackets.
 */
function classifyThreadleafWikiLink(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  const embed = state.src[start] === "!";
  const markerStart = embed ? start + 1 : start;
  if (state.src.slice(markerStart, markerStart + 2) !== "[[") return false;
  const close = state.src.indexOf("]]", markerStart + 2);
  if (close === -1 || state.src.slice(markerStart + 2, close).includes("\n")) return false;
  if (!state.src.slice(markerStart + 2, close).trim()) return false;
  if (!silent) state.push("threadleaf_wikilink", "a", 0);
  state.pos = close + 2;
  return true;
}

markdownReferenceDefinitionClassifier.inline.ruler.before(
  "image",
  "threadleaf_wikilink",
  classifyThreadleafWikiLink,
);

const markdownReferenceRule = markdownReferenceDefinitionClassifier.block.ruler.__rules__.find(
  (rule) => rule.name === "reference",
);
if (!markdownReferenceRule) {
  throw new Error("MarkdownIt reference block rule is unavailable.");
}

const markdownReferenceRuleFunction = markdownReferenceRule.fn;
markdownReferenceDefinitionClassifier.block.ruler.at(
  "reference",
  (state, startLine, endLine, silent) => {
    const accepted = markdownReferenceRuleFunction(state, startLine, endLine, silent);
    if (!accepted || silent) return accepted;
    const environment = state.env as RendererReferenceDefinitionEnvironment;
    const contexts = environment.threadleafReferenceDefinitionContexts;
    if (!Array.isArray(contexts) || state.line <= startLine) return accepted;
    const sourceOffsets = environment.threadleafReferenceSourceOffsets;
    const segments = rendererSourceSegments(state, startLine, state.line, sourceOffsets);
    const first = segments[0];
    if (first) {
      contexts.push({
        line: startLine + 1,
        endLine: state.line + 1,
        start: first.start,
        end: first.end,
        segments,
      });
    }
    return accepted;
  },
  { alt: markdownReferenceRule.alt },
);

const markdownParagraphRule = markdownReferenceDefinitionClassifier.block.ruler.__rules__.find(
  (rule) => rule.name === "paragraph",
);
if (!markdownParagraphRule) {
  throw new Error("MarkdownIt paragraph block rule is unavailable.");
}

function rendererReferenceUsageTokens(
  children: readonly { type: string; meta?: unknown }[] | null | undefined,
): RendererReferenceUsageToken[] {
  const usages: RendererReferenceUsageToken[] = [];
  for (const child of children ?? []) {
    if (child.type !== "link_open" && child.type !== "image") continue;
    if (!child.meta || typeof child.meta !== "object") continue;
    const label = (child.meta as { label?: unknown }).label;
    if (typeof label !== "string") continue;
    const normalized = normalizeMarkdownReferenceLabel(label);
    if (normalized) usages.push({ label: normalized, embed: child.type === "image" });
  }
  return usages;
}

const markdownParagraphRuleFunction = markdownParagraphRule.fn;
markdownReferenceDefinitionClassifier.block.ruler.at(
  "paragraph",
  (state, startLine, endLine, silent) => {
    const tokenStart = state.tokens.length;
    const accepted = markdownParagraphRuleFunction(state, startLine, endLine, silent);
    if (!accepted || silent) return accepted;
    const environment = state.env as RendererReferenceDefinitionEnvironment;
    const candidates = environment.threadleafReferenceUsageCandidateContexts;
    const sourceOffsets = environment.threadleafReferenceSourceOffsets;
    if (!Array.isArray(candidates) || !Array.isArray(sourceOffsets)) return accepted;
    for (const token of state.tokens.slice(tokenStart)) {
      if (token.type !== "inline" || !token.map) continue;
      const [tokenStartLine, tokenEndLine] = token.map;
      if (tokenStartLine === undefined || tokenEndLine === undefined) continue;
      const segments = rendererSourceSegments(state, tokenStartLine, tokenEndLine, sourceOffsets);
      const first = segments[0];
      const last = segments.at(-1);
      if (!first || !last) continue;
      candidates.push({
        line: tokenStartLine + 1,
        endLine: tokenEndLine + 1,
        start: first.start,
        end: last.end,
        segments,
        token,
      });
    }
    return accepted;
  },
  { alt: markdownParagraphRule.alt },
);

function rendererReferenceDefinitionContexts(
  content: string,
  frontmatterRanges: readonly MaskRange[],
): RendererReferenceDefinitionContext[] {
  // Reading view renders frontmatter as source-only text before MarkdownIt
  // sees it. Keep those exact offsets but prevent a frontmatter line from
  // becoming a visible definition in this classifier.
  const rendererSource = applyMaskRanges(content, frontmatterRanges);
  const normalizedSource = normalizeReferenceSource(rendererSource);
  const environment: RendererReferenceDefinitionEnvironment = {
    threadleafReferenceDefinitionContexts: [],
    threadleafReferenceUsageCandidateContexts: [],
    threadleafReferenceUsageContexts: [],
    threadleafReferenceSourceOffsets: normalizedSource.sourceOffsets,
  };
  markdownReferenceDefinitionClassifier.parse(normalizedSource.content, environment);
  return environment.threadleafReferenceDefinitionContexts;
}

function rendererReferenceUsageContexts(maskedContent: string): RendererReferenceUsageContext[] {
  // The physical scanner's opaque mask is source-offset preserving. Reuse it
  // exactly so MarkdownIt cannot surface references inside code, raw HTML,
  // comments, frontmatter, or recognized math blocks that Reading view treats
  // as non-link source.
  const normalizedSource = normalizeReferenceSource(maskedContent);
  const environment: RendererReferenceDefinitionEnvironment = {
    threadleafReferenceDefinitionContexts: [],
    threadleafReferenceUsageCandidateContexts: [],
    threadleafReferenceUsageContexts: [],
    threadleafReferenceSourceOffsets: normalizedSource.sourceOffsets,
  };
  markdownReferenceDefinitionClassifier.parse(normalizedSource.content, environment);
  for (const candidate of environment.threadleafReferenceUsageCandidateContexts) {
    const usages = rendererReferenceUsageTokens(candidate.token.children);
    if (usages.length > 0) {
      const { token: _token, ...context } = candidate;
      environment.threadleafReferenceUsageContexts.push({
        ...context,
        content: candidate.token.content,
        usages,
      });
    }
  }
  return environment.threadleafReferenceUsageContexts;
}

/**
 * Uses the preview's block-state math grammar so container prefixes do not
 * change the source ranges protected from link planning.
 */
function threadleafMathBlockRanges(
  content: string,
  frontmatterRanges: readonly MaskRange[],
): MaskRange[] {
  const frontmatterMasked = applyMaskRanges(content, frontmatterRanges);
  const lineStarts = [0];
  for (const match of content.matchAll(/\r\n|\r|\n/gu)) {
    lineStarts.push((match.index ?? 0) + match[0].length);
  }
  if (lineStarts.at(-1) !== content.length) lineStarts.push(content.length);

  const ranges: MaskRange[] = [];
  for (const token of markdownMathBlockClassifier.parse(frontmatterMasked, {})) {
    if (token.type !== "threadleaf_math_block" || !token.map) continue;
    const start = lineStarts[token.map[0]];
    const end = lineStarts[token.map[1]] ?? content.length;
    if (start !== undefined) ranges.push({ start, end });
  }
  return ranges;
}

function htmlCommentRanges(searchable: string): MaskRange[] {
  const ranges: MaskRange[] = [];
  let cursor = 0;
  while (cursor < searchable.length) {
    const start = searchable.indexOf("<!--", cursor);
    if (start === -1) break;
    const close = searchable.indexOf("-->", start + 4);
    const end = close === -1 ? searchable.length : close + 3;
    ranges.push({ start, end });
    cursor = end;
  }
  return ranges;
}

function inlineCodeRanges(searchable: string): MaskRange[] {
  const ranges: MaskRange[] = [];
  const runs = /`+/gu;
  let opener = runs.exec(searchable);
  while (opener) {
    const delimiterLength = opener[0].length;
    let candidate = runs.exec(searchable);
    while (candidate && candidate[0].length !== delimiterLength) candidate = runs.exec(searchable);
    if (!candidate) {
      runs.lastIndex = (opener.index ?? 0) + delimiterLength;
    } else {
      const start = opener.index ?? 0;
      const end = (candidate.index ?? start) + delimiterLength;
      ranges.push({ start, end });
      runs.lastIndex = end;
    }
    opener = runs.exec(searchable);
  }
  return ranges;
}

export function maskMarkdownCodeAndComments(content: string): string {
  const frontmatterRanges = yamlFrontmatterRanges(content);
  const rendererBlockRanges = rendererOpaqueBlockRanges(content);
  const mathBlockRanges = threadleafMathBlockRanges(content, frontmatterRanges);
  const blockRanges = [...rendererBlockRanges, ...mathBlockRanges];
  const blockMask = applyMaskRanges(content, [...frontmatterRanges, ...blockRanges]);
  const structuralRanges = mergeMaskRanges([
    ...frontmatterRanges,
    ...blockRanges,
    ...htmlCommentRanges(blockMask),
  ]);
  const structuralMask = applyMaskRanges(content, structuralRanges);
  return applyMaskRanges(content, [...structuralRanges, ...inlineCodeRanges(structuralMask)]);
}

function parseMarkdownReferenceDefinitionCandidate(
  sourceLine: string,
  searchableLine: string,
  lineStart: number,
  lineNumber: number,
  sourceOnly: boolean,
): ParsedMarkdownReferenceDefinitionCandidate | null {
  // Frontmatter is intentionally source-only. Its candidates must remain
  // inspectable by a mutation planner even though normal link parsing masks it.
  const definitionLine = sourceOnly ? sourceLine : searchableLine;
  const leading = definitionLine.match(/^ {0,3}/u)?.[0].length ?? 0;
  const cursor = leading;
  if (definitionLine[cursor] !== "[") return null;
  const close = findClosingReferenceLabel(definitionLine, cursor + 1);
  if (close === -1 || definitionLine[close + 1] !== ":") return null;
  const label = normalizeMarkdownReferenceLabel(sourceLine.slice(cursor + 1, close));
  if (!label) return null;

  const base = {
    label,
    line: lineNumber,
    position: lineStart + leading,
    sourceOnly,
  };
  const destination = scanDefinitionDestination(definitionLine, close + 2);
  if (!destination) {
    return {
      ...base,
      valid: false,
      external: false,
      target: null,
      rawTarget: sourceLine.slice(close + 2),
      targetStart: null,
      targetEnd: null,
    };
  }
  const rawDestination = sourceLine.slice(destination.targetStart, destination.targetEnd);
  const subpathAt = subpathOffset(rawDestination);
  const rawTargetOnly = subpathAt === -1 ? rawDestination : rawDestination.slice(0, subpathAt);
  const normalizedTarget = normalizeLinkTarget(rawTargetOnly).trim();
  if (!normalizedTarget) {
    return {
      ...base,
      valid: false,
      external: false,
      target: null,
      rawTarget: rawDestination,
      targetStart: null,
      targetEnd: null,
    };
  }
  const targetRange = trimmedRange(rawTargetOnly);
  return {
    ...base,
    valid: true,
    external: isExternalLink(normalizedTarget),
    target: normalizedTarget,
    rawTarget: rawDestination,
    targetStart: lineStart + destination.targetStart + targetRange.start,
    targetEnd: lineStart + destination.targetStart + targetRange.end,
  };
}

function opaqueRendererReferenceDefinitionCandidate(
  sourceLine: string,
  lineStart: number,
  lineNumber: number,
): ParsedMarkdownReferenceDefinitionCandidate | null {
  const leading = sourceLine.match(/^ {0,3}/u)?.[0].length ?? 0;
  const close =
    sourceLine[leading] === "[" ? findClosingReferenceLabel(sourceLine, leading + 1) : -1;
  if (close === -1 || sourceLine[close + 1] !== ":") return null;
  const label = normalizeMarkdownReferenceLabel(sourceLine.slice(leading + 1, close));
  if (!label) return null;
  return {
    label,
    valid: false,
    external: false,
    target: null,
    rawTarget: sourceLine.slice(close + 2),
    targetStart: null,
    targetEnd: null,
    line: lineNumber,
    position: lineStart + leading,
    sourceOnly: false,
  };
}

interface LogicalReferenceDefinitionSegment extends MaskRange {
  logicalStart: number;
  logicalEnd: number;
}

interface LogicalReferenceDefinitionSource {
  content: string;
  segments: LogicalReferenceDefinitionSegment[];
}

/**
 * MarkdownIt reports one source segment for each physical line it consumed,
 * after stripping block container prefixes. Rejoin those semantic segments
 * with normalized line breaks, then map only ranges wholly owned by a source
 * segment back to UTF-16 source offsets.
 */
function logicalRendererReferenceSource(
  source: string,
  context: RendererReferenceContext,
): LogicalReferenceDefinitionSource {
  let content = "";
  const segments: LogicalReferenceDefinitionSegment[] = [];
  for (const [index, segment] of context.segments.entries()) {
    if (index > 0) content += "\n";
    const logicalStart = content.length;
    content += source.slice(segment.start, segment.end);
    segments.push({ ...segment, logicalStart, logicalEnd: content.length });
  }
  return { content, segments };
}

function sourceSegmentForLogicalRange(
  segments: readonly LogicalReferenceDefinitionSegment[],
  start: number,
  end: number,
): LogicalReferenceDefinitionSegment | null {
  return (
    segments.find((segment) => start >= segment.logicalStart && end <= segment.logicalEnd) ?? null
  );
}

function originalOffsetForLogicalOffset(
  segment: LogicalReferenceDefinitionSegment,
  offset: number,
): number {
  return segment.start + offset - segment.logicalStart;
}

function originalSourceRangesForLogicalRange(
  segments: readonly LogicalReferenceDefinitionSegment[],
  logicalStart: number,
  logicalEnd: number,
): MaskRange[] | null {
  if (logicalStart < 0 || logicalEnd < logicalStart) return null;
  const ranges: MaskRange[] = [];
  let mappedLength = 0;
  for (const segment of segments) {
    const start = Math.max(logicalStart, segment.logicalStart);
    const end = Math.min(logicalEnd, segment.logicalEnd);
    if (end <= start) continue;
    ranges.push({
      start: originalOffsetForLogicalOffset(segment, start),
      end: originalOffsetForLogicalOffset(segment, end),
    });
    mappedLength += end - start;
  }
  // Every segment join adds exactly one logical LF. That LF represents the
  // original line boundary but must not be stretched across a blockquote/list
  // prefix when we report exact source fragments.
  const joinedLineBreaks = segments.slice(1).filter((segment) => {
    const separator = segment.logicalStart - 1;
    return logicalStart <= separator && separator < logicalEnd;
  }).length;
  return mappedLength + joinedLineBreaks === logicalEnd - logicalStart ? ranges : null;
}

function logicalRangeSpansRendererSegments(
  segments: readonly LogicalReferenceDefinitionSegment[],
  logicalStart: number,
  logicalEnd: number,
): boolean {
  return (
    segments.filter(
      (segment) =>
        Math.max(logicalStart, segment.logicalStart) < Math.min(logicalEnd, segment.logicalEnd),
    ).length > 1
  );
}

function sourceLineForOffset(content: string, offset: number): number {
  let line = 1;
  for (let cursor = 0; cursor < offset; cursor += 1) {
    const character = content[cursor];
    if (character === "\r") {
      line += 1;
      if (content[cursor + 1] === "\n") cursor += 1;
    } else if (character === "\n") {
      line += 1;
    }
  }
  return line;
}

interface ReferenceUsageCandidate {
  label: string;
  embed: boolean;
  position: number;
  end: number;
  labelStart: number;
  labelEnd: number;
}

/**
 * Parses one exact source segment with the same malformed, escaped, angle,
 * and wiki policy used by physical-line reference scanning. Callers keep the
 * source and opaque-mask strings offset-aligned, then choose whether returned
 * positions are physical or logical.
 */
function parseReferenceUsageCandidates(
  source: string,
  maskedSource: string,
): ReferenceUsageCandidate[] {
  const angleMasked = maskInlineAngleTokens(maskedSource);
  const wikiLinks = parseWikiLinks(source, angleMasked, 0, 1);
  const searchable = maskParsedLinkRanges(angleMasked, wikiLinks, 0);
  const usages: ReferenceUsageCandidate[] = [];
  let cursor = 0;
  while (cursor < searchable.length) {
    const bracket = searchable.indexOf("[", cursor);
    if (bracket === -1) break;
    const beforeBracket = bracket - 1;
    const possibleImage =
      searchable[beforeBracket] === "!" && !hasOddBackslashEscape(searchable, beforeBracket);
    const marker = possibleImage ? beforeBracket : bracket;
    if (hasOddBackslashEscape(searchable, marker)) {
      const escapedPseudoWikiClose =
        searchable[bracket + 1] === "[" ? findClosingReferenceLabel(searchable, bracket + 2) : -1;
      cursor = escapedPseudoWikiClose === -1 ? bracket + 1 : escapedPseudoWikiClose + 1;
      continue;
    }
    if (searchable[bracket + 1] === "[") {
      cursor = bracket + 2;
      continue;
    }
    const inlineClose = findClosingInlineBracket(searchable, bracket + 1);
    if (inlineClose === -1) {
      cursor = bracket + 1;
      continue;
    }
    if (searchable[inlineClose + 1] === "(") {
      const destination = scanInlineDestination(searchable, inlineClose + 1);
      cursor = destination ? destination.end : bracket + 1;
      continue;
    }
    if (searchable[inlineClose + 1] !== "[") {
      const close = findClosingReferenceLabel(searchable, bracket + 1);
      if (close === -1) {
        cursor = bracket + 1;
        continue;
      }
      const label = normalizeMarkdownReferenceLabel(source.slice(bracket + 1, close));
      if (label) {
        usages.push({
          label,
          embed: possibleImage,
          position: marker,
          end: close + 1,
          labelStart: bracket + 1,
          labelEnd: close,
        });
      }
      cursor = close + 1;
      continue;
    }
    const referenceClose = findClosingReferenceLabel(searchable, inlineClose + 2);
    if (referenceClose === -1) {
      cursor = bracket + 1;
      continue;
    }
    const explicit = source.slice(inlineClose + 2, referenceClose);
    const flatOuterClose = findClosingReferenceLabel(searchable, bracket + 1);
    if (!explicit && flatOuterClose !== inlineClose) {
      cursor = bracket + 1;
      continue;
    }
    const labelStart = explicit ? inlineClose + 2 : bracket + 1;
    const labelEnd = explicit ? referenceClose : inlineClose;
    const label = normalizeMarkdownReferenceLabel(source.slice(labelStart, labelEnd));
    if (label) {
      usages.push({
        label,
        embed: possibleImage,
        position: marker,
        end: referenceClose + 1,
        labelStart,
        labelEnd,
      });
    }
    cursor = referenceClose + 1;
  }
  return usages;
}

function rendererMappedReferenceUsages(
  content: string,
  maskedContent: string,
  contexts: readonly RendererReferenceUsageContext[],
): ParsedMarkdownReferenceUsage[] {
  const usages: ParsedMarkdownReferenceUsage[] = [];
  for (const context of contexts) {
    const logical = logicalRendererReferenceSource(content, context);
    const logicalMasked = logicalRendererReferenceSource(maskedContent, context);
    const logicalUsages =
      logical.content.length === logicalMasked.content.length
        ? parseReferenceUsageCandidates(logical.content, logicalMasked.content)
        : [];
    const hasLogicalMultilineUsage = logicalUsages.some((usage) =>
      logicalRangeSpansRendererSegments(logical.segments, usage.position, usage.end),
    );
    const tokenContentMatches = logicalMasked.content === context.content;
    const exactRendererSequence =
      tokenContentMatches &&
      logicalUsages.length === context.usages.length &&
      logicalUsages.every(
        (usage, index) =>
          usage.label === context.usages[index]?.label &&
          usage.embed === context.usages[index]?.embed,
      );
    if (!exactRendererSequence) {
      // Do not let a same-label lookalike steal a later renderer token. An
      // unmatched renderer-visible hard-wrapped reference is explicit source
      // evidence, and the attachment planner blocks source-related instances
      // below. A paragraph that contains only physical-line candidates must
      // stay out of this renderer-only path.
      if (hasLogicalMultilineUsage) {
        usages.push(
          ...context.usages.map((expected) => ({
            label: expected.label,
            embed: expected.embed,
            position: context.start,
            end: context.end,
            line: context.line,
            sourceMappable: false,
          })),
        );
      }
      continue;
    }
    for (const usage of logicalUsages) {
      if (!logicalRangeSpansRendererSegments(logical.segments, usage.position, usage.end)) {
        // Existing physical-line scanning owns ordinary source ranges. This
        // path is deliberately only the renderer-derived multiline extension.
        continue;
      }
      const sourceRanges = originalSourceRangesForLogicalRange(
        logical.segments,
        usage.position,
        usage.end,
      );
      const labelSourceRanges = originalSourceRangesForLogicalRange(
        logical.segments,
        usage.labelStart,
        usage.labelEnd,
      );
      if (
        !sourceRanges ||
        sourceRanges.length === 0 ||
        !labelSourceRanges ||
        labelSourceRanges.length === 0
      ) {
        usages.push({
          label: usage.label,
          embed: usage.embed,
          position: context.start,
          end: context.end,
          line: context.line,
          sourceMappable: false,
        });
        continue;
      }
      usages.push({
        label: usage.label,
        embed: usage.embed,
        position: sourceRanges[0]?.start ?? context.start,
        end: sourceRanges.at(-1)?.end ?? context.end,
        line: sourceLineForOffset(content, sourceRanges[0]?.start ?? context.start),
        sourceRanges,
        labelSourceRanges,
        sourceMappable: true,
      });
    }
  }
  return usages;
}

function rendererDefinitionCandidate(
  content: string,
  context: RendererReferenceDefinitionContext,
): ParsedMarkdownReferenceDefinitionCandidate | null {
  const logical = logicalRendererReferenceSource(content, context);
  const leading = logical.content.match(/^ {0,3}/u)?.[0].length ?? 0;
  const close =
    logical.content[leading] === "[" ? findClosingReferenceLabel(logical.content, leading + 1) : -1;
  let candidate = parseMarkdownReferenceDefinitionCandidate(
    logical.content,
    logical.content,
    0,
    context.line,
    false,
  );
  candidate ??= opaqueRendererReferenceDefinitionCandidate(logical.content, 0, context.line);
  if (!candidate) return null;

  const markerSegment = sourceSegmentForLogicalRange(
    logical.segments,
    candidate.position,
    candidate.position + 1,
  );
  const position = markerSegment
    ? originalOffsetForLogicalOffset(markerSegment, candidate.position)
    : context.start;
  const multiline = context.segments.length > 1;
  if (
    !candidate.valid ||
    candidate.targetStart === null ||
    candidate.targetEnd === null ||
    close === -1
  ) {
    return {
      ...candidate,
      position,
      ...(multiline ? { multilineContinuation: true } : {}),
    };
  }

  const colonSegment = sourceSegmentForLogicalRange(logical.segments, close + 1, close + 2);
  const targetSegment = sourceSegmentForLogicalRange(
    logical.segments,
    candidate.targetStart,
    candidate.targetEnd,
  );
  // A title may continue across renderer segments after a same-segment
  // destination. If the destination itself starts in a later segment, keep
  // the entire post-colon source opaque instead of publishing a partial write.
  if (!colonSegment || !targetSegment || colonSegment !== targetSegment) {
    return {
      ...candidate,
      valid: false,
      target: null,
      targetStart: null,
      targetEnd: null,
      position,
      rawTarget: logical.content.slice(close + 2),
      ...(multiline ? { multilineContinuation: true } : {}),
    };
  }
  return {
    ...candidate,
    position,
    targetStart: originalOffsetForLogicalOffset(targetSegment, candidate.targetStart),
    targetEnd: originalOffsetForLogicalOffset(targetSegment, candidate.targetEnd),
  };
}

/**
 * Returns each reference-definition candidate with exact destination ranges.
 * Visible definitions follow normal parser masking; YAML definitions are
 * retained as source-only evidence for mutation safety and are never emitted
 * by `parseMarkdownLinks`.
 */
export function parseMarkdownReferenceDefinitionCandidates(
  content: string,
  maskedContent = maskMarkdownCodeAndComments(content),
): ParsedMarkdownReferenceDefinitionCandidate[] {
  if (maskedContent.length !== content.length) {
    throw new Error("Masked Markdown must preserve source offsets.");
  }
  const lines = content.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? [];
  const searchableLines = maskedContent.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? [];
  const frontmatter = yamlFrontmatterRanges(content);
  const visibleDefinitions = new Map(
    rendererReferenceDefinitionContexts(content, frontmatter).map((context) => [
      context.line,
      context,
    ]),
  );
  const definitions: ParsedMarkdownReferenceDefinitionCandidate[] = [];
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const full = lines[index] ?? "";
    if (!full && index === lines.length - 1) break;
    const sourceLine = full.replace(/\r\n$|[\r\n]$/u, "");
    const searchableLine = (searchableLines[index] ?? "").replace(/\r\n$|[\r\n]$/u, "");
    const sourceOnly = frontmatter.some((range) => offset >= range.start && offset < range.end);
    const context = sourceOnly ? undefined : visibleDefinitions.get(index + 1);
    const lexicalCandidate = sourceOnly
      ? null
      : parseMarkdownReferenceDefinitionCandidate(
          sourceLine,
          searchableLine,
          offset,
          index + 1,
          false,
        );
    let candidate = sourceOnly
      ? parseMarkdownReferenceDefinitionCandidate(
          sourceLine,
          searchableLine,
          offset,
          index + 1,
          true,
        )
      : context
        ? rendererDefinitionCandidate(content, context)
        : lexicalCandidate?.valid
          ? null
          : lexicalCandidate;
    // Multi-line definition destinations are intentionally not rewritten in
    // this one-line parser. Preserve their exact raw source so the planner can
    // block source-related evidence instead of silently publishing stale links.
    if (
      candidate &&
      !candidate.sourceOnly &&
      !candidate.valid &&
      candidate.rawTarget.trim() === ""
    ) {
      let continuation = full.slice(sourceLine.length);
      let next = index + 1;
      let found = false;
      while (next < lines.length) {
        const nextFull = lines[next] ?? "";
        const nextLine = nextFull.replace(/\r\n$|[\r\n]$/u, "");
        if (!/^(?: {1,3}|\t)/u.test(nextLine)) break;
        continuation += nextFull;
        found = true;
        next += 1;
      }
      if (found && !candidate.multilineContinuation) {
        candidate = {
          ...candidate,
          rawTarget: `${candidate.rawTarget}${continuation}`,
          multilineContinuation: true,
        };
      }
    }
    if (candidate) definitions.push(candidate);
    offset += full.length;
  }
  return definitions;
}

/**
 * Returns visible reference definitions independently of their destination
 * kind. This compatibility view deliberately excludes source-only candidates.
 */
export function parseMarkdownReferenceDefinitions(
  content: string,
  maskedContent = maskMarkdownCodeAndComments(content),
): ParsedMarkdownReferenceDefinition[] {
  return parseMarkdownReferenceDefinitionCandidates(content, maskedContent)
    .filter((definition) => !definition.sourceOnly)
    .map(({ label, valid, external, line }) => ({ label, valid, external, line }));
}

/** Finds visible full, collapsed, and shortcut reference-style usages. */
export function parseMarkdownReferenceUsages(
  content: string,
  maskedContent = maskMarkdownCodeAndComments(content),
): ParsedMarkdownReferenceUsage[] {
  if (maskedContent.length !== content.length) {
    throw new Error("Masked Markdown must preserve source offsets.");
  }
  const lines = content.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? [];
  const searchableLines = maskedContent.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? [];
  const opaqueDefinitionLines = new Set<number>();
  for (const context of rendererReferenceDefinitionContexts(
    content,
    yamlFrontmatterRanges(content),
  )) {
    for (let line = context.line; line < context.endLine; line += 1) {
      opaqueDefinitionLines.add(line);
    }
  }
  const usages: ParsedMarkdownReferenceUsage[] = [];
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const full = lines[index] ?? "";
    if (!full && index === lines.length - 1) break;
    if (opaqueDefinitionLines.has(index + 1)) {
      offset += full.length;
      continue;
    }
    const sourceLine = full.replace(/\r\n$|[\r\n]$/u, "");
    const searchableLine = (searchableLines[index] ?? "").replace(/\r\n$|[\r\n]$/u, "");
    for (const usage of parseReferenceUsageCandidates(sourceLine, searchableLine)) {
      usages.push({
        label: usage.label,
        embed: usage.embed,
        position: offset + usage.position,
        end: offset + usage.end,
        line: index + 1,
      });
    }
    offset += full.length;
  }
  usages.push(
    ...rendererMappedReferenceUsages(
      content,
      maskedContent,
      rendererReferenceUsageContexts(maskedContent),
    ),
  );
  return usages.sort((left, right) => left.position - right.position || left.end - right.end);
}

export function parseMarkdownLinks(
  content: string,
  maskedContent = maskMarkdownCodeAndComments(content),
): ParsedMarkdownLink[] {
  if (maskedContent.length !== content.length) {
    throw new Error("Masked Markdown must preserve source offsets.");
  }
  const links: ParsedMarkdownLink[] = [];
  const lines = content.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? [];
  const searchableLines = maskedContent.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? [];
  const referenceContexts = rendererReferenceDefinitionContexts(
    content,
    yamlFrontmatterRanges(content),
  );
  const referenceContextByLine = new Map(
    referenceContexts.map((context) => [context.line, context]),
  );
  const opaqueReferenceLines = new Set<number>();
  for (const context of referenceContexts) {
    for (let line = context.line; line < context.endLine; line += 1) {
      opaqueReferenceLines.add(line);
    }
  }
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const full = lines[index] ?? "";
    if (full.length === 0 && index === lines.length - 1) {
      break;
    }
    const sourceLine = full.replace(/\r\n$|[\r\n]$/u, "");
    const searchableLine = (searchableLines[index] ?? "").replace(/\r\n$|[\r\n]$/u, "");
    const context = referenceContextByLine.get(index + 1);
    if (context) {
      const candidate = rendererDefinitionCandidate(content, context);
      const definition = candidate
        ? parseReferenceDefinition(candidate, context.segments.at(-1)?.end ?? context.end)
        : null;
      if (definition) links.push(definition);
    } else if (!opaqueReferenceLines.has(index + 1)) {
      links.push(...parseLine(sourceLine, searchableLine, offset, index + 1));
    }
    offset += full.length;
  }
  return links.sort(
    (left, right) => left.position - right.position || left.targetStart - right.targetStart,
  );
}
