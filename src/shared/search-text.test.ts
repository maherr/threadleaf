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
    expect(foldSearchText("ΟΣ")).toBe("ος");
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
    expect(foldSearchText("İ")).toBe("i\u0307");
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

  it("maps offsets after case folding a Turkish dotted I and astral graphemes", () => {
    const source = "prefix 😀 İ Cafe\u0301 target";
    const projection = projectSearchText(source);
    const foldedStart = projection.text.indexOf("cafe");
    const range = mapSearchMatchToSourceRange(projection, foldedStart, "cafe".length);

    expect(projection.text).toContain("i\u0307 cafe target");
    expect(range).toEqual({
      start: source.indexOf("Cafe"),
      end: source.indexOf(" target"),
    });
    expect(source.slice(range?.start, range?.end)).toBe("Cafe\u0301");
  });

  it("keeps lower-case expansion edges grapheme-safe", () => {
    const projection = projectSearchText("İ");

    expect(projection.text).toBe("i\u0307");
    expect(searchTextContains(projection.text, "i")).toBe(false);
    expect(searchTextFindMatch(projection.text, "i")).toBe(-1);
    expect(searchTextMatchCount(projection.text, "i")).toBe(0);
    expect(searchTextContains(projection.text, "i\u0307")).toBe(true);
    expect(mapSearchMatchToSourceRange(projection, 0, 2)).toEqual({ start: 0, end: 1 });
  });
});
