import { describe, expect, it } from "vitest";
import { type FullTextSearchDocument, FullTextSearchIndex } from "./full-text-search";

const sizes = [16_384, 32_768, 65_536] as const;

function document(content: string): FullTextSearchDocument {
  return {
    path: "Scale/Semantic snippet.md",
    content,
    headings: [],
    tags: [],
    properties: {},
  };
}

/**
 * Fill the requested UTF-16 length with whole grapheme-safe tokens. Every
 * prefix `needle` begins inside a Unicode Prepend grapheme and is therefore
 * not a semantic match. Only the final plain `needle` may anchor the snippet.
 */
function semanticSnippetSource(length: number): string {
  const invalidPrefix = "\u0600needle ";
  const token = "CAFÉ ";
  const suffix = "needle exact suffix";
  const available = length - invalidPrefix.length - suffix.length;
  const repetitions = Math.floor(available / token.length);
  const source = `${invalidPrefix}${token.repeat(repetitions)}${"x".repeat(available % token.length)}${suffix}`;
  expect(source).toHaveLength(length);
  return source;
}

function bestSearchTime(length: number): number {
  const index = new FullTextSearchIndex();
  index.upsert(document(semanticSnippetSource(length)));

  const search = (): number => {
    const started = performance.now();
    const page = index.search("needle", 1, { maxContexts: 1 });
    const elapsed = performance.now() - started;
    expect(page.results[0]?.matchCount).toBe(1);
    expect(page.results[0]?.contexts[0]).toMatchObject({ kind: "content", line: 1 });
    expect(page.results[0]?.contexts[0]?.text.endsWith("needle exact suffix")).toBe(true);
    return elapsed;
  };

  search();
  return Math.min(search(), search(), search());
}

describe("full-text semantic snippet scale", () => {
  it("keeps projection and snippet work near-linear at 16k, 32k, and 64k", () => {
    const at16k = bestSearchTime(sizes[0]);
    const at32k = bestSearchTime(sizes[1]);
    const at64k = bestSearchTime(sizes[2]);

    // The intermediate scale makes a localized regression visible, while the
    // 16k-to-64k ceiling separates expected roughly 4x linear work from a
    // roughly 16x quadratic rescan. Best warmed runs avoid scheduler and GC
    // pauses; the fixed floor leaves room for slower shared CI hosts.
    expect(at32k).toBeLessThan(Math.max(at16k * 6, 50));
    expect(at64k).toBeLessThan(Math.max(at32k * 6, 50));
    expect(at64k).toBeLessThan(Math.max(at16k * 8, 50));
  }, 30_000);
});
