import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PluginRuntimePort } from "../runtime/plugin-runtime-port";
import type { RuntimeSnapshot } from "../shared/contracts";
import {
  type ExactPluginPackageInput,
  exactInputFromDirectory,
  inspectPluginPackage,
  type PluginInspectionRuntimeContext,
  pluginPackageInspectionStageIds,
} from "./plugin-package-inspection";

const fixtureRoot = path.resolve("fixtures/plugin-packages");

async function fixtureInput(name: string): Promise<ExactPluginPackageInput> {
  return exactInputFromDirectory(path.join(fixtureRoot, name), {
    kind: "fixture",
    sourceUrl: `fixture://${name}`,
    releaseUrl: null,
    indexUrl: null,
    indexSha256: null,
  });
}

function runtimeSnapshot(
  pluginId: string,
  state: "loaded" | "unloaded" = "loaded",
  error: string | null = null,
): RuntimeSnapshot {
  const loaded = state === "loaded";
  return {
    vault: {
      id: null,
      name: "disposable",
      path: "/private-host-path-must-not-be-reported",
      markdownFileCount: 1,
      mode: "synthetic-read-only",
      source: "direct",
      warning: null,
    },
    plugin: {
      id: pluginId,
      name: "Inspection fixture",
      version: "0.1.0",
      state,
      compatibilityLevel: loaded ? 3 : 1,
      stylesheetDiscovered: true,
      error,
    },
    plugins: [
      {
        id: pluginId,
        name: "Inspection fixture",
        version: "0.1.0",
        state,
        compatibilityLevel: loaded ? 3 : 1,
        stylesheetDiscovered: true,
        error,
      },
    ],
    commands: loaded
      ? [{ id: `${pluginId}:command`, name: "Inspection command", ownerId: pluginId }]
      : [],
    actions: [],
    notices: [],
    events: [],
    integrations: {
      editorSuggests: 0,
      extensions: loaded ? [{ extension: "inspection", viewType: "inspection-view" }] : [],
      markdownPostProcessors: loaded ? 1 : 0,
      ribbonItems: 0,
      settingTabs: 0,
      statusBarItems: 0,
      viewTypes: loaded ? ["inspection-view"] : [],
    },
  };
}

function fakeRuntime(
  pluginId: string,
  behavior:
    | "normal"
    | "timeout"
    | "global"
    | "teardown"
    | "vault-write"
    | "outside-write"
    | "crash"
    | "secret-crash"
    | "sensitive-registration",
  context: PluginInspectionRuntimeContext,
): PluginRuntimePort {
  let loaded = false;
  return {
    async closePluginView() {
      return runtimeSnapshot(pluginId, loaded ? "loaded" : "unloaded");
    },
    async close() {
      loaded = false;
    },
    async getSnapshot() {
      return runtimeSnapshot(pluginId, loaded ? "loaded" : "unloaded");
    },
    async loadPlugin() {
      if (behavior === "timeout") {
        return new Promise<RuntimeSnapshot>(() => undefined);
      }
      if (behavior === "crash" || behavior === "secret-crash") {
        throw new Error(
          behavior === "secret-crash"
            ? "Error: /home/maher/private-token password=super-secret; at plugin.js:1:1"
            : "fixture activation crash",
        );
      }
      if (behavior === "global") {
        Object.assign(globalThis, { __threadleafInspectionGlobalCanary: true });
      }
      if (behavior === "vault-write") {
        await fs.writeFile(path.join(context.vaultPath, "runtime-write.md"), "fixture write\n");
      }
      if (behavior === "outside-write") {
        await fs.writeFile(
          path.join(path.dirname(context.vaultPath), "outside-write.txt"),
          "escape\n",
        );
      }
      loaded = true;
      const snapshot = runtimeSnapshot(pluginId);
      if (behavior === "sensitive-registration") {
        snapshot.commands = [
          {
            id: "/home/maher/private-token",
            name: "password=/home/maher/private-token",
            ownerId: pluginId,
          },
        ];
        snapshot.integrations = {
          editorSuggests: 0,
          extensions: [],
          markdownPostProcessors: 1,
          ribbonItems: 0,
          settingTabs: 0,
          statusBarItems: 0,
          viewTypes: ["/tmp/private-view"],
        };
      }
      return snapshot;
    },
    async markLayoutReady() {
      return runtimeSnapshot(pluginId);
    },
    async openPluginSettings() {
      return runtimeSnapshot(pluginId);
    },
    async openPluginView() {
      return runtimeSnapshot(pluginId);
    },
    async reloadPlugin() {
      return runtimeSnapshot(pluginId);
    },
    async runCommand() {
      return runtimeSnapshot(pluginId);
    },
    async waitForPluginMutations() {
      return runtimeSnapshot(pluginId, loaded ? "loaded" : "unloaded");
    },
    async unloadAllPlugins() {
      loaded = false;
      return runtimeSnapshot(
        pluginId,
        "unloaded",
        behavior === "teardown" ? "fixture teardown failed" : null,
      );
    },
    async unloadPlugin() {
      loaded = false;
      return runtimeSnapshot(pluginId, "unloaded");
    },
  };
}

