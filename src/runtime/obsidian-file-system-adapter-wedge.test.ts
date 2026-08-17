import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { revisionOf } from "../kernel/durability";
import { TFolder, Vault } from "./obsidian-compat";

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

async function createRoot(prefix: string): Promise<string> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(rootPath);
  return rootPath;
}

describe("Obsidian FileSystemAdapter compatibility wedge", () => {
  it("writes existing and missing text files through the revision-aware vault writer", async () => {
    const rootPath = await createRoot("threadleaf-adapter-write-");
    await fs.mkdir(path.join(rootPath, "Notes"));
    const existingPath = "Notes/Existing.md";
    const initial = "initial";
    await fs.writeFile(path.join(rootPath, existingPath), initial, "utf8");
    const writeText = vi.fn(async (filePath: string, content: string) => {
      await fs.writeFile(path.join(rootPath, filePath), content, "utf8");
      return {
        status: "committed" as const,
        path: filePath,
        revision: revisionOf(Buffer.from(content, "utf8")),
        transactionId: "adapter-write",
      };
    });
    const createText = vi.fn(async (filePath: string, content: string) => {
      await fs.writeFile(path.join(rootPath, filePath), content, { encoding: "utf8", flag: "wx" });
      return {
        status: "committed" as const,
        path: filePath,
        revision: revisionOf(Buffer.from(content, "utf8")),
        transactionId: "adapter-create",
      };
    });
    const vault = new Vault(rootPath, undefined, { createText, writeText });

    await expect(vault.adapter.write(existingPath, "replacement")).resolves.toBeUndefined();
    await expect(vault.adapter.write("Notes/New.md", "created")).resolves.toBeUndefined();

    expect(writeText).toHaveBeenCalledWith(
      existingPath,
      "replacement",
      revisionOf(Buffer.from(initial, "utf8")),
    );
    expect(createText).toHaveBeenCalledWith("Notes/New.md", "created");
    await expect(fs.readFile(path.join(rootPath, existingPath), "utf8")).resolves.toBe(
      "replacement",
    );
    await expect(fs.readFile(path.join(rootPath, "Notes/New.md"), "utf8")).resolves.toBe("created");
  });

  it("rejects unsafe or wrong-shaped write targets before invoking a writer", async () => {
    const sandboxPath = await createRoot("threadleaf-adapter-write-containment-");
    const rootPath = path.join(sandboxPath, "vault");
    const outsidePath = path.join(sandboxPath, "outside");
    await fs.mkdir(rootPath);
    await fs.mkdir(outsidePath);
    await fs.mkdir(path.join(rootPath, "Folder"));
    await fs.symlink(outsidePath, path.join(rootPath, "Escape"));
    const writeText = vi.fn();
    const createText = vi.fn();
    const vault = new Vault(rootPath, undefined, { createText, writeText });

    await expect(vault.adapter.write("../outside.md", "blocked")).rejects.toThrow(
      "escapes the vault",
    );
    await expect(vault.adapter.write("Escape/blocked.md", "blocked")).rejects.toThrow(
      "resolves outside the vault",
    );
    await expect(vault.adapter.append("Escape/blocked.md", "blocked")).rejects.toThrow(
      "resolves outside the vault",
    );
    await expect(vault.adapter.process("Escape/blocked.md", (data) => data)).rejects.toThrow(
      "resolves outside the vault",
    );
    await expect(vault.adapter.trashLocal("Escape/blocked.md")).rejects.toThrow(
      "resolves outside the vault",
    );
    await expect(vault.adapter.write("Folder", "blocked")).rejects.toThrow("requires a file path");
    await expect(vault.adapter.write("New.md", "blocked", { mtime: Date.now() })).rejects.toThrow(
      "timestamp options",
    );
    expect(writeText).not.toHaveBeenCalled();
    expect(createText).not.toHaveBeenCalled();
    await expect(fs.readdir(outsidePath)).resolves.toEqual([]);
  });

  it("routes binary writes, appends, process, rename, and local trash through the vault writer", async () => {
    const rootPath = await createRoot("threadleaf-adapter-mutations-");
    await fs.writeFile(path.join(rootPath, "Note.md"), "one", "utf8");
    await fs.writeFile(path.join(rootPath, "Bytes.bin"), Uint8Array.from([1, 2]));
    const writeText = vi.fn(async (filePath: string, content: string, expectedRevision: string) => {
      const current = await fs.readFile(path.join(rootPath, filePath));
      expect(revisionOf(current)).toBe(expectedRevision);
      await fs.writeFile(path.join(rootPath, filePath), content, "utf8");
      return {
        status: "committed" as const,
        path: filePath,
        revision: revisionOf(Buffer.from(content, "utf8")),
        transactionId: "adapter-write",
      };
    });
    const writeBinary = vi.fn(
      async (filePath: string, content: Uint8Array, expectedRevision: string) => {
        const current = await fs.readFile(path.join(rootPath, filePath));
        expect(revisionOf(current)).toBe(expectedRevision);
        await fs.writeFile(path.join(rootPath, filePath), content);
        return {
          status: "committed" as const,
          path: filePath,
          revision: revisionOf(content),
          transactionId: "adapter-write-binary",
        };
      },
    );
    const createBinary = vi.fn(async (filePath: string, content: Uint8Array) => {
      await fs.writeFile(path.join(rootPath, filePath), content, { flag: "wx" });
      return {
        status: "committed" as const,
        path: filePath,
        revision: revisionOf(content),
        transactionId: "adapter-create-binary",
      };
    });
    const renameFile = vi.fn(async (sourcePath: string, targetPath: string) => {
      await fs.rename(path.join(rootPath, sourcePath), path.join(rootPath, targetPath));
      return {
        status: "committed" as const,
        from: sourcePath,
        to: targetPath,
        transactionId: "adapter-rename",
      };
    });
    const trashFile = vi.fn(async (sourcePath: string) => {
      const targetPath = path.join(".trash", sourcePath);
      await fs.mkdir(path.dirname(path.join(rootPath, targetPath)), { recursive: true });
      await fs.rename(path.join(rootPath, sourcePath), path.join(rootPath, targetPath));
      return {
        status: "committed" as const,
        from: sourcePath,
        to: targetPath,
        transactionId: "adapter-trash",
      };
    });
    const vault = new Vault(rootPath, undefined, {
      createBinary,
      renameFile,
      trashFile,
      writeBinary,
      writeText,
    });

    await vault.adapter.writeBinary("Bytes.bin", Uint8Array.from([3, 4]).buffer);
    await vault.adapter.writeBinary("New.bin", Uint8Array.from([5]).buffer);
    await vault.adapter.append("Note.md", "-two");
    await vault.adapter.appendBinary("Bytes.bin", Uint8Array.from([6]).buffer);
    await expect(vault.adapter.process("Note.md", (data) => data.toUpperCase())).resolves.toBe(
      "ONE-TWO",
    );
    await vault.adapter.rename("New.bin", "Moved.bin");
    await vault.adapter.trashLocal("Moved.bin");

    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeBinary).toHaveBeenCalledTimes(2);
    expect(createBinary).toHaveBeenCalledOnce();
    expect(renameFile).toHaveBeenCalledOnce();
    expect(trashFile).toHaveBeenCalledOnce();
    await expect(fs.readFile(path.join(rootPath, "Note.md"), "utf8")).resolves.toBe("ONE-TWO");
    await expect(fs.readFile(path.join(rootPath, "Bytes.bin"))).resolves.toEqual(
      Buffer.from([3, 4, 6]),
    );
    await expect(fs.readFile(path.join(rootPath, ".trash", "Moved.bin"))).resolves.toEqual(
      Buffer.from([5]),
    );
  });

  it("creates a folder through the existing vault mutation port and resolves void", async () => {
    const rootPath = await createRoot("threadleaf-adapter-mkdir-");
    const createFolder = vi.fn(async (folderPath: string) => {
      await fs.mkdir(path.join(rootPath, folderPath));
      return { path: folderPath, created: true };
    });
    const vault = new Vault(rootPath, undefined, { createFolder, writeText: vi.fn() });

    await expect(vault.adapter.mkdir("Plugin data")).resolves.toBeUndefined();

    expect(createFolder).toHaveBeenCalledWith("Plugin data");
    expect(vault.getAbstractFileByPath("Plugin data")).toBeInstanceOf(TFolder);
  });

  it("rejects an escaping mkdir target without invoking the mutation port", async () => {
    const sandboxPath = await createRoot("threadleaf-adapter-mkdir-containment-");
    const rootPath = path.join(sandboxPath, "vault");
    const outsidePath = path.join(sandboxPath, "outside");
    await fs.mkdir(rootPath);
    await fs.mkdir(outsidePath);
    await fs.symlink(outsidePath, path.join(rootPath, "Escape"));
    const createFolder = vi.fn();
    const vault = new Vault(rootPath, undefined, { createFolder, writeText: vi.fn() });

    await expect(vault.adapter.mkdir("Escape/New folder")).rejects.toThrow(
      "resolves outside the vault",
    );

    expect(createFolder).not.toHaveBeenCalled();
    await expect(fs.readdir(outsidePath)).resolves.toEqual([]);
  });

  it("copies exact binary bytes through the no-clobber binary create port and resolves void", async () => {
    const rootPath = await createRoot("threadleaf-adapter-copy-");
    await fs.mkdir(path.join(rootPath, "Assets"));
    const sourcePath = "Assets/Source.bin";
    const targetPath = "Assets/Copy.bin";
    const bytes = Uint8Array.from([0, 0xff, 0x80, 1, 2, 3, 0]);
    await fs.writeFile(path.join(rootPath, sourcePath), bytes);
    const createBinary = vi.fn(async (filePath: string, content: Uint8Array) => {
      await fs.writeFile(path.join(rootPath, filePath), content, { flag: "wx" });
      return {
        status: "committed" as const,
        path: filePath,
        revision: revisionOf(content),
        transactionId: "adapter-copy",
      };
    });
    const vault = new Vault(rootPath, undefined, { createBinary, writeText: vi.fn() });

    await expect(vault.adapter.copy(sourcePath, targetPath)).resolves.toBeUndefined();

    expect(createBinary).toHaveBeenCalledOnce();
    expect(createBinary.mock.calls[0]?.[0]).toBe(targetPath);
    expect(createBinary.mock.calls[0]?.[1]).toEqual(bytes);
    await expect(fs.readFile(path.join(rootPath, targetPath))).resolves.toEqual(Buffer.from(bytes));
  });

  it("refuses copy collisions and escaping sources without invoking the create port", async () => {
    const sandboxPath = await createRoot("threadleaf-adapter-copy-containment-");
    const rootPath = path.join(sandboxPath, "vault");
    await fs.mkdir(rootPath);
    await fs.writeFile(path.join(rootPath, "Source.bin"), "source", "utf8");
    await fs.writeFile(path.join(rootPath, "Existing.bin"), "existing", "utf8");
    const outsidePath = path.join(sandboxPath, "outside.bin");
    await fs.writeFile(outsidePath, "outside", "utf8");
    await fs.symlink(outsidePath, path.join(rootPath, "Outside link.bin"));
    const createBinary = vi.fn();
    const vault = new Vault(rootPath, undefined, { createBinary, writeText: vi.fn() });

    await expect(vault.adapter.copy("Source.bin", "Existing.bin")).rejects.toThrow(
      "refused to overwrite",
    );
    await expect(vault.adapter.copy("Outside link.bin", "Copy.bin")).rejects.toThrow(
      "resolves outside the vault",
    );

    expect(createBinary).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(rootPath, "Existing.bin"), "utf8")).resolves.toBe(
      "existing",
    );
    await expect(fs.stat(path.join(rootPath, "Copy.bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("returns contained absolute paths for existing and not-yet-created vault entries", async () => {
    const rootPath = await createRoot("threadleaf-adapter-full-path-");
    await fs.mkdir(path.join(rootPath, "Notes"));
    await fs.writeFile(path.join(rootPath, "Notes", "Existing.md"), "existing", "utf8");
    const writeText = vi.fn();
    const vault = new Vault(rootPath, undefined, { writeText });

    expect(vault.adapter.getFullPath("Notes/Existing.md")).toBe(
      path.join(vault.rootPath, "Notes", "Existing.md"),
    );
    expect(vault.adapter.getFullPath("Notes/New.md")).toBe(
      path.join(vault.rootPath, "Notes", "New.md"),
    );
    expect(writeText).not.toHaveBeenCalled();
  });

  it("rejects lexical, symlinked, and dangling-symlink full paths outside the vault", async () => {
    const sandboxPath = await createRoot("threadleaf-adapter-full-path-containment-");
    const rootPath = path.join(sandboxPath, "vault");
    const outsidePath = path.join(sandboxPath, "outside");
    await fs.mkdir(rootPath);
    await fs.mkdir(outsidePath);
    await fs.symlink(outsidePath, path.join(rootPath, "Escape"));
    await fs.symlink(path.join(sandboxPath, "missing"), path.join(rootPath, "Dangling"));
    const writeText = vi.fn();
    const vault = new Vault(rootPath, undefined, { writeText });

    expect(() => vault.adapter.getFullPath("../outside.md")).toThrow("escapes the vault");
    expect(() => vault.adapter.getFullPath("Escape/New.md")).toThrow("resolves outside the vault");
    expect(() => vault.adapter.getFullPath("Dangling/New.md")).toThrow();
    expect(writeText).not.toHaveBeenCalled();
    await expect(fs.readdir(outsidePath)).resolves.toEqual([]);
  });
});
