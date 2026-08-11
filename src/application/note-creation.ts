import { normalizeMarkdownNotePath } from "../kernel/note-path";
import type { VaultMutationPort } from "../kernel/ports";
import type { NoteCreateOutcome } from "../shared/contracts";

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function createMarkdownNote(
  vault: VaultMutationPort,
  requestedPath: string,
  content: string,
): Promise<NoteCreateOutcome> {
  const normalizedPath = normalizeMarkdownNotePath(requestedPath);
  try {
    const existing = await vault.readText(normalizedPath);
    return {
      status: "exists",
      path: normalizedPath,
      currentRevision: existing.revision,
    };
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }
  return vault.writeText(normalizedPath, content, null);
}
