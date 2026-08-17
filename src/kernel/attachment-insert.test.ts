import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-kernel-attachment-insert-"));
  vaultPath = path.join(sandboxPath, "vault");
  statePath = path.join(sandboxPath, "state");
  await fs.mkdir(path.join(vaultPath, "Notes"), { recursive: true });
  await fs.mkdir(path.join(vaultPath, "Assets"), { recursive: true });
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

function request(revision: string) {
  return {
    sourceNotePath: "Notes/Current.md",
    sourceNoteRevision: revision,
    nextSourceContent: "# Current\n![[../Assets/photo.png]]\n",
    targetPath: "Assets/photo.png",
    attachmentBytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff]),
  };
}

function batchRequest(revision: string) {
  return {
    sourceNotePath: "Notes/Current.md",
    sourceNoteRevision: revision,
    nextSourceContent: "# Current\n![[../Assets/first.png]]\n![[../Assets/second.png]]\n",
    items: [
      {
        targetPath: "Assets/first.png",
        attachmentBytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]),
      },
      {
        targetPath: "Assets/second.png",
        attachmentBytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x02]),
      },
    ],
  };
}

describe.runIf(process.platform === "linux")("VaultKernel attachment insertion", () => {
  it("publishes exact attachment bytes before changing the source note", async () => {
    await fs.writeFile(path.join(vaultPath, "Notes", "Current.md"), "# Current\n", "utf8");
    const kernel = await openKernel((point) => {
      if (point === "attachment-insert:after-publish") {
        throw new Error("interrupted after attachment publication");
      }
    });
    const source = await kernel.readText("Notes/Current.md");

    await expect(kernel.insertAttachmentWithReference(request(source.revision))).rejects.toThrow(
      "interrupted after attachment publication",
    );
    await expect(fs.readFile(path.join(vaultPath, "Assets", "photo.png"))).resolves.toEqual(
      request(source.revision).attachmentBytes,
    );
    await expect(fs.readFile(path.join(vaultPath, "Notes", "Current.md"), "utf8")).resolves.toBe(
      "# Current\n",
    );

    const recovered = await openKernel();
    expect(recovered.startupRecoveryActions).toMatchObject([
      { kind: "attachment-insert", outcome: "committed", path: "Notes/Current.md" },
    ]);
    await expect(fs.readFile(path.join(vaultPath, "Notes", "Current.md"), "utf8")).resolves.toBe(
      "# Current\n![[../Assets/photo.png]]\n",
    );
  });

  it.each([
    ["attachment-insert:after-intent", "rolled-back", false, false],
    ["attachment-insert:after-stage", "committed", true, true],
    ["attachment-insert:before-publish", "committed", true, true],
    ["attachment-insert:after-publish", "committed", true, true],
    ["attachment-insert:before-note-write", "committed", true, true],
    ["attachment-insert:after-note-write", "committed", true, true],
    ["attachment-insert:after-commit", "committed", true, true],
  ] as const)(
    "recovers the compound insertion after %s",
    async (faultPoint, expectedOutcome, expectsAttachment, expectsReference) => {
      await fs.writeFile(path.join(vaultPath, "Notes", "Current.md"), "# Current\n", "utf8");
      const kernel = await openKernel((point) => {
        if (point === faultPoint) throw new Error(`interrupted at ${faultPoint}`);
      });
      const source = await kernel.readText("Notes/Current.md");
      await expect(kernel.insertAttachmentWithReference(request(source.revision))).rejects.toThrow(
        `interrupted at ${faultPoint}`,
      );

      const recovered = await openKernel();
      expect(recovered.startupRecoveryActions).toMatchObject([
        {
          kind: "attachment-insert",
          outcome: expectedOutcome,
          path: "Notes/Current.md",
        },
      ]);
      if (expectsAttachment) {
        await expect(fs.readFile(path.join(vaultPath, "Assets", "photo.png"))).resolves.toEqual(
          request(source.revision).attachmentBytes,
        );
      } else {
        await expect(fs.stat(path.join(vaultPath, "Assets", "photo.png"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      await expect(fs.readFile(path.join(vaultPath, "Notes", "Current.md"), "utf8")).resolves.toBe(
        expectsReference ? "# Current\n![[../Assets/photo.png]]\n" : "# Current\n",
      );
      await expect(fs.readdir(path.join(recovered.stateRoot, "journal"))).resolves.toEqual([]);
      await expect(fs.readdir(path.join(recovered.stateRoot, "transactions"))).resolves.toEqual([]);
    },
  );

  it("retains both private blobs when publication wins before its durable phase receipt", async () => {
    await fs.writeFile(path.join(vaultPath, "Notes", "Current.md"), "# Current\n", "utf8");
    const interrupted = await openKernel((point) => {
      if (point === "attachment-insert:after-native-publish") {
        throw new Error("interrupted before publication receipt");
      }
    });
    const source = await interrupted.readText("Notes/Current.md");
    await expect(
      interrupted.insertAttachmentWithReference(request(source.revision)),
    ).rejects.toThrow("interrupted before publication receipt");

    const recovered = await openKernel();
    expect(recovered.startupRecoveryActions).toMatchObject([
      { kind: "attachment-insert", outcome: "manual-conflict", path: "Notes/Current.md" },
    ]);
    const transactionId = recovered.startupRecoveryActions[0]?.transactionId;
    await expect(fs.readFile(path.join(vaultPath, "Assets", "photo.png"))).resolves.toEqual(
      request(source.revision).attachmentBytes,
    );
    await expect(fs.readFile(path.join(vaultPath, "Notes", "Current.md"), "utf8")).resolves.toBe(
      "# Current\n",
    );
    await expect(
      fs.readFile(
        path.join(
          recovered.stateRoot,
          "transactions",
          transactionId ?? "missing",
          "attachment-insert.bin",
        ),
      ),
    ).resolves.toEqual(request(source.revision).attachmentBytes);
    await expect(
      fs.readFile(
        path.join(
          recovered.stateRoot,
          "transactions",
          transactionId ?? "missing",
          "attachment-insert-note.md",
        ),
        "utf8",
      ),
    ).resolves.toBe("# Current\n![[../Assets/photo.png]]\n");
  });

  it.each([
    ["source", "source-note-changed"],
    ["target", "target-present"],
    ["alias", "target-normalized-exists"],
  ] as const)("refuses a %s race at the final pre-publication gate", async (race, reason) => {
    await fs.writeFile(path.join(vaultPath, "Notes", "Current.md"), "# Current\n", "utf8");
    const kernel = await openKernel(async (point) => {
      if (point !== "attachment-insert:before-publish") return;
      if (race === "source") {
        await fs.writeFile(
          path.join(vaultPath, "Notes", "Current.md"),
          "# External winner\n",
          "utf8",
        );
      } else if (race === "target") {
        await fs.writeFile(path.join(vaultPath, "Assets", "photo.png"), "exact winner");
      } else {
        await fs.writeFile(path.join(vaultPath, "Assets", "PHOTO.PNG"), "alias winner");
      }
    });
    const source = await kernel.readText("Notes/Current.md");

    await expect(
      kernel.insertAttachmentWithReference(request(source.revision)),
    ).resolves.toMatchObject({ status: "refused", reason });
    if (race === "source") {
      await expect(fs.stat(path.join(vaultPath, "Assets", "photo.png"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } else {
      const winner = race === "target" ? "photo.png" : "PHOTO.PNG";
      await expect(fs.readFile(path.join(vaultPath, "Assets", winner), "utf8")).resolves.toBe(
        race === "target" ? "exact winner" : "alias winner",
      );
    }
    await expect(fs.readdir(path.join(kernel.stateRoot, "journal"))).resolves.toEqual([]);
    await expect(fs.readdir(path.join(kernel.stateRoot, "transactions"))).resolves.toEqual([]);
  });

  it("keeps both target claims and private evidence when a normalized alias appears after publish", async () => {
    await fs.writeFile(path.join(vaultPath, "Notes", "Current.md"), "# Current\n", "utf8");
    const kernel = await openKernel(async (point) => {
      if (point === "attachment-insert:after-publish") {
        await fs.writeFile(path.join(vaultPath, "Assets", "PHOTO.PNG"), "alias winner");
      }
    });
    const source = await kernel.readText("Notes/Current.md");

    const result = await kernel.insertAttachmentWithReference(request(source.revision));

    expect(result).toMatchObject({
      status: "manual-conflict",
      reason: "target-normalized-exists",
      attachmentPath: "Assets/photo.png",
      transactionId: expect.any(String),
    });
    if (result.status !== "manual-conflict") throw new Error("Expected manual conflict.");
    await expect(fs.readFile(path.join(vaultPath, "Assets", "photo.png"))).resolves.toEqual(
      request(source.revision).attachmentBytes,
    );
    await expect(fs.readFile(path.join(vaultPath, "Assets", "PHOTO.PNG"), "utf8")).resolves.toBe(
      "alias winner",
    );
    await expect(fs.readFile(path.join(vaultPath, "Notes", "Current.md"), "utf8")).resolves.toBe(
      "# Current\n",
    );
    await expect(
      fs.readFile(
        path.join(
          kernel.stateRoot,
          "transactions",
          result.transactionId,
          "attachment-insert-note.md",
        ),
        "utf8",
      ),
    ).resolves.toBe("# Current\n![[../Assets/photo.png]]\n");
  });

  it("preserves the complete proposed note when the source races after publication", async () => {
    await fs.writeFile(path.join(vaultPath, "Notes", "Current.md"), "# Current\n", "utf8");
    const kernel = await openKernel(async (point) => {
      if (point === "attachment-insert:before-note-write") {
        await fs.writeFile(
          path.join(vaultPath, "Notes", "Current.md"),
          "# External winner\n",
          "utf8",
        );
      }
    });
    const source = await kernel.readText("Notes/Current.md");

    const result = await kernel.insertAttachmentWithReference(request(source.revision));

    expect(result).toMatchObject({
      status: "conflict",
      path: "Notes/Current.md",
      attachmentPath: "Assets/photo.png",
      conflictPath: expect.stringMatching(/\.threadleaf-conflict-/u),
    });
    if (result.status !== "conflict") throw new Error("Expected a preserved conflict copy.");
    await expect(fs.readFile(path.join(vaultPath, "Notes", "Current.md"), "utf8")).resolves.toBe(
      "# External winner\n",
    );
    await expect(fs.readFile(path.join(vaultPath, result.conflictPath), "utf8")).resolves.toBe(
      "# Current\n![[../Assets/photo.png]]\n",
    );
    await expect(fs.readFile(path.join(vaultPath, "Assets", "photo.png"))).resolves.toEqual(
      request(source.revision).attachmentBytes,
    );
  });

  it("recovers an interrupted post-race conflict preservation", async () => {
    await fs.writeFile(path.join(vaultPath, "Notes", "Current.md"), "# Current\n", "utf8");
    const kernel = await openKernel(async (point) => {
      if (point === "attachment-insert:before-note-write") {
        await fs.writeFile(
          path.join(vaultPath, "Notes", "Current.md"),
          "# External winner\n",
          "utf8",
        );
      }
      if (point === "attachment-insert:after-conflict-preserve") {
        throw new Error("interrupted after conflict preservation");
      }
    });
    const source = await kernel.readText("Notes/Current.md");
    await expect(kernel.insertAttachmentWithReference(request(source.revision))).rejects.toThrow(
      "interrupted after conflict preservation",
    );

    const recovered = await openKernel();
    expect(recovered.startupRecoveryActions).toMatchObject([
      {
        kind: "attachment-insert",
        outcome: "conflict-copy",
        path: "Notes/Current.md",
        conflictPath: expect.stringMatching(/\.threadleaf-conflict-/u),
      },
    ]);
    const conflictPath = recovered.startupRecoveryActions[0]?.conflictPath;
    await expect(
      fs.readFile(path.join(vaultPath, conflictPath ?? "missing"), "utf8"),
    ).resolves.toBe("# Current\n![[../Assets/photo.png]]\n");
    await expect(fs.readFile(path.join(vaultPath, "Notes", "Current.md"), "utf8")).resolves.toBe(
      "# External winner\n",
    );
  });

  it("retains private evidence when the source namespace becomes unwritable after publication", async () => {
    const shiftedNotes = path.join(vaultPath, "Notes shifted");
    const outsideNotes = path.join(sandboxPath, "outside-notes");
    await fs.writeFile(path.join(vaultPath, "Notes", "Current.md"), "# Current\n", "utf8");
    await fs.mkdir(outsideNotes);
    await fs.writeFile(path.join(outsideNotes, "Current.md"), "# Outside winner\n", "utf8");
    const kernel = await openKernel(async (point) => {
      if (point !== "attachment-insert:before-note-write") return;
      await fs.rename(path.join(vaultPath, "Notes"), shiftedNotes);
      await fs.symlink(outsideNotes, path.join(vaultPath, "Notes"), "dir");
    });
    const source = await kernel.readText("Notes/Current.md");

    const result = await kernel.insertAttachmentWithReference(request(source.revision));

    expect(result).toMatchObject({
      status: "manual-conflict",
      reason: "conflict-preservation-diverged",
      path: "Notes/Current.md",
      attachmentPath: "Assets/photo.png",
      transactionId: expect.any(String),
    });
    if (result.status !== "manual-conflict") {
      throw new Error("Expected a durable manual-conflict receipt.");
    }
    await expect(fs.readFile(path.join(vaultPath, "Assets", "photo.png"))).resolves.toEqual(
      request(source.revision).attachmentBytes,
    );
    await expect(fs.readFile(path.join(outsideNotes, "Current.md"), "utf8")).resolves.toBe(
      "# Outside winner\n",
    );
    await expect(
      fs.readFile(
        path.join(
          kernel.stateRoot,
          "transactions",
          result.transactionId,
          "attachment-insert-note.md",
        ),
        "utf8",
      ),
    ).resolves.toBe("# Current\n![[../Assets/photo.png]]\n");
  });

  it("refuses an unwritable source alias before publishing attachment bytes", async () => {
    await fs.writeFile(path.join(vaultPath, "Notes", "Real.md"), "# Current\n", "utf8");
    await fs.symlink("Real.md", path.join(vaultPath, "Notes", "Current.md"));
    const kernel = await openKernel();
    const source = await kernel.readText("Notes/Current.md");

    await expect(
      kernel.insertAttachmentWithReference(request(source.revision)),
    ).resolves.toMatchObject({ status: "refused", reason: "source-write-unavailable" });
    await expect(fs.stat(path.join(vaultPath, "Assets", "photo.png"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails closed before replaying a staged journal with an unsupported target", async () => {
    await fs.writeFile(path.join(vaultPath, "Notes", "Current.md"), "# Current\n", "utf8");
    const interrupted = await openKernel((point) => {
      if (point === "attachment-insert:after-stage") throw new Error("staged interruption");
    });
    const source = await interrupted.readText("Notes/Current.md");
    await expect(
      interrupted.insertAttachmentWithReference(request(source.revision)),
    ).rejects.toThrow("staged interruption");
    const journalDirectory = path.join(interrupted.stateRoot, "journal");
    const [journalName] = await fs.readdir(journalDirectory);
    if (!journalName) throw new Error("Expected a staged attachment-insert journal.");
    const journalPath = path.join(journalDirectory, journalName);
    const journal = JSON.parse(await fs.readFile(journalPath, "utf8")) as Record<string, unknown>;
    journal.targetPath = "Assets/payload.sh";
    await fs.writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");

    await expect(openKernel()).rejects.toBeInstanceOf(VaultRecoveryError);
    await expect(fs.stat(path.join(vaultPath, "Assets", "payload.sh"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(path.join(vaultPath, "Assets", "photo.png"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.readFile(path.join(vaultPath, "Notes", "Current.md"), "utf8")).resolves.toBe(
      "# Current\n",
    );
    await expect(fs.stat(journalPath)).resolves.toBeTruthy();
  });

  it("publishes a bounded ordered batch before one source-note write", async () => {
    await fs.writeFile(path.join(vaultPath, "Notes", "Current.md"), "# Current\n", "utf8");
    const kernel = await openKernel();
    const source = await kernel.readText("Notes/Current.md");

    await expect(
      kernel.insertAttachmentsWithReference(batchRequest(source.revision)),
    ).resolves.toMatchObject({
      status: "committed",
      path: "Notes/Current.md",
      attachments: [
        { attachmentPath: "Assets/first.png" },
        { attachmentPath: "Assets/second.png" },
      ],
      transactionId: expect.any(String),
    });
    await expect(fs.readFile(path.join(vaultPath, "Assets", "first.png"))).resolves.toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]),
    );
    await expect(fs.readFile(path.join(vaultPath, "Assets", "second.png"))).resolves.toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x02]),
    );
    await expect(fs.readFile(path.join(vaultPath, "Notes", "Current.md"), "utf8")).resolves.toBe(
      "# Current\n![[../Assets/first.png]]\n![[../Assets/second.png]]\n",
    );
  });

  it.each([
    ["attachment-batch:after-intent", "rolled-back"],
    ["attachment-batch:after-stage", "committed"],
    ["attachment-batch:after-item-publish", "committed"],
    ["attachment-batch:after-publish", "committed"],
    ["attachment-batch:before-note-write", "committed"],
    ["attachment-batch:after-note-write", "committed"],
    ["attachment-batch:after-commit", "committed"],
  ] as const)("recovers the ordered batch after %s", async (faultPoint, expectedOutcome) => {
    await fs.writeFile(path.join(vaultPath, "Notes", "Current.md"), "# Current\n", "utf8");
    const interrupted = await openKernel((point) => {
      if (point === faultPoint) throw new Error(`interrupted at ${faultPoint}`);
    });
    const source = await interrupted.readText("Notes/Current.md");
    await expect(
      interrupted.insertAttachmentsWithReference(batchRequest(source.revision)),
    ).rejects.toThrow(`interrupted at ${faultPoint}`);

    const recovered = await openKernel();
    expect(recovered.startupRecoveryActions).toMatchObject([
      {
        kind: "attachment-batch-insert",
        outcome: expectedOutcome,
        path: "Notes/Current.md",
        paths: ["Assets/first.png", "Assets/second.png"],
      },
    ]);
    await expect(fs.readFile(path.join(vaultPath, "Notes", "Current.md"), "utf8")).resolves.toBe(
      expectedOutcome === "committed"
        ? "# Current\n![[../Assets/first.png]]\n![[../Assets/second.png]]\n"
        : "# Current\n",
    );
    await expect(fs.readdir(path.join(recovered.stateRoot, "journal"))).resolves.toEqual([]);
    await expect(fs.readdir(path.join(recovered.stateRoot, "transactions"))).resolves.toEqual([]);
  });

  it("preflights every target and never leaves an earlier item behind on a collision", async () => {
    await fs.writeFile(path.join(vaultPath, "Notes", "Current.md"), "# Current\n", "utf8");
    await fs.writeFile(path.join(vaultPath, "Assets", "second.png"), "external winner", "utf8");
    const kernel = await openKernel();
    const source = await kernel.readText("Notes/Current.md");

    await expect(
      kernel.insertAttachmentsWithReference(batchRequest(source.revision)),
    ).resolves.toMatchObject({ status: "refused", reason: "target-present" });
    await expect(fs.stat(path.join(vaultPath, "Assets", "first.png"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.readFile(path.join(vaultPath, "Notes", "Current.md"), "utf8")).resolves.toBe(
      "# Current\n",
    );
    await expect(fs.readFile(path.join(vaultPath, "Assets", "second.png"), "utf8")).resolves.toBe(
      "external winner",
    );
  });

  it("preserves a complete conflict copy when the source changes after the batch publishes", async () => {
    await fs.writeFile(path.join(vaultPath, "Notes", "Current.md"), "# Current\n", "utf8");
    const kernel = await openKernel(async (point) => {
      if (point === "attachment-batch:before-note-write") {
        await fs.writeFile(
          path.join(vaultPath, "Notes", "Current.md"),
          "# External winner\n",
          "utf8",
        );
      }
    });
    const source = await kernel.readText("Notes/Current.md");
    const result = await kernel.insertAttachmentsWithReference(batchRequest(source.revision));

    expect(result).toMatchObject({
      status: "conflict",
      path: "Notes/Current.md",
      conflictPath: expect.stringMatching(/\.threadleaf-conflict-/u),
      attachments: [
        { attachmentPath: "Assets/first.png" },
        { attachmentPath: "Assets/second.png" },
      ],
    });
    if (result.status !== "conflict") throw new Error("Expected a batch conflict copy.");
    await expect(fs.readFile(path.join(vaultPath, result.conflictPath), "utf8")).resolves.toBe(
      "# Current\n![[../Assets/first.png]]\n![[../Assets/second.png]]\n",
    );
    await expect(fs.readFile(path.join(vaultPath, "Notes", "Current.md"), "utf8")).resolves.toBe(
      "# External winner\n",
    );
  });
});
