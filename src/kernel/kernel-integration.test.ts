import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { revisionOf } from "./durability";
import { MetadataIndex, VaultIndexReactor } from "./metadata-index";
import { NodeVaultWatcher } from "./node-vault-watcher";
import { FixedStateRoot } from "./ports";
import { VaultKernel } from "./vault-kernel";

let sandboxPath: string;
let vaultPath: string;
let statePath: string;

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-kernel-integration-"));
  vaultPath = path.join(sandboxPath, "vault");
  statePath = path.join(sandboxPath, "state");
  await fs.mkdir(vaultPath);
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

async function expectIndexEquivalent(
  reactor: VaultIndexReactor,
  kernel: VaultKernel,
): Promise<void> {
  const rebuilt = await MetadataIndex.build(kernel);
  expect(reactor.index.snapshot()).toEqual(rebuilt.snapshot());
}

describe("vault kernel integration", () => {
  it("converges writer, external edits, watcher attribution, and the metadata index", async () => {
    await fs.writeFile(path.join(vaultPath, "A.md"), "[[B]]", "utf8");
    await fs.writeFile(path.join(vaultPath, "B.md"), "# B", "utf8");
    const kernel = await VaultKernel.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
    });
    const watcher = await NodeVaultWatcher.open(vaultPath, { streamId: "integration-stream" });
    const reactor = await VaultIndexReactor.open(kernel);

    const beforeWrite = await kernel.readText("B.md");
    const write = await kernel.writeText("B.md", "# B changed\n#changed", beforeWrite.revision);
    expect(write.status).toBe("committed");
    if (write.status !== "committed") {
      throw new Error("Expected the fixture write to commit.");
    }
    watcher.operations.expect({
      id: write.transactionId,
      kind: "write",
      path: write.path,
      revision: write.revision,
    });
    const writeBatch = await watcher.scanNow();
    expect(writeBatch?.changes).toMatchObject([
      { kind: "upsert", state: { path: "B.md" }, operationId: write.transactionId },
    ]);
    if (!writeBatch) {
      throw new Error("Expected a watcher batch for the fixture write.");
    }
    await expect(reactor.accept(writeBatch)).resolves.toEqual({ mode: "incremental" });
    await expectIndexEquivalent(reactor, kernel);

    const rename = await kernel.renameFile("B.md", "Renamed.md", write.revision);
    expect(rename.status).toBe("committed");
    if (rename.status !== "committed") {
      throw new Error("Expected the fixture rename to commit.");
    }
    watcher.operations.expect({
      id: rename.transactionId,
      kind: "rename",
      from: rename.from,
      to: rename.to,
      revision: write.revision,
    });
    const renameBatch = await watcher.scanNow();
    expect(renameBatch?.changes).toMatchObject([
      {
        kind: "move",
        from: "B.md",
        to: "Renamed.md",
        operationId: rename.transactionId,
      },
    ]);
    if (!renameBatch) {
      throw new Error("Expected a watcher batch for the fixture rename.");
    }
    await reactor.accept(renameBatch);
    await expectIndexEquivalent(reactor, kernel);

    await fs.writeFile(path.join(vaultPath, "A.md"), "[[Renamed]] #external", "utf8");
    const externalBatch = await watcher.scanNow();
    expect(externalBatch?.changes[0]).not.toHaveProperty("operationId");
    if (!externalBatch) {
      throw new Error("Expected a watcher batch for the external edit.");
    }
    await reactor.accept(externalBatch);
    await expectIndexEquivalent(reactor, kernel);

    const stale = await kernel.readText("A.md");
    await fs.writeFile(path.join(vaultPath, "A.md"), "external wins", "utf8");
    const proposal = "threadleaf proposal";
    const conflict = await kernel.writeText("A.md", proposal, stale.revision);
    expect(conflict.status).toBe("conflict");
    if (conflict.status !== "conflict") {
      throw new Error("Expected the stale write to create a conflict copy.");
    }
    watcher.operations.expect({
      id: conflict.transactionId,
      kind: "write",
      path: conflict.conflictPath,
      revision: revisionOf(Buffer.from(proposal)),
    });
    const conflictBatch = await watcher.scanNow();
    expect(conflictBatch?.changes).toContainEqual(
      expect.objectContaining({
        kind: "upsert",
        state: expect.objectContaining({ path: conflict.conflictPath }),
        operationId: conflict.transactionId,
      }),
    );
    if (!conflictBatch) {
      throw new Error("Expected a watcher batch for the conflict fixture.");
    }
    await reactor.accept(conflictBatch);
    await expectIndexEquivalent(reactor, kernel);
    await watcher.close();
  });
});
