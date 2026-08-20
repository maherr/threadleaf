import type {
  AccessibilityPreferences,
  AccessibilityPreferencesSnapshot,
  EffectiveAccessibilityPreferences,
} from "./accessibility-preferences";
import type { AppUpdateSnapshot } from "./app-updates";
import type { AppearanceResponse, AppearanceSnapshot, VaultAppearanceSettings } from "./appearance";
import type { AutosaveFlushRequest, AutosaveFlushResult } from "./autosave";
import type { CanvasDiagnostic, JsonCanvasDocument } from "./json-canvas";
import type { AppSettingsSnapshot, ShortcutTargetId } from "./key-bindings";
import type {
  MigrationApplyOutcome,
  MigrationApplyRequest,
  MigrationPreviewResponse,
  MigrationRollbackResponse,
} from "./migration";
import type { NativeMenuCommandId } from "./native-menu";
import type { VaultNoteWorkflowSettings } from "./note-workflows";
import type {
  PluginPackageApplyOutcome,
  PluginPackageIndexResponse,
  PluginPackagePreviewRequest,
  PluginPackagePreviewResponse,
} from "./plugin-packages";
import type {
  PluginResourceDiagnosticReason,
  PluginResourceMetric,
} from "./plugin-resource-policy";
import type { PluginMutationWaitOptions, PluginRendererOperation } from "./plugin-runtime-protocol";

export type { PluginMutationWaitOptions } from "./plugin-runtime-protocol";

import type { PluginDiagnosticCode } from "./plugin-diagnostics";
import type {
  CompatibilityMode,
  CompatibilityProfile,
  PluginCatalogResponse,
  PluginCatalogSnapshot,
} from "./plugins";
import type { PublishNoteExportRequest, PublishNoteExportResponse } from "./publish-export";
import type { SupportBundleExportResponse } from "./support-bundle";
import type {
  AppearancePackageApplyOutcome,
  AppearancePackageInventorySnapshot,
  AppearancePackageKind,
  AppearancePackagePreviewRequest,
  AppearancePackagePreviewResponse,
  AppearancePackageReview,
} from "./theme-packages";
import type { WorkspaceLayoutSnapshot } from "./workspace-layout";
import type {
  WorkspaceOpenTransferAcknowledgement,
  WorkspaceOpenTransferReceipt,
} from "./workspace-open-diagnostics";
import type { VaultWorkspaceMode, VaultWorkspaceSettings } from "./workspace-settings";

export type AppearanceUpdateResponse =
  | {
      status: "updated";
      settings: AppSettingsSnapshot;
      appearance: AppearanceSnapshot;
    }
  | { status: "stale-vault"; vaultId: string };

export type MigrationApplyResponse =
  | {
      status: "updated";
      settings: AppSettingsSnapshot;
      snapshot: RuntimeSnapshot;
      outcome: MigrationApplyOutcome;
      runtimeWarning: string | null;
    }
  | { status: "stale-vault"; vaultId: string };

