import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { PluginConstructionRequest } from "../shared/plugins";
import { PluginConstructionAuthorityStore } from "./plugin-construction-authority-store";
import { PluginConstructionPolicyResolver } from "./plugin-construction-policy";
import { reviewedAuthorityProfiles } from "./reviewed-authority-profiles";

const fixtureRoot = path.resolve("fixtures/plugin-packages/inspection-safe");
const scratchDirectories: string[] = [];

async function vaultIdFor(vaultRoot: string): Promise<string> {
  return createHash("sha256")
    .update(await fs.realpath(vaultRoot), "utf8")
    .digest("hex");
}

async function makeWritable(candidate: string): Promise<void> {
  const stat = await fs.lstat(candidate).catch(() => null);
  if (!stat || stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) {
    if (stat.isFile()) await fs.chmod(candidate, 0o600).catch(() => undefined);
    return;
  }
  await fs.chmod(candidate, 0o700).catch(() => undefined);
  const entries = await fs.readdir(candidate, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) {
      await makeWritable(path.join(candidate, entry.name));
    }
  }
}

afterEach(async () => {
  await Promise.all(
    scratchDirectories.splice(0).map(async (directory) => {
      await makeWritable(directory);
      await fs.rm(directory, { recursive: true, force: true });
    }),
  );
});

function inspectionProfile() {
  const profile = reviewedAuthorityProfiles().find(
    ({ packageIdentity }) => packageIdentity.pluginId === "inspection-safe",
  );
  if (!profile) throw new Error("Inspection-safe reviewed profile is missing.");
  return profile;
}

interface AuthorityHarness {
  root: string;
  vaultId: string;
  vaultRoot: string;
  stateRoot: string;
  pluginDirectory: string;
  store: PluginConstructionAuthorityStore;
  session: Awaited<ReturnType<PluginConstructionAuthorityStore["activateVault"]>>;
  request: PluginConstructionRequest;
}

async function createHarness(): Promise<AuthorityHarness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-authority-store-"));
  scratchDirectories.push(root);
  const vaultRoot = path.join(root, "vault");
  const stateRoot = path.join(root, "private-authority");
  const pluginDirectory = path.join(vaultRoot, ".obsidian", "plugins", "inspection-safe");
  await fs.mkdir(path.dirname(pluginDirectory), { recursive: true });
  await fs.cp(fixtureRoot, pluginDirectory, { recursive: true });
  const vaultId = await vaultIdFor(vaultRoot);
  const store = new PluginConstructionAuthorityStore(stateRoot, {
    now: () => new Date("2026-08-16T12:00:00.000Z"),
    platform: "linux",
  });
  await store.initialize();
  const session = await store.activateVault(vaultId, vaultRoot, false);
  const request = await session.prepareConstructionRequest({
    pluginDirectory,
    reportedMainSha256: inspectionProfile().packageIdentity.mainSha256,
    constructionPath: "first-load",
  });
  return { root, vaultId, vaultRoot, stateRoot, pluginDirectory, store, session, request };
}

function resolverFor(session: AuthorityHarness["session"]): PluginConstructionPolicyResolver {
  let attempt = 0;
  return new PluginConstructionPolicyResolver({
    readAuthoritySnapshot: (request) => session.readAuthoritySnapshot(request),
    createAttemptId: () => `authority-store-attempt-${++attempt}`,
    now: () => new Date("2026-08-16T12:00:01.000Z"),
  });
}

