import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { deserialize, serialize } from "node:v8";
import { foldSearchText } from "../shared/search-text";
import type { FullTextSearchContentStore, PersistedSearchContent } from "./full-text-search";
import type {
  CachedMetadataIndexDocument,
  MetadataIndex,
  MetadataIndexSnapshot,
} from "./metadata-index";
import type { VaultSnapshot } from "./node-vault-watcher";
import type { VaultChange, WatchedPathState } from "./watch-protocol";

const cacheSchemaVersion = 5;
const cacheFileName = "derived-index-cache-v5.sqlite";
const legacyCacheFileNames = ["derived-index-cache-v4.sqlite"] as const;
const cacheBatchSize = 64;
const runtimeRequire = createRequire(path.join(process.cwd(), "__threadleaf_runtime__.cjs"));
const { DatabaseSync } = runtimeRequire(
  ["node", "sqlite"].join(":"),
) as typeof import("node:sqlite");
type DatabaseSyncInstance = import("node:sqlite").DatabaseSync;

interface CacheMetadataRow {
  schema_version: number;
  vault_id: string;
  document_count: number;
}

interface CacheStateRow {
  path: string;
  identity: string;
  revision: string;
  size: number;
  modified_ns: string;
  changed_ns: string;
}

interface CachePayloadRow {
  path: string;
  payload: Uint8Array;
}

interface CacheContentRow {
  id: number;
  path: string;
  content: string;
}

