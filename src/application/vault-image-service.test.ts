import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedStateRoot } from "../kernel/ports";
import { VaultKernel } from "../kernel/vault-kernel";
import {
  loadVaultImage,
  resolveVaultImageTarget,
  sniffVaultImageMime,
} from "./vault-image-service";

const pngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlL8AAAAASUVORK5CYII=",
  "base64",
);

let sandboxPath: string;
let vaultPath: string;
let kernel: VaultKernel;

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-images-"));
  vaultPath = path.join(sandboxPath, "vault");
  await fs.mkdir(path.join(vaultPath, "Notes"), { recursive: true });
  await fs.mkdir(path.join(vaultPath, "assets"), { recursive: true });
  await fs.writeFile(path.join(vaultPath, "Notes", "Current.md"), "# Current", "utf8");
  kernel = await VaultKernel.open({
    vaultRoot: vaultPath,
    stateRoot: new FixedStateRoot(path.join(sandboxPath, "state")),
  });
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

describe("vault image target resolution", () => {
  it("resolves note-relative, parent-relative, rooted, encoded, and bracketed targets", () => {
    expect(resolveVaultImageTarget("Notes/Current.md", "photo.png")).toEqual({
      status: "resolved",
      path: "Notes/photo.png",
    });
    expect(resolveVaultImageTarget("Notes/Current.md", "../assets/photo%20one.png#crop")).toEqual({
      status: "resolved",
      path: "assets/photo one.png",
    });
    expect(resolveVaultImageTarget("Notes/Current.md", "/assets/photo.png?cache=1")).toEqual({
      status: "resolved",
      path: "assets/photo.png",
    });
    expect(resolveVaultImageTarget("Notes/Current.md", "<../assets/photo one.png>")).toEqual({
      status: "resolved",
      path: "assets/photo one.png",
    });
  });

  it("rejects external, private, malformed, and escaping targets before filesystem access", () => {
    expect(resolveVaultImageTarget("Notes/Current.md", "https://example.com/a.png")).toMatchObject({
      status: "rejected",
      reason: "external",
    });
    expect(resolveVaultImageTarget("Notes/Current.md", "//example.com/a.png")).toMatchObject({
      status: "rejected",
      reason: "external",
    });
    expect(resolveVaultImageTarget("Notes/Current.md", "/.obsidian/theme.png")).toMatchObject({
      status: "rejected",
      reason: "private",
    });
    expect(resolveVaultImageTarget("Notes/Current.md", "../../../outside.png")).toMatchObject({
      status: "rejected",
      reason: "outside-vault",
    });
    expect(resolveVaultImageTarget("Notes/Current.md", "%E0%A4%A")).toMatchObject({
      status: "rejected",
      reason: "invalid",
    });
    expect(resolveVaultImageTarget("not-an-image.txt", "image.png")).toMatchObject({
      status: "rejected",
      reason: "invalid",
    });
  });
});

describe("vault image MIME sniffing", () => {
  it("recognizes only the supported raster signatures", () => {
    expect(sniffVaultImageMime(pngBytes)).toBe("image/png");
    expect(sniffVaultImageMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffVaultImageMime(Buffer.from("GIF89a", "ascii"))).toBe("image/gif");
    expect(
      sniffVaultImageMime(Buffer.concat([Buffer.from("RIFF0000WEBP", "ascii"), Buffer.alloc(4)])),
    ).toBe("image/webp");
    expect(sniffVaultImageMime(Buffer.from("<svg></svg>", "utf8"))).toBeNull();
    expect(sniffVaultImageMime(Buffer.from("not really a png", "utf8"))).toBeNull();
  });
});

