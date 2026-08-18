import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  PluginConstructionRequest,
  ReviewedAuthorityPlatform,
  ReviewedAuthorityProfile,
} from "../shared/plugins";
import type { PluginConstructionAuthoritySession } from "./plugin-construction-authority-store";
import { PluginConstructionAuthorityStore } from "./plugin-construction-authority-store";
import { reviewedAuthorityProfiles } from "./reviewed-authority-profiles";

const fixtureRoot = path.resolve("fixtures/plugin-packages/inspection-safe");
const scratchDirectories: string[] = [];
const testPlatform: ReviewedAuthorityPlatform =
  process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux";

interface AuthorityHarness {
  root: string;
  stateRoot: string;
  vaultRoot: string;
  pluginDirectory: string;
  vaultId: string;
  store: PluginConstructionAuthorityStore;
  session: PluginConstructionAuthoritySession;
  request: PluginConstructionRequest;
  profile: ReviewedAuthorityProfile;
}

function inspectionProfile(): ReviewedAuthorityProfile {
  const profile = reviewedAuthorityProfiles().find(
    ({ packageIdentity }) => packageIdentity.pluginId === "inspection-safe",
  );
  if (!profile) {
    throw new Error("Inspection-safe reviewed authority profile is missing.");
  }
  return profile;
}

function registerScratch(root: string): string {
  scratchDirectories.push(root);
  return root;
}

async function makeWritable(candidate: string): Promise<void> {
  const stat = await fs.lstat(candidate).catch(() => null);
  if (!stat || stat.isSymbolicLink()) {
    return;
  }
  if (!stat.isDirectory()) {
    if (stat.isFile()) {
      await fs.chmod(candidate, 0o600).catch(() => undefined);
    }
    return;
  }
  await fs.chmod(candidate, 0o700).catch(() => undefined);
  const entries = await fs.readdir(candidate, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) {
      await makeWritable(path.join(candidate, entry.name));
    }
  }
}

afterEach(async () => {
  const roots = scratchDirectories.splice(0);
  await Promise.all(
    roots.map(async (root) => {
      await makeWritable(root).catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    }),
  );
});

function createStore(stateRoot: string): PluginConstructionAuthorityStore {
  return new PluginConstructionAuthorityStore(stateRoot, {
    now: () => new Date("2026-08-16T12:00:00.000Z"),
    platform: testPlatform,
  });
}

async function vaultIdFor(vaultRoot: string): Promise<string> {
  const canonicalRoot = await fs.realpath(vaultRoot);
  const identityRoot = process.platform === "win32" ? canonicalRoot.toLowerCase() : canonicalRoot;
  return createHash("sha256").update(identityRoot).digest("hex");
}

async function createHarness(): Promise<AuthorityHarness> {
  const root = registerScratch(
    await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-authority-adversarial-")),
  );
  const stateRoot = path.join(root, "private-authority");
  const vaultRoot = path.join(root, "vault");
  const pluginDirectory = path.join(vaultRoot, ".obsidian", "plugins", "inspection-safe");
  const profile = inspectionProfile();

  await fs.mkdir(path.dirname(pluginDirectory), { recursive: true });
  await fs.cp(fixtureRoot, pluginDirectory, { recursive: true });

  const store = createStore(stateRoot);
  await store.initialize();
  const vaultId = await vaultIdFor(vaultRoot);
  const session = await store.activateVault(vaultId, vaultRoot, false);
  const request = await session.prepareConstructionRequest({
    pluginDirectory,
    reportedMainSha256: profile.packageIdentity.mainSha256,
    constructionPath: "test-execution",
  });

  return {
    root,
    stateRoot,
    vaultRoot,
    pluginDirectory,
    vaultId,
    store,
    session,
    request,
    profile,
  };
}

function authorityStatePath(harness: Pick<AuthorityHarness, "stateRoot" | "vaultId">): string {
  return path.join(harness.stateRoot, "vaults", harness.vaultId, "authority.json");
}

function authorityAnchorPath(harness: Pick<AuthorityHarness, "stateRoot" | "vaultId">): string {
  return path.join(harness.stateRoot, "anchors", `${harness.vaultId}.json`);
}

function pointerPath(
  harness: Pick<AuthorityHarness, "stateRoot">,
  request: PluginConstructionRequest,
): string {
  return path.join(
    harness.stateRoot,
    "packages",
    request.packageIdentityDigest,
    `${request.packageIdentity.packageTreeSha256}.json`,
  );
}

async function prepareRequest(
  session: PluginConstructionAuthoritySession,
  pluginDirectory: string,
  profile = inspectionProfile(),
): Promise<PluginConstructionRequest> {
  return session.prepareConstructionRequest({
    pluginDirectory,
    reportedMainSha256: profile.packageIdentity.mainSha256,
    constructionPath: "test-execution",
  });
}

