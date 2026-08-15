import { describe, expect, it } from "vitest";
import {
  authorityJsonSha256,
  parseReviewedAuthorityProfile,
  reviewedAuthorityPayload,
  reviewedAuthorityProfileByIdentity,
  reviewedAuthorityProfiles,
} from "./reviewed-authority-profiles";

describe("reviewed authority profiles", () => {
  it("loads the six exact identity-bound records", () => {
    const profiles = reviewedAuthorityProfiles();
    expect(profiles.map(({ packageIdentity }) => packageIdentity.pluginId).sort()).toEqual([
      "calendar-beta",
      "inspection-runaway",
      "inspection-safe",
      "inspection-teardown",
      "obsidian-style-settings",
      "templater-obsidian",
    ]);
    const calendar = profiles.find(
      ({ packageIdentity }) => packageIdentity.pluginId === "calendar-beta",
    );
    expect(calendar?.packageIdentity).toMatchObject({
      distributionTag: "2.0.0-beta.2",
      manifestVersion: "2.0.0",
    });
    const templater = profiles.find(
      ({ packageIdentity }) => packageIdentity.pluginId === "templater-obsidian",
    );
    expect(templater?.expectedStaticCapabilities).toContain("subprocess");
    expect(templater?.requiredAuthorities).toContain("subprocess");
    expect(templater?.executionProfile).toBe("trusted-desktop-escape");
  });

  it("recomputes deterministic identity and authority digests", () => {
    for (const profile of reviewedAuthorityProfiles()) {
      expect(authorityJsonSha256(profile.packageIdentity)).toBe(profile.packageIdentityDigest);
      expect(authorityJsonSha256(reviewedAuthorityPayload(profile))).toBe(profile.authorityDigest);
      expect(reviewedAuthorityProfileByIdentity(profile.packageIdentityDigest)).toEqual(profile);
    }
  });

  it("denies stale digests, unknown fields, and ambient-authority omissions", () => {
    const profile = reviewedAuthorityProfiles()[0];
    expect(profile).toBeDefined();
    if (!profile) {
      return;
    }
    expect(() =>
      parseReviewedAuthorityProfile({
        ...profile,
        packageIdentity: { ...profile.packageIdentity, mainSha256: "0".repeat(64) },
      }),
    ).toThrow("package identity digest is stale");
    expect(() => parseReviewedAuthorityProfile({ ...profile, mergedProfileId: "other" })).toThrow(
      "missing or unknown fields",
    );
    expect(() =>
      parseReviewedAuthorityProfile({ ...profile, authorityDigest: "0".repeat(64) }),
    ).toThrow("authority digest is stale");
    const withoutSubprocess = profile.requiredAuthorities.filter(
      (capability) => capability !== "subprocess",
    );
    expect(() =>
      parseReviewedAuthorityProfile({
        ...profile,
        requiredAuthorities: withoutSubprocess,
        authorityDigest: authorityJsonSha256({
          ...reviewedAuthorityPayload(profile),
          requiredAuthorities: withoutSubprocess,
        }),
      }),
    ).toThrow("must disclose filesystem, network, and subprocess");
  });

  it("requires every expected static capability to remain in required authorities", () => {
    const templater = reviewedAuthorityProfiles().find(
      ({ packageIdentity }) => packageIdentity.pluginId === "templater-obsidian",
    );
    expect(templater).toBeDefined();
    if (!templater) {
      return;
    }
    const requiredAuthorities = templater.requiredAuthorities.filter(
      (capability) => capability !== "workspace-ui",
    );
    expect(() =>
      parseReviewedAuthorityProfile({
        ...templater,
        requiredAuthorities,
        authorityDigest: authorityJsonSha256({
          ...reviewedAuthorityPayload(templater),
          requiredAuthorities,
        }),
      }),
    ).toThrow("must include every expected static capability");
  });
});
