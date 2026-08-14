import {
  foldSearchText,
  isSimpleSearchText,
  projectSearchText,
  searchTextContains,
  searchTextFindMappedMatch,
  searchTextMatchCount,
  searchTextStartsWith,
  sourceBoundaryAtOrAfter,
  sourceBoundaryAtOrBefore,
} from "../shared/search-text";
import { displayTitleFromVaultPath } from "./note-path";

export const maxSearchQueryLength = 256;
export const maxSearchTerms = 12;
export const maxSearchResults = 100;

export class SearchQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchQueryError";
  }
}

export type FullTextSearchContextKind = "content" | "heading" | "tag" | "property" | "path";

export interface FullTextSearchDocument {
  path: string;
  content: string;
  headings: Array<{ text: string; line: number }>;
  tags: string[];
  properties: Record<string, string | string[]>;
}

export interface FullTextSearchContext {
  kind: FullTextSearchContextKind;
  text: string;
  line?: number;
}

export interface FullTextSearchHit {
  path: string;
  score: number;
  matchCount: number;
  contexts: FullTextSearchContext[];
}

export interface FullTextSearchPage {
  query: string;
  terms: string[];
  total: number;
  truncated: boolean;
  results: FullTextSearchHit[];
}

export interface FullTextSearchOptions {
  caseSensitive?: boolean;
  folder?: string;
  maxContexts?: number;
  /**
   * Return "content" contexts as an exact, unclipped slice of the saved
   * source line instead of a trimmed, length-bounded snippet. Used by the
   * grep-style `search:context` CLI surface, which documents its contexts as
   * "sliced from the exact saved source rather than a folded key" (see
   * docs/cli.md). Ranked "search" results keep the trimmed, anchored
   * snippet for compact display.
   */
  exactContext?: boolean;
}

interface IndexedLine {
  line: number;
  text: string;
  canonical: string;
  normalized: string;
  simple: boolean;
}

interface IndexedHeading extends IndexedLine {
  canonical: string;
  normalized: string;
}

interface IndexedSearchDocument {
  path: string;
  canonicalPath: string;
  normalizedPath: string;
  pathSimple: boolean;
  title: string;
  canonicalTitle: string;
  normalizedTitle: string;
  titleSimple: boolean;
  /**
   * The exact saved source. Per-line index objects are deliberately not
   * retained: one object plus two folded strings for every line of every note
   * was 55 percent of the whole index heap at vault scale (about 3.1 GiB for
   * 31.45 million lines), to describe text this field already holds. Lines are
   * derived from here at query time, for matched documents only.
   */
  content: string;
  /**
   * The one whole-note comparable key kept at rest. The case-preserving
   * companion is derived on demand instead of stored, because for a note that
   * is already NFC it is a V8 alias of `content` and for a note carrying Latin
   * diacritics it is a second full copy.
   */
  normalizedContent: string;
  contentSimple: boolean;
  headings: IndexedHeading[];
  tags: Array<{
    text: string;
    canonical: string;
    normalized: string;
    simple: boolean;
  }>;
  properties: Array<{
    text: string;
    canonical: string;
    normalized: string;
    simple: boolean;
  }>;
}

interface ContextCandidate extends FullTextSearchContext {
  coverage: number;
  occurrences: number;
}

function comparableText(canonical: string, normalized: string, caseSensitive: boolean): string {
  return caseSensitive ? canonical : normalized;
}

function comparableLine(line: IndexedLine, caseSensitive: boolean): string {
  return caseSensitive ? line.canonical : line.normalized;
}

/** The exact string `indexDocument` folds, shared by both whole-note keys. */
function lineFeedContent(content: string): string {
  return content.replaceAll("\r\n", "\n");
}

/**
 * The whole-note comparable key for one query. The case-folded key is stored;
 * the case-preserving key is recomputed here because storing it would either
 * pin the raw note through a V8 alias or duplicate it outright.
 */
function comparableContent(document: IndexedSearchDocument, caseSensitive: boolean): string {
  return caseSensitive
    ? foldSearchText(lineFeedContent(document.content), true)
    : document.normalizedContent;
}

/**
 * Rebuild the per-line index for one document, identical in every field to the
 * shape the index used to hold. Only the returned array's lifetime changed:
 * it is now a query-local temporary for a matched document rather than a
 * permanent structure held for all of them.
 */
