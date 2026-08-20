import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const renderer = readFileSync(new URL("./renderer.ts", import.meta.url), "utf8");

describe("compatibility plugin surface lifecycle", () => {
  it("does not replace plugin-owned modal and settings overlays with the active document view", () => {
    expect(renderer).toContain('snapshot.pluginSurface?.viewType === "threadleaf-plugin-modal"');
    expect(renderer).toContain('snapshot.pluginSurface?.viewType === "threadleaf-plugin-settings"');
    expect(renderer).toContain("!pluginOverlayOwnsSurface");
  });

  it("delivers layout-ready again after replacing the compatibility runtime", () => {
    const settingsApplied = renderer.indexOf("applySettingsSnapshot(response.settings);");
    const readyReset = renderer.indexOf("pluginLayoutReadyVaultId = null;", settingsApplied);
    const responseRendered = renderer.indexOf("render(response.snapshot);", settingsApplied);

    expect(settingsApplied).toBeGreaterThanOrEqual(0);
    expect(readyReset).toBeGreaterThan(settingsApplied);
    expect(responseRendered).toBeGreaterThan(readyReset);
  });

  it("closes the prior plugin surface before activating a different workspace document", () => {
    const surfaceDecision = renderer.indexOf("const closesCurrentPluginSurface =");
    const close = renderer.indexOf("await window.threadleaf.closePluginView();", surfaceDecision);
    const open = renderer.indexOf(
      "return window.threadleaf.openNote(filePath, paneId, activate);",
      close,
    );

    expect(surfaceDecision).toBeGreaterThanOrEqual(0);
    expect(close).toBeGreaterThan(surfaceDecision);
    expect(open).toBeGreaterThan(close);
  });
});
