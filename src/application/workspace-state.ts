import { normalizeVaultPath } from "../kernel/path-policy";

export const maximumPersistedWorkspaceTabs = 1_024;
export const maximumPersistedWorkspaceHistory = 128;
export const maximumWorkspacePanes = 2;

export type WorkspacePaneId = "primary" | "secondary";
export type WorkspaceSplitDirection = "horizontal" | "vertical";

export interface WorkspaceNavigationHistory {
  back: string[];
  forward: string[];
}

export interface PersistedWorkspacePane {
  id: WorkspacePaneId;
  openPaths: string[];
  /**
   * Ordered members of the leading pinned tab region. This remains an optional
   * layoutVersion 2 member on disk so prior readers can retain the focused-pane
   * version 1 projection while current readers normalize an absent field to [].
   */
  pinnedPaths: string[];
  activePath: string | null;
  /** Optional so layoutVersion 2 readers can safely retain older state files. */
  navigationHistory?: WorkspaceNavigationHistory;
}

export interface WorkspacePaneInput {
  id: WorkspacePaneId;
  openPaths: readonly string[];
  pinnedPaths?: readonly string[];
  activePath: string | null;
  navigationHistory?: {
    readonly back: readonly string[];
    readonly forward: readonly string[];
  };
}

export interface PersistedWorkspaceState {
  version: 2;
  vaultId: string;
  panes: PersistedWorkspacePane[];
  activePaneId: WorkspacePaneId;
  splitDirection: WorkspaceSplitDirection | null;
}

interface LegacyWorkspaceState {
  version: 1;
  vaultId: string;
  openPaths: string[];
  activePath: string | null;
}

export interface WorkspaceStateDocument extends LegacyWorkspaceState {
  layoutVersion: 2;
  panes: PersistedWorkspacePane[];
  activePaneId: WorkspacePaneId;
  splitDirection: WorkspaceSplitDirection | null;
}

export interface WorkspaceStateStore {
  load(vaultId: string): Promise<PersistedWorkspaceState | null>;
  save(
    state: PersistedWorkspaceState,
    expectedCurrent?: PersistedWorkspaceState | null,
  ): Promise<PersistedWorkspaceState>;
}

export function workspaceStatesEqual(
  left: PersistedWorkspaceState,
  right: PersistedWorkspaceState,
): boolean {
  return (
    left.vaultId === right.vaultId &&
    left.activePaneId === right.activePaneId &&
    left.splitDirection === right.splitDirection &&
    left.panes.length === right.panes.length &&
    left.panes.every((pane, paneIndex) => {
      const other = right.panes[paneIndex];
      return (
        other !== undefined &&
        pane.id === other.id &&
        pane.activePath === other.activePath &&
        pane.openPaths.length === other.openPaths.length &&
        pane.openPaths.every((filePath, pathIndex) => filePath === other.openPaths[pathIndex]) &&
        pane.pinnedPaths.length === other.pinnedPaths.length &&
        pane.pinnedPaths.every(
          (filePath, pathIndex) => filePath === other.pinnedPaths[pathIndex],
        ) &&
        navigationHistoriesEqual(pane.navigationHistory, other.navigationHistory)
      );
    })
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPaneId(value: unknown): value is WorkspacePaneId {
  return value === "primary" || value === "secondary";
}

function isSplitDirection(value: unknown): value is WorkspaceSplitDirection {
  return value === "horizontal" || value === "vertical";
}

function normalizeWorkspacePath(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Workspace note paths must be strings.");
  }
  const normalized = normalizeVaultPath(value);
  const folded = normalized.toLocaleLowerCase("en-US");
  if (!folded.endsWith(".md") && !folded.endsWith(".canvas")) {
    throw new Error(
      `Workspace tabs can contain only Markdown notes or JSON Canvases: ${normalized}`,
    );
  }
  if (normalized.toLocaleLowerCase("en-US").startsWith(".obsidian/")) {
    throw new Error("Workspace tabs cannot point inside .obsidian.");
  }
  return normalized;
}

function normalizeNavigationHistory(value: unknown): WorkspaceNavigationHistory | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || !Array.isArray(value.back) || !Array.isArray(value.forward)) {
    throw new Error("Workspace navigation history requires back and forward path arrays.");
  }
  if (value.back.length + value.forward.length > maximumPersistedWorkspaceHistory) {
    throw new Error(
      `Workspace navigation history cannot contain more than ${maximumPersistedWorkspaceHistory} entries per pane.`,
    );
  }
  const back = value.back.map(normalizeWorkspacePath);
  const forward = value.forward.map(normalizeWorkspacePath);
  if (new Set([...back, ...forward]).size !== back.length + forward.length) {
    throw new Error("Workspace navigation history cannot contain duplicate paths.");
  }
  return { back, forward };
}

