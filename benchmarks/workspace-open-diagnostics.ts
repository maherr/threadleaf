import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceRuntime } from "../src/application/workspace-runtime";
import {
  createWorkspaceLayout,
  type PersistedWorkspaceState,
  type WorkspaceStateStore,
} from "../src/application/workspace-state";
import { FixedStateRoot } from "../src/kernel/ports";
import type { RuntimeSnapshot } from "../src/shared/contracts";
import { WorkspaceOpenDiagnostics } from "../src/shared/workspace-open-diagnostics";

const corpusSchemaVersion = 1;
const corpusSeed = "threadleaf-workspace-open-small-v1";
const defaultCorpusRoot = "/tmp/threadleaf-workspace-open-small-v1";
const defaultOutputPath = "/tmp/threadleaf-workspace-open-before.json";
const defaultFileCount = 200_000;
const filesPerDirectory = 500;
const writeConcurrency = 256;

interface CorpusManifest {
  schemaVersion: typeof corpusSchemaVersion;
  seed: typeof corpusSeed;
  fileCount: number;
  directoryCount: number;
  contentBytes: number;
  identity: string;
}

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

function notePath(index: number): string {
  const shard = Math.floor(index / filesPerDirectory)
    .toString()
    .padStart(3, "0");
  return `shard-${shard}/note-${index.toString().padStart(6, "0")}.md`;
}

function noteContent(index: number, fileCount: number): string {
  const next = notePath((index + 1) % fileCount);
  return `---\ntitle: Seed ${index}\ntags: [perf, shard-${Math.floor(index / filesPerDirectory)}]\n---\n# Seed ${index}\n\n[[${next}]]\n`;
}

function corpusIdentity(fileCount: number, contentBytes: number): string {
  return createHash("sha256")
    .update(`${corpusSchemaVersion}\u0000${corpusSeed}\u0000${fileCount}\u0000${contentBytes}`)
    .digest("hex");
}

async function existingManifest(rootPath: string): Promise<CorpusManifest | null> {
  try {
    const value = JSON.parse(
      await fs.readFile(path.join(rootPath, ".threadleaf-workspace-open-corpus.json"), "utf8"),
    ) as Partial<CorpusManifest>;
    return value.schemaVersion === corpusSchemaVersion &&
      value.seed === corpusSeed &&
      Number.isSafeInteger(value.fileCount) &&
      Number.isSafeInteger(value.directoryCount) &&
      Number.isSafeInteger(value.contentBytes) &&
      typeof value.identity === "string"
      ? (value as CorpusManifest)
      : null;
  } catch {
    return null;
  }
}