async function runtimeFor(
  behavior: Parameters<typeof fakeRuntime>[1],
): Promise<(context: PluginInspectionRuntimeContext) => Promise<PluginRuntimePort>> {
  return async (context) => fakeRuntime(path.basename(context.pluginDirectory), behavior, context);
}

function withMain(input: ExactPluginPackageInput, source: string): ExactPluginPackageInput {
  const main = new TextEncoder().encode(source);
  return {
    ...input,
    assets: { ...input.assets, main },
    hashes: {
      ...input.hashes,
      mainSha256: createHash("sha256").update(main).digest("hex"),
    },
  };
}

function withManifest(
  input: ExactPluginPackageInput,
  manifest: Record<string, unknown>,
): ExactPluginPackageInput {
  const bytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  const id = String(manifest.id);
  const version = String(manifest.version);
  return {
    ...input,
    assets: { ...input.assets, manifest: bytes },
    hashes: {
      ...input.hashes,
      manifestSha256: createHash("sha256").update(bytes).digest("hex"),
    },
    provenance: {
      ...input.provenance,
      pluginId: id,
      version,
      releaseTag: version,
    },
  };
}

describe("exact plugin package inspection", () => {
  it("records CITE's declared minimum Obsidian version without treating it as Threadleaf semver", async () => {
    const input = withManifest(await fixtureInput("inspection-safe"), {
      id: "cite",
      name: "CITE",
      version: "0.1.2",
      minAppVersion: "1.12.7",
      description: "Exact CITE release fixture.",
      author: "Fixture author",
      isDesktopOnly: false,
    });

    const report = await inspectPluginPackage(input, { appVersion: "0.1.0-beta.3" });

    expect(report.overall).toBe("pass");
    expect(report.manifest).toEqual({
      id: "cite",
      version: "0.1.2",
      minAppVersion: "1.12.7",
      isDesktopOnly: false,
    });
    expect(report.input.provenance).toMatchObject({
      pluginId: "cite",
      version: "0.1.2",
      releaseTag: "0.1.2",
    });
    expect(report.input.assets.find((asset) => asset.filename === "manifest.json")).toEqual({
      filename: "manifest.json",
      size: input.assets.manifest.byteLength,
      sha256: input.hashes.manifestSha256,
    });
    expect(report.stages.find((stage) => stage.id === "minimum-app-platform")).toMatchObject({
      status: "pass",
      diagnostics: [],
    });
  });

  it("keeps invalid declared minimum Obsidian syntax and desktop-only packages blocked", async () => {
    const invalidMinimum = withManifest(await fixtureInput("inspection-safe"), {
      id: "cite",
      name: "CITE",
      version: "0.1.2",
      minAppVersion: "1.12.x",
      isDesktopOnly: false,
    });
    const invalidReport = await inspectPluginPackage(invalidMinimum, {
      appVersion: "0.1.0-beta.3",
    });
    expect(invalidReport.stages.find((stage) => stage.id === "minimum-app-platform")).toMatchObject(
      {
        status: "blocked",
        diagnostics: [
          expect.objectContaining({
            code: "unsupported-min-app-version",
            message: "Declared minimum Obsidian version has unsupported syntax.",
          }),
        ],
      },
    );

    const desktopOnly = withManifest(await fixtureInput("inspection-safe"), {
      id: "cite",
      name: "CITE",
      version: "0.1.2",
      minAppVersion: "1.12.7",
      isDesktopOnly: true,
    });
    const desktopReport = await inspectPluginPackage(desktopOnly, {
      platform: "headless-cli",
    });
    expect(desktopReport.stages.find((stage) => stage.id === "minimum-app-platform")).toMatchObject(
      {
        status: "blocked",
        diagnostics: [expect.objectContaining({ code: "desktop-only-package" })],
      },
    );
  });

  it("produces all-gates-passed evidence and an exact registry candidate for a fixture", async () => {
    const input = await fixtureInput("inspection-safe");
    const report = await inspectPluginPackage(input, { timeoutMs: 1_000 });

    expect(report.overall).toBe("pass");
    expect(report.candidate).toMatchObject({
      exactPackage: { id: "inspection-safe", version: "0.1.0" },
      compatibilityLevel: 3,
      evidenceStatus: "all-required-gates-passed",
    });
    expect(report.stages.map((stage) => stage.id)).toEqual(pluginPackageInspectionStageIds);
    expect(report.stages.every((stage) => stage.status === "pass")).toBe(true);
    expect(report.staticAuthority).toMatchObject({ staticOnly: true });
    expect(
      report.stages.every((stage) => {
        return stage.durationMs >= 0 && stage.toolVersion === "1.0.0" && stage.schemaVersion === 1;
      }),
    ).toBe(true);
    expect(report.registrations).toMatchObject({
      commands: [{ id: "inspection-safe-command" }],
      viewTypes: ["inspection-safe-view"],
      markdownPostProcessors: 1,
    });
    expect(JSON.stringify(report)).not.toContain("private-host-path");
    expect(JSON.stringify(report)).not.toContain("Inspection Fixture.md");
    expect(JSON.stringify(report)).not.toContain("/tmp/");
  });

  it("binds every result to exact bytes and refuses floating or tampered inputs", async () => {
    const input = await fixtureInput("inspection-safe");
    const tampered: ExactPluginPackageInput = {
      ...input,
      hashes: { ...input.hashes, mainSha256: "0".repeat(64) },
    };
    const tamperedReport = await inspectPluginPackage(tampered);
    expect(tamperedReport.overall).toBe("fail");
    expect(tamperedReport.candidate).toBeNull();
    expect(tamperedReport.stages[0]?.diagnostics[0]?.code).toBe("asset-digest-mismatch");

    const floatingReport = await inspectPluginPackage({
      ...input,
      provenance: { ...input.provenance, releaseTag: "latest" },
    });
    expect(floatingReport.overall).toBe("fail");
    expect(floatingReport.stages[0]?.diagnostics[0]?.code).toBe("floating-release-label");

    const malformedProvenance = await inspectPluginPackage({
      ...input,
      provenance: { ...input.provenance, indexSha256: "password" },
    });
    expect(malformedProvenance.input.provenance.indexSha256).toBeNull();
    expect(JSON.stringify(malformedProvenance)).not.toContain("password");
  });

  it("detects undeclared host authority and escape-shaped package entries before activation", async () => {
    const input = await fixtureInput("inspection-escape");
    const report = await inspectPluginPackage(input);
    const shapeReport = await inspectPluginPackage({
      ...input,
      entries: [...(input.entries ?? []), { path: "../outside-vault", kind: "symlink" }],
    });

    expect(report.overall).toBe("fail");
    expect(report.candidate).toBeNull();
    expect(report.dependencies).toContainEqual({ module: "node:fs", kind: "node-builtin" });
    expect(report.primitives.map((primitive) => primitive.id)).toEqual(
      expect.arrayContaining(["node-filesystem", "path-traversal"]),
    );
    expect(report.stages.find((stage) => stage.id === "activation")?.status).toBe("blocked");
    expect(shapeReport.stages[0]?.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "package-path-escape" })]),
    );
    expect(JSON.stringify(report)).not.toContain("readFileSync");
  });

  it("marks asynchronous runaway work as a failure, never a pass", async () => {
    const input = await fixtureInput("inspection-runaway");
    const report = await inspectPluginPackage(input, {
      timeoutMs: 10,
      runtimeFactory: await runtimeFor("timeout"),
    });

    expect(report.overall).toBe("fail");
    expect(report.stages.find((stage) => stage.id === "activation")?.status).toBe("fail");
    expect(report.stages.find((stage) => stage.id === "timeout")?.status).toBe("fail");
    expect(report.candidate).toBeNull();
  });

  it("detects host global mutation and teardown failures in trusted fixture execution", async () => {
    try {
      const globalInput = await fixtureInput("inspection-global-mutation");
      const globalReport = await inspectPluginPackage(globalInput, {
        runtimeFactory: await runtimeFor("global"),
      });
      expect(globalReport.overall).toBe("fail");
      expect(globalReport.vaultDiff).toEqual({
        changedFileCount: 0,
        createdFileCount: 0,
        removedFileCount: 0,
        outsideBoundaryCount: 0,
      });
      expect(globalReport.stages.find((stage) => stage.id === "cleanup")?.diagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "global-mutation" })]),
      );

      const teardownInput = await fixtureInput("inspection-teardown");
      const teardownReport = await inspectPluginPackage(teardownInput, {
        runtimeFactory: await runtimeFor("teardown"),
      });
      expect(teardownReport.overall).toBe("fail");
      expect(teardownReport.stages.find((stage) => stage.id === "cleanup")?.diagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "teardown-failure" })]),
      );
    } finally {
      delete (globalThis as Record<string, unknown>).__threadleafInspectionGlobalCanary;
    }
  });

  it("diffs disposable vault writes and fails an observed boundary escape", async () => {
    const input = await fixtureInput("inspection-safe");
    const written = await inspectPluginPackage(input, {
      runtimeFactory: await runtimeFor("vault-write"),
    });
    expect(written.overall).toBe("pass");
    expect(written.vaultDiff).toMatchObject({
      changedFileCount: 0,
      createdFileCount: 1,
      removedFileCount: 0,
      outsideBoundaryCount: 0,
    });

    const escaped = await inspectPluginPackage(input, {
      runtimeFactory: await runtimeFor("outside-write"),
    });
    expect(escaped.overall).toBe("fail");
    expect(escaped.vaultDiff?.outsideBoundaryCount).toBe(1);
    expect(escaped.stages.find((stage) => stage.id === "cleanup")?.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "outside-boundary-write" })]),
    );
  });

  it("keeps crash evidence failed and denies network unless a fixture runtime is explicit", async () => {
    const input = await fixtureInput("inspection-safe");
    const crash = await inspectPluginPackage(input, {
      runtimeFactory: await runtimeFor("crash"),
    });
    expect(crash.overall).toBe("fail");
    expect(crash.stages.find((stage) => stage.id === "activation")?.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "activation-crash" })]),
    );

    const networkInput = await fixtureInput("inspection-network");
    const denied = await inspectPluginPackage(networkInput);
    expect(denied.overall).toBe("blocked");
    expect(denied.stages.find((stage) => stage.id === "activation")?.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "prerequisite-not-met" })]),
    );
    const fixture = await inspectPluginPackage(networkInput, {
      networkMode: "deterministic-fixture",
      runtimeFactory: await runtimeFor("normal"),
    });
    expect(fixture.overall).toBe("pass");
    expect(fixture.stages.find((stage) => stage.id === "activation")?.limitations).toEqual(
      expect.arrayContaining([expect.stringContaining("deterministic fixture runtime")]),
    );
  });

  it("keeps plugin-thrown secrets and host paths out of inspection receipts", async () => {
    const report = await inspectPluginPackage(await fixtureInput("inspection-safe"), {
      runtimeFactory: await runtimeFor("secret-crash"),
    });
    const serialized = JSON.stringify(report);
    expect(report.overall).toBe("fail");
    expect(report.stages.find((stage) => stage.id === "activation")?.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "activation-crash" })]),
    );
    expect(serialized).not.toContain("/home/maher/private-token");
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("plugin.js:1:1");
  });

  it("redacts absolute module specifiers from evidence and still blocks them", async () => {
    const input = await fixtureInput("inspection-safe");
    const report = await inspectPluginPackage(
      withMain(
        input,
        'const secret = require("/home/maher/private-token"); module.exports = class Fixture {};',
      ),
    );
    expect(report.overall).toBe("fail");
    expect(report.dependencies).toContainEqual({
      module: "<unsafe-module-specifier>",
      kind: "unsafe-specifier",
    });
    expect(JSON.stringify(report)).not.toContain("/home/maher/private-token");
  });

  it("redacts host paths and secrets from runtime registration evidence", async () => {
    const report = await inspectPluginPackage(await fixtureInput("inspection-safe"), {
      runtimeFactory: await runtimeFor("sensitive-registration"),
    });
    expect(report.overall).toBe("pass");
    expect(report.registrations?.commands).toEqual([
      { id: "<redacted>", name: "<redacted>", ownerId: "inspection-safe" },
    ]);
    expect(report.registrations?.viewTypes).toEqual(["<redacted>"]);
    expect(JSON.stringify(report)).not.toContain("/home/maher/private-token");
  });

  it("does not leave the materialized disposable package on disk", async () => {
    const input = await fixtureInput("inspection-safe");
    const before = new Set(
      (await fs.readdir(os.tmpdir())).filter((entry) =>
        entry.startsWith("threadleaf-plugin-inspection-"),
      ),
    );
    await inspectPluginPackage(input);
    const after = new Set(
      (await fs.readdir(os.tmpdir())).filter((entry) =>
        entry.startsWith("threadleaf-plugin-inspection-"),
      ),
    );
    expect([...after].filter((entry) => !before.has(entry))).toEqual([]);
  });
});
