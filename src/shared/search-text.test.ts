import { describe, expect, it } from "vitest";
import {
  foldSearchText,
  mapSearchMatchToSourceRange,
  projectSearchText,
  searchTextContains,
  searchTextFindMatch,
  searchTextMatchCount,
} from "./search-text";

describe("search text projection", () => {
  it("folds Latin diacritics while preserving case mode and non-Latin marks", () => {
    expect(foldSearchText("Café Português français ấ")).toBe("cafe portugues francais a");
    expect(foldSearchText("Café", true)).toBe("Cafe");
    expect(foldSearchText("café", true)).toBe("cafe");
    expect(foldSearchText("a\u1ab0", true)).toBe("a");
    expect(foldSearchText("a\u20dd", true)).toBe("a\u20dd");
    expect(foldSearchText("Straße")).toBe("straße");
    expect(foldSearchText("Straße")).not.toBe(foldSearchText("Strasse"));
    expect(foldSearchText("عَرَبِيّ")).toBe("عَرَبِيّ");
    expect(foldSearchText("عربي")).not.toBe(foldSearchText("عَرَبِيّ"));
    expect(foldSearchText("α\u0301")).toBe(foldSearchText("ά"));
    expect(foldSearchText("ε")).not.toBe(foldSearchText("έ"));
    expect(foldSearchText("ΟΣ")).toBe("οσ");
  });

  it("folds Greek final and medial sigma to the same Common-status form", () => {
    // CaseFolding.txt: `03A3; C; 03C3` and `03C2; C; 03C3` both target regular
    // sigma. This is a caseless-matching (case *folding*) property, distinct
    // from `String.prototype.toLowerCase`, whose word-position-dependent
    // Final_Sigma rule sends a word-final capital Sigma to U+03C2 instead.
    const finalSigma = "ς";
    const mediumSigma = "σ";
    const capitalSigma = "Σ";
    expect(finalSigma).not.toBe(mediumSigma);

    expect(foldSearchText(finalSigma)).toBe(mediumSigma);
    expect(foldSearchText(mediumSigma)).toBe(mediumSigma);
    expect(foldSearchText(capitalSigma)).toBe(mediumSigma);
    // A capital Sigma at the end of a "word" is exactly the case where
    // `toLowerCase` and Unicode simple case folding disagree.
    expect(foldSearchText("ΛΟΓΟΣ")).toBe("λογοσ");

    const projection = projectSearchText(`word${capitalSigma}`);
    expect(projection.text).toBe(`word${mediumSigma}`);
    expect(searchTextContains(projection.text, mediumSigma)).toBe(true);
  });

  it("keeps German sharp S distinct from ss under Simple case folding", () => {
    // CaseFolding.txt gives sharp s (U+00DF) only a Full (F) mapping to "ss";
    // it has no Common/Simple entry, so pinned Simple folding leaves it
    // unchanged. Capital sharp S (U+1E9E) has a Simple (S) entry to U+00DF,
    // so the two case pair with each other but neither ever becomes "ss".
    const sharpS = "ß";
    const capitalSharpS = "ẞ";

    expect(foldSearchText(sharpS)).toBe(sharpS);
    expect(foldSearchText(capitalSharpS)).toBe(sharpS);
    expect(foldSearchText("STRASSE")).not.toBe(foldSearchText("Straße"));
    expect(foldSearchText("Straße")).not.toBe(foldSearchText("Strasse"));
    expect(foldSearchText(`Stra${capitalSharpS}e`)).toBe(foldSearchText("Straße"));

    const projection = projectSearchText("Straße");
    expect(projection.text).toBe("straße");
    expect(searchTextContains(projection.text, "strasse")).toBe(false);
    expect(searchTextContains(projection.text, "straße")).toBe(true);
  });

  it("keeps script-specific marks significant inside Latin graphemes", () => {
    const arabic = "a\u064e";
    const hebrew = "a\u05b8";
    const indic = "a\u093e";
    const latinThenArabic = "a\u0301\u064e";
    const arabicThenLatin = "a\u064e\u0301";

    for (const marked of [arabic, hebrew, indic]) {
      expect(foldSearchText(marked, true)).toBe(marked);
      expect(foldSearchText(marked)).toBe(marked.toLowerCase());
      expect(foldSearchText(marked, true)).not.toBe("a");
      expect(foldSearchText(marked)).not.toBe("a");
    }
    expect(foldSearchText(latinThenArabic, true)).toBe("a\u064e");
    expect(foldSearchText(arabicThenLatin, true)).toBe("a\u064e");
    expect(foldSearchText("a\u0301", true)).toBe("a");
    expect(foldSearchText("a\u0307", true)).toBe("a");
    expect(foldSearchText("İ", true)).toBe("İ");
    // U+0130 has no Common/Simple case-fold entry (only Full and Turkic),
    // so pinned Simple case folding leaves it unchanged in every mode.
    expect(foldSearchText("İ")).toBe("İ");
    expect(foldSearchText("a\u20dd", true)).toBe("a\u20dd");
    expect(foldSearchText("a\ufe0f", true)).toBe("a\ufe0f");
    expect(foldSearchText("a\u200d", true)).toBe("a\u200d");
    expect(searchTextContains("مَ a", "a")).toBe(true);
    expect(searchTextContains(arabic, "a")).toBe(false);
  });

  it("keeps canonical equivalence, astral text, and mixed-script queries aligned", () => {
    const composed = "ấ";
    const decomposed = "a\u0302\u0301";
    expect(foldSearchText(composed, true)).toBe(foldSearchText(decomposed, true));
    expect(foldSearchText(composed)).toBe(foldSearchText(decomposed));

    const family = "👩\u200d❤️\u200d👨";
    expect(foldSearchText(family, true)).toBe(family);
    expect(foldSearchText(family)).toBe(family);
    expect(foldSearchText("a\u064e", true)).not.toBe(foldSearchText("a", true));
    expect(foldSearchText("a", true)).not.toBe(foldSearchText("a\u064e", true));
  });

  it("requires both match edges to be extended-grapheme boundaries", () => {
    const couple = "👩\u200d❤️\u200d👨";
    const flag = "🇨🇦";
    const marked = "a\u0301";
    const spacingMark = "क\u093e";
    const modifier = "👍🏽";
    const hangul = "가";
    const prepends = ["\u0600", "\u0890", String.fromCodePoint(0x110bd)];

    for (const [haystack, interior] of [
      [couple, "👨"],
      [couple, "\u200d"],
      [flag, "🇦"],
      [marked, "\u0301"],
      [spacingMark, "क"],
      [spacingMark, "\u093e"],
      [modifier, "👍"],
      [modifier, "🏽"],
      [hangul, "ᄀ"],
      [hangul, "ᅡ"],
    ] as const) {
      expect(searchTextContains(haystack, interior)).toBe(false);
      expect(searchTextMatchCount(haystack, interior)).toBe(0);
      expect(searchTextFindMatch(haystack, interior)).toBe(-1);
    }

    for (const prepend of prepends) {
      const haystack = `${prepend}a`;
      for (const interior of [prepend, "a"]) {
        expect(searchTextContains(haystack, interior)).toBe(false);
        expect(searchTextMatchCount(haystack, interior)).toBe(0);
        expect(searchTextFindMatch(haystack, interior)).toBe(-1);
      }
      expect(searchTextContains(haystack, haystack)).toBe(true);
    }

    expect(searchTextContains(couple, couple)).toBe(true);
    expect(searchTextContains(flag, flag)).toBe(true);
    expect(searchTextContains(marked, marked)).toBe(true);
    expect(searchTextContains(spacingMark, spacingMark)).toBe(true);
    expect(searchTextContains(modifier, modifier)).toBe(true);
    expect(searchTextContains(hangul, hangul)).toBe(true);
    expect(searchTextMatchCount(`${couple} ${couple}`, couple)).toBe(2);
    expect(searchTextMatchCount("🇨🇦🇺🇸", "🇺🇸")).toBe(1);
    expect(searchTextContains("\r\n", "\r")).toBe(false);
    expect(searchTextContains("\r\n", "\n")).toBe(false);
    expect(searchTextContains("\r\n", "\r\n")).toBe(true);
  });

  it("case-folds a cased letter inside a Prepend grapheme without splitting it", () => {
    // A Unicode Prepend character (grapheme cluster break property Prepend)
    // attaches to the following character to form one extended grapheme
    // cluster, so a cased base letter can appear inside a multi-code-point
    // grapheme. Folding must reach that letter while leaving the Prepend
    // character itself untouched, and the grapheme must still be
    // impenetrable to a query for either half alone.
    const prepends = ["؀", "࢐", String.fromCodePoint(0x110bd)];
    for (const prepend of prepends) {
      const source = `${prepend}Apple`;
      const projection = projectSearchText(source);

      expect(projection.text).toBe(`${prepend}apple`);
      expect(searchTextContains(projection.text, "apple")).toBe(false);
      expect(searchTextContains(projection.text, `${prepend}apple`)).toBe(true);

      const match = searchTextFindMatch(projection.text, `${prepend}apple`);
      expect(mapSearchMatchToSourceRange(projection, match, `${prepend}apple`.length)).toEqual({
        start: 0,
        end: source.length,
      });
    }
  });

  it("maps folded matches to exact UTF-16 source ranges and grapheme boundaries", () => {
    const source = "prefix 😀 Cafe\u0301 target";
    const projection = projectSearchText(source);
    const foldedStart = projection.text.indexOf("cafe");
    const range = mapSearchMatchToSourceRange(projection, foldedStart, "cafe".length);

    expect(range).toEqual({
      start: source.indexOf("Cafe"),
      end: source.indexOf(" target"),
    });
    expect(source.slice(range?.start, range?.end)).toBe("Cafe\u0301");
    expect(source.slice(0, range?.start).endsWith("\ud83d\ude00 ")).toBe(true);
    expect(projection.source).toBe(source);
    expect(mapSearchMatchToSourceRange(projectSearchText("a\u064e"), 0, 1)).toBeNull();
  });

  it("maps a Turkish dotted I to correct UTF-16 source offsets alongside astral and decomposed graphemes", () => {
    const source = "prefix 😀 İ Cafe\u0301 target";
    const projection = projectSearchText(source);

    // Pinned Simple case folding has no Common/Simple entry for U+0130, so it
    // folds to itself and survives untouched inside an otherwise lower-cased
    // key -- unlike `String.prototype.toLowerCase`, which would expand it to
    // "i" + a combining dot above.
    expect(projection.text).toContain("İ cafe target");

    const dottedIStart = projection.text.indexOf("İ");
    const dottedIRange = mapSearchMatchToSourceRange(projection, dottedIStart, 1);
    expect(dottedIRange).toEqual({
      start: source.indexOf("İ"),
      end: source.indexOf("İ") + 1,
    });
    expect(source.slice(dottedIRange?.start, dottedIRange?.end)).toBe("İ");

    const foldedStart = projection.text.indexOf("cafe");
    const range = mapSearchMatchToSourceRange(projection, foldedStart, "cafe".length);
    expect(range).toEqual({
      start: source.indexOf("Cafe"),
      end: source.indexOf(" target"),
    });
    expect(source.slice(range?.start, range?.end)).toBe("Cafe\u0301");
  });

  it("keeps Turkish dotted I distinct from plain Latin I under Simple case folding", () => {
    const source = "İstanbul";
    const projection = projectSearchText(source);

    // No Turkic (T) folding is applied: the dotted capital is not conflated
    // with plain "i"/"I", so only a query that itself carries the dotted
    // capital finds this grapheme.
    expect(projection.text).toBe(source);
    expect(searchTextContains(projection.text, "istanbul")).toBe(false);
    expect(searchTextContains(projection.text, source)).toBe(true);

    const match = searchTextFindMatch(projection.text, source);
    expect(match).toBe(0);
    expect(mapSearchMatchToSourceRange(projection, match, source.length)).toEqual({
      start: 0,
      end: source.length,
    });
  });
});
