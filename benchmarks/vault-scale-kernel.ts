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

function parseOptions(argv: readonly string[]): KernelOptions {
  const valueAfter = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const variant = valueAfter("--variant");
  if (variant !== "full" && variant !== "notes-only") {
    throw new Error("--variant must be full or notes-only.");
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

async function writeMarker(
  vaultPath: string,
  originals: ReadonlyMap<string, Buffer>,
  marker: string,
): Promise<void> {
  for (const [relativePath, bytes] of originals) {
    const next = Buffer.concat([bytes, Buffer.from(`\n${marker}\n`, "utf8")]);
    await fs.writeFile(path.join(vaultPath, ...relativePath.split("/")), next);
  }
}

async function restoreOriginals(
  vaultPath: string,
  originals: ReadonlyMap<string, Buffer>,
): Promise<void> {
  for (const [relativePath, bytes] of originals) {
    await fs.writeFile(path.join(vaultPath, ...relativePath.split("/")), bytes);
  }
}

async function measureIncremental(
  kernel: VaultKernel,
  baselineSnapshot: Awaited<ReturnType<typeof captureVaultBootstrap>>,
  baselineIndex: VaultIndexReactor,
  vaultPath: string,
  manifest: VaultScaleManifest,
): Promise<{
  singleFile: TimedOperation<{ changeCount: number; indexGeneration: number }>;
  batch100: TimedOperation<{ changeCount: number; indexGeneration: number }>;
}> {
  const singlePath = manifest.mutationPaths[0];
  if (!singlePath) throw new Error("The scale manifest has no single-file mutation path.");
  const singleOriginals = await readOriginals(vaultPath, [singlePath]);
  const singleMarker = `threadleaf-vault-scale-single-${manifest.variant}`;
  const singleWatcher = NodeVaultWatcher.fromSnapshot(kernel.paths, baselineSnapshot.snapshot, {
    streamId: `vault-scale-${manifest.variant}-single`,
  });
  const singleResult = await measure(async () => {
    await writeMarker(vaultPath, singleOriginals, singleMarker);
    const batch = await singleWatcher.scanNow();
    if (!batch) throw new Error("The single-file mutation did not produce a watcher change.");
    await baselineIndex.accept(batch);
    const result = baselineIndex.index.search(singleMarker);
    if (result.results.length !== 1) {
      throw new Error("The single-file mutation did not converge in the metadata index.");
    }
    return { changeCount: batch.changes.length, indexGeneration: baselineIndex.index.generation };
  });
  await restoreOriginals(vaultPath, singleOriginals);
  await singleWatcher.close();

  const batchPaths = manifest.mutationPaths.slice(0, 100);
  const batchOriginals = await readOriginals(vaultPath, batchPaths);
  const batchMarker = `threadleaf-vault-scale-batch-${manifest.variant}`;
  const batchWatcher = NodeVaultWatcher.fromSnapshot(kernel.paths, baselineSnapshot.snapshot, {
    streamId: `vault-scale-${manifest.variant}-batch`,
  });
  const batchResult = await measure(async () => {
    await writeMarker(vaultPath, batchOriginals, batchMarker);
    const batch = await batchWatcher.scanNow();
    if (!batch || batch.changes.length !== batchPaths.length) {
      throw new Error(
        `The 100-file mutation produced ${batch?.changes.length ?? 0} changes instead of ${batchPaths.length}.`,
      );
    }
    await baselineIndex.accept(batch);
    const result = baselineIndex.index.search(batchMarker);
    if (result.results.length < 50) {
      throw new Error("The 100-file mutation did not converge in the metadata index.");
    }
    return { changeCount: batch.changes.length, indexGeneration: baselineIndex.index.generation };
  });
  await restoreOriginals(vaultPath, batchOriginals);
  await batchWatcher.close();
  return { singleFile: singleResult, batch100: batchResult };
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
    const totalReadinessMs = performance.now() - started;
    const eventLoopPauses = [
      bootstrap.maxBlockingPauseMs,
      index.maxBlockingPauseMs,
      projection.maxBlockingPauseMs,
      visibleFiles.maxBlockingPauseMs,
      incremental.singleFile.maxBlockingPauseMs,
      incremental.batch100.maxBlockingPauseMs,
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
            incrementalSingleMs: incremental.singleFile.durationMs,
            incrementalBatch100Ms: incremental.batch100.durationMs,
          },
          incremental: {
            singleFile: incremental.singleFile.value,
            batch100: incremental.batch100.value,
          },
          memory: {
            nodePeakRssBytes: Math.max(
              kernelOpen.peakRssBytes,
              bootstrap.peakRssBytes,
              index.peakRssBytes,
              projection.peakRssBytes,
              visibleFiles.peakRssBytes,
              incremental.singleFile.peakRssBytes,
              incremental.batch100.peakRssBytes,
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
              incrementalSingleMs: incremental.singleFile.maxBlockingPauseMs,
              incrementalBatch100Ms: incremental.batch100.maxBlockingPauseMs,
            },
            heartbeatTicks: [
              bootstrap.heartbeatTicks,
              index.heartbeatTicks,
              projection.heartbeatTicks,
              visibleFiles.heartbeatTicks,
              incremental.singleFile.heartbeatTicks,
              incremental.batch100.heartbeatTicks,
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

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
