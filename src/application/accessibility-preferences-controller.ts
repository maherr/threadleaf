import {
  type AccessibilityPreferences,
  type AccessibilityPreferencesSnapshot,
  createDefaultAccessibilityPreferences,
  normalizeAccessibilityPreferences,
} from "../shared/accessibility-preferences";

export interface AccessibilityPreferencesStore {
  load(): Promise<AccessibilityPreferences | null>;
  save(preferences: AccessibilityPreferences): Promise<AccessibilityPreferences>;
}

type AccessibilityPreferencesListener = (snapshot: AccessibilityPreferencesSnapshot) => void;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Serializes publication after durable persistence. A failed save leaves the
 * active snapshot unchanged, while a malformed load falls back visibly and
 * keeps the invalid bytes available for diagnosis.
 */
export class AccessibilityPreferencesController {
  readonly #store: AccessibilityPreferencesStore;
  readonly #listeners = new Set<AccessibilityPreferencesListener>();
  #snapshot: AccessibilityPreferencesSnapshot;
  #writeTail: Promise<void> = Promise.resolve();

  private constructor(
    store: AccessibilityPreferencesStore,
    snapshot: AccessibilityPreferencesSnapshot,
  ) {
    this.#store = store;
    this.#snapshot = snapshot;
  }

  static async open(
    store: AccessibilityPreferencesStore,
  ): Promise<AccessibilityPreferencesController> {
    try {
      const preferences = (await store.load()) ?? createDefaultAccessibilityPreferences();
      return new AccessibilityPreferencesController(store, { preferences, warning: null });
    } catch (error) {
      return new AccessibilityPreferencesController(store, {
        preferences: createDefaultAccessibilityPreferences(),
        warning: `Could not read saved accessibility preferences: ${errorMessage(error)} Defaults are active; the file was not changed.`,
      });
    }
  }

  getSnapshot(): AccessibilityPreferencesSnapshot {
    return {
      preferences: { ...this.#snapshot.preferences },
      warning: this.#snapshot.warning,
    };
  }

  async setPreferences(
    preferences: AccessibilityPreferences,
  ): Promise<AccessibilityPreferencesSnapshot> {
    const candidate = normalizeAccessibilityPreferences(preferences);
    // Serialize writes even when a renderer sends two changes in quick
    // succession. The second operation reads the latest in-memory snapshot.
    const operation = this.#writeTail.then(
      () => this.#store.save(candidate),
      () => this.#store.save(candidate),
    );
    this.#writeTail = operation.then(
      () => undefined,
      () => undefined,
    );
    const saved = await operation;
    return this.adopt(saved);
  }

  async reset(): Promise<AccessibilityPreferencesSnapshot> {
    return this.setPreferences(createDefaultAccessibilityPreferences());
  }

  onSnapshot(listener: AccessibilityPreferencesListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  private adopt(preferences: AccessibilityPreferences): AccessibilityPreferencesSnapshot {
    this.#snapshot = { preferences, warning: null };
    const snapshot = this.getSnapshot();
    for (const listener of this.#listeners) {
      listener(snapshot);
    }
    return snapshot;
  }
}
