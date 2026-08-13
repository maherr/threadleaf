import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildLivePreviewMapping,
  measureLivePreviewMapping,
  parseLivePreviewLine,
  resolveInlineTransclusions,
} from "./live-preview";

interface FixtureToken {
  kind: string;
  from: number;
  to: number;
  status: "mapped" | "fallback";
  renderedText: string;
}

interface FixtureCase {
  id: string;
  source: string;
  protected?: [number, number][];
  tokens: FixtureToken[];
  roundTrips?: number[];
  fallbackContains?: string;
}

const fixture = JSON.parse(
  readFileSync(
    new URL("../../fixtures/live-preview-mapping-v1/cases.json", import.meta.url),
    "utf8",
  ),
) as { version: number; cases: FixtureCase[] };

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

  it("maps supported footnote references and math to source-backed generated text", () => {
    const source = [
      "A result[^one] and \\(x^2 + \\frac{1}{2}\\).",
      "",
      "[^one]: A source-backed explanation.",
    ].join("\n");
    const mapping = buildLivePreviewMapping(source);
    const footnote = mapping.tokens.find((token) => token.kind === "footnote-ref");
    const math = mapping.tokens.find((token) => token.kind === "math");
    expect(footnote?.status).toBe("mapped");
    expect(math?.status).toBe("mapped");
    expect(mapping.rendered).toContain("one");
    expect(mapping.rendered).toContain("x^2 + 1/2");
    expect(mapping.source).toBe(source);
    expect(new TextEncoder().encode(mapping.source)).toEqual(new TextEncoder().encode(source));
  });

  it("keeps unknown math and duplicate footnote definitions as source fallbacks", () => {
    const source = [
      "Unknown $\\notARealCommand{x}$ and [^dup].",
      "",
      "[^dup]: first",
      "[^dup]: second",
    ].join("\n");
    const mapping = buildLivePreviewMapping(source);
    expect(
      mapping.tokens.some(
        (token) =>
          token.status === "fallback" && token.sourceText.includes("$\\notARealCommand{x}$"),
      ),
    ).toBe(true);
    expect(mapping.tokens.some((token) => token.kind === "footnote-ref")).toBe(false);
    expect(mapping.rendered).toContain("$\\notARealCommand{x}$");
    expect(mapping.rendered).toContain("[^dup]: first");
    expect(mapping.rendered).toContain("[^dup]: second");
  });

  it("keeps footnote definition lines source-visible while references remain revealable", () => {
    const source = [
      "Text[^one]",
      "",
      "[^one]: Keep this exact source.",
      "    And [^nested] and $x$ remain source.",
    ].join("\n");
    const mapping = buildLivePreviewMapping(source);
    expect(mapping.tokens.filter((token) => token.kind === "source-block")).toHaveLength(2);
    expect(mapping.tokens.some((token) => token.kind === "math")).toBe(false);
    expect(
      mapping.tokens.some(
        (token) => token.kind === "footnote-ref" && token.sourceText.includes("nested"),
      ),
    ).toBe(false);
    expect(mapping.rendered).toContain("    And [^nested] and $x$ remain source.");
    const reference = mapping.tokens.find((token) => token.kind === "footnote-ref");
    expect(reference?.renderedText).toBe("one");
    expect(mapping.mapRenderedSelection(reference?.rendered ?? { from: 0, to: 0 })).toEqual({
      from: reference?.from,
      to: reference?.to,
    });
  });

  it("keeps adversarial unmatched and deeply nested math source-visible", () => {
    let nested = "x";
    for (let index = 0; index < 2_048; index += 1) {
      nested = String.raw`\frac{${nested}}{1}`;
    }
    expect(() => buildLivePreviewMapping(String.raw`\(${nested}\)`)).not.toThrow();
    expect(
      buildLivePreviewMapping(String.raw`\(${nested}\)`).tokens.some(
        (token) => token.kind === "math" && token.status === "mapped",
      ),
    ).toBe(false);

    const unmatched = String.raw`\(`.repeat(50_000);
    expect(() => parseLivePreviewLine(unmatched, 0)).not.toThrow();
    expect(parseLivePreviewLine(unmatched, 0)).toEqual([]);
  });

  it("does not decorate malformed footnote continuations or unresolved frontmatter", () => {
    const malformed = [
      "[^bad id]: malformed definition",
      "    Continuation $x$ and [[Embed]] stay source.",
      "Normal $y$ remains renderable.",
    ].join("\n");
    const mapping = buildLivePreviewMapping(malformed);
    expect(
      mapping.tokens.some((token) => token.kind === "math" && token.sourceText === "$x$"),
    ).toBe(false);
    expect(
      mapping.tokens.some((token) => token.kind === "math" && token.sourceText === "$y$"),
    ).toBe(true);

    const unresolved = [
      "---",
      ...Array.from({ length: 255 }, (_, index) => `key${index}: value`),
      "Body $x$ and [[Embed]]",
    ].join("\n");
    const unresolvedMapping = buildLivePreviewMapping(unresolved);
    expect(unresolvedMapping.tokens.some((token) => token.kind === "math")).toBe(false);
    expect(unresolvedMapping.tokens.some((token) => token.kind === "link")).toBe(false);
  });

  it("keeps resolved CR-only and mixed frontmatter source-only", () => {
    for (const source of [
      "---\rkind: fixture\r---\rBody $x$ and [[Embed]]",
      "---\r\nkind: fixture\n---\rBody $x$ and [[Embed]]",
      "---\nkind: fixture\r---\r\nBody $x$ and [[Embed]]",
    ]) {
      const mapping = buildLivePreviewMapping(source);
      expect(mapping.tokens.some((token) => token.kind === "math")).toBe(true);
      expect(mapping.tokens.some((token) => token.kind === "link")).toBe(true);
      expect(
        mapping.tokens.some(
          (token) =>
            (token.kind === "math" || token.kind === "link") &&
            token.sourceText.includes("kind: fixture"),
        ),
      ).toBe(false);
    }
  });
});

