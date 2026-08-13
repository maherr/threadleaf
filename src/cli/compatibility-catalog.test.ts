import { describe, expect, it } from "vitest";
import { safeCatalogText } from "./compatibility-catalog";

describe("safeCatalogText", () => {
  it("removes terminal controls and bounds complete Unicode code points", () => {
    const bounded = safeCatalogText(`${"a".repeat(199)}😀tail`);

    expect(Array.from(bounded)).toHaveLength(200);
    expect(bounded.endsWith("😀")).toBe(true);
    expect(safeCatalogText("  one\u0007\n\ttwo  ")).toBe("one two");
  });
});
