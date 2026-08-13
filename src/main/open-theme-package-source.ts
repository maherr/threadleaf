import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import type {
  AppearanceCssStaticReport,
  AppearancePackageAssetEvidence,
  AppearancePackageIndexSnapshot,
  AppearancePackageKind,
  AppearancePackageLicenseEvidence,
  AppearancePackageProvenance,
  AppearancePackageReadmeEvidence,
} from "../shared/theme-packages";
import { validateAppearanceCss } from "./vault-appearance-loader";

const maxArchiveBytes = 32 * 1024 * 1024;
const maxExtractedBytes = 16 * 1024 * 1024;
const maxArchiveEntries = 512;
const maxFilenameBytes = 512;
const maxReadmePreviewBytes = 8 * 1024;
const maxLicensePreviewBytes = 8 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
const packageIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/u;

export interface AppearanceArchiveEntry {
  filename: string;
  bytes: Buffer;
}

export interface AppearancePackageManifest {
  id: string;
  kind: AppearancePackageKind;
  name: string;
  version: string;
  description: string;
  repository: string | null;
  licenseName: string | null;
  licenseSpdxId: string | null;
  licenseSourceUrl: string | null;
}

export interface OpenAppearancePackage {
  kind: AppearancePackageKind;
  packageId: string;
  manifest: AppearancePackageManifest;
  archive: Buffer;
  archiveSha256: string;
  provenance: AppearancePackageProvenance;
  assets: AppearancePackageAssetEvidence[];
  files: AppearanceArchiveEntry[];
  /** The archive entry whose bytes are applied as the package stylesheet. */
  stylesheetFilename?: string;
  license: AppearancePackageLicenseEvidence | null;
  readme: AppearancePackageReadmeEvidence | null;
  css: AppearanceCssStaticReport;
  warnings: string[];
}

export interface OpenAppearanceIndex {
  entries: Array<{
    id: string;
    kind: AppearancePackageKind;
    name: string;
    version: string;
    description: string;
    repository: string | null;
    source: string;
  }>;
  sha256: string;
  sourceUrl: string;
}

export interface AppearancePackageSource {
  getIndex(): Promise<OpenAppearanceIndex>;
  getPackage(
    kind: AppearancePackageKind,
    packageId: string,
    version?: string,
  ): Promise<OpenAppearancePackage>;
}

export interface AppearanceArchiveInspection {
  files: AppearanceArchiveEntry[];
  archiveSha256: string;
  extractedBytes: number;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readU16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.length) {
    throw new Error("Appearance package archive is truncated.");
  }
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length) {
    throw new Error("Appearance package archive is truncated.");
  }
  const value =
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24);
  return value >>> 0;
}

function decodeFilename(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new Error("Appearance package archive contains a non-UTF-8 filename.");
  }
}

