import { createHash, randomUUID } from "node:crypto";
import { type Dirent, promises as fs } from "node:fs";
import path from "node:path";
import { atomicWriteFile, readStableFile, syncDirectory } from "../kernel/durability";
import { canonicalAuthorityJson } from "../shared/authority-json";
import { withPluginDiagnosticCode } from "../shared/plugin-diagnostics";
import type {
  ManagedPluginPackageHistory,
  ManagedPluginPackageSummary,
  PluginPackageApplyOutcome,
  PluginPackageAssetEvidence,
  PluginPackageIndexSnapshot,
  PluginPackageInspectionReceipt,
  PluginPackageLicenseEvidence,
  PluginPackagePreviewRequest,
  PluginPackageReview,
} from "../shared/plugin-packages";
import { type PluginManifestData, parsePluginId, parsePluginManifest } from "../shared/plugins";
import type { OpenPluginPackage, PluginPackageSource } from "./open-plugin-package-source";
import { verifyPluginPackageInspectionReceipt } from "./plugin-inspection-receipt";
import {
  exactInputFromPackage,
  inspectionReceiptFromReport,
  inspectPluginPackage,
  type PluginPackageInspectionReport,
} from "./plugin-package-inspection";

const reviewLifetimeMs = 15 * 60_000;
const maxHistoryEntries = 5;
const maxTreeEntries = 20_000;
const maxTreeBytes = 512 * 1024 * 1024;
const receiptFilename = ".threadleaf-package.json";
const retainedLicenseFilename = "LICENSE.threadleaf.txt";
const decoder = new TextDecoder("utf-8", { fatal: true });
const vaultIdPattern = /^[a-f0-9]{64}$/;

interface PackageReceipt {
  version: 1;
  pluginId: string;
  pluginVersion: string;
  repository: string | null;
  releaseUrl: string | null;
  indexUrl: string | null;
  indexSha256: string | null;
  installedAt: string;
  assets: Array<{ filename: string; sha256: string; size: number }>;
  license: {
    filename: string;
    name: string;
    sourceUrl: string;
    spdxId: string;
    sha256: string;
    size: number;
  } | null;
  inspection: PluginPackageInspectionReceipt;
}

function comparablePackageReceipt(receipt: PackageReceipt): string {
  const comparable = structuredClone(receipt);
  comparable.installedAt = "";
  comparable.indexSha256 = null;
  comparable.inspection.exactPackage.provenance.indexSha256 = null;
  return canonicalAuthorityJson(comparable);
}

interface InventoryFile {
  version: 1;
  packages: ManagedPluginPackageSummary[];
}

interface InternalReview {
  expectedTreeRevision: string | null;
  historySnapshotId: string | null;
  historySnapshotRevision: string | null;
  review: PluginPackageReview;
}

interface CapturedHistory {
  directoryPath: string;
  record: ManagedPluginPackageHistory;
}

interface PackageMetadataState {
  inventory: InventoryFile;
  receipt: Uint8Array | null;
}

type PackageTransactionPhase = "intent" | "staged" | "package-mutated" | "metadata-committed";

interface PackageTransactionJournal {
  version: 1;
  id: string;
  vaultId: string;
  pluginId: string;
  operation: PluginPackageReview["operation"];
  phase: PackageTransactionPhase;
  createdAt: string;
  expectedTreeRevision: string | null;
  nextTreeRevision: string | null;
  historySnapshotId: string | null;
  receiptBefore: boolean;
}

export interface PluginPackageManagerHooks {
  afterTransactionPhase?: (
    phase: PackageTransactionPhase,
    pluginId: string,
  ) => Promise<void> | void;
  inspectPackage?: (
    input: Parameters<typeof inspectPluginPackage>[0],
  ) => Promise<PluginPackageInspectionReport>;
}

const transactionPhases = new Set<PackageTransactionPhase>([
  "intent",
  "staged",
  "package-mutated",
  "metadata-committed",
]);
const packageOperations = new Set<PluginPackageReview["operation"]>([
  "install",
  "update",
  "reinstall",
  "rollback",
  "uninstall",
]);
const revisionPattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseVaultId(value: string): string {
  if (!vaultIdPattern.test(value)) {
    throw new Error("Plugin package operation requires a valid vault identity.");
  }
  return value;
}

function packageVersion(manifest: PluginManifestData | null): string | null {
  return manifest?.version ?? null;
}

function receiptBytes(receipt: PackageReceipt): Buffer {
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHistory(value: unknown): ManagedPluginPackageHistory {
  if (
    !isRecord(value) ||
    typeof value.snapshotId !== "string" ||
    !/^[A-Za-z0-9-]{1,200}$/u.test(value.snapshotId) ||
    typeof value.version !== "string" ||
    typeof value.capturedAt !== "string" ||
    Number.isNaN(Date.parse(value.capturedAt)) ||
    !["update", "reinstall", "uninstall", "rollback"].includes(String(value.reason))
  ) {
    throw new Error("Plugin package inventory contains an invalid history entry.");
  }
  return {
    snapshotId: value.snapshotId,
    version: value.version,
    capturedAt: value.capturedAt,
    reason: value.reason as ManagedPluginPackageHistory["reason"],
  };
}

function parseManagedSummary(value: unknown): ManagedPluginPackageSummary {
  if (
    !isRecord(value) ||
    typeof value.pluginId !== "string" ||
    (value.currentVersion !== null && typeof value.currentVersion !== "string") ||
    (value.repository !== null && typeof value.repository !== "string") ||
    (value.installedAt !== null && typeof value.installedAt !== "string") ||
    (value.integrity !== undefined &&
      !["verified", "changed", "not-installed"].includes(String(value.integrity))) ||
    !Array.isArray(value.history)
  ) {
    throw new Error("Plugin package inventory contains an invalid package entry.");
  }
  return {
    pluginId: parsePluginId(value.pluginId),
    currentVersion: value.currentVersion,
    repository: value.repository,
    installedAt: value.installedAt,
    integrity:
      (value.integrity as ManagedPluginPackageSummary["integrity"] | undefined) ??
      (value.currentVersion === null ? "not-installed" : "changed"),
    history: value.history.map(parseHistory),
  };
}

function parseInventory(value: unknown): InventoryFile {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.packages)) {
    throw new Error("Plugin package inventory must use version 1.");
  }
  const packages = value.packages.map(parseManagedSummary);
  if (new Set(packages.map((entry) => entry.pluginId)).size !== packages.length) {
    throw new Error("Plugin package inventory contains duplicate plugin identifiers.");
  }
  return { version: 1, packages };
}

function parseNullableRevision(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || !revisionPattern.test(value)) {
    throw new Error("Plugin package transaction contains an invalid revision.");
  }
  return value;
}

function parsePackageTransaction(
  value: unknown,
  expectedVaultId: string,
  expectedId: string,
): PackageTransactionJournal {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.id !== expectedId ||
    typeof value.id !== "string" ||
    !uuidPattern.test(value.id) ||
    value.vaultId !== expectedVaultId ||
    typeof value.pluginId !== "string" ||
    typeof value.operation !== "string" ||
    !packageOperations.has(value.operation as PluginPackageReview["operation"]) ||
    typeof value.phase !== "string" ||
    !transactionPhases.has(value.phase as PackageTransactionPhase) ||
    typeof value.createdAt !== "string" ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    !(value.historySnapshotId === null || typeof value.historySnapshotId === "string") ||
    typeof value.receiptBefore !== "boolean"
  ) {
    throw new Error("Plugin package transaction identity or shape is invalid.");
  }
  const pluginId = parsePluginId(value.pluginId);
  const expectedTreeRevision = parseNullableRevision(value.expectedTreeRevision);
  const nextTreeRevision = parseNullableRevision(value.nextTreeRevision);
  const historySnapshotId = value.historySnapshotId;
  if (
    (historySnapshotId !== null && !/^[A-Za-z0-9-]{1,200}$/u.test(historySnapshotId)) ||
    (expectedTreeRevision === null && historySnapshotId !== null) ||
    (value.phase === "intent" && nextTreeRevision !== null) ||
    (value.operation !== "uninstall" && value.phase !== "intent" && nextTreeRevision === null)
  ) {
    throw new Error("Plugin package transaction progress is inconsistent.");
  }
  return {
    version: 1,
    id: value.id,
    vaultId: expectedVaultId,
    pluginId,
    operation: value.operation as PluginPackageReview["operation"],
    phase: value.phase as PackageTransactionPhase,
    createdAt: value.createdAt,
    expectedTreeRevision,
    nextTreeRevision,
    historySnapshotId,
    receiptBefore: value.receiptBefore,
  };
}

async function pathKind(filePath: string): Promise<"directory" | "missing" | "other"> {
  try {
    const stat = await fs.lstat(filePath);
    return stat.isDirectory() && !stat.isSymbolicLink() ? "directory" : "other";
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return "missing";
    }
    throw error;
  }
}

