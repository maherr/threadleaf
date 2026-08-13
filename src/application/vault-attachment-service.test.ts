import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedStateRoot } from "../kernel/ports";
import { VaultKernel } from "../kernel/vault-kernel";
import {
  loadVaultAttachment,
  parseVaultAttachmentTarget,
  probeMediaFile,
  resolveVaultAttachmentTarget,
  sniffVaultAttachment,
} from "./vault-attachment-service";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlL8AAAAASUVORK5CYII=",
  "base64",
);

let sandboxPath: string;
let vaultPath: string;
let kernel: VaultKernel;

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-attachments-"));
  vaultPath = path.join(sandboxPath, "vault");
  await fs.mkdir(path.join(vaultPath, "Notes"), { recursive: true });
  await fs.mkdir(path.join(vaultPath, "Assets"), { recursive: true });
  await fs.writeFile(path.join(vaultPath, "Notes", "Current.md"), "# Current", "utf8");
  kernel = await VaultKernel.open({
    vaultRoot: vaultPath,
    stateRoot: new FixedStateRoot(path.join(sandboxPath, "state")),
  });
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

describe("bounded attachment detection", () => {
  it("sniffs common local attachments from magic bytes, independent of extension", () => {
    expect(sniffVaultAttachment(Buffer.from("%PDF-1.7\n", "ascii"))).toEqual({
      kind: "pdf",
      mimeType: "application/pdf",
    });
    expect(sniffVaultAttachment(Buffer.from("ID3\u0004\u0000\u0000", "binary"))).toEqual({
      kind: "audio",
      mimeType: "audio/mpeg",
    });
    expect(sniffVaultAttachment(Buffer.from("RIFF0000WAVE", "ascii"))).toEqual({
      kind: "audio",
      mimeType: "audio/wav",
    });
    expect(sniffVaultAttachment(Buffer.from("RIFF0000AVI ", "ascii"))).toEqual({
      kind: "video",
      mimeType: "video/x-msvideo",
    });
    expect(sniffVaultAttachment(Buffer.from("{\\rtf1\\ansi", "ascii"))).toEqual({
      kind: "document",
      mimeType: "application/rtf",
    });
    expect(sniffVaultAttachment(png)).toEqual({ kind: "image", mimeType: "image/png" });
    expect(sniffVaultAttachment(Buffer.from([0xff, 0x00, 0x91, 0x22]))).toBeNull();
  });

  it("recognizes an Office zip from bounded central-directory names without trusting its suffix", () => {
    const name = Buffer.from("[Content_Types].xml", "ascii");
    const local = Buffer.alloc(30 + name.length);
    local.write("PK\x03\x04", 0, "binary");
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    const central = Buffer.alloc(46 + name.length);
    central.write("PK\x01\x02", 0, "binary");
    central.writeUInt16LE(name.length, 28);
    name.copy(central, 46);
    expect(sniffVaultAttachment(Buffer.concat([local, central]))).toEqual({
      kind: "document",
      mimeType: "application/zip",
    });
  });

  it("resolves local targets while rejecting remote, private, and escaping paths", () => {
    expect(resolveVaultAttachmentTarget("Notes/Current.md", "../Assets/report.PDF#page=2")).toEqual(
      { status: "resolved", path: "Assets/report.PDF" },
    );
    expect(
      resolveVaultAttachmentTarget("Notes/Current.md", "https://example.com/report.pdf"),
    ).toMatchObject({ status: "rejected", reason: "external" });
    expect(
      resolveVaultAttachmentTarget("Notes/Current.md", "../.obsidian/private.pdf"),
    ).toMatchObject({ status: "rejected", reason: "private" });
    expect(resolveVaultAttachmentTarget("Notes/Current.md", "../../outside.pdf")).toMatchObject({
      status: "rejected",
      reason: "outside-vault",
    });
  });

  it("shares the local target parse while retaining an exact query and fragment suffix", () => {
    expect(
      parseVaultAttachmentTarget(
        "Notes/Current.md",
        "../Assets/report%20file.pdf?download=1%26preview=1#page=2",
      ),
    ).toEqual({
      status: "local",
      path: "Assets/report file.pdf",
      suffix: "?download=1%26preview=1#page=2",
      bareName: false,
    });
    expect(
      parseVaultAttachmentTarget("Notes/Current.md", "https://example.test/report.pdf#page=2"),
    ).toMatchObject({ status: "rejected", reason: "external" });
    expect(parseVaultAttachmentTarget("Notes/Current.md", "../Assets/report\\?draft.pdf")).toEqual({
      status: "local",
      path: "Assets/report?draft.pdf",
      suffix: "",
      bareName: false,
    });
  });

  it("returns metadata and open/reveal affordances without inline executable bytes", async () => {
    const bytes = Buffer.from("%PDF-1.7\nfixture", "ascii");
    await fs.writeFile(path.join(vaultPath, "Assets", "report.bin"), bytes);
    const response = await loadVaultAttachment(
      kernel,
      "Notes/Current.md",
      "../Assets/report.bin",
      kernel.vaultId,
    );
    expect(response).toMatchObject({
      status: "ready",
      attachment: {
        path: "Assets/report.bin",
        kind: "pdf",
        mimeType: "application/pdf",
        size: bytes.length,
        actions: { open: true, reveal: true, move: true, inline: false },
      },
    });
    expect(response.status === "ready" && "base64" in response.attachment).toBe(false);
  });

  it("uses Obsidian relative-first and vault-root fallback resolution for nested attachments", async () => {
    await fs.mkdir(path.join(vaultPath, "Drawings", "Assets"), { recursive: true });
    await fs.mkdir(path.join(vaultPath, "Assets", "Ébauche"), { recursive: true });
    await fs.writeFile(
      path.join(vaultPath, "Drawings", "Unicode Scene.excalidraw.md"),
      "![[Assets/Ébauche/diagram.svg]]",
      "utf8",
    );
    await fs.writeFile(
      path.join(vaultPath, "Assets", "Ébauche", "diagram.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
      "utf8",
    );

    await expect(
      loadVaultAttachment(
        kernel,
        "Drawings/Unicode Scene.excalidraw.md",
        "Assets/Ébauche/diagram.svg",
        kernel.vaultId,
      ),
    ).resolves.toMatchObject({
      status: "ready",
      attachment: { path: "Assets/Ébauche/diagram.svg" },
    });

    await fs.writeFile(
      path.join(vaultPath, "Drawings", "Assets", "diagram.pdf"),
      "%PDF-relative",
      "utf8",
    );
    await fs.writeFile(path.join(vaultPath, "Assets", "diagram.pdf"), "%PDF-root", "utf8");
    await expect(
      loadVaultAttachment(
        kernel,
        "Drawings/Unicode Scene.excalidraw.md",
        "Assets/diagram.pdf",
        kernel.vaultId,
      ),
    ).resolves.toMatchObject({
      status: "ready",
      attachment: { path: "Drawings/Assets/diagram.pdf" },
    });
  });

  it("refuses an ambiguous Obsidian basename attachment target", async () => {
    await fs.mkdir(path.join(vaultPath, "Archive"), { recursive: true });
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), "%PDF-assets", "utf8");
    await fs.writeFile(path.join(vaultPath, "Archive", "report.pdf"), "%PDF-archive", "utf8");

    await expect(
      loadVaultAttachment(kernel, "Notes/Current.md", "report.pdf", kernel.vaultId),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: "ambiguous",
    });
  });

  it("honors bounded reads and extension spoofing", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "spoof.pdf"), "plain text", "utf8");
    await fs.writeFile(path.join(vaultPath, "Assets", "large.dat"), Buffer.alloc(32, 0x41));
    await expect(
      loadVaultAttachment(kernel, "Notes/Current.md", "../Assets/spoof.pdf", kernel.vaultId),
    ).resolves.toMatchObject({ status: "ready", attachment: { kind: "text" } });
    await expect(
      loadVaultAttachment(kernel, "Notes/Current.md", "../Assets/large.dat", kernel.vaultId, {
        maxBytes: 8,
      }),
    ).resolves.toMatchObject({ status: "unavailable", reason: "too-large" });
  });
});

