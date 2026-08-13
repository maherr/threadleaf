import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertContainedPublishCapability,
  ContainedDurabilityError,
  FILE_PUBLISH_CAPABILITY,
  installContainedStagedFile,
  installStagedFile,
  moveContainedFileAside,
  probeContainedPublishCapability,
  readStableFileWithinLimit,
  removeExpectedContainedFile,
  removeExpectedFilePortably,
  revisionOf,
  strictContainmentSupported,
} from "./durability";

let sandboxPath: string;

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-durability-"));
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

describe("bounded stable file reads", () => {
  it("returns exact bytes and revision when the file stays within the limit", async () => {
    const filePath = path.join(sandboxPath, "ready.bin");
    const bytes = Buffer.from([0, 1, 2, 255]);
    await fs.writeFile(filePath, bytes);

    await expect(readStableFileWithinLimit(filePath, bytes.length)).resolves.toEqual({
      status: "ready",
      snapshot: {
        bytes,
        revision: revisionOf(bytes),
        size: bytes.length,
      },
    });
  });

  it("refuses an oversized sparse file without reading its contents", async () => {
    const filePath = path.join(sandboxPath, "oversized.bin");
    await fs.writeFile(filePath, Buffer.alloc(0));
    await fs.truncate(filePath, 8 * 1024 * 1024);

    await expect(readStableFileWithinLimit(filePath, 1024)).resolves.toEqual({
      status: "too-large",
      size: 8 * 1024 * 1024,
    });
  });

  it.runIf(process.platform !== "win32")("refuses a final symlink", async () => {
    const targetPath = path.join(sandboxPath, "target.bin");
    const linkPath = path.join(sandboxPath, "link.bin");
    await fs.writeFile(targetPath, "private target", "utf8");
    await fs.symlink(targetPath, linkPath);

    await expect(readStableFileWithinLimit(linkPath, 1024)).rejects.toMatchObject({
      code: "ELOOP",
    });
  });
});

