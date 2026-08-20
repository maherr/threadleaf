import { describe, expect, it } from "vitest";
import {
  authorityJsonSha256,
  parseReviewedAuthorityProfile,
  reviewedAuthorityPayload,
  reviewedAuthorityProfileByIdentity,
  reviewedAuthorityProfiles,
} from "./reviewed-authority-profiles";

describe("reviewed authority profiles", () => {
  it("loads the eighteen exact identity-bound records", () => {
    const profiles = reviewedAuthorityProfiles();
    expect(profiles.map(({ packageIdentity }) => packageIdentity.pluginId).sort()).toEqual([
      "calendar-beta",
      "cite",
      "data-files-editor",
      "dataview",
      "inspection-runaway",
      "inspection-safe",
      "inspection-teardown",
      "obsidian-excalidraw-plugin",
      "obsidian-excalidraw-plugin",
      "obsidian-excalidraw-plugin",
      "obsidian-icon-folder",
      "obsidian-minimal-settings",
      "obsidian-style-settings",
      "omnisearch",
      "templater-obsidian",
      "threadleaf-trusted-state-fixture",
      "threadleaf-trusted-view-fixture",
      "threadleaf-workspace-docks-fixture",
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
    const dataview = profiles.find(
      ({ packageIdentity }) => packageIdentity.pluginId === "dataview",
    );
    expect(dataview).toMatchObject({
      packageIdentity: {
        manifestVersion: "0.5.68",
        distributionTag: "0.5.68",
        packageTreeSha256: "ec702f4933c75eb674953d437e59ed8c2c2a610c2f3a199bf64d972588ca77f6",
      },
      packageIdentityDigest: "fb77330c95607d4a20bddf5a952f5ebc1513b110b62406d7d6e9744e87a8a087",
      expectedStaticCapabilities: [
        "vault-read",
        "network",
        "editor-extension",
        "workspace-ui",
        "dynamic-code",
      ],
      executionProfile: "trusted-node-renderer",
    });
    const excalidraw2253 = profiles.find(
      ({ packageIdentity }) =>
        packageIdentity.pluginId === "obsidian-excalidraw-plugin" &&
        packageIdentity.manifestVersion === "2.25.3",
    );
    expect(excalidraw2253).toMatchObject({
      packageIdentity: {
        manifestVersion: "2.25.3",
        distributionTag: "2.25.3",
        packageTreeSha256: "4ff38da95a78ba66e7200e1c6e34ec650e7fc1661e9fe6da3ac2aa7da251a8c3",
      },
      packageIdentityDigest: "eb4b823b4614be855b72198a11decd87d9eaaea7247210d74983a59ac0a82bb9",
      executionProfile: "trusted-node-renderer",
    });
    const excalidraw2264 = profiles.find(
      ({ packageIdentity }) =>
        packageIdentity.pluginId === "obsidian-excalidraw-plugin" &&
        packageIdentity.manifestVersion === "2.26.4",
    );
    expect(excalidraw2264).toMatchObject({
      packageIdentity: {
        manifestVersion: "2.26.4",
        distributionTag: "2.26.4",
        packageTreeSha256: "b5d2ce2c808a56cf668b020623c2a4a1702416214dfb898d7b2ad651ea0f8ea5",
      },
      packageIdentityDigest: "1075ef87ee0d8003dca8b0ed6b0fb5f5cb091d8fb6c35619319333aa3c4926e7",
      executionProfile: "trusted-node-renderer",
    });
    expect(excalidraw2253?.requiredAuthorities).toEqual([
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
    ]);
    expect(excalidraw2264?.requiredAuthorities).toEqual(excalidraw2253?.requiredAuthorities);
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
