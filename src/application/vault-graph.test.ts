import { describe, expect, it } from "vitest";
import type { MetadataIndexSnapshot } from "../kernel/metadata-index";
import { parseVaultGraphRequest, projectVaultGraph } from "./vault-graph";

function graphFixture(): MetadataIndexSnapshot {
  const documents = [
    {
      path: "Alpha.md",
      revision: "a",
      headings: [],
      tags: ["project"],
      tagCounts: { project: 1 },
      properties: {},
      links: [
        {
          target: "Beta",
          subpath: null,
          alias: null,
          embed: false,
          syntax: "wiki" as const,
          resolution: { status: "resolved" as const, path: "Beta.md" },
        },
        {
          target: "Beta",
          subpath: "#Plan",
          alias: "Plan",
          embed: false,
          syntax: "wiki" as const,
          resolution: { status: "resolved" as const, path: "Beta.md" },
        },
      ],
    },
    {
      path: "Beta.md",
      revision: "b",
      headings: [],
      tags: ["reference"],
      tagCounts: { reference: 1 },
      properties: {},
      links: [
        {
          target: "Folder/Gamma",
          subpath: null,
          alias: null,
          embed: false,
          syntax: "markdown" as const,
          resolution: { status: "resolved" as const, path: "Folder/Gamma.md" },
        },
      ],
    },
    {
      path: "Folder/Gamma.md",
      revision: "c",
      headings: [],
      tags: ["project"],
      tagCounts: { project: 1 },
      properties: {},
      links: [],
    },
    {
      path: "Orphan.md",
      revision: "d",
      headings: [],
      tags: ["project"],
      tagCounts: { project: 1 },
      properties: {},
      links: [],
    },
  ];
  return {
    documents,
    tags: [],
    backlinks: documents.map((document) => ({ path: document.path, sources: [] })),
    duplicateNames: [],
  };
}

describe("vault graph projection", () => {
  it("parses and bounds renderer requests at the application boundary", () => {
    expect(
      parseVaultGraphRequest({
        mode: "local",
        rootPath: " Folder/Note ",
        depth: 4,
        query: "  project  ",
        includeOrphans: false,
      }),
    ).toEqual({
      mode: "local",
      rootPath: "Folder/Note.md",
      depth: 4,
      query: "project",
      includeOrphans: false,
    });
    expect(() =>
      parseVaultGraphRequest({
        mode: "local",
        rootPath: null,
        depth: 1,
        query: "",
        includeOrphans: false,
      }),
    ).toThrow("requires a Markdown root path");
    expect(() =>
      parseVaultGraphRequest({
        mode: "global",
        rootPath: null,
        depth: 5,
        query: "",
        includeOrphans: false,
      }),
    ).toThrow("integer between 1 and 4");
  });

  it("deduplicates directed edges, counts occurrences, and omits orphans by default", () => {
    const graph = projectVaultGraph(graphFixture(), {
      mode: "global",
      rootPath: null,
      depth: 1,
      query: "",
      includeOrphans: false,
    });

    expect(graph).toMatchObject({
      mode: "global",
      totalNodes: 3,
      totalEdges: 2,
      truncated: false,
    });
    expect(graph.edges).toEqual([
      { source: "Alpha.md", target: "Beta.md", occurrences: 2 },
      { source: "Beta.md", target: "Folder/Gamma.md", occurrences: 1 },
    ]);
    expect(graph.nodes.find(({ path }) => path === "Beta.md")).toMatchObject({
      incomingCount: 2,
      outgoingCount: 1,
      neighborCount: 2,
      distance: null,
    });
  });

  it("includes orphans and filters by path, title, and tags with AND terms", () => {
    const all = projectVaultGraph(graphFixture(), {
      mode: "global",
      rootPath: null,
      depth: 1,
      query: "project orphan",
      includeOrphans: true,
    });
    expect(all.nodes.map(({ path }) => path)).toEqual(["Orphan.md"]);
    expect(all.totalEdges).toBe(0);

    const tagged = projectVaultGraph(graphFixture(), {
      mode: "global",
      rootPath: null,
      depth: 1,
      query: "project",
      includeOrphans: true,
    });
    expect(tagged.nodes.map(({ path }) => path)).toEqual([
      "Alpha.md",
      "Folder/Gamma.md",
      "Orphan.md",
    ]);
  });

  it("builds an undirected local neighborhood at the requested depth and keeps the root", () => {
    const depthOne = projectVaultGraph(graphFixture(), {
      mode: "local",
      rootPath: "Beta.md",
      depth: 1,
      query: "project",
      includeOrphans: false,
    });
    expect(depthOne.nodes.map(({ path }) => path)).toEqual([
      "Alpha.md",
      "Beta.md",
      "Folder/Gamma.md",
    ]);
    expect(depthOne.nodes.find(({ path }) => path === "Beta.md")?.distance).toBe(0);
    expect(depthOne.nodes.find(({ path }) => path === "Alpha.md")?.distance).toBe(1);

    const depthOneFromAlpha = projectVaultGraph(graphFixture(), {
      mode: "local",
      rootPath: "Alpha.md",
      depth: 1,
      query: "",
      includeOrphans: false,
    });
    expect(depthOneFromAlpha.nodes.map(({ path }) => path)).toEqual(["Alpha.md", "Beta.md"]);

    const depthTwo = projectVaultGraph(graphFixture(), {
      mode: "local",
      rootPath: "Alpha.md",
      depth: 2,
      query: "",
      includeOrphans: false,
    });
    expect(depthTwo.nodes.map(({ path }) => path)).toEqual([
      "Alpha.md",
      "Beta.md",
      "Folder/Gamma.md",
    ]);
  });

  it("reports deterministic node and edge truncation", () => {
    const graph = projectVaultGraph(graphFixture(), {
      mode: "global",
      rootPath: null,
      depth: 1,
      query: "",
      includeOrphans: true,
      maxNodes: 2,
      maxEdges: 1,
    });
    expect(graph).toMatchObject({ totalNodes: 4, totalEdges: 2, truncated: true });
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges.length).toBeLessThanOrEqual(1);
  });

  it("fails explicitly when the local root is not indexed", () => {
    expect(() =>
      projectVaultGraph(graphFixture(), {
        mode: "local",
        rootPath: "Missing.md",
        depth: 1,
        query: "",
        includeOrphans: false,
      }),
    ).toThrow("local graph root is not indexed");
  });
});
