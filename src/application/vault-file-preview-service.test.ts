import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedStateRoot } from "../kernel/ports";
import { VaultKernel } from "../kernel/vault-kernel";
import type { VaultFilePreviewReader } from "./vault-file-preview-service";
import {
  DEFAULT_VAULT_FILE_PREVIEW_MAX_BYTES,
  loadVaultFilePreview,
  MAX_VAULT_FILE_PREVIEW_TEXT_BYTES,
} from "./vault-file-preview-service";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlL8AAAAASUVORK5CYII=",
  "base64",
);

let sandboxPath: string;
let vaultPath: string;
let kernel: VaultKernel;

async function visiblePaths(): Promise<string[]> {
  return (await kernel.listVisiblePaths()).files;
}

function previewOptions(paths: readonly string[], overrides = {}) {
  return { visiblePaths: paths, ...overrides };
}

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-file-preview-"));
  vaultPath = path.join(sandboxPath, "vault");
  await fs.mkdir(path.join(vaultPath, "Notes"), { recursive: true });
  await fs.mkdir(path.join(vaultPath, "Assets"), { recursive: true });
  await fs.mkdir(path.join(vaultPath, ".obsidian"), { recursive: true });
  await fs.writeFile(path.join(vaultPath, "readme.txt"), "Hello from an ordinary file.", "utf8");
  await fs.writeFile(
    path.join(vaultPath, "hostile.html"),
    "<script>window.__threadleafExecuted = true;</script>",
    "utf8",
  );
  await fs.writeFile(path.join(vaultPath, "pixel.txt"), PNG);
  await fs.writeFile(path.join(vaultPath, "spoofed.png"), "plain text, not an image", "utf8");
  await fs.writeFile(path.join(vaultPath, "report.bin"), "%PDF-1.7\nfixture", "ascii");
  await fs.writeFile(path.join(vaultPath, "random.bin"), Uint8Array.from([0, 1, 2, 3]));
  await fs.writeFile(path.join(vaultPath, "missing.txt"), "temporary", "utf8");
  await fs.rm(path.join(vaultPath, "missing.txt"));
  await fs.writeFile(path.join(vaultPath, "Notes", "Note.md"), "# A note\n", "utf8");
  await fs.writeFile(path.join(vaultPath, "Notes", "Board.canvas"), "{}\n", "utf8");
  await fs.writeFile(path.join(vaultPath, ".obsidian", "secret.txt"), "private", "utf8");
  await fs.writeFile(path.join(vaultPath, ".hidden.txt"), "hidden", "utf8");
  kernel = await VaultKernel.open({
    vaultRoot: vaultPath,
    stateRoot: new FixedStateRoot(path.join(sandboxPath, "state")),
  });
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

