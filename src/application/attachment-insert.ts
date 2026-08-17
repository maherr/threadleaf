import { createHash } from "node:crypto";
import path from "node:path";
import type { VisibleVaultPaths } from "../kernel/path-policy";
import {
  hasHiddenVaultSegment,
  hasPrivateVaultSegment,
  normalizedVaultPathIdentity,
  normalizeVaultPath,
} from "../kernel/path-policy";
import type {
  VaultAttachmentInsertBatchMutationPort,
  VaultAttachmentInsertBatchResult,
  VaultAttachmentInsertMutationPort,
  VaultAttachmentInsertResult,
  VaultReadPort,
  VaultTextSnapshot,
  VaultWriteResult,
} from "../kernel/ports";
import {
  isSafeAttachmentDisplayFileName,
  MAX_VAULT_ATTACHMENT_BATCH_BYTES,
  MAX_VAULT_ATTACHMENT_BATCH_ITEMS,
  MAX_VAULT_ATTACHMENT_BYTES,
} from "../shared/attachment-limits";
import { isSafeExternalAttachmentTarget } from "../shared/attachment-targets";
import type {
  AttachmentBatchInsertItemPreview,
  AttachmentBatchInsertOutcome,
  AttachmentBatchInsertPreview,
  AttachmentInsertOutcome,
  AttachmentInsertPreview,
  AttachmentInsertRefusalReason,
} from "../shared/contracts";
import type { WorkspaceLinkStyle } from "../shared/workspace-settings";
import { attachmentReferenceTarget } from "./attachment-reference-path";

interface AttachmentInsertVault extends VaultReadPort, VaultAttachmentInsertMutationPort {
  listVisiblePaths(relativeDirectory?: string): Promise<VisibleVaultPaths>;
}

interface AttachmentBatchInsertVault extends VaultReadPort, VaultAttachmentInsertBatchMutationPort {
  listVisiblePaths(relativeDirectory?: string): Promise<VisibleVaultPaths>;
}

export interface AttachmentInsertRequest {
  sourceNotePath: string;
  targetPath: string;
  sourceFileName: string;
  bytes: Uint8Array;
  expectedSourceRevision: string;
  selectionStart: number;
  selectionEnd: number;
  linkStyle: WorkspaceLinkStyle;
  confirmationId?: string;
}

export interface AttachmentInsertOptions {
  generation?: number;
  currentGeneration?: () => number;
  maxBytes?: number;
}

export interface AttachmentBatchInsertItemRequest {
  targetPath: string;
  sourceFileName: string;
  bytes: Uint8Array;
  selectionStart: number;
  selectionEnd: number;
}

export interface AttachmentBatchInsertRequest {
  sourceNotePath: string;
  items: readonly AttachmentBatchInsertItemRequest[];
  expectedSourceRevision: string;
  linkStyle: WorkspaceLinkStyle;
  confirmationId?: string;
}

type AttachmentInsertRefused = Extract<AttachmentInsertOutcome, { status: "refused" }>;
type AttachmentInsertConflict = Extract<AttachmentInsertOutcome, { status: "conflict-copy" }>;
type AttachmentInsertWriteConflict = Extract<VaultWriteResult, { status: "conflict" }>;

export type AttachmentInsertExecutionOutcome =
  | AttachmentInsertOutcome
  | (AttachmentInsertConflict & { writeConflict: AttachmentInsertWriteConflict });

interface AttachmentInsertPlan {
  preview: AttachmentInsertPreview;
  sourceRevision: string;
  nextSourceContent: string;
  bytes: Buffer;
  generation: number | null;
  confirmationId: string;
}

interface AttachmentBatchInsertPlan {
  preview: AttachmentBatchInsertPreview;
  sourceRevision: string;
  nextSourceContent: string;
  items: Array<{
    preview: AttachmentBatchInsertItemPreview;
    bytes: Buffer;
  }>;
  generation: number | null;
  confirmationId: string;
}

type AttachmentBatchInsertRefused = Extract<AttachmentBatchInsertOutcome, { status: "refused" }>;

