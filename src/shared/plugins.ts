import { pluginCompatibilityRegistry } from "../generated/plugin-compatibility-registry";
import type { PluginDiagnosticCode } from "./plugin-diagnostics";

export const compatibilityModes = ["restricted", "enabled"] as const;
export const maxPluginBundleBytes = 16 * 1024 * 1024;
export const pluginCapabilityIds = [
  "vault-read",
  "vault-write",
  "network",
  "filesystem",
  "subprocess",
  "host-environment",
  "clipboard",
  "external-navigation",
  "editor-extension",
  "workspace-ui",
  "dynamic-code",
] as const;
export const reviewedAuthorityProfileSchemaVersion = 1 as const;
export const reviewedAuthorityExecutionProfiles = [
  "trusted-node-renderer",
  "trusted-desktop-escape",
] as const;
export const reviewedAuthorityPlatforms = ["linux", "darwin", "win32"] as const;

export type CompatibilityMode = (typeof compatibilityModes)[number];
export type PluginCapabilityId = (typeof pluginCapabilityIds)[number];
export type ReviewedAuthorityExecutionProfile = (typeof reviewedAuthorityExecutionProfiles)[number];
export type ReviewedAuthorityPlatform = (typeof reviewedAuthorityPlatforms)[number];

const pluginPackagePathEncoder = new TextEncoder();
const mutablePluginRootFiles = new Set([
  ".threadleaf-package.json",
  "LICENSE.threadleaf.txt",
  "data.json",
]);
const mutablePluginDataTemporaryFile =
  /^\.data\.json\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u;

