import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { basicSetup, EditorView } from "codemirror";
import {
  type AppearanceSnapshot,
  type ColorSchemePreference,
  createDefaultVaultAppearance,
  effectiveColorScheme,
  type VaultAppearanceSettings,
} from "../shared/appearance";
import type {
  NoteCreateResponse,
  NoteDeleteResponse,
  NoteMoveBlocker,
  NoteMoveResponse,
  NoteMoveRewritePreview,
  PluginEditorContext,
  PluginEditorUpdate,
  RuntimeSnapshot,
  VaultSearchResponse,
  VaultSearchResult,
  WorkspaceFileSummary,
  WorkspaceLinkSummary,
  WorkspaceNoteSnapshot,
  WorkspaceTabSummary,
} from "../shared/contracts";
import {
  type AppSettingsSnapshot,
  appearanceForVault,
  bindingFromKeyboardEvent,
  createDefaultAppSettings,
  displayKeyBinding,
  pluginsForVault,
  type ShortcutTargetId,
  shortcutTargetForEvent,
} from "../shared/key-bindings";
import {
  createDefaultVaultPluginSettings,
  type PluginCatalogSnapshot,
  type VaultPluginSettings,
} from "../shared/plugins";
import {
  filterPaletteCommands,
  firstEnabledPaletteIndex,
  movePaletteSelection,
  type PaletteCommandDescriptor,
} from "./command-palette-model";
import {
  addPreviewSourceControls,
  hydrateMarkdownPreviewImages,
  renderMarkdownPreview,
} from "./markdown-preview";
import { pluginViewTypeForPath } from "./plugin-view-model";
import "./styles.css";

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
  fileList: getElement("file-list"),
  indexStatus: getElement("index-status"),
  recoveryCount: getElement("recovery-count"),
  noteTabs: getElement("note-tabs"),
  notePath: getElement("note-path"),
  noteEmpty: getElement("note-empty"),
  noteView: getElement("note-view"),
  noteTitle: getElement("note-title"),
  noteStats: getElement("note-stats"),
  noteTags: getElement("note-tags"),
  editView: getButton("edit-view"),
  readView: getButton("read-view"),
  pluginView: getButton("plugin-view"),
  pluginSurfaceHost: getElement("plugin-surface-host"),
  noteEditorShell: getElement("note-editor-shell"),
  noteEditor: getElement("note-editor"),
  notePreview: getElement("note-preview"),
  editState: getElement("edit-state"),
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
  paletteQuery: getInput("palette-query"),
  paletteClose: getButton("palette-close"),
  paletteCount: getElement("palette-count"),
  paletteResults: getElement("palette-results"),
  paletteHint: getElement("palette-hint"),
  settingsDialog: getDialog("shortcut-settings"),
  settingsClose: getButton("settings-close"),
  settingsDone: getButton("settings-done"),
  settingsReset: getButton("settings-reset"),
  settingsPageEyebrow: getElement("settings-page-eyebrow"),
  settingsPageTitle: getElement("settings-page-title"),
  settingsNavAppearance: getButton("settings-nav-appearance"),
  settingsNavPlugins: getButton("settings-nav-plugins"),
  settingsNavHotkeys: getButton("settings-nav-hotkeys"),
  settingsWarning: getElement("settings-warning"),
  appearanceState: getElement("appearance-state"),
  appearanceTheme: getSelect("appearance-theme"),
  appearanceThemeDetail: getElement("appearance-theme-detail"),
  appearanceSnippets: getElement("appearance-snippets"),
  appearanceReload: getButton("appearance-reload"),
  appearanceReset: getButton("appearance-reset"),
  appearanceStatus: getElement("appearance-status"),
  appearanceWarnings: getElement("appearance-warnings"),
  pluginModeState: getElement("plugin-mode-state"),
  pluginModeToggle: getButton("plugin-mode-toggle"),
  pluginInstalledCount: getElement("plugin-installed-count"),
  pluginReloadAll: getButton("plugin-reload-all"),
  pluginSearch: getInput("plugin-search"),
  pluginList: getElement("plugin-list"),
  pluginStatus: getElement("plugin-status"),
  pluginWarnings: getElement("plugin-warnings"),
  schemeSystem: getInput("scheme-system"),
  schemeLight: getInput("scheme-light"),
  schemeDark: getInput("scheme-dark"),
  settingsList: getElement("key-binding-list"),
  settingsStatus: getElement("settings-status"),
  newNoteDialog: getDialog("new-note-dialog"),
  newNoteForm: getForm("new-note-form"),
  newNotePath: getInput("new-note-path"),
  newNoteClose: getButton("new-note-close"),
  newNoteCancel: getButton("new-note-cancel"),
  newNoteCreate: getButton("new-note-create"),
  newNoteError: getElement("new-note-error"),
  newNoteVault: getElement("new-note-vault"),
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
  toast: getElement("toast"),
};

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