function batchRefused(
  request: AttachmentBatchInsertRequest,
  reason: AttachmentBatchInsertRefused["reason"],
  message: string,
  sourceNotePath = request.sourceNotePath,
  targetPaths = request.items.map((item) => item.targetPath),
): AttachmentBatchInsertRefused {
  return {
    status: "refused",
    sourceNotePath,
    targetPaths,
    sourceFileNames: request.items.map((item) => item.sourceFileName),
    reason,
    message,
  };
}

function refused(
  request: Pick<AttachmentInsertRequest, "sourceNotePath" | "targetPath" | "sourceFileName">,
  reason: AttachmentInsertRefusalReason,
  message: string,
): AttachmentInsertRefused {
  return {
    status: "refused",
    sourceNotePath: request.sourceNotePath,
    targetPath: request.targetPath,
    sourceFileName: request.sourceFileName,
    reason,
    message,
  };
}

function externalOffsetAtEditorOffset(source: string, requestedOffset: number): number | null {
  if (!Number.isSafeInteger(requestedOffset) || requestedOffset < 0) return null;
  let externalOffset = source.startsWith("\uFEFF") ? 1 : 0;
  let editorOffset = 0;
  while (externalOffset < source.length) {
    if (editorOffset === requestedOffset) return externalOffset;
    const character = source[externalOffset];
    if (character === "\r" && source[externalOffset + 1] === "\n") {
      externalOffset += 2;
    } else {
      externalOffset += 1;
    }
    editorOffset += 1;
  }
  return editorOffset === requestedOffset ? externalOffset : null;
}

function markdownLabel(fileName: string): string {
  const extension = path.posix.extname(fileName);
  const label = extension ? fileName.slice(0, -extension.length) : fileName;
  return label.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function attachmentReference(
  style: WorkspaceLinkStyle,
  sourceNotePath: string,
  targetPath: string,
  sourceFileName: string,
): string {
  const syntax = style === "markdown" ? "markdown" : "wiki";
  const target = attachmentReferenceTarget(syntax, sourceNotePath, targetPath);
  return syntax === "wiki" ? `![[${target}]]` : `![${markdownLabel(sourceFileName)}](${target})`;
}

function confirmationIdFor(plan: Omit<AttachmentInsertPlan, "confirmationId" | "bytes">): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        preview: plan.preview,
        sourceRevision: plan.sourceRevision,
        generation: plan.generation,
      }),
      "utf8",
    )
    .digest("hex");
}

function batchConfirmationIdFor(
  plan: Omit<AttachmentBatchInsertPlan, "confirmationId" | "items"> & {
    items: AttachmentBatchInsertItemPreview[];
  },
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        preview: plan.preview,
        sourceRevision: plan.sourceRevision,
        generation: plan.generation,
      }),
      "utf8",
    )
    .digest("hex");
}

