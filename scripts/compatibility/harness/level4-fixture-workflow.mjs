import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { authorityJsonSha256 } from "../../../src/shared/authority-json-runtime.mjs";
import {
  canonicalizeLevel4Json,
  createLevel4ReceiptEnvelopeV2,
  parseLevel4ControllerAttemptRecordV2,
  verifyLevel4ControllerAttemptRecordSignature,
} from "../../../src/shared/level4-receipt-boundary.mjs";
import { generatePluginCompatibilityRegistry } from "../../generate-plugin-compatibility-registry.mjs";
import {
  buildPluginPackageIdentity,
  buildTreeManifest,
  diffTreeManifests,
  sha256Bytes,
} from "../level4-artifacts.mjs";
import { createLevel4ControllerRun, finalizeLevel4Receipt } from "../level4-controller.mjs";
import { verifyLevel4Receipt } from "../level4-verifier.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");

function check(condition, message) {
  assert.equal(condition, true, message);
}

async function writeFile(filePath, content, mode = 0o600) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, content);
  await fs.chmod(filePath, mode);
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function copyDirectory(source, destination) {
  await fs.cp(source, destination, { recursive: true, dereference: false });
  await fs.chmod(destination, 0o700);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function gitHead() {
  const result = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot });
  return result.stdout.trim();
}

function assertion(id, observedValue) {
  return {
    id,
    required: true,
    passed: true,
    observedValue,
    source: "fixture-controller-observation",
    evidenceSha256: sha256Bytes(Buffer.from(JSON.stringify(observedValue), "utf8")),
  };
}

async function makeFixture(root) {
  const packagePath = path.join(root, "plugin-package");
  const sealedPackageRootPath = path.join(root, "sealed-package");
  await fs.mkdir(packagePath, { recursive: true, mode: 0o700 });
  await writeJson(path.join(packagePath, "manifest.json"), {
    id: "threadleaf-level4-fixture-plugin",
    version: "1.0.0",
    name: "Threadleaf Level 4 Fixture",
    minAppVersion: "0.1.0",
  });
  await writeFile(
    path.join(packagePath, "main.js"),
    "module.exports = { onload() { return true; } };\n",
  );
  await writeFile(path.join(packagePath, "styles.css"), ".fixture { display: block; }\n");
  await fs.mkdir(path.join(packagePath, "lib"), { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(packagePath, "lib", "reachable.js"),
    "export const reachable = true;\n",
  );
  await copyDirectory(packagePath, sealedPackageRootPath);
  const packageData = await buildPluginPackageIdentity(packagePath, {
    distributionTag: "fixture-v1",
  });
  const packageIdentityDigest = packageData.packageIdentityDigest;
  const authorityProfile = {
    $schema: "./reviewed-authority-profile.v1.schema.json",
    schemaVersion: 1,
    profileId: "threadleaf-level4-fixture-profile",
    profileRevision: 1,
    packageIdentity: packageData.packageIdentity,
    packageIdentityDigest,
    expectedStaticCapabilities: ["editor-extension"],
    requiredAuthorities: ["editor-extension"],
    executionProfile: "trusted-node-renderer",
    allowedPlatforms: ["linux"],
  };
  authorityProfile.authorityDigest = authorityJsonSha256({
    schemaVersion: authorityProfile.schemaVersion,
    profileId: authorityProfile.profileId,
    profileRevision: authorityProfile.profileRevision,
    packageIdentity: authorityProfile.packageIdentity,
    packageIdentityDigest: authorityProfile.packageIdentityDigest,
    expectedStaticCapabilities: authorityProfile.expectedStaticCapabilities,
    requiredAuthorities: authorityProfile.requiredAuthorities,
    executionProfile: authorityProfile.executionProfile,
    allowedPlatforms: authorityProfile.allowedPlatforms,
  });
  const authorityProfilePath = path.join(root, "authority-profile.json");
  await writeJson(authorityProfilePath, authorityProfile);

  const workflowDefinition = {
    schemaVersion: 2,
    workflowId: "threadleaf.level4.fixture.workflow",
    version: "1.0.0",
    pluginId: packageData.packageIdentity.pluginId,
    packageIdentityDigest,
    platform: "linux-x64-electron",
    architecture: "x64",
    requiredAssertionIds: ["workflow.open", "workflow.save"],
    requiredPostReloadAssertionIds: ["workflow.reload"],
    requiredDeliveryIds: ["delivery.receipt"],
    cancellationStepId: "workflow.cancel",
    fixtureVersion: "fixture-v1",
  };
  const workflowDefinitionPath = path.join(root, "workflow.json");
  await writeJson(workflowDefinitionPath, workflowDefinition);
  const fixtureTreePath = path.join(root, "fixture-tree");
  await fs.mkdir(fixtureTreePath, { recursive: true, mode: 0o700 });
  await writeFile(path.join(fixtureTreePath, "fixture.json"), '{"fixture":"level4"}\n');
  await writeFile(path.join(fixtureTreePath, "expected.txt"), "completed\n");

  const installedApplicationTreePath = path.join(root, "installed-app");
  await fs.mkdir(installedApplicationTreePath, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(installedApplicationTreePath, "resources.asar"),
    "fixture-installed-application\n",
  );
  const relevantDistTreePath = path.join(root, "relevant-dist");
  await fs.mkdir(path.join(relevantDistTreePath, "assets"), { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(relevantDistTreePath, "assets", "index.js"),
    "export const app = true;\n",
  );
  await writeFile(
    path.join(relevantDistTreePath, "compatibility-registry.js"),
    "export const registry = true;\n",
  );
  const packagedArtifactPath = path.join(root, "Threadleaf-fixture.tar.xz");
  await writeFile(packagedArtifactPath, "fixture-packaged-artifact\n");
  const canonicalBuildManifestPath = path.join(root, "build-manifest.json");
  await writeJson(canonicalBuildManifestPath, {
    schemaVersion: 1,
    applicationId: "org.threadleaf.Threadleaf",
    version: "fixture-build",
    platform: "linux",
    architecture: "x64",
    source: "fixture",
  });
  const electronExecutablePath = path.join(root, "electron");
  await writeFile(electronExecutablePath, "#!/bin/sh\nexit 0\n", 0o700);
  const preconditionsPath = path.join(root, "preconditions.json");
  await writeJson(preconditionsPath, { schemaVersion: 1, policy: "fixture-preconditions" });
  const startingFixturePath = path.join(root, "starting-fixture.json");
  await writeJson(startingFixturePath, { schemaVersion: 1, state: "initial" });
  const vaultTreeBeforePath = path.join(root, "vault-before");
  const vaultTreeAfterPath = path.join(root, "vault-after");
  await fs.mkdir(vaultTreeBeforePath, { recursive: true, mode: 0o700 });
  await fs.mkdir(vaultTreeAfterPath, { recursive: true, mode: 0o700 });
  await writeFile(path.join(vaultTreeBeforePath, "note.md"), "before\n");
  await writeFile(path.join(vaultTreeAfterPath, "note.md"), "after\n");
  const beforeTree = await buildTreeManifest(vaultTreeBeforePath, { label: "vault before" });
  const afterTree = await buildTreeManifest(vaultTreeAfterPath, { label: "vault after" });
  const vaultDiff = diffTreeManifests(beforeTree, afterTree);

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPath = path.join(root, "fixture-private-key.pem");
  await writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), 0o600);
  const publicKeyBytes = publicKey.export({ type: "spki", format: "der" });
  const publicKeyBase64 = publicKeyBytes.toString("base64");
  const issuerKeyIdentitySha256 = sha256Bytes(publicKeyBytes);
  const trustedManifest = JSON.parse(
    await fs.readFile(
      path.join(
        repositoryRoot,
        "scripts",
        "compatibility",
        "trust",
        "trusted-controller-manifest.v1.json",
      ),
      "utf8",
    ),
  );
  const trustPolicyPath = path.join(root, "trust-policy.json");
  await writeJson(trustPolicyPath, {
    schemaVersion: 1,
    trustStoreVersion: 1,
    trustedControllerManifest: trustedManifest,
    issuerKeys: [
      {
        keyId: "fixture-ephemeral-key",
        publicKeyBase64,
        keyIdentitySha256: issuerKeyIdentitySha256,
        status: "active",
      },
    ],
  });
  const trustedControllerManifestPath = path.join(root, "trusted-controller-manifest.json");
  await writeJson(trustedControllerManifestPath, trustedManifest);
  const replayIndexPath = path.join(root, "replay-index.ndjson");
  const receiptDirectory = path.join(root, "receipt-store");
  const attemptDirectory = path.join(root, "attempt-store");
  const artifactPaths = {
    replayIndexPath,
    trustPolicyPath,
    trustedControllerManifestPath,
    controllerExecutablePath: path.join(
      repositoryRoot,
      "scripts",
      "compatibility",
      "level4-controller.mjs",
    ),
    harnessTreePath: path.join(repositoryRoot, "scripts", "compatibility", "harness"),
    workflowDefinitionPath,
    fixtureTreePath,
    packagePath,
    sealedPackageRootPath,
    packagedArtifactPath,
    installedApplicationTreePath,
    canonicalBuildManifestPath,
    relevantDistTreePath,
    requiredDistPaths: ["compatibility-registry.js"],
    electronExecutablePath,
    authorityProfilePath,
    preconditionsPath,
    startingFixturePath,
    vaultTreeBeforePath,
    vaultTreeAfterPath,
    distributionTag: "fixture-v1",
    screenshots: [],
  };
  return {
    packageData,
    packagePath,
    sealedPackageRootPath,
    workflowDefinition,
    workflowDefinitionPath,
    artifactPaths,
    receiptDirectory,
    attemptDirectory,
    privateKeyPath,
    publicKey,
    issuerKeyIdentitySha256,
    vaultDiff,
    sourceCommit: await gitHead(),
  };
}

