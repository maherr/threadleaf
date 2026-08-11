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
      version: 1,
      vaultId,
      openPaths: ["First.md", "Second.md"],
      activePath: "Second.md",
    });
    await store.save({
      version: 1,
      vaultId,
      openPaths: ["Second.md"],
      activePath: "Second.md",
    });

    await expect(store.load(vaultId)).resolves.toEqual({
      version: 1,
      vaultId,
      openPaths: ["Second.md"],
      activePath: "Second.md",
    });
    const filePath = path.join(workspaceDirectory, `${vaultId}.json`);
    const stat = await fs.stat(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("rejects malformed state without rewriting it", async () => {
    const store = new FileWorkspaceStateStore(workspaceDirectory);
    const filePath = path.join(workspaceDirectory, `${vaultId}.json`);
    await fs.mkdir(workspaceDirectory, { recursive: true });
    await fs.writeFile(filePath, "not json\n", "utf8");

    await expect(store.load(vaultId)).rejects.toThrow();
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("not json\n");
    await expect(store.load("../outside")).rejects.toThrow("SHA-256 vault identity");
  });
});