function deriveLines(content: string): IndexedLine[] {
  const lines = content.split(/\r?\n/).map((text, index) => ({
    line: index + 1,
    text,
    canonical: foldSearchText(text, true),
    normalized: foldSearchText(text),
    simple: false,
  }));
  for (const line of lines) {
    line.simple = isSimpleSearchText(line.canonical) && isSimpleSearchText(line.normalized);
  }
  return lines;
}

/**
 * True when a single saved line carries every term.
 *
 * This walks the folded whole-note key rather than re-folding each line, which
 * would cost 31 million `foldSearchText` calls on a large vault for one broad
 * query. `foldSearchText` is distributive over "\n" (proved over an
 * adversarial corpus in full-text-search-folding.test.ts), so a newline-bounded
 * slice of the folded key is exactly the folded line the index used to store.
 *
 * `simple` is passed as false rather than recomputed from a single variant: it
 * is a pure fast-path hint, never a semantic one. `searchTextContains` already
 * takes the same plain `indexOf` route whenever the haystack is simple, so
 * both values answer identically, while a `simple` inferred from one variant
 * could read true where the stored flag, which also consulted the other
 * variant, read false.
 */
function anyLineContainsEveryTerm(folded: string, terms: readonly string[]): boolean {
  let start = 0;
  for (;;) {
    const lineBreak = folded.indexOf("\n", start);
    const end = lineBreak === -1 ? folded.length : lineBreak;
    if (terms.every((term) => containsComparable(folded.slice(start, end), term, false))) {
      return true;
    }
    if (lineBreak === -1) {
      return false;
    }
    start = lineBreak + 1;
  }
}

function containsComparable(value: string, term: string, simple: boolean): boolean {
  return simple ? value.includes(term) : searchTextContains(value, term);
}

function startsWithComparable(value: string, term: string, simple: boolean): boolean {
  return simple ? value.startsWith(term) : searchTextStartsWith(value, term);
}

function countComparable(value: string, term: string, simple: boolean): number {
  if (!simple) {
    return searchTextMatchCount(value, term);
  }
  let count = 0;
  let offset = 0;
  while (offset <= value.length - term.length) {
    const found = value.indexOf(term, offset);
    if (found === -1) {
      break;
    }
    count += 1;
    offset = found + Math.max(1, term.length);
  }
  return count;
}

function propertyText(key: string, value: string | string[]): string {
  return `${key}: ${Array.isArray(value) ? value.join(", ") : value}`;
}

function indexDocument(document: FullTextSearchDocument): IndexedSearchDocument {
  const lineFeed = lineFeedContent(document.content);
  const canonicalContent = foldSearchText(lineFeed, true);
  const normalizedContent = foldSearchText(lineFeed);
  const title = displayTitleFromVaultPath(document.path);
  const canonicalPath = foldSearchText(document.path, true);
  const normalizedPath = foldSearchText(document.path);
  const canonicalTitle = foldSearchText(title, true);
  const normalizedTitle = foldSearchText(title);
  const pathSimple = isSimpleSearchText(canonicalPath) && isSimpleSearchText(normalizedPath);
  const titleSimple = isSimpleSearchText(canonicalTitle) && isSimpleSearchText(normalizedTitle);
  const contentSimple =
    isSimpleSearchText(canonicalContent) && isSimpleSearchText(normalizedContent);
  return {
    path: document.path,
    canonicalPath,
    normalizedPath,
    pathSimple,
    title,
    canonicalTitle,
    normalizedTitle,
    titleSimple,
    content: document.content,
    normalizedContent,
    contentSimple,
    headings: document.headings.map((heading) => {
      const canonical = foldSearchText(heading.text, true);
      const normalized = foldSearchText(heading.text);
      return {
        line: heading.line,
        text: heading.text,
        canonical,
        normalized,
        simple: isSimpleSearchText(canonical) && isSimpleSearchText(normalized),
      };
    }),
    tags: document.tags.map((tag) => {
      const canonical = foldSearchText(tag, true);
      const normalized = foldSearchText(tag);
      return {
        text: `#${tag}`,
        canonical,
        normalized,
        simple: isSimpleSearchText(canonical) && isSimpleSearchText(normalized),
      };
    }),
    properties: Object.entries(document.properties).map(([key, value]) => {
      const text = propertyText(key, value);
      const canonical = foldSearchText(text, true);
      const normalized = foldSearchText(text);
      return {
        text,
        canonical,
        normalized,
        simple: isSimpleSearchText(canonical) && isSimpleSearchText(normalized),
      };
    }),
  };
}

