import {
  createDefaultVaultAppearance,
  parseVaultAppearanceSettings,
  type VaultAppearanceSettings,
} from "./appearance";
import {
  createDefaultVaultNoteWorkflowSettings,
  parseVaultNoteWorkflowSettings,
  type VaultNoteWorkflowSettings,
} from "./note-workflows";
import {
  createDefaultVaultPluginSettings,
  parseVaultPluginSettings,
  type VaultPluginSettings,
} from "./plugins";
import {
  createDefaultVaultWorkspaceSettings,
  parseVaultWorkspaceSettings,
  type VaultWorkspaceMode,
  type VaultWorkspaceSettings,
} from "./workspace-settings";

export const shortcutTargetIds = [
  "ui.command-palette",
  "settings.open-keybindings",
  "workspace.open-vault",
  "workspace.quick-switcher",
  "workspace.create-note",
  "workspace.open-daily-note",
  "workspace.open-file-recovery",
  "workspace.export-note-html",
  "workspace.toggle-note-bookmark",
  "workspace.toggle-tab-pin",
  "workspace.open-graph-view",
  "workspace.open-local-graph",
  "workspace.move-note",
  "workspace.delete-note",
  "workspace.close-tab",
  "workspace.next-tab",
  "workspace.previous-tab",
  "workspace.go-back",
  "workspace.go-forward",
  "workspace.focus-note-filter",
  "editor.toggle-reading-view",
  "editor.toggle-source-mode",
  "editor.insert-template",
  "editor.insert-current-date",
  "editor.insert-current-time",
  "appearance.toggle-theme",
  "appearance.reload-custom-css",
  "appearance.disable-custom-css",
] as const;

export type ShortcutTargetId = (typeof shortcutTargetIds)[number];

export interface AppSettings {
  version: 5;
  keyBindings: Record<string, string | null>;
  appearanceByVault: Record<string, VaultAppearanceSettings>;
  pluginsByVault: Record<string, VaultPluginSettings>;
  noteWorkflowsByVault: Record<string, VaultNoteWorkflowSettings>;
  workspaceByVault: Record<string, VaultWorkspaceSettings>;
}

export interface AppSettingsSnapshot {
  settings: AppSettings;
  warning: string | null;
}

export interface KeyboardBindingEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export const defaultKeyBindings: Readonly<Record<ShortcutTargetId, string | null>> = {
  "ui.command-palette": "Mod+K",
  "settings.open-keybindings": "Mod+Comma",
  "workspace.open-vault": "Mod+O",
  "workspace.quick-switcher": "Mod+Shift+O",
  "workspace.create-note": "Mod+N",
  "workspace.open-daily-note": null,
  "workspace.open-file-recovery": null,
  "workspace.export-note-html": null,
  "workspace.toggle-note-bookmark": null,
  "workspace.toggle-tab-pin": null,
  "workspace.open-graph-view": null,
  "workspace.open-local-graph": null,
  "workspace.move-note": "Mod+Shift+M",
  "workspace.delete-note": null,
  "workspace.close-tab": "Mod+W",
  "workspace.next-tab": "Alt+ArrowRight",
  "workspace.previous-tab": "Alt+ArrowLeft",
  "workspace.go-back": "Mod+BracketLeft",
  "workspace.go-forward": "Mod+BracketRight",
  "workspace.focus-note-filter": "Mod+P",
  "editor.toggle-reading-view": "Mod+E",
  "editor.toggle-source-mode": null,
  "editor.insert-template": null,
  "editor.insert-current-date": null,
  "editor.insert-current-time": null,
  "appearance.toggle-theme": "Mod+Shift+L",
  "appearance.reload-custom-css": null,
  "appearance.disable-custom-css": "Mod+Alt+L",
};

const modifierOrder = ["Mod", "Alt", "Shift"] as const;
const namedKeys = new Set([
  "Comma",
  "Period",
  "Slash",
  "Semicolon",
  "Quote",
  "BracketLeft",
  "BracketRight",
  "Minus",
  "Equal",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Tab",
]);

