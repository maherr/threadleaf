import { describe, expect, it } from "vitest";
import { externalTextFromEditor, externalTextRepresentation } from "./editor-text";
import {
  applyEditorTextHistoryEntry,
  captureEditorTextHistoryEntry,
  type EditorTextHistoryChange,
} from "./editor-text-history";

describe("external editor-text history deltas", () => {
  it("keeps long-note undo metadata proportional to changed lines", () => {
    const source = Array.from({ length: 8_192 }, (_, index) => `line ${index}`).join("\r\n");
    const initial = externalTextRepresentation(source);
    let representation = initial;
    let editorText = initial.editorText;
    const entries = [] as ReturnType<typeof captureEditorTextHistoryEntry>[];

    for (let index = 0; index < 256; index += 1) {
      const from = 0;
      const to = editorText.indexOf("\n");
      const insert = `revision ${index}`;
      const change: EditorTextHistoryChange = {
        from,
        to,
        newFrom: from,
        newTo: from + insert.length,
        insert,
        removedText: "",
        removedLineEndings: [],
        insertedLineEndings: [],
      };
      const entry = captureEditorTextHistoryEntry(representation, editorText, [change]);
      entries.push(entry);
      representation = applyEditorTextHistoryEntry(representation, entry, "forward");
      editorText = representation.editorText;
    }

    const retainedLineEndingSlots = entries.reduce(
      (total, entry) =>
        total +
        entry.changes.reduce(
          (changeTotal, change) =>
            changeTotal + change.removedLineEndings.length + change.insertedLineEndings.length,
          0,
        ),
      0,
    );
    expect(retainedLineEndingSlots).toBe(0);
    expect(
      entries.every((entry) => entry.changes.every((change) => change.removedText.length < 32)),
    ).toBe(true);

    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry) representation = applyEditorTextHistoryEntry(representation, entry, "reverse");
    }
    expect(representation.editorText).toBe(initial.editorText);
    expect(externalTextFromEditor(representation.editorText, representation)).toBe(source);

    for (const entry of entries) {
      representation = applyEditorTextHistoryEntry(representation, entry, "forward");
    }
    expect(representation.editorText).toBe(editorText);
  });
});