function successfulResult(fixture) {
  return {
    processOutcome: "completed",
    constructionPolicyEpochs: [
      {
        checkpoint: "fixture",
        policyEpoch: 1,
        grantEpoch: 1,
        grantRevision: 1,
        safeModeEpoch: 1,
        packageStoreEpoch: 1,
        authorityProfileRevision: 1,
      },
    ],
    threadleafVersion: "0.1.0-beta.7",
    sourceCommit: fixture.sourceCommit,
    electronVersion: "fixture-electron-1",
    assertions: [
      assertion("workflow.open", { state: "open" }),
      assertion("workflow.save", { state: "saved" }),
    ],
    postReloadAssertions: [assertion("workflow.reload", { state: "reloaded" })],
    deliveryAssertions: [
      {
        id: "delivery.receipt",
        required: true,
        available: true,
        detail: "fixture receipt is available",
      },
    ],
    allowlistedVaultChanges: fixture.vaultDiff,
    privateStateNamespaces: ["fixture-private-state"],
    rendererIdentityBeforeReload: "renderer-before-1",
    rendererIdentityAfterReload: "renderer-after-2",
    cancelControl: {
      stepId: "workflow.cancel",
      result: "canceled",
      provesNoCompletion: true,
      evidenceSha256: sha256Bytes(Buffer.from("cancel-control", "utf8")),
    },
    errors: [],
  };
}

async function expectReject(action, label) {
  let rejected = false;
  try {
    await action();
  } catch {
    rejected = true;
  }
  check(rejected, `${label} must fail closed`);
}

