import type { RuntimeSnapshot } from "../shared/contracts";
import "./styles.css";

const elements = {
  runtimeState: getElement("runtime-state"),
  vaultMode: getElement("vault-mode"),
  fileCount: getElement("file-count"),
  compatibilityLevel: getElement("compatibility-level"),
  commandCount: getElement("command-count"),
  pluginState: getElement("plugin-state"),
  pluginName: getElement("plugin-name"),
  pluginId: getElement("plugin-id"),
  pluginVersion: getElement("plugin-version"),
  pluginStylesheet: getElement("plugin-stylesheet"),
  commandList: getElement("command-list"),
  runCommand: getButton("run-command"),
  reloadPlugin: getButton("reload-plugin"),
  unloadPlugin: getButton("unload-plugin"),
  eventCount: getElement("event-count"),
  eventList: getElement("event-list"),
  themeToggle: getButton("theme-toggle"),
  toast: getElement("toast"),
};

let currentSnapshot: RuntimeSnapshot | null = null;
let toastTimer: number | undefined;

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

function render(snapshot: RuntimeSnapshot): void {
  currentSnapshot = snapshot;
  const plugin = snapshot.plugin;

  elements.runtimeState.textContent =
    plugin?.state === "loaded" ? "Plugin loaded" : "Runtime ready";
  elements.vaultMode.textContent = "Synthetic read-only";
  elements.fileCount.textContent = String(snapshot.vault.markdownFileCount);
  elements.compatibilityLevel.textContent = `Level ${plugin?.compatibilityLevel ?? 0}`;
  elements.commandCount.textContent = String(snapshot.commands.length);
  elements.pluginState.textContent = plugin?.state ?? "empty";
  elements.pluginState.dataset.state = plugin?.state ?? "empty";
  elements.pluginName.textContent = plugin?.name ?? "Not loaded";
  elements.pluginId.textContent = plugin?.id ?? "none";
  elements.pluginVersion.textContent = plugin?.version ?? "none";
  elements.pluginStylesheet.textContent = plugin?.stylesheetDiscovered
    ? "Discovered"
    : "Not discovered";

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
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No commands are registered.";
    elements.commandList.append(empty);
  }

  elements.runCommand.disabled = snapshot.commands.length === 0;
  elements.unloadPlugin.disabled = plugin?.state !== "loaded";
  elements.eventCount.textContent = `${snapshot.events.length} ${snapshot.events.length === 1 ? "event" : "events"}`;
  elements.eventList.replaceChildren();

  for (const event of [...snapshot.events].reverse()) {
    const item = document.createElement("li");
    item.dataset.kind = event.kind;
    const index = document.createElement("span");
    index.className = "event-index";
    index.textContent = String(event.sequence).padStart(2, "0");
    const body = document.createElement("span");
    body.className = "event-body";
    const kind = document.createElement("small");
    kind.textContent = event.kind;
    const message = document.createElement("span");
    message.textContent = event.message;
    body.append(kind, message);
    item.append(index, body);
    elements.eventList.append(item);
  }
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
    const snapshot = await action();
    render(snapshot);
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  } finally {
    setActionState(false);
  }
}

function setActionState(busy: boolean): void {
  elements.reloadPlugin.disabled = busy;
  elements.unloadPlugin.disabled = busy || currentSnapshot?.plugin?.state !== "loaded";
  elements.runCommand.disabled = busy || (currentSnapshot?.commands.length ?? 0) === 0;
}

function setTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("threadleaf-theme", theme);
  elements.themeToggle.textContent = theme === "light" ? "Switch to dark" : "Switch to light";
}

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

const storedTheme = localStorage.getItem("threadleaf-theme");
const initialTheme =
  storedTheme === "light" || storedTheme === "dark"
    ? storedTheme
    : window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
setTheme(initialTheme);

void window.threadleaf
  .getSnapshot()
  .then(render)
  .catch((error: unknown) => showToast(error instanceof Error ? error.message : String(error)));
