import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedStateRoot, type VaultMutationPort } from "../kernel/ports";
import { type KernelFaultInjector, VaultKernel } from "../kernel/vault-kernel";
import {
  listTrashedMarkdownNotes,
  restoreTrashedMarkdownNote,
  trashMarkdownNote,
} from "./note-trash";

let sandboxPath: string;
let vaultPath: string;
let statePath: string;

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-trash-"));
  vaultPath = path.join(sandboxPath, "vault");
  statePath = path.join(sandboxPath, "state");
  await fs.mkdir(path.join(vaultPath, "Folder"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

async function openKernel(faultInjector?: KernelFaultInjector): Promise<VaultKernel> {
  return VaultKernel.open({
    vaultRoot: vaultPath,
    stateRoot: new FixedStateRoot(statePath),
    ...(faultInjector ? { faultInjector } : {}),
  });
}

function withRenameRace(
  kernel: VaultKernel,
  beforeRename: (sourcePath: string, targetPath: string) => Promise<void>,
): VaultMutationPort {
  return {
    getName: () => kernel.getName(),
    listMarkdownPaths: (relativeDirectory) => kernel.listMarkdownPaths(relativeDirectory),
    readText: (relativePath) => kernel.readText(relativePath),
    writeText: (relativePath, content, expectedRevision) =>
      kernel.writeText(relativePath, content, expectedRevision),
    renameFile: async (sourcePath, targetPath, expectedRevision) => {
      await beforeRename(sourcePath, targetPath);
      return kernel.renameFile(sourcePath, targetPath, expectedRevision);
    },
    writeMany: (requests) => kernel.writeMany(requests),
    moveWithWrites: (request) => kernel.moveWithWrites(request),
  };
}

describe("recoverable Markdown trash", () => {
  it("moves exact bytes to the canonical trash path and excludes them from the note corpus", async () => {
    const content = "\ufeff# Exact bytes\r\n\r\nBody\r\n";
    await fs.writeFile(path.join(vaultPath, "Folder", "Note.md"), content, "utf8");
    const kernel = await openKernel();

    const outcome = await trashMarkdownNote(kernel, "Folder/Note");

    expect(outcome).toMatchObject({
      status: "committed",
      from: "Folder/Note.md",
      to: ".trash/Folder/Note.md",
    });
    await expect(
      fs.readFile(path.join(vaultPath, ".trash", "Folder", "Note.md"), "utf8"),
    ).resolves.toBe(content);
    await expect(fs.stat(path.join(vaultPath, "Folder", "Note.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(kernel.listMarkdownPaths()).resolves.toEqual([]);
    await expect(listTrashedMarkdownNotes(kernel)).resolves.toMatchObject({
      total: 1,
      entries: [
        {
          path: "Folder/Note.md",
          trashPath: ".trash/Folder/Note.md",
          revision: expect.stringMatching(/^[a-f0-9]{64}$/),
          size: Buffer.byteLength(content),
        },
      ],
    });
  });

  it("rejects a stale source revision and preserves the external edit", async () => {
    const sourcePath = path.join(vaultPath, "Folder", "Note.md");
    await fs.writeFile(sourcePath, "original", "utf8");
    const kernel = await openKernel();
    const racingVault = withRenameRace(kernel, async () => {
      await fs.writeFile(sourcePath, "external edit", "utf8");
    });

    const outcome = await trashMarkdownNote(racingVault, "Folder/Note.md");

    expect(outcome).toMatchObject({
      status: "conflict",
      from: "Folder/Note.md",
      to: ".trash/Folder/Note.md",
      reason: "source-revision-changed",
    });
    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("external edit");
    await expect(
      fs.stat(path.join(vaultPath, ".trash", "Folder", "Note.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never overwrites an earlier trash entry with the same original path", async () => {
    await fs.mkdir(path.join(vaultPath, ".trash", "Folder"), { recursive: true });
    await fs.writeFile(path.join(vaultPath, "Folder", "Note.md"), "current", "utf8");
    await fs.writeFile(path.join(vaultPath, ".trash", "Folder", "Note.md"), "earlier", "utf8");
    const kernel = await openKernel();

    const outcome = await trashMarkdownNote(kernel, "Folder/Note.md");

    expect(outcome).toMatchObject({ status: "conflict", reason: "target-exists" });
    await expect(fs.readFile(path.join(vaultPath, "Folder", "Note.md"), "utf8")).resolves.toBe(
      "current",
    );
    await expect(
      fs.readFile(path.join(vaultPath, ".trash", "Folder", "Note.md"), "utf8"),
    ).resolves.toBe("earlier");
  });

  it("restores the exact original path and rejects a destination collision", async () => {
    const sourcePath = path.join(vaultPath, "Folder", "Note.md");
    const trashPath = path.join(vaultPath, ".trash", "Folder", "Note.md");
    await fs.writeFile(sourcePath, "first", "utf8");
    const kernel = await openKernel();
    await trashMarkdownNote(kernel, "Folder/Note.md");
    await fs.writeFile(sourcePath, "replacement", "utf8");

    const collision = await restoreTrashedMarkdownNote(kernel, ".trash/Folder/Note.md");

    expect(collision).toMatchObject({ status: "conflict", reason: "target-exists" });
    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("replacement");
    await expect(fs.readFile(trashPath, "utf8")).resolves.toBe("first");

    await fs.unlink(sourcePath);
    const restored = await restoreTrashedMarkdownNote(kernel, "Folder/Note");
    expect(restored).toMatchObject({
      status: "committed",
      from: ".trash/Folder/Note.md",
      to: "Folder/Note.md",
    });
    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("first");
    await expect(fs.stat(trashPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(listTrashedMarkdownNotes(kernel)).resolves.toEqual({ total: 0, entries: [] });
  });

  it("recovers an interrupted trash rename without exposing trash as an ordinary note", async () => {
    const sourcePath = path.join(vaultPath, "Folder", "Note.md");
    const trashPath = path.join(vaultPath, ".trash", "Folder", "Note.md");
    await fs.writeFile(sourcePath, "recover me", "utf8");
    const interrupted = await openKernel((point) => {
      if (point === "rename:after-link") {
        throw new Error("simulated trash interruption");
      }
    });

    await expect(trashMarkdownNote(interrupted, "Folder/Note.md")).rejects.toThrow(
      "simulated trash interruption",
    );
    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("recover me");
    await expect(fs.readFile(trashPath, "utf8")).resolves.toBe("recover me");

    const recovered = await openKernel();
    expect(recovered.startupRecoveryActions).toMatchObject([
      { kind: "rename", outcome: "committed", path: ".trash/Folder/Note.md" },
    ]);
    await expect(fs.stat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(trashPath, "utf8")).resolves.toBe("recover me");
    await expect(recovered.listMarkdownPaths()).resolves.toEqual([]);
  });

  it("rejects traversal and direct trash paths as ordinary delete targets", async () => {
    await fs.writeFile(path.join(vaultPath, "Folder", "Note.md"), "note", "utf8");
    const kernel = await openKernel();

    await expect(trashMarkdownNote(kernel, "../Outside.md")).rejects.toThrow("traversal");
    await expect(trashMarkdownNote(kernel, ".trash/Folder/Note.md")).rejects.toThrow(
      "private application",
    );
    await expect(restoreTrashedMarkdownNote(kernel, "../Outside.md")).rejects.toThrow("traversal");
  });
});
