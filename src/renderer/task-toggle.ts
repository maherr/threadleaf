import { parseMarkdownTasks, toggleMarkdownTaskStatus } from "../kernel/markdown-tasks";

export interface MarkdownTaskSelection {
  from: number;
  to: number;
}

export interface MarkdownTaskStatusChange {
  from: number;
  to: number;
  insert: string;
}

function boundedOffset(source: string, value: number): number {
  return Math.min(source.length, Math.max(0, value));
}

function sourceLineAtOffset(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") {
      line += 1;
    }
  }
  return line;
}

/**
 * Return every source line touched by CodeMirror-style selections. An
 * endpoint at the beginning of the next line does not select that next line.
 */
export function markdownTaskLinesForSelections(
  source: string,
  selections: readonly MarkdownTaskSelection[],
): ReadonlySet<number> {
  const lines = new Set<number>();
  for (const selection of selections) {
    const from = boundedOffset(source, Math.min(selection.from, selection.to));
    const to = boundedOffset(source, Math.max(selection.from, selection.to));
    const finalOffset = from === to ? from : Math.max(from, to - 1);
    const firstLine = sourceLineAtOffset(source, from);
    const lastLine = sourceLineAtOffset(source, finalOffset);
    for (let line = firstLine; line <= lastLine; line += 1) {
      lines.add(line);
    }
  }
  return lines;
}

/**
 * Build exact single-marker replacements for the tasks touched by a command
 * selection. Consumers dispatch these through their existing editor model.
 */
export function markdownTaskToggleChanges(
  source: string,
  selections: readonly MarkdownTaskSelection[],
): MarkdownTaskStatusChange[] {
  const selectedLines = markdownTaskLinesForSelections(source, selections);
  return parseMarkdownTasks(source)
    .filter((task) => selectedLines.has(task.line))
    .map((task) => ({
      from: task.statusStart,
      to: task.statusEnd,
      insert: toggleMarkdownTaskStatus(task.status),
    }));
}
