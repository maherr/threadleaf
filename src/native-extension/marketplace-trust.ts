import { createHash, createPublicKey, type KeyObject, sign, verify } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { nativeExtensionAuthorityDigest, nativeExtensionBundleSha256 } from "./digest";
import { type NativeExtensionManifest, parseNativeExtensionManifest } from "./manifest";
import type { NativeExtensionBundle } from "./sdk";

/** The first offline distribution envelope. Bump only with a compatibility decision. */
export const nativeExtensionDistributionVersion = 1 as const;
export const nativeExtensionSignatureAlgorithm = "ed25519" as const;
export const nativeExtensionIndexVersion = 1 as const;
export const nativeExtensionMarketplaceCatalogVersion = 1 as const;
export const nativeExtensionKeyRotationVersion = 1 as const;
export const nativeExtensionMarketplaceSuccessorVersion = 1 as const;
/** Signed catalogs are accepted only for this fixed local freshness window. */
export const nativeExtensionMarketplaceCatalogMaxAgeMs = 31 * 24 * 60 * 60 * 1_000;
/** @deprecated Use nativeExtensionMarketplaceCatalogMaxAgeMs. */
export const nativeExtensionMarketplaceIndexMaxAgeMs = nativeExtensionMarketplaceCatalogMaxAgeMs;

/** Ed25519's canonical DER SubjectPublicKeyInfo is one fixed 44-byte shape. */
export const nativeExtensionEd25519SpkiBytes = 44 as const;
export const nativeExtensionEd25519PublicKeyBase64urlLength = 59 as const;
/** An Ed25519 signature is exactly 64 bytes, encoded as 86 unpadded base64url characters. */
export const nativeExtensionEd25519SignatureBytes = 64 as const;
export const nativeExtensionEd25519SignatureBase64urlLength = 86 as const;

export type NativeExtensionSignatureAlgorithm = typeof nativeExtensionSignatureAlgorithm;

export interface NativeExtensionPublisherKey {
  publisherId: string;
  keyId: string;
  algorithm: NativeExtensionSignatureAlgorithm;
  /** Base64url-encoded DER SubjectPublicKeyInfo. */
  publicKey: string;
  /** SHA-256 of the DER SubjectPublicKeyInfo, prefixed for display. */
  fingerprint: string;
}

export interface NativeExtensionPublisherKeyRotation {
  rotationVersion: typeof nativeExtensionKeyRotationVersion;
  previous: NativeExtensionPublisherKey;
  effectiveAt: string;
  /** Ed25519 signature by `previous` over the previous and current key identities. */
  signature: string;
}

export interface NativeExtensionSignedManifest {
  distributionVersion: typeof nativeExtensionDistributionVersion;
  manifest: NativeExtensionManifest;
  bundleSha256: string;
  /** Digest of the complete installed package tree, including package metadata. */
  packageTreeSha256?: string;
  authorityDigest: string;
  publisher: NativeExtensionPublisherKey;
  issuedAt: string;
  expiresAt: string;
  revokedAt?: string;
  delistedAt?: string;
  keyRotation?: NativeExtensionPublisherKeyRotation;
  /** Base64url-encoded 64-byte Ed25519 signature over every other field. */
  signature: string;
}

export interface NativeExtensionTrustedPublisherKey extends NativeExtensionPublisherKey {
  /** A trust anchor can be retired without changing old signed records. */
  revokedAt?: string;
}

export interface NativeExtensionTrustAnchorSet {
  version: 1;
  publishers: NativeExtensionTrustedPublisherKey[];
  /** Offline roots that are allowed to sign catalog envelopes and successor paths. */
  catalogRoots?: NativeExtensionTrustedPublisherKey[];
}

export interface NativeExtensionMarketplaceIndex {
  indexVersion: typeof nativeExtensionIndexVersion;
  generatedAt: string;
  expiresAt: string;
  /** @deprecated Unsigned indexes are parseable for migration diagnostics, never trusted. */
  entries: NativeExtensionSignedManifest[];
}

export interface NativeExtensionMarketplaceCatalogEntryState {
  extensionId: string;
  version: string;
  at: string;
  /** Optional identity evidence for an irreversible lifecycle transition. */
  bundleSha256?: string;
  authorityDigest?: string;
  packageTreeSha256?: string;
  metadataSha256?: string;
}

export interface NativeExtensionMarketplaceTombstone
  extends NativeExtensionMarketplaceCatalogEntryState {
  tombstonedAt: string;
  reason?: string;
}

export interface NativeExtensionMarketplaceEntryIdentity {
  key: string;
  extensionId: string;
  version: string;
  bundleSha256: string;
  authorityDigest: string;
  packageTreeSha256: string;
  metadataSha256: string;
}

/** A root-authorized successor statement, used for publisher and catalog-root transitions. */
export interface NativeExtensionMarketplaceSuccessor {
  successorVersion: typeof nativeExtensionMarketplaceSuccessorVersion;
  previous: NativeExtensionPublisherKey;
  next: NativeExtensionPublisherKey;
  issuedAt: string;
  effectiveAt: string;
  /** Signature by the catalog root over the complete successor statement. */
  signature: string;
}

/** Signed catalog transport. The root, revision, digest, lifecycle state, and entries are all signed. */
export interface NativeExtensionMarketplaceCatalog {
  catalogVersion: typeof nativeExtensionMarketplaceCatalogVersion;
  revision: number;
  generatedAt: string;
  expiresAt: string;
  catalogRoot: NativeExtensionPublisherKey;
  entriesSha256: string;
  entries: NativeExtensionSignedManifest[];
  revocations: NativeExtensionMarketplaceCatalogEntryState[];
  delistings: NativeExtensionMarketplaceCatalogEntryState[];
  /** Irreversible package identities. A tombstoned key can never be re-added. */
  tombstones?: NativeExtensionMarketplaceTombstone[];
  /** Successor path for a rotated catalog root. */
  successorPath: NativeExtensionMarketplaceSuccessor[];
  /** Root-owned publisher successor statements. */
  publisherSuccessors: NativeExtensionMarketplaceSuccessor[];
  /** Base64url-encoded 64-byte Ed25519 signature over every other catalog field. */
  signature: string;
}

export interface NativeExtensionAcceptedMarketplaceCatalog {
  stateVersion: 1;
  revision: number;
  catalogSha256: string;
  generatedAt: string;
  expiresAt: string;
  entryKeys: string[];
  successorHashes: string[];
  /** Complete identity evidence for every accepted active entry. */
  entryIdentities?: NativeExtensionMarketplaceEntryIdentity[];
  /** Complete identity evidence for every irreversible tombstone. */
  tombstones?: NativeExtensionMarketplaceTombstone[];
}

export interface NativeExtensionMarketplaceCatalogStateStore {
  get(): NativeExtensionAcceptedMarketplaceCatalog | undefined;
  put(state: NativeExtensionAcceptedMarketplaceCatalog): void;
  /**
   * Required atomic compare-and-swap. Catalog acceptance always goes through this call, never
   * through `put`, so an interleaved writer cannot silently drop a tombstone. A store that does
   * not implement it is refused at the boundary rather than degraded.
   */
  compareAndSwap(
    expectedCatalogSha256: string | null,
    state: NativeExtensionAcceptedMarketplaceCatalog,
  ): void;
}

/**
 * The interface member is required, so this only catches a JavaScript caller that ignores the
 * type. It runs before any catalog work and outside the interleaving handler, so the failure says
 * what is actually wrong instead of reporting a lost update.
 */
function assertCompareAndSwapStore(
  store: NativeExtensionMarketplaceCatalogStateStore | undefined,
): void {
  if (store !== undefined && typeof store.compareAndSwap !== "function") {
    throw new Error(
      "Native extension marketplace catalog state store must implement compareAndSwap.",
    );
  }
}

