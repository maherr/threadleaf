import path from "node:path";
import {
  cloneVaultAccessibilityPreferencesMap,
  isVaultAccessibilityPreferencesDocumentWithinLimit,
  normalizeVaultAccessibilityPreferencesMap,
  parseVaultAccessibilityPreferencesMap,
  type VaultAccessibilityPreferencesMap,
  type VaultAccessibilityPreferencesStore,
  vaultAccessibilityPreferencesMaxDocumentBytes,
  vaultAccessibilityPreferencesVersion,
} from "../application/vault-accessibility-preferences";
import { atomicWriteFile, readStableFile, revisionOf } from "../kernel/durability";

const decoder = new TextDecoder("utf-8", { fatal: true });

type LoadState = "unloaded" | "loaded" | "blocked";

/**
 * Atomic, mode-0600 persistence for vault-local accessibility overrides. This
 * is deliberately a separate file from the global accessibility document
 * (`./file-accessibility-preferences-store.ts`, which never receives a vault
 * path and persists a different, application-wide concern) and from every
 * other application settings document, so neither can accidentally read or
 * overwrite the other and no existing consumer's version contract has to
 * move to add this.
 *
 * Follows the same revision-guarded atomic-write pattern already used for
 * other private per-vault documents (`./file-workspace-layout-store.ts`):
 * `atomicWriteFile`/`readStableFile` from `../kernel/durability`, and a save
 * that fails closed against an externally changed file instead of silently
 * clobbering it.
 */
export class FileVaultAccessibilityPreferencesStore implements VaultAccessibilityPreferencesStore {
  readonly #filePath: string;
  #knownRevision: string | null | undefined;
  #loadState: LoadState = "unloaded";

  constructor(filePath: string) {
    this.#filePath = path.resolve(filePath);
  }

  async load(): Promise<VaultAccessibilityPreferencesMap | null> {
    try {
      const snapshot = await readStableFile(this.#filePath);
      if (!snapshot) {
        this.#knownRevision = null;
        this.#loadState = "loaded";
        return null;
      }
      if (!isVaultAccessibilityPreferencesDocumentWithinLimit(snapshot.bytes.length)) {
        throw new Error(
          `Vault accessibility preferences exceed the ${vaultAccessibilityPreferencesMaxDocumentBytes}-byte limit.`,
        );
      }
      const parsed = parseVaultAccessibilityPreferencesMap(
        JSON.parse(decoder.decode(snapshot.bytes)),
      );
      this.#knownRevision = snapshot.revision;
      this.#loadState = "loaded";
      return parsed;
    } catch (error) {
      this.#knownRevision = undefined;
      this.#loadState = "blocked";
      throw error;
    }
  }

  async save(value: VaultAccessibilityPreferencesMap): Promise<VaultAccessibilityPreferencesMap> {
    if (this.#loadState === "blocked") {
      throw new Error(
        "Threadleaf vault accessibility load failed; call recover() explicitly before overwriting the private file.",
      );
    }
    const normalized = normalizeVaultAccessibilityPreferencesMap(value);
    const document = {
      version: vaultAccessibilityPreferencesVersion,
      byVault: normalized,
    } as const;
    const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
    if (!isVaultAccessibilityPreferencesDocumentWithinLimit(bytes.length)) {
      throw new Error(
        `Vault accessibility preferences exceed the ${vaultAccessibilityPreferencesMaxDocumentBytes}-byte limit.`,
      );
    }
    if (this.#loadState === "unloaded") {
      await this.load();
    }
    const current = await readStableFile(this.#filePath);
    const currentRevision = current?.revision ?? null;
    if (this.#knownRevision === undefined) {
      if (current) {
        throw new Error(
          "Threadleaf vault accessibility preferences must be loaded before overwriting an existing private file.",
        );
      }
      this.#knownRevision = currentRevision;
      this.#loadState = "loaded";
    }
    if (currentRevision !== this.#knownRevision) {
      throw new Error(
        "Threadleaf vault accessibility preferences changed externally; refusing to overwrite the newer private file.",
      );
    }
    await atomicWriteFile(this.#filePath, bytes);
    const installed = await readStableFile(this.#filePath);
    const savedRevision = revisionOf(bytes);
    if (!installed || installed.revision !== savedRevision) {
      throw new Error(
        "Threadleaf vault accessibility preferences changed externally while saving; the external private file was preserved.",
      );
    }
    this.#knownRevision = savedRevision;
    return cloneVaultAccessibilityPreferencesMap(normalized);
  }

  /** Explicitly clears a blocked load state after the caller has confirmed
   * the on-disk file is sound again (e.g. an operator repaired or removed
   * it), matching `FileWorkspaceLayoutStore`'s pattern of failing closed
   * rather than guessing. */
  async recover(): Promise<void> {
    const snapshot = await readStableFile(this.#filePath);
    this.#knownRevision = snapshot?.revision ?? null;
    this.#loadState = "loaded";
  }
}
