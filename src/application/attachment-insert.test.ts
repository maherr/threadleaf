import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedStateRoot } from "../kernel/ports";
import { VaultKernel } from "../kernel/vault-kernel";
import { insertExternalAttachment } from "./attachment-insert";

let sandboxPath: string;
let vaultPath: string;
let kernel: VaultKernel;

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-attachment-insert-"));
  vaultPath = path.join(sandboxPath, "vault");
  await fs.mkdir(path.join(vaultPath, "Notes"), { recursive: true });
  await fs.mkdir(path.join(vaultPath, "Assets"), { recursive: true });
  kernel = await VaultKernel.open({
    vaultRoot: vaultPath,
    stateRoot: new FixedStateRoot(path.join(sandboxPath, "state")),
  });
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

describe("external attachment insertion", () => {
  it.runIf(process.platform === "linux")(
    "previews and commits exact bytes plus one BOM/CRLF-preserving editor reference",
    async () => {
      const before = "\uFEFF# Current\r\nReplace me.\r\n";
      const logical = "# Current\nReplace me.\n";
      const selectionStart = logical.indexOf("Replace me");
      const selectionEnd = selectionStart + "Replace me".length;
      await fs.writeFile(path.join(vaultPath, "Notes", "Current.md"), before, "utf8");
      const source = await kernel.readText("Notes/Current.md");
      const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 0x0a]);

      const preview = await insertExternalAttachment(kernel, {
        sourceNotePath: source.path,
        targetPath: "Notes/photo.png",
        sourceFileName: "photo.png",
        bytes,
        expectedSourceRevision: source.revision,
        selectionStart,
        selectionEnd,
        linkStyle: "preserve",
      });

      expect(preview).toMatchObject({
        status: "requires-confirmation",
        preview: {
          sourceNotePath: "Notes/Current.md",
          targetPath: "Notes/photo.png",
          sourceFileName: "photo.png",
          byteLength: bytes.byteLength,
          contentRevision: expect.stringMatching(/^[a-f0-9]{64}$/u),
          proposedNoteRevision: expect.stringMatching(/^[a-f0-9]{64}$/u),
          referenceText: "![[photo.png]]",
          selectionStart,
          selectionEnd,
          selectionAfter: selectionStart + "![[photo.png]]".length,
        },
      });
      if (preview.status !== "requires-confirmation") {
        throw new Error("Expected an attachment insertion preview.");
      }
      await expect(fs.stat(path.join(vaultPath, "Notes", "photo.png"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.readFile(path.join(vaultPath, "Notes", "Current.md"), "utf8")).resolves.toBe(
        before,
      );

      const committed = await insertExternalAttachment(kernel, {
        sourceNotePath: source.path,
        targetPath: "Notes/photo.png",
        sourceFileName: "photo.png",
        bytes,
        expectedSourceRevision: source.revision,
        selectionStart,
        selectionEnd,
        linkStyle: "preserve",
        confirmationId: preview.confirmationId,
      });

      expect(committed).toMatchObject({
        status: "committed",
        path: "Notes/Current.md",
        attachmentPath: "Notes/photo.png",
        preview: preview.preview,
      });
      await expect(fs.readFile(path.join(vaultPath, "Notes", "photo.png"))).resolves.toEqual(
        Buffer.from(bytes),
      );
      await expect(fs.readFile(path.join(vaultPath, "Notes", "Current.md"), "utf8")).resolves.toBe(
        "\uFEFF# Current\r\n![[photo.png]].\r\n",
      );
    },
  );

  it.runIf(process.platform === "linux")(
    "generates an encoded note-relative Markdown embed without changing unrelated bytes",
    async () => {
      const before = "alpha\rbravo\r";
      await fs.writeFile(path.join(vaultPath, "Notes", "Current.md"), before, "utf8");
      const source = await kernel.readText("Notes/Current.md");
      const preview = await insertExternalAttachment(kernel, {
        sourceNotePath: source.path,
        targetPath: "Assets/diagram one.png",
        sourceFileName: "diagram one.png",
        bytes: Buffer.from("image bytes"),
        expectedSourceRevision: source.revision,
        selectionStart: 6,
        selectionEnd: 11,
        linkStyle: "markdown",
      });
      expect(preview).toMatchObject({
        status: "requires-confirmation",
        preview: {
          referenceText: "![diagram one](../Assets/diagram%20one.png)",
          selectionAfter: 6 + "![diagram one](../Assets/diagram%20one.png)".length,
        },
      });
      if (preview.status !== "requires-confirmation") throw new Error("Expected preview.");

      await insertExternalAttachment(kernel, {
        sourceNotePath: source.path,
        targetPath: "Assets/diagram one.png",
        sourceFileName: "diagram one.png",
        bytes: Buffer.from("image bytes"),
        expectedSourceRevision: source.revision,
        selectionStart: 6,
        selectionEnd: 11,
        linkStyle: "markdown",
        confirmationId: preview.confirmationId,
      });
      await expect(fs.readFile(path.join(vaultPath, "Notes", "Current.md"), "utf8")).resolves.toBe(
        "alpha\r![diagram one](../Assets/diagram%20one.png)\r",
      );
    },
  );

  it("binds confirmation to bytes, target, selection, and generated syntax", async () => {
    await fs.writeFile(path.join(vaultPath, "Notes", "Current.md"), "abcdef\n", "utf8");
    const source = await kernel.readText("Notes/Current.md");
    const base = {
      sourceNotePath: source.path,
      targetPath: "Notes/report.pdf",
      sourceFileName: "report.pdf",
      bytes: Buffer.from("first"),
      expectedSourceRevision: source.revision,
      selectionStart: 3,
      selectionEnd: 3,
      linkStyle: "preserve" as const,
    };
    const first = await insertExternalAttachment(kernel, base);
    if (first.status !== "requires-confirmation") throw new Error("Expected first preview.");

    for (const changed of [
      { ...base, bytes: Buffer.from("second") },
      { ...base, targetPath: "Assets/report.pdf" },
      { ...base, selectionStart: 4, selectionEnd: 4 },
      { ...base, linkStyle: "markdown" as const },
    ]) {
      const result = await insertExternalAttachment(kernel, {
        ...changed,
        confirmationId: first.confirmationId,
      });
      expect(result).toMatchObject({ status: "requires-confirmation" });
      if (result.status !== "requires-confirmation") throw new Error("Expected refreshed preview.");
      expect(result.confirmationId).not.toBe(first.confirmationId);
    }
  });

  it("refuses invalid ranges, active-content targets, collisions, and stale generations", async () => {
    await fs.writeFile(path.join(vaultPath, "Notes", "Current.md"), "current\n", "utf8");
    await fs.writeFile(path.join(vaultPath, "Notes", "Photo.PNG"), "claimant", "utf8");
    const source = await kernel.readText("Notes/Current.md");
    const request = {
      sourceNotePath: source.path,
      targetPath: "Notes/new.png",
      sourceFileName: "new.png",
      bytes: Buffer.from("bytes"),
      expectedSourceRevision: source.revision,
      selectionStart: 0,
      selectionEnd: 0,
      linkStyle: "preserve" as const,
    };
    await expect(
      insertExternalAttachment(kernel, { ...request, selectionEnd: 99 }),
    ).resolves.toMatchObject({ status: "refused", reason: "invalid-selection" });
    await expect(
      insertExternalAttachment(kernel, { ...request, targetPath: "Notes/script.svg" }),
    ).resolves.toMatchObject({ status: "refused", reason: "unsupported-target" });
    await expect(
      insertExternalAttachment(kernel, { ...request, targetPath: ".obsidian/new.png" }),
    ).resolves.toMatchObject({ status: "refused", reason: "private-path" });
    await expect(
      insertExternalAttachment(kernel, { ...request, targetPath: "Notes/photo.png" }),
    ).resolves.toMatchObject({ status: "refused", reason: "target-exists" });

    let generation = 4;
    const preview = await insertExternalAttachment(kernel, request, {
      generation,
      currentGeneration: () => generation,
    });
    if (preview.status !== "requires-confirmation") throw new Error("Expected preview.");
    generation += 1;
    await expect(
      insertExternalAttachment(
        kernel,
        { ...request, confirmationId: preview.confirmationId },
        { generation: 4, currentGeneration: () => generation },
      ),
    ).resolves.toMatchObject({ status: "refused", reason: "workspace-changed" });
  });
});