describe("kill-timed, length-independent media probing", () => {
  it("puts fast seek before input and returns bounded metadata", async () => {
    let observedBinary = "";
    let observedArgs: readonly string[] = [];
    const result = await probeMediaFile("/contained/recording.mp4", {
      timeoutMs: 321,
      run: async (binary, args, timeoutMs) => {
        observedBinary = `${binary}:${timeoutMs}`;
        observedArgs = args;
        return JSON.stringify({
          format: { duration: "7200" },
          streams: [{ width: 1920, height: 1080 }],
        });
      },
    });
    expect(observedBinary).toBe("ffprobe:321");
    expect(observedArgs.indexOf("-ss")).toBeLessThan(observedArgs.indexOf("-i"));
    expect(observedArgs).toContain("-read_intervals");
    expect(result).toMatchObject({
      status: "ready",
      durationSeconds: 7200,
      width: 1920,
      height: 1080,
      sampledSeconds: [0],
    });
  });

  it("turns a timed-out runner into an explicit timeout, never an unbounded wait", async () => {
    const result = await probeMediaFile("/contained/recording.mp4", {
      run: async () => {
        throw new Error("media-probe-timeout");
      },
    });
    expect(result).toMatchObject({ status: "timeout", sampledSeconds: [] });
  });
});