describe("direct ordinary-file preview", () => {
  it("returns a bounded UTF-8 text preview independent of the filename", async () => {
    const paths = await visiblePaths();
    const response = await loadVaultFilePreview(
      kernel,
      "readme.txt",
      kernel.vaultId,
      previewOptions(paths),
    );

    expect(response).toMatchObject({
      status: "ready",
      vaultId: kernel.vaultId,
      path: "readme.txt",
      kind: "text",
      mimeType: "text/plain",
      preview: "text",
      text: "Hello from an ordinary file.",
      truncated: false,
    });
    expect(response.status === "ready" && response.revision).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("returns hostile HTML as inert text payload rather than an executable representation", async () => {
    const response = await loadVaultFilePreview(
      kernel,
      "hostile.html",
      kernel.vaultId,
      previewOptions(await visiblePaths()),
    );

    expect(response).toMatchObject({
      status: "ready",
      preview: "text",
      kind: "text",
      mimeType: "text/plain",
      text: "<script>window.__threadleafExecuted = true;</script>",
      truncated: false,
    });
    if (response.status === "ready") {
      expect(response).not.toHaveProperty("base64");
    }
  });

  it("trims a multibyte boundary without producing a replacement character", async () => {
    const prefix = Buffer.alloc(MAX_VAULT_FILE_PREVIEW_TEXT_BYTES - 1, 0x61);
    const content = Buffer.concat([prefix, Buffer.from("€", "utf8"), Buffer.from("\n", "utf8")]);
    await fs.writeFile(path.join(vaultPath, "boundary.txt"), content);

    const response = await loadVaultFilePreview(
      kernel,
      "boundary.txt",
      kernel.vaultId,
      previewOptions([...(await visiblePaths()), "boundary.txt"]),
    );

    expect(response).toMatchObject({
      status: "ready",
      preview: "text",
      truncated: true,
    });
    if (response.status === "ready") {
      expect(response.preview).toBe("text");
      if (response.preview === "text") {
        expect(response.text).toBeDefined();
        if (response.text !== undefined) {
          expect(response.text).toHaveLength(MAX_VAULT_FILE_PREVIEW_TEXT_BYTES - 1);
          expect(response.text.endsWith("\ufffd")).toBe(false);
          expect(response.text.endsWith("a")).toBe(true);
        }
      }
    }
  });

  it("sniffs raster bytes instead of trusting a spoofed extension", async () => {
    const paths = await visiblePaths();
    const raster = await loadVaultFilePreview(
      kernel,
      "pixel.txt",
      kernel.vaultId,
      previewOptions(paths),
    );
    const spoofed = await loadVaultFilePreview(
      kernel,
      "spoofed.png",
      kernel.vaultId,
      previewOptions(paths),
    );

    expect(raster).toMatchObject({
      status: "ready",
      path: "pixel.txt",
      kind: "image",
      mimeType: "image/png",
      preview: "image",
      base64: PNG.toString("base64"),
    });
    expect(spoofed).toMatchObject({
      status: "ready",
      path: "spoofed.png",
      kind: "text",
      mimeType: "text/plain",
      preview: "text",
      text: "plain text, not an image",
    });
    if (spoofed.status === "ready") expect(spoofed).not.toHaveProperty("base64");
  });

  it("returns PDF and random bytes as metadata without exposing bytes", async () => {
    const paths = await visiblePaths();
    const pdf = await loadVaultFilePreview(
      kernel,
      "report.bin",
      kernel.vaultId,
      previewOptions(paths),
    );
    const random = await loadVaultFilePreview(
      kernel,
      "random.bin",
      kernel.vaultId,
      previewOptions(paths),
    );

    expect(pdf).toMatchObject({
      status: "ready",
      kind: "pdf",
      mimeType: "application/pdf",
      preview: "metadata",
    });
    expect(random).toMatchObject({
      status: "ready",
      kind: "unsupported",
      mimeType: null,
      preview: "metadata",
    });
    for (const response of [pdf, random]) {
      expect(response).not.toHaveProperty("base64");
      expect(response).not.toHaveProperty("text");
      expect(response).not.toHaveProperty("truncated");
    }
  });

  it("returns too-large without returning any preview payload", async () => {
    await fs.writeFile(
      path.join(vaultPath, "large.txt"),
      Buffer.alloc(DEFAULT_VAULT_FILE_PREVIEW_MAX_BYTES + 1, 0x61),
    );
    const response = await loadVaultFilePreview(
      kernel,
      "large.txt",
      kernel.vaultId,
      previewOptions([...(await visiblePaths()), "large.txt"]),
    );

    expect(response).toMatchObject({
      status: "unavailable",
      reason: "too-large",
      path: "large.txt",
      size: DEFAULT_VAULT_FILE_PREVIEW_MAX_BYTES + 1,
    });
    expect(response).not.toHaveProperty("base64");
    expect(response).not.toHaveProperty("text");
  });
});

describe("direct ordinary-file path and identity policy", () => {
  it.each([
    ["", "invalid"],
    ["../outside.txt", "outside-vault"],
    ["/absolute.txt", "outside-vault"],
    ["Notes/Note.md", "document"],
    ["Notes/Board.canvas", "document"],
    [".obsidian/secret.txt", "private"],
    [".hidden.txt", "private"],
  ] as const)("rejects %s as %s", async (requestedPath, reason) => {
    const response = await loadVaultFilePreview(
      kernel,
      requestedPath,
      kernel.vaultId,
      previewOptions(await visiblePaths()),
    );
    expect(response).toMatchObject({ status: "unavailable", reason });
    expect(response).not.toHaveProperty("base64");
    expect(response).not.toHaveProperty("text");
  });

  it("requires exact membership in the injected visible path set", async () => {
    let reads = 0;
    const reader: VaultFilePreviewReader = {
      vaultId: kernel.vaultId,
      resolveReadPath: kernel.resolveReadPath.bind(kernel),
      readBinary: async (relativePath, maxBytes) => {
        reads += 1;
        return kernel.readBinary(relativePath, maxBytes);
      },
    };
    const response = await loadVaultFilePreview(
      reader,
      "readme.txt",
      kernel.vaultId,
      previewOptions([]),
    );

    expect(response).toMatchObject({
      status: "unavailable",
      reason: "not-visible",
      path: "readme.txt",
    });
    expect(reads).toBe(0);
  });

  it("reports an inventory generation mismatch before reading", async () => {
    let reads = 0;
    const reader: VaultFilePreviewReader = {
      vaultId: kernel.vaultId,
      resolveReadPath: kernel.resolveReadPath.bind(kernel),
      readBinary: async (relativePath, maxBytes) => {
        reads += 1;
        return kernel.readBinary(relativePath, maxBytes);
      },
    };
    const response = await loadVaultFilePreview(
      reader,
      "readme.txt",
      kernel.vaultId,
      previewOptions(await visiblePaths(), {
        expectedInventoryGeneration: "old-generation",
        inventoryGeneration: "new-generation",
      }),
    );

    expect(response).toMatchObject({ status: "unavailable", reason: "stale-inventory" });
    expect(reads).toBe(0);
  });

  it("distinguishes a visible path that disappears during the read", async () => {
    const response = await loadVaultFilePreview(
      kernel,
      "missing.txt",
      kernel.vaultId,
      previewOptions([...(await visiblePaths()), "missing.txt"]),
    );

    expect(response).toMatchObject({
      status: "unavailable",
      reason: "missing",
      path: "missing.txt",
    });
  });

  it("rejects a canonical document reached through a contained alias", async () => {
    const aliasPath = path.join(vaultPath, "note-alias.txt");
    await fs.symlink(path.join("Notes", "Note.md"), aliasPath);
    const response = await loadVaultFilePreview(
      kernel,
      "note-alias.txt",
      kernel.vaultId,
      previewOptions([...(await visiblePaths()), "note-alias.txt"]),
    );

    expect(response).toMatchObject({ status: "unavailable", reason: "document" });
  });

  it("rejects an injected visible alias whose canonical target is outside the vault", async () => {
    const outsidePath = path.join(sandboxPath, "outside.txt");
    await fs.writeFile(outsidePath, "outside", "utf8");
    await fs.symlink(outsidePath, path.join(vaultPath, "outside-alias.txt"));

    const response = await loadVaultFilePreview(
      kernel,
      "outside-alias.txt",
      kernel.vaultId,
      previewOptions([...(await visiblePaths()), "outside-alias.txt"]),
    );

    expect(response).toMatchObject({
      status: "unavailable",
      reason: "outside-vault",
      path: "outside-alias.txt",
    });
    expect(response).not.toHaveProperty("base64");
    expect(response).not.toHaveProperty("text");
  });

  it("returns stale-vault before reading and after a read", async () => {
    const paths = await visiblePaths();
    const before = await loadVaultFilePreview(
      kernel,
      "readme.txt",
      "different-vault",
      previewOptions(paths),
    );
    expect(before).toEqual({ status: "stale-vault", vaultId: kernel.vaultId });

    let currentVaultId = kernel.vaultId;
    const reader: VaultFilePreviewReader = {
      get vaultId() {
        return currentVaultId;
      },
      resolveReadPath: kernel.resolveReadPath.bind(kernel),
      readBinary: async (relativePath, maxBytes) => {
        const result = await kernel.readBinary(relativePath, maxBytes);
        currentVaultId = "different-vault";
        return result;
      },
    };
    const after = await loadVaultFilePreview(
      reader,
      "readme.txt",
      kernel.vaultId,
      previewOptions(paths),
    );
    expect(after).toEqual({ status: "stale-vault", vaultId: "different-vault" });
  });
});
