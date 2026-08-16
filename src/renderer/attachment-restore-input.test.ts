import { describe, expect, it, vi } from "vitest";
import {
  type AttachmentRestoreFileInput,
  canAcceptSingleAttachmentFileDrag,
  hasAttachmentRestoreFileTransfer,
  selectSingleAttachmentRestoreFile,
  stageAttachmentRestoreFile,
} from "./attachment-restore-input";

function file(
  name: string,
  bytes: number[],
  declaredSize = bytes.length,
): AttachmentRestoreFileInput {
  return {
    name,
    size: declaredSize,
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  };
}

describe("attachment restore external-file input", () => {
  it("selects exactly one file while ignoring companion string transfer flavors", () => {
    const selected = file("recovery.bin", [0, 0xff, 0x80]);
    expect(
      selectSingleAttachmentRestoreFile(
        [selected],
        [{ kind: "file", webkitGetAsEntry: () => ({ isDirectory: false }) }, { kind: "string" }],
      ),
    ).toEqual({ status: "ready", file: selected });
    expect(selectSingleAttachmentRestoreFile([], [{ kind: "string" }])).toEqual({
      status: "none",
    });
    expect(selectSingleAttachmentRestoreFile([selected, selected])).toEqual({
      status: "multiple",
    });
  });

  it("rejects directory-shaped transfers and admits one regular drag candidate", () => {
    expect(
      canAcceptSingleAttachmentFileDrag([
        { kind: "file", webkitGetAsEntry: () => ({ isDirectory: false }) },
      ]),
    ).toBe(true);
    expect(
      canAcceptSingleAttachmentFileDrag([
        { kind: "file", webkitGetAsEntry: () => ({ isDirectory: true }) },
      ]),
    ).toBe(false);
    expect(
      selectSingleAttachmentRestoreFile(
        [file("folder", [])],
        [{ kind: "file", webkitGetAsEntry: () => ({ isDirectory: true }) }],
      ),
    ).toEqual({ status: "directory" });
    expect(
      selectSingleAttachmentRestoreFile(
        [],
        [{ kind: "file", webkitGetAsEntry: () => ({ isDirectory: true }) }],
      ),
    ).toEqual({ status: "directory" });
  });

  it("distinguishes file-shaped transfers from text and URL flavors before final validation", () => {
    expect(hasAttachmentRestoreFileTransfer([], [{ kind: "string" }])).toBe(false);
    expect(
      hasAttachmentRestoreFileTransfer(
        [],
        [{ kind: "file", webkitGetAsEntry: () => ({ isDirectory: true }) }],
      ),
    ).toBe(true);
    expect(hasAttachmentRestoreFileTransfer([file("recovery.bin", [1])], [])).toBe(true);
  });

  it("preserves exact bytes and a safe basename", async () => {
    const staged = await stageAttachmentRestoreFile(file("recovery.bin", [0, 0xff, 0x80, 0x42]));
    expect(staged.status).toBe("ready");
    if (staged.status !== "ready") throw new Error("Expected staged bytes.");
    expect(staged.sourceFileName).toBe("recovery.bin");
    expect([...new Uint8Array(staged.bytes)]).toEqual([0, 0xff, 0x80, 0x42]);
  });

  it.each(["", ".", "..", "../recovery.bin", "folder/recovery.bin", "bad\\name", "bad\0name"])(
    "rejects the unsafe or empty basename %j",
    async (name) => {
      await expect(stageAttachmentRestoreFile(file(name, [1]))).resolves.toEqual({
        status: "invalid-file-name",
      });
    },
  );

  it("rejects a name longer than 255 UTF-8 bytes", async () => {
    await expect(stageAttachmentRestoreFile(file(`${"é".repeat(128)}.bin`, [1]))).resolves.toEqual({
      status: "invalid-file-name",
    });
  });

  it("refuses a declared oversize file before reading it", async () => {
    const arrayBuffer = vi.fn(async () => Uint8Array.from([1]).buffer);
    await expect(
      stageAttachmentRestoreFile({ name: "large.bin", size: 5, arrayBuffer }, 4),
    ).resolves.toEqual({ status: "too-large", phase: "declared", byteLength: 5 });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("refuses bytes that exceed the bound after the read", async () => {
    await expect(
      stageAttachmentRestoreFile(file("large.bin", [1, 2, 3, 4, 5], 1), 4),
    ).resolves.toEqual({ status: "too-large", phase: "read", byteLength: 5 });
  });

  it("reports an unreadable file without staging bytes", async () => {
    await expect(
      stageAttachmentRestoreFile({
        name: "unreadable.bin",
        size: 1,
        arrayBuffer: async () => {
          throw new Error("fixture read failure");
        },
      }),
    ).resolves.toEqual({ status: "unreadable" });
  });
});
