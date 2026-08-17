import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const preloadSource = readFileSync(new URL("./preload.ts", import.meta.url), "utf8");

function handlerSource(channel: string): string {
  const token = `ipcChannels.${channel}`;
  const start = mainSource.indexOf(token);
  if (start < 0) return "";
  const next = mainSource.indexOf("\n  ipcMain.handle", start + token.length);
  return mainSource.slice(start, next < 0 ? undefined : next).replace(/\s+/gu, " ");
}

describe("editor attachment insertion IPC", () => {
  it("guards the owned renderer before validating and dispatching bounded copied bytes", () => {
    const handler = handlerSource("insertAttachment");
    const guard = handler.indexOf("isMainRendererSender(event.sender)");
    const validation = handler.indexOf("bytes instanceof ArrayBuffer");
    const dispatch = handler.indexOf("workspaceController.insertAttachment(");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(validation).toBeGreaterThan(guard);
    expect(dispatch).toBeGreaterThan(validation);
    expect(handler).toContain("MAX_VAULT_ATTACHMENT_BYTES");
    expect(handler).toContain('Buffer.byteLength(sourceFileName, "utf8") > 255');
    expect(handler).toContain("Number.isSafeInteger(selectionStart)");
    expect(handler).toContain("Number.isSafeInteger(selectionEnd)");
    expect(handler).toContain("new Uint8Array(bytes.slice(0))");
  });

  it("exposes only the typed preload channel needed by the renderer", () => {
    expect(preloadSource).toContain("insertAttachment:");
    expect(preloadSource).toContain("ipcChannels.insertAttachment");
    expect(preloadSource).toContain("Promise<AttachmentInsertResponse>");
    expect(preloadSource).not.toContain("selectedFile.path");
    expect(preloadSource).not.toContain("navigator.clipboard");
  });

  it("guards and bounds the ordered batch channel before copying any ArrayBuffer", () => {
    const handler = handlerSource("insertAttachmentBatch");
    expect(handler).toContain("isMainRendererSender(event.sender)");
    expect(handler).toContain("MAX_VAULT_ATTACHMENT_BATCH_ITEMS");
    expect(handler).toContain("MAX_VAULT_ATTACHMENT_BATCH_BYTES");
    expect(handler).toContain("item.bytes instanceof ArrayBuffer");
    expect(handler).toContain("new Uint8Array(item.bytes.slice(0))");
    expect(handler).toContain("workspaceController.insertAttachmentBatch(");
    expect(preloadSource).toContain("insertAttachmentBatch:");
    expect(preloadSource).toContain("ipcChannels.insertAttachmentBatch");
    expect(preloadSource).toContain("Promise<AttachmentBatchInsertResponse>");
  });
});
