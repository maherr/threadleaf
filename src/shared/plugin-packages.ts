import { type PluginCapabilityReport, type PluginManifestData, parsePluginId } from "./plugins";

export const pluginPackageActions = ["install", "uninstall", "rollback"] as const;

export type PluginPackageAction = (typeof pluginPackageActions)[number];
export type PluginPackageOperation = "install" | "update" | "reinstall" | "uninstall" | "rollback";

export interface PluginPackageIndexItem {
  id: string;
  name: string;
  author: string;
  description: string;
  repository: string;
  installedVersion: string | null;
  managed: boolean;
}

export interface PluginPackageIndexSnapshot {
  vaultId: string;
  query: string;
  sourceUrl: string;
  sourceSha256: string;
  results: PluginPackageIndexItem[];
}

export type PluginPackageIndexResponse =
  | { status: "ready"; index: PluginPackageIndexSnapshot }
  | { status: "stale-vault"; vaultId: string };

export interface PluginPackageAssetEvidence {
  filename: "manifest.json" | "main.js" | "styles.css";
  sha256: string;
  size: number;
}

export interface PluginPackageLicenseEvidence {
  filename: "LICENSE.threadleaf.txt";
  name: string;
  sourceUrl: string;
  spdxId: string;
  sha256: string;
  size: number;
}

export interface PluginPackageInspectionProvenance {
  kind: "fixture" | "local" | "release";
  pluginId: string;
  version: string;
  releaseTag: string;
  sourceUrl: string | null;
  releaseUrl: string | null;
  indexUrl: string | null;
  indexSha256: string | null;
}

/**
 * The one persisted authority receipt for an exact reviewed package. It is deliberately a
 * compact projection of the full inspector report: enough to bind the installed bytes,
 * provenance, and static authority report without retaining runtime paths or source snippets.
 */
export interface PluginPackageInspectionReceipt {
  schemaVersion: 1;
  tool: {
    id: "threadleaf-plugin-package-inspector";
    version: string;
  };
  overall: "pass" | "fail" | "blocked";
  exactPackage: {
    id: string;
    version: string;
    bundleSha256: string;
    manifestSha256: string;
    stylesSha256: string | null;
    provenance: PluginPackageInspectionProvenance;
  };
  assets: PluginPackageAssetEvidence[];
  staticAuthority: PluginCapabilityReport;
  compatibilityLevel: 0 | 1 | 2 | 3;
  limitations: string[];
}

export interface PluginPackageReview {
  reviewId: string;
  vaultId: string;
  operation: PluginPackageOperation;
  pluginId: string;
  manifest: PluginManifestData | null;
  installedVersion: string | null;
  targetVersion: string | null;
  repository: string | null;
  releaseUrl: string | null;
  indexUrl: string | null;
  indexSha256: string | null;
  assets: PluginPackageAssetEvidence[];
  license: PluginPackageLicenseEvidence | null;
  inspection: PluginPackageInspectionReceipt | null;
  createdAt: string;
  expiresAt: string;
  warnings: string[];
}

export interface PluginPackagePreviewRequest {
  action: PluginPackageAction;
  pluginId: string;
  version?: string;
}

export type PluginPackagePreviewResponse =
  | { status: "ready"; review: PluginPackageReview }
  | { status: "stale-vault"; vaultId: string };

export interface ManagedPluginPackageHistory {
  snapshotId: string;
  version: string;
  capturedAt: string;
  reason: "update" | "reinstall" | "uninstall" | "rollback";
}

export interface ManagedPluginPackageSummary {
  pluginId: string;
  currentVersion: string | null;
  repository: string | null;
  installedAt: string | null;
  integrity: "verified" | "changed" | "not-installed";
  history: ManagedPluginPackageHistory[];
}

export interface PluginPackageApplyOutcome {
  operation: PluginPackageOperation;
  pluginId: string;
  version: string | null;
  disabled: true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePluginPackagePreviewRequest(value: unknown): PluginPackagePreviewRequest {
  if (
    !isRecord(value) ||
    !pluginPackageActions.includes(value.action as PluginPackageAction) ||
    (value.version !== undefined && typeof value.version !== "string")
  ) {
    throw new Error("Plugin package preview requires install, uninstall, or rollback input.");
  }
  return {
    action: value.action as PluginPackageAction,
    pluginId: parsePluginId(value.pluginId),
    ...(value.version === undefined ? {} : { version: value.version }),
  };
}
