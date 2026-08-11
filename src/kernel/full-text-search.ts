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

interface IndexedLine {
  line: number;
  text: string;
  normalized: string;
}

interface IndexedHeading extends IndexedLine {}

interface IndexedSearchDocument {
  path: string;
  normalizedPath: string;
  title: string;
  normalizedTitle: string;
  lines: IndexedLine[];
  normalizedContent: string;
  headings: IndexedHeading[];
  tags: Array<{ text: string; normalized: string }>;
  properties: Array<{ text: string; normalized: string }>;
}

interface ContextCandidate extends FullTextSearchContext {
  coverage: number;
  occurrences: number;
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function propertyText(key: string, value: string | string[]): string {
  return `${key}: ${Array.isArray(value) ? value.join(", ") : value}`;
}

function indexDocument(document: FullTextSearchDocument): IndexedSearchDocument {
  const lines = document.content.split(/\r?\n/).map((text, index) => ({
    line: index + 1,
    text,
    normalized: normalizeSearchText(text),
  }));
  return {
    path: document.path,
    normalizedPath: normalizeSearchText(document.path),
    title: displayTitleFromVaultPath(document.path),
    normalizedTitle: normalizeSearchText(displayTitleFromVaultPath(document.path)),
    lines,
    normalizedContent: lines.map((line) => line.normalized).join("\n"),
    headings: document.headings.map((heading) => ({
      line: heading.line,
      text: heading.text,
      normalized: normalizeSearchText(heading.text),
    })),
    tags: document.tags.map((tag) => ({ text: `#${tag}`, normalized: normalizeSearchText(tag) })),
    properties: Object.entries(document.properties).map(([key, value]) => {
      const text = propertyText(key, value);
      return { text, normalized: normalizeSearchText(text) };
    }),
  };
}

function parseTerms(query: string): string[] {
  if (query.length > maxSearchQueryLength) {
    throw new SearchQueryError(
      `Search queries may contain at most ${maxSearchQueryLength} characters.`,
    );
  }
  const terms: string[] = [];
  let buffer = "";
  let quoted = false;
  const flush = (): void => {
    const normalized = normalizeSearchText(buffer.trim());
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

function snippetAround(text: string, terms: string[], maximumLength = 170): string {
  const trimmed = text.trim();
  if (trimmed.length <= maximumLength) {
    return trimmed;
  }
  const normalized = normalizeSearchText(trimmed);
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

function containsTerm(document: IndexedSearchDocument, term: string): boolean {
  return (
    document.normalizedTitle.includes(term) ||
    document.normalizedPath.includes(term) ||
    document.normalizedContent.includes(term) ||
    document.headings.some((heading) => heading.normalized.includes(term)) ||
    document.tags.some((tag) => tag.normalized.includes(term)) ||
    document.properties.some((property) => property.normalized.includes(term))
  );
}

function scoreDocument(document: IndexedSearchDocument, terms: string[]): number {
  let score = 0;
  for (const term of terms) {
    let strongestField = 0;
    if (document.normalizedTitle === term) {
      strongestField = 240;
    } else if (document.normalizedTitle.startsWith(term)) {
      strongestField = 180;
    } else if (document.normalizedTitle.includes(term)) {
      strongestField = 140;
    }
    if (document.tags.some((tag) => tag.normalized === term)) {
      strongestField = Math.max(strongestField, 130);
    } else if (document.tags.some((tag) => tag.normalized.includes(term))) {
      strongestField = Math.max(strongestField, 90);
    }
    if (document.headings.some((heading) => heading.normalized === term)) {
      strongestField = Math.max(strongestField, 115);
    } else if (document.headings.some((heading) => heading.normalized.includes(term))) {
      strongestField = Math.max(strongestField, 80);
    }
    if (document.normalizedPath.includes(term)) {
      strongestField = Math.max(strongestField, 70);
    }
    if (document.properties.some((property) => property.normalized.includes(term))) {
      strongestField = Math.max(strongestField, 55);
    }
    const contentCount = countOccurrences(document.normalizedContent, term);
    if (contentCount > 0) {
      strongestField = Math.max(strongestField, 25);
      score += Math.min(contentCount, 12) * 3;
    }
    score += strongestField;
  }
  if (document.lines.some((line) => terms.every((term) => line.normalized.includes(term)))) {
    score += 35;
  }
  return score;
}

function contextCandidates(document: IndexedSearchDocument, terms: string[]): ContextCandidate[] {
  const candidates: ContextCandidate[] = [];
  for (const line of document.lines) {
    const coverage = termCoverage(line.normalized, terms);
    if (coverage === 0 || !line.text.trim()) {
      continue;
    }
    candidates.push({
      kind: "content",
      line: line.line,
      text: snippetAround(line.text, terms),
      coverage,
      occurrences: terms.reduce(
        (count, term) => count + countOccurrences(line.normalized, term),
        0,
      ),
    });
  }
  for (const heading of document.headings) {
    const coverage = termCoverage(heading.normalized, terms);
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
    const coverage = termCoverage(tag.normalized, terms);
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
    const coverage = termCoverage(property.normalized, terms);
    if (coverage > 0) {
      candidates.push({
        kind: "property",
        text: property.text,
        coverage,
        occurrences: coverage,
      });
    }
  }
  const pathCoverage = termCoverage(document.normalizedPath, terms);
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
): FullTextSearchHit | null {
  if (!terms.every((term) => containsTerm(document, term))) {
    return null;
  }
  const candidates = contextCandidates(document, terms).sort(
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
    if (contexts.length === 3) {
      break;
    }
  }
  return {
    path: document.path,
    score: scoreDocument(document, terms),
    matchCount: terms.reduce(
      (count, term) => count + Math.max(1, countOccurrences(document.normalizedContent, term)),
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

  search(query: string, limit = 50): FullTextSearchPage {
    if (!Number.isInteger(limit) || limit < 1 || limit > maxSearchResults) {
      throw new Error(`Search result limits must be between 1 and ${maxSearchResults}.`);
    }
    const terms = parseTerms(query);
    if (terms.length === 0) {
      return { query, terms, total: 0, truncated: false, results: [] };
    }
    const matches: FullTextSearchHit[] = [];
    for (const document of this.#documents.values()) {
      const match = searchDocument(document, terms);
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
