/**
 * Small, deliberately conservative Markdown extensions used by Reading and
 * Live Preview.
 *
 * These helpers never mutate the input note.  A construct is rendered only
 * when its complete source can be parsed by the bounded grammar below.  The
 * caller can therefore keep an unrecognised construct as ordinary source
 * instead of guessing at its meaning.
 */

export interface FootnoteDefinition {
  id: string;
  sourceLine: number;
  sourceFrom: number;
  content: string;
}

export interface FootnoteCollection {
  body: string;
  definitions: readonly FootnoteDefinition[];
  ids: ReadonlySet<string>;
  definitionLines: ReadonlySet<number>;
}

/**
 * Frontmatter is source-only in both renderer paths.  The bounded scan is
 * deliberate: an unterminated opening marker must not turn an arbitrarily
 * large note into a renderer/parser workload.
 */
export const maxFrontmatterScanLines = 256;

export interface SourceLine {
  text: string;
  ending: "" | "lf" | "crlf" | "cr";
}

export function sourceLinesWithEndings(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let lineStart = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (character !== "\r" && character !== "\n") {
      continue;
    }
    const ending =
      character === "\r" && source[index + 1] === "\n" ? "crlf" : character === "\r" ? "cr" : "lf";
    lines.push({ text: source.slice(lineStart, index), ending });
    index += ending === "crlf" ? 1 : 0;
    lineStart = index + 1;
  }
  lines.push({ text: source.slice(lineStart), ending: "" });
  return lines;
}

export function splitSourceLines(source: string): string[] {
  return sourceLinesWithEndings(source).map(({ text }) => text);
}

export function sourceLineStarts(source: string): number[] {
  const starts: number[] = [];
  let offset = 0;
  for (const line of sourceLinesWithEndings(source)) {
    starts.push(offset);
    offset +=
      line.text.length +
      (line.ending === "crlf" ? 2 : line.ending === "cr" || line.ending === "lf" ? 1 : 0);
  }
  return starts;
}

export interface MarkdownSourceRange {
  from: number;
  to: number;
}

interface MarkdownFence {
  marker: "`" | "~";
  length: number;
}

function stripLineCarriageReturn(line: string): string {
  return line.replace(/\r$/u, "");
}

function fenceRun(line: string): { fence: MarkdownFence; trailing: string } | null {
  const match = /^ {0,3}(`+|~+)(.*)$/u.exec(stripLineCarriageReturn(line));
  const run = match?.[1];
  if (!run || run.length < 3) {
    return null;
  }
  const marker = run[0];
  if (marker !== "`" && marker !== "~") {
    return null;
  }
  return {
    fence: { marker, length: run.length },
    trailing: match?.[2] ?? "",
  };
}

function openingFence(line: string): MarkdownFence | null {
  const run = fenceRun(line);
  // A backtick fence cannot carry another backtick in its info string. Treat
  // that line as ordinary source rather than accidentally changing fence state.
  if (!run || (run.fence.marker === "`" && run.trailing.includes("`"))) {
    return null;
  }
  return run.fence;
}

function closesFence(line: string, opening: MarkdownFence): boolean {
  const run = fenceRun(line);
  return Boolean(
    run &&
      run.fence.marker === opening.marker &&
      run.fence.length >= opening.length &&
      /^[ \t]*$/u.test(run.trailing),
  );
}

export interface MarkdownCodeRangeScanStats {
  steps: number;
}

interface BacktickRun {
  from: number;
  to: number;
  length: number;
  escaped: boolean;
}

function scanBacktickRuns(line: string, stats?: MarkdownCodeRangeScanStats): BacktickRun[] {
  const runs: BacktickRun[] = [];
  let index = 0;
  let backslashRun = 0;
  while (index < line.length) {
    if (stats) stats.steps += 1;
    const character = line[index] ?? "";
    if (character === "\\") {
      backslashRun += 1;
      index += 1;
      continue;
    }
    if (character !== "`") {
      backslashRun = 0;
      index += 1;
      continue;
    }
    const from = index;
    const escaped = backslashRun % 2 === 1;
    backslashRun = 0;
    while (line[index] === "`") {
      if (stats) stats.steps += 1;
      index += 1;
    }
    runs.push({ from, to: index, length: index - from, escaped });
  }
  return runs;
}

