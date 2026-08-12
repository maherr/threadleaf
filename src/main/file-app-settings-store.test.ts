import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultAppSettings } from "../shared/key-bindings";
import { FileAppSettingsStore } from "./file-app-settings-store";

let sandboxPath: string;
let settingsPath: string;

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-settings-"));
  settingsPath = path.join(sandboxPath, "state", "settings.json");
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

describe("FileAppSettingsStore", () => {
  it("returns null when no settings have been saved", async () => {
    const store = new FileAppSettingsStore(settingsPath);

    await expect(store.load()).resolves.toBeNull();
  });

  it("normalizes and durably replaces settings with private permissions", async () => {
    const store = new FileAppSettingsStore(settingsPath);
    const settings = createDefaultAppSettings();
    settings.keyBindings["editor.revert-note"] = "alt + r";

    const saved = await store.save(settings);

    expect(saved.keyBindings["editor.revert-note"]).toBe("Alt+R");
    await expect(store.load()).resolves.toEqual(saved);
    const stat = await fs.stat(settingsPath);
    expect(stat.mode & 0o777).toBe(0o600);
    await expect(fs.readFile(settingsPath, "utf8")).resolves.toBe(
      `${JSON.stringify(saved, null, 2)}\n`,
    );
  });

  it("rejects malformed, unsupported, and colliding settings", async () => {
    const store = new FileAppSettingsStore(settingsPath);
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, "not json\n", "utf8");

    await expect(store.load()).rejects.toThrow();
    await fs.writeFile(settingsPath, '{"version":3,"keyBindings":{}}\n', "utf8");
    await expect(store.load()).rejects.toThrow("version 1 or 2");
    await fs.writeFile(
      settingsPath,
      '{"version":1,"keyBindings":{"ui.command-palette":"Mod+O"}}\n',
      "utf8",
    );
    await expect(store.load()).rejects.toThrow("already assigned");
  });
});
