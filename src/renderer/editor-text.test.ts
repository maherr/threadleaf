import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  applyEditorTextChanges,
  type EditorTextChange,
  editorTextFromExternal,
  externalTextFromEditor,
  externalTextRepresentation,
} from "./editor-text";

function mutate(
  state: EditorState,
  representation: ReturnType<typeof externalTextRepresentation>,
  changes: readonly EditorTextChange[],
): { state: EditorState; representation: ReturnType<typeof externalTextRepresentation> } {
  const updated = state.update({ changes });
  return {
    state: updated.state,
    representation: applyEditorTextChanges(representation, state.doc.toString(), changes),
  };
}

describe("editor text representation boundary", () => {
  it.each([
    ["LF", "first\nsecond\nthird\n"],
    ["CRLF", "first\r\nsecond\r\nthird\r\n"],
    ["CR", "first\rsecond\rthird\r"],
    ["mixed", "first\r\nsecond\nthird\rfourth\r\n"],
    ["BOM and mixed", "\uFEFFfirst\r\nsecond\nthird\rfourth\r\n"],
  ])("round-trips untouched %s bytes", (_label, external) => {
    const representation = externalTextRepresentation(external);
    const state = EditorState.create({ doc: editorTextFromExternal(external) });

    expect(externalTextFromEditor(state.doc.toString(), representation)).toBe(external);
  });

  it("preserves the exact line-ending sequence across an editor-state mutation", () => {
    const external = "\uFEFFfirst\r\nsecond\nthird\rfourth\r\n";
    const representation = externalTextRepresentation(external);
    const state = EditorState.create({ doc: editorTextFromExternal(external) });
    const secondLine = state.doc.line(2);
    const result = mutate(state, representation, [
      { from: secondLine.from, to: secondLine.to, insert: "changed" },
    ]);

    expect(externalTextFromEditor(result.state.doc.toString(), result.representation)).toBe(
      "\uFEFFfirst\r\nchanged\nthird\rfourth\r\n",
    );
  });

  it("preserves untouched endings around insert, delete, and multiline paste changes", () => {
    const external = "one\r\ntwo\nthree\rfour";
    const initial = externalTextRepresentation(external);
    const state = EditorState.create({ doc: editorTextFromExternal(external) });

    const inserted = mutate(state, initial, [
      { from: state.doc.line(2).to, to: state.doc.line(2).to, insert: "\ninserted\n" },
    ]);
    expect(externalTextFromEditor(inserted.state.doc.toString(), inserted.representation)).toBe(
      "one\r\ntwo\r\ninserted\r\n\nthree\rfour",
    );

    const deleteFrom = inserted.state.doc.line(4).from - 1;
    const deleted = mutate(inserted.state, inserted.representation, [
      { from: deleteFrom, to: deleteFrom + 1, insert: "" },
    ]);
    expect(externalTextFromEditor(deleted.state.doc.toString(), deleted.representation)).toBe(
      "one\r\ntwo\r\ninserted\nthree\rfour",
    );
  });

  it("keeps BOM state separate from visible editor text", () => {
    const external = "\uFEFFalpha\r\nbeta";
    const representation = externalTextRepresentation(external);
    expect(editorTextFromExternal(external)).toBe("alpha\nbeta");
    expect(externalTextFromEditor("changed\nbeta", representation)).toBe("\uFEFFchanged\r\nbeta");
    expect(externalTextFromEditor("alpha\nbeta", externalTextRepresentation("alpha\nbeta"))).toBe(
      "alpha\nbeta",
    );
  });

  it("restores the saved line-ending snapshot when a real CodeMirror edit is undone", () => {
    const external = "alpha\r\nbeta\ngamma\r";
    const original = externalTextRepresentation(external);
    const state = EditorState.create({ doc: editorTextFromExternal(external) });
    const deleted = mutate(state, original, [
      { from: state.doc.line(3).from - 1, to: state.doc.line(3).from, insert: "" },
    ]);
    expect(externalTextFromEditor(deleted.state.doc.toString(), deleted.representation)).toBe(
      "alpha\r\nbetagamma\r",
    );

    const undone = deleted.state.update({
      changes: {
        from: deleted.state.doc.line(2).from + "beta".length,
        to: deleted.state.doc.line(2).from + "beta".length,
        insert: "\n",
      },
    }).state;
    // The renderer's undo history restores the metadata snapshot alongside
    // the CodeMirror transaction.  The inserted newline is the original LF,
    // not the document's CRLF default.
    expect(externalTextFromEditor(undone.doc.toString(), original)).toBe(external);
  });
});
