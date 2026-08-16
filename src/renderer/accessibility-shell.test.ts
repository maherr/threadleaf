import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(resolve(process.cwd(), "src/renderer/styles.css"), "utf8").replace(
  /^@import[^\n]*\n/u,
  "",
);
const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>");
const style = dom.window.document.createElement("style");
style.textContent = stylesheet;
dom.window.document.head.append(style);

function declarationsFor(selector: string): Map<string, string> {
  const declarations = new Map<string, string>();
  const rules = style.sheet?.cssRules ?? [];
  for (const rule of rules) {
    if (!("selectorText" in rule) || !("style" in rule)) continue;
    const selectors = String(rule.selectorText)
      .split(",")
      .map((candidate) => candidate.trim());
    if (!selectors.includes(selector)) continue;
    const ruleStyle = rule.style as CSSStyleDeclaration;
    for (let index = 0; index < ruleStyle.length; index += 1) {
      const property = ruleStyle.item(index);
      declarations.set(property, ruleStyle.getPropertyValue(property).trim());
    }
  }
  return declarations;
}

function pixels(value: string | undefined): number {
  return Number.parseFloat(value ?? "0");
}

describe("shell accessibility styles", () => {
  it.each([".quick-switcher-search:focus-within", ".palette-search:focus-within"])(
    "gives %s a visible focus frame",
    (selector) => {
      const declarations = declarationsFor(selector);
      expect(declarations.get("outline")).toBe("2px solid var(--accent)");
      expect(declarations.get("outline-offset")).toBe("-2px");
    },
  );

  it("keeps repeated document and tab actions at least 24px on both axes", () => {
    const viewMode = declarationsFor(".document-view-switch button");
    expect(pixels(viewMode.get("min-width"))).toBeGreaterThanOrEqual(24);
    expect(pixels(viewMode.get("min-height"))).toBeGreaterThanOrEqual(24);

    const closeTab = declarationsFor(".note-tab-close");
    expect(pixels(closeTab.get("min-width"))).toBeGreaterThanOrEqual(24);
    expect(pixels(closeTab.get("min-height"))).toBeGreaterThanOrEqual(24);
  });
});
