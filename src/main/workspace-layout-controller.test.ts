import { describe, expect, it } from "vitest";
import {
  createDefaultWorkspaceLayout,
  type WorkspaceLayoutDocument,
  type WorkspaceLayoutSnapshot,
} from "../shared/workspace-layout";
import { WorkspaceLayoutController } from "./workspace-layout-controller";

const vaultId = "a".repeat(64);
const secondVaultId = "b".repeat(64);

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

class MemoryStore {
  readonly values = new Map<string, WorkspaceLayoutDocument>();
  failLoad = false;
  failSave = false;
  failSaveCount = 0;
  saveCount = 0;
  get value(): WorkspaceLayoutDocument | null {
    return this.values.get(vaultId) ?? null;
  }
  set value(layout: WorkspaceLayoutDocument | null) {
    if (layout) {
      this.values.set(layout.vaultId, structuredClone(layout));
    } else {
      this.values.delete(vaultId);
    }
  }
  async load(requestedVaultId: string): Promise<WorkspaceLayoutDocument | null> {
    if (this.failLoad) throw new Error("layout bytes malformed");
    const value = this.values.get(requestedVaultId);
    return value ? structuredClone(value) : null;
  }
  async save(layout: WorkspaceLayoutDocument): Promise<WorkspaceLayoutDocument> {
    this.saveCount += 1;
    if (this.failSaveCount > 0) {
      this.failSaveCount -= 1;
      throw new Error("layout disk unavailable");
    }
    if (this.failSave) throw new Error("layout disk unavailable");
    const saved = structuredClone(layout);
    this.values.set(layout.vaultId, saved);
    return structuredClone(saved);
  }
}

class DelayedStore extends MemoryStore {
  readonly firstSaveStarted = deferred();
  readonly releaseFirstSave = deferred();
  #saveCount = 0;

  override async save(layout: WorkspaceLayoutDocument): Promise<WorkspaceLayoutDocument> {
    if (this.#saveCount === 0) {
      this.#saveCount += 1;
      this.firstSaveStarted.resolve();
      await this.releaseFirstSave.promise;
    } else {
      this.#saveCount += 1;
    }
    return super.save(layout);
  }
}

const bounds = {
  x: 12,
  y: 24,
  width: 720,
  height: 560,
  scaleFactor: 1,
} as const;

const openPopout = {
  state: "open",
  viewType: "drawing",
  filePath: "Drawing.md",
  bounds: { x: 40, y: 50, width: 820, height: 620, scaleFactor: 1 },
  warning: null,
} as const;

type MutationName = "left" | "right" | "bounds" | "popout";
type Mutation = (
  controller: WorkspaceLayoutController,
  expectedVaultId: string,
) => Promise<WorkspaceLayoutSnapshot>;

const mutations: Record<MutationName, Mutation> = {
  left: (controller, expectedVaultId) => controller.setDockCollapsed("left", true, expectedVaultId),
  right: (controller, expectedVaultId) =>
    controller.setDockCollapsed("right", true, expectedVaultId),
  bounds: (controller, expectedVaultId) => controller.setMainWindowBounds(bounds, expectedVaultId),
  popout: (controller, expectedVaultId) => controller.setPopout(openPopout, expectedVaultId),
};

