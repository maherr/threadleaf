import { syntaxTree } from "@codemirror/language";
import { type Extension, type Range, StateEffect } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type {
  VaultImageResponse,
  VaultNoteEmbedResponse,
  WorkspaceLinkSummary,
} from "../shared/contracts";
import { isValidTagBody } from "../shared/tags";
import {
  collectFootnotes,
  createSafeMathElement,
  findInlineMathClose,
  markdownCodeRanges,
  markdownHtmlRanges,
  renderSafeMath,
  scanFrontmatter,
  sourceLineStarts,
  splitSourceLines,
} from "./markdown-extensions";

export type LivePreviewLinkSyntax = "wiki" | "markdown";

export interface LivePreviewLink {
  syntax: LivePreviewLinkSyntax;
  target: string;
  subpath: string | null;
  label: string;
  embed: boolean;
  external: boolean;
}

export interface LivePreviewOptions {
  sourceNotePath(): string | null;
  expectedVaultId(): string | null;
  activateLink(link: LivePreviewLink): void;
  activateTag(tag: string): void;
  loadImage(
    sourceNotePath: string,
    target: string,
    expectedVaultId: string,
  ): Promise<VaultImageResponse>;
  loadNoteEmbed?(
    sourceNotePath: string,
    target: string,
    subpath: string | null,
    expectedVaultId: string,
  ): Promise<VaultNoteEmbedResponse>;
  maxTransclusionDepth?: number;
  maxTransclusionFragments?: number;
  maxTransclusionBytes?: number;
}

/** A half-open UTF-16 range in the canonical Markdown document. */
export interface SourceRange {
  from: number;
  to: number;
}

/**
 * The side of a hidden delimiter to choose when a caret is exactly on a
 * zero-width decorated boundary.
 *
 * CodeMirror positions are always source positions. These affinities are for
 * the projected (rendered) surface only, so a generated widget can never
 * create a second, phantom document position.
 */
export type SelectionAffinity = "before" | "inside" | "after";

export type LivePreviewProjectionKind = "text" | "label" | "generated" | "hidden" | "fallback";

export interface LivePreviewProjectionSegment {
  source: SourceRange;
  rendered: SourceRange;
  kind: LivePreviewProjectionKind;
  editable: boolean;
}

export interface LivePreviewMappedToken extends SourceRange {
  kind: ParsedInlineToken["kind"] | "delimiter";
  sourceText: string;
  renderedText: string;
  status: "mapped" | "fallback";
  rendered: SourceRange;
  segments: readonly LivePreviewProjectionSegment[];
}

export interface LivePreviewMapping {
  /** The exact source input. It is never decoded, normalized, or rewritten. */
  source: string;
  /** A conceptual projection used for source/decorated offset tests. */
  rendered: string;
  tokens: readonly LivePreviewMappedToken[];
  segments: readonly LivePreviewProjectionSegment[];
  sourceToRendered(position: number, affinity?: SelectionAffinity): number;
  renderedToSource(position: number, affinity?: SelectionAffinity): number;
  mapRenderedSelection(selection: SourceRange, affinity?: SelectionAffinity): SourceRange;
}

export interface LivePreviewMappingScanStats {
  lines: number;
  protectedRangeChecks: number;
  rawTextSteps: number;
  rangeSubtractionComparisons?: number;
  nestedDestinationSteps?: number;
}

export type InlineTransclusionStatus =
  | "ready"
  | "missing"
  | "cycle"
  | "depth-limit"
  | "preview-limit"
  | "byte-limit"
  | "external"
  | "subpath-missing";

export interface InlineTransclusionNode {
  ownerPath: string;
  source: SourceRange;
  target: string;
  subpath: string | null;
  depth: number;
  status: InlineTransclusionStatus;
  content: string | null;
  children: readonly InlineTransclusionNode[];
}

export interface InlineTransclusionLimits {
  maxDepth?: number;
  maxFragments?: number;
  maxBytes?: number;
}

interface ParsedInlineToken extends SourceRange {
  kind:
    | "link"
    | "image"
    | "embed"
    | "callout"
    | "tag"
    | "task"
    | "footnote-ref"
    | "math"
    | "source-block";
  link?: LivePreviewLink;
  label: string;
  footnoteId?: string;
  mathExpression?: string;
  mathDisplay?: boolean;
}

const rasterImagePattern = /\.(?:gif|jpe?g|png|webp)$/iu;

function isExternalTarget(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/iu.test(value) || value.startsWith("//");
}

function splitTarget(value: string): { target: string; subpath: string | null } {
  let normalized: string;
  try {
    normalized = decodeURIComponent(value).replaceAll("\\", "/");
  } catch {
    normalized = value.replaceAll("\\", "/");
  }
  const headingIndex = normalized.indexOf("#");
  const blockIndex = normalized.indexOf("^");
  const indexes = [headingIndex, blockIndex].filter((index) => index >= 0);
  const splitAt = indexes.length > 0 ? Math.min(...indexes) : -1;
  if (splitAt === -1) {
    return { target: normalized.trim(), subpath: null };
  }
  return {
    target: normalized.slice(0, splitAt).trim(),
    subpath: normalized.slice(splitAt).trim() || null,
  };
}

function rangesIntersect(left: SourceRange, right: SourceRange): boolean {
  return left.from < right.to && right.from < left.to;
}

function intersectsAny(range: SourceRange, ranges: readonly SourceRange[]): boolean {
  return ranges.some((candidate) => rangesIntersect(range, candidate));
}

function mergeSourceRanges(ranges: readonly SourceRange[]): SourceRange[] {
  const ordered = ranges
    .filter((range) => range.from < range.to)
    .map((range) => ({ from: range.from, to: range.to }))
    .sort((left, right) => left.from - right.from || left.to - right.to);
  const merged: SourceRange[] = [];
  for (const range of ordered) {
    const previous = merged.at(-1);
    if (previous && range.from <= previous.to) {
      previous.to = Math.max(previous.to, range.to);
    } else {
      merged.push(range);
    }
  }
  return merged;
}

interface SourceRangeCursor {
  index: number;
}

function rangesForLine(
  line: SourceRange,
  ranges: readonly SourceRange[],
  cursor: SourceRangeCursor,
  stats?: LivePreviewMappingScanStats,
): SourceRange[] {
  while (cursor.index < ranges.length) {
    const candidate = ranges[cursor.index];
    if (!candidate || candidate.to > line.from) break;
    if (stats) stats.protectedRangeChecks += 1;
    cursor.index += 1;
  }
  const local: SourceRange[] = [];
  for (
    let index = cursor.index;
    index < ranges.length && (ranges[index]?.from ?? Number.POSITIVE_INFINITY) < line.to;
    index += 1
  ) {
    const candidate = ranges[index];
    if (!candidate) continue;
    if (stats) stats.protectedRangeChecks += 1;
    if (rangesIntersect(line, candidate)) local.push(candidate);
  }
  while (cursor.index < ranges.length) {
    const candidate = ranges[cursor.index];
    if (!candidate || candidate.to > line.to) break;
    cursor.index += 1;
  }
  return local;
}

export interface SourceRangeSubtractionStats {
  comparisons: number;
}

/**
 * Subtract the sorted union of masks from the sorted union of ranges.
 *
 * Both unions are formed once.  The second pass advances `maskIndex` only
 * forward; a mask that spans the current range is deliberately retained for
 * the next range.  This keeps the subtraction pass linear in the normalized
 * input sizes instead of restarting at mask zero for every range.
 */
export function subtractSourceRanges(
  ranges: readonly SourceRange[],
  masks: readonly SourceRange[],
  stats?: SourceRangeSubtractionStats,
): SourceRange[] {
  const orderedRanges = mergeSourceRanges(ranges);
  const orderedMasks = mergeSourceRanges(masks);
  const remainder: SourceRange[] = [];
  let maskIndex = 0;
  for (const range of orderedRanges) {
    while (maskIndex < orderedMasks.length) {
      if (stats) stats.comparisons += 1;
      const mask = orderedMasks[maskIndex];
      if (!mask || mask.to > range.from) break;
      maskIndex += 1;
    }
    let cursor = range.from;
    let scan = maskIndex;
    while (scan < orderedMasks.length) {
      if (stats) stats.comparisons += 1;
      const mask = orderedMasks[scan];
      if (!mask || mask.from >= range.to) break;
      if (cursor < mask.from) {
        remainder.push({ from: cursor, to: mask.from });
      }
      cursor = Math.max(cursor, mask.to);
      if (cursor >= range.to) break;
      scan += 1;
    }
    if (cursor < range.to) remainder.push({ from: cursor, to: range.to });
    // A mask consumed completely by this range cannot affect a later range.
    // Keep an overhanging mask at maskIndex for the next range.
    if (scan > maskIndex) maskIndex = scan;
  }
  return remainder;
}

function parseWikiLink(raw: string, embed: boolean): LivePreviewLink | null {
  const aliasAt = raw.indexOf("|");
  const rawTarget = aliasAt === -1 ? raw : raw.slice(0, aliasAt);
  const { target, subpath } = splitTarget(rawTarget.trim());
  if (!target && !subpath) {
    return null;
  }
  return {
    syntax: "wiki",
    target,
    subpath,
    label: (aliasAt === -1 ? "" : raw.slice(aliasAt + 1).trim()) || `${target}${subpath ?? ""}`,
    embed,
    external: isExternalTarget(target),
  };
}

function parseMarkdownLink(
  rawTarget: string,
  label: string,
  embed: boolean,
): LivePreviewLink | null {
  const trimmed = rawTarget.trim();
  const destination =
    trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed;
  if (!destination || /\s/u.test(destination)) {
    return null;
  }
  const { target, subpath } = splitTarget(destination);
  if (!target && !subpath) {
    return null;
  }
  return {
    syntax: "markdown",
    target,
    subpath,
    label: label.trim() || `${target}${subpath ?? ""}`,
    embed,
    external: isExternalTarget(target),
  };
}

interface MarkdownDestinationScan {
  closingByStart: Int32Array;
  literalOpenPrefix: Int32Array;
  steps: number;
}

/**
 * Find the first unescaped closing parenthesis for every possible Markdown
 * destination start. A destination's own opener is already part of the
 * prefix balance, so the matching close is the first later balance drop.
 * Next-lower lookup makes the whole line scan monotonic even when every
 * destination contains another destination opener.
 */
function scanMarkdownDestinations(text: string): MarkdownDestinationScan {
  const prefix = new Int32Array(text.length + 1);
  const literalOpenPrefix = new Int32Array(text.length + 1);
  let balance = 0;
  let literalOpens = 0;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    prefix[index] = balance;
    literalOpenPrefix[index] = literalOpens;
    const character = text[index] ?? "";
    if (escaped) {
      if (character === "(") literalOpens += 1;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
    } else if (character === "(") {
      balance += 1;
      literalOpens += 1;
    } else if (character === ")") {
      balance -= 1;
    }
  }
  prefix[text.length] = balance;
  literalOpenPrefix[text.length] = literalOpens;

  const nextLower = new Int32Array(prefix.length);
  nextLower.fill(-1);
  const stack: number[] = [];
  for (let index = prefix.length - 1; index >= 0; index -= 1) {
    while (
      stack.length > 0 &&
      (prefix[stack[stack.length - 1] ?? 0] ?? 0) >= (prefix[index] ?? 0)
    ) {
      stack.pop();
    }
    nextLower[index] = stack[stack.length - 1] ?? -1;
    stack.push(index);
  }

  // A destination can never be found to close past a newline. One backward
  // pass records the nearest newline at or after each position so a close
  // that would cross one can be rejected in O(1) per start below, matching
  // the single-pass cursor scan's original `if (character === "\n") break`
  // without rescanning the intervening text (which would reintroduce a
  // quadratic cost on inputs with many nested opens).
  const nextNewlineFrom = new Int32Array(text.length + 1);
  nextNewlineFrom[text.length] = text.length;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    nextNewlineFrom[index] =
      text[index] === "\n" ? index : (nextNewlineFrom[index + 1] ?? text.length);
  }

  const closingByStart = new Int32Array(text.length + 1);
  closingByStart.fill(-1);
  for (let start = 0; start < text.length; start += 1) {
    const lower = nextLower[start] ?? -1;
    if (lower > start && lower - 1 < (nextNewlineFrom[start] ?? text.length)) {
      closingByStart[start] = lower - 1;
    }
  }
  return {
    closingByStart,
    literalOpenPrefix,
    steps: text.length + prefix.length + stack.length,
  };
}

