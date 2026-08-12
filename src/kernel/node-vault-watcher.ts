import { createHash, randomUUID } from "node:crypto";
import { type FSWatcher, promises as fs, watch } from "node:fs";
import path from "node:path";
import {
  hasHiddenVaultSegment,
  isPathInside,
  normalizeVaultDirectoryPath,
  VaultPathPolicy,
} from "./path-policy";
import type { VaultTextSnapshot } from "./ports";
import {
  type RescanRequest,
  type VaultChange,
  type VaultChangeBatch,
  WatchBatchSequencer,
  type WatchedPathState,
  WatchOperationLedger,
} from "./watch-protocol";

export type VaultSnapshot = Map<string, WatchedPathState>;

export interface VaultBootstrapScan {
  documents: VaultTextSnapshot[];
  snapshot: VaultSnapshot;
}

export interface SnapshotDiff {
  changes: VaultChange[];
  rescan?: RescanRequest;
}

function isTransactionTemporary(name: string): boolean {
  return /^\.threadleaf-(?:write|rollback)-[a-f0-9-]+\.tmp$/i.test(name);
}

function revisionOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function sameObservedState(left: WatchedPathState, right: WatchedPathState): boolean {
  return (
    left.identity === right.identity &&
    left.size === right.size &&
    left.modifiedNs === right.modifiedNs &&
    left.changedNs === right.changedNs
  );
}