type DocumentViewMode = "source" | "reading" | "plugin";
type SettingsPage = "appearance" | "plugins" | "hotkeys";

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
    id: "workspace.create-note",
    label: "Create new note",
    description: "Create and open a Markdown note through the recoverable writer.",
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
    id: "editor.toggle-reading-view",
    label: "Toggle editing or reading view",
    description: "Preview the current draft or return to its Markdown source.",
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
let loadedNote: WorkspaceNoteSnapshot | null = null;
let loadedVaultId: string | null = null;
let pendingDiskNote: WorkspaceNoteSnapshot | null = null;
let diskChanged = false;
let editNoticeState: EditNoticeState | null = null;
let lastVaultWarning: string | null = null;
let toastTimer: number | undefined;
let busy = false;
let saving = false;
let dirty = false;
let syncingEditor = false;
let documentViewMode: DocumentViewMode = "source";
let renderedPreviewPath: string | null = null;
let renderedPreviewSource: string | null = null;
let renderedPreviewVaultId: string | null = null;
let renderedPreviewWatchSequence = -1;
let previewImageRequest = 0;
let pluginSurfaceRequest = 0;
let pluginLayoutReadyVaultId: string | null = null;
let paletteMatches: RendererCommand[] = [];
let paletteSelection = -1;
let paletteRestoreFocus: HTMLElement | null = null;
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
let appearanceSnapshot: AppearanceSnapshot | null = null;
let appearanceBusy = false;
let appearanceRequest = 0;
let appearanceMessage = "Discovering themes and snippets in this vault.";
let appearanceMessageKind: "info" | "saved" | "error" = "info";
let lastAppearanceWarning = "";
let pluginCatalog: PluginCatalogSnapshot | null = null;
let pluginBusy = false;
let pluginRequest = 0;
let pluginMessage = "Discovering installed plugins in this vault.";
let pluginMessageKind: "info" | "saved" | "warning" | "error" = "info";
let lastPluginWarning = "";
let lastPluginEditorUpdateId: string | null = null;
let pluginSurfacePresentationVisible = true;
let legacyThemeMigrationAttempted = false;
let newNoteRestoreFocus: HTMLElement | null = null;
let newNoteBusy = false;
let newNoteVaultId: string | null = null;
let moveNoteRestoreFocus: HTMLElement | null = null;
let moveNoteBusy = false;
let moveNoteVaultId: string | null = null;
let moveNoteSourcePath: string | null = null;
let moveNoteRevision: string | null = null;
let moveNoteBlockers: NoteMoveBlocker[] = [];
let moveNoteRewrites: NoteMoveRewritePreview[] = [];
let moveNoteConfirmationId: string | null = null;
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

const editorStyleNonce = "threadleaf-codemirror";
const appearanceStyle = document.createElement("style");
appearanceStyle.id = "threadleaf-custom-appearance";
appearanceStyle.nonce = editorStyleNonce;
document.head.append(appearanceStyle);
const pluginStyle = document.createElement("style");
pluginStyle.id = "threadleaf-compatibility-plugin-styles";
pluginStyle.nonce = editorStyleNonce;
document.head.append(pluginStyle);
const systemColorScheme = window.matchMedia("(prefers-color-scheme: dark)");
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

const editor = new EditorView({
  doc: "",
  parent: elements.noteEditor,
  extensions: [
    basicSetup,
    markdown(),
    EditorView.lineWrapping,
    EditorView.cspNonce.of(editorStyleNonce),
    syntaxHighlighting(sourceHighlight),
    EditorView.contentAttributes.of({
      "aria-label": "Markdown source editor",
      "aria-multiline": "true",
      spellcheck: "true",
    }),
    EditorView.updateListener.of((update) => {
      if (!syncingEditor && update.docChanged) {
        dirty = true;
        renderEditControls();
      }
    }),
  ],
});

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

