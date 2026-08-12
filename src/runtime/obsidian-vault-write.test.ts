import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { revisionOf } from "../kernel/durability";
import { FileManager, TFile, Vault } from "./obsidian-compat";

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
  it("resolves attachment paths beside the source and avoids existing names", async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-plugin-attachments-"));
    temporaryDirectories.push(rootPath);
    await fs.mkdir(path.join(rootPath, "Notes"), { recursive: true });
    await fs.writeFile(path.join(rootPath, "Notes", "Source.md"), "source", "utf8");
    await fs.writeFile(path.join(rootPath, "Notes", "Drawing.excalidraw.md"), "drawing", "utf8");
    const fileManager = new FileManager(new Vault(rootPath));

    await expect(
      fileManager.getAvailablePathForAttachment("Drawing.excalidraw.md", "Notes/Source.md"),
    ).resolves.toBe("Notes/Drawing.excalidraw 1.md");
    await expect(
      fileManager.getAvailablePathForAttachment("Sketch.png", "Source.md"),
    ).resolves.toBe("Sketch.png");
  });

  it("creates folders and files through the mutation port and resolves paths case-insensitively", async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-plugin-vault-create-"));
    temporaryDirectories.push(rootPath);
    const writer = {
      writeText: vi.fn(),
      createFolder: vi.fn(async (folderPath: string) => {
        const absolutePath = path.join(rootPath, folderPath);
        let created = false;
        try {
          await fs.mkdir(absolutePath, { recursive: true });
          created = true;
        } catch {
          created = false;
        }
        return { path: folderPath, created };
      }),
      createText: vi.fn(async (filePath: string, content: string) => {
        await fs.writeFile(path.join(rootPath, filePath), content, {
          encoding: "utf8",
          flag: "wx",
        });
        return {
          status: "committed" as const,
          path: filePath,
          revision: revisionOf(Buffer.from(content, "utf8")),
          transactionId: "created-file",
        };
      }),
    };
    const vault = new Vault(rootPath, undefined, writer);
    const created = vi.fn();
    vault.on("create", created);

    const folder = await vault.createFolder("Excalidraw");
    const file = await vault.create("Excalidraw/Drawing.excalidraw.md", "drawing bytes");

    expect(folder.path).toBe("Excalidraw");
    expect(file.path).toBe("Excalidraw/Drawing.excalidraw.md");
    expect(file.stat.size).toBe(Buffer.byteLength("drawing bytes", "utf8"));
    expect(
      vault.getAbstractFileByPathInsensitive("excalidraw/DRAWING.excalidraw.MD"),
    ).toMatchObject({
      path: "Excalidraw/Drawing.excalidraw.md",
    });
    expect(created).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(path.join(rootPath, file.path), "utf8")).toBe("drawing bytes");
  });

  it("refuses plugin create overwrites and reports retained create conflicts", async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-plugin-vault-create-"));
    temporaryDirectories.push(rootPath);
    const createText = vi
      .fn()
      .mockResolvedValueOnce({
        status: "exists" as const,
        path: "Existing.md",
        currentRevision: "a".repeat(64),
      })
      .mockResolvedValueOnce({
        status: "conflict" as const,
        path: "Raced.md",
        currentRevision: "b".repeat(64),
        conflictPath: "Raced.threadleaf-conflict.md",
        transactionId: "create-race",
      });
    const vault = new Vault(rootPath, undefined, { writeText: vi.fn(), createText });

    await expect(vault.create("Existing.md", "replacement")).rejects.toThrow(
      "refused to overwrite Existing.md",
    );
    await expect(vault.create("Raced.md", "proposal")).rejects.toThrow(
      "Raced.threadleaf-conflict.md",
    );
  });

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
