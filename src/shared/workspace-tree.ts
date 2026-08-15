import type {
  WorkspaceFileSummary,
  WorkspaceTreeEntry,
  WorkspaceTreePathLocation,
} from "./contracts";

export interface WorkspaceTreeIndex {
  childrenByParent: ReadonlyMap<string | null, readonly WorkspaceTreeEntry[]>;
  pathLocations: ReadonlyMap<string, WorkspaceTreePathLocation>;
}

interface TreeEntryLocation {
  parentPath: string | null;
  offset: number;
}

const treeNameCollator = new Intl.Collator("en-US", {
  numeric: true,
  sensitivity: "base",
});

function publicPathSegments(path: string): string[] | null {
  if (!path || path.includes("\\") || path.includes("\0")) {
    return null;
  }
  const segments = path.split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 && segment !== "." && segment !== ".." && !segment.startsWith("."),
  )
    ? segments
    : null;
}

function compareTreeEntries(left: WorkspaceTreeEntry, right: WorkspaceTreeEntry): number {
  if (left.kind !== right.kind) {
    return left.kind === "folder" ? -1 : 1;
  }
  const titleComparison = treeNameCollator.compare(left.title, right.title);
  return titleComparison !== 0 ? titleComparison : left.path.localeCompare(right.path, "en-US");
}

function childEntries(
  childrenByParent: Map<string | null, WorkspaceTreeEntry[]>,
  parentPath: string | null,
): WorkspaceTreeEntry[] {
  const current = childrenByParent.get(parentPath);
  if (current) return current;
  const created: WorkspaceTreeEntry[] = [];
  childrenByParent.set(parentPath, created);
  return created;
}

/**
 * Builds only index-derived immediate-child relationships. The renderer receives
 * pages from this model, never the complete result.
 */
export function buildWorkspaceTreeIndex(
  files: readonly WorkspaceFileSummary[],
): WorkspaceTreeIndex {
  const childrenByParent = new Map<string | null, WorkspaceTreeEntry[]>();
  const foldersByPath = new Map<string, Extract<WorkspaceTreeEntry, { kind: "folder" }>>();

  for (const file of files) {
    const segments = publicPathSegments(file.path);
    if (!segments) continue;
    let parentPath: string | null = null;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const folderPath = segments.slice(0, index + 1).join("/");
      const title = segments[index];
      if (!title) continue;
      if (!foldersByPath.has(folderPath)) {
        const folder = {
          kind: "folder" as const,
          path: folderPath,
          title,
          childCount: 0,
        };
        foldersByPath.set(folderPath, folder);
        childEntries(childrenByParent, parentPath).push(folder);
      }
      parentPath = folderPath;
    }
    childEntries(childrenByParent, parentPath).push({ kind: "note", ...file });
  }

  for (const entries of childrenByParent.values()) {
    entries.sort(compareTreeEntries);
  }
  for (const folder of foldersByPath.values()) {
    folder.childCount = childrenByParent.get(folder.path)?.length ?? 0;
  }

  const entryLocations = new Map<string, TreeEntryLocation>();
  for (const [parentPath, entries] of childrenByParent) {
    for (const [offset, entry] of entries.entries()) {
      entryLocations.set(entry.path, { parentPath, offset });
    }
  }

  const pathLocations = new Map<string, WorkspaceTreePathLocation>();
  for (const file of files) {
    if (!publicPathSegments(file.path)) continue;
    const pages: TreeEntryLocation[] = [];
    let current = entryLocations.get(file.path);
    while (current) {
      pages.push(current);
      current = current.parentPath === null ? undefined : entryLocations.get(current.parentPath);
    }
    if (pages.length > 0) {
      pathLocations.set(file.path, { path: file.path, pages: pages.reverse() });
    }
  }

  return { childrenByParent, pathLocations };
}
