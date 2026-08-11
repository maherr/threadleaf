import type {
  RuntimeSnapshot,
  WorkspaceFileSummary,
  WorkspaceLinkSummary,
} from "../shared/contracts";
import "./styles.css";

const elements = {
  vaultName: getElement("vault-name"),
  runtimeState: getElement("runtime-state"),
  statusShape: getElement("status-shape"),
  fileCount: getElement("file-count"),
  fileSearch: getInput("file-search"),
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
  noteContent: getElement("note-content"),
  outlineList: getElement("outline-list"),
  linkCount: getElement("link-count"),
  outgoingList: getElement("outgoing-list"),
  backlinkList: getElement("backlink-list"),
  pluginState: getElement("plugin-state"),
  pluginName: getElement("plugin-name"),
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
  themeToggle: getButton("theme-toggle"),
  themeLabel: getElement("theme-label"),
  toast: getElement("toast"),
};

let currentSnapshot: RuntimeSnapshot | null = null;
let toastTimer: number | undefined;
let busy = false;

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

function render(snapshot: RuntimeSnapshot): void {
  currentSnapshot = snapshot;
  const workspace = snapshot.workspace;
  const plugin = snapshot.plugin;
  elements.vaultName.textContent = snapshot.vault.name;
  elements.fileCount.textContent = String(
    workspace?.files.length ?? snapshot.vault.markdownFileCount,
  );
  elements.runtimeState.textContent = workspace?.state === "degraded" ? "Needs attention" : "Ready";
  elements.statusShape.dataset.state = workspace?.state ?? "ready";
  elements.indexStatus.textContent = workspace ? "Current" : "Unavailable";
  elements.recoveryCount.textContent = String(workspace?.recoveryActionCount ?? 0);
  elements.watchSequence.textContent = String(workspace?.watcher.lastSequence ?? 0);
  elements.watchMessage.textContent = workspace?.watcher.error
    ? `Watcher error: ${workspace.watcher.error}`
    : workspace?.watcher.lastRescanReason
      ? `Recovered by ${workspace.watcher.lastRescanReason} rescan`
      : "Filesystem and index agree";

  renderFiles(workspace?.files ?? [], workspace?.activeNote?.path ?? null);
  renderNote(snapshot);

  elements.pluginState.textContent = plugin?.state ?? "empty";
  elements.pluginState.dataset.state = plugin?.state ?? "empty";
  elements.pluginName.textContent = plugin?.name ?? "Not loaded";
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

function renderNote(snapshot: RuntimeSnapshot): void {
  const note = snapshot.workspace?.activeNote;
  elements.noteEmpty.hidden = note !== null && note !== undefined;
  elements.noteView.hidden = !note;
  if (!note) {
    elements.notePath.textContent = "No note selected";
    renderEmpty(elements.outlineList, "No outline yet.");
    renderEmpty(elements.outgoingList, "No outgoing links.");
    renderEmpty(elements.backlinkList, "No backlinks.");
    return;
  }

  elements.notePath.textContent = note.path;
  elements.noteTitle.textContent = note.title;
  elements.noteStats.textContent = `${note.headings.length} ${note.headings.length === 1 ? "heading" : "headings"} · ${note.outgoing.length} outgoing · ${note.backlinks.length} backlinks`;
  elements.noteContent.textContent = note.content;
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

function scrollToSourceLine(line: number): void {
  const lineHeight = Number.parseFloat(getComputedStyle(elements.noteContent).lineHeight) || 24;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  elements.noteContent.scrollTo({
    top: Math.max(0, line - 1) * lineHeight,
    behavior: reducedMotion ? "auto" : "smooth",
  });
  elements.noteContent.focus({ preventScroll: true });
}

async function openNote(filePath: string): Promise<void> {
  await runAction(() => window.threadleaf.openNote(filePath));
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
  elements.reloadPlugin.disabled = busy;
  elements.unloadPlugin.disabled = busy || currentSnapshot?.plugin?.state !== "loaded";
  elements.runCommand.disabled = busy || (currentSnapshot?.commands.length ?? 0) === 0;
}

function setTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("threadleaf-theme", theme);
  const next = theme === "light" ? "dark" : "light";
  elements.themeLabel.textContent = next === "dark" ? "Dark" : "Light";
  elements.themeToggle.ariaLabel = `Switch to ${next} theme`;
}

elements.fileSearch.addEventListener("input", () => {
  const workspace = currentSnapshot?.workspace;
  renderFiles(workspace?.files ?? [], workspace?.activeNote?.path ?? null);
});

elements.themeToggle.addEventListener("click", () => {
  setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});

elements.runCommand.addEventListener("click", () => {
  const command = currentSnapshot?.commands[0];
  if (!command) {
    return;
  }
  void runAction(async () => {
    const snapshot = await window.threadleaf.runCommand(command.id);
    showToast(snapshot.notices.at(-1) ?? "Command completed.");
    return snapshot;
  });
});

elements.reloadPlugin.addEventListener("click", () => {
  void runAction(() => window.threadleaf.reloadPlugin());
});

elements.unloadPlugin.addEventListener("click", () => {
  void runAction(() => window.threadleaf.unloadPlugin());
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase("en-US") === "p") {
    event.preventDefault();
    elements.fileSearch.focus();
    elements.fileSearch.select();
  } else if (event.key === "Escape" && document.activeElement === elements.fileSearch) {
    elements.fileSearch.value = "";
    elements.fileSearch.dispatchEvent(new Event("input"));
  }
});

const storedTheme = localStorage.getItem("threadleaf-theme");
const initialTheme =
  storedTheme === "light" || storedTheme === "dark"
    ? storedTheme
    : window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
setTheme(initialTheme);

const unsubscribe = window.threadleaf.onSnapshot(render);
window.addEventListener("beforeunload", unsubscribe, { once: true });
void window.threadleaf
  .getSnapshot()
  .then(render)
  .catch((error: unknown) => showToast(error instanceof Error ? error.message : String(error)));