function parseTerms(query: string, caseSensitive: boolean): string[] {
  if (query.length > maxSearchQueryLength) {
    throw new SearchQueryError(
      `Search queries may contain at most ${maxSearchQueryLength} characters.`,
    );
  }
  const terms: string[] = [];
  let buffer = "";
  let quoted = false;
  const flush = (): void => {
    const normalized = foldSearchText(buffer.trim(), caseSensitive);
    if (normalized && !terms.includes(normalized)) {
      terms.push(normalized);
    }
    buffer = "";
  };

  for (let index = 0; index < query.length; index += 1) {
    const character = query[index] ?? "";
    if (character === "\\" && query[index + 1] === '"') {
      buffer += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
      if (!quoted) {
        flush();
      }
    } else if (/\s/u.test(character) && !quoted) {
      flush();
    } else {
      buffer += character;
    }
  }
  flush();
  if (terms.length > maxSearchTerms) {
    throw new SearchQueryError(`Search queries may contain at most ${maxSearchTerms} terms.`);
  }
  return terms;
}

function countOccurrences(haystack: string, needle: string, simple: boolean): number {
  return countComparable(haystack, needle, simple);
}

function termCoverage(value: string, terms: string[], simple: boolean): number {
  return terms.reduce((count, term) => count + Number(containsComparable(value, term, simple)), 0);
}

function snippetAround(
  text: string,
  terms: string[],
  caseSensitive: boolean,
  maximumLength = 170,
): string {
  const trimmed = text.trim();
  if (trimmed.length <= maximumLength) {
    return trimmed;
  }
  const projection = projectSearchText(trimmed, caseSensitive);
  const positions = terms
    .map((term) => searchTextFindMappedMatch(projection, term)?.range ?? null)
    .filter((range): range is { start: number; end: number } => range !== null);
  const first = positions.reduce(
    (earliest, range) => Math.min(earliest, range.start),
    Number.MAX_SAFE_INTEGER,
  );
  const firstMatch = first === Number.MAX_SAFE_INTEGER ? 0 : first;
  let start = Math.max(0, firstMatch - Math.floor(maximumLength / 3));
  let end = Math.min(trimmed.length, start + maximumLength);
  start = sourceBoundaryAtOrBefore(projection, start);
  end = sourceBoundaryAtOrAfter(projection, end);
  if (end - start < maximumLength) {
    start = sourceBoundaryAtOrBefore(projection, Math.max(0, end - maximumLength));
  }
  if (start > 0) {
    const nextSpace = trimmed.indexOf(" ", start);
    if (nextSpace !== -1 && nextSpace < firstMatch) {
      start = sourceBoundaryAtOrAfter(projection, nextSpace + 1);
    }
  }
  if (end < trimmed.length) {
    const previousSpace = trimmed.lastIndexOf(" ", end);
    if (previousSpace > start) {
      end = sourceBoundaryAtOrBefore(projection, previousSpace);
    }
  }
  return `${start > 0 ? "…" : ""}${trimmed.slice(start, end)}${end < trimmed.length ? "…" : ""}`;
}

function containsTerm(
  document: IndexedSearchDocument,
  term: string,
  caseSensitive: boolean,
  content: string,
): boolean {
  return (
    containsComparable(
      comparableText(document.canonicalTitle, document.normalizedTitle, caseSensitive),
      term,
      document.titleSimple,
    ) ||
    containsComparable(
      comparableText(document.canonicalPath, document.normalizedPath, caseSensitive),
      term,
      document.pathSimple,
    ) ||
    containsComparable(content, term, document.contentSimple) ||
    document.headings.some((heading) =>
      containsComparable(
        comparableText(heading.canonical, heading.normalized, caseSensitive),
        term,
        heading.simple,
      ),
    ) ||
    document.tags.some((tag) =>
      containsComparable(
        comparableText(tag.canonical, tag.normalized, caseSensitive),
        term,
        tag.simple,
      ),
    ) ||
    document.properties.some((property) =>
      containsComparable(
        comparableText(property.canonical, property.normalized, caseSensitive),
        term,
        property.simple,
      ),
    )
  );
}

