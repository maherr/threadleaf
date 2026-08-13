import { describe, expect, it } from "vitest";
import {
  collectFootnotes,
  findInlineMathClose,
  markdownCodeRanges,
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

  it("does not collect definitions hidden inside multiline raw HTML", () => {
    const source = [
      "Visible[^shown]",
      "<span>",
      "[^hidden]: HTML text must remain source.",
      "</span>",
      "",
      "[^shown]: The semantic definition remains outside HTML.",
    ].join("\n");
    const collection = collectFootnotes(source);

    expect(collection.definitions.map(({ id }) => id)).toEqual(["shown"]);
    expect(collection.ids).toEqual(new Set(["shown"]));
    expect(collection.body.split("\n")[2]).toBe("[^hidden]: HTML text must remain source.");
    expect(collection.body).not.toContain(
      "[^shown]: The semantic definition remains outside HTML.",
    );
  });

  it("keeps protected HTML forms source-only while collecting post-close definitions", () => {
    const cases: Array<[string, string[]]> = [
      ["<!--\n[^hidden]: comment text\n-->\n[^shown]: after comment", ["shown"]],
      ["<![CDATA[\n[^hidden]: CDATA text\n]]>\n[^shown]: after CDATA", ["shown"]],
      ["<!DOCTYPE html>\n[^shown]: after declaration", ["shown"]],
      ["<https://example.com>\n[^shown]: after autolink", ["shown"]],
      ["<br>\n[^shown]: after void tag", ["shown"]],
      ["<span>\n<b>\n[^hidden]: nested text\n</span>\n[^shown]: after HTML", ["shown"]],
      ["<span>\n[^hidden]: unclosed text\n[^also-hidden]: still HTML", []],
      [
        "---\r\ntitle: 😀\r\n---\r\n<span>\r\n[^hidden]: after astral frontmatter\r\n</span>\r\n[^shown]: after HTML",
        ["shown"],
      ],
    ];
    for (const [source, expectedIds] of cases) {
      const collection = collectFootnotes(source);
      const ids = collection.definitions.map(({ id }) => id);
      expect(ids, source).toEqual(expectedIds);
      if (source.includes("[^hidden]")) {
        expect(collection.body, source).toContain("[^hidden]");
      }
    }
  });

  it("bounds unmatched inline-code runs with distinct lengths by operation count", () => {
    const operationCounts: number[] = [];
    for (const runCount of [32, 64, 128]) {
      const source = Array.from({ length: runCount }, (_, index) => "`".repeat(index + 1)).join(
        "x",
      );
      const stats = { steps: 0 };
      expect(markdownCodeRanges(source, stats)).toEqual([]);
      operationCounts.push(stats.steps);
      expect(stats.steps).toBeLessThan(source.length * 4);
    }
    expect(operationCounts[1]).toBeLessThan((operationCounts[0] ?? 0) * 5);
    expect(operationCounts[2]).toBeLessThan((operationCounts[1] ?? 0) * 5);
  });

  it("preserves escaped delimiters and UTF-16 source offsets", () => {
    const source = "😀 `one` \\`literal ``two``";
    const first = source.indexOf("`one`");
    const second = source.indexOf("``two``");
    expect(markdownCodeRanges(source)).toEqual([
      { from: first, to: first + "`one`".length },
      { from: second, to: second + "``two``".length },
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

  it("keeps HTML ranges UTF-16-correct across CRLF code lookalikes", () => {
    const source = "😀 <span>\r\n~~~\r\n</span>\r\n~~~\r\n</span>\r\n$x$";
    const from = source.indexOf("<span>");
    const to = source.lastIndexOf("</span>") + "</span>".length;
    expect(markdownHtmlRanges(source)).toEqual([{ from, to }]);
  });

  it("keeps mismatched closers fail-closed and bounds adversarial stack work", () => {
    const mismatched = "<a><b></c> $x$ </b> $y$ </a> $z$";
    const outerEnd = mismatched.indexOf("</a>") + "</a>".length;
    expect(markdownHtmlRanges(mismatched)).toEqual([{ from: 0, to: outerEnd }]);

    const size = 4_096;
    const source = "<span>".repeat(size) + "</missing>".repeat(size) + "</span>".repeat(size);
    const stats = { steps: 0, maxOpenTags: 0 };
    expect(markdownHtmlRanges(source, undefined, stats)).toEqual([{ from: 0, to: source.length }]);
    expect(stats.maxOpenTags).toBe(size);
    expect(stats.steps).toBeLessThan(source.length);
  });

  it("keeps nested comments and malformed tags inside the outer HTML range", () => {
    const comment = "<span><!-- </span> $x$ --> **inside** </span> $y$";
    expect(markdownHtmlRanges(comment)).toEqual([
      { from: 0, to: comment.lastIndexOf("</span>") + "</span>".length },
    ]);

    const malformed = '<span><em title="unterminated> $x$ </span> $y$';
    expect(markdownHtmlRanges(malformed)).toEqual([{ from: 0, to: malformed.length }]);
  });
});
