import path from "node:path";

function encodeWikiSegment(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll("?", "%3F")
    .replaceAll("#", "%23")
    .replaceAll("^", "%5E")
    .replaceAll("|", "%7C")
    .replaceAll("[", "%5B")
    .replaceAll("]", "%5D")
    .replaceAll("\\", "%5C");
}

function encodeWikiTarget(value: string): string {
  return value.split("/").map(encodeWikiSegment).join("/");
}

function encodeMarkdownSegment(value: string): string {
  if (value === "." || value === "..") return value;
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Builds a source-note-relative destination while preserving a parsed query suffix. */
export function attachmentReferenceTarget(
  syntax: "wiki" | "markdown",
  documentPath: string,
  targetPath: string,
  suffix = "",
): string {
  const relative = path.posix.relative(path.posix.dirname(documentPath), targetPath);
  if (syntax === "wiki") return `${encodeWikiTarget(relative)}${suffix}`;
  const encoded = relative.split("/").map(encodeMarkdownSegment).join("/");
  return `${encoded.includes("/") ? encoded : `./${encoded}`}${suffix}`;
}
