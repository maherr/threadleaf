import { describe, expect, it } from "vitest";
import {
  activeWorkspacePane,
  createWorkspaceLayout,
  createWorkspaceState,
  createWorkspaceStateDocument,
  maximumPersistedWorkspaceHistory,
  maximumPersistedWorkspaceTabs,
  parseWorkspaceState,
  reorderWorkspaceTab,
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
          pinnedPaths: [],
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
        {
          id: "primary",
          openPaths: ["First.md", "Shared.md"],
          pinnedPaths: ["Shared.md"],
          activePath: "First.md",
        },
        {
          id: "secondary",
          openPaths: ["Second.md", "Shared.md"],
          pinnedPaths: ["Shared.md"],
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
        {
          id: "primary",
          openPaths: ["Shared.md", "First.md"],
          pinnedPaths: ["Shared.md"],
          activePath: "First.md",
        },
        {
          id: "secondary",
          openPaths: ["Shared.md", "Second.md"],
          pinnedPaths: ["Shared.md"],
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
        {
          id: "primary",
          openPaths: ["First.md"],
          pinnedPaths: [],
          activePath: "First.md",
        },
        {
          id: "secondary",
          openPaths: ["Second.md", "Shared.md"],
          pinnedPaths: ["Shared.md"],
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
      openPaths: ["Shared.md", "Second.md"],
      activePath: "Shared.md",
      panes: [
        {
          id: "primary",
          openPaths: ["First.md"],
          pinnedPaths: [],
          activePath: "First.md",
        },
        {
          id: "secondary",
          openPaths: ["Shared.md", "Second.md"],
          pinnedPaths: ["Shared.md"],
          activePath: "Shared.md",
        },
      ],
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
      panes: [{ id: "primary", openPaths: [], pinnedPaths: [], activePath: null }],
      activePaneId: "primary",
      splitDirection: null,
    });
  });

  it("persists native Excalidraw tabs without admitting ordinary files", () => {
    const state = createWorkspaceState(
      vaultId,
      ["Notes/Source.md", "Drawings/Native Scene.excalidraw"],
      "Drawings/Native Scene.excalidraw",
    );
    expect(createWorkspaceStateDocument(state)).toMatchObject({
      openPaths: ["Notes/Source.md", "Drawings/Native Scene.excalidraw"],
      activePath: "Drawings/Native Scene.excalidraw",
    });
    expect(parseWorkspaceState(createWorkspaceStateDocument(state), vaultId)).toEqual(state);
    expect(() => createWorkspaceState(vaultId, ["Attachment.json"], "Attachment.json")).toThrow(
      "native Excalidraw scenes",
    );
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
    expect(() =>
      createWorkspaceLayout(
        vaultId,
        [
          {
            id: "primary",
            openPaths: ["Note.md"],
            pinnedPaths: ["Missing.md"],
            activePath: "Note.md",
          },
        ],
        "primary",
        null,
      ),
    ).toThrow("must also be open");
    expect(() =>
      createWorkspaceLayout(
        vaultId,
        [
          {
            id: "primary",
            openPaths: ["Note.md"],
            pinnedPaths: ["Note.md", "Note.md"],
            activePath: "Note.md",
          },
        ],
        "primary",
        null,
      ),
    ).toThrow("duplicate pinned");
  });

  it("normalizes the pinned region first while retaining the version 1 projection", () => {
    const state = parseWorkspaceState(
      {
        version: 1,
        layoutVersion: 2,
        vaultId,
        openPaths: ["Pinned.md", "Ordinary.md", "Later.md"],
        activePath: "Pinned.md",
        panes: [
          {
            id: "primary",
            openPaths: ["Ordinary.md", "Pinned.md", "Later.md"],
            pinnedPaths: ["Pinned.md"],
            activePath: "Pinned.md",
          },
        ],
        activePaneId: "primary",
        splitDirection: null,
      },
      vaultId,
    );

    expect(state.panes).toEqual([
      {
        id: "primary",
        openPaths: ["Pinned.md", "Ordinary.md", "Later.md"],
        pinnedPaths: ["Pinned.md"],
        activePath: "Pinned.md",
      },
    ]);
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

  it("round-trips bounded per-pane navigation history without changing old layouts", () => {
    const state = createWorkspaceLayout(
      vaultId,
      [
        {
          id: "primary",
          openPaths: ["Current.md"],
          activePath: "Current.md",
          navigationHistory: {
            back: ["Earlier.md", "First.md"],
            forward: ["Later.md"],
          },
        },
      ],
      "primary",
      null,
    );
    const document = createWorkspaceStateDocument(state);

    expect(document.panes[0]?.navigationHistory).toEqual({
      back: ["Earlier.md", "First.md"],
      forward: ["Later.md"],
    });
    expect(parseWorkspaceState(document, vaultId)).toEqual(state);
    expect(() =>
      createWorkspaceLayout(
        vaultId,
        [
          {
            id: "primary",
            openPaths: ["Current.md"],
            activePath: "Current.md",
            navigationHistory: {
              back: Array.from(
                { length: maximumPersistedWorkspaceHistory + 1 },
                (_, index) => `Earlier ${index}.md`,
              ),
              forward: [],
            },
          },
        ],
        "primary",
        null,
      ),
    ).toThrow(`${maximumPersistedWorkspaceHistory} entries`);
  });

  it("reorders tabs deterministically without crossing the pinned region", () => {
    const state = createWorkspaceLayout(
      vaultId,
      [
        {
          id: "primary",
          openPaths: ["Pinned.md", "First.md", "Second.md", "Third.md"],
          pinnedPaths: ["Pinned.md"],
          activePath: "First.md",
        },
      ],
      "primary",
      null,
    );

    expect(reorderWorkspaceTab(state, "primary", "Third.md", 1).panes[0]?.openPaths).toEqual([
      "Pinned.md",
      "Third.md",
      "First.md",
      "Second.md",
    ]);
    expect(reorderWorkspaceTab(state, "primary", "Pinned.md", 99).panes[0]?.openPaths).toEqual([
      "Pinned.md",
      "First.md",
      "Second.md",
      "Third.md",
    ]);
    expect(reorderWorkspaceTab(state, "primary", "First.md", 0).panes[0]?.openPaths).toEqual([
      "Pinned.md",
      "First.md",
      "Second.md",
      "Third.md",
    ]);
    expect(() => reorderWorkspaceTab(state, "primary", "Missing.md", 0)).toThrow(
      "does not contain this tab",
    );
  });
});
