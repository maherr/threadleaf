import type {
  EditorTextChange,
  ExternalLineEnding,
  ExternalTextRepresentation,
} from "./editor-text";

/**
 * One editor transaction's source delta. History intentionally stores only
 * changed text and changed line-ending slices, never a full note snapshot.
 */
export interface EditorTextHistoryChange extends EditorTextChange {
  newFrom: number;
  newTo: number;
  removedText: string;
  removedLineEndings: readonly ExternalLineEnding[];
  insertedLineEndings: readonly ExternalLineEnding[];
}

export interface EditorTextHistoryEntry {
  changes: readonly EditorTextHistoryChange[];
}

function newlineCount(source: string): number {
  let count = 0;
  for (const character of source) {
    if (character === "\n") count += 1;
  }
  return count;
}

function historyTextAfterChange(
  text: string,
  change: EditorTextHistoryChange,
  direction: "forward" | "reverse",
): string {
  if (direction === "forward") {
    return `${text.slice(0, change.from)}${change.insert}${text.slice(change.to)}`;
  }
  return `${text.slice(0, change.newFrom)}${change.removedText}${text.slice(change.newTo)}`;
}

function orderedChanges(
  entry: EditorTextHistoryEntry,
  direction: "forward" | "reverse",
): EditorTextHistoryChange[] {
  return [...entry.changes].sort((left, right) => {
    const leftPosition = direction === "forward" ? left.from : left.newFrom;
    const rightPosition = direction === "forward" ? right.from : right.newFrom;
    return rightPosition - leftPosition;
  });
}

export function historyTextAfterEntry(
  text: string,
  entry: EditorTextHistoryEntry,
  direction: "forward" | "reverse",
): string {
  let result = text;
  for (const change of orderedChanges(entry, direction)) {
    result = historyTextAfterChange(result, change, direction);
  }
  return result;
}

export function editorHistoryTarget(
  history: readonly EditorTextHistoryEntry[],
  editorText: string,
  targetText: string,
  direction: "undo" | "redo",
): number {
  let candidate = editorText;
  if (direction === "undo") {
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const entry = history[index];
      if (!entry) continue;
      candidate = historyTextAfterEntry(candidate, entry, "reverse");
      if (candidate === targetText) return index;
    }
    return -1;
  }
  for (let index = 0; index < history.length; index += 1) {
    const entry = history[index];
    if (!entry) continue;
    candidate = historyTextAfterEntry(candidate, entry, "forward");
    if (candidate === targetText) return index;
  }
  return -1;
}

export function applyEditorTextHistoryEntry(
  representation: ExternalTextRepresentation,
  entry: EditorTextHistoryEntry,
  direction: "forward" | "reverse",
): ExternalTextRepresentation {
  let editorText = representation.editorText;
  let lineEndings = [...representation.lineEndings];
  for (const change of orderedChanges(entry, direction)) {
    const from = direction === "forward" ? change.from : change.newFrom;
    const removed =
      direction === "forward" ? change.removedLineEndings : change.insertedLineEndings;
    const inserted =
      direction === "forward" ? change.insertedLineEndings : change.removedLineEndings;
    const startLine = newlineCount(editorText.slice(0, from));
    lineEndings = [
      ...lineEndings.slice(0, startLine),
      ...inserted,
      ...lineEndings.slice(startLine + removed.length),
    ];
    editorText = historyTextAfterChange(editorText, change, direction);
  }
  return { ...representation, editorText, lineEndings };
}

export function representationAtEditorText(
  representation: ExternalTextRepresentation,
  editorText: string,
): ExternalTextRepresentation {
  const lineCount = newlineCount(editorText);
  const lineEndings = [...representation.lineEndings.slice(0, lineCount)];
  while (lineEndings.length < lineCount) {
    lineEndings.push(representation.defaultLineEnding);
  }
  return { ...representation, editorText, lineEndings };
}

export function captureEditorTextHistoryEntry(
  representation: ExternalTextRepresentation,
  oldEditorText: string,
  changes: readonly EditorTextHistoryChange[],
): EditorTextHistoryEntry {
  let editorText = oldEditorText;
  let lineEndings = [...representation.lineEndings];
  const captured = [...changes]
    .sort((left, right) => right.from - left.from)
    .map((change) => {
      const from = Math.max(0, Math.min(change.from, editorText.length));
      const to = Math.max(from, Math.min(change.to, editorText.length));
      const insert = change.insert.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
      const startLine = newlineCount(editorText.slice(0, from));
      const removedBreaks = newlineCount(editorText.slice(from, to));
      const insertedBreaks = newlineCount(insert);
      const removedLineEndings = lineEndings.slice(startLine, startLine + removedBreaks);
      const insertedLineEndings = Array.from(
        { length: insertedBreaks },
        () => representation.defaultLineEnding,
      );
      const result: EditorTextHistoryChange = {
        ...change,
        from,
        to,
        insert,
        removedText: editorText.slice(from, to),
        removedLineEndings,
        insertedLineEndings,
      };
      editorText = `${editorText.slice(0, from)}${insert}${editorText.slice(to)}`;
      lineEndings = [
        ...lineEndings.slice(0, startLine),
        ...insertedLineEndings,
        ...lineEndings.slice(startLine + removedBreaks),
      ];
      return result;
    });
  return { changes: captured.reverse() };
}
