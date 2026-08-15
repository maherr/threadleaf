import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CommunityPluginGrantV2,
  isPluginConstructionRefusal,
  type PluginCapabilityId,
  type PluginConstructionDenialCode,
  type PluginConstructionRequest,
  pluginConstructionPaths,
} from "../shared/plugins";
import {
  type InspectedPluginPackage,
  inspectSealedPluginPackage,
  maxConsumedConstructionPolicyAttempts,
  measureInstalledPluginConstructionRequest,
  PluginCapabilityScanError,
  type PluginConstructionAuthoritySnapshot,
  PluginConstructionPolicyResolver,
} from "./plugin-construction-policy";
import {
  authorityJsonSha256,
  reviewedAuthorityPayload,
  reviewedAuthorityProfiles,
} from "./reviewed-authority-profiles";

const scratchDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true })),
  );
});

function styleProfile() {
  const profile = reviewedAuthorityProfiles().find(
    ({ packageIdentity }) => packageIdentity.pluginId === "obsidian-style-settings",
  );
  if (!profile) {
    throw new Error("Style Settings reviewed authority profile is missing.");
  }
  return profile;
}

function grantFor(profile = styleProfile()): CommunityPluginGrantV2 {
  return {
    schemaVersion: 2,
    grantId: "grant-1",
    vaultId: "vault-1",
    packageIdentity: { ...profile.packageIdentity },
    packageIdentityDigest: profile.packageIdentityDigest,
    authorityProfileId: profile.profileId,
    authorityProfileRevision: profile.profileRevision,
    authorityDigest: profile.authorityDigest,
    grantedAuthorities: [...profile.requiredAuthorities],
    provenance: {
      kind: "content-addressed-unsigned",
      sourceDescriptorDigest: "d".repeat(64),
    },
    grantRevision: 7,
    grantEpoch: 11,
    issuedAt: "2026-08-14T12:00:00.000Z",
    revokedAt: null,
    revocationReason: null,
  };
}

function requestFor(
  constructionPath: PluginConstructionRequest["constructionPath"] = "first-load",
): PluginConstructionRequest {
  const profile = styleProfile();
  return {
    constructionPath,
    pluginDirectory: "/source/obsidian-style-settings",
    packageIdentity: { ...profile.packageIdentity },
    packageIdentityDigest: profile.packageIdentityDigest,
  };
}

function snapshotFor(
  overrides: Partial<PluginConstructionAuthoritySnapshot> = {},
): PluginConstructionAuthoritySnapshot {
  const profile = styleProfile();
  return {
    vaultId: "vault-1",
    vaultGeneration: 23,
    policyEpoch: 41,
    grantEpoch: 11,
    safeMode: false,
    safeModeEpoch: 5,
    packageStoreEpoch: 17,
    platform: "linux",
    availableExecutionProfiles: ["trusted-node-renderer", "trusted-desktop-escape"],
    grant: grantFor(profile),
    sealedPackage: {
      sealedPackageRootId: "sealed-style-settings",
      sealedPackageRootPath: "/sealed/obsidian-style-settings",
      packageIdentityDigest: profile.packageIdentityDigest,
      packageTreeSha256: profile.packageIdentity.packageTreeSha256,
    },
    ...overrides,
  };
}

function inspectionFor(
  staticCapabilities = styleProfile().expectedStaticCapabilities,
): InspectedPluginPackage {
  const profile = styleProfile();
  return {
    identity: { ...profile.packageIdentity },
    identityDigest: profile.packageIdentityDigest,
    staticCapabilities: [...staticCapabilities],
    staticScanDigest: authorityJsonSha256({
      scannerVersion: 1,
      capabilities: staticCapabilities,
    }),
  };
}

