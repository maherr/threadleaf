import {
  isSafeAttachmentDisplayFileName,
  MAX_VAULT_ATTACHMENT_BYTES,
} from "../shared/attachment-limits";

export interface AttachmentRestoreFileInput {
  readonly name: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface AttachmentRestoreTransferItem {
  readonly kind: string;
  webkitGetAsEntry?(): { readonly isDirectory: boolean } | null;
}

export type AttachmentRestoreTransferSelection =
  | { status: "ready"; file: AttachmentRestoreFileInput }
  | { status: "none" | "multiple" | "directory" };

export type StagedAttachmentRestoreFile =
  | { status: "ready"; sourceFileName: string; bytes: ArrayBuffer }
  | { status: "invalid-file-name" }
  | { status: "too-large"; phase: "declared" | "read"; byteLength: number }
  | { status: "unreadable" };

function fileTransferItems(
  items: ArrayLike<AttachmentRestoreTransferItem> | null | undefined,
): AttachmentRestoreTransferItem[] {
  return items ? Array.from(items).filter((item) => item.kind === "file") : [];
}

function transferItemIsDirectory(item: AttachmentRestoreTransferItem): boolean {
  try {
    return item.webkitGetAsEntry?.()?.isDirectory === true;
  } catch {
    return true;
  }
}

/** File-shaped card drags are owned here even when later validation refuses them. */
export function hasAttachmentRestoreFileTransfer(
  files: ArrayLike<AttachmentRestoreFileInput> | null | undefined,
  items: ArrayLike<AttachmentRestoreTransferItem> | null | undefined,
): boolean {
  return (files?.length ?? 0) > 0 || fileTransferItems(items).length > 0;
}

/** Drag-over cannot read file bytes, so it admits only one file-shaped, non-directory candidate. */
export function canAcceptSingleAttachmentFileDrag(
  items: ArrayLike<AttachmentRestoreTransferItem> | null | undefined,
): boolean {
  const candidates = fileTransferItems(items);
  const candidate = candidates[0];
  return candidates.length === 1 && candidate !== undefined && !transferItemIsDirectory(candidate);
}

/** Final drop/paste selection is based on the exposed File list, never a URI or string flavor. */
export function selectSingleAttachmentRestoreFile(
  files: ArrayLike<AttachmentRestoreFileInput> | null | undefined,
  items?: ArrayLike<AttachmentRestoreTransferItem> | null,
): AttachmentRestoreTransferSelection {
  const typedItems = fileTransferItems(items);
  if (typedItems.length > 1) return { status: "multiple" };
  if (typedItems.some(transferItemIsDirectory)) return { status: "directory" };
  const candidates = files ? Array.from(files) : [];
  if (candidates.length === 0) return { status: "none" };
  if (candidates.length !== 1) return { status: "multiple" };
  const file = candidates[0];
  if (!file) return { status: "none" };
  return { status: "ready", file };
}

/** Copy one bounded external File into renderer-owned bytes before opening the restore preview. */
export async function stageAttachmentRestoreFile(
  file: AttachmentRestoreFileInput,
  maxBytes = MAX_VAULT_ATTACHMENT_BYTES,
): Promise<StagedAttachmentRestoreFile> {
  if (!isSafeAttachmentDisplayFileName(file.name)) {
    return { status: "invalid-file-name" };
  }
  if (!Number.isSafeInteger(file.size) || file.size < 0) {
    return { status: "unreadable" };
  }
  const boundedMaxBytes = Math.min(maxBytes, MAX_VAULT_ATTACHMENT_BYTES);
  if (file.size > boundedMaxBytes) {
    return { status: "too-large", phase: "declared", byteLength: file.size };
  }
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    return { status: "unreadable" };
  }
  if (bytes.byteLength > boundedMaxBytes) {
    return { status: "too-large", phase: "read", byteLength: bytes.byteLength };
  }
  return { status: "ready", sourceFileName: file.name, bytes };
}