function scoreDocument(
  document: IndexedSearchDocument,
  terms: string[],
  caseSensitive: boolean,
  content: string,
): number {
  const title = comparableText(document.canonicalTitle, document.normalizedTitle, caseSensitive);
  const filePath = comparableText(document.canonicalPath, document.normalizedPath, caseSensitive);
  let score = 0;
  for (const term of terms) {
    let strongestField = 0;
    if (title === term) {
      strongestField = 240;
    } else if (startsWithComparable(title, term, document.titleSimple)) {
      strongestField = 180;
    } else if (containsComparable(title, term, document.titleSimple)) {
      strongestField = 140;
    }
    if (
      document.tags.some(
        (tag) => comparableText(tag.canonical, tag.normalized, caseSensitive) === term,
      )
    ) {
      strongestField = Math.max(strongestField, 130);
    } else if (
      document.tags.some((tag) =>
        containsComparable(
          comparableText(tag.canonical, tag.normalized, caseSensitive),
          term,
          tag.simple,
        ),
      )
    ) {
      strongestField = Math.max(strongestField, 90);
    }
    if (
      document.headings.some(
        (heading) => comparableText(heading.canonical, heading.normalized, caseSensitive) === term,
      )
    ) {
      strongestField = Math.max(strongestField, 115);
    } else if (
      document.headings.some((heading) =>
        containsComparable(
          comparableText(heading.canonical, heading.normalized, caseSensitive),
          term,
          heading.simple,
        ),
      )
    ) {
      strongestField = Math.max(strongestField, 80);
    }
    if (containsComparable(filePath, term, document.pathSimple)) {
      strongestField = Math.max(strongestField, 70);
    }
    if (
      document.properties.some((property) =>
        containsComparable(
          comparableText(property.canonical, property.normalized, caseSensitive),
          term,
          property.simple,
        ),
      )
    ) {
      strongestField = Math.max(strongestField, 55);
    }
    const contentCount = countOccurrences(content, term, document.contentSimple);
    if (contentCount > 0) {
      strongestField = Math.max(strongestField, 25);
      score += Math.min(contentCount, 12) * 3;
    }
    score += strongestField;
  }
  if (anyLineContainsEveryTerm(content, terms)) {
    score += 35;
  }
  return score;
}

function contextCandidates(
  document: IndexedSearchDocument,
  terms: string[],
  caseSensitive: boolean,
  exactContext: boolean,
): ContextCandidate[] {
  const candidates: ContextCandidate[] = [];
  for (const line of deriveLines(document.content)) {
    const comparison = comparableLine(line, caseSensitive);
    const coverage = termCoverage(comparison, terms, line.simple);
    if (coverage === 0 || !line.text.trim()) {
      continue;
    }
    candidates.push({
      kind: "content",
      line: line.line,
      text: exactContext ? line.text : snippetAround(line.text, terms, caseSensitive),
      coverage,
      occurrences: terms.reduce(
        (count, term) => count + countOccurrences(comparison, term, line.simple),
        0,
      ),
    });
  }
  for (const heading of document.headings) {
    const coverage = termCoverage(
      comparableText(heading.canonical, heading.normalized, caseSensitive),
      terms,
      heading.simple,
    );
    if (coverage > 0) {
      candidates.push({
        kind: "heading",
        line: heading.line,
        text: heading.text,
        coverage,
        occurrences: coverage,
      });
    }
  }
  for (const tag of document.tags) {
    const coverage = termCoverage(
      comparableText(tag.canonical, tag.normalized, caseSensitive),
      terms,
      tag.simple,
    );
    if (coverage > 0) {
      candidates.push({
        kind: "tag",
        text: tag.text,
        coverage,
        occurrences: coverage,
      });
    }
  }
  for (const property of document.properties) {
    const coverage = termCoverage(
      comparableText(property.canonical, property.normalized, caseSensitive),
      terms,
      property.simple,
    );
    if (coverage > 0) {
      candidates.push({
        kind: "property",
        text: property.text,
        coverage,
        occurrences: coverage,
      });
    }
  }
  const pathCoverage = termCoverage(
    comparableText(document.canonicalPath, document.normalizedPath, caseSensitive),
    terms,
    document.pathSimple,
  );
  if (pathCoverage > 0) {
    candidates.push({
      kind: "path",
      text: document.path,
      coverage: pathCoverage,
      occurrences: pathCoverage,
    });
  }
  return candidates;
}

