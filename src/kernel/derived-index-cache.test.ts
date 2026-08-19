import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DerivedIndexCache } from "./derived-index-cache";
import type { FullTextSearchOptions } from "./full-text-search";
import { MetadataIndex } from "./metadata-index";
import type { VaultSnapshot } from "./node-vault-watcher";
import type { VaultTextSnapshot } from "./ports";

const temporaryRoots: string[] = [];
const runtimeRequire = createRequire(path.join(process.cwd(), "__threadleaf_cache_test__.cjs"));
const { DatabaseSync } = runtimeRequire(
  ["node", "sqlite"].join(":"),
) as typeof import("node:sqlite");

function note(filePath: string, content: string): VaultTextSnapshot {
  return {
    path: filePath,
    content,
    revision: createHash("sha256").update(content).digest("hex"),
    size: Buffer.byteLength(content),
  };
}

function stateFor(document: VaultTextSnapshot, serial: number) {
  return {
    path: document.path,
    identity: `1:${serial}`,
    revision: document.revision,
    size: document.size,
    modifiedNs: String(1_000 + serial),
    changedNs: String(2_000 + serial),
  };
}

function snapshotFor(documents: readonly VaultTextSnapshot[]): VaultSnapshot {
  return new Map(documents.map((document, index) => [document.path, stateFor(document, index)]));
}

