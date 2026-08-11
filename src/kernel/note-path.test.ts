import { describe, expect, it } from "vitest";
import { displayTitleFromVaultPath, normalizeMarkdownNotePath } from "./note-path";

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

describe("Markdown note paths", () => {
  it("normalizes portable paths and supplies the Markdown extension", () => {
    expect(normalizeMarkdownNotePath(" Inbox/New thought ")).toBe("Inbox/New thought.md");
    expect(normalizeMarkdownNotePath("Projects/Version 1.2")).toBe("Projects/Version 1.2.md");
    expect(normalizeMarkdownNotePath("Projects/Existing.MD")).toBe("Projects/Existing.MD");
    expect(normalizeMarkdownNotePath("Folder\\Windows path")).toBe("Folder/Windows path.md");
  });

  it("rejects traversal, absolute paths, empty names, and private application paths", () => {
    expect(() => normalizeMarkdownNotePath("   ")).toThrow("between 1 and 4096");
    expect(() => normalizeMarkdownNotePath("../outside")).toThrow("traversal");
    expect(() => normalizeMarkdownNotePath("/absolute/note")).toThrow("relative");
    expect(() => normalizeMarkdownNotePath("Folder/")).toThrow("name a file");
    expect(() => normalizeMarkdownNotePath(".Obsidian/Hidden")).toThrow("private application");
    expect(() => normalizeMarkdownNotePath("Folder/.git/Hidden")).toThrow("private application");
    expect(() => normalizeMarkdownNotePath(".threadleaf-write-secret")).toThrow(
      "private application",
    );
  });
});
