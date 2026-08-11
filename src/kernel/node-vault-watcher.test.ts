import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { revisionOf } from "./durability";
import {
  captureVaultSnapshot,
  diffVaultSnapshots,
  NodeVaultWatcher,
  type VaultSnapshot,
} from "./node-vault-watcher";
import { VaultPathPolicy } from "./path-policy";
import {
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
});

describe("NodeVaultWatcher", () => {
  it("captures Markdown and conflict files while excluding transaction temporaries and external links", async () => {
    await fs.writeFile(path.join(vaultPath, "Note.md"), "note", "utf8");
    await fs.writeFile(
      path.join(vaultPath, "Note.threadleaf-conflict-fixture.md"),
      "conflict",
      "utf8",
    );
    await fs.writeFile(path.join(vaultPath, ".threadleaf-write-deadbeef.tmp"), "temp", "utf8");
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
});
