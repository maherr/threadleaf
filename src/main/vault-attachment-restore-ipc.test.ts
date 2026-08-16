import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const preloadSource = readFileSync(new URL("./preload.ts", import.meta.url), "utf8");
const rendererSource = readFileSync(new URL("../renderer/renderer.ts", import.meta.url), "utf8");
const rendererHtml = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
const rendererInputSource = readFileSync(
  new URL("../renderer/attachment-restore-input.ts", import.meta.url),
  "utf8",
);

function handlerSource(channel: string): string {
  const token = `ipcChannels.${channel}`;
  const start = mainSource.indexOf(token);
  if (start < 0) return "";
  const next = mainSource.indexOf("\n  ipcMain.handle", start + token.length);
  return mainSource.slice(start, next < 0 ? undefined : next).replace(/\s+/gu, " ");
}

function functionSource(name: string): string {
  const marker = `function ${name}`;
  const start = rendererSource.indexOf(marker);
  if (start < 0) return "";
  const remainder = rendererSource.slice(start + marker.length);
  const next = remainder.search(/\n(?:async )?function [A-Za-z0-9_]+/u);
  return rendererSource.slice(
    start,
    next < 0 ? rendererSource.length : start + marker.length + next,
  );
}

describe("missing attachment restore IPC", () => {
  it("guards the owned renderer before validating or dispatching bounded copied bytes", () => {
    const handler = handlerSource("restoreAttachment");
    const guard = handler.indexOf("isMainRendererSender(event.sender)");
    const validation = handler.indexOf("bytes instanceof ArrayBuffer");
    const dispatch = handler.indexOf("workspaceController.restoreAttachment(");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(validation).toBeGreaterThan(guard);
    expect(dispatch).toBeGreaterThan(validation);
    expect(handler).toContain("MAX_VAULT_ATTACHMENT_BYTES");
    expect(handler).toContain('Buffer.byteLength(sourceFileName, "utf8") > 255');
    expect(handler).toContain("new Uint8Array(bytes.slice(0))");
  });

  it("keeps file selection renderer-owned and rejects oversize input before reading bytes", () => {
    const selection = functionSource("acceptAttachmentRestoreFileSelection");
    expect(rendererHtml).toMatch(/id="attachment-restore-file"[\s\S]*type="file"/u);
    expect(selection).toContain("acceptAttachmentRestoreExternalFile(selection, selectedFile)");
    expect(rendererInputSource.indexOf("file.size > boundedMaxBytes")).toBeGreaterThanOrEqual(0);
    expect(rendererInputSource.indexOf("file.arrayBuffer()")).toBeGreaterThan(
      rendererInputSource.indexOf("file.size > boundedMaxBytes"),
    );
    expect(rendererSource).toContain("window.threadleaf.restoreAttachment(");
    expect(rendererSource).toContain("bytes.slice(0)");
    expect(rendererSource).not.toContain("selectedFile.path");
    expect(rendererSource).not.toContain("navigator.clipboard");
    expect(rendererSource).not.toContain("ipcRenderer");
  });

  it("exposes exactly the typed preload channel needed by the renderer", () => {
    expect(preloadSource).toContain("restoreAttachment:");
    expect(preloadSource).toContain("ipcChannels.restoreAttachment");
    expect(preloadSource).toContain("Promise<AttachmentRestoreResponse>");
  });
});
