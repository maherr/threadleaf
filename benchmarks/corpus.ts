import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const corpusSchemaVersion = 1;
export const corpusGeneratorVersion = "1.0.0";
export const corpusSeed = 0x71_72_65_61;

export type CorpusProfileName = "smoke" | "standard" | "large";

export interface CorpusProfile {
  name: CorpusProfileName;
  noteCount: number;
  folderCount: number;
  burstSize: number;
  longNoteCharacters: number;
}

export const corpusProfiles: Readonly<Record<CorpusProfileName, CorpusProfile>> = {
  smoke: {
    name: "smoke",
    noteCount: 64,
    folderCount: 8,
    burstSize: 8,
    longNoteCharacters: 4_096,
  },
  standard: {
    name: "standard",
    noteCount: 1_024,
    folderCount: 32,
    burstSize: 24,
    longNoteCharacters: 32_768,
  },
  large: {
    name: "large",
    noteCount: 10_000,
    folderCount: 100,
    burstSize: 64,
    longNoteCharacters: 131_072,
  },
};

export type CorpusFileKind = "markdown" | "attachment";

export interface CorpusManifestFile {
  path: string;
  kind: CorpusFileKind;
  bytes: number;
  sha256: string;
}

export interface CorpusManifest {
  schemaVersion: typeof corpusSchemaVersion;
  generatorVersion: typeof corpusGeneratorVersion;
  seed: number;
  profile: CorpusProfileName;
  noteCount: number;
  attachmentCount: number;
  totalBytes: number;
  files: CorpusManifestFile[];
  manifestHash: string;
}

export interface CorpusWriteResult {
  rootPath: string;
  manifest: CorpusManifest;
  mutationPaths: string[];
}

interface CorpusManifestRegistryEntry {
  profile: CorpusProfileName;
  seed: number;
  noteCount: number;
  attachmentCount: number;
  totalBytes: number;
  manifestHash: string;
}

interface CorpusManifestRegistry {
  schemaVersion: typeof corpusSchemaVersion;
  generatorVersion: typeof corpusGeneratorVersion;
  seed: number;
  profiles: Record<CorpusProfileName, CorpusManifestRegistryEntry>;
}

interface CorpusFileBytes {
  path: string;
  kind: CorpusFileKind;
  bytes: Buffer;
}

const manifestFileName = "corpus-manifest.json";
const attachmentNames = [
  "assets/reference-00.png",
  "assets/reference-01.jpg",
  "assets/reference-02.gif",
  "assets/reference-03.webp",
] as const;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

function manifestHash(manifest: Omit<CorpusManifest, "manifestHash">): string {
  return sha256(Buffer.from(canonicalJson(manifest), "utf8"));
}

function validateManifestRegistry(value: unknown): asserts value is CorpusManifestRegistry {
  if (!value || typeof value !== "object") {
    throw new Error("Checked-in benchmark corpus manifest registry is not an object.");
  }
  const registry = value as Partial<CorpusManifestRegistry>;
  if (
    registry.schemaVersion !== corpusSchemaVersion ||
    registry.generatorVersion !== corpusGeneratorVersion ||
    registry.seed !== corpusSeed ||
    !registry.profiles ||
    typeof registry.profiles !== "object"
  ) {
    throw new Error("Checked-in benchmark corpus manifest registry is unsupported.");
  }
  for (const profileName of ["smoke", "standard", "large"] as const) {
    const entry = registry.profiles[profileName];
    const profile = corpusProfiles[profileName];
    if (
      !entry ||
      entry.profile !== profileName ||
      entry.seed !== corpusSeed ||
      entry.noteCount !== profile.noteCount ||
      entry.attachmentCount !== attachmentNames.length ||
      !Number.isInteger(entry.totalBytes) ||
      entry.totalBytes < 1 ||
      !/^[a-f0-9]{64}$/.test(entry.manifestHash)
    ) {
      throw new Error(
        `Checked-in benchmark corpus manifest registry has an invalid ${profileName} entry.`,
      );
    }
  }
}

