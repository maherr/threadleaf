export function assertMainRendererPluginIpcSender(
  isMainRenderer: boolean,
  operation: string,
): void {
  if (!isMainRenderer) {
    throw new Error(`${operation} requires the active Threadleaf window.`);
  }
}
