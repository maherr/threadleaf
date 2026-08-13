export const publishNoteExportVersion = 1 as const;
export const maximumPublishNoteHtmlBytes = 96 * 1024 * 1024;

export interface PublishNoteExportRequest {
  version: typeof publishNoteExportVersion;
  expectedVaultId: string;
  sourcePath: string;
  expectedRevision: string;
  html: string;
}

export type PublishNoteExportResponse =
  | { status: "cancelled" }
  | { status: "saved" }
  | { status: "stale-note"; message: string }
  | { status: "failed"; message: string };
