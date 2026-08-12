import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { revisionOf } from "../kernel/durability";
import { TFile, Vault } from "./obsidian-compat";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

async function createVaultFile(content = "initial drawing"): Promise<{
  file: TFile;
  rootPath: string;
}> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-plugin-vault-write-"));
  temporaryDirectories.push(rootPath);
  await fs.writeFile(path.join(rootPath, "Drawing.excalidraw.md"), content, "utf8");
  const vault = new Vault(rootPath);
  const file = vault.getFileByPath("Drawing.excalidraw.md");
  if (!file) {
    throw new Error("Fixture drawing was not discovered.");
  }
  return { file, rootPath };
}

describe("Obsidian compatibility vault writes", () => {
  it("binds sequential modifications to the last committed revision", async () => {
    const initial = "initial drawing";
    const { file, rootPath } = await createVaultFile(initial);
    const writer = {
      writeText: vi.fn(async (filePath: string, content: string) => {
        await fs.writeFile(path.join(rootPath, filePath), content, "utf8");
        return {
          status: "committed" as const,
          path: filePath,
          revision: revisionOf(Buffer.from(content, "utf8")),
          transactionId: `write-${content}`,
        };
      }),
    };
    const vault = new Vault(rootPath, undefined, writer);
    const writableFile = vault.getFileByPath(file.path);
    if (!writableFile) {
      throw new Error("Writable fixture drawing was not discovered.");
    }
    const modified = vi.fn();
    vault.on("modify", modified);

    await vault.modify(writableFile, "second drawing");
    await vault.modify(writableFile, "third drawing");

    expect(writer.writeText).toHaveBeenNthCalledWith(
      1,
      file.path,
      "second drawing",
      revisionOf(Buffer.from(initial, "utf8")),
    );
    expect(writer.writeText).toHaveBeenNthCalledWith(
      2,
      file.path,
      "third drawing",
      revisionOf(Buffer.from("second drawing", "utf8")),
    );
    expect(await fs.readFile(path.join(rootPath, file.path), "utf8")).toBe("third drawing");
    expect(writableFile.stat.size).toBe(Buffer.byteLength("third drawing", "utf8"));
    expect(modified).toHaveBeenCalledTimes(2);
  });

  it("surfaces retained conflict paths and rejects files from another vault", async () => {
    const { file, rootPath } = await createVaultFile();
    const writer = {
      writeText: vi.fn(async (filePath: string) => ({
        status: "conflict" as const,
        path: filePath,
        currentRevision: revisionOf(Buffer.from("external drawing", "utf8")),
        conflictPath: "Drawing.threadleaf-conflict.excalidraw.md",
        transactionId: "conflicted-write",
      })),
    };
    const vault = new Vault(rootPath, undefined, writer);
    const writableFile = vault.getFileByPath(file.path);
    if (!writableFile) {
      throw new Error("Writable fixture drawing was not discovered.");
    }
    const modified = vi.fn();
    vault.on("modify", modified);

    await expect(vault.modify(writableFile, "proposed drawing")).rejects.toThrow(
      "Drawing.threadleaf-conflict.excalidraw.md",
    );
    expect(modified).not.toHaveBeenCalled();

    const foreignFile = new TFile(file.path, new Vault(rootPath));
    await expect(vault.modify(foreignFile, "foreign drawing")).rejects.toThrow(
      "active compatibility vault",
    );
    expect(writer.writeText).toHaveBeenCalledTimes(1);
  });
});
