import { describe, expect, it } from "vitest";
import type { VaultGraphNode, VaultGraphProjection } from "../shared/contracts";
import { GRAPH_VIEWBOX_HEIGHT, GRAPH_VIEWBOX_WIDTH, layoutVaultGraph } from "./graph-layout";

function node(path: string, distance: number | null, weight = 1): VaultGraphNode {
  return {
    path,
    title: path.replace(/\.md$/u, ""),
    tags: [],
    incomingCount: weight,
    outgoingCount: 0,
    neighborCount: weight,
    distance,
  };
}

function projection(mode: "global" | "local"): VaultGraphProjection {
  return {
    mode,
    rootPath: mode === "local" ? "Root.md" : null,
    depth: 2,
    query: "",
    includeOrphans: true,
    totalNodes: 4,
    totalEdges: 3,
    truncated: false,
    nodes: [
      node("Root.md", mode === "local" ? 0 : null, 4),
      node("A.md", mode === "local" ? 1 : null, 2),
      node("B.md", mode === "local" ? 1 : null),
      node("C.md", mode === "local" ? 2 : null),
    ],
    edges: [],
  };
}

describe("graph layout", () => {
  it("keeps a local root centered and places each distance on a separate ring", () => {
    const layout = layoutVaultGraph(projection("local"));
    expect(layout.find(({ path }) => path === "Root.md")).toMatchObject({
      x: GRAPH_VIEWBOX_WIDTH / 2,
      y: GRAPH_VIEWBOX_HEIGHT / 2,
    });
    const distanceFromCenter = (path: string): number => {
      const item = layout.find((candidate) => candidate.path === path);
      if (!item) {
        throw new Error(`Missing positioned node ${path}`);
      }
      return Math.hypot(item.x - GRAPH_VIEWBOX_WIDTH / 2, item.y - GRAPH_VIEWBOX_HEIGHT / 2);
    };
    expect(distanceFromCenter("C.md")).toBeGreaterThan(distanceFromCenter("A.md"));
  });

  it("is deterministic, bounded, and gives higher-connectivity nodes more visual weight", () => {
    const first = layoutVaultGraph(projection("global"));
    expect(layoutVaultGraph(projection("global"))).toEqual(first);
    for (const item of first) {
      expect(item.x).toBeGreaterThanOrEqual(0);
      expect(item.x).toBeLessThanOrEqual(GRAPH_VIEWBOX_WIDTH);
      expect(item.y).toBeGreaterThanOrEqual(0);
      expect(item.y).toBeLessThanOrEqual(GRAPH_VIEWBOX_HEIGHT);
    }
    expect(first.find(({ path }) => path === "Root.md")?.radius).toBeGreaterThan(
      first.find(({ path }) => path === "C.md")?.radius ?? Number.MAX_SAFE_INTEGER,
    );
  });
});
