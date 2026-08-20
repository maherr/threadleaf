import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenPluginPackage, PluginPackageSource } from "./open-plugin-package-source";
import { PluginPackageManager } from "./plugin-package-manager";

const vaultId = "a".repeat(64);
const pluginId = "fixture-plugin";
let sandboxPath: string;
let vaultPath: string;
let statePath: string;

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function packageFor(version: string): OpenPluginPackage {
  const rawManifest = {
    id: pluginId,
    name: "Fixture Plugin",
    version,
    minAppVersion: "0.1.0",
    description: "Fixture package",
    author: "Fixture author",
    isDesktopOnly: false,
  };
  const manifest = { ...rawManifest, authorUrl: null };
  const manifestBytes = Buffer.from(JSON.stringify(rawManifest), "utf8");
  const mainBytes = Buffer.from(
    `const { Plugin } = require("obsidian");
module.exports = class Fixture extends Plugin {
  onload() {
    this.addCommand({ id: "fixture-command", name: "Fixture", callback: () => {} });
  }
};
const fixtureVersion = "${version}";`,
    "utf8",
  );
  const stylesBytes = Buffer.from(`.fixture { --fixture-version: "${version}"; }`, "utf8");
  const licenseBytes = Buffer.from(`MIT License for fixture ${version}\n`, "utf8");
  return {
    assets: [
      { filename: "manifest.json", bytes: manifestBytes, sha256: digest(manifestBytes) },
      { filename: "main.js", bytes: mainBytes, sha256: digest(mainBytes) },
      { filename: "styles.css", bytes: stylesBytes, sha256: digest(stylesBytes) },
    ],
    indexSha256: "b".repeat(64),
    indexUrl: "https://example.test/open-index.json",
    license: {
      bytes: licenseBytes,
      name: "MIT License",
      sourceUrl: `https://example.test/${version}/LICENSE`,
      spdxId: "MIT",
      sha256: digest(licenseBytes),
    },
    manifest,
    releaseUrl: `https://example.test/releases/${version}`,
    repository: "fixture-owner/fixture-plugin",
    warnings: [],
  };
}

class FixtureSource implements PluginPackageSource {
  version = "1.0.0";

  async getIndex() {
    return {
      entries: [
        {
          id: pluginId,
          name: "Fixture Plugin",
          author: "Fixture author",
          description: "Fixture package",
          repository: "fixture-owner/fixture-plugin",
        },
      ],
      sha256: "b".repeat(64),
      sourceUrl: "https://example.test/open-index.json",
    };
  }

  async getPackage(requestedPluginId: string, version?: string) {
    if (requestedPluginId !== pluginId) {
      throw new Error("unknown fixture plugin");
    }
    return packageFor(version ?? this.version);
  }
}

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-package-manager-"));
  vaultPath = path.join(sandboxPath, "vault");
  statePath = path.join(sandboxPath, "state");
  await fs.mkdir(vaultPath);
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

async function openManager(source = new FixtureSource()): Promise<PluginPackageManager> {
  const manager = new PluginPackageManager(statePath, source);
  await manager.initialize();
  return manager;
}

function pluginPath(...parts: string[]): string {
  return path.join(vaultPath, ".obsidian", "plugins", pluginId, ...parts);
}

async function pausingManagerAt(
  source: PluginPackageSource,
  phase: "package-mutated" | "metadata-committed",
): Promise<{
  manager: PluginPackageManager;
  arm: () => void;
  reached: Promise<void>;
}> {
  let armed = false;
  let resolveReached: (() => void) | undefined;
  const reached = new Promise<void>((resolve) => {
    resolveReached = resolve;
  });
  const stoppedProcess = new Promise<void>(() => undefined);
  const manager = new PluginPackageManager(statePath, source, () => new Date(), {
    afterTransactionPhase: async (currentPhase) => {
      if (armed && currentPhase === phase) {
        resolveReached?.();
        await stoppedProcess;
      }
    },
  });
  await manager.initialize();
  return { manager, arm: () => (armed = true), reached };
}

