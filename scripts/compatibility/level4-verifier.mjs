import { createPublicKey, verify as verifySignature } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { authorityJsonSha256 } from "../../src/shared/authority-json-runtime.mjs";
import {
  canonicalizeLevel4Json,
  level4JsonSha256,
  level4ReceiptSigningPreimage,
  parseLevel4Json,
  parseLevel4ReceiptEnvelopeV2,
  parseLevel4ReplayEntryV1,
  parseLevel4TrustedControllerManifestV1,
  parseLevel4TrustPolicyV1,
  parseLevel4WorkflowDefinitionV2,
  verifyLevel4ReceiptSignature,
} from "../../src/shared/level4-receipt-boundary.mjs";
import {
  buildFileArtifact,
  buildPluginPackageIdentity,
  buildTreeManifest,
  canonicalJsonFileSha256,
  diffTreeManifests,
  effectiveBuildIdentityDigest,
  readJsonFile,
  sha256Bytes,
} from "./level4-artifacts.mjs";

function fail(message) {
  throw new Error(`Level 4 verifier: ${message}`);
}

function ensureObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object.`);
  return value;
}

function equalJson(left, right, label) {
  if (level4JsonSha256(left) !== level4JsonSha256(right))
    fail(`${label} is stale or does not match current state.`);
}

function reviewedAuthorityPayload(profile) {
  return {
    schemaVersion: profile.schemaVersion,
    profileId: profile.profileId,
    profileRevision: profile.profileRevision,
    packageIdentity: profile.packageIdentity,
    packageIdentityDigest: profile.packageIdentityDigest,
    expectedStaticCapabilities: profile.expectedStaticCapabilities,
    requiredAuthorities: profile.requiredAuthorities,
    executionProfile: profile.executionProfile,
    allowedPlatforms: profile.allowedPlatforms,
  };
}

function activeIssuer(policy, payload) {
  const active = policy.issuerKeys.filter((key) => key.status === "active");
  if (active.length !== 1) fail("current trust policy must contain exactly one active issuer key.");
  const issuer = active[0];
  if (payload.issuerKeyIdentitySha256 !== issuer.keyIdentitySha256)
    fail("receipt issuer key identity is not the current active key.");
  if (payload.issuerKeyId !== issuer.keyId)
    fail("receipt issuer key ID is not the current active policy row.");
  const publicKeyBytes = Buffer.from(issuer.publicKeyBase64, "base64");
  let publicKey;
  try {
    publicKey = createPublicKey({ key: publicKeyBytes, type: "spki", format: "der" });
  } catch (error) {
    fail(
      `current issuer public key is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { issuer, publicKey };
}

async function loadCurrentTrust({ artifactPaths }) {
  const policy = parseLevel4TrustPolicyV1(
    await readJsonFile(artifactPaths.trustPolicyPath, "current trust policy"),
  );
  const manifest = parseLevel4TrustedControllerManifestV1(
    await readJsonFile(
      artifactPaths.trustedControllerManifestPath,
      "current trusted controller manifest",
    ),
  );
  equalJson(
    policy.trustedControllerManifest,
    manifest,
    "trust policy/controller manifest identity",
  );
  const controller = await buildFileArtifact(artifactPaths.controllerExecutablePath, {
    label: "current controller executable",
  });
  const harness = await buildTreeManifest(artifactPaths.harnessTreePath, {
    label: "current evidence harness",
  });
  if (controller.sha256 !== manifest.controllerExecutableSha256)
    fail("current controller executable is not the trusted executable.");
  if (harness.treeSha256 !== manifest.currentHarness.treeSha256)
    fail("current evidence harness is not the trusted harness.");
  const trustStoreIdentitySha256 = level4JsonSha256(policy);
  return {
    policy,
    manifest,
    controllerExecutableSha256: controller.sha256,
    harnessTreeSha256: harness.treeSha256,
    trustedControllerManifestSha256: level4JsonSha256(manifest),
    trustStoreIdentitySha256,
  };
}

