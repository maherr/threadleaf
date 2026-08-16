import { createHash } from "node:crypto";
import {
  maskMarkdownCodeAndComments,
  parseMarkdownDestinationTarget,
  parseMarkdownLinks,
} from "../kernel/markdown-links";
import { VaultLinkResolver } from "../kernel/metadata-index";
import type { VisibleVaultPaths } from "../kernel/path-policy";
import {
  hasHiddenVaultSegment,
  hasPrivateVaultSegment,
  normalizedVaultPathIdentity,
  normalizeVaultPath,
} from "../kernel/path-policy";
import type {
  VaultAttachmentIngressMutationPort,
  VaultReadPort,
  VaultTextSnapshot,
} from "../kernel/ports";
import {
  isSafeAttachmentDisplayFileName,
  MAX_VAULT_ATTACHMENT_BYTES,
} from "../shared/attachment-limits";
import { isPassiveAttachmentTarget } from "../shared/attachment-targets";
import type {
  AttachmentRestoreOutcome,
  AttachmentRestorePreview,
  AttachmentRestoreRefusalReason,
} from "../shared/contracts";
import { parseVaultAttachmentTarget } from "./vault-attachment-service";

interface AttachmentRestoreVault extends VaultReadPort, VaultAttachmentIngressMutationPort {
  listVisiblePaths(relativeDirectory?: string): Promise<VisibleVaultPaths>;
}

export interface AttachmentRestoreRequest {
  sourceNotePath: string;
  missingTarget: string;
  sourceFileName: string;
  bytes: Uint8Array;
  expectedSourceRevision: string;
  confirmationId?: string;
}

export interface AttachmentRestoreOptions {
  generation?: number;
  currentGeneration?: () => number;
  maxBytes?: number;
}

interface AttachmentRestorePlan {
  preview: AttachmentRestorePreview;
  sourceRevision: string;
  missingResolverTarget: string;
  bytes: Buffer;
  generation: number | null;
  confirmationId: string;
}

type AttachmentRestoreRefused = Extract<AttachmentRestoreOutcome, { status: "refused" }>;

function refused(
  request: Pick<AttachmentRestoreRequest, "sourceNotePath" | "sourceFileName">,
  missingPath: string,
  reason: AttachmentRestoreRefusalReason,
  message: string,
): AttachmentRestoreRefused {
  return {
    status: "refused",
    sourceNotePath: request.sourceNotePath,
    missingPath,
    sourceFileName: request.sourceFileName,
    reason,
    message,
  };
}

function passiveVisibleFiles(listing: VisibleVaultPaths): string[] {
  return listing.files.filter(
    (filePath) =>
      !hasHiddenVaultSegment(filePath) &&
      !hasPrivateVaultSegment(filePath) &&
      !filePath.toLocaleLowerCase("en-US").endsWith(".md"),
  );
}

function matchingMissingReferenceCount(source: VaultTextSnapshot, missingPath: string): number {
  return parseMarkdownLinks(source.content, maskMarkdownCodeAndComments(source.content)).filter(
    (link) => {
      if (!link.embed || link.sourceKind === "markdown-reference-definition") return false;
      const rawTarget = source.content.slice(link.targetStart, link.targetEnd);
      const parsed = parseVaultAttachmentTarget(source.path, rawTarget);
      return (
        parsed.status === "local" &&
        isPassiveAttachmentTarget(parsed.path) &&
        normalizedVaultPathIdentity(parsed.path) === normalizedVaultPathIdentity(missingPath)
      );
    },
  ).length;
}

function confirmationIdFor(plan: Omit<AttachmentRestorePlan, "confirmationId" | "bytes">): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        preview: plan.preview,
        sourceRevision: plan.sourceRevision,
        missingResolverTarget: plan.missingResolverTarget,
        generation: plan.generation,
      }),
      "utf8",
    )
    .digest("hex");
}

