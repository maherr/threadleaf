import { createHash } from "node:crypto";
import {
  maskMarkdownCodeAndComments,
  type ParsedMarkdownLink,
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
  VaultAttachmentRelinkMutationPort,
  VaultMutationPort,
  VaultReadPort,
  VaultTextSnapshot,
  VaultWriteResult,
} from "../kernel/ports";
import type { BinaryReadResult } from "../kernel/vault-kernel";
import { isPassiveAttachmentTarget } from "../shared/attachment-targets";
import type {
  AttachmentRelinkOutcome,
  AttachmentRelinkRefusalReason,
  AttachmentRelinkRewritePreview,
  VaultAttachmentRecoveryOffer,
} from "../shared/contracts";
import { attachmentReferenceTarget } from "./attachment-reference-path";
import {
  DEFAULT_VAULT_ATTACHMENT_MAX_BYTES,
  parseVaultAttachmentTarget,
} from "./vault-attachment-service";

interface AttachmentRelinkVault extends VaultMutationPort, VaultAttachmentRelinkMutationPort {
  listVisiblePaths(relativeDirectory?: string): Promise<VisibleVaultPaths>;
  resolveReadPath(relativePath: string): Promise<string>;
  readBinary(relativePath: string, maxBytes: number): Promise<BinaryReadResult>;
}

export interface AttachmentRelinkRequest {
  sourceNotePath: string;
  missingTarget: string;
  replacementPath: string;
  expectedSourceRevision: string;
  confirmationId?: string;
}

export interface AttachmentRelinkOptions {
  generation?: number;
  currentGeneration?: () => number;
  maxReplacementBytes?: number;
}

type AttachmentRelinkWriteConflict = Extract<VaultWriteResult, { status: "conflict" }>;
export type AttachmentRelinkExecutionOutcome =
  | AttachmentRelinkOutcome
  | {
      status: "refused";
      sourceNotePath: string;
      missingPath: string;
      replacementPath: string;
      reason: "write-conflict";
      message: string;
      writeConflict: AttachmentRelinkWriteConflict;
    };

interface AttachmentRelinkPlan {
  sourceNotePath: string;
  missingPath: string;
  missingResolverTarget: string;
  replacementPath: string;
  replacementCanonicalPath: string;
  sourceRevision: string;
  replacementRevision: string;
  maxReplacementBytes: number;
  content: string;
  rewrite: AttachmentRelinkRewritePreview;
  generation: number | null;
  confirmationId: string;
}

type AttachmentRelinkRefused = Extract<AttachmentRelinkOutcome, { status: "refused" }>;

function refused(
  request: Pick<AttachmentRelinkRequest, "sourceNotePath" | "replacementPath">,
  missingPath: string,
  reason: AttachmentRelinkRefusalReason,
  message: string,
): AttachmentRelinkRefused {
  return {
    status: "refused",
    sourceNotePath: request.sourceNotePath,
    missingPath,
    replacementPath: request.replacementPath,
    reason,
    message,
  };
}

function confirmationIdFor(plan: Omit<AttachmentRelinkPlan, "confirmationId">): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        sourceNotePath: plan.sourceNotePath,
        missingPath: plan.missingPath,
        missingResolverTarget: plan.missingResolverTarget,
        replacementPath: plan.replacementPath,
        replacementCanonicalPath: plan.replacementCanonicalPath,
        sourceRevision: plan.sourceRevision,
        replacementRevision: plan.replacementRevision,
        maxReplacementBytes: plan.maxReplacementBytes,
        rewrite: plan.rewrite,
        contentRevision: createHash("sha256").update(plan.content, "utf8").digest("hex"),
        generation: plan.generation,
      }),
      "utf8",
    )
    .digest("hex");
}

function passiveVisibleFiles(listing: VisibleVaultPaths): string[] {
  return listing.files.filter(
    (filePath) =>
      !hasHiddenVaultSegment(filePath) &&
      !hasPrivateVaultSegment(filePath) &&
      !filePath.toLocaleLowerCase("en-US").endsWith(".md"),
  );
}

