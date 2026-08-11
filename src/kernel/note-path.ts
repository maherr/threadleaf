import path from "node:path";

export function displayTitleFromVaultPath(filePath: string): string {
  const stem = path.posix.basename(filePath, path.posix.extname(filePath));
  const conflictMarker = ".threadleaf-conflict-";
  const conflictIndex = stem.lastIndexOf(conflictMarker);
  return conflictIndex > 0 ? `${stem.slice(0, conflictIndex)} (conflict copy)` : stem;
}
