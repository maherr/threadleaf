// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  calloutDefaultTitle,
  parseCalloutSourceLine,
  resolveCalloutStyle,
  standardCalloutTypes,
} from "./callouts";
import { renderMarkdownPreview } from "./markdown-preview";

function preview(source: string): HTMLElement {
  const root = document.createElement("div");
  root.append(renderMarkdownPreview(source));
  return root;
}

const aliases = {
  summary: "abstract",
  tldr: "abstract",
  hint: "tip",
  important: "tip",
  check: "success",
  done: "success",
  help: "question",
  faq: "question",
  caution: "warning",
  attention: "warning",
  fail: "failure",
  missing: "failure",
  error: "danger",
  cite: "quote",
} as const;

const stylesheet = readFileSync(resolve(process.cwd(), "src/renderer/styles.css"), "utf8");

describe("Obsidian-compatible callouts", () => {
  it("parses every standard identifier and alias case-insensitively", () => {
    for (const type of standardCalloutTypes) {
      expect(parseCalloutSourceLine(`> [!${type.toUpperCase()}] Title`)).toEqual({
        type,
        fold: null,
      });
      expect(resolveCalloutStyle(type)).toBe(type);
    }
    for (const [alias, style] of Object.entries(aliases)) {
      expect(parseCalloutSourceLine(`> [!${alias}] Alias`)).toEqual({ type: alias, fold: null });
      expect(resolveCalloutStyle(alias)).toBe(style);
    }
  });

  it("declares a distinct CSS accent and non-color icon for every standard style", () => {
    const accents = new Set<string>();
    const icons = new Set<string>();
    for (const type of standardCalloutTypes) {
      const selector = new RegExp(
        String.raw`\.callout\[data-callout-style="${type}"\]\s*\{\s*--callout-color:\s*([^;]+);\s*--tl-callout-glyph:\s*([^;]+);`,
        "u",
      );
      const match = selector.exec(stylesheet);
      expect(match?.[1]).toBeTruthy();
      expect(match?.[2]).toBeTruthy();
      accents.add(match?.[1]?.trim() ?? "");
      icons.add(match?.[2]?.trim() ?? "");
    }
    expect(accents).toHaveLength(standardCalloutTypes.length);
    expect(icons).toHaveLength(standardCalloutTypes.length);
    expect(stylesheet).not.toMatch(/--callout-icon\s*:/u);
  });

  it("uses the measured icon ink for the visible border and focus ring", () => {
    expect(stylesheet).toMatch(
      /border:\s*var\(--callout-border-width\)\s+solid\s+var\(--callout-icon-color\)/u,
    );
    expect(stylesheet).toMatch(
      /\.callout-title:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--callout-icon-color\)/su,
    );
    expect(stylesheet).toMatch(/--callout-icon-color:\s*var\(--callout-color\)/u);
  });

  it("keeps the pale callout materials shared instead of making them a categorical color channel", () => {
    expect(stylesheet).toMatch(/\.callout\s*\{[^}]*background:\s*var\(--surface-raised\)/su);
    expect(stylesheet).toMatch(/\.callout-title\s*\{[^}]*background:\s*var\(--surface-sunken\)/su);
    expect(stylesheet).not.toMatch(/background:\s*color-mix\([^;]*var\(--callout-color\)/u);
  });

  it("recognizes fold variants and keeps an exact default title for empty headers", () => {
    expect(parseCalloutSourceLine("> [!faq]- Collapsed")).toEqual({
      type: "faq",
      fold: "collapsed",
    });
    expect(parseCalloutSourceLine("> [!faq]+ Expanded")).toEqual({
      type: "faq",
      fold: "expanded",
    });
    expect(calloutDefaultTitle("custom-alert_type")).toBe("Custom Alert Type");

    const root = preview("> [!todo]");
    expect(root.querySelector(".callout-title-inner")?.textContent).toBe("Todo");
  });

  it("emits the public DOM contract and preserves inline Markdown in the title", () => {
    const root = preview(["> [!tip] **Bold** _title_", "> Body text"].join("\n"));
    const callout = root.querySelector<HTMLElement>(".callout");
    expect(callout).not.toBeNull();
    expect(callout?.dataset.callout).toBe("tip");
    expect(callout?.dataset.calloutStyle).toBe("tip");
    expect(callout?.dataset.sourceLine).toBe("1");
    expect(callout?.querySelector(":scope > .callout-title > .callout-icon")).not.toBeNull();
    expect(
      callout?.querySelector(":scope > .callout-title > .callout-title-inner strong")?.textContent,
    ).toBe("Bold");
    expect(callout?.querySelector(".callout-title-inner em")?.textContent).toBe("title");
    expect(callout?.querySelector(":scope > .callout-content")?.textContent).toContain("Body text");
  });

  it("folds only in view state and never changes its source marker", () => {
    const source = ["> [!warning]- Keep source", "> Hidden body"].join("\n");
    const root = preview(source);
    const callout = root.querySelector<HTMLElement>(".callout");
    const title = root.querySelector<HTMLElement>(".callout-title");
    expect(callout?.classList.contains("is-collapsible")).toBe(true);
    expect(callout?.classList.contains("is-collapsed")).toBe(true);
    expect(title?.getAttribute("aria-expanded")).toBe("false");

    title?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(callout?.classList.contains("is-collapsed")).toBe(false);
    expect(title?.getAttribute("aria-expanded")).toBe("true");
    expect(source).toBe("> [!warning]- Keep source\n> Hidden body");
  });

  it("renders nested callouts as nested public callout containers", () => {
    const root = preview(
      ["> [!question] Outer title", ">", "> > [!todo] Inner title", "> > Inner body"].join("\n"),
    );
    const callouts = root.querySelectorAll<HTMLElement>(".callout");
    expect(callouts).toHaveLength(2);
    expect(callouts[0]?.dataset.callout).toBe("question");
    expect(callouts[1]?.dataset.callout).toBe("todo");
    expect(callouts[0]?.querySelector(".callout-content .callout")).toBe(callouts[1]);
  });

  it("falls back to note styling while retaining an unknown identifier for user CSS", () => {
    const root = preview("> [!Custom-Alert] Custom body");
    const callout = root.querySelector<HTMLElement>(".callout");
    expect(callout?.dataset.callout).toBe("custom-alert");
    expect(callout?.dataset.calloutStyle).toBe("note");
    expect(callout?.querySelector(".callout-title-inner")?.textContent).toBe("Custom body");
  });

  it("leaves malformed or mid-quote marker lookalikes as ordinary blockquotes", () => {
    for (const source of [
      ">[!note] Missing required space",
      "> This quote mentions [!note] in the middle",
      "> [!note]Missing required title space",
    ]) {
      const root = preview(source);
      expect(root.querySelector(".callout")).toBeNull();
      expect(root.querySelector("blockquote")?.textContent).toContain("[!note]");
    }
  });
  it("restricts type identifiers to ASCII despite Unicode case-folding lookalikes", () => {
    for (const source of ["> [!\u017f] Long s lookalike", "> [!\u212a] Kelvin lookalike"]) {
      const root = preview(source);
      expect(root.querySelector(".callout")).toBeNull();
      expect(root.querySelector("blockquote")).not.toBeNull();
    }
    const upper = preview("> [!NOTE] Uppercase ASCII still resolves");
    expect(upper.querySelector(".callout")?.getAttribute("data-callout")).toBe("note");
  });
});
