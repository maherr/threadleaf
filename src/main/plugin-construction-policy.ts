import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { authorityJsonSha256 } from "../shared/authority-json";
import {
  type CommunityPluginGrantV2,
  type ConstructionPolicyEpoch,
  type ExactPluginPackageIdentity,
  maxPluginBundleBytes,
  type PluginCapabilityId,
  type PluginConstructionDenialCode,
  type PluginConstructionDispatch,
  type PluginConstructionPath,
  type PluginConstructionPolicy,
  PluginConstructionRefusal,
  type PluginConstructionRequest,
  parsePluginManifest,
  type ReviewedAuthorityExecutionProfile,
  type ReviewedAuthorityPlatform,
  type ReviewedAuthorityProfile,
  type SealedPluginPackageRecord,
} from "../shared/plugins";
import { scanPluginCapabilities } from "./plugin-capability-scanner";
import {
  reviewedAuthorityProfileByIdentity,
  reviewedAuthorityProfiles,
} from "./reviewed-authority-profiles";

const maxPackageFiles = 4_096;
const maxPackageBytes = 64 * 1024 * 1024;
export const maxConsumedConstructionPolicyAttempts = 4_096;

export interface PluginConstructionAuthoritySnapshot {
  vaultId: string;
  vaultGeneration: number;
  policyEpoch: number;
  grantEpoch: number;
  safeMode: boolean;
  safeModeEpoch: number;
  packageStoreEpoch: number;
  platform: ReviewedAuthorityPlatform;
  availableExecutionProfiles: ReviewedAuthorityExecutionProfile[];
  grant: CommunityPluginGrantV2 | null;
  sealedPackage: SealedPluginPackageRecord | null;
}

export interface PluginConstructionPolicyResolverOptions {
  readAuthoritySnapshot(
    request: PluginConstructionRequest,
  ): Promise<PluginConstructionAuthoritySnapshot>;
  profileByIdentity?(packageIdentityDigest: string): ReviewedAuthorityProfile | null;
  inspectSealedPackage?(
    sealedPackage: SealedPluginPackageRecord,
    distributionTag: string,
  ): Promise<InspectedPluginPackage>;
  now?(): Date;
  createAttemptId?(): string;
}

export interface InspectedPluginPackage {
  identity: ExactPluginPackageIdentity;
  identityDigest: string;
  staticCapabilities: PluginCapabilityId[];
  staticScanDigest: string;
}

export class PluginCapabilityScanError extends Error {
  constructor(cause: unknown) {
    super("The complete static capability scan failed.", { cause });
    this.name = "PluginCapabilityScanError";
  }
}

interface PendingConstructionAttempt {
  authorityFingerprint: string;
  policy: PluginConstructionPolicy;
  request: PluginConstructionRequest;
  sealedPackageRootPath: string;
}

interface TreeFile {
  path: string;
  sha256: string;
  size: number;
}

function sameData(left: unknown, right: unknown): boolean {
  return authorityJsonSha256(left) === authorityJsonSha256(right);
}

function sameCapabilities(
  left: readonly PluginCapabilityId[],
  right: readonly PluginCapabilityId[],
) {
  return sameData([...left].sort(), [...right].sort());
}

function snapshotFingerprint(snapshot: PluginConstructionAuthoritySnapshot): string {
  return authorityJsonSha256({
    vaultId: snapshot.vaultId,
    vaultGeneration: snapshot.vaultGeneration,
    policyEpoch: snapshot.policyEpoch,
    grantEpoch: snapshot.grantEpoch,
    safeMode: snapshot.safeMode,
    safeModeEpoch: snapshot.safeModeEpoch,
    packageStoreEpoch: snapshot.packageStoreEpoch,
    platform: snapshot.platform,
    availableExecutionProfiles: [...snapshot.availableExecutionProfiles].sort(),
    grant: snapshot.grant,
    sealedPackage: snapshot.sealedPackage,
  });
}

function policyPayload(policy: Omit<PluginConstructionPolicy, "policyDigest">) {
  return policy;
}

function createPolicy(
  input: Omit<PluginConstructionPolicy, "policyDigest">,
): PluginConstructionPolicy {
  return { ...input, policyDigest: authorityJsonSha256(policyPayload(input)) };
}

