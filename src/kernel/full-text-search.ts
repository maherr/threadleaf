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
}

interface IndexedLine {
  line: number;
  text: string;
  canonical: string;
  normalized: string;
}

interface IndexedHeading extends IndexedLine {}

interface IndexedSearchDocument {
  path: string;
  canonicalPath: string;
  normalizedPath: string;
  title: string;
  canonicalTitle: string;
  normalizedTitle: string;
  lines: IndexedLine[];
  canonicalContent: string;
  normalizedContent: string;
  headings: IndexedHeading[];
  tags: Array<{ text: string; canonical: string; normalized: string }>;
  properties: Array<{ text: string; canonical: string; normalized: string }>;
}

interface ContextCandidate extends FullTextSearchContext {
  coverage: number;
  occurrences: number;
}

function canonicalSearchText(value: string): string {
  return value.normalize("NFC");
}

function normalizeSearchText(value: string): string {
  return canonicalSearchText(value).toLocaleLowerCase("en-US");
}

function comparableText(canonical: string, normalized: string, caseSensitive: boolean): string {
  return caseSensitive ? canonical : normalized;
}

function propertyText(key: string, value: string | string[]): string {
  return `${key}: ${Array.isArray(value) ? value.join(", ") : value}`;
}

function indexDocument(document: FullTextSearchDocument): IndexedSearchDocument {
  const lines = document.content.split(/\r?\n/).map((text, index) => ({
    line: index + 1,
    text,
    canonical: canonicalSearchText(text),
    normalized: normalizeSearchText(text),
  }));
  const title = displayTitleFromVaultPath(document.path);
  return {
    path: document.path,
    canonicalPath: canonicalSearchText(document.path),
    normalizedPath: normalizeSearchText(document.path),
    title,
    canonicalTitle: canonicalSearchText(title),
    normalizedTitle: normalizeSearchText(title),
    lines,
    canonicalContent: lines.map((line) => line.canonical).join("\n"),
    normalizedContent: lines.map((line) => line.normalized).join("\n"),
    headings: document.headings.map((heading) => ({
      line: heading.line,
      text: heading.text,
      canonical: canonicalSearchText(heading.text),
      normalized: normalizeSearchText(heading.text),
    })),
    tags: document.tags.map((tag) => ({
      text: `#${tag}`,
      canonical: canonicalSearchText(tag),
      normalized: normalizeSearchText(tag),
    })),
    properties: Object.entries(document.properties).map(([key, value]) => {
      const text = propertyText(key, value);
      return {
        text,
        canonical: canonicalSearchText(text),
        normalized: normalizeSearchText(text),
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
    const normalized = caseSensitive
      ? canonicalSearchText(buffer.trim())
      : normalizeSearchText(buffer.trim());
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

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= haystack.length - needle.length) {
    const found = haystack.indexOf(needle, offset);
    if (found === -1) {
      break;
    }
    count += 1;
    offset = found + Math.max(1, needle.length);
  }
  return count;
}

function termCoverage(value: string, terms: string[]): number {
  return terms.reduce((count, term) => count + Number(value.includes(term)), 0);
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
  const normalized = caseSensitive ? canonicalSearchText(trimmed) : normalizeSearchText(trimmed);
  const positions = terms.map((term) => normalized.indexOf(term)).filter((index) => index >= 0);
  const first = positions.length > 0 ? Math.min(...positions) : 0;
  let start = Math.max(0, first - Math.floor(maximumLength / 3));
  let end = Math.min(trimmed.length, start + maximumLength);
  if (end - start < maximumLength) {
    start = Math.max(0, end - maximumLength);
  }
  if (start > 0) {
    const nextSpace = trimmed.indexOf(" ", start);
    if (nextSpace !== -1 && nextSpace < first) {
      start = nextSpace + 1;
    }
  }
  if (end < trimmed.length) {
    const previousSpace = trimmed.lastIndexOf(" ", end);
    if (previousSpace > start) {
      end = previousSpace;
    }
  }
  return `${start > 0 ? "…" : ""}${trimmed.slice(start, end)}${end < trimmed.length ? "…" : ""}`;
}

function containsTerm(
  document: IndexedSearchDocument,
  term: string,
  caseSensitive: boolean,
): boolean {
  return (
    comparableText(document.canonicalTitle, document.normalizedTitle, caseSensitive).includes(
      term,
    ) ||
    comparableText(document.canonicalPath, document.normalizedPath, caseSensitive).includes(term) ||
    comparableText(document.canonicalContent, document.normalizedContent, caseSensitive).includes(
      term,
    ) ||
    document.headings.some((heading) =>
      comparableText(heading.canonical, heading.normalized, caseSensitive).includes(term),
    ) ||
    document.tags.some((tag) =>
      comparableText(tag.canonical, tag.normalized, caseSensitive).includes(term),
    ) ||
    document.properties.some((property) =>
      comparableText(property.canonical, property.normalized, caseSensitive).includes(term),
    )
  );
}

function scoreDocument(
  document: IndexedSearchDocument,
  terms: string[],
  caseSensitive: boolean,
): number {
  const title = comparableText(document.canonicalTitle, document.normalizedTitle, caseSensitive);
  const filePath = comparableText(document.canonicalPath, document.normalizedPath, caseSensitive);
  const content = comparableText(
    document.canonicalContent,
    document.normalizedContent,
    caseSensitive,
  );
  let score = 0;
  for (const term of terms) {
    let strongestField = 0;
    if (title === term) {
      strongestField = 240;
    } else if (title.startsWith(term)) {
      strongestField = 180;
    } else if (title.includes(term)) {
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
        comparableText(tag.canonical, tag.normalized, caseSensitive).includes(term),
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
        comparableText(heading.canonical, heading.normalized, caseSensitive).includes(term),
      )
    ) {
      strongestField = Math.max(strongestField, 80);
    }
    if (filePath.includes(term)) {
      strongestField = Math.max(strongestField, 70);
    }
    if (
      document.properties.some((property) =>
        comparableText(property.canonical, property.normalized, caseSensitive).includes(term),
      )
    ) {
      strongestField = Math.max(strongestField, 55);
    }
    const contentCount = countOccurrences(content, term);
    if (contentCount > 0) {
      strongestField = Math.max(strongestField, 25);
      score += Math.min(contentCount, 12) * 3;
    }
    score += strongestField;
  }
  if (
    document.lines.some((line) => {
      const text = comparableText(line.canonical, line.normalized, caseSensitive);
      return terms.every((term) => text.includes(term));
    })
  ) {
    score += 35;
  }
  return score;
}

function contextCandidates(
  document: IndexedSearchDocument,
  terms: string[],
  caseSensitive: boolean,
): ContextCandidate[] {
  const candidates: ContextCandidate[] = [];
  for (const line of document.lines) {
    const comparison = comparableText(line.canonical, line.normalized, caseSensitive);
    const coverage = termCoverage(comparison, terms);
    if (coverage === 0 || !line.text.trim()) {
      continue;
    }
    candidates.push({
      kind: "content",
      line: line.line,
      text: snippetAround(line.text, terms, caseSensitive),
      coverage,
      occurrences: terms.reduce((count, term) => count + countOccurrences(comparison, term), 0),
    });
  }
  for (const heading of document.headings) {
    const coverage = termCoverage(
      comparableText(heading.canonical, heading.normalized, caseSensitive),
      terms,
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

function searchDocument(
  document: IndexedSearchDocument,
  terms: string[],
  caseSensitive: boolean,
  maxContexts: number,
): FullTextSearchHit | null {
  if (!terms.every((term) => containsTerm(document, term, caseSensitive))) {
    return null;
  }
  const candidates = contextCandidates(document, terms, caseSensitive).sort(
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
  return {
    path: document.path,
    score: scoreDocument(document, terms, caseSensitive),
    matchCount: terms.reduce(
      (count, term) =>
        count +
        Math.max(
          1,
          countOccurrences(
            comparableText(document.canonicalContent, document.normalizedContent, caseSensitive),
            term,
          ),
        ),
      0,
    ),
    contexts,
  };
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
    const terms = parseTerms(query, caseSensitive);
    if (terms.length === 0) {
      return { query, terms, total: 0, truncated: false, results: [] };
    }
    const matches: FullTextSearchHit[] = [];
    const folderPrefix = options.folder ? `${options.folder.replace(/\/+$/, "")}/` : "";
    for (const document of this.#documents.values()) {
      if (folderPrefix && !document.path.startsWith(folderPrefix)) {
        continue;
      }
      const match = searchDocument(document, terms, caseSensitive, maxContexts);
      if (match) {
        matches.push(match);
      }
    }
    matches.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
    return {
      query,
      terms,
      total: matches.length,
      truncated: matches.length > limit,
      results: matches.slice(0, limit),
    };
  }
}
