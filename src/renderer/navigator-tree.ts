import {
  maximumWorkspaceFilePageSize,
  type WorkspaceTreeEntry,
  type WorkspaceTreePageDescriptor,
} from "../shared/contracts";

export interface NavigatorTreeChildrenState {
  descriptor: WorkspaceTreePageDescriptor;
  entries: Map<number, WorkspaceTreeEntry>;
}

export interface NavigatorTreeState {
  vaultId: string;
  generation: string;
  pages: Map<string | null, NavigatorTreeChildrenState>;
  pendingRequests: Set<string>;
}

export interface NavigatorTreePageRequest {
  parentPath: string | null;
  offset: number;
  limit: number;
}

export type NavigatorTreeRow =
  | {
      kind: "entry";
      entry: WorkspaceTreeEntry;
      parentPath: string | null;
      depth: number;
      siblingIndex: number;
      siblingCount: number;
      expanded: boolean;
    }
  | {
      kind: "placeholder";
      parentPath: string | null;
      offset: number;
      depth: number;
      siblingIndex: number;
      siblingCount: number;
      loading: boolean;
    };

interface EntrySegment {
  kind: "entry";
  start: number;
  row: Extract<NavigatorTreeRow, { kind: "entry" }>;
}

interface PlaceholderSegment {
  kind: "placeholder";
  start: number;
  end: number;
  parentPath: string | null;
  firstOffset: number;
  depth: number;
  siblingCount: number;
  loading: boolean;
}

type NavigatorTreeSegment = EntrySegment | PlaceholderSegment;

export interface NavigatorTreeProjection {
  length: number;
  segmentCount: number;
  rowAt(index: number): NavigatorTreeRow | null;
  indexOfPath(path: string): number | null;
}

function requestKey(parentPath: string | null, offset: number): string {
  return `${parentPath ?? ""}\u0000${offset}`;
}

function sortedEntryOffsets(children: NavigatorTreeChildrenState): number[] {
  return [...children.entries.keys()]
    .filter((offset) => offset >= 0 && offset < children.descriptor.total)
    .sort((left, right) => left - right);
}

function findSegment(
  segments: readonly NavigatorTreeSegment[],
  index: number,
): NavigatorTreeSegment | null {
  let low = 0;
  let high = segments.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const segment = segments[middle];
    if (!segment) return null;
    const end = segment.kind === "entry" ? segment.start + 1 : segment.end;
    if (index < segment.start) {
      high = middle - 1;
    } else if (index >= end) {
      low = middle + 1;
    } else {
      return segment;
    }
  }
  return null;
}

export function createNavigatorTreeState(vaultId: string, generation: string): NavigatorTreeState {
  return {
    vaultId,
    generation,
    pages: new Map<string | null, NavigatorTreeChildrenState>(),
    pendingRequests: new Set<string>(),
  };
}

export function reconcileNavigatorTreeState(
  state: NavigatorTreeState | null,
  vaultId: string,
  generation: string,
): NavigatorTreeState {
  return state?.vaultId === vaultId && state.generation === generation
    ? state
    : createNavigatorTreeState(vaultId, generation);
}

export function applyNavigatorTreePage(
  state: NavigatorTreeState,
  descriptor: WorkspaceTreePageDescriptor,
  entries: readonly WorkspaceTreeEntry[],
): boolean {
  if (descriptor.generation !== state.generation) {
    return false;
  }
  const current = state.pages.get(descriptor.parentPath) ?? {
    descriptor: { ...descriptor },
    entries: new Map<number, WorkspaceTreeEntry>(),
  };
  current.descriptor = { ...descriptor };
  for (const offset of current.entries.keys()) {
    if (offset >= descriptor.total) current.entries.delete(offset);
  }
  for (const [index, entry] of entries.entries()) {
    current.entries.set(descriptor.offset + index, entry);
  }
  state.pages.set(descriptor.parentPath, current);
  return true;
}

export function completeNavigatorTreePageRequest(
  state: NavigatorTreeState,
  parentPath: string | null,
  offset: number,
): void {
  state.pendingRequests.delete(requestKey(parentPath, offset));
}