export type MigrationRollbackUpdateResponse =
  | {
      status: "updated";
      settings: AppSettingsSnapshot;
      snapshot: RuntimeSnapshot;
      outcome: Extract<MigrationRollbackResponse, { status: "rolled-back" }>;
      runtimeWarning: string | null;
    }
  | {
      status: "conflict";
      outcome: Extract<MigrationRollbackResponse, { status: "conflict" }>;
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

export type PluginPackageApplyResponse =
  | {
      status: "updated";
      settings: AppSettingsSnapshot;
      catalog: PluginCatalogSnapshot;
      snapshot: RuntimeSnapshot;
      outcome: PluginPackageApplyOutcome;
    }
  | { status: "stale-vault"; vaultId: string };

export type AppearancePackageInventoryResponse =
  | { status: "ready"; inventory: AppearancePackageInventorySnapshot }
  | { status: "stale-vault"; vaultId: string };

export type AppearancePackageLocalPreviewResponse =
  | { status: "ready"; review: AppearancePackageReview }
  | { status: "cancelled" }
  | { status: "stale-vault"; vaultId: string };

export type AppearancePackageApplyResponse =
  | {
      status: "updated";
      appearance: AppearanceSnapshot;
      inventory: AppearancePackageInventorySnapshot;
      outcome: AppearancePackageApplyOutcome;
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
  /** Stable renderer-safe category for `error`; raw plugin failures are never serialized. */
  errorCode?: PluginDiagnosticCode | null;
}

export interface PluginResourceDiagnostic {
  pluginId?: string;
  reason: PluginResourceDiagnosticReason;
  metric: PluginResourceMetric | null;
  operation: PluginRendererOperation | null;
  available: boolean;
  measuredValue: number | null;
  configuredBudget: number | null;
  unit: "milliseconds" | "bytes" | "percent" | null;
  sampleCount: number | null;
  startedAt: string;
  observedAt: string;
}

export interface PluginResourceMetricsSnapshot {
  sampledAt: string | null;
  memoryBytes: number | null;
  memoryAvailable: boolean;
  cpuPercent: number | null;
  cpuAvailable: boolean;
  cpuBreaches: number;
  inStartupQuietWindow: boolean;
}

export interface PluginResourcePolicySnapshot {
  version: 1;
  operationDeadlinesMs: Record<PluginRendererOperation, number>;
  memoryCeilingBytes: number;
  cpuBudgetPercent: number;
  cpuSampleIntervalMs: number;
  cpuStartupQuietWindowMs: number;
  cpuConsecutiveSamples: number;
  state: "monitoring" | "stopped";
  metrics: PluginResourceMetricsSnapshot;
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
  /** Workspace events with at least one live compatibility-plugin listener. */
  workspaceEvents?: string[];
}

/**
 * A settled Markdown post-processor projection: the plugin's registered processors already ran
 * to completion inside the trusted compatibility renderer, so `html` is that settled (non-live,
 * already-awaited) result, never a live callback. `html` is NOT sanitized: the plugin's processor
 * mutates the DOM after the compatibility renderer's own script/attribute stripping runs, so
 * nothing re-sanitizes what the processor added. Treat `html` as untrusted plugin output; every
 * consumer must sanitize it before display (see `sanitizePluginMarkdownProjection`). Bound to
 * `pluginId` + `sourcePath` + `contentSha256` so a consumer can refuse a stale result rather than
 * showing it against different content.
 */
export interface PluginMarkdownProjectionSnapshot {
  contentSha256: string;
  html: string;
  pluginId: string;
  postProcessorCount: number;
  sourcePath: string;
}

export interface PluginSurfaceSnapshot {
  displayText: string;
  filePath: string | null;
  /** Physical host selected by the compatibility workspace leaf. */
  region?: "main-document" | "right-dock";
  viewType: string;
}

export interface PluginSurfaceBounds {
  height: number;
  region?: "main-document" | "right-dock";
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

export interface PluginEditorEventSnapshot {
  handled: boolean;
  type: "paste";
}

export interface PluginEditorSuggestItem {
  id: string;
  label: string;
}

export interface PluginEditorSuggestInstruction {
  command: string;
  purpose: string;
}

export interface PluginEditorSuggestSnapshot {
  id: string;
  instructions: PluginEditorSuggestInstruction[];
  items: PluginEditorSuggestItem[];
  ownerId: string;
}

export interface PluginNavigatorDecoration {
  path: string;
  text: string;
  title: string | null;
}

export interface PluginAppearanceSnapshot {
  bodyClasses: string[];
  variables: Record<string, string>;
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
  editorEvent?: PluginEditorEventSnapshot | null;
  editorSuggest?: PluginEditorSuggestSnapshot | null;
  navigatorDecorations?: PluginNavigatorDecoration[];
  pluginAppearance?: PluginAppearanceSnapshot;
  markdownProjection?: PluginMarkdownProjectionSnapshot | null;
  pluginSurface?: PluginSurfaceSnapshot | null;
  pluginSurfaces?: PluginSurfaceSnapshot[];
  resourcePolicy?: PluginResourcePolicySnapshot;
  resourceDiagnostics?: PluginResourceDiagnostic[];
  workspace?: WorkspaceSnapshot;
  workspaceLayout?: WorkspaceLayoutSnapshot;
  workspaceOpenDiagnostics?: WorkspaceOpenTransferReceipt;
  pluginEnvironment?: PluginEnvironmentSnapshot;
}

/**
 * The renderer acknowledgement carried in runtime snapshots. Source text is
 * intentionally omitted: diagnostics expose identity, ordering, and whether
 * a live CSS reparse was settled without duplicating potentially large CSS.
 */
export interface PluginEnvironmentSnapshot {
  status: "applied" | "stale";
  vaultId: string;
  vaultGeneration: number;
  sequence: number;
  cssChangeTriggered: boolean;
}

export interface WorkspaceFileSummary {
  path: string;
  title: string;
  tags: string[];
  backlinkCount: number;
  outgoingCount: number;
  unresolvedCount: number;
}

export const maximumWorkspaceFilePageSize = 256;

export interface WorkspaceFilePageDescriptor {
  generation: string;
  offset: number;
  limit: number;
  total: number;
  complete: boolean;
}

export interface WorkspaceFilePageRequest {
  expectedVaultId: string;
  generation: string;
  offset: number;
  limit: number;
  /** Bounded title/path ranking for the quick switcher. Omit for tree order. */
  query?: string;
}

export type WorkspaceFilePageResponse =
  | {
      status: "ready";
      vaultId: string;
      page: WorkspaceFilePageDescriptor;
      files: WorkspaceFileSummary[];
    }
  | {
      status: "warming" | "degraded" | "stale-generation";
      vaultId: string;
      generation: string;
      census: WorkspaceCensusSnapshot;
    }
  | { status: "stale-vault"; vaultId: string };

export type WorkspaceTreeEntry =
  | {
      kind: "folder";
      path: string;
      title: string;
      childCount: number;
    }
  | {
      kind: "note" | "canvas" | "base" | "file";
      path: string;
      title: string;
    };

export interface WorkspaceVisibleInventorySnapshot {
  state: "lazy" | "warming" | "current" | "degraded";
  /** Runtime-scoped physical-path-set generation. Treat as an opaque validator. */
  generation: string;
  /** Visible non-folder entries, including Markdown, Canvas, and ordinary files. */
  fileCount: number;
  /** Visible physical folders, including explicit empty folders. */
  folderCount: number;
  error: string | null;
}

export interface WorkspaceTreePageDescriptor {
  generation: string;
  parentPath: string | null;
  offset: number;
  limit: number;
  total: number;
  complete: boolean;
}

export interface WorkspaceTreePageRequest {
  expectedVaultId: string;
  generation: string;
  parentPath: string | null;
  offset: number;
  limit: number;
}

export type WorkspaceTreePageResponse =
  | {
      status: "ready";
      vaultId: string;
      page: WorkspaceTreePageDescriptor;
      entries: WorkspaceTreeEntry[];
    }
  | {
      status: "warming" | "degraded" | "stale-generation";
      vaultId: string;
      generation: string;
      inventory: WorkspaceVisibleInventorySnapshot;
    }
  | {
      status: "missing-parent";
      vaultId: string;
      generation: string;
      parentPath: string;
    }
  | { status: "stale-vault"; vaultId: string };

export interface WorkspaceTagSummary {
  key: string;
  tag: string;
  parentKey: string | null;
  directCount: number;
  count: number;
}

export interface WorkspaceTagCatalogRequest {
  expectedVaultId: string;
  generation: string;
}

export type WorkspaceTagCatalogResponse =
  | {
      status: "ready";
      vaultId: string;
      generation: string;
      tags: WorkspaceTagSummary[];
    }
  | {
      status: "warming" | "degraded" | "stale-generation";
      vaultId: string;
      generation: string;
      census: WorkspaceCensusSnapshot;
    }
  | { status: "stale-vault"; vaultId: string };

export interface WorkspaceTreePathPageLocation {
  parentPath: string | null;
  offset: number;
}

export interface WorkspaceTreePathLocation {
  path: string;
  pages: WorkspaceTreePathPageLocation[];
}

export interface WorkspaceTreePathRequest {
  expectedVaultId: string;
  generation: string;
  path: string;
}

export type WorkspaceTreePathResponse =
  | { status: "ready"; vaultId: string; location: WorkspaceTreePathLocation }
  | { status: "missing"; vaultId: string }
  | {
      status: "warming" | "degraded" | "stale-generation";
      vaultId: string;
      generation: string;
      inventory: WorkspaceVisibleInventorySnapshot;
    }
  | { status: "stale-vault"; vaultId: string };

export interface WorkspaceFolderCreateResponse {
  path: string;
  created: boolean;
}

export interface WorkspaceCensusSnapshot {
  state: "warming" | "scanning" | "indexing" | "reconciling" | "current" | "degraded";
  generation: number;
  discovered: number;
  indexed: number;
  total: number | null;
  error: string | null;
}

export interface WorkspaceCanvasSummary {
  path: string;
  title: string;
}

export interface WorkspaceTabSummary {
  path: string;
  title: string;
  active: boolean;
  pinned: boolean;
}

export type WorkspacePaneId = "primary" | "secondary";
export type WorkspaceSplitDirection = "horizontal" | "vertical";

export interface WorkspaceLinkSummary {
  label: string;
  status: "resolved" | "unresolved" | "ambiguous";
  path?: string;
  target?: string;
  subpath?: string | null;
  embed?: boolean;
  syntax?: "wiki" | "markdown";
}

export const notePropertyTypes = [
  "text",
  "list",
  "number",
  "checkbox",
  "date",
  "datetime",
] as const;

export type NotePropertyType = (typeof notePropertyTypes)[number];
export type NotePropertyValue = string | string[] | number | boolean;

export interface WorkspacePropertySummary {
  name: string;
  type: NotePropertyType | "unsupported";
  value: NotePropertyValue;
  rawValue: string;
}

export interface WorkspacePropertyEditorSnapshot {
  editable: boolean;
  message: string | null;
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
  properties: WorkspacePropertySummary[];
  propertyEditor: WorkspacePropertyEditorSnapshot;
}

export interface WorkspaceCanvasSnapshot {
  path: string;
  title: string;
  revision: string;
  document: JsonCanvasDocument | null;
  diagnostics: CanvasDiagnostic[];
  readOnly: boolean;
}

export interface WorkspaceBaseSummary {
  path: string;
  title: string;
}

export interface WorkspaceBaseDiagnostic {
  code: "invalid-yaml" | "invalid-shape" | "unsupported-filter" | "unsupported-formula";
  path: string;
  message: string;
}

export interface WorkspaceBaseColumn {
  property: string;
  label: string;
}

export interface WorkspaceBaseRow {
  path: string;
  title: string;
  group: string | null;
  values: Record<string, string>;
}

export interface WorkspaceBaseViewSnapshot {
  name: string;
  type: string;
  columns: WorkspaceBaseColumn[];
  rows: WorkspaceBaseRow[];
  totalRows: number;
  truncated: boolean;
}

export interface WorkspaceBaseSnapshot {
  path: string;
  title: string;
  revision: string;
  views: WorkspaceBaseViewSnapshot[];
  diagnostics: WorkspaceBaseDiagnostic[];
  readOnly: true;
}

/**
 * A visible non-Markdown file owned by a loaded compatibility plugin's registered view.
 * The primary renderer receives identity and revision only; the trusted plugin realm reads and
 * writes the source through the same revision-bound vault bridge used by its other file APIs.
 */
export interface WorkspacePluginFileSnapshot {
  path: string;
  title: string;
  revision: string;
  viewType: string;
}

export type EditorDraftLineEnding = "lf" | "crlf" | "cr";

/**
 * Private load/save-boundary metadata for a logical CodeMirror draft. It
 * contains no vault path or source text: one compact code per logical newline
 * is enough to restore the original external representation after a crash.
 */
export interface EditorDraftTextRepresentation {
  hasBom: boolean;
  lineEndingKinds: string;
  defaultLineEnding: EditorDraftLineEnding;
}

export interface EditorDraftSnapshot {
  version: 3;
  draftId: string;
  vaultId: string;
  paneId: WorkspacePaneId;
  path: string;
  baseRevision: string;
  content: string;
  textRepresentation: EditorDraftTextRepresentation | null;
  selection: PluginEditorSelection;
  updatedAt: string;
}

export type EditorDraftReadResponse =
  | { status: "ready"; draft: EditorDraftSnapshot }
  | { status: "empty" }
  | { status: "stale-vault"; vaultId: string };

export type EditorDraftSaveResponse =
  | { status: "saved"; draft: EditorDraftSnapshot }
  | { status: "stale-vault"; vaultId: string };

export type EditorDraftClearResponse =
  | { status: "cleared"; cleared: boolean }
  | { status: "stale-vault"; vaultId: string };

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
  /** Runtime-scoped generation token. Changes when the census swaps in a new index. */
  indexGeneration: string;
  /** Makes partial-index answers explicitly non-authoritative while the census runs. */
  census: WorkspaceCensusSnapshot;
  error: string | null;
  query: string;
  terms: string[];
  tagFilters?: string[];
  total: number;
  truncated: boolean;
  results: VaultSearchResult[];
}

export type VaultGraphMode = "global" | "local";

export interface VaultGraphRequest {
  mode: VaultGraphMode;
  rootPath: string | null;
  depth: number;
  query: string;
  includeOrphans: boolean;
}

export interface VaultGraphNode {
  path: string;
  title: string;
  tags: string[];
  incomingCount: number;
  outgoingCount: number;
  neighborCount: number;
  distance: number | null;
}

export interface VaultGraphEdge {
  source: string;
  target: string;
  occurrences: number;
}

export interface VaultGraphProjection extends VaultGraphRequest {
  totalNodes: number;
  totalEdges: number;
  truncated: boolean;
  nodes: VaultGraphNode[];
  edges: VaultGraphEdge[];
}

export type VaultGraphResponse =
  | ({
      status: "ready";
      vaultId: string;
      indexGeneration: string;
      census: WorkspaceCensusSnapshot;
    } & VaultGraphProjection)
  | { status: "stale-vault"; vaultId: string };

export interface WorkspaceSnapshot {
  state: "warming" | "ready" | "degraded";
  /** Runtime-scoped generation token, safe to compare only as an opaque value. */
  indexGeneration: string;
  files: WorkspaceFileSummary[];
  filePage: WorkspaceFilePageDescriptor;
  census: WorkspaceCensusSnapshot;
  /** Physical visible-vault authority for the Files navigator. */
  inventory: WorkspaceVisibleInventorySnapshot;
  canvasFiles?: WorkspaceCanvasSummary[];
  baseFiles?: WorkspaceBaseSummary[];
  panes: WorkspacePaneSnapshot[];
  activePaneId: WorkspacePaneId;
  splitDirection: WorkspaceSplitDirection | null;
  /** Active-pane projection retained for one-pane consumers and compatibility plugins. */
  tabs: WorkspaceTabSummary[];
  /** Active-pane projection retained for one-pane consumers and compatibility plugins. */
  activeNote: WorkspaceNoteSnapshot | null;
  /** Active registered-extension document, when the selected file is not Markdown or Canvas. */
  activePluginFile?: WorkspacePluginFileSnapshot | null;
  /** Waiting-state entry for the active pane when its file is absent but not yet confirmed removed. */
  activeUnavailable?: WorkspaceUnavailableEntry | null;
  recoveryActionCount: number;
  watcher: {
    lastSequence: number;
    lastRescanReason: string | null;
    error: string | null;
  };
}

export interface WorkspacePaneSnapshot {
  id: WorkspacePaneId;
  active: boolean;
  tabs: WorkspaceTabSummary[];
  activeNote: WorkspaceNoteSnapshot | null;
  canGoBack?: boolean;
  canGoForward?: boolean;
  activeCanvas?: WorkspaceCanvasSnapshot | null;
  activeBase?: WorkspaceBaseSnapshot | null;
  /** A non-Markdown file whose content surface belongs to a registered compatibility view. */
  activePluginFile?: WorkspacePluginFileSnapshot | null;
  /**
   * Set instead of `activeNote`, `activeCanvas`, `activeBase`, or `activePluginFile` when the selected tab's file
   * is not on disk right now and nothing readable has been published for it in
   * this session. The workspace keeps such a tab rather than closing it on an
   * absence it has not confirmed, so the pane has to be able to say what it is
   * waiting for instead of rendering a document it cannot read.
   */
  activeUnavailable?: WorkspaceUnavailableEntry | null;
}

/** The selected tab whose file the workspace is still waiting on. */
export interface WorkspaceUnavailableEntry {
  path: string;
  title: string;
}

export type CanvasUnavailableReason =
  | "invalid"
  | "private"
  | "missing"
  | "outside-vault"
  | "too-large"
  | "unreadable"
  | "unsupported";

export type CanvasLoadResponse =
  | {
      status: "ready";
      vaultId: string;
      canvas: WorkspaceCanvasSnapshot;
    }
  | {
      status: "unavailable";
      vaultId: string;
      path: string;
      reason: CanvasUnavailableReason;
      message: string;
    }
  | { status: "stale-vault"; vaultId: string };

export type CanvasSaveOutcome =
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
    }
  | { status: "read-only"; path: string };

