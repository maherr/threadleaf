// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { addPreviewSourceControls, renderMarkdownPreview } from "./markdown-preview";

function preview(source: string): HTMLElement {
  const container = document.createElement("div");
  container.append(addPreviewSourceControls(renderMarkdownPreview(source)));
  return container;
}

describe("Markdown reading view", () => {
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
    expect(anchor?.dataset.threadleafExternalUrl).toBe("https://example.com/raw");
    expect(anchor?.getAttribute("href")).toBe("#");
  });

  it("uses inert placeholders for Markdown images until attachment serving is available", () => {
    const rendered = preview("![Architecture](assets/architecture.png)");
    const placeholder = rendered.querySelector<HTMLElement>(".preview-asset-placeholder");

    expect(rendered.querySelector("img")).toBeNull();
    expect(placeholder?.textContent).toBe("Image: Architecture");
    expect(placeholder?.dataset.threadleafAsset).toBe("assets/architecture.png");
  });
});
