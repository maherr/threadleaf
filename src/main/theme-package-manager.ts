import { createHash, randomUUID } from "node:crypto";
import { type Dirent, promises as fs } from "node:fs";
import path from "node:path";
import { atomicWriteFile, readStableFile, revisionOf, syncDirectory } from "../kernel/durability";
import type {
  AppearancePackageApplyOutcome,
  AppearancePackageIndexSnapshot,
  AppearancePackageKind,
  AppearancePackageOperation,
  AppearancePackagePreviewRequest,
  AppearancePackageProvenance,
  AppearancePackageReview,
  ManagedAppearancePackageHistory,
  ManagedAppearancePackageSummary,
} from "../shared/theme-packages";
import { parseAppearancePackagePreviewRequest } from "../shared/theme-packages";
import type {
  AppearanceArchiveEntry,
  AppearancePackageSource,
  OpenAppearancePackage,
} from "./open-theme-package-source";
import {
  extractAppearanceArchive,
  indexSnapshotForAppearanceSource,
} from "./open-theme-package-source";

const reviewLifetimeMs = 15 * 60_000;
const maxHistoryEntries = 5;
const maxInventoryEntries = 512;
const reviewArchiveFilename = "package.zip";
const vaultIdPattern = /^[a-f0-9]{64}$/u;
const revisionPattern = /^[a-f0-9]{64}$/u;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const packageIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const managedFilenamePattern = /^(?!\.)(?:[^/\\\0]+\/)*[^/\\\0]+$/u;
const decoder = new TextDecoder("utf-8", { fatal: true });

type TargetKind = "directory" | "file";
type TransactionPhase = "intent" | "staged" | "package-mutated" | "metadata-committed";

interface AppearanceReceipt {
  version: 1;
  kind: AppearancePackageKind;
  packageId: string;
  packageVersion: string;
  archiveSha256: string;
  provenance: AppearancePackageProvenance;
  assets: Array<{ filename: string; sha256: string; size: number }>;
  installedAt: string;
}

interface InventoryFile {
  version: 1;
  packages: ManagedAppearancePackageSummary[];
}

interface MetadataState {
  inventory: InventoryFile;
  receipt: Buffer | null;
}

interface InternalReview {
  review: AppearancePackageReview;
  expectedTargetRevision: string | null;
  historySnapshotId: string | null;
  historySnapshotRevision: string | null;
  targetKind: TargetKind;
}

interface AppearanceTransactionJournal {
  version: 1;
  id: string;
  vaultId: string;
  kind: AppearancePackageKind;
  packageId: string;
  operation: AppearancePackageOperation;
  targetPath: string;
  targetKind: TargetKind;
  phase: TransactionPhase;
  createdAt: string;
  expectedTargetRevision: string | null;
  nextTargetRevision: string | null;
  historySnapshotId: string | null;
}

export interface ThemePackageManagerHooks {
  afterTransactionPhase?: (phase: TransactionPhase, packageId: string) => Promise<void> | void;
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseVaultId(value: string): string {
  if (!vaultIdPattern.test(value)) {
    throw new Error("Appearance package operation requires a valid vault identity.");
  }
  return value;
}

function parsePackageId(value: string): string {
  if (!packageIdPattern.test(value)) {
    throw new Error("Appearance package identifier is invalid.");
  }
  return value;
}

function receiptBytes(receipt: AppearanceReceipt): Buffer {
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

function safeManagedFilename(filename: string): boolean {
  if (!managedFilenamePattern.test(filename)) return false;
  const normalized = filename.replaceAll("\\", "/");
  return (
    normalized.split("/").every((segment) => segment !== "." && segment !== "..") &&
    !path.posix.isAbsolute(normalized)
  );
}

function targetAssetEvidence(
  kind: AppearancePackageKind,
  assets: Array<{ filename: string; sha256: string; size: number }>,
  stylesheetFilename: string | undefined,
): Array<{ filename: string; sha256: string; size: number }> {
  if (kind === "theme") return assets.map((asset) => ({ ...asset }));
  const stylesheet = stylesheetFilename
    ? assets.find((asset) => asset.filename === stylesheetFilename)
    : assets.find((asset) => asset.filename.toLocaleLowerCase("en-US").endsWith(".css"));
  if (!stylesheet) throw new Error("Appearance snippet review is missing its stylesheet asset.");
  return [{ ...stylesheet }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHistory(value: unknown): ManagedAppearancePackageHistory {
  if (
    !isRecord(value) ||
    typeof value.snapshotId !== "string" ||
    !/^[A-Za-z0-9-]{1,200}$/u.test(value.snapshotId) ||
    typeof value.version !== "string" ||
    (typeof value.archiveSha256 !== "string" && value.archiveSha256 !== null) ||
    (value.archiveSha256 !== null && !revisionPattern.test(value.archiveSha256)) ||
    typeof value.capturedAt !== "string" ||
    Number.isNaN(Date.parse(value.capturedAt)) ||
    !["update", "reinstall", "uninstall", "rollback", "restore"].includes(String(value.reason))
  ) {
    throw new Error("Appearance package inventory contains an invalid history entry.");
  }
  return {
    snapshotId: value.snapshotId,
    version: value.version,
    archiveSha256: value.archiveSha256,
    capturedAt: value.capturedAt,
    reason: value.reason as ManagedAppearancePackageHistory["reason"],
  };
}

function parseSummary(value: unknown): ManagedAppearancePackageSummary {
  if (
    !isRecord(value) ||
    (value.kind !== "theme" && value.kind !== "snippet") ||
    typeof value.packageId !== "string" ||
    !packageIdPattern.test(value.packageId) ||
    (value.currentVersion !== null && typeof value.currentVersion !== "string") ||
    typeof value.targetPath !== "string" ||
    !value.targetPath ||
    (value.repository !== null && typeof value.repository !== "string") ||
    (value.installedAt !== null && typeof value.installedAt !== "string") ||
    !["verified", "changed", "not-installed"].includes(String(value.integrity)) ||
    !Array.isArray(value.history)
  ) {
    throw new Error("Appearance package inventory contains an invalid package entry.");
  }
  return {
    kind: value.kind,
    packageId: value.packageId,
    currentVersion: value.currentVersion,
    targetPath: value.targetPath,
    repository: value.repository,
    installedAt: value.installedAt,
    integrity: value.integrity as ManagedAppearancePackageSummary["integrity"],
    history: value.history.map(parseHistory),
  };
}

function parseInventory(value: unknown): InventoryFile {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.packages)) {
    throw new Error("Appearance package inventory must use version 1.");
  }
  if (value.packages.length > maxInventoryEntries) {
    throw new Error("Appearance package inventory contains too many entries.");
  }
  const packages = value.packages.map(parseSummary);
  const ids = packages.map((entry) => `${entry.kind}:${entry.packageId}`);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Appearance package inventory contains duplicate package identifiers.");
  }
  return { version: 1, packages };
}

function parseNullableRevision(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !revisionPattern.test(value)) {
    throw new Error("Appearance package transaction contains an invalid revision.");
  }
  return value;
}

function parseTransaction(
  value: unknown,
  vaultId: string,
  id: string,
): AppearanceTransactionJournal {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.id !== id ||
    typeof value.id !== "string" ||
    !uuidPattern.test(value.id) ||
    value.vaultId !== vaultId ||
    (value.kind !== "theme" && value.kind !== "snippet") ||
    typeof value.packageId !== "string" ||
    !packageIdPattern.test(value.packageId) ||
    typeof value.operation !== "string" ||
    !["install", "update", "reinstall", "uninstall", "rollback", "restore"].includes(
      value.operation,
    ) ||
    typeof value.targetPath !== "string" ||
    !value.targetPath ||
    (value.targetKind !== "directory" && value.targetKind !== "file") ||
    typeof value.phase !== "string" ||
    !["intent", "staged", "package-mutated", "metadata-committed"].includes(value.phase) ||
    typeof value.createdAt !== "string" ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    (typeof value.historySnapshotId !== "string" && value.historySnapshotId !== null)
  ) {
    throw new Error("Appearance package transaction identity or shape is invalid.");
  }
  const expectedTargetRevision = parseNullableRevision(value.expectedTargetRevision);
  const nextTargetRevision = parseNullableRevision(value.nextTargetRevision);
  if (value.historySnapshotId !== null && !/^[A-Za-z0-9-]{1,200}$/u.test(value.historySnapshotId)) {
    throw new Error("Appearance package transaction history identity is invalid.");
  }
  if (
    (expectedTargetRevision === null && value.historySnapshotId !== null) ||
    (value.phase === "intent" && nextTargetRevision !== null) ||
    (value.operation !== "uninstall" && value.phase !== "intent" && nextTargetRevision === null) ||
    (value.kind === "theme" && value.targetKind !== "directory") ||
    (value.kind === "snippet" && value.targetKind !== "file") ||
    !value.targetPath.startsWith(".obsidian/") ||
    value.targetPath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("Appearance package transaction progress is inconsistent.");
  }
  return {
    version: 1,
    id,
    vaultId,
    kind: value.kind,
    packageId: value.packageId,
    operation: value.operation as AppearancePackageOperation,
    targetPath: value.targetPath,
    targetKind: value.targetKind,
    phase: value.phase as TransactionPhase,
    createdAt: value.createdAt,
    expectedTargetRevision,
    nextTargetRevision,
    historySnapshotId: value.historySnapshotId,
  };
}

type PathKind = "directory" | "file" | "missing" | "other";

async function pathKind(filePath: string): Promise<PathKind> {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) return "other";
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
    return "other";
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "missing";
    throw error;
  }
}

function hashEntry(hash: ReturnType<typeof createHash>, relative: string, marker: string): void {
  hash.update(relative);
  hash.update("\0");
  hash.update(marker);
  hash.update("\0");
}