export interface CanvasSaveResponse {
  outcome: CanvasSaveOutcome;
  snapshot: RuntimeSnapshot;
}

export type CanvasAttachmentMimeType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp"
  | "application/pdf"
  | "text/plain"
  | "application/octet-stream";

export type CanvasAttachmentPreview = "image" | "text" | "binary";

export type CanvasAttachmentUnavailableReason =
  | "external"
  | "invalid"
  | "private"
  | "missing"
  | "outside-vault"
  | "too-large"
  | "unsupported"
  | "unreadable";

export type CanvasAttachmentResponse =
  | {
      status: "ready";
      vaultId: string;
      path: string;
      mimeType: CanvasAttachmentMimeType;
      preview: CanvasAttachmentPreview;
      size: number;
      revision: string;
      base64?: string;
      text?: string;
      truncated?: boolean;
    }
  | {
      status: "unavailable";
      vaultId: string;
      reason: CanvasAttachmentUnavailableReason;
      message: string;
    }
  | { status: "stale-vault"; vaultId: string };

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

export type NotePropertySetOutcome =
  | {
      status: "committed";
      path: string;
      revision: string;
      transactionId: string;
      name: string;
      type: NotePropertyType;
      value: NotePropertyValue;
    }
  | {
      status: "conflict";
      path: string;
      currentRevision: string | null;
      conflictPath: string;
      transactionId: string;
      name: string;
      type: NotePropertyType;
      value: NotePropertyValue;
    }
  | {
      status: "stale";
      path: string;
      currentRevision: string;
      name: string;
    };

