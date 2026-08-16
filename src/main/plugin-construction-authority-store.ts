import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";

import {
  atomicWriteFile,
  durableCreate,
  readStableFileWithinLimit,
  syncDirectory,
} from "../kernel/durability";
import { acquireStateLockAsync } from "../private-state-lock";
import { authorityJsonSha256 } from "../shared/authority-json";
import {
  type CommunityPluginGrantV2,
  type ExactPluginPackageIdentity,
  type PluginCapabilityGrantState,
  type PluginCapabilityId,
  type PluginConstructionPath,
  type PluginConstructionRequest,
  pluginCapabilityIds,
  type ReviewedAuthorityExecutionProfile,
  type ReviewedAuthorityPlatform,
  type ReviewedAuthorityProfile,
  reviewedAuthorityExecutionProfiles,
  reviewedAuthorityPlatforms,
  type SealedPluginPackageRecord,
} from "../shared/plugins";
import {
  capturePluginPackageTree,
  inspectCapturedPluginPackage,
  inspectSealedPluginPackage,
  type PluginConstructionAuthoritySnapshot,
} from "./plugin-construction-policy";
import {
  reviewedAuthorityProfileByIdentity,
  reviewedAuthorityProfiles,
} from "./reviewed-authority-profiles";

const authorityStateVersion = 1 as const;
const authorityAnchorVersion = 1 as const;
const sealedPackagePointerVersion = 1 as const;
const maxAuthorityStateBytes = 4 * 1024 * 1024;
const maxPointerBytes = 64 * 1024;
const maxGrantRecords = 4_096;
const maxKnownPackages = 1_024;
const authorityLockTimeoutMs = 10_000;
const digestPattern = /^[a-f0-9]{64}$/u;
const vaultIdPattern = /^[a-f0-9]{64}$/u;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/u;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const decoder = new TextDecoder("utf-8", { fatal: true });

interface PluginAuthorityStateFile {
  version: typeof authorityStateVersion;
  vaultId: string;
  vaultRoot: string;
  vaultRootFingerprint: string;
  stateRevision: number;
  previousStateDigest: string | null;
  vaultGeneration: number;
  policyEpoch: number;
  grantEpoch: number;
  safeMode: boolean;
  safeModeEpoch: number;
  packageStoreEpoch: number;
  knownPackageIdentityDigests: string[];
  grants: CommunityPluginGrantV2[];
}

interface PluginAuthorityStateAnchor {
  version: typeof authorityAnchorVersion;
  vaultId: string;
  vaultRootFingerprint: string;
  stateRevision: number;
  stateDigest: string;
  vaultGeneration: number;
  policyEpoch: number;
  grantEpoch: number;
  safeModeEpoch: number;
  packageStoreEpoch: number;
}

interface VaultRootBinding {
  canonicalRoot: string;
  fingerprint: string;
}

interface SealedPackagePointer {
  version: typeof sealedPackagePointerVersion;
  sealedPackageRootId: string;
  objectId: string;
  packageIdentityDigest: string;
  packageTreeSha256: string;
  createdAt: string;
}

export interface PreparePluginConstructionInput {
  pluginDirectory: string;
  reportedMainSha256: string;
  constructionPath: PluginConstructionPath;
}