function inlineCodeRanges(
  line: string,
  lineFrom: number,
  stats?: MarkdownCodeRangeScanStats,
): MarkdownSourceRange[] {
  const ranges: MarkdownSourceRange[] = [];
  const runs = scanBacktickRuns(line, stats);
  const nextSame = new Array<number>(runs.length).fill(-1);
  const nextAfterEscaped = new Array<number>(runs.length).fill(-1);
  const nextByLength = new Map<number, number>();
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    if (stats) stats.steps += 1;
    const run = runs[index];
    if (!run) continue;
    nextSame[index] = nextByLength.get(run.length) ?? -1;
    if (run.length > 1) {
      nextAfterEscaped[index] = nextByLength.get(run.length - 1) ?? -1;
    }
    nextByLength.set(run.length, index);
  }

  for (let index = 0; index < runs.length; ) {
    if (stats) stats.steps += 1;
    const opener = runs[index];
    if (!opener) break;
    // Match the old scanner's delimiter rule: an escaped run is skipped one
    // code unit at a time, so any remaining backticks may begin a shorter
    // opener.  A run considered as a closer remains a full raw run, even if
    // its first backtick was escaped.
    const closeIndex = (opener.escaped ? nextAfterEscaped[index] : nextSame[index]) ?? -1;
    const openerFrom = opener.from + (opener.escaped ? 1 : 0);
    if (opener.escaped && opener.length < 2) {
      index += 1;
      continue;
    }
    if (closeIndex < 0) {
      index += 1;
      continue;
    }
    const closer = runs[closeIndex];
    if (!closer) break;
    ranges.push({ from: lineFrom + openerFrom, to: lineFrom + closer.to });
    index = closeIndex + 1;
  }
  return ranges;
}

/**
 * Source-only code ranges for the standalone Live Preview mapping. The mounted
 * editor uses its syntax tree too, but this bounded scanner keeps the public
 * pure mapping honest when no CodeMirror view is available.
 */
export function markdownCodeRanges(
  source: string,
  stats?: MarkdownCodeRangeScanStats,
): MarkdownSourceRange[] {
  const ranges: MarkdownSourceRange[] = [];
  if (stats) stats.steps = 0;
  const lines = splitSourceLines(source);
  const starts = sourceLineStarts(source);
  let opening: MarkdownFence | null = null;
  let fenceFrom = 0;

  for (const [index, line] of lines.entries()) {
    const lineFrom = starts[index] ?? source.length;
    const lineTo = lineFrom + line.length;
    if (opening) {
      if (closesFence(line, opening)) {
        ranges.push({ from: fenceFrom, to: lineTo });
        opening = null;
      }
      continue;
    }
    const nextOpening = openingFence(line);
    if (nextOpening) {
      opening = nextOpening;
      fenceFrom = lineFrom;
      continue;
    }
    ranges.push(...inlineCodeRanges(line, lineFrom, stats));
  }
  if (opening) {
    ranges.push({ from: fenceFrom, to: source.length });
  }
  return ranges;
}

const htmlVoidElements = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

interface HtmlTagScan {
  kind: "opening" | "closing" | "standalone";
  name: string | null;
  end: number;
  complete: boolean;
  selfClosing: boolean;
}

function htmlTagEnd(source: string, from: number): number {
  let quote: "'" | '"' | null = null;
  for (let index = from + 1; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (character === ">") {
      return index + 1;
    }
  }
  return -1;
}

function htmlTagName(source: string, from: number): { name: string; end: number } | null {
  const first = source[from] ?? "";
  if (!/[A-Za-z]/u.test(first)) return null;
  let end = from + 1;
  while (/[A-Za-z0-9-]/u.test(source[end] ?? "")) end += 1;
  return { name: source.slice(from, end).toLowerCase(), end };
}

function scanHtmlTag(source: string, from: number): HtmlTagScan | null {
  if (source[from] !== "<") return null;
  if (source.startsWith("<!--", from)) {
    const close = source.indexOf("-->", from + 4);
    return {
      kind: "standalone",
      name: null,
      end: close < 0 ? source.length : close + 3,
      complete: close >= 0,
      selfClosing: true,
    };
  }
  if (source.startsWith("<![CDATA[", from)) {
    const close = source.indexOf("]]>", from + 9);
    return {
      kind: "standalone",
      name: null,
      end: close < 0 ? source.length : close + 3,
      complete: close >= 0,
      selfClosing: true,
    };
  }
  const next = source[from + 1] ?? "";
  if (next === "!" || next === "?") {
    const end = htmlTagEnd(source, from);
    return {
      kind: "standalone",
      name: null,
      end: end < 0 ? source.length : end,
      complete: end >= 0,
      selfClosing: true,
    };
  }

  const closing = next === "/";
  const name = htmlTagName(source, from + (closing ? 2 : 1));
  if (!name) return null;
  const boundary = source[name.end] ?? "";
  if (boundary && !/[\s/>]/u.test(boundary)) return null;
  const end = htmlTagEnd(source, from);
  const tagEnd = end < 0 ? source.length : end;
  const body = source.slice(from, tagEnd);
  return {
    kind: closing ? "closing" : "opening",
    name: name.name,
    end: tagEnd,
    complete: end >= 0,
    selfClosing: !closing && /\/\s*>$/u.test(body),
  };
}

function mergeMarkdownRanges(ranges: readonly MarkdownSourceRange[]): MarkdownSourceRange[] {
  const merged: MarkdownSourceRange[] = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range.from <= previous.to) {
      previous.to = Math.max(previous.to, range.to);
    } else if (range.from < range.to) {
      merged.push({ ...range });
    }
  }
  return merged;
}

export interface MarkdownHtmlRangeScanStats {
  steps: number;
  maxOpenTags: number;
}

