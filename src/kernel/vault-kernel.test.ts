import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VaultPathError } from "./path-policy";
import { FixedStateRoot } from "./ports";
import {
  type KernelFaultPoint,
  VaultKernel,
  type VaultKernelOptions,
  VaultRecoveryError,
} from "./vault-kernel";

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
});

describe("VaultKernel writes", () => {
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
    const recoveryFiles = await fs.readdir(path.join(recovered.stateRoot, "recovery"));
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
    await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
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