export function compareCanonicalPluginPackagePaths(left: string, right: string): number {
  const leftBytes = pluginPackagePathEncoder.encode(left);
  const rightBytes = pluginPackagePathEncoder.encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

export function isPluginDistributionPathIncluded(relativePath: string): boolean {
  return (
    !mutablePluginRootFiles.has(relativePath) && !mutablePluginDataTemporaryFile.test(relativePath)
  );
}

export interface ExactPluginPackageIdentity {
  pluginId: string;
  manifestVersion: string;
  distributionTag: string;
  manifestSha256: string;
  mainSha256: string;
  stylesSha256: string | null;
  packageTreeSha256: string;
}

export interface ReviewedAuthorityProfile {
  $schema: "./reviewed-authority-profile.v1.schema.json";
  schemaVersion: typeof reviewedAuthorityProfileSchemaVersion;
  profileId: string;
  profileRevision: number;
  packageIdentity: ExactPluginPackageIdentity;
  packageIdentityDigest: string;
  expectedStaticCapabilities: PluginCapabilityId[];
  requiredAuthorities: PluginCapabilityId[];
  executionProfile: ReviewedAuthorityExecutionProfile;
  allowedPlatforms: ReviewedAuthorityPlatform[];
  authorityDigest: string;
}

export const pluginConstructionPaths = [
  "first-load",
  "explicit-reload",
  "automatic-recovery",
  "renderer-death-restoration",
  "app-restart-reconstruction",
  "diagnostic-execution",
  "test-execution",
] as const;

export const pluginConstructionDenialCodes = [
  "authority-profile-missing",
  "authority-profile-mismatch",
  "package-identity-mismatch",
  "package-stage-invalid",
  "grant-required",
  "grant-stale",
  "grant-revoked",
  "safe-mode-blocked",
  "capability-unavailable",
  "policy-epoch-stale",
  "replay-ledger-exhausted",
] as const;

export type PluginConstructionPath = (typeof pluginConstructionPaths)[number];
export type PluginConstructionDenialCode = (typeof pluginConstructionDenialCodes)[number];

export interface ConstructionPolicyEpoch {
  policyEpoch: number;
  grantEpoch: number;
  grantRevision: number;
  safeModeEpoch: number;
  packageStoreEpoch: number;
  authorityProfileRevision: number;
}

export interface CommunityPluginGrantV2 {
  schemaVersion: 2;
  grantId: string;
  vaultId: string;
  packageIdentity: ExactPluginPackageIdentity;
  packageIdentityDigest: string;
  authorityProfileId: string;
  authorityProfileRevision: number;
  authorityDigest: string;
  grantedAuthorities: PluginCapabilityId[];
  provenance:
    | {
        kind: "signed-distribution";
        releaseDigest: string;
        signerKeyId: string;
        signatureDigest: string;
      }
    | { kind: "content-addressed-unsigned"; sourceDescriptorDigest: string };
  grantRevision: number;
  grantEpoch: number;
  issuedAt: string;
  revokedAt: string | null;
  revocationReason: string | null;
}

export interface PluginConstructionPolicy {
  constructionAttemptId: string;
  constructionPath: PluginConstructionPath;
  vaultId: string;
  vaultGeneration: number;
  epoch: ConstructionPolicyEpoch;
  packageIdentity: ExactPluginPackageIdentity;
  packageIdentityDigest: string;
  sealedPackageRootId: string | null;
  stagedPackageTreeSha256: string | null;
  authorityProfileId: string | null;
  authorityDigest: string | null;
  staticScanDigest: string | null;
  expectedStaticCapabilities: PluginCapabilityId[];
  requiredAuthorities: PluginCapabilityId[];
  boundary: ReviewedAuthorityExecutionProfile | null;
  decision: "allow" | "deny";
  denialCode: PluginConstructionDenialCode | null;
  issuedAt: string;
  policyDigest: string;
}

export interface PluginConstructionRequest {
  constructionPath: PluginConstructionPath;
  pluginDirectory: string;
  packageIdentity: ExactPluginPackageIdentity;
  packageIdentityDigest: string;
}

export interface PluginConstructionDispatch {
  pluginDirectory: string;
  policy: PluginConstructionPolicy;
}

export interface SealedPluginPackageRecord {
  sealedPackageRootId: string;
  sealedPackageRootPath: string;
  packageIdentityDigest: string;
  packageTreeSha256: string;
}

export class PluginConstructionRefusal extends Error {
  readonly code: PluginConstructionDenialCode;
  readonly policy: PluginConstructionPolicy;

  constructor(policy: PluginConstructionPolicy, cause?: unknown) {
    const code = policy.denialCode ?? "policy-epoch-stale";
    super(
      `Community plugin construction was denied [${code}].`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "PluginConstructionRefusal";
    this.code = code;
    this.policy = policy;
  }
}

export function isPluginConstructionRefusal(value: unknown): value is PluginConstructionRefusal {
  return (
    value instanceof PluginConstructionRefusal ||
    (typeof value === "object" &&
      value !== null &&
      "name" in value &&
      value.name === "PluginConstructionRefusal" &&
      "code" in value &&
      typeof value.code === "string" &&
      pluginConstructionDenialCodes.includes(value.code as PluginConstructionDenialCode))
  );
}

export interface PluginCapabilityDefinition {
  label: string;
  description: string;
}

export const pluginCapabilityDefinitions: Readonly<
  Record<PluginCapabilityId, PluginCapabilityDefinition>
> = {
  "vault-read": {
    label: "Read vault content",
    description: "References APIs that can inspect notes, attachments, or vault metadata.",
  },
  "vault-write": {
    label: "Change vault content",
    description: "References APIs that can create, edit, move, rename, or delete vault files.",
  },
  network: {
    label: "Use the network",
    description: "References browser or Node networking APIs that can contact remote services.",
  },
  filesystem: {
    label: "Access the host filesystem",
    description: "References Node filesystem APIs outside Threadleaf's vault abstraction.",
  },
  subprocess: {
    label: "Run host processes",
    description: "References Node child-process APIs that can launch programs or shell commands.",
  },
  "host-environment": {
    label: "Inspect the host environment",
    description: "References environment, operating-system, or home-directory information.",
  },
  clipboard: {
    label: "Read or change the clipboard",
    description: "References browser or Electron clipboard APIs.",
  },
  "external-navigation": {
    label: "Open external destinations",
    description: "References APIs that can open a browser, application, or external URL.",
  },
  "editor-extension": {
    label: "Extend the editor",
    description: "References CodeMirror or Obsidian editor-extension APIs.",
  },
  "workspace-ui": {
    label: "Change workspace UI",
    description: "References commands, views, settings, ribbon, status, or Markdown render hooks.",
  },
  "dynamic-code": {
    label: "Evaluate dynamic code",
    description: "References runtime code evaluation or dynamically selected modules.",
  },
};

export interface PluginCapabilityFinding {
  capability: PluginCapabilityId;
  evidence: string[];
}

export interface PluginCapabilityReport {
  scannerVersion: 1;
  bundleSha256: string;
  capabilities: PluginCapabilityId[];
  findings: PluginCapabilityFinding[];
  staticOnly: true;
}

export interface PluginCapabilityGrant {
  bundleSha256: string;
  capabilities: PluginCapabilityId[];
}

export type PluginCapabilityGrantState = "unavailable" | "required" | "granted" | "stale";

export interface VaultPluginSettings {
  compatibilityMode: CompatibilityMode;
  enabledPluginIds: string[];
  capabilityGrantsByPlugin: Record<string, PluginCapabilityGrant>;
}

export interface PluginManifestData {
  id: string;
  name: string;
  version: string;
  minAppVersion: string | null;
  description: string | null;
  author: string | null;
  authorUrl: string | null;
  isDesktopOnly: boolean;
}

export type PluginCompatibilityEvidenceStatus = "verified" | "different-version" | "unverified";

export interface PluginCompatibilityReport {
  level: 0 | 1 | 2 | 3 | 4;
  status: PluginCompatibilityEvidenceStatus;
  testedVersion: string | null;
  testedThreadleafVersion: string | null;
  lastTested: string | null;
  summary: string;
}

export type PluginPackageState = "ready" | "invalid";

export interface PluginPackageSummary extends PluginManifestData {
  source: "obsidian-vault";
  packageState: PluginPackageState;
  stylesheetDiscovered: boolean;
  compatibility: PluginCompatibilityReport;
  capabilityReport: PluginCapabilityReport | null;
  capabilityGrantState: PluginCapabilityGrantState;
  error: string | null;
  /** Stable renderer-safe category for `error`; raw loader failures are never serialized. */
  errorCode?: PluginDiagnosticCode | null;
}

export interface PluginCatalogSnapshot {
  vaultId: string;
  preference: VaultPluginSettings;
  safeMode: boolean;
  plugins: PluginPackageSummary[];
  managedPackages: import("./plugin-packages").ManagedPluginPackageSummary[];
  warnings: string[];
  css: string;
}

export type PluginCatalogResponse =
  | { status: "ready"; catalog: PluginCatalogSnapshot }
  | { status: "stale-vault"; vaultId: string };

export const defaultVaultPluginSettings: Readonly<VaultPluginSettings> = {
  compatibilityMode: "restricted",
  enabledPluginIds: [],
  capabilityGrantsByPlugin: {},
};

const pluginIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneLine(value: string, field: string, maxLength: number): string {
  const normalized = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    throw new Error(`Plugin manifest requires a non-empty ${field}.`);
  }
  if (normalized.length > maxLength) {
    throw new Error(`Plugin manifest ${field} exceeds ${maxLength} characters.`);
  }
  return normalized;
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new Error(`Plugin manifest requires a non-empty ${field}.`);
  }
  return oneLine(value, field, maxLength);
}

