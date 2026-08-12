import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VaultPluginSettings } from "../shared/plugins";
import { discoverVaultPlugins, loadVaultPluginCatalog } from "./vault-plugin-loader";

let sandboxPath: string;
let vaultPath: string;

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-plugins-"));
  vaultPath = path.join(sandboxPath, "vault");
  await fs.mkdir(vaultPath);
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

async function writePlugin(
  id: string,
  options: { manifestId?: string; main?: string | null; css?: string | null } = {},
): Promise<void> {
  const directory = path.join(vaultPath, ".obsidian", "plugins", id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify({
      id: options.manifestId ?? id,
      name: id === "drawing" ? "Drawing" : "Fixture plugin",
      version: "1.2.3",
      minAppVersion: "1.0.0",
      description: "Fixture package",
      author: "Fixture author",
      isDesktopOnly: false,
    }),
    "utf8",
  );
  if (options.main !== null) {
    await fs.writeFile(
      path.join(directory, "main.js"),
      options.main ?? "module.exports = {};",
      "utf8",
    );
  }
  if (options.css !== null && options.css !== undefined) {
    await fs.writeFile(path.join(directory, "styles.css"), options.css, "utf8");
  }
}

async function grantedPreference(
  enabledPluginIds: string[],
  compatibilityMode: VaultPluginSettings["compatibilityMode"] = "enabled",
): Promise<VaultPluginSettings> {
  const discovery = await discoverVaultPlugins(vaultPath);
  return {
    compatibilityMode,
    enabledPluginIds,
    capabilityGrantsByPlugin: Object.fromEntries(
      discovery.plugins.flatMap((plugin) =>
        plugin.summary.capabilityReport
          ? [
              [
                plugin.summary.id,
                {
                  bundleSha256: plugin.summary.capabilityReport.bundleSha256,
                  capabilities: plugin.summary.capabilityReport.capabilities,
                },
              ] as const,
            ]
          : [],
      ),
    ),
  };
}

