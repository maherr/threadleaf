import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs, renameSync } from "node:fs";
import { createServer, type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as nativeFilesystem from "../native-filesystem/index.js";
import { VaultPathError } from "./path-policy";
import { FixedStateRoot } from "./ports";
import {
  type KernelFaultPoint,
  VaultKernel,
  type VaultKernelOptions,
  VaultRecoveryError,
} from "./vault-kernel";

type NativeFilesystemPublishTestSeam = typeof nativeFilesystem & {
  probeAnonymousPublishNoName(targetDirectoryFd: number): void;
};

const nativeFilesystemPublishTestSeam = nativeFilesystem as NativeFilesystemPublishTestSeam;

let sandboxPath: string;
let vaultPath: string;
let statePath: string;

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-kernel-"));
  vaultPath = path.join(sandboxPath, "vault");
  statePath = path.join(sandboxPath, "state");
  await fs.mkdir(vaultPath);
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

async function openKernel(
  faultInjector?: (point: KernelFaultPoint) => void | Promise<void>,
): Promise<VaultKernel> {
  const options: VaultKernelOptions = {
    vaultRoot: vaultPath,
    stateRoot: new FixedStateRoot(statePath),
    ...(faultInjector ? { faultInjector } : {}),
  };
  return VaultKernel.open(options);
}

function injectAttachmentPublishCapability(
  kernel: VaultKernel,
  capability: VaultKernel["attachmentPublishCapability"],
): void {
  Object.defineProperty(kernel, "attachmentPublishCapability", { value: capability });
}

async function expectNoAttachmentPublicationArtifacts(kernel: VaultKernel): Promise<void> {
  await expect(fs.readdir(path.join(kernel.stateRoot, "journal"))).resolves.toEqual([]);
  await expect(fs.readdir(path.join(kernel.stateRoot, "history"))).resolves.toEqual([]);
  await expect(fs.readdir(path.join(kernel.stateRoot, "transactions"))).resolves.toEqual([]);
  await expect(
    fs.readdir(path.join(kernel.stateRoot, "recovery", "rollback-claims")),
  ).resolves.toEqual([]);
}

type NamespaceClaimantKind = "contained-directory-symlink" | "dangling-symlink" | "outside-symlink";

async function createNamespaceClaimant(
  claimantPath: string,
  kind: NamespaceClaimantKind,
  fixtureName: string,
): Promise<void> {
  await fs.mkdir(path.dirname(claimantPath), { recursive: true });
  if (kind === "contained-directory-symlink") {
    const containedDirectory = path.join(vaultPath, `Contained claimant ${fixtureName}`);
    await fs.mkdir(containedDirectory, { recursive: true });
    await fs.symlink(containedDirectory, claimantPath, "dir");
    return;
  }
  if (kind === "dangling-symlink") {
    await fs.symlink(path.join(vaultPath, `Missing claimant ${fixtureName}`), claimantPath);
    return;
  }
  const outsidePath = path.join(sandboxPath, `outside claimant ${fixtureName}.bin`);
  await fs.writeFile(outsidePath, `outside:${fixtureName}`, "utf8");
  await fs.symlink(outsidePath, claimantPath);
}

async function createNamespaceSocket(socketPath: string): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resolve();
    });
  });
  return server;
}

async function closeNamespaceSocket(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function replaceFromSeparateProcess(filePath: string, bytes: Uint8Array): Promise<void> {
  const script = [
    "const fs = require('node:fs');",
    "const target = process.argv[1];",
    "const bytes = Buffer.from(process.argv[2], 'base64');",
    "const temporary = target + '.child-' + process.pid;",
    "fs.writeFileSync(temporary, bytes, { mode: 0o600 });",
    "fs.renameSync(temporary, target);",
  ].join(" ");
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["-e", script, filePath, Buffer.from(bytes).toString("base64")],
      {
        stdio: "ignore",
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`separate-process barrier exited ${String(code)} ${String(signal)}`));
      }
    });
  });
}

