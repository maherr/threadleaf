import type { ExactPluginPackageIdentity } from "./plugins";

export type Level4StrictJsonValue =
  | null
  | boolean
  | number
  | string
  | Level4StrictJsonValue[]
  | { [key: string]: Level4StrictJsonValue };

export type Level4TerminalState =
  | "not-started"
  | "started"
  | "completed"
  | "canceled"
  | "failed"
  | "timed-out";

export type Level4ObservationKind = "probe" | "step" | "renderer" | "host";

export interface Level4RuntimeObservationV1 {
  schemaVersion: 1;
  runId: string;
  runNonce: string;
  sequence: number;
  kind: Level4ObservationKind;
  source: string;
  value: Level4StrictJsonValue;
  observedAt: string;
}

export interface Level4ConstructionPolicyEpochV1 {
  checkpoint: string;
  policyEpoch: number;
  grantEpoch: number;
  grantRevision: number;
  safeModeEpoch: number;
  packageStoreEpoch: number;
  authorityProfileRevision: number;
}

export interface Level4AssertionV2 {
  id: string;
  required: boolean;
  passed: boolean;
  observedValue: Level4StrictJsonValue;
  source: string;
  evidenceSha256: string | null;
}

export interface Level4DeliveryAssertionV2 {
  id: string;
  required: boolean;
  available: boolean;
  detail: string;
}

export interface Level4VaultChangeV2 {
  path: string;
  kind: "created" | "modified" | "deleted" | "renamed";
  beforeSha256: string | null;
  afterSha256: string | null;
}

export interface Level4ScreenshotV2 {
  path: string;
  purpose: string;
  sha256: string;
}

export interface Level4CancelControlV2 {
  stepId: string;
  result: "canceled";
  provesNoCompletion: boolean;
  evidenceSha256: string | null;
}

export interface Level4ErrorV2 {
  kind: "uncaught-error" | "rejected-promise" | "renderer-crash" | "timeout" | "host-diagnostic";
  detail: string;
}

export interface Level4ReceiptPayloadV2 {
  schemaVersion: 2;
  workflowId: string;
  workflowDefinitionSha256: string;
  fixtureVersion: string;
  fixtureTreeSha256: string;
  runId: string;
  runNonce: string;
  packageIdentity: ExactPluginPackageIdentity;
  packageIdentityDigest: string;
  stagedPackageTreeSha256: string;
  authorityProfileId: string;
  authorityDigest: string;
  constructionPolicyEpochs: Level4ConstructionPolicyEpochV1[];
  threadleafVersion: string;
  sourceCommit: string;
  packagedApplicationArtifactSha256: string;
  installedApplicationTreeSha256: string;
  canonicalBuildManifestSha256: string;
  relevantDistTreeSha256: string;
  electronExecutableSha256: string;
  effectiveBuildIdentityDigest: string;
  controllerVersion: string;
  controllerExecutableSha256: string;
  trustedControllerManifestId: string;
  trustedControllerManifestSha256: string;
  evidenceHarnessVersion: string;
  evidenceHarnessTreeSha256: string;
  issuerKeyId: string;
  issuerKeyIdentitySha256: string;
  issuerTrustStoreVersion: number;
  issuerTrustStoreIdentitySha256: string;
  preconditionsSha256: string;
  startingFixtureSha256: string;
  observations: Level4RuntimeObservationV1[];
  terminalState: "completed";
  assertions: Level4AssertionV2[];
  deliveryAssertions: Level4DeliveryAssertionV2[];
  allowlistedVaultChanges: Level4VaultChangeV2[];
  vaultTreeBeforeSha256: string;
  vaultTreeAfterSha256: string;
  privateStateNamespaces: string[];
  rendererIdentityBeforeReload: string;
  rendererIdentityAfterReload: string;
  postReloadAssertions: Level4AssertionV2[];
  cancelControl: Level4CancelControlV2;
  errors: Level4ErrorV2[];
  screenshots: Level4ScreenshotV2[];
  platform: string;
  architecture: string;
  electronVersion: string;
}

