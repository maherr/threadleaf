import { describe, expect, it } from "vitest";
import { revisionOf } from "./durability";
import { MetadataIndex, VaultIndexReactor } from "./metadata-index";
import type { VaultReadPort, VaultTextSnapshot } from "./ports";
import type { VaultChange, VaultChangeBatch, WatchedPathState } from "./watch-protocol";

class MemoryVault implements VaultReadPort {
  readonly #files = new Map<string, string>();
  failNextRead = false;
  readonly readPaths: string[] = [];

  getName(): string {
    return "fixture";
  }

  set(filePath: string, content: string): void {
    this.#files.set(filePath, content);
  }

  remove(filePath: string): void {
    this.#files.delete(filePath);
  }

  move(from: string, to: string): void {
    const content = this.#files.get(from);
    if (content === undefined) {
      throw new Error(`Missing fixture file: ${from}`);
    }
    this.#files.delete(from);
    this.#files.set(to, content);
  }

  async listMarkdownPaths(relativeDirectory = ""): Promise<string[]> {
    const prefix = relativeDirectory ? `${relativeDirectory.replace(/\/+$/, "")}/` : "";
    return [...this.#files.keys()]
      .filter((filePath) => filePath.toLowerCase().endsWith(".md"))
      .filter((filePath) => !prefix || filePath.startsWith(prefix))
      .sort();
  }

  async readText(relativePath: string): Promise<VaultTextSnapshot> {
    this.readPaths.push(relativePath);
    if (this.failNextRead) {
      this.failNextRead = false;
      throw new Error("simulated read race");
    }
    const content = this.#files.get(relativePath);
    if (content === undefined) {
      throw new Error(`Missing fixture file: ${relativePath}`);
    }
    const bytes = Buffer.from(content);
    return {
      path: relativePath,
      content,
      revision: revisionOf(bytes),
      size: bytes.length,
    };
  }

  state(filePath: string, identity = filePath): WatchedPathState {
    const content = this.#files.get(filePath);
    if (content === undefined) {
      throw new Error(`Missing fixture file: ${filePath}`);
    }
    const bytes = Buffer.from(content);
    return {
      path: filePath,
      identity,
      revision: revisionOf(bytes),
      size: bytes.length,
      modifiedNs: "100",
      changedNs: "100",
    };
  }
}

function batch(
  sequence: number,
  changes: VaultChange[],
  options: Partial<Pick<VaultChangeBatch, "streamId" | "rescan">> = {},
): VaultChangeBatch {
  return {
    streamId: options.streamId ?? "stream-a",
    sequence,
    observedAt: "2026-01-01T00:00:00.000Z",
    changes,
    ...(options.rescan ? { rescan: options.rescan } : {}),
  };
}

async function expectEquivalent(reactor: VaultIndexReactor, vault: MemoryVault): Promise<void> {
  const rebuilt = await MetadataIndex.build(vault);
  expect(reactor.index.snapshot()).toEqual(rebuilt.snapshot());
}

describe("MetadataIndex", () => {
  it("reports deterministic async-build progress without timing assertions", async () => {
    const snapshots: VaultTextSnapshot[] = Array.from({ length: 513 }, (_, index) => ({
      path: `${index.toString().padStart(3, "0")}.md`,
      content: `# Note ${index}\n`,
      revision: `${index}`,
      size: 8,
    }));
    const progress: Array<[number, number]> = [];

    await MetadataIndex.fromSnapshotsAsync(snapshots, {
      onProgress: (indexed, total) => progress.push([indexed, total]),
    });

    expect(progress).toEqual([
      [0, 513],
      [512, 513],
      [513, 513],
    ]);
  });

  it("builds the index and reactor from existing text snapshots without rereading the vault", async () => {
    const vault = new MemoryVault();
    vault.set("A.md", "# Alpha\n[[Folder/B]]");
    vault.set("Folder/B.md", "# Beta\nsearchable body");
    const paths = await vault.listMarkdownPaths();
    const snapshots = await Promise.all(paths.map((filePath) => vault.readText(filePath)));
    const expected = (await MetadataIndex.build(vault)).snapshot();
    vault.readPaths.length = 0;

    const index = MetadataIndex.fromSnapshots(snapshots);
    const reactor = VaultIndexReactor.fromSnapshots(vault, snapshots);

    expect(index.snapshot()).toEqual(expected);
    expect(reactor.index.snapshot()).toEqual(expected);
    expect(reactor.index.search("searchable").results[0]?.path).toBe("Folder/B.md");
    expect(vault.readPaths).toEqual([]);
  });

  it("yields to the event loop while building a snapshot-backed index", async () => {
    const snapshots = Array.from({ length: 64 }, (_, index): VaultTextSnapshot => {
      const content = `# Note ${index}\nsearchable body`;
      const bytes = Buffer.from(content);
      return {
        path: `Note ${String(index).padStart(2, "0")}.md`,
        content,
        revision: revisionOf(bytes),
        size: bytes.length,
      };
    });
    let eventLoopAdvanced = false;
    setImmediate(() => {
      eventLoopAdvanced = true;
    });

    const index = await MetadataIndex.fromSnapshotsAsync(snapshots);

    expect(eventLoopAdvanced).toBe(true);
    expect(index.snapshot().documents).toHaveLength(64);
    expect(index.search("searchable").total).toBe(64);
  });

  it("reuses an immutable-generation snapshot and invalidates it after an index change", async () => {
    const vault = new MemoryVault();
    vault.set("A.md", "before");
    const index = await MetadataIndex.build(vault);

    const first = index.snapshot();
    expect(index.snapshot()).toBe(first);

    vault.set("A.md", "after");
    await index.refresh(vault, "A.md");
    expect(index.snapshot()).not.toBe(first);
  });

  it("indexes properties, tags, headings, links, backlinks, ambiguity, and unresolved targets", async () => {
    const vault = new MemoryVault();
    vault.set(
      "Home.md",
      [
        "---",
        "status: active",
        "tags:",
        "  - project",
        "  - '#open'",
        "---",
        "# Home",
        "work #inline #inline",
        "`#inline-code` <!-- #comment -->",
        "[[Folder/Target#Section|Target alias]]",
        "![[Missing]]",
        "[[Duplicate]]",
        "[[#Home]]",
        "[Target markdown](Folder/Target.md)",
        "```md",
        "[[Ignored]] #ignored",
        "```",
      ].join("\n"),
    );
    vault.set("Folder/Target.md", "# Section\n#target-tag");
    vault.set("One/Duplicate.md", "one");
    vault.set("Two/Duplicate.md", "two");

    const snapshot = (await MetadataIndex.build(vault)).snapshot();
    const home = snapshot.documents.find((document) => document.path === "Home.md");

    expect(home).toMatchObject({
      headings: [{ level: 1, text: "Home", line: 7 }],
      tags: ["inline", "open", "project"],
      tagCounts: { inline: 2, open: 1, project: 1 },
      properties: { status: "active", tags: ["project", "#open"] },
    });
    expect(home?.links).toMatchObject([
      {
        target: "Folder/Target",
        subpath: "#Section",
        alias: "Target alias",
        resolution: { status: "resolved", path: "Folder/Target.md" },
      },
      { target: "Missing", embed: true, resolution: { status: "unresolved" } },
      {
        target: "Duplicate",
        resolution: {
          status: "ambiguous",
          candidates: ["One/Duplicate.md", "Two/Duplicate.md"],
        },
      },
      { target: "", subpath: "#Home", resolution: { status: "resolved", path: "Home.md" } },
      {
        target: "Folder/Target.md",
        syntax: "markdown",
        resolution: { status: "resolved", path: "Folder/Target.md" },
      },
    ]);
    expect(snapshot.backlinks).toContainEqual({
      path: "Folder/Target.md",
      sources: ["Home.md"],
    });
    expect(snapshot.duplicateNames).toEqual([
      { name: "duplicate", paths: ["One/Duplicate.md", "Two/Duplicate.md"] },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("Ignored");
  });

  it("indexes frontmatter forms, duplicate occurrences, casing, and nested parent counts", async () => {
    const vault = new MemoryVault();
    vault.set(
      "A.md",
      [
        "---",
        "tags: Project/Alpha, TEAM",
        "---",
        "#project/Alpha #PROJECT #2026",
        "[#hidden](Target.md) `#code`",
      ].join("\n"),
    );
    vault.set("B.md", "---\ntags: [project/Beta, personal]\n---\n#body");
    vault.set("C.md", "---\ntags:\n  - project/Alpha\n  - y2026\n---");

    const snapshot = (await MetadataIndex.build(vault)).snapshot();
    const first = snapshot.documents.find(({ path }) => path === "A.md");
    expect(first).toMatchObject({
      tags: ["PROJECT", "Project/Alpha", "TEAM"],
      tagCounts: { "Project/Alpha": 2, PROJECT: 1, TEAM: 1 },
    });
    expect(snapshot.tags).toEqual([
      { key: "body", tag: "body", parentKey: null, directCount: 1, count: 1 },
      { key: "personal", tag: "personal", parentKey: null, directCount: 1, count: 1 },
      { key: "project", tag: "Project", parentKey: null, directCount: 1, count: 5 },
      {
        key: "project/alpha",
        tag: "Project/Alpha",
        parentKey: "project",
        directCount: 3,
        count: 3,
      },
      {
        key: "project/beta",
        tag: "project/Beta",
        parentKey: "project",
        directCount: 1,
        count: 1,
      },
      { key: "team", tag: "TEAM", parentKey: null, directCount: 1, count: 1 },
      { key: "y2026", tag: "y2026", parentKey: null, directCount: 1, count: 1 },
    ]);
    expect(snapshot.tags.some(({ key }) => key === "2026")).toBe(false);
  });

  it("accepts case-insensitive Tags and singular tag frontmatter keys", async () => {
    const vault = new MemoryVault();
    vault.set("Upper.md", "---\nTags: [alpha]\n---\nbody");
    vault.set("Singular.md", "---\ntag: beta\n---\nbody");
    vault.set("Both.md", "---\nTag: loser\ntags: [winner]\n---\nbody");

    const snapshot = (await MetadataIndex.build(vault)).snapshot();
    const byPath = (path: string) => snapshot.documents.find((doc) => doc.path === path);
    expect(byPath("Upper.md")?.tags).toEqual(["alpha"]);
    expect(byPath("Singular.md")?.tags).toEqual(["beta"]);
    expect(byPath("Both.md")?.tags).toEqual(["winner"]);
  });

  it("resolves a same-folder note before a duplicate basename elsewhere", async () => {
    const vault = new MemoryVault();
    vault.set("Folder/Source.md", "[[Target]]");
    vault.set("Folder/Target.md", "near");
    vault.set("Elsewhere/Target.md", "far");

    const snapshot = (await MetadataIndex.build(vault)).snapshot();
    const source = snapshot.documents.find((document) => document.path === "Folder/Source.md");

    expect(source?.links[0]?.resolution).toEqual({
      status: "resolved",
      path: "Folder/Target.md",
    });
  });

  it("honors a root-qualified link instead of preferring the source folder", async () => {
    const vault = new MemoryVault();
    vault.set("Folder/Source.md", "[[/Target]]");
    vault.set("Folder/Target.md", "near");
    vault.set("Target.md", "root");

    const snapshot = (await MetadataIndex.build(vault)).snapshot();
    const source = snapshot.documents.find((document) => document.path === "Folder/Source.md");

    expect(source?.links[0]?.resolution).toEqual({ status: "resolved", path: "Target.md" });
  });
});

describe("VaultIndexReactor", () => {
  it("updates the hierarchical tag catalog through edit, create, move, delete, and rebuild", async () => {
    const vault = new MemoryVault();
    vault.set("A.md", "#Home/Child");
    vault.set("B.md", "#home");
    const reactor = await VaultIndexReactor.open(vault);
    const counts = (): Record<string, number> =>
      Object.fromEntries(reactor.index.snapshot().tags.map(({ key, count }) => [key, count]));

    expect(counts()).toEqual({ home: 2, "home/child": 1 });

    vault.set("A.md", "#Other");
    await reactor.accept(batch(1, [{ kind: "upsert", state: vault.state("A.md") }]));
    expect(counts()).toEqual({ home: 1, other: 1 });

    vault.set("C.md", "#HOME/Child #home/child");
    await reactor.accept(batch(2, [{ kind: "upsert", state: vault.state("C.md") }]));
    expect(counts()).toEqual({ home: 3, "home/child": 2, other: 1 });

    vault.move("C.md", "Moved.md");
    await reactor.accept(
      batch(3, [
        {
          kind: "move",
          from: "C.md",
          to: "Moved.md",
          state: vault.state("Moved.md", "c-inode"),
        },
      ]),
    );
    expect(counts()).toEqual({ home: 3, "home/child": 2, other: 1 });

    vault.remove("B.md");
    await reactor.accept(batch(4, [{ kind: "delete", path: "B.md" }]));
    expect(counts()).toEqual({ home: 2, "home/child": 2, other: 1 });

    vault.set("External.md", "#external/child");
    await reactor.accept(batch(6, []));
    expect(counts()).toEqual({
      external: 1,
      "external/child": 1,
      home: 2,
      "home/child": 2,
      other: 1,
    });
    await expectEquivalent(reactor, vault);
  });

  it("keeps full-text results aligned across edits, moves, deletes, and rebuilds", async () => {
    const vault = new MemoryVault();
    vault.set("A.md", "alpha before");
    vault.set("Folder/B.md", "beta body");
    const reactor = await VaultIndexReactor.open(vault);

    expect(reactor.index.search("alpha").results[0]?.path).toBe("A.md");
    vault.set("A.md", "gamma after");
    await reactor.accept(batch(1, [{ kind: "upsert", state: vault.state("A.md") }]));
    expect(reactor.index.search("alpha").total).toBe(0);
    expect(reactor.index.search("gamma").results[0]?.path).toBe("A.md");

    vault.move("Folder/B.md", "Renamed.md");
    await reactor.accept(
      batch(2, [
        {
          kind: "move",
          from: "Folder/B.md",
          to: "Renamed.md",
          state: vault.state("Renamed.md", "b-inode"),
        },
      ]),
    );
    expect(reactor.index.search("folder").total).toBe(0);
    expect(reactor.index.search("renamed").results[0]?.path).toBe("Renamed.md");

    vault.remove("A.md");
    await reactor.accept(batch(3, [{ kind: "delete", path: "A.md" }]));
    expect(reactor.index.search("gamma").total).toBe(0);

    vault.set("Unannounced.md", "delta rebuild");
    await reactor.accept(batch(5, []));
    const rebuilt = await MetadataIndex.build(vault);
    const { generation: incrementalGeneration, ...incremental } = reactor.index.search("delta");
    const { generation: rebuiltGeneration, ...clean } = rebuilt.search("delta");
    expect(incrementalGeneration).toBeGreaterThan(rebuiltGeneration);
    expect(incremental).toEqual(clean);
  });

  it("keeps every incremental state byte-equivalent to a clean rebuild", async () => {
    const vault = new MemoryVault();
    vault.set("A.md", "[[B]] [[Missing]]");
    vault.set("B.md", "# B");
    vault.set("One/Duplicate.md", "one");
    const reactor = await VaultIndexReactor.open(vault);

    vault.set("Missing.md", "now resolved");
    await expect(
      reactor.accept(batch(1, [{ kind: "upsert", state: vault.state("Missing.md") }])),
    ).resolves.toEqual({ mode: "incremental" });
    await expectEquivalent(reactor, vault);

    vault.set("B.md", "# B changed\n#tagged");
    await reactor.accept(batch(2, [{ kind: "upsert", state: vault.state("B.md") }]));
    await expectEquivalent(reactor, vault);

    vault.move("B.md", "Renamed.md");
    await reactor.accept(
      batch(3, [
        {
          kind: "move",
          from: "B.md",
          to: "Renamed.md",
          state: vault.state("Renamed.md", "b-inode"),
        },
      ]),
    );
    await expectEquivalent(reactor, vault);

    vault.remove("Missing.md");
    await reactor.accept(batch(4, [{ kind: "delete", path: "Missing.md" }]));
    await expectEquivalent(reactor, vault);

    vault.set("Two/Duplicate.md", "two");
    await reactor.accept(batch(5, [{ kind: "upsert", state: vault.state("Two/Duplicate.md") }]));
    await expectEquivalent(reactor, vault);
  });

  it("rebuilds from current bytes on a sequence gap, stream restart, rescan, or read race", async () => {
    const vault = new MemoryVault();
    vault.set("A.md", "one");
    const reactor = await VaultIndexReactor.open(vault);

    vault.set("A.md", "two");
    vault.set("Unannounced.md", "also current");
    await expect(
      reactor.accept(batch(2, [{ kind: "upsert", state: vault.state("A.md") }])),
    ).resolves.toEqual({ mode: "rebuild", reason: "sequence-gap" });
    await expectEquivalent(reactor, vault);

    vault.set("Restarted.md", "new stream");
    await expect(
      reactor.accept(
        batch(1, [], {
          streamId: "stream-b",
        }),
      ),
    ).resolves.toEqual({ mode: "rebuild", reason: "stream-restarted" });
    await expectEquivalent(reactor, vault);

    vault.set("Rescanned.md", "overflow recovery");
    await expect(
      reactor.accept(
        batch(2, [], {
          streamId: "stream-b",
          rescan: { scope: "vault", reason: "overflow" },
        }),
      ),
    ).resolves.toEqual({ mode: "rebuild", reason: "overflow" });
    await expectEquivalent(reactor, vault);

    vault.set("Race.md", "eventual read");
    vault.failNextRead = true;
    await expect(
      reactor.accept(
        batch(3, [{ kind: "upsert", state: vault.state("Race.md") }], {
          streamId: "stream-b",
        }),
      ),
    ).resolves.toEqual({ mode: "rebuild", reason: "read-race" });
    await expectEquivalent(reactor, vault);
  });

  it("rebuilds only the requested subtree when the watcher scopes the invalidation", async () => {
    const vault = new MemoryVault();
    vault.set("Folder/A.md", "old");
    vault.set("Outside.md", "untouched");
    const reactor = await VaultIndexReactor.open(vault);
    vault.readPaths.length = 0;

    vault.set("Folder/A.md", "new");
    vault.set("Folder/B.md", "added");
    await expect(
      reactor.accept(
        batch(1, [], {
          rescan: { scope: "subtree", reason: "backend-error", path: "Folder" },
        }),
      ),
    ).resolves.toEqual({ mode: "rebuild", reason: "backend-error" });

    expect(vault.readPaths.sort()).toEqual(["Folder/A.md", "Folder/B.md"]);
    await expectEquivalent(reactor, vault);
  });
});
