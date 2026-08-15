import { maskMarkdownCodeAndComments } from "./markdown-links";

export interface ParsedMarkdownTask {
  line: number;
  status: string;
  text: string;
  statusStart: number;
  statusEnd: number;
}

export function normalizeMarkdownTaskStatus(value: string): string {
  if (Array.from(value).length !== 1 || value === "]" || /[\r\n\t]/u.test(value)) {
    throw new Error("Task status must be one character other than ], a tab, or a line break.");
  }
  return value;
}

/**
 * Toggle a Markdown task marker without assigning meaning to custom states.
 *
 * `[ ]` is the one open form. Every other valid single-character marker is
 * treated as a checked-style state by the editing surfaces and resets to open.
 */
export function toggleMarkdownTaskStatus(status: string): string {
  return normalizeMarkdownTaskStatus(status) === " " ? "x" : " ";
}

export function isCompletedMarkdownTaskStatus(status: string): boolean {
  return status === "x" || status === "X";
}

export function parseMarkdownTasks(content: string): ParsedMarkdownTask[] {
  const searchable = maskMarkdownCodeAndComments(content);
  const sourceLines = content.match(/[^\r\n]*(?:\r\n|\n|$)/g) ?? [];
  const searchableLines = searchable.match(/[^\r\n]*(?:\r\n|\n|$)/g) ?? [];
  const tasks: ParsedMarkdownTask[] = [];
  let offset = 0;

  for (let index = 0; index < sourceLines.length; index += 1) {
    const full = sourceLines[index] ?? "";
    if (full.length === 0 && index === sourceLines.length - 1) {
      break;
    }
    const sourceLine = full.replace(/\r?\n$/, "");
    const searchableLine = (searchableLines[index] ?? "").replace(/\r?\n$/, "");
    const match =
      /^(\ufeff?(?:[\t ]*>[\t ]?)*[\t ]*(?:[-+*]|\d+[.)])[\t ]+\[)([^\]\r\n\t])\]([\t ]*)(.*)$/u.exec(
        searchableLine,
      );
    if (match?.[1] && match[2] !== undefined && match[3] !== undefined) {
      const trailingText = match[4] ?? "";
      if (match[3].length > 0 || trailingText.length === 0) {
        const statusStart = offset + match[1].length;
        const statusEnd = statusStart + match[2].length;
        const sourceClosingBracket = match[1].length + match[2].length;
        tasks.push({
          line: index + 1,
          status: match[2],
          text: sourceLine.slice(sourceClosingBracket + 1).trim(),
          statusStart,
          statusEnd,
        });
      }
    }
    offset += full.length;
  }

  return tasks;
}