describe("PluginConstructionAuthorityStore", () => {
  it("seals, grants, and dispatches one exact reviewed package outside the vault", async () => {
    const harness = await createHarness();
    const profile = inspectionProfile();
    expect(harness.request).toMatchObject({
      packageIdentity: profile.packageIdentity,
      packageIdentityDigest: profile.packageIdentityDigest,
    });

    const beforeGrant = await harness.session.readAuthoritySnapshot(harness.request);
    expect(beforeGrant.grant).toBeNull();
    expect(beforeGrant.sealedPackage).not.toBeNull();
    expect(beforeGrant.sealedPackage?.sealedPackageRootPath.startsWith(harness.vaultRoot)).toBe(
      false,
    );
    expect(
      (await resolverFor(harness.session).resolveConstructionPolicy(harness.request)).denialCode,
    ).toBe("grant-required");

    const grant = await harness.session.issueGrant(harness.request);
    expect(grant).toMatchObject({
      grantRevision: 1,
      packageIdentityDigest: profile.packageIdentityDigest,
      revokedAt: null,
    });
    await expect(harness.session.grantState(harness.request, "granted")).resolves.toBe("granted");

    const dispatch = await resolverFor(harness.session).resolveAndConsume(harness.request);
    expect(dispatch.policy).toMatchObject({
      decision: "allow",
      denialCode: null,
      packageIdentityDigest: profile.packageIdentityDigest,
    });
    expect(dispatch.pluginDirectory).toBe(
      (await harness.session.readAuthoritySnapshot(harness.request)).sealedPackage
        ?.sealedPackageRootPath,
    );
    expect(dispatch.pluginDirectory.startsWith(harness.vaultRoot)).toBe(false);
    expect((await fs.stat(dispatch.pluginDirectory)).mode & 0o222).toBe(0);
    expect((await fs.stat(path.join(dispatch.pluginDirectory, "main.js"))).mode & 0o222).toBe(0);
  });

  it("keeps mutable plugin data and Threadleaf metadata out of executable identity", async () => {
    const harness = await createHarness();
    await harness.session.issueGrant(harness.request);
    await fs.writeFile(path.join(harness.pluginDirectory, "data.json"), '{"setting":true}\n');
    await fs.writeFile(
      path.join(harness.pluginDirectory, ".data.json.00c98356-991b-442b-b05d-429d3d275e87.tmp"),
      '{"setting":"pending"}\n',
    );
    await fs.writeFile(
      path.join(harness.pluginDirectory, ".threadleaf-package.json"),
      '{"private":true}\n',
    );
    await fs.writeFile(
      path.join(harness.pluginDirectory, "LICENSE.threadleaf.txt"),
      "retained package metadata\n",
    );

    const repeated = await harness.session.prepareConstructionRequest({
      pluginDirectory: harness.pluginDirectory,
      reportedMainSha256: inspectionProfile().packageIdentity.mainSha256,
      constructionPath: "explicit-reload",
    });
    expect(repeated.packageIdentityDigest).toBe(harness.request.packageIdentityDigest);
    await expect(harness.session.grantState(repeated, "granted")).resolves.toBe("granted");
  });

  it("invalidates authority when a local dependency changes without changing main.js", async () => {
    const harness = await createHarness();
    await harness.session.issueGrant(harness.request);
    await fs.mkdir(path.join(harness.pluginDirectory, "lib"));
    await fs.writeFile(
      path.join(harness.pluginDirectory, "lib", "runtime.js"),
      "module.exports = 'changed closure';\n",
    );

    const changed = await harness.session.prepareConstructionRequest({
      pluginDirectory: harness.pluginDirectory,
      reportedMainSha256: inspectionProfile().packageIdentity.mainSha256,
      constructionPath: "automatic-recovery",
    });
    expect(changed.packageIdentity.mainSha256).toBe(harness.request.packageIdentity.mainSha256);
    expect(changed.packageIdentityDigest).not.toBe(harness.request.packageIdentityDigest);
    await expect(harness.session.grantState(changed, "granted")).resolves.toBe("unavailable");
    expect((await resolverFor(harness.session).resolveConstructionPolicy(changed)).denialCode).toBe(
      "authority-profile-missing",
    );
  });

  it("retains append-only revocation across restart and permits only a new exact grant", async () => {
    const harness = await createHarness();
    const issued = await harness.session.issueGrant(harness.request);
    const revoked = await harness.session.revokePlugin("inspection-safe", "review withdrawn");
    expect(revoked).toMatchObject({
      grantId: issued.grantId,
      grantRevision: 2,
      revokedAt: "2026-08-16T12:00:00.000Z",
      revocationReason: "review withdrawn",
    });
    expect(
      (await resolverFor(harness.session).resolveConstructionPolicy(harness.request)).denialCode,
    ).toBe("grant-revoked");

    const restartedStore = new PluginConstructionAuthorityStore(harness.stateRoot, {
      now: () => new Date("2026-08-16T12:05:00.000Z"),
      platform: "linux",
    });
    await restartedStore.initialize();
    const restarted = await restartedStore.activateVault(harness.vaultId, harness.vaultRoot, false);
    const restartedRequest = await restarted.prepareConstructionRequest({
      pluginDirectory: harness.pluginDirectory,
      reportedMainSha256: inspectionProfile().packageIdentity.mainSha256,
      constructionPath: "app-restart-reconstruction",
    });
    expect(
      (await resolverFor(restarted).resolveConstructionPolicy(restartedRequest)).denialCode,
    ).toBe("grant-revoked");

    const replacement = await restarted.issueGrant(restartedRequest);
    expect(replacement.grantId).not.toBe(issued.grantId);
    expect(replacement).toMatchObject({ grantRevision: 1, revokedAt: null });
    await expect(resolverFor(restarted).resolveAndConsume(restartedRequest)).resolves.toMatchObject(
      {
        policy: { decision: "allow" },
      },
    );

    const state = JSON.parse(
      await fs.readFile(
        path.join(harness.stateRoot, "vaults", harness.vaultId, "authority.json"),
        "utf8",
      ),
    ) as { grants: Array<{ grantId: string; grantRevision: number }> };
    expect(state.grants.map(({ grantId, grantRevision }) => ({ grantId, grantRevision }))).toEqual([
      { grantId: issued.grantId, grantRevision: 1 },
      { grantId: issued.grantId, grantRevision: 2 },
      { grantId: replacement.grantId, grantRevision: 1 },
    ]);
  });

  it("invalidates an outstanding allow policy when safe mode changes", async () => {
    const harness = await createHarness();
    await harness.session.issueGrant(harness.request);
    const resolver = resolverFor(harness.session);
    const allowed = await resolver.resolveConstructionPolicy(harness.request);
    expect(allowed.decision).toBe("allow");

    await harness.session.setSafeMode(true);
    await expect(resolver.consumeConstructionPolicy(allowed)).rejects.toMatchObject({
      code: "policy-epoch-stale",
    });
    expect((await resolver.resolveConstructionPolicy(harness.request)).denialCode).toBe(
      "safe-mode-blocked",
    );

    await harness.session.setSafeMode(false);
    await expect(resolver.resolveAndConsume(harness.request)).resolves.toMatchObject({
      policy: { decision: "allow" },
    });
  });

  it("fails closed when sealed package bytes or the immutable pointer are tampered", async () => {
    const harness = await createHarness();
    await harness.session.issueGrant(harness.request);
    const sealed = (await harness.session.readAuthoritySnapshot(harness.request)).sealedPackage;
    if (!sealed) throw new Error("Expected a sealed package.");

    const mainPath = path.join(sealed.sealedPackageRootPath, "main.js");
    await fs.chmod(mainPath, 0o600);
    await fs.appendFile(mainPath, "\n// tampered\n");
    expect(
      (await resolverFor(harness.session).resolveConstructionPolicy(harness.request)).denialCode,
    ).toBe("package-stage-invalid");
    await expect(harness.session.issueGrant(harness.request)).rejects.toThrow(
      /content address|mutable|differs/u,
    );

    await fs.writeFile(mainPath, await fs.readFile(path.join(fixtureRoot, "main.js")));
    await fs.chmod(mainPath, 0o400);
    const pointerPath = path.join(
      harness.stateRoot,
      "packages",
      harness.request.packageIdentityDigest,
      `${harness.request.packageIdentity.packageTreeSha256}.json`,
    );
    await fs.chmod(pointerPath, 0o600);
    expect(
      (await resolverFor(harness.session).resolveConstructionPolicy(harness.request)).denialCode,
    ).toBe("package-stage-invalid");
  });

  it("rejects authority state inside or around the vault and rejects cross-vault sources", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-authority-boundary-"));
    scratchDirectories.push(root);
    const vaultRoot = path.join(root, "vault");
    const pluginsRoot = path.join(vaultRoot, ".obsidian", "plugins");
    await fs.mkdir(pluginsRoot, { recursive: true });

    const insideStore = new PluginConstructionAuthorityStore(
      path.join(vaultRoot, ".threadleaf-authority"),
      { platform: "linux" },
    );
    await insideStore.initialize();
    await expect(
      insideStore.activateVault(await vaultIdFor(vaultRoot), vaultRoot, false),
    ).rejects.toThrow("outside the vault");

    const containingStateRoot = path.join(root, "containing-authority");
    const containedVault = path.join(containingStateRoot, "nested-vault");
    await fs.mkdir(containedVault, { recursive: true });
    const containingStore = new PluginConstructionAuthorityStore(containingStateRoot, {
      platform: "linux",
    });
    await containingStore.initialize();
    await expect(
      containingStore.activateVault(await vaultIdFor(containedVault), containedVault, false),
    ).rejects.toThrow("outside the vault");

    const outsidePlugin = path.join(root, "outside-plugin");
    await fs.cp(fixtureRoot, outsidePlugin, { recursive: true });
    const ordinaryStore = new PluginConstructionAuthorityStore(path.join(root, "private"), {
      platform: "linux",
    });
    await ordinaryStore.initialize();
    const session = await ordinaryStore.activateVault(
      await vaultIdFor(vaultRoot),
      vaultRoot,
      false,
    );
    await expect(
      session.prepareConstructionRequest({
        pluginDirectory: outsidePlugin,
        reportedMainSha256: inspectionProfile().packageIdentity.mainSha256,
        constructionPath: "test-execution",
      }),
    ).rejects.toThrow("escaped the active vault plugin directory");
  });

  it("rejects reordered or truncated-looking grant history on restart", async () => {
    const harness = await createHarness();
    await harness.session.issueGrant(harness.request);
    await harness.session.revokePlugin("inspection-safe", "review withdrawn");
    const statePath = path.join(harness.stateRoot, "vaults", harness.vaultId, "authority.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      grants: unknown[];
    };
    state.grants.reverse();
    await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

    const restarted = new PluginConstructionAuthorityStore(harness.stateRoot, {
      platform: "linux",
    });
    await restarted.initialize();
    await expect(
      restarted.activateVault(harness.vaultId, harness.vaultRoot, false),
    ).rejects.toThrow(/append-only/u);
  });

  it("invalidates stale sessions when the same vault is activated again", async () => {
    const harness = await createHarness();
    const replacement = await harness.store.activateVault(
      harness.vaultId,
      harness.vaultRoot,
      false,
    );
    await expect(harness.session.readAuthoritySnapshot(harness.request)).rejects.toThrow(
      "session is stale",
    );
    await expect(replacement.readAuthoritySnapshot(harness.request)).resolves.toMatchObject({
      vaultGeneration: 2,
    });
  });
});
