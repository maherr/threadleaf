/**
 * CodeMirror stores a document as logical text.  Its document boundary is
 * therefore intentionally LF-only, while the vault boundary keeps the exact
 * external line-ending and BOM representation.  A line-ending entry belongs
 * to the newline immediately before the next logical line.
 */
import type { EditorDraftLineEnding, EditorDraftTextRepresentation } from "../shared/contracts";

export type ExternalLineEnding = EditorDraftLineEnding;

export interface ExternalTextRepresentation {
  hasBom: boolean;
  lineEndings: readonly ExternalLineEnding[];
  /** The convention used for newly inserted line breaks. */
  defaultLineEnding: ExternalLineEnding;
  /** The LF-only text currently represented by this metadata. */
  editorText: string;
}

export interface EditorTextChange {
  from: number;
  to: number;
  insert: string;
}

interface ParsedExternalText {
  editorText: string;
  lineEndings: ExternalLineEnding[];
}

function parseExternalText(source: string): ParsedExternalText {
  const start = source.startsWith("\uFEFF") ? 1 : 0;
  return parseEditorText(source, start);
}

function parseEditorText(source: string, start = 0): ParsedExternalText {
  const editor: string[] = [];
  const lineEndings: ExternalLineEnding[] = [];
  for (let index = start; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (character === "\r") {
      if (source[index + 1] === "\n") {
        lineEndings.push("crlf");
        index += 1;
      } else {
        lineEndings.push("cr");
      }
      editor.push("\n");
    } else if (character === "\n") {
      lineEndings.push("lf");
      editor.push("\n");
    } else {
      editor.push(character);
    }
  }
  return { editorText: editor.join(""), lineEndings };
}

/** Normalize line breaks in editor input without interpreting U+FEFF. */
function normalizeInsertedEditorText(source: string): string {
  return parseEditorText(source).editorText;
}

function defaultLineEnding(lineEndings: readonly ExternalLineEnding[]): ExternalLineEnding {
  return lineEndings[0] ?? "lf";
}

function lineEndingBytes(ending: ExternalLineEnding): string {
  return ending === "crlf" ? "\r\n" : ending === "cr" ? "\r" : "\n";
}

export function externalTextRepresentation(source: string): ExternalTextRepresentation {
  const parsed = parseExternalText(source);
  return {
    hasBom: source.startsWith("\uFEFF"),
    lineEndings: parsed.lineEndings,
    defaultLineEnding: defaultLineEnding(parsed.lineEndings),
    editorText: parsed.editorText,
  };
}

function draftLineEndingKind(ending: ExternalLineEnding): "l" | "c" | "r" {
  return ending === "lf" ? "l" : ending === "crlf" ? "c" : "r";
}

function lineEndingFromDraftKind(kind: string): ExternalLineEnding | null {
  return kind === "l" ? "lf" : kind === "c" ? "crlf" : kind === "r" ? "cr" : null;
}

/**
 * Persist only the external spelling metadata that a logical editor draft
 * needs. The source remains the draft's existing LF-only content.
 */
export function editorDraftTextRepresentation(
  representation: ExternalTextRepresentation,
): EditorDraftTextRepresentation {
  return {
    hasBom: representation.hasBom,
    lineEndingKinds: representation.lineEndings.map(draftLineEndingKind).join(""),
    defaultLineEnding: representation.defaultLineEnding,
  };
}

/**
 * Reconstruct the external save boundary for a version-3 private draft. A
 * malformed or legacy metadata envelope deliberately falls back to the disk
 * snapshot instead of guessing at source bytes.
 */
