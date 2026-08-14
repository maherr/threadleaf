export interface QuickSwitcherNote {
  path: string;
  title: string;
}

interface RankedQuickSwitcherNote<T extends QuickSwitcherNote> {
  note: T;
  score: number;
  title: string;
  path: string;
}

export const maximumQuickSwitcherResults = 200;

function fold(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US");
}

function scoreNote(
  note: QuickSwitcherNote,
  foldedQuery: string,
  tokens: readonly string[],
): number | null {
  if (!foldedQuery) {
    return 6;
  }
  const title = fold(note.title);
  const path = fold(note.path);
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

export function filterQuickSwitcherNotes<T extends QuickSwitcherNote>(
  notes: readonly T[],
  query: string,
): T[] {
  const ranked: RankedQuickSwitcherNote<T>[] = [];
  const foldedQuery = fold(query.trim());
  const tokens = foldedQuery.split(/\s+/u).filter(Boolean);
  const compare = (left: RankedQuickSwitcherNote<T>, right: RankedQuickSwitcherNote<T>): number => {
    if (left.score !== right.score) {
      return left.score - right.score;
    }
    const titleOrder = left.title.localeCompare(right.title, "en-US");
    return titleOrder || left.path.localeCompare(right.path, "en-US");
  };
  const bubbleWorstUp = (start: number): void => {
    let cursor = start;
    while (cursor > 0) {
      const parent = Math.floor((cursor - 1) / 2);
      const candidate = ranked[cursor];
      const incumbent = ranked[parent];
      if (!candidate || !incumbent || compare(candidate, incumbent) <= 0) break;
      ranked[cursor] = incumbent;
      ranked[parent] = candidate;
      cursor = parent;
    }
  };
  const sinkWorst = (): void => {
    let cursor = 0;
    while (true) {
      const left = cursor * 2 + 1;
      const right = left + 1;
      let worst = cursor;
      const leftEntry = ranked[left];
      const cursorEntry = ranked[worst];
      if (leftEntry && cursorEntry && compare(leftEntry, cursorEntry) > 0) {
        worst = left;
      }
      const rightEntry = ranked[right];
      const worstEntry = ranked[worst];
      if (rightEntry && worstEntry && compare(rightEntry, worstEntry) > 0) {
        worst = right;
      }
      if (worst === cursor) break;
      const swap = ranked[cursor];
      const replacement = ranked[worst];
      if (!swap || !replacement) break;
      ranked[cursor] = replacement;
      ranked[worst] = swap;
      cursor = worst;
    }
  };
  for (const note of notes) {
    const score = scoreNote(note, foldedQuery, tokens);
    if (score === null) continue;
    const candidate = { note, score, title: fold(note.title), path: fold(note.path) };
    if (ranked.length < maximumQuickSwitcherResults) {
      ranked.push(candidate);
      bubbleWorstUp(ranked.length - 1);
      continue;
    }
    const currentWorst = ranked[0];
    if (!currentWorst || compare(candidate, currentWorst) >= 0) continue;
    ranked[0] = candidate;
    sinkWorst();
  }
  return ranked.sort(compare).map(({ note }) => note);
}
