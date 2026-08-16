export interface StateRootPort {
  getPath(): Promise<string>;
}

export interface VaultTextSnapshot {
  path: string;
  content: string;
  revision: string;
  size: number;
}

/** The complete lexical document corpus used to authorize a compound move. */
export interface VaultMarkdownCorpus {
  paths: string[];
  revisions: Array<{ path: string; revision: string }>;
  generation: string;
  /** Absent means the legacy Markdown-only corpus. */
  scope?: "references";
}

export interface VaultReadPort {
  getName(): string;
  listMarkdownPaths(relativeDirectory?: string): Promise<string[]>;
  readText(relativePath: string): Promise<VaultTextSnapshot>;
  /** Kernels provide an authoritative full-corpus receipt; test/fake ports may not. */
  readMarkdownCorpus?(): Promise<VaultMarkdownCorpus>;
  /** Complete visible Markdown and JSON Canvas reference corpus. */
  readReferenceCorpus?(): Promise<VaultMarkdownCorpus>;
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

export interface VaultAttachmentRelinkPreconditions {
  sourceNotePath: string;
  missingPath: string;
  missingResolverTarget: string;
  replacementPath: string;
  replacementCanonicalPath: string;
  replacementRevision: string;
  maxReplacementBytes: number;
}

export type VaultAttachmentRelinkPreconditionFailure =
  | "missing-target-present"
  | "missing-target-ambiguous"
  | "missing-target-unsafe"
  | "replacement-changed"
  | "replacement-unreadable";

export type VaultAttachmentRelinkWriteResult =
  | VaultWriteResult
  | {
      status: "precondition-failed";
      reason: VaultAttachmentRelinkPreconditionFailure;
    };

export interface VaultAttachmentRelinkMutationPort {
  writeTextWithAttachmentPreconditions(
    relativePath: string,
    content: string,
    expectedRevision: string,
    preconditions: VaultAttachmentRelinkPreconditions,
  ): Promise<VaultAttachmentRelinkWriteResult>;
}

export interface VaultAttachmentIngressAuthorization {
  operation: "restore-missing";
  sourceNotePath: string;
  sourceNoteRevision: string;
  missingPath: string;
  missingResolverTarget: string;
}

export type VaultAttachmentIngressFailureReason =
  | "source-note-changed"
  | "missing-target-present"
  | "missing-target-ambiguous"
  | "missing-target-unsafe"
  | "target-normalized-exists"
  | "attachment-publish-unavailable"
  | "publish-state-diverged";

export type VaultAttachmentIngressResult =
  | {
      status: "committed";
      path: string;
      revision: string;
      transactionId: string;
    }
  | {
      status: "refused";
      path: string;
      reason: VaultAttachmentIngressFailureReason;
    }
  | {
      status: "manual-conflict";
      path: string;
      reason: VaultAttachmentIngressFailureReason;
      transactionId: string;
    };

export interface VaultAttachmentIngressMutationPort {
  ingressAttachmentBytes(
    relativePath: string,
    content: Uint8Array,
    authorization: VaultAttachmentIngressAuthorization,
  ): Promise<VaultAttachmentIngressResult>;
}

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