const eventKeyNames: Readonly<Record<string, string>> = {
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  ";": "Semicolon",
  "'": "Quote",
  "[": "BracketLeft",
  "]": "BracketRight",
  "-": "Minus",
  "=": "Equal",
};

const displayKeyNames: Readonly<Record<string, string>> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const vaultIdPattern = /^[a-f0-9]{64}$/;

function parseAppearanceByVault(value: unknown): Record<string, VaultAppearanceSettings> {
  if (!isRecord(value)) {
    throw new Error("Settings appearanceByVault must be an object.");
  }
  const entries = Object.entries(value);
  if (entries.length > 128) {
    throw new Error("Settings contain appearance preferences for too many vaults.");
  }
  const appearanceByVault: Record<string, VaultAppearanceSettings> = {};
  for (const [vaultId, appearance] of entries) {
    if (!vaultIdPattern.test(vaultId)) {
      throw new Error("Appearance preferences require lowercase SHA-256 vault identities.");
    }
    appearanceByVault[vaultId] = parseVaultAppearanceSettings(appearance);
  }
  return appearanceByVault;
}

function parsePluginsByVault(value: unknown): Record<string, VaultPluginSettings> {
  if (!isRecord(value)) {
    throw new Error("Settings pluginsByVault must be an object.");
  }
  const entries = Object.entries(value);
  if (entries.length > 128) {
    throw new Error("Settings contain plugin preferences for too many vaults.");
  }
  const pluginsByVault: Record<string, VaultPluginSettings> = {};
  for (const [vaultId, plugins] of entries) {
    if (!vaultIdPattern.test(vaultId)) {
      throw new Error("Plugin preferences require lowercase SHA-256 vault identities.");
    }
    pluginsByVault[vaultId] = parseVaultPluginSettings(plugins);
  }
  return pluginsByVault;
}

function parseNoteWorkflowsByVault(value: unknown): Record<string, VaultNoteWorkflowSettings> {
  if (!isRecord(value)) {
    throw new Error("Settings noteWorkflowsByVault must be an object.");
  }
  const entries = Object.entries(value);
  if (entries.length > 128) {
    throw new Error("Settings contain note workflow preferences for too many vaults.");
  }
  const noteWorkflowsByVault: Record<string, VaultNoteWorkflowSettings> = {};
  for (const [vaultId, noteWorkflows] of entries) {
    if (!vaultIdPattern.test(vaultId)) {
      throw new Error("Note workflow preferences require lowercase SHA-256 vault identities.");
    }
    noteWorkflowsByVault[vaultId] = parseVaultNoteWorkflowSettings(noteWorkflows);
  }
  return noteWorkflowsByVault;
}

function parseWorkspaceByVault(value: unknown): Record<string, VaultWorkspaceSettings> {
  if (!isRecord(value)) {
    throw new Error("Settings workspaceByVault must be an object.");
  }
  const entries = Object.entries(value);
  if (entries.length > 128) {
    throw new Error("Settings contain workspace preferences for too many vaults.");
  }
  const workspaceByVault: Record<string, VaultWorkspaceSettings> = {};
  for (const [vaultId, workspace] of entries) {
    if (!vaultIdPattern.test(vaultId)) {
      throw new Error("Workspace preferences require lowercase SHA-256 vault identities.");
    }
    workspaceByVault[vaultId] = parseVaultWorkspaceSettings(workspace);
  }
  return workspaceByVault;
}

function normalizeKey(value: string): string {
  const trimmed = eventKeyNames[value.trim()] ?? value.trim();
  if (/^[a-z0-9]$/i.test(trimmed)) {
    return trimmed.toLocaleUpperCase("en-US");
  }
  if (/^f(?:[1-9]|1[0-2])$/i.test(trimmed)) {
    return trimmed.toLocaleUpperCase("en-US");
  }
  const named = [...namedKeys].find(
    (candidate) => candidate.toLocaleLowerCase("en-US") === trimmed.toLocaleLowerCase("en-US"),
  );
  if (named) {
    return named;
  }
  throw new Error(`Unsupported shortcut key: ${value}`);
}

