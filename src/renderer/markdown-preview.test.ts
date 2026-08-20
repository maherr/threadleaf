// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type {
  VaultAttachmentResponse,
  VaultImageResponse,
  VaultNoteEmbedResponse,
  WorkspaceLinkSummary,
} from "../shared/contracts";
import {
  addPreviewSourceControls,
  hydrateMarkdownPreview,
  hydrateMarkdownPreviewAttachments,
  hydrateMarkdownPreviewImages,
  renderMarkdownPreview,
  sanitizeDataviewProjection,
  sanitizePluginMarkdownProjection,
} from "./markdown-preview";

function preview(source: string): HTMLElement {
  const container = document.createElement("div");
  container.append(addPreviewSourceControls(renderMarkdownPreview(source)));
  return container;
}

function readyEmbed(
  path: string,
  content: string,
  options: {
    startLine?: number;
    endLine?: number;
    kind?: "note" | "heading" | "block";
    subpath?: string | null;
    links?: WorkspaceLinkSummary[];
    contentBytes?: number;
  } = {},
): VaultNoteEmbedResponse {
  return {
    status: "ready",
    vaultId: "vault-a",
    path,
    revision: "e".repeat(64),
    sourceSize: Buffer.byteLength(content),
    contentBytes: options.contentBytes ?? Buffer.byteLength(content),
    content,
    startLine: options.startLine ?? 1,
    endLine: options.endLine ?? Math.max(1, content.split("\n").length),
    kind: options.kind ?? "note",
    subpath: options.subpath ?? null,
    links: options.links ?? [],
  };
}

const unavailableImage = async (): Promise<VaultImageResponse> => ({
  status: "unavailable",
  vaultId: "vault-a",
  reason: "missing",
  message: "No image fixture was provided.",
});