export type NotePropertyRemoveOutcome =
  | {
      status: "committed";
      path: string;
      revision: string;
      transactionId: string;
      name: string;
    }
  | {
      status: "conflict";
      path: string;
      currentRevision: string | null;
      conflictPath: string;
      transactionId: string;
      name: string;
    }
  | {
      status: "missing";
      path: string;
      revision: string;
      name: string;
    }
  | {
      status: "stale";
      path: string;
      currentRevision: string;
      name: string;
    };

export interface NotePropertySetResponse {
  outcome: NotePropertySetOutcome;
  snapshot: RuntimeSnapshot;
}

export interface NotePropertyRemoveResponse {
  outcome: NotePropertyRemoveOutcome;
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

export type NoteWorkflowCatalogResponse =
  | {
      status: "ready";
      vaultId: string;
      settings: VaultNoteWorkflowSettings;
      templates: string[];
    }
  | { status: "stale-vault"; vaultId: string };

export type NoteWorkflowUpdateResponse =
  | {
      status: "updated";
      vaultId: string;
      appSettings: AppSettingsSnapshot;
      settings: VaultNoteWorkflowSettings;
      templates: string[];
    }
  | { status: "stale-vault"; vaultId: string };

export type NoteTemplateRenderResponse =
  | {
      status: "ready";
      vaultId: string;
      content: string;
      sourcePath: string;
      sourceRevision: string;
      size: number;
    }
  | { status: "stale-vault"; vaultId: string };

export type NoteWorkflowValueResponse =
  | { status: "ready"; vaultId: string; value: string }
  | { status: "stale-vault"; vaultId: string };

export type WorkspaceSettingsUpdateResponse =
  | {
      status: "updated";
      vaultId: string;
      settings: VaultWorkspaceSettings;
      appSettings: AppSettingsSnapshot;
    }
  | { status: "stale-vault"; vaultId: string };

export type WorkspaceSettingsResponse =
  | { status: "ready"; vaultId: string; settings: VaultWorkspaceSettings }
  | { status: "stale-vault"; vaultId: string };

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
  bookmarkWarning?: string;
}

export interface AttachmentMoveRewritePreview {
  documentPath: string;
  line: number;
  syntax: "wiki" | "markdown" | "canvas";
  embed: boolean;
  beforeTarget: string;
  afterTarget: string;
  location?: string;
}

export type AttachmentOperation = "publish-copy" | "rename";

export interface AttachmentMoveBlocker {
  documentPath: string;
  line: number;
  target: string;
  syntax: "wiki" | "markdown" | "canvas";
  reason: "ambiguous" | "unresolved" | "unsupported" | "canvas-reference" | "canvas-unreadable";
  candidates: string[];
  location?: string;
}

export type AttachmentMoveOutcome =
  | {
      status: "committed";
      from: string;
      to: string;
      transactionId: string;
      rewrites: AttachmentMoveRewritePreview[];
      writes: Array<{ path: string; revision: string }>;
    }
  | {
      status: "published-source-retained";
      from: string;
      to: string;
      transactionId: string;
      rewrites: AttachmentMoveRewritePreview[];
      writes: Array<{ path: string; revision: string }>;
    }
  | {
      status: "requires-confirmation";
      from: string;
      to: string;
      confirmationId: string;
      rewrites: AttachmentMoveRewritePreview[];
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
      blockers: AttachmentMoveBlocker[];
    };

export interface AttachmentMoveResponse {
  outcome: AttachmentMoveOutcome;
  snapshot: RuntimeSnapshot;
  /** Set when the mutation committed in a runtime replaced before reply. */
  committedVaultId?: string;
  /** Basename-safe identity of the vault that committed the mutation. */
  committedVaultName?: string;
}

export interface AttachmentRelinkRewritePreview {
  documentPath: string;
  line: number;
  syntax: "wiki" | "markdown";
  beforeTarget: string;
  afterTarget: string;
  missingPath: string;
  replacementPath: string;
}

export type AttachmentRelinkRefusalReason =
  | "invalid-source"
  | "invalid-missing-target"
  | "invalid-replacement"
  | "private-path"
  | "unsupported-reference"
  | "reference-not-found"
  | "reference-ambiguous"
  | "missing-target-returned"
  | "missing-target-ambiguous"
  | "missing-target-changed"
  | "replacement-missing"
  | "replacement-ambiguous"
  | "replacement-changed"
  | "replacement-too-large"
  | "replacement-unreadable"
  | "source-unreadable"
  | "source-revision-changed"
  | "workspace-changed"
  | "write-conflict"
  | "stale-vault";

