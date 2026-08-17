import type { CompatibilityEventRef } from "./obsidian-components";

type EventCallback = (...args: unknown[]) => unknown;

export class VaultEventRef {
  private release: (() => void) | null;
  private callback: EventCallback | null;
  private readonly originalCallback: EventCallback | null;

  constructor(
    release: () => void,
    callback: EventCallback | null = null,
    originalCallback: EventCallback | null = callback,
  ) {
    this.release = release;
    this.callback = callback;
    this.originalCallback = originalCallback;
  }

  off(): void {
    this.release?.();
    this.release = null;
    this.callback = null;
  }

  invoke(args: unknown[]): void {
    this.callback?.(...args);
  }

  matches(callback: EventCallback): boolean {
    return callback === this.callback || callback === this.originalCallback;
  }
}

export class Events {
  private readonly eventListeners = new Map<string, Set<VaultEventRef>>();

  on(name: string, callback: EventCallback, context?: unknown): CompatibilityEventRef {
    const bound = context ? callback.bind(context) : callback;
    const callbacks = this.eventListeners.get(name) ?? new Set<VaultEventRef>();
    let eventRef: VaultEventRef;
    eventRef = new VaultEventRef(
      () => {
        callbacks.delete(eventRef);
        if (callbacks.size === 0) {
          this.eventListeners.delete(name);
        }
      },
      bound,
      callback,
    );
    callbacks.add(eventRef);
    this.eventListeners.set(name, callbacks);
    return eventRef;
  }

  off(name: string, callback: EventCallback): void {
    for (const eventRef of [...(this.eventListeners.get(name) ?? [])]) {
      if (eventRef.matches(callback)) {
        eventRef.off();
      }
    }
  }

  offref(ref: CompatibilityEventRef): void {
    ref.off();
  }

  trigger(name: string, ...data: unknown[]): void {
    for (const eventRef of [...(this.eventListeners.get(name) ?? [])]) {
      eventRef.invoke(data);
    }
  }

  tryTrigger(evt: CompatibilityEventRef, args: unknown[]): void {
    if (evt instanceof VaultEventRef) {
      evt.invoke(args);
    }
  }
}
