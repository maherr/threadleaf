import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { basicSetup, EditorView } from "codemirror";
import { splitMarkdownDestinationTarget } from "../kernel/markdown-links";
import {
  type AccessibilityAccent,
  type AccessibilityOverride,
  type AccessibilityPreferences,
  type AccessibilityPreferencesSnapshot,
  accessibilityAccentChoices,
  accessibilityPreferenceRanges,
  createDefaultAccessibilityPreferences,
  type EffectiveAccessibilityPreferences,
  parseAccessibilityNumber,
  resolveAccessibilityPreferences,
} from "../shared/accessibility-preferences";
import type { AppUpdateSnapshot } from "../shared/app-updates";
import {
  type AppearanceSnapshot,
  type ColorSchemePreference,
  createDefaultVaultAppearance,
  effectiveColorScheme,
  type VaultAppearanceSettings,
} from "../shared/appearance";
import type {
  AttachmentMoveBlocker,
  AttachmentMoveResponse,
  AttachmentMoveRewritePreview,
  EditorDraftSnapshot,
  NoteCreateResponse,
  NoteDeleteResponse,
  NoteMoveBlocker,
  NoteMoveResponse,
  NoteMoveRewritePreview,
  NotePropertyType,
  NoteWorkflowCatalogResponse,
  PluginEditorContext,
  PluginEditorUpdate,
  PluginResourceDiagnostic,
  RuntimeSnapshot,
  VaultSearchResponse,
  WorkspaceCanvasSummary,
  WorkspaceFileSummary,
  WorkspaceLinkSummary,
  WorkspaceNoteSnapshot,
  WorkspacePaneId,
  WorkspacePaneSnapshot,
  WorkspacePropertySummary,
  WorkspaceSplitDirection,
  WorkspaceTabSummary,
  WorkspaceUnavailableEntry,
} from "../shared/contracts";
import {
  type AppSettingsSnapshot,
  appearanceForVault,
  bindingFromKeyboardEvent,
  createDefaultAppSettings,
  displayKeyBinding,
  noteWorkflowsForVault,
  pluginsForVault,
  type ShortcutTargetId,
  shortcutTargetForEvent,
  workspaceSettingsForVault,
} from "../shared/key-bindings";
import type {
  MigrationCandidate,
  MigrationPlan,
  ObsidianMigrationPreview,
} from "../shared/migration";
import {
  createDefaultVaultNoteWorkflowSettings,
  type VaultNoteWorkflowSettings,
} from "../shared/note-workflows";
import {
  type PluginDiagnosticCode,
  parsePluginDiagnosticMessage,
  pluginDiagnosticMessage,
} from "../shared/plugin-diagnostics";
import type {
  ManagedPluginPackageSummary,
  PluginPackageIndexSnapshot,
  PluginPackagePreviewRequest,
  PluginPackageReview,
} from "../shared/plugin-packages";
import {
  createDefaultVaultPluginSettings,
  type PluginCatalogSnapshot,
  type PluginPackageSummary,
  pluginCapabilityDefinitions,
  type VaultPluginSettings,
} from "../shared/plugins";
import { maximumPublishNoteHtmlBytes, publishNoteExportVersion } from "../shared/publish-export";
import type {
  AppearancePackageKind,
  AppearancePackagePreviewRequest,
  AppearancePackageReview,
  ManagedAppearancePackageSummary,
} from "../shared/theme-packages";
import { measureSerializableValue } from "../shared/workspace-open-diagnostics";
import {
  createDefaultVaultWorkspaceSettings,
  type VaultWorkspaceSettings,
} from "../shared/workspace-settings";
import { applyAppearanceCss } from "./appearance-renderer";
import {
  attachmentMoveCommitNotice,
  attachmentPublicationConflictMessage,
  attachmentPublicationReceipt,
} from "./attachment-move-status";
import { CanvasViewController } from "./canvas-view";
import {
  filterPaletteCommands,
  firstEnabledPaletteIndex,
  movePaletteSelection,
  type PaletteCommandDescriptor,
} from "./command-palette-model";
import {
  type ExternalTextRepresentation,
  editorDraftMatchesDiskText,
  editorDraftTextRepresentation,
  editorTextFromExternal,
  externalTextFromEditor,
  externalTextRepresentation,
  externalTextRepresentationFromDraft,
} from "./editor-text";
import {
  applyEditorTextHistoryEntry,
  boundedEditorTextHistory,
  boundedEditorTextRedoHistory,
  captureEditorTextHistoryEntry,
  type EditorTextHistoryChange,
  type EditorTextHistoryEntry,
  editorHistoryTarget,
  representationAtEditorText,
} from "./editor-text-history";
import { GraphViewController } from "./graph-view";
import {
  createLivePreviewExtension,
  type LivePreviewLink,
  type LivePreviewOptions,
} from "./live-preview";
import {
  addPreviewSourceControls,
  hydrateMarkdownPreview,
  renderMarkdownPreview,
  sanitizePluginMarkdownProjection,
} from "./markdown-preview";
import {
  type MigrationReviewIdentityState,
  migrationReviewOperationIsCurrent,
} from "./migration-review-identity";
import { pluginViewTypeForPath } from "./plugin-view-model";
import { createStandalonePublishedNoteHtml } from "./publish-export";
import {
  filterQuickSwitcherNotes,
  moveQuickSwitcherSelection,
  type QuickSwitcherNote,
  quickSwitcherNotesFromFiles,
} from "./quick-switcher-model";
import { RecoveryViewController } from "./recovery-view";
import {
  renderDocumentViewToolbarLabel,
  renderUnavailableNoticeToolbarLabel,
  unavailableNoticeText,
} from "./unavailable-notice";
import { vaultSearchDisplayContext } from "./vault-search-model";
import "./styles.css";
import type { WorkspaceLayoutSnapshot } from "../shared/workspace-layout";
import { nearestItemScrollTop, virtualListWindow } from "./virtual-list";
import { type TabDragState, tabInsertionIndex } from "./workspace-tab-dnd";

const elements = {
  vaultName: getElement("vault-name"),
  vaultIdentity: getElement("vault-identity"),
  openVault: getButton("open-vault"),
  vaultMode: getElement("vault-mode"),
  vaultSource: getElement("vault-source"),
  runtimeState: getElement("runtime-state"),
  statusShape: getElement("status-shape"),
  fileCount: getElement("file-count"),
  newNote: getButton("new-note"),
  fileSearch: getInput("file-search"),
  searchShortcut: getElement("search-shortcut"),
  filterSummary: getElement("filter-summary"),
  bookmarkShelf: getElement("bookmark-shelf"),
  bookmarkCount: getElement("bookmark-count"),
  bookmarkList: getElement("bookmark-list"),
  fileList: getElement("file-list"),
  canvasFileCount: getElement("canvas-file-count"),
  canvasFileList: getElement("canvas-file-list"),
  indexStatus: getElement("index-status"),
  recoveryCount: getElement("recovery-count"),
  workspaceRoot: getElement("workspace-root"),
  collapseLeftDock: getButton("collapse-left-dock"),
  collapseRightDock: getButton("collapse-right-dock"),
  workspacePanes: getElement("workspace-panes"),
  workspacePane: getElement("workspace-pane-primary"),
  noteTabs: getElement("note-tabs"),
  navigateBack: getButton("navigate-back"),
  navigateForward: getButton("navigate-forward"),
  splitPaneRight: getButton("split-pane-right"),
  splitPaneDown: getButton("split-pane-down"),
  moveTabPane: getButton("move-tab-pane"),
  popOutPluginView: getButton("pop-out-plugin-view"),
  closePane: getButton("close-pane"),
  notePath: getElement("note-path"),
  noteEmpty: getElement("note-empty"),
  noteView: getElement("note-view"),
  canvasView: getElement("canvas-view"),
  noteTitle: getElement("note-title"),
  noteStats: getElement("note-stats"),
  noteTags: getElement("note-tags"),
  editView: getButton("edit-view"),
  sourceView: getButton("source-view"),
  readView: getButton("read-view"),
  pluginView: getButton("plugin-view"),
  pluginSurfaceHost: getElement("plugin-surface-host"),
  pluginSurfaceStatus: getElement("plugin-surface-status"),
  noteEditorShell: getElement("note-editor-shell"),
  noteEditor: getElement("note-editor"),
  notePreview: getElement("note-preview"),
  editState: getElement("edit-state"),
  exportNote: getButton("export-note"),
  bookmarkNote: getButton("bookmark-note"),
  moveNote: getButton("move-note"),
  deleteNote: getButton("delete-note"),
  saveNote: getButton("save-note"),
  saveShortcut: getElement("save-shortcut"),
  revertNote: getButton("revert-note"),
  editNotice: getElement("edit-notice"),
  editNoticeTitle: getElement("edit-notice-title"),
  editNoticeMessage: getElement("edit-notice-message"),
  dismissEditNotice: getButton("dismiss-edit-notice"),
  outlineList: getElement("outline-list"),
  propertyCount: getElement("property-count"),
  propertyAdd: getButton("property-add"),
  propertyEditorMessage: getElement("property-editor-message"),
  propertyList: getElement("property-list"),
  linkCount: getElement("link-count"),
  outgoingList: getElement("outgoing-list"),
  backlinkList: getElement("backlink-list"),
  pluginState: getElement("plugin-state"),
  pluginName: getElement("plugin-name"),
  pluginTrustLabel: getElement("plugin-trust-label"),
  compatibilityLevel: getElement("compatibility-level"),
  commandCount: getElement("command-count"),
  commandList: getElement("command-list"),
  runCommand: getButton("run-command"),
  reloadPlugin: getButton("reload-plugin"),
  unloadPlugin: getButton("unload-plugin"),
  eventCount: getElement("event-count"),
  eventList: getElement("event-list"),
  watchSequence: getElement("watch-sequence"),
  watchMessage: getElement("watch-message"),
  commandTrigger: getButton("command-trigger"),
  commandShortcut: getElement("command-shortcut"),
  settingsTrigger: getButton("settings-trigger"),
  settingsShortcut: getElement("settings-shortcut"),
  themeToggle: getButton("theme-toggle"),
  themeLabel: getElement("theme-label"),
  commandPalette: getDialog("command-palette"),
  quickSwitcher: getDialog("quick-switcher"),
  graphDialog: getDialog("graph-dialog"),
  recoveryDialog: getDialog("recovery-dialog"),
  paletteQuery: getInput("palette-query"),
  paletteClose: getButton("palette-close"),
  paletteCount: getElement("palette-count"),
  paletteResults: getElement("palette-results"),
  paletteHint: getElement("palette-hint"),
  quickSwitcherQuery: getInput("quick-switcher-query"),
  quickSwitcherClose: getButton("quick-switcher-close"),
  quickSwitcherCount: getElement("quick-switcher-count"),
  quickSwitcherResults: getElement("quick-switcher-results"),
  quickSwitcherHint: getElement("quick-switcher-hint"),
  settingsDialog: getDialog("shortcut-settings"),
  settingsClose: getButton("settings-close"),
  settingsDone: getButton("settings-done"),
  settingsReset: getButton("settings-reset"),
  settingsPageEyebrow: getElement("settings-page-eyebrow"),
  settingsPageTitle: getElement("settings-page-title"),
  settingsNavAppearance: getButton("settings-nav-appearance"),
  settingsNavAccessibility: getButton("settings-nav-accessibility"),
  settingsNavNotes: getButton("settings-nav-notes"),
  settingsNavWorkspace: getButton("settings-nav-workspace"),
  settingsNavPlugins: getButton("settings-nav-plugins"),
  settingsNavMigration: getButton("settings-nav-migration"),
  settingsNavUpdates: getButton("settings-nav-updates"),
  settingsNavHotkeys: getButton("settings-nav-hotkeys"),
  settingsWarning: getElement("settings-warning"),
  appearanceState: getElement("appearance-state"),
  appearanceTheme: getSelect("appearance-theme"),
  appearanceThemeDetail: getElement("appearance-theme-detail"),
  appearanceSnippets: getElement("appearance-snippets"),
  appearanceReload: getButton("appearance-reload"),
  appearanceReset: getButton("appearance-reset"),
  appearancePackageKind: getSelect("appearance-package-kind"),
  appearancePackageOpen: getButton("appearance-package-open"),
  appearancePackageRefresh: getButton("appearance-package-refresh"),
  appearancePackageState: getElement("appearance-package-state"),
  appearancePackageList: getElement("appearance-package-list"),
  appearancePackageStatus: getElement("appearance-package-status"),
  appearancePackageReviewDialog: getDialog("appearance-package-review-dialog"),
  appearancePackageReviewOperation: getElement("appearance-package-review-operation"),
  appearancePackageReviewTitle: getElement("appearance-package-review-title"),
  appearancePackageReviewSummary: getElement("appearance-package-review-summary"),
  appearancePackageReviewFacts: getElement("appearance-package-review-facts"),
  appearancePackageReviewAssets: getElement("appearance-package-review-assets"),
  appearancePackageReviewLicense: getElement("appearance-package-review-license"),
  appearancePackageReviewReadme: getElement("appearance-package-review-readme"),
  appearancePackageReviewCss: getElement("appearance-package-review-css"),
  appearancePackageReviewWarnings: getElement("appearance-package-review-warnings"),
  appearancePackageReviewError: getElement("appearance-package-review-error"),
  appearancePackageReviewClose: getButton("appearance-package-review-close"),
  appearancePackageReviewCancel: getButton("appearance-package-review-cancel"),
  appearancePackageReviewApply: getButton("appearance-package-review-apply"),
  appearanceStatus: getElement("appearance-status"),
  appearanceWarnings: getElement("appearance-warnings"),
  accessibilityHighContrast: getSelect("accessibility-high-contrast"),
  accessibilityAccent: getSelect("accessibility-accent"),
  accessibilityUiFontScale: getInput("accessibility-ui-font-scale"),
  accessibilityTextFontScale: getInput("accessibility-text-font-scale"),
  accessibilityEditorFontSize: getInput("accessibility-editor-font-size"),
  accessibilityEditorLineHeight: getInput("accessibility-editor-line-height"),
  accessibilityReducedMotion: getSelect("accessibility-reduced-motion"),
  accessibilityReducedTransparency: getSelect("accessibility-reduced-transparency"),
  accessibilityReset: getButton("accessibility-reset"),
  accessibilityStatus: getElement("accessibility-status"),
  accessibilityDiagnostics: getElement("accessibility-diagnostics"),
  pluginModeState: getElement("plugin-mode-state"),
  pluginModeToggle: getButton("plugin-mode-toggle"),
  pluginInstalledCount: getElement("plugin-installed-count"),
  pluginReloadAll: getButton("plugin-reload-all"),
  pluginSearch: getInput("plugin-search"),
  pluginList: getElement("plugin-list"),
  pluginIndexQuery: getInput("plugin-index-query"),
  pluginIndexSearch: getButton("plugin-index-search"),
  pluginIndexSource: getElement("plugin-index-source"),
  pluginIndexList: getElement("plugin-index-list"),
  pluginRemovedPanel: getElement("plugin-removed-panel"),
  pluginRemovedList: getElement("plugin-removed-list"),
  pluginStatus: getElement("plugin-status"),
  pluginWarnings: getElement("plugin-warnings"),
  migrationState: getElement("migration-state"),
  migrationRefresh: getButton("migration-refresh"),
  migrationOverview: getElement("migration-overview"),
  migrationSourceList: getElement("migration-source-list"),
  migrationPluginList: getElement("migration-plugin-list"),
  migrationHotkeyList: getElement("migration-hotkey-list"),
  migrationAppearance: getElement("migration-appearance"),
  migrationWorkspace: getElement("migration-workspace"),
  migrationWarnings: getElement("migration-warnings"),
  migrationReviewSummary: getElement("migration-review-summary"),
  migrationReviewReceipt: getElement("migration-review-receipt"),
  migrationCandidateList: getElement("migration-candidate-list"),
  migrationApply: getButton("migration-apply"),
  migrationRollback: getButton("migration-rollback"),
  migrationApplyStatus: getElement("migration-apply-status"),
  appUpdateState: getElement("app-update-state"),
  appUpdateTitle: getElement("app-update-title"),
  appUpdateMessage: getElement("app-update-message"),
  appUpdateCurrentVersion: getElement("app-update-current-version"),
  appUpdateAvailableVersion: getElement("app-update-available-version"),
  appUpdatePolicy: getElement("app-update-policy"),
  appUpdateCheckedAt: getElement("app-update-checked-at"),
  appUpdateProgress: getElement("app-update-progress"),
  appUpdateProgressBar: getElement("app-update-progress-bar"),
  appUpdateProgressDetail: getElement("app-update-progress-detail"),
  appUpdateCheck: getButton("app-update-check"),
  appUpdateDownload: getButton("app-update-download"),
  appUpdateInstall: getButton("app-update-install"),
  supportBundleExport: getButton("support-bundle-export"),
  supportBundleStatus: getElement("support-bundle-status"),
  schemeSystem: getInput("scheme-system"),
  schemeLight: getInput("scheme-light"),
  schemeDark: getInput("scheme-dark"),
  settingsList: getElement("key-binding-list"),
  settingsStatus: getElement("settings-status"),
  noteWorkflowState: getElement("note-workflow-state"),
  noteWorkflowForm: getForm("note-workflow-form"),
  workflowTemplateFolder: getInput("workflow-template-folder"),
  workflowDateFormat: getInput("workflow-date-format"),
  workflowTimeFormat: getInput("workflow-time-format"),
  workflowDailyFolder: getInput("workflow-daily-folder"),
  workflowDailyFormat: getInput("workflow-daily-format"),
  workflowDailyTemplate: getSelect("workflow-daily-template"),
  workflowTemplateCount: getElement("workflow-template-count"),
  workflowSave: getButton("workflow-save"),
  workspaceSettingsState: getElement("workspace-settings-state"),
  workspaceSettingsForm: getForm("workspace-settings-form"),
  workspaceDefaultFolder: getInput("workspace-default-folder"),
  workspaceLinkStyle: getSelect("workspace-link-style"),
  workspaceAutomaticLinks: getSelect("workspace-automatic-links"),
  workspaceConfirmDelete: getSelect("workspace-confirm-delete"),
  workspaceNewTab: getSelect("workspace-new-tab"),
  workspaceEditorMode: getSelect("workspace-editor-mode"),
  workspaceDocumentView: getSelect("workspace-document-view"),
  workspaceRestorePolicy: getSelect("workspace-restore-policy"),
  workspaceSettingsReset: getButton("workspace-settings-reset"),
  workspaceSettingsSave: getButton("workspace-settings-save"),
  newNoteDialog: getDialog("new-note-dialog"),
  newNoteForm: getForm("new-note-form"),
  newNotePath: getInput("new-note-path"),
  newNoteClose: getButton("new-note-close"),
  newNoteCancel: getButton("new-note-cancel"),
  newNoteCreate: getButton("new-note-create"),
  newNoteError: getElement("new-note-error"),
  newNoteVault: getElement("new-note-vault"),
  templatePickerDialog: getDialog("template-picker-dialog"),
  templatePickerForm: getForm("template-picker-form"),
  templatePickerSelect: getSelect("template-picker-select"),
  templatePickerClose: getButton("template-picker-close"),
  templatePickerCancel: getButton("template-picker-cancel"),
  templatePickerInsert: getButton("template-picker-insert"),
  templatePickerError: getElement("template-picker-error"),
  templatePickerVault: getElement("template-picker-vault"),
  propertyDialog: getDialog("property-dialog"),
  propertyForm: getForm("property-form"),
  propertyDialogOperation: getElement("property-dialog-operation"),
  propertyDialogTitle: getElement("property-dialog-title"),
  propertyDialogDescription: getElement("property-dialog-description"),
  propertyDialogClose: getButton("property-dialog-close"),
  propertyFields: getElement("property-fields"),
  propertyName: getInput("property-name"),
  propertyType: getSelect("property-type"),
  propertyValueField: getElement("property-value-field"),
  propertyValue: getInput("property-value"),
  propertyCheckboxField: getElement("property-checkbox-field"),
  propertyCheckboxValue: getSelect("property-checkbox-value"),
  propertyValueHint: getElement("property-value-hint"),
  propertyRemoveSummary: getElement("property-remove-summary"),
  propertyRemoveName: getElement("property-remove-name"),
  propertyError: getElement("property-error"),
  propertyVault: getElement("property-vault"),
  propertyCancel: getButton("property-cancel"),
  propertySubmit: getButton("property-submit"),
  moveNoteDialog: getDialog("move-note-dialog"),
  moveNoteForm: getForm("move-note-form"),
  moveNoteTarget: getInput("move-note-target"),
  moveNoteClose: getButton("move-note-close"),
  moveNoteCancel: getButton("move-note-cancel"),
  moveNoteSubmit: getButton("move-note-submit"),
  moveNoteError: getElement("move-note-error"),
  moveNotePreviewMessage: getElement("move-note-preview-message"),
  moveNoteCurrentPath: getElement("move-note-current-path"),
  moveNoteVault: getElement("move-note-vault"),
  moveNoteBlockers: getElement("move-note-blockers"),
  moveNoteBlockerSummary: getElement("move-note-blocker-summary"),
  moveNoteBlockerList: getElement("move-note-blocker-list"),
  attachmentMoveDialog: getDialog("attachment-move-dialog"),
  attachmentMoveForm: getForm("attachment-move-form"),
  attachmentMoveTarget: getInput("attachment-move-target"),
  attachmentMoveClose: getButton("attachment-move-close"),
  attachmentMoveCancel: getButton("attachment-move-cancel"),
  attachmentMoveSubmit: getButton("attachment-move-submit"),
  attachmentMoveError: getElement("attachment-move-error"),
  attachmentMovePreviewMessage: getElement("attachment-move-preview-message"),
  attachmentMoveCurrentPath: getElement("attachment-move-current-path"),
  attachmentMoveVault: getElement("attachment-move-vault"),
  attachmentMoveBlockers: getElement("attachment-move-blockers"),
  attachmentMoveBlockerSummary: getElement("attachment-move-blocker-summary"),
  attachmentMoveBlockerList: getElement("attachment-move-blocker-list"),
  deleteNoteDialog: getDialog("delete-note-dialog"),
  deleteNoteForm: getForm("delete-note-form"),
  deleteNoteClose: getButton("delete-note-close"),
  deleteNoteCancel: getButton("delete-note-cancel"),
  deleteNoteSubmit: getButton("delete-note-submit"),
  deleteNoteError: getElement("delete-note-error"),
  deleteNoteCurrentPath: getElement("delete-note-current-path"),
  deleteNoteTrashPath: getElement("delete-note-trash-path"),
  deleteNoteImpactCopy: getElement("delete-note-impact-copy"),
  deleteNoteVault: getElement("delete-note-vault"),
  pluginPackageReviewDialog: getDialog("plugin-package-review-dialog"),
  pluginPackageReviewOperation: getElement("plugin-package-review-operation"),
  pluginPackageReviewTitle: getElement("plugin-package-review-title"),
  pluginPackageReviewSummary: getElement("plugin-package-review-summary"),
  pluginPackageFacts: getElement("plugin-package-facts"),
  pluginPackageAssets: getElement("plugin-package-assets"),
  pluginPackageLicense: getElement("plugin-package-license"),
  pluginPackageWarnings: getElement("plugin-package-warnings"),
  pluginPackageReviewError: getElement("plugin-package-review-error"),
  pluginPackageReviewClose: getButton("plugin-package-review-close"),
  pluginPackageReviewCancel: getButton("plugin-package-review-cancel"),
  pluginPackageReviewApply: getButton("plugin-package-review-apply"),
  pluginAuthorityReviewDialog: getDialog("plugin-authority-review-dialog"),
  pluginAuthorityReviewTitle: getElement("plugin-authority-review-title"),
  pluginAuthorityReviewSummary: getElement("plugin-authority-review-summary"),
  pluginAuthorityReviewFacts: getElement("plugin-authority-review-facts"),
  pluginAuthorityReviewList: getElement("plugin-authority-review-list"),
  pluginAuthorityReviewError: getElement("plugin-authority-review-error"),
  pluginAuthorityReviewClose: getButton("plugin-authority-review-close"),
  pluginAuthorityReviewCancel: getButton("plugin-authority-review-cancel"),
  pluginAuthorityReviewGrant: getButton("plugin-authority-review-grant"),
  toast: getElement("toast"),
};

const paneElementKeys = [
  "workspacePane",
  "noteTabs",
  "navigateBack",
  "navigateForward",
  "splitPaneRight",
  "splitPaneDown",
  "moveTabPane",
  "popOutPluginView",
  "closePane",
  "notePath",
  "noteEmpty",
  "noteView",
  "canvasView",
  "noteTitle",
  "noteStats",
  "noteTags",
  "editView",
  "sourceView",
  "readView",
  "pluginView",
  "pluginSurfaceHost",
  "pluginSurfaceStatus",
  "noteEditorShell",
  "noteEditor",
  "notePreview",
  "editState",
  "exportNote",
  "bookmarkNote",
  "moveNote",
  "deleteNote",
  "saveNote",
  "saveShortcut",
  "revertNote",
  "editNotice",
  "editNoticeTitle",
  "editNoticeMessage",
  "dismissEditNotice",
] as const;

type PaneElementKey = (typeof paneElementKeys)[number];
type WorkspacePaneElements = Pick<typeof elements, PaneElementKey>;

function cloneSecondaryPane(): HTMLElement {
  const clone = elements.workspacePane.cloneNode(true);
  if (!(clone instanceof HTMLElement)) {
    throw new Error("The secondary workspace pane could not be created.");
  }
  const idMap = new Map<string, string>();
  for (const element of [clone, ...clone.querySelectorAll<HTMLElement>("[id]")]) {
    if (!element.id) {
      continue;
    }
    const nextId = element === clone ? "workspace-pane-secondary" : `${element.id}-secondary`;
    idMap.set(element.id, nextId);
    element.id = nextId;
  }
  for (const element of [clone, ...clone.querySelectorAll<HTMLElement>("*")]) {
    for (const attribute of [
      "for",
      "aria-controls",
      "aria-labelledby",
      "aria-describedby",
    ] as const) {
      const value = element.getAttribute(attribute);
      if (!value) {
        continue;
      }
      element.setAttribute(
        attribute,
        value
          .split(/\s+/u)
          .map((id) => idMap.get(id) ?? id)
          .join(" "),
      );
    }
  }
  clone.dataset.paneId = "secondary";
  clone.dataset.active = "false";
  clone.ariaLabel = "Secondary editor pane";
  clone.hidden = true;
  elements.workspacePanes.append(clone);
  return clone;
}

function paneElementsFor(
  paneId: WorkspacePaneId,
  workspacePane: HTMLElement,
): WorkspacePaneElements {
  const suffix = paneId === "primary" ? "" : "-secondary";
  const element = (id: string): HTMLElement => getElement(`${id}${suffix}`);
  const button = (id: string): HTMLButtonElement => getButton(`${id}${suffix}`);
  return {
    workspacePane,
    noteTabs: element("note-tabs"),
    navigateBack: button("navigate-back"),
    navigateForward: button("navigate-forward"),
    splitPaneRight: button("split-pane-right"),
    splitPaneDown: button("split-pane-down"),
    moveTabPane: button("move-tab-pane"),
    popOutPluginView: button("pop-out-plugin-view"),
    closePane: button("close-pane"),
    notePath: element("note-path"),
    noteEmpty: element("note-empty"),
    noteView: element("note-view"),
    canvasView: element("canvas-view"),
    noteTitle: element("note-title"),
    noteStats: element("note-stats"),
    noteTags: element("note-tags"),
    editView: button("edit-view"),
    sourceView: button("source-view"),
    readView: button("read-view"),
    pluginView: button("plugin-view"),
    pluginSurfaceHost: element("plugin-surface-host"),
    pluginSurfaceStatus: element("plugin-surface-status"),
    noteEditorShell: element("note-editor-shell"),
    noteEditor: element("note-editor"),
    notePreview: element("note-preview"),
    editState: element("edit-state"),
    exportNote: button("export-note"),
    bookmarkNote: button("bookmark-note"),
    moveNote: button("move-note"),
    deleteNote: button("delete-note"),
    saveNote: button("save-note"),
    saveShortcut: element("save-shortcut"),
    revertNote: button("revert-note"),
    editNotice: element("edit-notice"),
    editNoticeTitle: element("edit-notice-title"),
    editNoticeMessage: element("edit-notice-message"),
    dismissEditNotice: button("dismiss-edit-notice"),
  };
}

const secondaryPaneRoot = cloneSecondaryPane();
const paneElements = new Map<WorkspacePaneId, WorkspacePaneElements>([
  ["primary", paneElementsFor("primary", elements.workspacePane)],
  ["secondary", paneElementsFor("secondary", secondaryPaneRoot)],
]);

const canvasViews = new Map<WorkspacePaneId, CanvasViewController>();
for (const [paneId, pane] of paneElements) {
  canvasViews.set(
    paneId,
    new CanvasViewController(pane.canvasView, {
      openPath: async (path) => {
        await openNote(path, undefined, paneId);
      },
      save: (path, content, revision) => {
        const vaultId = currentSnapshot?.vault.id;
        if (!vaultId) {
          return Promise.resolve({
            outcome: { status: "read-only", path } as const,
            snapshot: currentSnapshot as RuntimeSnapshot,
          });
        }
        return window.threadleaf.saveCanvas(path, content, revision, vaultId);
      },
      loadAttachment: (source, target) => {
        const vaultId = currentSnapshot?.vault.id;
        if (!vaultId) {
          return Promise.resolve({ status: "stale-vault", vaultId: "" } as const);
        }
        return window.threadleaf.loadCanvasAttachment(source, target, vaultId);
      },
    }),
  );
}

interface EditNoticeState {
  kind: "external" | "conflict";
  title: string;
  message: string;
}

interface RendererCommand extends PaletteCommandDescriptor {
  run: () => void | Promise<void>;
}

interface ShortcutTargetDefinition {
  id: ShortcutTargetId;
  label: string;
  description: string;
}

type EditingViewMode = "live" | "source";
type DocumentViewMode = EditingViewMode | "reading" | "plugin";
type SettingsPage =
  | "appearance"
  | "accessibility"
  | "notes"
  | "workspace"
  | "plugins"
  | "migration"
  | "updates"
  | "hotkeys";

const shortcutTargets: readonly ShortcutTargetDefinition[] = [
  {
    id: "ui.command-palette",
    label: "Open command palette",
    description: "Search every available core and compatibility-plugin action.",
  },
  {
    id: "settings.open-keybindings",
    label: "Open settings",
    description: "Review vault appearance and Threadleaf keyboard shortcuts.",
  },
  {
    id: "workspace.open-vault",
    label: "Open another vault",
    description: "Choose a local Markdown folder after any draft is saved or reverted.",
  },
  {
    id: "workspace.quick-switcher",
    label: "Open quick switcher",
    description: "Search indexed note titles and paths, then open one in the active pane.",
  },
  {
    id: "workspace.create-note",
    label: "Create new note",
    description: "Create and open a Markdown note through the recoverable writer.",
  },
  {
    id: "workspace.open-daily-note",
    label: "Open today's daily note",
    description: "Open today's note or create it through the recoverable writer.",
  },
  {
    id: "workspace.open-file-recovery",
    label: "Open file recovery",
    description: "Inspect recoverable vault trash and restore exact note paths without overwrite.",
  },
  {
    id: "workspace.export-note-html",
    label: "Export current note as HTML",
    description: "Save the current note as sanitized standalone HTML with embedded local images.",
  },
  {
    id: "workspace.toggle-note-bookmark",
    label: "Toggle bookmark for current note",
    description: "Keep or remove the current note in this vault's private bookmark shelf.",
  },
  {
    id: "workspace.toggle-tab-pin",
    label: "Toggle pin for current tab",
    description: "Keep the current tab in this pane's leading pinned tab region.",
  },
  {
    id: "workspace.open-graph-view",
    label: "Open vault graph",
    description: "Explore all indexed note connections without changing the vault.",
  },
  {
    id: "workspace.open-local-graph",
    label: "Open local graph",
    description: "Explore the connected neighborhood around the active note.",
  },
  {
    id: "workspace.move-note",
    label: "Move or rename current note",
    description: "Move only when every indexed internal link keeps the same meaning.",
  },
  {
    id: "workspace.delete-note",
    label: "Move current note to trash",
    description: "Move the note to recoverable vault trash without erasing its bytes.",
  },
  {
    id: "workspace.close-tab",
    label: "Close current tab",
    description: "Close the current note after its draft is saved or reverted.",
  },
  {
    id: "workspace.next-tab",
    label: "Activate next tab",
    description: "Move forward through the ordered open notes.",
  },
  {
    id: "workspace.previous-tab",
    label: "Activate previous tab",
    description: "Move backward through the ordered open notes.",
  },
  {
    id: "workspace.go-back",
    label: "Go back in note history",
    description: "Return to the previous note in this pane's bounded navigation history.",
  },
  {
    id: "workspace.go-forward",
    label: "Go forward in note history",
    description: "Advance to the next note in this pane's bounded navigation history.",
  },
  {
    id: "workspace.focus-note-filter",
    label: "Focus vault search",
    description: "Search saved note content, paths, headings, tags, and properties.",
  },
  {
    id: "editor.save-note",
    label: "Save current note",
    description: "Save through the revision-aware recoverable writer.",
  },
  {
    id: "editor.revert-note",
    label: "Revert current note",
    description: "Discard the current editor draft and accept the disk version.",
  },
  {
    id: "editor.insert-template",
    label: "Insert template",
    description: "Expand a configured Markdown template at the current editor selection.",
  },
  {
    id: "editor.insert-current-date",
    label: "Insert current date",
    description: "Insert the current date using this vault's template format.",
  },
  {
    id: "editor.insert-current-time",
    label: "Insert current time",
    description: "Insert the current time using this vault's template format.",
  },
  {
    id: "editor.toggle-reading-view",
    label: "Toggle editing or reading view",
    description: "Preview the current draft or return to its Markdown source.",
  },
  {
    id: "editor.toggle-source-mode",
    label: "Toggle Live Preview or Source mode",
    description: "Switch the editor between rendered Markdown and exact source.",
  },
  {
    id: "appearance.toggle-theme",
    label: "Toggle light or dark theme",
    description: "Switch the current Threadleaf color scheme.",
  },
  {
    id: "appearance.reload-custom-css",
    label: "Reload themes and CSS snippets",
    description: "Rescan the active vault and reapply selected appearance files.",
  },
  {
    id: "appearance.disable-custom-css",
    label: "Disable custom theme and snippets",
    description: "Restore Threadleaf styling without changing the selected light or dark scheme.",
  },
];

const isMac = navigator.platform.toLocaleLowerCase("en-US").includes("mac");
let currentSnapshot: RuntimeSnapshot | null = null;
let workspaceLayoutSnapshot: WorkspaceLayoutSnapshot | null = null;
let currentTabDrag: TabDragState | null = null;
let pointerTabGesture: {
  id: number;
  path: string;
  paneId: WorkspacePaneId;
  sourcePinned: boolean;
  insertionIndex: number;
  startX: number;
  startY: number;
} | null = null;
let suppressPointerActivationPath: string | null = null;
let workspaceKeyboardShortcutsBound = false;
let loadedNote: WorkspaceNoteSnapshot | null = null;
let loadedVaultId: string | null = null;
let loadedTextRepresentation: ExternalTextRepresentation = externalTextRepresentation("");
let editorTextUndoHistory: EditorTextHistoryEntry[] = [];
let editorTextRedoHistory: EditorTextHistoryEntry[] = [];
let pendingDiskNote: WorkspaceNoteSnapshot | null = null;
let diskChanged = false;
let editNoticeState: EditNoticeState | null = null;
let lastVaultWarning: string | null = null;
let lastWorkspaceLayoutWarningKey: string | null = null;
let toastTimer: number | undefined;
let busy = false;
let bookmarkVaultId: string | null = null;
let bookmarkPaths: string[] = [];
let bookmarkBusy = false;
let bookmarkRequest = 0;
let lastBookmarkWarning: string | null = null;
let publishExportBusy = false;
let saving = false;
let savingContent: string | null = null;
let dirty = false;
let syncingEditor = false;
let editorDraftId: string | null = null;
let editorDraftTimer: number | undefined;
let editorDraftPersistenceTail: Promise<void> = Promise.resolve();
let editorDraftPersistenceState: "idle" | "pending" | "saved" | "error" = "idle";
let editorDraftPersistenceError: string | null = null;
let editorDraftCheckedVaultId: string | null = null;
let editorDraftRestoreRequest = 0;
let pendingCleanDiskAcceptance = false;
let modeVaultId: string | null = null;
let modeInitialized = false;
let documentViewMode: DocumentViewMode = "live";
let editingViewMode: EditingViewMode = "live";
let renderedPreviewPath: string | null = null;
let renderedPreviewSource: string | null = null;
let renderedPreviewVaultId: string | null = null;
let renderedPreviewWatchSequence = -1;
let previewHydrationRequest = 0;
let pluginSurfaceRequest = 0;
let pluginSettingsTargetId: string | null = null;
let pluginLayoutReadyVaultId: string | null = null;
let paletteMatches: RendererCommand[] = [];
let paletteSelection = -1;
let paletteRestoreFocus: HTMLElement | null = null;
let quickSwitcherMatches: QuickSwitcherNote[] = [];
let quickSwitcherSelection = -1;
let quickSwitcherRestoreFocus: HTMLElement | null = null;
let quickSwitcherIdentity: { vaultId: string; indexGeneration: number } | null = null;
let quickSwitcherRequest = 0;
let settingsSnapshot: AppSettingsSnapshot = {
  settings: createDefaultAppSettings(),
  warning: null,
};
let settingsRestoreFocus: HTMLElement | null = null;
let settingsPage: SettingsPage = "appearance";
let recordingShortcut: ShortcutTargetId | null = null;
let settingsBusy = false;
let settingsMessage = "Select a command, then press its new shortcut.";
let settingsMessageKind: "info" | "saved" | "error" = "info";
let lastSettingsWarning: string | null = null;
let settingsLoaded = false;
let accessibilityPreferencesSnapshot: AccessibilityPreferencesSnapshot = {
  preferences: createDefaultAccessibilityPreferences(),
  warning: null,
};
let accessibilityPreferencesLoaded = false;
let accessibilityBusy = false;
let accessibilityMessage = "System accessibility preferences are active until you override them.";
let accessibilityMessageKind: "info" | "saved" | "error" = "info";
let lastAccessibilityWarning: string | null = null;
type ReadyNoteWorkflowCatalog = Extract<NoteWorkflowCatalogResponse, { status: "ready" }>;
let noteWorkflowCatalog: ReadyNoteWorkflowCatalog | null = null;
let noteWorkflowBusy = false;
let noteWorkflowRequest = 0;
let noteWorkflowMessage = "Discovering templates and daily-note preferences in this vault.";
let noteWorkflowMessageKind: "info" | "saved" | "error" = "info";
let noteWorkflowDraft: VaultNoteWorkflowSettings | null = null;
let workspaceSettingsBusy = false;
let workspaceSettingsRequest = 0;
let workspaceSettingsMessage = "Workspace preferences are private to this vault.";
let workspaceSettingsMessageKind: "info" | "saved" | "error" = "info";
let workspaceSettingsDraft: VaultWorkspaceSettings | null = null;
let workspaceModeRequest = 0;
let appearanceSnapshot: AppearanceSnapshot | null = null;
let appearanceBusy = false;
let appearanceRequest = 0;
let appearanceMessage = "Discovering themes and snippets in this vault.";
let appearanceMessageKind: "info" | "saved" | "error" = "info";
let lastAppearanceWarning = "";
let appearancePackages: ManagedAppearancePackageSummary[] = [];
let appearancePackagesVaultId: string | null = null;
let appearancePackageBusy = false;
let appearancePackageRequest = 0;
let appearancePackageMessage = "No package changes have been reviewed yet.";
let appearancePackageMessageKind: "info" | "saved" | "warning" | "error" = "info";
let appearancePackageReview: AppearancePackageReview | null = null;
let appearancePackageRestoreFocus: HTMLElement | null = null;
let pluginCatalog: PluginCatalogSnapshot | null = null;
let pluginBusy = false;
let pluginRequest = 0;
let pluginMessage = "Discovering installed plugins in this vault.";
let pluginMessageKind: "info" | "saved" | "warning" | "error" = "info";
let lastPluginWarning = "";
let pluginPackageIndex: PluginPackageIndexSnapshot | null = null;
let pluginPackageReview: PluginPackageReview | null = null;
let pluginAuthorityReview: PluginPackageSummary | null = null;
let pluginPackageRequest = 0;
let pluginPackageRestoreFocus: HTMLElement | null = null;
let pluginAuthorityRestoreFocus: HTMLElement | null = null;
let migrationPreview: ObsidianMigrationPreview | null = null;
let migrationPlan: MigrationPlan | null = null;
let migrationSelection = new Set<string>();
let migrationLastTransactionId: string | null = null;
let migrationApplyBusy = false;
let migrationBusy = false;
let migrationRequest = 0;
let migrationMutationRequest = 0;
let migrationMessage = "Open the preview to inspect existing Obsidian behavior.";
let migrationMessageKind: "info" | "saved" | "warning" | "error" = "info";
let appUpdateSnapshot: AppUpdateSnapshot | null = null;
let appUpdateActionBusy = false;
let supportBundleBusy = false;
let supportBundleMessage = "You choose where the report is saved, outside the active vault.";
let supportBundleMessageKind: "info" | "saved" | "error" = "info";
let lastPluginEditorUpdateId: string | null = null;
let pluginSurfacePresentationVisible = true;
let legacyThemeMigrationAttempted = false;
const virtualFileRowHeight = 64;
const virtualFileOverscan = 6;
let virtualFileRenderFrame: number | undefined;
let virtualFileRenderKey = "";
let virtualFileState: {
  files: WorkspaceFileSummary[];
  activePath: string | null;
} = { files: [], activePath: null };
let lastVirtualActivePath: string | null = null;
let newNoteRestoreFocus: HTMLElement | null = null;
let newNoteBusy = false;
let newNoteVaultId: string | null = null;
let templatePickerRestoreFocus: HTMLElement | null = null;
let templatePickerBusy = false;
let templatePickerVaultId: string | null = null;
let templatePickerNotePath: string | null = null;
type PropertyDialogMode = "add" | "edit" | "remove";
let propertyDialogMode: PropertyDialogMode = "add";
let propertyDialogRestoreFocus: HTMLElement | null = null;
let propertyBusy = false;
let propertyVaultId: string | null = null;
let propertyNotePath: string | null = null;
let propertyNoteRevision: string | null = null;
let propertyTargetName: string | null = null;
let moveNoteRestoreFocus: HTMLElement | null = null;
let moveNoteBusy = false;
let moveNoteVaultId: string | null = null;
let moveNoteSourcePath: string | null = null;
let moveNoteRevision: string | null = null;
let moveNoteBlockers: NoteMoveBlocker[] = [];
let moveNoteRewrites: NoteMoveRewritePreview[] = [];
let moveNoteConfirmationId: string | null = null;
let attachmentMoveRestoreFocus: HTMLElement | null = null;
let attachmentMoveBusy = false;
let attachmentMoveVaultId: string | null = null;
let attachmentMoveSourcePath: string | null = null;
let attachmentMoveRevision: string | null = null;
let attachmentMoveBlockers: AttachmentMoveBlocker[] = [];
let attachmentMoveRewrites: AttachmentMoveRewritePreview[] = [];
let attachmentMoveConfirmationId: string | null = null;
let deleteNoteRestoreFocus: HTMLElement | null = null;
let deleteNoteBusy = false;
let deleteNoteVaultId: string | null = null;
let deleteNoteSourcePath: string | null = null;
let deleteNoteRevision: string | null = null;
let deleteNoteBacklinkCount = 0;
type VaultSearchState =
  | { status: "idle" }
  | {
      status: "loading";
      query: string;
      vaultId: string;
      indexGeneration: number;
    }
  | {
      status: "error";
      query: string;
      vaultId: string;
      indexGeneration: number;
      message: string;
    }
  | { status: "ready"; response: VaultSearchResponse };
let vaultSearchState: VaultSearchState = { status: "idle" };
let vaultSearchTimer: number | undefined;
let vaultSearchRequest = 0;
let paneFocusRequest = 0;
let paneFocusTail: Promise<void> = Promise.resolve();

interface WorkspacePaneSession {
  editor: EditorView | null;
  loadedNote: WorkspaceNoteSnapshot | null;
  loadedVaultId: string | null;
  loadedTextRepresentation: ExternalTextRepresentation;
  editorTextUndoHistory: EditorTextHistoryEntry[];
  editorTextRedoHistory: EditorTextHistoryEntry[];
  pendingDiskNote: WorkspaceNoteSnapshot | null;
  diskChanged: boolean;
  editNoticeState: EditNoticeState | null;
  saving: boolean;
  savingContent: string | null;
  dirty: boolean;
  syncingEditor: boolean;
  editorDraftId: string | null;
  editorDraftTimer: number | undefined;
  editorDraftPersistenceTail: Promise<void>;
  editorDraftPersistenceState: "idle" | "pending" | "saved" | "error";
  editorDraftPersistenceError: string | null;
  editorDraftCheckedVaultId: string | null;
  editorDraftRestoreRequest: number;
  pendingCleanDiskAcceptance: boolean;
  modeVaultId: string | null;
  modeInitialized: boolean;
  documentViewMode: DocumentViewMode;
  editingViewMode: EditingViewMode;
  renderedPreviewPath: string | null;
  renderedPreviewSource: string | null;
  renderedPreviewVaultId: string | null;
  renderedPreviewWatchSequence: number;
  previewHydrationRequest: number;
  editorReadOnly: boolean;
}

function createWorkspacePaneSession(): WorkspacePaneSession {
  return {
    editor: null,
    loadedNote: null,
    loadedVaultId: null,
    loadedTextRepresentation: externalTextRepresentation(""),
    editorTextUndoHistory: [],
    editorTextRedoHistory: [],
    pendingDiskNote: null,
    diskChanged: false,
    editNoticeState: null,
    saving: false,
    savingContent: null,
    dirty: false,
    syncingEditor: false,
    editorDraftId: null,
    editorDraftTimer: undefined,
    editorDraftPersistenceTail: Promise.resolve(),
    editorDraftPersistenceState: "idle",
    editorDraftPersistenceError: null,
    editorDraftCheckedVaultId: null,
    editorDraftRestoreRequest: 0,
    pendingCleanDiskAcceptance: false,
    modeVaultId: null,
    modeInitialized: false,
    documentViewMode: "live",
    editingViewMode: "live",
    renderedPreviewPath: null,
    renderedPreviewSource: null,
    renderedPreviewVaultId: null,
    renderedPreviewWatchSequence: -1,
    previewHydrationRequest: 0,
    editorReadOnly: false,
  };
}

const paneSessions = new Map<WorkspacePaneId, WorkspacePaneSession>([
  ["primary", createWorkspacePaneSession()],
  ["secondary", createWorkspacePaneSession()],
]);
let activePaneContextId: WorkspacePaneId = "primary";
let editorsReady = false;
let editor: EditorView;

function paneSession(paneId: WorkspacePaneId): WorkspacePaneSession {
  const session = paneSessions.get(paneId);
  if (!session) {
    throw new Error(`Missing workspace pane session: ${paneId}`);
  }
  return session;
}

function captureActivePaneSession(): void {
  if (!editorsReady) {
    return;
  }
  const session = paneSession(activePaneContextId);
  session.editor = editor;
  session.loadedNote = loadedNote;
  session.loadedVaultId = loadedVaultId;
  session.loadedTextRepresentation = loadedTextRepresentation;
  session.editorTextUndoHistory = editorTextUndoHistory;
  session.editorTextRedoHistory = editorTextRedoHistory;
  session.pendingDiskNote = pendingDiskNote;
  session.diskChanged = diskChanged;
  session.editNoticeState = editNoticeState;
  session.saving = saving;
  session.savingContent = savingContent;
  session.dirty = dirty;
  session.syncingEditor = syncingEditor;
  session.editorDraftId = editorDraftId;
  session.editorDraftTimer = editorDraftTimer;
  session.editorDraftPersistenceTail = editorDraftPersistenceTail;
  session.editorDraftPersistenceState = editorDraftPersistenceState;
  session.editorDraftPersistenceError = editorDraftPersistenceError;
  session.editorDraftCheckedVaultId = editorDraftCheckedVaultId;
  session.editorDraftRestoreRequest = editorDraftRestoreRequest;
  session.pendingCleanDiskAcceptance = pendingCleanDiskAcceptance;
  session.modeVaultId = modeVaultId;
  session.modeInitialized = modeInitialized;
  session.documentViewMode = documentViewMode;
  session.editingViewMode = editingViewMode;
  session.renderedPreviewPath = renderedPreviewPath;
  session.renderedPreviewSource = renderedPreviewSource;
  session.renderedPreviewVaultId = renderedPreviewVaultId;
  session.renderedPreviewWatchSequence = renderedPreviewWatchSequence;
  session.previewHydrationRequest = previewHydrationRequest;
  session.editorReadOnly = editorReadOnly;
}

function activatePaneContext(paneId: WorkspacePaneId): void {
  if (editorsReady && paneId === activePaneContextId) {
    return;
  }
  captureActivePaneSession();
  const session = paneSession(paneId);
  const nextElements = paneElements.get(paneId);
  if (!nextElements) {
    throw new Error(`Missing workspace pane elements: ${paneId}`);
  }
  Object.assign(elements, nextElements);
  activePaneContextId = paneId;
  if (editorsReady) {
    if (!session.editor) {
      throw new Error(`Workspace pane editor is not ready: ${paneId}`);
    }
    editor = session.editor;
  }
  loadedNote = session.loadedNote;
  loadedVaultId = session.loadedVaultId;
  loadedTextRepresentation = session.loadedTextRepresentation;
  editorTextUndoHistory = boundedEditorTextHistory(session.editorTextUndoHistory);
  editorTextRedoHistory = boundedEditorTextRedoHistory(session.editorTextRedoHistory);
  pendingDiskNote = session.pendingDiskNote;
  diskChanged = session.diskChanged;
  editNoticeState = session.editNoticeState;
  saving = session.saving;
  savingContent = session.savingContent;
  dirty = session.dirty;
  syncingEditor = session.syncingEditor;
  editorDraftId = session.editorDraftId;
  editorDraftTimer = session.editorDraftTimer;
  editorDraftPersistenceTail = session.editorDraftPersistenceTail;
  editorDraftPersistenceState = session.editorDraftPersistenceState;
  editorDraftPersistenceError = session.editorDraftPersistenceError;
  editorDraftCheckedVaultId = session.editorDraftCheckedVaultId;
  editorDraftRestoreRequest = session.editorDraftRestoreRequest;
  pendingCleanDiskAcceptance = session.pendingCleanDiskAcceptance;
  // Mode state is pane-local, but it must never be carried into another vault.
  if (session.modeVaultId !== currentSnapshot?.vault.id) {
    session.modeVaultId = currentSnapshot?.vault.id ?? null;
    session.modeInitialized = false;
    session.documentViewMode = "live";
    session.editingViewMode = "live";
  }
  session.modeVaultId = currentSnapshot?.vault.id ?? null;
  modeVaultId = session.modeVaultId;
  modeInitialized = session.modeInitialized;
  documentViewMode = session.documentViewMode;
  editingViewMode = session.editingViewMode;
  renderedPreviewPath = session.renderedPreviewPath;
  renderedPreviewSource = session.renderedPreviewSource;
  renderedPreviewVaultId = session.renderedPreviewVaultId;
  renderedPreviewWatchSequence = session.renderedPreviewWatchSequence;
  previewHydrationRequest = session.previewHydrationRequest;
  editorReadOnly = session.editorReadOnly;
}

function runInPaneContext<T>(paneId: WorkspacePaneId, operation: () => T): T {
  const previousPaneId = activePaneContextId;
  activatePaneContext(paneId);
  try {
    return operation();
  } finally {
    activatePaneContext(previousPaneId);
  }
}

function workspacePaneSnapshot(
  paneId: WorkspacePaneId = activePaneContextId,
  snapshot: RuntimeSnapshot | null = currentSnapshot,
): WorkspacePaneSnapshot | null {
  return snapshot?.workspace?.panes.find((pane) => pane.id === paneId) ?? null;
}

function anyPaneDirty(): boolean {
  captureActivePaneSession();
  return [...paneSessions.values()].some((session) => session.dirty);
}

function anyPaneSaving(): boolean {
  captureActivePaneSession();
  return [...paneSessions.values()].some((session) => session.saving);
}

const editorStyleNonce = "threadleaf-codemirror";
const appearanceStyle = document.createElement("style");
appearanceStyle.id = "threadleaf-custom-appearance";
appearanceStyle.nonce = editorStyleNonce;
document.head.append(appearanceStyle);
const pluginStyle = document.createElement("style");
pluginStyle.id = "threadleaf-compatibility-plugin-styles";
pluginStyle.nonce = editorStyleNonce;
document.head.append(pluginStyle);
const accessibilityStyle = document.createElement("style");
accessibilityStyle.id = "threadleaf-accessibility-protection";
accessibilityStyle.nonce = editorStyleNonce;
document.head.append(accessibilityStyle);
const systemColorScheme = window.matchMedia("(prefers-color-scheme: dark)");
const systemHighContrast = window.matchMedia("(prefers-contrast: more)");
const systemReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const systemReducedTransparency = window.matchMedia("(prefers-reduced-transparency: reduce)");
const sourceHighlight = HighlightStyle.define([
  { tag: tags.heading, color: "var(--accent-strong)", fontWeight: "700" },
  {
    tag: [tags.link, tags.url],
    color: "var(--accent-strong)",
    textDecoration: "underline",
  },
  { tag: tags.strong, color: "var(--ink)", fontWeight: "750" },
  { tag: tags.emphasis, color: "var(--ink-soft)", fontStyle: "italic" },
  { tag: [tags.meta, tags.contentSeparator], color: "var(--signal)" },
  { tag: [tags.monospace, tags.string], color: "var(--ink)" },
  { tag: tags.comment, color: "var(--ink-muted)" },
]);
const editorAccess = new Compartment();
const editorPresentation = new Compartment();
let editorReadOnly = false;

function livePreviewOptions(paneId: WorkspacePaneId): LivePreviewOptions {
  const sourceNotePath = (): string | null => {
    const session = paneSession(paneId);
    return (paneId === activePaneContextId ? loadedNote : session.loadedNote)?.path ?? null;
  };
  const expectedVaultId = (): string | null => {
    const session = paneSession(paneId);
    return paneId === activePaneContextId ? loadedVaultId : session.loadedVaultId;
  };
  return {
    sourceNotePath,
    expectedVaultId,
    activateLink: (link) => {
      runInPaneContext(paneId, () => void activateLivePreviewLink(link));
    },
    loadImage: (sourceNotePath, target, expectedVaultId) =>
      window.threadleaf.loadVaultImage(sourceNotePath, target, expectedVaultId),
    loadNoteEmbed: (sourceNotePath, target, subpath, expectedVaultId) =>
      window.threadleaf.loadVaultNoteEmbed(sourceNotePath, target, subpath, expectedVaultId),
  };
}

function editorPresentationExtension(paneId: WorkspacePaneId) {
  return editingViewMode === "live" ? createLivePreviewExtension(livePreviewOptions(paneId)) : [];
}

function editorTextHistoryChanges(update: ViewUpdate): EditorTextHistoryChange[] {
  const changes: EditorTextHistoryChange[] = [];
  update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    changes.push({
      from: fromA,
      to: toA,
      newFrom: fromB,
      newTo: toB,
      insert: inserted.toString(),
      removedText: update.startState.doc.sliceString(fromA, toA),
      removedLineEndings: [],
      insertedLineEndings: [],
    });
  });
  return changes;
}

function updateEditorTextRepresentation(update: ViewUpdate): void {
  const changes = editorTextHistoryChanges(update);
  const nextEditorText = update.state.doc.toString();
  const userEvents = update.transactions.map((transaction) =>
    transaction.annotation(Transaction.userEvent),
  );
  const isUndo = userEvents.some((event) => event === "undo" || event?.startsWith("undo."));
  const isRedo = userEvents.some((event) => event === "redo" || event?.startsWith("redo."));
  if (isUndo || isRedo) {
    const sourceHistory = isUndo ? editorTextUndoHistory : editorTextRedoHistory;
    const targetIndex = editorHistoryTarget(
      sourceHistory,
      update.startState.doc.toString(),
      nextEditorText,
      isUndo ? "undo" : "redo",
    );
    if (targetIndex >= 0) {
      if (isUndo) {
        const moved = sourceHistory.splice(targetIndex);
        for (let index = moved.length - 1; index >= 0; index -= 1) {
          const entry = moved[index];
          if (entry) {
            loadedTextRepresentation = applyEditorTextHistoryEntry(
              loadedTextRepresentation,
              entry,
              "reverse",
            );
          }
        }
        editorTextRedoHistory = boundedEditorTextRedoHistory([...moved, ...editorTextRedoHistory]);
      } else {
        const moved = sourceHistory.splice(0, targetIndex + 1);
        for (const entry of moved) {
          loadedTextRepresentation = applyEditorTextHistoryEntry(
            loadedTextRepresentation,
            entry,
            "forward",
          );
        }
        editorTextUndoHistory = boundedEditorTextHistory([...editorTextUndoHistory, ...moved]);
      }
      return;
    }
    // An undo/redo that did not come from our tracked editor history (for
    // example a newly installed CodeMirror history extension) must not be
    // recorded as a normal edit. Rebase metadata to the visible document and
    // wait for the next ordinary transaction to establish a fresh delta.
    loadedTextRepresentation = representationAtEditorText(loadedTextRepresentation, nextEditorText);
    editorTextUndoHistory = [];
    editorTextRedoHistory = [];
    return;
  }
  const entry = captureEditorTextHistoryEntry(
    loadedTextRepresentation,
    update.startState.doc.toString(),
    changes,
  );
  editorTextUndoHistory = boundedEditorTextHistory([...editorTextUndoHistory, entry]);
  loadedTextRepresentation = applyEditorTextHistoryEntry(
    loadedTextRepresentation,
    entry,
    "forward",
  );
  editorTextRedoHistory = [];
}

function editorExtensions(paneId: WorkspacePaneId) {
  return [
    basicSetup,
    markdown({ base: markdownLanguage }),
    EditorView.lineWrapping,
    EditorView.cspNonce.of(editorStyleNonce),
    editorAccess.of([
      EditorState.readOnly.of(editorReadOnly),
      EditorView.editable.of(!editorReadOnly),
    ]),
    editorPresentation.of(editorPresentationExtension(paneId)),
    syntaxHighlighting(sourceHighlight),
    EditorView.contentAttributes.of({
      "aria-label": "Markdown editor",
      "aria-multiline": "true",
      spellcheck: "true",
    }),
    EditorView.updateListener.of((update) => {
      runInPaneContext(paneId, () => {
        if (syncingEditor) {
          return;
        }
        if (update.docChanged) {
          updateEditorTextRepresentation(update);
          const wasDirty = dirty;
          dirty =
            loadedNote !== null &&
            externalTextFromEditor(update.state.doc.toString(), loadedTextRepresentation) !==
              loadedNote.content;
          if (dirty) {
            scheduleEditorDraftPersistence();
          } else if (wasDirty) {
            clearCurrentEditorDraft();
            schedulePendingDiskAcceptance();
          }
          renderEditControls();
          return;
        }
        if (dirty && update.selectionSet) {
          scheduleEditorDraftPersistence();
        }
      });
    }),
  ];
}

function createEditorState(
  content: string,
  selection: { anchor: number; head?: number } = { anchor: 0 },
  paneId: WorkspacePaneId = activePaneContextId,
): EditorState {
  const editorContent = editorTextFromExternal(content);
  const anchor = Math.max(0, Math.min(selection.anchor, editorContent.length));
  const head = Math.max(0, Math.min(selection.head ?? anchor, editorContent.length));
  return EditorState.create({
    doc: editorContent,
    selection: { anchor, head },
    extensions: editorExtensions(paneId),
  });
}

for (const paneId of ["primary", "secondary"] as const) {
  const pane = paneElements.get(paneId);
  if (!pane) {
    throw new Error(`Missing workspace pane editor host: ${paneId}`);
  }
  paneSession(paneId).editor = new EditorView({
    state: createEditorState("", { anchor: 0 }, paneId),
    parent: pane.noteEditor,
  });
}
editor = paneSession("primary").editor as EditorView;
editorsReady = true;
captureActivePaneSession();

function getElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing required element: ${id}`);
  }
  return element;
}

function getButton(id: string): HTMLButtonElement {
  const element = getElement(id);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`Expected a button: ${id}`);
  }
  return element;
}

function getInput(id: string): HTMLInputElement {
  const element = getElement(id);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`Expected an input: ${id}`);
  }
  return element;
}

function getSelect(id: string): HTMLSelectElement {
  const element = getElement(id);
  if (!(element instanceof HTMLSelectElement)) {
    throw new Error(`Expected a select: ${id}`);
  }
  return element;
}

function getDialog(id: string): HTMLDialogElement {
  const element = getElement(id);
  if (!(element instanceof HTMLDialogElement)) {
    throw new Error(`Expected a dialog: ${id}`);
  }
  return element;
}

function getForm(id: string): HTMLFormElement {
  const element = getElement(id);
  if (!(element instanceof HTMLFormElement)) {
    throw new Error(`Expected a form: ${id}`);
  }
  return element;
}

function bindingFor(targetId: ShortcutTargetId): string | null {
  return settingsSnapshot.settings.keyBindings[targetId] ?? null;
}

function shortcutFor(targetId: ShortcutTargetId): string | null {
  const binding = bindingFor(targetId);
  return binding === null ? null : displayKeyBinding(binding, isMac);
}

function vaultOpening(): boolean {
  return currentSnapshot?.startup?.phase === "opening";
}

function readOnlyVault(): boolean {
  return currentSnapshot?.vault.mode === "synthetic-read-only";
}

function propertyEditBlockReason(): string | null {
  if (!loadedNote || !loadedVaultId) {
    return "Open a note to manage its properties.";
  }
  if (readOnlyVault()) {
    return "Open a local vault before editing properties.";
  }
  if (!loadedNote.propertyEditor.editable) {
    return loadedNote.propertyEditor.message ?? "This frontmatter is read-only.";
  }
  if (dirty) {
    return "Save or revert the current note before editing its properties.";
  }
  if (busy || saving || propertyBusy) {
    return "Threadleaf is finishing another action.";
  }
  return null;
}

function syncEditorAccess(): void {
  const readOnly = readOnlyVault();
  if (readOnly !== editorReadOnly) {
    editor.dispatch({
      effects: editorAccess.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
    editorReadOnly = readOnly;
  }
  elements.noteEditor.dataset.readOnly = String(readOnly);
}

function syncEditorPresentation(): void {
  editor.dispatch({
    effects: editorPresentation.reconfigure(editorPresentationExtension(activePaneContextId)),
  });
  elements.noteEditorShell.dataset.editorMode = editingViewMode;
}

function commandCatalog(): RendererCommand[] {
  const opening = vaultOpening();
  const readOnly = readOnlyVault();
  const tabs = opening ? [] : (workspacePaneSnapshot()?.tabs ?? []);
  const activeTab = tabs.find((tab) => tab.active) ?? null;
  const paneCount = currentSnapshot?.workspace?.panes.length ?? 1;
  const paneDirty = anyPaneDirty();
  const paneSaving = anyPaneSaving();
  const commands: RendererCommand[] = [
    {
      id: "workspace.create-note",
      label: "Create new note",
      category: "Workspace",
      keywords: ["new", "file", "markdown", "note"],
      shortcut: shortcutFor("workspace.create-note"),
      enabled: Boolean(
        currentSnapshot?.vault.id && !opening && !readOnly && !busy && !paneSaving && !paneDirty,
      ),
      disabledReason: opening
        ? `Opening ${currentSnapshot?.startup?.targetName ?? "the vault"}.`
        : readOnly
          ? "Open a local vault before creating notes."
          : paneDirty
            ? "Save or revert drafts before creating another note."
            : currentSnapshot?.vault.id
              ? "Threadleaf is finishing another action."
              : "No writable vault is active.",
      run: openNewNoteDialog,
    },
    {
      id: "workspace.open-daily-note",
      label: "Open today's daily note",
      category: "Workspace",
      keywords: ["daily", "today", "journal", "template", "date"],
      shortcut: shortcutFor("workspace.open-daily-note"),
      enabled: Boolean(
        currentSnapshot?.vault.id && !opening && !readOnly && !busy && !paneSaving && !paneDirty,
      ),
      disabledReason: opening
        ? `Opening ${currentSnapshot?.startup?.targetName ?? "the vault"}.`
        : readOnly
          ? "Open a local vault before using daily notes."
          : paneDirty
            ? "Save or revert drafts before opening today's note."
            : "Threadleaf is finishing another action.",
      run: openTodaysDailyNote,
    },
    {
      id: "workspace.open-file-recovery",
      label: "Open file recovery",
      category: "File",
      keywords: ["recovery", "restore", "trash", "deleted", "files"],
      shortcut: shortcutFor("workspace.open-file-recovery"),
      enabled: Boolean(currentSnapshot?.vault.id && !opening && !readOnly && !busy),
      disabledReason: opening
        ? `Opening ${currentSnapshot?.startup?.targetName ?? "the vault"}.`
        : readOnly
          ? "Open a writable local vault before restoring notes."
          : currentSnapshot?.vault.id
            ? "Threadleaf is finishing another action."
            : "No vault is active.",
      run: () => {
        if (graphView.open) {
          graphView.close(false);
        }
        return recoveryView.show();
      },
    },
    {
      id: "workspace.export-note-html",
      label: "Export current note as standalone HTML",
      category: "File",
      keywords: ["export", "publish", "html", "standalone", "offline", "share"],
      shortcut: shortcutFor("workspace.export-note-html"),
      enabled: Boolean(
        loadedNote && loadedVaultId && !opening && !busy && !saving && !dirty && !publishExportBusy,
      ),
      disabledReason: opening
        ? `The index for ${currentSnapshot?.startup?.targetName ?? "the vault"} is still opening.`
        : !loadedNote
          ? "No note is open."
          : dirty
            ? "Save or revert the current note before exporting it."
            : "Threadleaf is finishing another action.",
      run: exportCurrentNoteAsHtml,
    },
    {
      id: "workspace.open-graph-view",
      label: "Open vault graph",
      category: "View",
      keywords: ["graph", "links", "connections", "network", "global"],
      shortcut: shortcutFor("workspace.open-graph-view"),
      enabled: Boolean(currentSnapshot?.vault.id && !opening),
      disabledReason: opening
        ? `The index for ${currentSnapshot?.startup?.targetName ?? "the vault"} is still opening.`
        : "No vault is active.",
      run: () => {
        if (recoveryView.open) {
          recoveryView.close(false);
        }
        return graphView.show("global");
      },
    },
    {
      id: "workspace.open-local-graph",
      label: "Open local graph",
      category: "View",
      keywords: ["graph", "links", "connections", "network", "local", "note"],
      shortcut: shortcutFor("workspace.open-local-graph"),
      enabled: Boolean(currentSnapshot?.vault.id && loadedNote && !opening),
      disabledReason: opening
        ? `The index for ${currentSnapshot?.startup?.targetName ?? "the vault"} is still opening.`
        : "Open a note before opening its local graph.",
      run: () => {
        if (recoveryView.open) {
          recoveryView.close(false);
        }
        return graphView.show("local");
      },
    },
    {
      id: "workspace.toggle-note-bookmark",
      label:
        loadedNote && bookmarkPaths.includes(loadedNote.path)
          ? "Remove bookmark from current note"
          : "Bookmark current note",
      category: "Workspace",
      keywords: ["bookmark", "star", "favorite", "favourite", "pin", "note"],
      shortcut: shortcutFor("workspace.toggle-note-bookmark"),
      enabled: Boolean(
        loadedNote &&
          loadedVaultId &&
          bookmarkVaultId === loadedVaultId &&
          !opening &&
          !busy &&
          !bookmarkBusy,
      ),
      disabledReason: opening
        ? `The index for ${currentSnapshot?.startup?.targetName ?? "the vault"} is still opening.`
        : !loadedNote
          ? "No note is open."
          : bookmarkVaultId !== loadedVaultId
            ? "Bookmarks are not available for the active vault."
            : "Threadleaf is finishing another action.",
      run: toggleCurrentNoteBookmark,
    },
    {
      id: "workspace.toggle-tab-pin",
      label: activeTab?.pinned ? "Unpin current tab" : "Pin current tab",
      category: "Workspace",
      keywords: ["pin", "unpin", "tab", "keep", "workspace"],
      shortcut: shortcutFor("workspace.toggle-tab-pin"),
      enabled: Boolean(activeTab && loadedVaultId && !opening && !busy && !saving),
      disabledReason: opening
        ? `The index for ${currentSnapshot?.startup?.targetName ?? "the vault"} is still opening.`
        : !activeTab
          ? "No note tab is active."
          : "Threadleaf is finishing another action.",
      run: toggleCurrentTabPin,
    },
    {
      id: "workspace.move-note",
      label: "Move or rename current note",
      category: "Workspace",
      keywords: ["move", "rename", "path", "file", "refactor"],
      shortcut: shortcutFor("workspace.move-note"),
      enabled: Boolean(loadedNote && loadedVaultId && !readOnly && !busy && !saving && !dirty),
      disabledReason: !loadedNote
        ? "No note is open."
        : readOnly
          ? "Open a local vault before moving notes."
          : dirty
            ? "Save or revert the current note before moving it."
            : "Threadleaf is finishing another action.",
      run: openMoveNoteDialog,
    },
    {
      id: "workspace.manage-properties",
      label: "Add note property",
      category: "Workspace",
      keywords: ["property", "properties", "frontmatter", "metadata", "yaml"],
      shortcut: null,
      enabled: propertyEditBlockReason() === null,
      disabledReason: propertyEditBlockReason(),
      run: () => openPropertyDialog("add"),
    },
    {
      id: "workspace.delete-note",
      label: "Move current note to trash",
      category: "Workspace",
      keywords: ["delete", "remove", "trash", "recover", "file"],
      shortcut: shortcutFor("workspace.delete-note"),
      enabled: Boolean(loadedNote && loadedVaultId && !readOnly && !busy && !saving && !dirty),
      disabledReason: !loadedNote
        ? "No note is open."
        : readOnly
          ? "Open a local vault before moving notes to trash."
          : dirty
            ? "Save or revert the current note before moving it to trash."
            : "Threadleaf is finishing another action.",
      run: openDeleteNoteDialog,
    },
    {
      id: "workspace.close-tab",
      label: "Close current tab",
      category: "Workspace",
      keywords: ["close", "tab", "note"],
      shortcut: shortcutFor("workspace.close-tab"),
      enabled: Boolean(
        loadedNote && loadedVaultId && !busy && !saving && !dirty && !activeTab?.pinned,
      ),
      disabledReason: !loadedNote
        ? "No note tab is active."
        : activeTab?.pinned
          ? "Unpin the current tab before closing it."
          : dirty
            ? "Save or revert the current note before closing it."
            : "Threadleaf is finishing another action.",
      run: closeActiveTab,
    },
    {
      id: "workspace.go-back",
      label: "Go back in note history",
      category: "Workspace",
      keywords: ["back", "history", "previous", "note", "navigation"],
      shortcut: shortcutFor("workspace.go-back"),
      enabled: Boolean(
        workspacePaneSnapshot()?.canGoBack && !opening && !busy && !saving && !dirty,
      ),
      disabledReason: dirty
        ? "Save or revert the open draft before navigating note history."
        : workspacePaneSnapshot()?.canGoBack
          ? "Threadleaf is finishing another action."
          : "No earlier note is available in this pane's history.",
      run: () => navigateHistory("back"),
    },
    {
      id: "workspace.go-forward",
      label: "Go forward in note history",
      category: "Workspace",
      keywords: ["forward", "history", "next", "note", "navigation"],
      shortcut: shortcutFor("workspace.go-forward"),
      enabled: Boolean(
        workspacePaneSnapshot()?.canGoForward && !opening && !busy && !saving && !dirty,
      ),
      disabledReason: dirty
        ? "Save or revert the open draft before navigating note history."
        : workspacePaneSnapshot()?.canGoForward
          ? "Threadleaf is finishing another action."
          : "No later note is available in this pane's history.",
      run: () => navigateHistory("forward"),
    },
    {
      id: "workspace.split-right",
      label: paneCount < 2 ? "Split editor right" : "Arrange panes side by side",
      category: "Workspace",
      keywords: ["split", "pane", "right", "vertical", "side by side"],
      shortcut: null,
      enabled: !opening && !busy && !paneSaving && (paneCount > 1 || !paneDirty),
      disabledReason: paneDirty
        ? "Save or revert the open draft before creating another pane."
        : "Threadleaf is finishing another action.",
      run: () => splitWorkspace("vertical"),
    },
    {
      id: "workspace.split-down",
      label: paneCount < 2 ? "Split editor down" : "Stack editor panes",
      category: "Workspace",
      keywords: ["split", "pane", "down", "horizontal", "stack"],
      shortcut: null,
      enabled: !opening && !busy && !paneSaving && (paneCount > 1 || !paneDirty),
      disabledReason: paneDirty
        ? "Save or revert the open draft before creating another pane."
        : "Threadleaf is finishing another action.",
      run: () => splitWorkspace("horizontal"),
    },
    {
      id: "workspace.move-tab-to-other-pane",
      label: "Move current tab to other pane",
      category: "Workspace",
      keywords: ["move", "tab", "pane", "split"],
      shortcut: null,
      enabled: paneCount > 1 && Boolean(loadedNote) && !busy && !paneSaving && !paneDirty,
      disabledReason:
        paneCount < 2
          ? "Split the editor before moving a tab."
          : paneDirty
            ? "Save or revert drafts before moving a tab."
            : "Threadleaf is finishing another action.",
      run: moveActiveTabToOtherPane,
    },
    {
      id: "workspace.close-pane",
      label: "Close current editor pane",
      category: "Workspace",
      keywords: ["close", "pane", "split", "collapse"],
      shortcut: null,
      enabled: paneCount > 1 && !busy && !paneSaving && !paneDirty,
      disabledReason:
        paneCount < 2
          ? "Only one editor pane is open."
          : paneDirty
            ? "Save or revert drafts before closing a pane."
            : "Threadleaf is finishing another action.",
      run: closeActiveWorkspacePane,
    },
    {
      id: "workspace.next-tab",
      label: "Activate next tab",
      category: "Workspace",
      keywords: ["cycle", "forward", "switch", "tab"],
      shortcut: shortcutFor("workspace.next-tab"),
      enabled: tabs.length > 1 && !busy && !saving && !dirty,
      disabledReason:
        tabs.length < 2
          ? "Open another note to cycle tabs."
          : dirty
            ? "Save or revert the current note before switching tabs."
            : "Threadleaf is finishing another action.",
      run: () => cycleTab(1),
    },
    {
      id: "workspace.previous-tab",
      label: "Activate previous tab",
      category: "Workspace",
      keywords: ["cycle", "backward", "switch", "tab"],
      shortcut: shortcutFor("workspace.previous-tab"),
      enabled: tabs.length > 1 && !busy && !saving && !dirty,
      disabledReason:
        tabs.length < 2
          ? "Open another note to cycle tabs."
          : dirty
            ? "Save or revert the current note before switching tabs."
            : "Threadleaf is finishing another action.",
      run: () => cycleTab(-1),
    },
    {
      id: "workspace.open-vault",
      label: "Open another vault",
      category: "Workspace",
      keywords: ["folder", "switch", "choose"],
      shortcut: shortcutFor("workspace.open-vault"),
      enabled: !busy && !paneSaving && !paneDirty,
      disabledReason: paneDirty
        ? "Save or revert drafts before switching vaults."
        : busy || paneSaving
          ? "Threadleaf is finishing another action."
          : null,
      run: chooseVault,
    },
    {
      id: "workspace.quick-switcher",
      label: "Open quick switcher",
      category: "Workspace",
      keywords: ["quick", "switch", "note", "file", "open", "title", "path"],
      shortcut: shortcutFor("workspace.quick-switcher"),
      enabled: Boolean(!opening && !busy && !saving && !dirty),
      disabledReason: dirty
        ? "Save or revert the open draft before opening the quick switcher."
        : opening
          ? `The index for ${currentSnapshot?.startup?.targetName ?? "the vault"} is still opening.`
          : "Threadleaf is finishing another action.",
      run: openQuickSwitcher,
    },
    {
      id: "workspace.focus-note-filter",
      label: "Focus vault search",
      category: "Workspace",
      keywords: ["find", "files", "content", "full text", "quick switcher"],
      shortcut: shortcutFor("workspace.focus-note-filter"),
      enabled: !opening,
      disabledReason: opening
        ? `The index for ${currentSnapshot?.startup?.targetName ?? "the vault"} is still opening.`
        : null,
      run: focusVaultSearch,
    },
    {
      id: "editor.save-note",
      label: "Save current note",
      category: "Editor",
      keywords: ["write", "commit"],
      shortcut: shortcutFor("editor.save-note"),
      enabled: Boolean(loadedNote && loadedVaultId && !readOnly && dirty && !busy && !saving),
      disabledReason: !loadedNote
        ? "No note is open."
        : readOnly
          ? "Open a local vault before saving notes."
          : !dirty
            ? "The current note has no unsaved changes."
            : "Threadleaf is finishing another action.",
      run: saveActiveNote,
    },
    {
      id: "editor.revert-note",
      label: "Revert current note",
      category: "Editor",
      keywords: ["discard", "reload", "undo changes"],
      shortcut: shortcutFor("editor.revert-note"),
      enabled: Boolean(loadedNote && dirty && !busy && !saving),
      disabledReason: !loadedNote
        ? "No note is open."
        : !dirty
          ? "The current note has no unsaved changes."
          : "Threadleaf is finishing another action.",
      run: revertActiveNote,
    },
    {
      id: "editor.insert-template",
      label: "Insert template",
      category: "Editor",
      keywords: ["template", "insert", "snippet", "boilerplate"],
      shortcut: shortcutFor("editor.insert-template"),
      enabled: Boolean(loadedNote && loadedVaultId && !readOnly && !busy && !saving),
      disabledReason: !loadedNote
        ? "No note is open."
        : readOnly
          ? "Open a local vault before editing notes."
          : "Threadleaf is finishing another action.",
      run: openTemplatePicker,
    },
    {
      id: "editor.insert-current-date",
      label: "Insert current date",
      category: "Editor",
      keywords: ["date", "today", "insert", "template"],
      shortcut: shortcutFor("editor.insert-current-date"),
      enabled: Boolean(loadedNote && loadedVaultId && !readOnly && !busy && !saving),
      disabledReason: !loadedNote
        ? "No note is open."
        : readOnly
          ? "Open a local vault before editing notes."
          : "Threadleaf is finishing another action.",
      run: () => insertFormattedWorkflowValue("date"),
    },
    {
      id: "editor.insert-current-time",
      label: "Insert current time",
      category: "Editor",
      keywords: ["time", "clock", "insert", "template"],
      shortcut: shortcutFor("editor.insert-current-time"),
      enabled: Boolean(loadedNote && loadedVaultId && !readOnly && !busy && !saving),
      disabledReason: !loadedNote
        ? "No note is open."
        : readOnly
          ? "Open a local vault before editing notes."
          : "Threadleaf is finishing another action.",
      run: () => insertFormattedWorkflowValue("time"),
    },
    {
      id: "editor.toggle-reading-view",
      label: documentViewMode === "reading" ? "Switch to editing view" : "Switch to reading view",
      category: "Editor",
      keywords: ["preview", "read", "source", "markdown"],
      shortcut: shortcutFor("editor.toggle-reading-view"),
      enabled: Boolean(loadedNote && !busy && !saving),
      disabledReason: loadedNote ? "Threadleaf is finishing another action." : "No note is open.",
      run: toggleDocumentView,
    },
    {
      id: "editor.toggle-source-mode",
      label: editingViewMode === "live" ? "Switch to Source mode" : "Switch to Live Preview",
      category: "Editor",
      keywords: ["live preview", "source", "markdown", "edit"],
      shortcut: shortcutFor("editor.toggle-source-mode"),
      enabled: Boolean(loadedNote && !busy && !saving),
      disabledReason: loadedNote ? "Threadleaf is finishing another action." : "No note is open.",
      run: toggleEditingView,
    },
    {
      id: "appearance.toggle-theme",
      label: `Switch to ${document.documentElement.dataset.theme === "dark" ? "light" : "dark"} theme`,
      category: "Appearance",
      keywords: ["color", "dark", "light"],
      shortcut: shortcutFor("appearance.toggle-theme"),
      enabled: true,
      disabledReason: null,
      run: toggleTheme,
    },
    {
      id: "appearance.reload-custom-css",
      label: "Reload themes and CSS snippets",
      category: "Appearance",
      keywords: ["refresh", "rescan", "theme", "snippet", "css"],
      shortcut: shortcutFor("appearance.reload-custom-css"),
      enabled: Boolean(currentSnapshot?.vault.id && !opening && !appearanceBusy),
      disabledReason: opening
        ? "Appearance files become available after the vault opens."
        : appearanceBusy
          ? "Threadleaf is applying appearance settings."
          : "No vault is active.",
      run: () => refreshAppearance("Appearance files reloaded."),
    },
    {
      id: "appearance.disable-custom-css",
      label: "Disable custom theme and snippets",
      category: "Appearance",
      keywords: ["safe", "reset", "recover", "theme", "snippet", "css"],
      shortcut: shortcutFor("appearance.disable-custom-css"),
      enabled: Boolean(currentSnapshot?.vault.id && !opening && !appearanceBusy),
      disabledReason: opening
        ? "Appearance files become available after the vault opens."
        : appearanceBusy
          ? "Threadleaf is applying appearance settings."
          : "No vault is active.",
      run: disableCustomAppearance,
    },
    {
      id: "settings.open-keybindings",
      label: "Open settings",
      category: "Settings",
      keywords: [
        "appearance",
        "theme",
        "snippet",
        "plugin",
        "community",
        "shortcut",
        "hotkey",
        "preferences",
      ],
      shortcut: shortcutFor("settings.open-keybindings"),
      enabled: true,
      disabledReason: null,
      run: openSettings,
    },
    {
      id: "support.export-bundle",
      label: "Save privacy-safe support bundle",
      category: "Support",
      keywords: ["bug", "feedback", "diagnostics", "report", "privacy", "beta"],
      shortcut: null,
      enabled: !supportBundleBusy,
      disabledReason: supportBundleBusy ? "Threadleaf is preparing the support bundle." : null,
      run: exportSupportBundle,
    },
  ];

  for (const command of opening ? [] : (currentSnapshot?.commands ?? [])) {
    const owner = (currentSnapshot?.plugins ?? []).find(({ id }) => id === command.ownerId);
    commands.push({
      id: `plugin.command.${command.id}`,
      label: command.name,
      category: owner?.name ?? "Compatibility plugin",
      keywords: [command.id, "plugin", "compatibility"],
      shortcut: null,
      enabled: !busy && !saving,
      disabledReason: busy || saving ? "Threadleaf is finishing another action." : null,
      run: () => runCompatibilityCommand(command.id),
    });
  }

  commands.push(
    {
      id: "plugin.reload",
      label: "Reload enabled community plugins",
      category: "Compatibility",
      keywords: ["refresh", "restart", "plugin"],
      shortcut: null,
      enabled: Boolean(
        currentSnapshot?.vault.id &&
          !opening &&
          currentPluginPreference().compatibilityMode === "enabled" &&
          currentPluginPreference().enabledPluginIds.length > 0 &&
          !pluginSafeModeActive() &&
          !pluginBusy,
      ),
      disabledReason: pluginSafeModeActive()
        ? "Threadleaf started in plugin safe mode."
        : pluginBusy
          ? "Threadleaf is updating community plugins."
          : "No enabled community plugin is available.",
      run: reloadPlugins,
    },
    {
      id: "plugin.unload",
      label: "Turn on restricted mode",
      category: "Compatibility",
      keywords: ["disable", "stop", "safe", "restricted", "plugin"],
      shortcut: null,
      enabled:
        !opening &&
        currentPluginPreference().compatibilityMode === "enabled" &&
        !pluginSafeModeActive() &&
        !pluginBusy,
      disabledReason: pluginSafeModeActive()
        ? "Threadleaf started in plugin safe mode."
        : pluginBusy
          ? "Threadleaf is updating community plugins."
          : "Restricted mode is already active.",
      run: () => setCompatibilityMode("restricted"),
    },
  );
  return commands;
}

function focusVaultSearch(): void {
  elements.fileSearch.focus();
  elements.fileSearch.select();
}

function splitPreviewTarget(value: string): { target: string; subpath: string | null } {
  return splitMarkdownDestinationTarget(value);
}

function previewLinkIdentity(anchor: HTMLAnchorElement): {
  syntax: "wiki" | "markdown";
  target: string;
  subpath: string | null;
} | null {
  const syntax = anchor.dataset.threadleafLink;
  if (syntax !== "wiki" && syntax !== "markdown") {
    return null;
  }
  if (syntax === "markdown") {
    return { syntax, ...splitPreviewTarget(anchor.dataset.threadleafTarget ?? "") };
  }
  return {
    syntax,
    target: anchor.dataset.threadleafTarget ?? "",
    subpath: anchor.dataset.threadleafSubpath || null,
  };
}

function matchingPreviewLink(
  links: readonly WorkspaceLinkSummary[],
  anchor: HTMLAnchorElement,
): WorkspaceLinkSummary | null {
  const identity = previewLinkIdentity(anchor);
  if (!identity) {
    return null;
  }
  return (
    links.find(
      (link) =>
        link.syntax === identity.syntax &&
        link.target === identity.target &&
        (link.subpath ?? null) === identity.subpath,
    ) ?? null
  );
}

function decoratePreviewLinks(
  root: HTMLElement,
  links: readonly WorkspaceLinkSummary[],
  sourceNotePath: string,
): void {
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>("a[data-threadleaf-link]")) {
    anchor.dataset.threadleafOriginPath = sourceNotePath;
    if (anchor.dataset.threadleafLink === "external") {
      anchor.ariaLabel = `${anchor.textContent?.trim() || "External link"}, external link`;
      anchor.title = "External link opening is disabled in this beta.";
      continue;
    }
    const identity = previewLinkIdentity(anchor);
    if (identity) {
      anchor.dataset.threadleafTarget = identity.target;
      anchor.dataset.threadleafSubpath = identity.subpath ?? "";
    }
    const link = matchingPreviewLink(links, anchor);
    const status = link?.status ?? "unresolved";
    anchor.dataset.linkStatus = status;
    anchor.ariaLabel = `${anchor.textContent?.trim() || "Internal link"}, ${status} internal link`;
    if (link?.path) {
      anchor.dataset.threadleafPath = link.path;
    }
  }
}

/**
 * The exact CITE 0.1.2 compatibility fixture is the only plugin wired into this bounded settled
 * Reading projection slice (see docs/compatibility/open-plugin-api.md). This deliberately targets
 * one named, already-evidenced plugin rather than every installed plugin that registers a
 * Markdown post processor: it is a plugin-exact compatibility workflow, not a claim of general
 * dynamic render-child or Live Preview/CM6 delivery for arbitrary community plugins.
 */
const settledMarkdownProjectionPluginId = "cite";

function renderPluginMarkdownProjectionPanel(
  container: HTMLElement,
  state: "loading" | "ready" | "unavailable",
  detail: { html?: DocumentFragment; pluginName: string; message?: string },
): void {
  container
    .querySelector<HTMLElement>(`[data-plugin-projection="${settledMarkdownProjectionPluginId}"]`)
    ?.remove();
  const doc = container.ownerDocument;
  const panel = doc.createElement("section");
  panel.className = "plugin-markdown-projection";
  panel.dataset.pluginProjection = settledMarkdownProjectionPluginId;
  panel.dataset.pluginProjectionState = state;
  const heading = doc.createElement("p");
  heading.className = "plugin-markdown-projection-heading";
  heading.textContent = `${detail.pluginName} settled Reading projection`;
  panel.append(heading);
  const body = doc.createElement("div");
  body.className = "plugin-markdown-projection-body";
  if (state === "ready" && detail.html) {
    body.append(detail.html);
  } else {
    body.textContent = detail.message ?? (state === "loading" ? "Rendering…" : "Unavailable.");
  }
  panel.append(body);
  container.append(panel);
}

/**
 * Fetch CITE's settled (already-executed) Markdown post-processor projection for the note
 * currently shown in Reading view, sanitize it through `sanitizePluginMarkdownProjection` (the
 * returned `html` itself is unsanitized plugin output -- this call site is what makes it safe to
 * mount), and display it. `isCurrent` is the same note+revision+vault staleness guard
 * `hydrateMarkdownPreview` uses, so a response that arrives after the user switched notes, edited
 * the draft, or the vault changed is dropped instead of being mounted against different content.
 * Silently does nothing when CITE is not installed in this vault at all; an installed-but-inactive
 * CITE renders its honest "unavailable" state.
 */
function renderCiteSettledProjection(
  sourceNotePath: string,
  source: string,
  vaultId: string,
  isCurrent: () => boolean,
): void {
  const citePlugin = currentSnapshot?.plugins?.find(
    ({ id }) => id === settledMarkdownProjectionPluginId,
  );
  if (!citePlugin) {
    return;
  }
  renderPluginMarkdownProjectionPanel(elements.notePreview, "loading", {
    pluginName: citePlugin.name,
  });
  window.threadleaf
    .renderPluginMarkdownProjection(
      settledMarkdownProjectionPluginId,
      sourceNotePath,
      source,
      vaultId,
    )
    .then((response) => {
      if (!isCurrent()) {
        return;
      }
      if (response.status === "ready") {
        renderPluginMarkdownProjectionPanel(elements.notePreview, "ready", {
          html: sanitizePluginMarkdownProjection(response.html),
          pluginName: citePlugin.name,
        });
      } else if (response.status === "unavailable") {
        renderPluginMarkdownProjectionPanel(elements.notePreview, "unavailable", {
          pluginName: citePlugin.name,
          message: response.message,
        });
      } else {
        elements.notePreview
          .querySelector(`[data-plugin-projection="${settledMarkdownProjectionPluginId}"]`)
          ?.remove();
      }
    })
    .catch(() => {
      if (!isCurrent()) {
        return;
      }
      renderPluginMarkdownProjectionPanel(elements.notePreview, "unavailable", {
        pluginName: citePlugin.name,
        message: "The settled Markdown projection request failed.",
      });
    });
}

function sourceLineForSubpath(
  note: WorkspaceNoteSnapshot | null,
  subpath: string | null | undefined,
): number | null {
  if (!note || !subpath?.startsWith("#")) {
    return null;
  }
  let headingText: string;
  try {
    headingText = decodeURIComponent(subpath.slice(1));
  } catch {
    headingText = subpath.slice(1);
  }
  const normalized = headingText.normalize("NFC").toLocaleLowerCase("en-US");
  return (
    note.headings.find(
      (heading) => heading.text.normalize("NFC").toLocaleLowerCase("en-US") === normalized,
    )?.line ?? null
  );
}

function renderReadingView(): void {
  if (!loadedNote) {
    previewHydrationRequest += 1;
    elements.notePreview.replaceChildren();
    renderedPreviewPath = null;
    renderedPreviewSource = null;
    renderedPreviewVaultId = null;
    renderedPreviewWatchSequence = -1;
    return;
  }
  const source = editor.state.doc.toString();
  const vaultId = loadedVaultId;
  const watchSequence = currentSnapshot?.workspace?.watcher.lastSequence ?? 0;
  if (
    renderedPreviewPath === loadedNote.path &&
    renderedPreviewSource === source &&
    renderedPreviewVaultId === vaultId &&
    renderedPreviewWatchSequence === watchSequence
  ) {
    return;
  }
  const request = previewHydrationRequest + 1;
  previewHydrationRequest = request;
  const fragment = addPreviewSourceControls(renderMarkdownPreview(source), {
    sourceNotePath: loadedNote.path,
  });
  elements.notePreview.replaceChildren(fragment);
  decoratePreviewLinks(elements.notePreview, loadedNote.outgoing, loadedNote.path);
  renderedPreviewPath = loadedNote.path;
  renderedPreviewSource = source;
  renderedPreviewVaultId = vaultId;
  renderedPreviewWatchSequence = watchSequence;
  if (vaultId) {
    const isCurrent = () =>
      previewHydrationRequest === request &&
      loadedVaultId === vaultId &&
      renderedPreviewPath === loadedNote?.path &&
      renderedPreviewSource === source;
    void hydrateMarkdownPreview(elements.notePreview, {
      sourceNotePath: loadedNote.path,
      expectedVaultId: vaultId,
      loadImage: (sourceNotePath, target, expectedVaultId) =>
        window.threadleaf.loadVaultImage(sourceNotePath, target, expectedVaultId),
      loadAttachment: (sourceNotePath, target, expectedVaultId) =>
        window.threadleaf.loadVaultAttachment(sourceNotePath, target, expectedVaultId),
      loadNoteEmbed: (sourceNotePath, target, subpath, expectedVaultId) =>
        window.threadleaf.loadVaultNoteEmbed(sourceNotePath, target, subpath, expectedVaultId),
      loadCanvas: (path, expectedVaultId) => window.threadleaf.loadCanvas(path, expectedVaultId),
      decorateLinks: decoratePreviewLinks,
      isCurrent,
    });
    renderCiteSettledProjection(loadedNote.path, source, vaultId, isCurrent);
  }
}

function renderDocumentView(): void {
  const hasNote = loadedNote !== null;
  const activePane = workspacePaneSnapshot();
  const activeCanvas = activePane?.activeCanvas;
  const activeUnavailable = activePane?.activeUnavailable;
  const hasCanvas = activeCanvas !== undefined && activeCanvas !== null;
  const settingsPending = Boolean(currentSnapshot?.vault.id && hasNote && !settingsLoaded);
  if (settingsPending) {
    // The first settings snapshot is the only source of truth for a vault's
    // persisted mode. Keep the note surface hidden until it arrives so a
    // stale transient value cannot flash before the persisted preference wins.
    elements.noteEmpty.hidden = true;
    elements.noteEditorShell.hidden = true;
    elements.notePreview.hidden = true;
    elements.noteView.hidden = true;
    elements.canvasView.hidden = !hasCanvas;
    elements.pluginSurfaceHost.hidden = true;
    renderDocumentViewToolbarLabel(elements.notePath, {
      loadedPath: loadedNote?.path ?? activeCanvas?.path ?? null,
      unavailable: activeUnavailable,
    });
    elements.editView.disabled = true;
    elements.sourceView.disabled = true;
    elements.readView.disabled = true;
    elements.pluginView.disabled = true;
    elements.editView.setAttribute("aria-pressed", "false");
    elements.sourceView.setAttribute("aria-pressed", "false");
    elements.readView.setAttribute("aria-pressed", "false");
    elements.pluginView.setAttribute("aria-pressed", "false");
    elements.noteView.dataset.view = "pending";
    elements.noteEditorShell.dataset.editorMode = "pending";
    return;
  }
  const reading = hasNote && documentViewMode === "reading";
  const live = hasNote && documentViewMode === "live";
  const source = hasNote && documentViewMode === "source";
  const pluginSettings =
    pluginSettingsTargetId !== null ||
    currentSnapshot?.pluginSurface?.viewType === "threadleaf-plugin-settings";
  const plugin = documentViewMode === "plugin" && (hasNote || pluginSettings);
  const popoutState = workspaceLayoutSnapshot?.popout.state ?? "closed";
  const popoutOpen = popoutState === "open";
  const hasPluginSurface =
    currentSnapshot?.pluginSurface !== null && currentSnapshot?.pluginSurface !== undefined;
  const pluginViewType = preferredPluginViewType();
  const visiblePluginViewType = pluginSettings
    ? "threadleaf-plugin-settings"
    : (pluginViewType ?? (plugin ? (currentSnapshot?.pluginSurface?.viewType ?? null) : null));
  elements.noteEmpty.hidden = hasNote || hasCanvas || plugin;
  elements.noteEditorShell.hidden = reading;
  elements.notePreview.hidden = !reading;
  elements.noteView.hidden = !hasNote || plugin;
  elements.canvasView.hidden = !hasCanvas;
  elements.pluginSurfaceHost.hidden = !plugin;
  elements.pluginSurfaceHost.dataset.popoutState = popoutState;
  elements.pluginSurfaceStatus.textContent = !hasPluginSurface
    ? "Opening plugin view…"
    : popoutOpen
      ? "Plugin view is open in a separate window."
      : popoutState === "degraded"
        ? "Plugin pop-out unavailable; plugin view is open in the main window."
        : "Plugin view is open in the main window.";
  elements.noteView.dataset.view = reading ? "reading" : documentViewMode;
  elements.noteEditorShell.dataset.editorMode = editingViewMode;
  elements.noteEditorShell.classList.toggle("is-live-preview", editingViewMode === "live");
  elements.editView.disabled = !hasNote || busy || saving;
  elements.sourceView.disabled = !hasNote || busy || saving;
  elements.readView.disabled = !hasNote || busy || saving;
  elements.pluginView.hidden = visiblePluginViewType === null && !plugin;
  elements.pluginView.disabled = plugin
    ? busy || saving
    : !hasNote || !pluginViewType || busy || saving || dirty;
  elements.pluginView.textContent = pluginSettings ? "Options" : "Plugin";
  elements.editView.setAttribute("aria-pressed", String(live));
  elements.sourceView.setAttribute("aria-pressed", String(source));
  elements.readView.setAttribute("aria-pressed", String(reading));
  elements.pluginView.setAttribute("aria-pressed", String(plugin));
  elements.pluginView.title = plugin
    ? `Close ${pluginSettings ? "plugin options" : "community plugin view"}`
    : visiblePluginViewType
      ? `Open ${visiblePluginViewType} community plugin view`
      : "No community plugin view is registered";
  elements.popOutPluginView.hidden = !hasPluginSurface && !popoutOpen;
  elements.popOutPluginView.disabled = busy || saving || (!hasPluginSurface && !popoutOpen);
  elements.popOutPluginView.textContent = popoutOpen ? "↙" : "↗";
  elements.popOutPluginView.ariaLabel = popoutOpen ? "Reattach plugin view" : "Pop out plugin view";
  elements.popOutPluginView.title = popoutOpen ? "Reattach plugin view" : "Pop out plugin view";
  const pluginName =
    pluginSettings && plugin
      ? (currentSnapshot?.plugins ?? []).find(({ id }) => id === pluginSettingsTargetId)?.name
      : undefined;
  const pluginLabel =
    pluginSettings && plugin
      ? (currentSnapshot?.pluginSurface?.displayText ??
        (pluginName ? `${pluginName} settings` : "Plugin settings"))
      : null;
  renderDocumentViewToolbarLabel(elements.notePath, {
    loadedPath: loadedNote?.path ?? activeCanvas?.path ?? null,
    unavailable: activeUnavailable,
    pluginLabel,
  });
  const shortcut = shortcutFor("editor.toggle-reading-view");
  elements.editView.title = "Live Preview editing mode";
  elements.sourceView.title = "Source editing mode";
  elements.readView.title = shortcut ? `Reading view (${shortcut})` : "Reading view";
  if (reading) {
    renderReadingView();
  }
  if (plugin) {
    window.requestAnimationFrame(() => void updatePluginSurfaceBounds());
  }
}

function preferredPluginViewType(
  snapshot: RuntimeSnapshot | null = currentSnapshot,
): string | null {
  return loadedNote ? pluginViewTypeForPath(loadedNote.path, snapshot?.integrations) : null;
}

async function updatePluginSurfaceBounds(): Promise<void> {
  if (elements.pluginSurfaceHost.hidden) {
    return;
  }
  const bounds = elements.pluginSurfaceHost.getBoundingClientRect();
  await window.threadleaf.setPluginSurfaceBounds({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  });
}

async function activatePluginView(): Promise<void> {
  const viewType = preferredPluginViewType();
  const filePath = loadedNote?.path;
  if (!viewType || !filePath || busy || saving || dirty) {
    if (dirty) {
      showToast("Save or revert the current note before opening its plugin view.");
    }
    return;
  }
  const request = ++pluginSurfaceRequest;
  documentViewMode = "plugin";
  renderDocumentView();
  setActionState(true);
  try {
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    await updatePluginSurfaceBounds();
    await ensurePluginLayoutReady();
    const snapshot = await window.threadleaf.openPluginView(viewType, filePath);
    if (request !== pluginSurfaceRequest || documentViewMode !== "plugin") {
      await window.threadleaf.closePluginView();
      return;
    }
    render(snapshot);
  } catch (error) {
    documentViewMode = editingViewMode;
    renderDocumentView();
    showToast(pluginIpcErrorMessage(error, "runtime-view-failed"));
  } finally {
    setActionState(false);
  }
}

async function ensurePluginLayoutReady(): Promise<void> {
  const vaultId = currentSnapshot?.vault.id ?? null;
  if (!vaultId || pluginLayoutReadyVaultId === vaultId) {
    return;
  }
  pluginLayoutReadyVaultId = vaultId;
  try {
    render(await window.threadleaf.markPluginLayoutReady());
  } catch (error) {
    showToast(
      `Plugin startup reported a compatibility gap: ${pluginIpcErrorMessage(error, "runtime-load-failed")}`,
    );
  }
}

async function activatePluginSettings(pluginId: string): Promise<void> {
  if (
    busy ||
    saving ||
    pluginBusy ||
    !(currentSnapshot?.integrations?.settingTabPluginIds ?? []).includes(pluginId)
  ) {
    return;
  }
  if (elements.settingsDialog.open) {
    closeSettings(false);
  }
  const request = ++pluginSurfaceRequest;
  pluginSettingsTargetId = pluginId;
  documentViewMode = "plugin";
  renderDocumentView();
  setActionState(true);
  try {
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    await updatePluginSurfaceBounds();
    await ensurePluginLayoutReady();
    const snapshot = await window.threadleaf.openPluginSettings(pluginId);
    if (
      request !== pluginSurfaceRequest ||
      documentViewMode !== "plugin" ||
      pluginSettingsTargetId !== pluginId
    ) {
      await window.threadleaf.closePluginView();
      return;
    }
    render(snapshot);
  } catch (error) {
    pluginSettingsTargetId = null;
    documentViewMode = editingViewMode;
    renderDocumentView();
    showToast(pluginIpcErrorMessage(error, "runtime-settings-failed"));
  } finally {
    setActionState(false);
  }
}

function resetPaneDocumentModes(vaultId: string | null): void {
  for (const paneId of ["primary", "secondary"] as const) {
    runInPaneContext(paneId, () => {
      modeVaultId = vaultId;
      modeInitialized = false;
      documentViewMode = "live";
      editingViewMode = "live";
      syncEditorPresentation();
    });
  }
  activatePaneContext(activePaneContextId);
  renderDocumentView();
}

function modeForDocumentView(mode: Exclude<DocumentViewMode, "plugin">): {
  editorMode: VaultWorkspaceSettings["editorMode"];
  documentView: VaultWorkspaceSettings["documentView"];
} {
  return {
    editorMode: mode === "source" ? "source" : editingViewMode,
    documentView: mode,
  };
}

function persistDocumentMode(): void {
  const expectedVaultId = currentSnapshot?.vault.id;
  if (!expectedVaultId || !settingsLoaded) {
    return;
  }
  const request = ++workspaceModeRequest;
  const persistedDocumentView = documentViewMode === "plugin" ? editingViewMode : documentViewMode;
  void window.threadleaf
    .setWorkspaceMode(expectedVaultId, modeForDocumentView(persistedDocumentView))
    .then((response) => {
      if (
        request !== workspaceModeRequest ||
        response.status !== "updated" ||
        response.vaultId !== currentSnapshot?.vault.id
      ) {
        return;
      }
      workspaceSettingsDraft = { ...response.settings };
      applySettingsSnapshot(response.appSettings);
    })
    .catch((error) => {
      if (request === workspaceModeRequest && currentSnapshot?.vault.id === expectedVaultId) {
        showToast(
          `Workspace mode was not saved: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
}

function setDocumentView(mode: DocumentViewMode, focus = true): void {
  if (
    !loadedNote &&
    mode === "plugin" &&
    pluginSettingsTargetId === null &&
    currentSnapshot?.pluginSurface?.viewType !== "threadleaf-plugin-settings"
  ) {
    return;
  }
  const closingPlugin = documentViewMode === "plugin" && mode !== "plugin";
  const editingModeChanged = (mode === "live" || mode === "source") && editingViewMode !== mode;
  if (mode === "live" || mode === "source") {
    editingViewMode = mode;
  }
  documentViewMode = mode;
  modeVaultId = currentSnapshot?.vault.id ?? null;
  modeInitialized = true;
  if (mode !== "plugin") {
    pluginSettingsTargetId = null;
    persistDocumentMode();
  }
  if (editingModeChanged) {
    syncEditorPresentation();
  }
  renderDocumentView();
  renderPaletteResults();
  if (closingPlugin) {
    pluginSurfaceRequest += 1;
    void window.threadleaf
      .closePluginView()
      .then(render)
      .catch(() => undefined);
  }
  if (!focus) {
    return;
  }
  if (mode === "live" || mode === "source") {
    if (loadedNote) {
      editor.focus();
    } else {
      elements.fileSearch.focus();
    }
  } else if (mode === "reading") {
    elements.notePreview.focus();
  }
}

function applyWorkspaceViewDefaults(
  settings: VaultWorkspaceSettings,
  options: { force?: boolean } = {},
): void {
  const vaultId = currentSnapshot?.vault.id ?? null;
  for (const paneId of ["primary", "secondary"] as const) {
    runInPaneContext(paneId, () => {
      if (dirty || saving || (!options.force && modeInitialized && modeVaultId === vaultId)) {
        return;
      }
      modeVaultId = vaultId;
      modeInitialized = true;
      editingViewMode = settings.documentView === "source" ? "source" : settings.editorMode;
      documentViewMode = settings.documentView;
      syncEditorPresentation();
    });
  }
  activatePaneContext(activePaneContextId);
  renderDocumentView();
}

function toggleDocumentView(): void {
  setDocumentView(documentViewMode === "reading" ? editingViewMode : "reading");
}

function toggleEditingView(): void {
  setDocumentView(editingViewMode === "live" ? "source" : "live");
}

function scrollToDocumentLine(line: number): void {
  if (documentViewMode === "reading") {
    const block = elements.notePreview.querySelector<HTMLElement>(
      `.preview-block[data-source-line="${Math.max(1, line)}"]`,
    );
    block?.scrollIntoView({ block: "start" });
    return;
  }
  scrollToSourceLine(line);
}

async function activatePreviewLink(anchor: HTMLAnchorElement): Promise<void> {
  if (anchor.dataset.threadleafRawLink === "true") {
    showToast("Raw HTML links are not active in this beta.");
    return;
  }
  if (anchor.dataset.threadleafLink === "external") {
    showToast("External link opening is disabled in this beta.");
    return;
  }
  if (!loadedNote) {
    return;
  }
  const status = anchor.dataset.linkStatus;
  const path = anchor.dataset.threadleafPath;
  if (status !== "resolved" || !path) {
    showToast(
      status === "ambiguous"
        ? "That link has more than one possible destination."
        : "That link does not resolve to a note in this vault.",
    );
    return;
  }
  const identity = previewLinkIdentity(anchor);
  const activate = currentWorkspacePreference().newTabBehavior === "focus";
  const opened = await openNote(path, undefined, activePaneContextId, activate);
  if (!opened || !activate) {
    return;
  }
  const line = sourceLineForSubpath(loadedNote, identity?.subpath);
  if (line) {
    scrollToDocumentLine(line);
  } else if (identity?.subpath?.startsWith("^")) {
    showToast("Block-anchor navigation is not available yet.");
  }
}

async function activateLivePreviewLink(identity: LivePreviewLink): Promise<void> {
  if (identity.external) {
    showToast("External link opening is disabled in this beta.");
    return;
  }
  if (!loadedNote) {
    return;
  }
  const link =
    loadedNote.outgoing.find(
      (candidate) =>
        candidate.syntax === identity.syntax &&
        candidate.target === identity.target &&
        (candidate.subpath ?? null) === identity.subpath,
    ) ?? null;
  if (link?.status !== "resolved" || !link.path) {
    showToast(
      link?.status === "ambiguous"
        ? "That link has more than one possible destination."
        : "That link does not resolve to a note in this vault.",
    );
    return;
  }
  const activate = currentWorkspacePreference().newTabBehavior === "focus";
  if (!(await openNote(link.path, undefined, activePaneContextId, activate)) || !activate) {
    return;
  }
  const line = sourceLineForSubpath(loadedNote, identity.subpath);
  if (line) {
    scrollToDocumentLine(line);
  } else if (identity.subpath?.startsWith("^")) {
    showToast("Block-anchor navigation is not available yet.");
  }
}

async function activatePreviewSourceAction(sourceAction: HTMLButtonElement): Promise<void> {
  const line = Number.parseInt(sourceAction.dataset.sourceLine ?? "", 10);
  const sourcePath = sourceAction.dataset.sourcePath || loadedNote?.path;
  if (!sourcePath || !Number.isSafeInteger(line) || line < 1) {
    return;
  }
  if (loadedNote?.path !== sourcePath && !(await openNote(sourcePath))) {
    return;
  }
  setDocumentView("source", false);
  window.requestAnimationFrame(() => scrollToSourceLine(line));
}

async function activatePreviewEmbed(openButton: HTMLButtonElement): Promise<void> {
  const filePath = openButton.dataset.threadleafOpenPath;
  const activate = currentWorkspacePreference().newTabBehavior === "focus";
  if (
    !filePath ||
    !(await openNote(filePath, undefined, activePaneContextId, activate)) ||
    !activate
  ) {
    return;
  }
  const subpath = openButton.dataset.threadleafSubpath || null;
  const line = sourceLineForSubpath(loadedNote, subpath);
  if (line) {
    scrollToDocumentLine(line);
  } else if (subpath?.startsWith("^")) {
    showToast("Opened the source note. Block-anchor scrolling is not available yet.");
  }
}

function openAttachmentMoveDialog(
  sourcePath: string,
  revision: string,
  restoreFocus?: HTMLElement,
): void {
  if (elements.attachmentMoveDialog.open) {
    elements.attachmentMoveTarget.focus();
    elements.attachmentMoveTarget.select();
    return;
  }
  if (!loadedVaultId || readOnlyVault() || busy || anyPaneSaving() || anyPaneDirty()) {
    showToast(
      readOnlyVault()
        ? "Open a local vault before publishing attachment copies."
        : anyPaneDirty()
          ? "Save or revert drafts before publishing an attachment copy."
          : "Threadleaf is finishing another action.",
    );
    return;
  }
  if (elements.commandPalette.open) closeCommandPalette(false);
  if (documentViewMode === "plugin") setDocumentView(editingViewMode, false);
  attachmentMoveRestoreFocus =
    restoreFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  attachmentMoveBusy = false;
  attachmentMoveVaultId = loadedVaultId;
  attachmentMoveSourcePath = sourcePath;
  attachmentMoveRevision = revision;
  attachmentMoveBlockers = [];
  attachmentMoveRewrites = [];
  attachmentMoveConfirmationId = null;
  elements.attachmentMoveTarget.value = sourcePath;
  elements.attachmentMoveError.textContent = "";
  elements.attachmentMovePreviewMessage.textContent = "";
  elements.attachmentMoveDialog.showModal();
  renderAttachmentMoveDialog();
  window.requestAnimationFrame(() => {
    const nameStart = sourcePath.lastIndexOf("/") + 1;
    elements.attachmentMoveTarget.focus();
    elements.attachmentMoveTarget.setSelectionRange(nameStart, sourcePath.length);
  });
}

function activatePreviewAttachmentAction(actionButton: HTMLButtonElement): void {
  const action = actionButton.dataset.threadleafAttachmentAction;
  const target = actionButton.dataset.threadleafAttachmentPath;
  if (!target) {
    return;
  }
  if (action === "move") {
    const card = actionButton.closest<HTMLElement>(".preview-attachment-card");
    const revision = card?.dataset.threadleafAttachmentRevision;
    if (revision) openAttachmentMoveDialog(target, revision, actionButton);
    return;
  }
  if (action !== "open" && action !== "reveal") return;
  // The card deliberately exposes the safe action metadata without granting a
  // renderer-originated shell/network capability.  A future native bridge can
  // consume these data attributes without changing the byte-preserving loader.
  showToast(
    action === "open"
      ? `Opening local attachments is not enabled yet: ${target}`
      : `Revealing local attachments is not enabled yet: ${target}`,
  );
}

async function runCompatibilityCommand(commandId: string): Promise<void> {
  await runAction(async () => {
    const snapshot = await window.threadleaf.runCommand(commandId, pluginEditorContext());
    if (snapshot.pluginSurface) {
      documentViewMode = "plugin";
      renderDocumentView();
      window.requestAnimationFrame(() => void updatePluginSurfaceBounds());
    }
    showToast(snapshot.notices.at(-1) ?? "Command completed.");
    return snapshot;
  });
}

function pluginEditorContext(): PluginEditorContext | undefined {
  if (!loadedNote) {
    return undefined;
  }
  const selection = editor.state.selection.main;
  return {
    content: editor.state.doc.toString(),
    path: loadedNote.path,
    revision: loadedNote.revision,
    selection: { anchor: selection.anchor, head: selection.head },
  };
}

function applyPluginEditorUpdate(update: PluginEditorUpdate | null | undefined): void {
  if (!update || update.id === lastPluginEditorUpdateId) {
    return;
  }
  lastPluginEditorUpdateId = update.id;
  if (
    !loadedNote ||
    loadedNote.path !== update.path ||
    loadedNote.revision !== update.revision ||
    editor.state.doc.toString() !== update.baseContent
  ) {
    showToast("A plugin editor change was retained but not applied because the note changed.");
    return;
  }
  const anchor = Math.min(update.selection.anchor, update.content.length);
  const head = Math.min(update.selection.head, update.content.length);
  const currentContent = editor.state.doc.toString();
  editor.dispatch({
    ...(currentContent === update.content
      ? {}
      : { changes: { from: 0, to: currentContent.length, insert: update.content } }),
    selection: { anchor, head },
  });
  if (update.focused && documentViewMode !== "plugin") {
    editor.focus();
  }
}

async function executeRendererCommand(commandId: string): Promise<void> {
  const command = commandCatalog().find((candidate) => candidate.id === commandId);
  if (!command) {
    showToast("That command is no longer available.");
    return;
  }
  if (!command.enabled) {
    showToast(command.disabledReason ?? "That command is currently unavailable.");
    return;
  }
  if (elements.commandPalette.open) {
    closeCommandPalette(false);
  }
  try {
    await command.run();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
}

function openCommandPalette(): void {
  if (elements.commandPalette.open) {
    elements.paletteQuery.focus();
    elements.paletteQuery.select();
    return;
  }
  if (documentViewMode === "plugin") {
    setPluginSurfacePresentationVisible(false);
  }
  paletteRestoreFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  elements.paletteQuery.value = "";
  paletteSelection = -1;
  elements.commandPalette.showModal();
  renderPaletteResults();
  window.requestAnimationFrame(() => elements.paletteQuery.focus());
}

function closeCommandPalette(restoreFocus = true): void {
  if (!elements.commandPalette.open) {
    return;
  }
  elements.commandPalette.close();
  if (documentViewMode === "plugin") {
    setPluginSurfacePresentationVisible(true);
  }
  const restoreTarget = paletteRestoreFocus;
  paletteRestoreFocus = null;
  if (restoreFocus && restoreTarget?.isConnected) {
    restoreTarget.focus();
  }
}

function selectQuickSwitcherIndex(index: number, scrollIntoView: boolean): void {
  quickSwitcherSelection = index;
  const options = [
    ...elements.quickSwitcherResults.querySelectorAll<HTMLButtonElement>(".quick-switcher-option"),
  ];
  for (const [optionIndex, option] of options.entries()) {
    const active = optionIndex === index;
    option.dataset.active = String(active);
    option.setAttribute("aria-selected", String(active));
  }
  const activeOption = options[index];
  if (activeOption) {
    elements.quickSwitcherQuery.setAttribute("aria-activedescendant", activeOption.id);
    const note = quickSwitcherMatches[index];
    elements.quickSwitcherHint.textContent = note ? `Open ${note.path}` : "Ready";
    if (scrollIntoView) {
      activeOption.scrollIntoView({ block: "nearest" });
    }
  } else {
    elements.quickSwitcherQuery.removeAttribute("aria-activedescendant");
    elements.quickSwitcherHint.textContent = "No note selected";
  }
}

function renderQuickSwitcherResults(): void {
  if (!elements.quickSwitcher.open) {
    return;
  }
  const identity = currentVaultSearchIdentity();
  if (!identity) {
    closeQuickSwitcher(false);
    return;
  }
  if (
    quickSwitcherIdentity?.vaultId !== identity.vaultId ||
    quickSwitcherIdentity?.indexGeneration !== identity.indexGeneration
  ) {
    quickSwitcherRequest += 1;
    quickSwitcherIdentity = identity;
  }
  const selectedPath = quickSwitcherMatches[quickSwitcherSelection]?.path;
  quickSwitcherMatches = filterQuickSwitcherNotes(
    quickSwitcherNotesFromFiles(currentSnapshot?.workspace?.files ?? []),
    elements.quickSwitcherQuery.value,
  );
  const preservedIndex = selectedPath
    ? quickSwitcherMatches.findIndex((note) => note.path === selectedPath)
    : -1;
  quickSwitcherSelection =
    preservedIndex >= 0 ? preservedIndex : quickSwitcherMatches.length > 0 ? 0 : -1;
  elements.quickSwitcherResults.replaceChildren();
  for (const [index, note] of quickSwitcherMatches.entries()) {
    const option = document.createElement("button");
    option.id = `quick-switcher-option-${index}`;
    option.type = "button";
    option.className = "quick-switcher-option";
    option.dataset.notePath = note.path;
    option.setAttribute("role", "option");
    const mark = document.createElement("span");
    mark.className = "quick-switcher-option-mark";
    mark.ariaHidden = "true";
    mark.textContent = "◇";
    const copy = document.createElement("span");
    copy.className = "quick-switcher-option-copy";
    const title = document.createElement("strong");
    title.textContent = note.title;
    const path = document.createElement("small");
    path.textContent = note.path;
    copy.append(title, path);
    option.append(mark, copy);
    option.addEventListener("click", () => void chooseQuickSwitcherNote(index));
    option.addEventListener("mousemove", () => selectQuickSwitcherIndex(index, false));
    elements.quickSwitcherResults.append(option);
  }
  if (quickSwitcherMatches.length === 0) {
    const empty = document.createElement("p");
    empty.className = "quick-switcher-empty";
    empty.textContent = "No indexed note matches this search.";
    elements.quickSwitcherResults.append(empty);
  }
  elements.quickSwitcherCount.textContent = `${quickSwitcherMatches.length} shown`;
  selectQuickSwitcherIndex(quickSwitcherSelection, false);
}

function openQuickSwitcher(): void {
  if (elements.quickSwitcher.open) {
    elements.quickSwitcherQuery.focus();
    elements.quickSwitcherQuery.select();
    return;
  }
  if (vaultOpening()) {
    showToast("Wait for the vault index to finish opening.");
    return;
  }
  if (busy || dirty || saving) {
    if (dirty) {
      showToast("Save or revert the open draft before opening the quick switcher.");
    }
    return;
  }
  if (documentViewMode === "plugin") {
    setPluginSurfacePresentationVisible(false);
  }
  quickSwitcherRestoreFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  quickSwitcherRequest += 1;
  quickSwitcherIdentity = currentVaultSearchIdentity();
  elements.quickSwitcherQuery.value = "";
  quickSwitcherSelection = -1;
  elements.quickSwitcher.showModal();
  renderQuickSwitcherResults();
  window.requestAnimationFrame(() => {
    elements.quickSwitcherQuery.focus();
    elements.quickSwitcherQuery.select();
  });
}

function closeQuickSwitcher(restoreFocus = true): void {
  if (!elements.quickSwitcher.open) {
    return;
  }
  quickSwitcherRequest += 1;
  elements.quickSwitcher.close();
  quickSwitcherIdentity = null;
  if (documentViewMode === "plugin") {
    setPluginSurfacePresentationVisible(true);
  }
  const restoreTarget = quickSwitcherRestoreFocus;
  quickSwitcherRestoreFocus = null;
  if (restoreFocus && restoreTarget?.isConnected) {
    restoreTarget.focus();
  }
}

async function chooseQuickSwitcherNote(index: number): Promise<void> {
  const note = quickSwitcherMatches[index];
  const request = quickSwitcherRequest;
  const identity = quickSwitcherIdentity;
  if (!note || !identity) {
    return;
  }
  closeQuickSwitcher(false);
  if (
    request + 1 !== quickSwitcherRequest ||
    currentVaultSearchIdentity()?.vaultId !== identity.vaultId ||
    currentVaultSearchIdentity()?.indexGeneration !== identity.indexGeneration
  ) {
    showToast("The indexed note list changed. Reopen the quick switcher.");
    return;
  }
  await openNote(note.path);
}

function setPluginSurfacePresentationVisible(visible: boolean): void {
  if (pluginSurfacePresentationVisible === visible) {
    return;
  }
  pluginSurfacePresentationVisible = visible;
  void window.threadleaf.setPluginSurfaceVisible(visible).catch((error) => {
    if (pluginSurfacePresentationVisible === visible) {
      pluginSurfacePresentationVisible = !visible;
    }
    showToast(error instanceof Error ? error.message : String(error));
  });
}

function applySettingsSnapshot(snapshot: AppSettingsSnapshot): void {
  const vaultId = currentSnapshot?.vault.id ?? null;
  const previousAppearance = vaultId
    ? appearanceForVault(settingsSnapshot.settings, vaultId)
    : createDefaultVaultAppearance();
  const previousPlugins = vaultId
    ? pluginsForVault(settingsSnapshot.settings, vaultId)
    : createDefaultVaultPluginSettings();
  const previousNoteWorkflows = vaultId
    ? noteWorkflowsForVault(settingsSnapshot.settings, vaultId)
    : createDefaultVaultNoteWorkflowSettings();
  const previousWorkspaceSettings = vaultId
    ? workspaceSettingsForVault(settingsSnapshot.settings, vaultId)
    : createDefaultVaultWorkspaceSettings();
  settingsSnapshot = snapshot;
  settingsLoaded = true;
  updateShortcutLabels();
  if (snapshot.warning && snapshot.warning !== lastSettingsWarning) {
    showToast(snapshot.warning);
  }
  lastSettingsWarning = snapshot.warning;
  const nextAppearance = currentAppearancePreference();
  const nextPlugins = currentPluginPreference();
  const nextNoteWorkflows = currentNoteWorkflowPreference();
  const nextWorkspaceSettings = currentWorkspacePreference();
  applyColorScheme(nextAppearance.colorScheme);
  if (
    vaultId &&
    !workspaceSettingsBusy &&
    !workspaceSettingsEqual(previousWorkspaceSettings, nextWorkspaceSettings)
  ) {
    workspaceSettingsDraft = { ...nextWorkspaceSettings };
    applyWorkspaceViewDefaults(nextWorkspaceSettings);
  }
  renderDocumentView();
  if (
    vaultId &&
    !appearanceBusy &&
    (!appearancesEqual(previousAppearance, nextAppearance) ||
      appearanceSnapshot?.vaultId !== vaultId ||
      !appearancesEqual(appearanceSnapshot.preference, nextAppearance))
  ) {
    void refreshAppearance();
  }
  if (
    vaultId &&
    !pluginBusy &&
    (!pluginPreferencesEqual(previousPlugins, nextPlugins) ||
      pluginCatalog?.vaultId !== vaultId ||
      !pluginPreferencesEqual(pluginCatalog.preference, nextPlugins))
  ) {
    void refreshPlugins();
  }
  if (
    vaultId &&
    !noteWorkflowBusy &&
    (!noteWorkflowPreferencesEqual(previousNoteWorkflows, nextNoteWorkflows) ||
      noteWorkflowCatalog?.vaultId !== vaultId ||
      !noteWorkflowPreferencesEqual(noteWorkflowCatalog.settings, nextNoteWorkflows))
  ) {
    void refreshNoteWorkflows();
  }
  renderSettings();
  renderPaletteResults();
  void maybeMigrateLegacyTheme();
}

function updateShortcutLabels(): void {
  elements.commandShortcut.textContent = shortcutFor("ui.command-palette") ?? "None";
  elements.settingsShortcut.textContent = shortcutFor("settings.open-keybindings") ?? "None";
  elements.searchShortcut.textContent = shortcutFor("workspace.focus-note-filter") ?? "None";
  elements.saveShortcut.textContent = shortcutFor("editor.save-note") ?? "None";
  const newNoteShortcut = shortcutFor("workspace.create-note");
  elements.newNote.title = newNoteShortcut
    ? `Create a new note (${newNoteShortcut})`
    : "Create a new note";
  const moveNoteShortcut = shortcutFor("workspace.move-note");
  elements.moveNote.title = moveNoteShortcut
    ? `Move or rename current note (${moveNoteShortcut})`
    : "Move or rename current note";
  const deleteNoteShortcut = shortcutFor("workspace.delete-note");
  elements.deleteNote.title = deleteNoteShortcut
    ? `Move current note to recoverable trash (${deleteNoteShortcut})`
    : "Move current note to recoverable trash";
}

function renderNewNoteDialog(): void {
  const staleVault = Boolean(
    newNoteVaultId && currentSnapshot?.vault.id && newNoteVaultId !== currentSnapshot.vault.id,
  );
  if (staleVault && !elements.newNoteError.textContent) {
    elements.newNoteError.textContent = "The active vault changed. Cancel and reopen New note.";
  }
  const message = elements.newNoteError.textContent ?? "";
  elements.newNoteError.hidden = message.length === 0;
  elements.newNotePath.disabled = newNoteBusy;
  elements.newNoteClose.disabled = newNoteBusy;
  elements.newNoteCancel.disabled = newNoteBusy;
  elements.newNoteCreate.disabled = newNoteBusy || staleVault || readOnlyVault();
  elements.newNoteCreate.textContent = newNoteBusy ? "Creating…" : "Create note";
  elements.newNoteForm.setAttribute("aria-busy", String(newNoteBusy));
  elements.newNoteVault.textContent = staleVault
    ? "Vault changed"
    : currentSnapshot
      ? `In ${currentSnapshot.vault.name}`
      : "Active vault";
}

function openNewNoteDialog(): void {
  if (elements.newNoteDialog.open) {
    elements.newNotePath.focus();
    elements.newNotePath.select();
    return;
  }
  if (!currentSnapshot?.vault.id || readOnlyVault() || busy || saving || dirty) {
    showToast(
      readOnlyVault()
        ? "Open a local vault before creating notes."
        : dirty
          ? "Save or revert the open note before creating another."
          : "A writable vault must be ready before creating a note.",
    );
    return;
  }
  if (elements.commandPalette.open) {
    closeCommandPalette(false);
  }
  if (documentViewMode === "plugin") {
    setDocumentView(editingViewMode, false);
  }
  newNoteRestoreFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  newNoteBusy = false;
  newNoteVaultId = currentSnapshot.vault.id;
  elements.newNotePath.value = "";
  elements.newNoteError.textContent = "";
  elements.newNoteDialog.showModal();
  renderNewNoteDialog();
  window.requestAnimationFrame(() => elements.newNotePath.focus());
}

function closeNewNoteDialog(restoreFocus = true): void {
  if (!elements.newNoteDialog.open || newNoteBusy) {
    return;
  }
  elements.newNoteDialog.close();
  newNoteVaultId = null;
  const restoreTarget = newNoteRestoreFocus;
  newNoteRestoreFocus = null;
  if (restoreFocus && restoreTarget?.isConnected) {
    restoreTarget.focus();
  }
}

async function createNewNote(): Promise<void> {
  const expectedVaultId = newNoteVaultId;
  if (!expectedVaultId || newNoteBusy) {
    return;
  }
  const requestedPath = elements.newNotePath.value.trim();
  if (!requestedPath) {
    elements.newNoteError.textContent = "Enter a note name or vault-relative path.";
    renderNewNoteDialog();
    elements.newNotePath.focus();
    return;
  }

  let response: NoteCreateResponse | null = null;
  newNoteBusy = true;
  elements.newNoteError.textContent = "";
  renderNewNoteDialog();
  setActionState(true);
  try {
    response = await window.threadleaf.createNote(requestedPath, "", expectedVaultId);
    if (response.outcome.status === "exists") {
      elements.newNoteError.textContent = `${response.outcome.path} already exists. Choose another path.`;
      response = null;
    } else {
      render(response.snapshot);
    }
  } catch (error) {
    elements.newNoteError.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    newNoteBusy = false;
    setActionState(false);
    renderNewNoteDialog();
  }

  if (!response) {
    elements.newNotePath.focus();
    elements.newNotePath.select();
    return;
  }
  closeNewNoteDialog(false);
  setDocumentView(editingViewMode, false);
  if (response.outcome.status === "conflict") {
    setEditNotice({
      kind: "conflict",
      title: "The requested path appeared during creation",
      message: `The existing note was not overwritten. Your new note is ${response.outcome.conflictPath}.`,
    });
    showToast(`Preserved as ${response.outcome.conflictPath}`);
  } else {
    showToast(`Created ${response.outcome.path}`);
  }
  window.setTimeout(() => editor.focus(), 0);
}

async function openTodaysDailyNote(): Promise<void> {
  const expectedVaultId = currentSnapshot?.vault.id;
  if (
    !expectedVaultId ||
    readOnlyVault() ||
    vaultOpening() ||
    busy ||
    anyPaneSaving() ||
    anyPaneDirty()
  ) {
    if (anyPaneDirty()) {
      showToast("Save or revert drafts before opening today's note.");
    }
    return;
  }
  setActionState(true);
  try {
    const response = await window.threadleaf.openDailyNote(expectedVaultId);
    render(response.snapshot);
    setDocumentView(editingViewMode, false);
    if (response.outcome.status === "committed") {
      showToast(`Created today's note: ${response.outcome.path}`);
    } else if (response.outcome.status === "exists") {
      showToast(`Opened today's note: ${response.outcome.path}`);
    } else {
      setEditNotice({
        kind: "conflict",
        title: "Today's note appeared during creation",
        message: `The existing note was not overwritten. Your new note is ${response.outcome.conflictPath}.`,
      });
      showToast(`Preserved as ${response.outcome.conflictPath}`);
    }
    window.requestAnimationFrame(() => editor.focus());
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  } finally {
    setActionState(false);
  }
}

function insertEditorText(content: string): void {
  if (!loadedNote || readOnlyVault() || busy || saving) {
    return;
  }
  if (documentViewMode !== "live" && documentViewMode !== "source") {
    setDocumentView(editingViewMode, false);
  }
  const selection = editor.state.selection.main;
  editor.dispatch({
    changes: { from: selection.from, to: selection.to, insert: content },
    selection: { anchor: selection.from + content.length },
    scrollIntoView: true,
  });
  editor.focus();
}

function renderTemplatePickerDialog(): void {
  const staleVault = Boolean(
    templatePickerVaultId &&
      currentSnapshot?.vault.id &&
      templatePickerVaultId !== currentSnapshot.vault.id,
  );
  if (staleVault && !elements.templatePickerError.textContent) {
    elements.templatePickerError.textContent =
      "The active vault changed. Cancel and reopen Insert template.";
  }
  const catalog =
    noteWorkflowCatalog?.vaultId === templatePickerVaultId ? noteWorkflowCatalog : null;
  const selected = elements.templatePickerSelect.value;
  elements.templatePickerSelect.replaceChildren();
  for (const templatePath of catalog?.templates ?? []) {
    const option = document.createElement("option");
    option.value = templatePath;
    option.textContent = templatePath;
    elements.templatePickerSelect.append(option);
  }
  if (selected && (catalog?.templates ?? []).includes(selected)) {
    elements.templatePickerSelect.value = selected;
  }
  const hasTemplates = (catalog?.templates.length ?? 0) > 0;
  if (!hasTemplates && !elements.templatePickerError.textContent) {
    elements.templatePickerError.textContent = catalog
      ? `No Markdown templates were found in ${catalog.settings.templateFolder || "the vault root"}.`
      : "Templates are not available for this vault.";
  }
  const message = elements.templatePickerError.textContent ?? "";
  elements.templatePickerError.hidden = message.length === 0;
  elements.templatePickerSelect.disabled = templatePickerBusy || !hasTemplates;
  elements.templatePickerClose.disabled = templatePickerBusy;
  elements.templatePickerCancel.disabled = templatePickerBusy;
  elements.templatePickerInsert.disabled = templatePickerBusy || staleVault || !hasTemplates;
  elements.templatePickerInsert.textContent = templatePickerBusy ? "Expanding…" : "Insert";
  elements.templatePickerForm.setAttribute("aria-busy", String(templatePickerBusy));
  elements.templatePickerVault.textContent = staleVault
    ? "Vault changed"
    : currentSnapshot
      ? `Into ${currentSnapshot.vault.name}`
      : "Active vault";
}

async function openTemplatePicker(): Promise<void> {
  const expectedVaultId = loadedVaultId;
  const notePath = loadedNote?.path;
  if (!expectedVaultId || !notePath || readOnlyVault() || busy || saving) {
    return;
  }
  if (elements.templatePickerDialog.open) {
    elements.templatePickerSelect.focus();
    return;
  }
  if (elements.commandPalette.open) {
    closeCommandPalette(false);
  }
  try {
    const catalog = await refreshNoteWorkflows();
    if (!catalog || loadedVaultId !== expectedVaultId || loadedNote?.path !== notePath) {
      showToast(
        catalog
          ? "The vault or active note changed before templates could be opened."
          : noteWorkflowMessage,
      );
      return;
    }
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
    return;
  }
  templatePickerRestoreFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  templatePickerBusy = false;
  templatePickerVaultId = expectedVaultId;
  templatePickerNotePath = notePath;
  elements.templatePickerError.textContent = "";
  elements.templatePickerDialog.showModal();
  renderTemplatePickerDialog();
  window.requestAnimationFrame(() => {
    if (elements.templatePickerSelect.disabled) {
      elements.templatePickerCancel.focus();
    } else {
      elements.templatePickerSelect.focus();
    }
  });
}

function closeTemplatePicker(restoreFocus = true): void {
  if (!elements.templatePickerDialog.open || templatePickerBusy) {
    return;
  }
  elements.templatePickerDialog.close();
  templatePickerVaultId = null;
  templatePickerNotePath = null;
  const restoreTarget = templatePickerRestoreFocus;
  templatePickerRestoreFocus = null;
  if (restoreFocus && restoreTarget?.isConnected) {
    restoreTarget.focus();
  }
}

async function insertSelectedTemplate(): Promise<void> {
  const expectedVaultId = templatePickerVaultId;
  const notePath = templatePickerNotePath;
  const templatePath = elements.templatePickerSelect.value;
  if (!expectedVaultId || !notePath || !templatePath || templatePickerBusy) {
    return;
  }
  templatePickerBusy = true;
  elements.templatePickerError.textContent = "";
  renderTemplatePickerDialog();
  try {
    const response = await window.threadleaf.renderNoteTemplate(
      templatePath,
      notePath,
      expectedVaultId,
    );
    if (
      response.status !== "ready" ||
      loadedVaultId !== expectedVaultId ||
      loadedNote?.path !== notePath
    ) {
      elements.templatePickerError.textContent =
        "The vault or active note changed before the template could be inserted.";
      return;
    }
    templatePickerBusy = false;
    closeTemplatePicker(false);
    insertEditorText(response.content);
    showToast(`Inserted ${response.sourcePath}`);
  } catch (error) {
    elements.templatePickerError.textContent =
      error instanceof Error ? error.message : String(error);
  } finally {
    templatePickerBusy = false;
    if (elements.templatePickerDialog.open) {
      renderTemplatePickerDialog();
    }
  }
}

async function insertFormattedWorkflowValue(value: "date" | "time"): Promise<void> {
  const expectedVaultId = loadedVaultId;
  const notePath = loadedNote?.path;
  if (!expectedVaultId || !notePath || readOnlyVault() || busy || saving) {
    return;
  }
  setActionState(true);
  try {
    const response = await window.threadleaf.formatNoteWorkflowValue(value, expectedVaultId);
    if (
      response.status !== "ready" ||
      loadedVaultId !== expectedVaultId ||
      loadedNote?.path !== notePath
    ) {
      showToast(`The vault or active note changed before the ${value} could be inserted.`);
      return;
    }
    setActionState(false);
    insertEditorText(response.value);
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  } finally {
    setActionState(false);
  }
}

function selectedPropertyType(): NotePropertyType {
  switch (elements.propertyType.value) {
    case "list":
    case "number":
    case "checkbox":
    case "date":
    case "datetime":
      return elements.propertyType.value;
    default:
      return "text";
  }
}

function configurePropertyValueInput(): void {
  const type = selectedPropertyType();
  const checkbox = type === "checkbox";
  elements.propertyValueField.hidden = checkbox;
  elements.propertyCheckboxField.hidden = !checkbox;
  elements.propertyValue.required = !checkbox;
  elements.propertyCheckboxValue.required = checkbox;
  elements.propertyValue.type =
    type === "number"
      ? "number"
      : type === "date"
        ? "date"
        : type === "datetime"
          ? "datetime-local"
          : "text";
  elements.propertyValue.step = type === "number" ? "any" : type === "datetime" ? "1" : "";
  elements.propertyValue.placeholder =
    type === "list"
      ? 'alpha, beta or ["alpha","beta"]'
      : type === "number"
        ? "3.5"
        : type === "date"
          ? "YYYY-MM-DD"
          : type === "datetime"
            ? "YYYY-MM-DDTHH:mm:ss"
            : "Property value";
  elements.propertyValueHint.textContent =
    type === "list"
      ? "Use a comma-separated list or a JSON array of strings."
      : type === "checkbox"
        ? "Checked is stored as true; unchecked is stored as false."
        : type === "date"
          ? "A real calendar date is stored without a timezone."
          : type === "datetime"
            ? "Seconds are retained. This value is stored without a timezone."
            : "Threadleaf preserves unrelated frontmatter bytes exactly.";
}

function renderPropertyDialog(): void {
  if (!elements.propertyDialog.open) {
    return;
  }
  const staleVault = Boolean(
    propertyVaultId && propertyVaultId !== (currentSnapshot?.vault.id ?? null),
  );
  const staleNote = Boolean(
    !propertyBusy &&
      propertyNotePath &&
      propertyNoteRevision &&
      (!loadedNote ||
        loadedNote.path !== propertyNotePath ||
        loadedNote.revision !== propertyNoteRevision),
  );
  if ((staleVault || staleNote) && !elements.propertyError.textContent) {
    elements.propertyError.textContent = staleVault
      ? "The active vault changed. Cancel and reopen Properties."
      : "The note changed on disk. Cancel, review it, and reopen Properties.";
  }
  const removing = propertyDialogMode === "remove";
  const editing = propertyDialogMode === "edit";
  elements.propertyDialogOperation.textContent = removing
    ? "Explicit removal"
    : editing
      ? "Typed frontmatter"
      : "New typed frontmatter";
  elements.propertyDialogTitle.textContent = removing
    ? "Remove note property?"
    : editing
      ? "Edit note property"
      : "Add note property";
  elements.propertyDialogDescription.textContent = removing
    ? "Threadleaf removes only the selected top-level property block. The note body and every unrelated frontmatter byte stay unchanged."
    : "Threadleaf changes one top-level property without reserializing the rest of your note.";
  elements.propertyFields.hidden = removing;
  elements.propertyRemoveSummary.hidden = !removing;
  elements.propertyRemoveName.textContent = propertyTargetName ?? "Property";
  elements.propertyName.disabled = propertyBusy || editing || removing;
  elements.propertyType.disabled = propertyBusy || removing;
  elements.propertyValue.disabled = propertyBusy || removing;
  elements.propertyCheckboxValue.disabled = propertyBusy || removing;
  elements.propertyDialogClose.disabled = propertyBusy;
  elements.propertyCancel.disabled = propertyBusy;
  elements.propertySubmit.disabled = propertyBusy || staleVault || staleNote || readOnlyVault();
  elements.propertySubmit.textContent = propertyBusy
    ? removing
      ? "Removing…"
      : "Saving…"
    : removing
      ? "Remove property"
      : "Save property";
  elements.propertySubmit.classList.toggle("trash-confirm-button", removing);
  elements.propertyForm.setAttribute("aria-busy", String(propertyBusy));
  elements.propertyVault.textContent = staleVault
    ? "Vault changed"
    : currentSnapshot
      ? `In ${currentSnapshot.vault.name}`
      : "Active vault";
  elements.propertyError.hidden = !(elements.propertyError.textContent ?? "").length;
  configurePropertyValueInput();
}

function openPropertyDialog(mode: PropertyDialogMode, property?: WorkspacePropertySummary): void {
  const blocked = propertyEditBlockReason();
  if (blocked) {
    showToast(blocked);
    return;
  }
  if (!loadedNote || !loadedVaultId) {
    return;
  }
  if (mode !== "add" && (!property || property.type === "unsupported")) {
    showToast("This property cannot be changed losslessly yet.");
    return;
  }
  if (elements.commandPalette.open) {
    closeCommandPalette(false);
  }
  if (documentViewMode === "plugin") {
    setDocumentView(editingViewMode, false);
  }
  propertyDialogRestoreFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  propertyDialogMode = mode;
  propertyBusy = false;
  propertyVaultId = loadedVaultId;
  propertyNotePath = loadedNote.path;
  propertyNoteRevision = loadedNote.revision;
  propertyTargetName = property?.name ?? null;
  elements.propertyName.value = property?.name ?? "";
  elements.propertyType.value =
    property?.type === "unsupported" ? "text" : (property?.type ?? "text");
  elements.propertyValue.value = property?.rawValue ?? "";
  elements.propertyCheckboxValue.value = property?.value === false ? "false" : "true";
  elements.propertyError.textContent = "";
  elements.propertyDialog.showModal();
  renderPropertyDialog();
  window.requestAnimationFrame(() => {
    if (mode === "add") {
      elements.propertyName.focus();
    } else if (mode === "edit") {
      (selectedPropertyType() === "checkbox"
        ? elements.propertyCheckboxValue
        : elements.propertyValue
      ).focus();
    } else {
      elements.propertySubmit.focus();
    }
  });
}

function closePropertyDialog(restoreFocus = true): void {
  if (!elements.propertyDialog.open || propertyBusy) {
    return;
  }
  elements.propertyDialog.close();
  elements.propertyForm.setAttribute("aria-busy", "false");
  propertyVaultId = null;
  propertyNotePath = null;
  propertyNoteRevision = null;
  propertyTargetName = null;
  const restoreTarget = propertyDialogRestoreFocus;
  propertyDialogRestoreFocus = null;
  if (restoreFocus && restoreTarget?.isConnected) {
    restoreTarget.focus();
  }
}

async function savePropertyChange(): Promise<void> {
  const expectedVaultId = propertyVaultId;
  const path = propertyNotePath;
  const expectedRevision = propertyNoteRevision;
  if (!expectedVaultId || !path || !expectedRevision || propertyBusy) {
    return;
  }
  const name =
    propertyDialogMode === "add" ? elements.propertyName.value.trim() : propertyTargetName;
  if (!name) {
    elements.propertyError.textContent = "Enter a property name.";
    renderPropertyDialog();
    elements.propertyName.focus();
    return;
  }

  propertyBusy = true;
  elements.propertyError.textContent = "";
  renderPropertyDialog();
  setActionState(true);
  try {
    const response =
      propertyDialogMode === "remove"
        ? await window.threadleaf.removeNoteProperty(path, name, expectedRevision, expectedVaultId)
        : await window.threadleaf.setNoteProperty(
            path,
            name,
            selectedPropertyType() === "checkbox"
              ? elements.propertyCheckboxValue.value
              : elements.propertyValue.value,
            selectedPropertyType(),
            expectedRevision,
            expectedVaultId,
          );
    propertyBusy = false;
    setActionState(false);
    if (response.outcome.status === "stale") {
      render(response.snapshot);
      elements.propertyError.textContent =
        "The note changed on disk. Nothing was written. Cancel, review the current note, and try again.";
      renderPropertyDialog();
      return;
    }
    closePropertyDialog(false);
    render(response.snapshot);
    if (response.outcome.status === "conflict") {
      setEditNotice({
        kind: "conflict",
        title: "Your property change was preserved as a conflict note",
        message: `The original changed on disk and was not overwritten. Your proposed property change is now ${response.outcome.conflictPath}.`,
      });
      showToast(`Property change preserved as ${response.outcome.conflictPath}`);
    } else if (response.outcome.status === "missing") {
      showToast(`${name} was already absent.`);
    } else {
      showToast(propertyDialogMode === "remove" ? `Removed ${name}.` : `Saved ${name}.`);
    }
  } catch (error) {
    propertyBusy = false;
    setActionState(false);
    elements.propertyError.textContent = error instanceof Error ? error.message : String(error);
    renderPropertyDialog();
  }
}

function moveResolutionText(resolution: NoteMoveBlocker["before"]): string {
  if (resolution.status === "resolved") {
    return resolution.path ? `Resolved to ${resolution.path}` : "Resolved";
  }
  if (resolution.status === "ambiguous") {
    const candidates = resolution.candidates ?? [];
    if (candidates.length === 0) {
      return "Ambiguous";
    }
    const visible = candidates.slice(0, 4).join(", ");
    const remainder = candidates.length - 4;
    return `Ambiguous between ${visible}${remainder > 0 ? ` and ${remainder} more` : ""}`;
  }
  return "Unresolved";
}

function renderMoveNoteDialog(): void {
  const staleVault = Boolean(
    moveNoteVaultId && moveNoteVaultId !== (currentSnapshot?.vault.id ?? null),
  );
  const staleNote = Boolean(
    moveNoteSourcePath &&
      moveNoteRevision &&
      (!loadedNote ||
        loadedNote.path !== moveNoteSourcePath ||
        loadedNote.revision !== moveNoteRevision),
  );
  if ((staleVault || staleNote) && !elements.moveNoteError.textContent) {
    elements.moveNoteError.textContent = staleVault
      ? "The active vault changed. Cancel and reopen Move."
      : "The note changed on disk. Cancel, review it, and reopen Move.";
  }

  const message = elements.moveNoteError.textContent ?? "";
  elements.moveNoteError.hidden = message.length === 0;
  const previewMessage = elements.moveNotePreviewMessage.textContent ?? "";
  elements.moveNotePreviewMessage.hidden = previewMessage.length === 0;
  elements.moveNoteCurrentPath.textContent = moveNoteSourcePath ?? "No note selected";
  elements.moveNoteTarget.disabled = moveNoteBusy;
  elements.moveNoteClose.disabled = moveNoteBusy;
  elements.moveNoteCancel.disabled = moveNoteBusy;
  elements.moveNoteSubmit.disabled = moveNoteBusy || staleVault || staleNote || readOnlyVault();
  elements.moveNoteSubmit.textContent = moveNoteBusy
    ? moveNoteConfirmationId
      ? "Applying…"
      : "Checking…"
    : moveNoteConfirmationId
      ? `Update ${moveNoteRewrites.length} ${moveNoteRewrites.length === 1 ? "link" : "links"} and move`
      : "Check and move";
  elements.moveNoteForm.setAttribute("aria-busy", String(moveNoteBusy));
  elements.moveNoteVault.textContent = staleVault
    ? "Vault changed"
    : currentSnapshot
      ? `In ${currentSnapshot.vault.name}`
      : "Active vault";

  elements.moveNoteBlockerList.replaceChildren();
  const showingPreview = moveNoteRewrites.length > 0;
  const visibleChanges = showingPreview ? moveNoteRewrites : moveNoteBlockers;
  elements.moveNoteBlockers.hidden = visibleChanges.length === 0;
  elements.moveNoteBlockers.dataset.mode = showingPreview ? "preview" : "blocked";
  elements.moveNoteBlockerSummary.textContent = showingPreview
    ? `Ready: ${moveNoteRewrites.length} link target ${moveNoteRewrites.length === 1 ? "update" : "updates"}`
    : moveNoteBlockers.length === 1
      ? "Blocked: 1 internal link resolution is unsafe"
      : `Blocked: ${moveNoteBlockers.length} internal link resolutions are unsafe`;
  for (const rewrite of moveNoteRewrites.slice(0, 100)) {
    const item = document.createElement("li");
    const origin = document.createElement("span");
    origin.className = "move-note-blocker-origin";
    origin.textContent = `${rewrite.documentPath}:${rewrite.line} · ${rewrite.syntax === "wiki" ? "Wikilink" : "Markdown link"}`;
    const change = document.createElement("span");
    change.className = "move-note-blocker-change";
    const before = document.createElement("span");
    before.textContent = rewrite.beforeTarget;
    const arrow = document.createElement("span");
    arrow.className = "move-note-blocker-arrow";
    arrow.ariaHidden = "true";
    arrow.textContent = "→";
    const after = document.createElement("span");
    after.textContent = rewrite.afterTarget;
    change.append(before, arrow, after);
    item.append(origin, change);
    elements.moveNoteBlockerList.append(item);
  }
  for (const blocker of moveNoteBlockers.slice(0, 100)) {
    const item = document.createElement("li");
    const origin = document.createElement("span");
    origin.className = "move-note-blocker-origin";
    origin.textContent = `${blocker.documentPath} · ${blocker.syntax === "wiki" ? "Wikilink" : "Markdown link"}`;
    const target = document.createElement("code");
    target.textContent = blocker.target;
    const change = document.createElement("span");
    change.className = "move-note-blocker-change";
    const before = document.createElement("span");
    before.dataset.status = blocker.before.status;
    before.textContent = moveResolutionText(blocker.before);
    const arrow = document.createElement("span");
    arrow.className = "move-note-blocker-arrow";
    arrow.ariaHidden = "true";
    arrow.textContent = "→";
    const after = document.createElement("span");
    after.dataset.status = blocker.after.status;
    after.textContent = moveResolutionText(blocker.after);
    change.append(before, arrow, after);
    item.append(origin, target, change);
    elements.moveNoteBlockerList.append(item);
  }
  if (visibleChanges.length > 100) {
    const remainder = document.createElement("li");
    remainder.className = "move-note-blocker-more";
    remainder.textContent = `${visibleChanges.length - 100} more ${showingPreview ? "updates" : "blockers"} are not shown.`;
    elements.moveNoteBlockerList.append(remainder);
  }
}

function openMoveNoteDialog(): void {
  if (elements.moveNoteDialog.open) {
    elements.moveNoteTarget.focus();
    elements.moveNoteTarget.select();
    return;
  }
  if (!loadedNote || !loadedVaultId || readOnlyVault() || busy || saving || dirty) {
    showToast(
      readOnlyVault()
        ? "Open a local vault before moving notes."
        : dirty
          ? "Save or revert the current note before moving it."
          : loadedNote
            ? "Threadleaf is finishing another action."
            : "Open a note before moving or renaming it.",
    );
    return;
  }
  if (elements.commandPalette.open) {
    closeCommandPalette(false);
  }
  if (documentViewMode === "plugin") {
    setDocumentView(editingViewMode, false);
  }
  moveNoteRestoreFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  moveNoteBusy = false;
  moveNoteVaultId = loadedVaultId;
  moveNoteSourcePath = loadedNote.path;
  moveNoteRevision = loadedNote.revision;
  moveNoteBlockers = [];
  moveNoteRewrites = [];
  moveNoteConfirmationId = null;
  elements.moveNoteTarget.value = loadedNote.path;
  elements.moveNoteError.textContent = "";
  elements.moveNotePreviewMessage.textContent = "";
  elements.moveNoteDialog.showModal();
  renderMoveNoteDialog();
  window.requestAnimationFrame(() => {
    const nameStart = loadedNote ? loadedNote.path.lastIndexOf("/") + 1 : 0;
    const nameEnd = Math.max(nameStart, elements.moveNoteTarget.value.length - 3);
    elements.moveNoteTarget.focus();
    elements.moveNoteTarget.setSelectionRange(nameStart, nameEnd);
  });
}

function closeMoveNoteDialog(restoreFocus = true): void {
  if (!elements.moveNoteDialog.open || moveNoteBusy) {
    return;
  }
  elements.moveNoteDialog.close();
  moveNoteVaultId = null;
  moveNoteSourcePath = null;
  moveNoteRevision = null;
  moveNoteBlockers = [];
  moveNoteRewrites = [];
  moveNoteConfirmationId = null;
  elements.moveNoteError.textContent = "";
  elements.moveNotePreviewMessage.textContent = "";
  const restoreTarget = moveNoteRestoreFocus;
  moveNoteRestoreFocus = null;
  if (restoreFocus && restoreTarget?.isConnected) {
    restoreTarget.focus();
  }
}

async function moveCurrentNote(): Promise<void> {
  const expectedVaultId = moveNoteVaultId;
  const sourcePath = moveNoteSourcePath;
  const expectedRevision = moveNoteRevision;
  if (!expectedVaultId || !sourcePath || !expectedRevision || moveNoteBusy) {
    return;
  }
  const requestedPath = elements.moveNoteTarget.value.trim();
  if (!requestedPath) {
    elements.moveNoteError.textContent = "Enter a new vault-relative path.";
    moveNoteBlockers = [];
    moveNoteRewrites = [];
    moveNoteConfirmationId = null;
    elements.moveNotePreviewMessage.textContent = "";
    renderMoveNoteDialog();
    elements.moveNoteTarget.focus();
    return;
  }
  if (
    currentSnapshot?.vault.id !== expectedVaultId ||
    loadedNote?.path !== sourcePath ||
    loadedNote.revision !== expectedRevision
  ) {
    elements.moveNoteError.textContent =
      "The vault or note changed. Cancel, review the current note, and reopen Move.";
    moveNoteBlockers = [];
    moveNoteRewrites = [];
    moveNoteConfirmationId = null;
    elements.moveNotePreviewMessage.textContent = "";
    renderMoveNoteDialog();
    return;
  }

  let response: NoteMoveResponse | null = null;
  let committedPath: string | null = null;
  let committedRewriteCount = 0;
  const submittedConfirmationId = moveNoteConfirmationId;
  moveNoteBusy = true;
  moveNoteBlockers = [];
  if (!submittedConfirmationId) {
    moveNoteRewrites = [];
    elements.moveNotePreviewMessage.textContent = "";
  }
  elements.moveNoteError.textContent = "";
  renderMoveNoteDialog();
  setActionState(true);
  try {
    response = await window.threadleaf.moveNote(
      sourcePath,
      requestedPath,
      expectedRevision,
      expectedVaultId,
      submittedConfirmationId ?? undefined,
    );
    render(response.snapshot);
    if (response.outcome.status === "committed") {
      committedPath = response.outcome.to;
      committedRewriteCount = response.outcome.rewrites.length;
      await refreshNoteBookmarks(expectedVaultId);
    } else if (response.outcome.status === "requires-confirmation") {
      moveNoteBlockers = [];
      moveNoteRewrites = response.outcome.rewrites;
      moveNoteConfirmationId = response.outcome.confirmationId;
      const boundedPreviewNotice =
        response.outcome.rewrites.length > 100
          ? ` The list shows the first 100 of ${response.outcome.rewrites.length} exact updates.`
          : "";
      elements.moveNotePreviewMessage.textContent = submittedConfirmationId
        ? `The link plan changed on disk. Review this refreshed preview, then confirm it again.${boundedPreviewNotice}`
        : `Review the exact link target updates below. Submit again to apply them and move as one recoverable operation.${boundedPreviewNotice}`;
    } else if (response.outcome.status === "blocked") {
      moveNoteConfirmationId = null;
      moveNoteRewrites = [];
      moveNoteBlockers = response.outcome.blockers;
      elements.moveNotePreviewMessage.textContent = "";
      elements.moveNoteError.textContent = `Move blocked: ${response.outcome.blockers.length} internal link resolution${response.outcome.blockers.length === 1 ? " cannot" : "s cannot"} be rewritten safely. No files were changed.`;
    } else if (
      response.outcome.status === "conflict" &&
      response.outcome.reason === "target-exists"
    ) {
      moveNoteConfirmationId = null;
      moveNoteRewrites = [];
      elements.moveNotePreviewMessage.textContent = "";
      elements.moveNoteError.textContent = `${response.outcome.to} already exists. No files were changed.`;
    } else if (
      response.outcome.status === "conflict" &&
      response.outcome.reason === "source-revision-changed"
    ) {
      moveNoteConfirmationId = null;
      moveNoteRewrites = [];
      elements.moveNotePreviewMessage.textContent = "";
      elements.moveNoteError.textContent =
        "The note changed on disk while Threadleaf checked the move. No files were changed.";
    } else {
      moveNoteConfirmationId = null;
      moveNoteRewrites = [];
      elements.moveNotePreviewMessage.textContent = "";
      elements.moveNoteError.textContent =
        response.outcome.conflictPaths && response.outcome.conflictPaths.length > 0
          ? `The move did not commit (${response.outcome.reason}). Recovery copies were preserved at ${response.outcome.conflictPaths.join(", ")}.`
          : `The move did not commit (${response.outcome.reason}). Threadleaf did not overwrite an external winner; review the current vault state.`;
    }
  } catch (error) {
    elements.moveNoteError.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    moveNoteBusy = false;
    setActionState(false);
    if (elements.moveNoteDialog.open) {
      renderMoveNoteDialog();
    }
  }

  if (committedPath) {
    closeMoveNoteDialog(false);
    setDocumentView(editingViewMode, false);
    showToast(
      response?.bookmarkWarning ??
        (committedRewriteCount > 0
          ? `Moved note to ${committedPath} and updated ${committedRewriteCount} ${committedRewriteCount === 1 ? "link" : "links"}`
          : `Moved note to ${committedPath}`),
    );
    window.setTimeout(() => editor.focus(), 0);
  } else if (response?.outcome.status === "requires-confirmation") {
    elements.moveNoteSubmit.focus();
  } else if (response) {
    elements.moveNoteTarget.focus();
    elements.moveNoteTarget.select();
  }
}

function renderAttachmentMoveDialog(): void {
  const staleVault = Boolean(
    attachmentMoveVaultId && attachmentMoveVaultId !== (currentSnapshot?.vault.id ?? null),
  );
  if (staleVault && !elements.attachmentMoveError.textContent) {
    elements.attachmentMoveError.textContent =
      "The active vault changed. Cancel and reopen Publish copy.";
  }
  const message = elements.attachmentMoveError.textContent ?? "";
  elements.attachmentMoveError.hidden = message.length === 0;
  const previewMessage = elements.attachmentMovePreviewMessage.textContent ?? "";
  elements.attachmentMovePreviewMessage.hidden = previewMessage.length === 0;
  elements.attachmentMoveCurrentPath.textContent =
    attachmentMoveSourcePath ?? "No attachment selected";
  elements.attachmentMoveTarget.disabled = attachmentMoveBusy;
  elements.attachmentMoveClose.disabled = attachmentMoveBusy;
  elements.attachmentMoveCancel.disabled = attachmentMoveBusy;
  elements.attachmentMoveSubmit.disabled =
    attachmentMoveBusy || staleVault || readOnlyVault() || anyPaneDirty();
  elements.attachmentMoveSubmit.textContent = attachmentMoveBusy
    ? attachmentMoveConfirmationId
      ? "Publishing…"
      : "Checking…"
    : attachmentMoveConfirmationId
      ? `Update ${attachmentMoveRewrites.length} ${attachmentMoveRewrites.length === 1 ? "link" : "links"} and publish`
      : "Check and publish";
  elements.attachmentMoveForm.setAttribute("aria-busy", String(attachmentMoveBusy));
  elements.attachmentMoveVault.textContent = staleVault
    ? "Vault changed"
    : currentSnapshot
      ? `In ${currentSnapshot.vault.name}`
      : "Active vault";

  elements.attachmentMoveBlockerList.replaceChildren();
  const showingPreview = attachmentMoveRewrites.length > 0;
  const visibleChanges = showingPreview ? attachmentMoveRewrites : attachmentMoveBlockers;
  elements.attachmentMoveBlockers.hidden = visibleChanges.length === 0;
  elements.attachmentMoveBlockers.dataset.mode = showingPreview ? "preview" : "blocked";
  elements.attachmentMoveBlockerSummary.textContent = showingPreview
    ? `Ready: ${attachmentMoveRewrites.length} link target ${attachmentMoveRewrites.length === 1 ? "update" : "updates"}`
    : attachmentMoveBlockers.length === 1
      ? "Blocked: 1 internal link resolution is unsafe"
      : `Blocked: ${attachmentMoveBlockers.length} internal link resolutions are unsafe`;
  for (const rewrite of attachmentMoveRewrites.slice(0, 100)) {
    const item = document.createElement("li");
    const origin = document.createElement("span");
    origin.className = "move-note-blocker-origin";
    origin.textContent = `${rewrite.documentPath}:${rewrite.line} · ${rewrite.syntax === "wiki" ? "Wikilink" : "Markdown link"}`;
    const change = document.createElement("span");
    change.className = "move-note-blocker-change";
    const before = document.createElement("span");
    before.textContent = rewrite.beforeTarget;
    const arrow = document.createElement("span");
    arrow.className = "move-note-blocker-arrow";
    arrow.ariaHidden = "true";
    arrow.textContent = "→";
    const after = document.createElement("span");
    after.textContent = rewrite.afterTarget;
    change.append(before, arrow, after);
    item.append(origin, change);
    elements.attachmentMoveBlockerList.append(item);
  }
  for (const blocker of attachmentMoveBlockers.slice(0, 100)) {
    const item = document.createElement("li");
    const origin = document.createElement("span");
    origin.className = "move-note-blocker-origin";
    origin.textContent = `${blocker.documentPath}:${blocker.line} · ${blocker.syntax === "wiki" ? "Wikilink" : "Markdown link"}`;
    const target = document.createElement("code");
    target.textContent = blocker.target;
    const detail = document.createElement("span");
    detail.className = "move-note-blocker-change";
    detail.textContent =
      blocker.reason === "ambiguous"
        ? `Ambiguous (${blocker.candidates.slice(0, 4).join(", ") || "multiple matches"})`
        : blocker.reason === "unsupported"
          ? "Unsupported link form"
          : "Unresolved local link";
    item.append(origin, target, detail);
    elements.attachmentMoveBlockerList.append(item);
  }
  if (visibleChanges.length > 100) {
    const remainder = document.createElement("li");
    remainder.className = "move-note-blocker-more";
    remainder.textContent = `${visibleChanges.length - 100} more ${showingPreview ? "updates" : "blockers"} are not shown.`;
    elements.attachmentMoveBlockerList.append(remainder);
  }
}

function closeAttachmentMoveDialog(restoreFocus = true): void {
  if (!elements.attachmentMoveDialog.open || attachmentMoveBusy) return;
  elements.attachmentMoveDialog.close();
  attachmentMoveVaultId = null;
  attachmentMoveSourcePath = null;
  attachmentMoveRevision = null;
  attachmentMoveBlockers = [];
  attachmentMoveRewrites = [];
  attachmentMoveConfirmationId = null;
  elements.attachmentMoveError.textContent = "";
  elements.attachmentMovePreviewMessage.textContent = "";
  const restoreTarget = attachmentMoveRestoreFocus;
  attachmentMoveRestoreFocus = null;
  if (restoreFocus && restoreTarget?.isConnected) restoreTarget.focus();
}

async function moveCurrentAttachment(): Promise<void> {
  const expectedVaultId = attachmentMoveVaultId;
  const sourcePath = attachmentMoveSourcePath;
  const expectedRevision = attachmentMoveRevision;
  if (!expectedVaultId || !sourcePath || !expectedRevision || attachmentMoveBusy) return;
  const requestedPath = elements.attachmentMoveTarget.value.trim();
  if (!requestedPath) {
    elements.attachmentMoveError.textContent = "Enter a new vault-relative path.";
    attachmentMoveBlockers = [];
    attachmentMoveRewrites = [];
    attachmentMoveConfirmationId = null;
    elements.attachmentMovePreviewMessage.textContent = "";
    renderAttachmentMoveDialog();
    elements.attachmentMoveTarget.focus();
    return;
  }
  if (currentSnapshot?.vault.id !== expectedVaultId || anyPaneDirty()) {
    elements.attachmentMoveError.textContent = anyPaneDirty()
      ? "Save or revert drafts before publishing an attachment copy."
      : "The vault changed. Cancel and reopen Publish copy.";
    attachmentMoveBlockers = [];
    attachmentMoveRewrites = [];
    attachmentMoveConfirmationId = null;
    elements.attachmentMovePreviewMessage.textContent = "";
    renderAttachmentMoveDialog();
    return;
  }

  let response: AttachmentMoveResponse | null = null;
  let committedPath: string | null = null;
  let retainedSourcePath: string | null = null;
  let committedRewriteCount = 0;
  let committedVaultNotice: string | null = null;
  const submittedConfirmationId = attachmentMoveConfirmationId;
  attachmentMoveBusy = true;
  attachmentMoveBlockers = [];
  if (!submittedConfirmationId) {
    attachmentMoveRewrites = [];
    elements.attachmentMovePreviewMessage.textContent = "";
  }
  elements.attachmentMoveError.textContent = "";
  renderAttachmentMoveDialog();
  setActionState(true);
  try {
    response = await window.threadleaf.moveAttachment(
      sourcePath,
      requestedPath,
      expectedRevision,
      expectedVaultId,
      submittedConfirmationId ?? undefined,
    );
    render(response.snapshot);
    const attachmentConflictMessage =
      response.outcome.status === "conflict"
        ? attachmentPublicationConflictMessage(response.outcome.reason)
        : null;
    if (response.outcome.status === "published-source-retained") {
      const receipt = attachmentPublicationReceipt(response.outcome);
      if (receipt) {
        committedPath = receipt.targetPath;
        committedRewriteCount = receipt.rewriteCount;
        retainedSourcePath = receipt.sourcePath;
        committedVaultNotice = attachmentMoveCommitNotice(response);
      } else {
        attachmentMoveConfirmationId = null;
        attachmentMoveRewrites = [];
        elements.attachmentMovePreviewMessage.textContent = "";
        elements.attachmentMoveError.textContent =
          "Threadleaf received an incomplete publication receipt. The workbench remains open; review both paths before continuing.";
      }
    } else if (response.outcome.status === "requires-confirmation") {
      attachmentMoveBlockers = [];
      attachmentMoveRewrites = response.outcome.rewrites;
      attachmentMoveConfirmationId = response.outcome.confirmationId;
      const boundedPreviewNotice =
        response.outcome.rewrites.length > 100
          ? ` The list shows the first 100 of ${response.outcome.rewrites.length} exact updates.`
          : "";
      elements.attachmentMovePreviewMessage.textContent = submittedConfirmationId
        ? `The link plan changed on disk. Review this refreshed preview, then confirm it again.${boundedPreviewNotice}`
        : `Review the exact local link target updates below. Submit again to publish the copy and apply them as one recoverable operation.${boundedPreviewNotice}`;
    } else if (response.outcome.status === "blocked") {
      attachmentMoveConfirmationId = null;
      attachmentMoveRewrites = [];
      attachmentMoveBlockers = response.outcome.blockers;
      elements.attachmentMovePreviewMessage.textContent = "";
      elements.attachmentMoveError.textContent = `Publication blocked: ${response.outcome.blockers.length} internal link resolution${response.outcome.blockers.length === 1 ? " cannot" : "s cannot"} be rewritten safely. No files were changed.`;
    } else if (attachmentConflictMessage) {
      attachmentMoveConfirmationId = null;
      attachmentMoveRewrites = [];
      elements.attachmentMovePreviewMessage.textContent = "";
      elements.attachmentMoveError.textContent = attachmentConflictMessage;
    } else if (
      response.outcome.status === "conflict" &&
      response.outcome.reason === "target-exists"
    ) {
      attachmentMoveConfirmationId = null;
      attachmentMoveRewrites = [];
      elements.attachmentMovePreviewMessage.textContent = "";
      elements.attachmentMoveError.textContent =
        "That destination already exists. No files were changed.";
    } else if (
      response.outcome.status === "conflict" &&
      response.outcome.reason === "source-revision-changed"
    ) {
      attachmentMoveConfirmationId = null;
      attachmentMoveRewrites = [];
      elements.attachmentMovePreviewMessage.textContent = "";
      elements.attachmentMoveError.textContent =
        "The attachment changed on disk while Threadleaf checked the publication. No files were changed.";
    } else if (
      response.outcome.status === "conflict" &&
      response.outcome.reason === "rewrite-plan-changed"
    ) {
      attachmentMoveConfirmationId = null;
      attachmentMoveRewrites = [];
      elements.attachmentMovePreviewMessage.textContent = "";
      elements.attachmentMoveError.textContent =
        "The referenced notes changed after the preview. Nothing was published; reopen the workbench to review the current links.";
    } else {
      attachmentMoveConfirmationId = null;
      attachmentMoveRewrites = [];
      elements.attachmentMovePreviewMessage.textContent = "";
      elements.attachmentMoveError.textContent =
        "The attachment publication did not commit. No files were overwritten; review the current vault state.";
    }
  } catch {
    elements.attachmentMoveError.textContent =
      "The attachment publication could not be confirmed. Review the current vault state; no further files were changed.";
  } finally {
    attachmentMoveBusy = false;
    setActionState(false);
    if (elements.attachmentMoveDialog.open) renderAttachmentMoveDialog();
  }

  if (committedPath && retainedSourcePath) {
    closeAttachmentMoveDialog(false);
    const operationNotice = `Published a copy at ${committedPath}${
      committedRewriteCount > 0
        ? ` and updated ${committedRewriteCount} ${committedRewriteCount === 1 ? "link" : "links"}`
        : ""
    }; the original remains at ${retainedSourcePath}.`;
    showToast(
      committedVaultNotice ? `${committedVaultNotice} ${operationNotice}` : operationNotice,
    );
  } else if (response?.outcome.status === "requires-confirmation") {
    elements.attachmentMoveSubmit.focus();
  } else if (response) {
    elements.attachmentMoveTarget.focus();
    elements.attachmentMoveTarget.select();
  }
}
function renderDeleteNoteDialog(): void {
  const staleVault = Boolean(
    deleteNoteVaultId && deleteNoteVaultId !== (currentSnapshot?.vault.id ?? null),
  );
  const staleNote = Boolean(
    deleteNoteSourcePath &&
      deleteNoteRevision &&
      (!loadedNote ||
        loadedNote.path !== deleteNoteSourcePath ||
        loadedNote.revision !== deleteNoteRevision),
  );
  if ((staleVault || staleNote) && !elements.deleteNoteError.textContent) {
    elements.deleteNoteError.textContent = staleVault
      ? "The active vault changed. Cancel and reopen Trash."
      : "The note changed on disk. Cancel, review it, and reopen Trash.";
  }

  const sourcePath = deleteNoteSourcePath ?? "No note selected";
  const message = elements.deleteNoteError.textContent ?? "";
  elements.deleteNoteError.hidden = message.length === 0;
  elements.deleteNoteCurrentPath.textContent = sourcePath;
  elements.deleteNoteTrashPath.textContent = deleteNoteSourcePath
    ? `.trash/${deleteNoteSourcePath}`
    : ".trash/";
  elements.deleteNoteImpactCopy.textContent =
    deleteNoteBacklinkCount === 0
      ? currentWorkspacePreference().confirmDelete === "when-linked"
        ? "No indexed note currently links here. Confirmation is still required; the file will remain recoverable in .trash/."
        : "No indexed note currently links here. Confirm the recoverable move to .trash/."
      : `${deleteNoteBacklinkCount} indexed incoming link${deleteNoteBacklinkCount === 1 ? "" : "s"} will become unresolved. Restore this file later from .trash/.`;
  elements.deleteNoteClose.disabled = deleteNoteBusy;
  elements.deleteNoteCancel.disabled = deleteNoteBusy;
  elements.deleteNoteSubmit.disabled = deleteNoteBusy || staleVault || staleNote || readOnlyVault();
  elements.deleteNoteSubmit.textContent = deleteNoteBusy
    ? "Moving…"
    : currentWorkspacePreference().confirmDelete === "when-linked" && deleteNoteBacklinkCount === 0
      ? "Confirm recoverable move"
      : "Move to trash";
  elements.deleteNoteForm.setAttribute("aria-busy", String(deleteNoteBusy));
  elements.deleteNoteVault.textContent = staleVault
    ? "Vault changed"
    : currentSnapshot
      ? `In ${currentSnapshot.vault.name}`
      : "Active vault";
}

function openDeleteNoteDialog(): void {
  if (elements.deleteNoteDialog.open) {
    elements.deleteNoteCancel.focus();
    return;
  }
  if (!loadedNote || !loadedVaultId || readOnlyVault() || busy || saving || dirty) {
    showToast(
      readOnlyVault()
        ? "Open a local vault before moving notes to trash."
        : dirty
          ? "Save or revert the current note before moving it to trash."
          : loadedNote
            ? "Threadleaf is finishing another action."
            : "Open a note before moving it to trash.",
    );
    return;
  }
  if (elements.commandPalette.open) {
    closeCommandPalette(false);
  }
  if (documentViewMode === "plugin") {
    setDocumentView(editingViewMode, false);
  }
  deleteNoteRestoreFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  deleteNoteBusy = false;
  deleteNoteVaultId = loadedVaultId;
  deleteNoteSourcePath = loadedNote.path;
  deleteNoteRevision = loadedNote.revision;
  deleteNoteBacklinkCount = loadedNote.backlinks.length;
  elements.deleteNoteError.textContent = "";
  elements.deleteNoteDialog.showModal();
  renderDeleteNoteDialog();
  window.requestAnimationFrame(() => elements.deleteNoteCancel.focus());
}

function closeDeleteNoteDialog(restoreFocus = true): void {
  if (!elements.deleteNoteDialog.open || deleteNoteBusy) {
    return;
  }
  elements.deleteNoteDialog.close();
  deleteNoteVaultId = null;
  deleteNoteSourcePath = null;
  deleteNoteRevision = null;
  deleteNoteBacklinkCount = 0;
  elements.deleteNoteError.textContent = "";
  const restoreTarget = deleteNoteRestoreFocus;
  deleteNoteRestoreFocus = null;
  if (restoreFocus && restoreTarget?.isConnected) {
    restoreTarget.focus();
  }
}

async function deleteCurrentNote(): Promise<void> {
  const expectedVaultId = deleteNoteVaultId;
  const sourcePath = deleteNoteSourcePath;
  const expectedRevision = deleteNoteRevision;
  if (!expectedVaultId || !sourcePath || !expectedRevision || deleteNoteBusy) {
    return;
  }
  if (
    currentSnapshot?.vault.id !== expectedVaultId ||
    loadedNote?.path !== sourcePath ||
    loadedNote.revision !== expectedRevision
  ) {
    elements.deleteNoteError.textContent =
      "The vault or note changed. Cancel, review the current note, and reopen Trash.";
    renderDeleteNoteDialog();
    return;
  }

  let response: NoteDeleteResponse | null = null;
  let committed = false;
  deleteNoteBusy = true;
  elements.deleteNoteError.textContent = "";
  renderDeleteNoteDialog();
  setActionState(true);
  try {
    response = await window.threadleaf.deleteNote(sourcePath, expectedRevision, expectedVaultId);
    render(response.snapshot);
    if (response.outcome.status === "committed") {
      committed = true;
    } else if (
      response.outcome.status === "conflict" &&
      response.outcome.reason === "target-exists"
    ) {
      elements.deleteNoteError.textContent = `${response.outcome.to} already contains an earlier deletion. Restore or move that file first. No files were changed.`;
    } else if (
      response.outcome.status === "conflict" &&
      response.outcome.reason === "source-revision-changed"
    ) {
      elements.deleteNoteError.textContent =
        "The note changed on disk before it could be moved. Review the current version and try again. No files were changed.";
    } else {
      elements.deleteNoteError.textContent = `The note could not be moved to trash (${response.outcome.reason}). No files were changed.`;
    }
  } catch (error) {
    elements.deleteNoteError.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    deleteNoteBusy = false;
    setActionState(false);
    if (elements.deleteNoteDialog.open) {
      renderDeleteNoteDialog();
    }
  }

  if (committed) {
    closeDeleteNoteDialog(false);
    setDocumentView(editingViewMode, false);
    showToast(`Moved ${sourcePath} to recoverable trash.`);
    window.setTimeout(() => {
      if (loadedNote) {
        editor.focus();
      } else {
        elements.fileSearch.focus();
      }
    }, 0);
  }
}

function settingsOperationBusy(): boolean {
  return (
    settingsBusy ||
    noteWorkflowBusy ||
    workspaceSettingsBusy ||
    appearanceBusy ||
    appearancePackageBusy ||
    accessibilityBusy ||
    pluginBusy ||
    migrationBusy ||
    migrationApplyBusy ||
    supportBundleBusy
  );
}

function currentNoteWorkflowPreference(): VaultNoteWorkflowSettings {
  const vaultId = currentSnapshot?.vault.id;
  return vaultId
    ? noteWorkflowsForVault(settingsSnapshot.settings, vaultId)
    : createDefaultVaultNoteWorkflowSettings();
}

function currentWorkspacePreference(): VaultWorkspaceSettings {
  const vaultId = currentSnapshot?.vault.id;
  return vaultId
    ? workspaceSettingsForVault(settingsSnapshot.settings, vaultId)
    : createDefaultVaultWorkspaceSettings();
}

function workspaceSettingsEqual(
  left: VaultWorkspaceSettings,
  right: VaultWorkspaceSettings,
): boolean {
  return (
    left.defaultNoteFolder === right.defaultNoteFolder &&
    left.linkStyle === right.linkStyle &&
    left.automaticLinkUpdates === right.automaticLinkUpdates &&
    left.confirmDelete === right.confirmDelete &&
    left.newTabBehavior === right.newTabBehavior &&
    left.editorMode === right.editorMode &&
    left.documentView === right.documentView &&
    left.restorePolicy === right.restorePolicy
  );
}

async function refreshWorkspaceSettings(successMessage?: string): Promise<void> {
  const expectedVaultId = currentSnapshot?.vault.id;
  if (!expectedVaultId || vaultOpening()) {
    return;
  }
  const request = ++workspaceSettingsRequest;
  workspaceSettingsBusy = true;
  workspaceSettingsMessage = "Reading private workspace preferences.";
  workspaceSettingsMessageKind = "info";
  renderSettings();
  try {
    const response = await window.threadleaf.getWorkspaceSettings(expectedVaultId);
    if (
      request !== workspaceSettingsRequest ||
      response.status !== "ready" ||
      response.vaultId !== currentSnapshot?.vault.id
    ) {
      return;
    }
    workspaceSettingsDraft = { ...response.settings };
    applyWorkspaceViewDefaults(response.settings);
    workspaceSettingsMessage = successMessage ?? "Private workspace preferences loaded.";
    workspaceSettingsMessageKind = successMessage ? "saved" : "info";
  } catch (error) {
    if (request === workspaceSettingsRequest) {
      workspaceSettingsMessage = error instanceof Error ? error.message : String(error);
      workspaceSettingsMessageKind = "error";
    }
  } finally {
    if (request === workspaceSettingsRequest) {
      workspaceSettingsBusy = false;
      renderSettings();
    }
  }
}

function renderWorkspaceSettings(): void {
  const vaultId = currentSnapshot?.vault.id ?? null;
  const settings = workspaceSettingsDraft ?? currentWorkspacePreference();
  const disabled = !vaultId || vaultOpening() || workspaceSettingsBusy;
  elements.workspaceDefaultFolder.value = settings.defaultNoteFolder;
  elements.workspaceLinkStyle.value = settings.linkStyle;
  elements.workspaceAutomaticLinks.value = settings.automaticLinkUpdates;
  elements.workspaceConfirmDelete.value = settings.confirmDelete;
  elements.workspaceNewTab.value = settings.newTabBehavior;
  elements.workspaceEditorMode.value = settings.editorMode;
  elements.workspaceDocumentView.value = settings.documentView;
  elements.workspaceRestorePolicy.value = settings.restorePolicy;
  for (const control of [
    elements.workspaceDefaultFolder,
    elements.workspaceLinkStyle,
    elements.workspaceAutomaticLinks,
    elements.workspaceConfirmDelete,
    elements.workspaceNewTab,
    elements.workspaceEditorMode,
    elements.workspaceDocumentView,
    elements.workspaceRestorePolicy,
  ]) {
    control.disabled = disabled;
  }
  elements.workspaceSettingsReset.disabled = disabled;
  elements.workspaceSettingsReset.textContent = workspaceSettingsBusy
    ? "Restoring…"
    : "Reset this vault's defaults";
  elements.workspaceSettingsSave.disabled = disabled;
  elements.workspaceSettingsSave.textContent = workspaceSettingsBusy
    ? "Saving…"
    : "Save preferences";
  elements.workspaceSettingsForm.setAttribute("aria-busy", String(workspaceSettingsBusy));
  elements.workspaceSettingsState.textContent = workspaceSettingsBusy
    ? "Loading"
    : vaultId
      ? "Ready"
      : "No vault";
  elements.workspaceSettingsState.dataset.state = vaultId ? "active" : "";
}

function captureWorkspaceSettingsDraft(): VaultWorkspaceSettings {
  const draft: VaultWorkspaceSettings = {
    defaultNoteFolder: elements.workspaceDefaultFolder.value,
    linkStyle: elements.workspaceLinkStyle.value as VaultWorkspaceSettings["linkStyle"],
    automaticLinkUpdates: elements.workspaceAutomaticLinks
      .value as VaultWorkspaceSettings["automaticLinkUpdates"],
    confirmDelete: elements.workspaceConfirmDelete.value as VaultWorkspaceSettings["confirmDelete"],
    newTabBehavior: elements.workspaceNewTab.value as VaultWorkspaceSettings["newTabBehavior"],
    editorMode: elements.workspaceEditorMode.value as VaultWorkspaceSettings["editorMode"],
    documentView: elements.workspaceDocumentView.value as VaultWorkspaceSettings["documentView"],
    restorePolicy: elements.workspaceRestorePolicy.value as VaultWorkspaceSettings["restorePolicy"],
  };
  workspaceSettingsDraft = draft;
  return draft;
}

async function saveWorkspaceSettings(): Promise<void> {
  const expectedVaultId = currentSnapshot?.vault.id;
  if (!expectedVaultId || vaultOpening() || workspaceSettingsBusy) {
    return;
  }
  const previousPreference = currentWorkspacePreference();
  const requestedSettings = captureWorkspaceSettingsDraft();
  workspaceSettingsBusy = true;
  workspaceSettingsMessage = "Saving private workspace preferences.";
  workspaceSettingsMessageKind = "info";
  renderSettings();
  try {
    const response = await window.threadleaf.setWorkspaceSettings(
      expectedVaultId,
      requestedSettings,
    );
    if (response.status !== "updated") {
      workspaceSettingsMessage =
        "The active vault changed. Review these preferences and save again.";
      workspaceSettingsMessageKind = "error";
      return;
    }
    workspaceSettingsDraft = { ...response.settings };
    applySettingsSnapshot(response.appSettings);
    applyWorkspaceViewDefaults(response.settings, {
      force:
        previousPreference.editorMode !== response.settings.editorMode ||
        previousPreference.documentView !== response.settings.documentView,
    });
    workspaceSettingsMessage = "Workspace preferences saved privately for this vault.";
    workspaceSettingsMessageKind = "saved";
  } catch (error) {
    workspaceSettingsMessage = error instanceof Error ? error.message : String(error);
    workspaceSettingsMessageKind = "error";
  } finally {
    workspaceSettingsBusy = false;
    renderSettings();
  }
}

async function resetWorkspaceSettings(): Promise<void> {
  const expectedVaultId = currentSnapshot?.vault.id;
  if (!expectedVaultId || vaultOpening() || workspaceSettingsBusy) {
    return;
  }
  workspaceSettingsBusy = true;
  workspaceSettingsMessage = "Restoring safe workspace defaults.";
  workspaceSettingsMessageKind = "info";
  renderSettings();
  try {
    const response = await window.threadleaf.resetWorkspaceSettings(expectedVaultId);
    if (response.status !== "updated") {
      workspaceSettingsMessage =
        "The active vault changed. Review these preferences and reset again if needed.";
      workspaceSettingsMessageKind = "error";
      return;
    }
    workspaceSettingsDraft = { ...response.settings };
    applySettingsSnapshot(response.appSettings);
    applyWorkspaceViewDefaults(response.settings, { force: true });
    workspaceSettingsMessage = "Safe workspace defaults restored for this vault.";
    workspaceSettingsMessageKind = "saved";
  } catch (error) {
    workspaceSettingsMessage = error instanceof Error ? error.message : String(error);
    workspaceSettingsMessageKind = "error";
  } finally {
    workspaceSettingsBusy = false;
    renderSettings();
  }
}

function noteWorkflowPreferencesEqual(
  left: VaultNoteWorkflowSettings,
  right: VaultNoteWorkflowSettings,
): boolean {
  return (
    left.templateFolder === right.templateFolder &&
    left.templateDateFormat === right.templateDateFormat &&
    left.templateTimeFormat === right.templateTimeFormat &&
    left.dailyNoteFolder === right.dailyNoteFolder &&
    left.dailyNoteDateFormat === right.dailyNoteDateFormat &&
    left.dailyNoteTemplate === right.dailyNoteTemplate
  );
}

async function refreshNoteWorkflows(
  successMessage?: string,
): Promise<ReadyNoteWorkflowCatalog | null> {
  const expectedVaultId = currentSnapshot?.vault.id;
  if (!expectedVaultId || vaultOpening()) {
    return null;
  }
  const request = ++noteWorkflowRequest;
  noteWorkflowBusy = true;
  noteWorkflowMessage = "Discovering templates and daily-note preferences in this vault.";
  noteWorkflowMessageKind = "info";
  renderSettings();
  try {
    const response = await window.threadleaf.getNoteWorkflows(expectedVaultId);
    if (request !== noteWorkflowRequest || response.status !== "ready") {
      return null;
    }
    noteWorkflowCatalog = response;
    noteWorkflowMessage =
      successMessage ??
      `${response.templates.length} Markdown template${response.templates.length === 1 ? "" : "s"} available.`;
    noteWorkflowMessageKind = successMessage ? "saved" : "info";
    return response;
  } catch (error) {
    if (request === noteWorkflowRequest) {
      noteWorkflowCatalog = null;
      noteWorkflowMessage = error instanceof Error ? error.message : String(error);
      noteWorkflowMessageKind = "error";
    }
    return null;
  } finally {
    if (request === noteWorkflowRequest) {
      noteWorkflowBusy = false;
      renderSettings();
    }
  }
}

function renderNoteWorkflowSettings(): void {
  const vaultId = currentSnapshot?.vault.id ?? null;
  const catalog = noteWorkflowCatalog?.vaultId === vaultId ? noteWorkflowCatalog : null;
  const settings = noteWorkflowDraft ?? catalog?.settings ?? currentNoteWorkflowPreference();
  const disabled = !vaultId || vaultOpening() || noteWorkflowBusy;
  elements.workflowTemplateFolder.value = settings.templateFolder;
  elements.workflowDateFormat.value = settings.templateDateFormat;
  elements.workflowTimeFormat.value = settings.templateTimeFormat;
  elements.workflowDailyFolder.value = settings.dailyNoteFolder;
  elements.workflowDailyFormat.value = settings.dailyNoteDateFormat;

  elements.workflowDailyTemplate.replaceChildren();
  const noTemplate = document.createElement("option");
  noTemplate.value = "";
  noTemplate.textContent = "No template";
  elements.workflowDailyTemplate.append(noTemplate);
  for (const templatePath of catalog?.templates ?? []) {
    const option = document.createElement("option");
    option.value = templatePath;
    option.textContent = templatePath;
    elements.workflowDailyTemplate.append(option);
  }
  if (
    settings.dailyNoteTemplate &&
    !(catalog?.templates ?? []).includes(settings.dailyNoteTemplate)
  ) {
    const missing = document.createElement("option");
    missing.value = settings.dailyNoteTemplate;
    missing.textContent = `Unavailable: ${settings.dailyNoteTemplate}`;
    elements.workflowDailyTemplate.append(missing);
  }
  elements.workflowDailyTemplate.value = settings.dailyNoteTemplate ?? "";

  for (const control of [
    elements.workflowTemplateFolder,
    elements.workflowDateFormat,
    elements.workflowTimeFormat,
    elements.workflowDailyFolder,
    elements.workflowDailyFormat,
    elements.workflowDailyTemplate,
  ]) {
    control.disabled = disabled;
  }
  elements.workflowSave.disabled = disabled;
  elements.workflowSave.textContent = noteWorkflowBusy ? "Saving…" : "Save preferences";
  elements.noteWorkflowForm.setAttribute("aria-busy", String(noteWorkflowBusy));
  elements.noteWorkflowState.textContent = noteWorkflowBusy
    ? "Loading"
    : catalog
      ? "Ready"
      : "Not scanned";
  elements.noteWorkflowState.dataset.state = catalog ? "active" : "";
  elements.workflowTemplateCount.textContent = catalog
    ? `${catalog.templates.length} template${catalog.templates.length === 1 ? "" : "s"} found`
    : "Template folder not scanned";
}

async function saveNoteWorkflows(): Promise<void> {
  const expectedVaultId = currentSnapshot?.vault.id;
  if (!expectedVaultId || vaultOpening() || noteWorkflowBusy) {
    return;
  }
  const requestedSettings = captureNoteWorkflowDraft();
  noteWorkflowBusy = true;
  noteWorkflowMessage = "Saving note workflow preferences.";
  noteWorkflowMessageKind = "info";
  renderSettings();
  try {
    const response = await window.threadleaf.setNoteWorkflows(expectedVaultId, requestedSettings);
    if (response.status !== "updated") {
      noteWorkflowMessage = "The active vault changed. Review these preferences and save again.";
      noteWorkflowMessageKind = "error";
      return;
    }
    noteWorkflowCatalog = {
      status: "ready",
      vaultId: response.vaultId,
      settings: response.settings,
      templates: response.templates,
    };
    noteWorkflowDraft = { ...response.settings };
    applySettingsSnapshot(response.appSettings);
    noteWorkflowMessage = `Preferences saved. ${response.templates.length} template${response.templates.length === 1 ? "" : "s"} found.`;
    noteWorkflowMessageKind = "saved";
  } catch (error) {
    noteWorkflowMessage = error instanceof Error ? error.message : String(error);
    noteWorkflowMessageKind = "error";
  } finally {
    noteWorkflowBusy = false;
    renderSettings();
  }
}

function captureNoteWorkflowDraft(): VaultNoteWorkflowSettings {
  const draft = {
    templateFolder: elements.workflowTemplateFolder.value,
    templateDateFormat: elements.workflowDateFormat.value,
    templateTimeFormat: elements.workflowTimeFormat.value,
    dailyNoteFolder: elements.workflowDailyFolder.value,
    dailyNoteDateFormat: elements.workflowDailyFormat.value,
    dailyNoteTemplate: elements.workflowDailyTemplate.value || null,
  };
  noteWorkflowDraft = draft;
  return draft;
}

function currentAppearancePreference(): VaultAppearanceSettings {
  const vaultId = currentSnapshot?.vault.id;
  return vaultId
    ? appearanceForVault(settingsSnapshot.settings, vaultId)
    : createDefaultVaultAppearance();
}

function appearancesEqual(left: VaultAppearanceSettings, right: VaultAppearanceSettings): boolean {
  return (
    left.colorScheme === right.colorScheme &&
    left.themeId === right.themeId &&
    left.enabledSnippetIds.length === right.enabledSnippetIds.length &&
    left.enabledSnippetIds.every((id, index) => id === right.enabledSnippetIds[index])
  );
}

function currentPluginPreference(): VaultPluginSettings {
  const vaultId = currentSnapshot?.vault.id;
  return vaultId
    ? pluginsForVault(settingsSnapshot.settings, vaultId)
    : createDefaultVaultPluginSettings();
}

function pluginSafeModeActive(): boolean {
  const catalog = pluginCatalog;
  return catalog !== null && catalog.vaultId === currentSnapshot?.vault.id && catalog.safeMode;
}

function pluginPreferencesEqual(left: VaultPluginSettings, right: VaultPluginSettings): boolean {
  const leftGrantIds = Object.keys(left.capabilityGrantsByPlugin).sort((first, second) =>
    first.localeCompare(second, "en-US"),
  );
  const rightGrantIds = Object.keys(right.capabilityGrantsByPlugin).sort((first, second) =>
    first.localeCompare(second, "en-US"),
  );
  return (
    left.compatibilityMode === right.compatibilityMode &&
    left.enabledPluginIds.length === right.enabledPluginIds.length &&
    left.enabledPluginIds.every((id, index) => id === right.enabledPluginIds[index]) &&
    leftGrantIds.length === rightGrantIds.length &&
    leftGrantIds.every((pluginId, index) => {
      if (pluginId !== rightGrantIds[index]) {
        return false;
      }
      const leftGrant = left.capabilityGrantsByPlugin[pluginId];
      const rightGrant = right.capabilityGrantsByPlugin[pluginId];
      return (
        leftGrant !== undefined &&
        rightGrant !== undefined &&
        leftGrant.bundleSha256 === rightGrant.bundleSha256 &&
        leftGrant.capabilities.length === rightGrant.capabilities.length &&
        leftGrant.capabilities.every(
          (capability, capabilityIndex) => capability === rightGrant.capabilities[capabilityIndex],
        )
      );
    })
  );
}

const accessibilityAccentColors: Record<
  AccessibilityAccent,
  { light: string; dark: string; lightHover: string; darkHover: string }
> = {
  // Each ink is independently chosen for both schemes. The light values are
  // dark enough for text and controls on the light ground; the dark values are
  // bright enough for text and controls on the dark ground.
  blue: { light: "#005a8c", dark: "#76c7f0", lightHover: "#003f66", darkHover: "#a8e0fa" },
  teal: { light: "#006b5d", dark: "#62d4c3", lightHover: "#004f46", darkHover: "#a0f1e3" },
  orange: { light: "#9a4b00", dark: "#ffb45f", lightHover: "#713400", darkHover: "#ffd29a" },
};

function currentAccessibilityPreferences(): AccessibilityPreferences {
  return accessibilityPreferencesSnapshot.preferences;
}

function effectiveCurrentAccessibilityPreferences(): EffectiveAccessibilityPreferences {
  return resolveAccessibilityPreferences(currentAccessibilityPreferences(), {
    highContrast: systemHighContrast.matches,
    reducedMotion: systemReducedMotion.matches,
    reducedTransparency: systemReducedTransparency.matches,
  });
}

function accessibilityCss(state: EffectiveAccessibilityPreferences): string {
  const colors = accessibilityAccentColors[state.accent];
  return `
    :root {
      --threadleaf-ui-font-scale: ${state.uiFontScale};
      --threadleaf-text-font-scale: ${state.textFontScale};
      --threadleaf-editor-font-size: ${state.editorFontSize}px;
      --threadleaf-editor-line-height: ${state.editorLineHeight};
    }
    :root[data-threadleaf-accessibility="true"] {
      --color-accent: ${colors.light} !important;
      --interactive-accent: ${colors.light} !important;
      --interactive-accent-hover: ${colors.lightHover} !important;
      --text-accent: ${colors.light} !important;
      --text-accent-hover: ${colors.lightHover} !important;
      --accent: ${colors.light} !important;
      --accent-strong: ${colors.light} !important;
      font-size: calc(100% * var(--threadleaf-ui-font-scale)) !important;
    }
    :root[data-theme="dark"][data-threadleaf-accessibility="true"] {
      --color-accent: ${colors.dark} !important;
      --interactive-accent: ${colors.dark} !important;
      --interactive-accent-hover: ${colors.darkHover} !important;
      --text-accent: ${colors.dark} !important;
      --text-accent-hover: ${colors.darkHover} !important;
      --accent: ${colors.dark} !important;
      --accent-strong: ${colors.dark} !important;
    }
    :root[data-threadleaf-accessibility="true"] body {
      font-size: calc(14px * var(--threadleaf-ui-font-scale)) !important;
    }
    :root[data-threadleaf-accessibility="true"] .note-preview,
    :root[data-threadleaf-accessibility="true"] .note-header,
    :root[data-threadleaf-accessibility="true"] .settings-content {
      font-size: calc(14px * var(--threadleaf-text-font-scale)) !important;
    }
    :root[data-threadleaf-accessibility="true"] .cm-editor,
    :root[data-threadleaf-accessibility="true"] .cm-content,
    :root[data-threadleaf-accessibility="true"] .cm-line {
      font-size: var(--threadleaf-editor-font-size) !important;
      line-height: var(--threadleaf-editor-line-height) !important;
    }
    :root[data-threadleaf-high-contrast="true"] {
      --surface: #ffffff !important;
      --surface-raised: #ffffff !important;
      --surface-sunken: #ffffff !important;
      --canvas: #ffffff !important;
      --ink: #111111 !important;
      --ink-soft: #333333 !important;
      --ink-muted: #444444 !important;
      --line: #111111 !important;
      --line-strong: #000000 !important;
      --background-primary: #ffffff !important;
      --background-primary-alt: #ffffff !important;
      --background-secondary: #ffffff !important;
      --background-secondary-alt: #ffffff !important;
      --background-modifier-border: #111111 !important;
      --background-modifier-border-hover: #000000 !important;
      --text-normal: #111111 !important;
      --text-muted: #333333 !important;
      --text-faint: #444444 !important;
      --signal: #7a3100 !important;
      --signal-soft: #fff3e6 !important;
      background: #ffffff !important;
      color: #111111 !important;
    }
    :root[data-theme="dark"][data-threadleaf-high-contrast="true"] {
      --surface: #000000 !important;
      --surface-raised: #000000 !important;
      --surface-sunken: #000000 !important;
      --canvas: #000000 !important;
      --ink: #ffffff !important;
      --ink-soft: #eeeeee !important;
      --ink-muted: #dddddd !important;
      --line: #ffffff !important;
      --line-strong: #ffffff !important;
      --background-primary: #000000 !important;
      --background-primary-alt: #000000 !important;
      --background-secondary: #000000 !important;
      --background-secondary-alt: #000000 !important;
      --background-modifier-border: #ffffff !important;
      --background-modifier-border-hover: #ffffff !important;
      --text-normal: #ffffff !important;
      --text-muted: #eeeeee !important;
      --text-faint: #dddddd !important;
      --signal: #ffb45f !important;
      --signal-soft: #2a1708 !important;
      background: #000000 !important;
      color: #ffffff !important;
    }
    :root[data-threadleaf-reduced-motion="true"] *,
    :root[data-threadleaf-reduced-motion="true"] *::before,
    :root[data-threadleaf-reduced-motion="true"] *::after {
      animation: none !important;
      transition: none !important;
      scroll-behavior: auto !important;
    }
    :root[data-threadleaf-reduced-transparency="true"] *,
    :root[data-threadleaf-reduced-transparency="true"] *::before,
    :root[data-threadleaf-reduced-transparency="true"] *::after {
      backdrop-filter: none !important;
    }
    :root[data-threadleaf-reduced-transparency="true"] dialog::backdrop {
      backdrop-filter: none !important;
      background: var(--canvas) !important;
    }
    :root[data-threadleaf-reduced-transparency="true"] .topbar,
    :root[data-threadleaf-reduced-transparency="true"] .modal,
    :root[data-threadleaf-reduced-transparency="true"] .settings-shell,
    :root[data-threadleaf-reduced-transparency="true"] .note-tabs-shell {
      background: var(--surface-raised) !important;
      box-shadow: none !important;
    }
    :root[data-threadleaf-accessibility="true"] button:focus-visible,
    :root[data-threadleaf-accessibility="true"] a:focus-visible,
    :root[data-threadleaf-accessibility="true"] input:focus-visible,
    :root[data-threadleaf-accessibility="true"] select:focus-visible,
    :root[data-threadleaf-accessibility="true"] summary:focus-visible,
    :root[data-threadleaf-accessibility="true"] [tabindex]:focus-visible {
      outline: 3px solid var(--accent-strong) !important;
      outline-offset: 2px !important;
    }
  `;
}

function setAccessibilityRootAttributes(state: EffectiveAccessibilityPreferences): void {
  const root = document.documentElement;
  root.dataset.threadleafAccessibility = "true";
  root.dataset.threadleafHighContrast = String(state.highContrast);
  root.dataset.threadleafReducedMotion = String(state.reducedMotion);
  root.dataset.threadleafReducedTransparency = String(state.reducedTransparency);
  root.dataset.threadleafAccent = state.accent;
  for (const target of [root, document.body]) {
    target.style.setProperty("--threadleaf-ui-font-scale", String(state.uiFontScale), "important");
    target.style.setProperty(
      "--threadleaf-text-font-scale",
      String(state.textFontScale),
      "important",
    );
    target.style.setProperty(
      "--threadleaf-editor-font-size",
      `${state.editorFontSize}px`,
      "important",
    );
    target.style.setProperty(
      "--threadleaf-editor-line-height",
      String(state.editorLineHeight),
      "important",
    );
  }
  accessibilityStyle.textContent = accessibilityCss(state);
  void window.threadleaf.setPluginSurfaceAccessibility(state).catch(() => undefined);
}

function refreshAccessibilityDiagnostics(): void {
  const state = effectiveCurrentAccessibilityPreferences();
  const diagnostics: string[] = [];
  const computed = getComputedStyle(document.documentElement);
  const expectedAccent =
    document.documentElement.dataset.theme === "dark"
      ? accessibilityAccentColors[state.accent].dark
      : accessibilityAccentColors[state.accent].light;
  const actualAccent = computed.getPropertyValue("--interactive-accent").trim().toLowerCase();
  if (actualAccent && actualAccent !== expectedAccent) {
    diagnostics.push(
      `The selected theme or plugin overrides the protected ${state.accent} accent; Threadleaf could not verify the requested accent in live computed styles.`,
    );
  }
  if (
    appearanceSnapshot?.css &&
    /(?:--threadleaf-|font-size|line-height|prefers-reduced|backdrop-filter)/u.test(
      appearanceSnapshot.css,
    )
  ) {
    diagnostics.push(
      "The selected theme declares rules touching accessibility-sensitive properties. Threadleaf reapplies explicit preferences after that CSS, but plugin-owned inline styles may still require review.",
    );
  }
  if (
    pluginCatalog?.css &&
    /(?:--threadleaf-|font-size|line-height|prefers-reduced|backdrop-filter)/u.test(
      pluginCatalog.css,
    )
  ) {
    diagnostics.push(
      "An enabled compatibility plugin declares accessibility-sensitive styles. Its view is isolated and receives the explicit preference layer; inspect the diagnostics if its live view differs.",
    );
  }
  elements.accessibilityDiagnostics.replaceChildren();
  for (const message of diagnostics) {
    const item = document.createElement("li");
    item.textContent = message;
    elements.accessibilityDiagnostics.append(item);
  }
  if (diagnostics.length === 0) {
    const item = document.createElement("li");
    item.textContent = "No accessibility preference conflicts detected in the native workspace.";
    elements.accessibilityDiagnostics.append(item);
  }
}

function applyAccessibilityPreferences(snapshot: AccessibilityPreferencesSnapshot): void {
  accessibilityPreferencesSnapshot = snapshot;
  accessibilityPreferencesLoaded = true;
  if (snapshot.warning && snapshot.warning !== lastAccessibilityWarning) {
    showToast(snapshot.warning);
  }
  lastAccessibilityWarning = snapshot.warning;
  setAccessibilityRootAttributes(effectiveCurrentAccessibilityPreferences());
  renderSettings();
}

function accessibilityOverrideFromControl(value: string): AccessibilityOverride {
  return value === "system" ? null : value === "on";
}

function accessibilityOverrideLabel(value: AccessibilityOverride): string {
  return value === null ? "system" : value ? "on" : "off";
}

function accessibilityPreferencesAreCustomized(preferences: AccessibilityPreferences): boolean {
  return (
    preferences.highContrast !== null ||
    preferences.reducedMotion !== null ||
    preferences.reducedTransparency !== null ||
    preferences.accent !== "blue" ||
    preferences.uiFontScale !== 1 ||
    preferences.textFontScale !== 1 ||
    preferences.editorFontSize !== 15 ||
    preferences.editorLineHeight !== 1.6
  );
}

function renderAccessibilitySettings(): void {
  const preferences = currentAccessibilityPreferences();
  const disabled = accessibilityBusy || !accessibilityPreferencesLoaded;
  for (const [control, value] of [
    [elements.accessibilityHighContrast, accessibilityOverrideLabel(preferences.highContrast)],
    [elements.accessibilityReducedMotion, accessibilityOverrideLabel(preferences.reducedMotion)],
    [
      elements.accessibilityReducedTransparency,
      accessibilityOverrideLabel(preferences.reducedTransparency),
    ],
  ] as const) {
    control.value = value;
    control.disabled = disabled;
  }
  elements.accessibilityAccent.value = preferences.accent;
  elements.accessibilityAccent.disabled = disabled;
  const ranges = [
    [
      elements.accessibilityUiFontScale,
      preferences.uiFontScale,
      accessibilityPreferenceRanges.uiFontScale,
    ],
    [
      elements.accessibilityTextFontScale,
      preferences.textFontScale,
      accessibilityPreferenceRanges.textFontScale,
    ],
    [
      elements.accessibilityEditorFontSize,
      preferences.editorFontSize,
      accessibilityPreferenceRanges.editorFontSize,
    ],
    [
      elements.accessibilityEditorLineHeight,
      preferences.editorLineHeight,
      accessibilityPreferenceRanges.editorLineHeight,
    ],
  ] as const;
  for (const [control, value, range] of ranges) {
    control.value = String(value);
    control.setAttribute("aria-valuetext", String(value));
    control.min = String(range.min);
    control.max = String(range.max);
    control.step = String(range.step);
    control.disabled = disabled;
  }
  elements.accessibilityReset.disabled = disabled;
  elements.accessibilityStatus.textContent =
    accessibilityMessageKind === "info"
      ? accessibilityPreferencesAreCustomized(preferences)
        ? "Explicit accessibility preferences are active outside the vault."
        : "System accessibility preferences are active until you override them."
      : accessibilityMessage;
  elements.accessibilityStatus.dataset.kind = accessibilityMessageKind;
  refreshAccessibilityDiagnostics();
}

async function persistAccessibilityPreferences(next: AccessibilityPreferences): Promise<void> {
  if (accessibilityBusy) return;
  accessibilityBusy = true;
  accessibilityMessage = "Saving accessibility preferences outside the vault…";
  accessibilityMessageKind = "info";
  renderSettings();
  try {
    applyAccessibilityPreferences(await window.threadleaf.setAccessibilityPreferences(next));
    accessibilityMessage = "Accessibility preferences saved.";
    accessibilityMessageKind = "saved";
  } catch (error) {
    accessibilityMessage = error instanceof Error ? error.message : String(error);
    accessibilityMessageKind = "error";
  } finally {
    accessibilityBusy = false;
    renderSettings();
  }
}

async function resetAccessibilityPreferences(): Promise<void> {
  if (accessibilityBusy) return;
  accessibilityBusy = true;
  accessibilityMessage = "Restoring system defaults…";
  accessibilityMessageKind = "info";
  renderSettings();
  try {
    applyAccessibilityPreferences(await window.threadleaf.resetAccessibilityPreferences());
    accessibilityMessage = "Accessibility preferences reset to system defaults.";
    accessibilityMessageKind = "saved";
  } catch (error) {
    accessibilityMessage = error instanceof Error ? error.message : String(error);
    accessibilityMessageKind = "error";
  } finally {
    accessibilityBusy = false;
    renderSettings();
  }
}

function accessibilityDraftFromControls(): AccessibilityPreferences {
  const preferences = currentAccessibilityPreferences();
  return {
    ...preferences,
    highContrast: accessibilityOverrideFromControl(elements.accessibilityHighContrast.value),
    accent: accessibilityAccentChoices.includes(
      elements.accessibilityAccent.value as AccessibilityAccent,
    )
      ? (elements.accessibilityAccent.value as AccessibilityAccent)
      : preferences.accent,
    uiFontScale: parseAccessibilityNumber(elements.accessibilityUiFontScale.value, "uiFontScale"),
    textFontScale: parseAccessibilityNumber(
      elements.accessibilityTextFontScale.value,
      "textFontScale",
    ),
    editorFontSize: parseAccessibilityNumber(
      elements.accessibilityEditorFontSize.value,
      "editorFontSize",
    ),
    editorLineHeight: parseAccessibilityNumber(
      elements.accessibilityEditorLineHeight.value,
      "editorLineHeight",
    ),
    reducedMotion: accessibilityOverrideFromControl(elements.accessibilityReducedMotion.value),
    reducedTransparency: accessibilityOverrideFromControl(
      elements.accessibilityReducedTransparency.value,
    ),
  };
}

function applyColorScheme(preference: ColorSchemePreference): void {
  const scheme = effectiveColorScheme(preference, systemColorScheme.matches);
  document.documentElement.dataset.theme = scheme;
  for (const target of [document.documentElement, document.body]) {
    target.classList.toggle("theme-light", scheme === "light");
    target.classList.toggle("theme-dark", scheme === "dark");
  }
  const next = scheme === "light" ? "dark" : "light";
  elements.themeLabel.textContent = next === "dark" ? "Dark" : "Light";
  elements.themeToggle.ariaLabel = `Switch to ${next} theme`;
  void window.threadleaf.setPluginSurfaceTheme(scheme).catch(() => undefined);
  setAccessibilityRootAttributes(effectiveCurrentAccessibilityPreferences());
  refreshAccessibilityDiagnostics();
  renderPaletteResults();
}

function applyAppearanceSnapshot(snapshot: AppearanceSnapshot): void {
  if (snapshot.vaultId !== currentSnapshot?.vault.id) {
    return;
  }
  const previousCss = appearanceSnapshot?.css;
  appearanceSnapshot = snapshot;
  if (previousCss !== snapshot.css) {
    applyAppearanceCss(appearanceStyle, snapshot.css);
  }
  applyColorScheme(snapshot.preference.colorScheme);
  const warningKey = snapshot.warnings.join("\n");
  if (warningKey && warningKey !== lastAppearanceWarning) {
    showToast(snapshot.warnings[0] ?? "A custom appearance file could not be applied.");
  }
  lastAppearanceWarning = warningKey;
  refreshAccessibilityDiagnostics();
  renderSettings();
  renderPaletteResults();
}

async function refreshAppearance(successMessage?: string): Promise<void> {
  const vaultId = currentSnapshot?.vault.id;
  if (!vaultId) {
    appearanceSnapshot = null;
    applyAppearanceCss(appearanceStyle, "");
    renderSettings();
    return;
  }
  const request = ++appearanceRequest;
  appearanceBusy = true;
  appearanceMessage = "Scanning .obsidian/themes and .obsidian/snippets…";
  appearanceMessageKind = "info";
  renderSettings();
  renderPaletteResults();
  try {
    const response = await window.threadleaf.getAppearance(vaultId);
    if (request !== appearanceRequest || vaultId !== currentSnapshot?.vault.id) {
      return;
    }
    if (response.status === "stale-vault") {
      appearanceMessage = "The active vault changed before appearance files finished loading.";
      appearanceMessageKind = "info";
      return;
    }
    applyAppearanceSnapshot(response.appearance);
    appearanceMessage =
      successMessage ??
      `${response.appearance.themes.length} themes and ${response.appearance.snippets.length} snippets discovered.`;
    appearanceMessageKind = response.appearance.warnings.length > 0 ? "error" : "saved";
  } catch (error) {
    if (request !== appearanceRequest) {
      return;
    }
    appearanceMessage = error instanceof Error ? error.message : String(error);
    appearanceMessageKind = "error";
  } finally {
    if (request === appearanceRequest) {
      appearanceBusy = false;
      renderSettings();
      renderPaletteResults();
      void maybeMigrateLegacyTheme();
    }
  }
}

async function persistAppearance(
  appearance: VaultAppearanceSettings,
  successMessage: string,
): Promise<boolean> {
  const vaultId = currentSnapshot?.vault.id;
  if (!vaultId || appearanceBusy) {
    return false;
  }
  const request = ++appearanceRequest;
  appearanceBusy = true;
  appearanceMessage = "Saving appearance outside the vault…";
  appearanceMessageKind = "info";
  renderSettings();
  renderPaletteResults();
  try {
    const response = await window.threadleaf.setVaultAppearance(vaultId, appearance);
    if (request !== appearanceRequest || vaultId !== currentSnapshot?.vault.id) {
      return false;
    }
    if (response.status === "stale-vault") {
      appearanceMessage = "The active vault changed before the appearance update completed.";
      appearanceMessageKind = "info";
      return false;
    }
    applySettingsSnapshot(response.settings);
    applyAppearanceSnapshot(response.appearance);
    appearanceMessage = successMessage;
    appearanceMessageKind = response.appearance.warnings.length > 0 ? "error" : "saved";
    return true;
  } catch (error) {
    if (request === appearanceRequest) {
      appearanceMessage = error instanceof Error ? error.message : String(error);
      appearanceMessageKind = "error";
    }
    return false;
  } finally {
    if (request === appearanceRequest) {
      appearanceBusy = false;
      renderSettings();
      renderPaletteResults();
    }
  }
}

async function toggleTheme(): Promise<void> {
  const preference = currentAppearancePreference();
  const current = effectiveColorScheme(preference.colorScheme, systemColorScheme.matches);
  await persistAppearance(
    { ...preference, colorScheme: current === "dark" ? "light" : "dark" },
    `Switched to ${current === "dark" ? "light" : "dark"} mode.`,
  );
}

async function disableCustomAppearance(): Promise<void> {
  const preference = currentAppearancePreference();
  const changed = await persistAppearance(
    { ...preference, themeId: null, enabledSnippetIds: [] },
    "Custom theme and snippets disabled.",
  );
  if (changed) {
    showToast("Custom theme and snippets disabled.");
  }
}

async function maybeMigrateLegacyTheme(): Promise<void> {
  if (legacyThemeMigrationAttempted || !settingsLoaded || appearanceBusy) {
    return;
  }
  const vaultId = currentSnapshot?.vault.id;
  if (!vaultId) {
    return;
  }
  legacyThemeMigrationAttempted = true;
  const storedTheme = localStorage.getItem("threadleaf-theme");
  if (
    (storedTheme !== "light" && storedTheme !== "dark") ||
    settingsSnapshot.settings.appearanceByVault[vaultId]
  ) {
    return;
  }
  const migrated = await persistAppearance(
    { ...createDefaultVaultAppearance(), colorScheme: storedTheme },
    "Previous light or dark preference migrated into app settings.",
  );
  if (migrated) {
    localStorage.removeItem("threadleaf-theme");
  }
}

function applyPluginCatalog(catalog: PluginCatalogSnapshot): void {
  if (catalog.vaultId !== currentSnapshot?.vault.id) {
    return;
  }
  pluginCatalog = catalog;
  pluginStyle.textContent = catalog.css;
  setAccessibilityRootAttributes(effectiveCurrentAccessibilityPreferences());
  const warningKey = catalog.warnings.join("\n");
  if (warningKey && warningKey !== lastPluginWarning) {
    showToast(catalog.warnings[0] ?? "A compatibility plugin needs attention.");
  }
  lastPluginWarning = warningKey;
  refreshAccessibilityDiagnostics();
  renderSettings();
  renderPaletteResults();
}

function runtimePluginWarnings(snapshot: RuntimeSnapshot | null = currentSnapshot): string[] {
  const pluginFailures = (snapshot?.plugins ?? [])
    .filter((plugin) => plugin.error)
    .map((plugin) => `${plugin.name}: ${plugin.error}`);
  const resourceWarnings = (snapshot?.resourceDiagnostics ?? []).map((diagnostic) =>
    resourceDiagnosticWarning(diagnostic),
  );
  return [...pluginFailures, ...resourceWarnings];
}

function resourceDiagnosticWarning(diagnostic: PluginResourceDiagnostic): string {
  const owner = diagnostic.pluginId ? `${diagnostic.pluginId}: ` : "";
  if (diagnostic.reason === "metrics-unavailable") {
    const metric = diagnostic.metric ?? "resource";
    return `${owner}Compatibility ${metric} metrics were unavailable for a sample; no ${metric} enforcement was applied to that sample.`;
  }
  if (diagnostic.reason === "operation-deadline") {
    return `${owner}Compatibility ${diagnostic.operation ?? "operation"} exceeded its ${diagnostic.configuredBudget ?? "configured"} ms deadline (observed ${diagnostic.measuredValue ?? "unknown"} ms).`;
  }
  const metric = diagnostic.metric ?? "resource";
  const unit = diagnostic.unit === "bytes" ? "bytes" : "%";
  return `${owner}Compatibility ${metric} budget breached: ${diagnostic.measuredValue ?? "unknown"} ${unit} measured against ${diagnostic.configuredBudget ?? "configured"} ${unit}.`;
}

async function refreshPlugins(successMessage?: string): Promise<void> {
  const vaultId = currentSnapshot?.vault.id;
  if (!vaultId) {
    pluginCatalog = null;
    pluginStyle.textContent = "";
    renderSettings();
    return;
  }
  const request = ++pluginRequest;
  pluginBusy = true;
  pluginMessage = "Scanning .obsidian/plugins…";
  pluginMessageKind = "info";
  renderSettings();
  renderPaletteResults();
  try {
    const response = await window.threadleaf.getPlugins(vaultId);
    if (request !== pluginRequest || vaultId !== currentSnapshot?.vault.id) {
      return;
    }
    if (response.status === "stale-vault") {
      pluginMessage = "The active vault changed before plugin discovery completed.";
      pluginMessageKind = "info";
      return;
    }
    applyPluginCatalog(response.catalog);
    pluginMessage =
      successMessage ??
      `${response.catalog.plugins.length} installed plugin${response.catalog.plugins.length === 1 ? "" : "s"} discovered.`;
    pluginMessageKind =
      response.catalog.warnings.length > 0 || runtimePluginWarnings().length > 0
        ? "warning"
        : "saved";
  } catch (error) {
    if (request !== pluginRequest) {
      return;
    }
    pluginMessage = pluginIpcErrorMessage(error, "package-inventory-invalid");
    pluginMessageKind = "error";
  } finally {
    if (request === pluginRequest) {
      pluginBusy = false;
      renderSettings();
      renderPaletteResults();
      setActionState(busy);
    }
  }
}

async function updatePlugins(
  operation: (vaultId: string) => ReturnType<typeof window.threadleaf.setCompatibilityMode>,
  progressMessage: string,
  successMessage: string,
): Promise<boolean> {
  const vaultId = currentSnapshot?.vault.id;
  if (!vaultId || pluginBusy) {
    return false;
  }
  const request = ++pluginRequest;
  pluginBusy = true;
  pluginMessage = progressMessage;
  pluginMessageKind = "info";
  renderSettings();
  renderPaletteResults();
  try {
    const response = await operation(vaultId);
    if (request !== pluginRequest || vaultId !== currentSnapshot?.vault.id) {
      return false;
    }
    if (response.status === "stale-vault") {
      pluginMessage = "The active vault changed before the plugin update completed.";
      pluginMessageKind = "info";
      return false;
    }
    applySettingsSnapshot(response.settings);
    render(response.snapshot);
    applyPluginCatalog(response.catalog);
    pluginMessage = successMessage;
    pluginMessageKind =
      response.catalog.warnings.length > 0 || runtimePluginWarnings(response.snapshot).length > 0
        ? "warning"
        : "saved";
    migrationPreview = null;
    void refreshMigrationPreview("Migration preview refreshed after the plugin change.");
    return true;
  } catch (error) {
    if (request === pluginRequest) {
      pluginMessage = pluginIpcErrorMessage(error, "package-operation-failed");
      pluginMessageKind = "error";
    }
    return false;
  } finally {
    if (request === pluginRequest) {
      pluginBusy = false;
      renderSettings();
      renderPaletteResults();
      setActionState(busy);
    }
  }
}

async function setCompatibilityMode(mode: VaultPluginSettings["compatibilityMode"]): Promise<void> {
  const enabled = mode === "enabled";
  const changed = await updatePlugins(
    (vaultId) => window.threadleaf.setCompatibilityMode(vaultId, mode),
    enabled ? "Enabling the trusted compatibility runtime…" : "Unloading community plugins…",
    enabled ? "Community plugin compatibility enabled." : "Restricted mode is active.",
  );
  if (changed) {
    showToast(enabled ? "Community plugins enabled." : "Restricted mode enabled.");
  }
}

async function setPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
  await updatePlugins(
    (vaultId) => window.threadleaf.setPluginEnabled(vaultId, pluginId, enabled),
    `${enabled ? "Enabling" : "Disabling"} ${pluginId}…`,
    `${pluginId} ${enabled ? "enabled" : "disabled"}.`,
  );
}

async function setPluginCapabilityGrant(
  plugin: PluginPackageSummary,
  granted: boolean,
): Promise<boolean> {
  const report = plugin.capabilityReport;
  if (!report) {
    showToast(`${plugin.name} has no reviewable bundle report.`);
    return false;
  }
  const wasSelected = currentPluginPreference().enabledPluginIds.includes(plugin.id);
  const changed = await updatePlugins(
    (vaultId) =>
      window.threadleaf.setPluginCapabilityGrant(vaultId, plugin.id, report.bundleSha256, granted),
    `${granted ? "Granting" : "Revoking"} exact-bundle authority for ${plugin.id}…`,
    granted
      ? wasSelected
        ? `${plugin.id} exact bundle granted. Its saved selection can now load when compatibility mode permits.`
        : `${plugin.id} exact bundle granted. It remains disabled until you enable it.`
      : `${plugin.id} grant revoked and plugin disabled.`,
  );
  if (changed) {
    showToast(
      granted
        ? wasSelected
          ? `${plugin.name} exact bundle granted for its saved selection.`
          : `${plugin.name} exact bundle granted.`
        : `${plugin.name} grant revoked and plugin disabled.`,
    );
  }
  return changed;
}

async function reloadPlugins(): Promise<void> {
  await updatePlugins(
    (vaultId) => window.threadleaf.reloadPlugins(vaultId),
    "Reloading enabled community plugins…",
    "Enabled community plugins reloaded.",
  );
}

function formatPackageBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function packageOperationLabel(
  operation: PluginPackageReview["operation"] | AppearancePackageReview["operation"],
): string {
  return {
    install: "Install",
    update: "Update",
    reinstall: "Reinstall",
    uninstall: "Uninstall",
    rollback: "Roll back",
    restore: "Restore",
  }[operation];
}

function ipcErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': Error: /u, "");
}

function pluginIpcErrorMessage(
  error: unknown,
  code: PluginDiagnosticCode = "package-operation-failed",
): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.replace(/^Error invoking remote method '[^']+': Error: /u, "");
  // IPC errors are not trusted renderer content. Main-process catalog handlers attach the
  // stable diagnostic already; an unexpected/raw value gets the same bounded fallback.
  return parsePluginDiagnosticMessage(normalized)?.message ?? pluginDiagnosticMessage(code);
}

async function searchOpenPluginIndex(): Promise<void> {
  const vaultId = currentSnapshot?.vault.id;
  if (!vaultId || pluginBusy) {
    return;
  }
  const request = ++pluginPackageRequest;
  pluginBusy = true;
  pluginMessage = "Reading the community package index…";
  pluginMessageKind = "info";
  renderSettings();
  try {
    const response = await window.threadleaf.searchPluginPackages(
      vaultId,
      elements.pluginIndexQuery.value,
    );
    if (request !== pluginPackageRequest || vaultId !== currentSnapshot?.vault.id) {
      return;
    }
    if (response.status === "stale-vault") {
      pluginMessage = "The active vault changed before the registry search completed.";
      return;
    }
    pluginPackageIndex = response.index;
    pluginMessage = `${response.index.results.length} registry result${response.index.results.length === 1 ? "" : "s"} ready for metadata review.`;
    pluginMessageKind = "saved";
  } catch (error) {
    if (request === pluginPackageRequest) {
      pluginMessage = pluginIpcErrorMessage(error, "registry-index-invalid");
      pluginMessageKind = "error";
    }
  } finally {
    if (request === pluginPackageRequest) {
      pluginBusy = false;
      renderSettings();
      renderPaletteResults();
    }
  }
}

function appendDefinitionListFact(container: HTMLElement, label: string, value: string): void {
  const term = document.createElement("dt");
  term.textContent = label;
  const description = document.createElement("dd");
  description.textContent = value;
  container.append(term, description);
}

function appendPackageFact(label: string, value: string): void {
  appendDefinitionListFact(elements.pluginPackageFacts, label, value);
}

function openPluginAuthorityReview(plugin: PluginPackageSummary): void {
  const report = plugin.capabilityReport;
  if (!report || plugin.packageState !== "ready") {
    showToast(`${plugin.name} does not have a valid reviewable bundle.`);
    return;
  }
  pluginAuthorityReview = plugin;
  pluginAuthorityRestoreFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  elements.pluginAuthorityReviewTitle.textContent = plugin.name;
  elements.pluginAuthorityReviewSummary.textContent =
    report.capabilities.length === 0
      ? "The scanner found no known authority references in this exact bundle. That is not proof that the plugin has no authority."
      : `The scanner found ${report.capabilities.length} authority class${report.capabilities.length === 1 ? "" : "es"} in this exact bundle. Review each reference before granting it for this vault.`;
  elements.pluginAuthorityReviewFacts.replaceChildren();
  appendDefinitionListFact(elements.pluginAuthorityReviewFacts, "Plugin", plugin.id);
  appendDefinitionListFact(elements.pluginAuthorityReviewFacts, "Version", plugin.version);
  appendDefinitionListFact(
    elements.pluginAuthorityReviewFacts,
    "Scanner",
    "Threadleaf static authority scan v1",
  );
  appendDefinitionListFact(
    elements.pluginAuthorityReviewFacts,
    "main.js SHA-256",
    report.bundleSha256,
  );
  elements.pluginAuthorityReviewList.replaceChildren();
  if (report.findings.length === 0) {
    const empty = document.createElement("p");
    empty.className = "plugin-authority-review-empty";
    empty.textContent = "◇ No known authority references observed";
    elements.pluginAuthorityReviewList.append(empty);
  } else {
    for (const finding of report.findings) {
      const definition = pluginCapabilityDefinitions[finding.capability];
      const item = document.createElement("article");
      item.className = "plugin-authority-review-item";
      const heading = document.createElement("strong");
      heading.textContent = `◇ ${definition.label}`;
      const description = document.createElement("p");
      description.textContent = definition.description;
      const evidence = document.createElement("small");
      evidence.textContent = `Observed: ${finding.evidence.join("; ")}`;
      item.append(heading, description, evidence);
      elements.pluginAuthorityReviewList.append(item);
    }
  }
  elements.pluginAuthorityReviewError.hidden = true;
  elements.pluginAuthorityReviewError.textContent = "";
  elements.pluginAuthorityReviewGrant.disabled = readOnlyVault() || pluginBusy;
  elements.pluginAuthorityReviewGrant.textContent = "Grant exact bundle";
  elements.pluginAuthorityReviewCancel.disabled = false;
  elements.pluginAuthorityReviewClose.disabled = false;
  if (!elements.pluginAuthorityReviewDialog.open) {
    elements.pluginAuthorityReviewDialog.showModal();
  }
  elements.pluginAuthorityReviewClose.focus();
}

function closePluginAuthorityReview(restoreFocus = true): void {
  if (!elements.pluginAuthorityReviewDialog.open || pluginBusy) {
    return;
  }
  pluginAuthorityReview = null;
  elements.pluginAuthorityReviewDialog.close();
  const restoreTarget = pluginAuthorityRestoreFocus;
  pluginAuthorityRestoreFocus = null;
  if (restoreFocus && restoreTarget?.isConnected) {
    restoreTarget.focus();
  }
}

async function applyPluginAuthorityReview(): Promise<void> {
  const plugin = pluginAuthorityReview;
  if (!plugin || pluginBusy) {
    return;
  }
  elements.pluginAuthorityReviewGrant.disabled = true;
  elements.pluginAuthorityReviewCancel.disabled = true;
  elements.pluginAuthorityReviewClose.disabled = true;
  elements.pluginAuthorityReviewError.hidden = true;
  const changed = await setPluginCapabilityGrant(plugin, true);
  if (changed) {
    pluginAuthorityReview = null;
    elements.pluginAuthorityReviewDialog.close();
    const restoreTarget = pluginAuthorityRestoreFocus;
    pluginAuthorityRestoreFocus = null;
    if (restoreTarget?.isConnected) {
      restoreTarget.focus();
    }
    return;
  }
  elements.pluginAuthorityReviewError.textContent =
    pluginMessageKind === "error" ? pluginMessage : "The exact-bundle grant was not changed.";
  elements.pluginAuthorityReviewError.hidden = false;
  elements.pluginAuthorityReviewGrant.disabled = readOnlyVault();
  elements.pluginAuthorityReviewCancel.disabled = false;
  elements.pluginAuthorityReviewClose.disabled = false;
}

function openPluginPackageReview(review: PluginPackageReview): void {
  pluginPackageReview = review;
  pluginPackageRestoreFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  elements.pluginPackageReviewOperation.textContent = `${packageOperationLabel(review.operation)} review`;
  elements.pluginPackageReviewTitle.textContent = review.manifest?.name ?? review.pluginId;
  elements.pluginPackageReviewSummary.textContent =
    review.operation === "uninstall"
      ? `Remove ${review.pluginId} ${review.installedVersion ?? ""} after retaining a recoverable snapshot.`
      : `${packageOperationLabel(review.operation)} ${review.pluginId} from ${review.installedVersion ?? "not installed"} to ${review.targetVersion ?? "removed"}.`;
  elements.pluginPackageFacts.replaceChildren();
  appendPackageFact("Plugin", review.pluginId);
  appendPackageFact("Current", review.installedVersion ?? "Not installed");
  appendPackageFact("Target", review.targetVersion ?? "Removed");
  appendPackageFact("Repository", review.repository ?? "Local retained package");
  appendPackageFact("Review expires", new Date(review.expiresAt).toLocaleString());
  if (review.indexSha256) {
    appendPackageFact("Index SHA-256", review.indexSha256);
  }

  elements.pluginPackageAssets.replaceChildren();
  if (review.assets.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "No new executable asset will be installed.";
    elements.pluginPackageAssets.append(empty);
  } else {
    for (const asset of review.assets) {
      const row = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = asset.filename;
      const size = document.createElement("span");
      size.textContent = formatPackageBytes(asset.size);
      const hash = document.createElement("code");
      hash.textContent = asset.sha256;
      row.append(name, size, hash);
      elements.pluginPackageAssets.append(row);
    }
  }
  elements.pluginPackageLicense.textContent = review.license
    ? `${review.license.spdxId} · ${review.license.name} · ${formatPackageBytes(review.license.size)} · SHA-256 ${review.license.sha256}`
    : review.operation === "uninstall"
      ? "The existing directory is retained byte-for-byte in rollback history."
      : "No retained license is available for this local rollback snapshot.";
  elements.pluginPackageWarnings.replaceChildren();
  for (const warning of review.warnings) {
    const item = document.createElement("li");
    item.textContent = warning;
    elements.pluginPackageWarnings.append(item);
  }
  elements.pluginPackageReviewError.hidden = true;
  elements.pluginPackageReviewError.textContent = "";
  elements.pluginPackageReviewApply.disabled = readOnlyVault();
  elements.pluginPackageReviewCancel.disabled = false;
  elements.pluginPackageReviewClose.disabled = false;
  if (!elements.pluginPackageReviewDialog.open) {
    elements.pluginPackageReviewDialog.showModal();
  }
  elements.pluginPackageReviewClose.focus();
}

async function previewPluginPackage(requestValue: PluginPackagePreviewRequest): Promise<void> {
  const vaultId = currentSnapshot?.vault.id;
  if (!vaultId || pluginBusy) {
    return;
  }
  const request = ++pluginPackageRequest;
  pluginBusy = true;
  pluginMessage = `Preparing an exact ${requestValue.action} review for ${requestValue.pluginId}…`;
  pluginMessageKind = "info";
  renderSettings();
  try {
    const response = await window.threadleaf.previewPluginPackage(vaultId, requestValue);
    if (request !== pluginPackageRequest || vaultId !== currentSnapshot?.vault.id) {
      return;
    }
    if (response.status === "stale-vault") {
      pluginMessage = "The active vault changed before package review completed.";
      return;
    }
    pluginMessage = `${packageOperationLabel(response.review.operation)} review is ready. No vault bytes changed.`;
    pluginMessageKind = response.review.warnings.length > 0 ? "warning" : "saved";
    openPluginPackageReview(response.review);
  } catch (error) {
    if (request === pluginPackageRequest) {
      pluginMessage = pluginIpcErrorMessage(error, "package-operation-failed");
      pluginMessageKind = "error";
    }
  } finally {
    if (request === pluginPackageRequest) {
      pluginBusy = false;
      renderSettings();
      renderPaletteResults();
    }
  }
}

async function closePluginPackageReview(restoreFocus = true): Promise<void> {
  const review = pluginPackageReview;
  if (!elements.pluginPackageReviewDialog.open || pluginBusy) {
    return;
  }
  pluginPackageReview = null;
  elements.pluginPackageReviewDialog.close();
  if (review && currentSnapshot?.vault.id === review.vaultId) {
    await window.threadleaf
      .cancelPluginPackageReview(review.vaultId, review.reviewId)
      .catch(() => undefined);
  }
  const restoreTarget = pluginPackageRestoreFocus;
  pluginPackageRestoreFocus = null;
  if (restoreFocus && restoreTarget?.isConnected) {
    restoreTarget.focus();
  }
}

async function applyPluginPackageReview(): Promise<void> {
  const review = pluginPackageReview;
  const vaultId = currentSnapshot?.vault.id;
  if (!review || !vaultId || review.vaultId !== vaultId || pluginBusy) {
    return;
  }
  if (readOnlyVault()) {
    showToast("Open a local vault before changing plugin packages.");
    return;
  }
  const request = ++pluginPackageRequest;
  pluginBusy = true;
  elements.pluginPackageReviewApply.disabled = true;
  elements.pluginPackageReviewCancel.disabled = true;
  elements.pluginPackageReviewClose.disabled = true;
  elements.pluginPackageReviewError.hidden = true;
  pluginMessage = `Applying the reviewed ${review.operation} while keeping ${review.pluginId} disabled…`;
  pluginMessageKind = "info";
  renderSettings();
  try {
    const response = await window.threadleaf.applyPluginPackage(vaultId, review.reviewId);
    if (request !== pluginPackageRequest || vaultId !== currentSnapshot?.vault.id) {
      return;
    }
    if (response.status === "stale-vault") {
      throw new Error("The active vault changed before the reviewed package could be applied.");
    }
    applySettingsSnapshot(response.settings);
    render(response.snapshot);
    applyPluginCatalog(response.catalog);
    pluginPackageIndex = null;
    pluginPackageReview = null;
    pluginAuthorityReview = null;
    elements.pluginPackageReviewDialog.close();
    pluginMessage = `${response.outcome.pluginId} ${response.outcome.operation} completed and remains disabled.`;
    pluginMessageKind = response.catalog.warnings.length > 0 ? "warning" : "saved";
    showToast(`${response.outcome.pluginId} ${response.outcome.operation} completed disabled.`);
    migrationPreview = null;
    void refreshMigrationPreview("Migration preview refreshed after the package change.");
  } catch (error) {
    if (request === pluginPackageRequest) {
      const message = `${pluginIpcErrorMessage(error, "package-operation-failed")} Review the exact package again before another apply.`;
      pluginPackageReview = null;
      pluginMessage = message;
      pluginMessageKind = "error";
      elements.pluginPackageReviewError.textContent = message;
      elements.pluginPackageReviewError.hidden = false;
    }
  } finally {
    if (request === pluginPackageRequest) {
      pluginBusy = false;
      if (pluginPackageReview) {
        elements.pluginPackageReviewApply.disabled = readOnlyVault();
        elements.pluginPackageReviewCancel.disabled = false;
        elements.pluginPackageReviewClose.disabled = false;
      } else if (elements.pluginPackageReviewDialog.open) {
        elements.pluginPackageReviewApply.disabled = true;
        elements.pluginPackageReviewCancel.disabled = false;
        elements.pluginPackageReviewClose.disabled = false;
      }
      renderSettings();
      renderPaletteResults();
    }
  }
}

async function refreshMigrationPreview(
  successMessage?: string,
  successKind?: "saved" | "warning",
  preserveMutation = false,
): Promise<void> {
  if (!preserveMutation) {
    // A refresh supersedes any response still in flight. The response gate below
    // keeps that old operation from clearing the new preview or its selection.
    migrationMutationRequest += 1;
    migrationApplyBusy = false;
  }
  const vaultId = currentSnapshot?.vault.id;
  if (!vaultId) {
    migrationPreview = null;
    migrationPlan = null;
    migrationSelection = new Set();
    migrationLastTransactionId = null;
    migrationMessage = "Open a writable vault to inspect existing Obsidian behavior.";
    migrationMessageKind = "info";
    renderSettings();
    return;
  }
  const request = ++migrationRequest;
  migrationBusy = true;
  migrationPreview = null;
  migrationPlan = null;
  migrationSelection = new Set();
  migrationMessage = "Reading bounded .obsidian metadata without changing it…";
  migrationMessageKind = "info";
  renderSettings();
  try {
    const response = await window.threadleaf.getMigrationPreview(vaultId);
    if (request !== migrationRequest || vaultId !== currentSnapshot?.vault.id) {
      return;
    }
    if (response.status === "stale-vault") {
      migrationMessage = "The active vault changed before the migration preview completed.";
      migrationMessageKind = "info";
      return;
    }
    migrationPreview = response.preview;
    migrationPlan = response.plan;
    migrationLastTransactionId = response.rollbackTransactionId;
    migrationSelection = new Set();
    migrationMessage =
      successMessage ??
      (response.preview.detected
        ? "Review the checked candidates before applying private Threadleaf state."
        : "No Obsidian behavior metadata was found. Nothing was changed.");
    migrationMessageKind =
      successKind ?? (response.preview.warnings.length > 0 ? "warning" : "saved");
  } catch (error) {
    if (request !== migrationRequest) {
      return;
    }
    migrationMessage = error instanceof Error ? error.message : String(error);
    migrationMessageKind = "error";
  } finally {
    if (request === migrationRequest) {
      migrationBusy = false;
      renderSettings();
    }
  }
}

async function applyMigrationReview(): Promise<void> {
  const vaultId = currentSnapshot?.vault.id;
  const plan = migrationPlan?.vaultId === vaultId ? migrationPlan : null;
  if (migrationBusy || migrationApplyBusy || !vaultId || !plan || migrationSelection.size === 0) {
    return;
  }
  const requestId = migrationRequest;
  const mutationRequest = ++migrationMutationRequest;
  const operation = {
    kind: "apply" as const,
    requestId,
    vaultId,
    planId: plan.planId,
  };
  const currentIdentity = (): MigrationReviewIdentityState => ({
    requestId: migrationRequest,
    vaultId: currentSnapshot?.vault.id ?? null,
    planId: migrationPlan?.planId ?? null,
    transactionId: migrationLastTransactionId,
  });
  const currentMutation = (): boolean =>
    mutationRequest === migrationMutationRequest && vaultId === currentSnapshot?.vault.id;
  migrationApplyBusy = true;
  migrationMessage = "Applying the reviewed private-state transaction…";
  migrationMessageKind = "info";
  renderSettings();
  try {
    const response = await window.threadleaf.applyMigration(vaultId, {
      planId: plan.planId,
      sourceDigest: plan.sourceDigest,
      selectedItemIds: [...migrationSelection],
    });
    if (!migrationReviewOperationIsCurrent(operation, currentIdentity())) {
      return;
    }
    if (response.status === "stale-vault") {
      migrationMessage = "The active vault changed before migration apply completed.";
      migrationMessageKind = "info";
      return;
    }
    migrationLastTransactionId = response.outcome.transactionId;
    migrationMessage = `Private state committed for ${response.outcome.selectedItemIds.length} reviewed item${response.outcome.selectedItemIds.length === 1 ? "" : "s"}. Before and after state were retained for rollback.${response.runtimeWarning ? ` ${response.runtimeWarning}` : ""}`;
    migrationMessageKind = response.runtimeWarning ? "warning" : "saved";
    migrationSelection = new Set();
    await refreshMigrationPreview(migrationMessage, migrationMessageKind, true);
  } catch (error) {
    if (!migrationReviewOperationIsCurrent(operation, currentIdentity())) {
      return;
    }
    migrationPlan = null;
    migrationSelection = new Set();
    migrationMessage = error instanceof Error ? error.message : String(error);
    migrationMessageKind = "error";
  } finally {
    if (currentMutation()) {
      migrationApplyBusy = false;
      renderSettings();
    }
  }
}

async function rollbackMigrationReview(): Promise<void> {
  const vaultId = currentSnapshot?.vault.id;
  if (migrationBusy || migrationApplyBusy || !vaultId || !migrationLastTransactionId) {
    return;
  }
  const requestId = migrationRequest;
  const transactionId = migrationLastTransactionId;
  const mutationRequest = ++migrationMutationRequest;
  const operation = {
    kind: "rollback" as const,
    requestId,
    vaultId,
    transactionId,
  };
  const currentIdentity = (): MigrationReviewIdentityState => ({
    requestId: migrationRequest,
    vaultId: currentSnapshot?.vault.id ?? null,
    planId: migrationPlan?.planId ?? null,
    transactionId: migrationLastTransactionId,
  });
  const currentMutation = (): boolean =>
    mutationRequest === migrationMutationRequest && vaultId === currentSnapshot?.vault.id;
  migrationApplyBusy = true;
  migrationMessage = "Checking the private-state receipt before rollback…";
  migrationMessageKind = "info";
  renderSettings();
  try {
    const response = await window.threadleaf.rollbackMigration(vaultId, transactionId);
    if (!migrationReviewOperationIsCurrent(operation, currentIdentity())) {
      return;
    }
    if (response.status === "stale-vault") {
      migrationMessage = "The active vault changed before rollback completed.";
      migrationMessageKind = "info";
      return;
    }
    if (response.status === "conflict") {
      migrationMessage = response.outcome.message;
      migrationMessageKind = "warning";
      return;
    }
    migrationLastTransactionId = null;
    migrationSelection = new Set();
    migrationMessage = `Rollback committed. Newer private changes were not overwritten.${response.runtimeWarning ? ` ${response.runtimeWarning}` : ""}`;
    migrationMessageKind = response.runtimeWarning ? "warning" : "saved";
    await refreshMigrationPreview(migrationMessage, migrationMessageKind, true);
  } catch (error) {
    if (!migrationReviewOperationIsCurrent(operation, currentIdentity())) {
      return;
    }
    migrationPlan = null;
    migrationSelection = new Set();
    migrationMessage = error instanceof Error ? error.message : String(error);
    migrationMessageKind = "error";
  } finally {
    if (currentMutation()) {
      migrationApplyBusy = false;
      renderSettings();
    }
  }
}

function appendMigrationEmpty(target: HTMLElement, message: string): void {
  const empty = document.createElement("p");
  empty.className = "migration-empty";
  empty.textContent = message;
  target.append(empty);
}

function migrationBadge(text: string, state: string): HTMLSpanElement {
  const badge = document.createElement("span");
  badge.className = "migration-badge";
  badge.dataset.state = state;
  badge.textContent = text;
  return badge;
}

function formatMigrationBytes(byteLength: number | null): string {
  if (byteLength === null) {
    return "No file";
  }
  if (byteLength < 1024) {
    return `${byteLength} B`;
  }
  if (byteLength < 1024 * 1024) {
    return `${(byteLength / 1024).toFixed(byteLength < 10 * 1024 ? 1 : 0)} KiB`;
  }
  return `${(byteLength / (1024 * 1024)).toFixed(1)} MiB`;
}

function appendMigrationFact(target: HTMLElement, label: string, value: string): void {
  const row = document.createElement("span");
  row.className = "migration-fact";
  const term = document.createElement("small");
  term.textContent = label;
  const detail = document.createElement("strong");
  detail.textContent = value;
  row.append(term, detail);
  target.append(row);
}

function migrationCandidateStatus(candidate: MigrationCandidate): string {
  switch (candidate.status) {
    case "ready":
      return "Ready";
    case "review":
      return "Review required";
    case "unsupported":
      return "Unsupported";
    case "missing":
      return "Missing package";
    case "conflict":
      return "Conflict";
  }
}

function migrationSafeValue(value: string | null): string {
  return value === null ? "Not set" : value;
}

function renderMigrationReview(): void {
  elements.migrationCandidateList.replaceChildren();
  const plan = migrationPlan?.vaultId === currentSnapshot?.vault.id ? migrationPlan : null;
  const selectedCount = plan
    ? [...migrationSelection].filter((id) =>
        plan.candidates.some((candidate) => candidate.id === id),
      ).length
    : 0;
  elements.migrationReviewSummary.textContent = plan
    ? `${plan.candidates.filter((candidate) => candidate.status === "ready").length} ready · ${selectedCount} selected · source receipt ${plan.sourceDigest.slice(0, 12)}`
    : "No reviewed plan is ready.";
  elements.migrationReviewReceipt.textContent = migrationLastTransactionId
    ? `Transaction ${migrationLastTransactionId.slice(0, 12)}`
    : "No transaction";
  elements.migrationReviewReceipt.dataset.planId = plan?.planId ?? "";
  elements.migrationApply.disabled =
    migrationBusy ||
    migrationApplyBusy ||
    readOnlyVault() ||
    !plan ||
    selectedCount === 0 ||
    !currentSnapshot?.vault.id;
  elements.migrationRollback.disabled =
    migrationBusy || migrationApplyBusy || !migrationLastTransactionId || !plan;
  elements.migrationApplyStatus.textContent = migrationApplyBusy
    ? "Writing only private Threadleaf state. The vault and .obsidian files remain untouched."
    : migrationMessageKind === "error" || migrationMessageKind === "warning"
      ? migrationMessage
      : "";
  elements.migrationApplyStatus.dataset.kind = migrationMessageKind;
  if (!plan) {
    appendMigrationEmpty(
      elements.migrationCandidateList,
      "Refresh to create an exact reviewed plan.",
    );
    return;
  }
  if (plan.candidates.length === 0) {
    appendMigrationEmpty(
      elements.migrationCandidateList,
      "No behavior candidates are available for review.",
    );
    return;
  }
  for (const candidate of plan.candidates) {
    const row = document.createElement("label");
    row.className = "migration-candidate";
    row.dataset.candidateId = candidate.id;
    row.dataset.state = candidate.status;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.candidateId = candidate.id;
    checkbox.checked = migrationSelection.has(candidate.id);
    checkbox.disabled = migrationBusy || migrationApplyBusy || candidate.status !== "ready";
    checkbox.ariaLabel = `Select ${candidate.label}`;
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        migrationSelection.add(candidate.id);
      } else {
        migrationSelection.delete(candidate.id);
      }
      renderMigrationReview();
      const replacement = [...elements.migrationCandidateList.querySelectorAll("input")].find(
        (input) => input.dataset.candidateId === candidate.id,
      );
      replacement?.focus();
    });
    const copy = document.createElement("span");
    copy.className = "migration-candidate-copy";
    const label = document.createElement("strong");
    label.textContent = candidate.label;
    const message = document.createElement("small");
    message.textContent = candidate.message;
    const diff = document.createElement("small");
    diff.className = "migration-candidate-diff";
    diff.textContent = `Before: ${migrationSafeValue(candidate.before)} · After: ${migrationSafeValue(candidate.after)}`;
    copy.append(label, message, diff);
    row.append(
      checkbox,
      copy,
      migrationBadge(migrationCandidateStatus(candidate), candidate.status),
    );
    elements.migrationCandidateList.append(row);
  }
}

function renderMigrationSettings(): void {
  const vaultId = currentSnapshot?.vault.id ?? null;
  const preview = migrationPreview?.vaultId === vaultId ? migrationPreview : null;
  elements.migrationRefresh.disabled = migrationBusy || migrationApplyBusy || !vaultId;
  elements.migrationState.textContent = migrationBusy
    ? "Scanning"
    : preview?.detected
      ? "Detected"
      : preview
        ? "No state"
        : "Not scanned";
  elements.migrationState.dataset.state = migrationBusy
    ? "safe"
    : preview?.detected
      ? "active"
      : "default";

  for (const target of [
    elements.migrationOverview,
    elements.migrationSourceList,
    elements.migrationPluginList,
    elements.migrationHotkeyList,
    elements.migrationAppearance,
    elements.migrationWorkspace,
    elements.migrationWarnings,
  ]) {
    target.replaceChildren();
  }
  renderMigrationReview();

  if (!preview) {
    appendMigrationEmpty(
      elements.migrationOverview,
      migrationBusy
        ? "Inspecting known metadata files and plugin setting shapes…"
        : "Refresh to build a read-only behavior migration preview.",
    );
    appendMigrationEmpty(elements.migrationSourceList, "Source files have not been scanned.");
    appendMigrationEmpty(elements.migrationPluginList, "Plugin inventory has not been scanned.");
    appendMigrationEmpty(elements.migrationHotkeyList, "Hotkey overrides have not been scanned.");
    appendMigrationEmpty(elements.migrationAppearance, "Appearance has not been scanned.");
    appendMigrationEmpty(elements.migrationWorkspace, "Workspace layout has not been scanned.");
    return;
  }

  const overviewCards = [
    [
      String(preview.plugins.filter((plugin) => plugin.enabledInObsidian).length),
      "enabled Obsidian plugins",
    ],
    [
      String(preview.plugins.filter((plugin) => plugin.settings.state === "shared").length),
      "settings files shared in place",
    ],
    [
      String(preview.hotkeys.filter((hotkey) => hotkey.state === "ready").length),
      "reviewed hotkey candidates",
    ],
    [String(preview.workspace.restorablePaths.length), "restorable workspace tabs"],
  ] as const;
  for (const [value, label] of overviewCards) {
    const card = document.createElement("span");
    card.className = "migration-overview-card";
    const count = document.createElement("strong");
    count.textContent = value;
    const copy = document.createElement("small");
    copy.textContent = label;
    card.append(count, copy);
    elements.migrationOverview.append(card);
  }

  const sourceLabels = {
    ready: "◆ Read",
    absent: "◇ Absent",
    invalid: "× Invalid",
    oversized: "△ Too large",
  } as const;
  for (const source of preview.sources) {
    const row = document.createElement("span");
    row.className = "migration-row migration-source-row";
    const copy = document.createElement("span");
    const sourcePath = document.createElement("code");
    sourcePath.textContent = source.path;
    const detail = document.createElement("small");
    detail.textContent = source.message ?? formatMigrationBytes(source.byteLength);
    copy.append(sourcePath, detail);
    row.append(copy, migrationBadge(sourceLabels[source.state], source.state));
    elements.migrationSourceList.append(row);
  }

  for (const plugin of preview.plugins) {
    const row = document.createElement("article");
    row.className = "migration-row migration-plugin-row";
    row.dataset.packageState = plugin.packageState;
    const copy = document.createElement("span");
    const nameLine = document.createElement("span");
    nameLine.className = "migration-name-line";
    const name = document.createElement("strong");
    name.textContent = plugin.name;
    const identity = document.createElement("code");
    identity.textContent = plugin.version ? `${plugin.id} · ${plugin.version}` : plugin.id;
    nameLine.append(name, identity);
    const detail = document.createElement("small");
    detail.textContent = plugin.message;
    const settings = document.createElement("small");
    settings.className = "migration-private-shape";
    settings.textContent =
      plugin.settings.state === "shared"
        ? `Settings shape: ${plugin.settings.rootKind}, ${plugin.settings.topLevelEntryCount ?? 0} top-level entries, ${formatMigrationBytes(plugin.settings.byteLength)}. Values are hidden.`
        : plugin.settings.message;
    copy.append(nameLine, detail, settings);
    const badges = document.createElement("span");
    badges.className = "migration-badges";
    badges.append(
      migrationBadge(
        plugin.enabledInObsidian ? "◆ Enabled in Obsidian" : "◇ Installed only",
        plugin.enabledInObsidian ? "ready" : "absent",
      ),
      migrationBadge(
        plugin.packageState === "ready"
          ? "◆ Package valid"
          : plugin.packageState === "missing"
            ? "× Package missing"
            : "× Package invalid",
        plugin.packageState === "ready" ? "ready" : "invalid",
      ),
    );
    if (plugin.selectedInThreadleaf) {
      badges.append(migrationBadge("◆ Selected in Threadleaf", "selected"));
    }
    if (plugin.compatibility) {
      badges.append(
        migrationBadge(
          plugin.compatibility.status === "verified"
            ? `◆ Exact L${plugin.compatibility.level}`
            : plugin.compatibility.status === "different-version"
              ? "△ Version untested"
              : "◇ Workflow unverified",
          plugin.compatibility.status,
        ),
      );
    }
    row.append(copy, badges);
    elements.migrationPluginList.append(row);
  }
  if (preview.plugins.length === 0) {
    appendMigrationEmpty(
      elements.migrationPluginList,
      "No installed or enabled community plugins were found.",
    );
  }

  for (const hotkey of preview.hotkeys) {
    const row = document.createElement("span");
    row.className = "migration-row migration-hotkey-row";
    const copy = document.createElement("span");
    const identity = document.createElement("code");
    identity.textContent = hotkey.commandId;
    const binding = document.createElement("strong");
    binding.textContent = hotkey.bindings.join(" or ") || "No binding";
    const detail = document.createElement("small");
    detail.textContent = hotkey.message;
    copy.append(identity, binding, detail);
    row.append(
      copy,
      migrationBadge(
        hotkey.state === "ready" ? "◆ Candidate ready" : "△ Review required",
        hotkey.state,
      ),
    );
    elements.migrationHotkeyList.append(row);
  }
  if (preview.hotkeys.length === 0) {
    appendMigrationEmpty(elements.migrationHotkeyList, "No Obsidian hotkey overrides were found.");
  }

  appendMigrationFact(
    elements.migrationAppearance,
    "Base scheme",
    preview.appearance.colorSchemeCandidate
      ? `${preview.appearance.sourceColorScheme ?? "Default"} → ${preview.appearance.colorSchemeCandidate}`
      : preview.appearance.sourceColorScheme
        ? `${preview.appearance.sourceColorScheme} needs review`
        : "No override",
  );
  appendMigrationFact(
    elements.migrationAppearance,
    "Community theme",
    preview.appearance.sourceThemeName
      ? preview.appearance.themeAvailable
        ? `${preview.appearance.sourceThemeName} is available`
        : `${preview.appearance.sourceThemeName} is missing`
      : "No selection",
  );
  appendMigrationFact(
    elements.migrationAppearance,
    "CSS snippets",
    `${preview.appearance.snippetIdsCandidate.length} available · ${preview.appearance.missingSnippetNames.length} missing`,
  );

  appendMigrationFact(
    elements.migrationWorkspace,
    "Layout source",
    preview.workspace.sourcePath ?? "No workspace file",
  );
  appendMigrationFact(
    elements.migrationWorkspace,
    "Note tabs",
    `${preview.workspace.restorablePaths.length} restorable · ${preview.workspace.missingPaths.length} missing`,
  );
  appendMigrationFact(
    elements.migrationWorkspace,
    "Active note",
    preview.workspace.activePath ?? "No restorable active tab",
  );
  appendMigrationFact(
    elements.migrationWorkspace,
    "Other views",
    preview.workspace.unsupportedViewTypes.length > 0
      ? preview.workspace.unsupportedViewTypes
          .map((view) => `${view.type} ×${view.count}`)
          .join(" · ")
      : "None detected",
  );

  for (const warning of preview.warnings) {
    const item = document.createElement("li");
    item.textContent = warning;
    elements.migrationWarnings.append(item);
  }
  renderMigrationReview();
}

function packageActionButton(
  label: string,
  ariaLabel: string,
  request: PluginPackagePreviewRequest,
  disabled: boolean,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary-button plugin-package-action";
  button.textContent = label;
  button.ariaLabel = ariaLabel;
  button.disabled = disabled;
  button.addEventListener("click", () => void previewPluginPackage(request));
  return button;
}

function renderOpenPluginIndex(vaultId: string | null, disabled: boolean): void {
  const index = pluginPackageIndex?.vaultId === vaultId ? pluginPackageIndex : null;
  elements.pluginIndexQuery.disabled = disabled;
  elements.pluginIndexSearch.disabled = disabled;
  elements.pluginIndexSearch.textContent = pluginBusy ? "Working…" : "Search index";
  elements.pluginIndexSource.textContent = index
    ? `Verified ${index.sourceSha256.slice(0, 12)}…`
    : "Not loaded";
  elements.pluginIndexSource.title = index
    ? `${index.sourceUrl}\nSHA-256 ${index.sourceSha256}`
    : "Search to read the community package index.";
  elements.pluginIndexList.replaceChildren();
  if (!index) {
    const empty = document.createElement("p");
    empty.className = "plugin-empty";
    empty.textContent = readOnlyVault()
      ? "Open a local vault to review and install plugin packages."
      : "Search the community package index to review installable packages.";
    elements.pluginIndexList.append(empty);
    return;
  }
  for (const plugin of index.results) {
    const row = document.createElement("article");
    row.className = "plugin-index-row";
    row.dataset.pluginId = plugin.id;
    const copy = document.createElement("span");
    copy.className = "plugin-copy";
    const nameLine = document.createElement("span");
    nameLine.className = "plugin-name-line";
    const name = document.createElement("strong");
    name.textContent = plugin.name;
    const id = document.createElement("code");
    id.textContent = plugin.id;
    nameLine.append(name, id);
    const description = document.createElement("small");
    description.textContent = plugin.description;
    const source = document.createElement("small");
    source.className = "plugin-author";
    source.textContent = `${plugin.author} · ${plugin.repository}`;
    copy.append(nameLine, description, source);
    const state = document.createElement("span");
    state.className = "plugin-index-state";
    state.textContent = plugin.installedVersion
      ? `Installed ${plugin.installedVersion}${plugin.managed ? " · managed" : ""}`
      : "Not installed";
    const review = packageActionButton(
      plugin.installedVersion ? "Review update" : "Review install",
      `${plugin.installedVersion ? "Review an update for" : "Review installation of"} ${plugin.name}`,
      { action: "install", pluginId: plugin.id },
      disabled,
    );
    const controls = document.createElement("span");
    controls.className = "plugin-index-controls";
    controls.append(state, review);
    row.append(copy, controls);
    elements.pluginIndexList.append(row);
  }
  if (index.results.length === 0) {
    const empty = document.createElement("p");
    empty.className = "plugin-empty";
    empty.textContent = `No indexed plugins match “${index.query}”.`;
    elements.pluginIndexList.append(empty);
  }
}

function renderRemovedPackages(
  managedPackages: ManagedPluginPackageSummary[],
  disabled: boolean,
): void {
  const removed = managedPackages.filter(
    (managed) => managed.currentVersion === null && managed.history.length > 0,
  );
  elements.pluginRemovedPanel.hidden = removed.length === 0;
  elements.pluginRemovedList.replaceChildren();
  for (const managed of removed) {
    const row = document.createElement("article");
    row.className = "plugin-row plugin-removed-row";
    row.dataset.pluginId = managed.pluginId;
    const copy = document.createElement("span");
    copy.className = "plugin-copy";
    const nameLine = document.createElement("span");
    nameLine.className = "plugin-name-line";
    const name = document.createElement("strong");
    name.textContent = managed.pluginId;
    const version = document.createElement("code");
    version.textContent = managed.history[0]?.version ?? "unknown";
    nameLine.append(name, version);
    const detail = document.createElement("small");
    detail.textContent = `${managed.history.length} retained rollback package${managed.history.length === 1 ? "" : "s"}; no package is currently installed.`;
    copy.append(nameLine, detail);
    const restore = packageActionButton(
      "Review restore",
      `Review restoring ${managed.pluginId}`,
      { action: "rollback", pluginId: managed.pluginId },
      disabled,
    );
    row.append(copy, restore);
    elements.pluginRemovedList.append(row);
  }
}

function renderPluginSettings(): void {
  const vaultId = currentSnapshot?.vault.id ?? null;
  const catalog = pluginCatalog?.vaultId === vaultId ? pluginCatalog : null;
  const preference = currentPluginPreference();
  const safeMode = catalog?.safeMode ?? false;
  const restricted = preference.compatibilityMode === "restricted";
  const disabled = pluginBusy || !vaultId || readOnlyVault();
  const installed = catalog?.plugins ?? [];
  const managedPackages = catalog?.managedPackages ?? [];
  const managedById = new Map(managedPackages.map((managed) => [managed.pluginId, managed]));

  elements.pluginModeState.textContent = safeMode
    ? "Safe mode"
    : restricted
      ? "Restricted"
      : "Enabled";
  elements.pluginModeState.dataset.state = safeMode ? "safe" : restricted ? "default" : "active";
  elements.pluginModeToggle.textContent = restricted
    ? "Turn off restricted mode"
    : "Turn on restricted mode";
  elements.pluginModeToggle.disabled = disabled || safeMode;
  elements.pluginInstalledCount.textContent = `${installed.length} installed`;
  elements.pluginReloadAll.disabled = disabled || safeMode || restricted;
  elements.pluginSearch.disabled = disabled;
  renderOpenPluginIndex(vaultId, disabled);

  const query = elements.pluginSearch.value.trim().toLocaleLowerCase("en-US");
  const visiblePlugins = installed.filter((plugin) =>
    [
      plugin.name,
      plugin.id,
      plugin.description ?? "",
      plugin.author ?? "",
      plugin.minAppVersion ?? "",
      plugin.isDesktopOnly ? "desktop only" : "",
      plugin.compatibility.summary,
      ...(plugin.capabilityReport?.capabilities.map(
        (capability) => pluginCapabilityDefinitions[capability].label,
      ) ?? []),
    ]
      .join(" ")
      .toLocaleLowerCase("en-US")
      .includes(query),
  );
  elements.pluginList.replaceChildren();
  for (const plugin of visiblePlugins) {
    const row = document.createElement("article");
    row.className = "plugin-row";
    row.dataset.pluginId = plugin.id;
    row.dataset.invalid = String(plugin.packageState === "invalid");
    if (plugin.error) {
      row.title = plugin.error;
    }
    const managed = managedById.get(plugin.id);

    const copy = document.createElement("span");
    copy.className = "plugin-copy";
    const nameLine = document.createElement("span");
    nameLine.className = "plugin-name-line";
    const name = document.createElement("strong");
    name.textContent = plugin.name;
    const version = document.createElement("code");
    version.textContent = plugin.version;
    nameLine.append(name, version);
    const description = document.createElement("small");
    description.textContent =
      plugin.error ?? plugin.description ?? "No description was provided in manifest.json.";
    const preflight = document.createElement("span");
    preflight.className = "plugin-preflight";
    preflight.ariaLabel = `Compatibility preflight for ${plugin.name}`;
    const evidence = document.createElement("span");
    evidence.className = "plugin-preflight-badge";
    evidence.dataset.evidence =
      plugin.packageState === "invalid" ? "invalid" : plugin.compatibility.status;
    evidence.textContent =
      plugin.packageState === "invalid"
        ? "× Package invalid"
        : plugin.compatibility.status === "verified"
          ? `◆ Tested L${plugin.compatibility.level}`
          : plugin.compatibility.status === "different-version"
            ? "△ Version untested"
            : `◇ Discovered L${plugin.compatibility.level}`;
    const apiBaseline = document.createElement("span");
    apiBaseline.className = "plugin-preflight-badge";
    apiBaseline.textContent = plugin.minAppVersion
      ? `Declared minimum Obsidian ${plugin.minAppVersion}`
      : "Declared minimum Obsidian unknown";
    const platform = document.createElement("span");
    platform.className = "plugin-preflight-badge";
    platform.textContent = plugin.isDesktopOnly ? "Desktop only" : "No desktop-only flag";
    const dependencies = document.createElement("span");
    dependencies.className = "plugin-preflight-badge";
    dependencies.textContent = "Deps: bundled model";
    preflight.append(evidence, apiBaseline, platform, dependencies);
    if (managed) {
      const integrity = document.createElement("span");
      integrity.className = "plugin-preflight-badge";
      integrity.dataset.evidence = managed.integrity === "verified" ? "verified" : "invalid";
      integrity.textContent =
        managed.integrity === "verified" ? "◆ SHA-256 verified" : "× Managed bytes changed";
      preflight.append(integrity);
    }
    const compatibilityEvidence = document.createElement("small");
    compatibilityEvidence.className = "plugin-compatibility-evidence";
    compatibilityEvidence.textContent = `Evidence: ${plugin.compatibility.summary}`;
    const authority = document.createElement("span");
    authority.className = "plugin-authority-summary";
    authority.dataset.state = plugin.capabilityGrantState;
    const authorityState = document.createElement("strong");
    authorityState.textContent =
      plugin.capabilityGrantState === "granted"
        ? "◆ Exact bundle granted"
        : plugin.capabilityGrantState === "stale"
          ? "△ Bundle changed, review again"
          : plugin.capabilityGrantState === "required"
            ? "◇ Authority review required"
            : "× Authority report unavailable";
    const authorityCapabilities = document.createElement("small");
    const capabilityLabels =
      plugin.capabilityReport?.capabilities.map(
        (capability) => pluginCapabilityDefinitions[capability].label,
      ) ?? [];
    authorityCapabilities.textContent =
      capabilityLabels.length > 0
        ? capabilityLabels.join(" · ")
        : plugin.capabilityReport
          ? "No known references observed; trusted runtime remains unsandboxed."
          : "Bundle validation failed before static authority inspection.";
    authority.append(authorityState, authorityCapabilities);
    const author = document.createElement("small");
    author.className = "plugin-author";
    author.textContent = plugin.author ? `By ${plugin.author}` : plugin.id;
    copy.append(nameLine, description, preflight, compatibilityEvidence, authority, author);

    const controls = document.createElement("span");
    controls.className = "plugin-row-controls";
    const packageControls = document.createElement("span");
    packageControls.className = "plugin-package-controls";
    if (plugin.packageState !== "invalid" || managed?.currentVersion) {
      packageControls.append(
        packageActionButton(
          managed?.integrity === "changed" ? "Review reinstall" : "Review update",
          managed?.integrity === "changed"
            ? `Review reinstalling exact package bytes for ${plugin.name}`
            : `Review an exact package update for ${plugin.name}`,
          { action: "install", pluginId: plugin.id },
          disabled,
        ),
      );
    }
    if ((managed?.history.length ?? 0) > 0) {
      packageControls.append(
        packageActionButton(
          "Roll back",
          `Review rolling back ${plugin.name}`,
          { action: "rollback", pluginId: plugin.id },
          disabled,
        ),
      );
    }
    packageControls.append(
      packageActionButton(
        "Uninstall",
        `Review uninstalling ${plugin.name}`,
        { action: "uninstall", pluginId: plugin.id },
        disabled,
      ),
    );
    const selected = preference.enabledPluginIds.includes(plugin.id);
    const runtimePlugin = (currentSnapshot?.plugins ?? []).find(
      (candidate) => candidate.id === plugin.id,
    );
    const runtimeState = document.createElement("span");
    runtimeState.className = "plugin-runtime-state";
    runtimeState.textContent =
      managed?.integrity === "changed"
        ? "Integrity changed"
        : plugin.packageState === "invalid"
          ? "Invalid package"
          : plugin.capabilityGrantState === "stale"
            ? "Review stale"
            : plugin.capabilityGrantState === "required"
              ? selected
                ? "Blocked · review"
                : "Review required"
              : safeMode
                ? selected
                  ? "Selected · safe"
                  : "Disabled"
                : restricted
                  ? selected
                    ? "Selected"
                    : "Disabled"
                  : runtimePlugin?.state === "failed"
                    ? "Load failed"
                    : selected
                      ? runtimePlugin?.state === "loaded"
                        ? `Active · L${runtimePlugin.compatibilityLevel}`
                        : "Enabled"
                      : "Disabled";

    const authorityAction = document.createElement("button");
    authorityAction.type = "button";
    authorityAction.className = "secondary-button plugin-authority-action";
    authorityAction.textContent =
      plugin.capabilityGrantState === "granted" ? "Revoke grant" : "Review authority";
    authorityAction.disabled =
      disabled || plugin.packageState === "invalid" || plugin.capabilityReport === null;
    authorityAction.ariaLabel =
      plugin.capabilityGrantState === "granted"
        ? `Revoke exact-bundle authority for ${plugin.name}`
        : `Review exact-bundle authority for ${plugin.name}`;
    authorityAction.addEventListener("click", () => {
      if (plugin.capabilityGrantState === "granted") {
        void setPluginCapabilityGrant(plugin, false);
      } else {
        openPluginAuthorityReview(plugin);
      }
    });

    const toggle = document.createElement("label");
    toggle.className = "plugin-toggle";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.role = "switch";
    checkbox.checked = selected;
    checkbox.disabled =
      disabled ||
      safeMode ||
      restricted ||
      plugin.packageState === "invalid" ||
      plugin.capabilityGrantState !== "granted";
    checkbox.ariaLabel = `${selected ? "Disable" : "Enable"} ${plugin.name}`;
    checkbox.addEventListener("change", () => {
      void setPluginEnabled(plugin.id, checkbox.checked);
    });
    const track = document.createElement("span");
    track.className = "plugin-toggle-track";
    track.ariaHidden = "true";
    const toggleLabel = document.createElement("span");
    toggleLabel.className = "plugin-toggle-label";
    toggleLabel.textContent =
      selected && plugin.capabilityGrantState !== "granted"
        ? "Blocked"
        : selected
          ? "Enabled"
          : "Disabled";
    toggle.append(checkbox, track, toggleLabel);
    const hasSettings =
      runtimePlugin?.state === "loaded" &&
      (currentSnapshot?.integrations?.settingTabPluginIds ?? []).includes(plugin.id);
    const options = document.createElement("button");
    options.type = "button";
    options.className = "secondary-button plugin-options-button";
    options.textContent = "Options";
    options.hidden = !hasSettings;
    options.disabled = disabled || safeMode || restricted || pluginBusy || busy || saving;
    options.ariaLabel = `Open ${plugin.name} options`;
    options.addEventListener("click", () => void activatePluginSettings(plugin.id));
    controls.append(runtimeState, packageControls, authorityAction, options, toggle);
    row.append(copy, controls);
    elements.pluginList.append(row);
  }

  if (visiblePlugins.length === 0) {
    const empty = document.createElement("p");
    empty.className = "plugin-empty";
    empty.textContent = catalog
      ? query
        ? "No installed plugins match this search."
        : "No standard plugin packages were found in .obsidian/plugins."
      : "Plugin catalog is not loaded yet.";
    elements.pluginList.append(empty);
  }

  renderRemovedPackages(managedPackages, disabled);

  elements.pluginStatus.textContent = pluginMessage;
  elements.pluginStatus.dataset.kind = pluginMessageKind;
  elements.pluginWarnings.replaceChildren();
  const runtimeWarnings = runtimePluginWarnings();
  for (const warning of [...(catalog?.warnings ?? []), ...runtimeWarnings]) {
    const item = document.createElement("li");
    item.textContent = warning;
    elements.pluginWarnings.append(item);
  }
}

function appearancePackageKindLabel(kind: AppearancePackageKind): string {
  return kind === "theme" ? "Theme" : "CSS snippet";
}

function renderAppearancePackageSettings(): void {
  const vaultId = currentSnapshot?.vault.id ?? null;
  const loaded = appearancePackagesVaultId === vaultId && vaultId !== null;
  const disabled = appearancePackageBusy || !vaultId || readOnlyVault();
  elements.appearancePackageKind.disabled = disabled;
  elements.appearancePackageOpen.disabled = disabled;
  elements.appearancePackageRefresh.disabled = appearancePackageBusy || !vaultId;
  elements.appearancePackageState.textContent = appearancePackageBusy
    ? "Working"
    : !loaded
      ? "Not loaded"
      : `${appearancePackages.length} managed`;
  elements.appearancePackageState.dataset.state = appearancePackageBusy
    ? "active"
    : loaded
      ? "default"
      : "safe";

  elements.appearancePackageList.replaceChildren();
  if (!loaded) {
    const empty = document.createElement("p");
    empty.className = "appearance-package-empty";
    empty.textContent = "Package inventory is not loaded yet.";
    elements.appearancePackageList.append(empty);
  } else if (appearancePackages.length === 0) {
    const empty = document.createElement("p");
    empty.className = "appearance-package-empty";
    empty.textContent = "No Threadleaf-managed appearance packages are installed.";
    elements.appearancePackageList.append(empty);
  } else {
    for (const pkg of appearancePackages) {
      const row = document.createElement("article");
      row.className = "appearance-package-row";
      const copy = document.createElement("span");
      copy.className = "appearance-package-row-copy";
      const title = document.createElement("strong");
      title.textContent = `${appearancePackageKindLabel(pkg.kind)} · ${pkg.packageId}`;
      const detail = document.createElement("small");
      const version = pkg.currentVersion ?? "Not installed";
      detail.textContent = `${version} · ${pkg.integrity} · ${pkg.history.length} retained`;
      copy.append(title, detail);

      const controls = document.createElement("span");
      controls.className = "appearance-package-row-controls";
      const addAction = (label: string, action: "uninstall" | "rollback" | "restore"): void => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "secondary-button";
        button.textContent = label;
        button.ariaLabel = `${label} ${pkg.packageId}`;
        button.disabled = disabled;
        button.addEventListener("click", () => {
          void previewManagedAppearancePackage({
            action,
            kind: pkg.kind,
            packageId: pkg.packageId,
          });
        });
        controls.append(button);
      };
      if (pkg.currentVersion !== null) {
        addAction("Uninstall", "uninstall");
      }
      if (pkg.history.length > 0) {
        addAction(
          pkg.currentVersion === null ? "Restore" : "Roll back",
          pkg.currentVersion === null ? "restore" : "rollback",
        );
      }
      row.append(copy, controls);
      elements.appearancePackageList.append(row);
    }
  }
  elements.appearancePackageStatus.textContent = appearancePackageMessage;
  elements.appearancePackageStatus.dataset.kind = appearancePackageMessageKind;
}

async function refreshAppearancePackages(successMessage?: string): Promise<void> {
  const vaultId = currentSnapshot?.vault.id;
  if (!vaultId || appearancePackageBusy) {
    return;
  }
  const request = ++appearancePackageRequest;
  appearancePackageBusy = true;
  appearancePackageMessage = "Reading the private appearance package inventory…";
  appearancePackageMessageKind = "info";
  renderSettings();
  try {
    const response = await window.threadleaf.getAppearancePackages(vaultId);
    if (request !== appearancePackageRequest || vaultId !== currentSnapshot?.vault.id) {
      return;
    }
    if (response.status === "stale-vault") {
      appearancePackageMessage = "The active vault changed before package inventory loaded.";
      appearancePackageMessageKind = "info";
      return;
    }
    appearancePackages = response.inventory.packages;
    appearancePackagesVaultId = response.inventory.vaultId;
    appearancePackageMessage =
      response.inventory.recoveryNotices[0] ??
      successMessage ??
      `${appearancePackages.length} managed appearance package${appearancePackages.length === 1 ? "" : "s"} loaded.`;
    appearancePackageMessageKind =
      response.inventory.recoveryNotices.length > 0 ? "warning" : "saved";
  } catch (error) {
    if (request === appearancePackageRequest) {
      appearancePackageMessage = ipcErrorMessage(error);
      appearancePackageMessageKind = "error";
    }
  } finally {
    if (request === appearancePackageRequest) {
      appearancePackageBusy = false;
      renderSettings();
    }
  }
}

function appendAppearancePackageFact(label: string, value: string): void {
  appendDefinitionListFact(elements.appearancePackageReviewFacts, label, value);
}

function openAppearancePackageReview(review: AppearancePackageReview): void {
  appearancePackageReview = review;
  appearancePackageRestoreFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  elements.appearancePackageReviewOperation.textContent = `${packageOperationLabel(review.operation)} review`;
  elements.appearancePackageReviewTitle.textContent = review.name;
  elements.appearancePackageReviewSummary.textContent =
    review.operation === "uninstall"
      ? `Remove ${appearancePackageKindLabel(review.kind).toLocaleLowerCase("en-US")} ${review.packageId} after retaining its complete bytes for recovery.`
      : `${packageOperationLabel(review.operation)} ${review.packageId} from ${review.installedVersion ?? "not installed"} to ${review.targetVersion ?? "removed"}.`;
  elements.appearancePackageReviewFacts.replaceChildren();
  appendAppearancePackageFact("Kind", appearancePackageKindLabel(review.kind));
  appendAppearancePackageFact("Package", review.packageId);
  appendAppearancePackageFact("Current", review.installedVersion ?? "Not installed");
  appendAppearancePackageFact("Target", review.targetVersion ?? "Removed");
  appendAppearancePackageFact("Vault target", review.targetPath);
  appendAppearancePackageFact("Stylesheet", review.stylesheetFilename ?? "Retained target bytes");
  appendAppearancePackageFact("Archive SHA-256", review.archiveSha256 ?? "Retained bytes");
  appendAppearancePackageFact(
    "Provenance",
    review.provenance
      ? `${review.provenance.source}${review.provenance.locator ? ` · ${review.provenance.locator}` : ""}`
      : "Retained vault bytes",
  );
  appendAppearancePackageFact("Review expires", new Date(review.expiresAt).toLocaleString());

  elements.appearancePackageReviewAssets.replaceChildren();
  if (review.assets.length === 0) {
    const empty = document.createElement("p");
    empty.textContent =
      "No new archive assets. The existing target bytes are retained for this operation.";
    elements.appearancePackageReviewAssets.append(empty);
  } else {
    for (const asset of review.assets) {
      const row = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = asset.filename;
      const size = document.createElement("span");
      size.textContent = formatPackageBytes(asset.size);
      const hash = document.createElement("code");
      hash.textContent = asset.sha256;
      row.append(name, size, hash);
      elements.appearancePackageReviewAssets.append(row);
    }
  }
  elements.appearancePackageReviewCss.textContent = review.css
    ? `${review.css.valid ? "Valid" : "Rejected"} · ${review.css.stylesheetBytes} bytes · ${review.css.selectorCount} selectors · ${review.css.declarationCount} declarations · ${review.css.importCount} imports · ${review.css.externalUrlCount} external URLs · ${review.css.executableConstructCount} executable constructs`
    : "No new stylesheet report for this retained-byte operation.";
  elements.appearancePackageReviewLicense.textContent = review.license
    ? `${review.license.spdxId} · ${review.license.name} · ${formatPackageBytes(review.license.size)} · SHA-256 ${review.license.sha256}`
    : "No license evidence is included in this review.";
  elements.appearancePackageReviewReadme.textContent = review.readme
    ? `${review.readme.filename} · ${formatPackageBytes(review.readme.size)} · SHA-256 ${review.readme.sha256}\n${review.readme.preview}`
    : "No README evidence is included in this review.";
  elements.appearancePackageReviewWarnings.replaceChildren();
  for (const warning of review.warnings) {
    const item = document.createElement("li");
    item.textContent = warning;
    elements.appearancePackageReviewWarnings.append(item);
  }
  elements.appearancePackageReviewError.hidden = true;
  elements.appearancePackageReviewError.textContent = "";
  elements.appearancePackageReviewApply.textContent =
    review.operation === "uninstall"
      ? "Apply reviewed uninstall"
      : `Apply reviewed ${packageOperationLabel(review.operation).toLocaleLowerCase("en-US")}`;
  elements.appearancePackageReviewApply.disabled = readOnlyVault();
  elements.appearancePackageReviewCancel.disabled = false;
  elements.appearancePackageReviewClose.disabled = false;
  if (!elements.appearancePackageReviewDialog.open) {
    elements.appearancePackageReviewDialog.showModal();
  }
  elements.appearancePackageReviewClose.focus();
}

async function previewLocalAppearancePackage(): Promise<void> {
  const vaultId = currentSnapshot?.vault.id;
  if (!vaultId || appearancePackageBusy || readOnlyVault()) {
    if (readOnlyVault()) showToast("Open a local vault before changing appearance packages.");
    return;
  }
  const request = ++appearancePackageRequest;
  const kind = elements.appearancePackageKind.value as AppearancePackageKind;
  appearancePackageBusy = true;
  appearancePackageMessage = `Choose an exact local ${appearancePackageKindLabel(kind).toLocaleLowerCase("en-US")} archive to review…`;
  appearancePackageMessageKind = "info";
  renderSettings();
  try {
    const response = await window.threadleaf.previewLocalAppearancePackage(vaultId, kind);
    if (request !== appearancePackageRequest || vaultId !== currentSnapshot?.vault.id) return;
    if (response.status === "cancelled") {
      appearancePackageMessage = "Package review cancelled. No vault bytes changed.";
      appearancePackageMessageKind = "info";
      return;
    }
    if (response.status === "stale-vault") {
      appearancePackageMessage = "The active vault changed before package review completed.";
      appearancePackageMessageKind = "info";
      return;
    }
    appearancePackageMessage = `${packageOperationLabel(response.review.operation)} review is ready. No vault bytes changed.`;
    appearancePackageMessageKind = response.review.warnings.length > 0 ? "warning" : "saved";
    openAppearancePackageReview(response.review);
  } catch (error) {
    if (request === appearancePackageRequest) {
      appearancePackageMessage = ipcErrorMessage(error);
      appearancePackageMessageKind = "error";
    }
  } finally {
    if (request === appearancePackageRequest) {
      appearancePackageBusy = false;
      renderSettings();
    }
  }
}

async function previewManagedAppearancePackage(
  requestValue: AppearancePackagePreviewRequest,
): Promise<void> {
  const vaultId = currentSnapshot?.vault.id;
  if (!vaultId || appearancePackageBusy || readOnlyVault()) {
    if (readOnlyVault()) showToast("Open a local vault before changing appearance packages.");
    return;
  }
  const request = ++appearancePackageRequest;
  appearancePackageBusy = true;
  appearancePackageMessage = `Preparing an exact ${requestValue.action} review for ${requestValue.packageId}…`;
  appearancePackageMessageKind = "info";
  renderSettings();
  try {
    const response = await window.threadleaf.previewAppearancePackage(vaultId, requestValue);
    if (request !== appearancePackageRequest || vaultId !== currentSnapshot?.vault.id) return;
    if (response.status === "stale-vault") {
      appearancePackageMessage = "The active vault changed before package review completed.";
      appearancePackageMessageKind = "info";
      return;
    }
    appearancePackageMessage = `${packageOperationLabel(response.review.operation)} review is ready. No vault bytes changed.`;
    appearancePackageMessageKind = response.review.warnings.length > 0 ? "warning" : "saved";
    openAppearancePackageReview(response.review);
  } catch (error) {
    if (request === appearancePackageRequest) {
      appearancePackageMessage = ipcErrorMessage(error);
      appearancePackageMessageKind = "error";
    }
  } finally {
    if (request === appearancePackageRequest) {
      appearancePackageBusy = false;
      renderSettings();
    }
  }
}

async function closeAppearancePackageReview(restoreFocus = true): Promise<void> {
  const review = appearancePackageReview;
  if (!elements.appearancePackageReviewDialog.open || appearancePackageBusy) return;
  appearancePackageReview = null;
  elements.appearancePackageReviewDialog.close();
  if (review && currentSnapshot?.vault.id === review.vaultId) {
    await window.threadleaf
      .cancelAppearancePackageReview(review.vaultId, review.reviewId)
      .catch(() => undefined);
  }
  const restoreTarget = appearancePackageRestoreFocus;
  appearancePackageRestoreFocus = null;
  if (restoreFocus && restoreTarget?.isConnected) restoreTarget.focus();
}

async function applyAppearancePackageReview(): Promise<void> {
  const review = appearancePackageReview;
  const vaultId = currentSnapshot?.vault.id;
  if (!review || !vaultId || review.vaultId !== vaultId || appearancePackageBusy) return;
  if (readOnlyVault()) {
    showToast("Open a local vault before changing appearance packages.");
    return;
  }
  const request = ++appearancePackageRequest;
  appearancePackageBusy = true;
  elements.appearancePackageReviewApply.disabled = true;
  elements.appearancePackageReviewCancel.disabled = true;
  elements.appearancePackageReviewClose.disabled = true;
  elements.appearancePackageReviewError.hidden = true;
  appearancePackageMessage = `Applying the reviewed ${review.operation} without changing private appearance selection…`;
  appearancePackageMessageKind = "info";
  renderSettings();
  try {
    const response = await window.threadleaf.applyAppearancePackage(vaultId, review.reviewId);
    if (request !== appearancePackageRequest || vaultId !== currentSnapshot?.vault.id) return;
    if (response.status === "stale-vault") {
      throw new Error("The active vault changed before the reviewed package could be applied.");
    }
    applyAppearanceSnapshot(response.appearance);
    appearancePackages = response.inventory.packages;
    appearancePackagesVaultId = response.inventory.vaultId;
    appearancePackageReview = null;
    elements.appearancePackageReviewDialog.close();
    appearancePackageMessage = `${response.outcome.packageId} ${response.outcome.operation} completed. Private theme and snippet selection stayed unchanged.`;
    appearancePackageMessageKind =
      response.inventory.recoveryNotices.length > 0 ? "warning" : "saved";
    showToast(`${response.outcome.packageId} ${response.outcome.operation} completed.`);
    const restoreTarget = appearancePackageRestoreFocus;
    appearancePackageRestoreFocus = null;
    if (restoreTarget?.isConnected) restoreTarget.focus();
  } catch (error) {
    if (request === appearancePackageRequest) {
      const message = `${ipcErrorMessage(error)} Review the exact package again before another apply.`;
      appearancePackageReview = null;
      appearancePackageMessage = message;
      appearancePackageMessageKind = "error";
      elements.appearancePackageReviewError.textContent = message;
      elements.appearancePackageReviewError.hidden = false;
      elements.appearancePackageReviewDialog.close();
    }
  } finally {
    if (request === appearancePackageRequest) {
      appearancePackageBusy = false;
      renderSettings();
    }
  }
}

function renderAppearanceSettings(): void {
  const vaultId = currentSnapshot?.vault.id ?? null;
  const catalog = appearanceSnapshot?.vaultId === vaultId ? appearanceSnapshot : null;
  const preference = currentAppearancePreference();
  const disabled = appearanceBusy || !vaultId;
  const safeMode = catalog?.safeMode ?? false;

  elements.schemeSystem.checked = preference.colorScheme === "system";
  elements.schemeLight.checked = preference.colorScheme === "light";
  elements.schemeDark.checked = preference.colorScheme === "dark";
  for (const input of [elements.schemeSystem, elements.schemeLight, elements.schemeDark]) {
    input.disabled = disabled;
  }

  elements.appearanceTheme.replaceChildren();
  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "Threadleaf default";
  elements.appearanceTheme.append(defaultOption);
  for (const theme of catalog?.themes ?? []) {
    const option = document.createElement("option");
    option.value = theme.id;
    option.textContent = theme.version ? `${theme.name} (${theme.version})` : theme.name;
    elements.appearanceTheme.append(option);
  }
  if (
    preference.themeId &&
    !(catalog?.themes ?? []).some((theme) => theme.id === preference.themeId)
  ) {
    const missing = document.createElement("option");
    missing.value = preference.themeId;
    missing.textContent = "Selected theme is unavailable";
    elements.appearanceTheme.append(missing);
  }
  elements.appearanceTheme.value = preference.themeId ?? "";
  elements.appearanceTheme.disabled = disabled || safeMode;
  const selectedTheme = catalog?.themes.find((theme) => theme.id === preference.themeId);
  elements.appearanceThemeDetail.textContent = selectedTheme
    ? [selectedTheme.author, selectedTheme.version].filter(Boolean).join(" · ") ||
      "Vault community theme"
    : preference.themeId
      ? "Not found in .obsidian/themes"
      : "Threadleaf default";

  elements.appearanceSnippets.replaceChildren();
  for (const snippet of catalog?.snippets ?? []) {
    const label = document.createElement("label");
    label.className = "snippet-option";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = snippet.id;
    input.checked = preference.enabledSnippetIds.includes(snippet.id);
    input.disabled = disabled || safeMode;
    input.addEventListener("change", () => {
      const enabledSnippetIds = [
        ...elements.appearanceSnippets.querySelectorAll<HTMLInputElement>(
          'input[type="checkbox"]:checked',
        ),
      ].map((candidate) => candidate.value);
      void persistAppearance(
        { ...currentAppearancePreference(), enabledSnippetIds },
        "CSS snippet selection saved.",
      );
    });
    const name = document.createElement("span");
    name.textContent = snippet.name;
    label.append(input, name);
    elements.appearanceSnippets.append(label);
  }
  if ((catalog?.snippets.length ?? 0) === 0) {
    const empty = document.createElement("p");
    empty.className = "snippet-empty";
    empty.textContent = catalog
      ? "No .css files found in .obsidian/snippets."
      : "Appearance catalog is not loaded yet.";
    elements.appearanceSnippets.append(empty);
  }

  elements.appearanceReload.disabled = disabled;
  elements.appearanceReset.disabled =
    disabled || (preference.themeId === null && preference.enabledSnippetIds.length === 0);
  elements.appearanceStatus.textContent = appearanceMessage;
  elements.appearanceStatus.dataset.kind = appearanceMessageKind;
  elements.appearanceWarnings.replaceChildren();
  for (const warning of catalog?.warnings ?? []) {
    const item = document.createElement("li");
    item.textContent = warning;
    elements.appearanceWarnings.append(item);
  }

  const customCount = (catalog?.activeThemeId ? 1 : 0) + (catalog?.activeSnippetIds.length ?? 0);
  elements.appearanceState.textContent = safeMode
    ? "Safe mode"
    : appearanceBusy
      ? "Applying"
      : customCount > 0
        ? `${customCount} active`
        : "Default";
  elements.appearanceState.dataset.state = safeMode
    ? "safe"
    : customCount > 0
      ? "active"
      : "default";
  renderAppearancePackageSettings();
}

function renderAppUpdateSettings(): void {
  const snapshot = appUpdateSnapshot;
  if (!snapshot) {
    elements.appUpdateState.textContent = "Loading";
    elements.appUpdateTitle.textContent = "Threadleaf";
    elements.appUpdateMessage.textContent =
      "Reading the local package update policy. No network request starts automatically.";
    elements.appUpdateCurrentVersion.textContent = "Loading";
    elements.appUpdateAvailableVersion.textContent = "Not checked";
    elements.appUpdatePolicy.textContent = "Manual and signed";
    elements.appUpdateCheckedAt.textContent = "Never";
    elements.appUpdateProgress.hidden = true;
    elements.appUpdateCheck.disabled = true;
    elements.appUpdateDownload.hidden = true;
    elements.appUpdateInstall.hidden = true;
    return;
  }

  const phaseLabels: Record<AppUpdateSnapshot["phase"], string> = {
    disabled: "Disabled",
    idle: "Ready",
    checking: "Checking",
    available: "Available",
    downloading: "Downloading",
    downloaded: "Ready to install",
    installing: "Installing",
    "up-to-date": "Up to date",
    error: "Try again",
  };
  elements.appUpdateState.textContent = phaseLabels[snapshot.phase];
  elements.appUpdateState.dataset.state = snapshot.phase;
  elements.appUpdateTitle.textContent = `Threadleaf ${snapshot.currentVersion}`;
  elements.appUpdateMessage.textContent = snapshot.message;
  elements.appUpdateCurrentVersion.textContent = snapshot.currentVersion;
  elements.appUpdateAvailableVersion.textContent = snapshot.availableVersion ?? "None found";
  elements.appUpdateCheckedAt.textContent = snapshot.checkedAt
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(snapshot.checkedAt),
      )
    : "Never";
  elements.appUpdatePolicy.textContent = updatePolicyLabel(snapshot);

  const progress = snapshot.progress;
  elements.appUpdateProgress.hidden = snapshot.phase !== "downloading" || progress === null;
  if (progress) {
    const progressDetail = `${Math.round(progress.percent)}% · ${formatByteCount(progress.transferred)} of ${formatByteCount(progress.total)}`;
    elements.appUpdateProgressBar.style.width = `${progress.percent}%`;
    elements.appUpdateProgressDetail.textContent = progressDetail;
    elements.appUpdateProgress.setAttribute("aria-valuenow", String(Math.round(progress.percent)));
    elements.appUpdateProgress.setAttribute("aria-valuetext", progressDetail);
  } else {
    elements.appUpdateProgressBar.style.width = "0%";
    elements.appUpdateProgress.removeAttribute("aria-valuenow");
    elements.appUpdateProgress.removeAttribute("aria-valuetext");
  }

  const operationBusy =
    appUpdateActionBusy || ["checking", "downloading", "installing"].includes(snapshot.phase);
  elements.appUpdateCheck.hidden = false;
  elements.appUpdateCheck.disabled = operationBusy || !snapshot.canCheck;
  elements.appUpdateCheck.textContent =
    snapshot.phase === "checking" ? "Checking…" : "Check for updates";
  elements.appUpdateDownload.hidden = !snapshot.canDownload && snapshot.phase !== "downloading";
  elements.appUpdateDownload.disabled = operationBusy || !snapshot.canDownload;
  elements.appUpdateDownload.textContent =
    snapshot.phase === "downloading" ? "Downloading…" : "Download update";
  elements.appUpdateInstall.hidden = !snapshot.canInstall && snapshot.phase !== "installing";
  elements.appUpdateInstall.disabled = operationBusy || !snapshot.canInstall;
  elements.appUpdateInstall.textContent =
    snapshot.phase === "installing" ? "Installing…" : "Restart and install";
}

function renderSupportBundleSettings(): void {
  elements.supportBundleExport.disabled = supportBundleBusy;
  elements.supportBundleExport.textContent = supportBundleBusy
    ? "Preparing report…"
    : "Save support bundle";
  elements.supportBundleStatus.textContent = supportBundleMessage;
  elements.supportBundleStatus.dataset.kind = supportBundleMessageKind;
}

async function exportSupportBundle(): Promise<void> {
  if (supportBundleBusy) {
    return;
  }
  supportBundleBusy = true;
  supportBundleMessage = "Preparing an aggregate-only report. Nothing is being uploaded.";
  supportBundleMessageKind = "info";
  renderSettings();
  try {
    const response = await window.threadleaf.exportSupportBundle();
    if (response.status === "saved") {
      supportBundleMessage = "Support bundle saved. Nothing was uploaded.";
      supportBundleMessageKind = "saved";
      showToast("Privacy-safe support bundle saved.");
    } else if (response.status === "cancelled") {
      supportBundleMessage = "Save cancelled. No report was created or uploaded.";
      supportBundleMessageKind = "info";
    } else {
      supportBundleMessage = response.message;
      supportBundleMessageKind = "error";
      showToast(response.message);
    }
  } catch {
    supportBundleMessage = "Threadleaf could not prepare the support bundle. Nothing was uploaded.";
    supportBundleMessageKind = "error";
    showToast(supportBundleMessage);
  } finally {
    supportBundleBusy = false;
    renderSettings();
  }
}

function publishExportIdentityIsCurrent(
  expectedVaultId: string,
  expectedPath: string,
  expectedRevision: string,
): boolean {
  return Boolean(
    loadedVaultId === expectedVaultId &&
      currentSnapshot?.vault.id === expectedVaultId &&
      loadedNote?.path === expectedPath &&
      loadedNote.revision === expectedRevision &&
      !dirty &&
      !saving,
  );
}

async function exportCurrentNoteAsHtml(): Promise<void> {
  const note = loadedNote;
  const expectedVaultId = loadedVaultId;
  if (!note || !expectedVaultId || dirty || saving || busy || publishExportBusy) {
    if (dirty) {
      showToast("Save or revert the current note before exporting it.");
    }
    return;
  }

  publishExportBusy = true;
  setActionState(true);
  try {
    const rendered = document.createElement("div");
    rendered.append(renderMarkdownPreview(note.content));
    decoratePreviewLinks(rendered, note.outgoing, note.path);
    await hydrateMarkdownPreview(rendered, {
      sourceNotePath: note.path,
      expectedVaultId,
      loadImage: (sourceNotePath, target, vaultId) =>
        window.threadleaf.loadVaultImage(sourceNotePath, target, vaultId),
      loadAttachment: (sourceNotePath, target, vaultId) =>
        window.threadleaf.loadVaultAttachment(sourceNotePath, target, vaultId),
      loadNoteEmbed: (sourceNotePath, target, subpath, vaultId) =>
        window.threadleaf.loadVaultNoteEmbed(sourceNotePath, target, subpath, vaultId),
      loadCanvas: (path, vaultId) => window.threadleaf.loadCanvas(path, vaultId),
      decorateLinks: decoratePreviewLinks,
      isCurrent: () => publishExportIdentityIsCurrent(expectedVaultId, note.path, note.revision),
    });
    if (!publishExportIdentityIsCurrent(expectedVaultId, note.path, note.revision)) {
      showToast("The active note changed before export. Review it and export again.");
      return;
    }

    const html = createStandalonePublishedNoteHtml(note.title, rendered);
    if (new TextEncoder().encode(html).byteLength > maximumPublishNoteHtmlBytes) {
      showToast("This standalone export is too large. Reduce embedded images and retry.");
      return;
    }
    const response = await window.threadleaf.publishNote({
      version: publishNoteExportVersion,
      expectedVaultId,
      sourcePath: note.path,
      expectedRevision: note.revision,
      html,
    });
    if (response.status === "saved") {
      showToast("Standalone HTML export saved.");
    } else if (response.status === "cancelled") {
      showToast("Export cancelled. No file was created.");
    } else {
      showToast(response.message);
    }
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  } finally {
    publishExportBusy = false;
    setActionState(false);
  }
}

function updatePolicyLabel(snapshot: AppUpdateSnapshot): string {
  switch (snapshot.disabledReason) {
    case "development-build":
      return "Disabled · development build";
    case "unsupported-platform":
      return "System package manager";
    case "unsigned-package":
      return "Disabled · unsigned package";
    case "updater-unavailable":
      return "Disabled · updater unavailable";
    default:
      return "Manual · signed releases only";
  }
}

function formatByteCount(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"] as const;
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;
  return `${value >= 10 || unitIndex === 0 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
}

function applyAppUpdateSnapshot(snapshot: AppUpdateSnapshot): void {
  appUpdateSnapshot = snapshot;
  renderSettings();
}

async function runAppUpdateAction(action: "check" | "download" | "install"): Promise<void> {
  if (appUpdateActionBusy) {
    return;
  }
  appUpdateActionBusy = true;
  renderAppUpdateSettings();
  try {
    const snapshot =
      action === "check"
        ? await window.threadleaf.checkForAppUpdate()
        : action === "download"
          ? await window.threadleaf.downloadAppUpdate()
          : await window.threadleaf.installAppUpdate();
    applyAppUpdateSnapshot(snapshot);
  } catch {
    if (appUpdateSnapshot) {
      appUpdateSnapshot = {
        ...appUpdateSnapshot,
        phase: "error",
        message: "The update service became unavailable. Your installation was not changed.",
        progress: null,
        canCheck: appUpdateSnapshot.disabledReason === null,
        canDownload: false,
        canInstall: false,
      };
    }
  } finally {
    appUpdateActionBusy = false;
    renderSettings();
  }
}

function openSettings(): void {
  if (elements.settingsDialog.open) {
    elements.settingsClose.focus();
    return;
  }
  if (elements.commandPalette.open) {
    closeCommandPalette(false);
  }
  if (documentViewMode === "plugin") {
    setDocumentView(editingViewMode, false);
  }
  settingsRestoreFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  recordingShortcut = null;
  noteWorkflowDraft = null;
  workspaceSettingsDraft = null;
  settingsMessage = "Select a command, then press its new shortcut.";
  settingsMessageKind = "info";
  elements.settingsDialog.showModal();
  renderSettings();
  elements.settingsClose.focus();
  if (!appearanceSnapshot || appearanceSnapshot.vaultId !== currentSnapshot?.vault.id) {
    void refreshAppearance();
  }
  if (appearancePackagesVaultId !== currentSnapshot?.vault.id) {
    void refreshAppearancePackages();
  }
  if (!noteWorkflowCatalog || noteWorkflowCatalog.vaultId !== currentSnapshot?.vault.id) {
    void refreshNoteWorkflows();
  }
  if (!workspaceSettingsDraft) {
    void refreshWorkspaceSettings();
  }
  if (!pluginCatalog || pluginCatalog.vaultId !== currentSnapshot?.vault.id) {
    void refreshPlugins();
  }
  if (!migrationPreview || migrationPreview.vaultId !== currentSnapshot?.vault.id) {
    void refreshMigrationPreview();
  }
  if (!appUpdateSnapshot) {
    void window.threadleaf
      .getAppUpdate()
      .then(applyAppUpdateSnapshot)
      .catch(() => undefined);
  }
}

function closeSettings(restoreFocus = true): void {
  if (!elements.settingsDialog.open || settingsOperationBusy()) {
    return;
  }
  recordingShortcut = null;
  noteWorkflowDraft = null;
  workspaceSettingsDraft = null;
  elements.settingsDialog.close();
  const restoreTarget = settingsRestoreFocus;
  settingsRestoreFocus = null;
  if (restoreFocus && restoreTarget?.isConnected) {
    restoreTarget.focus();
  }
}

function focusBindingButton(targetId: ShortcutTargetId): void {
  elements.settingsList
    .querySelector<HTMLButtonElement>(
      `.binding-capture[data-shortcut-target="${CSS.escape(targetId)}"]`,
    )
    ?.focus();
}

function beginShortcutRecording(targetId: ShortcutTargetId): void {
  if (settingsOperationBusy()) {
    return;
  }
  recordingShortcut = targetId;
  settingsMessage =
    "Press Ctrl/Cmd or Alt with a letter, number, arrow, or supported symbol. Esc cancels.";
  settingsMessageKind = "info";
  renderSettings();
  focusBindingButton(targetId);
}

function cancelShortcutRecording(targetId: ShortcutTargetId): void {
  recordingShortcut = null;
  settingsMessage = "Shortcut capture cancelled.";
  settingsMessageKind = "info";
  renderSettings();
  focusBindingButton(targetId);
}

async function persistKeyBinding(
  targetId: ShortcutTargetId,
  binding: string | null,
): Promise<void> {
  if (settingsOperationBusy()) {
    return;
  }
  settingsBusy = true;
  settingsMessage = binding === null ? "Clearing shortcut…" : "Saving shortcut…";
  settingsMessageKind = "info";
  renderSettings();
  try {
    const snapshot = await window.threadleaf.setKeyBinding(targetId, binding);
    recordingShortcut = null;
    settingsMessage = binding === null ? "Shortcut cleared." : "Shortcut saved.";
    settingsMessageKind = "saved";
    applySettingsSnapshot(snapshot);
  } catch (error) {
    settingsMessage = error instanceof Error ? error.message : String(error);
    settingsMessageKind = "error";
  } finally {
    settingsBusy = false;
    renderSettings();
    focusBindingButton(targetId);
  }
}

async function resetKeyBindings(): Promise<void> {
  if (settingsOperationBusy()) {
    return;
  }
  settingsBusy = true;
  recordingShortcut = null;
  settingsMessage = "Restoring default shortcuts…";
  settingsMessageKind = "info";
  renderSettings();
  try {
    applySettingsSnapshot(await window.threadleaf.resetKeyBindings());
    settingsMessage = "Default shortcuts restored.";
    settingsMessageKind = "saved";
  } catch (error) {
    settingsMessage = error instanceof Error ? error.message : String(error);
    settingsMessageKind = "error";
  } finally {
    settingsBusy = false;
    renderSettings();
    elements.settingsReset.focus();
  }
}

function captureShortcut(event: KeyboardEvent, targetId: ShortcutTargetId): void {
  if (recordingShortcut !== targetId) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  if (event.key === "Escape") {
    cancelShortcutRecording(targetId);
    return;
  }
  if (
    (event.key === "Backspace" || event.key === "Delete") &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  ) {
    void persistKeyBinding(targetId, null);
    return;
  }
  const binding = bindingFromKeyboardEvent(event, isMac);
  if (!binding) {
    settingsMessage = "That key is not supported. Include Ctrl/Cmd or Alt and a non-modifier key.";
    settingsMessageKind = "error";
    renderSettings();
    focusBindingButton(targetId);
    return;
  }
  void persistKeyBinding(targetId, binding);
}

function setSettingsPage(page: SettingsPage, focusNavigation = false): void {
  settingsPage = page;
  recordingShortcut = null;
  if (page === "notes" && noteWorkflowDraft === null) {
    noteWorkflowDraft = { ...currentNoteWorkflowPreference() };
  }
  if (page === "workspace" && workspaceSettingsDraft === null) {
    workspaceSettingsDraft = { ...currentWorkspacePreference() };
  }
  renderSettings();
  if (focusNavigation) {
    const target =
      page === "appearance"
        ? elements.settingsNavAppearance
        : page === "accessibility"
          ? elements.settingsNavAccessibility
          : page === "notes"
            ? elements.settingsNavNotes
            : page === "workspace"
              ? elements.settingsNavWorkspace
              : page === "plugins"
                ? elements.settingsNavPlugins
                : page === "migration"
                  ? elements.settingsNavMigration
                  : page === "updates"
                    ? elements.settingsNavUpdates
                    : elements.settingsNavHotkeys;
    target.focus();
  }
}

function renderSettingsNavigation(): void {
  const pageDetails: Record<SettingsPage, { eyebrow: string; title: string }> = {
    appearance: { eyebrow: "Options", title: "Appearance" },
    accessibility: { eyebrow: "Inclusive workspace", title: "Accessibility" },
    notes: { eyebrow: "Core workflows", title: "Daily notes and templates" },
    workspace: { eyebrow: "Core behavior", title: "Workspace and editing" },
    plugins: { eyebrow: "Trusted runtime", title: "Community plugins" },
    migration: { eyebrow: "Migration bridge", title: "Migration preview" },
    updates: { eyebrow: "Release safety", title: "About and updates" },
    hotkeys: { eyebrow: "Keyboard", title: "Hotkeys" },
  };
  elements.settingsPageEyebrow.textContent = pageDetails[settingsPage].eyebrow;
  elements.settingsPageTitle.textContent = pageDetails[settingsPage].title;
  for (const [page, button] of [
    ["appearance", elements.settingsNavAppearance],
    ["accessibility", elements.settingsNavAccessibility],
    ["notes", elements.settingsNavNotes],
    ["workspace", elements.settingsNavWorkspace],
    ["plugins", elements.settingsNavPlugins],
    ["migration", elements.settingsNavMigration],
    ["updates", elements.settingsNavUpdates],
    ["hotkeys", elements.settingsNavHotkeys],
  ] as const) {
    const active = page === settingsPage;
    button.dataset.active = String(active);
    if (active) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  }
  for (const page of elements.settingsDialog.querySelectorAll<HTMLElement>(
    "[data-settings-page]",
  )) {
    page.hidden = page.dataset.settingsPage !== settingsPage;
  }
  elements.settingsReset.hidden = settingsPage !== "hotkeys";
}

function renderSettings(): void {
  elements.settingsWarning.hidden = settingsSnapshot.warning === null;
  elements.settingsWarning.textContent = settingsSnapshot.warning ?? "";
  const [statusMessage, statusKind] =
    settingsPage === "appearance"
      ? [appearanceMessage, appearanceMessageKind]
      : settingsPage === "accessibility"
        ? [accessibilityMessage, accessibilityMessageKind]
        : settingsPage === "notes"
          ? [noteWorkflowMessage, noteWorkflowMessageKind]
          : settingsPage === "workspace"
            ? [workspaceSettingsMessage, workspaceSettingsMessageKind]
            : settingsPage === "plugins"
              ? [pluginMessage, pluginMessageKind]
              : settingsPage === "migration"
                ? [migrationMessage, migrationMessageKind]
                : settingsPage === "updates"
                  ? [
                      appUpdateSnapshot?.message ?? "Reading the local package update policy.",
                      appUpdateSnapshot?.phase === "error"
                        ? "error"
                        : appUpdateSnapshot?.phase === "downloaded" ||
                            appUpdateSnapshot?.phase === "up-to-date"
                          ? "saved"
                          : "info",
                    ]
                  : [settingsMessage, settingsMessageKind];
  elements.settingsStatus.textContent =
    statusKind === "error" ? `Error: ${statusMessage}` : statusMessage;
  elements.settingsStatus.dataset.kind = statusKind;
  const operationBusy = settingsOperationBusy();
  elements.settingsClose.disabled = operationBusy;
  elements.settingsDone.disabled = operationBusy;
  elements.settingsReset.disabled = operationBusy;
  renderSettingsNavigation();
  renderAppearanceSettings();
  renderAccessibilitySettings();
  renderNoteWorkflowSettings();
  renderWorkspaceSettings();
  renderPluginSettings();
  renderMigrationSettings();
  renderAppUpdateSettings();
  renderSupportBundleSettings();
  if (!elements.settingsDialog.open) {
    return;
  }

  elements.settingsList.replaceChildren();
  for (const target of shortcutTargets) {
    const binding = bindingFor(target.id);
    const row = document.createElement("div");
    row.className = "binding-row";
    row.dataset.shortcutTarget = target.id;

    const copy = document.createElement("span");
    copy.className = "binding-copy";
    const label = document.createElement("strong");
    label.textContent = target.label;
    const description = document.createElement("small");
    description.textContent = target.description;
    const identity = document.createElement("code");
    identity.textContent = target.id;
    copy.append(label, description, identity);

    const capture = document.createElement("button");
    capture.type = "button";
    capture.className = "binding-capture";
    capture.dataset.shortcutTarget = target.id;
    capture.dataset.recording = String(recordingShortcut === target.id);
    capture.disabled = operationBusy;
    capture.ariaLabel = `Change shortcut for ${target.label}`;
    const key = document.createElement("kbd");
    key.textContent =
      recordingShortcut === target.id ? "Press shortcut" : displayKeyBinding(binding, isMac);
    capture.append(key);
    capture.addEventListener("click", () => beginShortcutRecording(target.id));
    capture.addEventListener("keydown", (event) => captureShortcut(event, target.id));

    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "binding-clear";
    clear.disabled = operationBusy || binding === null;
    clear.ariaLabel = `Clear shortcut for ${target.label}`;
    clear.textContent = "Clear";
    clear.addEventListener("click", () => void persistKeyBinding(target.id, null));

    const controls = document.createElement("span");
    controls.className = "binding-controls";
    controls.append(capture, clear);
    row.append(copy, controls);
    elements.settingsList.append(row);
  }
}

function selectPaletteIndex(index: number, scrollIntoView: boolean): void {
  paletteSelection = index;
  const options = [
    ...elements.paletteResults.querySelectorAll<HTMLButtonElement>(".palette-option"),
  ];
  for (const [optionIndex, option] of options.entries()) {
    const active = optionIndex === index;
    option.dataset.active = String(active);
    option.setAttribute("aria-selected", String(active));
  }
  const activeOption = options[index];
  if (activeOption) {
    elements.paletteQuery.setAttribute("aria-activedescendant", activeOption.id);
    const command = paletteMatches[index];
    elements.paletteHint.textContent = command ? `Ready: ${command.label}` : "Ready";
    if (scrollIntoView) {
      activeOption.scrollIntoView({ block: "nearest" });
    }
  } else {
    elements.paletteQuery.removeAttribute("aria-activedescendant");
    elements.paletteHint.textContent = "No command selected";
  }
}

function renderPaletteResults(): void {
  if (!elements.commandPalette.open) {
    return;
  }
  const selectedId = paletteMatches[paletteSelection]?.id;
  paletteMatches = filterPaletteCommands(commandCatalog(), elements.paletteQuery.value);
  const preservedIndex = selectedId
    ? paletteMatches.findIndex((command) => command.id === selectedId && command.enabled)
    : -1;
  paletteSelection =
    preservedIndex >= 0 ? preservedIndex : firstEnabledPaletteIndex(paletteMatches);
  elements.paletteResults.replaceChildren();

  for (const [index, command] of paletteMatches.entries()) {
    const option = document.createElement("button");
    option.id = `palette-option-${index}`;
    option.type = "button";
    option.className = "palette-option";
    option.dataset.commandId = command.id;
    option.setAttribute("role", "option");
    option.disabled = !command.enabled;

    const mark = document.createElement("span");
    mark.className = "palette-option-mark";
    mark.ariaHidden = "true";
    mark.textContent = command.enabled ? "◇" : "×";
    const copy = document.createElement("span");
    copy.className = "palette-option-copy";
    const label = document.createElement("strong");
    label.textContent = command.label;
    const identity = document.createElement("small");
    identity.textContent = `${command.category} · ${command.id}`;
    copy.append(label, identity);
    const meta = document.createElement("span");
    meta.className = "palette-option-meta";
    if (command.shortcut) {
      const shortcut = document.createElement("kbd");
      shortcut.textContent = command.shortcut;
      meta.append(shortcut);
    }
    if (!command.enabled) {
      const reason = document.createElement("small");
      reason.textContent = command.disabledReason ?? "Unavailable";
      meta.append(reason);
    }
    option.append(mark, copy, meta);
    option.addEventListener("click", () => void executeRendererCommand(command.id));
    option.addEventListener("mousemove", () => {
      if (command.enabled) {
        selectPaletteIndex(index, false);
      }
    });
    elements.paletteResults.append(option);
  }

  if (paletteMatches.length === 0) {
    const empty = document.createElement("p");
    empty.className = "palette-empty";
    empty.textContent = "No command matches this search.";
    elements.paletteResults.append(empty);
  }
  const enabledCount = paletteMatches.filter((command) => command.enabled).length;
  elements.paletteCount.textContent = `${enabledCount} available · ${paletteMatches.length} shown`;
  selectPaletteIndex(paletteSelection, false);
}

function currentVaultSearchIdentity(): { vaultId: string; indexGeneration: number } | null {
  if (vaultOpening()) {
    return null;
  }
  const vaultId = currentSnapshot?.vault.id;
  const indexGeneration = currentSnapshot?.workspace?.indexGeneration;
  return vaultId && indexGeneration !== undefined ? { vaultId, indexGeneration } : null;
}

function vaultSearchStateMatches(
  query: string,
  identity: { vaultId: string; indexGeneration: number },
): boolean {
  if (vaultSearchState.status === "idle") {
    return false;
  }
  if (vaultSearchState.status === "ready") {
    return (
      vaultSearchState.response.query.trim() === query &&
      vaultSearchState.response.vaultId === identity.vaultId &&
      vaultSearchState.response.indexGeneration === identity.indexGeneration
    );
  }
  return (
    vaultSearchState.query === query &&
    vaultSearchState.vaultId === identity.vaultId &&
    vaultSearchState.indexGeneration === identity.indexGeneration
  );
}

function scheduleVaultSearch(delay = 120, renderNow = true): void {
  const query = elements.fileSearch.value.trim();
  vaultSearchRequest += 1;
  const request = vaultSearchRequest;
  if (vaultSearchTimer !== undefined) {
    window.clearTimeout(vaultSearchTimer);
    vaultSearchTimer = undefined;
  }
  if (!query) {
    vaultSearchState = { status: "idle" };
    if (renderNow) {
      renderFiles(currentSnapshot?.workspace?.files ?? [], loadedNote?.path ?? null);
    }
    return;
  }
  const identity = currentVaultSearchIdentity();
  if (!identity) {
    vaultSearchState = {
      status: "error",
      query,
      vaultId: "",
      indexGeneration: -1,
      message: "The vault index is not ready yet.",
    };
    if (renderNow) {
      renderFiles(currentSnapshot?.workspace?.files ?? [], loadedNote?.path ?? null);
    }
    return;
  }
  vaultSearchState = { status: "loading", query, ...identity };
  if (renderNow) {
    renderFiles(currentSnapshot?.workspace?.files ?? [], loadedNote?.path ?? null);
  }
  vaultSearchTimer = window.setTimeout(() => {
    vaultSearchTimer = undefined;
    void performVaultSearch(query, identity, request);
  }, delay);
}

async function performVaultSearch(
  query: string,
  identity: { vaultId: string; indexGeneration: number },
  request: number,
): Promise<void> {
  try {
    const response = await window.threadleaf.searchVault(query);
    if (request !== vaultSearchRequest || elements.fileSearch.value.trim() !== query) {
      return;
    }
    const currentIdentity = currentVaultSearchIdentity();
    if (
      !currentIdentity ||
      response.vaultId !== currentIdentity.vaultId ||
      response.indexGeneration !== currentIdentity.indexGeneration ||
      identity.vaultId !== currentIdentity.vaultId ||
      identity.indexGeneration !== currentIdentity.indexGeneration
    ) {
      scheduleVaultSearch(0);
      return;
    }
    vaultSearchState = response.error
      ? { status: "error", query, ...identity, message: response.error }
      : { status: "ready", response };
  } catch (error) {
    if (request !== vaultSearchRequest || elements.fileSearch.value.trim() !== query) {
      return;
    }
    vaultSearchState = {
      status: "error",
      query,
      ...identity,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  renderFiles(currentSnapshot?.workspace?.files ?? [], loadedNote?.path ?? null);
}

function reconcileVaultSearch(snapshot: RuntimeSnapshot): void {
  if (snapshot.startup?.phase === "opening") {
    if (vaultSearchTimer !== undefined) {
      window.clearTimeout(vaultSearchTimer);
      vaultSearchTimer = undefined;
    }
    vaultSearchRequest += 1;
    vaultSearchState = { status: "idle" };
    return;
  }
  const query = elements.fileSearch.value.trim();
  if (!query) {
    if (vaultSearchTimer !== undefined) {
      window.clearTimeout(vaultSearchTimer);
      vaultSearchTimer = undefined;
    }
    if (vaultSearchState.status !== "idle") {
      vaultSearchRequest += 1;
      vaultSearchState = { status: "idle" };
    }
    return;
  }
  const vaultId = snapshot.vault.id;
  const indexGeneration = snapshot.workspace?.indexGeneration;
  if (!vaultId || indexGeneration === undefined) {
    return;
  }
  if (!vaultSearchStateMatches(query, { vaultId, indexGeneration })) {
    scheduleVaultSearch(0, false);
  }
}

function workspacePaneIdsInRenderOrder(activePaneId: WorkspacePaneId): readonly WorkspacePaneId[] {
  return activePaneId === "primary" ? ["secondary", "primary"] : ["primary", "secondary"];
}

function renderWorkspacePanes(
  snapshot: RuntimeSnapshot,
  workspace: RuntimeSnapshot["workspace"],
): WorkspaceNoteSnapshot | null {
  captureActivePaneSession();
  const availablePaneIds = new Set(workspace?.panes.map((pane) => pane.id) ?? ["primary"]);
  const activePaneId = workspace?.activePaneId ?? "primary";
  const paneCount = availablePaneIds.size;
  elements.workspacePanes.dataset.splitDirection = workspace?.splitDirection ?? "none";

  for (const paneId of ["primary", "secondary"] as const) {
    const pane = paneElements.get(paneId);
    if (!pane) {
      continue;
    }
    const available = availablePaneIds.has(paneId);
    const paneSnapshot = workspace?.panes.find((candidate) => candidate.id === paneId);
    pane.workspacePane.hidden = !available;
    pane.workspacePane.dataset.active = String(available && paneId === activePaneId);
    pane.workspacePane.setAttribute(
      "aria-label",
      `${paneId === "primary" ? "Primary" : "Secondary"} editor pane${paneId === activePaneId ? ", active" : ""}`,
    );
    pane.moveTabPane.hidden = paneCount < 2;
    pane.closePane.hidden = paneCount < 2;
    pane.splitPaneRight.setAttribute(
      "aria-pressed",
      String(paneCount > 1 && workspace?.splitDirection === "vertical"),
    );
    pane.splitPaneDown.setAttribute(
      "aria-pressed",
      String(paneCount > 1 && workspace?.splitDirection === "horizontal"),
    );
    const session = paneSession(paneId);
    const historyBlocked = busy || session.saving || session.dirty;
    pane.navigateBack.disabled = !available || historyBlocked || !paneSnapshot?.canGoBack;
    pane.navigateForward.disabled = !available || historyBlocked || !paneSnapshot?.canGoForward;
    pane.navigateBack.title = session.dirty
      ? "Save or revert the open draft before navigating note history"
      : "Go back in note history";
    pane.navigateForward.title = session.dirty
      ? "Save or revert the open draft before navigating note history"
      : "Go forward in note history";
  }

  const displayedNotes = new Map<WorkspacePaneId, WorkspaceNoteSnapshot | null>();
  for (const paneId of workspacePaneIdsInRenderOrder(activePaneId)) {
    const pane = workspace?.panes.find((candidate) => candidate.id === paneId);
    if (!pane) {
      runInPaneContext(paneId, () => {
        if (!dirty && loadedNote) {
          replaceEditorDocument(null, null);
        }
      });
      continue;
    }
    activatePaneContext(paneId);
    syncEditorAccess();
    if (paneId !== activePaneId && documentViewMode === "plugin") {
      documentViewMode = editingViewMode;
    }
    if (pane.activeCanvas) {
      const paneUi = paneElements.get(paneId);
      if (!paneUi) continue;
      if (loadedNote || dirty) {
        replaceEditorDocument(null, null);
      }
      loadedNote = null;
      loadedVaultId = null;
      paneUi.noteEmpty.hidden = true;
      paneUi.noteView.hidden = true;
      paneUi.canvasView.hidden = false;
      paneUi.notePath.textContent = pane.activeCanvas.path;
      canvasViews.get(paneId)?.render(pane.activeCanvas);
      displayedNotes.set(paneId, null);
      continue;
    }
    const displayedNote = reconcileEditor(pane.activeNote, snapshot.vault.id);
    displayedNotes.set(paneId, displayedNote);
    const paneUi = paneElements.get(paneId);
    if (paneUi) {
      paneUi.canvasView.hidden = true;
    }
    renderNote(displayedNote);
    renderUnavailableNotice(displayedNote ? null : pane.activeUnavailable);
  }

  activatePaneContext(activePaneId);
  const displayedNote = displayedNotes.get(activePaneId) ?? null;
  if (workspace?.panes.find((pane) => pane.id === activePaneId)?.activeCanvas) {
    renderNote(null);
    elements.noteEmpty.hidden = true;
    elements.noteView.hidden = true;
    elements.canvasView.hidden = false;
  } else {
    renderNote(displayedNote);
    renderUnavailableNotice(
      displayedNote
        ? null
        : workspace?.panes.find((pane) => pane.id === activePaneId)?.activeUnavailable,
    );
  }
  return displayedNote;
}

function renderWorkspaceLayout(layout: WorkspaceLayoutSnapshot | null | undefined): void {
  if (!layout) {
    return;
  }
  workspaceLayoutSnapshot = layout;
  elements.workspaceRoot.dataset.leftDockCollapsed = String(layout.docks.left.collapsed);
  elements.workspaceRoot.dataset.rightDockCollapsed = String(layout.docks.right.collapsed);
  const leftCollapsed = layout.docks.left.collapsed;
  elements.collapseLeftDock.setAttribute("aria-expanded", String(!leftCollapsed));
  elements.collapseLeftDock.setAttribute(
    "aria-label",
    `${leftCollapsed ? "Expand" : "Collapse"} notes dock`,
  );
  elements.collapseLeftDock.title = leftCollapsed ? "Expand notes dock" : "Collapse notes dock";
  elements.collapseLeftDock.textContent = leftCollapsed ? "›" : "‹";
  const rightCollapsed = layout.docks.right.collapsed;
  elements.collapseRightDock.setAttribute("aria-expanded", String(!rightCollapsed));
  elements.collapseRightDock.setAttribute(
    "aria-label",
    `${rightCollapsed ? "Expand" : "Collapse"} inspector dock`,
  );
  elements.collapseRightDock.title = rightCollapsed
    ? "Expand inspector dock"
    : "Collapse inspector dock";
  elements.collapseRightDock.textContent = rightCollapsed ? "‹" : "›";
  const warning =
    layout.popout.warning ?? layout.docks.left.warning ?? layout.docks.right.warning ?? null;
  const warningKey = warning ? `${layout.vaultId}\u0000${warning}` : null;
  if (warning && warningKey !== lastWorkspaceLayoutWarningKey) {
    showToast(warning);
  }
  lastWorkspaceLayoutWarningKey = warningKey;
}

async function toggleWorkspaceDock(dockId: "left" | "right"): Promise<void> {
  const expectedVaultId = currentSnapshot?.vault.id;
  const layout = workspaceLayoutSnapshot;
  if (!expectedVaultId || !layout || busy) {
    return;
  }
  setActionState(true);
  try {
    renderWorkspaceLayout(
      await window.threadleaf.setWorkspaceDockCollapsed(
        dockId,
        !layout.docks[dockId].collapsed,
        expectedVaultId,
      ),
    );
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  } finally {
    setActionState(false);
  }
}

async function togglePluginPopout(): Promise<void> {
  const expectedVaultId = currentSnapshot?.vault.id;
  if (!expectedVaultId || busy) {
    return;
  }
  setActionState(true);
  try {
    const popoutOpen = workspaceLayoutSnapshot?.popout.state === "open";
    renderWorkspaceLayout(
      popoutOpen
        ? await window.threadleaf.reattachPluginView(expectedVaultId)
        : await window.threadleaf.popOutPluginView(expectedVaultId),
    );
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  } finally {
    setActionState(false);
  }
}

function render(snapshot: RuntimeSnapshot): void {
  const diagnosticsStartedAt = snapshot.workspaceOpenDiagnostics ? performance.now() : null;
  const previousVaultId = currentSnapshot?.vault.id ?? null;
  currentSnapshot = snapshot;
  if (previousVaultId !== snapshot.vault.id) {
    workspaceModeRequest += 1;
    resetPaneDocumentModes(snapshot.vault.id);
    if (settingsLoaded && snapshot.vault.id) {
      applyWorkspaceViewDefaults(currentWorkspacePreference());
    }
  }
  renderWorkspaceLayout(snapshot.workspaceLayout);
  if (snapshot.vault.id) {
    graphView.onSnapshot({
      vaultId: snapshot.vault.id,
      vaultName: snapshot.vault.name,
      indexGeneration: snapshot.workspace?.indexGeneration ?? 0,
      rootPath: loadedNote?.path ?? null,
    });
    recoveryView.onSnapshot({
      vaultId: snapshot.vault.id,
      vaultName: snapshot.vault.name,
      readOnly: snapshot.vault.mode === "synthetic-read-only",
    });
  }
  if (previousVaultId !== snapshot.vault.id) {
    if (elements.quickSwitcher.open) {
      closeQuickSwitcher(false);
    }
    bookmarkRequest += 1;
    bookmarkVaultId = null;
    bookmarkPaths = [];
    bookmarkBusy = false;
    lastBookmarkWarning = null;
    for (const paneId of ["primary", "secondary"] as const) {
      runInPaneContext(paneId, () => {
        editorDraftRestoreRequest += 1;
        editorDraftCheckedVaultId = null;
        if (documentViewMode === "plugin") {
          documentViewMode = editingViewMode;
        }
      });
    }
    elements.fileList.scrollTop = 0;
    lastVirtualActivePath = null;
    virtualFileRenderKey = "";
    pluginSurfaceRequest += 1;
    pluginSettingsTargetId = null;
    pluginLayoutReadyVaultId = null;
    appearanceRequest += 1;
    appearanceBusy = false;
    appearanceSnapshot = null;
    applyAppearanceCss(appearanceStyle, "");
    lastAppearanceWarning = "";
    noteWorkflowRequest += 1;
    noteWorkflowBusy = false;
    noteWorkflowCatalog = null;
    noteWorkflowDraft = null;
    noteWorkflowMessage = "Discovering templates and daily-note preferences in this vault.";
    noteWorkflowMessageKind = "info";
    workspaceSettingsRequest += 1;
    workspaceSettingsBusy = false;
    workspaceSettingsDraft = null;
    workspaceSettingsMessage = "Workspace preferences are private to this vault.";
    workspaceSettingsMessageKind = "info";
    pluginRequest += 1;
    pluginPackageRequest += 1;
    pluginBusy = false;
    pluginCatalog = null;
    pluginPackageIndex = null;
    pluginPackageReview = null;
    if (elements.pluginPackageReviewDialog.open) {
      elements.pluginPackageReviewDialog.close();
    }
    if (elements.pluginAuthorityReviewDialog.open) {
      elements.pluginAuthorityReviewDialog.close();
    }
    pluginStyle.textContent = "";
    lastPluginWarning = "";
    const staleAppearanceReview = appearancePackageReview;
    appearancePackageRequest += 1;
    appearancePackageBusy = false;
    appearancePackages = [];
    appearancePackagesVaultId = null;
    appearancePackageReview = null;
    appearancePackageMessage = "No package changes have been reviewed yet.";
    appearancePackageMessageKind = "info";
    if (elements.appearancePackageReviewDialog.open) {
      elements.appearancePackageReviewDialog.close();
    }
    if (staleAppearanceReview) {
      void window.threadleaf
        .cancelAppearancePackageReview(
          staleAppearanceReview.vaultId,
          staleAppearanceReview.reviewId,
        )
        .catch(() => undefined);
    }
    migrationRequest += 1;
    migrationMutationRequest += 1;
    migrationBusy = false;
    migrationPreview = null;
    migrationPlan = null;
    migrationSelection = new Set();
    migrationLastTransactionId = null;
    migrationApplyBusy = false;
    migrationMessage = "Inspecting existing Obsidian behavior for this vault.";
    migrationMessageKind = "info";
    lastPluginEditorUpdateId = null;
    applyColorScheme(currentAppearancePreference().colorScheme);
    void refreshAppearance();
    void refreshAppearancePackages();
    void refreshNoteWorkflows();
    void refreshWorkspaceSettings();
    void refreshPlugins();
    void refreshMigrationPreview();
    void maybeMigrateLegacyTheme();
    if (snapshot.vault.id) {
      void refreshNoteBookmarks(snapshot.vault.id);
    }
  }
  const startup = snapshot.startup;
  const opening = startup?.phase === "opening";
  const workspace = opening ? undefined : snapshot.workspace;
  const plugin = opening ? null : snapshot.plugin;
  elements.vaultName.textContent = opening ? startup.targetName : snapshot.vault.name;
  elements.vaultIdentity.title = opening ? startup.targetPath : snapshot.vault.path;
  elements.vaultMode.title = opening ? startup.targetPath : snapshot.vault.path;
  elements.vaultSource.textContent = opening
    ? startup.source === "restored"
      ? "Restoring vault"
      : "Configured vault"
    : snapshot.vault.source === "bundled"
      ? "Bundled read-only demo"
      : snapshot.vault.source === "environment"
        ? "Development vault"
        : snapshot.vault.source === "restored"
          ? "Restored vault"
          : "Local vault";
  elements.fileCount.textContent = opening
    ? "…"
    : String(workspace?.files.length ?? snapshot.vault.markdownFileCount);
  const activePane = workspace?.panes.find((pane) => pane.id === workspace?.activePaneId);
  renderCanvasFiles(
    workspace?.canvasFiles ?? [],
    activePane?.activeCanvas?.path ?? activePane?.activeNote?.path ?? null,
  );
  const needsAttention =
    !opening && (workspace?.state === "degraded" || snapshot.vault.warning !== null);
  elements.runtimeState.textContent = opening
    ? "Opening"
    : needsAttention
      ? "Needs attention"
      : "Ready";
  elements.statusShape.dataset.state = opening ? "opening" : needsAttention ? "degraded" : "ready";
  elements.indexStatus.textContent = opening ? "Indexing" : workspace ? "Current" : "Unavailable";
  elements.recoveryCount.textContent = String(workspace?.recoveryActionCount ?? 0);
  elements.watchSequence.textContent = String(workspace?.watcher.lastSequence ?? 0);
  elements.watchMessage.textContent = opening
    ? `Building the local index for ${startup.targetName}`
    : snapshot.vault.warning
      ? snapshot.vault.warning
      : workspace?.watcher.error
        ? `Watcher error: ${workspace.watcher.error}`
        : workspace?.watcher.lastRescanReason
          ? `Recovered by ${workspace.watcher.lastRescanReason} rescan`
          : "Filesystem and index agree";
  if (snapshot.vault.warning && snapshot.vault.warning !== lastVaultWarning) {
    showToast(snapshot.vault.warning);
  }
  lastVaultWarning = snapshot.vault.warning;

  const displayedNote = renderWorkspacePanes(snapshot, workspace);
  applyPluginEditorUpdate(snapshot.editorUpdate);
  if (
    pluginSettingsTargetId &&
    snapshot.pluginSurface?.viewType !== "threadleaf-plugin-settings" &&
    !(snapshot.integrations?.settingTabPluginIds ?? []).includes(pluginSettingsTargetId)
  ) {
    pluginSettingsTargetId = null;
  }
  if (
    documentViewMode === "plugin" &&
    !snapshot.pluginSurface &&
    !preferredPluginViewType(snapshot) &&
    pluginSettingsTargetId === null
  ) {
    setDocumentView(editingViewMode, false);
  }
  reconcileVaultSearch(snapshot);
  renderQuickSwitcherResults();
  renderFiles(workspace?.files ?? [], displayedNote?.path ?? null);
  renderNoteBookmarks(workspace?.files ?? [], displayedNote?.path ?? null);

  elements.pluginState.textContent = plugin?.state ?? "empty";
  elements.pluginState.dataset.state = plugin?.state ?? "empty";
  elements.pluginName.textContent = plugin?.name ?? "Not loaded";
  elements.pluginTrustLabel.textContent = plugin
    ? "Trusted compatibility plugin"
    : "Plugins stay off by default";
  elements.compatibilityLevel.textContent = `Level ${plugin?.compatibilityLevel ?? 0}`;
  elements.commandCount.textContent = String(snapshot.commands.length);
  renderCommands(snapshot);
  renderEvents(snapshot);
  setActionState(busy);
  elements.fileSearch.disabled = opening;
  elements.openVault.disabled = busy || anyPaneSaving();
  elements.newNote.disabled =
    opening || readOnlyVault() || busy || anyPaneSaving() || anyPaneDirty();
  if (elements.newNoteDialog.open) {
    renderNewNoteDialog();
  }
  if (elements.templatePickerDialog.open) {
    renderTemplatePickerDialog();
  }
  if (elements.propertyDialog.open) {
    renderPropertyDialog();
  }
  if (elements.moveNoteDialog.open) {
    renderMoveNoteDialog();
  }
  if (elements.attachmentMoveDialog.open) {
    renderAttachmentMoveDialog();
  }
  if (elements.deleteNoteDialog.open) {
    renderDeleteNoteDialog();
  }
  for (const pane of workspace?.panes ?? []) {
    runInPaneContext(pane.id, () => maybeRestoreEditorDraft(snapshot));
  }
  activatePaneContext(workspace?.activePaneId ?? "primary");
  if (snapshot.workspaceOpenDiagnostics && diagnosticsStartedAt !== null) {
    window.threadleaf.reportWorkspaceOpenDiagnostics({
      phase: "rendered",
      transferId: snapshot.workspaceOpenDiagnostics.transferId,
      durationMs: Math.max(0, performance.now() - diagnosticsStartedAt),
      objectCount: measureSerializableValue(snapshot).objects,
    });
  }
}

function clearTabDragVisual(tabsElement: HTMLElement): void {
  tabsElement.dataset.dragging = "false";
  for (const tab of tabsElement.querySelectorAll<HTMLElement>(".workspace-tab-header")) {
    tab.dataset.dragTarget = "false";
  }
}

function clearWorkspaceTabDragVisuals(): void {
  for (const pane of paneElements.values()) {
    clearTabDragVisual(pane.noteTabs);
  }
}

function tabRectangles(tabsElement: HTMLElement): Array<{
  index: number;
  left: number;
  right: number;
  pinned: boolean;
}> {
  return [...tabsElement.querySelectorAll<HTMLElement>(".workspace-tab-header")].map((tab) => {
    const bounds = tab.getBoundingClientRect();
    return {
      index: Number.parseInt(tab.dataset.tabIndex ?? "", 10),
      left: bounds.left,
      right: bounds.right,
      pinned: tab.dataset.pinned === "true",
    };
  });
}

function updateTabDragTarget(
  paneId: WorkspacePaneId,
  tabsElement: HTMLElement,
  pointerX: number,
): number | null {
  if (!currentTabDrag) {
    return null;
  }
  clearWorkspaceTabDragVisuals();
  const targetIndex =
    tabInsertionIndex(pointerX, tabRectangles(tabsElement), currentTabDrag.sourcePinned) ??
    (() => {
      const targetTabs = workspacePaneSnapshot(paneId)?.tabs ?? [];
      const pinnedCount = targetTabs.filter((tab) => tab.pinned).length;
      if (currentTabDrag.sourcePinned) {
        return pinnedCount === 0 ? 0 : null;
      }
      return targetTabs.length;
    })();
  for (const tab of tabsElement.querySelectorAll<HTMLElement>(".workspace-tab-header")) {
    tab.dataset.dragTarget = String(
      Number.parseInt(tab.dataset.tabIndex ?? "", 10) === targetIndex &&
        tab.dataset.pinned === String(currentTabDrag.sourcePinned),
    );
  }
  currentTabDrag = {
    ...currentTabDrag,
    targetPaneId: paneId,
    insertionIndex: targetIndex ?? currentTabDrag.insertionIndex,
  };
  return targetIndex;
}

function tabsElementForPane(paneId: WorkspacePaneId): HTMLElement {
  const pane = paneElements.get(paneId);
  if (!pane) {
    throw new Error(`Missing workspace tab surface: ${paneId}`);
  }
  return pane.noteTabs;
}

function finishTabDrag(
  targetIndex: number | null = null,
  targetPaneId: WorkspacePaneId | null = currentTabDrag?.targetPaneId ?? null,
): void {
  const drag = currentTabDrag;
  clearWorkspaceTabDragVisuals();
  currentTabDrag = null;
  if (!drag || busy || saving || anyPaneDirty()) {
    return;
  }
  const expectedVaultId = currentSnapshot?.vault.id;
  if (!expectedVaultId) {
    return;
  }
  if (drag.targetPaneId !== drag.paneId && targetPaneId === drag.targetPaneId) {
    void runAction(async () => {
      const moved = await window.threadleaf.moveNoteToWorkspacePane(
        drag.path,
        drag.paneId,
        drag.targetPaneId,
        expectedVaultId,
      );
      if (targetIndex === null) {
        return moved;
      }
      return window.threadleaf.reorderWorkspaceTab(
        drag.path,
        drag.targetPaneId,
        targetIndex,
        expectedVaultId,
      );
    });
    return;
  }
  if (targetIndex === null || targetPaneId !== drag.paneId) {
    return;
  }
  void runAction(() =>
    window.threadleaf.reorderWorkspaceTab(drag.path, drag.paneId, targetIndex, expectedVaultId),
  );
}

function tabPaneAtPoint(clientX: number, clientY: number): WorkspacePaneId | null {
  const element = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>(".note-tabs");
  if (!element) {
    return null;
  }
  for (const [paneId, pane] of paneElements) {
    if (pane.noteTabs === element) {
      return paneId;
    }
  }
  return null;
}

function updateTabDragAtPoint(clientX: number, clientY: number): number | null {
  const paneId = tabPaneAtPoint(clientX, clientY);
  if (!paneId) {
    clearWorkspaceTabDragVisuals();
    return null;
  }
  return updateTabDragTarget(paneId, tabsElementForPane(paneId), clientX);
}

function bindWorkspaceKeyboardShortcuts(): void {
  if (workspaceKeyboardShortcutsBound) {
    return;
  }
  workspaceKeyboardShortcutsBound = true;
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button !== 0 || busy || saving || anyPaneDirty()) {
        return;
      }
      const target =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>(".note-tab-activate")
          : null;
      const wrapper = target?.closest<HTMLElement>(".workspace-tab-header");
      const paneElement = wrapper?.closest<HTMLElement>(".workspace-pane");
      const paneId =
        paneElement?.dataset.paneId === "primary" || paneElement?.dataset.paneId === "secondary"
          ? paneElement.dataset.paneId
          : null;
      const path = target?.dataset.notePath;
      const tabIndex = Number.parseInt(wrapper?.dataset.tabIndex ?? "", 10);
      if (!wrapper || !paneId || !path || !Number.isSafeInteger(tabIndex)) {
        return;
      }
      pointerTabGesture = {
        id: event.pointerId,
        path,
        paneId,
        sourcePinned: wrapper.dataset.pinned === "true",
        insertionIndex: tabIndex,
        startX: event.clientX,
        startY: event.clientY,
      };
    },
    true,
  );
  document.addEventListener(
    "pointermove",
    (event) => {
      const gesture = pointerTabGesture;
      if (!gesture || gesture.id !== event.pointerId) {
        return;
      }
      if (!currentTabDrag) {
        const distance = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY);
        if (distance < 5) {
          return;
        }
        suppressPointerActivationPath = gesture.path;
        currentTabDrag = {
          path: gesture.path,
          paneId: gesture.paneId,
          targetPaneId: gesture.paneId,
          sourcePinned: gesture.sourcePinned,
          insertionIndex: gesture.insertionIndex,
        };
        tabsElementForPane(gesture.paneId).dataset.dragging = "true";
      }
      event.preventDefault();
      updateTabDragAtPoint(event.clientX, event.clientY);
    },
    true,
  );
  document.addEventListener(
    "pointerup",
    (event) => {
      const gesture = pointerTabGesture;
      if (!gesture || gesture.id !== event.pointerId) {
        return;
      }
      pointerTabGesture = null;
      if (currentTabDrag?.path !== gesture.path) {
        return;
      }
      event.preventDefault();
      const targetPaneId = tabPaneAtPoint(event.clientX, event.clientY);
      const targetIndex = targetPaneId
        ? updateTabDragTarget(targetPaneId, tabsElementForPane(targetPaneId), event.clientX)
        : null;
      finishTabDrag(targetIndex, targetPaneId ?? gesture.paneId);
      window.setTimeout(() => {
        if (suppressPointerActivationPath === gesture.path) {
          suppressPointerActivationPath = null;
        }
      }, 0);
    },
    true,
  );
  document.addEventListener(
    "pointercancel",
    (event) => {
      const gesture = pointerTabGesture;
      if (!gesture || gesture.id !== event.pointerId) {
        return;
      }
      pointerTabGesture = null;
      suppressPointerActivationPath = null;
      if (currentTabDrag?.path === gesture.path) {
        finishTabDrag(null, gesture.paneId);
      }
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
        return;
      }
      if (!event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }
      if (!(event.target instanceof Node) || !elements.workspacePanes.contains(event.target)) {
        return;
      }
      const focusedTab =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>(".workspace-tab-header")
          : null;
      const focusedPane = focusedTab?.closest<HTMLElement>(".workspace-pane");
      const paneId =
        focusedPane?.dataset.paneId === "primary" || focusedPane?.dataset.paneId === "secondary"
          ? focusedPane.dataset.paneId
          : activePaneContextId;
      const pane = workspacePaneSnapshot(paneId);
      if (!pane) {
        return;
      }
      const filePath =
        focusedTab?.querySelector<HTMLElement>(".note-tab-activate")?.dataset.notePath ??
        pane.tabs.find((tab) => tab.active)?.path;
      if (!filePath) {
        return;
      }
      if (event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        void moveTabToOtherPane(filePath, paneId);
        return;
      }
      const sourceIndex = pane.tabs.findIndex((tab) => tab.path === filePath);
      if (sourceIndex === -1) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void reorderTab(filePath, paneId, sourceIndex + (event.key === "ArrowRight" ? 1 : -1));
    },
    true,
  );
}

function bindTabDragSurface(paneId: WorkspacePaneId, tabsElement: HTMLElement): void {
  bindWorkspaceKeyboardShortcuts();
  if (tabsElement.dataset.dragBound === "true") {
    return;
  }
  tabsElement.dataset.dragBound = "true";
  tabsElement.addEventListener("dragover", (event) => {
    if (!currentTabDrag || busy || saving || anyPaneDirty()) {
      return;
    }
    event.preventDefault();
    updateTabDragTarget(paneId, tabsElement, event.clientX);
  });
  tabsElement.addEventListener("drop", (event) => {
    if (!currentTabDrag) {
      return;
    }
    event.preventDefault();
    const targetIndex = updateTabDragTarget(paneId, tabsElement, event.clientX);
    finishTabDrag(targetIndex, paneId);
  });
  tabsElement.addEventListener("dragleave", (event) => {
    if (event.relatedTarget instanceof Node && tabsElement.contains(event.relatedTarget)) {
      return;
    }
    clearTabDragVisual(tabsElement);
  });
}

function renderTabs(tabs: WorkspaceTabSummary[], displayedPath: string | null): void {
  const paneId = activePaneContextId;
  bindTabDragSurface(paneId, elements.noteTabs);
  elements.noteTabs.replaceChildren();
  if (tabs.length === 0) {
    const empty = document.createElement("span");
    empty.className = "note-tabs-empty";
    empty.textContent = "No open notes";
    elements.noteTabs.append(empty);
    return;
  }

  const runtimeActivePath = tabs.find((tab) => tab.active)?.path ?? null;
  let activeTab: HTMLElement | null = null;
  let renderedPinnedTab = false;
  for (const [tabIndex, tab] of tabs.entries()) {
    if (!tab.pinned && renderedPinnedTab) {
      const divider = document.createElement("span");
      divider.className = "note-tabs-pin-divider";
      divider.setAttribute("role", "separator");
      divider.ariaLabel = "End of pinned tabs";
      elements.noteTabs.append(divider);
      renderedPinnedTab = false;
    }
    const isActive = tab.path === displayedPath;
    const wrapper = document.createElement("div");
    wrapper.className = "note-tab workspace-tab-header";
    wrapper.dataset.active = String(isActive);
    wrapper.dataset.pinned = String(tab.pinned);
    wrapper.dataset.tabIndex = String(tabIndex);
    wrapper.draggable = true;

    const activate = document.createElement("button");
    activate.type = "button";
    activate.className = "note-tab-activate";
    activate.setAttribute("role", "tab");
    activate.setAttribute("aria-selected", String(isActive));
    activate.setAttribute("aria-controls", elements.noteView.id);
    activate.tabIndex = isActive || (!displayedPath && tab.path === runtimeActivePath) ? 0 : -1;
    activate.dataset.notePath = tab.path;
    activate.title = tab.path;
    activate.ariaLabel = `${tab.pinned ? "Pinned " : ""}${
      isActive ? "current note" : "open note"
    }: ${tab.path}`;

    const mark = document.createElement("span");
    mark.className = "note-tab-mark";
    mark.ariaHidden = "true";
    mark.textContent = tab.pinned ? "PIN" : "◇";
    const title = document.createElement("span");
    title.className = "note-tab-title";
    title.textContent = tab.title;
    activate.append(mark, title);
    if (isActive) {
      activeTab = wrapper;
    }
    activate.addEventListener("click", () => {
      if (suppressPointerActivationPath === tab.path) {
        suppressPointerActivationPath = null;
        return;
      }
      void openNote(tab.path, undefined, paneId);
    });
    activate.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
        return;
      }
      event.preventDefault();
      if (!event.altKey && !event.ctrlKey && !event.metaKey) {
        void cycleTab(event.key === "ArrowRight" ? 1 : -1, paneId);
      }
    });

    wrapper.addEventListener("dragstart", (event) => {
      if (busy || saving || anyPaneDirty()) {
        event.preventDefault();
        showToast("Save or revert drafts before reordering tabs.");
        return;
      }
      currentTabDrag = {
        path: tab.path,
        paneId,
        targetPaneId: paneId,
        sourcePinned: tab.pinned,
        insertionIndex: tabIndex,
      };
      tabsElementForPane(paneId).dataset.dragging = "true";
      event.dataTransfer?.setData("text/plain", tab.path);
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
      }
    });
    wrapper.addEventListener("dragend", () => {
      if (currentTabDrag?.path === tab.path) {
        finishTabDrag(null, paneId);
      }
    });

    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "note-tab-pin";
    pin.dataset.notePath = tab.path;
    pin.dataset.pinned = String(tab.pinned);
    pin.ariaPressed = String(tab.pinned);
    pin.ariaLabel = `${tab.pinned ? "Unpin" : "Pin"} ${tab.path}`;
    pin.title = `${tab.pinned ? "Unpin" : "Pin"} ${tab.path}`;
    pin.textContent = tab.pinned ? "Unpin" : "Pin";
    pin.disabled = busy || saving;
    pin.addEventListener("click", (event) => {
      event.stopPropagation();
      void toggleTabPin(tab.path, paneId);
    });

    const close = document.createElement("button");
    close.type = "button";
    close.className = "note-tab-close";
    close.dataset.notePath = tab.path;
    close.ariaLabel = `Close ${tab.path}`;
    close.textContent = "×";
    close.disabled = busy || saving || (!tab.pinned && isActive && dirty);
    close.title = tab.pinned
      ? `Unpin ${tab.path} before closing it`
      : isActive && dirty
        ? "Save or revert this note before closing it"
        : `Close ${tab.path}`;
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      void closeTab(tab.path, paneId);
    });

    wrapper.append(activate, pin, close);
    elements.noteTabs.append(wrapper);
    renderedPinnedTab = tab.pinned;
  }
  if (activeTab) {
    const tab = activeTab;
    window.requestAnimationFrame(() => {
      if (tab.isConnected) {
        tab.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    });
  }
}

function renderFiles(files: WorkspaceFileSummary[], activePath: string | null): void {
  const query = elements.fileSearch.value.trim();
  if (vaultOpening()) {
    cancelVirtualFileRender();
    elements.fileList.dataset.mode = "empty";
    elements.fileList.replaceChildren();
    elements.fileList.setAttribute("aria-busy", "true");
    elements.fileList.setAttribute("aria-label", "Vault index progress");
    elements.filterSummary.textContent = "Building vault index";
    renderEmpty(
      elements.fileList,
      `Opening ${currentSnapshot?.startup?.targetName ?? "vault"} without blocking this window.`,
    );
    return;
  }
  elements.fileList.setAttribute(
    "aria-busy",
    String(query !== "" && vaultSearchState.status === "loading"),
  );
  elements.fileList.setAttribute("aria-label", query ? "Vault search results" : "Markdown files");

  if (query) {
    cancelVirtualFileRender();
    elements.fileList.dataset.mode = "search";
    elements.fileList.replaceChildren();
    renderVaultSearchResults(activePath, files.length);
    return;
  }

  elements.filterSummary.textContent = `${files.length} ${files.length === 1 ? "note" : "notes"} indexed`;
  const activeChanged = activePath !== lastVirtualActivePath;
  virtualFileState = { files, activePath };
  if (activeChanged && activePath) {
    const activeIndex = files.findIndex((file) => file.path === activePath);
    if (activeIndex >= 0) {
      elements.fileList.scrollTop = nearestItemScrollTop(
        activeIndex,
        virtualFileRowHeight,
        elements.fileList.scrollTop,
        Math.max(virtualFileRowHeight, elements.fileList.clientHeight),
      );
    }
  }
  lastVirtualActivePath = activePath;
  renderVirtualFiles(true);

  if (files.length === 0) {
    renderEmpty(elements.fileList, "No Markdown notes found.");
  }
}

function renderCanvasFiles(files: WorkspaceCanvasSummary[], activePath: string | null): void {
  elements.canvasFileCount.textContent = String(files.length);
  elements.canvasFileList.replaceChildren();
  if (files.length === 0) {
    const empty = document.createElement("p");
    empty.className = "canvas-shelf-empty";
    empty.textContent = "No JSON Canvases found.";
    elements.canvasFileList.append(empty);
    return;
  }
  for (const file of files) {
    const open = document.createElement("button");
    open.type = "button";
    open.className = "canvas-file-item";
    open.dataset.canvasPath = file.path;
    open.setAttribute("aria-current", String(file.path === activePath));
    open.setAttribute("aria-label", `Open canvas ${file.path}`);
    const mark = document.createElement("span");
    mark.className = "canvas-file-glyph";
    mark.textContent = "▦";
    mark.ariaHidden = "true";
    const copy = document.createElement("span");
    copy.className = "canvas-file-copy";
    const title = document.createElement("strong");
    title.textContent = file.title;
    const path = document.createElement("small");
    path.textContent = file.path;
    copy.append(title, path);
    open.append(mark, copy);
    open.addEventListener("click", () => void openNote(file.path));
    elements.canvasFileList.append(open);
  }
}

function bookmarkTitle(filePath: string): string {
  const slash = filePath.lastIndexOf("/");
  const filename = slash === -1 ? filePath : filePath.slice(slash + 1);
  return filename.toLocaleLowerCase("en-US").endsWith(".md") ? filename.slice(0, -3) : filename;
}

function renderNoteBookmarks(files: WorkspaceFileSummary[], activePath: string | null): void {
  const activeVaultId = currentSnapshot?.vault.id ?? null;
  const available = Boolean(activeVaultId && bookmarkVaultId === activeVaultId);
  const visiblePaths = available ? bookmarkPaths : [];
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  elements.bookmarkCount.textContent = String(visiblePaths.length);
  elements.bookmarkShelf.hidden = visiblePaths.length === 0;
  elements.bookmarkShelf.setAttribute("aria-busy", String(bookmarkBusy));
  elements.bookmarkList.replaceChildren();

  for (const filePath of visiblePaths) {
    const file = filesByPath.get(filePath);
    const missing = !file;
    const row = document.createElement("div");
    row.className = "bookmark-row";
    row.dataset.current = String(filePath === activePath);
    row.dataset.missing = String(missing);
    row.dataset.notePath = filePath;

    const open = document.createElement("button");
    open.type = "button";
    open.className = "bookmark-open";
    open.disabled = missing || busy;
    open.ariaLabel = missing ? `${filePath} is missing from the vault` : `Open ${filePath}`;
    if (filePath === activePath) {
      open.setAttribute("aria-current", "page");
    }

    const mark = document.createElement("span");
    mark.className = "bookmark-open-mark";
    mark.ariaHidden = "true";
    mark.textContent = missing ? "◇" : "★";
    const copy = document.createElement("span");
    copy.className = "bookmark-open-copy";
    const title = document.createElement("strong");
    title.textContent = file?.title ?? bookmarkTitle(filePath);
    const location = document.createElement("small");
    location.textContent = missing ? `Missing note · ${filePath}` : filePath;
    copy.append(title, location);
    open.append(mark, copy);
    if (!missing) {
      open.addEventListener("click", () => void openNote(filePath));
    }

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "bookmark-remove";
    remove.disabled = bookmarkBusy || busy;
    remove.ariaLabel = `Remove bookmark for ${filePath}`;
    remove.title = "Remove bookmark";
    remove.textContent = "×";
    remove.addEventListener("click", () => void setNoteBookmarked(filePath, false));

    row.append(open, remove);
    elements.bookmarkList.append(row);
  }
}

function renderBookmarkToggle(): void {
  const available = Boolean(
    loadedNote && loadedVaultId && bookmarkVaultId === loadedVaultId && !vaultOpening(),
  );
  const bookmarked = Boolean(available && loadedNote && bookmarkPaths.includes(loadedNote.path));
  elements.bookmarkNote.disabled = !available || busy || bookmarkBusy;
  elements.bookmarkNote.setAttribute("aria-pressed", String(bookmarked));
  elements.bookmarkNote.ariaLabel = bookmarked
    ? "Remove bookmark from current note"
    : "Bookmark current note";
  elements.bookmarkNote.title = available
    ? bookmarked
      ? "Remove bookmark"
      : "Bookmark note"
    : "Open a note in a vault with available bookmark storage";
  const mark = elements.bookmarkNote.querySelector<HTMLElement>(".bookmark-toolbar-mark");
  const label = elements.bookmarkNote.querySelector<HTMLElement>(".toolbar-action-label");
  if (mark) {
    mark.textContent = bookmarked ? "★" : "☆";
  }
  if (label) {
    label.textContent = bookmarked ? "Bookmarked" : "Bookmark";
  }
}

function renderBookmarkSurfaces(): void {
  renderAllPaneEditControls();
  renderNoteBookmarks(currentSnapshot?.workspace?.files ?? [], loadedNote?.path ?? null);
}

async function refreshNoteBookmarks(expectedVaultId: string): Promise<void> {
  const request = ++bookmarkRequest;
  try {
    const response = await window.threadleaf.getNoteBookmarks(expectedVaultId);
    if (request !== bookmarkRequest || currentSnapshot?.vault.id !== expectedVaultId) {
      return;
    }
    if (response.status === "stale-vault" || response.vaultId !== expectedVaultId) {
      bookmarkVaultId = null;
      bookmarkPaths = [];
      return;
    }
    bookmarkVaultId = response.vaultId;
    bookmarkPaths = [...response.paths];
    lastBookmarkWarning = null;
  } catch (error) {
    if (request !== bookmarkRequest || currentSnapshot?.vault.id !== expectedVaultId) {
      return;
    }
    bookmarkVaultId = null;
    bookmarkPaths = [];
    const message = error instanceof Error ? error.message : String(error);
    if (message !== lastBookmarkWarning) {
      showToast(`Bookmarks unavailable: ${message}`);
      lastBookmarkWarning = message;
    }
  } finally {
    if (request === bookmarkRequest && currentSnapshot?.vault.id === expectedVaultId) {
      renderBookmarkSurfaces();
    }
  }
}

async function setNoteBookmarked(filePath: string, bookmarked: boolean): Promise<void> {
  const expectedVaultId = currentSnapshot?.vault.id ?? null;
  if (!expectedVaultId || bookmarkVaultId !== expectedVaultId || bookmarkBusy || busy) {
    return;
  }
  bookmarkBusy = true;
  renderBookmarkSurfaces();
  try {
    const response = await window.threadleaf.setNoteBookmark(filePath, bookmarked, expectedVaultId);
    if (
      response.status !== "ready" ||
      response.vaultId !== expectedVaultId ||
      currentSnapshot?.vault.id !== expectedVaultId
    ) {
      showToast("The active vault changed before the bookmark was saved.");
      return;
    }
    bookmarkVaultId = response.vaultId;
    bookmarkPaths = [...response.paths];
    showToast(bookmarked ? `Bookmarked ${filePath}.` : `Removed bookmark for ${filePath}.`);
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  } finally {
    bookmarkBusy = false;
    renderBookmarkSurfaces();
  }
}

async function toggleCurrentNoteBookmark(): Promise<void> {
  if (!loadedNote) {
    return;
  }
  await setNoteBookmarked(loadedNote.path, !bookmarkPaths.includes(loadedNote.path));
}

function cancelVirtualFileRender(): void {
  if (virtualFileRenderFrame !== undefined) {
    window.cancelAnimationFrame(virtualFileRenderFrame);
    virtualFileRenderFrame = undefined;
  }
  virtualFileRenderKey = "";
}

function scheduleVirtualFileRender(): void {
  if (virtualFileRenderFrame !== undefined || vaultOpening() || elements.fileSearch.value.trim()) {
    return;
  }
  virtualFileRenderFrame = window.requestAnimationFrame(() => {
    virtualFileRenderFrame = undefined;
    renderVirtualFiles();
  });
}

function renderVirtualFiles(force = false): void {
  const { files, activePath } = virtualFileState;
  const geometry = virtualListWindow({
    itemCount: files.length,
    rowHeight: virtualFileRowHeight,
    scrollTop: elements.fileList.scrollTop,
    viewportHeight: Math.max(virtualFileRowHeight, elements.fileList.clientHeight),
    overscan: virtualFileOverscan,
  });
  const renderKey = `${geometry.start}:${geometry.end}:${activePath ?? ""}:${files.length}`;
  if (!force && renderKey === virtualFileRenderKey) {
    return;
  }
  virtualFileRenderKey = renderKey;
  elements.fileList.dataset.mode = "virtual";
  const fragment = document.createDocumentFragment();
  fragment.append(createVirtualSpacer(geometry.topSpacer));
  for (let index = geometry.start; index < geometry.end; index += 1) {
    const file = files[index];
    if (!file) {
      continue;
    }
    const button = createFileButton(file.path, file.title, activePath, "◇");
    button.classList.add("virtual-file-row");
    button.setAttribute("aria-posinset", String(index + 1));
    button.setAttribute("aria-setsize", String(files.length));
    const copy = button.querySelector<HTMLElement>(".file-copy");
    if (!copy) {
      throw new Error("File buttons require a copy container.");
    }
    const location = document.createElement("small");
    const slash = file.path.lastIndexOf("/");
    location.textContent = slash === -1 ? "Vault root" : file.path.slice(0, slash);
    copy.append(location);
    const metrics = document.createElement("span");
    metrics.className = "file-metrics";
    metrics.textContent =
      file.unresolvedCount > 0
        ? `${file.unresolvedCount} unresolved`
        : `${file.backlinkCount} back · ${file.outgoingCount} out`;
    button.append(metrics);
    button.addEventListener("click", () => void openNote(file.path));
    fragment.append(button);
  }
  fragment.append(createVirtualSpacer(geometry.bottomSpacer));
  elements.fileList.replaceChildren(fragment);
}

function createVirtualSpacer(height: number): HTMLDivElement {
  const spacer = document.createElement("div");
  spacer.className = "virtual-list-spacer";
  spacer.style.height = `${height}px`;
  spacer.ariaHidden = "true";
  return spacer;
}

function createFileButton(
  filePath: string,
  titleText: string,
  activePath: string | null,
  glyphText: string,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "file-item nav-file-title";
  button.dataset.notePath = filePath;
  button.ariaLabel = `Open ${filePath}`;
  if (filePath === activePath) {
    button.setAttribute("aria-current", "page");
  }

  const glyph = document.createElement("span");
  glyph.className = "file-glyph";
  glyph.ariaHidden = "true";
  glyph.textContent = glyphText;
  const copy = document.createElement("span");
  copy.className = "file-copy";
  const title = document.createElement("strong");
  title.textContent = titleText;
  copy.append(title);
  button.append(glyph, copy);
  return button;
}

function renderVaultSearchResults(activePath: string | null, indexedCount: number): void {
  if (vaultSearchState.status === "loading" || vaultSearchState.status === "idle") {
    elements.filterSummary.textContent = `Searching ${indexedCount} saved ${indexedCount === 1 ? "note" : "notes"}`;
    renderEmpty(elements.fileList, "Searching saved Markdown…");
    return;
  }
  if (vaultSearchState.status === "error") {
    elements.filterSummary.textContent = "Search unavailable";
    renderEmpty(elements.fileList, vaultSearchState.message ?? "Vault search failed.");
    return;
  }

  const response = vaultSearchState.response;
  elements.filterSummary.textContent = response.truncated
    ? `${response.total} matching notes · first ${response.results.length} shown`
    : `${response.total} ${response.total === 1 ? "note" : "notes"} match saved content`;

  for (const result of response.results) {
    const button = createFileButton(result.path, result.title, activePath, "⌕");
    button.classList.add("search-result");
    const context = result.contexts[0];
    const displayContext = vaultSearchDisplayContext(result);
    button.ariaLabel = `Open ${result.path}${context?.line ? ` at line ${context.line}` : ""}`;
    const copy = button.querySelector<HTMLElement>(".file-copy");
    if (!copy) {
      throw new Error("Search result buttons require a copy container.");
    }
    const location = document.createElement("small");
    location.textContent = result.path;
    copy.append(location);
    if (context) {
      const contextRow = document.createElement("span");
      contextRow.className = "search-context";
      const contextKind = document.createElement("small");
      contextKind.textContent = displayContext?.label ?? "Match";
      const contextText = document.createElement("span");
      contextText.textContent = displayContext?.text ?? context.text;
      contextRow.append(contextKind, contextText);
      copy.append(contextRow);
    }
    const metrics = document.createElement("span");
    metrics.className = "file-metrics search-metrics";
    metrics.textContent = `${result.matchCount} ${result.matchCount === 1 ? "match" : "matches"}`;
    button.append(metrics);
    button.addEventListener("click", () => void openNote(result.path, context?.line));
    elements.fileList.append(button);
  }

  if (response.results.length === 0) {
    renderEmpty(elements.fileList, "No saved note contains this search.");
  }
}

function renderUnavailableNotice(entry: WorkspaceUnavailableEntry | null | undefined): void {
  const text = unavailableNoticeText(entry);
  renderUnavailableNoticeToolbarLabel(elements.notePath, entry, text);
  const heading = elements.noteEmpty.querySelector("h2");
  const detail = elements.noteEmpty.querySelector("p");
  if (heading) {
    heading.textContent = text.heading;
  }
  if (detail) {
    detail.textContent = text.detail;
  }
}

function renderNote(note: WorkspaceNoteSnapshot | null): void {
  elements.canvasView.hidden = true;
  elements.noteEmpty.hidden = note !== null;
  elements.noteView.hidden = note === null;
  if (!note) {
    elements.notePath.textContent = "No note selected";
    elements.noteTags.replaceChildren();
    elements.linkCount.textContent = "0";
    renderProperties(null);
    renderEmpty(elements.outlineList, "No outline yet.");
    renderEmpty(elements.outgoingList, "No outgoing links.");
    renderEmpty(elements.backlinkList, "No backlinks.");
    renderEditControls();
    return;
  }

  elements.notePath.textContent = note.path;
  elements.noteTitle.textContent = note.title;
  elements.noteStats.textContent = `${note.headings.length} ${note.headings.length === 1 ? "heading" : "headings"} · ${note.outgoing.length} outgoing · ${note.backlinks.length} backlinks`;
  elements.noteTags.replaceChildren();
  for (const tag of note.tags) {
    const badge = document.createElement("li");
    badge.textContent = `#${tag}`;
    elements.noteTags.append(badge);
  }
  if (note.tags.length === 0) {
    const untagged = document.createElement("li");
    untagged.className = "muted-tag";
    untagged.textContent = "Untagged";
    elements.noteTags.append(untagged);
  }

  renderProperties(note);

  elements.outlineList.replaceChildren();
  for (const heading of note.headings) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "inspector-item outline-item";
    button.style.setProperty("--outline-depth", String(Math.max(0, heading.level - 1)));
    button.textContent = heading.text;
    button.addEventListener("click", () => scrollToDocumentLine(heading.line));
    elements.outlineList.append(button);
  }
  if (note.headings.length === 0) {
    renderEmpty(elements.outlineList, "No Markdown headings.");
  }

  elements.linkCount.textContent = String(note.outgoing.length + note.backlinks.length);
  renderConnections(elements.outgoingList, note.outgoing);
  renderConnections(
    elements.backlinkList,
    note.backlinks.map((filePath) => ({
      label: filePath,
      status: "resolved" as const,
      path: filePath,
    })),
  );
  renderEditControls();
}

function displayPropertyValue(property: WorkspacePropertySummary): string {
  if (Array.isArray(property.value)) {
    return property.value.length > 0 ? property.value.join(", ") : "Empty list";
  }
  if (property.type === "checkbox") {
    return property.value ? "Checked" : "Unchecked";
  }
  const value = String(property.value);
  return value || "Empty text";
}

function renderProperties(note: WorkspaceNoteSnapshot | null): void {
  elements.propertyList.replaceChildren();
  elements.propertyCount.textContent = String(note?.properties.length ?? 0);
  for (const property of note?.properties ?? []) {
    const row = document.createElement("div");
    row.className = "property-row";
    row.dataset.propertyName = property.name;

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "property-edit";
    edit.dataset.propertyAction = "edit";
    edit.dataset.propertyType = property.type;
    edit.setAttribute("aria-label", `Edit ${property.name} property`);
    const copy = document.createElement("span");
    copy.className = "property-copy";
    const name = document.createElement("strong");
    name.textContent = property.name;
    const value = document.createElement("span");
    value.textContent = displayPropertyValue(property);
    copy.append(name, value);
    const type = document.createElement("small");
    type.textContent = property.type === "unsupported" ? "Read only" : property.type;
    edit.append(copy, type);
    edit.addEventListener("click", () => openPropertyDialog("edit", property));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "property-remove";
    remove.dataset.propertyAction = "remove";
    remove.dataset.propertyType = property.type;
    remove.setAttribute("aria-label", `Remove ${property.name} property`);
    remove.textContent = "×";
    remove.addEventListener("click", () => openPropertyDialog("remove", property));
    row.append(edit, remove);
    elements.propertyList.append(row);
  }
  if (!note) {
    renderEmpty(elements.propertyList, "Open a note to inspect properties.");
  } else if (note.properties.length === 0) {
    renderEmpty(elements.propertyList, "No frontmatter properties.");
  }
  renderPropertyControls();
}

function renderPropertyControls(): void {
  const reason = propertyEditBlockReason();
  elements.propertyAdd.disabled = reason !== null;
  elements.propertyAdd.title = reason ?? "Add note property";
  for (const control of elements.propertyList.querySelectorAll<HTMLButtonElement>(
    "[data-property-action]",
  )) {
    const unsupported = control.dataset.propertyType === "unsupported";
    control.disabled = reason !== null || unsupported;
    control.title = unsupported
      ? "This complex property is visible but cannot be rewritten losslessly yet."
      : (reason ?? "");
  }
  const message = loadedNote ? reason : "Open a note to inspect and edit properties.";
  elements.propertyEditorMessage.textContent = message ?? "";
  elements.propertyEditorMessage.hidden = !message;
}

function reconcileEditor(
  incomingNote: WorkspaceNoteSnapshot | null,
  incomingVaultId: string | null,
): WorkspaceNoteSnapshot | null {
  if (!incomingNote) {
    if (dirty && loadedNote) {
      pendingDiskNote = null;
      diskChanged = true;
      setEditNotice({
        kind: "external",
        title: "The open note disappeared from the index",
        message:
          "Your unsaved text is still in the editor. Saving will preserve it through the conflict path instead of recreating or overwriting the missing note silently.",
      });
      return loadedNote;
    }
    replaceEditorDocument(null, null);
    return null;
  }

  if (!loadedNote) {
    replaceEditorDocument(incomingNote, incomingVaultId);
    return incomingNote;
  }

  if (
    loadedVaultId === incomingVaultId &&
    loadedNote.path === incomingNote.path &&
    loadedNote.revision === incomingNote.revision
  ) {
    loadedNote = incomingNote;
    if (!dirty) {
      loadedTextRepresentation = externalTextRepresentation(incomingNote.content);
      editorTextUndoHistory = [];
      editorTextRedoHistory = [];
    }
    return incomingNote;
  }

  const currentText = editor.state.doc.toString();
  if (saving && savingContent === incomingNote.content) {
    loadedNote = incomingNote;
    loadedVaultId = incomingVaultId;
    loadedTextRepresentation = externalTextRepresentation(incomingNote.content);
    pendingDiskNote = null;
    diskChanged = false;
    dirty = externalTextFromEditor(currentText, loadedTextRepresentation) !== incomingNote.content;
    if (dirty) {
      scheduleEditorDraftPersistence();
    }
    clearEditNotice();
    return incomingNote;
  }

  if (dirty) {
    pendingDiskNote = incomingNote;
    diskChanged = true;
    const sameVault = loadedVaultId === incomingVaultId;
    const samePath = loadedNote.path === incomingNote.path;
    setEditNotice({
      kind: "external",
      title: !sameVault
        ? "The active vault changed"
        : samePath
          ? "This note changed on disk"
          : "The active disk note changed",
      message: !sameVault
        ? "Threadleaf kept your unsaved editor text. It cannot be saved into the newly active vault; Revert to accept the new vault, or copy the text before switching back."
        : samePath
          ? "Threadleaf kept your unsaved editor text. Save to preserve it as a conflict copy, or Revert to load the current disk version."
          : "Threadleaf kept your unsaved editor text instead of switching notes. Save to preserve it, or Revert to accept the current disk selection.",
    });
    return loadedNote;
  }

  const sameDocument = loadedVaultId === incomingVaultId && loadedNote.path === incomingNote.path;
  const currentSelection = editor.state.selection.main;
  replaceEditorDocument(
    incomingNote,
    incomingVaultId,
    sameDocument ? { anchor: currentSelection.anchor, head: currentSelection.head } : undefined,
  );
  return incomingNote;
}

function replaceEditorDocument(
  note: WorkspaceNoteSnapshot | null,
  vaultId: string | null,
  selection?: { anchor: number; head?: number },
): void {
  const previousLoadedNote = loadedNote;
  const previousLoadedVaultId = loadedVaultId;
  // Live Preview snapshots its async owner while the replacement state is
  // created. Publish the new owner first so that creating the replacement
  // editor cannot issue another request for the note that is being removed.
  loadedNote = note;
  loadedVaultId = note ? vaultId : null;
  const content = note?.content ?? "";
  syncingEditor = true;
  try {
    editor.setState(createEditorState(content, selection));
  } catch (error) {
    loadedNote = previousLoadedNote;
    loadedVaultId = previousLoadedVaultId;
    throw error;
  } finally {
    syncingEditor = false;
  }
  loadedTextRepresentation = externalTextRepresentation(content);
  editorTextUndoHistory = [];
  editorTextRedoHistory = [];
  syncEditorPresentation();
  previewHydrationRequest += 1;
  renderedPreviewPath = null;
  renderedPreviewSource = null;
  renderedPreviewVaultId = null;
  renderedPreviewWatchSequence = -1;
  elements.notePreview.replaceChildren();
  pendingDiskNote = null;
  diskChanged = false;
  dirty = false;
  editorDraftId = null;
  editorDraftPersistenceState = "idle";
  editorDraftPersistenceError = null;
  clearEditNotice();
}

function enqueueEditorDraftOperation(operation: () => Promise<void>): Promise<void> {
  const result = editorDraftPersistenceTail.then(operation, operation);
  editorDraftPersistenceTail = result.catch(() => undefined);
  return result;
}

function reportEditorDraftPersistenceError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const changed = message !== editorDraftPersistenceError;
  editorDraftPersistenceState = "error";
  editorDraftPersistenceError = message;
  renderEditControls();
  if (changed) {
    showToast(`Draft recovery unavailable: ${message}`);
  }
}

function currentEditorDraft(): EditorDraftSnapshot | null {
  if (!dirty || !loadedNote || !loadedVaultId) {
    return null;
  }
  editorDraftId ??= window.crypto.randomUUID();
  const selection = editor.state.selection.main;
  return {
    version: 3,
    draftId: editorDraftId,
    vaultId: loadedVaultId,
    paneId: activePaneContextId,
    path: loadedNote.path,
    baseRevision: loadedNote.revision,
    content: editor.state.doc.toString(),
    textRepresentation: editorDraftTextRepresentation(loadedTextRepresentation),
    selection: { anchor: selection.anchor, head: selection.head },
    updatedAt: new Date().toISOString(),
  };
}

async function persistCurrentEditorDraft(): Promise<void> {
  const paneId = activePaneContextId;
  const draft = currentEditorDraft();
  if (!draft) {
    return;
  }
  editorDraftPersistenceState = "pending";
  renderEditControls();
  try {
    await enqueueEditorDraftOperation(async () => {
      const response = await window.threadleaf.saveEditorDraft(draft);
      if (response.status === "stale-vault") {
        throw new Error("the active vault changed before the private draft was stored");
      }
    });
    runInPaneContext(paneId, () => {
      if (editorDraftId === draft.draftId) {
        editorDraftPersistenceState = "saved";
        editorDraftPersistenceError = null;
        renderEditControls();
      }
    });
  } catch (error) {
    runInPaneContext(paneId, () => reportEditorDraftPersistenceError(error));
  }
}

function scheduleEditorDraftPersistence(delayMs = 180): void {
  if (!dirty || !loadedNote || !loadedVaultId) {
    return;
  }
  if (editorDraftTimer !== undefined) {
    window.clearTimeout(editorDraftTimer);
  }
  const paneId = activePaneContextId;
  editorDraftPersistenceState = "pending";
  editorDraftTimer = window.setTimeout(() => {
    runInPaneContext(paneId, () => {
      editorDraftTimer = undefined;
      void persistCurrentEditorDraft();
    });
  }, delayMs);
}

async function flushEditorDraftPersistence(): Promise<void> {
  if (editorDraftTimer !== undefined) {
    window.clearTimeout(editorDraftTimer);
    editorDraftTimer = undefined;
    await persistCurrentEditorDraft();
  }
  await editorDraftPersistenceTail;
}

function clearPersistedEditorDraft(
  vaultId: string,
  draftId: string,
  paneId: WorkspacePaneId = activePaneContextId,
): void {
  const operation = runInPaneContext(paneId, () =>
    enqueueEditorDraftOperation(async () => {
      const response = await window.threadleaf.clearEditorDraft(vaultId, draftId, paneId);
      if (response.status === "stale-vault") {
        return;
      }
    }),
  );
  void operation.catch((error: unknown) => {
    runInPaneContext(paneId, () => reportEditorDraftPersistenceError(error));
  });
}

function clearCurrentEditorDraft(): void {
  if (editorDraftTimer !== undefined) {
    window.clearTimeout(editorDraftTimer);
    editorDraftTimer = undefined;
  }
  const draftId = editorDraftId;
  const vaultId = loadedVaultId;
  editorDraftId = null;
  editorDraftPersistenceState = "idle";
  editorDraftPersistenceError = null;
  if (draftId && vaultId) {
    clearPersistedEditorDraft(vaultId, draftId);
  }
}

function schedulePendingDiskAcceptance(): void {
  if (!diskChanged || pendingCleanDiskAcceptance) {
    return;
  }
  const paneId = activePaneContextId;
  pendingCleanDiskAcceptance = true;
  queueMicrotask(() => {
    runInPaneContext(paneId, () => {
      pendingCleanDiskAcceptance = false;
      if (dirty || !diskChanged) {
        return;
      }
      const selection = editor.state.selection.main;
      const diskNote = pendingDiskNote ?? workspacePaneSnapshot(paneId)?.activeNote ?? null;
      replaceEditorDocument(diskNote, currentSnapshot?.vault.id ?? null, {
        anchor: selection.anchor,
        head: selection.head,
      });
      if (currentSnapshot) {
        render(currentSnapshot);
      } else {
        renderNote(diskNote);
      }
      showToast(diskNote ? "Accepted the current disk version." : "Accepted the disk deletion.");
    });
  });
}

function recoveredDraftNote(
  draft: EditorDraftSnapshot,
  diskNote: WorkspaceNoteSnapshot | null,
): WorkspaceNoteSnapshot {
  if (diskNote) {
    return { ...diskNote, revision: draft.baseRevision };
  }
  const basename = draft.path.slice(draft.path.lastIndexOf("/") + 1);
  return {
    path: draft.path,
    title: basename.toLocaleLowerCase("en-US").endsWith(".md") ? basename.slice(0, -3) : basename,
    content: "",
    revision: draft.baseRevision,
    tags: [],
    headings: [],
    outgoing: [],
    backlinks: [],
    properties: [],
    propertyEditor: { editable: true, message: null },
  };
}

async function restoreEditorDraft(draft: EditorDraftSnapshot, request: number): Promise<void> {
  const paneId = draft.paneId;
  const canRestore = (): boolean =>
    runInPaneContext(
      paneId,
      () =>
        request === editorDraftRestoreRequest &&
        currentSnapshot?.vault.id === draft.vaultId &&
        !dirty &&
        !readOnlyVault(),
    );
  if (!canRestore()) {
    return;
  }

  let snapshot = currentSnapshot;
  if (!snapshot) {
    return;
  }
  const originallyActivePaneId = snapshot.workspace?.activePaneId ?? "primary";
  let diskNote = workspacePaneSnapshot(paneId, snapshot)?.activeNote ?? null;
  if (diskNote?.path !== draft.path) {
    const exists = snapshot.workspace?.files.some(({ path }) => path === draft.path) ?? false;
    if (exists) {
      const opened = await window.threadleaf.openNote(draft.path, paneId);
      if (!canRestore() || opened.vault.id !== draft.vaultId) {
        return;
      }
      snapshot =
        originallyActivePaneId === paneId
          ? opened
          : await window.threadleaf.focusWorkspacePane(originallyActivePaneId, draft.vaultId);
      if (!canRestore() || snapshot.vault.id !== draft.vaultId) {
        return;
      }
      diskNote = workspacePaneSnapshot(paneId, snapshot)?.activeNote ?? null;
    } else {
      diskNote = null;
    }
  }

  // Version-3 drafts retain their external spelling metadata. Preserve a
  // stale disk file with logically identical text but a distinct BOM or line
  // ending sequence through the same conflict-safe recovery path.
  if (
    diskNote &&
    editorDraftMatchesDiskText(draft.content, draft.textRepresentation, diskNote.content)
  ) {
    clearPersistedEditorDraft(draft.vaultId, draft.draftId, paneId);
    return;
  }

  const restoredNote = recoveredDraftNote(draft, diskNote);
  runInPaneContext(paneId, () => {
    syncingEditor = true;
    try {
      editor.setState(createEditorState(draft.content, draft.selection, paneId));
    } finally {
      syncingEditor = false;
    }
    loadedNote = restoredNote;
    loadedVaultId = draft.vaultId;
    loadedTextRepresentation =
      externalTextRepresentationFromDraft(draft.content, draft.textRepresentation) ??
      externalTextRepresentation(diskNote?.content ?? draft.content);
    editorTextUndoHistory = [];
    editorTextRedoHistory = [];
    syncEditorPresentation();
    editorDraftId = draft.draftId;
    editorDraftPersistenceState = "saved";
    editorDraftPersistenceError = null;
    pendingDiskNote = diskNote;
    diskChanged = diskNote === null || diskNote.revision !== draft.baseRevision;
    dirty = true;
    setEditNotice({
      kind: diskChanged ? "conflict" : "external",
      title: diskChanged ? "Recovered draft, disk changed" : "Recovered unsaved draft",
      message: diskChanged
        ? "Threadleaf restored your private draft without overwriting the changed or missing vault note. Save to preserve it through the conflict path, or Revert to accept disk state."
        : "Threadleaf restored the exact private draft and selection from before the renderer stopped. Save it to the vault or Revert to discard it.",
    });
  });
  render(snapshot);
  if (snapshot.workspace?.activePaneId === paneId) {
    runInPaneContext(paneId, () => {
      setDocumentView("source", false);
      window.requestAnimationFrame(() => editor.focus());
    });
  }
}

function maybeRestoreEditorDraft(snapshot: RuntimeSnapshot): void {
  const paneId = activePaneContextId;
  const vaultId = snapshot.vault.id;
  if (
    snapshot.startup?.phase === "opening" ||
    !vaultId ||
    snapshot.vault.mode !== "kernel-backed" ||
    editorDraftCheckedVaultId === vaultId
  ) {
    return;
  }
  editorDraftCheckedVaultId = vaultId;
  const request = ++editorDraftRestoreRequest;
  void window.threadleaf
    .getEditorDraft(vaultId, paneId)
    .then((response) => {
      if (response.status === "ready" && response.draft.paneId === paneId) {
        return restoreEditorDraft(response.draft, request);
      }
      return undefined;
    })
    .catch((error: unknown) => {
      runInPaneContext(paneId, () => reportEditorDraftPersistenceError(error));
    });
}

function renderConnections(container: HTMLElement, links: WorkspaceLinkSummary[]): void {
  container.replaceChildren();
  for (const link of links) {
    if (link.status === "resolved" && link.path) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "inspector-item link-item";
      const label = document.createElement("span");
      label.textContent = link.label || link.path;
      const status = document.createElement("small");
      status.textContent = "Open";
      button.append(label, status);
      button.addEventListener("click", () => void openNote(link.path as string));
      container.append(button);
    } else {
      const row = document.createElement("div");
      row.className = "inspector-item link-item unresolved-link";
      const label = document.createElement("span");
      label.textContent = link.label || "Untitled link";
      const status = document.createElement("small");
      status.textContent = link.status === "ambiguous" ? "Ambiguous" : "Unresolved";
      row.append(label, status);
      container.append(row);
    }
  }
  if (links.length === 0) {
    renderEmpty(container, "None in this note.");
  }
}

function renderCommands(snapshot: RuntimeSnapshot): void {
  elements.commandList.replaceChildren();
  for (const command of snapshot.commands) {
    const row = document.createElement("div");
    row.className = "command-row";
    const name = document.createElement("strong");
    name.textContent = command.name;
    const id = document.createElement("code");
    id.textContent = command.id;
    row.append(name, id);
    elements.commandList.append(row);
  }
  if (snapshot.commands.length === 0) {
    renderEmpty(elements.commandList, "No plugin commands registered.");
  }
}

function renderEvents(snapshot: RuntimeSnapshot): void {
  elements.eventCount.textContent = `${snapshot.events.length} ${snapshot.events.length === 1 ? "event" : "events"}`;
  elements.eventList.replaceChildren();
  for (const event of [...snapshot.events].reverse().slice(0, 12)) {
    const item = document.createElement("li");
    item.dataset.kind = event.kind;
    const index = document.createElement("span");
    index.textContent = String(event.sequence).padStart(2, "0");
    const body = document.createElement("span");
    const kind = document.createElement("small");
    kind.textContent = event.kind;
    const message = document.createElement("span");
    message.textContent = event.message;
    body.append(kind, message);
    item.append(index, body);
    elements.eventList.append(item);
  }
}

function renderEmpty(container: HTMLElement, message: string): void {
  container.replaceChildren();
  const empty = document.createElement("p");
  empty.className = "empty-state";
  empty.textContent = message;
  container.append(empty);
}

function renderEditControls(): void {
  let state: "empty" | "saved" | "dirty" | "conflict" | "saving" = "empty";
  let label = "No note";
  if (saving) {
    state = "saving";
    label = "Saving";
  } else if (dirty && editorDraftPersistenceState === "error") {
    state = "conflict";
    label = "Unsaved, recovery failed";
  } else if (dirty && diskChanged) {
    state = "conflict";
    label = "Unsaved, disk changed";
  } else if (dirty) {
    state = "dirty";
    label = "Unsaved";
  } else if (loadedNote) {
    state = "saved";
    label = readOnlyVault() ? "Read only" : "Saved";
  }
  elements.editState.dataset.state = state;
  elements.editState.dataset.draftState = editorDraftPersistenceState;
  elements.editState.textContent = label;
  elements.editState.title = editorDraftPersistenceError
    ? `Private draft recovery failed: ${editorDraftPersistenceError}`
    : dirty && editorDraftPersistenceState === "saved"
      ? "Unsaved changes are protected in Threadleaf's private recovery store."
      : dirty && editorDraftPersistenceState === "pending"
        ? "Threadleaf is protecting this draft in private recovery storage."
        : "";
  renderBookmarkToggle();
  const opening = vaultOpening();
  const readOnly = readOnlyVault();
  const paneCount = currentSnapshot?.workspace?.panes.length ?? 1;
  const splitBlocked = busy || anyPaneSaving() || (paneCount < 2 && anyPaneDirty());
  elements.newNote.disabled = opening || readOnly || busy || saving || dirty;
  elements.exportNote.disabled =
    opening || busy || saving || dirty || publishExportBusy || !loadedNote || !loadedVaultId;
  elements.exportNote.title = dirty
    ? "Save or revert the current note before exporting it"
    : "Export current note as standalone HTML";
  elements.moveNote.disabled = readOnly || busy || saving || dirty || !loadedNote || !loadedVaultId;
  elements.deleteNote.disabled =
    readOnly || busy || saving || dirty || !loadedNote || !loadedVaultId;
  elements.saveNote.disabled =
    readOnly || busy || saving || !dirty || !loadedNote || !loadedVaultId;
  elements.revertNote.disabled = busy || saving || !dirty || !loadedNote;
  elements.splitPaneRight.disabled = opening || splitBlocked;
  elements.splitPaneDown.disabled = opening || splitBlocked;
  elements.moveTabPane.disabled =
    opening || paneCount < 2 || busy || anyPaneSaving() || anyPaneDirty() || !loadedNote;
  elements.closePane.disabled =
    opening || paneCount < 2 || busy || anyPaneSaving() || anyPaneDirty();
  const activePane = workspacePaneSnapshot();
  const historyBlocked = busy || saving || dirty;
  elements.navigateBack.disabled = historyBlocked || !activePane?.canGoBack;
  elements.navigateForward.disabled = historyBlocked || !activePane?.canGoForward;
  elements.navigateBack.title = dirty
    ? "Save or revert the open draft before navigating note history"
    : "Go back in note history";
  elements.navigateForward.title = dirty
    ? "Save or revert the open draft before navigating note history"
    : "Go forward in note history";
  elements.splitPaneRight.title =
    paneCount < 2 && anyPaneDirty()
      ? "Save or revert the open draft before creating another pane"
      : "Split editor right";
  elements.splitPaneDown.title =
    paneCount < 2 && anyPaneDirty()
      ? "Save or revert the open draft before creating another pane"
      : "Split editor down";
  elements.moveTabPane.title = anyPaneDirty()
    ? "Save or revert drafts before moving a tab between panes"
    : "Move current tab to the other pane";
  elements.closePane.title = anyPaneDirty()
    ? "Save or revert drafts before closing a pane"
    : "Close this editor pane";
  renderTabs(opening ? [] : (workspacePaneSnapshot()?.tabs ?? []), loadedNote?.path ?? null);
  renderEditNotice();
  renderDocumentView();
  renderPropertyControls();
  renderPaletteResults();
}

function setEditNotice(notice: EditNoticeState): void {
  editNoticeState = notice;
  renderEditNotice();
}

function clearEditNotice(): void {
  editNoticeState = null;
  renderEditNotice();
}

function renderEditNotice(): void {
  elements.editNotice.hidden = editNoticeState === null;
  elements.editNotice.dataset.kind = editNoticeState?.kind ?? "none";
  elements.editNoticeTitle.textContent = editNoticeState?.title ?? "";
  elements.editNoticeMessage.textContent = editNoticeState?.message ?? "";
}

function scrollToSourceLine(line: number): void {
  const boundedLine = Math.max(1, Math.min(line, editor.state.doc.lines));
  const offset = editor.state.doc.line(boundedLine).from;
  editor.dispatch({
    selection: { anchor: offset },
    effects: EditorView.scrollIntoView(offset, { y: "start" }),
  });
  editor.focus();
}

async function closeTab(
  filePath: string,
  paneId: WorkspacePaneId = activePaneContextId,
): Promise<void> {
  activatePaneContext(paneId);
  if (busy || saving) {
    return;
  }
  const expectedVaultId = currentSnapshot?.vault.id;
  if (!expectedVaultId) {
    return;
  }
  const tab = workspacePaneSnapshot(paneId)?.tabs.find((candidate) => candidate.path === filePath);
  if (tab?.pinned) {
    await runAction(() => window.threadleaf.closeNote(filePath, expectedVaultId, paneId));
    return;
  }
  if (loadedNote?.path === filePath && dirty) {
    showToast("Save or revert the current note before closing its tab.");
    setDocumentView("source");
    editor.focus();
    return;
  }
  await runAction(() => window.threadleaf.closeNote(filePath, expectedVaultId, paneId));
  window.requestAnimationFrame(() => {
    if (loadedNote) {
      if (documentViewMode === "reading") {
        elements.notePreview.focus();
      } else {
        editor.focus();
      }
    } else {
      elements.fileSearch.focus();
    }
  });
}

async function toggleTabPin(
  filePath: string,
  paneId: WorkspacePaneId = activePaneContextId,
): Promise<void> {
  activatePaneContext(paneId);
  if (busy || saving) {
    return;
  }
  const expectedVaultId = currentSnapshot?.vault.id;
  if (!expectedVaultId) {
    return;
  }
  await runAction(() => window.threadleaf.toggleTabPin(filePath, paneId, expectedVaultId));
}

async function reorderTab(
  filePath: string,
  paneId: WorkspacePaneId,
  targetIndex: number,
): Promise<void> {
  activatePaneContext(paneId);
  if (busy || saving || anyPaneDirty()) {
    if (anyPaneDirty()) {
      showToast("Save or revert drafts before reordering tabs.");
    }
    return;
  }
  const expectedVaultId = currentSnapshot?.vault.id;
  if (!expectedVaultId || !Number.isSafeInteger(targetIndex)) {
    return;
  }
  await runAction(() =>
    window.threadleaf.reorderWorkspaceTab(filePath, paneId, targetIndex, expectedVaultId),
  );
}

function toggleCurrentTabPin(): Promise<void> {
  const tab = workspacePaneSnapshot()?.tabs.find((candidate) => candidate.active);
  return tab ? toggleTabPin(tab.path) : Promise.resolve();
}

function closeActiveTab(): Promise<void> {
  return loadedNote ? closeTab(loadedNote.path, activePaneContextId) : Promise.resolve();
}

async function cycleTab(
  direction: -1 | 1,
  paneId: WorkspacePaneId = activePaneContextId,
): Promise<void> {
  activatePaneContext(paneId);
  const tabs = workspacePaneSnapshot(paneId)?.tabs ?? [];
  if (tabs.length < 2 || busy || saving) {
    return;
  }
  if (dirty) {
    showToast("Save or revert the current note before switching tabs.");
    setDocumentView("source");
    editor.focus();
    return;
  }
  const activePath = loadedNote?.path ?? tabs.find((tab) => tab.active)?.path;
  const activeIndex = tabs.findIndex((tab) => tab.path === activePath);
  const nextIndex = (Math.max(0, activeIndex) + direction + tabs.length) % tabs.length;
  const nextTab = tabs[nextIndex];
  if (nextTab) {
    await openNote(nextTab.path, undefined, paneId);
  }
}

async function openNote(
  filePath: string,
  line?: number,
  paneId: WorkspacePaneId = activePaneContextId,
  activate = true,
): Promise<boolean> {
  activatePaneContext(paneId);
  if (busy) {
    return false;
  }
  if (dirty || saving) {
    showToast("Save or revert the open note before navigating away.");
    setDocumentView("source");
    editor.focus();
    return false;
  }
  await runAction(() => window.threadleaf.openNote(filePath, paneId, activate));
  if (!activate) {
    showToast(`Opened ${filePath} in the background.`);
    return true;
  }
  if (line && loadedNote?.path === filePath) {
    scrollToDocumentLine(line);
  }
  if (!line && loadedNote?.path === filePath) {
    window.requestAnimationFrame(() => {
      if (documentViewMode === "reading") {
        elements.notePreview.focus();
      } else {
        editor.focus();
      }
    });
  }
  return (
    loadedNote?.path === filePath || workspacePaneSnapshot(paneId)?.activeCanvas?.path === filePath
  );
}

async function navigateHistory(
  direction: "back" | "forward",
  paneId: WorkspacePaneId = activePaneContextId,
): Promise<void> {
  activatePaneContext(paneId);
  const expectedVaultId = currentSnapshot?.vault.id;
  if (!expectedVaultId || busy) {
    return;
  }
  if (dirty || saving) {
    showToast("Save or revert the open note before navigating history.");
    setDocumentView("source");
    editor.focus();
    return;
  }
  const pane = workspacePaneSnapshot(paneId);
  if (
    (direction === "back" && !pane?.canGoBack) ||
    (direction === "forward" && !pane?.canGoForward)
  ) {
    return;
  }
  await runAction(() =>
    direction === "back"
      ? window.threadleaf.goBack(expectedVaultId, paneId)
      : window.threadleaf.goForward(expectedVaultId, paneId),
  );
  window.requestAnimationFrame(() => {
    if (loadedNote) {
      documentViewMode === "reading" ? elements.notePreview.focus() : editor.focus();
    }
  });
}

async function chooseVault(): Promise<void> {
  if (busy) {
    return;
  }
  if (anyPaneDirty() || anyPaneSaving()) {
    showToast("Save or revert drafts in every pane before switching vaults.");
    editor.focus();
    return;
  }
  try {
    setActionState(true);
    const response = await window.threadleaf.chooseVault();
    if (response.status === "opened") {
      render(response.snapshot);
      showToast(`Opened ${response.snapshot.vault.name}.`);
    } else if (response.status === "failed") {
      render(response.snapshot);
      showToast(response.message);
    }
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  } finally {
    setActionState(false);
  }
}

async function saveActiveNote(): Promise<void> {
  if (!loadedNote || !loadedVaultId || !dirty || saving || busy) {
    return;
  }
  const path = loadedNote.path;
  const expectedRevision = loadedNote.revision;
  const expectedVaultId = loadedVaultId;
  const content = externalTextFromEditor(editor.state.doc.toString(), loadedTextRepresentation);
  saving = true;
  savingContent = content;
  renderEditControls();
  setActionState(busy);
  await flushEditorDraftPersistence();
  const savedDraftId = editorDraftId;
  const savedDraftVaultId = loadedVaultId;
  const savedDraftPersistenceState = editorDraftPersistenceState;
  const savedDraftPersistenceError = editorDraftPersistenceError;
  editorDraftId = null;
  try {
    const response = await window.threadleaf.saveNote(
      path,
      content,
      expectedRevision,
      expectedVaultId,
    );
    render(response.snapshot);
    if (savedDraftId && savedDraftVaultId) {
      clearPersistedEditorDraft(savedDraftVaultId, savedDraftId);
    }
    if (response.outcome.status === "conflict") {
      setEditNotice({
        kind: "conflict",
        title: "Your edit was preserved as a conflict note",
        message: `The original changed on disk and was not overwritten. Your version is now ${response.outcome.conflictPath}.`,
      });
      showToast(`Preserved as ${response.outcome.conflictPath}`);
    } else if (dirty) {
      showToast("Saved, but the note changed again on disk.");
    } else {
      clearEditNotice();
      showToast(`Saved ${response.outcome.path}`);
    }
  } catch (error) {
    if (!editorDraftId && savedDraftId) {
      editorDraftId = savedDraftId;
      editorDraftPersistenceState = savedDraftPersistenceState;
      editorDraftPersistenceError = savedDraftPersistenceError;
    }
    showToast(error instanceof Error ? error.message : String(error));
  } finally {
    saving = false;
    savingContent = null;
    if (!dirty) {
      editorDraftPersistenceState = "idle";
      editorDraftPersistenceError = null;
    }
    setActionState(busy);
  }
}

function revertActiveNote(): void {
  if (!dirty || saving || busy) {
    return;
  }
  const diskNote = diskChanged
    ? (pendingDiskNote ?? workspacePaneSnapshot()?.activeNote ?? null)
    : loadedNote;
  const discardedDraftId = editorDraftId;
  const discardedVaultId = loadedVaultId;
  replaceEditorDocument(
    diskNote,
    diskChanged ? (currentSnapshot?.vault.id ?? null) : loadedVaultId,
    {
      anchor: editor.state.selection.main.anchor,
      head: editor.state.selection.main.head,
    },
  );
  if (discardedDraftId && discardedVaultId) {
    clearPersistedEditorDraft(discardedVaultId, discardedDraftId);
  }
  if (currentSnapshot) {
    render(currentSnapshot);
  } else {
    renderEditControls();
  }
  showToast(diskNote ? "Reverted to the current disk version." : "Accepted the disk deletion.");
}

function showToast(message: string): void {
  if (toastTimer !== undefined) {
    window.clearTimeout(toastTimer);
  }
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 3200);
}

async function runAction(action: () => Promise<RuntimeSnapshot>): Promise<void> {
  try {
    setActionState(true);
    render(await action());
  } catch (error) {
    showToast(ipcErrorMessage(error));
  } finally {
    setActionState(false);
  }
}

function otherWorkspacePaneId(paneId: WorkspacePaneId): WorkspacePaneId {
  return paneId === "primary" ? "secondary" : "primary";
}

function activateWorkspacePaneLocally(paneId: WorkspacePaneId): void {
  const pane = workspacePaneSnapshot(paneId);
  if (!pane) {
    return;
  }
  const previousPaneId = activePaneContextId;
  if (previousPaneId !== paneId && documentViewMode === "plugin") {
    pluginSurfaceRequest += 1;
    documentViewMode = editingViewMode;
    renderDocumentView();
    void window.threadleaf.closePluginView().catch(() => undefined);
  }
  activatePaneContext(paneId);
  for (const [candidateId, candidateElements] of paneElements) {
    candidateElements.workspacePane.dataset.active = String(candidateId === paneId);
    candidateElements.workspacePane.setAttribute(
      "aria-label",
      `${candidateId === "primary" ? "Primary" : "Secondary"} editor pane${candidateId === paneId ? ", active" : ""}`,
    );
  }
  renderFiles(currentSnapshot?.workspace?.files ?? [], loadedNote?.path ?? null);
  renderNoteBookmarks(currentSnapshot?.workspace?.files ?? [], loadedNote?.path ?? null);
  renderNote(loadedNote);
  setActionState(busy);
}

function requestWorkspacePaneFocus(paneId: WorkspacePaneId): void {
  if (!workspacePaneSnapshot(paneId) || busy || anyPaneSaving()) {
    return;
  }
  activateWorkspacePaneLocally(paneId);
  const expectedVaultId = currentSnapshot?.vault.id;
  if (!expectedVaultId) {
    return;
  }
  const request = ++paneFocusRequest;
  paneFocusTail = paneFocusTail
    .then(async () => {
      const snapshot = await window.threadleaf.focusWorkspacePane(paneId, expectedVaultId);
      if (
        request === paneFocusRequest &&
        currentSnapshot?.vault.id === expectedVaultId &&
        snapshot.vault.id === expectedVaultId
      ) {
        render(snapshot);
      }
    })
    .catch((error: unknown) => {
      if (request === paneFocusRequest) {
        showToast(error instanceof Error ? error.message : String(error));
      }
    });
}

async function splitWorkspace(direction: WorkspaceSplitDirection): Promise<void> {
  const expectedVaultId = currentSnapshot?.vault.id;
  const paneCount = currentSnapshot?.workspace?.panes.length ?? 1;
  if (!expectedVaultId || busy || anyPaneSaving() || (paneCount < 2 && anyPaneDirty())) {
    if (paneCount < 2 && anyPaneDirty()) {
      showToast("Save or revert the open draft before creating another pane.");
    }
    return;
  }
  await runAction(() => window.threadleaf.splitWorkspace(direction, expectedVaultId));
  window.requestAnimationFrame(() => editor.focus());
}

async function moveActiveTabToOtherPane(): Promise<void> {
  const expectedVaultId = currentSnapshot?.vault.id;
  const filePath = loadedNote?.path;
  const fromPaneId = activePaneContextId;
  if (!filePath) {
    return;
  }
  await moveTabToOtherPane(filePath, fromPaneId, expectedVaultId);
}

async function moveTabToOtherPane(
  filePath: string,
  fromPaneId: WorkspacePaneId,
  expectedVaultId = currentSnapshot?.vault.id,
): Promise<void> {
  const toPaneId = otherWorkspacePaneId(fromPaneId);
  if (
    !expectedVaultId ||
    !workspacePaneSnapshot(toPaneId) ||
    busy ||
    anyPaneSaving() ||
    anyPaneDirty()
  ) {
    if (anyPaneDirty()) {
      showToast("Save or revert drafts before moving a tab between panes.");
    }
    return;
  }
  await runAction(() =>
    window.threadleaf.moveNoteToWorkspacePane(filePath, fromPaneId, toPaneId, expectedVaultId),
  );
  window.requestAnimationFrame(() => editor.focus());
}

async function closeActiveWorkspacePane(): Promise<void> {
  const expectedVaultId = currentSnapshot?.vault.id;
  const paneId = activePaneContextId;
  if (
    !expectedVaultId ||
    (currentSnapshot?.workspace?.panes.length ?? 0) < 2 ||
    busy ||
    anyPaneSaving() ||
    anyPaneDirty()
  ) {
    if (anyPaneDirty()) {
      showToast("Save or revert drafts before closing a pane.");
    }
    return;
  }
  await runAction(() => window.threadleaf.closeWorkspacePane(paneId, expectedVaultId));
  window.requestAnimationFrame(() => editor.focus());
}

function renderAllPaneEditControls(): void {
  const activePaneId = activePaneContextId;
  for (const paneId of workspacePaneIdsInRenderOrder(activePaneId)) {
    if (!workspacePaneSnapshot(paneId)) {
      continue;
    }
    activatePaneContext(paneId);
    renderEditControls();
  }
  activatePaneContext(activePaneId);
}

function setActionState(nextBusy: boolean): void {
  busy = nextBusy;
  const opening = vaultOpening();
  const paneSaving = anyPaneSaving();
  const paneDirty = anyPaneDirty();
  elements.openVault.disabled = busy || paneSaving;
  elements.newNote.disabled = opening || readOnlyVault() || busy || paneSaving || paneDirty;
  elements.reloadPlugin.disabled =
    opening ||
    busy ||
    paneSaving ||
    pluginBusy ||
    pluginSafeModeActive() ||
    currentPluginPreference().compatibilityMode === "restricted" ||
    currentPluginPreference().enabledPluginIds.length === 0;
  elements.unloadPlugin.disabled =
    opening ||
    busy ||
    paneSaving ||
    pluginBusy ||
    pluginSafeModeActive() ||
    currentPluginPreference().compatibilityMode === "restricted";
  elements.runCommand.disabled =
    opening || busy || paneSaving || (currentSnapshot?.commands.length ?? 0) === 0;
  renderAllPaneEditControls();
  renderNoteBookmarks(currentSnapshot?.workspace?.files ?? [], loadedNote?.path ?? null);
}

elements.fileSearch.addEventListener("input", () => {
  scheduleVaultSearch();
});
elements.fileList.addEventListener("scroll", scheduleVirtualFileRender, { passive: true });
window.addEventListener("resize", scheduleVirtualFileRender);

function bindWorkspacePaneEvents(paneId: WorkspacePaneId, pane: WorkspacePaneElements): void {
  const activate = (): void => activateWorkspacePaneLocally(paneId);
  pane.workspacePane.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button !== 0 || paneId === activePaneContextId) {
        return;
      }
      if (busy || anyPaneSaving()) {
        event.preventDefault();
        return;
      }
      requestWorkspacePaneFocus(paneId);
    },
    { capture: true },
  );
  pane.workspacePane.addEventListener("focusin", () => {
    if (paneId !== activePaneContextId && !busy && !anyPaneSaving()) {
      requestWorkspacePaneFocus(paneId);
    }
  });
  pane.editView.addEventListener("click", () => {
    activate();
    setDocumentView("live");
  });
  pane.sourceView.addEventListener("click", () => {
    activate();
    setDocumentView("source");
  });
  pane.readView.addEventListener("click", () => {
    activate();
    setDocumentView("reading");
  });
  pane.pluginView.addEventListener("click", () => {
    activate();
    if (documentViewMode === "plugin") {
      setDocumentView(editingViewMode);
    } else {
      void activatePluginView();
    }
  });
  pane.popOutPluginView.addEventListener("click", () => {
    activate();
    void togglePluginPopout();
  });
  pane.notePreview.addEventListener("click", (event) => {
    activate();
    if (!(event.target instanceof Element)) {
      return;
    }
    const sourceAction = event.target.closest<HTMLButtonElement>(".preview-source-action");
    if (sourceAction) {
      void activatePreviewSourceAction(sourceAction);
      return;
    }
    const embedOpen = event.target.closest<HTMLButtonElement>(".preview-note-embed-open");
    if (embedOpen) {
      void activatePreviewEmbed(embedOpen);
      return;
    }
    const attachmentAction = event.target.closest<HTMLButtonElement>(".preview-attachment-action");
    if (attachmentAction) {
      activatePreviewAttachmentAction(attachmentAction);
      return;
    }
    const canvasOpen = event.target.closest<HTMLButtonElement>(".preview-canvas-embed-open");
    if (canvasOpen) {
      void activatePreviewEmbed(canvasOpen);
      return;
    }
    const anchor = event.target.closest<HTMLAnchorElement>("a[data-threadleaf-link]");
    if (anchor) {
      event.preventDefault();
      void activatePreviewLink(anchor);
    }
  });
  pane.splitPaneRight.addEventListener("click", () => {
    activate();
    void splitWorkspace("vertical");
  });
  pane.splitPaneDown.addEventListener("click", () => {
    activate();
    void splitWorkspace("horizontal");
  });
  pane.navigateBack.addEventListener("click", () => {
    activate();
    void navigateHistory("back", paneId);
  });
  pane.navigateForward.addEventListener("click", () => {
    activate();
    void navigateHistory("forward", paneId);
  });
  pane.moveTabPane.addEventListener("click", () => {
    activate();
    void moveActiveTabToOtherPane();
  });
  pane.closePane.addEventListener("click", () => {
    activate();
    void closeActiveWorkspacePane();
  });
  pane.moveNote.addEventListener("click", () => {
    activate();
    void executeRendererCommand("workspace.move-note");
  });
  pane.bookmarkNote.addEventListener("click", () => {
    activate();
    void executeRendererCommand("workspace.toggle-note-bookmark");
  });
  pane.exportNote.addEventListener("click", () => {
    activate();
    void executeRendererCommand("workspace.export-note-html");
  });
  pane.deleteNote.addEventListener("click", () => {
    activate();
    void executeRendererCommand("workspace.delete-note");
  });
  pane.saveNote.addEventListener("click", () => {
    activate();
    void executeRendererCommand("editor.save-note");
  });
  pane.revertNote.addEventListener("click", () => {
    activate();
    void executeRendererCommand("editor.revert-note");
  });
  pane.dismissEditNotice.addEventListener("click", () => {
    activate();
    clearEditNotice();
  });
}

const graphView = new GraphViewController(elements.graphDialog, {
  context: () => {
    if (!currentSnapshot?.vault.id) {
      return null;
    }
    return {
      vaultId: currentSnapshot.vault.id,
      vaultName: currentSnapshot.vault.name,
      indexGeneration: currentSnapshot.workspace?.indexGeneration ?? 0,
      rootPath: loadedNote?.path ?? null,
    };
  },
  load: (request, expectedVaultId) => window.threadleaf.getVaultGraph(request, expectedVaultId),
  openNote: (path) => openNote(path),
  setPluginSurfaceVisible: (visible) => {
    if (
      (!visible && documentViewMode === "plugin") ||
      (visible && !pluginSurfacePresentationVisible)
    ) {
      setPluginSurfacePresentationVisible(visible);
    }
  },
  report: showToast,
});

const recoveryView = new RecoveryViewController(elements.recoveryDialog, {
  context: () => {
    if (!currentSnapshot?.vault.id) {
      return null;
    }
    return {
      vaultId: currentSnapshot.vault.id,
      vaultName: currentSnapshot.vault.name,
      readOnly: currentSnapshot.vault.mode === "synthetic-read-only",
    };
  },
  load: (expectedVaultId) => window.threadleaf.getVaultTrash(expectedVaultId),
  restore: (path, expectedRevision, expectedVaultId) =>
    window.threadleaf.restoreNote(path, expectedRevision, expectedVaultId),
  renderSnapshot: render,
  setPluginSurfaceVisible: (visible) => {
    if (
      (!visible && documentViewMode === "plugin") ||
      (visible && !pluginSurfacePresentationVisible)
    ) {
      setPluginSurfacePresentationVisible(visible);
    }
  },
  report: showToast,
});

for (const [paneId, pane] of paneElements) {
  bindWorkspacePaneEvents(paneId, pane);
}

elements.collapseLeftDock.addEventListener("click", () => void toggleWorkspaceDock("left"));
elements.collapseRightDock.addEventListener("click", () => void toggleWorkspaceDock("right"));
for (const [button, dockId] of [
  [elements.collapseLeftDock, "left"],
  [elements.collapseRightDock, "right"],
] as const) {
  button.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    void toggleWorkspaceDock(dockId);
  });
}

elements.commandTrigger.addEventListener("click", openCommandPalette);
elements.settingsTrigger.addEventListener(
  "click",
  () => void executeRendererCommand("settings.open-keybindings"),
);
elements.themeToggle.addEventListener(
  "click",
  () => void executeRendererCommand("appearance.toggle-theme"),
);
elements.openVault.addEventListener(
  "click",
  () => void executeRendererCommand("workspace.open-vault"),
);
elements.newNote.addEventListener(
  "click",
  () => void executeRendererCommand("workspace.create-note"),
);
elements.propertyAdd.addEventListener("click", () => {
  void executeRendererCommand("workspace.manage-properties");
});

elements.runCommand.addEventListener("click", () => {
  const command = currentSnapshot?.commands[0];
  if (!command) {
    return;
  }
  void executeRendererCommand(`plugin.command.${command.id}`);
});

elements.reloadPlugin.addEventListener("click", () => void executeRendererCommand("plugin.reload"));

elements.unloadPlugin.addEventListener("click", () => void executeRendererCommand("plugin.unload"));

elements.paletteQuery.addEventListener("input", renderPaletteResults);
elements.paletteQuery.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    paletteSelection = movePaletteSelection(
      paletteMatches,
      paletteSelection,
      event.key === "ArrowDown" ? 1 : -1,
    );
    selectPaletteIndex(paletteSelection, true);
  } else if (event.key === "Enter") {
    event.preventDefault();
    const command = paletteMatches[paletteSelection];
    if (command?.enabled) {
      void executeRendererCommand(command.id);
    }
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeCommandPalette();
  }
});
elements.paletteClose.addEventListener("click", () => closeCommandPalette());
elements.commandPalette.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeCommandPalette();
});
elements.commandPalette.addEventListener("click", (event) => {
  if (event.target === elements.commandPalette) {
    closeCommandPalette();
  }
});
elements.quickSwitcherQuery.addEventListener("input", renderQuickSwitcherResults);
elements.quickSwitcherQuery.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    quickSwitcherSelection = moveQuickSwitcherSelection(
      quickSwitcherSelection,
      quickSwitcherMatches.length,
      event.key === "ArrowDown" ? 1 : -1,
    );
    selectQuickSwitcherIndex(quickSwitcherSelection, true);
  } else if (event.key === "Enter") {
    event.preventDefault();
    void chooseQuickSwitcherNote(quickSwitcherSelection);
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeQuickSwitcher();
  }
});
elements.quickSwitcherClose.addEventListener("click", () => closeQuickSwitcher());
elements.quickSwitcher.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeQuickSwitcher();
});
elements.quickSwitcher.addEventListener("click", (event) => {
  if (event.target === elements.quickSwitcher) {
    closeQuickSwitcher();
  }
});

elements.settingsClose.addEventListener("click", () => closeSettings());
elements.settingsDone.addEventListener("click", () => closeSettings());
elements.settingsReset.addEventListener("click", () => void resetKeyBindings());
elements.settingsNavAppearance.addEventListener("click", () => setSettingsPage("appearance"));
elements.settingsNavAccessibility.addEventListener("click", () => setSettingsPage("accessibility"));
elements.settingsNavNotes.addEventListener("click", () => setSettingsPage("notes"));
elements.settingsNavWorkspace.addEventListener("click", () => setSettingsPage("workspace"));
elements.settingsNavPlugins.addEventListener("click", () => setSettingsPage("plugins"));
elements.settingsNavMigration.addEventListener("click", () => setSettingsPage("migration"));
elements.settingsNavUpdates.addEventListener("click", () => setSettingsPage("updates"));
elements.settingsNavHotkeys.addEventListener("click", () => setSettingsPage("hotkeys"));
elements.appUpdateCheck.addEventListener("click", () => void runAppUpdateAction("check"));
elements.appUpdateDownload.addEventListener("click", () => void runAppUpdateAction("download"));
elements.appUpdateInstall.addEventListener("click", () => void runAppUpdateAction("install"));
elements.supportBundleExport.addEventListener("click", () => void exportSupportBundle());
elements.noteWorkflowForm.addEventListener("input", () => {
  captureNoteWorkflowDraft();
});
elements.noteWorkflowForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveNoteWorkflows();
});
elements.workspaceSettingsForm.addEventListener("input", () => {
  captureWorkspaceSettingsDraft();
});
elements.workspaceSettingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveWorkspaceSettings();
});
elements.workspaceSettingsReset.addEventListener("click", () => void resetWorkspaceSettings());
elements.migrationRefresh.addEventListener("click", () => {
  void refreshMigrationPreview(
    "Migration preview refreshed. Review the exact candidates before applying.",
  );
});
elements.migrationApply.addEventListener("click", () => {
  void applyMigrationReview();
});
elements.migrationRollback.addEventListener("click", () => {
  void rollbackMigrationReview();
});
elements.pluginModeToggle.addEventListener("click", () => {
  void setCompatibilityMode(
    currentPluginPreference().compatibilityMode === "restricted" ? "enabled" : "restricted",
  );
});
elements.pluginReloadAll.addEventListener("click", () => void reloadPlugins());
elements.pluginSearch.addEventListener("input", renderPluginSettings);
elements.pluginIndexSearch.addEventListener("click", () => void searchOpenPluginIndex());
elements.pluginIndexQuery.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void searchOpenPluginIndex();
  }
});
elements.pluginPackageReviewClose.addEventListener("click", () => {
  void closePluginPackageReview();
});
elements.pluginPackageReviewCancel.addEventListener("click", () => {
  void closePluginPackageReview();
});
elements.pluginPackageReviewApply.addEventListener("click", () => {
  void applyPluginPackageReview();
});
elements.pluginPackageReviewDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  void closePluginPackageReview();
});
elements.pluginPackageReviewDialog.addEventListener("click", (event) => {
  if (event.target === elements.pluginPackageReviewDialog) {
    void closePluginPackageReview();
  }
});
elements.pluginAuthorityReviewClose.addEventListener("click", () => {
  closePluginAuthorityReview();
});
elements.pluginAuthorityReviewCancel.addEventListener("click", () => {
  closePluginAuthorityReview();
});
elements.pluginAuthorityReviewGrant.addEventListener("click", () => {
  void applyPluginAuthorityReview();
});
elements.pluginAuthorityReviewDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closePluginAuthorityReview();
});
elements.pluginAuthorityReviewDialog.addEventListener("click", (event) => {
  if (event.target === elements.pluginAuthorityReviewDialog) {
    closePluginAuthorityReview();
  }
});
for (const [input, colorScheme] of [
  [elements.schemeSystem, "system"],
  [elements.schemeLight, "light"],
  [elements.schemeDark, "dark"],
] as const) {
  input.addEventListener("change", () => {
    if (!input.checked) {
      return;
    }
    void persistAppearance(
      { ...currentAppearancePreference(), colorScheme },
      colorScheme === "system"
        ? "Color scheme now follows the desktop."
        : `${colorScheme === "light" ? "Light" : "Dark"} mode saved.`,
    );
  });
}
elements.appearanceTheme.addEventListener("change", () => {
  void persistAppearance(
    {
      ...currentAppearancePreference(),
      themeId: elements.appearanceTheme.value || null,
    },
    elements.appearanceTheme.value ? "Community theme applied." : "Threadleaf theme restored.",
  );
});
elements.appearanceReload.addEventListener("click", () => {
  void refreshAppearance("Appearance files reloaded.");
});
elements.appearanceReset.addEventListener("click", () => void disableCustomAppearance());
elements.appearancePackageOpen.addEventListener("click", () => {
  void previewLocalAppearancePackage();
});
elements.appearancePackageRefresh.addEventListener("click", () => {
  void refreshAppearancePackages("Package inventory refreshed.");
});
elements.appearancePackageReviewClose.addEventListener("click", () => {
  void closeAppearancePackageReview();
});
elements.appearancePackageReviewCancel.addEventListener("click", () => {
  void closeAppearancePackageReview();
});
elements.appearancePackageReviewApply.addEventListener("click", () => {
  void applyAppearancePackageReview();
});
elements.appearancePackageReviewDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  void closeAppearancePackageReview();
});
elements.appearancePackageReviewDialog.addEventListener("click", (event) => {
  if (event.target === elements.appearancePackageReviewDialog) {
    void closeAppearancePackageReview();
  }
});
for (const [control, preferenceKey] of [
  [elements.accessibilityHighContrast, "highContrast"],
  [elements.accessibilityReducedMotion, "reducedMotion"],
  [elements.accessibilityReducedTransparency, "reducedTransparency"],
] as const) {
  control.addEventListener("change", () => {
    void persistAccessibilityPreferences({
      ...accessibilityDraftFromControls(),
      [preferenceKey]: accessibilityOverrideFromControl(control.value),
    });
  });
}
elements.accessibilityAccent.addEventListener("change", () => {
  void persistAccessibilityPreferences(accessibilityDraftFromControls());
});
for (const control of [
  elements.accessibilityUiFontScale,
  elements.accessibilityTextFontScale,
  elements.accessibilityEditorFontSize,
  elements.accessibilityEditorLineHeight,
]) {
  control.addEventListener("change", () => {
    try {
      void persistAccessibilityPreferences(accessibilityDraftFromControls());
    } catch (error) {
      accessibilityMessage = error instanceof Error ? error.message : String(error);
      accessibilityMessageKind = "error";
      renderSettings();
    }
  });
}
elements.accessibilityReset.addEventListener("click", () => void resetAccessibilityPreferences());
elements.settingsDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  if (recordingShortcut) {
    cancelShortcutRecording(recordingShortcut);
  } else {
    closeSettings();
  }
});
elements.settingsDialog.addEventListener("click", (event) => {
  if (event.target === elements.settingsDialog) {
    closeSettings();
  }
});

elements.newNoteForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void createNewNote();
});
elements.newNoteClose.addEventListener("click", () => closeNewNoteDialog());
elements.newNoteCancel.addEventListener("click", () => closeNewNoteDialog());
elements.newNoteDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeNewNoteDialog();
});
elements.newNoteDialog.addEventListener("click", (event) => {
  if (event.target === elements.newNoteDialog) {
    closeNewNoteDialog();
  }
});
elements.templatePickerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void insertSelectedTemplate();
});
elements.templatePickerClose.addEventListener("click", () => closeTemplatePicker());
elements.templatePickerCancel.addEventListener("click", () => closeTemplatePicker());
elements.templatePickerDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeTemplatePicker();
});
elements.templatePickerDialog.addEventListener("click", (event) => {
  if (event.target === elements.templatePickerDialog) {
    closeTemplatePicker();
  }
});

elements.propertyType.addEventListener("change", configurePropertyValueInput);
elements.propertyForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void savePropertyChange();
});
elements.propertyDialogClose.addEventListener("click", () => closePropertyDialog());
elements.propertyCancel.addEventListener("click", () => closePropertyDialog());
elements.propertyDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closePropertyDialog();
});
elements.propertyDialog.addEventListener("click", (event) => {
  if (event.target === elements.propertyDialog) {
    closePropertyDialog();
  }
});

elements.moveNoteTarget.addEventListener("input", () => {
  moveNoteBlockers = [];
  moveNoteRewrites = [];
  moveNoteConfirmationId = null;
  elements.moveNoteError.textContent = "";
  elements.moveNotePreviewMessage.textContent = "";
  renderMoveNoteDialog();
});
elements.moveNoteForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void moveCurrentNote();
});
elements.moveNoteClose.addEventListener("click", () => closeMoveNoteDialog());
elements.moveNoteCancel.addEventListener("click", () => closeMoveNoteDialog());
elements.moveNoteDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeMoveNoteDialog();
});
elements.moveNoteDialog.addEventListener("click", (event) => {
  if (event.target === elements.moveNoteDialog) {
    closeMoveNoteDialog();
  }
});

elements.attachmentMoveTarget.addEventListener("input", () => {
  attachmentMoveBlockers = [];
  attachmentMoveRewrites = [];
  attachmentMoveConfirmationId = null;
  elements.attachmentMoveError.textContent = "";
  elements.attachmentMovePreviewMessage.textContent = "";
  renderAttachmentMoveDialog();
});
elements.attachmentMoveForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void moveCurrentAttachment();
});
elements.attachmentMoveClose.addEventListener("click", () => closeAttachmentMoveDialog());
elements.attachmentMoveCancel.addEventListener("click", () => closeAttachmentMoveDialog());
elements.attachmentMoveDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeAttachmentMoveDialog();
});
elements.attachmentMoveDialog.addEventListener("click", (event) => {
  if (event.target === elements.attachmentMoveDialog) closeAttachmentMoveDialog();
});

elements.deleteNoteForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void deleteCurrentNote();
});
elements.deleteNoteClose.addEventListener("click", () => closeDeleteNoteDialog());
elements.deleteNoteCancel.addEventListener("click", () => closeDeleteNoteDialog());
elements.deleteNoteDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeDeleteNoteDialog();
});
elements.deleteNoteDialog.addEventListener("click", (event) => {
  if (event.target === elements.deleteNoteDialog) {
    closeDeleteNoteDialog();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.repeat) {
    return;
  }
  const targetId = shortcutTargetForEvent(settingsSnapshot.settings.keyBindings, event, isMac);
  if (targetId === "workspace.close-tab") {
    event.preventDefault();
  }
  if (targetId === "ui.command-palette") {
    if (
      elements.settingsDialog.open ||
      elements.graphDialog.open ||
      elements.recoveryDialog.open ||
      elements.newNoteDialog.open ||
      elements.templatePickerDialog.open ||
      elements.propertyDialog.open ||
      elements.moveNoteDialog.open ||
      elements.attachmentMoveDialog.open ||
      elements.deleteNoteDialog.open ||
      elements.quickSwitcher.open ||
      elements.pluginPackageReviewDialog.open ||
      elements.pluginAuthorityReviewDialog.open ||
      elements.appearancePackageReviewDialog.open
    ) {
      return;
    }
    event.preventDefault();
    if (elements.commandPalette.open) {
      closeCommandPalette();
    } else {
      openCommandPalette();
    }
    return;
  }
  if (targetId === "workspace.quick-switcher") {
    if (
      elements.settingsDialog.open ||
      elements.graphDialog.open ||
      elements.recoveryDialog.open ||
      elements.newNoteDialog.open ||
      elements.templatePickerDialog.open ||
      elements.propertyDialog.open ||
      elements.moveNoteDialog.open ||
      elements.attachmentMoveDialog.open ||
      elements.deleteNoteDialog.open ||
      elements.pluginPackageReviewDialog.open ||
      elements.pluginAuthorityReviewDialog.open ||
      elements.appearancePackageReviewDialog.open
    ) {
      return;
    }
    event.preventDefault();
    if (elements.quickSwitcher.open) {
      closeQuickSwitcher();
    } else {
      openQuickSwitcher();
    }
    return;
  }
  if (targetId === "settings.open-keybindings") {
    if (
      elements.graphDialog.open ||
      elements.recoveryDialog.open ||
      elements.newNoteDialog.open ||
      elements.templatePickerDialog.open ||
      elements.propertyDialog.open ||
      elements.moveNoteDialog.open ||
      elements.attachmentMoveDialog.open ||
      elements.deleteNoteDialog.open ||
      elements.quickSwitcher.open ||
      elements.pluginPackageReviewDialog.open ||
      elements.pluginAuthorityReviewDialog.open ||
      elements.appearancePackageReviewDialog.open
    ) {
      return;
    }
    event.preventDefault();
    if (elements.settingsDialog.open) {
      closeSettings();
    } else {
      void executeRendererCommand(targetId);
    }
    return;
  }
  if (
    elements.commandPalette.open ||
    elements.settingsDialog.open ||
    elements.graphDialog.open ||
    elements.recoveryDialog.open ||
    elements.newNoteDialog.open ||
    elements.templatePickerDialog.open ||
    elements.propertyDialog.open ||
    elements.moveNoteDialog.open ||
    elements.attachmentMoveDialog.open ||
    elements.deleteNoteDialog.open ||
    elements.quickSwitcher.open ||
    elements.pluginPackageReviewDialog.open ||
    elements.pluginAuthorityReviewDialog.open ||
    elements.appearancePackageReviewDialog.open
  ) {
    return;
  }
  if (targetId) {
    event.preventDefault();
    void executeRendererCommand(targetId);
  } else if (event.key === "Escape" && document.activeElement === elements.fileSearch) {
    elements.fileSearch.value = "";
    elements.fileSearch.dispatchEvent(new Event("input"));
  }
});

updateShortcutLabels();

resetPaneDocumentModes(null);

applyColorScheme("system");
const handleSystemColorSchemeChange = (): void => {
  if (currentAppearancePreference().colorScheme === "system") {
    applyColorScheme("system");
    renderSettings();
  }
};
systemColorScheme.addEventListener("change", handleSystemColorSchemeChange);
const handleSystemAccessibilityChange = (): void => {
  const preferences = currentAccessibilityPreferences();
  if (
    preferences.highContrast === null ||
    preferences.reducedMotion === null ||
    preferences.reducedTransparency === null
  ) {
    setAccessibilityRootAttributes(effectiveCurrentAccessibilityPreferences());
    renderSettings();
  }
};
systemHighContrast.addEventListener("change", handleSystemAccessibilityChange);
systemReducedMotion.addEventListener("change", handleSystemAccessibilityChange);
systemReducedTransparency.addEventListener("change", handleSystemAccessibilityChange);

const unsubscribe = window.threadleaf.onSnapshot(render);
const unsubscribeWorkspaceLayout = window.threadleaf.onWorkspaceLayout((snapshot) => {
  renderWorkspaceLayout(snapshot);
  renderDocumentView();
});
const unsubscribeSettings = window.threadleaf.onSettings(applySettingsSnapshot);
const unsubscribeAccessibility = window.threadleaf.onAccessibilityPreferences(
  applyAccessibilityPreferences,
);
const unsubscribeAppUpdate = window.threadleaf.onAppUpdate(applyAppUpdateSnapshot);
const unsubscribeAppearance = window.threadleaf.onAppearance((snapshot) => {
  if (snapshot.vaultId !== currentSnapshot?.vault.id) {
    return;
  }
  appearanceRequest += 1;
  appearanceBusy = false;
  applyAppearanceSnapshot(snapshot);
  appearanceMessage =
    snapshot.warnings.length > 0
      ? "Appearance files changed. Review the diagnostic below; saved selections were kept."
      : `${snapshot.themes.length} themes and ${snapshot.snippets.length} snippets reloaded after a file change.`;
  appearanceMessageKind = snapshot.warnings.length > 0 ? "error" : "saved";
  renderSettings();
  renderPaletteResults();
});
const unsubscribeMenuCommand = window.threadleaf.onMenuCommand((commandId) => {
  const openDialog = document.querySelector<HTMLDialogElement>("dialog[open]");
  if (commandId === "ui.command-palette") {
    if (openDialog && openDialog !== elements.commandPalette) {
      return;
    }
    openCommandPalette();
    return;
  }
  if (commandId === "workspace.quick-switcher") {
    if (openDialog && openDialog !== elements.quickSwitcher) {
      return;
    }
    if (elements.quickSwitcher.open) {
      closeQuickSwitcher();
    } else {
      openQuickSwitcher();
    }
    return;
  }
  if (commandId === "settings.open-keybindings") {
    if (
      openDialog &&
      openDialog !== elements.commandPalette &&
      openDialog !== elements.settingsDialog &&
      openDialog !== elements.appearancePackageReviewDialog
    ) {
      return;
    }
    if (elements.settingsDialog.open) {
      elements.settingsDialog.focus();
      return;
    }
  } else if (openDialog) {
    return;
  }
  void executeRendererCommand(commandId);
});
const pluginSurfaceResizeObserver = new ResizeObserver(() => {
  if (documentViewMode === "plugin") {
    void updatePluginSurfaceBounds();
  }
});
for (const pane of paneElements.values()) {
  pluginSurfaceResizeObserver.observe(pane.pluginSurfaceHost);
}
window.addEventListener("beforeunload", (event) => {
  let hasDirtyPane = false;
  for (const paneId of ["primary", "secondary"] as const) {
    runInPaneContext(paneId, () => {
      if (!dirty) {
        return;
      }
      hasDirtyPane = true;
      if (editorDraftTimer !== undefined) {
        window.clearTimeout(editorDraftTimer);
        editorDraftTimer = undefined;
      }
      void persistCurrentEditorDraft();
    });
  }
  if (hasDirtyPane) {
    event.preventDefault();
    event.returnValue = "";
  }
});
window.addEventListener(
  "unload",
  () => {
    if (vaultSearchTimer !== undefined) {
      window.clearTimeout(vaultSearchTimer);
    }
    for (const paneId of ["primary", "secondary"] as const) {
      runInPaneContext(paneId, () => {
        if (editorDraftTimer !== undefined) {
          window.clearTimeout(editorDraftTimer);
          editorDraftTimer = undefined;
        }
      });
    }
    unsubscribe();
    unsubscribeWorkspaceLayout();
    unsubscribeSettings();
    unsubscribeAccessibility();
    unsubscribeAppUpdate();
    unsubscribeAppearance();
    unsubscribeMenuCommand();
    systemColorScheme.removeEventListener("change", handleSystemColorSchemeChange);
    systemHighContrast.removeEventListener("change", handleSystemAccessibilityChange);
    systemReducedMotion.removeEventListener("change", handleSystemAccessibilityChange);
    systemReducedTransparency.removeEventListener("change", handleSystemAccessibilityChange);
    pluginSurfaceResizeObserver.disconnect();
    graphView.destroy();
    recoveryView.destroy();
    for (const session of paneSessions.values()) {
      session.editor?.destroy();
    }
  },
  { once: true },
);
void window.threadleaf
  .getSnapshot()
  .then((snapshot) => {
    render(snapshot);
    window.requestAnimationFrame(() => {
      document.documentElement.dataset.threadleafShellReady = "true";
      performance.mark("threadleaf:shell-ready");
      window.threadleaf.markStartupShellReady();
    });
  })
  .catch((error: unknown) => showToast(error instanceof Error ? error.message : String(error)));
void window.threadleaf
  .getSettings()
  .then(applySettingsSnapshot)
  .catch((error: unknown) => {
    // A missing settings snapshot falls back to safe Live mode, but it must
    // still release the startup gate so the editor is reachable.
    settingsLoaded = true;
    renderDocumentView();
    showToast(error instanceof Error ? error.message : String(error));
  });
void window.threadleaf
  .getAccessibilityPreferences()
  .then(applyAccessibilityPreferences)
  .catch((error: unknown) => showToast(error instanceof Error ? error.message : String(error)));
void window.threadleaf
  .getAppUpdate()
  .then(applyAppUpdateSnapshot)
  .catch(() => undefined);
