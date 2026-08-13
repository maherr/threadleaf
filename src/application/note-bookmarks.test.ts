import { describe, expect, it } from "vitest";
import {
  createNoteBookmarks,
  maximumNoteBookmarks,
  NoteBookmarkController,
  type NoteBookmarkStore,
  type PersistedNoteBookmarks,
  parseNoteBookmarks,
} from "./note-bookmarks";

class MemoryBookmarkStore implements NoteBookmarkStore {
  value: PersistedNoteBookmarks | null = null;
  saveError: Error | null = null;
  readonly saved: PersistedNoteBookmarks[] = [];

  async load(): Promise<PersistedNoteBookmarks | null> {
    return this.value;
  }

  async save(bookmarks: PersistedNoteBookmarks): Promise<PersistedNoteBookmarks> {
    if (this.saveError) {
      throw this.saveError;
    }
    this.value = bookmarks;
    this.saved.push(bookmarks);
    return bookmarks;
  }
}

const vaultId = "a".repeat(64);

describe("note bookmarks", () => {
  it("normalizes ordered Markdown paths and rejects unsafe or ambiguous state", () => {
    expect(createNoteBookmarks(vaultId, ["Folder\\First.md", "Second.md"])).toEqual({
      version: 1,
      vaultId,
      paths: ["Folder/First.md", "Second.md"],
    });
    expect(() => createNoteBookmarks(vaultId, ["Note.md", "Note.md"])).toThrow("duplicate");
    expect(() => createNoteBookmarks(vaultId, ["Image.png"])).toThrow("only Markdown");
    expect(() => createNoteBookmarks(vaultId, [".obsidian/Private.md"])).toThrow("hidden");
    expect(() => createNoteBookmarks(vaultId, ["Folder/.secret/Private.md"])).toThrow("hidden");
    expect(() => createNoteBookmarks(vaultId, ["../Outside.md"])).toThrow("traversal");
    expect(() => parseNoteBookmarks({ version: 2, vaultId, paths: [] }, vaultId)).toThrow(
      "version 1",
    );
  });

  it("bounds bookmark state", () => {
    const paths = Array.from({ length: maximumNoteBookmarks + 1 }, (_, index) => `${index}.md`);
    expect(() => createNoteBookmarks(vaultId, paths)).toThrow(`more than ${maximumNoteBookmarks}`);
  });

  it("persists idempotent set and remove operations in insertion order", async () => {
    const store = new MemoryBookmarkStore();
    const controller = new NoteBookmarkController(store);

    await expect(controller.set(vaultId, "First.md", true)).resolves.toMatchObject({
      paths: ["First.md"],
    });
    await expect(controller.set(vaultId, "First.md", true)).resolves.toMatchObject({
      paths: ["First.md"],
    });
    await expect(controller.set(vaultId, "Folder/Second.md", true)).resolves.toMatchObject({
      paths: ["First.md", "Folder/Second.md"],
    });
    await expect(controller.set(vaultId, "First.md", false)).resolves.toMatchObject({
      paths: ["Folder/Second.md"],
    });

    expect(store.saved).toHaveLength(3);
  });

  it("serializes concurrent mutations and keeps the active state when persistence fails", async () => {
    const store = new MemoryBookmarkStore();
    const controller = new NoteBookmarkController(store);

    await Promise.all([
      controller.set(vaultId, "First.md", true),
      controller.set(vaultId, "Second.md", true),
    ]);
    expect((await controller.get(vaultId)).paths).toEqual(["First.md", "Second.md"]);

    store.saveError = new Error("bookmark disk unavailable");
    await expect(controller.set(vaultId, "Third.md", true)).rejects.toThrow(
      "bookmark disk unavailable",
    );
    expect((await controller.get(vaultId)).paths).toEqual(["First.md", "Second.md"]);
  });

  it("remaps an internally moved bookmark without creating duplicates", async () => {
    const store = new MemoryBookmarkStore();
    store.value = createNoteBookmarks(vaultId, ["First.md", "Target.md", "Last.md"]);
    const controller = new NoteBookmarkController(store);

    await expect(controller.remap(vaultId, "First.md", "Moved.md")).resolves.toMatchObject({
      paths: ["Moved.md", "Target.md", "Last.md"],
    });
    await expect(controller.remap(vaultId, "Moved.md", "Target.md")).resolves.toMatchObject({
      paths: ["Target.md", "Last.md"],
    });
    expect(store.saved).toHaveLength(2);
  });
});
