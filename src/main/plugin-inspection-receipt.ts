import { createHash } from "node:crypto";
import type {
  PluginPackageAssetEvidence,
  PluginPackageInspectionProvenance,
  PluginPackageInspectionReceipt,
} from "../shared/plugin-packages";
import {
  type PluginCapabilityId,
  type PluginCapabilityReport,
  type PluginManifestData,
  parsePluginId,
  pluginCapabilityIds,
} from "../shared/plugins";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/u;
const provenanceKinds = new Set(["fixture", "local", "release"]);
const inspectionToolId = "threadleaf-plugin-package-inspector";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`Inspection receipt ${label} is invalid.`);
  }
  return value;
}

function requireHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw new Error(`Inspection receipt ${label} is not a SHA-256 digest.`);
  }
  return value;
}

function parseNullableUrl(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }
  return requireString(value, label, 500);
}

function parseProvenance(value: unknown): PluginPackageInspectionProvenance {
  if (!isRecord(value) || typeof value.kind !== "string" || !provenanceKinds.has(value.kind)) {
    throw new Error("Inspection receipt provenance is invalid.");
  }
  const pluginId = parsePluginId(value.pluginId);
  const version = requireString(value.version, "provenance version", 100);
  const releaseTag = requireString(value.releaseTag, "provenance release tag", 100);
  if (!versionPattern.test(version) || !versionPattern.test(releaseTag) || version !== releaseTag) {
    throw new Error("Inspection receipt provenance must carry one exact release version.");
  }
  return {
    kind: value.kind as PluginPackageInspectionProvenance["kind"],
    pluginId,
    version,
    releaseTag,
    sourceUrl: parseNullableUrl(value.sourceUrl, "provenance source URL"),
    releaseUrl: parseNullableUrl(value.releaseUrl, "provenance release URL"),
    indexUrl: parseNullableUrl(value.indexUrl, "provenance index URL"),
    indexSha256: value.indexSha256 === null ? null : requireHash(value.indexSha256, "index digest"),
  };
}

function parseAssets(value: unknown): PluginPackageAssetEvidence[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 3) {
    throw new Error(
      "Inspection receipt must list manifest.json, main.js, and optional styles.css.",
    );
  }
  const allowed = new Set(["manifest.json", "main.js", "styles.css"]);
  const assets = value.map((raw): PluginPackageAssetEvidence => {
    if (
      !isRecord(raw) ||
      typeof raw.filename !== "string" ||
      !allowed.has(raw.filename) ||
      typeof raw.size !== "number" ||
      !Number.isSafeInteger(raw.size) ||
      raw.size < 0
    ) {
      throw new Error("Inspection receipt contains an invalid asset entry.");
    }
    return {
      filename: raw.filename as PluginPackageAssetEvidence["filename"],
      size: raw.size,
      sha256: requireHash(raw.sha256, `${raw.filename} digest`),
    };
  });
  if (
    new Set(assets.map((asset) => asset.filename)).size !== assets.length ||
    !assets.some((asset) => asset.filename === "manifest.json") ||
    !assets.some((asset) => asset.filename === "main.js")
  ) {
    throw new Error("Inspection receipt asset set is incomplete or duplicated.");
  }
  return assets;
}

function parseStaticAuthority(value: unknown): PluginCapabilityReport {
  if (
    !isRecord(value) ||
    value.scannerVersion !== 1 ||
    value.staticOnly !== true ||
    !Array.isArray(value.capabilities) ||
    !Array.isArray(value.findings)
  ) {
    throw new Error("Inspection receipt static authority report is invalid.");
  }
  const capabilities = value.capabilities.map((raw): PluginCapabilityId => {
    if (typeof raw !== "string" || !pluginCapabilityIds.includes(raw as PluginCapabilityId)) {
      throw new Error("Inspection receipt contains an unknown static authority.");
    }
    return raw as PluginCapabilityId;
  });
  if (new Set(capabilities).size !== capabilities.length) {
    throw new Error("Inspection receipt static authorities are duplicated.");
  }
  const findings = value.findings.map((raw) => {
    if (!isRecord(raw) || typeof raw.capability !== "string" || !Array.isArray(raw.evidence)) {
      throw new Error("Inspection receipt contains an invalid static authority finding.");
    }
    if (!pluginCapabilityIds.includes(raw.capability as PluginCapabilityId)) {
      throw new Error("Inspection receipt contains an unknown finding authority.");
    }
    const evidence = raw.evidence.map((item) => requireString(item, "authority evidence", 500));
    return { capability: raw.capability as PluginCapabilityId, evidence };
  });
  if (
    new Set(findings.map((finding) => finding.capability)).size !== findings.length ||
    findings.some((finding) => !capabilities.includes(finding.capability))
  ) {
    throw new Error("Inspection receipt findings do not match its static authorities.");
  }
  return {
    scannerVersion: 1,
    bundleSha256: requireHash(value.bundleSha256, "static bundle digest"),
    capabilities,
    findings,
    staticOnly: true,
  };
}

