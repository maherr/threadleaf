import { bench, describe } from "vitest";
import { type FullTextSearchDocument, FullTextSearchIndex } from "./full-text-search";

const documentCount = 10_000;
const documents: FullTextSearchDocument[] = Array.from({ length: documentCount }, (_, item) => ({
  path: `Projects/Area ${item % 40}/Note ${String(item).padStart(5, "0")}.md`,
  content: [
    "---",
    `status: ${item % 3 === 0 ? "active" : "reference"}`,
    "---",
    `# Project note ${item}`,
    "Ordinary workspace prose repeated across the deterministic benchmark corpus.",
    item === documentCount - 1
      ? "A singular lighthouse-needle appears in the final document."
      : `Sequence marker ${item}.`,
  ].join("\n"),
  headings: [{ text: `Project note ${item}`, line: 4 }],
  tags: [item % 3 === 0 ? "active" : "reference", `area-${item % 40}`],
  properties: { status: item % 3 === 0 ? "active" : "reference" },
}));

const index = new FullTextSearchIndex();
index.replace(documents);

const longSnippetSource = `${"prefix 😀 Cafe\u0301 ".repeat(4_096)}needle exact suffix`;
const longSnippetIndex = new FullTextSearchIndex();
longSnippetIndex.upsert({
  path: "Projects/Long snippet.md",
  content: longSnippetSource,
  headings: [],
  tags: [],
  properties: {},
});

describe(`FullTextSearchIndex (${documentCount.toLocaleString("en-US")} notes)`, () => {
  bench("rebuild derived search state", () => {
    const rebuilt = new FullTextSearchIndex();
    rebuilt.replace(documents);
  });

  bench("find a rare match in the final document", () => {
    index.search("lighthouse-needle");
  });

  bench("rank and truncate a common two-term query", () => {
    index.search("ordinary workspace", 50);
  });

  bench("project a long matching line for its source-faithful snippet", () => {
    const context = longSnippetIndex.search("needle", 1, { maxContexts: 1 }).results[0]
      ?.contexts[0];
    if (!context?.text.includes("needle exact")) {
      throw new Error("Long-line snippet benchmark did not exercise snippet projection.");
    }
  });
});
