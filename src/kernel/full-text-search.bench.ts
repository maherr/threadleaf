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
});
