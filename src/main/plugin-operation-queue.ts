export class StalePluginVaultError extends Error {
  constructor() {
    super("The active vault changed before the compatibility operation could run.");
    this.name = "StalePluginVaultError";
  }
}

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