export function externalTextRepresentationFromDraft(
  editorText: string,
  persisted: EditorDraftTextRepresentation | null,
): ExternalTextRepresentation | null {
  if (!persisted || normalizeInsertedEditorText(editorText) !== editorText) {
    return null;
  }
  if (
    typeof persisted.hasBom !== "boolean" ||
    typeof persisted.lineEndingKinds !== "string" ||
    (persisted.defaultLineEnding !== "lf" &&
      persisted.defaultLineEnding !== "crlf" &&
      persisted.defaultLineEnding !== "cr") ||
    persisted.lineEndingKinds.length !== newlineCount(editorText)
  ) {
    return null;
  }
  const lineEndings: ExternalLineEnding[] = [];
  for (const kind of persisted.lineEndingKinds) {
    const ending = lineEndingFromDraftKind(kind);
    if (!ending) return null;
    lineEndings.push(ending);
  }
  return {
    hasBom: persisted.hasBom,
    lineEndings,
    defaultLineEnding: persisted.defaultLineEnding,
    editorText,
  };
}

/**
 * Decide whether a recovered private draft is already present on disk. Version
 * 3 drafts compare their reconstructed external bytes, so a stale disk file
 * with the same logical text but different BOM or endings still takes the
 * conflict-safe recovery path. Legacy drafts retain their former logical-text
 * comparison because they did not persist representation metadata.
 */
export function editorDraftMatchesDiskText(
  editorText: string,
  persisted: EditorDraftTextRepresentation | null,
  diskText: string,
): boolean {
  const representation = externalTextRepresentationFromDraft(editorText, persisted);
  if (representation) {
    return externalTextFromEditor(editorText, representation) === diskText;
  }
  return editorTextFromExternal(editorText) === editorTextFromExternal(diskText);
}

export function editorTextFromExternal(source: string): string {
  return parseExternalText(source).editorText;
}

export function externalTextFromEditor(
  editorText: string,
  representation: ExternalTextRepresentation,
): string {
  // The editor document may contain a literal U+FEFF inserted by the user.
  // Only the external load boundary interprets a leading U+FEFF as the file
  // BOM; never strip it while serializing an editor edit.
  const normalized = normalizeInsertedEditorText(editorText);
  const lines = normalized.split("\n");
  let external = representation.hasBom ? "\uFEFF" : "";
  for (let index = 0; index < lines.length; index += 1) {
    external += lines[index] ?? "";
    if (index >= lines.length - 1) {
      continue;
    }
    external += lineEndingBytes(
      representation.lineEndings[index] ?? representation.defaultLineEnding,
    );
  }
  return external;
}

function newlineCount(source: string): number {
  let count = 0;
  for (const character of source) {
    if (character === "\n") count += 1;
  }
  return count;
}

/**
 * Apply the changes from one CodeMirror transaction to the external metadata
 * model.  Changes are expressed in the transaction's old-document
 * coordinates.  Applying them from right to left keeps those coordinates
 * stable and preserves every untouched line-ending entry.
 */
export function applyEditorTextChanges(
  representation: ExternalTextRepresentation,
  oldEditorText: string,
  changes: readonly EditorTextChange[],
): ExternalTextRepresentation {
  // The editor already uses logical LF text. A leading U+FEFF here may be
  // literal document content inserted after load, so never reinterpret it as
  // the external file BOM at the edit boundary.
  let editorText = normalizeInsertedEditorText(oldEditorText);
  let lineEndings = [...representation.lineEndings];
  const ordered = [...changes].sort((left, right) => right.from - left.from);
  for (const change of ordered) {
    const from = Math.max(0, Math.min(change.from, editorText.length));
    const to = Math.max(from, Math.min(change.to, editorText.length));
    // A pasted U+FEFF is document text, not a new file-BOM marker.
    const inserted = normalizeInsertedEditorText(change.insert);
    const startLine = newlineCount(editorText.slice(0, from));
    const removedBreaks = newlineCount(editorText.slice(from, to));
    const insertedBreaks = newlineCount(inserted);
    editorText = `${editorText.slice(0, from)}${inserted}${editorText.slice(to)}`;
    lineEndings = [
      ...lineEndings.slice(0, startLine),
      ...Array.from({ length: insertedBreaks }, () => representation.defaultLineEnding),
      ...lineEndings.slice(startLine + removedBreaks),
    ];
  }
  return {
    ...representation,
    lineEndings,
    editorText,
  };
}
