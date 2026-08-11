import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedStateRoot, type VaultMutationPort } from "../kernel/ports";
import { VaultKernel } from "../kernel/vault-kernel";
import {
  applyNotePropertyRemove,
  applyNotePropertySet,
  removeMarkdownNoteProperty,
  setMarkdownNoteProperty,
} from "./note-properties";

let sandboxPath: string;
let vaultPath: string;
let statePath: string;

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-note-properties-"));
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

describe("note property transformations", () => {
  it("creates typed frontmatter while preserving a BOM, CRLF, and the complete body", () => {
    const result = applyNotePropertySet("\ufeff# Body\r\n", "published", "true", "text");

    expect(result).toEqual({
      value: "true",
      content: '\ufeff---\r\npublished: "true"\r\n---\r\n# Body\r\n',
    });
  });

  it("replaces one scalar or list without reserializing unrelated frontmatter", () => {
    const original = [
      "---",
      "# Keep this comment exactly",
      "status: old",
      "tags:",
      "  - one",
      "  - two",
      "unchanged: value # and comment",
      "---",
      "Body stays exact.",
    ].join("\n");

    const listed = applyNotePropertySet(original, "tags", '["alpha","[[Note]]"]', "list");
    expect(listed).toEqual({
      value: ["alpha", "[[Note]]"],
      content: [
        "---",
        "# Keep this comment exactly",
        "status: old",
        "tags:",
        '  - "alpha"',
        '  - "[[Note]]"',
        "unchanged: value # and comment",
        "---",
        "Body stays exact.",
      ].join("\n"),
    });

    const numbered = applyNotePropertySet(listed.content, "status", "3.5", "number");
    expect(numbered.value).toBe(3.5);
    expect(numbered.content).toContain("\nstatus: 3.5\n");
    expect(numbered.content).toContain("unchanged: value # and comment");
    expect(numbered.content.endsWith("Body stays exact.")).toBe(true);
  });

  it("serializes each supported scalar type without YAML coercion surprises", () => {
    const cases = [
      ["text", "false", 'value: "false"', "false"],
      ["number", "-12.50", "value: -12.5", -12.5],
      ["checkbox", "TRUE", "value: true", true],
      ["date", "2026-08-11", "value: 2026-08-11", "2026-08-11"],
      ["datetime", "2026-08-11T18:30:45", "value: 2026-08-11T18:30:45", "2026-08-11T18:30:45"],
    ] as const;

    for (const [type, rawValue, expectedLine, expectedValue] of cases) {
      const result = applyNotePropertySet("Body", "value", rawValue, type);
      expect(result.value).toEqual(expectedValue);
      expect(result.content).toContain(expectedLine);
    }
  });

  it("removes only the selected property and drops an otherwise empty frontmatter block", () => {
    const original = ["---", "status: active", "tags:", "  - one", "  - two", "---", "Body"].join(
      "\n",
    );

    expect(applyNotePropertyRemove(original, "tags")).toEqual({
      removed: true,
      content: "---\nstatus: active\n---\nBody",
    });
    expect(applyNotePropertyRemove("---\nstatus: active\n---\nBody", "status")).toEqual({
      removed: true,
      content: "Body",
    });
    expect(applyNotePropertyRemove(original, "missing")).toEqual({
      removed: false,
      content: original,
    });
  });

  it("rejects names, values, and frontmatter shapes that cannot be patched losslessly", () => {
    expect(() => applyNotePropertySet("Body", "has space", "x", "text")).toThrow(
      "letters, numbers, underscores, and hyphens",
    );
    expect(() => applyNotePropertySet("Body", "value", "1 + 2", "number")).toThrow(
      "literal integer or decimal",
    );
    expect(() => applyNotePropertySet("Body", "value", "2026-02-30", "date")).toThrow(
      "calendar date",
    );
    expect(() => applyNotePropertySet("Body", "value", "yes", "checkbox")).toThrow("true or false");
    expect(() =>
      applyNotePropertySet("---\nstatus: one\nstatus: two\n---\nBody", "status", "x", "text"),
    ).toThrow("duplicate property");
    expect(() =>
      applyNotePropertySet('---\n{"status":"one"}\n---\nBody', "status", "x", "text"),
    ).toThrow("JSON or complex YAML");
    expect(() =>
      applyNotePropertySet("---\nnested:\n  child: value\n---\nBody", "nested", "x", "text"),
    ).toThrow("nested or block YAML");
    expect(() => applyNotePropertySet("---\nstatus: value", "status", "x", "text")).toThrow(
      "no closing marker",
    );
  });
});

describe("recovery-backed note property mutation", () => {
  it("commits against the exact read revision and returns the typed value", async () => {
    await fs.writeFile(path.join(vaultPath, "Note.md"), "Body", "utf8");
    const kernel = await openKernel();

    const result = await setMarkdownNoteProperty(kernel, "Note", "priority", "4", "number");

    expect(result).toMatchObject({
      status: "committed",
      path: "Note.md",
      name: "priority",
      type: "number",
      value: 4,
    });
    await expect(fs.readFile(path.join(vaultPath, "Note.md"), "utf8")).resolves.toBe(
      "---\npriority: 4\n---\nBody",
    );
  });

  it("preserves an external winner and the complete proposed frontmatter on a race", async () => {
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

    const result = await setMarkdownNoteProperty(
      racingVault,
      "Note.md",
      "status",
      "review",
      "text",
    );

    expect(result).toMatchObject({
      status: "conflict",
      path: "Note.md",
      conflictPath: expect.stringContaining("conflict"),
      name: "status",
      value: "review",
    });
    await expect(fs.readFile(path.join(vaultPath, "Note.md"), "utf8")).resolves.toBe(
      "External winner",
    );
    if (result.status !== "conflict") {
      throw new Error("Expected a conflict result.");
    }
    await expect(fs.readFile(path.join(vaultPath, result.conflictPath), "utf8")).resolves.toBe(
      '---\nstatus: "review"\n---\nOriginal',
    );
  });

  it("treats removing an absent property as a no-write success", async () => {
    await fs.writeFile(path.join(vaultPath, "Note.md"), "Body", "utf8");
    const kernel = await openKernel();
    let writes = 0;
    const observingVault: VaultMutationPort = {
      getName: () => kernel.getName(),
      listMarkdownPaths: (directory) => kernel.listMarkdownPaths(directory),
      readText: (relativePath) => kernel.readText(relativePath),
      writeText: (...args) => {
        writes += 1;
        return kernel.writeText(...args);
      },
      renameFile: (sourcePath, targetPath, expectedSourceRevision) =>
        kernel.renameFile(sourcePath, targetPath, expectedSourceRevision),
      writeMany: (requests) => kernel.writeMany(requests),
      moveWithWrites: (request) => kernel.moveWithWrites(request),
    };

    const result = await removeMarkdownNoteProperty(observingVault, "Note", "missing");

    expect(result).toMatchObject({ status: "missing", path: "Note.md", name: "missing" });
    expect(writes).toBe(0);
    await expect(fs.readFile(path.join(vaultPath, "Note.md"), "utf8")).resolves.toBe("Body");
  });
});
