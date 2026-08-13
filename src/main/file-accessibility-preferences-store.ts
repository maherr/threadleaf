import path from "node:path";
import { atomicWriteFile, readStableFile } from "../kernel/durability";
import {
  type AccessibilityPreferences,
  accessibilityPreferencesMaxDocumentBytes,
  isAccessibilityPreferencesDocumentWithinLimit,
  parseAccessibilityPreferences,
} from "../shared/accessibility-preferences";

const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Atomic, mode-0600 persistence for global accessibility state. The caller
 * supplies an application-data path; this store never receives a vault path
 * and therefore cannot accidentally write into a vault.
 */
export class FileAccessibilityPreferencesStore {
  readonly #filePath: string;

  constructor(filePath: string) {
    this.#filePath = path.resolve(filePath);
  }

  async load(): Promise<AccessibilityPreferences | null> {
    const snapshot = await readStableFile(this.#filePath);
    if (!snapshot) {
      return null;
    }
    if (!isAccessibilityPreferencesDocumentWithinLimit(snapshot.bytes.length)) {
      throw new Error(
        `Accessibility preferences exceed the ${accessibilityPreferencesMaxDocumentBytes}-byte limit.`,
      );
    }
    return parseAccessibilityPreferences(JSON.parse(decoder.decode(snapshot.bytes)));
  }

  async save(preferences: AccessibilityPreferences): Promise<AccessibilityPreferences> {
    const normalized = parseAccessibilityPreferences(preferences);
    const bytes = Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    if (!isAccessibilityPreferencesDocumentWithinLimit(bytes.length)) {
      throw new Error(
        `Accessibility preferences exceed the ${accessibilityPreferencesMaxDocumentBytes}-byte limit.`,
      );
    }
    await atomicWriteFile(this.#filePath, bytes);
    return normalized;
  }
}
