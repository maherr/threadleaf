import type { ColorSchemePreference } from "./appearance";
import type { ShortcutTargetId } from "./key-bindings";
import type { PluginCompatibilityReport } from "./plugins";

export type MigrationSourceState = "ready" | "absent" | "invalid" | "oversized";

export interface MigrationSourceFileSummary {
  path: string;
  state: MigrationSourceState;
  byteLength: number | null;
  sha256: string | null;
  /** A filesystem revision is retained for bounded files that are not hashed. */
  revision?: string | null;
  message: string | null;
}

/** A private, non-content source receipt used to bind a reviewed plan to the bytes observed. */
export interface MigrationSourceEvidence {
  path: string;
  state: MigrationSourceState;
  byteLength: number | null;
  sha256: string | null;
  /** A filesystem revision is retained for bounded files that are not hashed. */
  revision?: string | null;
}

export type PluginSettingsMigrationState = "shared" | "absent" | "invalid" | "oversized";

export interface PluginSettingsMigrationSummary {
  state: PluginSettingsMigrationState;
  byteLength: number | null;
  sha256: string | null;
  revision?: string | null;
  rootKind: "array" | "object" | "primitive" | null;
  topLevelEntryCount: number | null;
  message: string;
}

export interface PluginMigrationSummary {
  id: string;
  name: string;
  version: string | null;
  enabledInObsidian: boolean;
  selectedInThreadleaf: boolean;
  packageState: "ready" | "invalid" | "missing";
  authorityState: "unavailable" | "required" | "granted" | "stale";
  compatibility: PluginCompatibilityReport | null;
  sourceEvidence: MigrationSourceEvidence[];
  settings: PluginSettingsMigrationSummary;
  message: string;
}

export interface HotkeyMigrationSummary {
  commandId: string;
  bindings: string[];
  owner: "core" | "plugin" | "unknown";
  targetId: ShortcutTargetId | null;
  candidateBinding: string | null;
  state: "ready" | "review";
  message: string;
}

export interface AppearanceMigrationSummary {
  sourceColorScheme: string | null;
  colorSchemeCandidate: ColorSchemePreference | null;
  sourceThemeName: string | null;
  themeIdCandidate: string | null;
  themeAvailable: boolean;
  sourceSnippetNames: string[];
  snippetIdsCandidate: string[];
  missingSnippetNames: string[];
}

export interface WorkspaceViewTypeSummary {
  type: string;
  count: number;
}

export interface WorkspaceMigrationSummary {
  sourcePath: string | null;
  leafCount: number;
  restorablePaths: string[];
  missingPaths: string[];
  activePath: string | null;
  recentFileCount: number;
  unsupportedViewTypes: WorkspaceViewTypeSummary[];
}

export interface ObsidianMigrationPreview {
  vaultId: string;
  detected: boolean;
  readOnly: true;
  sourceDigest: string;
  sourceEvidence: MigrationSourceEvidence[];
  sources: MigrationSourceFileSummary[];
  plugins: PluginMigrationSummary[];
  hotkeys: HotkeyMigrationSummary[];
  appearance: AppearanceMigrationSummary;
  workspace: WorkspaceMigrationSummary;
  warnings: string[];
}

export type MigrationCandidateKind =
  | "plugin-enable"
  | "hotkey"
  | "appearance-scheme"
  | "appearance-theme"
  | "appearance-snippet"
  | "workspace";

export type MigrationCandidateStatus = "ready" | "review" | "unsupported" | "missing" | "conflict";

/** A safe before/after projection. It deliberately contains no plugin setting values. */
export interface MigrationCandidate {
  id: string;
  kind: MigrationCandidateKind;
  label: string;
  status: MigrationCandidateStatus;
  message: string;
  sourcePaths: string[];
  before: string | null;
  after: string | null;
}

export interface MigrationPrivateStateSummary {
  revision: string;
  enabledPluginIds: string[];
  colorScheme: ColorSchemePreference;
  themeId: string | null;
  enabledSnippetIds: string[];
  keyBindings: Record<string, string | null>;
  workspacePaths: string[];
  activeWorkspacePath: string | null;
}

export interface MigrationPlan {
  version: 1;
  planId: string;
  vaultId: string;
  sourceDigest: string;
  privateStateRevision: string;
  sourceEvidence: MigrationSourceEvidence[];
  candidates: MigrationCandidate[];
  before: MigrationPrivateStateSummary;
}

export interface MigrationApplyRequest {
  planId: string;
  sourceDigest: string;
  selectedItemIds: string[];
}

export interface MigrationApplyOutcome {
  status: "applied";
  transactionId: string;
  vaultId: string;
  planId: string;
  selectedItemIds: string[];
  skippedItemIds: string[];
  before: MigrationPrivateStateSummary;
  after: MigrationPrivateStateSummary;
  rollbackAvailable: true;
}

export type MigrationRollbackResponse =
  | {
      status: "rolled-back";
      transactionId: string;
      rollbackTransactionId: string;
      vaultId: string;
      before: MigrationPrivateStateSummary;
      after: MigrationPrivateStateSummary;
    }
  | {
      status: "conflict";
      vaultId: string;
      transactionId: string;
      message: string;
    };

export type MigrationPreviewResponse =
  | {
      status: "ready";
      preview: ObsidianMigrationPreview;
      plan: MigrationPlan;
      rollbackTransactionId: string | null;
    }
  | { status: "stale-vault"; vaultId: string };