function optionalString(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Plugin manifest ${field} must be a string when present.`);
  }
  return oneLine(value, field, maxLength);
}

export function parsePluginId(value: unknown): string {
  if (typeof value !== "string" || !pluginIdPattern.test(value)) {
    throw new Error(
      "Plugin identifier must start with a letter or number and use only letters, numbers, dots, underscores, and hyphens.",
    );
  }
  return value;
}

export function parsePluginManifest(value: unknown): PluginManifestData {
  if (!isRecord(value)) {
    throw new Error("Plugin manifest must be an object.");
  }
  if (value.isDesktopOnly !== undefined && typeof value.isDesktopOnly !== "boolean") {
    throw new Error("Plugin manifest isDesktopOnly must be a boolean when present.");
  }
  return {
    id: parsePluginId(value.id),
    name: requiredString(value.name, "name", 200),
    version: requiredString(value.version, "version", 100),
    minAppVersion: optionalString(value.minAppVersion, "minAppVersion", 100),
    description: optionalString(value.description, "description", 2_000),
    author: optionalString(value.author, "author", 200),
    authorUrl: optionalString(value.authorUrl, "authorUrl", 2_000),
    isDesktopOnly: value.isDesktopOnly ?? false,
  };
}

export function createPluginCompatibilityReport(
  manifest: Pick<PluginManifestData, "id" | "version">,
): PluginCompatibilityReport {
  const candidates = pluginCompatibilityRegistry.entries.filter(
    (entry) => entry.plugin.id === manifest.id,
  );
  const evidence = candidates.find((entry) => entry.plugin.version === manifest.version);
  const reference = evidence ?? candidates.at(-1);
  if (evidence) {
    return {
      level: evidence.compatibilityLevel,
      status: "verified",
      testedVersion: evidence.plugin.version,
      testedThreadleafVersion: evidence.threadleafVersion,
      lastTested: evidence.lastTested,
      summary: `${evidence.summary} Verified with Threadleaf ${evidence.threadleafVersion} on ${evidence.lastTested}.`,
    };
  }
  if (!reference) {
    return {
      level: 0,
      status: "unverified",
      testedVersion: null,
      testedThreadleafVersion: null,
      lastTested: null,
      summary:
        "Package structure is valid. No production-path workflow is verified for this exact plugin version.",
    };
  }
  return {
    level: 0,
    status: "different-version",
    testedVersion: reference.plugin.version,
    testedThreadleafVersion: reference.threadleafVersion,
    lastTested: reference.lastTested,
    summary: `${reference.summary} Evidence applies to plugin ${reference.plugin.version} with Threadleaf ${reference.threadleafVersion}; installed ${manifest.version} remains unverified.`,
  };
}

export function parseVaultPluginSettings(value: unknown): VaultPluginSettings {
  if (
    !isRecord(value) ||
    !compatibilityModes.includes(value.compatibilityMode as CompatibilityMode)
  ) {
    throw new Error("Vault plugin settings require restricted or enabled compatibility mode.");
  }
  if (!Array.isArray(value.enabledPluginIds) || value.enabledPluginIds.length > 128) {
    throw new Error("Vault plugin settings may enable at most 128 plugins.");
  }
  const enabledPluginIds = value.enabledPluginIds.map(parsePluginId);
  if (new Set(enabledPluginIds).size !== enabledPluginIds.length) {
    throw new Error("Enabled plugin identifiers must be unique.");
  }
  const rawGrants = value.capabilityGrantsByPlugin ?? {};
  if (!isRecord(rawGrants) || Object.keys(rawGrants).length > 128) {
    throw new Error("Vault plugin settings may retain grants for at most 128 plugins.");
  }
  const capabilityGrantsByPlugin: Record<string, PluginCapabilityGrant> = {};
  for (const [rawPluginId, rawGrant] of Object.entries(rawGrants)) {
    const pluginId = parsePluginId(rawPluginId);
    if (
      !isRecord(rawGrant) ||
      typeof rawGrant.bundleSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(rawGrant.bundleSha256) ||
      !Array.isArray(rawGrant.capabilities) ||
      rawGrant.capabilities.length > pluginCapabilityIds.length
    ) {
      throw new Error(`Capability grant for ${pluginId} is malformed.`);
    }
    const capabilities = rawGrant.capabilities.map((capability) => {
      if (
        typeof capability !== "string" ||
        !pluginCapabilityIds.includes(capability as PluginCapabilityId)
      ) {
        throw new Error(`Capability grant for ${pluginId} contains an unknown authority.`);
      }
      return capability as PluginCapabilityId;
    });
    if (new Set(capabilities).size !== capabilities.length) {
      throw new Error(`Capability grant for ${pluginId} contains duplicate authorities.`);
    }
    capabilityGrantsByPlugin[pluginId] = {
      bundleSha256: rawGrant.bundleSha256,
      capabilities,
    };
  }
  return {
    compatibilityMode: value.compatibilityMode as CompatibilityMode,
    enabledPluginIds,
    capabilityGrantsByPlugin,
  };
}

export function createDefaultVaultPluginSettings(): VaultPluginSettings {
  return { compatibilityMode: "restricted", enabledPluginIds: [], capabilityGrantsByPlugin: {} };
}

export function pluginCapabilityGrantMatches(
  report: PluginCapabilityReport,
  grant: PluginCapabilityGrant | undefined,
): boolean {
  return (
    grant !== undefined &&
    grant.bundleSha256 === report.bundleSha256 &&
    grant.capabilities.length === report.capabilities.length &&
    grant.capabilities.every((capability, index) => capability === report.capabilities[index])
  );
}

export function pluginCapabilityGrantState(
  report: PluginCapabilityReport | null,
  grant: PluginCapabilityGrant | undefined,
): PluginCapabilityGrantState {
  if (!report) {
    return "unavailable";
  }
  if (!grant) {
    return "required";
  }
  return pluginCapabilityGrantMatches(report, grant) ? "granted" : "stale";
}