export interface PluginConstructionAuthorityStoreOptions {
  now?(): Date;
  createId?(): string;
  platform?: ReviewedAuthorityPlatform;
  availableExecutionProfiles?: readonly ReviewedAuthorityExecutionProfile[];
  profiles?(): ReviewedAuthorityProfile[];
  profileByIdentity?(packageIdentityDigest: string): ReviewedAuthorityProfile | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains missing or unknown fields.`);
  }
}

function requireSafeEpoch(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be a monotonic safe integer.`);
  }
  return value;
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function requireIsoDate(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO date.`);
  }
  return value;
}

function requireVersion(value: unknown, label: string): string {
  if (typeof value !== "string" || !versionPattern.test(value)) {
    throw new Error(`${label} must be an exact non-floating version or distribution tag.`);
  }
  return value;
}

function parseCapabilities(value: unknown, label: string): PluginCapabilityId[] {
  if (!Array.isArray(value) || value.length > pluginCapabilityIds.length) {
    throw new Error(`${label} must be a bounded capability array.`);
  }
  const capabilities = value.map((candidate): PluginCapabilityId => {
    if (
      typeof candidate !== "string" ||
      !pluginCapabilityIds.includes(candidate as PluginCapabilityId)
    ) {
      throw new Error(`${label} contains an unknown capability.`);
    }
    return candidate as PluginCapabilityId;
  });
  if (new Set(capabilities).size !== capabilities.length) {
    throw new Error(`${label} contains duplicate capabilities.`);
  }
  return capabilities;
}

function parsePackageIdentity(value: unknown): ExactPluginPackageIdentity {
  if (!isRecord(value)) {
    throw new Error("Plugin grant requires a complete package identity.");
  }
  requireExactKeys(
    value,
    [
      "pluginId",
      "manifestVersion",
      "distributionTag",
      "manifestSha256",
      "mainSha256",
      "stylesSha256",
      "packageTreeSha256",
    ],
    "Plugin grant package identity",
  );
  if (
    typeof value.pluginId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.pluginId) ||
    typeof value.manifestVersion !== "string" ||
    typeof value.distributionTag !== "string"
  ) {
    throw new Error("Plugin grant package identity metadata is invalid.");
  }
  return {
    pluginId: value.pluginId,
    manifestVersion: requireVersion(value.manifestVersion, "manifestVersion"),
    distributionTag: requireVersion(value.distributionTag, "distributionTag"),
    manifestSha256: requireDigest(value.manifestSha256, "manifestSha256"),
    mainSha256: requireDigest(value.mainSha256, "mainSha256"),
    stylesSha256:
      value.stylesSha256 === null ? null : requireDigest(value.stylesSha256, "stylesSha256"),
    packageTreeSha256: requireDigest(value.packageTreeSha256, "packageTreeSha256"),
  };
}

function parseGrant(value: unknown): CommunityPluginGrantV2 {
  if (!isRecord(value)) {
    throw new Error("Plugin authority history contains an invalid grant record.");
  }
  requireExactKeys(
    value,
    [
      "schemaVersion",
      "grantId",
      "vaultId",
      "packageIdentity",
      "packageIdentityDigest",
      "authorityProfileId",
      "authorityProfileRevision",
      "authorityDigest",
      "grantedAuthorities",
      "provenance",
      "grantRevision",
      "grantEpoch",
      "issuedAt",
      "revokedAt",
      "revocationReason",
    ],
    "Plugin authority grant",
  );
  if (
    value.schemaVersion !== 2 ||
    typeof value.grantId !== "string" ||
    !uuidPattern.test(value.grantId) ||
    typeof value.vaultId !== "string" ||
    !vaultIdPattern.test(value.vaultId) ||
    typeof value.authorityProfileId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.authorityProfileId) ||
    (typeof value.revocationReason !== "string" && value.revocationReason !== null)
  ) {
    throw new Error("Plugin authority grant metadata is invalid.");
  }
  const packageIdentity = parsePackageIdentity(value.packageIdentity);
  const packageIdentityDigest = requireDigest(value.packageIdentityDigest, "packageIdentityDigest");
  if (packageIdentityDigest !== authorityJsonSha256(packageIdentity)) {
    throw new Error("Plugin authority grant package identity digest is stale.");
  }
  if (!isRecord(value.provenance)) {
    throw new Error("Plugin authority grant provenance is invalid.");
  }
  let provenance: CommunityPluginGrantV2["provenance"];
  if (value.provenance.kind === "content-addressed-unsigned") {
    requireExactKeys(
      value.provenance,
      ["kind", "sourceDescriptorDigest"],
      "Unsigned plugin grant provenance",
    );
    provenance = {
      kind: "content-addressed-unsigned",
      sourceDescriptorDigest: requireDigest(
        value.provenance.sourceDescriptorDigest,
        "sourceDescriptorDigest",
      ),
    };
  } else if (value.provenance.kind === "signed-distribution") {
    requireExactKeys(
      value.provenance,
      ["kind", "releaseDigest", "signerKeyId", "signatureDigest"],
      "Signed plugin grant provenance",
    );
    if (typeof value.provenance.signerKeyId !== "string") {
      throw new Error("Signed plugin grant signer identity is invalid.");
    }
    provenance = {
      kind: "signed-distribution",
      releaseDigest: requireDigest(value.provenance.releaseDigest, "releaseDigest"),
      signerKeyId: value.provenance.signerKeyId,
      signatureDigest: requireDigest(value.provenance.signatureDigest, "signatureDigest"),
    };
  } else {
    throw new Error("Plugin authority grant provenance kind is invalid.");
  }
  const revokedAt = value.revokedAt === null ? null : requireIsoDate(value.revokedAt, "revokedAt");
  if (
    (revokedAt === null && value.revocationReason !== null) ||
    (revokedAt !== null &&
      (typeof value.revocationReason !== "string" ||
        value.revocationReason.length === 0 ||
        value.revocationReason.length > 500))
  ) {
    throw new Error("Plugin authority grant revocation state is invalid.");
  }
  return {
    schemaVersion: 2,
    grantId: value.grantId,
    vaultId: value.vaultId,
    packageIdentity,
    packageIdentityDigest,
    authorityProfileId: value.authorityProfileId,
    authorityProfileRevision: requireSafeEpoch(
      value.authorityProfileRevision,
      "authorityProfileRevision",
      1,
    ),
    authorityDigest: requireDigest(value.authorityDigest, "authorityDigest"),
    grantedAuthorities: parseCapabilities(value.grantedAuthorities, "grantedAuthorities"),
    provenance,
    grantRevision: requireSafeEpoch(value.grantRevision, "grantRevision", 1),
    grantEpoch: requireSafeEpoch(value.grantEpoch, "grantEpoch", 1),
    issuedAt: requireIsoDate(value.issuedAt, "issuedAt"),
    revokedAt,
    revocationReason: value.revocationReason,
  };
}

function immutableGrantPayload(grant: CommunityPluginGrantV2): unknown {
  return {
    schemaVersion: grant.schemaVersion,
    grantId: grant.grantId,
    vaultId: grant.vaultId,
    packageIdentity: grant.packageIdentity,
    packageIdentityDigest: grant.packageIdentityDigest,
    authorityProfileId: grant.authorityProfileId,
    authorityProfileRevision: grant.authorityProfileRevision,
    authorityDigest: grant.authorityDigest,
    grantedAuthorities: grant.grantedAuthorities,
    provenance: grant.provenance,
    issuedAt: grant.issuedAt,
  };
}

function sameImmutableGrant(left: CommunityPluginGrantV2, right: CommunityPluginGrantV2): boolean {
  return (
    authorityJsonSha256(immutableGrantPayload(left)) ===
    authorityJsonSha256(immutableGrantPayload(right))
  );
}

function parseAuthorityState(value: unknown, expectedVaultId: string): PluginAuthorityStateFile {
  if (!isRecord(value)) {
    throw new Error("Plugin authority state must be a JSON object.");
  }
  requireExactKeys(
    value,
    [
      "version",
      "vaultId",
      "vaultRoot",
      "vaultRootFingerprint",
      "stateRevision",
      "previousStateDigest",
      "vaultGeneration",
      "policyEpoch",
      "grantEpoch",
      "safeMode",
      "safeModeEpoch",
      "packageStoreEpoch",
      "knownPackageIdentityDigests",
      "grants",
    ],
    "Plugin authority state",
  );
  if (
    value.version !== authorityStateVersion ||
    value.vaultId !== expectedVaultId ||
    typeof value.vaultRoot !== "string" ||
    !path.isAbsolute(value.vaultRoot) ||
    value.vaultRoot.length === 0 ||
    value.vaultRoot.length > 8_192 ||
    typeof value.safeMode !== "boolean" ||
    !Array.isArray(value.knownPackageIdentityDigests) ||
    value.knownPackageIdentityDigests.length > maxKnownPackages ||
    !Array.isArray(value.grants) ||
    value.grants.length > maxGrantRecords
  ) {
    throw new Error("Plugin authority state metadata is invalid.");
  }
  const knownPackageIdentityDigests = value.knownPackageIdentityDigests.map((candidate) =>
    requireDigest(candidate, "known package identity"),
  );
  if (new Set(knownPackageIdentityDigests).size !== knownPackageIdentityDigests.length) {
    throw new Error("Plugin authority state contains duplicate package identities.");
  }
  const grants = value.grants.map(parseGrant);
  const stateRevision = requireSafeEpoch(value.stateRevision, "stateRevision", 1);
  const previousStateDigest =
    value.previousStateDigest === null
      ? null
      : requireDigest(value.previousStateDigest, "previousStateDigest");
  if ((stateRevision === 1) !== (previousStateDigest === null)) {
    throw new Error("Plugin authority state hash-chain predecessor is invalid.");
  }
  const revisions = new Map<string, CommunityPluginGrantV2>();
  const activeGrantByPlugin = new Map<string, string>();
  let previousGrantEpoch = 0;
  for (const grant of grants) {
    if (grant.vaultId !== expectedVaultId) {
      throw new Error("Plugin authority grant crossed its vault boundary.");
    }
    if (grant.grantEpoch <= previousGrantEpoch) {
      throw new Error("Plugin authority grant epochs are not globally append-only.");
    }
    previousGrantEpoch = grant.grantEpoch;
    const previous = revisions.get(grant.grantId);
    const pluginId = grant.packageIdentity.pluginId;
    if (!previous) {
      if (
        grant.grantRevision !== 1 ||
        grant.revokedAt !== null ||
        activeGrantByPlugin.has(pluginId)
      ) {
        throw new Error("Plugin authority grant creation history is not append-only.");
      }
      activeGrantByPlugin.set(pluginId, grant.grantId);
    } else {
      if (
        grant.grantRevision !== previous.grantRevision + 1 ||
        previous.revokedAt !== null ||
        grant.revokedAt === null ||
        !sameImmutableGrant(previous, grant) ||
        activeGrantByPlugin.get(pluginId) !== grant.grantId
      ) {
        throw new Error("Plugin authority grant revision history is not append-only.");
      }
      activeGrantByPlugin.delete(pluginId);
    }
    revisions.set(grant.grantId, grant);
  }
  const state = {
    version: authorityStateVersion,
    vaultId: expectedVaultId,
    vaultRoot: value.vaultRoot,
    vaultRootFingerprint: requireDigest(value.vaultRootFingerprint, "vaultRootFingerprint"),
    stateRevision,
    previousStateDigest,
    vaultGeneration: requireSafeEpoch(value.vaultGeneration, "vaultGeneration"),
    policyEpoch: requireSafeEpoch(value.policyEpoch, "policyEpoch"),
    grantEpoch: requireSafeEpoch(value.grantEpoch, "grantEpoch"),
    safeMode: value.safeMode,
    safeModeEpoch: requireSafeEpoch(value.safeModeEpoch, "safeModeEpoch"),
    packageStoreEpoch: requireSafeEpoch(value.packageStoreEpoch, "packageStoreEpoch"),
    knownPackageIdentityDigests,
    grants,
  } satisfies PluginAuthorityStateFile;
  if (state.grantEpoch !== previousGrantEpoch) {
    throw new Error("Plugin authority state grant epoch differs from its append-only history.");
  }
  if (grants.some((grant) => !knownPackageIdentityDigests.includes(grant.packageIdentityDigest))) {
    throw new Error("Plugin authority history references an unknown sealed package identity.");
  }
  return state;
}

function parseAuthorityAnchor(value: unknown, expectedVaultId: string): PluginAuthorityStateAnchor {
  if (!isRecord(value)) {
    throw new Error("Plugin authority high-water anchor must be a JSON object.");
  }
  requireExactKeys(
    value,
    [
      "version",
      "vaultId",
      "vaultRootFingerprint",
      "stateRevision",
      "stateDigest",
      "vaultGeneration",
      "policyEpoch",
      "grantEpoch",
      "safeModeEpoch",
      "packageStoreEpoch",
    ],
    "Plugin authority high-water anchor",
  );
  if (value.version !== authorityAnchorVersion || value.vaultId !== expectedVaultId) {
    throw new Error("Plugin authority high-water anchor metadata is invalid.");
  }
  return {
    version: authorityAnchorVersion,
    vaultId: expectedVaultId,
    vaultRootFingerprint: requireDigest(value.vaultRootFingerprint, "anchor vaultRootFingerprint"),
    stateRevision: requireSafeEpoch(value.stateRevision, "anchor stateRevision", 1),
    stateDigest: requireDigest(value.stateDigest, "anchor stateDigest"),
    vaultGeneration: requireSafeEpoch(value.vaultGeneration, "anchor vaultGeneration"),
    policyEpoch: requireSafeEpoch(value.policyEpoch, "anchor policyEpoch"),
    grantEpoch: requireSafeEpoch(value.grantEpoch, "anchor grantEpoch"),
    safeModeEpoch: requireSafeEpoch(value.safeModeEpoch, "anchor safeModeEpoch"),
    packageStoreEpoch: requireSafeEpoch(value.packageStoreEpoch, "anchor packageStoreEpoch"),
  };
}

function parsePointer(value: unknown): SealedPackagePointer {
  if (!isRecord(value)) {
    throw new Error("Sealed plugin package pointer must be a JSON object.");
  }
  requireExactKeys(
    value,
    [
      "version",
      "sealedPackageRootId",
      "objectId",
      "packageIdentityDigest",
      "packageTreeSha256",
      "createdAt",
    ],
    "Sealed plugin package pointer",
  );
  if (
    value.version !== sealedPackagePointerVersion ||
    typeof value.sealedPackageRootId !== "string" ||
    typeof value.objectId !== "string"
  ) {
    throw new Error("Sealed plugin package pointer metadata is invalid.");
  }
  return {
    version: sealedPackagePointerVersion,
    sealedPackageRootId: value.sealedPackageRootId,
    objectId: requireDigest(value.objectId, "pointer objectId"),
    packageIdentityDigest: requireDigest(
      value.packageIdentityDigest,
      "pointer packageIdentityDigest",
    ),
    packageTreeSha256: requireDigest(value.packageTreeSha256, "pointer packageTreeSha256"),
    createdAt: requireIsoDate(value.createdAt, "pointer createdAt"),
  };
}

function defaultState(
  vaultId: string,
  safeMode: boolean,
  binding: VaultRootBinding,
): PluginAuthorityStateFile {
  return {
    version: authorityStateVersion,
    vaultId,
    vaultRoot: binding.canonicalRoot,
    vaultRootFingerprint: binding.fingerprint,
    stateRevision: 0,
    previousStateDigest: null,
    vaultGeneration: 0,
    policyEpoch: 0,
    grantEpoch: 0,
    safeMode,
    safeModeEpoch: 0,
    packageStoreEpoch: 0,
    knownPackageIdentityDigests: [],
    grants: [],
  };
}

function isRecoverableInitialState(
  state: PluginAuthorityStateFile,
  initial: { safeMode: boolean; binding: VaultRootBinding },
): boolean {
  return (
    state.vaultRoot === initial.binding.canonicalRoot &&
    state.vaultRootFingerprint === initial.binding.fingerprint &&
    state.stateRevision === 1 &&
    state.previousStateDigest === null &&
    state.vaultGeneration === 1 &&
    state.policyEpoch === 1 &&
    state.grantEpoch === 0 &&
    state.safeMode === initial.safeMode &&
    state.safeModeEpoch === 1 &&
    state.packageStoreEpoch === 0 &&
    state.knownPackageIdentityDigests.length === 0 &&
    state.grants.length === 0
  );
}

function cloneIdentity(identity: ExactPluginPackageIdentity): ExactPluginPackageIdentity {
  return { ...identity };
}

function cloneGrant(grant: CommunityPluginGrantV2): CommunityPluginGrantV2 {
  return {
    ...grant,
    packageIdentity: cloneIdentity(grant.packageIdentity),
    grantedAuthorities: [...grant.grantedAuthorities],
    provenance: { ...grant.provenance },
  };
}

function cloneState(state: PluginAuthorityStateFile): PluginAuthorityStateFile {
  return {
    ...state,
    knownPackageIdentityDigests: [...state.knownPackageIdentityDigests],
    grants: state.grants.map(cloneGrant),
  };
}

function sameCapabilities(
  left: readonly PluginCapabilityId[],
  right: readonly PluginCapabilityId[],
): boolean {
  return authorityJsonSha256([...left].sort()) === authorityJsonSha256([...right].sort());
}

function profileBaseMatches(
  profile: ReviewedAuthorityProfile,
  identity: ExactPluginPackageIdentity,
): boolean {
  const reviewed = profile.packageIdentity;
  return (
    reviewed.pluginId === identity.pluginId &&
    reviewed.manifestVersion === identity.manifestVersion &&
    reviewed.manifestSha256 === identity.manifestSha256 &&
    reviewed.mainSha256 === identity.mainSha256 &&
    reviewed.stylesSha256 === identity.stylesSha256 &&
    reviewed.packageTreeSha256 === identity.packageTreeSha256
  );
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function latestGrantForPlugin(
  state: PluginAuthorityStateFile,
  pluginId: string,
): CommunityPluginGrantV2 | null {
  for (let index = state.grants.length - 1; index >= 0; index -= 1) {
    const grant = state.grants[index];
    if (grant?.packageIdentity.pluginId === pluginId) {
      return cloneGrant(grant);
    }
  }
  return null;
}

function stateBytes(state: PluginAuthorityStateFile): Buffer {
  return Buffer.from(`${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function stateDigest(state: PluginAuthorityStateFile): string {
  return authorityJsonSha256(state);
}

function anchorForState(state: PluginAuthorityStateFile): PluginAuthorityStateAnchor {
  return {
    version: authorityAnchorVersion,
    vaultId: state.vaultId,
    vaultRootFingerprint: state.vaultRootFingerprint,
    stateRevision: state.stateRevision,
    stateDigest: stateDigest(state),
    vaultGeneration: state.vaultGeneration,
    policyEpoch: state.policyEpoch,
    grantEpoch: state.grantEpoch,
    safeModeEpoch: state.safeModeEpoch,
    packageStoreEpoch: state.packageStoreEpoch,
  };
}

function anchorBytes(anchor: PluginAuthorityStateAnchor): Buffer {
  return Buffer.from(`${JSON.stringify(anchor, null, 2)}\n`, "utf8");
}

function pointerBytes(pointer: SealedPackagePointer): Buffer {
  return Buffer.from(`${JSON.stringify(pointer, null, 2)}\n`, "utf8");
}

async function durableCreateReadOnly(filePath: string, bytes: Uint8Array): Promise<void> {
  const handle = await fs.open(
    filePath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    0o400,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(filePath));
}

export class PluginConstructionAuthoritySession {
  constructor(
    private readonly store: PluginConstructionAuthorityStore,
    readonly vaultId: string,
    readonly vaultRoot: string,
    readonly vaultRootFingerprint: string,
    readonly vaultGeneration: number,
  ) {}

  prepareConstructionRequest(
    input: PreparePluginConstructionInput,
  ): Promise<PluginConstructionRequest> {
    return this.store.prepareConstructionRequest(this, input);
  }

  issueGrant(request: PluginConstructionRequest): Promise<CommunityPluginGrantV2> {
    return this.store.issueGrant(this, request);
  }

  revokePlugin(pluginId: string, reason = "user-revoked"): Promise<CommunityPluginGrantV2 | null> {
    return this.store.revokePlugin(this, pluginId, reason);
  }

  grantState(
    request: PluginConstructionRequest,
    legacyState: PluginCapabilityGrantState,
  ): Promise<PluginCapabilityGrantState> {
    return this.store.grantState(this, request, legacyState);
  }

  readAuthoritySnapshot(
    request: PluginConstructionRequest,
  ): Promise<PluginConstructionAuthoritySnapshot> {
    return this.store.readAuthoritySnapshot(this, request);
  }

  setSafeMode(safeMode: boolean): Promise<void> {
    return this.store.setSafeMode(this, safeMode);
  }
}

export class PluginConstructionAuthorityStore {
  #stateRoot: string;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #platform: ReviewedAuthorityPlatform;
  readonly #availableExecutionProfiles: ReviewedAuthorityExecutionProfile[];
  readonly #profiles: () => ReviewedAuthorityProfile[];
  readonly #profileByIdentity: (packageIdentityDigest: string) => ReviewedAuthorityProfile | null;
  readonly #sessions = new WeakSet<PluginConstructionAuthoritySession>();
  #tail: Promise<void> = Promise.resolve();
  #initialized = false;

  constructor(stateRoot: string, options: PluginConstructionAuthorityStoreOptions = {}) {
    this.#stateRoot = path.resolve(stateRoot);
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
    this.#platform = options.platform ?? (process.platform as ReviewedAuthorityPlatform);
    if (!reviewedAuthorityPlatforms.includes(this.#platform)) {
      throw new Error("Plugin construction authority is unavailable on this platform.");
    }
    this.#availableExecutionProfiles = [
      ...(options.availableExecutionProfiles ?? [
        "trusted-node-renderer",
        "trusted-desktop-escape",
      ]),
    ];
    if (
      new Set(this.#availableExecutionProfiles).size !== this.#availableExecutionProfiles.length ||
      this.#availableExecutionProfiles.some(
        (profile) => !reviewedAuthorityExecutionProfiles.includes(profile),
      )
    ) {
      throw new Error("Plugin construction authority has invalid execution profiles.");
    }
    this.#profiles = options.profiles ?? reviewedAuthorityProfiles;
    this.#profileByIdentity = options.profileByIdentity ?? reviewedAuthorityProfileByIdentity;
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.#stateRoot, { recursive: true, mode: 0o700 });
    const lexicalRoot = await fs.lstat(this.#stateRoot);
    if (!lexicalRoot.isDirectory() || lexicalRoot.isSymbolicLink()) {
      throw new Error("Plugin construction authority root must be a real directory.");
    }
    this.#stateRoot = await fs.realpath(this.#stateRoot);
    await fs.chmod(this.#stateRoot, 0o700);
    const lock = await acquireStateLockAsync(this.#lockPath(), {
      timeoutMs: authorityLockTimeoutMs,
      pollIntervalMs: 10,
    });
    try {
      lock.assertPathIdentity();
      await this.#ensureStoreDirectory(this.#objectsRoot(), this.#stateRoot);
      await this.#ensureStoreDirectory(this.#pointersRoot(), this.#stateRoot);
      await this.#ensureStoreDirectory(this.#vaultsRoot(), this.#stateRoot);
      await this.#ensureStoreDirectory(this.#anchorsRoot(), this.#stateRoot);
      await this.#assertStoreLayout();
      this.#initialized = true;
    } finally {
      lock.close();
    }
  }

  async activateVault(
    vaultIdValue: string,
    vaultRootValue: string,
    safeMode: boolean,
  ): Promise<PluginConstructionAuthoritySession> {
    return this.#enqueue(async () => {
      this.#assertInitialized();
      const vaultId = this.#parseVaultId(vaultIdValue);
      const binding = await this.#bindVaultRoot(vaultRootValue);
      if (vaultId !== this.#vaultIdForRoot(binding.canonicalRoot)) {
        throw new Error("Plugin construction vault identity does not match its canonical root.");
      }
      if (
        isPathInside(binding.canonicalRoot, this.#stateRoot) ||
        isPathInside(this.#stateRoot, binding.canonicalRoot)
      ) {
        throw new Error("Plugin construction authority state must remain outside the vault.");
      }
      const current = await this.#loadState(vaultId, { safeMode, binding });
      this.#assertStateBinding(current, binding);
      const next = cloneState(current);
      next.vaultGeneration += 1;
      next.policyEpoch += 1;
      if (next.safeModeEpoch === 0 || next.safeMode !== safeMode) {
        next.safeMode = safeMode;
        next.safeModeEpoch += 1;
      }
      const saved = await this.#saveState(current, next);
      const session = new PluginConstructionAuthoritySession(
        this,
        vaultId,
        binding.canonicalRoot,
        binding.fingerprint,
        saved.vaultGeneration,
      );
      this.#sessions.add(session);
      return session;
    });
  }

  prepareConstructionRequest(
    session: PluginConstructionAuthoritySession,
    input: PreparePluginConstructionInput,
  ): Promise<PluginConstructionRequest> {
    return this.#enqueue(async () => {
      const state = await this.#currentSessionState(session);
      const pluginDirectory = await this.#assertPluginSource(session, input.pluginDirectory);
      const captured = await capturePluginPackageTree(pluginDirectory);
      const preliminary = inspectCapturedPluginPackage(captured, this.#manifestVersion(captured));
      if (preliminary.identity.mainSha256 !== input.reportedMainSha256) {
        throw new Error("Installed plugin changed after its authority report was measured.");
      }
      const candidates = this.#profiles().filter((profile) =>
        profileBaseMatches(profile, preliminary.identity),
      );
      if (candidates.length > 1) {
        throw new Error("Installed plugin matches multiple reviewed distribution identities.");
      }
      const inspected = candidates[0]
        ? inspectCapturedPluginPackage(captured, candidates[0].packageIdentity.distributionTag)
        : preliminary;
      const request: PluginConstructionRequest = {
        constructionPath: input.constructionPath,
        pluginDirectory,
        packageIdentity: cloneIdentity(inspected.identity),
        packageIdentityDigest: inspected.identityDigest,
      };
      const profile = this.#profileByIdentity(inspected.identityDigest);
      if (!profile) {
        return request;
      }
      await this.#publishCapturedPackage(captured, inspected.identity, inspected.identityDigest);
      if (!state.knownPackageIdentityDigests.includes(inspected.identityDigest)) {
        if (state.knownPackageIdentityDigests.length >= maxKnownPackages) {
          throw new Error("Plugin construction package-store history is full.");
        }
        const next = cloneState(state);
        next.knownPackageIdentityDigests.push(inspected.identityDigest);
        next.knownPackageIdentityDigests.sort();
        next.packageStoreEpoch += 1;
        next.policyEpoch += 1;
        await this.#saveState(state, next);
      }
      return request;
    });
  }

  issueGrant(
    session: PluginConstructionAuthoritySession,
    request: PluginConstructionRequest,
  ): Promise<CommunityPluginGrantV2> {
    return this.#enqueue(async () => {
      const state = await this.#currentSessionState(session);
      const profile = this.#profileByIdentity(request.packageIdentityDigest);
      if (
        !profile ||
        profile.packageIdentityDigest !== request.packageIdentityDigest ||
        authorityJsonSha256(profile.packageIdentity) !== request.packageIdentityDigest ||
        authorityJsonSha256(request.packageIdentity) !== request.packageIdentityDigest
      ) {
        throw new Error("Plugin has no current exact-package reviewed authority profile.");
      }
      if (
        !profile.allowedPlatforms.includes(this.#platform) ||
        !this.#availableExecutionProfiles.includes(profile.executionProfile)
      ) {
        throw new Error("Plugin reviewed authority is unavailable on this platform.");
      }
      const sealedPackage = await this.#readSealedPackage(request);
      if (
        !sealedPackage ||
        !state.knownPackageIdentityDigests.includes(request.packageIdentityDigest)
      ) {
        throw new Error("Plugin exact package has not been sealed for construction.");
      }
      const inspected = await inspectSealedPluginPackage(
        sealedPackage,
        profile.packageIdentity.distributionTag,
      );
      if (
        inspected.identityDigest !== profile.packageIdentityDigest ||
        authorityJsonSha256(inspected.identity) !== profile.packageIdentityDigest ||
        !sameCapabilities(inspected.staticCapabilities, profile.expectedStaticCapabilities)
      ) {
        throw new Error("Plugin sealed package differs from its reviewed authority profile.");
      }
      const existing = latestGrantForPlugin(state, profile.packageIdentity.pluginId);
      if (
        existing &&
        existing.revokedAt === null &&
        existing.packageIdentityDigest === profile.packageIdentityDigest &&
        existing.authorityProfileId === profile.profileId &&
        existing.authorityProfileRevision === profile.profileRevision &&
        existing.authorityDigest === profile.authorityDigest &&
        sameCapabilities(existing.grantedAuthorities, profile.requiredAuthorities)
      ) {
        return existing;
      }
      if (state.grants.length + (existing?.revokedAt === null ? 2 : 1) > maxGrantRecords) {
        throw new Error("Plugin construction grant history is full.");
      }
      const next = cloneState(state);
      const issuedAt = this.#now().toISOString();
      if (existing && existing.revokedAt === null) {
        next.grantEpoch += 1;
        next.policyEpoch += 1;
        next.grants.push({
          ...existing,
          grantRevision: existing.grantRevision + 1,
          grantEpoch: next.grantEpoch,
          revokedAt: issuedAt,
          revocationReason: "superseded-by-exact-package-grant",
        });
      }
      next.grantEpoch += 1;
      next.policyEpoch += 1;
      const grantId = this.#createId();
      if (!uuidPattern.test(grantId)) {
        throw new Error("Plugin construction grant identity is invalid.");
      }
      const grant: CommunityPluginGrantV2 = {
        schemaVersion: 2,
        grantId,
        vaultId: session.vaultId,
        packageIdentity: cloneIdentity(profile.packageIdentity),
        packageIdentityDigest: profile.packageIdentityDigest,
        authorityProfileId: profile.profileId,
        authorityProfileRevision: profile.profileRevision,
        authorityDigest: profile.authorityDigest,
        grantedAuthorities: [...profile.requiredAuthorities],
        provenance: {
          kind: "content-addressed-unsigned",
          sourceDescriptorDigest: authorityJsonSha256({
            schemaVersion: 1,
            source: "vault-installed-package",
            packageIdentityDigest: profile.packageIdentityDigest,
            packageTreeSha256: profile.packageIdentity.packageTreeSha256,
          }),
        },
        grantRevision: 1,
        grantEpoch: next.grantEpoch,
        issuedAt,
        revokedAt: null,
        revocationReason: null,
      };
      next.grants.push(grant);
      await this.#saveState(state, next);
      return cloneGrant(grant);
    });
  }

  revokePlugin(
    session: PluginConstructionAuthoritySession,
    pluginId: string,
    reason: string,
  ): Promise<CommunityPluginGrantV2 | null> {
    return this.#enqueue(async () => {
      const state = await this.#currentSessionState(session);
      const existing = latestGrantForPlugin(state, pluginId);
      if (!existing || existing.revokedAt !== null) {
        return existing;
      }
      if (state.grants.length >= maxGrantRecords) {
        throw new Error("Plugin construction grant history is full.");
      }
      if (!reason || reason.length > 500) {
        throw new Error("Plugin authority revocation requires a bounded reason.");
      }
      const next = cloneState(state);
      next.grantEpoch += 1;
      next.policyEpoch += 1;
      const revoked: CommunityPluginGrantV2 = {
        ...existing,
        grantRevision: existing.grantRevision + 1,
        grantEpoch: next.grantEpoch,
        revokedAt: this.#now().toISOString(),
        revocationReason: reason,
      };
      next.grants.push(revoked);
      await this.#saveState(state, next);
      return cloneGrant(revoked);
    });
  }

  grantState(
    session: PluginConstructionAuthoritySession,
    request: PluginConstructionRequest,
    legacyState: PluginCapabilityGrantState,
  ): Promise<PluginCapabilityGrantState> {
    return this.#enqueue(async () => {
      const state = await this.#currentSessionState(session);
      const profile = this.#profileByIdentity(request.packageIdentityDigest);
      if (
        !profile?.allowedPlatforms.includes(this.#platform) ||
        !this.#availableExecutionProfiles.includes(profile.executionProfile)
      ) {
        return "unavailable";
      }
      if (legacyState === "unavailable" || legacyState === "required") {
        return legacyState;
      }
      if (legacyState === "stale") {
        return "stale";
      }
      const grant = latestGrantForPlugin(state, request.packageIdentity.pluginId);
      if (!grant) {
        return "stale";
      }
      if (grant.revokedAt !== null) {
        return "required";
      }
      if (
        grant.packageIdentityDigest !== profile.packageIdentityDigest ||
        grant.authorityProfileId !== profile.profileId ||
        grant.authorityProfileRevision !== profile.profileRevision ||
        grant.authorityDigest !== profile.authorityDigest ||
        !sameCapabilities(grant.grantedAuthorities, profile.requiredAuthorities)
      ) {
        return "stale";
      }
      return (await this.#readSealedPackage(request)) ? "granted" : "stale";
    });
  }

  readAuthoritySnapshot(
    session: PluginConstructionAuthoritySession,
    request: PluginConstructionRequest,
  ): Promise<PluginConstructionAuthoritySnapshot> {
    return this.#enqueue(async () => {
      const state = await this.#currentSessionState(session);
      const grant = latestGrantForPlugin(state, request.packageIdentity.pluginId);
      const sealedPackage = state.knownPackageIdentityDigests.includes(
        request.packageIdentityDigest,
      )
        ? await this.#readSealedPackage(request).catch(() => null)
        : null;
      return {
        vaultId: session.vaultId,
        vaultGeneration: state.vaultGeneration,
        policyEpoch: state.policyEpoch,
        grantEpoch: state.grantEpoch,
        safeMode: state.safeMode,
        safeModeEpoch: state.safeModeEpoch,
        packageStoreEpoch: state.packageStoreEpoch,
        platform: this.#platform,
        availableExecutionProfiles: [...this.#availableExecutionProfiles],
        grant,
        sealedPackage,
      };
    });
  }

  setSafeMode(session: PluginConstructionAuthoritySession, safeMode: boolean): Promise<void> {
    return this.#enqueue(async () => {
      const state = await this.#currentSessionState(session);
      if (state.safeMode === safeMode) {
        return;
      }
      const next = cloneState(state);
      next.safeMode = safeMode;
      next.safeModeEpoch += 1;
      next.policyEpoch += 1;
      await this.#saveState(state, next);
    });
  }

  async #publishCapturedPackage(
    captured: Awaited<ReturnType<typeof capturePluginPackageTree>>,
    identity: ExactPluginPackageIdentity,
    identityDigest: string,
  ): Promise<SealedPluginPackageRecord> {
    const request: PluginConstructionRequest = {
      constructionPath: "test-execution",
      pluginDirectory: captured.canonicalRoot,
      packageIdentity: identity,
      packageIdentityDigest: identityDigest,
    };
    const pointerPath = this.#pointerPath(identityDigest, identity.packageTreeSha256);
    await this.#ensureStoreDirectory(path.dirname(pointerPath), this.#pointersRoot());
    const pointerExists = await fs
      .lstat(pointerPath)
      .then(() => true)
      .catch(() => false);
    if (pointerExists) {
      try {
        const existing = await this.#readSealedPackage(request);
        if (existing) return existing;
      } catch {
        await this.#quarantineStoreEntry(pointerPath);
      }
    }
    const objectId = identityDigest;
    const objectRoot = path.join(this.#objectsRoot(), objectId);
    const packageRoot = path.join(objectRoot, "package");
    const provisionalPointer: SealedPackagePointer = {
      version: sealedPackagePointerVersion,
      sealedPackageRootId: `${identityDigest}.${identity.packageTreeSha256}`,
      objectId,
      packageIdentityDigest: identityDigest,
      packageTreeSha256: identity.packageTreeSha256,
      createdAt: this.#now().toISOString(),
    };
    let createdObject = false;
    const objectExists = await fs
      .lstat(objectRoot)
      .then(() => true)
      .catch(() => false);
    if (objectExists) {
      try {
        await this.#readSealedObject(request, provisionalPointer);
      } catch {
        await this.#removeObject(objectRoot);
      }
    }
    const reusableObject = await fs
      .lstat(packageRoot)
      .then(() => true)
      .catch(() => false);
    if (!reusableObject) {
      await this.#ensureStoreDirectory(objectRoot, this.#objectsRoot());
      await this.#ensureStoreDirectory(packageRoot, objectRoot);
      createdObject = true;
    }
    let publishedPointer = false;
    try {
      if (createdObject) {
        for (const file of captured.files) {
          const bytes = captured.bytesByPath.get(file.path);
          if (!bytes) {
            throw new Error("Captured plugin package lost a distribution file.");
          }
          const target = path.join(packageRoot, ...file.path.split("/"));
          await this.#ensureDistributionDirectory(packageRoot, path.dirname(target));
          await durableCreate(target, bytes);
        }
        const staged = await inspectSealedPluginPackage(
          {
            sealedPackageRootId: "staging",
            sealedPackageRootPath: packageRoot,
            packageIdentityDigest: identityDigest,
            packageTreeSha256: identity.packageTreeSha256,
          },
          identity.distributionTag,
        );
        if (
          staged.identityDigest !== identityDigest ||
          authorityJsonSha256(staged.identity) !== identityDigest
        ) {
          throw new Error("Staged plugin package does not match the captured source identity.");
        }
        await this.#makeTreeReadOnly(
          packageRoot,
          captured.files.map(({ path: filePath }) => filePath),
        );
      }
      await this.#readSealedObject(request, provisionalPointer);
      try {
        await durableCreateReadOnly(pointerPath, pointerBytes(provisionalPointer));
        publishedPointer = true;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
          throw error;
        }
        const winner = await this.#readSealedPackage(request);
        if (!winner) {
          throw new Error("Concurrent sealed-package publication produced no valid winner.");
        }
        return winner;
      }
      const installed = await this.#readSealedPackage(request);
      if (!installed) {
        throw new Error("Published sealed plugin package could not be verified.");
      }
      return installed;
    } catch (error) {
      if (publishedPointer) {
        await this.#quarantineStoreEntry(pointerPath).catch(() => undefined);
      }
      if (createdObject) {
        await this.#removeObject(objectRoot).catch(() => undefined);
      }
      throw error;
    }
  }

  async #readSealedPackage(
    request: PluginConstructionRequest,
  ): Promise<SealedPluginPackageRecord | null> {
    const pointerPath = this.#pointerPath(
      request.packageIdentityDigest,
      request.packageIdentity.packageTreeSha256,
    );
    const pointerDirectory = path.dirname(pointerPath);
    const pointerDirectoryExists = await fs
      .lstat(pointerDirectory)
      .then(() => true)
      .catch(() => false);
    if (!pointerDirectoryExists) return null;
    await this.#assertStoreDirectory(pointerDirectory, this.#pointersRoot());
    const snapshot = await readStableFileWithinLimit(pointerPath, maxPointerBytes);
    if (!snapshot) {
      return null;
    }
    if (snapshot.status === "too-large") {
      throw new Error("Sealed plugin package pointer exceeds its size limit.");
    }
    const pointerStat = await fs.lstat(pointerPath);
    if (!pointerStat.isFile() || pointerStat.isSymbolicLink() || (pointerStat.mode & 0o222) !== 0) {
      throw new Error("Sealed plugin package pointer is mutable or not a regular file.");
    }
    const pointer = parsePointer(JSON.parse(decoder.decode(snapshot.snapshot.bytes)));
    if (
      pointer.packageIdentityDigest !== request.packageIdentityDigest ||
      pointer.packageTreeSha256 !== request.packageIdentity.packageTreeSha256 ||
      pointer.sealedPackageRootId !==
        `${request.packageIdentityDigest}.${request.packageIdentity.packageTreeSha256}`
    ) {
      throw new Error("Sealed plugin package pointer identity is inconsistent.");
    }
    return this.#readSealedObject(request, pointer);
  }

  async #readSealedObject(
    request: PluginConstructionRequest,
    pointer: SealedPackagePointer,
  ): Promise<SealedPluginPackageRecord> {
    const objectRoot = path.join(this.#objectsRoot(), pointer.objectId);
    await this.#assertStoreDirectory(objectRoot, this.#objectsRoot());
    const expectedRoot = path.join(objectRoot, "package");
    await this.#assertStoreDirectory(expectedRoot, objectRoot);
    const canonicalRoot = await fs.realpath(expectedRoot);
    const canonicalObjects = await fs.realpath(this.#objectsRoot());
    if (canonicalRoot !== expectedRoot || !isPathInside(canonicalObjects, canonicalRoot)) {
      throw new Error("Sealed plugin package object escaped its host-owned store.");
    }
    const captured = await capturePluginPackageTree(canonicalRoot);
    await this.#assertTreeReadOnly(
      canonicalRoot,
      captured.files.map(({ path: filePath }) => filePath),
    );
    const inspected = inspectCapturedPluginPackage(
      captured,
      request.packageIdentity.distributionTag,
    );
    if (
      inspected.identityDigest !== request.packageIdentityDigest ||
      authorityJsonSha256(inspected.identity) !== request.packageIdentityDigest ||
      inspected.identity.packageTreeSha256 !== request.packageIdentity.packageTreeSha256
    ) {
      throw new Error("Sealed plugin package object differs from its content address.");
    }
    return {
      sealedPackageRootId: pointer.sealedPackageRootId,
      sealedPackageRootPath: canonicalRoot,
      packageIdentityDigest: pointer.packageIdentityDigest,
      packageTreeSha256: pointer.packageTreeSha256,
    };
  }

  async #ensureDistributionDirectory(rootPath: string, directoryPath: string): Promise<void> {
    if (!isPathInside(rootPath, directoryPath)) {
      throw new Error("Captured plugin package directory escaped its object root.");
    }
    const relative = path.relative(rootPath, directoryPath);
    let current = rootPath;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      const next = path.join(current, segment);
      await this.#ensureStoreDirectory(next, current);
      current = next;
    }
  }

  async #quarantineStoreEntry(candidatePath: string): Promise<void> {
    const stat = await fs.lstat(candidatePath);
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      throw new Error("Plugin authority refused to quarantine an unexpected store entry.");
    }
    const quarantinePath = `${candidatePath}.invalid-${randomUUID()}`;
    await fs.rename(candidatePath, quarantinePath);
    await syncDirectory(path.dirname(candidatePath));
  }

  async #makeTreeReadOnly(rootPath: string, filePaths: readonly string[]): Promise<void> {
    for (const filePath of filePaths) {
      await fs.chmod(path.join(rootPath, ...filePath.split("/")), 0o400);
    }
    const directories = new Set<string>([rootPath]);
    for (const filePath of filePaths) {
      let directory = path.dirname(path.join(rootPath, ...filePath.split("/")));
      while (isPathInside(rootPath, directory)) {
        directories.add(directory);
        if (directory === rootPath) break;
        directory = path.dirname(directory);
      }
    }
    for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
      await fs.chmod(directory, 0o500);
      await syncDirectory(directory);
    }
  }

  async #assertTreeReadOnly(rootPath: string, filePaths: readonly string[]): Promise<void> {
    const root = await fs.lstat(rootPath);
    if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o222) !== 0) {
      throw new Error("Sealed plugin package root is mutable.");
    }
    for (const filePath of filePaths) {
      const absolute = path.join(rootPath, ...filePath.split("/"));
      const stat = await fs.lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o222) !== 0) {
        throw new Error("Sealed plugin package contains a mutable distribution file.");
      }
      let directory = path.dirname(absolute);
      while (isPathInside(rootPath, directory)) {
        const directoryStat = await fs.lstat(directory);
        if (
          !directoryStat.isDirectory() ||
          directoryStat.isSymbolicLink() ||
          (directoryStat.mode & 0o222) !== 0
        ) {
          throw new Error("Sealed plugin package contains a mutable distribution directory.");
        }
        if (directory === rootPath) break;
        directory = path.dirname(directory);
      }
    }
  }

  async #removeObject(objectRoot: string): Promise<void> {
    const rootStat = await fs.lstat(objectRoot).catch(() => null);
    if (!rootStat) return;
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      await this.#quarantineStoreEntry(objectRoot);
      return;
    }
    if (path.dirname(objectRoot) !== this.#objectsRoot()) {
      throw new Error("Plugin authority object cleanup escaped the object store.");
    }
    const makeWritable = async (candidate: string): Promise<void> => {
      const candidateStat = await fs.lstat(candidate).catch(() => null);
      if (!candidateStat || candidateStat.isSymbolicLink()) return;
      if (!candidateStat.isDirectory()) {
        if (candidateStat.isFile()) {
          await fs.chmod(candidate, 0o600).catch(() => undefined);
        }
        return;
      }
      await fs.chmod(candidate, 0o700).catch(() => undefined);
      const entries = await fs.readdir(candidate, { withFileTypes: true }).catch(() => null);
      if (entries === null) return;
      for (const entry of entries) {
        const target = path.join(candidate, entry.name);
        if (entry.isSymbolicLink()) {
          continue;
        }
        if (entry.isDirectory()) {
          await makeWritable(target);
        } else if (entry.isFile()) {
          await fs.chmod(target, 0o600).catch(() => undefined);
        }
      }
    };
    await makeWritable(objectRoot);
    await fs.rm(objectRoot, { recursive: true, force: true });
    await syncDirectory(this.#objectsRoot());
  }

  async #assertPluginSource(
    session: PluginConstructionAuthoritySession,
    pluginDirectoryValue: string,
  ): Promise<string> {
    const pluginsRoot = await this.#assertRealDirectoryChain(session.vaultRoot, [
      ".obsidian",
      "plugins",
    ]);
    const pluginDirectory = await fs.realpath(pluginDirectoryValue);
    const lexicalPluginDirectory = path.resolve(pluginDirectoryValue);
    const pluginStat = await fs.lstat(pluginDirectory);
    if (
      pluginDirectory !== lexicalPluginDirectory ||
      !pluginStat.isDirectory() ||
      pluginStat.isSymbolicLink() ||
      path.dirname(pluginDirectory) !== pluginsRoot
    ) {
      throw new Error("Plugin construction source escaped the active vault plugin directory.");
    }
    return pluginDirectory;
  }

  async #assertRealDirectoryChain(rootPath: string, segments: readonly string[]): Promise<string> {
    let current = rootPath;
    for (const segment of segments) {
      current = path.join(current, segment);
      const stat = await fs.lstat(current);
      const canonical = await fs.realpath(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== current) {
        throw new Error("Plugin construction source contains a linked directory component.");
      }
    }
    return current;
  }

  #manifestVersion(captured: Awaited<ReturnType<typeof capturePluginPackageTree>>): string {
    const bytes = captured.bytesByPath.get("manifest.json");
    if (!bytes) {
      throw new Error("Plugin construction source is missing manifest.json.");
    }
    const value: unknown = JSON.parse(decoder.decode(bytes));
    if (!isRecord(value) || typeof value.version !== "string") {
      throw new Error("Plugin construction manifest has no exact version.");
    }
    return requireVersion(value.version, "plugin manifest version");
  }

  async #currentSessionState(
    session: PluginConstructionAuthoritySession,
  ): Promise<PluginAuthorityStateFile> {
    this.#assertInitialized();
    if (!this.#sessions.has(session)) {
      throw new Error("Plugin construction authority session does not belong to this store.");
    }
    const binding = await this.#bindVaultRoot(session.vaultRoot);
    if (
      binding.canonicalRoot !== session.vaultRoot ||
      binding.fingerprint !== session.vaultRootFingerprint ||
      this.#vaultIdForRoot(binding.canonicalRoot) !== session.vaultId
    ) {
      throw new Error("Plugin construction authority vault identity changed during the session.");
    }
    const state = await this.#loadState(session.vaultId);
    this.#assertStateBinding(state, binding);
    if (state.vaultGeneration !== session.vaultGeneration) {
      throw new Error("Plugin construction authority session is stale.");
    }
    return state;
  }

  async #loadState(
    vaultId: string,
    initial?: { safeMode: boolean; binding: VaultRootBinding },
  ): Promise<PluginAuthorityStateFile> {
    const statePath = this.#authorityStatePath(vaultId);
    const anchorPath = this.#anchorPath(vaultId);
    const stateDirectory = path.dirname(statePath);
    const stateDirectoryExists = await fs
      .lstat(stateDirectory)
      .then(() => true)
      .catch(() => false);
    if (stateDirectoryExists) {
      await this.#assertStoreDirectory(stateDirectory, this.#vaultsRoot());
    }
    const [stateSnapshot, anchorSnapshot] = await Promise.all([
      readStableFileWithinLimit(statePath, maxAuthorityStateBytes),
      readStableFileWithinLimit(anchorPath, maxPointerBytes),
    ]);
    if (!stateSnapshot && !anchorSnapshot) {
      if (!initial) {
        throw new Error("Plugin authority state is missing for an existing session.");
      }
      return defaultState(vaultId, initial.safeMode, initial.binding);
    }
    if (!stateSnapshot && anchorSnapshot) {
      throw new Error("Plugin authority state and its high-water anchor are incomplete.");
    }
    if (!stateSnapshot) {
      throw new Error("Plugin authority state is missing for an existing session.");
    }
    if (stateSnapshot.status === "too-large") {
      throw new Error("Plugin authority state exceeds its size limit.");
    }
    if (!anchorSnapshot) {
      if (!initial) {
        throw new Error("Plugin authority state and its high-water anchor are incomplete.");
      }
      await this.#assertPrivateRegularFile(statePath, 0o600);
      const state = parseAuthorityState(
        JSON.parse(decoder.decode(stateSnapshot.snapshot.bytes)),
        vaultId,
      );
      if (!isRecoverableInitialState(state, initial)) {
        throw new Error("Plugin authority state and its high-water anchor are incomplete.");
      }
      await this.#writeAnchor(anchorForState(state));
      return cloneState(state);
    }
    if (anchorSnapshot.status === "too-large") {
      throw new Error("Plugin authority high-water anchor exceeds its size limit.");
    }
    await this.#assertPrivateRegularFile(statePath, 0o600);
    await this.#assertPrivateRegularFile(anchorPath, 0o600);
    const state = parseAuthorityState(
      JSON.parse(decoder.decode(stateSnapshot.snapshot.bytes)),
      vaultId,
    );
    const anchor = parseAuthorityAnchor(
      JSON.parse(decoder.decode(anchorSnapshot.snapshot.bytes)),
      vaultId,
    );
    if (state.stateRevision === anchor.stateRevision) {
      this.#assertAnchorMatchesState(anchor, state);
      return cloneState(state);
    }
    if (
      state.stateRevision === anchor.stateRevision + 1 &&
      state.previousStateDigest === anchor.stateDigest &&
      state.vaultRootFingerprint === anchor.vaultRootFingerprint &&
      state.vaultGeneration >= anchor.vaultGeneration &&
      state.policyEpoch >= anchor.policyEpoch &&
      state.grantEpoch >= anchor.grantEpoch &&
      state.safeModeEpoch >= anchor.safeModeEpoch &&
      state.packageStoreEpoch >= anchor.packageStoreEpoch
    ) {
      await this.#writeAnchor(anchorForState(state));
      return cloneState(state);
    }
    throw new Error(
      "Plugin authority state was rolled back or diverged from its high-water anchor.",
    );
  }

  async #saveState(
    previous: PluginAuthorityStateFile,
    candidate: PluginAuthorityStateFile,
  ): Promise<PluginAuthorityStateFile> {
    if (
      candidate.vaultId !== previous.vaultId ||
      candidate.vaultRoot !== previous.vaultRoot ||
      candidate.vaultRootFingerprint !== previous.vaultRootFingerprint
    ) {
      throw new Error("Plugin authority state cannot change its vault binding.");
    }
    const state = cloneState(candidate);
    state.stateRevision = previous.stateRevision + 1;
    state.previousStateDigest = previous.stateRevision === 0 ? null : stateDigest(previous);
    parseAuthorityState(JSON.parse(JSON.stringify(state)), state.vaultId);
    const bytes = stateBytes(state);
    if (bytes.byteLength > maxAuthorityStateBytes) {
      throw new Error("Plugin authority state exceeds its size limit.");
    }
    const stateDirectory = path.dirname(this.#authorityStatePath(state.vaultId));
    await this.#ensureStoreDirectory(stateDirectory, this.#vaultsRoot());
    await atomicWriteFile(this.#authorityStatePath(state.vaultId), bytes);
    await fs.chmod(this.#authorityStatePath(state.vaultId), 0o600);
    await this.#assertPrivateRegularFile(this.#authorityStatePath(state.vaultId), 0o600);
    await this.#writeAnchor(anchorForState(state));
    return cloneState(state);
  }

  async #writeAnchor(anchor: PluginAuthorityStateAnchor): Promise<void> {
    const bytes = anchorBytes(anchor);
    if (bytes.byteLength > maxPointerBytes) {
      throw new Error("Plugin authority high-water anchor exceeds its size limit.");
    }
    await atomicWriteFile(this.#anchorPath(anchor.vaultId), bytes);
    await fs.chmod(this.#anchorPath(anchor.vaultId), 0o600);
    await this.#assertPrivateRegularFile(this.#anchorPath(anchor.vaultId), 0o600);
  }

  #assertAnchorMatchesState(
    anchor: PluginAuthorityStateAnchor,
    state: PluginAuthorityStateFile,
  ): void {
    if (
      anchor.vaultRootFingerprint !== state.vaultRootFingerprint ||
      anchor.stateDigest !== stateDigest(state) ||
      anchor.vaultGeneration !== state.vaultGeneration ||
      anchor.policyEpoch !== state.policyEpoch ||
      anchor.grantEpoch !== state.grantEpoch ||
      anchor.safeModeEpoch !== state.safeModeEpoch ||
      anchor.packageStoreEpoch !== state.packageStoreEpoch
    ) {
      throw new Error("Plugin authority state differs from its high-water anchor.");
    }
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(async () => {
      const lock = await acquireStateLockAsync(this.#lockPath(), {
        timeoutMs: authorityLockTimeoutMs,
        pollIntervalMs: 10,
      });
      try {
        lock.assertPathIdentity();
        await this.#assertStoreLayout();
        const value = await operation();
        lock.assertPathIdentity();
        return value;
      } finally {
        lock.close();
      }
    });
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #assertInitialized(): void {
    if (!this.#initialized) {
      throw new Error("Plugin construction authority store is not initialized.");
    }
  }

  #parseVaultId(value: string): string {
    if (!vaultIdPattern.test(value)) {
      throw new Error("Plugin construction authority requires a valid vault identity.");
    }
    return value;
  }

  async #bindVaultRoot(vaultRootValue: string): Promise<VaultRootBinding> {
    const canonicalRoot = await fs.realpath(vaultRootValue);
    const root = await fs.lstat(canonicalRoot, { bigint: true });
    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new Error("Plugin construction vault root must be a real directory.");
    }
    return {
      canonicalRoot,
      fingerprint: authorityJsonSha256({
        schemaVersion: 1,
        canonicalRoot,
        device: root.dev.toString(),
        inode: root.ino.toString(),
        birthtimeNs: root.birthtimeNs.toString(),
      }),
    };
  }

  #vaultIdForRoot(canonicalRoot: string): string {
    const identityPath = process.platform === "win32" ? canonicalRoot.toLowerCase() : canonicalRoot;
    return createHash("sha256").update(identityPath).digest("hex");
  }

  #assertStateBinding(state: PluginAuthorityStateFile, binding: VaultRootBinding): void {
    if (
      state.vaultRoot !== binding.canonicalRoot ||
      state.vaultRootFingerprint !== binding.fingerprint ||
      state.vaultId !== this.#vaultIdForRoot(binding.canonicalRoot)
    ) {
      throw new Error("Plugin authority state belongs to a different physical vault root.");
    }
  }

  async #assertPrivateRegularFile(filePath: string, expectedMode: number): Promise<void> {
    const stat = await fs.lstat(filePath, { bigint: true });
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1n ||
      (Number(stat.mode) & 0o777) !== expectedMode
    ) {
      throw new Error("Plugin authority private state path is aliased or has unsafe permissions.");
    }
  }

  async #ensureStoreDirectory(directoryPath: string, parentPath: string): Promise<void> {
    let created = false;
    try {
      await fs.mkdir(directoryPath, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
    }
    await this.#assertStoreDirectory(directoryPath, parentPath);
    await fs.chmod(directoryPath, 0o700);
    if (created) await syncDirectory(parentPath);
  }

  async #assertStoreDirectory(directoryPath: string, parentPath: string): Promise<void> {
    const stat = await fs.lstat(directoryPath);
    const canonical = await fs.realpath(directoryPath);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      canonical !== directoryPath ||
      !isPathInside(parentPath, canonical) ||
      path.dirname(canonical) !== parentPath
    ) {
      throw new Error("Plugin authority store contains an unsafe directory component.");
    }
  }

  async #assertStoreLayout(): Promise<void> {
    const root = await fs.lstat(this.#stateRoot);
    const canonicalRoot = await fs.realpath(this.#stateRoot);
    if (!root.isDirectory() || root.isSymbolicLink() || canonicalRoot !== this.#stateRoot) {
      throw new Error("Plugin construction authority root changed after initialization.");
    }
    for (const directory of [
      this.#objectsRoot(),
      this.#pointersRoot(),
      this.#vaultsRoot(),
      this.#anchorsRoot(),
    ]) {
      const stat = await fs.lstat(directory);
      const canonical = await fs.realpath(directory);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        canonical !== directory ||
        path.dirname(canonical) !== this.#stateRoot
      ) {
        throw new Error("Plugin authority store path component changed after initialization.");
      }
    }
  }

  #authorityStatePath(vaultId: string): string {
    return path.join(this.#vaultsRoot(), this.#parseVaultId(vaultId), "authority.json");
  }

  #anchorPath(vaultId: string): string {
    return path.join(this.#anchorsRoot(), `${this.#parseVaultId(vaultId)}.json`);
  }

  #pointerPath(identityDigest: string, treeDigest: string): string {
    return path.join(
      this.#pointersRoot(),
      requireDigest(identityDigest, "package identity"),
      `${requireDigest(treeDigest, "package tree")}.json`,
    );
  }

  #objectsRoot(): string {
    return path.join(this.#stateRoot, "objects");
  }

  #pointersRoot(): string {
    return path.join(this.#stateRoot, "packages");
  }

  #vaultsRoot(): string {
    return path.join(this.#stateRoot, "vaults");
  }

  #anchorsRoot(): string {
    return path.join(this.#stateRoot, "anchors");
  }

  #lockPath(): string {
    return path.join(this.#stateRoot, "authority.lock");
  }
}