function matchingMissingReferences(
  content: string,
  sourceNotePath: string,
  missingPath: string,
): ParsedMarkdownLink[] {
  return parseMarkdownLinks(content, maskMarkdownCodeAndComments(content)).filter((link) => {
    if (!link.embed || link.sourceKind === "markdown-reference-definition") return false;
    const rawTarget = content.slice(link.targetStart, link.targetEnd);
    const parsed = parseVaultAttachmentTarget(sourceNotePath, rawTarget);
    return (
      parsed.status === "local" &&
      isPassiveAttachmentTarget(parsed.path) &&
      normalizedVaultPathIdentity(parsed.path) === normalizedVaultPathIdentity(missingPath)
    );
  });
}

export async function inspectMissingAttachmentRelinkOffer(
  vault: Pick<VaultReadPort, "readText">,
  sourceNotePath: string,
  missingTarget: string,
  visiblePaths: readonly string[],
): Promise<VaultAttachmentRecoveryOffer | null> {
  let normalizedSourcePath: string;
  try {
    normalizedSourcePath = normalizeVaultPath(sourceNotePath);
  } catch {
    return null;
  }
  if (
    !normalizedSourcePath.toLocaleLowerCase("en-US").endsWith(".md") ||
    hasHiddenVaultSegment(normalizedSourcePath) ||
    hasPrivateVaultSegment(normalizedSourcePath)
  ) {
    return null;
  }
  const parsedMissing = parseVaultAttachmentTarget(normalizedSourcePath, missingTarget);
  if (parsedMissing.status !== "local" || !isPassiveAttachmentTarget(parsedMissing.path)) {
    return null;
  }
  const destination = parseMarkdownDestinationTarget(missingTarget)?.path ?? missingTarget;
  const resolver = new VaultLinkResolver(
    visiblePaths.filter(
      (filePath) =>
        !hasHiddenVaultSegment(filePath) &&
        !hasPrivateVaultSegment(filePath) &&
        !filePath.toLocaleLowerCase("en-US").endsWith(".md"),
    ),
  );
  if (resolver.resolve(normalizedSourcePath, destination).status !== "unresolved") return null;
  let source: VaultTextSnapshot;
  try {
    source = await vault.readText(normalizedSourcePath);
  } catch {
    return null;
  }
  const matches = matchingMissingReferences(
    source.content,
    normalizedSourcePath,
    parsedMissing.path,
  );
  if (matches.length !== 1) return null;
  return {
    kind: "missing-attachment",
    missingPath: parsedMissing.path,
    sourceNoteRevision: source.revision,
  };
}

