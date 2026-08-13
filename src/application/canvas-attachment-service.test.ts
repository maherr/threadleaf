import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedStateRoot } from "../kernel/ports";
import { VaultKernel } from "../kernel/vault-kernel";
import {
  loadCanvasAttachment,
  resolveCanvasAttachmentTarget,
  sniffCanvasAttachmentMime,
} from "./canvas-attachment-service";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlL8AAAAASUVORK5CYII=",
  "base64",
);

let sandboxPath: string;
let vaultPath: string;
let kernel: VaultKernel;

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-canvas-attachments-"));
  vaultPath = path.join(sandboxPath, "vault");
  await fs.mkdir(path.join(vaultPath, "Boards", "assets"), { recursive: true });
  await fs.mkdir(path.join(vaultPath, "assets"), { recursive: true });
  await fs.writeFile(path.join(vaultPath, "Boards", "Overview.canvas"), "{}", "utf8");
  kernel = await VaultKernel.open({
    vaultRoot: vaultPath,
    stateRoot: new FixedStateRoot(path.join(sandboxPath, "state")),
  });
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

describe("canvas attachment target safety", () => {
  it("resolves rooted and canvas-relative targets and rejects active content", () => {
    expect(resolveCanvasAttachmentTarget("Boards/Overview.canvas", "assets/image.data")).toEqual({
      status: "resolved",
      path: "assets/image.data",
    });
    expect(resolveCanvasAttachmentTarget("Boards/Overview.canvas", "./assets/image.data")).toEqual({
      status: "resolved",
      path: "Boards/assets/image.data",
    });
    expect(
      resolveCanvasAttachmentTarget("Boards/Overview.canvas", "/Boards/assets/image.data"),
    ).toEqual({
      status: "resolved",
      path: "Boards/assets/image.data",
    });
    expect(
      resolveCanvasAttachmentTarget("Boards/Overview.canvas", "https://example.test/x"),
    ).toMatchObject({
      status: "rejected",
      reason: "external",
    });
    expect(
      resolveCanvasAttachmentTarget("Boards/Overview.canvas", "../.obsidian/app.json"),
    ).toMatchObject({
      status: "rejected",
      reason: "private",
    });
    expect(
      resolveCanvasAttachmentTarget("Boards/Overview.canvas", "../../outside.bin"),
    ).toMatchObject({
      status: "rejected",
      reason: "outside-vault",
    });
  });
});

describe("canvas attachment MIME and bounded reads", () => {
  it("sniffs bytes instead of trusting extensions", () => {
    expect(sniffCanvasAttachmentMime(PNG)).toEqual({ mimeType: "image/png", preview: "image" });
    expect(sniffCanvasAttachmentMime(Buffer.from("%PDF-1.7", "ascii"))).toEqual({
      mimeType: "application/pdf",
      preview: "binary",
    });
    expect(sniffCanvasAttachmentMime(Buffer.from("hello", "utf8"))).toEqual({
      mimeType: "text/plain",
      preview: "text",
    });
    expect(sniffCanvasAttachmentMime(Uint8Array.from([0, 1, 2]))).toEqual({
      mimeType: "application/octet-stream",
      preview: "binary",
    });
  });

  it("returns image/text previews, never executable HTML, and no bytes on limit failure", async () => {
    await fs.writeFile(path.join(vaultPath, "assets", "pixel.unknown"), PNG);
    await fs.writeFile(path.join(vaultPath, "assets", "readme.bin"), "safe text", "utf8");
    await fs.writeFile(path.join(vaultPath, "assets", "large.bin"), Buffer.alloc(32, 7));
    await expect(
      loadCanvasAttachment(
        kernel,
        "Boards/Overview.canvas",
        "assets/pixel.unknown",
        kernel.vaultId,
      ),
    ).resolves.toMatchObject({ status: "ready", mimeType: "image/png", preview: "image" });
    const text = await loadCanvasAttachment(
      kernel,
      "Boards/Overview.canvas",
      "assets/readme.bin",
      kernel.vaultId,
    );
    expect(text).toMatchObject({
      status: "ready",
      mimeType: "text/plain",
      preview: "text",
      text: "safe text",
    });
    expect("base64" in text && text.base64).toBe(false);
    const bounded = await loadCanvasAttachment(
      kernel,
      "Boards/Overview.canvas",
      "assets/large.bin",
      kernel.vaultId,
      { maxBytes: 8 },
    );
    expect(bounded).toMatchObject({ status: "unavailable", reason: "too-large" });
    expect("base64" in bounded || "text" in bounded).toBe(false);
  });
});