async function currentManifest(directoryPath: string): Promise<PluginManifestData | null> {
  const snapshot = await readStableFile(path.join(directoryPath, "manifest.json"));
  if (!snapshot) {
    return null;
  }
  try {
    return parsePluginManifest(JSON.parse(decoder.decode(snapshot.bytes)));
  } catch {
    return null;
  }
}

async function directoryRevision(directoryPath: string): Promise<string | null> {
  const kind = await pathKind(directoryPath);
  if (kind === "missing") {
    return null;
  }
  if (kind !== "directory") {
    throw new Error("Plugin package target must be a real directory, not a file or symlink.");
  }
  const hash = createHash("sha256");
  const pending = [""];
  let entriesSeen = 0;
  let bytesSeen = 0;
  while (pending.length > 0) {
    const relativeDirectory = pending.pop() ?? "";
    const absoluteDirectory = path.join(directoryPath, relativeDirectory);
    const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en-US", { numeric: true }));
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > maxTreeEntries) {
        throw new Error(`Plugin package exceeds the ${maxTreeEntries} entry management limit.`);
      }
      const relativePath = relativeDirectory
        ? path.posix.join(relativeDirectory.split(path.sep).join("/"), entry.name)
        : entry.name;
      const absolutePath = path.join(absoluteDirectory, entry.name);
      hash.update(relativePath);
      hash.update("\0");
      if (entry.isDirectory()) {
        hash.update("directory\0");
        pending.push(path.join(relativeDirectory, entry.name));
      } else if (entry.isFile()) {
        hash.update("file\0");
        const snapshot = await readStableFile(absolutePath);
        if (!snapshot) {
          throw new Error(`Plugin package entry disappeared during review: ${relativePath}`);
        }
        bytesSeen += snapshot.size;
        if (bytesSeen > maxTreeBytes) {
          throw new Error("Plugin package exceeds the 512 MiB management limit.");
        }
        hash.update(snapshot.bytes);
      } else if (entry.isSymbolicLink()) {
        hash.update("symlink\0");
        hash.update(await fs.readlink(absolutePath));
      } else {
        throw new Error(`Plugin package contains an unsupported filesystem entry: ${relativePath}`);
      }
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

async function copyDirectoryExact(
  sourcePath: string,
  targetPath: string,
  expectedRevision: string,
): Promise<void> {
  await fs.cp(sourcePath, targetPath, {
    recursive: true,
    force: false,
    errorOnExist: true,
    dereference: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
  const [sourceRevision, targetRevision] = await Promise.all([
    directoryRevision(sourcePath),
    directoryRevision(targetPath),
  ]);
  if (sourceRevision !== expectedRevision || targetRevision !== expectedRevision) {
    throw new Error("Plugin package changed while its recoverable snapshot was being prepared.");
  }
}

async function removeTree(filePath: string): Promise<void> {
  await fs.rm(filePath, { recursive: true, force: true });
}

function receiptFromReview(review: PluginPackageReview, installedAt: string): PackageReceipt {
  if (!review.manifest || !review.inspection) {
    throw new Error(
      "Remote package review is missing its validated manifest or inspection receipt.",
    );
  }
  return {
    version: 1,
    pluginId: review.pluginId,
    pluginVersion: review.manifest.version,
    repository: review.repository,
    releaseUrl: review.releaseUrl,
    indexUrl: review.indexUrl,
    indexSha256: review.indexSha256,
    installedAt,
    assets: review.assets,
    license: review.license,
    inspection: review.inspection,
  };
}

export class PluginPackageManager {
  readonly #stateRoot: string;
  readonly #source: PluginPackageSource;
  readonly #reviews = new Map<string, InternalReview>();
  readonly #reviewExpiryTimers = new Map<string, NodeJS.Timeout>();
  readonly #clock: () => Date;
  readonly #hooks: PluginPackageManagerHooks;
  readonly #recoveryNotices = new Map<string, string[]>();

  constructor(
    stateRoot: string,
    source: PluginPackageSource,
    clock: () => Date = () => new Date(),
    hooks: PluginPackageManagerHooks = {},
  ) {
    this.#stateRoot = path.resolve(stateRoot);
    this.#source = source;
    this.#clock = clock;
    this.#hooks = hooks;
  }

  async #inspectRemotePackage(pkg: OpenPluginPackage): Promise<PluginPackageInspectionReceipt> {
    const input = exactInputFromPackage(pkg);
    const report = await (this.#hooks.inspectPackage?.(input) ?? inspectPluginPackage(input));
    return inspectionReceiptFromReport(report);
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
    const root = this.#transactionsRoot(vaultId);
    let entries: Dirent<string>[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return;
      }
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, "en-US"));
    for (const entry of entries) {
      if (!entry.isDirectory() || !uuidPattern.test(entry.name)) {
        throw new Error(
          `Plugin package recovery found an invalid transaction entry: ${entry.name}`,
        );
      }
      await this.#recoverTransactionDirectory(vaultPath, vaultId, entry.name, true);
    }
  }

  async search(
    vaultPath: string,
    vaultIdValue: string,
    queryValue: string,
  ): Promise<PluginPackageIndexSnapshot> {
    const vaultId = parseVaultId(vaultIdValue);
    const query = queryValue
      .replace(/[\r\n\t]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    if (query.length > 200) {
      throw new Error("Plugin registry search is limited to 200 characters.");
    }
    const [index, managed] = await Promise.all([
      this.#source.getIndex(),
      this.getManagedPackages(vaultPath, vaultId),
    ]);
    const normalized = query.toLocaleLowerCase("en-US");
    const managedIds = new Set(managed.map((entry) => entry.pluginId));
    const installed = await this.#installedVersions(vaultPath);
    const results = index.entries
      .filter((entry) =>
        [entry.name, entry.id, entry.author, entry.description, entry.repository]
          .join(" ")
          .toLocaleLowerCase("en-US")
          .includes(normalized),
      )
      .slice(0, 100)
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        author: entry.author,
        description: entry.description,
        repository: entry.repository,
        installedVersion: installed.get(entry.id) ?? null,
        managed: managedIds.has(entry.id),
      }));
    return {
      vaultId,
      query,
      sourceUrl: index.sourceUrl,
      sourceSha256: index.sha256,
      results,
    };
  }

  async preview(
    vaultPath: string,
    vaultIdValue: string,
    request: PluginPackagePreviewRequest,
  ): Promise<PluginPackageReview> {
    const vaultId = parseVaultId(vaultIdValue);
    await this.recoverVault(vaultPath, vaultId);
    const pluginId = parsePluginId(request.pluginId);
    const action = request.action;
    const pluginPath = this.#pluginPath(vaultPath, pluginId);
    const kind = await pathKind(pluginPath);
    if (kind === "other") {
      throw new Error("Plugin package target is not a real directory and cannot be managed.");
    }
    const expectedTreeRevision = await directoryRevision(pluginPath);
    const installedManifest = kind === "directory" ? await currentManifest(pluginPath) : null;
    const installedVersion =
      packageVersion(installedManifest) ?? (kind === "directory" ? "unknown" : null);
    const reviewId = randomUUID();
    const createdAt = this.#clock();
    const expiresAt = new Date(createdAt.getTime() + reviewLifetimeMs);

    if (action === "install") {
      const pkg = await this.#source.getPackage(pluginId, request.version);
      const inspection = await this.#inspectRemotePackage(pkg);
      const operation =
        kind === "missing"
          ? "install"
          : installedVersion === pkg.manifest.version
            ? "reinstall"
            : "update";
      const review: PluginPackageReview = {
        reviewId,
        vaultId,
        operation,
        pluginId,
        manifest: pkg.manifest,
        installedVersion,
        targetVersion: pkg.manifest.version,
        repository: pkg.repository,
        releaseUrl: pkg.releaseUrl,
        indexUrl: pkg.indexUrl,
        indexSha256: pkg.indexSha256,
        assets: pkg.assets.map((asset) => ({
          filename: asset.filename,
          sha256: asset.sha256,
          size: asset.bytes.byteLength,
        })),
        license: {
          filename: retainedLicenseFilename,
          name: pkg.license.name,
          sourceUrl: pkg.license.sourceUrl,
          spdxId: pkg.license.spdxId,
          sha256: pkg.license.sha256,
          size: pkg.license.bytes.byteLength,
        },
        inspection,
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        warnings: [
          ...pkg.warnings,
          "The package will be installed disabled and will not execute during this operation.",
          "Compatibility plugins are trusted desktop code, not sandboxed extensions.",
          inspection.overall === "pass"
            ? `Offline exact-package inspection passed at compatibility level ${inspection.compatibilityLevel}; static inspection is not a sandbox.`
            : `Offline exact-package inspection did not pass all gates; no compatibility level is claimed. Static inspection is not a sandbox.`,
          "Close other applications using this vault before applying the reviewed package.",
        ],
      };
      await this.#stageRemoteReview(review, pkg);
      this.#retainReview({
        expectedTreeRevision,
        historySnapshotId: null,
        historySnapshotRevision: null,
        review,
      });
      return review;
    }

    if (action === "uninstall") {
      if (kind !== "directory") {
        throw new Error(`Plugin ${pluginId} is not installed in this vault.`);
      }
      const review: PluginPackageReview = {
        reviewId,
        vaultId,
        operation: "uninstall",
        pluginId,
        manifest: installedManifest,
        installedVersion,
        targetVersion: null,
        repository: null,
        releaseUrl: null,
        indexUrl: null,
        indexSha256: null,
        assets: [],
        license: null,
        inspection: null,
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        warnings: [
          "The complete installed directory will be retained in private rollback history first.",
          "The plugin will be disabled and unloaded before its directory is removed.",
          "Close other applications using this vault before applying the reviewed uninstall.",
        ],
      };
      this.#retainReview({
        expectedTreeRevision,
        historySnapshotId: null,
        historySnapshotRevision: null,
        review,
      });
      return review;
    }

    const inventory = await this.#loadInventory(vaultId);
    const managed = inventory.packages.find((entry) => entry.pluginId === pluginId);
    const selected = request.version
      ? managed?.history.find((entry) => entry.version === request.version)
      : managed?.history[0];
    if (!selected) {
      throw new Error(
        `Plugin ${pluginId} has no retained rollback package${request.version ? ` for ${request.version}` : ""}.`,
      );
    }
    const snapshotPath = this.#historyPackagePath(vaultId, pluginId, selected.snapshotId);
    const historySnapshotRevision = await this.#requiredDirectoryRevision(snapshotPath);
    const manifest = await currentManifest(snapshotPath);
    if (!manifest || manifest.id !== pluginId) {
      throw new Error("Retained rollback package has an invalid manifest.");
    }
    const review: PluginPackageReview = {
      reviewId,
      vaultId,
      operation: "rollback",
      pluginId,
      manifest,
      installedVersion,
      targetVersion: manifest.version,
      repository: managed?.repository ?? null,
      releaseUrl: null,
      indexUrl: null,
      indexSha256: null,
      assets: await this.#assetEvidence(snapshotPath),
      license: await this.#licenseEvidence(snapshotPath),
      inspection: await this.#inspectionReceipt(snapshotPath),
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      warnings: [
        "Plugin data from the current installation is preserved while retained code assets are restored.",
        "The rolled-back package remains disabled until separately enabled after review.",
        "Close other applications using this vault before applying the reviewed rollback.",
      ],
    };
    this.#retainReview({
      expectedTreeRevision,
      historySnapshotId: selected.snapshotId,
      historySnapshotRevision,
      review,
    });
    return review;
  }

  async apply(
    vaultPath: string,
    vaultIdValue: string,
    reviewId: string,
  ): Promise<PluginPackageApplyOutcome> {
    const vaultId = parseVaultId(vaultIdValue);
    await this.recoverVault(vaultPath, vaultId);
    const pending = this.#reviews.get(reviewId);
    if (!pending || pending.review.vaultId !== vaultId) {
      throw new Error("Plugin package review is missing, expired, or belongs to another vault.");
    }
    if (Date.parse(pending.review.expiresAt) <= this.#clock().getTime()) {
      await this.#discardReview(reviewId);
      throw new Error("Plugin package review expired. Review the exact package again.");
    }
    this.#clearReviewExpiry(reviewId);
    try {
      const pluginId = parsePluginId(pending.review.pluginId);
      const pluginPath = this.#pluginPath(vaultPath, pluginId);
      const currentRevision = await directoryRevision(pluginPath);
      if (currentRevision !== pending.expectedTreeRevision) {
        throw withPluginDiagnosticCode(
          new Error("Installed plugin files changed after review. No package change was applied."),
          "package-review-stale",
        );
      }

      if (pending.review.operation === "uninstall") {
        return await this.#applyUninstall(vaultPath, vaultId, pending);
      }
      if (pending.review.operation === "rollback") {
        return await this.#applyRollback(vaultPath, vaultId, pending);
      }
      return await this.#applyRemote(vaultPath, vaultId, pending);
    } finally {
      await this.#discardReview(reviewId);
    }
  }

  reviewForApply(vaultIdValue: string, reviewId: string): PluginPackageReview {
    const vaultId = parseVaultId(vaultIdValue);
    const pending = this.#reviews.get(reviewId);
    if (!pending || pending.review.vaultId !== vaultId) {
      throw new Error("Plugin package review is missing, expired, or belongs to another vault.");
    }
    if (Date.parse(pending.review.expiresAt) <= this.#clock().getTime()) {
      throw new Error("Plugin package review expired. Review the exact package again.");
    }
    return pending.review;
  }

  async cancelReview(vaultIdValue: string, reviewId: string): Promise<void> {
    const review = this.reviewForApply(vaultIdValue, reviewId);
    if (review.reviewId !== reviewId) {
      throw new Error("Plugin package review identity changed unexpectedly.");
    }
    await this.#discardReview(reviewId);
  }

  async getManagedPackages(
    vaultPath: string,
    vaultIdValue: string,
  ): Promise<ManagedPluginPackageSummary[]> {
    const vaultId = parseVaultId(vaultIdValue);
    await this.recoverVault(vaultPath, vaultId);
    const inventory = await this.#loadInventory(vaultId);
    const result: ManagedPluginPackageSummary[] = [];
    for (const entry of inventory.packages) {
      const manifest = await currentManifest(this.#pluginPath(vaultPath, entry.pluginId));
      result.push({
        ...entry,
        currentVersion: manifest?.version ?? null,
        installedAt: manifest ? entry.installedAt : null,
        integrity: manifest
          ? await this.#verifyCurrentReceipt(vaultPath, vaultId, entry.pluginId)
          : "not-installed",
      });
    }
    return result.sort((left, right) => left.pluginId.localeCompare(right.pluginId, "en-US"));
  }

  async #applyRemote(
    vaultPath: string,
    vaultId: string,
    pending: InternalReview,
  ): Promise<PluginPackageApplyOutcome> {
    const review = pending.review;
    const pluginPath = this.#pluginPath(vaultPath, review.pluginId);
    const parentPath = path.dirname(pluginPath);
    await fs.mkdir(parentPath, { recursive: true });
    const metadataBefore = await this.#captureMetadataState(vaultId, review.pluginId);
    let transaction = await this.#beginTransaction(
      vaultId,
      review.pluginId,
      review.operation,
      pending.expectedTreeRevision,
      metadataBefore,
    );
    const stagingPath = this.#transactionStagingPath(vaultPath, transaction);
    const rollbackPath = this.#transactionRollbackPath(vaultPath, transaction);
    try {
      const history = transaction.historySnapshotId
        ? await this.#captureHistory(
            vaultId,
            review.pluginId,
            pluginPath,
            pending.expectedTreeRevision as string,
            review.operation === "reinstall" ? "reinstall" : "update",
            transaction.historySnapshotId,
          )
        : null;
      if (history) {
        await copyDirectoryExact(
          history.directoryPath,
          stagingPath,
          await this.#requiredDirectoryRevision(history.directoryPath),
        );
      } else {
        await fs.mkdir(stagingPath, { mode: 0o700 });
      }
      const receipt = receiptFromReview(review, this.#clock().toISOString());
      await this.#overlayRemoteReview(review.reviewId, stagingPath, review, receipt);
      const nextTreeRevision = await this.#requiredDirectoryRevision(stagingPath);
      transaction = await this.#setTransactionPhase(transaction, "staged", nextTreeRevision);
      await this.#swapDirectory(
        pluginPath,
        stagingPath,
        rollbackPath,
        pending.expectedTreeRevision,
        nextTreeRevision,
      );
      transaction = await this.#setTransactionPhase(
        transaction,
        "package-mutated",
        nextTreeRevision,
      );
      await this.#recordCurrent(vaultId, review.pluginId, receipt, history?.record ?? null);
      transaction = await this.#setTransactionPhase(
        transaction,
        "metadata-committed",
        nextTreeRevision,
      );
      await this.#finishTransaction(vaultPath, transaction);
      return {
        operation: review.operation,
        pluginId: review.pluginId,
        version: review.targetVersion,
        disabled: true,
      };
    } catch (error) {
      try {
        await this.#recoverTransactionDirectory(vaultPath, vaultId, transaction.id, false);
      } catch (recoveryError) {
        throw new Error(
          `Plugin package apply failed (${errorMessage(error)}), and automatic restoration also failed (${errorMessage(recoveryError)}). Retained history and transaction evidence were preserved.`,
        );
      }
      throw error;
    }
  }

  async #applyUninstall(
    vaultPath: string,
    vaultId: string,
    pending: InternalReview,
  ): Promise<PluginPackageApplyOutcome> {
    if (!pending.expectedTreeRevision) {
      throw new Error("Plugin disappeared before the reviewed uninstall.");
    }
    const review = pending.review;
    const pluginPath = this.#pluginPath(vaultPath, review.pluginId);
    const metadataBefore = await this.#captureMetadataState(vaultId, review.pluginId);
    let transaction = await this.#beginTransaction(
      vaultId,
      review.pluginId,
      "uninstall",
      pending.expectedTreeRevision,
      metadataBefore,
    );
    const rollbackPath = this.#transactionRollbackPath(vaultPath, transaction);
    try {
      const history = await this.#captureHistory(
        vaultId,
        review.pluginId,
        pluginPath,
        pending.expectedTreeRevision,
        "uninstall",
        transaction.historySnapshotId as string,
      );
      transaction = await this.#setTransactionPhase(transaction, "staged", null);
      await this.#removeDirectoryForTransaction(
        pluginPath,
        rollbackPath,
        pending.expectedTreeRevision,
      );
      transaction = await this.#setTransactionPhase(transaction, "package-mutated", null);
      await this.#recordRemoved(vaultId, review.pluginId, history.record);
      transaction = await this.#setTransactionPhase(transaction, "metadata-committed", null);
      await this.#finishTransaction(vaultPath, transaction);
      return { operation: "uninstall", pluginId: review.pluginId, version: null, disabled: true };
    } catch (error) {
      try {
        await this.#recoverTransactionDirectory(vaultPath, vaultId, transaction.id, false);
      } catch (recoveryError) {
        throw new Error(
          `Plugin uninstall failed (${errorMessage(error)}), and automatic restoration also failed (${errorMessage(recoveryError)}). Retained history and transaction evidence were preserved.`,
        );
      }
      throw error;
    }
  }

  async #applyRollback(
    vaultPath: string,
    vaultId: string,
    pending: InternalReview,
  ): Promise<PluginPackageApplyOutcome> {
    const review = pending.review;
    const snapshotId = pending.historySnapshotId;
    const expectedRetainedRevision = pending.historySnapshotRevision;
    if (!snapshotId || !expectedRetainedRevision || !review.manifest) {
      throw new Error("Rollback review is missing its retained package.");
    }
    const pluginPath = this.#pluginPath(vaultPath, review.pluginId);
    const retainedPath = this.#historyPackagePath(vaultId, review.pluginId, snapshotId);
    const retainedRevision = await this.#requiredDirectoryRevision(retainedPath);
    if (retainedRevision !== expectedRetainedRevision) {
      throw new Error(
        "Retained rollback package changed after review. No package change was applied.",
      );
    }
    const metadataBefore = await this.#captureMetadataState(vaultId, review.pluginId);
    let transaction = await this.#beginTransaction(
      vaultId,
      review.pluginId,
      "rollback",
      pending.expectedTreeRevision,
      metadataBefore,
    );
    const stagingPath = this.#transactionStagingPath(vaultPath, transaction);
    const rollbackPath = this.#transactionRollbackPath(vaultPath, transaction);
    try {
      const currentHistory = transaction.historySnapshotId
        ? await this.#captureHistory(
            vaultId,
            review.pluginId,
            pluginPath,
            pending.expectedTreeRevision as string,
            "rollback",
            transaction.historySnapshotId,
          )
        : null;
      if (currentHistory) {
        await copyDirectoryExact(
          currentHistory.directoryPath,
          stagingPath,
          await this.#requiredDirectoryRevision(currentHistory.directoryPath),
        );
        await this.#overlayRetainedAssets(
          retainedPath,
          stagingPath,
          review,
          expectedRetainedRevision,
        );
      } else {
        await copyDirectoryExact(retainedPath, stagingPath, retainedRevision);
      }
      const receipt = await this.#receiptForRetainedPackage(stagingPath, review);
      await atomicWriteFile(path.join(stagingPath, receiptFilename), receiptBytes(receipt));
      const nextTreeRevision = await this.#requiredDirectoryRevision(stagingPath);
      transaction = await this.#setTransactionPhase(transaction, "staged", nextTreeRevision);
      await this.#swapDirectory(
        pluginPath,
        stagingPath,
        rollbackPath,
        pending.expectedTreeRevision,
        nextTreeRevision,
      );
      transaction = await this.#setTransactionPhase(
        transaction,
        "package-mutated",
        nextTreeRevision,
      );
      await this.#recordCurrent(vaultId, review.pluginId, receipt, currentHistory?.record ?? null);
      transaction = await this.#setTransactionPhase(
        transaction,
        "metadata-committed",
        nextTreeRevision,
      );
      await this.#finishTransaction(vaultPath, transaction);
      return {
        operation: "rollback",
        pluginId: review.pluginId,
        version: review.targetVersion,
        disabled: true,
      };
    } catch (error) {
      try {
        await this.#recoverTransactionDirectory(vaultPath, vaultId, transaction.id, false);
      } catch (recoveryError) {
        throw new Error(
          `Plugin rollback failed (${errorMessage(error)}), and automatic restoration also failed (${errorMessage(recoveryError)}). Retained history and transaction evidence were preserved.`,
        );
      }
      throw error;
    }
  }

  async #captureHistory(
    vaultId: string,
    pluginId: string,
    sourcePath: string,
    expectedRevision: string,
    reason: ManagedPluginPackageHistory["reason"],
    snapshotIdValue?: string,
  ): Promise<CapturedHistory> {
    const snapshotId =
      snapshotIdValue ?? `${this.#clock().toISOString().replaceAll(/[-:.]/gu, "")}-${randomUUID()}`;
    const snapshotRoot = this.#historySnapshotPath(vaultId, pluginId, snapshotId);
    const directoryPath = path.join(snapshotRoot, "package");
    await fs.mkdir(snapshotRoot, { recursive: true, mode: 0o700 });
    try {
      await copyDirectoryExact(sourcePath, directoryPath, expectedRevision);
      const manifest = await currentManifest(directoryPath);
      const record: ManagedPluginPackageHistory = {
        snapshotId,
        version: manifest?.version ?? "unknown",
        capturedAt: this.#clock().toISOString(),
        reason,
      };
      await atomicWriteFile(
        path.join(snapshotRoot, "snapshot.json"),
        Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8"),
      );
      return { directoryPath, record };
    } catch (error) {
      await removeTree(snapshotRoot).catch(() => undefined);
      throw error;
    }
  }

  async #swapDirectory(
    targetPath: string,
    stagingPath: string,
    rollbackPath: string,
    expectedRevision: string | null,
    nextRevision: string,
  ): Promise<void> {
    const parentPath = path.dirname(targetPath);
    if (expectedRevision === null) {
      if ((await pathKind(targetPath)) !== "missing") {
        throw new Error("Plugin target appeared after review. No files were replaced.");
      }
      await fs.rename(stagingPath, targetPath);
      try {
        await syncDirectory(parentPath);
        if ((await directoryRevision(targetPath)) !== nextRevision) {
          throw new Error("Installed plugin changed during the final package swap.");
        }
      } catch (error) {
        await fs.rename(targetPath, stagingPath).catch(() => undefined);
        await syncDirectory(parentPath).catch(() => undefined);
        throw error;
      }
      return;
    }
    await fs.rename(targetPath, rollbackPath);
    await syncDirectory(parentPath);
    let replacementInstalled = false;
    try {
      if ((await directoryRevision(rollbackPath)) !== expectedRevision) {
        throw new Error(
          "Plugin changed during installation and was restored without modification.",
        );
      }
      await fs.rename(stagingPath, targetPath);
      replacementInstalled = true;
      await syncDirectory(parentPath);
      if ((await directoryRevision(targetPath)) !== nextRevision) {
        throw new Error("Installed plugin changed during the final package swap.");
      }
    } catch (error) {
      let recoveryFailure: unknown = null;
      try {
        if (replacementInstalled && (await pathKind(targetPath)) === "directory") {
          await removeTree(stagingPath).catch(() => undefined);
          await fs.rename(targetPath, stagingPath);
        }
        if (
          (await pathKind(targetPath)) === "missing" &&
          (await pathKind(rollbackPath)) === "directory"
        ) {
          await fs.rename(rollbackPath, targetPath);
        }
        await syncDirectory(parentPath);
      } catch (recoveryError) {
        recoveryFailure = recoveryError;
      }
      if (recoveryFailure) {
        throw new Error(
          `Plugin directory swap failed (${errorMessage(error)}), and restoring the original directory also failed (${errorMessage(recoveryFailure)}).`,
        );
      }
      throw error;
    }
  }

  async #removeDirectoryForTransaction(
    targetPath: string,
    rollbackPath: string,
    expectedRevision: string,
  ): Promise<void> {
    await fs.rename(targetPath, rollbackPath);
    await syncDirectory(path.dirname(targetPath));
    if ((await directoryRevision(rollbackPath)) === expectedRevision) {
      return;
    }
    await fs.rename(rollbackPath, targetPath).catch(() => undefined);
    await syncDirectory(path.dirname(targetPath)).catch(() => undefined);
    throw new Error("Plugin changed during uninstall and was restored without modification.");
  }

  async #stageRemoteReview(review: PluginPackageReview, pkg: OpenPluginPackage): Promise<void> {
    const reviewPath = this.#reviewPath(review.reviewId);
    await fs.mkdir(reviewPath, { recursive: true, mode: 0o700 });
    try {
      for (const asset of pkg.assets) {
        await atomicWriteFile(path.join(reviewPath, asset.filename), asset.bytes);
      }
      await atomicWriteFile(path.join(reviewPath, retainedLicenseFilename), pkg.license.bytes);
      await atomicWriteFile(
        path.join(reviewPath, "review.json"),
        Buffer.from(`${JSON.stringify(review, null, 2)}\n`, "utf8"),
      );
    } catch (error) {
      await removeTree(reviewPath).catch(() => undefined);
      throw error;
    }
  }

  async #overlayRemoteReview(
    reviewId: string,
    stagingPath: string,
    review: PluginPackageReview,
    receipt: PackageReceipt,
  ): Promise<void> {
    const reviewPath = this.#reviewPath(reviewId);
    const present = new Set<string>();
    for (const evidence of review.assets) {
      const snapshot = await readStableFile(path.join(reviewPath, evidence.filename));
      if (!snapshot || snapshot.size !== evidence.size || snapshot.revision !== evidence.sha256) {
        throw new Error(`Reviewed ${evidence.filename} bytes failed their integrity check.`);
      }
      present.add(evidence.filename);
      await atomicWriteFile(path.join(stagingPath, evidence.filename), snapshot.bytes);
    }
    if (!present.has("styles.css")) {
      await fs.rm(path.join(stagingPath, "styles.css"), { force: true });
    }
    if (!review.license) {
      throw new Error("Reviewed remote package is missing retained license evidence.");
    }
    const license = await readStableFile(path.join(reviewPath, retainedLicenseFilename));
    if (
      !license ||
      license.size !== review.license.size ||
      license.revision !== review.license.sha256
    ) {
      throw new Error("Reviewed license bytes failed their integrity check.");
    }
    await atomicWriteFile(path.join(stagingPath, retainedLicenseFilename), license.bytes);
    await atomicWriteFile(path.join(stagingPath, receiptFilename), receiptBytes(receipt));
  }

  async #overlayRetainedAssets(
    retainedPath: string,
    stagingPath: string,
    review: PluginPackageReview,
    expectedRevision: string,
  ): Promise<void> {
    const evidence = new Map(review.assets.map((asset) => [asset.filename, asset]));
    for (const filename of ["manifest.json", "main.js", "styles.css"] as const) {
      const expected = evidence.get(filename);
      const snapshot = await readStableFile(path.join(retainedPath, filename));
      if (
        (expected &&
          (!snapshot ||
            snapshot.size !== expected.size ||
            snapshot.revision !== expected.sha256)) ||
        (!expected && snapshot)
      ) {
        throw new Error(`Retained rollback ${filename} bytes changed after review.`);
      }
      if (snapshot) {
        await atomicWriteFile(path.join(stagingPath, filename), snapshot.bytes);
      } else {
        await fs.rm(path.join(stagingPath, filename), { force: true });
      }
    }
    const license = await readStableFile(path.join(retainedPath, retainedLicenseFilename));
    if (
      (review.license &&
        (!license ||
          license.size !== review.license.size ||
          license.revision !== review.license.sha256)) ||
      (!review.license && license)
    ) {
      throw new Error("Retained rollback license bytes changed after review.");
    }
    if (license) {
      await atomicWriteFile(path.join(stagingPath, retainedLicenseFilename), license.bytes);
    } else {
      await fs.rm(path.join(stagingPath, retainedLicenseFilename), { force: true });
    }
    if ((await this.#requiredDirectoryRevision(retainedPath)) !== expectedRevision) {
      throw new Error("Retained rollback package changed while its reviewed assets were prepared.");
    }
  }

  async #receiptForRetainedPackage(
    stagingPath: string,
    review: PluginPackageReview,
  ): Promise<PackageReceipt> {
    if (!review.manifest || !review.inspection) {
      throw new Error("Rollback package is missing a manifest or inspection receipt.");
    }
    const assets = await this.#assetEvidence(stagingPath);
    const license = await this.#licenseEvidence(stagingPath);
    return {
      version: 1,
      pluginId: review.pluginId,
      pluginVersion: review.manifest.version,
      repository: review.repository,
      releaseUrl: null,
      indexUrl: null,
      indexSha256: null,
      installedAt: this.#clock().toISOString(),
      assets,
      license,
      inspection: review.inspection,
    };
  }

  async #assetEvidence(directoryPath: string): Promise<PluginPackageAssetEvidence[]> {
    const assets: PluginPackageAssetEvidence[] = [];
    for (const filename of ["manifest.json", "main.js", "styles.css"] as const) {
      const snapshot = await readStableFile(path.join(directoryPath, filename));
      if (snapshot) {
        assets.push({ filename, sha256: snapshot.revision, size: snapshot.size });
      }
    }
    return assets;
  }

  async #licenseEvidence(directoryPath: string): Promise<PluginPackageLicenseEvidence | null> {
    const snapshot = await readStableFile(path.join(directoryPath, retainedLicenseFilename));
    if (!snapshot) {
      return null;
    }
    return {
      filename: retainedLicenseFilename,
      name: "Retained package license",
      sourceUrl: "retained rollback snapshot",
      spdxId: "UNKNOWN",
      sha256: snapshot.revision,
      size: snapshot.size,
    };
  }

  async #inspectionReceipt(directoryPath: string): Promise<PluginPackageInspectionReceipt> {
    const snapshot = await readStableFile(path.join(directoryPath, receiptFilename));
    if (!snapshot) {
      throw new Error("Retained rollback package is missing its inspection receipt.");
    }
    const parsed: unknown = JSON.parse(decoder.decode(snapshot.bytes));
    if (!isRecord(parsed) || !("inspection" in parsed)) {
      throw new Error("Retained rollback package is missing its inspection receipt.");
    }
    const manifestFile = await readStableFile(path.join(directoryPath, "manifest.json"));
    const mainFile = await readStableFile(path.join(directoryPath, "main.js"));
    const stylesFile = await readStableFile(path.join(directoryPath, "styles.css"));
    const manifest = manifestFile
      ? parsePluginManifest(JSON.parse(decoder.decode(manifestFile.bytes)))
      : null;
    if (!manifestFile || !manifest || !mainFile) {
      throw new Error("Retained rollback package is missing its inspected code assets.");
    }
    const manifestBytes = manifestFile.bytes;
    const verified = verifyPluginPackageInspectionReceipt(
      parsed.inspection,
      manifest.id,
      manifest,
      {
        manifest: manifestBytes,
        main: mainFile.bytes,
        styles: stylesFile?.bytes ?? null,
      },
    );
    if (!verified.receipt) {
      throw new Error(`Retained rollback package inspection is invalid: ${verified.error}`);
    }
    return verified.receipt;
  }

  async #recordCurrent(
    vaultId: string,
    pluginId: string,
    receipt: PackageReceipt,
    history: ManagedPluginPackageHistory | null,
  ): Promise<void> {
    const inventory = await this.#loadInventory(vaultId);
    const existing = inventory.packages.find((entry) => entry.pluginId === pluginId);
    const histories = [history, ...(existing?.history ?? [])].filter(
      (entry): entry is ManagedPluginPackageHistory => entry !== null,
    );
    const retained = histories.slice(0, maxHistoryEntries);
    inventory.packages = [
      ...inventory.packages.filter((entry) => entry.pluginId !== pluginId),
      {
        pluginId,
        currentVersion: receipt.pluginVersion,
        repository: receipt.repository,
        installedAt: receipt.installedAt,
        integrity: "verified",
        history: retained,
      },
    ];
    await atomicWriteFile(this.#currentReceiptPath(vaultId, pluginId), receiptBytes(receipt));
    await this.#saveInventory(vaultId, inventory);
  }

  async #recordRemoved(
    vaultId: string,
    pluginId: string,
    history: ManagedPluginPackageHistory,
  ): Promise<void> {
    const inventory = await this.#loadInventory(vaultId);
    const existing = inventory.packages.find((entry) => entry.pluginId === pluginId);
    const retained = [history, ...(existing?.history ?? [])].slice(0, maxHistoryEntries);
    inventory.packages = [
      ...inventory.packages.filter((entry) => entry.pluginId !== pluginId),
      {
        pluginId,
        currentVersion: null,
        repository: existing?.repository ?? null,
        installedAt: null,
        integrity: "not-installed",
        history: retained,
      },
    ];
    await this.#saveInventory(vaultId, inventory);
    await fs.rm(this.#currentReceiptPath(vaultId, pluginId), { force: true });
  }

  async #captureMetadataState(vaultId: string, pluginId: string): Promise<PackageMetadataState> {
    const [inventory, receipt] = await Promise.all([
      this.#loadInventory(vaultId),
      readStableFile(this.#currentReceiptPath(vaultId, pluginId)),
    ]);
    return { inventory, receipt: receipt?.bytes ?? null };
  }

  async #restoreMetadataState(
    vaultId: string,
    pluginId: string,
    state: PackageMetadataState,
  ): Promise<void> {
    let failure: unknown = null;
    try {
      await this.#saveInventory(vaultId, state.inventory);
    } catch (error) {
      failure = error;
    }
    try {
      if (state.receipt) {
        await atomicWriteFile(this.#currentReceiptPath(vaultId, pluginId), state.receipt);
      } else {
        await fs.rm(this.#currentReceiptPath(vaultId, pluginId), { force: true });
      }
    } catch (error) {
      failure ??= error;
    }
    if (failure) {
      throw failure;
    }
  }

  async #beginTransaction(
    vaultId: string,
    pluginId: string,
    operation: PluginPackageReview["operation"],
    expectedTreeRevision: string | null,
    metadataBefore: PackageMetadataState,
  ): Promise<PackageTransactionJournal> {
    const id = randomUUID();
    const createdAt = this.#clock().toISOString();
    const transaction: PackageTransactionJournal = {
      version: 1,
      id,
      vaultId,
      pluginId,
      operation,
      phase: "intent",
      createdAt,
      expectedTreeRevision,
      nextTreeRevision: null,
      historySnapshotId: expectedTreeRevision
        ? `${createdAt.replaceAll(/[-:.]/gu, "")}-${id}`
        : null,
      receiptBefore: metadataBefore.receipt !== null,
    };
    const transactionPath = this.#transactionPath(vaultId, id);
    await fs.mkdir(transactionPath, { recursive: true, mode: 0o700 });
    try {
      await atomicWriteFile(
        this.#transactionInventoryPath(vaultId, id),
        Buffer.from(`${JSON.stringify(metadataBefore.inventory, null, 2)}\n`, "utf8"),
      );
      if (metadataBefore.receipt) {
        await atomicWriteFile(this.#transactionReceiptPath(vaultId, id), metadataBefore.receipt);
      }
      await this.#writeTransaction(transaction);
      return transaction;
    } catch (error) {
      await removeTree(transactionPath).catch(() => undefined);
      throw error;
    }
  }

  async #setTransactionPhase(
    transaction: PackageTransactionJournal,
    phase: PackageTransactionPhase,
    nextTreeRevision: string | null,
  ): Promise<PackageTransactionJournal> {
    const next = { ...transaction, phase, nextTreeRevision };
    const parsed = parsePackageTransaction(next, transaction.vaultId, transaction.id);
    await this.#writeTransaction(parsed);
    return parsed;
  }

  async #writeTransaction(transaction: PackageTransactionJournal): Promise<void> {
    await atomicWriteFile(
      this.#transactionJournalPath(transaction.vaultId, transaction.id),
      Buffer.from(`${JSON.stringify(transaction, null, 2)}\n`, "utf8"),
    );
    await this.#hooks.afterTransactionPhase?.(transaction.phase, transaction.pluginId);
  }

  async #loadTransactionMetadata(
    transaction: PackageTransactionJournal,
  ): Promise<PackageMetadataState> {
    const [inventorySnapshot, receiptSnapshot] = await Promise.all([
      readStableFile(this.#transactionInventoryPath(transaction.vaultId, transaction.id)),
      readStableFile(this.#transactionReceiptPath(transaction.vaultId, transaction.id)),
    ]);
    if (!inventorySnapshot) {
      throw new Error("Plugin package recovery is missing its private inventory snapshot.");
    }
    if (transaction.receiptBefore !== Boolean(receiptSnapshot)) {
      throw new Error("Plugin package recovery receipt snapshot is inconsistent.");
    }
    return {
      inventory: parseInventory(JSON.parse(decoder.decode(inventorySnapshot.bytes))),
      receipt: receiptSnapshot?.bytes ?? null,
    };
  }

  async #recoverTransactionDirectory(
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
    const transaction = parsePackageTransaction(
      JSON.parse(decoder.decode(journalSnapshot.bytes)),
      vaultId,
      transactionId,
    );
    if (transaction.phase === "metadata-committed") {
      await this.#cleanupCommittedTransaction(vaultPath, transaction);
      if (recordNotice) {
        this.#appendRecoveryNotice(
          vaultId,
          `Completed cleanup for interrupted plugin package ${transaction.operation} of ${transaction.pluginId}; the reviewed package state was already committed.`,
        );
      }
      return;
    }

    const metadataBefore = await this.#loadTransactionMetadata(transaction);
    const recovery = await this.#restoreInterruptedPackage(vaultPath, transaction);
    await this.#restoreMetadataState(vaultId, transaction.pluginId, metadataBefore);
    if (recovery === "restored" && transaction.historySnapshotId) {
      await removeTree(
        this.#historySnapshotPath(vaultId, transaction.pluginId, transaction.historySnapshotId),
      );
    }
    await this.#cleanupTransactionPaths(vaultPath, transaction);
    await removeTree(this.#transactionPath(vaultId, transaction.id));
    if (recordNotice) {
      this.#appendRecoveryNotice(
        vaultId,
        recovery === "restored"
          ? `Recovered interrupted plugin package ${transaction.operation} for ${transaction.pluginId}; the previous package and private metadata were restored.`
          : `Recovered interrupted plugin package ${transaction.operation} for ${transaction.pluginId}; externally changed package bytes were preserved and remain disabled pending review.`,
      );
    }
  }

  async #discardUnstartedTransaction(
    vaultPath: string,
    vaultId: string,
    transactionId: string,
  ): Promise<void> {
    const transactionPath = this.#transactionPath(vaultId, transactionId);
    const entries = await fs.readdir(transactionPath, { withFileTypes: true });
    const temporaryName = new RegExp(
      `^\\.(?:inventory-before|receipt-before|journal)\\.json\\.${uuidPattern.source.slice(1, -1)}\\.tmp$`,
      "iu",
    );
    for (const entry of entries) {
      if (
        !entry.isFile() ||
        (!["inventory-before.json", "receipt-before.json"].includes(entry.name) &&
          !temporaryName.test(entry.name))
      ) {
        throw new Error(
          "Plugin package recovery found unfamiliar evidence before its durable journal.",
        );
      }
    }
    const inventory = await readStableFile(this.#transactionInventoryPath(vaultId, transactionId));
    if (inventory) {
      parseInventory(JSON.parse(decoder.decode(inventory.bytes)));
    }
    if (
      !inventory &&
      (await readStableFile(this.#transactionReceiptPath(vaultId, transactionId)))
    ) {
      throw new Error(
        "Plugin package recovery found a receipt snapshot without its prior inventory.",
      );
    }
    const pluginRoot = path.join(path.resolve(vaultPath), ".obsidian", "plugins");
    let pluginEntries: string[] = [];
    try {
      pluginEntries = await fs.readdir(pluginRoot);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw error;
      }
    }
    const transactionSuffix = `-${transactionId}`;
    if (
      pluginEntries.some(
        (entry) => entry.startsWith(".threadleaf-package-") && entry.endsWith(transactionSuffix),
      )
    ) {
      throw new Error(
        "Plugin package recovery is missing its journal but found vault transaction evidence.",
      );
    }
    await removeTree(transactionPath);
  }

  async #restoreInterruptedPackage(
    vaultPath: string,
    transaction: PackageTransactionJournal,
  ): Promise<"restored" | "external-preserved"> {
    const pluginPath = this.#pluginPath(vaultPath, transaction.pluginId);
    const stagingPath = this.#transactionStagingPath(vaultPath, transaction);
    const rollbackPath = this.#transactionRollbackPath(vaultPath, transaction);
    const recoveryPath = this.#transactionRecoveryPath(vaultPath, transaction);
    const parentPath = path.dirname(pluginPath);
    const targetRevision = await directoryRevision(pluginPath);

    if (transaction.phase === "intent") {
      if (targetRevision !== transaction.expectedTreeRevision) {
        await this.#cleanupKnownStaging(stagingPath, transaction.nextTreeRevision, true);
        return "external-preserved";
      }
      await this.#cleanupKnownStaging(stagingPath, transaction.nextTreeRevision, true);
      await removeTree(rollbackPath).catch(() => undefined);
      await removeTree(recoveryPath).catch(() => undefined);
      return "restored";
    }

    if (transaction.expectedTreeRevision === null) {
      if (targetRevision === null) {
        const stagingRevision = await directoryRevision(stagingPath);
        if (
          stagingRevision &&
          transaction.nextTreeRevision &&
          stagingRevision !== transaction.nextTreeRevision
        ) {
          await fs.rename(stagingPath, pluginPath);
          await syncDirectory(parentPath);
          return "external-preserved";
        }
        await this.#cleanupKnownStaging(stagingPath, transaction.nextTreeRevision, false);
        return "restored";
      }
      if (targetRevision !== transaction.nextTreeRevision) {
        await this.#cleanupKnownStaging(stagingPath, transaction.nextTreeRevision, false);
        return "external-preserved";
      }
      await this.#moveExpectedTargetAside(pluginPath, stagingPath, transaction.nextTreeRevision);
      await removeTree(stagingPath);
      await syncDirectory(parentPath);
      return "restored";
    }

    if (targetRevision === transaction.expectedTreeRevision) {
      await this.#cleanupKnownStaging(stagingPath, transaction.nextTreeRevision, false);
      const rollbackRevision = await directoryRevision(rollbackPath);
      if (rollbackRevision && rollbackRevision !== transaction.expectedTreeRevision) {
        throw new Error("Interrupted plugin rollback directory changed outside Threadleaf.");
      }
      await removeTree(rollbackPath).catch(() => undefined);
      await removeTree(recoveryPath).catch(() => undefined);
      return "restored";
    }

    if (targetRevision !== null && targetRevision !== transaction.nextTreeRevision) {
      const rollbackRevision = await directoryRevision(rollbackPath);
      if (rollbackRevision !== null) {
        throw new Error(
          "Interrupted package and rollback directories both changed; all evidence was preserved for manual recovery.",
        );
      }
      await this.#cleanupKnownStaging(stagingPath, transaction.nextTreeRevision, false);
      return "external-preserved";
    }

    if (targetRevision !== null && targetRevision === transaction.nextTreeRevision) {
      await this.#moveExpectedTargetAside(pluginPath, stagingPath, transaction.nextTreeRevision);
    }
    const rollbackRevision = await directoryRevision(rollbackPath);
    if (rollbackRevision !== null && rollbackRevision !== transaction.expectedTreeRevision) {
      throw new Error("Interrupted plugin rollback bytes changed outside Threadleaf.");
    }
    if (rollbackRevision === transaction.expectedTreeRevision) {
      await fs.rename(rollbackPath, pluginPath);
      await syncDirectory(parentPath);
    } else {
      if (!transaction.historySnapshotId) {
        throw new Error("Interrupted plugin package recovery has no retained prior package.");
      }
      const historyPath = this.#historyPackagePath(
        transaction.vaultId,
        transaction.pluginId,
        transaction.historySnapshotId,
      );
      const historyRevision = await this.#requiredDirectoryRevision(historyPath);
      if (historyRevision !== transaction.expectedTreeRevision) {
        throw new Error("Retained interrupted package no longer matches its reviewed revision.");
      }
      await removeTree(recoveryPath).catch(() => undefined);
      await copyDirectoryExact(historyPath, recoveryPath, historyRevision);
      await fs.rename(recoveryPath, pluginPath);
      await syncDirectory(parentPath);
    }
    if ((await directoryRevision(pluginPath)) !== transaction.expectedTreeRevision) {
      throw new Error("Interrupted plugin package could not be restored exactly.");
    }
    await this.#cleanupKnownStaging(stagingPath, transaction.nextTreeRevision, false);
    await removeTree(recoveryPath).catch(() => undefined);
    return "restored";
  }

  async #moveExpectedTargetAside(
    targetPath: string,
    stagingPath: string,
    expectedRevision: string | null,
  ): Promise<void> {
    if (!expectedRevision) {
      throw new Error("Plugin package recovery is missing the installed package revision.");
    }
    await this.#cleanupKnownStaging(stagingPath, expectedRevision, false);
    await fs.rename(targetPath, stagingPath);
    await syncDirectory(path.dirname(targetPath));
    if ((await directoryRevision(stagingPath)) === expectedRevision) {
      return;
    }
    await fs.rename(stagingPath, targetPath).catch(() => undefined);
    await syncDirectory(path.dirname(targetPath)).catch(() => undefined);
    throw new Error("Plugin package changed during interruption recovery; no bytes were removed.");
  }

  async #cleanupKnownStaging(
    stagingPath: string,
    expectedRevision: string | null,
    allowPartial: boolean,
  ): Promise<void> {
    const kind = await pathKind(stagingPath);
    if (kind === "missing") {
      return;
    }
    if (kind !== "directory") {
      throw new Error("Plugin package staging path is not a real directory.");
    }
    if (!allowPartial && (await directoryRevision(stagingPath)) !== expectedRevision) {
      throw new Error("Plugin package staging bytes changed outside Threadleaf.");
    }
    await removeTree(stagingPath);
  }

  async #finishTransaction(
    vaultPath: string,
    transaction: PackageTransactionJournal,
  ): Promise<void> {
    try {
      await this.#cleanupCommittedTransaction(vaultPath, transaction);
    } catch {
      // A metadata-committed journal is sufficient for deterministic cleanup on the next launch.
    }
  }

  async #cleanupCommittedTransaction(
    vaultPath: string,
    transaction: PackageTransactionJournal,
  ): Promise<void> {
    await this.#cleanupTransactionPaths(vaultPath, transaction);
    await this.#pruneRecordedHistory(transaction.vaultId, transaction.pluginId);
    await removeTree(this.#transactionPath(transaction.vaultId, transaction.id));
  }

  async #cleanupTransactionPaths(
    vaultPath: string,
    transaction: PackageTransactionJournal,
  ): Promise<void> {
    const paths = [
      this.#transactionStagingPath(vaultPath, transaction),
      this.#transactionRollbackPath(vaultPath, transaction),
      this.#transactionRecoveryPath(vaultPath, transaction),
    ];
    for (const ownedPath of paths) {
      const kind = await pathKind(ownedPath);
      if (kind === "missing") {
        continue;
      }
      if (kind !== "directory") {
        throw new Error("Plugin package transaction path is not a real directory.");
      }
      const revision = await directoryRevision(ownedPath);
      if (
        revision !== transaction.nextTreeRevision &&
        revision !== transaction.expectedTreeRevision
      ) {
        throw new Error("Plugin package transaction evidence changed outside Threadleaf.");
      }
      await removeTree(ownedPath);
    }
    await syncDirectory(path.dirname(this.#pluginPath(vaultPath, transaction.pluginId)));
  }

  async #pruneRecordedHistory(vaultId: string, pluginId: string): Promise<void> {
    const inventory = await this.#loadInventory(vaultId);
    const retained = inventory.packages.find((entry) => entry.pluginId === pluginId)?.history ?? [];
    await this.#pruneHistory(vaultId, pluginId, retained);
  }

  #appendRecoveryNotice(vaultId: string, notice: string): void {
    const current = this.#recoveryNotices.get(vaultId) ?? [];
    if (!current.includes(notice)) {
      current.push(notice);
      this.#recoveryNotices.set(vaultId, current);
    }
  }

  async #pruneHistory(
    vaultId: string,
    pluginId: string,
    retained: ManagedPluginPackageHistory[],
  ): Promise<void> {
    const historyRoot = this.#historyRoot(vaultId, pluginId);
    let entries: string[];
    try {
      entries = await fs.readdir(historyRoot);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return;
      }
      throw error;
    }
    const keep = new Set(retained.map((entry) => entry.snapshotId));
    await Promise.all(
      entries
        .filter((entry) => !keep.has(entry))
        .map((entry) => removeTree(path.join(historyRoot, entry))),
    );
  }

  async #installedVersions(vaultPath: string): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const root = path.join(vaultPath, ".obsidian", "plugins");
    let entries: Dirent<string>[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return result;
      }
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".threadleaf-")) {
        continue;
      }
      try {
        const id = parsePluginId(entry.name);
        const manifest = await currentManifest(path.join(root, entry.name));
        if (manifest?.id === id) {
          result.set(id, manifest.version);
        }
      } catch {
        // Invalid existing packages remain available in the local catalog instead.
      }
    }
    return result;
  }

  async #loadInventory(vaultId: string): Promise<InventoryFile> {
    const snapshot = await readStableFile(this.#inventoryPath(vaultId));
    return snapshot
      ? parseInventory(JSON.parse(decoder.decode(snapshot.bytes)))
      : { version: 1, packages: [] };
  }

  async #saveInventory(vaultId: string, inventory: InventoryFile): Promise<void> {
    const normalized = parseInventory(inventory);
    normalized.packages.sort((left, right) => left.pluginId.localeCompare(right.pluginId, "en-US"));
    await atomicWriteFile(
      this.#inventoryPath(vaultId),
      Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`, "utf8"),
    );
  }

  async #requiredDirectoryRevision(directoryPath: string): Promise<string> {
    const revision = await directoryRevision(directoryPath);
    if (!revision) {
      throw new Error("Retained plugin package disappeared.");
    }
    return revision;
  }

  async #verifyCurrentReceipt(
    vaultPath: string,
    vaultId: string,
    pluginId: string,
  ): Promise<"verified" | "changed"> {
    try {
      const snapshot = await readStableFile(this.#currentReceiptPath(vaultId, pluginId));
      if (!snapshot) {
        return "changed";
      }
      const parsed: unknown = JSON.parse(decoder.decode(snapshot.bytes));
      if (
        !isRecord(parsed) ||
        parsed.version !== 1 ||
        parsed.pluginId !== pluginId ||
        typeof parsed.pluginVersion !== "string" ||
        !parsed.pluginVersion.trim() ||
        !Array.isArray(parsed.assets) ||
        !("inspection" in parsed) ||
        (parsed.license !== null && !isRecord(parsed.license))
      ) {
        return "changed";
      }
      const receipt = parsed as unknown as PackageReceipt;
      const allowedAssets = new Set(["manifest.json", "main.js", "styles.css"]);
      const assets = new Map<string, { sha256: string; size: number }>();
      for (const asset of receipt.assets) {
        if (
          !isRecord(asset) ||
          typeof asset.filename !== "string" ||
          !allowedAssets.has(asset.filename) ||
          assets.has(asset.filename) ||
          typeof asset.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/u.test(asset.sha256) ||
          typeof asset.size !== "number" ||
          !Number.isSafeInteger(asset.size) ||
          asset.size < 0
        ) {
          return "changed";
        }
        assets.set(asset.filename, { sha256: asset.sha256, size: asset.size });
      }
      if (!assets.has("manifest.json") || !assets.has("main.js")) {
        return "changed";
      }
      const directoryPath = this.#pluginPath(vaultPath, pluginId);
      const assetSnapshots = new Map<string, { bytes: Buffer; size: number; revision: string }>();
      for (const filename of allowedAssets) {
        const evidence = assets.get(filename);
        const installed = await readStableFile(path.join(directoryPath, filename));
        if (
          (evidence &&
            (!installed ||
              installed.size !== evidence.size ||
              installed.revision !== evidence.sha256)) ||
          (!evidence && installed)
        ) {
          return "changed";
        }
        if (installed) {
          assetSnapshots.set(filename, installed);
        }
      }
      const manifest = await currentManifest(directoryPath);
      if (!manifest || manifest.id !== pluginId || manifest.version !== receipt.pluginVersion) {
        return "changed";
      }
      const inspection = verifyPluginPackageInspectionReceipt(
        parsed.inspection,
        pluginId,
        manifest,
        {
          manifest: assetSnapshots.get("manifest.json")?.bytes ?? Buffer.alloc(0),
          main: assetSnapshots.get("main.js")?.bytes ?? Buffer.alloc(0),
          styles: assetSnapshots.get("styles.css")?.bytes ?? null,
        },
      );
      if (!inspection.receipt) {
        return "changed";
      }
      const installedReceipt = await readStableFile(path.join(directoryPath, receiptFilename));
      if (!installedReceipt) {
        return "changed";
      }
      const installedParsed: unknown = JSON.parse(decoder.decode(installedReceipt.bytes));
      if (!isRecord(installedParsed) || !("inspection" in installedParsed)) {
        return "changed";
      }
      const installedInspection = verifyPluginPackageInspectionReceipt(
        installedParsed.inspection,
        pluginId,
        manifest,
        {
          manifest: assetSnapshots.get("manifest.json")?.bytes ?? Buffer.alloc(0),
          main: assetSnapshots.get("main.js")?.bytes ?? Buffer.alloc(0),
          styles: assetSnapshots.get("styles.css")?.bytes ?? null,
        },
      );
      if (
        !installedInspection.receipt ||
        comparablePackageReceipt(installedParsed as unknown as PackageReceipt) !==
          comparablePackageReceipt(receipt)
      ) {
        return "changed";
      }
      const installedLicense = await readStableFile(
        path.join(directoryPath, retainedLicenseFilename),
      );
      if (receipt.license) {
        if (
          receipt.license.filename !== retainedLicenseFilename ||
          typeof receipt.license.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/u.test(receipt.license.sha256) ||
          !Number.isSafeInteger(receipt.license.size) ||
          receipt.license.size < 0 ||
          !installedLicense ||
          installedLicense.size !== receipt.license.size ||
          installedLicense.revision !== receipt.license.sha256
        ) {
          return "changed";
        }
      } else if (installedLicense) {
        return "changed";
      }
      return "verified";
    } catch {
      return "changed";
    }
  }

  async #discardReview(reviewId: string): Promise<void> {
    this.#clearReviewExpiry(reviewId);
    this.#reviews.delete(reviewId);
    await removeTree(this.#reviewPath(reviewId));
  }

  #clearReviewExpiry(reviewId: string): void {
    const timer = this.#reviewExpiryTimers.get(reviewId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.#reviewExpiryTimers.delete(reviewId);
  }

  #retainReview(pending: InternalReview): void {
    const reviewId = pending.review.reviewId;
    this.#reviews.set(reviewId, pending);
    const timer = setTimeout(
      async () => await this.#discardReview(reviewId).catch(() => undefined),
      Math.max(0, Date.parse(pending.review.expiresAt) - this.#clock().getTime()),
    );
    timer.unref();
    this.#reviewExpiryTimers.set(reviewId, timer);
  }

  #pluginPath(vaultPath: string, pluginId: string): string {
    return path.join(path.resolve(vaultPath), ".obsidian", "plugins", parsePluginId(pluginId));
  }

  #inventoryPath(vaultId: string): string {
    return path.join(this.#stateRoot, "vaults", parseVaultId(vaultId), "inventory.json");
  }

  #currentReceiptPath(vaultId: string, pluginId: string): string {
    return path.join(
      this.#stateRoot,
      "vaults",
      parseVaultId(vaultId),
      "current",
      `${parsePluginId(pluginId)}.json`,
    );
  }

  #historyRoot(vaultId: string, pluginId: string): string {
    return path.join(
      this.#stateRoot,
      "vaults",
      parseVaultId(vaultId),
      "history",
      parsePluginId(pluginId),
    );
  }

  #historySnapshotPath(vaultId: string, pluginId: string, snapshotId: string): string {
    if (!/^[A-Za-z0-9-]{1,200}$/u.test(snapshotId)) {
      throw new Error("Plugin history snapshot identity is invalid.");
    }
    return path.join(this.#historyRoot(vaultId, pluginId), snapshotId);
  }

  #historyPackagePath(vaultId: string, pluginId: string, snapshotId: string): string {
    return path.join(this.#historySnapshotPath(vaultId, pluginId, snapshotId), "package");
  }

  #reviewsPath(): string {
    return path.join(this.#stateRoot, "reviews");
  }

  #reviewPath(reviewId: string): string {
    if (!/^[a-f0-9-]{36}$/u.test(reviewId)) {
      throw new Error("Plugin package review identity is invalid.");
    }
    return path.join(this.#reviewsPath(), reviewId);
  }

  #transactionsRoot(vaultId: string): string {
    return path.join(this.#stateRoot, "transactions", parseVaultId(vaultId));
  }

  #transactionPath(vaultId: string, transactionId: string): string {
    if (!uuidPattern.test(transactionId)) {
      throw new Error("Plugin package transaction identity is invalid.");
    }
    return path.join(this.#transactionsRoot(vaultId), transactionId);
  }

  #transactionJournalPath(vaultId: string, transactionId: string): string {
    return path.join(this.#transactionPath(vaultId, transactionId), "journal.json");
  }

  #transactionInventoryPath(vaultId: string, transactionId: string): string {
    return path.join(this.#transactionPath(vaultId, transactionId), "inventory-before.json");
  }

  #transactionReceiptPath(vaultId: string, transactionId: string): string {
    return path.join(this.#transactionPath(vaultId, transactionId), "receipt-before.json");
  }

  #transactionStagingPath(vaultPath: string, transaction: PackageTransactionJournal): string {
    return path.join(
      path.dirname(this.#pluginPath(vaultPath, transaction.pluginId)),
      `.threadleaf-package-stage-${transaction.id}`,
    );
  }

  #transactionRollbackPath(vaultPath: string, transaction: PackageTransactionJournal): string {
    return path.join(
      path.dirname(this.#pluginPath(vaultPath, transaction.pluginId)),
      `.threadleaf-package-rollback-${transaction.id}`,
    );
  }

  #transactionRecoveryPath(vaultPath: string, transaction: PackageTransactionJournal): string {
    return path.join(
      path.dirname(this.#pluginPath(vaultPath, transaction.pluginId)),
      `.threadleaf-package-recovery-${transaction.id}`,
    );
  }
}