/**
 * Source-only ranges for raw HTML. Markdown treats the contents between an
 * opening and closing tag as HTML source, not as an invitation to parse
 * Markdown-looking task, math, link, or footnote syntax. This is a small
 * lexical scanner rather than a tag regex so quoted `>` characters, nested
 * elements, comments, and malformed tags remain bounded and source-visible.
 */
export function markdownHtmlRanges(
  source: string,
  codeRanges: readonly MarkdownSourceRange[] = markdownCodeRanges(source),
  stats?: MarkdownHtmlRangeScanStats,
): MarkdownSourceRange[] {
  const ranges: MarkdownSourceRange[] = [];
  const openTags: { name: string; from: number }[] = [];
  const openTagsByName = new Map<string, { name: string; from: number }[]>();
  const countStep = (): void => {
    if (stats) stats.steps += 1;
  };
  if (stats) {
    stats.steps = 0;
    stats.maxOpenTags = 0;
  }
  let codeIndex = 0;
  const insideCode = (position: number): boolean => {
    while (codeIndex < codeRanges.length && position >= (codeRanges[codeIndex]?.to ?? 0)) {
      codeIndex += 1;
    }
    const range = codeRanges[codeIndex];
    return Boolean(range && range.from <= position && position < range.to);
  };

  for (let index = 0; index < source.length; ) {
    countStep();
    if (insideCode(index)) {
      index = codeRanges[codeIndex]?.to ?? source.length;
      continue;
    }
    if (source[index] !== "<") {
      index += 1;
      continue;
    }
    const tag = scanHtmlTag(source, index);
    if (!tag) {
      index += 1;
      continue;
    }
    if (!tag.complete) {
      if (openTags.length === 0) ranges.push({ from: index, to: source.length });
      break;
    }
    if (tag.kind === "standalone") {
      if (openTags.length === 0) ranges.push({ from: index, to: tag.end });
      index = tag.end;
      continue;
    }
    const name = tag.name;
    if (!name) {
      index = tag.end;
      continue;
    }
    if (tag.kind === "opening") {
      if (tag.selfClosing || htmlVoidElements.has(name)) {
        if (openTags.length === 0) ranges.push({ from: index, to: tag.end });
      } else {
        const open = { name, from: index };
        openTags.push(open);
        const sameName = openTagsByName.get(name) ?? [];
        sameName.push(open);
        openTagsByName.set(name, sameName);
        if (stats) stats.maxOpenTags = Math.max(stats.maxOpenTags, openTags.length);
      }
      index = tag.end;
      continue;
    }
    const sameName = openTagsByName.get(name);
    const matching = sameName?.[sameName.length - 1];
    if (!matching) {
      if (openTags.length === 0) ranges.push({ from: index, to: tag.end });
    } else {
      while (openTags.length > 0) {
        const open = openTags.pop();
        if (!open) break;
        countStep();
        const nameStack = openTagsByName.get(open.name);
        if (nameStack) {
          nameStack.pop();
          if (nameStack.length === 0) openTagsByName.delete(open.name);
        }
        if (open === matching) break;
      }
      if (openTags.length === 0) {
        ranges.push({ from: matching.from, to: tag.end });
      }
    }
    index = tag.end;
  }
  const firstOpen = openTags[0];
  if (firstOpen) {
    ranges.push({ from: firstOpen.from, to: source.length });
  }
  return mergeMarkdownRanges(ranges);
}

export function joinSourceLines(source: string, lines: readonly string[]): string {
  const originalLines = sourceLinesWithEndings(source);
  const bytes = (ending: SourceLine["ending"]): string =>
    ending === "crlf" ? "\r\n" : ending === "cr" ? "\r" : ending === "lf" ? "\n" : "";
  return lines
    .map(
      (line, index) =>
        `${line}${bytes(originalLines[index]?.ending ?? (index < lines.length - 1 ? "lf" : ""))}`,
    )
    .join("");
}

export interface FrontmatterScan {
  status: "none" | "resolved" | "unresolved";
  openingLine: number | null;
  closingLine: number | null;
}

export function scanFrontmatter(source: string): FrontmatterScan {
  const firstBreak = source.search(/[\r\n]/u);
  const first = source
    .slice(0, firstBreak < 0 ? source.length : firstBreak)
    .replace(/^\uFEFF/u, "")
    .trim();
  if (first !== "---") {
    return { status: "none", openingLine: null, closingLine: null };
  }
  let lineNumber = 1;
  let offset = firstBreak < 0 ? source.length : firstBreak;
  if (source[offset] === "\r" && source[offset + 1] === "\n") offset += 2;
  else if (offset < source.length) offset += 1;
  while (lineNumber < maxFrontmatterScanLines && offset <= source.length) {
    const breakOffset = source.slice(offset).search(/[\r\n]/u);
    const lineEnd = breakOffset < 0 ? source.length : offset + breakOffset;
    const line = source.slice(offset, lineEnd).trim();
    if (line === "---" || line === "...") {
      return { status: "resolved", openingLine: 1, closingLine: lineNumber + 1 };
    }
    if (breakOffset < 0) break;
    offset = lineEnd + 1;
    if (source[lineEnd] === "\r" && source[lineEnd + 1] === "\n") offset += 1;
    lineNumber += 1;
  }
  return { status: "unresolved", openingLine: 1, closingLine: null };
}

