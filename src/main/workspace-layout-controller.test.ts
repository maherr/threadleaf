import { describe, expect, it } from "vitest";
import {
  createDefaultWorkspaceLayout,
  type WorkspaceLayoutDocument,
} from "../shared/workspace-layout";
import { WorkspaceLayoutController } from "./workspace-layout-controller";

const vaultId = "a".repeat(64);

class MemoryStore {
  value: WorkspaceLayoutDocument | null = null;
  failLoad = false;
  failSave = false;
  async load(): Promise<WorkspaceLayoutDocument | null> {
    if (this.failLoad) throw new Error("layout bytes malformed");
    return this.value;
  }
  async save(layout: WorkspaceLayoutDocument): Promise<WorkspaceLayoutDocument> {
    if (this.failSave) throw new Error("layout disk unavailable");
    this.value = structuredClone(layout);
    return this.value;
  }
}

describe("WorkspaceLayoutController", () => {
  it("keeps dock and pop-out state versioned and vault-bound", async () => {
    const store = new MemoryStore();
    const controller = new WorkspaceLayoutController({
      store,
      supportedPopoutViewTypes: ["drawing"],
    });
    await controller.activateVault(vaultId);
    await controller.setDockCollapsed("left", true, vaultId);
    await controller.setPopout(
      {
        state: "open",
        viewType: "drawing",
        filePath: "Drawing.md",
        bounds: { x: 4, y: 8, width: 720, height: 560, scaleFactor: 1 },
        warning: null,
      },
      vaultId,
    );
    expect(controller.snapshot()).toMatchObject({
      version: 1,
      vaultId,
      docks: { left: { collapsed: true } },
      popout: { state: "open", viewType: "drawing", filePath: "Drawing.md" },
    });
    await expect(controller.setDockCollapsed("right", true, "b".repeat(64))).rejects.toThrow(
      "active vault changed",
    );
  });

  it("degrades unavailable saved views without rewriting malformed bytes", async () => {
    const store = new MemoryStore();
    const initial = createDefaultWorkspaceLayout(vaultId);
    initial.popout = {
      state: "open",
      viewType: "future-view",
      filePath: "Future.md",
      bounds: { x: 0, y: 0, width: 640, height: 480, scaleFactor: 1 },
      warning: null,
    };
    store.value = initial;
    const controller = new WorkspaceLayoutController({
      store,
      supportedPopoutViewTypes: ["drawing"],
    });
    const snapshot = await controller.activateVault(vaultId);
    expect(snapshot.popout).toMatchObject({ state: "degraded", viewType: "future-view" });
    expect(store.value?.popout.viewType).toBe("future-view");
    store.failLoad = true;
    const second = await controller.activateVault(vaultId);
    expect(second.docks.left.state).toBe("degraded");
  });

  it("does not report a persisted pop-out as live after process restart", async () => {
    const store = new MemoryStore();
    const initial = createDefaultWorkspaceLayout(vaultId);
    initial.popout = {
      state: "open",
      viewType: "drawing",
      filePath: "Drawing.md",
      bounds: { x: 4, y: 8, width: 720, height: 560, scaleFactor: 1 },
      warning: null,
    };
    store.value = initial;
    const controller = new WorkspaceLayoutController({
      store,
      supportedPopoutViewTypes: ["drawing"],
    });

    expect((await controller.activateVault(vaultId)).popout).toMatchObject({
      state: "degraded",
      viewType: "drawing",
      filePath: "Drawing.md",
      warning: expect.stringContaining("Threadleaf restarted"),
    });
    expect(store.value).toEqual(initial);
  });

  it("does not adopt a failed private layout write", async () => {
    const store = new MemoryStore();
    const controller = new WorkspaceLayoutController({ store });
    await controller.activateVault(vaultId);
    store.failSave = true;
    await expect(controller.setDockCollapsed("left", true, vaultId)).rejects.toThrow(
      "layout disk unavailable",
    );
    expect(controller.snapshot().docks.left.collapsed).toBe(false);
  });
});
