import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type FullTextSearchDocument,
  FullTextSearchIndex,
  type FullTextSearchOptions,
  type FullTextSearchPage,
} from "./full-text-search";

/**
 * Behavioural lock for the full-text search engine.
 *
 * The index stores derived projections rather than the shapes it once held, so
 * a refactor that changes *how* a document is retained must still produce the
 * same page for every query: identical `terms`, `total`, `truncated`, result
 * order, scores, match counts, and every context kind, line, and snippet
 * character. This suite pins that whole surface to a checked-in fixture that
 * was captured from the pre-refactor engine, which is the only artefact that
 * can tell a storage change apart from a behaviour change.
 *
 * Regenerate deliberately, never to make a red test green:
 *   THREADLEAF_SEARCH_GOLDEN_UPDATE=1 pnpm vitest run src/kernel/full-text-search-golden.test.ts
 */

const goldenUrl = new URL(
  "../../fixtures/search-golden/full-text-search-golden.json",
  import.meta.url,
);
const goldenPath = fileURLToPath(goldenUrl);
const updateGolden = process.env.THREADLEAF_SEARCH_GOLDEN_UPDATE === "1";

function note(
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

const astral = "😀";
const familyEmoji = "👩‍👩‍👧‍👦";
const flag = "🇨🇦";
const arabic = "عَرَبِيّ";
const hebrew = "שָׁלוֹם";
const greekNfd = "ἔ";
const kelvin = "K"; // KELVIN SIGN: non-ASCII canonical, folds to ASCII "k"
const longLine = `${"padding word ".repeat(20)}needle exact suffix`;
const decomposedLong = `${`prefix ${astral} `.repeat(28)}Café target suffix`;

/**
 * A deliberately adversarial corpus. Every document exists to make one storage
 * assumption observable: line endings that are not "\n", lines whose folded
 * form differs in length from the source, graphemes that must not be split,
 * a folded key that becomes ASCII while its source is not, matches that live
 * only in a heading/tag/property/path, and long lines that must be clipped
 * around the first valid match.
 */
const corpus: readonly FullTextSearchDocument[] = [
  note("Research/Café Notes.md", "# Café Notes\nAlpha beta lives here.\nalpha only below."),
  note("Research/Other.md", "Alpha only."),
  note("Research/Café NFD.md", "The source is Café in decomposed form."),
  note(
    "Français/Café.md",
    [
      "---",
      "status: déjà-vu",
      "---",
      "# Café heading",
      "Português ação and Vietnamese ấc in body.",
      "const café = true;",
      "#crème",
    ].join("\n"),
    {
      headings: [{ text: "Café heading", line: 4 }],
      tags: ["crème"],
      properties: { status: "déjà-vu" },
    },
  ),
  note("Greek/Logos.md", "Μια αναφορά στον λόγος και τη λογική.\nΛΟΓΟΣ σε κεφαλαία."),
  note("German/Weather Note.md", "Die Straße ist ruhig heute Abend."),
  note("Languages.md", `${arabic}\n${hebrew}\n${greekNfd}`),
  note("Marks/Fatha.md", "aَ", {
    headings: [{ text: "aَ", line: 1 }],
    tags: ["aَ"],
    properties: { Ω: "aَ" },
  }),
  note("Marks/Plain.md", "a"),
  note("Unicode/Prepend.md", ["؀needle", "࢐needle", "needle"].join("\n")),
  note("Unicode/Kelvin.md", `The ${kelvin} sign and a plain k on one line.\nkelvin alone.`),
  note("Unicode/DottedI.md", "İstanbul and Istanbul and istanbul."),
  note("Emoji/Astral.md", `${astral} joy line\n${familyEmoji} family line\n${flag} flag line`),
  note("Endings/Crlf.md", "first crlf line\r\nsecond crlf line\r\nthird crlf line"),
  note("Endings/LoneCr.md", "alpha\rbeta on one source line\ngamma on the next"),
  note("Endings/Mixed.md", "one\r\r\ntwo\nthree"),
  note("Whitespace/Indented.md", "before\n    const needle = true;   \nafter\n\n   \n"),
  note("Long/Line.md", longLine),
  note("Long/Café.md", decomposedLong),
  note("Long/MarkedPrefix.md", `aَ${"x".repeat(400)} a`),
  note(
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
  note("Zeta/Tagged.md", "No title match here.", { tags: ["orbit"] }),
  note("Orbit.md", "A body without the query outside its title."),
  note("Alpha/Body.md", "orbit appears only in body"),
  note("Beta/Body.md", "orbit appears only in body"),
  note("Archive/Case.md", "Needle archived"),
  note("Research/Case.md", "Needle first\nneedle second\nNeedle third"),
  note("Repeats/Duplicate.md", "needle line\nneedle line\nneedle line\nneedle line"),
  note("Repeats/Heading Echo.md", "release checklist", {
    headings: [{ text: "release checklist", line: 1 }],
    tags: ["release checklist"],
    properties: { topic: "release checklist" },
  }),
  note(
    "Multiline/Span.md",
    "the phrase starts here\nand finishes on the following line\nunrelated tail",
  ),
  note("Properties/List.md", "body text", {
    properties: { aliases: ["First Alias", "Second Alias"], stage: "draft" },
  }),
  ...Array.from({ length: 8 }, (_, item) =>
    note(
      `Notes/${String(item).padStart(2, "0")}.md`,
      "first needle line\nsecond needle line\nthird needle line\nfourth needle line",
    ),
  ),
];

interface GoldenCase {
  readonly id: string;
  readonly query: string;
  readonly limit?: number;
  readonly options?: FullTextSearchOptions;
}

/**
 * Query shapes, not query examples: exact title, substring, case folded,
 * accent folded, astral, grapheme-cluster interiors, per-line anchoring,
 * multi-line quoted phrases, folder scope, case sensitivity, exact context,
 * context caps, and pagination truncation.
 */
const cases: readonly GoldenCase[] = [
  { id: "exact-title", query: "orbit" },
  { id: "exact-title-limit-2", query: "orbit", limit: 2 },
  { id: "and-terms", query: "ALPHA beta" },
  { id: "quoted-phrase", query: '"alpha beta"' },
  { id: "quoted-phrase-escaped", query: '"say \\"needle\\""' },
  { id: "substring-partial", query: "ac" },
  { id: "case-folded-upper", query: "NEEDLE" },
  { id: "accent-nfd-query", query: "Café" },
  { id: "accent-stripped-query", query: "cafe" },
  { id: "accent-native-query", query: "café" },
  { id: "greek-final-sigma", query: "λόγος" },
  { id: "greek-medial-sigma", query: "λόγοσ" },
  { id: "greek-upper", query: "ΛΟΓΟΣ" },
  { id: "sharp-s", query: "straße" },
  { id: "sharp-s-expanded", query: "strasse" },
  { id: "arabic-marked", query: arabic },
  { id: "arabic-unmarked", query: "عربي" },
  { id: "hebrew-marked", query: hebrew },
  { id: "greek-nfc-of-nfd-source", query: "ἔ" },
  { id: "mark-bearing-grapheme", query: "aَ" },
  { id: "mark-bearing-base-only", query: "a" },
  { id: "prepend-grapheme", query: "؀" },
  { id: "prepend-needle", query: "needle", options: { maxContexts: 100 } },
  { id: "kelvin-sign", query: kelvin },
  { id: "kelvin-ascii", query: "k" },
  { id: "dotted-capital-i", query: "İstanbul" },
  { id: "dotted-plain-i", query: "istanbul" },
  { id: "astral-emoji", query: astral },
  { id: "astral-zwj-family", query: familyEmoji },
  { id: "astral-flag", query: flag },
  { id: "astral-with-word", query: `${astral} joy` },
  { id: "crlf-line", query: "second crlf" },
  { id: "lone-cr-line", query: "beta on one" },
  { id: "mixed-endings", query: "two" },
  { id: "line-anchored-bonus", query: "needle line" },
  { id: "multi-line-span-quoted", query: '"starts here\nand finishes"' },
  { id: "multi-line-span-terms", query: "starts finishes" },
  { id: "heading-only", query: "checklist" },
  { id: "tag-only", query: "ship-it" },
  { id: "property-only", query: "waiting-review" },
  { id: "property-list-value", query: "Second Alias" },
  { id: "path-only", query: "Français" },
  { id: "fenced-code", query: "hiddenNeedle" },
  { id: "duplicate-lines", query: "needle", options: { maxContexts: 4 } },
  { id: "echoed-across-fields", query: "release checklist", options: { maxContexts: 100 } },
  { id: "long-line-clipped", query: "needle" },
  { id: "long-line-exact", query: "needle", options: { exactContext: true } },
  { id: "long-decomposed-clip", query: "cafe", options: { maxContexts: 1 } },
  { id: "marked-prefix-anchor", query: "a", options: { maxContexts: 1 } },
  { id: "indent-preserved-exact", query: "const needle", options: { exactContext: true } },
  { id: "indent-trimmed-default", query: "const needle" },
  { id: "case-sensitive-lower", query: "needle", options: { caseSensitive: true } },
  { id: "case-sensitive-upper", query: "Needle", options: { caseSensitive: true } },
  { id: "case-sensitive-shout", query: "NEEDLE", options: { caseSensitive: true } },
  { id: "case-sensitive-accent", query: "Cafe", options: { caseSensitive: true } },
  { id: "case-sensitive-accent-native", query: "Café", options: { caseSensitive: true } },
  { id: "case-sensitive-sharp-s", query: "Straße", options: { caseSensitive: true } },
  { id: "case-sensitive-greek", query: "ΛΟΓΟΣ", options: { caseSensitive: true } },
  { id: "case-sensitive-quoted", query: '"Cafe heading"', options: { caseSensitive: true } },
  { id: "case-sensitive-marked", query: "aَ", options: { caseSensitive: true } },
  { id: "case-sensitive-kelvin", query: kelvin, options: { caseSensitive: true } },
  {
    id: "case-sensitive-folder-scope",
    query: "Needle",
    options: { caseSensitive: true, folder: "Research" },
  },
  { id: "folder-scope", query: "needle", options: { folder: "Archive" } },
  { id: "folder-scope-trailing-slash", query: "needle", options: { folder: "Notes/" } },
  { id: "folder-scope-empty", query: "needle", options: { folder: "Nowhere" } },
  { id: "truncated-page", query: "needle", limit: 3 },
  { id: "max-contexts-one", query: "needle", options: { maxContexts: 1 } },
  { id: "max-contexts-hundred", query: "needle", options: { maxContexts: 100 } },
  { id: "twelve-terms", query: "needle line first second third fourth alpha beta orbit cafe a k" },
  { id: "empty-query", query: "  " },
  { id: "no-match", query: "zzzznotpresentzzzz" },
  { id: "whitespace-only-line-skip", query: "before" },
];

function buildIndex(): FullTextSearchIndex {
  const index = new FullTextSearchIndex();
  index.replace(corpus);
  return index;
}

interface CapturedCase {
  readonly id: string;
  readonly query: string;
  readonly limit: number | null;
  readonly options: FullTextSearchOptions;
  readonly page: FullTextSearchPage;
}

interface Golden {
  readonly schemaVersion: 1;
  readonly corpus: { readonly documentCount: number; readonly paths: readonly string[] };
  readonly cases: readonly CapturedCase[];
  readonly mutation: Record<string, FullTextSearchPage>;
}

function capture(): Golden {
  const index = buildIndex();
  const captured = cases.map((entry) => ({
    id: entry.id,
    query: entry.query,
    limit: entry.limit ?? null,
    options: entry.options ?? {},
    page:
      entry.limit === undefined
        ? index.search(entry.query, 50, entry.options ?? {})
        : index.search(entry.query, entry.limit, entry.options ?? {}),
  }));

  // Mutation surface: upsert must not leave a stale projection behind, and
  // remove must not leave a searchable ghost.
  const mutable = new FullTextSearchIndex();
  mutable.replace([note("Mutable/Note.md", "before text\nsecond before line")]);
  const mutation: Record<string, FullTextSearchPage> = {
    "before-upsert": mutable.search("before"),
  };
  mutable.upsert(note("Mutable/Note.md", "after text\nsecond after line"));
  mutation["after-upsert-old-term"] = mutable.search("before");
  mutation["after-upsert-new-term"] = mutable.search("after");
  mutable.remove("Mutable/Note.md");
  mutation["after-remove"] = mutable.search("after");

  return {
    schemaVersion: 1,
    corpus: { documentCount: corpus.length, paths: corpus.map((entry) => entry.path) },
    cases: captured,
    mutation,
  };
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

describe("full-text search golden pages", () => {
  it("reproduces the checked-in page for every pinned query shape", () => {
    const actual = capture();
    if (updateGolden) {
      mkdirSync(dirname(goldenPath), { recursive: true });
      writeFileSync(goldenPath, canonical(actual));
    }
    const expected = JSON.parse(readFileSync(goldenPath, "utf8")) as Golden;

    // Fail per case first: a whole-file diff of ~70 pages is unreadable, and
    // the case id is the fastest route from a red test to the broken shape.
    expect(actual.cases.map((entry) => entry.id)).toEqual(expected.cases.map((entry) => entry.id));
    for (const [index, entry] of actual.cases.entries()) {
      const reference = expected.cases[index];
      expect(
        canonical(entry),
        `golden search case "${entry.id}" changed; regenerate only when the change is intended`,
      ).toBe(canonical(reference));
    }
    expect(canonical(actual.mutation)).toBe(canonical(expected.mutation));
    expect(canonical(actual.corpus)).toBe(canonical(expected.corpus));
    expect(canonical(actual)).toBe(canonical(expected));
  });

  it("covers every context kind and both truncation states", () => {
    const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as Golden;
    const kinds = new Set<string>();
    let truncated = 0;
    let untruncated = 0;
    let matched = 0;
    for (const entry of golden.cases) {
      for (const result of entry.page.results) {
        for (const context of result.contexts) {
          kinds.add(context.kind);
        }
      }
      if (entry.page.total > 0) {
        matched += 1;
      }
      if (entry.page.truncated) {
        truncated += 1;
      } else {
        untruncated += 1;
      }
    }
    expect([...kinds].sort()).toEqual(["content", "heading", "path", "property", "tag"]);
    expect(truncated).toBeGreaterThan(0);
    expect(untruncated).toBeGreaterThan(0);
    // Guards the fixture against silently collapsing to "nothing matches",
    // which would make every assertion above pass for the wrong reason.
    expect(matched).toBeGreaterThan(golden.cases.length / 2);
  });
});
