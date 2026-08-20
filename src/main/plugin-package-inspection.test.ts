import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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
            ? "Error: /home/threadleaf-user/private-token password=super-secret; at plugin.js:1:1"
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
            id: "/home/threadleaf-user/private-token",
            name: "password=/home/threadleaf-user/private-token",
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

/**
 * Spies on `fs.mkdtemp` to capture every per-run temporary root that
 * `inspectPluginPackage` materializes for the given call, instead of scanning the shared
 * `os.tmpdir()` namespace for `threadleaf-plugin-inspection-*` entries. A namespace scan cannot
 * tell this run's own directories apart from a same-prefixed directory belonging to a genuinely
 * parallel, unrelated run sharing the same host temp directory, so it can misattribute that
 * sibling as this run's leaked residue. Capturing the exact created paths keeps residue
 * accounting scoped only to what this specific call created -- all of it. Keeping only the most
 * recently captured root would let a second, separately leaked root hide behind a properly
 * cleaned-up last one; every caller must check every entry in `rootPaths`, not just one.
 */
async function withCapturedMaterializedRoot<T>(
  action: () => Promise<T>,
): Promise<{ outcome: T; rootPaths: string[] }> {
  const realMkdtemp = fs.mkdtemp.bind(fs);
  const capturedRoots: string[] = [];
  const mkdtempSpy = vi
    .spyOn(fs, "mkdtemp")
    .mockImplementation(async (prefix: string, options?: unknown) => {
      const created = await realMkdtemp(prefix, options as Parameters<typeof fs.mkdtemp>[1]);
      capturedRoots.push(created);
      return created;
    });
  try {
    const outcome = await action();
    if (capturedRoots.length === 0) {
      throw new Error("expected inspectPluginPackage to materialize a temporary root");
    }
    return { outcome, rootPaths: capturedRoots };
  } finally {
    mkdtempSpy.mockRestore();
  }
}

async function pathExists(target: string): Promise<boolean> {
  return fs
    .stat(target)
    .then(() => true)
    .catch(() => false);
}

