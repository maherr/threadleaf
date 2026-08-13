import path from "node:path";
import { atomicWriteFile, readStableFile, revisionOf } from "../kernel/durability";
import { type AppSettings, parseAppSettings } from "../shared/key-bindings";

const decoder = new TextDecoder("utf-8", { fatal: true });

export class FileAppSettingsStore {
  readonly #filePath: string;
  #knownRevision: string | null | undefined;

  constructor(filePath: string) {
    this.#filePath = path.resolve(filePath);
  }

  async load(): Promise<AppSettings | null> {
    const snapshot = await readStableFile(this.#filePath);
    this.#knownRevision = snapshot?.revision ?? null;
    return snapshot ? parseAppSettings(JSON.parse(decoder.decode(snapshot.bytes))) : null;
  }

  async save(settings: AppSettings): Promise<AppSettings> {
    const normalized = parseAppSettings(settings);
    const bytes = Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    const current = await readStableFile(this.#filePath);
    const currentRevision = current?.revision ?? null;
    if (this.#knownRevision === undefined) {
      if (current) {
        throw new Error(
          "Threadleaf settings must be loaded before overwriting an existing private file.",
        );
      }
      this.#knownRevision = currentRevision;
    }
    if (currentRevision !== this.#knownRevision) {
      throw new Error(
        "Threadleaf settings changed externally; refusing to overwrite the newer private file.",
      );
    }
    await atomicWriteFile(this.#filePath, bytes);
    const installed = await readStableFile(this.#filePath);
    const savedRevision = revisionOf(bytes);
    if (!installed || installed.revision !== savedRevision) {
      throw new Error(
        "Threadleaf settings changed externally while saving; the external private file was preserved.",
      );
    }
    this.#knownRevision = savedRevision;
    return normalized;
  }
}
