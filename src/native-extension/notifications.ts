/**
 * Limits for the local notification surface. These are deliberately small because the
 * capability targets an in-app notice or toast, not a durable notification store or OS service.
 */
export const nativeNotificationLimits = {
  maxMessageLength: 4_096,
  maxPerInvocation: 8,
  maxPerWindow: 20,
  windowMs: 60_000,
} as const;

/** The only payload accepted by the native notification capability. */
export interface NativeNotificationPort {
  show(message: string): Promise<void>;
}

/** A host-owned callback for the application's existing visible notice or toast surface. */
export type NativeNotificationSink = (message: string) => void | Promise<void>;

/**
 * Adapt the application's existing notice surface to the native extension port. The extension
 * receives no Electron object, BrowserWindow, DOM node, or operating-system notification handle.
 */
export function bindNativeNotificationPort(sink: NativeNotificationSink): NativeNotificationPort {
  return {
    show: async (message) => {
      await sink(message);
    },
  };
}
