import {
  NativeExtensionHost,
  type NativeExtensionHostOptions,
  type NativeExtensionReview,
} from "./host";
import { type NativeExtensionManifest, parseNativeExtensionManifest } from "./manifest";
import type { NativeExtensionTrustProvenance } from "./marketplace-trust";
import type { NativeExtensionContext } from "./sdk";
import { defineNativeExtension, type NativeExtensionBundle } from "./sdk";
import type { NativeExtensionTestBundle } from "./test-access";

export type { NativeExtensionTestBundle, NativeExtensionTestEntrypoint } from "./test-access";

export interface NativeExtensionTestDefinitionOptions<Input = unknown, Output = unknown> {
  manifest: NativeExtensionManifest | unknown;
  bundleBytes: Uint8Array;
  entrypoint: import("./test-access").NativeExtensionTestEntrypoint<Input, Output>;
}

/**
 * Test-only construction for the in-process conformance host. This module is not a package export
 * and is never a production build entrypoint. Production bundles are byte-only.
 */
export function defineNativeExtensionForTest<Input = unknown, Output = unknown>(
  options: NativeExtensionTestDefinitionOptions<Input, Output>,
): NativeExtensionTestBundle<Input, Output> {
  const bundle: NativeExtensionBundle = defineNativeExtension({
    manifest: options.manifest,
    bundleBytes: options.bundleBytes,
  });
  return {
    ...bundle,
    entrypoint: options.entrypoint,
  };
}

export function definePortableExtensionForTest<Input = unknown, Output = unknown>(
  options: NativeExtensionTestDefinitionOptions<Input, Output> & {
    manifest: NativeExtensionManifest;
  },
): NativeExtensionTestBundle<Input, Output> {
  const bundle = defineNativeExtensionForTest(options);
  const manifest = parseNativeExtensionManifest(bundle.manifest);
  if (!manifest.portable || manifest.desktopOnly) {
    throw new Error("A portable test extension must set portable=true and desktopOnly=false.");
  }
  return bundle;
}

class NativeExtensionConformanceHost extends NativeExtensionHost {
  override register<Input = unknown, Output = unknown>(
    bundle: NativeExtensionTestBundle<Input, Output>,
  ): NativeExtensionReview {
    const manifest = parseNativeExtensionManifest(bundle.manifest);
    if (typeof bundle.entrypoint !== "function") {
      throw new Error("Native extension test entrypoint is not callable.");
    }
    const testOnlyHost = this as unknown as {
      replaceRegistration: (
        bundle: NativeExtensionBundle,
        entrypoint: (context: NativeExtensionContext, input: unknown) => unknown | Promise<unknown>,
        verification: null,
        trust: {
          distributionTrust: "unsigned-development";
          publisherFingerprint: null;
          trustProvenance: NativeExtensionTrustProvenance;
        },
      ) => NativeExtensionReview;
    };
    return testOnlyHost.replaceRegistration(
      {
        manifest,
        bundleBytes: new Uint8Array(bundle.bundleBytes),
        ...(bundle.packageTreeSha256 === undefined
          ? {}
          : { packageTreeSha256: bundle.packageTreeSha256 }),
      },
      bundle.entrypoint as (context: NativeExtensionContext, input: unknown) => unknown,
      null,
      {
        distributionTrust: "unsigned-development",
        publisherFingerprint: null,
        trustProvenance: {
          distributionTrust: "unsigned-development",
          metadataSha256: null,
          publisherId: null,
          publisherKeyId: null,
          publisherFingerprint: null,
          keyTrust: "none",
          marketplaceIndex: "not-applicable",
          marketplaceCatalogRevision: null,
          marketplaceCatalogSha256: null,
          marketplaceCatalogRootFingerprint: null,
          packageTreeSha256: null,
          installedTreeEvidence: "none",
        },
      },
    );
  }
}

/** Construct a test-only host for callable conformance fixtures. */
export function createNativeExtensionTestHost(
  options: NativeExtensionHostOptions,
): NativeExtensionHost {
  return new NativeExtensionConformanceHost(options);
}

export type { NativeExtensionContext };
