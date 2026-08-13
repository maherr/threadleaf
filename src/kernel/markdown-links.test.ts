import { describe, expect, it } from "vitest";
import {
  parseMarkdownLinks,
  parseMarkdownReferenceDefinitions,
  parseMarkdownReferenceUsages,
} from "./markdown-links";

describe("Markdown link source parser", () => {
  it("returns exact target ranges while preserving aliases, subpaths, embeds, and titles", () => {
    const content = [
      "Before [[ Folder/Target#Heading | visible ]] and ![[Image.png]].",
      'Read [the note](../Other%20Note.md#Part "hover title").',
    ].join("\n");

    const links = parseMarkdownLinks(content);

    expect(links).toMatchObject([
      {
        target: "Folder/Target",
        subpath: "#Heading",
        alias: "visible",
        embed: false,
        syntax: "wiki",
        line: 1,
      },
      {
        target: "Image.png",
        subpath: null,
        alias: null,
        embed: true,
        syntax: "wiki",
        line: 1,
      },
      {
        target: "../Other Note.md",
        subpath: "#Part",
        alias: null,
        embed: false,
        syntax: "markdown",
        line: 2,
      },
    ]);
    expect(links.map((link) => content.slice(link.targetStart, link.targetEnd))).toEqual([
      "Folder/Target",
      "Image.png",
      "../Other%20Note.md",
    ]);
    expect(links.map((link) => content.slice(link.position, link.end))).toEqual([
      "[[ Folder/Target#Heading | visible ]]",
      "![[Image.png]]",
      '[the note](../Other%20Note.md#Part "hover title")',
    ]);
  });

  it("ignores fenced code without shifting later source offsets", () => {
    const content = [
      "[[Before]]",
      "```md",
      "[[Ignored]]",
      "[also ignored](Hidden.md)",
      "```",
      "[After](Target.md)",
    ].join("\n");

    const links = parseMarkdownLinks(content);

    expect(links.map((link) => ({ target: link.target, line: link.line }))).toEqual([
      { target: "Before", line: 1 },
      { target: "Target.md", line: 6 },
    ]);
    expect(content.slice(links[1]?.targetStart, links[1]?.targetEnd)).toBe("Target.md");
  });

  it("keeps repeated links in source order with independent ranges", () => {
    const content = "[[Same]] then [[Same|again]] then [same](Same.md)";
    const links = parseMarkdownLinks(content);

    expect(links.map((link) => link.position)).toEqual(
      [...links.map((link) => link.position)].sort((a, b) => a - b),
    );
    expect(links.map((link) => content.slice(link.targetStart, link.targetEnd))).toEqual([
      "Same",
      "Same",
      "Same.md",
    ]);
  });

  it("splits anchors before decoding escaped filename delimiters", () => {
    const links = parseMarkdownLinks(
      "[[Note%23One#Heading]] and [caret](Folder/Note%5ETwo.md^block)",
    );

    expect(links.map((link) => ({ target: link.target, subpath: link.subpath }))).toEqual([
      { target: "Note#One", subpath: "#Heading" },
      { target: "Folder/Note^Two.md", subpath: "^block" },
    ]);
  });

  it("ignores inline code and HTML comments without shifting visible link ranges", () => {
    const content = [
      "`[[Inline]]` and ``[also inline](Hidden.md)`` then [[Visible]]",
      "<!-- [[Commented]] --> [shown](Target.md)",
      "<!--",
      "[[Commented across lines]]",
      "-->",
      "![[Image.png]]",
    ].join("\n");

    const links = parseMarkdownLinks(content);

    expect(links.map((link) => ({ target: link.target, line: link.line }))).toEqual([
      { target: "Visible", line: 1 },
      { target: "Target.md", line: 2 },
      { target: "Image.png", line: 6 },
    ]);
    expect(links.map((link) => content.slice(link.targetStart, link.targetEnd))).toEqual([
      "Visible",
      "Target.md",
      "Image.png",
    ]);
  });

  it("requires a matching fence character with at least the opener length", () => {
    const content = [
      "````md",
      "[[Ignored]]",
      "```",
      "[[Still ignored]]",
      "````",
      "[[Visible]]",
    ].join("\n");

    expect(parseMarkdownLinks(content).map((link) => link.target)).toEqual(["Visible"]);
  });

  it("preserves aliases, embeds, line numbers, and offsets across CR-only and mixed endings", () => {
    const content = "[[Before|alias]]\r![[Nested|embed]]\r\n[After](Target.md)\n";
    const links = parseMarkdownLinks(content);

    expect(
      links.map((link) => ({ target: link.target, label: link.alias, line: link.line })),
    ).toEqual([
      { target: "Before", label: "alias", line: 1 },
      { target: "Nested", label: "embed", line: 2 },
      { target: "Target.md", label: null, line: 3 },
    ]);
    expect(links.map((link) => content.slice(link.position, link.end))).toEqual([
      "[[Before|alias]]",
      "![[Nested|embed]]",
      "[After](Target.md)",
    ]);
  });

  it("parses reference-style definitions with angle destinations and titles", () => {
    const content = [
      "Use [report][asset] and ![report image][asset].",
      '[asset]: <../Assets/Report (draft).pdf?download=1#page=2> "Report title"',
    ].join("\n");
    const links = parseMarkdownLinks(content);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      target: "../Assets/Report (draft).pdf?download=1",
      syntax: "markdown",
      embed: false,
      line: 2,
    });
    expect(content.slice(links[0]?.targetStart, links[0]?.targetEnd)).toBe(
      "../Assets/Report (draft).pdf?download=1",
    );
    expect(content.slice(links[0]?.position, links[0]?.end)).toBe(
      '[asset]: <../Assets/Report (draft).pdf?download=1#page=2> "Report title"',
    );
  });

  it("parses escaped balanced-parenthesis destinations without consuming the title", () => {
    const content = '[asset]: ../Assets/Report\\ \\(draft\\).pdf?download=1#page=2 "title"';
    const links = parseMarkdownLinks(content);
    expect(links).toHaveLength(1);
    expect(content.slice(links[0]?.targetStart, links[0]?.targetEnd)).toBe(
      "../Assets/Report\\ \\(draft\\).pdf?download=1",
    );
  });

  it("excludes source-only YAML frontmatter while preserving later definitions", () => {
    const content = ["---", "[asset]: Hidden.pdf", "---", "", "[asset]: Visible.pdf"].join("\n");
    const links = parseMarkdownLinks(content);
    expect(links.map((link) => link.target)).toEqual(["Visible.pdf"]);
    expect(links[0]?.line).toBe(5);
  });

  it("does not treat escaped literal query or fragment bytes as suffixes", () => {
    const links = parseMarkdownLinks(
      "[query](Assets/report\\?draft.pdf) [fragment](Assets/report\\#draft.pdf)",
    );
    expect(links.map((link) => ({ target: link.target, subpath: link.subpath }))).toEqual([
      { target: "Assets/report?draft.pdf", subpath: null },
      { target: "Assets/report#draft.pdf", subpath: null },
    ]);
  });

  it("finds visible full, collapsed, and shortcut image references without frontmatter definitions", () => {
    const content = [
      "---",
      "[asset]: Hidden.pdf",
      "---",
      "![full][asset] ![collapsed][] ![shortcut]",
      "[asset]: Visible.pdf",
    ].join("\n");
    expect(parseMarkdownReferenceUsages(content).map((usage) => usage.label)).toEqual([
      "asset",
      "collapsed",
      "shortcut",
    ]);
    expect(parseMarkdownReferenceDefinitions(content)).toEqual([
      { label: "asset", valid: true, external: false, line: 5 },
    ]);
  });
});