export function normalizeKeyBinding(value: string): string {
  const tokens = value
    .split("+")
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length < 2) {
    throw new Error("A shortcut needs a modifier and a key.");
  }
  const key = normalizeKey(tokens.at(-1) ?? "");
  const modifiers = new Set<string>();
  for (const token of tokens.slice(0, -1)) {
    const normalized = modifierOrder.find(
      (candidate) => candidate.toLocaleLowerCase("en-US") === token.toLocaleLowerCase("en-US"),
    );
    if (!normalized) {
      throw new Error(`Unsupported shortcut modifier: ${token}`);
    }
    if (modifiers.has(normalized)) {
      throw new Error(`Shortcut modifier is repeated: ${normalized}`);
    }
    modifiers.add(normalized);
  }
  if (!modifiers.has("Mod") && !modifiers.has("Alt")) {
    throw new Error("A shortcut must include Mod or Alt.");
  }
  return [...modifierOrder.filter((modifier) => modifiers.has(modifier)), key].join("+");
}

export function createDefaultAppSettings(): AppSettings {
  return {
    version: 5,
    keyBindings: { ...defaultKeyBindings },
    appearanceByVault: {},
    pluginsByVault: {},
    noteWorkflowsByVault: {},
    workspaceByVault: {},
  };
}

export function parseAppSettings(value: unknown): AppSettings {
  if (
    !isRecord(value) ||
    (value.version !== 1 &&
      value.version !== 2 &&
      value.version !== 3 &&
      value.version !== 4 &&
      value.version !== 5) ||
    !isRecord(value.keyBindings)
  ) {
    throw new Error("Settings must contain version 1, 2, 3, 4, or 5 and a keyBindings object.");
  }
  const entries = Object.entries(value.keyBindings);
  if (entries.length > 512) {
    throw new Error("Settings contain too many key bindings.");
  }
  const keyBindings: Record<string, string | null> = { ...defaultKeyBindings };
  for (const [targetId, binding] of entries) {
    if (targetId === "editor.save-note" || targetId === "editor.revert-note") {
      continue;
    }
    if (!/^[a-z0-9][a-z0-9._:-]{0,199}$/i.test(targetId)) {
      throw new Error(`Invalid shortcut target: ${targetId}`);
    }
    if (binding !== null && typeof binding !== "string") {
      throw new Error(`Shortcut for ${targetId} must be a string or null.`);
    }
    keyBindings[targetId] = binding === null ? null : normalizeKeyBinding(binding);
  }
  assertNoKeyBindingCollisions(keyBindings);
  const appearanceByVault =
    value.version === 1 ? {} : parseAppearanceByVault(value.appearanceByVault);
  const pluginsByVault =
    value.version === 3 || value.version === 4 || value.version === 5
      ? parsePluginsByVault(value.pluginsByVault)
      : {};
  const noteWorkflowsByVault =
    value.version === 5 ? parseNoteWorkflowsByVault(value.noteWorkflowsByVault) : {};
  const workspaceByVault =
    value.version === 5 && value.workspaceByVault !== undefined
      ? parseWorkspaceByVault(value.workspaceByVault)
      : {};
  return {
    version: 5,
    keyBindings,
    appearanceByVault,
    pluginsByVault,
    noteWorkflowsByVault,
    workspaceByVault,
  };
}

export function isShortcutTargetId(value: string): value is ShortcutTargetId {
  return shortcutTargetIds.includes(value as ShortcutTargetId);
}

export function updateKeyBinding(
  settings: AppSettings,
  targetId: ShortcutTargetId,
  binding: string | null,
): AppSettings {
  const keyBindings = {
    ...settings.keyBindings,
    [targetId]: binding === null ? null : normalizeKeyBinding(binding),
  };
  assertNoKeyBindingCollisions(keyBindings);
  return { ...settings, keyBindings };
}

export function appearanceForVault(
  settings: AppSettings,
  vaultId: string,
): VaultAppearanceSettings {
  const appearance = settings.appearanceByVault[vaultId];
  return appearance
    ? {
        colorScheme: appearance.colorScheme,
        themeId: appearance.themeId,
        enabledSnippetIds: [...appearance.enabledSnippetIds],
      }
    : createDefaultVaultAppearance();
}

