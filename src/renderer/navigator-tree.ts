import {
  maximumWorkspaceFilePageSize,
  type WorkspaceTreeEntry,
  type WorkspaceTreePageDescriptor,
} from "../shared/contracts";

/**
 * The cache keeps every page needed by the current viewport, focus, or active
 * reveal chain. Outside that mandatory set, it retains only a small LRU.
 */
export const maximumNavigatorTreeLruPages = 8;

export interface NavigatorTreeChildrenState {
  descriptor: WorkspaceTreePageDescriptor;
  entries: Map<number, WorkspaceTreeEntry>;
}

export interface NavigatorTreeState {
  vaultId: string;
  generation: string;
  pages: Map<string | null, NavigatorTreeChildrenState>;
  pendingRequests: Set<string>;
  cachedPages: Map<string, NavigatorTreeCachedPage>;
  retainedPageKeys: Set<string>;
}

export interface NavigatorTreePageRequest {
  parentPath: string | null;
  offset: number;
  limit: number;
}

/** A single row needed to keep an active-note reveal chain visible. */
export interface NavigatorTreeEntryLocation {
  parentPath: string | null;
  offset: number;
}

export interface NavigatorTreeRetentionCounts {
  pages: number;
  entries: number;
  parentDescriptors: number;
  mandatoryPages: number;
  lruPages: number;
}

interface NavigatorTreeCachedPage {
  parentPath: string | null;
  offset: number;
  entryOffsets: readonly number[];
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

function pageRequestForRow(
  state: NavigatorTreeState,
  row: NavigatorTreeRow,
): NavigatorTreePageRequest {
  const children = state.pages.get(row.parentPath);
  const limit = children?.descriptor.limit ?? maximumWorkspaceFilePageSize;
  const siblingOffset = row.kind === "entry" ? row.siblingIndex : row.offset;
  return {
    parentPath: row.parentPath,
    offset: Math.floor(siblingOffset / limit) * limit,
    limit,
  };
}

function touchCachedPage(state: NavigatorTreeState, key: string): void {
  const cached = state.cachedPages.get(key);
  if (!cached) return;
  state.cachedPages.delete(key);
  state.cachedPages.set(key, cached);
}

function retainedEntryCount(state: NavigatorTreeState): number {
  let total = 0;
  for (const children of state.pages.values()) {
    total += children.entries.size;
  }
  return total;
}

function cachedMandatoryPageCount(state: NavigatorTreeState): number {
  let total = 0;
  for (const key of state.cachedPages.keys()) {
    if (state.retainedPageKeys.has(key)) total += 1;
  }
  return total;
}

function cachedLruPageCount(state: NavigatorTreeState): number {
  return state.cachedPages.size - cachedMandatoryPageCount(state);
}

function hasCachedPageForParent(state: NavigatorTreeState, parentPath: string | null): boolean {
  for (const cached of state.cachedPages.values()) {
    if (cached.parentPath === parentPath) return true;
  }
  return false;
}

function discardCachedPage(state: NavigatorTreeState, key: string): void {
  const cached = state.cachedPages.get(key);
  if (!cached) return;
  const children = state.pages.get(cached.parentPath);
  if (children) {
    for (const offset of cached.entryOffsets) {
      children.entries.delete(offset);
    }
  }
  state.cachedPages.delete(key);
  if (!hasCachedPageForParent(state, cached.parentPath)) {
    state.pages.delete(cached.parentPath);
  }
}

function trimNavigatorTreeCache(state: NavigatorTreeState): void {
  while (cachedLruPageCount(state) > maximumNavigatorTreeLruPages) {
    const evictedKey = [...state.cachedPages.keys()].find(
      (key) => !state.retainedPageKeys.has(key),
    );
    if (!evictedKey) return;
    discardCachedPage(state, evictedKey);
  }
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
    cachedPages: new Map<string, NavigatorTreeCachedPage>(),
    retainedPageKeys: new Set<string>(),
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
  const key = requestKey(descriptor.parentPath, descriptor.offset);
  const current = state.pages.get(descriptor.parentPath) ?? {
    descriptor: { ...descriptor },
    entries: new Map<number, WorkspaceTreeEntry>(),
  };
  if (state.cachedPages.has(key)) {
    discardCachedPage(state, key);
  }
  current.descriptor = { ...descriptor };
  for (const offset of current.entries.keys()) {
    if (offset >= descriptor.total) current.entries.delete(offset);
  }
  const entryOffsets: number[] = [];
  for (const [index, entry] of entries.entries()) {
    const offset = descriptor.offset + index;
    current.entries.set(offset, entry);
    entryOffsets.push(offset);
  }
  state.pages.set(descriptor.parentPath, current);
  state.cachedPages.set(key, {
    parentPath: descriptor.parentPath,
    offset: descriptor.offset,
    entryOffsets,
  });
  trimNavigatorTreeCache(state);
  return true;
}

/**
 * Retains complete viewport/focus pages and only the exact rows needed for a
 * deep active-note reveal. Replacing the target set lets stale traversal pages
 * fall out through the LRU on the next response or retention update.
 */
export function retainNavigatorTreePages(
  state: NavigatorTreeState,
  pageRequests: readonly NavigatorTreePageRequest[],
  entryLocations: readonly NavigatorTreeEntryLocation[] = [],
): void {
  const pageKeys = new Set<string>();
  for (const request of pageRequests) {
    const key = requestKey(request.parentPath, request.offset);
    pageKeys.add(key);
    touchCachedPage(state, key);
  }
  for (const location of entryLocations) {
    const limit =
      state.pages.get(location.parentPath)?.descriptor.limit ?? maximumWorkspaceFilePageSize;
    const offset = Math.floor(location.offset / limit) * limit;
    const key = requestKey(location.parentPath, offset);
    pageKeys.add(key);
    touchCachedPage(state, key);
  }
  state.retainedPageKeys = pageKeys;
  trimNavigatorTreeCache(state);
}

export function navigatorTreeRetentionCounts(
  state: NavigatorTreeState,
): NavigatorTreeRetentionCounts {
  const mandatoryPages = cachedMandatoryPageCount(state);
  return {
    pages: state.cachedPages.size,
    entries: retainedEntryCount(state),
    parentDescriptors: state.pages.size,
    mandatoryPages,
    lruPages: state.cachedPages.size - mandatoryPages,
  };
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
  const key = requestKey(request.parentPath, request.offset);
  if (
    (children?.descriptor.total !== undefined && request.offset >= children.descriptor.total) ||
    state.cachedPages.has(key)
  ) {
    touchCachedPage(state, key);
    return false;
  }
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
  for (const request of navigatorTreePageRequestsForRange(state, projection, start, end)) {
    if (claimNavigatorTreePageRequest(state, request)) requests.push(request);
  }
  return requests;
}

/** Returns all complete pages intersecting a virtual range, loaded or not. */
export function navigatorTreePageRequestsForRange(
  state: NavigatorTreeState,
  projection: NavigatorTreeProjection,
  start: number,
  end: number,
): NavigatorTreePageRequest[] {
  const requests = new Map<string, NavigatorTreePageRequest>();
  for (let index = Math.max(0, start); index < Math.min(end, projection.length); index += 1) {
    const row = projection.rowAt(index);
    if (!row) continue;
    const request = pageRequestForRow(state, row);
    requests.set(requestKey(request.parentPath, request.offset), request);
  }
  return [...requests.values()];
}

export function navigatorTreeParentPath(path: string): string | null {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? null : path.slice(0, separator);
}
