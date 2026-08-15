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

async function mainProcessIpcHandlers(): Promise<Map<string, string>> {
  const sourceText = await fs.readFile(new URL("./main.ts", import.meta.url), "utf8");
  const handlers = new Map<string, string>();
  for (const channel of guardedPluginIpcChannels) {
    const channelToken = `ipcChannels.${channel}`;
    const start =
      new RegExp(`ipcChannels\\.${channel}(?![A-Za-z])`, "u").exec(sourceText)?.index ?? -1;
    if (start >= 0) {
      const nextHandler = sourceText.indexOf("\n  ipcMain.handle", start + channelToken.length);
      handlers.set(
        channel,
        sourceText.slice(start, nextHandler >= 0 ? nextHandler : undefined).replace(/\s+/gu, " "),
      );
    }
  }
  return handlers;
}

describe("plugin IPC sender guard", () => {
  it("rejects a non-main sender before the protected operation can run", () => {
    expect(() => assertMainRendererPluginIpcSender(false, "Plugin reload")).toThrow(
      "Plugin reload requires the active Threadleaf window.",
    );
    expect(() => assertMainRendererPluginIpcSender(true, "Plugin reload")).not.toThrow();
  });

  it("guards every main-renderer plugin IPC handler consistently", async () => {
    const handlers = await mainProcessIpcHandlers();
    for (const channel of guardedPluginIpcChannels) {
      expect(handlers.get(channel), `missing sender guard for ipcChannels.${channel}`).toMatch(
        /assertMainRendererPluginIpcSender\(\s*isMainRendererSender\(event\.sender\)/u,
      );
    }
  });
});
