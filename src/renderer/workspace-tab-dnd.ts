export interface WorkspaceTabRect {
  index: number;
  left: number;
  right: number;
  pinned: boolean;
}

/**
 * Resolve a pointer position to an insertion index before any mutation. The
 * source tab's region is the only region considered, so a drag can never
 * silently change pin state. Empty and malformed rectangles are ignored.
 */
export function tabInsertionIndex(
  pointerX: number,
  rectangles: readonly WorkspaceTabRect[],
  sourcePinned: boolean,
): number | null {
  if (!Number.isFinite(pointerX)) {
    return null;
  }
  const region = rectangles
    .filter(
      (rect) =>
        rect.pinned === sourcePinned &&
        Number.isFinite(rect.left) &&
        Number.isFinite(rect.right) &&
        rect.right >= rect.left,
    )
    .sort((left, right) => left.index - right.index);
  if (region.length === 0) {
    return null;
  }
  for (const rect of region) {
    if (pointerX < rect.left + (rect.right - rect.left) / 2) {
      return rect.index;
    }
  }
  const last = region.at(-1);
  return last ? last.index + 1 : null;
}

export interface TabDragState {
  path: string;
  paneId: "primary" | "secondary";
  targetPaneId: "primary" | "secondary";
  sourcePinned: boolean;
  insertionIndex: number;
}

export function cancelTabDrag(): null {
  return null;
}
