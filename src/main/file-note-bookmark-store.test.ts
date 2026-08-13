import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNoteBookmarks } from "../application/note-bookmarks";
import { FileNoteBookmarkStore } from "./file-note-bookmark-store";

let sandboxPath: string;
let bookmarkDirectory: string;
const vaultId = "b".repeat(64);

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-bookmarks-"));
  bookmarkDirectory = path.join(sandboxPath, "state", "bookmarks");
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

describe("FileNoteBookmarkStore", () => {
  it("returns null without creating state", async () => {
    const store = new FileNoteBookmarkStore(bookmarkDirectory);

    await expect(store.load(vaultId)).resolves.toBeNull();
    await expect(fs.stat(bookmarkDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("atomically saves normalized private bookmark state with owner-only permissions", async () => {
    const store = new FileNoteBookmarkStore(bookmarkDirectory);
    const saved = await store.save(createNoteBookmarks(vaultId, ["Folder/Note.md"]));

    await expect(store.load(vaultId)).resolves.toEqual(saved);
    const filePath = path.join(bookmarkDirectory, `${vaultId}.json`);
    const stat = await fs.stat(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe(
      `${JSON.stringify(saved, null, 2)}\n`,
    );
  });

  it("fails loudly without rewriting malformed state", async () => {
    const store = new FileNoteBookmarkStore(bookmarkDirectory);
    const filePath = path.join(bookmarkDirectory, `${vaultId}.json`);
    await fs.mkdir(bookmarkDirectory, { recursive: true });
    await fs.writeFile(filePath, '{"version":2,"paths":[]}\n', "utf8");

    await expect(store.load(vaultId)).rejects.toThrow("version 1");
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe('{"version":2,"paths":[]}\n');
  });
});
