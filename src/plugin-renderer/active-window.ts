/**
 * Publish the renderer's actual Window object to the same realm in which the
 * compatibility bundle will evaluate. This is deliberately not a proxy and
 * cannot be replaced after bootstrap.
 */
export function installActiveWindowGlobal(rendererWindow: Window, target: typeof globalThis): void {
  const existing = Object.getOwnPropertyDescriptor(target, "activeWindow");
  if (existing && !existing.configurable) {
    if (existing.value !== rendererWindow) {
      throw new Error("The isolated renderer activeWindow binding is already occupied.");
    }
    return;
  }
  Object.defineProperty(target, "activeWindow", {
    configurable: false,
    enumerable: true,
    value: rendererWindow,
    writable: false,
  });
}
