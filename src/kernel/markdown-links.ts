export interface ParsedMarkdownLink {
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

/** A visible reference-style image usage, without resolving its definition. */
export interface ParsedMarkdownReferenceUsage {
  label: string;
  embed: true;
  position: number;
  end: number;
  line: number;
}

/** A visible reference definition and whether its destination is syntactically usable. */
export interface ParsedMarkdownReferenceDefinition {
  label: string;
  valid: boolean;
  external: boolean;
  line: number;
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

function findClosingBracket(value: string, start: number): number {
  let escaped = false;
  for (let cursor = start; cursor < value.length; cursor += 1) {
    const character = value[cursor];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "]") {
      return cursor;
    }
  }
  return -1;
}

function parseWikiLinks(
  sourceLine: string,
  searchableLine: string,
  lineStart: number,
  lineNumber: number,
): ParsedMarkdownLink[] {
  const links: ParsedMarkdownLink[] = [];
  const pattern = /(!)?\[\[([^\]\n]+)\]\]/gu;
  for (const match of searchableLine.matchAll(pattern)) {
    const localStart = match.index ?? 0;
    const full = sourceLine.slice(localStart, localStart + match[0].length);
    const embed = match[1] === "!";
    const inner = full.slice(embed ? 3 : 2, -2);
    const aliasAt = inner.indexOf("|");
    const rawTarget = aliasAt === -1 ? inner : inner.slice(0, aliasAt);
    const subpathAt = subpathOffset(rawTarget);
    const rawTargetOnly = subpathAt === -1 ? rawTarget : rawTarget.slice(0, subpathAt);
    const targetRange = trimmedRange(rawTargetOnly);
    const position = lineStart + localStart;
    const innerStart = position + (embed ? 3 : 2);
    links.push({
      target: normalizeLinkTarget(rawTargetOnly).trim(),
      subpath: normalizeSubpath(subpathAt === -1 ? "" : rawTarget.slice(subpathAt)),
      alias: aliasAt === -1 ? null : inner.slice(aliasAt + 1).trim() || null,
      embed,
      syntax: "wiki",
      position,
      end: position + full.length,
      targetStart: innerStart + targetRange.start,
      targetEnd: innerStart + targetRange.end,
      line: lineNumber,
    });
  }
  return links;
}

