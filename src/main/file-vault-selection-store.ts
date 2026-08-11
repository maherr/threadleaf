import path from "node:path";
import type { VaultSelectionStore } from "../application/workspace-controller";
import { atomicWriteFile, readStableFile } from "../kernel/durability";

interface VaultSelectionDocument {
  version: 1;
  vaultPath: string;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

function parseSelection(bytes: Uint8Array): VaultSelectionDocument {
  const parsed: unknown = JSON.parse(decoder.decode(bytes));
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("vaultPath" in parsed) ||
    typeof parsed.vaultPath !== "string" ||
    !path.isAbsolute(parsed.vaultPath)
  ) {
    throw new Error("Saved vault selection must contain version 1 and an absolute vault path.");
  }
  return { version: 1, vaultPath: path.resolve(parsed.vaultPath) };
}

export class FileVaultSelectionStore implements VaultSelectionStore {
  readonly #filePath: string;

  constructor(filePath: string) {
    this.#filePath = path.resolve(filePath);
  }

  async load(): Promise<string | null> {
    const snapshot = await readStableFile(this.#filePath);
    return snapshot ? parseSelection(snapshot.bytes).vaultPath : null;
  }

  async save(vaultPath: string): Promise<void> {
    if (!path.isAbsolute(vaultPath)) {
      throw new Error("Vault selections must use an absolute path.");
    }
    const document: VaultSelectionDocument = {
      version: 1,
      vaultPath: path.resolve(vaultPath),
    };
    await atomicWriteFile(
      this.#filePath,
      Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8"),
    );
  }
}
