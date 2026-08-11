import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { basicSetup, EditorView } from "codemirror";
import type {
  RuntimeSnapshot,
  WorkspaceFileSummary,
  WorkspaceLinkSummary,
  WorkspaceNoteSnapshot,
} from "../shared/contracts";
import {
  filterPaletteCommands,
  firstEnabledPaletteIndex,
  movePaletteSelection,
  type PaletteCommandDescriptor,
} from "./command-palette-model";
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
  fileSearch: getInput("file-search"),
  searchShortcut: getElement("search-shortcut"),
  filterSummary: getElement("filter-summary"),
  fileList: getElement("file-list"),
  indexStatus: getElement("index-status"),
  recoveryCount: getElement("recovery-count"),
  notePath: getElement("note-path"),
  noteEmpty: getElement("note-empty"),
  noteView: getElement("note-view"),
  noteTitle: getElement("note-title"),
  noteStats: getElement("note-stats"),
  noteTags: getElement("note-tags"),
  noteEditor: getElement("note-editor"),
  editState: getElement("edit-state"),
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
  themeToggle: getButton("theme-toggle"),
  themeLabel: getElement("theme-label"),
  commandPalette: getDialog("command-palette"),
  paletteQuery: getInput("palette-query"),
  paletteClose: getButton("palette-close"),
  paletteCount: getElement("palette-count"),
  paletteResults: getElement("palette-results"),
  paletteHint: getElement("palette-hint"),
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
let paletteMatches: RendererCommand[] = [];
let paletteSelection = -1;
let paletteRestoreFocus: HTMLElement | null = null;

const editorStyleNonce = "threadleaf-codemirror";
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

function getDialog(id: string): HTMLDialogElement {
  const element = getElement(id);
  if (!(element instanceof HTMLDialogElement)) {
    throw new Error(`Expected a dialog: ${id}`);
  }
  return element;
}