async function planAttachmentRelink(
  vault: AttachmentRelinkVault,
  request: AttachmentRelinkRequest,
  options: AttachmentRelinkOptions,
): Promise<AttachmentRelinkPlan | AttachmentRelinkRefused> {
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
      request,
      request.missingTarget,
      hasHiddenVaultSegment(sourceNotePath) || hasPrivateVaultSegment(sourceNotePath)
        ? "private-path"
        : "invalid-source",
      "Relinking requires a public Markdown source note.",
    );
  }

  const parsedMissing = parseVaultAttachmentTarget(sourceNotePath, request.missingTarget);
  if (parsedMissing.status !== "local" || !isPassiveAttachmentTarget(parsedMissing.path)) {
    return refused(
      request,
      parsedMissing.status === "local" ? parsedMissing.path : request.missingTarget,
      parsedMissing.status === "rejected" && parsedMissing.reason === "private"
        ? "private-path"
        : "invalid-missing-target",
      "The missing target is not a safe passive attachment reference.",
    );
  }
  const missingPath = parsedMissing.path;

  let replacementPath: string;
  try {
    replacementPath = normalizeVaultPath(request.replacementPath);
  } catch {
    return refused(request, missingPath, "invalid-replacement", "The replacement path is invalid.");
  }
  const normalizedRequest = { ...request, sourceNotePath, replacementPath };
  if (hasHiddenVaultSegment(replacementPath) || hasPrivateVaultSegment(replacementPath)) {
    return refused(
      normalizedRequest,
      missingPath,
      "private-path",
      "Private application paths cannot replace an attachment.",
    );
  }
  if (
    replacementPath.toLocaleLowerCase("en-US").endsWith(".md") ||
    !isPassiveAttachmentTarget(replacementPath)
  ) {
    return refused(
      normalizedRequest,
      missingPath,
      "invalid-replacement",
      "The replacement must be an existing passive attachment, not a Markdown note.",
    );
  }

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
      "The source note changed before the relink preview was built.",
    );
  }

  let listing: VisibleVaultPaths;
  try {
    listing = await vault.listVisiblePaths("");
  } catch {
    return refused(
      normalizedRequest,
      missingPath,
      "replacement-unreadable",
      "The visible attachment inventory could not be read safely.",
    );
  }
  const visibleFiles = passiveVisibleFiles(listing);
  const resolver = new VaultLinkResolver(visibleFiles);
  const missingDestination =
    parseMarkdownDestinationTarget(request.missingTarget)?.path ?? request.missingTarget;
  const missingResolution = resolver.resolve(sourceNotePath, missingDestination);
  if (missingResolution.status === "ambiguous") {
    return refused(
      normalizedRequest,
      missingPath,
      "missing-target-ambiguous",
      "The missing target became ambiguous in the active vault.",
    );
  }
  if (missingResolution.status === "resolved") {
    return refused(
      normalizedRequest,
      missingPath,
      "missing-target-returned",
      "The original attachment path resolves again, so Threadleaf will not replace the reference.",
    );
  }

  const replacementMatches = visibleFiles.filter(
    (candidate) =>
      normalizedVaultPathIdentity(candidate) === normalizedVaultPathIdentity(replacementPath),
  );
  if (replacementMatches.length === 0) {
    return refused(
      normalizedRequest,
      missingPath,
      "replacement-missing",
      "The replacement attachment does not exist in the visible vault.",
    );
  }
  if (replacementMatches.length > 1) {
    return refused(
      normalizedRequest,
      missingPath,
      "replacement-ambiguous",
      "The replacement path is ambiguous after case and Unicode normalization.",
    );
  }
  replacementPath = replacementMatches[0] as string;
  const resolvedRequest = { ...normalizedRequest, replacementPath };

  let replacementCanonicalPath: string;
  try {
    replacementCanonicalPath = await vault.resolveReadPath(replacementPath);
    if (
      hasHiddenVaultSegment(replacementCanonicalPath) ||
      hasPrivateVaultSegment(replacementCanonicalPath)
    ) {
      return refused(
        resolvedRequest,
        missingPath,
        "private-path",
        "The replacement resolves to a private application path.",
      );
    }
  } catch {
    return refused(
      resolvedRequest,
      missingPath,
      "replacement-unreadable",
      "The replacement attachment could not be contained safely in the active vault.",
    );
  }

  let replacement: BinaryReadResult;
  const maxReplacementBytes = options.maxReplacementBytes ?? DEFAULT_VAULT_ATTACHMENT_MAX_BYTES;
  try {
    replacement = await vault.readBinary(replacementPath, maxReplacementBytes);
  } catch {
    return refused(
      resolvedRequest,
      missingPath,
      "replacement-unreadable",
      "The replacement attachment could not be read safely.",
    );
  }
  if (replacement.status === "too-large") {
    return refused(
      resolvedRequest,
      missingPath,
      "replacement-too-large",
      "The replacement exceeds the bounded attachment read limit.",
    );
  }
  try {
    if ((await vault.resolveReadPath(replacementPath)) !== replacementCanonicalPath) {
      return refused(
        resolvedRequest,
        missingPath,
        "replacement-unreadable",
        "The replacement attachment changed identity while it was inspected.",
      );
    }
  } catch {
    return refused(
      resolvedRequest,
      missingPath,
      "replacement-unreadable",
      "The replacement attachment changed containment while it was inspected.",
    );
  }

  const candidates = matchingMissingReferences(source.content, sourceNotePath, missingPath);
  if (candidates.length === 0) {
    return refused(
      resolvedRequest,
      missingPath,
      "reference-not-found",
      "No supported missing attachment embed matches the rendered card.",
    );
  }
  if (candidates.length > 1) {
    return refused(
      resolvedRequest,
      missingPath,
      "reference-ambiguous",
      "More than one attachment embed matches the missing target, so Threadleaf will not guess.",
    );
  }
  const link = candidates[0];
  if (!link) {
    return refused(
      resolvedRequest,
      missingPath,
      "unsupported-reference",
      "The missing attachment reference is not supported for relinking.",
    );
  }
  const sourceTarget = source.content.slice(link.targetStart, link.targetEnd);
  const parsedSourceTarget = parseVaultAttachmentTarget(sourceNotePath, sourceTarget);
  if (parsedSourceTarget.status !== "local") {
    return refused(
      resolvedRequest,
      missingPath,
      "unsupported-reference",
      "The missing attachment reference could not be preserved safely.",
    );
  }
  const afterTarget = attachmentReferenceTarget(
    link.syntax,
    sourceNotePath,
    replacementPath,
    parsedSourceTarget.suffix,
  );
  const content = `${source.content.slice(0, link.targetStart)}${afterTarget}${source.content.slice(link.targetEnd)}`;
  const generation = options.generation ?? options.currentGeneration?.() ?? null;
  const planWithoutId = {
    sourceNotePath,
    missingPath,
    missingResolverTarget: missingDestination,
    replacementPath,
    replacementCanonicalPath,
    sourceRevision: source.revision,
    replacementRevision: replacement.snapshot.revision,
    maxReplacementBytes,
    content,
    rewrite: {
      documentPath: sourceNotePath,
      line: link.line,
      syntax: link.syntax,
      beforeTarget: sourceTarget,
      afterTarget,
      missingPath,
      replacementPath,
    },
    generation,
  } satisfies Omit<AttachmentRelinkPlan, "confirmationId">;
  return { ...planWithoutId, confirmationId: confirmationIdFor(planWithoutId) };
}

