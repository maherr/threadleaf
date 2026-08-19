import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceOpenDiagnostics } from "../shared/workspace-open-diagnostics";
import { revisionOf } from "./durability";
import {
  captureVaultBootstrap,
  captureVaultSnapshot,
  diffVaultSnapshots,
  NodeVaultWatcher,
  type VaultSnapshot,
  WorkspacePathActivityLedger,
  workspacePathForFilesystemActivity,
} from "./node-vault-watcher";
import { VaultPathPolicy } from "./path-policy";
import { FixedStateRoot } from "./ports";
import { VaultKernel } from "./vault-kernel";
import {
  type VaultChangeBatch,
  VaultTransientAbsences,
  WatchBatchSequencer,
  type WatchedPathState,
  WatchOperationLedger,
  WatchSequenceGate,
} from "./watch-protocol";

let sandboxPath: string;
let vaultPath: string;

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-watcher-"));
  vaultPath = path.join(sandboxPath, "vault");
  await fs.mkdir(vaultPath);
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

function state(
  filePath: string,
  identity: string,
  revision = revisionOf(Buffer.from(filePath)),
): WatchedPathState {
  return {
    path: filePath,
    identity,
    revision,
    size: 10,
    modifiedNs: "100",
    changedNs: "100",
  };
}

function snapshot(...states: WatchedPathState[]): VaultSnapshot {
  return new Map(states.map((entry) => [entry.path, entry]));
}

describe("workspace path activity", () => {
  it("attributes a Syncthing temporary to its exact eventual workspace path", () => {
    expect(workspacePathForFilesystemActivity(".syncthing.Syncing.md.tmp")).toBe("Syncing.md");
    expect(workspacePathForFilesystemActivity("Boards/.syncthing.Overview.canvas.tmp")).toBe(
      "Boards/Overview.canvas",
    );
    expect(workspacePathForFilesystemActivity("Other.md")).toBe("Other.md");
    expect(workspacePathForFilesystemActivity(".syncthing.image.png.tmp")).toBeNull();
    expect(workspacePathForFilesystemActivity("../Outside.md")).toBeNull();
  });

  it("keeps one path's receipt independent of activity on other paths", () => {
    const activity = new WorkspacePathActivityLedger();
    activity.record(".syncthing.Syncing.md.tmp");
    const syncingVersion = activity.versionForPath("Syncing.md");

    for (let index = 0; index < 5_000; index += 1) {
      activity.record(`Unrelated-${index}.md`);
    }

    expect(syncingVersion).toBeGreaterThan(0);
    expect(activity.versionForPath("Syncing.md")).toBe(syncingVersion);
    expect(activity.versionForPath("Unrelated-4999.md")).toBeGreaterThan(syncingVersion);
  });
});

describe("snapshot diff", () => {
  it("pairs a unique inode move and reports edits, creates, and deletes deterministically", () => {
    const before = snapshot(state("Move.md", "1"), state("Edit.md", "2"), state("Delete.md", "3"));
    const edited = {
      ...state("Edit.md", "2", revisionOf(Buffer.from("edited"))),
      changedNs: "101",
    };
    const after = snapshot(state("Moved.md", "1"), edited, state("Added.md", "4"));

    expect(diffVaultSnapshots(before, after)).toEqual({
      changes: [
        { kind: "upsert", state: state("Added.md", "4") },
        { kind: "delete", path: "Delete.md" },
        { kind: "upsert", state: edited },
        { kind: "move", from: "Move.md", to: "Moved.md", state: state("Moved.md", "1") },
      ],
    });
  });

  it("requests a full rescan instead of guessing an ambiguous rename", () => {
    const before = snapshot(state("A.md", "shared"), state("B.md", "shared"));
    const after = snapshot(state("C.md", "shared"));

    expect(diffVaultSnapshots(before, after)).toEqual({
      changes: [],
      rescan: { scope: "vault", reason: "ambiguous-rename" },
    });
  });

  it("scopes an ambiguous rename to its common subtree", () => {
    const before = snapshot(state("Folder/A.md", "shared"), state("Folder/Nested/B.md", "shared"));
    const after = snapshot(state("Folder/C.md", "shared"));

    expect(diffVaultSnapshots(before, after)).toEqual({
      changes: [],
      rescan: { scope: "subtree", reason: "ambiguous-rename", path: "Folder" },
    });
  });
});

