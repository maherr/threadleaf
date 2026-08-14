import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { signedDistributionBundle } from "../../fixtures/native-extensions/signed-distribution/index";
import { NativeExtensionHost, type NativeExtensionInstallOptions } from "./host";
import {
  nativeExtensionPublisherKeyFromKeyObject,
  signNativeExtensionManifest,
} from "./marketplace-trust";
import type { NativeVaultPort } from "./ports";

const vaultPort = {} as NativeVaultPort;
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(appRoot, relativePath), "utf8");
}

/**
 * A genuinely installable signed record. The wrong-mode test must present metadata that would
 * otherwise succeed, or removing the mode gate still throws for an unrelated reason and the test
 * cannot see the difference.
 */
function installableDistribution() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const publisherKey = nativeExtensionPublisherKeyFromKeyObject({
    publisherId: "fixture.publisher",
    keyId: "key-1",
    key: privateKey,
  });
  const metadata = signNativeExtensionManifest(
    {
      manifest: signedDistributionBundle.manifest,
      bundleBytes: signedDistributionBundle.bundleBytes,
      publisher: publisherKey,
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2027-01-01T00:00:00.000Z",
    },
    privateKey,
  );
  return { metadata, publisherKey };
}

/**
 * The production host must refuse every install that is not an explicit signed trusted
 * distribution. These are the runtime gates behind the single-member install-mode union, so a
 * JavaScript caller that ignores the type cannot reach an unsigned install.
 */
describe("native extension production install gate", () => {
  it("refuses callable registration on a production host", async () => {
    const host = new NativeExtensionHost({ ports: { vault: vaultPort } });
    expect(() => host.register(signedDistributionBundle)).toThrow(
      expect.objectContaining({ code: "distribution-untrusted" }),
    );
    await host.close();
  });

  it("refuses an install with no options at all", async () => {
    const host = new NativeExtensionHost({ ports: { vault: vaultPort } });
    // The message is asserted, not just the code: every later trust failure raises the same code,
    // so a code-only assertion stays green even when this guard is replaced by a default.
    expect(() => host.install(signedDistributionBundle)).toThrow(
      expect.objectContaining({
        code: "distribution-untrusted",
        message: "Native extension install requires an explicit trust mode.",
      }),
    );
    await host.close();
  });

  it("refuses an unsigned-development install mode forced past the type", async () => {
    const { metadata, publisherKey } = installableDistribution();
    const host = new NativeExtensionHost({ ports: { vault: vaultPort } });

    // Control: this exact payload installs when the mode is right, so any refusal below is the
    // mode gate and not a signature, publisher, or freshness failure.
    expect(
      host.install(signedDistributionBundle, {
        mode: "trusted-distribution",
        metadata,
        trustedPublishers: [publisherKey],
      }).distributionTrust,
    ).toBe("trusted-distribution");

    for (const mode of ["unsigned-development", "development", "", "TRUSTED-DISTRIBUTION"]) {
      const forced = {
        mode,
        metadata,
        trustedPublishers: [publisherKey],
      } as unknown as NativeExtensionInstallOptions;
      expect(() => host.install(signedDistributionBundle, forced)).toThrow(
        expect.objectContaining({
          code: "distribution-untrusted",
          message: "Trusted distribution install requires signed metadata.",
        }),
      );
    }
    await host.close();
  });

  it("refuses a trusted-distribution install that carries no signed metadata", async () => {
    const host = new NativeExtensionHost({ ports: { vault: vaultPort } });
    // reviewDistribution repeats this check with its own wording, so pin the install-level
    // message to keep both layers independently covered.
    for (const options of [
      { mode: "trusted-distribution" } as const,
      { mode: "trusted-distribution", metadata: undefined } as const,
    ]) {
      expect(() => host.install(signedDistributionBundle, options)).toThrow(
        expect.objectContaining({
          code: "distribution-untrusted",
          message: "Trusted distribution install requires signed metadata.",
        }),
      );
    }
    // The second layer stands on its own if the first is ever removed.
    expect(() =>
      host.reviewDistribution(signedDistributionBundle, { metadata: undefined }),
    ).toThrow(
      expect.objectContaining({
        code: "distribution-untrusted",
        message: "Trusted distribution review requires signed metadata.",
      }),
    );
    await host.close();
  });
});

/**
 * Source-level half of `scripts/check-native-extension-build-artifact.mjs`. That script also
 * inspects `dist`, so it only runs after a build; these assertions hold the same boundary on every
 * ordinary test run, which is when the boundary is most likely to be broken.
 */
describe("native extension test-only boundary", () => {
  const testOnlyMarkers = [
    "./test-support",
    "./test-access",
    "defineNativeExtensionForTest",
    "nativeExtensionTestAccess",
  ];

  it("keeps test-only material out of every production source file", () => {
    for (const productionSourcePath of [
      "src/native-extension/digest.ts",
      "src/native-extension/errors.ts",
      "src/native-extension/host.ts",
      "src/native-extension/index.ts",
      "src/native-extension/manifest.ts",
      "src/native-extension/marketplace-trust.ts",
      "src/native-extension/ports.ts",
      "src/native-extension/sdk.ts",
    ]) {
      const source = readSource(productionSourcePath);
      for (const marker of testOnlyMarkers) {
        expect(`${productionSourcePath}:${source.includes(marker)}`).toBe(
          `${productionSourcePath}:false`,
        );
      }
    }
  });

  it("keeps test-only source out of the build entries and package exports", () => {
    const tsup = readSource("tsup.config.ts");
    for (const forbiddenEntry of [
      "src/native-extension/test-access.ts",
      "src/native-extension/test-support.ts",
    ]) {
      expect(tsup.includes(forbiddenEntry)).toBe(false);
    }
    const serializedExports = JSON.stringify(
      (JSON.parse(readSource("package.json")) as { exports?: unknown }).exports ?? {},
    );
    for (const forbiddenExport of ["test-support", "test-access", "defineNativeExtensionForTest"]) {
      expect(serializedExports.includes(forbiddenExport)).toBe(false);
    }
  });

  it("keeps a callable entrypoint type off the production SDK surface", () => {
    const sdk = readSource("src/native-extension/sdk.ts");
    expect(sdk.includes("NativeExtensionEntrypoint")).toBe(false);
    // Comments legitimately discuss the absent entrypoint, so assert on code only. A bare
    // substring check here passes on prose and would not notice a restored declaration.
    const code = sdk.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code.includes("entrypoint")).toBe(false);
  });
});