export type AttachmentRelinkOutcome =
  | {
      status: "requires-confirmation";
      sourceNotePath: string;
      missingPath: string;
      replacementPath: string;
      replacementRevision: string;
      confirmationId: string;
      rewrite: AttachmentRelinkRewritePreview;
    }
  | {
      status: "committed";
      path: string;
      revision: string;
      transactionId: string;
      rewrite: AttachmentRelinkRewritePreview;
    }
  | {
      status: "refused";
      sourceNotePath: string;
      missingPath: string;
      replacementPath: string;
      reason: AttachmentRelinkRefusalReason;
      message: string;
    };

export interface AttachmentRelinkResponse {
  outcome: AttachmentRelinkOutcome;
  snapshot: RuntimeSnapshot;
  /** Set when the mutation committed in a runtime replaced before reply. */
  committedVaultId?: string;
  /** Basename-safe identity of the vault that committed the mutation. */
  committedVaultName?: string;
}

export interface AttachmentRestorePreview {
  sourceNotePath: string;
  targetPath: string;
  sourceFileName: string;
  byteLength: number;
  contentRevision: string;
}

export type AttachmentRestoreRefusalReason =
  | "invalid-source"
  | "invalid-missing-target"
  | "private-path"
  | "unsupported-reference"
  | "reference-not-found"
  | "reference-ambiguous"
  | "source-unreadable"
  | "source-revision-changed"
  | "invalid-file-name"
  | "attachment-too-large"
  | "missing-target-returned"
  | "missing-target-ambiguous"
  | "missing-target-changed"
  | "attachment-publish-unavailable"
  | "workspace-changed"
  | "stale-vault";

export type AttachmentRestoreOutcome =
  | {
      status: "requires-confirmation";
      preview: AttachmentRestorePreview;
      confirmationId: string;
    }
  | {
      status: "committed";
      path: string;
      revision: string;
      transactionId: string;
      preview: AttachmentRestorePreview;
    }
  | {
      status: "refused";
      sourceNotePath: string;
      missingPath: string;
      sourceFileName: string;
      reason: AttachmentRestoreRefusalReason;
      message: string;
    }
  | {
      status: "manual-conflict";
      path: string;
      transactionId: string;
      reason: string;
      message: string;
    };

export interface AttachmentRestoreResponse {
  outcome: AttachmentRestoreOutcome;
  snapshot: RuntimeSnapshot;
  /** Set when the affected runtime was replaced before its reply. */
  affectedVaultId?: string;
  /** Basename-safe identity of the vault affected by the operation. */
  affectedVaultName?: string;
}

export interface AttachmentInsertPreview {
  sourceNotePath: string;
  targetPath: string;
  sourceFileName: string;
  byteLength: number;
  contentRevision: string;
  proposedNoteRevision: string;
  referenceText: string;
  selectionStart: number;
  selectionEnd: number;
  selectionAfter: number;
}

export type AttachmentInsertRefusalReason =
  | "invalid-source"
  | "private-path"
  | "invalid-file-name"
  | "attachment-too-large"
  | "invalid-target"
  | "unsupported-target"
  | "target-parent-missing"
  | "target-exists"
  | "source-unreadable"
  | "source-write-unavailable"
  | "source-revision-changed"
  | "invalid-selection"
  | "workspace-changed"
  | "attachment-publish-unavailable"
  | "stale-vault";

export type AttachmentInsertOutcome =
  | {
      status: "requires-confirmation";
      preview: AttachmentInsertPreview;
      confirmationId: string;
    }
  | {
      status: "committed";
      path: string;
      revision: string;
      attachmentPath: string;
      attachmentRevision: string;
      transactionId: string;
      preview: AttachmentInsertPreview;
    }
  | {
      status: "conflict-copy";
      path: string;
      currentRevision: string | null;
      conflictPath: string;
      attachmentPath: string;
      attachmentRevision: string;
      transactionId: string;
      preview: AttachmentInsertPreview;
      message: string;
    }
  | {
      status: "refused";
      sourceNotePath: string;
      targetPath: string;
      sourceFileName: string;
      reason: AttachmentInsertRefusalReason;
      message: string;
    }
  | {
      status: "manual-conflict";
      path: string;
      attachmentPath: string;
      transactionId: string;
      reason: string;
      message: string;
    };

export interface AttachmentInsertResponse {
  outcome: AttachmentInsertOutcome;
  snapshot: RuntimeSnapshot;
  /** Set when the affected runtime was replaced before its reply. */
  affectedVaultId?: string;
  /** Basename-safe identity of the vault affected by the operation. */
  affectedVaultName?: string;
}

export interface AttachmentBatchInsertItemPreview {
  sourceFileName: string;
  targetPath: string;
  byteLength: number;
  contentRevision: string;
  referenceText: string;
  selectionStart: number;
  selectionEnd: number;
  selectionAfter: number;
}

export interface AttachmentBatchInsertPreview {
  sourceNotePath: string;
  targetDirectory: string;
  totalByteLength: number;
  proposedNoteRevision: string;
  items: AttachmentBatchInsertItemPreview[];
  selectionAfter: number;
}

export type AttachmentBatchInsertRefusalReason =
  | AttachmentInsertRefusalReason
  | "batch-empty"
  | "batch-too-large"
  | "target-directory-mismatch"
  | "selection-order";

export interface AttachmentBatchInsertPublication {
  attachmentPath: string;
  attachmentRevision: string;
}

export type AttachmentBatchInsertOutcome =
  | {
      status: "requires-confirmation";
      preview: AttachmentBatchInsertPreview;
      confirmationId: string;
    }
  | {
      status: "committed";
      path: string;
      revision: string;
      attachments: AttachmentBatchInsertPublication[];
      transactionId: string;
      preview: AttachmentBatchInsertPreview;
    }
  | {
      status: "conflict-copy";
      path: string;
      currentRevision: string | null;
      conflictPath: string;
      attachments: AttachmentBatchInsertPublication[];
      transactionId: string;
      preview: AttachmentBatchInsertPreview;
      message: string;
    }
  | {
      status: "refused";
      sourceNotePath: string;
      targetPaths: string[];
      sourceFileNames: string[];
      reason: AttachmentBatchInsertRefusalReason;
      message: string;
    }
  | {
      status: "manual-conflict";
      path: string;
      attachmentPaths: string[];
      transactionId: string;
      reason: string;
      message: string;
    };

export interface AttachmentBatchInsertResponse {
  outcome: AttachmentBatchInsertOutcome;
  snapshot: RuntimeSnapshot;
  affectedVaultId?: string;
  affectedVaultName?: string;
}

export type NoteDeleteOutcome =
  | { status: "committed"; from: string; to: string; transactionId: string }
  | { status: "conflict"; from: string; to: string; reason: string };

export interface NoteDeleteResponse {
  outcome: NoteDeleteOutcome;
  snapshot: RuntimeSnapshot;
}

export interface VaultTrashEntry {
  path: string;
  trashPath: string;
  revision: string;
  size: number;
}

export type VaultTrashResponse =
  | {
      status: "ready";
      vaultId: string;
      total: number;
      truncated: boolean;
      entries: VaultTrashEntry[];
    }
  | { status: "stale-vault"; vaultId: string };