async function planAttachmentInsert(
  vault: AttachmentInsertVault,
  request: AttachmentInsertRequest,
  options: AttachmentInsertOptions,
): Promise<AttachmentInsertPlan | AttachmentInsertRefused> {
  let sourceNotePath: string;
  try {
    sourceNotePath = normalizeVaultPath(request.sourceNotePath);
  } catch {
    return refused(request, "invalid-source", "The source note path is invalid.");
  }
  const normalizedRequest = { ...request, sourceNotePath };
  if (
    !sourceNotePath.toLocaleLowerCase("en-US").endsWith(".md") ||
    hasHiddenVaultSegment(sourceNotePath) ||
    hasPrivateVaultSegment(sourceNotePath)
  ) {
    return refused(
      normalizedRequest,
      hasHiddenVaultSegment(sourceNotePath) || hasPrivateVaultSegment(sourceNotePath)
        ? "private-path"
        : "invalid-source",
      "Inserting an attachment requires a public Markdown source note.",
    );
  }
  if (!isSafeAttachmentDisplayFileName(request.sourceFileName)) {
    return refused(
      normalizedRequest,
      "invalid-file-name",
      "The selected file name is empty, unsafe, or longer than 255 UTF-8 bytes.",
    );
  }
  const maxBytes = Math.min(
    options.maxBytes ?? MAX_VAULT_ATTACHMENT_BYTES,
    MAX_VAULT_ATTACHMENT_BYTES,
  );
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || request.bytes.byteLength > maxBytes) {
    return refused(
      normalizedRequest,
      "attachment-too-large",
      `The selected file exceeds the ${MAX_VAULT_ATTACHMENT_BYTES}-byte attachment ingress limit.`,
    );
  }

  let targetPath: string;
  try {
    targetPath = normalizeVaultPath(request.targetPath);
  } catch {
    return refused(normalizedRequest, "invalid-target", "Enter a valid vault-relative file path.");
  }
  const targetRequest = { ...normalizedRequest, targetPath };
  if (hasHiddenVaultSegment(targetPath) || hasPrivateVaultSegment(targetPath)) {
    return refused(
      targetRequest,
      "private-path",
      "External attachments cannot be inserted into hidden or application-owned folders.",
    );
  }
  if (!isSafeExternalAttachmentTarget(targetPath)) {
    return refused(
      targetRequest,
      "unsupported-target",
      "Choose a supported raster image or passive attachment file name.",
    );
  }

  let source: VaultTextSnapshot;
  try {
    source = await vault.readText(sourceNotePath);
  } catch {
    return refused(targetRequest, "source-unreadable", "The source note could not be read safely.");
  }
  if (source.revision !== request.expectedSourceRevision) {
    return refused(
      targetRequest,
      "source-revision-changed",
      "The source note changed before the attachment preview was built.",
    );
  }

  const selectionStart = externalOffsetAtEditorOffset(source.content, request.selectionStart);
  const selectionEnd = externalOffsetAtEditorOffset(source.content, request.selectionEnd);
  if (
    selectionStart === null ||
    selectionEnd === null ||
    request.selectionStart > request.selectionEnd ||
    selectionStart > selectionEnd
  ) {
    return refused(
      targetRequest,
      "invalid-selection",
      "The editor selection is outside the current source note.",
    );
  }

  let listing: VisibleVaultPaths;
  try {
    listing = await vault.listVisiblePaths("");
  } catch {
    return refused(
      targetRequest,
      "attachment-publish-unavailable",
      "The visible vault namespace could not be checked safely.",
    );
  }
  const targetIdentity = normalizedVaultPathIdentity(targetPath);
  if (
    [...listing.files, ...listing.folders].some(
      (candidate) => normalizedVaultPathIdentity(candidate) === targetIdentity,
    )
  ) {
    return refused(
      targetRequest,
      "target-exists",
      "That attachment path, or a case-equivalent name, already exists.",
    );
  }
  const parent = path.posix.dirname(targetPath);
  const parentDirectory = parent === "." ? "" : parent;
  let parentListing: VisibleVaultPaths;
  try {
    parentListing = await vault.listVisiblePaths(parentDirectory);
  } catch {
    return refused(
      targetRequest,
      "target-parent-missing",
      "The target folder could not be verified safely.",
    );
  }
  if (!parentListing.exists) {
    return refused(
      targetRequest,
      "target-parent-missing",
      "Choose an existing visible vault folder. This operation does not create folders.",
    );
  }

  const referenceText = attachmentReference(
    request.linkStyle,
    sourceNotePath,
    targetPath,
    request.sourceFileName,
  );
  const nextSourceContent = `${source.content.slice(0, selectionStart)}${referenceText}${source.content.slice(selectionEnd)}`;
  const bytes = Buffer.from(request.bytes);
  const generation = options.generation ?? options.currentGeneration?.() ?? null;
  const preview: AttachmentInsertPreview = {
    sourceNotePath,
    targetPath,
    sourceFileName: request.sourceFileName,
    byteLength: bytes.byteLength,
    contentRevision: createHash("sha256").update(bytes).digest("hex"),
    proposedNoteRevision: createHash("sha256").update(nextSourceContent, "utf8").digest("hex"),
    referenceText,
    selectionStart: request.selectionStart,
    selectionEnd: request.selectionEnd,
    selectionAfter: request.selectionStart + referenceText.length,
  };
  const planWithoutId = {
    preview,
    sourceRevision: source.revision,
    nextSourceContent,
    generation,
  } satisfies Omit<AttachmentInsertPlan, "confirmationId" | "bytes">;
  return {
    ...planWithoutId,
    bytes,
    confirmationId: confirmationIdFor(planWithoutId),
  };
}

