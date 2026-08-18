import { promises as fs } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertMainRendererPluginIpcSender } from "./plugin-ipc-sender-guard";

const guardedPluginIpcChannels = [
  "popOutPluginView",
  "reattachPluginView",
  "plugins",
  "searchPluginPackages",
  "previewPluginPackage",
  "applyPluginPackage",
  "cancelPluginPackageReview",
  "setCompatibilityMode",
  "setCompatibilityProfile",
  "setPluginCapabilityGrant",
  "setPluginEnabled",
  "reloadPlugins",
  "renderPluginMarkdownProjection",
  "runCommand",
  "waitForPluginMutations",
  "reloadPlugin",
  "unloadPlugin",
  "markPluginLayoutReady",
  "openPluginSettings",
  "openPluginView",
  "closePluginView",
  "setPluginSurfaceBounds",
  "setPluginSurfaceVisible",
  "setPluginSurfaceTheme",
  "setPluginSurfaceAccessibility",
] as const;

describe("plugin IPC sender guard", () => {
  it("rejects a non-main sender before the protected operation can run", () => {
    expect(() => assertMainRendererPluginIpcSender(false, "Plugin reload")).toThrow(
      "Plugin reload requires the active Threadleaf window.",
    );
    expect(() => assertMainRendererPluginIpcSender(true, "Plugin reload")).not.toThrow();
  });

  it("guards every main-renderer plugin IPC handler consistently", async () => {
    const sourceText = await fs.readFile(new URL("./main.ts", import.meta.url), "utf8");
    for (const channel of guardedPluginIpcChannels) {
      expect(sourceText, `missing guarded registration for ipcChannels.${channel}`).toMatch(
        new RegExp(`handleMainRendererIpc\\(\\s*ipcChannels\\.${channel}(?![A-Za-z])`, "u"),
      );
    }
  });
});
