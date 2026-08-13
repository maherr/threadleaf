import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedStateRoot, type VaultMutationPort } from "../kernel/ports";
import { VaultKernel } from "../kernel/vault-kernel";
import { applyNoteTextMutation, mutateMarkdownNoteText } from "./note-text-mutation";

let sandboxPath: string;
let vaultPath: string;
let statePath: string;

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-text-mutation-"));
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

describe("note text transformations", () => {
  it("adds a separating newline unless append is inline", () => {
    expect(applyNoteTextMutation("Alpha", "Beta", "append", false)).toBe("Alpha\nBeta");
    expect(applyNoteTextMutation("Alpha\r\nBody", "Beta", "append", false)).toBe(
      "Alpha\r\nBody\r\nBeta",
    );
    expect(applyNoteTextMutation("Alpha", "Beta", "append", true)).toBe("AlphaBeta");
    expect(applyNoteTextMutation("", "Beta", "append", false)).toBe("Beta");
  });

  it("prepends after frontmatter and supports CRLF and an inline mode", () => {
    expect(applyNoteTextMutation("---\ntags: [one]\n---\n# Body", "Lead", "prepend", false)).toBe(
      "---\ntags: [one]\n---\nLead\n# Body",
    );
    expect(
      applyNoteTextMutation("---\r\ntags: [one]\r\n---\r\nBody", "Lead", "prepend", true),
    ).toBe("---\r\ntags: [one]\r\n---\r\nLeadBody");
    expect(applyNoteTextMutation("---\nkey: value\n---", "Lead", "prepend", false)).toBe(
      "---\nkey: value\n---\nLead",
    );
  });

  it("treats an unterminated frontmatter marker as ordinary Markdown", () => {
    expect(applyNoteTextMutation("---\nkey: value", "Lead", "prepend", false)).toBe(
      "Lead\n---\nkey: value",
    );
  });

  it("keeps a leading BOM at byte zero for every prepend boundary", () => {
    const cases = [
      ["empty", "", "Lead"],
      ["BOM-only", "\ufeff", "\ufeffLead"],
      ["BOM body with LF", "\ufeffBody", "\ufeffLead\nBody"],
      ["BOM body with CRLF", "\ufeffBody\r\n", "\ufeffLead\r\nBody\r\n"],
      [
        "BOM frontmatter with LF",
        "\ufeff---\ntags: [one]\n---\nBody",
        "\ufeff---\ntags: [one]\n---\nLead\nBody",
      ],
      [
        "BOM frontmatter with CRLF",
        "\ufeff---\r\ntags: [one]\r\n---\r\nBody",
        "\ufeff---\r\ntags: [one]\r\n---\r\nLead\r\nBody",
      ],
      ["frontmatter without BOM", "---\nkey: value\n---\nBody", "---\nkey: value\n---\nLead\nBody"],
      ["BOM with unterminated frontmatter", "\ufeff---\nkey: value", "\ufeffLead\n---\nkey: value"],
    ] as const;

    for (const [label, current, expected] of cases) {
      expect(applyNoteTextMutation(current, "Lead", "prepend", false), label).toBe(expected);
    }
    expect(applyNoteTextMutation("\ufeffBody", "Lead", "prepend", true)).toBe("\ufeffLeadBody");
  });
});

describe("recovery-backed note text mutation", () => {
  it("commits against the revision that was actually read", async () => {
    await fs.writeFile(path.join(vaultPath, "Note.md"), "Original", "utf8");
    const kernel = await openKernel();

    const result = await mutateMarkdownNoteText(kernel, "Note", "Added", "append", false);

    expect(result).toMatchObject({ status: "committed", path: "Note.md" });
    await expect(fs.readFile(path.join(vaultPath, "Note.md"), "utf8")).resolves.toBe(
      "Original\nAdded",
    );
  });

  it("preserves both versions when an external edit wins the final race", async () => {
    await fs.writeFile(path.join(vaultPath, "Note.md"), "Original", "utf8");
    const kernel = await openKernel();
    const racingVault: VaultMutationPort = {
      getName: () => kernel.getName(),
      listMarkdownPaths: (directory) => kernel.listMarkdownPaths(directory),
      readText: (relativePath) => kernel.readText(relativePath),
      writeText: async (relativePath, content, expectedRevision) => {
        await fs.writeFile(path.join(vaultPath, relativePath), "External winner", "utf8");
        return kernel.writeText(relativePath, content, expectedRevision);
      },
      renameFile: (sourcePath, targetPath, expectedSourceRevision) =>
        kernel.renameFile(sourcePath, targetPath, expectedSourceRevision),
      writeMany: (requests) => kernel.writeMany(requests),
      moveWithWrites: (request) => kernel.moveWithWrites(request),
    };

    const result = await mutateMarkdownNoteText(
      racingVault,
      "Note.md",
      "Proposed addition",
      "append",
      false,
    );

    expect(result).toMatchObject({
      status: "conflict",
      path: "Note.md",
      conflictPath: expect.stringContaining("conflict"),
    });
    await expect(fs.readFile(path.join(vaultPath, "Note.md"), "utf8")).resolves.toBe(
      "External winner",
    );
    if (result.status !== "conflict") {
      throw new Error("Expected a conflict result.");
    }
    await expect(fs.readFile(path.join(vaultPath, result.conflictPath), "utf8")).resolves.toBe(
      "Original\nProposed addition",
    );
  });

  it("keeps a BOM at byte zero in a recoverable prepend and conflict copy", async () => {
    await fs.writeFile(path.join(vaultPath, "Note.md"), "\ufeffOriginal\r\n", "utf8");
    const kernel = await openKernel();
    const racingVault: VaultMutationPort = {
      getName: () => kernel.getName(),
      listMarkdownPaths: (directory) => kernel.listMarkdownPaths(directory),
      readText: (relativePath) => kernel.readText(relativePath),
      writeText: async (relativePath, content, expectedRevision) => {
        await fs.writeFile(path.join(vaultPath, relativePath), "External winner", "utf8");
        return kernel.writeText(relativePath, content, expectedRevision);
      },
      renameFile: (sourcePath, targetPath, expectedSourceRevision) =>
        kernel.renameFile(sourcePath, targetPath, expectedSourceRevision),
      writeMany: (requests) => kernel.writeMany(requests),
      moveWithWrites: (request) => kernel.moveWithWrites(request),
    };

    const result = await mutateMarkdownNoteText(racingVault, "Note.md", "Lead", "prepend", false);

    expect(result).toMatchObject({
      status: "conflict",
      path: "Note.md",
      conflictPath: expect.stringContaining("conflict"),
    });
    await expect(fs.readFile(path.join(vaultPath, "Note.md"), "utf8")).resolves.toBe(
      "External winner",
    );
    if (result.status !== "conflict") {
      throw new Error("Expected a conflict result.");
    }
    await expect(fs.readFile(path.join(vaultPath, result.conflictPath), "utf8")).resolves.toBe(
      "\ufeffLead\r\nOriginal\r\n",
    );
    await expect(fs.readFile(path.join(vaultPath, result.conflictPath))).resolves.toEqual(
      Buffer.from("\ufeffLead\r\nOriginal\r\n", "utf8"),
    );
  });
});
