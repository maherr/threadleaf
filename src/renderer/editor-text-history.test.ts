import { describe, expect, it } from "vitest";
import { externalTextFromEditor, externalTextRepresentation } from "./editor-text";
import {
  applyEditorTextHistoryEntry,
  boundedEditorTextHistory,
  boundedEditorTextRedoHistory,
  captureEditorTextHistoryEntry,
  type EditorTextHistoryChange,
  type EditorTextHistoryEntry,
  maxEditorTextHistoryEntries,
} from "./editor-text-history";

describe("external editor-text history deltas", () => {
  it("retains only the bounded newest metadata entries", () => {
    const entries = Array.from({ length: maxEditorTextHistoryEntries + 17 }, (_, index) => ({
      changes: [
        {
          from: index,
          to: index,
          newFrom: index,
          newTo: index + 1,
          insert: String(index),
          removedText: "",
          removedLineEndings: [],
          insertedLineEndings: [],
        },
      ],
    }));

    const retained = boundedEditorTextHistory(entries);
    expect(retained).toHaveLength(maxEditorTextHistoryEntries);
    expect(retained[0]?.changes[0]?.from).toBe(17);
    expect(retained.at(-1)?.changes[0]?.from).toBe(maxEditorTextHistoryEntries + 16);
  });

  it("keeps the entries closest to being redone when redo history exceeds the bound", () => {
    // The redo stack's consumption order is the OPPOSITE of the undo
    // stack's: editorHistoryTarget's "redo" direction walks forward from
    // index 0, and renderer.ts always prepends a freshly-undone batch to
    // the front of editorTextRedoHistory, so index 0 is always the entry
    // closest to being redone next. Bounding it must therefore keep the
    // FRONT and evict the tail -- the opposite of boundedEditorTextHistory
    // above, which keeps the tail for the chronological undo stack.
    const entries = Array.from({ length: maxEditorTextHistoryEntries + 17 }, (_, index) => ({
      changes: [
        {
          from: index,
          to: index,
          newFrom: index,
          newTo: index + 1,
          insert: String(index),
          removedText: "",
          removedLineEndings: [],
          insertedLineEndings: [],
        },
      ],
    }));

    const retained = boundedEditorTextRedoHistory(entries);
    expect(retained).toHaveLength(maxEditorTextHistoryEntries);
    expect(retained[0]?.changes[0]?.from).toBe(0);
    expect(retained.at(-1)?.changes[0]?.from).toBe(maxEditorTextHistoryEntries - 1);
  });

  it("keeps undo and redo correct at the 256-entry bound across a renderer-style 300-edit session", () => {
    // Mirrors renderer.ts's updateEditorTextRepresentation orchestration
    // (capture entry -> push bounded undo -> apply forward, and on undo:
    // splice the target off the undo stack -> apply reverse -> push bounded
    // redo) using only the exported building blocks, since renderer.ts
    // itself pulls in Electron/CodeMirror DOM wiring that cannot run here.
    const editCount = 300;
    const evictedCount = editCount - maxEditorTextHistoryEntries; // 44
    const initial = externalTextRepresentation("");
    let representation = initial;
    let editorText = "";
    let undoHistory: EditorTextHistoryEntry[] = [];
    let redoHistory: EditorTextHistoryEntry[] = [];
    const textAfterEdit: string[] = [];

    for (let index = 0; index < editCount; index += 1) {
      const insert = `e${index} `;
      const change: EditorTextHistoryChange = {
        from: editorText.length,
        to: editorText.length,
        newFrom: editorText.length,
        newTo: editorText.length + insert.length,
        insert,
        removedText: "",
        removedLineEndings: [],
        insertedLineEndings: [],
      };
      const entry = captureEditorTextHistoryEntry(representation, editorText, [change]);
      undoHistory = boundedEditorTextHistory([...undoHistory, entry]);
      representation = applyEditorTextHistoryEntry(representation, entry, "forward");
      editorText = representation.editorText;
      redoHistory = []; // a normal edit always clears redo, as in renderer.ts
      textAfterEdit.push(editorText);
    }

    expect(undoHistory).toHaveLength(maxEditorTextHistoryEntries);

    // Undo everything the bounded history remembers, in one renderer-style
    // burst (as if a single editorHistoryTarget resolution covered the
    // whole retained stack).
    const moved = undoHistory.splice(0);
    for (let index = moved.length - 1; index >= 0; index -= 1) {
      const entry = moved[index];
      if (entry) representation = applyEditorTextHistoryEntry(representation, entry, "reverse");
    }
    redoHistory = boundedEditorTextRedoHistory([...moved, ...redoHistory]);

    // Oldest evicted: the metadata cannot reach further back than the
    // point the bound started retaining entries from.
    expect(undoHistory).toHaveLength(0);
    expect(representation.editorText).toBe(textAfterEdit[evictedCount - 1]);
    // Newest 256 undoable: exactly the retained stack moved to redo.
    expect(redoHistory).toHaveLength(maxEditorTextHistoryEntries);

    // Redo order survives the bound: replaying the retained redo stack in
    // its real front-to-back consumption order reproduces the original 256
    // newest edits in their original sequence.
    for (const entry of redoHistory) {
      representation = applyEditorTextHistoryEntry(representation, entry, "forward");
    }
    expect(representation.editorText).toBe(textAfterEdit[editCount - 1]);
  });

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
