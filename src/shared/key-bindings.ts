export const shortcutTargetIds = [
  "ui.command-palette",
  "settings.open-keybindings",
  "workspace.open-vault",
  "workspace.create-note",
  "workspace.focus-note-filter",
  "editor.save-note",
  "editor.revert-note",
  "editor.toggle-reading-view",
  "appearance.toggle-theme",
] as const;

export type ShortcutTargetId = (typeof shortcutTargetIds)[number];

export interface AppSettings {
  version: 1;
  keyBindings: Record<string, string | null>;
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
  "workspace.create-note": "Mod+N",
  "workspace.focus-note-filter": "Mod+P",
  "editor.save-note": "Mod+S",
  "editor.revert-note": null,
  "editor.toggle-reading-view": "Mod+E",
  "appearance.toggle-theme": "Mod+Shift+L",
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
  return { version: 1, keyBindings: { ...defaultKeyBindings } };
}

export function parseAppSettings(value: unknown): AppSettings {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.keyBindings)) {
    throw new Error("Settings must contain version 1 and a keyBindings object.");
  }
  const entries = Object.entries(value.keyBindings);
  if (entries.length > 512) {
    throw new Error("Settings contain too many key bindings.");
  }
  const keyBindings: Record<string, string | null> = { ...defaultKeyBindings };
  for (const [targetId, binding] of entries) {
    if (!/^[a-z0-9][a-z0-9._:-]{0,199}$/i.test(targetId)) {
      throw new Error(`Invalid shortcut target: ${targetId}`);
    }
    if (binding !== null && typeof binding !== "string") {
      throw new Error(`Shortcut for ${targetId} must be a string or null.`);
    }
    keyBindings[targetId] = binding === null ? null : normalizeKeyBinding(binding);
  }
  assertNoKeyBindingCollisions(keyBindings);
  return { version: 1, keyBindings };
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
  return { version: 1, keyBindings };
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
