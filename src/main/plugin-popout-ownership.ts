import type { BrowserWindow, WebContentsView } from "electron";

export function destroyedViewOwnsPluginPopout(
  destroyedView: WebContentsView,
  attachedView: WebContentsView | null,
  attachedHost: BrowserWindow | null,
  popoutWindow: BrowserWindow | null,
): boolean {
  return destroyedView === attachedView && attachedHost !== null && attachedHost === popoutWindow;
}
