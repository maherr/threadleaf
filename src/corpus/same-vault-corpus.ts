import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MutableJsonCanvas,
  parseJsonCanvas,
  serializeJsonCanvas,
} from "../application/json-canvas";
import { loadVaultNoteEmbed } from "../application/note-embed-service";
import { moveMarkdownNote } from "../application/note-move";
import {
  applyNotePropertySet,
  inspectMarkdownNoteProperties,
} from "../application/note-properties";
import { runCli } from "../cli/command-line";
import type { LinkMetadata } from "../kernel/metadata-index";
import { MetadataIndex } from "../kernel/metadata-index";
import { FixedStateRoot } from "../kernel/ports";
import { VaultKernel } from "../kernel/vault-kernel";

interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
}

interface CorpusManifest {
  schemaVersion: number;
  corpusId: string;
  root: string;
  files: ManifestFile[];
}

interface CorpusCase {
  id: string;
  category: string;
  support: "supported" | "unsupported";
  surface: string;
  source: { files: string[] | "manifest" };
  operation: Record<string, unknown>;
  expected: Record<string, unknown>;
  allowedVariance: string[];
}

interface CorpusCases {
  schemaVersion: number;
  corpusId: string;
  license: string;
  canonicalRoot: string;
  manifest: string;
  cases: CorpusCase[];
}

interface JsonSuccess {
  schemaVersion: number;
  ok: true;
  command: string;
  data: Record<string, unknown>;
}

interface CliCapture {
  code: number;
  stdout: string;
  stderr: string;
}

interface TreeSnapshot {
  files: Map<string, Buffer>;
}

const corpusDirectory = path.resolve(process.cwd(), "fixtures/corpus/same-vault-v1");
const canonicalVault = path.join(corpusDirectory, "vault");
const requiredCaseIds = [
  "links.resolution-and-anchors",
  "links.unicode-and-case",
  "aliases.frontmatter-and-cli",
  "embeds.heading-block-and-failure",
  "attachments.exact-byte-roundtrip",
  "frontmatter.typed-and-malformed",
  "rename.rewrite-and-exclusion",
  "rename.ambiguous-refusal",
  "canvas.byte-preservation",
  "obsidian.read-only-coexistence",
  "external.atomic-edit-conflict",
  "roundtrip.every-canonical-byte",
  "canvas.editing-roundtrip",
] as const;

