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

  it("splits wikilink paths from heading and block subpaths at the first hash", () => {
    expect(parseLinktext("Folder/Note#Heading#Nested")).toEqual({
      path: "Folder/Note",
      subpath: "#Heading#Nested",
    });
    expect(parseLinktext("#^block-id")).toEqual({ path: "", subpath: "#^block-id" });
    expect(parseLinktext("Folder/Note")).toEqual({ path: "Folder/Note", subpath: "" });
    expect(getLinkpath("Folder/Note#Heading")).toBe("Folder/Note");
  });

  it("serializes YAML without document fences and keeps typed collection shapes", () => {
    expect(
      stringifyYaml({
        title: "A: B",
        tags: ["one", "two"],
        enabled: true,
      }),
    ).toBe('title: "A: B"\ntags:\n  - one\n  - two\nenabled: true\n');
  });

  it("matches every space-separated simple-search word and returns UTF-16 ranges", () => {
    const search = prepareSimpleSearch("alpha gamma");
    const direct = search("Alpha beta GAMMA");
    const delayed = search("prefix alpha with a delayed gamma");

    expect(direct?.matches).toEqual([
      [0, 5],
      [11, 16],
    ]);
    expect(prepareSimpleSearch("gamma alpha")("Alpha beta GAMMA")).toEqual(direct);
    expect(prepareSimpleSearch("alpha alpha")("alpha beta alpha")).toEqual({
      score: 0,
      matches: [[0, 5]],
    });
    expect(direct?.score).toBeGreaterThan(delayed?.score ?? Number.NEGATIVE_INFINITY);
    expect(search("alpha only")).toBeNull();
    expect(prepareSimpleSearch("")("anything")).toEqual({ score: 0, matches: [] });
    expect(prepareSimpleSearch("🧵 leaf")("🧵 Threadleaf")?.matches).toEqual([
      [0, 2],
      [9, 13],
    ]);
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