function safeArchiveFilename(filename: string, allowDirectory = false): string {
  const normalized = filename.replaceAll("\\", "/");
  const directory = allowDirectory && normalized.endsWith("/");
  const portable = directory ? normalized.slice(0, -1) : normalized;
  if (
    !portable ||
    Buffer.byteLength(normalized, "utf8") > maxFilenameBytes ||
    portable.startsWith("/") ||
    /^[A-Za-z]:\//u.test(portable) ||
    portable.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Appearance package contains an unsafe archive path: ${filename}`);
  }
  if (portable.includes("\u0000")) {
    throw new Error("Appearance package archive filenames may not contain null bytes.");
  }
  return directory ? `${portable}/` : portable;
}

function isDirectoryEntry(filename: string, externalAttributes: number, flags: number): boolean {
  const unixMode = (externalAttributes >>> 16) & 0xffff;
  const unixType = unixMode & 0xf000;
  if (unixType === 0xa000) {
    throw new Error(`Appearance package archive contains a symlink: ${filename}`);
  }
  if ((flags & 0x1) !== 0) {
    throw new Error(`Appearance package archive contains encrypted entry: ${filename}`);
  }
  return filename.endsWith("/") || unixType === 0x4000;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const minimum = 22;
  const start = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - minimum; offset >= start; offset -= 1) {
    if (readU32(bytes, offset) === 0x06054b50) {
      return offset;
    }
  }
  throw new Error("Appearance package is not a ZIP archive with a central directory.");
}

export function extractAppearanceArchive(archive: Uint8Array): AppearanceArchiveInspection {
  const bytes = Buffer.from(archive);
  if (bytes.byteLength === 0 || bytes.byteLength > maxArchiveBytes) {
    throw new Error(`Appearance package archive exceeds the ${maxArchiveBytes} byte limit.`);
  }
  const archiveSha256 = sha256(bytes);
  const eocd = findEndOfCentralDirectory(bytes);
  const disk = readU16(bytes, eocd + 4);
  const centralDisk = readU16(bytes, eocd + 6);
  const entryCount = readU16(bytes, eocd + 10);
  const centralBytes = readU32(bytes, eocd + 12);
  const centralOffset = readU32(bytes, eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || entryCount === 0 || entryCount > maxArchiveEntries) {
    throw new Error("Appearance package archive uses unsupported multi-disk or empty layout.");
  }
  if (centralOffset + centralBytes > eocd || centralOffset < 0 || centralBytes > maxArchiveBytes) {
    throw new Error("Appearance package archive central directory is outside the archive.");
  }

  const entries: AppearanceArchiveEntry[] = [];
  const names = new Set<string>();
  const foldedNames = new Set<string>();
  let cursor = centralOffset;
  let extractedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (readU32(bytes, cursor) !== 0x02014b50) {
      throw new Error("Appearance package archive has an invalid central directory entry.");
    }
    const flags = readU16(bytes, cursor + 8);
    const method = readU16(bytes, cursor + 10);
    const crc = readU32(bytes, cursor + 16);
    const compressedSize = readU32(bytes, cursor + 20);
    const uncompressedSize = readU32(bytes, cursor + 24);
    const filenameLength = readU16(bytes, cursor + 28);
    const extraLength = readU16(bytes, cursor + 30);
    const commentLength = readU16(bytes, cursor + 32);
    const externalAttributes = readU32(bytes, cursor + 38);
    const localOffset = readU32(bytes, cursor + 42);
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + filenameLength);
    const rawName = decodeFilename(nameBytes);
    const filename = safeArchiveFilename(rawName, true);
    const collisionName = filename.endsWith("/") ? filename.slice(0, -1) : filename;
    const folded = collisionName.toLocaleLowerCase("en-US");
    if (names.has(collisionName) || foldedNames.has(folded)) {
      throw new Error(
        `Appearance package archive contains duplicate or case-colliding path: ${filename}`,
      );
    }
    names.add(collisionName);
    foldedNames.add(folded);
    const directory = isDirectoryEntry(filename, externalAttributes, flags);
    const nextCursor = cursor + 46 + filenameLength + extraLength + commentLength;
    if (nextCursor > eocd) {
      throw new Error("Appearance package central directory entry is truncated.");
    }
    cursor = nextCursor;
    if (directory) {
      continue;
    }
    if (method !== 0 && method !== 8) {
      throw new Error(`Appearance package uses unsupported compression for ${filename}.`);
    }
    if (
      uncompressedSize > maxExtractedBytes ||
      extractedBytes + uncompressedSize > maxExtractedBytes
    ) {
      throw new Error(`Appearance package extraction exceeds the ${maxExtractedBytes} byte limit.`);
    }
    if (readU32(bytes, localOffset) !== 0x04034b50) {
      throw new Error(`Appearance package local header is invalid for ${filename}.`);
    }
    const localFlags = readU16(bytes, localOffset + 6);
    const localMethod = readU16(bytes, localOffset + 8);
    const localNameLength = readU16(bytes, localOffset + 26);
    const localExtraLength = readU16(bytes, localOffset + 28);
    const localName = decodeFilename(
      bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength),
    );
    if (
      localFlags !== flags ||
      localMethod !== method ||
      safeArchiveFilename(localName, true) !== filename ||
      localOffset + 30 + localNameLength + localExtraLength + compressedSize > bytes.length
    ) {
      throw new Error(`Appearance package local and central entries disagree for ${filename}.`);
    }
    if ((flags & 0x8) !== 0 && (crc === 0 || compressedSize === 0 || uncompressedSize === 0)) {
      throw new Error(
        `Appearance package data-descriptor entry is missing bounded sizes: ${filename}`,
      );
    }
    const compressed = bytes.subarray(
      localOffset + 30 + localNameLength + localExtraLength,
      localOffset + 30 + localNameLength + localExtraLength + compressedSize,
    );
    let extracted: Buffer;
    try {
      extracted =
        method === 0
          ? Buffer.from(compressed)
          : inflateRawSync(compressed, {
              maxOutputLength: maxExtractedBytes - extractedBytes,
            });
    } catch {
      throw new Error(`Appearance package entry could not be decompressed: ${filename}`);
    }
    if (extracted.byteLength !== uncompressedSize || crc32(extracted) !== crc) {
      throw new Error(`Appearance package entry failed its size or CRC check: ${filename}`);
    }
    extractedBytes += extracted.byteLength;
    entries.push({ filename, bytes: extracted });
  }
  if (cursor !== centralOffset + centralBytes) {
    throw new Error("Appearance package central directory size does not match its entries.");
  }
  entries.sort((left, right) =>
    left.filename.localeCompare(right.filename, "en-US", { numeric: true }),
  );
  return { files: entries, archiveSha256, extractedBytes };
}

function parseText(bytes: Buffer, label: string, maxBytes: number): string {
  if (bytes.byteLength > maxBytes) {
    throw new Error(`${label} exceeds its ${maxBytes} byte limit.`);
  }
  try {
    return decoder.decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8.`);
  }
}

