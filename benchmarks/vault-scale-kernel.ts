import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { VaultIndexReactor } from "../src/kernel/metadata-index";
import { captureVaultBootstrap, NodeVaultWatcher } from "../src/kernel/node-vault-watcher";
import { FixedStateRoot } from "../src/kernel/ports";
import { VaultKernel } from "../src/kernel/vault-kernel";
import {
  buildVaultScaleManifest,
  type VaultScaleManifest,
  type VaultScaleVariant,
} from "./vault-scale-corpus";

interface KernelOptions {
  variant: VaultScaleVariant;
  vaultPath: string;
  stateRoot: string;
}

interface TimedOperation<T> {
  value: T;
  durationMs: number;
  maxBlockingPauseMs: number;
  heartbeatTicks: number;
  peakRssBytes: number;
}

export const incrementalMutationCount = 100;
const incrementalAdditionDirectory = "threadleaf-performance-incremental";

function parseOptions(argv: readonly string[]): KernelOptions {
  const valueAfter = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const variant = valueAfter("--variant");
  if (variant !== "full" && variant !== "notes-only" && variant !== "smoke") {
    throw new Error("--variant must be full, notes-only, or smoke.");
  }
  const vaultPath = valueAfter("--vault");
  const stateRoot = valueAfter("--state-root");
  if (!vaultPath || !stateRoot) {
    throw new Error("--vault and --state-root are required.");
  }
  return { variant, vaultPath, stateRoot };
}

async function measure<T>(operation: () => Promise<T>): Promise<TimedOperation<T>> {
  const intervalMs = 5;
  let maxBlockingPauseMs = 0;
  let heartbeatTicks = 0;
  let lastHeartbeat = performance.now();
  let peakRssBytes = process.memoryUsage().rss;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    maxBlockingPauseMs = Math.max(
      maxBlockingPauseMs,
      Math.max(0, now - lastHeartbeat - intervalMs),
    );
    lastHeartbeat = now;
    heartbeatTicks += 1;
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }, intervalMs);
  const started = performance.now();
  let value: T;
  try {
    value = await operation();
  } finally {
    clearInterval(heartbeat);
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }
  return {
    value,
    durationMs: performance.now() - started,
    maxBlockingPauseMs,
    heartbeatTicks,
    peakRssBytes,
  };
}

async function currentVisibleFileCount(kernel: VaultKernel): Promise<number> {
  return (await kernel.listVisiblePaths()).files.length;
}

async function readOriginals(
  vaultPath: string,
  paths: readonly string[],
): Promise<Map<string, Buffer>> {
  const originals = new Map<string, Buffer>();
  for (const relativePath of paths) {
    originals.set(
      relativePath,
      await fs.readFile(path.join(vaultPath, ...relativePath.split("/"))),
    );
  }
  return originals;
}

async function restoreOriginals(
  vaultPath: string,
  originals: ReadonlyMap<string, Buffer>,
): Promise<void> {
  for (const [relativePath, bytes] of originals) {
    await fs.writeFile(path.join(vaultPath, ...relativePath.split("/")), bytes);
  }
}

function addedPaths(): string[] {
  return Array.from(
    { length: incrementalMutationCount },
    (_, index) => `${incrementalAdditionDirectory}/added-${String(index + 1).padStart(3, "0")}.md`,
  );
}

export function createIncrementalMutationPlan(manifest: VaultScaleManifest): {
  touchPaths: string[];
  deletePaths: string[];
  additionPaths: string[];
} {
  const touchPaths = manifest.mutationPaths.slice(0, incrementalMutationCount);
  if (touchPaths.length !== incrementalMutationCount) {
    throw new Error("The scale manifest has fewer than 100 mutation paths.");
  }
  const deletePaths = [...touchPaths];
  return { touchPaths, deletePaths, additionPaths: addedPaths() };
}

