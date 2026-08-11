import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MetadataIndex } from "../kernel/metadata-index";
import { FixedStateRoot, type VaultMutationPort } from "../kernel/ports";
import { VaultKernel } from "../kernel/vault-kernel";
import {
  movedMarkdownPath,
  moveMarkdownNote,
  planMarkdownNoteMove,
  renamedMarkdownPath,
} from "./note-move";

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
  it("plans a backlink rewrite without touching its alias, anchor, spacing, or body", async () => {
    await fs.writeFile(path.join(vaultPath, "Target.md"), "# Target\n", "utf8");
    const linker = "Before [[ Target#Heading | visible ]] after\n";
    await fs.writeFile(path.join(vaultPath, "Linker.md"), linker, "utf8");
    const kernel = await openKernel();

    const plan = await planMarkdownNoteMove(kernel, "Target.md", "Renamed.md");

    if (plan.status !== "planned") {
      throw new Error(`Expected a move plan, received ${plan.status}.`);
    }
    expect(plan.blockers).toEqual([]);
    expect(plan.rewrites).toMatchObject([
      {
        documentPath: "Linker.md",
        resultPath: "Linker.md",
        line: 1,
        syntax: "wiki",
        beforeTarget: "Target",
        afterTarget: "Renamed",
        before: { status: "resolved", path: "Target.md" },
        after: { status: "unresolved" },
      },
    ]);
    expect(plan.writes).toMatchObject([
      {
        path: "Linker.md",
        resultPath: "Linker.md",
        content: "Before [[ Renamed#Heading | visible ]] after\n",
      },
    ]);
  });

  it("plans a relative Markdown rewrite when the linking note moves folders", async () => {
    await fs.mkdir(path.join(vaultPath, "Folder"));
    const source = '[local](./Target.md#Part "hover title")\n';
    await fs.writeFile(path.join(vaultPath, "Folder", "Source.md"), source, "utf8");
    await fs.writeFile(path.join(vaultPath, "Folder", "Target.md"), "# Target\n", "utf8");
    const kernel = await openKernel();

    const plan = await planMarkdownNoteMove(kernel, "Folder/Source.md", "Archive/Source.md");

    if (plan.status !== "planned") {
      throw new Error(`Expected a move plan, received ${plan.status}.`);
    }
    expect(plan.blockers).toEqual([]);
    expect(plan.rewrites).toMatchObject([
      {
        documentPath: "Folder/Source.md",
        resultPath: "Archive/Source.md",
        syntax: "markdown",
        beforeTarget: "./Target.md",
        afterTarget: "../Folder/Target.md",
      },
    ]);
    expect(plan.writes).toMatchObject([
      {
        path: "Folder/Source.md",
        resultPath: "Archive/Source.md",
        content: '[local](../Folder/Target.md#Part "hover title")\n',
      },
    ]);
  });

  it("rewrites repeated targets in source order while ignoring fenced examples", async () => {
    await fs.writeFile(path.join(vaultPath, "Target.md"), "# Target\n", "utf8");
    const linker = [
      "[[Target]] and [same](Target.md)",
      "```md",
      "[[Target]] and [ignored](Target.md)",
      "```",
    ].join("\n");
    await fs.writeFile(path.join(vaultPath, "Linker.md"), linker, "utf8");
    const kernel = await openKernel();

    const plan = await planMarkdownNoteMove(kernel, "Target.md", "New Name.md");

    if (plan.status !== "planned") {
      throw new Error(`Expected a move plan, received ${plan.status}.`);
    }
    expect(plan.blockers).toEqual([]);
    expect(plan.rewrites.map((rewrite) => rewrite.afterTarget)).toEqual([
      "New Name",
      "./New%20Name.md",
    ]);
    expect(plan.writes[0]?.content).toBe(
      [
        "[[New Name]] and [same](./New%20Name.md)",
        "```md",
        "[[Target]] and [ignored](Target.md)",
        "```",
      ].join("\n"),
    );
  });

  it("preserves a BOM, CRLF line endings, and escaped filename delimiters", async () => {
    await fs.writeFile(path.join(vaultPath, "Target.md"), "# Target\r\n", "utf8");
    const linker = '\uFEFFtitle: kept\r\n[[Target#Section|alias]]\r\n[same](Target.md "title")\r\n';
    await fs.writeFile(path.join(vaultPath, "Linker.md"), linker, "utf8");
    const kernel = await openKernel();

    const plan = await planMarkdownNoteMove(kernel, "Target.md", "New#Leaf (1).md");

    if (plan.status !== "planned") {
      throw new Error(`Expected a move plan, received ${plan.status}.`);
    }
    expect(plan.blockers).toEqual([]);
    expect(plan.rewrites.map((rewrite) => rewrite.afterTarget)).toEqual([
      "New%23Leaf (1)",
      "./New%23Leaf%20%281%29.md",
    ]);
    expect(plan.writes[0]?.content).toBe(
      '\uFEFFtitle: kept\r\n[[New%23Leaf (1)#Section|alias]]\r\n[same](./New%23Leaf%20%281%29.md "title")\r\n',
    );
  });

  it("does not guess when moving one candidate changes an ambiguous link", async () => {
    await fs.mkdir(path.join(vaultPath, "One"));
    await fs.mkdir(path.join(vaultPath, "Two"));
    await fs.writeFile(path.join(vaultPath, "One", "Target.md"), "one", "utf8");
    await fs.writeFile(path.join(vaultPath, "Two", "Target.md"), "two", "utf8");
    await fs.writeFile(path.join(vaultPath, "Linker.md"), "[[Target]]\n", "utf8");
    const kernel = await openKernel();

    const plan = await planMarkdownNoteMove(kernel, "One/Target.md", "Other/Renamed.md");

    if (plan.status !== "planned") {
      throw new Error(`Expected a move plan, received ${plan.status}.`);
    }
    expect(plan.rewrites).toEqual([]);
    expect(plan.writes).toEqual([]);
    expect(plan.blockers).toMatchObject([
      {
        documentPath: "Linker.md",
        target: "Target",
        before: {
          status: "ambiguous",
          candidates: ["One/Target.md", "Two/Target.md"],
        },
        after: { status: "resolved", path: "Two/Target.md" },
      },
    ]);
  });

  it("produces bytes whose final projected index preserves every resolved target", async () => {
    await fs.mkdir(path.join(vaultPath, "Folder"));
    await fs.writeFile(path.join(vaultPath, "Folder", "Target.md"), "[peer](./Peer.md)\n", "utf8");
    await fs.writeFile(path.join(vaultPath, "Folder", "Peer.md"), "# Peer\n", "utf8");
    await fs.writeFile(path.join(vaultPath, "Root.md"), "[[Folder/Target]]\n", "utf8");
    const kernel = await openKernel();

    const plan = await planMarkdownNoteMove(kernel, "Folder/Target.md", "Archive/New Target.md");

    if (plan.status !== "planned") {
      throw new Error(`Expected a move plan, received ${plan.status}.`);
    }
    expect(plan.blockers).toEqual([]);
    for (const write of plan.writes) {
      await fs.writeFile(path.join(vaultPath, write.path), write.content, "utf8");
    }
    await fs.mkdir(path.join(vaultPath, "Archive"));
    await fs.rename(
      path.join(vaultPath, "Folder", "Target.md"),
      path.join(vaultPath, "Archive", "New Target.md"),
    );

    const documents = new Map(
      (await MetadataIndex.build(kernel))
        .snapshot()
        .documents.map((document) => [document.path, document]),
    );
    expect(documents.get("Root.md")?.links[0]?.resolution).toEqual({
      status: "resolved",
      path: "Archive/New Target.md",
    });
    expect(documents.get("Archive/New Target.md")?.links[0]?.resolution).toEqual({
      status: "resolved",
      path: "Folder/Peer.md",
    });
  });

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

  it("rejects a move prepared from an older source revision", async () => {
    await fs.writeFile(path.join(vaultPath, "Old.md"), "current", "utf8");
    const kernel = await openKernel();

    const result = await moveMarkdownNote(kernel, "Old.md", "New.md", "0".repeat(64));

    expect(result).toEqual({
      status: "conflict",
      from: "Old.md",
      to: "New.md",
      reason: "source-revision-changed",
    });
    await expect(fs.readFile(path.join(vaultPath, "Old.md"), "utf8")).resolves.toBe("current");
    await expect(fs.stat(path.join(vaultPath, "New.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
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
