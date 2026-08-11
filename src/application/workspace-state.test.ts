import { describe, expect, it } from "vitest";
import {
  createWorkspaceState,
  maximumPersistedWorkspaceTabs,
  parseWorkspaceState,
} from "./workspace-state";

const vaultId = "a".repeat(64);

describe("workspace state", () => {
  it("normalizes a versioned ordered tab snapshot", () => {
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
      version: 1,
      vaultId,
      openPaths: ["Notes/First.md", "Second.MD"],
      activePath: "Notes/First.md",
    });
  });

  it("accepts an explicitly empty workspace", () => {
    expect(createWorkspaceState(vaultId, [], null)).toEqual({
      version: 1,
      vaultId,
      openPaths: [],
      activePath: null,
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

  it("bounds persisted tab state", () => {
    const paths = Array.from(
      { length: maximumPersistedWorkspaceTabs + 1 },
      (_, index) => `Note ${index}.md`,
    );
    expect(() => createWorkspaceState(vaultId, paths, paths[0] ?? null)).toThrow(
      `${maximumPersistedWorkspaceTabs} tabs`,
    );
  });
});