export interface Level4ReceiptIssuerV2 {
  keyId: string;
  keyIdentitySha256: string;
  controllerVersion: string;
  controllerExecutableSha256: string;
  trustedControllerManifestSha256: string;
  issuerTrustStoreIdentitySha256: string;
}

export interface Level4ReceiptEnvelopeV2 {
  schemaVersion: 2;
  payload: Level4ReceiptPayloadV2;
  payloadSha256: string;
  issuer: Level4ReceiptIssuerV2;
  signature: {
    algorithm: "Ed25519";
    valueBase64: string;
  };
}

export interface Level4WorkflowDefinitionV2 {
  schemaVersion: 2;
  workflowId: string;
  version: string;
  pluginId: string;
  packageIdentityDigest: string;
  platform: string;
  architecture: string;
  requiredAssertionIds: string[];
  requiredPostReloadAssertionIds: string[];
  requiredDeliveryIds: string[];
  cancellationStepId: string;
  fixtureVersion: string;
}

export interface Level4TrustPolicyV1 {
  schemaVersion: 1;
  trustStoreVersion: number;
  trustedControllerManifest: {
    manifestId: string;
    manifestVersion: number;
    controllerVersion: string;
    controllerExecutableSha256: string;
    allowedReceiptSchemaVersions: [2];
    currentHarness: {
      version: string;
      treeSha256: string;
    };
  };
  issuerKeys: Array<{
    keyId: string;
    publicKeyBase64: string;
    keyIdentitySha256: string;
    status: "active" | "revoked";
  }>;
}

export type Level4TrustedControllerManifestV1 = Level4TrustPolicyV1["trustedControllerManifest"];

export interface Level4VerificationTupleV2 {
  schemaVersion: 2;
  effectiveBuildIdentityDigest: string;
  packageIdentityDigest: string;
  authorityDigest: string;
  workflowDefinitionSha256: string;
  fixtureTreeSha256: string;
  platform: string;
  architecture: string;
  controllerExecutableSha256: string;
  trustedControllerManifestSha256: string;
  evidenceHarnessVersion: string;
  evidenceHarnessTreeSha256: string;
  issuerKeyIdentitySha256: string;
  issuerTrustStoreVersion: number;
  issuerTrustStoreIdentitySha256: string;
}

export interface Level4ReplayEntryV1 {
  schemaVersion: 1;
  tupleDigest: string;
  runNonce: string;
  runId: string;
  receiptFileSha256: string;
}

export interface Level4ControllerAttemptRecordV2 {
  schemaVersion: 2;
  runId: string;
  runNonce: string;
  workflowId: string;
  terminalState: Exclude<Level4TerminalState, "not-started" | "started" | "completed">;
  publishable: false;
  failureReason: string;
  observedAt: string;
  observations: Level4RuntimeObservationV1[];
  issuer: Level4ReceiptIssuerV2;
  signature: {
    algorithm: "Ed25519";
    valueBase64: string;
  };
}

export interface Level4VerifiedReceipt {
  receipt: Level4ReceiptEnvelopeV2;
  receiptFileSha256: string;
  verificationTuple: Level4VerificationTupleV2;
  verificationTupleDigest: string;
  replay: "inserted" | "idempotent";
  issuerTrustStoreIdentitySha256: string;
}

export {
  canonicalizeLevel4Json,
  createLevel4ControllerAttemptRecordV2,
  createLevel4ReceiptEnvelopeV2,
  level4ControllerAttemptSigningPreimage,
  level4JsonSha256,
  level4ReceiptSigningPreimage,
  level4ReceiptUnsignedEnvelope,
  parseLevel4ControllerAttemptRecordV2,
  parseLevel4Json,
  parseLevel4ReceiptEnvelopeV2,
  parseLevel4ReceiptPayloadV2,
  parseLevel4ReplayEntryV1,
  parseLevel4RuntimeObservationV1,
  parseLevel4TrustedControllerManifestV1,
  parseLevel4TrustPolicyV1,
  parseLevel4VerificationTupleV2,
  parseLevel4WorkflowDefinitionV2,
  verifyLevel4ControllerAttemptRecordSignature,
  verifyLevel4ReceiptSignature,
} from "./level4-receipt-boundary.mjs";
