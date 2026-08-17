import type {
  Level4ControllerAttemptRecordV2,
  Level4ReceiptEnvelopeV2,
  Level4ReceiptPayloadV2,
  Level4ReplayEntryV1,
  Level4RuntimeObservationV1,
  Level4StrictJsonValue,
  Level4TrustedControllerManifestV1,
  Level4TrustPolicyV1,
  Level4VerificationTupleV2,
  Level4WorkflowDefinitionV2,
} from "./level4-receipts";

export function canonicalizeLevel4Json(value: Level4StrictJsonValue): Uint8Array;
export function level4JsonSha256(value: Level4StrictJsonValue): string;
export function parseLevel4Json(
  value: Uint8Array | string,
  options?: { requireCanonical?: boolean },
): Level4StrictJsonValue;
export function parseLevel4ReceiptEnvelopeV2(value: unknown): Level4ReceiptEnvelopeV2;
export function parseLevel4ReceiptPayloadV2(value: unknown): Level4ReceiptPayloadV2;
export function parseLevel4RuntimeObservationV1(value: unknown): Level4RuntimeObservationV1;
export function parseLevel4ControllerAttemptRecordV2(
  value: unknown,
): Level4ControllerAttemptRecordV2;
export function parseLevel4TrustPolicyV1(value: unknown): Level4TrustPolicyV1;
export function parseLevel4TrustedControllerManifestV1(
  value: unknown,
): Level4TrustedControllerManifestV1;
export function parseLevel4WorkflowDefinitionV2(value: unknown): Level4WorkflowDefinitionV2;
export function parseLevel4VerificationTupleV2(value: unknown): Level4VerificationTupleV2;
export function parseLevel4ReplayEntryV1(value: unknown): Level4ReplayEntryV1;
export function createLevel4ControllerAttemptRecordV2(input: {
  record: Omit<Level4ControllerAttemptRecordV2, "signature">;
  privateKey: unknown;
}): Level4ControllerAttemptRecordV2;
export function verifyLevel4ControllerAttemptRecordSignature(
  record: Level4ControllerAttemptRecordV2,
  publicKey: unknown,
): boolean;
export function createLevel4ReceiptEnvelopeV2(input: {
  payload: Level4ReceiptPayloadV2;
  issuer: Level4ReceiptEnvelopeV2["issuer"];
  privateKey: unknown;
}): Level4ReceiptEnvelopeV2;
export function verifyLevel4ReceiptSignature(
  envelope: Level4ReceiptEnvelopeV2,
  publicKey: unknown,
): boolean;
export function level4ReceiptSigningPreimage(
  envelope: Omit<Level4ReceiptEnvelopeV2, "signature">,
): Uint8Array;
export function level4ReceiptUnsignedEnvelope(
  envelope: Level4ReceiptEnvelopeV2,
): Omit<Level4ReceiptEnvelopeV2, "signature">;
export function level4ControllerAttemptSigningPreimage(
  record: Omit<Level4ControllerAttemptRecordV2, "signature">,
): Uint8Array;
