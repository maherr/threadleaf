import { describe, expect, it } from "vitest";
import type { PluginIntegrationSnapshot } from "./contracts";
import { pluginViewTypeForPath, workspacePluginViewTypeForPath } from "./plugin-document";

function integrations(
  extensions: PluginIntegrationSnapshot["extensions"],
  viewTypes = [...new Set(extensions.map(({ viewType }) => viewType))],
): PluginIntegrationSnapshot {
  return {
    editorSuggests: 0,
    extensions,
    markdownPostProcessors: 0,
    ribbonItems: 0,
    settingTabs: 0,
    statusBarItems: 0,
    viewTypes,
  };
}

describe("plugin document view resolution", () => {
  it("keeps ordinary Markdown native when a plugin registers the broad md extension", () => {
    const snapshot = integrations([{ extension: "md", viewType: "excalidraw" }]);

    expect(pluginViewTypeForPath("Notes/Source.md", snapshot)).toBeNull();
    expect(workspacePluginViewTypeForPath("Notes/Source.md", snapshot)).toBeNull();
  });

  it("preserves the explicit Excalidraw Markdown contract", () => {
    const snapshot = integrations([{ extension: "md", viewType: "excalidraw" }]);

    expect(pluginViewTypeForPath("Drawings/Scene.excalidraw.md", snapshot)).toBe("excalidraw");
  });

  it("still resolves non-Markdown custom documents through registered extensions", () => {
    const snapshot = integrations([{ extension: "json", viewType: "data-files-editor" }]);

    expect(pluginViewTypeForPath("Data/status.json", snapshot)).toBe("data-files-editor");
  });
});
