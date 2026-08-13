export const workspaceLayoutVersion = 1 as const;
export const workspaceWindowMinimumWidth = 640;
export const workspaceWindowMinimumHeight = 480;
export const workspaceVisibleGrip = 48;

export type WorkspaceDockId = "left" | "right";
export type WorkspaceDockViewType = "navigator" | "inspector";

export interface WorkspaceWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
}

export interface WorkspaceDockSnapshot {
  id: WorkspaceDockId;
  collapsed: boolean;
  viewType: WorkspaceDockViewType;
  state: "ready" | "degraded";
  warning: string | null;
}

export interface WorkspacePopoutSnapshot {
  state: "closed" | "open" | "degraded";
  viewType: string | null;
  filePath: string | null;
  bounds: WorkspaceWindowBounds | null;
  warning: string | null;
}

export interface WorkspaceLayoutSnapshot {
  version: typeof workspaceLayoutVersion;
  vaultId: string;
  docks: Record<WorkspaceDockId, WorkspaceDockSnapshot>;
  mainWindowBounds: WorkspaceWindowBounds | null;
  popout: WorkspacePopoutSnapshot;
}

export interface WorkspaceLayoutDocument {
  version: typeof workspaceLayoutVersion;
  vaultId: string;
  docks: {
    left: { collapsed: boolean; viewType: WorkspaceDockViewType };
    right: { collapsed: boolean; viewType: WorkspaceDockViewType };
  };
  mainWindowBounds: WorkspaceWindowBounds | null;
  popout: WorkspacePopoutSnapshot;
}

export interface WorkspaceDisplayWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDockViewType(value: unknown): value is WorkspaceDockViewType {
  return value === "navigator" || value === "inspector";
}

function boundedString(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`${label} must be a bounded non-empty string.`);
  }
  return value;
}

export function parseWorkspaceWindowBounds(value: unknown): WorkspaceWindowBounds {
  if (!isRecord(value)) {
    throw new Error("Workspace window bounds must be an object.");
  }
  const numbers = [value.x, value.y, value.width, value.height, value.scaleFactor];
  if (numbers.some((candidate) => typeof candidate !== "number" || !Number.isFinite(candidate))) {
    throw new Error("Workspace window bounds require finite numeric fields.");
  }
  if (
    (value.width as number) < workspaceWindowMinimumWidth ||
    (value.height as number) < workspaceWindowMinimumHeight ||
    (value.scaleFactor as number) <= 0
  ) {
    throw new Error("Workspace window bounds are below the supported minimum.");
  }
  return {
    x: Math.round(value.x as number),
    y: Math.round(value.y as number),
    width: Math.round(value.width as number),
    height: Math.round(value.height as number),
    scaleFactor: Math.round((value.scaleFactor as number) * 100) / 100,
  };
}

function parsePopout(value: unknown): WorkspacePopoutSnapshot {
  if (!isRecord(value)) {
    throw new Error("Workspace pop-out state must be an object.");
  }
  if (value.state !== "closed" && value.state !== "open" && value.state !== "degraded") {
    throw new Error("Workspace pop-out state is unsupported.");
  }
  const viewType =
    value.viewType === null ? null : boundedString(value.viewType, "Pop-out view type");
  const filePath =
    value.filePath === null ? null : boundedString(value.filePath, "Pop-out file path");
  const bounds = value.bounds === null ? null : parseWorkspaceWindowBounds(value.bounds);
  const warning =
    value.warning === null ? null : boundedString(value.warning, "Pop-out warning", 1_024);
  if (value.state === "closed" && (viewType !== null || filePath !== null || warning !== null)) {
    throw new Error("A closed workspace pop-out cannot retain an active view or warning.");
  }
  if (value.state === "open" && (viewType === null || bounds === null || warning !== null)) {
    throw new Error("An open workspace pop-out requires a view, visible bounds, and no warning.");
  }
  if (value.state === "degraded" && warning === null) {
    throw new Error("A degraded workspace pop-out requires a warning.");
  }
  return { state: value.state, viewType, filePath, bounds, warning };
}

