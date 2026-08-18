import { createPrivateKey, createPublicKey, randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { authorityJsonSha256 } from "../../src/shared/authority-json-runtime.mjs";
import {
  canonicalizeLevel4Json,
  createLevel4ControllerAttemptRecordV2,
  createLevel4ReceiptEnvelopeV2,
  level4JsonSha256,
  parseLevel4ReceiptPayloadV2,
  parseLevel4RuntimeObservationV1,
  parseLevel4TrustedControllerManifestV1,
  parseLevel4TrustPolicyV1,
  parseLevel4WorkflowDefinitionV2,
} from "../../src/shared/level4-receipt-boundary.mjs";
import {
  buildExecutableClosureManifest,
  buildFileArtifact,
  buildPluginPackageIdentity,
  buildTreeManifest,
  effectiveBuildIdentityDigest,
  readAuthorityJsonFile,
  sha256Bytes,
  validateCanonicalBuildManifest,
} from "./level4-artifacts.mjs";

export const level4ControllerVersion = "level4-controller-v2-phase0";
export const level4ReceiptDirectoryName = "receipts";
export const level4AttemptDirectoryName = "attempts";

function fail(message) {
  throw new Error(`Level 4 controller: ${message}`);
}

function now() {
  return new Date().toISOString();
}

function cloneControllerValue(value, label) {
  try {
    return structuredClone(value);
  } catch (error) {
    fail(`${label} could not be copied: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function ensureObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object.`);
  return value;
}

function ensureExactKeys(value, keys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} contains unsupported or missing fields.`);
  }
}

function rejectRuntimeAuthority(value, label = "observation", depth = 0) {
  if (depth > 24 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      rejectRuntimeAuthority(item, `${label}[${index}]`, depth + 1);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (
      [
        "terminalState",
        "compatibilityLevel",
        "level4",
        "receipt",
        "signature",
        "publishable",
        "finalize",
        "registryMutation",
      ].includes(key)
    ) {
      fail(`${label} attempted to author controller-owned field ${key}.`);
    }
    rejectRuntimeAuthority(child, `${label}.${key}`, depth + 1);
  }
}

function requirePrivateKey(value) {
  try {
    return value?.type === "private" ? value : createPrivateKey(value);
  } catch (error) {
    fail(
      `private issuer key could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function loadPrivateKey(value) {
  if (typeof value !== "string") return requirePrivateKey(value);
  let bytes;
  try {
    bytes = await fs.readFile(value);
  } catch (error) {
    fail(
      `private issuer key could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return requirePrivateKey(bytes);
}

async function loadTrustContext({
  trustPolicyPath,
  trustedControllerManifestPath,
  controllerExecutablePath,
  harnessTreePath,
}) {
  const rawPolicy = await readAuthorityJsonFile(trustPolicyPath, "Level 4 trust policy");
  const policy = parseLevel4TrustPolicyV1(rawPolicy);
  const rawManifest = await readAuthorityJsonFile(
    trustedControllerManifestPath,
    "trusted controller manifest",
  );
  const manifest = parseLevel4TrustedControllerManifestV1(rawManifest);
  if (level4JsonSha256(policy.trustedControllerManifest) !== level4JsonSha256(manifest)) {
    fail("trust policy and trusted controller manifest disagree.");
  }
  if (manifest.controllerVersion !== level4ControllerVersion)
    fail("trusted controller manifest does not identify this controller version.");
  const controllerArtifact = await buildFileArtifact(controllerExecutablePath, {
    label: "controller executable",
  });
  const harnessManifest = await buildTreeManifest(harnessTreePath, {
    label: "evidence harness",
    includeModes: false,
  });
  const closureRoot = path.resolve(path.dirname(controllerExecutablePath), "../..");
  const executableClosure = await buildExecutableClosureManifest({
    rootPath: closureRoot,
    trustedClosure: manifest.executableClosure,
  });
  if (controllerArtifact.sha256 !== manifest.controllerExecutableSha256)
    fail("controller executable does not match trusted manifest.");
  if (harnessManifest.treeSha256 !== manifest.currentHarness.treeSha256)
    fail("evidence harness does not match trusted manifest.");
  if (executableClosure.closureSha256 !== manifest.executableClosureSha256)
    fail("reachable controller/verifier executable closure is not trusted.");
  return {
    policy,
    manifest,
    controllerExecutableSha256: controllerArtifact.sha256,
    executableClosureSha256: executableClosure.closureSha256,
    evidenceHarnessTreeSha256: harnessManifest.treeSha256,
    trustedControllerManifestSha256: level4JsonSha256(manifest),
    issuerTrustStoreIdentitySha256: level4JsonSha256(policy),
  };
}

function requireSingleActiveIssuer(policy) {
  const active = policy.issuerKeys.filter((key) => key.status === "active");
  if (active.length === 0)
    fail("no active issuer key is configured; production bootstrap is incomplete.");
  if (active.length !== 1) fail("trust policy must have exactly one active issuer key.");
  return active[0];
}

function findActiveIssuer(policy, privateKey) {
  const activeIssuer = requireSingleActiveIssuer(policy);
  const publicKey = createPublicKey(privateKey);
  const publicKeyBytes = publicKey.export({ type: "spki", format: "der" });
  const publicKeyBase64 = publicKeyBytes.toString("base64");
  const keyIdentitySha256 = sha256Bytes(publicKeyBytes);
  if (
    activeIssuer.publicKeyBase64 !== publicKeyBase64 ||
    activeIssuer.keyIdentitySha256 !== keyIdentitySha256
  )
    fail("private issuer key is not the active key in the current trust policy.");
  return { ...activeIssuer, publicKey, keyIdentitySha256 };
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

async function loadAuthorityProfile(profilePath, packageIdentity, packageIdentityDigest) {
  const profile = await readAuthorityJsonFile(profilePath, "reviewed authority profile");
  ensureObject(profile, "reviewed authority profile");
  if (
    profile.schemaVersion !== 1 ||
    typeof profile.profileId !== "string" ||
    typeof profile.profileRevision !== "number"
  ) {
    fail("reviewed authority profile has no supported identity.");
  }
  if (
    profile.packageIdentityDigest !== packageIdentityDigest ||
    level4JsonSha256(profile.packageIdentity) !== packageIdentityDigest
  ) {
    fail("authority profile package identity digest does not match the exact package.");
  }
  if (level4JsonSha256(profile.packageIdentity) !== level4JsonSha256(packageIdentity))
    fail("authority profile package identity differs from the package.");
  const authorityDigest = authorityJsonSha256(reviewedAuthorityPayload(profile));
  if (profile.authorityDigest !== authorityDigest)
    fail("authority profile authority digest is stale.");
  return { profileId: profile.profileId, authorityDigest, profile };
}

async function digestScreenshotList(screenshots = []) {
  if (!Array.isArray(screenshots) || screenshots.length > 256)
    fail("screenshot list is not bounded.");
  return Promise.all(
    screenshots.map(async (item, index) => {
      ensureObject(item, `screenshot[${index}]`);
      ensureExactKeys(item, ["path", "purpose"], `screenshot[${index}]`);
      const artifact = await buildFileArtifact(item.path, { label: `screenshot ${index}` });
      return {
        artifactId: `sha256:${artifact.sha256}`,
        purpose: item.purpose,
        sha256: artifact.sha256,
      };
    }),
  );
}

async function buildPayloadArtifacts(input) {
  const workflow = parseLevel4WorkflowDefinitionV2(
    await readAuthorityJsonFile(input.workflowDefinitionPath, "workflow definition"),
  );
  const packageData = await buildPluginPackageIdentity(input.packagePath, {
    distributionTag: input.distributionTag,
  });
  const sealedPackage = await buildTreeManifest(input.sealedPackageRootPath, {
    label: "sealed-plugin-package",
  });
  if (sealedPackage.treeSha256 !== packageData.packageIdentity.packageTreeSha256)
    fail("sealed package root differs from staged package tree.");
  if (workflow.packageIdentityDigest !== packageData.packageIdentityDigest)
    fail("workflow package identity does not match the exact package.");
  const fixtureTree = await buildTreeManifest(input.fixtureTreePath, { label: "workflow-fixture" });
  const packagedArtifact = await buildFileArtifact(input.packagedArtifactPath, {
    label: "packaged application artifact",
  });
  const installedTree = await buildTreeManifest(input.installedApplicationTreePath, {
    label: "installed application",
  });
  const buildManifest = await validateCanonicalBuildManifest(input.canonicalBuildManifestPath, {
    installedApplicationTreePath: input.installedApplicationTreePath,
    requiredInstalledPaths: input.requiredInstalledPaths,
    expected: input.expected,
  });
  const relevantDist = await buildTreeManifest(input.relevantDistTreePath, {
    label: "relevant dist",
  });
  const electron = await buildFileArtifact(input.electronExecutablePath, {
    label: "Electron executable",
  });
  const preconditions = await buildFileArtifact(input.preconditionsPath, {
    label: "preconditions",
  });
  const startingFixture = await buildFileArtifact(input.startingFixturePath, {
    label: "starting fixture",
  });
  const vaultBefore = await buildTreeManifest(input.vaultTreeBeforePath, { label: "vault before" });
  const vaultAfter = await buildTreeManifest(input.vaultTreeAfterPath, { label: "vault after" });
  const trust = await loadTrustContext(input);
  const authority = await loadAuthorityProfile(
    input.authorityProfilePath,
    packageData.packageIdentity,
    packageData.packageIdentityDigest,
  );
  const identity = effectiveBuildIdentityDigest({
    packageIdentityDigest: packageData.packageIdentityDigest,
    stagedPackageTreeSha256: sealedPackage.treeSha256,
    packagedApplicationArtifactSha256: packagedArtifact.sha256,
    installedApplicationTreeSha256: installedTree.treeSha256,
    canonicalBuildManifestSha256: buildManifest.sha256,
    relevantDistTreeSha256: relevantDist.treeSha256,
    electronExecutableSha256: electron.sha256,
  });
  const screenshots = await digestScreenshotList(input.screenshots);
  return {
    workflow,
    packageIdentity: packageData.packageIdentity,
    packageIdentityDigest: packageData.packageIdentityDigest,
    stagedPackageTreeSha256: sealedPackage.treeSha256,
    fixtureTreeSha256: fixtureTree.treeSha256,
    packagedApplicationArtifactSha256: packagedArtifact.sha256,
    installedApplicationTreeSha256: installedTree.treeSha256,
    canonicalBuildManifestSha256: buildManifest.sha256,
    relevantDistTreeSha256: relevantDist.treeSha256,
    electronExecutableSha256: electron.sha256,
    effectiveBuildIdentityDigest: identity.digest,
    workflowDefinitionSha256: level4JsonSha256(workflow),
    preconditionsSha256: preconditions.sha256,
    startingFixtureSha256: startingFixture.sha256,
    vaultTreeBeforeSha256: vaultBefore.treeSha256,
    vaultTreeAfterSha256: vaultAfter.treeSha256,
    screenshots,
    authority,
    trust,
  };
}

export function createLevel4ControllerRun({ workflowId, workflowDefinition }) {
  const workflow = parseLevel4WorkflowDefinitionV2(workflowDefinition);
  if (workflow.workflowId !== workflowId) fail("workflow ID does not match its definition.");
  const runId = randomUUID();
  const runNonce = randomBytes(32).toString("hex");
  const state = {
    workflow,
    runId,
    runNonce,
    observations: [],
    terminalState: "started",
  };
  return {
    get runId() {
      return state.runId;
    },
    get runNonce() {
      return state.runNonce;
    },
    get observations() {
      return state.observations.map((observation) =>
        cloneControllerValue(observation, "observation"),
      );
    },
    observe(input) {
      ensureObject(input, "runtime observation input");
      ensureExactKeys(
        input,
        ["kind", "source", "value", "observedAt"],
        "runtime observation input",
      );
      rejectRuntimeAuthority(input.value);
      const observation = parseLevel4RuntimeObservationV1({
        schemaVersion: 1,
        runId: state.runId,
        runNonce: state.runNonce,
        sequence: state.observations.length + 1,
        kind: input.kind,
        source: input.source,
        value: input.value,
        observedAt: input.observedAt ?? now(),
      });
      const stored = cloneControllerValue(observation, "observation");
      state.observations.push(stored);
      return cloneControllerValue(stored, "observation");
    },
    deriveTerminalState(result) {
      state.terminalState = deriveControllerTerminalState({
        ...result,
        observations: state.observations,
      });
      return state.terminalState;
    },
    snapshot() {
      return {
        workflow: cloneControllerValue(state.workflow, "workflow definition"),
        runId: state.runId,
        runNonce: state.runNonce,
        observations: state.observations.map((observation) =>
          cloneControllerValue(observation, "observation"),
        ),
        terminalState: state.terminalState,
      };
    },
  };
}

export function deriveControllerTerminalState(result) {
  ensureObject(result, "controller result");
  const outcome = result.processOutcome;
  if (outcome === "canceled") return "canceled";
  if (outcome === "timed-out") return "timed-out";
  if (outcome !== "completed") return "failed";
  if (!Array.isArray(result.observations) || result.observations.length === 0) return "failed";
  const workflow = result.workflow;
  const assertions = new Map(
    Array.isArray(result.assertions) ? result.assertions.map((item) => [item.id, item]) : [],
  );
  const postReloadAssertions = new Map(
    Array.isArray(result.postReloadAssertions)
      ? result.postReloadAssertions.map((item) => [item.id, item])
      : [],
  );
  const deliveryAssertions = new Map(
    Array.isArray(result.deliveryAssertions)
      ? result.deliveryAssertions.map((item) => [item.id, item])
      : [],
  );
  if (
    !Array.isArray(result.assertions) ||
    result.assertions.some((item) => item.required && item.passed !== true)
  )
    return "failed";
  if (
    workflow &&
    !workflow.requiredAssertionIds.every(
      (id) => assertions.get(id)?.required === true && assertions.get(id)?.passed === true,
    )
  )
    return "failed";
  if (
    !Array.isArray(result.postReloadAssertions) ||
    result.postReloadAssertions.some((item) => item.required && item.passed !== true)
  )
    return "failed";
  if (
    workflow &&
    !workflow.requiredPostReloadAssertionIds.every(
      (id) =>
        postReloadAssertions.get(id)?.required === true &&
        postReloadAssertions.get(id)?.passed === true,
    )
  )
    return "failed";
  if (
    !Array.isArray(result.deliveryAssertions) ||
    result.deliveryAssertions.some((item) => item.required && item.available !== true)
  )
    return "failed";
  if (
    workflow &&
    !workflow.requiredDeliveryIds.every(
      (id) =>
        deliveryAssertions.get(id)?.required === true &&
        deliveryAssertions.get(id)?.available === true,
    )
  )
    return "failed";
  if (!Array.isArray(result.errors) || result.errors.length !== 0) return "failed";
  if (
    typeof result.rendererIdentityBeforeReload !== "string" ||
    typeof result.rendererIdentityAfterReload !== "string" ||
    result.rendererIdentityBeforeReload === result.rendererIdentityAfterReload
  )
    return "failed";
  if (
    result.cancelControl?.result !== "canceled" ||
    result.cancelControl?.provesNoCompletion !== true
  )
    return "failed";
  if (workflow && result.cancelControl.stepId !== workflow.cancellationStepId) return "failed";
  return "completed";
}

function mapFailureState(value) {
  if (value === "canceled") return "canceled";
  if (value === "timed-out") return "timed-out";
  return "failed";
}

async function syncDirectoryHandle(handle) {
  try {
    await handle.sync();
  } catch (error) {
    if (
      process.platform !== "win32" ||
      !(error instanceof Error) ||
      !("code" in error) ||
      (error.code !== "EISDIR" && error.code !== "EPERM" && error.code !== "EINVAL")
    ) {
      throw error;
    }
  }
}

async function writeNoReplace(
  filePath,
  bytes,
  {
    mode = 0o600,
    beforeLink = undefined,
    afterFlush = undefined,
    afterFinalLink = undefined,
    beforeTemporaryNameRemoval = undefined,
    directoryOpen = undefined,
    directorySync = undefined,
    cleanupFinal = undefined,
  } = {},
) {
  const directoryPath = path.dirname(filePath);
  await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  await fs.chmod(directoryPath, 0o700);
  const pendingDirectory = path.join(directoryPath, ".level4-pending");
  await fs.mkdir(pendingDirectory, { recursive: true, mode: 0o700 });
  await fs.chmod(pendingDirectory, 0o700);
  const temporaryPath = path.join(
    pendingDirectory,
    `.${path.basename(filePath)}.${randomBytes(12).toString("hex")}.tmp`,
  );
  const incompleteMarkerPath = path.join(directoryPath, `.${path.basename(filePath)}.incomplete`);
  let handle;
  let linked = false;
  let finalRemoved = false;
  let markerCreated = false;
  let markerOwned = false;
  try {
    const markerHandle = await fs.open(incompleteMarkerPath, "wx", 0o600);
    markerOwned = true;
    await markerHandle.writeFile("incomplete\n", "utf8");
    await markerHandle.sync();
    await markerHandle.close();
    markerCreated = true;
    handle = await fs.open(temporaryPath, "wx", mode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (afterFlush) await afterFlush();
    if (beforeLink) await beforeLink();
    await fs.link(temporaryPath, filePath);
    linked = true;
    if (afterFinalLink) await afterFinalLink();
    if (beforeTemporaryNameRemoval) await beforeTemporaryNameRemoval();
    await fs.unlink(temporaryPath);
    let directoryHandle;
    try {
      if (directoryOpen) await directoryOpen();
      directoryHandle = await fs.open(directoryPath, "r");
      if (directorySync) await directorySync();
      await syncDirectoryHandle(directoryHandle);
    } finally {
      await directoryHandle?.close();
    }
    await fs.unlink(incompleteMarkerPath);
    markerCreated = false;
    let finalDirectoryHandle;
    try {
      finalDirectoryHandle = await fs.open(directoryPath, "r");
      await syncDirectoryHandle(finalDirectoryHandle);
    } finally {
      await finalDirectoryHandle?.close();
    }
  } catch (error) {
    try {
      await handle?.close();
    } catch {}
    try {
      await fs.unlink(temporaryPath);
    } catch {}
    if (linked && !finalRemoved) {
      try {
        if (cleanupFinal) await cleanupFinal();
        await fs.unlink(filePath);
        finalRemoved = true;
      } catch {}
    }
    if (finalRemoved || (!linked && markerOwned)) {
      try {
        await fs.unlink(incompleteMarkerPath);
        markerCreated = false;
      } catch {}
    } else if (linked && !markerCreated) {
      try {
        const markerHandle = await fs.open(incompleteMarkerPath, "wx", 0o600);
        await markerHandle.writeFile("incomplete\n", "utf8");
        await markerHandle.sync();
        await markerHandle.close();
      } catch {}
    }
    throw error;
  }
}

async function writeFailedAttempt({
  run,
  terminalState,
  failureReason,
  attemptDirectory,
  artifactPaths,
  privateKey,
}) {
  if (!artifactPaths || privateKey === undefined) return null;
  const snapshot = run.snapshot();
  const trust = await loadTrustContext(artifactPaths);
  let issuerKey;
  try {
    requireSingleActiveIssuer(trust.policy);
  } catch (error) {
    if (error instanceof Error && error.message.includes("no active issuer key is configured")) {
      return null;
    }
    throw error;
  }
  const trustKey = await loadPrivateKey(privateKey);
  try {
    issuerKey = findActiveIssuer(trust.policy, trustKey);
  } catch (error) {
    if (error instanceof Error && error.message.includes("no active issuer key is configured")) {
      return null;
    }
    throw error;
  }
  const issuer = {
    keyId: issuerKey.keyId,
    keyIdentitySha256: issuerKey.keyIdentitySha256,
    controllerVersion: trust.manifest.controllerVersion,
    controllerExecutableSha256: trust.controllerExecutableSha256,
    trustedExecutableClosureSha256: trust.executableClosureSha256,
    trustedControllerManifestSha256: trust.trustedControllerManifestSha256,
    issuerTrustStoreIdentitySha256: trust.issuerTrustStoreIdentitySha256,
  };
  const record = createLevel4ControllerAttemptRecordV2({
    record: {
      schemaVersion: 2,
      runId: run.runId,
      runNonce: run.runNonce,
      workflowId: snapshot.workflow.workflowId,
      terminalState: mapFailureState(terminalState),
      publishable: false,
      failureReason,
      observedAt: now(),
      observations: run.observations,
      issuer,
    },
    privateKey: trustKey,
  });
  const bytes = Buffer.from(canonicalizeLevel4Json(record));
  const attemptPath = path.join(attemptDirectory, `${run.runId}.json`);
  await writeNoReplace(attemptPath, bytes);
  return { attemptPath, record };
}

export async function finalizeLevel4Receipt({
  run,
  result,
  artifactPaths,
  privateKey,
  receiptDirectory,
  attemptDirectory,
  faults = {},
}) {
  if (!run || typeof run.snapshot !== "function")
    fail("finalization requires a controller-owned run.");
  const snapshot = run.snapshot();
  const terminalState = run.deriveTerminalState({ ...result, workflow: snapshot.workflow });
  if (terminalState !== "completed") {
    const attempt = await writeFailedAttempt({
      run,
      terminalState,
      failureReason: result.failureReason ?? `controller derived terminal state ${terminalState}`,
      attemptDirectory,
      artifactPaths,
      privateKey,
    });
    return { publishable: false, terminalState, attempt };
  }
  if (faults.beforeArtifactBuild) await faults.beforeArtifactBuild();
  const artifacts = await buildPayloadArtifacts({
    ...artifactPaths,
    expected: {
      threadleafVersion: result.threadleafVersion,
      platform: snapshot.workflow.platform,
      architecture: snapshot.workflow.architecture,
    },
  });
  requireSingleActiveIssuer(artifacts.trust.policy);
  const trustKey = await loadPrivateKey(privateKey);
  const issuerKey = findActiveIssuer(artifacts.trust.policy, trustKey);
  const issuer = {
    keyId: issuerKey.keyId,
    keyIdentitySha256: issuerKey.keyIdentitySha256,
    controllerVersion: artifacts.trust.manifest.controllerVersion,
    controllerExecutableSha256: artifacts.trust.controllerExecutableSha256,
    trustedExecutableClosureSha256: artifacts.trust.executableClosureSha256,
    trustedControllerManifestSha256: artifacts.trust.trustedControllerManifestSha256,
    issuerTrustStoreIdentitySha256: artifacts.trust.issuerTrustStoreIdentitySha256,
  };
  const payload = parseLevel4ReceiptPayloadV2({
    schemaVersion: 2,
    workflowId: snapshot.workflow.workflowId,
    workflowDefinitionSha256: artifacts.workflowDefinitionSha256,
    fixtureVersion: snapshot.workflow.fixtureVersion,
    fixtureTreeSha256: artifacts.fixtureTreeSha256,
    runId: snapshot.runId,
    runNonce: snapshot.runNonce,
    packageIdentity: artifacts.packageIdentity,
    packageIdentityDigest: artifacts.packageIdentityDigest,
    stagedPackageTreeSha256: artifacts.stagedPackageTreeSha256,
    authorityProfileId: artifacts.authority.profileId,
    authorityDigest: artifacts.authority.authorityDigest,
    constructionPolicyEpochs: result.constructionPolicyEpochs,
    threadleafVersion: result.threadleafVersion,
    sourceCommit: result.sourceCommit,
    packagedApplicationArtifactSha256: artifacts.packagedApplicationArtifactSha256,
    installedApplicationTreeSha256: artifacts.installedApplicationTreeSha256,
    canonicalBuildManifestSha256: artifacts.canonicalBuildManifestSha256,
    relevantDistTreeSha256: artifacts.relevantDistTreeSha256,
    electronExecutableSha256: artifacts.electronExecutableSha256,
    effectiveBuildIdentityDigest: artifacts.effectiveBuildIdentityDigest,
    controllerVersion: artifacts.trust.manifest.controllerVersion,
    controllerExecutableSha256: artifacts.trust.controllerExecutableSha256,
    trustedExecutableClosureSha256: artifacts.trust.executableClosureSha256,
    trustedControllerManifestId: artifacts.trust.manifest.manifestId,
    trustedControllerManifestSha256: artifacts.trust.trustedControllerManifestSha256,
    evidenceHarnessVersion: artifacts.trust.manifest.currentHarness.version,
    evidenceHarnessTreeSha256: artifacts.trust.evidenceHarnessTreeSha256,
    issuerKeyId: issuerKey.keyId,
    issuerKeyIdentitySha256: issuerKey.keyIdentitySha256,
    issuerTrustStoreVersion: artifacts.trust.policy.trustStoreVersion,
    issuerTrustStoreIdentitySha256: artifacts.trust.issuerTrustStoreIdentitySha256,
    preconditionsSha256: artifacts.preconditionsSha256,
    startingFixtureSha256: artifacts.startingFixtureSha256,
    observations: snapshot.observations,
    terminalState: "completed",
    assertions: result.assertions,
    deliveryAssertions: result.deliveryAssertions,
    allowlistedVaultChanges: result.allowlistedVaultChanges ?? [],
    vaultTreeBeforeSha256: artifacts.vaultTreeBeforeSha256,
    vaultTreeAfterSha256: artifacts.vaultTreeAfterSha256,
    privateStateNamespaces: result.privateStateNamespaces ?? [],
    rendererIdentityBeforeReload: result.rendererIdentityBeforeReload,
    rendererIdentityAfterReload: result.rendererIdentityAfterReload,
    postReloadAssertions: result.postReloadAssertions,
    cancelControl: result.cancelControl,
    errors: [],
    screenshots: artifacts.screenshots,
    platform: snapshot.workflow.platform,
    architecture: snapshot.workflow.architecture,
    electronVersion: result.electronVersion,
  });
  if (faults.afterPayloadBuild) await faults.afterPayloadBuild(payload);
  const envelope = createLevel4ReceiptEnvelopeV2({ payload, issuer, privateKey: trustKey });
  const bytes = Buffer.from(canonicalizeLevel4Json(envelope));
  const receiptPath = path.join(receiptDirectory, `${snapshot.runId}.receipt.json`);
  try {
    await writeNoReplace(receiptPath, bytes, {
      beforeLink: faults.beforeReceiptLink,
      afterFlush: faults.afterReceiptFlush,
      afterFinalLink: faults.afterFinalReceiptLink,
      beforeTemporaryNameRemoval: faults.beforeReceiptTemporaryNameRemoval,
      directoryOpen: faults.receiptDirectoryOpen,
      directorySync: faults.receiptDirectorySync,
      cleanupFinal: faults.receiptFinalCleanup,
    });
  } catch (error) {
    if (error?.code === "EEXIST") fail(`receipt final name already exists: ${receiptPath}`);
    throw error;
  }
  return {
    publishable: true,
    terminalState: "completed",
    receiptPath,
    envelope,
    payload,
    receiptFileSha256: sha256Bytes(bytes),
  };
}

export async function recordControllerFailure({
  run,
  terminalState,
  failureReason,
  attemptDirectory,
  artifactPaths,
  privateKey,
}) {
  return writeFailedAttempt({
    run,
    terminalState,
    failureReason,
    attemptDirectory,
    artifactPaths,
    privateKey,
  });
}