function denialPolicy(
  request: PluginConstructionRequest,
  snapshot: PluginConstructionAuthoritySnapshot,
  profile: ReviewedAuthorityProfile | null,
  attemptId: string,
  issuedAt: string,
  denialCode: PluginConstructionDenialCode,
  staticScanDigest: string | null = null,
): PluginConstructionPolicy {
  return createPolicy({
    constructionAttemptId: attemptId,
    constructionPath: request.constructionPath,
    vaultId: snapshot.vaultId,
    vaultGeneration: snapshot.vaultGeneration,
    epoch: policyEpoch(snapshot, profile),
    packageIdentity: { ...request.packageIdentity },
    packageIdentityDigest: request.packageIdentityDigest,
    sealedPackageRootId: null,
    stagedPackageTreeSha256: null,
    authorityProfileId: profile?.profileId ?? null,
    authorityDigest: profile?.authorityDigest ?? null,
    staticScanDigest,
    expectedStaticCapabilities: [...(profile?.expectedStaticCapabilities ?? [])],
    requiredAuthorities: [...(profile?.requiredAuthorities ?? [])],
    boundary: profile?.executionProfile ?? null,
    decision: "deny",
    denialCode,
    issuedAt,
  });
}

function policyEpoch(
  snapshot: PluginConstructionAuthoritySnapshot,
  profile: ReviewedAuthorityProfile | null,
): ConstructionPolicyEpoch {
  return {
    policyEpoch: snapshot.policyEpoch,
    grantEpoch: snapshot.grantEpoch,
    grantRevision: snapshot.grant?.grantRevision ?? 0,
    safeModeEpoch: snapshot.safeModeEpoch,
    packageStoreEpoch: snapshot.packageStoreEpoch,
    authorityProfileRevision: profile?.profileRevision ?? 0,
  };
}

async function readRegularFile(filePath: string, byteLimit: number): Promise<Buffer> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > byteLimit) {
    throw new Error("Sealed plugin package contains an invalid or oversized regular file.");
  }
  return fs.readFile(filePath);
}

async function enumeratePackageTree(rootPath: string): Promise<TreeFile[]> {
  const canonicalRoot = await fs.realpath(rootPath);
  const files: TreeFile[] = [];
  let totalBytes = 0;
  async function visit(directoryPath: string, relativeDirectory: string): Promise<void> {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en-US"));
    for (const entry of entries) {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (
        path.isAbsolute(relativePath) ||
        relativePath.split("/").includes("..") ||
        entry.isSymbolicLink()
      ) {
        throw new Error("Sealed plugin package contains a forbidden path entry.");
      }
      const absolutePath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error("Sealed plugin package contains a non-regular entry.");
      }
      const bytes = await readRegularFile(absolutePath, maxPackageBytes);
      totalBytes += bytes.byteLength;
      if (files.length >= maxPackageFiles || totalBytes > maxPackageBytes) {
        throw new Error("Sealed plugin package exceeds its bounded closure budget.");
      }
      files.push({
        path: relativePath,
        sha256: authorityBytesSha256(bytes),
        size: bytes.byteLength,
      });
    }
  }
  await visit(canonicalRoot, "");
  const folded = new Set<string>();
  for (const file of files) {
    const key = file.path.normalize("NFC").toLocaleLowerCase("en-US");
    if (folded.has(key)) {
      throw new Error("Sealed plugin package contains case-colliding paths.");
    }
    folded.add(key);
  }
  return files.sort((left, right) => left.path.localeCompare(right.path, "en-US"));
}

function authorityBytesSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function inspectSealedPluginPackage(
  sealedPackage: SealedPluginPackageRecord,
  distributionTag: string,
): Promise<InspectedPluginPackage> {
  const files = await enumeratePackageTree(sealedPackage.sealedPackageRootPath);
  const byPath = new Map(files.map((file) => [file.path, file]));
  const manifestFile = byPath.get("manifest.json");
  const mainFile = byPath.get("main.js");
  const stylesFile = byPath.get("styles.css") ?? null;
  if (!manifestFile || !mainFile) {
    throw new Error("Sealed plugin package is missing manifest.json or main.js.");
  }
  const manifestBytes = await readRegularFile(
    path.join(sealedPackage.sealedPackageRootPath, "manifest.json"),
    64 * 1024,
  );
  const mainBytes = await readRegularFile(
    path.join(sealedPackage.sealedPackageRootPath, "main.js"),
    maxPluginBundleBytes,
  );
  const manifest = parsePluginManifest(JSON.parse(manifestBytes.toString("utf8")));
  const packageTreeSha256 = authorityJsonSha256({ schemaVersion: 1, files });
  const identity: ExactPluginPackageIdentity = {
    pluginId: manifest.id,
    manifestVersion: manifest.version,
    distributionTag,
    manifestSha256: manifestFile.sha256,
    mainSha256: mainFile.sha256,
    stylesSha256: stylesFile?.sha256 ?? null,
    packageTreeSha256,
  };
  let report: ReturnType<typeof scanPluginCapabilities>;
  try {
    report = scanPluginCapabilities(mainBytes);
  } catch (error) {
    throw new PluginCapabilityScanError(error);
  }
  return {
    identity,
    identityDigest: authorityJsonSha256(identity),
    staticCapabilities: [...report.capabilities],
    staticScanDigest: authorityJsonSha256(report),
  };
}