async function readWatchedFile(
  policy: VaultPathPolicy,
  relativePath: string,
  previous: WatchedPathState | undefined,
  includeDocument: boolean,
  attempt = 0,
): Promise<{ document?: VaultTextSnapshot; state: WatchedPathState } | null> {
  const lexicalPath = policy.resolveLexical(relativePath);
  let canonicalPath: string;
  try {
    canonicalPath = await fs.realpath(lexicalPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (!isPathInside(policy.rootPath, canonicalPath)) {
    return null;
  }

  const stat = await fs.stat(canonicalPath, { bigint: true });
  if (!stat.isFile()) {
    return null;
  }
  const observed = {
    path: relativePath,
    identity: `${stat.dev}:${stat.ino}`,
    size: Number(stat.size),
    modifiedNs: stat.mtimeNs.toString(),
    changedNs: stat.ctimeNs.toString(),
  };
  if (
    previous &&
    previous.identity === observed.identity &&
    previous.size === observed.size &&
    previous.modifiedNs === observed.modifiedNs &&
    previous.changedNs === observed.changedNs
  ) {
    return { state: { ...observed, revision: previous.revision } };
  }

  const bytes = await fs.readFile(canonicalPath);
  const after = await fs.stat(canonicalPath, { bigint: true });
  if (
    after.dev !== stat.dev ||
    after.ino !== stat.ino ||
    after.size !== stat.size ||
    after.mtimeNs !== stat.mtimeNs ||
    after.ctimeNs !== stat.ctimeNs
  ) {
    if (attempt >= 2) {
      throw new Error(`File kept changing while it was scanned: ${relativePath}`);
    }
    return readWatchedFile(policy, relativePath, undefined, includeDocument, attempt + 1);
  }
  const revision = revisionOf(bytes);
  return {
    state: { ...observed, revision },
    ...(includeDocument
      ? {
          document: {
            path: relativePath,
            content: textDecoder.decode(bytes),
            revision,
            size: bytes.length,
          },
        }
      : {}),
  };
}

async function readWatchedState(
  policy: VaultPathPolicy,
  relativePath: string,
  previous: WatchedPathState | undefined,
): Promise<WatchedPathState | null> {
  return (await readWatchedFile(policy, relativePath, previous, false))?.state ?? null;
}

export async function captureVaultBootstrap(policy: VaultPathPolicy): Promise<VaultBootstrapScan> {
  const snapshot: VaultSnapshot = new Map();
  const documents: VaultTextSnapshot[] = [];
  const paths = await policy.listMarkdownPaths();
  for (const relativePath of paths) {
    if (isTransactionTemporary(path.posix.basename(relativePath))) {
      continue;
    }
    const scanned = await readWatchedFile(policy, relativePath, undefined, true);
    if (!scanned?.document) {
      continue;
    }
    snapshot.set(relativePath, scanned.state);
    documents.push(scanned.document);
  }
  return { documents, snapshot };
}

export async function captureVaultSnapshot(
  policy: VaultPathPolicy,
  previous: VaultSnapshot = new Map(),
  relativeDirectory = "",
): Promise<VaultSnapshot> {
  const snapshot: VaultSnapshot = new Map();
  const paths = await policy.listMarkdownPaths(relativeDirectory);
  for (const relativePath of paths) {
    if (isTransactionTemporary(path.posix.basename(relativePath))) {
      continue;
    }
    const state = await readWatchedState(policy, relativePath, previous.get(relativePath));
    if (state) {
      snapshot.set(relativePath, state);
    }
  }
  return snapshot;
}

export function diffVaultSnapshots(before: VaultSnapshot, after: VaultSnapshot): SnapshotDiff {
  const changes: VaultChange[] = [];
  const removed = new Map<string, WatchedPathState>();
  const added = new Map<string, WatchedPathState>();

  for (const [filePath, prior] of before) {
    const next = after.get(filePath);
    if (!next) {
      removed.set(filePath, prior);
    } else if (!sameObservedState(prior, next) || prior.revision !== next.revision) {
      changes.push({ kind: "upsert", state: next });
    }
  }
  for (const [filePath, next] of after) {
    if (!before.has(filePath)) {
      added.set(filePath, next);
    }
  }

  const removedByIdentity = new Map<string, WatchedPathState[]>();
  const addedByIdentity = new Map<string, WatchedPathState[]>();
  for (const state of removed.values()) {
    const bucket = removedByIdentity.get(state.identity) ?? [];
    bucket.push(state);
    removedByIdentity.set(state.identity, bucket);
  }
  for (const state of added.values()) {
    const bucket = addedByIdentity.get(state.identity) ?? [];
    bucket.push(state);
    addedByIdentity.set(state.identity, bucket);
  }

  for (const [identity, removedStates] of removedByIdentity) {
    const addedStates = addedByIdentity.get(identity);
    if (!addedStates) {
      continue;
    }
    if (removedStates.length !== 1 || addedStates.length !== 1) {
      const affectedPaths = [...removedStates, ...addedStates].map((state) => state.path);
      const commonDirectory = commonParentDirectory(affectedPaths);
      return {
        changes: [],
        rescan: commonDirectory
          ? { scope: "subtree", reason: "ambiguous-rename", path: commonDirectory }
          : { scope: "vault", reason: "ambiguous-rename" },
      };
    }
    const from = removedStates[0];
    const to = addedStates[0];
    if (!from || !to) {
      continue;
    }
    changes.push({ kind: "move", from: from.path, to: to.path, state: to });
    removed.delete(from.path);
    added.delete(to.path);
  }

  for (const state of removed.values()) {
    changes.push({ kind: "delete", path: state.path });
  }
  for (const state of added.values()) {
    changes.push({ kind: "upsert", state });
  }

  changes.sort((left, right) => {
    const leftPath =
      left.kind === "upsert" ? left.state.path : left.kind === "move" ? left.from : left.path;
    const rightPath =
      right.kind === "upsert" ? right.state.path : right.kind === "move" ? right.from : right.path;
    return leftPath.localeCompare(rightPath) || left.kind.localeCompare(right.kind);
  });
  return { changes };
}

function commonParentDirectory(paths: readonly string[]): string {
  if (paths.length === 0) {
    return "";
  }
  const directories = paths.map((filePath) => path.posix.dirname(filePath).split("/"));
  const first = directories[0] ?? [];
  const common: string[] = [];
  for (let index = 0; index < first.length; index += 1) {
    const segment = first[index];
    if (!segment || segment === "." || directories.some((parts) => parts[index] !== segment)) {
      break;
    }
    common.push(segment);
  }
  return common.join("/");
}

export interface NodeVaultWatcherOptions {
  debounceMs?: number;
  clock?: () => Date;
  streamId?: string;
  onError?: (error: unknown) => void;
}

export class NodeVaultWatcher {
  readonly policy: VaultPathPolicy;
  readonly #sequencer: WatchBatchSequencer;
  readonly #ledger = new WatchOperationLedger();
  readonly #debounceMs: number;
  readonly #onError: (error: unknown) => void;
  #snapshot: VaultSnapshot;
  #watcher: FSWatcher | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #listener: ((batch: VaultChangeBatch) => void | Promise<void>) | undefined;
  #flushTail: Promise<void> = Promise.resolve();
  #activitySinceScan = false;
  #closed = false;

  private constructor(
    policy: VaultPathPolicy,
    snapshot: VaultSnapshot,
    options: NodeVaultWatcherOptions,
  ) {
    this.policy = policy;
    this.#snapshot = snapshot;
    this.#debounceMs = options.debounceMs ?? 80;
    this.#onError = options.onError ?? (() => undefined);
    this.#sequencer = new WatchBatchSequencer({
      streamId: options.streamId ?? randomUUID(),
      ...(options.clock ? { clock: options.clock } : {}),
    });
  }

  static async open(
    rootPath: string,
    options: NodeVaultWatcherOptions = {},
  ): Promise<NodeVaultWatcher> {
    const policy = await VaultPathPolicy.open(rootPath);
    const snapshot = await captureVaultSnapshot(policy);
    return new NodeVaultWatcher(policy, snapshot, options);
  }

  static fromSnapshot(
    policy: VaultPathPolicy,
    snapshot: VaultSnapshot,
    options: NodeVaultWatcherOptions = {},
  ): NodeVaultWatcher {
    return new NodeVaultWatcher(policy, new Map(snapshot), options);
  }

  get operations(): WatchOperationLedger {
    return this.#ledger;
  }

  start(listener: (batch: VaultChangeBatch) => void | Promise<void>): void {
    if (this.#closed) {
      throw new Error("Vault watcher is closed.");
    }
    if (this.#watcher) {
      throw new Error("Vault watcher is already running.");
    }
    this.#listener = listener;
    this.#watcher = watch(this.policy.rootPath, { recursive: true }, (_eventType, fileName) => {
      if (fileName && hasHiddenVaultSegment(fileName.toString())) {
        return;
      }
      this.#activitySinceScan = true;
      this.scheduleScan();
    });
    this.#watcher.on("error", (error) => {
      if (this.#closed) {
        return;
      }
      this.#onError(error);
      void this.emitRescan("backend-error").catch(this.#onError);
    });
    this.scheduleScan();
  }

  async scanNow(): Promise<VaultChangeBatch | null> {
    const next = await captureVaultSnapshot(this.policy, this.#snapshot);
    const diff = diffVaultSnapshots(this.#snapshot, next);
    this.#snapshot = next;
    if (diff.changes.length === 0 && !diff.rescan) {
      return null;
    }
    if (diff.rescan) {
      this.#ledger.clear();
    }
    return this.#sequencer.next({
      changes: this.#ledger.annotate(diff.changes),
      ...(diff.rescan ? { rescan: diff.rescan } : {}),
    });
  }

  async scanSubtree(relativeDirectory: string): Promise<VaultChangeBatch | null> {
    const normalizedDirectory = normalizeVaultDirectoryPath(relativeDirectory);
    const prefix = normalizedDirectory ? `${normalizedDirectory}/` : "";
    const nextSubtree = await captureVaultSnapshot(
      this.policy,
      this.#snapshot,
      normalizedDirectory,
    );
    const next = new Map(this.#snapshot);
    for (const filePath of next.keys()) {
      if (!prefix || filePath.startsWith(prefix)) {
        next.delete(filePath);
      }
    }
    for (const [filePath, state] of nextSubtree) {
      next.set(filePath, state);
    }
    const diff = diffVaultSnapshots(this.#snapshot, next);
    this.#snapshot = next;
    if (diff.changes.length === 0 && !diff.rescan) {
      return null;
    }
    if (diff.rescan) {
      this.#ledger.clear();
    }
    return this.#sequencer.next({
      changes: this.#ledger.annotate(diff.changes),
      ...(diff.rescan ? { rescan: diff.rescan } : {}),
    });
  }

  async reportOverflow(): Promise<VaultChangeBatch> {
    this.#ledger.clear();
    return this.emitRescan("overflow");
  }

  async reportSubtreeInvalidated(relativeDirectory: string): Promise<VaultChangeBatch> {
    this.#ledger.clear();
    const normalizedDirectory = normalizeVaultDirectoryPath(relativeDirectory);
    return this.emitRescan("backend-error", {
      scope: "subtree",
      reason: "backend-error",
      path: normalizedDirectory,
    });
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#watcher?.close();
    this.#watcher = undefined;
    this.#listener = undefined;
  }

  private scheduleScan(): void {
    if (this.#closed) {
      return;
    }
    if (this.#timer) {
      clearTimeout(this.#timer);
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (this.#closed) {
        return;
      }
      this.#flushTail = this.#flushTail.then(async () => {
        try {
          const observedFilesystemActivity = this.#activitySinceScan;
          this.#activitySinceScan = false;
          const batch =
            (await this.scanNow()) ??
            (observedFilesystemActivity ? this.#sequencer.next({ changes: [] }) : null);
          if (this.#closed) {
            return;
          }
          if (batch && this.#listener) {
            await this.#listener(batch);
          }
        } catch (error) {
          if (this.#closed) {
            return;
          }
          this.#onError(error);
          await this.emitRescan("backend-error").catch(this.#onError);
        }
      });
    }, this.#debounceMs);
  }

  private async emitRescan(
    reason: "backend-error" | "overflow",
    request: RescanRequest = { scope: "vault", reason },
  ): Promise<VaultChangeBatch> {
    this.#ledger.clear();
    const batch = this.#sequencer.next({
      rescan: request,
    });
    if (this.#listener) {
      await this.#listener(batch);
    }
    return batch;
  }
}