interface CandidateFootnote extends FootnoteDefinition {
  endLine: number;
}

const footnoteDefinitionPattern = /^ {0,3}\[\^([^\]\r\n]+)\]:[ \t]*(.*?)(?:\r)?$/u;
const footnoteContinuationPattern = /^(?: {4}|\t)(.*?)(?:\r)?$/u;
const footnoteMarkerPattern = /^ {0,3}\[\^/u;

function looksLikeFootnoteDefinition(line: string): boolean {
  return footnoteMarkerPattern.test(line);
}

function isIndentedFootnoteLine(line: string): boolean {
  return /^(?:[ \t]+|\s*$)/u.test(line);
}

function markFootnoteSourceLines(
  lines: readonly string[],
  start: number,
  end: number,
  sourceLines: Set<number>,
): void {
  for (let lineNumber = start; lineNumber <= end && lineNumber < lines.length; lineNumber += 1) {
    sourceLines.add(lineNumber + 1);
  }
}

/**
 * Mask source-looking footnote definitions before any renderer extension sees
 * them.  Valid definitions still become semantic footnotes; malformed or
 * ambiguous definitions remain ordinary source, but their continuation lines
 * are marked source-only so math/embed decoration cannot leak into them.
 */
function collectFootnoteSourceLines(
  lines: readonly string[],
  candidates: CandidateFootnote[],
  markerIndexes: ReadonlySet<number>,
  sourceLines: Set<number>,
): void {
  const candidatesByStart = new Map(
    candidates.map((candidate) => [candidate.sourceLine - 1, candidate]),
  );
  for (const index of markerIndexes) {
    const line = lines[index] ?? "";
    if (!looksLikeFootnoteDefinition(line)) {
      continue;
    }
    const candidate = candidatesByStart.get(index);
    const end = candidate?.endLine ?? index;
    markFootnoteSourceLines(lines, index, end, sourceLines);
    let continuation = end + 1;
    while (continuation < lines.length) {
      const next = lines[continuation] ?? "";
      const nextIsContinuation = isIndentedFootnoteLine(next);
      if (!nextIsContinuation) {
        break;
      }
      // A blank line belongs to this source-only range only when it leads to
      // an indented continuation.  Otherwise it terminates the definition.
      if (next.trim() === "") {
        const following = lines[continuation + 1] ?? "";
        if (!isIndentedFootnoteLine(following) || following.trim() === "") {
          break;
        }
      }
      sourceLines.add(continuation + 1);
      continuation += 1;
    }
  }
}

/**
 * Extract standard Markdown footnote definitions while retaining line count
 * and line offsets in the temporary body passed to Markdown-it.
 */
export function collectFootnotes(source: string): FootnoteCollection {
  const frontmatter = scanFrontmatter(source);
  if (frontmatter.status === "unresolved") {
    return {
      body: source,
      definitions: [],
      ids: new Set(),
      // The renderer has a separate unresolved-frontmatter fast path.  Do
      // not allocate one source-line entry per unbounded input line here.
      definitionLines: new Set(),
    };
  }
  const lines = splitSourceLines(source);
  const lineOffsets = sourceLineStarts(source);
  // HTML protection is a separate lexical pass in the renderers.  Reuse its
  // source ranges here so a definition inside a multiline element cannot
  // become a semantic footnote before that pass masks the element.  Resolved
  // frontmatter is blanked for this auxiliary scan: an HTML-looking value in
  // frontmatter must not make an unclosed tag swallow later Markdown.
  const htmlScanSource =
    frontmatter.status === "resolved" && frontmatter.closingLine
      ? `${source
          .slice(0, lineOffsets[frontmatter.closingLine - 1] ?? 0)
          .replace(/[^\r\n]/g, " ")}${source.slice(
          (lineOffsets[frontmatter.closingLine - 1] ?? 0) +
            (lines[frontmatter.closingLine - 1]?.length ?? 0),
        )}`
      : source;
  const htmlRanges = markdownHtmlRanges(htmlScanSource);
  let htmlRangeIndex = 0;
  const isInsideHtml = (position: number): boolean => {
    while (
      htmlRangeIndex < htmlRanges.length &&
      position >= (htmlRanges[htmlRangeIndex]?.to ?? 0)
    ) {
      htmlRangeIndex += 1;
    }
    const range = htmlRanges[htmlRangeIndex];
    return Boolean(range && range.from <= position && position < range.to);
  };
  const candidates: CandidateFootnote[] = [];
  const definitionLines = new Set<number>();
  const markerIndexes = new Set<number>();
  let fence: MarkdownFence | null = null;
  let inFrontmatter = false;

  for (let index = 0; index < lines.length; index += 1) {
    const originalLine = lines[index] ?? "";
    const line = originalLine.replace(/\r$/u, "");
    const trimmed = line.trim();
    if (index === 0 && /^\uFEFF?---$/u.test(trimmed)) {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (trimmed === "---" || trimmed === "...") {
        inFrontmatter = false;
      }
      continue;
    }
    if (fence) {
      if (closesFence(line, fence)) {
        fence = null;
      }
      continue;
    }
    const nextFence = openingFence(line);
    if (nextFence) {
      fence = nextFence;
      continue;
    }
    if (looksLikeFootnoteDefinition(originalLine)) {
      markerIndexes.add(index);
    }
    const match = footnoteDefinitionPattern.exec(originalLine);
    if (!match?.[1] || /\s/u.test(match[1])) {
      continue;
    }
    if (isInsideHtml(lineOffsets[index] ?? 0)) {
      continue;
    }
    const id = match[1];
    const contentLines = [match[2] ?? ""];
    let endLine = index;
    let continuation = index + 1;
    while (continuation < lines.length) {
      const next = lines[continuation] ?? "";
      const continued = footnoteContinuationPattern.exec(next);
      if (continued) {
        contentLines.push(continued[1] ?? "");
        endLine = continuation;
        continuation += 1;
        continue;
      }
      if (
        next.trim() === "" &&
        continuation + 1 < lines.length &&
        footnoteContinuationPattern.test(lines[continuation + 1] ?? "")
      ) {
        contentLines.push("");
        endLine = continuation;
        continuation += 1;
        continue;
      }
      break;
    }
    candidates.push({
      id,
      sourceLine: index + 1,
      sourceFrom: lineOffsets[index] ?? 0,
      content: contentLines.join("\n").trimEnd(),
      endLine,
    });
    for (let lineNumber = index; lineNumber <= endLine; lineNumber += 1) {
      definitionLines.add(lineNumber + 1);
    }
    index = endLine;
  }

  const duplicateIds = new Set<string>();
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) {
      duplicateIds.add(candidate.id);
    }
    seen.add(candidate.id);
  }
  collectFootnoteSourceLines(lines, candidates, markerIndexes, definitionLines);
  if (duplicateIds.size > 0 || candidates.length === 0) {
    return {
      body: source,
      definitions: [],
      ids: new Set(),
      // Even an ambiguous definition stays source-only.  The renderer must
      // not decorate a continuation while deciding that its target is
      // unsupported.
      definitionLines,
    };
  }

  const masked = [...lines];
  for (const candidate of candidates) {
    for (
      let lineNumber = candidate.sourceLine - 1;
      lineNumber <= candidate.endLine;
      lineNumber += 1
    ) {
      const original = masked[lineNumber] ?? "";
      // Preserve UTF-16 positions: without the Unicode flag each surrogate
      // unit becomes one space, so astral source characters keep their width.
      masked[lineNumber] = original.replace(/[^\r]/g, " ");
    }
  }

  const definitions = candidates.map(({ endLine: _endLine, ...definition }) => definition);
  return {
    body: joinSourceLines(source, masked),
    definitions,
    ids: new Set(definitions.map(({ id }) => id)),
    definitionLines,
  };
}