async function assertAuthorityProfile(profilePath, packageIdentity, packageIdentityDigest) {
  const profile = ensureObject(
    await readJsonFile(profilePath, "current authority profile"),
    "current authority profile",
  );
  if (
    profile.schemaVersion !== 1 ||
    typeof profile.profileId !== "string" ||
    typeof profile.profileRevision !== "number"
  )
    fail("current authority profile is not a supported profile.");
  equalJson(profile.packageIdentity, packageIdentity, "authority profile package identity");
  if (profile.packageIdentityDigest !== packageIdentityDigest)
    fail("authority profile package identity digest is stale.");
  const authorityDigest = authorityJsonSha256(reviewedAuthorityPayload(profile));
  if (profile.authorityDigest !== authorityDigest)
    fail("authority profile authority digest is stale.");
  return { profileId: profile.profileId, authorityDigest };
}

function assertRequiredAssertions(payload, workflow) {
  const assertions = new Map(payload.assertions.map((item) => [item.id, item]));
  const postReload = new Map(payload.postReloadAssertions.map((item) => [item.id, item]));
  for (const id of workflow.requiredAssertionIds) {
    const assertion = assertions.get(id);
    if (assertion?.required !== true || assertion?.passed !== true)
      fail(`required assertion ${id} is missing or failed.`);
  }
  for (const id of workflow.requiredPostReloadAssertionIds) {
    const assertion = postReload.get(id);
    if (assertion?.required !== true || assertion?.passed !== true)
      fail(`required post-reload assertion ${id} is missing or failed.`);
  }
  const deliveries = new Map(payload.deliveryAssertions.map((item) => [item.id, item]));
  for (const id of workflow.requiredDeliveryIds) {
    const delivery = deliveries.get(id);
    if (delivery?.required !== true || delivery?.available !== true)
      fail(`required delivery ${id} is missing or unavailable.`);
  }
}

function assertVaultChanges(payload, before, after) {
  const actual = diffTreeManifests(before, after);
  const declared = [...payload.allowlistedVaultChanges].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  if (actual.length !== declared.length)
    fail("vault change allowlist does not cover the exact current diff.");
  for (let index = 0; index < actual.length; index += 1) {
    if (level4JsonSha256(actual[index]) !== level4JsonSha256(declared[index]))
      fail(`vault change allowlist differs at ${actual[index].path}.`);
  }
}

async function assertScreenshots(payload, artifactPaths) {
  const expected = artifactPaths.screenshots ?? [];
  if (payload.screenshots.length !== expected.length)
    fail("receipt screenshot count differs from the current workflow inputs.");
  for (let index = 0; index < expected.length; index += 1) {
    const declared = payload.screenshots[index];
    const current = expected[index];
    if (
      path.resolve(declared.path) !== path.resolve(current.path) ||
      declared.purpose !== current.purpose
    )
      fail("receipt screenshot identity differs from current workflow inputs.");
    const artifact = await buildFileArtifact(current.path, {
      label: `current screenshot ${index}`,
    });
    if (declared.sha256 !== artifact.sha256)
      fail(`receipt screenshot digest differs from current screenshot ${index}.`);
  }
}

