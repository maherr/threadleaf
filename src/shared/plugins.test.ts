import { describe, expect, it } from "vitest";
import {
  createDefaultVaultPluginSettings,
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
});