export interface SafeMathRender {
  html: string;
  text: string;
}

type MathNode =
  | { kind: "text"; value: string }
  | { kind: "sequence"; children: MathNode[] }
  | { kind: "fraction"; numerator: MathNode; denominator: MathNode }
  | { kind: "sqrt"; body: MathNode }
  | { kind: "styled"; style: "text" | "mathrm" | "mathbf" | "mathit"; body: MathNode }
  | { kind: "script"; base: MathNode; sup: MathNode | null; sub: MathNode | null };

const mathSymbols: Readonly<Record<string, string>> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ϵ",
  varepsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  vartheta: "ϑ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  pi: "π",
  varpi: "ϖ",
  rho: "ρ",
  sigma: "σ",
  tau: "τ",
  upsilon: "υ",
  phi: "ϕ",
  varphi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Upsilon: "Υ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
  infty: "∞",
  times: "×",
  cdot: "⋅",
  div: "÷",
  pm: "±",
  mp: "∓",
  le: "≤",
  leq: "≤",
  ge: "≥",
  geq: "≥",
  neq: "≠",
  approx: "≈",
  equiv: "≡",
  ne: "≠",
  to: "→",
  rightarrow: "→",
  leftarrow: "←",
  mapsto: "↦",
  sum: "∑",
  prod: "∏",
  int: "∫",
  partial: "∂",
  nabla: "∇",
  forall: "∀",
  exists: "∃",
  in: "∈",
  notin: "∉",
  subset: "⊂",
  subseteq: "⊆",
  supset: "⊃",
  supseteq: "⊇",
  emptyset: "∅",
  cdots: "⋯",
  ldots: "…",
};

const mathStyleCommands = new Set(["text", "mathrm", "mathbf", "mathit"] as const);
const mathDelimiters = new Set(["(", ")", "[", "]", "{", "}", "|", "<", ">", "."]);

/**
 * These are deliberately conservative limits for the small offline math
 * grammar.  They bound both parser work and the HTML produced by a hostile
 * note while leaving ordinary inline and display expressions untouched.
 */