export async function relinkMissingAttachment(
  vault: AttachmentRelinkVault,
  request: AttachmentRelinkRequest,
  options: AttachmentRelinkOptions = {},
): Promise<AttachmentRelinkExecutionOutcome> {
  const plan = await planAttachmentRelink(vault, request, options);
  if ("status" in plan) return plan;
  if (request.confirmationId !== plan.confirmationId) {
    return {
      status: "requires-confirmation",
      sourceNotePath: plan.sourceNotePath,
      missingPath: plan.missingPath,
      replacementPath: plan.replacementPath,
      replacementRevision: plan.replacementRevision,
      confirmationId: plan.confirmationId,
      rewrite: plan.rewrite,
    };
  }
  if (options.currentGeneration && options.currentGeneration() !== plan.generation) {
    return refused(
      request,
      plan.missingPath,
      "workspace-changed",
      "The visible vault changed after the relink preview.",
    );
  }
  const result = await vault.writeTextWithAttachmentPreconditions(
    plan.sourceNotePath,
    plan.content,
    plan.sourceRevision,
    {
      sourceNotePath: plan.sourceNotePath,
      missingPath: plan.missingPath,
      missingResolverTarget: plan.missingResolverTarget,
      replacementPath: plan.replacementPath,
      replacementCanonicalPath: plan.replacementCanonicalPath,
      replacementRevision: plan.replacementRevision,
      maxReplacementBytes: plan.maxReplacementBytes,
    },
  );
  if (result.status === "precondition-failed") {
    if (result.reason === "missing-target-present") {
      return refused(
        request,
        plan.missingPath,
        "missing-target-returned",
        "The original attachment path resolves again, so Threadleaf did not replace the reference.",
      );
    }
    if (result.reason === "missing-target-ambiguous") {
      return refused(
        request,
        plan.missingPath,
        "missing-target-ambiguous",
        "The original attachment target became ambiguous before the note write.",
      );
    }
    if (result.reason === "missing-target-unsafe") {
      return refused(
        request,
        plan.missingPath,
        "missing-target-changed",
        "The original attachment path changed or became unsafe before the note write.",
      );
    }
    return refused(
      request,
      plan.missingPath,
      result.reason === "replacement-changed" ? "replacement-changed" : "replacement-unreadable",
      result.reason === "replacement-changed"
        ? "The replacement attachment changed before the note write. Review a refreshed relink plan."
        : "The replacement attachment became unreadable or left the safe vault boundary before the note write.",
    );
  }
  if (result.status === "conflict") {
    return {
      ...refused(
        request,
        plan.missingPath,
        "write-conflict",
        `The source note changed during the relink transaction. Threadleaf preserved the proposed relink at ${result.conflictPath}; review both notes before continuing.`,
      ),
      writeConflict: result,
    };
  }
  return {
    status: "committed",
    path: result.path,
    revision: result.revision,
    transactionId: result.transactionId,
    rewrite: plan.rewrite,
  };
}
