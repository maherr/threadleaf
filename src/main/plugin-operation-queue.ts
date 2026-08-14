export class StalePluginVaultError extends Error {
  constructor() {
    super("The active vault changed before the compatibility operation could run.");
    this.name = "StalePluginVaultError";
  }
}

/**
 * Serializes plugin compatibility operations and guards each one against a
 * vault switch that happens before or during its run.
 *
 * The guard is identity-level, not generation-level: `run()` compares the
 * live `activeVaultId()` string against the `expectedVaultId` the caller
 * captured when it enqueued the operation. That comparison cannot tell
 * "the vault never changed" apart from "the vault changed away and then
 * changed back to the same ID" (an A -> B -> A sequence while the operation
 * was queued or in flight): an ID that reads identical both times passes
 * either way, even though a real vault swap and reload happened in between.
 * Detecting that round trip would need a monotonically increasing
 * generation counter instead of (or alongside) the vault ID string. This
 * module deliberately does not add one: whether an A -> B -> A round trip
 * should also invalidate a queued operation is a decision for the future
 * wiring lane that owns the generation-counter question, not this
 * foundation.
 */
export class SerializedPluginOperationQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly activeVaultId: () => string) {}

  run<T>(operation: () => Promise<T>, expectedVaultId: string): Promise<T> {
    const guardedOperation = async (): Promise<T> => {
      if (this.activeVaultId() !== expectedVaultId) {
        throw new StalePluginVaultError();
      }
      const result = await operation();
      if (this.activeVaultId() !== expectedVaultId) {
        throw new StalePluginVaultError();
      }
      return result;
    };
    return this.enqueue(guardedOperation);
  }

  runGlobal<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueue(operation);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