function resolverFor(options?: {
  snapshot?: PluginConstructionAuthoritySnapshot;
  inspection?: InspectedPluginPackage;
  profileMissing?: boolean;
  createAttemptId?: () => string;
}) {
  const state = { current: options?.snapshot ?? snapshotFor() };
  const profileState = {
    current: options?.profileMissing ? null : styleProfile(),
  };
  const inspect = vi.fn(async () => options?.inspection ?? inspectionFor());
  const resolver = new PluginConstructionPolicyResolver({
    readAuthoritySnapshot: async () => state.current,
    profileByIdentity: () => profileState.current,
    inspectSealedPackage: inspect,
    createAttemptId: options?.createAttemptId ?? (() => "attempt-1"),
    now: () => new Date("2026-08-14T12:34:56.000Z"),
  });
  return { inspect, profileState, resolver, state };
}

async function expectDenied(
  resolver: PluginConstructionPolicyResolver,
  code: PluginConstructionDenialCode,
  request = requestFor(),
) {
  const policy = await resolver.resolveConstructionPolicy(request);
  expect(policy).toMatchObject({
    decision: "deny",
    denialCode: code,
    sealedPackageRootId: null,
    stagedPackageTreeSha256: null,
  });
  await expect(resolver.consumeConstructionPolicy(policy)).rejects.toSatisfy(
    (error: unknown) => isPluginConstructionRefusal(error) && error.code === code,
  );
  return policy;
}

