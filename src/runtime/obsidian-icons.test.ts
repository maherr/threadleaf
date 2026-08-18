import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { createCompatibleIcon } from "./obsidian-icons";

describe("Obsidian icon compatibility", () => {
  it.each([
    ["reset", "RotateCcw"],
    ["install", "Download"],
    ["right-triangle", "TriangleRight"],
  ])("renders the legacy %s icon as a nonempty SVG", (iconId) => {
    const dom = new JSDOM("<!doctype html>");

    const icon = createCompatibleIcon(dom.window.document, iconId, null);

    expect(icon).not.toBeNull();
    expect(icon?.dataset.icon).toBe(iconId);
    expect(icon?.children.length).toBeGreaterThan(0);
    expect(icon?.querySelector("path, line, polyline, polygon, circle, rect, ellipse")).not.toBe(
      null,
    );
    dom.window.close();
  });

  it("keeps direct Lucide lookup, custom content, and unknown-id behavior intact", () => {
    const dom = new JSDOM("<!doctype html>");

    const direct = createCompatibleIcon(dom.window.document, "lucide-leaf", null);
    const custom = createCompatibleIcon(
      dom.window.document,
      "threadleaf-custom",
      '<path d="M2 2h20v20H2z" />',
    );
    const unknown = createCompatibleIcon(dom.window.document, "threadleaf-unknown", null);

    expect(direct?.dataset.icon).toBe("lucide-leaf");
    expect(direct?.children.length).toBeGreaterThan(0);
    expect(custom?.dataset.icon).toBe("threadleaf-custom");
    expect(custom?.querySelector("path")).not.toBeNull();
    expect(unknown).toBeNull();
    dom.window.close();
  });
});
