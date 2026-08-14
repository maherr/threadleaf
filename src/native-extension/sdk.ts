import {
  type NativeExtensionCapabilityId,
  type NativeExtensionManifest,
  type NativeExtensionRuntime,
  parseNativeExtensionManifest,
} from "./manifest";
import type {
  NativeClipboardPort,
  NativeDynamicCodePort,
  NativeEditorPort,
  NativeExternalNavigationPort,
  NativeNetworkPort,
  NativeSecretsPort,
  NativeSubprocessPort,
  NativeVaultPort,
  NativeWorkspacePort,
} from "./ports";

export interface NativeExtensionContext {
  readonly extensionId: string;
  readonly vaultId: string;
  readonly runtime: NativeExtensionRuntime;
  readonly manifest: Readonly<NativeExtensionManifest>;
  readonly signal: AbortSignal;
  readonly vault: NativeVaultPort;
  readonly network: NativeNetworkPort;
  readonly clipboard: NativeClipboardPort;
  readonly navigation: NativeExternalNavigationPort;
  readonly editor: NativeEditorPort;
  readonly workspace: NativeWorkspacePort;
  readonly subprocess: NativeSubprocessPort;
  readonly secrets: NativeSecretsPort;
  readonly dynamicCode: NativeDynamicCodePort;
  /** Register cleanup for host teardown. The callback must not start a new operation. */
  onTeardown(callback: () => void | Promise<void>): () => void;
}

/**
 * A production bundle is bytes plus its manifest. It deliberately has no callable entrypoint:
 * the production host must either evaluate verified bytes through a future runtime adapter or
 * fail closed. Function-injected fixtures live in the private test-support module.
 */
export interface NativeExtensionBundle {
  manifest: NativeExtensionManifest;
  bundleBytes: Uint8Array;
  /** Optional digest of the complete installed package tree, including metadata. */
  packageTreeSha256?: string;
}

export interface NativeExtensionDefinitionOptions {
  manifest: NativeExtensionManifest | unknown;
  bundleBytes: Uint8Array;
  packageTreeSha256?: string;
}

/** Construct the byte-only production bundle consumed by the capability host. */
export function defineNativeExtension(
  options: NativeExtensionDefinitionOptions,
): NativeExtensionBundle {
  return {
    manifest: parseNativeExtensionManifest(options.manifest),
    bundleBytes: new Uint8Array(options.bundleBytes),
    ...(options.packageTreeSha256 === undefined
      ? {}
      : { packageTreeSha256: options.packageTreeSha256 }),
  };
}

/** Restrict a definition at the type boundary for first-party portable workflows. */
export function definePortableExtension(
  options: NativeExtensionDefinitionOptions & {
    manifest: NativeExtensionManifest;
  },
): NativeExtensionBundle {
  const bundle = defineNativeExtension(options);
  if (!bundle.manifest.portable || bundle.manifest.desktopOnly) {
    throw new Error(
      "A portable extension definition must set portable=true and desktopOnly=false.",
    );
  }
  return bundle;
}

/** A small helper for SDK examples that need to advertise their requested authority. */
export function declaredNativeCapabilities(
  manifest: NativeExtensionManifest,
): NativeExtensionCapabilityId[] {
  return manifest.capabilities.map(({ id }) => id);
}