async function cacheAt(vaultId = "vault-a"): Promise<{ cache: DerivedIndexCache; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-derived-cache-test-"));
  temporaryRoots.push(root);
  return { cache: new DerivedIndexCache(root, vaultId), root };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("DerivedIndexCache", () => {
  it("round-trips exact metadata and search state", async () => {
    const documents = [
      note("Alpha.md", "---\ntags: [project/cache]\n---\n# Alpha\nLinks [[Beta]].\n"),
      note("Folder/Beta.md", "# Beta\nA singular lighthouse phrase.\n"),
    ];
    const original = MetadataIndex.fromSnapshots(documents);
    const { cache } = await cacheAt();

    await cache.replace(snapshotFor(documents), original.cachedDocuments(), original.snapshot());
    const loaded = await cache.load();
    if (!loaded) throw new Error("Expected the derived cache to load.");
    const restored = await MetadataIndex.fromCachedDocumentsAsync(
      loaded.documents(),
      loaded.documentCount,
      loaded.projection(),
      { contentStore: loaded.searchStore },
    );

    expect(loaded.snapshot).toEqual(snapshotFor(documents));
    expect(restored.snapshot()).toEqual(original.snapshot());
    expect(restored.search("lighthouse")).toEqual(original.search("lighthouse"));
    expect(restored.search("tag:project/cache")).toEqual(original.search("tag:project/cache"));
  });

  it("stores note text once and keeps only position-free trigram postings", async () => {
    const document = note("Note.md", "# Note\nA deliberately repeated lighthouse phrase.\n");
    const original = MetadataIndex.fromSnapshots([document]);
    const { cache, root } = await cacheAt();
    await cache.replace(snapshotFor([document]), original.cachedDocuments(), original.snapshot());

    const database = new DatabaseSync(path.join(root, "derived-index-cache-v5.sqlite"), {
      readOnly: true,
    });
    try {
      const tables = database
        .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as unknown as Array<{ name: string; sql: string }>;
      expect(tables.some((table) => table.name === "search_content_content")).toBe(false);
      const search = tables.find((table) => table.name === "search_content");
      const normalizedSql = search?.sql.replaceAll(/\s+/gu, "") ?? "";
      expect(normalizedSql).toContain("contentless_delete=1");
      expect(normalizedSql).toContain("detail=none");
      expect(database.prepare("SELECT count(*) AS count FROM note_content").get()).toMatchObject({
        count: 1,
      });
    } finally {
      database.close();
    }
  });

  it("applies changed, moved, and deleted rows transactionally", async () => {
    const first = note("First.md", "# First\nold phrase\n");
    const second = note("Second.md", "# Second\nkeep me\n");
    const { cache } = await cacheAt();
    const original = MetadataIndex.fromSnapshots([first, second]);
    await cache.replace(
      snapshotFor([first, second]),
      original.cachedDocuments(),
      original.snapshot(),
    );

    const moved = note("Moved.md", "# First\nnew phrase\n");
    const next = MetadataIndex.fromSnapshots([moved]);
    await cache.applyChanges(
      [
        { kind: "move", from: first.path, to: moved.path, state: stateFor(moved, 4) },
        { kind: "delete", path: second.path },
      ],
      next,
    );

    const loaded = await cache.load();
    if (!loaded) throw new Error("Expected the updated derived cache to load.");
    const restored = await MetadataIndex.fromCachedDocumentsAsync(
      loaded.documents(),
      loaded.documentCount,
      loaded.projection(),
      { contentStore: loaded.searchStore },
    );
    expect([...loaded.snapshot.keys()]).toEqual(["Moved.md"]);
    expect(restored.snapshot()).toEqual(next.snapshot());
    expect(restored.search("new phrase").total).toBe(1);
    expect(restored.search("old phrase").total).toBe(0);
  });

  it("rejects a cache opened for another vault", async () => {
    const document = note("Note.md", "# Note\n");
    const { cache, root } = await cacheAt("vault-a");
    const index = MetadataIndex.fromSnapshots([document]);
    await cache.replace(snapshotFor([document]), index.cachedDocuments(), index.snapshot());

    const wrongVault = new DerivedIndexCache(root, "vault-b");
    await expect(wrongVault.load()).rejects.toThrow("incompatible");
  });

  it("preserves exact cold-search behavior through the disk-backed warm index", async () => {
    const documents = [
      note(
        "Projects/CAFÉ Alpha.md",
        "---\ntags: [project/cache]\nowner: Alice\n---\n# Café Alpha\nA singular lighthouse phrase.\nTiny x marker.\n",
      ),
      note(
        "Projects/Beta.md",
        "# Beta\nLighthouse appears here, but not the complete phrase.\nOwner mention: alice.\n",
      ),
      note("Archive/Gamma.md", "# Gamma\nPunctuation: a+b and quoted words together.\n"),
      note(
        "Unicode/Forms.md",
        "Café decomposed. İstanbul dotted. عَرَبِيّ marked. 👩‍👩‍👧‍👦 family.\nstarts here\nand finishes there\n",
      ),
    ];
    const cold = MetadataIndex.fromSnapshots(documents);
    const { cache } = await cacheAt();
    await cache.replace(snapshotFor(documents), cold.cachedDocuments(), cold.snapshot());
    const loaded = await cache.load();
    if (!loaded) throw new Error("Expected the search cache to load.");
    const warm = await MetadataIndex.fromCachedDocumentsAsync(
      loaded.documents(),
      loaded.documentCount,
      loaded.projection(),
      { contentStore: loaded.searchStore },
    );

    const cases: ReadonlyArray<{ query: string; options?: FullTextSearchOptions }> = [
      { query: "lighthouse" },
      { query: '"singular lighthouse phrase"' },
      { query: "cafe" },
      { query: "CAFÉ", options: { caseSensitive: true } },
      { query: "Alice", options: { caseSensitive: true } },
      { query: "alice", options: { caseSensitive: true } },
      { query: "tag:project/cache" },
      { query: "x" },
      { query: "a+b" },
      { query: '"quoted words"', options: { exactContext: true } },
      { query: "lighthouse", options: { folder: "Projects" } },
      { query: "café" },
      { query: "İstanbul" },
      { query: "عَرَبِيّ" },
      { query: "👩‍👩‍👧‍👦" },
      { query: '"starts here\nand finishes"' },
      { query: "lighthouse phrase owner alice cafe family starts finishes" },
    ];
    for (const testCase of cases) {
      expect(warm.search(testCase.query, 50, testCase.options)).toEqual(
        cold.search(testCase.query, 50, testCase.options),
      );
    }
  });

  it("rolls back an interrupted replacement and preserves the last complete generation", async () => {
    const initial = note("Initial.md", "# Initial\nlast complete generation\n");
    const initialIndex = MetadataIndex.fromSnapshots([initial]);
    const { cache } = await cacheAt();
    await cache.replace(
      snapshotFor([initial]),
      initialIndex.cachedDocuments(),
      initialIndex.snapshot(),
    );

    const replacement = Array.from({ length: 256 }, (_, index) =>
      note(
        `Replacement/${String(index).padStart(3, "0")}.md`,
        `# Replacement ${index}\n${"large replacement payload ".repeat(200)}\n`,
      ),
    );
    const replacementIndex = MetadataIndex.fromSnapshots(replacement);
    const pending = cache.replace(
      snapshotFor(replacement),
      replacementIndex.cachedDocuments(),
      replacementIndex.snapshot(),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    cache.cancelPendingReplace();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    const loaded = await cache.load();
    if (!loaded) throw new Error("Expected the prior cache generation to survive rollback.");
    expect([...loaded.snapshot.keys()]).toEqual(["Initial.md"]);
    const restored = await MetadataIndex.fromCachedDocumentsAsync(
      loaded.documents(),
      loaded.documentCount,
      loaded.projection(),
      { contentStore: loaded.searchStore },
    );
    expect(restored.search("last complete generation")).toEqual(
      initialIndex.search("last complete generation"),
    );
  });
});
