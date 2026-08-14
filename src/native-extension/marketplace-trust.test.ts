import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signedDistributionBundle } from "../../fixtures/native-extensions/signed-distribution/index";
import { FileNativeExtensionGrantStore, InMemoryNativeExtensionGrantStore } from "./grants";
import { NativeExtensionHost } from "./host";
import {
  canonicalizeNativeExtensionTrustMetadata,
  createNativeExtensionMarketplaceCatalog,
  createNativeExtensionMarketplaceIndex,
  FileNativeExtensionMarketplaceCatalogStateStore,
  InMemoryNativeExtensionMarketplaceCatalogStateStore,
  type NativeExtensionPublisherKey,
  nativeExtensionMarketplaceCatalogSha256,
  nativeExtensionPublisherKeyFromKeyObject,
  nativeExtensionSignedManifestSha256,
  parseNativeExtensionMarketplaceIndex,
  signNativeExtensionKeyRotation,
  signNativeExtensionManifest,
  signNativeExtensionMarketplaceSuccessor,
  verifyNativeExtensionDistribution,
  verifyNativeExtensionMarketplaceCatalog,
  verifyNativeExtensionMarketplaceIndex,
} from "./marketplace-trust";
import type { NativeVaultPort } from "./ports";
import { createNativeExtensionTestHost } from "./test-support";

const issuedAt = "2026-01-01T00:00:00.000Z";
const now = "2026-06-01T00:00:00.000Z";
const expiresAt = "2027-01-01T00:00:00.000Z";
const vaultPort = {} as NativeVaultPort;

function keyPair() {
  return generateKeyPairSync("ed25519");
}

function publisher(privateKey: ReturnType<typeof keyPair>["privateKey"], keyId: string) {
  return nativeExtensionPublisherKeyFromKeyObject({
    publisherId: "fixture.publisher",
    keyId,
    key: privateKey,
  });
}

function signed(
  privateKey: ReturnType<typeof keyPair>["privateKey"],
  publisherKey: NativeExtensionPublisherKey,
  overrides: Partial<{
    issuedAt: string;
    expiresAt: string;
    revokedAt: string;
    delistedAt: string;
    keyRotation: ReturnType<typeof signNativeExtensionKeyRotation>;
  }> = {},
) {
  return signNativeExtensionManifest(
    {
      manifest: signedDistributionBundle.manifest,
      bundleBytes: signedDistributionBundle.bundleBytes,
      publisher: publisherKey,
      issuedAt: overrides.issuedAt ?? issuedAt,
      expiresAt: overrides.expiresAt ?? expiresAt,
      ...(overrides.revokedAt === undefined ? {} : { revokedAt: overrides.revokedAt }),
      ...(overrides.delistedAt === undefined ? {} : { delistedAt: overrides.delistedAt }),
      ...(overrides.keyRotation === undefined ? {} : { keyRotation: overrides.keyRotation }),
    },
    privateKey,
  );
}

function expectTrustCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected trust failure");
  } catch (error) {
    expect(error).toMatchObject({ name: "NativeExtensionTrustError", code });
  }
}

async function expectHostCode(action: Promise<unknown>, code: string): Promise<void> {
  await expect(action).rejects.toMatchObject({ name: "NativeExtensionError", code });
}

function tamperSignature(signature: string): string {
  const bytes = Buffer.from(signature, "base64url");
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  return bytes.toString("base64url");
}