export function parseLivePreviewLine(
  text: string,
  lineFrom: number,
  protectedRanges: readonly SourceRange[] = [],
  options: { footnoteIds?: ReadonlySet<string>; stats?: LivePreviewMappingScanStats } = {},
): ParsedInlineToken[] {
  const tokens: ParsedInlineToken[] = [];
  const occupied: SourceRange[] = [];
  const add = (token: ParsedInlineToken): void => {
    if (intersectsAny(token, protectedRanges) || intersectsAny(token, occupied)) {
      return;
    }
    tokens.push(token);
    occupied.push(token);
  };

  const callout = /^\s*>\s*\[!([a-z0-9_-]+)\](?:[+-])?/iu.exec(text);
  if (callout?.[0] && callout[1]) {
    const markerAt = callout[0].indexOf("[!");
    const marker = callout[0].slice(markerAt);
    add({
      from: lineFrom + markerAt,
      to: lineFrom + markerAt + marker.length,
      kind: "callout",
      label: callout[1].replaceAll(/[-_]+/gu, " "),
    });
  }

  for (const match of text.matchAll(/(!?)\[\[([^\]\n]+)\]\]/gu)) {
    const full = match[0];
    const raw = match[2];
    if (match.index === undefined || !raw) {
      continue;
    }
    const embed = match[1] === "!";
    const link = parseWikiLink(raw, embed);
    if (!link) {
      continue;
    }
    add({
      from: lineFrom + match.index,
      to: lineFrom + match.index + full.length,
      kind: embed ? (rasterImagePattern.test(link.target) ? "image" : "embed") : "link",
      link,
      label: link.label,
    });
  }

  for (const match of text.matchAll(/(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/gu)) {
    const full = match[0];
    const label = match[2] ?? "";
    const rawTarget = match[3];
    if (match.index === undefined || !rawTarget) {
      continue;
    }
    const embed = match[1] === "!";
    // The simple scanner deliberately does not guess through nested
    // destinations. A second pass below records the complete construct as a
    // source fallback so a partial widget can never hide its tail.
    if (rawTarget.includes("(")) {
      continue;
    }
    const link = parseMarkdownLink(rawTarget, label, embed);
    if (!link) {
      continue;
    }
    add({
      from: lineFrom + match.index,
      to: lineFrom + match.index + full.length,
      kind: embed ? (rasterImagePattern.test(link.target) ? "image" : "embed") : "link",
      link,
      label: link.label,
    });
  }

  const destinationScan = text.includes("](") ? scanMarkdownDestinations(text) : null;
  if (destinationScan && options.stats) {
    options.stats.nestedDestinationSteps =
      (options.stats.nestedDestinationSteps ?? 0) + destinationScan.steps;
  }
  for (const match of text.matchAll(/(!?)\[([^\]\n]*)\]\(/gu)) {
    if (match.index === undefined) {
      continue;
    }
    const embed = match[1] === "!";
    const open = match.index + (embed ? 1 : 0);
    const labelEnd = match.index + match[0].length - 2;
    const destinationFrom = match.index + match[0].length;
    const destinationTo = destinationScan?.closingByStart[destinationFrom] ?? -1;
    const fallbackTo = destinationTo >= 0 ? destinationTo + 1 : text.length;
    const label = match[2] ?? text.slice(open + 1, labelEnd);
    const rawTargetTo = destinationTo >= 0 ? destinationTo : text.length;
    const hasLiteralOpen =
      (destinationScan?.literalOpenPrefix[rawTargetTo] ?? 0) >
      (destinationScan?.literalOpenPrefix[destinationFrom] ?? 0);
    const candidate = {
      from: lineFrom + (embed ? match.index : open),
      to: lineFrom + fallbackTo,
    };
    // An unterminated destination with a nested open owns the rest of the
    // line even when something else already occupies its exact range (e.g. a
    // simple link matched earlier in the same span): that is still the
    // signal that later candidates sit inside abandoned, ambiguous syntax
    // and must stay source-visible rather than become their own widgets.
    const ownsRestOfLine = destinationTo < 0 && hasLiteralOpen;
    // Once an outer fallback owns the complete nested construct, the inner
    // candidates cannot produce a different widget. Skip them before slicing
    // or parsing their increasingly large destination strings.
    if (intersectsAny(candidate, protectedRanges) || intersectsAny(candidate, occupied)) {
      if (ownsRestOfLine) {
        // Even though this candidate could not be added (its range is
        // already spoken for), it still marks the rest of the line as
        // owned fallback territory. Stop scanning here so a later nested
        // candidate cannot be mistaken for an independent, valid link.
        break;
      }
      continue;
    }
    const rawTarget = text.slice(destinationFrom, rawTargetTo);
    const link = parseMarkdownLink(rawTarget, label, embed);
    if (!link && !hasLiteralOpen) {
      continue;
    }
    add({
      ...candidate,
      kind: link
        ? embed
          ? rasterImagePattern.test(link.target)
            ? "image"
            : "embed"
          : "link"
        : "link",
      ...(link ? { link } : {}),
      label: link?.label ?? label.trim(),
    });
    if (ownsRestOfLine) {
      // This fallback owns the rest of the line; scanning later candidates
      // could only rediscover ranges that are already source-visible.
      break;
    }
  }
  for (const match of text.matchAll(/(^|[\s(])#([\p{L}\p{M}\p{N}_/-]+)/gu)) {
    if (match.index === undefined || !match[2]) {
      continue;
    }
    if (!isValidTagBody(match[2])) continue;
    const prefixLength = match[1]?.length ?? 0;
    const from = lineFrom + match.index + prefixLength;
    add({ from, to: from + match[0].length - prefixLength, kind: "tag", label: match[2] });
  }

  const definition = /^ {0,3}\[\^([^\]\r\n]+)\]:/u.exec(text);
  if (!definition) {
    for (const match of text.matchAll(/\[\^([^\]\n]+)\]/gu)) {
      if (match.index === undefined || !match[1] || isEscaped(text, match.index)) continue;
      if (options.footnoteIds && !options.footnoteIds.has(match[1])) continue;
      add({
        from: lineFrom + match.index,
        to: lineFrom + match.index + match[0].length,
        kind: "footnote-ref",
        label: match[1],
        footnoteId: match[1],
      });
    }
  }

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\\" && text[index + 1] === "(" && !isEscaped(text, index)) {
      const close = findInlineMathClose(text, index, "paren");
      if (close < 0) break;
      const expression = text.slice(index + 2, close);
      add({
        from: lineFrom + index,
        to: lineFrom + close + 2,
        kind: "math",
        label: expression,
        mathExpression: expression,
      });
      index = close + 1;
      continue;
    }
    if (text[index] !== "$" || text[index + 1] === "$" || isEscaped(text, index)) continue;
    const close = findInlineMathClose(text, index, "dollar");
    if (close < 0) {
      break;
    }
    const expression = text.slice(index + 1, close);
    if (expression.length > 0 && !expression.startsWith(" ") && !expression.endsWith(" ")) {
      add({
        from: lineFrom + index,
        to: lineFrom + close + 1,
        kind: "math",
        label: expression,
        mathExpression: expression,
      });
    }
    index = close;
  }

  return tokens.sort((left, right) => left.from - right.from || left.to - right.to);
}

function unresolvedFrontmatterMapping(source: string): LivePreviewMapping {
  const segment: LivePreviewProjectionSegment = {
    source: sourceRange(0, source.length),
    rendered: sourceRange(0, source.length),
    kind: "fallback",
    editable: true,
  };
  const token: LivePreviewMappedToken = {
    from: 0,
    to: source.length,
    kind: "source-block",
    sourceText: source,
    renderedText: source,
    status: "fallback",
    rendered: sourceRange(0, source.length),
    segments: source.length > 0 ? [segment] : [],
  };
  return {
    source,
    rendered: source,
    tokens: source.length > 0 ? [token] : [],
    segments: source.length > 0 ? [segment] : [],
    sourceToRendered: (position) => clampPosition(position, source.length),
    renderedToSource: (position) => clampPosition(position, source.length),
    mapRenderedSelection: (selection) => ({
      from: clampPosition(selection.from, source.length),
      to: clampPosition(selection.to, source.length),
    }),
  };
}

interface ProjectionOperation {
  source: SourceRange;
  rendered: string;
  kind: LivePreviewProjectionKind;
  editable: boolean;
  token?: ParsedInlineToken;
  delimiter?: boolean;
}

function clampPosition(position: number, length: number): number {
  return Number.isFinite(position) ? Math.max(0, Math.min(length, Math.trunc(position))) : 0;
}

function rangeContains(range: SourceRange, position: number): boolean {
  return range.from <= position && position <= range.to;
}

