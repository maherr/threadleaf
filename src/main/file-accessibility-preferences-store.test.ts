import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AccessibilityPreferences,
  createDefaultAccessibilityPreferences,
} from "../shared/accessibility-preferences";
import { FileAccessibilityPreferencesStore } from "./file-accessibility-preferences-store";

let sandboxPath: string;
let preferencesPath: string;

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-accessibility-"));
  preferencesPath = path.join(sandboxPath, "state", "accessibility-preferences.json");
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

describe("FileAccessibilityPreferencesStore", () => {
  it("returns null before the first write", async () => {
    await expect(new FileAccessibilityPreferencesStore(preferencesPath).load()).resolves.toBeNull();
  });

  it("writes a normalized private document atomically", async () => {
    const store = new FileAccessibilityPreferencesStore(preferencesPath);
    const saved = await store.save({
      ...createDefaultAccessibilityPreferences(),
      accent: "orange",
      uiFontScale: 1.234,
    });
    expect(saved.uiFontScale).toBe(1.23);
    await expect(store.load()).resolves.toEqual(saved);
    expect((await fs.stat(preferencesPath)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(preferencesPath, "utf8")).toBe(`${JSON.stringify(saved, null, 2)}\n`);
    expect(await fs.readdir(sandboxPath, { recursive: true })).not.toContain("vault");
  });

  it("leaves malformed bytes untouched for visible recovery", async () => {
    await fs.mkdir(path.dirname(preferencesPath), { recursive: true });
    const malformed = '{"version":9,"accent":"blue"}\n';
    await fs.writeFile(preferencesPath, malformed, "utf8");
    const store = new FileAccessibilityPreferencesStore(preferencesPath);
    await expect(store.load()).rejects.toThrow("version 1");
    await expect(fs.readFile(preferencesPath, "utf8")).resolves.toBe(malformed);
  });

  it("rejects malformed updates before creating the file", async () => {
    const store = new FileAccessibilityPreferencesStore(preferencesPath);
    await expect(
      store.save({
        ...createDefaultAccessibilityPreferences(),
        editorLineHeight: Number.NaN,
      } as AccessibilityPreferences),
    ).rejects.toThrow("finite");
    await expect(fs.stat(preferencesPath)).rejects.toThrow();
  });
});
