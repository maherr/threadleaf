export interface PluginSurfacePreferenceTarget {
  isDestroyed(): boolean;
}

/**
 * Serializes preference propagation per isolated renderer while invalidating
 * superseded work. A delayed update for an old view cannot overtake a newer
 * update, and destroyed views never receive queued work after recreation.
 */
export class LatestPluginSurfacePropagation<T extends PluginSurfacePreferenceTarget> {
  readonly #tails = new WeakMap<T, Promise<void>>();
  readonly #epochs = new WeakMap<T, number>();
  readonly #generations = new WeakMap<T, Map<string, number>>();

  schedule(target: T, channel: string, operation: () => Promise<void>): Promise<void> {
    const channels = this.#generations.get(target) ?? new Map<string, number>();
    const generation = (channels.get(channel) ?? 0) + 1;
    channels.set(channel, generation);
    this.#generations.set(target, channels);
    const epoch = this.#epochs.get(target) ?? 0;
    const previous = this.#tails.get(target) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        if (
          (this.#epochs.get(target) ?? 0) !== epoch ||
          this.#generations.get(target)?.get(channel) !== generation ||
          target.isDestroyed()
        ) {
          return;
        }
        await operation();
      });
    this.#tails.set(target, next);
    return next;
  }

  invalidate(target: T): void {
    this.#epochs.set(target, (this.#epochs.get(target) ?? 0) + 1);
    this.#tails.delete(target);
    this.#generations.delete(target);
  }
}
