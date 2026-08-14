import { readFileSync } from "node:fs";
import type { NativeExtensionManifest } from "../../../src/native-extension/manifest";
import { definePortableExtensionForTest } from "../../../src/native-extension/test-support";

/** A public bundle fixture. Signatures and keys are generated in tests, never stored here. */
export const signedDistributionManifest: NativeExtensionManifest = {
  manifestVersion: 1,
  apiVersion: "1.0",
  id: "threadleaf.signed-summary",
  name: "Signed summary fixture",
  version: "1.0.0",
  entrypoint: "bundle.js",
  portable: true,
  desktopOnly: false,
  capabilities: [
    { id: "vault.read", reason: "Read one selected note for the fixture workflow." },
    { id: "vault.write", reason: "Write the generated summary through the public vault port." },
  ],
};

export const signedDistributionBundle = definePortableExtensionForTest({
  manifest: signedDistributionManifest,
  bundleBytes: new Uint8Array(readFileSync(new URL("./bundle.js", import.meta.url))),
  entrypoint: async (context, input: { path: string; outputPath: string }) => {
    const note = await context.vault.readText({
      vaultId: context.vaultId,
      relativePath: input.path,
    });
    return context.vault.writeText({
      vaultId: context.vaultId,
      relativePath: input.outputPath,
      content: `# Signed summary\n\n${note.content.split("\n")[0] ?? "(empty note)"}\n`,
      expectedRevision: null,
    });
  },
});
