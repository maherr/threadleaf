import { describe, expect, it } from "vitest";
import { maximumEditorDraftBytes, parseEditorDraft } from "./editor-draft";

const vaultId = "a".repeat(64);

function draft() {
  return {
    version: 3,
    draftId: "9ee6115a-d87e-4c87-8cb8-b444695200cf",
    vaultId,
    paneId: "secondary",
    path: "Notes/Active.md",
    baseRevision: "b".repeat(64),
    content: "draft text",
    textRepresentation: { hasBom: false, lineEndingKinds: "", defaultLineEnding: "lf" },
    selection: { anchor: 5, head: 10 },
    updatedAt: "2026-08-12T08:00:00.000Z",
  };
}

describe("parseEditorDraft", () => {
  it("normalizes a bounded versioned draft", () => {
    expect(parseEditorDraft(draft(), vaultId)).toEqual(draft());
  });

  it("migrates version 1 and 2 drafts into version 3 private state", () => {
    const legacy = { ...draft(), version: 1 };
    delete (legacy as { paneId?: string }).paneId;
    delete (legacy as { textRepresentation?: unknown }).textRepresentation;
    expect(parseEditorDraft(legacy, vaultId)).toEqual({
      ...draft(),
      paneId: "primary",
      textRepresentation: null,
    });
    const versionTwo = { ...draft(), version: 2 };
    delete (versionTwo as { textRepresentation?: unknown }).textRepresentation;
    expect(parseEditorDraft(versionTwo, vaultId)).toEqual({ ...draft(), textRepresentation: null });
  });

  it("rejects crossed vaults, unsafe paths, invalid revisions, and escaped selections", () => {
    expect(() => parseEditorDraft({ ...draft(), vaultId: "c".repeat(64) }, vaultId)).toThrow(
      "exact vault",
    );
    expect(() => parseEditorDraft({ ...draft(), path: ".obsidian/private.md" }, vaultId)).toThrow(
      ".obsidian",
    );
    expect(() => parseEditorDraft({ ...draft(), baseRevision: "not-a-revision" }, vaultId)).toThrow(
      "exact vault",
    );
    expect(() => parseEditorDraft({ ...draft(), paneId: "third" }, vaultId)).toThrow(
      "pane identity",
    );
    expect(() =>
      parseEditorDraft({ ...draft(), selection: { anchor: 0, head: 99 } }, vaultId),
    ).toThrow("inside");
  });

  it("bounds UTF-8 content and requires canonical timestamps", () => {
    expect(() =>
      parseEditorDraft({ ...draft(), content: "x".repeat(maximumEditorDraftBytes + 1) }, vaultId),
    ).toThrow("cannot exceed");
    expect(() => parseEditorDraft({ ...draft(), updatedAt: "2026-08-12" }, vaultId)).toThrow(
      "canonical",
    );
  });

  it("rejects malformed version 3 external text metadata", () => {
    expect(() =>
      parseEditorDraft(
        {
          ...draft(),
          textRepresentation: { hasBom: true, lineEndingKinds: "l", defaultLineEnding: "lf" },
        },
        vaultId,
      ),
    ).toThrow("representation");
    expect(() => parseEditorDraft({ ...draft(), content: "draft\rtext" }, vaultId)).toThrow(
      "logical LF",
    );
  });

  it("accepts literal U+FEFF editor text when the persisted BOM flag is false", () => {
    const value = {
      ...draft(),
      content: "\uFEFFdraft text",
      textRepresentation: { hasBom: false, lineEndingKinds: "", defaultLineEnding: "lf" as const },
    };
    expect(parseEditorDraft(value, vaultId)).toEqual(value);
  });
});