export function parseWorkspaceLayout(
  value: unknown,
  expectedVaultId: string,
): WorkspaceLayoutDocument {
  boundedString(expectedVaultId, "Workspace layout vault identity", 256);
  if (!isRecord(value) || value.version !== workspaceLayoutVersion) {
    throw new Error("Workspace layout requires version 1.");
  }
  if (value.vaultId !== expectedVaultId || !isRecord(value.docks)) {
    throw new Error("Workspace layout vault identity or docks are invalid.");
  }
  const docks = { left: value.docks.left, right: value.docks.right };
  for (const id of ["left", "right"] as const) {
    const dock = docks[id];
    if (!isRecord(dock) || typeof dock.collapsed !== "boolean" || !isDockViewType(dock.viewType)) {
      throw new Error(`Workspace ${id} dock state is invalid.`);
    }
  }
  const leftDock = docks.left as Record<string, unknown>;
  const rightDock = docks.right as Record<string, unknown>;
  const mainWindowBounds =
    value.mainWindowBounds === null ? null : parseWorkspaceWindowBounds(value.mainWindowBounds);
  const popout = parsePopout(value.popout);
  return {
    version: workspaceLayoutVersion,
    vaultId: expectedVaultId,
    docks: {
      left: {
        collapsed: leftDock.collapsed as boolean,
        viewType: leftDock.viewType as WorkspaceDockViewType,
      },
      right: {
        collapsed: rightDock.collapsed as boolean,
        viewType: rightDock.viewType as WorkspaceDockViewType,
      },
    },
    mainWindowBounds,
    popout,
  };
}

export function createDefaultWorkspaceLayout(vaultId: string): WorkspaceLayoutDocument {
  boundedString(vaultId, "Workspace layout vault identity", 256);
  return {
    version: workspaceLayoutVersion,
    vaultId,
    docks: {
      left: { collapsed: false, viewType: "navigator" },
      right: { collapsed: false, viewType: "inspector" },
    },
    mainWindowBounds: null,
    popout: { state: "closed", viewType: null, filePath: null, bounds: null, warning: null },
  };
}

function overlap(aStart: number, aLength: number, bStart: number, bLength: number): number {
  return Math.max(0, Math.min(aStart + aLength, bStart + bLength) - Math.max(aStart, bStart));
}

function visibleOnWorkArea(
  bounds: WorkspaceWindowBounds,
  workArea: WorkspaceDisplayWorkArea,
): boolean {
  return (
    overlap(bounds.x, bounds.width, workArea.x, workArea.width) >= workspaceVisibleGrip &&
    overlap(bounds.y, bounds.height, workArea.y, workArea.height) >= workspaceVisibleGrip
  );
}

export function restoreWorkspaceWindowBounds(
  requested: WorkspaceWindowBounds | null,
  workAreas: readonly WorkspaceDisplayWorkArea[],
  fallback: WorkspaceWindowBounds,
): WorkspaceWindowBounds {
  const candidate = requested ?? fallback;
  const area =
    workAreas.find((workArea) => visibleOnWorkArea(candidate, workArea)) ??
    workAreas[0] ??
    ({
      x: 0,
      y: 0,
      width: candidate.width,
      height: candidate.height,
    } satisfies WorkspaceDisplayWorkArea);
  const width = Math.min(
    Math.max(workspaceWindowMinimumWidth, Math.round(candidate.width)),
    Math.max(workspaceWindowMinimumWidth, Math.round(area.width)),
  );
  const height = Math.min(
    Math.max(workspaceWindowMinimumHeight, Math.round(candidate.height)),
    Math.max(workspaceWindowMinimumHeight, Math.round(area.height)),
  );
  const xMax = area.x + Math.max(0, area.width - workspaceVisibleGrip);
  const yMax = area.y + Math.max(0, area.height - workspaceVisibleGrip);
  return {
    x: Math.min(xMax, Math.max(area.x - width + workspaceVisibleGrip, Math.round(candidate.x))),
    y: Math.min(yMax, Math.max(area.y - height + workspaceVisibleGrip, Math.round(candidate.y))),
    width,
    height,
    scaleFactor: candidate.scaleFactor > 0 ? candidate.scaleFactor : 1,
  };
}
