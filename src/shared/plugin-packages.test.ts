import { describe, expect, it } from "vitest";
import { parsePluginPackagePreviewRequest } from "./plugin-packages";

describe("plugin package requests", () => {
  it("accepts registry-compatible identifiers and exact versions", () => {
    expect(
      parsePluginPackagePreviewRequest({
        action: "install",
        pluginId: "scrybble.ink",
        version: "2.0.0-beta.1+desktop",
      }),
    ).toEqual({
      action: "install",
      pluginId: "scrybble.ink",
      version: "2.0.0-beta.1+desktop",
    });
    expect(
      parsePluginPackagePreviewRequest({ action: "rollback", pluginId: "ObsidianAnkiSync" }),
    ).toEqual({ action: "rollback", pluginId: "ObsidianAnkiSync" });
  });

  it("rejects malformed actions, identifiers, and request shapes", () => {
    for (const request of [
      null,
      { action: "execute", pluginId: "fixture" },
      { action: "install", pluginId: "../fixture" },
      { action: "uninstall", pluginId: "fixture", version: 1 },
    ]) {
      expect(() => parsePluginPackagePreviewRequest(request)).toThrow();
    }
  });
});
