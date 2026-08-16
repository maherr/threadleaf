import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const preloadSource = readFileSync(new URL("./preload.ts", import.meta.url), "utf8");
const rendererSource = readFileSync(new URL("../renderer/renderer.ts", import.meta.url), "utf8");

function handlerSource(channel: string): string {
  const token = `ipcChannels.${channel}`;
  const start = mainSource.indexOf(token);
  if (start < 0) return "";
  const next = mainSource.indexOf("\n  ipcMain.handle", start + token.length);
  return mainSource.slice(start, next < 0 ? undefined : next).replace(/\s+/gu, " ");
}

describe("missing attachment relink IPC", () => {
  it("guards the owned renderer before validating or dispatching the mutation", () => {
    const handler = handlerSource("relinkAttachment");
    const guard = handler.indexOf("isMainRendererSender(event.sender)");
    const dispatch = handler.indexOf("workspaceController.relinkAttachment(");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(dispatch).toBeGreaterThan(guard);
    expect(handler).toContain("sourceNotePath.length > 4_096");
    expect(handler).toContain("confirmationId.length > 128");
  });

  it("exposes one typed preload method and no renderer-side raw IPC authority", () => {
    expect(preloadSource).toContain("relinkAttachment:");
    expect(preloadSource).toContain("ipcChannels.relinkAttachment");
    expect(preloadSource).toContain("Promise<AttachmentRelinkResponse>");
    expect(rendererSource).toContain("window.threadleaf.relinkAttachment(");
    expect(rendererSource).not.toContain("ipcRenderer");
  });
});