export const safeMathLimits = {
  maxInputLength: 16_384,
  maxDelimiterScanLength: 64 * 1024,
  maxInlineMathScanLength: 256 * 1024,
  maxInlineMathCandidates: 4_096,
  maxNestingDepth: 128,
  maxNodes: 16_384,
  maxOutputLength: 64 * 1024,
} as const;

function escapeMathText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

class MathParser {
  readonly source: string;
  position = 0;
  private nodeCount = 0;

  constructor(source: string) {
    this.source = source;
  }

  parse(): MathNode | null {
    if (this.source.length > safeMathLimits.maxInputLength) {
      return null;
    }
    const hasControl = [...this.source].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 8 || (code >= 11 && code <= 31) || code === 127;
    });
    if (!this.source.trim() || hasControl) {
      return null;
    }
    const sequence = this.parseSequence(false, 0);
    if (!sequence || this.position !== this.source.length || sequence.children.length === 0) {
      return null;
    }
    return sequence;
  }

  private createNode<T extends MathNode>(node: T): T {
    this.nodeCount += 1;
    if (this.nodeCount > safeMathLimits.maxNodes) {
      throw new Error("math node limit exceeded");
    }
    return node;
  }

  private parseSequence(
    stopAtBrace: boolean,
    depth: number,
  ): { kind: "sequence"; children: MathNode[] } | null {
    if (depth > safeMathLimits.maxNestingDepth) {
      throw new Error("math nesting limit exceeded");
    }
    const children: MathNode[] = [];
    while (this.position < this.source.length) {
      const character = this.source[this.position] ?? "";
      if (character === "}") {
        if (!stopAtBrace) return null;
        this.position += 1;
        return this.createNode({ kind: "sequence", children });
      }
      if (character === "^") {
        this.position += 1;
        const script = this.parseArgument(depth + 1);
        if (!script || children.length === 0) return null;
        const base = children.pop() as MathNode;
        const previous = base.kind === "script" ? base : null;
        children.push(
          this.createNode({
            kind: "script",
            base: previous?.base ?? base,
            sup: script,
            sub: previous?.sub ?? null,
          }),
        );
        continue;
      }
      if (character === "_") {
        this.position += 1;
        const script = this.parseArgument(depth + 1);
        if (!script || children.length === 0) return null;
        const base = children.pop() as MathNode;
        const previous = base.kind === "script" ? base : null;
        children.push(
          this.createNode({
            kind: "script",
            base: previous?.base ?? base,
            sup: previous?.sup ?? null,
            sub: script,
          }),
        );
        continue;
      }
      const atom = this.parseAtom(depth);
      if (!atom) return null;
      children.push(atom);
    }
    return stopAtBrace ? null : this.createNode({ kind: "sequence", children });
  }

  private parseArgument(depth: number): MathNode | null {
    while (this.source[this.position] === " ") this.position += 1;
    if (this.source[this.position] === "{") {
      this.position += 1;
      return this.parseSequence(true, depth + 1);
    }
    return this.parseAtom(depth + 1);
  }

  private parseAtom(depth: number): MathNode | null {
    const character = this.source[this.position] ?? "";
    if (!character || character === "$" || character === "{") {
      return null;
    }
    if (character === "{") {
      this.position += 1;
      return this.parseSequence(true, depth + 1);
    }
    if (character === "\\") {
      this.position += 1;
      const commandStart = this.position;
      while (/\p{L}/u.test(this.source[this.position] ?? "")) this.position += 1;
      const command = this.source.slice(commandStart, this.position);
      if (!command) {
        const escaped = this.source[this.position] ?? "";
        if (!"{}[]()\\|,;:!?+-=*/<>.".includes(escaped)) return null;
        this.position += 1;
        return this.createNode({
          kind: "text",
          value: escaped === "," || escaped === ";" ? " " : escaped,
        });
      }
      const symbol = mathSymbols[command];
      if (symbol) {
        return this.createNode({ kind: "text", value: symbol });
      }
      if (command === "frac") {
        const numerator = this.parseArgument(depth + 1);
        const denominator = this.parseArgument(depth + 1);
        return numerator && denominator
          ? this.createNode({ kind: "fraction", numerator, denominator })
          : null;
      }
      if (command === "sqrt") {
        if (this.source[this.position] === "[") {
          const close = this.source.indexOf("]", this.position + 1);
          if (close < 0) return null;
          this.position = close + 1;
        }
        const body = this.parseArgument(depth + 1);
        return body ? this.createNode({ kind: "sqrt", body }) : null;
      }
      if (
        mathStyleCommands.has(command as typeof mathStyleCommands extends Set<infer T> ? T : never)
      ) {
        const body = this.parseArgument(depth + 1);
        return body
          ? this.createNode({
              kind: "styled",
              style: command as "text" | "mathrm" | "mathbf" | "mathit",
              body,
            })
          : null;
      }
      if (command === "left" || command === "right") {
        const delimiter = this.source[this.position] ?? "";
        if (!mathDelimiters.has(delimiter)) return null;
        this.position += 1;
        return this.createNode({ kind: "text", value: delimiter === "." ? "" : delimiter });
      }
      return null;
    }
    if (character === "~") {
      this.position += 1;
      return this.createNode({ kind: "text", value: " " });
    }
    if (character === "}") return null;
    if (/[\p{L}\p{N}\s.,;:!?+*/=<>|()[\]-]/u.test(character)) {
      this.position += 1;
      return this.createNode({ kind: "text", value: character });
    }
    return null;
  }
}