function fail(message: string): never {
  throw new Error(`same-vault corpus: ${message}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    fail(message);
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  assert(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  assert(Array.isArray(value), `${label} must be an array`);
  return value;
}

function equalJson(left: unknown, right: unknown, label: string): void {
  assert(
    JSON.stringify(left) === JSON.stringify(right),
    `${label}: expected ${JSON.stringify(right)}, got ${JSON.stringify(left)}`,
  );
}

async function readJson<T>(filePath: string): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    fail(`could not parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function renderManifest(files: readonly ManifestFile[]): string {
  return [
    "{",
    '  "schemaVersion": 1,',
    '  "corpusId": "threadleaf.same-vault.v1",',
    '  "root": "vault",',
    '  "files": [',
    ...files.map(
      (entry, index) =>
        `    {"path": ${JSON.stringify(entry.path)}, "size": ${entry.size}, "sha256": ${JSON.stringify(entry.sha256)}}${index + 1 === files.length ? "" : ","}`,
    ),
    "  ]",
    "}",
    "",
  ].join("\n");
}

async function walkFiles(root: string, relative = ""): Promise<string[]> {
  const absolute = path.join(root, relative);
  const entries = await fs.readdir(absolute, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      fail(`symlink is not allowed in canonical corpus: ${entryRelative}`);
    }
    if (entry.isDirectory()) {
      result.push(...(await walkFiles(root, entryRelative)));
    } else if (entry.isFile()) {
      result.push(entryRelative);
    } else {
      fail(`non-regular canonical corpus entry: ${entryRelative}`);
    }
  }
  return result;
}

async function snapshotTree(root: string): Promise<TreeSnapshot> {
  const files = new Map<string, Buffer>();
  for (const relative of await walkFiles(root)) {
    files.set(relative, await fs.readFile(path.join(root, relative)));
  }
  return { files };
}

function assertTreesEqual(before: TreeSnapshot, after: TreeSnapshot, label: string): void {
  equalJson([...before.files.keys()].sort(), [...after.files.keys()].sort(), `${label} file set`);
  for (const [relative, bytes] of before.files) {
    equalJson(
      after.files.get(relative)?.toString("hex"),
      bytes.toString("hex"),
      `${label} ${relative}`,
    );
  }
}

function assertNoVaultPrivateWrites(snapshot: TreeSnapshot, label: string): void {
  for (const relative of snapshot.files.keys()) {
    const privateSegment = relative
      .split("/")
      .find(
        (segment) =>
          segment === ".git" || segment === ".trash" || segment.startsWith(".threadleaf-"),
      );
    assert(!privateSegment, `${label} created an unexpected private vault segment: ${relative}`);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertManifestShape(manifest: CorpusManifest): void {
  assert(manifest.schemaVersion === 1, "manifest schemaVersion must be 1");
  assert(manifest.corpusId === "threadleaf.same-vault.v1", "manifest corpusId is stale");
  assert(manifest.root === "vault", "manifest root must be vault");
  const paths = manifest.files.map((entry) => entry.path);
  equalJson(
    paths,
    [...paths].sort((left, right) => left.localeCompare(right, "en")),
    "manifest ordering",
  );
  assert(new Set(paths).size === paths.length, "manifest contains duplicate paths");
  for (const entry of manifest.files) {
    assert(
      entry.path === entry.path.replaceAll("\\", "/"),
      `manifest path is not portable: ${entry.path}`,
    );
    assert(
      !entry.path.startsWith("/") && !entry.path.split("/").includes(".."),
      `manifest path escapes root: ${entry.path}`,
    );
    assert(Number.isSafeInteger(entry.size) && entry.size >= 0, `invalid size for ${entry.path}`);
    assert(/^[a-f0-9]{64}$/.test(entry.sha256), `invalid hash for ${entry.path}`);
  }
}

async function verifyManifest(manifest: CorpusManifest): Promise<TreeSnapshot> {
  assertManifestShape(manifest);
  const actual = await snapshotTree(canonicalVault);
  const actualPaths = [...actual.files.keys()].sort((left, right) =>
    left.localeCompare(right, "en"),
  );
  const manifestPaths = manifest.files.map((entry) => entry.path);
  equalJson(actualPaths, manifestPaths, "manifest file inventory");
  const manifestBytes = await fs.readFile(path.join(corpusDirectory, "manifest.json"), "utf8");
  equalJson(manifestBytes, renderManifest(manifest.files), "manifest regeneration bytes");
  for (const entry of manifest.files) {
    const bytes = actual.files.get(entry.path);
    assert(bytes, `manifest file is missing: ${entry.path}`);
    assert(bytes.length === entry.size, `manifest size is stale for ${entry.path}`);
    assert(sha256(bytes) === entry.sha256, `manifest hash is stale for ${entry.path}`);
  }
  return actual;
}

function verifyCaseShape(corpusCases: CorpusCases, manifest: CorpusManifest): void {
  assert(corpusCases.schemaVersion === 1, "cases schemaVersion must be 1");
  assert(corpusCases.corpusId === manifest.corpusId, "cases and manifest corpus IDs differ");
  assert(corpusCases.license === "CC0-1.0", "cases must declare the fixture license");
  assert(corpusCases.canonicalRoot === "vault", "cases canonicalRoot must be vault");
  assert(corpusCases.manifest === "manifest.json", "cases must point at manifest.json");
  const ids = corpusCases.cases.map((entry) => entry.id);
  assert(new Set(ids).size === ids.length, "cases contain duplicate IDs");
  for (const requiredCaseId of requiredCaseIds) {
    assert(ids.includes(requiredCaseId), `corpus is missing required case ${requiredCaseId}`);
  }
  const manifestPaths = new Set(manifest.files.map((entry) => entry.path));
  for (const entry of corpusCases.cases) {
    assert(entry.id.length > 0 && entry.category.length > 0, "every case needs an id and category");
    assert(entry.surface.length > 0, `${entry.id} needs a public surface`);
    assert(entry.operation && entry.expected, `${entry.id} needs operation and expected behavior`);
    assert(Array.isArray(entry.allowedVariance), `${entry.id} needs allowedVariance`);
    if (entry.support === "unsupported") {
      assert(
        typeof entry.expected.reason === "string" && entry.expected.reason.length > 0,
        `${entry.id} unsupported case needs a reason`,
      );
    } else {
      assert(entry.support === "supported", `${entry.id} has unknown support status`);
    }
    if (entry.source.files !== "manifest") {
      for (const sourcePath of entry.source.files) {
        assert(
          manifestPaths.has(sourcePath),
          `${entry.id} references missing source byte ${sourcePath}`,
        );
      }
    }
  }
}

async function copyCanonicalVault(target: string): Promise<void> {
  await fs.cp(canonicalVault, target, { recursive: true, force: false, errorOnExist: true });
}

async function openKernel(
  vaultPath: string,
  statePath: string,
  readOnly: boolean,
): Promise<VaultKernel> {
  return VaultKernel.open({
    vaultRoot: vaultPath,
    stateRoot: new FixedStateRoot(statePath),
    readOnly,
  });
}

async function cli(vaultPath: string, statePath: string, args: string[]): Promise<CliCapture> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(
    ["--vault", vaultPath, "--json", ...args],
    {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    },
    { stateRoot: new FixedStateRoot(statePath) },
  );
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

function parseCliSuccess(capture: CliCapture, command: string): JsonSuccess {
  assert(capture.code === 0, `${command} CLI failed with ${capture.code}: ${capture.stderr}`);
  let value: unknown;
  try {
    value = JSON.parse(capture.stdout);
  } catch {
    fail(`${command} CLI did not return JSON: ${capture.stdout}`);
  }
  const result = asRecord(value, `${command} CLI response`);
  assert(result.ok === true, `${command} CLI response is not successful`);
  assert(result.command === command, `${command} CLI response command is stale`);
  return {
    schemaVersion: result.schemaVersion as number,
    ok: true,
    command,
    data: asRecord(result.data, `${command} data`),
  };
}

function summarizeLink(link: LinkMetadata): Record<string, unknown> {
  return {
    target: link.target,
    ...(link.subpath === null ? {} : { subpath: link.subpath }),
    ...(link.alias === null ? {} : { alias: link.alias }),
    ...(link.embed ? { embed: true } : {}),
    syntax: link.syntax,
    status: link.resolution.status,
    ...(link.resolution.path ? { path: link.resolution.path } : {}),
    ...(link.resolution.candidates ? { candidates: link.resolution.candidates } : {}),
  };
}

function assertExpectedLinks(actualLinks: LinkMetadata[], expected: unknown[]): void {
  const actual = actualLinks.map(summarizeLink);
  const expectedRecords = expected.map((entry) => asRecord(entry, "expected link"));
  equalJson(actual.length, expectedRecords.length, "indexed link count");
  for (let index = 0; index < expectedRecords.length; index += 1) {
    const expectedRecord = expectedRecords[index];
    const actualRecord = actual[index];
    assert(expectedRecord, `expected link ${index + 1} is missing`);
    assert(actualRecord, `indexed link ${index + 1} is missing`);
    for (const [key, value] of Object.entries(expectedRecord)) {
      equalJson(actualRecord[key], value, `indexed link ${index + 1} ${key}`);
    }
  }
}

function countRawLinkOccurrences(markdown: string): number {
  return [...markdown.matchAll(/!?\[\[[^\]\n]+\]\]|!?\[[^\]\n]*\]\([^\n)]*\)/gu)].length;
}

