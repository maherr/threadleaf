import path from "node:path";
import { describe, expect, it } from "vitest";
import { FixedStateRoot } from "../kernel/ports";
import type { NoteSaveResponse, RuntimeSnapshot, VaultSearchResponse } from "../shared/contracts";
import {
  type VaultSelectionStore,
  WorkspaceController,
  type WorkspaceRuntimeFactory,
  type WorkspaceRuntimePort,
} from "./workspace-controller";
import type { WorkspaceRuntimeOptions } from "./workspace-runtime";

class MemorySelectionStore implements VaultSelectionStore {
  value: string | null;
  readonly saved: string[] = [];
  loadError: Error | null = null;
  saveError: Error | null = null;
  loadCount = 0;

  constructor(value: string | null = null) {
    this.value = value;
  }

  async load(): Promise<string | null> {
    this.loadCount += 1;
    if (this.loadError) {
      throw this.loadError;
    }
    return this.value;
  }

  async save(vaultPath: string): Promise<void> {
    if (this.saveError) {
      throw this.saveError;
    }
    this.value = vaultPath;
    this.saved.push(vaultPath);
  }
}

function snapshotFor(options: WorkspaceRuntimeOptions, vaultPath: string, vaultId: string) {
  return {
    vault: {
      id: vaultId,
      name: path.basename(vaultPath),
      path: vaultPath,
      markdownFileCount: 0,
      mode: "kernel-backed",
      source: options.selectionSource ?? "direct",
      warning: options.warning ?? null,
    },
    plugin: null,
    commands: [],
    actions: [],
    notices: [],
    events: [],
  } satisfies RuntimeSnapshot;
}

class FakeRuntime implements WorkspaceRuntimePort {
  readonly vaultId: string;
  readonly vaultPath: string;
  readonly options: WorkspaceRuntimeOptions;
  readonly #snapshot: RuntimeSnapshot;
  readonly #listeners = new Set<(snapshot: RuntimeSnapshot) => void>();
  closed = false;

  constructor(options: WorkspaceRuntimeOptions) {
    this.options = options;
    this.vaultPath = path.resolve(options.vaultRoot);
    this.vaultId = `vault:${this.vaultPath}`;
    this.#snapshot = snapshotFor(options, this.vaultPath, this.vaultId);
  }

  async getSnapshot(): Promise<RuntimeSnapshot> {
    return this.#snapshot;
  }

  async searchVault(query: string): Promise<VaultSearchResponse> {
    return {
      vaultId: this.vaultId,
      indexGeneration: 1,
      error: null,
      query,
      terms: query ? [query] : [],
      total: 0,
      truncated: false,
      results: [],
    };
  }

  async openNote(): Promise<RuntimeSnapshot> {
    return this.#snapshot;
  }

  async saveNote(
    filePath: string,
    _content: string,
    _expectedRevision: string,
    _expectedVaultId: string,
  ): Promise<NoteSaveResponse> {
    return {
      outcome: {
        status: "committed",
        path: filePath,
        revision: "a".repeat(64),
        transactionId: "save",
      },
      snapshot: this.#snapshot,
    };
  }

  async runPluginCommand(): Promise<RuntimeSnapshot> {
    return this.#snapshot;
  }

  async reloadPlugin(): Promise<RuntimeSnapshot> {
    return this.#snapshot;
  }

  async unloadPlugin(): Promise<RuntimeSnapshot> {
    return this.#snapshot;
  }