interface ScoredDocument {
  document: IndexedSearchDocument;
  score: number;
  matchCount: number;
}

/**
 * Match and score one document without touching its lines. Scoring reads the
 * folded whole-note key, which is retained; only the contexts of the results a
 * page actually returns need the source, and those are built later.
 */
function scoreMatch(
  document: IndexedSearchDocument,
  terms: string[],
  caseSensitive: boolean,
): ScoredDocument | null {
  const content = comparableContent(document, caseSensitive);
  if (!terms.every((term) => containsTerm(document, term, caseSensitive, content))) {
    return null;
  }
  return {
    document,
    score: scoreDocument(document, terms, caseSensitive, content),
    matchCount: terms.reduce(
      (count, term) => count + Math.max(1, countOccurrences(content, term, document.contentSimple)),
      0,
    ),
  };
}

/**
 * Build the contexts for one returned result. Contexts were previously built
 * for every matched document and then thrown away for all but the first
 * `limit` of them, so restricting the work to the returned page is a pure
 * saving: a discarded hit's contexts were never observable.
 */
function documentContexts(
  document: IndexedSearchDocument,
  terms: string[],
  caseSensitive: boolean,
  maxContexts: number,
  exactContext: boolean,
): FullTextSearchContext[] {
  const candidates = contextCandidates(document, terms, caseSensitive, exactContext).sort(
    (left, right) =>
      right.coverage - left.coverage ||
      right.occurrences - left.occurrences ||
      (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER) ||
      left.kind.localeCompare(right.kind),
  );
  const contexts: FullTextSearchContext[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const identity = `${candidate.kind}\u0000${candidate.line ?? ""}\u0000${candidate.text}`;
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    contexts.push({
      kind: candidate.kind,
      text: candidate.text,
      ...(candidate.line ? { line: candidate.line } : {}),
    });
    if (contexts.length === maxContexts) {
      break;
    }
  }
  return contexts;
}

export class FullTextSearchIndex {
  readonly #documents = new Map<string, IndexedSearchDocument>();

  replace(documents: Iterable<FullTextSearchDocument>): void {
    const next = new Map<string, IndexedSearchDocument>();
    for (const document of documents) {
      next.set(document.path, indexDocument(document));
    }
    this.#documents.clear();
    for (const [filePath, document] of next) {
      this.#documents.set(filePath, document);
    }
  }

  upsert(document: FullTextSearchDocument): void {
    this.#documents.set(document.path, indexDocument(document));
  }

  remove(filePath: string): void {
    this.#documents.delete(filePath);
  }

  search(query: string, limit = 50, options: FullTextSearchOptions = {}): FullTextSearchPage {
    if (!Number.isInteger(limit) || limit < 1 || limit > maxSearchResults) {
      throw new Error(`Search result limits must be between 1 and ${maxSearchResults}.`);
    }
    const caseSensitive = options.caseSensitive ?? false;
    const maxContexts = options.maxContexts ?? 3;
    if (!Number.isInteger(maxContexts) || maxContexts < 1 || maxContexts > 100) {
      throw new Error("Search context limits must be between 1 and 100.");
    }
    const exactContext = options.exactContext ?? false;
    const terms = parseTerms(query, caseSensitive);
    if (terms.length === 0) {
      return { query, terms, total: 0, truncated: false, results: [] };
    }
    const matches: ScoredDocument[] = [];
    const folderPrefix = options.folder ? `${options.folder.replace(/\/+$/, "")}/` : "";
    for (const document of this.#documents.values()) {
      if (folderPrefix && !document.path.startsWith(folderPrefix)) {
        continue;
      }
      const match = scoreMatch(document, terms, caseSensitive);
      if (match) {
        matches.push(match);
      }
    }
    matches.sort(
      (left, right) =>
        right.score - left.score || left.document.path.localeCompare(right.document.path),
    );
    return {
      query,
      terms,
      total: matches.length,
      truncated: matches.length > limit,
      results: matches.slice(0, limit).map((match) => ({
        path: match.document.path,
        score: match.score,
        matchCount: match.matchCount,
        contexts: documentContexts(match.document, terms, caseSensitive, maxContexts, exactContext),
      })),
    };
  }
}
