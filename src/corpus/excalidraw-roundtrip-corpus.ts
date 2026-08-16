import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { moveBinaryAttachment, planBinaryAttachmentMove } from "../application/attachment-move";
import {
  canonicalizeExcalidrawScene,
  compareExcalidrawMarkdown,
  createExcalidrawAttachmentManifest,
  parseExcalidrawMarkdown,
  parseUncompressedExcalidrawScene,
  replaceExcalidrawScene,
  synchronizeExcalidrawTextElementMappings,
} from "../kernel/excalidraw-roundtrip";
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
  support: "supported" | "unsupported";
  source: { files: string[] | "manifest" };
  expected: Record<string, unknown>;
}

interface CorpusCases {
  schemaVersion: number;
  corpusId: string;
  license: string;
  canonicalRoot: string;
  manifest: string;
  cases: CorpusCase[];
}

type ExternalObservationStatus = "observed" | "unverified";

interface CorpusCaseResult {
  message: string;
  status: "passed" | ExternalObservationStatus;
}

const corpusDirectory = path.resolve(process.cwd(), "fixtures/corpus/excalidraw-roundtrip-v1");
const canonicalVault = path.join(corpusDirectory, "vault");
const canonicalManifestPath = path.join(corpusDirectory, "manifest.json");
const canonicalCasesPath = path.join(corpusDirectory, "cases.json");

