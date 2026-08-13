import { describe, expect, it } from "vitest";
import { tabInsertionIndex } from "./workspace-tab-dnd";

const rectangles = [
  { index: 0, left: 0, right: 100, pinned: true },
  { index: 1, left: 100, right: 200, pinned: false },
  { index: 2, left: 200, right: 300, pinned: false },
];

describe("tabInsertionIndex", () => {
  it("uses midpoint targets within the source pin region", () => {
    expect(tabInsertionIndex(149, rectangles, false)).toBe(1);
    expect(tabInsertionIndex(151, rectangles, false)).toBe(2);
    expect(tabInsertionIndex(500, rectangles, false)).toBe(3);
  });

  it("clamps a pointer to the source region and rejects malformed input", () => {
    expect(tabInsertionIndex(-10, rectangles, false)).toBe(1);
    expect(tabInsertionIndex(50, rectangles, false)).toBe(1);
    expect(tabInsertionIndex(Number.NaN, rectangles, false)).toBeNull();
    expect(tabInsertionIndex(50, [], false)).toBeNull();
  });
});
