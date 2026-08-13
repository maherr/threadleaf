/**
 * CodeMirror stores a document as logical text.  Its document boundary is
 * therefore intentionally LF-only, while the vault boundary keeps the exact
 * external line-ending and BOM representation.  A line-ending entry belongs
 * to the newline immediately before the next logical line.
 */
export type ExternalLineEnding = "lf" | "crlf" | "cr";

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

function normalizeEditorText(source: string): string {
  return parseExternalText(source).editorText;
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

export function editorTextFromExternal(source: string): string {
  return parseExternalText(source).editorText;
}

export function externalTextFromEditor(
  editorText: string,
  representation: ExternalTextRepresentation,
): string {
  const normalized = normalizeEditorText(editorText);
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
  let editorText = normalizeEditorText(oldEditorText);
  let lineEndings = [...representation.lineEndings];
  const ordered = [...changes].sort((left, right) => right.from - left.from);
  for (const change of ordered) {
    const from = Math.max(0, Math.min(change.from, editorText.length));
    const to = Math.max(from, Math.min(change.to, editorText.length));
    const inserted = normalizeEditorText(change.insert);
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
