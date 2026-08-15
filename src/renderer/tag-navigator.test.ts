import { describe, expect, it } from "vitest";
import type { WorkspaceTagSummary } from "../shared/contracts";
import { buildTagNavigatorProjection, expandableTagKeys } from "./tag-navigator";

const tags: WorkspaceTagSummary[] = [
  { key: "project", tag: "Project", parentKey: null, directCount: 1, count: 4 },
  {
    key: "project/threadleaf",
    tag: "Project/Threadleaf",
    parentKey: "project",
    directCount: 2,
    count: 3,
  },
  {
    key: "project/threadleaf/parser",
    tag: "Project/Threadleaf/Parser",
    parentKey: "project/threadleaf",
    directCount: 1,
    count: 1,
  },
  {
    key: "2026/threadleaf",
    tag: "2026/Threadleaf",
    parentKey: null,
    directCount: 1,
    count: 1,
  },
];

describe("tag navigator projection", () => {
  it("builds a deterministic visible hierarchy and keeps synthetic numeric parents absent", () => {
    const projection = buildTagNavigatorProjection(tags, expandableTagKeys(tags));

    expect(
      projection.rows.map((row) => [row.label, row.depth, row.tag.count, row.tag.directCount]),
    ).toEqual([
      ["2026/Threadleaf", 1, 1, 1],
      ["Project", 1, 4, 1],
      ["Threadleaf", 2, 3, 2],
      ["Parser", 3, 1, 1],
    ]);
    expect(projection.indexByKey.get("project/threadleaf/parser")).toBe(3);
  });

  it("hides descendants of a collapsed row without losing the catalog", () => {
    const projection = buildTagNavigatorProjection(tags, new Set());

    expect(projection.rows.map((row) => row.tag.key)).toEqual(["2026/threadleaf", "project"]);
    expect(projection.childKeys.get("project")).toEqual(["project/threadleaf"]);
  });
});
