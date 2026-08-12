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
});
