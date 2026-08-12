export interface MainRendererExitDetails {
  reason: string;
  exitCode: number;
}

export interface MainRendererRecoveryOptions {
  prepare(): void;
  recover(): void | Promise<void>;
  report(message: string, details?: unknown): void;
  schedule(operation: () => void, delayMs: number): void;
  now?: () => number;
  maximumAttempts?: number;
  attemptWindowMs?: number;
  reloadDelayMs?: number;
}

export function createMainRendererRecoveryHandler(
  options: MainRendererRecoveryOptions,
): (details: MainRendererExitDetails) => void {
  const now = options.now ?? Date.now;
  const maximumAttempts = options.maximumAttempts ?? 3;
  const attemptWindowMs = options.attemptWindowMs ?? 60_000;
  const reloadDelayMs = options.reloadDelayMs ?? 100;
  const attempts: number[] = [];

  return (details) => {
    options.report("Threadleaf main renderer exited", details);
    if (details.reason === "clean-exit") {
      return;
    }
    const currentTime = now();
    while (attempts[0] !== undefined && attempts[0] <= currentTime - attemptWindowMs) {
      attempts.shift();
    }
    if (attempts.length >= maximumAttempts) {
      options.report(
        `Threadleaf stopped automatic renderer recovery after ${maximumAttempts} failures in ${attemptWindowMs} ms.`,
      );
      return;
    }
    attempts.push(currentTime);
    try {
      options.prepare();
    } catch (error) {
      options.report("Threadleaf renderer recovery preparation failed", error);
    }
    options.schedule(() => {
      try {
        const recovery = options.recover();
        void Promise.resolve(recovery).catch((error: unknown) => {
          options.report("Threadleaf could not replace the stopped renderer", error);
        });
      } catch (error) {
        options.report("Threadleaf could not replace the stopped renderer", error);
      }
    }, reloadDelayMs);
  };
}
