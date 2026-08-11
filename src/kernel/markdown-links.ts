export interface ParsedMarkdownLink {
  target: string;
  subpath: string | null;
  alias: string | null;
  embed: boolean;
  syntax: "wiki" | "markdown";
  position: number;
  end: number;
  targetStart: number;
  targetEnd: number;
  line: number;
}

function normalizeLinkTarget(value: string): string {
  const unwrapped = value.startsWith("<") && value.endsWith(">") ? value.slice(1, -1) : value;
  try {
    return decodeURIComponent(unwrapped).replaceAll("\\", "/");
  } catch {
    return unwrapped.replaceAll("\\", "/");
  }
}

function normalizeSubpath(value: string): string | null {
  if (!value.trim()) {
    return null;
  }
  try {
    return decodeURIComponent(value).trim() || null;
  } catch {
    return value.trim() || null;
  }
}

function isExternalLink(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//");
}

function subpathOffset(value: string): number {
  const headingIndex = value.indexOf("#");
  const blockIndex = value.indexOf("^");
  const indexes = [headingIndex, blockIndex].filter((index) => index >= 0);
  return indexes.length > 0 ? Math.min(...indexes) : -1;
}

function trimmedRange(value: string): { start: number; end: number } {
  const start = value.length - value.trimStart().length;
  const end = value.trimEnd().length;
  return { start, end: Math.max(start, end) };
}

function parseLine(
  sourceLine: string,
  searchableLine: string,
  lineStart: number,
  lineNumber: number,
): ParsedMarkdownLink[] {
  const links: ParsedMarkdownLink[] = [];
  const wikiPattern = /(!)?\[\[([^\]\n]+)\]\]/g;
  for (const match of searchableLine.matchAll(wikiPattern)) {
    const localStart = match.index ?? 0;
    const full = sourceLine.slice(localStart, localStart + match[0].length);
    const embed = match[1] === "!";
    const inner = full.slice(embed ? 3 : 2, -2);
    const aliasAt = inner.indexOf("|");
    const rawTarget = aliasAt === -1 ? inner : inner.slice(0, aliasAt);
    const rawSubpathAt = subpathOffset(rawTarget);
    const rawTargetOnly = rawSubpathAt === -1 ? rawTarget : rawTarget.slice(0, rawSubpathAt);
    const targetRange = trimmedRange(rawTargetOnly);
    const position = lineStart + localStart;
    const innerStart = position + (embed ? 3 : 2);
    const target = normalizeLinkTarget(rawTargetOnly).trim();
    const subpath = normalizeSubpath(rawSubpathAt === -1 ? "" : rawTarget.slice(rawSubpathAt));
    links.push({
      target,
      subpath,
      alias: aliasAt === -1 ? null : inner.slice(aliasAt + 1).trim() || null,
      embed,
      syntax: "wiki",
      position,
      end: position + full.length,
      targetStart: innerStart + targetRange.start,
      targetEnd: innerStart + targetRange.end,
      line: lineNumber,
    });
  }

  const markdownPattern = /(!)?\[[^\]\n]*\]\(([^)\n]+)\)/g;
  for (const match of searchableLine.matchAll(markdownPattern)) {
    const localStart = match.index ?? 0;
    const full = sourceLine.slice(localStart, localStart + match[0].length);
    const destinationMarker = full.indexOf("](");
    const rawInside = destinationMarker === -1 ? "" : full.slice(destinationMarker + 2, -1);
    const leading = rawInside.length - rawInside.trimStart().length;
    const trimmed = rawInside.trim();
    const titleAt = /\s+["']/.exec(trimmed)?.index ?? -1;
    const rawDestination = titleAt === -1 ? trimmed : trimmed.slice(0, titleAt);
    const wrapped = rawDestination.startsWith("<") && rawDestination.endsWith(">");
    const destination = wrapped ? rawDestination.slice(1, -1) : rawDestination;
    const rawSubpathAt = subpathOffset(destination);
    const rawTargetOnly = rawSubpathAt === -1 ? destination : destination.slice(0, rawSubpathAt);
    const targetRange = trimmedRange(rawTargetOnly);
    const normalizedTarget = normalizeLinkTarget(rawTargetOnly).trim();
    const subpath = normalizeSubpath(rawSubpathAt === -1 ? "" : destination.slice(rawSubpathAt));
    if ((!normalizedTarget && !subpath) || isExternalLink(normalizedTarget)) {
      continue;
    }
    const position = lineStart + localStart;
    const destinationStart = position + destinationMarker + 2 + leading + (wrapped ? 1 : 0);
    links.push({
      target: normalizedTarget,
      subpath,
      alias: null,
      embed: match[1] === "!",
      syntax: "markdown",
      position,
      end: position + full.length,
      targetStart: destinationStart + targetRange.start,
      targetEnd: destinationStart + targetRange.end,
      line: lineNumber,
    });
  }
  return links;
}