export async function loadExpectedCorpusManifestHash(
  registryPath: string,
  profileName: CorpusProfileName,
): Promise<string> {
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(registryPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Checked-in benchmark corpus manifest registry could not be read: ${String(error)}`,
    );
  }
  validateManifestRegistry(value);
  return value.profiles[profileName].manifestHash;
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

function randomWord(random: () => number, index: number): string {
  const words = [
    "atlas",
    "cinder",
    "delta",
    "ember",
    "fable",
    "gale",
    "harbor",
    "index",
    "juniper",
    "keystone",
    "lattice",
    "meadow",
    "north",
    "orbit",
    "pocket",
    "quartz",
    "river",
    "signal",
    "tide",
    "umber",
  ];
  return `${words[Math.floor(random() * words.length)]}-${String(index % 97).padStart(2, "0")}`;
}

function pathForNote(profile: CorpusProfile, index: number): string {
  if (index === 0) {
    return "Topics/Shared.md";
  }
  if (index === 1) {
    return "Archive/Shared.md";
  }
  if (index === 2) {
    return "Long/Corpus.md";
  }
  const folder = String(index % profile.folderCount).padStart(3, "0");
  const nested = String(Math.floor(index / profile.folderCount) % 7).padStart(2, "0");
  return `Notes/Section-${folder}/Cluster-${nested}/Note-${String(index).padStart(5, "0")}.md`;
}

function withoutExtension(filePath: string): string {
  return filePath.endsWith(".md") ? filePath.slice(0, -3) : filePath;
}

function noteContent(profile: CorpusProfile, index: number, random: () => number): string {
  const notePath = pathForNote(profile, index);
  const target = (offset: number): string =>
    withoutExtension(pathForNote(profile, (index + offset) % profile.noteCount));
  const status = index % 4 === 0 ? "active" : index % 4 === 1 ? "draft" : "reference";
  const tag = `benchmark/area-${index % profile.folderCount}`;
  const lines = [
    "---",
    `title: "${path.basename(notePath, ".md")}"`,
    `status: ${status}`,
    "tags:",
    "  - benchmark",
    `  - ${tag}`,
    `aliases: ["Alias ${String(index).padStart(5, "0")}"]`,
    "---",
    `# ${path.basename(notePath, ".md")} heading`,
    `This deterministic note belongs to the public ${profile.name} corpus.`,
    `It has a stable sample word ${randomWord(random, index)} and #inline/area-${index % 11}.`,
    `Related note: [[${target(1)}|next]] and embedded note ![[${target(2)}]].`,
    `Backlink fanout: [[${target(7)}]] [[${target(13)}]]`,
    index % 7 === 0 ? "Ambiguous name probe: [[Shared]]." : "",
    index % 11 === 0 ? `Unresolved probe: [[Missing/Target-${index}]].` : "",
    index % 17 === 0 ? `Markdown link probe: [linked](<${target(19)}.md>).` : "",
    "## Detail heading",
    `The corpus keeps links, backlinks, tags, properties, headings, and nested folders visible for index tests (${index}).`,
  ];
  if (index === 2) {
    const repeated =
      "Long corpus search material carries a stable lighthouse needle token for bounded query checks. ";
    const body = repeated.repeat(Math.ceil(profile.longNoteCharacters / repeated.length));
    lines.push(body.slice(0, profile.longNoteCharacters));
    lines.push("Unique marker: singular-lighthouse.");
  }
  return `${lines.filter((line) => line.length > 0).join("\n")}\n`;
}