function assertExactChanges(
  label: string,
  changes: readonly { kind: string; state?: { path: string }; path?: string }[],
  expectedKind: "upsert" | "delete",
  expectedPaths: readonly string[],
): void {
  const observedPaths = changes.map((change) =>
    change.kind === "upsert" ? change.state?.path : change.path,
  );
  if (
    changes.length !== expectedPaths.length ||
    changes.some((change) => change.kind !== expectedKind) ||
    observedPaths.sort().join("\n") !== [...expectedPaths].sort().join("\n")
  ) {
    throw new Error(
      `${label} produced ${changes.length} change(s), not exactly ${expectedPaths.length} ${expectedKind} change(s) for the expected paths.`,
    );
  }
}

async function acceptScan(watcher: NodeVaultWatcher, index: VaultIndexReactor, label: string) {
  const batch = await watcher.scanNow();
  if (!batch) throw new Error(`${label} did not produce a watcher change.`);
  await index.accept(batch);
  return batch;
}

async function measureIncremental(
  kernel: VaultKernel,
  baselineSnapshot: Awaited<ReturnType<typeof captureVaultBootstrap>>,
  baselineIndex: VaultIndexReactor,
  vaultPath: string,
  manifest: VaultScaleManifest,
): Promise<{
  touch100: TimedOperation<{ changeCount: number; indexGeneration: number }>;
  add100: TimedOperation<{ changeCount: number; indexGeneration: number }>;
  delete100: TimedOperation<{ changeCount: number; indexGeneration: number }>;
}> {
  const {
    touchPaths: touchedPaths,
    deletePaths: deletedPaths,
    additionPaths,
  } = createIncrementalMutationPlan(manifest);
  const incrementalWatcher = NodeVaultWatcher.fromSnapshot(
    kernel.paths,
    baselineSnapshot.snapshot,
    {
      streamId: `vault-scale-${manifest.variant}-incremental`,
    },
  );

  try {
    const touchOriginals = await readOriginals(vaultPath, touchedPaths);
    let touchObserved = false;
    let touchResult: TimedOperation<{ changeCount: number; indexGeneration: number }> | undefined;
    try {
      touchResult = await measure(async () => {
        const changedAt = new Date(Date.now() + 2_000);
        for (const relativePath of touchedPaths) {
          await fs.utimes(path.join(vaultPath, ...relativePath.split("/")), changedAt, changedAt);
        }
        const batch = await acceptScan(incrementalWatcher, baselineIndex, "The 100-file touch");
        touchObserved = true;
        assertExactChanges("The 100-file touch", batch.changes, "upsert", touchedPaths);
        return {
          changeCount: batch.changes.length,
          indexGeneration: baselineIndex.index.generation,
        };
      });
    } finally {
      await restoreOriginals(vaultPath, touchOriginals);
      if (touchObserved) {
        const restoredTouch = await acceptScan(
          incrementalWatcher,
          baselineIndex,
          "The touch restoration",
        );
        assertExactChanges("The touch restoration", restoredTouch.changes, "upsert", touchedPaths);
      }
    }
    if (!touchResult) throw new Error("The 100-file touch did not produce a timing result.");

    const additionDirectory = path.join(vaultPath, incrementalAdditionDirectory);
    const addMarker = `threadleaf-vault-scale-add-${manifest.variant}`;
    let additionsObserved = false;
    let addResult: TimedOperation<{ changeCount: number; indexGeneration: number }> | undefined;
    try {
      addResult = await measure(async () => {
        await fs.mkdir(additionDirectory, { recursive: true });
        for (const relativePath of additionPaths) {
          await fs.writeFile(
            path.join(vaultPath, ...relativePath.split("/")),
            `---\ntags: [threadleaf-performance]\n---\n# Added benchmark note\n\n${addMarker}\n`,
          );
        }
        const batch = await acceptScan(incrementalWatcher, baselineIndex, "The 100-file add");
        additionsObserved = true;
        assertExactChanges("The 100-file add", batch.changes, "upsert", additionPaths);
        const addedDocumentCount = baselineIndex.index
          .snapshot()
          .documents.filter((document) =>
            document.path.startsWith(`${incrementalAdditionDirectory}/`),
          ).length;
        if (addedDocumentCount !== incrementalMutationCount) {
          throw new Error("The 100-file add did not converge in the metadata index.");
        }
        return {
          changeCount: batch.changes.length,
          indexGeneration: baselineIndex.index.generation,
        };
      });
    } finally {
      await fs.rm(additionDirectory, { recursive: true, force: true });
      if (additionsObserved) {
        const removedAdditions = await acceptScan(
          incrementalWatcher,
          baselineIndex,
          "The add restoration",
        );
        assertExactChanges(
          "The add restoration",
          removedAdditions.changes,
          "delete",
          additionPaths,
        );
      }
    }
    if (!addResult) throw new Error("The 100-file add did not produce a timing result.");

    const deleteOriginals = await readOriginals(vaultPath, deletedPaths);
    let deletesObserved = false;
    let deleteResult: TimedOperation<{ changeCount: number; indexGeneration: number }> | undefined;
    try {
      deleteResult = await measure(async () => {
        for (const relativePath of deletedPaths) {
          await fs.rm(path.join(vaultPath, ...relativePath.split("/")));
        }
        const batch = await acceptScan(incrementalWatcher, baselineIndex, "The 100-file delete");
        deletesObserved = true;
        assertExactChanges("The 100-file delete", batch.changes, "delete", deletedPaths);
        return {
          changeCount: batch.changes.length,
          indexGeneration: baselineIndex.index.generation,
        };
      });
    } finally {
      await restoreOriginals(vaultPath, deleteOriginals);
      if (deletesObserved) {
        const restoredDeletes = await acceptScan(
          incrementalWatcher,
          baselineIndex,
          "The delete restoration",
        );
        assertExactChanges(
          "The delete restoration",
          restoredDeletes.changes,
          "upsert",
          deletedPaths,
        );
      }
    }
    if (!deleteResult) throw new Error("The 100-file delete did not produce a timing result.");
    return { touch100: touchResult, add100: addResult, delete100: deleteResult };
  } finally {
    await incrementalWatcher.close();
  }
}

