import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const vaultScaleSchemaVersion = 1;
export const vaultScaleGeneratorVersion = "1.0.0";
export const vaultScaleSeed = 0x54_48_52_44;

export type VaultScaleVariant = "full" | "notes-only";

const manifestFileName = "manifest.json";
const noteCount = 21_145;
const hiddenFileCount = 1_024;

const fullExtensionCounts: Readonly<Record<string, number>> = {
  ".js": 68_000,
  ".ts": 34_000,
  ".map": 28_000,
  ".json": 23_000,
  "[none]": 11_000,
  ".mdx": 9_600,
  ".mjs": 4_500,
  ".png": 4_300,
  misc: 4_181,
};

const visibleExtensionCounts: Readonly<Record<string, number>> = {
  ...fullExtensionCounts,
  "[none]": (fullExtensionCounts["[none]"] ?? 0) - hiddenFileCount,
};

const miscExtensions = [".css", ".svg", ".canvas", ".html", ".bin"] as const;
const miscExtensionCounts: Readonly<Record<(typeof miscExtensions)[number], number>> = {
  ".css": 1_200,
  ".svg": 900,
  ".canvas": 900,
  ".html": 700,
  ".bin": 481,
};

const noteSizeBuckets = [
  { label: "p50", count: 11_200, bytes: 10_240 },
  { label: "p90", count: 7_900, bytes: 37_888 },
  { label: "p99", count: 1_834, bytes: 156_672 },
  { label: "tail", count: 210, bytes: 0 },
  { label: "max", count: 1, bytes: 1_228_800 },
] as const;

const sampleNoteIndexes = [0, 11_199, 11_200, 19_099, 20_933, 20_934, 21_144] as const;
const sampleBallastIndexes = [0, 1_023, 10_000, 50_000, 100_000, 150_000, 186_580] as const;
const sampleHiddenIndexes = [0, 511, 1_023] as const;

export interface VaultScaleNoteSizeBucket {
  label: string;
  count: number;
  minimumBytes: number;
  maximumBytes: number;
}

export interface VaultScaleSampleFile {
  path: string;
  kind: "markdown" | "ballast" | "hidden";
  bytes: number;
  sha256: string;
}

export interface VaultScaleManifest {
  schemaVersion: typeof vaultScaleSchemaVersion;
  generatorVersion: typeof vaultScaleGeneratorVersion;
  seed: number;
  variant: VaultScaleVariant;
  fileCount: number;
  visibleFileCount: number;
  hiddenFileCount: number;
  markdownFileCount: number;
  ballastFileCount: number;
  totalBytes: number;
  extensionCounts: Record<string, number>;
  depthProfile: {
    minimum: number;
    maximum: number;
    p50: number;
    p90: number;
    atLeast10: number;
  };
  noteSizeDistribution: {
    p50Bytes: number;
    p90Bytes: number;
    p99Bytes: number;
    maximumBytes: number;
    buckets: VaultScaleNoteSizeBucket[];
  };
  mutationPaths: string[];
  sampleFiles: VaultScaleSampleFile[];
  sampleHash: string;
}

export interface VaultScaleCorpusWriteResult {
  outputDirectory: string;
  vaultPath: string;
  manifestPath: string;
  manifest: VaultScaleManifest;
}