async function planAttachmentBatchInsert(
  vault: AttachmentBatchInsertVault,
  request: AttachmentBatchInsertRequest,
  options: AttachmentInsertOptions,
): Promise<AttachmentBatchInsertPlan | AttachmentBatchInsertRefused> {
  let sourceNotePath: string;
  try {
    sourceNotePath = normalizeVaultPath(request.sourceNotePath);
  } catch {
    return batchRefused(request, "invalid-source", "The source note path is invalid.");
  }
  const normalizedRequest = { ...request, sourceNotePath };
  if (
    !sourceNotePath.toLocaleLowerCase("en-US").endsWith(".md") ||
    hasHiddenVaultSegment(sourceNotePath) ||
    hasPrivateVaultSegment(sourceNotePath)
  ) {
    return batchRefused(
      normalizedRequest,
      hasHiddenVaultSegment(sourceNotePath) || hasPrivateVaultSegment(sourceNotePath)
        ? "private-path"
        : "invalid-source",
      "Inserting attachments requires a public Markdown source note.",
      sourceNotePath,
    );
  }
  if (request.items.length === 0) {
    return batchRefused(
      normalizedRequest,
      "batch-empty",
      "Choose at least one external attachment.",
      sourceNotePath,
      [],
    );
  }
  if (request.items.length > MAX_VAULT_ATTACHMENT_BATCH_ITEMS) {
    return batchRefused(
      normalizedRequest,
      "batch-too-large",
      `Choose at most ${MAX_VAULT_ATTACHMENT_BATCH_ITEMS} attachments per insertion.`,
      sourceNotePath,
    );
  }

  const maxBytes = Math.min(
    options.maxBytes ?? MAX_VAULT_ATTACHMENT_BYTES,
    MAX_VAULT_ATTACHMENT_BYTES,
  );
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    return batchRefused(
      normalizedRequest,
      "batch-too-large",
      "The attachment size limit is invalid.",
      sourceNotePath,
    );
  }
  let totalByteLength = 0;
  const normalizedItems: Array<AttachmentBatchInsertItemRequest & { targetPath: string }> = [];
  const targetIdentities = new Set<string>();
  let targetDirectory: string | null = null;
  for (const item of request.items) {
    if (!isSafeAttachmentDisplayFileName(item.sourceFileName)) {
      return batchRefused(
        normalizedRequest,
        "invalid-file-name",
        "One selected file name is empty, unsafe, or longer than 255 UTF-8 bytes.",
        sourceNotePath,
      );
    }
    if (!Number.isSafeInteger(item.bytes.byteLength) || item.bytes.byteLength > maxBytes) {
      return batchRefused(
        normalizedRequest,
        "attachment-too-large",
        `Each selected file must be at most ${MAX_VAULT_ATTACHMENT_BYTES} bytes.`,
        sourceNotePath,
      );
    }
    totalByteLength += item.bytes.byteLength;
    if (totalByteLength > MAX_VAULT_ATTACHMENT_BATCH_BYTES) {
      return batchRefused(
        normalizedRequest,
        "batch-too-large",
        `The selected attachments exceed the ${MAX_VAULT_ATTACHMENT_BATCH_BYTES}-byte batch limit.`,
        sourceNotePath,
      );
    }
    let targetPath: string;
    try {
      targetPath = normalizeVaultPath(item.targetPath);
    } catch {
      return batchRefused(
        normalizedRequest,
        "invalid-target",
        "One attachment target is not a valid vault-relative path.",
        sourceNotePath,
      );
    }
    if (hasHiddenVaultSegment(targetPath) || hasPrivateVaultSegment(targetPath)) {
      return batchRefused(
        normalizedRequest,
        "private-path",
        "External attachments cannot be inserted into hidden or application-owned folders.",
        sourceNotePath,
      );
    }
    if (!isSafeExternalAttachmentTarget(targetPath)) {
      return batchRefused(
        normalizedRequest,
        "unsupported-target",
        "Choose supported raster images or passive attachment file names.",
        sourceNotePath,
      );
    }
    const nextDirectory = path.posix.dirname(targetPath);
    if (targetDirectory === null) targetDirectory = nextDirectory;
    if (targetDirectory !== nextDirectory) {
      return batchRefused(
        normalizedRequest,
        "target-directory-mismatch",
        "All attachments in one insertion must use the same existing destination folder.",
        sourceNotePath,
      );
    }
    const targetIdentity = normalizedVaultPathIdentity(targetPath);
    if (targetIdentities.has(targetIdentity)) {
      return batchRefused(
        normalizedRequest,
        "target-exists",
        "The batch contains two attachment paths that collide by case or Unicode normalization.",
        sourceNotePath,
      );
    }
    targetIdentities.add(targetIdentity);
    normalizedItems.push({ ...item, targetPath });
  }

  let source: VaultTextSnapshot;
  try {
    source = await vault.readText(sourceNotePath);
  } catch {
    return batchRefused(
      normalizedRequest,
      "source-unreadable",
      "The source note could not be read safely.",
      sourceNotePath,
    );
  }
  if (source.revision !== request.expectedSourceRevision) {
    return batchRefused(
      normalizedRequest,
      "source-revision-changed",
      "The source note changed before the attachment preview was built.",
      sourceNotePath,
    );
  }

  const parts: string[] = [];
  const plannedItems: AttachmentBatchInsertPlan["items"] = [];
  let externalCursor = 0;
  let previousSelectionEnd = 0;
  let cumulativeDelta = 0;
  for (const item of normalizedItems) {
    const selectionStart = externalOffsetAtEditorOffset(source.content, item.selectionStart);
    const selectionEnd = externalOffsetAtEditorOffset(source.content, item.selectionEnd);
    if (
      selectionStart === null ||
      selectionEnd === null ||
      item.selectionStart > item.selectionEnd ||
      item.selectionStart < previousSelectionEnd ||
      selectionStart < externalCursor ||
      selectionStart > selectionEnd
    ) {
      return batchRefused(
        normalizedRequest,
        item.selectionStart < previousSelectionEnd ? "selection-order" : "invalid-selection",
        "Attachment selections must be valid, ordered, and non-overlapping in the source note.",
        sourceNotePath,
      );
    }
    const referenceText = attachmentReference(
      request.linkStyle,
      sourceNotePath,
      item.targetPath,
      item.sourceFileName,
    );
    parts.push(source.content.slice(externalCursor, selectionStart));
    parts.push(referenceText);
    externalCursor = selectionEnd;
    previousSelectionEnd = item.selectionEnd;
    cumulativeDelta += referenceText.length - (item.selectionEnd - item.selectionStart);
    plannedItems.push({
      preview: {
        sourceFileName: item.sourceFileName,
        targetPath: item.targetPath,
        byteLength: item.bytes.byteLength,
        contentRevision: createHash("sha256").update(item.bytes).digest("hex"),
        referenceText,
        selectionStart: item.selectionStart,
        selectionEnd: item.selectionEnd,
        selectionAfter: item.selectionStart + cumulativeDelta,
      },
      bytes: Buffer.from(item.bytes),
    });
  }
  parts.push(source.content.slice(externalCursor));
  const nextSourceContent = parts.join("");
  const normalizedTargetPaths = normalizedItems.map((item) => item.targetPath);
  let listing: VisibleVaultPaths;
  try {
    listing = await vault.listVisiblePaths("");
  } catch {
    return batchRefused(
      normalizedRequest,
      "attachment-publish-unavailable",
      "The visible vault namespace could not be checked safely.",
      sourceNotePath,
      normalizedTargetPaths,
    );
  }
  if (
    [...listing.files, ...listing.folders].some((candidate) =>
      targetIdentities.has(normalizedVaultPathIdentity(candidate)),
    )
  ) {
    return batchRefused(
      normalizedRequest,
      "target-exists",
      "One attachment path, or a case-equivalent name, already exists.",
      sourceNotePath,
      normalizedTargetPaths,
    );
  }
  const parent = targetDirectory === "." ? "" : (targetDirectory ?? "");
  let parentListing: VisibleVaultPaths;
  try {
    parentListing = await vault.listVisiblePaths(parent);
  } catch {
    return batchRefused(
      normalizedRequest,
      "target-parent-missing",
      "The common destination folder could not be verified safely.",
      sourceNotePath,
      normalizedTargetPaths,
    );
  }
  if (!parentListing.exists) {
    return batchRefused(
      normalizedRequest,
      "target-parent-missing",
      "Choose an existing visible vault folder. This operation does not create folders.",
      sourceNotePath,
      normalizedTargetPaths,
    );
  }

  const generation = options.generation ?? options.currentGeneration?.() ?? null;
  const preview: AttachmentBatchInsertPreview = {
    sourceNotePath,
    targetDirectory: parent,
    totalByteLength,
    proposedNoteRevision: createHash("sha256").update(nextSourceContent, "utf8").digest("hex"),
    items: plannedItems.map((item) => item.preview),
    selectionAfter: plannedItems.at(-1)?.preview.selectionAfter ?? 0,
  };
  const planWithoutId = {
    preview,
    sourceRevision: source.revision,
    nextSourceContent,
    generation,
    items: plannedItems.map((item) => item.preview),
  };
  return {
    preview,
    sourceRevision: source.revision,
    nextSourceContent,
    items: plannedItems,
    generation,
    confirmationId: batchConfirmationIdFor(planWithoutId),
  };
}

