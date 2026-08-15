const tagBodyCharacters = /^[\p{L}\p{M}\p{N}_/-]+$/u;
const tagBodyNonNumeric = /[\p{L}\p{M}_/-]/u;

export function tagKey(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

export function isValidTagBody(value: string): boolean {
  if (!tagBodyCharacters.test(value) || !tagBodyNonNumeric.test(value)) {
    return false;
  }
  return value.split("/").every((segment) => segment.length > 0);
}

export function normalizeTagBody(value: string): string | null {
  const normalized = value.trim().replace(/^#+/u, "");
  return isValidTagBody(normalized) ? normalized : null;
}

/**
 * Returns valid hierarchy rows from the first segment through the complete tag.
 * Numeric-only synthetic parents stay absent because they are not valid tags.
 */
export function tagHierarchy(value: string): string[] {
  const segments = value.split("/");
  const hierarchy: string[] = [];
  for (let length = 1; length <= segments.length; length += 1) {
    const candidate = segments.slice(0, length).join("/");
    if (isValidTagBody(candidate)) hierarchy.push(candidate);
  }
  return hierarchy;
}
