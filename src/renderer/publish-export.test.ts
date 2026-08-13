// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { renderMarkdownPreview } from "./markdown-preview";
import { createStandalonePublishedNoteHtml } from "./publish-export";

function renderedFixture(): HTMLElement {
  const root = document.createElement("div");
  root.append(
    renderMarkdownPreview(
      [
        "---",
        "private: hidden",
        "---",
        "",
        "# Public heading",
        "",
        "[Website](https://example.com/docs)",
        "[Unsafe](javascript:alert(1))",
        "[[Private Note|Vault reference]]",
        "",
        "<script>alert('never')</script>",
      ].join("\n"),
    ),
  );
  const image = document.createElement("img");
  image.className = "preview-local-image";
  image.alt = "Embedded fixture";
  image.src =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  image.dataset.threadleafAssetPath = "/private/vault/image.png";
  const embed = document.createElement("section");
  embed.className = "preview-note-embed";
  embed.dataset.threadleafPath = "Private Note.md";
  const open = document.createElement("button");
  open.className = "preview-note-embed-open";
  open.textContent = "Private Note.md";
  const body = document.createElement("div");
  body.className = "preview-note-embed-body";
  body.innerHTML = '<p onclick="alert(1)">Frozen embedded content</p>';
  embed.append(open, body);
  root.append(image, embed);
  return root;
}

describe("standalone published note", () => {
  it("creates offline HTML with embedded images, honest links, and no active content", () => {
    const html = createStandalonePublishedNoteHtml('A <safe> & "portable" note', renderedFixture());
    const parsed = new DOMParser().parseFromString(html, "text/html");

    expect(parsed.title).toBe('A <safe> & "portable" note');
    expect(
      parsed.querySelector<HTMLMetaElement>("meta[http-equiv='Content-Security-Policy']")?.content,
    ).toContain("default-src 'none'");
    expect(parsed.querySelector("script")).toBeNull();
    expect(parsed.querySelector("button")).toBeNull();
    expect(parsed.querySelector("[onclick]")).toBeNull();
    expect(parsed.body.textContent).not.toContain("private: hidden");
    expect(parsed.body.textContent).toContain("Public heading");
    expect(parsed.body.textContent).toContain("Frozen embedded content");
    expect(parsed.body.textContent).not.toContain("Private Note.md");
    expect(parsed.querySelector("a")?.href).toBe("https://example.com/docs");
    expect(parsed.querySelector("a")?.rel).toBe("noreferrer noopener");
    expect(parsed.querySelectorAll(".vault-link")).toHaveLength(1);
    expect(parsed.body.textContent).toContain("Unsafe");
    expect(parsed.querySelector("img")?.src).toMatch(/^data:image\/png;base64,/u);
    expect(html).not.toContain("/private/vault");
    expect(html).not.toMatch(/data-threadleaf-(?:asset|path|revision)/u);
    expect(
      [...parsed.querySelectorAll("a")].some((anchor) => anchor.href.startsWith("javascript:")),
    ).toBe(false);
  });

  it("replaces non-embedded images instead of publishing remote or file URLs", () => {
    const root = document.createElement("div");
    const image = document.createElement("img");
    image.src = "https://example.com/tracker.png";
    image.alt = "Remote tracker";
    root.append(image);

    const parsed = new DOMParser().parseFromString(
      createStandalonePublishedNoteHtml("Remote image", root),
      "text/html",
    );
    expect(parsed.querySelector("img")).toBeNull();
    expect(parsed.querySelector<HTMLElement>(".preview-asset-placeholder")?.title).toBe(
      "Image was not embedded.",
    );
  });

  it("never republishes URLs from raw HTML navigation markers", () => {
    const root = document.createElement("div");
    root.append(
      renderMarkdownPreview(
        [
          '<a data-threadleaf-footnote-ref="true" class="preview-footnote-backref" href="https://evil.example/raw">raw external</a>',
          '<a data-threadleaf-link="external" data-threadleaf-external-url="https://evil.example/forged" href="//evil.example/forged">raw forged marker</a>',
          "",
          "A genuine note.[^source]",
          "",
          "[^source]: A local footnote.",
        ].join("\n"),
      ),
    );

    const parsed = new DOMParser().parseFromString(
      createStandalonePublishedNoteHtml("Raw HTML safety", root),
      "text/html",
    );
    expect(
      parsed.querySelectorAll("a[href^='https://evil.example'],a[href^='//evil.example']"),
    ).toHaveLength(0);
    expect(parsed.querySelectorAll(".vault-link")).toHaveLength(2);
    expect(parsed.querySelectorAll(".preview-footnote-ref")).toHaveLength(1);
    expect(parsed.querySelectorAll(".preview-footnote-backref")).toHaveLength(1);
  });

  it("keeps table, footnote, and safe math semantics in the offline fixture", () => {
    const root = document.createElement("div");
    root.append(
      renderMarkdownPreview(
        [
          "| Name | Count |",
          "| :--- | ---: |",
          "| Atlas | 42 |",
          "",
          "A result $\\alpha + \\frac{1}{2}$ has a note.[^source]",
          "",
          "[^source]: The source-backed explanation remains available.",
        ].join("\n"),
      ),
    );

    const parsed = new DOMParser().parseFromString(
      createStandalonePublishedNoteHtml("Semantic fixture", root),
      "text/html",
    );
    expect(parsed.querySelector("table.preview-gfm-table")).not.toBeNull();
    expect(parsed.querySelector("th[scope='col'].align-left")?.textContent).toBe("Name");
    expect(parsed.querySelector("th[scope='col'].align-right")?.textContent).toBe("Count");
    expect(parsed.querySelector(".preview-math .math-fraction")).not.toBeNull();
    expect(parsed.querySelector(".preview-footnotes")).not.toBeNull();
    expect(parsed.querySelector(".preview-footnote-ref")).not.toBeNull();
    expect(parsed.querySelector("#threadleaf-footnote-1-source")).not.toBeNull();
  });

  it("publishes unresolved frontmatter as inert source text", () => {
    const source = [
      "---",
      ...Array.from({ length: 256 }, (_, index) => `key${index}: value`),
      "Body $x$ [[Hidden]]",
    ].join("\n");
    const root = document.createElement("div");
    root.append(renderMarkdownPreview(source));

    const parsed = new DOMParser().parseFromString(
      createStandalonePublishedNoteHtml("Unresolved frontmatter", root),
      "text/html",
    );
    expect(parsed.body.textContent).toContain("Body $x$ [[Hidden]]");
    expect(parsed.querySelector(".preview-math")).toBeNull();
    expect(parsed.querySelector(".vault-link")).toBeNull();
    expect(parsed.querySelector(".preview-note-embed")).toBeNull();
  });
});
