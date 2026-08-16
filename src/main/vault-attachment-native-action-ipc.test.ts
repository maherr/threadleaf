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

describe("native attachment action IPC", () => {
  it("guards the privileged handler before validation or native dispatch", () => {
    const handler = handlerSource("vaultAttachmentNativeAction");
    expect(handler).toContain("isMainRendererSender(event.sender)");
    expect(handler.indexOf("isMainRendererSender(event.sender)")).toBeLessThan(
      handler.indexOf("performVaultAttachmentNativeAction"),
    );
  });

  it("exposes one typed preload method rather than raw shell or ipcRenderer authority", () => {
    expect(preloadSource).toContain("runVaultAttachmentNativeAction:");
    expect(preloadSource).toContain("ipcChannels.vaultAttachmentNativeAction");
    expect(preloadSource).not.toContain("shell.openPath");
    expect(preloadSource).not.toContain("shell.showItemInFolder");
  });

  it("maps the production adapter to Electron shell and gates the packaged receiver", () => {
    expect(mainSource).toContain("shell.openPath(absolutePath)");
    expect(mainSource).toContain("shell.showItemInFolder(absolutePath)");
    expect(mainSource).toMatch(
      /THREADLEAF_TEST_NATIVE_ATTACHMENT_RECEIVER === "stdout-v1"\s*&&\s*process\.argv\.some/u,
    );
    expect(mainSource).toContain('createHash("sha256").update(absolutePath, "utf8")');
  });
});
