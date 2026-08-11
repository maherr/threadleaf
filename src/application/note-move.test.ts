import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedStateRoot, type VaultMutationPort } from "../kernel/ports";
import { VaultKernel } from "../kernel/vault-kernel";
import { movedMarkdownPath, moveMarkdownNote, renamedMarkdownPath } from "./note-move";

let sandboxPath: string;
let vaultPath: string;
let statePath: string;

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-note-move-"));
  vaultPath = path.join(sandboxPath, "vault");
  statePath = path.join(sandboxPath, "state");
  await fs.mkdir(vaultPath);
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

async function openKernel(): Promise<VaultKernel> {
  return VaultKernel.open({
    vaultRoot: vaultPath,
    stateRoot: new FixedStateRoot(statePath),
  });
}

describe("note move paths", () => {
  it("preserves the folder and Markdown extension for rename", () => {
    expect(renamedMarkdownPath("Folder/Old.md", "New")).toBe("Folder/New.md");
    expect(renamedMarkdownPath("Old", "New.MD")).toBe("New.MD");
    expect(() => renamedMarkdownPath("Old.md", "Nested/New")).toThrow("without directory");
  });

  it("accepts an exact move target or an explicit destination folder", () => {
    expect(movedMarkdownPath("Folder/Old.md", "Archive/New")).toBe("Archive/New.md");
    expect(movedMarkdownPath("Folder/Old.md", "Archive/")).toBe("Archive/Old.md");
  });
});

describe("link-safe note moves", () => {
  it("moves an unreferenced note through the recoverable rename primitive", async () => {
    await fs.writeFile(path.join(vaultPath, "Old.md"), "# Old\n", "utf8");
    const kernel = await openKernel();

    const result = await moveMarkdownNote(kernel, "Old", "Archive/New");

    expect(result).toMatchObject({ status: "committed", from: "Old.md", to: "Archive/New.md" });
    await expect(fs.readFile(path.join(vaultPath, "Archive", "New.md"), "utf8")).resolves.toBe(
      "# Old\n",
    );
    await expect(fs.stat(path.join(vaultPath, "Old.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows a folder move when basename link resolution remains identical", async () => {
    await fs.mkdir(path.join(vaultPath, "Folder"));
    await fs.writeFile(path.join(vaultPath, "Folder", "Target.md"), "# Target\n", "utf8");
    await fs.writeFile(path.join(vaultPath, "Linker.md"), "[[Target]]\n", "utf8");
    const kernel = await openKernel();

    const result = await moveMarkdownNote(kernel, "Folder/Target.md", "Archive/Target.md");

    expect(result).toMatchObject({ status: "committed", to: "Archive/Target.md" });
    await expect(fs.readFile(path.join(vaultPath, "Linker.md"), "utf8")).resolves.toBe(
      "[[Target]]\n",
    );
  });

  it("blocks a rename that would break a resolved backlink", async () => {
    await fs.writeFile(path.join(vaultPath, "Target.md"), "# Target\n", "utf8");
    await fs.writeFile(path.join(vaultPath, "Linker.md"), "[[Target#Heading|label]]\n", "utf8");
    const kernel = await openKernel();

    const result = await moveMarkdownNote(kernel, "Target.md", "Renamed.md");

    expect(result).toMatchObject({
      status: "blocked",
      from: "Target.md",
      to: "Renamed.md",
      blockers: [
        {
          documentPath: "Linker.md",
          target: "Target",
          syntax: "wiki",
          before: { status: "resolved", path: "Target.md" },
          after: { status: "unresolved" },
        },
      ],
    });
    await expect(fs.readFile(path.join(vaultPath, "Target.md"), "utf8")).resolves.toBe(
      "# Target\n",
    );
    await expect(fs.stat(path.join(vaultPath, "Renamed.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("blocks a folder move that would change a relative Markdown target", async () => {
    await fs.mkdir(path.join(vaultPath, "Folder"));
    await fs.writeFile(
      path.join(vaultPath, "Folder", "Source.md"),
      "[local](./Target.md)\n",
      "utf8",
    );
    await fs.writeFile(path.join(vaultPath, "Folder", "Target.md"), "# Target\n", "utf8");
    const kernel = await openKernel();

    const result = await moveMarkdownNote(kernel, "Folder/Source.md", "Archive/Source.md");

    expect(result).toMatchObject({
      status: "blocked",
      blockers: [
        {
          documentPath: "Folder/Source.md",
          target: "./Target.md",
          syntax: "markdown",
          before: { status: "resolved", path: "Folder/Target.md" },
          after: { status: "unresolved" },
        },
      ],
    });
  });

  it("rejects a destination collision without changing either note", async () => {
    await fs.writeFile(path.join(vaultPath, "Old.md"), "old", "utf8");
    await fs.writeFile(path.join(vaultPath, "Existing.md"), "existing", "utf8");
    const kernel = await openKernel();

    const result = await moveMarkdownNote(kernel, "Old.md", "Existing.md");

    expect(result).toEqual({
      status: "conflict",
      from: "Old.md",
      to: "Existing.md",
      reason: "target-exists",
    });
    await expect(fs.readFile(path.join(vaultPath, "Old.md"), "utf8")).resolves.toBe("old");
    await expect(fs.readFile(path.join(vaultPath, "Existing.md"), "utf8")).resolves.toBe(
      "existing",
    );
  });

  it("preserves an external target that appears after preflight", async () => {
    await fs.writeFile(path.join(vaultPath, "Old.md"), "old", "utf8");
    const kernel = await openKernel();
    const racingVault: VaultMutationPort = {
      getName: () => kernel.getName(),
      listMarkdownPaths: (directory) => kernel.listMarkdownPaths(directory),
      readText: (relativePath) => kernel.readText(relativePath),
      writeText: (relativePath, content, expectedRevision) =>
        kernel.writeText(relativePath, content, expectedRevision),
      renameFile: async (sourcePath, targetPath, expectedSourceRevision) => {
        await fs.mkdir(path.dirname(path.join(vaultPath, targetPath)), { recursive: true });
        await fs.writeFile(path.join(vaultPath, targetPath), "external winner", "utf8");
        return kernel.renameFile(sourcePath, targetPath, expectedSourceRevision);
      },
      writeMany: (requests) => kernel.writeMany(requests),
    };

    const result = await moveMarkdownNote(racingVault, "Old.md", "Archive/New.md");

    expect(result).toEqual({
      status: "conflict",
      from: "Old.md",
      to: "Archive/New.md",
      reason: "target-exists",
    });
    await expect(fs.readFile(path.join(vaultPath, "Old.md"), "utf8")).resolves.toBe("old");
    await expect(fs.readFile(path.join(vaultPath, "Archive", "New.md"), "utf8")).resolves.toBe(
      "external winner",
    );
  });
});
