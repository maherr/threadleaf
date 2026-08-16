import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedStateRoot } from "../kernel/ports";
import { VaultKernel } from "../kernel/vault-kernel";
import { inspectMissingAttachmentRelinkOffer, relinkMissingAttachment } from "./attachment-relink";

const pdfBytes = Buffer.from("%PDF-1.7\nrelink-candidate", "ascii");

let sandboxPath: string;
let vaultPath: string;
let kernel: VaultKernel;
let finalWriteFault: (() => void | Promise<void>) | null;

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-attachment-relink-"));
  vaultPath = path.join(sandboxPath, "vault");
  await fs.mkdir(path.join(vaultPath, "Notes"), { recursive: true });
  await fs.mkdir(path.join(vaultPath, "Assets"), { recursive: true });
  await fs.writeFile(path.join(vaultPath, "Assets", "recovered report.pdf"), pdfBytes);
  finalWriteFault = null;
  kernel = await VaultKernel.open({
    vaultRoot: vaultPath,
    stateRoot: new FixedStateRoot(path.join(sandboxPath, "state")),
    faultInjector: async (point) => {
      if (point !== "write:before-final-check" || !finalWriteFault) return;
      const fault = finalWriteFault;
      finalWriteFault = null;
      await fault();
    },
  });
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

async function expectRelinkPreconditionRollbackReceipt(): Promise<void> {
  await expect(fs.readdir(path.join(kernel.stateRoot, "journal"))).resolves.toEqual([]);
  const historyNames = await fs.readdir(path.join(kernel.stateRoot, "history"));
  expect(historyNames).toHaveLength(1);
  const historyName = historyNames[0];
  if (!historyName) throw new Error("Expected a rolled-back relink receipt.");
  await expect(
    fs
      .readFile(path.join(kernel.stateRoot, "history", historyName), "utf8")
      .then((value) => JSON.parse(value)),
  ).resolves.toMatchObject({
    kind: "write",
    phase: "prepared",
    targetPath: "Notes/Current.md",
    outcome: "rolled-back",
  });
  const recoveryEntries = await fs.readdir(path.join(kernel.stateRoot, "recovery"), {
    withFileTypes: true,
  });
  expect(recoveryEntries.filter((entry) => entry.isFile()).map((entry) => entry.name)).toEqual([]);
  await expect(
    fs.readdir(path.join(kernel.stateRoot, "recovery", "rollback-claims")),
  ).resolves.toEqual([]);
  await expect(fs.readdir(path.join(kernel.stateRoot, "transactions"))).resolves.toEqual([]);
  expect(
    (await fs.readdir(path.join(vaultPath, "Notes"))).filter(
      (name) => name.startsWith(".threadleaf-write-") || name.startsWith(".threadleaf-rollback-"),
    ),
  ).toEqual([]);
}