describe("PluginConstructionPolicyResolver", () => {
  it("pins every construction path to the same non-default policy and epoch contract", async () => {
    expect(pluginConstructionPaths).toEqual([
      "first-load",
      "explicit-reload",
      "automatic-recovery",
      "renderer-death-restoration",
      "app-restart-reconstruction",
      "diagnostic-execution",
      "test-execution",
    ]);
    for (const constructionPath of pluginConstructionPaths) {
      const { resolver } = resolverFor();
      const dispatch = await resolver.resolveAndConsume(requestFor(constructionPath));
      expect(dispatch.policy).toMatchObject({
        constructionPath,
        boundary: "trusted-node-renderer",
        authorityProfileId: "obsidian-style-settings-1.0.9",
        epoch: {
          policyEpoch: 41,
          grantRevision: 7,
          safeModeEpoch: 5,
          packageStoreEpoch: 17,
        },
      });
    }
  });

  it("allows one exact, current, reviewed construction and preserves non-default epochs", async () => {
    const { resolver } = resolverFor();
    const policy = await resolver.resolveConstructionPolicy(
      requestFor("app-restart-reconstruction"),
    );
    expect(policy).toMatchObject({
      constructionPath: "app-restart-reconstruction",
      decision: "allow",
      denialCode: null,
      boundary: "trusted-node-renderer",
      epoch: {
        policyEpoch: 41,
        grantEpoch: 11,
        grantRevision: 7,
        safeModeEpoch: 5,
        packageStoreEpoch: 17,
        authorityProfileRevision: 1,
      },
    });
    const dispatch = await resolver.consumeConstructionPolicy(policy);
    expect(dispatch.pluginDirectory).toBe("/sealed/obsidian-style-settings");
    const { policyDigest: _policyDigest, ...policyPayload } = policy;
    expect(dispatch.policy.policyDigest).toBe(authorityJsonSha256(policyPayload));
    await expect(resolver.consumeConstructionPolicy(policy)).rejects.toSatisfy(
      (error: unknown) => isPluginConstructionRefusal(error) && error.code === "policy-epoch-stale",
    );
  });

  it("fails closed for every identity, profile, stage, grant, safe-mode, and platform deny", async () => {
    const profile = styleProfile();
    const cases: Array<{
      code: PluginConstructionDenialCode;
      resolver: PluginConstructionPolicyResolver;
      request?: PluginConstructionRequest;
    }> = [
      {
        code: "authority-profile-missing",
        resolver: resolverFor({ profileMissing: true }).resolver,
      },
      {
        code: "authority-profile-mismatch",
        resolver: resolverFor().resolver,
        request: {
          ...requestFor(),
          packageIdentity: { ...profile.packageIdentity, mainSha256: "0".repeat(64) },
        },
      },
      {
        code: "package-stage-invalid",
        resolver: resolverFor({ snapshot: snapshotFor({ sealedPackage: null }) }).resolver,
      },
      {
        code: "package-stage-invalid",
        resolver: new PluginConstructionPolicyResolver({
          readAuthoritySnapshot: async () => snapshotFor(),
          inspectSealedPackage: async () => {
            throw new Error("sealed root became unreadable");
          },
          createAttemptId: () => "unreadable-stage",
        }),
      },
      {
        code: "authority-profile-mismatch",
        resolver: new PluginConstructionPolicyResolver({
          readAuthoritySnapshot: async () => snapshotFor(),
          inspectSealedPackage: async () => {
            throw new PluginCapabilityScanError(new Error("invalid UTF-8"));
          },
          createAttemptId: () => "failed-static-scan",
        }),
      },
      {
        code: "package-identity-mismatch",
        resolver: resolverFor({
          inspection: {
            ...inspectionFor(),
            identity: { ...profile.packageIdentity, mainSha256: "0".repeat(64) },
            identityDigest: "0".repeat(64),
          },
        }).resolver,
      },
      {
        code: "authority-profile-mismatch",
        resolver: resolverFor({ inspection: inspectionFor(["workspace-ui"]) }).resolver,
      },
      {
        code: "safe-mode-blocked",
        resolver: resolverFor({ snapshot: snapshotFor({ safeMode: true }) }).resolver,
      },
      {
        code: "grant-required",
        resolver: resolverFor({ snapshot: snapshotFor({ grant: null }) }).resolver,
      },
      {
        code: "grant-revoked",
        resolver: resolverFor({
          snapshot: snapshotFor({
            grant: {
              ...grantFor(),
              revokedAt: "2026-08-14T12:30:00.000Z",
              revocationReason: "review withdrawn",
            },
          }),
        }).resolver,
      },
      {
        code: "grant-stale",
        resolver: resolverFor({
          snapshot: snapshotFor({
            grant: {
              ...grantFor(),
              grantedAuthorities: [
                ...grantFor().grantedAuthorities,
                "external-navigation" as PluginCapabilityId,
              ],
            },
          }),
        }).resolver,
      },
      {
        code: "capability-unavailable",
        resolver: resolverFor({
          snapshot: snapshotFor({ availableExecutionProfiles: ["trusted-desktop-escape"] }),
        }).resolver,
      },
    ];
    for (const candidate of cases) {
      await expectDenied(candidate.resolver, candidate.code, candidate.request);
    }
  });

  it("does not inspect or disclose a package when no fixed profile exists", async () => {
    const { inspect, resolver } = resolverFor({ profileMissing: true });
    await expectDenied(resolver, "authority-profile-missing");
    expect(inspect).not.toHaveBeenCalled();
  });

  it("denies every construction path when coherent authority epochs change before dispatch", async () => {
    for (const constructionPath of pluginConstructionPaths) {
      const { resolver, state } = resolverFor();
      const policy = await resolver.resolveConstructionPolicy(requestFor(constructionPath));
      state.current = { ...state.current, safeMode: true, safeModeEpoch: 6, policyEpoch: 42 };
      await expect(resolver.consumeConstructionPolicy(policy)).rejects.toSatisfy(
        (error: unknown) =>
          isPluginConstructionRefusal(error) &&
          error.code === "policy-epoch-stale" &&
          error.policy.constructionPath === constructionPath &&
          error.policy.sealedPackageRootId === null,
      );
    }
  });

  it("denies when the reviewed profile revision changes before dispatch", async () => {
    const { profileState, resolver } = resolverFor();
    const policy = await resolver.resolveConstructionPolicy(requestFor("explicit-reload"));
    const current = profileState.current;
    if (!current) {
      throw new Error("Expected a reviewed profile fixture.");
    }
    profileState.current = {
      ...current,
      profileRevision: current.profileRevision + 1,
      authorityDigest: "0".repeat(64),
    };

    await expect(resolver.consumeConstructionPolicy(policy)).rejects.toSatisfy(
      (error: unknown) => isPluginConstructionRefusal(error) && error.code === "policy-epoch-stale",
    );
  });

  it("denies an otherwise exact profile on a platform the review did not allow", async () => {
    const { profileState, resolver, state } = resolverFor();
    const current = profileState.current;
    if (!current) {
      throw new Error("Expected a reviewed profile fixture.");
    }
    const restricted = {
      ...current,
      allowedPlatforms: ["darwin" as const],
      authorityDigest: "",
    };
    restricted.authorityDigest = authorityJsonSha256(reviewedAuthorityPayload(restricted));
    profileState.current = restricted;
    state.current = { ...state.current, grant: grantFor(restricted) };

    await expectDenied(resolver, "capability-unavailable");
  });

  it("rejects a resolve-to-consume policy substitution even with a fresh digest", async () => {
    const { resolver } = resolverFor();
    const policy = await resolver.resolveConstructionPolicy(requestFor("first-load"));
    const { policyDigest: _policyDigest, ...substitutedPayload } = {
      ...policy,
      constructionPath: "diagnostic-execution" as const,
    };
    const substituted = {
      ...substitutedPayload,
      policyDigest: authorityJsonSha256(substitutedPayload),
    };

    await expect(resolver.consumeConstructionPolicy(substituted)).rejects.toSatisfy(
      (error: unknown) => isPluginConstructionRefusal(error) && error.code === "policy-epoch-stale",
    );
  });

  it("recomputes the consume-time policy digest independently of the stored object", async () => {
    const { resolver } = resolverFor();
    const policy = await resolver.resolveConstructionPolicy(requestFor());
    // The resolver stores this exact object reference. Mutating it makes the resolve-vs-consume
    // equality guard pass, so only the independent digest recomputation can reject it.
    policy.policyDigest = "0".repeat(64);

    await expect(resolver.consumeConstructionPolicy(policy)).rejects.toSatisfy(
      (error: unknown) => isPluginConstructionRefusal(error) && error.code === "policy-epoch-stale",
    );
  });

  it("rejects replay even if a consumed pending attempt is reintroduced", async () => {
    const { resolver } = resolverFor();
    const policy = await resolver.resolveConstructionPolicy(requestFor());
    const attempts = (resolver as unknown as { attempts: Map<string, unknown> }).attempts;
    const pending = attempts.get(policy.constructionAttemptId);
    expect(pending).toBeDefined();
    await resolver.consumeConstructionPolicy(policy);
    attempts.set(policy.constructionAttemptId, pending);

    await expect(resolver.consumeConstructionPolicy(policy)).rejects.toSatisfy(
      (error: unknown) => isPluginConstructionRefusal(error) && error.code === "policy-epoch-stale",
    );
  });

  it("fails closed when the consumed-policy replay ledger reaches its bound", async () => {
    let attemptSequence = 0;
    const { resolver } = resolverFor({
      createAttemptId: () => `ledger-attempt-${++attemptSequence}`,
    });
    for (let index = 0; index < maxConsumedConstructionPolicyAttempts; index += 1) {
      await resolver.resolveAndConsume(requestFor());
    }

    await expect(resolver.resolveAndConsume(requestFor())).rejects.toSatisfy(
      (error: unknown) =>
        isPluginConstructionRefusal(error) && error.code === "replay-ledger-exhausted",
    );
    expect(attemptSequence).toBe(maxConsumedConstructionPolicyAttempts + 1);
  });
});

