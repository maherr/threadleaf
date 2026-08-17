import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import moment from "moment";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FixedStateRoot } from "../kernel/ports";
import { type KernelFaultInjector, VaultKernel } from "../kernel/vault-kernel";
import type { PluginRuntimePort } from "../runtime/plugin-runtime-port";
import { MAX_VAULT_ATTACHMENT_BYTES } from "../shared/attachment-limits";
import type { RuntimeSnapshot } from "../shared/contracts";
import { createDefaultVaultNoteWorkflowSettings } from "../shared/note-workflows";
import { WorkspaceOpenDiagnostics } from "../shared/workspace-open-diagnostics";
import type { VaultWorkspaceSettings } from "../shared/workspace-settings";
import {
  testConstructionRequest,
  testPluginRuntimeFactory,
} from "../test-support/plugin-construction";
import {
  absenceConfirmationIntervalMs,
  maximumAbsenceConfirmationAttempts,
  startupAbsenceMaximumSettleMs,
  startupAbsenceSettleMs,
  transientAbsenceSettleMs,
  WorkspaceRuntime,
} from "./workspace-runtime";
import {
  createWorkspaceLayout,
  type PersistedWorkspaceState,
  parseWorkspaceState,
  type WorkspaceStateStore,
  workspaceStatesEqual,
} from "./workspace-state";

const fixtureVault = path.resolve("fixtures/vaults/basic");
let sandboxPath: string;
let vaultPath: string;
let statePath: string;
let runtime: WorkspaceRuntime | undefined;

class MemoryWorkspaceStateStore implements WorkspaceStateStore {
  value: PersistedWorkspaceState | null = null;
  readonly saved: PersistedWorkspaceState[] = [];
  loadError: Error | null = null;
  saveError: Error | null = null;
  beforeSave: (() => Promise<void>) | null = null;
  #writeTail: Promise<void> = Promise.resolve();
  readonly #initial: {
    openPaths: string[];
    pinnedPaths?: string[];
    activePath: string | null;
  } | null;

  constructor(
    initial: {
      openPaths: string[];
      pinnedPaths?: string[];
      activePath: string | null;
    } | null = null,
  ) {
    this.#initial = initial;
  }

  async load(vaultId: string): Promise<PersistedWorkspaceState | null> {
    if (this.loadError) {
      throw this.loadError;
    }
    if (this.value) {
      return parseWorkspaceState(this.value, vaultId);
    }
    return this.#initial
      ? createWorkspaceLayout(
          vaultId,
          [
            {
              id: "primary",
              openPaths: this.#initial.openPaths,
              ...(this.#initial.pinnedPaths ? { pinnedPaths: this.#initial.pinnedPaths } : {}),
              activePath: this.#initial.activePath,
            },
          ],
          "primary",
          null,
        )
      : null;
  }

  async save(
    state: PersistedWorkspaceState,
    expectedCurrent?: PersistedWorkspaceState | null,
  ): Promise<PersistedWorkspaceState> {
    const normalized = createWorkspaceLayout(
      state.vaultId,
      state.panes,
      state.activePaneId,
      state.splitDirection,
    );
    const write = this.#writeTail
      .catch(() => undefined)
      .then(async () => {
        if (this.saveError) {
          throw this.saveError;
        }
        await this.beforeSave?.();
        const stored =
          this.value ??
          (this.#initial
            ? createWorkspaceLayout(
                state.vaultId,
                [
                  {
                    id: "primary",
                    openPaths: this.#initial.openPaths,
                    ...(this.#initial.pinnedPaths
                      ? { pinnedPaths: this.#initial.pinnedPaths }
                      : {}),
                    activePath: this.#initial.activePath,
                  },
                ],
                "primary",
                null,
              )
            : null);
        if (
          expectedCurrent !== undefined &&
          ((stored === null) !== (expectedCurrent === null) ||
            (stored !== null &&
              expectedCurrent !== null &&
              !workspaceStatesEqual(stored, expectedCurrent)))
        ) {
          throw new Error("Threadleaf workspace state changed before it could be saved.");
        }
        this.value = normalized;
        this.saved.push(normalized);
      });
    this.#writeTail = write.then(
      () => undefined,
      () => undefined,
    );
    await write;
    return normalized;
  }
}

class BlockingWorkspaceStateStore implements WorkspaceStateStore {
  readonly inner = new MemoryWorkspaceStateStore();
  #gate: Promise<void> | null = null;
  #releaseGate: (() => void) | null = null;
  #saveCount = 0;
  #saveCountWaiters = new Map<number, Array<() => void>>();

  async load(vaultId: string): Promise<PersistedWorkspaceState | null> {
    return this.inner.load(vaultId);
  }

  blockSaves(): void {
    this.#gate = new Promise<void>((resolve) => {
      this.#releaseGate = resolve;
    });
  }

  releaseSaves(): void {
    this.#releaseGate?.();
    this.#gate = null;
    this.#releaseGate = null;
  }

  resetSaveCount(): void {
    this.#saveCount = 0;
  }

  async waitForSaveCount(target: number): Promise<void> {
    if (this.#saveCount >= target) {
      return;
    }
    // Bounded and rejecting: an unbounded wait made every race test that
    // uses this store fail at vitest's global default under machine load,
    // with the timeout blamed on whichever assertion happened to be next.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`waitForSaveCount(${target}) still at ${this.#saveCount} after 15000ms`));
      }, 15_000);
      const waiters = this.#saveCountWaiters.get(target) ?? [];
      waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
      this.#saveCountWaiters.set(target, waiters);
    });
  }

  async save(
    state: PersistedWorkspaceState,
    expectedCurrent?: PersistedWorkspaceState | null,
  ): Promise<PersistedWorkspaceState> {
    this.#saveCount += 1;
    for (const [target, waiters] of this.#saveCountWaiters) {
      if (this.#saveCount >= target) {
        for (const resolve of waiters) {
          resolve();
        }
        this.#saveCountWaiters.delete(target);
      }
    }
    const gate = this.#gate;
    if (gate) {
      await gate;
    }
    return this.inner.save(state, expectedCurrent);
  }
}

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-workspace-"));
  vaultPath = path.join(sandboxPath, "vault");
  statePath = path.join(sandboxPath, "state");
  await fs.cp(fixtureVault, vaultPath, { recursive: true });
});

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

/**
 * The clock the absence settle windows are measured against.
 *
 * A test that has to prove either side of a window drives this instead of
 * sleeping, so its result says which side of the boundary the behaviour is on
 * rather than how quickly this machine happened to get through the passes.
 */