export function updateVaultAppearance(
  settings: AppSettings,
  vaultId: string,
  appearance: VaultAppearanceSettings,
): AppSettings {
  if (!vaultIdPattern.test(vaultId)) {
    throw new Error("Appearance preferences require a lowercase SHA-256 vault identity.");
  }
  const normalized = parseVaultAppearanceSettings(appearance);
  return {
    ...settings,
    appearanceByVault: {
      ...settings.appearanceByVault,
      [vaultId]: normalized,
    },
  };
}

export function pluginsForVault(settings: AppSettings, vaultId: string): VaultPluginSettings {
  const plugins = settings.pluginsByVault[vaultId];
  return plugins
    ? {
        compatibilityMode: plugins.compatibilityMode,
        enabledPluginIds: [...plugins.enabledPluginIds],
        capabilityGrantsByPlugin: Object.fromEntries(
          Object.entries(plugins.capabilityGrantsByPlugin).map(([pluginId, grant]) => [
            pluginId,
            {
              bundleSha256: grant.bundleSha256,
              capabilities: [...grant.capabilities],
            },
          ]),
        ),
      }
    : createDefaultVaultPluginSettings();
}

export function updateVaultPlugins(
  settings: AppSettings,
  vaultId: string,
  plugins: VaultPluginSettings,
): AppSettings {
  if (!vaultIdPattern.test(vaultId)) {
    throw new Error("Plugin preferences require lowercase SHA-256 vault identities.");
  }
  const normalized = parseVaultPluginSettings(plugins);
  return {
    ...settings,
    pluginsByVault: {
      ...settings.pluginsByVault,
      [vaultId]: normalized,
    },
  };
}

export function noteWorkflowsForVault(
  settings: AppSettings,
  vaultId: string,
): VaultNoteWorkflowSettings {
  const noteWorkflows = settings.noteWorkflowsByVault[vaultId];
  return noteWorkflows
    ? {
        templateFolder: noteWorkflows.templateFolder,
        templateDateFormat: noteWorkflows.templateDateFormat,
        templateTimeFormat: noteWorkflows.templateTimeFormat,
        dailyNoteFolder: noteWorkflows.dailyNoteFolder,
        dailyNoteDateFormat: noteWorkflows.dailyNoteDateFormat,
        dailyNoteTemplate: noteWorkflows.dailyNoteTemplate,
      }
    : createDefaultVaultNoteWorkflowSettings();
}

export function workspaceSettingsForVault(
  settings: AppSettings,
  vaultId: string,
): VaultWorkspaceSettings {
  const workspace = settings.workspaceByVault[vaultId];
  return workspace
    ? {
        defaultNoteFolder: workspace.defaultNoteFolder,
        linkStyle: workspace.linkStyle,
        automaticLinkUpdates: workspace.automaticLinkUpdates,
        confirmDelete: workspace.confirmDelete,
        newTabBehavior: workspace.newTabBehavior,
        editorMode: workspace.editorMode,
        documentView: workspace.documentView,
        restorePolicy: workspace.restorePolicy,
      }
    : createDefaultVaultWorkspaceSettings();
}

export function updateVaultNoteWorkflows(
  settings: AppSettings,
  vaultId: string,
  noteWorkflows: VaultNoteWorkflowSettings,
): AppSettings {
  if (!vaultIdPattern.test(vaultId)) {
    throw new Error("Note workflow preferences require a lowercase SHA-256 vault identity.");
  }
  const normalized = parseVaultNoteWorkflowSettings(noteWorkflows);
  return {
    ...settings,
    noteWorkflowsByVault: {
      ...settings.noteWorkflowsByVault,
      [vaultId]: normalized,
    },
  };
}

export function updateVaultWorkspaceSettings(
  settings: AppSettings,
  vaultId: string,
  workspace: VaultWorkspaceSettings,
): AppSettings {
  if (!vaultIdPattern.test(vaultId)) {
    throw new Error("Workspace preferences require a lowercase SHA-256 vault identity.");
  }
  const normalized = parseVaultWorkspaceSettings(workspace);
  return {
    ...settings,
    workspaceByVault: {
      ...settings.workspaceByVault,
      [vaultId]: normalized,
    },
  };
}

