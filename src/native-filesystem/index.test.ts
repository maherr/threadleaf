import { promises as fs, constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { type NativeFilesystemError, renameNoReplace } from "./index.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-native-filesystem-test-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("native filesystem", () => {
  it.runIf(process.platform === "linux")(
    "moves an exact source without replacing an existing target",
    async () => {
      const root = await temporaryRoot();
      const source = path.join(root, "source.bin");
      const target = path.join(root, "target.bin");
      await fs.writeFile(source, "source", "utf8");

      renameNoReplace(source, target);
      await expect(fs.stat(source)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile(target, "utf8")).resolves.toBe("source");

      const claimant = path.join(root, "claimant.bin");
      await fs.writeFile(claimant, "claimant", "utf8");
      expect(() => renameNoReplace(claimant, target)).toThrowError(
        expect.objectContaining<Partial<NativeFilesystemError>>({ code: "exists" }),
      );
      await expect(fs.readFile(claimant, "utf8")).resolves.toBe("claimant");
      await expect(fs.readFile(target, "utf8")).resolves.toBe("source");
    },
  );

  it.runIf(process.platform === "linux")(
    "publishes through a held directory descriptor without replacing a claimant",
    async () => {
      const root = await temporaryRoot();
      const source = path.join(root, "descriptor-source.bin");
      const target = path.join(root, "descriptor-target.bin");
      await fs.writeFile(source, "source", "utf8");
      const directory = await fs.open(root, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
      try {
        const heldRoot = path.join("/proc/self/fd", String(directory.fd));
        renameNoReplace(
          path.join(heldRoot, path.basename(source)),
          path.join(heldRoot, path.basename(target)),
        );
      } finally {
        await directory.close();
      }
      await expect(fs.stat(source)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile(target, "utf8")).resolves.toBe("source");
    },
  );

  it("rejects relative and empty paths before native dispatch", () => {
    expect(() => renameNoReplace("relative", "/target")).toThrowError(
      expect.objectContaining<Partial<NativeFilesystemError>>({ code: "invalid" }),
    );
    expect(() => renameNoReplace("/source", "")).toThrowError(
      expect.objectContaining<Partial<NativeFilesystemError>>({ code: "invalid" }),
    );
  });
});
