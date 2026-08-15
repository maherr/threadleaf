import { describe, expect, it } from "vitest";
import type { WorkspaceTreeEntry, WorkspaceTreePageDescriptor } from "../shared/contracts";
import {
  applyNavigatorTreePage,
  buildNavigatorTreeProjection,
  claimNavigatorTreePageRequest,
  claimNavigatorTreePageRequests,
  completeNavigatorTreePageRequest,
  createNavigatorTreeState,
  maximumNavigatorTreeLruPages,
  type NavigatorTreeState,
  navigatorTreePageRequestsForRange,
  navigatorTreeRetentionCounts,
  retainNavigatorTreePages,
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

function expectHonestRetentionBound(state: NavigatorTreeState, pageSize = 256) {
  const counts = navigatorTreeRetentionCounts(state);
  expect(counts.parentDescriptors).toBe(state.pages.size);
  expect(counts.parentDescriptors).toBeLessThanOrEqual(counts.pages);
  expect(counts.lruPages).toBeLessThanOrEqual(maximumNavigatorTreeLruPages);
  expect(counts.pages).toBeLessThanOrEqual(counts.mandatoryPages + maximumNavigatorTreeLruPages);
  expect(counts.entries).toBeLessThanOrEqual(
    (counts.mandatoryPages + maximumNavigatorTreeLruPages) * pageSize,
  );
  return counts;
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

  it("bounds retained pages and entries throughout a full 200K traversal and refetches evicted ends", () => {
    const state = createNavigatorTreeState("vault", "tree:1");
    const total = 200_000;
    const limit = 256;
    let maximumPages = 0;
    let maximumEntries = 0;

    const entriesFor = (offset: number): WorkspaceTreeEntry[] =>
      Array.from({ length: Math.min(limit, total - offset) }, (_, index) =>
        note(`Root ${String(offset + index).padStart(6, "0")}.md`),
      );
    const load = (offset: number, alreadyClaimed = false): void => {
      const request = { parentPath: null, offset, limit };
      if (alreadyClaimed) {
        // The assertion directly before this call proves the refetch claim.
      } else if (offset === 0 && !state.pages.has(null)) {
        expect(claimNavigatorTreePageRequest(state, request)).toBe(true);
      } else {
        const projection = buildNavigatorTreeProjection(state, new Set());
        expect(claimNavigatorTreePageRequests(state, projection, offset, offset + 1)).toEqual([
          request,
        ]);
      }
      retainNavigatorTreePages(state, [request]);
      const entries = entriesFor(offset);
      applyNavigatorTreePage(
        state,
        {
          generation: state.generation,
          parentPath: null,
          offset,
          limit,
          total,
          complete: offset + entries.length >= total,
        },
        entries,
      );
      completeNavigatorTreePageRequest(state, request.parentPath, request.offset);
      const counts = expectHonestRetentionBound(state, limit);
      maximumPages = Math.max(maximumPages, counts.pages);
      maximumEntries = Math.max(maximumEntries, counts.entries);
    };

    for (let offset = 0; offset < total; offset += limit) {
      load(offset);
    }

    const afterTraversal = buildNavigatorTreeProjection(state, new Set());
    expect(maximumPages).toBeLessThanOrEqual(maximumNavigatorTreeLruPages + 1);
    expect(maximumEntries).toBeLessThanOrEqual((maximumNavigatorTreeLruPages + 1) * limit);
    expect(afterTraversal.segmentCount).toBeLessThanOrEqual(
      (maximumNavigatorTreeLruPages + 1) * limit + 1,
    );
    expect(afterTraversal.rowAt(0)).toMatchObject({ kind: "placeholder", offset: 0 });

    const homeRequest = { parentPath: null, offset: 0, limit };
    expect(claimNavigatorTreePageRequests(state, afterTraversal, 0, 1)).toEqual([homeRequest]);
    load(0, true);
    expect(buildNavigatorTreeProjection(state, new Set()).rowAt(0)).toMatchObject({
      kind: "entry",
      entry: { path: "Root 000000.md" },
    });

    for (
      let offset = limit;
      offset <= (maximumNavigatorTreeLruPages + 1) * limit;
      offset += limit
    ) {
      load(offset);
    }
    const beforeEnd = buildNavigatorTreeProjection(state, new Set());
    const endOffset = Math.floor((total - 1) / limit) * limit;
    expect(beforeEnd.rowAt(total - 1)).toMatchObject({ kind: "placeholder", offset: total - 1 });
    expect(claimNavigatorTreePageRequests(state, beforeEnd, total - 1, total)).toEqual([
      { parentPath: null, offset: endOffset, limit },
    ]);
    load(endOffset, true);
    expect(buildNavigatorTreeProjection(state, new Set()).rowAt(total - 1)).toMatchObject({
      kind: "entry",
      entry: { path: "Root 199999.md" },
    });

    const focusIndex = 100_000;
    const focusOffset = Math.floor(focusIndex / limit) * limit;
    const beforeFocus = buildNavigatorTreeProjection(state, new Set());
    expect(beforeFocus.rowAt(focusIndex)).toMatchObject({
      kind: "placeholder",
      offset: focusIndex,
    });
    expect(claimNavigatorTreePageRequests(state, beforeFocus, focusIndex, focusIndex + 1)).toEqual([
      { parentPath: null, offset: focusOffset, limit },
    ]);
    load(focusOffset, true);
    expect(buildNavigatorTreeProjection(state, new Set()).rowAt(focusIndex)).toMatchObject({
      kind: "entry",
      entry: { path: "Root 100000.md" },
    });
  });

  it("keeps the active reveal chain addressable while unrelated pages follow the LRU", () => {
    const state = createNavigatorTreeState("vault", "tree:1");
    const total = 20 * 256;
    const limit = 256;
    applyNavigatorTreePage(state, page(null, total), [folder("Projects", 1)]);
    applyNavigatorTreePage(state, page("Projects", 1), [folder("Projects/Deep", 1)]);
    applyNavigatorTreePage(state, page("Projects/Deep", 1), [note("Projects/Deep/Active.md")]);
    retainNavigatorTreePages(
      state,
      [],
      [
        { parentPath: null, offset: 0 },
        { parentPath: "Projects", offset: 0 },
        { parentPath: "Projects/Deep", offset: 0 },
      ],
    );

    for (let offset = limit; offset < total; offset += limit) {
      const entries = Array.from({ length: limit }, (_, index) =>
        note(`Root ${String(offset + index).padStart(6, "0")}.md`),
      );
      applyNavigatorTreePage(
        state,
        {
          generation: state.generation,
          parentPath: null,
          offset,
          limit,
          total,
          complete: offset + entries.length >= total,
        },
        entries,
      );
    }

    const projection = buildNavigatorTreeProjection(state, new Set(["Projects", "Projects/Deep"]));
    expect(projection.indexOfPath("Projects/Deep/Active.md")).toBe(2);
    const counts = expectHonestRetentionBound(state, limit);
    expect(counts.mandatoryPages).toBe(3);
    expect(claimNavigatorTreePageRequests(state, projection, 0, 1)).toEqual([]);
  });

  it("releases parent descriptors during 20K unique-parent churn", () => {
    const state = createNavigatorTreeState("vault", "tree:1");

    for (let index = 0; index < 20_000; index += 1) {
      const parentPath = `Parent ${String(index).padStart(5, "0")}`;
      const request = { parentPath, offset: 0, limit: 256 };
      retainNavigatorTreePages(state, [request]);
      applyNavigatorTreePage(state, page(parentPath, 1), [note(`${parentPath}/Child.md`)]);
      completeNavigatorTreePageRequest(state, parentPath, 0);
    }

    const counts = expectHonestRetentionBound(state);
    expect(counts.parentDescriptors).toBeLessThanOrEqual(maximumNavigatorTreeLruPages + 1);
  });

  it("keeps a 37-row multi-parent viewport and its active reveal chain within the honest bound", () => {
    const state = createNavigatorTreeState("vault", "tree:1");
    const limit = 256;
    const chain = Array.from(
      { length: 40 },
      (_, index) => `Depth ${String(index).padStart(2, "0")}`,
    );
    const entriesByParent = new Map<string | null, WorkspaceTreeEntry[]>();
    let parentPath: string | null = null;
    for (const [level, segment] of chain.entries()) {
      const folderPath: string = parentPath ? `${parentPath}/${segment}` : segment;
      entriesByParent.set(parentPath, [
        folder(folderPath, limit),
        ...Array.from({ length: limit - 1 }, (_, sibling) =>
          note(`${parentPath ? `${parentPath}/` : ""}Sibling ${level}-${sibling}.md`),
        ),
      ]);
      parentPath = folderPath;
    }
    const activePath = `${parentPath}/Active.md`;
    entriesByParent.set(parentPath, [
      note(activePath),
      ...Array.from({ length: limit - 1 }, (_, sibling) =>
        note(`${parentPath}/Sibling active-${sibling}.md`),
      ),
    ]);
    const revealLocations = [...entriesByParent.keys()].map((parent) => ({
      parentPath: parent,
      offset: 0,
    }));

    retainNavigatorTreePages(state, [], revealLocations);
    for (const [parent, entries] of entriesByParent) {
      const request = { parentPath: parent, offset: 0, limit };
      expect(claimNavigatorTreePageRequest(state, request)).toBe(true);
      applyNavigatorTreePage(state, page(parent, entries.length), entries);
      completeNavigatorTreePageRequest(state, parent, 0);
    }

    const expandedPaths = new Set(chain.map((_, index) => chain.slice(0, index + 1).join("/")));
    const projection = buildNavigatorTreeProjection(state, expandedPaths);
    const viewportRequests = navigatorTreePageRequestsForRange(state, projection, 0, 37);
    expect(viewportRequests).toHaveLength(37);
    retainNavigatorTreePages(state, viewportRequests, revealLocations);
    for (const request of viewportRequests) {
      const entries = entriesByParent.get(request.parentPath);
      expect(entries).toBeDefined();
      applyNavigatorTreePage(state, page(request.parentPath, entries?.length ?? 0), entries ?? []);
      completeNavigatorTreePageRequest(state, request.parentPath, request.offset);
    }

    const counts = expectHonestRetentionBound(state, limit);
    expect(counts.mandatoryPages).toBe(revealLocations.length);
    for (let index = 0; index < 37; index += 1) {
      expect(projection.rowAt(index)).toMatchObject({ kind: "entry" });
    }
    expect(projection.indexOfPath(activePath)).toBe(40);
  });
});
