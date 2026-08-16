import type { WorkspaceTreeEntry, WorkspaceTreePathLocation } from "./contracts";

export interface WorkspaceTreeIndex {
  childrenByParent: ReadonlyMap<string | null, readonly WorkspaceTreeEntry[]>;
  filePaths: ReadonlySet<string>;
  folderPaths: ReadonlySet<string>;
  pathLocations: ReadonlyMap<string, WorkspaceTreePathLocation>;
}

export interface WorkspaceVisiblePathsInput {
  files: readonly string[];
  folders: readonly string[];
}

interface TreeEntryLocation {
  parentPath: string | null;
  offset: number;
}

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

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftPoints[index]?.codePointAt(0) ?? 0;
    const rightPoint = rightPoints[index]?.codePointAt(0) ?? 0;
    if (leftPoint !== rightPoint) return leftPoint - rightPoint;
  }
  return leftPoints.length - rightPoints.length;
}

function naturalParts(value: string): string[] {
  return value.match(/[0-9]+|[^0-9]+/gu) ?? [];
}

function compareAsciiNumbers(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+(?=[0-9])/u, "");
  const normalizedRight = right.replace(/^0+(?=[0-9])/u, "");
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length - normalizedRight.length;
  }
  const valueComparison = compareCodePoints(normalizedLeft, normalizedRight);
  return valueComparison !== 0 ? valueComparison : left.length - right.length;
}

function compareNaturalCodePoints(left: string, right: string): number {
  const leftParts = naturalParts(left);
  const rightParts = naturalParts(right);
  const length = Math.min(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? "";
    const rightPart = rightParts[index] ?? "";
    const numeric = /^[0-9]+$/u.test(leftPart) && /^[0-9]+$/u.test(rightPart);
    const comparison = numeric
      ? compareAsciiNumbers(leftPart, rightPart)
      : compareCodePoints(leftPart, rightPart);
    if (comparison !== 0) return comparison;
  }
  return leftParts.length - rightParts.length;
}

function primaryVisibleKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Mark}+/gu, "")
    .toLowerCase();
}

function compareVisibleNames(left: string, right: string): number {
  const normalizedLeft = left.normalize("NFC");
  const normalizedRight = right.normalize("NFC");
  const foldedComparison = compareNaturalCodePoints(
    primaryVisibleKey(normalizedLeft),
    primaryVisibleKey(normalizedRight),
  );
  if (foldedComparison !== 0) return foldedComparison;
  const normalizedComparison = compareNaturalCodePoints(normalizedLeft, normalizedRight);
  return normalizedComparison !== 0 ? normalizedComparison : compareCodePoints(left, right);
}

export function compareWorkspaceInventoryPaths(left: string, right: string): number {
  const foldedComparison = compareNaturalCodePoints(
    primaryVisibleKey(left),
    primaryVisibleKey(right),
  );
  if (foldedComparison !== 0) return foldedComparison;
  const normalizedComparison = compareNaturalCodePoints(
    left.normalize("NFC"),
    right.normalize("NFC"),
  );
  return normalizedComparison !== 0 ? normalizedComparison : compareCodePoints(left, right);
}

function compareTreeEntries(left: WorkspaceTreeEntry, right: WorkspaceTreeEntry): number {
  const leftFolder = left.kind === "folder";
  const rightFolder = right.kind === "folder";
  if (leftFolder !== rightFolder) return leftFolder ? -1 : 1;
  const titleComparison = compareVisibleNames(left.title, right.title);
  return titleComparison !== 0
    ? titleComparison
    : compareWorkspaceInventoryPaths(left.path, right.path);
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
 * Builds immutable immediate-child relationships from one physical root census.
 * The renderer receives pages from this model, never the complete result.
 */
export function buildWorkspaceTreeIndex(input: WorkspaceVisiblePathsInput): WorkspaceTreeIndex {
  const childrenByParent = new Map<string | null, WorkspaceTreeEntry[]>();
  const foldersByPath = new Map<string, Extract<WorkspaceTreeEntry, { kind: "folder" }>>();
  const folderPaths = new Set(
    input.folders.filter((folderPath) => publicPathSegments(folderPath) !== null),
  );
  const filePaths = new Set(
    input.files.filter((filePath) => publicPathSegments(filePath) !== null),
  );

  const orderedFolders = [...folderPaths].sort((left, right) => {
    const depthComparison = left.split("/").length - right.split("/").length;
    return depthComparison !== 0 ? depthComparison : compareWorkspaceInventoryPaths(left, right);
  });
  for (const folderPath of orderedFolders) {
    const segments = publicPathSegments(folderPath);
    if (!segments) continue;
    const title = segments.at(-1);
    if (!title) continue;
    const parentPath = segments.length > 1 ? segments.slice(0, -1).join("/") : null;
    if (parentPath !== null && !folderPaths.has(parentPath)) {
      folderPaths.delete(folderPath);
      continue;
    }
    const folder = { kind: "folder" as const, path: folderPath, title, childCount: 0 };
    foldersByPath.set(folderPath, folder);
    childEntries(childrenByParent, parentPath).push(folder);
  }

  for (const filePath of [...filePaths]) {
    const segments = publicPathSegments(filePath);
    if (!segments) continue;
    const baseName = segments.at(-1);
    if (!baseName) continue;
    const parentPath = segments.length > 1 ? segments.slice(0, -1).join("/") : null;
    if (parentPath !== null && !folderPaths.has(parentPath)) {
      filePaths.delete(filePath);
      continue;
    }
    const lowerName = baseName.toLowerCase();
    const kind = lowerName.endsWith(".md")
      ? "note"
      : lowerName.endsWith(".canvas")
        ? "canvas"
        : "file";
    const title =
      kind === "note"
        ? baseName.slice(0, -3)
        : kind === "canvas"
          ? baseName.slice(0, -7)
          : baseName;
    childEntries(childrenByParent, parentPath).push({ kind, path: filePath, title });
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
  for (const filePath of filePaths) {
    const pages: TreeEntryLocation[] = [];
    let current = entryLocations.get(filePath);
    while (current) {
      pages.push(current);
      current = current.parentPath === null ? undefined : entryLocations.get(current.parentPath);
    }
    if (pages.length > 0) {
      pathLocations.set(filePath, { path: filePath, pages: pages.reverse() });
    }
  }

  return { childrenByParent, filePaths, folderPaths, pathLocations };
}
