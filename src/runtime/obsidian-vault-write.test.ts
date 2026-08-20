import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { revisionOf } from "../kernel/durability";
import {
  arrayBufferToBase64,
  arrayBufferToHex,
  base64ToArrayBuffer,
  FileManager,
  FileSystemAdapter,
  parseFrontMatterEntry,
  TFile,
  Vault,
} from "./obsidian-compat";

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
  it("roundtrips public binary codecs without changing any byte", () => {
    const bytes = Uint8Array.from([0, 1, 2, 0x7f, 0x80, 0xfe, 0xff]);

    expect(arrayBufferToBase64(bytes.buffer)).toBe("AAECf4D+/w==");
    expect(arrayBufferToHex(bytes.buffer)).toBe("0001027f80feff");
    expect(new Uint8Array(base64ToArrayBuffer("AAECf4D+/w=="))).toEqual(bytes);
  });

  it("reads exact and regular-expression frontmatter entries", () => {
    const frontmatter = { cssclasses: ["wide-page", "drawing"], title: "Canvas" };

    expect(parseFrontMatterEntry(frontmatter, "cssclasses")).toEqual(["wide-page", "drawing"]);
    expect(parseFrontMatterEntry(frontmatter, /^tit/)).toBe("Canvas");
    expect(parseFrontMatterEntry(frontmatter, "missing")).toBeNull();
    expect(parseFrontMatterEntry(null, "cssclasses")).toBeNull();
  });

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

  it("exposes contained resource URLs and a read-only desktop adapter surface", async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-plugin-resources-"));
    temporaryDirectories.push(rootPath);
    await fs.mkdir(path.join(rootPath, "Assets"));
    await fs.mkdir(path.join(rootPath, ".obsidian"));
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff]);
    const relativePath = "Assets/Résumé image.png";
    const absolutePath = path.join(rootPath, relativePath);
    await fs.writeFile(absolutePath, bytes);
    await fs.writeFile(path.join(rootPath, ".obsidian", "appearance.json"), "{}", "utf8");
    const vault = new Vault(rootPath);
    const file = vault.getFileByPath(relativePath);
    if (!file) {
      throw new Error("Resource fixture was not discovered.");
    }
    const canonicalRootPath = vault.rootPath;
    const canonicalAbsolutePath = path.join(canonicalRootPath, relativePath);

    expect(vault.adapter).toBeInstanceOf(FileSystemAdapter);
    expect(vault.adapter.getName()).toBe(path.basename(rootPath));
    expect(vault.rootPath).toBe(canonicalRootPath);
    expect(vault.adapter.getBasePath()).toBe(canonicalRootPath);
    expect(vault.adapter.basePath).toBe(canonicalRootPath);
    expect(vault.adapter.url.pathToFileURL(absolutePath).toString()).toBe(
      pathToFileURL(absolutePath).toString(),
    );
    expect(vault.getResourcePath(file)).toBe(pathToFileURL(canonicalAbsolutePath).toString());
    expect(vault.adapter.getResourcePath(relativePath)).toBe(
      pathToFileURL(canonicalAbsolutePath).toString(),
    );
    expect(vault.adapter.getFilePath(relativePath)).toBe(canonicalAbsolutePath);
    await expect(vault.adapter.exists(relativePath)).resolves.toBe(true);
    await expect(vault.adapter.exists("assets/Résumé image.png", true)).resolves.toBe(false);
    await expect(vault.adapter.exists("Assets/Missing.png")).resolves.toBe(false);
    await expect(vault.adapter.readBinary(relativePath)).resolves.toEqual(bytes.buffer);
    await expect(vault.adapter.read(".obsidian/appearance.json")).resolves.toBe("{}");
    await expect(vault.adapter.stat(relativePath)).resolves.toMatchObject({
      type: "file",
      size: bytes.byteLength,
    });
    await expect(vault.adapter.list("Assets")).resolves.toEqual({
      files: [relativePath],
      folders: [],
    });
    expect(vault.getFolderByPath("Assets")?.path).toBe("Assets");
    expect(vault.getFolderByPath(relativePath)).toBeNull();
    expect(vault.getConfig("propertiesInDocument")).toBeUndefined();

    const foreignFile = new TFile(relativePath, new Vault(rootPath));
    expect(() => vault.getResourcePath(foreignFile)).toThrow("active compatibility vault");
  });

  it("roundtrips vault configuration and emits the public config-changed event", async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-plugin-config-"));
    temporaryDirectories.push(rootPath);
    await fs.mkdir(path.join(rootPath, ".obsidian"));
    await fs.writeFile(
      path.join(rootPath, ".obsidian", "app.json"),
      `${JSON.stringify({ baseFontSize: 16, foldHeading: true }, null, 2)}\n`,
      "utf8",
    );
    const vault = new Vault(rootPath);
    const changes: Array<[unknown, unknown]> = [];
    vault.on("config-changed", (key, value) => changes.push([key, value]));

    expect(vault.getConfig("baseFontSize")).toBe(16);
    expect(vault.getPersistedConfig("baseFontSize")).toBe(16);
    expect(vault.getPersistedConfig("missingSetting")).toBeUndefined();
    await vault.setConfig("baseFontSize", 17.5);

    expect(vault.getConfig("baseFontSize")).toBe(17.5);
    expect(changes).toEqual([["baseFontSize", 17.5]]);
    await expect(
      fs.readFile(path.join(rootPath, ".obsidian", "app.json"), "utf8"),
    ).resolves.toContain('"baseFontSize": 17.5');
  });

  it("allows internal resource symlinks but rejects resource paths that resolve outside", async () => {
    const sandboxPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "threadleaf-plugin-resource-link-"),
    );
    temporaryDirectories.push(sandboxPath);
    const rootPath = path.join(sandboxPath, "vault");
    await fs.mkdir(rootPath);
    await fs.writeFile(path.join(rootPath, "Inside.png"), "inside", "utf8");
    await fs.writeFile(path.join(sandboxPath, "Outside.png"), "outside", "utf8");
    await fs.symlink("Inside.png", path.join(rootPath, "Inside link.png"));
    await fs.symlink(
      path.join(sandboxPath, "Outside.png"),
      path.join(rootPath, "Outside link.png"),
    );
    const vault = new Vault(rootPath);
    const insideLink = vault.getFileByPath("Inside link.png");
    const outsideLink = vault.getFileByPath("Outside link.png");
    if (!insideLink || !outsideLink) {
      throw new Error("Resource symlink fixtures were not discovered.");
    }

    expect(vault.getResourcePath(insideLink)).toBe(
      pathToFileURL(path.join(vault.rootPath, "Inside.png")).toString(),
    );
    expect(() => vault.getResourcePath(outsideLink)).toThrow("resolves outside the vault");
    await expect(vault.adapter.readBinary("Outside link.png")).rejects.toThrow(
      "resolves outside the vault",
    );
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

  it("creates and modifies binary files without changing their bytes", async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-plugin-binary-write-"));
    temporaryDirectories.push(rootPath);
    await fs.mkdir(path.join(rootPath, "Exports"));
    const createBinary = vi.fn(async (filePath: string, content: Uint8Array) => {
      await fs.writeFile(path.join(rootPath, filePath), content, { flag: "wx" });
      return {
        status: "committed" as const,
        path: filePath,
        revision: revisionOf(content),
        transactionId: "binary-create",
      };
    });
    const writeBinary = vi.fn(async (filePath: string, content: Uint8Array) => {
      await fs.writeFile(path.join(rootPath, filePath), content);
      return {
        status: "committed" as const,
        path: filePath,
        revision: revisionOf(content),
        transactionId: "binary-write",
      };
    });
    const vault = new Vault(rootPath, undefined, {
      createBinary,
      writeBinary,
      writeText: vi.fn(),
    });
    const created = vi.fn();
    const modified = vi.fn();
    vault.on("create", created);
    vault.on("modify", modified);
    const firstBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0xff]);
    const secondBytes = Uint8Array.from([0, 0xff, 0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

    const file = await vault.createBinary("Exports/Drawing.png", firstBytes.buffer);
    await vault.modifyBinary(file, secondBytes.buffer);

    expect(createBinary).toHaveBeenCalledWith("Exports/Drawing.png", firstBytes);
    expect(writeBinary).toHaveBeenCalledWith(
      "Exports/Drawing.png",
      secondBytes,
      revisionOf(firstBytes),
    );
    expect(new Uint8Array(await vault.readBinary(file))).toEqual(secondBytes);
    expect(await fs.readFile(path.join(rootPath, file.path))).toEqual(Buffer.from(secondBytes));
    expect(file.stat.size).toBe(secondBytes.byteLength);
    expect(created).toHaveBeenCalledOnce();
    expect(modified).toHaveBeenCalledOnce();
  });

  it("appends and processes text and binary files through revision-aware writes", async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-plugin-vault-append-"));
    temporaryDirectories.push(rootPath);
    const textPath = "Notes/Journal.md";
    const binaryPath = "Assets/Blob.bin";
    await fs.mkdir(path.join(rootPath, "Notes"));
    await fs.mkdir(path.join(rootPath, "Assets"));
    await fs.writeFile(path.join(rootPath, textPath), "first", "utf8");
    const initialBinary = Uint8Array.from([0, 0xff, 1]);
    await fs.writeFile(path.join(rootPath, binaryPath), initialBinary);
    const writeText = vi.fn(async (filePath: string, content: string) => {
      await fs.writeFile(path.join(rootPath, filePath), content, "utf8");
      return {
        status: "committed" as const,
        path: filePath,
        revision: revisionOf(Buffer.from(content, "utf8")),
        transactionId: `append-text-${content}`,
      };
    });
    const writeBinary = vi.fn(async (filePath: string, content: Uint8Array) => {
      await fs.writeFile(path.join(rootPath, filePath), content);
      return {
        status: "committed" as const,
        path: filePath,
        revision: revisionOf(content),
        transactionId: "append-binary",
      };
    });
    const vault = new Vault(rootPath, undefined, { writeText, writeBinary });
    const textFile = vault.getFileByPath(textPath);
    const binaryFile = vault.getFileByPath(binaryPath);
    if (!textFile || !binaryFile) {
      throw new Error("Append fixtures were not discovered.");
    }

    await vault.append(textFile, "\nsecond");
    await expect(
      vault.process(textFile, (content) => content.replace("first", "updated")),
    ).resolves.toBe("updated\nsecond");
    await vault.appendBinary(binaryFile, Uint8Array.from([2, 3]).buffer);

    expect(writeText).toHaveBeenNthCalledWith(
      1,
      textPath,
      "first\nsecond",
      revisionOf(Buffer.from("first", "utf8")),
    );
    expect(writeText).toHaveBeenNthCalledWith(
      2,
      textPath,
      "updated\nsecond",
      revisionOf(Buffer.from("first\nsecond", "utf8")),
    );
    expect(writeBinary).toHaveBeenCalledWith(
      binaryPath,
      Uint8Array.from([0, 0xff, 1, 2, 3]),
      revisionOf(initialBinary),
    );
    await expect(fs.readFile(path.join(rootPath, textPath), "utf8")).resolves.toBe(
      "updated\nsecond",
    );
    await expect(fs.readFile(path.join(rootPath, binaryPath))).resolves.toEqual(
      Buffer.from([0, 0xff, 1, 2, 3]),
    );
  });

  it("copies files and folders without clobbering existing paths", async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-plugin-vault-copy-"));
    temporaryDirectories.push(rootPath);
    await fs.mkdir(path.join(rootPath, "Source", "Nested"), { recursive: true });
    const sourceBytes = Uint8Array.from([0, 0xff, 4, 5]);
    await fs.writeFile(path.join(rootPath, "Source", "Nested", "Blob.bin"), sourceBytes);
    await fs.writeFile(path.join(rootPath, "Source", "Note.md"), "copied", "utf8");
    const createFolder = vi.fn(async (folderPath: string) => {
      await fs.mkdir(path.join(rootPath, folderPath), { recursive: true });
      return { path: folderPath, created: true };
    });
    const createBinary = vi.fn(async (filePath: string, content: Uint8Array) => {
      await fs.writeFile(path.join(rootPath, filePath), content, { flag: "wx" });
      return {
        status: "committed" as const,
        path: filePath,
        revision: revisionOf(content),
        transactionId: `copy-${filePath}`,
      };
    });
    const vault = new Vault(rootPath, undefined, {
      createFolder,
      createBinary,
      writeText: vi.fn(),
    });
    const source = vault.getFolderByPath("Source");
    const note = vault.getFileByPath("Source/Note.md");
    if (!source || !note) {
      throw new Error("Copy fixtures were not discovered.");
    }

    const copiedFolder = await vault.copy(source, "Copies/Source");
    const copiedFile = await vault.copy(note, "Copies/Note.md");

    expect(copiedFolder.path).toBe("Copies/Source");
    expect(copiedFile.path).toBe("Copies/Note.md");
    await expect(fs.readFile(path.join(rootPath, "Copies/Source/Note.md"), "utf8")).resolves.toBe(
      "copied",
    );
    await expect(
      fs.readFile(path.join(rootPath, "Copies/Source/Nested/Blob.bin")),
    ).resolves.toEqual(Buffer.from(sourceBytes));
    await expect(fs.readFile(path.join(rootPath, "Copies/Note.md"), "utf8")).resolves.toBe(
      "copied",
    );
    await expect(vault.copy(note, "Copies/Note.md")).rejects.toThrow("refused to overwrite");
    expect(createBinary).toHaveBeenCalledTimes(3);
  });

  it("renames binary files through FileManager without changing bytes or leaving stale paths", async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-plugin-binary-rename-"));
    temporaryDirectories.push(rootPath);
    await fs.mkdir(path.join(rootPath, "Exports"));
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 1, 2, 3]);
    await fs.writeFile(path.join(rootPath, "Exports", "Drawing.png"), bytes);
    const renameFile = vi.fn(
      async (sourcePath: string, targetPath: string, expectedRevision: string) => {
        expect(expectedRevision).toBe(revisionOf(bytes));
        await fs.mkdir(path.dirname(path.join(rootPath, targetPath)), { recursive: true });
        await fs.rename(path.join(rootPath, sourcePath), path.join(rootPath, targetPath));
        return {
          status: "committed" as const,
          from: sourcePath,
          to: targetPath,
          transactionId: "binary-rename",
        };
      },
    );
    const vault = new Vault(rootPath, undefined, { renameFile, writeText: vi.fn() });
    const file = vault.getFileByPath("Exports/Drawing.png");
    if (!file) {
      throw new Error("Binary rename fixture was not discovered.");
    }
    const renamed = vi.fn();
    vault.on("rename", renamed);

    await new FileManager(vault).renameFile(file, "Assets/Renamed.png");

    expect(renameFile).toHaveBeenCalledWith(
      "Exports/Drawing.png",
      "Assets/Renamed.png",
      revisionOf(bytes),
    );
    expect(file).toMatchObject({
      path: "Assets/Renamed.png",
      name: "Renamed.png",
      basename: "Renamed",
      extension: "png",
    });
    expect(vault.getFileByPath("Exports/Drawing.png")).toBeNull();
    expect(vault.getFileByPath("Assets/Renamed.png")).not.toBeNull();
    expect(await fs.readFile(path.join(rootPath, "Assets", "Renamed.png"))).toEqual(
      Buffer.from(bytes),
    );
    expect(renamed).toHaveBeenCalledWith(file, "Exports/Drawing.png");
  });

  it("moves binary files to recoverable trash through FileManager without changing bytes", async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-plugin-binary-trash-"));
    temporaryDirectories.push(rootPath);
    await fs.mkdir(path.join(rootPath, "Assets"));
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 4, 5, 6]);
    await fs.writeFile(path.join(rootPath, "Assets", "Drawing.png"), bytes);
    const trashFile = vi.fn(async (sourcePath: string, expectedRevision: string) => {
      expect(expectedRevision).toBe(revisionOf(bytes));
      const targetPath = `.trash/${sourcePath}`;
      await fs.mkdir(path.dirname(path.join(rootPath, targetPath)), { recursive: true });
      await fs.rename(path.join(rootPath, sourcePath), path.join(rootPath, targetPath));
      return {
        status: "committed" as const,
        from: sourcePath,
        to: targetPath,
        transactionId: "binary-trash",
      };
    });
    const vault = new Vault(rootPath, undefined, { trashFile, writeText: vi.fn() });
    const file = vault.getFileByPath("Assets/Drawing.png");
    if (!file) {
      throw new Error("Binary trash fixture was not discovered.");
    }
    const deleted = vi.fn();
    vault.on("delete", deleted);

    await new FileManager(vault).trashFile(file);

    expect(trashFile).toHaveBeenCalledWith("Assets/Drawing.png", revisionOf(bytes));
    expect(vault.getFileByPath("Assets/Drawing.png")).toBeNull();
    await expect(fs.stat(path.join(rootPath, "Assets", "Drawing.png"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.readFile(path.join(rootPath, ".trash", "Assets", "Drawing.png")),
    ).resolves.toEqual(Buffer.from(bytes));
    expect(deleted).toHaveBeenCalledWith(file);
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

  it("reports the active mutation kind when a plugin write does not settle", async () => {
    const { file, rootPath } = await createVaultFile();
    const committed = {
      status: "committed" as const,
      path: file.path,
      revision: revisionOf(Buffer.from("pending drawing", "utf8")),
      transactionId: "pending-write",
    };
    let resolveWrite!: (value: typeof committed) => void;
    const pendingWrite = new Promise<typeof committed>((resolve) => {
      resolveWrite = resolve;
    });
    const writeText = vi.fn(() => pendingWrite);
    const vault = new Vault(rootPath, undefined, { writeText });
    const writableFile = vault.getFileByPath(file.path);
    if (!writableFile) {
      throw new Error("Writable fixture drawing was not discovered.");
    }

    const mutation = vault.modify(writableFile, "pending drawing");
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    await expect(vault.waitForSettledMutations(1, 25)).rejects.toThrow(
      "Active operations: modify-text.",
    );

    resolveWrite(committed);
    await mutation;
    await expect(vault.waitForSettledMutations(1, 100)).resolves.toBeUndefined();
  });

  it("reports generic barrier timeout diagnostics for a pending binary export", async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-plugin-binary-timeout-"));
    temporaryDirectories.push(rootPath);
    const filePath = "Drawing.png";
    const initialBytes = Uint8Array.from([137, 80, 78, 71, 0]);
    await fs.writeFile(path.join(rootPath, filePath), initialBytes);
    const committed = {
      status: "committed" as const,
      path: filePath,
      revision: revisionOf(Uint8Array.from([137, 80, 78, 71, 1])),
      transactionId: "pending-binary-write",
    };
    let resolveWrite!: (value: typeof committed) => void;
    const pendingWrite = new Promise<typeof committed>((resolve) => {
      resolveWrite = resolve;
    });
    const writeBinary = vi.fn(() => pendingWrite);
    const vault = new Vault(rootPath, undefined, {
      writeBinary,
      writeText: vi.fn(),
    });
    const file = vault.getFileByPath(filePath);
    if (!file) {
      throw new Error("Pending binary fixture was not discovered.");
    }

    const mutation = vault.modifyBinary(file, Uint8Array.from([137, 80, 78, 71, 1]).buffer);
    await vi.waitFor(() => expect(writeBinary).toHaveBeenCalledOnce());
    await expect(vault.waitForPluginMutations({ quietMs: 1, timeoutMs: 25 })).rejects.toThrow(
      "Active operations: modify-binary.",
    );

    resolveWrite(committed);
    await mutation;
    await expect(
      vault.waitForPluginMutations({ quietMs: 1, timeoutMs: 100 }),
    ).resolves.toBeUndefined();
  });
});
