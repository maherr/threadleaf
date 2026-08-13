import path from "node:path";
import {
  type NoteBookmarkStore,
  type PersistedNoteBookmarks,
  parseNoteBookmarks,
} from "../application/note-bookmarks";
import { atomicWriteFile, readStableFile } from "../kernel/durability";

const decoder = new TextDecoder("utf-8", { fatal: true });
const vaultIdPattern = /^[a-f0-9]{64}$/;

export class FileNoteBookmarkStore implements NoteBookmarkStore {
  readonly #directoryPath: string;

  constructor(directoryPath: string) {
    this.#directoryPath = path.resolve(directoryPath);
  }

  async load(vaultId: string): Promise<PersistedNoteBookmarks | null> {
    const snapshot = await readStableFile(this.filePath(vaultId));
    return snapshot
      ? parseNoteBookmarks(JSON.parse(decoder.decode(snapshot.bytes)), vaultId)
      : null;
  }

  async save(bookmarks: PersistedNoteBookmarks): Promise<PersistedNoteBookmarks> {
    const normalized = parseNoteBookmarks(bookmarks, bookmarks.vaultId);
    await atomicWriteFile(
      this.filePath(normalized.vaultId),
      Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`, "utf8"),
    );
    return normalized;
  }

  private filePath(vaultId: string): string {
    if (!vaultIdPattern.test(vaultId)) {
      throw new Error("Bookmark filenames require a lowercase SHA-256 vault identity.");
    }
    return path.join(this.#directoryPath, `${vaultId}.json`);
  }
}