export type NoteRestoreOutcome =
  | { status: "committed"; from: string; to: string; transactionId: string }
  | { status: "conflict"; from: string; to: string; reason: string };

export interface NoteRestoreResponse {
  outcome: NoteRestoreOutcome;
  snapshot: RuntimeSnapshot;
}

export type NoteBookmarksResponse =
  | { status: "ready"; vaultId: string; paths: string[] }
  | { status: "stale-vault"; vaultId: string };

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

export type VaultAttachmentKind =
  | "image"
  | "pdf"
  | "audio"
  | "video"
  | "document"
  | "text"
  | "archive"
  | "unsupported";

export interface VaultAttachmentMetadata {
  path: string;
  kind: VaultAttachmentKind;
  mimeType: string | null;
  size: number;
  revision: string;
  actions: { open: boolean; reveal: boolean; rename: boolean; move: boolean; inline: false };
}

export type VaultAttachmentUnavailableReason =
  | "external"
  | "invalid"
  | "ambiguous"
  | "private"
  | "missing"
  | "outside-vault"
  | "too-large"
  | "unreadable";

export interface VaultAttachmentRecoveryOffer {
  kind: "missing-attachment";
  missingPath: string;
  sourceNoteRevision: string;
}

export type VaultAttachmentResponse =
  | { status: "ready"; vaultId: string; attachment: VaultAttachmentMetadata }
  | {
      status: "unavailable";
      vaultId: string;
      reason: VaultAttachmentUnavailableReason;
      message: string;
      attachment?: Pick<VaultAttachmentMetadata, "path" | "actions">;
      recovery?: VaultAttachmentRecoveryOffer;
    }
  | { status: "stale-vault"; vaultId: string };

export type VaultAttachmentNativeAction = "open" | "reveal";

export interface VaultAttachmentNativeActionRequest {
  action: VaultAttachmentNativeAction;
  path: string;
  expectedRevision: string;
  expectedVaultId: string;
}

export type VaultAttachmentNativeActionUnavailableReason =
  | "invalid"
  | "private"
  | "missing"
  | "outside-vault"
  | "not-file"
  | "too-large"
  | "stale-revision"
  | "unsupported"
  | "unreadable"
  | "native-failed";

export type VaultAttachmentNativeActionResponse =
  | { status: "opened"; vaultId: string; path: string }
  | { status: "reveal-dispatched"; vaultId: string; path: string }
  | {
      status: "unavailable";
      vaultId: string;
      reason: VaultAttachmentNativeActionUnavailableReason;
      message: string;
    }
  | { status: "stale-vault"; vaultId: string };

export type VaultFilePreviewUnavailableReason =
  | "invalid"
  | "private"
  | "missing"
  | "outside-vault"
  | "too-large"
  | "unreadable"
  | "not-visible"
  | "document"
  | "stale-inventory";

interface VaultFilePreviewReadyBase {
  status: "ready";
  vaultId: string;
  path: string;
  size: number;
  revision: string;
}

export type VaultFilePreviewReadyResponse = VaultFilePreviewReadyBase &
  (
    | {
        kind: "image";
        mimeType: string;
        preview: "image";
        /** Present only for a sniffed PNG, JPEG, GIF, or WebP response. */
        base64: string;
        text?: undefined;
        truncated?: undefined;
      }
    | {
        kind: "text";
        mimeType: "text/plain";
        preview: "text";
        /** A bounded, valid UTF-8, no-NUL text response. */
        text: string;
        truncated: boolean;
        base64?: undefined;
      }
    | {
        kind: Exclude<VaultAttachmentKind, "image" | "text">;
        mimeType: string | null;
        preview: "metadata";
        base64?: undefined;
        text?: undefined;
        truncated?: undefined;
      }
  );

export type VaultFilePreviewResponse =
  | VaultFilePreviewReadyResponse
  | {
      status: "unavailable";
      vaultId: string;
      reason: VaultFilePreviewUnavailableReason;
      message: string;
      path?: string;
      size?: number;
    }
  | { status: "stale-vault"; vaultId: string };

export type VaultNoteEmbedUnavailableReason =
  | "external"
  | "invalid"
  | "private"
  | "missing"
  | "ambiguous"
  | "outside-vault"
  | "too-large"
  | "unreadable"
  | "subpath-missing"
  | "warming"
  | "degraded";

export type VaultNoteEmbedResponse =
  | {
      status: "ready";
      vaultId: string;
      path: string;
      revision: string;
      sourceSize: number;
      contentBytes: number;
      content: string;
      startLine: number;
      endLine: number;
      kind: "note" | "heading" | "block";
      subpath: string | null;
      links: WorkspaceLinkSummary[];
    }
  | {
      status: "unavailable";
      vaultId: string;
      reason: VaultNoteEmbedUnavailableReason;
      message: string;
    }
  | {
      status: "stale-vault";
      vaultId: string;
    };

export type PluginMarkdownProjectionUnavailableReason =
  | "plugin-disabled"
  | "processor-error"
  | "timeout"
  | "too-large";

/**
 * The primary-renderer-facing result of requesting an explicit settled Markdown post-processor
 * projection for one exact, already-loaded compatibility plugin. `ready` carries sanitizer-bound
 * evidence (`contentSha256`, `postProcessorCount`) so a stale or mismatched result can be refused
 * by the caller instead of silently replacing unrelated note content.
 */
