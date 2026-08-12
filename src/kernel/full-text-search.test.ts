import { describe, expect, it } from "vitest";
import {
  type FullTextSearchDocument,
  FullTextSearchIndex,
  maxSearchQueryLength,
  maxSearchResults,
  maxSearchTerms,
} from "./full-text-search";

function document(
  path: string,
  content: string,
  options: Partial<Pick<FullTextSearchDocument, "headings" | "tags" | "properties">> = {},
): FullTextSearchDocument {
  return {
    path,
    content,
    headings: options.headings ?? [],
    tags: options.tags ?? [],
    properties: options.properties ?? {},
  };
}

describe("FullTextSearchIndex", () => {
  it("uses AND terms, quoted phrases, Unicode normalization, and case-insensitive matching", () => {
    const index = new FullTextSearchIndex();
    index.replace([
      document("Research/Café Notes.md", "# Café Notes\nAlpha beta lives here."),
      document("Research/Other.md", "Alpha only."),
    ]);

    expect(index.search("ALPHA beta").results.map((result) => result.path)).toEqual([
      "Research/Café Notes.md",
    ]);
    expect(index.search('"alpha beta"').results[0]).toMatchObject({
      path: "Research/Café Notes.md",
      contexts: [{ kind: "content", line: 2, text: "Alpha beta lives here." }],
    });
    expect(index.search("Cafe\u0301").results[0]?.path).toBe("Research/Café Notes.md");
  });

  it("searches path, headings, tags, properties, fenced code, and ordinary body text", () => {
    const index = new FullTextSearchIndex();
    index.upsert(
      document(
        "Projects/Launch Plan.md",
        [
          "---",
          "status: waiting-review",
          "---",
          "# Release checklist",
          "```ts",
          "const hiddenNeedle = true;",
          "```",
          "ordinary paragraph",
        ].join("\n"),
        {
          headings: [{ text: "Release checklist", line: 4 }],
          tags: ["ship-it"],
          properties: { status: "waiting-review" },
        },
      ),
    );

    for (const query of [
      "launch",
      "release",
      "ship-it",
      "waiting-review",
      "hiddenNeedle",
      "ordinary paragraph",
    ]) {
      expect(index.search(query).results[0]?.path).toBe("Projects/Launch Plan.md");
    }
    expect(index.search("hiddenNeedle").results[0]?.contexts[0]).toMatchObject({
      kind: "content",
      line: 6,
    });
  });

  it("ranks exact titles ahead of metadata and body-only matches with stable path ties", () => {
    const index = new FullTextSearchIndex();
    index.replace([
      document("Zeta/Tagged.md", "No title match here.", { tags: ["orbit"] }),
      document("Orbit.md", "A body without the query outside its title."),
      document("Alpha/Body.md", "orbit appears only in body"),
      document("Beta/Body.md", "orbit appears only in body"),
    ]);

    const results = index.search("orbit").results;
    expect(results.map((result) => result.path)).toEqual([
      "Orbit.md",
      "Zeta/Tagged.md",
      "Alpha/Body.md",
      "Beta/Body.md",
    ]);
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
    expect(results[2]?.score).toBe(results[3]?.score);
  });

  it("returns bounded contextual lines and reports truncation without losing the total", () => {
    const index = new FullTextSearchIndex();
    index.replace(
      Array.from({ length: 8 }, (_, item) =>
        document(
          `Notes/${String(item).padStart(2, "0")}.md`,
          `first needle line\nsecond needle line\nthird needle line\nfourth needle line`,
        ),
      ),
    );

    const page = index.search("needle", 3);
    expect(page).toMatchObject({ total: 8, truncated: true });
    expect(page.results).toHaveLength(3);
    expect(page.results[0]?.contexts).toHaveLength(3);
    expect(page.results[0]?.matchCount).toBeGreaterThanOrEqual(4);
  });

  it("supports deterministic folder scopes, case-sensitive matching, and context limits", () => {
    const index = new FullTextSearchIndex();
    index.replace([
      document("Research/Case.md", "Needle first\nneedle second\nNeedle third"),
      document("Archive/Case.md", "Needle archived"),
    ]);

    expect(index.search("Needle", 50, { caseSensitive: true, folder: "Research" })).toMatchObject({
      total: 1,
      results: [{ path: "Research/Case.md", matchCount: 2 }],
    });
    expect(index.search("NEEDLE", 50, { caseSensitive: true }).total).toBe(0);
    expect(index.search("needle", 50, { folder: "Archive" }).results).toMatchObject([
      { path: "Archive/Case.md" },
    ]);
    expect(index.search("needle", 50, { maxContexts: 1 }).results[0]?.contexts).toHaveLength(1);
    expect(() => index.search("needle", 50, { maxContexts: 101 })).toThrow("between 1 and 100");

    const longLineIndex = new FullTextSearchIndex();
    longLineIndex.upsert(document("Long.md", `${"lower prefix ".repeat(30)}Needle exact`));
    expect(
      longLineIndex.search("Needle", 50, { caseSensitive: true }).results[0]?.contexts[0]?.text,
    ).toContain("Needle exact");
  });

  it("replaces, updates, and removes documents without retaining stale matches", () => {
    const index = new FullTextSearchIndex();
    index.replace([document("Old.md", "before")]);
    expect(index.search("before").total).toBe(1);

    index.upsert(document("Old.md", "after"));
    expect(index.search("before").total).toBe(0);
    expect(index.search("after").total).toBe(1);

    index.remove("Old.md");
    expect(index.search("after").total).toBe(0);
  });

  it("bounds query and result work while treating an empty query as no search", () => {
    const index = new FullTextSearchIndex();
    index.upsert(document("Note.md", "content"));

    expect(index.search("  ")).toEqual({
      query: "  ",
      terms: [],
      total: 0,
      truncated: false,
      results: [],
    });
    expect(() => index.search("x".repeat(maxSearchQueryLength + 1))).toThrow("at most 256");
    expect(() =>
      index.search(Array.from({ length: maxSearchTerms + 1 }, (_, i) => `t${i}`).join(" ")),
    ).toThrow("at most 12");
    expect(() => index.search("content", maxSearchResults + 1)).toThrow("between 1 and 100");
  });

  it("finds a late matching document in a deterministic 5,000-note scale fixture", () => {
    const index = new FullTextSearchIndex();
    index.replace(
      Array.from({ length: 5_000 }, (_, item) =>
        document(
          `Scale/${String(item).padStart(5, "0")}.md`,
          item === 4_999
            ? "ordinary repeated corpus text with a singular lighthouse-needle"
            : "ordinary repeated corpus text",
        ),
      ),
    );

    expect(index.search("lighthouse-needle").results.map((result) => result.path)).toEqual([
      "Scale/04999.md",
    ]);
  });
});
