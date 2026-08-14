import { nativeExtensionAuthorityDigest, nativeExtensionBundleSha256 } from "./digest";
import { NativeExtensionError } from "./errors";
import {
  InMemoryNativeExtensionGrantStore,
  type NativeExtensionGrant,
  type NativeExtensionGrantStore,
} from "./grants";
import {
  type NativeExtensionBoundary,
  type NativeExtensionCapabilityId,
  type NativeExtensionManifest,
  type NativeExtensionRuntime,
  nativeExtensionCapabilityDefinitions,
  nativeExtensionCapabilityIds,
  parseNativeExtensionId,
  parseNativeExtensionManifest,
} from "./manifest";
import {
  canonicalizeNativeExtensionTrustMetadata,
  type NativeExtensionMarketplaceCatalog,
  type NativeExtensionMarketplaceCatalogStateStore,
  type NativeExtensionTrustedPublisherKey,
  type NativeExtensionTrustOptions,
  type NativeExtensionTrustProvenance,
  type NativeExtensionVerification,
  nativeExtensionSignedManifestSha256,
  parseNativeExtensionMarketplaceCatalog,
  verifyNativeExtensionBundle,
  verifyNativeExtensionMarketplaceCatalog,
} from "./marketplace-trust";
import type {
  NativeClipboardPort,
  NativeDynamicCodePort,
  NativeEditorPort,
  NativeExternalNavigationPort,
  NativeNetworkPort,
  NativeNetworkRequest,
  NativeNetworkResponse,
  NativeSecretsPort,
  NativeSubprocessPort,
  NativeSubprocessRequest,
  NativeSubprocessResult,
  NativeVaultPort,
  NativeVaultReadRequest,
  NativeVaultTextSnapshot,
  NativeVaultWriteRequest,
  NativeVaultWriteResult,
  NativeWorkspacePort,
} from "./ports";
import type { NativeExtensionBundle, NativeExtensionContext } from "./sdk";

type NativeExtensionEntrypoint = (
  context: NativeExtensionContext,
  input: unknown,
) => unknown | Promise<unknown>;

export type NativeExtensionRegistrationState =
  | "installed"
  | "grant-required"
  | "granted"
  | "stale"
  | "revoked"
  | "safe-mode"
  | "runtime-unavailable"
  | "active"
  | "stopped";

export type NativeExtensionAuthorityChange = "new" | "none" | "narrowed" | "grew";

export interface NativeExtensionReview {
  extensionId: string;
  manifest: NativeExtensionManifest;
  bundleSha256: string;
  packageTreeSha256: string;
  authorityDigest: string;
  capabilities: NativeExtensionCapabilityId[];
  authorityChange: NativeExtensionAuthorityChange;
  requiresReReview: boolean;
  distributionTrust: "trusted-distribution" | "unsigned-development";
  publisherFingerprint: string | null;
  trustProvenance: NativeExtensionTrustProvenance;
  boundaries: Readonly<Record<NativeExtensionCapabilityId, NativeExtensionBoundary>>;
}

export interface NativeExtensionInspection {
  extensionId: string;
  vaultId: string;
  state: NativeExtensionRegistrationState;
  runtime: NativeExtensionRuntime;
  sandboxed: false;
  boundary: "capability-governed" | "trusted-desktop-escape";
  declaredCapabilities: NativeExtensionCapabilityId[];
  grantedCapabilities: NativeExtensionCapabilityId[];
  bundleSha256: string;
  packageTreeSha256: string;
  authorityDigest: string;
  metadataSha256: string | null;
  publisherId: string | null;
  publisherKeyId: string | null;
  metadataExpiresAt: string | null;
  metadataRevokedAt: string | null;
  metadataDelistedAt: string | null;
  distributionTrust: "trusted-distribution" | "unsigned-development";
  trustProvenance: NativeExtensionTrustProvenance;
  safeMode: boolean;
  revoked: boolean;
  active: boolean;
  diagnostics: string[];
}

export interface NativeExtensionHostPorts {
  vault: NativeVaultPort;
  network?: NativeNetworkPort;
  clipboard?: NativeClipboardPort;
  navigation?: NativeExternalNavigationPort;
  editor?: NativeEditorPort;
  workspace?: NativeWorkspacePort;
  subprocess?: NativeSubprocessPort;
  secrets?: NativeSecretsPort;
  dynamicCode?: NativeDynamicCodePort;
}

export interface NativeExtensionHostOptions {
  ports: NativeExtensionHostPorts;
  runtime?: NativeExtensionRuntime;
  grantStore?: NativeExtensionGrantStore;
  invocationTimeoutMs?: number;
  teardownTimeoutMs?: number;
  now?: () => string;
}

export type NativeExtensionInstallMode = "trusted-distribution";

export interface NativeExtensionInstallOptions {
  mode: NativeExtensionInstallMode;
  metadata?: unknown;
  trustedPublishers?: NativeExtensionTrustOptions["trustedPublishers"];
  /** A signed catalog envelope that must contain and authorize `metadata`. */
  marketplaceCatalog?: unknown;
  trustedCatalogRoots?: NativeExtensionTrustOptions["trustedCatalogRoots"];
  catalogStateStore?: NativeExtensionMarketplaceCatalogStateStore;
}

interface Registration {
  bundle: NativeExtensionBundle;
  entrypoint?: NativeExtensionEntrypoint;
  bundleSha256: string;
  packageTreeSha256: string;
  authorityDigest: string;
  review: NativeExtensionReview;
  verification: NativeExtensionVerification | null;
  marketplaceCatalog: NativeExtensionMarketplaceCatalog | null;
  catalogStateStore: NativeExtensionMarketplaceCatalogStateStore | null;
  trustedCatalogRoots: NativeExtensionTrustedPublisherKey[];
}

interface ActiveInvocation {
  vaultId: string;
  extensionId: string;
  controller: AbortController;
  terminated: boolean;
  cancel: (error: NativeExtensionError) => Promise<void>;
}

function cloneManifest(manifest: NativeExtensionManifest): NativeExtensionManifest {
  return {
    ...manifest,
    capabilities: manifest.capabilities.map((capability) => ({ ...capability })),
  };
}

function cloneReview(review: NativeExtensionReview): NativeExtensionReview {
  return {
    ...review,
    manifest: cloneManifest(review.manifest),
    capabilities: [...review.capabilities],
    publisherFingerprint: review.publisherFingerprint,
    trustProvenance: { ...review.trustProvenance },
    boundaries: { ...review.boundaries },
  };
}

function capabilitySet(capabilities: readonly NativeExtensionCapabilityId[]): Set<string> {
  return new Set(capabilities);
}