async function targetRevision(filePath: string): Promise<string | null> {
  const kind = await pathKind(filePath);
  if (kind === "missing") return null;
  if (kind === "other")
    throw new Error(`Appearance package target is not a regular file or directory: ${filePath}`);
  const hash = createHash("sha256");
  if (kind === "file") {
    const snapshot = await readStableFile(filePath);
    if (!snapshot) return null;
    hash.update(snapshot.bytes);
    return hash.digest("hex");
  }
  const pending = [""];
  let entriesSeen = 0;
  while (pending.length > 0) {
    const relativeDirectory = pending.pop() ?? "";
    const absoluteDirectory = path.join(filePath, relativeDirectory);
    const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en-US", { numeric: true }));
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > 20_000)
        throw new Error("Appearance package target exceeds the entry limit.");
      const relative = relativeDirectory
        ? path.posix.join(relativeDirectory, entry.name)
        : entry.name;
      const absolute = path.join(absoluteDirectory, entry.name);
      if (entry.isDirectory()) {
        hashEntry(hash, relative, "directory");
        pending.push(relative);
      } else if (entry.isFile()) {
        const snapshot = await readStableFile(absolute);
        if (!snapshot) throw new Error(`Appearance package target disappeared: ${relative}`);
        hashEntry(hash, relative, "file");
        hash.update(snapshot.bytes);
      } else if (entry.isSymbolicLink()) {
        throw new Error(`Appearance package target contains a symlink: ${relative}`);
      } else {
        throw new Error(`Appearance package target contains unsupported entry: ${relative}`);
      }
    }
  }
  return hash.digest("hex");
}

