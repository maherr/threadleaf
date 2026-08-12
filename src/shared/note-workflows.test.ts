import { describe, expect, it } from "vitest";
import {
  createDefaultVaultNoteWorkflowSettings,
  isNoteWorkflowTemplatePath,
  normalizeNoteWorkflowFile,
  normalizeNoteWorkflowFolder,
  parseVaultNoteWorkflowSettings,
} from "./note-workflows";

describe("note workflow settings", () => {
  it("provides portable defaults without writing anything into a vault", () => {
    expect(createDefaultVaultNoteWorkflowSettings()).toEqual({
      templateFolder: "Templates",
      templateDateFormat: "YYYY-MM-DD",
      templateTimeFormat: "HH:mm",
      dailyNoteFolder: "",
      dailyNoteDateFormat: "YYYY-MM-DD",
      dailyNoteTemplate: null,
    });
  });

  it("normalizes visible vault-relative folders and Markdown files", () => {
    expect(normalizeNoteWorkflowFolder(" ./Journal\\Daily/ ")).toBe("Journal/Daily");
    expect(normalizeNoteWorkflowFolder(".")).toBe("");
    expect(normalizeNoteWorkflowFile("Templates/Meeting")).toBe("Templates/Meeting.md");
    expect(normalizeNoteWorkflowFile("Templates/Meeting.MD")).toBe("Templates/Meeting.MD");
  });

  it("rejects traversal, absolute, hidden, private, and unbounded settings", () => {
    for (const value of [
      "../Templates",
      "/Templates",
      "C:\\Templates",
      ".hidden/Templates",
      ".obsidian/Templates",
    ]) {
      expect(() => normalizeNoteWorkflowFolder(value)).toThrow();
    }
    expect(() => normalizeNoteWorkflowFile("")).toThrow("Markdown file");
    expect(() =>
      parseVaultNoteWorkflowSettings({
        ...createDefaultVaultNoteWorkflowSettings(),
        dailyNoteDateFormat: "x".repeat(257),
      }),
    ).toThrow("256");
  });

  it("parses a complete setting and tests exact template folder containment", () => {
    const settings = parseVaultNoteWorkflowSettings({
      templateFolder: "Work/Templates/",
      templateDateFormat: "YYYY.MM.DD",
      templateTimeFormat: "HH-mm",
      dailyNoteFolder: "Journal",
      dailyNoteDateFormat: "YYYY/MMMM/YYYY-MM-DD",
      dailyNoteTemplate: "Work/Templates/Daily",
    });

    expect(settings).toEqual({
      templateFolder: "Work/Templates",
      templateDateFormat: "YYYY.MM.DD",
      templateTimeFormat: "HH-mm",
      dailyNoteFolder: "Journal",
      dailyNoteDateFormat: "YYYY/MMMM/YYYY-MM-DD",
      dailyNoteTemplate: "Work/Templates/Daily.md",
    });
    expect(isNoteWorkflowTemplatePath("Work/Templates/Meeting.md", settings)).toBe(true);
    expect(isNoteWorkflowTemplatePath("Work/Templates-old/Meeting.md", settings)).toBe(false);
    expect(isNoteWorkflowTemplatePath("Work/Meeting.md", settings)).toBe(false);
  });
});