function parseReferenceDefinition(
  sourceLine: string,
  searchableLine: string,
  lineStart: number,
  lineNumber: number,
): ParsedMarkdownLink | null {
  const leading = searchableLine.match(/^ {0,3}/u)?.[0].length ?? 0;
  let cursor = leading;
  const embed = searchableLine[cursor] === "!";
  if (embed) cursor += 1;
  if (searchableLine[cursor] !== "[") return null;
  const close = findClosingBracket(searchableLine, cursor + 1);
  if (close === -1 || searchableLine[close + 1] !== ":") return null;
  const destination = scanDefinitionDestination(searchableLine, close + 2);
  if (!destination) return null;
  const rawDestination = sourceLine.slice(destination.targetStart, destination.targetEnd);
  const subpathAt = subpathOffset(rawDestination);
  const rawTargetOnly = subpathAt === -1 ? rawDestination : rawDestination.slice(0, subpathAt);
  const targetRange = trimmedRange(rawTargetOnly);
  const normalizedTarget = normalizeLinkTarget(rawTargetOnly).trim();
  if ((!normalizedTarget && subpathAt === -1) || isExternalLink(normalizedTarget)) return null;
  const position = lineStart + leading;
  return {
    target: normalizedTarget,
    subpath: normalizeSubpath(subpathAt === -1 ? "" : rawDestination.slice(subpathAt)),
    alias: null,
    embed,
    syntax: "markdown",
    position,
    end: lineStart + destination.end,
    targetStart: lineStart + destination.targetStart + targetRange.start,
    targetEnd: lineStart + destination.targetStart + targetRange.end,
    line: lineNumber,
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
    const embed = marker > 0 && searchableLine[marker - 1] === "!";
    const position = embed ? marker - 1 : marker;
    const closeBracket = findClosingBracket(searchableLine, marker + 1);
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

function parseLine(
  sourceLine: string,
  searchableLine: string,
  lineStart: number,
  lineNumber: number,
): ParsedMarkdownLink[] {
  const definition = parseReferenceDefinition(sourceLine, searchableLine, lineStart, lineNumber);
  return [
    ...parseWikiLinks(sourceLine, searchableLine, lineStart, lineNumber),
    ...(definition ? [definition] : []),
    ...parseInlineLinks(sourceLine, searchableLine, lineStart, lineNumber),
  ];
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
    chunks.push(content.slice(range.start, range.end).replace(/[^\r\n]/gu, " "));
    cursor = range.end;
  }
  chunks.push(content.slice(cursor));
  return chunks.join("");
}

function yamlFrontmatterRanges(content: string): MaskRange[] {
  const bom = content.startsWith("\uFEFF") ? 1 : 0;
  const firstEnd = content.indexOf("\n", bom);
  const firstLineEnd = firstEnd === -1 ? content.length : firstEnd;
  const firstLine = content.slice(bom, firstLineEnd).replace(/\r$/u, "");
  if (!/^ {0,3}---$/u.test(firstLine)) return [];
  const ranges: MaskRange[] = [];
  let offset = bom;
  const lines = content.slice(bom).match(/[^\r\n]*(?:\r\n|\n|$)/gu) ?? [];
  let closed = false;
  for (const full of lines) {
    if (full.length === 0) break;
    const line = full.replace(/\r?\n$/u, "");
    const trimmed = line.replace(/^ {0,3}/u, "");
    ranges.push({ start: offset, end: offset + full.length });
    offset += full.length;
    if (ranges.length > 1 && /^(?:---|\.\.\.)$/u.test(trimmed)) {
      closed = true;
      break;
    }
  }
  if (!closed && ranges.length > 0) return [{ start: bom, end: content.length }];
  return ranges;
}

function fencedCodeRanges(content: string): MaskRange[] {
  const ranges: MaskRange[] = [];
  const lines = content.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g);
  let offset = 0;
  let fence: { character: "`" | "~"; length: number } | null = null;
  for (const match of lines) {
    const full = match[0];
    if (full.length === 0) {
      break;
    }
    const line = full.replace(/\r\n$|[\r\n]$/u, "");
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence || marker) {
      ranges.push({ start: offset, end: offset + full.length });
    }
    if (!fence && marker) {
      fence = { character: marker[0] as "`" | "~", length: marker.length };
    } else if (
      fence &&
      marker?.[0] === fence.character &&
      marker.length >= fence.length &&
      line.slice(line.indexOf(marker) + marker.length).trim() === ""
    ) {
      fence = null;
    }
    offset += full.length;
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
  const fencedRanges = fencedCodeRanges(content);
  const fencedMask = applyMaskRanges(content, [...frontmatterRanges, ...fencedRanges]);
  const structuralRanges = mergeMaskRanges([
    ...frontmatterRanges,
    ...fencedRanges,
    ...htmlCommentRanges(fencedMask),
  ]);
  const structuralMask = applyMaskRanges(content, structuralRanges);
  return applyMaskRanges(content, [...structuralRanges, ...inlineCodeRanges(structuralMask)]);
}

/**
 * Returns visible reference definitions independently of their destination
 * kind. The attachment mover uses this to distinguish an external definition
 * from a malformed or source-only definition before it offers a move.
 */
export function parseMarkdownReferenceDefinitions(
  content: string,
  maskedContent = maskMarkdownCodeAndComments(content),
): ParsedMarkdownReferenceDefinition[] {
  if (maskedContent.length !== content.length) {
    throw new Error("Masked Markdown must preserve source offsets.");
  }
  const lines = content.match(/[^\r\n]*(?:\r\n|\n|$)/gu) ?? [];
  const searchableLines = maskedContent.match(/[^\r\n]*(?:\r\n|\n|$)/gu) ?? [];
  const definitions: ParsedMarkdownReferenceDefinition[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const full = lines[index] ?? "";
    if (!full && index === lines.length - 1) break;
    const sourceLine = full.replace(/\r?\n$/u, "");
    const searchableLine = (searchableLines[index] ?? "").replace(/\r?\n$/u, "");
    const leading = searchableLine.match(/^ {0,3}/u)?.[0].length ?? 0;
    let cursor = leading;
    if (searchableLine[cursor] === "!") cursor += 1;
    if (searchableLine[cursor] !== "[") continue;
    const close = findClosingBracket(searchableLine, cursor + 1);
    if (close === -1 || searchableLine[close + 1] !== ":") continue;
    const label = normalizeMarkdownReferenceLabel(sourceLine.slice(cursor + 1, close));
    if (!label) continue;
    const destination = scanDefinitionDestination(searchableLine, close + 2);
    if (!destination) {
      definitions.push({ label, valid: false, external: false, line: index + 1 });
      continue;
    }
    const rawDestination = sourceLine.slice(destination.targetStart, destination.targetEnd);
    const subpathAt = subpathOffset(rawDestination);
    const rawTargetOnly = subpathAt === -1 ? rawDestination : rawDestination.slice(0, subpathAt);
    const normalizedTarget = normalizeLinkTarget(rawTargetOnly).trim();
    definitions.push({
      label,
      valid: normalizedTarget.length > 0,
      external: normalizedTarget.length > 0 && isExternalLink(normalizedTarget),
      line: index + 1,
    });
  }
  return definitions;
}

