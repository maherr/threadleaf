import { promises as fs } from "node:fs";
import type { ActionRegistry } from "../application/action-registry";
import type { VaultReadPort } from "../kernel/ports";
import {
  inspectSealedPluginPackage,
  PluginConstructionPolicyResolver,
} from "../main/plugin-construction-policy";
import { PolicyEnforcingPluginHost } from "../main/policy-enforcing-plugin-host";
import type { CompatibilityVaultWritePort } from "../runtime/obsidian-compat";
import { PluginHost } from "../runtime/plugin-host";
import { authorityJsonSha256 } from "../shared/authority-json";
import type {
  CommunityPluginGrantV2,
  PluginCapabilityId,
  PluginConstructionDispatch,
  PluginConstructionPath,
  PluginConstructionRequest,
  ReviewedAuthorityProfile,
} from "../shared/plugins";

let testAttemptSequence = 0;

function uniqueCapabilities(values: readonly PluginCapabilityId[]): PluginCapabilityId[] {
  const wanted = new Set(values);
  return [
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
  ].filter((capability): capability is PluginCapabilityId =>
    wanted.has(capability as PluginCapabilityId),
  );
}

function profilePayload(profile: ReviewedAuthorityProfile) {
  return {
    schemaVersion: profile.schemaVersion,
    profileId: profile.profileId,
    profileRevision: profile.profileRevision,
    packageIdentity: profile.packageIdentity,
    packageIdentityDigest: profile.packageIdentityDigest,
    expectedStaticCapabilities: profile.expectedStaticCapabilities,
    requiredAuthorities: profile.requiredAuthorities,
    executionProfile: profile.executionProfile,
    allowedPlatforms: profile.allowedPlatforms,
  };
}

export async function testConstructionRequest(
  pluginDirectory: string,
  constructionPath: PluginConstructionPath = "test-execution",
): Promise<PluginConstructionRequest> {
  pluginDirectory = await fs.realpath(pluginDirectory);
  const manifest = JSON.parse(await fs.readFile(`${pluginDirectory}/manifest.json`, "utf8")) as {
    version: string;
  };
  const sealedPackage = {
    sealedPackageRootId: "test-probe",
    sealedPackageRootPath: pluginDirectory,
    packageIdentityDigest: "0".repeat(64),
    packageTreeSha256: "0".repeat(64),
  };
  const inspected = await inspectSealedPluginPackage(sealedPackage, manifest.version);
  return {
    constructionPath,
    pluginDirectory,
    packageIdentity: inspected.identity,
    packageIdentityDigest: inspected.identityDigest,
  };
}

export async function testConstructionDispatch(
  pluginDirectory: string,
  constructionPath: PluginConstructionPath = "test-execution",
): Promise<PluginConstructionDispatch> {
  pluginDirectory = await fs.realpath(pluginDirectory);
  const request = await testConstructionRequest(pluginDirectory, constructionPath);
  const inspected = await inspectSealedPluginPackage(
    {
      sealedPackageRootId: "test-probe",
      sealedPackageRootPath: pluginDirectory,
      packageIdentityDigest: request.packageIdentityDigest,
      packageTreeSha256: request.packageIdentity.packageTreeSha256,
    },
    request.packageIdentity.distributionTag,
  );
  const profile: ReviewedAuthorityProfile = {
    $schema: "./reviewed-authority-profile.v1.schema.json",
    schemaVersion: 1,
    profileId: `test-${request.packageIdentity.pluginId}-${request.packageIdentityDigest}`,
    profileRevision: 37,
    packageIdentity: request.packageIdentity,
    packageIdentityDigest: request.packageIdentityDigest,
    expectedStaticCapabilities: inspected.staticCapabilities,
    requiredAuthorities: uniqueCapabilities([
      ...inspected.staticCapabilities,
      "network",
      "filesystem",
      "subprocess",
      "host-environment",
      "dynamic-code",
    ]),
    executionProfile: "trusted-node-renderer",
    allowedPlatforms: ["linux", "darwin", "win32"],
    authorityDigest: "",
  };
  profile.authorityDigest = authorityJsonSha256(profilePayload(profile));
  const grant: CommunityPluginGrantV2 = {
    schemaVersion: 2,
    grantId: `test-grant-${request.packageIdentityDigest}`,
    vaultId: "test-vault",
    packageIdentity: request.packageIdentity,
    packageIdentityDigest: request.packageIdentityDigest,
    authorityProfileId: profile.profileId,
    authorityProfileRevision: profile.profileRevision,
    authorityDigest: profile.authorityDigest,
    grantedAuthorities: profile.requiredAuthorities,
    provenance: {
      kind: "content-addressed-unsigned",
      sourceDescriptorDigest: "1".repeat(64),
    },
    grantRevision: 29,
    grantEpoch: 31,
    issuedAt: "2026-08-14T00:00:00.000Z",
    revokedAt: null,
    revocationReason: null,
  };
  const sealedPackage = {
    sealedPackageRootId: `test-sealed-${request.packageIdentityDigest}`,
    sealedPackageRootPath: pluginDirectory,
    packageIdentityDigest: request.packageIdentityDigest,
    packageTreeSha256: request.packageIdentity.packageTreeSha256,
  };
  const resolver = new PluginConstructionPolicyResolver({
    profileByIdentity: () => profile,
    readAuthoritySnapshot: async () => ({
      vaultId: "test-vault",
      vaultGeneration: 19,
      policyEpoch: 23,
      grantEpoch: 31,
      safeMode: false,
      safeModeEpoch: 17,
      packageStoreEpoch: 13,
      platform: "linux",
      availableExecutionProfiles: ["trusted-node-renderer"],
      grant,
      sealedPackage,
    }),
    createAttemptId: () => `test-attempt-${++testAttemptSequence}`,
    now: () => new Date("2026-08-14T00:00:00.000Z"),
  });
  return resolver.resolveAndConsume(request);
}

export async function testPluginRuntimeFactory(
  vaultPath: string,
  actions: ActionRegistry,
  vault?: VaultReadPort & CompatibilityVaultWritePort,
) {
  return new PolicyEnforcingPluginHost(
    new PluginHost(vaultPath, vault, actions, undefined, vault),
    {
      resolveAndConsume: (request) =>
        testConstructionDispatch(request.pluginDirectory, request.constructionPath),
    },
  );
}