function navigationHistoriesEqual(
  left: WorkspaceNavigationHistory | undefined,
  right: WorkspaceNavigationHistory | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return (
      (!left || (left.back.length === 0 && left.forward.length === 0)) &&
      (!right || (right.back.length === 0 && right.forward.length === 0))
    );
  }
  return (
    left.back.length === right.back.length &&
    left.back.every((filePath, index) => filePath === right.back[index]) &&
    left.forward.length === right.forward.length &&
    left.forward.every((filePath, index) => filePath === right.forward[index])
  );
}

function normalizePane(value: unknown): PersistedWorkspacePane {
  if (
    !isRecord(value) ||
    !isPaneId(value.id) ||
    !Array.isArray(value.openPaths) ||
    !(value.pinnedPaths === undefined || Array.isArray(value.pinnedPaths)) ||
    !(value.activePath === null || typeof value.activePath === "string")
  ) {
    throw new Error(
      "Each workspace pane requires an ID, ordered tabs, pinned tabs, and an active path.",
    );
  }
  if (value.openPaths.length > maximumPersistedWorkspaceTabs) {
    throw new Error(
      `A workspace pane cannot contain more than ${maximumPersistedWorkspaceTabs} tabs.`,
    );
  }
  const rawOpenPaths = value.openPaths.map(normalizeWorkspacePath);
  if (new Set(rawOpenPaths).size !== rawOpenPaths.length) {
    throw new Error("A workspace pane cannot contain duplicate tabs.");
  }
  const pinnedPaths = (value.pinnedPaths ?? []).map(normalizeWorkspacePath);
  if (new Set(pinnedPaths).size !== pinnedPaths.length) {
    throw new Error("A workspace pane cannot contain duplicate pinned tabs.");
  }
  if (pinnedPaths.length > rawOpenPaths.length) {
    throw new Error("A workspace pane cannot pin more tabs than it opens.");
  }
  const openPathSet = new Set(rawOpenPaths);
  if (pinnedPaths.some((filePath) => !openPathSet.has(filePath))) {
    throw new Error("Pinned workspace tabs must also be open in their pane.");
  }
  const pinnedPathSet = new Set(pinnedPaths);
  const openPaths = [
    ...pinnedPaths,
    ...rawOpenPaths.filter((filePath) => !pinnedPathSet.has(filePath)),
  ];
  const activePath = value.activePath === null ? null : normalizeWorkspacePath(value.activePath);
  if (activePath !== null && !openPaths.includes(activePath)) {
    throw new Error("The active workspace path must also be an open tab in its pane.");
  }
  if (activePath === null && openPaths.length > 0) {
    throw new Error("A workspace pane with open tabs must identify its active path.");
  }
  const navigationHistory = normalizeNavigationHistory(value.navigationHistory);
  return {
    id: value.id,
    openPaths,
    pinnedPaths,
    activePath,
    ...(navigationHistory ? { navigationHistory } : {}),
  };
}

