import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import moment from "moment";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FixedStateRoot } from "../kernel/ports";
import type { PluginRuntimePort } from "../runtime/plugin-runtime-port";
import type { RuntimeSnapshot } from "../shared/contracts";
import { createDefaultVaultNoteWorkflowSettings } from "../shared/note-workflows";
import { WorkspaceRuntime } from "./workspace-runtime";
import {
  createWorkspaceLayout,
  createWorkspaceState,
  type PersistedWorkspaceState,
  parseWorkspaceState,
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
  readonly #initial: { openPaths: string[]; activePath: string | null } | null;

  constructor(initial: { openPaths: string[]; activePath: string | null } | null = null) {
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
      ? createWorkspaceState(vaultId, this.#initial.openPaths, this.#initial.activePath)
      : null;
  }

  async save(state: PersistedWorkspaceState): Promise<PersistedWorkspaceState> {
    if (this.saveError) {
      throw this.saveError;
    }
    const normalized = createWorkspaceLayout(
      state.vaultId,
      state.panes,
      state.activePaneId,
      state.splitDirection,
    );
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
      runtime.saveNote(note.path, "blocked", note.revision, runtime.vaultId),
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
        id: "threadleaf-fixture-confirm",
        name: "Confirm compatibility bridge",
        source: "plugin",
      },
      { id: "workspace.create-note", name: "Create note", source: "workspace" },
      { id: "workspace.focus-pane", name: "Focus workspace pane", source: "workspace" },
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
      {
        id: "workspace.remove-note-property",
        name: "Remove note property",
        source: "workspace",
      },
      { id: "workspace.save-note", name: "Save note", source: "workspace" },
      {
        id: "workspace.set-note-property",
        name: "Set note property",
        source: "workspace",
      },
      { id: "workspace.split", name: "Split workspace", source: "workspace" },
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
      openPluginSettings: async () => pluginSnapshot(),
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
          tabs: [{ path: "Linked Note.md", active: true }],
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

  it("reuses the unchanged derived file projection across snapshots", async () => {
    const workspace = await openRuntime();

    const first = await workspace.getSnapshot();
    const second = await workspace.getSnapshot();

    expect(second.workspace?.files).toBe(first.workspace?.files);
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
      panes: [
        {
          openPaths: ["Welcome.md", "Linked Note.md"],
          activePath: "Linked Note.md",
        },
      ],
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
      { id: "workspace.close-pane", name: "Close workspace pane", source: "workspace" },
      { id: "workspace.create-note", name: "Create note", source: "workspace" },
      { id: "workspace.focus-pane", name: "Focus workspace pane", source: "workspace" },
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
      {
        id: "workspace.remove-note-property",
        name: "Remove note property",
        source: "workspace",
      },
      { id: "workspace.save-note", name: "Save note", source: "workspace" },
      {
        id: "workspace.set-note-property",
        name: "Set note property",
        source: "workspace",
      },
      { id: "workspace.split", name: "Split workspace", source: "workspace" },
    ]);
    await expect(workspace.openNote("Welcome.md")).resolves.toMatchObject({
      workspace: { activeNote: { path: "Welcome.md" } },
    });
  });
});
