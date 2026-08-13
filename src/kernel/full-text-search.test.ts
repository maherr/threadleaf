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
    expect(index.search("cafe").results[0]?.path).toBe("Research/Café Notes.md");
    expect(index.search("café").results[0]?.path).toBe("Research/Café Notes.md");
    expect(index.search('"cafe notes"').results[0]?.path).toBe("Research/Café Notes.md");
    expect(index.search("Cafe", 50, { caseSensitive: true }).results[0]?.path).toBe(
      "Research/Café Notes.md",
    );
    expect(index.search("CAFE", 50, { caseSensitive: true }).total).toBe(0);
  });

  it("matches NFC and NFD source text in either query direction", () => {
    const index = new FullTextSearchIndex();
    const nfdPath = "Research/Cafe\u0301 NFD.md";
    const nfdBody = "The source is Cafe\u0301 in decomposed form.";
    index.upsert(document(nfdPath, nfdBody));

    expect(index.search("café").results[0]?.path).toBe(nfdPath);
    expect(index.search("cafe").results[0]?.path).toBe(nfdPath);
    expect(index.search("cafe").results[0]?.contexts[0]).toEqual({
      kind: "content",
      line: 1,
      text: nfdBody,
    });
  });

  it("folds Latin diacritics across every searchable field without changing contexts", () => {
    const index = new FullTextSearchIndex();
    const source = [
      "---",
      "status: déjà-vu",
      "---",
      "# Café heading",
      "Português ação and Vietnamese ấc in body.",
      "const café = true;",
      "#crème",
    ].join("\n");
    index.upsert(
      document("Français/Café.md", source, {
        headings: [{ text: "Café heading", line: 4 }],
        tags: ["crème"],
        properties: { status: "déjà-vu" },
      }),
    );

    expect(index.search("francais", 50, { maxContexts: 100 }).results[0]?.contexts).toContainEqual({
      kind: "path",
      text: "Français/Café.md",
    });
    expect(index.search("cafe", 50, { maxContexts: 100 }).results[0]?.contexts).toEqual(
      expect.arrayContaining([
        { kind: "content", line: 6, text: "const café = true;" },
        { kind: "heading", line: 4, text: "Café heading" },
        { kind: "path", text: "Français/Café.md" },
      ]),
    );
    expect(index.search("creme").results[0]?.contexts).toContainEqual({
      kind: "tag",
      text: "#crème",
    });
    expect(index.search("deja-vu").results[0]?.contexts).toContainEqual({
      kind: "property",
      text: "status: déjà-vu",
    });
    expect(index.search("portugues").results[0]?.path).toBe("Français/Café.md");
    expect(index.search("acao").results[0]?.path).toBe("Français/Café.md");
    expect(index.search("ac").results[0]?.path).toBe("Français/Café.md");
    expect(index.search("Cafe", 50, { caseSensitive: true }).results[0]?.path).toBe(
      "Français/Café.md",
    );
    expect(index.search('"Cafe heading"', 50, { caseSensitive: true }).total).toBe(1);
    expect(index.search('"cafe heading"', 50, { caseSensitive: true }).total).toBe(0);
    expect(index.search("cafe", 50, { caseSensitive: true }).total).toBe(1);
    expect(index.search("CAFE", 50, { caseSensitive: true }).total).toBe(0);
  });

  it("keeps non-Latin mark-bearing text distinct while retaining exact source context", () => {
    const index = new FullTextSearchIndex();
    const arabic = "عَرَبِيّ";
    const hebrew = "שָׁלוֹם";
    const greekNfd = "ε\u0313\u0301";
    const greekNfc = "ἔ";
    index.upsert(document("Languages.md", `${arabic}\n${hebrew}\n${greekNfd}`));

    expect(index.search("عربي").total).toBe(0);
    expect(index.search(arabic).results[0]?.contexts[0]).toMatchObject({
      kind: "content",
      line: 1,
      text: arabic,
    });
    expect(index.search("שלום").total).toBe(0);
    expect(index.search(hebrew).results[0]?.contexts[0]).toMatchObject({
      kind: "content",
      line: 2,
      text: hebrew,
    });
    expect(index.search(greekNfc).results[0]?.contexts[0]).toMatchObject({
      kind: "content",
      line: 3,
      text: greekNfd,
    });
    expect(index.search("ε").total).toBe(0);
  });

  it("keeps script-specific marks significant in every searchable field and query direction", () => {
    const marks = ["a\u064e", "a\u05b8", "a\u093e"];
    const markedDocuments = marks.map((marked, item) =>
      document(`Fields/${item}.md`, marked, {
        headings: [{ text: marked, line: 1 }],
        tags: [marked],
        properties: { Ω: marked },
      }),
    );
    const index = new FullTextSearchIndex();
    index.replace([...markedDocuments, document("Fields/Δ.md", "a")]);

    for (const [item, marked] of marks.entries()) {
      for (const caseSensitive of [false, true]) {
        const exact = index.search(marked, 50, { caseSensitive, maxContexts: 100 });
        expect(exact.results.map((result) => result.path)).toContain(`Fields/${item}.md`);
        expect(
          index.search("a", 50, { caseSensitive }).results.map((result) => result.path),
        ).not.toContain(`Fields/${item}.md`);
      }
    }

    const plainOnly = new FullTextSearchIndex();
    plainOnly.upsert(
      document("Fields/Δ.md", "a", {
        headings: [{ text: "a", line: 1 }],
        tags: ["a"],
        properties: { Ω: "a" },
      }),
    );
    for (const marked of marks) {
      expect(plainOnly.search(marked).total).toBe(0);
      expect(plainOnly.search(marked, 50, { caseSensitive: true }).total).toBe(0);
    }
  });

  it("anchors long snippets on the first valid grapheme match, not a marked prefix", () => {
    const markedPrefix = `a\u064e${"x".repeat(400)} a`;
    const index = new FullTextSearchIndex();
    index.upsert(document("Red control.md", markedPrefix));

    const result = index.search("a", 50, { maxContexts: 1 }).results[0];
    expect(result?.matchCount).toBe(1);
    expect(result?.contexts[0]).toMatchObject({ kind: "content", line: 1 });
    expect(result?.contexts[0]?.text.endsWith("a")).toBe(true);
    expect(result?.contexts[0]?.text).not.toContain("a\u064e");
  });

  it("does not count text inside Unicode Prepend graphemes", () => {
    const prepends = ["\u0600", "\u0890", String.fromCodePoint(0x110bd)];
    const source = [...prepends.map((prepend) => `${prepend}needle`), "needle"].join("\n");
    const index = new FullTextSearchIndex();
    index.upsert(document("Unicode/Prepend.md", source));

    expect(index.search("needle", 50, { maxContexts: 100 })).toMatchObject({
      total: 1,
      results: [
        {
          path: "Unicode/Prepend.md",
          matchCount: 1,
          contexts: [{ kind: "content", line: 4, text: "needle" }],
        },
      ],
    });
    expect(index.search("\u0600", 50).total).toBe(0);
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

  it("keeps long decomposed snippets exact and grapheme-safe after folded length changes", () => {
    const index = new FullTextSearchIndex();
    const source = `${"prefix 😀 ".repeat(28)}Cafe\u0301 target suffix`;
    index.upsert(document("Long/Café.md", source));

    const context = index.search("cafe", 50, { maxContexts: 1 }).results[0]?.contexts[0];
    expect(context).toMatchObject({ kind: "content", line: 1 });
    expect(context?.text).toContain("Cafe\u0301 target");
    expect(context?.text).not.toContain("�");
    for (let index = 0; index < (context?.text.length ?? 0); index += 1) {
      const codeUnit = context?.text.charCodeAt(index) ?? 0;
      if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        const next = context?.text.charCodeAt(index + 1) ?? 0;
        expect(next).toBeGreaterThanOrEqual(0xdc00);
        expect(next).toBeLessThanOrEqual(0xdfff);
      }
      if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
        const previous = context?.text.charCodeAt(index - 1) ?? 0;
        expect(previous).toBeGreaterThanOrEqual(0xd800);
        expect(previous).toBeLessThanOrEqual(0xdbff);
      }
    }
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
