import { describe, expect, it } from "vitest";
import { displayTitleFromVaultPath } from "./note-path";

describe("vault note display titles", () => {
  it("uses the Markdown stem for ordinary notes", () => {
    expect(displayTitleFromVaultPath("Folder/Project brief.md")).toBe("Project brief");
  });

  it("hides transaction identity while labeling conflict copies", () => {
    expect(
      displayTitleFromVaultPath(
        "Folder/Project brief.threadleaf-conflict-20260811T154700000Z-1a2b3c4d.md",
      ),
    ).toBe("Project brief (conflict copy)");
  });
});
