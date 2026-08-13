import { createHash } from "node:crypto";
import type { NativeExtensionManifest, NativeExtensionManifestSummary } from "./manifest";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Hashes authority-bearing fields, not human display text or capability reasons. */
export function nativeExtensionAuthorityDigest(manifest: NativeExtensionManifest): string {
  const authority = {
    manifestVersion: manifest.manifestVersion,
    apiVersion: manifest.apiVersion,
    entrypoint: manifest.entrypoint,
    version: manifest.version,
    portable: manifest.portable,
    desktopOnly: manifest.desktopOnly,
    capabilities: manifest.capabilities.map(({ id }) => id),
  };
  return createHash("sha256").update(canonicalJson(authority), "utf8").digest("hex");
}

export function nativeExtensionBundleSha256(bundleBytes: Uint8Array): string {
  return createHash("sha256").update(bundleBytes).digest("hex");
}

export function summarizeNativeExtensionManifest(
  manifest: NativeExtensionManifest,
): NativeExtensionManifestSummary {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    entrypoint: manifest.entrypoint,
    portable: manifest.portable,
    desktopOnly: manifest.desktopOnly,
    capabilities: manifest.capabilities.map(({ id }) => id),
    authorityDigest: nativeExtensionAuthorityDigest(manifest),
  };
}