describe("plugin package manager", () => {
  it("keeps preview read-only, then installs only reviewed bytes with license and receipt", async () => {
    const source = new FixtureSource();
    const manager = await openManager(source);

    const review = await manager.preview(vaultPath, vaultId, {
      action: "install",
      pluginId,
    });

    await expect(fs.stat(pluginPath())).rejects.toMatchObject({ code: "ENOENT" });
    expect(review.operation).toBe("install");
    expect(review.assets).toHaveLength(3);
    expect(review.license).toMatchObject({ spdxId: "MIT" });

    const outcome = await manager.apply(vaultPath, vaultId, review.reviewId);

    expect(outcome).toEqual({
      operation: "install",
      pluginId,
      version: "1.0.0",
      disabled: true,
    });
    expect(await fs.readFile(pluginPath("main.js"), "utf8")).toContain('"1.0.0"');
    expect(await fs.readFile(pluginPath("LICENSE.threadleaf.txt"), "utf8")).toContain(
      "MIT License",
    );
    const receipt = JSON.parse(await fs.readFile(pluginPath(".threadleaf-package.json"), "utf8"));
    expect(receipt).toMatchObject({
      version: 1,
      pluginId,
      pluginVersion: "1.0.0",
      repository: "fixture-owner/fixture-plugin",
      license: { spdxId: "MIT" },
    });
    expect((await manager.getManagedPackages(vaultPath, vaultId))[0]).toMatchObject({
      pluginId,
      currentVersion: "1.0.0",
      integrity: "verified",
      history: [],
    });
  });

  it("detects changed managed code and returns to verified only after a reviewed reinstall", async () => {
    const manager = await openManager();
    const install = await manager.preview(vaultPath, vaultId, { action: "install", pluginId });
    await manager.apply(vaultPath, vaultId, install.reviewId);

    await fs.writeFile(pluginPath("main.js"), "changed outside the package manager", "utf8");
    expect((await manager.getManagedPackages(vaultPath, vaultId))[0]?.integrity).toBe("changed");

    const reinstall = await manager.preview(vaultPath, vaultId, { action: "install", pluginId });
    expect(reinstall.operation).toBe("reinstall");
    await manager.apply(vaultPath, vaultId, reinstall.reviewId);

    expect((await manager.getManagedPackages(vaultPath, vaultId))[0]?.integrity).toBe("verified");
    expect(await fs.readFile(pluginPath("main.js"), "utf8")).toContain('"1.0.0"');
  });

  it("accepts a fresh exact-package provenance receipt without accepting changed authority", async () => {
    const manager = await openManager();
    const install = await manager.preview(vaultPath, vaultId, { action: "install", pluginId });
    await manager.apply(vaultPath, vaultId, install.reviewId);

    const receiptPath = pluginPath(".threadleaf-package.json");
    const refreshed = JSON.parse(await fs.readFile(receiptPath, "utf8"));
    refreshed.installedAt = "2026-08-19T19:19:45.054Z";
    refreshed.indexSha256 = "c".repeat(64);
    refreshed.inspection.exactPackage.provenance.indexSha256 = "c".repeat(64);
    await fs.writeFile(receiptPath, `${JSON.stringify(refreshed, null, 2)}\n`, "utf8");

    expect((await manager.getManagedPackages(vaultPath, vaultId))[0]?.integrity).toBe("verified");

    refreshed.inspection.staticAuthority.capabilities = [];
    refreshed.inspection.staticAuthority.findings = [];
    await fs.writeFile(receiptPath, `${JSON.stringify(refreshed, null, 2)}\n`, "utf8");

    expect((await manager.getManagedPackages(vaultPath, vaultId))[0]?.integrity).toBe("changed");
  });

  it("invalidates reviewed payload tampering before the vault is changed", async () => {
    const manager = await openManager();
    const review = await manager.preview(vaultPath, vaultId, { action: "install", pluginId });
    await fs.writeFile(path.join(statePath, "reviews", review.reviewId, "main.js"), "tampered");

    await expect(manager.apply(vaultPath, vaultId, review.reviewId)).rejects.toThrow(
      "failed their integrity check",
    );
    await expect(fs.stat(pluginPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("expires review authorization and removes private staged bytes", async () => {
    vi.useFakeTimers();
    try {
      const manager = await openManager();
      const review = await manager.preview(vaultPath, vaultId, { action: "install", pluginId });
      const reviewPath = path.join(statePath, "reviews", review.reviewId);
      expect(await fs.readFile(path.join(reviewPath, "main.js"), "utf8")).toContain('"1.0.0"');

      await vi.advanceTimersByTimeAsync(15 * 60_000);

      expect(() => manager.reviewForApply(vaultId, review.reviewId)).toThrow(
        "missing, expired, or belongs to another vault",
      );
      vi.useRealTimers();
      let removed = false;
      for (let attempt = 0; attempt < 20 && !removed; attempt += 1) {
        try {
          await fs.stat(reviewPath);
          await new Promise((resolve) => setTimeout(resolve, 5));
        } catch (error) {
          removed = error instanceof Error && "code" in error && error.code === "ENOENT";
        }
      }
      expect(removed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a changed installed tree after review without replacing either version", async () => {
    const source = new FixtureSource();
    const manager = await openManager(source);
    const install = await manager.preview(vaultPath, vaultId, { action: "install", pluginId });
    await manager.apply(vaultPath, vaultId, install.reviewId);
    source.version = "2.0.0";
    const update = await manager.preview(vaultPath, vaultId, { action: "install", pluginId });
    await fs.writeFile(pluginPath("data.json"), '{"changed":true}\n', "utf8");

    await expect(manager.apply(vaultPath, vaultId, update.reviewId)).rejects.toThrow(
      "changed after review",
    );
    expect(await fs.readFile(pluginPath("main.js"), "utf8")).toContain('"1.0.0"');
    expect(await fs.readFile(pluginPath("data.json"), "utf8")).toContain("changed");
  });

  it("restores every old byte when an external write lands inside the final swap window", async () => {
    const source = new FixtureSource();
    const manager = await openManager(source);
    const install = await manager.preview(vaultPath, vaultId, { action: "install", pluginId });
    await manager.apply(vaultPath, vaultId, install.reviewId);
    source.version = "2.0.0";
    const update = await manager.preview(vaultPath, vaultId, { action: "install", pluginId });
    const realRename = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (sourcePath, targetPath) => {
      await realRename(sourcePath, targetPath);
      if (
        String(sourcePath) === pluginPath() &&
        path.basename(String(targetPath)).startsWith(".threadleaf-package-rollback-")
      ) {
        await fs.writeFile(
          path.join(String(targetPath), "external-race.txt"),
          "preserve me",
          "utf8",
        );
      }
    });

    try {
      await expect(manager.apply(vaultPath, vaultId, update.reviewId)).rejects.toThrow(
        "changed during installation",
      );
    } finally {
      rename.mockRestore();
    }

    expect(await fs.readFile(pluginPath("main.js"), "utf8")).toContain('"1.0.0"');
    expect(await fs.readFile(pluginPath("external-race.txt"), "utf8")).toBe("preserve me");
  });

  it("updates, preserves plugin data, and rolls exact code assets back while staying disabled", async () => {
    const source = new FixtureSource();
    const manager = await openManager(source);
    const install = await manager.preview(vaultPath, vaultId, { action: "install", pluginId });
    await manager.apply(vaultPath, vaultId, install.reviewId);
    await fs.writeFile(pluginPath("data.json"), '{"preference":42}\n', "utf8");

    source.version = "2.0.0";
    const update = await manager.preview(vaultPath, vaultId, { action: "install", pluginId });
    expect(update.operation).toBe("update");
    await manager.apply(vaultPath, vaultId, update.reviewId);

    expect(await fs.readFile(pluginPath("main.js"), "utf8")).toContain('"2.0.0"');
    expect(await fs.readFile(pluginPath("data.json"), "utf8")).toContain("42");
    expect((await manager.getManagedPackages(vaultPath, vaultId))[0]?.history[0]?.version).toBe(
      "1.0.0",
    );

    await fs.writeFile(pluginPath("data.json"), '{"preference":84}\n', "utf8");
    const rollback = await manager.preview(vaultPath, vaultId, { action: "rollback", pluginId });
    expect(rollback.targetVersion).toBe("1.0.0");
    await manager.apply(vaultPath, vaultId, rollback.reviewId);

    expect(await fs.readFile(pluginPath("main.js"), "utf8")).toContain('"1.0.0"');
    expect(await fs.readFile(pluginPath("data.json"), "utf8")).toContain("84");
    expect((await manager.getManagedPackages(vaultPath, vaultId))[0]?.history[0]?.version).toBe(
      "2.0.0",
    );
  });

  it("rejects retained rollback bytes changed after review", async () => {
    const source = new FixtureSource();
    const manager = await openManager(source);
    const install = await manager.preview(vaultPath, vaultId, { action: "install", pluginId });
    await manager.apply(vaultPath, vaultId, install.reviewId);
    source.version = "2.0.0";
    const update = await manager.preview(vaultPath, vaultId, { action: "install", pluginId });
    await manager.apply(vaultPath, vaultId, update.reviewId);
    const rollback = await manager.preview(vaultPath, vaultId, { action: "rollback", pluginId });
    const retained = (await manager.getManagedPackages(vaultPath, vaultId))[0]?.history[0];
    expect(retained).toBeDefined();
    const retainedMain = path.join(
      statePath,
      "vaults",
      vaultId,
      "history",
      pluginId,
      retained?.snapshotId as string,
      "package",
      "main.js",
    );
    await fs.writeFile(retainedMain, "changed after rollback review", "utf8");

    await expect(manager.apply(vaultPath, vaultId, rollback.reviewId)).rejects.toThrow(
      "Retained rollback package changed after review",
    );
    expect(await fs.readFile(pluginPath("main.js"), "utf8")).toContain('"2.0.0"');
  });

  it("retains a complete uninstall snapshot and can restore it after removal", async () => {
    const manager = await openManager();
    const install = await manager.preview(vaultPath, vaultId, { action: "install", pluginId });
    await manager.apply(vaultPath, vaultId, install.reviewId);
    await fs.writeFile(pluginPath("data.json"), '{"recoverable":true}\n', "utf8");

    const uninstall = await manager.preview(vaultPath, vaultId, {
      action: "uninstall",
      pluginId,
    });
    await manager.apply(vaultPath, vaultId, uninstall.reviewId);

    await expect(fs.stat(pluginPath())).rejects.toMatchObject({ code: "ENOENT" });
    expect((await manager.getManagedPackages(vaultPath, vaultId))[0]).toMatchObject({
      currentVersion: null,
      history: [{ version: "1.0.0", reason: "uninstall" }],
    });

    const restore = await manager.preview(vaultPath, vaultId, { action: "rollback", pluginId });
    await manager.apply(vaultPath, vaultId, restore.reviewId);

    expect(await fs.readFile(pluginPath("data.json"), "utf8")).toContain("recoverable");
    expect(await fs.readFile(pluginPath("main.js"), "utf8")).toContain('"1.0.0"');
  });

  it("searches the community package index with installed and managed state but never downloads a bundle", async () => {
    const source = new FixtureSource();
    const manager = await openManager(source);
    const result = await manager.search(vaultPath, vaultId, "fixture");

    expect(result.results).toEqual([
      expect.objectContaining({
        id: pluginId,
        installedVersion: null,
        managed: false,
      }),
    ]);
  });

  it("removes a first install interrupted after the directory swap", async () => {
    const source = new FixtureSource();
    const interrupted = await pausingManagerAt(source, "package-mutated");
    const review = await interrupted.manager.preview(vaultPath, vaultId, {
      action: "install",
      pluginId,
    });
    interrupted.arm();
    void interrupted.manager.apply(vaultPath, vaultId, review.reviewId);
    await interrupted.reached;

    expect(await fs.readFile(pluginPath("main.js"), "utf8")).toContain('"1.0.0"');
    const recovered = await openManager(source);
    expect(await recovered.getManagedPackages(vaultPath, vaultId)).toEqual([]);
    await expect(fs.stat(pluginPath())).rejects.toMatchObject({ code: "ENOENT" });
    expect(recovered.takeRecoveryNotices(vaultId).join(" ")).toContain(
      "previous package and private metadata were restored",
    );
  });

  it("discards a pre-journal transaction only when no vault mutation evidence exists", async () => {
    const transactionId = "12345678-1234-4123-8123-123456789abc";
    const transactionPath = path.join(statePath, "transactions", vaultId, transactionId);
    await fs.mkdir(transactionPath, { recursive: true });
    await fs.writeFile(
      path.join(transactionPath, "inventory-before.json"),
      '{"version":1,"packages":[]}\n',
      "utf8",
    );
    const manager = await openManager();

    expect(await manager.getManagedPackages(vaultPath, vaultId)).toEqual([]);
    await expect(fs.stat(transactionPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves vault transaction evidence when its private journal is missing", async () => {
    const transactionId = "12345678-1234-4123-8123-123456789abc";
    const transactionPath = path.join(statePath, "transactions", vaultId, transactionId);
    const evidencePath = path.join(
      vaultPath,
      ".obsidian",
      "plugins",
      `.threadleaf-package-rollback-${transactionId}`,
    );
    await fs.mkdir(transactionPath, { recursive: true });
    await fs.mkdir(evidencePath, { recursive: true });
    const manager = await openManager();

    await expect(manager.getManagedPackages(vaultPath, vaultId)).rejects.toThrow(
      "missing its journal but found vault transaction evidence",
    );
    expect((await fs.stat(transactionPath)).isDirectory()).toBe(true);
    expect((await fs.stat(evidencePath)).isDirectory()).toBe(true);
  });

  it("restores an update interrupted after the directory swap", async () => {
    const source = new FixtureSource();
    const interrupted = await pausingManagerAt(source, "package-mutated");
    const install = await interrupted.manager.preview(vaultPath, vaultId, {
      action: "install",
      pluginId,
    });
    await interrupted.manager.apply(vaultPath, vaultId, install.reviewId);
    await fs.writeFile(pluginPath("data.json"), '{"preserved":true}\n', "utf8");
    source.version = "2.0.0";
    const update = await interrupted.manager.preview(vaultPath, vaultId, {
      action: "install",
      pluginId,
    });
    interrupted.arm();
    void interrupted.manager.apply(vaultPath, vaultId, update.reviewId);
    await interrupted.reached;

    expect(await fs.readFile(pluginPath("main.js"), "utf8")).toContain('"2.0.0"');
    const recovered = await openManager(source);
    expect((await recovered.getManagedPackages(vaultPath, vaultId))[0]).toMatchObject({
      currentVersion: "1.0.0",
      integrity: "verified",
      history: [],
    });
    expect(await fs.readFile(pluginPath("data.json"), "utf8")).toContain("preserved");
  });

  it("restores an update interrupted between the two directory renames", async () => {
    const source = new FixtureSource();
    const manager = await openManager(source);
    const install = await manager.preview(vaultPath, vaultId, {
      action: "install",
      pluginId,
    });
    await manager.apply(vaultPath, vaultId, install.reviewId);
    await fs.writeFile(pluginPath("data.json"), '{"midSwap":true}\n', "utf8");
    source.version = "2.0.0";
    const update = await manager.preview(vaultPath, vaultId, {
      action: "install",
      pluginId,
    });
    const realRename = fs.rename.bind(fs);
    let resolveReached: (() => void) | undefined;
    const reached = new Promise<void>((resolve) => {
      resolveReached = resolve;
    });
    const stoppedProcess = new Promise<void>(() => undefined);
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (sourcePath, targetPath) => {
      await realRename(sourcePath, targetPath);
      if (
        String(sourcePath) === pluginPath() &&
        path.basename(String(targetPath)).startsWith(".threadleaf-package-rollback-")
      ) {
        resolveReached?.();
        await stoppedProcess;
      }
    });

    void manager.apply(vaultPath, vaultId, update.reviewId);
    await reached;
    rename.mockRestore();

    await expect(fs.stat(pluginPath())).rejects.toMatchObject({ code: "ENOENT" });
    const recovered = await openManager(source);
    expect((await recovered.getManagedPackages(vaultPath, vaultId))[0]).toMatchObject({
      currentVersion: "1.0.0",
      integrity: "verified",
      history: [],
    });
    expect(await fs.readFile(pluginPath("data.json"), "utf8")).toContain("midSwap");
  });

  it("restores an uninstall interrupted after the directory removal", async () => {
    const source = new FixtureSource();
    const interrupted = await pausingManagerAt(source, "package-mutated");
    const install = await interrupted.manager.preview(vaultPath, vaultId, {
      action: "install",
      pluginId,
    });
    await interrupted.manager.apply(vaultPath, vaultId, install.reviewId);
    await fs.writeFile(pluginPath("data.json"), '{"recoverable":true}\n', "utf8");
    const uninstall = await interrupted.manager.preview(vaultPath, vaultId, {
      action: "uninstall",
      pluginId,
    });
    interrupted.arm();
    void interrupted.manager.apply(vaultPath, vaultId, uninstall.reviewId);
    await interrupted.reached;

    await expect(fs.stat(pluginPath())).rejects.toMatchObject({ code: "ENOENT" });
    const recovered = await openManager(source);
    expect((await recovered.getManagedPackages(vaultPath, vaultId))[0]).toMatchObject({
      currentVersion: "1.0.0",
      integrity: "verified",
    });
    expect(await fs.readFile(pluginPath("data.json"), "utf8")).toContain("recoverable");
  });

  it("restores the current package when rollback is interrupted after its swap", async () => {
    const source = new FixtureSource();
    const interrupted = await pausingManagerAt(source, "package-mutated");
    const install = await interrupted.manager.preview(vaultPath, vaultId, {
      action: "install",
      pluginId,
    });
    await interrupted.manager.apply(vaultPath, vaultId, install.reviewId);
    source.version = "2.0.0";
    const update = await interrupted.manager.preview(vaultPath, vaultId, {
      action: "install",
      pluginId,
    });
    await interrupted.manager.apply(vaultPath, vaultId, update.reviewId);
    await fs.writeFile(pluginPath("data.json"), '{"current":2}\n', "utf8");
    const rollback = await interrupted.manager.preview(vaultPath, vaultId, {
      action: "rollback",
      pluginId,
    });
    interrupted.arm();
    void interrupted.manager.apply(vaultPath, vaultId, rollback.reviewId);
    await interrupted.reached;

    expect(await fs.readFile(pluginPath("main.js"), "utf8")).toContain('"1.0.0"');
    const recovered = await openManager(source);
    expect((await recovered.getManagedPackages(vaultPath, vaultId))[0]).toMatchObject({
      currentVersion: "2.0.0",
      integrity: "verified",
    });
    expect(await fs.readFile(pluginPath("data.json"), "utf8")).toContain('"current":2');
  });

  it("keeps a package whose metadata commit completed before interruption", async () => {
    const source = new FixtureSource();
    const interrupted = await pausingManagerAt(source, "metadata-committed");
    const install = await interrupted.manager.preview(vaultPath, vaultId, {
      action: "install",
      pluginId,
    });
    await interrupted.manager.apply(vaultPath, vaultId, install.reviewId);
    source.version = "2.0.0";
    const update = await interrupted.manager.preview(vaultPath, vaultId, {
      action: "install",
      pluginId,
    });
    interrupted.arm();
    void interrupted.manager.apply(vaultPath, vaultId, update.reviewId);
    await interrupted.reached;

    const recovered = await openManager(source);
    expect((await recovered.getManagedPackages(vaultPath, vaultId))[0]).toMatchObject({
      currentVersion: "2.0.0",
      integrity: "verified",
      history: [{ version: "1.0.0" }],
    });
    expect(recovered.takeRecoveryNotices(vaultId).join(" ")).toContain(
      "reviewed package state was already committed",
    );
  });

  it("preserves externally changed committed cleanup evidence and its journal", async () => {
    const source = new FixtureSource();
    const interrupted = await pausingManagerAt(source, "metadata-committed");
    const install = await interrupted.manager.preview(vaultPath, vaultId, {
      action: "install",
      pluginId,
    });
    await interrupted.manager.apply(vaultPath, vaultId, install.reviewId);
    source.version = "2.0.0";
    const update = await interrupted.manager.preview(vaultPath, vaultId, {
      action: "install",
      pluginId,
    });
    interrupted.arm();
    void interrupted.manager.apply(vaultPath, vaultId, update.reviewId);
    await interrupted.reached;

    const pluginRoot = path.dirname(pluginPath());
    const rollbackName = (await fs.readdir(pluginRoot)).find((entry) =>
      entry.startsWith(".threadleaf-package-rollback-"),
    );
    expect(rollbackName).toBeDefined();
    const rollbackPath = path.join(pluginRoot, rollbackName as string);
    await fs.writeFile(path.join(rollbackPath, "external.txt"), "preserve evidence\n", "utf8");

    const recovered = await openManager(source);
    await expect(recovered.getManagedPackages(vaultPath, vaultId)).rejects.toThrow(
      "transaction evidence changed outside Threadleaf",
    );
    expect(await fs.readFile(path.join(rollbackPath, "external.txt"), "utf8")).toContain(
      "preserve evidence",
    );
    const transactionsRoot = path.join(statePath, "transactions", vaultId);
    expect(await fs.readdir(transactionsRoot)).toHaveLength(1);
    expect(await fs.readFile(pluginPath("main.js"), "utf8")).toContain('"2.0.0"');
  });

  it("retains and stores only the five newest rollback packages", async () => {
    const source = new FixtureSource();
    const manager = await openManager(source);
    const install = await manager.preview(vaultPath, vaultId, {
      action: "install",
      pluginId,
    });
    await manager.apply(vaultPath, vaultId, install.reviewId);

    for (let version = 2; version <= 7; version += 1) {
      source.version = `${version}.0.0`;
      const update = await manager.preview(vaultPath, vaultId, {
        action: "install",
        pluginId,
      });
      await manager.apply(vaultPath, vaultId, update.reviewId);
    }

    const managed = (await manager.getManagedPackages(vaultPath, vaultId))[0];
    expect(managed?.history.map((entry) => entry.version)).toEqual([
      "6.0.0",
      "5.0.0",
      "4.0.0",
      "3.0.0",
      "2.0.0",
    ]);
    const historyRoot = path.join(statePath, "vaults", vaultId, "history", pluginId);
    expect((await fs.readdir(historyRoot)).sort()).toEqual(
      managed?.history.map((entry) => entry.snapshotId).sort(),
    );
  });
});
