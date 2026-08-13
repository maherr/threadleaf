import { hasHiddenVaultSegment, normalizeVaultPath } from "../kernel/path-policy";

export const maximumNoteBookmarks = 2_048;

export interface PersistedNoteBookmarks {
  version: 1;
  vaultId: string;
  paths: string[];
}

export interface NoteBookmarkStore {
  load(vaultId: string): Promise<PersistedNoteBookmarks | null>;
  save(bookmarks: PersistedNoteBookmarks): Promise<PersistedNoteBookmarks>;
}

const vaultIdPattern = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBookmarkPath(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Bookmark paths must be strings.");
  }
  const normalized = normalizeVaultPath(value);
  if (!normalized.toLocaleLowerCase("en-US").endsWith(".md")) {
    throw new Error(`Bookmarks can contain only Markdown notes: ${normalized}`);
  }
  if (hasHiddenVaultSegment(normalized)) {
    throw new Error(`Bookmarks cannot point inside hidden vault paths: ${normalized}`);
  }
  return normalized;
}

export function parseNoteBookmarks(
  value: unknown,
  expectedVaultId: string,
): PersistedNoteBookmarks {
  if (!vaultIdPattern.test(expectedVaultId)) {
    throw new Error("Bookmarks require a lowercase SHA-256 vault identity.");
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.vaultId !== expectedVaultId ||
    !Array.isArray(value.paths)
  ) {
    throw new Error("Bookmarks must contain version 1, their vault identity, and ordered paths.");
  }
  if (value.paths.length > maximumNoteBookmarks) {
    throw new Error(`A vault cannot contain more than ${maximumNoteBookmarks} bookmarks.`);
  }
  const paths = value.paths.map(normalizeBookmarkPath);
  if (new Set(paths).size !== paths.length) {
    throw new Error("Bookmarks cannot contain duplicate note paths.");
  }
  return { version: 1, vaultId: expectedVaultId, paths };
}

export function createNoteBookmarks(
  vaultId: string,
  paths: readonly string[],
): PersistedNoteBookmarks {
  return parseNoteBookmarks({ version: 1, vaultId, paths: [...paths] }, vaultId);
}

export class NoteBookmarkController {
  readonly #store: NoteBookmarkStore;
  readonly #writeTails = new Map<string, Promise<void>>();

  constructor(store: NoteBookmarkStore) {
    this.#store = store;
  }

  async get(vaultId: string): Promise<PersistedNoteBookmarks> {
    const pending = this.#writeTails.get(vaultId);
    if (pending) {
      await pending.catch(() => undefined);
    }
    return this.#load(vaultId);
  }

  set(vaultId: string, filePath: string, bookmarked: boolean): Promise<PersistedNoteBookmarks> {
    const normalizedPath = normalizeBookmarkPath(filePath);
    return this.#mutate(vaultId, async (current) => {
      const present = current.paths.includes(normalizedPath);
      if (present === bookmarked) {
        return current;
      }
      const paths = bookmarked
        ? [...current.paths, normalizedPath]
        : current.paths.filter((candidate) => candidate !== normalizedPath);
      return this.#store.save(createNoteBookmarks(vaultId, paths));
    });
  }

  remap(vaultId: string, fromPath: string, toPath: string): Promise<PersistedNoteBookmarks> {
    const from = normalizeBookmarkPath(fromPath);
    const to = normalizeBookmarkPath(toPath);
    return this.#mutate(vaultId, async (current) => {
      if (from === to || !current.paths.includes(from)) {
        return current;
      }
      const paths = current.paths
        .map((candidate) => (candidate === from ? to : candidate))
        .filter((candidate, index, values) => values.indexOf(candidate) === index);
      return this.#store.save(createNoteBookmarks(vaultId, paths));
    });
  }

  async #load(vaultId: string): Promise<PersistedNoteBookmarks> {
    if (!vaultIdPattern.test(vaultId)) {
      throw new Error("Bookmarks require a lowercase SHA-256 vault identity.");
    }
    return (await this.#store.load(vaultId)) ?? createNoteBookmarks(vaultId, []);
  }

  #mutate(
    vaultId: string,
    mutation: (current: PersistedNoteBookmarks) => Promise<PersistedNoteBookmarks>,
  ): Promise<PersistedNoteBookmarks> {
    const previous = this.#writeTails.get(vaultId) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => mutation(await this.#load(vaultId)));
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.#writeTails.set(vaultId, tail);
    void tail.finally(() => {
      if (this.#writeTails.get(vaultId) === tail) {
        this.#writeTails.delete(vaultId);
      }
    });
    return operation;
  }
}
