import { describe, expect, it } from "vitest";
import { SerializedPluginOperationQueue, StalePluginVaultError } from "./plugin-operation-queue";

describe("SerializedPluginOperationQueue", () => {
  it("rejects a delayed A request after B becomes active before the matching command can write", async () => {
    let activeVaultId = "vault-a";
    const writes: string[] = [];
    const queue = new SerializedPluginOperationQueue(() => activeVaultId);
    const commandId = "same-command-id";
    const byteIdenticalB = { payload: "same bytes" };

    let releaseBarrier!: () => void;
    const barrier = queue.runGlobal(
      () =>
        new Promise<void>((resolve) => {
          releaseBarrier = resolve;
        }),
    );
    const delayedA = queue.run(async () => {
      writes.push(`stale-A:${commandId}`);
    }, "vault-a");

    // Vault switching is outside this queue. The queued A request must see B
    // before its operation body, even though it was submitted first.
    await Promise.resolve();
    expect(releaseBarrier).toEqual(expect.any(Function));
    activeVaultId = "vault-b";
    releaseBarrier();
    await barrier;
    await expect(delayedA).rejects.toBeInstanceOf(StalePluginVaultError);

    await queue.run(async () => {
      writes.push(`B:${commandId}:${JSON.stringify(byteIdenticalB)}`);
    }, "vault-b");

    expect(writes).toEqual(['B:same-command-id:{"payload":"same bytes"}']);
    expect(writes).not.toContain("stale-A:same-command-id");
  });
});
