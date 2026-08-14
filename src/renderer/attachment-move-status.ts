export interface AttachmentMoveCommitStatus {
  outcome: { status: string };
  snapshot: { vault: { id: string | null } };
  committedVaultId?: string;
  committedVaultName?: string;
}

export interface AttachmentPublicationOutcomeStatus {
  status: string;
  from?: unknown;
  to?: unknown;
  rewrites?: unknown;
}

export interface VerifiedAttachmentPublicationReceipt {
  sourcePath: string;
  targetPath: string;
  rewriteCount: number;
}

/** Explains strict-publication conflicts without pretending they are generic failures. */
export function attachmentPublicationConflictMessage(reason: unknown): string | null {
  if (reason === "attachment-publish-unavailable") {
    return "Threadleaf could not verify strict no-overwrite publication at that destination. Use an existing contained folder on this vault filesystem that supports attachment publication. Review both attachment paths; Markdown references were not updated.";
  }
  if (reason === "target-normalized-exists") {
    return "Threadleaf found a case- or Unicode-equivalent destination name. Choose a path with a distinct normalized name. Threadleaf did not overwrite it or update Markdown references.";
  }
  return null;
}

function displaySafeVaultName(value: string | undefined): string {
  const basenameSafe = (value ?? "").replaceAll("\\", "/").split("/").at(-1) ?? "";
  const cleaned = [...basenameSafe]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f ? " " : character;
    })
    .join("")
    .trim();
  return cleaned || "previous vault";
}

/** Keeps an old-vault commit visible without exposing its path. */
export function attachmentMoveCommitNotice(response: AttachmentMoveCommitStatus): string | null {
  if (
    response.outcome.status !== "published-source-retained" ||
    !response.committedVaultId ||
    response.committedVaultId === response.snapshot.vault.id
  ) {
    return null;
  }
  return `Committed in previously active vault "${displaySafeVaultName(response.committedVaultName)}". The current view is another vault.`;
}

/** Refuses to turn an incomplete or legacy outcome into a publication success message. */
export function attachmentPublicationReceipt(
  outcome: AttachmentPublicationOutcomeStatus,
): VerifiedAttachmentPublicationReceipt | null {
  if (
    outcome.status !== "published-source-retained" ||
    typeof outcome.from !== "string" ||
    outcome.from.length === 0 ||
    typeof outcome.to !== "string" ||
    outcome.to.length === 0 ||
    !Array.isArray(outcome.rewrites)
  ) {
    return null;
  }
  return {
    sourcePath: outcome.from,
    targetPath: outcome.to,
    rewriteCount: outcome.rewrites.length,
  };
}
