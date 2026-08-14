import { describe, expect, it } from "vitest";
import {
  attachmentMoveCommitNotice,
  attachmentPublicationConflictMessage,
  attachmentPublicationReceipt,
} from "./attachment-move-status";

describe("attachment move commit status", () => {
  it("names the previous vault without exposing its path after a replacement", () => {
    expect(
      attachmentMoveCommitNotice({
        outcome: { status: "published-source-retained" },
        snapshot: { vault: { id: "vault:new" } },
        committedVaultId: "vault:old:/private/old-vault",
        committedVaultName: "/private/old-vault\n",
      }),
    ).toBe('Committed in previously active vault "old-vault". The current view is another vault.');
  });

  it("does not add a previous-vault notice for a current-vault commit", () => {
    expect(
      attachmentMoveCommitNotice({
        outcome: { status: "published-source-retained" },
        snapshot: { vault: { id: "vault:current" } },
        committedVaultId: "vault:current",
        committedVaultName: "Current",
      }),
    ).toBeNull();
  });

  it("does not present a legacy destructive move outcome as attachment publication", () => {
    expect(
      attachmentMoveCommitNotice({
        outcome: { status: "committed" },
        snapshot: { vault: { id: "vault:new" } },
        committedVaultId: "vault:old",
        committedVaultName: "Old",
      }),
    ).toBeNull();
  });

  it("accepts only a complete source-retaining publication receipt", () => {
    expect(
      attachmentPublicationReceipt({
        status: "published-source-retained",
        from: "Assets/report.pdf",
        to: "Archive/report.pdf",
        rewrites: [{ path: "Notes/Index.md" }],
      }),
    ).toEqual({
      sourcePath: "Assets/report.pdf",
      targetPath: "Archive/report.pdf",
      rewriteCount: 1,
    });
    expect(
      attachmentPublicationReceipt({
        status: "published-source-retained",
        to: "Archive/report.pdf",
        rewrites: [],
      }),
    ).toBeNull();
    expect(
      attachmentPublicationReceipt({
        status: "committed",
        from: "Assets/report.pdf",
        to: "Archive/report.pdf",
        rewrites: [],
      }),
    ).toBeNull();
  });

  it("explains typed strict-publication conflicts without the generic failure fallback", () => {
    expect(attachmentPublicationConflictMessage("attachment-publish-unavailable")).toBe(
      "Threadleaf could not verify strict no-overwrite publication at that destination. Use an existing contained folder on this vault filesystem that supports attachment publication. Review both attachment paths; Markdown references were not updated.",
    );
    expect(attachmentPublicationConflictMessage("target-normalized-exists")).toBe(
      "Threadleaf found a case- or Unicode-equivalent destination name. Choose a path with a distinct normalized name. Threadleaf did not overwrite it or update Markdown references.",
    );
    expect(attachmentPublicationConflictMessage("target-exists")).toBeNull();
  });
});
