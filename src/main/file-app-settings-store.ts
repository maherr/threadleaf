import path from "node:path";
import { atomicWriteFile, readStableFile } from "../kernel/durability";
import { type AppSettings, parseAppSettings } from "../shared/key-bindings";

const decoder = new TextDecoder("utf-8", { fatal: true });

export class FileAppSettingsStore {
  readonly #filePath: string;

  constructor(filePath: string) {
    this.#filePath = path.resolve(filePath);
  }

  async load(): Promise<AppSettings | null> {
    const snapshot = await readStableFile(this.#filePath);
    return snapshot ? parseAppSettings(JSON.parse(decoder.decode(snapshot.bytes))) : null;
  }

  async save(settings: AppSettings): Promise<AppSettings> {
    const normalized = parseAppSettings(settings);
    await atomicWriteFile(
      this.#filePath,
      Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`, "utf8"),
    );
    return normalized;
  }
}
