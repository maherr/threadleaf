import { describe, expect, it } from "vitest";
import { parseLivePreviewLine } from "./live-preview";

describe("live preview inline model", () => {
  it("recognizes source-backed wikilinks, aliases, embeds, and subpaths", () => {
    const source = "See [[Projects/Atlas#Plan|the plan]] and ![[Sketch.png|wireframe]].";

    expect(parseLivePreviewLine(source, 100)).toEqual([
      {
        from: 104,
        to: 136,
        kind: "link",
        label: "the plan",
        link: {
          syntax: "wiki",
          target: "Projects/Atlas",
          subpath: "#Plan",
          label: "the plan",
          embed: false,
          external: false,
        },
      },
      {
        from: 141,
        to: 166,
        kind: "image",
        label: "wireframe",
        link: {
          syntax: "wiki",
          target: "Sketch.png",
          subpath: null,
          label: "wireframe",
          embed: true,
          external: false,
        },
      },
    ]);
  });

  it("recognizes simple Markdown links and leaves titled destinations honest source", () => {
    const source = '[local](notes/a.md#Part) [web](https://example.com) [titled](a.md "A")';

    expect(parseLivePreviewLine(source, 0)).toMatchObject([
      {
        from: 0,
        to: 24,
        kind: "link",
        label: "local",
        link: {
          syntax: "markdown",
          target: "notes/a.md",
          subpath: "#Part",
          external: false,
        },
      },
      {
        from: 25,
        to: 51,
        kind: "link",
        label: "web",
        link: {
          syntax: "markdown",
          target: "https://example.com",
          subpath: null,
          external: true,
        },
      },
    ]);
    expect(parseLivePreviewLine(source, 0)).toHaveLength(2);
  });

  it("marks callouts and Unicode tags without consuming their leading whitespace", () => {
    const source = "> [!important]+ Read #résumé and #project/atlas";

    expect(parseLivePreviewLine(source, 20)).toEqual([
      { from: 22, to: 35, kind: "callout", label: "important" },
      { from: 41, to: 48, kind: "tag", label: "résumé" },
      { from: 53, to: 67, kind: "tag", label: "project/atlas" },
    ]);
  });

  it("does not decorate tokens protected by inline or fenced code ranges", () => {
    const source = "`[[literal]]` and [[real]]";

    expect(parseLivePreviewLine(source, 0, [{ from: 0, to: 13 }])).toEqual([
      {
        from: 18,
        to: 26,
        kind: "link",
        label: "real",
        link: {
          syntax: "wiki",
          target: "real",
          subpath: null,
          label: "real",
          embed: false,
          external: false,
        },
      },
    ]);
  });

  it("prefers one complete wiki token over Markdown-looking inner brackets", () => {
    const source = "![[image.webp]] [[Note|Alias]]";
    const tokens = parseLivePreviewLine(source, 0);

    expect(tokens.map(({ kind, from, to }) => ({ kind, from, to }))).toEqual([
      { kind: "image", from: 0, to: 15 },
      { kind: "link", from: 16, to: 30 },
    ]);
  });
});
