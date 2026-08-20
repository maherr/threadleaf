import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import {
  inspectSealedPluginPackage,
  PluginConstructionPolicyResolver,
} from "../main/plugin-construction-policy";
import { reviewedAuthorityPayload } from "../main/reviewed-authority-profiles";
import { authorityJsonSha256 } from "../shared/authority-json";
import { attachedPluginDiagnosticCode } from "../shared/plugin-diagnostics";
import {
  type CommunityPluginGrantV2,
  isPluginConstructionRefusal,
  type PluginCapabilityId,
  type PluginConstructionPolicy,
  pluginCapabilityIds,
  type ReviewedAuthorityProfile,
} from "../shared/plugins";
import {
  testConstructionDispatch,
  testConstructionRequest,
} from "../test-support/plugin-construction";
import { installObsidianDomCompatibility } from "./obsidian-dom";
import {
  maxConsumedPluginConstructionAttempts,
  PluginHost,
  waitForSettledPluginProjectionElement,
} from "./plugin-host";

const fixtureVault = path.resolve("fixtures/vaults/basic");
const fixturePlugin = path.join(fixtureVault, ".obsidian", "plugins", "threadleaf-fixture");

async function loadPlugin(host: PluginHost, pluginDirectory: string) {
  return host.loadAuthorizedPlugin(await testConstructionDispatch(pluginDirectory));
}

async function reloadPlugin(host: PluginHost, pluginDirectory: string) {
  return host.reloadAuthorizedPlugin(
    await testConstructionDispatch(pluginDirectory, "explicit-reload"),
  );
}

