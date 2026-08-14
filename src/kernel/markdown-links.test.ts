import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import {
  maskMarkdownCodeAndComments,
  parseMarkdownLinks,
  parseMarkdownReferenceDefinitionCandidates,
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
      "before <!-- [[Commented]] --> [shown](Target.md)",
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
      "",
      '[asset]: <../Assets/Report (draft).pdf?download=1#page=2> "Report title"',
    ].join("\n");
    const links = parseMarkdownLinks(content);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      target: "../Assets/Report (draft).pdf?download=1",
      syntax: "markdown",
      embed: false,
      line: 3,
    });
    expect(content.slice(links[0]?.targetStart, links[0]?.targetEnd)).toBe(
      "../Assets/Report (draft).pdf?download=1",
    );
    expect(content.slice(links[0]?.position, links[0]?.end)).toBe(
      '[asset]: <../Assets/Report (draft).pdf?download=1#page=2> "Report title"',
    );
  });

  it("parses escaped balanced-parenthesis destinations without consuming the title", () => {
    const content = '[asset]: ../Assets/Report\\(draft\\).pdf?download=1#page=2 "title"';
    const links = parseMarkdownLinks(content);
    expect(links).toHaveLength(1);
    expect(content.slice(links[0]?.targetStart, links[0]?.targetEnd)).toBe(
      "../Assets/Report\\(draft\\).pdf?download=1",
    );
  });

  it("excludes source-only YAML frontmatter while preserving later definitions", () => {
    const content = ["---", "[asset]: Hidden.pdf", "---", "", "[asset]: Visible.pdf"].join("\n");
    const links = parseMarkdownLinks(content);
    expect(links.map((link) => link.target)).toEqual(["Visible.pdf"]);
    expect(links[0]?.line).toBe(5);
  });

  it("retains exact visible, opaque, and source-only definition candidates", () => {
    const content = [
      "---",
      "[hidden]: ../Assets/report.pdf",
      "---",
      "[visible]: ../Assets/report.pdf",
      "[broken]: <../Assets/report.pdf",
      "```md",
      "[ignored]: ../Assets/report.pdf",
      "```",
    ].join("\n");

    const candidates = parseMarkdownReferenceDefinitionCandidates(content);

    expect(
      candidates.map(({ label, valid, external, target, rawTarget, line, sourceOnly }) => ({
        label,
        valid,
        external,
        target,
        rawTarget,
        line,
        sourceOnly,
      })),
    ).toEqual([
      {
        label: "hidden",
        valid: true,
        external: false,
        target: "../Assets/report.pdf",
        rawTarget: "../Assets/report.pdf",
        line: 2,
        sourceOnly: true,
      },
      {
        label: "visible",
        valid: true,
        external: false,
        target: "../Assets/report.pdf",
        rawTarget: "../Assets/report.pdf",
        line: 4,
        sourceOnly: false,
      },
      {
        label: "broken",
        valid: false,
        external: false,
        target: null,
        rawTarget: " <../Assets/report.pdf",
        line: 5,
        sourceOnly: false,
      },
    ]);
    const visible = candidates[1];
    if (!visible || visible.targetStart === null || visible.targetEnd === null) {
      throw new Error("Expected an exact visible definition destination range.");
    }
    expect(content.slice(visible.targetStart, visible.targetEnd)).toBe("../Assets/report.pdf");
  });

  it("keeps code and comments out of reference-definition candidates", () => {
    const content = [
      "`[inline]: ../Assets/report.pdf`",
      "<!-- [comment]: ../Assets/report.pdf -->",
      "```md",
      "[fenced]: ../Assets/report.pdf",
      "```",
      "[visible]: ../Assets/report.pdf",
    ].join("\n");

    expect(
      parseMarkdownReferenceDefinitionCandidates(content).map((candidate) => candidate.label),
    ).toEqual(["visible"]);
  });

  it("preserves exact definition destination ranges across CR-only line endings", () => {
    const content =
      "![first image][first]\r\r[first]: ../Assets/report.pdf\r[second]: ../Assets/other.pdf";
    const candidates = parseMarkdownReferenceDefinitionCandidates(content);

    expect(
      candidates.map((candidate) => ({ label: candidate.label, line: candidate.line })),
    ).toEqual([
      { label: "first", line: 3 },
      { label: "second", line: 4 },
    ]);
    const ranges = candidates.map((candidate) => {
      if (candidate.targetStart === null || candidate.targetEnd === null) {
        throw new Error("Expected an exact definition destination range.");
      }
      return content.slice(candidate.targetStart, candidate.targetEnd);
    });
    expect(ranges).toEqual(["../Assets/report.pdf", "../Assets/other.pdf"]);
    expect(parseMarkdownReferenceUsages(content)).toEqual([
      expect.objectContaining({ label: "first", line: 1 }),
    ]);
  });

  it("uses renderer reference-block acceptance for paragraph, blockquote, and nested-list contexts", () => {
    const previewReferenceRenderer = new MarkdownIt({
      breaks: false,
      html: true,
      linkify: false,
      typographer: false,
    });
    const forms = [
      { name: "ordinary full", usage: "[visible][asset]", embed: false },
      { name: "ordinary collapsed", usage: "[asset][]", embed: false },
      { name: "ordinary shortcut", usage: "[asset]", embed: false },
      { name: "image full", usage: "![visible][asset]", embed: true },
      { name: "image collapsed", usage: "![asset][]", embed: true },
      { name: "image shortcut", usage: "![asset]", embed: true },
    ];
    const endings = ["\n", "\r\n", "\r"] as const;

    for (const ending of endings) {
      for (const form of forms) {
        const paragraphAdjacent = [form.usage, "[asset]: ../Assets/report.pdf"].join(ending);
        const targetAttribute = form.embed ? "src" : "href";
        expect(previewReferenceRenderer.render(paragraphAdjacent)).not.toContain(
          `${targetAttribute}="../Assets/report.pdf"`,
        );
        expect(parseMarkdownReferenceDefinitionCandidates(paragraphAdjacent)).toEqual([]);
        expect(parseMarkdownReferenceDefinitions(paragraphAdjacent)).toEqual([]);
        expect(parseMarkdownLinks(paragraphAdjacent)).toEqual([]);

        for (const source of [
          [`> ${form.usage}`, ">", "> [asset]: ../Assets/report.pdf"].join(ending),
          [`- > ${form.usage}`, "  >", "  > [asset]: ../Assets/report.pdf"].join(ending),
        ]) {
          expect(previewReferenceRenderer.render(source)).toContain(
            `${targetAttribute}="../Assets/report.pdf"`,
          );
          const candidates = parseMarkdownReferenceDefinitionCandidates(source);
          expect(candidates).toEqual([
            expect.objectContaining({
              label: "asset",
              valid: true,
              sourceOnly: false,
              line: 3,
            }),
          ]);
          const candidate = candidates[0];
          if (!candidate || candidate.targetStart === null || candidate.targetEnd === null) {
            throw new Error(`Expected an exact ${form.name} definition destination range.`);
          }
          expect(source.slice(candidate.targetStart, candidate.targetEnd)).toBe(
            "../Assets/report.pdf",
          );
          expect(parseMarkdownReferenceDefinitions(source)).toEqual([
            { label: "asset", valid: true, external: false, line: 3 },
          ]);
          expect(parseMarkdownLinks(source)).toEqual([
            expect.objectContaining({
              target: "../Assets/report.pdf",
              syntax: "markdown",
              sourceKind: "markdown-reference-definition",
              line: 3,
            }),
          ]);
          expect(
            parseMarkdownReferenceUsages(source).filter((usage) => usage.label === "asset"),
          ).toEqual([expect.objectContaining({ embed: form.embed, line: 1 })]);
        }
      }
    }
  });

  it("resumes reference scanning after an odd-escaped pseudo-wiki opener", () => {
    const previewReferenceRenderer = new MarkdownIt({
      breaks: false,
      html: true,
      linkify: false,
      typographer: false,
    });
    const forms = [
      { name: "ordinary full", usage: "[visible][report]", embed: false },
      { name: "ordinary collapsed", usage: "[report][]", embed: false },
      { name: "ordinary shortcut", usage: "[report]", embed: false },
      { name: "image full", usage: "![visible][report]", embed: true },
      { name: "image collapsed", usage: "![report][]", embed: true },
      { name: "image shortcut", usage: "![report]", embed: true },
    ];
    for (const form of forms) {
      const source = [`\\[[a] ${form.usage}]`, "", "[report]: ../Assets/report.pdf"].join("\n");
      const targetAttribute = form.embed ? "src" : "href";
      expect(previewReferenceRenderer.render(source)).toContain(
        `${targetAttribute}="../Assets/report.pdf"`,
      );
      expect(parseMarkdownReferenceUsages(source)).toEqual([
        expect.objectContaining({ label: "report", embed: form.embed, line: 1 }),
      ]);
    }

    const evenEscaped = ["\\\\[[a] [report]]", "", "[report]: ../Assets/report.pdf"].join("\n");
    const rawSingleBracketWiki = ["[[a] [report]tail]]", "", "[report]: ../Assets/report.pdf"].join(
      "\n",
    );
    expect(
      parseMarkdownReferenceUsages(evenEscaped).filter((usage) => usage.label === "report"),
    ).toEqual([]);
    expect(
      parseMarkdownReferenceUsages(rawSingleBracketWiki).filter(
        (usage) => usage.label === "report",
      ),
    ).toEqual([]);
    expect(parseMarkdownLinks(rawSingleBracketWiki)).toEqual([
      expect.objectContaining({ syntax: "wiki", target: "a] [report]tail" }),
      expect.objectContaining({ syntax: "markdown", target: "../Assets/report.pdf", line: 3 }),
    ]);
  });

  it("keeps CR-only frontmatter definitions source-only", () => {
    const content = "---\r[hidden]: ../Assets/report.pdf\r---\r[visible]: ../Assets/report.pdf";

    expect(
      parseMarkdownReferenceDefinitionCandidates(content).map((candidate) => ({
        label: candidate.label,
        sourceOnly: candidate.sourceOnly,
      })),
    ).toEqual([
      { label: "hidden", sourceOnly: true },
      { label: "visible", sourceOnly: false },
    ]);
    expect(parseMarkdownLinks(content).map((link) => link.target)).toEqual([
      "../Assets/report.pdf",
    ]);
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

  it("respects odd and even escape parity for ordinary and wiki link openers", () => {
    const content = [
      "\\[escaped ordinary](../Assets/report.pdf)",
      "\\[[../Assets/report.pdf]]",
      "\\![[../Assets/report.pdf]]",
      "\\\\[even ordinary](../Assets/report.pdf)",
      "\\\\[[../Assets/report.pdf]]",
      "\\\\![[../Assets/report.pdf]]",
    ].join("\n");

    expect(
      parseMarkdownLinks(content).map((link) => ({ target: link.target, embed: link.embed })),
    ).toEqual([
      { target: "../Assets/report.pdf", embed: false },
      { target: "../Assets/report.pdf", embed: false },
      { target: "../Assets/report.pdf", embed: false },
      { target: "../Assets/report.pdf", embed: true },
    ]);
  });

  it("finds visible full, collapsed, and shortcut image references without frontmatter definitions", () => {
    const content = [
      "---",
      "[asset]: Hidden.pdf",
      "---",
      "![full][asset] ![collapsed][] ![shortcut]",
      "",
      "[asset]: Visible.pdf",
    ].join("\n");
    expect(parseMarkdownReferenceUsages(content).map((usage) => usage.label)).toEqual([
      "asset",
      "collapsed",
      "shortcut",
    ]);
    expect(parseMarkdownReferenceDefinitions(content)).toEqual([
      { label: "asset", valid: true, external: false, line: 6 },
    ]);
  });

  it("finds ordinary and image full, collapsed, and shortcut references while excluding dormant syntax", () => {
    const content = [
      "---",
      "[frontmatter]: Hidden.pdf",
      "---",
      "[ordinary full][asset] [ordinary collapsed][] [ordinary shortcut]",
      "![image full][image] ![image collapsed][] ![image shortcut]",
      "[inline](Visible.pdf) [definition]: Visible.pdf",
      "\\[escaped ordinary] \\![escaped image] [[wiki]] ![[wiki embed]]",
      "`[inline code][code]` <!-- [comment][comment] -->",
      "```md",
      "[fenced][fenced]",
      "```",
    ].join("\n");

    expect(parseMarkdownReferenceUsages(content)).toEqual([
      expect.objectContaining({ label: "asset", embed: false, line: 4 }),
      expect.objectContaining({ label: "ordinary collapsed", embed: false, line: 4 }),
      expect.objectContaining({ label: "ordinary shortcut", embed: false, line: 4 }),
      expect.objectContaining({ label: "image", embed: true, line: 5 }),
      expect.objectContaining({ label: "image collapsed", embed: true, line: 5 }),
      expect.objectContaining({ label: "image shortcut", embed: true, line: 5 }),
      expect.objectContaining({ label: "definition", embed: false, line: 6 }),
      expect.objectContaining({ label: "escaped image", embed: false, line: 7 }),
    ]);
  });

  it("does not scan reference labels inside inline destinations, titles, or nested inline labels", () => {
    const content = [
      '[external](https://example.test "literal [report] title")',
      "[other [report]](https://example.test)",
      "",
      '[external definition]: https://example.test "literal [report] title"',
      '[local definition]: ../Assets/Other/local.pdf "literal [report] title"',
      "[report]: ../Assets/report.pdf",
    ].join("\r\n");

    expect(parseMarkdownReferenceUsages(content)).toEqual([]);
  });

  it("retains source-like labels in malformed inline text while retaining a separate later reference", () => {
    const content = [
      '[external](https://example.test "unclosed [report]) [real][asset]',
      "",
      "[report]: ../Assets/report.pdf",
      "[asset]: ../Assets/other.pdf",
    ].join("\n");

    expect(parseMarkdownReferenceUsages(content)).toEqual([
      expect.objectContaining({ label: "report", embed: false, line: 1 }),
      expect.objectContaining({ label: "asset", embed: false, line: 1 }),
    ]);
  });

  it("keeps a mid-prose colon shortcut visible while skipping a valid line-leading definition", () => {
    const content = ["Text [report]: later", "", "[report]: ../Assets/report.pdf"].join("\n");

    expect(parseMarkdownReferenceUsages(content)).toEqual([
      expect.objectContaining({ label: "report", embed: false, line: 1 }),
    ]);
  });

  it("requires immediate delimiters for inline and full reference forms", () => {
    const content = [
      "[report] (../Assets/other.pdf)",
      "[visible] [asset]",
      "",
      "[report]: ../Assets/report.pdf",
      "[asset]: ../Assets/asset.pdf",
    ].join("\n");

    expect(parseMarkdownReferenceUsages(content).map((usage) => usage.label)).toEqual([
      "report",
      "visible",
      "asset",
    ]);
  });

  it("treats an image shortcut followed by a colon as a visible image reference", () => {
    const content = ["![report]: ../Assets/other.pdf", "", "[report]: ../Assets/report.pdf"].join(
      "\n",
    );

    expect(parseMarkdownReferenceUsages(content)).toEqual([
      expect.objectContaining({ label: "report", embed: true, line: 1 }),
    ]);
    expect(parseMarkdownReferenceDefinitions(content)).toEqual([
      { label: "report", valid: true, external: false, line: 3 },
    ]);
  });

  it("keeps a malformed line-leading definition label visible as a shortcut", () => {
    const content = ["[report]: <unterminated", "", "[report]: ../Assets/report.pdf"].join("\n");

    expect(parseMarkdownReferenceUsages(content)).toEqual([
      expect.objectContaining({ label: "report", embed: false, line: 1 }),
    ]);
  });

  it("retains a multiline definition continuation as opaque source evidence", () => {
    const content = ["[x][asset]", "", "[asset]:", "  ../Assets/report.pdf"].join("\n");

    expect(parseMarkdownReferenceDefinitionCandidates(content)).toEqual([
      expect.objectContaining({
        label: "asset",
        valid: false,
        rawTarget: "\n  ../Assets/report.pdf",
        targetStart: null,
        targetEnd: null,
      }),
    ]);
    expect(parseMarkdownReferenceUsages(content)).toEqual([
      expect.objectContaining({ label: "asset", embed: false, line: 1 }),
    ]);
  });

  it("uses flat labels for shortcuts while allowing nested inline text in full references", () => {
    const content = [
      "[outer [report]]",
      "[outer [report]][]",
      "[outer [inside]][asset]",
      "",
      "[report]: ../Assets/report.pdf",
      "[asset]: ../Assets/asset.pdf",
    ].join("\n");

    expect(parseMarkdownReferenceUsages(content).map((usage) => usage.label)).toEqual([
      "report",
      "report",
      "asset",
    ]);
  });

  it("keeps brackets inside autolinks and raw HTML tags opaque", () => {
    const content = [
      "<https://example.test/[report]>",
      '<span data-x="[report]">',
      "",
      "[report]: ../Assets/report.pdf",
    ].join("\r\n");

    expect(parseMarkdownReferenceUsages(content)).toEqual([]);
    expect(
      parseMarkdownLinks(
        [
          "<https://example.test/[report](../Assets/report.pdf)>",
          '<span data-x="[report](../Assets/report.pdf)">x</span>',
        ].join("\r\n"),
      ),
    ).toEqual([]);
  });

  it("keeps indented code and raw HTML blocks out of link and reference scans", () => {
    const indentedCode = [
      "    [direct](../Assets/report.pdf)",
      "\t![image](../Assets/report.pdf)",
    ].join("\n");
    const htmlBlock = ["<div>", "[direct](../Assets/report.pdf)", "[report]", "</div>"].join("\n");
    const htmlBlockReferences = [
      "<div>",
      "[report]",
      "</div>",
      "",
      "[report]: ../Assets/report.pdf",
    ].join("\n");

    expect(parseMarkdownLinks(indentedCode)).toEqual([]);
    expect(parseMarkdownLinks(htmlBlock)).toEqual([]);
    expect(parseMarkdownReferenceUsages(htmlBlockReferences)).toEqual([]);
  });

  it("uses renderer block boundaries for HTML and indented-code opacity", () => {
    const typeSixHtmlBlock = [
      "<div>",
      "</div>",
      "[still raw](../Assets/report.pdf)",
      "",
      "[visible](Visible.md)",
    ].join("\n");
    const typeOneHtmlBlocks = ["script", "style", "pre", "textarea"].map((tag) =>
      [
        `<${tag.toLocaleUpperCase("en-US")}>`,
        `[${tag} raw](../Assets/report.pdf)`,
        `[${tag}-reference]`,
        `</${tag}>`,
        "[visible](Visible.md)",
      ].join("\r\n"),
    );
    const paragraphContinuation = [
      "paragraph",
      "    [visible continuation](../Assets/report.pdf)",
    ].join("\n");
    const listContinuation = [
      "- item",
      "    [visible list continuation](../Assets/report.pdf)",
    ].join("\n");
    const leadingCommentBlock = [
      "<!-- hidden --> [still raw](../Assets/report.pdf)",
      "[visible](Visible.md)",
    ].join("\n");

    expect(parseMarkdownLinks(typeSixHtmlBlock).map((link) => link.target)).toEqual(["Visible.md"]);
    for (const typeOneHtmlBlock of typeOneHtmlBlocks) {
      expect(parseMarkdownLinks(typeOneHtmlBlock).map((link) => link.target)).toEqual([
        "Visible.md",
      ]);
      expect(parseMarkdownReferenceUsages(typeOneHtmlBlock)).toEqual([]);
    }
    expect(parseMarkdownLinks(paragraphContinuation).map((link) => link.target)).toEqual([
      "../Assets/report.pdf",
    ]);
    expect(parseMarkdownLinks(listContinuation).map((link) => link.target)).toEqual([
      "../Assets/report.pdf",
    ]);
    expect(parseMarkdownLinks(leadingCommentBlock).map((link) => link.target)).toEqual([
      "Visible.md",
    ]);
  });

  it("keeps recognized wiki bodies opaque to generic reference scanning", () => {
    const content = [
      "[[Assets/report[.pdf]]",
      "[[Target|alias[report]]]",
      "",
      "[report]: ../Assets/report.pdf",
    ].join("\n");

    expect(parseMarkdownReferenceUsages(content)).toEqual([]);
  });

  it("uses first-close wiki spans with raw single brackets and keeps them opaque to references", () => {
    const content = [
      "[[../Assets/report]draft.pdf#section|alias [report] title]]",
      "",
      "[report]: ../Assets/report.pdf",
    ].join("\n");

    const wiki = parseMarkdownLinks(content).find((link) => link.syntax === "wiki");
    if (!wiki) throw new Error("Expected a wiki link with raw single bracket bytes.");
    expect(wiki).toMatchObject({
      target: "../Assets/report]draft.pdf",
      subpath: "#section",
      alias: "alias [report] title",
      embed: false,
      line: 1,
    });
    expect(content.slice(wiki.position, wiki.end)).toBe(
      "[[../Assets/report]draft.pdf#section|alias [report] title]]",
    );
    expect(content.slice(wiki.targetStart, wiki.targetEnd)).toBe("../Assets/report]draft.pdf");
    expect(parseMarkdownReferenceUsages(content)).toEqual([]);
  });

  it("masks trimmed renderer math blocks without changing source line endings", () => {
    for (const ending of ["\n", "\r", "\r\n"] as const) {
      const content = [
        "  $$  ",
        "[direct](../Assets/report.pdf)",
        "![[../Assets/report.pdf]]",
        "[report]",
        "\t$$",
        "  \\[  ",
        "[second](../Assets/report.pdf)",
        "![[../Assets/report.pdf]]",
        "[report]",
        "\\]  ",
        "[outside](Visible.pdf)",
      ].join(ending);
      const masked = maskMarkdownCodeAndComments(content);

      expect(masked).toHaveLength(content.length);
      expect(masked.replace(/[^\r\n]/gu, "")).toBe(content.replace(/[^\r\n]/gu, ""));
      expect(parseMarkdownLinks(content).map((link) => link.target)).toEqual(["Visible.pdf"]);
      expect(parseMarkdownReferenceUsages(content)).toEqual([]);
    }
  });

  it("leaves unmatched and over-bound math delimiters visible", () => {
    const unmatched = [
      "\\[",
      "[unmatched](../Assets/report.pdf)",
      "![[../Assets/report.pdf]]",
      "[report]",
    ].join("\n");
    const atBoundary = [
      "$$",
      "[hidden-at-boundary](../Assets/report.pdf)",
      ...Array.from({ length: 254 }, () => "padding"),
      "$$",
    ].join("\r");
    const overBound = [
      "$$",
      "[visible-over-bound](../Assets/report.pdf)",
      "[report]",
      ...Array.from({ length: 254 }, () => "padding"),
      "$$",
    ].join("\r\n");

    expect(parseMarkdownLinks(unmatched).map((link) => link.target)).toEqual([
      "../Assets/report.pdf",
      "../Assets/report.pdf",
    ]);
    expect(parseMarkdownReferenceUsages(unmatched)).toEqual([
      expect.objectContaining({ label: "report", line: 4 }),
    ]);
    expect(parseMarkdownLinks(atBoundary)).toEqual([]);
    expect(parseMarkdownLinks(overBound).map((link) => link.target)).toEqual([
      "../Assets/report.pdf",
    ]);
    expect(parseMarkdownReferenceUsages(overBound)).toEqual([
      expect.objectContaining({ label: "report", line: 3 }),
    ]);
  });

  it("uses renderer math block boundaries inside blockquotes and nested list blockquotes", () => {
    const sources = [
      [
        "> $$",
        "> [direct](../Assets/report.pdf)",
        "> ![[../Assets/report.pdf]]",
        "> [report]",
        "> $$",
        "[outside](Visible.md)",
      ].join("\n"),
      [
        "- > $$",
        "  > [direct](../Assets/report.pdf)",
        "  > ![[../Assets/report.pdf]]",
        "  > [report]",
        "  > $$",
        "[outside](Visible.md)",
      ].join("\r\n"),
    ];

    for (const source of sources) {
      expect(parseMarkdownLinks(source).map((link) => link.target)).toEqual(["Visible.md"]);
      expect(parseMarkdownReferenceUsages(source)).toEqual([]);
    }
  });

  it("does not parse an inline-looking source target inside a valid external definition title", () => {
    const content =
      '[external]: https://example.test "literal [report](../Assets/report.pdf) and ![[../Assets/report.pdf]]"';

    expect(parseMarkdownLinks(content)).toEqual([]);
  });

  it("preserves UTF-16 offsets through astral opaque regions before visible definitions", () => {
    const endings = ["\n", "\r\n", "\r"] as const;
    const opaqueBlocks = [
      {
        name: "frontmatter",
        source: (ending: string) => `\uFEFF---${ending}title: 😀${ending}---`,
      },
      {
        name: "fenced code",
        source: (ending: string) => ["```md", "😀 [hidden](Hidden.pdf)", "```"].join(ending),
      },
      {
        name: "indented code",
        source: () => "    😀 [hidden](Hidden.pdf)",
      },
      {
        name: "inline code",
        source: () => "`😀 [hidden](Hidden.pdf)`",
      },
      {
        name: "HTML comment",
        source: () => "<!-- 😀 [hidden](Hidden.pdf) -->",
      },
      {
        name: "HTML block",
        source: (ending: string) => ["<div>", "😀 [hidden](Hidden.pdf)", "</div>"].join(ending),
      },
      {
        name: "raw-text HTML block",
        source: (ending: string) =>
          ["<script>", 'const hidden = "😀 [hidden](Hidden.pdf)";', "</script>"].join(ending),
      },
      {
        name: "math block",
        source: (ending: string) => ["$$", "😀 [hidden](Hidden.pdf)", "$$"].join(ending),
      },
    ];

    for (const ending of endings) {
      for (const opaque of opaqueBlocks) {
        const content = [
          opaque.source(ending),
          "",
          "[visible][asset]",
          "",
          '[asset]: ../Assets/report.pdf "keep title"',
        ].join(ending);
        const expectedUsageLine = opaque.source(ending).split(/\r\n|\r|\n/).length + 2;
        const before = content;
        const masked = maskMarkdownCodeAndComments(content);

        expect(masked, `${opaque.name} ${JSON.stringify(ending)}`).toHaveLength(content.length);
        expect(masked.match(/\r\n|\r|\n/g)).toEqual(content.match(/\r\n|\r|\n/g));
        const definitions = parseMarkdownReferenceDefinitionCandidates(content);
        const definition = definitions.find((candidate) => candidate.label === "asset");
        expect(definition).toEqual(
          expect.objectContaining({
            valid: true,
            target: "../Assets/report.pdf",
            targetStart: expect.any(Number),
            targetEnd: expect.any(Number),
          }),
        );
        if (!definition || definition.targetStart === null || definition.targetEnd === null) {
          throw new Error("Expected an exact visible definition range.");
        }
        expect(content.slice(definition.targetStart, definition.targetEnd)).toBe(
          "../Assets/report.pdf",
        );
        expect(parseMarkdownLinks(content).map((link) => link.target)).toEqual([
          "../Assets/report.pdf",
        ]);
        expect(parseMarkdownReferenceUsages(content)).toEqual([
          expect.objectContaining({ label: "asset", line: expectedUsageLine }),
        ]);
        expect(content).toBe(before);
      }
    }
  });

  it("maps renderer-live hard-wrapped reference usages across forms, containers, and endings", () => {
    const renderer = new MarkdownIt({
      breaks: false,
      html: true,
      linkify: false,
      typographer: false,
    });
    const forms = [
      { name: "ordinary full", lines: ["[visible alias][asset", "]"], embed: false },
      { name: "ordinary collapsed", lines: ["[asset", "][]"], embed: false },
      { name: "ordinary shortcut", lines: ["[asset", "]"], embed: false },
      { name: "image full", lines: ["![image alt][asset", "]"], embed: true },
      { name: "image collapsed", lines: ["![asset", "][]"], embed: true },
      { name: "image shortcut", lines: ["![asset", "]"], embed: true },
    ];
    const contexts = [
      {
        name: "top-level",
        lines: (usage: readonly string[]) => [...usage, "", "[asset]: ../Assets/report.pdf"],
      },
      {
        name: "blockquote",
        lines: (usage: readonly string[]) => [
          ...usage.map((line) => `> ${line}`),
          ">",
          "> [asset]: ../Assets/report.pdf",
        ],
      },
      {
        name: "nested-list-blockquote",
        lines: (usage: readonly string[]) => [
          `- > ${usage[0] ?? ""}`,
          ...usage.slice(1).map((line) => `  > ${line}`),
          "  >",
          "  > [asset]: ../Assets/report.pdf",
        ],
      },
    ];

    for (const ending of ["\n", "\r\n", "\r"] as const) {
      for (const context of contexts) {
        for (const form of forms) {
          const source = context.lines(form.lines).join(ending);
          const targetAttribute = form.embed ? "src" : "href";
          const label = `${context.name} ${form.name} ${JSON.stringify(ending)}`;

          expect(renderer.render(source), label).toContain(
            `${targetAttribute}="../Assets/report.pdf"`,
          );
          const usages = parseMarkdownReferenceUsages(source);
          expect(usages, label).toEqual([
            expect.objectContaining({ label: "asset", embed: form.embed, line: 1 }),
          ]);
          const usage = usages[0];
          if (!usage?.sourceRanges || !usage.labelSourceRanges) {
            throw new Error(`Expected source-mapped renderer usage for ${label}.`);
          }
          expect(
            usage.sourceRanges.map((range) => source.slice(range.start, range.end)).join("\n"),
            label,
          ).toBe(form.lines.join("\n"));
          expect(
            usage.labelSourceRanges
              .map((range) => source.slice(range.start, range.end))
              .join("\n")
              .replace(/\s+/gu, " ")
              .trim(),
            label,
          ).toBe("asset");
          expect(usage.sourceMappable, label).toBe(true);
          expect(parseMarkdownLinks(source), label).toEqual([
            expect.objectContaining({
              target: "../Assets/report.pdf",
              syntax: "markdown",
              sourceKind: "markdown-reference-definition",
            }),
          ]);
        }
      }
    }
  });

  it("keeps odd-escaped and opaque hard-wrapped reference lookalikes out of renderer usage mapping", () => {
    const cases = [
      ["\\[asset", "][]", "", "[asset]: ../Assets/report.pdf"].join("\n"),
      ["[[asset]]", "continued paragraph", "", "[asset]: ../Assets/report.pdf"].join("\n"),
      ["![[asset]]", "continued paragraph", "", "[asset]: ../Assets/report.pdf"].join("\n"),
      ["\\![[asset]]", "continued paragraph", "", "[asset]: ../Assets/report.pdf"].join("\n"),
      ["[[a] [asset] tail]]", "continued paragraph", "", "[asset]: ../Assets/report.pdf"].join(
        "\n",
      ),
      ["    [asset", "    ][]", "", "[asset]: ../Assets/report.pdf"].join("\r\n"),
      ["<div>", "[asset", "][]", "</div>", "", "[asset]: ../Assets/report.pdf"].join("\r"),
      ["<!--", "[asset", "][]", "-->", "", "[asset]: ../Assets/report.pdf"].join("\n"),
      ["$$", "[asset", "][]", "$$", "", "[asset]: ../Assets/report.pdf"].join("\n"),
    ];

    for (const source of cases) {
      expect(parseMarkdownReferenceUsages(source)).toEqual([]);
    }
  });

  it("fails closed when renderer token order cannot be mapped to logical source evidence", () => {
    const source = ["\\[[asset]] [asset", "][]", "", "[asset]: ../Assets/report.pdf"].join("\n");

    expect(parseMarkdownReferenceUsages(source)).toEqual([
      expect.objectContaining({ label: "asset", embed: false, sourceMappable: false, line: 1 }),
      expect.objectContaining({ label: "asset", embed: false, sourceMappable: false, line: 1 }),
    ]);
  });

  it("keeps renderer-visible unmatched wiki-prefix references as unmappable evidence", () => {
    const renderer = new MarkdownIt({
      breaks: false,
      html: true,
      linkify: false,
      typographer: false,
    });
    const target = "../Assets/report.pdf";
    const layouts = [
      {
        name: "top-level",
        source: (usage: readonly string[], definition: string) => [...usage, "", definition],
      },
      {
        name: "blockquote",
        source: (usage: readonly string[], definition: string) => [
          ...usage.map((line) => `> ${line}`),
          ">",
          `> ${definition}`,
        ],
      },
      {
        name: "nested-list-blockquote",
        source: (usage: readonly string[], definition: string) => [
          `- > ${usage[0] ?? ""}`,
          ...usage.slice(1).map((line) => `  > ${line}`),
          "  >",
          `  > ${definition}`,
        ],
      },
    ];
    const minimalForms = [
      { name: "ordinary", lines: ["[[asset", "]"] },
      { name: "bang", lines: ["![[asset", "]"] },
    ];

    for (const ending of ["\n", "\r\n", "\r"] as const) {
      for (const layout of layouts) {
        for (const form of minimalForms) {
          const source = layout.source(form.lines, `[asset]: ${target}`).join(ending);
          const label = `${layout.name} ${form.name} ${JSON.stringify(ending)}`;
          expect(renderer.render(source), label).toContain(`href="${target}"`);
          const unmappable = parseMarkdownReferenceUsages(source).filter(
            (usage) => usage.sourceMappable === false,
          );
          expect(unmappable, label).toEqual([
            expect.objectContaining({ label: "asset", embed: false, line: 1 }),
          ]);
          for (const usage of unmappable) {
            expect(usage.sourceRanges, label).toBeUndefined();
            expect(usage.labelSourceRanges, label).toBeUndefined();
          }
        }
      }
    }

    const longLabel = "a".repeat(999);
    const edgeCases = [
      {
        name: "one-backslash escaped opener",
        lines: ["\\[[asset]]"],
        definitionLabel: "asset",
        label: "asset",
        expected: 1,
      },
      {
        name: "whitespace and case",
        lines: ["[[ \t ASSET ", "]"],
        definitionLabel: " aSsEt ",
        label: "asset",
        expected: 1,
      },
      {
        name: "escaped label close",
        lines: ["[[asset\\]", "]"],
        definitionLabel: "asset\\]",
        label: "asset]",
        expected: 1,
      },
      {
        name: "collapsed close",
        lines: ["[[asset", "][]"],
        definitionLabel: "asset",
        label: "asset",
        expected: 1,
      },
      {
        name: "extra close",
        lines: ["[[asset", "]]"],
        definitionLabel: "asset",
        label: "asset",
        expected: 1,
      },
      {
        name: "999-character label",
        lines: [`[[${longLabel}`, "]"],
        definitionLabel: longLabel,
        label: longLabel,
        expected: 1,
      },
      {
        name: "mixed ordinary and bang events",
        lines: ["[[asset", "] ![[asset", "]"],
        definitionLabel: "asset",
        label: "asset",
        expected: 2,
      },
    ];

    for (const edgeCase of edgeCases) {
      const source = [...edgeCase.lines, "", `[${edgeCase.definitionLabel}]: ${target}`].join("\n");
      expect(renderer.render(source), edgeCase.name).toContain(`href="${target}"`);
      const unmappable = parseMarkdownReferenceUsages(source).filter(
        (usage) => usage.sourceMappable === false,
      );
      expect(unmappable, edgeCase.name).toHaveLength(edgeCase.expected);
      for (const usage of unmappable) {
        expect(usage, edgeCase.name).toEqual(
          expect.objectContaining({ label: edgeCase.label, embed: false, line: 1 }),
        );
        expect(usage.sourceRanges, edgeCase.name).toBeUndefined();
        expect(usage.labelSourceRanges, edgeCase.name).toBeUndefined();
      }
    }

    const ordinaryReference = ["[missing] [asset]", "", `[asset]: ${target}`].join("\n");
    expect(renderer.render(ordinaryReference)).toContain(`href="${target}"`);
    expect(
      parseMarkdownReferenceUsages(ordinaryReference).filter(
        (usage) => usage.sourceMappable === false,
      ),
    ).toEqual([]);

    for (const control of ["[[asset]]", "![[asset]]", "\\\\[[asset]]", "\\\\![[asset]]"]) {
      const source = [control, "", `[asset]: ${target}`].join("\n");
      expect(parseMarkdownReferenceUsages(source), control).toEqual([]);
      expect(parseMarkdownLinks(source), control).toEqual(
        expect.arrayContaining([expect.objectContaining({ sourceKind: "wiki" })]),
      );
    }
  });

  it("maps renderer-live wrapped reference labels when their target shares the definition segment", () => {
    const renderer = new MarkdownIt({
      breaks: false,
      html: true,
      linkify: false,
      typographer: false,
    });
    const forms = [
      { name: "ordinary full", usage: "[visible][asset]", embed: false },
      { name: "ordinary collapsed", usage: "[asset][]", embed: false },
      { name: "ordinary shortcut", usage: "[asset]", embed: false },
      { name: "image full", usage: "![visible][asset]", embed: true },
      { name: "image collapsed", usage: "![asset][]", embed: true },
      { name: "image shortcut", usage: "![asset]", embed: true },
    ];
    const contexts = [
      {
        name: "top-level",
        lines: (usage: string) => [usage, "", "[asset", ']: ../Assets/report.pdf "title"'],
      },
      {
        name: "blockquote",
        lines: (usage: string) => [
          `> ${usage}`,
          ">",
          "> [asset",
          '> ]: ../Assets/report.pdf "title"',
        ],
      },
      {
        name: "nested list blockquote",
        lines: (usage: string) => [
          `- > ${usage}`,
          "  >",
          "  > [asset",
          '  > ]: ../Assets/report.pdf "title"',
        ],
      },
    ];

    for (const ending of ["\n", "\r\n", "\r"] as const) {
      for (const context of contexts) {
        for (const form of forms) {
          const source = context.lines(form.usage).join(ending);
          const targetAttribute = form.embed ? "src" : "href";
          expect(
            renderer.render(source),
            `${context.name} ${form.name} ${JSON.stringify(ending)}`,
          ).toContain(`${targetAttribute}="../Assets/report.pdf"`);

          const candidates = parseMarkdownReferenceDefinitionCandidates(source);
          expect(candidates).toEqual([
            expect.objectContaining({
              label: "asset",
              valid: true,
              target: "../Assets/report.pdf",
              sourceOnly: false,
              targetStart: expect.any(Number),
              targetEnd: expect.any(Number),
            }),
          ]);
          const candidate = candidates[0];
          if (!candidate || candidate.targetStart === null || candidate.targetEnd === null) {
            throw new Error("Expected a mapped wrapped-label destination range.");
          }
          expect(source.slice(candidate.targetStart, candidate.targetEnd)).toBe(
            "../Assets/report.pdf",
          );
          expect(source.slice(candidate.targetEnd)).toContain(' "title"');
          expect(parseMarkdownLinks(source)).toEqual([
            expect.objectContaining({
              target: "../Assets/report.pdf",
              syntax: "markdown",
              line: 3,
            }),
          ]);
          expect(parseMarkdownReferenceUsages(source)).toEqual([
            expect.objectContaining({ label: "asset", embed: form.embed, line: 1 }),
          ]);
        }
      }
    }
  });

  it("keeps title continuations inside the renderer-derived link span", () => {
    const contexts = [
      {
        name: "top-level",
        lines: () => ["[visible][asset]", "", "[asset]: ../Assets/report.pdf", '  "keep title"'],
      },
      {
        name: "blockquote",
        lines: () => [
          "> [visible][asset]",
          ">",
          "> [asset]: ../Assets/report.pdf",
          '>   "keep title"',
        ],
      },
      {
        name: "nested list blockquote",
        lines: () => [
          "- > [visible][asset]",
          "  >",
          "  > [asset]: ../Assets/report.pdf",
          '  >   "keep title"',
        ],
      },
    ];

    for (const ending of ["\n", "\r\n", "\r"] as const) {
      for (const context of contexts) {
        const source = context.lines().join(ending);
        const links = parseMarkdownLinks(source);
        const link = links[0];
        if (!link) throw new Error("Expected a renderer-derived title continuation link.");
        expect(link.target).toBe("../Assets/report.pdf");
        expect(
          source.slice(link.position, link.end),
          `${context.name} ${JSON.stringify(ending)}`,
        ).toMatch(/"keep title"$/u);
      }
    }
  });

  it("retains a renderer-live wrapped external definition without emitting a local link", () => {
    const renderer = new MarkdownIt({
      breaks: false,
      html: true,
      linkify: false,
      typographer: false,
    });
    const source = [
      "[visible][asset]",
      "",
      "[asset",
      ']: https://example.test/report.pdf "external"',
    ].join("\n");

    expect(renderer.render(source)).toContain('href="https://example.test/report.pdf"');
    expect(parseMarkdownReferenceDefinitionCandidates(source)).toEqual([
      expect.objectContaining({
        label: "asset",
        valid: true,
        external: true,
        target: "https://example.test/report.pdf",
      }),
    ]);
    expect(parseMarkdownLinks(source)).toEqual([]);
  });

  it("matches the renderer frontmatter boundary for trimmed markers and the 256-line fallback", () => {
    for (const ending of ["\n", "\r\n", "\r"] as const) {
      for (const [opener, closer] of [
        ["\uFEFF \t--- \t", "\t...\t"],
        ["---", "    ---"],
      ]) {
        const source = [
          opener,
          "[hidden]: ../Assets/report.pdf",
          closer,
          "[visible](../Assets/report.pdf)",
        ].join(ending);
        expect(parseMarkdownReferenceDefinitionCandidates(source)).toEqual([
          expect.objectContaining({ label: "hidden", sourceOnly: true }),
        ]);
        expect(parseMarkdownLinks(source).map((link) => link.target)).toEqual([
          "../Assets/report.pdf",
        ]);
      }

      const resolvedAtLine256 = [
        "---",
        ...Array.from({ length: 254 }, (_, index) => `padding-${index}`),
        "\t...\t",
        "[visible](../Assets/report.pdf)",
      ].join(ending);
      expect(parseMarkdownLinks(resolvedAtLine256).map((link) => link.target)).toEqual([
        "../Assets/report.pdf",
      ]);

      const unresolvedAtLine257 = [
        "---",
        ...Array.from({ length: 254 }, (_, index) => `padding-${index}`),
        "[asset]: ../Assets/report.pdf",
        "...",
        "[visible][asset]",
      ].join(ending);
      expect(parseMarkdownReferenceDefinitionCandidates(unresolvedAtLine257)).toEqual([
        expect.objectContaining({ label: "asset", sourceOnly: true }),
      ]);
      expect(parseMarkdownLinks(unresolvedAtLine257)).toEqual([]);
      expect(parseMarkdownReferenceUsages(unresolvedAtLine257)).toEqual([]);
    }
  });
});
