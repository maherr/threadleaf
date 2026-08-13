import path from "node:path";
import { atomicWriteFile, readStableFile, revisionOf } from "../kernel/durability";
import { parseWorkspaceLayout, type WorkspaceLayoutDocument } from "../shared/workspace-layout";

const decoder = new TextDecoder("utf-8", { fatal: true });
const vaultIdPattern = /^[a-f0-9]{64}$/;

export interface WorkspaceLayoutStore {
  load(vaultId: string): Promise<WorkspaceLayoutDocument | null>;
  save(layout: WorkspaceLayoutDocument): Promise<WorkspaceLayoutDocument>;
}

export class WorkspaceLayoutConflictError extends Error {
  readonly code = "WORKSPACE_LAYOUT_CONFLICT" as const;
  readonly vaultId: string;
  readonly expectedRevision: string | null;
  readonly actualRevision: string | null;

  constructor(vaultId: string, expectedRevision: string | null, actualRevision: string | null) {
    super("The saved workspace layout changed outside Threadleaf. Reload it before saving.");
    this.name = "WorkspaceLayoutConflictError";
    this.vaultId = vaultId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class FileWorkspaceLayoutStore implements WorkspaceLayoutStore {
  readonly #directoryPath: string;
  #writeTail: Promise<void> = Promise.resolve();
  readonly #expectedRevisionByVault = new Map<string, string | null>();

  constructor(directoryPath: string) {
    this.#directoryPath = path.resolve(directoryPath);
  }

  async load(vaultId: string): Promise<WorkspaceLayoutDocument | null> {
    const snapshot = await readStableFile(this.filePath(vaultId));
    const document = snapshot
      ? parseWorkspaceLayout(JSON.parse(decoder.decode(snapshot.bytes)), vaultId)
      : null;
    this.#expectedRevisionByVault.set(vaultId, snapshot?.revision ?? null);
    return document;
  }

  async save(layout: WorkspaceLayoutDocument): Promise<WorkspaceLayoutDocument> {
    const normalized = parseWorkspaceLayout(layout, layout.vaultId);
    const bytes = Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    const write = this.#writeTail
      .catch(() => undefined)
      .then(async () => {
        const filePath = this.filePath(normalized.vaultId);
        const current = await readStableFile(filePath);
        const actualRevision = current?.revision ?? null;
        const expectedRevision = this.#expectedRevisionByVault.get(normalized.vaultId);
        if (
          (expectedRevision !== undefined && actualRevision !== expectedRevision) ||
          (expectedRevision === undefined && current !== null)
        ) {
          throw new WorkspaceLayoutConflictError(
            normalized.vaultId,
            expectedRevision ?? null,
            actualRevision,
          );
        }
        await atomicWriteFile(filePath, bytes);
        this.#expectedRevisionByVault.set(normalized.vaultId, revisionOf(bytes));
      });
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