async function runLinksCase(
  vaultPath: string,
  statePath: string,
  entry: CorpusCase,
): Promise<void> {
  const kernel = await openKernel(vaultPath, statePath, true);
  const snapshot = (await MetadataIndex.build(kernel)).snapshot();
  const document = snapshot.documents.find((candidate) => candidate.path === "Notes/Index.md");
  assert(document, "Notes/Index.md is not indexed");
  const expected = asArray(entry.expected.links, `${entry.id}.expected.links`);
  assertExpectedLinks(document.links, expected);
  const source = await kernel.readText("Notes/Index.md");
  equalJson(
    countRawLinkOccurrences(source.content) - document.links.length,
    entry.expected.ignoredOccurrences,
    `${entry.id} ignored link-like occurrences`,
  );
  const links = parseCliSuccess(
    await cli(vaultPath, statePath, ["links", "Notes/Index.md"]),
    "links",
  );
  const cliDataLinks = asArray(links.data.links, "CLI links");
  equalJson(cliDataLinks.length, document.links.length, "CLI and kernel link count");
  const alias = asRecord(expected[0], "first expected link");
  equalJson(
    asRecord(cliDataLinks[0], "first CLI link").alias,
    alias.alias,
    "CLI alias preservation",
  );
}

async function runUnicodeCase(
  vaultPath: string,
  statePath: string,
  entry: CorpusCase,
): Promise<void> {
  const operation = asRecord(entry.operation, `${entry.id}.operation`);
  const expected = entry.expected;
  equalJson(expected.normalization, "NFC-case-insensitive", `${entry.id} normalization contract`);
  const ambiguousTargets = asArray(
    operation.ambiguousTargets,
    `${entry.id}.operation.ambiguousTargets`,
  );
  assert(ambiguousTargets.length >= 2, `${entry.id} needs case-variant ambiguous targets`);
  for (const target of ambiguousTargets) {
    assert(typeof target === "string" && target.length > 0, `${entry.id} has an invalid target`);
    const capture = await cli(vaultPath, statePath, ["file", `file=${target}`]);
    equalJson(capture.code, expected.exitCode, `${entry.id} ${target} exit code`);
    assert(
      capture.stderr.includes("Unicode.md"),
      `${entry.id} ${target} must name Unicode.md as a candidate`,
    );
    assert(
      capture.stderr.includes("UNICODE.md"),
      `${entry.id} ${target} must name UNICODE.md as a candidate`,
    );
  }
  const normalizedTarget = operation.normalizedTarget;
  assert(
    typeof normalizedTarget === "string" && normalizedTarget.length > 0,
    `${entry.id} needs a composed normalization target`,
  );
  const normalized = parseCliSuccess(
    await cli(vaultPath, statePath, ["file", `file=${normalizedTarget}`]),
    "file",
  );
  equalJson(normalized.data.path, expected.normalizedPath, `${entry.id} normalized path`);
  const kernel = await openKernel(vaultPath, statePath, true);
  const index = (await MetadataIndex.build(kernel)).snapshot();
  assert(
    index.documents.some((document) => document.path.includes("Unicodé.md")),
    `${entry.id} lost the decomposed path`,
  );
}

