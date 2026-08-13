import type { AppearanceWatchInvalidation } from "./vault-appearance-watcher";

export interface AppearanceWatchTarget {
  vaultId: string;
  vaultPath: string;
}

export interface AppearanceWatcherPort {
  close(): Promise<void> | void;
}

export interface AppearanceWatcherLifecycleOptions {
  createWatcher: (
    target: AppearanceWatchTarget,
    onInvalidation: (invalidation: AppearanceWatchInvalidation) => void | Promise<void>,
  ) => Promise<AppearanceWatcherPort>;
  reload: (target: AppearanceWatchTarget) => Promise<void>;
  reportError?: (error: unknown) => void;
}

function sameTarget(
  left: AppearanceWatchTarget | null,
  right: AppearanceWatchTarget | null,
): boolean {
  return left?.vaultId === right?.vaultId && left?.vaultPath === right?.vaultPath;
}

/** Main-process ownership and supersession guard for one active vault appearance watcher. */
export class AppearanceWatcherLifecycle {
  readonly #options: AppearanceWatcherLifecycleOptions;
  readonly #closing = new Set<Promise<void>>();
  readonly #opening = new Set<Promise<void>>();
  #target: AppearanceWatchTarget | null = null;
  #watcher: AppearanceWatcherPort | null = null;
  #generation = 0;

  constructor(options: AppearanceWatcherLifecycleOptions) {
    this.#options = options;
  }

  reconcile(target: AppearanceWatchTarget | null): void {
    if (sameTarget(this.#target, target)) {
      return;
    }
    this.#target = target;
    const generation = ++this.#generation;
    const previous = this.#watcher;
    this.#watcher = null;
    if (previous) {
      this.#close(previous);
    }
    if (!target) {
      return;
    }
    const opening = this.#open(target, generation);
    this.#opening.add(opening);
    void opening.finally(() => this.#opening.delete(opening));
  }

  async close(): Promise<void> {
    this.reconcile(null);
    await Promise.allSettled([...this.#opening]);
    await Promise.allSettled([...this.#closing]);
  }

  async #open(target: AppearanceWatchTarget, generation: number): Promise<void> {
    try {
      const watcher = await this.#options.createWatcher(target, (invalidation) =>
        this.#reload(target, generation, invalidation),
      );
      if (!this.#isCurrent(target, generation)) {
        await this.#close(watcher);
        return;
      }
      this.#watcher = watcher;
    } catch (error) {
      this.#options.reportError?.(error);
    }
  }

  async #reload(
    target: AppearanceWatchTarget,
    generation: number,
    _invalidation: AppearanceWatchInvalidation,
  ): Promise<void> {
    if (!this.#isCurrent(target, generation)) {
      return;
    }
    try {
      await this.#options.reload(target);
    } catch (error) {
      this.#options.reportError?.(error);
    }
  }

  #isCurrent(target: AppearanceWatchTarget, generation: number): boolean {
    return generation === this.#generation && sameTarget(this.#target, target);
  }

  async #close(watcher: AppearanceWatcherPort): Promise<void> {
    const closing = Promise.resolve()
      .then(() => watcher.close())
      .catch((error) => {
        this.#options.reportError?.(error);
      });
    this.#closing.add(closing);
    await closing;
    this.#closing.delete(closing);
  }
}