function kernelBatchRefusal(
  request: AttachmentBatchInsertRequest,
  result: Extract<VaultAttachmentInsertBatchResult, { status: "refused" }>,
): AttachmentBatchInsertRefused {
  if (result.reason === "source-note-changed") {
    return batchRefused(
      request,
      "source-revision-changed",
      "The source note changed before any attachment bytes were published.",
    );
  }
  if (result.reason === "source-write-unavailable") {
    return batchRefused(
      request,
      "source-write-unavailable",
      "The source note is readable but is not safely writable.",
    );
  }
  if (result.reason === "target-present" || result.reason === "target-normalized-exists") {
    return batchRefused(
      request,
      "target-exists",
      "An attachment path was claimed before publication, so nothing was overwritten.",
    );
  }
  return batchRefused(
    request,
    "attachment-publish-unavailable",
    "The attachment batch could not be published through the contained no-overwrite path.",
  );
}

export async function insertExternalAttachments(
  vault: AttachmentBatchInsertVault,
  request: AttachmentBatchInsertRequest,
  options: AttachmentInsertOptions = {},
): Promise<AttachmentBatchInsertOutcome> {
  const plan = await planAttachmentBatchInsert(vault, request, options);
  if ("status" in plan) return plan;
  if (request.confirmationId !== plan.confirmationId) {
    return {
      status: "requires-confirmation",
      preview: plan.preview,
      confirmationId: plan.confirmationId,
    };
  }
  if (options.currentGeneration && options.currentGeneration() !== plan.generation) {
    return batchRefused(
      request,
      "workspace-changed",
      "The visible vault changed after the attachment insertion preview.",
    );
  }

  const result = await vault.insertAttachmentsWithReference({
    sourceNotePath: plan.preview.sourceNotePath,
    sourceNoteRevision: plan.sourceRevision,
    nextSourceContent: plan.nextSourceContent,
    items: plan.items.map((item) => ({
      targetPath: item.preview.targetPath,
      attachmentBytes: item.bytes,
    })),
  });
  if (result.status === "refused") return kernelBatchRefusal(request, result);
  if (result.status === "manual-conflict") {
    return {
      ...result,
      message: `Threadleaf published or observed part of the attachment batch, but the compound note-and-bytes receipt was uncertain (${result.reason}). It preserved private recovery evidence for manual review.`,
    };
  }
  if (result.status === "conflict") {
    return {
      status: "conflict-copy",
      path: result.path,
      currentRevision: result.currentRevision,
      conflictPath: result.conflictPath,
      attachments: result.attachments,
      transactionId: result.transactionId,
      preview: plan.preview,
      message: `The source note changed after the attachment batch was published. Threadleaf kept the current note untouched and preserved the complete insertion at ${result.conflictPath}.`,
    };
  }
  return { ...result, preview: plan.preview };
}

