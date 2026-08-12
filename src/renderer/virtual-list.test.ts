import { describe, expect, it } from "vitest";
import { nearestItemScrollTop, virtualListWindow } from "./virtual-list";

describe("virtual list geometry", () => {
  it("renders only the viewport and bounded overscan for a large collection", () => {
    expect(
      virtualListWindow({
        itemCount: 20_000,
        rowHeight: 64,
        scrollTop: 12_800,
        viewportHeight: 640,
        overscan: 4,
      }),
    ).toEqual({
      start: 196,
      end: 214,
      topSpacer: 12_544,
      bottomSpacer: 1_266_304,
    });
  });

  it("clamps empty, leading, and trailing windows", () => {
    expect(
      virtualListWindow({
        itemCount: 0,
        rowHeight: 64,
        scrollTop: 100,
        viewportHeight: 640,
        overscan: 4,
      }),
    ).toEqual({ start: 0, end: 0, topSpacer: 0, bottomSpacer: 0 });
    expect(
      virtualListWindow({
        itemCount: 10,
        rowHeight: 64,
        scrollTop: 10_000,
        viewportHeight: 128,
        overscan: 2,
      }),
    ).toEqual({ start: 6, end: 10, topSpacer: 384, bottomSpacer: 0 });
  });

  it("scrolls only when the requested item is outside the viewport", () => {
    expect(nearestItemScrollTop(5, 64, 256, 256)).toBe(256);
    expect(nearestItemScrollTop(8, 64, 256, 256)).toBe(320);
    expect(nearestItemScrollTop(3, 64, 256, 256)).toBe(192);
  });
});