describe("watch protocol", () => {
  it("numbers batches and turns sequence gaps and stream changes into full rescans", () => {
    const first = new WatchBatchSequencer({ streamId: "stream-a" });
    const second = new WatchBatchSequencer({ streamId: "stream-b" });
    const gate = new WatchSequenceGate();

    expect(gate.accept(first.next({ changes: [] }))).toMatchObject({ accepted: true });
    const skipped = first.next({ changes: [] });
    const third = first.next({ changes: [] });
    expect(skipped.sequence).toBe(2);
    expect(gate.accept(third)).toMatchObject({
      accepted: false,
      rescan: { scope: "vault", reason: "sequence-gap" },
    });
    expect(gate.accept(second.next({ changes: [] }))).toMatchObject({
      accepted: false,
      rescan: { scope: "vault", reason: "stream-restarted" },
    });
  });

  it("annotates exact operation results without hiding mismatched external edits", () => {
    const ledger = new WatchOperationLedger();
    const expectedRevision = revisionOf(Buffer.from("threadleaf"));
    ledger.expect({ id: "write-1", kind: "write", path: "Note.md", revision: expectedRevision });

    const external = ledger.annotate([
      { kind: "upsert", state: state("Note.md", "1", revisionOf(Buffer.from("external"))) },
    ]);
    expect(external[0]).not.toHaveProperty("operationId");
    expect(ledger.size).toBe(1);

    const own = ledger.annotate([
      { kind: "upsert", state: state("Note.md", "2", expectedRevision) },
    ]);
    expect(own[0]).toMatchObject({ operationId: "write-1" });
    expect(ledger.size).toBe(0);
  });

  it("acknowledges an exact result observed before the writer registers it", () => {
    const ledger = new WatchOperationLedger();
    const expectedRevision = revisionOf(Buffer.from("late result"));
    const observed = ledger.annotate([
      { kind: "upsert", state: state("Note.md", "fresh-inode", expectedRevision) },
    ]);
    expect(observed[0]).not.toHaveProperty("operationId");

    ledger.expect({
      id: "late-write-1",
      kind: "write",
      path: "Note.md",
      revision: expectedRevision,
    });

    expect(ledger.size).toBe(0);
  });

  it("attributes every exact result of a multi-file operation", () => {
    const ledger = new WatchOperationLedger();
    const firstRevision = revisionOf(Buffer.from("first"));
    const secondRevision = revisionOf(Buffer.from("second"));
    ledger.expect({
      id: "multi-1",
      kind: "multi-write",
      writes: [
        { path: "A.md", revision: firstRevision },
        { path: "B.md", revision: secondRevision },
      ],
    });

    const annotated = ledger.annotate([
      { kind: "upsert", state: state("A.md", "1", firstRevision) },
      { kind: "upsert", state: state("B.md", "2", secondRevision) },
    ]);

    expect(annotated).toMatchObject([{ operationId: "multi-1" }, { operationId: "multi-1" }]);
    expect(ledger.size).toBe(0);
  });

  it("attributes a move and its related rewrites as one compound operation", () => {
    const ledger = new WatchOperationLedger();
    const targetRevision = revisionOf(Buffer.from("target"));
    const linkerRevision = revisionOf(Buffer.from("linker"));
    ledger.expect({
      id: "compound-1",
      kind: "move-with-writes",
      from: "Before.md",
      to: "After.md",
      targetRevision,
      sourceRewritten: false,
      writes: [{ path: "Linker.md", revision: linkerRevision }],
    });

    const annotated = ledger.annotate([
      { kind: "upsert", state: state("Linker.md", "2", linkerRevision) },
      {
        kind: "move",
        from: "Before.md",
        to: "After.md",
        state: state("After.md", "1", targetRevision),
      },
    ]);

    expect(annotated).toMatchObject([{ operationId: "compound-1" }, { operationId: "compound-1" }]);
    expect(ledger.size).toBe(0);
  });

  it("attributes a freshly materialized rename as one move", () => {
    const ledger = new WatchOperationLedger();
    const revision = revisionOf(Buffer.from("materialized"));
    ledger.expect({
      id: "rename-copy-1",
      kind: "rename",
      from: "Before.md",
      to: "After.md",
      revision,
    });

    const annotated = ledger.annotate([
      { kind: "delete", path: "Before.md" },
      { kind: "upsert", state: state("After.md", "fresh-inode", revision) },
    ]);

    expect(annotated).toEqual([
      {
        kind: "move",
        from: "Before.md",
        to: "After.md",
        state: state("After.md", "fresh-inode", revision),
        operationId: "rename-copy-1",
      },
    ]);
    expect(ledger.size).toBe(0);
  });

  it("attributes a rewritten source as a delete plus destination upsert", () => {
    const ledger = new WatchOperationLedger();
    const targetRevision = revisionOf(Buffer.from("rewritten target"));
    const linkerRevision = revisionOf(Buffer.from("linker"));
    ledger.expect({
      id: "compound-2",
      kind: "move-with-writes",
      from: "Before.md",
      to: "After.md",
      targetRevision,
      sourceRewritten: true,
      writes: [{ path: "Linker.md", revision: linkerRevision }],
    });

    const annotated = ledger.annotate([
      { kind: "delete", path: "Before.md" },
      { kind: "upsert", state: state("After.md", "3", targetRevision) },
      { kind: "upsert", state: state("Linker.md", "2", linkerRevision) },
    ]);

    expect(annotated).toMatchObject([
      { operationId: "compound-2" },
      { operationId: "compound-2" },
      { operationId: "compound-2" },
    ]);
    expect(ledger.size).toBe(0);
  });

  it("attributes an exact delete without consuming an unrelated deletion", () => {
    const ledger = new WatchOperationLedger();
    ledger.expect({ id: "delete-1", kind: "delete", path: "Note.md" });

    const unrelated = ledger.annotate([{ kind: "delete", path: "Other.md" }]);
    expect(unrelated[0]).not.toHaveProperty("operationId");
    expect(ledger.size).toBe(1);

    const own = ledger.annotate([{ kind: "delete", path: "Note.md" }]);
    expect(own[0]).toMatchObject({ operationId: "delete-1" });
    expect(ledger.size).toBe(0);
  });
});

