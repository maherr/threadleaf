import { describe, expect, it } from "vitest";
import {
  createDefaultVaultPluginSettings,
  createPluginCompatibilityReport,
  parsePluginManifest,
  parseVaultPluginSettings,
} from "./plugins";

describe("plugin compatibility settings", () => {
  it("defaults to restricted mode with no selected compatibility plugins", () => {
    expect(createDefaultVaultPluginSettings()).toEqual({
      compatibilityMode: "restricted",
      enabledPluginIds: [],
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
      "lowercase letters",
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

  it("keeps compatibility evidence exact to the tested plugin version", () => {
    expect(
      createPluginCompatibilityReport({ id: "obsidian-excalidraw-plugin", version: "2.25.3" }),
    ).toMatchObject({
      level: 4,
      status: "verified",
      testedVersion: "2.25.3",
    });
    expect(
      createPluginCompatibilityReport({ id: "obsidian-excalidraw-plugin", version: "2.26.0" }),
    ).toMatchObject({
      level: 0,
      status: "different-version",
      testedVersion: "2.25.3",
    });
    expect(createPluginCompatibilityReport({ id: "unknown-plugin", version: "1.0.0" })).toEqual({
      level: 0,
      status: "unverified",
      testedVersion: null,
      summary:
        "Package structure is valid. No production-path workflow is verified for this exact plugin version.",
    });
  });
});