async function narrowConstructionDispatch(
  pluginDirectory: string,
  withheldAuthority: PluginCapabilityId,
) {
  const request = await testConstructionRequest(pluginDirectory);
  const sealedPackage = {
    sealedPackageRootId: `narrow-${request.packageIdentityDigest}`,
    sealedPackageRootPath: pluginDirectory,
    packageIdentityDigest: request.packageIdentityDigest,
    packageTreeSha256: request.packageIdentity.packageTreeSha256,
  };
  const inspected = await inspectSealedPluginPackage(
    sealedPackage,
    request.packageIdentity.distributionTag,
  );
  const requiredAuthorities = pluginCapabilityIds.filter(
    (capability) => capability !== withheldAuthority,
  );
  const profile: ReviewedAuthorityProfile = {
    $schema: "./reviewed-authority-profile.v1.schema.json",
    schemaVersion: 1,
    profileId: `narrow-${withheldAuthority}-${request.packageIdentityDigest}`,
    profileRevision: 1,
    packageIdentity: request.packageIdentity,
    packageIdentityDigest: request.packageIdentityDigest,
    expectedStaticCapabilities: inspected.staticCapabilities,
    requiredAuthorities,
    executionProfile: "trusted-node-renderer",
    allowedPlatforms: ["linux"],
    authorityDigest: "",
  };
  profile.authorityDigest = authorityJsonSha256(reviewedAuthorityPayload(profile));
  const grant: CommunityPluginGrantV2 = {
    schemaVersion: 2,
    grantId: `narrow-${withheldAuthority}`,
    vaultId: "narrow-vault",
    packageIdentity: request.packageIdentity,
    packageIdentityDigest: request.packageIdentityDigest,
    authorityProfileId: profile.profileId,
    authorityProfileRevision: profile.profileRevision,
    authorityDigest: profile.authorityDigest,
    grantedAuthorities: requiredAuthorities,
    provenance: {
      kind: "content-addressed-unsigned",
      sourceDescriptorDigest: "2".repeat(64),
    },
    grantRevision: 1,
    grantEpoch: 1,
    issuedAt: "2026-08-14T00:00:00.000Z",
    revokedAt: null,
    revocationReason: null,
  };
  return new PluginConstructionPolicyResolver({
    profileByIdentity: () => profile,
    readAuthoritySnapshot: async () => ({
      vaultId: "narrow-vault",
      vaultGeneration: 1,
      policyEpoch: 1,
      grantEpoch: 1,
      safeMode: false,
      safeModeEpoch: 1,
      packageStoreEpoch: 1,
      platform: "linux",
      availableExecutionProfiles: ["trusted-node-renderer"],
      grant,
      sealedPackage,
    }),
    createAttemptId: () => `narrow-${withheldAuthority}`,
    now: () => new Date("2026-08-14T00:00:00.000Z"),
  }).resolveAndConsume(request);
}

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
  it("waits through an async Markdown loading placeholder before capture", async () => {
    const dom = new JSDOM("<!doctype html><body><div id='projection'>Loading...</div></body>");
    try {
      const element = dom.window.document.querySelector<HTMLElement>("#projection");
      expect(element).not.toBeNull();
      if (!element) return;
      const settling = waitForSettledPluginProjectionElement(element, {
        quietMs: 5,
        timeoutMs: 100,
      });
      dom.window.setTimeout(() => {
        element.replaceChildren(dom.window.document.createElement("table"));
      }, 10);
      await expect(settling).resolves.toBeUndefined();
      expect(element.querySelector("table")).not.toBeNull();
    } finally {
      dom.window.close();
    }
  });

  it("rejects a Markdown projection that never leaves its loading state", async () => {
    const dom = new JSDOM("<!doctype html><body><div id='projection'>Loading...</div></body>");
    try {
      const element = dom.window.document.querySelector<HTMLElement>("#projection");
      expect(element).not.toBeNull();
      if (!element) return;
      await expect(
        waitForSettledPluginProjectionElement(element, { quietMs: 5, timeoutMs: 20 }),
      ).rejects.toThrow("did not settle its loading state");
    } finally {
      dom.window.close();
    }
  });

  it("pins test construction to a fresh non-default authority policy", async () => {
    const dispatch = await testConstructionDispatch(fixturePlugin);

    expect(dispatch.policy).toMatchObject({
      constructionPath: "test-execution",
      authorityProfileId: expect.stringContaining("test-threadleaf-fixture"),
      epoch: {
        policyEpoch: 23,
        grantEpoch: 31,
        grantRevision: 29,
        safeModeEpoch: 17,
        packageStoreEpoch: 13,
        authorityProfileRevision: 37,
      },
    });
    await expect(
      new PluginHost(fixtureVault).loadAuthorizedPlugin(dispatch),
    ).resolves.toMatchObject({
      plugin: { id: "threadleaf-fixture", state: "loaded" },
    });
  });

  it("builds synchronous frontmatter and link metadata from canonical vault files", () => {
    const host = new PluginHost(fixtureVault);
    const welcome = host.vault.getFileByPath("Welcome.md");

    expect(host.app.metadataCache.getFileCache(welcome)?.frontmatter).toEqual({
      type: "guide",
    });
    expect(host.app.metadataCache.getCachedFiles()).toEqual([
      "Boards/Overview.canvas",
      "Linked Note.md",
      "Welcome.md",
    ]);
    const linked = host.app.metadataCache.getFirstLinkpathDest("Linked Note#Heading", "Welcome.md");
    expect(linked?.path).toBe("Linked Note.md");
    expect(linked && host.app.metadataCache.fileToLinktext(linked, "Welcome.md", true)).toBe(
      "Linked Note",
    );

    const changed: string[] = [];
    const eventRef = host.app.metadataCache.on("changed", (file) => {
      changed.push((file as { path: string }).path);
    });
    host.app.metadataCache.trigger("changed", welcome);
    host.app.metadataCache.offref(eventRef);
    host.app.metadataCache.trigger("changed", welcome);
    expect(changed).toEqual(["Welcome.md"]);
  });

  it("never promotes compatibility evidence when an unchanged plugin command returns", async () => {
    const before = await readFixtureBytes();
    const host = new PluginHost(fixtureVault);

    const loaded = await loadPlugin(host, fixturePlugin);
    expect(loaded.vault.markdownFileCount).toBe(2);
    expect(loaded.plugin).toMatchObject({
      id: "threadleaf-fixture",
      state: "loaded",
      compatibilityLevel: 3,
      stylesheetDiscovered: true,
    });
    expect(host.app.plugins.getPlugin("threadleaf-fixture")?._loaded).toBe(true);
    expect(loaded.commands).toEqual([
      {
        id: "threadleaf-fixture:threadleaf-fixture-confirm",
        name: "Confirm compatibility bridge",
        ownerId: "threadleaf-fixture",
      },
    ]);

    const verified = await host.runCommand("threadleaf-fixture:threadleaf-fixture-confirm");
    expect(verified.plugin?.compatibilityLevel).toBe(3);
    expect(verified.notices).toContain("Fixture command crossed the compatibility bridge.");

    const after = await readFixtureBytes();
    expect(after).toEqual(before);
  });

  it("does not force a global command through a native editor without a renderer document", async () => {
    const host = new PluginHost(fixtureVault);
    await loadPlugin(host, fixturePlugin);

    const snapshot = await host.runCommand("threadleaf-fixture:threadleaf-fixture-confirm", {
      path: "Welcome.md",
      content: "unchanged",
      revision: "a".repeat(64),
      selection: { anchor: 0, head: 0 },
    });

    expect(snapshot.notices).toContain("Fixture command crossed the compatibility bridge.");
    expect(snapshot.editorUpdate).toBeNull();
  });

  it("rechecks the exact bundle bytes immediately before plugin execution", async () => {
    const bundleBytes = await fs.readFile(path.join(fixturePlugin, "main.js"));
    expect(createHash("sha256").update(bundleBytes).digest("hex")).toMatch(/^[a-f0-9]{64}$/u);

    const allowedHost = new PluginHost(fixtureVault);
    const allowed = await loadPlugin(allowedHost, fixturePlugin);
    expect(allowed.plugin).toMatchObject({
      id: "threadleaf-fixture",
      state: "loaded",
      compatibilityLevel: 3,
    });
    await allowedHost.close();
  });

  it("releases command registrations on unload and recreates them on reload", async () => {
    const host = new PluginHost(fixtureVault);
    await loadPlugin(host, fixturePlugin);

    const unloaded = await host.unloadPlugin();
    expect(unloaded.plugin?.state).toBe("unloaded");
    expect(unloaded.commands).toEqual([]);

    const reloaded = await reloadPlugin(host, fixturePlugin);
    expect(reloaded.plugin?.state).toBe("loaded");
    expect(reloaded.commands).toHaveLength(1);
    expect(reloaded.events.filter(({ message }) => message.startsWith("Unloaded "))).toHaveLength(
      1,
    );
  });

  it("makes direct load and reload entry points structurally incapable of evaluation", async () => {
    const host = new PluginHost(fixtureVault);
    const request = await testConstructionRequest(fixturePlugin, "diagnostic-execution");

    await expect(host.loadPlugin(request)).rejects.toSatisfy(
      (error: unknown) =>
        isPluginConstructionRefusal(error) && error.code === "authority-profile-missing",
    );
    await expect(host.reloadPlugin(request)).rejects.toSatisfy(
      (error: unknown) =>
        isPluginConstructionRefusal(error) && error.code === "authority-profile-missing",
    );
    expect((await host.getSnapshot()).plugin).toBeNull();
  });

  it("rejects a reused or digest-tampered main-process construction dispatch", async () => {
    const host = new PluginHost(fixtureVault);
    const dispatch = await testConstructionDispatch(fixturePlugin);
    await host.loadAuthorizedPlugin(dispatch);

    await expect(host.loadAuthorizedPlugin(dispatch)).rejects.toSatisfy(
      (error: unknown) => isPluginConstructionRefusal(error) && error.code === "policy-epoch-stale",
    );
    const fresh = await testConstructionDispatch(fixturePlugin);
    await expect(
      host.loadAuthorizedPlugin({
        ...fresh,
        policy: { ...fresh.policy, policyDigest: "0".repeat(64) },
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isPluginConstructionRefusal(error) && error.code === "policy-epoch-stale",
    );
  });

  it("rejects allow/deny contradictions before package evaluation", async () => {
    const host = new PluginHost(fixtureVault);
    const assertDispatch = (
      host as unknown as {
        assertConstructionDispatch(dispatch: unknown): void;
      }
    ).assertConstructionDispatch.bind(host);
    for (const contradiction of [
      { decision: "deny" as const, denialCode: null },
      { decision: "allow" as const, denialCode: "grant-required" as const },
    ]) {
      const dispatch = await testConstructionDispatch(fixturePlugin);
      const payload = {
        ...dispatch.policy,
        ...contradiction,
        policyDigest: undefined,
      };
      const { policyDigest: _policyDigest, ...withoutDigest } = payload;
      const policy = {
        ...withoutDigest,
        policyDigest: authorityJsonSha256(withoutDigest),
      } as PluginConstructionPolicy;
      expect(() => assertDispatch({ ...dispatch, policy })).toThrow(
        "complete main-process allow dispatch",
      );
    }
  });

  it("fails closed when the consumed-attempt replay ledger reaches its bound", async () => {
    const host = new PluginHost(fixtureVault);
    const baseDispatch = await testConstructionDispatch(fixturePlugin);
    const assertDispatch = (
      host as unknown as {
        assertConstructionDispatch(dispatch: unknown): void;
      }
    ).assertConstructionDispatch.bind(host);
    const dispatchForAttempt = (constructionAttemptId: string) => {
      const { policyDigest: _policyDigest, ...basePayload } = baseDispatch.policy;
      const payload = { ...basePayload, constructionAttemptId };
      return {
        ...baseDispatch,
        policy: { ...payload, policyDigest: authorityJsonSha256(payload) },
      };
    };
    for (let index = 0; index < maxConsumedPluginConstructionAttempts; index += 1) {
      assertDispatch(dispatchForAttempt(`ledger-attempt-${index}`));
    }

    let refusal: unknown;
    try {
      assertDispatch(dispatchForAttempt(`ledger-attempt-${maxConsumedPluginConstructionAttempts}`));
    } catch (error) {
      refusal = error;
    }
    expect(isPluginConstructionRefusal(refusal) && refusal.code).toBe("replay-ledger-exhausted");
  });

  it("rejects changed local dependency bytes before evaluating an unchanged main bundle", async () => {
    const sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-sealed-tree-"));
    const vaultPath = path.join(sandboxPath, "vault");
    const pluginPath = path.join(vaultPath, ".obsidian", "plugins", "tree-fixture");
    try {
      await fs.mkdir(pluginPath, { recursive: true });
      await fs.writeFile(
        path.join(pluginPath, "manifest.json"),
        JSON.stringify({ id: "tree-fixture", name: "Tree fixture", version: "1.0.0" }),
      );
      await fs.writeFile(
        path.join(pluginPath, "main.js"),
        'require("./dependency.js"); globalThis.__threadleafTreeEvaluated = true;\n',
      );
      await fs.writeFile(path.join(pluginPath, "dependency.js"), "module.exports = 1;\n");
      const dispatch = await testConstructionDispatch(pluginPath);
      await fs.writeFile(path.join(pluginPath, "dependency.js"), "module.exports = 2;\n");
      Reflect.deleteProperty(globalThis, "__threadleafTreeEvaluated");

      await expect(new PluginHost(vaultPath).loadAuthorizedPlugin(dispatch)).rejects.toSatisfy(
        (error: unknown) =>
          isPluginConstructionRefusal(error) && error.code === "package-identity-mismatch",
      );
      expect(Reflect.has(globalThis, "__threadleafTreeEvaluated")).toBe(false);
    } finally {
      Reflect.deleteProperty(globalThis, "__threadleafTreeEvaluated");
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });

  it("rejects traversal and symlink module resolutions outside the sealed root", async () => {
    const cases = ["traversal", "symlink"] as const;
    for (const mode of cases) {
      const sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), `threadleaf-module-${mode}-`));
      const vaultPath = path.join(sandboxPath, "vault");
      const pluginPath = path.join(vaultPath, ".obsidian", "plugins", `${mode}-fixture`);
      const outsidePath = path.join(vaultPath, ".obsidian", "plugins", `${mode}-outside.js`);
      const dependencyPath = path.join(pluginPath, "dependency.js");
      try {
        await fs.mkdir(pluginPath, { recursive: true });
        await fs.writeFile(
          path.join(pluginPath, "manifest.json"),
          JSON.stringify({ id: `${mode}-fixture`, name: `${mode} fixture`, version: "1.0.0" }),
        );
        await fs.writeFile(
          outsidePath,
          `globalThis.__threadleafModuleEscape = ${JSON.stringify(mode)}; module.exports = {};\n`,
        );
        await fs.writeFile(
          path.join(pluginPath, "main.js"),
          'require("./dependency.js");\nconst { Plugin } = require("obsidian");\nmodule.exports = class extends Plugin {};\n',
        );
        await fs.writeFile(
          dependencyPath,
          mode === "traversal"
            ? `require("../${mode}-outside.js"); module.exports = {};\n`
            : "module.exports = {};\n",
        );
        const dispatch = await testConstructionDispatch(pluginPath);
        const host = new PluginHost(vaultPath);
        const internals = host as unknown as {
          evaluatePlugin(
            entryPath: string,
            sealedPackageRoot: string,
            policy: PluginConstructionPolicy,
            verifiedFiles: ReadonlyMap<string, { sha256: string; size: number }>,
          ): Promise<unknown>;
          verifyPackageIdentity(
            rootPath: string,
            policy: PluginConstructionPolicy,
          ): Promise<ReadonlyMap<string, { sha256: string; size: number }>>;
        };
        const verifiedFiles = await internals.verifyPackageIdentity(pluginPath, dispatch.policy);
        if (mode === "symlink") {
          await fs.rename(dependencyPath, path.join(sandboxPath, "reviewed-dependency.js"));
          await fs.symlink(outsidePath, dependencyPath);
        }
        Reflect.deleteProperty(globalThis, "__threadleafModuleEscape");

        await expect(
          internals.evaluatePlugin(
            path.join(pluginPath, "main.js"),
            pluginPath,
            dispatch.policy,
            verifiedFiles,
          ),
        ).rejects.toSatisfy(
          (error: unknown) => attachedPluginDiagnosticCode(error) === "package-path-escape",
        );
        expect(Reflect.has(globalThis, "__threadleafModuleEscape")).toBe(false);
      } finally {
        Reflect.deleteProperty(globalThis, "__threadleafModuleEscape");
        await fs.rm(sandboxPath, { recursive: true, force: true });
      }
    }
  });

  it("admits Node builtins only when the reviewed policy discloses their authority", async () => {
    const sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-builtin-authority-"));
    const vaultPath = path.join(sandboxPath, "vault");
    const pluginPath = path.join(vaultPath, ".obsidian", "plugins", "builtin-fixture");
    try {
      await fs.mkdir(pluginPath, { recursive: true });
      await fs.writeFile(
        path.join(pluginPath, "manifest.json"),
        JSON.stringify({ id: "builtin-fixture", name: "Builtin fixture", version: "1.0.0" }),
      );
      await fs.writeFile(
        path.join(pluginPath, "main.js"),
        'require("node:fs"); const { Plugin } = require("obsidian"); module.exports = class extends Plugin {};\n',
      );
      const dispatch = await testConstructionDispatch(pluginPath);
      const withoutFilesystem = dispatch.policy.requiredAuthorities.filter(
        (capability) => capability !== "filesystem",
      );
      const { policyDigest: _policyDigest, ...payload } = {
        ...dispatch.policy,
        requiredAuthorities: withoutFilesystem,
      };
      const policy = {
        ...payload,
        policyDigest: authorityJsonSha256(payload),
      };

      await expect(
        new PluginHost(vaultPath).loadAuthorizedPlugin({ ...dispatch, policy }),
      ).rejects.toSatisfy(
        (error: unknown) =>
          isPluginConstructionRefusal(error) && error.code === "authority-profile-mismatch",
      );
    } finally {
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });

  it.each([
    {
      authority: "filesystem" as const,
      dependencyBytes: null,
      dependencyName: null,
      label: "node:sqlite",
      request: "node:sqlite",
    },
    {
      authority: "dynamic-code" as const,
      dependencyBytes: null,
      dependencyName: null,
      label: "node:inspector",
      request: "node:inspector",
    },
    {
      authority: "dynamic-code" as const,
      dependencyBytes: null,
      dependencyName: null,
      label: "node:v8",
      request: "node:v8",
    },
  ])("denies $label when its narrow profile withholds $authority", async (testCase) => {
    const sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-narrow-authority-"));
    const vaultPath = path.join(sandboxPath, "vault");
    const pluginPath = path.join(vaultPath, ".obsidian", "plugins", "narrow-fixture");
    try {
      await fs.mkdir(pluginPath, { recursive: true });
      await fs.writeFile(
        path.join(pluginPath, "manifest.json"),
        JSON.stringify({ id: "narrow-fixture", name: "Narrow fixture", version: "1.0.0" }),
      );
      await fs.writeFile(
        path.join(pluginPath, "main.js"),
        `require(${JSON.stringify(testCase.request)}); const { Plugin } = require("obsidian"); module.exports = class extends Plugin {};\n`,
      );
      if (testCase.dependencyName && testCase.dependencyBytes) {
        await fs.writeFile(
          path.join(pluginPath, testCase.dependencyName),
          testCase.dependencyBytes,
        );
      }
      const dispatch = await narrowConstructionDispatch(pluginPath, testCase.authority);

      await expect(new PluginHost(vaultPath).loadAuthorizedPlugin(dispatch)).rejects.toSatisfy(
        (error: unknown) =>
          isPluginConstructionRefusal(error) && error.code === "authority-profile-mismatch",
      );
    } finally {
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });

  it("rejects native addons before constructing an authority profile", async () => {
    const sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-native-addon-"));
    const vaultPath = path.join(sandboxPath, "vault");
    const pluginPath = path.join(vaultPath, ".obsidian", "plugins", "native-addon-fixture");
    try {
      await fs.mkdir(pluginPath, { recursive: true });
      await fs.writeFile(
        path.join(pluginPath, "manifest.json"),
        JSON.stringify({
          id: "native-addon-fixture",
          name: "Native addon fixture",
          version: "1.0.0",
        }),
      );
      await fs.writeFile(
        path.join(pluginPath, "main.js"),
        'require("./fixture.node"); module.exports = {};\n',
      );
      await fs.writeFile(path.join(pluginPath, "fixture.node"), Buffer.from([0, 1, 2, 3]));

      await expect(testConstructionDispatch(pluginPath)).rejects.toThrow(
        "Sealed plugin package contains an unreviewed native addon.",
      );
    } finally {
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });

  it("uses one bytewise package-path ordering for punctuation, case, and Unicode", async () => {
    const sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-path-order-"));
    const vaultPath = path.join(sandboxPath, "vault");
    const pluginPath = path.join(vaultPath, ".obsidian", "plugins", "path-order-fixture");
    const dependencyDirectory = path.join(pluginPath, "Deps [β]");
    try {
      await fs.mkdir(dependencyDirectory, { recursive: true });
      await fs.writeFile(
        path.join(pluginPath, "manifest.json"),
        JSON.stringify({ id: "path-order-fixture", name: "Path order fixture", version: "1.0.0" }),
      );
      await fs.writeFile(
        path.join(pluginPath, "main.js"),
        `require("./Deps [β]/Álpha #2.js");
require("./Deps [β]/alpha-10.js");
require("./Deps [β]/alpha-2.js");
const { Plugin } = require("obsidian");
module.exports = class extends Plugin {};
`,
      );
      await fs.writeFile(
        path.join(dependencyDirectory, "Álpha #2.js"),
        "globalThis.__threadleafPathOrder = ['unicode'];\n",
      );
      await fs.writeFile(
        path.join(dependencyDirectory, "alpha-10.js"),
        "globalThis.__threadleafPathOrder.push('ten');\n",
      );
      await fs.writeFile(
        path.join(dependencyDirectory, "alpha-2.js"),
        "globalThis.__threadleafPathOrder.push('two');\n",
      );
      Reflect.deleteProperty(globalThis, "__threadleafPathOrder");

      const snapshot = await loadPlugin(new PluginHost(vaultPath), pluginPath);

      expect(snapshot.plugin).toMatchObject({ id: "path-order-fixture", state: "loaded" });
      expect(Reflect.get(globalThis, "__threadleafPathOrder")).toEqual(["unicode", "ten", "two"]);
    } finally {
      Reflect.deleteProperty(globalThis, "__threadleafPathOrder");
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });

  it("rejects a dependency changed after closure verification but before delayed require", async () => {
    const sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-delayed-require-"));
    const vaultPath = path.join(sandboxPath, "vault");
    const pluginPath = path.join(vaultPath, ".obsidian", "plugins", "delayed-require-fixture");
    try {
      await fs.mkdir(pluginPath, { recursive: true });
      await fs.writeFile(
        path.join(pluginPath, "manifest.json"),
        JSON.stringify({
          id: "delayed-require-fixture",
          name: "Delayed require fixture",
          version: "1.0.0",
        }),
      );
      await fs.writeFile(
        path.join(pluginPath, "main.js"),
        `const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(path.join(__dirname, "dependency.js"), "module.exports = 2;\\n");
require("./dependency.js");
globalThis.__threadleafDelayedDependencyEvaluated = true;
const { Plugin } = require("obsidian");
module.exports = class extends Plugin {};
`,
      );
      await fs.writeFile(path.join(pluginPath, "dependency.js"), "module.exports = 1;\n");
      Reflect.deleteProperty(globalThis, "__threadleafDelayedDependencyEvaluated");

      await expect(loadPlugin(new PluginHost(vaultPath), pluginPath)).rejects.toSatisfy(
        (error: unknown) => attachedPluginDiagnosticCode(error) === "managed-package-changed",
      );
      expect(Reflect.has(globalThis, "__threadleafDelayedDependencyEvaluated")).toBe(false);
    } finally {
      Reflect.deleteProperty(globalThis, "__threadleafDelayedDependencyEvaluated");
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });

  it("closes plugin-owned modals on unload without duplicating them after reload", async () => {
    const sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-plugin-modal-"));
    const vaultPath = path.join(sandboxPath, "vault");
    const pluginPath = path.join(vaultPath, ".obsidian", "plugins", "modal-fixture");
    const otherPluginPath = path.join(vaultPath, ".obsidian", "plugins", "other-modal-fixture");
    const dom = new JSDOM("<!doctype html><body></body>", {
      url: "https://threadleaf.invalid/",
    });
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    try {
      installObsidianDomCompatibility(dom.window);
      Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
      });
      const pluginSource = `const { Modal, Plugin } = require("obsidian");
class FixtureModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }
  onOpen() { this.containerEl.addClass(this.plugin.manifest.id); }
}
module.exports = class ModalFixture extends Plugin {
  async onload() {
    new FixtureModal(this.app, this).open();
    this.addCommand({
      id: "open-anonymous-modal",
      name: "Open anonymous modal",
      callback: () => {
        const modal = new Modal(this.app);
        modal.containerEl.addClass("anonymous-command-modal");
        modal.open();
      },
    });
  }
};
`;
      for (const [directoryPath, manifest] of [
        [pluginPath, { id: "modal-fixture", name: "Modal fixture", version: "0.1.0" }],
        [
          otherPluginPath,
          { id: "other-modal-fixture", name: "Other modal fixture", version: "0.1.0" },
        ],
      ] as const) {
        await fs.mkdir(directoryPath, { recursive: true });
        await fs.writeFile(
          path.join(directoryPath, "manifest.json"),
          JSON.stringify(manifest),
          "utf8",
        );
        await fs.writeFile(path.join(directoryPath, "main.js"), pluginSource, "utf8");
      }

      const surfaceChanges = vi.fn();
      const host = new PluginHost(vaultPath, undefined, undefined, undefined, undefined, {
        onSurfaceChange: surfaceChanges,
      });
      await loadPlugin(host, pluginPath);
      await loadPlugin(host, otherPluginPath);
      expect(dom.window.document.querySelectorAll(".modal-fixture")).toHaveLength(1);
      expect(dom.window.document.querySelectorAll(".other-modal-fixture")).toHaveLength(1);
      expect((await host.getSnapshot()).pluginSurface).toEqual({
        displayText: "Other modal fixture dialog",
        filePath: null,
        viewType: "threadleaf-plugin-modal",
      });
      expect(surfaceChanges).toHaveBeenCalledTimes(2);

      await host.runCommand("modal-fixture:open-anonymous-modal");
      expect(dom.window.document.querySelectorAll(".anonymous-command-modal")).toHaveLength(1);

      await host.unloadPlugin("modal-fixture");
      expect(dom.window.document.querySelectorAll(".modal-fixture")).toHaveLength(0);
      expect(dom.window.document.querySelectorAll(".anonymous-command-modal")).toHaveLength(0);
      expect(dom.window.document.querySelectorAll(".other-modal-fixture")).toHaveLength(1);

      await reloadPlugin(host, pluginPath);
      expect(dom.window.document.querySelectorAll(".modal-fixture")).toHaveLength(1);
      expect(dom.window.document.querySelectorAll(".other-modal-fixture")).toHaveLength(1);
      await host.unloadPlugin("other-modal-fixture");
      await host.unloadPlugin("modal-fixture");
      expect((await host.getSnapshot()).pluginSurface).toBeNull();
    } finally {
      if (previousWindow === undefined) {
        Reflect.deleteProperty(globalThis, "window");
      } else {
        globalThis.window = previousWindow;
      }
      if (previousDocument === undefined) {
        Reflect.deleteProperty(globalThis, "document");
      } else {
        globalThis.document = previousDocument;
      }
      dom.window.close();
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });

  it("persists plugin data across reloads and host restarts", async () => {
    const sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-plugin-data-"));
    const vaultPath = path.join(sandboxPath, "vault");
    const pluginPath = path.join(vaultPath, ".obsidian", "plugins", "data-fixture");
    try {
      await fs.mkdir(pluginPath, { recursive: true });
      await fs.writeFile(
        path.join(pluginPath, "manifest.json"),
        JSON.stringify({ id: "data-fixture", name: "Data fixture", version: "0.1.0" }),
        "utf8",
      );
      await fs.writeFile(
        path.join(pluginPath, "main.js"),
        `const { Plugin } = require("obsidian");
module.exports = class DataFixture extends Plugin {
  async onload() {
    const data = (await this.loadData()) ?? { loads: 0 };
    data.loads += 1;
    await this.saveData(data);
    this.addCommand({ id: "data-fixture-command", name: "Data fixture command", callback() {} });
  }
};
`,
        "utf8",
      );

      const host = new PluginHost(vaultPath);
      await loadPlugin(host, pluginPath);
      await expect(fs.readFile(path.join(pluginPath, "data.json"), "utf8")).resolves.toContain(
        '"loads": 1',
      );

      await reloadPlugin(host, pluginPath);
      await expect(fs.readFile(path.join(pluginPath, "data.json"), "utf8")).resolves.toContain(
        '"loads": 2',
      );

      const restartedHost = new PluginHost(vaultPath);
      await loadPlugin(restartedHost, pluginPath);
      await expect(fs.readFile(path.join(pluginPath, "data.json"), "utf8")).resolves.toContain(
        '"loads": 3',
      );
    } finally {
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
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
      await loadPlugin(host, path.join(vaultPath, ".obsidian", "plugins", "threadleaf-fixture"));
      const bothLoaded = await loadPlugin(host, secondPlugin);

      expect(bothLoaded.plugins).toMatchObject([
        { id: "threadleaf-fixture", state: "loaded", compatibilityLevel: 3 },
        { id: "threadleaf-secondary", state: "loaded", compatibilityLevel: 3 },
      ]);
      expect(bothLoaded.commands.map(({ id, ownerId }) => ({ id, ownerId }))).toEqual([
        {
          id: "threadleaf-fixture:threadleaf-fixture-confirm",
          ownerId: "threadleaf-fixture",
        },
        {
          id: "threadleaf-secondary:threadleaf-secondary-confirm",
          ownerId: "threadleaf-secondary",
        },
      ]);

      const oneUnloaded = await host.unloadPlugin("threadleaf-secondary");
      expect(oneUnloaded.commands.map(({ id }) => id)).toEqual([
        "threadleaf-fixture:threadleaf-fixture-confirm",
      ]);
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
      await loadPlugin(host, failingPlugin);
      await loadPlugin(host, path.join(vaultPath, ".obsidian", "plugins", "threadleaf-fixture"));

      const unloaded = await host.unloadAllPlugins();

      expect(unloaded.commands).toEqual([]);
      expect(unloaded.plugins?.every(({ state }) => state === "unloaded")).toBe(true);
      expect(unloaded.plugins?.find(({ id }) => id === "failing-unload")?.error).toContain(
        "[runtime-unload-failed].",
      );
      expect(
        unloaded.events.some(({ message }) => message.includes("[runtime-unload-failed].")),
      ).toBe(true);
    } finally {
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });

  it("provides declared host modules to plugins copied outside the application tree", async () => {
    const sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-plugin-modules-"));
    const vaultPath = path.join(sandboxPath, "vault");
    try {
      await fs.mkdir(path.join(vaultPath, ".obsidian", "plugins"), { recursive: true });
      const pluginPath = path.join(vaultPath, ".obsidian", "plugins", "host-module-fixture");
      await fs.mkdir(pluginPath, { recursive: true });
      await fs.writeFile(
        path.join(pluginPath, "manifest.json"),
        JSON.stringify({
          id: "host-module-fixture",
          name: "Host module fixture",
          version: "0.1.0",
        }),
        "utf8",
      );
      await fs.writeFile(
        path.join(pluginPath, "main.js"),
        `const { EditorView } = require("@codemirror/view");
const { getLanguage, Notice, Plugin } = require("obsidian");
module.exports = class HostModulePlugin extends Plugin {
  async onload() {
    if (typeof EditorView !== "function") throw new Error("EditorView host module missing");
    if (!getLanguage()) throw new Error("Host language missing");
    this.addCommand({
      id: "confirm-host-module",
      name: "Confirm host module",
      callback: () => new Notice(EditorView.name + ":" + getLanguage()),
    });
  }
};
`,
        "utf8",
      );
      const host = new PluginHost(
        vaultPath,
        undefined,
        undefined,
        createRequire(path.resolve("package.json")),
      );

      const loaded = await loadPlugin(host, pluginPath);
      expect(loaded.plugin).toMatchObject({ state: "loaded", compatibilityLevel: 3 });

      const verified = await host.runCommand("host-module-fixture:confirm-host-module");
      expect(verified.notices.some((message) => message.startsWith("EditorView:"))).toBe(true);
    } finally {
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });

  it("provides UI base classes and releases registered integrations on unload", async () => {
    const sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-plugin-ui-api-"));
    const vaultPath = path.join(sandboxPath, "vault");
    const dom = new JSDOM("<!doctype html><body><div id='plugin-surface-host'></div></body>", {
      url: "https://threadleaf.invalid/",
    });
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousElement = globalThis.Element;
    const previousMouseEvent = globalThis.MouseEvent;
    try {
      installObsidianDomCompatibility(dom.window);
      Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        Element: dom.window.Element,
        MouseEvent: dom.window.MouseEvent,
      });
      const pluginPath = path.join(vaultPath, ".obsidian", "plugins", "ui-api-fixture");
      await fs.mkdir(pluginPath, { recursive: true });
      await fs.writeFile(
        path.join(pluginPath, "manifest.json"),
        JSON.stringify({ id: "ui-api-fixture", name: "UI API fixture", version: "0.1.0" }),
        "utf8",
      );
      await fs.writeFile(
        path.join(pluginPath, "main.js"),
        `const {
  AbstractInputSuggest, BaseComponent, ButtonComponent, Component, DropdownComponent, EditorSuggest, FileView,
  FuzzySuggestModal, ItemView, MarkdownView, Modal, Notice, Plugin, PluginSettingTab,
  PopoverSuggest, Scope, Setting, SettingTab, SliderComponent, SuggestModal, TextFileView,
  ToggleComponent, View, Workspace, WorkspaceLeaf, addIcon, normalizePath, sanitizeHTMLToDom
} = require("obsidian");
if (![AbstractInputSuggest, BaseComponent, ButtonComponent, Component, DropdownComponent, EditorSuggest, FileView,
  FuzzySuggestModal, ItemView, MarkdownView, Modal, PluginSettingTab, Scope, Setting,
  PopoverSuggest, SettingTab, SliderComponent, SuggestModal, TextFileView, ToggleComponent, View,
  Workspace, WorkspaceLeaf].every((value) => typeof value === "function")) {
  throw new Error("UI base class export missing");
}
module.exports = class UiApiPlugin extends Plugin {
  async onload() {
    if (normalizePath("/Folder\\\\Note.md") !== "Folder/Note.md") throw new Error("normalizePath failed");
    if (normalizePath("") !== "") throw new Error("normalizePath root failed");
    const safe = sanitizeHTMLToDom("<strong>safe</strong><script>unsafe()</script><a href='javascript:unsafe()'>link</a>");
    if (safe.querySelector("script") || safe.querySelector("a").hasAttribute("href") || safe.textContent !== "safelink") {
      throw new Error("sanitizeHTMLToDom failed");
    }
    addIcon("ui-api-icon", "<path d='M0 0h1v1z'/>");
    this.registerView("ui-api-view", (leaf) => new (class extends ItemView {
      getViewType() { return "ui-api-view"; }
    })(leaf));
    this.registerExtensions(["drawing"], "ui-api-view");
    this.addRibbonIcon("ui-api-icon", "Open drawing", () => {});
    this.addStatusBarItem().setText("Ready");
    this.addSettingTab(new (class extends PluginSettingTab {
      display() {
        window.__threadleafSettingsDisplays = (window.__threadleafSettingsDisplays || 0) + 1;
        this.containerEl.textContent = "UI API settings";
      }
      hide() {
        window.__threadleafSettingsHides = (window.__threadleafSettingsHides || 0) + 1;
        super.hide();
      }
    })(this.app, this));
    this.registerMarkdownPostProcessor(() => {});
    this.registerEditorSuggest(new (class extends EditorSuggest {})(this.app));
    this.app.workspace.onLayoutReady(() => new Notice("Fixture layout became ready."));
  }
};
`,
        "utf8",
      );

      const host = new PluginHost(vaultPath);
      const loaded = await loadPlugin(host, pluginPath);
      expect(loaded.plugin).toMatchObject({ state: "loaded", compatibilityLevel: 2 });
      expect(host.app.compatibility.snapshot()).toEqual({
        editorSuggests: 1,
        extensions: [{ extension: "drawing", viewType: "ui-api-view" }],
        markdownPostProcessors: 1,
        ribbonItems: 1,
        settingTabs: 1,
        settingTabPluginIds: ["ui-api-fixture"],
        statusBarItems: 1,
        viewTypes: ["ui-api-view"],
      });
      expect(loaded.notices).not.toContain("Fixture layout became ready.");

      await host.app.workspace.markLayoutReady();
      expect((await host.getSnapshot()).notices).toContain("Fixture layout became ready.");

      const settingsSnapshot = await host.openPluginSettings("ui-api-fixture");
      expect(settingsSnapshot.pluginSurface).toEqual({
        displayText: "UI API fixture settings",
        filePath: null,
        viewType: "threadleaf-plugin-settings",
      });
      expect(dom.window.document.querySelector(".vertical-tab-content")?.textContent).toBe(
        "UI API settings",
      );
      expect(
        dom.window.document.querySelector("#threadleaf-plugin-surface")?.parentElement?.id,
      ).toBe("plugin-surface-host");
      expect(dom.window.eval("window.__threadleafSettingsDisplays")).toBe(1);
      await host.closePluginView();
      expect(dom.window.eval("window.__threadleafSettingsHides")).toBe(1);
      expect(dom.window.document.querySelector("#threadleaf-plugin-surface")).toBeNull();

      const viewSnapshot = await host.openPluginView("ui-api-view", "Drawing.drawing");
      expect(viewSnapshot.pluginSurface).toMatchObject({
        filePath: "Drawing.drawing",
        viewType: "ui-api-view",
      });
      expect(
        dom.window.document.querySelector("#threadleaf-plugin-surface")?.parentElement?.id,
      ).toBe("plugin-surface-host");
      expect(host.app.workspace.getLayout()).toEqual({
        floating: { children: [], direction: "vertical", type: "split" },
        left: { children: [], direction: "vertical", type: "split" },
        main: {
          children: [
            {
              id: expect.stringMatching(/^threadleaf-leaf-/),
              state: {
                state: { file: "Drawing.drawing" },
                type: "ui-api-view",
              },
              type: "leaf",
            },
          ],
          direction: "vertical",
          type: "split",
        },
        right: { children: [], direction: "vertical", type: "split" },
      });

      const originalLeaf = host.app.workspace.activeLeaf;
      const splitLeaf = host.app.workspace.createLeafBySplit(originalLeaf);
      expect(splitLeaf).not.toBeNull();
      expect(host.app.workspace.getLayout().main.children).toHaveLength(2);
      expect((splitLeaf as { containerEl: HTMLElement }).containerEl.hidden).toBe(true);
      expect((splitLeaf as { containerEl: HTMLElement }).containerEl.style.display).toBe("none");
      expect(
        (splitLeaf as { containerEl: HTMLElement }).containerEl.style.getPropertyPriority(
          "display",
        ),
      ).toBe("important");
      host.app.workspace.setActiveLeaf(splitLeaf);
      expect((splitLeaf as { containerEl: HTMLElement }).containerEl.hidden).toBe(false);
      expect((splitLeaf as { containerEl: HTMLElement }).containerEl.style.display).toBe("flex");
      expect((originalLeaf as { containerEl: HTMLElement }).containerEl.hidden).toBe(true);
      expect((await host.getSnapshot()).pluginSurface).toMatchObject({
        filePath: "Drawing.drawing",
        viewType: "ui-api-view",
      });
      await fs.writeFile(path.join(vaultPath, "Drawing.md"), "# Drawing\n", "utf8");
      await (
        splitLeaf as {
          openFile(file: ReturnType<typeof host.app.createFile>): Promise<void>;
          view: { getViewType(): string } | null;
        }
      ).openFile(host.app.createFile("Drawing.md"));
      expect(
        (
          splitLeaf as {
            view: { getViewType(): string } | null;
          }
        ).view?.getViewType(),
      ).toBe("markdown");

      await host.unloadPlugin();
      expect(host.app.compatibility.snapshot()).toEqual({
        editorSuggests: 0,
        extensions: [],
        markdownPostProcessors: 0,
        ribbonItems: 0,
        settingTabs: 0,
        settingTabPluginIds: [],
        statusBarItems: 0,
        viewTypes: [],
      });
    } finally {
      if (previousWindow === undefined) {
        Reflect.deleteProperty(globalThis, "window");
      } else {
        globalThis.window = previousWindow;
      }
      if (previousDocument === undefined) {
        Reflect.deleteProperty(globalThis, "document");
      } else {
        globalThis.document = previousDocument;
      }
      if (previousElement === undefined) {
        Reflect.deleteProperty(globalThis, "Element");
      } else {
        globalThis.Element = previousElement;
      }
      if (previousMouseEvent === undefined) {
        Reflect.deleteProperty(globalThis, "MouseEvent");
      } else {
        globalThis.MouseEvent = previousMouseEvent;
      }
      dom.window.close();
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });

  it("renders 1.13 declarative plugin settings instead of the legacy display fallback", async () => {
    const sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-plugin-settings-"));
    const vaultPath = path.join(sandboxPath, "vault");
    const dom = new JSDOM("<!doctype html><body></body>", {
      url: "https://threadleaf.invalid/",
    });
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousElement = globalThis.Element;
    const previousMouseEvent = globalThis.MouseEvent;
    try {
      installObsidianDomCompatibility(dom.window);
      Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        Element: dom.window.Element,
        MouseEvent: dom.window.MouseEvent,
      });
      const pluginPath = path.join(vaultPath, ".obsidian", "plugins", "settings-fixture");
      await fs.mkdir(pluginPath, { recursive: true });
      await fs.writeFile(
        path.join(pluginPath, "manifest.json"),
        JSON.stringify({ id: "settings-fixture", name: "Settings fixture", version: "0.1.0" }),
        "utf8",
      );
      await fs.writeFile(
        path.join(pluginPath, "main.js"),
        `const { Plugin, PluginSettingTab } = require("obsidian");
module.exports = class SettingsFixture extends Plugin {
  async onload() {
    this.settings = Object.assign({ enabled: false, threshold: 2, mode: "focus" }, await this.loadData());
    this.addSettingTab(new (class extends PluginSettingTab {
      getSettingDefinitions() {
        return [
          {
            name: "Enable canvas helpers",
            desc: "Adds drawing-aware controls.",
            aliases: ["drawing"],
            control: { type: "toggle", key: "enabled" },
          },
          {
            name: "Canvas threshold",
            desc: "Visible only while helpers are enabled.",
            visible: () => this.plugin.settings.enabled,
            control: {
              type: "number",
              key: "threshold",
              min: 1,
              max: 8,
              validate: (value) => value < 1 || value > 8 ? "Choose a value from 1 to 8." : undefined,
            },
          },
          {
            type: "group",
            heading: "Drawing mode",
            search: {
              placeholder: "Filter drawing modes",
              match: (definition, query) => definition.name.toLowerCase().includes(query.toLowerCase()),
            },
            items: [{
              name: "Default mode",
              control: { type: "dropdown", key: "mode", options: { focus: "Focus", review: "Review" } },
            }],
          },
          {
            type: "page",
            name: "Advanced canvas",
            displayValue: () => this.plugin.settings.enabled ? "On" : "Off",
            items: [{ name: "Native renderer", control: { type: "toggle", key: "enabled" } }],
          },
        ];
      }
      display() {
        window.__threadleafLegacySettingsFallback = (window.__threadleafLegacySettingsFallback || 0) + 1;
      }
    })(this.app, this));
  }
};
`,
        "utf8",
      );

      const host = new PluginHost(vaultPath);
      await loadPlugin(host, pluginPath);
      await host.openPluginSettings("settings-fixture");

      expect(dom.window.eval("window.__threadleafLegacySettingsFallback || 0")).toBe(0);
      const enabledRow = dom.window.document.querySelector<HTMLElement>(
        '[data-setting-name="Enable canvas helpers"]',
      );
      const thresholdRow = dom.window.document.querySelector<HTMLElement>(
        '[data-setting-name="Canvas threshold"]',
      );
      expect(enabledRow?.dataset.settingSearch).toContain("drawing");
      expect(thresholdRow?.hidden).toBe(true);

      const pageRow = [
        ...dom.window.document.querySelectorAll<HTMLElement>(".setting-item-page"),
      ].find((element) => element.textContent?.includes("Advanced canvas"));
      pageRow?.click();
      expect(dom.window.document.querySelector(".setting-page-titlebar")?.textContent).toContain(
        "Advanced canvas",
      );
      expect(
        dom.window.document.querySelector('[data-setting-name="Native renderer"]'),
      ).not.toBeNull();
    } finally {
      if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window");
      else globalThis.window = previousWindow;
      if (previousDocument === undefined) Reflect.deleteProperty(globalThis, "document");
      else globalThis.document = previousDocument;
      if (previousElement === undefined) Reflect.deleteProperty(globalThis, "Element");
      else globalThis.Element = previousElement;
      if (previousMouseEvent === undefined) Reflect.deleteProperty(globalThis, "MouseEvent");
      else globalThis.MouseEvent = previousMouseEvent;
      dom.window.close();
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });

  it("runs check-callback commands against a native Markdown editor context", async () => {
    const sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-plugin-editor-"));
    const vaultPath = path.join(sandboxPath, "vault");
    const dom = new JSDOM("<!doctype html><body></body>", {
      url: "https://threadleaf.invalid/",
    });
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    try {
      installObsidianDomCompatibility(dom.window);
      Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
      });
      await fs.mkdir(vaultPath, { recursive: true });
      await fs.writeFile(path.join(vaultPath, "Welcome.md"), "alpha\nomega", "utf8");
      const pluginPath = path.join(vaultPath, ".obsidian", "plugins", "editor-fixture");
      await fs.mkdir(pluginPath, { recursive: true });
      await fs.writeFile(
        path.join(pluginPath, "manifest.json"),
        JSON.stringify({ id: "editor-fixture", name: "Editor fixture", version: "0.1.0" }),
        "utf8",
      );
      await fs.writeFile(
        path.join(pluginPath, "main.js"),
        `const { MarkdownView, Plugin } = require("obsidian");
module.exports = class EditorFixture extends Plugin {
  async onload() {
    this.addCommand({
      id: "callback-insert",
      name: "Callback insert",
      callback: () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return;
        view.editor.replaceSelection("callback");
        view.editor.focus();
      },
    });
    this.addCommand({
      id: "insert-embed",
      name: "Insert drawing embed",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return false;
        if (view.editor.editorComponent?.file?.path !== view.file?.path) {
          throw new Error("editorComponent did not expose the active file");
        }
        if (checking) return true;
        view.editor.replaceSelection("![[Drawing.excalidraw.md]]");
        view.editor.focus();
        return true;
      },
    });
  }
};
`,
        "utf8",
      );

      const host = new PluginHost(vaultPath);
      await loadPlugin(host, pluginPath);
      await expect(host.runCommand("editor-fixture:insert-embed")).rejects.toThrow(
        "[runtime-command-failed].",
      );
      const callbackSnapshot = await host.runCommand("editor-fixture:callback-insert", {
        path: "Welcome.md",
        content: "alpha\nomega",
        revision: "c".repeat(64),
        selection: { anchor: 0, head: 5 },
      });
      expect(callbackSnapshot.editorUpdate).toMatchObject({
        baseContent: "alpha\nomega",
        content: "callback\nomega",
        revision: "c".repeat(64),
      });
      const revision = "d".repeat(64);
      const snapshot = await host.runCommand("editor-fixture:insert-embed", {
        path: "Welcome.md",
        content: "alpha\nomega",
        revision,
        selection: { anchor: 6, head: 6 },
      });

      expect(snapshot.editorUpdate).toEqual({
        baseContent: "alpha\nomega",
        content: "alpha\n![[Drawing.excalidraw.md]]omega",
        focused: true,
        id: "threadleaf-plugin-editor-2",
        path: "Welcome.md",
        revision,
        selection: { anchor: 32, head: 32 },
      });
      expect(snapshot.pluginSurface).toBeNull();
      expect(snapshot.plugin?.compatibilityLevel).toBe(3);
      await expect(fs.readFile(path.join(vaultPath, "Welcome.md"), "utf8")).resolves.toBe(
        "alpha\nomega",
      );

      const secondSnapshot = await host.runCommand("editor-fixture:insert-embed", {
        path: "Welcome.md",
        content: "fresh content",
        revision: "e".repeat(64),
        selection: { anchor: 5, head: 5 },
      });
      expect(secondSnapshot.editorUpdate).toMatchObject({
        baseContent: "fresh content",
        content: "fresh![[Drawing.excalidraw.md]] content",
        revision: "e".repeat(64),
      });
    } finally {
      if (previousWindow === undefined) {
        Reflect.deleteProperty(globalThis, "window");
      } else {
        globalThis.window = previousWindow;
      }
      if (previousDocument === undefined) {
        Reflect.deleteProperty(globalThis, "document");
      } else {
        globalThis.document = previousDocument;
      }
      dom.window.close();
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });

  it("delivers revision-bound editor paste events and reports whether a plugin handled them", async () => {
    const sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-plugin-paste-"));
    const vaultPath = path.join(sandboxPath, "vault");
    const dom = new JSDOM("<!doctype html><body></body>", {
      url: "https://threadleaf.invalid/",
    });
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    try {
      installObsidianDomCompatibility(dom.window);
      Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
      });
      await fs.mkdir(vaultPath, { recursive: true });
      await fs.writeFile(path.join(vaultPath, "Welcome.md"), "alpha beta", "utf8");
      const pluginPath = path.join(vaultPath, ".obsidian", "plugins", "paste-fixture");
      await fs.mkdir(pluginPath, { recursive: true });
      await fs.writeFile(
        path.join(pluginPath, "manifest.json"),
        JSON.stringify({ id: "paste-fixture", name: "Paste fixture", version: "0.1.0" }),
        "utf8",
      );
      await fs.writeFile(
        path.join(pluginPath, "main.js"),
        `const { ItemView, Plugin } = require("obsidian");
module.exports = class PasteFixture extends Plugin {
  async onload() {
    this.registerView("paste-fixture-view", (leaf) => new class extends ItemView {
      getViewType() { return "paste-fixture-view"; }
      getDisplayText() { return "Paste fixture view"; }
    }(leaf));
    this.registerEvent(this.app.workspace.on("editor-paste", async (event, editor) => {
      await Promise.resolve();
      const text = event.clipboardData?.getData("text") ?? "";
      if (!text.startsWith("https://")) return;
      event.preventDefault();
      editor.replaceSelection("[" + editor.getSelection() + "](" + text + ")");
    }));
  }
};
`,
        "utf8",
      );

      const host = new PluginHost(vaultPath);
      await loadPlugin(host, pluginPath);
      const visible = await host.openPluginView("paste-fixture-view");
      expect(visible.pluginSurface?.viewType).toBe("paste-fixture-view");
      const revision = "f".repeat(64);
      const handled = await host.runPluginEditorPaste(
        {
          path: "Welcome.md",
          content: "alpha beta",
          revision,
          selection: { anchor: 0, head: 5 },
        },
        "https://example.test",
      );
      expect(handled.integrations?.workspaceEvents).toContain("editor-paste");
      expect(handled.editorEvent).toEqual({ handled: true, type: "paste" });
      expect(handled.pluginSurface).toBeNull();
      expect(handled.editorUpdate).toMatchObject({
        baseContent: "alpha beta",
        content: "[alpha](https://example.test) beta",
        revision,
        selection: { anchor: 29, head: 29 },
      });

      const ordinary = await host.runPluginEditorPaste(
        {
          path: "Welcome.md",
          content: "alpha beta",
          revision,
          selection: { anchor: 6, head: 10 },
        },
        "ordinary text",
      );
      expect(ordinary.editorEvent).toEqual({ handled: false, type: "paste" });
      expect(ordinary.editorUpdate).toMatchObject({ content: "alpha beta" });
      await host.close();
    } finally {
      if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window");
      else globalThis.window = previousWindow;
      if (previousDocument === undefined) Reflect.deleteProperty(globalThis, "document");
      else globalThis.document = previousDocument;
      dom.window.close();
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });

  it("rejects plugin directories outside the active vault", async () => {
    const host = new PluginHost(fixtureVault);
    const request = await testConstructionRequest(fixturePlugin);
    await expect(
      host.loadPlugin({ ...request, pluginDirectory: path.resolve("fixtures") }),
    ).rejects.toMatchObject({ code: "authority-profile-missing" });
  });
});
