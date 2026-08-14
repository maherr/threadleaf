import type { NativeExtensionBundle, NativeExtensionContext } from "./sdk";

/**
 * This module is intentionally not exported from the package and is not a build entrypoint.
 *
 * The real boundary is module reach, not this token: the registration seam lives in
 * `./internal-registry`, which nothing re-exports, so it is module-local state in the built bundle
 * and a JavaScript consumer has no route to it. `./test-support` imports that module directly from
 * source. A token cannot be a boundary once it is exported from anything a consumer can import, so
 * this symbol claims no authority. It brands a conformance host for diagnostics, and it is one of
 * the strings `scripts/check-native-extension-build-artifact.mjs` greps for, which is how a leak
 * of this module into a shipped bundle fails the build.
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
