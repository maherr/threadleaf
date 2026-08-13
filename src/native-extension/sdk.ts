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

export type NativeExtensionEntrypoint<Input = unknown, Output = unknown> = (
  context: NativeExtensionContext,
  input: Input,
) => Output | Promise<Output>;

export interface NativeExtensionBundle<Input = unknown, Output = unknown> {
  manifest: NativeExtensionManifest;
  bundleBytes: Uint8Array;
  entrypoint: NativeExtensionEntrypoint<Input, Output>;
}

export interface NativeExtensionDefinitionOptions<Input = unknown, Output = unknown> {
  manifest: NativeExtensionManifest | unknown;
  bundleBytes: Uint8Array;
  entrypoint: NativeExtensionEntrypoint<Input, Output>;
}

/** Construct the portable SDK bundle consumed by the capability host. */
export function defineNativeExtension<Input = unknown, Output = unknown>(
  options: NativeExtensionDefinitionOptions<Input, Output>,
): NativeExtensionBundle<Input, Output> {
  return {
    manifest: parseNativeExtensionManifest(options.manifest),
    bundleBytes: new Uint8Array(options.bundleBytes),
    entrypoint: options.entrypoint,
  };
}

/** Restrict a definition at the type boundary for first-party portable workflows. */
export function definePortableExtension<Input = unknown, Output = unknown>(
  options: NativeExtensionDefinitionOptions<Input, Output> & {
    manifest: NativeExtensionManifest;
  },
): NativeExtensionBundle<Input, Output> {
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
