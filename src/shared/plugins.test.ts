import { describe, expect, it } from "vitest";
import {
  applyCompatibilityProfile,
  compatibilityProfileForVaultPluginSettings,
  createDefaultVaultPluginSettings,
  createPluginCompatibilityReport,
  isPluginDistributionPathIncluded,
  type PluginCapabilityGrant,
  type PluginCapabilityReport,
  parsePluginManifest,
  parseVaultPluginSettings,
  pluginCapabilityGrantMatches,
  pluginCapabilityGrantState,
} from "./plugins";

describe("plugin compatibility settings", () => {
  it("excludes only recognized mutable root data files from executable identity", () => {
    expect(isPluginDistributionPathIncluded("data.json")).toBe(false);
    expect(
      isPluginDistributionPathIncluded(".data.json.00c98356-991b-442b-b05d-429d3d275e87.tmp"),
    ).toBe(false);
    expect(isPluginDistributionPathIncluded(".data.json.not-a-uuid.tmp")).toBe(true);
    expect(
      isPluginDistributionPathIncluded("cache/.data.json.00c98356-991b-442b-b05d-429d3d275e87.tmp"),
    ).toBe(true);
    expect(
      isPluginDistributionPathIncluded(".main.js.00c98356-991b-442b-b05d-429d3d275e87.tmp"),
    ).toBe(true);
  });

  it("defaults to restricted mode with no selected compatibility plugins", () => {
    expect(createDefaultVaultPluginSettings()).toEqual({
      compatibilityMode: "restricted",
      compatibilityTopology: "isolated",
      enabledPluginIds: [],
      capabilityGrantsByPlugin: {},
    });
  });

  it("maps the three product profiles onto the orthogonal stored settings", () => {
    const current = {
      ...createDefaultVaultPluginSettings(),
      compatibilityMode: "enabled" as const,
      compatibilityTopology: "trusted-workspace" as const,
      enabledPluginIds: ["fixture"],
    };

    expect(compatibilityProfileForVaultPluginSettings(current)).toBe("trusted-workspace");
    expect(applyCompatibilityProfile(current, "off")).toMatchObject({
      compatibilityMode: "restricted",
      compatibilityTopology: "trusted-workspace",
    });
    expect(applyCompatibilityProfile(current, "isolated")).toMatchObject({
      compatibilityMode: "enabled",
      compatibilityTopology: "isolated",
    });
    expect(applyCompatibilityProfile(current, "trusted-workspace")).toMatchObject({
      compatibilityMode: "enabled",
      compatibilityTopology: "trusted-workspace",
    });
    expect(
      compatibilityProfileForVaultPluginSettings(applyCompatibilityProfile(current, "off")),
    ).toBe("off");
  });

  it("parses current and historical Obsidian plugin manifest fields", () => {
    expect(
      parsePluginManifest({
        id: "obsidian-excalidraw-plugin",
        name: "Excalidraw",
        version: "2.25.3",
        minAppVersion: "1.8.7",
        description: "Sketch your mind.",
        author: "Fixture author",
        authorUrl: "https://example.test",
        isDesktopOnly: false,
      }),
    ).toEqual({
      id: "obsidian-excalidraw-plugin",
      name: "Excalidraw",
      version: "2.25.3",
      minAppVersion: "1.8.7",
      description: "Sketch your mind.",
      author: "Fixture author",
      authorUrl: "https://example.test",
      isDesktopOnly: false,
    });
  });

  it("rejects malformed manifests and duplicate enabled identifiers", () => {
    expect(() => parsePluginManifest({ id: "../escape", name: "Bad", version: "1" })).toThrow(
      "start with a letter or number",
    );
    expect(() => parsePluginManifest({ id: "valid", name: " ", version: "1" })).toThrow(
      "non-empty name",
    );
    expect(() =>
      parseVaultPluginSettings({
        compatibilityMode: "enabled",
        enabledPluginIds: ["fixture", "fixture"],
      }),
    ).toThrow("unique");
  });

  it("accepts the uppercase, underscore, and dotted identifiers in the community package index", () => {
    for (const id of ["DEVONlink-obsidian", "waka_time_box", "scrybble.ink"]) {
      expect(parsePluginManifest({ id, name: id, version: "1.0.0" }).id).toBe(id);
    }
  });

  it("keeps compatibility evidence exact to the tested plugin version", () => {
    expect(
      createPluginCompatibilityReport({ id: "obsidian-excalidraw-plugin", version: "2.25.3" }),
    ).toMatchObject({
      level: 0,
      status: "verified",
      testedVersion: "2.25.3",
      testedThreadleafVersion: "0.1.0",
      lastTested: "2026-08-16",
    });
    expect(
      createPluginCompatibilityReport({ id: "obsidian-excalidraw-plugin", version: "2.26.4" }),
    ).toMatchObject({
      level: 2,
      status: "verified",
      testedVersion: "2.26.4",
      testedThreadleafVersion: "0.1.0",
      lastTested: "2026-08-16",
      evidenceMode: "direct",
      platforms: expect.arrayContaining([
        expect.objectContaining({ id: "linux-x64-electron", status: "verified" }),
      ]),
      workflows: expect.arrayContaining([
        expect.objectContaining({
          id: "sealed-construction-restart-revocation",
          status: "passed",
        }),
      ]),
    });
    expect(
      createPluginCompatibilityReport({ id: "obsidian-excalidraw-plugin", version: "2.27.0" }),
    ).toMatchObject({
      level: 0,
      status: "different-version",
      testedVersion: "2.26.4",
      testedThreadleafVersion: "0.1.0",
      lastTested: "2026-08-16",
    });
    expect(
      createPluginCompatibilityReport({
        id: "url-into-selection",
        version: "1.11.4",
        bundleSha256: "377883d2fc2a1feeb96be868f7110782874206cb3065635281e89fdfdc6e6d77",
      }),
    ).toMatchObject({ level: 3, status: "verified" });
    expect(
      createPluginCompatibilityReport({
        id: "url-into-selection",
        version: "1.11.4",
        bundleSha256: "8578844689112df74390d7b107a1302b30c8e31a490cadf40bccd73ddeca9aca",
      }),
    ).toMatchObject({ level: 3, status: "verified" });
    expect(
      createPluginCompatibilityReport({ id: "url-into-selection", version: "1.11.4" }),
    ).toMatchObject({ level: 0, status: "unverified" });
    expect(
      createPluginCompatibilityReport({
        id: "obsidian-auto-link-title",
        version: "1.5.5",
        bundleSha256: "eb27498bfd05dc5c3847dd072f555ed4c02aece24451042c2edb25fc961f38be",
      }),
    ).toMatchObject({ level: 3, status: "verified" });
    expect(
      createPluginCompatibilityReport({
        id: "obsidian-auto-link-title",
        version: "1.5.5",
        bundleSha256: "b1da7a8b9b98b4c7daeae1286db2cd7fc5e24bef2903d3e326adcfc7db146f32",
      }),
    ).toMatchObject({ level: 3, status: "verified" });
    expect(
      createPluginCompatibilityReport({ id: "obsidian-auto-link-title", version: "1.5.5" }),
    ).toMatchObject({ level: 0, status: "unverified" });
    expect(createPluginCompatibilityReport({ id: "unknown-plugin", version: "1.0.0" })).toEqual({
      level: 0,
      status: "unverified",
      testedVersion: null,
      testedThreadleafVersion: null,
      lastTested: null,
      summary:
        "Package structure is valid. No production-path workflow is verified for this exact plugin version.",
    });
  });

  it("parses exact-bundle capability grants and migrates legacy settings closed", () => {
    expect(
      parseVaultPluginSettings({
        compatibilityMode: "enabled",
        enabledPluginIds: ["fixture"],
      }),
    ).toEqual({
      compatibilityMode: "enabled",
      compatibilityTopology: "isolated",
      enabledPluginIds: ["fixture"],
      capabilityGrantsByPlugin: {},
    });
    const parsed = parseVaultPluginSettings({
      compatibilityMode: "enabled",
      enabledPluginIds: ["fixture"],
      capabilityGrantsByPlugin: {
        fixture: {
          bundleSha256: "a".repeat(64),
          capabilities: ["vault-read", "network"],
        },
      },
    });
    expect(parsed.capabilityGrantsByPlugin.fixture).toEqual({
      bundleSha256: "a".repeat(64),
      capabilities: ["vault-read", "network"],
    });
    expect(
      parseVaultPluginSettings({
        compatibilityMode: "enabled",
        compatibilityTopology: "trusted-workspace",
        enabledPluginIds: [],
      }).compatibilityTopology,
    ).toBe("trusted-workspace");
    expect(() =>
      parseVaultPluginSettings({
        compatibilityMode: "enabled",
        compatibilityTopology: "unknown",
        enabledPluginIds: [],
      }),
    ).toThrow("compatibility topology");
    expect(() =>
      parseVaultPluginSettings({
        compatibilityMode: "enabled",
        enabledPluginIds: [],
        capabilityGrantsByPlugin: {
          fixture: { bundleSha256: "not-a-hash", capabilities: [] },
        },
      }),
    ).toThrow("malformed");
  });

  it("requires the grant to match both exact bytes and the observed authority list", () => {
    const report: PluginCapabilityReport = {
      scannerVersion: 1,
      bundleSha256: "b".repeat(64),
      capabilities: ["vault-read", "network"],
      findings: [],
      staticOnly: true,
    };
    const exactGrant: PluginCapabilityGrant = {
      bundleSha256: "b".repeat(64),
      capabilities: ["vault-read", "network"],
    };

    expect(pluginCapabilityGrantMatches(report, exactGrant)).toBe(true);
    expect(pluginCapabilityGrantState(report, exactGrant)).toBe("granted");
    expect(
      pluginCapabilityGrantState(report, {
        ...exactGrant,
        bundleSha256: "c".repeat(64),
      }),
    ).toBe("stale");
    expect(pluginCapabilityGrantState(report, undefined)).toBe("required");
    expect(pluginCapabilityGrantState(null, undefined)).toBe("unavailable");
  });
});