function commandCatalog(): RendererCommand[] {
  const modifier = isMac ? "⌘" : "Ctrl";
  const plugin = currentSnapshot?.plugin ?? null;
  const commands: RendererCommand[] = [
    {
      id: "workspace.open-vault",
      label: "Open another vault",
      category: "Workspace",
      keywords: ["folder", "switch", "choose"],
      shortcut: `${modifier} O`,
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
      label: "Focus note filter",
      category: "Workspace",
      keywords: ["find", "files", "search", "quick switcher"],
      shortcut: `${modifier} P`,
      enabled: true,
      disabledReason: null,
      run: focusNoteFilter,
    },
    {
      id: "editor.save-note",
      label: "Save current note",
      category: "Editor",
      keywords: ["write", "commit"],
      shortcut: `${modifier} S`,
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
      shortcut: null,
      enabled: Boolean(loadedNote && dirty && !busy && !saving),
      disabledReason: !loadedNote
        ? "No note is open."
        : !dirty
          ? "The current note has no unsaved changes."
          : "Threadleaf is finishing another action.",
      run: revertActiveNote,
    },
    {
      id: "appearance.toggle-theme",
      label: `Switch to ${document.documentElement.dataset.theme === "dark" ? "light" : "dark"} theme`,
      category: "Appearance",
      keywords: ["color", "dark", "light"],
      shortcut: `${modifier} Shift L`,
      enabled: true,
      disabledReason: null,
      run: toggleTheme,
    },
  ];

  for (const command of currentSnapshot?.commands ?? []) {
    commands.push({
      id: `plugin.command.${command.id}`,
      label: command.name,
      category: plugin?.name ?? "Compatibility plugin",
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
      label: "Reload compatibility plugin",
      category: "Compatibility",
      keywords: ["refresh", "restart", "plugin"],
      shortcut: null,
      enabled: Boolean(plugin && !busy && !saving),
      disabledReason: plugin
        ? "Threadleaf is finishing another action."
        : "No compatibility plugin is loaded.",
      run: () => runAction(() => window.threadleaf.reloadPlugin()),
    },
    {
      id: "plugin.unload",
      label: "Unload compatibility plugin",
      category: "Compatibility",
      keywords: ["disable", "stop", "plugin"],
      shortcut: null,
      enabled: Boolean(plugin?.state === "loaded" && !busy && !saving),
      disabledReason:
        plugin?.state === "loaded"
          ? "Threadleaf is finishing another action."
          : "No loaded compatibility plugin is available.",
      run: () => runAction(() => window.threadleaf.unloadPlugin()),
    },
  );
  return commands;
}

function focusNoteFilter(): void {
  elements.fileSearch.focus();
  elements.fileSearch.select();
}

function toggleTheme(): void {
  setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
}

async function runCompatibilityCommand(commandId: string): Promise<void> {
  await runAction(async () => {
    const snapshot = await window.threadleaf.runCommand(commandId);
    showToast(snapshot.notices.at(-1) ?? "Command completed.");
    return snapshot;
  });
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
  const restoreTarget = paletteRestoreFocus;
  paletteRestoreFocus = null;
  if (restoreFocus && restoreTarget?.isConnected) {
    restoreTarget.focus();
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

function render(snapshot: RuntimeSnapshot): void {
  currentSnapshot = snapshot;
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
}

function renderFiles(files: WorkspaceFileSummary[], activePath: string | null): void {
  const query = elements.fileSearch.value.trim().toLocaleLowerCase("en-US");
  const visible = files.filter((file) => {
    const searchable = `${file.path} ${file.tags.join(" ")}`.toLocaleLowerCase("en-US");
    return query === "" || searchable.includes(query);
  });
  elements.filterSummary.textContent = query
    ? `${visible.length} of ${files.length} notes match`
    : `${files.length} ${files.length === 1 ? "note" : "notes"} indexed`;
  elements.fileList.replaceChildren();

  for (const file of visible) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "file-item";
    button.dataset.notePath = file.path;
    button.ariaLabel = `Open ${file.path}`;
    if (file.path === activePath) {
      button.setAttribute("aria-current", "page");
    }

    const glyph = document.createElement("span");
    glyph.className = "file-glyph";
    glyph.ariaHidden = "true";
    glyph.textContent = "◇";
    const copy = document.createElement("span");
    copy.className = "file-copy";
    const title = document.createElement("strong");
    title.textContent = file.title;
    const location = document.createElement("small");
    const slash = file.path.lastIndexOf("/");
    location.textContent = slash === -1 ? "Vault root" : file.path.slice(0, slash);
    copy.append(title, location);
    const metrics = document.createElement("span");
    metrics.className = "file-metrics";
    metrics.textContent =
      file.unresolvedCount > 0
        ? `${file.unresolvedCount} unresolved`
        : `${file.backlinkCount} back · ${file.outgoingCount} out`;
    button.append(glyph, copy, metrics);
    button.addEventListener("click", () => void openNote(file.path));
    elements.fileList.append(button);
  }

  if (visible.length === 0) {
    renderEmpty(
      elements.fileList,
      query ? "No note matches this filter." : "No Markdown notes found.",
    );
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
    button.addEventListener("click", () => scrollToSourceLine(heading.line));
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
  elements.saveNote.disabled = busy || saving || !dirty || !loadedNote || !loadedVaultId;
  elements.revertNote.disabled = busy || saving || !dirty || !loadedNote;
  renderEditNotice();
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

async function openNote(filePath: string): Promise<void> {
  if (busy) {
    return;
  }
  if (dirty || saving) {
    showToast("Save or revert the open note before navigating away.");
    editor.focus();
    return;
  }
  await runAction(() => window.threadleaf.openNote(filePath));
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
  elements.reloadPlugin.disabled = busy || saving || !currentSnapshot?.plugin;
  elements.unloadPlugin.disabled = busy || saving || currentSnapshot?.plugin?.state !== "loaded";
  elements.runCommand.disabled = busy || saving || (currentSnapshot?.commands.length ?? 0) === 0;
  renderEditControls();
}

function setTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("threadleaf-theme", theme);
  const next = theme === "light" ? "dark" : "light";
  elements.themeLabel.textContent = next === "dark" ? "Dark" : "Light";
  elements.themeToggle.ariaLabel = `Switch to ${next} theme`;
  renderPaletteResults();
}

elements.fileSearch.addEventListener("input", () => {
  const workspace = currentSnapshot?.workspace;
  renderFiles(workspace?.files ?? [], loadedNote?.path ?? null);
});

elements.commandTrigger.addEventListener("click", openCommandPalette);
elements.themeToggle.addEventListener(
  "click",
  () => void executeRendererCommand("appearance.toggle-theme"),
);
elements.openVault.addEventListener(
  "click",
  () => void executeRendererCommand("workspace.open-vault"),
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

document.addEventListener("keydown", (event) => {
  const modifier = event.metaKey || event.ctrlKey;
  const key = event.key.toLocaleLowerCase("en-US");
  if (modifier && key === "k") {
    event.preventDefault();
    if (elements.commandPalette.open) {
      closeCommandPalette();
    } else {
      openCommandPalette();
    }
    return;
  }
  if (elements.commandPalette.open) {
    return;
  }
  if (modifier && key === "s") {
    event.preventDefault();
    void executeRendererCommand("editor.save-note");
  } else if (modifier && key === "o") {
    event.preventDefault();
    void executeRendererCommand("workspace.open-vault");
  } else if (modifier && key === "p") {
    event.preventDefault();
    void executeRendererCommand("workspace.focus-note-filter");
  } else if (modifier && event.shiftKey && key === "l") {
    event.preventDefault();
    void executeRendererCommand("appearance.toggle-theme");
  } else if (event.key === "Escape" && document.activeElement === elements.fileSearch) {
    elements.fileSearch.value = "";
    elements.fileSearch.dispatchEvent(new Event("input"));
  }
});

elements.searchShortcut.textContent = isMac ? "⌘P" : "Ctrl P";
elements.saveShortcut.textContent = isMac ? "⌘S" : "Ctrl S";
elements.commandShortcut.textContent = isMac ? "⌘K" : "Ctrl K";

const storedTheme = localStorage.getItem("threadleaf-theme");
const initialTheme =
  storedTheme === "light" || storedTheme === "dark"
    ? storedTheme
    : window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
setTheme(initialTheme);

const unsubscribe = window.threadleaf.onSnapshot(render);
window.addEventListener("beforeunload", (event) => {
  if (dirty) {
    event.preventDefault();
    event.returnValue = "";
  }
});
window.addEventListener(
  "unload",
  () => {
    unsubscribe();
    editor.destroy();
  },
  { once: true },
);
void window.threadleaf
  .getSnapshot()
  .then(render)
  .catch((error: unknown) => showToast(error instanceof Error ? error.message : String(error)));