function grantMatchesRegistration(
  grant: NativeExtensionGrant | undefined,
  registration: Registration,
  verification: NativeExtensionVerification | null,
): boolean {
  if (!grant) {
    return false;
  }
  return (
    grant.bundleSha256 === registration.bundleSha256 &&
    grant.packageTreeSha256 ===
      (verification?.packageTreeSha256 ??
        registration.bundle.packageTreeSha256 ??
        registration.bundleSha256) &&
    grant.authorityDigest === registration.authorityDigest &&
    grant.distributionTrust === registration.review.distributionTrust &&
    grant.metadataSha256 === (verification?.metadataSha256 ?? null) &&
    grant.publisherId === (verification?.publisherId ?? null) &&
    grant.publisherKeyId === (verification?.publisherKeyId ?? null) &&
    grant.publisherFingerprint === (verification?.publisherFingerprint ?? null) &&
    grant.metadataIssuedAt === (verification?.metadataIssuedAt ?? null) &&
    grant.metadataExpiresAt === (verification?.metadataExpiresAt ?? null) &&
    grant.metadataRevokedAt === (verification?.metadataRevokedAt ?? null) &&
    grant.metadataDelistedAt === (verification?.metadataDelistedAt ?? null) &&
    (grant.marketplaceCatalogRevision ?? null) ===
      (verification?.marketplaceCatalogRevision ?? null) &&
    (grant.marketplaceCatalogSha256 ?? null) === (verification?.marketplaceCatalogSha256 ?? null) &&
    (grant.marketplaceCatalogRootFingerprint ?? null) ===
      (verification?.marketplaceCatalogRootFingerprint ?? null)
  );
}

function authorityChange(
  previous: readonly NativeExtensionCapabilityId[] | null,
  current: readonly NativeExtensionCapabilityId[],
): NativeExtensionAuthorityChange {
  if (!previous) {
    return "new";
  }
  const oldSet = capabilitySet(previous);
  const currentSet = capabilitySet(current);
  const grew = current.some((capability) => !oldSet.has(capability));
  const narrowed = previous.some((capability) => !currentSet.has(capability));
  return grew ? "grew" : narrowed ? "narrowed" : "none";
}

function hostNow(): string {
  return new Date().toISOString();
}

function catalogRootsFromInstallOptions(
  options: Pick<NativeExtensionInstallOptions, "trustedPublishers" | "trustedCatalogRoots">,
): NativeExtensionTrustedPublisherKey[] {
  if (options.trustedCatalogRoots !== undefined) {
    return [...options.trustedCatalogRoots];
  }
  const anchors = options.trustedPublishers;
  if (typeof anchors === "object" && anchors !== null && "catalogRoots" in anchors) {
    const catalogRoots = (anchors as { catalogRoots?: unknown }).catalogRoots;
    if (Array.isArray(catalogRoots)) {
      return [...catalogRoots] as NativeExtensionTrustedPublisherKey[];
    }
  }
  return [];
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function assertRelativePath(
  value: string,
  capability: NativeExtensionCapabilityId,
  operation: string,
  vaultId: string,
): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    value.includes("\u0000") ||
    value.startsWith("/") ||
    value
      .split(/[\\/]/u)
      .some(
        (segment) =>
          segment === "" || segment === "." || segment === ".." || segment.startsWith("."),
      )
  ) {
    throw new NativeExtensionError(
      "invalid-request",
      "Vault paths must be contained relative paths.",
      {
        capability,
        operation,
        vaultId,
      },
    );
  }
}

function assertRevision(
  value: string | null,
  capability: NativeExtensionCapabilityId,
  operation: string,
  vaultId: string,
): void {
  if (value !== null && !/^[a-f0-9]{64}$/u.test(value)) {
    throw new NativeExtensionError("invalid-request", "Vault revision must be SHA-256 or null.", {
      capability,
      operation,
      vaultId,
    });
  }
}

function assertBoundedText(
  value: string,
  maximum: number,
  capability: NativeExtensionCapabilityId,
  operation: string,
  vaultId: string,
): void {
  if (typeof value !== "string" || value.length > maximum) {
    throw new NativeExtensionError("invalid-request", "Extension text input exceeds its bound.", {
      capability,
      operation,
      vaultId,
    });
  }
}

export class NativeExtensionHost {
  readonly #ports: NativeExtensionHostPorts;
  readonly #runtime: NativeExtensionRuntime;
  readonly #grants: NativeExtensionGrantStore;
  readonly #invocationTimeoutMs: number;
  readonly #teardownTimeoutMs: number;
  readonly #now: () => string;
  readonly #registrations = new Map<string, Registration>();
  readonly #safeModes = new Set<string>();
  readonly #active = new Map<string, ActiveInvocation>();
  readonly #diagnostics = new Map<string, string[]>();
  #closed = false;

  constructor(options: NativeExtensionHostOptions) {
    this.#ports = options.ports;
    this.#runtime = options.runtime ?? "portable";
    this.#grants = options.grantStore ?? new InMemoryNativeExtensionGrantStore();
    this.#invocationTimeoutMs = positiveTimeout(options.invocationTimeoutMs, 10_000);
    this.#teardownTimeoutMs = positiveTimeout(options.teardownTimeoutMs, 1_000);
    this.#now = options.now ?? hostNow;
  }

  /** Callable registration is deliberately unavailable on production hosts. */
  register(_bundle: NativeExtensionBundle): NativeExtensionReview {
    throw new NativeExtensionError(
      "distribution-untrusted",
      "Callable native extension registration is unavailable on production hosts.",
    );
  }

  /**
   * Install is a trust gate and never creates a grant. Unsigned development must be explicit;
   * trusted distribution requires a signed record, exact bundle bytes, and offline anchors.
   */
  install(
    bundle: NativeExtensionBundle,
    options?: NativeExtensionInstallOptions,
  ): NativeExtensionReview {
    this.assertHostOpen();
    if (!options) {
      throw new NativeExtensionError(
        "distribution-untrusted",
        "Native extension install requires an explicit trust mode.",
      );
    }
    if (options.mode !== "trusted-distribution" || options.metadata === undefined) {
      throw new NativeExtensionError(
        "distribution-untrusted",
        "Trusted distribution install requires signed metadata.",
      );
    }
    return this.reviewDistribution(bundle, options);
  }