function normalizeVersionTwo(
  value: Record<string, unknown>,
  expectedVaultId: string,
): PersistedWorkspaceState {
  if (
    value.vaultId !== expectedVaultId ||
    !Array.isArray(value.panes) ||
    !isPaneId(value.activePaneId) ||
    !(value.splitDirection === null || isSplitDirection(value.splitDirection))
  ) {
    throw new Error(
      "Workspace state must contain version 2, its vault identity, panes, active pane, and split direction.",
    );
  }
  if (value.panes.length < 1 || value.panes.length > maximumWorkspacePanes) {
    throw new Error(`Workspace state must contain between 1 and ${maximumWorkspacePanes} panes.`);
  }
  const panes = value.panes.map(normalizePane);
  if (new Set(panes.map(({ id }) => id)).size !== panes.length) {
    throw new Error("Workspace state cannot contain duplicate pane IDs.");
  }
  if (panes[0]?.id !== "primary") {
    throw new Error("The first workspace pane must be primary.");
  }
  if (panes.length === 2 && panes[1]?.id !== "secondary") {
    throw new Error("The second workspace pane must be secondary.");
  }
  if (!panes.some(({ id }) => id === value.activePaneId)) {
    throw new Error("The active workspace pane must exist in the layout.");
  }
  if ((panes.length === 1) !== (value.splitDirection === null)) {
    throw new Error("One pane cannot have a split direction, and two panes require one.");
  }
  return {
    version: 2,
    vaultId: expectedVaultId,
    panes,
    activePaneId: value.activePaneId,
    splitDirection: value.splitDirection,
  };
}

function migrateVersionOne(
  value: Record<string, unknown>,
  expectedVaultId: string,
): PersistedWorkspaceState {
  if (
    value.vaultId !== expectedVaultId ||
    !Array.isArray(value.openPaths) ||
    !(value.activePath === null || typeof value.activePath === "string")
  ) {
    throw new Error(
      "Workspace state must contain version 1, its vault identity, tabs, and active path.",
    );
  }
  const legacy: LegacyWorkspaceState = {
    version: 1,
    vaultId: expectedVaultId,
    openPaths: value.openPaths as string[],
    activePath: value.activePath as string | null,
  };
  return normalizeVersionTwo(
    {
      version: 2,
      vaultId: expectedVaultId,
      panes: [
        {
          id: "primary",
          openPaths: legacy.openPaths,
          activePath: legacy.activePath,
        },
      ],
      activePaneId: "primary",
      splitDirection: null,
    },
    expectedVaultId,
  );
}

function normalizeCompatibleVersionOne(
  value: Record<string, unknown>,
  expectedVaultId: string,
): PersistedWorkspaceState {
  const legacy = migrateVersionOne(value, expectedVaultId);
  const layout = normalizeVersionTwo(
    {
      vaultId: value.vaultId,
      panes: value.panes,
      activePaneId: value.activePaneId,
      splitDirection: value.splitDirection,
    },
    expectedVaultId,
  );
  const projectedPane = activeWorkspacePane(layout);
  const legacyPane = activeWorkspacePane(legacy);
  if (
    legacyPane.activePath !== projectedPane.activePath ||
    legacyPane.openPaths.length !== projectedPane.openPaths.length ||
    legacyPane.openPaths.some((filePath, index) => filePath !== projectedPane.openPaths[index])
  ) {
    throw new Error("The version 1 compatibility projection must match the active workspace pane.");
  }
  return layout;
}

export function parseWorkspaceState(
  value: unknown,
  expectedVaultId: string,
): PersistedWorkspaceState {
  if (!expectedVaultId || expectedVaultId.length > 256) {
    throw new Error("Workspace state requires a bounded vault identity.");
  }
  if (!isRecord(value)) {
    throw new Error("Workspace state must be an object.");
  }
  if (value.version === 1) {
    if (value.layoutVersion === 2) {
      return normalizeCompatibleVersionOne(value, expectedVaultId);
    }
    if (value.layoutVersion !== undefined) {
      throw new Error("Workspace state has an unsupported layout extension version.");
    }
    return migrateVersionOne(value, expectedVaultId);
  }
  if (value.version !== 2) {
    throw new Error("Workspace state requires version 1 or 2.");
  }
  return normalizeVersionTwo(value, expectedVaultId);
}

export function createWorkspaceState(
  vaultId: string,
  openPaths: readonly string[],
  activePath: string | null,
): PersistedWorkspaceState {
  return createWorkspaceLayout(
    vaultId,
    [{ id: "primary", openPaths: [...openPaths], activePath }],
    "primary",
    null,
  );
}