async function main() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-level4-"));
  await fs.chmod(temporaryRoot, 0o700);
  try {
    const fixture = await makeFixture(temporaryRoot);
    const run = createLevel4ControllerRun({
      workflowId: fixture.workflowDefinition.workflowId,
      workflowDefinition: fixture.workflowDefinition,
    });
    run.observe({
      kind: "step",
      source: "fixture",
      value: { step: "open", success: true },
      observedAt: new Date().toISOString(),
    });
    run.observe({
      kind: "renderer",
      source: "fixture",
      value: { step: "reload", success: true },
      observedAt: new Date().toISOString(),
    });
    const result = successfulResult(fixture);
    check(
      run.deriveTerminalState(result) === "completed",
      "controller must derive completed from its assertions",
    );
    await expectReject(
      async () =>
        run.observe({
          kind: "step",
          source: "fixture",
          value: { terminalState: "completed" },
          observedAt: new Date().toISOString(),
        }),
      "runtime-authored terminal state",
    );
    const finalized = await finalizeLevel4Receipt({
      run,
      result,
      artifactPaths: fixture.artifactPaths,
      privateKey: fixture.privateKeyPath,
      receiptDirectory: fixture.receiptDirectory,
      attemptDirectory: fixture.attemptDirectory,
    });
    check(finalized.publishable === true, "controller must publish exactly one completed receipt");
    const verified = await verifyLevel4Receipt({
      receiptPath: finalized.receiptPath,
      artifactPaths: fixture.artifactPaths,
      expected: {
        platform: fixture.workflowDefinition.platform,
        architecture: fixture.workflowDefinition.architecture,
        sourceCommit: fixture.sourceCommit,
        threadleafVersion: "0.1.0-beta.7",
        electronVersion: "fixture-electron-1",
      },
    });
    const verifiedAgain = await verifyLevel4Receipt({
      receiptPath: finalized.receiptPath,
      artifactPaths: fixture.artifactPaths,
      expected: {
        platform: fixture.workflowDefinition.platform,
        architecture: fixture.workflowDefinition.architecture,
        sourceCommit: fixture.sourceCommit,
        threadleafVersion: "0.1.0-beta.7",
        electronVersion: "fixture-electron-1",
      },
    });
    check(verified.replay === "inserted", "first verification must append replay state");
    check(verifiedAgain.replay === "idempotent", "same receipt verification must be idempotent");
    const receiptBytes = await fs.readFile(finalized.receiptPath);
    check(
      Buffer.from(canonicalizeLevel4Json(finalized.envelope)).equals(receiptBytes),
      "receipt bytes must be canonical and exact",
    );
    check(
      (await fs.readdir(fixture.receiptDirectory)).length === 1,
      "receipt store must contain one final receipt",
    );
    const signingKey = createPrivateKey(await fs.readFile(fixture.privateKeyPath));
    const expectedCurrent = {
      platform: fixture.workflowDefinition.platform,
      architecture: fixture.workflowDefinition.architecture,
      sourceCommit: fixture.sourceCommit,
      threadleafVersion: "0.1.0-beta.7",
      electronVersion: "fixture-electron-1",
    };
    const verifyFixture = (
      artifactOverrides = {},
      expectedOverrides = {},
      receiptPath = finalized.receiptPath,
    ) =>
      verifyLevel4Receipt({
        receiptPath,
        artifactPaths: { ...fixture.artifactPaths, ...artifactOverrides },
        expected: { ...expectedCurrent, ...expectedOverrides },
      });
    const writeSignedVariant = async (name, mutatePayload, mutateIssuer = (issuer) => issuer) => {
      const payload = structuredClone(finalized.payload);
      mutatePayload(payload);
      const envelope = createLevel4ReceiptEnvelopeV2({
        payload,
        issuer: mutateIssuer({ ...finalized.envelope.issuer }),
        privateKey: signingKey,
      });
      const variantPath = path.join(temporaryRoot, name);
      await writeFile(variantPath, canonicalizeLevel4Json(envelope));
      return variantPath;
    };

    const alteredPath = path.join(temporaryRoot, "altered.receipt.json");
    const altered = JSON.parse(receiptBytes.toString("utf8"));
    altered.payload.threadleafVersion = "0.1.0-beta.6";
    await writeFile(alteredPath, canonicalizeLevel4Json(altered));
    await expectReject(
      () =>
        verifyLevel4Receipt({
          receiptPath: alteredPath,
          artifactPaths: fixture.artifactPaths,
          expected: {
            platform: fixture.workflowDefinition.platform,
            architecture: fixture.workflowDefinition.architecture,
            sourceCommit: fixture.sourceCommit,
            threadleafVersion: "0.1.0-beta.7",
            electronVersion: "fixture-electron-1",
          },
        }),
      "altered signed payload",
    );
    const wrongDomainPath = path.join(temporaryRoot, "wrong-domain.receipt.json");
    const unsignedEnvelope = {
      schemaVersion: 2,
      payload: finalized.envelope.payload,
      payloadSha256: finalized.envelope.payloadSha256,
      issuer: finalized.envelope.issuer,
    };
    const wrongDomainSignature = sign(
      null,
      Buffer.concat([
        Buffer.from("wrong-level4-domain\0", "utf8"),
        Buffer.from(canonicalizeLevel4Json(unsignedEnvelope)),
      ]),
      signingKey,
    ).toString("base64");
    await writeFile(
      wrongDomainPath,
      canonicalizeLevel4Json({
        ...finalized.envelope,
        signature: { algorithm: "Ed25519", valueBase64: wrongDomainSignature },
      }),
    );
    await expectReject(
      () => verifyFixture({}, {}, wrongDomainPath),
      "signature with the wrong domain-separated preimage",
    );
    const forgedIssuerPath = path.join(temporaryRoot, "forged-issuer.receipt.json");
    await writeFile(
      forgedIssuerPath,
      canonicalizeLevel4Json({
        ...finalized.envelope,
        issuer: {
          ...finalized.envelope.issuer,
          controllerExecutableSha256: "0".repeat(64),
        },
      }),
    );
    await expectReject(
      () => verifyFixture({}, {}, forgedIssuerPath),
      "forged duplicated issuer identity",
    );
    const untrustedKeyIdPath = await writeSignedVariant(
      "untrusted-key-id.receipt.json",
      (payload) => {
        payload.issuerKeyId = "untrusted-key-id";
      },
      (issuer) => ({ ...issuer, keyId: "untrusted-key-id" }),
    );
    await expectReject(() => verifyFixture({}, {}, untrustedKeyIdPath), "untrusted envelope keyId");
    await expectReject(
      () =>
        writeSignedVariant("fast-forward.receipt.json", (payload) => {
          payload.observations[0].sequence = 2;
        }),
      "fast-forwarded observation sequence",
    );
    await expectReject(
      () =>
        writeSignedVariant("same-renderer.receipt.json", (payload) => {
          payload.rendererIdentityAfterReload = payload.rendererIdentityBeforeReload;
        }),
      "unchanged post-reload renderer identity",
    );
    const sameRunDifferentPayloadPath = await writeSignedVariant(
      "same-run-different-payload.receipt.json",
      (payload) => {
        payload.assertions[0].observedValue = { state: "different" };
      },
    );
    await expectReject(
      () => verifyFixture({}, {}, sameRunDifferentPayloadPath),
      "nonce and run-ID reuse with a different payload",
    );
    const wrongPlatformPath = await writeSignedVariant("wrong-platform.receipt.json", (payload) => {
      payload.platform = "darwin-arm64-electron";
    });
    await expectReject(() => verifyFixture({}, {}, wrongPlatformPath), "wrong receipt platform");
    const wrongArchitecturePath = await writeSignedVariant(
      "wrong-architecture.receipt.json",
      (payload) => {
        payload.architecture = "arm64";
      },
    );
    await expectReject(
      () => verifyFixture({}, {}, wrongArchitecturePath),
      "wrong receipt architecture",
    );
    const malformedSignaturePath = path.join(temporaryRoot, "malformed-signature.receipt.json");
    const malformedSignature = JSON.parse(receiptBytes.toString("utf8"));
    malformedSignature.signature.valueBase64 = `A${malformedSignature.signature.valueBase64.slice(1)}`;
    await writeFile(malformedSignaturePath, canonicalizeLevel4Json(malformedSignature));
    await expectReject(
      () =>
        verifyLevel4Receipt({
          receiptPath: malformedSignaturePath,
          artifactPaths: fixture.artifactPaths,
          expected: {
            platform: fixture.workflowDefinition.platform,
            architecture: fixture.workflowDefinition.architecture,
            sourceCommit: fixture.sourceCommit,
            threadleafVersion: "0.1.0-beta.7",
            electronVersion: "fixture-electron-1",
          },
        }),
      "malformed signature",
    );
    const duplicateFieldPath = path.join(temporaryRoot, "duplicate-field.receipt.json");
    await writeFile(
      duplicateFieldPath,
      Buffer.from(`{"schemaVersion":2,"schemaVersion":2,"payload":{}}`, "utf8"),
    );
    await expectReject(
      () =>
        verifyLevel4Receipt({
          receiptPath: duplicateFieldPath,
          artifactPaths: fixture.artifactPaths,
          expected: {
            platform: fixture.workflowDefinition.platform,
            architecture: fixture.workflowDefinition.architecture,
            sourceCommit: fixture.sourceCommit,
            threadleafVersion: "0.1.0-beta.7",
            electronVersion: "fixture-electron-1",
          },
        }),
      "duplicate envelope field",
    );
    const wrongPackagePath = path.join(temporaryRoot, "wrong-package");
    await copyDirectory(fixture.packagePath, wrongPackagePath);
    await writeFile(
      path.join(wrongPackagePath, "lib", "reachable.js"),
      "export const reachable = false;\n",
    );
    await expectReject(
      () =>
        verifyLevel4Receipt({
          receiptPath: finalized.receiptPath,
          artifactPaths: { ...fixture.artifactPaths, packagePath: wrongPackagePath },
          expected: {
            platform: fixture.workflowDefinition.platform,
            architecture: fixture.workflowDefinition.architecture,
            sourceCommit: fixture.sourceCommit,
            threadleafVersion: "0.1.0-beta.7",
            electronVersion: "fixture-electron-1",
          },
        }),
      "changed reachable package dependency",
    );
    const wrongInstalledPath = path.join(temporaryRoot, "wrong-installed");
    await copyDirectory(fixture.artifactPaths.installedApplicationTreePath, wrongInstalledPath);
    await writeFile(
      path.join(wrongInstalledPath, "resources.asar"),
      "changed-installed-application\n",
    );
    await expectReject(
      () =>
        verifyLevel4Receipt({
          receiptPath: finalized.receiptPath,
          artifactPaths: {
            ...fixture.artifactPaths,
            installedApplicationTreePath: wrongInstalledPath,
          },
          expected: {
            platform: fixture.workflowDefinition.platform,
            architecture: fixture.workflowDefinition.architecture,
            sourceCommit: fixture.sourceCommit,
            threadleafVersion: "0.1.0-beta.7",
            electronVersion: "fixture-electron-1",
          },
        }),
      "changed installed application tree",
    );
    const wrongPackagedPath = path.join(temporaryRoot, "wrong-packaged-artifact");
    await writeFile(wrongPackagedPath, "changed-packaged-artifact\n");
    await expectReject(
      () => verifyFixture({ packagedArtifactPath: wrongPackagedPath }),
      "changed packaged application artifact",
    );
    const wrongBuildManifestPath = path.join(temporaryRoot, "wrong-build-manifest.json");
    await writeJson(wrongBuildManifestPath, {
      schemaVersion: 1,
      applicationId: "org.threadleaf.Threadleaf",
      version: "changed-fixture-build",
      platform: "linux",
      architecture: "x64",
      source: "fixture",
    });
    await expectReject(
      () => verifyFixture({ canonicalBuildManifestPath: wrongBuildManifestPath }),
      "changed canonical build manifest",
    );
    const wrongPreconditionsPath = path.join(temporaryRoot, "wrong-preconditions.json");
    await writeJson(wrongPreconditionsPath, { schemaVersion: 1, policy: "changed" });
    await expectReject(
      () => verifyFixture({ preconditionsPath: wrongPreconditionsPath }),
      "changed preconditions",
    );
    const wrongStartingFixturePath = path.join(temporaryRoot, "wrong-starting-fixture.json");
    await writeJson(wrongStartingFixturePath, { schemaVersion: 1, state: "changed" });
    await expectReject(
      () => verifyFixture({ startingFixturePath: wrongStartingFixturePath }),
      "changed starting fixture",
    );
    const wrongDistPath = path.join(temporaryRoot, "wrong-dist");
    await copyDirectory(fixture.artifactPaths.relevantDistTreePath, wrongDistPath);
    await writeFile(
      path.join(wrongDistPath, "compatibility-registry.js"),
      "changed-registry-code\n",
    );
    await expectReject(
      () =>
        verifyLevel4Receipt({
          receiptPath: finalized.receiptPath,
          artifactPaths: { ...fixture.artifactPaths, relevantDistTreePath: wrongDistPath },
          expected: {
            platform: fixture.workflowDefinition.platform,
            architecture: fixture.workflowDefinition.architecture,
            sourceCommit: fixture.sourceCommit,
            threadleafVersion: "0.1.0-beta.7",
            electronVersion: "fixture-electron-1",
          },
        }),
      "changed relevant registry dist",
    );
    const wrongElectronPath = path.join(temporaryRoot, "wrong-electron");
    await writeFile(wrongElectronPath, "changed-electron\n", 0o700);
    await expectReject(
      () =>
        verifyLevel4Receipt({
          receiptPath: finalized.receiptPath,
          artifactPaths: { ...fixture.artifactPaths, electronExecutablePath: wrongElectronPath },
          expected: {
            platform: fixture.workflowDefinition.platform,
            architecture: fixture.workflowDefinition.architecture,
            sourceCommit: fixture.sourceCommit,
            threadleafVersion: "0.1.0-beta.7",
            electronVersion: "fixture-electron-1",
          },
        }),
      "changed Electron executable",
    );
    const wrongFixturePath = path.join(temporaryRoot, "wrong-fixture");
    await copyDirectory(fixture.artifactPaths.fixtureTreePath, wrongFixturePath);
    await writeFile(path.join(wrongFixturePath, "expected.txt"), "not-completed\n");
    await expectReject(
      () =>
        verifyLevel4Receipt({
          receiptPath: finalized.receiptPath,
          artifactPaths: { ...fixture.artifactPaths, fixtureTreePath: wrongFixturePath },
          expected: {
            platform: fixture.workflowDefinition.platform,
            architecture: fixture.workflowDefinition.architecture,
            sourceCommit: fixture.sourceCommit,
            threadleafVersion: "0.1.0-beta.7",
            electronVersion: "fixture-electron-1",
          },
        }),
      "changed workflow fixture",
    );
    const wrongWorkflowPath = path.join(temporaryRoot, "wrong-workflow.json");
    const wrongWorkflow = JSON.parse(
      await fs.readFile(fixture.artifactPaths.workflowDefinitionPath, "utf8"),
    );
    wrongWorkflow.version = "1.0.1";
    await writeJson(wrongWorkflowPath, wrongWorkflow);
    await expectReject(
      () => verifyFixture({ workflowDefinitionPath: wrongWorkflowPath }),
      "changed workflow definition",
    );
    const wrongSealedPath = path.join(temporaryRoot, "wrong-sealed");
    await copyDirectory(fixture.sealedPackageRootPath, wrongSealedPath);
    await writeFile(
      path.join(wrongSealedPath, "lib", "reachable.js"),
      "export const reachable = false;\n",
    );
    await expectReject(
      () =>
        verifyLevel4Receipt({
          receiptPath: finalized.receiptPath,
          artifactPaths: { ...fixture.artifactPaths, sealedPackageRootPath: wrongSealedPath },
          expected: {
            platform: fixture.workflowDefinition.platform,
            architecture: fixture.workflowDefinition.architecture,
            sourceCommit: fixture.sourceCommit,
            threadleafVersion: "0.1.0-beta.7",
            electronVersion: "fixture-electron-1",
          },
        }),
      "changed sealed package root",
    );
    const wrongControllerPath = path.join(temporaryRoot, "wrong-controller.mjs");
    await writeFile(
      wrongControllerPath,
      String(await fs.readFile(fixture.artifactPaths.controllerExecutablePath, "utf8")) +
        "\n// stale fixture copy\n",
    );
    await expectReject(
      () => verifyFixture({ controllerExecutablePath: wrongControllerPath }),
      "stale controller executable",
    );
    const wrongHarnessPath = path.join(temporaryRoot, "wrong-harness");
    await copyDirectory(fixture.artifactPaths.harnessTreePath, wrongHarnessPath);
    await writeFile(path.join(wrongHarnessPath, "README.md"), "stale harness\n");
    await expectReject(
      () => verifyFixture({ harnessTreePath: wrongHarnessPath }),
      "stale evidence harness",
    );
    const wrongAuthorityProfilePath = path.join(temporaryRoot, "wrong-authority-profile.json");
    const wrongAuthorityProfile = JSON.parse(
      await fs.readFile(fixture.artifactPaths.authorityProfilePath, "utf8"),
    );
    wrongAuthorityProfile.authorityDigest = "0".repeat(64);
    await writeJson(wrongAuthorityProfilePath, wrongAuthorityProfile);
    await expectReject(
      () => verifyFixture({ authorityProfilePath: wrongAuthorityProfilePath }),
      "changed authority profile",
    );
    const revokedPolicy = JSON.parse(
      await fs.readFile(fixture.artifactPaths.trustPolicyPath, "utf8"),
    );
    revokedPolicy.issuerKeys[0].status = "revoked";
    await writeJson(fixture.artifactPaths.trustPolicyPath, revokedPolicy);
    await expectReject(
      () =>
        verifyLevel4Receipt({
          receiptPath: finalized.receiptPath,
          artifactPaths: fixture.artifactPaths,
          expected: {
            platform: fixture.workflowDefinition.platform,
            architecture: fixture.workflowDefinition.architecture,
            sourceCommit: fixture.sourceCommit,
            threadleafVersion: "0.1.0-beta.7",
            electronVersion: "fixture-electron-1",
          },
        }),
      "revoked issuer key",
    );
    const activePolicy = JSON.parse(
      await fs.readFile(path.join(temporaryRoot, "trust-policy.json"), "utf8"),
    );
    activePolicy.issuerKeys[0].status = "active";
    await writeJson(fixture.artifactPaths.trustPolicyPath, activePolicy);
    activePolicy.trustStoreVersion = 2;
    await writeJson(fixture.artifactPaths.trustPolicyPath, activePolicy);
    await expectReject(
      () =>
        verifyLevel4Receipt({
          receiptPath: finalized.receiptPath,
          artifactPaths: fixture.artifactPaths,
          expected: {
            platform: fixture.workflowDefinition.platform,
            architecture: fixture.workflowDefinition.architecture,
            sourceCommit: fixture.sourceCommit,
            threadleafVersion: "0.1.0-beta.7",
            electronVersion: "fixture-electron-1",
          },
        }),
      "stale trust store identity",
    );
    activePolicy.trustStoreVersion = 1;
    await writeJson(fixture.artifactPaths.trustPolicyPath, activePolicy);
    const { publicKey: wrongIssuerPublicKey } = generateKeyPairSync("ed25519");
    const wrongIssuerPublicKeyBytes = wrongIssuerPublicKey.export({ type: "spki", format: "der" });
    const wrongIssuerPolicy = structuredClone(activePolicy);
    wrongIssuerPolicy.issuerKeys[0].publicKeyBase64 = wrongIssuerPublicKeyBytes.toString("base64");
    wrongIssuerPolicy.issuerKeys[0].keyIdentitySha256 = sha256Bytes(wrongIssuerPublicKeyBytes);
    await writeJson(fixture.artifactPaths.trustPolicyPath, wrongIssuerPolicy);
    await expectReject(() => verifyFixture(), "rotated active issuer key");
    await writeJson(fixture.artifactPaths.trustPolicyPath, activePolicy);
    const forgedRuntime = createLevel4ControllerRun({
      workflowId: fixture.workflowDefinition.workflowId,
      workflowDefinition: fixture.workflowDefinition,
    });
    await expectReject(
      () =>
        forgedRuntime.observe({
          kind: "step",
          source: "fixture",
          value: { compatibilityLevel: 4 },
          observedAt: new Date().toISOString(),
        }),
      "runtime self-promotion",
    );

    const failedRun = createLevel4ControllerRun({
      workflowId: fixture.workflowDefinition.workflowId,
      workflowDefinition: fixture.workflowDefinition,
    });
    failedRun.observe({
      kind: "step",
      source: "fixture",
      value: { step: "failed", success: false },
      observedAt: new Date().toISOString(),
    });
    const failed = await finalizeLevel4Receipt({
      run: failedRun,
      result: {
        ...successfulResult(fixture),
        processOutcome: "completed",
        assertions: [
          assertion("workflow.open", { state: "open" }),
          { ...assertion("workflow.save", { state: "saved" }), passed: false },
        ],
      },
      artifactPaths: fixture.artifactPaths,
      privateKey: fixture.privateKeyPath,
      receiptDirectory: fixture.receiptDirectory,
      attemptDirectory: fixture.attemptDirectory,
    });
    check(failed.publishable === false, "missing assertion must produce a nonpublishable attempt");
    check(
      (await fs.readdir(fixture.receiptDirectory)).length === 1,
      "failed attempt must not enter receipt store",
    );
    const missingAssertionRun = createLevel4ControllerRun({
      workflowId: fixture.workflowDefinition.workflowId,
      workflowDefinition: fixture.workflowDefinition,
    });
    missingAssertionRun.observe({
      kind: "step",
      source: "fixture",
      value: { step: "missing-assertion" },
      observedAt: new Date().toISOString(),
    });
    const missingAssertion = await finalizeLevel4Receipt({
      run: missingAssertionRun,
      result: {
        ...successfulResult(fixture),
        assertions: [assertion("workflow.open", { state: "open" })],
      },
      artifactPaths: fixture.artifactPaths,
      privateKey: fixture.privateKeyPath,
      receiptDirectory: fixture.receiptDirectory,
      attemptDirectory: fixture.attemptDirectory,
    });
    check(
      missingAssertion.publishable === false,
      "missing required assertion must produce a nonpublishable attempt",
    );
    for (const processOutcome of [
      "canceled",
      "failed",
      "timed-out",
      "crashed",
      "ambiguous",
      "partial",
    ]) {
      const negativeRun = createLevel4ControllerRun({
        workflowId: fixture.workflowDefinition.workflowId,
        workflowDefinition: fixture.workflowDefinition,
      });
      negativeRun.observe({
        kind: "host",
        source: "fixture",
        value: { outcome: processOutcome },
        observedAt: new Date().toISOString(),
      });
      const negative = await finalizeLevel4Receipt({
        run: negativeRun,
        result: {
          ...successfulResult(fixture),
          processOutcome,
          failureReason: `fixture ${processOutcome}`,
        },
        artifactPaths: fixture.artifactPaths,
        privateKey: fixture.privateKeyPath,
        receiptDirectory: fixture.receiptDirectory,
        attemptDirectory: fixture.attemptDirectory,
      });
      check(negative.publishable === false, `${processOutcome} attempt must not be publishable`);
    }
    const unavailableRun = createLevel4ControllerRun({
      workflowId: fixture.workflowDefinition.workflowId,
      workflowDefinition: fixture.workflowDefinition,
    });
    unavailableRun.observe({
      kind: "host",
      source: "fixture",
      value: { outcome: "delivery-unavailable" },
      observedAt: new Date().toISOString(),
    });
    const unavailable = await finalizeLevel4Receipt({
      run: unavailableRun,
      result: {
        ...successfulResult(fixture),
        deliveryAssertions: [
          { id: "delivery.receipt", required: true, available: false, detail: "missing" },
        ],
      },
      artifactPaths: fixture.artifactPaths,
      privateKey: fixture.privateKeyPath,
      receiptDirectory: fixture.receiptDirectory,
      attemptDirectory: fixture.attemptDirectory,
    });
    check(
      unavailable.publishable === false,
      "unavailable required delivery must not be publishable",
    );
    const attemptNames = await fs.readdir(fixture.attemptDirectory);
    check(attemptNames.length >= 3, "non-passing attempts must be isolated from the receipt store");
    const attemptRecord = parseLevel4ControllerAttemptRecordV2(
      JSON.parse(await fs.readFile(path.join(fixture.attemptDirectory, attemptNames[0]), "utf8")),
    );
    check(
      verifyLevel4ControllerAttemptRecordSignature(attemptRecord, fixture.publicKey),
      "non-passing attempt records must be controller-signed",
    );
    const flushFailureRun = createLevel4ControllerRun({
      workflowId: fixture.workflowDefinition.workflowId,
      workflowDefinition: fixture.workflowDefinition,
    });
    flushFailureRun.observe({
      kind: "step",
      source: "fixture",
      value: { step: "flush-failure" },
      observedAt: new Date().toISOString(),
    });
    await expectReject(
      () =>
        finalizeLevel4Receipt({
          run: flushFailureRun,
          result: successfulResult(fixture),
          artifactPaths: fixture.artifactPaths,
          privateKey: fixture.privateKeyPath,
          receiptDirectory: fixture.receiptDirectory,
          attemptDirectory: fixture.attemptDirectory,
          faults: {
            afterReceiptFlush: async () => {
              throw new Error("fixture flush failure");
            },
          },
        }),
      "final receipt flush failure",
    );
    check(
      !(await fs.readdir(fixture.receiptDirectory)).some((name) =>
        name.startsWith(flushFailureRun.runId),
      ),
      "flush failure must leave no final receipt",
    );
    const linkFailureRun = createLevel4ControllerRun({
      workflowId: fixture.workflowDefinition.workflowId,
      workflowDefinition: fixture.workflowDefinition,
    });
    linkFailureRun.observe({
      kind: "step",
      source: "fixture",
      value: { step: "link-failure" },
      observedAt: new Date().toISOString(),
    });
    await expectReject(
      () =>
        finalizeLevel4Receipt({
          run: linkFailureRun,
          result: successfulResult(fixture),
          artifactPaths: fixture.artifactPaths,
          privateKey: fixture.privateKeyPath,
          receiptDirectory: fixture.receiptDirectory,
          attemptDirectory: fixture.attemptDirectory,
          faults: {
            beforeReceiptLink: async () => {
              throw new Error("fixture link failure");
            },
          },
        }),
      "partial final receipt write",
    );
    check(
      !(await fs.readdir(fixture.receiptDirectory)).some((name) =>
        name.startsWith(linkFailureRun.runId),
      ),
      "partial final receipt write must leave no final receipt",
    );
    const symlinkTree = path.join(temporaryRoot, "symlink-tree");
    await fs.mkdir(symlinkTree, { recursive: true, mode: 0o700 });
    await writeFile(path.join(symlinkTree, "real.txt"), "real\n");
    await fs.symlink("real.txt", path.join(symlinkTree, "link.txt"));
    await expectReject(() => buildTreeManifest(symlinkTree), "symlink artifact entry");
    await expectReject(
      () =>
        finalizeLevel4Receipt({
          run,
          result,
          artifactPaths: fixture.artifactPaths,
          privateKey: fixture.privateKeyPath,
          receiptDirectory: fixture.receiptDirectory,
          attemptDirectory: fixture.attemptDirectory,
        }),
      "existing final receipt name",
    );

    const sourceEntry = {
      plugin: {
        id: fixture.packageData.packageIdentity.pluginId,
        name: "Fixture plugin",
        version: fixture.packageData.packageIdentity.manifestVersion,
        repository: "https://example.invalid/threadleaf-level4-fixture",
        license: "MIT",
        bundleSha256: fixture.packageData.packageIdentity.mainSha256,
      },
      threadleafVersion: "0.1.0-beta.7",
      lastTested: "2026-08-17",
      compatibilityLevel: 4,
      summary: "A hermetic fixture receipt was accepted by the dedicated controller and verifier.",
      evidenceMode: "production-receipt",
      requiredCapabilities: ["editor-extension"],
      platforms: [
        {
          id: fixture.workflowDefinition.platform,
          status: "verified",
          limits: ["Fixture-only evidence; not a production plugin row."],
        },
      ],
      workflows: [
        {
          id: fixture.workflowDefinition.workflowId,
          name: "Hermetic fixture workflow",
          status: "passed",
          gates: [
            {
              path: "scripts/compatibility/harness/README.md",
              command: "pnpm test:level4-hermetic",
            },
          ],
        },
      ],
      failures: [],
      limitations: ["This isolated output is not the production registry."],
      level4Receipt: {
        receiptPath: finalized.receiptPath,
        replayIndexPath: fixture.artifactPaths.replayIndexPath,
        trustPolicyPath: fixture.artifactPaths.trustPolicyPath,
        trustedControllerManifestPath: fixture.artifactPaths.trustedControllerManifestPath,
        controllerExecutablePath: fixture.artifactPaths.controllerExecutablePath,
        harnessTreePath: fixture.artifactPaths.harnessTreePath,
        workflowDefinitionPath: fixture.artifactPaths.workflowDefinitionPath,
        fixtureTreePath: fixture.artifactPaths.fixtureTreePath,
        packagePath: fixture.artifactPaths.packagePath,
        sealedPackageRootPath: fixture.artifactPaths.sealedPackageRootPath,
        packagedArtifactPath: fixture.artifactPaths.packagedArtifactPath,
        installedApplicationTreePath: fixture.artifactPaths.installedApplicationTreePath,
        canonicalBuildManifestPath: fixture.artifactPaths.canonicalBuildManifestPath,
        relevantDistTreePath: fixture.artifactPaths.relevantDistTreePath,
        electronExecutablePath: fixture.artifactPaths.electronExecutablePath,
        authorityProfilePath: fixture.artifactPaths.authorityProfilePath,
        preconditionsPath: fixture.artifactPaths.preconditionsPath,
        startingFixturePath: fixture.artifactPaths.startingFixturePath,
        vaultTreeBeforePath: fixture.artifactPaths.vaultTreeBeforePath,
        vaultTreeAfterPath: fixture.artifactPaths.vaultTreeAfterPath,
        distributionTag: fixture.artifactPaths.distributionTag,
        requiredDistPaths: fixture.artifactPaths.requiredDistPaths,
        screenshots: [],
        platform: fixture.workflowDefinition.platform,
        architecture: fixture.workflowDefinition.architecture,
        sourceCommit: fixture.sourceCommit,
        threadleafVersion: "0.1.0-beta.7",
        electronVersion: "fixture-electron-1",
      },
    };
    const sourcePath = path.join(temporaryRoot, "plugin-evidence.json");
    await writeJson(sourcePath, { schemaVersion: 2, entries: [sourceEntry] });
    const isolatedRegistryPath = path.join(temporaryRoot, "registry.json");
    const isolatedTypeScriptPath = path.join(temporaryRoot, "registry.ts");
    const isolatedMarkdownPath = path.join(temporaryRoot, "registry.md");
    const generated = await generatePluginCompatibilityRegistry({
      sourcePathOverride: sourcePath,
      registryPathOverride: isolatedRegistryPath,
      generatedTypeScriptPathOverride: isolatedTypeScriptPath,
      generatedMarkdownPathOverride: isolatedMarkdownPath,
      fixtureOnly: true,
    });
    check(
      generated.registry.entries[0].compatibilityLevel === 4,
      "isolated registry must consume only the accepted fixture receipt",
    );
    check(
      !JSON.stringify(generated.registry).includes("fixture-private-key"),
      "isolated registry must not expose private key paths",
    );

    const declarativeSourcePath = path.join(temporaryRoot, "declarative-evidence.json");
    const declarative = { ...sourceEntry };
    delete declarative.level4Receipt;
    await writeJson(declarativeSourcePath, { schemaVersion: 2, entries: [declarative] });
    await expectReject(
      () =>
        generatePluginCompatibilityRegistry({
          sourcePathOverride: declarativeSourcePath,
          registryPathOverride: path.join(temporaryRoot, "declarative-registry.json"),
          generatedTypeScriptPathOverride: path.join(temporaryRoot, "declarative-registry.ts"),
          generatedMarkdownPathOverride: path.join(temporaryRoot, "declarative-registry.md"),
          fixtureOnly: true,
        }),
      "declarative Level 4 evidence",
    );

    const rotationSourcePath = path.join(temporaryRoot, "rotation-evidence.json");
    await writeJson(rotationSourcePath, { schemaVersion: 2, entries: [sourceEntry] });
    const rotatedPolicy = JSON.parse(
      await fs.readFile(fixture.artifactPaths.trustPolicyPath, "utf8"),
    );
    await expectReject(
      () =>
        generatePluginCompatibilityRegistry({
          sourcePathOverride: rotationSourcePath,
          registryPathOverride: path.join(temporaryRoot, "rotation-registry.json"),
          generatedTypeScriptPathOverride: path.join(temporaryRoot, "rotation-registry.ts"),
          generatedMarkdownPathOverride: path.join(temporaryRoot, "rotation-registry.md"),
          fixtureOnly: true,
          beforePublication: async () => {
            rotatedPolicy.trustStoreVersion = 2;
            await writeJson(fixture.artifactPaths.trustPolicyPath, rotatedPolicy);
          },
        }),
      "trust rotation between verification and publication",
    );
    check(
      !(await fileExists(path.join(temporaryRoot, "rotation-registry.json"))),
      "trust rotation must publish no isolated Level 4 registry row",
    );

    process.stdout.write(
      `${JSON.stringify({ hermetic: true, controllerTerminalState: "completed", receiptCanonical: true, receiptVerified: true, replayIdempotent: true, isolatedRegistryLevel: generated.registry.entries[0].compatibilityLevel, productionRegistryUntouched: true })}\n`,
    );
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(
    `Level 4 hermetic fixture failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