function boundedTextPreview(bytes: Buffer, maxBytes: number): string {
  return parseText(bytes, "Package text", maxBytes)
    .replaceAll("\0", "")
    .replace(/\r\n?/gu, "\n")
    .slice(0, maxBytes);
}

function manifestFromArchive(
  files: AppearanceArchiveEntry[],
  kind: AppearancePackageKind,
  requestedId: string,
): { manifest: AppearancePackageManifest; manifestFile: AppearanceArchiveEntry } {
  const manifestFile = files.find(
    (file) => file.filename === "manifest.json" || file.filename === "package.json",
  );
  if (!manifestFile) {
    throw new Error("Appearance package must include a root manifest.json or package.json.");
  }
  let value: unknown;
  try {
    value = JSON.parse(parseText(manifestFile.bytes, "Appearance package manifest", 64 * 1024));
  } catch (error) {
    throw new Error(
      `Appearance package manifest is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Appearance package manifest must be an object.");
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : requestedId;
  const manifestKind = record.kind ?? record.type;
  const resolvedKind = manifestKind === undefined ? kind : manifestKind;
  const name = typeof record.name === "string" ? record.name.trim() : id;
  const version = typeof record.version === "string" ? record.version.trim() : "";
  if (
    !packageIdPattern.test(id) ||
    resolvedKind !== kind ||
    !name ||
    !versionPattern.test(version) ||
    id !== requestedId
  ) {
    throw new Error("Appearance package manifest identity, kind, or version is invalid.");
  }
  const description =
    typeof record.description === "string" ? record.description.trim().slice(0, 500) : "";
  const repository =
    typeof record.repository === "string" ? record.repository.trim().slice(0, 300) : null;
  const licenseValue = record.license;
  const licenseObject =
    licenseValue && typeof licenseValue === "object" && !Array.isArray(licenseValue)
      ? (licenseValue as Record<string, unknown>)
      : null;
  return {
    manifest: {
      id,
      kind,
      name: name.slice(0, 200),
      version,
      description,
      repository,
      licenseName:
        typeof licenseObject?.name === "string" ? licenseObject.name.slice(0, 200) : null,
      licenseSpdxId:
        typeof licenseObject?.spdxId === "string" ? licenseObject.spdxId.slice(0, 100) : null,
      licenseSourceUrl:
        typeof licenseObject?.sourceUrl === "string" ? licenseObject.sourceUrl.slice(0, 500) : null,
    },
    manifestFile,
  };
}

function staticCssReport(cssBytes: Buffer): AppearanceCssStaticReport {
  const css = parseText(cssBytes, "Appearance stylesheet", 2 * 1024 * 1024);
  const warnings: string[] = [];
  let valid = true;
  try {
    validateAppearanceCss(css);
  } catch (error) {
    valid = false;
    warnings.push(error instanceof Error ? error.message : String(error));
  }
  const inspectable = css.replace(/\/\*[\s\S]*?\*\//gu, " ");
  const count = (pattern: RegExp): number => [...inspectable.matchAll(pattern)].length;
  const importCount = count(/@import\b/giu);
  const externalUrlCount = count(/url\s*\(\s*["']?(?!(?:data:|#|var\())/giu);
  const executableConstructCount = count(/(?:expression\s*\(|-moz-binding\s*:|behavior\s*:)/giu);
  if (importCount > 0) warnings.push("The stylesheet contains @import rules.");
  if (externalUrlCount > 0) warnings.push("The stylesheet contains direct external URLs.");
  if (executableConstructCount > 0)
    warnings.push("The stylesheet contains legacy executable constructs.");
  return {
    scannerVersion: 1,
    stylesheetSha256: sha256(cssBytes),
    stylesheetBytes: cssBytes.byteLength,
    selectorCount: count(/(?:^|\})\s*[^@{}][^{}]*\{/gmu),
    declarationCount: count(/[-\w]+\s*:/gu),
    customPropertyCount: count(/--[A-Za-z0-9_-]+\s*:/gu),
    importCount,
    externalUrlCount,
    executableConstructCount,
    warnings,
    valid,
  };
}

function evidence(filename: string, bytes: Buffer): AppearancePackageAssetEvidence {
  return { filename, sha256: sha256(bytes), size: bytes.byteLength };
}

function findLicense(
  files: AppearanceArchiveEntry[],
  manifest: AppearancePackageManifest,
): AppearancePackageLicenseEvidence | null {
  const file = files.find((entry) =>
    /^(?:license|copying|unlicense)(?:\.[^/]*)?$/iu.test(entry.filename),
  );
  if (!file) return null;
  return {
    filename: file.filename,
    name: manifest.licenseName ?? "Package license",
    spdxId: manifest.licenseSpdxId ?? "UNKNOWN",
    sourceUrl: manifest.licenseSourceUrl,
    sha256: sha256(file.bytes),
    size: file.bytes.byteLength,
    preview: boundedTextPreview(file.bytes, maxLicensePreviewBytes),
  };
}

function findReadme(files: AppearanceArchiveEntry[]): AppearancePackageReadmeEvidence | null {
  const file = files.find((entry) => /^readme(?:\.[^/]*)?$/iu.test(entry.filename));
  if (!file) return null;
  return {
    filename: file.filename,
    sha256: sha256(file.bytes),
    size: file.bytes.byteLength,
    preview: boundedTextPreview(file.bytes, maxReadmePreviewBytes),
  };
}

export function inspectAppearancePackageArchive(
  kind: AppearancePackageKind,
  packageId: string,
  archive: Uint8Array,
  provenance: AppearancePackageProvenance = {
    source: "local",
    locator: null,
    sourceSha256: sha256(archive),
  },
): OpenAppearancePackage {
  if (!packageIdPattern.test(packageId)) {
    throw new Error("Appearance package identifier is invalid.");
  }
  const inspection = extractAppearanceArchive(archive);
  const { manifest } = manifestFromArchive(inspection.files, kind, packageId);
  const cssFiles = inspection.files.filter((file) =>
    file.filename.toLocaleLowerCase("en-US").endsWith(".css"),
  );
  const cssFile =
    kind === "theme"
      ? inspection.files.find((file) => file.filename === "theme.css")
      : (cssFiles.find((file) => file.filename !== "theme.css") ?? cssFiles[0]);
  if (!cssFile) {
    throw new Error(`Appearance ${kind} package must include a CSS stylesheet.`);
  }
  const css = staticCssReport(cssFile.bytes);
  if (!css.valid) {
    throw new Error(`Appearance package CSS is not safe to review: ${css.warnings.join("; ")}`);
  }
  const license = findLicense(inspection.files, manifest);
  const readme = findReadme(inspection.files);
  const warnings = [
    ...(license ? [] : ["No license file was found in the exact package archive."]),
    ...(readme ? [] : ["No README was found in the exact package archive."]),
    "Preview is isolated in private application data; no vault bytes change until the review is applied.",
  ];
  return {
    kind,
    packageId,
    manifest,
    archive: Buffer.from(archive),
    archiveSha256: inspection.archiveSha256,
    provenance,
    assets: inspection.files.map((file) => evidence(file.filename, file.bytes)),
    files: inspection.files,
    stylesheetFilename: cssFile.filename,
    license,
    readme,
    css,
    warnings,
  };
}

export function indexSnapshotForAppearanceSource(
  vaultId: string,
  query: string,
  source: OpenAppearanceIndex,
  installed: Map<string, string>,
  managed: Set<string>,
): AppearancePackageIndexSnapshot {
  const normalized = query.toLocaleLowerCase("en-US");
  return {
    vaultId,
    query,
    sourceUrl: source.sourceUrl,
    sourceSha256: source.sha256,
    results: source.entries
      .filter((entry) =>
        [entry.id, entry.name, entry.description, entry.repository ?? ""]
          .join(" ")
          .toLocaleLowerCase("en-US")
          .includes(normalized),
      )
      .slice(0, 100)
      .map((entry) => ({
        ...entry,
        installedVersion: installed.get(`${entry.kind}:${entry.id}`) ?? null,
        managed: managed.has(`${entry.kind}:${entry.id}`),
      })),
  };
}

/** Offline fixture/source adapter. It intentionally has no network or account behavior. */
export class MemoryAppearancePackageSource implements AppearancePackageSource {
  readonly #packages: OpenAppearancePackage[];
  readonly #sourceUrl: string;
  readonly #sourceSha256: string;

  constructor(packages: OpenAppearancePackage[], sourceUrl = "memory://appearance-index") {
    this.#packages = [...packages].sort(
      (left, right) =>
        left.kind.localeCompare(right.kind, "en-US") ||
        left.packageId.localeCompare(right.packageId, "en-US") ||
        left.manifest.version.localeCompare(right.manifest.version, "en-US", { numeric: true }),
    );
    this.#sourceUrl = sourceUrl;
    const source = JSON.stringify(
      this.#packages.map((entry) => [
        entry.kind,
        entry.packageId,
        entry.manifest.version,
        entry.archiveSha256,
      ]),
    );
    this.#sourceSha256 = sha256(Buffer.from(source, "utf8"));
  }

  async getIndex(): Promise<OpenAppearanceIndex> {
    return {
      entries: this.#packages.map((entry) => ({
        id: entry.packageId,
        kind: entry.kind,
        name: entry.manifest.name,
        version: entry.manifest.version,
        description: entry.manifest.description,
        repository: entry.manifest.repository,
        source: entry.provenance.locator ?? entry.provenance.source,
      })),
      sha256: this.#sourceSha256,
      sourceUrl: this.#sourceUrl,
    };
  }

  async getPackage(
    kind: AppearancePackageKind,
    packageId: string,
    version?: string,
  ): Promise<OpenAppearancePackage> {
    const matches = this.#packages.filter(
      (entry) =>
        entry.kind === kind &&
        entry.packageId === packageId &&
        (version === undefined || entry.manifest.version === version),
    );
    const selected = matches.at(-1);
    if (!selected) {
      throw new Error(
        `No exact ${kind} package ${packageId}${version ? `@${version}` : ""} is available offline.`,
      );
    }
    return selected;
  }
}
