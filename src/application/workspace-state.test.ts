import { describe, expect, it } from "vitest";
import {
  activeWorkspacePane,
  createWorkspaceLayout,
  createWorkspaceState,
  createWorkspaceStateDocument,
  maximumPersistedWorkspaceTabs,
  parseWorkspaceState,
} from "./workspace-state";

const vaultId = "a".repeat(64);

describe("workspace state", () => {
  it("migrates a version 1 ordered tab snapshot into one primary pane", () => {
    expect(
      parseWorkspaceState(
        {
          version: 1,
          vaultId,
          openPaths: ["Notes\\First.md", "Second.MD"],
          activePath: "Notes/First.md",
        },
        vaultId,
      ),
    ).toEqual({
      version: 2,
      vaultId,
      panes: [
        {
          id: "primary",
          openPaths: ["Notes/First.md", "Second.MD"],
          activePath: "Notes/First.md",
        },
      ],
      activePaneId: "primary",
      splitDirection: null,
    });
  });

  it("normalizes two independent panes and exposes the active pane", () => {
    const state = createWorkspaceLayout(
      vaultId,
      [
        { id: "primary", openPaths: ["First.md", "Shared.md"], activePath: "First.md" },
        {
          id: "secondary",
          openPaths: ["Second.md", "Shared.md"],
          activePath: "Shared.md",
        },
      ],
      "secondary",
      "vertical",
    );

    expect(state).toEqual({
      version: 2,
      vaultId,
      panes: [
        { id: "primary", openPaths: ["First.md", "Shared.md"], activePath: "First.md" },
        {
          id: "secondary",
          openPaths: ["Second.md", "Shared.md"],
          activePath: "Shared.md",
        },
      ],
      activePaneId: "secondary",
      splitDirection: "vertical",
    });
    expect(activeWorkspacePane(state).activePath).toBe("Shared.md");
  });

  it("round-trips a split layout through a version 1 rollback projection", () => {
    const state = createWorkspaceLayout(
      vaultId,
      [
        { id: "primary", openPaths: ["First.md"], activePath: "First.md" },
        {
          id: "secondary",
          openPaths: ["Second.md", "Shared.md"],
          activePath: "Shared.md",
        },
      ],
      "secondary",
      "horizontal",
    );

    const document = createWorkspaceStateDocument(state);

    expect(document).toMatchObject({
      version: 1,
      layoutVersion: 2,
      openPaths: ["Second.md", "Shared.md"],
      activePath: "Shared.md",
    });
    expect(parseWorkspaceState(document, vaultId)).toEqual(state);
    expect(() => parseWorkspaceState({ ...document, activePath: "Second.md" }, vaultId)).toThrow(
      "compatibility projection must match",
    );
  });

  it("accepts an explicitly empty workspace", () => {
    expect(createWorkspaceState(vaultId, [], null)).toEqual({
      version: 2,
      vaultId,
      panes: [{ id: "primary", openPaths: [], activePath: null }],
      activePaneId: "primary",
      splitDirection: null,
    });
  });

  it("rejects crossed vaults, duplicates, private paths, and invalid active tabs", () => {
    expect(() =>
      parseWorkspaceState(
        { version: 1, vaultId: "b".repeat(64), openPaths: [], activePath: null },
        vaultId,
      ),
    ).toThrow("vault identity");
    expect(() => createWorkspaceState(vaultId, ["Note.md", "Note.md"], "Note.md")).toThrow(
      "duplicate",
    );
    expect(() =>
      createWorkspaceState(vaultId, [".obsidian/State.md"], ".obsidian/State.md"),
    ).toThrow("inside .obsidian");
    expect(() => createWorkspaceState(vaultId, ["Note.txt"], "Note.txt")).toThrow("only Markdown");
    expect(() => createWorkspaceState(vaultId, ["Note.md"], "Other.md")).toThrow(
      "also be an open tab",
    );
    expect(() => createWorkspaceState(vaultId, ["Note.md"], null)).toThrow(
      "must identify its active path",
    );
  });

  it("rejects malformed pane topology", () => {
    expect(() =>
      createWorkspaceLayout(
        vaultId,
        [{ id: "primary", openPaths: [], activePath: null }],
        "primary",
        "vertical",
      ),
    ).toThrow("cannot have a split direction");
    expect(() =>
      createWorkspaceLayout(
        vaultId,
        [
          { id: "primary", openPaths: [], activePath: null },
          { id: "secondary", openPaths: [], activePath: null },
        ],
        "secondary",
        null,
      ),
    ).toThrow("require one");
    expect(() =>
      parseWorkspaceState(
        {
          version: 2,
          vaultId,
          panes: [{ id: "secondary", openPaths: [], activePath: null }],
          activePaneId: "secondary",
          splitDirection: null,
        },
        vaultId,
      ),
    ).toThrow("first workspace pane must be primary");
    expect(() =>
      parseWorkspaceState(
        {
          version: 2,
          vaultId,
          panes: [
            { id: "primary", openPaths: [], activePath: null },
            { id: "primary", openPaths: [], activePath: null },
          ],
          activePaneId: "primary",
          splitDirection: "vertical",
        },
        vaultId,
      ),
    ).toThrow("duplicate pane IDs");
    expect(() =>
      parseWorkspaceState(
        {
          version: 2,
          vaultId,
          panes: [{ id: "primary", openPaths: [], activePath: null }],
          activePaneId: "secondary",
          splitDirection: null,
        },
        vaultId,
      ),
    ).toThrow("active workspace pane must exist");
  });

  it("bounds persisted tab state per pane", () => {
    const paths = Array.from(
      { length: maximumPersistedWorkspaceTabs + 1 },
      (_, index) => `Note ${index}.md`,
    );
    expect(() => createWorkspaceState(vaultId, paths, paths[0] ?? null)).toThrow(
      `${maximumPersistedWorkspaceTabs} tabs`,
    );
  });
});
