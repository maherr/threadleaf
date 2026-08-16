import { describe, expect, it } from "vitest";
import {
  createDefaultVaultPluginSettings,
  createPluginCompatibilityReport,
  type PluginCapabilityGrant,
  type PluginCapabilityReport,
  parsePluginManifest,
  parseVaultPluginSettings,
  pluginCapabilityGrantMatches,
  pluginCapabilityGrantState,
} from "./plugins";

describe("plugin compatibility settings", () => {
  it("defaults to restricted mode with no selected compatibility plugins", () => {
    expect(createDefaultVaultPluginSettings()).toEqual({
      compatibilityMode: "restricted",
      enabledPluginIds: [],
      capabilityGrantsByPlugin: {},
    });
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
      level: 4,
      status: "verified",
      testedVersion: "2.25.3",
      testedThreadleafVersion: "0.1.0-beta.6",
      lastTested: "2026-08-15",
    });
    expect(
      createPluginCompatibilityReport({ id: "obsidian-excalidraw-plugin", version: "2.26.0" }),
    ).toMatchObject({
      level: 0,
      status: "different-version",
      testedVersion: "2.25.3",
      testedThreadleafVersion: "0.1.0-beta.6",
      lastTested: "2026-08-15",
    });
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
