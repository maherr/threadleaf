import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { WorkspaceRuntime } from "../src/application/workspace-runtime";
import { MetadataIndex, VaultIndexReactor } from "../src/kernel/metadata-index";
import { NodeVaultWatcher } from "../src/kernel/node-vault-watcher";
import { VaultPathPolicy } from "../src/kernel/path-policy";
import { FixedStateRoot } from "../src/kernel/ports";
import { VaultKernel } from "../src/kernel/vault-kernel";
import { benchmarkBudgetRules } from "./budgets";
import {
  corpusManifestSummary,
  corpusProfile,
  loadExpectedCorpusManifestHash,
  verifyCorpus,
  writeCorpus,
} from "./corpus";
import {
  assertBudgetPasses,
  assertCorrectness,
  type BenchmarkBudgetResult,
  type BenchmarkCorrectnessCheck,
  type BenchmarkMetricSummary,
  type BenchmarkResult,
  evaluateBudgets,
  sha256Json,
  summarizeMetric,
} from "./results";

interface RunnerOptions {
  profile: "smoke" | "standard" | "large";
  warmups: number;
  samples: number;
  outputPath: string | null;
  enforceBudgets: boolean;
  integrityOnly: boolean;
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function parseOptions(argv: readonly string[]): RunnerOptions {
  const options: RunnerOptions = {
    profile: "large",
    warmups: 2,
    samples: 11,
    outputPath: null,
    enforceBudgets: false,
    integrityOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument || argument === "--") {
      continue;
    }
    if (argument === "--profile") {
      const profile = argv[++index];
      if (profile !== "smoke" && profile !== "standard" && profile !== "large") {
        throw new Error("--profile must be smoke, standard, or large.");
      }
      options.profile = profile;
    } else if (argument === "--samples") {
      options.samples = parsePositiveInteger(argv[++index] ?? "", "--samples");
    } else if (argument === "--warmups") {
      options.warmups = parsePositiveInteger(argv[++index] ?? "", "--warmups");
    } else if (argument === "--output") {
      options.outputPath = argv[++index] ?? null;
      if (!options.outputPath) {
        throw new Error("--output needs a file path.");
      }
    } else if (argument === "--enforce-budgets") {
      options.enforceBudgets = true;
    } else if (argument === "--integrity") {
      options.integrityOnly = true;
    } else if (argument === "--help" || argument === "-h") {
      process.stdout.write(
        [
          "Usage: node runner.cjs [--profile smoke|standard|large] [--samples N] [--warmups N]",
          "                     [--output FILE] [--integrity] [--enforce-budgets]",
          "",
          "The default large profile is opt-in and emits JSON only. Timing budgets are evaluated",
          "only with --enforce-budgets. --integrity runs the lightweight corpus/index checks.",
          "",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (options.integrityOnly) {
    options.samples = 2;
    options.warmups = 1;
  }
  return options;
}

async function loadBaseline(profile: RunnerOptions["profile"]): Promise<{
  value: import("./results").BenchmarkBaseline;
  hash: string;
} | null> {
  try {
    const contents = await fs.readFile(
      path.join(process.cwd(), "benchmarks", "baseline.json"),
      "utf8",
    );
    const value = JSON.parse(contents) as import("./results").BenchmarkBaseline;
    if (value.profile !== profile) {
      return null;
    }
    return { value, hash: sha256Json(value) };
  } catch {
    return null;
  }
}

function check(
  checks: BenchmarkCorrectnessCheck[],
  name: string,
  passed: boolean,
  details: string,
): void {
  checks.push({ name, status: passed ? "pass" : "fail", details });
}

async function measure(
  name: string,
  operation: () => Promise<void> | void,
  options: RunnerOptions,
  details?: Record<string, number | string | boolean>,
): Promise<BenchmarkMetricSummary> {
  const warmupSamples: number[] = [];
  for (let index = 0; index < options.warmups; index += 1) {
    const started = performance.now();
    await operation();
    warmupSamples.push(performance.now() - started);
  }
  const samples: number[] = [];
  for (let index = 0; index < options.samples; index += 1) {
    const started = performance.now();
    await operation();
    samples.push(performance.now() - started);
  }
  return summarizeMetric(name, "milliseconds", warmupSamples, samples, details);
}

async function runCorrectness(
  rootPath: string,
  profileName: RunnerOptions["profile"],
  expectedManifestHash: string,
): Promise<{
  manifest: Awaited<ReturnType<typeof verifyCorpus>>;
  checks: BenchmarkCorrectnessCheck[];
}> {
  const checks: BenchmarkCorrectnessCheck[] = [];
  let manifest: Awaited<ReturnType<typeof verifyCorpus>>;
  try {
    manifest = await verifyCorpus(rootPath, expectedManifestHash);
    check(checks, "corpus-manifest", true, "Manifest hash and every generated file match.");
  } catch (error) {
    check(checks, "corpus-manifest", false, error instanceof Error ? error.message : String(error));
    throw error;
  }

  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-benchmark-state-"));
  try {
    const policy = await VaultPathPolicy.open(rootPath);
    const kernel = await VaultKernel.open({
      vaultRoot: rootPath,
      stateRoot: new FixedStateRoot(stateRoot),
      readOnly: true,
    });
    const index = await MetadataIndex.build(kernel);
    const snapshot = index.snapshot();
    check(
      checks,
      "index-note-count",
      snapshot.documents.length === manifest.noteCount,
      `${snapshot.documents.length} indexed notes, expected ${manifest.noteCount}.`,
    );
    check(
      checks,
      "index-links-and-backlinks",
      snapshot.documents.some((document) =>
        document.links.some((link) => link.resolution.status === "resolved"),
      ) && snapshot.backlinks.some((entry) => entry.sources.length > 0),
      "Resolved links and backlinks are present.",
    );
    check(
      checks,
      "index-unresolved-and-ambiguous",
      snapshot.documents.some((document) =>
        document.links.some((link) => link.resolution.status === "unresolved"),
      ) && snapshot.duplicateNames.length > 0,
      "Unresolved links and duplicate-name ambiguity are represented.",
    );
    check(
      checks,
      "index-structure",
      snapshot.documents.some((document) => document.headings.length > 0) &&
        snapshot.documents.some((document) => Object.keys(document.properties).length > 0) &&
        snapshot.documents.some((document) => document.tags.length > 0),
      "Headings, frontmatter properties, and tags are indexed.",
    );
    const longNote = await kernel.readText("Long/Corpus.md");
    check(
      checks,
      "long-note-search-corpus",
      longNote.content.length >= corpusProfile(profileName).longNoteCharacters &&
        index.search("singular-lighthouse").total === 1,
      "The long note and rare search marker are present.",
    );
    const attachmentCount = manifest.files.filter((file) => file.kind === "attachment").length;
    check(
      checks,
      "attachment-metadata",
      attachmentCount === 4 && manifest.attachmentCount === 4,
      `${attachmentCount} deterministic attachment metadata entries are present.`,
    );
    check(
      checks,
      "policy-visible-markdown-set",
      (await policy.listMarkdownPaths()).length === manifest.noteCount,
      "Vault path policy exposes exactly the generated Markdown corpus.",
    );
    assertCorrectness(checks);
    return { manifest, checks };
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
}

async function runBenchmark(options: RunnerOptions): Promise<BenchmarkResult> {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-scale-benchmark-"));
  try {
    return await runBenchmarkInRoot(options, testRoot);
  } finally {
    await fs.rm(testRoot, { recursive: true, force: true });
  }
}

async function runBenchmarkInRoot(
  options: RunnerOptions,
  testRoot: string,
): Promise<BenchmarkResult> {
  const vaultPath = path.join(testRoot, "vault");
  const statePath = path.join(testRoot, "state");
  const generated = await writeCorpus(vaultPath, options.profile);
  const expectedManifestHash = await loadExpectedCorpusManifestHash(
    path.join(process.cwd(), "benchmarks", "corpus-manifests.json"),
    options.profile,
  );
  const { manifest, checks } = await runCorrectness(
    vaultPath,
    options.profile,
    expectedManifestHash,
  );
  if (options.integrityOnly) {
    const result: BenchmarkResult = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      profile: options.profile,
      corpus: corpusManifestSummary(manifest),
      runtime: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpuCount: os.cpus().length,
        electron: process.versions.electron ?? null,
      },
      configuration: {
        warmups: options.warmups,
        samples: options.samples,
        tailStatistic: "p90",
      },
      correctness: checks,
      metrics: [],
      memoryObservation: {
        rssBytes: process.memoryUsage().rss,
        heapUsedBytes: process.memoryUsage().heapUsed,
        note: "Integrity-only run; memory is not a timing or regression gate.",
      },
      budgets: { evaluated: false, baselineHash: null, checks: [] },
      limitations: [
        "Integrity-only mode does not measure timings or Electron window readiness.",
        "Attachment entries are metadata fixtures; image decoding is outside this benchmark.",
      ],
    };
    return result;
  }

  const kernel = await VaultKernel.open({
    vaultRoot: vaultPath,
    stateRoot: new FixedStateRoot(statePath),
    readOnly: true,
  });
  const metrics: BenchmarkMetricSummary[] = [];
  metrics.push(
    await measure(
      "metadata-index-rebuild",
      async () => {
        await MetadataIndex.build(kernel);
      },
      options,
      { noteCount: manifest.noteCount },
    ),
  );
  metrics.push(
    await measure(
      "workspace-runtime-activation",
      async () => {
        const runtime = await WorkspaceRuntime.open({
          vaultRoot: vaultPath,
          stateRoot: new FixedStateRoot(statePath),
        });
        await runtime.close();
      },
      options,
      {
        noteCount: manifest.noteCount,
        seam: "kernel-watcher-index-plugin-host-without-electron-window",
      },
    ),
  );

  const reactor = await VaultIndexReactor.open(kernel);
  const watcher = await NodeVaultWatcher.open(vaultPath, {
    debounceMs: 0,
    streamId: `benchmark-${options.profile}`,
  });
  const policy = await VaultPathPolicy.open(vaultPath);
  const originalBurstContent = new Map<string, string>();
  for (const relativePath of generated.mutationPaths) {
    originalBurstContent.set(
      relativePath,
      await fs.readFile(policy.resolveLexical(relativePath), "utf8"),
    );
  }
  let burstIteration = 0;
  try {
    metrics.push(
      await measure(
        "watcher-burst-incremental-index",
        async () => {
          burstIteration += 1;
          await Promise.all(
            generated.mutationPaths.map(async (relativePath) => {
              const original = originalBurstContent.get(relativePath);
              if (original === undefined) {
                throw new Error(`Missing benchmark mutation source ${relativePath}.`);
              }
              const content = `${original}\nBurst sample ${burstIteration} marker ${"x".repeat(burstIteration % 9)}.\n`;
              await fs.writeFile(policy.resolveLexical(relativePath), content, { mode: 0o600 });
            }),
          );
          const batch = await watcher.scanNow();
          if (!batch) {
            throw new Error("Watcher burst produced no change batch.");
          }
          await reactor.accept(batch);
        },
        options,
        { changedNotes: generated.mutationPaths.length },
      ),
    );
  } finally {
    await watcher.close();
  }

  metrics.push(
    await measure(
      "search-rare-query",
      () => {
        reactor.index.search("singular-lighthouse", 20);
      },
      options,
      { queryClass: "rare", limit: 20 },
    ),
  );
  metrics.push(
    await measure(
      "search-broad-query",
      () => {
        reactor.index.search("deterministic corpus", 50);
      },
      options,
      { queryClass: "broad", limit: 50 },
    ),
  );

  const baseline = await loadBaseline(options.profile);
  if (options.enforceBudgets && !baseline) {
    throw new Error(`No checked-in ${options.profile} benchmark baseline is available.`);
  }
  const budgetChecks: BenchmarkBudgetResult[] = baseline
    ? evaluateBudgets(metrics, baseline.value, benchmarkBudgetRules)
    : benchmarkBudgetRules.map((rule) => ({
        metric: rule.metric,
        status: "skipped" as const,
        reason: "No checked-in baseline is available.",
      }));
  const result: BenchmarkResult = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    profile: options.profile,
    corpus: corpusManifestSummary(manifest),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpuCount: os.cpus().length,
      electron: process.versions.electron ?? null,
    },
    configuration: {
      warmups: options.warmups,
      samples: options.samples,
      tailStatistic: "p90",
    },
    correctness: checks,
    metrics,
    memoryObservation: {
      rssBytes: process.memoryUsage().rss,
      heapUsedBytes: process.memoryUsage().heapUsed,
      note: "Single-process post-run observation; host-dependent and not a regression gate.",
    },
    budgets: {
      evaluated: options.enforceBudgets,
      baselineHash: baseline?.hash ?? null,
      checks: options.enforceBudgets
        ? budgetChecks
        : budgetChecks.map((check) => ({
            ...check,
            status: "skipped" as const,
            reason: "Timing enforcement is opt-in.",
          })),
    },
    limitations: [
      "Timing budgets compare p50 and p90 against a checked-in same-profile reference; they are not universal SLAs.",
      "The workspace activation metric measures the kernel, watcher, index, and plugin-host seam without an Electron window or renderer paint.",
      "The watcher metric uses deterministic external file replacements and includes scan and incremental index reconciliation, not OS notification delivery latency.",
      "Attachment entries cover deterministic metadata and bytes; image decoding is not timed here.",
      "Plugin activation and editor keystroke latency are omitted because their stable production seams require an Electron renderer.",
    ],
  };
  if (options.enforceBudgets) {
    assertBudgetPasses(budgetChecks);
  }
  return result;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  try {
    const result = await runBenchmark(options);
    const output = `${JSON.stringify(result, null, 2)}\n`;
    if (options.outputPath) {
      await fs.mkdir(path.dirname(path.resolve(options.outputPath)), { recursive: true });
      await fs.writeFile(options.outputPath, output, { mode: 0o600 });
    }
    process.stdout.write(output);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

void main();
