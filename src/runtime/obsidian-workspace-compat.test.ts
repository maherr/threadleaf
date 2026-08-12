import { describe, expect, it } from "vitest";
import { Workspace } from "./obsidian-workspace-compat";

describe("Obsidian compatibility workspace lifecycle", () => {
  it("awaits startup callbacks and callbacks registered after layout readiness", async () => {
    const workspace = new Workspace();
    const events: string[] = [];
    workspace.onLayoutReady(async () => {
      await Promise.resolve();
      events.push("initial");
    });

    await workspace.markLayoutReady();
    expect(events).toEqual(["initial"]);

    workspace.onLayoutReady(async () => {
      await Promise.resolve();
      events.push("late");
    });
    await workspace.waitForLayoutReadyCallbacks();

    expect(events).toEqual(["initial", "late"]);
  });

  it("reports a callback failure once without poisoning later callbacks", async () => {
    const workspace = new Workspace();
    workspace.onLayoutReady(() => {
      throw new Error("fixture startup failure");
    });

    await expect(workspace.markLayoutReady()).rejects.toThrow("fixture startup failure");

    let lateCallbackRan = false;
    workspace.onLayoutReady(() => {
      lateCallbackRan = true;
    });
    await expect(workspace.waitForLayoutReadyCallbacks()).resolves.toBeUndefined();
    expect(lateCallbackRan).toBe(true);
  });

  it("detaches every leaf of one view type without touching other views", () => {
    const workspace = new Workspace();
    const detached: string[] = [];
    const createLeaf = (id: string, viewType: string) => {
      let release = () => {};
      const leaf = {
        id,
        view: { getViewType: () => viewType },
        detach: () => {
          detached.push(id);
          release();
        },
      };
      release = workspace.registerLeaf(leaf);
      return leaf;
    };
    createLeaf("drawing-one", "excalidraw");
    createLeaf("markdown", "markdown");
    createLeaf("drawing-two", "excalidraw");

    workspace.detachLeavesOfType("excalidraw");

    expect(detached).toEqual(["drawing-one", "drawing-two"]);
    expect(workspace.getLeavesOfType("excalidraw")).toEqual([]);
    expect(workspace.getLeavesOfType("markdown")).toHaveLength(1);
  });
});
