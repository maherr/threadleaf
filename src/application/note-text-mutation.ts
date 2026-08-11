import { normalizeMarkdownNotePath } from "../kernel/note-path";
import type { VaultMutationPort, VaultWriteResult } from "../kernel/ports";

export type NoteTextMutationMode = "append" | "prepend";

function lineEndingFor(content: string): "\n" | "\r\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function frontmatterBodyOffset(content: string): number {
  const opening = /^\ufeff?---[\t ]*(?:\r?\n)/.exec(content);
  if (!opening) {
    return 0;
  }
  const remaining = content.slice(opening[0].length);
  const closing = /^(?:---|\.\.\.)[\t ]*(?:\r?\n|$)/m.exec(remaining);
  return closing ? opening[0].length + closing.index + closing[0].length : 0;
}

export function applyNoteTextMutation(
  currentContent: string,
  content: string,
  mode: NoteTextMutationMode,
  inline: boolean,
): string {
  const lineEnding = lineEndingFor(currentContent);
  if (mode === "append") {
    const separator = !inline && currentContent.length > 0 ? lineEnding : "";
    return `${currentContent}${separator}${content}`;
  }

  const insertionOffset = frontmatterBodyOffset(currentContent);
  const prefix = currentContent.slice(0, insertionOffset);
  const body = currentContent.slice(insertionOffset);
  const frontmatterSeparator = prefix.length > 0 && !prefix.endsWith("\n") ? lineEnding : "";
  const bodySeparator = !inline && body.length > 0 ? lineEnding : "";
  return `${prefix}${frontmatterSeparator}${content}${bodySeparator}${body}`;
}

export async function mutateMarkdownNoteText(
  vault: VaultMutationPort,
  requestedPath: string,
  content: string,
  mode: NoteTextMutationMode,
  inline: boolean,
): Promise<VaultWriteResult> {
  const normalizedPath = normalizeMarkdownNotePath(requestedPath);
  const existing = await vault.readText(normalizedPath);
  const proposedContent = applyNoteTextMutation(existing.content, content, mode, inline);
  return vault.writeText(normalizedPath, proposedContent, existing.revision);
}
