import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  applyEditorTextChanges,
  type EditorTextChange,
  editorDraftMatchesDiskText,
  editorDraftTextRepresentation,
  editorTextFromExternal,
  externalTextFromEditor,
  externalTextRepresentation,
  externalTextRepresentationFromDraft,
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

  it.each([
    ["LF", "alpha\nbeta\n"],
    ["CRLF", "alpha\r\nbeta\r\n"],
    ["CR", "alpha\rbeta\r"],
    ["mixed", "alpha\r\nbeta\ngamma\r"],
    ["BOM LF", "\uFEFFalpha\nbeta\n"],
    ["BOM CRLF", "\uFEFFalpha\r\nbeta\r\n"],
    ["BOM CR", "\uFEFFalpha\rbeta\r"],
    ["BOM mixed", "\uFEFFalpha\r\nbeta\ngamma\r"],
  ])(
    "keeps exact %s bytes through missing or stale-disk draft recovery and save payloads",
    (_label, external) => {
      const editorText = editorTextFromExternal(external);
      const persisted = editorDraftTextRepresentation(externalTextRepresentation(external));

      // Missing-disk recovery and stale-disk conflict-copy recovery must use
      // the draft's own external representation, not a missing or changed
      // disk snapshot.
      const recovered = externalTextRepresentationFromDraft(editorText, persisted);
      expect(recovered).not.toBeNull();
      expect(externalTextFromEditor(editorText, recovered as NonNullable<typeof recovered>)).toBe(
        external,
      );

      const savedPayload = externalTextFromEditor(
        `${editorText}changed`,
        recovered as NonNullable<typeof recovered>,
      );
      expect(savedPayload).toBe(`${external}changed`);
    },
  );

  it("keeps a version-3 draft when a stale disk copy changes only its spelling", () => {
    const external = "\uFEFFalpha\r\nbeta\r\n";
    const editorText = editorTextFromExternal(external);
    const persisted = editorDraftTextRepresentation(externalTextRepresentation(external));

    expect(editorDraftMatchesDiskText(editorText, persisted, external)).toBe(true);
    expect(editorDraftMatchesDiskText(editorText, persisted, "alpha\nbeta\n")).toBe(false);
  });

  it("fails closed for a malformed private text representation", () => {
    expect(
      externalTextRepresentationFromDraft("alpha\nbeta", {
        hasBom: true,
        lineEndingKinds: "cc",
        defaultLineEnding: "crlf",
      }),
    ).toBeNull();
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
