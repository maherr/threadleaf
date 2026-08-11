import { describe, expect, it } from "vitest";
import { parseMarkdownLinks } from "./markdown-links";

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
});
