import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  App,
  CommandRegistry,
  createObsidianCompatibilityModule,
  getAllTags,
  getLinkpath,
  MetadataCache,
  NoticeBus,
  parseFrontMatterTags,
  parseLinktext,
  prepareSimpleSearch,
  stringifyYaml,
  Vault,
} from "./obsidian-compat";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

async function createTemporaryVault(
  files: Readonly<Record<string, string>>,
): Promise<{ rootPath: string; vault: Vault }> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-metadata-link-yaml-"));
  temporaryDirectories.push(rootPath);
  for (const [relativePath, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(rootPath, relativePath)), { recursive: true });
    await fs.writeFile(path.join(rootPath, relativePath), content, "utf8");
  }
  return { rootPath, vault: new Vault(rootPath) };
}

describe("Obsidian metadata, link, and YAML compatibility", () => {
  it("normalizes frontmatter tags to Obsidian-prefixed strings with null semantics", () => {
    expect(parseFrontMatterTags({ tags: ["project", "#urgent", " spaced ", 42] })).toEqual([
      "#project",
      "#urgent",
      "#spaced",
    ]);
    expect(parseFrontMatterTags({ tags: "project, #urgent" })).toEqual(["#project", "#urgent"]);
    expect(parseFrontMatterTags({ tags: [] })).toEqual([]);
    expect(parseFrontMatterTags({ tags: 42 })).toBeNull();
    expect(parseFrontMatterTags(null)).toBeNull();
  });

  it("combines frontmatter and inline tag occurrences without inventing tags", () => {
    const position = {
      start: { line: 2, col: 0, offset: 20 },
      end: { line: 2, col: 7, offset: 27 },
    };
    expect(
      getAllTags({
        frontmatter: { tags: ["project", "#urgent"] },
        tags: [
          { tag: "#urgent", position },
          { tag: "#inline", position },
        ],
      }),
    ).toEqual(["#project", "#urgent", "#urgent", "#inline"]);
    expect(getAllTags({})).toBeNull();
  });

  it("aggregates hierarchical tags, strips a final slash, and consolidates case", async () => {
    // Public API shape: https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts
    // Real-parser fixtures: host-verified against Obsidian 1.13.7 — a terminal
    // slash is stripped then participates in hierarchy counting, and numeric-only
    // ancestors are never synthesized (#2024/notes is kept, #2024 is not).
    const { vault } = await createTemporaryVault({
      "First.md": "#Home/Child\n",
      "Second.md": "#home/child #home/child #home\n",
      "Third.md": "#trail/child/\n",
      "Numeric.md": "#2024/notes\n",
    });
    const metadataCache = new MetadataCache(vault);
    expect(metadataCache.getTags()).toEqual({
      "#home": 4,
      "#home/child": 3,
      "#trail": 1,
      "#trail/child": 1,
      "#2024/notes": 1,
    });
  });

  it("splits wikilink paths from heading and block subpaths at the first hash", () => {
    expect(parseLinktext("Folder/Note#Heading#Nested")).toEqual({
      path: "Folder/Note",
      subpath: "#Heading#Nested",
    });
    expect(parseLinktext("#^block-id")).toEqual({ path: "", subpath: "#^block-id" });
    expect(parseLinktext("Folder/Note")).toEqual({ path: "Folder/Note", subpath: "" });
    expect(getLinkpath("Folder/Note#Heading")).toBe("Folder/Note");
  });

  it("serializes YAML with Obsidian null and duplicate-reference semantics", () => {
    // Public API declaration: https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts
    expect(
      stringifyYaml({
        title: "A: B",
        tags: ["one", "two"],
        enabled: true,
      }),
    ).toBe('title: "A: B"\ntags:\n  - one\n  - two\nenabled: true\n');
    expect(stringifyYaml({ a: null })).toBe("a:\n");

    const shared = { n: 1 };
    expect(stringifyYaml({ a: shared, b: shared })).toBe("a:\n  n: 1\nb:\n  n: 1\n");
  });

  it("matches all simple-search occurrences with host whitespace, merge, and score semantics", () => {
    // `prepareSimpleSearch()` documents space-separated words and SearchResult's score/ranges:
    // https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts
    const duplicate = prepareSimpleSearch("alpha alpha")("alpha beta alpha");
    expect(duplicate?.matches).toEqual([
      [0, 5],
      [11, 16],
    ]);
    expect(duplicate?.score).toBeCloseTo(-1.0616, 12);

    const repeatedSpace = prepareSimpleSearch("alpha  beta")("alpha beta");
    expect(repeatedSpace?.matches).toEqual([
      [0, 5],
      [6, 10],
    ]);
    expect(repeatedSpace?.score).toBeCloseTo(-1.001, 12);

    const overlap = prepareSimpleSearch("ab bc")("abc");
    expect(overlap?.matches).toEqual([[0, 3]]);
    expect(overlap?.score).toBeCloseTo(0.0097, 12);

    const shortWords = prepareSimpleSearch("a b")("a b");
    expect(shortWords?.matches).toEqual([
      [0, 1],
      [2, 3],
    ]);
    expect(shortWords?.score).toBeCloseTo(-1.0103, 12);
    expect(prepareSimpleSearch("alpha gamma")("alpha only")).toBeNull();
    expect(prepareSimpleSearch("")("anything")).toEqual({ score: 0, matches: [] });
  });

  it("uses lowercased-string UTF-16 offsets for length-changing case folds", () => {
    // SearchMatchPart is an inclusive-start, exclusive-end offset pair in the public declaration:
    // https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts
    const lengthChanging = prepareSimpleSearch("İ")("İ");
    expect(lengthChanging?.matches).toEqual([[0, 2]]);
    expect(lengthChanging?.score).toBeCloseTo(-0.0201, 12);

    const trailingMatch = prepareSimpleSearch("y")("xİy");
    expect(trailingMatch?.matches).toEqual([[3, 4]]);
    expect(trailingMatch?.score).toBeCloseTo(-0.0133, 12);

    const greek = prepareSimpleSearch("ος")("ΟΣ");
    expect(greek?.matches).toEqual([[0, 2]]);
    expect(greek?.score).toBeCloseTo(-0.0102, 12);
  });

  it("builds Obsidian-shaped file caches and aggregate tag counts from canonical note bytes", async () => {
    const { vault } = await createTemporaryVault({
      "First.md": [
        "---",
        "tags: [project, '#urgent']",
        "---",
        "#urgent and #inline/tag, then #urgent again",
        "`#masked`",
        "<!-- #hidden -->",
      ].join("\n"),
      "Second.md": "#project\n",
    });
    const metadataCache = new MetadataCache(vault);
    const first = vault.getFileByPath("First.md");
    const firstCache = metadataCache.getFileCache(first);

    expect(firstCache?.tags?.map(({ tag }) => tag)).toEqual(["#urgent", "#inline/tag", "#urgent"]);
    expect(firstCache?.tags?.[0]?.position).toMatchObject({
      start: { line: 3, col: 0 },
      end: { line: 3, col: 7 },
    });
    expect(metadataCache.getTags()).toEqual({
      "#inline": 1,
      "#inline/tag": 1,
      "#project": 2,
      "#urgent": 3,
    });
  });

  it("returns every visible folder, including empty folders, and includes root only on request", async () => {
    const { rootPath, vault } = await createTemporaryVault({
      "Boards/Kanban.md": "board\n",
      ".obsidian/ignored.txt": "private\n",
    });
    await fs.mkdir(path.join(rootPath, "Empty", "Nested"), { recursive: true });

    expect(vault.getAllFolders().map(({ path: folderPath }) => folderPath)).toEqual([
      "Boards",
      "Empty",
      "Empty/Nested",
    ]);
    expect(vault.getAllFolders(true).map(({ path: folderPath }) => folderPath)).toEqual([
      "",
      "Boards",
      "Empty",
      "Empty/Nested",
    ]);
  });

  it("deduplicates available paths case-insensitively without changing extensions", async () => {
    const { rootPath, vault } = await createTemporaryVault({
      "Note.md": "first\n",
      "Note 1.md": "second\n",
      "CASE.md": "case collision\n",
    });
    await fs.mkdir(path.join(rootPath, "Taken"));

    expect(vault.getAvailablePath("Note", "md")).toBe("Note 2.md");
    expect(vault.getAvailablePath("Fresh", ".md")).toBe("Fresh.md");
    expect(vault.getAvailablePath("case", "md")).toBe("case 1.md");
    expect(vault.getAvailablePath("Taken", "")).toBe("Taken 1");
  });

  it("counts private occupied paths and rejects unsafe available-path inputs", async () => {
    const { vault } = await createTemporaryVault({
      ".Private.md": "private\n",
      ".Secret/Claim.md": "hidden nested claim\n",
    });

    expect(vault.getAvailablePath(".private", "md")).toBe(".private 1.md");
    expect(vault.getAvailablePath(".secret/claim", "md")).toBe(".secret/claim 1.md");
    expect(() => vault.getAvailablePath("../outside", "md")).toThrow("escapes the vault");
    expect(() => vault.getAvailablePath("/absolute/name", "md")).toThrow("vault-relative");
    expect(() => vault.getAvailablePath("Note", "../md")).toThrow("plain extension");
  });

  it("publishes the shared helper references on the compatibility module", async () => {
    const { vault } = await createTemporaryVault({ "Note.md": "body\n" });
    const app = new App(vault, new CommandRegistry(), new NoticeBus(() => undefined));
    const compatibility = createObsidianCompatibilityModule(app);

    expect(compatibility.parseFrontMatterTags).toBe(parseFrontMatterTags);
    expect(compatibility.getAllTags).toBe(getAllTags);
    expect(compatibility.getLinkpath).toBe(getLinkpath);
    expect(compatibility.parseLinktext).toBe(parseLinktext);
    expect(compatibility.stringifyYaml).toBe(stringifyYaml);
    expect(compatibility.prepareSimpleSearch).toBe(prepareSimpleSearch);
  });
});
