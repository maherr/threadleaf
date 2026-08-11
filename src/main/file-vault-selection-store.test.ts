import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileVaultSelectionStore } from "./file-vault-selection-store";

let sandboxPath: string;
let selectionPath: string;

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-selection-"));
  selectionPath = path.join(sandboxPath, "state", "workspace-selection.json");
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

describe("FileVaultSelectionStore", () => {
  it("returns null when no selection has been saved", async () => {
    const store = new FileVaultSelectionStore(selectionPath);

    await expect(store.load()).resolves.toBeNull();
  });

  it("durably replaces an absolute selection with private file permissions", async () => {
    const store = new FileVaultSelectionStore(selectionPath);
    const first = path.join(sandboxPath, "first-vault");
    const second = path.join(sandboxPath, "second-vault");

    await store.save(first);
    await expect(store.load()).resolves.toBe(first);
    await store.save(second);
    await expect(store.load()).resolves.toBe(second);

    const stat = await fs.stat(selectionPath);
    expect(stat.mode & 0o777).toBe(0o600);
    await expect(fs.readFile(selectionPath, "utf8")).resolves.toBe(
      `${JSON.stringify({ version: 1, vaultPath: second }, null, 2)}\n`,
    );
  });

  it("rejects malformed, unsupported, and relative selections", async () => {
    const store = new FileVaultSelectionStore(selectionPath);
    await fs.mkdir(path.dirname(selectionPath), { recursive: true });
    await fs.writeFile(selectionPath, "not json\n", "utf8");

    await expect(store.load()).rejects.toThrow();
    await fs.writeFile(selectionPath, '{"version":2,"vaultPath":"/vault"}\n', "utf8");

    await expect(store.load()).rejects.toThrow("version 1 and an absolute vault path");
    await fs.writeFile(selectionPath, '{"version":1,"vaultPath":"relative/vault"}\n', "utf8");

    await expect(store.load()).rejects.toThrow("version 1 and an absolute vault path");
    await expect(store.save("relative/vault")).rejects.toThrow("absolute path");
  });
});
