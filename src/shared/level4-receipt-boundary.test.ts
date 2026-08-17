import { describe, expect, it } from "vitest";
import {
  canonicalizeLevel4Json,
  level4JsonSha256,
  parseLevel4Json,
} from "./level4-receipt-boundary.mjs";

function canonical(value: unknown): string {
  return Buffer.from(canonicalizeLevel4Json(value as never)).toString("utf8");
}

describe("Level 4 receipt strict RFC 8785 boundary", () => {
  it("orders astral keys by UTF-16 code units and escapes controls", () => {
    expect(
      canonical({
        "😀": "grin",
        "\u20ac": "euro",
        "\ud834\udd1e": "g-clef",
        "\u000f": "unit-separator",
        "\n": "line-feed",
        "\r": "carriage-return",
        "1": "one",
      }),
    ).toBe(
      '{"\\n":"line-feed","\\r":"carriage-return","\\u000f":"unit-separator","1":"one","€":"euro","𝄞":"g-clef","😀":"grin"}',
    );
  });

  it("accepts only safe integers and rejects number edge cases", () => {
    expect(canonical({ zero: 0, negative: -7, maximum: 9_007_199_254_740_991 })).toBe(
      '{"maximum":9007199254740991,"negative":-7,"zero":0}',
    );
    for (const value of [
      1.5,
      -0,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      9_007_199_254_740_992,
    ]) {
      expect(() => canonical(value)).toThrow();
    }
  });

  it("rejects prototypes, mutation hooks, special objects, and non-data values", () => {
    const prototypeBearing = Object.create({ inherited: 1 }) as { own: number };
    prototypeBearing.own = 1;
    expect(() => canonical(prototypeBearing)).toThrow();
    expect(() => canonical(new Date(0))).toThrow();
    expect(() => canonical(new Map([["key", 1]]))).toThrow();
    expect(() => canonical(new Set([1]))).toThrow();
    expect(() => canonical({ toJSON: () => ({}) })).toThrow();
    expect(() => canonical({ value: undefined })).toThrow();
    expect(() => canonical({ value: Symbol("value") })).toThrow();
    expect(() => canonical({ value: () => 1 })).toThrow();
    const withSymbol = { value: 1 } as { value: number; [key: symbol]: number };
    withSymbol[Symbol("extra")] = 1;
    expect(() => canonical(withSymbol)).toThrow();
    const sparse = [] as unknown[];
    sparse.length = 1;
    expect(() => canonical(sparse)).toThrow();
    const extraArrayField = [1] as unknown[] & { extra?: number };
    extraArrayField.extra = 1;
    expect(() => canonical(extraArrayField)).toThrow();
    const accessor = {} as { value: number };
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get: () => 1,
    });
    expect(() => canonical(accessor)).toThrow();
  });

  it("rejects lone surrogates and accepts valid non-BMP strings", () => {
    expect(() => canonical("\ud800")).toThrow();
    expect(() => canonical({ "\ud800": "invalid-key" })).toThrow();
    expect(canonical("😀")).toBe('"😀"');
  });

  it("detects duplicate textual keys and noncanonical raw bytes", () => {
    expect(() => parseLevel4Json('{"a":1,"a":2}')).toThrow();
    expect(() => parseLevel4Json('{"a":1.0}')).toThrow();
    expect(() => parseLevel4Json('{"a":1e0}')).toThrow();
    expect(() => parseLevel4Json('{"a":-0}')).toThrow();
    expect(() => parseLevel4Json('{"a":9007199254740992}')).toThrow();
    expect(() => parseLevel4Json('{"a":NaN}')).toThrow();
    expect(() => parseLevel4Json('{"a":Infinity}')).toThrow();
    expect(() => parseLevel4Json([123] as never)).toThrow();
    expect(() => parseLevel4Json('{"a":"\ud800"}')).toThrow();
    expect(() => parseLevel4Json('{"b":2,"a":1}', { requireCanonical: true })).toThrow();
    expect(() => parseLevel4Json(' {"a":1}', { requireCanonical: true })).toThrow();
    expect(() => parseLevel4Json(Buffer.from([0xc3, 0x28]))).toThrow();
    const bytes = canonicalizeLevel4Json({ a: 1, nested: [true, null, "x"] });
    expect(parseLevel4Json(bytes, { requireCanonical: true })).toEqual({
      a: 1,
      nested: [true, null, "x"],
    });
  });

  it("gives semantically equal values one signing digest", () => {
    expect(level4JsonSha256({ b: 2, a: 1 })).toBe(level4JsonSha256({ a: 1, b: 2 }));
  });
});