describe("exact plugin package inspection", () => {
  it("excludes mutable installed-plugin state while retaining unknown distribution entries", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-installed-plugin-input-"));
    try {
      await fs.cp(path.join(fixtureRoot, "inspection-safe"), root, { recursive: true });
      await fs.writeFile(path.join(root, "data.json"), '{"userSetting":true}\n');
      await fs.writeFile(path.join(root, ".threadleaf-package.json"), "{}\n");
      const installed = await exactInputFromDirectory(root, {
        kind: "local",
        sourceUrl: null,
        releaseUrl: null,
        indexUrl: null,
        indexSha256: null,
      });

      expect((installed.entries ?? []).map(({ path: entryPath }) => entryPath).sort()).toEqual([
        "main.js",
        "manifest.json",
        "styles.css",
      ]);

      await fs.writeFile(path.join(root, "unexpected.bin"), "distribution byte\n");
      const unexpected = await exactInputFromDirectory(root, {
        kind: "local",
        sourceUrl: null,
        releaseUrl: null,
        indexUrl: null,
        indexSha256: null,
      });
      expect((unexpected.entries ?? []).map(({ path: entryPath }) => entryPath)).toContain(
        "unexpected.bin",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

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

    const report = await inspectPluginPackage(input, {
      appVersion: "0.1.0-beta.3",
      runtimeFactory: await runtimeFor("normal"),
    });

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
    let observedConstructionPath: string | null = null;
    const report = await inspectPluginPackage(input, {
      timeoutMs: 1_000,
      runtimeFactory: async (context) => {
        observedConstructionPath = context.constructionRequest.constructionPath;
        return fakeRuntime("inspection-safe", "normal", context);
      },
    });

    expect(report.overall).toBe("pass");
    expect(observedConstructionPath).toBe("diagnostic-execution");
    expect(report.candidate).toMatchObject({
      exactPackage: { id: "inspection-safe", version: "0.1.0" },
      compatibilityLevel: 3,
      evidenceStatus: "all-required-gates-passed",
    });
    expect(report.stages.map((stage) => stage.id)).toEqual(pluginPackageInspectionStageIds);
    expect(report.stages.every((stage) => stage.status === "pass")).toBe(true);
    expect(report.staticAuthority).toMatchObject({ staticOnly: true });
    expect(report.dependencies).toContainEqual({ module: "node:buffer", kind: "node-builtin" });
    expect(
      report.stages.every((stage) => {
        return stage.durationMs >= 0 && stage.toolVersion === "1.0.0" && stage.schemaVersion === 1;
      }),
    ).toBe(true);
    expect(report.registrations).toMatchObject({
      commands: [{ id: "inspection-safe:command" }],
      viewTypes: ["inspection-view"],
      markdownPostProcessors: 1,
    });
    expect(JSON.stringify(report)).not.toContain("private-host-path");
    expect(JSON.stringify(report)).not.toContain("Inspection Fixture.md");
    expect(JSON.stringify(report)).not.toContain("/tmp/");
  });

  it.skipIf(process.platform === "win32")(
    "canonicalizes a symlinked host temp root before trusted runtime construction",
    async () => {
      const hostRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "threadleaf-inspection-canonical-root-"),
      );
      const realTemporaryDirectory = path.join(hostRoot, "real");
      const aliasedTemporaryDirectory = path.join(hostRoot, "alias");
      await fs.mkdir(realTemporaryDirectory);
      await fs.symlink(realTemporaryDirectory, aliasedTemporaryDirectory, "dir");

      const realMkdtemp = fs.mkdtemp.bind(fs);
      const mkdtempSpy = vi
        .spyOn(fs, "mkdtemp")
        .mockImplementation(async (prefix: string, options?: unknown) =>
          realMkdtemp(
            path.join(aliasedTemporaryDirectory, path.basename(prefix)),
            options as Parameters<typeof fs.mkdtemp>[1],
          ),
        );
      try {
        const report = await inspectPluginPackage(await fixtureInput("inspection-safe"), {
          runtimeFactory: async (context) => {
            expect(context.vaultPath).toBe(await fs.realpath(context.vaultPath));
            expect(context.pluginDirectory).toBe(await fs.realpath(context.pluginDirectory));
            return fakeRuntime("inspection-safe", "normal", context);
          },
        });
        expect(report.overall).toBe("pass");
      } finally {
        mkdtempSpy.mockRestore();
        await fs.rm(hostRoot, { recursive: true, force: true });
      }
    },
  );

  it("never activates the exact package when the caller requests static-only inspection", async () => {
    const input = await fixtureInput("inspection-safe");
    const report = await inspectPluginPackage(input, { timeoutMs: 1_000, runActivation: false });

    expect(report.overall).toBe("blocked");
    expect(
      report.stages.filter((stage) =>
        [
          "package-shape",
          "manifest-schema",
          "dependency-model",
          "minimum-app-platform",
          "static-authority",
          "banned-private-primitives",
        ].includes(stage.id),
      ),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ status: "pass" })]));
    expect(report.stages.find((stage) => stage.id === "activation")?.status).toBe("blocked");
    expect(report.stages.find((stage) => stage.id === "registration-snapshot")?.status).toBe(
      "blocked",
    );
    expect(report.staticAuthority).toMatchObject({ staticOnly: true });
    expect(report.registrations).toBeNull();
    expect(report.candidate).toBeNull();

    const activated = await inspectPluginPackage(input, {
      timeoutMs: 1_000,
      runtimeFactory: await runtimeFor("normal"),
    });
    expect(activated.stages.find((stage) => stage.id === "activation")?.status).toBe("pass");
  });

  it("preserves an unprofiled exact package's construction denial code", async () => {
    const input = withManifest(await fixtureInput("inspection-safe"), {
      id: "inspection-unprofiled",
      name: "Inspection Unprofiled Fixture",
      version: "0.1.0",
      isDesktopOnly: false,
    });
    const report = await inspectPluginPackage(input);

    expect(report.overall).toBe("fail");
    expect(report.stages.find((stage) => stage.id === "activation")?.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "authority-profile-missing" })]),
    );
    expect(JSON.stringify(report)).not.toContain("Community plugin construction was denied");
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

  it("ignores dependency-like text outside executable code while retaining real requires", async () => {
    const input = withMain(
      await fixtureInput("inspection-safe"),
      [
        'const obsidian = require("obsidian");',
        'const message = `require("/private/not-a-module") $' + "{obsidian}`;",
        'const quoted = "require(dynamicSecret)";',
        'const matcher = /require\\("/private/also-not-a-module"\\)/u;',
        '// require("/private/comment")',
        "module.exports = class Fixture extends obsidian.Plugin {};",
      ].join("\n"),
    );
    const report = await inspectPluginPackage(input, { runActivation: false });

    expect(report.dependencies).toEqual([{ module: "obsidian", kind: "obsidian-api" }]);
    expect(report.stages.find((stage) => stage.id === "dependency-model")).toMatchObject({
      status: "pass",
      diagnostics: [],
    });
  });

  it("allows only the fixed global-object probe while blocking arbitrary dynamic evaluation", async () => {
    const fixedLookup = await inspectPluginPackage(
      withMain(
        await fixtureInput("inspection-safe"),
        'const root = Function("return this")(); module.exports = class Fixture { value = root; };',
      ),
      { runActivation: false },
    );
    const arbitrary = await inspectPluginPackage(
      withMain(
        await fixtureInput("inspection-safe"),
        'const root = Function("return process")(); module.exports = class Fixture { value = root; };',
      ),
      { runActivation: false },
    );

    expect(
      fixedLookup.stages.find((stage) => stage.id === "banned-private-primitives"),
    ).toMatchObject({ status: "pass" });
    expect(fixedLookup.primitives).toContainEqual(
      expect.objectContaining({ id: "global-object-discovery", severity: "warning" }),
    );
    expect(
      arbitrary.stages.find((stage) => stage.id === "banned-private-primitives"),
    ).toMatchObject({ status: "fail" });
    expect(arbitrary.primitives).toContainEqual(
      expect.objectContaining({ id: "dynamic-evaluation", severity: "blocked" }),
    );
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
    expect(serialized).not.toContain("/home/threadleaf-user/private-token");
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("plugin.js:1:1");
  });

  it("redacts absolute module specifiers from evidence and still blocks them", async () => {
    const input = await fixtureInput("inspection-safe");
    const report = await inspectPluginPackage(
      withMain(
        input,
        'const secret = require("/home/threadleaf-user/private-token"); module.exports = class Fixture {};',
      ),
    );
    expect(report.overall).toBe("fail");
    expect(report.dependencies).toContainEqual({
      module: "<unsafe-module-specifier>",
      kind: "unsafe-specifier",
    });
    expect(JSON.stringify(report)).not.toContain("/home/threadleaf-user/private-token");
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
    expect(JSON.stringify(report)).not.toContain("/home/threadleaf-user/private-token");
  });

  it("does not leave the materialized disposable package on disk", async () => {
    const input = await fixtureInput("inspection-safe");
    const runtimeFactory = await runtimeFor("normal");
    const { outcome: report, rootPaths } = await withCapturedMaterializedRoot(() =>
      inspectPluginPackage(input, { runtimeFactory }),
    );
    expect(report.overall).toBe("pass");
    // A single inspection run must materialize exactly one temporary root. Asserting the
    // count, not just the survival of whichever root was captured last, is what stops a
    // second, separately leaked root from hiding behind a properly cleaned-up final one.
    expect(rootPaths).toHaveLength(1);
    for (const rootPath of rootPaths) {
      expect(await pathExists(rootPath)).toBe(false);
    }
  });

  it("does not misattribute a foreign sibling inspection directory created during a run", async () => {
    const input = await fixtureInput("inspection-safe");
    const realMkdtemp = fs.mkdtemp.bind(fs);
    let foreignSibling = "";
    const { outcome: report, rootPaths } = await withCapturedMaterializedRoot(async () => {
      const inspectionPromise = inspectPluginPackage(input, {
        runtimeFactory: await runtimeFor("normal"),
      });
      // Simulate a genuinely parallel, unrelated run whose own uniquely mkdtemp'd root lands in
      // the same shared `threadleaf-plugin-inspection-*` namespace while this run is in flight.
      // A namespace scan taken before and after this call would see this directory appear in
      // between and mistake it for this run's own leaked residue. Using the unspied
      // `realMkdtemp` keeps it out of `rootPaths`, exactly like a foreign process's own call
      // would be.
      foreignSibling = await realMkdtemp(path.join(os.tmpdir(), "threadleaf-plugin-inspection-"));
      await fs.writeFile(
        path.join(foreignSibling, "unrelated-run.marker"),
        "belongs to a different, still-in-flight run",
        "utf8",
      );
      return inspectionPromise;
    });
    try {
      expect(report.overall).toBe("pass");
      expect(rootPaths).toHaveLength(1);
      expect(rootPaths).not.toContain(foreignSibling);
      // This run's own materialized root was still cleaned up normally...
      for (const rootPath of rootPaths) {
        expect(await pathExists(rootPath)).toBe(false);
      }
      // ...while the foreign sibling was never touched, swept, or blamed on this run.
      expect(await pathExists(foreignSibling)).toBe(true);
      expect(await fs.readdir(foreignSibling)).toEqual(["unrelated-run.marker"]);
    } finally {
      await fs.rm(foreignSibling, { recursive: true, force: true });
    }
  });

  it("still detects a genuine leak of its own materialized directory", async () => {
    const input = await fixtureInput("inspection-safe");
    const realMkdtemp = fs.mkdtemp.bind(fs);
    const realRm = fs.rm.bind(fs);
    let capturedRoot: string | undefined;
    const mkdtempSpy = vi
      .spyOn(fs, "mkdtemp")
      .mockImplementation(async (prefix: string, options?: unknown) => {
        const created = await realMkdtemp(prefix, options as Parameters<typeof fs.mkdtemp>[1]);
        capturedRoot = created;
        return created;
      });
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      const sameCapturedRoot = capturedRoot
        ? await Promise.all([
            fs.stat(capturedRoot, { bigint: true }),
            fs.stat(target, { bigint: true }),
          ]).then(([left, right]) => left.dev === right.dev && left.ino === right.ino)
        : false;
      if (sameCapturedRoot) {
        // Simulate a cleanup call that silently fails to remove this run's own root, the way a
        // permission race or unsupported filesystem behavior could in production.
        return;
      }
      return realRm(target as Parameters<typeof fs.rm>[0], options as Parameters<typeof fs.rm>[1]);
    });
    try {
      const report = await inspectPluginPackage(input, {
        runtimeFactory: await runtimeFor("normal"),
      });
      expect(report.overall).toBe("pass");
      expect(capturedRoot).toBeDefined();
      // A genuine leak of this run's own root remains observable: a residue check would
      // correctly go red here instead of passing regardless of what happened on disk.
      expect(await pathExists(capturedRoot as string)).toBe(true);
    } finally {
      mkdtempSpy.mockRestore();
      rmSpy.mockRestore();
      if (capturedRoot) {
        await fs.rm(capturedRoot, { recursive: true, force: true });
      }
    }
  });

  it("still detects a leaked second temporary root even when a later, unrelated root is cleaned up normally", async () => {
    // Reproduces the planted-second-mkdtemp finding directly: with only the LAST captured
    // root retained, a root leaked before the run's own (properly cleaned up) root would
    // never be checked, so a residue assertion would false-pass while it sat on disk.
    const input = await fixtureInput("inspection-safe");
    let plantedLeak = "";
    const { outcome: report, rootPaths } = await withCapturedMaterializedRoot(async () => {
      // Plant an extra mkdtemp call through the SAME spied `fs.mkdtemp` entry point that
      // `inspectPluginPackage` uses, before its own call, and never clean it up here -- this
      // stands in for a second, genuinely leaked temporary root.
      plantedLeak = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-plugin-inspection-"));
      return inspectPluginPackage(input, { runtimeFactory: await runtimeFor("normal") });
    });
    try {
      expect(report.overall).toBe("pass");
      // Both mkdtemp calls were captured, in creation order: the planted leak first, then
      // inspectPluginPackage's own root.
      expect(rootPaths).toHaveLength(2);
      expect(rootPaths[0]).toBe(plantedLeak);

      const stillExisting = await Promise.all(rootPaths.map((root) => pathExists(root)));
      // inspectPluginPackage's own root (the one a single-slot helper would have kept) was
      // cleaned up normally, while the planted first root -- the one a single-slot helper
      // would have silently discarded from tracking -- is still on disk. Checking every
      // captured root, not just the last one, is what makes that residue observable.
      expect(stillExisting).toEqual([true, false]);
    } finally {
      await fs.rm(plantedLeak, { recursive: true, force: true });
    }
  });
});
