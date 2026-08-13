export interface StateRootPort {
  getPath(): Promise<string>;
}

export interface VaultTextSnapshot {
  path: string;
  content: string;
  revision: string;
  size: number;
}

/** The complete lexical Markdown corpus used to authorize a compound move. */
export interface VaultMarkdownCorpus {
  paths: string[];
  revisions: Array<{ path: string; revision: string }>;
  generation: string;
}

export interface VaultReadPort {
  getName(): string;
  listMarkdownPaths(relativeDirectory?: string): Promise<string[]>;
  readText(relativePath: string): Promise<VaultTextSnapshot>;
  /** Kernels provide an authoritative full-corpus receipt; test/fake ports may not. */
  readMarkdownCorpus?(): Promise<VaultMarkdownCorpus>;
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

export interface VaultDirectoryCreateResult {
  created: boolean;
  path: string;
}

export type VaultRenameResult =
  | {
      status: "committed";
      from: string;
      to: string;
      transactionId: string;
    }
  | {
      /** Strict attachment publication creates a target and retains the source. */
      status: "published-source-retained";
      from: string;
      to: string;
      transactionId: string;
    }
  | {
      status: "conflict";
      from: string;
      to: string;
      reason: string;
      conflictPaths?: string[];
    };

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
  /** If present, the kernel must compare the complete Markdown corpus before journaling. */
  expectedMarkdownCorpus?: VaultMarkdownCorpus;
  /** Strict descriptor-relative containment for attachment moves. */
  strictContainment?: boolean;
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
      /** Attachment publication creates a new target and retains the source bytes. */
      status: "published-source-retained";
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
    expectedMarkdownCorpus?: VaultMarkdownCorpus,
    options?: { strictContainment?: boolean },
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