async function copyTargetExact(
  sourcePath: string,
  targetPath: string,
  expectedRevision: string,
): Promise<void> {
  const kind = await pathKind(sourcePath);
  if (kind !== "directory" && kind !== "file")
    throw new Error("Appearance package source disappeared while staging.");
  if (kind === "directory") {
    await fs.cp(sourcePath, targetPath, {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
  } else {
    await fs.copyFile(sourcePath, targetPath);
  }
  if (
    (await targetRevision(sourcePath)) !== expectedRevision ||
    (await targetRevision(targetPath)) !== expectedRevision
  ) {
    throw new Error(
      "Appearance package changed while its recoverable snapshot was being prepared.",
    );
  }
}

async function removeTree(filePath: string): Promise<void> {
  await fs.rm(filePath, { recursive: true, force: true });
}

function targetRelative(kind: AppearancePackageKind, packageId: string): string {
  return kind === "theme"
    ? path.join(".obsidian", "themes", packageId)
    : path.join(".obsidian", "snippets", `${packageId}.css`);
}

function targetLabel(kind: AppearancePackageKind, packageId: string): string {
  return `${kind}:${packageId}`;
}

function receiptFromPackage(pkg: OpenAppearancePackage, installedAt: string): AppearanceReceipt {
  const assets = targetAssetEvidence(pkg.kind, pkg.assets, pkg.stylesheetFilename);
  return {
    version: 1,
    kind: pkg.kind,
    packageId: pkg.packageId,
    packageVersion: pkg.manifest.version,
    archiveSha256: pkg.archiveSha256,
    provenance: pkg.provenance,
    assets,
    installedAt,
  };
}

function validateReviewedPackage(
  pkg: OpenAppearancePackage,
  kind: AppearancePackageKind,
  packageId: string,
): void {
  if (
    pkg.kind !== kind ||
    pkg.packageId !== packageId ||
    !revisionPattern.test(pkg.archiveSha256) ||
    revisionOf(pkg.archive) !== pkg.archiveSha256 ||
    !revisionPattern.test(pkg.provenance.sourceSha256)
  ) {
    throw new Error("Appearance source returned a package with inconsistent identity or hash.");
  }
  const extracted = extractAppearanceArchive(pkg.archive);
  if (extracted.archiveSha256 !== pkg.archiveSha256) {
    throw new Error("Appearance source archive hash changed while it was being reviewed.");
  }
  const expectedFiles = new Map(extracted.files.map((file) => [file.filename, file]));
  const files = new Map<string, AppearanceArchiveEntry>();
  const folded = new Set<string>();
  for (const file of pkg.files) {
    if (!safeManagedFilename(file.filename) || file.filename.endsWith("/")) {
      throw new Error(`Appearance package contains an unsafe managed asset path: ${file.filename}`);
    }
    const key = file.filename.toLocaleLowerCase("en-US");
    if (files.has(file.filename) || folded.has(key)) {
      throw new Error(
        `Appearance package contains duplicate or case-colliding path: ${file.filename}`,
      );
    }
    files.set(file.filename, file);
    folded.add(key);
    const archiveFile = expectedFiles.get(file.filename);
    if (!archiveFile || revisionOf(file.bytes) !== revisionOf(archiveFile.bytes)) {
      throw new Error(`Appearance package asset ${file.filename} does not match its archive.`);
    }
  }
  if (files.size !== expectedFiles.size) {
    throw new Error("Appearance package file list does not match its exact archive.");
  }
  const assets = new Map<string, { filename: string; sha256: string; size: number }>();
  for (const asset of pkg.assets) {
    if (!safeManagedFilename(asset.filename) || assets.has(asset.filename)) {
      throw new Error(`Appearance package evidence contains an invalid asset: ${asset.filename}`);
    }
    const file = files.get(asset.filename);
    if (!file || asset.size !== file.bytes.byteLength || asset.sha256 !== revisionOf(file.bytes)) {
      throw new Error(`Appearance package evidence does not match ${asset.filename}.`);
    }
    assets.set(asset.filename, asset);
  }
  if (assets.size !== files.size) {
    throw new Error("Appearance package evidence is incomplete.");
  }
  const stylesheetFilename =
    pkg.stylesheetFilename ??
    (kind === "theme"
      ? "theme.css"
      : pkg.files.find((file) => file.filename.toLocaleLowerCase("en-US").endsWith(".css"))
          ?.filename);
  const stylesheet = stylesheetFilename ? files.get(stylesheetFilename) : undefined;
  if (
    !stylesheet ||
    !pkg.css ||
    pkg.css.stylesheetSha256 !== revisionOf(stylesheet.bytes) ||
    pkg.css.stylesheetBytes !== stylesheet.bytes.byteLength ||
    !pkg.css.valid
  ) {
    throw new Error("Appearance package stylesheet evidence is invalid.");
  }
  if (pkg.license) {
    const license = files.get(pkg.license.filename);
    if (
      !license ||
      pkg.license.sha256 !== revisionOf(license.bytes) ||
      pkg.license.size !== license.bytes.byteLength
    ) {
      throw new Error("Appearance package license evidence does not match its archive.");
    }
  }
  if (pkg.readme) {
    const readme = files.get(pkg.readme.filename);
    if (
      !readme ||
      pkg.readme.sha256 !== revisionOf(readme.bytes) ||
      pkg.readme.size !== readme.bytes.byteLength
    ) {
      throw new Error("Appearance package README evidence does not match its archive.");
    }
  }
}

export class ThemePackageManager {
  readonly #stateRoot: string;
  readonly #source: AppearancePackageSource;
  readonly #reviews = new Map<string, InternalReview>();
  readonly #reviewExpiryTimers = new Map<string, NodeJS.Timeout>();
  readonly #recoveryNotices = new Map<string, string[]>();
  readonly #clock: () => Date;
  readonly #hooks: ThemePackageManagerHooks;

  constructor(
    stateRoot: string,
    source: AppearancePackageSource,
    clock: () => Date = () => new Date(),
    hooks: ThemePackageManagerHooks = {},
  ) {
    this.#stateRoot = path.resolve(stateRoot);
    this.#source = source;
    this.#clock = clock;
    this.#hooks = hooks;
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.#stateRoot, { recursive: true, mode: 0o700 });
    await removeTree(this.#reviewsPath());
    await fs.mkdir(this.#reviewsPath(), { recursive: true, mode: 0o700 });
  }

  takeRecoveryNotices(vaultIdValue: string): string[] {
    const vaultId = parseVaultId(vaultIdValue);
    const notices = this.#recoveryNotices.get(vaultId) ?? [];
    this.#recoveryNotices.delete(vaultId);
    return [...notices];
  }

  async recoverVault(vaultPath: string, vaultIdValue: string): Promise<void> {
    const vaultId = parseVaultId(vaultIdValue);
    await this.#assertAppearanceRoots(vaultPath);
    const root = this.#transactionsRoot(vaultId);
    let entries: Dirent<string>[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, "en-US"));
    for (const entry of entries) {
      if (!entry.isDirectory() || !uuidPattern.test(entry.name)) {
        throw new Error(`Appearance recovery found an invalid transaction entry: ${entry.name}`);
      }
      await this.#recoverTransaction(vaultPath, vaultId, entry.name, true);
    }
  }

  async #discardUnstartedTransaction(
    vaultPath: string,
    vaultId: string,
    transactionId: string,
  ): Promise<void> {
    const transactionPath = this.#transactionPath(vaultId, transactionId);
    const entries = await fs.readdir(transactionPath, { withFileTypes: true });
    const temporary = /^\.(?:inventory-before|receipt-before|journal)\.json\.[a-f0-9-]{36}\.tmp$/iu;
    for (const entry of entries) {
      if (
        !entry.isFile() ||
        (!new Set(["inventory-before.json", "receipt-before.json"]).has(entry.name) &&
          !temporary.test(entry.name))
      ) {
        throw new Error(
          "Appearance package recovery found unfamiliar evidence before its durable journal.",
        );
      }
    }
    const inventory = await readStableFile(this.#transactionInventoryPath(vaultId, transactionId));
    if (inventory) parseInventory(JSON.parse(decoder.decode(inventory.bytes)));
    if (
      !inventory &&
      (await readStableFile(this.#transactionReceiptPath(vaultId, transactionId)))
    ) {
      throw new Error(
        "Appearance package recovery found a receipt snapshot without its prior inventory.",
      );
    }
    const transactionSuffix = `-${transactionId}`;
    for (const kind of ["theme", "snippet"] as const) {
      const parent = path.join(
        path.resolve(vaultPath),
        ".obsidian",
        kind === "theme" ? "themes" : "snippets",
      );
      let names: string[] = [];
      try {
        names = await fs.readdir(parent);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      if (
        names.some(
          (name) =>
            (name.startsWith(".threadleaf-appearance-stage-") ||
              name.startsWith(".threadleaf-appearance-rollback-")) &&
            name.endsWith(transactionSuffix),
        )
      ) {
        throw new Error(
          "Appearance package recovery is missing its journal but found vault transaction evidence.",
        );
      }
    }
    await removeTree(transactionPath);
  }

  async search(
    vaultPath: string,
    vaultIdValue: string,
    queryValue: string,
  ): Promise<AppearancePackageIndexSnapshot> {
    const vaultId = parseVaultId(vaultIdValue);
    await this.recoverVault(vaultPath, vaultId);
    const query = queryValue
      .replace(/[\r\n\t]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    if (query.length > 200)
      throw new Error("Appearance package search is limited to 200 characters.");
    const source = await this.#source.getIndex();
    const managed = await this.getManagedPackages(vaultPath, vaultId);
    const installed = new Map(
      managed.map((entry) => [`${entry.kind}:${entry.packageId}`, entry.currentVersion ?? ""]),
    );
    return indexSnapshotForAppearanceSource(
      vaultId,
      query,
      source,
      installed,
      new Set(managed.map((entry) => `${entry.kind}:${entry.packageId}`)),
    );
  }

  async preview(
    vaultPath: string,
    vaultIdValue: string,
    requestValue: AppearancePackagePreviewRequest,
  ): Promise<AppearancePackageReview> {
    const vaultId = parseVaultId(vaultIdValue);
    await this.recoverVault(vaultPath, vaultId);
    const request = parseAppearancePackagePreviewRequest(requestValue);
    const packageId = parsePackageId(request.packageId);
    if (request.action === "install") {
      await this.#assertAppearanceRoot(vaultPath, request.kind);
      const pkg = await this.#source.getPackage(request.kind, packageId, request.version);
      validateReviewedPackage(pkg, request.kind, packageId);
      return this.#previewInstallPackage(vaultPath, vaultId, request.kind, packageId, pkg);
    }
    await this.#assertAppearanceRoot(vaultPath, request.kind);
    const targetPath = this.#targetPath(vaultPath, request.kind, packageId);
    const expectedTargetRevision = await targetRevision(targetPath);
    const targetKind = request.kind === "theme" ? "directory" : "file";
    const existingKind = await pathKind(targetPath);
    if (existingKind !== "missing" && existingKind !== targetKind) {
      throw new Error("Appearance package target conflicts with an existing file type.");
    }
    await this.#assertNoCaseCollision(vaultPath, request.kind, packageId);
    const installed = await this.#currentReceipt(vaultId, request.kind, packageId);
    const installedVersion =
      installed?.packageVersion ?? (expectedTargetRevision ? "unknown" : null);
    const createdAt = this.#clock();
    const expiresAt = new Date(createdAt.getTime() + reviewLifetimeMs);
    if (expectedTargetRevision === null && request.action === "uninstall")
      throw new Error(`Appearance ${request.kind} ${packageId} is not installed in this vault.`);
    if (request.action === "uninstall") {
      const uninstallStylesheetFilename = installed?.assets.find((asset) =>
        asset.filename.toLocaleLowerCase("en-US").endsWith(".css"),
      )?.filename;
      const review: AppearancePackageReview = {
        reviewId: randomUUID(),
        vaultId,
        kind: request.kind,
        operation: "uninstall",
        packageId,
        name: packageId,
        installedVersion,
        targetVersion: null,
        targetPath: targetRelative(request.kind, packageId).replaceAll(path.sep, "/"),
        archiveSha256: installed?.archiveSha256 ?? null,
        provenance: installed?.provenance ?? null,
        ...(uninstallStylesheetFilename ? { stylesheetFilename: uninstallStylesheetFilename } : {}),
        assets: installed?.assets ?? [],
        license: null,
        readme: null,
        css: null,
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        warnings: [
          "The complete existing appearance package will be retained in private rollback history before removal.",
          "Threadleaf will not change the private selected theme or snippet order.",
        ],
      };
      this.#retainReview({
        review,
        expectedTargetRevision,
        historySnapshotId: null,
        historySnapshotRevision: null,
        targetKind,
      });
      return review;
    }
    const inventory = await this.#loadInventory(vaultId);
    const managed = inventory.packages.find(
      (entry) => entry.kind === request.kind && entry.packageId === packageId,
    );
    const selected = request.version
      ? managed?.history.find((entry) => entry.version === request.version)
      : managed?.history[0];
    if (!selected)
      throw new Error(`Appearance package ${packageId} has no retained rollback package.`);
    const historyPath = this.#historyPackagePath(
      vaultId,
      request.kind,
      packageId,
      selected.snapshotId,
    );
    const historyRevision = await targetRevision(historyPath);
    if (!historyRevision) throw new Error("Retained appearance package disappeared.");
    const receipt = await this.#historyReceipt(
      vaultId,
      request.kind,
      packageId,
      selected.snapshotId,
    );
    const stylesheetFilename = receipt?.assets.find((asset) =>
      asset.filename.toLocaleLowerCase("en-US").endsWith(".css"),
    )?.filename;
    const operation: AppearancePackageOperation = request.action;
    const review: AppearancePackageReview = {
      reviewId: randomUUID(),
      vaultId,
      kind: request.kind,
      operation,
      packageId,
      name: packageId,
      installedVersion,
      targetVersion: selected.version,
      targetPath: targetRelative(request.kind, packageId).replaceAll(path.sep, "/"),
      archiveSha256: receipt?.archiveSha256 ?? selected.archiveSha256,
      provenance: receipt?.provenance ?? {
        source: "retained",
        locator: selected.snapshotId,
        sourceSha256: selected.archiveSha256 ?? "0".repeat(64),
      },
      ...(stylesheetFilename ? { stylesheetFilename } : {}),
      assets: receipt?.assets ?? [],
      license: null,
      readme: null,
      css: null,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      warnings: [
        "The retained package bytes are checked again before replacement.",
        "Threadleaf will not change the private selected theme or snippet order.",
      ],
    };
    this.#retainReview({
      review,
      expectedTargetRevision,
      historySnapshotId: selected.snapshotId,
      historySnapshotRevision: historyRevision,
      targetKind,
    });
    return review;
  }

  async previewLocal(
    vaultPath: string,
    vaultIdValue: string,
    pkg: OpenAppearancePackage,
  ): Promise<AppearancePackageReview> {
    const vaultId = parseVaultId(vaultIdValue);
    await this.recoverVault(vaultPath, vaultId);
    const packageId = parsePackageId(pkg.packageId);
    validateReviewedPackage(pkg, pkg.kind, packageId);
    return this.#previewInstallPackage(vaultPath, vaultId, pkg.kind, packageId, pkg);
  }

  async #previewInstallPackage(
    vaultPath: string,
    vaultId: string,
    kind: AppearancePackageKind,
    packageId: string,
    pkg: OpenAppearancePackage,
  ): Promise<AppearancePackageReview> {
    await this.#assertAppearanceRoot(vaultPath, kind);
    const targetPath = this.#targetPath(vaultPath, kind, packageId);
    const expectedTargetRevision = await targetRevision(targetPath);
    const targetKind = kind === "theme" ? "directory" : "file";
    const existingKind = await pathKind(targetPath);
    if (existingKind !== "missing" && existingKind !== targetKind) {
      throw new Error("Appearance package target conflicts with an existing file type.");
    }
    await this.#assertNoCaseCollision(vaultPath, kind, packageId);
    const installed = await this.#currentReceipt(vaultId, kind, packageId);
    const installedVersion =
      installed?.packageVersion ?? (expectedTargetRevision ? "unknown" : null);
    const operation: AppearancePackageOperation =
      expectedTargetRevision === null
        ? "install"
        : installedVersion === pkg.manifest.version
          ? "reinstall"
          : "update";
    const createdAt = this.#clock();
    const expiresAt = new Date(createdAt.getTime() + reviewLifetimeMs);
    const review = this.#reviewFromPackage(
      vaultId,
      operation,
      installedVersion,
      kind,
      pkg,
      createdAt,
      expiresAt,
    );
    await this.#stageReview(review, pkg);
    this.#retainReview({
      review,
      expectedTargetRevision,
      historySnapshotId: null,
      historySnapshotRevision: null,
      targetKind,
    });
    return review;
  }

  async apply(
    vaultPath: string,
    vaultIdValue: string,
    reviewId: string,
  ): Promise<AppearancePackageApplyOutcome> {
    const vaultId = parseVaultId(vaultIdValue);
    await this.recoverVault(vaultPath, vaultId);
    const pending = this.#reviews.get(reviewId);
    if (!pending || pending.review.vaultId !== vaultId)
      throw new Error(
        "Appearance package review is missing, expired, or belongs to another vault.",
      );
    if (Date.parse(pending.review.expiresAt) <= this.#clock().getTime()) {
      await this.#discardReview(reviewId);
      throw new Error("Appearance package review expired. Review the exact package again.");
    }
    this.#clearReviewExpiry(reviewId);
    try {
      const targetPath = this.#targetPath(vaultPath, pending.review.kind, pending.review.packageId);
      const currentRevision = await targetRevision(targetPath);
      if (currentRevision !== pending.expectedTargetRevision)
        throw new Error(
          "Appearance package files changed after review. No package change was applied.",
        );
      if (pending.review.operation === "uninstall")
        return await this.#applyUninstall(vaultPath, vaultId, pending);
      if (pending.review.operation === "rollback" || pending.review.operation === "restore")
        return await this.#applyRetained(vaultPath, vaultId, pending);
      return await this.#applyRemote(vaultPath, vaultId, pending);
    } finally {
      await this.#discardReview(reviewId);
    }
  }

  reviewForApply(vaultIdValue: string, reviewId: string): AppearancePackageReview {
    const vaultId = parseVaultId(vaultIdValue);
    const pending = this.#reviews.get(reviewId);
    if (!pending || pending.review.vaultId !== vaultId)
      throw new Error(
        "Appearance package review is missing, expired, or belongs to another vault.",
      );
    if (Date.parse(pending.review.expiresAt) <= this.#clock().getTime())
      throw new Error("Appearance package review expired. Review the exact package again.");
    return pending.review;
  }

  async cancelReview(vaultIdValue: string, reviewId: string): Promise<void> {
    this.reviewForApply(vaultIdValue, reviewId);
    await this.#discardReview(reviewId);
  }

  async getManagedPackages(
    vaultPath: string,
    vaultIdValue: string,
  ): Promise<ManagedAppearancePackageSummary[]> {
    const vaultId = parseVaultId(vaultIdValue);
    await this.recoverVault(vaultPath, vaultId);
    const inventory = await this.#loadInventory(vaultId);
    const result: ManagedAppearancePackageSummary[] = [];
    for (const entry of inventory.packages) {
      const targetPath = this.#targetPath(vaultPath, entry.kind, entry.packageId);
      const target = await targetRevision(targetPath);
      const receipt = await this.#currentReceipt(vaultId, entry.kind, entry.packageId);
      result.push({
        ...entry,
        currentVersion: target && receipt ? receipt.packageVersion : null,
        installedAt: target && receipt ? entry.installedAt : null,
        integrity:
          target && receipt && (await this.#verifyReceipt(targetPath, receipt))
            ? "verified"
            : target
              ? "changed"
              : "not-installed",
      });
    }
    return result.sort(
      (left, right) =>
        left.kind.localeCompare(right.kind, "en-US") ||
        left.packageId.localeCompare(right.packageId, "en-US"),
    );
  }

  async #applyRemote(
    vaultPath: string,
    vaultId: string,
    pending: InternalReview,
  ): Promise<AppearancePackageApplyOutcome> {
    const review = pending.review;
    const pkg = await this.#readReviewedPackage(review);
    const targetPath = this.#targetPath(vaultPath, review.kind, review.packageId);
    const parentPath = path.dirname(targetPath);
    await fs.mkdir(parentPath, { recursive: true });
    const metadataBefore = await this.#captureMetadataState(vaultId, review.kind, review.packageId);
    let transaction = await this.#beginTransaction(vaultId, review, pending.expectedTargetRevision);
    const stagePath = this.#stagePath(vaultPath, transaction);
    const rollbackPath = this.#rollbackPath(vaultPath, transaction);
    try {
      const history = pending.expectedTargetRevision
        ? await this.#captureHistory(
            vaultPath,
            vaultId,
            review.kind,
            review.packageId,
            targetPath,
            pending.expectedTargetRevision,
            review.operation === "reinstall" ? "reinstall" : "update",
            transaction.historySnapshotId ?? undefined,
            metadataBefore.receipt,
          )
        : null;
      if (pending.expectedTargetRevision) {
        await copyTargetExact(targetPath, stagePath, pending.expectedTargetRevision);
        const previous = metadataBefore.receipt ? this.#parseReceipt(metadataBefore.receipt) : null;
        if (previous && review.kind === "theme")
          await this.#removeManagedFilesAbsent(stagePath, previous.assets, review.assets);
      } else if (review.kind === "theme") {
        await fs.mkdir(stagePath, { recursive: true, mode: 0o700 });
      }
      await this.#overlayReviewedPackage(stagePath, review, pkg.files);
      const nextRevision = await this.#requiredRevision(stagePath);
      transaction = await this.#setPhase(transaction, "staged", nextRevision);
      await this.#swapTarget(
        targetPath,
        stagePath,
        rollbackPath,
        pending.expectedTargetRevision,
        nextRevision,
        pending.targetKind,
      );
      transaction = await this.#setPhase(transaction, "package-mutated", nextRevision);
      const receipt = receiptFromPackage(pkg, this.#clock().toISOString());
      await this.#recordCurrent(vaultId, review, receipt, history?.record ?? null);
      transaction = await this.#setPhase(transaction, "metadata-committed", nextRevision);
      await this.#finishTransaction(vaultPath, transaction);
      return {
        kind: review.kind,
        packageId: review.packageId,
        operation: review.operation,
        version: review.targetVersion,
        targetPath: review.targetPath,
        selectionUnchanged: true,
      };
    } catch (error) {
      try {
        await this.#recoverTransaction(vaultPath, vaultId, transaction.id, false);
      } catch (recoveryError) {
        throw new Error(
          `Appearance package apply failed (${errorMessage(error)}), and automatic restoration also failed (${errorMessage(recoveryError)}). Evidence was preserved.`,
        );
      }
      throw error;
    }
  }

  async #applyUninstall(
    vaultPath: string,
    vaultId: string,
    pending: InternalReview,
  ): Promise<AppearancePackageApplyOutcome> {
    const review = pending.review;
    if (!pending.expectedTargetRevision)
      throw new Error("Appearance package disappeared before the reviewed uninstall.");
    const targetPath = this.#targetPath(vaultPath, review.kind, review.packageId);
    const metadataBefore = await this.#captureMetadataState(vaultId, review.kind, review.packageId);
    let transaction = await this.#beginTransaction(vaultId, review, pending.expectedTargetRevision);
    const rollbackPath = this.#rollbackPath(vaultPath, transaction);
    try {
      const history = await this.#captureHistory(
        vaultPath,
        vaultId,
        review.kind,
        review.packageId,
        targetPath,
        pending.expectedTargetRevision,
        "uninstall",
        transaction.historySnapshotId ?? undefined,
        metadataBefore.receipt,
      );
      transaction = await this.#setPhase(transaction, "staged", null);
      await fs.rename(targetPath, rollbackPath);
      await syncDirectory(path.dirname(targetPath));
      if ((await targetRevision(rollbackPath)) !== pending.expectedTargetRevision)
        throw new Error(
          "Appearance package changed during uninstall and was restored without modification.",
        );
      transaction = await this.#setPhase(transaction, "package-mutated", null);
      await this.#recordRemoved(vaultId, review, history.record);
      transaction = await this.#setPhase(transaction, "metadata-committed", null);
      await this.#finishTransaction(vaultPath, transaction);
      return {
        kind: review.kind,
        packageId: review.packageId,
        operation: "uninstall",
        version: null,
        targetPath: review.targetPath,
        selectionUnchanged: true,
      };
    } catch (error) {
      try {
        await this.#recoverTransaction(vaultPath, vaultId, transaction.id, false);
      } catch (recoveryError) {
        throw new Error(
          `Appearance uninstall failed (${errorMessage(error)}), and automatic restoration also failed (${errorMessage(recoveryError)}). Evidence was preserved.`,
        );
      }
      throw error;
    }
  }

  async #applyRetained(
    vaultPath: string,
    vaultId: string,
    pending: InternalReview,
  ): Promise<AppearancePackageApplyOutcome> {
    const review = pending.review;
    const snapshotId = pending.historySnapshotId;
    const expectedHistoryRevision = pending.historySnapshotRevision;
    if (!snapshotId || !expectedHistoryRevision)
      throw new Error("Appearance rollback review is missing its retained package.");
    const retainedPath = this.#historyPackagePath(
      vaultId,
      review.kind,
      review.packageId,
      snapshotId,
    );
    if ((await targetRevision(retainedPath)) !== expectedHistoryRevision)
      throw new Error(
        "Retained appearance package changed after review. No package change was applied.",
      );
    const targetPath = this.#targetPath(vaultPath, review.kind, review.packageId);
    const metadataBefore = await this.#captureMetadataState(vaultId, review.kind, review.packageId);
    let transaction = await this.#beginTransaction(vaultId, review, pending.expectedTargetRevision);
    const stagePath = this.#stagePath(vaultPath, transaction);
    const rollbackPath = this.#rollbackPath(vaultPath, transaction);
    try {
      const retainedReceiptEvidence = await this.#historyReceipt(
        vaultId,
        review.kind,
        review.packageId,
        snapshotId,
      );
      if (review.kind === "theme") {
        const retainedFiles = await this.#directoryFiles(retainedPath);
        if (pending.expectedTargetRevision) {
          await copyTargetExact(targetPath, stagePath, pending.expectedTargetRevision);
          const previous = metadataBefore.receipt
            ? this.#parseReceipt(metadataBefore.receipt)
            : null;
          if (previous) {
            await this.#removeManagedFilesAbsent(
              stagePath,
              previous.assets,
              retainedReceiptEvidence?.assets ??
                retainedFiles.map((file) => ({ filename: file.filename })),
            );
          }
        } else {
          await fs.mkdir(stagePath, { recursive: true, mode: 0o700 });
        }
        await this.#overlayDirectoryFiles(stagePath, retainedFiles);
      } else {
        await copyTargetExact(retainedPath, stagePath, expectedHistoryRevision);
      }
      const nextRevision = await this.#requiredRevision(stagePath);
      transaction = await this.#setPhase(transaction, "staged", nextRevision);
      await this.#swapTarget(
        targetPath,
        stagePath,
        rollbackPath,
        pending.expectedTargetRevision,
        nextRevision,
        pending.targetKind,
      );
      transaction = await this.#setPhase(transaction, "package-mutated", nextRevision);
      const retainedReceipt =
        retainedReceiptEvidence ??
        (await this.#receiptForRetainedTarget(
          retainedPath,
          review,
          expectedHistoryRevision,
          snapshotId,
        ));
      const currentHistory = pending.expectedTargetRevision
        ? await this.#captureHistory(
            vaultPath,
            vaultId,
            review.kind,
            review.packageId,
            rollbackPath,
            pending.expectedTargetRevision,
            review.operation === "restore" ? "restore" : "rollback",
            transaction.historySnapshotId ?? undefined,
            metadataBefore.receipt,
          )
        : null;
      await this.#recordCurrent(vaultId, review, retainedReceipt, currentHistory?.record ?? null);
      transaction = await this.#setPhase(transaction, "metadata-committed", nextRevision);
      await this.#finishTransaction(vaultPath, transaction);
      return {
        kind: review.kind,
        packageId: review.packageId,
        operation: review.operation,
        version: review.targetVersion,
        targetPath: review.targetPath,
        selectionUnchanged: true,
      };
    } catch (error) {
      try {
        await this.#recoverTransaction(vaultPath, vaultId, transaction.id, false);
      } catch (recoveryError) {
        throw new Error(
          `Appearance rollback failed (${errorMessage(error)}), and automatic restoration also failed (${errorMessage(recoveryError)}). Evidence was preserved.`,
        );
      }
      throw error;
    }
  }

  #reviewFromPackage(
    vaultId: string,
    operation: AppearancePackageOperation,
    installedVersion: string | null,
    kind: AppearancePackageKind,
    pkg: OpenAppearancePackage,
    createdAt: Date,
    expiresAt: Date,
  ): AppearancePackageReview {
    return {
      reviewId: randomUUID(),
      vaultId,
      kind,
      operation,
      packageId: pkg.packageId,
      name: pkg.manifest.name,
      installedVersion,
      targetVersion: pkg.manifest.version,
      targetPath: targetRelative(kind, pkg.packageId).replaceAll(path.sep, "/"),
      archiveSha256: pkg.archiveSha256,
      provenance: pkg.provenance,
      ...(pkg.stylesheetFilename ? { stylesheetFilename: pkg.stylesheetFilename } : {}),
      assets: pkg.assets,
      license: pkg.license,
      readme: pkg.readme,
      css: pkg.css,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      warnings: [
        ...pkg.warnings,
        "The exact package is staged only in private application data until this review is applied.",
        "Threadleaf will not change the private selected theme or snippet order.",
      ],
    };
  }

  async #stageReview(review: AppearancePackageReview, pkg: OpenAppearancePackage): Promise<void> {
    const reviewPath = this.#reviewPath(review.reviewId);
    await fs.mkdir(path.join(reviewPath, "files"), { recursive: true, mode: 0o700 });
    try {
      await atomicWriteFile(path.join(reviewPath, reviewArchiveFilename), pkg.archive);
      for (const file of pkg.files) {
        const destination = path.join(reviewPath, "files", ...file.filename.split("/"));
        await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await atomicWriteFile(destination, file.bytes);
      }
      await atomicWriteFile(
        path.join(reviewPath, "review.json"),
        Buffer.from(`${JSON.stringify(review, null, 2)}\n`, "utf8"),
      );
    } catch (error) {
      await removeTree(reviewPath).catch(() => undefined);
      throw error;
    }
  }

  async #readReviewedPackage(review: AppearancePackageReview): Promise<OpenAppearancePackage> {
    const reviewPath = this.#reviewPath(review.reviewId);
    const files: AppearanceArchiveEntry[] = [];
    for (const asset of review.assets) {
      const snapshot = await readStableFile(
        path.join(reviewPath, "files", ...asset.filename.split("/")),
      );
      if (!snapshot || snapshot.size !== asset.size || snapshot.revision !== asset.sha256)
        throw new Error(`Reviewed appearance asset ${asset.filename} failed its integrity check.`);
      files.push({ filename: asset.filename, bytes: snapshot.bytes });
    }
    const archive = await readStableFile(path.join(reviewPath, reviewArchiveFilename));
    if (!archive || review.archiveSha256 !== archive.revision)
      throw new Error("Reviewed appearance archive failed its exact SHA-256 check.");
    return {
      kind: review.kind,
      packageId: review.packageId,
      manifest: {
        id: review.packageId,
        kind: review.kind,
        name: review.name,
        version: review.targetVersion ?? "",
        description: "",
        repository: null,
        licenseName: review.license?.name ?? null,
        licenseSpdxId: review.license?.spdxId ?? null,
        licenseSourceUrl: review.license?.sourceUrl ?? null,
      },
      archive: archive.bytes,
      archiveSha256: archive.revision,
      provenance: review.provenance as AppearancePackageProvenance,
      assets: review.assets,
      ...(review.stylesheetFilename ? { stylesheetFilename: review.stylesheetFilename } : {}),
      files,
      license: review.license,
      readme: review.readme,
      css: review.css as NonNullable<AppearancePackageReview["css"]>,
      warnings: review.warnings,
    };
  }

  async #overlayReviewedPackage(
    stagePath: string,
    review: AppearancePackageReview,
    files: AppearanceArchiveEntry[],
  ): Promise<void> {
    if (review.kind === "snippet") {
      const stylesheetFilename =
        review.stylesheetFilename ??
        files.find((file) => file.filename.toLocaleLowerCase("en-US").endsWith(".css"))?.filename;
      const stylesheet = files.find((file) => file.filename === stylesheetFilename);
      if (!stylesheet) throw new Error("Appearance snippet review is missing its stylesheet.");
      await atomicWriteFile(stagePath, stylesheet.bytes);
      return;
    }
    await fs.mkdir(stagePath, { recursive: true, mode: 0o700 });
    for (const file of files) {
      const destination = path.join(stagePath, ...file.filename.split("/"));
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await atomicWriteFile(destination, file.bytes);
    }
  }

  async #directoryFiles(directoryPath: string): Promise<AppearanceArchiveEntry[]> {
    const files: AppearanceArchiveEntry[] = [];
    const pending = [""];
    let entriesSeen = 0;
    while (pending.length > 0) {
      const relativeDirectory = pending.pop() ?? "";
      const absoluteDirectory = path.join(directoryPath, relativeDirectory);
      const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
      entries.sort((left, right) =>
        left.name.localeCompare(right.name, "en-US", { numeric: true }),
      );
      for (const entry of entries) {
        entriesSeen += 1;
        if (entriesSeen > 20_000) {
          throw new Error("Retained appearance package exceeds the entry limit.");
        }
        const relative = relativeDirectory
          ? path.posix.join(relativeDirectory, entry.name)
          : entry.name;
        const absolute = path.join(absoluteDirectory, entry.name);
        if (entry.isDirectory()) {
          pending.push(relative);
        } else if (entry.isFile()) {
          const snapshot = await readStableFile(absolute);
          if (!snapshot) throw new Error(`Retained appearance asset disappeared: ${relative}`);
          files.push({ filename: relative, bytes: snapshot.bytes });
        } else {
          throw new Error(`Retained appearance target contains an unsupported entry: ${relative}`);
        }
      }
    }
    return files;
  }

  async #overlayDirectoryFiles(stagePath: string, files: AppearanceArchiveEntry[]): Promise<void> {
    for (const file of files) {
      const destination = path.join(stagePath, ...file.filename.split("/"));
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await atomicWriteFile(destination, file.bytes);
    }
  }

  async #removeManagedFilesAbsent(
    stagePath: string,
    previous: Array<{ filename: string }>,
    next: Array<{ filename: string }>,
  ): Promise<void> {
    const keep = new Set(next.map((entry) => entry.filename));
    for (const entry of previous) {
      if (!keep.has(entry.filename))
        await fs.rm(path.join(stagePath, ...entry.filename.split("/")), {
          force: true,
          recursive: false,
        });
    }
  }

  async #swapTarget(
    targetPath: string,
    stagePath: string,
    rollbackPath: string,
    expectedRevision: string | null,
    nextRevision: string,
    targetKind: TargetKind,
  ): Promise<void> {
    const parentPath = path.dirname(targetPath);
    if (expectedRevision === null) {
      if ((await pathKind(targetPath)) !== "missing")
        throw new Error("Appearance package target appeared after review. No files were replaced.");
      // A rename replaces a same-type file that appears after the check above. Use a
      // same-directory hard link for first-install snippets so that the final install is
      // no-clobber even when another process creates the target in this narrow window.
      // Theme directories still use rename because Node has no portable directory
      // equivalent to renameat2(RENAME_NOREPLACE).
      if (targetKind === "file") {
        await this.#linkFileNoReplace(
          stagePath,
          targetPath,
          "Appearance package target appeared after review. No files were replaced.",
        );
      } else {
        await fs.rename(stagePath, targetPath);
      }
      await syncDirectory(parentPath);
      if ((await targetRevision(targetPath)) !== nextRevision) {
        await fs.rename(targetPath, stagePath).catch(() => undefined);
        await syncDirectory(parentPath).catch(() => undefined);
        throw new Error("Installed appearance package changed during the final swap.");
      }
      return;
    }
    if ((await pathKind(targetPath)) !== targetKind)
      throw new Error("Appearance package target changed type during the final swap.");
    await fs.rename(targetPath, rollbackPath);
    await syncDirectory(parentPath);
    let replacementInstalled = false;
    try {
      if ((await targetRevision(rollbackPath)) !== expectedRevision)
        throw new Error(
          "Appearance package changed during installation and was restored without modification.",
        );
      if (targetKind === "file") {
        await this.#linkFileNoReplace(
          stagePath,
          targetPath,
          "Appearance package target appeared during installation and was preserved.",
        );
      } else {
        await fs.rename(stagePath, targetPath);
      }
      replacementInstalled = true;
      await syncDirectory(parentPath);
      if ((await targetRevision(targetPath)) !== nextRevision)
        throw new Error("Installed appearance package changed during the final swap.");
    } catch (error) {
      if (replacementInstalled && (await pathKind(targetPath)) !== "missing")
        await removeTree(stagePath).catch(() => undefined);
      if (
        (await pathKind(targetPath)) === "missing" &&
        (await pathKind(rollbackPath)) !== "missing"
      )
        await fs.rename(rollbackPath, targetPath).catch(() => undefined);
      await syncDirectory(parentPath).catch(() => undefined);
      throw error;
    }
  }

  async #linkFileNoReplace(
    stagePath: string,
    targetPath: string,
    collisionMessage: string,
  ): Promise<void> {
    try {
      await fs.link(stagePath, targetPath);
    } catch (error) {
      if (errorCode(error) === "EEXIST") throw new Error(collisionMessage);
      throw error;
    }
    await fs.unlink(stagePath);
  }

  async #captureHistory(
    vaultPath: string,
    vaultId: string,
    kind: AppearancePackageKind,
    packageId: string,
    sourcePath: string,
    expectedRevision: string,
    reason: ManagedAppearancePackageHistory["reason"],
    snapshotIdValue: string | undefined,
    receiptBytesBefore: Buffer | null,
  ): Promise<{ directoryPath: string; record: ManagedAppearancePackageHistory }> {
    const snapshotId =
      snapshotIdValue ?? `${this.#clock().toISOString().replaceAll(/[-:.]/gu, "")}-${randomUUID()}`;
    const snapshotRoot = this.#historySnapshotPath(vaultId, kind, packageId, snapshotId);
    const packagePath = path.join(snapshotRoot, "package");
    await fs.mkdir(snapshotRoot, { recursive: true, mode: 0o700 });
    try {
      await copyTargetExact(sourcePath, packagePath, expectedRevision);
      if (receiptBytesBefore)
        await atomicWriteFile(path.join(snapshotRoot, "receipt.json"), receiptBytesBefore);
      const receipt = receiptBytesBefore ? this.#parseReceipt(receiptBytesBefore) : null;
      const record: ManagedAppearancePackageHistory = {
        snapshotId,
        version: receipt?.packageVersion ?? "unknown",
        archiveSha256: receipt?.archiveSha256 ?? null,
        capturedAt: this.#clock().toISOString(),
        reason,
      };
      await atomicWriteFile(
        path.join(snapshotRoot, "snapshot.json"),
        Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8"),
      );
      void vaultPath;
      return { directoryPath: packagePath, record };
    } catch (error) {
      await removeTree(snapshotRoot).catch(() => undefined);
      throw error;
    }
  }

  async #receiptForRetainedTarget(
    retainedPath: string,
    review: AppearancePackageReview,
    expectedRevision: string,
    snapshotId: string,
  ): Promise<AppearanceReceipt> {
    if ((await targetRevision(retainedPath)) !== expectedRevision) {
      throw new Error("Retained appearance package changed while its receipt was prepared.");
    }
    const kind = await pathKind(retainedPath);
    const assets: Array<{ filename: string; sha256: string; size: number }> = [];
    if (kind === "file") {
      const snapshot = await readStableFile(retainedPath);
      if (!snapshot) throw new Error("Retained appearance package disappeared.");
      assets.push({
        filename:
          review.stylesheetFilename ??
          path.posix.basename(review.targetPath.replaceAll(path.sep, "/")),
        sha256: snapshot.revision,
        size: snapshot.size,
      });
    } else if (kind === "directory") {
      const pending = [""];
      while (pending.length > 0) {
        const relativeDirectory = pending.pop() ?? "";
        const absoluteDirectory = path.join(retainedPath, relativeDirectory);
        const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
        entries.sort((left, right) =>
          left.name.localeCompare(right.name, "en-US", { numeric: true }),
        );
        for (const entry of entries) {
          const relative = relativeDirectory
            ? path.posix.join(relativeDirectory, entry.name)
            : entry.name;
          const absolute = path.join(absoluteDirectory, entry.name);
          if (entry.isDirectory()) {
            pending.push(relative);
          } else if (entry.isFile()) {
            const snapshot = await readStableFile(absolute);
            if (!snapshot) throw new Error(`Retained appearance asset disappeared: ${relative}`);
            assets.push({ filename: relative, sha256: snapshot.revision, size: snapshot.size });
          } else {
            throw new Error(
              `Retained appearance target contains an unsupported entry: ${relative}`,
            );
          }
        }
      }
    } else {
      throw new Error("Retained appearance package disappeared.");
    }
    return {
      version: 1,
      kind: review.kind,
      packageId: review.packageId,
      packageVersion: review.targetVersion ?? "unknown",
      archiveSha256: "0".repeat(64),
      provenance: { source: "retained", locator: snapshotId, sourceSha256: "0".repeat(64) },
      assets,
      installedAt: this.#clock().toISOString(),
    };
  }

  async #beginTransaction(
    vaultId: string,
    review: AppearancePackageReview,
    expectedRevision: string | null,
  ): Promise<AppearanceTransactionJournal> {
    const id = randomUUID();
    const transaction: AppearanceTransactionJournal = {
      version: 1,
      id,
      vaultId,
      kind: review.kind,
      packageId: review.packageId,
      operation: review.operation,
      targetPath: review.targetPath,
      targetKind: review.kind === "theme" ? "directory" : "file",
      phase: "intent",
      createdAt: this.#clock().toISOString(),
      expectedTargetRevision: expectedRevision,
      nextTargetRevision: null,
      historySnapshotId: expectedRevision
        ? `${this.#clock().toISOString().replaceAll(/[-:.]/gu, "")}-${id}`
        : null,
    };
    const transactionPath = this.#transactionPath(vaultId, id);
    await fs.mkdir(transactionPath, { recursive: true, mode: 0o700 });
    try {
      const metadata = await this.#captureMetadataState(vaultId, review.kind, review.packageId);
      await atomicWriteFile(
        this.#transactionInventoryPath(vaultId, id),
        Buffer.from(`${JSON.stringify(metadata.inventory, null, 2)}\n`, "utf8"),
      );
      if (metadata.receipt)
        await atomicWriteFile(this.#transactionReceiptPath(vaultId, id), metadata.receipt);
      await this.#writeTransaction(transaction);
      return transaction;
    } catch (error) {
      await removeTree(transactionPath).catch(() => undefined);
      throw error;
    }
  }

  async #setPhase(
    transaction: AppearanceTransactionJournal,
    phase: TransactionPhase,
    nextRevision: string | null,
  ): Promise<AppearanceTransactionJournal> {
    const next = { ...transaction, phase, nextTargetRevision: nextRevision };
    await this.#writeTransaction(next);
    return next;
  }

  async #writeTransaction(transaction: AppearanceTransactionJournal): Promise<void> {
    await atomicWriteFile(
      this.#transactionJournalPath(transaction.vaultId, transaction.id),
      Buffer.from(`${JSON.stringify(transaction, null, 2)}\n`, "utf8"),
    );
    await this.#hooks.afterTransactionPhase?.(transaction.phase, transaction.packageId);
  }

  async #recoverTransaction(
    vaultPath: string,
    vaultId: string,
    transactionId: string,
    recordNotice: boolean,
  ): Promise<void> {
    const journalSnapshot = await readStableFile(
      this.#transactionJournalPath(vaultId, transactionId),
    );
    if (!journalSnapshot) {
      await this.#discardUnstartedTransaction(vaultPath, vaultId, transactionId);
      return;
    }
    const transaction = parseTransaction(
      JSON.parse(decoder.decode(journalSnapshot.bytes)),
      vaultId,
      transactionId,
    );
    if (transaction.phase === "metadata-committed") {
      await this.#cleanupTransaction(vaultPath, transaction, true);
      if (recordNotice)
        this.#notice(
          vaultId,
          `Completed cleanup for interrupted appearance package ${transaction.operation} of ${transaction.packageId}; the reviewed package state was already committed.`,
        );
      return;
    }
    const metadata = await this.#loadTransactionMetadata(transaction);
    const outcome = await this.#restoreInterruptedTarget(vaultPath, transaction);
    await this.#restoreMetadata(vaultId, transaction, metadata);
    await this.#cleanupTransaction(vaultPath, transaction, false);
    if (outcome === "restored" && transaction.historySnapshotId)
      await removeTree(
        this.#historySnapshotPath(
          vaultId,
          transaction.kind,
          transaction.packageId,
          transaction.historySnapshotId,
        ),
      );
    if (recordNotice)
      this.#notice(
        vaultId,
        outcome === "restored"
          ? `Recovered interrupted appearance package ${transaction.operation} for ${transaction.packageId}; the previous bytes and private metadata were restored.`
          : `Recovered interrupted appearance package ${transaction.operation} for ${transaction.packageId}; externally changed bytes were preserved and remain available for review.`,
      );
  }

  async #restoreInterruptedTarget(
    vaultPath: string,
    transaction: AppearanceTransactionJournal,
  ): Promise<"restored" | "external-preserved"> {
    const targetPath = this.#targetPath(vaultPath, transaction.kind, transaction.packageId);
    const stagePath = this.#stagePath(vaultPath, transaction);
    const rollbackPath = this.#rollbackPath(vaultPath, transaction);
    const current = await targetRevision(targetPath);
    if (transaction.phase === "intent") {
      if (current !== transaction.expectedTargetRevision) return "external-preserved";
      await this.#removeKnown(stagePath, transaction.nextTargetRevision, true);
      const rollbackRevision = await targetRevision(rollbackPath);
      if (rollbackRevision !== null) {
        if (rollbackRevision !== transaction.expectedTargetRevision) return "external-preserved";
        await this.#removeKnown(rollbackPath, transaction.expectedTargetRevision, false);
      }
      return "restored";
    }
    if (
      transaction.phase === "staged" &&
      current !== transaction.expectedTargetRevision &&
      current !== transaction.nextTargetRevision
    ) {
      return "external-preserved";
    }
    if (transaction.phase === "staged" && current === transaction.expectedTargetRevision) {
      const stageRevision = await targetRevision(stagePath);
      if (
        transaction.nextTargetRevision !== null &&
        stageRevision !== transaction.nextTargetRevision
      ) {
        return "external-preserved";
      }
      await this.#removeKnown(stagePath, transaction.nextTargetRevision, false);
      const rollbackRevision = await targetRevision(rollbackPath);
      if (rollbackRevision !== null) {
        if (rollbackRevision !== transaction.expectedTargetRevision) return "external-preserved";
        await this.#removeKnown(rollbackPath, transaction.expectedTargetRevision, false);
      }
      return "restored";
    }
    if (
      current !== null &&
      current !== transaction.nextTargetRevision &&
      current !== transaction.expectedTargetRevision
    )
      return "external-preserved";
    if (transaction.expectedTargetRevision === null) {
      if ((await targetRevision(rollbackPath)) !== null) return "external-preserved";
      if (current === transaction.nextTargetRevision) {
        await removeTree(targetPath);
        await syncDirectory(path.dirname(targetPath));
      }
      await this.#removeKnown(stagePath, transaction.nextTargetRevision, false);
      return "restored";
    }
    if (current === transaction.expectedTargetRevision) {
      await this.#removeKnown(stagePath, transaction.nextTargetRevision, false);
      await this.#removeKnown(rollbackPath, transaction.expectedTargetRevision, false);
      return "restored";
    }
    const rollbackRevision = await targetRevision(rollbackPath);
    if (rollbackRevision !== null && rollbackRevision !== transaction.expectedTargetRevision) {
      return "external-preserved";
    }
    if (current === transaction.nextTargetRevision) {
      await removeTree(targetPath);
      await syncDirectory(path.dirname(targetPath));
    }
    if (rollbackRevision === transaction.expectedTargetRevision) {
      await fs.rename(rollbackPath, targetPath);
      await syncDirectory(path.dirname(targetPath));
    } else if (transaction.historySnapshotId) {
      const historyPath = this.#historyPackagePath(
        transaction.vaultId,
        transaction.kind,
        transaction.packageId,
        transaction.historySnapshotId,
      );
      if ((await targetRevision(historyPath)) !== transaction.expectedTargetRevision)
        throw new Error(
          "Retained interrupted appearance package no longer matches its reviewed revision.",
        );
      await copyTargetExact(historyPath, targetPath, transaction.expectedTargetRevision);
    } else {
      return "external-preserved";
    }
    if ((await targetRevision(targetPath)) !== transaction.expectedTargetRevision)
      throw new Error("Interrupted appearance package could not be restored exactly.");
    await this.#removeKnown(stagePath, transaction.nextTargetRevision, false);
    return "restored";
  }

  async #removeKnown(
    filePath: string,
    expectedRevision: string | null,
    allowPartial: boolean,
  ): Promise<void> {
    if ((await pathKind(filePath)) === "missing") return;
    if (!allowPartial && (await targetRevision(filePath)) !== expectedRevision)
      throw new Error("Appearance package transaction evidence changed outside Threadleaf.");
    await removeTree(filePath);
  }

  async #cleanupTransaction(
    vaultPath: string,
    transaction: AppearanceTransactionJournal,
    committed: boolean,
  ): Promise<void> {
    const stagePath = this.#stagePath(vaultPath, transaction);
    const rollbackPath = this.#rollbackPath(vaultPath, transaction);
    const stageKind = await pathKind(stagePath);
    if (stageKind !== "missing") {
      const stageRevision = await targetRevision(stagePath);
      if (!committed && transaction.phase === "intent" && transaction.nextTargetRevision === null) {
        await removeTree(stagePath);
      } else if (
        stageRevision === transaction.nextTargetRevision ||
        stageRevision === transaction.expectedTargetRevision
      ) {
        await removeTree(stagePath);
      } else {
        throw new Error("Appearance package staging evidence changed outside Threadleaf.");
      }
    }
    const rollbackKind = await pathKind(rollbackPath);
    if (rollbackKind !== "missing") {
      const rollbackRevision = await targetRevision(rollbackPath);
      if (rollbackRevision === transaction.expectedTargetRevision) {
        await removeTree(rollbackPath);
      } else {
        throw new Error(
          committed
            ? "Committed appearance transaction evidence changed outside Threadleaf."
            : "Appearance package rollback evidence changed outside Threadleaf.",
        );
      }
    }
    await syncDirectory(
      path.dirname(this.#targetPath(vaultPath, transaction.kind, transaction.packageId)),
    ).catch(() => undefined);
    await removeTree(this.#transactionPath(transaction.vaultId, transaction.id));
    if (committed)
      await this.#pruneHistory(transaction.vaultId, transaction.kind, transaction.packageId);
  }

  async #loadTransactionMetadata(
    transaction: AppearanceTransactionJournal,
  ): Promise<MetadataState> {
    const inventory = await readStableFile(
      this.#transactionInventoryPath(transaction.vaultId, transaction.id),
    );
    if (!inventory)
      throw new Error("Appearance recovery is missing its private inventory snapshot.");
    const receipt = await readStableFile(
      this.#transactionReceiptPath(transaction.vaultId, transaction.id),
    );
    return {
      inventory: parseInventory(JSON.parse(decoder.decode(inventory.bytes))),
      receipt: receipt?.bytes ?? null,
    };
  }

  async #restoreMetadata(
    vaultId: string,
    transaction: AppearanceTransactionJournal,
    state: MetadataState,
  ): Promise<void> {
    await this.#saveInventory(vaultId, state.inventory);
    const receiptPath = this.#currentReceiptPath(vaultId, transaction.kind, transaction.packageId);
    if (state.receipt) await atomicWriteFile(receiptPath, state.receipt);
    else await fs.rm(receiptPath, { force: true });
  }

  async #captureMetadataState(
    vaultId: string,
    kind: AppearancePackageKind,
    packageId: string,
  ): Promise<MetadataState> {
    const [inventory, receipt] = await Promise.all([
      this.#loadInventory(vaultId),
      readStableFile(this.#currentReceiptPath(vaultId, kind, packageId)),
    ]);
    return { inventory, receipt: receipt?.bytes ?? null };
  }

  async #recordCurrent(
    vaultId: string,
    review: AppearancePackageReview,
    receipt: AppearanceReceipt,
    history: ManagedAppearancePackageHistory | null,
  ): Promise<void> {
    const inventory = await this.#loadInventory(vaultId);
    const key = targetLabel(review.kind, review.packageId);
    const existing = inventory.packages.find(
      (entry) => targetLabel(entry.kind, entry.packageId) === key,
    );
    const histories = [history, ...(existing?.history ?? [])]
      .filter((entry): entry is ManagedAppearancePackageHistory => entry !== null)
      .slice(0, maxHistoryEntries);
    inventory.packages = [
      ...inventory.packages.filter((entry) => targetLabel(entry.kind, entry.packageId) !== key),
      {
        kind: review.kind,
        packageId: review.packageId,
        currentVersion: receipt.packageVersion,
        targetPath: review.targetPath,
        repository: review.provenance?.locator ?? existing?.repository ?? null,
        installedAt: receipt.installedAt,
        integrity: "verified",
        history: histories,
      },
    ];
    await atomicWriteFile(
      this.#currentReceiptPath(vaultId, review.kind, review.packageId),
      receiptBytes(receipt),
    );
    await this.#saveInventory(vaultId, inventory);
  }

  async #requiredRevision(filePath: string): Promise<string> {
    const revision = await targetRevision(filePath);
    if (!revision) throw new Error("Retained appearance package disappeared.");
    return revision;
  }

  async #finishTransaction(
    vaultPath: string,
    transaction: AppearanceTransactionJournal,
  ): Promise<void> {
    try {
      await this.#cleanupTransaction(vaultPath, transaction, true);
    } catch {
      // The metadata-committed journal is enough for deterministic startup cleanup.
    }
  }

  async #recordRemoved(
    vaultId: string,
    review: AppearancePackageReview,
    history: ManagedAppearancePackageHistory,
  ): Promise<void> {
    const inventory = await this.#loadInventory(vaultId);
    const existing = inventory.packages.find(
      (entry) => entry.kind === review.kind && entry.packageId === review.packageId,
    );
    inventory.packages = [
      ...inventory.packages.filter(
        (entry) => entry.kind !== review.kind || entry.packageId !== review.packageId,
      ),
      {
        kind: review.kind,
        packageId: review.packageId,
        currentVersion: null,
        targetPath: review.targetPath,
        repository: existing?.repository ?? null,
        installedAt: null,
        integrity: "not-installed",
        history: [history, ...(existing?.history ?? [])].slice(0, maxHistoryEntries),
      },
    ];
    await this.#saveInventory(vaultId, inventory);
    await fs.rm(this.#currentReceiptPath(vaultId, review.kind, review.packageId), { force: true });
  }

  async #saveInventory(vaultId: string, inventory: InventoryFile): Promise<void> {
    const normalized = parseInventory(inventory);
    normalized.packages.sort(
      (left, right) =>
        left.kind.localeCompare(right.kind, "en-US") ||
        left.packageId.localeCompare(right.packageId, "en-US"),
    );
    await atomicWriteFile(
      this.#inventoryPath(vaultId),
      Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`, "utf8"),
    );
  }

  async #loadInventory(vaultId: string): Promise<InventoryFile> {
    const snapshot = await readStableFile(this.#inventoryPath(vaultId));
    if (!snapshot) return { version: 1, packages: [] };
    return parseInventory(JSON.parse(decoder.decode(snapshot.bytes)));
  }

  async #currentReceipt(
    vaultId: string,
    kind: AppearancePackageKind,
    packageId: string,
  ): Promise<AppearanceReceipt | null> {
    const snapshot = await readStableFile(this.#currentReceiptPath(vaultId, kind, packageId));
    return snapshot ? this.#parseReceipt(snapshot.bytes, kind, packageId) : null;
  }

  #parseReceipt(
    bytes: Buffer,
    expectedKind?: AppearancePackageKind,
    expectedPackageId?: string,
  ): AppearanceReceipt {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      (value.kind !== "theme" && value.kind !== "snippet") ||
      typeof value.packageId !== "string" ||
      !packageIdPattern.test(value.packageId) ||
      typeof value.packageVersion !== "string" ||
      typeof value.archiveSha256 !== "string" ||
      !revisionPattern.test(value.archiveSha256) ||
      !isRecord(value.provenance) ||
      !Array.isArray(value.assets) ||
      typeof value.installedAt !== "string"
    )
      throw new Error("Appearance package receipt is invalid.");
    if (
      (expectedKind !== undefined && value.kind !== expectedKind) ||
      (expectedPackageId !== undefined && value.packageId !== expectedPackageId)
    ) {
      throw new Error("Appearance package receipt identity does not match its private path.");
    }
    const assets = value.assets.map((asset) => {
      if (
        !isRecord(asset) ||
        typeof asset.filename !== "string" ||
        !safeManagedFilename(asset.filename) ||
        typeof asset.sha256 !== "string" ||
        !revisionPattern.test(asset.sha256) ||
        typeof asset.size !== "number" ||
        !Number.isSafeInteger(asset.size) ||
        asset.size < 0
      )
        throw new Error("Appearance package receipt asset is invalid.");
      return { filename: asset.filename, sha256: asset.sha256, size: asset.size };
    });
    if (new Set(assets.map((asset) => asset.filename)).size !== assets.length) {
      throw new Error("Appearance package receipt contains duplicate assets.");
    }
    const provenance = value.provenance as Record<string, unknown>;
    if (
      !["local", "bundled", "retained"].includes(String(provenance.source)) ||
      (provenance.locator !== null && typeof provenance.locator !== "string") ||
      typeof provenance.sourceSha256 !== "string" ||
      !revisionPattern.test(provenance.sourceSha256)
    )
      throw new Error("Appearance package receipt provenance is invalid.");
    return {
      version: 1,
      kind: value.kind,
      packageId: value.packageId,
      packageVersion: value.packageVersion,
      archiveSha256: value.archiveSha256 as string,
      provenance: {
        source: provenance.source as AppearancePackageProvenance["source"],
        locator: provenance.locator as string | null,
        sourceSha256: provenance.sourceSha256,
      },
      assets,
      installedAt: value.installedAt,
    };
  }

  async #verifyReceipt(targetPathValue: string, receipt: AppearanceReceipt): Promise<boolean> {
    try {
      if ((await pathKind(targetPathValue)) === "file") {
        if (receipt.assets.length !== 1) return false;
        const asset = receipt.assets[0];
        const snapshot = await readStableFile(targetPathValue);
        return Boolean(
          snapshot && snapshot.size === asset?.size && snapshot.revision === asset?.sha256,
        );
      }
      for (const asset of receipt.assets) {
        if (!safeManagedFilename(asset.filename)) return false;
        const snapshot = await readStableFile(
          path.join(targetPathValue, ...asset.filename.split("/")),
        );
        if (!snapshot || snapshot.size !== asset.size || snapshot.revision !== asset.sha256)
          return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  async #historyReceipt(
    vaultId: string,
    kind: AppearancePackageKind,
    packageId: string,
    snapshotId: string,
  ): Promise<AppearanceReceipt | null> {
    const snapshot = await readStableFile(
      path.join(this.#historySnapshotPath(vaultId, kind, packageId, snapshotId), "receipt.json"),
    );
    if (!snapshot) return null;
    return this.#parseReceipt(snapshot.bytes, kind, packageId);
  }

  async #pruneHistory(
    vaultId: string,
    kind: AppearancePackageKind,
    packageId: string,
  ): Promise<void> {
    const root = this.#historyRoot(vaultId, kind, packageId);
    let entries: string[];
    try {
      entries = await fs.readdir(root);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    const inventory = await this.#loadInventory(vaultId);
    const keep = new Set(
      inventory.packages
        .find((entry) => entry.kind === kind && entry.packageId === packageId)
        ?.history.map((entry) => entry.snapshotId) ?? [],
    );
    await Promise.all(
      entries
        .filter((entry) => !keep.has(entry))
        .map((entry) => removeTree(path.join(root, entry))),
    );
  }

  async #assertNoCaseCollision(
    vaultPath: string,
    kind: AppearancePackageKind,
    packageId: string,
  ): Promise<void> {
    const directory = path.join(
      path.resolve(vaultPath),
      ".obsidian",
      kind === "theme" ? "themes" : "snippets",
    );
    let entries: Dirent<string>[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    const targetName = kind === "theme" ? packageId : `${packageId}.css`;
    const folded = targetName.toLocaleLowerCase("en-US");
    const collisions = entries.filter(
      (entry) => entry.name.toLocaleLowerCase("en-US") === folded && entry.name !== targetName,
    );
    if (collisions.length > 0)
      throw new Error(`Appearance package name collides by case with ${collisions[0]?.name}.`);
  }

  async #assertAppearanceRoots(vaultPath: string): Promise<void> {
    await this.#assertAppearanceRoot(vaultPath, "theme");
    await this.#assertAppearanceRoot(vaultPath, "snippet");
  }

  async #assertAppearanceRoot(vaultPath: string, kind: AppearancePackageKind): Promise<void> {
    const root = path.resolve(vaultPath);
    const rootStat = await fs.lstat(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error("Appearance package vault root must be a real directory.");
    }
    const segments = [".obsidian", kind === "theme" ? "themes" : "snippets"];
    let current = root;
    for (const segment of segments) {
      current = path.join(current, segment);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) {
          throw new Error("Appearance package source roots may not contain symlinks.");
        }
        if (!stat.isDirectory()) {
          throw new Error("Appearance package source root is not a directory.");
        }
      } catch (error) {
        if (errorCode(error) === "ENOENT") return;
        throw error;
      }
    }
  }

  #targetPath(vaultPath: string, kind: AppearancePackageKind, packageId: string): string {
    return path.join(path.resolve(vaultPath), targetRelative(kind, packageId));
  }
  #reviewsPath(): string {
    return path.join(this.#stateRoot, "reviews");
  }
  #reviewPath(reviewId: string): string {
    if (!uuidPattern.test(reviewId)) throw new Error("Appearance review identity is invalid.");
    return path.join(this.#reviewsPath(), reviewId);
  }
  #reviewExpiry(review: AppearancePackageReview): void {
    const timer = setTimeout(
      () => void this.#discardReview(review.reviewId).catch(() => undefined),
      Math.max(0, Date.parse(review.expiresAt) - this.#clock().getTime()),
    );
    timer.unref();
    this.#reviewExpiryTimers.set(review.reviewId, timer);
  }
  #retainReview(pending: InternalReview): void {
    this.#reviews.set(pending.review.reviewId, pending);
    this.#reviewExpiry(pending.review);
  }
  #clearReviewExpiry(reviewId: string): void {
    const timer = this.#reviewExpiryTimers.get(reviewId);
    if (timer) clearTimeout(timer);
    this.#reviewExpiryTimers.delete(reviewId);
  }
  async #discardReview(reviewId: string): Promise<void> {
    this.#clearReviewExpiry(reviewId);
    this.#reviews.delete(reviewId);
    await removeTree(this.#reviewPath(reviewId));
  }
  #notice(vaultId: string, notice: string): void {
    const notices = this.#recoveryNotices.get(vaultId) ?? [];
    if (!notices.includes(notice)) notices.push(notice);
    this.#recoveryNotices.set(vaultId, notices);
  }
  #inventoryPath(vaultId: string): string {
    return path.join(this.#stateRoot, "vaults", parseVaultId(vaultId), "inventory.json");
  }
  #currentReceiptPath(vaultId: string, kind: AppearancePackageKind, packageId: string): string {
    return path.join(
      this.#stateRoot,
      "vaults",
      parseVaultId(vaultId),
      "current",
      `${kind}-${parsePackageId(packageId)}.json`,
    );
  }
  #historyRoot(vaultId: string, kind: AppearancePackageKind, packageId: string): string {
    return path.join(
      this.#stateRoot,
      "vaults",
      parseVaultId(vaultId),
      "history",
      kind,
      parsePackageId(packageId),
    );
  }
  #historySnapshotPath(
    vaultId: string,
    kind: AppearancePackageKind,
    packageId: string,
    snapshotId: string,
  ): string {
    if (!/^[A-Za-z0-9-]{1,200}$/u.test(snapshotId))
      throw new Error("Appearance history snapshot identity is invalid.");
    return path.join(this.#historyRoot(vaultId, kind, packageId), snapshotId);
  }
  #historyPackagePath(
    vaultId: string,
    kind: AppearancePackageKind,
    packageId: string,
    snapshotId: string,
  ): string {
    return path.join(this.#historySnapshotPath(vaultId, kind, packageId, snapshotId), "package");
  }
  #transactionsRoot(vaultId: string): string {
    return path.join(this.#stateRoot, "transactions", parseVaultId(vaultId));
  }
  #transactionPath(vaultId: string, transactionId: string): string {
    if (!uuidPattern.test(transactionId))
      throw new Error("Appearance transaction identity is invalid.");
    return path.join(this.#transactionsRoot(vaultId), transactionId);
  }
  #transactionJournalPath(vaultId: string, id: string): string {
    return path.join(this.#transactionPath(vaultId, id), "journal.json");
  }
  #transactionInventoryPath(vaultId: string, id: string): string {
    return path.join(this.#transactionPath(vaultId, id), "inventory-before.json");
  }
  #transactionReceiptPath(vaultId: string, id: string): string {
    return path.join(this.#transactionPath(vaultId, id), "receipt-before.json");
  }
  #stagePath(vaultPath: string, transaction: AppearanceTransactionJournal): string {
    return path.join(
      path.dirname(this.#targetPath(vaultPath, transaction.kind, transaction.packageId)),
      `.threadleaf-appearance-stage-${transaction.id}`,
    );
  }
  #rollbackPath(vaultPath: string, transaction: AppearanceTransactionJournal): string {
    return path.join(
      path.dirname(this.#targetPath(vaultPath, transaction.kind, transaction.packageId)),
      `.threadleaf-appearance-rollback-${transaction.id}`,
    );
  }
}