function expectedLayout(...names: MutationName[]): WorkspaceLayoutDocument {
  const layout = createDefaultWorkspaceLayout(vaultId);
  for (const name of names) {
    if (name === "left") layout.docks.left.collapsed = true;
    if (name === "right") layout.docks.right.collapsed = true;
    if (name === "bounds") layout.mainWindowBounds = { ...bounds };
    if (name === "popout") layout.popout = structuredClone(openPopout);
  }
  return layout;
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
      version: 2,
      vaultId,
      docks: { left: { collapsed: true } },
      popout: { state: "open", viewType: "drawing", filePath: "Drawing.md" },
    });
    await expect(controller.setDockCollapsed("right", true, "b".repeat(64))).rejects.toThrow(
      "active vault changed",
    );
  });

  it("persists normalized navigator expansion paths per vault", async () => {
    const store = new MemoryStore();
    const controller = new WorkspaceLayoutController({ store });
    await controller.activateVault(vaultId);

    const saved = await controller.setNavigatorExpandedPaths(
      ["Projects/Research", "Archive"],
      vaultId,
    );
    expect(saved.navigator.expandedFolderPaths).toEqual(["Archive", "Projects/Research"]);
    expect(store.values.get(vaultId)?.navigator.expandedFolderPaths).toEqual([
      "Archive",
      "Projects/Research",
    ]);

    await expect(controller.setNavigatorExpandedPaths([".private"], vaultId)).rejects.toThrow(
      "hidden or traversal",
    );
    expect(controller.snapshot().navigator.expandedFolderPaths).toEqual([
      "Archive",
      "Projects/Research",
    ]);

    await controller.activateVault(secondVaultId);
    expect(controller.snapshot().navigator.expandedFolderPaths).toEqual([]);
    await controller.activateVault(vaultId);
    expect(controller.snapshot().navigator.expandedFolderPaths).toEqual([
      "Archive",
      "Projects/Research",
    ]);
  });

  it("persists a deep navigator reveal chain with one layout write", async () => {
    const store = new MemoryStore();
    const controller = new WorkspaceLayoutController({ store });
    await controller.activateVault(vaultId);
    const paths = Array.from({ length: 128 }, (_, index) =>
      Array.from({ length: index + 1 }, (_, segment) => `Depth-${segment}`.padEnd(12, "0")).join(
        "/",
      ),
    );

    const saved = await controller.setNavigatorExpandedPaths(paths, vaultId);

    expect(saved.navigator.expandedFolderPaths).toEqual([...paths].sort());
    expect(store.saveCount).toBe(1);
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

  for (const first of Object.keys(mutations) as MutationName[]) {
    for (const second of Object.keys(mutations) as MutationName[]) {
      it(`serializes ${first} followed by ${second} from the latest layout`, async () => {
        const store = new DelayedStore();
        const controller = new WorkspaceLayoutController({
          store,
          supportedPopoutViewTypes: ["drawing"],
        });
        await controller.activateVault(vaultId);

        const firstWrite = mutations[first](controller, vaultId);
        await store.firstSaveStarted.promise;
        const secondWrite = mutations[second](controller, vaultId);
        store.releaseFirstSave.resolve();
        await Promise.all([firstWrite, secondWrite]);

        expect(store.value).toEqual(expectedLayout(first, second));
      });
    }
  }

  it("retains all independent fields when every mutation overlaps the first delayed save", async () => {
    const store = new DelayedStore();
    const controller = new WorkspaceLayoutController({
      store,
      supportedPopoutViewTypes: ["drawing"],
    });
    await controller.activateVault(vaultId);

    const firstWrite = mutations.left(controller, vaultId);
    await store.firstSaveStarted.promise;
    const rightWrite = mutations.right(controller, vaultId);
    const boundsWrite = mutations.bounds(controller, vaultId);
    const popoutWrite = mutations.popout(controller, vaultId);
    store.releaseFirstSave.resolve();
    await Promise.all([firstWrite, rightWrite, boundsWrite, popoutWrite]);

    expect(store.value).toEqual(expectedLayout("left", "right", "bounds", "popout"));
  });

  it("recovers the queue after a failed save without adopting or dropping a later mutation", async () => {
    const store = new DelayedStore();
    const controller = new WorkspaceLayoutController({ store });
    await controller.activateVault(vaultId);
    store.failSaveCount = 1;

    const failedWrite = mutations.left(controller, vaultId);
    await store.firstSaveStarted.promise;
    const recoveredWrite = mutations.right(controller, vaultId);
    store.releaseFirstSave.resolve();

    await expect(failedWrite).rejects.toThrow("layout disk unavailable");
    await recoveredWrite;
    expect(store.value).toEqual(expectedLayout("right"));

    await controller.setDockCollapsed("left", true, vaultId);
    expect(store.value).toEqual(expectedLayout("right", "left"));
  });

  it("returns each queued response for its own vault and never lets an old write adopt the new vault", async () => {
    const store = new DelayedStore();
    const secondLayout = createDefaultWorkspaceLayout(secondVaultId);
    secondLayout.docks.right.collapsed = true;
    store.value = secondLayout;
    const controller = new WorkspaceLayoutController({ store });
    await controller.activateVault(vaultId);

    const firstWrite = mutations.left(controller, vaultId);
    await store.firstSaveStarted.promise;
    const switchVault = controller.activateVault(secondVaultId);
    store.releaseFirstSave.resolve();

    const [updated, switched] = await Promise.all([firstWrite, switchVault]);
    expect(updated.vaultId).toBe(vaultId);
    expect(updated.docks.left.collapsed).toBe(true);
    expect(switched.vaultId).toBe(secondVaultId);
    expect(controller.snapshot().vaultId).toBe(secondVaultId);
    expect(store.values.get(vaultId)?.docks.left.collapsed).toBe(true);
    expect(store.values.get(secondVaultId)).toEqual(secondLayout);
  });

  it("rejects a stale mutation queued after a vault switch without touching the new vault", async () => {
    const store = new MemoryStore();
    const secondLayout = createDefaultWorkspaceLayout(secondVaultId);
    secondLayout.docks.right.collapsed = true;
    store.value = secondLayout;
    const controller = new WorkspaceLayoutController({ store });
    await controller.activateVault(vaultId);

    const switchVault = controller.activateVault(secondVaultId);
    const staleWrite = controller.setDockCollapsed("left", true, vaultId);
    await switchVault;

    await expect(staleWrite).rejects.toThrow("active vault changed");
    expect(controller.snapshot().vaultId).toBe(secondVaultId);
    expect(store.values.get(secondVaultId)).toEqual(secondLayout);
  });
});
