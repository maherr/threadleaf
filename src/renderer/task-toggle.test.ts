import { describe, expect, it } from "vitest";
import {
  type MarkdownTaskStatusChange,
  markdownTaskLinesForSelections,
  markdownTaskToggleChanges,
} from "./task-toggle";

function applyChanges(source: string, changes: readonly MarkdownTaskStatusChange[]): string {
  let result = source;
  for (const change of [...changes].sort((left, right) => right.from - left.from)) {
    result = `${result.slice(0, change.from)}${change.insert}${result.slice(change.to)}`;
  }
  return result;
}

describe("Markdown task toggle changes", () => {
  it("changes only selected nested, indented, quoted, and custom status markers", () => {
    const source = [
      "\ufeff- [ ] root",
      "  * [x] nested",
      "> - [?] quoted",
      "    1. [🟡] indented unicode",
      "- [-] untouched",
    ].join("\r\n");
    const nested = source.indexOf("  * [x]");
    const unicodeEnd = source.indexOf("\r\n- [-]");

    const changes = markdownTaskToggleChanges(source, [{ from: nested, to: unicodeEnd }]);

    expect(changes).toEqual([
      { from: source.indexOf("x]"), to: source.indexOf("x]") + 1, insert: " " },
      { from: source.indexOf("?]"), to: source.indexOf("?") + 1, insert: " " },
      {
        from: source.indexOf("🟡]"),
        to: source.indexOf("🟡]") + "🟡".length,
        insert: " ",
      },
    ]);
    expect(applyChanges(source, changes)).toBe(
      [
        "\ufeff- [ ] root",
        "  * [ ] nested",
        "> - [ ] quoted",
        "    1. [ ] indented unicode",
        "- [-] untouched",
      ].join("\r\n"),
    );
  });

  it("uses the cursor line or every selected line without including an endpoint line", () => {
    const source = ["- [ ] first", "- [x] second", "- [?] third"].join("\n");
    const second = source.indexOf("- [x]");
    const third = source.indexOf("- [?]");

    expect(markdownTaskLinesForSelections(source, [{ from: second, to: second }])).toEqual(
      new Set([2]),
    );
    expect(markdownTaskToggleChanges(source, [{ from: 0, to: third }])).toEqual([
      { from: 3, to: 4, insert: "x" },
      { from: second + 3, to: second + 4, insert: " " },
    ]);
    expect(
      markdownTaskToggleChanges(source, [
        { from: 0, to: 0 },
        { from: third, to: third },
      ]),
    ).toEqual([
      { from: 3, to: 4, insert: "x" },
      { from: third + 3, to: third + 4, insert: " " },
    ]);
  });
});