describe("NodeVaultWatcher", () => {
  it("partitions bootstrap filesystem and watcher-rescan work without timing assertions", async () => {
    await fs.writeFile(path.join(vaultPath, "Alpha.md"), "alpha", "utf8");
    await fs.writeFile(path.join(vaultPath, "Beta.md"), "beta", "utf8");
    const policy = await VaultPathPolicy.open(vaultPath);
    const diagnostics = new WorkspaceOpenDiagnostics();

    const bootstrap = await captureVaultBootstrap(policy, diagnostics);
    await captureVaultSnapshot(policy, bootstrap.snapshot, "", {
      diagnostics,
      reason: "fixture-rescan",
    });

    const captured = diagnostics.snapshot();
    expect(captured.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "bootstrap.list", count: 1 }),
        expect.objectContaining({ name: "bootstrap.realpath", count: 2 }),
        expect.objectContaining({ name: "bootstrap.stat", count: 4 }),
        expect.objectContaining({ name: "bootstrap.read", count: 2, bytes: 9 }),
        expect.objectContaining({ name: "bootstrap.hash", count: 2, bytes: 9 }),
        expect.objectContaining({
          name: "watcher-rescan.list",
          count: 1,
          attributes: { reason: "fixture-rescan" },
        }),
        expect.objectContaining({ name: "watcher-rescan.realpath", count: 2 }),
        expect.objectContaining({ name: "watcher-rescan.stat", count: 2 }),
      ]),
    );
    expect(captured.spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "bootstrap.filesystem",
          attributes: { documents: 2, paths: 2 },
        }),
        expect.objectContaining({
          name: "watcher-rescan.capture",
          attributes: { paths: 2, reason: "fixture-rescan" },
        }),
      ]),
    );
  });

  it("seeds the index and watcher from one visible Markdown scan", async () => {
    await fs.mkdir(path.join(vaultPath, "Folder"));
    await fs.mkdir(path.join(vaultPath, ".archive"));
    await fs.writeFile(path.join(vaultPath, "Alpha.md"), "alpha", "utf8");
    await fs.writeFile(path.join(vaultPath, "Folder", "Unicode.md"), "cafe\u0301", "utf8");
    await fs.writeFile(path.join(vaultPath, "Folder", "Board.canvas"), "{}", "utf8");
    await fs.writeFile(path.join(vaultPath, ".archive", "Hidden.md"), "hidden", "utf8");
    const policy = await VaultPathPolicy.open(vaultPath);

    const captured = await captureVaultBootstrap(policy);

    expect(captured.documents).toEqual([
      {
        path: "Alpha.md",
        content: "alpha",
        revision: revisionOf(Buffer.from("alpha")),
        size: Buffer.byteLength("alpha"),
      },
      {
        path: "Folder/Unicode.md",
        content: "cafe\u0301",
        revision: revisionOf(Buffer.from("cafe\u0301")),
        size: Buffer.byteLength("cafe\u0301"),
      },
    ]);
    expect([...captured.snapshot.keys()]).toEqual(["Alpha.md", "Folder/Unicode.md"]);
    expect(captured.canvasPaths).toEqual(["Folder/Board.canvas"]);
    for (const document of captured.documents) {
      expect(captured.snapshot.get(document.path)).toMatchObject({
        path: document.path,
        revision: document.revision,
        size: document.size,
      });
    }

    const watcher = NodeVaultWatcher.fromSnapshot(policy, captured.snapshot, {
      streamId: "bootstrap-stream",
    });
    await expect(watcher.scanNow()).resolves.toBeNull();
    await fs.writeFile(path.join(vaultPath, "Alpha.md"), "alpha changed", "utf8");
    await expect(watcher.scanNow()).resolves.toMatchObject({
      streamId: "bootstrap-stream",
      sequence: 1,
      changes: [{ kind: "upsert", state: { path: "Alpha.md" } }],
    });
    await watcher.close();
  });

  it("reports bounded scan progress and catches changes before the watcher becomes current", async () => {
    await fs.writeFile(path.join(vaultPath, "Alpha.md"), "alpha", "utf8");
    const policy = await VaultPathPolicy.open(vaultPath);
    const progress: Array<{ scanned: number; total: number }> = [];
    const captured = await captureVaultBootstrap(policy, undefined, {
      onProgress: (value) => progress.push(value),
    });
    expect(progress).toEqual([
      { scanned: 0, total: 1 },
      { scanned: 1, total: 1 },
    ]);

    await fs.writeFile(path.join(vaultPath, "Beta.md"), "beta", "utf8");
    const watcher = NodeVaultWatcher.fromSnapshot(policy, captured.snapshot, {
      streamId: "startup-catch-up",
    });
    const batches: VaultChangeBatch[] = [];
    const batch = await watcher.startWithInitialScan((value) => {
      batches.push(value);
    });

    expect(batch).toMatchObject({
      streamId: "startup-catch-up",
      sequence: 1,
      changes: [{ kind: "upsert", state: { path: "Beta.md" } }],
    });
    expect(batches).toEqual([batch]);
    await watcher.close();
  });

  it("does not rescan when a watcher buffered no startup activity", async () => {
    await fs.writeFile(path.join(vaultPath, "Alpha.md"), "alpha", "utf8");
    const policy = await VaultPathPolicy.open(vaultPath);
    const watcher = NodeVaultWatcher.fromSnapshot(policy, new Map(), {
      streamId: "buffered-clean-startup",
    });
    watcher.startBuffering();
    const captured = await captureVaultBootstrap(policy);
    watcher.installStartupSnapshot(captured.snapshot);
    const list = vi.spyOn(policy, "listMarkdownPaths");

    await expect(watcher.finishBufferedStart(() => undefined)).resolves.toBeNull();
    expect(list).not.toHaveBeenCalled();
    await watcher.close();
  });

  it("rescans once when startup activity arrived after the buffered baseline", async () => {
    await fs.writeFile(path.join(vaultPath, "Alpha.md"), "alpha", "utf8");
    const policy = await VaultPathPolicy.open(vaultPath);
    const captured = await captureVaultBootstrap(policy);
    const watcher = NodeVaultWatcher.fromSnapshot(policy, new Map(), {
      streamId: "buffered-dirty-startup",
    });
    watcher.startBuffering();
    watcher.installStartupSnapshot(captured.snapshot);
    await fs.writeFile(path.join(vaultPath, "Beta.md"), "beta", "utf8");
    await vi.waitFor(() => expect(watcher.activityVersionForPath("Beta.md")).toBeGreaterThan(0));
    const batches: VaultChangeBatch[] = [];

    const batch = await watcher.finishBufferedStart((value) => {
      batches.push(value);
    });

    expect(batch).toMatchObject({
      streamId: "buffered-dirty-startup",
      sequence: 1,
      changes: [{ kind: "upsert", state: { path: "Beta.md" } }],
    });
    expect(batches).toEqual([batch]);
    await watcher.close();
  });

  it("captures Markdown and conflict files while excluding transaction temporaries and external links", async () => {
    await fs.writeFile(path.join(vaultPath, "Note.md"), "note", "utf8");
    await fs.writeFile(
      path.join(vaultPath, "Note.threadleaf-conflict-fixture.md"),
      "conflict",
      "utf8",
    );
    await fs.writeFile(path.join(vaultPath, ".threadleaf-write-deadbeef.tmp"), "temp", "utf8");
    await fs.mkdir(path.join(vaultPath, ".trash"), { recursive: true });
    await fs.writeFile(path.join(vaultPath, ".trash", "Deleted.md"), "deleted", "utf8");
    const outsidePath = path.join(sandboxPath, "Outside.md");
    await fs.writeFile(outsidePath, "outside", "utf8");
    await fs.symlink(outsidePath, path.join(vaultPath, "Outside-link.md"));
    await fs.symlink("Note.md", path.join(vaultPath, "Inside-link.md"));
    const policy = await VaultPathPolicy.open(vaultPath);

    const captured = await captureVaultSnapshot(policy);

    expect([...captured.keys()].sort()).toEqual([
      "Inside-link.md",
      "Note.md",
      "Note.threadleaf-conflict-fixture.md",
    ]);
  });

  it("produces a sequenced move and attaches the matching Threadleaf operation", async () => {
    const sourcePath = path.join(vaultPath, "Before.md");
    const targetPath = path.join(vaultPath, "After.md");
    const content = "move me";
    await fs.writeFile(sourcePath, content, "utf8");
    const watcher = await NodeVaultWatcher.open(vaultPath, { streamId: "fixture-stream" });
    watcher.operations.expect({
      id: "rename-1",
      kind: "rename",
      from: "Before.md",
      to: "After.md",
      revision: revisionOf(Buffer.from(content)),
    });

    await fs.rename(sourcePath, targetPath);
    const batch = await watcher.scanNow();

    expect(batch).toMatchObject({
      streamId: "fixture-stream",
      sequence: 1,
      changes: [
        {
          kind: "move",
          from: "Before.md",
          to: "After.md",
          operationId: "rename-1",
        },
      ],
    });
    expect(await watcher.scanNow()).toBeNull();
    await watcher.close();
  });

  it("reports a move into private trash as an attributed corpus deletion", async () => {
    const sourcePath = path.join(vaultPath, "Deleted.md");
    const trashPath = path.join(vaultPath, ".trash", "Deleted.md");
    await fs.writeFile(sourcePath, "recoverable", "utf8");
    const watcher = await NodeVaultWatcher.open(vaultPath, { streamId: "trash-stream" });
    watcher.operations.expect({ id: "trash-1", kind: "delete", path: "Deleted.md" });

    await fs.mkdir(path.dirname(trashPath), { recursive: true });
    await fs.rename(sourcePath, trashPath);
    const batch = await watcher.scanNow();

    expect(batch).toMatchObject({
      streamId: "trash-stream",
      sequence: 1,
      changes: [{ kind: "delete", path: "Deleted.md", operationId: "trash-1" }],
    });
    await watcher.close();
  });

  it("emits an explicit sequenced overflow rescan", async () => {
    const watcher = await NodeVaultWatcher.open(vaultPath, { streamId: "fixture-stream" });

    await expect(watcher.reportOverflow()).resolves.toMatchObject({
      streamId: "fixture-stream",
      sequence: 1,
      changes: [],
      rescan: { scope: "vault", reason: "overflow" },
    });
    await watcher.close();
  });

  it("can reconcile one subtree without consuming changes elsewhere", async () => {
    await fs.mkdir(path.join(vaultPath, "Folder"));
    await fs.writeFile(path.join(vaultPath, "Folder", "Inside.md"), "old", "utf8");
    await fs.writeFile(path.join(vaultPath, "Outside.md"), "old", "utf8");
    const watcher = await NodeVaultWatcher.open(vaultPath, { streamId: "subtree-stream" });

    await fs.writeFile(path.join(vaultPath, "Folder", "Inside.md"), "new", "utf8");
    await fs.writeFile(path.join(vaultPath, "Outside.md"), "new", "utf8");
    const subtree = await watcher.scanSubtree("Folder/");

    expect(subtree?.changes).toMatchObject([
      { kind: "upsert", state: { path: "Folder/Inside.md" } },
    ]);
    const remainder = await watcher.scanNow();
    expect(remainder?.changes).toMatchObject([{ kind: "upsert", state: { path: "Outside.md" } }]);
    await watcher.close();
  });

  it("emits an explicit subtree invalidation", async () => {
    const watcher = await NodeVaultWatcher.open(vaultPath, { streamId: "subtree-stream" });

    await expect(watcher.reportSubtreeInvalidated("Folder/")).resolves.toMatchObject({
      sequence: 1,
      rescan: { scope: "subtree", reason: "backend-error", path: "Folder" },
    });
    await watcher.close();
  });

  it("delivers a debounced batch through the live filesystem watcher", async () => {
    const errors: unknown[] = [];
    const watcher = await NodeVaultWatcher.open(vaultPath, {
      debounceMs: 20,
      streamId: "live-stream",
      onError: (error) => errors.push(error),
    });
    const received = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("watcher fixture timed out")), 2_000);
      watcher.start((batch) => {
        clearTimeout(timeout);
        resolve(batch);
      });
    });

    await fs.writeFile(path.join(vaultPath, "Live.md"), "live", "utf8");

    await expect(received).resolves.toMatchObject({
      streamId: "live-stream",
      sequence: 1,
      changes: [{ kind: "upsert", state: { path: "Live.md" } }],
    });
    expect(errors).toEqual([]);
    await watcher.close();
  });

  it("publishes non-Markdown filesystem activity without indexing binary bytes", async () => {
    const watcher = await NodeVaultWatcher.open(vaultPath, {
      debounceMs: 20,
      streamId: "asset-stream",
    });
    const received = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("asset watcher fixture timed out")), 2_000);
      watcher.start((batch) => {
        clearTimeout(timeout);
        resolve(batch);
      });
    });

    await fs.writeFile(path.join(vaultPath, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    await expect(received).resolves.toMatchObject({
      streamId: "asset-stream",
      sequence: 1,
      changes: [],
    });
    await watcher.close();
  });

  it("does not queue shutdown behind a listener that is still handling a batch", async () => {
    const watcher = await NodeVaultWatcher.open(vaultPath, {
      debounceMs: 20,
      streamId: "shutdown-stream",
    });
    let releaseListener: (() => void) | undefined;
    const listenerReleased = new Promise<void>((resolve) => {
      releaseListener = resolve;
    });
    let markListenerStarted: (() => void) | undefined;
    const listenerStarted = new Promise<void>((resolve) => {
      markListenerStarted = resolve;
    });
    watcher.start(async () => {
      markListenerStarted?.();
      await listenerReleased;
    });
    await fs.writeFile(path.join(vaultPath, "Closing.md"), "closing", "utf8");
    await listenerStarted;

    await expect(watcher.close()).resolves.toBeUndefined();
    releaseListener?.();
    expect(() => watcher.start(() => undefined)).toThrow("Vault watcher is closed");
  });
});

