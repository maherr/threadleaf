import { describe, expect, it } from "vitest";
import {
  collectFootnotes,
  findInlineMathClose,
  markdownHtmlRanges,
  renderSafeMath,
  safeMathLimits,
  scanInlineMath,
  sourceLineStarts,
} from "./markdown-extensions";

describe("bounded offline math", () => {
  it("keeps ordinary expressions inside the realistic limits", () => {
    expect(renderSafeMath(String.raw`\sum_{i=1}^{n} \frac{i^2}{2}`)).not.toBeNull();
    expect(renderSafeMath("x".repeat(1_000))).not.toBeNull();
  });

  it("rejects a 2048-level nested fraction without recursing unboundedly", () => {
    let expression = "x";
    for (let index = 0; index < 2_048; index += 1) {
      expression = String.raw`\frac{${expression}}{1}`;
    }
    expect(expression.length).toBeGreaterThan(safeMathLimits.maxInputLength);
    expect(() => renderSafeMath(expression)).not.toThrow();
    expect(renderSafeMath(expression)).toBeNull();
  });

  it("finds a closer in one pass and returns no closer for a long unmatched family", () => {
    const closed = String.raw`prefix \(x + y\) suffix`;
    expect(findInlineMathClose(closed, 7, "paren")).toBe(14);

    const unmatched = String.raw`\(`.repeat(50_000);
    expect(() => findInlineMathClose(unmatched, 0, "paren")).not.toThrow();
    expect(findInlineMathClose(unmatched, 0, "paren")).toBe(-1);
  });

  it("scans overlapping inline openers with a linear operation bound", () => {
    const operationCounts: number[] = [];
    for (const size of [10_000, 30_000, 60_000]) {
      const source = String.raw`\(`.repeat(size) + String.raw`x\)`;
      const scan = scanInlineMath(source);
      operationCounts.push(scan.steps);
      expect(scan.candidates.get(0)).toBeNull();
      expect(scan.scannedLength).toBeLessThanOrEqual(source.length);
      expect(scan.steps).toBeLessThan(source.length * 3);
    }
    expect(operationCounts[1]).toBeLessThan((operationCounts[0] ?? 0) * 4);
    expect(operationCounts[2]).toBeLessThan((operationCounts[1] ?? 0) * 3);

    const unmatched = scanInlineMath(String.raw`\(`.repeat(50_000));
    expect(unmatched.unmatchedOpeners.has(0)).toBe(true);
    expect(unmatched.scannedLength).toBeLessThanOrEqual(safeMathLimits.maxDelimiterScanLength + 2);
  });

  it("bounds the total number of inline candidates", () => {
    const source = "$x$ ".repeat(safeMathLimits.maxInlineMathCandidates + 100);
    const scan = scanInlineMath(source);
    expect(scan.truncated).toBe(true);
    expect(scan.candidates.size).toBe(safeMathLimits.maxInlineMathCandidates + 1);
  });

  it("keeps UTF-16 line offsets and masked footnote width for astral source", () => {
    const source = "[^id]: note 😀 $x$\r\nBody $y$ [[Good]]";
    const collection = collectFootnotes(source);
    expect(collection.body.length).toBe(source.length);
    expect(sourceLineStarts("---\r\ntitle: 😀\r\n---\r\nBody")).toEqual([0, 5, 16, 21]);
  });

  it("does not materialize unbounded footnote lines for unresolved frontmatter", () => {
    const source = [
      "---",
      ...Array.from({ length: 100_000 }, (_, index) => `key${index}: value`),
      "Body $x$ [[Embed]]",
    ].join("\n");
    const collection = collectFootnotes(source);
    expect(collection.body).toBe(source);
    expect(collection.definitions).toEqual([]);
    expect(collection.definitionLines.size).toBe(0);
  });

  it("does not collect footnotes from mismatched or insufficient fenced-code closers", () => {
    for (const source of [
      ["~~~", "```", "[^inside]: tilde code must stay source."].join("\n"),
      ["~~~~", "~~~", "[^inside]: a shorter tilde fence must not close the block."].join("\n"),
      ["```", "~~~", "[^inside]: backtick code must stay source after a tilde fence."].join("\n"),
      ["~~~", "[^inside]: an unclosed tilde fence must stay code."].join("\n"),
      ["```", "[^inside]: an unclosed backtick fence must stay code."].join("\n"),
    ]) {
      expect(collectFootnotes(source).definitions).toEqual([]);
    }
  });

  it("collects definitions after a matching fence closer without treating code as a definition", () => {
    const source = ["~~~~", "[^inside]: code", "~~~~", "", "[^outside]: footnote"].join("\n");
    expect(collectFootnotes(source).definitions.map((definition) => definition.id)).toEqual([
      "outside",
    ]);
  });
});

describe("raw HTML source protection", () => {
  it("protects nested elements and quoted tag delimiters without consuming following Markdown", () => {
    const source = 'before <span title="a > b"><em>- [ ] $x$</em></span> **after**';
    const from =
      source.indexOf("<span>") >= 0 ? source.indexOf("<span>") : source.indexOf("<span ");
    const to = source.indexOf("</span>") + "</span>".length;
    expect(markdownHtmlRanges(source)).toEqual([{ from, to }]);
  });

  it("keeps comments, void tags, self-closing tags, and malformed tags bounded", () => {
    const comment = "<!-- <span>$x$</span> --> $after$";
    expect(markdownHtmlRanges(comment)).toEqual([
      { from: 0, to: "<!-- <span>$x$</span> -->".length },
    ]);

    const tags = '<br> $x$ <img src="a>b"> $y$ <span/> $z$';
    expect(markdownHtmlRanges(tags)).toEqual([
      { from: 0, to: 4 },
      { from: 9, to: 24 },
      { from: 29, to: 36 },
    ]);

    const malformed = '<span title="unterminated $x$ **after**';
    expect(markdownHtmlRanges(malformed)).toEqual([{ from: 0, to: malformed.length }]);
  });

  it("does not mistake autolinks or inline-code lookalikes for HTML", () => {
    expect(markdownHtmlRanges("<https://example.com> $x$")).toEqual([]);
    const source = "`<span>$x$</span>` <span>$y$</span>";
    const from = source.lastIndexOf("<span>");
    expect(markdownHtmlRanges(source)).toEqual([{ from, to: source.length }]);

    const tagWithBackticks = '<span title="`not code`">$x$</span> $y$';
    expect(markdownHtmlRanges(tagWithBackticks)).toEqual([
      { from: 0, to: tagWithBackticks.indexOf("</span>") + "</span>".length },
    ]);
  });
});
