import v8 from "node:v8";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { maskMarkdownCodeAndComments } from "./markdown-links";
import { MetadataIndex } from "./metadata-index";
import type { VaultTextSnapshot } from "./ports";

/**
 * Retention regression guard for metadata string flattening.
 *
 * A heading, tag, or link target parsed out of a note is a V8 SlicedString: a
 * small header pointing at the note it was cut from. Keeping one keeps the
 * whole note, and `parseDocument` slices out of two extra full-note copies
 * (`stripFencedCode` and `maskMarkdownCodeAndComments`) that nothing else
 * holds, so a handful of short strings per note pinned three note-sized
 * buffers. This test measures that directly rather than asserting it.
 *
 * The forced collections come from `v8.setFlagsFromString`, so the suite needs
 * no special node flags and fails loudly if the hook ever disappears.
 */

v8.setFlagsFromString("--expose-gc");
const collectOnce = vm.runInNewContext("gc") as unknown;
if (typeof collectOnce !== "function") {
  throw new Error("Could not obtain a forced-collection hook; retention cannot be measured.");
}
const collect = collectOnce as () => void;

function settle(): void {
  // Repeated because one mark-compact can leave a young-generation survivor
  // that a second pass promotes and then reclaims.
  for (let pass = 0; pass < 6; pass += 1) {
    collect();
  }
}

/** Bytes still held after `build` returns and everything it allocated internally is dropped. */
function retainedBytes(build: () => unknown): { bytes: number; kept: unknown } {
  settle();
  const before = process.memoryUsage().heapUsed;
  const kept = build();
  settle();
  const after = process.memoryUsage().heapUsed;
  return { bytes: after - before, kept };
}

const noteCount = 40;
const bodyLineCount = 4_000;

function syntheticNote(seed: number): string {
  const lines = [
    "---",
    `title: Synthetic note ${seed}`,
    "tags: [alpha, beta]",
    "---",
    `# Heading ${seed} one`,
    "",
  ];
  for (let line = 0; line < bodyLineCount; line += 1) {
    if (line % 500 === 0) {
      lines.push(`## Section ${seed}-${line} heading text`);
    }
    if (line % 700 === 0) {
      lines.push(`See [[target-${seed}-${line}|Alias ${seed} ${line}]] and #tag-${seed}-${line}.`);
    }
    lines.push(`Body line ${line} of note ${seed} with ordinary prose worth about sixty bytes.`);
  }
  return lines.join("\n");
}

function snapshots(): VaultTextSnapshot[] {
  return Array.from({ length: noteCount }, (_, item) => {
    const content = syntheticNote(item);
    return {
      path: `Notes/${String(item).padStart(3, "0")}.md`,
      content,
      revision: `rev-${item}`,
      size: content.length,
    };
  });
}

const corpusBytes = snapshots().reduce((total, snapshot) => total + snapshot.content.length, 0);

/** The shape `parseDocument` used to retain: short slices of note-sized parents. */
function slicedMetadata(sources: readonly string[]): Array<{ headings: string[]; tags: string[] }> {
  return sources.map((content) => {
    const masked = maskMarkdownCodeAndComments(content);
    const headings: string[] = [];
    for (const line of content.split("\n")) {
      const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (heading?.[2]) {
        headings.push(heading[2]);
      }
    }
    const tags: string[] = [];
    for (const tag of masked.matchAll(/(?:^|[\s(])#([\p{L}\p{N}_/-]+)/gu)) {
      if (tag[1]) {
        tags.push(tag[1]);
      }
    }
    return { headings, tags };
  });
}

function flattenAll(
  entries: Array<{ headings: string[]; tags: string[] }>,
): Array<{ headings: string[]; tags: string[] }> {
  const flatten = (value: string): string => {
    const copy = Buffer.from(value, "utf8").toString("utf8");
    return copy === value ? copy : value;
  };
  return entries.map((entry) => ({
    headings: entry.headings.map(flatten),
    tags: entry.tags.map(flatten),
  }));
}

describe("metadata string flattening detaches parent notes", () => {
  it("keeps note-sized parents alive when short strings are left as slices", () => {
    const sliced = retainedBytes(() => slicedMetadata(snapshots().map((entry) => entry.content)));
    const flattened = retainedBytes(() =>
      flattenAll(slicedMetadata(snapshots().map((entry) => entry.content))),
    );

    // The control must actually pin: metadata is a few kilobytes per note, so
    // holding more than half the corpus proves the parents are alive.
    expect(
      sliced.bytes,
      `sliced retention ${sliced.bytes} should exceed half the ${corpusBytes} byte corpus`,
    ).toBeGreaterThan(corpusBytes / 2);
    // Flattened metadata is the strings themselves and nothing else.
    expect(
      flattened.bytes,
      `flattened retention ${flattened.bytes} against sliced ${sliced.bytes}`,
    ).toBeLessThan(corpusBytes / 10);
    expect(sliced.kept).toBeDefined();
    expect(flattened.kept).toBeDefined();
  });

  it("holds a built index near the text it must keep, not a multiple of it", () => {
    const built = retainedBytes(() => MetadataIndex.fromSnapshots(snapshots()));

    // The index legitimately retains two whole-note strings per note: the saved
    // source, which query-time line derivation needs, and one folded key. The
    // pre-fix parser added the fenced-code-stripped and masked copies on top
    // through pinned metadata slices, which the control above shows costs a
    // further note-sized buffer per note per pinned copy.
    expect(
      built.bytes,
      `index retention ${built.bytes} for a ${corpusBytes} byte corpus`,
    ).toBeLessThan(corpusBytes * 3);
    expect((built.kept as MetadataIndex).snapshot().documents).toHaveLength(noteCount);
  });
});
