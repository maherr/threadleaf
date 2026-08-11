export interface StateRootPort {
  getPath(): Promise<string>;
}

export interface VaultTextSnapshot {
  path: string;
  content: string;
  revision: string;
  size: number;
}

export interface VaultReadPort {
  getName(): string;
  listMarkdownPaths(relativeDirectory?: string): Promise<string[]>;
  readText(relativePath: string): Promise<VaultTextSnapshot>;
}

export type VaultWriteResult =
  | { status: "committed"; path: string; revision: string; transactionId: string }
  | {
      status: "conflict";
      path: string;
      currentRevision: string | null;
      conflictPath: string;
      transactionId: string;
    };

export type VaultRenameResult =
  | { status: "committed"; from: string; to: string; transactionId: string }
  | { status: "conflict"; from: string; to: string; reason: string };

export interface MultiWriteRequest {
  path: string;
  content: string;
  expectedRevision: string | null;
}

export type MultiWriteEntryResult =
  | { status: "committed"; path: string; revision: string }
  | {
      status: "conflict";
      path: string;
      currentRevision: string | null;
      conflictPath: string;
    };

export interface MultiWriteResult {
  status: "committed" | "conflict";
  transactionId: string;
  entries: MultiWriteEntryResult[];
}

export interface MoveWithWritesRequest {
  sourcePath: string;
  targetPath: string;
  expectedSourceRevision: string;
  writes: readonly MultiWriteRequest[];
}

export type MoveWithWritesResult =
  | {
      status: "committed";
      from: string;
      to: string;
      transactionId: string;
      writes: Array<{ path: string; revision: string }>;
    }
  | {
      status: "conflict";
      from: string;
      to: string;
      reason: string;
      conflictPaths: string[];
    };

export interface VaultMutationPort extends VaultReadPort {
  writeText(
    relativePath: string,
    content: string,
    expectedRevision: string | null,
  ): Promise<VaultWriteResult>;
  renameFile(
    sourcePath: string,
    targetPath: string,
    expectedSourceRevision: string,
  ): Promise<VaultRenameResult>;
  writeMany(requests: readonly MultiWriteRequest[]): Promise<MultiWriteResult>;
  moveWithWrites(request: MoveWithWritesRequest): Promise<MoveWithWritesResult>;
}

export class FixedStateRoot implements StateRootPort {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async getPath(): Promise<string> {
    return this.#path;
  }
}
