import { normalizeVaultPath } from "../kernel/path-policy";

export const maximumPersistedWorkspaceTabs = 1_024;

export interface PersistedWorkspaceState {
  version: 1;
  vaultId: string;
  openPaths: string[];
  activePath: string | null;
}

export interface WorkspaceStateStore {
  load(vaultId: string): Promise<PersistedWorkspaceState | null>;
  save(state: PersistedWorkspaceState): Promise<PersistedWorkspaceState>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeWorkspacePath(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Workspace note paths must be strings.");
  }
  const normalized = normalizeVaultPath(value);
  if (!normalized.toLocaleLowerCase("en-US").endsWith(".md")) {
    throw new Error(`Workspace tabs can contain only Markdown notes: ${normalized}`);
  }
  if (normalized.toLocaleLowerCase("en-US").startsWith(".obsidian/")) {
    throw new Error("Workspace tabs cannot point inside .obsidian.");
  }
  return normalized;
}

export function parseWorkspaceState(
  value: unknown,
  expectedVaultId: string,
): PersistedWorkspaceState {
  if (!expectedVaultId || expectedVaultId.length > 256) {
    throw new Error("Workspace state requires a bounded vault identity.");
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.vaultId !== expectedVaultId ||
    !Array.isArray(value.openPaths) ||
    !(value.activePath === null || typeof value.activePath === "string")
  ) {
    throw new Error(
      "Workspace state must contain version 1, its vault identity, tabs, and active path.",
    );
  }
  if (value.openPaths.length > maximumPersistedWorkspaceTabs) {
    throw new Error(
      `Workspace state cannot contain more than ${maximumPersistedWorkspaceTabs} tabs.`,
    );
  }

  const openPaths = value.openPaths.map(normalizeWorkspacePath);
  if (new Set(openPaths).size !== openPaths.length) {
    throw new Error("Workspace state cannot contain duplicate tabs.");
  }
  const activePath = value.activePath === null ? null : normalizeWorkspacePath(value.activePath);
  if (activePath !== null && !openPaths.includes(activePath)) {
    throw new Error("The active workspace path must also be an open tab.");
  }
  if (activePath === null && openPaths.length > 0) {
    throw new Error("A workspace with open tabs must identify its active path.");
  }

  return {
    version: 1,
    vaultId: expectedVaultId,
    openPaths,
    activePath,
  };
}

export function createWorkspaceState(
  vaultId: string,
  openPaths: readonly string[],
  activePath: string | null,
): PersistedWorkspaceState {
  return parseWorkspaceState(
    {
      version: 1,
      vaultId,
      openPaths: [...openPaths],
      activePath,
    },
    vaultId,
  );
}
