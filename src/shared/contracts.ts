import type { AppearanceResponse, AppearanceSnapshot, VaultAppearanceSettings } from "./appearance";
import type { AppSettingsSnapshot, ShortcutTargetId } from "./key-bindings";
import type { MigrationPreviewResponse } from "./migration";
import type { CompatibilityMode, PluginCatalogResponse, PluginCatalogSnapshot } from "./plugins";

export type AppearanceUpdateResponse =
  | {
      status: "updated";
      settings: AppSettingsSnapshot;
      appearance: AppearanceSnapshot;
    }
  | { status: "stale-vault"; vaultId: string };

export type PluginUpdateResponse =
  | {
      status: "updated";
      settings: AppSettingsSnapshot;
      catalog: PluginCatalogSnapshot;
      snapshot: RuntimeSnapshot;
    }
  | { status: "stale-vault"; vaultId: string };

export type PluginRuntimeState = "empty" | "loaded" | "unloaded" | "failed";

export type RuntimeEventKind = "runtime" | "plugin" | "command" | "notice" | "error";

export interface RuntimeEvent {
  sequence: number;
  kind: RuntimeEventKind;
  message: string;
}

export interface CommandSummary {
  id: string;
  name: string;
  ownerId: string;
}

export interface ActionSummary {
  id: string;
  name: string;
  source: "workspace" | "plugin" | "system";
}

export interface PluginSummary {
  id: string;
  name: string;
  version: string;
  state: PluginRuntimeState;
  compatibilityLevel: 0 | 1 | 2 | 3 | 4;
  stylesheetDiscovered: boolean;
  error: string | null;
}

export interface PluginExtensionRegistration {
  extension: string;
  viewType: string;
}

export interface PluginIntegrationSnapshot {
  editorSuggests: number;
  extensions: PluginExtensionRegistration[];
  markdownPostProcessors: number;
  ribbonItems: number;
  settingTabs: number;
  settingTabPluginIds?: string[];
  statusBarItems: number;
  viewTypes: string[];
}

export interface PluginSurfaceSnapshot {
  displayText: string;
  filePath: string | null;
  viewType: string;
}

