import path from "node:path";
import type { EditorDraftStore, PersistedEditorDraft } from "../application/editor-draft";
import { parseEditorDraft } from "../application/editor-draft";
import {
  atomicWriteFile,
  readStableFile,
  removeIfPresent,
  syncDirectory,
} from "../kernel/durability";

const decoder = new TextDecoder("utf-8", { fatal: true });
const vaultIdPattern = /^[a-f0-9]{64}$/;

export class FileEditorDraftStore implements EditorDraftStore {
  readonly #directoryPath: string;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(directoryPath: string) {
    this.#directoryPath = path.resolve(directoryPath);
  }

  load(vaultId: string): Promise<PersistedEditorDraft | null> {
    return this.#writeTail.catch(() => undefined).then(() => this.loadCurrent(vaultId));
  }

  async save(draft: PersistedEditorDraft): Promise<PersistedEditorDraft> {
    const normalized = parseEditorDraft(draft, draft.vaultId);
    const bytes = Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    const write = this.#writeTail
      .catch(() => undefined)
      .then(() => atomicWriteFile(this.filePath(normalized.vaultId), bytes));
    this.#writeTail = write.then(
      () => undefined,
      () => undefined,
    );
    await write;
    return normalized;
  }

  async clear(vaultId: string, draftId: string): Promise<boolean> {
    if (typeof draftId !== "string" || draftId.length > 128) {
      throw new Error("Editor draft clearing requires a bounded draft identity.");
    }
    let cleared = false;
    const write = this.#writeTail
      .catch(() => undefined)
      .then(async () => {
        const current = await this.loadCurrent(vaultId);
        if (!current || current.draftId !== draftId) {
          return;
        }
        await removeIfPresent(this.filePath(vaultId));
        await syncDirectory(this.#directoryPath);
        cleared = true;
      });
    this.#writeTail = write.then(
      () => undefined,
      () => undefined,
    );
    await write;
    return cleared;
  }

  private async loadCurrent(vaultId: string): Promise<PersistedEditorDraft | null> {
    const snapshot = await readStableFile(this.filePath(vaultId));
    return snapshot ? parseEditorDraft(JSON.parse(decoder.decode(snapshot.bytes)), vaultId) : null;
  }

  private filePath(vaultId: string): string {
    if (!vaultIdPattern.test(vaultId)) {
      throw new Error("Editor draft filenames require a lowercase SHA-256 vault identity.");
    }
    return path.join(this.#directoryPath, `${vaultId}.json`);
  }
}