describe("transient absence attribution", () => {
  it("marks a deletion observed inside a write's move-aside window", async () => {
    const statePath = path.join(sandboxPath, "state");
    await fs.writeFile(path.join(vaultPath, "Note.md"), "before\n", "utf8");
    const observed: VaultChangeBatch[] = [];
    let insideWindow = false;
    const kernel = await VaultKernel.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
      faultInjector: async (point) => {
        if (point !== "write:after-move-aside" || insideWindow) {
          return;
        }
        insideWindow = true;
        const batch = await watcher.scanNow();
        if (batch) {
          observed.push(batch);
        }
      },
    });
    const watcher = await NodeVaultWatcher.open(vaultPath, {
      streamId: "transient-stream",
      transientAbsences: kernel.transientAbsences,
    });
    const before = await kernel.readText("Note.md");

    const written = await kernel.writeText("Note.md", "after\n", before.revision);
    expect(written).toMatchObject({ status: "committed" });
    expect(insideWindow).toBe(true);
    // Without this the deletion is indistinguishable from a removal, and the
    // guards that refuse to read one as an expected removal or as half of a
    // materialized move have nothing to key on.
    expect(observed.at(0)?.changes).toEqual([
      { kind: "delete", path: "Note.md", transientOperationId: expect.any(String) },
    ]);
    expect(kernel.transientAbsences.operationFor("Note.md")).toBeUndefined();
    await watcher.close();
  });

  it("leaves an ordinary deletion unmarked", async () => {
    const statePath = path.join(sandboxPath, "state");
    await fs.writeFile(path.join(vaultPath, "Note.md"), "before\n", "utf8");
    const kernel = await VaultKernel.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
    });
    const watcher = await NodeVaultWatcher.open(vaultPath, {
      streamId: "ordinary-stream",
      transientAbsences: kernel.transientAbsences,
    });

    await fs.unlink(path.join(vaultPath, "Note.md"));
    const batch = await watcher.scanNow();
    expect(batch?.changes).toEqual([{ kind: "delete", path: "Note.md" }]);
    await watcher.close();
  });
});

