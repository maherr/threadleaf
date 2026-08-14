import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { revisionOf } from "../kernel/durability";
import {
  App,
  CommandRegistry,
  createObsidianCompatibilityModule,
  FileManager,
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

function writableVault(rootPath: string): { vault: Vault; writeText: ReturnType<typeof vi.fn> } {
  const writeText = vi.fn(async (filePath: string, content: string, expectedRevision: string) => {
    const absolutePath = path.join(rootPath, filePath);
    const before = await fs.readFile(absolutePath);
    expect(expectedRevision).toBe(revisionOf(before));
    await fs.writeFile(absolutePath, content, "utf8");
    return {
      status: "committed" as const,
      path: filePath,
      revision: revisionOf(Buffer.from(content, "utf8")),
      transactionId: `frontmatter-${writeText.mock.calls.length}`,
    };
  });
  return { vault: new Vault(rootPath, undefined, { writeText }), writeText };
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

  it("projects unresolved and ambiguous local links with per-source occurrence counts", async () => {
    const { vault } = await createTemporaryVault({
      "A.md": [
        "[[B]]",
        "[[Missing]] and [[Missing#Heading|Alias]]",
        "[Other](Other.md)",
        "[[Same]]",
      ].join("\n"),
      "B.md": "resolved\n",
      "One/Same.md": "ambiguous one\n",
      "Two/Same.md": "ambiguous two\n",
    });

    expect(new MetadataCache(vault).unresolvedLinks).toEqual({
      "A.md": {
        Missing: 2,
        "Other.md": 1,
        Same: 1,
      },
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

  it("deduplicates available note and attachment paths without changing extensions", async () => {
    const { vault } = await createTemporaryVault({
      "Note.md": "first\n",
      "Note 1.md": "second\n",
      "CASE.md": "case collision\n",
      "Boards/Kanban.md": "board\n",
      "Boards/Pasted image.png": "image\n",
    });
    const board = vault.getFileByPath("Boards/Kanban.md");
    if (!board) {
      throw new Error("Board fixture was not discovered.");
    }

    expect(vault.getAvailablePath("Note", "md")).toBe("Note 2.md");
    expect(vault.getAvailablePath("Fresh", ".md")).toBe("Fresh.md");
    expect(vault.getAvailablePath("case", "md")).toBe("case 1.md");
    await expect(vault.getAvailablePathForAttachments("Pasted image", "png", board)).resolves.toBe(
      "Boards/Pasted image 1.png",
    );
    await expect(
      new FileManager(vault).getAvailablePathForAttachment("Pasted image.png", "Boards/Kanban.md"),
    ).resolves.toBe("Boards/Pasted image 1.png");
  });

  it("patches supported frontmatter while preserving BOM, CRLF, comments, body, and unrelated YAML", async () => {
    const before = [
      "\ufeff---",
      'title: "Old" # keep title comment',
      "complex: &anchor",
      "  nested: value",
      "alias: *anchor",
      "tags:",
      "  - first",
      "---",
      "Body stays exact.",
      "",
    ].join("\r\n");
    const { rootPath } = await createTemporaryVault({ "Note.md": before });
    const { vault, writeText } = writableVault(rootPath);
    const file = vault.getFileByPath("Note.md");
    if (!file) {
      throw new Error("Frontmatter fixture was not discovered.");
    }

    await new FileManager(vault).processFrontMatter(file, (frontmatter) => {
      frontmatter.title = "New";
      if (!Array.isArray(frontmatter.tags)) {
        throw new Error("Tags fixture was not parsed as an array.");
      }
      frontmatter.tags.push("second");
      frontmatter.enabled = true;
    });

    const after = await fs.readFile(path.join(rootPath, "Note.md"), "utf8");
    expect(after).toBe(
      [
        "\ufeff---",
        'title: "New" # keep title comment',
        "complex: &anchor",
        "  nested: value",
        "alias: *anchor",
        "tags:",
        "  - first",
        "  - second",
        "enabled: true",
        "---",
        "Body stays exact.",
        "",
      ].join("\r\n"),
    );
    expect(writeText).toHaveBeenCalledOnce();
  });

  it("creates frontmatter without disturbing a BOM or body and skips a no-op mutation", async () => {
    const before = "\ufeffBody\r\n";
    const { rootPath } = await createTemporaryVault({ "Note.md": before });
    const { vault, writeText } = writableVault(rootPath);
    const file = vault.getFileByPath("Note.md");
    if (!file) {
      throw new Error("Frontmatter creation fixture was not discovered.");
    }
    const fileManager = new FileManager(vault);

    await fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter.tags = ["created"];
    });
    await fileManager.processFrontMatter(file, () => undefined);

    await expect(fs.readFile(path.join(rootPath, "Note.md"), "utf8")).resolves.toBe(
      "\ufeff---\r\ntags:\r\n  - created\r\n---\r\nBody\r\n",
    );
    expect(writeText).toHaveBeenCalledOnce();
  });

  it("fails closed when a callback would normalize unsupported YAML", async () => {
    const before = [
      "---",
      "complex: &anchor",
      "  nested: value",
      "alias: *anchor",
      "---",
      "Body",
      "",
    ].join("\n");
    const { rootPath } = await createTemporaryVault({ "Note.md": before });
    const { vault, writeText } = writableVault(rootPath);
    const file = vault.getFileByPath("Note.md");
    if (!file) {
      throw new Error("Unsupported YAML fixture was not discovered.");
    }

    await expect(
      new FileManager(vault).processFrontMatter(file, (frontmatter) => {
        frontmatter.alias = { nested: "changed" };
      }),
    ).rejects.toThrow("unsupported YAML");
    expect(writeText).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(rootPath, "Note.md"), "utf8")).resolves.toBe(before);
  });

  it("refuses to invent YAML aliases from shared callback objects", async () => {
    const before = "---\ntitle: Plain\n---\nBody\n";
    const { rootPath } = await createTemporaryVault({ "Note.md": before });
    const { vault, writeText } = writableVault(rootPath);
    const file = vault.getFileByPath("Note.md");
    if (!file) {
      throw new Error("Shared-object fixture was not discovered.");
    }
    const shared = { nested: "value" };

    await expect(
      new FileManager(vault).processFrontMatter(file, (frontmatter) => {
        frontmatter.items = [shared, shared];
      }),
    ).rejects.toThrow("implicit YAML aliases");
    expect(writeText).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(rootPath, "Note.md"), "utf8")).resolves.toBe(before);
  });

  it("publishes one helper function per bare or obsidian-prefixed module access path", async () => {
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