describe("vault image loading", () => {
  it("reads sniffed image bytes through the contained kernel boundary", async () => {
    await fs.writeFile(path.join(vaultPath, "assets", "pixel.data"), pngBytes);

    const response = await loadVaultImage(
      kernel,
      "Notes/Current.md",
      "../assets/pixel.data",
      kernel.vaultId,
    );

    expect(response).toMatchObject({
      status: "ready",
      vaultId: kernel.vaultId,
      path: "assets/pixel.data",
      mimeType: "image/png",
      size: pngBytes.length,
      base64: pngBytes.toString("base64"),
    });
    expect(response.status === "ready" ? response.revision : "").toMatch(/^[a-f0-9]{64}$/);
  });

  it("uses bytes rather than extensions and reports unsupported content", async () => {
    await fs.writeFile(path.join(vaultPath, "assets", "actually-image.txt"), pngBytes);
    await fs.writeFile(path.join(vaultPath, "assets", "spoofed.png"), "plain text", "utf8");

    await expect(
      loadVaultImage(kernel, "Notes/Current.md", "../assets/actually-image.txt", kernel.vaultId),
    ).resolves.toMatchObject({ status: "ready", mimeType: "image/png" });
    await expect(
      loadVaultImage(kernel, "Notes/Current.md", "../assets/spoofed.png", kernel.vaultId),
    ).resolves.toMatchObject({ status: "unavailable", reason: "unsupported" });
  });

  it("rejects stale identities, missing files, and bounded reads without leaking bytes", async () => {
    await fs.writeFile(path.join(vaultPath, "assets", "large.png"), pngBytes);

    await expect(
      loadVaultImage(kernel, "Notes/Current.md", "../assets/large.png", "stale-vault"),
    ).resolves.toEqual({ status: "stale-vault", vaultId: kernel.vaultId });
    await expect(
      loadVaultImage(kernel, "Notes/Current.md", "../assets/missing.png", kernel.vaultId),
    ).resolves.toMatchObject({ status: "unavailable", reason: "missing" });
    const bounded = await loadVaultImage(
      kernel,
      "Notes/Current.md",
      "../assets/large.png",
      kernel.vaultId,
      { maxBytes: 8 },
    );
    expect(bounded).toMatchObject({ status: "unavailable", reason: "too-large" });
    expect("base64" in bounded).toBe(false);
  });

  it("accepts internal symlinks but rejects symlinks that resolve outside the vault", async () => {
    await fs.writeFile(path.join(vaultPath, "assets", "inside.png"), pngBytes);
    const outsidePath = path.join(sandboxPath, "outside.png");
    await fs.writeFile(outsidePath, pngBytes);
    await fs.symlink("inside.png", path.join(vaultPath, "assets", "inside-link.png"));
    await fs.symlink(outsidePath, path.join(vaultPath, "assets", "outside-link.png"));

    await expect(
      loadVaultImage(kernel, "Notes/Current.md", "../assets/inside-link.png", kernel.vaultId),
    ).resolves.toMatchObject({ status: "ready", path: "assets/inside-link.png" });
    await expect(
      loadVaultImage(kernel, "Notes/Current.md", "../assets/outside-link.png", kernel.vaultId),
    ).resolves.toMatchObject({ status: "unavailable", reason: "outside-vault" });
  });

  it("does not render a public-looking symlink into private vault configuration", async () => {
    await fs.mkdir(path.join(vaultPath, ".obsidian"), { recursive: true });
    await fs.writeFile(path.join(vaultPath, ".obsidian", "private.png"), pngBytes);
    await fs.symlink(
      "../.obsidian/private.png",
      path.join(vaultPath, "assets", "public-looking.png"),
    );

    await expect(
      loadVaultImage(kernel, "Notes/Current.md", "../assets/public-looking.png", kernel.vaultId),
    ).resolves.toMatchObject({ status: "unavailable", reason: "private" });
  });

  it("returns a fresh revision after an external image edit", async () => {
    const imagePath = path.join(vaultPath, "assets", "changing.png");
    await fs.writeFile(imagePath, pngBytes);
    const first = await loadVaultImage(
      kernel,
      "Notes/Current.md",
      "../assets/changing.png",
      kernel.vaultId,
    );
    await fs.writeFile(imagePath, Buffer.concat([pngBytes, Buffer.from("changed")]));
    const second = await loadVaultImage(
      kernel,
      "Notes/Current.md",
      "../assets/changing.png",
      kernel.vaultId,
    );

    expect(first.status).toBe("ready");
    expect(second.status).toBe("ready");
    if (first.status === "ready" && second.status === "ready") {
      expect(second.revision).not.toBe(first.revision);
      expect(second.base64).not.toBe(first.base64);
    }
  });
});