export interface PluginSurfaceBounds {
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface PluginEditorSelection {
  anchor: number;
  head: number;
}

export interface PluginEditorContext {
  content: string;
  path: string;
  revision: string;
  selection: PluginEditorSelection;
}

export interface PluginEditorUpdate {
  baseContent: string;
  content: string;
  focused: boolean;
  id: string;
  path: string;
  revision: string;
  selection: PluginEditorSelection;
}

export type VaultSelectionSource = "bundled" | "direct" | "environment" | "picked" | "restored";

export interface VaultStartupSnapshot {
  phase: "opening";
  source: Extract<VaultSelectionSource, "environment" | "restored">;
  targetName: string;
  targetPath: string;
}

export interface RuntimeSnapshot {
  vault: {
    id: string | null;
    name: string;
    path: string;
    markdownFileCount: number;
    mode: "synthetic-read-only" | "kernel-backed";
    source: VaultSelectionSource;
    warning: string | null;
  };
  startup?: VaultStartupSnapshot;
  plugin: PluginSummary | null;
  plugins?: PluginSummary[];
  commands: CommandSummary[];
  actions: ActionSummary[];
  notices: string[];
  events: RuntimeEvent[];
  integrations?: PluginIntegrationSnapshot;
  editorUpdate?: PluginEditorUpdate | null;
  pluginSurface?: PluginSurfaceSnapshot | null;
  workspace?: WorkspaceSnapshot;
}

export interface WorkspaceFileSummary {
  path: string;
  title: string;
  tags: string[];
  backlinkCount: number;
  outgoingCount: number;
  unresolvedCount: number;
}

export interface WorkspaceTabSummary {
  path: string;
  title: string;
  active: boolean;
}

export interface WorkspaceLinkSummary {
  label: string;
  status: "resolved" | "unresolved" | "ambiguous";
  path?: string;
  target?: string;
  subpath?: string | null;
  embed?: boolean;
  syntax?: "wiki" | "markdown";
}

export interface WorkspaceNoteSnapshot {
  path: string;
  title: string;
  content: string;
  revision: string;
  tags: string[];
  headings: Array<{ level: number; text: string; line: number }>;
  outgoing: WorkspaceLinkSummary[];
  backlinks: string[];
}

export type VaultSearchContextKind = "content" | "heading" | "tag" | "property" | "path";

export interface VaultSearchContext {
  kind: VaultSearchContextKind;
  text: string;
  line?: number;
}

export interface VaultSearchResult {
  path: string;
  title: string;
  score: number;
  matchCount: number;
  contexts: VaultSearchContext[];
}

export interface VaultSearchResponse {
  vaultId: string;
  indexGeneration: number;
  error: string | null;
  query: string;
  terms: string[];
  total: number;
  truncated: boolean;
  results: VaultSearchResult[];
}

export interface WorkspaceSnapshot {
  state: "ready" | "degraded";
  indexGeneration: number;
  files: WorkspaceFileSummary[];
  tabs: WorkspaceTabSummary[];
  activeNote: WorkspaceNoteSnapshot | null;
  recoveryActionCount: number;
  watcher: {
    lastSequence: number;
    lastRescanReason: string | null;
    error: string | null;
  };
}

export type NoteSaveOutcome =
  | {
      status: "committed";
      path: string;
      revision: string;
      transactionId: string;
    }
  | {
      status: "conflict";
      path: string;
      currentRevision: string | null;
      conflictPath: string;
      transactionId: string;
    };

export interface NoteSaveResponse {
  outcome: NoteSaveOutcome;
  snapshot: RuntimeSnapshot;
}

export type NoteCreateOutcome =
  | {
      status: "committed";
      path: string;
      revision: string;
      transactionId: string;
    }
  | {
      status: "exists";
      path: string;
      currentRevision: string;
    }
  | {
      status: "conflict";
      path: string;
      currentRevision: string | null;
      conflictPath: string;
      transactionId: string;
    };

export interface NoteCreateResponse {
  outcome: NoteCreateOutcome;
  snapshot: RuntimeSnapshot;
}

export interface NoteMoveLinkResolution {
  status: "resolved" | "unresolved" | "ambiguous";
  path?: string;
  candidates?: string[];
}

export interface NoteMoveBlocker {
  documentPath: string;
  target: string;
  syntax: "wiki" | "markdown";
  before: NoteMoveLinkResolution;
  after: NoteMoveLinkResolution;
}

export interface NoteMoveRewritePreview {
  documentPath: string;
  resultPath: string;
  line: number;
  syntax: "wiki" | "markdown";
  beforeTarget: string;
  afterTarget: string;
}

export interface NoteMoveCommittedWrite {
  path: string;
  resultPath: string;
  revision: string;
}

export type NoteMoveOutcome =
  | {
      status: "committed";
      from: string;
      to: string;
      transactionId: string;
      rewrites: NoteMoveRewritePreview[];
      writes: NoteMoveCommittedWrite[];
    }
  | {
      status: "requires-confirmation";
      from: string;
      to: string;
      confirmationId: string;
      rewrites: NoteMoveRewritePreview[];
    }
  | {
      status: "conflict";
      from: string;
      to: string;
      reason: string;
      conflictPaths?: string[];
    }
  | {
      status: "blocked";
      from: string;
      to: string;
      blockers: NoteMoveBlocker[];
    };

export interface NoteMoveResponse {
  outcome: NoteMoveOutcome;
  snapshot: RuntimeSnapshot;
}

export type NoteDeleteOutcome =
  | { status: "committed"; from: string; to: string; transactionId: string }
  | { status: "conflict"; from: string; to: string; reason: string };

export interface NoteDeleteResponse {
  outcome: NoteDeleteOutcome;
  snapshot: RuntimeSnapshot;
}

export type VaultImageMimeType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export type VaultImageUnavailableReason =
  | "external"
  | "invalid"
  | "private"
  | "missing"
  | "outside-vault"
  | "unsupported"
  | "too-large"
  | "unreadable";

export type VaultImageResponse =
  | {
      status: "ready";
      vaultId: string;
      path: string;
      mimeType: VaultImageMimeType;
      size: number;
      revision: string;
      base64: string;
    }
  | {
      status: "unavailable";
      vaultId: string;
      reason: VaultImageUnavailableReason;
      message: string;
    }
  | {
      status: "stale-vault";
      vaultId: string;
    };

export type VaultOpenResponse =
  | { status: "cancelled"; snapshot: RuntimeSnapshot }
  | { status: "opened"; snapshot: RuntimeSnapshot }
  | { status: "failed"; message: string; snapshot: RuntimeSnapshot };

export interface ThreadleafBridge {
  getSnapshot(): Promise<RuntimeSnapshot>;
  getSettings(): Promise<AppSettingsSnapshot>;
  getAppearance(expectedVaultId: string): Promise<AppearanceResponse>;
  setVaultAppearance(
    expectedVaultId: string,
    appearance: VaultAppearanceSettings,
  ): Promise<AppearanceUpdateResponse>;
  getPlugins(expectedVaultId: string): Promise<PluginCatalogResponse>;
  setCompatibilityMode(
    expectedVaultId: string,
    mode: CompatibilityMode,
  ): Promise<PluginUpdateResponse>;
  setPluginEnabled(
    expectedVaultId: string,
    pluginId: string,
    enabled: boolean,
  ): Promise<PluginUpdateResponse>;
  reloadPlugins(expectedVaultId: string): Promise<PluginUpdateResponse>;
  getMigrationPreview(expectedVaultId: string): Promise<MigrationPreviewResponse>;
  searchVault(query: string): Promise<VaultSearchResponse>;
  loadVaultImage(
    sourceNotePath: string,
    target: string,
    expectedVaultId: string,
  ): Promise<VaultImageResponse>;
  setKeyBinding(targetId: ShortcutTargetId, binding: string | null): Promise<AppSettingsSnapshot>;
  resetKeyBindings(): Promise<AppSettingsSnapshot>;
  chooseVault(): Promise<VaultOpenResponse>;
  runCommand(commandId: string, editorContext?: PluginEditorContext): Promise<RuntimeSnapshot>;
  reloadPlugin(pluginId?: string): Promise<RuntimeSnapshot>;
  unloadPlugin(pluginId?: string): Promise<RuntimeSnapshot>;
  markPluginLayoutReady(): Promise<RuntimeSnapshot>;
  openPluginSettings(pluginId: string): Promise<RuntimeSnapshot>;
  openPluginView(viewType: string, filePath?: string): Promise<RuntimeSnapshot>;
  closePluginView(): Promise<RuntimeSnapshot>;
  setPluginSurfaceBounds(bounds: PluginSurfaceBounds): Promise<void>;
  setPluginSurfaceVisible(visible: boolean): Promise<void>;
  setPluginSurfaceTheme(theme: "dark" | "light"): Promise<void>;
  openNote(path: string): Promise<RuntimeSnapshot>;
  closeNote(path: string, expectedVaultId: string): Promise<RuntimeSnapshot>;
  moveNote(
    path: string,
    targetPath: string,
    expectedRevision: string,
    expectedVaultId: string,
    confirmationId?: string,
  ): Promise<NoteMoveResponse>;
  deleteNote(
    path: string,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<NoteDeleteResponse>;
  createNote(path: string, content: string, expectedVaultId: string): Promise<NoteCreateResponse>;
  saveNote(
    path: string,
    content: string,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<NoteSaveResponse>;
  onSnapshot(listener: (snapshot: RuntimeSnapshot) => void): () => void;
  onSettings(listener: (snapshot: AppSettingsSnapshot) => void): () => void;
}