describe("source/decorated mapping fixture", () => {
  it("matches every public delimiter and nested-combination offset", () => {
    expect(fixture.version).toBe(1);
    for (const testCase of fixture.cases) {
      const protectedRanges = testCase.protected?.map(([from, to]) => ({ from, to }));
      const mapping = protectedRanges
        ? buildLivePreviewMapping(testCase.source, { protectedRanges })
        : buildLivePreviewMapping(testCase.source);
      const tokens = mapping.tokens
        .filter((token) => token.kind !== "delimiter")
        .map(({ kind, from, to, status, renderedText }) => ({
          kind,
          from,
          to,
          status,
          renderedText,
        }));
      const delimiters = mapping.tokens
        .filter((token) => token.kind === "delimiter")
        .map(({ kind, from, to, status, renderedText }) => ({
          kind,
          from,
          to,
          status,
          renderedText,
        }));
      const expected = testCase.tokens.filter((token) => token.kind !== "delimiter");
      const expectedDelimiters = testCase.tokens.filter((token) => token.kind === "delimiter");
      expect(tokens, testCase.id).toEqual(expected);
      expect(delimiters, testCase.id).toEqual(expectedDelimiters);
      if (testCase.fallbackContains) {
        expect(
          mapping.tokens.some(
            (token) =>
              token.status === "fallback" &&
              token.sourceText.includes(testCase.fallbackContains as string),
          ),
          testCase.id,
        ).toBe(true);
      }
      for (const sourcePosition of testCase.roundTrips ?? []) {
        const renderedPosition = mapping.sourceToRendered(sourcePosition, "inside");
        const recovered = mapping.renderedToSource(renderedPosition, "inside");
        expect(
          recovered,
          `${testCase.id} source position ${sourcePosition}`,
        ).toBeGreaterThanOrEqual(0);
        expect(recovered, `${testCase.id} source position ${sourcePosition}`).toBeLessThanOrEqual(
          testCase.source.length,
        );
      }
    }
  });

  it("maps compound-link boundaries with explicit affinity and preserves source bytes", () => {
    const source = "\uFEFF [[Notes/Plan.md|Résumé]] and **bold**\r\n";
    const mapping = buildLivePreviewMapping(source);
    expect(mapping.source).toBe(source);
    expect(new TextEncoder().encode(mapping.source)).toEqual(new TextEncoder().encode(source));
    const link = mapping.tokens.find((token) => token.kind === "link");
    expect(link?.status).toBe("mapped");
    const before = mapping.sourceToRendered(link?.from ?? 0, "before");
    const after = mapping.sourceToRendered(link?.to ?? 0, "after");
    expect(before).toBeLessThanOrEqual(after);
    expect(mapping.renderedToSource(before, "before")).toBeGreaterThanOrEqual(link?.from ?? 0);
    expect(mapping.renderedToSource(after, "after")).toBeLessThanOrEqual(link?.to ?? source.length);
    expect(mapping.mapRenderedSelection({ from: before, to: after }, "inside")).toEqual({
      from: link?.from,
      to: link?.to,
    });
  });

  it("keeps malformed compound syntax in deterministic source fallback", () => {
    const source = "[bad](path/(nested).md) and [good](path.md)";
    const mapping = buildLivePreviewMapping(source);
    const fallback = mapping.tokens.find((token) => token.status === "fallback");
    expect(fallback?.sourceText).toContain("[bad](path/(nested)");
    expect(mapping.segments.some((segment) => segment.kind === "fallback")).toBe(true);
    expect(mapping.rendered).toContain("[bad](path/(nested)");
  });
});