  /** Review a signed distribution without granting any per-vault capabilities. */
  reviewDistribution(
    bundle: NativeExtensionBundle,
    options: Pick<
      NativeExtensionInstallOptions,
      | "metadata"
      | "trustedPublishers"
      | "marketplaceCatalog"
      | "trustedCatalogRoots"
      | "catalogStateStore"
    >,
  ): NativeExtensionReview {
    this.assertHostOpen();
    if (options.metadata === undefined) {
      throw new NativeExtensionError(
        "distribution-untrusted",
        "Trusted distribution review requires signed metadata.",
      );
    }
    let verification: ReturnType<typeof verifyNativeExtensionBundle>;
    let marketplaceCatalog: NativeExtensionMarketplaceCatalog | null = null;
    const catalogStateStore = options.catalogStateStore ?? null;
    const trustedCatalogRoots = catalogRootsFromInstallOptions(options);
    try {
      if (options.marketplaceCatalog !== undefined) {
        if (catalogStateStore === null) {
          throw new Error(
            "Signed marketplace catalog install requires a persistent catalog state store.",
          );
        }
        marketplaceCatalog = parseNativeExtensionMarketplaceCatalog(options.marketplaceCatalog);
        const key = `${bundle.manifest.id}\u0000${bundle.manifest.version}`;
        const verifications = verifyNativeExtensionMarketplaceCatalog(options.marketplaceCatalog, {
          trustedPublishers: options.trustedPublishers ?? [],
          bundleBytesByEntry: new Map([[key, bundle.bundleBytes]]),
          ...(bundle.packageTreeSha256 === undefined
            ? {}
            : { packageTreeSha256ByEntry: new Map([[key, bundle.packageTreeSha256]]) }),
          selectedEntryKey: key,
          ...(options.trustedCatalogRoots === undefined
            ? {}
            : { trustedCatalogRoots: options.trustedCatalogRoots }),
          ...(options.trustedCatalogRoots === undefined && trustedCatalogRoots.length > 0
            ? { trustedCatalogRoots }
            : {}),
          now: this.#now(),
          ...(catalogStateStore === null ? {} : { stateStore: catalogStateStore }),
        });
        const metadataSha256 = nativeExtensionSignedManifestSha256(options.metadata);
        const selected = verifications.find(
          (candidate) =>
            candidate.metadataSha256 === metadataSha256 &&
            candidate.metadata.manifest.id === bundle.manifest.id,
        );
        if (!selected) {
          throw new Error("Signed metadata is not the catalog entry selected for this bundle.");
        }
        const normalizedBundleManifest = parseNativeExtensionManifest(bundle.manifest);
        if (
          canonicalizeNativeExtensionTrustMetadata(normalizedBundleManifest) !==
          canonicalizeNativeExtensionTrustMetadata(selected.metadata.manifest)
        ) {
          throw new Error("Signed metadata manifest does not match the supplied bundle manifest.");
        }
        verification = selected;
      } else {
        verification = verifyNativeExtensionBundle(options.metadata, bundle, {
          trustedPublishers: options.trustedPublishers ?? [],
          now: this.#now(),
        });
      }
    } catch (error) {
      throw new NativeExtensionError(
        "distribution-untrusted",
        error instanceof Error ? error.message : "Native extension distribution is untrusted.",
        { cause: error },
      );
    }
    return this.replaceRegistration(
      {
        manifest: cloneManifest(bundle.manifest),
        bundleBytes: new Uint8Array(bundle.bundleBytes),
        ...(bundle.packageTreeSha256 === undefined
          ? {}
          : { packageTreeSha256: bundle.packageTreeSha256 }),
      },
      undefined,
      verification,
      {
        distributionTrust: "trusted-distribution",
        publisherFingerprint: verification.publisherFingerprint,
        trustProvenance: {
          distributionTrust: "trusted-distribution",
          metadataSha256: verification.metadataSha256,
          publisherId: verification.publisherId,
          publisherKeyId: verification.publisherKeyId,
          publisherFingerprint: verification.publisherFingerprint,
          keyTrust: verification.keyTrust,
          marketplaceIndex: verification.marketplaceIndexTrust,
          marketplaceCatalogRevision: verification.marketplaceCatalogRevision,
          marketplaceCatalogSha256: verification.marketplaceCatalogSha256,
          marketplaceCatalogRootFingerprint: verification.marketplaceCatalogRootFingerprint,
          packageTreeSha256: verification.packageTreeSha256,
          installedTreeEvidence:
            verification.metadata.packageTreeSha256 === undefined
              ? "bundle-only"
              : "signed-package-tree",
        },
      },
      marketplaceCatalog,
      catalogStateStore,
      trustedCatalogRoots,
    );
  }

  private replaceRegistration(
    bundle: NativeExtensionBundle,
    entrypoint: NativeExtensionEntrypoint | undefined,
    verification: NativeExtensionVerification | null,
    trust: {
      distributionTrust: NativeExtensionReview["distributionTrust"];
      publisherFingerprint: string | null;
      trustProvenance: NativeExtensionTrustProvenance;
    },
    marketplaceCatalog: NativeExtensionMarketplaceCatalog | null = null,
    catalogStateStore: NativeExtensionMarketplaceCatalogStateStore | null = null,
    trustedCatalogRoots: readonly NativeExtensionTrustedPublisherKey[] = [],
  ): NativeExtensionReview {
    const manifest = parseNativeExtensionManifest(bundle.manifest);
    const bundleBytes = new Uint8Array(bundle.bundleBytes);
    const bundleSha256 = nativeExtensionBundleSha256(bundleBytes);
    const packageTreeSha256 = bundle.packageTreeSha256 ?? bundleSha256;
    const authorityDigest = nativeExtensionAuthorityDigest(manifest);
    const previous = this.#registrations.get(manifest.id);
    if (previous) {
      for (const [key, active] of this.#active) {
        if (active.extensionId === manifest.id) {
          void active.cancel(
            new NativeExtensionError(
              "stale-grant",
              "Native extension bundle changed while it was executing.",
            ),
          );
          this.#active.delete(key);
        }
      }
    }
    const capabilities = manifest.capabilities.map(({ id }) => id);
    const change = authorityChange(previous?.review.capabilities ?? null, capabilities);
    const review: NativeExtensionReview = {
      extensionId: manifest.id,
      manifest: cloneManifest(manifest),
      bundleSha256,
      packageTreeSha256,
      authorityDigest,
      capabilities: [...capabilities],
      authorityChange: change,
      requiresReReview: previous !== undefined && change === "grew",
      distributionTrust: trust.distributionTrust,
      publisherFingerprint: trust.publisherFingerprint,
      trustProvenance: { ...trust.trustProvenance },
      boundaries: Object.fromEntries(
        capabilities.map((capability) => [
          capability,
          nativeExtensionCapabilityDefinitions[capability].boundary,
        ]),
      ) as Readonly<Record<NativeExtensionCapabilityId, NativeExtensionBoundary>>,
    };
    const registration: Registration = {
      bundle: {
        manifest: cloneManifest(manifest),
        bundleBytes,
        ...(bundle.packageTreeSha256 === undefined
          ? {}
          : { packageTreeSha256: bundle.packageTreeSha256 }),
      },
      ...(entrypoint === undefined ? {} : { entrypoint }),
      bundleSha256,
      packageTreeSha256,
      authorityDigest,
      review,
      verification,
      marketplaceCatalog,
      catalogStateStore,
      trustedCatalogRoots: [...trustedCatalogRoots],
    };
    this.#registrations.set(manifest.id, registration);
    this.#diagnostics.delete(manifest.id);
    return cloneReview(review);
  }

