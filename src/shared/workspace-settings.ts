export const workspaceLinkStyles = ["preserve", "wikilink", "markdown"] as const;
export type WorkspaceLinkStyle = (typeof workspaceLinkStyles)[number];

export const automaticLinkUpdatePolicies = ["ask", "always", "never"] as const;
export type AutomaticLinkUpdatePolicy = (typeof automaticLinkUpdatePolicies)[number];

export const deleteConfirmationPolicies = ["always", "when-linked"] as const;
export type DeleteConfirmationPolicy = (typeof deleteConfirmationPolicies)[number];

export const newTabBehaviors = ["focus", "background"] as const;
export type NewTabBehavior = (typeof newTabBehaviors)[number];

export const editorModes = ["live", "source"] as const;
export type EditorMode = (typeof editorModes)[number];

export const documentViewModes = ["live", "source", "reading"] as const;
export type DocumentViewMode = (typeof documentViewModes)[number];

export interface VaultWorkspaceMode {
  editorMode: EditorMode;
  documentView: DocumentViewMode;
}

export const restorePolicies = ["restore", "fresh"] as const;
export type RestorePolicy = (typeof restorePolicies)[number];

export const editorTabSizes = [2, 4, 8] as const;
export type EditorTabSize = (typeof editorTabSizes)[number];

export interface VaultWorkspaceSettings {
  defaultNoteFolder: string;
  attachmentFolder: string;
  linkStyle: WorkspaceLinkStyle;
  automaticLinkUpdates: AutomaticLinkUpdatePolicy;
  confirmDelete: DeleteConfirmationPolicy;
  newTabBehavior: NewTabBehavior;
  editorMode: EditorMode;
  documentView: DocumentViewMode;
  showInlineTitle: boolean;
  readableLineLength: boolean;
  showLineNumbers: boolean;
  spellcheck: boolean;
  tabSize: EditorTabSize;
  showStatusBar: boolean;
  restorePolicy: RestorePolicy;
}

export const defaultVaultWorkspaceSettings: Readonly<VaultWorkspaceSettings> = {
  defaultNoteFolder: "",
  attachmentFolder: "",
  linkStyle: "preserve",
  automaticLinkUpdates: "ask",
  confirmDelete: "always",
  newTabBehavior: "focus",
  editorMode: "live",
  documentView: "live",
  showInlineTitle: true,
  readableLineLength: true,
  showLineNumbers: false,
  spellcheck: true,
  tabSize: 2,
  showStatusBar: true,
  restorePolicy: "restore",
};