export function createWorkspaceLayout(
  vaultId: string,
  panes: readonly WorkspacePaneInput[],
  activePaneId: WorkspacePaneId,
  splitDirection: WorkspaceSplitDirection | null,
): PersistedWorkspaceState {
  return parseWorkspaceState(
    {
      version: 2,
      vaultId,
      panes: panes.map((pane) => ({
        id: pane.id,
        openPaths: [...pane.openPaths],
        ...(pane.pinnedPaths ? { pinnedPaths: [...pane.pinnedPaths] } : {}),
        activePath: pane.activePath,
        ...(pane.navigationHistory
          ? {
              navigationHistory: {
                back: [...pane.navigationHistory.back],
                forward: [...pane.navigationHistory.forward],
              },
            }
          : {}),
      })),
      activePaneId,
      splitDirection,
    },
    vaultId,
  );
}

export function activeWorkspacePane(state: PersistedWorkspaceState): PersistedWorkspacePane {
  const pane = state.panes.find(({ id }) => id === state.activePaneId);
  if (!pane) {
    throw new Error("The active workspace pane is missing.");
  }
  return pane;
}

export function createWorkspaceStateDocument(
  state: PersistedWorkspaceState,
): WorkspaceStateDocument {
  const normalized = parseWorkspaceState(state, state.vaultId);
  const projectedPane = activeWorkspacePane(normalized);
  return {
    version: 1,
    layoutVersion: 2,
    vaultId: normalized.vaultId,
    openPaths: [...projectedPane.openPaths],
    activePath: projectedPane.activePath,
    panes: normalized.panes.map((pane) => ({
      id: pane.id,
      openPaths: [...pane.openPaths],
      pinnedPaths: [...pane.pinnedPaths],
      activePath: pane.activePath,
      ...(pane.navigationHistory
        ? {
            navigationHistory: {
              back: [...pane.navigationHistory.back],
              forward: [...pane.navigationHistory.forward],
            },
          }
        : {}),
    })),
    activePaneId: normalized.activePaneId,
    splitDirection: normalized.splitDirection,
  };
}

/**
 * Reorders one tab inside the region it already belongs to. `targetIndex` is
 * an insertion index in the pane's complete ordered tab list. Keeping the
 * operation here, beside state normalization, means pointer and keyboard
 * movement cannot accidentally cross the pinned boundary or lose a tab.
 */
export function reorderWorkspaceTab(
  state: PersistedWorkspaceState,
  paneId: WorkspacePaneId,
  filePath: string,
  targetIndex: number,
): PersistedWorkspaceState {
  const normalizedPath = normalizeWorkspacePath(filePath);
  if (!Number.isFinite(targetIndex)) {
    throw new Error("Workspace tab insertion targets must be finite numbers.");
  }
  const pane = state.panes.find(({ id }) => id === paneId);
  if (!pane) {
    throw new Error(`Workspace pane is not open: ${paneId}`);
  }
  const sourceIndex = pane.openPaths.indexOf(normalizedPath);
  if (sourceIndex === -1) {
    throw new Error(`The workspace pane does not contain this tab: ${normalizedPath}`);
  }
  const pinnedCount = pane.pinnedPaths.length;
  const pinned = sourceIndex < pinnedCount;
  const regionStart = pinned ? 0 : pinnedCount;
  const regionEnd = pinned ? pinnedCount : pane.openPaths.length;
  const requestedIndex = Math.max(regionStart, Math.min(regionEnd, Math.round(targetIndex)));
  const nextPaths = [...pane.openPaths];
  nextPaths.splice(sourceIndex, 1);
  const insertionIndex = sourceIndex < requestedIndex ? requestedIndex - 1 : requestedIndex;
  nextPaths.splice(insertionIndex, 0, normalizedPath);
  if (nextPaths.every((path, index) => path === pane.openPaths[index])) {
    return state;
  }
  const nextPanes = state.panes.map((candidate) =>
    candidate.id === paneId ? { ...candidate, openPaths: nextPaths } : candidate,
  );
  return createWorkspaceLayout(state.vaultId, nextPanes, state.activePaneId, state.splitDirection);
}
