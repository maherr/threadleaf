import path from "node:path";
import { normalizeVaultPath } from "./path-policy";

const maxNotePathLength = 4_096;

export function normalizeMarkdownNotePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > maxNotePathLength) {
    throw new Error("Note paths must contain between 1 and 4096 characters.");
  }
  if (trimmed.endsWith("/") || trimmed.endsWith("\\")) {
    throw new Error("A note path must name a file, not only a folder.");
  }
  const withExtension = trimmed.toLocaleLowerCase("en-US").endsWith(".md")
    ? trimmed
    : `${trimmed}.md`;
  const normalized = normalizeVaultPath(withExtension);
  if (normalized.length > maxNotePathLength) {
    throw new Error("Normalized note paths may contain at most 4096 characters.");
  }
  const privateSegment = normalized.split("/").find((segment) => {
    const folded = segment.toLocaleLowerCase("en-US");
    return (
      folded === ".obsidian" ||
      folded === ".git" ||
      folded === ".trash" ||
      folded.startsWith(".threadleaf-")
    );
  });
  if (privateSegment) {
    throw new Error(
      `Markdown notes cannot be created in private application paths: ${privateSegment}`,
    );
  }
  return normalized;
}

export function displayTitleFromVaultPath(filePath: string): string {
  const stem = path.posix.basename(filePath, path.posix.extname(filePath));
  const conflictMarker = ".threadleaf-conflict-";
  const conflictIndex = stem.lastIndexOf(conflictMarker);
  return conflictIndex > 0 ? `${stem.slice(0, conflictIndex)} (conflict copy)` : stem;
}
