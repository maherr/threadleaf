export interface PaletteCommandDescriptor {
  id: string;
  label: string;
  category: string;
  keywords: readonly string[];
  shortcut: string | null;
  enabled: boolean;
  disabledReason: string | null;
}

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .trim();
}

function matchScore(command: PaletteCommandDescriptor, query: string): number | null {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) {
    return 0;
  }
  const label = normalize(command.label);
  const id = normalize(command.id);
  const category = normalize(command.category);
  const keywords = command.keywords.map(normalize);
  const haystack = [label, id, category, ...keywords].join(" ");
  const tokens = normalizedQuery.split(/\s+/);
  if (!tokens.every((token) => haystack.includes(token))) {
    return null;
  }
  if (label === normalizedQuery) {
    return 0;
  }
  if (label.startsWith(normalizedQuery)) {
    return 1;
  }
  if (label.split(/\s+/).some((word) => word.startsWith(normalizedQuery))) {
    return 2;
  }
  if (
    id.startsWith(normalizedQuery) ||
    keywords.some((keyword) => keyword.startsWith(normalizedQuery))
  ) {
    return 3;
  }
  return 4;
}

export function filterPaletteCommands<T extends PaletteCommandDescriptor>(
  commands: readonly T[],
  query: string,
): T[] {
  return commands
    .map((command, index) => ({ command, index, score: matchScore(command, query) }))
    .filter(
      (candidate): candidate is { command: T; index: number; score: number } =>
        candidate.score !== null,
    )
    .sort(
      (left, right) =>
        left.score - right.score ||
        Number(right.command.enabled) - Number(left.command.enabled) ||
        left.index - right.index,
    )
    .map(({ command }) => command);
}

export function firstEnabledPaletteIndex(commands: readonly PaletteCommandDescriptor[]): number {
  return commands.findIndex((command) => command.enabled);
}

export function movePaletteSelection(
  commands: readonly PaletteCommandDescriptor[],
  currentIndex: number,
  direction: -1 | 1,
): number {
  if (commands.length === 0 || !commands.some((command) => command.enabled)) {
    return -1;
  }
  let index = currentIndex;
  for (let visited = 0; visited < commands.length; visited += 1) {
    index = (index + direction + commands.length) % commands.length;
    if (commands[index]?.enabled) {
      return index;
    }
  }
  return -1;
}
