import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedStateRoot } from "../kernel/ports";
import { VaultKernel } from "../kernel/vault-kernel";
import { restoreMissingAttachment } from "./attachment-restore";

let sandboxPath: string;
let vaultPath: string;
let kernel: VaultKernel;

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-attachment-restore-"));
  vaultPath = path.join(sandboxPath, "vault");
  await fs.mkdir(path.join(vaultPath, "Notes"), { recursive: true });
  await fs.mkdir(path.join(vaultPath, "Missing"), { recursive: true });
  kernel = await VaultKernel.open({
    vaultRoot: vaultPath,
    stateRoot: new FixedStateRoot(path.join(sandboxPath, "state")),
  });
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

describe("missing attachment restoration", () => {
  it.runIf(process.platform === "linux")(
    "previews and commits exact bytes at the existing missing path without rewriting Markdown",
    async () => {
      const before = [
        "\uFEFF# Current",
        "`![[../Missing/report.pdf?download=1|ignored code]]`",
        "![[../Missing/report.pdf?download=1#page=2|Quarterly report]]",
        "After",
        "",
      ].join("\r\n");
      await fs.writeFile(path.join(vaultPath, "Notes", "Current.md"), before, "utf8");
      const source = await kernel.readText("Notes/Current.md");
      const bytes = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0, 0xff, 0x0a]);

      const preview = await restoreMissingAttachment(kernel, {
        sourceNotePath: source.path,
        missingTarget: "../Missing/report.pdf?download=1",
        sourceFileName: "quarterly-report.pdf",
        bytes,
        expectedSourceRevision: source.revision,
      });

      expect(preview).toMatchObject({
        status: "requires-confirmation",
        preview: {
          sourceNotePath: "Notes/Current.md",
          targetPath: "Missing/report.pdf",
          sourceFileName: "quarterly-report.pdf",
          byteLength: bytes.byteLength,
          contentRevision: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      });
      if (preview.status !== "requires-confirmation") {
        throw new Error("Expected an attachment restore preview.");
      }
      await expect(fs.readFile(path.join(vaultPath, "Notes", "Current.md"), "utf8")).resolves.toBe(
        before,
      );
      await expect(fs.stat(path.join(vaultPath, "Missing", "report.pdf"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      const committed = await restoreMissingAttachment(kernel, {
        sourceNotePath: source.path,
        missingTarget: "../Missing/report.pdf?download=1",
        sourceFileName: "quarterly-report.pdf",
        bytes,
        expectedSourceRevision: source.revision,
        confirmationId: preview.confirmationId,
      });

      expect(committed).toMatchObject({
        status: "committed",
        path: "Missing/report.pdf",
        preview: preview.preview,
      });
      await expect(fs.readFile(path.join(vaultPath, "Missing", "report.pdf"))).resolves.toEqual(
        Buffer.from(bytes),
      );
      await expect(fs.readFile(path.join(vaultPath, "Notes", "Current.md"), "utf8")).resolves.toBe(
        before,
      );
    },
  );

  it("binds confirmation to the exact external bytes and selected file name", async () => {
    await fs.writeFile(
      path.join(vaultPath, "Notes", "Current.md"),
      "![[../Missing/report.pdf]]\n",
      "utf8",
    );
    const source = await kernel.readText("Notes/Current.md");
    const first = await restoreMissingAttachment(kernel, {
      sourceNotePath: source.path,
      missingTarget: "../Missing/report.pdf",
      sourceFileName: "first.pdf",
      bytes: Buffer.from("first"),
      expectedSourceRevision: source.revision,
    });
    if (first.status !== "requires-confirmation") throw new Error("Expected first preview.");

    const changedBytes = await restoreMissingAttachment(kernel, {
      sourceNotePath: source.path,
      missingTarget: "../Missing/report.pdf",
      sourceFileName: "first.pdf",
      bytes: Buffer.from("second"),
      expectedSourceRevision: source.revision,
      confirmationId: first.confirmationId,
    });
    expect(changedBytes).toMatchObject({ status: "requires-confirmation" });
    if (changedBytes.status !== "requires-confirmation") {
      throw new Error("Expected changed bytes to require a new confirmation.");
    }
    expect(changedBytes.confirmationId).not.toBe(first.confirmationId);

    const changedName = await restoreMissingAttachment(kernel, {
      sourceNotePath: source.path,
      missingTarget: "../Missing/report.pdf",
      sourceFileName: "second.pdf",
      bytes: Buffer.from("first"),
      expectedSourceRevision: source.revision,
      confirmationId: first.confirmationId,
    });
    expect(changedName).toMatchObject({ status: "requires-confirmation" });
    if (changedName.status !== "requires-confirmation") {
      throw new Error("Expected changed name to require a new confirmation.");
    }
    expect(changedName.confirmationId).not.toBe(first.confirmationId);
  });

  it("refuses unsafe names, oversized bytes, duplicate references, and stale generations", async () => {
    await fs.writeFile(
      path.join(vaultPath, "Notes", "Current.md"),
      "![[../Missing/report.pdf]]\n![[../Missing/report.pdf]]\n",
      "utf8",
    );
    const duplicateSource = await kernel.readText("Notes/Current.md");
    await expect(
      restoreMissingAttachment(kernel, {
        sourceNotePath: duplicateSource.path,
        missingTarget: "../Missing/report.pdf",
        sourceFileName: "report.pdf",
        bytes: Buffer.from("bytes"),
        expectedSourceRevision: duplicateSource.revision,
      }),
    ).resolves.toMatchObject({ status: "refused", reason: "reference-ambiguous" });

    await fs.writeFile(
      path.join(vaultPath, "Notes", "Current.md"),
      "![[../Missing/report.pdf]]\n",
      "utf8",
    );
    const source = await kernel.readText("Notes/Current.md");
    await expect(
      restoreMissingAttachment(kernel, {
        sourceNotePath: source.path,
        missingTarget: "../Missing/report.pdf",
        sourceFileName: "../report.pdf",
        bytes: Buffer.from("bytes"),
        expectedSourceRevision: source.revision,
      }),
    ).resolves.toMatchObject({ status: "refused", reason: "invalid-file-name" });
    await expect(
      restoreMissingAttachment(
        kernel,
        {
          sourceNotePath: source.path,
          missingTarget: "../Missing/report.pdf",
          sourceFileName: "report.pdf",
          bytes: Buffer.from("too large"),
          expectedSourceRevision: source.revision,
        },
        { maxBytes: 4 },
      ),
    ).resolves.toMatchObject({ status: "refused", reason: "attachment-too-large" });

    let generation = 7;
    const preview = await restoreMissingAttachment(
      kernel,
      {
        sourceNotePath: source.path,
        missingTarget: "../Missing/report.pdf",
        sourceFileName: "report.pdf",
        bytes: Buffer.from("bytes"),
        expectedSourceRevision: source.revision,
      },
      { generation, currentGeneration: () => generation },
    );
    if (preview.status !== "requires-confirmation") throw new Error("Expected preview.");
    generation += 1;
    await expect(
      restoreMissingAttachment(
        kernel,
        {
          sourceNotePath: source.path,
          missingTarget: "../Missing/report.pdf",
          sourceFileName: "report.pdf",
          bytes: Buffer.from("bytes"),
          expectedSourceRevision: source.revision,
          confirmationId: preview.confirmationId,
        },
        { generation: 7, currentGeneration: () => generation },
      ),
    ).resolves.toMatchObject({ status: "refused", reason: "workspace-changed" });
  });
});
