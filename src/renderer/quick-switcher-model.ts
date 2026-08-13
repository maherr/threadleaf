import type { WorkspaceFileSummary } from "../shared/contracts";

export interface QuickSwitcherNote {
  path: string;
  title: string;
}

interface RankedQuickSwitcherNote extends QuickSwitcherNote {
  score: number;
}

export const maximumQuickSwitcherResults = 200;

function fold(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US");
}

function scoreNote(note: QuickSwitcherNote, query: string): number | null {
  const foldedQuery = fold(query.trim());
  if (!foldedQuery) {
    return 6;
  }
  const title = fold(note.title);
  const path = fold(note.path);
  const tokens = foldedQuery.split(/\s+/u).filter(Boolean);
  if (tokens.some((token) => !title.includes(token) && !path.includes(token))) {
    return null;
  }
  if (title === foldedQuery) {
    return 0;
  }
  if (title.startsWith(foldedQuery)) {
    return 1;
  }
  if (title.split(/[^a-z0-9]+/u).some((word) => word.startsWith(foldedQuery))) {
    return 2;
  }
  if (path.startsWith(foldedQuery)) {
    return 3;
  }
  if (title.includes(foldedQuery)) {
    return 4;
  }
  return 5;
}

export function filterQuickSwitcherNotes(
  notes: readonly QuickSwitcherNote[],
  query: string,
): QuickSwitcherNote[] {
  const ranked: RankedQuickSwitcherNote[] = [];
  for (const note of notes) {
    const score = scoreNote(note, query);
    if (score !== null) {
      ranked.push({ ...note, score });
    }
  }
  return ranked
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }
      const titleOrder = fold(left.title).localeCompare(fold(right.title), "en-US");
      return titleOrder || fold(left.path).localeCompare(fold(right.path), "en-US");
    })
    .slice(0, maximumQuickSwitcherResults)
    .map(({ score: _score, ...note }) => note);
}

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
