import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pluginCompatibilityRegistry } from "../generated/plugin-compatibility-registry";
import { OpenPluginPackageSource } from "./open-plugin-package-source";
import { scanPluginCapabilities } from "./plugin-capability-scanner";
import { PluginPackageManager } from "./plugin-package-manager";

const live = process.env.THREADLEAF_LIVE_PLUGIN_INDEX === "1";

describe.runIf(live)("live open plugin package source", () => {
  it("reviews the pinned Excalidraw release from the community package index", async () => {
    const source = new OpenPluginPackageSource();
    const index = await source.getIndex();

    expect(index.entries.length).toBeGreaterThan(5_000);
    expect(index.entries).toContainEqual(
      expect.objectContaining({
        id: "obsidian-excalidraw-plugin",
        repository: "zsviczian/obsidian-excalidraw-plugin",
      }),
    );

    const pkg = await source.getPackage("obsidian-excalidraw-plugin", "2.25.3");
    expect(pkg.manifest).toMatchObject({
      id: "obsidian-excalidraw-plugin",
      version: "2.25.3",
    });
    expect(pkg.assets.map((asset) => asset.filename)).toEqual([
      "manifest.json",
      "main.js",
      "styles.css",
    ]);
    expect(pkg.license).toMatchObject({ spdxId: "AGPL-3.0" });
    expect(pkg.assets.every((asset) => /^[a-f0-9]{64}$/u.test(asset.sha256))).toBe(true);
    const evidence = pluginCompatibilityRegistry.entries.find(
      (entry) =>
        entry.plugin.id === "obsidian-excalidraw-plugin" && entry.plugin.version === "2.25.3",
    );
    const main = pkg.assets.find((asset) => asset.filename === "main.js");
    expect(evidence).toBeDefined();
    expect(main).toBeDefined();
    expect(main?.sha256).toBe(evidence?.plugin.bundleSha256);
    expect(scanPluginCapabilities(main?.bytes ?? Buffer.alloc(0)).capabilities).toEqual(
      evidence?.requiredCapabilities,
    );
  }, 60_000);

  it("installs, verifies, removes, and restores a real reviewed release", async () => {
    const sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-live-package-"));
    const vaultPath = path.join(sandboxPath, "vault");
    const statePath = path.join(sandboxPath, "state");
    await fs.mkdir(vaultPath);
    try {
      const manager = new PluginPackageManager(statePath, new OpenPluginPackageSource());
      await manager.initialize();
      const install = await manager.preview(vaultPath, "f".repeat(64), {
        action: "install",
        pluginId: "obsidian-excalidraw-plugin",
        version: "2.25.3",
      });
      expect(install).toMatchObject({
        operation: "install",
        targetVersion: "2.25.3",
        license: { spdxId: "AGPL-3.0" },
      });
      await manager.apply(vaultPath, "f".repeat(64), install.reviewId);
      expect((await manager.getManagedPackages(vaultPath, "f".repeat(64)))[0]).toMatchObject({
        currentVersion: "2.25.3",
        integrity: "verified",
      });

      const uninstall = await manager.preview(vaultPath, "f".repeat(64), {
        action: "uninstall",
        pluginId: "obsidian-excalidraw-plugin",
      });
      await manager.apply(vaultPath, "f".repeat(64), uninstall.reviewId);
      const pluginPath = path.join(vaultPath, ".obsidian", "plugins", "obsidian-excalidraw-plugin");
      await expect(fs.stat(pluginPath)).rejects.toMatchObject({ code: "ENOENT" });

      const restore = await manager.preview(vaultPath, "f".repeat(64), {
        action: "rollback",
        pluginId: "obsidian-excalidraw-plugin",
      });
      await manager.apply(vaultPath, "f".repeat(64), restore.reviewId);
      expect((await manager.getManagedPackages(vaultPath, "f".repeat(64)))[0]?.integrity).toBe(
        "verified",
      );
      expect(await fs.readFile(path.join(pluginPath, "LICENSE.threadleaf.txt"), "utf8")).toContain(
        "GNU AFFERO GENERAL PUBLIC LICENSE",
      );
    } finally {
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  }, 60_000);
});
