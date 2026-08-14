import type { BrowserWindow, WebContentsView } from "electron";

/**
 * Checks a single (destroyedView, attachedView, attachedHost, popoutWindow)
 * snapshot for pop-out ownership. This is a pure, stateless predicate: it
 * holds no registry of live pop-outs and compares only the four references
 * it is given for this one call.
 *
 * Double registration (e.g. the same view attached as the "owner" of two
 * pop-out windows at once, or two different views both believing they own
 * the same host) is therefore undefined behavior at this layer: there is
 * no state here in which "double" could even be detected. Preventing it is
 * the responsibility of whatever holds the actual attachment state (the
 * future wiring lane), which must ensure at most one live triple exists per
 * pop-out before calling this function; this module only ever validates one
 * candidate triple against itself.
 */
export function destroyedViewOwnsPluginPopout(
  destroyedView: WebContentsView,
  attachedView: WebContentsView | null,
  attachedHost: BrowserWindow | null,
  popoutWindow: BrowserWindow | null,
): boolean {
  return destroyedView === attachedView && attachedHost !== null && attachedHost === popoutWindow;
}
