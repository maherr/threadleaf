import { describe, expect, it } from "vitest";
import type { WorkspaceTreeEntry, WorkspaceTreePageDescriptor } from "../shared/contracts";
import {
  applyNavigatorTreePage,
  buildNavigatorTreeProjection,
  claimNavigatorTreePageRequests,
  createNavigatorTreeState,
} from "./navigator-tree";

function folder(path: string, childCount: number): WorkspaceTreeEntry {
  return { kind: "folder", path, title: path.slice(path.lastIndexOf("/") + 1), childCount };
}

function note(path: string): WorkspaceTreeEntry {
  return {
    kind: "note",
    path,
    title: path.slice(path.lastIndexOf("/") + 1, -3),
    tags: [],
    backlinkCount: 0,
    outgoingCount: 0,
    unresolvedCount: 0,
  };
}

function page(parentPath: string | null, total: number, offset = 0): WorkspaceTreePageDescriptor {
  return { generation: "tree:1", parentPath, offset, limit: 256, total, complete: false };
}

describe("navigator tree projection", () => {
  it("keeps a 200K root as compact virtual ranges while expanding a 1,001-child folder", () => {
    const state = createNavigatorTreeState("vault", "tree:1");
    applyNavigatorTreePage(state, page(null, 200_000), [folder("Archive", 1_001)]);
    applyNavigatorTreePage(
      state,
      page("Archive", 1_001),
      Array.from({ length: 256 }, (_, index) => note(`Archive/${index}.md`)),
    );

    const collapsed = buildNavigatorTreeProjection(state, new Set());
    expect(collapsed.length).toBe(200_000);
    expect(collapsed.segmentCount).toBe(2);
    expect(collapsed.rowAt(199_999)).toMatchObject({
      kind: "placeholder",
      parentPath: null,
      offset: 199_999,
    });

    const expanded = buildNavigatorTreeProjection(state, new Set(["Archive"]));
    expect(expanded.length).toBe(201_001);
    expect(expanded.segmentCount).toBeLessThan(300);
    expect(expanded.rowAt(1)).toMatchObject({ kind: "entry", entry: { path: "Archive/0.md" } });
    expect(expanded.rowAt(300)).toMatchObject({
      kind: "placeholder",
      parentPath: "Archive",
      offset: 299,
    });
  });

  it("requests only virtual-window pages and never a whole sparse branch", () => {
    const state = createNavigatorTreeState("vault", "tree:1");
    applyNavigatorTreePage(state, page(null, 200_000), [folder("Archive", 1_001)]);
    const projection = buildNavigatorTreeProjection(state, new Set(["Archive"]));

    expect(claimNavigatorTreePageRequests(state, projection, 0, 24)).toEqual([
      { parentPath: "Archive", offset: 0, limit: 256 },
    ]);
    expect(claimNavigatorTreePageRequests(state, projection, 80_000, 80_024)).toEqual([
      { parentPath: null, offset: 79_872, limit: 256 },
    ]);
  });

  it("locates loaded paths in their visible flattened position", () => {
    const state = createNavigatorTreeState("vault", "tree:1");
    applyNavigatorTreePage(state, page(null, 1), [folder("Projects", 1)]);
    applyNavigatorTreePage(state, page("Projects", 1), [note("Projects/Active.md")]);

    const projection = buildNavigatorTreeProjection(state, new Set(["Projects"]));
    expect(projection.indexOfPath("Projects/Active.md")).toBe(1);
  });
});
