import type { NativeExtensionReview } from "./host";
import type {
  NativeExtensionTrustProvenance,
  NativeExtensionVerification,
} from "./marketplace-trust";
import type { NativeExtensionBundle, NativeExtensionContext } from "./sdk";

/**
 * The registration seam that can attach a callable entrypoint.
 *
 * This module is deliberately absent from `./index`, from `package.json` exports, and from the
 * tsup entry list. It is bundled into the built artifact as module-local state with no export
 * binding, so a JavaScript consumer holding a host instance has no route to it: that is the whole
 * boundary, and it does not depend on a token, a naming convention, or TypeScript visibility,
 * which are all erased at runtime. Test support imports this module directly from source.
 */
export interface NativeExtensionHostInternals {
  replaceRegistration(
    bundle: NativeExtensionBundle,
    entrypoint:
      | ((context: NativeExtensionContext, input: unknown) => unknown | Promise<unknown>)
      | undefined,
    verification: NativeExtensionVerification | null,
    trust: {
      distributionTrust: NativeExtensionReview["distributionTrust"];
      publisherFingerprint: string | null;
      trustProvenance: NativeExtensionTrustProvenance;
    },
  ): NativeExtensionReview;
}

export const nativeExtensionHostInternals = new WeakMap<object, NativeExtensionHostInternals>();