function renderNode(node: MathNode, depth = 0): SafeMathRender {
  if (depth > safeMathLimits.maxNestingDepth) {
    throw new Error("math render nesting limit exceeded");
  }
  const renderChild = (child: MathNode): SafeMathRender => renderNode(child, depth + 1);
  const finish = (rendered: SafeMathRender): SafeMathRender => {
    if (
      rendered.html.length > safeMathLimits.maxOutputLength ||
      rendered.text.length > safeMathLimits.maxOutputLength
    ) {
      throw new Error("math output limit exceeded");
    }
    return rendered;
  };
  switch (node.kind) {
    case "text":
      return finish({ html: escapeMathText(node.value), text: node.value });
    case "sequence": {
      const rendered = node.children.map(renderChild);
      return finish({
        html: rendered.map(({ html }) => html).join(""),
        text: rendered.map(({ text }) => text).join(""),
      });
    }
    case "fraction": {
      const numerator = renderChild(node.numerator);
      const denominator = renderChild(node.denominator);
      return finish({
        html: `<span class="math-fraction"><span class="math-numerator">${numerator.html}</span><span class="math-denominator">${denominator.html}</span></span>`,
        text: `${numerator.text}/${denominator.text}`,
      });
    }
    case "sqrt": {
      const body = renderChild(node.body);
      return finish({
        html: `<span class="math-sqrt"><span class="math-radical" aria-hidden="true">√</span><span class="math-radicand">${body.html}</span></span>`,
        text: `√${body.text}`,
      });
    }
    case "styled": {
      const body = renderChild(node.body);
      return finish({
        html: `<span class="math-${node.style}">${body.html}</span>`,
        text: body.text,
      });
    }
    case "script": {
      const base = renderChild(node.base);
      const sup = node.sup ? renderChild(node.sup) : null;
      const sub = node.sub ? renderChild(node.sub) : null;
      return finish({
        html: `<span class="math-script">${base.html}${sup ? `<sup>${sup.html}</sup>` : ""}${sub ? `<sub>${sub.html}</sub>` : ""}</span>`,
        text: `${base.text}${sup ? `^${sup.text}` : ""}${sub ? `_${sub.text}` : ""}`,
      });
    }
  }
}

export function renderSafeMath(expression: string): SafeMathRender | null {
  try {
    const ast = new MathParser(expression).parse();
    return ast ? renderNode(ast) : null;
  } catch {
    // A malformed or adversarial expression remains ordinary source in both
    // renderer paths.  Math rendering must never be the reason a note fails
    // to load.
    return null;
  }
}

export type InlineMathDelimiter = "paren" | "dollar";

/**
 * Find one inline math closer in a single forward pass.  Callers must cache
 * an unmatched result or stop scanning after it; repeatedly searching from
 * every opener is the quadratic failure mode this helper is meant to avoid.
 */
export function findInlineMathClose(
  source: string,
  start: number,
  delimiter: InlineMathDelimiter,
): number {
  if (start < 0 || start >= source.length) {
    return -1;
  }
  let backslashRun = 0;
  const from = delimiter === "paren" ? start + 2 : start + 1;
  const scanEnd = Math.min(source.length, from + safeMathLimits.maxDelimiterScanLength);
  for (let index = from; index < scanEnd; index += 1) {
    const character = source[index] ?? "";
    if (character === "\n" || character === "\r") {
      return -1;
    }
    if (character === "\\") {
      backslashRun += 1;
      continue;
    }
    if (delimiter === "paren") {
      if (character === ")" && backslashRun > 0 && backslashRun % 2 === 1) {
        return index - 1;
      }
    } else if (character === "$" && backslashRun % 2 === 0 && source[index + 1] !== "$") {
      return index;
    }
    backslashRun = 0;
  }
  return -1;
}

export interface InlineMathCandidate {
  delimiter: InlineMathDelimiter;
  from: number;
  to: number;
  expression: string;
  rendered: SafeMathRender;
}

export interface InlineMathScan {
  /** Null entries record an opener that was examined but is not renderable. */
  candidates: ReadonlyMap<number, InlineMathCandidate | null>;
  /** Closed candidates that must remain literal source instead of being escaped. */
  rejectedRanges: ReadonlyMap<number, { from: number; to: number }>;
  unmatchedOpeners: ReadonlySet<number>;
  candidateCount: number;
  /** A testable work bound, independent of wall-clock scheduling. */
  steps: number;
  scannedLength: number;
  truncated: boolean;
}

/**
 * Tokenize all inline math candidates in one forward pass.  Markdown-it
 * invokes an inline rule once at every source position, so searching from
 * each opener lets overlapping malformed candidates rescan the same closer.
 * This scanner records both accepted and rejected openers and advances past
 * each examined candidate.  A rejected candidate is therefore O(1) for the
 * inline rule, while the total delimiter work remains linear in the source.
 */