function sourceRange(from: number, to: number): SourceRange {
  return { from: Math.max(0, from), to: Math.max(from, to) };
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function safeToken(token: ParsedInlineToken, source: string): boolean {
  const raw = source.slice(token.from, token.to);
  if (raw.includes("\n") || raw.includes("\r") || raw.length === 0) {
    return false;
  }
  if (token.kind === "tag" || token.kind === "callout" || token.kind === "task") {
    return true;
  }
  if (token.kind === "footnote-ref") {
    return Boolean(token.footnoteId && !/\s/u.test(token.footnoteId));
  }
  if (token.kind === "math") {
    return Boolean(token.mathExpression && renderSafeMath(token.mathExpression));
  }
  if (!token.link || raw.includes("[\n") || raw.includes("]\n")) {
    return false;
  }
  if (token.link.syntax === "wiki") {
    const body = raw.slice(raw.startsWith("!") ? 3 : 2, -2);
    return body.length > 0 && !body.includes("[") && !body.includes("]");
  }
  const open = raw.indexOf("](");
  return (
    open > 0 &&
    raw.endsWith(")") &&
    !raw.slice(open + 2, -1).includes("(") &&
    !raw.slice(1, open).includes("[")
  );
}

function tokenOperations(
  token: ParsedInlineToken,
  source: string,
  status: "mapped" | "fallback",
): ProjectionOperation[] {
  const raw = source.slice(token.from, token.to);
  if (status === "fallback") {
    return [
      {
        source: sourceRange(token.from, token.to),
        rendered: raw,
        kind: "fallback",
        editable: true,
        token,
      },
    ];
  }
  if (token.kind === "tag") {
    return [
      {
        source: sourceRange(token.from, token.to),
        rendered: raw,
        kind: "label",
        editable: true,
        token,
      },
    ];
  }
  if (token.kind === "callout") {
    return [
      {
        source: sourceRange(token.from, token.to),
        rendered: token.label,
        kind: "generated",
        editable: false,
        token,
      },
    ];
  }
  if (token.kind === "task") {
    return [
      {
        source: sourceRange(token.from, token.to),
        rendered:
          source.slice(token.from, token.to).toLocaleLowerCase("en-US") === "[x]" ? "☑" : "☐",
        kind: "generated",
        editable: false,
        token,
      },
    ];
  }
  if (token.kind === "footnote-ref") {
    return [
      {
        source: sourceRange(token.from, token.to),
        rendered: token.footnoteId ?? token.label,
        kind: "generated",
        editable: false,
        token,
      },
    ];
  }
  if (token.kind === "math" && token.mathExpression) {
    const rendered = renderSafeMath(token.mathExpression);
    return [
      {
        source: sourceRange(token.from, token.to),
        rendered: rendered?.text ?? raw,
        kind: rendered ? "generated" : "fallback",
        editable: false,
        token,
      },
    ];
  }
  if (!token.link) {
    return [];
  }

  const prefixLength = raw.startsWith("!") ? 1 : 0;
  const openingLength = token.link.syntax === "wiki" ? 2 : 1;
  const closingLength = token.link.syntax === "wiki" ? 2 : 1;
  const contentFrom = token.from + prefixLength + openingLength;
  const contentTo = token.to - closingLength;
  const body = source.slice(contentFrom, contentTo);
  const aliasAt = token.link.syntax === "wiki" ? body.indexOf("|") : -1;
  const labelFrom =
    aliasAt >= 0
      ? contentFrom + aliasAt + 1
      : token.link.syntax === "markdown"
        ? contentFrom
        : contentFrom;
  const labelTo =
    aliasAt >= 0
      ? contentTo
      : token.link.syntax === "markdown"
        ? contentFrom + body.indexOf("](")
        : contentTo;
  const labelSource = source.slice(labelFrom, Math.max(labelFrom, labelTo));
  const renderedLabel =
    token.link.label || labelSource.trim() || token.link.target || token.link.subpath || "";
  const operations: ProjectionOperation[] = [];
  const hidden = (from: number, to: number): void => {
    if (from < to) {
      operations.push({
        source: sourceRange(from, to),
        rendered: "",
        kind: "hidden",
        editable: false,
        token,
      });
    }
  };
  if (prefixLength) {
    hidden(token.from, token.from + prefixLength);
  }
  hidden(token.from + prefixLength, contentFrom);
  if (aliasAt >= 0) {
    hidden(contentFrom, labelFrom);
  }
  if (labelFrom < labelTo) {
    operations.push({
      source: sourceRange(labelFrom, labelTo),
      rendered: renderedLabel,
      kind: token.kind === "embed" || token.kind === "image" ? "generated" : "label",
      editable: token.kind === "link",
      token,
    });
  } else if (token.link.syntax === "markdown" && body.length > 0) {
    const destinationMarker = body.indexOf("](");
    const destinationFrom =
      contentFrom + Math.max(0, destinationMarker >= 0 ? destinationMarker : 0);
    const destinationStart = destinationMarker >= 0 ? destinationFrom + 2 : destinationFrom;
    hidden(contentFrom, destinationStart);
    hidden(destinationStart, contentTo);
  }
  hidden(labelTo, contentTo);
  hidden(token.to - closingLength, token.to);
  return operations.sort((left, right) => left.source.from - right.source.from);
}

function delimiterOperations(
  text: string,
  lineFrom: number,
  occupied: readonly SourceRange[],
  protectedRanges: readonly SourceRange[],
): ProjectionOperation[] {
  const operations: ProjectionOperation[] = [];
  const addPair = (left: number, right: number, length: number): void => {
    const ranges = [
      sourceRange(lineFrom + left, lineFrom + left + length),
      sourceRange(lineFrom + right, lineFrom + right + length),
    ];
    if (
      ranges.some(
        (range) =>
          intersectsAny(range, occupied) ||
          intersectsAny(range, protectedRanges) ||
          operations.some((candidate) => rangesIntersect(range, candidate.source)),
      )
    ) {
      return;
    }
    for (const range of ranges) {
      operations.push({
        source: range,
        rendered: "",
        kind: "hidden",
        editable: false,
        delimiter: true,
      });
    }
  };

  const candidates = [...text.matchAll(/(`+|~~|\*+|_+)/gu)];
  const stacks = new Map<string, { index: number; length: number }[]>();
  for (const match of candidates) {
    if (match.index === undefined || !match[1] || isEscaped(text, match.index)) {
      continue;
    }
    const value = match[1];
    const before = text[match.index - 1] ?? "";
    const after = text[match.index + value.length] ?? "";
    const canClose = !/\s/u.test(before) && before.length > 0;
    const canOpen = !/\s/u.test(after) && after.length > 0;
    const unitLengths: number[] = [];
    if (value.startsWith("`") || value === "~~") {
      unitLengths.push(value.length);
    } else {
      let remaining = value.length;
      while (remaining >= 2) {
        unitLengths.push(2);
        remaining -= 2;
      }
      if (remaining === 1) {
        unitLengths.push(1);
      }
    }
    const stackKey = value.startsWith("`") ? value : (value[0] ?? "");
    const stack = stacks.get(stackKey) ?? [];
    let remaining = value.length;
    if (canClose && stack.length > 0) {
      while (remaining > 0 && stack.length > 0) {
        const open = stack.at(-1);
        if (!open || open.length > remaining) {
          break;
        }
        const closeAt = match.index + remaining - open.length;
        addPair(open.index, closeAt, open.length);
        stack.pop();
        remaining -= open.length;
      }
    }
    if (canOpen && remaining > 0) {
      let openAt = match.index;
      for (const unitLength of unitLengths) {
        if (openAt + unitLength > match.index + remaining) {
          break;
        }
        stack.push({ index: openAt, length: unitLength });
        openAt += unitLength;
      }
    }
    stacks.set(stackKey, stack);
  }
  return operations.sort((left, right) => left.source.from - right.source.from);
}

function prefixOperations(
  text: string,
  lineFrom: number,
  occupied: readonly SourceRange[],
  protectedRanges: readonly SourceRange[],
): ProjectionOperation[] {
  const operations: ProjectionOperation[] = [];
  const add = (
    from: number,
    to: number,
    rendered: string,
    kind: LivePreviewProjectionKind,
  ): void => {
    const source = sourceRange(lineFrom + from, lineFrom + to);
    if (from >= to || intersectsAny(source, occupied) || intersectsAny(source, protectedRanges)) {
      return;
    }
    operations.push({ source, rendered, kind, editable: false });
  };
  const heading = /^\s{0,3}#{1,6}(?=\s|$)/u.exec(text);
  if (heading?.[0]) {
    const markFrom = heading[0].search(/#/u);
    add(markFrom, heading[0].length, "", "hidden");
  }
  const quote = /^\s*>\s?/u.exec(text);
  if (quote?.[0]) {
    const markFrom = quote[0].search(/>/u);
    add(markFrom, quote[0].length, "", "hidden");
  }
  const list = /^\s*(?:[-+*]|\d+[.)])(?=\s|$)/u.exec(text);
  if (list?.[0]) {
    const markerFrom = list[0].search(/[-+*]|\d+[.)]/u);
    const marker = /[-+*]|\d+[.)]/u.exec(list[0]);
    if (marker && markerFrom >= 0) {
      add(markerFrom, markerFrom + marker[0].length, "•", "generated");
    }
  }
  return operations;
}

function projectionSegments(
  source: string,
  operations: readonly ProjectionOperation[],
): {
  rendered: string;
  segments: LivePreviewProjectionSegment[];
  operationSegments: Map<ProjectionOperation, LivePreviewProjectionSegment>;
} {
  const segments: LivePreviewProjectionSegment[] = [];
  const operationSegments = new Map<ProjectionOperation, LivePreviewProjectionSegment>();
  let sourceCursor = 0;
  let renderedCursor = 0;
  let rendered = "";
  for (const operation of operations) {
    if (operation.source.from < sourceCursor || operation.source.to > source.length) {
      continue;
    }
    if (sourceCursor < operation.source.from) {
      const identity = source.slice(sourceCursor, operation.source.from);
      rendered += identity;
      const segment = {
        source: sourceRange(sourceCursor, operation.source.from),
        rendered: sourceRange(renderedCursor, renderedCursor + identity.length),
        kind: "text" as const,
        editable: true,
      };
      segments.push(segment);
      renderedCursor += identity.length;
    }
    const projected = operation.rendered;
    rendered += projected;
    const segment: LivePreviewProjectionSegment = {
      source: sourceRange(operation.source.from, operation.source.to),
      rendered: sourceRange(renderedCursor, renderedCursor + projected.length),
      kind: operation.kind,
      editable: operation.editable,
    };
    segments.push(segment);
    operationSegments.set(operation, segment);
    renderedCursor += projected.length;
    sourceCursor = operation.source.to;
  }
  if (sourceCursor < source.length) {
    const identity = source.slice(sourceCursor);
    rendered += identity;
    segments.push({
      source: sourceRange(sourceCursor, source.length),
      rendered: sourceRange(renderedCursor, renderedCursor + identity.length),
      kind: "text",
      editable: true,
    });
  }
  return { rendered, segments, operationSegments };
}

function boundaryMapping(
  segment: LivePreviewProjectionSegment,
  position: number,
  affinity: SelectionAffinity,
): number {
  const sourceLength = segment.source.to - segment.source.from;
  const renderedLength = segment.rendered.to - segment.rendered.from;
  if (renderedLength === 0) {
    if (affinity === "after") {
      return segment.rendered.to;
    }
    if (affinity === "inside") {
      const middle = segment.source.from + sourceLength / 2;
      return position >= middle ? segment.rendered.to : segment.rendered.from;
    }
    return segment.rendered.from;
  }
  if (sourceLength === 0) {
    return segment.rendered.from;
  }
  const ratio = (position - segment.source.from) / sourceLength;
  return Math.max(
    segment.rendered.from,
    Math.min(segment.rendered.to, segment.rendered.from + Math.round(ratio * renderedLength)),
  );
}

function sourceBoundaryMapping(
  segment: LivePreviewProjectionSegment,
  position: number,
  affinity: SelectionAffinity,
): number {
  const sourceLength = segment.source.to - segment.source.from;
  const renderedLength = segment.rendered.to - segment.rendered.from;
  if (renderedLength === 0) {
    return affinity === "after" ? segment.source.to : segment.source.from;
  }
  if (sourceLength === 0) {
    return segment.source.from;
  }
  const ratio = (position - segment.rendered.from) / renderedLength;
  return Math.max(
    segment.source.from,
    Math.min(segment.source.to, segment.source.from + Math.round(ratio * sourceLength)),
  );
}

function mapSourcePosition(
  segments: readonly LivePreviewProjectionSegment[],
  position: number,
  length: number,
  affinity: SelectionAffinity,
): number {
  const bounded = clampPosition(position, length);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment || !rangeContains(segment.source, bounded)) {
      continue;
    }
    const previous = segments[index - 1];
    const next = segments[index + 1];
    if (bounded === segment.source.from && affinity === "before" && previous) {
      return previous.rendered.to;
    }
    if (bounded === segment.source.to && affinity === "after" && next) {
      return next.rendered.from;
    }
    return boundaryMapping(segment, bounded, affinity);
  }
  return bounded;
}