async function run(options: KernelOptions): Promise<void> {
  const manifest = buildVaultScaleManifest(options.variant);
  await fs.mkdir(options.stateRoot, { recursive: true, mode: 0o700 });
  const started = performance.now();
  const kernelOpen = await measure(() =>
    VaultKernel.open({
      vaultRoot: options.vaultPath,
      stateRoot: new FixedStateRoot(options.stateRoot),
      readOnly: true,
    }),
  );
  const kernel = kernelOpen.value;
  let watcher: NodeVaultWatcher | undefined;
  try {
    const bootstrap = await measure(() => captureVaultBootstrap(kernel.paths));
    watcher = NodeVaultWatcher.fromSnapshot(kernel.paths, bootstrap.value.snapshot, {
      streamId: `vault-scale-${options.variant}-baseline`,
    });
    const index = await measure(() =>
      VaultIndexReactor.fromSnapshotsAsync(kernel, bootstrap.value.documents),
    );
    const projection = await measure(async () => {
      const snapshot = index.value.index.snapshot();
      if (snapshot.documents.length !== manifest.markdownFileCount) {
        throw new Error(
          `Kernel index has ${snapshot.documents.length} notes, expected ${manifest.markdownFileCount}.`,
        );
      }
      return {
        documentCount: snapshot.documents.length,
        backlinkCount: snapshot.backlinks.filter((entry) => entry.sources.length > 0).length,
        duplicateNameCount: snapshot.duplicateNames.length,
      };
    });
    const totalReadinessMs = performance.now() - started;
    const visibleFiles = await measure(() => currentVisibleFileCount(kernel));
    const bootstrapDocumentCount = bootstrap.value.documents.length;
    if (
      bootstrapDocumentCount !== manifest.markdownFileCount ||
      bootstrap.value.snapshot.size !== manifest.markdownFileCount ||
      visibleFiles.value !== manifest.visibleFileCount
    ) {
      throw new Error(
        `Kernel corpus counts mismatch: bootstrap=${bootstrapDocumentCount}, watcher=${bootstrap.value.snapshot.size}, visible=${visibleFiles.value}.`,
      );
    }
    bootstrap.value.documents.length = 0;
    const incremental = await measureIncremental(
      kernel,
      bootstrap.value,
      index.value,
      options.vaultPath,
      manifest,
    );
    const settledRssBytes = process.memoryUsage().rss;
    const eventLoopPauses = [
      bootstrap.maxBlockingPauseMs,
      index.maxBlockingPauseMs,
      projection.maxBlockingPauseMs,
      visibleFiles.maxBlockingPauseMs,
      incremental.touch100.maxBlockingPauseMs,
      incremental.add100.maxBlockingPauseMs,
      incremental.delete100.maxBlockingPauseMs,
    ];
    process.stdout.write(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          variant: options.variant,
          corpus: {
            fileCount: manifest.fileCount,
            visibleFileCount: manifest.visibleFileCount,
            markdownFileCount: manifest.markdownFileCount,
            totalBytes: manifest.totalBytes,
            sampleHash: manifest.sampleHash,
          },
          timings: {
            kernelOpenMs: kernelOpen.durationMs,
            bootstrapScanMs: bootstrap.durationMs,
            metadataIndexBuildMs: index.durationMs,
            indexProjectionMs: projection.durationMs,
            visiblePathEnumerationMs: visibleFiles.durationMs,
            readinessMs: totalReadinessMs,
            incrementalTouch100Ms: incremental.touch100.durationMs,
            incrementalAdd100Ms: incremental.add100.durationMs,
            incrementalDelete100Ms: incremental.delete100.durationMs,
          },
          incremental: {
            touch100: incremental.touch100.value,
            add100: incremental.add100.value,
            delete100: incremental.delete100.value,
          },
          memory: {
            nodePeakRssBytes: Math.max(
              kernelOpen.peakRssBytes,
              bootstrap.peakRssBytes,
              index.peakRssBytes,
              projection.peakRssBytes,
              visibleFiles.peakRssBytes,
              incremental.touch100.peakRssBytes,
              incremental.add100.peakRssBytes,
              incremental.delete100.peakRssBytes,
            ),
            nodeSettledRssBytes: settledRssBytes,
            heapUsedBytes: process.memoryUsage().heapUsed,
          },
          responsiveness: {
            maxBlockingPauseMs: Math.max(...eventLoopPauses),
            stages: {
              bootstrapScanMs: bootstrap.maxBlockingPauseMs,
              metadataIndexBuildMs: index.maxBlockingPauseMs,
              indexProjectionMs: projection.maxBlockingPauseMs,
              visiblePathEnumerationMs: visibleFiles.maxBlockingPauseMs,
              incrementalTouch100Ms: incremental.touch100.maxBlockingPauseMs,
              incrementalAdd100Ms: incremental.add100.maxBlockingPauseMs,
              incrementalDelete100Ms: incremental.delete100.maxBlockingPauseMs,
            },
            heartbeatTicks: [
              bootstrap.heartbeatTicks,
              index.heartbeatTicks,
              projection.heartbeatTicks,
              visibleFiles.heartbeatTicks,
              incremental.touch100.heartbeatTicks,
              incremental.add100.heartbeatTicks,
              incremental.delete100.heartbeatTicks,
            ].reduce((sum, value) => sum + value, 0),
          },
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await watcher?.close();
  }
}

async function main(): Promise<void> {
  await run(parseOptions(process.argv.slice(2)));
}

if (
  process.argv[1]?.endsWith("vault-scale-kernel.cjs") ||
  process.argv[1]?.endsWith("vault-scale-kernel.ts")
) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
