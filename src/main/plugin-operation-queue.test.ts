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

  it("rejects the result of an in-flight operation whose vault switched away before it resolved", async () => {
    let activeVaultId = "vault-a";
    const queue = new SerializedPluginOperationQueue(() => activeVaultId);
    let operationRan = false;
    let resolveOperation!: (value: string) => void;

    const inFlight = queue.run(
      () =>
        new Promise<string>((resolve) => {
          // The Promise executor runs synchronously, so by the time this
          // line executes the pre-op guard has already passed with vault-a
          // still active: the operation genuinely started, it just has not
          // resolved yet.
          operationRan = true;
          resolveOperation = resolve;
        }),
      "vault-a",
    );

    await Promise.resolve();
    expect(operationRan).toBe(true);

    // The active vault changes while the long-running operation is still
    // in flight...
    activeVaultId = "vault-b";
    // ...and only then does the operation itself finish successfully.
    resolveOperation("operation result");

    // The operation body completed and produced a result, but the post-op
    // guard (checked after `await operation()`) must still discard it: the
    // caller sees a rejection, never "operation result".
    await expect(inFlight).rejects.toBeInstanceOf(StalePluginVaultError);
  });
});