  unregister(extensionId: string): void {
    this.assertHostOpen();
    const id = parseNativeExtensionId(extensionId);
    for (const key of [...this.#active.keys()]) {
      if (key.endsWith(`\u0000${id}`)) {
        void this.stopByKey(key, "teardown");
      }
    }
    this.#registrations.delete(id);
  }

  review(extensionId: string): NativeExtensionReview {
    this.assertHostOpen();
    const registration = this.registration(extensionId);
    this.assertCurrentDistribution(registration);
    return cloneReview(registration.review);
  }

  async grant(
    vaultId: string,
    extensionId: string,
    capabilities?: readonly NativeExtensionCapabilityId[],
  ): Promise<NativeExtensionInspection> {
    this.assertHostOpen();
    const registration = this.registration(extensionId);
    this.assertRuntimeAvailable(registration.bundle.manifest);
    const verification = this.assertCurrentDistribution(registration);
    const requested =
      capabilities === undefined ? registration.review.capabilities : [...capabilities];
    if (new Set(requested).size !== requested.length) {
      throw new NativeExtensionError("invalid-request", "Native extension grant has duplicates.");
    }
    for (const capability of requested) {
      if (!nativeExtensionCapabilityIds.includes(capability)) {
        throw new NativeExtensionError(
          "invalid-request",
          `Unknown native extension capability ${capability}.`,
        );
      }
      if (!registration.review.capabilities.includes(capability)) {
        throw new NativeExtensionError(
          "invalid-request",
          `Cannot grant undeclared native extension capability ${capability}.`,
          { capability },
        );
      }
    }
    const grant: NativeExtensionGrant = {
      grantVersion: 2,
      vaultId,
      extensionId: registration.bundle.manifest.id,
      bundleSha256: registration.bundleSha256,
      packageTreeSha256: verification?.packageTreeSha256 ?? registration.packageTreeSha256,
      authorityDigest: registration.authorityDigest,
      distributionTrust: registration.review.distributionTrust,
      metadataSha256: verification?.metadataSha256 ?? null,
      publisherId: verification?.publisherId ?? null,
      publisherKeyId: verification?.publisherKeyId ?? null,
      publisherFingerprint: verification?.publisherFingerprint ?? null,
      metadataIssuedAt: verification?.metadataIssuedAt ?? null,
      metadataExpiresAt: verification?.metadataExpiresAt ?? null,
      metadataRevokedAt: verification?.metadataRevokedAt ?? null,
      metadataDelistedAt: verification?.metadataDelistedAt ?? null,
      marketplaceCatalogRevision: verification?.marketplaceCatalogRevision ?? null,
      marketplaceCatalogSha256: verification?.marketplaceCatalogSha256 ?? null,
      marketplaceCatalogRootFingerprint: verification?.marketplaceCatalogRootFingerprint ?? null,
      capabilities: [...requested],
      grantedAt: this.#now(),
    };
    if (this.#grants.replace) {
      await this.#grants.replace(grant);
    } else {
      await this.#grants.put(grant);
    }
    return this.inspect(vaultId, extensionId);
  }

  async revoke(vaultId: string, extensionId: string): Promise<NativeExtensionInspection> {
    this.assertHostOpen();
    const registration = this.registration(extensionId);
    const current = await this.#grants.get(vaultId, registration.bundle.manifest.id);
    const verification = registration.verification;
    const grant: NativeExtensionGrant = {
      grantVersion: 2,
      vaultId,
      extensionId: registration.bundle.manifest.id,
      bundleSha256: current?.bundleSha256 ?? registration.bundleSha256,
      packageTreeSha256:
        current?.packageTreeSha256 ??
        verification?.packageTreeSha256 ??
        registration.packageTreeSha256,
      authorityDigest: current?.authorityDigest ?? registration.authorityDigest,
      distributionTrust: current?.distributionTrust ?? registration.review.distributionTrust,
      metadataSha256: current?.metadataSha256 ?? verification?.metadataSha256 ?? null,
      publisherId: current?.publisherId ?? verification?.publisherId ?? null,
      publisherKeyId: current?.publisherKeyId ?? verification?.publisherKeyId ?? null,
      publisherFingerprint:
        current?.publisherFingerprint ?? verification?.publisherFingerprint ?? null,
      metadataIssuedAt: current?.metadataIssuedAt ?? verification?.metadataIssuedAt ?? null,
      metadataExpiresAt: current?.metadataExpiresAt ?? verification?.metadataExpiresAt ?? null,
      metadataRevokedAt: current?.metadataRevokedAt ?? verification?.metadataRevokedAt ?? null,
      metadataDelistedAt: current?.metadataDelistedAt ?? verification?.metadataDelistedAt ?? null,
      marketplaceCatalogRevision:
        current?.marketplaceCatalogRevision ?? verification?.marketplaceCatalogRevision ?? null,
      marketplaceCatalogSha256:
        current?.marketplaceCatalogSha256 ?? verification?.marketplaceCatalogSha256 ?? null,
      marketplaceCatalogRootFingerprint:
        current?.marketplaceCatalogRootFingerprint ??
        verification?.marketplaceCatalogRootFingerprint ??
        null,
      capabilities: current?.capabilities ?? [],
      grantedAt: current?.grantedAt ?? this.#now(),
      revokedAt: this.#now(),
    };
    if (this.#grants.revoke) {
      await this.#grants.revoke(grant);
    } else {
      await this.#grants.put(grant);
    }
    const key = this.invocationKey(vaultId, registration.bundle.manifest.id);
    const active = this.#active.get(key);
    if (active) {
      await active.cancel(
        new NativeExtensionError(
          "revoked",
          "Native extension grant was revoked during execution.",
          {
            vaultId,
          },
        ),
      );
    }
    return this.inspect(vaultId, extensionId);
  }

  setSafeMode(vaultId: string, enabled: boolean): void {
    this.assertHostOpen();
    const keyPrefix = `${vaultId}\u0000`;
    if (enabled) {
      this.#safeModes.add(vaultId);
      for (const [key, active] of this.#active) {
        if (key.startsWith(keyPrefix)) {
          void active.cancel(
            new NativeExtensionError("safe-mode", "Native extension safe mode stopped execution.", {
              vaultId,
            }),
          );
        }
      }
    } else {
      this.#safeModes.delete(vaultId);
    }
  }

  async inspect(vaultId: string, extensionId: string): Promise<NativeExtensionInspection> {
    this.assertHostOpen();
    const registration = this.registration(extensionId);
    const manifest = registration.bundle.manifest;
    const verification = this.assertCurrentDistribution(registration);
    const grant = await this.#grants.get(vaultId, manifest.id);
    const safeMode = this.#safeModes.has(vaultId);
    const revoked = grant?.revokedAt !== undefined;
    const active = this.#active.has(this.invocationKey(vaultId, manifest.id));
    let state: NativeExtensionRegistrationState = "installed";
    if (safeMode) {
      state = "safe-mode";
    } else if (revoked) {
      state = "revoked";
    } else if (!grant) {
      state = "grant-required";
    } else if (!grantMatchesRegistration(grant, registration, verification)) {
      state = "stale";
    } else if (!this.runtimeAvailable(manifest)) {
      state = "runtime-unavailable";
    } else if (active) {
      state = "active";
    } else {
      state = "granted";
    }
    const boundaries = manifest.capabilities.map(
      ({ id }) => nativeExtensionCapabilityDefinitions[id].boundary,
    );
    const boundary = boundaries.includes("trusted-desktop-escape")
      ? "trusted-desktop-escape"
      : "capability-governed";
    return {
      extensionId: manifest.id,
      vaultId,
      state,
      runtime: this.#runtime,
      sandboxed: false,
      boundary,
      declaredCapabilities: manifest.capabilities.map(({ id }) => id),
      grantedCapabilities: grant?.capabilities ? [...grant.capabilities] : [],
      bundleSha256: registration.bundleSha256,
      packageTreeSha256: registration.packageTreeSha256,
      authorityDigest: registration.authorityDigest,
      metadataSha256: verification?.metadataSha256 ?? null,
      publisherId: verification?.publisherId ?? null,
      publisherKeyId: verification?.publisherKeyId ?? null,
      metadataExpiresAt: verification?.metadataExpiresAt ?? null,
      metadataRevokedAt: verification?.metadataRevokedAt ?? null,
      metadataDelistedAt: verification?.metadataDelistedAt ?? null,
      distributionTrust: registration.review.distributionTrust,
      trustProvenance: { ...registration.review.trustProvenance },
      safeMode,
      revoked,
      active,
      diagnostics: [...(this.#diagnostics.get(manifest.id) ?? [])],
    };
  }

  async execute<Input = unknown, Output = unknown>(
    vaultId: string,
    extensionId: string,
    input: Input,
  ): Promise<Output> {
    this.assertHostOpen();
    const registration = this.registration(extensionId);
    const manifest = registration.bundle.manifest;
    await this.assertExecutable(vaultId, registration);
    const entrypoint = registration.entrypoint;
    if (!entrypoint) {
      throw new NativeExtensionError(
        "runtime-unavailable",
        "Verified native extension bytes have no production evaluator; execution is fail-closed.",
        { vaultId, operation: "execute" },
      );
    }
    const key = this.invocationKey(vaultId, manifest.id);
    if (this.#active.has(key)) {
      throw new NativeExtensionError(
        "capability-denied",
        "Native extension already has an active invocation.",
        {
          vaultId,
          operation: "execute",
        },
      );
    }
    const controller = new AbortController();
    const teardownCallbacks = new Set<() => void | Promise<void>>();
    let terminated = false;
    let settled = false;
    let cleanupPromise: Promise<NativeExtensionError | null> | null = null;
    let resolveOutcome:
      | ((outcome: { ok: true; value: Output } | { ok: false; error: unknown }) => void)
      | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let active: ActiveInvocation;
    const terminate = (): void => {
      if (terminated) {
        return;
      }
      terminated = true;
      active.terminated = true;
      controller.abort();
    };
    const cleanup = async (): Promise<NativeExtensionError | null> => {
      cleanupPromise ??= this.runTeardown(teardownCallbacks, manifest.id, vaultId);
      return cleanupPromise;
    };
    const combineTeardownFailure = (
      executionError: unknown,
      teardownError: NativeExtensionError,
    ): NativeExtensionError => {
      const executionMessage =
        executionError instanceof Error ? executionError.message : "Native extension failed.";
      return new NativeExtensionError(
        "teardown",
        `${teardownError.message} Original execution failure: ${executionMessage}`,
        { operation: "execute", vaultId, cause: executionError },
      );
    };
    const finishFailure = async (error: NativeExtensionError): Promise<void> => {
      if (settled || terminated) {
        return;
      }
      terminate();
      const teardownError = await cleanup();
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      this.#active.delete(key);
      resolveOutcome?.({
        ok: false,
        error: teardownError ? combineTeardownFailure(error, teardownError) : error,
      });
    };
    active = {
      vaultId,
      extensionId: manifest.id,
      controller,
      terminated: false,
      cancel: finishFailure,
    };
    this.#active.set(key, active);
    const context = this.createContext(
      registration,
      vaultId,
      controller,
      teardownCallbacks,
      () => terminated,
    );
    const extensionResult = Promise.resolve().then(() => entrypoint(context, input));
    const outcome = await new Promise<{ ok: true; value: Output } | { ok: false; error: unknown }>(
      (resolve) => {
        resolveOutcome = resolve;
        timer = setTimeout(() => {
          void finishFailure(
            new NativeExtensionError(
              "timeout",
              `Native extension exceeded its ${this.#invocationTimeoutMs} ms invocation deadline.`,
              { operation: "execute", vaultId },
            ),
          );
        }, this.#invocationTimeoutMs);
        extensionResult.then(
          (value) => {
            if (settled || terminated) {
              return;
            }
            terminate();
            void cleanup().then((teardownError) => {
              if (settled) {
                return;
              }
              settled = true;
              if (timer) {
                clearTimeout(timer);
              }
              this.#active.delete(key);
              resolve(
                teardownError
                  ? { ok: false, error: teardownError }
                  : { ok: true, value: value as Output },
              );
            });
          },
          (error: unknown) => {
            if (settled || terminated) {
              return;
            }
            terminate();
            void cleanup().then((teardownError) => {
              if (settled) {
                return;
              }
              settled = true;
              this.#active.delete(key);
              if (timer) {
                clearTimeout(timer);
              }
              resolve({
                ok: false,
                error: teardownError ? combineTeardownFailure(error, teardownError) : error,
              });
            });
          },
        );
      },
    );
    if (outcome.ok) {
      return outcome.value;
    }
    if (outcome.error instanceof NativeExtensionError) {
      this.recordDiagnostic(manifest.id, outcome.error.message);
      throw outcome.error;
    }
    const message =
      outcome.error instanceof Error ? outcome.error.message : "Native extension failed.";
    this.recordDiagnostic(manifest.id, message);
    throw new NativeExtensionError("extension-failed", message, {
      operation: "execute",
      vaultId,
      cause: outcome.error,
    });
  }

  async stop(vaultId: string, extensionId: string): Promise<void> {
    this.assertHostOpen();
    const id = parseNativeExtensionId(extensionId);
    const active = this.#active.get(this.invocationKey(vaultId, id));
    if (active) {
      await active.cancel(
        new NativeExtensionError("teardown", "Native extension was stopped.", { vaultId }),
      );
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await Promise.all(
      [...this.#active.values()].map((active) =>
        active.cancel(new NativeExtensionError("host-closed", "Native extension host was closed.")),
      ),
    );
    this.#active.clear();
  }

  private assertCurrentDistribution(
    registration: Registration,
  ): NativeExtensionVerification | null {
    if (!registration.verification) {
      return null;
    }
    try {
      const current = registration.marketplaceCatalog
        ? (() => {
            const key = `${registration.bundle.manifest.id}\u0000${registration.bundle.manifest.version}`;
            const currentCatalog = verifyNativeExtensionMarketplaceCatalog(
              registration.marketplaceCatalog,
              {
                trustedPublishers: registration.verification?.trustedPublishers ?? [],
                trustedCatalogRoots: registration.trustedCatalogRoots,
                bundleBytesByEntry: new Map([[key, registration.bundle.bundleBytes]]),
                selectedEntryKey: key,
                now: this.#now(),
                packageTreeSha256ByEntry: new Map([[key, registration.packageTreeSha256]]),
                ...(registration.catalogStateStore === null
                  ? {}
                  : { stateStore: registration.catalogStateStore }),
              },
            );
            const selected = currentCatalog[0];
            if (!selected) {
              throw new Error("Installed extension is not present in its marketplace catalog.");
            }
            return selected;
          })()
        : verifyNativeExtensionBundle(registration.verification.metadata, registration.bundle, {
            trustedPublishers: registration.verification.trustedPublishers,
            now: this.#now(),
          });
      if (
        current.metadataSha256 !== registration.review.trustProvenance.metadataSha256 ||
        current.bundleSha256 !== registration.bundleSha256 ||
        current.packageTreeSha256 !== registration.packageTreeSha256 ||
        current.authorityDigest !== registration.authorityDigest ||
        current.marketplaceCatalogRevision !==
          registration.review.trustProvenance.marketplaceCatalogRevision ||
        current.marketplaceCatalogSha256 !==
          registration.review.trustProvenance.marketplaceCatalogSha256 ||
        current.marketplaceCatalogRootFingerprint !==
          registration.review.trustProvenance.marketplaceCatalogRootFingerprint
      ) {
        throw new Error("Verified native extension distribution changed after registration.");
      }
      return current;
    } catch (error) {
      throw new NativeExtensionError(
        "distribution-untrusted",
        error instanceof Error ? error.message : "Native extension distribution is untrusted.",
        { cause: error },
      );
    }
  }

  private async assertExecutable(vaultId: string, registration: Registration): Promise<void> {
    const manifest = registration.bundle.manifest;
    if (this.#safeModes.has(vaultId)) {
      throw new NativeExtensionError("safe-mode", "Native extension safe mode is active.", {
        vaultId,
      });
    }
    this.assertRuntimeAvailable(manifest);
    const verification = this.assertCurrentDistribution(registration);
    const grant = await this.#grants.get(vaultId, manifest.id);
    if (!grant) {
      throw new NativeExtensionError(
        "grant-required",
        "Native extension requires install-time review and grant.",
        {
          vaultId,
        },
      );
    }
    if (grant.revokedAt !== undefined) {
      throw new NativeExtensionError("revoked", "Native extension grant has been revoked.", {
        vaultId,
      });
    }
    if (!grantMatchesRegistration(grant, registration, verification)) {
      throw new NativeExtensionError(
        "stale-grant",
        "Native extension grant is stale for the installed bundle or authority declaration.",
        { vaultId },
      );
    }
  }

  private createContext(
    registration: Registration,
    vaultId: string,
    controller: AbortController,
    teardownCallbacks: Set<() => void | Promise<void>>,
    isTerminated: () => boolean,
  ): NativeExtensionContext {
    const manifest = cloneManifest(registration.bundle.manifest);
    const requireCapability = async (
      capability: NativeExtensionCapabilityId,
      operation: string,
    ): Promise<void> => {
      if (this.#closed) {
        throw new NativeExtensionError("host-closed", "Native extension host is closed.", {
          capability,
          operation,
          vaultId,
        });
      }
      if (isTerminated() || controller.signal.aborted) {
        throw new NativeExtensionError("teardown", "Native extension invocation has ended.", {
          capability,
          operation,
          vaultId,
        });
      }
      if (!manifest.capabilities.some(({ id }) => id === capability)) {
        throw new NativeExtensionError(
          "undeclared-capability",
          `Native extension did not declare ${capability}.`,
          { capability, operation, vaultId },
        );
      }
      const definition = nativeExtensionCapabilityDefinitions[capability];
      if (definition.availability === "desktop-only" && this.#runtime === "portable") {
        throw new NativeExtensionError(
          "capability-unavailable",
          `${capability} is unavailable in the portable runtime.`,
          { capability, operation, vaultId },
        );
      }
      const verification = this.assertCurrentDistribution(registration);
      const grant = await this.#grants.get(vaultId, manifest.id);
      if (!grant || grant.revokedAt !== undefined) {
        throw new NativeExtensionError(
          grant?.revokedAt === undefined ? "grant-required" : "revoked",
          grant?.revokedAt === undefined
            ? "Native extension capability has no current grant."
            : "Native extension grant has been revoked.",
          { capability, operation, vaultId },
        );
      }
      if (!grantMatchesRegistration(grant, registration, verification)) {
        throw new NativeExtensionError(
          "stale-grant",
          "Native extension capability grant is stale.",
          { capability, operation, vaultId },
        );
      }
      if (!grant.capabilities.includes(capability)) {
        throw new NativeExtensionError(
          "capability-denied",
          `Native extension capability ${capability} was not granted for this vault.`,
          { capability, operation, vaultId },
        );
      }
    };
    const assertVault = (requestedVaultId: string, operation: string): void => {
      if (requestedVaultId !== vaultId) {
        throw new NativeExtensionError(
          "cross-vault",
          "Native extension attempted to address a different vault.",
          { operation, vaultId: requestedVaultId },
        );
      }
    };
    const assertLive = (operation: string): void => {
      if (this.#closed) {
        throw new NativeExtensionError("host-closed", "Native extension host is closed.", {
          operation,
          vaultId,
        });
      }
      if (isTerminated() || controller.signal.aborted) {
        throw new NativeExtensionError("teardown", "Native extension invocation has ended.", {
          operation,
          vaultId,
        });
      }
    };
    const guardedVault: NativeVaultPort = {
      listMarkdownPaths: async (request) => {
        assertLive("vault.listMarkdownPaths");
        await requireCapability("vault.read", "vault.listMarkdownPaths");
        assertVault(request.vaultId, "vault.listMarkdownPaths");
        if (request.relativeDirectory !== undefined) {
          assertRelativePath(
            request.relativeDirectory,
            "vault.read",
            "vault.listMarkdownPaths",
            vaultId,
          );
        }
        return this.#ports.vault.listMarkdownPaths(request);
      },
      readText: async (request: NativeVaultReadRequest): Promise<NativeVaultTextSnapshot> => {
        assertLive("vault.readText");
        await requireCapability("vault.read", "vault.readText");
        assertVault(request.vaultId, "vault.readText");
        assertRelativePath(request.relativePath, "vault.read", "vault.readText", vaultId);
        const snapshot = await this.#ports.vault.readText(request);
        if (
          typeof snapshot.content !== "string" ||
          typeof snapshot.path !== "string" ||
          typeof snapshot.revision !== "string" ||
          !/^[a-f0-9]{64}$/u.test(snapshot.revision) ||
          !Number.isSafeInteger(snapshot.size) ||
          snapshot.size < 0 ||
          snapshot.content.length > 16 * 1024 * 1024
        ) {
          throw new NativeExtensionError(
            "capability-unavailable",
            "Vault port returned an invalid snapshot.",
            {
              capability: "vault.read",
              operation: "vault.readText",
              vaultId,
            },
          );
        }
        return snapshot;
      },
      writeText: async (request: NativeVaultWriteRequest): Promise<NativeVaultWriteResult> => {
        assertLive("vault.writeText");
        await requireCapability("vault.write", "vault.writeText");
        assertVault(request.vaultId, "vault.writeText");
        assertRelativePath(request.relativePath, "vault.write", "vault.writeText", vaultId);
        assertBoundedText(
          request.content,
          16 * 1024 * 1024,
          "vault.write",
          "vault.writeText",
          vaultId,
        );
        assertRevision(request.expectedRevision, "vault.write", "vault.writeText", vaultId);
        return this.#ports.vault.writeText(request);
      },
    };
    const guardedNetwork: NativeNetworkPort = {
      request: async (
        request: NativeNetworkRequest,
        signal = controller.signal,
      ): Promise<NativeNetworkResponse> => {
        assertLive("network.request");
        await requireCapability("network", "network.request");
        let parsed: URL;
        try {
          parsed = new URL(request.url);
        } catch {
          throw new NativeExtensionError("invalid-request", "Network URL is invalid.", {
            capability: "network",
            operation: "network.request",
            vaultId,
          });
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw new NativeExtensionError("invalid-request", "Network URL must use HTTP(S).", {
            capability: "network",
            operation: "network.request",
            vaultId,
          });
        }
        return (
          this.#ports.network?.request({ ...request, url: parsed.toString() }, signal) ??
          Promise.reject(
            new NativeExtensionError("capability-unavailable", "Network port is unavailable.", {
              capability: "network",
              operation: "network.request",
              vaultId,
            }),
          )
        );
      },
    };
    const guardedClipboard: NativeClipboardPort = {
      readText: async () => {
        assertLive("clipboard.readText");
        await requireCapability("clipboard", "clipboard.readText");
        if (!this.#ports.clipboard) {
          throw new NativeExtensionError(
            "capability-unavailable",
            "Clipboard port is unavailable.",
            {
              capability: "clipboard",
              operation: "clipboard.readText",
              vaultId,
            },
          );
        }
        return this.#ports.clipboard.readText();
      },
      writeText: async (text: string) => {
        assertLive("clipboard.writeText");
        await requireCapability("clipboard", "clipboard.writeText");
        assertBoundedText(text, 1 * 1024 * 1024, "clipboard", "clipboard.writeText", vaultId);
        if (!this.#ports.clipboard) {
          throw new NativeExtensionError(
            "capability-unavailable",
            "Clipboard port is unavailable.",
            {
              capability: "clipboard",
              operation: "clipboard.writeText",
              vaultId,
            },
          );
        }
        return this.#ports.clipboard.writeText(text);
      },
    };
    const guardedNavigation: NativeExternalNavigationPort = {
      openExternal: async (url: string) => {
        assertLive("navigation.openExternal");
        await requireCapability("external-navigation", "navigation.openExternal");
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw new NativeExtensionError("invalid-request", "External navigation URL is invalid.", {
            capability: "external-navigation",
            operation: "navigation.openExternal",
            vaultId,
          });
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw new NativeExtensionError(
            "invalid-request",
            "External navigation requires HTTP(S).",
            {
              capability: "external-navigation",
              operation: "navigation.openExternal",
              vaultId,
            },
          );
        }
        if (!this.#ports.navigation) {
          throw new NativeExtensionError(
            "capability-unavailable",
            "Navigation port is unavailable.",
            {
              capability: "external-navigation",
              operation: "navigation.openExternal",
              vaultId,
            },
          );
        }
        return this.#ports.navigation.openExternal(parsed.toString());
      },
    };
    const guardedEditor: NativeEditorPort = {
      getSelection: async (expectedVaultId: string) => {
        assertLive("editor.getSelection");
        await requireCapability("editor-ui", "editor.getSelection");
        assertVault(expectedVaultId, "editor.getSelection");
        if (!this.#ports.editor) {
          throw new NativeExtensionError("capability-unavailable", "Editor port is unavailable.", {
            capability: "editor-ui",
            operation: "editor.getSelection",
            vaultId,
          });
        }
        return this.#ports.editor.getSelection(vaultId);
      },
      replaceSelection: async (expectedVaultId: string, content: string) => {
        assertLive("editor.replaceSelection");
        await requireCapability("editor-ui", "editor.replaceSelection");
        assertVault(expectedVaultId, "editor.replaceSelection");
        assertBoundedText(
          content,
          2 * 1024 * 1024,
          "editor-ui",
          "editor.replaceSelection",
          vaultId,
        );
        if (!this.#ports.editor) {
          throw new NativeExtensionError("capability-unavailable", "Editor port is unavailable.", {
            capability: "editor-ui",
            operation: "editor.replaceSelection",
            vaultId,
          });
        }
        return this.#ports.editor.replaceSelection(vaultId, content);
      },
    };
    const guardedWorkspace: NativeWorkspacePort = {
      notice: async (message: string) => {
        assertLive("workspace.notice");
        await requireCapability("workspace-ui", "workspace.notice");
        assertBoundedText(message, 4_096, "workspace-ui", "workspace.notice", vaultId);
        if (!this.#ports.workspace) {
          throw new NativeExtensionError(
            "capability-unavailable",
            "Workspace port is unavailable.",
            {
              capability: "workspace-ui",
              operation: "workspace.notice",
              vaultId,
            },
          );
        }
        return this.#ports.workspace.notice(message);
      },
      openFile: async (expectedVaultId: string, relativePath: string) => {
        assertLive("workspace.openFile");
        await requireCapability("workspace-ui", "workspace.openFile");
        assertVault(expectedVaultId, "workspace.openFile");
        assertRelativePath(relativePath, "workspace-ui", "workspace.openFile", vaultId);
        if (!this.#ports.workspace) {
          throw new NativeExtensionError(
            "capability-unavailable",
            "Workspace port is unavailable.",
            {
              capability: "workspace-ui",
              operation: "workspace.openFile",
              vaultId,
            },
          );
        }
        return this.#ports.workspace.openFile(vaultId, relativePath);
      },
    };
    const guardedSubprocess: NativeSubprocessPort = {
      run: async (
        request: NativeSubprocessRequest,
        signal = controller.signal,
      ): Promise<NativeSubprocessResult> => {
        assertLive("subprocess.run");
        await requireCapability("subprocess", "subprocess.run");
        if (!this.#ports.subprocess) {
          throw new NativeExtensionError(
            "capability-unavailable",
            "Subprocess port is unavailable.",
            {
              capability: "subprocess",
              operation: "subprocess.run",
              vaultId,
            },
          );
        }
        return this.#ports.subprocess.run(request, signal);
      },
    };
    const guardedSecrets: NativeSecretsPort = {
      get: async (name: string) => {
        assertLive("secrets.get");
        await requireCapability("secrets", "secrets.get");
        if (!/^[A-Za-z0-9._-]{1,128}$/u.test(name)) {
          throw new NativeExtensionError("invalid-request", "Secret name is invalid.", {
            capability: "secrets",
            operation: "secrets.get",
            vaultId,
          });
        }
        if (!this.#ports.secrets) {
          throw new NativeExtensionError("capability-unavailable", "Secrets port is unavailable.", {
            capability: "secrets",
            operation: "secrets.get",
            vaultId,
          });
        }
        return this.#ports.secrets.get(name);
      },
    };
    const guardedDynamicCode: NativeDynamicCodePort = {
      evaluate: async (source: string, signal = controller.signal) => {
        assertLive("dynamic-code.evaluate");
        await requireCapability("dynamic-code", "dynamic-code.evaluate");
        if (typeof source !== "string" || source.length > 256 * 1024) {
          throw new NativeExtensionError(
            "invalid-request",
            "Dynamic code source is invalid or too large.",
            {
              capability: "dynamic-code",
              operation: "dynamic-code.evaluate",
              vaultId,
            },
          );
        }
        if (!this.#ports.dynamicCode) {
          throw new NativeExtensionError(
            "capability-unavailable",
            "Dynamic-code port is unavailable.",
            {
              capability: "dynamic-code",
              operation: "dynamic-code.evaluate",
              vaultId,
            },
          );
        }
        return this.#ports.dynamicCode.evaluate(source, signal);
      },
    };
    return {
      extensionId: manifest.id,
      vaultId,
      runtime: this.#runtime,
      manifest: Object.freeze(manifest),
      signal: controller.signal,
      vault: guardedVault,
      network: guardedNetwork,
      clipboard: guardedClipboard,
      navigation: guardedNavigation,
      editor: guardedEditor,
      workspace: guardedWorkspace,
      subprocess: guardedSubprocess,
      secrets: guardedSecrets,
      dynamicCode: guardedDynamicCode,
      onTeardown: (callback) => {
        assertLive("onTeardown");
        teardownCallbacks.add(callback);
        return () => teardownCallbacks.delete(callback);
      },
    };
  }

  private async runTeardown(
    callbacks: Set<() => void | Promise<void>>,
    extensionId: string,
    vaultId: string,
  ): Promise<NativeExtensionError | null> {
    const pending = [...callbacks];
    callbacks.clear();
    let firstFailure: NativeExtensionError | null = null;
    for (const callback of pending) {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          Promise.resolve().then(callback),
          new Promise<never>(
            (_, reject) =>
              (timeout = setTimeout(
                () => reject(new Error("Native extension teardown deadline exceeded.")),
                this.#teardownTimeoutMs,
              )),
          ),
        ]);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Native extension teardown failed.";
        const failure = new NativeExtensionError("teardown", message, {
          operation: "teardown",
          vaultId,
          cause: error,
        });
        firstFailure ??= failure;
        this.recordDiagnostic(extensionId, failure.message);
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
      }
    }
    return firstFailure;
  }

  private async stopByKey(key: string, reason: "teardown"): Promise<void> {
    const active = this.#active.get(key);
    if (active) {
      await active.cancel(new NativeExtensionError(reason, "Native extension was stopped."));
    }
  }

  private assertRuntimeAvailable(manifest: NativeExtensionManifest): void {
    if (!this.runtimeAvailable(manifest)) {
      throw new NativeExtensionError(
        "runtime-unavailable",
        `Native extension ${manifest.id} cannot run in the ${this.#runtime} runtime.`,
      );
    }
  }

  private runtimeAvailable(manifest: NativeExtensionManifest): boolean {
    return !(manifest.desktopOnly && this.#runtime === "portable");
  }

  private registration(extensionId: string): Registration {
    const id = parseNativeExtensionId(extensionId);
    const registration = this.#registrations.get(id);
    if (!registration) {
      throw new NativeExtensionError("not-installed", `Native extension ${id} is not installed.`);
    }
    return registration;
  }

  private invocationKey(vaultId: string, extensionId: string): string {
    return `${vaultId}\u0000${extensionId}`;
  }

  private recordDiagnostic(extensionId: string, message: string): void {
    const diagnostics = this.#diagnostics.get(extensionId) ?? [];
    diagnostics.push(message);
    if (diagnostics.length > 20) {
      diagnostics.splice(0, diagnostics.length - 20);
    }
    this.#diagnostics.set(extensionId, diagnostics);
  }

  private assertHostOpen(): void {
    if (this.#closed) {
      throw new NativeExtensionError("host-closed", "Native extension host is closed.");
    }
  }
}
