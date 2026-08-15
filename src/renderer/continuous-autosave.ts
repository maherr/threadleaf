import type { AutosaveFlushReason } from "../shared/autosave";

export const continuousAutosaveDelayMs = 1_500;

export interface ContinuousAutosaveOptions<Snapshot> {
  capture(): Snapshot | null;
  persist(snapshot: Snapshot): Promise<void>;
  delayMs?: number;
  onStateChange?(): void;
}

/**
 * Coalesces editor changes without weakening transition boundaries. A timed
 * save persists the latest captured version after the idle delay, while a
 * flush waits for an in-flight write and then keeps saving until every edit
 * observed before the transition has reached the writer.
 */
export class ContinuousAutosave<Snapshot> {
  readonly #capture: () => Snapshot | null;
  readonly #persist: (snapshot: Snapshot) => Promise<void>;
  readonly #delayMs: number;
  readonly #onStateChange: () => void;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #version = 0;
  #persistedVersion = 0;
  #inFlight: Promise<void> | null = null;
  #error: Error | null = null;

  constructor(options: ContinuousAutosaveOptions<Snapshot>) {
    this.#capture = options.capture;
    this.#persist = options.persist;
    this.#delayMs = options.delayMs ?? continuousAutosaveDelayMs;
    this.#onStateChange = options.onStateChange ?? (() => undefined);
  }

  get pending(): boolean {
    return this.#persistedVersion < this.#version;
  }

  get saving(): boolean {
    return this.#inFlight !== null;
  }

  get error(): Error | null {
    return this.#error;
  }

  changed(): void {
    this.#version += 1;
    this.#error = null;
    this.#schedule();
    this.#onStateChange();
  }

  synchronized(): void {
    this.#cancelTimer();
    this.#persistedVersion = this.#version;
    this.#error = null;
    this.#onStateChange();
  }

  reset(): void {
    this.#cancelTimer();
    this.#version = 0;
    this.#persistedVersion = 0;
    this.#error = null;
    this.#onStateChange();
  }

  async flush(_reason: AutosaveFlushReason): Promise<void> {
    this.#cancelTimer();
    if (this.#inFlight) await this.#inFlight;
    while (this.pending) {
      await this.#saveNext();
    }
  }

  dispose(): void {
    this.#cancelTimer();
  }

  #schedule(): void {
    this.#cancelTimer();
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#saveNext().catch(() => undefined);
    }, this.#delayMs);
  }

  async #saveNext(): Promise<void> {
    if (this.#inFlight) {
      await this.#inFlight;
      return;
    }
    if (!this.pending) {
      return;
    }
    const targetVersion = this.#version;
    const snapshot = this.#capture();
    if (snapshot === null) {
      this.#persistedVersion = targetVersion;
      this.#error = null;
      this.#onStateChange();
      return;
    }
    this.#cancelTimer();
    const operation = this.#persist(snapshot)
      .then(() => {
        this.#persistedVersion = Math.max(this.#persistedVersion, targetVersion);
        this.#error = null;
      })
      .catch((error: unknown) => {
        this.#error = error instanceof Error ? error : new Error(String(error));
        throw this.#error;
      })
      .finally(() => {
        this.#inFlight = null;
        if (this.pending && !this.#error) {
          this.#schedule();
        }
        this.#onStateChange();
      });
    this.#inFlight = operation;
    this.#onStateChange();
    await operation;
  }

  #cancelTimer(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }
}
