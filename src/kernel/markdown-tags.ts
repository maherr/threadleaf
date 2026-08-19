import { isValidTagBody, tagKey } from "../shared/tags";
import {
  maskMarkdownCodeAndComments,
  type ParsedMarkdownLink,
  type ParsedMarkdownReferenceUsage,
  parseMarkdownLinks,
  parseMarkdownReferenceUsages,
} from "./markdown-links";

export {
  isValidTagBody,
  normalizeTagBody,
  tagHierarchy,
  tagKey,
} from "../shared/tags";

interface TagMaskRange {
  start: number;
  end: number;
}

export interface ParsedMarkdownTag {
  /** Source-preserved tag body without the leading hash. */
  tag: string;
  /** Case-insensitive NFC identity used by indexes and filters. */
  key: string;
  /** Source offset of the leading hash. */
  from: number;
  /** Source offset immediately after the tag body. */
  to: number;
}

const inlineTag = /(?:^|[\s(])#([\p{L}\p{M}\p{N}_/-]+)/gu;

export interface MarkdownTagProtection {
  links?: readonly ParsedMarkdownLink[];
  referenceUsages?: readonly ParsedMarkdownReferenceUsage[];
}

function protectedMarkdownRanges(
  content: string,
  maskedContent: string,
  protection: MarkdownTagProtection,
): TagMaskRange[] {
  const links = protection.links ?? parseMarkdownLinks(content, maskedContent);
  const referenceUsages =
    protection.referenceUsages ?? parseMarkdownReferenceUsages(content, maskedContent);
  const ranges: TagMaskRange[] = links.map((link) => ({
    start: link.position,
    end: link.end,
  }));
  for (const usage of referenceUsages) {
    if (usage.sourceRanges && usage.sourceRanges.length > 0) {
      ranges.push(...usage.sourceRanges);
    } else {
      ranges.push({ start: usage.position, end: usage.end });
    }
  }
  return ranges.sort((left, right) => left.start - right.start || left.end - right.end);
}

function offsetIsProtected(
  offset: number,
  ranges: readonly TagMaskRange[],
  cursor: number,
): number {
  let index = cursor;
  while (index < ranges.length && (ranges[index]?.end ?? 0) <= offset) index += 1;
  const range = ranges[index];
  return range && range.start <= offset && offset < range.end ? -(index + 1) : index;
}

export function parseInlineMarkdownTags(
  content: string,
  maskedContent = maskMarkdownCodeAndComments(content),
  protection: MarkdownTagProtection = {},
): ParsedMarkdownTag[] {
  if (maskedContent.length !== content.length) {
    throw new Error("Masked Markdown must preserve source offsets.");
  }
  const protectedRanges = protectedMarkdownRanges(content, maskedContent, protection);
  const tags: ParsedMarkdownTag[] = [];
  let rangeCursor = 0;
  for (const match of maskedContent.matchAll(inlineTag)) {
    const tag = match[1];
    if (match.index === undefined || !tag || !isValidTagBody(tag)) continue;
    const from = match.index + match[0].lastIndexOf("#");
    const protectedResult = offsetIsProtected(from, protectedRanges, rangeCursor);
    if (protectedResult < 0) {
      rangeCursor = -protectedResult - 1;
      continue;
    }
    rangeCursor = protectedResult;
    tags.push({ tag, key: tagKey(tag), from, to: from + tag.length + 1 });
  }
  return tags;
}
