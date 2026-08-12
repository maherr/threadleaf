import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FixedStateRoot } from "../kernel/ports";
import type { PluginRuntimePort } from "../runtime/plugin-runtime-port";
import type { RuntimeSnapshot } from "../shared/contracts";
import { WorkspaceRuntime } from "./workspace-runtime";
import {
  createWorkspaceState,
  type PersistedWorkspaceState,
  type WorkspaceStateStore,
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
  readonly #initial: Pick<PersistedWorkspaceState, "openPaths" | "activePath"> | null;

  constructor(initial: Pick<PersistedWorkspaceState, "openPaths" | "activePath"> | null = null) {
    this.#initial = initial;
  }

  async load(vaultId: string): Promise<PersistedWorkspaceState | null> {
    if (this.loadError) {
      throw this.loadError;
    }
    if (this.value) {
      return createWorkspaceState(vaultId, this.value.openPaths, this.value.activePath);
    }
    return this.#initial
      ? createWorkspaceState(vaultId, this.#initial.openPaths, this.#initial.activePath)
      : null;
  }

  async save(state: PersistedWorkspaceState): Promise<PersistedWorkspaceState> {
    if (this.saveError) {
      throw this.saveError;
    }
    const normalized = createWorkspaceState(state.vaultId, state.openPaths, state.activePath);
    this.value = normalized;
    this.saved.push(normalized);
    return normalized;
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

async function openRuntime(workspaceStateStore?: WorkspaceStateStore): Promise<WorkspaceRuntime> {
  runtime = await WorkspaceRuntime.open({
    vaultRoot: vaultPath,
    stateRoot: new FixedStateRoot(statePath),
    pluginDirectory: path.join(vaultPath, ".obsidian", "plugins", "threadleaf-fixture"),
    ...(workspaceStateStore ? { workspaceStateStore } : {}),
  });
  return runtime;
}

describe("WorkspaceRuntime", () => {
  it("composes the kernel, metadata, shared actions, and compatibility host", async () => {
    const workspace = await openRuntime();

    const initial = await workspace.getSnapshot();

    expect(initial.vault).toMatchObject({
      name: "vault",
      path: vaultPath,
      markdownFileCount: 2,
      mode: "kernel-backed",
      source: "direct",
      warning: null,
    });
    expect(initial.workspace).toMatchObject({
      state: "ready",
      files: [
        { path: "Linked Note.md", title: "Linked Note" },
        { path: "Welcome.md", title: "Welcome", outgoingCount: 1 },
      ],
      activeNote: { path: "Linked Note.md", title: "Linked Note" },
      tabs: [{ path: "Linked Note.md", title: "Linked Note", active: true }],
    });
    expect(initial.actions).toEqual([
      { id: "workspace.close-note", name: "Close note", source: "workspace" },
      {
        id: "threadleaf-fixture-confirm",
        name: "Confirm compatibility bridge",
        source: "plugin",
      },
      { id: "workspace.create-note", name: "Create note", source: "workspace" },
      { id: "workspace.delete-note", name: "Move note to trash", source: "workspace" },
      { id: "workspace.move-note", name: "Move or rename note", source: "workspace" },
      { id: "workspace.open-note", name: "Open note", source: "workspace" },
      { id: "workspace.save-note", name: "Save note", source: "workspace" },
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
      ],
    });
    await expect(
      workspace.openNote(".obsidian/plugins/threadleaf-fixture/main.js"),
    ).rejects.toThrow("not indexed");

    const commanded = await workspace.runPluginCommand("threadleaf-fixture-confirm");
    expect(commanded.notices).toContain("Fixture command crossed the compatibility bridge.");
    expect(commanded.plugin?.compatibilityLevel).toBe(4);
  });

  it("merges actions and command workflows from an external plugin runtime", async () => {
    let compatibilityLevel: 0 | 1 | 2 | 3 | 4 = 3;
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
        compatibilityLevel,
        stylesheetDiscovered: false,
        error: null,
      },
      plugins: [],
      commands: [{ id: "external-command", name: "External command", ownerId: "external-fixture" }],
      actions: [{ id: "external-command", name: "External command", source: "plugin" }],
      notices: compatibilityLevel === 4 ? ["External command ran."] : [],
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
      openPluginView: async () => pluginSnapshot(),
      reloadPlugin: async () => pluginSnapshot(),
      runCommand: async () => {
        compatibilityLevel = 4;
        return pluginSnapshot();
      },
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
    expect(commanded.plugin?.compatibilityLevel).toBe(4);
    expect(commanded.notices).toEqual(["External command ran."]);

    await runtime.close();
    runtime = undefined;
    expect(closed).toBe(true);
  });

  it("opens, reuses, activates, and closes ordered note tabs", async () => {
    const workspace = await openRuntime();

    const welcome = await workspace.openNote("Welcome.md");
    expect(welcome.workspace?.tabs).toEqual([
      { path: "Linked Note.md", title: "Linked Note", active: false },
      { path: "Welcome.md", title: "Welcome", active: true },
    ]);

    const reused = await workspace.openNote("Linked Note.md");
    expect(reused.workspace?.tabs).toEqual([
      { path: "Linked Note.md", title: "Linked Note", active: true },
      { path: "Welcome.md", title: "Welcome", active: false },
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

  it("restores ordered tabs, chooses a surviving active note, and prunes stale paths", async () => {
    const store = new MemoryWorkspaceStateStore({
      openPaths: ["Welcome.md", "Missing.md", "Linked Note.md"],
      activePath: "Missing.md",
    });
    const workspace = await openRuntime(store);

    const snapshot = await workspace.getSnapshot();

    expect(snapshot.workspace).toMatchObject({
      tabs: [
        { path: "Welcome.md", active: false },
        { path: "Linked Note.md", active: true },
      ],
      activeNote: { path: "Linked Note.md" },
    });
    expect(store.saved.at(-1)).toMatchObject({
      openPaths: ["Welcome.md", "Linked Note.md"],
      activePath: "Linked Note.md",
    });
    expect(snapshot.vault.warning).toBeNull();
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

  it("keeps open tabs aligned with external note renames and deletions", async () => {
    const workspace = await openRuntime();
    await workspace.openNote("Welcome.md");

    await fs.rename(path.join(vaultPath, "Welcome.md"), path.join(vaultPath, "Renamed.md"));
    const renamed = await workspace.reconcileNow();
    expect(renamed.workspace).toMatchObject({
      tabs: [
        { path: "Linked Note.md", active: false },
        { path: "Renamed.md", active: true },
      ],
      activeNote: { path: "Renamed.md" },
    });

    await fs.unlink(path.join(vaultPath, "Renamed.md"));
    const deleted = await workspace.reconcileNow();
    expect(deleted.workspace).toMatchObject({
      tabs: [{ path: "Linked Note.md", active: true }],
      activeNote: { path: "Linked Note.md" },
    });
  });

  it("moves an open note through the link-safe service and remaps its tab", async () => {
    const workspace = await openRuntime();
    const opened = await workspace.openNote("Welcome.md");
    const note = opened.workspace?.activeNote;
    if (!note) {
      throw new Error("Expected an active note.");
    }

    const moved = await workspace.moveNote(
      note.path,
      "Archive/Welcome",
      note.revision,
      workspace.vaultId,
    );

    expect(moved.outcome).toMatchObject({
      status: "committed",
      from: "Welcome.md",
      to: "Archive/Welcome.md",
    });
    expect(moved.snapshot.workspace).toMatchObject({
      tabs: [
        { path: "Linked Note.md", active: false },
        { path: "Archive/Welcome.md", active: true },
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
      files: [{ path: "Welcome.md", unresolvedCount: 1 }],
      tabs: [{ path: "Welcome.md", active: true }],
      activeNote: {
        path: "Welcome.md",
        outgoing: [{ target: "Linked Note", status: "unresolved" }],
      },
    });
    expect(store.saved.at(-1)).toMatchObject({
      openPaths: ["Welcome.md"],
      activePath: "Welcome.md",
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

  it("keeps Markdown image targets out of the note-link inspector", async () => {
    await fs.writeFile(
      path.join(vaultPath, "Gallery.md"),
      "# Gallery\n\n![Local](assets/image.png)\n\n[[Linked Note]]",
      "utf8",
    );
    const workspace = await openRuntime();
    const opened = await workspace.openNote("Gallery.md");

    expect(opened.workspace?.activeNote?.outgoing).toEqual([
      expect.objectContaining({ syntax: "wiki", path: "Linked Note.md", status: "resolved" }),
    ]);
    expect(opened.workspace?.files.find((file) => file.path === "Gallery.md")).toMatchObject({
      outgoingCount: 1,
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
      { id: "workspace.create-note", name: "Create note", source: "workspace" },
      { id: "workspace.delete-note", name: "Move note to trash", source: "workspace" },
      { id: "workspace.move-note", name: "Move or rename note", source: "workspace" },
      { id: "workspace.open-note", name: "Open note", source: "workspace" },
      { id: "workspace.save-note", name: "Save note", source: "workspace" },
    ]);
    await expect(workspace.openNote("Welcome.md")).resolves.toMatchObject({
      workspace: { activeNote: { path: "Welcome.md" } },
    });
  });
});