function blankRange(mask: string[], start: number, end: number): void {
  for (let index = start; index < end; index += 1) {
    if (mask[index] !== "\n" && mask[index] !== "\r") {
      mask[index] = " ";
    }
  }
}

function maskFencedCode(content: string, mask: string[]): void {
  const lines = content.match(/[^\r\n]*(?:\r\n|\n|$)/g) ?? [];
  let offset = 0;
  let fence: { character: "`" | "~"; length: number } | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const full = lines[index] ?? "";
    if (full.length === 0 && index === lines.length - 1) {
      break;
    }
    const line = full.replace(/\r?\n$/, "");
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence || marker) {
      blankRange(mask, offset, offset + line.length);
    }
    if (!fence && marker) {
      fence = { character: marker[0] as "`" | "~", length: marker.length };
    } else if (
      fence &&
      marker?.[0] === fence.character &&
      marker.length >= fence.length &&
      line.slice(line.indexOf(marker) + marker.length).trim() === ""
    ) {
      fence = null;
    }
    offset += full.length;
  }
}

function maskHtmlComments(mask: string[]): void {
  const searchable = mask.join("");
  let cursor = 0;
  while (cursor < searchable.length) {
    const start = searchable.indexOf("<!--", cursor);
    if (start === -1) {
      break;
    }
    const close = searchable.indexOf("-->", start + 4);
    const end = close === -1 ? searchable.length : close + 3;
    blankRange(mask, start, end);
    cursor = end;
  }
}

function maskInlineCode(mask: string[]): void {
  const searchable = mask.join("");
  const runs = /`+/g;
  let opener = runs.exec(searchable);
  while (opener) {
    const delimiterLength = opener[0].length;
    let closer: RegExpExecArray | null = null;
    let candidate = runs.exec(searchable);
    while (candidate) {
      if (candidate[0].length === delimiterLength) {
        closer = candidate;
        break;
      }
      candidate = runs.exec(searchable);
    }
    if (!closer) {
      runs.lastIndex = (opener.index ?? 0) + delimiterLength;
    } else {
      const start = opener.index ?? 0;
      const end = (closer.index ?? start) + delimiterLength;
      blankRange(mask, start, end);
      runs.lastIndex = end;
    }
    opener = runs.exec(searchable);
  }
}

export function parseMarkdownLinks(content: string): ParsedMarkdownLink[] {
  const links: ParsedMarkdownLink[] = [];
  const mask = content.split("");
  maskFencedCode(content, mask);
  maskHtmlComments(mask);
  maskInlineCode(mask);
  const searchable = mask.join("");
  const lines = content.match(/[^\r\n]*(?:\r\n|\n|$)/g) ?? [];
  const searchableLines = searchable.match(/[^\r\n]*(?:\r\n|\n|$)/g) ?? [];
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const full = lines[index] ?? "";
    if (full.length === 0 && index === lines.length - 1) {
      break;
    }
    const sourceLine = full.replace(/\r?\n$/, "");
    const searchableLine = (searchableLines[index] ?? "").replace(/\r?\n$/, "");
    links.push(...parseLine(sourceLine, searchableLine, offset, index + 1));
    offset += full.length;
  }
  return links.sort((left, right) => left.position - right.position);
}