async function sealedPackageIsAvailable(
  session: PluginConstructionAuthoritySession,
  request: PluginConstructionRequest,
): Promise<boolean> {
  try {
    return (await session.readAuthoritySnapshot(request)).sealedPackage !== null;
  } catch {
    return false;
  }
}

describe("PluginConstructionAuthorityStore adversarial contract", () => {
  it("rejects a valid pre-revocation state replay after restart", async () => {
    const harness = await createHarness();
    await harness.session.issueGrant(harness.request);
    const preRevocation = await fs.readFile(authorityStatePath(harness));
    await harness.session.revokePlugin("inspection-safe", "adversarial replay test");

    await fs.writeFile(authorityStatePath(harness), preRevocation);

    const restarted = createStore(harness.stateRoot);
    await expect(
      (async () => {
        await restarted.initialize();
        await restarted.activateVault(harness.vaultId, harness.vaultRoot, false);
      })(),
    ).rejects.toThrow();
  });

  it("rejects deletion of authority state when its independent anchor remains", async () => {
    const harness = await createHarness();
    await harness.session.issueGrant(harness.request);
    await harness.session.revokePlugin("inspection-safe", "anchor deletion test");
    await fs.rm(authorityStatePath(harness));

    const restarted = createStore(harness.stateRoot);
    await expect(
      (async () => {
        await restarted.initialize();
        await restarted.activateVault(harness.vaultId, harness.vaultRoot, false);
      })(),
    ).rejects.toThrow();
  });

  it("repairs the empty first-generation state when its initial anchor write was interrupted", async () => {
    const root = registerScratch(
      await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-authority-first-anchor-crash-")),
    );
    const stateRoot = path.join(root, "private-authority");
    const vaultRoot = path.join(root, "vault");
    await fs.mkdir(vaultRoot, { recursive: true });
    const vaultId = await vaultIdFor(vaultRoot);
    const firstStore = createStore(stateRoot);
    await firstStore.initialize();
    await firstStore.activateVault(vaultId, vaultRoot, false);

    await fs.rm(authorityAnchorPath({ stateRoot, vaultId }));

    const restarted = createStore(stateRoot);
    await restarted.initialize();
    const recovered = await restarted.activateVault(vaultId, vaultRoot, false);
    expect(recovered.vaultGeneration).toBe(2);
  });

  it("rejects a missing anchor after the state has gained package authority history", async () => {
    const harness = await createHarness();
    await fs.rm(authorityAnchorPath(harness));

    const restarted = createStore(harness.stateRoot);
    await expect(
      (async () => {
        await restarted.initialize();
        await restarted.activateVault(harness.vaultId, harness.vaultRoot, false);
      })(),
    ).rejects.toThrow();
  });

  it("binds an established vault identity to one physical root", async () => {
    const harness = await createHarness();
    const replacementRoot = path.join(harness.root, "different-vault");
    await fs.mkdir(replacementRoot);

    await expect(
      harness.store.activateVault(harness.vaultId, replacementRoot, false),
    ).rejects.toThrow();
  });

  it("rejects a session created by a different store instance", async () => {
    const harness = await createHarness();
    const otherStore = createStore(harness.stateRoot);
    await otherStore.initialize();

    await expect(
      otherStore.readAuthoritySnapshot(harness.session, harness.request),
    ).rejects.toThrow();
  });

  it("rejects a same-path vault replacement", async () => {
    const harness = await createHarness();
    const originalPath = path.join(harness.root, "vault-original");
    await fs.rename(harness.vaultRoot, originalPath);
    await fs.mkdir(harness.vaultRoot, { recursive: true });

    const restarted = createStore(harness.stateRoot);
    await expect(
      (async () => {
        await restarted.initialize();
        await restarted.activateVault(harness.vaultId, harness.vaultRoot, false);
      })(),
    ).rejects.toThrow();
  });

  for (const component of ["objects", "packages", "vaults", "anchors"] as const) {
    it(`rejects a symlinked ${component} state component`, async () => {
      const root = registerScratch(
        await fs.mkdtemp(path.join(os.tmpdir(), `threadleaf-authority-${component}-link-`)),
      );
      const stateRoot = path.join(root, "private-authority");
      const target = path.join(root, `${component}-target`);
      await fs.mkdir(stateRoot, { recursive: true });
      await fs.mkdir(target, { recursive: true });
      await fs.symlink(
        target,
        path.join(stateRoot, component),
        process.platform === "win32" ? "junction" : "dir",
      );

      await expect(createStore(stateRoot).initialize()).rejects.toThrow();
    });
  }

  it("rejects source preparation through a symlinked .obsidian/plugins root", async () => {
    const root = registerScratch(
      await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-authority-source-link-")),
    );
    const stateRoot = path.join(root, "private-authority");
    const vaultRoot = path.join(root, "vault");
    const pluginsRoot = path.join(vaultRoot, ".obsidian", "plugins");
    const externalPluginsRoot = path.join(root, "external-plugins");
    const pluginDirectory = path.join(pluginsRoot, "inspection-safe");

    await fs.mkdir(path.dirname(pluginsRoot), { recursive: true });
    await fs.mkdir(externalPluginsRoot, { recursive: true });
    await fs.cp(fixtureRoot, path.join(externalPluginsRoot, "inspection-safe"), {
      recursive: true,
    });
    await fs.symlink(
      externalPluginsRoot,
      pluginsRoot,
      process.platform === "win32" ? "junction" : "dir",
    );

    const store = createStore(stateRoot);
    await store.initialize();
    const vaultId = await vaultIdFor(vaultRoot);
    const session = await store.activateVault(vaultId, vaultRoot, false);

    await expect(prepareRequest(session, pluginDirectory)).rejects.toThrow();
  });

  it("preserves revocation and epochs across two store instances", async () => {
    const harness = await createHarness();
    const issued = await harness.session.issueGrant(harness.request);

    const otherStore = createStore(harness.stateRoot);
    await otherStore.initialize();
    const otherSession = await otherStore.activateVault(harness.vaultId, harness.vaultRoot, false);
    const otherRequest = await prepareRequest(
      otherSession,
      harness.pluginDirectory,
      harness.profile,
    );
    const revoked = await otherSession.revokePlugin(
      "inspection-safe",
      "cross-store revocation test",
    );
    expect(revoked?.grantId).toBe(issued.grantId);
    await expect(otherSession.grantState(otherRequest, "granted")).resolves.toBe("required");

    const refreshedSession = await harness.store.activateVault(
      harness.vaultId,
      harness.vaultRoot,
      false,
    );
    const refreshedRequest = await prepareRequest(
      refreshedSession,
      harness.pluginDirectory,
      harness.profile,
    );
    await expect(refreshedSession.grantState(refreshedRequest, "granted")).resolves.toBe(
      "required",
    );

    await refreshedSession.setSafeMode(true);
    const mutatedSnapshot = await refreshedSession.readAuthoritySnapshot(refreshedRequest);
    expect(mutatedSnapshot.safeMode).toBe(true);
    const finalStore = createStore(harness.stateRoot);
    await finalStore.initialize();
    const finalSession = await finalStore.activateVault(harness.vaultId, harness.vaultRoot, false);
    const finalRequest = await prepareRequest(
      finalSession,
      harness.pluginDirectory,
      harness.profile,
    );
    const finalSnapshot = await finalSession.readAuthoritySnapshot(finalRequest);
    expect(finalSnapshot.grant?.revokedAt).not.toBeNull();
  });

  it("serializes concurrent activation mutations across store instances", async () => {
    const root = registerScratch(
      await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-authority-concurrent-")),
    );
    const stateRoot = path.join(root, "private-authority");
    const vaultRoot = path.join(root, "vault");
    await fs.mkdir(vaultRoot, { recursive: true });
    const vaultId = await vaultIdFor(vaultRoot);
    const firstStore = createStore(stateRoot);
    const secondStore = createStore(stateRoot);
    await firstStore.initialize();
    await secondStore.initialize();

    await Promise.all([
      firstStore.activateVault(vaultId, vaultRoot, false),
      secondStore.activateVault(vaultId, vaultRoot, false),
    ]);

    const verifier = createStore(stateRoot);
    await verifier.initialize();
    const serialized = await verifier.activateVault(vaultId, vaultRoot, false);
    expect(serialized.vaultGeneration).toBe(3);
  });

  for (const corruption of ["dangling", "corrupt"] as const) {
    it(`keeps a ${corruption} sealed pointer fail closed until fresh preparation repairs it`, async () => {
      const harness = await createHarness();
      const sealed = (await harness.session.readAuthoritySnapshot(harness.request)).sealedPackage;
      if (!sealed) {
        throw new Error("Expected the exact reviewed package to be sealed.");
      }
      const pointer = pointerPath(harness, harness.request);

      if (corruption === "dangling") {
        const objectRoot = path.dirname(sealed.sealedPackageRootPath);
        await makeWritable(objectRoot);
        await fs.rm(objectRoot, { recursive: true, force: true });
      } else {
        await fs.chmod(pointer, 0o600);
        await fs.writeFile(pointer, Buffer.from("not-json\n", "utf8"));
      }

      expect(await sealedPackageIsAvailable(harness.session, harness.request)).toBe(false);

      const repaired = await prepareRequest(
        harness.session,
        harness.pluginDirectory,
        harness.profile,
      );
      expect(repaired.packageIdentityDigest).toBe(harness.request.packageIdentityDigest);
      expect(await sealedPackageIsAvailable(harness.session, repaired)).toBe(true);
    });
  }
});