export async function measureInstalledPluginConstructionRequest(
  installed: {
    directoryPath: string;
    summary: { id: string; version: string };
  },
  reportedMainSha256: string,
  constructionPath: PluginConstructionPath,
  inspectPackage: typeof inspectSealedPluginPackage = inspectSealedPluginPackage,
): Promise<PluginConstructionRequest> {
  const reviewed = reviewedAuthorityProfiles().find(
    (profile) =>
      profile.packageIdentity.pluginId === installed.summary.id &&
      profile.packageIdentity.manifestVersion === installed.summary.version &&
      profile.packageIdentity.mainSha256 === reportedMainSha256,
  );
  const inspected = await inspectPackage(
    {
      sealedPackageRootId: `installed-${installed.summary.id}`,
      sealedPackageRootPath: installed.directoryPath,
      packageIdentityDigest: "0".repeat(64),
      packageTreeSha256: "0".repeat(64),
    },
    reviewed?.packageIdentity.distributionTag ?? installed.summary.version,
  );
  if (
    inspected.identity.pluginId !== installed.summary.id ||
    inspected.identity.manifestVersion !== installed.summary.version ||
    inspected.identity.mainSha256 !== reportedMainSha256
  ) {
    throw new Error("Installed plugin package changed before construction measurement completed.");
  }
  return {
    constructionPath,
    pluginDirectory: installed.directoryPath,
    packageIdentity: { ...inspected.identity },
    packageIdentityDigest: inspected.identityDigest,
  };
}

export class PluginConstructionPolicyResolver {
  private readonly attempts = new Map<string, PendingConstructionAttempt>();
  private readonly consumedAttempts = new Set<string>();
  private readonly profileByIdentity: (
    packageIdentityDigest: string,
  ) => ReviewedAuthorityProfile | null;
  private readonly inspectPackage: typeof inspectSealedPluginPackage;
  private readonly now: () => Date;
  private readonly createAttemptId: () => string;

  constructor(private readonly options: PluginConstructionPolicyResolverOptions) {
    this.profileByIdentity = options.profileByIdentity ?? reviewedAuthorityProfileByIdentity;
    this.inspectPackage = options.inspectSealedPackage ?? inspectSealedPluginPackage;
    this.now = options.now ?? (() => new Date());
    this.createAttemptId = options.createAttemptId ?? randomUUID;
  }

  async resolveConstructionPolicy(
    request: PluginConstructionRequest,
  ): Promise<PluginConstructionPolicy> {
    const snapshot = await this.options.readAuthoritySnapshot(request);
    const attemptId = this.createAttemptId();
    const issuedAt = this.now().toISOString();
    const profile = this.profileByIdentity(request.packageIdentityDigest);
    const deny = (code: PluginConstructionDenialCode, scanDigest: string | null = null) =>
      denialPolicy(request, snapshot, profile, attemptId, issuedAt, code, scanDigest);

    if (!profile) {
      return deny("authority-profile-missing");
    }
    if (
      request.packageIdentityDigest !== authorityJsonSha256(request.packageIdentity) ||
      !sameData(request.packageIdentity, profile.packageIdentity)
    ) {
      return deny("authority-profile-mismatch");
    }
    const sealedPackage = snapshot.sealedPackage;
    if (!sealedPackage) {
      return deny("package-stage-invalid");
    }
    let inspected: InspectedPluginPackage;
    try {
      inspected = await this.inspectPackage(sealedPackage, profile.packageIdentity.distributionTag);
    } catch (error) {
      return deny(
        error instanceof PluginCapabilityScanError
          ? "authority-profile-mismatch"
          : "package-stage-invalid",
      );
    }
    if (
      sealedPackage.packageIdentityDigest !== profile.packageIdentityDigest ||
      sealedPackage.packageTreeSha256 !== profile.packageIdentity.packageTreeSha256 ||
      inspected.identityDigest !== profile.packageIdentityDigest ||
      !sameData(inspected.identity, profile.packageIdentity)
    ) {
      return deny("package-identity-mismatch", inspected.staticScanDigest);
    }
    if (!sameCapabilities(inspected.staticCapabilities, profile.expectedStaticCapabilities)) {
      return deny("authority-profile-mismatch", inspected.staticScanDigest);
    }
    if (!profile.allowedPlatforms.includes(snapshot.platform)) {
      return deny("capability-unavailable", inspected.staticScanDigest);
    }
    if (snapshot.safeMode) {
      return deny("safe-mode-blocked", inspected.staticScanDigest);
    }
    const grant = snapshot.grant;
    if (!grant) {
      return deny("grant-required", inspected.staticScanDigest);
    }
    if (grant.revokedAt !== null) {
      return deny("grant-revoked", inspected.staticScanDigest);
    }
    if (
      grant.vaultId !== snapshot.vaultId ||
      grant.packageIdentityDigest !== profile.packageIdentityDigest ||
      !sameData(grant.packageIdentity, profile.packageIdentity) ||
      grant.authorityProfileId !== profile.profileId ||
      grant.authorityProfileRevision !== profile.profileRevision ||
      grant.authorityDigest !== profile.authorityDigest ||
      grant.grantEpoch !== snapshot.grantEpoch ||
      !sameCapabilities(grant.grantedAuthorities, profile.requiredAuthorities)
    ) {
      return deny("grant-stale", inspected.staticScanDigest);
    }
    if (!snapshot.availableExecutionProfiles.includes(profile.executionProfile)) {
      return deny("capability-unavailable", inspected.staticScanDigest);
    }
    const policy = createPolicy({
      constructionAttemptId: attemptId,
      constructionPath: request.constructionPath,
      vaultId: snapshot.vaultId,
      vaultGeneration: snapshot.vaultGeneration,
      epoch: policyEpoch(snapshot, profile),
      packageIdentity: { ...profile.packageIdentity },
      packageIdentityDigest: profile.packageIdentityDigest,
      sealedPackageRootId: sealedPackage.sealedPackageRootId,
      stagedPackageTreeSha256: inspected.identity.packageTreeSha256,
      authorityProfileId: profile.profileId,
      authorityDigest: profile.authorityDigest,
      staticScanDigest: inspected.staticScanDigest,
      expectedStaticCapabilities: [...profile.expectedStaticCapabilities],
      requiredAuthorities: [...profile.requiredAuthorities],
      boundary: profile.executionProfile,
      decision: "allow",
      denialCode: null,
      issuedAt,
    });
    this.attempts.set(attemptId, {
      authorityFingerprint: snapshotFingerprint(snapshot),
      policy,
      request,
      sealedPackageRootPath: sealedPackage.sealedPackageRootPath,
    });
    return policy;
  }

