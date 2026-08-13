import { createHash } from "node:crypto";

export const appearancePackageKinds = ["theme", "snippet"] as const;
export type AppearancePackageKind = (typeof appearancePackageKinds)[number];

export const appearancePackageActions = ["install", "uninstall", "rollback", "restore"] as const;
export type AppearancePackageAction = (typeof appearancePackageActions)[number];
export type AppearancePackageOperation =
  | "install"
  | "update"
  | "reinstall"
  | "uninstall"
  | "rollback"
  | "restore";

export interface AppearancePackageIndexItem {
  id: string;
  kind: AppearancePackageKind;
  name: string;
  version: string;
  description: string;
  repository: string | null;
  source: string;
  installedVersion: string | null;
  managed: boolean;
}

export interface AppearancePackageIndexSnapshot {
  vaultId: string;
  query: string;
  sourceUrl: string;
  sourceSha256: string;
  results: AppearancePackageIndexItem[];
}

export type AppearancePackageIndexResponse =
  | { status: "ready"; index: AppearancePackageIndexSnapshot }
  | { status: "stale-vault"; vaultId: string };

export interface AppearancePackageAssetEvidence {
  filename: string;
  sha256: string;
  size: number;
}

export interface AppearancePackageLicenseEvidence {
  filename: string;
  name: string;
  spdxId: string;
  sourceUrl: string | null;
  sha256: string;
  size: number;
  preview: string;
}

export interface AppearancePackageReadmeEvidence {
  filename: string;
  sha256: string;
  size: number;
  preview: string;
}

export interface AppearanceCssStaticReport {
  scannerVersion: 1;
  stylesheetSha256: string;
  stylesheetBytes: number;
  selectorCount: number;
  declarationCount: number;
  customPropertyCount: number;
  importCount: number;
  externalUrlCount: number;
  executableConstructCount: number;
  warnings: string[];
  valid: boolean;
}

export interface AppearancePackageProvenance {
  source: "local" | "bundled" | "retained";
  locator: string | null;
  sourceSha256: string;
}

export interface AppearancePackageReview {
  reviewId: string;
  vaultId: string;
  kind: AppearancePackageKind;
  operation: AppearancePackageOperation;
  packageId: string;
  name: string;
  installedVersion: string | null;
  targetVersion: string | null;
  targetPath: string;
  archiveSha256: string | null;
  provenance: AppearancePackageProvenance | null;
  /** Root archive entry that supplies a snippet's installed CSS file. */
  stylesheetFilename?: string;
  assets: AppearancePackageAssetEvidence[];
  license: AppearancePackageLicenseEvidence | null;
  readme: AppearancePackageReadmeEvidence | null;
  css: AppearanceCssStaticReport | null;
  createdAt: string;
  expiresAt: string;
  warnings: string[];
}

export interface AppearancePackagePreviewRequest {
  action: AppearancePackageAction;
  kind: AppearancePackageKind;
  packageId: string;
  version?: string;
}

export type AppearancePackagePreviewResponse =
  | { status: "ready"; review: AppearancePackageReview }
  | { status: "stale-vault"; vaultId: string };

export interface ManagedAppearancePackageHistory {
  snapshotId: string;
  version: string;
  archiveSha256: string | null;
  capturedAt: string;
  reason: "update" | "reinstall" | "uninstall" | "rollback" | "restore";
}

export interface ManagedAppearancePackageSummary {
  kind: AppearancePackageKind;
  packageId: string;
  currentVersion: string | null;
  targetPath: string;
  repository: string | null;
  installedAt: string | null;
  integrity: "verified" | "changed" | "not-installed";
  history: ManagedAppearancePackageHistory[];
}

export interface AppearancePackageApplyOutcome {
  kind: AppearancePackageKind;
  packageId: string;
  operation: AppearancePackageOperation;
  version: string | null;
  targetPath: string;
  selectionUnchanged: true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const packageIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/u;

function parsePackageId(value: unknown): string {
  if (typeof value !== "string" || !packageIdPattern.test(value)) {
    throw new Error("Appearance package identifiers must be bounded portable names.");
  }
  return value;
}

function parseVersion(value: unknown): string {
  if (typeof value !== "string" || !versionPattern.test(value)) {
    throw new Error("Appearance package versions must be bounded exact values.");
  }
  return value;
}

export function sha256AppearancePackage(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function parseAppearancePackagePreviewRequest(
  value: unknown,
): AppearancePackagePreviewRequest {
  if (
    !isRecord(value) ||
    !appearancePackageActions.includes(value.action as AppearancePackageAction) ||
    !appearancePackageKinds.includes(value.kind as AppearancePackageKind)
  ) {
    throw new Error(
      "Appearance package preview requires an install, uninstall, rollback, or restore action.",
    );
  }
  const packageId = parsePackageId(value.packageId);
  return {
    action: value.action as AppearancePackageAction,
    kind: value.kind as AppearancePackageKind,
    packageId,
    ...(value.version === undefined ? {} : { version: parseVersion(value.version) }),
  };
}
