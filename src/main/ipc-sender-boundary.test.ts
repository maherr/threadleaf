import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

describe("main renderer IPC sender boundary", () => {
  it("registers every ordinary renderer channel through the main-window guard", () => {
    const unguardedChannels = [
      ...mainSource.matchAll(/ipcMain\.handle\(\s*ipcChannels\.([A-Za-z0-9]+)/gu),
    ].map((match) => match[1]);
    expect(unguardedChannels).toEqual([]);
    expect(mainSource).toMatch(
      /function handleMainRendererIpc[\s\S]*?isMainRendererSender\(event\.sender\)[\s\S]*?ipcMain\.handle/u,
    );
  });

  it("keeps compatibility-runtime channels on their dedicated sender guard", () => {
    expect(mainSource).toMatch(
      /ipcMain\.handle\(pluginRendererChannels\.[\s\S]*?isPluginRuntimeSender\(event\.sender\)/u,
    );
  });
});