function attachmentBytes(name: string, index: number): Buffer {
  const magic: Record<string, number[]> = {
    ".png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    ".jpg": [0xff, 0xd8, 0xff, 0xe0],
    ".gif": [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
    ".webp": [0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50],
  };
  const extension = path.extname(name);
  const bytes = Buffer.alloc(128 + index * 7);
  for (const [offset, value] of (magic[extension] ?? []).entries()) {
    bytes[offset] = value;
  }
  for (let offset = magic[extension]?.length ?? 0; offset < bytes.length; offset += 1) {
    bytes[offset] = (offset * 31 + index * 17 + 0x5a) % 256;
  }
  return bytes;
}

export function corpusProfile(name: CorpusProfileName): CorpusProfile {
  return { ...corpusProfiles[name] };
}

export function corpusFilePaths(profileName: CorpusProfileName): string[] {
  const profile = corpusProfiles[profileName];
  return Array.from({ length: profile.noteCount }, (_, index) => pathForNote(profile, index));
}

export function buildCorpusFiles(profileName: CorpusProfileName): CorpusFileBytes[] {
  const profile = corpusProfiles[profileName];
  const random = createRandom(corpusSeed ^ profile.noteCount);
  const notes = Array.from({ length: profile.noteCount }, (_, index) => ({
    path: pathForNote(profile, index),
    kind: "markdown" as const,
    bytes: Buffer.from(noteContent(profile, index, random), "utf8"),
  }));
  const attachments = attachmentNames.map((attachmentPath, index) => ({
    path: attachmentPath,
    kind: "attachment" as const,
    bytes: attachmentBytes(attachmentPath, index),
  }));
  return [...notes, ...attachments].sort((left, right) => compareStrings(left.path, right.path));
}

function buildManifest(profileName: CorpusProfileName, files: CorpusFileBytes[]): CorpusManifest {
  const profile = corpusProfiles[profileName];
  const entries = files
    .map(({ path: filePath, kind, bytes }) => ({
      path: filePath,
      kind,
      bytes: bytes.length,
      sha256: sha256(bytes),
    }))
    .sort((left, right) => compareStrings(left.path, right.path));
  const withoutHash: Omit<CorpusManifest, "manifestHash"> = {
    schemaVersion: corpusSchemaVersion,
    generatorVersion: corpusGeneratorVersion,
    seed: corpusSeed,
    profile: profileName,
    noteCount: profile.noteCount,
    attachmentCount: attachmentNames.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    files: entries,
  };
  return { ...withoutHash, manifestHash: manifestHash(withoutHash) };
}

export async function writeCorpus(
  rootPath: string,
  profileName: CorpusProfileName,
): Promise<CorpusWriteResult> {
  const files = buildCorpusFiles(profileName);
  await fs.mkdir(rootPath, { recursive: true, mode: 0o700 });
  const existing = await fs.readdir(rootPath);
  if (existing.length > 0) {
    throw new Error("Benchmark corpus target must be empty.");
  }
  for (const file of files) {
    const destination = path.join(rootPath, ...file.path.split("/"));
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.writeFile(destination, file.bytes, { mode: 0o600 });
  }
  const manifest = buildManifest(profileName, files);
  await fs.writeFile(
    path.join(rootPath, manifestFileName),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  return {
    rootPath,
    manifest,
    mutationPaths: corpusFilePaths(profileName).slice(3, 3 + corpusProfiles[profileName].burstSize),
  };
}

async function listFiles(rootPath: string, relativeDirectory = ""): Promise<string[]> {
  const directory = path.join(rootPath, ...relativeDirectory.split("/").filter(Boolean));
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => compareStrings(left.name, right.name))) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(rootPath, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

function validateManifestShape(value: unknown): asserts value is CorpusManifest {
  if (!value || typeof value !== "object") {
    throw new Error("Benchmark corpus manifest is not an object.");
  }
  const manifest = value as Partial<CorpusManifest>;
  if (
    manifest.schemaVersion !== corpusSchemaVersion ||
    manifest.generatorVersion !== corpusGeneratorVersion ||
    typeof manifest.manifestHash !== "string" ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error("Benchmark corpus manifest schema is unsupported.");
  }
}

export async function verifyCorpus(
  rootPath: string,
  expectedManifestHash?: string,
): Promise<CorpusManifest> {
  const manifestPath = path.join(rootPath, manifestFileName);
  let manifest: CorpusManifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as CorpusManifest;
  } catch (error) {
    throw new Error(`Benchmark corpus manifest could not be read: ${String(error)}`);
  }
  validateManifestShape(manifest);
  const { manifestHash: actualHash, ...withoutHash } = manifest;
  if (manifestHash(withoutHash) !== actualHash) {
    throw new Error("Benchmark corpus manifest hash does not match its contents.");
  }
  if (expectedManifestHash && actualHash !== expectedManifestHash) {
    throw new Error("Benchmark corpus manifest differs from the checked-in public manifest.");
  }
  const listed = new Set<string>();
  let totalBytes = 0;
  for (const entry of manifest.files) {
    if (path.posix.isAbsolute(entry.path) || entry.path.includes("..")) {
      throw new Error("Benchmark corpus manifest contains an unsafe path.");
    }
    if (listed.has(entry.path)) {
      throw new Error(`Benchmark corpus manifest repeats ${entry.path}.`);
    }
    listed.add(entry.path);
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(path.join(rootPath, ...entry.path.split("/")));
    } catch {
      throw new Error(`Benchmark corpus is missing ${entry.path}.`);
    }
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
      throw new Error(`Benchmark corpus bytes changed for ${entry.path}.`);
    }
    totalBytes += bytes.length;
  }
  if (totalBytes !== manifest.totalBytes) {
    throw new Error("Benchmark corpus byte total does not match its manifest.");
  }
  const actualFiles = (await listFiles(rootPath)).filter(
    (filePath) => filePath !== manifestFileName,
  );
  const expectedFiles = [...listed].sort(compareStrings);
  if (
    actualFiles.length !== expectedFiles.length ||
    actualFiles.some((filePath, index) => filePath !== expectedFiles[index])
  ) {
    throw new Error("Benchmark corpus file set differs from its manifest.");
  }
  if (manifest.files.filter((file) => file.kind === "markdown").length !== manifest.noteCount) {
    throw new Error("Benchmark corpus note count is inconsistent.");
  }
  if (
    manifest.files.filter((file) => file.kind === "attachment").length !== manifest.attachmentCount
  ) {
    throw new Error("Benchmark corpus attachment count is inconsistent.");
  }
  return manifest;
}

export function corpusManifestSummary(manifest: CorpusManifest) {
  return {
    profile: manifest.profile,
    seed: manifest.seed,
    noteCount: manifest.noteCount,
    attachmentCount: manifest.attachmentCount,
    totalBytes: manifest.totalBytes,
    manifestHash: manifest.manifestHash,
  };
}
