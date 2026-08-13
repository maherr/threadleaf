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
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toMatchObject({
      version: 1,
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
});