describe("bounded source-backed transclusion", () => {
  it("resolves local fragments, records owners, and stops a cycle", () => {
    const documents = new Map([
      ["Root.md", "# Root\n![[Child.md#Part]]"],
      ["Child.md", "# Part\nchild body\n![[Root.md]]"],
    ]);
    const [root] = resolveInlineTransclusions("Root.md", documents.get("Root.md") ?? "", documents);
    expect(root).toMatchObject({
      ownerPath: "Root.md",
      target: "Child.md",
      subpath: "#Part",
      depth: 1,
      status: "ready",
      content: "# Part\nchild body\n![[Root.md]]",
    });
    expect(root?.children[0]).toMatchObject({
      ownerPath: "Child.md",
      target: "Root.md",
      status: "cycle",
      content: null,
    });
    expect(root?.source.from).toBe("# Root\n".length);
  });

  it("uses shared depth and byte budgets without touching source", () => {
    const documents = new Map([
      ["A.md", "![[B.md]]"],
      ["B.md", "![[C.md]]"],
      ["C.md", "leaf"],
    ]);
    const source = documents.get("A.md") ?? "";
    const nodes = resolveInlineTransclusions("A.md", source, documents, {
      maxDepth: 1,
      maxBytes: 1,
    });
    expect(source).toBe("![[B.md]]");
    expect(nodes[0]?.status).toBe("byte-limit");
    expect(nodes[0]?.ownerPath).toBe("A.md");
  });
});

describe("mapping measurement", () => {
  it("reports linear-shape metrics for a long note without a timing claim", () => {
    const source = Array.from(
      { length: 10_000 },
      (_, index) => `line ${index} **text** $x_${index}$`,
    ).join("\n");
    const metrics = measureLivePreviewMapping(source);
    expect(metrics.sourceLength).toBe(source.length);
    expect(metrics.renderedLength).toBeLessThanOrEqual(source.length);
    expect(metrics.segmentCount).toBeLessThan(source.length * 2);
    expect(metrics.tokenCount).toBeGreaterThan(0);
    expect(Number.isFinite(metrics.elapsedMs)).toBe(true);
    expect(metrics.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});