async function ensureCorpus(rootPath: string, fileCount: number): Promise<CorpusManifest> {
  const existing = await existingManifest(rootPath);
  if (existing) {
    if (existing.fileCount !== fileCount) {
      throw new Error(
        `Corpus ${rootPath} has ${existing.fileCount} files; use a fresh path for ${fileCount}.`,
      );
    }
    return existing;
  }
  try {
    await fs.mkdir(rootPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(`Refusing to replace unrecognized corpus directory: ${rootPath}`);
    }
    throw error;
  }

  const directoryCount = Math.ceil(fileCount / filesPerDirectory);
  await Promise.all(
    Array.from({ length: directoryCount }, (_, index) =>
      fs.mkdir(path.join(rootPath, `shard-${index.toString().padStart(3, "0")}`)),
    ),
  );

  let contentBytes = 0;
  for (let start = 0; start < fileCount; start += writeConcurrency) {
    const end = Math.min(fileCount, start + writeConcurrency);
    await Promise.all(
      Array.from({ length: end - start }, async (_, offset) => {
        const index = start + offset;
        const content = noteContent(index, fileCount);
        contentBytes += Buffer.byteLength(content);
        await fs.writeFile(path.join(rootPath, notePath(index)), content, "utf8");
      }),
    );
  }
  const manifest: CorpusManifest = {
    schemaVersion: corpusSchemaVersion,
    seed: corpusSeed,
    fileCount,
    directoryCount,
    contentBytes,
    identity: corpusIdentity(fileCount, contentBytes),
  };
  await fs.writeFile(
    path.join(rootPath, ".threadleaf-workspace-open-corpus.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}

class RestoredWorkspaceStateStore implements WorkspaceStateStore {
  #state: PersistedWorkspaceState | null = null;
  readonly #openPaths: string[];
  readonly #pinnedPaths: string[];
  readonly #activePath: string;

  constructor(openPaths: string[], pinnedPaths: string[], activePath: string) {
    this.#openPaths = openPaths;
    this.#pinnedPaths = pinnedPaths;
    this.#activePath = activePath;
  }

  async load(vaultId: string): Promise<PersistedWorkspaceState> {
    return (
      this.#state ??
      createWorkspaceLayout(
        vaultId,
        [
          {
            id: "primary",
            openPaths: this.#openPaths,
            pinnedPaths: this.#pinnedPaths,
            activePath: this.#activePath,
          },
        ],
        "primary",
        null,
      )
    );
  }

  async save(state: PersistedWorkspaceState): Promise<PersistedWorkspaceState> {
    this.#state = state;
    return state;
  }
}

interface CensusAwareRuntime {
  waitForCensusCompletion?: () => Promise<void>;
}

function workspaceProgress(snapshot: RuntimeSnapshot): unknown {
  return "census" in (snapshot.workspace ?? {})
    ? (snapshot.workspace as RuntimeSnapshot["workspace"] & { census?: unknown })?.census
    : undefined;
}

async function main(): Promise<void> {
  const rootPath = option("--corpus", defaultCorpusRoot);
  const outputPath = option("--output", defaultOutputPath);
  const fileCount = Number.parseInt(option("--files", String(defaultFileCount)), 10);
  if (!Number.isSafeInteger(fileCount) || fileCount < 4) {
    throw new Error("--files must be an integer of at least 4");
  }
  const generationStartedAt = performance.now();
  const manifest = await ensureCorpus(rootPath, fileCount);
  const corpusReadyAt = performance.now();
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-workspace-open-state-"));
  const diagnostics = new WorkspaceOpenDiagnostics();
  const missingPath = "Missing-at-startup.md";
  const restoredPaths = [
    notePath(0),
    notePath(Math.floor(fileCount / 2)),
    notePath(fileCount - 1),
    missingPath,
  ];
  const stateStore = new RestoredWorkspaceStateStore(
    restoredPaths,
    [notePath(fileCount - 1)],
    notePath(Math.floor(fileCount / 2)),
  );
  const progress: unknown[] = [];
  let runtime: WorkspaceRuntime | undefined;
  try {
    const openStartedAt = performance.now();
    runtime = await WorkspaceRuntime.open({
      vaultRoot: rootPath,
      stateRoot: new FixedStateRoot(stateRoot),
      selectionSource: "restored",
      workspaceStateStore: stateStore,
      diagnostics,
      deferWorkspaceCensus: true,
    });
    const runtimeOpenedAt = performance.now();
    const unsubscribe = runtime.onSnapshot((snapshot) => {
      const census = workspaceProgress(snapshot);
      if (census !== undefined) progress.push(census);
    });
    const firstSnapshot = await runtime.getSnapshot();
    const interactiveAt = performance.now();
    const actualTabs = new Set(firstSnapshot.workspace?.tabs.map((tab) => tab.path) ?? []);
    for (const restoredPath of restoredPaths) {
      if (!actualTabs.has(restoredPath)) {
        throw new Error(`First snapshot dropped restored tab ${restoredPath}`);
      }
    }
    const censusRuntime = runtime as WorkspaceRuntime & CensusAwareRuntime;
    await censusRuntime.waitForCensusCompletion?.();
    const censusAt = performance.now();
    const finalSnapshot = await runtime.getSnapshot();
    unsubscribe();
    const result = {
      schemaVersion: 1,
      corpus: { rootPath, ...manifest },
      generationMs: corpusReadyAt - generationStartedAt,
      timings: {
        runtimeOpenMs: runtimeOpenedAt - openStartedAt,
        firstRestoredSnapshotMs: interactiveAt - openStartedAt,
        censusCompleteMs: censusAt - openStartedAt,
      },
      firstSnapshot: {
        payloadFileCount: firstSnapshot.workspace?.files.length ?? 0,
        totalFileCount: firstSnapshot.workspace?.filePage.total ?? 0,
        markdownFileCount: firstSnapshot.vault.markdownFileCount,
        indexGeneration: firstSnapshot.workspace?.indexGeneration ?? 0,
        tabs: firstSnapshot.workspace?.tabs ?? [],
        activeUnavailable: firstSnapshot.workspace?.activeUnavailable ?? null,
        census: workspaceProgress(firstSnapshot),
      },
      finalSnapshot: {
        payloadFileCount: finalSnapshot.workspace?.files.length ?? 0,
        totalFileCount: finalSnapshot.workspace?.filePage.total ?? 0,
        markdownFileCount: finalSnapshot.vault.markdownFileCount,
        indexGeneration: finalSnapshot.workspace?.indexGeneration ?? 0,
        census: workspaceProgress(finalSnapshot),
      },
      progress,
      diagnostics: diagnostics.snapshot(),
      memory: process.memoryUsage(),
    };
    await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await runtime?.close();
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
