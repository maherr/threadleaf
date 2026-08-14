import { readFileSync } from "node:fs";
import type { NativeExtensionManifest } from "../../../src/native-extension/manifest";
import { definePortableExtensionForTest } from "../../../src/native-extension/test-support";

export const notificationFixtureManifest: NativeExtensionManifest = {
  manifestVersion: 1,
  apiVersion: "1.0",
  id: "threadleaf.notifications",
  name: "Native notification fixture",
  version: "1.0.0",
  entrypoint: "bundle.js",
  portable: true,
  desktopOnly: false,
  capabilities: [{ id: "notifications", reason: "Show one completion notice." }],
};

export const notificationFixture = definePortableExtensionForTest({
  manifest: notificationFixtureManifest,
  bundleBytes: new Uint8Array(readFileSync(new URL("./bundle.js", import.meta.url))),
  entrypoint: async (context, message: string) => {
    await context.notifications.show(message);
    return { status: "shown" as const };
  },
});