  onSnapshot(listener: (snapshot: RuntimeSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(): void {
    for (const listener of this.#listeners) {
      listener(this.#snapshot);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.#listeners.clear();
  }
}

function runtimeHarness(failingPaths: string[] = []) {
  const runtimes: FakeRuntime[] = [];
  const optionsSeen: WorkspaceRuntimeOptions[] = [];
  const runtimeFactory: WorkspaceRuntimeFactory = async (options) => {
    optionsSeen.push(options);
    if (
      failingPaths
        .map((candidate) => path.resolve(candidate))
        .includes(path.resolve(options.vaultRoot))
    ) {
      throw new Error(`Unavailable vault: ${options.vaultRoot}`);
    }
    const runtime = new FakeRuntime(options);
    runtimes.push(runtime);
    return runtime;
  };
  return { runtimeFactory, runtimes, optionsSeen };
}

const fixtureVaultPath = "/fixtures/basic";
const stateRoot = new FixedStateRoot("/state");

describe("WorkspaceController", () => {
  it("gives an explicit environment vault priority without persisting it", async () => {
    const store = new MemorySelectionStore("/restored/vault");
    const harness = runtimeHarness();
    const controller = await WorkspaceController.open({
      stateRoot,
      selectionStore: store,
      fixtureVaultPath,
      fixturePluginDirectory: "/fixtures/basic/.obsidian/plugins/fixture",
      configuredVaultPath: "/configured/vault",
      configuredPluginDirectory: "/configured/vault/.obsidian/plugins/fixture",
      runtimeFactory: harness.runtimeFactory,
    });

    expect(store.loadCount).toBe(0);
    expect(store.saved).toEqual([]);
    expect(harness.optionsSeen[0]).toMatchObject({
      vaultRoot: "/configured/vault",
      selectionSource: "environment",
      pluginDirectory: "/configured/vault/.obsidian/plugins/fixture",
    });
    expect((await controller.getSnapshot()).vault.source).toBe("environment");
    await controller.close();
  });

  it("restores a saved vault without auto-loading a compatibility plugin", async () => {
    const store = new MemorySelectionStore("/restored/vault");
    const harness = runtimeHarness();
    const controller = await WorkspaceController.open({
      stateRoot,
      selectionStore: store,
      fixtureVaultPath,
      fixturePluginDirectory: "/fixtures/basic/.obsidian/plugins/fixture",
      runtimeFactory: harness.runtimeFactory,
    });

    expect(harness.optionsSeen[0]).toMatchObject({
      vaultRoot: "/restored/vault",
      selectionSource: "restored",
    });
    expect(harness.optionsSeen[0]?.pluginDirectory).toBeUndefined();
    expect((await controller.getSnapshot()).vault.warning).toBeNull();
    await controller.close();
  });

  it("fails loudly back to the bundled vault when restoration is unavailable", async () => {
    const store = new MemorySelectionStore("/missing/vault");
    const harness = runtimeHarness(["/missing/vault"]);
    const controller = await WorkspaceController.open({
      stateRoot,
      selectionStore: store,
      fixtureVaultPath,
      fixturePluginDirectory: "/fixtures/basic/.obsidian/plugins/fixture",
      runtimeFactory: harness.runtimeFactory,
    });

    const snapshot = await controller.getSnapshot();
    expect(harness.optionsSeen).toHaveLength(2);
    expect(snapshot.vault).toMatchObject({
      path: path.resolve(fixtureVaultPath),
      source: "bundled",
    });
    expect(snapshot.vault.warning).toContain("Could not restore /missing/vault");
    expect(store.value).toBe("/missing/vault");
    await controller.close();
  });

  it("fails loudly back to the bundled vault when saved selection state is malformed", async () => {
    const store = new MemorySelectionStore();
    store.loadError = new Error("invalid selection document");
    const harness = runtimeHarness();
    const controller = await WorkspaceController.open({
      stateRoot,
      selectionStore: store,
      fixtureVaultPath,
      fixturePluginDirectory: "/fixtures/basic/.obsidian/plugins/fixture",
      runtimeFactory: harness.runtimeFactory,
    });

    const snapshot = await controller.getSnapshot();
    expect(snapshot.vault).toMatchObject({
      path: path.resolve(fixtureVaultPath),
      source: "bundled",
    });
    expect(snapshot.vault.warning).toContain(
      "Could not read the saved vault selection: invalid selection document",
    );
    await controller.close();
  });

  it("validates and persists a picked vault before adopting it", async () => {
    const store = new MemorySelectionStore();
    const harness = runtimeHarness();
    const controller = await WorkspaceController.open({
      stateRoot,
      selectionStore: store,
      fixtureVaultPath,
      runtimeFactory: harness.runtimeFactory,
    });
    const previous = harness.runtimes[0];
    const observed: string[] = [];
    controller.onSnapshot((snapshot) => observed.push(snapshot.vault.path));

    const switched = await controller.switchVault("/picked/vault");

    expect(switched.vault).toMatchObject({
      path: "/picked/vault",
      source: "picked",
      warning: null,
    });
    expect(store.saved).toEqual(["/picked/vault"]);
    expect(previous?.closed).toBe(true);
    expect(observed).toEqual(["/picked/vault"]);
    harness.runtimes[1]?.emit();
    expect(observed).toEqual(["/picked/vault", "/picked/vault"]);
    previous?.emit();
    expect(observed).toEqual(["/picked/vault", "/picked/vault"]);
    await controller.close();
  });

  it("keeps the current runtime when persistence of a picked vault fails", async () => {
    const store = new MemorySelectionStore();
    store.saveError = new Error("selection store unavailable");
    const harness = runtimeHarness();
    const controller = await WorkspaceController.open({
      stateRoot,
      selectionStore: store,
      fixtureVaultPath,
      runtimeFactory: harness.runtimeFactory,
    });

    await expect(controller.switchVault("/picked/vault")).rejects.toThrow(
      "selection store unavailable",
    );
    expect(controller.vaultPath).toBe(path.resolve(fixtureVaultPath));
    expect(harness.runtimes[0]?.closed).toBe(false);
    expect(harness.runtimes[1]?.closed).toBe(true);
    await controller.close();
  });

  it("keeps the current runtime when a picked vault cannot open", async () => {
    const store = new MemorySelectionStore();
    const harness = runtimeHarness(["/missing/vault"]);
    const controller = await WorkspaceController.open({
      stateRoot,
      selectionStore: store,
      fixtureVaultPath,
      runtimeFactory: harness.runtimeFactory,
    });

    await expect(controller.switchVault("/missing/vault")).rejects.toThrow("Unavailable vault");
    expect(controller.vaultPath).toBe(path.resolve(fixtureVaultPath));
    expect(store.saved).toEqual([]);
    expect(harness.runtimes).toHaveLength(1);
    await controller.close();
  });
});
