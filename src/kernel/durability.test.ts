import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readStableFileWithinLimit, revisionOf } from "./durability";

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
