import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePluginManifest } from "../shared/plugins";
import type { OpenPluginPackage, PluginPackageSource } from "./open-plugin-package-source";
import { PluginPackageManager } from "./plugin-package-manager";
import { discoverVaultPlugins, loadVaultPluginCatalog } from "./vault-plugin-loader";

const fixtureDirectory = path.resolve("fixtures/plugin-packages/inspection-safe");
const vaultId = "c".repeat(64);
const pluginId = "inspection-safe";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

class ExactFixtureSource implements PluginPackageSource {
  constructor(private readonly pkg: OpenPluginPackage) {}

  async getIndex() {
    return {
      entries: [
        {
          id: pluginId,
          name: this.pkg.manifest.name,
          author: this.pkg.manifest.author ?? "",
          description: this.pkg.manifest.description ?? "",
          repository: this.pkg.repository,
        },
      ],
      sha256: this.pkg.indexSha256,
      sourceUrl: this.pkg.indexUrl,
    };
  }

  async getPackage(requestedPluginId: string, version?: string): Promise<OpenPluginPackage> {
    if (requestedPluginId !== pluginId || (version && version !== this.pkg.manifest.version)) {
      throw new Error("unknown exact fixture package");
    }
    return this.pkg;
  }
}

let sandboxPath: string;
let vaultPath: string;
let statePath: string;

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-plugin-authority-"));
  vaultPath = path.join(sandboxPath, "vault");
  statePath = path.join(sandboxPath, "state");
  await fs.mkdir(vaultPath);
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

async function exactFixturePackage(): Promise<OpenPluginPackage> {
  const manifestBytes = await fs.readFile(path.join(fixtureDirectory, "manifest.json"));
  const mainBytes = await fs.readFile(path.join(fixtureDirectory, "main.js"));
  const stylesBytes = await fs.readFile(path.join(fixtureDirectory, "styles.css"));
  const manifest = parsePluginManifest(JSON.parse(manifestBytes.toString("utf8")));
  const licenseBytes = Buffer.from("Fixture license for exact authority E2E\n", "utf8");
  return {
    assets: [
      { filename: "manifest.json", bytes: manifestBytes, sha256: sha256(manifestBytes) },
      { filename: "main.js", bytes: mainBytes, sha256: sha256(mainBytes) },
      { filename: "styles.css", bytes: stylesBytes, sha256: sha256(stylesBytes) },
    ],
    indexSha256: "d".repeat(64),
    indexUrl: "fixture://inspection-safe/index.json",
    license: {
      bytes: licenseBytes,
      name: "Fixture license",
      sourceUrl: "fixture://inspection-safe/LICENSE",
      spdxId: "MIT",
      sha256: sha256(licenseBytes),
    },
    manifest,
    releaseUrl: "fixture://inspection-safe/0.1.0",
    repository: "fixture-owner/inspection-safe",
    warnings: [],
  };
}

describe("managed plugin package inspection authority", () => {
  it("carries exact review authority through apply, grant, enablement, and drift rejection", async () => {
    const source = new ExactFixtureSource(await exactFixturePackage());
    const manager = new PluginPackageManager(statePath, source);
    await manager.initialize();

    const review = await manager.preview(vaultPath, vaultId, {
      action: "install",
      pluginId,
    });
    expect(review.inspection).toMatchObject({
      overall: "pass",
      compatibilityLevel: 3,
      staticAuthority: { staticOnly: true },
    });
    expect(review.inspection?.limitations.join("\n")).toContain("not a sandbox");
    expect(review.inspection?.exactPackage.bundleSha256).toBe(
      review.assets.find((asset) => asset.filename === "main.js")?.sha256,
    );
    expect(review.inspection?.compatibilityLevel).not.toBe(4);

    await manager.apply(vaultPath, vaultId, review.reviewId);
    const receipt = JSON.parse(
      await fs.readFile(
        path.join(vaultPath, ".obsidian", "plugins", pluginId, ".threadleaf-package.json"),
        "utf8",
      ),
    );
    expect(receipt.inspection).toMatchObject({
      overall: "pass",
      compatibilityLevel: 3,
      exactPackage: {
        id: pluginId,
        version: "0.1.0",
        provenance: { releaseTag: "0.1.0" },
      },
      staticAuthority: { staticOnly: true },
    });

    const discovered = await discoverVaultPlugins(vaultPath);
    const installed = discovered.plugins[0];
    expect(installed?.inspection).toMatchObject({ compatibilityLevel: 3 });
    expect(installed?.summary.capabilityReport).toEqual(installed?.inspection?.staticAuthority);

    const report = installed?.summary.capabilityReport;
    expect(report).toBeDefined();
    const enabled = await loadVaultPluginCatalog({
      vaultPath,
      vaultId,
      preference: {
        compatibilityMode: "enabled",
        enabledPluginIds: [pluginId],
        capabilityGrantsByPlugin: {
          [pluginId]: {
            bundleSha256: report?.bundleSha256 ?? "",
            capabilities: report?.capabilities ?? [],
          },
        },
      },
      safeMode: false,
    });
    expect(enabled.plugins[0]).toMatchObject({
      id: pluginId,
      packageState: "ready",
      capabilityGrantState: "granted",
    });
    expect(enabled.css).toContain(".inspection-safe");

    await fs.appendFile(
      path.join(vaultPath, ".obsidian", "plugins", pluginId, "main.js"),
      "\n// changed after exact review\n",
      "utf8",
    );
    await expect(manager.getManagedPackages(vaultPath, vaultId)).resolves.toMatchObject([
      { pluginId, integrity: "changed" },
    ]);

    const drifted = await discoverVaultPlugins(vaultPath);
    expect(drifted.plugins[0]).toMatchObject({
      summary: {
        packageState: "invalid",
        error: expect.stringContaining("inspection receipt"),
      },
    });
    const blocked = await loadVaultPluginCatalog({
      vaultPath,
      vaultId,
      preference: {
        compatibilityMode: "enabled",
        enabledPluginIds: [pluginId],
        capabilityGrantsByPlugin: {
          [pluginId]: {
            bundleSha256: report?.bundleSha256 ?? "",
            capabilities: report?.capabilities ?? [],
          },
        },
      },
      safeMode: false,
      blockedPluginIds: new Set([pluginId]),
    });
    expect(blocked.plugins[0]?.packageState).toBe("invalid");
    expect(blocked.css).toBe("");
  });
});