async function runAliasesCase(
  vaultPath: string,
  statePath: string,
  entry: CorpusCase,
): Promise<void> {
  const capture = parseCliSuccess(
    await cli(vaultPath, statePath, ["aliases", "path=Notes/Index.md"]),
    "aliases",
  );
  const aliases = asArray(capture.data.aliases, "aliases").map(
    (value) => asRecord(value, "alias").alias,
  );
  equalJson(aliases, entry.expected.aliases, `${entry.id} aliases`);
  equalJson(capture.data.path, entry.expected.sourcePath, `${entry.id} source path`);
}

async function runEmbedsCase(
  vaultPath: string,
  statePath: string,
  entry: CorpusCase,
): Promise<void> {
  const kernel = await openKernel(vaultPath, statePath, true);
  const documents = (await MetadataIndex.build(kernel)).snapshot().documents;
  const heading = await loadVaultNoteEmbed(
    kernel,
    documents,
    "Notes/Index.md",
    "Target",
    "#Section",
    kernel.vaultId,
  );
  const expectedHeading = asRecord(entry.expected.heading, "expected heading embed");
  const headingRecord = asRecord(heading, "heading embed");
  for (const key of ["status", "path", "kind", "startLine"]) {
    equalJson(headingRecord[key], expectedHeading[key], `${entry.id} heading ${key}`);
  }
  for (const value of asArray(expectedHeading.contains, "heading contains")) {
    assert(
      String(headingRecord.content).includes(String(value)),
      `${entry.id} heading misses ${String(value)}`,
    );
  }
  for (const value of asArray(expectedHeading.excludes, "heading excludes")) {
    assert(
      !String(headingRecord.content).includes(String(value)),
      `${entry.id} heading includes excluded ${String(value)}`,
    );
  }
  const block = await loadVaultNoteEmbed(
    kernel,
    documents,
    "Notes/Index.md",
    "Target",
    "^stable-block",
    kernel.vaultId,
  );
  const expectedBlock = asRecord(entry.expected.block, "expected block embed");
  const blockRecord = asRecord(block, "block embed");
  for (const key of ["status", "path", "kind", "content"]) {
    equalJson(blockRecord[key], expectedBlock[key], `${entry.id} block ${key}`);
  }
  const missing = await loadVaultNoteEmbed(
    kernel,
    documents,
    "Notes/Index.md",
    "Target",
    "#Absent",
    kernel.vaultId,
  );
  const missingRecord = asRecord(missing, "missing embed");
  equalJson(missingRecord.status, "unavailable", `${entry.id} missing status`);
  equalJson(missingRecord.reason, "subpath-missing", `${entry.id} missing reason`);
}

