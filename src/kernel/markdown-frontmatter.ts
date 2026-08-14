/**
 * Frontmatter is source-only in renderer and mutation planning. The bounded
 * scan prevents an unterminated opener from turning an arbitrarily large note
 * into parser work.
 */
export const maxFrontmatterScanLines = 256;

export interface FrontmatterScan {
  status: "none" | "resolved" | "unresolved";
  openingLine: number | null;
  closingLine: number | null;
}

/**
 * Scans the same physical-line grammar used by both Markdown renderers.
 * Delimiter text is JavaScript-trimmed, including a leading BOM on line one.
 */
export function scanFrontmatter(source: string): FrontmatterScan {
  const firstBreak = source.search(/[\r\n]/u);
  const first = source
    .slice(0, firstBreak < 0 ? source.length : firstBreak)
    .replace(/^\uFEFF/u, "")
    .trim();
  if (first !== "---") {
    return { status: "none", openingLine: null, closingLine: null };
  }
  let lineNumber = 1;
  let offset = firstBreak < 0 ? source.length : firstBreak;
  if (source[offset] === "\r" && source[offset + 1] === "\n") offset += 2;
  else if (offset < source.length) offset += 1;
  while (lineNumber < maxFrontmatterScanLines && offset <= source.length) {
    const breakOffset = source.slice(offset).search(/[\r\n]/u);
    const lineEnd = breakOffset < 0 ? source.length : offset + breakOffset;
    const line = source.slice(offset, lineEnd).trim();
    if (line === "---" || line === "...") {
      return { status: "resolved", openingLine: 1, closingLine: lineNumber + 1 };
    }
    if (breakOffset < 0) break;
    offset = lineEnd + 1;
    if (source[lineEnd] === "\r" && source[lineEnd + 1] === "\n") offset += 1;
    lineNumber += 1;
  }
  return { status: "unresolved", openingLine: 1, closingLine: null };
}
