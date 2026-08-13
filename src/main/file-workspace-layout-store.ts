import path from "node:path";
import { atomicWriteFile, readStableFile } from "../kernel/durability";
import { parseWorkspaceLayout, type WorkspaceLayoutDocument } from "../shared/workspace-layout";

const decoder = new TextDecoder("utf-8", { fatal: true });
const vaultIdPattern = /^[a-f0-9]{64}$/;

export interface WorkspaceLayoutStore {
  load(vaultId: string): Promise<WorkspaceLayoutDocument | null>;
  save(layout: WorkspaceLayoutDocument): Promise<WorkspaceLayoutDocument>;
}

export class FileWorkspaceLayoutStore implements WorkspaceLayoutStore {
  readonly #directoryPath: string;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(directoryPath: string) {
    this.#directoryPath = path.resolve(directoryPath);
  }

  async load(vaultId: string): Promise<WorkspaceLayoutDocument | null> {
    const snapshot = await readStableFile(this.filePath(vaultId));
    return snapshot
      ? parseWorkspaceLayout(JSON.parse(decoder.decode(snapshot.bytes)), vaultId)
      : null;
  }

  async save(layout: WorkspaceLayoutDocument): Promise<WorkspaceLayoutDocument> {
    const normalized = parseWorkspaceLayout(layout, layout.vaultId);
    const bytes = Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    const write = this.#writeTail
      .catch(() => undefined)
      .then(() => atomicWriteFile(this.filePath(normalized.vaultId), bytes));
    this.#writeTail = write.then(
      () => undefined,
      () => undefined,
    );
    await write;
    return normalized;
  }

  private filePath(vaultId: string): string {
    if (!vaultIdPattern.test(vaultId)) {
      throw new Error("Workspace layout filenames require a lowercase SHA-256 vault identity.");
    }
    return path.join(this.#directoryPath, `${vaultId}.json`);
  }
}