async function runAttachmentsCase(
  vaultPath: string,
  statePath: string,
  manifest: CorpusManifest,
  entry: CorpusCase,
): Promise<void> {
  const file = parseCliSuccess(
    await cli(vaultPath, statePath, ["file", "file=diagram.svg"]),
    "file",
  );
  equalJson(file.data.path, "Attachments/diagram.svg", `${entry.id} attachment resolution`);
  const kernel = await openKernel(vaultPath, statePath, false);
  for (const sourcePath of ["Attachments/diagram.svg", "Attachments/notes.txt"]) {
    const read = await kernel.readBinary(sourcePath, 1024 * 1024);
    assert(read.status === "ready", `${entry.id} could not read ${sourcePath}`);
    const bytes = read.snapshot.bytes;
    const manifestEntry = manifest.files.find((candidate) => candidate.path === sourcePath);
    assert(manifestEntry, `${entry.id} has no manifest entry for ${sourcePath}`);
    assert(
      sha256(bytes) === manifestEntry.sha256,
      `${entry.id} read bytes differ for ${sourcePath}`,
    );
    const result = await kernel.writeBinary(sourcePath, bytes, read.snapshot.revision);
    assert(
      result.status === "committed",
      `${entry.id} exact write did not commit for ${sourcePath}`,
    );
  }
  const after = await snapshotTree(vaultPath);
  for (const sourcePath of ["Attachments/diagram.svg", "Attachments/notes.txt"]) {
    equalJson(
      sha256(after.files.get(sourcePath) ?? Buffer.alloc(0)),
      manifest.files.find((entry) => entry.path === sourcePath)?.sha256,
      `${entry.id} attachment roundtrip ${sourcePath}`,
    );
  }
}

async function runFrontmatterCase(
  vaultPath: string,
  statePath: string,
  entry: CorpusCase,
): Promise<void> {
  const kernel = await openKernel(vaultPath, statePath, true);
  const typed = await kernel.readText("Notes/Index.md");
  const inspection = inspectMarkdownNoteProperties(typed.content);
  equalJson(inspection.editor.editable, entry.expected.typedEditable, `${entry.id} typed editable`);
  assert(
    inspection.properties.some((property) => property.type === "list"),
    `${entry.id} list property missing`,
  );
  assert(
    inspection.properties.some((property) => property.type === "text"),
    `${entry.id} text property missing`,
  );
  const malformed = await kernel.readText("Notes/Malformed.md");
  const malformedInspection = inspectMarkdownNoteProperties(malformed.content);
  equalJson(
    malformedInspection.editor.editable,
    entry.expected.malformedEditable,
    `${entry.id} malformed editable`,
  );
  const transformed = applyNotePropertySet(typed.content, "status", "review", "text");
  assert(
    transformed.content.includes('status: "review"'),
    `${entry.id} typed proposal did not serialize`,
  );
  equalJson(
    (await kernel.readText("Notes/Malformed.md")).content,
    malformed.content,
    `${entry.id} malformed no-write`,
  );
}

