import { describe, expect, it } from "vitest";
import {
  isCompletedMarkdownTaskStatus,
  markdownTaskStatusLabel,
  normalizeMarkdownTaskStatus,
  parseMarkdownTasks,
  toggleMarkdownTaskStatus,
} from "./markdown-tasks";

describe("Markdown tasks", () => {
  it("parses unordered, ordered, nested, quoted, and custom-status tasks", () => {
    const content = [
      "- [ ] open",
      "  * [x] done",
      "1. [?] waiting",
      "> - [-] cancelled",
      "+ [🟡] unicode",
      "- [ ]",
      "plain [ ] text",
      "- [ ]missing separator",
    ].join("\n");

    expect(parseMarkdownTasks(content)).toMatchObject([
      { line: 1, status: " ", text: "open" },
      { line: 2, status: "x", text: "done" },
      { line: 3, status: "?", text: "waiting" },
      { line: 4, status: "-", text: "cancelled" },
      { line: 5, status: "🟡", text: "unicode" },
      { line: 6, status: " ", text: "" },
    ]);
    expect(isCompletedMarkdownTaskStatus("x")).toBe(true);
    expect(isCompletedMarkdownTaskStatus("X")).toBe(true);
    expect(isCompletedMarkdownTaskStatus("-")).toBe(false);
    expect([" ", "x", "X", "-", "?", "🟡"].map(markdownTaskStatusLabel)).toEqual([
      "Open task",
      "Completed task",
      "Completed task",
      "Cancelled task",
      "Question task",
      "Task with custom status 🟡",
    ]);
  });

  it("ignores fenced code, inline code, HTML comments, and tab statuses without shifting offsets", () => {
    const content = [
      "```md",
      "- [ ] fenced",
      "```",
      "`- [ ] inline`",
      "<!--",
      "- [x] commented",
      "-->",
      "- [\t] tab status",
      "- [ ] real",
    ].join("\r\n");

    const tasks = parseMarkdownTasks(content);

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ line: 9, status: " ", text: "real" });
    const task = tasks[0];
    if (!task) {
      throw new Error("Expected the visible task.");
    }
    expect(content.slice(task.statusStart, task.statusEnd)).toBe(" ");
  });

  it("retains BOM-aware and Unicode status source ranges", () => {
    const content = "\ufeff- [🟡] first\r\n- [ ] second\r\n";
    const [first, second] = parseMarkdownTasks(content);

    expect(first).toMatchObject({ line: 1, status: "🟡", text: "first" });
    expect(second).toMatchObject({ line: 2, status: " ", text: "second" });
    expect(content.slice(first?.statusStart, first?.statusEnd)).toBe("🟡");
    expect(content.slice(second?.statusStart, second?.statusEnd)).toBe(" ");
    expect(normalizeMarkdownTaskStatus("🟡")).toBe("🟡");
    expect(toggleMarkdownTaskStatus(" ")).toBe("x");
    expect(toggleMarkdownTaskStatus("x")).toBe(" ");
    expect(toggleMarkdownTaskStatus("?")).toBe(" ");
    expect(toggleMarkdownTaskStatus("🟡")).toBe(" ");
    expect(() => normalizeMarkdownTaskStatus("]")).toThrow("Task status");
    expect(() => normalizeMarkdownTaskStatus("\t")).toThrow("Task status");
    expect(() => normalizeMarkdownTaskStatus("xx")).toThrow("Task status");
  });
});