export class InMemoryNativeExtensionMarketplaceCatalogStateStore
  implements NativeExtensionMarketplaceCatalogStateStore
{
  #state: NativeExtensionAcceptedMarketplaceCatalog | undefined;

  get(): NativeExtensionAcceptedMarketplaceCatalog | undefined {
    return this.#state === undefined
      ? undefined
      : {
          ...this.#state,
          entryKeys: [...this.#state.entryKeys],
          successorHashes: [...this.#state.successorHashes],
          ...(this.#state.entryIdentities === undefined
            ? {}
            : { entryIdentities: this.#state.entryIdentities.map((entry) => ({ ...entry })) }),
          ...(this.#state.tombstones === undefined
            ? {}
            : { tombstones: this.#state.tombstones.map((entry) => ({ ...entry })) }),
        };
  }

  put(state: NativeExtensionAcceptedMarketplaceCatalog): void {
    const parsed = parseAcceptedCatalogState(state);
    const previous = this.#state;
    if (previous) {
      if (parsed.revision < previous.revision) {
        throw new Error("Native extension marketplace catalog state cannot move backwards.");
      }
      if (
        parsed.revision === previous.revision &&
        parsed.catalogSha256 !== previous.catalogSha256
      ) {
        throw new Error("Native extension marketplace catalog state cannot replay a revision.");
      }
      if (parsed.generatedAt < previous.generatedAt) {
        throw new Error("Native extension marketplace catalog state cannot freeze generatedAt.");
      }
    }
    this.#state = cloneAcceptedCatalogState(parsed);
  }

  compareAndSwap(
    expectedCatalogSha256: string | null,
    state: NativeExtensionAcceptedMarketplaceCatalog,
  ): void {
    const current = this.#state?.catalogSha256 ?? null;
    if (current !== expectedCatalogSha256) {
      throw new Error("Native extension marketplace catalog compare-and-swap lost an update.");
    }
    this.put(state);
  }
}

interface NativeExtensionMarketplaceCatalogStateFile {
  stateVersion: 1;
  accepted: NativeExtensionAcceptedMarketplaceCatalog;
}

function cloneAcceptedCatalogState(
  state: NativeExtensionAcceptedMarketplaceCatalog,
): NativeExtensionAcceptedMarketplaceCatalog {
  return {
    ...state,
    entryKeys: [...state.entryKeys],
    successorHashes: [...state.successorHashes],
    ...(state.entryIdentities === undefined
      ? {}
      : { entryIdentities: state.entryIdentities.map((entry) => ({ ...entry })) }),
    ...(state.tombstones === undefined
      ? {}
      : { tombstones: state.tombstones.map((entry) => ({ ...entry })) }),
  };
}

function parseAcceptedCatalogState(value: unknown): NativeExtensionAcceptedMarketplaceCatalog {
  if (!isRecord(value) || value.stateVersion !== 1) {
    throw new Error("Native extension marketplace catalog state has an unsupported shape.");
  }
  if (
    Object.keys(value).some(
      (key) =>
        ![
          "stateVersion",
          "revision",
          "catalogSha256",
          "generatedAt",
          "expiresAt",
          "entryKeys",
          "successorHashes",
          "entryIdentities",
          "tombstones",
        ].includes(key),
    ) ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    typeof value.catalogSha256 !== "string" ||
    !hashPattern.test(value.catalogSha256) ||
    typeof value.generatedAt !== "string" ||
    !timestampPattern.test(value.generatedAt) ||
    typeof value.expiresAt !== "string" ||
    !timestampPattern.test(value.expiresAt) ||
    !Array.isArray(value.entryKeys) ||
    value.entryKeys.length > 10_000 ||
    !value.entryKeys.every(
      (key) => typeof key === "string" && key.length > 0 && key.length <= 300,
    ) ||
    new Set(value.entryKeys).size !== value.entryKeys.length ||
    !Array.isArray(value.successorHashes) ||
    value.successorHashes.length > 20_000 ||
    !value.successorHashes.every((hash) => typeof hash === "string" && hashPattern.test(hash)) ||
    new Set(value.successorHashes).size !== value.successorHashes.length
  ) {
    throw new Error("Native extension marketplace catalog state is malformed.");
  }
  const generatedAt = parseTimestamp(value.generatedAt, "state.generatedAt");
  const expiresAt = parseTimestamp(value.expiresAt, "state.expiresAt");
  if (expiresAt <= generatedAt) {
    throw new Error("Native extension marketplace catalog state has an invalid validity window.");
  }
  const entryIdentities = parseAcceptedEntryIdentities(value.entryIdentities);
  const tombstones = parseTombstones(value.tombstones, "state.tombstones");
  if (entryIdentities !== undefined) {
    const activeKeys = new Set(value.entryKeys);
    if (
      entryIdentities.length !== activeKeys.size ||
      entryIdentities.some((identity) => !activeKeys.has(identity.key))
    ) {
      throw new Error(
        "Native extension marketplace catalog state identities do not match entries.",
      );
    }
  }
  if (tombstones !== undefined) {
    const activeKeys = new Set(value.entryKeys);
    if (
      tombstones.some((tombstone) =>
        activeKeys.has(catalogEntryKey(tombstone.extensionId, tombstone.version)),
      )
    ) {
      throw new Error("Native extension marketplace catalog state tombstone is still active.");
    }
  }
  return {
    stateVersion: 1,
    revision: value.revision,
    catalogSha256: value.catalogSha256,
    generatedAt,
    expiresAt,
    entryKeys: [...value.entryKeys],
    successorHashes: [...value.successorHashes],
    ...(entryIdentities === undefined ? {} : { entryIdentities }),
    ...(tombstones === undefined ? {} : { tombstones }),
  };
}

/** Durable monotonic state for hosts that need rollback/replay protection across restarts. */
export class FileNativeExtensionMarketplaceCatalogStateStore
  implements NativeExtensionMarketplaceCatalogStateStore
{
  readonly #filePath: string;

  constructor(filePath: string) {
    this.#filePath = path.resolve(filePath);
  }

  get(): NativeExtensionAcceptedMarketplaceCatalog | undefined {
    if (!existsSync(this.#filePath)) {
      return undefined;
    }
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.#filePath, "utf8"));
    } catch {
      throw new Error("Native extension marketplace catalog state is not valid JSON.");
    }
    if (
      !isRecord(value) ||
      value.stateVersion !== 1 ||
      Object.keys(value).some((key) => !["stateVersion", "accepted"].includes(key))
    ) {
      throw new Error("Native extension marketplace catalog state file has unknown fields.");
    }
    return cloneAcceptedCatalogState(parseAcceptedCatalogState(value.accepted));
  }

  put(state: NativeExtensionAcceptedMarketplaceCatalog): void {
    const parsed = parseAcceptedCatalogState(state);
    withSynchronousFileLock(this.#filePath, () => {
      const previous = this.get();
      assertMonotonicCatalogState(previous, parsed);
      mkdirSync(path.dirname(this.#filePath), { recursive: true, mode: 0o700 });
      const temporaryPath = `${this.#filePath}.${process.pid}.${Date.now()}.tmp`;
      const file: NativeExtensionMarketplaceCatalogStateFile = {
        stateVersion: 1,
        accepted: parsed,
      };
      writeFileSync(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, this.#filePath);
      chmodSync(this.#filePath, 0o600);
    });
  }

  compareAndSwap(
    expectedCatalogSha256: string | null,
    state: NativeExtensionAcceptedMarketplaceCatalog,
  ): void {
    const parsed = parseAcceptedCatalogState(state);
    withSynchronousFileLock(this.#filePath, () => {
      const previous = this.get();
      if ((previous?.catalogSha256 ?? null) !== expectedCatalogSha256) {
        throw new Error("Native extension marketplace catalog compare-and-swap lost an update.");
      }
      assertMonotonicCatalogState(previous, parsed);
      mkdirSync(path.dirname(this.#filePath), { recursive: true, mode: 0o700 });
      const temporaryPath = `${this.#filePath}.${process.pid}.${Date.now()}.tmp`;
      const file: NativeExtensionMarketplaceCatalogStateFile = {
        stateVersion: 1,
        accepted: parsed,
      };
      writeFileSync(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, this.#filePath);
      chmodSync(this.#filePath, 0o600);
    });
  }
}

function assertMonotonicCatalogState(
  previous: NativeExtensionAcceptedMarketplaceCatalog | undefined,
  parsed: NativeExtensionAcceptedMarketplaceCatalog,
): void {
  if (!previous) return;
  if (parsed.revision < previous.revision) {
    throw new Error("Native extension marketplace catalog state cannot move backwards.");
  }
  if (parsed.revision === previous.revision && parsed.catalogSha256 !== previous.catalogSha256) {
    throw new Error("Native extension marketplace catalog state cannot replay a revision.");
  }
  if (parsed.generatedAt < previous.generatedAt) {
    throw new Error("Native extension marketplace catalog state cannot freeze generatedAt.");
  }
}

/**
 * A cross-process lock for catalog state.
 *
 * There is deliberately no automatic stale-lock break. This lock guards the compare-and-swap that
 * makes catalog acceptance safe against interleaving, and every cheap recovery rule is unsound
 * here: a recorded pid can be reused by an unrelated process, an age threshold cannot tell a
 * crashed owner from a slow one, and breaking a live owner's lock is precisely the lost update the
 * lock exists to prevent. So an abnormal termination such as SIGKILL leaves the lock file behind
 * and every later catalog write fails until an operator removes it. The failure names the path and
 * the recorded owner so that removal is an obvious, checkable step rather than a mystery.
 */
function withSynchronousFileLock<T>(filePath: string, action: () => T): T {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const lockPath = `${filePath}.lock`;
  let descriptor: number | undefined;
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      Atomics.wait(waitBuffer, 0, 0, 2);
    }
  }
  if (descriptor === undefined) {
    throw new Error(
      `Native extension marketplace catalog state lock timed out. ${describeLockOwner(lockPath)} If that process is gone, this lock is stale and must be removed by hand; it is never broken automatically, because breaking a live owner's lock would lose the update the lock protects.`,
    );
  }
  try {
    // Recorded for the operator who has to decide whether the owner is still alive. It is
    // diagnostic only and is never read back as an authority.
    writeFileSync(
      descriptor,
      `${JSON.stringify({ pid: process.pid, hostname: hostname(), at: new Date().toISOString() })}\n`,
      "utf8",
    );
    return action();
  } finally {
    closeSync(descriptor);
    try {
      unlinkSync(lockPath);
    } catch {
      // The lock is advisory. The state write already completed; a later caller can retry.
    }
  }
}

function describeLockOwner(lockPath: string): string {
  let owner = "";
  try {
    owner = readFileSync(lockPath, "utf8").trim();
  } catch {
    // The holder released the lock while this caller was giving up; the retry will succeed.
    return `Lock file ${lockPath} was released while waiting, so this call can simply be retried.`;
  }
  return owner.length === 0
    ? `Lock file ${lockPath} records no owner.`
    : `Lock file ${lockPath} is held by ${owner}.`;
}

export interface NativeExtensionTrustOptions {
  trustedPublishers: readonly NativeExtensionTrustedPublisherKey[] | NativeExtensionTrustAnchorSet;
  trustedCatalogRoots?: readonly NativeExtensionTrustedPublisherKey[];
  /** Deterministic verification clock for offline import and tests. Defaults to host UTC now. */
  now?: string;
  /** Installed package tree identity. Defaults to the bundle digest for legacy byte-only bundles. */
  packageTreeSha256?: string;
}

export type NativeExtensionTrustFailureCode =
  | "invalid-metadata"
  | "unsupported-version"
  | "invalid-publisher-key"
  | "invalid-signature"
  | "untrusted-publisher"
  | "key-revoked"
  | "key-rotation-invalid"
  | "not-yet-valid"
  | "expired"
  | "revoked"
  | "delisted"
  | "bundle-mismatch"
  | "authority-mismatch"
  | "index-expired"
  | "catalog-expired"
  | "catalog-untrusted"
  | "catalog-signature-invalid"
  | "catalog-rollback"
  | "catalog-replay"
  | "catalog-freeze"
  | "catalog-omission"
  | "catalog-state-mismatch"
  | "catalog-rebind"
  | "catalog-tombstoned"
  | "catalog-interleaving"
  | "catalog-successor-invalid"
  | "duplicate-entry"
  | "duplicate-trust-anchor";

export class NativeExtensionTrustError extends Error {
  readonly code: NativeExtensionTrustFailureCode;
  readonly publisherFingerprint: string | null;

  constructor(
    code: NativeExtensionTrustFailureCode,
    message: string,
    publisherFingerprint: string | null = null,
  ) {
    super(message);
    this.name = "NativeExtensionTrustError";
    this.code = code;
    this.publisherFingerprint = publisherFingerprint;
  }
}

export interface NativeExtensionVerification {
  status: "trusted";
  metadata: NativeExtensionSignedManifest;
  metadataSha256: string;
  publisherFingerprint: string;
  publisherId: string;
  publisherKeyId: string;
  metadataIssuedAt: string;
  metadataExpiresAt: string;
  metadataRevokedAt: string | null;
  metadataDelistedAt: string | null;
  keyTrust: "direct" | "rotated";
  bundleSha256: string;
  packageTreeSha256: string;
  authorityDigest: string;
  trustedPublishers: NativeExtensionTrustedPublisherKey[];
  marketplaceIndexTrust: NativeExtensionMarketplaceIndexTrust;
  marketplaceCatalogRevision: number | null;
  marketplaceCatalogSha256: string | null;
  marketplaceCatalogRootFingerprint: string | null;
}

export type NativeExtensionMarketplaceIndexTrust = "not-applicable" | "signed-catalog";

export interface NativeExtensionTrustProvenance {
  distributionTrust: "trusted-distribution" | "unsigned-development";
  metadataSha256: string | null;
  publisherId: string | null;
  publisherKeyId: string | null;
  publisherFingerprint: string | null;
  keyTrust: "direct" | "rotated" | "none";
  marketplaceIndex: NativeExtensionMarketplaceIndexTrust;
  marketplaceCatalogRevision: number | null;
  marketplaceCatalogSha256: string | null;
  marketplaceCatalogRootFingerprint: string | null;
  packageTreeSha256: string | null;
  installedTreeEvidence: "signed-package-tree" | "bundle-only" | "none";
}

export interface NativeExtensionSignedManifestInput {
  manifest: NativeExtensionManifest | unknown;
  bundleBytes: Uint8Array;
  packageTreeSha256?: string;
  publisher: NativeExtensionPublisherKey;
  issuedAt: string;
  expiresAt: string;
  revokedAt?: string;
  delistedAt?: string;
  keyRotation?: NativeExtensionPublisherKeyRotation;
}

export interface NativeExtensionKeyRotationInput {
  previous: NativeExtensionPublisherKey;
  next: NativeExtensionPublisherKey;
  effectiveAt: string;
}

const hashPattern = /^[a-f0-9]{64}$/u;
const fingerprintPattern = /^sha256:[a-f0-9]{64}$/u;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const keyIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const base64urlPattern = /^[A-Za-z0-9_-]+$/u;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trustFailure(
  code: NativeExtensionTrustFailureCode,
  message: string,
  publisherFingerprint: string | null = null,
): never {
  throw new NativeExtensionTrustError(code, message, publisherFingerprint);
}

function assertOnlyKeys(value: RecordValue, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      trustFailure("invalid-metadata", `${label} contains unknown field ${key}.`);
    }
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      trustFailure("invalid-metadata", "Signed metadata cannot contain a non-finite number.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  trustFailure("invalid-metadata", "Signed metadata contains an unsupported value.");
}

/** The exact byte representation signed by this module. Useful for independent implementations. */
export function canonicalizeNativeExtensionTrustMetadata(value: unknown): string {
  return canonicalJson(value);
}

/** Digest of the normalized signed envelope, including its signature and lifecycle metadata. */
export function nativeExtensionSignedManifestSha256(value: unknown): string {
  const metadata = parseNativeExtensionSignedManifest(value);
  return createHash("sha256").update(canonicalJson(metadata), "utf8").digest("hex");
}

function encodeBase64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function decodeBase64url(value: unknown, label: string, maximumBytes: number): Buffer {
  if (typeof value !== "string" || value.length === 0 || !base64urlPattern.test(value)) {
    trustFailure("invalid-metadata", `${label} must be unpadded base64url.`);
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    trustFailure("invalid-metadata", `${label} is not valid base64url.`);
  }
  if (decoded.length === 0 || decoded.length > maximumBytes || encodeBase64url(decoded) !== value) {
    trustFailure("invalid-metadata", `${label} has a non-canonical length or encoding.`);
  }
  return decoded;
}

function parseTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !timestampPattern.test(value)) {
    trustFailure(
      "invalid-metadata",
      `${label} must be an ISO-8601 UTC timestamp with milliseconds.`,
    );
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    trustFailure("invalid-metadata", `${label} is not a valid timestamp.`);
  }
  return value;
}

function parseIdentifier(
  value: unknown,
  label: string,
  pattern: RegExp = identifierPattern,
): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    trustFailure("invalid-metadata", `${label} is invalid.`);
  }
  return value;
}

function publicKeyObjectFromDer(bytes: Uint8Array, fingerprint: string | null = null): KeyObject {
  if (bytes.length !== nativeExtensionEd25519SpkiBytes) {
    trustFailure(
      "invalid-publisher-key",
      `Publisher Ed25519 SPKI must be exactly ${nativeExtensionEd25519SpkiBytes} bytes.`,
      fingerprint,
    );
  }
  try {
    const key = createPublicKey({ key: Buffer.from(bytes), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== nativeExtensionSignatureAlgorithm) {
      trustFailure(
        "invalid-publisher-key",
        "Publisher key is not an Ed25519 public key.",
        fingerprint,
      );
    }
    let exported: Buffer;
    try {
      exported = key.export({ format: "der", type: "spki" });
    } catch {
      trustFailure(
        "invalid-publisher-key",
        "Publisher public key cannot be exported.",
        fingerprint,
      );
    }
    if (!Buffer.from(bytes).equals(exported)) {
      trustFailure(
        "invalid-publisher-key",
        "Publisher public key is not canonical Ed25519 SPKI.",
        fingerprint,
      );
    }
    return key;
  } catch (error) {
    if (error instanceof NativeExtensionTrustError) throw error;
    trustFailure("invalid-publisher-key", "Publisher public key is not valid DER.", fingerprint);
  }
}

function publicKeyDer(key: KeyObject): Buffer {
  const publicKey = createPublicKey(key);
  if (publicKey.asymmetricKeyType !== nativeExtensionSignatureAlgorithm) {
    trustFailure("invalid-publisher-key", "Publisher key is not an Ed25519 key.");
  }
  try {
    const der = publicKey.export({ format: "der", type: "spki" });
    if (der.length !== nativeExtensionEd25519SpkiBytes) {
      trustFailure(
        "invalid-publisher-key",
        `Publisher Ed25519 SPKI must be exactly ${nativeExtensionEd25519SpkiBytes} bytes.`,
      );
    }
    return der;
  } catch {
    trustFailure("invalid-publisher-key", "Publisher key cannot be exported as SPKI.");
  }
}

/** Returns the stable display and comparison identity for a publisher key. */
export function nativeExtensionPublisherFingerprint(key: KeyObject | Uint8Array): string {
  const der = key instanceof Uint8Array ? Buffer.from(key) : publicKeyDer(key);
  publicKeyObjectFromDer(der);
  return `sha256:${createHash("sha256").update(der).digest("hex")}`;
}

/** Builds a public publisher identity without exposing or serializing a private key. */
export function nativeExtensionPublisherKeyFromKeyObject(options: {
  publisherId: string;
  keyId: string;
  key: KeyObject;
}): NativeExtensionPublisherKey {
  const publisherId = parseIdentifier(options.publisherId, "publisherId");
  const keyId = parseIdentifier(options.keyId, "keyId", keyIdentifierPattern);
  const der = publicKeyDer(options.key);
  const publicKey = encodeBase64url(der);
  return {
    publisherId,
    keyId,
    algorithm: nativeExtensionSignatureAlgorithm,
    publicKey,
    fingerprint: nativeExtensionPublisherFingerprint(der),
  };
}

function normalizePublisherKey(value: unknown, label: string): NativeExtensionPublisherKey {
  if (!isRecord(value)) trustFailure("invalid-metadata", `${label} must be an object.`);
  assertOnlyKeys(value, ["publisherId", "keyId", "algorithm", "publicKey", "fingerprint"], label);
  const publisherId = parseIdentifier(value.publisherId, `${label}.publisherId`);
  const keyId = parseIdentifier(value.keyId, `${label}.keyId`, keyIdentifierPattern);
  if (value.algorithm !== nativeExtensionSignatureAlgorithm) {
    trustFailure("invalid-publisher-key", `${label}.algorithm must be ed25519.`);
  }
  if (typeof value.fingerprint !== "string" || !fingerprintPattern.test(value.fingerprint)) {
    trustFailure("invalid-publisher-key", `${label}.fingerprint is invalid.`);
  }
  if (
    typeof value.publicKey !== "string" ||
    value.publicKey.length !== nativeExtensionEd25519PublicKeyBase64urlLength
  ) {
    trustFailure(
      "invalid-publisher-key",
      `Publisher Ed25519 publicKey must be the canonical ${nativeExtensionEd25519SpkiBytes}-byte SPKI.`,
    );
  }
  const der = decodeBase64url(
    value.publicKey,
    `${label}.publicKey`,
    nativeExtensionEd25519SpkiBytes,
  );
  if (der.length !== nativeExtensionEd25519SpkiBytes) {
    trustFailure(
      "invalid-publisher-key",
      `Publisher Ed25519 publicKey must be the canonical ${nativeExtensionEd25519SpkiBytes}-byte SPKI.`,
    );
  }
  const fingerprint = nativeExtensionPublisherFingerprint(der);
  if (fingerprint !== value.fingerprint) {
    trustFailure("invalid-publisher-key", `${label}.fingerprint does not match its public key.`);
  }
  publicKeyObjectFromDer(der, fingerprint);
  return {
    publisherId,
    keyId,
    algorithm: nativeExtensionSignatureAlgorithm,
    publicKey: encodeBase64url(der),
    fingerprint,
  };
}

function parseManifestStrict(value: unknown): NativeExtensionManifest {
  if (!isRecord(value))
    trustFailure("invalid-metadata", "Signed extension manifest must be an object.");
  assertOnlyKeys(
    value,
    [
      "manifestVersion",
      "apiVersion",
      "id",
      "name",
      "version",
      "entrypoint",
      "portable",
      "desktopOnly",
      "capabilities",
    ],
    "manifest",
  );
  if (Array.isArray(value.capabilities)) {
    for (const [index, capability] of value.capabilities.entries()) {
      if (isRecord(capability)) {
        assertOnlyKeys(capability, ["id", "reason"], `manifest.capabilities[${index}]`);
      }
    }
  }
  try {
    return parseNativeExtensionManifest(value);
  } catch (error) {
    trustFailure(
      "invalid-metadata",
      error instanceof Error ? error.message : "Signed extension manifest is invalid.",
    );
  }
}

function parseRotation(value: unknown): NativeExtensionPublisherKeyRotation {
  if (!isRecord(value)) trustFailure("key-rotation-invalid", "Key rotation must be an object.");
  assertOnlyKeys(value, ["rotationVersion", "previous", "effectiveAt", "signature"], "keyRotation");
  if (value.rotationVersion !== nativeExtensionKeyRotationVersion) {
    trustFailure("key-rotation-invalid", "Unsupported key rotation version.");
  }
  const previous = normalizePublisherKey(value.previous, "keyRotation.previous");
  const effectiveAt = parseTimestamp(value.effectiveAt, "keyRotation.effectiveAt");
  const signature = decodeBase64url(value.signature, "keyRotation.signature", 64);
  if (signature.length !== 64) {
    trustFailure("key-rotation-invalid", "Key rotation signature must be 64 bytes.");
  }
  return {
    rotationVersion: nativeExtensionKeyRotationVersion,
    previous,
    effectiveAt,
    signature: encodeBase64url(signature),
  };
}

function signedPayload(
  metadata: NativeExtensionSignedManifest,
): Omit<NativeExtensionSignedManifest, "signature"> {
  const payload: Omit<NativeExtensionSignedManifest, "signature"> = {
    distributionVersion: nativeExtensionDistributionVersion,
    manifest: metadata.manifest,
    bundleSha256: metadata.bundleSha256,
    ...(metadata.packageTreeSha256 === undefined
      ? {}
      : { packageTreeSha256: metadata.packageTreeSha256 }),
    authorityDigest: metadata.authorityDigest,
    publisher: metadata.publisher,
    issuedAt: metadata.issuedAt,
    expiresAt: metadata.expiresAt,
    ...(metadata.revokedAt === undefined ? {} : { revokedAt: metadata.revokedAt }),
    ...(metadata.delistedAt === undefined ? {} : { delistedAt: metadata.delistedAt }),
    ...(metadata.keyRotation === undefined ? {} : { keyRotation: metadata.keyRotation }),
  };
  return payload;
}

function rotationPayload(
  publisher: NativeExtensionPublisherKey,
  rotation: NativeExtensionPublisherKeyRotation,
): RecordValue {
  return {
    rotationVersion: nativeExtensionKeyRotationVersion,
    publisherId: publisher.publisherId,
    previous: rotation.previous,
    next: publisher,
    effectiveAt: rotation.effectiveAt,
  };
}

function comparePublisherKeys(
  left: NativeExtensionPublisherKey,
  right: NativeExtensionPublisherKey,
): boolean {
  return (
    left.publisherId === right.publisherId &&
    left.keyId === right.keyId &&
    left.algorithm === right.algorithm &&
    left.publicKey === right.publicKey &&
    left.fingerprint === right.fingerprint
  );
}

/** Parse and normalize a signed record before any signature or bundle operation. */
export function parseNativeExtensionSignedManifest(value: unknown): NativeExtensionSignedManifest {
  if (!isRecord(value))
    trustFailure("invalid-metadata", "Signed extension metadata must be an object.");
  assertOnlyKeys(
    value,
    [
      "distributionVersion",
      "manifest",
      "bundleSha256",
      "packageTreeSha256",
      "authorityDigest",
      "publisher",
      "issuedAt",
      "expiresAt",
      "revokedAt",
      "delistedAt",
      "keyRotation",
      "signature",
    ],
    "signed manifest",
  );
  if (value.distributionVersion !== nativeExtensionDistributionVersion) {
    trustFailure("unsupported-version", "Unsupported native extension distribution version.");
  }
  const manifest = parseManifestStrict(value.manifest);
  if (typeof value.bundleSha256 !== "string" || !hashPattern.test(value.bundleSha256)) {
    trustFailure("invalid-metadata", "bundleSha256 must be a lowercase SHA-256 digest.");
  }
  if (
    value.packageTreeSha256 !== undefined &&
    (typeof value.packageTreeSha256 !== "string" || !hashPattern.test(value.packageTreeSha256))
  ) {
    trustFailure("invalid-metadata", "packageTreeSha256 must be a lowercase SHA-256 digest.");
  }
  if (typeof value.authorityDigest !== "string" || !hashPattern.test(value.authorityDigest)) {
    trustFailure("invalid-metadata", "authorityDigest must be a lowercase SHA-256 digest.");
  }
  const publisher = normalizePublisherKey(value.publisher, "publisher");
  const issuedAt = parseTimestamp(value.issuedAt, "issuedAt");
  const expiresAt = parseTimestamp(value.expiresAt, "expiresAt");
  if (expiresAt <= issuedAt) {
    trustFailure("invalid-metadata", "expiresAt must be after issuedAt.", publisher.fingerprint);
  }
  const revokedAt =
    value.revokedAt === undefined ? undefined : parseTimestamp(value.revokedAt, "revokedAt");
  const delistedAt =
    value.delistedAt === undefined ? undefined : parseTimestamp(value.delistedAt, "delistedAt");
  if (revokedAt !== undefined && revokedAt < issuedAt) {
    trustFailure("invalid-metadata", "revokedAt cannot precede issuedAt.", publisher.fingerprint);
  }
  if (delistedAt !== undefined && delistedAt < issuedAt) {
    trustFailure("invalid-metadata", "delistedAt cannot precede issuedAt.", publisher.fingerprint);
  }
  const keyRotation =
    value.keyRotation === undefined ? undefined : parseRotation(value.keyRotation);
  if (keyRotation !== undefined && keyRotation.previous.publisherId !== publisher.publisherId) {
    trustFailure("key-rotation-invalid", "Key rotation publisher does not match the manifest.");
  }
  const signature = decodeBase64url(value.signature, "signature", 64);
  if (signature.length !== 64) {
    trustFailure(
      "invalid-signature",
      "Ed25519 signature must be exactly 64 bytes.",
      publisher.fingerprint,
    );
  }
  return {
    distributionVersion: nativeExtensionDistributionVersion,
    manifest,
    bundleSha256: value.bundleSha256,
    ...(value.packageTreeSha256 === undefined
      ? {}
      : { packageTreeSha256: value.packageTreeSha256 as string }),
    authorityDigest: value.authorityDigest,
    publisher,
    issuedAt,
    expiresAt,
    ...(revokedAt === undefined ? {} : { revokedAt }),
    ...(delistedAt === undefined ? {} : { delistedAt }),
    ...(keyRotation === undefined ? {} : { keyRotation }),
    signature: encodeBase64url(signature),
  };
}

/** Create an Ed25519-signed record for tests or an explicit publisher build step. */
export function signNativeExtensionManifest(
  input: NativeExtensionSignedManifestInput,
  privateKey: KeyObject,
): NativeExtensionSignedManifest {
  const manifest = parseManifestStrict(input.manifest);
  const publisher = normalizePublisherKey(input.publisher, "publisher");
  const signingPublisher = nativeExtensionPublisherKeyFromKeyObject({
    publisherId: publisher.publisherId,
    keyId: publisher.keyId,
    key: privateKey,
  });
  if (!comparePublisherKeys(publisher, signingPublisher)) {
    trustFailure("invalid-publisher-key", "Signing key does not match publisher.publicKey.");
  }
  const issuedAt = parseTimestamp(input.issuedAt, "issuedAt");
  const expiresAt = parseTimestamp(input.expiresAt, "expiresAt");
  if (expiresAt <= issuedAt) {
    trustFailure("invalid-metadata", "expiresAt must be after issuedAt.", publisher.fingerprint);
  }
  const revokedAt =
    input.revokedAt === undefined ? undefined : parseTimestamp(input.revokedAt, "revokedAt");
  const delistedAt =
    input.delistedAt === undefined ? undefined : parseTimestamp(input.delistedAt, "delistedAt");
  const keyRotation =
    input.keyRotation === undefined ? undefined : parseRotation(input.keyRotation);
  const metadata: NativeExtensionSignedManifest = {
    distributionVersion: nativeExtensionDistributionVersion,
    manifest,
    bundleSha256: nativeExtensionBundleSha256(input.bundleBytes),
    packageTreeSha256: input.packageTreeSha256 ?? nativeExtensionBundleSha256(input.bundleBytes),
    authorityDigest: nativeExtensionAuthorityDigest(manifest),
    publisher,
    issuedAt,
    expiresAt,
    ...(revokedAt === undefined ? {} : { revokedAt }),
    ...(delistedAt === undefined ? {} : { delistedAt }),
    ...(keyRotation === undefined ? {} : { keyRotation }),
    signature: "",
  };
  const signature = sign(
    null,
    Buffer.from(canonicalJson(signedPayload(metadata)), "utf8"),
    privateKey,
  );
  return { ...metadata, signature: encodeBase64url(signature) };
}

/** Create a signed key-rotation statement. The previous key must sign the next key identity. */
export function signNativeExtensionKeyRotation(
  input: NativeExtensionKeyRotationInput,
  previousPrivateKey: KeyObject,
): NativeExtensionPublisherKeyRotation {
  const previous = normalizePublisherKey(input.previous, "previous");
  const next = normalizePublisherKey(input.next, "next");
  if (previous.publisherId !== next.publisherId || previous.fingerprint === next.fingerprint) {
    trustFailure(
      "key-rotation-invalid",
      "Key rotation must stay within one publisher and change keys.",
    );
  }
  const signingPrevious = nativeExtensionPublisherKeyFromKeyObject({
    publisherId: previous.publisherId,
    keyId: previous.keyId,
    key: previousPrivateKey,
  });
  if (!comparePublisherKeys(previous, signingPrevious)) {
    trustFailure("key-rotation-invalid", "Previous signing key does not match rotation.previous.");
  }
  const effectiveAt = parseTimestamp(input.effectiveAt, "effectiveAt");
  const unsigned: NativeExtensionPublisherKeyRotation = {
    rotationVersion: nativeExtensionKeyRotationVersion,
    previous,
    effectiveAt,
    signature: "",
  };
  const signature = sign(
    null,
    Buffer.from(canonicalJson(rotationPayload(next, unsigned)), "utf8"),
    previousPrivateKey,
  );
  return { ...unsigned, signature: encodeBase64url(signature) };
}

function parseTrustAnchor(value: unknown): NativeExtensionTrustedPublisherKey {
  if (!isRecord(value)) trustFailure("invalid-metadata", "Trusted publisher must be an object.");
  const { revokedAt: rawRevokedAt, ...publisherValue } = value;
  const publisher = normalizePublisherKey(publisherValue, "trusted publisher");
  const revokedAt =
    rawRevokedAt === undefined
      ? undefined
      : parseTimestamp(rawRevokedAt, "trusted publisher.revokedAt");
  return { ...publisher, ...(revokedAt === undefined ? {} : { revokedAt }) };
}

function parseCatalogRootAnchors(value: unknown): NativeExtensionTrustedPublisherKey[] {
  if (!Array.isArray(value)) {
    trustFailure("catalog-untrusted", "Catalog root anchors must be an array.");
  }
  return normalizeTrustAnchors(value);
}

function normalizeTrustAnchors(
  anchors: NativeExtensionTrustOptions["trustedPublishers"],
): NativeExtensionTrustedPublisherKey[] {
  let publishers: readonly unknown[] | null = null;
  if (Array.isArray(anchors)) {
    publishers = anchors;
  } else if (isRecord(anchors) && anchors.version === 1 && Array.isArray(anchors.publishers)) {
    assertOnlyKeys(anchors, ["version", "publishers", "catalogRoots"], "trust anchor set");
    publishers = anchors.publishers;
  }
  if (!publishers) {
    trustFailure("untrusted-publisher", "No offline publisher trust anchors were supplied.");
  }
  const normalized: NativeExtensionTrustedPublisherKey[] = [];
  const identities = new Set<string>();
  const fingerprints = new Set<string>();
  for (const value of publishers) {
    const anchor = parseTrustAnchor(value);
    const identity = `${anchor.publisherId}\u0000${anchor.keyId}`;
    if (identities.has(identity) || fingerprints.has(anchor.fingerprint)) {
      trustFailure(
        "duplicate-trust-anchor",
        `Trust anchors contain a duplicate or conflicting key for ${anchor.publisherId}/${anchor.keyId}.`,
        anchor.fingerprint,
      );
    }
    identities.add(identity);
    fingerprints.add(anchor.fingerprint);
    normalized.push(anchor);
  }
  return normalized;
}

function currentHostTime(): string {
  return parseTimestamp(new Date().toISOString(), "now");
}

function findTrustAnchor(
  publisher: NativeExtensionPublisherKey,
  anchors: readonly NativeExtensionTrustedPublisherKey[],
): NativeExtensionTrustedPublisherKey | undefined {
  return anchors.find((candidate) => comparePublisherKeys(candidate, publisher));
}

function verifySignature(
  signature: string,
  payload: unknown,
  publicKey: NativeExtensionPublisherKey,
  code:
    | "invalid-signature"
    | "key-rotation-invalid"
    | "catalog-signature-invalid"
    | "catalog-successor-invalid",
): void {
  const keyBytes = decodeBase64url(
    publicKey.publicKey,
    "publisher.publicKey",
    nativeExtensionEd25519SpkiBytes,
  );
  const key = publicKeyObjectFromDer(keyBytes, publicKey.fingerprint);
  const signatureBytes = decodeBase64url(
    signature,
    "signature",
    nativeExtensionEd25519SignatureBytes,
  );
  if (signatureBytes.length !== nativeExtensionEd25519SignatureBytes) {
    trustFailure(
      code,
      `Ed25519 signature must be exactly ${nativeExtensionEd25519SignatureBytes} bytes.`,
      publicKey.fingerprint,
    );
  }
  let valid = false;
  try {
    valid = verify(null, Buffer.from(canonicalJson(payload), "utf8"), key, signatureBytes);
  } catch {
    trustFailure(code, "Ed25519 signature verification failed.", publicKey.fingerprint);
  }
  if (!valid) {
    trustFailure(code, "Ed25519 signature verification failed.", publicKey.fingerprint);
  }
}

function verifyKeyTrust(
  metadata: NativeExtensionSignedManifest,
  normalizedAnchors: readonly NativeExtensionTrustedPublisherKey[],
  now: string,
): "direct" | "rotated" {
  const direct = findTrustAnchor(metadata.publisher, normalizedAnchors);
  if (direct) {
    if (direct.revokedAt !== undefined && direct.revokedAt <= now) {
      trustFailure("key-revoked", "Publisher key is revoked.", metadata.publisher.fingerprint);
    }
    if (metadata.keyRotation !== undefined) {
      if (metadata.keyRotation.previous.fingerprint === metadata.publisher.fingerprint) {
        trustFailure(
          "key-rotation-invalid",
          "Key rotation must change the publisher key.",
          metadata.publisher.fingerprint,
        );
      }
      const previous = findTrustAnchor(metadata.keyRotation.previous, normalizedAnchors);
      if (!previous) {
        trustFailure(
          "key-rotation-invalid",
          "Key rotation does not start at a trusted key.",
          metadata.publisher.fingerprint,
        );
      }
      // Authoritative predicate: an effectively revoked key can never be a rotation source. The
      // two window clauses below intersect on exactly one point, issuedAt = effectiveAt =
      // revokedAt, so on their own they accept a rotation minted from a stolen revoked key using
      // only the public revokedAt value.
      if (previous.revokedAt !== undefined && previous.revokedAt <= now) {
        trustFailure("key-revoked", "Publisher key is revoked.", previous.fingerprint);
      }
      // Defence in depth, not redundant: this still rejects every rotation whose predecessor
      // carries a revocation scheduled in the future, which the predicate above deliberately
      // leaves alone until that revocation is effective.
      if (
        previous.revokedAt !== undefined &&
        (metadata.issuedAt > previous.revokedAt ||
          metadata.keyRotation.effectiveAt < previous.revokedAt)
      ) {
        trustFailure(
          "key-rotation-invalid",
          "Key rotation was issued after predecessor revocation or backdated before it.",
          metadata.publisher.fingerprint,
        );
      }
      // Independent of revocation entirely: every rotation must already be effective and must not
      // predate its own effectiveAt. This clause governs the far more common unrevoked case.
      if (
        metadata.keyRotation.effectiveAt > now ||
        metadata.issuedAt < metadata.keyRotation.effectiveAt
      ) {
        trustFailure(
          "key-rotation-invalid",
          "Key rotation is not effective for this record.",
          metadata.publisher.fingerprint,
        );
      }
      verifySignature(
        metadata.keyRotation.signature,
        rotationPayload(metadata.publisher, metadata.keyRotation),
        metadata.keyRotation.previous,
        "key-rotation-invalid",
      );
    }
    return "direct";
  }

  const rotation = metadata.keyRotation;
  if (!rotation) {
    trustFailure(
      "untrusted-publisher",
      "Publisher key is not in the offline trust anchors.",
      metadata.publisher.fingerprint,
    );
  }
  const previous = findTrustAnchor(rotation.previous, normalizedAnchors);
  if (!previous) {
    trustFailure(
      "key-rotation-invalid",
      "Key rotation does not start at a trusted key.",
      metadata.publisher.fingerprint,
    );
  }
  // Authoritative predicate. This is the only path that can mint trust for a publisher key that
  // is not itself an anchor, so a revoked predecessor must never serve as its rotation source.
  // The two window clauses below intersect on exactly one point, issuedAt = effectiveAt =
  // revokedAt, and revokedAt is public: without this check a stolen revoked key yields a
  // permanent forged trusted identity.
  if (previous.revokedAt !== undefined && previous.revokedAt <= now) {
    trustFailure("key-revoked", "Publisher key is revoked.", previous.fingerprint);
  }
  // Defence in depth, not redundant: this still rejects every rotation whose predecessor carries
  // a revocation scheduled in the future, which the predicate above deliberately leaves alone
  // until that revocation is effective.
  if (
    previous.revokedAt !== undefined &&
    (metadata.issuedAt > previous.revokedAt || rotation.effectiveAt < previous.revokedAt)
  ) {
    trustFailure(
      "key-rotation-invalid",
      "Key rotation was issued after predecessor revocation or backdated before it.",
      metadata.publisher.fingerprint,
    );
  }
  // Independent of revocation entirely: every rotation must already be effective and must not
  // predate its own effectiveAt. This clause governs the far more common unrevoked case.
  if (rotation.effectiveAt > now || metadata.issuedAt < rotation.effectiveAt) {
    trustFailure(
      "key-rotation-invalid",
      "Key rotation is not effective for this record.",
      metadata.publisher.fingerprint,
    );
  }
  verifySignature(
    rotation.signature,
    rotationPayload(metadata.publisher, rotation),
    rotation.previous,
    "key-rotation-invalid",
  );
  return "rotated";
}

function assertLifecycle(metadata: NativeExtensionSignedManifest, now: string): void {
  if (metadata.issuedAt > now) {
    trustFailure(
      "not-yet-valid",
      "Signed extension metadata is not valid yet.",
      metadata.publisher.fingerprint,
    );
  }
  if (metadata.expiresAt <= now) {
    trustFailure(
      "expired",
      "Signed extension metadata has expired.",
      metadata.publisher.fingerprint,
    );
  }
  if (metadata.revokedAt !== undefined && metadata.revokedAt <= now) {
    trustFailure(
      "revoked",
      "Signed extension metadata has been revoked.",
      metadata.publisher.fingerprint,
    );
  }
  if (metadata.delistedAt !== undefined && metadata.delistedAt <= now) {
    trustFailure(
      "delisted",
      "Signed extension metadata has been delisted.",
      metadata.publisher.fingerprint,
    );
  }
}

/** Verify one signed record and bind it to the exact bundle bytes supplied by the installer. */
export function verifyNativeExtensionDistribution(
  value: unknown,
  bundleBytes: Uint8Array,
  options: NativeExtensionTrustOptions,
): NativeExtensionVerification {
  const metadata = parseNativeExtensionSignedManifest(value);
  const now = options.now === undefined ? currentHostTime() : parseTimestamp(options.now, "now");
  verifySignature(
    metadata.signature,
    signedPayload(metadata),
    metadata.publisher,
    "invalid-signature",
  );
  const actualBundleSha256 = nativeExtensionBundleSha256(bundleBytes);
  if (actualBundleSha256 !== metadata.bundleSha256) {
    trustFailure(
      "bundle-mismatch",
      "Bundle bytes do not match the signed SHA-256 digest.",
      metadata.publisher.fingerprint,
    );
  }
  const actualAuthorityDigest = nativeExtensionAuthorityDigest(metadata.manifest);
  if (actualAuthorityDigest !== metadata.authorityDigest) {
    trustFailure(
      "authority-mismatch",
      "Signed authority digest does not match the manifest.",
      metadata.publisher.fingerprint,
    );
  }
  const actualPackageTreeSha256 = options.packageTreeSha256 ?? actualBundleSha256;
  if (!hashPattern.test(actualPackageTreeSha256)) {
    trustFailure(
      "invalid-metadata",
      "Installed package tree identity must be a lowercase SHA-256 digest.",
      metadata.publisher.fingerprint,
    );
  }
  const signedPackageTreeSha256 = metadata.packageTreeSha256 ?? actualBundleSha256;
  if (signedPackageTreeSha256 !== actualPackageTreeSha256) {
    trustFailure(
      "bundle-mismatch",
      "Installed package tree does not match the signed package identity.",
      metadata.publisher.fingerprint,
    );
  }
  const trustedPublishers = normalizeTrustAnchors(options.trustedPublishers);
  const keyTrust = verifyKeyTrust(metadata, trustedPublishers, now);
  assertLifecycle(metadata, now);
  return {
    status: "trusted",
    metadata,
    metadataSha256: nativeExtensionSignedManifestSha256(metadata),
    publisherFingerprint: metadata.publisher.fingerprint,
    publisherId: metadata.publisher.publisherId,
    publisherKeyId: metadata.publisher.keyId,
    metadataIssuedAt: metadata.issuedAt,
    metadataExpiresAt: metadata.expiresAt,
    metadataRevokedAt: metadata.revokedAt ?? null,
    metadataDelistedAt: metadata.delistedAt ?? null,
    keyTrust,
    bundleSha256: actualBundleSha256,
    packageTreeSha256: actualPackageTreeSha256,
    authorityDigest: actualAuthorityDigest,
    trustedPublishers,
    marketplaceIndexTrust: "not-applicable",
    marketplaceCatalogRevision: null,
    marketplaceCatalogSha256: null,
    marketplaceCatalogRootFingerprint: null,
  };
}

/** Verify both the signed record and the manifest presented by the executable bundle. */
export function verifyNativeExtensionBundle(
  value: unknown,
  bundle: NativeExtensionBundle,
  options: NativeExtensionTrustOptions,
): NativeExtensionVerification {
  const metadata = parseNativeExtensionSignedManifest(value);
  const bundleManifest = parseManifestStrict(bundle.manifest);
  if (
    canonicalJson(bundleManifest) !== canonicalJson(metadata.manifest) ||
    bundleManifest.id !== metadata.manifest.id
  ) {
    trustFailure(
      "authority-mismatch",
      "Bundle manifest does not match signed distribution metadata.",
      metadata.publisher.fingerprint,
    );
  }
  return verifyNativeExtensionDistribution(
    metadata,
    bundle.bundleBytes,
    bundle.packageTreeSha256 === undefined
      ? options
      : { ...options, packageTreeSha256: bundle.packageTreeSha256 },
  );
}

export function parseNativeExtensionMarketplaceIndex(
  value: unknown,
): NativeExtensionMarketplaceIndex {
  if (!isRecord(value)) trustFailure("invalid-metadata", "Marketplace index must be an object.");
  assertOnlyKeys(
    value,
    ["indexVersion", "generatedAt", "expiresAt", "entries"],
    "marketplace index",
  );
  if (value.indexVersion !== nativeExtensionIndexVersion) {
    trustFailure("unsupported-version", "Unsupported native extension index version.");
  }
  const generatedAt = parseTimestamp(value.generatedAt, "index.generatedAt");
  const expiresAt = parseTimestamp(value.expiresAt, "index.expiresAt");
  if (expiresAt <= generatedAt)
    trustFailure("invalid-metadata", "index.expiresAt must be after generatedAt.");
  if (!Array.isArray(value.entries) || value.entries.length > 10_000) {
    trustFailure("invalid-metadata", "index.entries must be a bounded array.");
  }
  const entries = value.entries.map(parseNativeExtensionSignedManifest);
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.manifest.id}\u0000${entry.manifest.version}`;
    if (seen.has(key))
      trustFailure(
        "duplicate-entry",
        `index.entries repeats ${entry.manifest.id}@${entry.manifest.version}.`,
      );
    seen.add(key);
  }
  return { indexVersion: nativeExtensionIndexVersion, generatedAt, expiresAt, entries };
}

function assertMarketplaceIndexFreshness(
  index: NativeExtensionMarketplaceIndex,
  now: string,
  failureCode: "index-expired" | "catalog-expired" = "index-expired",
): void {
  const generatedMs = Date.parse(index.generatedAt);
  const latestAllowedExpiry = new Date(
    generatedMs + nativeExtensionMarketplaceCatalogMaxAgeMs,
  ).toISOString();
  if (index.expiresAt > latestAllowedExpiry) {
    trustFailure(
      failureCode,
      `Marketplace catalog exceeds the ${nativeExtensionMarketplaceCatalogMaxAgeMs} ms local max-age.`,
    );
  }
  if (index.generatedAt > now || index.expiresAt <= now) {
    trustFailure(failureCode, "Marketplace catalog is outside its validity window.");
  }
}

/** Unsigned indexes are retained only as a parser for migration diagnostics and never authorize. */
export function verifyNativeExtensionMarketplaceIndex(
  value: unknown,
  _options?: NativeExtensionTrustOptions,
): never {
  parseNativeExtensionMarketplaceIndex(value);
  trustFailure(
    "catalog-untrusted",
    "Unsigned marketplace indexes cannot authorize native extension installation; use a signed catalog.",
  );
}

/** Export a deterministic, mirrorable index. Entries are sorted by extension ID and version. */
export function createNativeExtensionMarketplaceIndex(input: {
  generatedAt: string;
  expiresAt: string;
  entries: readonly NativeExtensionSignedManifest[];
}): NativeExtensionMarketplaceIndex {
  const generatedAt = parseTimestamp(input.generatedAt, "generatedAt");
  const expiresAt = parseTimestamp(input.expiresAt, "expiresAt");
  if (expiresAt <= generatedAt)
    trustFailure("invalid-metadata", "expiresAt must be after generatedAt.");
  const entries = input.entries.map(parseNativeExtensionSignedManifest).sort((left, right) => {
    const id = left.manifest.id.localeCompare(right.manifest.id, "en-US");
    return id === 0 ? left.manifest.version.localeCompare(right.manifest.version, "en-US") : id;
  });
  const index = parseNativeExtensionMarketplaceIndex({
    indexVersion: nativeExtensionIndexVersion,
    generatedAt,
    expiresAt,
    entries,
  });
  assertMarketplaceIndexFreshness(index, generatedAt);
  return index;
}

function catalogEntryKey(extensionId: string, version: string): string {
  return `${extensionId}\u0000${version}`;
}

function parseOptionalIdentityFields(
  value: RecordValue,
  label: string,
): Pick<
  NativeExtensionMarketplaceCatalogEntryState,
  "bundleSha256" | "authorityDigest" | "packageTreeSha256" | "metadataSha256"
> {
  const fields = [
    "bundleSha256",
    "authorityDigest",
    "packageTreeSha256",
    "metadataSha256",
  ] as const;
  const present = fields.filter((field) => value[field] !== undefined);
  if (present.length !== 0 && present.length !== fields.length) {
    trustFailure(
      "catalog-state-mismatch",
      `${label} must preserve complete package and authority identity evidence.`,
    );
  }
  if (present.length === 0) return {};
  for (const field of fields) {
    if (typeof value[field] !== "string" || !hashPattern.test(value[field])) {
      trustFailure("catalog-state-mismatch", `${label}.${field} must be a SHA-256 digest.`);
    }
  }
  return {
    bundleSha256: value.bundleSha256 as string,
    authorityDigest: value.authorityDigest as string,
    packageTreeSha256: value.packageTreeSha256 as string,
    metadataSha256: value.metadataSha256 as string,
  };
}

function parseAcceptedEntryIdentities(
  value: unknown,
): NativeExtensionMarketplaceEntryIdentity[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 10_000) {
    throw new Error("Native extension marketplace catalog entry identities are malformed.");
  }
  const identities = value.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new Error(`Native extension marketplace catalog entry identity ${index} is malformed.`);
    }
    const allowed = [
      "key",
      "extensionId",
      "version",
      "bundleSha256",
      "authorityDigest",
      "packageTreeSha256",
      "metadataSha256",
    ];
    if (Object.keys(raw).some((key) => !allowed.includes(key))) {
      throw new Error("Native extension marketplace catalog entry identity has unknown fields.");
    }
    const extensionId = parseIdentifier(
      raw.extensionId,
      `state.entryIdentities[${index}].extensionId`,
    );
    const version = parseIdentifier(raw.version, `state.entryIdentities[${index}].version`);
    const key = catalogEntryKey(extensionId, version);
    if (raw.key !== key)
      throw new Error("Native extension marketplace catalog identity key mismatch.");
    for (const field of [
      "bundleSha256",
      "authorityDigest",
      "packageTreeSha256",
      "metadataSha256",
    ]) {
      if (typeof raw[field] !== "string" || !hashPattern.test(raw[field])) {
        throw new Error(`state.entryIdentities[${index}].${field} is malformed.`);
      }
    }
    return {
      key,
      extensionId,
      version,
      bundleSha256: raw.bundleSha256 as string,
      authorityDigest: raw.authorityDigest as string,
      packageTreeSha256: raw.packageTreeSha256 as string,
      metadataSha256: raw.metadataSha256 as string,
    };
  });
  const keys = new Set(identities.map((entry) => entry.key));
  if (keys.size !== identities.length) {
    throw new Error("Native extension marketplace catalog entry identities repeat a key.");
  }
  return identities;
}

function parseTombstones(
  value: unknown,
  label: string,
): NativeExtensionMarketplaceTombstone[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 10_000) {
    trustFailure("catalog-state-mismatch", `${label} must be a bounded array.`);
  }
  const tombstones = value.map((raw, index) => {
    if (!isRecord(raw))
      trustFailure("catalog-state-mismatch", `${label}[${index}] must be an object.`);
    assertOnlyKeys(
      raw,
      [
        "extensionId",
        "version",
        "at",
        "bundleSha256",
        "authorityDigest",
        "packageTreeSha256",
        "metadataSha256",
        "tombstonedAt",
        "reason",
      ],
      `${label}[${index}]`,
    );
    const { tombstonedAt: _tombstonedAt, reason: _reason, ...stateValue } = raw;
    const state = parseCatalogEntryState(stateValue, `${label}[${index}]`);
    const identity = parseOptionalIdentityFields(raw, `${label}[${index}]`);
    if (
      identity.bundleSha256 === undefined ||
      identity.authorityDigest === undefined ||
      identity.packageTreeSha256 === undefined ||
      identity.metadataSha256 === undefined
    ) {
      trustFailure(
        "catalog-state-mismatch",
        `${label}[${index}] must preserve complete package identity evidence.`,
      );
    }
    const tombstonedAt = parseTimestamp(raw.tombstonedAt, `${label}[${index}].tombstonedAt`);
    if (tombstonedAt < state.at) {
      trustFailure(
        "catalog-state-mismatch",
        `${label}[${index}].tombstonedAt precedes its lifecycle time.`,
      );
    }
    if (raw.reason !== undefined && (typeof raw.reason !== "string" || raw.reason.length > 256)) {
      trustFailure("catalog-state-mismatch", `${label}[${index}].reason is invalid.`);
    }
    return {
      ...state,
      ...identity,
      tombstonedAt,
      ...(raw.reason === undefined ? {} : { reason: raw.reason as string }),
    };
  });
  const keys = new Set(
    tombstones.map((entry) => catalogEntryKey(entry.extensionId, entry.version)),
  );
  if (keys.size !== tombstones.length) {
    trustFailure("catalog-state-mismatch", `${label} repeats an extension version.`);
  }
  return tombstones.sort((left, right) =>
    catalogEntryKey(left.extensionId, left.version).localeCompare(
      catalogEntryKey(right.extensionId, right.version),
      "en-US",
    ),
  );
}

function parseCatalogEntryState(
  value: unknown,
  label: string,
): NativeExtensionMarketplaceCatalogEntryState {
  if (!isRecord(value)) trustFailure("catalog-state-mismatch", `${label} must be an object.`);
  assertOnlyKeys(
    value,
    [
      "extensionId",
      "version",
      "at",
      "bundleSha256",
      "authorityDigest",
      "packageTreeSha256",
      "metadataSha256",
    ],
    label,
  );
  const identity = parseOptionalIdentityFields(value, label);
  return {
    extensionId: parseIdentifier(value.extensionId, `${label}.extensionId`),
    version: parseIdentifier(value.version, `${label}.version`),
    at: parseTimestamp(value.at, `${label}.at`),
    ...identity,
  };
}

function parseSuccessor(value: unknown, label: string): NativeExtensionMarketplaceSuccessor {
  if (!isRecord(value)) trustFailure("catalog-successor-invalid", `${label} must be an object.`);
  assertOnlyKeys(
    value,
    ["successorVersion", "previous", "next", "issuedAt", "effectiveAt", "signature"],
    label,
  );
  if (value.successorVersion !== nativeExtensionMarketplaceSuccessorVersion) {
    trustFailure("catalog-successor-invalid", `${label}.successorVersion is unsupported.`);
  }
  const previous = normalizePublisherKey(value.previous, `${label}.previous`);
  const next = normalizePublisherKey(value.next, `${label}.next`);
  if (previous.publisherId !== next.publisherId || previous.fingerprint === next.fingerprint) {
    trustFailure(
      "catalog-successor-invalid",
      `${label} must change keys within one publisher identity.`,
    );
  }
  const issuedAt = parseTimestamp(value.issuedAt, `${label}.issuedAt`);
  const effectiveAt = parseTimestamp(value.effectiveAt, `${label}.effectiveAt`);
  if (effectiveAt < issuedAt) {
    trustFailure("catalog-successor-invalid", `${label}.effectiveAt cannot precede issuedAt.`);
  }
  const signature = decodeBase64url(
    value.signature,
    `${label}.signature`,
    nativeExtensionEd25519SignatureBytes,
  );
  if (signature.length !== nativeExtensionEd25519SignatureBytes) {
    trustFailure("catalog-successor-invalid", `${label}.signature must be exactly 64 bytes.`);
  }
  return {
    successorVersion: nativeExtensionMarketplaceSuccessorVersion,
    previous,
    next,
    issuedAt,
    effectiveAt,
    signature: encodeBase64url(signature),
  };
}

function successorPayload(successor: NativeExtensionMarketplaceSuccessor): RecordValue {
  return {
    successorVersion: nativeExtensionMarketplaceSuccessorVersion,
    previous: successor.previous,
    next: successor.next,
    issuedAt: successor.issuedAt,
    effectiveAt: successor.effectiveAt,
  };
}

function catalogPayload(
  catalog: NativeExtensionMarketplaceCatalog,
): Omit<NativeExtensionMarketplaceCatalog, "signature"> {
  return {
    catalogVersion: nativeExtensionMarketplaceCatalogVersion,
    revision: catalog.revision,
    generatedAt: catalog.generatedAt,
    expiresAt: catalog.expiresAt,
    catalogRoot: catalog.catalogRoot,
    entriesSha256: catalog.entriesSha256,
    entries: catalog.entries,
    revocations: catalog.revocations,
    delistings: catalog.delistings,
    ...(catalog.tombstones === undefined ? {} : { tombstones: catalog.tombstones }),
    successorPath: catalog.successorPath,
    publisherSuccessors: catalog.publisherSuccessors,
  };
}

function sortedCatalogStates(
  values: readonly NativeExtensionMarketplaceCatalogEntryState[],
): NativeExtensionMarketplaceCatalogEntryState[] {
  return [...values].sort((left, right) => {
    const key = catalogEntryKey(left.extensionId, left.version).localeCompare(
      catalogEntryKey(right.extensionId, right.version),
      "en-US",
    );
    return key === 0 ? left.at.localeCompare(right.at, "en-US") : key;
  });
}

function sortedCatalogTombstones(
  values: readonly NativeExtensionMarketplaceTombstone[],
): NativeExtensionMarketplaceTombstone[] {
  return [...values]
    .map(
      (value, index) =>
        parseTombstones(
          [value],
          `catalog.tombstones[${index}]`,
        )?.[0] as NativeExtensionMarketplaceTombstone,
    )
    .sort((left, right) =>
      catalogEntryKey(left.extensionId, left.version).localeCompare(
        catalogEntryKey(right.extensionId, right.version),
        "en-US",
      ),
    );
}

function parseCatalogEntries(value: unknown): NativeExtensionSignedManifest[] {
  if (!Array.isArray(value) || value.length > 10_000) {
    trustFailure("invalid-metadata", "catalog.entries must be a bounded array.");
  }
  const entries = value.map(parseNativeExtensionSignedManifest).sort((left, right) => {
    const id = left.manifest.id.localeCompare(right.manifest.id, "en-US");
    return id === 0 ? left.manifest.version.localeCompare(right.manifest.version, "en-US") : id;
  });
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = catalogEntryKey(entry.manifest.id, entry.manifest.version);
    if (seen.has(key)) trustFailure("duplicate-entry", `catalog.entries repeats ${key}.`);
    seen.add(key);
  }
  return entries;
}

/** Parse and normalize a signed catalog envelope before any catalog signature or bundle operation. */
export function parseNativeExtensionMarketplaceCatalog(
  value: unknown,
): NativeExtensionMarketplaceCatalog {
  if (!isRecord(value)) trustFailure("invalid-metadata", "Marketplace catalog must be an object.");
  assertOnlyKeys(
    value,
    [
      "catalogVersion",
      "revision",
      "generatedAt",
      "expiresAt",
      "catalogRoot",
      "entriesSha256",
      "entries",
      "revocations",
      "delistings",
      "tombstones",
      "successorPath",
      "publisherSuccessors",
      "signature",
    ],
    "marketplace catalog",
  );
  if (value.catalogVersion !== nativeExtensionMarketplaceCatalogVersion) {
    trustFailure("unsupported-version", "Unsupported native extension catalog version.");
  }
  if (
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1
  ) {
    trustFailure("invalid-metadata", "catalog.revision must be a positive safe integer.");
  }
  const generatedAt = parseTimestamp(value.generatedAt, "catalog.generatedAt");
  const expiresAt = parseTimestamp(value.expiresAt, "catalog.expiresAt");
  if (expiresAt <= generatedAt) {
    trustFailure("invalid-metadata", "catalog.expiresAt must be after generatedAt.");
  }
  const catalogRoot = normalizePublisherKey(value.catalogRoot, "catalog.catalogRoot");
  if (typeof value.entriesSha256 !== "string" || !hashPattern.test(value.entriesSha256)) {
    trustFailure("invalid-metadata", "catalog.entriesSha256 must be a lowercase SHA-256 digest.");
  }
  const entries = parseCatalogEntries(value.entries);
  for (const entry of entries) {
    if (entry.issuedAt > generatedAt) {
      trustFailure(
        "catalog-state-mismatch",
        `Catalog entry ${entry.manifest.id}@${entry.manifest.version} is newer than its catalog.`,
        entry.publisher.fingerprint,
      );
    }
  }
  const actualEntriesSha256 = createHash("sha256")
    .update(canonicalJson(entries), "utf8")
    .digest("hex");
  if (actualEntriesSha256 !== value.entriesSha256) {
    trustFailure("catalog-state-mismatch", "catalog.entriesSha256 does not match entries.");
  }
  if (!Array.isArray(value.revocations) || value.revocations.length > 10_000) {
    trustFailure("catalog-state-mismatch", "catalog.revocations must be a bounded array.");
  }
  if (!Array.isArray(value.delistings) || value.delistings.length > 10_000) {
    trustFailure("catalog-state-mismatch", "catalog.delistings must be a bounded array.");
  }
  const revocations = sortedCatalogStates(
    value.revocations.map((entry, index) =>
      parseCatalogEntryState(entry, `catalog.revocations[${index}]`),
    ),
  );
  const delistings = sortedCatalogStates(
    value.delistings.map((entry, index) =>
      parseCatalogEntryState(entry, `catalog.delistings[${index}]`),
    ),
  );
  const tombstones = parseTombstones(value.tombstones, "catalog.tombstones") ?? [];
  for (const state of [...revocations, ...delistings]) {
    if (state.at > generatedAt) {
      trustFailure(
        "catalog-state-mismatch",
        `catalog lifecycle state for ${state.extensionId}@${state.version} is newer than its catalog.`,
      );
    }
  }
  for (const tombstone of tombstones) {
    if (tombstone.tombstonedAt > generatedAt || tombstone.at > generatedAt) {
      trustFailure(
        "catalog-state-mismatch",
        `catalog tombstone for ${tombstone.extensionId}@${tombstone.version} is newer than its catalog.`,
      );
    }
  }
  const successorPath =
    !Array.isArray(value.successorPath) || value.successorPath.length > 100
      ? trustFailure("catalog-successor-invalid", "catalog.successorPath must be a bounded array.")
      : value.successorPath.map((entry, index) =>
          parseSuccessor(entry, `catalog.successorPath[${index}]`),
        );
  const publisherSuccessors =
    !Array.isArray(value.publisherSuccessors) || value.publisherSuccessors.length > 10_000
      ? trustFailure(
          "catalog-successor-invalid",
          "catalog.publisherSuccessors must be a bounded array.",
        )
      : value.publisherSuccessors.map((entry, index) =>
          parseSuccessor(entry, `catalog.publisherSuccessors[${index}]`),
        );
  const signature = decodeBase64url(
    value.signature,
    "catalog.signature",
    nativeExtensionEd25519SignatureBytes,
  );
  if (signature.length !== nativeExtensionEd25519SignatureBytes) {
    trustFailure("catalog-signature-invalid", "Catalog signature must be exactly 64 bytes.");
  }
  const byKey = new Map(
    entries.map((entry) => [catalogEntryKey(entry.manifest.id, entry.manifest.version), entry]),
  );
  const checkStates = (
    states: readonly NativeExtensionMarketplaceCatalogEntryState[],
    field: "revokedAt" | "delistedAt",
  ): void => {
    const seen = new Set<string>();
    for (const state of states) {
      const key = catalogEntryKey(state.extensionId, state.version);
      if (seen.has(key)) trustFailure("catalog-state-mismatch", `catalog.${field} repeats ${key}.`);
      seen.add(key);
      const entry = byKey.get(key);
      if (entry && entry[field] !== state.at) {
        trustFailure(
          "catalog-state-mismatch",
          `catalog.${field} does not match signed lifecycle state for ${key}.`,
        );
      }
      if (entry) {
        const stateIdentity = catalogEntryStateIdentity(state);
        if (stateIdentity && !identityMatches(entryIdentity(entry), stateIdentity)) {
          trustFailure(
            "catalog-rebind",
            `catalog.${field} attempted to rebind package identity for ${key}.`,
            entry.publisher.fingerprint,
          );
        }
      }
    }
    for (const entry of entries) {
      const at = entry[field];
      const key = catalogEntryKey(entry.manifest.id, entry.manifest.version);
      if (
        at !== undefined &&
        !states.some(
          (state) => catalogEntryKey(state.extensionId, state.version) === key && state.at === at,
        )
      ) {
        trustFailure("catalog-state-mismatch", `catalog is missing ${field} state for ${key}.`);
      }
    }
  };
  checkStates(revocations, "revokedAt");
  checkStates(delistings, "delistedAt");
  const revokedKeys = new Set(
    revocations.map((state) => catalogEntryKey(state.extensionId, state.version)),
  );
  for (const state of delistings) {
    if (revokedKeys.has(catalogEntryKey(state.extensionId, state.version))) {
      trustFailure(
        "catalog-state-mismatch",
        "An entry cannot be both revoked and delisted in one catalog.",
      );
    }
  }
  for (const tombstone of tombstones) {
    const key = catalogEntryKey(tombstone.extensionId, tombstone.version);
    if (byKey.has(key)) {
      trustFailure(
        "catalog-state-mismatch",
        `catalog tombstone conflicts with active entry ${key}.`,
      );
    }
    if (
      revokedKeys.has(key) ||
      delistings.some((state) => catalogEntryKey(state.extensionId, state.version) === key)
    ) {
      trustFailure(
        "catalog-state-mismatch",
        `catalog tombstone duplicates lifecycle state for ${key}.`,
      );
    }
  }
  return {
    catalogVersion: nativeExtensionMarketplaceCatalogVersion,
    revision: value.revision,
    generatedAt,
    expiresAt,
    catalogRoot,
    entriesSha256: value.entriesSha256,
    entries,
    revocations,
    delistings,
    tombstones,
    successorPath,
    publisherSuccessors,
    signature: encodeBase64url(signature),
  };
}

export function nativeExtensionMarketplaceCatalogSha256(value: unknown): string {
  const catalog = parseNativeExtensionMarketplaceCatalog(value);
  return createHash("sha256").update(canonicalJson(catalog), "utf8").digest("hex");
}

function catalogRootsFromOptions(
  options: NativeExtensionMarketplaceCatalogTrustOptions,
): NativeExtensionTrustedPublisherKey[] {
  if (options.trustedCatalogRoots !== undefined) {
    return normalizeTrustAnchors(options.trustedCatalogRoots);
  }
  const anchors = options.trustedPublishers;
  if (!Array.isArray(anchors) && isRecord(anchors) && anchors.catalogRoots !== undefined) {
    return parseCatalogRootAnchors(anchors.catalogRoots);
  }
  trustFailure("catalog-untrusted", "No offline catalog root trust anchors were supplied.");
}

function successorHash(successor: NativeExtensionMarketplaceSuccessor): string {
  return createHash("sha256").update(canonicalJson(successor), "utf8").digest("hex");
}

function verifySuccessorStatement(
  successor: NativeExtensionMarketplaceSuccessor,
  signer: NativeExtensionPublisherKey,
): void {
  verifySignature(
    successor.signature,
    successorPayload(successor),
    signer,
    "catalog-successor-invalid",
  );
}

function verifyCatalogRoot(
  catalog: NativeExtensionMarketplaceCatalog,
  roots: readonly NativeExtensionTrustedPublisherKey[],
  now: string,
  previous: NativeExtensionAcceptedMarketplaceCatalog | undefined,
): NativeExtensionTrustedPublisherKey {
  const direct = findTrustAnchor(catalog.catalogRoot, roots);
  if (direct) {
    if (direct.revokedAt !== undefined && direct.revokedAt <= now) {
      trustFailure("catalog-untrusted", "Catalog root is revoked.", direct.fingerprint);
    }
    verifySignature(
      catalog.signature,
      catalogPayload(catalog),
      catalog.catalogRoot,
      "catalog-signature-invalid",
    );
    return direct;
  }
  let current: NativeExtensionPublisherKey | undefined;
  for (const successor of catalog.successorPath) {
    const predecessor =
      current === undefined
        ? findTrustAnchor(successor.previous, roots)
        : comparePublisherKeys(current, successor.previous)
          ? ({ ...current } as NativeExtensionTrustedPublisherKey)
          : undefined;
    if (!predecessor) {
      trustFailure("catalog-successor-invalid", "Catalog root successor path is not anchored.");
    }
    if (predecessor.revokedAt !== undefined && predecessor.revokedAt <= now) {
      const known = previous?.successorHashes.includes(successorHash(successor)) ?? false;
      if (!known) {
        trustFailure(
          "catalog-successor-invalid",
          "A revoked catalog root cannot authorize a new or backdated successor.",
          predecessor.fingerprint,
        );
      }
    }
    if (successor.issuedAt > catalog.generatedAt || successor.effectiveAt > catalog.generatedAt) {
      trustFailure(
        "catalog-successor-invalid",
        "Catalog root successor is newer than its catalog.",
      );
    }
    verifySuccessorStatement(successor, successor.previous);
    current = successor.next;
  }
  if (!current || !comparePublisherKeys(current, catalog.catalogRoot)) {
    trustFailure("catalog-untrusted", "Catalog root is not anchored by a trusted successor path.");
  }
  verifySignature(
    catalog.signature,
    catalogPayload(catalog),
    catalog.catalogRoot,
    "catalog-signature-invalid",
  );
  return { ...catalog.catalogRoot };
}

function verifyPublisherSuccessors(
  catalog: NativeExtensionMarketplaceCatalog,
  root: NativeExtensionTrustedPublisherKey,
  roots: readonly NativeExtensionTrustedPublisherKey[],
  now: string,
  previous: NativeExtensionAcceptedMarketplaceCatalog | undefined,
): NativeExtensionTrustedPublisherKey[] {
  for (const successor of catalog.publisherSuccessors) {
    const predecessor = findTrustAnchor(successor.previous, roots);
    if (predecessor?.revokedAt !== undefined && predecessor.revokedAt <= now) {
      const known = previous?.successorHashes.includes(successorHash(successor)) ?? false;
      if (!known) {
        trustFailure(
          "catalog-successor-invalid",
          "A revoked predecessor cannot authorize a new or backdated publisher rotation.",
          predecessor.fingerprint,
        );
      }
    }
    if (successor.issuedAt > catalog.generatedAt || successor.effectiveAt > catalog.generatedAt) {
      trustFailure("catalog-successor-invalid", "Publisher successor is newer than its catalog.");
    }
    verifySuccessorStatement(successor, root);
  }
  for (const entry of catalog.entries) {
    const rotation = entry.keyRotation;
    if (!rotation) continue;
    const successor = catalog.publisherSuccessors.find(
      (candidate) =>
        comparePublisherKeys(candidate.previous, rotation.previous) &&
        comparePublisherKeys(candidate.next, entry.publisher) &&
        candidate.effectiveAt === rotation.effectiveAt,
    );
    if (!successor && !findTrustAnchor(entry.publisher, roots)) {
      trustFailure(
        "catalog-successor-invalid",
        `Catalog is missing a root-owned successor for ${entry.manifest.id}@${entry.manifest.version}.`,
        entry.publisher.fingerprint,
      );
    }
  }
  const derived = [...roots];
  let changed = true;
  while (changed) {
    changed = false;
    for (const successor of catalog.publisherSuccessors) {
      const predecessor = findTrustAnchor(successor.previous, derived);
      if (!predecessor) continue;
      const known = previous?.successorHashes.includes(successorHash(successor)) ?? false;
      if (predecessor.revokedAt !== undefined && predecessor.revokedAt <= now) {
        if (!known) continue;
        const index = derived.findIndex((anchor) => comparePublisherKeys(anchor, predecessor));
        const candidate = index < 0 ? undefined : derived[index];
        if (candidate) {
          const { revokedAt: _revokedAt, ...unrevoked } = candidate;
          derived[index] = unrevoked;
        }
      }
      if (!findTrustAnchor(successor.next, derived)) {
        derived.push({ ...successor.next });
        changed = true;
      }
    }
  }
  return derived;
}

function publisherAnchorsForEntry(
  entry: NativeExtensionSignedManifest,
  originalAnchors: readonly NativeExtensionTrustedPublisherKey[],
  derivedAnchors: readonly NativeExtensionTrustedPublisherKey[],
): NativeExtensionTrustedPublisherKey[] {
  if (!entry.keyRotation) {
    return [...originalAnchors];
  }
  const publisherWasExplicitlyTrusted = originalAnchors.some((anchor) =>
    comparePublisherKeys(anchor, entry.publisher),
  );
  return derivedAnchors.filter(
    (anchor) => publisherWasExplicitlyTrusted || !comparePublisherKeys(anchor, entry.publisher),
  );
}

function packageTreeIdentity(metadata: NativeExtensionSignedManifest): string {
  return metadata.packageTreeSha256 ?? metadata.bundleSha256;
}

function entryIdentity(
  metadata: NativeExtensionSignedManifest,
): NativeExtensionMarketplaceEntryIdentity {
  const extensionId = metadata.manifest.id;
  const version = metadata.manifest.version;
  return {
    key: catalogEntryKey(extensionId, version),
    extensionId,
    version,
    bundleSha256: metadata.bundleSha256,
    authorityDigest: metadata.authorityDigest,
    packageTreeSha256: packageTreeIdentity(metadata),
    metadataSha256: nativeExtensionSignedManifestSha256(metadata),
  };
}

function identityMatches(
  left: NativeExtensionMarketplaceEntryIdentity,
  right: NativeExtensionMarketplaceEntryIdentity,
): boolean {
  return (
    left.key === right.key &&
    left.bundleSha256 === right.bundleSha256 &&
    left.authorityDigest === right.authorityDigest &&
    left.packageTreeSha256 === right.packageTreeSha256 &&
    left.metadataSha256 === right.metadataSha256
  );
}

function catalogEntryStateIdentity(
  state: NativeExtensionMarketplaceCatalogEntryState,
): NativeExtensionMarketplaceEntryIdentity | undefined {
  if (
    state.bundleSha256 === undefined ||
    state.authorityDigest === undefined ||
    state.packageTreeSha256 === undefined ||
    state.metadataSha256 === undefined
  ) {
    return undefined;
  }
  return {
    key: catalogEntryKey(state.extensionId, state.version),
    extensionId: state.extensionId,
    version: state.version,
    bundleSha256: state.bundleSha256,
    authorityDigest: state.authorityDigest,
    packageTreeSha256: state.packageTreeSha256,
    metadataSha256: state.metadataSha256,
  };
}

function tombstoneMatches(
  left: NativeExtensionMarketplaceTombstone,
  right: NativeExtensionMarketplaceTombstone,
): boolean {
  return (
    identityMatches(tombstoneIdentity(left), tombstoneIdentity(right)) &&
    left.at === right.at &&
    left.tombstonedAt === right.tombstonedAt &&
    left.reason === right.reason
  );
}

function tombstoneFromState(
  state: NativeExtensionMarketplaceCatalogEntryState,
  identity: NativeExtensionMarketplaceEntryIdentity,
): NativeExtensionMarketplaceTombstone {
  const key = catalogEntryKey(state.extensionId, state.version);
  if (identity.key !== key) {
    trustFailure(
      "catalog-state-mismatch",
      `Catalog lifecycle state identity does not match ${key}.`,
    );
  }
  const expected = {
    bundleSha256: identity.bundleSha256,
    authorityDigest: identity.authorityDigest,
    packageTreeSha256: identity.packageTreeSha256,
    metadataSha256: identity.metadataSha256,
  };
  for (const field of Object.keys(expected) as (keyof typeof expected)[]) {
    const supplied = state[field];
    if (supplied !== undefined && supplied !== expected[field]) {
      trustFailure("catalog-rebind", `Catalog lifecycle state attempted to rebind ${key}.`);
    }
  }
  return {
    extensionId: state.extensionId,
    version: state.version,
    at: state.at,
    ...expected,
    tombstonedAt: state.at,
  };
}

function tombstoneIdentity(
  tombstone: NativeExtensionMarketplaceTombstone,
): NativeExtensionMarketplaceEntryIdentity {
  return {
    key: catalogEntryKey(tombstone.extensionId, tombstone.version),
    extensionId: tombstone.extensionId,
    version: tombstone.version,
    bundleSha256: tombstone.bundleSha256 as string,
    authorityDigest: tombstone.authorityDigest as string,
    packageTreeSha256: tombstone.packageTreeSha256 as string,
    metadataSha256: tombstone.metadataSha256 as string,
  };
}

export interface NativeExtensionMarketplaceCatalogTrustOptions extends NativeExtensionTrustOptions {
  trustedCatalogRoots?: readonly NativeExtensionTrustedPublisherKey[];
  bundleBytesByEntry?: ReadonlyMap<string, Uint8Array>;
  packageTreeSha256ByEntry?: ReadonlyMap<string, string>;
  /** Install-time selection may verify one exact local bundle without downloading other entries. */
  selectedEntryKey?: string;
  stateStore?: NativeExtensionMarketplaceCatalogStateStore;
  acceptedState?: NativeExtensionAcceptedMarketplaceCatalog;
}

/** Verify a signed catalog, its root-owned state, every entry, and exact local bundle bytes. */
export function verifyNativeExtensionMarketplaceCatalog(
  value: unknown,
  options: NativeExtensionMarketplaceCatalogTrustOptions,
): NativeExtensionVerification[] {
  assertCompareAndSwapStore(options.stateStore);
  const catalog = parseNativeExtensionMarketplaceCatalog(value);
  const now = options.now === undefined ? currentHostTime() : parseTimestamp(options.now, "now");
  assertMarketplaceIndexFreshness(
    {
      indexVersion: nativeExtensionIndexVersion,
      generatedAt: catalog.generatedAt,
      expiresAt: catalog.expiresAt,
      entries: catalog.entries,
    },
    now,
    "catalog-expired",
  );
  const previous = options.stateStore?.get() ?? options.acceptedState;
  if (previous) {
    const hash = nativeExtensionMarketplaceCatalogSha256(catalog);
    if (catalog.revision < previous.revision) {
      trustFailure("catalog-rollback", "Marketplace catalog revision moved backwards.");
    }
    if (catalog.revision === previous.revision && hash !== previous.catalogSha256) {
      trustFailure("catalog-replay", "Marketplace catalog revision was replayed with new bytes.");
    }
    if (catalog.revision > previous.revision && catalog.generatedAt <= previous.generatedAt) {
      trustFailure(
        "catalog-freeze",
        "Marketplace catalog generatedAt did not advance with revision.",
      );
    }
  }
  const roots = catalogRootsFromOptions(options);
  const root = verifyCatalogRoot(catalog, roots, now, previous);
  const publisherAnchors = verifyPublisherSuccessors(
    catalog,
    root,
    normalizeTrustAnchors(options.trustedPublishers),
    now,
    previous,
  );
  const previousKeys = new Set(previous?.entryKeys ?? []);
  const previousIdentities = new Map(
    (previous?.entryIdentities ?? []).map((identity) => [identity.key, identity]),
  );
  const previousTombstones = new Map(
    (previous?.tombstones ?? []).map((tombstone) => [
      catalogEntryKey(tombstone.extensionId, tombstone.version),
      tombstone,
    ]),
  );
  const currentKeys = new Set(
    catalog.entries.map((entry) => catalogEntryKey(entry.manifest.id, entry.manifest.version)),
  );
  if (options.selectedEntryKey !== undefined && !currentKeys.has(options.selectedEntryKey)) {
    trustFailure(
      "catalog-state-mismatch",
      `Catalog does not contain the selected entry ${options.selectedEntryKey}.`,
    );
  }
  for (const entry of catalog.entries) {
    const identity = entryIdentity(entry);
    const tombstone = previousTombstones.get(identity.key);
    if (tombstone) {
      trustFailure(
        "catalog-tombstoned",
        `Catalog attempted to re-add irreversible tombstone ${identity.key}.`,
      );
    }
    const prior = previousIdentities.get(identity.key);
    if (prior && !identityMatches(prior, identity)) {
      trustFailure(
        "catalog-rebind",
        `Catalog attempted to rebind immutable package identity ${identity.key}.`,
      );
    }
  }
  if (previous) {
    for (const key of previousKeys) {
      if (currentKeys.has(key)) continue;
      const state = [...catalog.revocations, ...catalog.delistings].find(
        (candidate) => catalogEntryKey(candidate.extensionId, candidate.version) === key,
      );
      const explicitTombstone = (catalog.tombstones ?? []).find(
        (candidate) => catalogEntryKey(candidate.extensionId, candidate.version) === key,
      );
      if (!state && !explicitTombstone) {
        trustFailure(
          "catalog-omission",
          `Catalog omitted an active previously accepted entry ${key}.`,
        );
      }
      const prior = previousIdentities.get(key);
      if (!prior) {
        trustFailure(
          "catalog-state-mismatch",
          `Catalog omission ${key} lacks complete installed-tree identity evidence.`,
        );
      }
      const tombstone =
        explicitTombstone ??
        tombstoneFromState(state as NativeExtensionMarketplaceCatalogEntryState, prior);
      const existing = previousTombstones.get(key);
      if (existing && !tombstoneMatches(existing, tombstone)) {
        trustFailure("catalog-rebind", `Catalog attempted to change tombstone identity ${key}.`);
      }
    }
  }
  for (const tombstone of catalog.tombstones ?? []) {
    const identity = tombstoneIdentity(tombstone);
    const prior = previousTombstones.get(identity.key);
    if (prior && !tombstoneMatches(prior, tombstone)) {
      trustFailure(
        "catalog-rebind",
        `Catalog attempted to change tombstone identity ${identity.key}.`,
      );
    }
    const priorActive = previousIdentities.get(identity.key);
    if (priorActive && !identityMatches(priorActive, identity)) {
      trustFailure("catalog-rebind", `Catalog tombstone identity changed for ${identity.key}.`);
    }
  }
  const catalogSha256 = nativeExtensionMarketplaceCatalogSha256(catalog);
  const trustedPublishers = normalizeTrustAnchors(options.trustedPublishers);
  const verifications = catalog.entries.map((entry): NativeExtensionVerification | null => {
    const key = catalogEntryKey(entry.manifest.id, entry.manifest.version);
    const bundleBytes = options.bundleBytesByEntry?.get(key);
    if (
      !bundleBytes &&
      (options.selectedEntryKey === undefined || options.selectedEntryKey === key)
    ) {
      trustFailure(
        "bundle-mismatch",
        `No exact bundle bytes were supplied for ${key}.`,
        entry.publisher.fingerprint,
      );
    }
    if (!bundleBytes) return null;
    const packageTreeSha256 = options.packageTreeSha256ByEntry?.get(key);
    const verification = verifyNativeExtensionDistribution(
      entry,
      bundleBytes,
      packageTreeSha256 === undefined
        ? {
            trustedPublishers: publisherAnchorsForEntry(entry, trustedPublishers, publisherAnchors),
            now,
          }
        : {
            trustedPublishers: publisherAnchorsForEntry(entry, trustedPublishers, publisherAnchors),
            now,
            packageTreeSha256,
          },
    );
    return {
      ...verification,
      trustedPublishers,
      marketplaceIndexTrust: "signed-catalog" as const,
      marketplaceCatalogRevision: catalog.revision,
      marketplaceCatalogSha256: catalogSha256,
      marketplaceCatalogRootFingerprint: root.fingerprint,
    } as NativeExtensionVerification;
  });
  if (previous && catalog.revision > previous.revision) {
    const omitted = [...previousKeys].filter((key) => !currentKeys.has(key));
    const omittedTombstones = omitted.map((key) => {
      const state = [...catalog.revocations, ...catalog.delistings].find(
        (candidate) => catalogEntryKey(candidate.extensionId, candidate.version) === key,
      );
      const explicitTombstone = (catalog.tombstones ?? []).find(
        (candidate) => catalogEntryKey(candidate.extensionId, candidate.version) === key,
      );
      const prior = previousIdentities.get(key);
      if ((!state && !explicitTombstone) || !prior) {
        trustFailure(
          "catalog-state-mismatch",
          `Catalog omission ${key} lacks immutable identity evidence.`,
        );
      }
      return (
        explicitTombstone ??
        tombstoneFromState(state as NativeExtensionMarketplaceCatalogEntryState, prior)
      );
    });
    const currentIdentities = catalog.entries.map(entryIdentity);
    const tombstones = [
      ...(previous?.tombstones ?? []),
      ...(catalog.tombstones ?? []),
      ...omittedTombstones,
    ].filter((tombstone, index, values) => {
      const key = catalogEntryKey(tombstone.extensionId, tombstone.version);
      return (
        values.findIndex(
          (candidate) => catalogEntryKey(candidate.extensionId, candidate.version) === key,
        ) === index
      );
    });
    const state = {
      stateVersion: 1 as const,
      revision: catalog.revision,
      catalogSha256,
      generatedAt: catalog.generatedAt,
      expiresAt: catalog.expiresAt,
      entryKeys: [...currentKeys].sort(),
      entryIdentities: currentIdentities.sort((left, right) =>
        left.key.localeCompare(right.key, "en-US"),
      ),
      tombstones: tombstones.sort((left, right) =>
        catalogEntryKey(left.extensionId, left.version).localeCompare(
          catalogEntryKey(right.extensionId, right.version),
          "en-US",
        ),
      ),
      successorHashes: [
        ...catalog.successorPath.map(successorHash),
        ...catalog.publisherSuccessors.map(successorHash),
        ...(previous?.successorHashes ?? []),
      ].filter((hash, index, hashes) => hashes.indexOf(hash) === index),
    } satisfies NativeExtensionAcceptedMarketplaceCatalog;
    try {
      options.stateStore?.compareAndSwap(previous?.catalogSha256 ?? null, state);
    } catch (error) {
      trustFailure(
        "catalog-interleaving",
        error instanceof Error
          ? error.message
          : "Catalog state changed while this catalog was being accepted.",
      );
    }
  } else if (!previous) {
    const state = {
      stateVersion: 1,
      revision: catalog.revision,
      catalogSha256,
      generatedAt: catalog.generatedAt,
      expiresAt: catalog.expiresAt,
      entryKeys: [...currentKeys].sort(),
      entryIdentities: catalog.entries
        .map(entryIdentity)
        .sort((left, right) => left.key.localeCompare(right.key, "en-US")),
      tombstones: [...(catalog.tombstones ?? [])],
      successorHashes: [
        ...catalog.successorPath.map(successorHash),
        ...catalog.publisherSuccessors.map(successorHash),
      ].filter((hash, index, hashes) => hashes.indexOf(hash) === index),
    } satisfies NativeExtensionAcceptedMarketplaceCatalog;
    try {
      options.stateStore?.compareAndSwap(null, state);
    } catch (error) {
      trustFailure(
        "catalog-interleaving",
        error instanceof Error
          ? error.message
          : "Catalog state changed while this catalog was being accepted.",
      );
    }
  }
  return verifications.filter((verification) => verification !== null);
}

export function createNativeExtensionMarketplaceCatalog(
  input: Omit<NativeExtensionMarketplaceCatalog, "catalogVersion" | "entriesSha256" | "signature">,
  privateKey: KeyObject,
): NativeExtensionMarketplaceCatalog {
  const catalogRoot = normalizePublisherKey(input.catalogRoot, "catalogRoot");
  const signingRoot = nativeExtensionPublisherKeyFromKeyObject({
    publisherId: catalogRoot.publisherId,
    keyId: catalogRoot.keyId,
    key: privateKey,
  });
  if (!comparePublisherKeys(catalogRoot, signingRoot)) {
    trustFailure("catalog-untrusted", "Catalog signing key does not match catalogRoot.");
  }
  const entries = parseCatalogEntries(input.entries);
  const entriesSha256 = createHash("sha256").update(canonicalJson(entries), "utf8").digest("hex");
  const unsigned: NativeExtensionMarketplaceCatalog = {
    catalogVersion: nativeExtensionMarketplaceCatalogVersion,
    revision: input.revision,
    generatedAt: parseTimestamp(input.generatedAt, "generatedAt"),
    expiresAt: parseTimestamp(input.expiresAt, "expiresAt"),
    catalogRoot,
    entriesSha256,
    entries,
    revocations: sortedCatalogStates(input.revocations),
    delistings: sortedCatalogStates(input.delistings),
    tombstones: sortedCatalogTombstones(input.tombstones ?? []),
    successorPath: input.successorPath.map((successor) =>
      parseSuccessor(successor, "successorPath"),
    ),
    publisherSuccessors: input.publisherSuccessors.map((successor) =>
      parseSuccessor(successor, "publisherSuccessors"),
    ),
    // A temporary canonical 64-byte value lets the strict parser validate every other field
    // before the real root signature is produced.
    signature: "A".repeat(nativeExtensionEd25519SignatureBase64urlLength),
  };
  const parsed = parseNativeExtensionMarketplaceCatalog(unsigned);
  const signature = sign(
    null,
    Buffer.from(canonicalJson(catalogPayload(parsed)), "utf8"),
    privateKey,
  );
  return { ...parsed, signature: encodeBase64url(signature) };
}

export function signNativeExtensionMarketplaceSuccessor(
  input: Omit<NativeExtensionMarketplaceSuccessor, "successorVersion" | "signature">,
  rootPrivateKey: KeyObject,
): NativeExtensionMarketplaceSuccessor {
  const issuedAt = parseTimestamp(input.issuedAt, "successor.issuedAt");
  const effectiveAt = parseTimestamp(input.effectiveAt, "successor.effectiveAt");
  if (effectiveAt < issuedAt) {
    trustFailure("catalog-successor-invalid", "successor.effectiveAt cannot precede issuedAt.");
  }
  const successor: NativeExtensionMarketplaceSuccessor = {
    successorVersion: nativeExtensionMarketplaceSuccessorVersion,
    previous: normalizePublisherKey(input.previous, "successor.previous"),
    next: normalizePublisherKey(input.next, "successor.next"),
    issuedAt,
    effectiveAt,
    signature: "",
  };
  const signature = sign(
    null,
    Buffer.from(canonicalJson(successorPayload(successor)), "utf8"),
    rootPrivateKey,
  );
  return { ...successor, signature: encodeBase64url(signature) };
}