describe("Markdown reading view", () => {
  it("renders unambiguous footnotes with local backreferences and source provenance", () => {
    const source = [
      "A claim with a note.[^source] A second reference.[^source]",
      "",
      "[^source]: The footnote **stays offline** and keeps its source line.",
    ].join("\n");
    const rendered = preview(source);
    const section = rendered.querySelector<HTMLElement>(".preview-footnotes");
    expect(section?.textContent).toContain("The footnote stays offline");
    expect(section?.closest<HTMLElement>(".preview-block")?.dataset.sourceLine).toBe("3");
    expect(rendered.querySelectorAll(".preview-footnote-ref")).toHaveLength(2);
    expect(rendered.querySelectorAll(".preview-footnote-backref")).toHaveLength(2);
    expect(rendered.querySelector(".preview-footnote-content strong")?.textContent).toBe(
      "stays offline",
    );
    expect(rendered.textContent).not.toContain("[^source]:");
    expect(rendered.querySelector(".preview-footnote-ref a")?.getAttribute("href")).toMatch(
      /^#threadleaf-footnote-/u,
    );
  });

  it("keeps duplicate or unknown footnotes as exact visible source", () => {
    const source = [
      "Unknown [^missing] and duplicate [^dup].",
      "",
      "[^dup]: first definition",
      "[^dup]: second definition",
    ].join("\n");
    const rendered = preview(source);
    expect(rendered.querySelector(".preview-footnotes")).toBeNull();
    expect(rendered.textContent).toContain("[^missing]");
    expect(rendered.textContent).toContain("[^dup]: first definition");
    expect(rendered.textContent).toContain("[^dup]: second definition");
  });

  it("does not turn mismatched fenced code into a rendered footnote", () => {
    const source = ["~~~", "```", "[^inside]: This remains code, not a definition."].join("\n");
    const rendered = preview(source);

    expect(rendered.querySelector(".preview-footnotes")).toBeNull();
    expect(rendered.querySelector("pre code")?.textContent).toContain(
      "[^inside]: This remains code, not a definition.",
    );
  });

  it("renders supported offline math and leaves unknown commands source-visible", () => {
    const rendered = preview(
      [
        "Inline \\(x^2 + \\frac{1}{2}\\) and $\\alpha + \\sqrt{x}$.",
        "",
        "$$",
        "\\sum_{i=1}^{n} i",
        "$$",
        "",
        "Unsupported $\\notARealCommand{x}$ stays source.",
      ].join("\n"),
    );
    expect(rendered.querySelectorAll(".preview-math")).toHaveLength(2);
    expect(rendered.querySelector(".preview-math .math-fraction")).not.toBeNull();
    expect(rendered.querySelector(".preview-math .math-sqrt")).not.toBeNull();
    expect(rendered.querySelector(".preview-math-block .math-script")).not.toBeNull();
    expect(rendered.querySelector(".preview-math-block")?.textContent).toContain("∑");
    expect(rendered.textContent).toContain("$\\notARealCommand{x}$");
    expect(rendered.innerHTML).not.toContain("<script");
  });

  it("renders rejected math and malformed footnote source literally", () => {
    const rejectedMath = preview(String.raw`$\notARealCommand{*em* <strong>html</strong>}$`);
    expect(rejectedMath.querySelector("em")).toBeNull();
    expect(rejectedMath.querySelector("strong")).toBeNull();
    expect(rejectedMath.textContent).toContain(
      String.raw`$\notARealCommand{*em* <strong>html</strong>}$`,
    );

    const malformedSource =
      "[^bad id]: <strong>formatted</strong> and *emphasized* <script>bad()</script> $x$\n    continuation";
    const malformedFootnote = preview(malformedSource);
    expect(malformedFootnote.querySelector("strong")).toBeNull();
    expect(malformedFootnote.querySelector("em")).toBeNull();
    expect(malformedFootnote.querySelector("script")).toBeNull();
    expect(malformedFootnote.textContent).toContain(
      "[^bad id]: <strong>formatted</strong> and *emphasized* <script>bad()</script> $x$",
    );
    expect(malformedFootnote.querySelector("[data-source-line='1']")?.textContent).toContain(
      "[^bad id]: <strong>formatted</strong>",
    );
  });

  it("keeps malformed display math source-visible", () => {
    const source = ["$$", "\\notARealCommand{*em* <strong>html</strong>}", "$$"].join("\n");
    const rendered = preview(source);
    expect(rendered.querySelector(".preview-math-block")).toBeNull();
    expect(rendered.querySelector("em")).toBeNull();
    expect(rendered.querySelector("strong")).toBeNull();
    expect(rendered.textContent).toContain("$$");
    expect(rendered.textContent).toContain("\\notARealCommand{*em* <strong>html</strong>}");
    expect(
      rendered.querySelector(".preview-block[data-source-line='1'] .preview-source-fallback"),
    ).not.toBeNull();
  });

  it("keeps an over-budget unclosed display block fully source-visible", () => {
    const source = [
      "$$",
      ...Array.from({ length: 257 }, (_, index) => `line ${index}`),
      "AFTER",
    ].join("\n");
    const rendered = preview(source);

    expect(rendered.querySelector(".preview-math-block")).toBeNull();
    expect(rendered.textContent).toContain("line 0");
    expect(rendered.textContent).toContain("line 256");
    expect(rendered.textContent).toContain("AFTER");
  });

  it("fails closed for deeply nested and unmatched inline math", () => {
    let nested = "x";
    for (let index = 0; index < 2_048; index += 1) {
      nested = String.raw`\frac{${nested}}{1}`;
    }
    const nestedRendered = preview(String.raw`\(${nested}\)`);
    expect(nestedRendered.querySelector(".preview-math")).toBeNull();
    expect(nestedRendered.textContent).toContain("frac");

    const unmatched = String.raw`\(`.repeat(50_000);
    const unmatchedRendered = preview(unmatched);
    expect(unmatchedRendered.querySelector(".preview-math")).toBeNull();
    expect(unmatchedRendered.textContent?.length).toBeGreaterThan(0);

    const overlapping = String.raw`\(`.repeat(30_000) + String.raw`x\)`;
    const overlappingRendered = preview(overlapping);
    expect(overlappingRendered.querySelector(".preview-math")).toBeNull();
    expect(overlappingRendered.textContent).toContain("x");
  });

  it("does not carry an unmatched delimiter cache into another paragraph", () => {
    const rendered = preview(String.raw`Unmatched \(x

Working $y$`);
    expect(rendered.querySelectorAll(".preview-math")).toHaveLength(1);
    expect(rendered.querySelector(".preview-math")?.textContent).toBe("y");
  });

  it("fails closed when frontmatter has no terminator within the scan budget", () => {
    const source = [
      "---",
      ...Array.from({ length: 255 }, (_, index) => `key${index}: value`),
      "Body $x$ and [[Embed]]",
    ].join("\n");
    const rendered = preview(source);

    expect(rendered.querySelector(".preview-math")).toBeNull();
    expect(rendered.querySelector("[data-threadleaf-link='wiki']")).toBeNull();
    expect(rendered.querySelector(".preview-source-fallback")).not.toBeNull();
    expect(rendered.textContent).toContain("Body $x$ and [[Embed]]");
  });

  it("preserves CR-only and mixed source boundaries while masking resolved frontmatter", () => {
    for (const source of [
      "\uFEFF---\rkind: fixture\r---\rBody $x$ and [[Embed]]",
      "---\r\nkind: fixture\n---\rBody $x$ and [[Embed]]",
      "---\nkind: fixture\r---\r\nBody $x$ and [[Embed]]",
    ]) {
      const rendered = preview(source);
      expect(rendered.querySelectorAll(".preview-math")).toHaveLength(1);
      expect(rendered.querySelectorAll("[data-threadleaf-link='wiki']")).toHaveLength(1);
      expect(rendered.textContent).not.toContain("kind: fixture");
      expect(rendered.textContent).toContain("Body x and Embed");
    }
  });

  it("preserves UTF-16 offsets while masking astral frontmatter", () => {
    const rendered = preview("---\r\ntitle: 😀\r\n---\r\nBody $x$ [[Good]]");
    expect(rendered.querySelectorAll(".preview-math")).toHaveLength(1);
    expect(rendered.querySelectorAll("[data-threadleaf-link='wiki']")).toHaveLength(1);
    expect(rendered.textContent).not.toContain("title: 😀");
    expect(rendered.textContent).toContain("Body x Good");
  });

  it("fails closed before splitting an enormous unresolved frontmatter body", () => {
    const source = [
      "---",
      ...Array.from({ length: 100_000 }, (_, index) => `key${index}: value`),
      "Body $x$ and [[Embed]]",
    ].join("\n");
    const rendered = preview(source);
    expect(rendered.querySelector(".preview-source-fallback")).not.toBeNull();
    expect(rendered.querySelectorAll(".preview-math")).toHaveLength(0);
    expect(rendered.querySelectorAll("[data-threadleaf-link='wiki']")).toHaveLength(0);
    expect(rendered.textContent).toContain("key99999: value");
    expect(rendered.textContent).toContain("Body $x$ and [[Embed]]");
  });

  it("keeps malformed footnote definitions and continuations source-only", () => {
    const rendered = preview(
      [
        "[^bad id]: malformed definition",
        "    Continuation $x$ and [[Embed]] stay source.",
        "Normal $y$ remains renderable.",
      ].join("\n"),
    );

    expect(rendered.querySelectorAll(".preview-math")).toHaveLength(1);
    expect(rendered.textContent).toContain("Continuation $x$ and [[Embed]] stay source.");
    expect(rendered.querySelector("[data-threadleaf-link='wiki']")).toBeNull();
  });

  it("keeps malformed footnote regions source-only when they follow another paragraph", () => {
    const rendered = preview(
      [
        "Introductory prose.",
        "",
        "[^bad id]: malformed definition",
        "    Continuation $x$ and [[Embed]] stay source.",
        "",
        "Normal $y$ remains renderable.",
      ].join("\n"),
    );

    expect(rendered.querySelectorAll(".preview-math")).toHaveLength(1);
    expect(rendered.querySelector(".preview-math")?.textContent).toBe("y");
    expect(rendered.textContent).toContain("Continuation $x$ and [[Embed]] stay source.");
    expect(rendered.querySelector("[data-threadleaf-link='wiki']")).toBeNull();
  });

  it("masks malformed footnote definitions after Markdown-it deindents them", () => {
    for (const ending of ["\n", "\r\n", "\r"]) {
      for (const indentation of ["", " ", "  ", "   "]) {
        const source = [
          `${indentation}[^bad id]: malformed $x$ [[Bad]]`,
          "    continuation $y$ [[Cont]]",
          "Normal $z$ [[Good]]",
        ].join(ending);
        const rendered = preview(source);
        expect(
          [...rendered.querySelectorAll(".preview-math")].map((node) => node.textContent),
        ).toEqual(["z"]);
        expect(
          [...rendered.querySelectorAll("[data-threadleaf-link='wiki']")].map(
            (node) => node.textContent,
          ),
        ).toEqual(["Good"]);
      }
    }
  });

  it("does not mask ordinary indented prose", () => {
    const rendered = preview("   Normal $x$ and [[Good]]");
    expect(rendered.querySelectorAll(".preview-math")).toHaveLength(1);
    expect(rendered.querySelectorAll("[data-threadleaf-link='wiki']")).toHaveLength(1);
  });

  it("does not let source marker characters create a masking collision", () => {
    const source = [
      "\u2060\u2061\u2062\u2063\uFFF9\uFFFA",
      "[^bad id]: source-only $x$ [[Bad]]",
      "Normal $y$ [[Good]]",
    ].join("\n");
    const rendered = preview(source);

    expect([...rendered.querySelectorAll(".preview-math")].map((node) => node.textContent)).toEqual(
      ["y"],
    );
    expect(
      [...rendered.querySelectorAll("[data-threadleaf-link='wiki']")].map(
        (node) => node.textContent,
      ),
    ).toEqual(["Good"]);
  });

  it("marks GFM tables with semantic headers and alignment classes", () => {
    const rendered = preview(["| Name | Count |", "| :--- | ---: |", "| Atlas | 42 |"].join("\n"));
    const table = rendered.querySelector<HTMLTableElement>("table.preview-gfm-table");
    expect(table?.dataset.threadleafTable).toBe("gfm");
    expect(table?.querySelector("th[scope='col'].align-left")?.textContent).toBe("Name");
    expect(table?.querySelector("th[scope='col'].align-right")?.textContent).toBe("Count");
    expect(table?.querySelector("td.align-right")?.textContent).toBe("42");
    expect(table?.querySelector("[style]")).toBeNull();
  });

  it("renders the supported structural subset with source-line controls", () => {
    const rendered = preview(
      [
        "---",
        "kind: fixture",
        "---",
        "",
        "# Heading",
        "",
        "A **strong** paragraph with `code`.",
        "",
        "> Quoted",
        "",
        "- First",
        "- Second",
        "",
        "| Column | Value |",
        "| :--- | ---: |",
        "| Alpha | 42 |",
        "",
        "```ts",
        "const value = 42;",
        "```",
      ].join("\n"),
    );

    expect(rendered.querySelector("h1")?.textContent).toBe("Heading");
    expect(rendered.querySelector("strong")?.textContent).toBe("strong");
    expect(rendered.querySelector("blockquote")?.textContent).toContain("Quoted");
    expect(rendered.querySelectorAll("li")).toHaveLength(2);
    expect(rendered.querySelector("table")?.textContent).toContain("Alpha");
    expect(rendered.querySelector("pre code")?.textContent).toContain("const value = 42;");
    expect(rendered.querySelector(".preview-block[data-source-line='5'] h1")).not.toBeNull();
    expect(rendered.querySelector("button[aria-label='Edit source at line 5']")).not.toBeNull();
    expect(rendered.querySelector("button[aria-label='Edit source at line 18']")).not.toBeNull();
    expect(rendered.querySelector("th.align-left")).not.toBeNull();
    expect(rendered.querySelector("th.align-right")).not.toBeNull();
    expect(rendered.querySelector("th[style],td[style]")).toBeNull();
    expect(rendered.textContent).not.toContain("kind: fixture");
  });

  it("renders standard and custom Markdown task markers as source-addressable checkboxes", () => {
    const rendered = preview(
      [
        "- [ ] open",
        "  - [x] nested",
        "- [-] cancelled",
        "> - [?] quoted",
        ">   1. [🟡] quoted unicode",
      ].join("\n"),
    );
    const tasks = [...rendered.querySelectorAll<HTMLLIElement>("li.task-list-item")];
    const checkboxes = [
      ...rendered.querySelectorAll<HTMLInputElement>('input[data-threadleaf-task="true"]'),
    ];

    expect(tasks.map((task) => task.getAttribute("data-task"))).toEqual(["", "x", "-", "?", "🟡"]);
    expect(tasks.map((task) => task.dataset.sourceLine)).toEqual(["1", "2", "3", "4", "5"]);
    expect(checkboxes.map((checkbox) => checkbox.checked)).toEqual([
      false,
      true,
      false,
      false,
      false,
    ]);
    expect(checkboxes.map((checkbox) => checkbox.getAttribute("data-task"))).toEqual([
      "",
      "x",
      "-",
      "?",
      "🟡",
    ]);
    expect(checkboxes.map((checkbox) => checkbox.getAttribute("aria-label"))).toEqual([
      "Open task, open",
      "Completed task, nested",
      "Cancelled task, cancelled",
      "Question task, quoted",
      "Task with custom status 🟡, quoted unicode",
    ]);
    expect(rendered.textContent).not.toContain("[ ] open");
    expect(rendered.textContent).not.toContain("[?] quoted");
  });

  it("preserves wiki-link meaning without parsing code as links", () => {
    const rendered = preview(
      [
        "Open [[Folder/Target#Section|Target alias]] and ![[Drawing.excalidraw]].",
        "",
        "Inline `[[not a link]]`.",
        "",
        "```",
        "[[also not a link]]",
        "```",
      ].join("\n"),
    );
    const links = [
      ...rendered.querySelectorAll<HTMLAnchorElement>("[data-threadleaf-link='wiki']"),
    ];

    expect(links).toHaveLength(2);
    expect(links[0]?.textContent).toBe("Target alias");
    expect(links[0]?.dataset.threadleafTarget).toBe("Folder/Target");
    expect(links[0]?.dataset.threadleafSubpath).toBe("#Section");
    expect(links[0]?.dataset.threadleafEmbed).toBe("false");
    expect(links[1]?.dataset.threadleafEmbed).toBe("true");
    expect(rendered.querySelector("code")?.textContent).toBe("[[not a link]]");
    expect(rendered.querySelector("pre")?.textContent).toContain("[[also not a link]]");
  });

  it("renders valid tags as trusted anchors outside code and links", () => {
    const rendered = preview(
      [
        "#Alpha/Child #2026 #y2026 and (#résumé).",
        "",
        "`#inline-code` [linked #hidden](Target.md)",
        "",
        "```md",
        "#fenced",
        "```",
      ].join("\n"),
    );
    const tags = [...rendered.querySelectorAll<HTMLAnchorElement>("a.tag")];

    expect(tags.map((tag) => tag.textContent)).toEqual(["#Alpha/Child", "#y2026", "#résumé"]);
    expect(tags.map((tag) => tag.dataset.threadleafTag)).toEqual([
      "Alpha/Child",
      "y2026",
      "résumé",
    ]);
    expect(tags.map((tag) => tag.dataset.tagName)).toEqual(["#Alpha/Child", "#y2026", "#résumé"]);
    expect(tags.map((tag) => tag.getAttribute("href"))).toEqual([
      "#Alpha/Child",
      "#y2026",
      "#résumé",
    ]);
    expect(rendered.querySelector("code")?.textContent).toBe("#inline-code");
    expect(rendered.querySelector("pre")?.textContent).toContain("#fenced");
  });

  it("classifies local and external Markdown links without leaving a navigable URL", () => {
    const rendered = preview(
      "[Local](Folder/Note.md#Part) [Web](https://example.com/path) [Unsafe](javascript:alert(1))",
    );
    const local = rendered.querySelector<HTMLAnchorElement>("[data-threadleaf-link='markdown']");
    const external = rendered.querySelector<HTMLAnchorElement>("[data-threadleaf-link='external']");

    expect(local?.dataset.threadleafTarget).toBe("Folder/Note.md#Part");
    expect(local?.getAttribute("href")).toBe("#");
    expect(external?.dataset.threadleafExternalUrl).toBe("https://example.com/path");
    expect(external?.getAttribute("href")).toBe("#");
    expect(rendered.querySelectorAll("a")).toHaveLength(2);
    expect(rendered.querySelector("a[href^='javascript:']")).toBeNull();
  });

  it("removes executable and privileged HTML while retaining safe prose", () => {
    delete document.body.dataset.threadleafProbe;
    const rendered = preview(
      [
        "<script>document.body.dataset.threadleafProbe = 'executed'</script>",
        "<img src=x onerror=\"document.body.dataset.threadleafProbe = 'executed'\">",
        '<svg><a href="javascript:alert(1)">bad</a></svg>',
        '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
        '<form><input name="__proto__"></form>',
        '<div style="background:url(https://example.com/leak)" onclick="alert(1)" data-evil="x" aria-bad="y">Safe prose</div>',
      ].join("\n"),
    );

    expect(document.body.dataset.threadleafProbe).toBeUndefined();
    expect(rendered.querySelector("script,img,svg,iframe,form,input")).toBeNull();
    expect(
      rendered.querySelector("[onclick],[onerror],[style],[src],[srcdoc],[data-evil],[aria-bad]"),
    ).toBeNull();
    expect(rendered.textContent).toContain("Safe prose");
    expect(rendered.innerHTML).not.toContain("example.com/leak");
  });

  it("makes links supplied through safe raw HTML inert too", () => {
    const rendered = preview('<a href="https://example.com/raw">Raw link</a>');
    const anchor = rendered.querySelector<HTMLAnchorElement>("a");

    expect(anchor?.dataset.threadleafLink).toBe("external");
    expect(anchor?.dataset.threadleafExternalUrl).toBeUndefined();
    expect(anchor?.getAttribute("href")).toBe("#");
  });

  it("does not trust raw HTML navigation markers or privileged classes", () => {
    const source = [
      '<a data-threadleaf-footnote-ref="true" class="preview-footnote-backref" href="https://evil.example/one">forged https</a>',
      '<a data-threadleaf-link="external" data-threadleaf-external-url="https://evil.example/two" href="//evil.example/two">forged protocol-relative</a>',
      '<a data-threadleaf-link="wiki" data-threadleaf-target="Secret.md" href="javascript:alert(1)">forged javascript</a>',
      '<a data-threadleaf-link="external" data-threadleaf-external-url="data:text/html,evil" href="data:text/html,evil">forged data</a>',
      '<a data-threadleaf-link="external" data-threadleaf-external-url="https://evil.example/fragment" href="#forged">forged fragment</a>',
      "",
      "A genuine note.[^source]",
      "",
      "[^source]: The genuine footnote remains local.",
    ].join("\n");
    const rendered = preview(source);
    const rawAnchors = [...rendered.querySelectorAll<HTMLAnchorElement>("a")].filter(
      (anchor) => anchor.dataset.threadleafRawLink === "true",
    );

    expect(rawAnchors).toHaveLength(5);
    for (const anchor of rawAnchors) {
      expect(anchor.getAttribute("href")).toBe("#");
      expect(anchor.dataset.threadleafFootnoteRef).toBeUndefined();
      expect(anchor.classList.contains("preview-footnote-backref")).toBe(false);
    }
    expect(rawAnchors.map((anchor) => anchor.dataset.threadleafLink)).toEqual([
      "external",
      "external",
      "markdown",
      "markdown",
      "markdown",
    ]);
    expect(rendered.querySelectorAll(".preview-footnote-ref")).toHaveLength(1);
    expect(
      rendered.querySelectorAll(".preview-footnote-ref a[data-threadleaf-raw-link]"),
    ).toHaveLength(0);
    expect(rendered.querySelectorAll(".preview-footnote-backref")).toHaveLength(1);
    expect(
      rendered.querySelector<HTMLElement>(".preview-footnote-ref a")?.getAttribute("href"),
    ).toMatch(/^#threadleaf-footnote-/u);
  });

  it("keeps forged footnote navigation inert inside a genuine definition", () => {
    const source = [
      "A genuine note.[^source]",
      "",
      '[^source]: <a class="preview-footnote-backref" data-threadleaf-footnote-ref="true" data-threadleaf-external-url="https://evil.example/footnote" href="https://evil.example/footnote">forged</a>',
    ].join("\n");
    const rendered = preview(source);
    const raw = rendered.querySelector<HTMLAnchorElement>("a[data-threadleaf-raw-link='true']");
    const genuineReference = rendered.querySelector<HTMLAnchorElement>(".preview-footnote-ref a");

    expect(raw?.textContent).toBe("forged");
    expect(raw?.getAttribute("href")).toBe("#");
    expect(raw?.dataset.threadleafExternalUrl).toBeUndefined();
    expect(raw?.classList.contains("preview-footnote-backref")).toBe(false);
    expect(genuineReference?.getAttribute("href")).toMatch(/^#threadleaf-footnote-/u);
  });

  it("keeps reading Markdown after a raw script close-tag lookalike", () => {
    const source = `<span><script>const html = "</div>"; \`unmatched\n[^hidden]: script text\n</script></span>\n**after**\n\n[^shown]: visible note`;
    const rendered = preview(source);

    expect(rendered.querySelector("strong")?.textContent).toBe("after");
    expect(rendered.querySelector(".preview-footnotes")?.textContent).toContain("visible note");
    expect(rendered.textContent).not.toContain("script text");
    expect(rendered.textContent).not.toContain("[^hidden]");
  });

  it("uses inert placeholders for Markdown images before bounded hydration", () => {
    const rendered = preview("![Architecture](assets/architecture.png)");
    const placeholder = rendered.querySelector<HTMLElement>(".preview-asset-placeholder");

    expect(rendered.querySelector("img")).toBeNull();
    expect(placeholder?.textContent).toBe("Image: Architecture");
    expect(placeholder?.dataset.threadleafAsset).toBe("assets/architecture.png");
    expect(placeholder?.dataset.threadleafAlt).toBe("Architecture");
  });

  it("uses the same bounded image path for wiki-style image embeds", async () => {
    const rendered = preview("![[assets/architecture.PNG|Architecture]]");
    const requests: string[][] = [];

    await hydrateMarkdownPreviewImages(rendered, {
      sourceNotePath: "Notes/Current.md",
      expectedVaultId: "vault-a",
      loadImage: async (sourceNotePath, target, expectedVaultId) => {
        requests.push([sourceNotePath, target, expectedVaultId]);
        return {
          status: "ready",
          vaultId: "vault-a",
          path: "Notes/assets/architecture.PNG",
          mimeType: "image/png",
          size: 4,
          revision: "d".repeat(64),
          base64: "iVBORw==",
        };
      },
    });

    expect(requests).toEqual([["Notes/Current.md", "assets/architecture.PNG", "vault-a"]]);
    expect(rendered.querySelector<HTMLImageElement>("img.preview-local-image")?.alt).toBe(
      "Architecture",
    );
    expect(rendered.querySelector("a.preview-embed-link")).toBeNull();
  });

  it("distinguishes Markdown note transclusions from raster and plugin-owned embeds", () => {
    const rendered = preview(
      [
        "![[Note#Section|Wiki section]]",
        "",
        "![Markdown section](Folder/Note.md#Part)",
        "",
        "![[assets/image.png|Raster]]",
        "",
        "![[Drawing.excalidraw]]",
      ].join("\n"),
    );
    const embeds = [...rendered.querySelectorAll<HTMLElement>(".preview-note-embed-placeholder")];

    expect(embeds).toHaveLength(2);
    expect(embeds[0]?.dataset.threadleafTarget).toBe("Note");
    expect(embeds[0]?.dataset.threadleafSubpath).toBe("#Section");
    expect(embeds[1]?.dataset.threadleafTarget).toBe("Folder/Note.md");
    expect(embeds[1]?.dataset.threadleafSubpath).toBe("#Part");
    expect(rendered.querySelector(".preview-asset-placeholder")?.textContent).toContain("Raster");
    expect(rendered.querySelector("a.preview-embed-link")?.textContent).toBe("Drawing.excalidraw");
  });

  it("hydrates nested note content, origin-relative images, links, and source provenance", async () => {
    const rendered = preview("![[Embedded#Part|Project brief]]");
    const noteRequests: Array<[string, string, string | null, string]> = [];
    const imageRequests: Array<[string, string, string]> = [];
    const decorated: Array<[string, string[]]> = [];

    await hydrateMarkdownPreview(rendered, {
      sourceNotePath: "Current.md",
      expectedVaultId: "vault-a",
      loadImage: async (sourceNotePath, target, expectedVaultId) => {
        imageRequests.push([sourceNotePath, target, expectedVaultId]);
        return {
          status: "ready",
          vaultId: "vault-a",
          path: "Folder/pic.png",
          mimeType: "image/png",
          size: 4,
          revision: "f".repeat(64),
          base64: "iVBORw==",
        };
      },
      loadNoteEmbed: async (sourceNotePath, target, subpath, expectedVaultId) => {
        noteRequests.push([sourceNotePath, target, subpath, expectedVaultId]);
        if (target === "Embedded") {
          return readyEmbed(
            "Folder/Embedded.md",
            "## Part\n\n![Diagram](pic.png)\n\n[[Destination]]\n\n![[Nested]]",
            {
              startLine: 10,
              endLine: 16,
              kind: "heading",
              subpath: "#Part",
              links: [
                {
                  label: "Destination",
                  status: "resolved",
                  path: "Folder/Destination.md",
                  target: "Destination",
                  subpath: null,
                  embed: false,
                  syntax: "wiki",
                },
                {
                  label: "Nested",
                  status: "resolved",
                  path: "Folder/Nested.md",
                  target: "Nested",
                  subpath: null,
                  embed: true,
                  syntax: "wiki",
                },
              ],
            },
          );
        }
        return readyEmbed("Folder/Nested.md", "# Nested\n\nNested body.");
      },
      decorateLinks: (_root, links, sourceNotePath) => {
        decorated.push([sourceNotePath, links.map(({ label }) => label)]);
      },
    });

    expect(noteRequests).toEqual([
      ["Current.md", "Embedded", "#Part", "vault-a"],
      ["Folder/Embedded.md", "Nested", null, "vault-a"],
    ]);
    expect(imageRequests).toEqual([["Folder/Embedded.md", "pic.png", "vault-a"]]);
    expect(decorated).toEqual([
      ["Folder/Embedded.md", ["Destination", "Nested"]],
      ["Folder/Nested.md", []],
    ]);
    expect(
      rendered.querySelectorAll(".preview-note-embed[data-threadleaf-note-embed-status='ready']"),
    ).toHaveLength(2);
    expect(rendered.querySelector<HTMLButtonElement>(".preview-note-embed-open")).toMatchObject({
      textContent: "Folder/Embedded.md#Part",
    });
    expect(
      rendered.querySelector<HTMLButtonElement>(
        ".preview-note-embed-body .preview-source-action[data-source-line='10']",
      )?.dataset.sourcePath,
    ).toBe("Folder/Embedded.md");
    expect(rendered.querySelector<HTMLImageElement>(".preview-note-embed-body img")?.alt).toBe(
      "Diagram",
    );
  });

  it("allows a finite same-note section embed and stops a repeated embed identity as a cycle", async () => {
    const rendered = preview("![[#Part]]");
    const requests: Array<[string, string, string | null]> = [];

    await hydrateMarkdownPreview(rendered, {
      sourceNotePath: "Current.md",
      expectedVaultId: "vault-a",
      loadImage: unavailableImage,
      loadNoteEmbed: async (sourceNotePath, target, subpath) => {
        requests.push([sourceNotePath, target, subpath]);
        return readyEmbed("Current.md", "## Part\n\n![[#Part]]", {
          kind: "heading",
          subpath: "#Part",
        });
      },
      decorateLinks: () => undefined,
    });

    expect(requests).toEqual([
      ["Current.md", "", "#Part"],
      ["Current.md", "", "#Part"],
    ]);
    expect(
      rendered.querySelector(".preview-note-embed[data-threadleaf-note-embed-status='ready']"),
    ).not.toBeNull();
    expect(
      rendered.querySelector(
        ".preview-note-embed-unavailable[data-threadleaf-note-embed-status='cycle']",
      )?.textContent,
    ).toContain("Embedded note unavailable");
  });

  it("makes stale, depth-limited, and byte-limited note embeds explicit", async () => {
    const stale = preview("![[Old]]");
    await hydrateMarkdownPreview(stale, {
      sourceNotePath: "Current.md",
      expectedVaultId: "vault-a",
      loadImage: unavailableImage,
      loadNoteEmbed: async () => ({ status: "stale-vault", vaultId: "vault-b" }),
      decorateLinks: () => undefined,
    });
    expect(
      stale.querySelector<HTMLElement>(
        ".preview-note-embed-unavailable[data-threadleaf-note-embed-status='stale-vault']",
      )?.title,
    ).toContain("active vault changed");

    const deep = preview("![[A1]]");
    let depthRequests = 0;
    await hydrateMarkdownPreview(deep, {
      sourceNotePath: "Current.md",
      expectedVaultId: "vault-a",
      loadImage: unavailableImage,
      loadNoteEmbed: async (_source, target) => {
        depthRequests += 1;
        const number = Number.parseInt(target.slice(1), 10);
        return readyEmbed(`A${number}.md`, `# A${number}\n\n![[A${number + 1}]]`);
      },
      decorateLinks: () => undefined,
    });
    expect(depthRequests).toBe(4);
    expect(
      deep.querySelector(
        ".preview-note-embed-unavailable[data-threadleaf-note-embed-status='depth-limit']",
      )?.textContent,
    ).toContain("Embedded note unavailable");

    const oversized = preview("![[Huge]]");
    await hydrateMarkdownPreview(oversized, {
      sourceNotePath: "Current.md",
      expectedVaultId: "vault-a",
      loadImage: unavailableImage,
      loadNoteEmbed: async () => readyEmbed("Huge.md", "# Huge", { contentBytes: 9 * 1024 * 1024 }),
      decorateLinks: () => undefined,
    });
    expect(
      oversized.querySelector<HTMLElement>(
        ".preview-note-embed-unavailable[data-threadleaf-note-embed-status='preview-limit']",
      )?.title,
    ).toContain("8 MiB");
  });

  it("hydrates a supported local image without exposing a navigable filesystem URL", async () => {
    const rendered = preview("![Architecture](assets/architecture.png)");
    const requests: string[][] = [];

    await hydrateMarkdownPreviewImages(rendered, {
      sourceNotePath: "Notes/Current.md",
      expectedVaultId: "vault-a",
      loadImage: async (sourceNotePath, target, expectedVaultId) => {
        requests.push([sourceNotePath, target, expectedVaultId]);
        return {
          status: "ready",
          vaultId: "vault-a",
          path: "Notes/assets/architecture.png",
          mimeType: "image/png",
          size: 4,
          revision: "a".repeat(64),
          base64: "iVBORw==",
        };
      },
    });

    const image = rendered.querySelector<HTMLImageElement>("img.preview-local-image");
    expect(requests).toEqual([["Notes/Current.md", "assets/architecture.png", "vault-a"]]);
    expect(image?.alt).toBe("Architecture");
    expect(image?.loading).toBe("eager");
    expect(image?.src).toBe("data:image/png;base64,iVBORw==");
    expect(image?.dataset.threadleafAssetPath).toBe("Notes/assets/architecture.png");
    expect(image?.dataset.threadleafRevision).toBe("a".repeat(64));
    expect(rendered.innerHTML).not.toContain("file://");
    image?.dispatchEvent(new Event("error"));
    expect(
      rendered.querySelector<HTMLElement>(
        ".preview-asset-placeholder[data-threadleaf-asset-status='decode-failed']",
      )?.textContent,
    ).toBe("Image unavailable: Architecture");
  });

  it("keeps failures explicit and ignores image responses from a stale render", async () => {
    const unavailable = preview("![Missing](missing.png)");
    await hydrateMarkdownPreviewImages(unavailable, {
      sourceNotePath: "Current.md",
      expectedVaultId: "vault-a",
      loadImage: async () => ({
        status: "unavailable",
        vaultId: "vault-a",
        reason: "missing",
        message: "The local image no longer exists.",
      }),
    });
    const failure = unavailable.querySelector<HTMLElement>(".preview-asset-placeholder");
    expect(failure?.textContent).toBe("Image unavailable: Missing");
    expect(failure?.dataset.threadleafAssetStatus).toBe("missing");
    expect(failure?.title).toBe("The local image no longer exists.");

    const stale = preview("![Old](old.png)");
    let current = true;
    let release: ((response: VaultImageResponse) => void) | undefined;
    const pending = hydrateMarkdownPreviewImages(stale, {
      sourceNotePath: "Current.md",
      expectedVaultId: "vault-a",
      isCurrent: () => current,
      loadImage: () =>
        new Promise<VaultImageResponse>((resolve) => {
          release = resolve;
        }),
    });
    current = false;
    release?.({
      status: "ready",
      vaultId: "vault-a",
      path: "old.png",
      mimeType: "image/png",
      size: 4,
      revision: "b".repeat(64),
      base64: "iVBORw==",
    });
    await pending;
    expect(stale.querySelector("img")).toBeNull();
    expect(stale.querySelector(".preview-asset-placeholder")).not.toBeNull();
  });

  it("bounds the total decoded image set for one reading view", async () => {
    const rendered = preview("![One](one.png)\n\n![Two](two.png)");

    await hydrateMarkdownPreviewImages(rendered, {
      sourceNotePath: "Current.md",
      expectedVaultId: "vault-a",
      loadImage: async (_source, target) => ({
        status: "ready",
        vaultId: "vault-a",
        path: target,
        mimeType: "image/png",
        size: 40 * 1024 * 1024,
        revision: "c".repeat(64),
        base64: "iVBORw==",
      }),
    });

    expect(rendered.querySelectorAll("img.preview-local-image")).toHaveLength(1);
    const bounded = rendered.querySelector<HTMLElement>(
      ".preview-asset-placeholder[data-threadleaf-asset-status='preview-limit']",
    );
    expect(bounded?.textContent).toBe("Image unavailable: Two");
    expect(bounded?.title).toContain("64 MiB");
  });

  it("renders passive attachment metadata without decoding or embedding arbitrary bytes", async () => {
    const rendered = preview("![[Assets/report.pdf|Report]]\n\n![[Assets/unknown.bin|Unknown]]");
    expect(rendered.querySelectorAll(".preview-attachment-placeholder")).toHaveLength(2);
    const requested: string[] = [];
    await hydrateMarkdownPreviewAttachments(rendered, {
      sourceNotePath: "Current.md",
      expectedVaultId: "vault-a",
      loadAttachment: async (_source, target): Promise<VaultAttachmentResponse> => {
        requested.push(target);
        return {
          status: "ready",
          vaultId: "vault-a",
          attachment: {
            path: target,
            kind: target.endsWith("pdf") ? "pdf" : "unsupported",
            mimeType: target.endsWith("pdf") ? "application/pdf" : null,
            size: 12,
            revision: "f".repeat(64),
            actions: {
              open: target.endsWith("pdf"),
              reveal: true,
              rename: true,
              move: true,
              inline: false,
            },
          },
        };
      },
    });
    expect(requested).toEqual(["Assets/report.pdf", "Assets/unknown.bin"]);
    const cards = rendered.querySelectorAll<HTMLElement>(".preview-attachment-card");
    expect(cards).toHaveLength(2);
    expect(cards[0]?.textContent).toContain("application/pdf");
    expect(cards[1]?.textContent).toContain("unsupported");
    expect(rendered.querySelectorAll("img, video, audio, iframe")).toHaveLength(0);
    expect(rendered.querySelectorAll(".preview-attachment-action")).toHaveLength(7);
    expect(
      rendered.querySelector(
        '[data-threadleaf-attachment-path="Assets/unknown.bin"][data-threadleaf-attachment-action="open"]',
      ),
    ).toBeNull();
    expect(
      [...rendered.querySelectorAll<HTMLElement>(".preview-attachment-action")].filter(
        (button) => button.textContent === "Rename or move",
      ),
    ).toHaveLength(2);
  });

  it("renders card-scoped Restore, Paste file, and Relink actions only for an authorized missing attachment", async () => {
    const rendered = preview("![[Missing/report.pdf|Quarterly report]]");
    await hydrateMarkdownPreviewAttachments(rendered, {
      sourceNotePath: "Notes/Current.md",
      expectedVaultId: "vault-a",
      loadAttachment: async (): Promise<VaultAttachmentResponse> => ({
        status: "unavailable",
        vaultId: "vault-a",
        reason: "missing",
        message: "The attachment target does not resolve in the active vault.",
        recovery: {
          kind: "missing-attachment",
          missingPath: "Notes/Missing/report.pdf",
          sourceNoteRevision: "d".repeat(64),
        },
      }),
    });

    const card = rendered.querySelector<HTMLElement>(".preview-attachment-unavailable");
    const relink = card?.querySelector<HTMLButtonElement>(
      '[data-threadleaf-attachment-action="relink"]',
    );
    const restore = card?.querySelector<HTMLButtonElement>(
      '[data-threadleaf-attachment-action="restore"]',
    );
    const paste = card?.querySelector<HTMLButtonElement>(
      '[data-threadleaf-attachment-action="paste"]',
    );
    expect(card?.getAttribute("role")).toBe("group");
    expect(card?.getAttribute("aria-busy")).toBe("false");
    expect(card?.dataset.threadleafAttachmentExternalInput).toBe("true");
    expect(card?.dataset.threadleafAttachmentPath).toBe("Notes/Missing/report.pdf");
    expect(card?.dataset.threadleafAttachmentSourceRevision).toBe("d".repeat(64));
    expect(relink?.textContent).toBe("Relink");
    expect(relink?.dataset.threadleafAttachmentPath).toBe("Notes/Missing/report.pdf");
    expect(relink?.dataset.threadleafAttachmentMissingTarget).toBe("Missing/report.pdf");
    expect(restore?.textContent).toBe("Restore file");
    expect(restore?.dataset.threadleafAttachmentPath).toBe("Notes/Missing/report.pdf");
    expect(restore?.dataset.threadleafAttachmentMissingTarget).toBe("Missing/report.pdf");
    expect(paste?.textContent).toBe("Paste file");
    expect(paste?.dataset.threadleafAttachmentPath).toBe("Notes/Missing/report.pdf");
    expect(paste?.dataset.threadleafAttachmentMissingTarget).toBe("Missing/report.pdf");
    expect(paste?.getAttribute("aria-keyshortcuts")).toBe("Control+V Meta+V");
    expect(card?.querySelector(".preview-attachment-input-hint")?.textContent).toContain(
      "Drop one file here",
    );
    expect(card?.dataset.threadleafAttachmentSourceNotePath).toBe("Notes/Current.md");
    expect(relink?.dataset.threadleafAttachmentSourceNotePath).toBe("Notes/Current.md");
    expect(restore?.dataset.threadleafAttachmentSourceNotePath).toBe("Notes/Current.md");
    expect(paste?.dataset.threadleafAttachmentSourceNotePath).toBe("Notes/Current.md");

    const inert = preview("![[Missing/other.pdf]]");
    await hydrateMarkdownPreviewAttachments(inert, {
      sourceNotePath: "Notes/Current.md",
      expectedVaultId: "vault-a",
      loadAttachment: async (): Promise<VaultAttachmentResponse> => ({
        status: "unavailable",
        vaultId: "vault-a",
        reason: "missing",
        message: "The attachment target does not resolve in the active vault.",
      }),
    });
    expect(inert.querySelector('[data-threadleaf-attachment-action="relink"]')).toBeNull();
    expect(inert.querySelector('[data-threadleaf-attachment-action="restore"]')).toBeNull();
    expect(inert.querySelector('[data-threadleaf-attachment-action="paste"]')).toBeNull();
    expect(inert.dataset.threadleafAttachmentExternalInput).toBeUndefined();
  });

  it("carries a nested note source path onto its restore and relink actions", async () => {
    const rendered = preview("![[Embedded]]");

    await hydrateMarkdownPreview(rendered, {
      sourceNotePath: "Root.md",
      expectedVaultId: "vault-a",
      loadImage: unavailableImage,
      loadAttachment: async (sourceNotePath, target): Promise<VaultAttachmentResponse> => {
        expect(sourceNotePath).toBe("Folder/Embedded.md");
        expect(target).toBe("Missing/report.pdf");
        return {
          status: "unavailable",
          vaultId: "vault-a",
          reason: "missing",
          message: "The attachment target does not resolve in the active vault.",
          recovery: {
            kind: "missing-attachment",
            missingPath: "Folder/Missing/report.pdf",
            sourceNoteRevision: "e".repeat(64),
          },
        };
      },
      loadNoteEmbed: async () => readyEmbed("Folder/Embedded.md", "![[Missing/report.pdf|Report]]"),
      decorateLinks: () => undefined,
    });

    const rootRelink = rendered.querySelector(
      ':scope > .preview-attachment-card [data-threadleaf-attachment-action="relink"]',
    );
    const nestedRelink = rendered.querySelector<HTMLButtonElement>(
      '.preview-note-embed-body [data-threadleaf-attachment-action="relink"]',
    );
    const nestedRestore = rendered.querySelector<HTMLButtonElement>(
      '.preview-note-embed-body [data-threadleaf-attachment-action="restore"]',
    );
    const nestedPaste = rendered.querySelector<HTMLButtonElement>(
      '.preview-note-embed-body [data-threadleaf-attachment-action="paste"]',
    );
    expect(rootRelink).toBeNull();
    expect(nestedRelink?.dataset.threadleafAttachmentSourceNotePath).toBe("Folder/Embedded.md");
    expect(nestedRestore?.dataset.threadleafAttachmentSourceNotePath).toBe("Folder/Embedded.md");
    expect(nestedPaste?.dataset.threadleafAttachmentSourceNotePath).toBe("Folder/Embedded.md");
  });

  it("keeps escaped query and fragment filename bytes out of renderer subpaths", () => {
    const rendered = preview(
      "![fragment](Assets/report\\#draft.pdf)\n\n![query](Assets/report\\?draft.pdf)",
    );
    expect(
      [...rendered.querySelectorAll<HTMLElement>(".preview-attachment-placeholder")].map(
        (element) => element.dataset.threadleafAttachmentTarget,
      ),
    ).toEqual(["Assets/report#draft.pdf", "Assets/report?draft.pdf"]);
  });
});

describe("sanitizePluginMarkdownProjection", () => {
  it("keeps allowed structure and text from a settled plugin projection", () => {
    const fragment = sanitizePluginMarkdownProjection(
      '<p>CITE recognized 1 citation.</p><p><span class="cite-citation">Doe 2024</span></p>',
    );
    const container = document.createElement("div");
    container.append(fragment);
    expect(container.querySelectorAll("p")).toHaveLength(2);
    expect(container.querySelector(".cite-citation")?.textContent).toBe("Doe 2024");
  });

  it("removes script, event-handler, and disallowed elements like the ordinary sanitizer", () => {
    const fragment = sanitizePluginMarkdownProjection(
      '<p onclick="evil()">safe</p><script>evil()</script><img src="x" onerror="evil()">',
    );
    const container = document.createElement("div");
    container.append(fragment);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("p")?.outerHTML).toBe("<p>safe</p>");
  });

  it("strips data-threadleaf-* and data-source-line so plugin output cannot pose as trusted native markup", () => {
    const fragment = sanitizePluginMarkdownProjection(
      '<p data-threadleaf-link="markdown" data-threadleaf-target="Secret.md" data-source-line="3">text</p>',
    );
    const container = document.createElement("div");
    container.append(fragment);
    const paragraph = container.querySelector("p");
    expect(paragraph?.getAttribute("data-threadleaf-link")).toBeNull();
    expect(paragraph?.getAttribute("data-threadleaf-target")).toBeNull();
    expect(paragraph?.getAttribute("data-source-line")).toBeNull();
    expect(paragraph?.textContent).toBe("text");
  });

  it("inert-links every anchor so a settled projection cannot trigger native navigation", () => {
    const fragment = sanitizePluginMarkdownProjection(
      '<a href="https://example.com">external</a><a href="Other.md">internal-looking</a>',
    );
    const container = document.createElement("div");
    container.append(fragment);
    for (const anchor of container.querySelectorAll("a")) {
      expect(anchor.hasAttribute("href")).toBe(false);
    }
    expect(container.textContent).toBe("externalinternal-looking");
  });

  it("strips every privileged and delegated-click class so plugin output cannot pose as a trusted native control", () => {
    // Payload proof: each class below is individually meaningful to renderer.ts's markup
    // (internal/external link styling, footnote wiring) or its delegated click handlers
    // (source-jump, note-embed open, attachment action, canvas-embed open), which all match by
    // `closest(".classname")` -- any allowed element carrying the class is the real threat model,
    // not specifically a <button>. A settled plugin projection must never carry any of them.
    const strippedClasses = [
      "internal-link",
      "external-link",
      "preview-embed-link",
      "preview-footnote-ref",
      "preview-footnote-backref",
      "preview-source-action",
      "preview-note-embed-open",
      "preview-attachment-action",
      "preview-canvas-embed-open",
    ];
    const letters = "abcdefghi";
    const payload = strippedClasses
      .map((className, index) => `<span class="${className}">${letters[index]}</span>`)
      .join("");
    const fragment = sanitizePluginMarkdownProjection(payload);
    const container = document.createElement("div");
    container.append(fragment);
    for (const className of strippedClasses) {
      expect(container.querySelector(`.${className}`)).toBeNull();
    }
    // The elements and their text survive; only the privileged/delegated-click classes are gone,
    // proving this is a targeted class strip, not a broader element removal.
    expect(container.textContent).toBe(letters);
    expect(container.querySelectorAll("span")).toHaveLength(9);
  });

  it("preserves an allowed class that happens to share no name with a privileged or delegated-click one", () => {
    const fragment = sanitizePluginMarkdownProjection(
      '<span class="cite-citation internal-link">Doe 2024</span>',
    );
    const container = document.createElement("div");
    container.append(fragment);
    const span = container.querySelector("span");
    expect(span?.classList.contains("cite-citation")).toBe(true);
    expect(span?.classList.contains("internal-link")).toBe(false);
  });
});

describe("sanitizeDataviewProjection", () => {
  it("re-authors only vault-local Markdown file cells as native internal links", () => {
    const fragment = sanitizeDataviewProjection(
      [
        '<a class="internal-link" href="#" data-href="Folder/Note.md#Result">Note</a>',
        '<a href="#" data-href="https://example.com">External</a>',
        '<a href="#" data-href="../Secret.md">Traversal</a>',
      ].join(""),
      "Queries/Dashboard.md",
    );
    const anchors = [...fragment.querySelectorAll<HTMLAnchorElement>("a")];
    expect(anchors[0]?.outerHTML).toContain('data-threadleaf-path="Folder/Note.md"');
    expect(anchors[0]?.dataset.threadleafSubpath).toBe("#Result");
    expect(anchors[0]?.dataset.threadleafOriginPath).toBe("Queries/Dashboard.md");
    expect(anchors[0]?.dataset.linkStatus).toBe("resolved");
    expect(anchors[0]?.getAttribute("href")).toBe("#");
    for (const anchor of anchors.slice(1)) {
      expect(anchor.hasAttribute("href")).toBe(false);
      expect(anchor.dataset.threadleafLink).toBeUndefined();
    }
  });
});
