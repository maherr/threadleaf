import type { NativeExtensionEntrypoint } from "../../../src/native-extension/sdk";

/** Entry points used by the conformance suite to exercise denied public-port calls. */
export const undeclaredNetwork: NativeExtensionEntrypoint = async (context) =>
  context.network.request({ url: "https://example.invalid" });

export const unavailableNetwork: NativeExtensionEntrypoint = async (context) =>
  context.network.request({ url: "https://example.invalid" });

export const partialWrite: NativeExtensionEntrypoint = async (context) =>
  context.vault.writeText({
    vaultId: context.vaultId,
    relativePath: "Nope.md",
    content: "no",
    expectedRevision: null,
  });

export const crossVaultRead: NativeExtensionEntrypoint = async (context) =>
  context.vault.readText({ vaultId: "vault-b", relativePath: "Welcome.md" });

export const traversalRead: NativeExtensionEntrypoint = async (context) =>
  context.vault.readText({ vaultId: context.vaultId, relativePath: "../outside.md" });