export function scanInlineMath(
  source: string,
  candidateLimit: number = safeMathLimits.maxInlineMathCandidates,
): InlineMathScan {
  const candidates = new Map<number, InlineMathCandidate | null>();
  const rejectedRanges = new Map<number, { from: number; to: number }>();
  const unmatchedOpeners = new Set<number>();
  const scanLimit = Math.min(source.length, safeMathLimits.maxInlineMathScanLength);
  const boundedCandidateLimit = Number.isFinite(candidateLimit)
    ? Math.max(0, Math.min(Math.floor(candidateLimit), safeMathLimits.maxInlineMathCandidates))
    : safeMathLimits.maxInlineMathCandidates;
  let index = 0;
  let steps = 0;
  let candidateCount = 0;
  let truncated = source.length > scanLimit;
  let slashRun = 0;
  let scannedLength = 0;

  const findClose = (from: number, delimiter: InlineMathDelimiter): number => {
    let backslashRun = 0;
    const closeLimit = Math.min(scanLimit, from + safeMathLimits.maxDelimiterScanLength);
    for (let cursor = from; cursor < closeLimit; cursor += 1) {
      steps += 1;
      scannedLength = Math.max(scannedLength, cursor + 1);
      const character = source[cursor] ?? "";
      if (character === "\n" || character === "\r") {
        return -1;
      }
      if (character === "\\") {
        backslashRun += 1;
        continue;
      }
      if (delimiter === "paren") {
        if (character === ")" && backslashRun % 2 === 1) {
          return cursor - 1;
        }
      } else if (character === "$" && backslashRun % 2 === 0 && source[cursor + 1] !== "$") {
        return cursor;
      }
      backslashRun = 0;
    }
    return -1;
  };

  while (index < scanLimit) {
    steps += 1;
    scannedLength = Math.max(scannedLength, index + 1);
    const character = source[index] ?? "";
    if (character === "\\") {
      const parenOpen = source[index + 1] === "(" && slashRun % 2 === 0;
      if (!parenOpen) {
        slashRun += 1;
        index += 1;
        continue;
      }
      if (candidateCount >= boundedCandidateLimit) {
        candidates.set(index, null);
        truncated = true;
        break;
      }
      candidateCount += 1;
      const close = findClose(index + 2, "paren");
      if (close < 0) {
        candidates.set(index, null);
        unmatchedOpeners.add(index);
        // No later opener can be examined safely without rescanning this
        // unmatched suffix.  The source remains ordinary Markdown.
        truncated = true;
        break;
      }
      const expression = source.slice(index + 2, close);
      const rendered = expression.includes("\n") ? null : renderSafeMath(expression);
      if (!rendered) {
        rejectedRanges.set(index, { from: index, to: close + 2 });
      }
      candidates.set(
        index,
        rendered
          ? {
              delimiter: "paren",
              from: index,
              to: close + 2,
              expression,
              rendered,
            }
          : null,
      );
      index = close + 2;
      slashRun = 0;
      continue;
    }
    if (character === "$" && source[index + 1] !== "$" && slashRun % 2 === 0) {
      if (candidateCount >= boundedCandidateLimit) {
        candidates.set(index, null);
        truncated = true;
        break;
      }
      candidateCount += 1;
      const close = findClose(index + 1, "dollar");
      if (close < 0) {
        candidates.set(index, null);
        unmatchedOpeners.add(index);
        truncated = true;
        break;
      }
      const expression = source.slice(index + 1, close);
      const rendered =
        expression.length > 0 && !expression.startsWith(" ") && !expression.endsWith(" ")
          ? renderSafeMath(expression)
          : null;
      if (!rendered) {
        rejectedRanges.set(index, { from: index, to: close + 1 });
      }
      candidates.set(
        index,
        rendered
          ? {
              delimiter: "dollar",
              from: index,
              to: close + 1,
              expression,
              rendered,
            }
          : null,
      );
      index = close + 1;
      slashRun = 0;
      continue;
    }
    slashRun = 0;
    index += 1;
  }

  return {
    candidates,
    rejectedRanges,
    unmatchedOpeners,
    candidateCount,
    steps,
    scannedLength: Math.min(scannedLength, scanLimit),
    truncated,
  };
}

export function createSafeMathElement(
  document: Document,
  expression: string,
  display: boolean,
): HTMLElement | null {
  const rendered = renderSafeMath(expression);
  if (!rendered) return null;
  const element = document.createElement(display ? "div" : "span");
  element.className = display ? "tl-live-math-block" : "tl-live-math";
  element.setAttribute("role", "math");
  element.setAttribute("aria-label", rendered.text);
  // `rendered.html` is constructed solely from escaped text and fixed tags
  // above.  No source HTML or URL reaches this assignment.
  element.innerHTML = rendered.html;
  return element;
}

export function isFootnoteDefinitionLine(line: string): boolean {
  return footnoteDefinitionPattern.test(line);
}