describe("sealed package inspection", () => {
  async function fixturePackage(mainSource: string) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-authority-package-"));
    scratchDirectories.push(root);
    await fs.writeFile(
      path.join(root, "manifest.json"),
      JSON.stringify({ id: "fixture-plugin", name: "Fixture", version: "1.0.0" }),
    );
    await fs.writeFile(path.join(root, "main.js"), mainSource);
    await fs.writeFile(path.join(root, "dependency.js"), "module.exports = 1;\n");
    return root;
  }

  it("binds the identity to reachable local dependency bytes even when main.js is unchanged", async () => {
    const root = await fixturePackage('require("./dependency.js");\n');
    const stage = {
      sealedPackageRootId: "fixture",
      sealedPackageRootPath: root,
      packageIdentityDigest: "0".repeat(64),
      packageTreeSha256: "0".repeat(64),
    };
    const before = await inspectSealedPluginPackage(stage, "1.0.0");
    await fs.writeFile(path.join(root, "dependency.js"), "module.exports = 2;\n");
    const after = await inspectSealedPluginPackage(stage, "1.0.0");
    expect(after.identity.mainSha256).toBe(before.identity.mainSha256);
    expect(after.identity.packageTreeSha256).not.toBe(before.identity.packageTreeSha256);
    expect(after.identityDigest).not.toBe(before.identityDigest);
  });

  it("uses measured installed identity fields instead of copying a reviewed profile", async () => {
    const profile = styleProfile();
    const measuredIdentity = {
      ...profile.packageIdentity,
      manifestSha256: "a".repeat(64),
      stylesSha256: null,
      packageTreeSha256: "b".repeat(64),
    };
    const inspection: InspectedPluginPackage = {
      identity: measuredIdentity,
      identityDigest: authorityJsonSha256(measuredIdentity),
      staticCapabilities: [...profile.expectedStaticCapabilities],
      staticScanDigest: "c".repeat(64),
    };
    const inspectPackage = vi.fn(async () => inspection);

    const request = await measureInstalledPluginConstructionRequest(
      {
        directoryPath: "/installed/obsidian-style-settings",
        summary: { id: "obsidian-style-settings", version: "1.0.9" },
      },
      profile.packageIdentity.mainSha256,
      "first-load",
      inspectPackage,
    );

    expect(request.packageIdentity).toEqual(measuredIdentity);
    expect(request.packageIdentityDigest).toBe(inspection.identityDigest);
    expect(inspectPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        sealedPackageRootPath: "/installed/obsidian-style-settings",
      }),
      profile.packageIdentity.distributionTag,
    );
  });

  it("reports scanner evasion as drift instead of selecting lower authority", async () => {
    const root = await fixturePackage('require("child_" + "process");\n');
    const stage = {
      sealedPackageRootId: "fixture",
      sealedPackageRootPath: root,
      packageIdentityDigest: "0".repeat(64),
      packageTreeSha256: "0".repeat(64),
    };
    const inspected = await inspectSealedPluginPackage(stage, "1.0.0");
    expect(inspected.staticCapabilities).not.toContain("subprocess");
    const profile = {
      ...styleProfile(),
      profileId: "fixture-1.0.0",
      packageIdentity: inspected.identity,
      packageIdentityDigest: inspected.identityDigest,
      expectedStaticCapabilities: ["subprocess" as const],
      requiredAuthorities: ["network", "filesystem", "subprocess"] as PluginCapabilityId[],
    };
    profile.authorityDigest = authorityJsonSha256({
      schemaVersion: profile.schemaVersion,
      profileId: profile.profileId,
      profileRevision: profile.profileRevision,
      packageIdentity: profile.packageIdentity,
      packageIdentityDigest: profile.packageIdentityDigest,
      expectedStaticCapabilities: profile.expectedStaticCapabilities,
      requiredAuthorities: profile.requiredAuthorities,
      executionProfile: profile.executionProfile,
      allowedPlatforms: profile.allowedPlatforms,
    });
    const grant = grantFor(profile);
    const resolver = new PluginConstructionPolicyResolver({
      profileByIdentity: () => profile,
      readAuthoritySnapshot: async () => ({
        ...snapshotFor(),
        grant,
        sealedPackage: {
          ...stage,
          packageIdentityDigest: inspected.identityDigest,
          packageTreeSha256: inspected.identity.packageTreeSha256,
        },
      }),
      createAttemptId: () => "scanner-evasion",
    });
    await expectDenied(resolver, "authority-profile-mismatch", {
      constructionPath: "test-execution",
      pluginDirectory: root,
      packageIdentity: inspected.identity,
      packageIdentityDigest: inspected.identityDigest,
    });
  });
});