function mapRenderedPosition(
  segments: readonly LivePreviewProjectionSegment[],
  position: number,
  length: number,
  affinity: SelectionAffinity,
): number {
  const bounded = clampPosition(position, length);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment || !rangeContains(segment.rendered, bounded)) {
      continue;
    }
    const previous = segments[index - 1];
    const next = segments[index + 1];
    if (bounded === segment.rendered.from && affinity === "before" && previous) {
      let candidateIndex = index - 1;
      let earliestZero: number | null = null;
      while (candidateIndex >= 0) {
        const candidate = segments[candidateIndex];
        if (
          !candidate ||
          candidate.rendered.from !== bounded ||
          candidate.rendered.to !== bounded
        ) {
          break;
        }
        earliestZero = candidate.source.from;
        candidateIndex -= 1;
      }
      if (earliestZero !== null) {
        return earliestZero;
      }
      return previous.source.to;
    }
    if (bounded === segment.rendered.to && affinity === "after" && next) {
      let candidateIndex = index + 1;
      let latestZero: number | null = null;
      while (candidateIndex < segments.length) {
        const candidate = segments[candidateIndex];
        if (
          !candidate ||
          candidate.rendered.from !== bounded ||
          candidate.rendered.to !== bounded
        ) {
          break;
        }
        latestZero = candidate.source.to;
        candidateIndex += 1;
      }
      if (latestZero !== null) {
        return latestZero;
      }
      return next.source.from;
    }
    return sourceBoundaryMapping(segment, bounded, affinity);
  }
  return clampPosition(bounded, length);
}

/**
 * Build the source/decorated projection used by Live Preview.
 *
 * Every projected character is either an identity slice of source, a label
 * slice derived from source, or a non-editable generated widget. Unsupported
 * or ambiguous tokens become one `fallback` identity segment. That makes the
 * model useful for cursor tests without pretending that a DOM widget is an
 * editable document.
 */
export function buildLivePreviewMapping(
  source: string,
  options: {
    protectedRanges?: readonly SourceRange[];
    stats?: LivePreviewMappingScanStats;
  } = {},
): LivePreviewMapping {
  if (options.stats) {
    options.stats.lines = 0;
    options.stats.protectedRangeChecks = 0;
    options.stats.rawTextSteps = 0;
    options.stats.rangeSubtractionComparisons = 0;
    options.stats.nestedDestinationSteps = 0;
  }
  const frontmatter = scanFrontmatter(source);
  if (frontmatter.status === "unresolved") {
    return unresolvedFrontmatterMapping(source);
  }
  const footnotes = collectFootnotes(source);
  const codeRanges = mergeSourceRanges(markdownCodeRanges(source));
  const htmlStats = options.stats ? { steps: 0, maxOpenTags: 0, rawTextSteps: 0 } : undefined;
  const htmlRanges = mergeSourceRanges(markdownHtmlRanges(source, codeRanges, htmlStats));
  if (options.stats) options.stats.rawTextSteps = htmlStats?.rawTextSteps ?? 0;
  const requestedProtectedRanges = mergeSourceRanges([
    ...codeRanges,
    ...(options.protectedRanges ?? []),
  ]);
  const subtractionStats = options.stats ? { comparisons: 0 } : undefined;
  const nonHtmlProtectedRanges = subtractSourceRanges(
    requestedProtectedRanges,
    htmlRanges,
    subtractionStats,
  );
  if (options.stats) {
    options.stats.rangeSubtractionComparisons = subtractionStats?.comparisons ?? 0;
  }
  const protectedRanges = mergeSourceRanges([...nonHtmlProtectedRanges, ...htmlRanges]);
  // A code range nested inside raw HTML must not make the whole line look
  // like Markdown code. Both lists are ordered once, then each line advances
  // a cursor monotonically instead of rescanning every prior range.
  const lineProtectedRanges = nonHtmlProtectedRanges;
  const protectedCursor: SourceRangeCursor = { index: 0 };
  const lineProtectedCursor: SourceRangeCursor = { index: 0 };
  const parsed: ParsedInlineToken[] = [];
  const lines = splitSourceLines(source);
  const lineStarts = sourceLineStarts(source);
  const frontmatterLines = new Set<number>();
  if (frontmatter.status === "resolved" && frontmatter.closingLine !== null) {
    for (let lineNumber = 1; lineNumber <= frontmatter.closingLine; lineNumber += 1) {
      frontmatterLines.add(lineNumber);
    }
  }
  let lineFrom = 0;
  for (const [lineIndex, line] of lines.entries()) {
    if (options.stats) options.stats.lines += 1;
    const lineNumber = lineIndex + 1;
    const lineRange = sourceRange(lineFrom, lineFrom + line.length);
    // The pure mapping has no mounted CodeMirror syntax tree to hide behind.
    // Leave every line containing a protected non-HTML range as an identity
    // slice, including code that merely resembles a table, task, frontmatter
    // marker, or math. HTML ranges are handled at token boundaries so ordinary
    // Markdown after a closing tag remains renderable.
    const localNonHtmlProtectedRanges = rangesForLine(
      lineRange,
      lineProtectedRanges,
      lineProtectedCursor,
      options.stats,
    );
    const localProtectedRanges = rangesForLine(
      lineRange,
      protectedRanges,
      protectedCursor,
      options.stats,
    );
    if (localNonHtmlProtectedRanges.length > 0) {
      lineFrom = lineStarts[lineIndex + 1] ?? source.length;
      continue;
    }
    const isFrontmatter = frontmatterLines.has(lineNumber);
    const isFrontmatterFence = /^\s*---\s*\r?$/u.test(line);
    const isTableLine = /^\s*\|.*\|\s*$/u.test(line);
    const isFootnoteSourceLine = footnotes.definitionLines.has(lineNumber);
    const sourceOnlyLine =
      isFrontmatter || isFrontmatterFence || isTableLine || isFootnoteSourceLine;
    if (!sourceOnlyLine) {
      const parseOptions = options.stats
        ? { footnoteIds: footnotes.ids, stats: options.stats }
        : { footnoteIds: footnotes.ids };
      parsed.push(...parseLivePreviewLine(line, lineFrom, localProtectedRanges, parseOptions));
    }
    if (isFrontmatter) {
      parsed.push({
        from: lineFrom,
        to: lineFrom + line.length,
        kind: "source-block",
        label: "frontmatter",
      });
    } else if (isTableLine) {
      parsed.push({
        from: lineFrom,
        to: lineFrom + line.length,
        kind: "source-block",
        label: "table",
      });
    } else if (isFootnoteSourceLine) {
      parsed.push({
        from: lineFrom,
        to: lineFrom + line.length,
        kind: "source-block",
        label: "footnote-definition",
      });
    }
    for (const match of sourceOnlyLine ? [] : line.matchAll(/(?:^|\s)(\[[ xX]\])(?=\s|$)/gu)) {
      const marker = match[1];
      if (match.index === undefined || !marker) {
        continue;
      }
      const from = lineFrom + match.index + match[0].length - marker.length;
      const to = from + marker.length;
      if (!intersectsAny({ from, to }, localProtectedRanges)) {
        parsed.push({ from, to, kind: "task", label: marker });
      }
    }
    lineFrom = lineStarts[lineIndex + 1] ?? source.length;
  }
  const operations: ProjectionOperation[] = [];
  const mappedTokens: {
    token: ParsedInlineToken;
    operations: ProjectionOperation[];
    status: "mapped" | "fallback";
  }[] = [];
  for (const token of parsed) {
    const status = safeToken(token, source) ? "mapped" : "fallback";
    const tokenOps = tokenOperations(token, source, status);
    operations.push(...tokenOps);
    mappedTokens.push({ token, operations: tokenOps, status });
  }
  lineFrom = 0;
  const operationProtectedCursor: SourceRangeCursor = { index: 0 };
  let parsedIndex = 0;
  for (const [lineIndex, line] of lines.entries()) {
    const lineTo = lineFrom + line.length;
    while ((parsed[parsedIndex]?.to ?? Number.POSITIVE_INFINITY) <= lineFrom) {
      parsedIndex += 1;
    }
    const lineTokens: ParsedInlineToken[] = [];
    while ((parsed[parsedIndex]?.from ?? Number.POSITIVE_INFINITY) < lineTo) {
      const token = parsed[parsedIndex];
      if (token && token.to <= lineTo) {
        lineTokens.push(token);
      }
      parsedIndex += 1;
    }
    const occupied = lineTokens.map((token) => sourceRange(token.from, token.to));
    const localProtectedRanges = rangesForLine(
      sourceRange(lineFrom, lineTo),
      protectedRanges,
      operationProtectedCursor,
      options.stats,
    );
    operations.push(...prefixOperations(line, lineFrom, occupied, localProtectedRanges));
    operations.push(...delimiterOperations(line, lineFrom, occupied, localProtectedRanges));
    lineFrom = lineStarts[lineIndex + 1] ?? source.length;
  }
  const uniqueOperations = operations
    .filter((operation) => operation.source.from < operation.source.to)
    .sort((left, right) => left.source.from - right.source.from || left.source.to - right.source.to)
    .filter((operation, index, all) => {
      if (index === 0) {
        return true;
      }
      const previous = all[index - 1];
      return !previous || !rangesIntersect(previous.source, operation.source);
    });
  const projection = projectionSegments(source, uniqueOperations);
  const tokens: LivePreviewMappedToken[] = [];
  for (const entry of mappedTokens) {
    const segments = entry.operations
      .map((operation) => projection.operationSegments.get(operation))
      .filter((segment): segment is LivePreviewProjectionSegment => Boolean(segment));
    const status =
      entry.status === "mapped" && segments.length !== entry.operations.length
        ? "fallback"
        : entry.status;
    const renderedFrom =
      segments.at(0)?.rendered.from ??
      mapSourcePosition(projection.segments, entry.token.from, source.length, "inside");
    const renderedTo = segments.at(-1)?.rendered.to ?? renderedFrom;
    tokens.push({
      from: entry.token.from,
      to: entry.token.to,
      kind: entry.token.kind,
      sourceText: source.slice(entry.token.from, entry.token.to),
      renderedText: projection.rendered.slice(renderedFrom, renderedTo),
      status,
      rendered: sourceRange(renderedFrom, renderedTo),
      segments,
    });
  }
  for (const operation of uniqueOperations.filter((candidate) => candidate.delimiter)) {
    const segment = projection.operationSegments.get(operation);
    if (!segment) {
      continue;
    }
    tokens.push({
      from: operation.source.from,
      to: operation.source.to,
      kind: "delimiter",
      sourceText: source.slice(operation.source.from, operation.source.to),
      renderedText: "",
      status: "mapped",
      rendered: segment.rendered,
      segments: [segment],
    });
  }
  tokens.sort((left, right) => left.from - right.from || left.to - right.to);
  return {
    source,
    rendered: projection.rendered,
    tokens,
    segments: projection.segments,
    sourceToRendered: (position, affinity = "inside") =>
      mapSourcePosition(projection.segments, position, source.length, affinity),
    renderedToSource: (position, affinity = "inside") =>
      mapRenderedPosition(projection.segments, position, projection.rendered.length, affinity),
    mapRenderedSelection: (selection, affinity = "inside") => ({
      from: mapRenderedPosition(
        projection.segments,
        selection.from,
        projection.rendered.length,
        affinity === "after" ? "after" : "before",
      ),
      to: mapRenderedPosition(
        projection.segments,
        selection.to,
        projection.rendered.length,
        affinity === "before" ? "before" : "after",
      ),
    }),
  };
}

export function measureLivePreviewMapping(source: string): {
  sourceLength: number;
  renderedLength: number;
  tokenCount: number;
  segmentCount: number;
  elapsedMs: number;
} {
  const started = typeof performance !== "undefined" ? performance.now() : Date.now();
  const mapping = buildLivePreviewMapping(source);
  const ended = typeof performance !== "undefined" ? performance.now() : Date.now();
  return {
    sourceLength: source.length,
    renderedLength: mapping.rendered.length,
    tokenCount: mapping.tokens.length,
    segmentCount: mapping.segments.length,
    elapsedMs: Math.max(0, ended - started),
  };
}

function transclusionIdentity(path: string, subpath: string | null): string {
  return `${path}\u0000${subpath ?? ""}`;
}

interface PreviewSourceLine {
  text: string;
  from: number;
  to: number;
  ending: string;
}

