import type { ColorSchemePreference } from "./appearance";
import type { ShortcutTargetId } from "./key-bindings";
import type { PluginCompatibilityReport } from "./plugins";

export type MigrationSourceState = "ready" | "absent" | "invalid" | "oversized";

export interface MigrationSourceFileSummary {
  path: string;
  state: MigrationSourceState;
  byteLength: number | null;
  message: string | null;
}

export type PluginSettingsMigrationState = "shared" | "absent" | "invalid" | "oversized";

export interface PluginSettingsMigrationSummary {
  state: PluginSettingsMigrationState;
  byteLength: number | null;
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
  compatibility: PluginCompatibilityReport | null;
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
  sources: MigrationSourceFileSummary[];
  plugins: PluginMigrationSummary[];
  hotkeys: HotkeyMigrationSummary[];
  appearance: AppearanceMigrationSummary;
  workspace: WorkspaceMigrationSummary;
  warnings: string[];
}

export type MigrationPreviewResponse =
  | { status: "ready"; preview: ObsidianMigrationPreview }
  | { status: "stale-vault"; vaultId: string };
