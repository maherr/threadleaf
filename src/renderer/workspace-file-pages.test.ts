import { describe, expect, it } from "vitest";
import type { WorkspaceFileSummary } from "../shared/contracts";
import {
  applyWorkspaceFilePage,
  loadedWorkspaceFiles,
  reconcileWorkspaceFilePageSnapshot,
  unloadedWorkspaceFilePageOffsets,
} from "./workspace-file-pages";

function file(path: string): WorkspaceFileSummary {
  return {
    path,
    title: path,
    tags: [],
    backlinkCount: 0,
    outgoingCount: 0,
    unresolvedCount: 0,
  };
}

describe("workspace file pages", () => {
  it("allocates a sparse corpus-sized list while requesting only visible bounded pages", () => {
    const state = reconcileWorkspaceFilePageSnapshot(
      null,
      "vault-1",
      { generation: "2:1", offset: 0, limit: 256, total: 200_000, complete: false },
      [file("000000.md"), file("000001.md")],
    );

    expect(state.files).toHaveLength(200_000);
    expect(loadedWorkspaceFiles(state).map(({ path }) => path)).toEqual(["000000.md", "000001.md"]);
    expect(unloadedWorkspaceFilePageOffsets(state, 10_000, 10_640)).toEqual([9984, 10_240, 10_496]);
  });

  it("refuses a stale page after the generation changes", () => {
    const state = reconcileWorkspaceFilePageSnapshot(
      null,
      "vault-1",
      { generation: "2:1", offset: 0, limit: 256, total: 600, complete: false },
      [file("first.md")],
    );

    expect(
      applyWorkspaceFilePage(
        state,
        { generation: "1:9", offset: 256, limit: 256, total: 600, complete: false },
        [file("stale.md")],
      ),
    ).toBe(false);
    expect(loadedWorkspaceFiles(state).map(({ path }) => path)).toEqual(["first.md"]);
  });
});
