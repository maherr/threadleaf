import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VaultAccessibilityPreferencesMap } from "../application/vault-accessibility-preferences";
import { createDefaultAccessibilityPreferences } from "../shared/accessibility-preferences";
import { FileVaultAccessibilityPreferencesStore } from "./accessibility-preferences-vault-store";

const vaultA = "a".repeat(64);
const vaultB = "b".repeat(64);
let sandboxPath: string;
let filePath: string;

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-vault-accessibility-"));
  filePath = path.join(sandboxPath, "vault-accessibility-preferences.json");
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

describe("FileVaultAccessibilityPreferencesStore", () => {
  it("persists an override keyed by vault identity, atomically and mode-0600", async () => {
    const store = new FileVaultAccessibilityPreferencesStore(filePath);
    const overrides: VaultAccessibilityPreferencesMap = {
      [vaultA]: { ...createDefaultAccessibilityPreferences(), accent: "teal" },
    };
    await store.save(overrides);
    await expect(store.load()).resolves.toEqual(overrides);
    if (process.platform !== "win32") {
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toMatchObject({
      version: 1,
      byVault: { [vaultA]: { accent: "teal" } },
    });
  });

  it("returns null and never writes when no file exists yet", async () => {
    const store = new FileVaultAccessibilityPreferencesStore(filePath);
    await expect(store.load()).resolves.toBeNull();
    await expect(fs.stat(filePath)).rejects.toThrow();
  });

  it("keeps one vault's stored override from disturbing another vault's", async () => {
    const store = new FileVaultAccessibilityPreferencesStore(filePath);
    await store.save({
      [vaultA]: { ...createDefaultAccessibilityPreferences(), accent: "orange" },
      [vaultB]: { ...createDefaultAccessibilityPreferences(), accent: "teal" },
    });
    const reloaded = await store.load();
    expect(reloaded?.[vaultA]?.accent).toBe("orange");
    expect(reloaded?.[vaultB]?.accent).toBe("teal");
  });

  it("dropping a vault key on save removes only that vault's entry", async () => {
    const store = new FileVaultAccessibilityPreferencesStore(filePath);
    await store.save({
      [vaultA]: { ...createDefaultAccessibilityPreferences(), accent: "orange" },
      [vaultB]: { ...createDefaultAccessibilityPreferences(), accent: "teal" },
    });
    await store.save({
      [vaultB]: { ...createDefaultAccessibilityPreferences(), accent: "teal" },
    });
    const reloaded = await store.load();
    expect(reloaded).toEqual({
      [vaultB]: { ...createDefaultAccessibilityPreferences(), accent: "teal" },
    });
  });

  it("rejects a malformed vault identity instead of silently dropping it", async () => {
    const store = new FileVaultAccessibilityPreferencesStore(filePath);
    await expect(
      store.save({
        "not-a-vault-id": createDefaultAccessibilityPreferences(),
      } as VaultAccessibilityPreferencesMap),
    ).rejects.toThrow("lowercase SHA-256");
    await expect(fs.stat(filePath)).rejects.toThrow();
  });

  it("does not rewrite malformed future state", async () => {
    const store = new FileVaultAccessibilityPreferencesStore(filePath);
    const malformed = `${JSON.stringify({ version: 99, byVault: {} })}\n`;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, malformed, "utf8");
    await expect(store.load()).rejects.toThrow("version 1");
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe(malformed);
  });

  it("rejects an external replacement after load and preserves the external bytes", async () => {
    const store = new FileVaultAccessibilityPreferencesStore(filePath);
    const initial: VaultAccessibilityPreferencesMap = {
      [vaultA]: { ...createDefaultAccessibilityPreferences(), accent: "orange" },
    };
    await store.save(initial);
    await expect(store.load()).resolves.toEqual(initial);

    const external: VaultAccessibilityPreferencesMap = {
      [vaultA]: { ...createDefaultAccessibilityPreferences(), accent: "teal" },
    };
    const externalBytes = `${JSON.stringify({ version: 1, byVault: external }, null, 2)}\n`;
    await fs.writeFile(filePath, externalBytes, "utf8");

    await expect(store.save({ [vaultB]: createDefaultAccessibilityPreferences() })).rejects.toThrow(
      "changed externally",
    );
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe(externalBytes);
  });

  it("auto-loads before a fresh instance's first save and merges onto the current file", async () => {
    const store = new FileVaultAccessibilityPreferencesStore(filePath);
    await store.save({ [vaultA]: createDefaultAccessibilityPreferences() });

    // A freshly constructed store pointed at the same file has never called
    // load() itself, but its first save must still see the real current
    // revision (an implicit load), not blindly overwrite as though the file
    // were empty.
    const freshStore = new FileVaultAccessibilityPreferencesStore(filePath);
    await expect(
      freshStore.save({
        [vaultA]: createDefaultAccessibilityPreferences(),
        [vaultB]: createDefaultAccessibilityPreferences(),
      }),
    ).resolves.toEqual({
      [vaultA]: createDefaultAccessibilityPreferences(),
      [vaultB]: createDefaultAccessibilityPreferences(),
    });
    await expect(store.load()).resolves.toEqual({
      [vaultA]: createDefaultAccessibilityPreferences(),
      [vaultB]: createDefaultAccessibilityPreferences(),
    });
  });

  it("still rejects a fresh instance's first save when the on-disk file cannot be parsed", async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "not json", "utf8");

    const freshStore = new FileVaultAccessibilityPreferencesStore(filePath);
    await expect(
      freshStore.save({ [vaultA]: createDefaultAccessibilityPreferences() }),
    ).rejects.toThrow();
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("not json");
  });

  it("recovers from a blocked load and allows a subsequent save", async () => {
    const store = new FileVaultAccessibilityPreferencesStore(filePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "not json", "utf8");
    await expect(store.load()).rejects.toThrow();
    await expect(store.save({ [vaultA]: createDefaultAccessibilityPreferences() })).rejects.toThrow(
      "call recover()",
    );

    await fs.writeFile(filePath, `${JSON.stringify({ version: 1, byVault: {} })}\n`, "utf8");
    await store.recover();
    await expect(
      store.save({ [vaultA]: createDefaultAccessibilityPreferences() }),
    ).resolves.toEqual({ [vaultA]: createDefaultAccessibilityPreferences() });
  });
});
