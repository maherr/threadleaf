// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type {
  VaultImageResponse,
  VaultNoteEmbedResponse,
  WorkspaceLinkSummary,
} from "../shared/contracts";
import {
  addPreviewSourceControls,
  hydrateMarkdownPreview,
  hydrateMarkdownPreviewImages,
  renderMarkdownPreview,
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
});
