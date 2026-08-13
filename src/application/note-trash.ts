import { normalizeMarkdownNotePath } from "../kernel/note-path";
import type { VaultMutationPort, VaultReadPort, VaultRenameResult } from "../kernel/ports";

export const vaultTrashDirectory = ".trash";

export interface TrashedMarkdownNote {
  path: string;
  trashPath: string;
  revision: string;
  size: number;
}

export interface TrashedMarkdownNoteList {
  total: number;
  entries: TrashedMarkdownNote[];
}

interface TrashLocation {
  path: string;
  trashPath: string;
}

function trashLocationForOriginalPath(requestedPath: string): TrashLocation {
  const originalPath = normalizeMarkdownNotePath(requestedPath);
  return {
    path: originalPath,
    trashPath: `${vaultTrashDirectory}/${originalPath}`,
  };
}

function trashLocationForReference(requestedPath: string): TrashLocation {
  const portable = requestedPath.trim().replaceAll("\\", "/");
  const prefix = `${vaultTrashDirectory}/`;
  if (portable.toLocaleLowerCase("en-US").startsWith(prefix)) {
    return trashLocationForOriginalPath(portable.slice(prefix.length));
  }
  return trashLocationForOriginalPath(portable);
}

export async function listTrashedMarkdownNotes(
  vault: VaultReadPort,
  limit = Number.POSITIVE_INFINITY,
): Promise<TrashedMarkdownNoteList> {
  const prefix = `${vaultTrashDirectory}/`;
  const trashPaths = (await vault.listMarkdownPaths(vaultTrashDirectory)).filter((filePath) =>
    filePath.startsWith(prefix),
  );
  const selectedPaths = trashPaths.slice(0, Math.max(0, Math.floor(limit)));
  const entries = await Promise.all(
    selectedPaths.map(async (trashPath) => {
      const snapshot = await vault.readText(trashPath);
      return {
        path: trashPath.slice(prefix.length),
        trashPath,
        revision: snapshot.revision,
        size: snapshot.size,
      };
    }),
  );
  return { total: trashPaths.length, entries };
}

export async function trashMarkdownNote(
  vault: VaultMutationPort,
  requestedPath: string,
  expectedSourceRevision?: string,
): Promise<VaultRenameResult> {
  const location = trashLocationForOriginalPath(requestedPath);
  const paths = await vault.listMarkdownPaths();
  if (!paths.includes(location.path)) {
    throw new Error(`Markdown note is not indexed in this vault: ${location.path}`);
  }
  const source = await vault.readText(location.path);
  if (expectedSourceRevision && source.revision !== expectedSourceRevision) {
    return {
      status: "conflict",
      from: location.path,
      to: location.trashPath,
      reason: "source-revision-changed",
    };
  }
  return vault.renameFile(location.path, location.trashPath, source.revision);
}

export async function restoreTrashedMarkdownNote(
  vault: VaultMutationPort,
  requestedPath: string,
  expectedSourceRevision?: string,
): Promise<VaultRenameResult> {
  const location = trashLocationForReference(requestedPath);
  const trashPaths = await vault.listMarkdownPaths(vaultTrashDirectory);
  if (!trashPaths.includes(location.trashPath)) {
    throw new Error(`Recoverable trash entry does not exist: ${location.trashPath}`);
  }
  const source = await vault.readText(location.trashPath);
  if (expectedSourceRevision && source.revision !== expectedSourceRevision) {
    return {
      status: "conflict",
      from: location.trashPath,
      to: location.path,
      reason: "source-revision-changed",
    };
  }
  return vault.renameFile(location.trashPath, location.path, source.revision);
}
