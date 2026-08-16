import { describe, expect, it } from "vitest";
import { buildWorkspaceTreeIndex } from "./workspace-tree";

describe("workspace visible-inventory tree", () => {
  it("keeps explicit empty folders and gives every visible file a minimal typed row", () => {
    const index = buildWorkspaceTreeIndex({
      folders: ["Projects/Nested", "Empty", "Projects", "Archive"],
      files: [
        "zeta.md",
        "Projects/item10.md",
        "Projects/item2.md",
        "Projects/Board.canvas",
        "Projects/image.PNG",
        "Alpha.md",
      ],
    });

    expect(index.childrenByParent.get(null)).toEqual([
      { kind: "folder", path: "Archive", title: "Archive", childCount: 0 },
      { kind: "folder", path: "Empty", title: "Empty", childCount: 0 },
      { kind: "folder", path: "Projects", title: "Projects", childCount: 5 },
      { kind: "note", path: "Alpha.md", title: "Alpha" },
      { kind: "note", path: "zeta.md", title: "zeta" },
    ]);
    expect(index.childrenByParent.get("Projects")).toEqual([
      { kind: "folder", path: "Projects/Nested", title: "Nested", childCount: 0 },
      { kind: "canvas", path: "Projects/Board.canvas", title: "Board" },
      { kind: "file", path: "Projects/image.PNG", title: "image.PNG" },
      { kind: "note", path: "Projects/item2.md", title: "item2" },
      { kind: "note", path: "Projects/item10.md", title: "item10" },
    ]);

    for (const entries of index.childrenByParent.values()) {
      for (const entry of entries) {
        expect(Object.keys(entry).sort()).toEqual(
          entry.kind === "folder"
            ? ["childCount", "kind", "path", "title"]
            : ["kind", "path", "title"],
        );
      }
    }
    expect(index.folderPaths).toEqual(new Set(["Archive", "Empty", "Projects", "Projects/Nested"]));
  });

  it("uses a locale-independent folder-first natural order with explicit raw tie-breaks", () => {
    const decomposed = "e\u0301clair.md";
    const composed = "éclair.md";
    const index = buildWorkspaceTreeIndex({
      folders: [],
      files: [
        "item10.md",
        composed,
        "alpha.md",
        "_under.md",
        decomposed,
        "item2.md",
        "Alpha.md",
        "-dash.md",
      ],
    });

    expect(index.childrenByParent.get(null)?.map(({ path }) => path)).toEqual([
      "-dash.md",
      "_under.md",
      "Alpha.md",
      "alpha.md",
      decomposed,
      composed,
      "item2.md",
      "item10.md",
    ]);
  });

  it("keeps every safe kind and its ancestor chain addressable without inventing hidden rows", () => {
    const index = buildWorkspaceTreeIndex({
      folders: ["日本語", "日本語/مرحبا", ".obsidian", "Visible/.secret"],
      files: [
        "日本語/مرحبا/éclair.md",
        "日本語/مرحبا/Board.canvas",
        "日本語/مرحبا/photo.avif",
        ".obsidian/Private.md",
        "Visible/.secret/Hidden.md",
        "../Outside.md",
        "Windows\\Path.md",
      ],
    });

    expect(index.childrenByParent.get(null)).toEqual([
      { kind: "folder", path: "日本語", title: "日本語", childCount: 1 },
    ]);
    for (const filePath of [
      "日本語/مرحبا/éclair.md",
      "日本語/مرحبا/Board.canvas",
      "日本語/مرحبا/photo.avif",
    ]) {
      expect(index.pathLocations.get(filePath)).toEqual({
        path: filePath,
        pages: [
          { parentPath: null, offset: 0 },
          { parentPath: "日本語", offset: 0 },
          { parentPath: "日本語/مرحبا", offset: expect.any(Number) },
        ],
      });
    }
    expect(index.folderPaths.has(".obsidian")).toBe(false);
    expect(index.pathLocations.has("Visible/.secret/Hidden.md")).toBe(false);
    expect(index.pathLocations.has("../Outside.md")).toBe(false);
    expect(index.pathLocations.has("Windows\\Path.md")).toBe(false);
  });
});