function fail(message: string): never {
  throw new Error(`Excalidraw round-trip corpus: ${message}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    fail(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function observationText(value: unknown, label: string): string {
  assert(
    typeof value === "string" && value.trim() === value && value.length > 0,
    `${label} is invalid`,
  );
  return value;
}

function observationSha256(value: unknown, label: string): string {
  const digest = observationText(value, label);
  assert(/^[a-f0-9]{64}$/u.test(digest), `${label} is not SHA-256`);
  return digest;
}

async function readJson<T>(filePath: string): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    fail(`could not parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
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

async function snapshotManifest(root: string): Promise<ManifestFile[]> {
  const files = await walkFiles(root);
  return Promise.all(
    files.map(async (relative) => {
      const bytes = await fs.readFile(path.join(root, relative));
      return { path: relative, size: bytes.length, sha256: sha256(bytes) };
    }),
  );
}

function renderManifest(files: readonly ManifestFile[]): string {
  return [
    "{",
    '  "schemaVersion": 1,',
    '  "corpusId": "threadleaf.excalidraw-roundtrip.v1",',
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

function assertManifestShape(manifest: CorpusManifest): void {
  assert(manifest.schemaVersion === 1, "manifest schemaVersion must be 1");
  assert(manifest.corpusId === "threadleaf.excalidraw-roundtrip.v1", "manifest corpusId is stale");
  assert(manifest.root === "vault", "manifest root must be vault");
  const paths = manifest.files.map((entry) => entry.path);
  assert(new Set(paths).size === paths.length, "manifest contains duplicate paths");
  assert(
    JSON.stringify(paths) ===
      JSON.stringify([...paths].sort((left, right) => left.localeCompare(right, "en"))),
    "manifest ordering is not deterministic",
  );
  for (const entry of manifest.files) {
    assert(
      entry.path === entry.path.replaceAll("\\", "/"),
      `manifest path is not portable: ${entry.path}`,
    );
    assert(
      !entry.path.startsWith("/") && !entry.path.split("/").includes(".."),
      `manifest path escapes root: ${entry.path}`,
    );
    assert(
      Number.isSafeInteger(entry.size) && entry.size >= 0,
      `manifest size is invalid: ${entry.path}`,
    );
    assert(/^[a-f0-9]{64}$/u.test(entry.sha256), `manifest hash is invalid: ${entry.path}`);
  }
}

async function verifyManifest(manifest: CorpusManifest): Promise<void> {
  assertManifestShape(manifest);
  const expected = renderManifest(manifest.files);
  assert(
    (await fs.readFile(canonicalManifestPath, "utf8")) === expected,
    "manifest regeneration differs",
  );
  const actual = await snapshotManifest(canonicalVault);
  assert(
    JSON.stringify(actual) === JSON.stringify(manifest.files),
    "manifest file inventory differs",
  );
}

async function verifyExternalObservation(
  value: Record<string, unknown>,
  entry: CorpusCase,
  manifest: CorpusManifest,
): Promise<ExternalObservationStatus> {
  assert(value.schemaVersion === 1, `${entry.id} observation schema is stale`);
  assert(
    value.observationId === "threadleaf.excalidraw.obsidian.v1",
    `${entry.id} observation identity is stale`,
  );
  assert(
    value.status === "observed" || value.status === "unverified",
    `${entry.id} observation status is invalid`,
  );
  const status = value.status;
  assert(entry.expected.status === status, `${entry.id} case and observation statuses differ`);
  observationText(value.method, `${entry.id} method`);
  observationText(value.source, `${entry.id} source`);
  observationText(value.operator, `${entry.id} operator`);
  const recordedAt = observationText(value.recordedAt, `${entry.id} recordedAt`);
  assert(/^\d{4}-\d{2}-\d{2}$/u.test(recordedAt), `${entry.id} recordedAt is invalid`);
  if (status === "unverified") {
    assert(value.result === null, `${entry.id} unverified observation cannot carry a result`);
    return status;
  }

  assert(isRecord(value.corpus), `${entry.id} corpus receipt is missing`);
  assert(value.corpus.corpusId === manifest.corpusId, `${entry.id} corpus identity differs`);
  const recordedManifestSha256 = observationSha256(
    value.corpus.manifestSha256,
    `${entry.id} corpus manifest`,
  );
  assert(
    recordedManifestSha256 === sha256(await fs.readFile(canonicalManifestPath)),
    `${entry.id} corpus manifest receipt is stale`,
  );
  const canonicalPublicFileCount = manifest.files.filter(
    (file) => !file.path.startsWith(".obsidian/"),
  ).length;
  assert(
    value.corpus.canonicalPublicFileCount === canonicalPublicFileCount,
    `${entry.id} canonical public file count differs`,
  );

  assert(
    isRecord(value.officialApplication),
    `${entry.id} official application receipt is missing`,
  );
  assert(
    value.officialApplication.id === "md.obsidian.Obsidian",
    `${entry.id} did not identify official Obsidian`,
  );
  observationText(value.officialApplication.version, `${entry.id} application version`);
  observationSha256(value.officialApplication.flatpakCommit, `${entry.id} Flatpak commit`);
  observationText(value.officialApplication.electronVersion, `${entry.id} Electron version`);
  observationText(value.officialApplication.chromiumVersion, `${entry.id} Chromium version`);
  assert(
    isRecord(value.officialApplication.isolation) &&
      value.officialApplication.isolation.profile === "disposable" &&
      value.officialApplication.isolation.vault === "disposable synthetic copy" &&
      value.officialApplication.isolation.remoteDebuggingAddress === "127.0.0.1",
    `${entry.id} official application was not isolated`,
  );

  assert(isRecord(value.plugin), `${entry.id} plugin receipt is missing`);
  assert(
    value.plugin.id === "obsidian-excalidraw-plugin" && value.plugin.version === "2.25.3",
    `${entry.id} plugin identity differs`,
  );
  assert(
    observationSha256(value.plugin.manifestSha256, `${entry.id} plugin manifest`) ===
      "43f18bc17c5c3f76af1a9a4191daa1c3566e2875aa4430561d57b7828785282e",
    `${entry.id} plugin manifest digest differs`,
  );
  assert(
    observationSha256(value.plugin.mainSha256, `${entry.id} plugin bundle`) ===
      "684cf6da43f6e3b2a7646d5a50d14f7a43eb5d859d073dc6a375c4a1b0990dd6" &&
      value.plugin.mainBytes === 4_898_048,
    `${entry.id} plugin bundle identity differs`,
  );
  observationSha256(value.plugin.stylesSha256, `${entry.id} plugin stylesheet`);

  assert(
    Array.isArray(value.officialSettingsRuns) && value.officialSettingsRuns.length === 2,
    `${entry.id} must record both compression settings`,
  );
  const compressionSettings = new Set<boolean>();
  for (const [index, run] of value.officialSettingsRuns.entries()) {
    assert(isRecord(run), `${entry.id} settings run ${index} is invalid`);
    assert(typeof run.compress === "boolean", `${entry.id} settings run ${index} lacks compress`);
    compressionSettings.add(run.compress);
    assert(
      run.fileCount === canonicalPublicFileCount,
      `${entry.id} settings run ${index} file count differs`,
    );
    observationSha256(run.manifestSha256, `${entry.id} settings run ${index} manifest`);
    observationSha256(run.unicodeSceneSha256, `${entry.id} settings run ${index} Unicode scene`);
    observationSha256(
      run.compressedSceneSha256,
      `${entry.id} settings run ${index} compressed scene`,
    );
    observationSha256(run.nativeSceneSha256, `${entry.id} settings run ${index} native scene`);
  }
  assert(
    compressionSettings.has(false) && compressionSettings.has(true),
    `${entry.id} compression setting coverage differs`,
  );

  assert(
    isRecord(value.crossApplicationRoundtrip),
    `${entry.id} cross-application receipt is missing`,
  );
  const inputManifest = observationSha256(
    value.crossApplicationRoundtrip.inputManifestSha256,
    `${entry.id} input manifest`,
  );
  const outputManifest = observationSha256(
    value.crossApplicationRoundtrip.outputManifestSha256,
    `${entry.id} output manifest`,
  );
  assert(
    value.crossApplicationRoundtrip.threadleafStatus === "passed" &&
      value.crossApplicationRoundtrip.officialReturnOpens === 2 &&
      value.crossApplicationRoundtrip.officialRestart === true &&
      value.crossApplicationRoundtrip.exact === true &&
      inputManifest === outputManifest,
    `${entry.id} cross-application result is incomplete`,
  );

  assert(isRecord(value.result), `${entry.id} result is missing`);
  assert(
    value.result.status === "passed" &&
      value.result.officialOpenSaveReopen === true &&
      value.result.threadleafOpenEditRestart === true &&
      value.result.officialReturnOpenRestart === true &&
      value.result.crossApplicationBytesExact === true &&
      value.result.attachmentBytesExact === true,
    `${entry.id} observed result is incomplete`,
  );
  assert(
    Array.isArray(value.limitations) && value.limitations.length > 0,
    `${entry.id} limitations are missing`,
  );
  return status;
}

async function verifyCases(
  cases: CorpusCases,
  manifest: CorpusManifest,
): Promise<Map<string, ExternalObservationStatus>> {
  assert(cases.schemaVersion === 1, "cases schemaVersion must be 1");
  assert(cases.corpusId === manifest.corpusId, "cases and manifest corpus IDs differ");
  assert(cases.license === "CC0-1.0", "cases must declare the fixture license");
  assert(cases.canonicalRoot === "vault", "cases canonicalRoot must be vault");
  assert(cases.manifest === "manifest.json", "cases manifest pointer is stale");
  const manifestPaths = new Set(manifest.files.map((entry) => entry.path));
  const externalObservations = new Map<string, ExternalObservationStatus>();
  for (const entry of cases.cases) {
    assert(entry.id.length > 0 && entry.source && entry.expected, "case shape is incomplete");
    if (entry.source.files !== "manifest") {
      for (const source of entry.source.files) {
        if (source.startsWith("observations/")) {
          const observation = await readJson<Record<string, unknown>>(
            path.join(corpusDirectory, source),
          );
          externalObservations.set(
            entry.id,
            await verifyExternalObservation(observation, entry, manifest),
          );
        } else {
          assert(
            manifestPaths.has(source),
            `${entry.id} references missing manifest path ${source}`,
          );
        }
      }
    }
  }
  return externalObservations;
}

async function copyCanonicalVault(target: string): Promise<void> {
  await fs.cp(canonicalVault, target, { recursive: true, force: false, errorOnExist: true });
}

async function openKernel(vaultRoot: string, stateRoot: string): Promise<VaultKernel> {
  return VaultKernel.open({ vaultRoot, stateRoot: new FixedStateRoot(stateRoot) });
}

function textElementWithChangedText(markdown: string, nextText: string): string {
  const scene = parseUncompressedExcalidrawScene(markdown);
  const elements = Array.isArray(scene.elements)
    ? scene.elements.filter(
        (element): element is Record<string, unknown> =>
          typeof element === "object" && element !== null && !Array.isArray(element),
      )
    : [];
  const target = elements.find(
    (element): element is Record<string, unknown> =>
      typeof element === "object" && element !== null && element.id === "text1234",
  );
  assert(target, "the deterministic text element is missing");
  target.text = nextText;
  target.originalText = nextText;
  target.rawText = nextText;
  const edited = replaceExcalidrawScene(
    markdown,
    JSON.stringify({
      files: scene.files,
      appState: scene.appState,
      elements: scene.elements,
      source: scene.source,
      type: scene.type,
      version: scene.version,
    }),
  );
  return synchronizeExcalidrawTextElementMappings(edited, scene);
}

async function runUncompressedCase(vaultRoot: string, stateRoot: string): Promise<void> {
  const relative = "Drawings/Unicode Scene.excalidraw.md";
  const kernel = await openKernel(vaultRoot, stateRoot);
  const original = await kernel.readText(relative);
  const edited = textElementWithChangedText(original.content, "Ébauche modifiée");
  const comparison = compareExcalidrawMarkdown(original.content, edited);
  assert(
    comparison.kind === "semantic" && !comparison.equal,
    "uncompressed edit was not classified as semantic",
  );
  assert(comparison.nonSceneBytesEqual, "uncompressed edit changed non-scene Markdown bytes");
  const result = await kernel.writeText(relative, edited, original.revision);
  assert(result.status === "committed", "uncompressed scene edit did not commit");
  const reopened = await kernel.readText(relative);
  const reopenedScene = parseUncompressedExcalidrawScene(reopened.content);
  const reopenedElements = Array.isArray(reopenedScene.elements) ? reopenedScene.elements : [];
  const reopenedText = reopenedElements.find(
    (element): element is Record<string, unknown> =>
      typeof element === "object" && element !== null && element.id === "text1234",
  );
  assert(reopenedText?.text === "Ébauche modifiée", "edited scene did not reopen");
  assert(
    reopened.content.includes("Ébauche modifiée ^text1234"),
    "edited scene text mapping did not reopen",
  );
  assert(
    canonicalizeExcalidrawScene(parseUncompressedExcalidrawScene(reopened.content)).includes(
      "Ébauche modifiée",
    ),
    "edited scene semantic bytes disappeared",
  );
}

async function runCompressedCase(vaultRoot: string, stateRoot: string): Promise<void> {
  const relative = "Drawings/Compressed Scene.excalidraw.md";
  const kernel = await openKernel(vaultRoot, stateRoot);
  const original = await kernel.readText(relative);
  const parsed = parseExcalidrawMarkdown(original.content);
  assert(
    parsed.scene.encoding === "compressed-json",
    "compressed fixture did not parse as compressed-json",
  );
  const result = await kernel.writeText(relative, original.content, original.revision);
  assert(result.status === "committed", "compressed exact write did not commit");
  const reopened = await kernel.readText(relative);
  const comparison = compareExcalidrawMarkdown(original.content, reopened.content);
  assert(comparison.kind === "byte-exact" && comparison.equal, "compressed scene bytes changed");
}

async function runNativeCase(vaultRoot: string, stateRoot: string): Promise<void> {
  const relative = "Drawings/Native Scene.excalidraw";
  const kernel = await openKernel(vaultRoot, stateRoot);
  const original = await kernel.readText(relative);
  const scene: unknown = JSON.parse(original.content);
  assert(
    typeof scene === "object" &&
      scene !== null &&
      !Array.isArray(scene) &&
      (scene as Record<string, unknown>).type === "excalidraw",
    "native Excalidraw fixture is not a public scene JSON object",
  );
  const result = await kernel.writeText(relative, original.content, original.revision);
  assert(result.status === "committed", "native scene exact write did not commit");
  const reopened = await kernel.readText(relative);
  assert(reopened.content === original.content, "native scene bytes changed on exact write");
  assert(
    canonicalizeExcalidrawScene(JSON.parse(reopened.content)) ===
      canonicalizeExcalidrawScene(scene),
    "native scene semantic bytes changed on exact write",
  );
}

async function runAttachmentCase(vaultRoot: string): Promise<void> {
  const manifest = await createExcalidrawAttachmentManifest(vaultRoot, [
    "Assets/Ébauche/diagram.svg",
    "Assets/Ébauche/notes.txt",
  ]);
  assert(manifest.entries.length === 2, "attachment manifest count is not deterministic");
  assert(manifest.entries[0]?.path === "Assets/Ébauche/diagram.svg", "attachment ordering changed");
  const drawing = await fs.readFile(
    path.join(vaultRoot, "Drawings/Unicode Scene.excalidraw.md"),
    "utf8",
  );
  assert(
    parseExcalidrawMarkdown(drawing).attachmentReferences.length === 1,
    "attachment reference was not discovered",
  );
}

async function runAttachmentRenameCase(vaultRoot: string, stateRoot: string): Promise<void> {
  const fromPath = "Assets/Ébauche/diagram.svg";
  const toPath = "Assets/Ébauche/diagram-renamed.svg";
  const kernel = await openKernel(vaultRoot, stateRoot);
  const attachment = await kernel.readBinary(fromPath, 1024 * 1024);
  assert(attachment.status === "ready", "attachment could not be read before rename");
  const plan = await planBinaryAttachmentMove(
    kernel,
    fromPath,
    toPath,
    attachment.snapshot.revision,
  );
  assert(plan.status === "planned", "attachment move plan was not created");
  assert(plan.blockers.length === 0, "attachment move plan reported blockers");
  const rename = await moveBinaryAttachment(
    kernel,
    fromPath,
    toPath,
    attachment.snapshot.revision,
    { plan, acceptCurrentRewrites: true },
  );
  assert(
    rename.status === "published-source-retained",
    "attachment publication did not retain the source",
  );
  const renamed = await kernel.readBinary(toPath, 1024 * 1024);
  assert(renamed.status === "ready", "renamed attachment could not be reopened");
  assert(
    sha256(renamed.snapshot.bytes) === sha256(attachment.snapshot.bytes),
    "attachment bytes changed during rename",
  );
  const retained = await kernel.readBinary(fromPath, 1024 * 1024);
  assert(retained.status === "ready", "published attachment source was not retained");
  assert(
    sha256(retained.snapshot.bytes) === sha256(attachment.snapshot.bytes),
    "retained attachment source bytes changed during publication",
  );
  const movedDrawing = await kernel.readText("Drawings/Unicode Scene.excalidraw.md");
  assert(
    parseExcalidrawMarkdown(movedDrawing.content).attachmentReferences[0] ===
      "../Assets/Ébauche/diagram-renamed.svg",
    "attachment move did not round-trip the supplied Excalidraw wiki target",
  );
}

async function runExternalEditCase(vaultRoot: string, stateRoot: string): Promise<void> {
  const relative = "Notes/External.md";
  const kernel = await openKernel(vaultRoot, stateRoot);
  const original = await kernel.readText(relative);
  const absolute = path.join(vaultRoot, relative);
  const temporary = `${absolute}.external-temp`;
  const external = `${original.content}\nExternal atomic winner.\n`;
  await fs.writeFile(temporary, external, "utf8");
  await fs.rename(temporary, absolute);
  const proposal = `${original.content}\nThreadleaf stale proposal.\n`;
  const result = await kernel.writeText(relative, proposal, original.revision);
  assert(result.status === "conflict", "stale plugin save did not produce a conflict");
  assert((await fs.readFile(absolute, "utf8")) === external, "external bytes did not win the race");
  assert(
    result.status === "conflict" &&
      (await fs.readFile(path.join(vaultRoot, result.conflictPath), "utf8")) === proposal,
    "proposal was not retained",
  );
}

async function runPackagedGatePresenceCase(): Promise<void> {
  await fs.access(path.resolve(process.cwd(), "scripts/check-excalidraw-roundtrip.mjs"));
}

async function runCase(
  entry: CorpusCase,
  externalObservations: ReadonlyMap<string, ExternalObservationStatus>,
): Promise<CorpusCaseResult> {
  if (entry.support === "unsupported") {
    const status = externalObservations.get(entry.id) ?? "unverified";
    return {
      message: `${entry.id}: ${status} (external evidence, not an executable pass)`,
      status,
    };
  }
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "threadleaf-excalidraw-roundtrip-"),
  );
  const vaultRoot = path.join(temporaryRoot, "vault");
  const stateRoot = path.join(temporaryRoot, "state");
  try {
    await copyCanonicalVault(vaultRoot);
    if (entry.id === "markdown.uncompressed-semantic-edit") {
      await runUncompressedCase(vaultRoot, stateRoot);
    } else if (entry.id === "markdown.compressed-byte-preservation") {
      await runCompressedCase(vaultRoot, stateRoot);
    } else if (entry.id === "native.excalidraw-byte-preservation") {
      await runNativeCase(vaultRoot, stateRoot);
    } else if (entry.id === "attachments.manifest-and-reference") {
      await runAttachmentCase(vaultRoot);
    } else if (entry.id === "attachments.rename-reference-rewrite") {
      await runAttachmentRenameCase(vaultRoot, stateRoot);
    } else if (entry.id === "external-edit.revision-conflict") {
      await runExternalEditCase(vaultRoot, stateRoot);
    } else if (entry.id === "workflow.packaged-electron") {
      await runPackagedGatePresenceCase();
      return {
        message: `${entry.id}: gate present (run separately with Electron/Xvfb)`,
        status: "passed",
      };
    } else {
      fail(`no handler for ${entry.id}`);
    }
    return { message: `${entry.id}: passed`, status: "passed" };
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function runExcalidrawRoundtripCorpus(): Promise<{
  passed: number;
  observed: number;
  unverified: number;
}> {
  const manifest = await readJson<CorpusManifest>(canonicalManifestPath);
  await verifyManifest(manifest);
  const cases = await readJson<CorpusCases>(canonicalCasesPath);
  const externalObservations = await verifyCases(cases, manifest);
  const results: CorpusCaseResult[] = [];
  let passed = 0;
  let observed = 0;
  let unverified = 0;
  for (const entry of cases.cases) {
    const result = await runCase(entry, externalObservations);
    results.push(result);
    if (result.status === "passed") passed += 1;
    else if (result.status === "observed") observed += 1;
    else unverified += 1;
  }
  for (const result of results) {
    process.stdout.write(`${result.message}\n`);
  }
  process.stdout.write(
    `Excalidraw round-trip corpus: ${passed} executable gates, ${observed} observed external, ${unverified} unverified\n`,
  );
  return { passed, observed, unverified };
}