describe("vault plugin loader", () => {
  it("discovers standard Obsidian packages without reading enabled state from the vault", async () => {
    await writePlugin("drawing", { css: ".drawing-view { color: #123456; }" });
    await writePlugin("search");

    const discovery = await discoverVaultPlugins(vaultPath);

    expect(discovery.plugins.map((plugin) => plugin.summary.id)).toEqual(["drawing", "search"]);
    expect(discovery.plugins[0]?.summary).toMatchObject({
      name: "Drawing",
      version: "1.2.3",
      packageState: "ready",
      stylesheetDiscovered: true,
      compatibility: {
        level: 0,
        status: "unverified",
        testedVersion: null,
      },
      capabilityReport: {
        scannerVersion: 1,
        capabilities: [],
        staticOnly: true,
      },
      capabilityGrantState: "required",
    });
    expect(discovery.warnings).toEqual([]);
  });

  it("applies CSS only for privately enabled plugins outside restricted mode", async () => {
    await writePlugin("drawing", { css: ".drawing-view { --drawing-ready: 1; }" });
    await writePlugin("search", { css: ".search-view { --search-ready: 1; }" });

    const catalog = await loadVaultPluginCatalog({
      vaultPath,
      vaultId: "a".repeat(64),
      preference: await grantedPreference(["drawing"]),
      safeMode: false,
    });

    expect(catalog.css).toContain("--drawing-ready");
    expect(catalog.css).not.toContain("--search-ready");
    expect(catalog.warnings).toEqual([]);
  });

  it("blocks plugin code and CSS until the exact bundle authority report is granted", async () => {
    await writePlugin("drawing", {
      main: "app.vault.cachedRead(file); fetch(endpoint);",
      css: ".drawing-view { --drawing-ready: 1; }",
    });

    const missing = await loadVaultPluginCatalog({
      vaultPath,
      vaultId: "9".repeat(64),
      preference: {
        compatibilityMode: "enabled",
        enabledPluginIds: ["drawing"],
        capabilityGrantsByPlugin: {},
      },
      safeMode: false,
    });
    const stale = await loadVaultPluginCatalog({
      vaultPath,
      vaultId: "9".repeat(64),
      preference: {
        compatibilityMode: "enabled",
        enabledPluginIds: ["drawing"],
        capabilityGrantsByPlugin: {
          drawing: { bundleSha256: "0".repeat(64), capabilities: ["vault-read", "network"] },
        },
      },
      safeMode: false,
    });

    expect(missing.plugins[0]?.capabilityReport?.capabilities).toEqual(["vault-read", "network"]);
    expect(missing.plugins[0]?.capabilityGrantState).toBe("required");
    expect(missing.css).toBe("");
    expect(missing.warnings.join("\n")).toContain("review is missing");
    expect(stale.plugins[0]?.capabilityGrantState).toBe("stale");
    expect(stale.css).toBe("");
    expect(stale.warnings.join("\n")).toContain("review is stale");
  });

  it("keeps discovery visible while restricted and safe modes suppress plugin CSS", async () => {
    await writePlugin("drawing", { css: ".drawing-view { --drawing-ready: 1; }" });

    const restricted = await loadVaultPluginCatalog({
      vaultPath,
      vaultId: "b".repeat(64),
      preference: await grantedPreference(["drawing"], "restricted"),
      safeMode: false,
    });
    const safe = await loadVaultPluginCatalog({
      vaultPath,
      vaultId: "b".repeat(64),
      preference: await grantedPreference(["drawing"]),
      safeMode: true,
    });

    expect(restricted.plugins).toHaveLength(1);
    expect(restricted.css).toBe("");
    expect(safe.plugins).toHaveLength(1);
    expect(safe.css).toBe("");
    expect(safe.warnings[0]).toContain("safe mode");
  });

  it("blocks managed packages whose reviewed bytes changed, including their CSS", async () => {
    await writePlugin("drawing", { css: ".drawing-view { --drawing-ready: 1; }" });

    const catalog = await loadVaultPluginCatalog({
      vaultPath,
      vaultId: "f".repeat(64),
      preference: await grantedPreference(["drawing"]),
      safeMode: false,
      blockedPluginIds: new Set(["drawing"]),
    });

    expect(catalog.plugins[0]).toMatchObject({
      id: "drawing",
      packageState: "invalid",
      error: expect.stringContaining("SHA-256"),
    });
    expect(catalog.css).toBe("");
    expect(catalog.warnings.join("\n")).toContain("changed after installation");
  });

  it("reports missing, mismatched, and unsafe packages without losing the valid catalog", async () => {
    await writePlugin("valid");
    await writePlugin("mismatch", { manifestId: "another-id" });
    await writePlugin("missing-main", { main: null });

    const catalog = await loadVaultPluginCatalog({
      vaultPath,
      vaultId: "c".repeat(64),
      preference: {
        compatibilityMode: "enabled",
        enabledPluginIds: ["valid", "not-installed"],
        capabilityGrantsByPlugin: (await grantedPreference(["valid"])).capabilityGrantsByPlugin,
      },
      safeMode: false,
    });

    expect(catalog.plugins).toHaveLength(3);
    expect(catalog.plugins.filter((plugin) => plugin.packageState === "invalid")).toHaveLength(2);
    expect(
      catalog.plugins
        .filter((plugin) => plugin.packageState === "invalid")
        .every((plugin) => plugin.compatibility.level === 0),
    ).toBe(true);
    expect(catalog.warnings.join("\n")).toContain("does not match folder");
    expect(catalog.warnings.join("\n")).toContain("main.js is missing");
    expect(catalog.warnings.join("\n")).toContain("not installed");
  });

  it("applies plugin styles while neutralizing network-capable asset URLs", async () => {
    await writePlugin("drawing", {
      css: [
        '.drawing-view { background: url("https://example.test/image.png"); }',
        '.embedded { background: url("data:image/svg+xml,%3Csvg%3E"); }',
        ".variable { mask: url(var(--drawing-icon)); }",
      ].join("\n"),
    });

    const catalog = await loadVaultPluginCatalog({
      vaultPath,
      vaultId: "d".repeat(64),
      preference: await grantedPreference(["drawing"]),
      safeMode: false,
    });

    expect(catalog.css).toContain(".drawing-view");
    expect(catalog.css).toContain("data:image/svg+xml");
    expect(catalog.css).toContain("var(--drawing-icon)");
    expect(catalog.css).not.toContain("https://example.test");
    expect(catalog.warnings).toEqual([
      "Plugin drawing stylesheet was applied with 1 external asset URL blocked.",
    ]);
  });

  it("still rejects executable plugin CSS after URL neutralization", async () => {
    await writePlugin("drawing", {
      css: '@import url("https://example.test/plugin.css"); .drawing-view { color: white; }',
    });

    const catalog = await loadVaultPluginCatalog({
      vaultPath,
      vaultId: "e".repeat(64),
      preference: await grantedPreference(["drawing"]),
      safeMode: false,
    });

    expect(catalog.css).toBe("");
    expect(catalog.warnings[0]).toContain("stylesheet was not applied");
    expect(catalog.warnings[0]).toContain("@import");
  });
});