describe("durable mutation platform contract", () => {
  it("exposes the narrow strict-containment platform contract", () => {
    expect(strictContainmentSupported).toBe(
      process.platform === "linux" && Boolean(constants.O_DIRECTORY && constants.O_NOFOLLOW),
    );
  });

  it.runIf(process.platform !== "linux")(
    "fails explicitly for strict attachment containment without support",
    async () => {
      await expect(
        installContainedStagedFile(
          path.join(sandboxPath, "staged.bin"),
          path.join(sandboxPath, "target.bin"),
        ),
      ).rejects.toBeInstanceOf(ContainedDurabilityError);
    },
  );

  it.runIf(process.platform === "linux")(
    "publishes an exact attachment copy without leaving a target-parent stage",
    async () => {
      const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-attachment-state-"));
      try {
        const stagedPath = path.join(privateRoot, "source.bin");
        const targetPath = path.join(sandboxPath, "published.bin");
        const bytes = Buffer.from([0, 1, 2, 255, 10]);
        await fs.writeFile(stagedPath, bytes);
        const unlink = vi
          .spyOn(fs, "unlink")
          .mockRejectedValue(new Error("attachment publication must not clean by pathname"));
        try {
          await expect(installContainedStagedFile(stagedPath, targetPath)).resolves.toBe(true);
          expect(unlink).not.toHaveBeenCalled();
        } finally {
          unlink.mockRestore();
        }
        await expect(fs.readFile(targetPath)).resolves.toEqual(bytes);
        await expect(fs.readFile(stagedPath)).resolves.toEqual(bytes);
        await expect(
          fs
            .readdir(sandboxPath)
            .then((entries) =>
              entries.filter((entry) => entry.startsWith(".threadleaf-attachment-stage-")),
            ),
        ).resolves.toEqual([]);
      } finally {
        await fs.rm(privateRoot, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "does not expose a replaceable target-side stage before publication",
    async () => {
      const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-attachment-state-"));
      const stagedPath = path.join(privateRoot, "source.bin");
      const targetPath = path.join(sandboxPath, "descriptor-published.bin");
      const expected = Buffer.from("expected attachment bytes", "utf8");
      let sawReplaceableStage = false;
      const originalOpen = fs.open.bind(fs);
      const open = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
        const handle =
          mode === undefined
            ? await originalOpen(filePath, flags)
            : await originalOpen(filePath, flags, mode);
        if (
          !sawReplaceableStage &&
          typeof filePath === "string" &&
          filePath.includes(".threadleaf-attachment-stage-") &&
          typeof flags === "number" &&
          (flags & (constants.O_WRONLY | constants.O_RDWR)) === 0
        ) {
          sawReplaceableStage = true;
          const originalClose = handle.close.bind(handle);
          handle.close = async () => {
            await originalClose();
            await fs.rename(filePath, `${filePath}.expected`);
            await fs.writeFile(filePath, "external stage replacement", "utf8");
          };
        }
        return handle;
      });
      try {
        await fs.writeFile(stagedPath, expected);
        await expect(installContainedStagedFile(stagedPath, targetPath)).resolves.toBe(true);
        expect(sawReplaceableStage).toBe(false);
        await expect(fs.readFile(targetPath)).resolves.toEqual(expected);
      } finally {
        open.mockRestore();
        await fs.rm(privateRoot, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "preserves a target claimant without exposing a generated stage when publication collides",
    async () => {
      const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-attachment-state-"));
      try {
        const stagedPath = path.join(privateRoot, "source.bin");
        const targetPath = path.join(sandboxPath, "collision.bin");
        await fs.writeFile(stagedPath, "source bytes", "utf8");
        await fs.writeFile(targetPath, "external target", "utf8");
        await expect(installContainedStagedFile(stagedPath, targetPath)).resolves.toBe(false);
        await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("external target");
        const stages = (await fs.readdir(sandboxPath)).filter((entry) =>
          entry.startsWith(".threadleaf-attachment-stage-"),
        );
        expect(stages).toEqual([]);
        await expect(fs.readFile(stagedPath, "utf8")).resolves.toBe("source bytes");
      } finally {
        await fs.rm(privateRoot, { recursive: true, force: true });
      }
    },
  );

  it("cleans ordinary private staging without retaining a full claim copy", async () => {
    const bytes = Buffer.from("ordinary private staging");
    for (let index = 0; index < 8; index += 1) {
      const stagedPath = path.join(sandboxPath, `ordinary-stage-${index}.bin`);
      const targetPath = path.join(sandboxPath, `ordinary-target-${index}.bin`);
      await fs.writeFile(stagedPath, bytes);
      await expect(installStagedFile(stagedPath, targetPath)).resolves.toBe(true);
      await expect(fs.readFile(targetPath)).resolves.toEqual(bytes);
      await expect(fs.stat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(
      fs
        .readdir(sandboxPath)
        .then((entries) => entries.filter((entry) => entry.startsWith(".threadleaf-claim-"))),
    ).resolves.toEqual([]);
  });

  it.runIf(process.platform === "linux")(
    "does not authorize strict vault-claim cleanup without private authority",
    async () => {
      const filePath = path.join(sandboxPath, "vault-claim.bin");
      const bytes = Buffer.from("vault evidence");
      await fs.writeFile(filePath, bytes);

      await expect(removeExpectedContainedFile(filePath, revisionOf(bytes))).resolves.toBe(false);
      await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        fs
          .readdir(sandboxPath)
          .then((entries) => entries.filter((entry) => entry.startsWith(".threadleaf-claim-"))),
      ).resolves.toHaveLength(1);
    },
  );

  it.runIf(process.platform === "linux")(
    "never unlinks a strict private claim through its mutable pathname",
    async () => {
      const filePath = path.join(sandboxPath, "private-claim.bin");
      const bytes = Buffer.from("private claim evidence");
      await fs.writeFile(filePath, bytes);
      const unlink = vi
        .spyOn(fs, "unlink")
        .mockRejectedValue(new Error("strict claim cleanup must not unlink by pathname"));
      try {
        await expect(
          removeExpectedContainedFile(filePath, revisionOf(bytes), {
            claimAuthority: "private",
            cleanupClaim: true,
          }),
        ).resolves.toBe(false);
        expect(unlink).not.toHaveBeenCalled();
      } finally {
        unlink.mockRestore();
      }
      await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
      const claims = (await fs.readdir(sandboxPath)).filter((entry) =>
        entry.startsWith(".threadleaf-claim-"),
      );
      expect(claims).toHaveLength(1);
      const claim = claims[0];
      if (!claim) throw new Error("strict private claim was not retained");
      await expect(fs.readFile(path.join(sandboxPath, claim))).resolves.toEqual(bytes);
    },
  );

  it.runIf(process.platform === "linux")(
    "preflights no-clobber publication without creating or deleting vault names",
    async () => {
      const before = await fs.readdir(sandboxPath);
      await expect(probeContainedPublishCapability(sandboxPath)).resolves.toMatchObject({
        status: "supported",
        contract: FILE_PUBLISH_CAPABILITY,
      });
      await expect(fs.readdir(sandboxPath)).resolves.toEqual(before);
    },
  );

  it.runIf(process.platform === "linux")(
    "rejects a destination parent on another device before publication",
    async () => {
      const capability = await probeContainedPublishCapability(sandboxPath);
      if (capability.status !== "supported") return;
      const destination = await fs.mkdtemp(path.join("/dev/shm", "threadleaf-publish-target-"));
      try {
        await expect(
          assertContainedPublishCapability(capability, destination),
        ).rejects.toMatchObject({
          code: "cross-device",
          contract: FILE_PUBLISH_CAPABILITY,
        });
      } finally {
        await fs.rm(destination, { recursive: true, force: true });
      }
    },
  );
});

describe("claim-then-verify removal", () => {
  it.runIf(process.platform === "linux")(
    "retains the claimed expected inode when a winner appears after claim",
    async () => {
      const filePath = path.join(sandboxPath, "source.bin");
      const retentionPath = path.join(sandboxPath, "retained");
      await fs.writeFile(filePath, "expected", "utf8");
      const replacement = path.join(sandboxPath, "replacement.bin");
      let calls = 0;
      const removed = await removeExpectedContainedFile(
        filePath,
        revisionOf(Buffer.from("expected")),
        {
          retentionDirectory: retentionPath,
          afterClaim: async () => {
            if (calls++ !== 0) return;
            await fs.writeFile(replacement, "external winner", "utf8");
            await fs.rename(replacement, filePath);
          },
        },
      );

      expect(removed).toBe(false);
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("external winner");
      await expect(
        fs
          .readdir(sandboxPath)
          .then((entries) => entries.filter((entry) => entry.startsWith(".threadleaf-claim-"))),
      ).resolves.toEqual([]);
      await expect(
        fs.readdir(retentionPath).then(async (entries) => {
          expect(entries).toHaveLength(1);
          const entry = entries[0];
          if (!entry) throw new Error("retained claim is missing");
          return fs.readFile(path.join(retentionPath, entry), "utf8");
        }),
      ).resolves.toBe("expected");
    },
  );

  it.runIf(process.platform === "linux")(
    "retains a changed quarantine winner instead of deleting it",
    async () => {
      const filePath = path.join(sandboxPath, "source.bin");
      const retentionPath = path.join(sandboxPath, "retained");
      await fs.writeFile(filePath, "expected", "utf8");
      const expectedRevision = revisionOf(Buffer.from("expected"));
      let claimPath = "";
      const removed = await removeExpectedContainedFile(filePath, expectedRevision, {
        retentionDirectory: retentionPath,
        afterClaim: async () => {
          claimPath =
            (await fs.readdir(sandboxPath)).find((entry) =>
              entry.startsWith(".threadleaf-claim-"),
            ) ?? "";
          if (!claimPath) throw new Error("quarantine was not created");
          const replacement = path.join(sandboxPath, "quarantine-replacement.bin");
          await fs.writeFile(replacement, "quarantine winner", "utf8");
          await fs.rename(replacement, path.join(sandboxPath, claimPath));
        },
      });

      expect(removed).toBe(false);
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("quarantine winner");
      await expect(
        fs
          .readdir(sandboxPath)
          .then((entries) => entries.filter((entry) => entry.startsWith(".threadleaf-claim-"))),
      ).resolves.toHaveLength(1);
      await expect(fs.stat(retentionPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.runIf(process.platform === "linux")(
    "does not recreate bytes when the claimed quarantine disappears",
    async () => {
      const filePath = path.join(sandboxPath, "source.bin");
      await fs.writeFile(filePath, "expected", "utf8");
      const expectedRevision = revisionOf(Buffer.from("expected"));
      const removed = await removeExpectedContainedFile(filePath, expectedRevision, {
        afterClaim: async () => {
          const claimPath = (await fs.readdir(sandboxPath)).find((entry) =>
            entry.startsWith(".threadleaf-claim-"),
          );
          if (!claimPath) throw new Error("quarantine was not created");
          await fs.unlink(path.join(sandboxPath, claimPath));
        },
      });

      expect(removed).toBe(false);
      await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        fs
          .readdir(sandboxPath)
          .then((entries) => entries.filter((entry) => entry.startsWith(".threadleaf-claim-"))),
      ).resolves.toEqual([]);
    },
  );

  it.runIf(process.platform === "linux")(
    "retains a strict claim when the post-claim hook fails",
    async () => {
      const filePath = path.join(sandboxPath, "strict-hook.bin");
      const retentionPath = path.join(sandboxPath, "strict-retained");
      const bytes = Buffer.from("strict writer");
      await fs.writeFile(filePath, bytes);
      await expect(
        removeExpectedContainedFile(filePath, revisionOf(bytes), {
          retentionDirectory: retentionPath,
          afterClaim: async () => {
            await fs.writeFile(filePath, "external winner", "utf8");
            throw new Error("interrupt after strict claim");
          },
        }),
      ).rejects.toThrow("interrupt after strict claim");
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("external winner");
      await expect(
        fs.readdir(retentionPath).then(async (entries) => {
          expect(entries).toHaveLength(1);
          const entry = entries[0];
          if (!entry) throw new Error("retained claim is missing");
          return fs.readFile(path.join(retentionPath, entry), "utf8");
        }),
      ).resolves.toBe("strict writer");
    },
  );

  it.runIf(process.platform === "linux")(
    "keeps both rollback bytes and a source winner across the held-parent claim",
    async () => {
      const targetPath = path.join(sandboxPath, "target.bin");
      const rollbackPath = path.join(sandboxPath, "rollback.bin");
      const retentionPath = path.join(sandboxPath, "rollback-retained");
      const expected = Buffer.from("rollback bytes");
      await fs.writeFile(targetPath, expected);
      const removed = await moveContainedFileAside(
        targetPath,
        rollbackPath,
        revisionOf(expected),
        retentionPath,
        {
          afterValidation: async () => {
            const replacement = path.join(sandboxPath, "replacement.bin");
            await fs.writeFile(replacement, "external source", "utf8");
            await fs.rename(replacement, targetPath);
          },
        },
      );

      expect(removed).toBe(false);
      await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("external source");
      await expect(fs.readFile(rollbackPath)).resolves.toEqual(expected);
      await expect(
        fs
          .readdir(sandboxPath)
          .then((entries) => entries.filter((entry) => entry.startsWith(".threadleaf-claim-"))),
      ).resolves.toHaveLength(1);
      await expect(fs.stat(retentionPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.runIf(process.platform === "linux")(
    "copies retained claim evidence across devices without a false removal",
    async () => {
      const filePath = path.join(sandboxPath, "cross-device.bin");
      const retentionPath = await fs.mkdtemp(path.join("/dev/shm", "threadleaf-retained-"));
      const bytes = Buffer.from("cross-device evidence");
      try {
        await fs.writeFile(filePath, bytes);
        await expect(
          removeExpectedContainedFile(filePath, revisionOf(bytes), {
            retentionDirectory: retentionPath,
          }),
        ).resolves.toBe(false);
        await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
        const entries = await fs.readdir(retentionPath);
        expect(entries).toHaveLength(1);
        const entry = entries[0];
        if (!entry) throw new Error("cross-device evidence is missing");
        await expect(fs.readFile(path.join(retentionPath, entry))).resolves.toEqual(bytes);
        await expect(
          fs
            .readdir(sandboxPath)
            .then((names) => names.filter((name) => name.startsWith(".threadleaf-claim-"))),
        ).resolves.toHaveLength(1);
      } finally {
        await fs.rm(retentionPath, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "copies portable retained claim evidence across devices",
    async () => {
      const filePath = path.join(sandboxPath, "portable-cross-device.bin");
      const retentionPath = await fs.mkdtemp(path.join("/dev/shm", "threadleaf-retained-"));
      const bytes = Buffer.from("portable cross-device evidence");
      try {
        await fs.writeFile(filePath, bytes);
        await expect(
          removeExpectedFilePortably(filePath, revisionOf(bytes), {
            retentionDirectory: retentionPath,
          }),
        ).resolves.toBe(false);
        await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
        const entries = await fs.readdir(retentionPath);
        expect(entries).toHaveLength(1);
        const entry = entries[0];
        if (!entry) throw new Error("portable cross-device evidence is missing");
        await expect(fs.readFile(path.join(retentionPath, entry))).resolves.toEqual(bytes);
        await expect(
          fs
            .readdir(sandboxPath)
            .then((names) => names.filter((name) => name.startsWith(".threadleaf-claim-"))),
        ).resolves.toHaveLength(1);
      } finally {
        await fs.rm(retentionPath, { recursive: true, force: true });
      }
    },
  );

  it("keeps ordinary writers available on every platform", async () => {
    const filePath = path.join(sandboxPath, "portable.bin");
    const bytes = Buffer.from("ordinary writer");
    await fs.writeFile(filePath, bytes);
    await expect(removeExpectedFilePortably(filePath, revisionOf(bytes))).resolves.toBe(true);
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs
        .readdir(sandboxPath)
        .then((entries) => entries.filter((entry) => entry.startsWith(".threadleaf-claim-"))),
    ).resolves.toEqual([]);
  });

  it.runIf(process.platform === "linux")(
    "does not move a claimant installed at the final strict settlement barrier",
    async () => {
      const filePath = path.join(sandboxPath, "strict-cleanup-barrier.bin");
      const bytes = Buffer.from("expected strict bytes");
      await fs.writeFile(filePath, bytes);
      const removed = await removeExpectedContainedFile(filePath, revisionOf(bytes), {
        beforeCleanup: async () => {
          const claimName = (await fs.readdir(sandboxPath)).find((entry) =>
            entry.startsWith(".threadleaf-claim-"),
          );
          if (!claimName) throw new Error("claim was not created");
          await fs.writeFile(path.join(sandboxPath, "strict-cleanup-winner"), "winner", "utf8");
          await fs.rename(
            path.join(sandboxPath, "strict-cleanup-winner"),
            path.join(sandboxPath, claimName),
          );
        },
      });

      expect(removed).toBe(false);
      await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        fs
          .readdir(sandboxPath)
          .then((names) => names.filter((name) => name.startsWith(".threadleaf-claim-"))),
      ).resolves.toHaveLength(1);
    },
  );

  it("does not delete a claimant installed at the final portable cleanup barrier", async () => {
    const filePath = path.join(sandboxPath, "portable-cleanup-barrier.bin");
    const bytes = Buffer.from("expected portable bytes");
    await fs.writeFile(filePath, bytes);
    const removed = await removeExpectedFilePortably(filePath, revisionOf(bytes), {
      beforeCleanup: async () => {
        const claimName = (await fs.readdir(sandboxPath)).find((entry) =>
          entry.startsWith(".threadleaf-claim-"),
        );
        if (!claimName) throw new Error("claim was not created");
        await fs.writeFile(path.join(sandboxPath, "portable-cleanup-winner"), "winner", "utf8");
        await fs.rename(
          path.join(sandboxPath, "portable-cleanup-winner"),
          path.join(sandboxPath, claimName),
        );
      },
    });

    expect(removed).toBe(false);
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs
        .readdir(sandboxPath)
        .then((names) => names.filter((name) => name.startsWith(".threadleaf-claim-"))),
    ).resolves.toHaveLength(1);
  });

  it("preserves a portable claim when the post-claim hook fails", async () => {
    const filePath = path.join(sandboxPath, "portable-hook.bin");
    const retentionPath = path.join(sandboxPath, "portable-retained");
    const bytes = Buffer.from("ordinary writer");
    await fs.writeFile(filePath, bytes);
    await expect(
      removeExpectedFilePortably(filePath, revisionOf(bytes), {
        retentionDirectory: retentionPath,
        afterClaim: async () => {
          await fs.writeFile(filePath, "external winner", "utf8");
          throw new Error("interrupt after claim");
        },
      }),
    ).rejects.toThrow("interrupt after claim");
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("external winner");
    await expect(
      fs.readdir(retentionPath).then(async (entries) => {
        expect(entries).toHaveLength(1);
        const entry = entries[0];
        if (!entry) throw new Error("retained claim is missing");
        return fs.readFile(path.join(retentionPath, entry), "utf8");
      }),
    ).resolves.toBe("ordinary writer");
  });
});
