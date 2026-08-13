import { readFileSync } from "node:fs";
import type { NativeExtensionManifest } from "../../../src/native-extension/manifest";
import { definePortableExtension } from "../../../src/native-extension/sdk";

export const portableSummaryManifest: NativeExtensionManifest = {
  manifestVersion: 1,
  apiVersion: "1.0",
  id: "threadleaf.portable-summary",
  name: "Portable summary fixture",
  version: "1.0.0",
  entrypoint: "bundle.js",
  portable: true,
  desktopOnly: false,
  capabilities: [{ id: "vault.read" }, { id: "vault.write" }],
};

export const portableSummaryFixture = definePortableExtension({
  manifest: portableSummaryManifest,
  bundleBytes: new Uint8Array(readFileSync(new URL("./bundle.js", import.meta.url))),
  entrypoint: async (context, input: { path: string; outputPath: string }) => {
    const note = await context.vault.readText({
      vaultId: context.vaultId,
      relativePath: input.path,
    });
    return context.vault.writeText({
      vaultId: context.vaultId,
      relativePath: input.outputPath,
      content: `# Portable summary\n\n${note.content.split("\n")[0] ?? "(empty note)"}\n`,
      expectedRevision: null,
    });
  },
});