interface CompactCacheDocument {
  payload: Uint8Array;
  content: string;
  normalizedContent: string;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function cacheDatabasePath(stateRoot: string): string {
  return path.join(stateRoot, cacheFileName);
}

function cacheAbortError(): Error {
  const error = new Error("Derived index cache replacement was cancelled.");
  error.name = "AbortError";
  return error;
}

function throwIfCacheReplacementAborted(signal: AbortSignal): void {
  if (signal.aborted) throw cacheAbortError();
}

function createSchema(database: DatabaseSyncInstance): void {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS cache_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL,
      vault_id TEXT NOT NULL,
      document_count INTEGER NOT NULL,
      committed_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS path_state (
      path TEXT PRIMARY KEY,
      identity TEXT NOT NULL,
      revision TEXT NOT NULL,
      size INTEGER NOT NULL,
      modified_ns TEXT NOT NULL,
      changed_ns TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS documents (
      path TEXT PRIMARY KEY,
      payload BLOB NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS note_content (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL
    ) STRICT;
    CREATE VIRTUAL TABLE IF NOT EXISTS search_content USING fts5(
      normalized_content,
      content = '',
      contentless_delete = 1,
      detail = none,
      tokenize = 'trigram'
    );
    CREATE TABLE IF NOT EXISTS projection (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      payload BLOB NOT NULL
    ) STRICT;
  `);
}

function metadataRow(database: DatabaseSyncInstance): CacheMetadataRow | undefined {
  return database
    .prepare(
      "SELECT schema_version, vault_id, document_count FROM cache_metadata WHERE singleton = 1",
    )
    .get() as CacheMetadataRow | undefined;
}

function assertMetadata(row: CacheMetadataRow | undefined, vaultId: string): CacheMetadataRow {
  if (
    !row ||
    row.schema_version !== cacheSchemaVersion ||
    row.vault_id !== vaultId ||
    !Number.isSafeInteger(row.document_count) ||
    row.document_count < 0
  ) {
    throw new Error("The derived index cache header is incompatible.");
  }
  return row;
}

function watchedState(row: CacheStateRow): WatchedPathState {
  if (
    !row.path ||
    !row.identity ||
    !/^[a-f0-9]{64}$/u.test(row.revision) ||
    !Number.isSafeInteger(row.size) ||
    row.size < 0 ||
    !row.modified_ns ||
    !row.changed_ns
  ) {
    throw new Error("The derived index cache contains an invalid path state.");
  }
  return {
    path: row.path,
    identity: row.identity,
    revision: row.revision,
    size: row.size,
    modifiedNs: row.modified_ns,
    changedNs: row.changed_ns,
  };
}

function payloadDocument(row: CachePayloadRow): CachedMetadataIndexDocument {
  const value = deserialize(row.payload) as CachedMetadataIndexDocument;
  if (
    !value ||
    typeof value !== "object" ||
    value.document?.path !== row.path ||
    value.searchDocument?.path !== row.path
  ) {
    throw new Error("The derived index cache contains an invalid document payload.");
  }
  return value;
}

function compactDocument(cached: CachedMetadataIndexDocument): CompactCacheDocument {
  const { content, normalizedContent, ...searchMetadata } = cached.searchDocument;
  if (content === null || normalizedContent === null) {
    throw new Error(
      `The derived index cache cannot replace missing source for ${cached.document.path}.`,
    );
  }
  return {
    payload: serialize({
      document: cached.document,
      searchDocument: {
        ...searchMetadata,
        content: null,
        normalizedContent: null,
        canonicalContent: null,
      },
    } satisfies CachedMetadataIndexDocument),
    content,
    normalizedContent,
  };
}

function quotedFtsTerm(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

function supportsTrigramLookup(term: string): boolean {
  return [...term].length >= 3;
}

function trigramCandidateQuery(term: string): string {
  const characters = [...term];
  const trigrams = new Set<string>();
  for (let index = 0; index <= characters.length - 3; index += 1) {
    trigrams.add(characters.slice(index, index + 3).join(""));
  }
  return [...trigrams].map(quotedFtsTerm).join(" AND ");
}

class SqliteFullTextSearchStore implements FullTextSearchContentStore {
  readonly #databasePath: string;
  readonly #vaultId: string;

  constructor(databasePath: string, vaultId: string) {
    this.#databasePath = databasePath;
    this.#vaultId = vaultId;
  }

  pathsContaining(terms: readonly string[]): readonly ReadonlySet<string>[] {
    const database = new DatabaseSync(this.#databasePath, { readOnly: true });
    try {
      assertMetadata(metadataRow(database), this.#vaultId);
      const trigram = database.prepare(
        `SELECT note_content.path
           FROM search_content
           JOIN note_content ON note_content.id = search_content.rowid
          WHERE search_content MATCH ?`,
      );
      const result = terms.map(() => new Set<string>());
      const shortTerms = terms
        .map((term, index) => ({ term, index }))
        .filter(({ term }) => !supportsTrigramLookup(term));
      for (const [index, term] of terms.entries()) {
        if (!supportsTrigramLookup(term)) continue;
        const rows = trigram.all(trigramCandidateQuery(term)) as unknown as Array<{ path: string }>;
        result[index] = new Set(rows.map((row) => row.path));
      }
      if (shortTerms.length > 0) {
        const rows = database.prepare("SELECT path, content FROM note_content ORDER BY path");
        for (const row of rows.iterate() as unknown as Iterable<CacheContentRow>) {
          const normalizedContent = foldSearchText(row.content.replaceAll("\r\n", "\n"));
          for (const { term, index } of shortTerms) {
            if (normalizedContent.includes(term)) result[index]?.add(row.path);
          }
        }
      }
      return result;
    } finally {
      database.close();
    }
  }

  load(paths: readonly string[]): ReadonlyMap<string, PersistedSearchContent> {
    const result = new Map<string, PersistedSearchContent>();
    if (paths.length === 0) return result;
    const database = new DatabaseSync(this.#databasePath, { readOnly: true });
    try {
      assertMetadata(metadataRow(database), this.#vaultId);
      const select = database.prepare("SELECT id, path, content FROM note_content WHERE path = ?");
      for (const filePath of paths) {
        const row = select.get(filePath) as CacheContentRow | undefined;
        if (!row) continue;
        result.set(row.path, {
          content: row.content,
          normalizedContent: foldSearchText(row.content.replaceAll("\r\n", "\n")),
        });
      }
      return result;
    } finally {
      database.close();
    }
  }
}

export interface LoadedDerivedIndexCache {
  documentCount: number;
  snapshot: VaultSnapshot;
  projection: () => Promise<MetadataIndexSnapshot | null>;
  searchStore: FullTextSearchContentStore;
  documents: () => AsyncIterable<CachedMetadataIndexDocument>;
}

/**
 * A same-host, replaceable accelerator for metadata and search state.
 *
 * Vault bytes remain authoritative. A warm start first compares these cheap
 * path receipts with the filesystem and refreshes every changed document.
 * Cache failures therefore select a cold rebuild rather than changing vault
 * behavior or making a stale row authoritative.
 */
export class DerivedIndexCache {
  readonly #stateRoot: string;
  readonly #databasePath: string;
  readonly #vaultId: string;
  #tail: Promise<void> = Promise.resolve();
  #replaceAbortController: AbortController | null = null;

  constructor(stateRoot: string, vaultId: string) {
    this.#stateRoot = stateRoot;
    this.#databasePath = cacheDatabasePath(stateRoot);
    this.#vaultId = vaultId;
  }

  async load(): Promise<LoadedDerivedIndexCache | null> {
    try {
      await fs.access(this.#databasePath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }

    const database = new DatabaseSync(this.#databasePath, { readOnly: true });
    try {
      const metadata = assertMetadata(metadataRow(database), this.#vaultId);
      const rows = database
        .prepare(
          "SELECT path, identity, revision, size, modified_ns, changed_ns FROM path_state ORDER BY path",
        )
        .all() as unknown as CacheStateRow[];
      if (rows.length !== metadata.document_count) {
        throw new Error(
          `The derived index cache contains ${rows.length} path states, expected ${metadata.document_count}.`,
        );
      }
      const snapshot: VaultSnapshot = new Map();
      for (const row of rows) {
        const state = watchedState(row);
        if (snapshot.has(state.path)) {
          throw new Error(`The derived index cache repeats a path: ${state.path}`);
        }
        snapshot.set(state.path, state);
      }
      return {
        documentCount: metadata.document_count,
        snapshot,
        projection: () => this.loadProjection(metadata.document_count),
        searchStore: new SqliteFullTextSearchStore(this.#databasePath, this.#vaultId),
        documents: () => this.streamDocuments(metadata.document_count),
      };
    } finally {
      database.close();
    }
  }

  async loadProjection(expectedCount: number): Promise<MetadataIndexSnapshot | null> {
    await yieldToEventLoop();
    const database = new DatabaseSync(this.#databasePath, { readOnly: true });
    try {
      assertMetadata(metadataRow(database), this.#vaultId);
      const row = database.prepare("SELECT payload FROM projection WHERE singleton = 1").get() as
        | { payload: Uint8Array }
        | undefined;
      if (!row) return null;
      const projection = deserialize(row.payload) as MetadataIndexSnapshot;
      if (!Array.isArray(projection.documents) || projection.documents.length !== expectedCount) {
        throw new Error("The derived index cache projection is invalid.");
      }
      return projection;
    } finally {
      database.close();
    }
  }

  async *streamDocuments(
    expectedCount: number,
  ): AsyncGenerator<CachedMetadataIndexDocument, void, void> {
    const database = new DatabaseSync(this.#databasePath, { readOnly: true });
    let loaded = 0;
    let afterPath = "";
    try {
      assertMetadata(metadataRow(database), this.#vaultId);
      const statement = database.prepare(
        "SELECT path, payload FROM documents WHERE path > ? ORDER BY path LIMIT ?",
      );
      for (;;) {
        const rows = statement.all(afterPath, cacheBatchSize) as unknown as CachePayloadRow[];
        if (rows.length === 0) break;
        for (const row of rows) {
          yield payloadDocument(row);
          loaded += 1;
          afterPath = row.path;
        }
        await yieldToEventLoop();
      }
      if (loaded !== expectedCount) {
        throw new Error(
          `The derived index cache yielded ${loaded} documents, expected ${expectedCount}.`,
        );
      }
    } finally {
      database.close();
    }
  }

  replace(
    snapshot: VaultSnapshot,
    documents: Iterable<CachedMetadataIndexDocument>,
    projection: MetadataIndexSnapshot,
  ): Promise<void> {
    this.#replaceAbortController?.abort();
    const controller = new AbortController();
    this.#replaceAbortController = controller;
    return this.enqueue(async () => {
      try {
        throwIfCacheReplacementAborted(controller.signal);
        await fs.mkdir(path.dirname(this.#databasePath), { recursive: true, mode: 0o700 });
        const database = new DatabaseSync(this.#databasePath);
        try {
          createSchema(database);
          const insertState = database.prepare(`
          INSERT INTO path_state (
            path, identity, revision, size, modified_ns, changed_ns
          ) VALUES (?, ?, ?, ?, ?, ?)
        `);
          const insertDocument = database.prepare(
            "INSERT INTO documents (path, payload) VALUES (?, ?)",
          );
          const insertContent = database.prepare(
            "INSERT INTO note_content (path, content) VALUES (?, ?)",
          );
          const insertSearch = database.prepare(
            "INSERT INTO search_content (rowid, normalized_content) VALUES (?, ?)",
          );
          database.exec("BEGIN IMMEDIATE");
          try {
            database.exec("DELETE FROM path_state");
            database.exec("DELETE FROM documents");
            database.exec("DELETE FROM note_content");
            database.exec("DELETE FROM search_content");
            database.exec("DELETE FROM projection");
            let inserted = 0;
            for (const cached of documents) {
              const state = snapshot.get(cached.document.path);
              if (!state || state.revision !== cached.document.revision) {
                throw new Error(
                  `The derived index cache snapshot is stale for ${cached.document.path}.`,
                );
              }
              const compact = compactDocument(cached);
              insertState.run(
                state.path,
                state.identity,
                state.revision,
                state.size,
                state.modifiedNs,
                state.changedNs,
              );
              insertDocument.run(state.path, compact.payload);
              const content = insertContent.run(state.path, compact.content);
              insertSearch.run(content.lastInsertRowid, compact.normalizedContent);
              inserted += 1;
              if (inserted % cacheBatchSize === 0) {
                await yieldToEventLoop();
                throwIfCacheReplacementAborted(controller.signal);
              }
            }
            if (inserted !== snapshot.size) {
              throw new Error(
                `The derived index cache has ${inserted} documents for ${snapshot.size} path states.`,
              );
            }
            throwIfCacheReplacementAborted(controller.signal);
            database
              .prepare(`
              INSERT INTO cache_metadata (
                singleton, schema_version, vault_id, document_count, committed_at
              ) VALUES (1, ?, ?, ?, ?)
              ON CONFLICT(singleton) DO UPDATE SET
                schema_version = excluded.schema_version,
                vault_id = excluded.vault_id,
                document_count = excluded.document_count,
                committed_at = excluded.committed_at
            `)
              .run(cacheSchemaVersion, this.#vaultId, inserted, new Date().toISOString());
            database
              .prepare("INSERT INTO projection (singleton, payload) VALUES (1, ?)")
              .run(serialize(projection));
            database.exec("COMMIT");
          } catch (error) {
            database.exec("ROLLBACK");
            throw error;
          }
        } finally {
          database.close();
        }
        await fs.chmod(this.#databasePath, 0o600);
        await this.removeLegacyCaches();
      } finally {
        if (this.#replaceAbortController === controller) this.#replaceAbortController = null;
      }
    });
  }

  applyChanges(
    changes: readonly VaultChange[],
    index: MetadataIndex,
    projection: MetadataIndexSnapshot | null = null,
  ): Promise<void> {
    if (changes.length === 0) return Promise.resolve();
    const payloads = new Map<string, CompactCacheDocument>();
    for (const change of changes) {
      if (change.kind === "delete") continue;
      const cached = index.cachedDocument(change.state.path);
      if (!cached || cached.document.revision !== change.state.revision) {
        return Promise.reject(
          new Error(`The derived index cache update is stale for ${change.state.path}.`),
        );
      }
      payloads.set(change.state.path, compactDocument(cached));
    }
    const serializedProjection = projection ? serialize(projection) : null;
    return this.enqueue(async () => {
      const database = new DatabaseSync(this.#databasePath);
      try {
        createSchema(database);
        assertMetadata(metadataRow(database), this.#vaultId);
        const removeState = database.prepare("DELETE FROM path_state WHERE path = ?");
        const removeDocument = database.prepare("DELETE FROM documents WHERE path = ?");
        const selectContentId = database.prepare("SELECT id FROM note_content WHERE path = ?");
        const removeContent = database.prepare("DELETE FROM note_content WHERE path = ?");
        const removeSearch = database.prepare("DELETE FROM search_content WHERE rowid = ?");
        const upsertState = database.prepare(`
          INSERT INTO path_state (
            path, identity, revision, size, modified_ns, changed_ns
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(path) DO UPDATE SET
            identity = excluded.identity,
            revision = excluded.revision,
            size = excluded.size,
            modified_ns = excluded.modified_ns,
            changed_ns = excluded.changed_ns
        `);
        const upsertDocument = database.prepare(`
          INSERT INTO documents (path, payload) VALUES (?, ?)
          ON CONFLICT(path) DO UPDATE SET payload = excluded.payload
        `);
        const insertContent = database.prepare(
          "INSERT INTO note_content (path, content) VALUES (?, ?)",
        );
        const insertSearch = database.prepare(
          "INSERT INTO search_content (rowid, normalized_content) VALUES (?, ?)",
        );
        const removePath = (filePath: string) => {
          const row = selectContentId.get(filePath) as { id: number } | undefined;
          if (row) removeSearch.run(row.id);
          removeContent.run(filePath);
        };
        database.exec("BEGIN IMMEDIATE");
        try {
          for (const change of changes) {
            if (change.kind === "delete") {
              removeState.run(change.path);
              removeDocument.run(change.path);
              removePath(change.path);
              continue;
            }
            if (change.kind === "move") {
              removeState.run(change.from);
              removeDocument.run(change.from);
              removePath(change.from);
            }
            const state = change.state;
            const compact = payloads.get(state.path);
            if (!compact)
              throw new Error(`The derived index cache update is missing ${state.path}.`);
            removePath(state.path);
            upsertState.run(
              state.path,
              state.identity,
              state.revision,
              state.size,
              state.modifiedNs,
              state.changedNs,
            );
            upsertDocument.run(state.path, compact.payload);
            const content = insertContent.run(state.path, compact.content);
            insertSearch.run(content.lastInsertRowid, compact.normalizedContent);
          }
          const count = database.prepare("SELECT count(*) AS count FROM path_state").get() as {
            count: number;
          };
          database
            .prepare(
              "UPDATE cache_metadata SET document_count = ?, committed_at = ? WHERE singleton = 1",
            )
            .run(count.count, new Date().toISOString());
          database.exec("DELETE FROM projection");
          if (serializedProjection) {
            database
              .prepare("INSERT INTO projection (singleton, payload) VALUES (1, ?)")
              .run(serializedProjection);
          }
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      } finally {
        database.close();
      }
    });
  }

  async invalidate(): Promise<void> {
    this.cancelPendingReplace();
    await this.#tail.catch(() => undefined);
    await fs.rm(this.#databasePath, { force: true });
    await fs.rm(`${this.#databasePath}-wal`, { force: true });
    await fs.rm(`${this.#databasePath}-shm`, { force: true });
  }

  async flush(): Promise<void> {
    await this.#tail;
  }

  cancelPendingReplace(): void {
    this.#replaceAbortController?.abort();
  }

  private async removeLegacyCaches(): Promise<void> {
    await Promise.all(
      legacyCacheFileNames.flatMap((fileName) => {
        const databasePath = path.join(this.#stateRoot, fileName);
        return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].map((target) =>
          fs.rm(target, { force: true }),
        );
      }),
    );
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.catch(() => undefined);
    return result;
  }
}
