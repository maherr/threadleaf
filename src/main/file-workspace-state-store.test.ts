import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileWorkspaceStateStore } from "./file-workspace-state-store";

let sandboxPath: string;
let workspaceDirectory: string;
const vaultId = "a".repeat(64);

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-workspace-state-"));
  workspaceDirectory = path.join(sandboxPath, "state", "workspaces");
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

describe("FileWorkspaceStateStore", () => {
  it("returns null without creating state when a vault has no saved workspace", async () => {
    const store = new FileWorkspaceStateStore(workspaceDirectory);

    await expect(store.load(vaultId)).resolves.toBeNull();
    await expect(fs.stat(workspaceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("durably replaces one vault state with private file permissions", async () => {
    const store = new FileWorkspaceStateStore(workspaceDirectory);
    await store.save({
      version: 2,
      vaultId,
      panes: [
        {
          id: "primary",
          openPaths: ["First.md", "Second.md"],
          pinnedPaths: ["First.md"],
          activePath: "Second.md",
        },
      ],
      activePaneId: "primary",
      splitDirection: null,
    });
    await store.save({
      version: 2,
      vaultId,
      panes: [
        { id: "primary", openPaths: ["Second.md"], pinnedPaths: [], activePath: "Second.md" },
        {
          id: "secondary",
          openPaths: ["Third.md"],
          pinnedPaths: ["Third.md"],
          activePath: "Third.md",
        },
      ],
      activePaneId: "secondary",
      splitDirection: "horizontal",
    });

    await expect(store.load(vaultId)).resolves.toEqual({
      version: 2,
      vaultId,
      panes: [
        { id: "primary", openPaths: ["Second.md"], pinnedPaths: [], activePath: "Second.md" },
        {
          id: "secondary",
          openPaths: ["Third.md"],
          pinnedPaths: ["Third.md"],
          activePath: "Third.md",
        },
      ],
      activePaneId: "secondary",
      splitDirection: "horizontal",
    });
    const filePath = path.join(workspaceDirectory, `${vaultId}.json`);
    const document = JSON.parse(await fs.readFile(filePath, "utf8"));
    expect(document).toMatchObject({
      version: 1,
      layoutVersion: 2,
      openPaths: ["Third.md"],
      activePath: "Third.md",
      panes: [
        {
          id: "primary",
          openPaths: ["Second.md"],
          pinnedPaths: [],
          activePath: "Second.md",
        },
        {
          id: "secondary",
          openPaths: ["Third.md"],
          pinnedPaths: ["Third.md"],
          activePath: "Third.md",
        },
      ],
    });
    const stat = await fs.stat(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("keeps each vault's pinned workspace state isolated for deterministic vault switches", async () => {
    const store = new FileWorkspaceStateStore(workspaceDirectory);
    const otherVaultId = "b".repeat(64);
    await store.save({
      version: 2,
      vaultId,
      panes: [
        {
          id: "primary",
          openPaths: ["First.md", "Second.md"],
          pinnedPaths: ["First.md"],
          activePath: "Second.md",
        },
      ],
      activePaneId: "primary",
      splitDirection: null,
    });
    await store.save({
      version: 2,
      vaultId: otherVaultId,
      panes: [
        {
          id: "primary",
          openPaths: ["Other.md"],
          pinnedPaths: ["Other.md"],
          activePath: "Other.md",
        },
      ],
      activePaneId: "primary",
      splitDirection: null,
    });

    await expect(store.load(vaultId)).resolves.toMatchObject({
      panes: [{ openPaths: ["First.md", "Second.md"], pinnedPaths: ["First.md"] }],
    });
    await expect(store.load(otherVaultId)).resolves.toMatchObject({
      panes: [{ openPaths: ["Other.md"], pinnedPaths: ["Other.md"] }],
    });
  });

  it("rejects a queued stale workspace replacement instead of losing the committed layout", async () => {
    const store = new FileWorkspaceStateStore(workspaceDirectory);
    const initial = {
      version: 2 as const,
      vaultId,
      panes: [
        {
          id: "primary" as const,
          openPaths: ["First.md"],
          pinnedPaths: [],
          activePath: "First.md",
        },
      ],
      activePaneId: "primary" as const,
      splitDirection: null,
    };
    const migrated = {
      ...initial,
      panes: [
        {
          id: "primary" as const,
          openPaths: ["Second.md"],
          pinnedPaths: [],
          activePath: "Second.md",
        },
      ],
    };
    const stale = {
      ...initial,
      panes: [
        {
          id: "primary" as const,
          openPaths: ["First.md"],
          pinnedPaths: ["First.md"],
          activePath: "First.md",
        },
      ],
    };
    await store.save(initial);

    await store.save(migrated, initial);
    await expect(store.save(stale, initial)).rejects.toThrow(
      "workspace state changed before it could be saved",
    );
    await expect(store.load(vaultId)).resolves.toEqual(migrated);
  });

  it("rejects malformed state without rewriting it", async () => {
    const store = new FileWorkspaceStateStore(workspaceDirectory);
    const filePath = path.join(workspaceDirectory, `${vaultId}.json`);
    const malformed = `${JSON.stringify(
      {
        version: 2,
        vaultId,
        panes: [
          { id: "primary", openPaths: ["First.md"], activePath: "First.md" },
          { id: "secondary", openPaths: ["Second.md"], activePath: "Second.md" },
        ],
        activePaneId: "secondary",
        splitDirection: null,
      },
      null,
      2,
    )}\n`;
    await fs.mkdir(workspaceDirectory, { recursive: true });
    await fs.writeFile(filePath, malformed, "utf8");

    await expect(store.load(vaultId)).rejects.toThrow("two panes require one");
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe(malformed);
    await expect(store.load("../outside")).rejects.toThrow("SHA-256 vault identity");
  });
});