function sourceLineSlices(source: string): PreviewSourceLine[] {
  const lines = splitSourceLines(source);
  const starts = sourceLineStarts(source);
  return lines.map((text, index) => {
    const from = starts[index] ?? source.length;
    const to = from + text.length;
    const next = starts[index + 1] ?? source.length;
    return { text, from, to, ending: source.slice(to, next) };
  });
}

function joinPreviewSourceLines(lines: readonly PreviewSourceLine[]): string {
  return lines
    .map((line, index) => `${line.text}${index + 1 < lines.length ? line.ending : ""}`)
    .join("");
}

function extractTransclusionContent(
  source: string,
  subpath: string | null,
): { status: InlineTransclusionStatus; content: string | null } {
  if (!subpath) {
    return { status: "ready", content: source };
  }
  if (subpath.startsWith("^")) {
    const block = subpath.slice(1).trim();
    const lines = sourceLineSlices(source);
    const line = lines.find(({ text }) =>
      new RegExp(`(?:^|\\s)\\^${block.replace(/[.*+?^${}()|[\]\\]/gu, "\\\\$&")}\\s*$`, "u").test(
        text.replace(/^\uFEFF/u, ""),
      ),
    );
    return line
      ? { status: "ready", content: line.text }
      : { status: "subpath-missing", content: null };
  }
  const heading = subpath.startsWith("#") ? subpath.slice(1).trim() : "";
  if (!heading) {
    return { status: "subpath-missing", content: null };
  }
  const lines = sourceLineSlices(source);
  const headingIndex = lines.findIndex(({ text }) => {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(text.replace(/^\uFEFF/u, ""));
    return match?.[2]?.trim().toLocaleLowerCase("en-US") === heading.toLocaleLowerCase("en-US");
  });
  if (headingIndex < 0) {
    return { status: "subpath-missing", content: null };
  }
  const current =
    /^(#{1,6})\s+/u.exec(lines[headingIndex]?.text.replace(/^\uFEFF/u, "") ?? "")?.[1]?.length ?? 6;
  let end = headingIndex + 1;
  while (end < lines.length) {
    const level = /^(#{1,6})\s+/u.exec(lines[end]?.text.replace(/^\uFEFF/u, "") ?? "")?.[1]?.length;
    if (level !== undefined && level <= current) {
      break;
    }
    end += 1;
  }
  return { status: "ready", content: joinPreviewSourceLines(lines.slice(headingIndex, end)) };
}

/**
 * Resolve note embeds from an already loaded local document map.
 *
 * This helper intentionally has no filesystem or network authority. The map
 * is the caller's bounded snapshot, and every returned node carries the
 * owning source path/range so a consumer cannot accidentally edit generated
 * transclusion DOM. Cycles use path+subpath ancestry, and limits are shared by
 * the whole tree rather than reset for every child.
 */
export function resolveInlineTransclusions(
  sourceNotePath: string,
  source: string,
  documents: ReadonlyMap<string, string>,
  limits: InlineTransclusionLimits = {},
): readonly InlineTransclusionNode[] {
  const maxDepth = Math.max(0, Math.trunc(limits.maxDepth ?? 4));
  const maxFragments = Math.max(0, Math.trunc(limits.maxFragments ?? 32));
  const maxBytes = Math.max(0, Math.trunc(limits.maxBytes ?? 8 * 1024 * 1024));
  const encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
  const byteLength = (value: string): number =>
    encoder ? encoder.encode(value).length : value.length;
  const state = { fragments: 0, bytes: 0 };

  const walk = (
    ownerPath: string,
    content: string,
    depth: number,
    ancestry: ReadonlySet<string>,
  ): readonly InlineTransclusionNode[] => {
    const nodes: InlineTransclusionNode[] = [];
    for (const line of sourceLineSlices(content)) {
      for (const token of parseLivePreviewLine(line.text, line.from)) {
        if (token.kind !== "embed" || !token.link) {
          continue;
        }
        const target = token.link.target || ownerPath;
        const subpath = token.link.subpath;
        const base = {
          ownerPath,
          source: sourceRange(token.from, token.to),
          target,
          subpath,
          depth,
        };
        let status: InlineTransclusionStatus = "ready";
        let childContent: string | null = null;
        let children: readonly InlineTransclusionNode[] = [];
        if (token.link.external) {
          status = "external";
        } else if (depth > maxDepth) {
          status = "depth-limit";
        } else if (state.fragments >= maxFragments) {
          status = "preview-limit";
        } else {
          const identity = transclusionIdentity(target, subpath);
          if (ancestry.has(identity)) {
            status = "cycle";
          } else {
            const candidate = documents.get(target);
            if (candidate === undefined) {
              status = "missing";
            } else {
              const extracted = extractTransclusionContent(candidate, subpath);
              status = extracted.status;
              childContent = extracted.content;
              if (status === "ready" && childContent !== null) {
                const bytes = byteLength(childContent);
                if (state.bytes + bytes > maxBytes) {
                  status = "byte-limit";
                  childContent = null;
                } else {
                  state.fragments += 1;
                  state.bytes += bytes;
                  children = walk(
                    target,
                    childContent,
                    depth + 1,
                    new Set([...ancestry, identity]),
                  );
                }
              }
            }
          }
        }
        nodes.push({ ...base, status, content: childContent, children });
      }
    }
    return nodes;
  };

  return walk(sourceNotePath, source, 1, new Set([transclusionIdentity(sourceNotePath, null)]));
}

function revealSource(view: EditorView, from: number, event: Event): void {
  event.preventDefault();
  event.stopPropagation();
  view.dispatch({
    selection: { anchor: Math.min(from, view.state.doc.length) },
    scrollIntoView: true,
  });
  view.focus();
}

function isActivationEvent(event: MouseEvent | KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

function sourceMetadata(
  element: HTMLElement,
  from: number,
  to: number,
  kind: string,
  ownerPath: string | null = null,
): void {
  element.dataset.tlSourceFrom = String(from);
  element.dataset.tlSourceTo = String(to);
  element.dataset.tlMappingKind = kind;
  element.dataset.tlSourceReveal = "true";
  if (ownerPath) {
    element.dataset.tlSourceOwner = ownerPath;
  }
}

class LinkWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly link: LivePreviewLink,
    readonly options: LivePreviewOptions,
  ) {
    super();
  }

  eq(other: LinkWidget): boolean {
    return (
      this.from === other.from &&
      this.to === other.to &&
      this.link.syntax === other.link.syntax &&
      this.link.target === other.link.target &&
      this.link.subpath === other.link.subpath &&
      this.link.label === other.link.label &&
      this.link.external === other.link.external
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const link = document.createElement("span");
    link.className = this.link.external
      ? "tl-live-link tl-live-link-external"
      : "tl-live-link tl-live-link-internal";
    link.textContent = this.link.label;
    link.tabIndex = 0;
    link.setAttribute("role", "link");
    sourceMetadata(link, this.from, this.to, "link");
    link.ariaLabel = `${this.link.label}, ${this.link.external ? "external" : "internal"} link`;
    link.title = this.link.external
      ? "External opening is disabled. Click to edit source."
      : "Click to edit source. Modifier-click to open.";
    const activate = (event: MouseEvent | KeyboardEvent): void => {
      if (isActivationEvent(event)) {
        event.preventDefault();
        event.stopPropagation();
        this.options.activateLink(this.link);
      } else {
        revealSource(view, this.from, event);
      }
    };
    link.addEventListener("mousedown", (event) => {
      if (event.button === 0) {
        activate(event);
      }
    });
    link.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        activate(event);
      }
    });
    return link;
  }
}

class TagWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly tag: string,
    readonly options: LivePreviewOptions,
  ) {
    super();
  }

  eq(other: TagWidget): boolean {
    return this.from === other.from && this.to === other.to && this.tag === other.tag;
  }

  toDOM(): HTMLElement {
    const anchor = document.createElement("a");
    anchor.className = "tag tl-live-tag";
    anchor.href = `#${this.tag}`;
    anchor.dataset.threadleafTag = this.tag;
    anchor.dataset.tagName = `#${this.tag}`;
    anchor.textContent = `#${this.tag}`;
    anchor.ariaLabel = `Search for tag ${this.tag}`;
    anchor.title = `Search notes tagged #${this.tag}`;
    sourceMetadata(anchor, this.from, this.to, "tag");
    const activate = (event: MouseEvent | KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      this.options.activateTag(this.tag);
    };
    anchor.addEventListener("mousedown", (event) => {
      if (event.button === 0) activate(event);
    });
    anchor.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") activate(event);
    });
    return anchor;
  }
}

class EmbedWidget extends WidgetType {
  readonly ownerPath: string | null;
  readonly ownerVaultId: string | null;

  constructor(
    readonly from: number,
    readonly to: number,
    readonly link: LivePreviewLink,
    readonly options: LivePreviewOptions,
  ) {
    super();
    this.ownerPath = options.sourceNotePath();
    this.ownerVaultId = options.expectedVaultId();
  }