describe("missing attachment relinking", () => {
  it("offers recovery only for one source-mappable missing passive embed", async () => {
    const content = ["`![[../Missing/report.pdf]]`", "![[../Missing/report.pdf]]", ""].join("\n");
    await fs.writeFile(path.join(vaultPath, "Notes", "Current.md"), content, "utf8");
    const listing = await kernel.listVisiblePaths("");

    await expect(
      inspectMissingAttachmentRelinkOffer(
        kernel,
        "Notes/Current.md",
        "../Missing/report.pdf",
        listing.files,
      ),
    ).resolves.toMatchObject({
      kind: "missing-attachment",
      missingPath: "Missing/report.pdf",
      sourceNoteRevision: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });

    await fs.writeFile(
      path.join(vaultPath, "Notes", "Current.md"),
      `${content}![[../Missing/report.pdf]]\n`,
      "utf8",
    );
    await expect(
      inspectMissingAttachmentRelinkOffer(
        kernel,
        "Notes/Current.md",
        "../Missing/report.pdf",
        listing.files,
      ),
    ).resolves.toBeNull();
  });

  it("previews and commits exactly one source-token rewrite while preserving note and candidate bytes", async () => {
    const before = [
      "\ufeff# Current",
      "`![[../Missing/report.pdf?download=1#page=2|ignored code]]`",
      "![[../Missing/report.pdf?download=1#page=2|Quarterly report]]",
      "After",
      "",
    ].join("\r\n");
    await fs.writeFile(path.join(vaultPath, "Notes", "Current.md"), before, "utf8");
    const source = await kernel.readText("Notes/Current.md");

    const preview = await relinkMissingAttachment(kernel, {
      sourceNotePath: "Notes/Current.md",
      missingTarget: "../Missing/report.pdf?download=1",
      replacementPath: "Assets/recovered report.pdf",
      expectedSourceRevision: source.revision,
    });

    expect(preview).toMatchObject({
      status: "requires-confirmation",
      rewrite: {
        documentPath: "Notes/Current.md",
        line: 3,
        syntax: "wiki",
        beforeTarget: "../Missing/report.pdf?download=1",
        afterTarget: "../Assets/recovered report.pdf?download=1",
        missingPath: "Missing/report.pdf",
        replacementPath: "Assets/recovered report.pdf",
      },
    });
    if (preview.status !== "requires-confirmation") {
      throw new Error("Expected an exact relink preview.");
    }
    await expect(fs.readFile(path.join(vaultPath, "Notes", "Current.md"), "utf8")).resolves.toBe(
      before,
    );

    const committed = await relinkMissingAttachment(kernel, {
      sourceNotePath: "Notes/Current.md",
      missingTarget: "../Missing/report.pdf?download=1",
      replacementPath: "Assets/recovered report.pdf",
      expectedSourceRevision: source.revision,
      confirmationId: preview.confirmationId,
    });

    expect(committed).toMatchObject({ status: "committed", path: "Notes/Current.md" });
    const after = before.replace(
      "![[../Missing/report.pdf?download=1#page=2|Quarterly report]]",
      "![[../Assets/recovered report.pdf?download=1#page=2|Quarterly report]]",
    );
    await expect(fs.readFile(path.join(vaultPath, "Notes", "Current.md"), "utf8")).resolves.toBe(
      after,
    );
    await expect(
      fs.readFile(path.join(vaultPath, "Assets", "recovered report.pdf")),
    ).resolves.toEqual(pdfBytes);
    await expect(fs.stat(path.join(vaultPath, "Missing", "report.pdf"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses to guess when more than one visible embed resolves to the missing path", async () => {
    const before = ["![[../Missing/report.pdf]]", "![second](../Missing/report.pdf)", ""].join(
      "\n",
    );
    await fs.writeFile(path.join(vaultPath, "Notes", "Current.md"), before, "utf8");
    const source = await kernel.readText("Notes/Current.md");

    await expect(
      relinkMissingAttachment(kernel, {
        sourceNotePath: "Notes/Current.md",
        missingTarget: "../Missing/report.pdf",
        replacementPath: "Assets/recovered report.pdf",
        expectedSourceRevision: source.revision,
      }),
    ).resolves.toMatchObject({ status: "refused", reason: "reference-ambiguous" });
    await expect(fs.readFile(path.join(vaultPath, "Notes", "Current.md"), "utf8")).resolves.toBe(
      before,
    );
  });

  it("invalidates a confirmation when the missing target returns", async () => {
    const before = "![[../Missing/report.pdf]]\n";
    await fs.writeFile(path.join(vaultPath, "Notes", "Current.md"), before, "utf8");
    const source = await kernel.readText("Notes/Current.md");
    const preview = await relinkMissingAttachment(kernel, {
      sourceNotePath: "Notes/Current.md",
      missingTarget: "../Missing/report.pdf",
      replacementPath: "Assets/recovered report.pdf",
      expectedSourceRevision: source.revision,
    });
    if (preview.status !== "requires-confirmation") {
      throw new Error("Expected an exact relink preview.");
    }
    await fs.mkdir(path.join(vaultPath, "Missing"), { recursive: true });
    await fs.writeFile(path.join(vaultPath, "Missing", "report.pdf"), pdfBytes);

    await expect(
      relinkMissingAttachment(kernel, {
        sourceNotePath: "Notes/Current.md",
        missingTarget: "../Missing/report.pdf",
        replacementPath: "Assets/recovered report.pdf",
        expectedSourceRevision: source.revision,
        confirmationId: preview.confirmationId,
      }),
    ).resolves.toMatchObject({ status: "refused", reason: "missing-target-returned" });
    await expect(fs.readFile(path.join(vaultPath, "Notes", "Current.md"), "utf8")).resolves.toBe(
      before,
    );
  });

  it("refreshes confirmation when candidate bytes change without touching either path", async () => {
    const before = "![[../Missing/report.pdf]]\n";
    await fs.writeFile(path.join(vaultPath, "Notes", "Current.md"), before, "utf8");
    const source = await kernel.readText("Notes/Current.md");
    const preview = await relinkMissingAttachment(kernel, {
      sourceNotePath: "Notes/Current.md",
      missingTarget: "../Missing/report.pdf",
      replacementPath: "Assets/recovered report.pdf",
      expectedSourceRevision: source.revision,
    });
    if (preview.status !== "requires-confirmation") {
      throw new Error("Expected an exact relink preview.");
    }
    const changedCandidate = Buffer.from("%PDF-1.7\nchanged candidate\n", "ascii");
    await fs.writeFile(path.join(vaultPath, "Assets", "recovered report.pdf"), changedCandidate);

    const refreshed = await relinkMissingAttachment(kernel, {
      sourceNotePath: "Notes/Current.md",
      missingTarget: "../Missing/report.pdf",
      replacementPath: "Assets/recovered report.pdf",
      expectedSourceRevision: source.revision,
      confirmationId: preview.confirmationId,
    });

    expect(refreshed).toMatchObject({
      status: "requires-confirmation",
      confirmationId: expect.not.stringMatching(preview.confirmationId),
    });
    await expect(fs.readFile(path.join(vaultPath, "Notes", "Current.md"), "utf8")).resolves.toBe(
      before,
    );
    await expect(
      fs.readFile(path.join(vaultPath, "Assets", "recovered report.pdf")),
    ).resolves.toEqual(changedCandidate);
  });

  it("refuses without mutating the source when the missing target returns at the write boundary", async () => {
    const before = "![[../Missing/report.pdf]]\n";
    await fs.writeFile(path.join(vaultPath, "Notes", "Current.md"), before, "utf8");
    const source = await kernel.readText("Notes/Current.md");
    const preview = await relinkMissingAttachment(kernel, {
      sourceNotePath: "Notes/Current.md",
      missingTarget: "../Missing/report.pdf",
      replacementPath: "Assets/recovered report.pdf",
      expectedSourceRevision: source.revision,
    });
    if (preview.status !== "requires-confirmation") {
      throw new Error("Expected an exact relink preview.");
    }
    finalWriteFault = async () => {
      await fs.mkdir(path.join(vaultPath, "Missing"), { recursive: true });
      await fs.writeFile(path.join(vaultPath, "Missing", "report.pdf"), pdfBytes);
    };

    await expect(
      relinkMissingAttachment(kernel, {
        sourceNotePath: "Notes/Current.md",
        missingTarget: "../Missing/report.pdf",
        replacementPath: "Assets/recovered report.pdf",
        expectedSourceRevision: source.revision,
        confirmationId: preview.confirmationId,
      }),
    ).resolves.toMatchObject({ status: "refused", reason: "missing-target-returned" });
    await expect(fs.readFile(path.join(vaultPath, "Notes", "Current.md"), "utf8")).resolves.toBe(
      before,
    );
    await expectRelinkPreconditionRollbackReceipt();
  });

  it("refuses when a case-equivalent missing target returns at the write boundary", async () => {
    const before = "![[../Missing/report.pdf]]\n";
    const returnedBytes = Buffer.from("%PDF-1.7\nreturned with different case\n", "ascii");
    await fs.writeFile(path.join(vaultPath, "Notes", "Current.md"), before, "utf8");
    const source = await kernel.readText("Notes/Current.md");
    const preview = await relinkMissingAttachment(kernel, {
      sourceNotePath: "Notes/Current.md",
      missingTarget: "../Missing/report.pdf",
      replacementPath: "Assets/recovered report.pdf",
      expectedSourceRevision: source.revision,
    });
    if (preview.status !== "requires-confirmation") {
      throw new Error("Expected an exact relink preview.");
    }
    finalWriteFault = async () => {
      await fs.mkdir(path.join(vaultPath, "Missing"), { recursive: true });
      await fs.writeFile(path.join(vaultPath, "Missing", "Report.pdf"), returnedBytes);
    };

    await expect(
      relinkMissingAttachment(kernel, {
        sourceNotePath: "Notes/Current.md",
        missingTarget: "../Missing/report.pdf",
        replacementPath: "Assets/recovered report.pdf",
        expectedSourceRevision: source.revision,
        confirmationId: preview.confirmationId,
      }),
    ).resolves.toMatchObject({ status: "refused", reason: "missing-target-returned" });
    await expect(fs.readFile(path.join(vaultPath, "Notes", "Current.md"), "utf8")).resolves.toBe(
      before,
    );
    await expect(fs.readFile(path.join(vaultPath, "Missing", "Report.pdf"))).resolves.toEqual(
      returnedBytes,
    );
    await expectRelinkPreconditionRollbackReceipt();
  });

  it("refuses without mutating the source when candidate bytes change at the write boundary", async () => {
    const before = "![[../Missing/report.pdf]]\n";
    await fs.writeFile(path.join(vaultPath, "Notes", "Current.md"), before, "utf8");
    const source = await kernel.readText("Notes/Current.md");
    const preview = await relinkMissingAttachment(kernel, {
      sourceNotePath: "Notes/Current.md",
      missingTarget: "../Missing/report.pdf",
      replacementPath: "Assets/recovered report.pdf",
      expectedSourceRevision: source.revision,
    });
    if (preview.status !== "requires-confirmation") {
      throw new Error("Expected an exact relink preview.");
    }
    const changedCandidate = Buffer.from("%PDF-1.7\nchanged at final boundary\n", "ascii");
    finalWriteFault = () =>
      fs.writeFile(path.join(vaultPath, "Assets", "recovered report.pdf"), changedCandidate);

    await expect(
      relinkMissingAttachment(kernel, {
        sourceNotePath: "Notes/Current.md",
        missingTarget: "../Missing/report.pdf",
        replacementPath: "Assets/recovered report.pdf",
        expectedSourceRevision: source.revision,
        confirmationId: preview.confirmationId,
      }),
    ).resolves.toMatchObject({ status: "refused", reason: "replacement-changed" });
    await expect(fs.readFile(path.join(vaultPath, "Notes", "Current.md"), "utf8")).resolves.toBe(
      before,
    );
    await expect(
      fs.readFile(path.join(vaultPath, "Assets", "recovered report.pdf")),
    ).resolves.toEqual(changedCandidate);
    await expectRelinkPreconditionRollbackReceipt();
  });

  it("refuses when the replacement becomes case-equivalent ambiguous at the write boundary", async () => {
    const before = "![[../Missing/report.pdf]]\n";
    const duplicateBytes = Buffer.from("%PDF-1.7\ncase-equivalent duplicate\n", "ascii");
    const duplicatePath = path.join(vaultPath, "Assets", "RECOVERED REPORT.PDF");
    await fs.writeFile(path.join(vaultPath, "Notes", "Current.md"), before, "utf8");
    const source = await kernel.readText("Notes/Current.md");
    const preview = await relinkMissingAttachment(kernel, {
      sourceNotePath: "Notes/Current.md",
      missingTarget: "../Missing/report.pdf",
      replacementPath: "Assets/recovered report.pdf",
      expectedSourceRevision: source.revision,
    });
    if (preview.status !== "requires-confirmation") {
      throw new Error("Expected an exact relink preview.");
    }
    finalWriteFault = () => fs.writeFile(duplicatePath, duplicateBytes);

    await expect(
      relinkMissingAttachment(kernel, {
        sourceNotePath: "Notes/Current.md",
        missingTarget: "../Missing/report.pdf",
        replacementPath: "Assets/recovered report.pdf",
        expectedSourceRevision: source.revision,
        confirmationId: preview.confirmationId,
      }),
    ).resolves.toMatchObject({ status: "refused", reason: "replacement-changed" });
    await expect(fs.readFile(path.join(vaultPath, "Notes", "Current.md"), "utf8")).resolves.toBe(
      before,
    );
    await expect(
      fs.readFile(path.join(vaultPath, "Assets", "recovered report.pdf")),
    ).resolves.toEqual(pdfBytes);
    await expect(fs.readFile(duplicatePath)).resolves.toEqual(duplicateBytes);
    await expectRelinkPreconditionRollbackReceipt();
  });

  it("refuses without mutating the source when a candidate symlink leaves the vault at the write boundary", async () => {
    const before = "![[../Missing/report.pdf]]\n";
    const aliasPath = path.join(vaultPath, "Assets", "recovered alias.pdf");
    const outsidePath = path.join(sandboxPath, "outside-replacement.pdf");
    await fs.writeFile(path.join(vaultPath, "Notes", "Current.md"), before, "utf8");
    await fs.writeFile(outsidePath, pdfBytes);
    await fs.symlink("recovered report.pdf", aliasPath);
    const source = await kernel.readText("Notes/Current.md");
    const preview = await relinkMissingAttachment(kernel, {
      sourceNotePath: "Notes/Current.md",
      missingTarget: "../Missing/report.pdf",
      replacementPath: "Assets/recovered alias.pdf",
      expectedSourceRevision: source.revision,
    });
    if (preview.status !== "requires-confirmation") {
      throw new Error("Expected an exact relink preview.");
    }
    finalWriteFault = async () => {
      await fs.unlink(aliasPath);
      await fs.symlink(outsidePath, aliasPath);
    };

    await expect(
      relinkMissingAttachment(kernel, {
        sourceNotePath: "Notes/Current.md",
        missingTarget: "../Missing/report.pdf",
        replacementPath: "Assets/recovered alias.pdf",
        expectedSourceRevision: source.revision,
        confirmationId: preview.confirmationId,
      }),
    ).resolves.toMatchObject({ status: "refused", reason: "replacement-unreadable" });
    await expect(fs.readFile(path.join(vaultPath, "Notes", "Current.md"), "utf8")).resolves.toBe(
      before,
    );
    await expect(fs.realpath(aliasPath)).resolves.toBe(outsidePath);
    await expectRelinkPreconditionRollbackReceipt();
  });

  it("refuses stale source, private, Markdown, ambiguous, and outside-vault replacements", async () => {
    const before = "![[../Missing/report.pdf]]\n";
    await fs.writeFile(path.join(vaultPath, "Notes", "Current.md"), before, "utf8");
    await fs.writeFile(path.join(vaultPath, "Assets", "duplicate.PDF"), pdfBytes);
    await fs.writeFile(path.join(vaultPath, "Assets", "DUPLICATE.pdf"), pdfBytes);
    await fs.writeFile(path.join(vaultPath, "Assets", "note.md"), "# Not an attachment\n", "utf8");
    await fs.mkdir(path.join(vaultPath, ".threadleaf"), { recursive: true });
    await fs.writeFile(path.join(vaultPath, ".threadleaf", "private.pdf"), pdfBytes);
    const outsidePath = path.join(sandboxPath, "outside.pdf");
    await fs.writeFile(outsidePath, pdfBytes);
    await fs.symlink(outsidePath, path.join(vaultPath, "Assets", "outside.pdf"));
    const source = await kernel.readText("Notes/Current.md");
    await fs.writeFile(path.join(vaultPath, "Notes", "Current.md"), `${before}\nchanged`, "utf8");

    const base = {
      sourceNotePath: "Notes/Current.md",
      missingTarget: "../Missing/report.pdf",
      expectedSourceRevision: source.revision,
    } as const;
    await expect(
      relinkMissingAttachment(kernel, {
        ...base,
        replacementPath: "Assets/recovered report.pdf",
      }),
    ).resolves.toMatchObject({ status: "refused", reason: "source-revision-changed" });

    const current = await kernel.readText("Notes/Current.md");
    const currentBase = { ...base, expectedSourceRevision: current.revision };
    await expect(
      relinkMissingAttachment(kernel, {
        ...currentBase,
        replacementPath: ".threadleaf/private.pdf",
      }),
    ).resolves.toMatchObject({ status: "refused", reason: "private-path" });
    await expect(
      relinkMissingAttachment(kernel, {
        ...currentBase,
        replacementPath: "Assets/note.md",
      }),
    ).resolves.toMatchObject({ status: "refused", reason: "invalid-replacement" });
    await expect(
      relinkMissingAttachment(kernel, {
        ...currentBase,
        replacementPath: "Assets/duplicate.pdf",
      }),
    ).resolves.toMatchObject({ status: "refused", reason: "replacement-ambiguous" });
    await expect(
      relinkMissingAttachment(kernel, {
        ...currentBase,
        replacementPath: "Assets/outside.pdf",
      }),
    ).resolves.toMatchObject({ status: "refused", reason: "replacement-missing" });
  });

  it("preserves a conflict copy and reports its path when the source changes at commit", async () => {
    const before = "![[../Missing/report.pdf]]\n";
    const external = "# Changed outside Threadleaf\n";
    await fs.writeFile(path.join(vaultPath, "Notes", "Current.md"), before, "utf8");
    const source = await kernel.readText("Notes/Current.md");
    const preview = await relinkMissingAttachment(kernel, {
      sourceNotePath: "Notes/Current.md",
      missingTarget: "../Missing/report.pdf",
      replacementPath: "Assets/recovered report.pdf",
      expectedSourceRevision: source.revision,
    });
    if (preview.status !== "requires-confirmation") {
      throw new Error("Expected an exact relink preview.");
    }
    finalWriteFault = async () => {
      await fs.writeFile(path.join(vaultPath, "Notes", "Current.md"), external, "utf8");
    };

    const conflict = await relinkMissingAttachment(kernel, {
      sourceNotePath: "Notes/Current.md",
      missingTarget: "../Missing/report.pdf",
      replacementPath: "Assets/recovered report.pdf",
      expectedSourceRevision: source.revision,
      confirmationId: preview.confirmationId,
    });

    expect(conflict).toMatchObject({
      status: "refused",
      reason: "write-conflict",
      message: expect.stringContaining(".threadleaf-conflict-"),
      writeConflict: {
        status: "conflict",
        conflictPath: expect.stringContaining(".threadleaf-conflict-"),
      },
    });
    if (!("writeConflict" in conflict)) throw new Error("Expected a recoverable conflict receipt.");
    await expect(fs.readFile(path.join(vaultPath, "Notes", "Current.md"), "utf8")).resolves.toBe(
      external,
    );
    await expect(
      fs.readFile(path.join(vaultPath, conflict.writeConflict.conflictPath), "utf8"),
    ).resolves.toContain("../Assets/recovered report.pdf");
  });
});
