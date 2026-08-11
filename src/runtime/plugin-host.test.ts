import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PluginHost } from "./plugin-host";

const fixtureVault = path.resolve("fixtures/vaults/basic");
const fixturePlugin = path.join(fixtureVault, ".obsidian", "plugins", "threadleaf-fixture");

async function readFixtureBytes(): Promise<Map<string, Buffer>> {
  const relativePaths = [
    "Welcome.md",
    "Linked Note.md",
    ".obsidian/plugins/threadleaf-fixture/manifest.json",
    ".obsidian/plugins/threadleaf-fixture/main.js",
    ".obsidian/plugins/threadleaf-fixture/styles.css",
  ];
  return new Map(
    await Promise.all(
      relativePaths.map(
        async (relativePath) =>
          [relativePath, await fs.readFile(path.join(fixtureVault, relativePath))] as const,
      ),
    ),
  );
}

describe("PluginHost", () => {
  it("loads an unchanged CommonJS plugin and verifies its command workflow", async () => {
    const before = await readFixtureBytes();
    const host = new PluginHost(fixtureVault);

    const loaded = await host.loadPlugin(fixturePlugin);
    expect(loaded.vault.markdownFileCount).toBe(2);
    expect(loaded.plugin).toMatchObject({
      id: "threadleaf-fixture",
      state: "loaded",
      compatibilityLevel: 3,
      stylesheetDiscovered: true,
    });
    expect(loaded.commands).toEqual([
      {
        id: "threadleaf-fixture-confirm",
        name: "Confirm compatibility bridge",
      },
    ]);

    const verified = await host.runCommand("threadleaf-fixture-confirm");
    expect(verified.plugin?.compatibilityLevel).toBe(4);
    expect(verified.notices).toContain("Fixture command crossed the compatibility bridge.");

    const after = await readFixtureBytes();
    expect(after).toEqual(before);
  });

  it("releases command registrations on unload and recreates them on reload", async () => {
    const host = new PluginHost(fixtureVault);
    await host.loadPlugin(fixturePlugin);

    const unloaded = await host.unloadPlugin();
    expect(unloaded.plugin?.state).toBe("unloaded");
    expect(unloaded.commands).toEqual([]);

    const reloaded = await host.reloadPlugin();
    expect(reloaded.plugin?.state).toBe("loaded");
    expect(reloaded.commands).toHaveLength(1);
    expect(reloaded.events.filter(({ message }) => message.startsWith("Unloaded "))).toHaveLength(
      1,
    );
  });

  it("rejects plugin directories outside the active vault", async () => {
    const host = new PluginHost(fixtureVault);
    await expect(host.loadPlugin(path.resolve("fixtures"))).rejects.toThrow(
      "Plugin directory must be inside the active vault.",
    );
  });
});
