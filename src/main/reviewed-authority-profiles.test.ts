import { describe, expect, it } from "vitest";
import {
  authorityJsonSha256,
  parseReviewedAuthorityProfile,
  reviewedAuthorityPayload,
  reviewedAuthorityProfileByIdentity,
  reviewedAuthorityProfiles,
} from "./reviewed-authority-profiles";

describe("reviewed authority profiles", () => {
  it("loads the twenty-six exact identity-bound records", () => {
    const profiles = reviewedAuthorityProfiles();
    expect(profiles.map(({ packageIdentity }) => packageIdentity.pluginId).sort()).toEqual([
      "calendar-beta",
      "cite",
      "darlal-switcher-plus",
      "data-files-editor",
      "dataview",
      "inspection-runaway",
      "inspection-safe",
      "inspection-teardown",
      "nldates-obsidian",
      "obsidian-auto-link-title",
      "obsidian-auto-link-title",
      "obsidian-excalidraw-plugin",
      "obsidian-excalidraw-plugin",
      "obsidian-excalidraw-plugin",
      "obsidian-icon-folder",
      "obsidian-minimal-settings",
      "obsidian-minimal-settings",
      "obsidian-style-settings",
      "omnisearch",
      "table-editor-obsidian",
      "templater-obsidian",
      "threadleaf-trusted-state-fixture",
      "threadleaf-trusted-view-fixture",
      "threadleaf-workspace-docks-fixture",
      "url-into-selection",
      "url-into-selection",
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
    const advancedTables = profiles.find(
      ({ packageIdentity }) => packageIdentity.pluginId === "table-editor-obsidian",
    );
    expect(advancedTables).toMatchObject({
      packageIdentity: {
        manifestVersion: "0.22.1",
        distributionTag: "0.22.1",
        packageTreeSha256: "becba250c710da28e5adbd6c67463b34203a44a34756152c36fa36739f1d9d11",
      },
      packageIdentityDigest: "8a23f9e4fed85016f015f656dd66f341547a51be9c0d1c2dffde70e55b20e289",
      expectedStaticCapabilities: [
        "external-navigation",
        "editor-extension",
        "workspace-ui",
        "dynamic-code",
      ],
      executionProfile: "trusted-node-renderer",
    });
    const urlSelectionProfiles = profiles.filter(
      ({ packageIdentity }) => packageIdentity.pluginId === "url-into-selection",
    );
    expect(urlSelectionProfiles).toHaveLength(2);
    expect(urlSelectionProfiles.map(({ packageIdentity }) => packageIdentity.mainSha256)).toEqual([
      "377883d2fc2a1feeb96be868f7110782874206cb3065635281e89fdfdc6e6d77",
      "8578844689112df74390d7b107a1302b30c8e31a490cadf40bccd73ddeca9aca",
    ]);
    const autoLinkTitleProfiles = profiles.filter(
      ({ packageIdentity }) => packageIdentity.pluginId === "obsidian-auto-link-title",
    );
    expect(autoLinkTitleProfiles).toHaveLength(2);
    expect(autoLinkTitleProfiles.map(({ packageIdentity }) => packageIdentity.mainSha256)).toEqual([
      "eb27498bfd05dc5c3847dd072f555ed4c02aece24451042c2edb25fc961f38be",
      "b1da7a8b9b98b4c7daeae1286db2cd7fc5e24bef2903d3e326adcfc7db146f32",
    ]);
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
