import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedStateRoot, type VaultMutationPort } from "../kernel/ports";
import { VaultKernel } from "../kernel/vault-kernel";
import { listMarkdownTasks, mutateMarkdownTask, readMarkdownTask } from "./note-task";

let sandboxPath: string;
let vaultPath: string;
let statePath: string;

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-note-task-"));
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

describe("recovery-backed Markdown tasks", () => {
  it("lists exact task records across the vault and reads one by source line", async () => {
    await fs.writeFile(path.join(vaultPath, "A.md"), "- [ ] first\n- [x] done\n", "utf8");
    await fs.writeFile(path.join(vaultPath, "B.md"), "text\n1. [?] waiting\n", "utf8");
    const kernel = await openKernel();

    await expect(listMarkdownTasks(kernel)).resolves.toEqual([
      { path: "A.md", line: 1, status: " ", completed: false, text: "first" },
      { path: "A.md", line: 2, status: "x", completed: true, text: "done" },
      { path: "B.md", line: 2, status: "?", completed: false, text: "waiting" },
    ]);
    await expect(readMarkdownTask(kernel, "B", 2)).resolves.toMatchObject({
      task: { path: "B.md", line: 2, status: "?", text: "waiting" },
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("changes only the addressed status while preserving BOM, CRLF, and custom task text", async () => {
    const before = "\ufeff---\r\ntitle: Tasks\r\n---\r\n- [ ] first  \r\n- [🟡] second `code`\r\n";
    await fs.writeFile(path.join(vaultPath, "Tasks.md"), before, "utf8");
    const kernel = await openKernel();

    const done = await mutateMarkdownTask(kernel, "Tasks", 4, { kind: "set", status: "x" });
    const toggled = await mutateMarkdownTask(kernel, "Tasks", 5, { kind: "toggle" });

    expect(done).toMatchObject({
      status: "committed",
      task: { path: "Tasks.md", line: 4, status: "x", completed: true, text: "first" },
    });
    expect(toggled).toMatchObject({
      status: "committed",
      task: { path: "Tasks.md", line: 5, status: " ", completed: false },
    });
    await expect(fs.readFile(path.join(vaultPath, "Tasks.md"), "utf8")).resolves.toBe(
      before.replace("[ ]", "[x]").replace("[🟡]", "[ ]"),
    );
  });

  it("returns unchanged without invoking the writer when the requested status already matches", async () => {
    await fs.writeFile(path.join(vaultPath, "Tasks.md"), "- [x] done\n", "utf8");
    const kernel = await openKernel();
    let writes = 0;
    const observingVault: VaultMutationPort = {
      getName: () => kernel.getName(),
      listMarkdownPaths: (directory) => kernel.listMarkdownPaths(directory),
      readText: (relativePath) => kernel.readText(relativePath),
      writeText: async (relativePath, content, expectedRevision) => {
        writes += 1;
        return kernel.writeText(relativePath, content, expectedRevision);
      },
      renameFile: (sourcePath, targetPath, expectedSourceRevision) =>
        kernel.renameFile(sourcePath, targetPath, expectedSourceRevision),
      writeMany: (requests) => kernel.writeMany(requests),
      moveWithWrites: (request) => kernel.moveWithWrites(request),
    };

    const result = await mutateMarkdownTask(observingVault, "Tasks.md", 1, {
      kind: "set",
      status: "x",
    });

    expect(result).toMatchObject({ status: "unchanged", task: { status: "x" } });
    expect(writes).toBe(0);
  });

  it("keeps an external winner and preserves the proposed task version as a conflict copy", async () => {
    await fs.writeFile(path.join(vaultPath, "Tasks.md"), "- [ ] original\n", "utf8");
    const kernel = await openKernel();
    const racingVault: VaultMutationPort = {
      getName: () => kernel.getName(),
      listMarkdownPaths: (directory) => kernel.listMarkdownPaths(directory),
      readText: (relativePath) => kernel.readText(relativePath),
      writeText: async (relativePath, content, expectedRevision) => {
        await fs.writeFile(path.join(vaultPath, relativePath), "- [ ] external winner\n", "utf8");
        return kernel.writeText(relativePath, content, expectedRevision);
      },
      renameFile: (sourcePath, targetPath, expectedSourceRevision) =>
        kernel.renameFile(sourcePath, targetPath, expectedSourceRevision),
      writeMany: (requests) => kernel.writeMany(requests),
      moveWithWrites: (request) => kernel.moveWithWrites(request),
    };

    const result = await mutateMarkdownTask(racingVault, "Tasks.md", 1, { kind: "toggle" });

    expect(result).toMatchObject({
      status: "conflict",
      task: { status: "x", text: "original" },
      conflictPath: expect.stringContaining("threadleaf-conflict"),
    });
    await expect(fs.readFile(path.join(vaultPath, "Tasks.md"), "utf8")).resolves.toBe(
      "- [ ] external winner\n",
    );
    if (result.status !== "conflict") {
      throw new Error("Expected a task mutation conflict.");
    }
    await expect(fs.readFile(path.join(vaultPath, result.conflictPath), "utf8")).resolves.toBe(
      "- [x] original\n",
    );
  });
});
