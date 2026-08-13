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

export const restorePolicies = ["restore", "fresh"] as const;
export type RestorePolicy = (typeof restorePolicies)[number];

export interface VaultWorkspaceSettings {
  defaultNoteFolder: string;
  linkStyle: WorkspaceLinkStyle;
  automaticLinkUpdates: AutomaticLinkUpdatePolicy;
  confirmDelete: DeleteConfirmationPolicy;
  newTabBehavior: NewTabBehavior;
  editorMode: EditorMode;
  documentView: DocumentViewMode;
  restorePolicy: RestorePolicy;
}

export const defaultVaultWorkspaceSettings: Readonly<VaultWorkspaceSettings> = {
  defaultNoteFolder: "",
  linkStyle: "preserve",
  automaticLinkUpdates: "ask",
  confirmDelete: "always",
  newTabBehavior: "focus",
  editorMode: "live",
  documentView: "live",
  restorePolicy: "restore",
};

const maxPathLength = 4_096;
const privateSegments = new Set([".obsidian", ".git", ".trash"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeVisibleFolder(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Default note folder must be a string.");
  }
  if (value.includes("\0") || value.length > maxPathLength) {
    throw new Error(
      `Default note folder must contain at most ${maxPathLength} characters and no null bytes.`,
    );
  }
  const portable = value.trim().replaceAll("\\", "/");
  if (/^(?:\/|[a-z]:\/)/i.test(portable)) {
    throw new Error("Default note folder must be relative to the vault.");
  }
  const segments: string[] = [];
  for (const segment of portable.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      throw new Error("Default note folder cannot leave the vault.");
    }
    const folded = segment.toLocaleLowerCase("en-US");
    if (
      segment.startsWith(".") ||
      privateSegments.has(folded) ||
      folded.startsWith(".threadleaf-")
    ) {
      throw new Error("Default note folder cannot use hidden or private vault paths.");
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

export function createDefaultVaultWorkspaceSettings(): VaultWorkspaceSettings {
  return { ...defaultVaultWorkspaceSettings };
}

export function parseVaultWorkspaceSettings(value: unknown): VaultWorkspaceSettings {
  if (!isRecord(value)) {
    throw new Error("Workspace settings must be an object.");
  }
  return {
    defaultNoteFolder: normalizeVisibleFolder(value.defaultNoteFolder),
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
    restorePolicy: parseEnum(value.restorePolicy, restorePolicies, "Workspace restore policy"),
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
  const normalizedFolder = normalizeVisibleFolder(folder);
  const normalizedPath = requestedPath.trim().replaceAll("\\", "/");
  if (!normalizedFolder || normalizedPath.includes("/")) {
    return normalizedPath;
  }
  return `${normalizedFolder}/${normalizedPath}`;
}