/**
 * Finds visible full/collapsed reference-style image usages. This deliberately
 * does not return ordinary reference links: only image syntax needs the
 * attachment move's explicit definition safety gate.
 */
export function parseMarkdownReferenceUsages(
  content: string,
  maskedContent = maskMarkdownCodeAndComments(content),
): ParsedMarkdownReferenceUsage[] {
  if (maskedContent.length !== content.length) {
    throw new Error("Masked Markdown must preserve source offsets.");
  }
  const lines = content.match(/[^\r\n]*(?:\r\n|\n|$)/gu) ?? [];
  const searchableLines = maskedContent.match(/[^\r\n]*(?:\r\n|\n|$)/gu) ?? [];
  const usages: ParsedMarkdownReferenceUsage[] = [];
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const full = lines[index] ?? "";
    if (!full && index === lines.length - 1) break;
    const searchableLine = (searchableLines[index] ?? "").replace(/\r?\n$/u, "");
    let cursor = 0;
    while (cursor < searchableLine.length) {
      const marker = searchableLine.indexOf("!", cursor);
      if (marker === -1) break;
      let backslashes = 0;
      for (let before = marker - 1; before >= 0 && searchableLine[before] === "\\"; before -= 1) {
        backslashes += 1;
      }
      if (backslashes % 2 !== 0 || searchableLine[marker + 1] !== "[") {
        cursor = marker + 1;
        continue;
      }
      // Obsidian wiki embeds start with `![[`; they are parsed by the wiki
      // scanner, not as a Markdown reference image whose alt text happens to
      // begin with `[`.
      if (searchableLine[marker + 2] === "[") {
        cursor = marker + 3;
        continue;
      }
      const close = findClosingBracket(searchableLine, marker + 2);
      if (close === -1) {
        cursor = marker + 2;
        continue;
      }
      const afterLabel = skipWhitespace(searchableLine, close + 1);
      if (searchableLine[afterLabel] === "(" || searchableLine[afterLabel] === ":") {
        cursor = close + 1;
        continue;
      }
      if (searchableLine[afterLabel] !== "[") {
        const label = normalizeMarkdownReferenceLabel(full.slice(marker + 2, close));
        if (label) {
          usages.push({
            label,
            embed: true,
            position: offset + marker,
            end: offset + close + 1,
            line: index + 1,
          });
        }
        cursor = close + 1;
        continue;
      }
      const referenceClose = findClosingBracket(searchableLine, afterLabel + 1);
      if (referenceClose === -1) {
        cursor = afterLabel + 1;
        continue;
      }
      const alt = full.slice(marker + 2, close);
      const explicit = full.slice(afterLabel + 1, referenceClose);
      const label = normalizeMarkdownReferenceLabel(explicit || alt);
      if (label) {
        usages.push({
          label,
          embed: true,
          position: offset + marker,
          end: offset + referenceClose + 1,
          line: index + 1,
        });
      }
      cursor = referenceClose + 1;
    }
    offset += full.length;
  }
  return usages;
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
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const full = lines[index] ?? "";
    if (full.length === 0 && index === lines.length - 1) {
      break;
    }
    const sourceLine = full.replace(/\r\n$|[\r\n]$/u, "");
    const searchableLine = (searchableLines[index] ?? "").replace(/\r\n$|[\r\n]$/u, "");
    links.push(...parseLine(sourceLine, searchableLine, offset, index + 1));
    offset += full.length;
  }
  return links.sort(
    (left, right) => left.position - right.position || left.targetStart - right.targetStart,
  );
}
