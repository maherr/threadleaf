import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedStateRoot } from "../kernel/ports";
import { WorkspaceRuntime } from "./workspace-runtime";

const fixtureVault = path.resolve("fixtures/vaults/basic");
let sandboxPath: string;
let vaultPath: string;
let statePath: string;
let runtime: WorkspaceRuntime | undefined;

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

async function openRuntime(): Promise<WorkspaceRuntime> {
  runtime = await WorkspaceRuntime.open({
    vaultRoot: vaultPath,
    stateRoot: new FixedStateRoot(statePath),
    pluginDirectory: path.join(vaultPath, ".obsidian", "plugins", "threadleaf-fixture"),
  });
  return runtime;
}

describe("WorkspaceRuntime", () => {
  it("composes the kernel, metadata, shared actions, and compatibility host", async () => {
    const workspace = await openRuntime();

    const initial = await workspace.getSnapshot();

    expect(initial.vault).toMatchObject({
      name: "vault",
      markdownFileCount: 2,
      mode: "kernel-backed-fixture",
    });
    expect(initial.workspace).toMatchObject({
      state: "ready",
      files: [
        { path: "Linked Note.md", title: "Linked Note" },
        { path: "Welcome.md", title: "Welcome", outgoingCount: 1 },
      ],
      activeNote: { path: "Linked Note.md", title: "Linked Note" },
    });
    expect(initial.actions).toEqual([
      {
        id: "threadleaf-fixture-confirm",
        name: "Confirm compatibility bridge",
        source: "plugin",
      },
      { id: "workspace.open-note", name: "Open note", source: "workspace" },
    ]);

    const opened = await workspace.openNote("Welcome.md");
    expect(opened.workspace?.activeNote).toMatchObject({
      path: "Welcome.md",
      outgoing: [
        {
          label: "Linked Note",
          status: "resolved",
          path: "Linked Note.md",
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
      { id: "workspace.open-note", name: "Open note", source: "workspace" },
    ]);
    await expect(workspace.openNote("Welcome.md")).resolves.toMatchObject({
      workspace: { activeNote: { path: "Welcome.md" } },
    });
  });
});
