import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultWorkspaceLayout } from "../shared/workspace-layout";
import { FileWorkspaceLayoutStore } from "./file-workspace-layout-store";

const vaultId = "a".repeat(64);
let sandboxPath: string;

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-workspace-layout-"));
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

describe("FileWorkspaceLayoutStore", () => {
  it("keeps the layout outside the vault and atomically private", async () => {
    const store = new FileWorkspaceLayoutStore(path.join(sandboxPath, "layouts"));
    const layout = createDefaultWorkspaceLayout(vaultId);
    layout.docks.left.collapsed = true;
    await store.save(layout);
    await expect(store.load(vaultId)).resolves.toEqual(layout);
    const filePath = path.join(sandboxPath, "layouts", `${vaultId}.json`);
    if (process.platform !== "win32") {
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toMatchObject({
      version: 2,
      vaultId,
      docks: { left: { collapsed: true } },
    });
  });

  it("does not rewrite malformed future state", async () => {
    const store = new FileWorkspaceLayoutStore(path.join(sandboxPath, "layouts"));
    const filePath = path.join(sandboxPath, "layouts", `${vaultId}.json`);
    const malformed = `${JSON.stringify({ version: 99, vaultId })}\n`;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, malformed, "utf8");
    await expect(store.load(vaultId)).rejects.toThrow("version 1");
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe(malformed);
  });

  it("rejects an external replacement after load and preserves the external bytes", async () => {
    const store = new FileWorkspaceLayoutStore(path.join(sandboxPath, "layouts"));
    const filePath = path.join(sandboxPath, "layouts", `${vaultId}.json`);
    const initial = createDefaultWorkspaceLayout(vaultId);
    await store.save(initial);
    await expect(store.load(vaultId)).resolves.toEqual(initial);

    const external = createDefaultWorkspaceLayout(vaultId);
    external.docks.right.collapsed = true;
    const externalBytes = `${JSON.stringify(external, null, 2)}\n`;
    await fs.writeFile(filePath, externalBytes, "utf8");

    const local = createDefaultWorkspaceLayout(vaultId);
    local.docks.left.collapsed = true;
    await expect(store.save(local)).rejects.toMatchObject({
      name: "WorkspaceLayoutConflictError",
      code: "WORKSPACE_LAYOUT_CONFLICT",
      vaultId,
    });
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe(externalBytes);

    const reloadedStore = new FileWorkspaceLayoutStore(path.join(sandboxPath, "layouts"));
    await expect(reloadedStore.load(vaultId)).resolves.toEqual(external);
    await expect(reloadedStore.save(local)).resolves.toEqual(local);
  });

  it("refuses a direct save over an existing file without a loaded revision", async () => {
    const store = new FileWorkspaceLayoutStore(path.join(sandboxPath, "layouts"));
    const initial = createDefaultWorkspaceLayout(vaultId);
    await store.save(initial);

    const replacement = createDefaultWorkspaceLayout(vaultId);
    replacement.docks.left.collapsed = true;
    const freshStore = new FileWorkspaceLayoutStore(path.join(sandboxPath, "layouts"));
    await expect(freshStore.save(replacement)).rejects.toMatchObject({
      name: "WorkspaceLayoutConflictError",
      code: "WORKSPACE_LAYOUT_CONFLICT",
    });
    await expect(store.load(vaultId)).resolves.toEqual(initial);
  });

  it("treats an external deletion as a conflict instead of recreating the file", async () => {
    const store = new FileWorkspaceLayoutStore(path.join(sandboxPath, "layouts"));
    const filePath = path.join(sandboxPath, "layouts", `${vaultId}.json`);
    const initial = createDefaultWorkspaceLayout(vaultId);
    await store.save(initial);
    await expect(store.load(vaultId)).resolves.toEqual(initial);
    await fs.unlink(filePath);

    const local = createDefaultWorkspaceLayout(vaultId);
    local.docks.left.collapsed = true;
    await expect(store.save(local)).rejects.toMatchObject({
      name: "WorkspaceLayoutConflictError",
      code: "WORKSPACE_LAYOUT_CONFLICT",
      actualRevision: null,
    });
    await expect(fs.access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
