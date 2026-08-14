import type { NativeExtensionBundle, NativeExtensionContext } from "./sdk";

/**
 * This module is intentionally not exported from the package or included as a build entrypoint.
 * The token is the only capability that lets a test host retain a function-injected entrypoint.
 */
export const nativeExtensionTestAccess = Symbol("threadleaf.native-extension.test-access");

export type NativeExtensionTestEntrypoint<Input = unknown, Output = unknown> = (
  context: NativeExtensionContext,
  input: Input,
) => Output | Promise<Output>;

export interface NativeExtensionTestBundle<Input = unknown, Output = unknown>
  extends NativeExtensionBundle {
  entrypoint: NativeExtensionTestEntrypoint<Input, Output>;
}