async function runRenameCase(
  vaultPath: string,
  statePath: string,
  entry: CorpusCase,
): Promise<void> {
  const before = await snapshotTree(vaultPath);
  const kernel = await openKernel(vaultPath, statePath, false);
  const preview = await moveMarkdownNote(kernel, "Notes/Target.md", "Archive/Renamed Target.md");
  const previewRecord = asRecord(preview, "rename preview");
  equalJson(previewRecord.status, "requires-confirmation", `${entry.id} preview status`);
  const confirmationId = previewRecord.confirmationId;
  assert(typeof confirmationId === "string", `${entry.id} preview has no confirmation ID`);
  const result = await moveMarkdownNote(
    kernel,
    "Notes/Target.md",
    "Archive/Renamed Target.md",
    undefined,
    { confirmationId },
  );
  const resultRecord = asRecord(result, "rename result");
  equalJson(resultRecord.status, "committed", `${entry.id} result status`);
  const after = await snapshotTree(vaultPath);
  assert(!after.files.has("Notes/Target.md"), `${entry.id} source still exists`);
  assert(after.files.has("Archive/Renamed Target.md"), `${entry.id} destination is missing`);
  for (const pathName of [
    ".obsidian/app.json",
    ".obsidian/appearance.json",
    ".obsidian/workspace.json",
    ".obsidian/snippets/fixture.css",
  ]) {
    equalJson(
      after.files.get(pathName)?.toString("hex"),
      before.files.get(pathName)?.toString("hex"),
      `${entry.id} .obsidian preservation ${pathName}`,
    );
  }
  const index = (await MetadataIndex.build(kernel)).snapshot();
  const renamed = index.documents.find((document) => document.path === "Archive/Renamed Target.md");
  assert(renamed, `${entry.id} renamed note is not indexed`);
  assert(
    renamed.links.every((link) => link.resolution.status !== "unresolved"),
    `${entry.id} renamed note has a broken link`,
  );
  const indexNote = index.documents.find((document) => document.path === "Notes/Index.md");
  assert(indexNote, `${entry.id} linker disappeared`);
  assert(
    indexNote.links.some((link) => link.resolution.path === "Archive/Renamed Target.md"),
    `${entry.id} backlink was not rewritten`,
  );
  const indexContent = after.files.get("Notes/Index.md")?.toString("utf8");
  assert(indexContent, `${entry.id} linker bytes disappeared`);
  assert(
    indexContent.includes("<!-- [ignored](Target.md)"),
    `${entry.id} rewrote an HTML comment occurrence`,
  );
  assert(
    indexContent.includes("```md\n[[Target]]"),
    `${entry.id} rewrote a fenced-code occurrence`,
  );
}

async function runAmbiguousRenameCase(
  vaultPath: string,
  statePath: string,
  entry: CorpusCase,
): Promise<void> {
  const before = await snapshotTree(vaultPath);
  const kernel = await openKernel(vaultPath, statePath, false);
  const result = await moveMarkdownNote(kernel, "One/Duplicate.md", "Archive/First.md");
  const record = asRecord(result, "ambiguous rename result");
  equalJson(record.status, "blocked", `${entry.id} status`);
  const after = await snapshotTree(vaultPath);
  assertTreesEqual(before, after, `${entry.id} no-write`);
}

async function runCanvasCase(
  vaultPath: string,
  statePath: string,
  entry: CorpusCase,
): Promise<void> {
  const kernel = await openKernel(vaultPath, statePath, false);
  const read = await kernel.readBinary("Boards/Overview.canvas", 1024 * 1024);
  assert(read.status === "ready", `${entry.id} canvas is not readable`);
  const parsed = JSON.parse(read.snapshot.bytes.toString("utf8")) as Record<string, unknown>;
  equalJson(
    asArray(parsed.nodes, "canvas nodes").length,
    entry.expected.nodes,
    `${entry.id} nodes`,
  );
  equalJson(
    asArray(parsed.edges, "canvas edges").length,
    entry.expected.edges,
    `${entry.id} edges`,
  );
  const result = await kernel.writeBinary(
    "Boards/Overview.canvas",
    read.snapshot.bytes,
    read.snapshot.revision,
  );
  equalJson(result.status, "committed", `${entry.id} exact canvas write`);
  const after = await kernel.readBinary("Boards/Overview.canvas", 1024 * 1024);
  assert(after.status === "ready", `${entry.id} canvas disappeared after write`);
  equalJson(
    after.snapshot.bytes.toString("hex"),
    read.snapshot.bytes.toString("hex"),
    `${entry.id} canvas bytes`,
  );
}