async function readReplayEntries(replayIndexPath) {
  let text;
  try {
    text = await fs.readFile(replayIndexPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    fail(
      `replay index could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const lines = text.split("\n").filter((line) => line.length > 0);
  return lines.map((line, index) => {
    let parsed;
    try {
      parsed = parseLevel4Json(line, { requireCanonical: true });
    } catch (error) {
      fail(
        `replay index line ${index + 1} is not canonical: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return parseLevel4ReplayEntryV1(parsed);
  });
}

async function withReplayLock(replayIndexPath, callback) {
  await fs.mkdir(path.dirname(replayIndexPath), { recursive: true, mode: 0o700 });
  const lockPath = `${replayIndexPath}.lock`;
  let lockHandle;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      lockHandle = await fs.open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (!lockHandle) fail("replay index lock is held or stale; refusing to guess.");
  try {
    return await callback();
  } finally {
    await lockHandle.close();
    await fs.unlink(lockPath).catch(() => {});
  }
}

async function updateReplayIndex(replayIndexPath, entry) {
  return withReplayLock(replayIndexPath, async () => {
    const entries = await readReplayEntries(replayIndexPath);
    const same = entries.find(
      (item) =>
        item.receiptFileSha256 === entry.receiptFileSha256 &&
        item.tupleDigest === entry.tupleDigest,
    );
    if (same) return "idempotent";
    const nonceCollision = entries.find(
      (item) => item.runNonce === entry.runNonce || item.runId === entry.runId,
    );
    if (nonceCollision) fail("run nonce or run ID was replayed for a different receipt or tuple.");
    const bytes = Buffer.from(canonicalizeLevel4Json(entry));
    let handle;
    try {
      handle = await fs.open(replayIndexPath, "a", 0o600);
      await handle.writeFile(Buffer.concat([bytes, Buffer.from("\n", "utf8")]));
      await handle.sync();
    } finally {
      await handle?.close();
    }
    return "inserted";
  });
}

async function assertCurrentArtifacts({ payload, workflow, artifactPaths, expected, trust }) {
  const packageData = await buildPluginPackageIdentity(artifactPaths.packagePath, {
    distributionTag: artifactPaths.distributionTag,
  });
  equalJson(payload.packageIdentity, packageData.packageIdentity, "receipt package identity");
  if (payload.packageIdentityDigest !== packageData.packageIdentityDigest)
    fail("receipt package identity digest differs from current package.");
  const sealed = await buildTreeManifest(artifactPaths.sealedPackageRootPath, {
    label: "sealed-plugin-package",
  });
  if (
    sealed.treeSha256 !== packageData.packageIdentity.packageTreeSha256 ||
    payload.stagedPackageTreeSha256 !== sealed.treeSha256
  )
    fail("sealed package tree differs from current staged package.");
  const fixture = await buildTreeManifest(artifactPaths.fixtureTreePath, {
    label: "workflow-fixture",
  });
  const packaged = await buildFileArtifact(artifactPaths.packagedArtifactPath, {
    label: "packaged application artifact",
  });
  const installed = await buildTreeManifest(artifactPaths.installedApplicationTreePath, {
    label: "installed application",
  });
  const buildManifest = await canonicalJsonFileSha256(
    artifactPaths.canonicalBuildManifestPath,
    "canonical build manifest",
  );
  const dist = await buildTreeManifest(artifactPaths.relevantDistTreePath, {
    label: "relevant dist",
  });
  const electron = await buildFileArtifact(artifactPaths.electronExecutablePath, {
    label: "Electron executable",
  });
  const preconditions = await buildFileArtifact(artifactPaths.preconditionsPath, {
    label: "preconditions",
  });
  const startingFixture = await buildFileArtifact(artifactPaths.startingFixturePath, {
    label: "starting fixture",
  });
  const before = await buildTreeManifest(artifactPaths.vaultTreeBeforePath, {
    label: "vault before",
  });
  const after = await buildTreeManifest(artifactPaths.vaultTreeAfterPath, { label: "vault after" });
  const authority = await assertAuthorityProfile(
    artifactPaths.authorityProfilePath,
    packageData.packageIdentity,
    packageData.packageIdentityDigest,
  );
  if (payload.workflowDefinitionSha256 !== level4JsonSha256(workflow))
    fail("workflow definition hash differs from current workflow.");
  if (payload.fixtureTreeSha256 !== fixture.treeSha256)
    fail("fixture tree differs from current fixture.");
  if (payload.packagedApplicationArtifactSha256 !== packaged.sha256)
    fail("packaged application artifact differs from current artifact.");
  if (payload.installedApplicationTreeSha256 !== installed.treeSha256)
    fail("installed application tree differs from current tree.");
  if (payload.canonicalBuildManifestSha256 !== buildManifest)
    fail("canonical build manifest differs from current manifest.");
  if (payload.relevantDistTreeSha256 !== dist.treeSha256)
    fail("relevant dist tree differs from current dist.");
  if (payload.electronExecutableSha256 !== electron.sha256)
    fail("Electron executable differs from current executable.");
  if (payload.preconditionsSha256 !== preconditions.sha256)
    fail("preconditions differ from current inputs.");
  if (payload.startingFixtureSha256 !== startingFixture.sha256)
    fail("starting fixture differs from current inputs.");
  if (
    payload.vaultTreeBeforeSha256 !== before.treeSha256 ||
    payload.vaultTreeAfterSha256 !== after.treeSha256
  )
    fail("vault tree differs from current state.");
  if (
    payload.authorityProfileId !== authority.profileId ||
    payload.authorityDigest !== authority.authorityDigest
  )
    fail("authority identity differs from current profile.");
  const effective = effectiveBuildIdentityDigest({
    packageIdentityDigest: packageData.packageIdentityDigest,
    stagedPackageTreeSha256: sealed.treeSha256,
    packagedApplicationArtifactSha256: packaged.sha256,
    installedApplicationTreeSha256: installed.treeSha256,
    canonicalBuildManifestSha256: buildManifest,
    relevantDistTreeSha256: dist.treeSha256,
    electronExecutableSha256: electron.sha256,
  });
  if (payload.effectiveBuildIdentityDigest !== effective.digest)
    fail("effective build identity differs from current artifacts.");
  assertVaultChanges(payload, before, after);
  await assertScreenshots(payload, artifactPaths);
  for (const requiredPath of artifactPaths.requiredDistPaths ?? []) {
    if (!dist.entries.some((entry) => entry.kind === "file" && entry.path === requiredPath))
      fail(`relevant dist omits required registry code ${requiredPath}.`);
  }
  if (
    payload.workflowId !== workflow.workflowId ||
    payload.fixtureVersion !== workflow.fixtureVersion
  )
    fail("receipt workflow identity differs from current workflow.");
  if (payload.packageIdentity.pluginId !== workflow.pluginId)
    fail("workflow plugin identity differs from the exact package.");
  if (workflow.packageIdentityDigest !== payload.packageIdentityDigest)
    fail("workflow package identity digest differs from the exact package.");
  if (payload.cancelControl.stepId !== workflow.cancellationStepId)
    fail("receipt cancellation control is not bound to the current workflow.");
  if (workflow.platform !== expected.platform || workflow.architecture !== expected.architecture)
    fail("verifier platform or architecture inputs disagree with the current workflow.");
  if (payload.platform !== expected.platform || payload.architecture !== expected.architecture)
    fail("receipt platform or architecture differs from current workflow.");
  if (payload.sourceCommit !== expected.sourceCommit) fail("receipt source commit is stale.");
  if (payload.threadleafVersion !== expected.threadleafVersion)
    fail("receipt Threadleaf version is stale.");
  if (payload.electronVersion !== expected.electronVersion)
    fail("receipt Electron version is stale.");
  assertRequiredAssertions(payload, workflow);
  if (payload.rendererIdentityBeforeReload === payload.rendererIdentityAfterReload)
    fail("post-reload renderer identity is not distinct.");
  return { fixture, packaged, installed, buildManifest, dist, electron, before, after, trust };
}

export async function verifyLevel4Receipt({ receiptPath, artifactPaths, expected }) {
  let receiptBytes;
  try {
    receiptBytes = await fs.readFile(receiptPath);
  } catch (error) {
    fail(`receipt could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsedWire = parseLevel4Json(receiptBytes, { requireCanonical: true });
  const envelope = parseLevel4ReceiptEnvelopeV2(parsedWire);
  const trust = await loadCurrentTrust({ artifactPaths });
  const issuer = activeIssuer(trust.policy, envelope.payload);
  if (envelope.payload.issuerTrustStoreIdentitySha256 !== trust.trustStoreIdentitySha256)
    fail("receipt trust-store identity is stale.");
  if (envelope.payload.trustedControllerManifestSha256 !== trust.trustedControllerManifestSha256)
    fail("receipt trusted-controller manifest is stale.");
  if (envelope.payload.controllerExecutableSha256 !== trust.controllerExecutableSha256)
    fail("receipt controller executable identity is stale.");
  if (envelope.payload.evidenceHarnessTreeSha256 !== trust.harnessTreeSha256)
    fail("receipt harness identity is stale.");
  if (envelope.payload.evidenceHarnessVersion !== trust.manifest.currentHarness.version)
    fail("receipt harness version is stale.");
  if (envelope.payload.controllerVersion !== trust.manifest.controllerVersion)
    fail("receipt controller version is stale.");
  if (envelope.payload.trustedControllerManifestId !== trust.manifest.manifestId)
    fail("receipt trusted-controller manifest ID is stale.");
  if (envelope.payload.issuerTrustStoreVersion !== trust.policy.trustStoreVersion)
    fail("receipt trust-store version is stale.");
  if (!verifyLevel4ReceiptSignature(envelope, issuer.publicKey))
    fail("receipt Ed25519 signature is invalid.");
  const workflow = parseLevel4WorkflowDefinitionV2(
    await readJsonFile(artifactPaths.workflowDefinitionPath, "current workflow definition"),
  );
  const current = await assertCurrentArtifacts({
    payload: envelope.payload,
    workflow,
    artifactPaths,
    expected,
    trust,
  });
  const tuple = {
    schemaVersion: 2,
    effectiveBuildIdentityDigest: envelope.payload.effectiveBuildIdentityDigest,
    packageIdentityDigest: envelope.payload.packageIdentityDigest,
    authorityDigest: envelope.payload.authorityDigest,
    workflowDefinitionSha256: envelope.payload.workflowDefinitionSha256,
    fixtureTreeSha256: envelope.payload.fixtureTreeSha256,
    platform: envelope.payload.platform,
    architecture: envelope.payload.architecture,
    controllerExecutableSha256: envelope.payload.controllerExecutableSha256,
    trustedControllerManifestSha256: envelope.payload.trustedControllerManifestSha256,
    evidenceHarnessVersion: envelope.payload.evidenceHarnessVersion,
    evidenceHarnessTreeSha256: envelope.payload.evidenceHarnessTreeSha256,
    issuerKeyIdentitySha256: envelope.payload.issuerKeyIdentitySha256,
    issuerTrustStoreVersion: envelope.payload.issuerTrustStoreVersion,
    issuerTrustStoreIdentitySha256: envelope.payload.issuerTrustStoreIdentitySha256,
  };
  const tupleDigest = level4JsonSha256(tuple);
  const receiptFileSha256 = sha256Bytes(receiptBytes);
  const replayEntry = {
    schemaVersion: 1,
    tupleDigest,
    runNonce: envelope.payload.runNonce,
    runId: envelope.payload.runId,
    receiptFileSha256,
  };
  const replay = await updateReplayIndex(artifactPaths.replayIndexPath, replayEntry);
  const rereadTrust = await loadCurrentTrust({ artifactPaths });
  if (
    rereadTrust.trustStoreIdentitySha256 !== trust.trustStoreIdentitySha256 ||
    rereadTrust.trustedControllerManifestSha256 !== trust.trustedControllerManifestSha256
  )
    fail("trust policy or controller identity changed during verification.");
  return {
    receipt: envelope,
    receiptFileSha256,
    verificationTuple: tuple,
    verificationTupleDigest: tupleDigest,
    replay,
    issuerTrustStoreIdentitySha256: trust.trustStoreIdentitySha256,
    current,
  };
}

export function verifyReceiptSignatureAgainstPublicKey(envelope, publicKey) {
  return verifySignature(
    null,
    level4ReceiptSigningPreimage(envelope),
    publicKey,
    Buffer.from(envelope.signature.valueBase64, "base64"),
  );
}