export function parsePluginPackageInspectionReceipt(
  value: unknown,
): PluginPackageInspectionReceipt {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isRecord(value.tool) ||
    value.tool.id !== inspectionToolId ||
    typeof value.tool.version !== "string" ||
    !["pass", "fail", "blocked"].includes(String(value.overall)) ||
    !isRecord(value.exactPackage) ||
    typeof value.exactPackage.id !== "string" ||
    typeof value.exactPackage.version !== "string" ||
    typeof value.compatibilityLevel !== "number" ||
    !Number.isInteger(value.compatibilityLevel) ||
    value.compatibilityLevel < 0 ||
    value.compatibilityLevel > 3 ||
    !Array.isArray(value.limitations)
  ) {
    throw new Error("Inspection receipt has an invalid shape.");
  }
  const exactPackage = value.exactPackage;
  const id = parsePluginId(exactPackage.id);
  const version = requireString(exactPackage.version, "package version", 100);
  if (!versionPattern.test(version)) {
    throw new Error("Inspection receipt package version is invalid.");
  }
  const provenance = parseProvenance(exactPackage.provenance);
  if (provenance.pluginId !== id || provenance.version !== version) {
    throw new Error("Inspection receipt package and provenance identities differ.");
  }
  const assets = parseAssets(value.assets);
  const manifest = assets.find((asset) => asset.filename === "manifest.json");
  const main = assets.find((asset) => asset.filename === "main.js");
  const styles = assets.find((asset) => asset.filename === "styles.css");
  if (
    exactPackage.manifestSha256 !== manifest?.sha256 ||
    exactPackage.bundleSha256 !== main?.sha256 ||
    (exactPackage.stylesSha256 ?? null) !== (styles?.sha256 ?? null)
  ) {
    throw new Error("Inspection receipt exact-package hashes do not match its assets.");
  }
  const staticAuthority = parseStaticAuthority(value.staticAuthority);
  if (staticAuthority.bundleSha256 !== exactPackage.bundleSha256) {
    throw new Error("Inspection receipt static authority is bound to another bundle.");
  }
  const limitations = value.limitations.map((item) => requireString(item, "limitation", 1_000));
  return {
    schemaVersion: 1,
    tool: { id: inspectionToolId, version: requireString(value.tool.version, "tool version", 100) },
    overall: value.overall as PluginPackageInspectionReceipt["overall"],
    exactPackage: {
      id,
      version,
      bundleSha256: exactPackage.bundleSha256 as string,
      manifestSha256: exactPackage.manifestSha256 as string,
      stylesSha256: (exactPackage.stylesSha256 ?? null) as string | null,
      provenance,
    },
    assets,
    staticAuthority,
    compatibilityLevel: value.compatibilityLevel as 0 | 1 | 2 | 3,
    limitations,
  };
}

export interface PluginPackageAssetBytesForReceipt {
  manifest: Uint8Array;
  main: Uint8Array;
  styles: Uint8Array | null;
}

export function verifyPluginPackageInspectionReceipt(
  value: unknown,
  pluginId: string,
  manifest: PluginManifestData,
  assets: PluginPackageAssetBytesForReceipt,
): { receipt: PluginPackageInspectionReceipt | null; error: string | null } {
  try {
    const receipt = parsePluginPackageInspectionReceipt(value);
    const actualAssets = new Map<string, { size: number; sha256: string }>([
      ["manifest.json", { size: assets.manifest.byteLength, sha256: hash(assets.manifest) }],
      ["main.js", { size: assets.main.byteLength, sha256: hash(assets.main) }],
    ]);
    if (assets.styles) {
      actualAssets.set("styles.css", {
        size: assets.styles.byteLength,
        sha256: hash(assets.styles),
      });
    }
    if (
      receipt.exactPackage.id !== pluginId ||
      receipt.exactPackage.id !== manifest.id ||
      receipt.exactPackage.version !== manifest.version
    ) {
      throw new Error("Inspection receipt package identity does not match the installed manifest.");
    }
    for (const [filename, actual] of actualAssets) {
      const expected = receipt.assets.find((asset) => asset.filename === filename);
      if (!expected || expected.size !== actual.size || expected.sha256 !== actual.sha256) {
        throw new Error(`Inspection receipt ${filename} bytes differ from the installed package.`);
      }
    }
    if (receipt.assets.some((asset) => !actualAssets.has(asset.filename))) {
      throw new Error("Inspection receipt lists an asset that is not installed.");
    }
    if (receipt.staticAuthority.bundleSha256 !== hash(assets.main)) {
      throw new Error("Inspection receipt authority digest differs from main.js.");
    }
    return { receipt, error: null };
  } catch (error) {
    return { receipt: null, error: errorMessage(error) };
  }
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
