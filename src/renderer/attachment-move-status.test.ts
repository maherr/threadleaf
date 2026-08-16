import { describe, expect, it } from "vitest";
import {
  attachmentMoveCommitNotice,
  attachmentPublicationConflictMessage,
  attachmentPublicationReceipt,
  attachmentRenameReceipt,
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

  it("names the previous vault for an explicitly expected attachment rename", () => {
    const response = {
      outcome: { status: "committed" },
      snapshot: { vault: { id: "vault:new" } },
      committedVaultId: "vault:old",
      committedVaultName: "Old",
    };
    expect(attachmentMoveCommitNotice(response, "committed")).toBe(
      'Committed in previously active vault "Old". The current view is another vault.',
    );
  });

  it("accepts only a complete source-retaining publication receipt", () => {
    expect(
      attachmentPublicationReceipt({
        status: "published-source-retained",
        from: "Assets/report.pdf",
        to: "Archive/report.pdf",
        rewrites: [
          {
            documentPath: "Notes/Index.md",
            line: 1,
            syntax: "wiki",
            embed: true,
            beforeTarget: "Assets/report.pdf",
            afterTarget: "Archive/report.pdf",
          },
        ],
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

  it("accepts only a complete source-removing rename receipt", () => {
    expect(
      attachmentRenameReceipt({
        status: "committed",
        from: "Assets/report.pdf",
        to: "Archive/report.pdf",
        rewrites: [
          {
            documentPath: "Notes/Index.md",
            line: 1,
            syntax: "wiki",
            embed: true,
            beforeTarget: "Assets/report.pdf",
            afterTarget: "Archive/report.pdf",
          },
          {
            documentPath: "Board.canvas",
            line: 4,
            syntax: "canvas",
            embed: false,
            beforeTarget: "Assets/report.pdf",
            afterTarget: "Archive/report.pdf",
            location: "$.nodes[0].file",
          },
        ],
      }),
    ).toEqual({
      sourcePath: "Assets/report.pdf",
      targetPath: "Archive/report.pdf",
      rewriteCount: 2,
    });
    expect(
      attachmentRenameReceipt({
        status: "published-source-retained",
        from: "Assets/report.pdf",
        to: "Archive/report.pdf",
        rewrites: [],
      }),
    ).toBeNull();
    expect(
      attachmentRenameReceipt({
        status: "committed",
        from: "Assets/report.pdf",
        to: "Archive/report.pdf",
        rewrites: [
          {
            documentPath: "Board.canvas",
            line: 1,
            syntax: "canvas",
            embed: false,
            beforeTarget: "Assets/report.pdf",
            afterTarget: "Archive/report.pdf",
          },
        ],
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
