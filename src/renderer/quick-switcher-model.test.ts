import { describe, expect, it } from "vitest";
import {
  filterQuickSwitcherNotes,
  maximumQuickSwitcherResults,
  moveQuickSwitcherSelection,
  quickSwitcherNotesFromFiles,
} from "./quick-switcher-model";

const notes = [
  { path: "Projects/Alpha.md", title: "Alpha" },
  { path: "Archive/Alpha Notes.md", title: "Alpha Notes" },
  { path: "Projects/Élan.md", title: "Élan" },
  { path: "Notes/Reading.md", title: "Reading" },
];

describe("quick switcher model", () => {
  it("ranks exact, prefix, and path matches deterministically", () => {
    expect(filterQuickSwitcherNotes(notes, "alpha")).toEqual([
      { path: "Projects/Alpha.md", title: "Alpha" },
      { path: "Archive/Alpha Notes.md", title: "Alpha Notes" },
    ]);
    expect(filterQuickSwitcherNotes(notes, "projects/alpha")).toEqual([
      { path: "Projects/Alpha.md", title: "Alpha" },
    ]);
  });

  it("folds accents and requires every query token", () => {
    expect(filterQuickSwitcherNotes(notes, "elan")).toEqual([
      { path: "Projects/Élan.md", title: "Élan" },
    ]);
    expect(filterQuickSwitcherNotes(notes, "alpha missing")).toEqual([]);
  });

  it("wraps keyboard selection without producing an invalid index", () => {
    expect(moveQuickSwitcherSelection(-1, 3, 1)).toBe(0);
    expect(moveQuickSwitcherSelection(0, 3, -1)).toBe(2);
    expect(moveQuickSwitcherSelection(0, 0, 1)).toBe(-1);
  });

  it("projects indexed file summaries into the switcher shape", () => {
    expect(
      quickSwitcherNotesFromFiles([
        {
          path: "Projects/Alpha.md",
          title: "Alpha",
          tags: [],
          backlinkCount: 0,
          outgoingCount: 0,
          unresolvedCount: 0,
        },
      ]),
    ).toEqual([notes[0]]);
  });

  it("bounds rendered results for large vaults", () => {
    const largeVault = Array.from({ length: maximumQuickSwitcherResults + 50 }, (_, index) => ({
      path: `Notes/${index}.md`,
      title: `Note ${index}`,
    }));
    expect(filterQuickSwitcherNotes(largeVault, "")).toHaveLength(maximumQuickSwitcherResults);
  });
});