function commandCatalog(): RendererCommand[] {
  const tabs = currentSnapshot?.workspace?.tabs ?? [];
  const commands: RendererCommand[] = [
    {
      id: "workspace.create-note",
      label: "Create new note",
      category: "Workspace",
      keywords: ["new", "file", "markdown", "note"],
      shortcut: shortcutFor("workspace.create-note"),
      enabled: Boolean(currentSnapshot?.vault.id && !busy && !saving && !dirty),
      disabledReason: dirty
        ? "Save or revert the open note before creating another."
        : currentSnapshot?.vault.id
          ? "Threadleaf is finishing another action."
          : "No writable vault is active.",
      run: openNewNoteDialog,
    },
    {
      id: "workspace.move-note",
      label: "Move or rename current note",
      category: "Workspace",
      keywords: ["move", "rename", "path", "file", "refactor"],
      shortcut: shortcutFor("workspace.move-note"),
      enabled: Boolean(loadedNote && loadedVaultId && !busy && !saving && !dirty),
      disabledReason: !loadedNote
        ? "No note is open."
        : dirty
          ? "Save or revert the current note before moving it."
          : "Threadleaf is finishing another action.",
      run: openMoveNoteDialog,
    },
    {
      id: "workspace.delete-note",
      label: "Move current note to trash",
      category: "Workspace",
      keywords: ["delete", "remove", "trash", "recover", "file"],
      shortcut: shortcutFor("workspace.delete-note"),
      enabled: Boolean(loadedNote && loadedVaultId && !busy && !saving && !dirty),
      disabledReason: !loadedNote
        ? "No note is open."
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
      enabled: Boolean(loadedNote && loadedVaultId && !busy && !saving && !dirty),
      disabledReason: !loadedNote
        ? "No note tab is active."
        : dirty
          ? "Save or revert the current note before closing it."
          : "Threadleaf is finishing another action.",
      run: closeActiveTab,
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
      enabled: !busy && !saving && !dirty,
      disabledReason: dirty
        ? "Save or revert the open note before switching vaults."
        : busy || saving
          ? "Threadleaf is finishing another action."
          : null,
      run: chooseVault,
    },
    {
      id: "workspace.focus-note-filter",
      label: "Focus vault search",
      category: "Workspace",
      keywords: ["find", "files", "content", "full text", "quick switcher"],
      shortcut: shortcutFor("workspace.focus-note-filter"),
      enabled: true,
      disabledReason: null,
      run: focusVaultSearch,
    },
    {
      id: "editor.save-note",
      label: "Save current note",
      category: "Editor",
      keywords: ["write", "commit"],
      shortcut: shortcutFor("editor.save-note"),
      enabled: Boolean(loadedNote && loadedVaultId && dirty && !busy && !saving),
      disabledReason: !loadedNote
        ? "No note is open."
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
      enabled: Boolean(currentSnapshot?.vault.id && !appearanceBusy),
      disabledReason: appearanceBusy
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
      enabled: Boolean(currentSnapshot?.vault.id && !appearanceBusy),
      disabledReason: appearanceBusy
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
      enabled: !settingsOperationBusy(),
      disabledReason: settingsOperationBusy() ? "Threadleaf is saving application settings." : null,
      run: openSettings,
    },
  ];

  for (const command of currentSnapshot?.commands ?? []) {
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
  let normalized: string;
  try {
    normalized = decodeURIComponent(value).replaceAll("\\", "/");
  } catch {
    normalized = value.replaceAll("\\", "/");
  }
  const headingIndex = normalized.indexOf("#");
  const blockIndex = normalized.indexOf("^");
  const indexes = [headingIndex, blockIndex].filter((index) => index >= 0);
  const splitAt = indexes.length > 0 ? Math.min(...indexes) : -1;
  if (splitAt === -1) {
    return { target: normalized.trim(), subpath: null };
  }
  return {
    target: normalized.slice(0, splitAt).trim(),
    subpath: normalized.slice(splitAt).trim() || null,
  };
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
  note: WorkspaceNoteSnapshot,
  anchor: HTMLAnchorElement,
): WorkspaceLinkSummary | null {
  const identity = previewLinkIdentity(anchor);
  if (!identity) {
    return null;
  }
  return (
    note.outgoing.find(
      (link) =>
        link.syntax === identity.syntax &&
        link.target === identity.target &&
        (link.subpath ?? null) === identity.subpath,
    ) ?? null
  );
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
    previewImageRequest += 1;
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
  const request = previewImageRequest + 1;
  previewImageRequest = request;
  const fragment = addPreviewSourceControls(renderMarkdownPreview(source));
  elements.notePreview.replaceChildren(fragment);
  for (const anchor of elements.notePreview.querySelectorAll<HTMLAnchorElement>(
    "a[data-threadleaf-link]",
  )) {
    if (anchor.dataset.threadleafLink === "external") {
      anchor.ariaLabel = `${anchor.textContent?.trim() || "External link"}, external link`;
      anchor.title = "External link opening is disabled in this pre-alpha build.";
      continue;
    }
    const identity = previewLinkIdentity(anchor);
    if (identity) {
      anchor.dataset.threadleafTarget = identity.target;
      anchor.dataset.threadleafSubpath = identity.subpath ?? "";
    }
    const link = matchingPreviewLink(loadedNote, anchor);
    const status = link?.status ?? "unresolved";
    anchor.dataset.linkStatus = status;
    anchor.ariaLabel = `${anchor.textContent?.trim() || "Internal link"}, ${status} internal link`;
    if (link?.path) {
      anchor.dataset.threadleafPath = link.path;
    }
  }
  renderedPreviewPath = loadedNote.path;
  renderedPreviewSource = source;
  renderedPreviewVaultId = vaultId;
  renderedPreviewWatchSequence = watchSequence;
  if (vaultId) {
    void hydrateMarkdownPreviewImages(elements.notePreview, {
      sourceNotePath: loadedNote.path,
      expectedVaultId: vaultId,
      loadImage: (sourceNotePath, target, expectedVaultId) =>
        window.threadleaf.loadVaultImage(sourceNotePath, target, expectedVaultId),
      isCurrent: () =>
        previewImageRequest === request &&
        loadedVaultId === vaultId &&
        renderedPreviewPath === loadedNote?.path &&
        renderedPreviewSource === source,
    });
  }
}

function renderDocumentView(): void {
  const hasNote = loadedNote !== null;
  const reading = hasNote && documentViewMode === "reading";
  const plugin = hasNote && documentViewMode === "plugin";
  const pluginViewType = preferredPluginViewType();
  const visiblePluginViewType =
    pluginViewType ?? (plugin ? (currentSnapshot?.pluginSurface?.viewType ?? null) : null);
  elements.noteEditorShell.hidden = reading;
  elements.notePreview.hidden = !reading;
  elements.noteView.hidden = !hasNote || plugin;
  elements.pluginSurfaceHost.hidden = !plugin;
  elements.noteView.dataset.view = reading ? "reading" : "source";
  elements.editView.disabled = !hasNote || busy || saving;
  elements.readView.disabled = !hasNote || busy || saving;
  elements.pluginView.hidden = visiblePluginViewType === null;
  elements.pluginView.disabled = !hasNote || !pluginViewType || busy || saving || dirty;
  elements.editView.setAttribute("aria-pressed", String(hasNote && !reading && !plugin));
  elements.readView.setAttribute("aria-pressed", String(reading));
  elements.pluginView.setAttribute("aria-pressed", String(plugin));
  elements.pluginView.title = visiblePluginViewType
    ? `${plugin ? "Showing" : "Open"} ${visiblePluginViewType} community plugin view`
    : "No community plugin view is registered";
  const shortcut = shortcutFor("editor.toggle-reading-view");
  elements.editView.title = shortcut ? `Editing view (${shortcut})` : "Editing view";
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
    const vaultId = currentSnapshot?.vault.id ?? null;
    if (vaultId && pluginLayoutReadyVaultId !== vaultId) {
      pluginLayoutReadyVaultId = vaultId;
      try {
        render(await window.threadleaf.markPluginLayoutReady());
      } catch (error) {
        showToast(
          `Plugin startup reported a compatibility gap: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const snapshot = await window.threadleaf.openPluginView(viewType, filePath);
    if (request !== pluginSurfaceRequest || documentViewMode !== "plugin") {
      await window.threadleaf.closePluginView();
      return;
    }
    render(snapshot);
  } catch (error) {
    documentViewMode = "source";
    renderDocumentView();
    showToast(error instanceof Error ? error.message : String(error));
  } finally {
    setActionState(false);
  }
}

function setDocumentView(mode: DocumentViewMode, focus = true): void {
  if (!loadedNote && mode === "plugin") {
    return;
  }
  const closingPlugin = documentViewMode === "plugin" && mode !== "plugin";
  documentViewMode = mode;
  if (mode !== "plugin") {
    localStorage.setItem("threadleaf-document-view", mode);
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
  if (mode === "source") {
    editor.focus();
  } else if (mode === "reading") {
    elements.notePreview.focus();
  }
}

function toggleDocumentView(): void {
  setDocumentView(documentViewMode === "reading" ? "source" : "reading");
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
  if (anchor.dataset.threadleafLink === "external") {
    showToast("External link opening is disabled in this pre-alpha build.");
    return;
  }
  if (!loadedNote) {
    return;
  }
  const link = matchingPreviewLink(loadedNote, anchor);
  if (link?.status !== "resolved" || !link.path) {
    showToast(
      link?.status === "ambiguous"
        ? "That link has more than one possible destination."
        : "That link does not resolve to a note in this vault.",
    );
    return;
  }
  const opened = await openNote(link.path);
  if (!opened) {
    return;
  }
  const line = sourceLineForSubpath(loadedNote, link.subpath);
  if (line) {
    scrollToDocumentLine(line);
  } else if (link.subpath?.startsWith("^")) {
    showToast("Block-anchor navigation is not available yet.");
  }
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
  settingsSnapshot = snapshot;
  settingsLoaded = true;
  updateShortcutLabels();
  renderDocumentView();
  if (snapshot.warning && snapshot.warning !== lastSettingsWarning) {
    showToast(snapshot.warning);
  }
  lastSettingsWarning = snapshot.warning;
  const nextAppearance = currentAppearancePreference();
  const nextPlugins = currentPluginPreference();
  applyColorScheme(nextAppearance.colorScheme);
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
  elements.newNoteCreate.disabled = newNoteBusy || staleVault;
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
  if (!currentSnapshot?.vault.id || busy || saving || dirty) {
    showToast(
      dirty
        ? "Save or revert the open note before creating another."
        : "A writable vault must be ready before creating a note.",
    );
    return;
  }
  if (elements.commandPalette.open) {
    closeCommandPalette(false);
  }
  if (documentViewMode === "plugin") {
    setDocumentView("source", false);
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
  setDocumentView("source", false);
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
  elements.moveNoteSubmit.disabled = moveNoteBusy || staleVault || staleNote;
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
  if (!loadedNote || !loadedVaultId || busy || saving || dirty) {
    showToast(
      dirty
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
    setDocumentView("source", false);
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
    } else if (response.outcome.reason === "target-exists") {
      moveNoteConfirmationId = null;
      moveNoteRewrites = [];
      elements.moveNotePreviewMessage.textContent = "";
      elements.moveNoteError.textContent = `${response.outcome.to} already exists. No files were changed.`;
    } else if (response.outcome.reason === "source-revision-changed") {
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
    setDocumentView("source", false);
    showToast(
      committedRewriteCount > 0
        ? `Moved note to ${committedPath} and updated ${committedRewriteCount} ${committedRewriteCount === 1 ? "link" : "links"}`
        : `Moved note to ${committedPath}`,
    );
    window.setTimeout(() => editor.focus(), 0);
  } else if (response?.outcome.status === "requires-confirmation") {
    elements.moveNoteSubmit.focus();
  } else if (response) {
    elements.moveNoteTarget.focus();
    elements.moveNoteTarget.select();
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
      ? "No indexed note currently links here. Restore this file later from .trash/."
      : `${deleteNoteBacklinkCount} indexed incoming link${deleteNoteBacklinkCount === 1 ? "" : "s"} will become unresolved. Restore this file later from .trash/.`;
  elements.deleteNoteClose.disabled = deleteNoteBusy;
  elements.deleteNoteCancel.disabled = deleteNoteBusy;
  elements.deleteNoteSubmit.disabled = deleteNoteBusy || staleVault || staleNote;
  elements.deleteNoteSubmit.textContent = deleteNoteBusy ? "Moving…" : "Move to trash";
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
  if (!loadedNote || !loadedVaultId || busy || saving || dirty) {
    showToast(
      dirty
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
    setDocumentView("source", false);
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
    } else if (response.outcome.reason === "target-exists") {
      elements.deleteNoteError.textContent = `${response.outcome.to} already contains an earlier deletion. Restore or move that file first. No files were changed.`;
    } else if (response.outcome.reason === "source-revision-changed") {
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
    setDocumentView("source", false);
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
  return settingsBusy || appearanceBusy || pluginBusy;
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
  return (
    left.compatibilityMode === right.compatibilityMode &&
    left.enabledPluginIds.length === right.enabledPluginIds.length &&
    left.enabledPluginIds.every((id, index) => id === right.enabledPluginIds[index])
  );
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
  renderPaletteResults();
}

function applyAppearanceSnapshot(snapshot: AppearanceSnapshot): void {
  if (snapshot.vaultId !== currentSnapshot?.vault.id) {
    return;
  }
  appearanceSnapshot = snapshot;
  appearanceStyle.textContent = snapshot.css;
  applyColorScheme(snapshot.preference.colorScheme);
  const warningKey = snapshot.warnings.join("\n");
  if (warningKey && warningKey !== lastAppearanceWarning) {
    showToast(snapshot.warnings[0] ?? "A custom appearance file could not be applied.");
  }
  lastAppearanceWarning = warningKey;
  renderSettings();
  renderPaletteResults();
}

async function refreshAppearance(successMessage?: string): Promise<void> {
  const vaultId = currentSnapshot?.vault.id;
  if (!vaultId) {
    appearanceSnapshot = null;
    appearanceStyle.textContent = "";
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
  const warningKey = catalog.warnings.join("\n");
  if (warningKey && warningKey !== lastPluginWarning) {
    showToast(catalog.warnings[0] ?? "A compatibility plugin needs attention.");
  }
  lastPluginWarning = warningKey;
  renderSettings();
  renderPaletteResults();
}

function runtimePluginWarnings(snapshot: RuntimeSnapshot | null = currentSnapshot): string[] {
  return (snapshot?.plugins ?? [])
    .filter((plugin) => plugin.error)
    .map((plugin) => `${plugin.name}: ${plugin.error}`);
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
    pluginMessage = error instanceof Error ? error.message : String(error);
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
    return true;
  } catch (error) {
    if (request === pluginRequest) {
      pluginMessage = error instanceof Error ? error.message : String(error);
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

async function reloadPlugins(): Promise<void> {
  await updatePlugins(
    (vaultId) => window.threadleaf.reloadPlugins(vaultId),
    "Reloading enabled community plugins…",
    "Enabled community plugins reloaded.",
  );
}

function renderPluginSettings(): void {
  const vaultId = currentSnapshot?.vault.id ?? null;
  const catalog = pluginCatalog?.vaultId === vaultId ? pluginCatalog : null;
  const preference = currentPluginPreference();
  const safeMode = catalog?.safeMode ?? false;
  const restricted = preference.compatibilityMode === "restricted";
  const disabled = pluginBusy || !vaultId;
  const installed = catalog?.plugins ?? [];

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

  const query = elements.pluginSearch.value.trim().toLocaleLowerCase("en-US");
  const visiblePlugins = installed.filter((plugin) =>
    [plugin.name, plugin.id, plugin.description ?? "", plugin.author ?? ""]
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
    const author = document.createElement("small");
    author.className = "plugin-author";
    author.textContent = plugin.author ? `By ${plugin.author}` : plugin.id;
    copy.append(nameLine, description, author);

    const controls = document.createElement("span");
    controls.className = "plugin-row-controls";
    const selected = preference.enabledPluginIds.includes(plugin.id);
    const runtimePlugin = (currentSnapshot?.plugins ?? []).find(
      (candidate) => candidate.id === plugin.id,
    );
    const runtimeState = document.createElement("span");
    runtimeState.className = "plugin-runtime-state";
    runtimeState.textContent =
      plugin.packageState === "invalid"
        ? "Invalid package"
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

    const toggle = document.createElement("label");
    toggle.className = "plugin-toggle";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.role = "switch";
    checkbox.checked = selected;
    checkbox.disabled = disabled || safeMode || restricted || plugin.packageState === "invalid";
    checkbox.ariaLabel = `${selected ? "Disable" : "Enable"} ${plugin.name}`;
    checkbox.addEventListener("change", () => {
      void setPluginEnabled(plugin.id, checkbox.checked);
    });
    const track = document.createElement("span");
    track.className = "plugin-toggle-track";
    track.ariaHidden = "true";
    const toggleLabel = document.createElement("span");
    toggleLabel.className = "plugin-toggle-label";
    toggleLabel.textContent = selected ? "Enabled" : "Disabled";
    toggle.append(checkbox, track, toggleLabel);
    controls.append(runtimeState, toggle);
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
    setDocumentView("source", false);
  }
  settingsRestoreFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  recordingShortcut = null;
  settingsMessage = "Select a command, then press its new shortcut.";
  settingsMessageKind = "info";
  elements.settingsDialog.showModal();
  renderSettings();
  elements.settingsClose.focus();
  if (!appearanceSnapshot || appearanceSnapshot.vaultId !== currentSnapshot?.vault.id) {
    void refreshAppearance();
  }
  if (!pluginCatalog || pluginCatalog.vaultId !== currentSnapshot?.vault.id) {
    void refreshPlugins();
  }
}

function closeSettings(restoreFocus = true): void {
  if (!elements.settingsDialog.open || settingsOperationBusy()) {
    return;
  }
  recordingShortcut = null;
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
  renderSettings();
  if (focusNavigation) {
    const target =
      page === "appearance"
        ? elements.settingsNavAppearance
        : page === "plugins"
          ? elements.settingsNavPlugins
          : elements.settingsNavHotkeys;
    target.focus();
  }
}

function renderSettingsNavigation(): void {
  const pageDetails: Record<SettingsPage, { eyebrow: string; title: string }> = {
    appearance: { eyebrow: "Options", title: "Appearance" },
    plugins: { eyebrow: "Trusted runtime", title: "Community plugins" },
    hotkeys: { eyebrow: "Keyboard", title: "Hotkeys" },
  };
  elements.settingsPageEyebrow.textContent = pageDetails[settingsPage].eyebrow;
  elements.settingsPageTitle.textContent = pageDetails[settingsPage].title;
  for (const [page, button] of [
    ["appearance", elements.settingsNavAppearance],
    ["plugins", elements.settingsNavPlugins],
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
      : settingsPage === "plugins"
        ? [pluginMessage, pluginMessageKind]
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
  renderPluginSettings();
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

function render(snapshot: RuntimeSnapshot): void {
  const previousVaultId = currentSnapshot?.vault.id ?? null;
  currentSnapshot = snapshot;
  if (previousVaultId !== snapshot.vault.id) {
    pluginSurfaceRequest += 1;
    pluginLayoutReadyVaultId = null;
    if (documentViewMode === "plugin") {
      documentViewMode = "source";
    }
    appearanceRequest += 1;
    appearanceBusy = false;
    appearanceSnapshot = null;
    appearanceStyle.textContent = "";
    lastAppearanceWarning = "";
    pluginRequest += 1;
    pluginBusy = false;
    pluginCatalog = null;
    pluginStyle.textContent = "";
    lastPluginWarning = "";
    lastPluginEditorUpdateId = null;
    applyColorScheme(currentAppearancePreference().colorScheme);
    void refreshAppearance();
    void refreshPlugins();
    void maybeMigrateLegacyTheme();
  }
  const workspace = snapshot.workspace;
  const plugin = snapshot.plugin;
  elements.vaultName.textContent = snapshot.vault.name;
  elements.vaultIdentity.title = snapshot.vault.path;
  elements.vaultMode.title = snapshot.vault.path;
  elements.vaultSource.textContent =
    snapshot.vault.source === "bundled"
      ? "Bundled vault"
      : snapshot.vault.source === "environment"
        ? "Development vault"
        : snapshot.vault.source === "restored"
          ? "Restored vault"
          : "Local vault";
  elements.fileCount.textContent = String(
    workspace?.files.length ?? snapshot.vault.markdownFileCount,
  );
  const needsAttention = workspace?.state === "degraded" || snapshot.vault.warning !== null;
  elements.runtimeState.textContent = needsAttention ? "Needs attention" : "Ready";
  elements.statusShape.dataset.state = needsAttention ? "degraded" : "ready";
  elements.indexStatus.textContent = workspace ? "Current" : "Unavailable";
  elements.recoveryCount.textContent = String(workspace?.recoveryActionCount ?? 0);
  elements.watchSequence.textContent = String(workspace?.watcher.lastSequence ?? 0);
  elements.watchMessage.textContent = snapshot.vault.warning
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

  const displayedNote = reconcileEditor(workspace?.activeNote ?? null, snapshot.vault.id);
  applyPluginEditorUpdate(snapshot.editorUpdate);
  if (
    documentViewMode === "plugin" &&
    !snapshot.pluginSurface &&
    !preferredPluginViewType(snapshot)
  ) {
    setDocumentView("source", false);
  }
  reconcileVaultSearch(snapshot);
  renderFiles(workspace?.files ?? [], displayedNote?.path ?? null);
  renderNote(displayedNote);

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
  if (elements.newNoteDialog.open) {
    renderNewNoteDialog();
  }
  if (elements.moveNoteDialog.open) {
    renderMoveNoteDialog();
  }
  if (elements.deleteNoteDialog.open) {
    renderDeleteNoteDialog();
  }
}

function renderTabs(tabs: WorkspaceTabSummary[], displayedPath: string | null): void {
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
  for (const tab of tabs) {
    const isActive = tab.path === displayedPath;
    const wrapper = document.createElement("div");
    wrapper.className = "note-tab workspace-tab-header";
    wrapper.dataset.active = String(isActive);

    const activate = document.createElement("button");
    activate.type = "button";
    activate.className = "note-tab-activate";
    activate.setAttribute("role", "tab");
    activate.setAttribute("aria-selected", String(isActive));
    activate.setAttribute("aria-controls", "note-view");
    activate.tabIndex = isActive || (!displayedPath && tab.path === runtimeActivePath) ? 0 : -1;
    activate.title = tab.path;
    activate.ariaLabel = `${isActive ? "Current note" : "Open note"}: ${tab.path}`;

    const mark = document.createElement("span");
    mark.className = "note-tab-mark";
    mark.ariaHidden = "true";
    mark.textContent = "◇";
    const title = document.createElement("span");
    title.className = "note-tab-title";
    title.textContent = tab.title;
    activate.append(mark, title);
    if (isActive) {
      activeTab = wrapper;
    }
    activate.addEventListener("click", () => void openNote(tab.path));
    activate.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
        return;
      }
      event.preventDefault();
      void cycleTab(event.key === "ArrowRight" ? 1 : -1);
    });

    const close = document.createElement("button");
    close.type = "button";
    close.className = "note-tab-close";
    close.ariaLabel = `Close ${tab.path}`;
    close.textContent = "×";
    close.disabled = busy || saving || (isActive && dirty);
    close.title =
      isActive && dirty ? "Save or revert this note before closing it" : `Close ${tab.path}`;
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      void closeTab(tab.path);
    });

    wrapper.append(activate, close);
    elements.noteTabs.append(wrapper);
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
  elements.fileList.replaceChildren();
  elements.fileList.setAttribute(
    "aria-busy",
    String(query !== "" && vaultSearchState.status === "loading"),
  );
  elements.fileList.setAttribute("aria-label", query ? "Vault search results" : "Markdown files");

  if (query) {
    renderVaultSearchResults(activePath, files.length);
    return;
  }

  elements.filterSummary.textContent = `${files.length} ${files.length === 1 ? "note" : "notes"} indexed`;
  for (const file of files) {
    const button = createFileButton(file.path, file.title, activePath, "◇");
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
    elements.fileList.append(button);
  }

  if (files.length === 0) {
    renderEmpty(elements.fileList, "No Markdown notes found.");
  }
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

function searchContextLabel(result: VaultSearchResult): string {
  const context = result.contexts[0];
  if (!context) {
    return "Match";
  }
  if (context.kind === "content") {
    return context.line ? `Line ${context.line}` : "Text";
  }
  if (context.kind === "heading") {
    return context.line ? `Heading ${context.line}` : "Heading";
  }
  return `${context.kind[0]?.toLocaleUpperCase("en-US") ?? ""}${context.kind.slice(1)}`;
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
      contextKind.textContent = searchContextLabel(result);
      const contextText = document.createElement("span");
      contextText.textContent = context.text;
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

function renderNote(note: WorkspaceNoteSnapshot | null): void {
  elements.noteEmpty.hidden = note !== null;
  elements.noteView.hidden = note === null;
  if (!note) {
    elements.notePath.textContent = "No note selected";
    elements.noteTags.replaceChildren();
    elements.linkCount.textContent = "0";
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
    return incomingNote;
  }

  const currentText = editor.state.doc.toString();
  if (saving && currentText === incomingNote.content) {
    replaceEditorDocument(incomingNote, incomingVaultId);
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

  replaceEditorDocument(incomingNote, incomingVaultId);
  return incomingNote;
}

function replaceEditorDocument(note: WorkspaceNoteSnapshot | null, vaultId: string | null): void {
  const content = note?.content ?? "";
  syncingEditor = true;
  try {
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: content },
      selection: { anchor: 0 },
    });
  } finally {
    syncingEditor = false;
  }
  loadedNote = note;
  loadedVaultId = note ? vaultId : null;
  previewImageRequest += 1;
  renderedPreviewPath = null;
  renderedPreviewSource = null;
  renderedPreviewVaultId = null;
  renderedPreviewWatchSequence = -1;
  elements.notePreview.replaceChildren();
  pendingDiskNote = null;
  diskChanged = false;
  dirty = false;
  clearEditNotice();
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
  } else if (dirty && diskChanged) {
    state = "conflict";
    label = "Unsaved, disk changed";
  } else if (dirty) {
    state = "dirty";
    label = "Unsaved";
  } else if (loadedNote) {
    state = "saved";
    label = "Saved";
  }
  elements.editState.dataset.state = state;
  elements.editState.textContent = label;
  elements.newNote.disabled = busy || saving || dirty;
  elements.moveNote.disabled = busy || saving || dirty || !loadedNote || !loadedVaultId;
  elements.deleteNote.disabled = busy || saving || dirty || !loadedNote || !loadedVaultId;
  elements.saveNote.disabled = busy || saving || !dirty || !loadedNote || !loadedVaultId;
  elements.revertNote.disabled = busy || saving || !dirty || !loadedNote;
  renderTabs(currentSnapshot?.workspace?.tabs ?? [], loadedNote?.path ?? null);
  renderEditNotice();
  renderDocumentView();
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

async function closeTab(filePath: string): Promise<void> {
  if (busy || saving) {
    return;
  }
  if (loadedNote?.path === filePath && dirty) {
    showToast("Save or revert the current note before closing its tab.");
    setDocumentView("source");
    editor.focus();
    return;
  }
  const expectedVaultId = currentSnapshot?.vault.id;
  if (!expectedVaultId) {
    return;
  }
  await runAction(() => window.threadleaf.closeNote(filePath, expectedVaultId));
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

function closeActiveTab(): Promise<void> {
  return loadedNote ? closeTab(loadedNote.path) : Promise.resolve();
}

async function cycleTab(direction: -1 | 1): Promise<void> {
  const tabs = currentSnapshot?.workspace?.tabs ?? [];
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
    await openNote(nextTab.path);
  }
}

async function openNote(filePath: string, line?: number): Promise<boolean> {
  if (busy) {
    return false;
  }
  if (dirty || saving) {
    showToast("Save or revert the open note before navigating away.");
    setDocumentView("source");
    editor.focus();
    return false;
  }
  await runAction(() => window.threadleaf.openNote(filePath));
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
  return loadedNote?.path === filePath;
}

async function chooseVault(): Promise<void> {
  if (busy) {
    return;
  }
  if (dirty || saving) {
    showToast("Save or revert the open note before switching vaults.");
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
  const content = editor.state.doc.toString();
  saving = true;
  renderEditControls();
  setActionState(busy);
  try {
    const response = await window.threadleaf.saveNote(
      path,
      content,
      expectedRevision,
      expectedVaultId,
    );
    render(response.snapshot);
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
    showToast(error instanceof Error ? error.message : String(error));
  } finally {
    saving = false;
    setActionState(busy);
  }
}

function revertActiveNote(): void {
  if (!dirty || saving || busy) {
    return;
  }
  const diskNote = diskChanged
    ? (pendingDiskNote ?? currentSnapshot?.workspace?.activeNote ?? null)
    : loadedNote;
  replaceEditorDocument(
    diskNote,
    diskChanged ? (currentSnapshot?.vault.id ?? null) : loadedVaultId,
  );
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
    showToast(error instanceof Error ? error.message : String(error));
  } finally {
    setActionState(false);
  }
}

function setActionState(nextBusy: boolean): void {
  busy = nextBusy;
  elements.openVault.disabled = busy || saving;
  elements.newNote.disabled = busy || saving || dirty;
  elements.reloadPlugin.disabled =
    busy ||
    saving ||
    pluginBusy ||
    pluginSafeModeActive() ||
    currentPluginPreference().compatibilityMode === "restricted" ||
    currentPluginPreference().enabledPluginIds.length === 0;
  elements.unloadPlugin.disabled =
    busy ||
    saving ||
    pluginBusy ||
    pluginSafeModeActive() ||
    currentPluginPreference().compatibilityMode === "restricted";
  elements.runCommand.disabled = busy || saving || (currentSnapshot?.commands.length ?? 0) === 0;
  renderEditControls();
}

elements.fileSearch.addEventListener("input", () => {
  scheduleVaultSearch();
});

elements.editView.addEventListener("click", () => setDocumentView("source"));
elements.readView.addEventListener("click", () => setDocumentView("reading"));
elements.pluginView.addEventListener("click", () => void activatePluginView());
elements.notePreview.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) {
    return;
  }
  const sourceAction = event.target.closest<HTMLButtonElement>(".preview-source-action");
  if (sourceAction) {
    const line = Number.parseInt(sourceAction.dataset.sourceLine ?? "", 10);
    if (Number.isSafeInteger(line) && line > 0) {
      setDocumentView("source", false);
      window.requestAnimationFrame(() => scrollToSourceLine(line));
    }
    return;
  }
  const anchor = event.target.closest<HTMLAnchorElement>("a[data-threadleaf-link]");
  if (anchor) {
    event.preventDefault();
    void activatePreviewLink(anchor);
  }
});

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
elements.moveNote.addEventListener(
  "click",
  () => void executeRendererCommand("workspace.move-note"),
);
elements.deleteNote.addEventListener(
  "click",
  () => void executeRendererCommand("workspace.delete-note"),
);
elements.saveNote.addEventListener("click", () => void executeRendererCommand("editor.save-note"));
elements.revertNote.addEventListener(
  "click",
  () => void executeRendererCommand("editor.revert-note"),
);
elements.dismissEditNotice.addEventListener("click", clearEditNotice);

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

elements.settingsClose.addEventListener("click", () => closeSettings());
elements.settingsDone.addEventListener("click", () => closeSettings());
elements.settingsReset.addEventListener("click", () => void resetKeyBindings());
elements.settingsNavAppearance.addEventListener("click", () => setSettingsPage("appearance"));
elements.settingsNavPlugins.addEventListener("click", () => setSettingsPage("plugins"));
elements.settingsNavHotkeys.addEventListener("click", () => setSettingsPage("hotkeys"));
elements.pluginModeToggle.addEventListener("click", () => {
  void setCompatibilityMode(
    currentPluginPreference().compatibilityMode === "restricted" ? "enabled" : "restricted",
  );
});
elements.pluginReloadAll.addEventListener("click", () => void reloadPlugins());
elements.pluginSearch.addEventListener("input", renderPluginSettings);
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
      elements.newNoteDialog.open ||
      elements.moveNoteDialog.open ||
      elements.deleteNoteDialog.open
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
  if (targetId === "settings.open-keybindings") {
    if (
      elements.newNoteDialog.open ||
      elements.moveNoteDialog.open ||
      elements.deleteNoteDialog.open
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
    elements.newNoteDialog.open ||
    elements.moveNoteDialog.open ||
    elements.deleteNoteDialog.open
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

const storedDocumentView = localStorage.getItem("threadleaf-document-view");
documentViewMode = storedDocumentView === "reading" ? "reading" : "source";

applyColorScheme("system");
const handleSystemColorSchemeChange = (): void => {
  if (currentAppearancePreference().colorScheme === "system") {
    applyColorScheme("system");
    renderSettings();
  }
};
systemColorScheme.addEventListener("change", handleSystemColorSchemeChange);

const unsubscribe = window.threadleaf.onSnapshot(render);
const unsubscribeSettings = window.threadleaf.onSettings(applySettingsSnapshot);
const pluginSurfaceResizeObserver = new ResizeObserver(() => {
  if (documentViewMode === "plugin") {
    void updatePluginSurfaceBounds();
  }
});
pluginSurfaceResizeObserver.observe(elements.pluginSurfaceHost);
window.addEventListener("beforeunload", (event) => {
  if (dirty) {
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
    unsubscribe();
    unsubscribeSettings();
    systemColorScheme.removeEventListener("change", handleSystemColorSchemeChange);
    pluginSurfaceResizeObserver.disconnect();
    editor.destroy();
  },
  { once: true },
);
void window.threadleaf
  .getSnapshot()
  .then(render)
  .catch((error: unknown) => showToast(error instanceof Error ? error.message : String(error)));
void window.threadleaf
  .getSettings()
  .then(applySettingsSnapshot)
  .catch((error: unknown) => showToast(error instanceof Error ? error.message : String(error)));