interface FileDescriptor {
  path: string;
  kind: "markdown" | "ballast" | "hidden";
  extension: string;
  index: number;
  bytes: number;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function deepDirectory(root: string, index: number): string {
  const segments = [
    `Layer-${String(index % 8).padStart(2, "0")}`,
    `Branch-${String(Math.floor(index / 8) % 8).padStart(2, "0")}`,
    `Shelf-${String(Math.floor(index / 64) % 8).padStart(2, "0")}`,
    `Section-${String(Math.floor(index / 512) % 8).padStart(2, "0")}`,
    `Topic-${String(Math.floor(index / 4_096) % 8).padStart(2, "0")}`,
    `Area-${String(Math.floor(index / 32_768) % 8).padStart(2, "0")}`,
    `Cabinet-${String(Math.floor(index / 262_144) % 8).padStart(2, "0")}`,
    `Drawer-${String(Math.floor(index / 2_097_152) % 8).padStart(2, "0")}`,
    `Shard-${String(Math.floor(index / 512)).padStart(4, "0")}`,
  ];
  return path.posix.join(root, ...segments);
}

function notePath(index: number): string {
  return path.posix.join(
    deepDirectory("Notes", index),
    `Note-${String(index).padStart(5, "0")}.md`,
  );
}

function ballastPath(index: number, extension: string): string {
  const suffix = extension === "[none]" ? "" : extension;
  return path.posix.join(
    deepDirectory("Ballast", index),
    `File-${String(index).padStart(6, "0")}${suffix}`,
  );
}

function hiddenPath(index: number): string {
  return path.posix.join(
    ".hidden-cache",
    `Layer-${String(index % 8).padStart(2, "0")}`,
    `Bucket-${String(Math.floor(index / 8)).padStart(3, "0")}`,
    `Entry-${String(index).padStart(4, "0")}`,
  );
}

const tailBucketMinimumBytes = 174_080;

function tailBucketRampBytes(offset: number): number {
  const span = noteSizeBuckets[4].bytes - tailBucketMinimumBytes;
  return tailBucketMinimumBytes + Math.floor((offset * span) / noteSizeBuckets[3].count);
}

function noteSize(index: number): number {
  const p50End = noteSizeBuckets[0].count;
  const p90End = p50End + noteSizeBuckets[1].count;
  const p99End = p90End + noteSizeBuckets[2].count;
  const tailEnd = p99End + noteSizeBuckets[3].count;
  if (index < p50End) return noteSizeBuckets[0].bytes;
  if (index < p90End) return noteSizeBuckets[1].bytes;
  if (index < p99End) return noteSizeBuckets[2].bytes;
  if (index < tailEnd) return tailBucketRampBytes(index - p99End);
  return noteSizeBuckets[4].bytes;
}

function tailExtension(index: number): string {
  let remaining = index;
  for (const extension of miscExtensions) {
    const count = miscExtensionCounts[extension];
    if (remaining < count) return extension;
    remaining -= count;
  }
  throw new Error(`Miscellaneous ballast index is out of range: ${index}`);
}

function descriptorPlan(variant: VaultScaleVariant): FileDescriptor[] {
  const notes: FileDescriptor[] = Array.from({ length: noteCount }, (_, index) => ({
    path: notePath(index),
    kind: "markdown" as const,
    extension: ".md",
    index,
    bytes: noteSize(index),
  }));
  if (variant === "notes-only") return notes;

  const ballast: FileDescriptor[] = [];
  let index = 0;
  for (const [extension, count] of Object.entries(visibleExtensionCounts)) {
    if (extension === "misc") {
      for (let offset = 0; offset < count; offset += 1) {
        const actualExtension = tailExtension(offset);
        ballast.push({
          path: ballastPath(index, actualExtension),
          kind: "ballast",
          extension: actualExtension,
          index,
          bytes: ballastSize(actualExtension, index),
        });
        index += 1;
      }
      continue;
    }
    for (let offset = 0; offset < count; offset += 1) {
      ballast.push({
        path: ballastPath(index, extension),
        kind: "ballast",
        extension,
        index,
        bytes: ballastSize(extension, index),
      });
      index += 1;
    }
  }
  const hidden = Array.from({ length: hiddenFileCount }, (_, hiddenIndex) => ({
    path: hiddenPath(hiddenIndex),
    kind: "hidden" as const,
    extension: "[none]",
    index: hiddenIndex,
    bytes: ballastSize("[none]", hiddenIndex),
  }));
  return [...notes, ...ballast, ...hidden];
}

function ballastSize(extension: string, index: number): number {
  if (extension === ".map") return 512 + (index % 4) * 64;
  if (extension === ".json" || extension === ".canvas") return 256 + (index % 3) * 32;
  if (extension === ".png") return 192 + (index % 5) * 16;
  return 128 + (index % 7) * 16;
}

function noteContent(index: number, size: number): Buffer {
  const random = createRandom(vaultScaleSeed ^ index);
  const target = notePath((index + 1) % noteCount);
  const nextTarget = notePath((index + 7) % noteCount);
  const lines = [
    "---",
    `title: "Scale note ${String(index).padStart(5, "0")}"`,
    `status: ${index % 3 === 0 ? "active" : index % 3 === 1 ? "draft" : "reference"}`,
    "tags:",
    "  - threadleaf-scale",
    `  - scale/area-${index % 64}`,
    `aliases: ["Scale alias ${String(index).padStart(5, "0")}"]`,
    "---",
    `# Scale note ${String(index).padStart(5, "0")}`,
    `This byte-stable synthetic note is generated from seed ${vaultScaleSeed}.`,
    `The sample word is scale-${Math.floor(random() * 1_000_000)} and the index is ${index}.`,
    `Links: [[${target}|next]] and [[${nextTarget}|fanout]].`,
    index % 19 === 0 ? `Unresolved link: [[Missing/${index}]].` : "",
    index % 17 === 0 ? "#scale/periodic #scale/periodic" : "#scale/common",
    "## Body",
  ].filter(Boolean);
  const base = Buffer.from(`${lines.join("\n")}\n`, "utf8");
  if (base.length > size) {
    throw new Error(`Generated note base exceeds its size bucket: ${index}`);
  }
  const fillerLine = Buffer.from(
    `scale-padding-${String(index).padStart(5, "0")}-${Math.floor(random() * 1_000_000)}\n`,
    "utf8",
  );
  const padding = Buffer.alloc(size - base.length);
  for (let offset = 0; offset < padding.length; offset += 1) {
    padding[offset] = fillerLine[offset % fillerLine.length] ?? 0x20;
  }
  return Buffer.concat([base, padding]);
}

function ballastContent(descriptor: FileDescriptor): Buffer {
  const bytes = Buffer.alloc(descriptor.bytes);
  const extension = descriptor.extension;
  const magic =
    extension === ".png"
      ? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      : Buffer.from("threadleaf-scale\n", "utf8");
  magic.copy(bytes, 0, 0, Math.min(magic.length, bytes.length));
  const random = createRandom(vaultScaleSeed ^ descriptor.index ^ extension.length);
  for (let offset = magic.length; offset < bytes.length; offset += 1) {
    bytes[offset] = Math.floor(random() * 256);
  }
  return bytes;
}

function contentForDescriptor(descriptor: FileDescriptor): Buffer {
  return descriptor.kind === "markdown"
    ? noteContent(descriptor.index, descriptor.bytes)
    : ballastContent(descriptor);
}

function extensionCountsFor(variant: VaultScaleVariant): Record<string, number> {
  if (variant === "notes-only") return { ".md": noteCount };
  const namedExtensions: Record<string, number> = { ...fullExtensionCounts };
  delete namedExtensions.misc;
  return { ".md": noteCount, ...namedExtensions, ...miscExtensionCounts };
}

function depthOf(filePath: string): number {
  return filePath.split("/").length - 1;
}

function sampleDescriptors(
  variant: VaultScaleVariant,
  plan: readonly FileDescriptor[],
): FileDescriptor[] {
  const byPath = new Map(plan.map((descriptor) => [descriptor.path, descriptor]));
  const descriptors: FileDescriptor[] = [];
  for (const index of sampleNoteIndexes) {
    const descriptor = byPath.get(notePath(index));
    if (descriptor) descriptors.push(descriptor);
  }
  if (variant === "full") {
    for (const index of sampleBallastIndexes) {
      const descriptor = plan.find(
        (candidate) => candidate.kind === "ballast" && candidate.index === index,
      );
      if (descriptor) descriptors.push(descriptor);
    }
    for (const index of sampleHiddenIndexes) {
      const descriptor = byPath.get(hiddenPath(index));
      if (descriptor) descriptors.push(descriptor);
    }
  }
  return descriptors.sort((left, right) => compareStrings(left.path, right.path));
}

export function buildVaultScaleManifest(variant: VaultScaleVariant): VaultScaleManifest {
  const plan = descriptorPlan(variant);
  const totalBytes = plan.reduce((sum, descriptor) => sum + descriptor.bytes, 0);
  const depths = plan
    .map((descriptor) => depthOf(descriptor.path))
    .sort((left, right) => left - right);
  const noteDescriptors = plan.filter((descriptor) => descriptor.kind === "markdown");
  const sampleFiles = sampleDescriptors(variant, plan).map((descriptor) => ({
    path: descriptor.path,
    kind: descriptor.kind,
    bytes: descriptor.bytes,
    sha256: sha256(contentForDescriptor(descriptor)),
  }));
  const sampleHash = sha256(Buffer.from(canonicalJson(sampleFiles), "utf8"));
  const p50 = noteDescriptors[Math.floor((noteDescriptors.length - 1) * 0.5)]?.bytes ?? 0;
  const p90 = noteDescriptors[Math.ceil(noteDescriptors.length * 0.9) - 1]?.bytes ?? 0;
  const p99 = noteDescriptors[Math.ceil(noteDescriptors.length * 0.99) - 1]?.bytes ?? 0;
  return {
    schemaVersion: vaultScaleSchemaVersion,
    generatorVersion: vaultScaleGeneratorVersion,
    seed: vaultScaleSeed,
    variant,
    fileCount: plan.length,
    visibleFileCount: plan.filter((descriptor) => descriptor.kind !== "hidden").length,
    hiddenFileCount: plan.filter((descriptor) => descriptor.kind === "hidden").length,
    markdownFileCount: noteDescriptors.length,
    ballastFileCount: plan.filter((descriptor) => descriptor.kind !== "markdown").length,
    totalBytes,
    extensionCounts: extensionCountsFor(variant),
    depthProfile: {
      minimum: depths[0] ?? 0,
      maximum: depths.at(-1) ?? 0,
      p50: depths[Math.floor((depths.length - 1) * 0.5)] ?? 0,
      p90: depths[Math.ceil(depths.length * 0.9) - 1] ?? 0,
      atLeast10: depths.filter((depth) => depth >= 10).length,
    },
    noteSizeDistribution: {
      p50Bytes: p50,
      p90Bytes: p90,
      p99Bytes: p99,
      maximumBytes: Math.max(...noteDescriptors.map((descriptor) => descriptor.bytes)),
      buckets: noteSizeBuckets.map((bucket, index) =>
        index === 3
          ? {
              label: bucket.label,
              count: bucket.count,
              minimumBytes: tailBucketRampBytes(0),
              maximumBytes: tailBucketRampBytes(bucket.count - 1),
            }
          : {
              label: bucket.label,
              count: bucket.count,
              minimumBytes: bucket.bytes,
              maximumBytes: bucket.bytes,
            },
      ),
    },
    mutationPaths: Array.from({ length: 100 }, (_, index) => notePath(index + 32)),
    sampleFiles,
    sampleHash,
  };
}

async function writeDescriptors(
  vaultPath: string,
  descriptors: readonly FileDescriptor[],
): Promise<void> {
  const directories = new Set<string>();
  for (const descriptor of descriptors) {
    directories.add(path.dirname(path.join(vaultPath, ...descriptor.path.split("/"))));
  }
  for (const directory of [...directories].sort(compareStrings)) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  }
  const batchSize = 64;
  for (let start = 0; start < descriptors.length; start += batchSize) {
    const batch = descriptors.slice(start, start + batchSize);
    await Promise.all(
      batch.map(async (descriptor) => {
        const destination = path.join(vaultPath, ...descriptor.path.split("/"));
        await fs.writeFile(destination, contentForDescriptor(descriptor), { mode: 0o600 });
      }),
    );
  }
}