  eq(other: EmbedWidget): boolean {
    return (
      this.from === other.from &&
      this.to === other.to &&
      this.link.syntax === other.link.syntax &&
      this.link.target === other.link.target &&
      this.link.subpath === other.link.subpath &&
      this.link.label === other.link.label &&
      this.ownerPath === other.ownerPath &&
      this.ownerVaultId === other.ownerVaultId
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const card = document.createElement("span");
    card.className = "tl-live-embed";
    card.tabIndex = 0;
    card.setAttribute("role", "group");
    card.ariaLabel = `Embedded note ${this.link.label}`;
    const ownerPath = this.ownerPath;
    sourceMetadata(card, this.from, this.to, "transclusion", ownerPath);
    const mark = document.createElement("span");
    mark.className = "tl-live-embed-mark";
    mark.ariaHidden = "true";
    mark.textContent = "◇";
    const label = document.createElement("span");
    label.textContent = this.link.label;
    card.append(mark, label);
    const activate = (event: MouseEvent | KeyboardEvent): void => {
      if (isActivationEvent(event)) {
        event.preventDefault();
        event.stopPropagation();
        this.options.activateLink(this.link);
      } else {
        revealSource(view, this.from, event);
      }
    };
    card.addEventListener("mousedown", (event) => {
      if (event.button === 0) {
        activate(event);
      }
    });
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        activate(event);
      }
    });
    const expectedVaultId = this.ownerVaultId;
    const loadNoteEmbed = this.options.loadNoteEmbed;
    const isCurrentOwner = (): boolean =>
      card.isConnected &&
      this.options.sourceNotePath() === ownerPath &&
      this.options.expectedVaultId() === expectedVaultId;
    const setStatus = (status: string, title?: string): void => {
      card.dataset.tlTransclusionStatus = status;
      mark.textContent = status === "ready" ? "◇" : `◇ ${status.replaceAll("-", " ")}`;
      mark.ariaHidden = status === "ready" ? "true" : "false";
      if (title) {
        card.title = title;
      }
    };
    if (this.link.external) {
      setStatus(
        "external",
        "External embeds stay source-backed and are not loaded in Live Preview.",
      );
    } else if (loadNoteEmbed && ownerPath && expectedVaultId) {
      const maxDepth = this.options.maxTransclusionDepth ?? 4;
      const maxFragments = this.options.maxTransclusionFragments ?? 32;
      const maxBytes = this.options.maxTransclusionBytes ?? 8 * 1024 * 1024;
      card.dataset.tlTransclusionDepth = "1";
      if (maxDepth < 1) {
        setStatus("depth-limit", "This embedded note exceeds the Live Preview depth budget.");
        return card;
      }
      if (maxFragments < 1) {
        setStatus("preview-limit", "This embedded note exceeds the Live Preview fragment budget.");
        return card;
      }
      const budget = { fragments: 0, bytes: 0 };
      const appendNested = (
        owner: string,
        target: string,
        subpath: string | null,
        status: string,
        content: string | null,
        title: string,
      ): void => {
        const nested = document.createElement("span");
        nested.className = "tl-live-embed-nested";
        nested.dataset.tlTransclusionStatus = status;
        nested.dataset.tlSourceOwner = owner;
        nested.dataset.tlTransclusionPath = target;
        nested.dataset.tlTransclusionSubpath = subpath ?? "";
        nested.dataset.tlSourceReveal = "false";
        nested.textContent =
          status === "ready"
            ? `↳ ${content?.replaceAll(/\s+/gu, " ").trim().slice(0, 180) ?? target}`
            : `↳ ${status.replaceAll("-", " ")}`;
        nested.title = title;
        card.append(nested);
      };
      const hydrateNested = async (
        links: readonly WorkspaceLinkSummary[],
        sourcePath: string,
        ancestry: ReadonlySet<string>,
        depth: number,
      ): Promise<void> => {
        for (const link of links) {
          if (!link.embed || !card.isConnected) {
            continue;
          }
          const target = link.target ?? link.path ?? link.label;
          const subpath = link.subpath ?? null;
          if (depth > maxDepth) {
            appendNested(
              sourcePath,
              target,
              subpath,
              "depth-limit",
              null,
              "This nested embed exceeds the Live Preview depth budget.",
            );
            continue;
          }
          if (budget.fragments >= maxFragments) {
            appendNested(
              sourcePath,
              target,
              subpath,
              "preview-limit",
              null,
              "This preview reached its embedded-fragment budget.",
            );
            continue;
          }
          if (link.status !== "resolved" || !link.path) {
            appendNested(
              sourcePath,
              target,
              subpath,
              link.status === "ambiguous" ? "ambiguous" : "missing",
              null,
              `The nested embed target ${target} is not uniquely available.`,
            );
            continue;
          }
          const identity = transclusionIdentity(link.path, subpath);
          if (ancestry.has(identity)) {
            appendNested(
              sourcePath,
              target,
              subpath,
              "cycle",
              null,
              "This nested embed would create a recursive note cycle.",
            );
            continue;
          }
          let response: VaultNoteEmbedResponse;
          try {
            response = await loadNoteEmbed(sourcePath, target, subpath, expectedVaultId);
          } catch {
            if (isCurrentOwner()) {
              appendNested(
                sourcePath,
                target,
                subpath,
                "unavailable",
                null,
                "The nested embedded note request failed.",
              );
            }
            continue;
          }
          if (!isCurrentOwner()) return;
          if (response.status === "stale-vault" || response.vaultId !== expectedVaultId) {
            appendNested(
              sourcePath,
              target,
              subpath,
              "stale-vault",
              null,
              "The active vault changed during nested transclusion.",
            );
            continue;
          }
          if (response.status === "unavailable") {
            appendNested(sourcePath, target, subpath, response.reason, null, response.message);
            continue;
          }
          const responseIdentity = transclusionIdentity(response.path, response.subpath);
          if (ancestry.has(responseIdentity)) {
            appendNested(
              sourcePath,
              target,
              subpath,
              "cycle",
              null,
              "This nested embed would create a recursive note cycle.",
            );
            continue;
          }
          if (budget.bytes + response.contentBytes > maxBytes) {
            appendNested(
              sourcePath,
              target,
              subpath,
              "byte-limit",
              null,
              "This preview reached its embedded-byte budget.",
            );
            continue;
          }
          budget.fragments += 1;
          budget.bytes += response.contentBytes;
          appendNested(
            sourcePath,
            response.path,
            response.subpath,
            "ready",
            response.content,
            `Source-backed nested preview from ${response.path}`,
          );
          await hydrateNested(
            response.links,
            response.path,
            new Set([...ancestry, responseIdentity]),
            depth + 1,
          );
        }
      };
      void loadNoteEmbed(ownerPath, this.link.target, this.link.subpath, expectedVaultId)
        .then((response) => {
          if (!isCurrentOwner()) {
            return;
          }
          if (response.status === "stale-vault" || response.vaultId !== expectedVaultId) {
            setStatus(
              "stale-vault",
              "The active vault changed before this embedded note finished loading.",
            );
            return;
          }
          if (response.status === "unavailable") {
            setStatus(response.reason, response.message);
            return;
          }
          if (
            response.path === ownerPath &&
            response.subpath === null &&
            this.link.subpath === null
          ) {
            setStatus("cycle", "This embedded note points back to its owning source.");
            return;
          }
          if (response.contentBytes > maxBytes) {
            setStatus("byte-limit", "This embedded note exceeds the Live Preview byte budget.");
            return;
          }
          budget.fragments = 1;
          budget.bytes = response.contentBytes;
          setStatus("ready", `Source-backed preview from ${response.path}`);
          card.dataset.tlTransclusionPath = response.path;
          const preview = document.createElement("span");
          preview.className = "tl-live-embed-preview";
          preview.textContent = response.content.replaceAll(/\s+/gu, " ").trim().slice(0, 220);
          preview.title = `Source-backed preview from ${response.path}`;
          card.append(preview);
          void hydrateNested(
            response.links,
            response.path,
            new Set([
              transclusionIdentity(ownerPath, null),
              transclusionIdentity(response.path, response.subpath),
            ]),
            2,
          );
        })
        .catch(() => {
          if (isCurrentOwner()) {
            setStatus("unavailable", "The embedded note request failed.");
          }
        });
    } else {
      setStatus("source-only", "The owning source note is not available for this preview.");
    }
    return card;
  }
}

class ImageWidget extends WidgetType {
  readonly ownerPath: string | null;
  readonly ownerVaultId: string | null;

  constructor(
    readonly from: number,
    readonly to: number,
    readonly link: LivePreviewLink,
    readonly options: LivePreviewOptions,
  ) {
    super();
    this.ownerPath = options.sourceNotePath();
    this.ownerVaultId = options.expectedVaultId();
  }

  eq(other: ImageWidget): boolean {
    return (
      this.from === other.from &&
      this.to === other.to &&
      this.link.target === other.link.target &&
      this.link.label === other.link.label &&
      this.ownerPath === other.ownerPath &&
      this.ownerVaultId === other.ownerVaultId
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const frame = document.createElement("span");
    frame.className = "tl-live-image";
    frame.tabIndex = 0;
    frame.setAttribute("role", "img");
    sourceMetadata(frame, this.from, this.to, "image");
    frame.ariaLabel = this.link.label || this.link.target;
    frame.ariaBusy = "true";
    const placeholder = document.createElement("span");
    placeholder.className = "tl-live-image-placeholder";
    placeholder.textContent = `Image: ${this.link.label || this.link.target}`;
    frame.append(placeholder);
    frame.addEventListener("mousedown", (event) => {
      if (event.button === 0) {
        revealSource(view, this.from, event);
      }
    });
    frame.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        revealSource(view, this.from, event);
      }
    });

    const sourceNotePath = this.ownerPath;
    const expectedVaultId = this.ownerVaultId;
    if (!sourceNotePath || !expectedVaultId || this.link.external) {
      frame.ariaBusy = "false";
      frame.dataset.status = "unavailable";
      frame.dataset.reason = !sourceNotePath
        ? "missing-source-note"
        : !expectedVaultId
          ? "missing-vault"
          : "external";
      return frame;
    }
    void this.options
      .loadImage(sourceNotePath, this.link.target, expectedVaultId)
      .then((response) => {
        if (!frame.isConnected) {
          return;
        }
        frame.ariaBusy = "false";
        if (
          response.status !== "ready" ||
          response.vaultId !== expectedVaultId ||
          this.options.sourceNotePath() !== sourceNotePath ||
          this.options.expectedVaultId() !== expectedVaultId
        ) {
          frame.dataset.status = "unavailable";
          frame.dataset.reason =
            response.status !== "ready"
              ? response.status
              : response.vaultId !== expectedVaultId
                ? "vault-response-mismatch"
                : this.options.sourceNotePath() !== sourceNotePath
                  ? "source-note-changed"
                  : "active-vault-changed";
          if (response.status === "unavailable") {
            frame.title = response.message;
          }
          return;
        }
        const image = document.createElement("img");
        image.className = "tl-live-image-content";
        image.alt = this.link.label;
        image.decoding = "async";
        image.src = `data:${response.mimeType};base64,${response.base64}`;
        image.addEventListener("error", () => {
          if (frame.contains(image)) {
            frame.dataset.status = "unavailable";
            frame.dataset.reason = "decode-failed";
            image.replaceWith(placeholder);
          }
        });
        frame.dataset.status = "ready";
        frame.replaceChildren(image);
        view.requestMeasure();
      })
      .catch(() => {
        if (frame.isConnected) {
          frame.ariaBusy = "false";
          frame.dataset.status = "unavailable";
          frame.dataset.reason = "load-failed";
        }
      });
    return frame;
  }
}

class CalloutWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly label: string,
  ) {
    super();
  }

  eq(other: CalloutWidget): boolean {
    return this.from === other.from && this.to === other.to && this.label === other.label;
  }

  toDOM(view: EditorView): HTMLElement {
    const badge = document.createElement("span");
    badge.className = "tl-live-callout";
    badge.textContent = this.label;
    sourceMetadata(badge, this.from, this.to, "callout");
    badge.addEventListener("mousedown", (event) => {
      if (event.button === 0) {
        revealSource(view, this.from, event);
      }
    });
    return badge;
  }
}

class FootnoteWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly id: string,
    readonly number: number,
  ) {
    super();
  }

  eq(other: FootnoteWidget): boolean {
    return (
      this.from === other.from &&
      this.to === other.to &&
      this.id === other.id &&
      this.number === other.number
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const reference = document.createElement("sup");
    reference.className = "tl-live-footnote-ref";
    reference.textContent = String(this.number);
    reference.tabIndex = 0;
    reference.setAttribute("role", "doc-noteref");
    reference.ariaLabel = `Footnote ${this.number}`;
    sourceMetadata(reference, this.from, this.to, "footnote-ref");
    const reveal = (event: MouseEvent | KeyboardEvent): void => {
      revealSource(view, this.from, event);
    };
    reference.addEventListener("mousedown", (event) => {
      if (event.button === 0) reveal(event);
    });
    reference.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") reveal(event);
    });
    return reference;
  }
}

class MathWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly expression: string,
    readonly display: boolean,
    readonly revealAt = from,
  ) {
    super();
  }

  eq(other: MathWidget): boolean {
    return (
      this.from === other.from &&
      this.to === other.to &&
      this.expression === other.expression &&
      this.display === other.display &&
      this.revealAt === other.revealAt
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const math = createSafeMathElement(document, this.expression, this.display);
    if (!math) {
      const fallback = document.createElement("span");
      fallback.textContent = this.expression;
      return fallback;
    }
    math.tabIndex = 0;
    sourceMetadata(math, this.from, this.to, "math");
    math.title = "Click to edit the exact math source";
    math.addEventListener("mousedown", (event) => {
      if (event.button === 0) revealSource(view, this.revealAt, event);
    });
    math.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") revealSource(view, this.revealAt, event);
    });
    return math;
  }
}

class MathBlockSpacerWidget extends WidgetType {
  toDOM(): HTMLElement {
    const spacer = document.createElement("span");
    spacer.className = "tl-live-math-block-spacer";
    spacer.ariaHidden = "true";
    return spacer;
  }

  eq(): boolean {
    return true;
  }
}

class BulletWidget extends WidgetType {
  toDOM(): HTMLElement {
    const bullet = document.createElement("span");
    bullet.className = "tl-live-bullet";
    bullet.ariaHidden = "true";
    bullet.textContent = "•";
    return bullet;
  }

  eq(): boolean {
    return true;
  }
}

class TaskWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly checked: boolean,
  ) {
    super();
  }

  eq(other: TaskWidget): boolean {
    return this.from === other.from && this.to === other.to && this.checked === other.checked;
  }

  toDOM(view: EditorView): HTMLElement {
    const checkbox = document.createElement("input");
    checkbox.className = "tl-live-task";
    checkbox.type = "checkbox";
    checkbox.checked = this.checked;
    checkbox.disabled = view.state.readOnly;
    sourceMetadata(checkbox, this.from, this.to, "task");
    checkbox.ariaLabel = this.checked ? "Completed task" : "Open task";
    checkbox.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (view.state.readOnly) {
        checkbox.checked = this.checked;
        return;
      }
      const current = view.state.doc.sliceString(this.from, this.to);
      if (!/^\[[ xX]\]$/u.test(current)) {
        checkbox.checked = this.checked;
        return;
      }
      view.dispatch({
        changes: {
          from: this.from,
          to: this.to,
          insert: current[1]?.toLocaleLowerCase("en-US") === "x" ? "[ ]" : "[x]",
        },
      });
      view.focus();
    });
    return checkbox;
  }
}

function activeLineRanges(view: EditorView): SourceRange[] {
  const ranges = view.state.selection.ranges.map((selection) => ({
    from: view.state.doc.lineAt(selection.from).from,
    to: view.state.doc.lineAt(selection.to).to,
  }));
  if (view.composing) {
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    ranges.push({ from: line.from, to: line.to });
  }
  return ranges;
}

function sameInactiveLine(
  view: EditorView,
  range: SourceRange,
  active: readonly SourceRange[],
): boolean {
  return (
    view.state.doc.lineAt(range.from).number ===
      view.state.doc.lineAt(Math.max(range.from, range.to - 1)).number &&
    !intersectsAny({ from: range.from, to: Math.max(range.from + 1, range.to) }, active)
  );
}

function visibleLines(view: EditorView): { from: number; to: number; text: string }[] {
  const seen = new Set<number>();
  const lines: { from: number; to: number; text: string }[] = [];
  for (const range of view.visibleRanges) {
    let line = view.state.doc.lineAt(range.from);
    while (true) {
      if (!seen.has(line.number)) {
        seen.add(line.number);
        lines.push({ from: line.from, to: line.to, text: line.text });
      }
      if (line.to >= range.to || line.number >= view.state.doc.lines) {
        break;
      }
      line = view.state.doc.line(line.number + 1);
    }
  }
  return lines;
}

interface LiveTableCell {
  value: string;
  align: "left" | "center" | "right";
}

interface LiveTableData {
  header: LiveTableCell[];
  rows: LiveTableCell[][];
}

interface LiveMathBlock {
  from: number;
  to: number;
  expression: string;
  renderLine: number;
  lines: SourceRange[];
}

function tableCells(line: string): string[] {
  let value = line.trim().replace(/\r$/u, "");
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|")) value = value.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (character === "\\" && value[index + 1] === "|") {
      current += "|";
      index += 1;
    } else if (character === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  cells.push(current.trim());
  return cells;
}

function tableAlignment(value: string): "left" | "center" | "right" | null {
  if (!/^:?-{1,}:?$/u.test(value)) return null;
  if (value.startsWith(":") && value.endsWith(":")) return "center";
  if (value.endsWith(":")) return "right";
  return "left";
}

function parseLiveTable(source: string): LiveTableData | null {
  const lines = source.split(/\r?\n/u);
  if (lines.length < 2 || lines.some((line) => line.trim().length === 0)) return null;
  const headerValues = tableCells(lines[0] ?? "");
  const separators = tableCells(lines[1] ?? "");
  if (headerValues.length === 0 || separators.length !== headerValues.length) return null;
  const alignments = separators.map(tableAlignment);
  if (alignments.some((alignment): alignment is null => alignment === null)) return null;
  const header = headerValues.map((value, index) => ({
    value,
    align: alignments[index] as "left" | "center" | "right",
  }));
  const rows: LiveTableCell[][] = [];
  for (const line of lines.slice(2)) {
    const values = tableCells(line);
    if (values.length !== header.length) return null;
    rows.push(
      values.map((value, index) => ({
        value,
        align: header[index]?.align ?? "left",
      })),
    );
  }
  return { header, rows };
}

function collectVisibleMathBlocks(
  view: EditorView,
  protectedRanges: readonly SourceRange[],
): LiveMathBlock[] {
  const blocks: LiveMathBlock[] = [];
  const scannedStarts = new Set<number>();
  for (const visible of view.visibleRanges) {
    // Include a bounded look-behind so scrolling into the middle or closing
    // delimiter of a block still discovers its opening marker.
    const firstLine = Math.max(1, view.state.doc.lineAt(visible.from).number - 64);
    const lastLine = view.state.doc.lineAt(Math.min(visible.to, view.state.doc.length)).number;
    for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber += 1) {
      if (scannedStarts.has(lineNumber)) continue;
      scannedStarts.add(lineNumber);
      const opening = view.state.doc.line(lineNumber);
      const marker = opening.text.trim();
      const closingMarker = marker === "$$" ? "$$" : marker === "\\[" ? "\\]" : null;
      if (!closingMarker) continue;
      const expressionLines: string[] = [];
      let closingLine: { from: number; to: number; number: number } | null = null;
      for (
        let candidateNumber = lineNumber + 1;
        candidateNumber <= view.state.doc.lines && candidateNumber <= lineNumber + 64;
        candidateNumber += 1
      ) {
        const candidate = view.state.doc.line(candidateNumber);
        if (candidate.text.trim() === closingMarker) {
          closingLine = candidate;
          break;
        }
        expressionLines.push(candidate.text);
      }
      if (!closingLine || expressionLines.join("\n").trim().length === 0) continue;
      const lineRanges: SourceRange[] = [];
      for (let number = lineNumber; number <= closingLine.number; number += 1) {
        const current = view.state.doc.line(number);
        lineRanges.push({ from: current.from, to: current.to });
      }
      const blockRange = { from: opening.from, to: closingLine.to };
      if (lineRanges.some((range) => intersectsAny(range, protectedRanges))) continue;
      const expression = expressionLines.join("\n");
      if (!renderSafeMath(expression)) continue;
      blocks.push({
        from: blockRange.from,
        to: blockRange.to,
        expression,
        renderLine: lineNumber + 1,
        lines: lineRanges,
      });
      // The close marker is part of this block and must not start another
      // scan when a visible range begins near the end of the block.
      for (let number = lineNumber; number <= closingLine.number; number += 1) {
        scannedStarts.add(number);
      }
    }
  }
  return blocks;
}

function collectSourceOnlyLineNumbers(
  view: EditorView,
  footnoteDefinitionLines: ReadonlySet<number>,
): Set<number> {
  const sourceOnly = new Set(footnoteDefinitionLines);
  const frontmatter = scanFrontmatter(view.state.doc.toString());
  if (frontmatter.status === "unresolved") {
    for (let lineNumber = 1; lineNumber <= view.state.doc.lines; lineNumber += 1) {
      sourceOnly.add(lineNumber);
    }
  } else if (frontmatter.status === "resolved" && frontmatter.closingLine !== null) {
    for (let lineNumber = 1; lineNumber <= frontmatter.closingLine; lineNumber += 1) {
      sourceOnly.add(lineNumber);
    }
  }
  return sourceOnly;
}

type LiveTableRowKind = "header" | "separator" | "body";

class TableRowWidget extends WidgetType {
  constructor(
    readonly sourceFrom: number,
    readonly sourceTo: number,
    readonly kind: LiveTableRowKind,
    readonly cells: readonly LiveTableCell[],
    readonly columns: number,
    readonly lineSource: string,
  ) {
    super();
  }

  eq(other: TableRowWidget): boolean {
    return (
      this.sourceFrom === other.sourceFrom &&
      this.sourceTo === other.sourceTo &&
      this.kind === other.kind &&
      this.columns === other.columns &&
      this.lineSource === other.lineSource &&
      this.cells.length === other.cells.length &&
      this.cells.every(
        (cell, index) =>
          cell.value === other.cells[index]?.value && cell.align === other.cells[index]?.align,
      )
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const frame = document.createElement("span");
    frame.className = `tl-live-table-widget tl-live-table-row-${this.kind}`;
    frame.setAttribute("role", "row");
    sourceMetadata(frame, this.sourceFrom, this.sourceTo, "table");
    frame.title = "Click to edit the exact table source";
    const reveal = (event: MouseEvent | KeyboardEvent): void => {
      revealSource(view, this.sourceFrom, event);
    };
    frame.addEventListener("mousedown", (event) => {
      if (event.button === 0) reveal(event);
    });
    frame.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") reveal(event);
    });
    if (this.kind === "separator") {
      // The alignment row is meaningful table structure and remains a
      // source-reveal target, but it is not an interactive stop in the tab
      // order. Do not hide it from assistive technology or expose a focusable
      // span that contains no cells.
      frame.setAttribute("aria-label", "Table alignment row");
      return frame;
    }
    frame.tabIndex = 0;
    frame.style.setProperty("--tl-live-table-columns", String(this.columns));
    for (const cell of this.cells) {
      const element = document.createElement("span");
      element.className = `tl-live-table-cell align-${cell.align}`;
      element.setAttribute("role", this.kind === "header" ? "columnheader" : "cell");
      element.textContent = cell.value;
      frame.append(element);
    }
    return frame;
  }
}