export function claimNavigatorTreePageRequest(
  state: NavigatorTreeState,
  request: NavigatorTreePageRequest,
): boolean {
  const children = state.pages.get(request.parentPath);
  if (
    (children?.descriptor.total !== undefined && request.offset >= children.descriptor.total) ||
    children?.entries.has(request.offset)
  ) {
    return false;
  }
  const key = requestKey(request.parentPath, request.offset);
  if (state.pendingRequests.has(key)) return false;
  state.pendingRequests.add(key);
  return true;
}

export function buildNavigatorTreeProjection(
  state: NavigatorTreeState,
  expandedPaths: ReadonlySet<string>,
): NavigatorTreeProjection {
  const segments: NavigatorTreeSegment[] = [];
  const rowIndexes = new Map<string, number>();
  let length = 0;

  const appendPlaceholder = (
    parentPath: string | null,
    firstOffset: number,
    count: number,
    depth: number,
    siblingCount: number,
    loading: boolean,
  ): void => {
    if (count <= 0) return;
    segments.push({
      kind: "placeholder",
      start: length,
      end: length + count,
      parentPath,
      firstOffset,
      depth,
      siblingCount,
      loading,
    });
    length += count;
  };

  const appendChildren = (parentPath: string | null, depth: number): void => {
    const children = state.pages.get(parentPath);
    if (!children) {
      if (parentPath !== null) {
        appendPlaceholder(parentPath, 0, 1, depth, 0, true);
      }
      return;
    }
    const total = children.descriptor.total;
    const offsets = sortedEntryOffsets(children);
    let nextOffset = 0;
    for (const offset of offsets) {
      if (offset > nextOffset) {
        appendPlaceholder(parentPath, nextOffset, offset - nextOffset, depth, total, false);
      }
      const entry = children.entries.get(offset);
      if (entry) {
        const row: Extract<NavigatorTreeRow, { kind: "entry" }> = {
          kind: "entry",
          entry,
          parentPath,
          depth,
          siblingIndex: offset,
          siblingCount: total,
          expanded: entry.kind === "folder" && expandedPaths.has(entry.path),
        };
        segments.push({ kind: "entry", start: length, row });
        rowIndexes.set(entry.path, length);
        length += 1;
        if (row.expanded) {
          appendChildren(entry.path, depth + 1);
        }
      }
      nextOffset = offset + 1;
    }
    if (nextOffset < total) {
      appendPlaceholder(parentPath, nextOffset, total - nextOffset, depth, total, false);
    }
  };

  appendChildren(null, 1);

  return {
    length,
    segmentCount: segments.length,
    rowAt(index: number): NavigatorTreeRow | null {
      if (!Number.isSafeInteger(index) || index < 0 || index >= length) return null;
      const segment = findSegment(segments, index);
      if (!segment) return null;
      if (segment.kind === "entry") return segment.row;
      const offset = segment.firstOffset + index - segment.start;
      return {
        kind: "placeholder",
        parentPath: segment.parentPath,
        offset,
        depth: segment.depth,
        siblingIndex: offset,
        siblingCount: segment.siblingCount,
        loading: segment.loading,
      };
    },
    indexOfPath(path: string): number | null {
      return rowIndexes.get(path) ?? null;
    },
  };
}

/** Claims the unloaded child pages intersecting a virtual viewport. */
export function claimNavigatorTreePageRequests(
  state: NavigatorTreeState,
  projection: NavigatorTreeProjection,
  start: number,
  end: number,
): NavigatorTreePageRequest[] {
  const requests: NavigatorTreePageRequest[] = [];
  for (let index = Math.max(0, start); index < Math.min(end, projection.length); index += 1) {
    const row = projection.rowAt(index);
    if (row?.kind !== "placeholder") continue;
    const children = state.pages.get(row.parentPath);
    const limit = children?.descriptor.limit ?? maximumWorkspaceFilePageSize;
    const offset = Math.floor(row.offset / limit) * limit;
    const total = children?.descriptor.total;
    if ((total !== undefined && offset >= total) || children?.entries.has(offset)) continue;
    const request = { parentPath: row.parentPath, offset, limit };
    if (claimNavigatorTreePageRequest(state, request)) requests.push(request);
  }
  return requests;
}

export function navigatorTreeParentPath(path: string): string | null {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? null : path.slice(0, separator);
}