async function planAttachmentRestore(
  vault: AttachmentRestoreVault,
  request: AttachmentRestoreRequest,
  options: AttachmentRestoreOptions,
): Promise<AttachmentRestorePlan | AttachmentRestoreRefused> {
  let sourceNotePath: string;
  try {
    sourceNotePath = normalizeVaultPath(request.sourceNotePath);
  } catch {
    return refused(
      request,
      request.missingTarget,
      "invalid-source",
      "The source note path is invalid.",
    );
  }
  if (
    !sourceNotePath.toLocaleLowerCase("en-US").endsWith(".md") ||
    hasHiddenVaultSegment(sourceNotePath) ||
    hasPrivateVaultSegment(sourceNotePath)
  ) {
    return refused(
      { ...request, sourceNotePath },
      request.missingTarget,
      hasHiddenVaultSegment(sourceNotePath) || hasPrivateVaultSegment(sourceNotePath)
        ? "private-path"
        : "invalid-source",
      "Restoring an attachment requires a public Markdown source note.",
    );
  }
  const normalizedRequest = { ...request, sourceNotePath };
  if (!isSafeAttachmentDisplayFileName(request.sourceFileName)) {
    return refused(
      normalizedRequest,
      request.missingTarget,
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
      request.missingTarget,
      "attachment-too-large",
      `The selected file exceeds the ${MAX_VAULT_ATTACHMENT_BYTES}-byte attachment ingress limit.`,
    );
  }

  const parsedMissing = parseVaultAttachmentTarget(sourceNotePath, request.missingTarget);
  if (parsedMissing.status !== "local" || !isPassiveAttachmentTarget(parsedMissing.path)) {
    return refused(
      normalizedRequest,
      parsedMissing.status === "local" ? parsedMissing.path : request.missingTarget,
      parsedMissing.status === "rejected" && parsedMissing.reason === "private"
        ? "private-path"
        : "invalid-missing-target",
      "The missing target is not a safe passive attachment reference.",
    );
  }
  const missingPath = parsedMissing.path;

  let source: VaultTextSnapshot;
  try {
    source = await vault.readText(sourceNotePath);
  } catch {
    return refused(
      normalizedRequest,
      missingPath,
      "source-unreadable",
      "The source note could not be read safely.",
    );
  }
  if (source.revision !== request.expectedSourceRevision) {
    return refused(
      normalizedRequest,
      missingPath,
      "source-revision-changed",
      "The source note changed before the restore preview was built.",
    );
  }

  let listing: VisibleVaultPaths;
  try {
    listing = await vault.listVisiblePaths("");
  } catch {
    return refused(
      normalizedRequest,
      missingPath,
      "source-unreadable",
      "The visible attachment inventory could not be read safely.",
    );
  }
  const visibleFiles = passiveVisibleFiles(listing);
  const missingResolverTarget =
    parseMarkdownDestinationTarget(request.missingTarget)?.path ?? request.missingTarget;
  const resolution = new VaultLinkResolver(visibleFiles).resolve(
    sourceNotePath,
    missingResolverTarget,
  );
  if (resolution.status === "resolved") {
    return refused(
      normalizedRequest,
      missingPath,
      "missing-target-returned",
      "The original attachment resolves again, so Threadleaf will not overwrite it.",
    );
  }
  if (resolution.status === "ambiguous") {
    return refused(
      normalizedRequest,
      missingPath,
      "missing-target-ambiguous",
      "The missing target became ambiguous in the active vault.",
    );
  }

  const matches = matchingMissingReferenceCount(source, missingPath);
  if (matches === 0) {
    return refused(
      normalizedRequest,
      missingPath,
      "reference-not-found",
      "No supported missing attachment embed matches the rendered card.",
    );
  }
  if (matches > 1) {
    return refused(
      normalizedRequest,
      missingPath,
      "reference-ambiguous",
      "More than one attachment embed matches the missing target, so Threadleaf will not guess.",
    );
  }

  const bytes = Buffer.from(request.bytes);
  const generation = options.generation ?? options.currentGeneration?.() ?? null;
  const preview: AttachmentRestorePreview = {
    sourceNotePath,
    targetPath: missingPath,
    sourceFileName: request.sourceFileName,
    byteLength: bytes.byteLength,
    contentRevision: createHash("sha256").update(bytes).digest("hex"),
  };
  const planWithoutId = {
    preview,
    sourceRevision: source.revision,
    missingResolverTarget,
    generation,
  } satisfies Omit<AttachmentRestorePlan, "confirmationId" | "bytes">;
  return {
    ...planWithoutId,
    bytes,
    confirmationId: confirmationIdFor(planWithoutId),
  };
}

export async function restoreMissingAttachment(
  vault: AttachmentRestoreVault,
  request: AttachmentRestoreRequest,
  options: AttachmentRestoreOptions = {},
): Promise<AttachmentRestoreOutcome> {
  const plan = await planAttachmentRestore(vault, request, options);
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
      plan.preview.targetPath,
      "workspace-changed",
      "The visible vault changed after the restore preview.",
    );
  }

  const result = await vault.ingressAttachmentBytes(plan.preview.targetPath, plan.bytes, {
    operation: "restore-missing",
    sourceNotePath: plan.preview.sourceNotePath,
    sourceNoteRevision: plan.sourceRevision,
    missingPath: plan.preview.targetPath,
    missingResolverTarget: plan.missingResolverTarget,
  });
  if (result.status === "committed") {
    return { ...result, preview: plan.preview };
  }
  if (result.status === "manual-conflict") {
    return {
      status: "manual-conflict",
      path: result.path,
      transactionId: result.transactionId,
      reason: result.reason,
      message: `Threadleaf published or observed bytes at ${result.path}, but the final namespace receipt was uncertain (${result.reason}). It preserved private recovery evidence for manual review.`,
    };
  }
  if (result.reason === "source-note-changed") {
    return refused(
      request,
      result.path,
      "source-revision-changed",
      "The source note changed before any attachment bytes were published.",
    );
  }
  if (result.reason === "missing-target-present") {
    return refused(
      request,
      result.path,
      "missing-target-returned",
      "The missing attachment returned before publication, so Threadleaf did not overwrite it.",
    );
  }
  if (result.reason === "missing-target-ambiguous") {
    return refused(
      request,
      result.path,
      "missing-target-ambiguous",
      "The missing target became ambiguous before publication.",
    );
  }
  if (result.reason === "attachment-publish-unavailable") {
    return refused(
      request,
      result.path,
      "attachment-publish-unavailable",
      "Strict no-overwrite attachment publication is unavailable at that exact target directory.",
    );
  }
  return refused(
    request,
    result.path,
    "missing-target-changed",
    "The missing target changed or became unsafe before publication.",
  );
}
