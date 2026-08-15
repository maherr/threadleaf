import { describe, expect, it } from "vitest";
import {
  isValidTagBody,
  normalizeTagBody,
  parseInlineMarkdownTags,
  tagHierarchy,
  tagKey,
} from "./markdown-tags";

describe("Markdown tags", () => {
  it("accepts the lane grammar and rejects numeric-only or malformed bodies", () => {
    for (const tag of [
      "meeting",
      "y2026",
      "snake_case",
      "kebab-case",
      "projects/threadleaf",
      "2026/threadleaf",
      "日本語/مرحبا",
      "Cafe\u0301",
    ]) {
      expect(isValidTagBody(tag), tag).toBe(true);
    }
    for (const tag of ["", "2026", "with space", "/root", "tail/", "a//b", "emoji😀"])
      expect(isValidTagBody(tag), tag).toBe(false);

    expect(normalizeTagBody("  #Project/Threadleaf ")).toBe("Project/Threadleaf");
    expect(normalizeTagBody("#2026")).toBeNull();
    expect(tagKey("ÉTÉ/Notes")).toBe(tagKey("été/notes"));
  });

  it("derives only valid parent hierarchy rows", () => {
    expect(tagHierarchy("Project/Threadleaf/Parser")).toEqual([
      "Project",
      "Project/Threadleaf",
      "Project/Threadleaf/Parser",
    ]);
    expect(tagHierarchy("2026/Threadleaf")).toEqual(["2026/Threadleaf"]);
  });

  it("extracts source-preserved inline tags while excluding code, fences, and links", () => {
    const content = [
      "---",
      "tags: [frontmatter]",
      "---",
      "# Heading #Alpha/Child #2026 #y2026",
      "Text #snake_case and (#kebab-case).",
      "`#inline-code` and ``#other-code``",
      "[linked #not-a-tag](Target.md) and [reference #also-hidden][target]",
      "![image #hidden-too](image.png) and [[Wiki #hidden-again]]",
      "```md",
      "#fenced",
      "```",
      "[target]: Destination.md",
    ].join("\n");

    const tags = parseInlineMarkdownTags(content);
    expect(tags.map(({ tag }) => tag)).toEqual([
      "Alpha/Child",
      "y2026",
      "snake_case",
      "kebab-case",
    ]);
    for (const parsed of tags) {
      expect(content.slice(parsed.from, parsed.to)).toBe(`#${parsed.tag}`);
    }
  });

  it("consolidates only identity, never source display spelling", () => {
    const tags = parseInlineMarkdownTags("#Project #PROJECT #project/Child");
    expect(tags.map(({ tag }) => tag)).toEqual(["Project", "PROJECT", "project/Child"]);
    expect(tags[0]?.key).toBe(tags[1]?.key);
    expect(tags[2]?.key).toBe("project/child");
  });
});