async function runCanvasEditingCase(
  vaultPath: string,
  statePath: string,
  entry: CorpusCase,
): Promise<void> {
  const kernel = await openKernel(vaultPath, statePath, false);
  const read = await kernel.readBinary("Boards/Overview.canvas", 1024 * 1024);
  assert(read.status === "ready", `${entry.id} canvas is not readable`);
  const parsed = parseJsonCanvas(read.snapshot.bytes);
  assert(parsed.status === "ready" && parsed.document, `${entry.id} canvas is malformed`);
  const model = new MutableJsonCanvas(parsed.document);
  model.editText("node-index", "Edited by corpus");
  const proposal = serializeJsonCanvas(model.snapshot());
  const result = await kernel.writeBinary(
    "Boards/Overview.canvas",
    new TextEncoder().encode(proposal),
    read.snapshot.revision,
  );
  equalJson(result.status, "committed", `${entry.id} status`);
  const after = await kernel.readBinary("Boards/Overview.canvas", 1024 * 1024);
  assert(after.status === "ready", `${entry.id} edited canvas disappeared`);
  const edited = parseJsonCanvas(after.snapshot.bytes);
  assert(edited.status === "ready" && edited.document, `${entry.id} output is malformed`);
  const textNode = edited.document.nodes?.find((node) => node.id === "node-index");
  assert(textNode?.type === "text", `${entry.id} edited text node disappeared`);
  equalJson(textNode.text, entry.expected.editedText, `${entry.id} text edit`);
  equalJson(edited.document.nodes?.length, entry.expected.nodes, `${entry.id} node count`);
  equalJson(edited.document.edges?.length, entry.expected.edges, `${entry.id} edge count`);
  assert(
    after.snapshot.bytes.toString("hex") !== read.snapshot.bytes.toString("hex"),
    `${entry.id} did not change the edited bytes`,
  );
}

async function runObsidianCase(
  vaultPath: string,
  statePath: string,
  entry: CorpusCase,
): Promise<void> {
  const before = await snapshotTree(vaultPath);
  const snippet = parseCliSuccess(await cli(vaultPath, statePath, ["snippets"]), "snippets");
  equalJson(snippet.data.total, 1, `${entry.id} snippet catalog`);
  const listed = parseCliSuccess(await cli(vaultPath, statePath, ["files"]), "files");
  const listedPaths = asArray(listed.data.files, "visible files");
  assert(
    !listedPaths.some((value) => String(value).startsWith(".obsidian/")),
    `${entry.id} leaked .obsidian into visible inventory`,
  );
  const kernel = await openKernel(vaultPath, statePath, false);
  const note = await kernel.readText("Notes/Index.md");
  const result = await kernel.writeText("Notes/Index.md", note.content, note.revision);
  equalJson(result.status, "committed", `${entry.id} ordinary write`);
  const after = await snapshotTree(vaultPath);
  for (const manifestEntry of before.files.keys()) {
    if (manifestEntry.startsWith(".obsidian/")) {
      equalJson(
        after.files.get(manifestEntry)?.toString("hex"),
        before.files.get(manifestEntry)?.toString("hex"),
        `${entry.id} ${manifestEntry}`,
      );
    }
  }
}

async function runExternalEditCase(
  vaultPath: string,
  statePath: string,
  entry: CorpusCase,
): Promise<void> {
  const kernel = await openKernel(vaultPath, statePath, false);
  const original = await kernel.readText("Notes/Target.md");
  const external = `${original.content}\nExternal atomic winner.\n`;
  const externalPath = path.join(vaultPath, "Notes/Target.md");
  const temporaryPath = `${externalPath}.external-temp`;
  await fs.writeFile(temporaryPath, external, "utf8");
  await fs.rename(temporaryPath, externalPath);
  const proposal = `${original.content}\nThreadleaf stale proposal.\n`;
  const result = await kernel.writeText("Notes/Target.md", proposal, original.revision);
  const record = asRecord(result, "external edit result");
  equalJson(record.status, "conflict", `${entry.id} status`);
  equalJson(await fs.readFile(externalPath, "utf8"), external, `${entry.id} external winner`);
  const conflictPath = record.conflictPath;
  assert(typeof conflictPath === "string", `${entry.id} has no conflict path`);
  equalJson(
    await fs.readFile(path.join(vaultPath, conflictPath), "utf8"),
    proposal,
    `${entry.id} proposal conflict copy`,
  );
}

