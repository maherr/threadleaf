import { describe, expect, it } from "vitest";
import {
  foldSearchText,
  isSimpleSearchText,
  searchTextContains,
  searchTextMatchCount,
  searchTextStartsWith,
} from "../shared/search-text";

/**
 * Two properties the index relies on to stop storing per-line data.
 *
 * 1. Folding distributes over line breaks, so a newline-bounded slice of the
 *    folded whole-note key is exactly the folded line the index used to store.
 *    This is what lets the "every term on one line" scoring bonus be answered
 *    from the retained key instead of re-folding 31 million lines per query.
 *
 * 2. The `simple` flag is a fast-path hint and never a semantic one, so a
 *    derived line may pass `false` without changing an answer. That matters
 *    because the stored flag consulted both folded variants of a line, and a
 *    flag inferred from only one variant could read true where the stored one
 *    read false (a Kelvin sign folds to ASCII "k" while its source is not
 *    ASCII).
 */

const astral = "😀";
const family = "👩‍👩‍👧‍👦";
const flag = "🇨🇦";

const sources: readonly string[] = [
  "",
  "\n",
  "\n\n\n",
  "plain ascii line\nsecond ascii line",
  "trailing newline\n",
  "leading\n\nblank between",
  "crlf first\r\ncrlf second\r\n",
  "lone \r carriage return inside\nnext line",
  "adjacent\r\r\ncarriage pair\nrest",
  "\r\n\r\n",
  "mixed\r\nendings\nand \r lone",
  "Café résumé naïve\nDÉJÀ VU\ncafe resume naive",
  "Café decomposed\nCafé composed",
  "Μια αναφορά στον λόγος\nΛΟΓΟΣ σε κεφαλαία\nλογοσ",
  "Die Straße ist ruhig\nSTRASSE",
  "عَرَبِيّ\nשָׁלוֹם\nἔ",
  "aَ marked\na plain\naָ hebrew mark\naा devanagari",
  `${astral} joy\n${family} family\n${flag} flag`,
  `${astral}\n${astral}${astral}\n`,
  "K kelvin sign line\nk ascii line",
  "İstanbul\nIstanbul\nistanbul\ni̇stanbul",
  "؀needle prepend\n࢐needle prepend\nneedle plain",
  "ﬁ ligature\nfi plain",
  "ǅ titlecase\nǄ upper\nǆ lower",
  "ς final sigma\nσ medial sigma\nΣ capital sigma",
  "  indented  \n\ttabbed\t\n   ",
  "# Heading\n- list item\n> quote\n```ts\ncode();\n```",
  "very long line ".repeat(300) + "\nshort",
  `${"x".repeat(70_000)}\n${"y".repeat(5)}`,
  "​zero width\n nbsp\n﻿bom",
  "😀 surrogate pair split test\nnormal",
];

/** Mirrors `indexDocument`: both whole-note keys fold this string. */
function lineFeed(value: string): string {
  return value.replaceAll("\r\n", "\n");
}

describe("search text folding distributes over line breaks", () => {
  for (const caseSensitive of [false, true]) {
    it(`slices the folded whole-note key into the folded lines (caseSensitive=${caseSensitive})`, () => {
      for (const source of sources) {
        const wholeKey = foldSearchText(lineFeed(source), caseSensitive);
        const fromKey = wholeKey.split("\n");
        const fromLines = source.split(/\r?\n/).map((line) => foldSearchText(line, caseSensitive));
        expect(fromKey, `line count for ${JSON.stringify(source.slice(0, 40))}`).toHaveLength(
          fromLines.length,
        );
        for (const [index, expected] of fromLines.entries()) {
          expect(
            fromKey[index],
            `line ${index + 1} of ${JSON.stringify(source.slice(0, 40))}`,
          ).toBe(expected);
        }
      }
    });
  }

  it("holds for every document in the golden corpus shape", () => {
    // A guard against the property being proved only on hand-written strings:
    // concatenating the whole corpus exercises boundaries between documents of
    // different scripts, which is where a whole-string branch in
    // `foldSearchText` could disagree with a per-line one.
    const combined = sources.join("\n");
    for (const caseSensitive of [false, true]) {
      expect(foldSearchText(lineFeed(combined), caseSensitive).split("\n")).toEqual(
        combined.split(/\r?\n/).map((line) => foldSearchText(line, caseSensitive)),
      );
    }
  });
});

describe("the simple fast path never changes an answer", () => {
  const needles = [
    "a",
    "k",
    "K",
    "cafe",
    "café",
    "needle",
    "line",
    "σ",
    astral,
    family,
    "aَ",
    "\r",
    "  ",
    "İ",
    "ß",
  ];

  function manualCount(haystack: string, needle: string): number {
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

  it("agrees with the grapheme-aware matcher for every simple haystack", () => {
    let simpleHaystacks = 0;
    for (const source of sources) {
      for (const caseSensitive of [false, true]) {
        for (const line of foldSearchText(lineFeed(source), caseSensitive).split("\n")) {
          if (!isSimpleSearchText(line)) {
            continue;
          }
          simpleHaystacks += 1;
          for (const needle of needles) {
            if (!needle) {
              continue;
            }
            expect(line.includes(needle), `includes ${JSON.stringify(needle)}`).toBe(
              searchTextContains(line, needle),
            );
            expect(line.startsWith(needle), `startsWith ${JSON.stringify(needle)}`).toBe(
              searchTextStartsWith(line, needle),
            );
            expect(manualCount(line, needle), `count ${JSON.stringify(needle)}`).toBe(
              searchTextMatchCount(line, needle),
            );
          }
        }
      }
    }
    // Positive control: the assertions above are vacuous if nothing is simple.
    expect(simpleHaystacks).toBeGreaterThan(50);
  });
});
