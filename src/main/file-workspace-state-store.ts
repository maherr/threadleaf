import path from "node:path";
import type { PersistedWorkspaceState, WorkspaceStateStore } from "../application/workspace-state";
import {
  createWorkspaceStateDocument,
  parseWorkspaceState,
  workspaceStatesEqual,
} from "../application/workspace-state";
import { atomicWriteFile, readStableFile } from "../kernel/durability";

const decoder = new TextDecoder("utf-8", { fatal: true });
const vaultIdPattern = /^[a-f0-9]{64}$/;

export class FileWorkspaceStateStore implements WorkspaceStateStore {
  readonly #directoryPath: string;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(directoryPath: string) {
    this.#directoryPath = path.resolve(directoryPath);
  }

  async load(vaultId: string): Promise<PersistedWorkspaceState | null> {
    return this.#load(vaultId);
  }

  async save(
    state: PersistedWorkspaceState,
    expectedCurrent?: PersistedWorkspaceState | null,
  ): Promise<PersistedWorkspaceState> {
    const normalized = parseWorkspaceState(state, state.vaultId);
    const normalizedExpected =
      expectedCurrent === undefined || expectedCurrent === null
        ? expectedCurrent
        : parseWorkspaceState(expectedCurrent, normalized.vaultId);
    const document = createWorkspaceStateDocument(normalized);
    const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
    const filePath = this.filePath(normalized.vaultId);
    const write = this.#writeTail
      .catch(() => undefined)
      .then(async () => {
        if (normalizedExpected !== undefined) {
          const current = await this.#load(normalized.vaultId);
          if (
            (current === null) !== (normalizedExpected === null) ||
            (current !== null &&
              normalizedExpected !== null &&
              !workspaceStatesEqual(current, normalizedExpected))
          ) {
            throw new Error("Threadleaf workspace state changed before it could be saved.");
          }
        }
        await atomicWriteFile(filePath, bytes);
      });
    this.#writeTail = write.then(
      () => undefined,
      () => undefined,
    );
    await write;
    return normalized;
  }

  async #load(vaultId: string): Promise<PersistedWorkspaceState | null> {
    const snapshot = await readStableFile(this.filePath(vaultId));
    return snapshot
      ? parseWorkspaceState(JSON.parse(decoder.decode(snapshot.bytes)), vaultId)
      : null;
  }

  private filePath(vaultId: string): string {
    if (!vaultIdPattern.test(vaultId)) {
      throw new Error("Workspace state filenames require a lowercase SHA-256 vault identity.");
    }
    return path.join(this.#directoryPath, `${vaultId}.json`);
  }
}