export async function writeVaultScaleCorpus(
  outputDirectory: string,
  variant: VaultScaleVariant,
): Promise<VaultScaleCorpusWriteResult> {
  const absoluteOutput = path.resolve(outputDirectory);
  const vaultPath = path.join(absoluteOutput, "vault");
  await fs.mkdir(absoluteOutput, { recursive: true, mode: 0o700 });
  const existing = await fs.readdir(absoluteOutput);
  if (existing.length > 0) {
    throw new Error(`Vault-scale output directory must be empty: ${absoluteOutput}`);
  }
  const manifest = buildVaultScaleManifest(variant);
  await fs.mkdir(vaultPath, { recursive: true, mode: 0o700 });
  await writeDescriptors(vaultPath, descriptorPlan(variant));
  const manifestPath = path.join(absoluteOutput, manifestFileName);
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { outputDirectory: absoluteOutput, vaultPath, manifestPath, manifest };
}

async function collectFiles(
  rootPath: string,
  relativeDirectory = "",
  result: string[] = [],
): Promise<string[]> {
  const absoluteDirectory = path.join(rootPath, ...relativeDirectory.split("/").filter(Boolean));
  const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => compareStrings(left.name, right.name))) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await collectFiles(rootPath, relativePath, result);
    } else if (entry.isFile()) {
      result.push(relativePath);
    }
  }
  return result;
}

