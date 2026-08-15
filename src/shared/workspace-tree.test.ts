import { describe, expect, it } from "vitest";
import type { WorkspaceFileSummary } from "./contracts";
import { buildWorkspaceTreeIndex } from "./workspace-tree";

function file(path: string): WorkspaceFileSummary {
  return {
    path,
    title: path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, ""),
    tags: [],
    backlinkCount: 0,
    outgoingCount: 0,
    unresolvedCount: 0,
  };
}

describe("workspace tree index", () => {
  it("builds immediate children with folders before naturally sorted notes", () => {
    const index = buildWorkspaceTreeIndex([
      file("zeta.md"),
      file("Projects/10.md"),
      file("Projects/2.md"),
      file("Alpha.md"),
      file("Archive/Readme.md"),
    ]);

    expect(index.childrenByParent.get(null)).toEqual([
      { kind: "folder", path: "Archive", title: "Archive", childCount: 1 },
      { kind: "folder", path: "Projects", title: "Projects", childCount: 2 },
      expect.objectContaining({ kind: "note", path: "Alpha.md" }),
      expect.objectContaining({ kind: "note", path: "zeta.md" }),
    ]);
    expect(index.childrenByParent.get("Projects")).toEqual([
      expect.objectContaining({ kind: "note", path: "Projects/2.md" }),
      expect.objectContaining({ kind: "note", path: "Projects/10.md" }),
    ]);
  });

  it("keeps unicode and deep paths addressable while excluding hidden and malformed paths", () => {
    const index = buildWorkspaceTreeIndex([
      file("日本語/مرحبا/éclair.md"),
      file(".obsidian/Private.md"),
      file("Visible/.secret/Hidden.md"),
      file("../Outside.md"),
      file("Windows\\Path.md"),
    ]);

    expect(index.childrenByParent.get(null)).toEqual([
      { kind: "folder", path: "日本語", title: "日本語", childCount: 1 },
    ]);
    expect(index.pathLocations.get("日本語/مرحبا/éclair.md")).toEqual({
      path: "日本語/مرحبا/éclair.md",
      pages: [
        { parentPath: null, offset: 0 },
        { parentPath: "日本語", offset: 0 },
        { parentPath: "日本語/مرحبا", offset: 0 },
      ],
    });
    expect(index.pathLocations.has(".obsidian/Private.md")).toBe(false);
    expect(index.pathLocations.has("Visible/.secret/Hidden.md")).toBe(false);
    expect(index.pathLocations.has("../Outside.md")).toBe(false);
  });
});