describe("native extension offline distribution trust", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date(now) });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("verifies an Ed25519 record, displays its SPKI fingerprint, and binds exact bytes", () => {
    const pair = keyPair();
    const publisherKey = publisher(pair.privateKey, "key-1");
    expect(publisherKey.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    const metadata = signed(pair.privateKey, publisherKey);
    const result = verifyNativeExtensionDistribution(
      metadata,
      signedDistributionBundle.bundleBytes,
      {
        trustedPublishers: { version: 1, publishers: [publisherKey] },
      },
    );

    expect(result).toMatchObject({
      status: "trusted",
      keyTrust: "direct",
      publisherFingerprint: publisherKey.fingerprint,
      bundleSha256: metadata.bundleSha256,
      authorityDigest: metadata.authorityDigest,
    });
  });

  it("rejects metadata and bundle tampering before install can proceed", () => {
    const pair = keyPair();
    const publisherKey = publisher(pair.privateKey, "key-1");
    const metadata = signed(pair.privateKey, publisherKey);

    expectTrustCode(
      () =>
        verifyNativeExtensionDistribution(
          {
            ...metadata,
            signature: tamperSignature(metadata.signature),
          },
          signedDistributionBundle.bundleBytes,
          { trustedPublishers: [publisherKey] },
        ),
      "invalid-signature",
    );
    expectTrustCode(
      () =>
        verifyNativeExtensionDistribution(
          metadata,
          new Uint8Array([...signedDistributionBundle.bundleBytes, 0]),
          { trustedPublishers: [publisherKey] },
        ),
      "bundle-mismatch",
    );
    expectTrustCode(
      () =>
        verifyNativeExtensionDistribution(
          { ...metadata, authorityDigest: "f".repeat(64) },
          signedDistributionBundle.bundleBytes,
          { trustedPublishers: [publisherKey] },
        ),
      "invalid-signature",
    );
  });

  it("fails closed for expiry, signed revocation, and signed delisting", () => {
    const pair = keyPair();
    const publisherKey = publisher(pair.privateKey, "key-1");
    expectTrustCode(
      () =>
        verifyNativeExtensionDistribution(
          signed(pair.privateKey, publisherKey, {
            expiresAt: "2026-05-01T00:00:00.000Z",
          }),
          signedDistributionBundle.bundleBytes,
          { trustedPublishers: [publisherKey] },
        ),
      "expired",
    );
    expectTrustCode(
      () =>
        verifyNativeExtensionDistribution(
          signed(pair.privateKey, publisherKey, { revokedAt: "2026-05-01T00:00:00.000Z" }),
          signedDistributionBundle.bundleBytes,
          { trustedPublishers: [publisherKey] },
        ),
      "revoked",
    );
    expectTrustCode(
      () =>
        verifyNativeExtensionDistribution(
          signed(pair.privateKey, publisherKey, { delistedAt: "2026-05-01T00:00:00.000Z" }),
          signedDistributionBundle.bundleBytes,
          { trustedPublishers: [publisherKey] },
        ),
      "delisted",
    );
  });

  it("accepts a new key only through a valid rotation from a trusted previous key", () => {
    const oldPair = keyPair();
    const newPair = keyPair();
    const oldPublisher = publisher(oldPair.privateKey, "key-1");
    const newPublisher = publisher(newPair.privateKey, "key-2");
    const rotation = signNativeExtensionKeyRotation(
      {
        previous: oldPublisher,
        next: newPublisher,
        effectiveAt: "2026-05-01T00:00:00.000Z",
      },
      oldPair.privateKey,
    );
    const metadata = signed(newPair.privateKey, newPublisher, {
      issuedAt: "2026-05-02T00:00:00.000Z",
      keyRotation: rotation,
    });
    expect(
      verifyNativeExtensionDistribution(metadata, signedDistributionBundle.bundleBytes, {
        trustedPublishers: [oldPublisher],
      }).keyTrust,
    ).toBe("rotated");

    const invalidRotation = {
      ...rotation,
      signature: "A".repeat(86),
    };
    const invalidMetadata = signed(newPair.privateKey, newPublisher, {
      issuedAt: "2026-05-02T00:00:00.000Z",
      keyRotation: invalidRotation,
    });
    expectTrustCode(
      () =>
        verifyNativeExtensionDistribution(invalidMetadata, signedDistributionBundle.bundleBytes, {
          trustedPublishers: [oldPublisher],
        }),
      "key-rotation-invalid",
    );
    // An effectively revoked predecessor is refused by the revocation predicate before the
    // rotation window clauses are consulted at all.
    expectTrustCode(
      () =>
        verifyNativeExtensionDistribution(metadata, signedDistributionBundle.bundleBytes, {
          trustedPublishers: [{ ...oldPublisher, revokedAt: "2026-04-01T00:00:00.000Z" }],
        }),
      "key-revoked",
    );
  });

  it("refuses a rotation whose predecessor revocation is already effective, at the exact instant", () => {
    // This case previously asserted an accept. `issuedAt = effectiveAt = revokedAt` is the single
    // point where the two rotation window clauses do not overlap into a rejection, and revokedAt
    // is public, so a stolen revoked key could mint a permanently trusted successor identity.
    const oldPair = keyPair();
    const newPair = keyPair();
    const oldPublisher = publisher(oldPair.privateKey, "key-1");
    const newPublisher = publisher(newPair.privateKey, "key-2");
    const rotation = signNativeExtensionKeyRotation(
      {
        previous: oldPublisher,
        next: newPublisher,
        effectiveAt: "2026-05-01T00:00:00.000Z",
      },
      oldPair.privateKey,
    );
    const metadata = signed(newPair.privateKey, newPublisher, {
      issuedAt: "2026-05-01T00:00:00.000Z",
      keyRotation: rotation,
    });
    expectTrustCode(
      () =>
        verifyNativeExtensionDistribution(metadata, signedDistributionBundle.bundleBytes, {
          trustedPublishers: [{ ...oldPublisher, revokedAt: "2026-05-01T00:00:00.000Z" }],
        }),
      "key-revoked",
    );
    expectTrustCode(
      () =>
        verifyNativeExtensionDistribution(
          signed(newPair.privateKey, newPublisher, {
            issuedAt: "2026-05-01T00:00:00.000Z",
            keyRotation: { ...rotation, effectiveAt: "2026-04-30T00:00:00.000Z" },
          }),
          signedDistributionBundle.bundleBytes,
          { trustedPublishers: [{ ...oldPublisher, revokedAt: "2026-05-01T00:00:00.000Z" }] },
        ),
      "key-revoked",
    );
    // The rotation path stays open for a predecessor that carries no revocation at all.
    expect(
      verifyNativeExtensionDistribution(metadata, signedDistributionBundle.bundleBytes, {
        trustedPublishers: [oldPublisher],
      }).keyTrust,
    ).toBe("rotated");
  });

  it("rejects every rotation on the predecessor revocation boundary", () => {
    // The whole neighbourhood of revokedAt, not just one side of it. A table assertion names the
    // exact cell that regressed instead of failing on the first throw.
    const revokedAt = "2026-05-01T00:00:00.000Z";
    const boundary = [
      ["T-1ms", "2026-04-30T23:59:59.999Z"],
      ["T", revokedAt],
      ["T+1ms", "2026-05-01T00:00:00.001Z"],
    ] as const;
    const oldPair = keyPair();
    const newPair = keyPair();
    const oldPublisher = publisher(oldPair.privateKey, "key-1");
    const newPublisher = publisher(newPair.privateKey, "key-2");
    const observed: string[] = [];
    for (const [effectiveLabel, effectiveAt] of boundary) {
      for (const [issuedLabel, issuedAt] of boundary) {
        const rotation = signNativeExtensionKeyRotation(
          { previous: oldPublisher, next: newPublisher, effectiveAt },
          oldPair.privateKey,
        );
        const metadata = signed(newPair.privateKey, newPublisher, {
          issuedAt,
          keyRotation: rotation,
        });
        let outcome = "ACCEPTED";
        try {
          verifyNativeExtensionDistribution(metadata, signedDistributionBundle.bundleBytes, {
            trustedPublishers: [{ ...oldPublisher, revokedAt }],
          });
        } catch (error) {
          outcome = (error as { code?: string }).code ?? "unknown-error";
        }
        observed.push(`effectiveAt=${effectiveLabel} issuedAt=${issuedLabel} -> ${outcome}`);
      }
    }
    expect(observed).toEqual([
      "effectiveAt=T-1ms issuedAt=T-1ms -> key-revoked",
      "effectiveAt=T-1ms issuedAt=T -> key-revoked",
      "effectiveAt=T-1ms issuedAt=T+1ms -> key-revoked",
      "effectiveAt=T issuedAt=T-1ms -> key-revoked",
      "effectiveAt=T issuedAt=T -> key-revoked",
      "effectiveAt=T issuedAt=T+1ms -> key-revoked",
      "effectiveAt=T+1ms issuedAt=T-1ms -> key-revoked",
      "effectiveAt=T+1ms issuedAt=T -> key-revoked",
      "effectiveAt=T+1ms issuedAt=T+1ms -> key-revoked",
    ]);
  });

  it("keeps both rotation window clauses live beside the revocation predicate", () => {
    const oldPair = keyPair();
    const newPair = keyPair();
    const oldPublisher = publisher(oldPair.privateKey, "key-1");
    const newPublisher = publisher(newPair.privateKey, "key-2");
    const rotate = (effectiveAt: string) =>
      signNativeExtensionKeyRotation(
        { previous: oldPublisher, next: newPublisher, effectiveAt },
        oldPair.privateKey,
      );

    // Revocation scheduled after `now`: the revoked-predecessor predicate deliberately holds its
    // fire, so the first window clause is the check that rejects here.
    expectTrustCode(
      () =>
        verifyNativeExtensionDistribution(
          signed(newPair.privateKey, newPublisher, {
            issuedAt: "2026-05-02T00:00:00.000Z",
            keyRotation: rotate("2026-05-01T00:00:00.000Z"),
          }),
          signedDistributionBundle.bundleBytes,
          { trustedPublishers: [{ ...oldPublisher, revokedAt: "2026-07-01T00:00:00.000Z" }] },
        ),
      "key-rotation-invalid",
    );

    // No revocation at all: the second window clause still rejects a rotation that is not yet
    // effective, and one that predates its own effectiveAt.
    expectTrustCode(
      () =>
        verifyNativeExtensionDistribution(
          signed(newPair.privateKey, newPublisher, {
            issuedAt: "2026-07-02T00:00:00.000Z",
            keyRotation: rotate("2026-07-01T00:00:00.000Z"),
          }),
          signedDistributionBundle.bundleBytes,
          { trustedPublishers: [oldPublisher] },
        ),
      "key-rotation-invalid",
    );
    expectTrustCode(
      () =>
        verifyNativeExtensionDistribution(
          signed(newPair.privateKey, newPublisher, {
            issuedAt: "2026-04-01T00:00:00.000Z",
            keyRotation: rotate("2026-05-01T00:00:00.000Z"),
          }),
          signedDistributionBundle.bundleBytes,
          { trustedPublishers: [oldPublisher] },
        ),
      "key-rotation-invalid",
    );
  });

  it("refuses to install a forged successor minted from a revoked anchor", async () => {
    const revokedAt = "2026-05-01T00:00:00.000Z";
    const stolenPair = keyPair();
    const forgedPair = keyPair();
    const stolenPublisher = publisher(stolenPair.privateKey, "key-1");
    const forgedPublisher = publisher(forgedPair.privateKey, "key-2");
    // Everything an attacker holding the revoked key needs: the key itself and the public
    // revokedAt value. Both timestamps are pinned to it.
    const forgedRotation = signNativeExtensionKeyRotation(
      { previous: stolenPublisher, next: forgedPublisher, effectiveAt: revokedAt },
      stolenPair.privateKey,
    );
    const forgedMetadata = signed(forgedPair.privateKey, forgedPublisher, {
      issuedAt: revokedAt,
      keyRotation: forgedRotation,
    });
    const revokedAnchors = [{ ...stolenPublisher, revokedAt }];

    expectTrustCode(
      () =>
        verifyNativeExtensionDistribution(forgedMetadata, signedDistributionBundle.bundleBytes, {
          trustedPublishers: revokedAnchors,
        }),
      "key-revoked",
    );

    const host = new NativeExtensionHost({ ports: { vault: vaultPort } });
    expect(() =>
      host.install(signedDistributionBundle, {
        mode: "trusted-distribution",
        metadata: forgedMetadata,
        trustedPublishers: revokedAnchors,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "distribution-untrusted",
        message: "Publisher key is revoked.",
      }),
    );
    // Nothing was registered by the refused install.
    expect(() => host.review(forgedMetadata.manifest.id)).toThrow(
      expect.objectContaining({ code: "not-installed" }),
    );
    // Control: the identical record installs against the same anchor without the revocation, so
    // the refusal above is the revocation check and not a signature, freshness, or bytes failure.
    expect(
      host.install(signedDistributionBundle, {
        mode: "trusted-distribution",
        metadata: forgedMetadata,
        trustedPublishers: [stolenPublisher],
      }).distributionTrust,
    ).toBe("trusted-distribution");
    await host.close();
  });

  it("verifies a deterministic mirror index and requires exact bundle bytes", () => {
    const pair = keyPair();
    const publisherKey = publisher(pair.privateKey, "key-1");
    const metadata = signed(pair.privateKey, publisherKey);
    const index = createNativeExtensionMarketplaceIndex({
      generatedAt: "2026-06-01T00:00:00.000Z",
      expiresAt: "2026-06-30T00:00:00.000Z",
      entries: [metadata],
    });
    expectTrustCode(
      () =>
        verifyNativeExtensionMarketplaceIndex(index, {
          trustedPublishers: [publisherKey],
        }),
      "catalog-untrusted",
    );
    expectTrustCode(
      () =>
        createNativeExtensionMarketplaceIndex({
          generatedAt: "2026-06-01T00:00:00.000Z",
          expiresAt: "2026-08-01T00:00:00.000Z",
          entries: [metadata],
        }),
      "index-expired",
    );
    expectTrustCode(
      () =>
        parseNativeExtensionMarketplaceIndex({
          ...index,
          entries: [metadata, metadata],
        }),
      "duplicate-entry",
    );
    vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
    expectTrustCode(
      () =>
        verifyNativeExtensionMarketplaceIndex(index, {
          trustedPublishers: [publisherKey],
        }),
      "catalog-untrusted",
    );
  });

  it("makes host install mode explicit and keeps unsigned development separate", async () => {
    const pair = keyPair();
    const publisherKey = publisher(pair.privateKey, "key-1");
    const metadata = signed(pair.privateKey, publisherKey);
    const host = new NativeExtensionHost({ ports: { vault: vaultPort } });

    expect(() => host.install(signedDistributionBundle)).toThrow(
      expect.objectContaining({ code: "distribution-untrusted" }),
    );
    expect(() =>
      host.install(signedDistributionBundle, { mode: "trusted-distribution", metadata }),
    ).toThrow(expect.objectContaining({ code: "distribution-untrusted" }));
    const trustedReview = host.install(signedDistributionBundle, {
      mode: "trusted-distribution",
      metadata,
      trustedPublishers: [publisherKey],
    });
    expect(trustedReview).toMatchObject({
      extensionId: "threadleaf.signed-summary",
      distributionTrust: "trusted-distribution",
      publisherFingerprint: publisherKey.fingerprint,
    });
    const reviewHost = new NativeExtensionHost({ ports: { vault: vaultPort } });
    expect(
      reviewHost.reviewDistribution(signedDistributionBundle, {
        metadata,
        trustedPublishers: [publisherKey],
      }).extensionId,
    ).toBe("threadleaf.signed-summary");

    const developmentHost = createNativeExtensionTestHost({ ports: { vault: vaultPort } });
    expect(developmentHost.register(signedDistributionBundle)).toMatchObject({
      extensionId: "threadleaf.signed-summary",
      distributionTrust: "unsigned-development",
      publisherFingerprint: null,
    });
    await host.close();
    await reviewHost.close();
    await developmentHost.close();
  });

  it("rejects duplicate or conflicting offline trust anchors", () => {
    const pair = keyPair();
    const otherPair = keyPair();
    const publisherKey = publisher(pair.privateKey, "key-1");
    const conflictingKey = {
      ...publisher(otherPair.privateKey, "key-1"),
      publisherId: "fixture.publisher",
    };
    const metadata = signed(pair.privateKey, publisherKey);

    expectTrustCode(
      () =>
        verifyNativeExtensionDistribution(metadata, signedDistributionBundle.bundleBytes, {
          trustedPublishers: [publisherKey, publisherKey],
        }),
      "duplicate-trust-anchor",
    );
    expectTrustCode(
      () =>
        verifyNativeExtensionDistribution(metadata, signedDistributionBundle.bundleBytes, {
          trustedPublishers: [publisherKey, conflictingKey],
        }),
      "duplicate-trust-anchor",
    );
  });

  it("persists signed metadata identity and revalidates it after restore and lifecycle changes", async () => {
    const pair = keyPair();
    const publisherKey = publisher(pair.privateKey, "key-1");
    const metadata = signed(pair.privateKey, publisherKey);
    const store = new InMemoryNativeExtensionGrantStore();
    const host = new NativeExtensionHost({ ports: { vault: vaultPort }, grantStore: store });
    host.install(signedDistributionBundle, {
      mode: "trusted-distribution",
      metadata,
      trustedPublishers: [publisherKey],
    });
    await host.grant("vault-a", metadata.manifest.id);
    const persisted = await store.get("vault-a", metadata.manifest.id);
    expect(persisted).toMatchObject({
      grantVersion: 2,
      distributionTrust: "trusted-distribution",
      metadataSha256: nativeExtensionSignedManifestSha256(metadata),
      publisherId: publisherKey.publisherId,
      publisherKeyId: publisherKey.keyId,
      publisherFingerprint: publisherKey.fingerprint,
      metadataExpiresAt: metadata.expiresAt,
      metadataRevokedAt: null,
      metadataDelistedAt: null,
    });
    await host.close();

    const restored = new NativeExtensionHost({ ports: { vault: vaultPort }, grantStore: store });
    const review = restored.install(signedDistributionBundle, {
      mode: "trusted-distribution",
      metadata,
      trustedPublishers: [publisherKey],
    });
    expect(review.trustProvenance).toMatchObject({
      distributionTrust: "trusted-distribution",
      metadataSha256: persisted?.metadataSha256,
      publisherId: publisherKey.publisherId,
      publisherKeyId: publisherKey.keyId,
    });
    expect(await restored.inspect("vault-a", metadata.manifest.id)).toMatchObject({
      state: "granted",
      metadataSha256: persisted?.metadataSha256,
      publisherId: publisherKey.publisherId,
      publisherKeyId: publisherKey.keyId,
    });
    if (!persisted) {
      throw new Error("grant was not persisted");
    }
    await store.put({ ...persisted, metadataSha256: "f".repeat(64) });
    expect(await restored.inspect("vault-a", metadata.manifest.id)).toMatchObject({
      state: "stale",
    });
    await store.put(persisted);

    vi.setSystemTime(new Date("2027-01-01T00:00:00.000Z"));
    await expectHostCode(
      restored.execute("vault-a", metadata.manifest.id, undefined),
      "distribution-untrusted",
    );
    await restored.close();
  });

  it("binds a custom signed package-tree identity through host revalidation and grants", async () => {
    const pair = keyPair();
    const publisherKey = publisher(pair.privateKey, "key-1");
    const packageTreeSha256 = "e".repeat(64);
    const metadata = signNativeExtensionManifest(
      {
        manifest: signedDistributionBundle.manifest,
        bundleBytes: signedDistributionBundle.bundleBytes,
        packageTreeSha256,
        publisher: publisherKey,
        issuedAt,
        expiresAt,
      },
      pair.privateKey,
    );
    const host = new NativeExtensionHost({
      ports: { vault: vaultPort },
      now: () => now,
    });
    const review = host.install(
      { ...signedDistributionBundle, packageTreeSha256 },
      { mode: "trusted-distribution", metadata, trustedPublishers: [publisherKey] },
    );
    expect(review.packageTreeSha256).toBe(packageTreeSha256);
    expect(host.review(metadata.manifest.id).packageTreeSha256).toBe(packageTreeSha256);
    await expect(host.grant("vault-a", metadata.manifest.id)).resolves.toMatchObject({
      packageTreeSha256,
    });
    await host.close();
  });

  it("never lets a production host execute a caller-injected function", async () => {
    const pair = keyPair();
    const publisherKey = publisher(pair.privateKey, "key-1");
    const metadata = signed(pair.privateKey, publisherKey);
    const host = new NativeExtensionHost({ ports: { vault: vaultPort } });
    expect(() => host.register(signedDistributionBundle)).toThrow(
      expect.objectContaining({ code: "distribution-untrusted" }),
    );
    host.install(signedDistributionBundle, {
      mode: "trusted-distribution",
      metadata,
      trustedPublishers: [publisherKey],
    });
    await host.grant("vault-a", metadata.manifest.id);
    await expectHostCode(
      host.execute("vault-a", metadata.manifest.id, undefined),
      "runtime-unavailable",
    );
    await host.close();
  });

  it("rechecks signed revocation and delisting at execution time", async () => {
    const pair = keyPair();
    const publisherKey = publisher(pair.privateKey, "key-1");
    const metadata = signed(pair.privateKey, publisherKey, {
      revokedAt: "2026-06-15T00:00:00.000Z",
      delistedAt: "2026-06-20T00:00:00.000Z",
    });
    const host = new NativeExtensionHost({ ports: { vault: vaultPort } });
    host.install(signedDistributionBundle, {
      mode: "trusted-distribution",
      metadata,
      trustedPublishers: [publisherKey],
    });
    await host.grant("vault-a", metadata.manifest.id);
    vi.setSystemTime(new Date("2026-06-16T00:00:00.000Z"));
    await expectHostCode(
      host.execute("vault-a", metadata.manifest.id, undefined),
      "distribution-untrusted",
    );
    await host.close();
  });

  it("rejects backdated rotations from a predecessor revoked by the trust root", () => {
    const oldPair = keyPair();
    const newPair = keyPair();
    const oldPublisher = publisher(oldPair.privateKey, "key-1");
    const newPublisher = publisher(newPair.privateKey, "key-2");
    const rotation = signNativeExtensionKeyRotation(
      {
        previous: oldPublisher,
        next: newPublisher,
        effectiveAt: "2026-04-01T00:00:00.000Z",
      },
      oldPair.privateKey,
    );
    const metadata = signed(newPair.privateKey, newPublisher, {
      issuedAt: "2026-06-01T00:00:00.000Z",
      keyRotation: rotation,
    });
    // Backdating is still refused here, now by the stronger revoked-predecessor predicate. The
    // backdating clause itself is covered against an unrevoked anchor in the window-clause case.
    expectTrustCode(
      () =>
        verifyNativeExtensionDistribution(metadata, signedDistributionBundle.bundleBytes, {
          trustedPublishers: [{ ...oldPublisher, revokedAt: "2026-05-01T00:00:00.000Z" }],
        }),
      "key-revoked",
    );
  });

  it("uses exact canonical Ed25519 SPKI and signature bounds", () => {
    const pair = keyPair();
    const publisherKey = publisher(pair.privateKey, "key-1");
    expect(publisherKey.publicKey).toHaveLength(59);
    expect(signed(pair.privateKey, publisherKey).signature).toHaveLength(86);
    const metadata = signed(pair.privateKey, publisherKey);
    expectTrustCode(
      () =>
        verifyNativeExtensionDistribution(
          { ...metadata, signature: `${metadata.signature}A` },
          signedDistributionBundle.bundleBytes,
          { trustedPublishers: [publisherKey] },
        ),
      "invalid-metadata",
    );
    expectTrustCode(
      () =>
        verifyNativeExtensionDistribution(
          {
            ...metadata,
            publisher: { ...publisherKey, publicKey: `${publisherKey.publicKey}A` },
          },
          signedDistributionBundle.bundleBytes,
          { trustedPublishers: [publisherKey] },
        ),
      "invalid-publisher-key",
    );
  });

  it("uses stable sorted-key canonical encoding for signatures and hashes", () => {
    expect(
      canonicalizeNativeExtensionTrustMetadata({ z: 1, a: { y: 2, x: true }, list: ["b", "a"] }),
    ).toBe('{"a":{"x":true,"y":2},"list":["b","a"],"z":1}');
    const pair = keyPair();
    const publisherKey = publisher(pair.privateKey, "key-1");
    const metadata = signed(pair.privateKey, publisherKey);
    const reordered = {
      signature: metadata.signature,
      publisher: metadata.publisher,
      expiresAt: metadata.expiresAt,
      issuedAt: metadata.issuedAt,
      authorityDigest: metadata.authorityDigest,
      bundleSha256: metadata.bundleSha256,
      packageTreeSha256: metadata.packageTreeSha256,
      manifest: metadata.manifest,
      distributionVersion: metadata.distributionVersion,
    };
    expect(
      verifyNativeExtensionDistribution(reordered, signedDistributionBundle.bundleBytes, {
        trustedPublishers: [publisherKey],
      }).metadataSha256,
    ).toBe(nativeExtensionSignedManifestSha256(metadata));
  });

  it("verifies a signed catalog, persists monotonic revision/hash, and rejects rollback, freeze, and omission", () => {
    const publisherPair = keyPair();
    const rootPair = keyPair();
    const publisherKey = publisher(publisherPair.privateKey, "publisher-1");
    const rootKey = nativeExtensionPublisherKeyFromKeyObject({
      publisherId: "threadleaf.catalog",
      keyId: "root-1",
      key: rootPair.privateKey,
    });
    const metadata = signed(publisherPair.privateKey, publisherKey);
    const stateStore = new InMemoryNativeExtensionMarketplaceCatalogStateStore();
    const options = {
      trustedPublishers: [publisherKey],
      trustedCatalogRoots: [rootKey],
      bundleBytesByEntry: new Map([
        [
          `${metadata.manifest.id}\u0000${metadata.manifest.version}`,
          signedDistributionBundle.bundleBytes,
        ],
      ]),
      stateStore,
    };
    const catalog = createNativeExtensionMarketplaceCatalog(
      {
        revision: 1,
        generatedAt: "2026-06-01T00:00:00.000Z",
        expiresAt: "2026-06-30T00:00:00.000Z",
        catalogRoot: rootKey,
        entries: [metadata],
        revocations: [],
        delistings: [],
        successorPath: [],
        publisherSuccessors: [],
      },
      rootPair.privateKey,
    );
    expect(verifyNativeExtensionMarketplaceCatalog(catalog, options)).toMatchObject([
      {
        marketplaceIndexTrust: "signed-catalog",
        marketplaceCatalogRevision: 1,
        marketplaceCatalogSha256: nativeExtensionMarketplaceCatalogSha256(catalog),
        marketplaceCatalogRootFingerprint: rootKey.fingerprint,
      },
    ]);
    expect(stateStore.get()).toMatchObject({
      revision: 1,
      catalogSha256: nativeExtensionMarketplaceCatalogSha256(catalog),
    });
    const frozen = createNativeExtensionMarketplaceCatalog(
      { ...catalog, revision: 2 },
      rootPair.privateKey,
    );
    expectTrustCode(
      () => verifyNativeExtensionMarketplaceCatalog(frozen, options),
      "catalog-freeze",
    );
    const replay = createNativeExtensionMarketplaceCatalog(
      {
        revision: 1,
        generatedAt: "2026-06-01T00:00:00.000Z",
        expiresAt: "2026-06-29T00:00:00.000Z",
        catalogRoot: rootKey,
        entries: [metadata],
        revocations: [],
        delistings: [],
        successorPath: [],
        publisherSuccessors: [],
      },
      rootPair.privateKey,
    );
    expectTrustCode(
      () => verifyNativeExtensionMarketplaceCatalog(replay, options),
      "catalog-replay",
    );
    const omitted = createNativeExtensionMarketplaceCatalog(
      {
        revision: 2,
        generatedAt: "2026-06-02T00:00:00.000Z",
        expiresAt: "2026-07-01T00:00:00.000Z",
        catalogRoot: rootKey,
        entries: [],
        revocations: [],
        delistings: [],
        successorPath: [],
        publisherSuccessors: [],
      },
      rootPair.privateKey,
    );
    vi.setSystemTime(new Date("2026-06-03T00:00:00.000Z"));
    expectTrustCode(
      () => verifyNativeExtensionMarketplaceCatalog(omitted, options),
      "catalog-omission",
    );
    expectTrustCode(
      () =>
        createNativeExtensionMarketplaceCatalog(
          {
            ...omitted,
            revocations: [
              {
                extensionId: metadata.manifest.id,
                version: metadata.manifest.version,
                at: "2026-07-01T00:00:00.000Z",
              },
            ],
          },
          rootPair.privateKey,
        ),
      "catalog-state-mismatch",
    );
  });

  it("rejects catalog freshness forged by the signed generated and expiry fields", () => {
    const publisherPair = keyPair();
    const rootPair = keyPair();
    const publisherKey = publisher(publisherPair.privateKey, "publisher-1");
    const rootKey = nativeExtensionPublisherKeyFromKeyObject({
      publisherId: "threadleaf.catalog",
      keyId: "root-1",
      key: rootPair.privateKey,
    });
    const metadata = signed(publisherPair.privateKey, publisherKey);
    const base = {
      revision: 1,
      catalogRoot: rootKey,
      entries: [metadata],
      revocations: [],
      delistings: [],
      successorPath: [],
      publisherSuccessors: [],
    };
    const overAge = createNativeExtensionMarketplaceCatalog(
      {
        ...base,
        generatedAt: "2026-06-01T00:00:00.000Z",
        expiresAt: "2026-08-01T00:00:00.000Z",
      },
      rootPair.privateKey,
    );
    const options = {
      trustedPublishers: [publisherKey],
      trustedCatalogRoots: [rootKey],
      bundleBytesByEntry: new Map([
        [
          `${metadata.manifest.id}\u0000${metadata.manifest.version}`,
          signedDistributionBundle.bundleBytes,
        ],
      ]),
    };
    expectTrustCode(
      () => verifyNativeExtensionMarketplaceCatalog(overAge, options),
      "catalog-expired",
    );
    const future = createNativeExtensionMarketplaceCatalog(
      {
        ...base,
        generatedAt: "2026-07-01T00:00:00.000Z",
        expiresAt: "2026-07-31T00:00:00.000Z",
      },
      rootPair.privateKey,
    );
    expectTrustCode(
      () => verifyNativeExtensionMarketplaceCatalog(future, options),
      "catalog-expired",
    );
  });

  it("retains signed-catalog provenance through host review and revalidation", async () => {
    const publisherPair = keyPair();
    const rootPair = keyPair();
    const publisherKey = publisher(publisherPair.privateKey, "publisher-1");
    const rootKey = nativeExtensionPublisherKeyFromKeyObject({
      publisherId: "threadleaf.catalog",
      keyId: "root-1",
      key: rootPair.privateKey,
    });
    const metadata = signed(publisherPair.privateKey, publisherKey);
    const catalog = createNativeExtensionMarketplaceCatalog(
      {
        revision: 1,
        generatedAt: "2026-06-01T00:00:00.000Z",
        expiresAt: "2026-06-30T00:00:00.000Z",
        catalogRoot: rootKey,
        entries: [metadata],
        revocations: [],
        delistings: [],
        successorPath: [],
        publisherSuccessors: [],
      },
      rootPair.privateKey,
    );
    const host = new NativeExtensionHost({ ports: { vault: vaultPort } });
    const trustAnchors = {
      version: 1 as const,
      publishers: [publisherKey],
      catalogRoots: [rootKey],
    };
    const review = host.install(signedDistributionBundle, {
      mode: "trusted-distribution",
      metadata,
      trustedPublishers: trustAnchors,
      marketplaceCatalog: catalog,
      catalogStateStore: new InMemoryNativeExtensionMarketplaceCatalogStateStore(),
    });
    expect(review.trustProvenance).toMatchObject({
      marketplaceIndex: "signed-catalog",
      marketplaceCatalogRevision: 1,
      marketplaceCatalogSha256: nativeExtensionMarketplaceCatalogSha256(catalog),
      marketplaceCatalogRootFingerprint: rootKey.fingerprint,
    });
    expect(host.review(metadata.manifest.id).trustProvenance).toMatchObject({
      marketplaceIndex: "signed-catalog",
      marketplaceCatalogRevision: 1,
      marketplaceCatalogSha256: nativeExtensionMarketplaceCatalogSha256(catalog),
      marketplaceCatalogRootFingerprint: rootKey.fingerprint,
    });
    await expect(host.grant("vault-a", metadata.manifest.id)).resolves.toMatchObject({
      trustProvenance: {
        marketplaceIndex: "signed-catalog",
        marketplaceCatalogRevision: 1,
        marketplaceCatalogSha256: nativeExtensionMarketplaceCatalogSha256(catalog),
        marketplaceCatalogRootFingerprint: rootKey.fingerprint,
      },
    });
    const mismatchHost = new NativeExtensionHost({ ports: { vault: vaultPort } });
    expect(() =>
      mismatchHost.install(
        {
          ...signedDistributionBundle,
          manifest: { ...signedDistributionBundle.manifest, name: "forged display" },
        },
        {
          mode: "trusted-distribution",
          metadata,
          trustedPublishers: trustAnchors,
          marketplaceCatalog: catalog,
          catalogStateStore: new InMemoryNativeExtensionMarketplaceCatalogStateStore(),
        },
      ),
    ).toThrow(expect.objectContaining({ code: "distribution-untrusted" }));
    await mismatchHost.close();
    await host.close();
  });

  it("persists accepted catalog state atomically and rejects state rollback", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "threadleaf-catalog-state-"));
    try {
      const state = {
        stateVersion: 1 as const,
        revision: 4,
        catalogSha256: "a".repeat(64),
        generatedAt: "2026-06-01T00:00:00.000Z",
        expiresAt: "2026-06-30T00:00:00.000Z",
        entryKeys: ["threadleaf.signed-summary\u00001.0.0"],
        successorHashes: ["b".repeat(64)],
      };
      const filePath = path.join(directory, "catalog-state.json");
      new FileNativeExtensionMarketplaceCatalogStateStore(filePath).put(state);
      const restored = new FileNativeExtensionMarketplaceCatalogStateStore(filePath);
      expect(restored.get()).toEqual(state);
      expect(() => restored.put({ ...state, revision: 3 })).toThrow(/move backwards/u);
      expect(() => restored.put({ ...state, entryIdentities: [] })).toThrow(/identities/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requires a root-owned successor path for rotated catalog roots and publisher keys", () => {
    const oldRootPair = keyPair();
    const newRootPair = keyPair();
    const oldRoot = nativeExtensionPublisherKeyFromKeyObject({
      publisherId: "threadleaf.catalog",
      keyId: "root-1",
      key: oldRootPair.privateKey,
    });
    const newRoot = nativeExtensionPublisherKeyFromKeyObject({
      publisherId: "threadleaf.catalog",
      keyId: "root-2",
      key: newRootPair.privateKey,
    });
    const successor = signNativeExtensionMarketplaceSuccessor(
      {
        previous: oldRoot,
        next: newRoot,
        issuedAt: "2026-05-01T00:00:00.000Z",
        effectiveAt: "2026-05-02T00:00:00.000Z",
      },
      oldRootPair.privateKey,
    );
    const publisherPair = keyPair();
    const nextPublisherPair = keyPair();
    const previousPublisher = publisher(publisherPair.privateKey, "publisher-1");
    const nextPublisher = publisher(nextPublisherPair.privateKey, "publisher-2");
    const rotation = signNativeExtensionKeyRotation(
      { previous: previousPublisher, next: nextPublisher, effectiveAt: "2026-05-10T00:00:00.000Z" },
      publisherPair.privateKey,
    );
    const metadata = signed(nextPublisherPair.privateKey, nextPublisher, {
      issuedAt: "2026-05-11T00:00:00.000Z",
      keyRotation: rotation,
    });
    const publisherSuccessor = signNativeExtensionMarketplaceSuccessor(
      {
        previous: previousPublisher,
        next: nextPublisher,
        issuedAt: "2026-05-09T00:00:00.000Z",
        effectiveAt: "2026-05-10T00:00:00.000Z",
      },
      newRootPair.privateKey,
    );
    const catalog = createNativeExtensionMarketplaceCatalog(
      {
        revision: 1,
        generatedAt: "2026-06-01T00:00:00.000Z",
        expiresAt: "2026-06-30T00:00:00.000Z",
        catalogRoot: newRoot,
        entries: [metadata],
        revocations: [],
        delistings: [],
        successorPath: [successor],
        publisherSuccessors: [publisherSuccessor],
      },
      newRootPair.privateKey,
    );
    const key = `${metadata.manifest.id}\u0000${metadata.manifest.version}`;
    const stateStore = new InMemoryNativeExtensionMarketplaceCatalogStateStore();
    expect(
      verifyNativeExtensionMarketplaceCatalog(catalog, {
        trustedPublishers: [previousPublisher],
        trustedCatalogRoots: [oldRoot],
        bundleBytesByEntry: new Map([[key, signedDistributionBundle.bundleBytes]]),
        stateStore,
      }),
    ).toMatchObject([{ marketplaceCatalogRevision: 1, keyTrust: "rotated" }]);
    expect(
      verifyNativeExtensionMarketplaceCatalog(catalog, {
        trustedPublishers: [{ ...previousPublisher, revokedAt: "2026-05-01T00:00:00.000Z" }],
        trustedCatalogRoots: [oldRoot],
        bundleBytesByEntry: new Map([[key, signedDistributionBundle.bundleBytes]]),
        stateStore,
      }),
    ).toMatchObject([{ marketplaceCatalogRevision: 1, keyTrust: "rotated" }]);
    expectTrustCode(
      () =>
        verifyNativeExtensionMarketplaceCatalog(catalog, {
          trustedPublishers: [previousPublisher],
          trustedCatalogRoots: [{ ...oldRoot, revokedAt: "2026-05-01T00:00:00.000Z" }],
          bundleBytesByEntry: new Map([[key, signedDistributionBundle.bundleBytes]]),
        }),
      "catalog-successor-invalid",
    );
    expectTrustCode(
      () =>
        verifyNativeExtensionMarketplaceCatalog(catalog, {
          trustedPublishers: [{ ...previousPublisher, revokedAt: "2026-05-01T00:00:00.000Z" }],
          trustedCatalogRoots: [oldRoot],
          bundleBytesByEntry: new Map([[key, signedDistributionBundle.bundleBytes]]),
        }),
      "catalog-successor-invalid",
    );
  });

  it("rejects same-version package digest rebinding across catalog revisions", () => {
    const publisherPair = keyPair();
    const rootPair = keyPair();
    const publisherKey = publisher(publisherPair.privateKey, "publisher-1");
    const rootKey = nativeExtensionPublisherKeyFromKeyObject({
      publisherId: "threadleaf.catalog",
      keyId: "root-1",
      key: rootPair.privateKey,
    });
    const changedBytes = new Uint8Array([...signedDistributionBundle.bundleBytes, 7]);
    const first = signed(publisherPair.privateKey, publisherKey);
    const rebound = signNativeExtensionManifest(
      {
        manifest: signedDistributionBundle.manifest,
        bundleBytes: changedBytes,
        publisher: publisherKey,
        issuedAt,
        expiresAt,
      },
      publisherPair.privateKey,
    );
    const stateStore = new InMemoryNativeExtensionMarketplaceCatalogStateStore();
    const common = {
      catalogRoot: rootKey,
      revocations: [],
      delistings: [],
      successorPath: [],
      publisherSuccessors: [],
    };
    const firstCatalog = createNativeExtensionMarketplaceCatalog(
      {
        ...common,
        revision: 1,
        generatedAt: "2026-06-01T00:00:00.000Z",
        expiresAt: "2026-06-30T00:00:00.000Z",
        entries: [first],
      },
      rootPair.privateKey,
    );
    const options = {
      trustedPublishers: [publisherKey],
      trustedCatalogRoots: [rootKey],
      stateStore,
      now: "2026-06-03T00:00:00.000Z",
      bundleBytesByEntry: new Map([
        [
          `${first.manifest.id}\u0000${first.manifest.version}`,
          signedDistributionBundle.bundleBytes,
        ],
      ]),
    };
    verifyNativeExtensionMarketplaceCatalog(firstCatalog, options);
    const reboundCatalog = createNativeExtensionMarketplaceCatalog(
      {
        ...common,
        revision: 2,
        generatedAt: "2026-06-02T00:00:00.000Z",
        expiresAt: "2026-07-01T00:00:00.000Z",
        entries: [rebound],
      },
      rootPair.privateKey,
    );
    expectTrustCode(
      () =>
        verifyNativeExtensionMarketplaceCatalog(reboundCatalog, {
          ...options,
          bundleBytesByEntry: new Map([
            [`${rebound.manifest.id}\u0000${rebound.manifest.version}`, changedBytes],
          ]),
        }),
      "catalog-rebind",
    );
  });

  it("keeps catalog tombstones irreversible and rejects re-add", () => {
    const publisherPair = keyPair();
    const rootPair = keyPair();
    const publisherKey = publisher(publisherPair.privateKey, "publisher-1");
    const rootKey = nativeExtensionPublisherKeyFromKeyObject({
      publisherId: "threadleaf.catalog",
      keyId: "root-1",
      key: rootPair.privateKey,
    });
    const metadata = signed(publisherPair.privateKey, publisherKey);
    const key = `${metadata.manifest.id}\u0000${metadata.manifest.version}`;
    const stateStore = new InMemoryNativeExtensionMarketplaceCatalogStateStore();
    const common = {
      catalogRoot: rootKey,
      successorPath: [],
      publisherSuccessors: [],
    };
    const options = {
      trustedPublishers: [publisherKey],
      trustedCatalogRoots: [rootKey],
      stateStore,
      now: "2026-06-03T00:00:00.000Z",
      bundleBytesByEntry: new Map([[key, signedDistributionBundle.bundleBytes]]),
    };
    const first = createNativeExtensionMarketplaceCatalog(
      {
        ...common,
        revision: 1,
        generatedAt: "2026-06-01T00:00:00.000Z",
        expiresAt: "2026-06-30T00:00:00.000Z",
        entries: [metadata],
        revocations: [],
        delistings: [],
      },
      rootPair.privateKey,
    );
    verifyNativeExtensionMarketplaceCatalog(first, options);
    const tombstoned = createNativeExtensionMarketplaceCatalog(
      {
        ...common,
        revision: 2,
        generatedAt: "2026-06-02T00:00:00.000Z",
        expiresAt: "2026-07-01T00:00:00.000Z",
        entries: [],
        revocations: [
          {
            extensionId: metadata.manifest.id,
            version: metadata.manifest.version,
            at: "2026-06-02T00:00:00.000Z",
          },
        ],
        delistings: [],
      },
      rootPair.privateKey,
    );
    verifyNativeExtensionMarketplaceCatalog(tombstoned, {
      ...options,
      bundleBytesByEntry: new Map(),
    });
    const persistedTombstone = stateStore.get()?.tombstones?.[0];
    if (!persistedTombstone) throw new Error("catalog tombstone was not persisted");
    expect(stateStore.get()?.tombstones).toHaveLength(1);
    const changedTombstone = createNativeExtensionMarketplaceCatalog(
      {
        ...common,
        revision: 3,
        generatedAt: "2026-06-03T00:00:00.000Z",
        expiresAt: "2026-07-02T00:00:00.000Z",
        entries: [],
        revocations: [],
        delistings: [],
        tombstones: [{ ...persistedTombstone, reason: "changed after acceptance" }],
      },
      rootPair.privateKey,
    );
    expectTrustCode(
      () =>
        verifyNativeExtensionMarketplaceCatalog(changedTombstone, {
          ...options,
          bundleBytesByEntry: new Map(),
        }),
      "catalog-rebind",
    );
    const readded = createNativeExtensionMarketplaceCatalog(
      {
        ...common,
        revision: 4,
        generatedAt: "2026-06-03T00:00:00.000Z",
        expiresAt: "2026-07-02T00:00:00.000Z",
        entries: [metadata],
        revocations: [],
        delistings: [],
      },
      rootPair.privateKey,
    );
    expectTrustCode(
      () => verifyNativeExtensionMarketplaceCatalog(readded, options),
      "catalog-tombstoned",
    );
  });

  it("uses file-state compare-and-swap to reject catalog revision interleaving", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "threadleaf-catalog-cas-"));
    try {
      const filePath = path.join(directory, "catalog-state.json");
      const first = new FileNativeExtensionMarketplaceCatalogStateStore(filePath);
      const second = new FileNativeExtensionMarketplaceCatalogStateStore(filePath);
      const initial = {
        stateVersion: 1 as const,
        revision: 1,
        catalogSha256: "a".repeat(64),
        generatedAt: "2026-06-01T00:00:00.000Z",
        expiresAt: "2026-06-30T00:00:00.000Z",
        entryKeys: [],
        successorHashes: [],
        entryIdentities: [],
        tombstones: [],
      };
      first.put(initial);
      const expected = second.get()?.catalogSha256 ?? null;
      const next = {
        ...initial,
        revision: 2,
        catalogSha256: "b".repeat(64),
        generatedAt: "2026-06-02T00:00:00.000Z",
      };
      first.compareAndSwap(expected, next);
      expect(() =>
        second.compareAndSwap(expected, { ...next, catalogSha256: "c".repeat(64) }),
      ).toThrow(/compare-and-swap lost an update/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves a revoke when a stale grant save interleaves", async () => {
    vi.useRealTimers();
    const directory = mkdtempSync(path.join(os.tmpdir(), "threadleaf-grant-cas-"));
    try {
      const filePath = path.join(directory, "grants.json");
      const saver = new FileNativeExtensionGrantStore(filePath);
      const revoker = new FileNativeExtensionGrantStore(filePath);
      const grant = {
        grantVersion: 2 as const,
        vaultId: "constructor",
        extensionId: "toString",
        bundleSha256: "a".repeat(64),
        packageTreeSha256: "a".repeat(64),
        authorityDigest: "b".repeat(64),
        distributionTrust: "trusted-distribution" as const,
        metadataSha256: "c".repeat(64),
        publisherId: "fixture.publisher",
        publisherKeyId: "key-1",
        publisherFingerprint: `sha256:${"d".repeat(64)}`,
        metadataIssuedAt: issuedAt,
        metadataExpiresAt: expiresAt,
        metadataRevokedAt: null,
        metadataDelistedAt: null,
        marketplaceCatalogRevision: 1,
        marketplaceCatalogSha256: "e".repeat(64),
        marketplaceCatalogRootFingerprint: `sha256:${"f".repeat(64)}`,
        capabilities: [],
        grantedAt: issuedAt,
      };
      await saver.put(grant);
      await Promise.all([
        revoker.revoke({ ...grant, revokedAt: "2026-06-02T00:00:00.000Z" }),
        saver.put({ ...grant, capabilities: ["vault.read"] }),
      ]);
      expect(await saver.get("constructor", grant.extensionId)).toMatchObject({
        revokedAt: "2026-06-02T00:00:00.000Z",
      });
      const persisted = readFileSync(filePath);
      writeFileSync(filePath, "{", "utf8");
      await expect(saver.put(grant)).rejects.toThrow(/not valid JSON/u);
      writeFileSync(filePath, persisted);
      await expect(saver.put(grant)).resolves.toBeUndefined();
      expect(await saver.get("constructor", grant.extensionId)).toMatchObject({
        revokedAt: "2026-06-02T00:00:00.000Z",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
