import type { WorkspaceFilePageDescriptor, WorkspaceFileSummary } from "../shared/contracts";

export interface WorkspaceFilePagesState {
  vaultId: string;
  descriptor: WorkspaceFilePageDescriptor;
  files: Array<WorkspaceFileSummary | undefined>;
  pendingOffsets: Set<number>;
}

export function reconcileWorkspaceFilePageSnapshot(
  state: WorkspaceFilePagesState | null,
  vaultId: string,
  descriptor: WorkspaceFilePageDescriptor,
  files: readonly WorkspaceFileSummary[],
): WorkspaceFilePagesState {
  const current =
    state?.vaultId === vaultId && state.descriptor.generation === descriptor.generation
      ? state
      : {
          vaultId,
          descriptor: { ...descriptor },
          files: new Array<WorkspaceFileSummary | undefined>(descriptor.total),
          pendingOffsets: new Set<number>(),
        };
  current.descriptor = { ...descriptor };
  current.files.length = descriptor.total;
  for (const [index, file] of files.entries()) {
    current.files[descriptor.offset + index] = file;
  }
  return current;
}

export function unloadedWorkspaceFilePageOffsets(
  state: WorkspaceFilePagesState,
  start: number,
  end: number,
): number[] {
  const pageSize = Math.max(1, state.descriptor.limit);
  const firstOffset = Math.floor(Math.max(0, start) / pageSize) * pageSize;
  const offsets: number[] = [];
  for (let offset = firstOffset; offset < Math.min(end, state.files.length); offset += pageSize) {
    if (!state.files[offset] && !state.pendingOffsets.has(offset)) {
      offsets.push(offset);
    }
  }
  return offsets;
}

export function applyWorkspaceFilePage(
  state: WorkspaceFilePagesState,
  descriptor: WorkspaceFilePageDescriptor,
  files: readonly WorkspaceFileSummary[],
): boolean {
  if (descriptor.generation !== state.descriptor.generation) {
    return false;
  }
  state.descriptor = { ...descriptor };
  state.files.length = descriptor.total;
  for (const [index, file] of files.entries()) {
    state.files[descriptor.offset + index] = file;
  }
  return true;
}

export function loadedWorkspaceFiles(
  state: WorkspaceFilePagesState | null,
): WorkspaceFileSummary[] {
  return (state?.files ?? []).filter((file): file is WorkspaceFileSummary => file !== undefined);
}