describe("VaultKernel path policy", () => {
  it("contains reads and rejects every write through a symbolic link", async () => {
    const outsidePath = path.join(sandboxPath, "outside.md");
    await fs.writeFile(path.join(vaultPath, "inside.md"), "inside", "utf8");
    await fs.writeFile(outsidePath, "outside", "utf8");
    await fs.symlink("inside.md", path.join(vaultPath, "inside-link.md"));
    await fs.symlink(outsidePath, path.join(vaultPath, "outside-link.md"));
    const kernel = await openKernel();

    await expect(kernel.readText("../outside.md")).rejects.toBeInstanceOf(VaultPathError);
    await expect(kernel.readText("outside-link.md")).rejects.toThrow("resolves outside the vault");
    await expect(kernel.readText("inside-link.md")).resolves.toMatchObject({ content: "inside" });
    await expect(kernel.writeText("inside-link.md", "changed", null)).rejects.toThrow(
      "Writes through symbolic links",
    );
    await expect(fs.readFile(path.join(vaultPath, "inside.md"), "utf8")).resolves.toBe("inside");
    await expect(fs.readFile(outsidePath, "utf8")).resolves.toBe("outside");
  });

  it.runIf(process.platform === "linux")(
    "enumerates lexical namespace claimants without exposing or descending through symlink directories",
    async () => {
      await fs.mkdir(path.join(vaultPath, "Real directory"));
      await fs.writeFile(path.join(vaultPath, "Real directory", "inside.bin"), "inside", "utf8");
      await fs.writeFile(path.join(vaultPath, "Regular.bin"), "regular", "utf8");
      await fs.mkdir(path.join(vaultPath, ".obsidian", "private"), { recursive: true });
      await fs.writeFile(
        path.join(vaultPath, ".obsidian", "private", "Hidden.bin"),
        "hidden",
        "utf8",
      );
      await createNamespaceClaimant(
        path.join(vaultPath, "Contained directory link"),
        "contained-directory-symlink",
        "enumerator",
      );
      await createNamespaceClaimant(
        path.join(vaultPath, "Dangling link"),
        "dangling-symlink",
        "enumerator",
      );
      await createNamespaceClaimant(
        path.join(vaultPath, "Outside link"),
        "outside-symlink",
        "enumerator",
      );
      const socketPath = path.join(vaultPath, "Namespace socket");
      const socket = await createNamespaceSocket(socketPath);
      try {
        const kernel = await openKernel();
        const claimants = await kernel.paths.listNamespaceClaimants();

        expect(claimants).toEqual(
          expect.arrayContaining([
            "Contained directory link",
            "Dangling link",
            "Namespace socket",
            "Outside link",
            "Real directory",
            "Real directory/inside.bin",
            "Regular.bin",
          ]),
        );
        expect((await fs.lstat(socketPath)).isSocket()).toBe(true);
        expect(claimants).not.toContain("Contained directory link/inside.bin");
        expect(claimants).not.toContain(".obsidian");
        expect(claimants).not.toContain(".obsidian/private/Hidden.bin");
      } finally {
        await closeNamespaceSocket(socket);
      }
    },
  );

  it("keeps Threadleaf state outside the vault", async () => {
    await expect(
      VaultKernel.open({
        vaultRoot: vaultPath,
        stateRoot: new FixedStateRoot(path.join(vaultPath, ".threadleaf")),
      }),
    ).rejects.toThrow("state must be stored outside the vault");
  });

  it("rejects a state-root symlink that resolves into the vault", async () => {
    const linkedStateRoot = path.join(sandboxPath, "linked-state");
    await fs.symlink(vaultPath, linkedStateRoot, "dir");

    await expect(
      VaultKernel.open({
        vaultRoot: vaultPath,
        stateRoot: new FixedStateRoot(path.join(linkedStateRoot, "state")),
      }),
    ).rejects.toThrow("state must be stored outside the vault");
  });

  it("creates vault identity once and validates it without rewriting", async () => {
    const kernel = await openKernel();
    const identityPath = path.join(kernel.stateRoot, "vault.json");
    const oldDate = new Date("2020-01-02T03:04:05.000Z");
    await fs.utimes(identityPath, oldDate, oldDate);

    await openKernel();

    const stat = await fs.stat(identityPath);
    expect(stat.mtimeMs).toBe(oldDate.getTime());
  });

  it("lists a requested Markdown subtree and rejects directory traversal", async () => {
    await fs.mkdir(path.join(vaultPath, "Folder", "Nested"), { recursive: true });
    await fs.mkdir(path.join(vaultPath, ".obsidian", "plugins", "fixture"), {
      recursive: true,
    });
    await fs.mkdir(path.join(vaultPath, ".git", "notes"), { recursive: true });
    await fs.mkdir(path.join(vaultPath, ".archive"), { recursive: true });
    await fs.mkdir(path.join(vaultPath, "Folder", ".cache"), { recursive: true });
    await fs.mkdir(path.join(vaultPath, ".trash", "Folder"), { recursive: true });
    await fs.writeFile(path.join(vaultPath, "Root.md"), "root", "utf8");
    await fs.writeFile(path.join(vaultPath, "Folder", "A.md"), "a", "utf8");
    await fs.writeFile(path.join(vaultPath, "Folder", "Nested", "B.md"), "b", "utf8");
    await fs.writeFile(
      path.join(vaultPath, ".obsidian", "plugins", "fixture", "README.md"),
      "plugin metadata",
      "utf8",
    );
    await fs.writeFile(path.join(vaultPath, ".git", "notes", "README.md"), "git metadata", "utf8");
    await fs.writeFile(path.join(vaultPath, ".archive", "Hidden.md"), "hidden", "utf8");
    await fs.writeFile(path.join(vaultPath, "Folder", ".cache", "Hidden.md"), "hidden", "utf8");
    await fs.writeFile(path.join(vaultPath, ".draft.md"), "hidden", "utf8");
    await fs.writeFile(path.join(vaultPath, ".trash", "Folder", "Deleted.md"), "deleted", "utf8");
    const kernel = await openKernel();

    await expect(kernel.listMarkdownPaths()).resolves.toEqual([
      "Folder/A.md",
      "Folder/Nested/B.md",
      "Root.md",
    ]);
    await expect(kernel.listMarkdownPaths("Folder/")).resolves.toEqual([
      "Folder/A.md",
      "Folder/Nested/B.md",
    ]);
    await expect(kernel.listMarkdownPaths(".trash")).resolves.toEqual([".trash/Folder/Deleted.md"]);
    await expect(kernel.listMarkdownPaths("../")).rejects.toBeInstanceOf(VaultPathError);
  });

  it("lists visible files and folders without exposing private application trees", async () => {
    await fs.mkdir(path.join(vaultPath, "Folder", "Nested"), { recursive: true });
    await fs.mkdir(path.join(vaultPath, "Empty"));
    await fs.mkdir(path.join(vaultPath, ".obsidian"), { recursive: true });
    await fs.mkdir(path.join(vaultPath, ".archive"), { recursive: true });
    await fs.mkdir(path.join(vaultPath, "Folder", ".cache"), { recursive: true });
    await fs.mkdir(path.join(vaultPath, ".trash"), { recursive: true });
    await fs.writeFile(path.join(vaultPath, "Root.md"), "root", "utf8");
    await fs.writeFile(path.join(vaultPath, "Folder", "image.PNG"), "image", "utf8");
    await fs.writeFile(path.join(vaultPath, "Folder", "Nested", "Board.canvas"), "{}", "utf8");
    await fs.writeFile(path.join(vaultPath, "Folder", "Nested", "Inside.md"), "inside", "utf8");
    await fs.writeFile(path.join(vaultPath, ".obsidian", "appearance.json"), "{}", "utf8");
    await fs.writeFile(path.join(vaultPath, ".obsidian", "Secret.md"), "private", "utf8");
    await fs.writeFile(path.join(vaultPath, ".archive", "Hidden.md"), "hidden", "utf8");
    await fs.writeFile(path.join(vaultPath, "Folder", ".cache", "Hidden.md"), "hidden", "utf8");
    await fs.writeFile(path.join(vaultPath, ".hidden.txt"), "hidden", "utf8");
    await fs.writeFile(path.join(vaultPath, ".trash", "Deleted.md"), "deleted", "utf8");
    await fs.symlink("../Root.md", path.join(vaultPath, "Folder", "root-link.txt"));
    await fs.symlink("../.obsidian/Secret.md", path.join(vaultPath, "Folder", "private-link.md"));
    await fs.symlink("missing.txt", path.join(vaultPath, "Folder", "broken-link.txt"));
    const outsidePath = path.join(sandboxPath, "outside-visible.txt");
    await fs.writeFile(outsidePath, "outside", "utf8");
    await fs.symlink(outsidePath, path.join(vaultPath, "Folder", "outside-link.txt"));
    await fs.symlink("Folder/Nested", path.join(vaultPath, "Nested alias"), "dir");
    const kernel = await openKernel();

    await expect(kernel.listVisiblePaths()).resolves.toEqual({
      directory: "",
      exists: true,
      files: [
        "Folder/image.PNG",
        "Folder/Nested/Board.canvas",
        "Folder/Nested/Inside.md",
        "Folder/root-link.txt",
        "Root.md",
      ],
      folders: ["Empty", "Folder", "Folder/Nested"],
    });
    await expect(kernel.listVisiblePaths("Folder/")).resolves.toEqual({
      directory: "Folder",
      exists: true,
      files: [
        "Folder/image.PNG",
        "Folder/Nested/Board.canvas",
        "Folder/Nested/Inside.md",
        "Folder/root-link.txt",
      ],
      folders: ["Folder/Nested"],
    });
    await expect(kernel.listVisiblePaths("Nested alias")).resolves.toEqual({
      directory: "Nested alias",
      exists: false,
      files: [],
      folders: [],
    });
    await expect(kernel.listMarkdownPaths("Nested alias")).resolves.toEqual([]);
    await expect(kernel.listVisiblePaths(".obsidian")).resolves.toEqual({
      directory: ".obsidian",
      exists: false,
      files: [],
      folders: [],
    });
    await expect(kernel.listVisiblePaths(".archive")).resolves.toEqual({
      directory: ".archive",
      exists: false,
      files: [],
      folders: [],
    });
    await expect(kernel.listVisiblePaths("Missing")).resolves.toMatchObject({ exists: false });
    await expect(kernel.listMarkdownPaths()).resolves.toEqual([
      "Folder/Nested/Inside.md",
      "Root.md",
    ]);
    await expect(kernel.listWorkspaceDocumentPaths()).resolves.toEqual({
      markdownPaths: ["Folder/Nested/Inside.md", "Root.md"],
      canvasPaths: ["Folder/Nested/Board.canvas"],
    });
    await expect(kernel.listVisiblePaths("../")).rejects.toBeInstanceOf(VaultPathError);
  });

  it.skipIf(process.platform === "win32")(
    "rejects relative directory listings through every symlinked ancestor",
    async () => {
      await fs.mkdir(path.join(vaultPath, "Contained", "Child"), { recursive: true });
      await fs.writeFile(path.join(vaultPath, "Contained", "Child", "Inside.md"), "inside", "utf8");
      await fs.symlink("Contained", path.join(vaultPath, "Contained alias"), "dir");

      const outsideDirectory = path.join(sandboxPath, "outside-directory");
      await fs.mkdir(path.join(outsideDirectory, "Child"), { recursive: true });
      await fs.writeFile(path.join(outsideDirectory, "Child", "Outside.md"), "outside", "utf8");
      await fs.symlink(outsideDirectory, path.join(vaultPath, "Outside alias"), "dir");
      const kernel = await openKernel();

      await expect(kernel.listVisiblePaths("Contained/Child")).resolves.toMatchObject({
        directory: "Contained/Child",
        exists: true,
        files: ["Contained/Child/Inside.md"],
      });
      for (const alias of ["Contained alias/Child", "Outside alias/Child"]) {
        await expect(kernel.listVisiblePaths(alias)).resolves.toEqual({
          directory: alias,
          exists: false,
          files: [],
          folders: [],
        });
        await expect(kernel.listMarkdownPaths(alias)).resolves.toEqual([]);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "excludes visible special files from the physical census",
    async () => {
      const socketPath = path.join(vaultPath, "ordinary-looking.sock");
      const socket = await createNamespaceSocket(socketPath);
      try {
        const kernel = await openKernel();
        await expect(kernel.listVisiblePaths()).resolves.toEqual({
          directory: "",
          exists: true,
          files: [],
          folders: [],
        });
      } finally {
        await closeNamespaceSocket(socket);
      }
    },
  );

  it("creates nested public directories while rejecting private, linked, and file paths", async () => {
    const kernel = await openKernel();

    await expect(kernel.createDirectory("Excalidraw/Nested")).resolves.toEqual({
      path: "Excalidraw/Nested",
      created: true,
    });
    await expect(kernel.createDirectory("Excalidraw/Nested/")).resolves.toEqual({
      path: "Excalidraw/Nested",
      created: false,
    });
    await expect(fs.stat(path.join(vaultPath, "Excalidraw", "Nested"))).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
    await expect(kernel.createDirectory(".obsidian/Plugins")).rejects.toThrow(
      "private application paths",
    );

    await fs.symlink("Excalidraw", path.join(vaultPath, "Linked"), "dir");
    await expect(kernel.createDirectory("Linked/New")).rejects.toThrow("symbolic links");
    await fs.writeFile(path.join(vaultPath, "Not a folder"), "file", "utf8");
    await expect(kernel.createDirectory("Not a folder/Nested")).rejects.toThrow("not a directory");
  });
});

describe("VaultKernel writes", () => {
  it("preserves a UTF-8 BOM and CRLF bytes across a read and write", async () => {
    const original = "\uFEFFfirst\r\nsecond\r\n";
    await fs.writeFile(path.join(vaultPath, "Note.md"), original, "utf8");
    const kernel = await openKernel();

    const snapshot = await kernel.readText("Note.md");
    expect(snapshot.content).toBe(original);
    const result = await kernel.writeText(
      "Note.md",
      snapshot.content.replace("second", "changed"),
      snapshot.revision,
    );

    expect(result.status).toBe("committed");
    await expect(fs.readFile(path.join(vaultPath, "Note.md"), "utf8")).resolves.toBe(
      "\uFEFFfirst\r\nchanged\r\n",
    );
  });

  it("creates, modifies, and conflict-preserves exact binary bytes", async () => {
    const kernel = await openKernel();
    const original = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0xff]);
    const updated = Uint8Array.from([0, 0xff, 1, 2, 3, 4, 5]);
    const proposed = Uint8Array.from([0xde, 0xad, 0, 0xbe, 0xef]);
    const external = Uint8Array.from([9, 8, 7, 6]);

    const created = await kernel.createBinary("Exports/Drawing.png", original);
    expect(created).toMatchObject({ status: "committed", path: "Exports/Drawing.png" });
    if (created.status !== "committed") {
      throw new Error("Expected binary creation to commit.");
    }
    await expect(kernel.createBinary("Exports/Drawing.png", updated)).resolves.toMatchObject({
      status: "exists",
      path: "Exports/Drawing.png",
      currentRevision: created.revision,
    });
    const modified = await kernel.writeBinary("Exports/Drawing.png", updated, created.revision);
    expect(modified.status).toBe("committed");
    if (modified.status !== "committed") {
      throw new Error("Expected binary modification to commit.");
    }
    const afterModify = await kernel.readBinary("Exports/Drawing.png", 1024);
    expect(afterModify.status).toBe("ready");
    if (afterModify.status !== "ready") {
      throw new Error("Expected the binary fixture to fit within the read limit.");
    }
    expect(afterModify.snapshot.bytes).toEqual(Buffer.from(updated));

    await fs.writeFile(path.join(vaultPath, "Exports", "Drawing.png"), external);
    const conflict = await kernel.writeBinary("Exports/Drawing.png", proposed, modified.revision);
    expect(conflict.status).toBe("conflict");
    if (conflict.status !== "conflict") {
      throw new Error("Expected the stale binary write to retain a conflict copy.");
    }
    await expect(fs.readFile(path.join(vaultPath, "Exports", "Drawing.png"))).resolves.toEqual(
      Buffer.from(external),
    );
    const retained = await kernel.readBinary(conflict.conflictPath, 1024);
    expect(retained.status).toBe("ready");
    if (retained.status !== "ready") {
      throw new Error("Expected the binary conflict copy to fit within the read limit.");
    }
    expect(retained.snapshot.bytes).toEqual(Buffer.from(proposed));
  });

  it.runIf(process.platform === "linux")(
    "restores exact external attachment bytes through the strict ingress journal",
    async () => {
      await fs.mkdir(path.join(vaultPath, "Notes"));
      await fs.mkdir(path.join(vaultPath, "Missing"));
      await fs.writeFile(
        path.join(vaultPath, "Notes", "Current.md"),
        "\uFEFF# Current\r\n![[Missing/report.pdf?download=1]]\r\n",
        "utf8",
      );
      const kernel = await openKernel();
      const source = await kernel.readText("Notes/Current.md");
      const bytes = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0, 0xff, 0xef, 0xbb, 0xbf]);

      const result = await kernel.ingressAttachmentBytes("Missing/report.pdf", bytes, {
        operation: "restore-missing",
        sourceNotePath: source.path,
        sourceNoteRevision: source.revision,
        missingPath: "Missing/report.pdf",
        missingResolverTarget: "Missing/report.pdf",
      });

      expect(result).toMatchObject({
        status: "committed",
        path: "Missing/report.pdf",
      });
      await expect(fs.readFile(path.join(vaultPath, "Missing", "report.pdf"))).resolves.toEqual(
        Buffer.from(bytes),
      );
      await expect(fs.readFile(path.join(vaultPath, "Notes", "Current.md"), "utf8")).resolves.toBe(
        "\uFEFF# Current\r\n![[Missing/report.pdf?download=1]]\r\n",
      );
      await expect(fs.readdir(path.join(kernel.stateRoot, "journal"))).resolves.toEqual([]);
      await expect(fs.readdir(path.join(kernel.stateRoot, "transactions"))).resolves.toEqual([]);
    },
  );

  it.runIf(process.platform === "linux")(
    "retains staged evidence when a completed publication becomes unobservable",
    async () => {
      const missingDirectory = path.join(vaultPath, "Missing");
      const shiftedDirectory = path.join(vaultPath, "Missing shifted after publication");
      await fs.mkdir(missingDirectory);
      await fs.writeFile(path.join(vaultPath, "Current.md"), "![[Missing/report.pdf]]\n", "utf8");
      const kernel = await openKernel();
      const source = await kernel.readText("Current.md");
      const proposed = Buffer.from("retained uncertain publication");
      const originalPublish = nativeFilesystem.publishBufferNoReplace;
      const publish = vi
        .spyOn(nativeFilesystem, "publishBufferNoReplace")
        .mockImplementation((targetDirectoryFd, targetName, bytes) => {
          originalPublish(targetDirectoryFd, targetName, bytes);
          renameSync(missingDirectory, shiftedDirectory);
          throw new nativeFilesystem.NativeFilesystemError(
            "unsupported",
            "injected post-publication observation failure",
          );
        });

      try {
        const result = await kernel.ingressAttachmentBytes("Missing/report.pdf", proposed, {
          operation: "restore-missing",
          sourceNotePath: "Current.md",
          sourceNoteRevision: source.revision,
          missingPath: "Missing/report.pdf",
          missingResolverTarget: "Missing/report.pdf",
        });

        expect(result).toMatchObject({
          status: "manual-conflict",
          reason: "publish-state-diverged",
          path: "Missing/report.pdf",
        });
        await expect(fs.readFile(path.join(shiftedDirectory, "report.pdf"))).resolves.toEqual(
          proposed,
        );
        const histories = await fs.readdir(path.join(kernel.stateRoot, "history"));
        expect(histories).toHaveLength(1);
        const historyName = histories[0];
        if (!historyName) throw new Error("uncertain attachment-ingress history is missing");
        await expect(
          fs
            .readFile(path.join(kernel.stateRoot, "history", historyName), "utf8")
            .then((contents) => JSON.parse(contents)),
        ).resolves.toMatchObject({ kind: "attachment-ingress", outcome: "manual-conflict" });
        const transactionId = path.basename(historyName, ".json");
        await expect(
          fs.readFile(
            path.join(kernel.stateRoot, "transactions", transactionId, "attachment-ingress.bin"),
          ),
        ).resolves.toEqual(proposed);
      } finally {
        publish.mockRestore();
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "refuses a final source or target race without publishing a conflict copy",
    async () => {
      await fs.mkdir(path.join(vaultPath, "Missing"));
      await fs.writeFile(path.join(vaultPath, "Current.md"), "![[Missing/report.pdf]]\n", "utf8");
      let race: "source" | "target" = "source";
      const kernel = await openKernel(async (point) => {
        if (point !== "attachment-ingress:before-publish") return;
        if (race === "source") {
          await fs.writeFile(path.join(vaultPath, "Current.md"), "changed externally\n", "utf8");
        } else {
          await fs.writeFile(path.join(vaultPath, "Missing", "report.pdf"), "external winner");
        }
      });
      const firstSource = await kernel.readText("Current.md");
      const first = await kernel.ingressAttachmentBytes(
        "Missing/report.pdf",
        Buffer.from("first proposal"),
        {
          operation: "restore-missing",
          sourceNotePath: "Current.md",
          sourceNoteRevision: firstSource.revision,
          missingPath: "Missing/report.pdf",
          missingResolverTarget: "Missing/report.pdf",
        },
      );
      expect(first).toMatchObject({ status: "refused", reason: "source-note-changed" });
      await expect(fs.stat(path.join(vaultPath, "Missing", "report.pdf"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      await fs.writeFile(path.join(vaultPath, "Current.md"), "![[Missing/report.pdf]]\n", "utf8");
      const secondSource = await kernel.readText("Current.md");
      race = "target";
      const second = await kernel.ingressAttachmentBytes(
        "Missing/report.pdf",
        Buffer.from("second proposal"),
        {
          operation: "restore-missing",
          sourceNotePath: "Current.md",
          sourceNoteRevision: secondSource.revision,
          missingPath: "Missing/report.pdf",
          missingResolverTarget: "Missing/report.pdf",
        },
      );
      expect(second).toMatchObject({ status: "refused", reason: "missing-target-present" });
      await expect(
        fs.readFile(path.join(vaultPath, "Missing", "report.pdf"), "utf8"),
      ).resolves.toBe("external winner");
      expect(
        (await fs.readdir(path.join(vaultPath, "Missing"))).filter((entry) =>
          entry.includes("threadleaf-conflict"),
        ),
      ).toEqual([]);
    },
  );

  it.runIf(process.platform === "linux").each([
    ["attachment-ingress:after-intent", "rolled-back", false],
    ["attachment-ingress:after-stage", "committed", true],
    ["attachment-ingress:before-publish", "committed", true],
    ["attachment-ingress:after-publish", "committed", true],
    ["attachment-ingress:after-commit", "committed", true],
  ] as const)(
    "recovers attachment ingress after %s",
    async (faultPoint, expectedOutcome, expectsTarget) => {
      await fs.mkdir(path.join(vaultPath, "Missing"));
      await fs.writeFile(path.join(vaultPath, "Current.md"), "![[Missing/report.pdf]]\n", "utf8");
      const kernel = await openKernel((point) => {
        if (point === faultPoint) throw new Error(`interrupted at ${faultPoint}`);
      });
      const source = await kernel.readText("Current.md");
      await expect(
        kernel.ingressAttachmentBytes("Missing/report.pdf", Buffer.from("recover me"), {
          operation: "restore-missing",
          sourceNotePath: "Current.md",
          sourceNoteRevision: source.revision,
          missingPath: "Missing/report.pdf",
          missingResolverTarget: "Missing/report.pdf",
        }),
      ).rejects.toThrow(`interrupted at ${faultPoint}`);

      const recovered = await openKernel();
      expect(recovered.startupRecoveryActions).toMatchObject([
        {
          kind: "attachment-ingress",
          outcome: expectedOutcome,
          path: "Missing/report.pdf",
        },
      ]);
      if (expectsTarget) {
        await expect(
          fs.readFile(path.join(vaultPath, "Missing", "report.pdf"), "utf8"),
        ).resolves.toBe("recover me");
      } else {
        await expect(fs.stat(path.join(vaultPath, "Missing", "report.pdf"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "revalidates source evidence before recovering staged ingress",
    async () => {
      await fs.mkdir(path.join(vaultPath, "Missing"));
      await fs.writeFile(path.join(vaultPath, "Current.md"), "![[Missing/report.pdf]]\n", "utf8");
      const kernel = await openKernel((point) => {
        if (point === "attachment-ingress:after-stage") throw new Error("staged interruption");
      });
      const source = await kernel.readText("Current.md");
      await expect(
        kernel.ingressAttachmentBytes("Missing/report.pdf", Buffer.from("staged bytes"), {
          operation: "restore-missing",
          sourceNotePath: "Current.md",
          sourceNoteRevision: source.revision,
          missingPath: "Missing/report.pdf",
          missingResolverTarget: "Missing/report.pdf",
        }),
      ).rejects.toThrow("staged interruption");
      await fs.writeFile(path.join(vaultPath, "Current.md"), "reference removed\n", "utf8");

      const recovered = await openKernel();
      expect(recovered.startupRecoveryActions).toMatchObject([
        { kind: "attachment-ingress", outcome: "rolled-back", path: "Missing/report.pdf" },
      ]);
      await expect(fs.stat(path.join(vaultPath, "Missing", "report.pdf"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.runIf(process.platform === "linux")(
    "retains uncertain staged evidence when an exact target appears before recovery",
    async () => {
      await fs.mkdir(path.join(vaultPath, "Missing"));
      await fs.writeFile(path.join(vaultPath, "Current.md"), "![[Missing/report.pdf]]\n", "utf8");
      const kernel = await openKernel((point) => {
        if (point === "attachment-ingress:after-stage") throw new Error("staged interruption");
      });
      const source = await kernel.readText("Current.md");
      await expect(
        kernel.ingressAttachmentBytes("Missing/report.pdf", Buffer.from("staged proposal"), {
          operation: "restore-missing",
          sourceNotePath: "Current.md",
          sourceNoteRevision: source.revision,
          missingPath: "Missing/report.pdf",
          missingResolverTarget: "Missing/report.pdf",
        }),
      ).rejects.toThrow("staged interruption");
      await fs.writeFile(path.join(vaultPath, "Missing", "report.pdf"), "external winner");

      const recovered = await openKernel();
      expect(recovered.startupRecoveryActions).toMatchObject([
        { kind: "attachment-ingress", outcome: "manual-conflict", path: "Missing/report.pdf" },
      ]);
      await expect(
        fs.readFile(path.join(vaultPath, "Missing", "report.pdf"), "utf8"),
      ).resolves.toBe("external winner");
      const history = recovered.startupRecoveryActions[0];
      expect(history?.transactionId).toBeTypeOf("string");
      await expect(
        fs.readFile(
          path.join(
            recovered.stateRoot,
            "transactions",
            history?.transactionId ?? "missing",
            "attachment-ingress.bin",
          ),
          "utf8",
        ),
      ).resolves.toBe("staged proposal");
    },
  );

  it.runIf(process.platform === "linux")(
    "detects a normalized alias that appears after publication and retains both claims",
    async () => {
      await fs.mkdir(path.join(vaultPath, "Missing"));
      await fs.writeFile(path.join(vaultPath, "Current.md"), "![[Missing/Report.pdf]]\n", "utf8");
      const kernel = await openKernel(async (point) => {
        if (point === "attachment-ingress:after-publish") {
          await fs.writeFile(path.join(vaultPath, "Missing", "report.PDF"), "external alias");
        }
      });
      const source = await kernel.readText("Current.md");
      const result = await kernel.ingressAttachmentBytes(
        "Missing/Report.pdf",
        Buffer.from("published bytes"),
        {
          operation: "restore-missing",
          sourceNotePath: "Current.md",
          sourceNoteRevision: source.revision,
          missingPath: "Missing/Report.pdf",
          missingResolverTarget: "Missing/Report.pdf",
        },
      );

      expect(result).toMatchObject({
        status: "manual-conflict",
        reason: "target-normalized-exists",
        path: "Missing/Report.pdf",
      });
      await expect(
        fs.readFile(path.join(vaultPath, "Missing", "Report.pdf"), "utf8"),
      ).resolves.toBe("published bytes");
      await expect(
        fs.readFile(path.join(vaultPath, "Missing", "report.PDF"), "utf8"),
      ).resolves.toBe("external alias");
    },
  );

  it.each([
    ["write:after-intent", "rolled-back", "original", false],
    ["write:after-stage", "conflict-copy", "original", true],
    ["write:after-backup", "conflict-copy", "original", true],
    ["write:before-final-check", "conflict-copy", "original", true],
    ["write:after-prepare", "conflict-copy", "original", true],
    ["write:after-move-aside", "conflict-copy", "original", true],
    ["write:after-install", "committed", "proposed", false],
    ["write:after-commit", "committed", "proposed", false],
  ] as const)(
    "recovers safely after interruption at %s",
    async (faultPoint, expectedOutcome, expectedTarget, expectsConflictCopy) => {
      await fs.writeFile(path.join(vaultPath, "Note.md"), "original", "utf8");
      const kernel = await openKernel((point) => {
        if (point === faultPoint) {
          throw new Error(`interrupted at ${faultPoint}`);
        }
      });
      const original = await kernel.readText("Note.md");

      await expect(kernel.writeText("Note.md", "proposed", original.revision)).rejects.toThrow(
        `interrupted at ${faultPoint}`,
      );
      const recovered = await openKernel();

      expect(recovered.startupRecoveryActions).toHaveLength(1);
      expect(recovered.startupRecoveryActions[0]).toMatchObject({
        kind: "write",
        outcome: expectedOutcome,
        path: "Note.md",
      });
      await expect(recovered.readText("Note.md")).resolves.toMatchObject({
        content: expectedTarget,
      });
      const conflictPath = recovered.startupRecoveryActions[0]?.conflictPath;
      if (expectsConflictCopy) {
        expect(conflictPath).toBeTypeOf("string");
        await expect(recovered.readText(conflictPath ?? "missing")).resolves.toMatchObject({
          content: "proposed",
        });
      } else {
        expect(conflictPath).toBeUndefined();
      }
    },
  );

  it.each([
    ["write:after-intent", "rolled-back", false],
    ["write:after-stage", "committed", true],
    ["write:after-backup", "committed", true],
    ["write:before-final-check", "committed", true],
    ["write:after-prepare", "committed", true],
    ["write:after-install", "committed", true],
    ["write:after-commit", "committed", true],
  ] as const)(
    "recovers a new-file write after interruption at %s",
    async (faultPoint, expectedOutcome, expectsTarget) => {
      const kernel = await openKernel((point) => {
        if (point === faultPoint) {
          throw new Error(`interrupted at ${faultPoint}`);
        }
      });

      await expect(kernel.writeText("New.md", "created", null)).rejects.toThrow(
        `interrupted at ${faultPoint}`,
      );
      const recovered = await openKernel();

      expect(recovered.startupRecoveryActions).toMatchObject([
        { kind: "write", outcome: expectedOutcome, path: "New.md" },
      ]);
      if (expectsTarget) {
        await expect(recovered.readText("New.md")).resolves.toMatchObject({ content: "created" });
      } else {
        await expect(recovered.readText("New.md")).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect((await fs.readdir(vaultPath)).filter((name) => name.includes("conflict"))).toEqual([]);
    },
  );

  it("recovers an interrupted staged write without losing either version", async () => {
    const notePath = path.join(vaultPath, "Note.md");
    await fs.writeFile(notePath, "original", "utf8");
    const kernel = await openKernel((point) => {
      if (point === "write:after-stage") {
        throw new Error("simulated power loss");
      }
    });
    const original = await kernel.readText("Note.md");

    await expect(kernel.writeText("Note.md", "proposed", original.revision)).rejects.toThrow(
      "simulated power loss",
    );
    await expect(fs.readFile(notePath, "utf8")).resolves.toBe("original");

    const recovered = await openKernel();
    expect(recovered.startupRecoveryActions).toHaveLength(1);
    expect(recovered.startupRecoveryActions[0]).toMatchObject({
      kind: "write",
      outcome: "conflict-copy",
      path: "Note.md",
    });
    const conflictPath = recovered.startupRecoveryActions[0]?.conflictPath;
    expect(conflictPath).toBeTypeOf("string");
    await expect(recovered.readText(conflictPath ?? "missing")).resolves.toMatchObject({
      content: "proposed",
    });
    await expect(recovered.readText("Note.md")).resolves.toMatchObject({ content: "original" });
  });

  it("finalizes an interrupted committed write and retains the previous bytes", async () => {
    await fs.writeFile(path.join(vaultPath, "Note.md"), "before", "utf8");
    const kernel = await openKernel((point) => {
      if (point === "write:after-commit") {
        throw new Error("simulated process death");
      }
    });
    const before = await kernel.readText("Note.md");

    await expect(kernel.writeText("Note.md", "after", before.revision)).rejects.toThrow(
      "simulated process death",
    );
    await expect(fs.readFile(path.join(vaultPath, "Note.md"), "utf8")).resolves.toBe("after");

    const recovered = await openKernel();
    expect(recovered.startupRecoveryActions).toMatchObject([
      { kind: "write", outcome: "committed", path: "Note.md" },
    ]);
    const recoveryFiles = (
      await fs.readdir(path.join(recovered.stateRoot, "recovery"), { withFileTypes: true })
    )
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
    expect(recoveryFiles).toHaveLength(1);
    await expect(
      fs.readFile(
        path.join(recovered.stateRoot, "recovery", recoveryFiles[0] ?? "missing"),
        "utf8",
      ),
    ).resolves.toBe("before");
  });

  it("preserves an external edit and writes the proposed version as a conflict copy", async () => {
    const notePath = path.join(vaultPath, "Note.md");
    await fs.writeFile(notePath, "base", "utf8");
    const kernel = await openKernel(async (point) => {
      if (point === "write:before-final-check") {
        await fs.writeFile(notePath, "external", "utf8");
      }
    });
    const base = await kernel.readText("Note.md");

    const result = await kernel.writeText("Note.md", "threadleaf", base.revision);
    expect(result.status).toBe("conflict");
    await expect(fs.readFile(notePath, "utf8")).resolves.toBe("external");
    if (result.status !== "conflict") {
      throw new Error("Expected a conflict result.");
    }
    await expect(kernel.readText(result.conflictPath)).resolves.toMatchObject({
      content: "threadleaf",
    });
  });

  it("does not overwrite an external file created in the final install window", async () => {
    const notePath = path.join(vaultPath, "Note.md");
    await fs.writeFile(notePath, "base", "utf8");
    const kernel = await openKernel(async (point) => {
      if (point === "write:after-move-aside") {
        await fs.writeFile(notePath, "external", "utf8");
      }
    });
    const base = await kernel.readText("Note.md");

    const result = await kernel.writeText("Note.md", "threadleaf", base.revision);

    expect(result.status).toBe("conflict");
    await expect(fs.readFile(notePath, "utf8")).resolves.toBe("external");
    if (result.status === "conflict") {
      await expect(kernel.readText(result.conflictPath)).resolves.toMatchObject({
        content: "threadleaf",
      });
    }
  });

  it("preserves a rollback-name claimant instead of overwriting it", async () => {
    const notePath = path.join(vaultPath, "Note.md");
    await fs.writeFile(notePath, "base", "utf8");
    let stateRoot = "";
    const kernel = await openKernel(async (point) => {
      if (point !== "write:after-prepare") return;
      const journalName = (await fs.readdir(path.join(stateRoot, "journal"))).find((entry) =>
        entry.endsWith(".json"),
      );
      if (!journalName) throw new Error("write journal was not present");
      const journal = JSON.parse(
        await fs.readFile(path.join(stateRoot, "journal", journalName), "utf8"),
      ) as { rollbackPath: string };
      await fs.writeFile(path.join(vaultPath, journal.rollbackPath), "external claimant", "utf8");
    });
    stateRoot = kernel.stateRoot;
    const base = await kernel.readText("Note.md");

    const result = await kernel.writeText("Note.md", "threadleaf", base.revision);

    expect(result.status).toBe("conflict");
    await expect(fs.readFile(notePath, "utf8")).resolves.toBe("base");
    const claimant = (await fs.readdir(vaultPath)).find((entry) =>
      entry.startsWith(".threadleaf-rollback-"),
    );
    expect(claimant).toBeTypeOf("string");
    await expect(fs.readFile(path.join(vaultPath, claimant ?? "missing"), "utf8")).resolves.toBe(
      "external claimant",
    );
    if (result.status === "conflict") {
      await expect(kernel.readText(result.conflictPath)).resolves.toMatchObject({
        content: "threadleaf",
      });
    }
  });

  it("restores an old inode changed after it was moved aside", async () => {
    const notePath = path.join(vaultPath, "Note.md");
    await fs.writeFile(notePath, "base", "utf8");
    const kernel = await openKernel(async (point) => {
      if (point === "write:after-move-aside") {
        const rollbackName = (await fs.readdir(vaultPath)).find((name) =>
          name.startsWith(".threadleaf-rollback-"),
        );
        if (!rollbackName) {
          throw new Error("rollback fixture was not present");
        }
        await fs.writeFile(
          path.join(vaultPath, rollbackName),
          "external through old inode",
          "utf8",
        );
      }
    });
    const base = await kernel.readText("Note.md");

    const result = await kernel.writeText("Note.md", "threadleaf", base.revision);

    expect(result.status).toBe("conflict");
    await expect(fs.readFile(notePath, "utf8")).resolves.toBe("external through old inode");
    if (result.status === "conflict") {
      await expect(kernel.readText(result.conflictPath)).resolves.toMatchObject({
        content: "threadleaf",
      });
    }
  });

  it("requires a revision for overwrites and never performs a blind write", async () => {
    await fs.writeFile(path.join(vaultPath, "Note.md"), "existing", "utf8");
    const kernel = await openKernel();

    const result = await kernel.writeText("Note.md", "proposed", null);
    expect(result.status).toBe("conflict");
    await expect(kernel.readText("Note.md")).resolves.toMatchObject({ content: "existing" });
    if (result.status === "conflict") {
      await expect(kernel.readText(result.conflictPath)).resolves.toMatchObject({
        content: "proposed",
      });
    }
  });

  it("refuses every mutation in read-only mode", async () => {
    const kernel = await VaultKernel.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
      readOnly: true,
    });
    await expect(fs.stat(statePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(kernel.listMarkdownPaths()).resolves.toEqual([]);
    await expect(kernel.writeText("Note.md", "content", null)).rejects.toThrow("read-only mode");
  });

  it("serializes competing writes and preserves the losing proposal", async () => {
    await fs.writeFile(path.join(vaultPath, "Note.md"), "base", "utf8");
    const kernel = await openKernel();
    const base = await kernel.readText("Note.md");

    const [first, second] = await Promise.all([
      kernel.writeText("Note.md", "first", base.revision),
      kernel.writeText("Note.md", "second", base.revision),
    ]);

    expect(first.status).toBe("committed");
    expect(second.status).toBe("conflict");
    await expect(kernel.readText("Note.md")).resolves.toMatchObject({ content: "first" });
    if (second.status === "conflict") {
      await expect(kernel.readText(second.conflictPath)).resolves.toMatchObject({
        content: "second",
      });
    }
  });

  it("validates every pending journal before changing any vault file", async () => {
    const notePath = path.join(vaultPath, "Note.md");
    await fs.writeFile(notePath, "original", "utf8");
    const interrupted = await openKernel((point) => {
      if (point === "write:after-stage") {
        throw new Error("simulated interruption");
      }
    });
    const original = await interrupted.readText("Note.md");
    await expect(interrupted.writeText("Note.md", "proposed", original.revision)).rejects.toThrow(
      "simulated interruption",
    );

    const invalidId = randomUUID();
    const invalidJournalPath = path.join(interrupted.stateRoot, "journal", `${invalidId}.json`);
    await fs.writeFile(
      invalidJournalPath,
      JSON.stringify({
        version: 1,
        id: invalidId,
        vaultId: interrupted.vaultId,
        kind: "write",
        phase: "staged",
        targetPath: "../../outside.md",
      }),
      "utf8",
    );

    await expect(openKernel()).rejects.toBeInstanceOf(VaultRecoveryError);
    await expect(fs.readFile(notePath, "utf8")).resolves.toBe("original");
    expect(await fs.readdir(path.join(interrupted.stateRoot, "history"))).toHaveLength(0);

    await fs.unlink(invalidJournalPath);
    const recovered = await openKernel();
    expect(recovered.startupRecoveryActions).toMatchObject([
      { kind: "write", outcome: "conflict-copy", path: "Note.md" },
    ]);
  });
});

describe("VaultKernel renames", () => {
  it("recovers a crash between linking the new name and removing the old one", async () => {
    await fs.writeFile(path.join(vaultPath, "Before.md"), "rename me", "utf8");
    const kernel = await openKernel((point) => {
      if (point === "rename:after-link") {
        throw new Error("simulated rename interruption");
      }
    });
    const source = await kernel.readText("Before.md");

    await expect(kernel.renameFile("Before.md", "After.md", source.revision)).rejects.toThrow(
      "simulated rename interruption",
    );
    await expect(fs.readFile(path.join(vaultPath, "Before.md"), "utf8")).resolves.toBe("rename me");
    await expect(fs.readFile(path.join(vaultPath, "After.md"), "utf8")).resolves.toBe("rename me");

    const recovered = await openKernel();
    expect(recovered.startupRecoveryActions).toMatchObject([
      { kind: "rename", outcome: "committed", path: "After.md" },
    ]);
    await expect(fs.stat(path.join(vaultPath, "Before.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.readFile(path.join(vaultPath, "After.md"), "utf8")).resolves.toBe("rename me");
  });

  it.each([
    "rename:after-intent",
    "rename:after-stage",
    "rename:before-install",
    "rename:after-install",
    "rename:after-link",
    "rename:after-source-check",
    "rename:after-source-claim",
    "rename:before-source-remove",
    "rename:after-commit",
  ] as const)("recovers an independent-byte rename after %s", async (faultPoint) => {
    await fs.writeFile(path.join(vaultPath, "Before.md"), "rename me", "utf8");
    const interrupted = await openKernel((point) => {
      if (point === faultPoint) throw new Error(`interrupted at ${faultPoint}`);
    });
    const source = await interrupted.readText("Before.md");
    await expect(interrupted.renameFile("Before.md", "After.md", source.revision)).rejects.toThrow(
      `interrupted at ${faultPoint}`,
    );

    const recovered = await openKernel();

    expect(recovered.startupRecoveryActions.at(-1)).toMatchObject({
      kind: "rename",
      outcome: "committed",
      path: "After.md",
    });
    await expect(fs.readFile(path.join(vaultPath, "After.md"), "utf8")).resolves.toBe("rename me");
    await expect(fs.stat(path.join(vaultPath, "Before.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs
        .readdir(vaultPath)
        .then((entries) => entries.filter((entry) => entry.startsWith(".threadleaf-claim-"))),
    ).resolves.toEqual([]);
  });

  it("keeps both files when a rename target already exists", async () => {
    await fs.writeFile(path.join(vaultPath, "Before.md"), "source", "utf8");
    await fs.writeFile(path.join(vaultPath, "After.md"), "target", "utf8");
    const kernel = await openKernel();
    const source = await kernel.readText("Before.md");

    await expect(
      kernel.renameFile("Before.md", "After.md", source.revision),
    ).resolves.toMatchObject({
      status: "conflict",
      reason: "target-exists",
    });
    await expect(kernel.readText("Before.md")).resolves.toMatchObject({ content: "source" });
    await expect(kernel.readText("After.md")).resolves.toMatchObject({ content: "target" });
  });

  it.runIf(process.platform === "linux")(
    "returns the source-retained publication outcome for strict attachment copies",
    async () => {
      const sourcePath = path.join(vaultPath, "Before.bin");
      const targetPath = path.join(vaultPath, "After.bin");
      const bytes = Buffer.from([0, 1, 2, 255, 10]);
      await fs.writeFile(sourcePath, bytes);
      const kernel = await openKernel();
      const source = await kernel.readBinary("Before.bin", 1024);
      if (source.status !== "ready") throw new Error("Expected binary fixture.");

      const result = await kernel.renameFile(
        "Before.bin",
        "After.bin",
        source.snapshot.revision,
        undefined,
        {
          strictContainment: true,
        },
      );

      expect(result).toMatchObject({
        status: "published-source-retained",
        from: "Before.bin",
        to: "After.bin",
      });
      if (result.status !== "published-source-retained") {
        throw new Error("Expected a source-retained publication.");
      }
      await expect(fs.readFile(sourcePath)).resolves.toEqual(bytes);
      await expect(fs.readFile(targetPath)).resolves.toEqual(bytes);
      await expect(
        fs.readFile(
          path.join(kernel.stateRoot, "transactions", result.transactionId, "rename-source"),
        ),
      ).resolves.toEqual(bytes);
    },
  );

  it.runIf(process.platform === "linux")(
    "refuses a strict attachment target whose parent is absent before creating transaction state",
    async () => {
      const sourcePath = path.join(vaultPath, "Before.bin");
      const targetPath = path.join(vaultPath, "Archive", "After.bin");
      const bytes = Buffer.from("strict source");
      await fs.writeFile(sourcePath, bytes);
      const kernel = await openKernel();
      const source = await kernel.readBinary("Before.bin", 1024);
      if (source.status !== "ready") throw new Error("Expected binary fixture.");

      await expect(
        kernel.renameFile("Before.bin", "Archive/After.bin", source.snapshot.revision, undefined, {
          strictContainment: true,
        }),
      ).resolves.toMatchObject({ status: "conflict", reason: "attachment-publish-unavailable" });
      await expect(fs.readFile(sourcePath)).resolves.toEqual(bytes);
      await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(path.join(vaultPath, "Archive"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expectNoAttachmentPublicationArtifacts(kernel);
    },
  );

  it.runIf(process.platform === "linux")(
    "fails an exact target-directory anonymous publication probe before direct transaction evidence",
    async () => {
      const sourcePath = path.join(vaultPath, "Probe source.bin");
      const targetPath = path.join(vaultPath, "Probe target.bin");
      const bytes = Buffer.from("direct target probe source");
      await fs.writeFile(sourcePath, bytes);
      const kernel = await openKernel();
      expect(kernel.attachmentPublishCapability).toMatchObject({ status: "supported" });
      const source = await kernel.readBinary("Probe source.bin", 1024);
      if (source.status !== "ready") throw new Error("Expected binary fixture.");
      const probe = vi
        .spyOn(nativeFilesystemPublishTestSeam, "probeAnonymousPublishNoName")
        .mockImplementation(() => {
          throw new nativeFilesystem.NativeFilesystemError(
            "unsupported",
            "injected exact target anonymous probe failure",
          );
        });
      const publish = vi.spyOn(nativeFilesystem, "publishBufferNoReplace");
      try {
        await expect(
          kernel.renameFile(
            "Probe source.bin",
            "Probe target.bin",
            source.snapshot.revision,
            undefined,
            {
              strictContainment: true,
            },
          ),
        ).resolves.toMatchObject({
          status: "conflict",
          reason: "attachment-publish-unavailable",
        });
        expect(probe).toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
        await expect(fs.readFile(sourcePath)).resolves.toEqual(bytes);
        await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expectNoAttachmentPublicationArtifacts(kernel);
      } finally {
        publish.mockRestore();
        probe.mockRestore();
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "returns a typed direct conflict and retains private evidence when the final native publish call fails",
    async () => {
      const sourcePath = path.join(vaultPath, "Late source.bin");
      const targetPath = path.join(vaultPath, "Late target.bin");
      const bytes = Buffer.from("direct late native publish source");
      await fs.writeFile(sourcePath, bytes);
      const kernel = await openKernel();
      expect(kernel.attachmentPublishCapability).toMatchObject({ status: "supported" });
      const source = await kernel.readBinary("Late source.bin", 1024);
      if (source.status !== "ready") throw new Error("Expected binary fixture.");
      const publish = vi
        .spyOn(nativeFilesystem, "publishBufferNoReplace")
        .mockImplementation(() => {
          throw new nativeFilesystem.NativeFilesystemError(
            "unsupported",
            "injected final native publish failure",
          );
        });
      try {
        await expect(
          kernel.renameFile(
            "Late source.bin",
            "Late target.bin",
            source.snapshot.revision,
            undefined,
            {
              strictContainment: true,
            },
          ),
        ).resolves.toMatchObject({
          status: "conflict",
          reason: "attachment-publish-unavailable",
        });
        expect(publish).toHaveBeenCalled();
        await expect(fs.readFile(sourcePath)).resolves.toEqual(bytes);
        // This controlled replacement throws before native linkat, so its target is absent.
        await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
        const histories = await fs.readdir(path.join(kernel.stateRoot, "history"));
        expect(histories).toHaveLength(1);
        const historyName = histories[0];
        if (!historyName) throw new Error("late direct publication history is missing");
        await expect(
          fs
            .readFile(path.join(kernel.stateRoot, "history", historyName), "utf8")
            .then((contents) => JSON.parse(contents)),
        ).resolves.toMatchObject({ kind: "rename", outcome: "manual-conflict" });
        const transactionId = path.basename(historyName, ".json");
        await expect(
          fs.readFile(path.join(kernel.stateRoot, "transactions", transactionId, "rename-source")),
        ).resolves.toEqual(bytes);
        await expect(
          fs.readFile(path.join(kernel.stateRoot, "recovery", `${transactionId}.before`)),
        ).resolves.toEqual(bytes);
      } finally {
        publish.mockRestore();
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "returns typed strict publication conflicts before any direct-rename mutation when capability checks fail",
    async () => {
      const cases = [
        {
          name: "anonymous publication is unsupported",
          capability: {
            status: "unsupported" as const,
            code: "anonymous-publication-unsupported" as const,
            contract: "FILE-PUBLISH-CAP-02" as const,
            detail: "injected unsupported capability",
          },
        },
        {
          name: "the destination device differs",
          capability: {
            status: "supported" as const,
            contract: "FILE-PUBLISH-CAP-02" as const,
            device: "injected-other-device",
          },
        },
      ];

      for (const testCase of cases) {
        const sourcePath = path.join(vaultPath, `${testCase.name}.bin`);
        const targetPath = path.join(vaultPath, `${testCase.name}-copy.bin`);
        const bytes = Buffer.from(testCase.name, "utf8");
        await fs.writeFile(sourcePath, bytes);
        const kernel = await openKernel();
        injectAttachmentPublishCapability(kernel, testCase.capability);
        const source = await kernel.readBinary(path.basename(sourcePath), 1024);
        if (source.status !== "ready") throw new Error("Expected binary fixture.");

        await expect(
          kernel.renameFile(
            path.basename(sourcePath),
            path.basename(targetPath),
            source.snapshot.revision,
            undefined,
            { strictContainment: true },
          ),
        ).resolves.toMatchObject({ status: "conflict", reason: "attachment-publish-unavailable" });
        await expect(fs.readFile(sourcePath)).resolves.toEqual(bytes);
        await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expectNoAttachmentPublicationArtifacts(kernel);
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "recovers a strict publication interrupted after the publish barrier",
    async () => {
      const sourcePath = path.join(vaultPath, "Before.bin");
      const targetPath = path.join(vaultPath, "After.bin");
      const bytes = Buffer.from([0, 1, 2, 255, 10]);
      await fs.writeFile(sourcePath, bytes);
      const interrupted = await openKernel(async (point) => {
        if (point === "rename:after-publish") throw new Error("interrupted after publish");
      });
      const source = await interrupted.readBinary("Before.bin", 1024);
      if (source.status !== "ready") throw new Error("Expected binary fixture.");

      await expect(
        interrupted.renameFile("Before.bin", "After.bin", source.snapshot.revision, undefined, {
          strictContainment: true,
        }),
      ).rejects.toThrow("interrupted after publish");
      await expect(fs.readFile(sourcePath)).resolves.toEqual(bytes);
      await expect(fs.readFile(targetPath)).resolves.toEqual(bytes);

      const recovered = await openKernel();
      expect(recovered.startupRecoveryActions.at(-1)).toMatchObject({
        kind: "rename",
        outcome: "published-source-retained",
        path: "After.bin",
      });
      await expect(fs.readFile(sourcePath)).resolves.toEqual(bytes);
      await expect(fs.readFile(targetPath)).resolves.toEqual(bytes);
    },
  );

  it.runIf(process.platform === "linux")(
    "treats a committed strict publication as receipt-only recovery",
    async () => {
      const cases = [
        {
          name: "an altered exact target",
          mutate: async (targetPath: string, _claimantPath: string, _claimantBytes: Buffer) => {
            await fs.writeFile(targetPath, "external target", "utf8");
          },
          expectedTarget: "external target",
        },
        {
          name: "a missing exact target",
          mutate: async (targetPath: string, _claimantPath: string, _claimantBytes: Buffer) => {
            await fs.unlink(targetPath);
          },
          expectedTarget: null,
        },
        {
          name: "an equivalent claimant",
          mutate: async (_targetPath: string, claimantPath: string, claimantBytes: Buffer) => {
            await fs.writeFile(claimantPath, claimantBytes);
          },
          expectedTarget: "source bytes",
          expectsClaimant: true,
        },
      ];
      for (const [index, testCase] of cases.entries()) {
        const sourcePath = path.join(vaultPath, `Committed direct ${index}.bin`);
        const targetPath = path.join(vaultPath, "Archive", `Committed direct ${index}.bin`);
        const claimantPath = path.join(vaultPath, "archive", `committed direct ${index}.BIN`);
        const sourceBytes = Buffer.from("source bytes", "utf8");
        const claimantBytes = Buffer.from(`claimant:${testCase.name}`, "utf8");
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.mkdir(path.dirname(claimantPath), { recursive: true });
        await fs.writeFile(sourcePath, sourceBytes);
        const interrupted = await openKernel(async (point) => {
          if (point !== "rename:after-commit") return;
          await testCase.mutate(targetPath, claimantPath, claimantBytes);
          throw new Error(`interrupted after committed ${testCase.name}`);
        });
        const source = await interrupted.readBinary(path.basename(sourcePath), 1024);
        if (source.status !== "ready") throw new Error("Expected binary fixture.");

        await expect(
          interrupted.renameFile(
            path.basename(sourcePath),
            `Archive/${path.basename(targetPath)}`,
            source.snapshot.revision,
            undefined,
            { strictContainment: true },
          ),
        ).rejects.toThrow(`interrupted after committed ${testCase.name}`);

        const recovered = await openKernel();
        expect(recovered.startupRecoveryActions.at(-1)).toMatchObject({
          kind: "rename",
          outcome: "manual-conflict",
          path: `Archive/${path.basename(targetPath)}`,
        });
        await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBytes);
        if (testCase.expectedTarget === null) {
          await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          await expect(fs.readFile(targetPath, "utf8")).resolves.toBe(testCase.expectedTarget);
        }
        if (testCase.expectsClaimant) {
          await expect(fs.readFile(claimantPath)).resolves.toEqual(claimantBytes);
        }
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "keeps an equivalent claimant and the exact target after a strict publication crash",
    async () => {
      const sourcePath = path.join(vaultPath, "Before.bin");
      const targetPath = path.join(vaultPath, "After.bin");
      const claimantPath = path.join(vaultPath, "after.BIN");
      const bytes = Buffer.from("strict recovery source", "utf8");
      const claimantBytes = Buffer.from("external normalized claimant", "utf8");
      await fs.writeFile(sourcePath, bytes);
      const interrupted = await openKernel(async (point) => {
        if (point !== "rename:after-publish") return;
        await fs.writeFile(claimantPath, claimantBytes);
        throw new Error("interrupted after strict publish claimant");
      });
      const source = await interrupted.readBinary("Before.bin", 1024);
      if (source.status !== "ready") throw new Error("Expected binary fixture.");

      await expect(
        interrupted.renameFile("Before.bin", "After.bin", source.snapshot.revision, undefined, {
          strictContainment: true,
        }),
      ).rejects.toThrow("interrupted after strict publish claimant");

      const recovered = await openKernel();
      expect(recovered.startupRecoveryActions.at(-1)).toMatchObject({
        kind: "rename",
        outcome: "manual-conflict",
        path: "After.bin",
      });
      await expect(fs.readFile(sourcePath)).resolves.toEqual(bytes);
      await expect(fs.readFile(targetPath)).resolves.toEqual(bytes);
      await expect(fs.readFile(claimantPath)).resolves.toEqual(claimantBytes);
    },
  );

  it.runIf(process.platform === "linux")(
    "rejects a strict target claimant at the publish barrier",
    async () => {
      const sourcePath = path.join(vaultPath, "Before.bin");
      const targetPath = path.join(vaultPath, "After.bin");
      const bytes = Buffer.from([0, 1, 2, 255, 10]);
      await fs.writeFile(sourcePath, bytes);
      const kernel = await openKernel(async (point) => {
        if (point !== "rename:before-publish") return;
        await fs.writeFile(targetPath, Buffer.from("external target", "utf8"));
      });
      const source = await kernel.readBinary("Before.bin", 1024);
      if (source.status !== "ready") throw new Error("Expected binary fixture.");

      const result = await kernel.renameFile(
        "Before.bin",
        "After.bin",
        source.snapshot.revision,
        undefined,
        { strictContainment: true },
      );

      expect(result).toMatchObject({ status: "conflict", reason: "target-created" });
      await expect(fs.readFile(sourcePath)).resolves.toEqual(bytes);
      await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("external target");
    },
  );

  it.runIf(process.platform === "linux")(
    "rejects every lexical symlink alias at the final strict direct-publication barrier",
    async () => {
      const cases: Array<{ kind: NamespaceClaimantKind; name: string }> = [
        { kind: "contained-directory-symlink", name: "contained directory" },
        { kind: "dangling-symlink", name: "dangling" },
        { kind: "outside-symlink", name: "outside" },
      ];
      for (const [index, testCase] of cases.entries()) {
        const sourceName = `Direct namespace source ${index}.bin`;
        const targetName = `Direct namespace target ${index}.bin`;
        const claimantName = `direct namespace TARGET ${index}.BIN`;
        const sourcePath = path.join(vaultPath, sourceName);
        const targetPath = path.join(vaultPath, targetName);
        const claimantPath = path.join(vaultPath, claimantName);
        const sourceBytes = Buffer.from(`direct source:${testCase.name}`, "utf8");
        await fs.writeFile(sourcePath, sourceBytes);
        const kernel = await openKernel(async (point) => {
          if (point !== "rename:before-publish") return;
          await createNamespaceClaimant(claimantPath, testCase.kind, `direct-prepublish-${index}`);
        });
        const source = await kernel.readBinary(sourceName, 1024);
        if (source.status !== "ready") throw new Error("Expected binary fixture.");

        await expect(
          kernel.renameFile(sourceName, targetName, source.snapshot.revision, undefined, {
            strictContainment: true,
          }),
        ).resolves.toMatchObject({ status: "conflict", reason: "target-normalized-exists" });
        await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBytes);
        expect((await fs.lstat(claimantPath)).isSymbolicLink()).toBe(true);
        await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "preserves direct attachment evidence and lexical aliases through post-publication crash recovery",
    async () => {
      const cases: Array<{ kind: NamespaceClaimantKind; name: string }> = [
        { kind: "contained-directory-symlink", name: "contained directory" },
        { kind: "dangling-symlink", name: "dangling" },
        { kind: "outside-symlink", name: "outside" },
      ];
      for (const [index, testCase] of cases.entries()) {
        const sourceName = `Direct recovery source ${index}.bin`;
        const targetName = `Direct recovery target ${index}.bin`;
        const claimantName = `direct recovery TARGET ${index}.BIN`;
        const sourcePath = path.join(vaultPath, sourceName);
        const targetPath = path.join(vaultPath, targetName);
        const claimantPath = path.join(vaultPath, claimantName);
        const sourceBytes = Buffer.from(`direct recovery:${testCase.name}`, "utf8");
        await fs.writeFile(sourcePath, sourceBytes);
        const interrupted = await openKernel(async (point) => {
          if (point !== "rename:after-publish") return;
          await createNamespaceClaimant(claimantPath, testCase.kind, `direct-recovery-${index}`);
          throw new Error(`interrupted direct namespace ${testCase.name}`);
        });
        const source = await interrupted.readBinary(sourceName, 1024);
        if (source.status !== "ready") throw new Error("Expected binary fixture.");

        await expect(
          interrupted.renameFile(sourceName, targetName, source.snapshot.revision, undefined, {
            strictContainment: true,
          }),
        ).rejects.toThrow(`interrupted direct namespace ${testCase.name}`);
        await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBytes);
        await expect(fs.readFile(targetPath)).resolves.toEqual(sourceBytes);
        expect((await fs.lstat(claimantPath)).isSymbolicLink()).toBe(true);

        const recovered = await openKernel();
        expect(recovered.startupRecoveryActions.at(-1)).toMatchObject({
          kind: "rename",
          outcome: "manual-conflict",
          path: targetName,
        });
        await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBytes);
        await expect(fs.readFile(targetPath)).resolves.toEqual(sourceBytes);
        expect((await fs.lstat(claimantPath)).isSymbolicLink()).toBe(true);
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "keeps an exact regular target on the ordinary strict target-exists path",
    async () => {
      const sourcePath = path.join(vaultPath, "Exact regular source.bin");
      const targetPath = path.join(vaultPath, "Exact regular target.bin");
      const sourceBytes = Buffer.from("source", "utf8");
      const targetBytes = Buffer.from("target", "utf8");
      await fs.writeFile(sourcePath, sourceBytes);
      await fs.writeFile(targetPath, targetBytes);
      const kernel = await openKernel();
      const source = await kernel.readBinary("Exact regular source.bin", 1024);
      if (source.status !== "ready") throw new Error("Expected binary fixture.");

      await expect(
        kernel.renameFile(
          "Exact regular source.bin",
          "Exact regular target.bin",
          source.snapshot.revision,
          undefined,
          { strictContainment: true },
        ),
      ).resolves.toMatchObject({ status: "conflict", reason: "target-exists" });
      await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBytes);
      await expect(fs.readFile(targetPath)).resolves.toEqual(targetBytes);
    },
  );

  it.runIf(process.platform === "linux")(
    "rejects a socket case alias at the final strict direct-publication barrier",
    async () => {
      const sourceName = "Socket alias source.bin";
      const targetName = "Socket alias target.bin";
      const claimantName = "SOCKET ALIAS TARGET.BIN";
      const sourcePath = path.join(vaultPath, sourceName);
      const targetPath = path.join(vaultPath, targetName);
      const claimantPath = path.join(vaultPath, claimantName);
      const sourceBytes = Buffer.from("socket alias source", "utf8");
      await fs.writeFile(sourcePath, sourceBytes);
      let socket: Server | undefined;
      const kernel = await openKernel(async (point) => {
        if (point !== "rename:before-publish") return;
        socket = await createNamespaceSocket(claimantPath);
      });
      try {
        const source = await kernel.readBinary(sourceName, 1024);
        if (source.status !== "ready") throw new Error("Expected binary fixture.");

        await expect(
          kernel.renameFile(sourceName, targetName, source.snapshot.revision, undefined, {
            strictContainment: true,
          }),
        ).resolves.toMatchObject({ status: "conflict", reason: "target-normalized-exists" });
        await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBytes);
        expect((await fs.lstat(claimantPath)).isSocket()).toBe(true);
        await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        if (socket) await closeNamespaceSocket(socket);
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "rejects an exact socket strict target before reading or journaling",
    async () => {
      const sourceName = "Exact socket source.bin";
      const targetName = "Exact socket target.bin";
      const sourcePath = path.join(vaultPath, sourceName);
      const targetPath = path.join(vaultPath, targetName);
      const sourceBytes = Buffer.from("exact socket source", "utf8");
      await fs.writeFile(sourcePath, sourceBytes);
      const socket = await createNamespaceSocket(targetPath);
      try {
        const kernel = await openKernel();
        const source = await kernel.readBinary(sourceName, 1024);
        if (source.status !== "ready") throw new Error("Expected binary fixture.");

        await expect(
          kernel.renameFile(sourceName, targetName, source.snapshot.revision, undefined, {
            strictContainment: true,
          }),
        ).resolves.toMatchObject({ status: "conflict", reason: "target-normalized-exists" });
        await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBytes);
        expect((await fs.lstat(targetPath)).isSocket()).toBe(true);
        await expectNoAttachmentPublicationArtifacts(kernel);
      } finally {
        await closeNamespaceSocket(socket);
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "keeps an exact symlink target on the strict containment-unavailable path",
    async () => {
      const cases: Array<{ kind: NamespaceClaimantKind; name: string }> = [
        { kind: "contained-directory-symlink", name: "contained directory" },
        { kind: "dangling-symlink", name: "dangling" },
        { kind: "outside-symlink", name: "outside" },
      ];
      for (const [index, testCase] of cases.entries()) {
        const sourceName = `Exact symlink source ${index}.bin`;
        const targetName = `Exact symlink target ${index}.bin`;
        const sourcePath = path.join(vaultPath, sourceName);
        const targetPath = path.join(vaultPath, targetName);
        const sourceBytes = Buffer.from(`exact symlink:${testCase.name}`, "utf8");
        await fs.writeFile(sourcePath, sourceBytes);
        await createNamespaceClaimant(targetPath, testCase.kind, `exact-symlink-${index}`);
        const kernel = await openKernel();
        const source = await kernel.readBinary(sourceName, 1024);
        if (source.status !== "ready") throw new Error("Expected binary fixture.");

        await expect(
          kernel.renameFile(sourceName, targetName, source.snapshot.revision, undefined, {
            strictContainment: true,
          }),
        ).resolves.toMatchObject({ status: "conflict", reason: "attachment-publish-unavailable" });
        await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBytes);
        expect((await fs.lstat(targetPath)).isSymbolicLink()).toBe(true);
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "treats exact, case, and NFC-equivalent target folders as strict direct-publication claimants",
    async () => {
      const cases = [
        { target: "Archive/Exact folder.bin", claimant: "Archive/Exact folder.bin" },
        { target: "Archive/Case folder.bin", claimant: "archive/case FOLDER.BIN" },
        { target: "Archive/Caf\u00e9 folder.bin", claimant: "Archive/Cafe\u0301 folder.bin" },
      ];
      for (const [index, testCase] of cases.entries()) {
        const sourcePath = path.join(vaultPath, `Folder source ${index}.bin`);
        const targetPath = path.join(vaultPath, testCase.target);
        const claimantPath = path.join(vaultPath, testCase.claimant);
        const sourceBytes = Buffer.from(`source:${testCase.target}`, "utf8");
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.mkdir(path.dirname(claimantPath), { recursive: true });
        await fs.mkdir(claimantPath);
        await fs.writeFile(sourcePath, sourceBytes);
        const kernel = await openKernel();
        const source = await kernel.readBinary(path.basename(sourcePath), 1024);
        if (source.status !== "ready") throw new Error("Expected binary fixture.");

        await expect(
          kernel.renameFile(
            path.basename(sourcePath),
            testCase.target,
            source.snapshot.revision,
            undefined,
            {
              strictContainment: true,
            },
          ),
        ).resolves.toMatchObject({ status: "conflict", reason: "target-normalized-exists" });
        await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBytes);
        expect((await fs.stat(claimantPath)).isDirectory()).toBe(true);
        if (testCase.claimant !== testCase.target) {
          await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
        }
        await expectNoAttachmentPublicationArtifacts(kernel);
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "rejects case and NFC-equivalent strict target claimants at the final pre-publication barrier",
    async () => {
      const cases = [
        { source: "Case source.bin", target: "Report copy.bin", claimant: "REPORT COPY.BIN" },
        { source: "Nfc source.bin", target: "Caf\u00e9 copy.bin", claimant: "Cafe\u0301 copy.bin" },
        {
          source: "Ancestor source.bin",
          target: "Archive/Report copy.bin",
          claimant: "archive/report COPY.BIN",
        },
      ];
      for (const testCase of cases) {
        const sourcePath = path.join(vaultPath, testCase.source);
        const targetPath = path.join(vaultPath, testCase.target);
        const claimantPath = path.join(vaultPath, testCase.claimant);
        const sourceBytes = Buffer.from(`source:${testCase.source}`, "utf8");
        const claimantBytes = Buffer.from(`claimant:${testCase.claimant}`, "utf8");
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.mkdir(path.dirname(claimantPath), { recursive: true });
        await fs.writeFile(sourcePath, sourceBytes);
        const kernel = await openKernel(async (point) => {
          if (point === "rename:before-publish") await fs.writeFile(claimantPath, claimantBytes);
        });
        const source = await kernel.readBinary(testCase.source, 1024);
        if (source.status !== "ready") throw new Error("Expected binary fixture.");

        await expect(
          kernel.renameFile(testCase.source, testCase.target, source.snapshot.revision, undefined, {
            strictContainment: true,
          }),
        ).resolves.toMatchObject({ status: "conflict", reason: "target-normalized-exists" });
        await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBytes);
        await expect(fs.readFile(claimantPath)).resolves.toEqual(claimantBytes);
        await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "does not complete a strict publication when a case or NFC claimant arrives after linking",
    async () => {
      const cases = [
        { source: "Late case source.bin", target: "Late Report.bin", claimant: "late report.BIN" },
        {
          source: "Late nfc source.bin",
          target: "Th\u00e9orie.bin",
          claimant: "The\u0301orie.bin",
        },
        {
          source: "Late ancestor source.bin",
          target: "Archive/Late Report.bin",
          claimant: "archive/late report.BIN",
        },
      ];
      for (const testCase of cases) {
        const sourcePath = path.join(vaultPath, testCase.source);
        const targetPath = path.join(vaultPath, testCase.target);
        const claimantPath = path.join(vaultPath, testCase.claimant);
        const sourceBytes = Buffer.from(`source:${testCase.source}`, "utf8");
        const claimantBytes = Buffer.from(`claimant:${testCase.claimant}`, "utf8");
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.mkdir(path.dirname(claimantPath), { recursive: true });
        await fs.writeFile(sourcePath, sourceBytes);
        const kernel = await openKernel(async (point) => {
          if (point === "rename:after-link") await fs.writeFile(claimantPath, claimantBytes);
        });
        const source = await kernel.readBinary(testCase.source, 1024);
        if (source.status !== "ready") throw new Error("Expected binary fixture.");

        await expect(
          kernel.renameFile(testCase.source, testCase.target, source.snapshot.revision, undefined, {
            strictContainment: true,
          }),
        ).resolves.toMatchObject({ status: "conflict", reason: "target-normalized-exists" });
        await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBytes);
        await expect(fs.readFile(targetPath)).resolves.toEqual(sourceBytes);
        await expect(fs.readFile(claimantPath)).resolves.toEqual(claimantBytes);
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "keeps a separate-process source winner at the snapshot barrier",
    async () => {
      const sourcePath = path.join(vaultPath, "Snapshot.bin");
      const targetPath = path.join(vaultPath, "Snapshot-copy.bin");
      const bytes = Buffer.from("snapshot source");
      await fs.writeFile(sourcePath, bytes);
      const kernel = await openKernel(async (point) => {
        if (point === "rename:after-source-check") {
          await replaceFromSeparateProcess(sourcePath, Buffer.from("separate source winner"));
        }
      });
      const source = await kernel.readBinary("Snapshot.bin", 1024);
      if (source.status !== "ready") throw new Error("Expected binary fixture.");

      const result = await kernel.renameFile(
        "Snapshot.bin",
        "Snapshot-copy.bin",
        source.snapshot.revision,
        undefined,
        { strictContainment: true },
      );

      expect(result).toMatchObject({ status: "conflict", reason: "source-changed-during-publish" });
      await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("separate source winner");
      await expect(fs.readFile(targetPath)).resolves.toEqual(bytes);
    },
  );

  it.runIf(process.platform === "linux")(
    "keeps a separate-process target claimant at the stage barrier",
    async () => {
      const sourcePath = path.join(vaultPath, "Stage.bin");
      const targetPath = path.join(vaultPath, "Stage-copy.bin");
      const bytes = Buffer.from("stage source");
      await fs.writeFile(sourcePath, bytes);
      const kernel = await openKernel(async (point) => {
        if (point === "rename:before-publish") {
          await replaceFromSeparateProcess(targetPath, Buffer.from("separate target winner"));
        }
      });
      const source = await kernel.readBinary("Stage.bin", 1024);
      if (source.status !== "ready") throw new Error("Expected binary fixture.");

      const result = await kernel.renameFile(
        "Stage.bin",
        "Stage-copy.bin",
        source.snapshot.revision,
        undefined,
        { strictContainment: true },
      );

      expect(result).toMatchObject({ status: "conflict", reason: "target-created" });
      await expect(fs.readFile(sourcePath)).resolves.toEqual(bytes);
      await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("separate target winner");
    },
  );

  it.runIf(process.platform === "linux")(
    "keeps a separate-process target winner at the publish receipt barrier",
    async () => {
      const sourcePath = path.join(vaultPath, "Publish.bin");
      const targetPath = path.join(vaultPath, "Publish-copy.bin");
      const bytes = Buffer.from("publish source");
      await fs.writeFile(sourcePath, bytes);
      const kernel = await openKernel(async (point) => {
        if (point === "rename:after-publish") {
          await replaceFromSeparateProcess(targetPath, Buffer.from("separate publish winner"));
        }
      });
      const source = await kernel.readBinary("Publish.bin", 1024);
      if (source.status !== "ready") throw new Error("Expected binary fixture.");

      const result = await kernel.renameFile(
        "Publish.bin",
        "Publish-copy.bin",
        source.snapshot.revision,
        undefined,
        { strictContainment: true },
      );

      expect(result).toMatchObject({ status: "conflict", reason: "source-changed-during-publish" });
      await expect(fs.readFile(sourcePath)).resolves.toEqual(bytes);
      await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("separate publish winner");
    },
  );

  it("does not alias the source inode when the destination is edited after creation", async () => {
    const sourcePath = path.join(vaultPath, "Before.md");
    const targetPath = path.join(vaultPath, "After.md");
    await fs.writeFile(sourcePath, "source", "utf8");
    const kernel = await openKernel(async (point) => {
      if (point === "rename:after-link") {
        await fs.writeFile(targetPath, "external target", "utf8");
      }
    });
    const source = await kernel.readText("Before.md");

    const result = await kernel.renameFile("Before.md", "After.md", source.revision);

    expect(result).toMatchObject({ status: "conflict" });
    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("source");
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("external target");
  });

  it.runIf(process.platform === "linux")(
    "preserves an atomic source replacement before the strict claim",
    async () => {
      const sourcePath = path.join(vaultPath, "Before.md");
      const targetPath = path.join(vaultPath, "After.md");
      await fs.writeFile(sourcePath, "source", "utf8");
      const kernel = await openKernel(async (point) => {
        if (point !== "rename:after-source-check") return;
        const replacement = `${sourcePath}.${randomUUID()}.replacement`;
        await fs.writeFile(replacement, "external source winner", "utf8");
        await fs.rename(replacement, sourcePath);
      });
      const source = await kernel.readText("Before.md");

      const result = await kernel.renameFile("Before.md", "After.md", source.revision, undefined, {
        strictContainment: true,
      });

      expect(result).toMatchObject({ status: "conflict", reason: "source-changed-during-publish" });
      await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("external source winner");
      await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("source");
      await expect(
        fs
          .readdir(vaultPath)
          .then((entries) => entries.filter((entry) => entry.startsWith(".threadleaf-claim-"))),
      ).resolves.toEqual([]);
    },
  );

  it.runIf(process.platform === "linux")(
    "preserves an atomic source replacement after the strict claim",
    async () => {
      const sourcePath = path.join(vaultPath, "Before.md");
      const targetPath = path.join(vaultPath, "After.md");
      await fs.writeFile(sourcePath, "source", "utf8");
      const kernel = await openKernel(async (point) => {
        if (point !== "rename:after-source-claim") return;
        const replacement = `${sourcePath}.${randomUUID()}.replacement`;
        await fs.writeFile(replacement, "external source winner", "utf8");
        await fs.rename(replacement, sourcePath);
      });
      const source = await kernel.readText("Before.md");

      const result = await kernel.renameFile("Before.md", "After.md", source.revision, undefined, {
        strictContainment: true,
      });

      expect(result).toMatchObject({ status: "conflict", reason: "source-changed-during-publish" });
      await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("external source winner");
      await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("source");
      await expect(
        fs
          .readdir(vaultPath)
          .then((entries) => entries.filter((entry) => entry.startsWith(".threadleaf-claim-"))),
      ).resolves.toEqual([]);
    },
  );

  it("keeps an external destination created after durable staging", async () => {
    const sourcePath = path.join(vaultPath, "Before.md");
    const targetPath = path.join(vaultPath, "After.md");
    await fs.writeFile(sourcePath, "source", "utf8");
    const kernel = await openKernel(async (point) => {
      if (point === "rename:after-stage") {
        await fs.writeFile(targetPath, "external target", "utf8");
      }
    });
    const source = await kernel.readText("Before.md");

    const result = await kernel.renameFile("Before.md", "After.md", source.revision);

    expect(result).toMatchObject({ status: "conflict", reason: "target-created" });
    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("source");
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("external target");
  });

  it.runIf(process.platform === "linux")(
    "fails closed when a destination parent is replaced by a symlink",
    async () => {
      const sourcePath = path.join(vaultPath, "Before.md");
      const targetDirectory = path.join(vaultPath, "Archive");
      const outsideDirectory = path.join(sandboxPath, "outside");
      await fs.mkdir(targetDirectory);
      await fs.mkdir(outsideDirectory);
      await fs.writeFile(sourcePath, "source", "utf8");
      const kernel = await openKernel(async (point) => {
        if (point === "rename:after-intent") {
          await fs.rm(targetDirectory, { recursive: true, force: true });
          await fs.symlink(outsideDirectory, targetDirectory, "dir");
        }
      });
      const source = await kernel.readText("Before.md");

      await expect(
        kernel.renameFile("Before.md", "Archive/After.md", source.revision, undefined, {
          strictContainment: true,
        }),
      ).rejects.toThrow();
      await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("source");
      await expect(fs.stat(path.join(outsideDirectory, "After.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      const recovered = await openKernel();
      expect(recovered.startupRecoveryActions.at(-1)).toMatchObject({
        kind: "rename",
        outcome: "manual-conflict",
        path: "Archive/After.md",
      });
      await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("source");
      await expect(fs.stat(path.join(outsideDirectory, "After.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.runIf(process.platform === "linux")(
    "does not create through a parent or ancestor swapped at the install window",
    async () => {
      const sourcePath = path.join(vaultPath, "Before.md");
      const targetDirectory = path.join(vaultPath, "Archive", "Nested");
      const outsideDirectory = path.join(sandboxPath, "outside");
      await fs.mkdir(targetDirectory, { recursive: true });
      await fs.mkdir(outsideDirectory);
      await fs.writeFile(sourcePath, "source", "utf8");
      const kernel = await openKernel(async (point) => {
        if (point !== "rename:before-install") return;
        await fs.rm(path.join(vaultPath, "Archive"), { recursive: true, force: true });
        await fs.symlink(outsideDirectory, path.join(vaultPath, "Archive"), "dir");
      });
      const source = await kernel.readText("Before.md");

      await expect(
        kernel.renameFile("Before.md", "Archive/Nested/After.md", source.revision, undefined, {
          strictContainment: true,
        }),
      ).resolves.toMatchObject({ status: "conflict", reason: "attachment-publish-unavailable" });
      await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("source");
      await expect(
        fs.stat(path.join(outsideDirectory, "Nested", "After.md")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.runIf(process.platform === "linux")(
    "does not follow a final destination symlink created at install",
    async () => {
      const sourcePath = path.join(vaultPath, "Before.md");
      const targetDirectory = path.join(vaultPath, "Archive");
      const outsidePath = path.join(sandboxPath, "outside.md");
      const targetPath = path.join(targetDirectory, "After.md");
      await fs.mkdir(targetDirectory);
      await fs.writeFile(sourcePath, "source", "utf8");
      await fs.writeFile(outsidePath, "outside", "utf8");
      const kernel = await openKernel(async (point) => {
        if (point !== "rename:before-install") return;
        await fs.symlink(outsidePath, targetPath);
      });
      const source = await kernel.readText("Before.md");

      const result = await kernel.renameFile(
        "Before.md",
        "Archive/After.md",
        source.revision,
        undefined,
        { strictContainment: true },
      );

      expect(result).toMatchObject({
        status: "conflict",
        reason: "attachment-publish-unavailable",
      });
      await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("source");
      await expect(fs.readFile(outsidePath, "utf8")).resolves.toBe("outside");
    },
  );

  it.runIf(process.platform === "linux")(
    "does not follow a source path replaced by an outside symlink",
    async () => {
      const sourcePath = path.join(vaultPath, "Before.md");
      const outsidePath = path.join(sandboxPath, "outside.md");
      await fs.writeFile(sourcePath, "source", "utf8");
      await fs.writeFile(outsidePath, "outside", "utf8");
      const kernel = await openKernel(async (point) => {
        if (point === "rename:after-stage") {
          await fs.unlink(sourcePath);
          await fs.symlink(outsidePath, sourcePath);
        }
      });
      const source = await kernel.readText("Before.md");

      await expect(
        kernel.renameFile("Before.md", "After.md", source.revision, undefined, {
          strictContainment: true,
        }),
      ).rejects.toThrow();
      await expect(fs.readFile(outsidePath, "utf8")).resolves.toBe("outside");
      await expect(fs.stat(path.join(vaultPath, "After.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      const recovered = await openKernel();
      expect(recovered.startupRecoveryActions.at(-1)).toMatchObject({
        kind: "rename",
        outcome: "manual-conflict",
        path: "After.md",
      });
      await expect(fs.readFile(outsidePath, "utf8")).resolves.toBe("outside");
    },
  );

  it("aborts an interrupted rename when the linked source is externally edited", async () => {
    const sourcePath = path.join(vaultPath, "Before.md");
    const targetPath = path.join(vaultPath, "After.md");
    await fs.writeFile(sourcePath, "base", "utf8");
    const kernel = await openKernel((point) => {
      if (point === "rename:after-link") {
        throw new Error("simulated interruption");
      }
    });
    const source = await kernel.readText("Before.md");
    await expect(kernel.renameFile("Before.md", "After.md", source.revision)).rejects.toThrow(
      "simulated interruption",
    );

    await fs.writeFile(sourcePath, "external edit", "utf8");
    const recovered = await openKernel();

    expect(recovered.startupRecoveryActions).toMatchObject([
      { kind: "rename", outcome: "manual-conflict", path: "After.md" },
    ]);
    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("external edit");
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("base");
  });

  it("keeps distinct source and target files after an interrupted rename", async () => {
    const sourcePath = path.join(vaultPath, "Before.md");
    const targetPath = path.join(vaultPath, "After.md");
    await fs.writeFile(sourcePath, "source", "utf8");
    const kernel = await openKernel((point) => {
      if (point === "rename:after-link") {
        throw new Error("simulated interruption");
      }
    });
    const source = await kernel.readText("Before.md");
    await expect(kernel.renameFile("Before.md", "After.md", source.revision)).rejects.toThrow(
      "simulated interruption",
    );

    await fs.unlink(targetPath);
    await fs.writeFile(targetPath, "external target", "utf8");
    const recovered = await openKernel();

    expect(recovered.startupRecoveryActions).toMatchObject([
      { kind: "rename", outcome: "manual-conflict", path: "After.md" },
    ]);
    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("source");
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("external target");
  });

  it("archives an unrecoverable rename so it does not repeat at every startup", async () => {
    const sourcePath = path.join(vaultPath, "Before.md");
    await fs.writeFile(sourcePath, "source", "utf8");
    const kernel = await openKernel((point) => {
      if (point === "rename:after-intent") {
        throw new Error("simulated interruption");
      }
    });
    const source = await kernel.readText("Before.md");
    await expect(kernel.renameFile("Before.md", "After.md", source.revision)).rejects.toThrow(
      "simulated interruption",
    );
    await fs.unlink(sourcePath);

    const recovered = await openKernel();
    expect(recovered.startupRecoveryActions).toMatchObject([
      { kind: "rename", outcome: "manual-conflict", path: "After.md" },
    ]);
    const reopened = await openKernel();
    expect(reopened.startupRecoveryActions).toEqual([]);
  });
});

describe("VaultKernel multi-write transactions", () => {
  it("commits updates and creates as one journaled roll-forward operation", async () => {
    await fs.writeFile(path.join(vaultPath, "A.md"), "old a", "utf8");
    const kernel = await openKernel();
    const beforeA = await kernel.readText("A.md");

    const result = await kernel.writeMany([
      { path: "A.md", content: "new a", expectedRevision: beforeA.revision },
      { path: "Folder/B.md", content: "new b", expectedRevision: null },
    ]);

    expect(result).toMatchObject({
      status: "committed",
      entries: [
        { status: "committed", path: "A.md" },
        { status: "committed", path: "Folder/B.md" },
      ],
    });
    await expect(kernel.readText("A.md")).resolves.toMatchObject({ content: "new a" });
    await expect(kernel.readText("Folder/B.md")).resolves.toMatchObject({ content: "new b" });
    await expect(
      fs.readFile(
        path.join(kernel.stateRoot, "transactions", result.transactionId, "0.next"),
        "utf8",
      ),
    ).resolves.toBe("new a");
  });

  it("commits safe entries and preserves a stale proposal as a conflict copy", async () => {
    await fs.writeFile(path.join(vaultPath, "A.md"), "old a", "utf8");
    await fs.writeFile(path.join(vaultPath, "B.md"), "old b", "utf8");
    const kernel = await openKernel();
    const [beforeA, beforeB] = await Promise.all([
      kernel.readText("A.md"),
      kernel.readText("B.md"),
    ]);
    await fs.writeFile(path.join(vaultPath, "B.md"), "external b", "utf8");

    const result = await kernel.writeMany([
      { path: "A.md", content: "new a", expectedRevision: beforeA.revision },
      { path: "B.md", content: "proposed b", expectedRevision: beforeB.revision },
    ]);

    expect(result.status).toBe("conflict");
    await expect(kernel.readText("A.md")).resolves.toMatchObject({ content: "new a" });
    await expect(kernel.readText("B.md")).resolves.toMatchObject({ content: "external b" });
    const conflict = result.entries.find((entry) => entry.status === "conflict");
    expect(conflict).toMatchObject({ status: "conflict", path: "B.md" });
    if (conflict?.status === "conflict") {
      await expect(kernel.readText(conflict.conflictPath)).resolves.toMatchObject({
        content: "proposed b",
      });
    }
  });

  it("rolls forward every pending entry after interruption at transaction intent", async () => {
    await fs.writeFile(path.join(vaultPath, "A.md"), "old a", "utf8");
    await fs.writeFile(path.join(vaultPath, "B.md"), "old b", "utf8");
    const kernel = await openKernel((point) => {
      if (point === "multi-write:after-intent") {
        throw new Error("simulated multi-write interruption");
      }
    });
    const [beforeA, beforeB] = await Promise.all([
      kernel.readText("A.md"),
      kernel.readText("B.md"),
    ]);
    await expect(
      kernel.writeMany([
        { path: "A.md", content: "new a", expectedRevision: beforeA.revision },
        { path: "B.md", content: "new b", expectedRevision: beforeB.revision },
      ]),
    ).rejects.toThrow("simulated multi-write interruption");

    const recovered = await openKernel();

    expect(recovered.startupRecoveryActions).toMatchObject([
      {
        kind: "multi-write",
        outcome: "committed",
        paths: ["A.md", "B.md"],
      },
    ]);
    await expect(recovered.readText("A.md")).resolves.toMatchObject({ content: "new a" });
    await expect(recovered.readText("B.md")).resolves.toMatchObject({ content: "new b" });
  });

  it("resumes after one child committed but parent progress was interrupted", async () => {
    await fs.writeFile(path.join(vaultPath, "A.md"), "old a", "utf8");
    await fs.writeFile(path.join(vaultPath, "B.md"), "old b", "utf8");
    let completedEntries = 0;
    const kernel = await openKernel((point) => {
      if (point === "multi-write:after-entry" && completedEntries++ === 0) {
        throw new Error("simulated progress interruption");
      }
    });
    const [beforeA, beforeB] = await Promise.all([
      kernel.readText("A.md"),
      kernel.readText("B.md"),
    ]);
    await expect(
      kernel.writeMany([
        { path: "A.md", content: "new a", expectedRevision: beforeA.revision },
        { path: "B.md", content: "new b", expectedRevision: beforeB.revision },
      ]),
    ).rejects.toThrow("simulated progress interruption");
    await expect(fs.readFile(path.join(vaultPath, "A.md"), "utf8")).resolves.toBe("new a");
    await expect(fs.readFile(path.join(vaultPath, "B.md"), "utf8")).resolves.toBe("old b");

    const recovered = await openKernel();

    expect(recovered.startupRecoveryActions).toMatchObject([
      { kind: "multi-write", outcome: "committed", paths: ["A.md", "B.md"] },
    ]);
    await expect(recovered.readText("A.md")).resolves.toMatchObject({ content: "new a" });
    await expect(recovered.readText("B.md")).resolves.toMatchObject({ content: "new b" });
  });

  it("finalizes a transaction interrupted after every entry committed", async () => {
    await fs.writeFile(path.join(vaultPath, "A.md"), "old a", "utf8");
    const kernel = await openKernel((point) => {
      if (point === "multi-write:after-commit") {
        throw new Error("simulated finalization interruption");
      }
    });
    const before = await kernel.readText("A.md");
    await expect(
      kernel.writeMany([{ path: "A.md", content: "new a", expectedRevision: before.revision }]),
    ).rejects.toThrow("simulated finalization interruption");

    const recovered = await openKernel();

    expect(recovered.startupRecoveryActions).toMatchObject([
      { kind: "multi-write", outcome: "committed", paths: ["A.md"] },
    ]);
    await expect(recovered.readText("A.md")).resolves.toMatchObject({ content: "new a" });
  });

  it("preserves an external edit that arrives before roll-forward recovery", async () => {
    await fs.writeFile(path.join(vaultPath, "A.md"), "old a", "utf8");
    await fs.writeFile(path.join(vaultPath, "B.md"), "old b", "utf8");
    const kernel = await openKernel((point) => {
      if (point === "multi-write:after-intent") {
        throw new Error("simulated multi-write interruption");
      }
    });
    const [beforeA, beforeB] = await Promise.all([
      kernel.readText("A.md"),
      kernel.readText("B.md"),
    ]);
    await expect(
      kernel.writeMany([
        { path: "A.md", content: "new a", expectedRevision: beforeA.revision },
        { path: "B.md", content: "proposed b", expectedRevision: beforeB.revision },
      ]),
    ).rejects.toThrow("simulated multi-write interruption");
    await fs.writeFile(path.join(vaultPath, "B.md"), "external b", "utf8");

    const recovered = await openKernel();

    expect(recovered.startupRecoveryActions).toMatchObject([
      {
        kind: "multi-write",
        outcome: "conflict-copy",
        paths: ["A.md", "B.md"],
      },
    ]);
    await expect(recovered.readText("A.md")).resolves.toMatchObject({ content: "new a" });
    await expect(recovered.readText("B.md")).resolves.toMatchObject({ content: "external b" });
    const conflictPath = recovered.startupRecoveryActions[0]?.conflictPath;
    expect(conflictPath).toBeTypeOf("string");
    await expect(recovered.readText(conflictPath ?? "missing")).resolves.toMatchObject({
      content: "proposed b",
    });
  });

  it("recovers child journals before resuming their parent transaction", async () => {
    await fs.writeFile(path.join(vaultPath, "A.md"), "old a", "utf8");
    await fs.writeFile(path.join(vaultPath, "B.md"), "old b", "utf8");
    const kernel = await openKernel((point) => {
      if (point === "write:after-stage") {
        throw new Error("simulated child interruption");
      }
    });
    const [beforeA, beforeB] = await Promise.all([
      kernel.readText("A.md"),
      kernel.readText("B.md"),
    ]);
    await expect(
      kernel.writeMany([
        { path: "A.md", content: "new a", expectedRevision: beforeA.revision },
        { path: "B.md", content: "new b", expectedRevision: beforeB.revision },
      ]),
    ).rejects.toThrow("simulated child interruption");

    const recovered = await openKernel();

    expect(recovered.startupRecoveryActions.map((action) => action.kind)).toEqual([
      "write",
      "multi-write",
    ]);
    await expect(recovered.readText("A.md")).resolves.toMatchObject({ content: "new a" });
    await expect(recovered.readText("B.md")).resolves.toMatchObject({ content: "new b" });
  });

  it("blocks recovery before applying anything when a pending proposal blob is missing", async () => {
    await fs.writeFile(path.join(vaultPath, "A.md"), "old a", "utf8");
    await fs.writeFile(path.join(vaultPath, "B.md"), "old b", "utf8");
    const kernel = await openKernel((point) => {
      if (point === "write:after-stage") {
        throw new Error("simulated child interruption");
      }
    });
    const [beforeA, beforeB] = await Promise.all([
      kernel.readText("A.md"),
      kernel.readText("B.md"),
    ]);
    await expect(
      kernel.writeMany([
        { path: "A.md", content: "new a", expectedRevision: beforeA.revision },
        { path: "B.md", content: "new b", expectedRevision: beforeB.revision },
      ]),
    ).rejects.toThrow("simulated child interruption");
    const journalDirectory = path.join(kernel.stateRoot, "journal");
    const journalNames = await fs.readdir(journalDirectory);
    let transactionId: string | undefined;
    for (const journalName of journalNames) {
      const journal = JSON.parse(
        await fs.readFile(path.join(journalDirectory, journalName), "utf8"),
      ) as {
        kind?: unknown;
      };
      if (journal.kind === "multi-write") {
        transactionId = journalName.replace(/\.json$/, "");
      }
    }
    expect(transactionId).toBeTypeOf("string");
    await fs.unlink(
      path.join(kernel.stateRoot, "transactions", transactionId ?? "missing", "1.next"),
    );

    await expect(openKernel()).rejects.toBeInstanceOf(VaultRecoveryError);
    await expect(fs.readFile(path.join(vaultPath, "A.md"), "utf8")).resolves.toBe("old a");
    await expect(fs.readFile(path.join(vaultPath, "B.md"), "utf8")).resolves.toBe("old b");
    expect(await fs.readdir(path.join(kernel.stateRoot, "history"))).toEqual([]);
  });

  it("rejects empty, duplicate, and malformed requests before creating a journal", async () => {
    const kernel = await openKernel();

    await expect(kernel.writeMany([])).rejects.toThrow("at least one file");
    await expect(
      kernel.writeMany([
        { path: "A.md", content: "one", expectedRevision: null },
        { path: "./A.md", content: "two", expectedRevision: null },
      ]),
    ).rejects.toThrow("cannot target a path twice");
    await expect(
      kernel.writeMany([{ path: "A.md", content: "one", expectedRevision: "not-a-revision" }]),
    ).rejects.toThrow("lowercase SHA-256");
    expect(await fs.readdir(path.join(kernel.stateRoot, "journal"))).toEqual([]);
  });
});

describe("VaultKernel compound move transactions", () => {
  async function prepareFixture(kernel: VaultKernel) {
    const [source, linkerA, linkerB] = await Promise.all([
      kernel.readText("Source.md"),
      kernel.readText("A.md"),
      kernel.readText("B.md"),
    ]);
    return {
      sourcePath: "Source.md",
      targetPath: "Renamed.md",
      expectedSourceRevision: source.revision,
      writes: [
        { path: "A.md", content: "[[Renamed]]", expectedRevision: linkerA.revision },
        { path: "B.md", content: "[renamed](./Renamed.md)", expectedRevision: linkerB.revision },
      ],
    };
  }

  async function seedFixture(): Promise<void> {
    await fs.writeFile(path.join(vaultPath, "Source.md"), "# Source", "utf8");
    await fs.writeFile(path.join(vaultPath, "A.md"), "[[Source]]", "utf8");
    await fs.writeFile(path.join(vaultPath, "B.md"), "[source](./Source.md)", "utf8");
  }

  it("commits every validated rewrite and the rename under one parent transaction", async () => {
    await seedFixture();
    const kernel = await openKernel();
    const result = await kernel.moveWithWrites(await prepareFixture(kernel));

    expect(result).toMatchObject({
      status: "committed",
      from: "Source.md",
      to: "Renamed.md",
      writes: [
        { path: "A.md", revision: expect.stringMatching(/^[a-f0-9]{64}$/) },
        { path: "B.md", revision: expect.stringMatching(/^[a-f0-9]{64}$/) },
      ],
    });
    await expect(kernel.readText("A.md")).resolves.toMatchObject({ content: "[[Renamed]]" });
    await expect(kernel.readText("B.md")).resolves.toMatchObject({
      content: "[renamed](./Renamed.md)",
    });
    await expect(kernel.readText("Renamed.md")).resolves.toMatchObject({ content: "# Source" });
    await expect(kernel.readText("Source.md")).rejects.toThrow();
    if (result.status !== "committed") {
      throw new Error("Expected the compound move fixture to commit.");
    }
    await expect(
      fs.readFile(
        path.join(kernel.stateRoot, "transactions", result.transactionId, "0.before"),
        "utf8",
      ),
    ).resolves.toBe("[[Source]]");
    await expect(
      fs.readFile(
        path.join(kernel.stateRoot, "transactions", result.transactionId, "0.next"),
        "utf8",
      ),
    ).resolves.toBe("[[Renamed]]");
  });

  it.runIf(process.platform === "linux")(
    "cleans private rollback claims after a source-retained compound receipt",
    async () => {
      await seedFixture();
      const kernel = await openKernel();
      const result = await kernel.moveWithWrites({
        ...(await prepareFixture(kernel)),
        strictContainment: true,
      });

      expect(result.status).toBe("published-source-retained");
      await expect(
        fs.readdir(path.join(kernel.stateRoot, "recovery", "rollback-claims")),
      ).resolves.toEqual([]);
      await expect(fs.readFile(path.join(vaultPath, "Source.md"), "utf8")).resolves.toBe(
        "# Source",
      );
      await expect(fs.readFile(path.join(vaultPath, "Renamed.md"), "utf8")).resolves.toBe(
        "# Source",
      );
      await expect(
        fs
          .readdir(vaultPath)
          .then((entries) => entries.filter((entry) => entry.startsWith(".threadleaf-"))),
      ).resolves.toEqual([]);
    },
  );

  it.runIf(process.platform === "linux")(
    "refuses a rewrite-bearing strict publication with an absent target parent before journaling",
    async () => {
      const sourcePath = path.join(vaultPath, "Source.bin");
      const notePath = path.join(vaultPath, "Note.md");
      const targetPath = path.join(vaultPath, "Archive", "Source copy.bin");
      const sourceBytes = Buffer.from("source bytes");
      const noteBytes = "[source](./Source.bin)\n";
      await fs.writeFile(sourcePath, sourceBytes);
      await fs.writeFile(notePath, noteBytes, "utf8");
      const kernel = await openKernel();
      const [source, note] = await Promise.all([
        kernel.readBinary("Source.bin", 1024),
        kernel.readText("Note.md"),
      ]);
      if (source.status !== "ready") throw new Error("Expected binary fixture.");

      await expect(
        kernel.moveWithWrites({
          sourcePath: "Source.bin",
          targetPath: "Archive/Source copy.bin",
          expectedSourceRevision: source.snapshot.revision,
          writes: [
            {
              path: "Note.md",
              content: "[source](./Archive/Source%20copy.bin)\n",
              expectedRevision: note.revision,
            },
          ],
          strictContainment: true,
        }),
      ).resolves.toMatchObject({ status: "conflict", reason: "attachment-publish-unavailable" });
      await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBytes);
      await expect(fs.readFile(notePath, "utf8")).resolves.toBe(noteBytes);
      await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(path.join(vaultPath, "Archive"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expectNoAttachmentPublicationArtifacts(kernel);
    },
  );

  it.runIf(process.platform === "linux")(
    "fails an exact target-directory anonymous publication probe before rewrite-bearing transaction evidence",
    async () => {
      const sourcePath = path.join(vaultPath, "Probe source.bin");
      const notePath = path.join(vaultPath, "Probe note.md");
      const targetPath = path.join(vaultPath, "Probe target.bin");
      const sourceBytes = Buffer.from("rewrite-bearing target probe source");
      const noteBytes = "[source](./Probe%20source.bin)\n";
      await fs.writeFile(sourcePath, sourceBytes);
      await fs.writeFile(notePath, noteBytes, "utf8");
      const kernel = await openKernel();
      expect(kernel.attachmentPublishCapability).toMatchObject({ status: "supported" });
      const [source, note] = await Promise.all([
        kernel.readBinary("Probe source.bin", 1024),
        kernel.readText("Probe note.md"),
      ]);
      if (source.status !== "ready") throw new Error("Expected binary fixture.");
      const probe = vi
        .spyOn(nativeFilesystemPublishTestSeam, "probeAnonymousPublishNoName")
        .mockImplementation(() => {
          throw new nativeFilesystem.NativeFilesystemError(
            "unsupported",
            "injected rewrite-bearing target anonymous probe failure",
          );
        });
      const publish = vi.spyOn(nativeFilesystem, "publishBufferNoReplace");
      try {
        await expect(
          kernel.moveWithWrites({
            sourcePath: "Probe source.bin",
            targetPath: "Probe target.bin",
            expectedSourceRevision: source.snapshot.revision,
            writes: [
              {
                path: "Probe note.md",
                content: "[source](./Probe%20target.bin)\n",
                expectedRevision: note.revision,
              },
            ],
            strictContainment: true,
          }),
        ).resolves.toMatchObject({
          status: "conflict",
          reason: "attachment-publish-unavailable",
        });
        expect(probe).toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
        await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBytes);
        await expect(fs.readFile(notePath, "utf8")).resolves.toBe(noteBytes);
        await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expectNoAttachmentPublicationArtifacts(kernel);
      } finally {
        publish.mockRestore();
        probe.mockRestore();
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "keeps Markdown untouched and reports a typed conflict when the final rewrite-bearing native publish call fails",
    async () => {
      const sourcePath = path.join(vaultPath, "Late source.bin");
      const notePath = path.join(vaultPath, "Late note.md");
      const targetPath = path.join(vaultPath, "Late target.bin");
      const sourceBytes = Buffer.from("rewrite-bearing late native publish source");
      const noteBytes = "[source](./Late%20source.bin)\n";
      await fs.writeFile(sourcePath, sourceBytes);
      await fs.writeFile(notePath, noteBytes, "utf8");
      const kernel = await openKernel();
      expect(kernel.attachmentPublishCapability).toMatchObject({ status: "supported" });
      const [source, note] = await Promise.all([
        kernel.readBinary("Late source.bin", 1024),
        kernel.readText("Late note.md"),
      ]);
      if (source.status !== "ready") throw new Error("Expected binary fixture.");
      const publish = vi
        .spyOn(nativeFilesystem, "publishBufferNoReplace")
        .mockImplementation(() => {
          throw new nativeFilesystem.NativeFilesystemError(
            "unsupported",
            "injected final rewrite-bearing native publish failure",
          );
        });
      try {
        await expect(
          kernel.moveWithWrites({
            sourcePath: "Late source.bin",
            targetPath: "Late target.bin",
            expectedSourceRevision: source.snapshot.revision,
            writes: [
              {
                path: "Late note.md",
                content: "[source](./Late%20target.bin)\n",
                expectedRevision: note.revision,
              },
            ],
            strictContainment: true,
          }),
        ).resolves.toMatchObject({
          status: "conflict",
          reason: "attachment-publish-unavailable",
        });
        expect(publish).toHaveBeenCalled();
        await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBytes);
        await expect(fs.readFile(notePath, "utf8")).resolves.toBe(noteBytes);
        // This controlled replacement throws before native linkat, so its target is absent.
        await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
        const histories = await fs.readdir(path.join(kernel.stateRoot, "history"));
        expect(histories).toHaveLength(1);
        const historyName = histories[0];
        if (!historyName) throw new Error("late compound publication history is missing");
        await expect(
          fs
            .readFile(path.join(kernel.stateRoot, "history", historyName), "utf8")
            .then((contents) => JSON.parse(contents)),
        ).resolves.toMatchObject({
          kind: "move-with-writes",
          outcome: "manual-conflict",
          reason: "attachment-publish-unavailable",
        });
        const transactionId = path.basename(historyName, ".json");
        await expect(
          fs.readFile(path.join(kernel.stateRoot, "transactions", transactionId, "rename-source")),
        ).resolves.toEqual(sourceBytes);
        await expect(
          fs.readFile(path.join(kernel.stateRoot, "recovery", `${transactionId}.before`)),
        ).resolves.toEqual(sourceBytes);
      } finally {
        publish.mockRestore();
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "returns typed rewrite-bearing publication conflicts before any mutation when capabilities fail",
    async () => {
      const cases = [
        {
          name: "unsupported anonymous publication",
          capability: {
            status: "unsupported" as const,
            code: "anonymous-publication-unsupported" as const,
            contract: "FILE-PUBLISH-CAP-02" as const,
            detail: "injected unsupported capability",
          },
        },
        {
          name: "different destination device",
          capability: {
            status: "supported" as const,
            contract: "FILE-PUBLISH-CAP-02" as const,
            device: "injected-other-device",
          },
        },
      ];
      for (const testCase of cases) {
        const sourcePath = path.join(vaultPath, `${testCase.name}.bin`);
        const notePath = path.join(vaultPath, `${testCase.name}.md`);
        const targetPath = path.join(vaultPath, `${testCase.name} copy.bin`);
        const sourceBytes = Buffer.from(`source:${testCase.name}`, "utf8");
        const noteBytes = `[source](./${testCase.name}.bin)\n`;
        await fs.writeFile(sourcePath, sourceBytes);
        await fs.writeFile(notePath, noteBytes, "utf8");
        const kernel = await openKernel();
        injectAttachmentPublishCapability(kernel, testCase.capability);
        const [source, note] = await Promise.all([
          kernel.readBinary(path.basename(sourcePath), 1024),
          kernel.readText(path.basename(notePath)),
        ]);
        if (source.status !== "ready") throw new Error("Expected binary fixture.");

        await expect(
          kernel.moveWithWrites({
            sourcePath: path.basename(sourcePath),
            targetPath: path.basename(targetPath),
            expectedSourceRevision: source.snapshot.revision,
            writes: [
              {
                path: path.basename(notePath),
                content: `[source](./${path.basename(targetPath)})\n`,
                expectedRevision: note.revision,
              },
            ],
            strictContainment: true,
          }),
        ).resolves.toMatchObject({
          status: "conflict",
          reason: "attachment-publish-unavailable",
          conflictPaths: [],
        });
        await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBytes);
        await expect(fs.readFile(notePath, "utf8")).resolves.toBe(noteBytes);
        await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expectNoAttachmentPublicationArtifacts(kernel);
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "returns a typed rewrite-bearing strict publication conflict before mutations when capabilities fail",
    async () => {
      const sourcePath = path.join(vaultPath, "Source.bin");
      const notePath = path.join(vaultPath, "Note.md");
      const targetPath = path.join(vaultPath, "Source copy.bin");
      const sourceBytes = Buffer.from("source bytes");
      const noteBytes = "[source](./Source.bin)\n";
      await fs.writeFile(sourcePath, sourceBytes);
      await fs.writeFile(notePath, noteBytes, "utf8");
      const kernel = await openKernel();
      injectAttachmentPublishCapability(kernel, {
        status: "supported",
        contract: "FILE-PUBLISH-CAP-02",
        device: "injected-other-device",
      });
      const [source, note] = await Promise.all([
        kernel.readBinary("Source.bin", 1024),
        kernel.readText("Note.md"),
      ]);
      if (source.status !== "ready") throw new Error("Expected binary fixture.");

      await expect(
        kernel.moveWithWrites({
          sourcePath: "Source.bin",
          targetPath: "Source copy.bin",
          expectedSourceRevision: source.snapshot.revision,
          writes: [
            {
              path: "Note.md",
              content: "[source](./Source%20copy.bin)\n",
              expectedRevision: note.revision,
            },
          ],
          strictContainment: true,
        }),
      ).resolves.toMatchObject({ status: "conflict", reason: "attachment-publish-unavailable" });
      await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBytes);
      await expect(fs.readFile(notePath, "utf8")).resolves.toBe(noteBytes);
      await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expectNoAttachmentPublicationArtifacts(kernel);
    },
  );

  it.runIf(process.platform === "linux")(
    "rejects case and NFC-equivalent claimants at the rewrite-bearing pre-publication barrier",
    async () => {
      const cases = [
        { target: "Archive/Report copy.bin", claimant: "Archive/REPORT COPY.BIN" },
        { target: "Archive/Caf\u00e9 copy.bin", claimant: "Archive/Cafe\u0301 copy.bin" },
        { target: "Archive/Ancestor.bin", claimant: "archive/ancestor.BIN" },
      ];
      for (const testCase of cases) {
        const sourcePath = path.join(vaultPath, "Source.bin");
        const notePath = path.join(vaultPath, "Note.md");
        const targetPath = path.join(vaultPath, testCase.target);
        const claimantPath = path.join(vaultPath, testCase.claimant);
        const sourceBytes = Buffer.from(`source:${testCase.target}`, "utf8");
        const noteBytes = "[source](./Source.bin)\n";
        const claimantBytes = Buffer.from(`claimant:${testCase.claimant}`, "utf8");
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.mkdir(path.dirname(claimantPath), { recursive: true });
        await fs.writeFile(sourcePath, sourceBytes);
        await fs.writeFile(notePath, noteBytes, "utf8");
        const kernel = await openKernel(async (point) => {
          if (point === "move-with-writes:before-publish") {
            await fs.writeFile(claimantPath, claimantBytes);
          }
        });
        const [source, note] = await Promise.all([
          kernel.readBinary("Source.bin", 1024),
          kernel.readText("Note.md"),
        ]);
        if (source.status !== "ready") throw new Error("Expected binary fixture.");

        await expect(
          kernel.moveWithWrites({
            sourcePath: "Source.bin",
            targetPath: testCase.target,
            expectedSourceRevision: source.snapshot.revision,
            writes: [
              {
                path: "Note.md",
                content: "[source](./Archive/replaced.bin)\n",
                expectedRevision: note.revision,
              },
            ],
            strictContainment: true,
          }),
        ).resolves.toMatchObject({ status: "conflict", reason: "target-normalized-exists" });
        await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBytes);
        await expect(fs.readFile(notePath, "utf8")).resolves.toBe(noteBytes);
        await expect(fs.readFile(claimantPath)).resolves.toEqual(claimantBytes);
        await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "treats exact and NFC-equivalent target folders as strict rewrite-publication claimants",
    async () => {
      const cases = [
        {
          target: "Archive/Exact rewrite folder.bin",
          claimant: "Archive/Exact rewrite folder.bin",
        },
        {
          target: "Archive/Caf\u00e9 rewrite folder.bin",
          claimant: "Archive/Cafe\u0301 rewrite folder.bin",
        },
      ];
      for (const [index, testCase] of cases.entries()) {
        const sourcePath = path.join(vaultPath, `Folder rewrite source ${index}.bin`);
        const notePath = path.join(vaultPath, `Folder rewrite note ${index}.md`);
        const targetPath = path.join(vaultPath, testCase.target);
        const claimantPath = path.join(vaultPath, testCase.claimant);
        const sourceBytes = Buffer.from(`source:${testCase.target}`, "utf8");
        const noteBytes = `[source](./${path.basename(sourcePath)})\n`;
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.mkdir(path.dirname(claimantPath), { recursive: true });
        await fs.mkdir(claimantPath);
        await fs.writeFile(sourcePath, sourceBytes);
        await fs.writeFile(notePath, noteBytes, "utf8");
        const kernel = await openKernel();
        const [source, note] = await Promise.all([
          kernel.readBinary(path.basename(sourcePath), 1024),
          kernel.readText(path.basename(notePath)),
        ]);
        if (source.status !== "ready") throw new Error("Expected binary fixture.");

        await expect(
          kernel.moveWithWrites({
            sourcePath: path.basename(sourcePath),
            targetPath: testCase.target,
            expectedSourceRevision: source.snapshot.revision,
            writes: [
              {
                path: path.basename(notePath),
                content: "[source](./rewritten.bin)\n",
                expectedRevision: note.revision,
              },
            ],
            strictContainment: true,
          }),
        ).resolves.toMatchObject({ status: "conflict", reason: "target-normalized-exists" });
        await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBytes);
        await expect(fs.readFile(notePath, "utf8")).resolves.toBe(noteBytes);
        expect((await fs.stat(claimantPath)).isDirectory()).toBe(true);
        if (testCase.claimant !== testCase.target) {
          await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
        }
        await expectNoAttachmentPublicationArtifacts(kernel);
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "does not rewrite Markdown when a case or NFC claimant arrives after rewrite-bearing publication",
    async () => {
      const cases = [
        { target: "Archive/Late Report.bin", claimant: "Archive/late report.BIN" },
        { target: "Archive/Th\u00e9orie.bin", claimant: "Archive/The\u0301orie.bin" },
        { target: "Archive/Late Ancestor.bin", claimant: "archive/late ancestor.BIN" },
      ];
      for (const testCase of cases) {
        const sourcePath = path.join(vaultPath, "Source.bin");
        const notePath = path.join(vaultPath, "Note.md");
        const targetPath = path.join(vaultPath, testCase.target);
        const claimantPath = path.join(vaultPath, testCase.claimant);
        const sourceBytes = Buffer.from(`source:${testCase.target}`, "utf8");
        const noteBytes = "[source](./Source.bin)\n";
        const claimantBytes = Buffer.from(`claimant:${testCase.claimant}`, "utf8");
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.mkdir(path.dirname(claimantPath), { recursive: true });
        await fs.writeFile(sourcePath, sourceBytes);
        await fs.writeFile(notePath, noteBytes, "utf8");
        const kernel = await openKernel(async (point) => {
          if (point === "rename:after-link") await fs.writeFile(claimantPath, claimantBytes);
        });
        const [source, note] = await Promise.all([
          kernel.readBinary("Source.bin", 1024),
          kernel.readText("Note.md"),
        ]);
        if (source.status !== "ready") throw new Error("Expected binary fixture.");

        await expect(
          kernel.moveWithWrites({
            sourcePath: "Source.bin",
            targetPath: testCase.target,
            expectedSourceRevision: source.snapshot.revision,
            writes: [
              {
                path: "Note.md",
                content: "[source](./Archive/replaced.bin)\n",
                expectedRevision: note.revision,
              },
            ],
            strictContainment: true,
          }),
        ).resolves.toMatchObject({ status: "conflict", reason: "target-normalized-exists" });
        await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBytes);
        await expect(fs.readFile(targetPath)).resolves.toEqual(sourceBytes);
        await expect(fs.readFile(claimantPath)).resolves.toEqual(claimantBytes);
        await expect(fs.readFile(notePath, "utf8")).resolves.toBe(noteBytes);
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "rejects every lexical symlink alias before rewrite-bearing strict publication can mutate Markdown",
    async () => {
      const cases: Array<{ kind: NamespaceClaimantKind; name: string }> = [
        { kind: "contained-directory-symlink", name: "contained directory" },
        { kind: "dangling-symlink", name: "dangling" },
        { kind: "outside-symlink", name: "outside" },
      ];
      for (const [index, testCase] of cases.entries()) {
        const sourceName = `RewriteSource${index}.bin`;
        const targetName = `RewriteTarget${index}.bin`;
        const claimantName = `rewritetarget${index}.BIN`;
        const noteName = `RewriteNote${index}.md`;
        const sourcePath = path.join(vaultPath, sourceName);
        const targetPath = path.join(vaultPath, targetName);
        const claimantPath = path.join(vaultPath, claimantName);
        const notePath = path.join(vaultPath, noteName);
        const sourceBytes = Buffer.from(`rewrite source:${testCase.name}`, "utf8");
        const noteBytes = `[attachment](./${sourceName})\n`;
        const rewrittenNote = `[attachment](./${targetName})\n`;
        await fs.writeFile(sourcePath, sourceBytes);
        await fs.writeFile(notePath, noteBytes, "utf8");
        const kernel = await openKernel(async (point) => {
          if (point !== "move-with-writes:before-publish") return;
          await createNamespaceClaimant(claimantPath, testCase.kind, `rewrite-prepublish-${index}`);
        });
        const [source, note] = await Promise.all([
          kernel.readBinary(sourceName, 1024),
          kernel.readText(noteName),
        ]);
        if (source.status !== "ready") throw new Error("Expected binary fixture.");

        await expect(
          kernel.moveWithWrites({
            sourcePath: sourceName,
            targetPath: targetName,
            expectedSourceRevision: source.snapshot.revision,
            writes: [{ path: noteName, content: rewrittenNote, expectedRevision: note.revision }],
            strictContainment: true,
          }),
        ).resolves.toMatchObject({ status: "conflict", reason: "target-normalized-exists" });
        await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBytes);
        await expect(fs.readFile(notePath, "utf8")).resolves.toBe(noteBytes);
        expect((await fs.lstat(claimantPath)).isSymbolicLink()).toBe(true);
        await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "preserves attachment, lexical alias, target, and Markdown through rewrite-bearing post-publication recovery",
    async () => {
      const cases: Array<{ kind: NamespaceClaimantKind; name: string }> = [
        { kind: "contained-directory-symlink", name: "contained directory" },
        { kind: "dangling-symlink", name: "dangling" },
        { kind: "outside-symlink", name: "outside" },
      ];
      for (const [index, testCase] of cases.entries()) {
        const sourceName = `RewriteRecoverySource${index}.bin`;
        const targetName = `RewriteRecoveryTarget${index}.bin`;
        const claimantName = `rewriterecoverytarget${index}.BIN`;
        const noteName = `RewriteRecoveryNote${index}.md`;
        const sourcePath = path.join(vaultPath, sourceName);
        const targetPath = path.join(vaultPath, targetName);
        const claimantPath = path.join(vaultPath, claimantName);
        const notePath = path.join(vaultPath, noteName);
        const sourceBytes = Buffer.from(`rewrite recovery:${testCase.name}`, "utf8");
        const noteBytes = `[attachment](./${sourceName})\n`;
        const rewrittenNote = `[attachment](./${targetName})\n`;
        await fs.writeFile(sourcePath, sourceBytes);
        await fs.writeFile(notePath, noteBytes, "utf8");
        const interrupted = await openKernel(async (point) => {
          if (point !== "move-with-writes:after-publish") return;
          await createNamespaceClaimant(claimantPath, testCase.kind, `rewrite-recovery-${index}`);
          throw new Error(`interrupted rewrite namespace ${testCase.name}`);
        });
        const [source, note] = await Promise.all([
          interrupted.readBinary(sourceName, 1024),
          interrupted.readText(noteName),
        ]);
        if (source.status !== "ready") throw new Error("Expected binary fixture.");

        await expect(
          interrupted.moveWithWrites({
            sourcePath: sourceName,
            targetPath: targetName,
            expectedSourceRevision: source.snapshot.revision,
            writes: [{ path: noteName, content: rewrittenNote, expectedRevision: note.revision }],
            strictContainment: true,
          }),
        ).rejects.toThrow(`interrupted rewrite namespace ${testCase.name}`);
        await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBytes);
        await expect(fs.readFile(targetPath)).resolves.toEqual(sourceBytes);
        await expect(fs.readFile(notePath, "utf8")).resolves.toBe(noteBytes);
        expect((await fs.lstat(claimantPath)).isSymbolicLink()).toBe(true);

        const recovered = await openKernel();
        expect(recovered.startupRecoveryActions.at(-1)).toMatchObject({
          kind: "move-with-writes",
          outcome: "manual-conflict",
          path: sourceName,
        });
        await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBytes);
        await expect(fs.readFile(targetPath)).resolves.toEqual(sourceBytes);
        await expect(fs.readFile(notePath, "utf8")).resolves.toBe(noteBytes);
        expect((await fs.lstat(claimantPath)).isSymbolicLink()).toBe(true);
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "rolls Markdown back when an equivalent claimant arrives after rewrite-bearing publication",
    async () => {
      const sourcePath = path.join(vaultPath, "Source.bin");
      const notePath = path.join(vaultPath, "Note.md");
      const targetPath = path.join(vaultPath, "Archive", "After Markdown.bin");
      const claimantPath = path.join(vaultPath, "archive", "after markdown.BIN");
      const sourceBytes = Buffer.from("source bytes", "utf8");
      const claimantBytes = Buffer.from("external normalized claimant", "utf8");
      const noteBytes = "[source](./Source.bin)\n";
      const rewrittenNote = "[source](./Archive/After%20Markdown.bin)\n";
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.mkdir(path.dirname(claimantPath), { recursive: true });
      await fs.writeFile(sourcePath, sourceBytes);
      await fs.writeFile(notePath, noteBytes, "utf8");
      const kernel = await openKernel(async (point) => {
        if (point === "move-with-writes:before-rename") {
          await fs.writeFile(claimantPath, claimantBytes);
        }
      });
      const [source, note] = await Promise.all([
        kernel.readBinary("Source.bin", 1024),
        kernel.readText("Note.md"),
      ]);
      if (source.status !== "ready") throw new Error("Expected binary fixture.");

      await expect(
        kernel.moveWithWrites({
          sourcePath: "Source.bin",
          targetPath: "Archive/After Markdown.bin",
          expectedSourceRevision: source.snapshot.revision,
          writes: [
            {
              path: "Note.md",
              content: rewrittenNote,
              expectedRevision: note.revision,
            },
          ],
          strictContainment: true,
        }),
      ).resolves.toMatchObject({ status: "conflict", reason: "target-normalized-exists" });
      await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBytes);
      await expect(fs.readFile(targetPath)).resolves.toEqual(sourceBytes);
      await expect(fs.readFile(claimantPath)).resolves.toEqual(claimantBytes);
      await expect(fs.readFile(notePath, "utf8")).resolves.toBe(noteBytes);
    },
  );

  it.runIf(process.platform === "linux")(
    "keeps attachment evidence and untouched Markdown after a post-publication crash",
    async () => {
      const sourcePath = path.join(vaultPath, "Source.bin");
      const notePath = path.join(vaultPath, "Note.md");
      const targetPath = path.join(vaultPath, "Archive", "Published.bin");
      const claimantPath = path.join(vaultPath, "archive", "published.BIN");
      const sourceBytes = Buffer.from("source bytes", "utf8");
      const claimantBytes = Buffer.from("external normalized claimant", "utf8");
      const noteBytes = "[source](./Source.bin)\n";
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.mkdir(path.dirname(claimantPath), { recursive: true });
      await fs.writeFile(sourcePath, sourceBytes);
      await fs.writeFile(notePath, noteBytes, "utf8");
      const interrupted = await openKernel(async (point) => {
        if (point !== "move-with-writes:after-publish") return;
        await fs.writeFile(claimantPath, claimantBytes);
        throw new Error("interrupted after rewrite-bearing publish");
      });
      const [source, note] = await Promise.all([
        interrupted.readBinary("Source.bin", 1024),
        interrupted.readText("Note.md"),
      ]);
      if (source.status !== "ready") throw new Error("Expected binary fixture.");

      await expect(
        interrupted.moveWithWrites({
          sourcePath: "Source.bin",
          targetPath: "Archive/Published.bin",
          expectedSourceRevision: source.snapshot.revision,
          writes: [
            {
              path: "Note.md",
              content: "[source](./Archive/Published.bin)\n",
              expectedRevision: note.revision,
            },
          ],
          strictContainment: true,
        }),
      ).rejects.toThrow("interrupted after rewrite-bearing publish");

      const recovered = await openKernel();
      expect(recovered.startupRecoveryActions.at(-1)).toMatchObject({
        kind: "move-with-writes",
        outcome: "manual-conflict",
        path: "Source.bin",
      });
      await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBytes);
      await expect(fs.readFile(targetPath)).resolves.toEqual(sourceBytes);
      await expect(fs.readFile(claimantPath)).resolves.toEqual(claimantBytes);
      await expect(fs.readFile(notePath, "utf8")).resolves.toBe(noteBytes);
    },
  );

  it.runIf(process.platform === "linux")(
    "does not archive a committed source-retained move as success after attachment identity changes",
    async () => {
      const cases = [
        {
          name: "an altered exact target",
          mutate: async (targetPath: string, _claimantPath: string, _claimantBytes: Buffer) => {
            await fs.writeFile(targetPath, "external target", "utf8");
          },
          expectedTarget: "external target",
        },
        {
          name: "a missing exact target",
          mutate: async (targetPath: string, _claimantPath: string, _claimantBytes: Buffer) => {
            await fs.unlink(targetPath);
          },
          expectedTarget: null,
        },
        {
          name: "an equivalent claimant",
          mutate: async (_targetPath: string, claimantPath: string, claimantBytes: Buffer) => {
            await fs.writeFile(claimantPath, claimantBytes);
          },
          expectedTarget: "source bytes",
        },
      ];
      for (const testCase of cases) {
        const sourcePath = path.join(vaultPath, "Source.bin");
        const notePath = path.join(vaultPath, "Note.md");
        const targetPath = path.join(vaultPath, "Archive", "Committed.bin");
        const claimantPath = path.join(vaultPath, "archive", "committed.BIN");
        const sourceBytes = Buffer.from("source bytes", "utf8");
        const claimantBytes = Buffer.from(`claimant:${testCase.name}`, "utf8");
        const noteBytes = "[source](./Source.bin)\n";
        const rewrittenNote = "[source](./Archive/Committed.bin)\n";
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.mkdir(path.dirname(claimantPath), { recursive: true });
        await fs.writeFile(sourcePath, sourceBytes);
        await fs.writeFile(notePath, noteBytes, "utf8");
        const interrupted = await openKernel(async (point) => {
          if (point !== "move-with-writes:after-commit") return;
          await testCase.mutate(targetPath, claimantPath, claimantBytes);
          throw new Error(`interrupted after committed ${testCase.name}`);
        });
        const [source, note] = await Promise.all([
          interrupted.readBinary("Source.bin", 1024),
          interrupted.readText("Note.md"),
        ]);
        if (source.status !== "ready") throw new Error("Expected binary fixture.");

        await expect(
          interrupted.moveWithWrites({
            sourcePath: "Source.bin",
            targetPath: "Archive/Committed.bin",
            expectedSourceRevision: source.snapshot.revision,
            writes: [{ path: "Note.md", content: rewrittenNote, expectedRevision: note.revision }],
            strictContainment: true,
          }),
        ).rejects.toThrow(`interrupted after committed ${testCase.name}`);

        const recovered = await openKernel();
        expect(recovered.startupRecoveryActions.at(-1)).toMatchObject({
          kind: "move-with-writes",
          outcome: "manual-conflict",
          path: "Source.bin",
        });
        await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBytes);
        await expect(fs.readFile(notePath, "utf8")).resolves.toBe(rewrittenNote);
        if (testCase.expectedTarget === null) {
          await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          await expect(fs.readFile(targetPath, "utf8")).resolves.toBe(testCase.expectedTarget);
        }
        if (testCase.name === "an equivalent claimant") {
          await expect(fs.readFile(claimantPath)).resolves.toEqual(claimantBytes);
        }
        await fs.rm(path.join(vaultPath, "Archive"), { recursive: true, force: true });
        await fs.rm(path.join(vaultPath, "archive"), { recursive: true, force: true });
        await fs.unlink(sourcePath);
        await fs.unlink(notePath);
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "rejects cross-device rollback retention before publishing an attachment",
    async () => {
      const crossDeviceState = await fs.mkdtemp(path.join("/dev/shm", "threadleaf-state-"));
      try {
        const [vaultStat, stateStat] = await Promise.all([
          fs.stat(vaultPath),
          fs.stat(crossDeviceState),
        ]);
        if (vaultStat.dev === stateStat.dev) return;
        await seedFixture();
        const kernel = await VaultKernel.open({
          vaultRoot: vaultPath,
          stateRoot: new FixedStateRoot(crossDeviceState),
        });
        const request = { ...(await prepareFixture(kernel)), strictContainment: true };

        await expect(kernel.moveWithWrites(request)).resolves.toMatchObject({
          status: "conflict",
          reason: "attachment-publish-unavailable",
          conflictPaths: [],
        });
        await expect(fs.readFile(path.join(vaultPath, "Source.md"), "utf8")).resolves.toBe(
          "# Source",
        );
        await expect(fs.readFile(path.join(vaultPath, "A.md"), "utf8")).resolves.toBe("[[Source]]");
        await expect(fs.stat(path.join(vaultPath, "Renamed.md"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(
          fs
            .readdir(vaultPath)
            .then((entries) => entries.filter((entry) => entry.startsWith(".threadleaf-"))),
        ).resolves.toEqual([]);
        await expectNoAttachmentPublicationArtifacts(kernel);
      } finally {
        await fs.rm(crossDeviceState, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "preserves a strict rollback-name claimant during compound recovery",
    async () => {
      await seedFixture();
      let stateRoot = "";
      let afterPrepareCount = 0;
      const kernel = await openKernel(async (point) => {
        if (point === "move-with-writes:before-rename") {
          await fs.writeFile(path.join(vaultPath, "Renamed.md"), "external target", "utf8");
          return;
        }
        if (point !== "write:after-prepare" || ++afterPrepareCount !== 3) return;
        const journalEntries = await Promise.all(
          (await fs.readdir(path.join(stateRoot, "journal")))
            .filter((entry) => entry.endsWith(".json"))
            .map(
              async (entry) =>
                JSON.parse(await fs.readFile(path.join(stateRoot, "journal", entry), "utf8")) as {
                  kind?: unknown;
                  rollbackPath?: string;
                },
            ),
        );
        const journal = journalEntries.find(
          (entry): entry is { kind: "write"; rollbackPath: string } =>
            entry.kind === "write" && typeof entry.rollbackPath === "string",
        );
        if (!journal) throw new Error("rollback child journal was not present");
        await fs.writeFile(
          path.join(vaultPath, journal.rollbackPath),
          "external rollback claimant",
          "utf8",
        );
      });
      stateRoot = kernel.stateRoot;
      const request = { ...(await prepareFixture(kernel)), strictContainment: true };

      const result = await kernel.moveWithWrites(request);

      expect(result).toMatchObject({ status: "conflict" });
      const claimant = (await fs.readdir(path.join(vaultPath, ""))).find((entry) =>
        entry.startsWith(".threadleaf-rollback-"),
      );
      expect(claimant).toBeTypeOf("string");
      await expect(fs.readFile(path.join(vaultPath, claimant ?? "missing"), "utf8")).resolves.toBe(
        "external rollback claimant",
      );
      await expect(fs.readFile(path.join(vaultPath, "Renamed.md"), "utf8")).resolves.toBe(
        "external target",
      );
    },
  );

  it.each([
    "move-with-writes:after-intent",
    "move-with-writes:after-entry",
    "move-with-writes:before-rename",
    "move-with-writes:after-rename",
    "move-with-writes:after-commit",
  ] as const)(
    "recovers a coherent committed result after interruption at %s",
    async (faultPoint) => {
      await seedFixture();
      let entryFaults = 0;
      const kernel = await openKernel((point) => {
        if (
          point === faultPoint &&
          (point !== "move-with-writes:after-entry" || entryFaults++ === 0)
        ) {
          throw new Error(`interrupted at ${faultPoint}`);
        }
      });
      await expect(kernel.moveWithWrites(await prepareFixture(kernel))).rejects.toThrow(
        `interrupted at ${faultPoint}`,
      );

      const recovered = await openKernel();

      expect(recovered.startupRecoveryActions.at(-1)).toMatchObject({
        kind: "move-with-writes",
        outcome: "committed",
        path: "Renamed.md",
        paths: ["A.md", "B.md"],
      });
      await expect(recovered.readText("A.md")).resolves.toMatchObject({ content: "[[Renamed]]" });
      await expect(recovered.readText("B.md")).resolves.toMatchObject({
        content: "[renamed](./Renamed.md)",
      });
      await expect(recovered.readText("Renamed.md")).resolves.toMatchObject({
        content: "# Source",
      });
      await expect(recovered.readText("Source.md")).rejects.toThrow();
    },
  );

  it("recovers a child write journal before its compound parent", async () => {
    await seedFixture();
    const kernel = await openKernel((point) => {
      if (point === "write:after-stage") {
        throw new Error("interrupted child write");
      }
    });
    await expect(kernel.moveWithWrites(await prepareFixture(kernel))).rejects.toThrow(
      "interrupted child write",
    );

    const recovered = await openKernel();

    expect(recovered.startupRecoveryActions.map((action) => action.kind)).toEqual([
      "write",
      "move-with-writes",
    ]);
    await expect(recovered.readText("Renamed.md")).resolves.toMatchObject({
      content: "# Source",
    });
    await expect(recovered.readText("A.md")).resolves.toMatchObject({ content: "[[Renamed]]" });
    await expect(recovered.readText("B.md")).resolves.toMatchObject({
      content: "[renamed](./Renamed.md)",
    });
  });

  it("recovers a child rename journal before its compound parent", async () => {
    await seedFixture();
    const kernel = await openKernel((point) => {
      if (point === "rename:after-link") {
        throw new Error("interrupted child rename");
      }
    });
    await expect(kernel.moveWithWrites(await prepareFixture(kernel))).rejects.toThrow(
      "interrupted child rename",
    );

    const recovered = await openKernel();

    expect(recovered.startupRecoveryActions.map((action) => action.kind)).toEqual([
      "rename",
      "move-with-writes",
    ]);
    expect(recovered.startupRecoveryActions.at(-1)).toMatchObject({
      kind: "move-with-writes",
      outcome: "committed",
      path: "Renamed.md",
    });
    await expect(recovered.readText("Renamed.md")).resolves.toMatchObject({
      content: "# Source",
    });
    await expect(recovered.readText("Source.md")).rejects.toThrow();
    await expect(recovered.readText("A.md")).resolves.toMatchObject({ content: "[[Renamed]]" });
    await expect(recovered.readText("B.md")).resolves.toMatchObject({
      content: "[renamed](./Renamed.md)",
    });
  });

  it.each([
    ["B/A", "original"],
    ["B/C", "external-target"],
    ["B/missing", "missing"],
  ] as const)(
    "archives manual recovery without repointing Markdown for a %s rename topology",
    async (_topology, targetState) => {
      await seedFixture();
      const kernel = await openKernel((point) => {
        if (point === "move-with-writes:after-rename") {
          throw new Error("interrupted before rename recovery topology");
        }
      });
      await expect(kernel.moveWithWrites(await prepareFixture(kernel))).rejects.toThrow(
        "interrupted before rename recovery topology",
      );

      await fs.writeFile(path.join(vaultPath, "Source.md"), "external source winner", "utf8");
      if (targetState === "external-target") {
        await fs.writeFile(path.join(vaultPath, "Renamed.md"), "external target winner", "utf8");
      } else if (targetState === "missing") {
        await fs.unlink(path.join(vaultPath, "Renamed.md"));
      }

      const recovered = await openKernel();

      expect(recovered.startupRecoveryActions.at(-1)).toMatchObject({
        kind: "move-with-writes",
        outcome: "manual-conflict",
        path: "Source.md",
      });
      await expect(recovered.readText("A.md")).resolves.toMatchObject({
        content: "[[Renamed]]",
      });
      await expect(recovered.readText("B.md")).resolves.toMatchObject({
        content: "[renamed](./Renamed.md)",
      });
      await expect(recovered.readText("Source.md")).resolves.toMatchObject({
        content: "external source winner",
      });
      if (targetState === "original") {
        await expect(recovered.readText("Renamed.md")).resolves.toMatchObject({
          content: "# Source",
        });
      } else if (targetState === "external-target") {
        await expect(recovered.readText("Renamed.md")).resolves.toMatchObject({
          content: "external target winner",
        });
      } else {
        await expect(recovered.readText("Renamed.md")).rejects.toThrow();
      }

      const historyEntries = await fs.readdir(path.join(recovered.stateRoot, "history"));
      const parentHistory = await Promise.all(
        historyEntries.map(async (entry) => {
          const parsed = JSON.parse(
            await fs.readFile(path.join(recovered.stateRoot, "history", entry), "utf8"),
          ) as { kind?: unknown; outcome?: unknown; reason?: unknown };
          return parsed.kind === "move-with-writes" ? parsed : null;
        }),
      );
      expect(parentHistory).toContainEqual(
        expect.objectContaining({
          kind: "move-with-writes",
          outcome: "manual-conflict",
          reason: "rename-state-diverged",
        }),
      );
    },
  );

  it("fails closed on a corrupt parent blob before recovering a pending child", async () => {
    await seedFixture();
    const kernel = await openKernel((point) => {
      if (point === "write:after-stage") {
        throw new Error("interrupted child write before parent validation");
      }
    });
    await expect(kernel.moveWithWrites(await prepareFixture(kernel))).rejects.toThrow(
      "interrupted child write before parent validation",
    );
    const journalNames = await fs.readdir(path.join(kernel.stateRoot, "journal"));
    let parentId: string | undefined;
    for (const journalName of journalNames) {
      const journal = JSON.parse(
        await fs.readFile(path.join(kernel.stateRoot, "journal", journalName), "utf8"),
      );
      if (journal.kind === "move-with-writes") {
        parentId = journal.id;
      }
    }
    expect(parentId).toBeTypeOf("string");
    await fs.writeFile(
      path.join(kernel.stateRoot, "transactions", parentId ?? "missing", "0.before"),
      "corrupt",
      "utf8",
    );

    await expect(openKernel()).rejects.toBeInstanceOf(VaultRecoveryError);
    await expect(fs.readFile(path.join(vaultPath, "A.md"), "utf8")).resolves.toBe("[[Source]]");
    await expect(fs.readFile(path.join(vaultPath, "B.md"), "utf8")).resolves.toBe(
      "[source](./Source.md)",
    );
  });

  it("uses rewritten source bytes as the revision moved to the destination", async () => {
    await seedFixture();
    await fs.writeFile(path.join(vaultPath, "Source.md"), "# Source\n[[Source]]", "utf8");
    const kernel = await openKernel();
    const request = await prepareFixture(kernel);
    request.writes.push({
      path: "Source.md",
      content: "# Source\n[[Renamed]]",
      expectedRevision: request.expectedSourceRevision,
    });

    const result = await kernel.moveWithWrites(request);

    expect(result).toMatchObject({ status: "committed", from: "Source.md", to: "Renamed.md" });
    await expect(kernel.readText("Renamed.md")).resolves.toMatchObject({
      content: "# Source\n[[Renamed]]",
    });
    await expect(kernel.readText("Source.md")).rejects.toThrow();
  });

  it("preserves an external pending edit, rolls back applied rewrites, and does not rename", async () => {
    await seedFixture();
    let completedEntries = 0;
    const kernel = await openKernel((point) => {
      if (point === "move-with-writes:after-entry" && completedEntries++ === 0) {
        throw new Error("interrupted after first rewrite");
      }
    });
    await expect(kernel.moveWithWrites(await prepareFixture(kernel))).rejects.toThrow(
      "interrupted after first rewrite",
    );
    await fs.writeFile(path.join(vaultPath, "B.md"), "external b", "utf8");

    const recovered = await openKernel();

    expect(recovered.startupRecoveryActions.at(-1)).toMatchObject({
      kind: "move-with-writes",
      outcome: "conflict-copy",
      path: "Source.md",
    });
    await expect(recovered.readText("A.md")).resolves.toMatchObject({ content: "[[Source]]" });
    await expect(recovered.readText("B.md")).resolves.toMatchObject({ content: "external b" });
    await expect(recovered.readText("Source.md")).resolves.toMatchObject({ content: "# Source" });
    await expect(recovered.readText("Renamed.md")).rejects.toThrow();
    const conflictPath = recovered.startupRecoveryActions.at(-1)?.conflictPath;
    expect(conflictPath).toBeTypeOf("string");
    await expect(recovered.readText(conflictPath ?? "missing")).resolves.toMatchObject({
      content: "[renamed](./Renamed.md)",
    });
  });

  it("rolls back every rewrite when the destination is claimed before recovery", async () => {
    await seedFixture();
    const kernel = await openKernel((point) => {
      if (point === "move-with-writes:before-rename") {
        throw new Error("interrupted before rename");
      }
    });
    await expect(kernel.moveWithWrites(await prepareFixture(kernel))).rejects.toThrow(
      "interrupted before rename",
    );
    await fs.writeFile(path.join(vaultPath, "Renamed.md"), "external target", "utf8");

    const recovered = await openKernel();

    expect(recovered.startupRecoveryActions.at(-1)).toMatchObject({
      kind: "move-with-writes",
      outcome: "rolled-back",
      path: "Source.md",
    });
    await expect(recovered.readText("A.md")).resolves.toMatchObject({ content: "[[Source]]" });
    await expect(recovered.readText("B.md")).resolves.toMatchObject({
      content: "[source](./Source.md)",
    });
    await expect(recovered.readText("Source.md")).resolves.toMatchObject({ content: "# Source" });
    await expect(recovered.readText("Renamed.md")).resolves.toMatchObject({
      content: "external target",
    });
  });

  it("finishes rolling back after an interruption between rollback entries", async () => {
    await seedFixture();
    let rollbackEntries = 0;
    const kernel = await openKernel(async (point) => {
      if (point === "move-with-writes:before-rename") {
        await fs.writeFile(path.join(vaultPath, "Renamed.md"), "external target", "utf8");
      }
      if (point === "move-with-writes:after-rollback-entry" && rollbackEntries++ === 0) {
        throw new Error("interrupted during rollback");
      }
    });
    await expect(kernel.moveWithWrites(await prepareFixture(kernel))).rejects.toThrow(
      "interrupted during rollback",
    );

    const recovered = await openKernel();

    expect(recovered.startupRecoveryActions.at(-1)).toMatchObject({
      kind: "move-with-writes",
      outcome: "rolled-back",
      path: "Source.md",
    });
    await expect(recovered.readText("A.md")).resolves.toMatchObject({ content: "[[Source]]" });
    await expect(recovered.readText("B.md")).resolves.toMatchObject({
      content: "[source](./Source.md)",
    });
    await expect(recovered.readText("Source.md")).resolves.toMatchObject({ content: "# Source" });
    await expect(recovered.readText("Renamed.md")).resolves.toMatchObject({
      content: "external target",
    });
  });

  it("keeps an external edit and preserves the original bytes when rollback also conflicts", async () => {
    await seedFixture();
    const kernel = await openKernel((point) => {
      if (point === "move-with-writes:before-rename") {
        throw new Error("interrupted before contested rollback");
      }
    });
    await expect(kernel.moveWithWrites(await prepareFixture(kernel))).rejects.toThrow(
      "interrupted before contested rollback",
    );
    await fs.writeFile(path.join(vaultPath, "A.md"), "external after rewrite", "utf8");
    await fs.writeFile(path.join(vaultPath, "Renamed.md"), "external target", "utf8");

    const recovered = await openKernel();

    expect(recovered.startupRecoveryActions.at(-1)).toMatchObject({
      kind: "move-with-writes",
      outcome: "manual-conflict",
      path: "Source.md",
    });
    await expect(recovered.readText("A.md")).resolves.toMatchObject({
      content: "external after rewrite",
    });
    await expect(recovered.readText("B.md")).resolves.toMatchObject({
      content: "[source](./Source.md)",
    });
    const conflictPath = recovered.startupRecoveryActions.at(-1)?.conflictPath;
    expect(conflictPath).toBeTypeOf("string");
    await expect(recovered.readText(conflictPath ?? "missing")).resolves.toMatchObject({
      content: "[[Source]]",
    });
  });
});