function manualClock(start = Date.now()): { now: () => number; advance: (ms: number) => void } {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

async function openRuntime(
  workspaceStateStore?: WorkspaceStateStore,
  workspaceSettings?: Partial<VaultWorkspaceSettings>,
  beforeWorkspaceStateRestore?: (vaultId: string) => Promise<void>,
  faultInjector?: KernelFaultInjector,
  now?: () => number,
): Promise<WorkspaceRuntime> {
  const pluginDirectory = path.join(vaultPath, ".obsidian", "plugins", "threadleaf-fixture");
  runtime = await WorkspaceRuntime.open({
    vaultRoot: vaultPath,
    stateRoot: new FixedStateRoot(statePath),
    pluginConstructionRequest: await testConstructionRequest(pluginDirectory),
    pluginRuntimeFactory: testPluginRuntimeFactory,
    ...(workspaceStateStore ? { workspaceStateStore } : {}),
    ...(beforeWorkspaceStateRestore ? { beforeWorkspaceStateRestore } : {}),
    ...(faultInjector ? { faultInjector } : {}),
    ...(now ? { now } : {}),
    ...(workspaceSettings
      ? {
          workspaceSettings: {
            defaultNoteFolder: "",
            linkStyle: "preserve",
            automaticLinkUpdates: "ask",
            confirmDelete: "always",
            newTabBehavior: "focus",
            editorMode: "live",
            documentView: "live",
            restorePolicy: "restore",
            ...workspaceSettings,
          },
        }
      : {}),
  });
  return runtime;
}

describe("WorkspaceRuntime", () => {
  it("keeps the interactive workspace payload bounded independently of corpus size", async () => {
    await Promise.all(
      Array.from({ length: 600 }, (_, index) =>
        fs.writeFile(
          path.join(vaultPath, `Payload-${index.toString().padStart(3, "0")}.md`),
          `# Payload ${index}\n`,
          "utf8",
        ),
      ),
    );
    const workspace = await openRuntime();

    const snapshot = await workspace.getSnapshot();
    const filePage = snapshot.workspace?.filePage;

    expect(snapshot.workspace?.files.length).toBeLessThanOrEqual(256);
    expect(filePage).toMatchObject({ total: 602, complete: false });
    expect(snapshot.workspace?.census).toMatchObject({
      state: "current",
      generation: 1,
      discovered: 602,
      indexed: 602,
      total: 602,
    });
    expect(snapshot.vault.markdownFileCount).toBe(602);
    await expect(
      workspace.getWorkspaceFilePage({
        expectedVaultId: workspace.vaultId,
        generation: filePage?.generation ?? "missing",
        offset: 0,
        limit: 200,
        query: "payload 599",
      }),
    ).resolves.toMatchObject({
      status: "ready",
      page: { total: 1, complete: true },
      files: [{ path: "Payload-599.md", title: "Payload-599" }],
    });
    const boundedQuickSwitcher = await workspace.getWorkspaceFilePage({
      expectedVaultId: workspace.vaultId,
      generation: filePage?.generation ?? "missing",
      offset: 0,
      limit: 200,
      query: "",
    });
    expect(boundedQuickSwitcher.status).toBe("ready");
    if (boundedQuickSwitcher.status === "ready") {
      expect(boundedQuickSwitcher.files).toHaveLength(200);
    }
  });

  it("invalidates file-page generations across direct create, rename, and delete mutations", async () => {
    const workspace = await openRuntime();
    await workspace.watcher.close();
    const before = await workspace.getSnapshot();
    const generation = before.workspace?.filePage.generation;
    const censusGeneration = before.workspace?.census.generation ?? Number.NaN;
    expect(generation).toEqual(expect.any(String));
    const created = await workspace.createNote(
      "Generation-change.md",
      "# Changed\n",
      workspace.vaultId,
    );
    expect(created.snapshot.workspace).toMatchObject({
      census: {
        generation: censusGeneration + 1,
        discovered: 3,
        indexed: 3,
        total: 3,
      },
      filePage: { generation: expect.any(String), total: 3 },
    });
    expect(created.snapshot.vault.markdownFileCount).toBe(3);
    expect(created.snapshot.workspace?.indexGeneration).not.toBe(generation);

    await expect(
      workspace.getWorkspaceFilePage({
        expectedVaultId: workspace.vaultId,
        generation: generation ?? "missing",
        offset: 0,
        limit: 64,
      }),
    ).resolves.toMatchObject({ status: "stale-generation" });

    const createdNote = created.snapshot.workspace?.activeNote;
    const createdGeneration = created.snapshot.workspace?.filePage.generation;
    if (!createdNote || !createdGeneration)
      throw new Error("Expected the created note generation.");
    const moved = await workspace.moveNote(
      createdNote.path,
      "Generation-renamed.md",
      createdNote.revision,
      workspace.vaultId,
    );
    expect(moved.outcome).toMatchObject({
      status: "committed",
      from: "Generation-change.md",
      to: "Generation-renamed.md",
    });
    expect(moved.snapshot.workspace).toMatchObject({
      census: {
        generation: censusGeneration + 1,
        discovered: 3,
        indexed: 3,
        total: 3,
      },
      filePage: { total: 3 },
      activeNote: { path: "Generation-renamed.md" },
    });
    expect(moved.snapshot.workspace?.indexGeneration).not.toBe(createdGeneration);
    await expect(
      workspace.getWorkspaceFilePage({
        expectedVaultId: workspace.vaultId,
        generation: createdGeneration,
        offset: 0,
        limit: 64,
      }),
    ).resolves.toMatchObject({ status: "stale-generation" });

    const movedNote = moved.snapshot.workspace?.activeNote;
    const movedGeneration = moved.snapshot.workspace?.filePage.generation;
    if (!movedNote || !movedGeneration) throw new Error("Expected the renamed note generation.");
    const deleted = await workspace.deleteNote(
      movedNote.path,
      movedNote.revision,
      workspace.vaultId,
    );
    expect(deleted.outcome).toMatchObject({ status: "committed" });
    expect(deleted.snapshot.workspace).toMatchObject({
      census: {
        generation: censusGeneration + 2,
        discovered: 2,
        indexed: 2,
        total: 2,
      },
      filePage: { total: 2 },
    });
    expect(deleted.snapshot.vault.markdownFileCount).toBe(2);
    await expect(
      workspace.getWorkspaceFilePage({
        expectedVaultId: workspace.vaultId,
        generation: movedGeneration,
        offset: 0,
        limit: 64,
      }),
    ).resolves.toMatchObject({ status: "stale-generation" });

    const current = await workspace.getWorkspaceFilePage({
      expectedVaultId: workspace.vaultId,
      generation: deleted.snapshot.workspace?.filePage.generation ?? "missing",
      offset: 0,
      limit: 64,
    });
    expect(current).toMatchObject({ status: "ready", page: { total: 2 } });
  });

  it("retries an asynchronously assembled snapshot after the index generation advances", async () => {
    const workspace = await openRuntime();
    await workspace.watcher.close();
    const before = await workspace.getSnapshot();
    const activePath = before.workspace?.activeNote?.path;
    if (!activePath) throw new Error("Expected an active note before the snapshot race.");

    const originalReadText = workspace.kernel.readText.bind(workspace.kernel);
    let releaseRead: () => void = () => undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let markReadStarted: () => void = () => undefined;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    let blockFirstActiveRead = true;
    vi.spyOn(workspace.kernel, "readText").mockImplementation(async (filePath) => {
      if (blockFirstActiveRead && filePath === activePath) {
        blockFirstActiveRead = false;
        markReadStarted();
        await readGate;
      }
      return originalReadText(filePath);
    });

    const pending = workspace.getSnapshot();
    await readStarted;
    let created: Awaited<ReturnType<WorkspaceRuntime["createNote"]>>;
    try {
      created = await workspace.createNote(
        "Concurrent-snapshot.md",
        "# Concurrent snapshot\n",
        workspace.vaultId,
      );
    } finally {
      releaseRead();
    }
    const assembled = await pending;

    expect(created.outcome).toMatchObject({
      status: "committed",
      path: "Concurrent-snapshot.md",
    });
    expect(assembled.workspace).toMatchObject({
      indexGeneration: created.snapshot.workspace?.indexGeneration,
      filePage: { total: created.snapshot.workspace?.filePage.total },
      census: created.snapshot.workspace?.census,
      activeNote: { path: "Concurrent-snapshot.md" },
    });
  });

  it("refreshes metadata when active note bytes move ahead of the captured index", async () => {
    const workspace = await openRuntime();
    await workspace.watcher.close();
    const before = await workspace.getSnapshot();
    const activeNote = before.workspace?.activeNote;
    if (!activeNote) throw new Error("Expected an active note before the external edit.");
    const content = "# Externally changed\n\n#external-refresh\n";

    await fs.writeFile(path.join(vaultPath, activeNote.path), content, "utf8");
    const refreshed = await workspace.getSnapshot();

    expect(refreshed.workspace?.indexGeneration).not.toBe(before.workspace?.indexGeneration);
    expect(refreshed.workspace?.activeNote).toMatchObject({
      path: activeNote.path,
      content,
      tags: ["external-refresh"],
      headings: [{ level: 1, text: "Externally changed", line: 1 }],
    });
    expect(refreshed.workspace?.activeNote?.revision).not.toBe(activeNote.revision);
  });

  it("pages the physical Files tree with exact typed rows and explicit missing parents", async () => {
    const workspace = await openRuntime();
    await workspace.createNote("Projects/2", "# Two\n", workspace.vaultId);
    await workspace.createNote("Projects/مرحبا/10", "# Ten\n", workspace.vaultId);
    await workspace.createPluginFile(
      "Projects/image.PNG",
      new Uint8Array([1, 2, 3]),
      workspace.vaultId,
    );
    await workspace.createPluginFolder("Empty", workspace.vaultId);
    const snapshot = await workspace.getSnapshot();
    const generation = snapshot.workspace?.inventory.generation;
    expect(generation).toEqual(expect.any(String));
    expect(snapshot.workspace?.inventory).toMatchObject({
      state: "current",
      fileCount: 6,
      folderCount: 4,
    });

    const root = await workspace.getWorkspaceTreePage({
      expectedVaultId: workspace.vaultId,
      generation: generation ?? "missing",
      parentPath: null,
      offset: 0,
      limit: 256,
    });
    expect(root).toMatchObject({
      status: "ready",
      page: { parentPath: null },
      entries: expect.arrayContaining([
        { kind: "folder", path: "Boards", title: "Boards", childCount: 1 },
        { kind: "folder", path: "Empty", title: "Empty", childCount: 0 },
        { kind: "folder", path: "Projects", title: "Projects", childCount: 3 },
      ]),
    });
    if (root.status !== "ready") throw new Error("Expected a ready root Files page.");
    for (const entry of root.entries) {
      expect(Object.keys(entry).sort()).toEqual(
        entry.kind === "folder"
          ? ["childCount", "kind", "path", "title"]
          : ["kind", "path", "title"],
      );
    }

    const projects = await workspace.getWorkspaceTreePage({
      expectedVaultId: workspace.vaultId,
      generation: generation ?? "missing",
      parentPath: "Projects",
      offset: 0,
      limit: 256,
    });
    expect(projects).toMatchObject({
      status: "ready",
      entries: [
        { kind: "folder", path: "Projects/مرحبا", title: "مرحبا", childCount: 1 },
        { kind: "note", path: "Projects/2.md", title: "2" },
        { kind: "file", path: "Projects/image.PNG", title: "image.PNG" },
      ],
    });

    await expect(
      workspace.getWorkspaceTreePage({
        expectedVaultId: workspace.vaultId,
        generation: generation ?? "missing",
        parentPath: "Boards",
        offset: 0,
        limit: 256,
      }),
    ).resolves.toMatchObject({
      status: "ready",
      entries: [{ kind: "canvas", path: "Boards/Overview.canvas", title: "Overview" }],
    });

    await expect(
      workspace.getWorkspaceTreePage({
        expectedVaultId: workspace.vaultId,
        generation: generation ?? "missing",
        parentPath: "Missing",
        offset: 0,
        limit: 256,
      }),
    ).resolves.toEqual({
      status: "missing-parent",
      vaultId: workspace.vaultId,
      generation,
      parentPath: "Missing",
    });

    await expect(
      workspace.getWorkspaceTreePath({
        expectedVaultId: workspace.vaultId,
        generation: generation ?? "missing",
        path: "Projects/مرحبا/10.md",
      }),
    ).resolves.toMatchObject({
      status: "ready",
      location: {
        path: "Projects/مرحبا/10.md",
        pages: [
          { parentPath: null, offset: expect.any(Number) },
          { parentPath: "Projects", offset: expect.any(Number) },
          { parentPath: "Projects/مرحبا", offset: expect.any(Number) },
        ],
      },
    });
    await expect(
      workspace.getWorkspaceTreePage({
        expectedVaultId: workspace.vaultId,
        generation: generation ?? "missing",
        parentPath: ".obsidian",
        offset: 0,
        limit: 1,
      }),
    ).rejects.toThrow("bounded public");
  });

  it("loads the all-tag catalog lazily and rejects a stale generation", async () => {
    const workspace = await openRuntime();
    await workspace.createNote(
      "Tagged",
      "---\ntags: [Project/Alpha]\n---\n#project/Beta #PROJECT\n",
      workspace.vaultId,
    );
    // The lazy-catalog contract is independent of watcher scheduling. Quiesce
    // the watcher before capturing the ready token, then advance that token
    // deliberately with the direct create below.
    await workspace.watcher.close();
    const snapshot = await workspace.getSnapshot();
    const generation = snapshot.workspace?.indexGeneration ?? "missing";
    expect(JSON.stringify(snapshot.workspace)).not.toContain("directCount");

    await expect(
      workspace.getWorkspaceTagCatalog({
        expectedVaultId: workspace.vaultId,
        generation,
      }),
    ).resolves.toMatchObject({
      status: "ready",
      generation,
      tags: [
        { key: "project", tag: "Project", directCount: 1, count: 3 },
        {
          key: "project/alpha",
          tag: "Project/Alpha",
          parentKey: "project",
          directCount: 1,
          count: 1,
        },
        {
          key: "project/beta",
          tag: "project/Beta",
          parentKey: "project",
          directCount: 1,
          count: 1,
        },
      ],
    });

    await workspace.createNote("New-tag", "#external", workspace.vaultId);
    await expect(
      workspace.getWorkspaceTagCatalog({
        expectedVaultId: workspace.vaultId,
        generation,
      }),
    ).resolves.toMatchObject({ status: "stale-generation" });
  });

  it("keeps an uncensused restored active tab selected in its waiting state", async () => {
    const store = new MemoryWorkspaceStateStore({
      openPaths: ["Welcome.md", "Not-arrived.md"],
      pinnedPaths: ["Not-arrived.md"],
      activePath: "Not-arrived.md",
    });
    let releaseCensus: (() => void) | undefined;
    const censusGate = new Promise<void>((resolve) => {
      releaseCensus = resolve;
    });
    const diagnostics = new WorkspaceOpenDiagnostics();
    runtime = await WorkspaceRuntime.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
      workspaceStateStore: store,
      diagnostics,
      ...({
        deferWorkspaceCensus: true,
        beforeBackgroundCensus: () => censusGate,
      } as Record<string, unknown>),
    });
    try {
      const warming = await runtime.getSnapshot();

      expect(warming.workspace?.state).toBe("warming");
      expect(warming.workspace?.tabs).toContainEqual(
        expect.objectContaining({ path: "Not-arrived.md", active: true, pinned: true }),
      );
      expect(warming.workspace?.activeUnavailable).toMatchObject({ path: "Not-arrived.md" });
      const warmingGeneration = warming.workspace?.filePage.generation;
      releaseCensus?.();
      await runtime.waitForCensusCompletion();
      const current = await runtime.getSnapshot();

      expect(current.workspace).toMatchObject({
        state: "ready",
        census: { state: "current", total: 2, indexed: 2 },
        filePage: { total: 2, complete: true },
        activeUnavailable: { path: "Not-arrived.md" },
      });
      await expect(
        runtime.getWorkspaceFilePage({
          expectedVaultId: runtime.vaultId,
          generation: warmingGeneration ?? "missing",
          offset: 0,
          limit: 64,
        }),
      ).resolves.toMatchObject({ status: "stale-generation" });
      expect(diagnostics.snapshot().spans).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "census.parse-index", attributes: { documents: 2 } }),
        ]),
      );
    } finally {
      releaseCensus?.();
      await runtime.waitForCensusCompletion();
    }
  });

  it("returns a bounded first-time workspace before choosing its first indexed note", async () => {
    let releaseCensus: (() => void) | undefined;
    const censusGate = new Promise<void>((resolve) => {
      releaseCensus = resolve;
    });
    runtime = await WorkspaceRuntime.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
      deferWorkspaceCensus: true,
      beforeBackgroundCensus: () => censusGate,
    });
    try {
      const warming = await runtime.getSnapshot();
      expect(warming.workspace).toMatchObject({
        state: "warming",
        files: [],
        tabs: [],
        filePage: { total: 0, complete: true },
        inventory: { state: "warming", fileCount: 0, folderCount: 0, error: null },
      });

      releaseCensus?.();
      await runtime.waitForCensusCompletion();
      const current = await runtime.getSnapshot();
      expect(current.workspace).toMatchObject({
        state: "ready",
        census: { state: "current", total: 2, indexed: 2 },
        inventory: { state: "current", fileCount: 3, folderCount: 1, error: null },
        activeNote: { path: "Linked Note.md" },
      });
    } finally {
      releaseCensus?.();
      await runtime.waitForCensusCompletion();
    }
  });

  it("keeps the current census aligned with accepted external vault changes", async () => {
    runtime = await WorkspaceRuntime.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
      deferWorkspaceCensus: true,
    });
    await runtime.waitForCensusCompletion();

    const initial = await runtime.getSnapshot();
    expect(initial.workspace).toMatchObject({
      state: "ready",
      census: {
        state: "current",
        discovered: 2,
        indexed: 2,
        total: 2,
      },
      filePage: { total: 2 },
    });
    const initialCensusGeneration = initial.workspace?.census.generation ?? Number.NaN;
    const initialInventoryGeneration = initial.workspace?.inventory.generation ?? "missing";
    const initialIndexGeneration = initial.workspace?.indexGeneration ?? "missing";
    expect(initialCensusGeneration).toBeGreaterThan(0);
    expect(initial.workspace?.inventory).toMatchObject({
      state: "current",
      fileCount: 3,
      folderCount: 1,
    });

    await fs.writeFile(path.join(vaultPath, "External.md"), "# External\n", "utf8");
    const created = await runtime.reconcileNow();
    expect(created.workspace).toMatchObject({
      state: "ready",
      census: {
        state: "current",
        generation: initialCensusGeneration + 1,
        discovered: 3,
        indexed: 3,
        total: 3,
      },
      filePage: { total: 3 },
    });
    expect(created.vault.markdownFileCount).toBe(3);
    expect(created.workspace?.inventory).toMatchObject({ fileCount: 4, folderCount: 1 });
    expect(created.workspace?.inventory.generation).not.toBe(initialInventoryGeneration);
    expect(created.workspace?.indexGeneration).not.toBe(initialIndexGeneration);
    const createdInventoryGeneration = created.workspace?.inventory.generation ?? "missing";

    await expect(
      runtime.getWorkspaceTreePage({
        expectedVaultId: runtime.vaultId,
        generation: initialInventoryGeneration,
        parentPath: null,
        offset: 0,
        limit: 64,
      }),
    ).resolves.toMatchObject({ status: "stale-generation" });

    await fs.writeFile(path.join(vaultPath, "preview.bin"), Buffer.from([0x01, 0x02, 0x03]));
    const attachment = await runtime.reconcileNow();
    expect(attachment.workspace).toMatchObject({
      census: {
        generation: initialCensusGeneration + 1,
        discovered: 3,
        indexed: 3,
        total: 3,
      },
      filePage: { total: 3 },
    });
    expect(attachment.workspace?.inventory).toMatchObject({ fileCount: 5, folderCount: 1 });
    expect(attachment.workspace?.inventory.generation).not.toBe(createdInventoryGeneration);
    const attachmentInventoryGeneration = attachment.workspace?.inventory.generation ?? "missing";

    await fs.writeFile(path.join(vaultPath, "Welcome.md"), "# Welcome changed\n", "utf8");
    const contentOnly = await runtime.reconcileNow();
    expect(contentOnly.workspace?.indexGeneration).not.toBe(attachment.workspace?.indexGeneration);
    expect(contentOnly.workspace?.inventory.generation).toBe(attachmentInventoryGeneration);
    expect(contentOnly.workspace?.inventory).toMatchObject({ fileCount: 5, folderCount: 1 });

    const noOp = await runtime.reconcileNow();
    expect(noOp.workspace?.indexGeneration).toBe(contentOnly.workspace?.indexGeneration);
    expect(noOp.workspace?.inventory.generation).toBe(attachmentInventoryGeneration);

    await fs.unlink(path.join(vaultPath, "External.md"));
    const deleted = await runtime.reconcileNow();
    expect(deleted.workspace).toMatchObject({
      state: "ready",
      census: {
        state: "current",
        generation: initialCensusGeneration + 2,
        discovered: 2,
        indexed: 2,
        total: 2,
      },
      filePage: { total: 2 },
    });
    expect(deleted.vault.markdownFileCount).toBe(2);
    expect(deleted.workspace?.inventory).toMatchObject({ fileCount: 4, folderCount: 1 });
    expect(deleted.workspace?.inventory.generation).not.toBe(attachmentInventoryGeneration);
  });

  it("keeps census and index baselines independent and protects cached pages from callers", async () => {
    const workspace = await openRuntime();
    const before = await workspace.getSnapshot();
    const beforeIndexGeneration = before.workspace?.indexGeneration ?? "missing";
    const beforeCensusGeneration = before.workspace?.census.generation ?? Number.NaN;
    const beforeInventoryGeneration = before.workspace?.inventory.generation ?? "missing";
    const beforeFileCount = before.workspace?.files.length ?? 0;
    expect(before.workspace?.census).toMatchObject({
      state: "current",
      discovered: 2,
      indexed: 2,
      total: 2,
    });

    const beforeTree = await workspace.getWorkspaceTreePage({
      expectedVaultId: workspace.vaultId,
      generation: beforeInventoryGeneration,
      parentPath: null,
      offset: 0,
      limit: 64,
    });
    expect(beforeTree.status).toBe("ready");
    if (beforeTree.status !== "ready") throw new Error("Expected the initial Files page.");
    const expectedTreeEntries = beforeTree.entries.map((entry) => ({ ...entry }));

    await fs.writeFile(
      path.join(vaultPath, "Welcome.md"),
      "# Changed without a new note\n",
      "utf8",
    );
    const contentOnly = await workspace.reconcileNow();

    expect(contentOnly.workspace?.indexGeneration).not.toBe(beforeIndexGeneration);
    expect(contentOnly.workspace?.census.generation).toBe(beforeCensusGeneration);
    expect(contentOnly.workspace?.census).toMatchObject({
      state: "current",
      discovered: 2,
      indexed: 2,
      total: 2,
    });
    expect(contentOnly.workspace?.inventory.generation).toBe(beforeInventoryGeneration);
    await expect(
      workspace.getWorkspaceFilePage({
        expectedVaultId: workspace.vaultId,
        generation: beforeIndexGeneration,
        offset: 1,
        limit: 1,
      }),
    ).resolves.toMatchObject({ status: "stale-generation" });

    if (before.workspace) {
      before.workspace.files.pop();
      before.workspace.files[0]?.tags.push("caller-mutation");
    }
    const firstTreeEntry = beforeTree.entries[0];
    if (!firstTreeEntry) throw new Error("Expected one root Files entry.");
    firstTreeEntry.path = "caller-mutation";

    const afterCallerMutation = await workspace.getSnapshot();
    expect(afterCallerMutation.workspace?.files).toHaveLength(beforeFileCount);
    expect(
      afterCallerMutation.workspace?.files.some(
        ({ path: filePath }) => filePath === "caller-mutation",
      ),
    ).toBe(false);
    expect(
      afterCallerMutation.workspace?.files.some(({ tags }) => tags.includes("caller-mutation")),
    ).toBe(false);

    const afterTree = await workspace.getWorkspaceTreePage({
      expectedVaultId: workspace.vaultId,
      generation: beforeInventoryGeneration,
      parentPath: null,
      offset: 0,
      limit: 64,
    });
    expect(afterTree).toMatchObject({
      status: "ready",
      entries: expectedTreeEntries,
    });
    expect(afterTree).not.toMatchObject({ entries: [{ path: "caller-mutation" }] });
  });

  it("scans inventory outside the index lock and rejects a result invalidated in flight", async () => {
    runtime = await WorkspaceRuntime.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
    });
    const before = await runtime.getSnapshot();
    const beforeGeneration = before.workspace?.inventory.generation;
    expect(beforeGeneration).toEqual(expect.any(String));

    const inventorySeam = runtime as unknown as {
      invalidateVisibleInventory: () => void;
    };
    const listVisiblePaths = runtime.kernel.listVisiblePaths.bind(runtime.kernel);
    let pauseNextScan = true;
    let releaseScan: () => void = () => undefined;
    const scanGate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    let reportScanPaused: () => void = () => undefined;
    const scanPaused = new Promise<void>((resolve) => {
      reportScanPaused = resolve;
    });
    runtime.kernel.listVisiblePaths = async (...args) => {
      const visible = await listVisiblePaths(...args);
      if (pauseNextScan) {
        pauseNextScan = false;
        reportScanPaused();
        await scanGate;
      }
      return visible;
    };

    inventorySeam.invalidateVisibleInventory();
    const overlappingSnapshot = runtime.getSnapshot();
    await scanPaused;
    const mutation = runtime.createPluginFile(
      "Overlap.bin",
      new Uint8Array([1, 2, 3]),
      runtime.vaultId,
    );
    const mutatedBeforeScanRelease = await Promise.race([
      mutation.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    expect(mutatedBeforeScanRelease).toBe(true);
    releaseScan();
    const during = await overlappingSnapshot;

    expect(during.workspace).toMatchObject({
      inventory: { state: "current", fileCount: 4, folderCount: 1 },
    });
    expect(during.workspace?.inventory.generation).not.toBe(beforeGeneration);
    expect(during.workspace?.census).toMatchObject({ discovered: 2, indexed: 2, total: 2 });
    expect(during.vault.markdownFileCount).toBe(2);
  });

  it("retains the last good inventory on scan failure and retries without generation churn", async () => {
    runtime = await WorkspaceRuntime.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
    });
    const before = await runtime.getSnapshot();
    const beforeGeneration = before.workspace?.inventory.generation ?? "missing";
    const inventorySeam = runtime as unknown as {
      invalidateVisibleInventory: () => void;
    };
    const listVisiblePaths = runtime.kernel.listVisiblePaths.bind(runtime.kernel);
    let failNextScan = true;
    runtime.kernel.listVisiblePaths = async (...args) => {
      if (failNextScan) {
        failNextScan = false;
        throw new Error("intentional inventory scan failure");
      }
      return listVisiblePaths(...args);
    };

    inventorySeam.invalidateVisibleInventory();
    const degraded = await runtime.getSnapshot();
    expect(degraded.workspace?.inventory).toEqual({
      state: "degraded",
      generation: beforeGeneration,
      fileCount: 3,
      folderCount: 1,
      error: "The visible file inventory could not be read.",
    });

    const recovered = await runtime.getSnapshot();
    expect(recovered.workspace?.inventory).toEqual({
      state: "current",
      generation: beforeGeneration,
      fileCount: 3,
      folderCount: 1,
      error: null,
    });
  });

  it("marks partial search and graph results warming and rotates their generation after census", async () => {
    const firstStore = new MemoryWorkspaceStateStore({
      openPaths: ["Welcome.md"],
      activePath: "Welcome.md",
    });
    const secondStore = new MemoryWorkspaceStateStore({
      openPaths: ["Welcome.md"],
      activePath: "Welcome.md",
    });
    let releaseFirstCensus: (() => void) | undefined;
    let releaseSecondCensus: (() => void) | undefined;
    const firstCensusGate = new Promise<void>((resolve) => {
      releaseFirstCensus = resolve;
    });
    const secondCensusGate = new Promise<void>((resolve) => {
      releaseSecondCensus = resolve;
    });
    const first = await WorkspaceRuntime.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
      workspaceStateStore: firstStore,
      deferWorkspaceCensus: true,
      beforeBackgroundCensus: () => firstCensusGate,
    });
    const second = await WorkspaceRuntime.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(path.join(sandboxPath, "second-state")),
      workspaceStateStore: secondStore,
      deferWorkspaceCensus: true,
      beforeBackgroundCensus: () => secondCensusGate,
    });
    try {
      const warming = await first.getSnapshot();
      const secondWarming = await second.getSnapshot();
      const warmingGeneration = warming.workspace?.indexGeneration;
      expect(warming.workspace).toMatchObject({ census: { state: "warming" } });
      expect(warmingGeneration).toEqual(expect.any(String));
      expect(secondWarming.workspace?.indexGeneration).not.toBe(warmingGeneration);

      const warmingSearch = await first.searchVault("bounded UTF-8");
      expect(warmingSearch).toMatchObject({
        total: 0,
        census: { state: "warming" },
        indexGeneration: warmingGeneration,
      });
      await expect(
        first.getVaultGraph(
          { mode: "global", rootPath: null, depth: 1, query: "", includeOrphans: true },
          first.vaultId,
        ),
      ).resolves.toMatchObject({
        status: "ready",
        census: { state: "warming" },
        indexGeneration: warmingGeneration,
      });
      await expect(
        first.loadVaultNoteEmbed("Welcome.md", "Linked Note", null, first.vaultId),
      ).resolves.toMatchObject({ status: "unavailable", reason: "warming" });

      releaseFirstCensus?.();
      await first.waitForCensusCompletion();
      const ready = await first.getSnapshot();
      const readySearch = await first.searchVault("bounded UTF-8");
      expect(ready.workspace).toMatchObject({ census: { state: "current" } });
      expect(ready.workspace?.indexGeneration).not.toBe(warmingGeneration);
      expect(readySearch).toMatchObject({
        total: 1,
        census: { state: "current" },
        indexGeneration: ready.workspace?.indexGeneration,
      });
    } finally {
      releaseFirstCensus?.();
      releaseSecondCensus?.();
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("reports a failed census as degraded through bounded, search, and graph responses", async () => {
    runtime = await WorkspaceRuntime.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
      deferWorkspaceCensus: true,
      beforeBackgroundCensus: async () => {
        throw new Error("intentional census failure");
      },
    });
    await runtime.waitForCensusCompletion();

    const snapshot = await runtime.getSnapshot();
    const generation = snapshot.workspace?.filePage.generation;
    const inventoryGeneration = snapshot.workspace?.inventory.generation;
    expect(snapshot.workspace).toMatchObject({
      state: "degraded",
      census: { state: "degraded" },
      inventory: { state: "current", fileCount: 3, folderCount: 1, error: null },
    });
    await expect(
      runtime.getWorkspaceTreePage({
        expectedVaultId: runtime.vaultId,
        generation: inventoryGeneration ?? "missing",
        parentPath: null,
        offset: 0,
        limit: 64,
      }),
    ).resolves.toMatchObject({ status: "ready", page: { total: 3 } });
    await expect(
      runtime.getWorkspaceFilePage({
        expectedVaultId: runtime.vaultId,
        generation: generation ?? "missing",
        offset: 0,
        limit: 64,
      }),
    ).resolves.toMatchObject({ status: "degraded", census: { state: "degraded" } });
    await expect(runtime.searchVault("bounded UTF-8")).resolves.toMatchObject({
      census: { state: "degraded" },
    });
    await expect(
      runtime.getVaultGraph(
        { mode: "global", rootPath: null, depth: 1, query: "", includeOrphans: true },
        runtime.vaultId,
      ),
    ).resolves.toMatchObject({ status: "ready", census: { state: "degraded" } });
    await expect(
      runtime.loadVaultNoteEmbed("Welcome.md", "Linked Note", null, runtime.vaultId),
    ).resolves.toMatchObject({ status: "unavailable", reason: "degraded" });
  });

  it("does not create transient absence bookkeeping when history is traversed while warming", async () => {
    const store = new MemoryWorkspaceStateStore();
    const first = await openRuntime(store);
    await first.openNote("Welcome.md");
    await first.openNote("Linked Note.md");
    await first.close();
    runtime = undefined;
    await fs.rename(path.join(vaultPath, "Welcome.md"), path.join(sandboxPath, "Welcome.md.aside"));
    let releaseCensus: (() => void) | undefined;
    const censusGate = new Promise<void>((resolve) => {
      releaseCensus = resolve;
    });
    runtime = await WorkspaceRuntime.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
      workspaceStateStore: store,
      deferWorkspaceCensus: true,
      beforeBackgroundCensus: () => censusGate,
    });
    try {
      expect((await runtime.getSnapshot()).workspace?.panes[0]).toMatchObject({
        activeNote: { path: "Linked Note.md" },
        canGoBack: true,
      });
      const requestFollowUpScan = vi.spyOn(runtime.watcher, "requestFollowUpScan");
      await runtime.goBack(runtime.vaultId);

      expect(requestFollowUpScan).not.toHaveBeenCalled();
    } finally {
      releaseCensus?.();
      await runtime.waitForCensusCompletion();
    }
  });

  it("partitions parse/index and snapshot construction without wall-clock assertions", async () => {
    const diagnostics = new WorkspaceOpenDiagnostics();
    runtime = await WorkspaceRuntime.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
      diagnostics,
    });

    const snapshot = await runtime.getSnapshot();
    const captured = diagnostics.snapshot();

    expect(captured.spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "bootstrap.filesystem" }),
        expect.objectContaining({
          name: "parse-index",
          attributes: { documents: snapshot.vault.markdownFileCount },
        }),
        expect.objectContaining({
          name: "snapshot.construction",
          attributes: expect.objectContaining({
            files: snapshot.workspace?.files.length,
            payloadBytes: expect.any(Number),
            payloadObjects: expect.any(Number),
          }),
        }),
      ]),
    );
    expect(captured.metrics).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "snapshot.payload", count: 1 })]),
    );
  });

  it("reuses one visible-file inventory across attachment-card hydration", async () => {
    await fs.mkdir(path.join(vaultPath, "Drawings"), { recursive: true });
    await fs.mkdir(path.join(vaultPath, "Assets", "Ébauche"), { recursive: true });
    await fs.writeFile(
      path.join(vaultPath, "Drawings", "Scene.excalidraw.md"),
      "![[Assets/Ébauche/diagram.svg]]",
      "utf8",
    );
    await fs.writeFile(
      path.join(vaultPath, "Assets", "Ébauche", "diagram.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
      "utf8",
    );
    const workspace = await openRuntime();
    const listVisiblePaths = vi.spyOn(workspace.kernel, "listVisiblePaths");

    const [first, second] = await Promise.all([
      workspace.loadVaultAttachment(
        "Drawings/Scene.excalidraw.md",
        "Assets/Ébauche/diagram.svg",
        workspace.vaultId,
      ),
      workspace.loadVaultAttachment(
        "Drawings/Scene.excalidraw.md",
        "Assets/Ébauche/diagram.svg",
        workspace.vaultId,
      ),
    ]);

    expect(first).toMatchObject({
      status: "ready",
      attachment: { path: "Assets/Ébauche/diagram.svg" },
    });
    expect(second).toMatchObject({ status: "ready" });
    expect(listVisiblePaths).toHaveBeenCalledTimes(1);
  });

  it("offers and commits one revision-bound missing attachment relink through the runtime", async () => {
    const candidateBytes = Buffer.from("%PDF-1.7\nruntime relink candidate\n", "ascii");
    const before = "# Recovery Desk\n\n![[../Missing/report.pdf?download=1#page=2|Report]]\n";
    await fs.mkdir(path.join(vaultPath, "Assets"), { recursive: true });
    await fs.mkdir(path.join(vaultPath, "Notes"), { recursive: true });
    await fs.writeFile(path.join(vaultPath, "Assets", "recovered report.pdf"), candidateBytes);
    await fs.writeFile(path.join(vaultPath, "Notes", "Recovery Desk.md"), before, "utf8");
    const workspace = await openRuntime();
    const opened = await workspace.openNote("Notes/Recovery Desk.md");
    const source = opened.workspace?.activeNote;
    if (!source) throw new Error("Expected the recovery source note to open.");

    const missing = await workspace.loadVaultAttachment(
      source.path,
      "../Missing/report.pdf?download=1",
      workspace.vaultId,
    );
    expect(missing).toMatchObject({
      status: "unavailable",
      reason: "missing",
      recovery: {
        kind: "missing-attachment",
        missingPath: "Missing/report.pdf",
        sourceNoteRevision: source.revision,
      },
    });

    const preview = await workspace.relinkAttachment(
      source.path,
      "../Missing/report.pdf?download=1",
      "Assets/recovered report.pdf",
      source.revision,
      workspace.vaultId,
    );
    expect(preview.outcome).toMatchObject({
      status: "requires-confirmation",
      rewrite: {
        documentPath: source.path,
        syntax: "wiki",
        beforeTarget: "../Missing/report.pdf?download=1",
        afterTarget: "../Assets/recovered report.pdf?download=1",
      },
    });
    if (preview.outcome.status !== "requires-confirmation") {
      throw new Error("Expected a missing attachment relink confirmation.");
    }
    await expect(fs.readFile(path.join(vaultPath, source.path), "utf8")).resolves.toBe(before);

    const committed = await workspace.relinkAttachment(
      source.path,
      "../Missing/report.pdf?download=1",
      "Assets/recovered report.pdf",
      source.revision,
      workspace.vaultId,
      preview.outcome.confirmationId,
    );
    expect(committed.outcome).toMatchObject({
      status: "committed",
      path: source.path,
      rewrite: { replacementPath: "Assets/recovered report.pdf" },
    });
    expect(committed.snapshot.workspace?.activeNote?.content).toBe(
      before.replace(
        "../Missing/report.pdf?download=1",
        "../Assets/recovered report.pdf?download=1",
      ),
    );
    await expect(
      fs.readFile(path.join(vaultPath, "Assets", "recovered report.pdf")),
    ).resolves.toEqual(candidateBytes);
    await expect(fs.stat(path.join(vaultPath, "Missing", "report.pdf"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    await workspace.reconcileNow();
    expect(workspace.watcher.operations.size).toBe(0);
  });

  it("previews and restores exact external bytes without rewriting the source note", async () => {
    const restoredBytes = Uint8Array.from([0x00, 0xff, 0x80, 0x42, 0xef, 0xbb, 0xbf, 0x0a]);
    const before = "# Recovery Desk\n\n![[../Missing/report.bin|Report]]\n";
    await fs.mkdir(path.join(vaultPath, "Missing"), { recursive: true });
    await fs.mkdir(path.join(vaultPath, "Notes"), { recursive: true });
    await fs.writeFile(path.join(vaultPath, "Notes", "Recovery Desk.md"), before, "utf8");
    const workspace = await openRuntime();
    const opened = await workspace.openNote("Notes/Recovery Desk.md");
    const source = opened.workspace?.activeNote;
    if (!source) throw new Error("Expected the recovery source note to open.");

    const preview = await workspace.restoreAttachment(
      source.path,
      "../Missing/report.bin",
      "external-recovery.bin",
      restoredBytes,
      source.revision,
      workspace.vaultId,
    );
    expect(preview.outcome).toMatchObject({
      status: "requires-confirmation",
      preview: {
        sourceNotePath: source.path,
        targetPath: "Missing/report.bin",
        sourceFileName: "external-recovery.bin",
        byteLength: restoredBytes.byteLength,
      },
    });
    if (preview.outcome.status !== "requires-confirmation") {
      throw new Error("Expected a missing attachment restore confirmation.");
    }
    await expect(fs.stat(path.join(vaultPath, "Missing", "report.bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.readFile(path.join(vaultPath, source.path), "utf8")).resolves.toBe(before);

    const committed = await workspace.restoreAttachment(
      source.path,
      "../Missing/report.bin",
      "external-recovery.bin",
      restoredBytes,
      source.revision,
      workspace.vaultId,
      preview.outcome.confirmationId,
    );
    expect(committed.outcome).toMatchObject({
      status: "committed",
      path: "Missing/report.bin",
      preview: { sourceFileName: "external-recovery.bin" },
    });
    await expect(fs.readFile(path.join(vaultPath, "Missing", "report.bin"))).resolves.toEqual(
      Buffer.from(restoredBytes),
    );
    await expect(fs.readFile(path.join(vaultPath, source.path), "utf8")).resolves.toBe(before);
    await expect(
      workspace.loadVaultAttachment(source.path, "../Missing/report.bin", workspace.vaultId),
    ).resolves.toMatchObject({
      status: "ready",
      attachment: { path: "Missing/report.bin", size: restoredBytes.byteLength },
    });
    expect(workspace.watcher.operations.size).toBe(0);
  });

  it("previews and inserts one external attachment at the editor selection", async () => {
    const insertedBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff]);
    await fs.mkdir(path.join(vaultPath, "Notes"), { recursive: true });
    await fs.mkdir(path.join(vaultPath, "Assets"), { recursive: true });
    await fs.writeFile(
      path.join(vaultPath, "Notes", "Current.md"),
      "before replace after\n",
      "utf8",
    );
    const workspace = await openRuntime(undefined, { linkStyle: "markdown" });
    const opened = await workspace.openNote("Notes/Current.md");
    const source = opened.workspace?.activeNote;
    if (!source) throw new Error("Expected the insertion source note to open.");
    const selectionStart = source.content.indexOf("replace");
    const selectionEnd = selectionStart + "replace".length;

    const preview = await workspace.insertAttachment(
      source.path,
      "Assets/diagram one.png",
      "diagram one.png",
      insertedBytes,
      source.revision,
      workspace.vaultId,
      selectionStart,
      selectionEnd,
    );
    expect(preview.outcome).toMatchObject({
      status: "requires-confirmation",
      preview: {
        targetPath: "Assets/diagram one.png",
        referenceText: "![diagram one](../Assets/diagram%20one.png)",
        selectionStart,
        selectionEnd,
      },
    });
    if (preview.outcome.status !== "requires-confirmation") {
      throw new Error("Expected an attachment insertion confirmation.");
    }

    const committed = await workspace.insertAttachment(
      source.path,
      "Assets/diagram one.png",
      "diagram one.png",
      insertedBytes,
      source.revision,
      workspace.vaultId,
      selectionStart,
      selectionEnd,
      preview.outcome.confirmationId,
    );
    expect(committed.outcome).toMatchObject({
      status: "committed",
      path: source.path,
      attachmentPath: "Assets/diagram one.png",
      preview: preview.outcome.preview,
    });
    expect(committed.snapshot.workspace?.activeNote?.content).toBe(
      "before ![diagram one](../Assets/diagram%20one.png) after\n",
    );
    await expect(fs.readFile(path.join(vaultPath, "Assets", "diagram one.png"))).resolves.toEqual(
      Buffer.from(insertedBytes),
    );
  });

  it("routes an ordered attachment batch through one workspace action", async () => {
    await fs.mkdir(path.join(vaultPath, "Notes"), { recursive: true });
    await fs.mkdir(path.join(vaultPath, "Assets"), { recursive: true });
    await fs.writeFile(path.join(vaultPath, "Notes", "Current.md"), "before\nafter\n", "utf8");
    const workspace = await openRuntime(undefined, { linkStyle: "markdown" });
    const opened = await workspace.openNote("Notes/Current.md");
    const source = opened.workspace?.activeNote;
    if (!source) throw new Error("Expected the batch insertion source note to open.");
    const selectionStart = source.content.indexOf("after");
    const items = [
      {
        targetPath: "Assets/first.png",
        sourceFileName: "first.png",
        bytes: Uint8Array.from([1, 2, 3]),
        selectionStart,
        selectionEnd: selectionStart,
      },
      {
        targetPath: "Assets/second.png",
        sourceFileName: "second.png",
        bytes: Uint8Array.from([4, 5, 6]),
        selectionStart,
        selectionEnd: selectionStart,
      },
    ];
    const preview = await workspace.insertAttachmentBatch(
      source.path,
      items,
      source.revision,
      workspace.vaultId,
    );
    expect(preview.outcome).toMatchObject({
      status: "requires-confirmation",
      preview: {
        targetDirectory: "Assets",
        items: [{ targetPath: "Assets/first.png" }, { targetPath: "Assets/second.png" }],
      },
    });
    if (preview.outcome.status !== "requires-confirmation") {
      throw new Error("Expected a batch insertion confirmation.");
    }
    const committed = await workspace.insertAttachmentBatch(
      source.path,
      items,
      source.revision,
      workspace.vaultId,
      preview.outcome.confirmationId,
    );
    expect(committed.outcome).toMatchObject({
      status: "committed",
      attachments: [
        { attachmentPath: "Assets/first.png" },
        { attachmentPath: "Assets/second.png" },
      ],
    });
    expect(committed.snapshot.workspace?.activeNote?.content).toBe(
      "before\n![first](../Assets/first.png)![second](../Assets/second.png)after\n",
    );
  });

  it("publishes a conflict copy when the source changes after attachment publication", async () => {
    await fs.mkdir(path.join(vaultPath, "Notes"), { recursive: true });
    await fs.mkdir(path.join(vaultPath, "Assets"), { recursive: true });
    await fs.writeFile(path.join(vaultPath, "Notes", "Current.md"), "# Current\n", "utf8");
    const workspace = await openRuntime(undefined, undefined, undefined, async (point) => {
      if (point === "attachment-insert:before-note-write") {
        await fs.writeFile(
          path.join(vaultPath, "Notes", "Current.md"),
          "# External winner\n",
          "utf8",
        );
      }
    });
    const opened = await workspace.openNote("Notes/Current.md");
    const source = opened.workspace?.activeNote;
    if (!source) throw new Error("Expected the insertion source note to open.");
    const bytes = Buffer.from("image bytes");
    const preview = await workspace.insertAttachment(
      source.path,
      "Assets/photo.png",
      "photo.png",
      bytes,
      source.revision,
      workspace.vaultId,
      source.content.length,
      source.content.length,
    );
    if (preview.outcome.status !== "requires-confirmation") {
      throw new Error("Expected an attachment insertion confirmation.");
    }

    const conflict = await workspace.insertAttachment(
      source.path,
      "Assets/photo.png",
      "photo.png",
      bytes,
      source.revision,
      workspace.vaultId,
      source.content.length,
      source.content.length,
      preview.outcome.confirmationId,
    );
    expect(conflict.outcome).toMatchObject({
      status: "conflict-copy",
      path: source.path,
      conflictPath: expect.stringMatching(/\.threadleaf-conflict-/u),
      attachmentPath: "Assets/photo.png",
    });
    if (conflict.outcome.status !== "conflict-copy") {
      throw new Error("Expected an attachment insertion conflict copy.");
    }
    expect(conflict.snapshot.workspace?.activeNote?.path).toBe(conflict.outcome.conflictPath);
    expect(conflict.snapshot.workspace?.activeNote?.content).toBe(
      "# Current\n![[../Assets/photo.png]]",
    );
    await expect(fs.readFile(path.join(vaultPath, "Notes", "Current.md"), "utf8")).resolves.toBe(
      "# External winner\n",
    );
  });

  it("rejects oversized restore bytes at the action boundary", async () => {
    const workspace = await openRuntime();

    await expect(
      workspace.restoreAttachment(
        "Welcome.md",
        "Missing/oversized.bin",
        "oversized.bin",
        new Uint8Array(MAX_VAULT_ATTACHMENT_BYTES + 1),
        "revision",
        workspace.vaultId,
      ),
    ).rejects.toThrow("plus bounded bytes");
  });

  it("binds direct ordinary-file previews to the current physical inventory generation", async () => {
    await fs.writeFile(path.join(vaultPath, "readme.data"), "ordinary text", "utf8");
    const workspace = await openRuntime();
    const snapshot = await workspace.getSnapshot();
    const generation = snapshot.workspace?.inventory.generation;
    if (!generation) throw new Error("Expected a current physical inventory generation.");
    const readBinary = vi.spyOn(workspace.kernel, "readBinary");

    await expect(
      workspace.loadVaultFilePreview("readme.data", workspace.vaultId, `${generation}:stale`),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: "stale-inventory",
      path: "readme.data",
    });
    expect(readBinary).not.toHaveBeenCalled();

    await expect(
      workspace.loadVaultFilePreview("readme.data", workspace.vaultId, generation),
    ).resolves.toMatchObject({
      status: "ready",
      path: "readme.data",
      kind: "text",
      preview: "text",
      text: "ordinary text",
    });
    expect(readBinary).toHaveBeenCalledTimes(1);
  });

  it("reuses the restored startup inventory for the first nondeferred snapshot", async () => {
    const store = new MemoryWorkspaceStateStore({
      openPaths: ["Welcome.md"],
      activePath: "Welcome.md",
    });
    const listVisiblePaths = vi.spyOn(VaultKernel.prototype, "listVisiblePaths");
    try {
      const workspace = await openRuntime(store);
      expect(
        listVisiblePaths.mock.calls.filter(([relative]) => relative === undefined),
      ).toHaveLength(1);

      const snapshot = await workspace.getSnapshot();

      expect(snapshot.workspace?.inventory).toMatchObject({
        state: "current",
        fileCount: 3,
        folderCount: 1,
      });
      expect(
        listVisiblePaths.mock.calls.filter(([relative]) => relative === undefined),
      ).toHaveLength(1);
    } finally {
      listVisiblePaths.mockRestore();
    }
  });

  it("keeps the bundled demo vault read-only across native and plugin mutation paths", async () => {
    runtime = await WorkspaceRuntime.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
      selectionSource: "bundled",
    });
    const snapshot = await runtime.getSnapshot();
    const note = snapshot.workspace?.activeNote;
    if (!note) {
      throw new Error("Expected the bundled fixture to open an active note.");
    }
    const before = await fs.readFile(path.join(vaultPath, note.path), "utf8");

    expect(runtime.readOnly).toBe(true);
    expect(snapshot.vault).toMatchObject({
      name: "Threadleaf Demo",
      mode: "synthetic-read-only",
      source: "bundled",
    });
    await expect(runtime.createNote("Blocked.md", "blocked", runtime.vaultId)).rejects.toThrow(
      "Open a local vault",
    );
    await expect(
      runtime.saveNote(note.path, "blocked", note.revision, runtime.vaultId, "primary"),
    ).rejects.toThrow("Open a local vault");
    await expect(
      runtime.setNoteProperty(
        note.path,
        "status",
        "blocked",
        "text",
        note.revision,
        runtime.vaultId,
      ),
    ).rejects.toThrow("Open a local vault");
    await expect(
      runtime.removeNoteProperty(note.path, "status", note.revision, runtime.vaultId),
    ).rejects.toThrow("Open a local vault");
    await expect(
      runtime.moveNote(note.path, "Moved.md", note.revision, runtime.vaultId),
    ).rejects.toThrow("Open a local vault");
    await expect(runtime.deleteNote(note.path, note.revision, runtime.vaultId)).rejects.toThrow(
      "Open a local vault",
    );
    await expect(
      runtime.createPluginFile("Blocked.png", Uint8Array.of(1, 2, 3), runtime.vaultId),
    ).rejects.toThrow("Open a local vault");
    await expect(runtime.createPluginFolder("Blocked", runtime.vaultId)).rejects.toThrow(
      "Open a local vault",
    );

    await expect(fs.readFile(path.join(vaultPath, note.path), "utf8")).resolves.toBe(before);
    await expect(fs.stat(path.join(vaultPath, "Blocked.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(path.join(vaultPath, "Blocked.png"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(path.join(vaultPath, "Blocked"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("composes the kernel, metadata, shared actions, and compatibility host", async () => {
    const workspace = await openRuntime();
    const canonicalVaultPath = await fs.realpath(vaultPath);

    const initial = await workspace.getSnapshot();

    expect(initial.vault).toMatchObject({
      name: "vault",
      path: canonicalVaultPath,
      markdownFileCount: 2,
      mode: "kernel-backed",
      source: "direct",
      warning: null,
    });
    expect(initial.workspace).toMatchObject({
      state: "ready",
      files: [
        { path: "Linked Note.md", title: "Linked Note" },
        { path: "Welcome.md", title: "Welcome", outgoingCount: 2 },
      ],
      activeNote: { path: "Linked Note.md", title: "Linked Note" },
      tabs: [{ path: "Linked Note.md", title: "Linked Note", active: true }],
    });
    expect(initial.actions).toEqual([
      { id: "workspace.close-note", name: "Close note", source: "workspace" },
      { id: "workspace.close-pane", name: "Close workspace pane", source: "workspace" },
      {
        id: "threadleaf-fixture:threadleaf-fixture-confirm",
        name: "Confirm compatibility bridge",
        source: "plugin",
      },
      { id: "workspace.create-note", name: "Create note", source: "workspace" },
      { id: "workspace.focus-pane", name: "Focus workspace pane", source: "workspace" },
      { id: "workspace.go-back", name: "Go back in note history", source: "workspace" },
      { id: "workspace.go-forward", name: "Go forward in note history", source: "workspace" },
      {
        id: "workspace.insert-attachment",
        name: "Insert external attachment",
        source: "workspace",
      },
      {
        id: "workspace.insert-attachment-batch",
        name: "Insert external attachment batch",
        source: "workspace",
      },
      { id: "workspace.delete-note", name: "Move note to trash", source: "workspace" },
      {
        id: "workspace.move-note-to-pane",
        name: "Move note to workspace pane",
        source: "workspace",
      },
      { id: "workspace.move-note", name: "Move or rename note", source: "workspace" },
      { id: "workspace.open-note", name: "Open note", source: "workspace" },
      {
        id: "workspace.open-daily-note",
        name: "Open today's daily note",
        source: "workspace",
      },
      { id: "workspace.move-attachment", name: "Publish attachment copy", source: "workspace" },
      {
        id: "workspace.relink-attachment",
        name: "Relink missing attachment",
        source: "workspace",
      },
      {
        id: "workspace.remove-note-property",
        name: "Remove note property",
        source: "workspace",
      },
      { id: "workspace.reorder-tab", name: "Reorder workspace tab", source: "workspace" },
      {
        id: "workspace.restore-attachment",
        name: "Restore missing attachment",
        source: "workspace",
      },
      { id: "workspace.save-note", name: "Save note", source: "workspace" },
      {
        id: "workspace.set-note-property",
        name: "Set note property",
        source: "workspace",
      },
      { id: "workspace.split", name: "Split workspace", source: "workspace" },
      { id: "workspace.toggle-tab-pin", name: "Toggle tab pin", source: "workspace" },
    ]);

    const opened = await workspace.openNote("Welcome.md");
    expect(opened.workspace?.activeNote).toMatchObject({
      path: "Welcome.md",
      outgoing: [
        {
          label: "Linked Note",
          status: "resolved",
          path: "Linked Note.md",
          target: "Linked Note",
          subpath: null,
          embed: false,
          syntax: "wiki",
        },
        {
          label: "Linked Note#Project brief",
          status: "resolved",
          path: "Linked Note.md",
          target: "Linked Note",
          subpath: "#Project brief",
          embed: true,
          syntax: "wiki",
        },
      ],
    });
    await expect(
      workspace.openNote(".obsidian/plugins/threadleaf-fixture/main.js"),
    ).rejects.toThrow("not indexed");

    const commanded = await workspace.runPluginCommand(
      "threadleaf-fixture:threadleaf-fixture-confirm",
    );
    expect(commanded.notices).toContain("Fixture command crossed the compatibility bridge.");
    expect(commanded.plugin?.compatibilityLevel).toBe(3);
  });

  it("re-resolves the configured plugin as app-restart reconstruction", async () => {
    const constructionPaths: string[] = [];
    const pluginDirectory = path.join(vaultPath, ".obsidian", "plugins", "threadleaf-fixture");
    runtime = await WorkspaceRuntime.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
      pluginConstructionRequest: await testConstructionRequest(pluginDirectory, "first-load"),
      pluginRuntimeFactory: async (runtimeVaultPath, actions) => {
        const delegate = await testPluginRuntimeFactory(runtimeVaultPath, actions);
        const loadPlugin = delegate.loadPlugin.bind(delegate);
        delegate.loadPlugin = async (request) => {
          constructionPaths.push(request.constructionPath);
          return loadPlugin(request);
        };
        return delegate;
      },
    });

    expect(constructionPaths).toEqual(["app-restart-reconstruction"]);
  });

  it("applies private workspace defaults to native creation and background tabs", async () => {
    const workspace = await openRuntime(undefined, {
      defaultNoteFolder: "Notes",
      newTabBehavior: "background",
    });
    const created = await workspace.createNote("Created.md", "# Created", workspace.vaultId);
    expect(created.outcome).toMatchObject({ status: "committed", path: "Notes/Created.md" });
    await expect(fs.readFile(path.join(vaultPath, "Notes/Created.md"), "utf8")).resolves.toBe(
      "# Created",
    );

    await workspace.openNote("Welcome.md");
    const before = await workspace.getSnapshot();
    await workspace.openNote("Linked Note.md", "primary", false);
    const after = await workspace.getSnapshot();
    expect(after.workspace?.activeNote?.path).toBe(before.workspace?.activeNote?.path);
    expect(after.workspace?.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "Linked Note.md", active: false }),
        expect.objectContaining({ path: "Welcome.md", active: true }),
      ]),
    );
  });

  it("keeps the fresh restart policy scoped to note panes without deleting saved state", async () => {
    const state = new MemoryWorkspaceStateStore({
      openPaths: ["Welcome.md"],
      activePath: "Welcome.md",
    });
    const workspace = await openRuntime(state, { restorePolicy: "fresh" });
    const snapshot = await workspace.getSnapshot();
    expect(snapshot.workspace?.activeNote?.path).toBe("Linked Note.md");
    expect(state.saved.at(-1)?.activePaneId).toBe("primary");
    expect(state.saved.at(-1)?.panes[0]?.activePath).toBe("Linked Note.md");
  });

  it("moves without backlink writes when automatic updates are disabled", async () => {
    const workspace = await openRuntime(undefined, { automaticLinkUpdates: "never" });
    await workspace.openNote("Welcome.md");
    const before = await workspace.getSnapshot();
    const source = before.workspace?.activeNote;
    if (!source) {
      throw new Error("Expected a source note for the automatic-update test.");
    }

    const moved = await workspace.moveNote(
      source.path,
      "Moved.md",
      source.revision,
      workspace.vaultId,
    );

    expect(moved.outcome).toMatchObject({
      status: "committed",
      from: "Welcome.md",
      to: "Moved.md",
      rewrites: [],
      writes: [],
    });
    await expect(fs.readFile(path.join(vaultPath, "Linked Note.md"), "utf8")).resolves.toContain(
      "[[Welcome]]",
    );
  });

  it("merges actions and command workflows from an external plugin runtime", async () => {
    let commandRan = false;
    let closed = false;
    const pluginSnapshot = (): RuntimeSnapshot => ({
      vault: {
        id: null,
        name: "vault",
        path: vaultPath,
        markdownFileCount: 2,
        mode: "synthetic-read-only",
        source: "direct",
        warning: null,
      },
      plugin: {
        id: "external-fixture",
        name: "External fixture",
        version: "0.1.0",
        state: "loaded",
        compatibilityLevel: 3,
        stylesheetDiscovered: false,
        error: null,
      },
      plugins: [],
      commands: [{ id: "external-command", name: "External command", ownerId: "external-fixture" }],
      actions: [{ id: "external-command", name: "External command", source: "plugin" }],
      notices: commandRan ? ["External command ran."] : [],
      events: [],
    });
    const externalRuntime: PluginRuntimePort = {
      close: async () => {
        closed = true;
      },
      closePluginView: async () => pluginSnapshot(),
      getSnapshot: async () => pluginSnapshot(),
      loadPlugin: async () => pluginSnapshot(),
      markLayoutReady: async () => pluginSnapshot(),
      openPluginSettings: async () => pluginSnapshot(),
      openPluginView: async () => pluginSnapshot(),
      reloadPlugin: async () => pluginSnapshot(),
      runCommand: async () => {
        commandRan = true;
        return pluginSnapshot();
      },
      waitForPluginMutations: async () => pluginSnapshot(),
      unloadAllPlugins: async () => pluginSnapshot(),
      unloadPlugin: async () => pluginSnapshot(),
    };
    runtime = await WorkspaceRuntime.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
      pluginRuntimeFactory: async () => externalRuntime,
    });

    const initial = await runtime.getSnapshot();
    expect(initial.actions).toContainEqual({
      id: "external-command",
      name: "External command",
      source: "plugin",
    });
    expect(initial.actions).toContainEqual({
      id: "workspace.open-note",
      name: "Open note",
      source: "workspace",
    });

    const commanded = await runtime.runPluginCommand("external-command");
    expect(commanded.plugin?.compatibilityLevel).toBe(3);
    expect(commanded.notices).toEqual(["External command ran."]);

    await runtime.close();
    runtime = undefined;
    expect(closed).toBe(true);
  });

  it("settles queued watcher and snapshot work when close wins an inventory invalidation race", async () => {
    const workspace = await openRuntime();
    await workspace.getSnapshot();

    const accept = workspace.indexReactor.accept.bind(workspace.indexReactor);
    let markAcceptEntered: () => void = () => undefined;
    let releaseAccept: () => void = () => undefined;
    const acceptEntered = new Promise<void>((resolve) => {
      markAcceptEntered = resolve;
    });
    const acceptGate = new Promise<void>((resolve) => {
      releaseAccept = resolve;
    });
    vi.spyOn(workspace.indexReactor, "accept").mockImplementation(async (batch) => {
      markAcceptEntered();
      await acceptGate;
      return accept(batch);
    });

    const overflow = workspace.watcher.reportOverflow();
    await acceptEntered;
    const closing = workspace.close();
    const snapshot = workspace.getSnapshot();
    releaseAccept();

    await Promise.all([overflow, closing, snapshot]);
    runtime = undefined;
  });

  it("keeps a plugin command projected once when its local ID collides with a workspace action", async () => {
    const pluginDirectory = path.join(
      vaultPath,
      ".obsidian",
      "plugins",
      "action-collision-fixture",
    );
    await fs.mkdir(pluginDirectory, { recursive: true });
    await fs.writeFile(
      path.join(pluginDirectory, "manifest.json"),
      JSON.stringify({
        id: "action-collision-fixture",
        name: "Action Collision Fixture",
        version: "0.1.0",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(pluginDirectory, "main.js"),
      `const { Plugin } = require("obsidian");
module.exports = class ActionCollisionFixture extends Plugin {
  async onload() {
    this.addCommand({ id: "workspace.open-note", name: "Plugin open note", callback() {} });
  }
};
`,
      "utf8",
    );
    runtime = await WorkspaceRuntime.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
      pluginConstructionRequest: await testConstructionRequest(pluginDirectory),
      pluginRuntimeFactory: testPluginRuntimeFactory,
    });

    const qualifiedId = "action-collision-fixture:workspace.open-note";
    const initial = await runtime.getSnapshot();
    expect(initial.commands).toContainEqual({
      id: qualifiedId,
      name: "Plugin open note",
      ownerId: "action-collision-fixture",
    });
    expect(runtime.actions.list("plugin")).toEqual([
      { id: qualifiedId, name: "Plugin open note", source: "plugin" },
    ]);
    expect(initial.actions.filter(({ id }) => id === qualifiedId)).toEqual([
      { id: qualifiedId, name: "Plugin open note", source: "plugin" },
    ]);
    expect(initial.actions.filter(({ id }) => id === "workspace.open-note")).toEqual([
      { id: "workspace.open-note", name: "Open note", source: "workspace" },
    ]);

    const unloaded = await runtime.unloadPlugin("action-collision-fixture");
    expect(runtime.actions.list("plugin")).toEqual([]);
    expect(unloaded.actions.some(({ id }) => id === qualifiedId)).toBe(false);
    expect(unloaded.actions.filter(({ id }) => id === "workspace.open-note")).toEqual([
      { id: "workspace.open-note", name: "Open note", source: "workspace" },
    ]);
  });

  it("opens, reuses, activates, and closes ordered note tabs", async () => {
    const workspace = await openRuntime();

    const welcome = await workspace.openNote("Welcome.md");
    expect(welcome.workspace?.tabs).toEqual([
      { path: "Linked Note.md", title: "Linked Note", active: false, pinned: false },
      { path: "Welcome.md", title: "Welcome", active: true, pinned: false },
    ]);

    const reused = await workspace.openNote("Linked Note.md");
    expect(reused.workspace?.tabs).toEqual([
      { path: "Linked Note.md", title: "Linked Note", active: true, pinned: false },
      { path: "Welcome.md", title: "Welcome", active: false, pinned: false },
    ]);

    const closedActive = await workspace.closeNote("Linked Note.md", workspace.vaultId);
    expect(closedActive.workspace).toMatchObject({
      tabs: [{ path: "Welcome.md", title: "Welcome", active: true }],
      activeNote: { path: "Welcome.md" },
    });

    const closedLast = await workspace.closeNote("Welcome.md", workspace.vaultId);
    expect(closedLast.workspace).toMatchObject({ tabs: [], activeNote: null });
    expect(closedLast.workspace?.files).toHaveLength(2);
    await expect(workspace.closeNote("Welcome.md", "stale-vault")).rejects.toThrow(
      "active vault changed",
    );
  });

  it("traverses per-pane history, clears forward history on a branch, and persists it", async () => {
    const store = new MemoryWorkspaceStateStore();
    let workspace = await openRuntime(store);

    await workspace.openNote("Welcome.md");
    const linked = await workspace.openNote("Linked Note.md");
    expect(linked.workspace?.panes[0]).toMatchObject({
      activeNote: { path: "Linked Note.md" },
      canGoBack: true,
      canGoForward: false,
    });

    const back = await workspace.goBack(workspace.vaultId);
    expect(back.workspace?.activeNote?.path).toBe("Welcome.md");
    expect(back.workspace?.panes[0]).toMatchObject({ canGoBack: false, canGoForward: true });

    const forward = await workspace.goForward(workspace.vaultId);
    expect(forward.workspace?.activeNote?.path).toBe("Linked Note.md");
    expect(forward.workspace?.panes[0]).toMatchObject({ canGoBack: true, canGoForward: false });

    await workspace.goBack(workspace.vaultId);
    const branched = await workspace.openNote("Linked Note.md");
    expect(branched.workspace?.panes[0]).toMatchObject({ canGoBack: true, canGoForward: false });
    expect(store.saved.at(-1)?.panes[0]?.navigationHistory).toEqual({
      back: ["Welcome.md"],
      forward: [],
    });

    await workspace.close();
    runtime = undefined;
    workspace = await openRuntime(store);
    expect((await workspace.getSnapshot()).workspace?.panes[0]).toMatchObject({
      activeNote: { path: "Linked Note.md" },
      canGoBack: true,
      canGoForward: false,
    });
  });

  it("prunes the replacement active note when closing a tab and restoring stale history", async () => {
    const store = new MemoryWorkspaceStateStore();
    let workspace = await openRuntime(store);
    await workspace.openNote("Welcome.md");
    await workspace.openNote("Linked Note.md");

    const closed = await workspace.closeNote("Linked Note.md", workspace.vaultId);
    expect(closed.workspace?.activeNote?.path).toBe("Welcome.md");
    expect(closed.workspace?.panes[0]).toMatchObject({
      canGoBack: false,
      canGoForward: false,
    });

    await workspace.close();
    runtime = undefined;
    store.value = createWorkspaceLayout(
      workspace.vaultId,
      [
        {
          id: "primary",
          openPaths: ["Welcome.md"],
          activePath: "Welcome.md",
          navigationHistory: { back: ["Welcome.md", "Linked Note.md"], forward: [] },
        },
      ],
      "primary",
      null,
    );
    workspace = await openRuntime(store);
    const restored = await workspace.getSnapshot();
    expect(restored.workspace?.activeNote?.path).toBe("Welcome.md");
    expect(store.saved.at(-1)?.panes[0]?.navigationHistory).toEqual({
      back: ["Linked Note.md"],
      forward: [],
    });
  });

  it("orders pinned tabs, refuses destructive closes, and persists their private state", async () => {
    const store = new MemoryWorkspaceStateStore();
    let workspace = await openRuntime(store);
    const opened = await workspace.openNote("Welcome.md");
    const activeNote = opened.workspace?.activeNote;
    if (!activeNote) {
      throw new Error("Expected Welcome.md to be active.");
    }

    await workspace.toggleTabPin("Welcome.md", "primary", workspace.vaultId);
    const bothPinned = await workspace.toggleTabPin("Linked Note.md", "primary", workspace.vaultId);
    expect(bothPinned.workspace?.tabs).toEqual([
      { path: "Welcome.md", title: "Welcome", active: true, pinned: true },
      { path: "Linked Note.md", title: "Linked Note", active: false, pinned: true },
    ]);

    const unpinned = await workspace.toggleTabPin("Welcome.md", "primary", workspace.vaultId);
    expect(unpinned.workspace?.tabs).toEqual([
      { path: "Linked Note.md", title: "Linked Note", active: false, pinned: true },
      { path: "Welcome.md", title: "Welcome", active: true, pinned: false },
    ]);
    const repinned = await workspace.toggleTabPin("Welcome.md", "primary", workspace.vaultId);
    expect(
      repinned.workspace?.tabs.map(({ path: filePath, pinned }) => ({ filePath, pinned })),
    ).toEqual([
      { filePath: "Linked Note.md", pinned: true },
      { filePath: "Welcome.md", pinned: true },
    ]);

    const before = await fs.readFile(path.join(vaultPath, "Welcome.md"), "utf8");
    await expect(workspace.closeNote("Welcome.md", workspace.vaultId)).rejects.toThrow(
      "Unpin this tab before closing it.",
    );
    await expect(
      workspace.deleteNote("Welcome.md", activeNote.revision, workspace.vaultId),
    ).rejects.toThrow("Unpin this tab before closing it.");
    await expect(fs.readFile(path.join(vaultPath, "Welcome.md"), "utf8")).resolves.toBe(before);
    await expect(
      workspace.toggleTabPin("Missing.md", "primary", workspace.vaultId),
    ).rejects.toThrow("does not contain this tab");
    await expect(workspace.toggleTabPin("Welcome.md", "primary", "stale-vault")).rejects.toThrow(
      "active vault changed",
    );

    await workspace.toggleTabPin("Welcome.md", "primary", workspace.vaultId);
    await workspace.closeNote("Welcome.md", workspace.vaultId);
    await workspace.close();
    runtime = undefined;

    workspace = await openRuntime(store);
    expect((await workspace.getSnapshot()).workspace?.tabs).toEqual([
      { path: "Linked Note.md", title: "Linked Note", active: true, pinned: true },
    ]);
    expect(store.saved.at(-1)?.panes[0]).toMatchObject({
      openPaths: ["Linked Note.md"],
      pinnedPaths: ["Linked Note.md"],
    });
  });

  it("does not adopt a pin change when its private workspace write fails", async () => {
    const store = new MemoryWorkspaceStateStore();
    const workspace = await openRuntime(store);
    store.saveError = new Error("workspace disk unavailable");

    await expect(
      workspace.toggleTabPin("Linked Note.md", "primary", workspace.vaultId),
    ).rejects.toThrow("Could not save workspace state: workspace disk unavailable");
    expect((await workspace.getSnapshot()).workspace?.tabs).toEqual([
      { path: "Linked Note.md", title: "Linked Note", active: true, pinned: false },
    ]);
  });

  it("rejects a concurrent tab update instead of overwriting a migration workspace write", async () => {
    const store = new MemoryWorkspaceStateStore();
    const workspace = await openRuntime(store);
    const current = await workspace.getWorkspaceState(workspace.vaultId);
    const migrated = createWorkspaceLayout(
      workspace.vaultId,
      [{ id: "primary", openPaths: ["Welcome.md"], activePath: "Welcome.md" }],
      "primary",
      null,
    );
    let markSaveStarted: () => void = () => undefined;
    const saveStarted = new Promise<void>((resolve) => {
      markSaveStarted = resolve;
    });
    let releaseSave: () => void = () => undefined;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let firstSave = true;
    store.beforeSave = async () => {
      if (!firstSave) {
        return;
      }
      firstSave = false;
      markSaveStarted();
      await saveGate;
    };

    const migration = workspace.setWorkspaceState(migrated, workspace.vaultId, current);
    await saveStarted;
    const pin = workspace.toggleTabPin("Linked Note.md", "primary", workspace.vaultId).then(
      () => ({ status: "resolved" as const, error: null }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    releaseSave();

    await expect(migration).resolves.toMatchObject({
      workspace: { activeNote: { path: "Welcome.md" } },
    });
    await expect(pin).resolves.toMatchObject({ status: "rejected" });
    expect((await pin).error).toBeInstanceOf(Error);
    expect(String((await pin).error)).toContain("workspace state changed before it could be saved");
    await expect(workspace.getWorkspaceState(workspace.vaultId)).resolves.toEqual(migrated);
  });

  it("does not let a stale note persistence overwrite migration state across restart", async () => {
    const store = new BlockingWorkspaceStateStore();
    const workspace = await openRuntime(store);
    const current = await workspace.getWorkspaceState(workspace.vaultId);
    const migrated = createWorkspaceLayout(
      workspace.vaultId,
      [{ id: "primary", openPaths: ["Welcome.md"], activePath: "Welcome.md" }],
      "primary",
      null,
    );
    store.resetSaveCount();
    store.blockSaves();
    const migration = workspace.setWorkspaceState(migrated, workspace.vaultId, current);
    await store.waitForSaveCount(1);

    const note = workspace.createNote("Race.md", "# Race\n", workspace.vaultId);
    await store.waitForSaveCount(2);
    store.releaseSaves();

    await expect(migration).resolves.toMatchObject({
      workspace: { activeNote: { path: "Welcome.md" } },
    });
    const created = await note;
    expect(created.outcome).toMatchObject({ status: "committed", path: "Race.md" });
    await expect(store.inner.load(workspace.vaultId)).resolves.toEqual(migrated);

    await workspace.close();
    runtime = undefined;
    const restarted = await openRuntime(store);
    expect((await restarted.getSnapshot()).workspace).toMatchObject({
      tabs: [{ path: "Welcome.md", active: true }],
      activeNote: { path: "Welcome.md" },
    });
  });

  it("uses the same pinned-region reorder contract for keyboard and pointer callers", async () => {
    const workspace = await openRuntime();
    await workspace.openNote("Welcome.md");
    await workspace.createNote("Third", "# Third\n", workspace.vaultId);

    const moved = await workspace.reorderWorkspaceTab("Third.md", "primary", 1, workspace.vaultId);
    expect(moved.workspace?.tabs.map(({ path }) => path)).toEqual([
      "Linked Note.md",
      "Third.md",
      "Welcome.md",
    ]);
    await workspace.toggleTabPin("Welcome.md", "primary", workspace.vaultId);
    const clamped = await workspace.reorderWorkspaceTab(
      "Third.md",
      "primary",
      0,
      workspace.vaultId,
    );
    expect(clamped.workspace?.tabs.map(({ path }) => path)).toEqual([
      "Welcome.md",
      "Third.md",
      "Linked Note.md",
    ]);
    await expect(
      workspace.reorderWorkspaceTab("Third.md", "primary", 1, "stale-vault"),
    ).rejects.toThrow("active vault changed");
  });

  it("keeps pinned ordering through pane split, transfer, collapse, and restart", async () => {
    const store = new MemoryWorkspaceStateStore();
    let workspace = await openRuntime(store);
    await workspace.openNote("Welcome.md");
    await workspace.toggleTabPin("Welcome.md", "primary", workspace.vaultId);
    await workspace.splitWorkspace("vertical", workspace.vaultId);
    await workspace.focusWorkspacePane("primary", workspace.vaultId);
    const created = await workspace.createNote("Third", "# Third\n", workspace.vaultId);
    if (created.outcome.status !== "committed") {
      throw new Error("Expected the third note to be created.");
    }
    await workspace.toggleTabPin("Third.md", "primary", workspace.vaultId);

    const moved = await workspace.moveNoteToWorkspacePane(
      "Third.md",
      "primary",
      "secondary",
      workspace.vaultId,
    );
    expect(moved.workspace?.panes).toMatchObject([
      {
        id: "primary",
        tabs: [
          { path: "Welcome.md", pinned: true },
          { path: "Linked Note.md", pinned: false },
        ],
      },
      {
        id: "secondary",
        tabs: [
          { path: "Welcome.md", pinned: true },
          { path: "Third.md", pinned: true, active: true },
        ],
      },
    ]);

    const collapsed = await workspace.closeWorkspacePane("secondary", workspace.vaultId);
    expect(collapsed.workspace).toMatchObject({
      activePaneId: "primary",
      splitDirection: null,
      panes: [
        {
          id: "primary",
          tabs: [
            { path: "Welcome.md", pinned: true, active: false },
            { path: "Third.md", pinned: true, active: true },
            { path: "Linked Note.md", pinned: false, active: false },
          ],
        },
      ],
    });
    await workspace.close();
    runtime = undefined;

    workspace = await openRuntime(store);
    expect((await workspace.getSnapshot()).workspace).toMatchObject({
      activePaneId: "primary",
      splitDirection: null,
      tabs: [
        { path: "Welcome.md", pinned: true, active: false },
        { path: "Third.md", pinned: true, active: true },
        { path: "Linked Note.md", pinned: false, active: false },
      ],
    });
  });

  it("promotes an existing destination tab when a pinned copy moves between panes", async () => {
    const workspace = await openRuntime();
    await workspace.splitWorkspace("vertical", workspace.vaultId);
    await workspace.focusWorkspacePane("primary", workspace.vaultId);
    await workspace.toggleTabPin("Linked Note.md", "primary", workspace.vaultId);

    const moved = await workspace.moveNoteToWorkspacePane(
      "Linked Note.md",
      "primary",
      "secondary",
      workspace.vaultId,
    );

    expect(moved.workspace).toMatchObject({
      activePaneId: "secondary",
      panes: [
        { id: "primary", tabs: [] },
        {
          id: "secondary",
          tabs: [{ path: "Linked Note.md", pinned: true, active: true }],
        },
      ],
    });
  });

  it("reconciles both pane histories when an active tab moves between panes", async () => {
    const store = new MemoryWorkspaceStateStore();
    const workspace = await openRuntime(store);
    await workspace.splitWorkspace("vertical", workspace.vaultId);
    await workspace.focusWorkspacePane("primary", workspace.vaultId);
    await workspace.openNote("Welcome.md", "primary");

    const moved = await workspace.moveNoteToWorkspacePane(
      "Welcome.md",
      "primary",
      "secondary",
      workspace.vaultId,
    );

    expect(moved.workspace?.panes).toMatchObject([
      {
        id: "primary",
        activeNote: { path: "Linked Note.md" },
        canGoBack: false,
        canGoForward: false,
      },
      {
        id: "secondary",
        activeNote: { path: "Welcome.md" },
        canGoBack: true,
        canGoForward: false,
      },
    ]);
    expect(store.saved.at(-1)?.panes).toMatchObject([
      { navigationHistory: { back: [], forward: [] } },
      { navigationHistory: { back: ["Linked Note.md"], forward: [] } },
    ]);

    const back = await workspace.goBack(workspace.vaultId, "secondary");
    expect(back.workspace?.panes[1]).toMatchObject({
      activeNote: { path: "Linked Note.md" },
      canGoBack: false,
      canGoForward: true,
    });
  });

  it("retains the focused pane history when collapsing a split layout", async () => {
    const store = new MemoryWorkspaceStateStore();
    const workspace = await openRuntime(store);
    await workspace.openNote("Welcome.md", "primary");
    await workspace.splitWorkspace("vertical", workspace.vaultId);
    await workspace.focusWorkspacePane("primary", workspace.vaultId);

    const collapsed = await workspace.closeWorkspacePane("secondary", workspace.vaultId);
    expect(collapsed.workspace?.panes[0]).toMatchObject({
      activeNote: { path: "Welcome.md" },
      canGoBack: true,
      canGoForward: false,
    });
    expect(store.saved.at(-1)?.panes[0]?.navigationHistory).toEqual({
      back: ["Linked Note.md"],
      forward: [],
    });

    const back = await workspace.goBack(workspace.vaultId, "primary");
    expect(back.workspace?.activeNote?.path).toBe("Linked Note.md");
  });

  it("splits into independent panes, focuses them, moves tabs, and closes a pane", async () => {
    const workspace = await openRuntime();

    const split = await workspace.splitWorkspace("vertical", workspace.vaultId);
    expect(split.workspace).toMatchObject({
      activePaneId: "secondary",
      splitDirection: "vertical",
      panes: [
        {
          id: "primary",
          active: false,
          tabs: [{ path: "Linked Note.md", active: true }],
          activeNote: { path: "Linked Note.md" },
        },
        {
          id: "secondary",
          active: true,
          tabs: [{ path: "Linked Note.md", active: true }],
          activeNote: { path: "Linked Note.md" },
        },
      ],
      tabs: [{ path: "Linked Note.md", active: true }],
      activeNote: { path: "Linked Note.md" },
    });

    const secondary = await workspace.openNote("Welcome.md", "secondary");
    expect(secondary.workspace?.panes[1]).toMatchObject({
      id: "secondary",
      tabs: [
        { path: "Linked Note.md", active: false },
        { path: "Welcome.md", active: true },
      ],
      activeNote: { path: "Welcome.md" },
    });

    const primary = await workspace.focusWorkspacePane("primary", workspace.vaultId);
    expect(primary.workspace).toMatchObject({
      activePaneId: "primary",
      activeNote: { path: "Linked Note.md" },
    });

    await workspace.openNote("Welcome.md", "primary");
    const moved = await workspace.moveNoteToWorkspacePane(
      "Welcome.md",
      "primary",
      "secondary",
      workspace.vaultId,
    );
    expect(moved.workspace).toMatchObject({
      activePaneId: "secondary",
      panes: [
        {
          id: "primary",
          tabs: [{ path: "Linked Note.md", active: true }],
          activeNote: { path: "Linked Note.md" },
        },
        {
          id: "secondary",
          tabs: [
            { path: "Linked Note.md", active: false },
            { path: "Welcome.md", active: true },
          ],
          activeNote: { path: "Welcome.md" },
        },
      ],
    });

    const closed = await workspace.closeWorkspacePane("secondary", workspace.vaultId);
    expect(closed.workspace).toMatchObject({
      activePaneId: "primary",
      splitDirection: null,
      panes: [
        {
          id: "primary",
          active: true,
          tabs: [
            { path: "Linked Note.md", active: false },
            { path: "Welcome.md", active: true },
          ],
        },
      ],
    });
    await expect(workspace.focusWorkspacePane("secondary", workspace.vaultId)).rejects.toThrow(
      "not open",
    );
    await expect(workspace.splitWorkspace("horizontal", "stale-vault")).rejects.toThrow(
      "active vault changed",
    );
  });

  it("restores both panes, their active tabs, focus, and split direction", async () => {
    const store = new MemoryWorkspaceStateStore();
    let workspace = await openRuntime(store);
    await workspace.splitWorkspace("horizontal", workspace.vaultId);
    await workspace.openNote("Welcome.md", "secondary");
    await workspace.focusWorkspacePane("primary", workspace.vaultId);
    await workspace.close();
    runtime = undefined;

    workspace = await openRuntime(store);
    expect((await workspace.getSnapshot()).workspace).toMatchObject({
      activePaneId: "primary",
      splitDirection: "horizontal",
      panes: [
        { id: "primary", activeNote: { path: "Linked Note.md" } },
        { id: "secondary", activeNote: { path: "Welcome.md" } },
      ],
    });
  });

  it("autosaves a background pane through the shared writer without stealing focus", async () => {
    const workspace = await openRuntime();
    await workspace.splitWorkspace("vertical", workspace.vaultId);
    const opened = await workspace.openNote("Welcome.md", "secondary");
    const secondaryNote = opened.workspace?.panes.find(({ id }) => id === "secondary")?.activeNote;
    if (!secondaryNote) throw new Error("Expected a note in the secondary pane.");
    await workspace.focusWorkspacePane("primary", workspace.vaultId);

    const saved = await workspace.saveNote(
      secondaryNote.path,
      "# Background autosave\n\nsecondary pane bytes\n",
      secondaryNote.revision,
      workspace.vaultId,
      "secondary",
    );

    expect(saved.outcome).toMatchObject({ status: "committed", path: "Welcome.md" });
    expect(saved.snapshot.workspace).toMatchObject({
      activePaneId: "primary",
      activeNote: { path: "Linked Note.md" },
      panes: [
        { id: "primary", activeNote: { path: "Linked Note.md" } },
        {
          id: "secondary",
          activeNote: {
            path: "Welcome.md",
            content: "# Background autosave\n\nsecondary pane bytes\n",
          },
        },
      ],
    });
    await expect(fs.readFile(path.join(vaultPath, "Welcome.md"), "utf8")).resolves.toBe(
      "# Background autosave\n\nsecondary pane bytes\n",
    );
  });

  it("detaches the bounded file projection across snapshots", async () => {
    const workspace = await openRuntime();

    const first = await workspace.getSnapshot();
    const second = await workspace.getSnapshot();

    expect(second.workspace?.files).toEqual(first.workspace?.files);
    expect(second.workspace?.files).not.toBe(first.workspace?.files);
  });

  it("restores ordered tabs, keeps one the vault has not listed, and prunes it once confirmed", async () => {
    const store = new MemoryWorkspaceStateStore({
      openPaths: ["Welcome.md", "Missing.md", "Linked Note.md"],
      pinnedPaths: ["Welcome.md", "Missing.md"],
      activePath: "Missing.md",
    });
    const clock = manualClock();
    const workspace = await openRuntime(store, undefined, undefined, undefined, clock.now);

    // A file the vault has not listed yet is not a file anyone deleted, and the
    // restore has watched nothing happen to it. The tab and its pin survive on
    // first sight, and no state that drops them is written back. The selection
    // does move: nothing readable has been published for the path this session,
    // so it cannot be what the pane renders yet.
    const snapshot = await workspace.getSnapshot();
    expect(snapshot.workspace).toMatchObject({
      tabs: [
        { path: "Welcome.md", active: false, pinned: true },
        { path: "Missing.md", active: false, pinned: true },
        { path: "Linked Note.md", active: true, pinned: false },
      ],
      activeNote: { path: "Linked Note.md" },
    });
    for (const saved of store.saved) {
      expect(saved.panes[0]?.openPaths).toContain("Missing.md");
      expect(saved.panes[0]?.pinnedPaths).toContain("Missing.md");
    }
    expect(snapshot.vault.warning).toBeNull();

    // It is still confirm-scanned, so a file deleted before this session started
    // does resolve away rather than keeping a tab forever.
    clock.advance(startupAbsenceSettleMs + 1);
    await workspace.reconcileNow();
    clock.advance(absenceConfirmationIntervalMs + 1);
    const pruned = await workspace.reconcileNow();
    expect(pruned.workspace).toMatchObject({
      tabs: [
        { path: "Welcome.md", active: false, pinned: true },
        { path: "Linked Note.md", active: true, pinned: false },
      ],
      activeNote: { path: "Linked Note.md" },
    });
    expect(store.saved.at(-1)).toMatchObject({
      panes: [
        {
          openPaths: ["Welcome.md", "Linked Note.md"],
          pinnedPaths: ["Welcome.md"],
          activePath: "Linked Note.md",
        },
      ],
    });
  });

  it("runs startup recovery before restoring and pruning workspace state", async () => {
    const store = new MemoryWorkspaceStateStore({
      openPaths: ["Missing.md", "Linked Note.md"],
      activePath: "Missing.md",
    });
    const events: string[] = [];
    const load = store.load.bind(store);
    store.load = async (vaultId) => {
      events.push("restore");
      return load(vaultId);
    };

    const clock = manualClock();
    const workspace = await openRuntime(
      store,
      undefined,
      async () => {
        events.push("recover");
      },
      undefined,
      clock.now,
    );

    expect(events).toEqual(["recover", "restore"]);
    expect((await workspace.getSnapshot()).workspace).toMatchObject({
      activeNote: { path: "Linked Note.md" },
    });
    expect(store.saved.at(-1)?.panes[0]?.openPaths).toEqual(["Missing.md", "Linked Note.md"]);

    clock.advance(startupAbsenceSettleMs + 1);
    await workspace.reconcileNow();
    clock.advance(absenceConfirmationIntervalMs + 1);
    await workspace.reconcileNow();
    expect(store.saved.at(-1)).toMatchObject({
      panes: [{ openPaths: ["Linked Note.md"], activePath: "Linked Note.md" }],
    });
  });

  it("persists tab order, active note, and an explicitly empty workspace across restarts", async () => {
    const store = new MemoryWorkspaceStateStore();
    let workspace = await openRuntime(store);
    await workspace.openNote("Welcome.md");
    await workspace.openNote("Linked Note.md");
    await workspace.close();
    runtime = undefined;

    workspace = await openRuntime(store);
    expect((await workspace.getSnapshot()).workspace).toMatchObject({
      tabs: [
        { path: "Linked Note.md", active: true },
        { path: "Welcome.md", active: false },
      ],
      activeNote: { path: "Linked Note.md" },
    });
    await workspace.closeNote("Linked Note.md", workspace.vaultId);
    await workspace.closeNote("Welcome.md", workspace.vaultId);
    await workspace.close();
    runtime = undefined;

    workspace = await openRuntime(store);
    expect((await workspace.getSnapshot()).workspace).toMatchObject({
      tabs: [],
      activeNote: null,
    });
  });

  it("falls back visibly without overwriting malformed workspace state", async () => {
    const store = new MemoryWorkspaceStateStore();
    store.loadError = new Error("invalid workspace document");
    const workspace = await openRuntime(store);

    const fallback = await workspace.getSnapshot();

    expect(fallback.workspace).toMatchObject({
      tabs: [{ path: "Linked Note.md", active: true }],
      activeNote: { path: "Linked Note.md" },
    });
    expect(fallback.vault.warning).toContain("invalid workspace document");
    expect(store.saved).toEqual([]);
  });

  it("keeps the current tabs when required workspace persistence fails", async () => {
    const store = new MemoryWorkspaceStateStore();
    const workspace = await openRuntime(store);
    store.saveError = new Error("workspace disk unavailable");

    await expect(workspace.openNote("Welcome.md")).rejects.toThrow(
      "Could not save workspace state: workspace disk unavailable",
    );
    const snapshot = await workspace.getSnapshot();
    expect(snapshot.workspace).toMatchObject({
      tabs: [{ path: "Linked Note.md", active: true }],
      activeNote: { path: "Linked Note.md" },
    });
    expect(snapshot.vault.warning).toContain("workspace disk unavailable");
  });

  it("does not report a committed vault write as failed when workspace persistence is unavailable", async () => {
    const store = new MemoryWorkspaceStateStore();
    const workspace = await openRuntime(store);
    store.saveError = new Error("workspace disk unavailable");

    const created = await workspace.createNote("Created.md", "# Created\n", workspace.vaultId);

    expect(created.outcome).toMatchObject({ status: "committed", path: "Created.md" });
    expect(created.snapshot.workspace).toMatchObject({
      activeNote: { path: "Created.md" },
    });
    expect(created.snapshot.vault.warning).toContain("workspace disk unavailable");
    await expect(fs.readFile(path.join(vaultPath, "Created.md"), "utf8")).resolves.toBe(
      "# Created\n",
    );
  });

  it("lists and renders templates, then creates or reopens today's daily note", async () => {
    await fs.mkdir(path.join(vaultPath, "Templates"));
    await fs.writeFile(
      path.join(vaultPath, "Templates", "Daily.md"),
      "# {{title}}\n{{date}} at {{time}}\n",
      "utf8",
    );
    await fs.writeFile(path.join(vaultPath, "Templates", "Meeting.md"), "## {{title}}\n", "utf8");
    const workspace = await openRuntime();
    const settings = {
      ...createDefaultVaultNoteWorkflowSettings(),
      dailyNoteFolder: "Journal",
      dailyNoteDateFormat: "YYYY/MM/YYYY-MM-DD",
      dailyNoteTemplate: "Templates/Daily.md",
    };
    const fixedNow = moment.parseZone("2026-08-12T18:07:09-04:00");

    await expect(workspace.listNoteTemplates("Templates", workspace.vaultId)).resolves.toEqual([
      "Templates/Daily.md",
      "Templates/Meeting.md",
    ]);
    await expect(
      workspace.renderNoteTemplate(
        "Templates/Meeting.md",
        "Projects/Kickoff.md",
        settings,
        workspace.vaultId,
        fixedNow,
      ),
    ).resolves.toMatchObject({
      content: "## Kickoff\n",
      sourcePath: "Templates/Meeting.md",
    });

    const created = await workspace.openDailyNote(settings, workspace.vaultId, fixedNow);
    expect(created.outcome).toMatchObject({
      status: "committed",
      path: "Journal/2026/08/2026-08-12.md",
    });
    expect(created.snapshot.workspace?.activeNote).toMatchObject({
      path: "Journal/2026/08/2026-08-12.md",
      content: "# 2026-08-12\n2026-08-12 at 18:07\n",
    });
    const revision = created.snapshot.workspace?.activeNote?.revision;
    if (!revision) {
      throw new Error("Expected the daily note revision.");
    }
    await workspace.saveNote(
      "Journal/2026/08/2026-08-12.md",
      "manual daily content",
      revision,
      workspace.vaultId,
    );
    const reopened = await workspace.openDailyNote(settings, workspace.vaultId, fixedNow);
    expect(reopened.outcome).toMatchObject({
      status: "exists",
      path: "Journal/2026/08/2026-08-12.md",
    });
    expect(reopened.snapshot.workspace?.activeNote?.content).toBe("manual daily content");
    await expect(fs.readFile(path.join(vaultPath, "Templates", "Daily.md"), "utf8")).resolves.toBe(
      "# {{title}}\n{{date}} at {{time}}\n",
    );
  });

  it("rejects stale vaults and template insertion outside the configured folder", async () => {
    const workspace = await openRuntime();
    const settings = createDefaultVaultNoteWorkflowSettings();

    await expect(workspace.listNoteTemplates("Templates", "stale-vault")).rejects.toThrow(
      "active vault changed",
    );
    await expect(
      workspace.renderNoteTemplate("Welcome.md", "Target.md", settings, workspace.vaultId),
    ).rejects.toThrow("configured template folder");
    await expect(workspace.openDailyNote(settings, "stale-vault")).rejects.toThrow(
      "active vault changed",
    );
  });

  it("keeps open tabs aligned with external note renames and deletions", async () => {
    const store = new MemoryWorkspaceStateStore();
    const clock = manualClock();
    const workspace = await openRuntime(store, undefined, undefined, undefined, clock.now);
    await workspace.openNote("Welcome.md");
    const pinned = await workspace.toggleTabPin("Welcome.md", "primary", workspace.vaultId);
    expect(pinned.workspace?.tabs).toContainEqual(
      expect.objectContaining({ path: "Welcome.md", pinned: true }),
    );

    await fs.rename(path.join(vaultPath, "Welcome.md"), path.join(vaultPath, "Renamed.md"));
    const renamed = await workspace.reconcileNow();
    expect(store.saved.at(-1)?.panes[0]?.pinnedPaths).toEqual(["Renamed.md"]);
    expect(renamed.workspace).toMatchObject({
      tabs: [
        { path: "Renamed.md", active: true, pinned: true },
        { path: "Linked Note.md", active: false, pinned: false },
      ],
      activeNote: { path: "Renamed.md" },
    });

    await fs.unlink(path.join(vaultPath, "Renamed.md"));
    // A deletion nothing in this process performed is accepted once it has
    // survived its settle window and a run of re-reads that all found it gone.
    // That is what tells a removal apart from the gap in the middle of an
    // outside writer's atomic replace, which no claim in this process covers.
    await workspace.reconcileNow();
    clock.advance(2000);
    await workspace.reconcileNow();
    clock.advance(absenceConfirmationIntervalMs + 1);
    const deleted = await workspace.reconcileNow();
    expect(store.saved.at(-1)?.panes[0]?.pinnedPaths).toEqual([]);
    expect(deleted.workspace).toMatchObject({
      tabs: [{ path: "Linked Note.md", active: true }],
      activeNote: { path: "Linked Note.md" },
    });
  });

  it("remaps and removes history entries when notes are renamed or deleted", async () => {
    const store = new MemoryWorkspaceStateStore();
    const clock = manualClock();
    const workspace = await openRuntime(store, undefined, undefined, undefined, clock.now);
    await workspace.openNote("Welcome.md");
    await workspace.openNote("Linked Note.md");

    await fs.rename(path.join(vaultPath, "Welcome.md"), path.join(vaultPath, "Renamed.md"));
    const renamed = await workspace.reconcileNow();
    expect(store.saved.at(-1)?.panes[0]?.navigationHistory).toEqual({
      back: ["Renamed.md"],
      forward: [],
    });
    const back = await workspace.goBack(workspace.vaultId);
    expect(back.workspace?.activeNote?.path).toBe("Renamed.md");

    await workspace.goForward(workspace.vaultId);
    await fs.unlink(path.join(vaultPath, "Renamed.md"));
    // History entries are scrubbed once the absence is confirmed, which is after
    // its settle window rather than on the pass straight after it was observed.
    await workspace.reconcileNow();
    clock.advance(2000);
    await workspace.reconcileNow();
    clock.advance(absenceConfirmationIntervalMs + 1);
    const deleted = await workspace.reconcileNow();
    expect(deleted.workspace?.activeNote?.path).toBe("Linked Note.md");
    expect(deleted.workspace?.panes[0]).toMatchObject({ canGoBack: false });
    expect(store.saved.at(-1)?.panes[0]?.navigationHistory).toEqual({
      back: [],
      forward: [],
    });
    expect(renamed.workspace?.panes[0]?.tabs.map(({ path: filePath }) => filePath)).toContain(
      "Renamed.md",
    );
  });

  it("moves an open note through the link-safe service and remaps its tab", async () => {
    const store = new MemoryWorkspaceStateStore();
    const workspace = await openRuntime(store);
    const opened = await workspace.openNote("Welcome.md");
    const note = opened.workspace?.activeNote;
    if (!note) {
      throw new Error("Expected an active note.");
    }
    const pinned = await workspace.toggleTabPin("Welcome.md", "primary", workspace.vaultId);
    expect(pinned.workspace?.tabs).toContainEqual(
      expect.objectContaining({ path: "Welcome.md", pinned: true }),
    );

    const moved = await workspace.moveNote(
      note.path,
      "Archive/Welcome",
      note.revision,
      workspace.vaultId,
    );
    expect(store.saved.at(-1)?.panes[0]?.pinnedPaths).toEqual(["Archive/Welcome.md"]);

    expect(moved.outcome).toMatchObject({
      status: "committed",
      from: "Welcome.md",
      to: "Archive/Welcome.md",
    });
    expect(moved.snapshot.workspace).toMatchObject({
      tabs: [
        { path: "Archive/Welcome.md", active: true, pinned: true },
        { path: "Linked Note.md", active: false, pinned: false },
      ],
      activeNote: { path: "Archive/Welcome.md", content: note.content },
    });
    await expect(fs.stat(path.join(vaultPath, "Welcome.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.readFile(path.join(vaultPath, "Archive", "Welcome.md"), "utf8")).resolves.toBe(
      note.content,
    );
  });

  it("moves attachment bytes with reference preview while preserving note tabs and index convergence", async () => {
    const bytes = Buffer.from("%PDF-1.7\nopaque attachment bytes\n", "ascii");
    await fs.mkdir(path.join(vaultPath, "Assets"), { recursive: true });
    await fs.mkdir(path.join(vaultPath, "Archive"), { recursive: true });
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), bytes);
    await fs.writeFile(
      path.join(vaultPath, "Attachment Desk.md"),
      "# Attachment Desk\n\n![[Assets/report.pdf|Report]]\n\n[download](Assets/report.pdf)\n",
      "utf8",
    );
    const store = new MemoryWorkspaceStateStore();
    const workspace = await openRuntime(store);
    const opened = await workspace.openNote("Attachment Desk.md");
    const note = opened.workspace?.activeNote;
    if (!note) throw new Error("Expected the attachment note to open.");
    await workspace.toggleTabPin(note.path, "primary", workspace.vaultId);
    const source = await workspace.kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected the attachment bytes.");

    const preview = await workspace.moveAttachment(
      "Assets/report.pdf",
      "Archive/report-renamed.pdf",
      source.snapshot.revision,
      workspace.vaultId,
    );
    expect(preview.outcome).toMatchObject({
      status: "requires-confirmation",
      rewrites: [
        expect.objectContaining({ documentPath: "Attachment Desk.md", syntax: "wiki" }),
        expect.objectContaining({ documentPath: "Attachment Desk.md", syntax: "markdown" }),
      ],
    });
    if (preview.outcome.status !== "requires-confirmation") {
      throw new Error("Expected an attachment move confirmation.");
    }
    expect(preview.snapshot.workspace?.tabs).toContainEqual(
      expect.objectContaining({ path: "Attachment Desk.md", pinned: true, active: true }),
    );
    await expect(
      fs.stat(path.join(vaultPath, "Archive", "report-renamed.pdf")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });

    const moved = await workspace.moveAttachment(
      "Assets/report.pdf",
      "Archive/report-renamed.pdf",
      source.snapshot.revision,
      workspace.vaultId,
      preview.outcome.confirmationId,
    );
    expect(moved.outcome).toMatchObject({
      status: "published-source-retained",
      from: "Assets/report.pdf",
      to: "Archive/report-renamed.pdf",
      writes: [{ path: "Attachment Desk.md" }],
    });
    expect(moved.snapshot.workspace?.tabs).toContainEqual(
      expect.objectContaining({ path: "Attachment Desk.md", pinned: true, active: true }),
    );
    await expect(
      fs.readFile(path.join(vaultPath, "Archive", "report-renamed.pdf")),
    ).resolves.toEqual(bytes);
    await expect(fs.readFile(path.join(vaultPath, "Assets", "report.pdf"))).resolves.toEqual(bytes);
    await expect(fs.readFile(path.join(vaultPath, "Attachment Desk.md"), "utf8")).resolves.toBe(
      "# Attachment Desk\n\n![[Archive/report-renamed.pdf|Report]]\n\n[download](Archive/report-renamed.pdf)\n",
    );

    await workspace.reconcileNow();
    expect(workspace.watcher.operations.size).toBe(0);
    const afterReconcile = await workspace.getSnapshot();
    expect(afterReconcile.workspace?.activeNote?.content).toContain("Archive/report-renamed.pdf");
  });

  it("routes an explicit attachment rename through the source-removing kernel outcome", async () => {
    const bytes = Buffer.from("%PDF-1.7\nrename attachment bytes\n", "ascii");
    await fs.mkdir(path.join(vaultPath, "Assets"), { recursive: true });
    await fs.mkdir(path.join(vaultPath, "Archive"), { recursive: true });
    await fs.writeFile(path.join(vaultPath, "Assets", "rename.pdf"), bytes);
    await fs.writeFile(
      path.join(vaultPath, "Rename Desk.md"),
      "# Rename Desk\n\n![[Assets/rename.pdf]]\n",
      "utf8",
    );
    const workspace = await openRuntime();
    await workspace.openNote("Rename Desk.md");
    const source = await workspace.kernel.readBinary("Assets/rename.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected the attachment bytes.");

    const preview = await workspace.moveAttachment(
      "Assets/rename.pdf",
      "Archive/renamed.pdf",
      source.snapshot.revision,
      workspace.vaultId,
      undefined,
      "rename",
    );
    if (preview.outcome.status !== "requires-confirmation") {
      throw new Error("Expected an attachment rename confirmation.");
    }
    const moved = await workspace.moveAttachment(
      "Assets/rename.pdf",
      "Archive/renamed.pdf",
      source.snapshot.revision,
      workspace.vaultId,
      preview.outcome.confirmationId,
      "rename",
    );
    expect(moved.outcome).toMatchObject({
      status: "committed",
      from: "Assets/rename.pdf",
      to: "Archive/renamed.pdf",
      writes: [{ path: "Rename Desk.md" }],
    });
    await expect(fs.stat(path.join(vaultPath, "Assets", "rename.pdf"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.readFile(path.join(vaultPath, "Archive", "renamed.pdf"))).resolves.toEqual(
      bytes,
    );
    expect(moved.snapshot.workspace?.activeNote?.content).toContain("Archive/renamed.pdf");
  });

  it("rejects attachment publication outside visible vault containment without echoing the request", async () => {
    const workspace = await openRuntime();
    const source = await workspace.kernel.readBinary("Welcome.md", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected a bounded source read.");
    await expect(
      workspace.moveAttachment(
        "../outside.bin",
        "Archive/outside.bin",
        source.snapshot.revision,
        workspace.vaultId,
      ),
    ).rejects.toThrow("safe vault-relative files");
    await expect(
      workspace.moveAttachment(
        ".obsidian/private.bin",
        "Archive/private.bin",
        source.snapshot.revision,
        workspace.vaultId,
      ),
    ).rejects.toThrow("safe vault-relative files");
  });

  it("previews exact link rewrites and commits them only with the matching confirmation", async () => {
    const workspace = await openRuntime();
    const snapshot = await workspace.getSnapshot();
    const note = snapshot.workspace?.activeNote;
    if (!note) {
      throw new Error("Expected an active note.");
    }
    await expect(
      workspace.moveNote(note.path, "Renamed", note.revision, "stale-vault"),
    ).rejects.toThrow("active vault changed");

    const preview = await workspace.moveNote(
      note.path,
      "Renamed",
      note.revision,
      workspace.vaultId,
    );

    expect(preview.outcome).toMatchObject({
      status: "requires-confirmation",
      from: "Linked Note.md",
      to: "Renamed.md",
      confirmationId: expect.stringMatching(/^[a-f0-9]{64}$/),
      rewrites: [
        {
          documentPath: "Welcome.md",
          resultPath: "Welcome.md",
          syntax: "wiki",
          beforeTarget: "Linked Note",
          afterTarget: "Renamed",
          line: 9,
        },
        {
          documentPath: "Welcome.md",
          resultPath: "Welcome.md",
          syntax: "wiki",
          beforeTarget: "Linked Note",
          afterTarget: "Renamed",
          line: 20,
        },
      ],
    });
    expect(preview.snapshot.workspace).toMatchObject({
      tabs: [{ path: "Linked Note.md", active: true }],
      activeNote: { path: "Linked Note.md" },
    });
    await expect(fs.readFile(path.join(vaultPath, "Linked Note.md"), "utf8")).resolves.toBe(
      note.content,
    );
    await expect(fs.stat(path.join(vaultPath, "Renamed.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    if (preview.outcome.status !== "requires-confirmation") {
      throw new Error("Expected a move confirmation preview.");
    }
    const moved = await workspace.moveNote(
      note.path,
      "Renamed",
      note.revision,
      workspace.vaultId,
      preview.outcome.confirmationId,
    );

    expect(moved.outcome).toMatchObject({
      status: "committed",
      from: "Linked Note.md",
      to: "Renamed.md",
      rewrites: preview.outcome.rewrites,
      writes: [{ path: "Welcome.md", resultPath: "Welcome.md" }],
    });
    expect(moved.snapshot.workspace).toMatchObject({
      tabs: [{ path: "Renamed.md", active: true }],
      activeNote: { path: "Renamed.md" },
    });
    await expect(fs.readFile(path.join(vaultPath, "Welcome.md"), "utf8")).resolves.toContain(
      "[[Renamed]]",
    );
  });

  it("moves an exact note to recoverable trash and selects the right surviving tab", async () => {
    const store = new MemoryWorkspaceStateStore();
    const workspace = await openRuntime(store);
    await workspace.openNote("Welcome.md");
    const opened = await workspace.openNote("Linked Note.md");
    const note = opened.workspace?.activeNote;
    if (!note) {
      throw new Error("Expected an active note.");
    }

    const deleted = await workspace.deleteNote(note.path, note.revision, workspace.vaultId);

    expect(deleted.outcome).toMatchObject({
      status: "committed",
      from: "Linked Note.md",
      to: ".trash/Linked Note.md",
    });
    expect(deleted.snapshot.workspace).toMatchObject({
      files: [{ path: "Welcome.md", unresolvedCount: 2 }],
      tabs: [{ path: "Welcome.md", active: true }],
      activeNote: {
        path: "Welcome.md",
        outgoing: [
          { target: "Linked Note", status: "unresolved", embed: false, subpath: null },
          {
            target: "Linked Note",
            status: "unresolved",
            embed: true,
            subpath: "#Project brief",
          },
        ],
      },
    });
    expect(store.saved.at(-1)).toMatchObject({
      panes: [{ openPaths: ["Welcome.md"], activePath: "Welcome.md" }],
    });
    await expect(fs.stat(path.join(vaultPath, "Linked Note.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.readFile(path.join(vaultPath, ".trash", "Linked Note.md"), "utf8"),
    ).resolves.toBe(note.content);
    expect((await workspace.searchVault("linked note")).results).toEqual([
      expect.objectContaining({ path: "Welcome.md" }),
    ]);
  });

  it("lists recoverable trash and restores exact bytes through the live index", async () => {
    const workspace = await openRuntime();
    const opened = await workspace.openNote("Linked Note.md");
    const note = opened.workspace?.activeNote;
    if (!note) {
      throw new Error("Expected an active note.");
    }
    await workspace.deleteNote(note.path, note.revision, workspace.vaultId);

    const trash = await workspace.getVaultTrash(workspace.vaultId);
    expect(trash).toMatchObject({
      status: "ready",
      vaultId: workspace.vaultId,
      total: 1,
      truncated: false,
      entries: [
        {
          path: "Linked Note.md",
          trashPath: ".trash/Linked Note.md",
          revision: expect.stringMatching(/^[a-f0-9]{64}$/),
          size: Buffer.byteLength(note.content),
        },
      ],
    });
    if (trash.status !== "ready" || !trash.entries[0]) {
      throw new Error("Expected one recoverable trash entry.");
    }

    const restored = await workspace.restoreNote(
      trash.entries[0].path,
      trash.entries[0].revision,
      workspace.vaultId,
    );

    expect(restored.outcome).toMatchObject({
      status: "committed",
      from: ".trash/Linked Note.md",
      to: "Linked Note.md",
    });
    expect(restored.snapshot.workspace).toMatchObject({
      files: [{ path: "Linked Note.md" }, { path: "Welcome.md", unresolvedCount: 0 }],
      tabs: [],
      activeNote: null,
    });
    await expect(fs.readFile(path.join(vaultPath, "Linked Note.md"), "utf8")).resolves.toBe(
      note.content,
    );
    await expect(fs.stat(path.join(vaultPath, ".trash", "Linked Note.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(workspace.getVaultTrash(workspace.vaultId)).resolves.toMatchObject({
      status: "ready",
      total: 0,
      entries: [],
    });
  });

  it("keeps both files when a recovery entry changes or its destination is occupied", async () => {
    const workspace = await openRuntime();
    const opened = await workspace.openNote("Linked Note.md");
    const note = opened.workspace?.activeNote;
    if (!note) {
      throw new Error("Expected an active note.");
    }
    await workspace.deleteNote(note.path, note.revision, workspace.vaultId);
    const trash = await workspace.getVaultTrash(workspace.vaultId);
    if (trash.status !== "ready" || !trash.entries[0]) {
      throw new Error("Expected one recoverable trash entry.");
    }

    await fs.writeFile(path.join(vaultPath, ".trash", note.path), "new trash bytes", "utf8");
    const stale = await workspace.restoreNote(
      note.path,
      trash.entries[0].revision,
      workspace.vaultId,
    );
    expect(stale.outcome).toMatchObject({ status: "conflict", reason: "source-revision-changed" });
    await expect(fs.stat(path.join(vaultPath, note.path))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const currentTrash = await workspace.getVaultTrash(workspace.vaultId);
    if (currentTrash.status !== "ready" || !currentTrash.entries[0]) {
      throw new Error("Expected the changed recovery entry.");
    }
    await fs.writeFile(path.join(vaultPath, note.path), "replacement", "utf8");
    const occupied = await workspace.restoreNote(
      note.path,
      currentTrash.entries[0].revision,
      workspace.vaultId,
    );
    expect(occupied.outcome).toMatchObject({ status: "conflict", reason: "target-exists" });
    await expect(fs.readFile(path.join(vaultPath, note.path), "utf8")).resolves.toBe("replacement");
    await expect(fs.readFile(path.join(vaultPath, ".trash", note.path), "utf8")).resolves.toBe(
      "new trash bytes",
    );
  });

  it("rejects stale vaults, stale revisions, and occupied trash paths without changing tabs", async () => {
    const workspace = await openRuntime();
    const initial = await workspace.getSnapshot();
    const note = initial.workspace?.activeNote;
    if (!note) {
      throw new Error("Expected an active note.");
    }

    await expect(workspace.deleteNote(note.path, note.revision, "stale-vault")).rejects.toThrow(
      "active vault changed",
    );
    await fs.writeFile(path.join(vaultPath, note.path), "external edit", "utf8");
    const stale = await workspace.deleteNote(note.path, note.revision, workspace.vaultId);
    expect(stale.outcome).toMatchObject({
      status: "conflict",
      reason: "source-revision-changed",
    });
    expect(stale.snapshot.workspace).toMatchObject({
      tabs: [{ path: note.path, active: true }],
      activeNote: { path: note.path, content: "external edit" },
    });
    await expect(fs.readFile(path.join(vaultPath, note.path), "utf8")).resolves.toBe(
      "external edit",
    );

    await fs.mkdir(path.join(vaultPath, ".trash"), { recursive: true });
    await fs.writeFile(path.join(vaultPath, ".trash", note.path), "earlier deletion", "utf8");
    const current = await workspace.kernel.readText(note.path);
    const occupied = await workspace.deleteNote(note.path, current.revision, workspace.vaultId);
    expect(occupied.outcome).toMatchObject({ status: "conflict", reason: "target-exists" });
    expect(occupied.snapshot.workspace?.tabs).toEqual([
      expect.objectContaining({ path: note.path, active: true }),
    ]);
    await expect(fs.readFile(path.join(vaultPath, ".trash", note.path), "utf8")).resolves.toBe(
      "earlier deletion",
    );
  });

  it("does not report a committed trash move as failed when workspace persistence is unavailable", async () => {
    const store = new MemoryWorkspaceStateStore();
    const workspace = await openRuntime(store);
    const note = (await workspace.getSnapshot()).workspace?.activeNote;
    if (!note) {
      throw new Error("Expected an active note.");
    }
    store.saveError = new Error("workspace disk unavailable");

    const deleted = await workspace.deleteNote(note.path, note.revision, workspace.vaultId);

    expect(deleted.outcome.status).toBe("committed");
    expect(deleted.snapshot.workspace).toMatchObject({
      tabs: [],
      activeNote: null,
    });
    expect(deleted.snapshot.vault.warning).toContain("workspace disk unavailable");
    await expect(fs.readFile(path.join(vaultPath, ".trash", note.path), "utf8")).resolves.toBe(
      note.content,
    );
  });

  it("creates a nested Markdown note through the recoverable writer and selects it", async () => {
    const workspace = await openRuntime();

    const created = await workspace.createNote(
      "Projects/New thread",
      "# New thread\n\n#fresh and [[Welcome]]\n",
      workspace.vaultId,
    );

    expect(created.outcome).toMatchObject({
      status: "committed",
      path: "Projects/New thread.md",
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(created.snapshot.workspace?.activeNote).toMatchObject({
      path: "Projects/New thread.md",
      title: "New thread",
      tags: ["fresh"],
      outgoing: [expect.objectContaining({ path: "Welcome.md", status: "resolved" })],
    });
    expect(created.snapshot.workspace?.panes[0]).toMatchObject({
      canGoBack: true,
      canGoForward: false,
    });
    const returned = await workspace.goBack(workspace.vaultId);
    expect(returned.workspace?.activeNote?.path).toBe("Linked Note.md");
    await expect(
      fs.readFile(path.join(vaultPath, "Projects", "New thread.md"), "utf8"),
    ).resolves.toBe("# New thread\n\n#fresh and [[Welcome]]\n");
  });

  it("reports an existing note without changing it or creating a conflict copy", async () => {
    const workspace = await openRuntime();
    const before = await fs.readFile(path.join(vaultPath, "Welcome.md"), "utf8");

    const result = await workspace.createNote("Welcome", "replacement", workspace.vaultId);

    expect(result.outcome).toMatchObject({
      status: "exists",
      path: "Welcome.md",
      currentRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await expect(fs.readFile(path.join(vaultPath, "Welcome.md"), "utf8")).resolves.toBe(before);
    expect((await fs.readdir(vaultPath)).filter((name) => name.includes("conflict"))).toEqual([]);
  });

  it("creates plugin-owned folders and Markdown files without replacing the active native note", async () => {
    const workspace = await openRuntime();
    await workspace.openNote("Welcome.md");

    await expect(workspace.createPluginFolder("Excalidraw", workspace.vaultId)).resolves.toEqual({
      path: "Excalidraw",
      created: true,
    });
    const outcome = await workspace.createPluginNote(
      "Excalidraw/Drawing.excalidraw.md",
      "---\nexcalidraw-plugin: parsed\n---\n",
      workspace.vaultId,
    );

    expect(outcome).toMatchObject({
      status: "committed",
      path: "Excalidraw/Drawing.excalidraw.md",
    });
    const snapshot = await workspace.getSnapshot();
    expect(snapshot.workspace?.activeNote?.path).toBe("Welcome.md");
    expect(snapshot.workspace?.files.map(({ path: filePath }) => filePath)).toContain(
      "Excalidraw/Drawing.excalidraw.md",
    );
    await expect(
      fs.readFile(path.join(vaultPath, "Excalidraw", "Drawing.excalidraw.md"), "utf8"),
    ).resolves.toContain("excalidraw-plugin: parsed");
    await expect(
      workspace.createPluginFolder(".obsidian/Generated", workspace.vaultId),
    ).rejects.toThrow("private application paths");
    await expect(
      workspace.createPluginNote("Excalidraw/Wrong.md", "", "stale-vault"),
    ).rejects.toThrow("active vault changed");
  });

  it("refuses plugin-owned Markdown trash while the same tab is pinned", async () => {
    const workspace = await openRuntime();
    const created = await workspace.createPluginNote(
      "Excalidraw/Pinned.excalidraw.md",
      "pinned drawing",
      workspace.vaultId,
    );
    if (created.status !== "committed") {
      throw new Error("Expected the plugin Markdown note to be created.");
    }
    await workspace.openNote(created.path);
    await workspace.toggleTabPin(created.path, "primary", workspace.vaultId);

    await expect(
      workspace.trashPluginFile(created.path, created.revision, workspace.vaultId),
    ).rejects.toThrow("Unpin this tab before closing it.");
    await expect(
      fs.readFile(path.join(vaultPath, "Excalidraw", "Pinned.excalidraw.md"), "utf8"),
    ).resolves.toBe("pinned drawing");

    await workspace.toggleTabPin(created.path, "primary", workspace.vaultId);
    await expect(
      workspace.trashPluginFile(created.path, created.revision, workspace.vaultId),
    ).resolves.toMatchObject({ status: "committed", from: created.path });
  });

  it("creates and revision-binds plugin text and binary files outside the Markdown index", async () => {
    const workspace = await openRuntime();
    await workspace.openNote("Welcome.md");
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>',
      "utf8",
    );
    const firstPng = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0xff]);
    const secondPng = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 0, 0xff]);

    const createdSvg = await workspace.createPluginFile(
      "Exports/Drawing.svg",
      svg,
      workspace.vaultId,
    );
    const createdPng = await workspace.createPluginFile(
      "Exports/Drawing.png",
      firstPng,
      workspace.vaultId,
    );
    expect(createdSvg.status).toBe("committed");
    expect(createdPng.status).toBe("committed");
    if (createdPng.status !== "committed") {
      throw new Error("Expected plugin binary creation to commit.");
    }
    const modifiedPng = await workspace.writePluginFile(
      "Exports/Drawing.png",
      secondPng,
      createdPng.revision,
      workspace.vaultId,
    );
    expect(modifiedPng.status).toBe("committed");
    if (modifiedPng.status !== "committed") {
      throw new Error("Expected plugin binary modification to commit.");
    }
    const renamedPng = await workspace.renamePluginFile(
      "Exports/Drawing.png",
      "Assets/Renamed Drawing.png",
      modifiedPng.revision,
      workspace.vaultId,
    );
    expect(renamedPng).toMatchObject({
      status: "committed",
      from: "Exports/Drawing.png",
      to: "Assets/Renamed Drawing.png",
    });
    await expect(fs.readFile(path.join(vaultPath, "Exports", "Drawing.svg"))).resolves.toEqual(svg);
    await expect(fs.readFile(path.join(vaultPath, "Exports", "Drawing.png"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
    await expect(
      fs.readFile(path.join(vaultPath, "Assets", "Renamed Drawing.png")),
    ).resolves.toEqual(Buffer.from(secondPng));
    await expect(
      workspace.createPluginFile("Assets/Renamed Drawing.png", firstPng, workspace.vaultId),
    ).resolves.toMatchObject({ status: "exists", path: "Assets/Renamed Drawing.png" });
    const trashedPng = await workspace.trashPluginFile(
      "Assets/Renamed Drawing.png",
      modifiedPng.revision,
      workspace.vaultId,
    );
    expect(trashedPng).toMatchObject({
      status: "committed",
      from: "Assets/Renamed Drawing.png",
      to: ".trash/Assets/Renamed Drawing.png",
    });
    await expect(
      fs.readFile(path.join(vaultPath, "Assets", "Renamed Drawing.png")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.readFile(path.join(vaultPath, ".trash", "Assets", "Renamed Drawing.png")),
    ).resolves.toEqual(Buffer.from(secondPng));
    expect((await workspace.getSnapshot()).workspace?.activeNote?.path).toBe("Welcome.md");
    expect(
      (await workspace.getSnapshot()).workspace?.files.map(({ path: filePath }) => filePath),
    ).not.toContain("Exports/Drawing.svg");
    await expect(
      workspace.createPluginFile("Exports/Wrong.png", firstPng, "stale-vault"),
    ).rejects.toThrow("active vault changed");
    await expect(
      workspace.createPluginFile(".obsidian/Generated.png", firstPng, workspace.vaultId),
    ).rejects.toThrow("private application paths");
  });

  it("acknowledges plugin mutation conflicts without re-entering the plugin runtime", async () => {
    const workspace = await openRuntime();
    await workspace.watcher.close();
    const pluginSnapshot = vi.spyOn(workspace.pluginHost, "getSnapshot");
    pluginSnapshot.mockClear();

    const created = await workspace.createPluginFile(
      "Drawings/Scene.excalidraw.md",
      Buffer.from("plugin original", "utf8"),
      workspace.vaultId,
    );
    if (created.status !== "committed") {
      throw new Error("Expected the plugin drawing fixture to commit.");
    }
    await fs.writeFile(
      path.join(vaultPath, "Drawings", "Scene.excalidraw.md"),
      "external winner",
      "utf8",
    );

    await expect(
      workspace.writePluginFile(
        "Drawings/Scene.excalidraw.md",
        Buffer.from("plugin proposal", "utf8"),
        created.revision,
        workspace.vaultId,
      ),
    ).resolves.toMatchObject({ status: "conflict" });
    expect(pluginSnapshot).not.toHaveBeenCalled();
  });

  it("returns a plugin rename conflict after an external edit and rebuilds the Markdown index", async () => {
    const workspace = await openRuntime();
    const created = await workspace.createPluginNote(
      "Excalidraw/Scene.excalidraw.md",
      "original drawing",
      workspace.vaultId,
    );
    if (created.status !== "committed") {
      throw new Error("Expected the Excalidraw fixture to be created.");
    }
    await fs.writeFile(
      path.join(vaultPath, "Excalidraw", "Scene.excalidraw.md"),
      "external drawing",
      "utf8",
    );

    await expect(
      workspace.renamePluginFile(
        "Excalidraw/Scene.excalidraw.md",
        "Excalidraw/Renamed.excalidraw.md",
        created.revision,
        workspace.vaultId,
      ),
    ).resolves.toMatchObject({ status: "conflict", reason: "source-revision-changed" });
    await expect(
      fs.readFile(path.join(vaultPath, "Excalidraw", "Scene.excalidraw.md"), "utf8"),
    ).resolves.toBe("external drawing");
    await expect(
      fs.stat(path.join(vaultPath, "Excalidraw", "Renamed.excalidraw.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await workspace.getSnapshot()).workspace?.files).toContainEqual(
      expect.objectContaining({ path: "Excalidraw/Scene.excalidraw.md" }),
    );
    await expect(
      workspace.renamePluginFile(
        "Excalidraw/Scene.excalidraw.md",
        ".obsidian/Renamed.excalidraw.md",
        created.revision,
        workspace.vaultId,
      ),
    ).rejects.toThrow("private application paths");
    await expect(
      workspace.renamePluginFile(
        "Excalidraw/Scene.excalidraw.md",
        "Excalidraw/Renamed.excalidraw.md",
        created.revision,
        "stale-vault",
      ),
    ).rejects.toThrow("active vault changed");
    await expect(
      workspace.trashPluginFile(
        "Excalidraw/Scene.excalidraw.md",
        created.revision,
        workspace.vaultId,
      ),
    ).resolves.toMatchObject({ status: "conflict", reason: "source-revision-changed" });
    await expect(
      workspace.trashPluginFile(
        ".obsidian/Scene.excalidraw.md",
        created.revision,
        workspace.vaultId,
      ),
    ).rejects.toThrow("private application paths");
    await expect(
      workspace.trashPluginFile("Excalidraw/Scene.excalidraw.md", created.revision, "stale-vault"),
    ).rejects.toThrow("active vault changed");
  });

  it("preserves a create race as a selected conflict note without overwriting the winner", async () => {
    const workspace = await openRuntime();
    const writeText = workspace.kernel.writeText.bind(workspace.kernel);
    vi.spyOn(workspace.kernel, "writeText").mockImplementationOnce(async (...args) => {
      await fs.writeFile(path.join(vaultPath, "Race.md"), "external winner", "utf8");
      return writeText(...args);
    });

    const result = await workspace.createNote("Race", "my draft", workspace.vaultId);

    expect(result.outcome).toMatchObject({ status: "conflict", path: "Race.md" });
    if (result.outcome.status !== "conflict") {
      throw new Error("Expected the create race to return a conflict.");
    }
    await expect(fs.readFile(path.join(vaultPath, "Race.md"), "utf8")).resolves.toBe(
      "external winner",
    );
    await expect(
      fs.readFile(path.join(vaultPath, result.outcome.conflictPath), "utf8"),
    ).resolves.toBe("my draft");
    expect(result.snapshot.workspace?.activeNote).toMatchObject({
      path: result.outcome.conflictPath,
      content: "my draft",
    });
  });

  it("rejects stale-vault and private create or save requests before writing", async () => {
    const workspace = await openRuntime();

    await expect(workspace.createNote("Wrong vault", "", "stale-vault")).rejects.toThrow(
      "active vault changed",
    );
    await expect(workspace.createNote(".obsidian/Private", "", workspace.vaultId)).rejects.toThrow(
      "private application",
    );
    await expect(workspace.createNote(".trash/Private", "", workspace.vaultId)).rejects.toThrow(
      "private application",
    );
    await expect(workspace.createNote("../Outside", "", workspace.vaultId)).rejects.toThrow(
      "traversal",
    );
    const opened = await workspace.openNote("Welcome.md");
    const revision = opened.workspace?.activeNote?.revision;
    if (!revision) {
      throw new Error("Expected an active note revision.");
    }
    await expect(
      workspace.saveNote(".trash/Welcome.md", "private", revision, workspace.vaultId),
    ).rejects.toThrow("private application");
    await expect(fs.stat(path.join(vaultPath, "Wrong vault.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("saves through the recoverable writer and refreshes derived metadata", async () => {
    const workspace = await openRuntime();
    const opened = await workspace.openNote("Welcome.md");
    const revision = opened.workspace?.activeNote?.revision;
    if (!revision) {
      throw new Error("Expected an active note revision.");
    }

    const saved = await workspace.saveNote(
      "Welcome.md",
      "# Saved in Threadleaf\n\n#edited and [[Linked Note]]",
      revision,
      workspace.vaultId,
      "primary",
    );

    expect(saved.outcome).toMatchObject({ status: "committed", path: "Welcome.md" });
    expect(saved.snapshot.workspace?.activeNote).toMatchObject({
      path: "Welcome.md",
      content: "# Saved in Threadleaf\n\n#edited and [[Linked Note]]",
      tags: ["edited"],
      headings: [{ level: 1, text: "Saved in Threadleaf", line: 1 }],
      outgoing: [
        {
          label: "Linked Note",
          status: "resolved",
          path: "Linked Note.md",
          target: "Linked Note",
          subpath: null,
          embed: false,
          syntax: "wiki",
        },
      ],
    });
    await expect(fs.readFile(path.join(vaultPath, "Welcome.md"), "utf8")).resolves.toBe(
      "# Saved in Threadleaf\n\n#edited and [[Linked Note]]",
    );
  });

  it("views, sets, changes, and removes every supported desktop property type", async () => {
    const workspace = await openRuntime();
    let snapshot = await workspace.openNote("Welcome.md");
    expect(snapshot.workspace?.activeNote).toMatchObject({
      properties: [
        {
          name: "kind",
          type: "text",
          value: "compatibility-fixture",
          rawValue: "compatibility-fixture",
        },
      ],
      propertyEditor: { editable: true, message: null },
    });

    const cases = [
      ["status", "review", "text", "review"],
      ["aliases", '["Brief","Overview"]', "list", ["Brief", "Overview"]],
      ["priority", "3.5", "number", 3.5],
      ["published", "true", "checkbox", true],
      ["due", "2026-08-12", "date", "2026-08-12"],
      ["meeting", "2026-08-12T14:30:45", "datetime", "2026-08-12T14:30:45"],
    ] as const;
    for (const [name, rawValue, type, expectedValue] of cases) {
      const note = snapshot.workspace?.activeNote;
      if (!note) {
        throw new Error("Expected an active note while setting properties.");
      }
      const response = await workspace.setNoteProperty(
        note.path,
        name,
        rawValue,
        type,
        note.revision,
        workspace.vaultId,
      );
      expect(response.outcome).toMatchObject({
        status: "committed",
        name,
        type,
        value: expectedValue,
      });
      snapshot = response.snapshot;
    }

    expect(snapshot.workspace?.activeNote?.properties).toEqual([
      expect.objectContaining({ name: "kind", type: "text" }),
      expect.objectContaining({ name: "status", type: "text", value: "review" }),
      expect.objectContaining({ name: "aliases", type: "list", value: ["Brief", "Overview"] }),
      expect.objectContaining({ name: "priority", type: "number", value: 3.5 }),
      expect.objectContaining({ name: "published", type: "checkbox", value: true }),
      expect.objectContaining({ name: "due", type: "date", value: "2026-08-12" }),
      expect.objectContaining({
        name: "meeting",
        type: "datetime",
        value: "2026-08-12T14:30:45",
      }),
    ]);

    const current = snapshot.workspace?.activeNote;
    if (!current) {
      throw new Error("Expected the property-bearing note.");
    }
    const removed = await workspace.removeNoteProperty(
      current.path,
      "status",
      current.revision,
      workspace.vaultId,
    );
    expect(removed.outcome).toMatchObject({ status: "committed", name: "status" });
    expect(removed.snapshot.workspace?.activeNote?.properties).not.toContainEqual(
      expect.objectContaining({ name: "status" }),
    );
    const afterRemoval = removed.snapshot.workspace?.activeNote;
    if (!afterRemoval) {
      throw new Error("Expected the note after property removal.");
    }
    const missing = await workspace.removeNoteProperty(
      afterRemoval.path,
      "missing",
      afterRemoval.revision,
      workspace.vaultId,
    );
    expect(missing.outcome).toMatchObject({ status: "missing", name: "missing" });
  });

  it("refuses a stale property panel and preserves a raced proposal as a conflict note", async () => {
    const workspace = await openRuntime();
    const opened = await workspace.openNote("Welcome.md");
    const note = opened.workspace?.activeNote;
    if (!note) {
      throw new Error("Expected an active note.");
    }

    await fs.writeFile(path.join(vaultPath, note.path), "---\nexternal: true\n---\nWinner", "utf8");
    const stale = await workspace.setNoteProperty(
      note.path,
      "status",
      "review",
      "text",
      note.revision,
      workspace.vaultId,
    );
    expect(stale.outcome).toMatchObject({ status: "stale", name: "status" });
    expect(stale.snapshot.workspace?.activeNote).toMatchObject({
      content: "---\nexternal: true\n---\nWinner",
      properties: [expect.objectContaining({ name: "external", type: "checkbox", value: true })],
    });

    const current = stale.snapshot.workspace?.activeNote;
    if (!current) {
      throw new Error("Expected the refreshed external note.");
    }
    const writeText = workspace.kernel.writeText.bind(workspace.kernel);
    vi.spyOn(workspace.kernel, "writeText").mockImplementationOnce(
      async (filePath, content, expectedRevision) => {
        await fs.writeFile(path.join(vaultPath, filePath), "External race winner", "utf8");
        return writeText(filePath, content, expectedRevision);
      },
    );
    const raced = await workspace.setNoteProperty(
      current.path,
      "priority",
      "4",
      "number",
      current.revision,
      workspace.vaultId,
    );
    expect(raced.outcome).toMatchObject({
      status: "conflict",
      name: "priority",
      value: 4,
      conflictPath: expect.stringContaining("threadleaf-conflict"),
    });
    if (raced.outcome.status !== "conflict") {
      throw new Error("Expected a property conflict.");
    }
    await expect(fs.readFile(path.join(vaultPath, current.path), "utf8")).resolves.toBe(
      "External race winner",
    );
    await expect(
      fs.readFile(path.join(vaultPath, raced.outcome.conflictPath), "utf8"),
    ).resolves.toContain("priority: 4");
    expect(raced.snapshot.workspace?.activeNote).toMatchObject({
      path: raced.outcome.conflictPath,
      properties: expect.arrayContaining([
        expect.objectContaining({ name: "priority", type: "number", value: 4 }),
      ]),
    });
  });

  it("searches current saved bytes with vault identity and contextual lines", async () => {
    const workspace = await openRuntime();

    const initial = await workspace.searchVault('"synthetic vault" proves');
    expect(initial).toMatchObject({
      vaultId: workspace.vaultId,
      error: null,
      query: '"synthetic vault" proves',
      terms: ["synthetic vault", "proves"],
      total: 1,
      truncated: false,
      results: [
        {
          path: "Welcome.md",
          title: "Welcome",
          contexts: [
            {
              kind: "content",
              line: 7,
              text: "This synthetic vault proves that the runtime can discover ordinary Markdown without changing it.",
            },
          ],
        },
      ],
    });

    const opened = await workspace.openNote("Welcome.md");
    const note = opened.workspace?.activeNote;
    if (!note) {
      throw new Error("Expected an active note.");
    }
    await workspace.saveNote(
      note.path,
      "# Search replacement\n\nnew-index-needle",
      note.revision,
      workspace.vaultId,
    );

    expect((await workspace.searchVault("synthetic vault")).total).toBe(0);
    expect((await workspace.searchVault("new-index-needle")).results[0]).toMatchObject({
      path: "Welcome.md",
      contexts: [{ kind: "content", line: 3, text: "new-index-needle" }],
    });

    await expect(workspace.searchVault("x".repeat(257))).resolves.toMatchObject({
      vaultId: workspace.vaultId,
      error: "Search queries may contain at most 256 characters.",
      total: 0,
      results: [],
    });
  });

  it("projects the current link index through the active-vault graph boundary", async () => {
    const workspace = await openRuntime();

    await expect(
      workspace.getVaultGraph(
        {
          mode: "global",
          rootPath: null,
          depth: 1,
          query: "",
          includeOrphans: false,
        },
        workspace.vaultId,
      ),
    ).resolves.toMatchObject({
      status: "ready",
      vaultId: workspace.vaultId,
      totalNodes: 2,
      totalEdges: 2,
      nodes: [
        { path: "Linked Note.md", neighborCount: 1 },
        { path: "Welcome.md", neighborCount: 1 },
      ],
      edges: [
        { source: "Linked Note.md", target: "Welcome.md", occurrences: 2 },
        { source: "Welcome.md", target: "Linked Note.md", occurrences: 2 },
      ],
    });

    await expect(
      workspace.getVaultGraph(
        {
          mode: "local",
          rootPath: "Welcome.md",
          depth: 1,
          query: "",
          includeOrphans: false,
        },
        "stale-vault",
      ),
    ).resolves.toEqual({ status: "stale-vault", vaultId: workspace.vaultId });
  });

  it("loads local raster images through the active-vault identity boundary", async () => {
    const workspace = await openRuntime();
    const imageBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlL8AAAAASUVORK5CYII=",
      "base64",
    );
    await fs.mkdir(path.join(vaultPath, "assets"), { recursive: true });
    await fs.writeFile(path.join(vaultPath, "assets", "pixel.png"), imageBytes);

    await expect(
      workspace.loadVaultImage("Welcome.md", "assets/pixel.png", workspace.vaultId),
    ).resolves.toMatchObject({
      status: "ready",
      vaultId: workspace.vaultId,
      path: "assets/pixel.png",
      mimeType: "image/png",
      base64: imageBytes.toString("base64"),
    });
    await expect(
      workspace.loadVaultImage("Welcome.md", "assets/pixel.png", "stale-vault"),
    ).resolves.toEqual({ status: "stale-vault", vaultId: workspace.vaultId });
  });

  it("loads note transclusions through the current metadata index", async () => {
    const workspace = await openRuntime();

    await expect(
      workspace.loadVaultNoteEmbed("Welcome.md", "Linked Note", null, workspace.vaultId),
    ).resolves.toMatchObject({
      status: "ready",
      vaultId: workspace.vaultId,
      path: "Linked Note.md",
      kind: "note",
    });
    await expect(
      workspace.loadVaultNoteEmbed("Welcome.md", "Linked Note", null, "stale-vault"),
    ).resolves.toEqual({ status: "stale-vault", vaultId: workspace.vaultId });
  });

  it("keeps supported attachment targets out of the note-link inspector", async () => {
    await fs.writeFile(
      path.join(vaultPath, "Gallery.md"),
      [
        "# Gallery",
        "",
        "![Local](assets/image.png)",
        "",
        "![[assets/image.png]]",
        "",
        "[[assets/report.pdf]]",
        "",
        "[Report](assets/report.pdf)",
        "",
        "![[Linked Note]]",
        "",
        "[[Linked Note]]",
      ].join("\n"),
      "utf8",
    );
    const workspace = await openRuntime();
    const opened = await workspace.openNote("Gallery.md");

    expect(opened.workspace?.activeNote?.outgoing).toEqual([
      expect.objectContaining({
        syntax: "wiki",
        embed: true,
        path: "Linked Note.md",
        status: "resolved",
      }),
      expect.objectContaining({ syntax: "wiki", path: "Linked Note.md", status: "resolved" }),
    ]);
    expect(opened.workspace?.files.find((file) => file.path === "Gallery.md")).toMatchObject({
      outgoingCount: 2,
      unresolvedCount: 0,
    });
  });

  it("publishes a new watcher sequence after an external attachment edit", async () => {
    const workspace = await openRuntime();
    const observed = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("attachment update timed out")), 2_000);
      workspace.onSnapshot((snapshot) => {
        const sequence = snapshot.workspace?.watcher.lastSequence ?? 0;
        if (sequence > 0) {
          clearTimeout(timeout);
          resolve(sequence);
        }
      });
    });

    await fs.writeFile(path.join(vaultPath, "preview.png"), Buffer.from([0x89, 0x50, 0x4e]));

    await expect(observed).resolves.toBeGreaterThan(0);
  });

  it("preserves a stale edit as an indexed conflict copy", async () => {
    const workspace = await openRuntime();
    const opened = await workspace.openNote("Welcome.md");
    const revision = opened.workspace?.activeNote?.revision;
    if (!revision) {
      throw new Error("Expected an active note revision.");
    }
    await fs.writeFile(path.join(vaultPath, "Welcome.md"), "# Changed elsewhere", "utf8");

    const saved = await workspace.saveNote(
      "Welcome.md",
      "# My preserved edit",
      revision,
      workspace.vaultId,
      "primary",
    );

    expect(saved.outcome).toMatchObject({
      status: "conflict",
      path: "Welcome.md",
    });
    if (saved.outcome.status !== "conflict") {
      throw new Error("Expected a conflict result.");
    }
    expect(saved.outcome.conflictPath).toMatch(/^Welcome\.threadleaf-conflict-[A-Za-z0-9-]+\.md$/);
    await expect(fs.readFile(path.join(vaultPath, "Welcome.md"), "utf8")).resolves.toBe(
      "# Changed elsewhere",
    );
    await expect(
      fs.readFile(path.join(vaultPath, saved.outcome.conflictPath), "utf8"),
    ).resolves.toBe("# My preserved edit");
    expect(saved.snapshot.workspace?.activeNote).toMatchObject({
      path: saved.outcome.conflictPath,
      title: "Welcome (conflict copy)",
      content: "# My preserved edit",
    });
    expect(saved.snapshot.workspace?.files).toContainEqual(
      expect.objectContaining({
        path: saved.outcome.conflictPath,
        title: "Welcome (conflict copy)",
      }),
    );
  });

  it("rejects a save prepared for a different active vault", async () => {
    const workspace = await openRuntime();
    const opened = await workspace.openNote("Welcome.md");
    const note = opened.workspace?.activeNote;
    if (!note) {
      throw new Error("Expected an active note.");
    }

    await expect(
      workspace.saveNote("Welcome.md", "# Wrong vault", note.revision, "stale-vault-id"),
    ).rejects.toThrow("active vault changed");
    await expect(fs.readFile(path.join(vaultPath, "Welcome.md"), "utf8")).resolves.toBe(
      note.content,
    );
  });

  it("publishes current indexed bytes after an external edit", async () => {
    const workspace = await openRuntime();
    await workspace.openNote("Welcome.md");
    const observed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("workspace update timed out")), 2_000);
      workspace.onSnapshot((snapshot) => {
        if (snapshot.workspace?.activeNote?.content.startsWith("# Updated outside")) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    await fs.writeFile(
      path.join(vaultPath, "Welcome.md"),
      "# Updated outside Threadleaf\n\n#external",
      "utf8",
    );
    await observed;
    const reconciled = await workspace.getSnapshot();

    expect(reconciled.workspace?.activeNote).toMatchObject({
      path: "Welcome.md",
      content: "# Updated outside Threadleaf\n\n#external",
      tags: ["external"],
    });
  });

  it("keeps workspace actions available when the compatibility plugin unloads", async () => {
    const workspace = await openRuntime();

    const unloaded = await workspace.unloadPlugin();

    expect(unloaded.commands).toEqual([]);
    expect(unloaded.actions).toEqual([
      { id: "workspace.close-note", name: "Close note", source: "workspace" },
      { id: "workspace.close-pane", name: "Close workspace pane", source: "workspace" },
      { id: "workspace.create-note", name: "Create note", source: "workspace" },
      { id: "workspace.focus-pane", name: "Focus workspace pane", source: "workspace" },
      { id: "workspace.go-back", name: "Go back in note history", source: "workspace" },
      { id: "workspace.go-forward", name: "Go forward in note history", source: "workspace" },
      {
        id: "workspace.insert-attachment",
        name: "Insert external attachment",
        source: "workspace",
      },
      {
        id: "workspace.insert-attachment-batch",
        name: "Insert external attachment batch",
        source: "workspace",
      },
      { id: "workspace.delete-note", name: "Move note to trash", source: "workspace" },
      {
        id: "workspace.move-note-to-pane",
        name: "Move note to workspace pane",
        source: "workspace",
      },
      { id: "workspace.move-note", name: "Move or rename note", source: "workspace" },
      { id: "workspace.open-note", name: "Open note", source: "workspace" },
      {
        id: "workspace.open-daily-note",
        name: "Open today's daily note",
        source: "workspace",
      },
      { id: "workspace.move-attachment", name: "Publish attachment copy", source: "workspace" },
      {
        id: "workspace.relink-attachment",
        name: "Relink missing attachment",
        source: "workspace",
      },
      {
        id: "workspace.remove-note-property",
        name: "Remove note property",
        source: "workspace",
      },
      { id: "workspace.reorder-tab", name: "Reorder workspace tab", source: "workspace" },
      {
        id: "workspace.restore-attachment",
        name: "Restore missing attachment",
        source: "workspace",
      },
      { id: "workspace.save-note", name: "Save note", source: "workspace" },
      {
        id: "workspace.set-note-property",
        name: "Set note property",
        source: "workspace",
      },
      { id: "workspace.split", name: "Split workspace", source: "workspace" },
      { id: "workspace.toggle-tab-pin", name: "Toggle tab pin", source: "workspace" },
    ]);
    await expect(workspace.openNote("Welcome.md")).resolves.toMatchObject({
      workspace: { activeNote: { path: "Welcome.md" } },
    });
  });
});

describe("WorkspaceRuntime atomic-replace reconciliation", () => {
  const attachmentBytes = Buffer.from("%PDF-1.7\nopaque attachment bytes\n", "ascii");

  async function seedAttachmentDesk(): Promise<void> {
    await fs.mkdir(path.join(vaultPath, "Assets"), { recursive: true });
    await fs.mkdir(path.join(vaultPath, "Archive"), { recursive: true });
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), attachmentBytes);
    await fs.writeFile(
      path.join(vaultPath, "Attachment Desk.md"),
      "# Attachment Desk\n\n![[Assets/report.pdf|Report]]\n\n[download](Assets/report.pdf)\n",
      "utf8",
    );
  }

  function tabPaths(snapshot: RuntimeSnapshot): string[] {
    return (snapshot.workspace?.tabs ?? []).map(({ path: filePath }) => filePath);
  }

  it("keeps a pinned tab through the move-aside window of an attachment move", async () => {
    await seedAttachmentDesk();
    const store = new MemoryWorkspaceStateStore();
    let racedScans = 0;
    let observedAbsence = false;
    const workspace = await openRuntime(store, undefined, undefined, async (point) => {
      if (point !== "write:after-move-aside" || racedScans > 0) {
        return;
      }
      racedScans += 1;
      // The transaction is holding the note aside right now, which is exactly
      // the state a scan misreads as a deletion.
      observedAbsence = await fs
        .stat(path.join(vaultPath, "Attachment Desk.md"))
        .then(() => false)
        .catch(() => true);
      await runtime?.reconcileNow();
    });
    await workspace.openNote("Welcome.md");
    await workspace.openNote("Attachment Desk.md");
    await workspace.toggleTabPin("Attachment Desk.md", "primary", workspace.vaultId);
    const before = store.saved.at(-1);

    const source = await workspace.kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected the attachment bytes.");
    const preview = await workspace.moveAttachment(
      "Assets/report.pdf",
      "Archive/report-renamed.pdf",
      source.snapshot.revision,
      workspace.vaultId,
    );
    if (preview.outcome.status !== "requires-confirmation") {
      throw new Error("Expected an attachment move confirmation.");
    }
    const moved = await workspace.moveAttachment(
      "Assets/report.pdf",
      "Archive/report-renamed.pdf",
      source.snapshot.revision,
      workspace.vaultId,
      preview.outcome.confirmationId,
    );
    expect(moved.outcome).toMatchObject({ status: "published-source-retained" });
    expect(racedScans).toBe(1);
    expect(observedAbsence).toBe(true);

    const settled = await workspace.reconcileNow();
    expect(settled.workspace?.tabs).toContainEqual(
      expect.objectContaining({ path: "Attachment Desk.md", pinned: true, active: true }),
    );
    expect(settled.workspace?.activeNote?.content).toContain("Archive/report-renamed.pdf");
    expect(store.saved.at(-1)?.panes[0]?.pinnedPaths).toEqual(["Attachment Desk.md"]);
    expect(store.saved.at(-1)?.panes[0]?.openPaths).toEqual(before?.panes[0]?.openPaths);
    expect(store.saved.at(-1)?.panes[0]?.activePath).toBe("Attachment Desk.md");
  });

  it("keeps a pinned tab while autosave uses the atomic move-aside writer", async () => {
    const store = new MemoryWorkspaceStateStore();
    let racedScans = 0;
    let observedAbsence = false;
    const workspace = await openRuntime(store, undefined, undefined, async (point) => {
      if (point !== "write:after-move-aside" || racedScans > 0) {
        return;
      }
      racedScans += 1;
      observedAbsence = await fs
        .stat(path.join(vaultPath, "Welcome.md"))
        .then(() => false)
        .catch(() => true);
      await runtime?.reconcileNow();
    });
    await workspace.openNote("Linked Note.md");
    const opened = await workspace.openNote("Welcome.md");
    const note = opened.workspace?.activeNote;
    if (!note) throw new Error("Expected the note to open.");
    await workspace.toggleTabPin("Welcome.md", "primary", workspace.vaultId);

    const saved = await workspace.saveNote(
      "Welcome.md",
      "# Welcome\n\nsaved through the race\n",
      note.revision,
      workspace.vaultId,
      "primary",
    );
    expect(saved.outcome).toMatchObject({ status: "committed" });
    expect(racedScans).toBe(1);
    expect(observedAbsence).toBe(true);

    const settled = await workspace.reconcileNow();
    expect(settled.workspace?.tabs).toContainEqual(
      expect.objectContaining({ path: "Welcome.md", pinned: true, active: true }),
    );
    expect(settled.workspace?.activeNote?.content).toBe("# Welcome\n\nsaved through the race\n");
    expect(store.saved.at(-1)?.panes[0]?.pinnedPaths).toEqual(["Welcome.md"]);
    expect(store.saved.at(-1)?.panes[0]?.activePath).toBe("Welcome.md");
  });

  it("keeps a pinned tab through an external atomic replace", async () => {
    const store = new MemoryWorkspaceStateStore();
    const workspace = await openRuntime(store);
    await workspace.openNote("Linked Note.md");
    await workspace.openNote("Welcome.md");
    await workspace.toggleTabPin("Welcome.md", "primary", workspace.vaultId);
    const before = store.saved.at(-1);

    // No kernel transaction: an outside writer renaming its replacement into
    // place leaves the same gap, and the workspace has nothing to attribute it to.
    const asidePath = path.join(sandboxPath, "Welcome.md.aside");
    await fs.rename(path.join(vaultPath, "Welcome.md"), asidePath);
    const during = await workspace.reconcileNow();
    // The tab is not hidden while the absence is unconfirmed: it stays open,
    // pinned and active, and its note is republished from what was last read.
    expect(during.workspace?.tabs).toContainEqual(
      expect.objectContaining({ path: "Welcome.md", pinned: true, active: true }),
    );

    await fs.writeFile(path.join(vaultPath, "Welcome.md"), "# Welcome\n\nreplaced\n", "utf8");
    const settled = await workspace.reconcileNow();
    expect(settled.workspace?.tabs).toContainEqual(
      expect.objectContaining({ path: "Welcome.md", pinned: true, active: true }),
    );
    expect(settled.workspace?.activeNote?.content).toBe("# Welcome\n\nreplaced\n");
    expect(store.saved.at(-1)?.panes[0]?.openPaths).toEqual(before?.panes[0]?.openPaths);
    expect(store.saved.at(-1)?.panes[0]?.pinnedPaths).toEqual(["Welcome.md"]);
    expect(store.saved.at(-1)?.panes[0]?.activePath).toBe("Welcome.md");
  });

  it("closes the tab once an external deletion is confirmed", async () => {
    const store = new MemoryWorkspaceStateStore();
    const clock = manualClock();
    const workspace = await openRuntime(store, undefined, undefined, undefined, clock.now);
    await workspace.openNote("Linked Note.md");
    await workspace.openNote("Welcome.md");
    await workspace.toggleTabPin("Welcome.md", "primary", workspace.vaultId);

    await fs.unlink(path.join(vaultPath, "Welcome.md"));
    await workspace.reconcileNow();
    clock.advance(2000);
    await workspace.reconcileNow();
    clock.advance(absenceConfirmationIntervalMs + 1);
    const settled = await workspace.reconcileNow();
    expect(tabPaths(settled)).toEqual(["Linked Note.md"]);
    expect(settled.workspace?.activeNote?.path).toBe("Linked Note.md");
    expect(store.saved.at(-1)?.panes[0]?.openPaths).toEqual(["Linked Note.md"]);
    expect(store.saved.at(-1)?.panes[0]?.pinnedPaths).toEqual([]);
  });

  it("closes the tab for a live watcher deletion with no further vault activity", async () => {
    const store = new MemoryWorkspaceStateStore();
    const workspace = await openRuntime(store);
    await workspace.openNote("Linked Note.md");
    await workspace.openNote("Welcome.md");

    // Deferring a deletion is only safe if something still asks the vault the
    // second question. A deletion is the last filesystem event of its burst, so
    // nothing here drives the watcher and no test call reconciles: the
    // confirmation pass has to be requested by the deferral itself. This asserts
    // the persisted layout rather than the published one, because only the
    // written-back projection distinguishes a confirmed close from the one pass
    // the display hides an unconfirmed path for.
    await fs.unlink(path.join(vaultPath, "Welcome.md"));
    const deadline = Date.now() + 15000;
    while (
      Date.now() < deadline &&
      (store.saved.at(-1)?.panes[0]?.openPaths ?? []).includes("Welcome.md")
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(store.saved.at(-1)?.panes[0]?.openPaths).toEqual(["Linked Note.md"]);
    const settled = await workspace.getSnapshot();
    expect(tabPaths(settled)).toEqual(["Linked Note.md"]);
    expect(settled.workspace?.activeNote?.path).toBe("Linked Note.md");
  }, 30000);

  it("closes the tab on a deliberate trash and still refuses a pinned one", async () => {
    const store = new MemoryWorkspaceStateStore();
    const workspace = await openRuntime(store);
    await workspace.openNote("Linked Note.md");
    const opened = await workspace.openNote("Welcome.md");
    const note = opened.workspace?.activeNote;
    if (!note) throw new Error("Expected the note to open.");
    await workspace.toggleTabPin("Welcome.md", "primary", workspace.vaultId);

    await expect(
      workspace.deleteNote("Welcome.md", note.revision, workspace.vaultId),
    ).rejects.toThrow("Unpin this tab before closing it.");
    await workspace.toggleTabPin("Welcome.md", "primary", workspace.vaultId);

    const deleted = await workspace.deleteNote("Welcome.md", note.revision, workspace.vaultId);
    expect(deleted.outcome).toMatchObject({ status: "committed" });
    expect(tabPaths(deleted.snapshot)).toEqual(["Linked Note.md"]);
    const settled = await workspace.reconcileNow();
    expect(tabPaths(settled)).toEqual(["Linked Note.md"]);
    expect(store.saved.at(-1)?.panes[0]?.openPaths).toEqual(["Linked Note.md"]);
  });

  it("keeps the tab and releases the claim when a write rolls its target back", async () => {
    const store = new MemoryWorkspaceStateStore();
    let racedScans = 0;
    const workspace = await openRuntime(store, undefined, undefined, async (point) => {
      if (point !== "write:after-move-aside" || racedScans > 0) {
        return;
      }
      racedScans += 1;
      await runtime?.reconcileNow();
      // Change the rolled-back copy so the transaction takes its restore-and-
      // conflict exit instead of installing the replacement.
      const rollbackName = (await fs.readdir(vaultPath)).find((name) =>
        name.startsWith(".threadleaf-rollback-"),
      );
      if (!rollbackName) throw new Error("Expected a rollback copy inside the window.");
      await fs.writeFile(path.join(vaultPath, rollbackName), "# Welcome\n\nrolled back\n", "utf8");
    });
    await workspace.openNote("Linked Note.md");
    const opened = await workspace.openNote("Welcome.md");
    const note = opened.workspace?.activeNote;
    if (!note) throw new Error("Expected the note to open.");
    await workspace.toggleTabPin("Welcome.md", "primary", workspace.vaultId);

    const saved = await workspace.saveNote(
      "Welcome.md",
      "# Welcome\n\nnever installed\n",
      note.revision,
      workspace.vaultId,
    );
    expect(saved.outcome).toMatchObject({ status: "conflict" });
    expect(racedScans).toBe(1);
    expect(workspace.kernel.transientAbsences.operationFor("Welcome.md")).toBeUndefined();

    const settled = await workspace.reconcileNow();
    // A conflict activates its conflict copy, which is unchanged behaviour. What
    // matters here is that the note's own tab and pin survived the window.
    expect(settled.workspace?.tabs).toContainEqual(
      expect.objectContaining({ path: "Welcome.md", pinned: true }),
    );
    expect(settled.workspace?.activeNote?.path).toMatch(/^Welcome\.threadleaf-conflict-/);
    expect(store.saved.at(-1)?.panes[0]?.pinnedPaths).toEqual(["Welcome.md"]);
    await expect(fs.readFile(path.join(vaultPath, "Welcome.md"), "utf8")).resolves.toBe(
      "# Welcome\n\nrolled back\n",
    );
  });

  it("keeps the tab when a second write reopens the window before the first is confirmed", async () => {
    const store = new MemoryWorkspaceStateStore();
    let windows = 0;
    const workspace = await openRuntime(store, undefined, undefined, async (point) => {
      if (point !== "write:after-move-aside") {
        return;
      }
      windows += 1;
      await runtime?.reconcileNow();
    });
    await workspace.openNote("Linked Note.md");
    const opened = await workspace.openNote("Welcome.md");
    const note = opened.workspace?.activeNote;
    if (!note) throw new Error("Expected the note to open.");
    await workspace.toggleTabPin("Welcome.md", "primary", workspace.vaultId);

    const first = await workspace.saveNote(
      "Welcome.md",
      "# Welcome\n\none\n",
      note.revision,
      workspace.vaultId,
    );
    if (first.outcome.status !== "committed") throw new Error("Expected the first save.");
    // The second window opens before anything confirmed the absence the first
    // one left behind, so the confirmation lands while the file is aside again.
    const second = await workspace.saveNote(
      "Welcome.md",
      "# Welcome\n\ntwo\n",
      first.outcome.revision,
      workspace.vaultId,
    );
    expect(second.outcome).toMatchObject({ status: "committed" });
    expect(windows).toBe(2);

    const settled = await workspace.reconcileNow();
    expect(settled.workspace?.tabs).toContainEqual(
      expect.objectContaining({ path: "Welcome.md", pinned: true, active: true }),
    );
    expect(settled.workspace?.activeNote?.content).toBe("# Welcome\n\ntwo\n");
    expect(store.saved.at(-1)?.panes[0]?.pinnedPaths).toEqual(["Welcome.md"]);
  });

  it("releases the claim when a write throws inside its move-aside window", async () => {
    const store = new MemoryWorkspaceStateStore();
    const clock = manualClock();
    let raced = false;
    const workspace = await openRuntime(
      store,
      undefined,
      undefined,
      async (point) => {
        if (point !== "write:after-move-aside" || raced) {
          return;
        }
        raced = true;
        await runtime?.reconcileNow();
        throw new Error("injected move-aside failure");
      },
      clock.now,
    );
    await workspace.openNote("Linked Note.md");
    const opened = await workspace.openNote("Welcome.md");
    const note = opened.workspace?.activeNote;
    if (!note) throw new Error("Expected the note to open.");

    await expect(
      workspace.saveNote("Welcome.md", "# Welcome\n\nlost\n", note.revision, workspace.vaultId),
    ).rejects.toThrow("injected move-aside failure");
    expect(raced).toBe(true);
    expect(workspace.kernel.transientAbsences.operationFor("Welcome.md")).toBeUndefined();

    // The claim is gone, so the absence is now confirmable like any other: the
    // file really did not come back, and the tab closes once its window ends.
    await workspace.reconcileNow();
    clock.advance(2000);
    await workspace.reconcileNow();
    clock.advance(absenceConfirmationIntervalMs + 1);
    const settled = await workspace.reconcileNow();
    expect(tabPaths(settled)).toEqual(["Linked Note.md"]);
  });
});

describe("WorkspaceRuntime absence confirmation at the sink", () => {
  // Several of these replace a global filesystem call. A test that fails before
  // its own restore would otherwise hand the stub to every test after it.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function tabPaths(snapshot: RuntimeSnapshot): string[] {
    return (snapshot.workspace?.tabs ?? []).map(({ path: filePath }) => filePath);
  }

  async function openPinnedPair(
    store: MemoryWorkspaceStateStore,
    now?: () => number,
  ): Promise<WorkspaceRuntime> {
    const workspace = await openRuntime(store, undefined, undefined, undefined, now);
    await workspace.openNote("Linked Note.md");
    await workspace.openNote("Welcome.md");
    await workspace.toggleTabPin("Welcome.md", "primary", workspace.vaultId);
    return workspace;
  }

  function persistedTrackedPaths(store: BlockingWorkspaceStateStore): string[] {
    return (store.inner.value?.panes ?? []).flatMap((pane) => [
      ...pane.openPaths,
      ...pane.pinnedPaths,
      ...(pane.activePath ? [pane.activePath] : []),
      ...(pane.navigationHistory?.back ?? []),
      ...(pane.navigationHistory?.forward ?? []),
    ]);
  }

  async function raceConfirmedWelcomeRemovalAgainst(
    workspace: WorkspaceRuntime,
    store: BlockingWorkspaceStateStore,
    clock: ReturnType<typeof manualClock>,
    mutation: () => Promise<RuntimeSnapshot>,
  ): Promise<void> {
    await workspace.watcher.close();
    await fs.unlink(path.join(vaultPath, "Welcome.md"));
    await workspace.reconcileNow();
    clock.advance(transientAbsenceSettleMs + 1);
    const firstConfirmation = await workspace.reconcileNow();
    expect(
      firstConfirmation.workspace?.panes.flatMap((pane) =>
        pane.tabs.map(({ path: filePath }) => filePath),
      ),
    ).toContain("Welcome.md");
    clock.advance(absenceConfirmationIntervalMs + 1);

    store.resetSaveCount();
    store.blockSaves();
    let pendingMutation: Promise<RuntimeSnapshot> | undefined;
    let confirmation: Promise<RuntimeSnapshot> | undefined;
    try {
      pendingMutation = mutation();
      await store.waitForSaveCount(1);
      confirmation = workspace.reconcileNow();
      await store.waitForSaveCount(2);
    } finally {
      store.releaseSaves();
    }
    if (!pendingMutation || !confirmation) {
      throw new Error("The blocked workspace mutation did not reach the confirmation race.");
    }
    await Promise.all([pendingMutation, confirmation]);
  }

  it("bounds confirmation work during unrelated churn and still closes deleted notes and canvases", async () => {
    const store = new MemoryWorkspaceStateStore();
    const clock = manualClock();
    const workspace = await openRuntime(store, undefined, undefined, undefined, clock.now);
    await workspace.openNote("Welcome.md");
    await workspace.openNote("Boards/Overview.canvas");
    await workspace.openNote("Linked Note.md");
    await workspace.watcher.close();

    await fs.unlink(path.join(vaultPath, "Welcome.md"));
    await fs.unlink(path.join(vaultPath, "Boards", "Overview.canvas"));
    const observed = await workspace.reconcileNow();
    expect(tabPaths(observed)).toEqual(
      expect.arrayContaining(["Welcome.md", "Boards/Overview.canvas"]),
    );

    const probes = new Map([
      ["Welcome.md", 0],
      ["Boards/Overview.canvas", 0],
    ]);
    const realpath = fs.realpath;
    vi.spyOn(fs, "realpath").mockImplementation((async (
      probed: Parameters<typeof realpath>[0],
      ...rest: unknown[]
    ) => {
      if (typeof probed === "string") {
        for (const filePath of probes.keys()) {
          if (probed.endsWith(`/${filePath}`)) {
            probes.set(filePath, (probes.get(filePath) ?? 0) + 1);
          }
        }
      }
      return (realpath as (...args: unknown[]) => unknown)(probed, ...rest);
    }) as unknown as typeof fs.realpath);

    // Activity elsewhere in the vault may cause arbitrarily many reconciliation
    // passes. It cannot spend, replenish, or otherwise touch either target's
    // per-absence confirmation work while the settle window is still open.
    for (let pass = 0; pass < 24; pass += 1) {
      await fs.writeFile(path.join(vaultPath, "Churn.md"), `# Churn ${pass}\n`, "utf8");
      const during = await workspace.reconcileNow();
      expect(tabPaths(during)).toEqual(
        expect.arrayContaining(["Welcome.md", "Boards/Overview.canvas"]),
      );
    }

    clock.advance(transientAbsenceSettleMs + 1);
    let settled = await workspace.getSnapshot();
    for (let confirmation = 0; confirmation < 6; confirmation += 1) {
      await fs.writeFile(
        path.join(vaultPath, "Churn.md"),
        `# Confirmation churn ${confirmation}\n`,
        "utf8",
      );
      settled = await workspace.reconcileNow();
      clock.advance(250);
    }

    expect(tabPaths(settled)).not.toContain("Welcome.md");
    expect(tabPaths(settled)).not.toContain("Boards/Overview.canvas");
    expect(store.saved.at(-1)?.panes[0]?.openPaths).not.toContain("Welcome.md");
    expect(store.saved.at(-1)?.panes[0]?.openPaths).not.toContain("Boards/Overview.canvas");
    expect(Object.fromEntries(probes)).toEqual({
      "Welcome.md": expect.any(Number),
      "Boards/Overview.canvas": expect.any(Number),
    });
    expect(probes.get("Welcome.md")).toBeLessThanOrEqual(4);
    expect(probes.get("Boards/Overview.canvas")).toBeLessThanOrEqual(4);
  });

  it("converges after bounded alternating indeterminate and absent reads", async () => {
    const store = new MemoryWorkspaceStateStore();
    const clock = manualClock();
    const workspace = await openRuntime(store, undefined, undefined, undefined, clock.now);
    await workspace.openNote("Linked Note.md");
    await workspace.openNote("Welcome.md");
    await workspace.watcher.close();

    await fs.unlink(path.join(vaultPath, "Welcome.md"));
    await workspace.reconcileNow();
    clock.advance(transientAbsenceSettleMs + 1);

    const realpath = fs.realpath;
    let targetProbes = 0;
    vi.spyOn(fs, "realpath").mockImplementation((async (
      probed: Parameters<typeof realpath>[0],
      ...rest: unknown[]
    ) => {
      if (typeof probed === "string" && probed.endsWith("/Welcome.md")) {
        targetProbes += 1;
        if (targetProbes % 2 === 1) {
          const error: NodeJS.ErrnoException = new Error("EACCES: permission denied");
          error.code = "EACCES";
          throw error;
        }
      }
      return (realpath as (...args: unknown[]) => unknown)(probed, ...rest);
    }) as unknown as typeof fs.realpath);

    let settled = await workspace.getSnapshot();
    for (let confirmation = 0; confirmation < 12; confirmation += 1) {
      settled = await workspace.reconcileNow();
      clock.advance(250);
    }

    expect(tabPaths(settled)).not.toContain("Welcome.md");
    expect(store.saved.at(-1)?.panes[0]?.openPaths).toEqual(["Linked Note.md"]);
    expect(targetProbes).toBeGreaterThan(0);
    expect(targetProbes).toBeLessThanOrEqual(4);
  });

  it("does not let a retained-tab selection resurrect a concurrently confirmed deletion", async () => {
    const store = new BlockingWorkspaceStateStore();
    const clock = manualClock();
    const workspace = await openRuntime(store, undefined, undefined, undefined, clock.now);
    await workspace.openNote("Welcome.md");
    await workspace.openNote("Linked Note.md");
    await workspace.watcher.close();

    await fs.unlink(path.join(vaultPath, "Welcome.md"));
    await workspace.reconcileNow();
    clock.advance(transientAbsenceSettleMs + 1);
    await workspace.reconcileNow();
    clock.advance(absenceConfirmationIntervalMs + 1);

    store.resetSaveCount();
    store.blockSaves();
    const selection = workspace.openNote("Welcome.md");
    await store.waitForSaveCount(1);
    const confirmation = workspace.reconcileNow();
    await store.waitForSaveCount(2);
    store.releaseSaves();
    await Promise.all([selection, confirmation]);

    const openPaths = store.inner.value?.panes[0]?.openPaths ?? [];
    expect(openPaths).not.toContain("Welcome.md");
    expect(tabPaths(await workspace.getSnapshot())).not.toContain("Welcome.md");
  });

  it("guards a tab-pin save against a concurrently confirmed removal and permits a later reopen", async () => {
    const store = new BlockingWorkspaceStateStore();
    const clock = manualClock();
    const workspace = await openRuntime(store, undefined, undefined, undefined, clock.now);
    await workspace.openNote("Welcome.md");
    await workspace.openNote("Linked Note.md");

    await raceConfirmedWelcomeRemovalAgainst(workspace, store, clock, () =>
      workspace.toggleTabPin("Welcome.md", "primary", workspace.vaultId),
    );

    expect(persistedTrackedPaths(store)).not.toContain("Welcome.md");
    expect(tabPaths(await workspace.getSnapshot())).not.toContain("Welcome.md");

    await fs.writeFile(path.join(vaultPath, "Welcome.md"), "# Welcome\n\nreturned\n", "utf8");
    await workspace.reconcileNow();
    await workspace.openNote("Welcome.md");
    const repinned = await workspace.toggleTabPin("Welcome.md", "primary", workspace.vaultId);
    expect(repinned.workspace?.tabs).toContainEqual(
      expect.objectContaining({ path: "Welcome.md", pinned: true, active: true }),
    );
    expect(store.inner.value?.panes[0]?.pinnedPaths).toContain("Welcome.md");
  });

  it("guards a tab-reorder save against a concurrently confirmed removal", async () => {
    const store = new BlockingWorkspaceStateStore();
    const clock = manualClock();
    const workspace = await openRuntime(store, undefined, undefined, undefined, clock.now);
    await workspace.openNote("Welcome.md");
    await workspace.openNote("Linked Note.md");
    const created = await workspace.createNote("Third", "# Third\n", workspace.vaultId);
    expect(created.outcome).toMatchObject({ status: "committed", path: "Third.md" });
    await workspace.toggleTabPin("Welcome.md", "primary", workspace.vaultId);

    await raceConfirmedWelcomeRemovalAgainst(workspace, store, clock, () =>
      workspace.reorderWorkspaceTab("Third.md", "primary", 1, workspace.vaultId),
    );

    expect(persistedTrackedPaths(store)).not.toContain("Welcome.md");
    expect(tabPaths(await workspace.getSnapshot())).not.toContain("Welcome.md");
  });

  it("guards a pane-transfer save against a concurrently confirmed removal", async () => {
    const store = new BlockingWorkspaceStateStore();
    const clock = manualClock();
    const workspace = await openRuntime(store, undefined, undefined, undefined, clock.now);
    await workspace.openNote("Welcome.md");
    await workspace.openNote("Linked Note.md");
    await workspace.toggleTabPin("Welcome.md", "primary", workspace.vaultId);
    await workspace.splitWorkspace("vertical", workspace.vaultId);
    await workspace.focusWorkspacePane("primary", workspace.vaultId);

    await raceConfirmedWelcomeRemovalAgainst(workspace, store, clock, () =>
      workspace.moveNoteToWorkspacePane("Welcome.md", "primary", "secondary", workspace.vaultId),
    );

    expect(persistedTrackedPaths(store)).not.toContain("Welcome.md");
    expect(tabPaths(await workspace.getSnapshot())).not.toContain("Welcome.md");
  });

  it("guards a history-navigation save against a concurrently confirmed removal", async () => {
    const store = new BlockingWorkspaceStateStore();
    const clock = manualClock();
    const workspace = await openRuntime(store, undefined, undefined, undefined, clock.now);
    await workspace.openNote("Welcome.md");
    await workspace.openNote("Linked Note.md");
    expect(store.inner.value?.panes[0]?.navigationHistory?.back).toContain("Welcome.md");

    await raceConfirmedWelcomeRemovalAgainst(workspace, store, clock, () =>
      workspace.goBack(workspace.vaultId),
    );

    expect(persistedTrackedPaths(store)).not.toContain("Welcome.md");
    expect(tabPaths(await workspace.getSnapshot())).not.toContain("Welcome.md");
  });

  it("guards a pane-close save against a concurrently confirmed removal", async () => {
    const store = new BlockingWorkspaceStateStore();
    const clock = manualClock();
    const workspace = await openRuntime(store, undefined, undefined, undefined, clock.now);
    await workspace.openNote("Welcome.md");
    await workspace.openNote("Linked Note.md");
    await workspace.splitWorkspace("vertical", workspace.vaultId);

    await raceConfirmedWelcomeRemovalAgainst(workspace, store, clock, () =>
      workspace.closeWorkspacePane("secondary", workspace.vaultId),
    );

    expect(persistedTrackedPaths(store)).not.toContain("Welcome.md");
    expect(tabPaths(await workspace.getSnapshot())).not.toContain("Welcome.md");
  });

  it("guards history navigation when confirmation lands inside its visible-path read", async () => {
    const store = new MemoryWorkspaceStateStore();
    const clock = manualClock();
    const workspace = await openRuntime(store, undefined, undefined, undefined, clock.now);
    await workspace.openNote("Welcome.md");
    await workspace.openNote("Linked Note.md");
    expect(store.value?.panes[0]?.navigationHistory?.back).toContain("Welcome.md");

    await workspace.watcher.close();
    await fs.unlink(path.join(vaultPath, "Welcome.md"));
    await workspace.reconcileNow();
    clock.advance(transientAbsenceSettleMs + 1);
    const first = await workspace.reconcileNow();
    expect(tabPaths(first)).toContain("Welcome.md");
    clock.advance(absenceConfirmationIntervalMs + 1);

    const realList = workspace.kernel.listVisiblePaths.bind(workspace.kernel);
    let injected = false;
    vi.spyOn(workspace.kernel, "listVisiblePaths").mockImplementation(async () => {
      const result = await realList();
      if (!injected) {
        injected = true;
        await workspace.reconcileNow();
      }
      return result;
    });

    await workspace.goBack(workspace.vaultId);
    vi.restoreAllMocks();
    expect(injected).toBe(true);

    const persisted = store.value?.panes.flatMap((pane) => [
      ...pane.openPaths,
      ...pane.pinnedPaths,
      ...(pane.activePath ? [pane.activePath] : []),
      ...(pane.navigationHistory?.back ?? []),
      ...(pane.navigationHistory?.forward ?? []),
    ]);
    expect(persisted).not.toContain("Welcome.md");
    expect(tabPaths(await workspace.getSnapshot())).not.toContain("Welcome.md");
  });

  it("keeps an unrelated pin when a confirmed removal scrubs the same pane state", async () => {
    const store = new BlockingWorkspaceStateStore();
    const clock = manualClock();
    const workspace = await openRuntime(store, undefined, undefined, undefined, clock.now);
    await workspace.openNote("Welcome.md");
    await workspace.openNote("Linked Note.md");

    await raceConfirmedWelcomeRemovalAgainst(workspace, store, clock, () =>
      workspace.toggleTabPin("Linked Note.md", "primary", workspace.vaultId),
    );

    expect(persistedTrackedPaths(store)).not.toContain("Welcome.md");

    const snapshot = await workspace.getSnapshot();
    expect(store.inner.value?.panes[0]?.pinnedPaths ?? []).toContain("Linked Note.md");
    expect(snapshot.workspace?.tabs).toContainEqual(
      expect.objectContaining({ path: "Linked Note.md", pinned: true }),
    );
  });

  it("keeps another pane's pin when a confirmed removal scrubs the workspace state", async () => {
    const store = new BlockingWorkspaceStateStore();
    const clock = manualClock();
    const workspace = await openRuntime(store, undefined, undefined, undefined, clock.now);
    await workspace.openNote("Welcome.md");
    await workspace.openNote("Linked Note.md");
    await workspace.splitWorkspace("vertical", workspace.vaultId);
    expect(store.inner.value?.panes[0]?.openPaths).toContain("Welcome.md");
    expect(store.inner.value?.panes[1]?.openPaths).toEqual(["Linked Note.md"]);

    await raceConfirmedWelcomeRemovalAgainst(workspace, store, clock, () =>
      workspace.toggleTabPin("Linked Note.md", "secondary", workspace.vaultId),
    );

    expect(persistedTrackedPaths(store)).not.toContain("Welcome.md");

    const snapshot = await workspace.getSnapshot();
    expect(store.inner.value?.panes[1]?.pinnedPaths ?? []).toContain("Linked Note.md");
    expect(snapshot.workspace?.panes.find(({ id }) => id === "secondary")?.tabs).toContainEqual(
      expect.objectContaining({ path: "Linked Note.md", pinned: true }),
    );
  });

  it("extends a startup absence while that exact path is active and keeps a slow arrival", async () => {
    const store = new MemoryWorkspaceStateStore({
      openPaths: ["Welcome.md", "Syncing.md"],
      pinnedPaths: ["Syncing.md"],
      activePath: "Syncing.md",
    });
    const clock = manualClock();
    const workspace = await openRuntime(store, undefined, undefined, undefined, clock.now);
    await workspace.watcher.close();
    let syncingActivity = 0;
    vi.spyOn(workspace.watcher, "activityVersionForPath").mockImplementation((filePath) =>
      filePath === "Syncing.md" ? syncingActivity : 0,
    );

    clock.advance(startupAbsenceSettleMs - 1);
    syncingActivity += 1;
    await workspace.reconcileNow();

    // This is beyond the fixed startup window. Two confirmation opportunities
    // would have removed the tab without the exact-path quiet extension.
    clock.advance(2);
    await workspace.reconcileNow();
    clock.advance(absenceConfirmationIntervalMs + 1);
    const beyondFixedWindow = await workspace.reconcileNow();
    expect(tabPaths(beyondFixedWindow)).toContain("Syncing.md");

    clock.advance(startupAbsenceSettleMs / 2);
    await fs.writeFile(
      path.join(vaultPath, "Syncing.md"),
      "# Syncing\n\narrived after the fixed window\n",
      "utf8",
    );
    await workspace.reconcileNow();
    const landed = await workspace.openNote("Syncing.md");
    expect(landed.workspace?.activeNote?.content).toBe(
      "# Syncing\n\narrived after the fixed window\n",
    );
    expect(landed.workspace?.tabs).toContainEqual(
      expect.objectContaining({ path: "Syncing.md", pinned: true, active: true }),
    );
    for (const saved of store.saved) {
      expect(saved.panes[0]?.openPaths).toContain("Syncing.md");
      expect(saved.panes[0]?.pinnedPaths).toEqual(["Syncing.md"]);
    }
  });

  it("closes a startup absence within the bounded confirmation tail once the vault is quiet", async () => {
    const store = new MemoryWorkspaceStateStore({
      openPaths: ["Welcome.md", "Never Arrives.md"],
      pinnedPaths: ["Never Arrives.md"],
      activePath: "Never Arrives.md",
    });
    const clock = manualClock();
    const startedAt = clock.now();
    const workspace = await openRuntime(store, undefined, undefined, undefined, clock.now);
    await workspace.watcher.close();
    const realpath = fs.realpath;
    let targetProbes = 0;
    vi.spyOn(fs, "realpath").mockImplementation((async (
      probed: Parameters<typeof realpath>[0],
      ...rest: unknown[]
    ) => {
      if (typeof probed === "string" && probed.endsWith("/Never Arrives.md")) {
        targetProbes += 1;
      }
      return (realpath as (...args: unknown[]) => unknown)(probed, ...rest);
    }) as unknown as typeof fs.realpath);

    clock.advance(startupAbsenceSettleMs + 1);
    let settled = await workspace.getSnapshot();
    for (let attempt = 0; attempt < maximumAbsenceConfirmationAttempts; attempt += 1) {
      settled = await workspace.reconcileNow();
      if (!tabPaths(settled).includes("Never Arrives.md")) break;
      clock.advance(absenceConfirmationIntervalMs + 1);
    }

    expect(tabPaths(settled)).not.toContain("Never Arrives.md");
    expect(store.saved.at(-1)?.panes[0]?.pinnedPaths).toEqual([]);
    expect(targetProbes).toBeLessThanOrEqual(maximumAbsenceConfirmationAttempts);
    expect(clock.now() - startedAt).toBeLessThanOrEqual(
      startupAbsenceSettleMs +
        maximumAbsenceConfirmationAttempts * (absenceConfirmationIntervalMs + 1) +
        1,
    );
  });

  it("caps startup extensions even when exact-path activity never becomes quiet", async () => {
    const store = new MemoryWorkspaceStateStore({
      openPaths: ["Welcome.md", "Still Syncing.md"],
      pinnedPaths: ["Still Syncing.md"],
      activePath: "Still Syncing.md",
    });
    const clock = manualClock();
    const startedAt = clock.now();
    const workspace = await openRuntime(store, undefined, undefined, undefined, clock.now);
    await workspace.watcher.close();
    let syncingActivity = 0;
    vi.spyOn(workspace.watcher, "activityVersionForPath").mockImplementation((filePath) =>
      filePath === "Still Syncing.md" ? syncingActivity : 0,
    );

    const activityStepMs = startupAbsenceSettleMs / 2;
    while (clock.now() - startedAt < startupAbsenceMaximumSettleMs) {
      clock.advance(activityStepMs);
      syncingActivity += 1;
      await workspace.reconcileNow();
    }
    let settled = await workspace.getSnapshot();
    for (let attempt = 0; attempt < maximumAbsenceConfirmationAttempts; attempt += 1) {
      syncingActivity += 1;
      settled = await workspace.reconcileNow();
      if (!tabPaths(settled).includes("Still Syncing.md")) break;
      clock.advance(absenceConfirmationIntervalMs + 1);
    }

    expect(tabPaths(settled)).not.toContain("Still Syncing.md");
    expect(clock.now() - startedAt).toBeLessThanOrEqual(
      startupAbsenceMaximumSettleMs +
        maximumAbsenceConfirmationAttempts * (absenceConfirmationIntervalMs + 1),
    );
  });

  it("keeps the tab when an external replacement lands before the batch is handled", async () => {
    const store = new MemoryWorkspaceStateStore();
    const workspace = await openPinnedPair(store);
    const target = path.join(vaultPath, "Welcome.md");
    const asidePath = path.join(sandboxPath, "Welcome.md.aside");
    await fs.rename(target, asidePath);

    // The install lands between the scan listing the directory and the workspace
    // acting on what it listed. A pass-through spy only chooses that instant; the
    // reconciliation under test is untouched.
    const accept = workspace.indexReactor.accept.bind(workspace.indexReactor);
    let sawDelete = false;
    const spy = vi.spyOn(workspace.indexReactor, "accept").mockImplementation(async (batch) => {
      const result = await accept(batch);
      if (batch.changes.some((c) => c.kind === "delete" && c.path === "Welcome.md")) {
        sawDelete = true;
        await fs.rename(asidePath, target);
        spy.mockRestore();
      }
      return result;
    });

    await workspace.reconcileNow();
    expect(sawDelete).toBe(true);
    const settled = await workspace.reconcileNow();
    expect(tabPaths(settled)).toContain("Welcome.md");
    expect(store.saved.at(-1)?.panes[0]?.openPaths).toContain("Welcome.md");
    expect(store.saved.at(-1)?.panes[0]?.pinnedPaths).toEqual(["Welcome.md"]);
  });

  it("keeps the tab across every replace-window width", async () => {
    for (const delayMs of [0, 1, 2, 5]) {
      const store = new MemoryWorkspaceStateStore();
      const workspace = await openPinnedPair(store);
      const target = path.join(vaultPath, "Welcome.md");
      const asidePath = path.join(sandboxPath, `Welcome.md.aside-${delayMs}`);

      // No stubs at all: a real rename-aside, a reconcile started inside the gap,
      // and a real rename-back after `delayMs`. delay 0 is the band the panel
      // localised, where the install wins the race with the deferred re-read.
      await fs.rename(target, asidePath);
      const reconcile = workspace.reconcileNow();
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      await fs.rename(asidePath, target);
      await reconcile;
      await workspace.reconcileNow();
      const settled = await workspace.reconcileNow();

      expect({ delayMs, tabs: tabPaths(settled) }).toEqual({
        delayMs,
        tabs: expect.arrayContaining(["Welcome.md"]),
      });
      expect({ delayMs, pinned: store.saved.at(-1)?.panes[0]?.pinnedPaths }).toEqual({
        delayMs,
        pinned: ["Welcome.md"],
      });
      await workspace.close();
      runtime = undefined;
    }
  }, 30000);

  it("keeps the tab when the kernel's own save is scanned on a large vault", async () => {
    // The claim is released when the write finishes. On a vault big enough that
    // the scan is still walking at that moment, the deletion reaches the ledger
    // unattributed - which is the ordinary case, not an exotic one.
    const bulk = path.join(vaultPath, "Bulk");
    await fs.mkdir(bulk, { recursive: true });
    await Promise.all(
      Array.from({ length: 600 }, (_, index) =>
        fs.writeFile(path.join(bulk, `n${index}.md`), `# Note ${index}\n`, "utf8"),
      ),
    );
    const store = new MemoryWorkspaceStateStore();
    let raced = 0;
    let fileAbsent = false;
    let reconcile: Promise<unknown> | undefined;
    const workspace = await openRuntime(store, undefined, undefined, async (point) => {
      if (point !== "write:after-move-aside" || raced > 0 || !runtime) {
        return;
      }
      raced += 1;
      fileAbsent = await fs
        .stat(path.join(vaultPath, "Welcome.md"))
        .then(() => false)
        .catch(() => true);
      // Started, not awaited: the walk overlaps the rest of the transaction, so
      // the claim is released before the diff is annotated and handled.
      reconcile = runtime.reconcileNow();
    });
    await workspace.openNote("Linked Note.md");
    const opened = await workspace.openNote("Welcome.md");
    const note = opened.workspace?.activeNote;
    if (!note) throw new Error("Expected the note to open.");
    await workspace.toggleTabPin("Welcome.md", "primary", workspace.vaultId);

    const saved = await workspace.saveNote(
      "Welcome.md",
      "# Welcome\n\nsaved on a large vault\n",
      note.revision,
      workspace.vaultId,
    );
    expect(saved.outcome).toMatchObject({ status: "committed" });
    expect({ raced, fileAbsent }).toEqual({ raced: 1, fileAbsent: true });
    await reconcile;
    await workspace.reconcileNow();
    const settled = await workspace.reconcileNow();

    expect(settled.workspace?.tabs).toContainEqual(
      expect.objectContaining({ path: "Welcome.md", pinned: true }),
    );
    expect(store.saved.at(-1)?.panes[0]?.pinnedPaths).toEqual(["Welcome.md"]);
  }, 30000);

  it("keeps the tab when a read-race rebuild lands during an external replace", async () => {
    const store = new MemoryWorkspaceStateStore();
    const workspace = await openPinnedPair(store);
    const target = path.join(vaultPath, "Welcome.md");
    const asidePath = path.join(sandboxPath, "Welcome.md.aside");
    await fs.rename(target, asidePath);

    // The production catch in VaultIndexReactor.accept: one refresh that loses
    // its race with the filesystem escalates the whole batch to a full rebuild,
    // which then reads the vault while the file is still aside.
    const spy = vi.spyOn(workspace.indexReactor.index, "refresh").mockImplementation(async () => {
      spy.mockRestore();
      throw new Error("read race");
    });
    await fs.writeFile(
      path.join(vaultPath, "Linked Note.md"),
      "# Linked Note\n\ntouched\n",
      "utf8",
    );
    const during = await workspace.reconcileNow();
    expect(during.workspace?.watcher.lastRescanReason).toBe("read-race");

    await fs.rename(asidePath, target);
    await workspace.reconcileNow();
    const settled = await workspace.reconcileNow();
    expect(tabPaths(settled)).toContain("Welcome.md");
    expect(store.saved.at(-1)?.panes[0]?.pinnedPaths).toEqual(["Welcome.md"]);
  });

  it("keeps the tab when an overflow rescan lands during an external replace", async () => {
    const store = new MemoryWorkspaceStateStore();
    const workspace = await openPinnedPair(store);
    const target = path.join(vaultPath, "Welcome.md");
    const asidePath = path.join(sandboxPath, "Welcome.md.aside");
    await fs.rename(target, asidePath);
    await workspace.watcher.reportOverflow();

    await fs.rename(asidePath, target);
    await workspace.reconcileNow();
    const settled = await workspace.reconcileNow();
    expect(tabPaths(settled)).toContain("Welcome.md");
    expect(store.saved.at(-1)?.panes[0]?.pinnedPaths).toEqual(["Welcome.md"]);
  });

  it("keeps the tab when an overflow rescan lands while the kernel holds the file aside", async () => {
    const store = new MemoryWorkspaceStateStore();
    let raced = 0;
    let claimHeld = false;
    let fileAbsent = false;
    const workspace = await openRuntime(store, undefined, undefined, async (point) => {
      if (point !== "write:after-move-aside" || raced > 0 || !runtime) {
        return;
      }
      raced += 1;
      claimHeld = runtime.kernel.transientAbsences.operationFor("Welcome.md") !== undefined;
      fileAbsent = await fs
        .stat(path.join(vaultPath, "Welcome.md"))
        .then(() => false)
        .catch(() => true);
      await runtime.watcher.reportOverflow();
    });
    await workspace.openNote("Linked Note.md");
    const opened = await workspace.openNote("Welcome.md");
    const note = opened.workspace?.activeNote;
    if (!note) throw new Error("Expected the note to open.");
    await workspace.toggleTabPin("Welcome.md", "primary", workspace.vaultId);

    const saved = await workspace.saveNote(
      "Welcome.md",
      "# Welcome\n\nsaved through the overflow\n",
      note.revision,
      workspace.vaultId,
    );
    expect(saved.outcome).toMatchObject({ status: "committed" });
    expect({ raced, claimHeld, fileAbsent }).toEqual({
      raced: 1,
      claimHeld: true,
      fileAbsent: true,
    });

    await workspace.reconcileNow();
    const settled = await workspace.reconcileNow();
    expect(tabPaths(settled)).toContain("Welcome.md");
    expect(store.saved.at(-1)?.panes[0]?.pinnedPaths).toEqual(["Welcome.md"]);
  });

  it("keeps the tab when a rebuild lands while the kernel holds the file aside", async () => {
    const store = new MemoryWorkspaceStateStore();
    let raced = 0;
    let claimHeld = false;
    let fileAbsent = false;
    const workspace = await openRuntime(store, undefined, undefined, async (point) => {
      if (point !== "write:after-move-aside" || raced > 0 || !runtime) {
        return;
      }
      raced += 1;
      claimHeld = runtime.kernel.transientAbsences.operationFor("Welcome.md") !== undefined;
      fileAbsent = await fs
        .stat(path.join(vaultPath, "Welcome.md"))
        .then(() => false)
        .catch(() => true);
      const spy = vi.spyOn(runtime.indexReactor.index, "refresh").mockImplementation(async () => {
        spy.mockRestore();
        throw new Error("read race");
      });
      await runtime.reconcileNow();
    });
    await workspace.openNote("Linked Note.md");
    const opened = await workspace.openNote("Welcome.md");
    const note = opened.workspace?.activeNote;
    if (!note) throw new Error("Expected the note to open.");
    await workspace.toggleTabPin("Welcome.md", "primary", workspace.vaultId);
    await fs.writeFile(
      path.join(vaultPath, "Linked Note.md"),
      "# Linked Note\n\ntouched\n",
      "utf8",
    );

    const saved = await workspace.saveNote(
      "Welcome.md",
      "# Welcome\n\nsaved through the rebuild\n",
      note.revision,
      workspace.vaultId,
    );
    expect(saved.outcome).toMatchObject({ status: "committed" });
    expect({ raced, claimHeld, fileAbsent }).toEqual({
      raced: 1,
      claimHeld: true,
      fileAbsent: true,
    });

    await workspace.reconcileNow();
    const settled = await workspace.reconcileNow();
    expect(tabPaths(settled)).toContain("Welcome.md");
    expect(store.saved.at(-1)?.panes[0]?.pinnedPaths).toEqual(["Welcome.md"]);
  });

  it("keeps the tab when the confirming re-read cannot tell", async () => {
    const store = new MemoryWorkspaceStateStore();
    const clock = manualClock();
    const workspace = await openPinnedPair(store, clock.now);
    const target = path.join(vaultPath, "Welcome.md");
    const asidePath = path.join(sandboxPath, "Welcome.md.aside");
    await fs.rename(target, asidePath);
    await workspace.reconcileNow();

    // An unreadable filesystem is not evidence a file was deleted, and this one
    // stays unreadable for several passes before the replacement lands.
    let injected = 0;
    const realpath = fs.realpath;
    const spy = vi.spyOn(fs, "realpath").mockImplementation((async (
      target: Parameters<typeof realpath>[0],
      ...rest: unknown[]
    ) => {
      if (typeof target === "string" && target.endsWith("/Welcome.md")) {
        injected += 1;
        const error: NodeJS.ErrnoException = new Error("EACCES: permission denied");
        error.code = "EACCES";
        throw error;
      }
      return (realpath as (...args: unknown[]) => unknown)(target, ...rest);
    }) as unknown as typeof fs.realpath);

    clock.advance(transientAbsenceSettleMs + 1);
    const blocked = await workspace.reconcileNow();
    expect(injected).toBeGreaterThan(0);
    expect(tabPaths(blocked)).toContain("Welcome.md");
    expect(store.saved.at(-1)?.panes[0]?.pinnedPaths).toEqual(["Welcome.md"]);
    expect(blocked.workspace?.watcher.error).toBeNull();

    spy.mockRestore();
    await fs.rename(asidePath, target);
    await workspace.reconcileNow();
    const settled = await workspace.reconcileNow();
    expect(tabPaths(settled)).toContain("Welcome.md");
    expect(store.saved.at(-1)?.panes[0]?.pinnedPaths).toEqual(["Welcome.md"]);
  });

  it("applies the rest of a batch when one deleted path cannot be read", async () => {
    const store = new MemoryWorkspaceStateStore();
    const clock = manualClock();
    const workspace = await openPinnedPair(store, clock.now);
    const realpath = fs.realpath;
    let injected = 0;
    vi.spyOn(fs, "realpath").mockImplementation((async (
      probed: Parameters<typeof realpath>[0],
      ...rest: unknown[]
    ) => {
      if (typeof probed === "string" && probed.endsWith("/Welcome.md")) {
        injected += 1;
        const error: NodeJS.ErrnoException = new Error("EACCES: permission denied");
        error.code = "EACCES";
        throw error;
      }
      return (realpath as (...args: unknown[]) => unknown)(probed, ...rest);
    }) as unknown as typeof fs.realpath);

    // One unreadable path in a batch must not take the batch down with it: the
    // watcher snapshot has already advanced, so anything dropped here is never
    // re-emitted, and the failure escalates into a rescan.
    await fs.unlink(path.join(vaultPath, "Welcome.md"));
    await fs.writeFile(path.join(vaultPath, "Linked Note.md"), "# Linked Note\n\nedited\n", "utf8");
    // The batch itself makes no filesystem call for the deleted path, which is
    // why it cannot be taken down by one; the confirming re-read on the pass
    // after it is where the unreadable path is actually met.
    const applied = await workspace.reconcileNow();
    expect(injected).toBe(0);
    clock.advance(transientAbsenceSettleMs + 1);
    const settled = await workspace.reconcileNow();

    expect(injected).toBeGreaterThan(0);
    expect(applied.workspace?.watcher.error).toBeNull();
    expect(settled.workspace?.watcher.error).toBeNull();
    expect(settled.workspace?.watcher.lastRescanReason).toBeNull();
    expect(settled.workspace?.state).toBe("ready");
    expect(tabPaths(settled)).toContain("Welcome.md");
    const linked = settled.workspace?.files.find(
      ({ path: filePath }) => filePath === "Linked Note.md",
    );
    expect(linked).toBeDefined();
    await expect(workspace.kernel.readText("Linked Note.md")).resolves.toMatchObject({
      content: "# Linked Note\n\nedited\n",
    });
  });

  it("republishes the active note unchanged while its file is held aside", async () => {
    const store = new MemoryWorkspaceStateStore();
    const published: RuntimeSnapshot[] = [];
    let raced = 0;
    const workspace = await openRuntime(store, undefined, undefined, async (point) => {
      if (point !== "write:after-move-aside" || raced > 0 || !runtime) {
        return;
      }
      raced += 1;
      published.push(await runtime.reconcileNow());
      published.push(await runtime.reconcileNow());
    });
    await workspace.openNote("Linked Note.md");
    const opened = await workspace.openNote("Welcome.md");
    const note = opened.workspace?.activeNote;
    if (!note) throw new Error("Expected the note to open.");
    await workspace.toggleTabPin("Welcome.md", "primary", workspace.vaultId);

    await workspace.saveNote(
      "Welcome.md",
      "# Welcome\n\nsaved through the window\n",
      note.revision,
      workspace.vaultId,
    );
    expect(raced).toBe(1);
    // The editor is showing this buffer. Anything else published for it - a
    // different note promoted to active, or a re-read of a file that is not
    // there - resets the document and discards its undo history.
    expect(published).toHaveLength(2);
    for (const snapshot of published) {
      expect(snapshot.workspace?.activeNote).toMatchObject({
        path: note.path,
        revision: note.revision,
        content: note.content,
      });
      expect(snapshot.workspace?.tabs).toContainEqual(
        expect.objectContaining({ path: "Welcome.md", pinned: true, active: true }),
      );
    }
  });

  it("ignores a deletion the workspace is not tracking", async () => {
    const store = new MemoryWorkspaceStateStore();
    const workspace = await openRuntime(store);
    await workspace.openNote("Welcome.md");
    await fs.writeFile(path.join(vaultPath, "Untracked.md"), "# Untracked\n", "utf8");
    await workspace.reconcileNow();
    await fs.unlink(path.join(vaultPath, "Untracked.md"));

    let probes = 0;
    const realpath = fs.realpath;
    const spy = vi.spyOn(fs, "realpath").mockImplementation((async (
      probed: Parameters<typeof realpath>[0],
      ...rest: unknown[]
    ) => {
      if (typeof probed === "string" && probed.endsWith("/Untracked.md")) {
        probes += 1;
      }
      return (realpath as (...args: unknown[]) => unknown)(probed, ...rest);
    }) as unknown as typeof fs.realpath);
    await workspace.reconcileNow();
    const settled = await workspace.reconcileNow();
    spy.mockRestore();

    // A path no pane holds needs no protection, so it never becomes an absence
    // and never costs a confirmation read. Its file is gone, so the scan cannot
    // be the source of these probes.
    expect(probes).toBe(0);
    expect(tabPaths(settled)).toContain("Welcome.md");
    expect(tabPaths(settled)).not.toContain("Untracked.md");
  });

  it("closes an all-indeterminate absence exactly at the confirmation hard cap", async () => {
    const store = new MemoryWorkspaceStateStore();
    const clock = manualClock();
    const workspace = await openPinnedPair(store, clock.now);
    await workspace.watcher.close();
    await fs.unlink(path.join(vaultPath, "Welcome.md"));
    await workspace.reconcileNow();

    const realpath = fs.realpath;
    let targetProbes = 0;
    vi.spyOn(fs, "realpath").mockImplementation((async (
      probed: Parameters<typeof realpath>[0],
      ...rest: unknown[]
    ) => {
      if (typeof probed === "string" && probed.endsWith("/Welcome.md")) {
        targetProbes += 1;
        const error: NodeJS.ErrnoException = new Error("EIO: i/o error");
        error.code = "EIO";
        throw error;
      }
      return (realpath as (...args: unknown[]) => unknown)(probed, ...rest);
    }) as unknown as typeof fs.realpath);

    clock.advance(transientAbsenceSettleMs + 1);
    let settled = await workspace.getSnapshot();
    for (let attempt = 1; attempt <= maximumAbsenceConfirmationAttempts; attempt += 1) {
      settled = await workspace.reconcileNow();
      expect(targetProbes).toBe(attempt);
      if (attempt < maximumAbsenceConfirmationAttempts) {
        expect(tabPaths(settled)).toContain("Welcome.md");
        expect(store.saved.at(-1)?.panes[0]?.pinnedPaths).toEqual(["Welcome.md"]);
        clock.advance(absenceConfirmationIntervalMs + 1);
      }
    }

    expect(targetProbes).toBe(maximumAbsenceConfirmationAttempts);
    expect(tabPaths(settled)).not.toContain("Welcome.md");
    expect(store.saved.at(-1)?.panes[0]?.openPaths).toEqual(["Linked Note.md"]);
    expect(store.saved.at(-1)?.panes[0]?.pinnedPaths).toEqual([]);
  });

  it("stops asking for watcher scans while bounded direct re-reads keep failing", async () => {
    const store = new MemoryWorkspaceStateStore();
    const clock = manualClock();
    const workspace = await openPinnedPair(store, clock.now);
    const target = path.join(vaultPath, "Welcome.md");
    const asidePath = path.join(sandboxPath, "Welcome.md.aside");
    await fs.rename(target, asidePath);
    await workspace.reconcileNow();

    const realpath = fs.realpath;
    const failing = vi.spyOn(fs, "realpath").mockImplementation((async (
      probed: Parameters<typeof realpath>[0],
      ...rest: unknown[]
    ) => {
      if (typeof probed === "string" && probed.endsWith("/Welcome.md")) {
        const error: NodeJS.ErrnoException = new Error("EIO: i/o error");
        error.code = "EIO";
        throw error;
      }
      return (realpath as (...args: unknown[]) => unknown)(probed, ...rest);
    }) as unknown as typeof fs.realpath);
    const followUps = vi.spyOn(workspace.watcher, "requestFollowUpScan");
    clock.advance(transientAbsenceSettleMs + 1);
    for (let pass = 0; pass < maximumAbsenceConfirmationAttempts; pass += 1) {
      await workspace.reconcileNow();
      clock.advance(absenceConfirmationIntervalMs + 1);
    }
    const requested = followUps.mock.calls.length;
    followUps.mockRestore();
    failing.mockRestore();

    // Indeterminate reads consume the epoch's fixed direct-read budget. They do
    // not request watcher scans, and a filesystem that never answers cannot hold
    // the tab forever.
    expect(requested).toBe(0);
    const settled = await workspace.getSnapshot();
    expect(tabPaths(settled)).not.toContain("Welcome.md");
    expect(store.saved.at(-1)?.panes[0]?.pinnedPaths).toEqual([]);
  }, 30000);

  it("does not reset an absence epoch merely because the filesystem answers again", async () => {
    const store = new MemoryWorkspaceStateStore();
    const clock = manualClock();
    const workspace = await openRuntime(store, undefined, undefined, undefined, clock.now);
    await workspace.openNote("Linked Note.md");
    await workspace.openNote("Welcome.md");
    const target = path.join(vaultPath, "Welcome.md");
    await fs.rename(target, path.join(sandboxPath, "Welcome.md.aside"));
    await workspace.reconcileNow();

    const realpath = fs.realpath;
    let targetProbe = 0;
    vi.spyOn(fs, "realpath").mockImplementation((async (
      probed: Parameters<typeof realpath>[0],
      ...rest: unknown[]
    ) => {
      if (typeof probed === "string" && probed.endsWith("/Welcome.md")) {
        targetProbe += 1;
        if (targetProbe % 2 === 1) {
          const error: NodeJS.ErrnoException = new Error("EIO: i/o error");
          error.code = "EIO";
          throw error;
        }
      }
      return (realpath as (...args: unknown[]) => unknown)(probed, ...rest);
    }) as unknown as typeof fs.realpath);
    const followUps = vi.spyOn(workspace.watcher, "requestFollowUpScan");
    clock.advance(transientAbsenceSettleMs + 1);
    let settled = await workspace.getSnapshot();
    for (let pass = 0; pass < maximumAbsenceConfirmationAttempts; pass += 1) {
      settled = await workspace.reconcileNow();
      clock.advance(absenceConfirmationIntervalMs + 1);
    }

    // EIO, absent, EIO, absent is one epoch. Definitive reads do not replenish
    // work after an indeterminate one, so the fourth bounded read must settle it.
    expect(targetProbe).toBe(maximumAbsenceConfirmationAttempts);
    expect(followUps.mock.calls).toHaveLength(0);
    expect(tabPaths(settled)).not.toContain("Welcome.md");
  }, 30000);

  it("restores a deferred tab when the workspace is reopened mid-window", async () => {
    const store = new MemoryWorkspaceStateStore();
    const workspace = await openPinnedPair(store);
    const target = path.join(vaultPath, "Welcome.md");
    const asidePath = path.join(sandboxPath, "Welcome.md.aside");
    await fs.rename(target, asidePath);
    await workspace.reconcileNow();
    await workspace.close();
    runtime = undefined;

    await fs.rename(asidePath, target);
    const restarted = await openRuntime(store);
    const snapshot = await restarted.getSnapshot();
    expect(tabPaths(snapshot)).toContain("Welcome.md");
    expect(snapshot.workspace?.tabs).toContainEqual(
      expect.objectContaining({ path: "Welcome.md", pinned: true }),
    );
  });

  it("keeps a restored pinned tab whose file has not arrived yet, and opens it when it does", async () => {
    // The vault this session restores against is one three hosts write to, and a
    // boot can beat the sync. The tab is the user's, not the filesystem's.
    const store = new MemoryWorkspaceStateStore({
      openPaths: ["Welcome.md", "Syncing.md"],
      pinnedPaths: ["Syncing.md"],
      activePath: "Syncing.md",
    });
    const clock = manualClock();
    const workspace = await openRuntime(store, undefined, undefined, undefined, clock.now);

    const restored = await workspace.getSnapshot();
    expect(restored.workspace?.tabs).toContainEqual(
      expect.objectContaining({ path: "Syncing.md", pinned: true }),
    );

    clock.advance(startupAbsenceSettleMs / 2);
    await fs.writeFile(
      path.join(vaultPath, "Syncing.md"),
      "# Syncing\n\narrived from another host\n",
      "utf8",
    );
    await workspace.reconcileNow();
    const landed = await workspace.openNote("Syncing.md");
    expect(landed.workspace?.activeNote?.content).toBe("# Syncing\n\narrived from another host\n");
    expect(landed.workspace?.tabs).toContainEqual(
      expect.objectContaining({ path: "Syncing.md", pinned: true, active: true }),
    );

    // Retention is the claim, so it is asserted on every state that was written,
    // not on the one that happens to be current after the file landed.
    for (const saved of store.saved) {
      expect(saved.panes[0]?.openPaths).toContain("Syncing.md");
      expect(saved.panes[0]?.pinnedPaths).toEqual(["Syncing.md"]);
    }
  });

  it("restores navigation history across a path that is missing at startup", async () => {
    const store = new MemoryWorkspaceStateStore();
    const first = await openRuntime(store);
    await first.openNote("Welcome.md");
    await first.openNote("Linked Note.md");
    expect(store.saved.at(-1)?.panes[0]?.navigationHistory).toEqual({
      back: ["Welcome.md"],
      forward: [],
    });
    await first.close();
    runtime = undefined;

    const target = path.join(vaultPath, "Welcome.md");
    const asidePath = path.join(sandboxPath, "Welcome.md.aside");
    await fs.rename(target, asidePath);

    const savedBeforeRestore = store.saved.length;
    const clock = manualClock();
    const reopened = await openRuntime(store, undefined, undefined, undefined, clock.now);
    expect((await reopened.getSnapshot()).workspace?.panes[0]).toMatchObject({ canGoBack: true });
    // Nothing written while the file was away may have dropped the entry.
    for (const saved of store.saved.slice(savedBeforeRestore)) {
      expect(saved.panes[0]?.navigationHistory?.back ?? []).toContain("Welcome.md");
    }

    await fs.rename(asidePath, target);
    await reopened.reconcileNow();
    const back = await reopened.goBack(reopened.vaultId);
    expect(back.workspace?.activeNote?.path).toBe("Welcome.md");
  });

  it("keeps a history entry for a briefly missing path when Back is pressed", async () => {
    const store = new MemoryWorkspaceStateStore();
    const clock = manualClock();
    const workspace = await openRuntime(store, undefined, undefined, undefined, clock.now);
    await fs.writeFile(path.join(vaultPath, "Third.md"), "# Third\n", "utf8");
    await workspace.reconcileNow();
    await workspace.openNote("Welcome.md");
    await workspace.openNote("Linked Note.md");
    await workspace.openNote("Third.md");
    expect(store.saved.at(-1)?.panes[0]?.navigationHistory?.back).toEqual([
      "Linked Note.md",
      "Welcome.md",
    ]);

    const target = path.join(vaultPath, "Welcome.md");
    const asidePath = path.join(sandboxPath, "Welcome.md.aside");
    await fs.rename(target, asidePath);
    await workspace.reconcileNow();

    // Back does not step onto the missing path here - it steps onto the entry in
    // front of it - so nothing about this navigation is about that file. It was
    // pruned all the same, because traversal reconciled the whole history
    // against the listing and persisted the result.
    const back = await workspace.goBack(workspace.vaultId);
    expect(back.workspace?.activeNote?.path).toBe("Linked Note.md");
    expect(store.saved.at(-1)?.panes[0]?.navigationHistory).toEqual({
      back: ["Welcome.md"],
      forward: ["Third.md"],
    });

    await fs.rename(asidePath, target);
    await workspace.reconcileNow();
    const returned = await workspace.goBack(workspace.vaultId);
    expect(returned.workspace?.activeNote?.path).toBe("Welcome.md");
  });

  it("navigates onto a briefly missing path rather than swallowing the Back", async () => {
    const store = new MemoryWorkspaceStateStore();
    const clock = manualClock();
    const workspace = await openRuntime(store, undefined, undefined, undefined, clock.now);
    await workspace.openNote("Welcome.md");
    await workspace.openNote("Linked Note.md");

    const target = path.join(vaultPath, "Welcome.md");
    const asidePath = path.join(sandboxPath, "Welcome.md.aside");
    await fs.rename(target, asidePath);
    await workspace.reconcileNow();

    const back = await workspace.goBack(workspace.vaultId);
    expect(store.saved.at(-1)?.panes[0]?.activePath).toBe("Welcome.md");
    expect(store.saved.at(-1)?.panes[0]?.navigationHistory).toEqual({
      back: [],
      forward: ["Linked Note.md"],
    });
    // The pane says what it is waiting for rather than rendering a document it
    // cannot read, and the tab it landed on is the selected one.
    expect(back.workspace?.panes[0]?.activeUnavailable).toMatchObject({ path: "Welcome.md" });
    expect(back.workspace?.panes[0]?.activeNote).toBeNull();
    expect(back.workspace?.tabs).toContainEqual(
      expect.objectContaining({ path: "Welcome.md", active: true }),
    );

    await fs.writeFile(target, "# Welcome\n\nback again\n", "utf8");
    const settled = await workspace.reconcileNow();
    expect(settled.workspace?.panes[0]?.activeUnavailable ?? null).toBeNull();
    expect(settled.workspace?.activeNote).toMatchObject({
      path: "Welcome.md",
      content: "# Welcome\n\nback again\n",
    });
  });

  it("selects a retained tab instead of throwing out of the click", async () => {
    const store = new MemoryWorkspaceStateStore({
      openPaths: ["Welcome.md", "Syncing.md"],
      pinnedPaths: ["Syncing.md"],
      activePath: "Welcome.md",
    });
    const clock = manualClock();
    const workspace = await openRuntime(store, undefined, undefined, undefined, clock.now);
    expect((await workspace.getSnapshot()).workspace?.tabs).toContainEqual(
      expect.objectContaining({ path: "Syncing.md", pinned: true, active: false }),
    );

    // Nothing has ever been read for this path in this session, so there is no
    // retained snapshot to fall back on either. The click still has to work.
    const clicked = await workspace.openNote("Syncing.md");
    expect(clicked.workspace?.tabs).toContainEqual(
      expect.objectContaining({ path: "Syncing.md", pinned: true, active: true }),
    );
    expect(clicked.workspace?.panes[0]?.activeUnavailable).toEqual({
      path: "Syncing.md",
      title: "Syncing",
    });
    expect(clicked.workspace?.activeNote).toBeNull();

    await fs.writeFile(path.join(vaultPath, "Syncing.md"), "# Syncing\n\nlanded\n", "utf8");
    const landed = await workspace.reconcileNow();
    expect(landed.workspace?.panes[0]?.activeUnavailable ?? null).toBeNull();
    expect(landed.workspace?.activeNote).toMatchObject({
      path: "Syncing.md",
      content: "# Syncing\n\nlanded\n",
    });
  });

  it("keeps a retained canvas selectable and reports it as unavailable", async () => {
    const store = new MemoryWorkspaceStateStore({
      openPaths: ["Welcome.md", "Boards/Missing.canvas"],
      activePath: "Welcome.md",
    });
    const clock = manualClock();
    const workspace = await openRuntime(store, undefined, undefined, undefined, clock.now);

    const clicked = await workspace.openNote("Boards/Missing.canvas");
    expect(clicked.workspace?.panes[0]?.activeUnavailable).toMatchObject({
      path: "Boards/Missing.canvas",
    });
    expect(clicked.workspace?.panes[0]?.activeCanvas ?? null).toBeNull();
    expect(clicked.workspace?.tabs).toContainEqual(
      expect.objectContaining({ path: "Boards/Missing.canvas", active: true }),
    );
  });

  it("observes a canvas going missing even though the watcher never diffs one", async () => {
    // The watcher snapshots Markdown only, so a canvas rename produces no diff
    // and no batch of its own. Anything that decided when to look at the vault
    // again from the watcher's sequence therefore never looked at all, and the
    // absence of a canvas was invisible until unrelated Markdown activity moved
    // the sequence on.
    const store = new MemoryWorkspaceStateStore();
    const clock = manualClock();
    const workspace = await openRuntime(store, undefined, undefined, undefined, clock.now);
    await workspace.openNote("Welcome.md");
    await workspace.openNote("Boards/Overview.canvas");

    const target = path.join(vaultPath, "Boards", "Overview.canvas");
    const asidePath = path.join(sandboxPath, "Overview.canvas.aside");
    await fs.rename(target, asidePath);
    expect(await workspace.watcher.scanNow()).toBeNull();

    const during = await workspace.reconcileNow();
    expect(during.workspace?.canvasFiles ?? []).not.toContainEqual(
      expect.objectContaining({ path: "Boards/Overview.canvas" }),
    );

    await fs.rename(asidePath, target);
    const settled = await workspace.reconcileNow();
    expect(settled.workspace?.canvasFiles ?? []).toContainEqual(
      expect.objectContaining({ path: "Boards/Overview.canvas" }),
    );
  });

  it("keeps an active canvas tab, its pin, and its selection through a transient absence", async () => {
    const store = new MemoryWorkspaceStateStore();
    const clock = manualClock();
    const workspace = await openRuntime(store, undefined, undefined, undefined, clock.now);
    await workspace.openNote("Welcome.md");
    await workspace.openNote("Boards/Overview.canvas");
    await workspace.toggleTabPin("Boards/Overview.canvas", "primary", workspace.vaultId);
    const settledSetup = store.saved.length;

    const target = path.join(vaultPath, "Boards", "Overview.canvas");
    const asidePath = path.join(sandboxPath, "Overview.canvas.aside");
    await fs.rename(target, asidePath);
    const during = await workspace.reconcileNow();
    expect(during.workspace?.tabs).toContainEqual(
      expect.objectContaining({ path: "Boards/Overview.canvas", pinned: true, active: true }),
    );
    // Republished exactly as it was, not emptied to a waiting state. A canvas
    // view is a live surface with its own view state, and rebuilding it for a
    // gap nobody caused throws away everything the pane was showing - which is
    // the same reason an active note is republished rather than re-read.
    expect(during.workspace?.panes[0]?.activeUnavailable ?? null).toBeNull();
    expect(during.workspace?.panes[0]?.activeCanvas?.path).toBe("Boards/Overview.canvas");

    await fs.rename(asidePath, target);
    const settled = await workspace.reconcileNow();
    expect(settled.workspace?.panes[0]?.activeCanvas?.path).toBe("Boards/Overview.canvas");
    // The selection is the assertion, not just the tab: a retained path that
    // cannot hold it has its pane's activePath rewritten and persisted, and
    // nothing puts the selection back when the file returns.
    for (const saved of store.saved.slice(settledSetup)) {
      expect(saved.panes[0]?.activePath).toBe("Boards/Overview.canvas");
      expect(saved.panes[0]?.openPaths).toContain("Boards/Overview.canvas");
      expect(saved.panes[0]?.pinnedPaths).toEqual(["Boards/Overview.canvas"]);
    }
  });

  it("closes a canvas tab once its deletion is confirmed", async () => {
    const store = new MemoryWorkspaceStateStore();
    const clock = manualClock();
    const workspace = await openRuntime(store, undefined, undefined, undefined, clock.now);
    await workspace.openNote("Welcome.md");
    await workspace.openNote("Boards/Overview.canvas");

    await fs.unlink(path.join(vaultPath, "Boards", "Overview.canvas"));
    await workspace.reconcileNow();
    clock.advance(transientAbsenceSettleMs + 1);
    await workspace.reconcileNow();
    clock.advance(absenceConfirmationIntervalMs + 1);
    const confirmed = await workspace.reconcileNow();
    expect(tabPaths(confirmed)).not.toContain("Boards/Overview.canvas");
    expect(store.saved.at(-1)?.panes[0]?.openPaths).not.toContain("Boards/Overview.canvas");
    expect(store.saved.at(-1)?.panes[0]?.activePath).toBe("Welcome.md");
  });

  it("keeps an unattributed replace for as many passes as its settle window lasts", async () => {
    const store = new MemoryWorkspaceStateStore();
    const clock = manualClock();
    const workspace = await openRuntime(store, undefined, undefined, undefined, clock.now);
    await workspace.openNote("Linked Note.md");
    await workspace.openNote("Welcome.md");
    await workspace.toggleTabPin("Welcome.md", "primary", workspace.vaultId);
    const target = path.join(vaultPath, "Welcome.md");
    const asidePath = path.join(sandboxPath, "Welcome.md.aside");
    const settledSetup = store.saved.length;

    // No kernel claim covers an outside writer, so the number of passes that fit
    // inside its gap is whatever this machine happened to manage. Ten of them
    // land inside the window here, and the count is not what decides.
    await fs.rename(target, asidePath);
    await workspace.reconcileNow();
    clock.advance(transientAbsenceSettleMs - 1);
    for (let pass = 0; pass < 10; pass += 1) {
      await workspace.reconcileNow();
    }
    for (const saved of store.saved.slice(settledSetup)) {
      expect(saved.panes[0]?.openPaths).toContain("Welcome.md");
      expect(saved.panes[0]?.pinnedPaths).toEqual(["Welcome.md"]);
    }

    await fs.writeFile(target, "# Welcome\n\nreplaced by an outside writer\n", "utf8");
    const settled = await workspace.reconcileNow();
    expect(settled.workspace?.tabs).toContainEqual(
      expect.objectContaining({ path: "Welcome.md", pinned: true, active: true }),
    );
    expect(settled.workspace?.activeNote?.content).toBe(
      "# Welcome\n\nreplaced by an outside writer\n",
    );
    expect(store.saved.at(-1)?.panes[0]?.pinnedPaths).toEqual(["Welcome.md"]);
  });

  it("closes an unattributed absence that outlives its settle window", async () => {
    const store = new MemoryWorkspaceStateStore();
    const clock = manualClock();
    const workspace = await openRuntime(store, undefined, undefined, undefined, clock.now);
    await workspace.openNote("Linked Note.md");
    await workspace.openNote("Welcome.md");
    await workspace.toggleTabPin("Welcome.md", "primary", workspace.vaultId);

    await fs.unlink(path.join(vaultPath, "Welcome.md"));
    await workspace.reconcileNow();
    clock.advance(transientAbsenceSettleMs + 1);

    // The window ending is necessary and not sufficient: one re-read past it is
    // still a single look, and a run of them is what confirmation is made of.
    const single = await workspace.reconcileNow();
    expect(tabPaths(single)).toContain("Welcome.md");
    expect(store.saved.at(-1)?.panes[0]?.pinnedPaths).toEqual(["Welcome.md"]);

    clock.advance(absenceConfirmationIntervalMs + 1);
    const confirmed = await workspace.reconcileNow();
    expect(tabPaths(confirmed)).toEqual(["Linked Note.md"]);
    expect(store.saved.at(-1)?.panes[0]?.openPaths).toEqual(["Linked Note.md"]);
    expect(store.saved.at(-1)?.panes[0]?.pinnedPaths).toEqual([]);
  });

  it("keeps a pinned tab across live replace gaps and still closes a live deletion", async () => {
    // Both boundaries against the real debounced watcher, on the real clock,
    // with nothing driving reconciliation but the watcher itself. The kept side
    // is asserted on every persisted state rather than on the last one, so it
    // says the tab was never written away rather than that it came back in time.
    for (const gapMs of [50, 150, 300, 500]) {
      const store = new MemoryWorkspaceStateStore();
      const workspace = await openRuntime(store);
      await workspace.openNote("Linked Note.md");
      await workspace.openNote("Welcome.md");
      await workspace.toggleTabPin("Welcome.md", "primary", workspace.vaultId);
      const target = path.join(vaultPath, "Welcome.md");
      const asidePath = path.join(sandboxPath, `Welcome.md.aside-${gapMs}`);
      const settledSetup = store.saved.length;

      await fs.rename(target, asidePath);
      await new Promise((resolve) => setTimeout(resolve, gapMs));
      await fs.writeFile(target, `# Welcome\n\nreplaced after ${gapMs}ms\n`, "utf8");
      // Well past the window the gap sat inside, so a decision has been reached.
      await new Promise((resolve) => setTimeout(resolve, transientAbsenceSettleMs + 1000));

      for (const saved of store.saved.slice(settledSetup)) {
        expect({ gapMs, openPaths: saved.panes[0]?.openPaths }).toEqual({
          gapMs,
          openPaths: expect.arrayContaining(["Welcome.md"]),
        });
        expect({ gapMs, pinnedPaths: saved.panes[0]?.pinnedPaths }).toEqual({
          gapMs,
          pinnedPaths: ["Welcome.md"],
        });
      }
      const snapshot = await workspace.getSnapshot();
      expect({ gapMs, tabs: tabPaths(snapshot) }).toEqual({
        gapMs,
        tabs: expect.arrayContaining(["Welcome.md"]),
      });
      await workspace.close();
      runtime = undefined;
    }

    const store = new MemoryWorkspaceStateStore();
    const workspace = await openRuntime(store);
    await workspace.openNote("Linked Note.md");
    await workspace.openNote("Welcome.md");
    await workspace.toggleTabPin("Welcome.md", "primary", workspace.vaultId);

    const deletedAt = Date.now();
    await fs.unlink(path.join(vaultPath, "Welcome.md"));
    const deadline = deletedAt + 20000;
    while (
      Date.now() < deadline &&
      (store.saved.at(-1)?.panes[0]?.openPaths ?? []).includes("Welcome.md")
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const closedAfterMs = Date.now() - deletedAt;

    // The deletion closes, and it does not close early: the window it had to
    // outlive is the same one the gaps above sat inside. Only the lower bound is
    // asserted, because how far past it a loaded machine lands is not a contract.
    expect(store.saved.at(-1)?.panes[0]?.openPaths).toEqual(["Linked Note.md"]);
    expect(store.saved.at(-1)?.panes[0]?.pinnedPaths).toEqual([]);
    expect(closedAfterMs).toBeGreaterThanOrEqual(transientAbsenceSettleMs);
  }, 60000);

  it("keeps a path both panes track through a transient absence", async () => {
    const store = new MemoryWorkspaceStateStore();
    const workspace = await openRuntime(store);
    await workspace.openNote("Welcome.md");
    await workspace.splitWorkspace("vertical", workspace.vaultId);
    await workspace.openNote("Welcome.md");
    const target = path.join(vaultPath, "Welcome.md");
    const asidePath = path.join(sandboxPath, "Welcome.md.aside");

    await fs.rename(target, asidePath);
    await workspace.reconcileNow();
    await fs.rename(asidePath, target);
    const settled = await workspace.reconcileNow();
    for (const pane of settled.workspace?.panes ?? []) {
      expect(pane.tabs.map(({ path: filePath }) => filePath)).toContain("Welcome.md");
    }
    for (const pane of store.saved.at(-1)?.panes ?? []) {
      expect(pane.openPaths).toContain("Welcome.md");
    }
  });
});