async function runRoundtripCase(
  vaultPath: string,
  statePath: string,
  before: TreeSnapshot,
  entry: CorpusCase,
): Promise<void> {
  const kernel = await openKernel(vaultPath, statePath, true);
  await MetadataIndex.build(kernel);
  const listed = parseCliSuccess(await cli(vaultPath, statePath, ["vault", "info"]), "vault.info");
  assert(Number(listed.data.markdownFiles) > 0, `${entry.id} CLI did not see Markdown files`);
  assert(
    ![...before.files.keys()].some((relative) => relative.includes(".threadleaf-")),
    `${entry.id} canonical tree contains private state`,
  );
  assertTreesEqual(before, await snapshotTree(vaultPath), entry.id);
}

async function runCase(entry: CorpusCase, manifest: CorpusManifest): Promise<string> {
  if (entry.support === "unsupported") {
    return `${entry.id}: unsupported (declared, not counted as a pass)`;
  }
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-same-vault-"));
  const vaultPath = path.join(temporaryRoot, "vault");
  const statePath = path.join(temporaryRoot, "state");
  try {
    await copyCanonicalVault(vaultPath);
    const before = await snapshotTree(vaultPath);
    if (entry.id === "links.resolution-and-anchors") {
      await runLinksCase(vaultPath, statePath, entry);
    } else if (entry.id === "links.unicode-and-case") {
      await runUnicodeCase(vaultPath, statePath, entry);
    } else if (entry.id === "aliases.frontmatter-and-cli") {
      await runAliasesCase(vaultPath, statePath, entry);
    } else if (entry.id === "embeds.heading-block-and-failure") {
      await runEmbedsCase(vaultPath, statePath, entry);
    } else if (entry.id === "attachments.exact-byte-roundtrip") {
      await runAttachmentsCase(vaultPath, statePath, manifest, entry);
    } else if (entry.id === "frontmatter.typed-and-malformed") {
      await runFrontmatterCase(vaultPath, statePath, entry);
    } else if (entry.id === "rename.rewrite-and-exclusion") {
      await runRenameCase(vaultPath, statePath, entry);
    } else if (entry.id === "rename.ambiguous-refusal") {
      await runAmbiguousRenameCase(vaultPath, statePath, entry);
    } else if (entry.id === "canvas.byte-preservation") {
      await runCanvasCase(vaultPath, statePath, entry);
    } else if (entry.id === "canvas.editing-roundtrip") {
      await runCanvasEditingCase(vaultPath, statePath, entry);
    } else if (entry.id === "obsidian.read-only-coexistence") {
      await runObsidianCase(vaultPath, statePath, entry);
    } else if (entry.id === "external.atomic-edit-conflict") {
      await runExternalEditCase(vaultPath, statePath, entry);
    } else if (entry.id === "roundtrip.every-canonical-byte") {
      await runRoundtripCase(vaultPath, statePath, before, entry);
    } else {
      fail(`no executable handler for supported case ${entry.id}`);
    }
    assertNoVaultPrivateWrites(await snapshotTree(vaultPath), entry.id);
    return `${entry.id}: passed`;
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function runSameVaultCorpus(): Promise<{ passed: number; unsupported: number }> {
  const manifest = await readJson<CorpusManifest>(path.join(corpusDirectory, "manifest.json"));
  const canonicalBefore = await verifyManifest(manifest);
  const corpusCases = await readJson<CorpusCases>(path.join(corpusDirectory, "cases.json"));
  verifyCaseShape(corpusCases, manifest);
  const results: string[] = [];
  let passed = 0;
  let unsupported = 0;
  for (const entry of corpusCases.cases) {
    const result = await runCase(entry, manifest);
    results.push(result);
    if (entry.support === "supported") {
      passed += 1;
    } else {
      unsupported += 1;
    }
  }
  assertTreesEqual(
    canonicalBefore,
    await snapshotTree(canonicalVault),
    "canonical corpus after gate",
  );
  for (const result of results) {
    process.stdout.write(`${result}\n`);
  }
  process.stdout.write(
    `same-vault corpus: ${passed} passed, ${unsupported} unsupported, ${corpusCases.cases.length} total\n`,
  );
  return { passed, unsupported };
}
