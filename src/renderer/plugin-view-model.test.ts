import { describe, expect, it } from "vitest";
import type { PluginIntegrationSnapshot } from "../shared/contracts";
import { pluginViewTypeForPath } from "./plugin-view-model";

const integrations: PluginIntegrationSnapshot = {
  editorSuggests: 0,
  extensions: [{ extension: "drawing", viewType: "drawing-view" }],
  markdownPostProcessors: 0,
  ribbonItems: 0,
  settingTabs: 0,
  statusBarItems: 0,
  viewTypes: ["excalidraw", "drawing-view", "sample-sidepanel"],
};

describe("plugin document view selection", () => {
  it("selects the explicit Excalidraw document contract", () => {
    expect(pluginViewTypeForPath("Sketch.excalidraw.md", integrations)).toBe("excalidraw");
    expect(pluginViewTypeForPath("SKETCH.EXCALIDRAW.MD", integrations)).toBe("excalidraw");
  });

  it("selects views registered for a file extension", () => {
    expect(pluginViewTypeForPath("Board.drawing", integrations)).toBe("drawing-view");
  });

  it("does not mount an unrelated document view for ordinary Markdown", () => {
    expect(pluginViewTypeForPath("Notes.md", integrations)).toBeNull();
    expect(pluginViewTypeForPath("Notes", integrations)).toBeNull();
    expect(pluginViewTypeForPath("Sketch.excalidraw.md", null)).toBeNull();
  });
});
