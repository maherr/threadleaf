import moment from "moment";
import { describe, expect, it } from "vitest";
import {
  dailyNotePath,
  expandNoteTemplate,
  listNoteTemplates,
  loadNoteTemplate,
  type NoteTemplateReader,
  noteTemplateTitle,
  renderNoteTemplate,
} from "./note-template";

const now = moment.parseZone("2026-08-12T18:07:09-04:00");

describe("note templates", () => {
  it("expands documented title, date, time, and custom Moment formats", () => {
    expect(
      expandNoteTemplate(
        "# {{title}}\n{{date}} {{time}}\n{{date:dddd, MMMM Do YYYY}}\n{{time:HH-mm-ss}}\n{{unknown}}\n{{title:x}}",
        {
          title: "Daily log",
          now,
          dateFormat: "YYYY.MM.DD",
          timeFormat: "HH:mm:ss",
        },
      ),
    ).toBe(
      "# Daily log\n2026.08.12 18:07:09\nWednesday, August 12th 2026\n18-07-09\n{{unknown}}\n{{title:x}}",
    );
  });

  it("derives a title from the target note and builds nested daily paths", () => {
    expect(noteTemplateTitle("Journal/A meeting.md")).toBe("A meeting");
    expect(dailyNotePath("Journal", "YYYY/MMMM/YYYY-MM-DD", now)).toBe(
      "Journal/2026/August/2026-08-12.md",
    );
    expect(dailyNotePath("", "YYYY-MM-DD", now)).toBe("2026-08-12.md");
    expect(() => dailyNotePath("Journal", "[../escape]", now)).toThrow("leave the vault");
  });

  it("loads bounded UTF-8 templates and rejects too-large or malformed text", async () => {
    const readyReader: NoteTemplateReader = {
      listMarkdownPaths: async () => [],
      readBinary: async (filePath) => ({
        status: "ready",
        snapshot: {
          path: filePath,
          bytes: Buffer.from("Hello {{title}}", "utf8"),
          revision: "r1",
          size: 15,
        },
      }),
    };
    await expect(loadNoteTemplate(readyReader, "Templates/Hello")).resolves.toEqual({
      path: "Templates/Hello.md",
      content: "Hello {{title}}",
      revision: "r1",
      size: 15,
    });

    await expect(
      loadNoteTemplate(
        {
          ...readyReader,
          readBinary: async (filePath) => ({ status: "too-large", path: filePath, size: 10 }),
        },
        "Templates/Large.md",
        5,
      ),
    ).rejects.toThrow("limit is 5");
    await expect(
      loadNoteTemplate(
        {
          ...readyReader,
          readBinary: async (filePath) => ({
            status: "ready",
            snapshot: {
              path: filePath,
              bytes: Uint8Array.from([0xc3, 0x28]),
              revision: "r2",
              size: 2,
            },
          }),
        },
        "Templates/Invalid.md",
      ),
    ).rejects.toThrow("valid UTF-8");
  });

  it("lists only Markdown descendants of the configured template folder in stable order", async () => {
    const reader: NoteTemplateReader = {
      listMarkdownPaths: async () => [
        "Templates/Z.md",
        "Templates/Nested/A.md",
        "Templates-old/Outside.md",
        "Templates/NotMarkdown.txt",
      ],
      readBinary: async () => {
        throw new Error("unused");
      },
    };
    await expect(listNoteTemplates(reader, "Templates")).resolves.toEqual([
      "Templates/Nested/A.md",
      "Templates/Z.md",
    ]);
  });

  it("renders a loaded template while retaining its source identity", async () => {
    const reader: NoteTemplateReader = {
      listMarkdownPaths: async () => [],
      readBinary: async (filePath) => ({
        status: "ready",
        snapshot: {
          path: filePath,
          bytes: Buffer.from("# {{title}} on {{date}}", "utf8"),
          revision: "template-r1",
          size: 23,
        },
      }),
    };
    await expect(
      renderNoteTemplate(reader, "Templates/Meeting.md", {
        title: "Project kickoff",
        now,
        dateFormat: "YYYY-MM-DD",
        timeFormat: "HH:mm",
      }),
    ).resolves.toEqual({
      content: "# Project kickoff on 2026-08-12",
      sourcePath: "Templates/Meeting.md",
      sourceRevision: "template-r1",
      size: 23,
    });
  });
});
