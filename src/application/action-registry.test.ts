import { describe, expect, it } from "vitest";
import { ActionRegistry } from "./action-registry";

describe("ActionRegistry", () => {
  it("dispatches one shared action path and releases only the registering owner", async () => {
    const registry = new ActionRegistry();
    const release = registry.register("workspace", {
      id: "workspace.open-note",
      name: "Open note",
      source: "workspace",
      execute: (payload) => `opened:${String(payload)}`,
    });

    await expect(registry.dispatch("workspace.open-note", "Note.md")).resolves.toBe(
      "opened:Note.md",
    );
    expect(registry.list()).toEqual([
      { id: "workspace.open-note", name: "Open note", source: "workspace" },
    ]);
    release();
    await expect(registry.dispatch("workspace.open-note", "Note.md")).rejects.toThrow(
      "Action is not available",
    );
  });

  it("rejects collisions across action sources", () => {
    const registry = new ActionRegistry();
    registry.register("plugin-a", {
      id: "shared-id",
      name: "Plugin action",
      source: "plugin",
      execute: () => undefined,
    });

    expect(() =>
      registry.register("workspace", {
        id: "shared-id",
        name: "Workspace action",
        source: "workspace",
        execute: () => undefined,
      }),
    ).toThrow("Action already registered");
  });
});