describe("transient absence attribution timing", () => {
  function heldAbsence(filePath: string, operationId: string) {
    const absences = new VaultTransientAbsences();
    const since = absences.mark();
    const handle = absences.reserve(filePath);
    handle.hold(operationId);
    return { absences, since, handle };
  }

  it("attributes a deletion to a claim the write already released", () => {
    const { absences, since, handle } = heldAbsence("Note.md", "write-1");
    // The scan listed the directory while the file was aside, and the write
    // finished before the diff reached the ledger. That is the ordinary case on
    // any vault large enough for the walk to outlast the transaction.
    handle.release();
    const ledger = new WatchOperationLedger({ transientAbsences: absences });

    expect(ledger.annotate([{ kind: "delete", path: "Note.md" }], since)).toEqual([
      { kind: "delete", path: "Note.md", transientOperationId: "write-1" },
    ]);
  });

  it("does not attribute a claim released before the scan began", () => {
    const { absences, handle } = heldAbsence("Note.md", "write-1");
    handle.release();
    const ledger = new WatchOperationLedger({ transientAbsences: absences });
    const since = absences.mark();

    expect(ledger.annotate([{ kind: "delete", path: "Note.md" }], since)).toEqual([
      { kind: "delete", path: "Note.md" },
    ]);
  });

  it("refuses to fold a transient deletion into a materialized move", () => {
    const { absences, since } = heldAbsence("A.md", "write-1");
    const ledger = new WatchOperationLedger({ transientAbsences: absences });
    ledger.expect({ id: "rename-1", kind: "rename", from: "A.md", to: "B.md", revision: "rev-b" });

    const annotated = ledger.annotate(
      [
        { kind: "delete", path: "A.md" },
        { kind: "upsert", state: state("B.md", "9", "rev-b") },
      ],
      since,
    );

    // Folding these into a move would drive the workspace to rename the tab of a
    // file that is merely being rewritten.
    expect(annotated.map((change) => change.kind)).toEqual(["delete", "upsert"]);
    expect(annotated[0]).toMatchObject({ transientOperationId: "write-1" });
  });

  it("refuses to settle an expected removal with a transient deletion", () => {
    const { absences, since } = heldAbsence("A.md", "write-1");
    const ledger = new WatchOperationLedger({ transientAbsences: absences });
    ledger.expect({ id: "trash-1", kind: "delete", path: "A.md" });

    const annotated = ledger.annotate([{ kind: "delete", path: "A.md" }], since);

    expect(annotated[0]?.operationId).toBeUndefined();
    expect(ledger.size).toBe(1);
  });

  /**
   * Drive one scan whose walk both takes and releases a claim on `Held.md`,
   * which is the window the scan's own mark exists to cover. Only a scan that
   * took its mark before walking, and asked what was held since then, can still
   * attribute the deletion it is about to report.
   */
  async function scanAcrossAReleasedClaim(
    scan: (watcher: NodeVaultWatcher) => Promise<VaultChangeBatch | null>,
  ): Promise<{ batch: VaultChangeBatch | null; absences: VaultTransientAbsences }> {
    await fs.mkdir(path.join(vaultPath, "Notes"), { recursive: true });
    await fs.writeFile(path.join(vaultPath, "Notes", "Held.md"), "# Held\n", "utf8");
    const absences = new VaultTransientAbsences();
    const watcher = await NodeVaultWatcher.open(vaultPath, { transientAbsences: absences });
    const handle = absences.reserve("Notes/Held.md");
    const listMarkdownPaths = watcher.policy.listMarkdownPaths.bind(watcher.policy);
    let walks = 0;
    const spy = vi
      .spyOn(watcher.policy, "listMarkdownPaths")
      .mockImplementation(async (relativeDirectory?: string) => {
        walks += 1;
        if (walks > 1) {
          return listMarkdownPaths(relativeDirectory);
        }
        handle.hold("write-held");
        await fs.rename(
          path.join(vaultPath, "Notes", "Held.md"),
          path.join(sandboxPath, "Held.md.aside"),
        );
        const paths = await listMarkdownPaths(relativeDirectory);
        handle.release();
        return paths;
      });
    try {
      const batch = await scan(watcher);
      return { batch, absences };
    } finally {
      spy.mockRestore();
      await watcher.close();
    }
  }

  it("marks a full scan before walking, so a claim released inside it still attributes", async () => {
    const { batch, absences } = await scanAcrossAReleasedClaim((watcher) => watcher.scanNow());

    // Nothing holds the path by the time the diff is annotated, which is the
    // ordinary case on any vault whose walk outlasts the transaction.
    expect(absences.operationFor("Notes/Held.md")).toBeUndefined();
    expect(batch?.changes).toEqual([
      { kind: "delete", path: "Notes/Held.md", transientOperationId: "write-held" },
    ]);
  });

  it("marks a subtree scan before walking too", async () => {
    const { batch } = await scanAcrossAReleasedClaim((watcher) => watcher.scanSubtree("Notes"));

    expect(batch?.changes).toEqual([
      { kind: "delete", path: "Notes/Held.md", transientOperationId: "write-held" },
    ]);
  });

  it("refuses to settle a rewritten move source with a transient deletion", () => {
    const { absences, since } = heldAbsence("A.md", "write-1");
    const ledger = new WatchOperationLedger({ transientAbsences: absences });
    ledger.expect({
      id: "move-1",
      kind: "move-with-writes",
      from: "A.md",
      to: "B.md",
      targetRevision: "rev-b",
      sourceRewritten: true,
      writes: [],
    });

    const annotated = ledger.annotate(
      [
        { kind: "delete", path: "A.md" },
        { kind: "upsert", state: state("B.md", "9", "rev-b") },
      ],
      since,
    );

    expect(annotated.every((change) => change.operationId === undefined)).toBe(true);
    expect(ledger.size).toBe(1);
  });
});
