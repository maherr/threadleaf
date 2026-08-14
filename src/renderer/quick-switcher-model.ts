import type { WorkspaceFileSummary } from "../shared/contracts";

export {
  filterQuickSwitcherNotes,
  maximumQuickSwitcherResults,
  type QuickSwitcherNote,
} from "../shared/quick-switcher";

import type { QuickSwitcherNote } from "../shared/quick-switcher";

export function quickSwitcherNotesFromFiles(
  files: readonly WorkspaceFileSummary[],
): QuickSwitcherNote[] {
  return files.map(({ path, title }) => ({ path, title }));
}

export function moveQuickSwitcherSelection(
  current: number,
  count: number,
  direction: 1 | -1,
): number {
  if (count === 0) {
    return -1;
  }
  const start = current < 0 ? (direction === 1 ? -1 : 0) : current;
  return (start + direction + count) % count;
}