const maxPathLength = 4_096;
const privateSegments = new Set([".obsidian", ".git", ".trash"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeVisibleFolder(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  if (value.includes("\0") || value.length > maxPathLength) {
    throw new Error(`${label} must contain at most ${maxPathLength} characters and no null bytes.`);
  }
  const portable = value.trim().replaceAll("\\", "/");
  if (/^(?:\/|[a-z]:\/)/i.test(portable)) {
    throw new Error(`${label} must be relative to the vault.`);
  }
  const segments: string[] = [];
  for (const segment of portable.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      throw new Error(`${label} cannot leave the vault.`);
    }
    const folded = segment.toLocaleLowerCase("en-US");
    if (
      segment.startsWith(".") ||
      privateSegments.has(folded) ||
      folded.startsWith(".threadleaf-")
    ) {
      throw new Error(`${label} cannot use hidden or private vault paths.`);
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function parseEnum<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${label} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T[number];
}

function parseBoolean(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be true or false.`);
  }
  return value;
}

function parseEditorTabSize(value: unknown): EditorTabSize {
  if (value === undefined) {
    return defaultVaultWorkspaceSettings.tabSize;
  }
  if (typeof value !== "number" || !editorTabSizes.includes(value as EditorTabSize)) {
    throw new Error(`Editor tab size must be one of: ${editorTabSizes.join(", ")}.`);
  }
  return value as EditorTabSize;
}

export function createDefaultVaultWorkspaceSettings(): VaultWorkspaceSettings {
  return { ...defaultVaultWorkspaceSettings };
}

export function parseVaultWorkspaceSettings(value: unknown): VaultWorkspaceSettings {
  if (!isRecord(value)) {
    throw new Error("Workspace settings must be an object.");
  }
  return {
    defaultNoteFolder: normalizeVisibleFolder(value.defaultNoteFolder, "Default note folder"),
    attachmentFolder: normalizeVisibleFolder(value.attachmentFolder ?? "", "Attachment folder"),
    linkStyle: parseEnum(value.linkStyle, workspaceLinkStyles, "Link style"),
    automaticLinkUpdates: parseEnum(
      value.automaticLinkUpdates,
      automaticLinkUpdatePolicies,
      "Automatic link update policy",
    ),
    confirmDelete: parseEnum(
      value.confirmDelete,
      deleteConfirmationPolicies,
      "Delete confirmation policy",
    ),
    newTabBehavior: parseEnum(value.newTabBehavior, newTabBehaviors, "New-tab behavior"),
    editorMode: parseEnum(value.editorMode, editorModes, "Editor mode"),
    documentView: parseEnum(value.documentView, documentViewModes, "Document view"),
    showInlineTitle: parseBoolean(
      value.showInlineTitle,
      defaultVaultWorkspaceSettings.showInlineTitle,
      "Inline title visibility",
    ),
    readableLineLength: parseBoolean(
      value.readableLineLength,
      defaultVaultWorkspaceSettings.readableLineLength,
      "Readable line length",
    ),
    showLineNumbers: parseBoolean(
      value.showLineNumbers,
      defaultVaultWorkspaceSettings.showLineNumbers,
      "Line number visibility",
    ),
    spellcheck: parseBoolean(
      value.spellcheck,
      defaultVaultWorkspaceSettings.spellcheck,
      "Spellcheck",
    ),
    tabSize: parseEditorTabSize(value.tabSize),
    showStatusBar: parseBoolean(
      value.showStatusBar,
      defaultVaultWorkspaceSettings.showStatusBar,
      "Status bar visibility",
    ),
    restorePolicy: parseEnum(value.restorePolicy, restorePolicies, "Workspace restore policy"),
  };
}

export function parseVaultWorkspaceMode(value: unknown): VaultWorkspaceMode {
  if (!isRecord(value)) {
    throw new Error("Workspace mode must be an object.");
  }
  return {
    editorMode: parseEnum(value.editorMode, editorModes, "Editor mode"),
    documentView: parseEnum(value.documentView, documentViewModes, "Document view"),
  };
}

export function workspaceSettingsForVault(
  settings: { workspaceByVault: Record<string, VaultWorkspaceSettings> },
  vaultId: string,
): VaultWorkspaceSettings {
  const value = settings.workspaceByVault[vaultId];
  return value ? { ...value } : createDefaultVaultWorkspaceSettings();
}

export function updateVaultWorkspaceSettings(
  settings: { workspaceByVault: Record<string, VaultWorkspaceSettings> },
  vaultId: string,
  value: VaultWorkspaceSettings,
): { workspaceByVault: Record<string, VaultWorkspaceSettings> } & typeof settings {
  if (!/^[a-f0-9]{64}$/.test(vaultId)) {
    throw new Error("Workspace preferences require lowercase SHA-256 vault identities.");
  }
  const normalized = parseVaultWorkspaceSettings(value);
  return {
    ...settings,
    workspaceByVault: {
      ...settings.workspaceByVault,
      [vaultId]: normalized,
    },
  };
}

export function defaultNotePath(folder: string, requestedPath: string): string {
  const normalizedFolder = normalizeVisibleFolder(folder, "Default note folder");
  const normalizedPath = requestedPath.trim().replaceAll("\\", "/");
  if (!normalizedFolder || normalizedPath.includes("/")) {
    return normalizedPath;
  }
  return `${normalizedFolder}/${normalizedPath}`;
}