function kernelRefusal(
  request: AttachmentInsertRequest,
  result: Extract<VaultAttachmentInsertResult, { status: "refused" }>,
): AttachmentInsertRefused {
  if (result.reason === "source-note-changed") {
    return refused(
      request,
      "source-revision-changed",
      "The source note changed before any attachment bytes were published.",
    );
  }
  if (result.reason === "source-write-unavailable") {
    return refused(
      request,
      "source-write-unavailable",
      "The source note is readable but is not a safely writable vault file.",
    );
  }
  if (result.reason === "target-present" || result.reason === "target-normalized-exists") {
    return refused(
      request,
      "target-exists",
      "The target attachment path was claimed before publication, so nothing was overwritten.",
    );
  }
  return refused(
    request,
    "attachment-publish-unavailable",
    "The attachment could not be published through the contained no-overwrite path.",
  );
}

export async function insertExternalAttachment(
  vault: AttachmentInsertVault,
  request: AttachmentInsertRequest,
  options: AttachmentInsertOptions = {},
): Promise<AttachmentInsertExecutionOutcome> {
  const plan = await planAttachmentInsert(vault, request, options);
  if ("status" in plan) return plan;
  if (request.confirmationId !== plan.confirmationId) {
    return {
      status: "requires-confirmation",
      preview: plan.preview,
      confirmationId: plan.confirmationId,
    };
  }
  if (options.currentGeneration && options.currentGeneration() !== plan.generation) {
    return refused(
      request,
      "workspace-changed",
      "The visible vault changed after the attachment insertion preview.",
    );
  }

  const result = await vault.insertAttachmentWithReference({
    sourceNotePath: plan.preview.sourceNotePath,
    sourceNoteRevision: plan.sourceRevision,
    nextSourceContent: plan.nextSourceContent,
    targetPath: plan.preview.targetPath,
    attachmentBytes: plan.bytes,
  });
  if (result.status === "refused") return kernelRefusal(request, result);
  if (result.status === "manual-conflict") {
    return {
      ...result,
      message: `Threadleaf published or observed attachment state at ${result.attachmentPath}, but the compound note-and-byte receipt was uncertain (${result.reason}). It preserved private recovery evidence for manual review.`,
    };
  }
  if (result.status === "conflict") {
    const writeConflict: AttachmentInsertWriteConflict = {
      status: "conflict",
      path: result.path,
      currentRevision: result.currentRevision,
      conflictPath: result.conflictPath,
      transactionId: result.transactionId,
    };
    return {
      status: "conflict-copy",
      path: result.path,
      currentRevision: result.currentRevision,
      conflictPath: result.conflictPath,
      attachmentPath: result.attachmentPath,
      attachmentRevision: result.attachmentRevision,
      transactionId: result.transactionId,
      preview: plan.preview,
      message: `The source note changed after ${result.attachmentPath} was published. Threadleaf kept the current note untouched and preserved the complete insertion at ${result.conflictPath}.`,
      writeConflict,
    };
  }
  return { ...result, preview: plan.preview };
}