export function updateVaultWorkspaceMode(
  settings: AppSettings,
  vaultId: string,
  mode: VaultWorkspaceMode,
): AppSettings {
  const workspace = workspaceSettingsForVault(settings, vaultId);
  return updateVaultWorkspaceSettings(settings, vaultId, {
    ...workspace,
    ...mode,
  });
}

export function assertNoKeyBindingCollisions(
  keyBindings: Readonly<Record<string, string | null>>,
): void {
  const assigned = new Map<string, string>();
  for (const [targetId, binding] of Object.entries(keyBindings)) {
    if (binding === null) {
      continue;
    }
    const normalized = normalizeKeyBinding(binding);
    const existing = assigned.get(normalized);
    if (existing) {
      throw new Error(`Shortcut ${normalized} is already assigned to ${existing}.`);
    }
    assigned.set(normalized, targetId);
  }
}

export function bindingFromKeyboardEvent(
  event: KeyboardBindingEvent,
  isMac: boolean,
): string | null {
  if (["Control", "Meta", "Alt", "Shift"].includes(event.key)) {
    return null;
  }
  const mappedKey = eventKeyNames[event.key] ?? event.key;
  let key: string;
  try {
    key = normalizeKey(mappedKey);
  } catch {
    return null;
  }
  const modifiers: string[] = [];
  const primaryPressed = isMac ? event.metaKey : event.ctrlKey;
  const otherPrimaryPressed = isMac ? event.ctrlKey : event.metaKey;
  if (otherPrimaryPressed) {
    return null;
  }
  if (primaryPressed) {
    modifiers.push("Mod");
  }
  if (event.altKey) {
    modifiers.push("Alt");
  }
  if (event.shiftKey) {
    modifiers.push("Shift");
  }
  if (!modifiers.includes("Mod") && !modifiers.includes("Alt")) {
    return null;
  }
  return normalizeKeyBinding([...modifiers, key].join("+"));
}

export function eventMatchesKeyBinding(
  event: KeyboardBindingEvent,
  binding: string | null,
  isMac: boolean,
): boolean {
  if (binding === null) {
    return false;
  }
  const tokens = normalizeKeyBinding(binding).split("+");
  const key = tokens.at(-1);
  const modifiers = new Set(tokens.slice(0, -1));
  const mappedKey = eventKeyNames[event.key] ?? event.key;
  let eventKey: string;
  try {
    eventKey = normalizeKey(mappedKey);
  } catch {
    return false;
  }
  const primaryPressed = isMac ? event.metaKey : event.ctrlKey;
  const otherPrimaryPressed = isMac ? event.ctrlKey : event.metaKey;
  return (
    eventKey === key &&
    primaryPressed === modifiers.has("Mod") &&
    !otherPrimaryPressed &&
    event.altKey === modifiers.has("Alt") &&
    event.shiftKey === modifiers.has("Shift")
  );
}

export function shortcutTargetForEvent(
  keyBindings: Readonly<Record<string, string | null>>,
  event: KeyboardBindingEvent,
  isMac: boolean,
): ShortcutTargetId | null {
  return (
    shortcutTargetIds.find((targetId) =>
      eventMatchesKeyBinding(event, keyBindings[targetId] ?? null, isMac),
    ) ?? null
  );
}

export function displayKeyBinding(binding: string | null, isMac: boolean): string {
  if (binding === null) {
    return "Unassigned";
  }
  return normalizeKeyBinding(binding)
    .split("+")
    .map((token) => {
      if (token === "Mod") {
        return isMac ? "⌘" : "Ctrl";
      }
      if (token === "Alt") {
        return isMac ? "⌥" : "Alt";
      }
      if (token === "Shift") {
        return isMac ? "⇧" : "Shift";
      }
      return displayKeyNames[token] ?? token;
    })
    .join(isMac ? "" : " ");
}