function buildDecorations(view: EditorView, options: LivePreviewOptions): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const active = activeLineRanges(view);
  const source = view.state.doc.toString();
  const frontmatter = scanFrontmatter(source);
  if (frontmatter.status === "unresolved") {
    return Decoration.none;
  }
  const footnotes = collectFootnotes(source);
  const footnoteNumbers = new Map([...footnotes.ids].map((id, index) => [id, index + 1] as const));
  const protectedRanges: SourceRange[] = [];
  const htmlRanges = markdownHtmlRanges(source);
  protectedRanges.push(...htmlRanges);
  const sourceOnlyLineNumbers = collectSourceOnlyLineNumbers(view, footnotes.definitionLines);
  const sourceOnlyRanges = [...sourceOnlyLineNumbers].map((lineNumber) => {
    const line = view.state.doc.line(lineNumber);
    return { from: line.from, to: line.to };
  });
  protectedRanges.push(...sourceOnlyRanges);
  const replacedRanges: SourceRange[] = [];
  const fallbackRanges: SourceRange[] = [];
  const tableRanges: SourceRange[] = [];
  const lineClasses = new Map<number, Set<string>>();
  const addLineClass = (position: number, className: string): void => {
    const line = view.state.doc.lineAt(Math.min(position, view.state.doc.length));
    const classes = lineClasses.get(line.from) ?? new Set<string>();
    classes.add(className);
    lineClasses.set(line.from, classes);
  };
  const addNodeLines = (from: number, to: number, className: string): void => {
    let line = view.state.doc.lineAt(from);
    const endLine = view.state.doc.lineAt(Math.max(from, to - 1)).number;
    while (line.number <= endLine) {
      addLineClass(line.from, className);
      if (line.number === endLine) {
        break;
      }
      line = view.state.doc.line(line.number + 1);
    }
  };

  for (const visible of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from: visible.from,
      to: visible.to,
      enter(node) {
        if (["InlineCode", "FencedCode", "CodeText", "HTMLBlock", "HTMLTag"].includes(node.name)) {
          protectedRanges.push({ from: node.from, to: node.to });
        }
        if (node.name === "Table") {
          const range = { from: node.from, to: node.to };
          if (
            !intersectsAny(range, sourceOnlyRanges) &&
            !intersectsAny(range, htmlRanges) &&
            !intersectsAny(range, active) &&
            !tableRanges.some(
              (candidate) => candidate.from === range.from && candidate.to === range.to,
            )
          ) {
            tableRanges.push(range);
          }
        }
      },
    });
  }

  const validTableRanges = tableRanges.filter((range) =>
    Boolean(parseLiveTable(view.state.doc.sliceString(range.from, range.to))),
  );
  tableRanges.length = 0;
  tableRanges.push(...validTableRanges);
  const mathBlocks = collectVisibleMathBlocks(view, protectedRanges);
  const orderedProtectedRanges = mergeSourceRanges([
    ...subtractSourceRanges(protectedRanges, htmlRanges),
    ...htmlRanges,
  ]);
  const lineProtectedCursor: SourceRangeCursor = { index: 0 };
  for (const range of tableRanges) {
    const source = view.state.doc.sliceString(range.from, range.to);
    const data = parseLiveTable(source);
    if (!data) continue;
    const rows: { kind: LiveTableRowKind; cells: readonly LiveTableCell[] }[] = [
      { kind: "header", cells: data.header },
      { kind: "separator", cells: [] },
      ...data.rows.map((cells) => ({ kind: "body" as const, cells })),
    ];
    const startLine = view.state.doc.lineAt(range.from);
    const endLine = view.state.doc.lineAt(Math.max(range.from, range.to - 1));
    if (endLine.number - startLine.number + 1 !== rows.length) continue;
    let line = startLine;
    for (const row of rows) {
      const lineSource = view.state.doc.sliceString(line.from, line.to);
      ranges.push(
        Decoration.replace({
          widget: new TableRowWidget(
            line.from,
            line.to,
            row.kind,
            row.cells,
            data.header.length,
            lineSource,
          ),
          inclusive: true,
        }).range(line.from, line.to),
      );
      replacedRanges.push({ from: line.from, to: line.to });
      if (line.number === endLine.number) break;
      line = view.state.doc.line(line.number + 1);
    }
  }

  for (const line of visibleLines(view)) {
    if (tableRanges.some((range) => rangesIntersect(range, { from: line.from, to: line.to }))) {
      continue;
    }
    const lineRange = { from: line.from, to: line.to };
    const localAbsoluteProtectedRanges = rangesForLine(
      lineRange,
      orderedProtectedRanges,
      lineProtectedCursor,
    );
    const lineNumber = view.state.doc.lineAt(line.from).number;
    if (sourceOnlyLineNumbers.has(lineNumber)) {
      if (footnotes.definitionLines.has(lineNumber)) {
        addLineClass(line.from, "tl-live-footnote-definition-line");
      }
      continue;
    }
    const mathBlock = mathBlocks.find((block) =>
      block.lines.some((range) => range.from === line.from && range.to === line.to),
    );
    if (mathBlock && !intersectsAny({ from: mathBlock.from, to: mathBlock.to }, active)) {
      const widget =
        view.state.doc.lineAt(line.from).number === mathBlock.renderLine
          ? new MathWidget(
              mathBlock.from,
              mathBlock.to,
              mathBlock.expression,
              true,
              view.state.doc.line(mathBlock.renderLine).from,
            )
          : new MathBlockSpacerWidget();
      ranges.push(Decoration.replace({ widget, inclusive: true }).range(line.from, line.to));
      replacedRanges.push(lineRange);
      continue;
    }
    const lineActive = intersectsAny(
      { from: line.from, to: Math.max(line.from + 1, line.to) },
      active,
    );
    const tokens = parseLivePreviewLine(line.text, line.from, localAbsoluteProtectedRanges, {
      footnoteIds: footnotes.ids,
    });
    const localProtectedRanges = localAbsoluteProtectedRanges.map((range) => ({
      from: Math.max(0, range.from - line.from),
      to: Math.min(line.text.length, range.to - line.from),
    }));
    const lineMapping = buildLivePreviewMapping(line.text, {
      protectedRanges: localProtectedRanges,
    });
    for (const mapped of lineMapping.tokens) {
      if (mapped.status === "fallback" && mapped.kind === "source-block") {
        fallbackRanges.push({
          from: line.from + mapped.from,
          to: line.from + mapped.to,
        });
      }
    }
    for (const token of tokens) {
      const mapped = lineMapping.tokens.find(
        (candidate) =>
          candidate.from === token.from - line.from && candidate.to === token.to - line.from,
      );
      if (mapped?.status === "fallback") {
        fallbackRanges.push(token);
      }
      if (token.kind === "tag") {
        if (mapped?.status === "fallback" || lineActive) {
          ranges.push(
            Decoration.mark({
              class: "tl-live-tag tl-live-tag-source",
              attributes: {
                "data-tl-source-from": String(token.from),
                "data-tl-source-to": String(token.to),
                "data-tl-mapping-kind": "tag",
              },
            }).range(token.from, token.to),
          );
        } else {
          ranges.push(
            Decoration.replace({
              widget: new TagWidget(token.from, token.to, token.label, options),
            }).range(token.from, token.to),
          );
          replacedRanges.push(token);
        }
        continue;
      }
      if (mapped?.status === "fallback") {
        continue;
      }
      if (lineActive) {
        continue;
      }
      let widget: WidgetType;
      if (token.kind === "callout") {
        widget = new CalloutWidget(token.from, token.to, token.label);
        addLineClass(token.from, "tl-live-callout-line");
      } else if (token.kind === "image" && token.link) {
        widget = new ImageWidget(token.from, token.to, token.link, options);
      } else if (token.kind === "embed" && token.link) {
        widget = new EmbedWidget(token.from, token.to, token.link, options);
      } else if (token.kind === "footnote-ref" && token.footnoteId) {
        const number = footnoteNumbers.get(token.footnoteId);
        if (!number) continue;
        widget = new FootnoteWidget(token.from, token.to, token.footnoteId, number);
      } else if (token.kind === "math" && token.mathExpression) {
        widget = new MathWidget(token.from, token.to, token.mathExpression, false);
      } else if (token.link) {
        widget = new LinkWidget(token.from, token.to, token.link, options);
      } else {
        continue;
      }
      ranges.push(Decoration.replace({ widget }).range(token.from, token.to));
      replacedRanges.push(token);
    }
  }

  for (const visible of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from: visible.from,
      to: visible.to,
      enter(node) {
        const nodeRange = { from: node.from, to: node.to };
        if (intersectsAny(nodeRange, sourceOnlyRanges)) {
          return;
        }
        if (intersectsAny(nodeRange, htmlRanges)) {
          return;
        }
        const replaced = intersectsAny(nodeRange, replacedRanges);
        const inactive = sameInactiveLine(view, nodeRange, active);
        const mark = (className: string): void => {
          if (!replaced && node.from < node.to) {
            ranges.push(
              Decoration.mark({
                class: className,
                attributes: { "data-tl-source-from": String(node.from) },
              }).range(node.from, node.to),
            );
          }
        };
        const hide = (from = node.from, to = node.to): void => {
          if (!replaced && inactive && from < to && !intersectsAny({ from, to }, fallbackRanges)) {
            ranges.push(Decoration.replace({}).range(from, to));
          }
        };

        const heading = /^ATXHeading([1-6])$/u.exec(node.name);
        if (heading?.[1]) {
          addLineClass(node.from, `tl-live-heading tl-live-heading-${heading[1]}`);
          return;
        }
        switch (node.name) {
          case "HeaderMark": {
            const line = view.state.doc.lineAt(node.from);
            const following = view.state.doc.sliceString(node.to, Math.min(line.to, node.to + 1));
            hide(node.from, following === " " ? node.to + 1 : node.to);
            break;
          }
          case "StrongEmphasis":
            mark("tl-live-strong");
            break;
          case "Emphasis":
            mark("tl-live-emphasis");
            break;
          case "Strikethrough":
            mark("tl-live-strikethrough");
            break;
          case "EmphasisMark":
          case "StrikethroughMark":
            hide();
            break;
          case "InlineCode":
            mark("tl-live-inline-code");
            break;
          case "CodeMark":
            if (node.to - node.from < 3) {
              hide();
            }
            break;
          case "Blockquote":
            addNodeLines(node.from, node.to, "tl-live-blockquote-line");
            break;
          case "QuoteMark": {
            const line = view.state.doc.lineAt(node.from);
            const following = view.state.doc.sliceString(node.to, Math.min(line.to, node.to + 1));
            hide(node.from, following === " " ? node.to + 1 : node.to);
            break;
          }
          case "ListItem":
            addLineClass(node.from, "tl-live-list-line");
            break;
          case "ListMark": {
            const marker = view.state.doc.sliceString(node.from, node.to);
            if (inactive && /^[*+-]$/u.test(marker) && !replaced) {
              ranges.push(
                Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to),
              );
            }
            break;
          }
          case "Task":
            addLineClass(node.from, "tl-live-task-line");
            break;
          case "TaskMarker": {
            if (inactive && !replaced) {
              const marker = view.state.doc.sliceString(node.from, node.to);
              ranges.push(
                Decoration.replace({
                  widget: new TaskWidget(node.from, node.to, /[xX]/u.test(marker)),
                }).range(node.from, node.to),
              );
            }
            break;
          }
          case "FencedCode":
            addNodeLines(node.from, node.to, "tl-live-code-line");
            break;
          case "Table":
            if (!replaced) {
              addNodeLines(node.from, node.to, "tl-live-table-source-line");
            }
            break;
          case "HorizontalRule":
            addLineClass(node.from, "tl-live-rule-line");
            break;
        }
      },
    });
  }

  const firstLine = view.state.doc.line(1);
  if (firstLine.text.replace(/^\uFEFF/u, "").trim() === "---") {
    for (let lineNumber = 1; lineNumber <= Math.min(view.state.doc.lines, 256); lineNumber += 1) {
      const line = view.state.doc.line(lineNumber);
      addLineClass(line.from, "tl-live-frontmatter-line");
      if (lineNumber > 1 && ["---", "..."].includes(line.text.trim())) {
        break;
      }
    }
  }

  for (const [from, classes] of lineClasses) {
    ranges.push(
      Decoration.line({
        class: [...classes].sort().join(" "),
        attributes: { "data-tl-source-from": String(from) },
      }).range(from),
    );
  }
  return Decoration.set(ranges, true);
}

const refreshLivePreview = StateEffect.define<null>();

export function createLivePreviewExtension(options: LivePreviewOptions): Extension {
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
          this.decorations = buildDecorations(view, options);
        }

        update(update: ViewUpdate): void {
          if (
            update.docChanged ||
            update.selectionSet ||
            update.viewportChanged ||
            update.transactions.some((transaction) =>
              transaction.effects.some((effect) => effect.is(refreshLivePreview)),
            )
          ) {
            this.decorations = buildDecorations(update.view, options);
          }
        }
      },
      { decorations: (plugin) => plugin.decorations },
    ),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0 || !(event.target instanceof Element)) {
          return false;
        }
        const source = event.target.closest<HTMLElement>("[data-tl-source-from]");
        const from = Number.parseInt(source?.dataset.tlSourceFrom ?? "", 10);
        if (!Number.isSafeInteger(from) || from < 0) {
          return false;
        }
        revealSource(view, from, event);
        return true;
      },
      compositionstart(_event, view) {
        view.dispatch({ effects: refreshLivePreview.of(null) });
        return false;
      },
      compositionupdate(_event, view) {
        view.dispatch({ effects: refreshLivePreview.of(null) });
        return false;
      },
      compositionend(_event, view) {
        view.dispatch({ effects: refreshLivePreview.of(null) });
        return false;
      },
      beforeinput(event, view) {
        if (event.isComposing) {
          view.dispatch({ effects: refreshLivePreview.of(null) });
        }
        return false;
      },
    }),
  ];
}