export type PluginMarkdownProjectionResponse =
  | {
      status: "ready";
      vaultId: string;
      pluginId: string;
      sourcePath: string;
      contentSha256: string;
      html: string;
      postProcessorCount: number;
    }
  | {
      status: "unavailable";
      vaultId: string;
      pluginId: string;
      reason: PluginMarkdownProjectionUnavailableReason;
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
  exportSupportBundle(): Promise<SupportBundleExportResponse>;
  publishNote(request: PublishNoteExportRequest): Promise<PublishNoteExportResponse>;
  getAppUpdate(): Promise<AppUpdateSnapshot>;
  checkForAppUpdate(): Promise<AppUpdateSnapshot>;
  downloadAppUpdate(): Promise<AppUpdateSnapshot>;
  installAppUpdate(): Promise<AppUpdateSnapshot>;
  getSnapshot(): Promise<RuntimeSnapshot>;
  getWorkspaceFilePage(request: WorkspaceFilePageRequest): Promise<WorkspaceFilePageResponse>;
  getWorkspaceTreePage(request: WorkspaceTreePageRequest): Promise<WorkspaceTreePageResponse>;
  getWorkspaceTreePath(request: WorkspaceTreePathRequest): Promise<WorkspaceTreePathResponse>;
  getWorkspaceTagCatalog(request: WorkspaceTagCatalogRequest): Promise<WorkspaceTagCatalogResponse>;
  reportWorkspaceOpenDiagnostics(acknowledgement: WorkspaceOpenTransferAcknowledgement): void;
  getWorkspaceLayout(expectedVaultId?: string): Promise<WorkspaceLayoutSnapshot>;
  setWorkspaceDockCollapsed(
    dockId: "left" | "right",
    collapsed: boolean,
    expectedVaultId: string,
  ): Promise<WorkspaceLayoutSnapshot>;
  setWorkspaceNavigatorExpandedPaths(
    paths: string[],
    expectedVaultId: string,
  ): Promise<WorkspaceLayoutSnapshot>;
  popOutPluginView(expectedVaultId: string): Promise<WorkspaceLayoutSnapshot>;
  reattachPluginView(expectedVaultId: string): Promise<WorkspaceLayoutSnapshot>;
  markStartupShellReady(): void;
  getSettings(): Promise<AppSettingsSnapshot>;
  getAccessibilityPreferences(): Promise<AccessibilityPreferencesSnapshot>;
  setAccessibilityPreferences(
    preferences: AccessibilityPreferences,
  ): Promise<AccessibilityPreferencesSnapshot>;
  resetAccessibilityPreferences(): Promise<AccessibilityPreferencesSnapshot>;
  getAppearance(expectedVaultId: string): Promise<AppearanceResponse>;
  onAppearance(listener: (snapshot: AppearanceSnapshot) => void): () => void;
  setVaultAppearance(
    expectedVaultId: string,
    appearance: VaultAppearanceSettings,
  ): Promise<AppearanceUpdateResponse>;
  getAppearancePackages(expectedVaultId: string): Promise<AppearancePackageInventoryResponse>;
  previewAppearancePackage(
    expectedVaultId: string,
    request: AppearancePackagePreviewRequest,
  ): Promise<AppearancePackagePreviewResponse>;
  previewLocalAppearancePackage(
    expectedVaultId: string,
    kind: AppearancePackageKind,
  ): Promise<AppearancePackageLocalPreviewResponse>;
  applyAppearancePackage(
    expectedVaultId: string,
    reviewId: string,
  ): Promise<AppearancePackageApplyResponse>;
  cancelAppearancePackageReview(expectedVaultId: string, reviewId: string): Promise<void>;
  getPlugins(expectedVaultId: string): Promise<PluginCatalogResponse>;
  searchPluginPackages(expectedVaultId: string, query: string): Promise<PluginPackageIndexResponse>;
  previewPluginPackage(
    expectedVaultId: string,
    request: PluginPackagePreviewRequest,
  ): Promise<PluginPackagePreviewResponse>;
  applyPluginPackage(
    expectedVaultId: string,
    reviewId: string,
  ): Promise<PluginPackageApplyResponse>;
  cancelPluginPackageReview(expectedVaultId: string, reviewId: string): Promise<void>;
  setCompatibilityMode(
    expectedVaultId: string,
    mode: CompatibilityMode,
  ): Promise<PluginUpdateResponse>;
  setCompatibilityProfile(
    expectedVaultId: string,
    profile: CompatibilityProfile,
  ): Promise<PluginUpdateResponse>;
  setPluginCapabilityGrant(
    expectedVaultId: string,
    pluginId: string,
    expectedBundleSha256: string,
    granted: boolean,
  ): Promise<PluginUpdateResponse>;
  setPluginEnabled(
    expectedVaultId: string,
    pluginId: string,
    enabled: boolean,
  ): Promise<PluginUpdateResponse>;
  reloadPlugins(expectedVaultId: string): Promise<PluginUpdateResponse>;
  getMigrationPreview(expectedVaultId: string): Promise<MigrationPreviewResponse>;
  applyMigration(
    expectedVaultId: string,
    request: MigrationApplyRequest,
  ): Promise<MigrationApplyResponse>;
  rollbackMigration(
    expectedVaultId: string,
    transactionId: string,
  ): Promise<MigrationRollbackUpdateResponse>;
  searchVault(query: string): Promise<VaultSearchResponse>;
  getVaultGraph(request: VaultGraphRequest, expectedVaultId: string): Promise<VaultGraphResponse>;
  loadVaultImage(
    sourceNotePath: string,
    target: string,
    expectedVaultId: string,
  ): Promise<VaultImageResponse>;
  loadVaultAttachment(
    sourceNotePath: string,
    target: string,
    expectedVaultId: string,
  ): Promise<VaultAttachmentResponse>;
  runVaultAttachmentNativeAction(
    request: VaultAttachmentNativeActionRequest,
  ): Promise<VaultAttachmentNativeActionResponse>;
  loadVaultFilePreview(
    path: string,
    expectedVaultId: string,
    expectedInventoryGeneration: string,
  ): Promise<VaultFilePreviewResponse>;
  loadVaultNoteEmbed(
    sourceNotePath: string,
    target: string,
    subpath: string | null,
    expectedVaultId: string,
  ): Promise<VaultNoteEmbedResponse>;
  renderPluginMarkdownProjection(
    pluginId: string,
    sourceNotePath: string,
    content: string,
    expectedVaultId: string,
  ): Promise<PluginMarkdownProjectionResponse>;
  loadCanvas(path: string, expectedVaultId: string): Promise<CanvasLoadResponse>;
  saveCanvas(
    path: string,
    content: string,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<CanvasSaveResponse>;
  loadCanvasAttachment(
    sourceCanvasPath: string,
    target: string,
    expectedVaultId: string,
  ): Promise<CanvasAttachmentResponse>;
  setKeyBinding(targetId: ShortcutTargetId, binding: string | null): Promise<AppSettingsSnapshot>;
  resetKeyBindings(): Promise<AppSettingsSnapshot>;
  getNoteWorkflows(expectedVaultId: string): Promise<NoteWorkflowCatalogResponse>;
  setNoteWorkflows(
    expectedVaultId: string,
    settings: VaultNoteWorkflowSettings,
  ): Promise<NoteWorkflowUpdateResponse>;
  getWorkspaceSettings(expectedVaultId: string): Promise<WorkspaceSettingsResponse>;
  setWorkspaceSettings(
    expectedVaultId: string,
    settings: VaultWorkspaceSettings,
  ): Promise<WorkspaceSettingsUpdateResponse>;
  setWorkspaceMode(
    expectedVaultId: string,
    mode: VaultWorkspaceMode,
  ): Promise<WorkspaceSettingsUpdateResponse>;
  resetWorkspaceSettings(expectedVaultId: string): Promise<WorkspaceSettingsUpdateResponse>;
  openDailyNote(expectedVaultId: string): Promise<NoteCreateResponse>;
  renderNoteTemplate(
    templatePath: string,
    targetPath: string,
    expectedVaultId: string,
  ): Promise<NoteTemplateRenderResponse>;
  formatNoteWorkflowValue(
    value: "date" | "time",
    expectedVaultId: string,
  ): Promise<NoteWorkflowValueResponse>;
  chooseVault(): Promise<VaultOpenResponse>;
  runCommand(commandId: string, editorContext?: PluginEditorContext): Promise<RuntimeSnapshot>;
  runPluginEditorPaste(
    editorContext: PluginEditorContext,
    clipboardText: string,
  ): Promise<RuntimeSnapshot>;
  queryPluginEditorSuggest(editorContext: PluginEditorContext): Promise<RuntimeSnapshot>;
  selectPluginEditorSuggest(
    editorContext: PluginEditorContext,
    sessionId: string,
    itemIndex: number,
    shiftKey: boolean,
  ): Promise<RuntimeSnapshot>;
  waitForPluginMutations(options?: PluginMutationWaitOptions): Promise<RuntimeSnapshot>;
  reloadPlugin(pluginId?: string): Promise<RuntimeSnapshot>;
  unloadPlugin(pluginId?: string): Promise<RuntimeSnapshot>;
  markPluginLayoutReady(): Promise<RuntimeSnapshot>;
  openPluginSettings(pluginId: string): Promise<RuntimeSnapshot>;
  openPluginView(viewType: string, filePath?: string): Promise<RuntimeSnapshot>;
  closePluginView(): Promise<RuntimeSnapshot>;
  setPluginSurfaceBounds(bounds: PluginSurfaceBounds): Promise<void>;
  setPluginSurfaceVisible(visible: boolean): Promise<void>;
  setPluginSurfaceTheme(theme: "dark" | "light"): Promise<void>;
  setPluginSurfaceAccessibility(preferences: EffectiveAccessibilityPreferences): Promise<void>;
  openNote(path: string, paneId?: WorkspacePaneId, activate?: boolean): Promise<RuntimeSnapshot>;
  goBack(expectedVaultId: string, paneId?: WorkspacePaneId): Promise<RuntimeSnapshot>;
  goForward(expectedVaultId: string, paneId?: WorkspacePaneId): Promise<RuntimeSnapshot>;
  closeNote(
    path: string,
    expectedVaultId: string,
    paneId?: WorkspacePaneId,
  ): Promise<RuntimeSnapshot>;
  toggleTabPin(
    path: string,
    paneId: WorkspacePaneId,
    expectedVaultId: string,
  ): Promise<RuntimeSnapshot>;
  splitWorkspace(
    direction: WorkspaceSplitDirection,
    expectedVaultId: string,
  ): Promise<RuntimeSnapshot>;
  focusWorkspacePane(paneId: WorkspacePaneId, expectedVaultId: string): Promise<RuntimeSnapshot>;
  closeWorkspacePane(paneId: WorkspacePaneId, expectedVaultId: string): Promise<RuntimeSnapshot>;
  moveNoteToWorkspacePane(
    path: string,
    fromPaneId: WorkspacePaneId,
    toPaneId: WorkspacePaneId,
    expectedVaultId: string,
  ): Promise<RuntimeSnapshot>;
  reorderWorkspaceTab(
    path: string,
    paneId: WorkspacePaneId,
    targetIndex: number,
    expectedVaultId: string,
  ): Promise<RuntimeSnapshot>;
  moveNote(
    path: string,
    targetPath: string,
    expectedRevision: string,
    expectedVaultId: string,
    confirmationId?: string,
  ): Promise<NoteMoveResponse>;
  moveAttachment(
    path: string,
    targetPath: string,
    expectedRevision: string,
    expectedVaultId: string,
    confirmationId?: string,
    operation?: AttachmentOperation,
  ): Promise<AttachmentMoveResponse>;
  relinkAttachment(
    sourceNotePath: string,
    missingTarget: string,
    replacementPath: string,
    expectedSourceRevision: string,
    expectedVaultId: string,
    confirmationId?: string,
  ): Promise<AttachmentRelinkResponse>;
  restoreAttachment(
    sourceNotePath: string,
    missingTarget: string,
    sourceFileName: string,
    bytes: ArrayBuffer,
    expectedSourceRevision: string,
    expectedVaultId: string,
    confirmationId?: string,
  ): Promise<AttachmentRestoreResponse>;
  insertAttachment(
    sourceNotePath: string,
    targetPath: string,
    sourceFileName: string,
    bytes: ArrayBuffer,
    expectedSourceRevision: string,
    expectedVaultId: string,
    selectionStart: number,
    selectionEnd: number,
    confirmationId?: string,
  ): Promise<AttachmentInsertResponse>;
  insertAttachmentBatch(
    sourceNotePath: string,
    items: Array<{
      targetPath: string;
      sourceFileName: string;
      bytes: ArrayBuffer;
      selectionStart: number;
      selectionEnd: number;
    }>,
    expectedSourceRevision: string,
    expectedVaultId: string,
    confirmationId?: string,
  ): Promise<AttachmentBatchInsertResponse>;
  deleteNote(
    path: string,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<NoteDeleteResponse>;
  getVaultTrash(expectedVaultId: string): Promise<VaultTrashResponse>;
  restoreNote(
    path: string,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<NoteRestoreResponse>;
  getNoteBookmarks(expectedVaultId: string): Promise<NoteBookmarksResponse>;
  setNoteBookmark(
    path: string,
    bookmarked: boolean,
    expectedVaultId: string,
  ): Promise<NoteBookmarksResponse>;
  createNote(path: string, content: string, expectedVaultId: string): Promise<NoteCreateResponse>;
  createWorkspaceFolder(
    folderPath: string,
    expectedVaultId: string,
  ): Promise<WorkspaceFolderCreateResponse>;
  saveNote(
    path: string,
    content: string,
    expectedRevision: string,
    expectedVaultId: string,
    paneId?: WorkspacePaneId,
  ): Promise<NoteSaveResponse>;
  setNoteProperty(
    path: string,
    name: string,
    rawValue: string,
    type: NotePropertyType,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<NotePropertySetResponse>;
  removeNoteProperty(
    path: string,
    name: string,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<NotePropertyRemoveResponse>;
  getEditorDraft(
    expectedVaultId: string,
    paneId?: WorkspacePaneId,
  ): Promise<EditorDraftReadResponse>;
  saveEditorDraft(draft: EditorDraftSnapshot): Promise<EditorDraftSaveResponse>;
  clearEditorDraft(
    expectedVaultId: string,
    draftId: string,
    paneId?: WorkspacePaneId,
  ): Promise<EditorDraftClearResponse>;
  completeAutosaveFlush(result: AutosaveFlushResult): void;
  onAutosaveFlushRequest(listener: (request: AutosaveFlushRequest) => void): () => void;
  onMenuCommand(listener: (commandId: NativeMenuCommandId) => void): () => void;
  onSnapshot(listener: (snapshot: RuntimeSnapshot) => void): () => void;
  onWorkspaceLayout(listener: (snapshot: WorkspaceLayoutSnapshot) => void): () => void;
  onSettings(listener: (snapshot: AppSettingsSnapshot) => void): () => void;
  onAccessibilityPreferences(
    listener: (snapshot: AccessibilityPreferencesSnapshot) => void,
  ): () => void;
  onAppUpdate(listener: (snapshot: AppUpdateSnapshot) => void): () => void;
}