  async consumeConstructionPolicy(
    policy: PluginConstructionPolicy,
  ): Promise<PluginConstructionDispatch> {
    if (policy.decision !== "allow" || policy.denialCode !== null) {
      throw new PluginConstructionRefusal(policy);
    }
    const attempt = this.attempts.get(policy.constructionAttemptId);
    this.attempts.delete(policy.constructionAttemptId);
    if (this.consumedAttempts.size >= maxConsumedConstructionPolicyAttempts) {
      throw new PluginConstructionRefusal(replayLedgerExhaustedPolicy(policy));
    }
    if (
      !attempt ||
      this.consumedAttempts.has(policy.constructionAttemptId) ||
      !sameData(attempt.policy, policy) ||
      policy.policyDigest !== authorityJsonSha256(policyPayloadWithoutDigest(policy))
    ) {
      throw new PluginConstructionRefusal(stalePolicy(policy));
    }
    this.consumedAttempts.add(policy.constructionAttemptId);
    const current = await this.options.readAuthoritySnapshot(attempt.request);
    const currentProfile = this.profileByIdentity(attempt.request.packageIdentityDigest);
    if (
      snapshotFingerprint(current) !== attempt.authorityFingerprint ||
      !currentProfile ||
      currentProfile.profileRevision !== policy.epoch.authorityProfileRevision ||
      currentProfile.authorityDigest !== policy.authorityDigest
    ) {
      throw new PluginConstructionRefusal(stalePolicy(policy));
    }
    return { pluginDirectory: attempt.sealedPackageRootPath, policy };
  }

  async resolveAndConsume(request: PluginConstructionRequest): Promise<PluginConstructionDispatch> {
    return this.consumeConstructionPolicy(await this.resolveConstructionPolicy(request));
  }
}

function policyPayloadWithoutDigest(
  policy: PluginConstructionPolicy,
): Omit<PluginConstructionPolicy, "policyDigest"> {
  const { policyDigest: _policyDigest, ...payload } = policy;
  return payload;
}

function stalePolicy(policy: PluginConstructionPolicy): PluginConstructionPolicy {
  return createPolicy({
    ...policyPayloadWithoutDigest(policy),
    sealedPackageRootId: null,
    stagedPackageTreeSha256: null,
    decision: "deny",
    denialCode: "policy-epoch-stale",
  });
}

function replayLedgerExhaustedPolicy(policy: PluginConstructionPolicy): PluginConstructionPolicy {
  return createPolicy({
    ...policyPayloadWithoutDigest(policy),
    sealedPackageRootId: null,
    stagedPackageTreeSha256: null,
    decision: "deny",
    denialCode: "replay-ledger-exhausted",
  });
}