export async function verifyVaultScaleCorpus(
  outputDirectory: string,
  expected: VaultScaleManifest,
): Promise<VaultScaleManifest> {
  const absoluteOutput = path.resolve(outputDirectory);
  const manifestPath = path.join(absoluteOutput, manifestFileName);
  const actual = JSON.parse(await fs.readFile(manifestPath, "utf8")) as VaultScaleManifest;
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`Generated vault-scale manifest differs for ${expected.variant}.`);
  }
  const files = await collectFiles(path.join(absoluteOutput, "vault"));
  if (files.length !== expected.fileCount) {
    throw new Error(`Expected ${expected.fileCount} files, found ${files.length}.`);
  }
  const extensionCounts: Record<string, number> = {};
  for (const filePath of files) {
    const extension = path.extname(filePath) || "[none]";
    extensionCounts[extension] = (extensionCounts[extension] ?? 0) + 1;
  }
  if (
    canonicalJson(Object.fromEntries(Object.entries(extensionCounts).sort())) !==
    canonicalJson(Object.fromEntries(Object.entries(expected.extensionCounts).sort()))
  ) {
    throw new Error("Generated vault-scale extension counts differ from the manifest.");
  }
  const noteSizes: number[] = [];
  let visibleFileCount = 0;
  let hiddenCount = 0;
  for (const filePath of files) {
    const hidden = filePath.split("/").some((segment) => segment.startsWith("."));
    if (hidden) hiddenCount += 1;
    else visibleFileCount += 1;
    if (filePath.endsWith(".md")) {
      noteSizes.push(
        (await fs.stat(path.join(absoluteOutput, "vault", ...filePath.split("/")))).size,
      );
    }
  }
  noteSizes.sort((left, right) => left - right);
  if (
    visibleFileCount !== expected.visibleFileCount ||
    hiddenCount !== expected.hiddenFileCount ||
    noteSizes.length !== expected.markdownFileCount ||
    noteSizes[Math.floor((noteSizes.length - 1) * 0.5)] !==
      expected.noteSizeDistribution.p50Bytes ||
    noteSizes[Math.ceil(noteSizes.length * 0.9) - 1] !== expected.noteSizeDistribution.p90Bytes ||
    noteSizes[Math.ceil(noteSizes.length * 0.99) - 1] !== expected.noteSizeDistribution.p99Bytes ||
    noteSizes.at(-1) !== expected.noteSizeDistribution.maximumBytes
  ) {
    throw new Error("Generated vault-scale note-size or visibility statistics differ.");
  }
  for (const sample of expected.sampleFiles) {
    const bytes = await fs.readFile(path.join(absoluteOutput, "vault", ...sample.path.split("/")));
    if (bytes.length !== sample.bytes || sha256(bytes) !== sample.sha256) {
      throw new Error(`Generated vault-scale sample differs: ${sample.path}`);
    }
  }
  return actual;
}

function parseVariant(value: string | undefined): VaultScaleVariant {
  if (value === "full" || value === "notes-only") return value;
  throw new Error("--variant must be full or notes-only.");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const valueAfter = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const variant = parseVariant(valueAfter("--variant") ?? "full");
  if (args.includes("--manifest")) {
    process.stdout.write(`${JSON.stringify(buildVaultScaleManifest(variant), null, 2)}\n`);
    return;
  }
  const outputDirectory = valueAfter("--output");
  if (!outputDirectory) throw new Error("--output is required.");
  if (args.includes("--verify")) {
    const manifest = await verifyVaultScaleCorpus(
      outputDirectory,
      buildVaultScaleManifest(variant),
    );
    process.stdout.write(`${JSON.stringify({ variant, verified: true, manifest }, null, 2)}\n`);
    return;
  }
  const result = await writeVaultScaleCorpus(outputDirectory, variant);
  process.stdout.write(
    `${JSON.stringify({ variant, generated: true, vaultPath: result.vaultPath, manifest: result.manifest }, null, 2)}\n`,
  );
}

if (
  process.argv[1]?.endsWith("vault-scale-corpus.cjs") ||
  process.argv[1]?.endsWith("vault-scale-corpus.ts")
) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
