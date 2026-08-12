import { promises as fs } from "node:fs";
import os from "node:os";
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
        ownerId: "threadleaf-fixture",
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

  it("owns multiple plugin lifecycles independently", async () => {
    const sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-plugin-host-"));
    const vaultPath = path.join(sandboxPath, "vault");
    try {
      await fs.cp(fixtureVault, vaultPath, { recursive: true });
      const secondPlugin = path.join(vaultPath, ".obsidian", "plugins", "threadleaf-secondary");
      await fs.mkdir(secondPlugin, { recursive: true });
      await fs.writeFile(
        path.join(secondPlugin, "manifest.json"),
        JSON.stringify({
          id: "threadleaf-secondary",
          name: "Threadleaf Secondary Fixture",
          version: "0.1.0",
        }),
        "utf8",
      );
      await fs.writeFile(
        path.join(secondPlugin, "main.js"),
        `const { Plugin } = require("obsidian");
module.exports = class SecondaryPlugin extends Plugin {
  async onload() {
    this.addCommand({ id: "threadleaf-secondary-confirm", name: "Confirm second plugin", callback() {} });
  }
};
`,
        "utf8",
      );
      const host = new PluginHost(vaultPath);
      await host.loadPlugin(path.join(vaultPath, ".obsidian", "plugins", "threadleaf-fixture"));
      const bothLoaded = await host.loadPlugin(secondPlugin);

      expect(bothLoaded.plugins).toMatchObject([
        { id: "threadleaf-fixture", state: "loaded", compatibilityLevel: 3 },
        { id: "threadleaf-secondary", state: "loaded", compatibilityLevel: 3 },
      ]);
      expect(bothLoaded.commands.map(({ id, ownerId }) => ({ id, ownerId }))).toEqual([
        { id: "threadleaf-fixture-confirm", ownerId: "threadleaf-fixture" },
        { id: "threadleaf-secondary-confirm", ownerId: "threadleaf-secondary" },
      ]);

      const oneUnloaded = await host.unloadPlugin("threadleaf-secondary");
      expect(oneUnloaded.commands.map(({ id }) => id)).toEqual(["threadleaf-fixture-confirm"]);
      expect(oneUnloaded.plugins?.find(({ id }) => id === "threadleaf-fixture")?.state).toBe(
        "loaded",
      );

      const allUnloaded = await host.unloadAllPlugins();
      expect(allUnloaded.commands).toEqual([]);
      expect(allUnloaded.plugins?.every(({ state }) => state === "unloaded")).toBe(true);
    } finally {
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });

  it("continues unloading every plugin when one onunload hook fails", async () => {
    const sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-plugin-unload-"));
    const vaultPath = path.join(sandboxPath, "vault");
    try {
      await fs.cp(fixtureVault, vaultPath, { recursive: true });
      const failingPlugin = path.join(vaultPath, ".obsidian", "plugins", "failing-unload");
      await fs.mkdir(failingPlugin, { recursive: true });
      await fs.writeFile(
        path.join(failingPlugin, "manifest.json"),
        JSON.stringify({ id: "failing-unload", name: "Failing unload", version: "0.1.0" }),
        "utf8",
      );
      await fs.writeFile(
        path.join(failingPlugin, "main.js"),
        `const { Plugin } = require("obsidian");
module.exports = class FailingUnloadPlugin extends Plugin {
  async onload() {
    this.addCommand({ id: "failing-unload-command", name: "Failing unload command", callback() {} });
  }
  async onunload() {
    throw new Error("fixture onunload failure");
  }
};
`,
        "utf8",
      );

      const host = new PluginHost(vaultPath);
      await host.loadPlugin(failingPlugin);
      await host.loadPlugin(path.join(vaultPath, ".obsidian", "plugins", "threadleaf-fixture"));

      const unloaded = await host.unloadAllPlugins();

      expect(unloaded.commands).toEqual([]);
      expect(unloaded.plugins?.every(({ state }) => state === "unloaded")).toBe(true);
      expect(unloaded.plugins?.find(({ id }) => id === "failing-unload")?.error).toBe(
        "fixture onunload failure",
      );
      expect(unloaded.events.some(({ message }) => message.includes("onunload failed"))).toBe(true);
    } finally {
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });

  it("rejects plugin directories outside the active vault", async () => {
    const host = new PluginHost(fixtureVault);
    await expect(host.loadPlugin(path.resolve("fixtures"))).rejects.toThrow(
      "Plugin directory must be an immediate child of .obsidian/plugins in the active vault.",
    );
  });
});
