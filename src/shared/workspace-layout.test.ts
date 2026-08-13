import { describe, expect, it } from "vitest";
import {
  createDefaultWorkspaceLayout,
  parseWorkspaceLayout,
  restoreWorkspaceWindowBounds,
  workspaceWindowMinimumHeight,
  workspaceWindowMinimumWidth,
} from "./workspace-layout";

describe("workspace layout bounds", () => {
  it("restores an off-screen and undersized window into a visible display", () => {
    const restored = restoreWorkspaceWindowBounds(
      { x: 9000, y: -9000, width: 320, height: 200, scaleFactor: 2 },
      [{ x: 0, y: 0, width: 1280, height: 720 }],
      { x: 20, y: 20, width: 800, height: 600, scaleFactor: 1 },
    );
    expect(restored.width).toBe(workspaceWindowMinimumWidth);
    expect(restored.height).toBe(workspaceWindowMinimumHeight);
    expect(restored.x).toBeGreaterThanOrEqual(0);
    expect(restored.x).toBeLessThanOrEqual(1280 - 48);
    expect(restored.y + restored.height).toBeGreaterThanOrEqual(48);
    expect(restored.y).toBeLessThanOrEqual(720 - 48);
    expect(restored.scaleFactor).toBe(2);
  });

  it("rejects stale or malformed versioned private layout state", () => {
    const layout = createDefaultWorkspaceLayout("a".repeat(64));
    expect(() => parseWorkspaceLayout({ ...layout, version: 2 }, layout.vaultId)).toThrow(
      "version 1",
    );
    expect(() => parseWorkspaceLayout(layout, "b".repeat(64))).toThrow("vault identity");
  });

  it("permits a closed pop-out to retain its last visible bounds", () => {
    const layout = createDefaultWorkspaceLayout("a".repeat(64));
    layout.popout = {
      state: "closed",
      viewType: null,
      filePath: null,
      bounds: { x: 4, y: 8, width: 640, height: 480, scaleFactor: 1 },
      warning: null,
    };
    expect(parseWorkspaceLayout(layout, layout.vaultId).popout.bounds).toEqual(
      layout.popout.bounds,
    );
  });

  it("enforces honest closed, open, and degraded pop-out states", () => {
    const layout = createDefaultWorkspaceLayout("a".repeat(64));
    expect(() =>
      parseWorkspaceLayout(
        {
          ...layout,
          popout: { ...layout.popout, state: "open", viewType: "drawing" },
        },
        layout.vaultId,
      ),
    ).toThrow("visible bounds");
    expect(() =>
      parseWorkspaceLayout(
        {
          ...layout,
          popout: { ...layout.popout, state: "degraded" },
        },
        layout.vaultId,
      ),
    ).toThrow("requires a warning");
    expect(() =>
      parseWorkspaceLayout(
        {
          ...layout,
          popout: { ...layout.popout, warning: "stale" },
        },
        layout.vaultId,
      ),
    ).toThrow("active view or warning");
  });
});
