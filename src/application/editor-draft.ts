import { normalizeVaultPath } from "../kernel/path-policy";
import type {
  EditorDraftLineEnding,
  EditorDraftSnapshot,
  EditorDraftTextRepresentation,
} from "../shared/contracts";

export const maximumEditorDraftBytes = 64 * 1024 * 1024;

export type PersistedEditorDraft = EditorDraftSnapshot;

export interface EditorDraftStore {
  load(vaultId: string, paneId?: "primary" | "secondary"): Promise<PersistedEditorDraft | null>;
  save(draft: PersistedEditorDraft): Promise<PersistedEditorDraft>;
  clear(vaultId: string, draftId: string, paneId?: "primary" | "secondary"): Promise<boolean>;
}

const sha256Pattern = /^[a-f0-9]{64}$/;
const draftIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeMarkdownPath(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Editor draft paths must be strings.");
  }
  const normalized = normalizeVaultPath(value);
  if (!normalized.toLocaleLowerCase("en-US").endsWith(".md")) {
    throw new Error("Editor drafts can target only Markdown notes.");
  }
  if (normalized.toLocaleLowerCase("en-US").startsWith(".obsidian/")) {
    throw new Error("Editor drafts cannot target .obsidian.");
  }
  return normalized;
}

function logicalNewlineCount(value: string): number {
  let count = 0;
  for (const character of value) {
    if (character === "\n") count += 1;
  }
  return count;
}

function isLineEnding(value: unknown): value is EditorDraftLineEnding {
  return value === "lf" || value === "crlf" || value === "cr";
}

function parseTextRepresentation(value: unknown, content: string): EditorDraftTextRepresentation {
  if (
    !isRecord(value) ||
    typeof value.hasBom !== "boolean" ||
    typeof value.lineEndingKinds !== "string" ||
    !/^[lcr]*$/u.test(value.lineEndingKinds) ||
    !isLineEnding(value.defaultLineEnding) ||
    value.lineEndingKinds.length !== logicalNewlineCount(content)
  ) {
    throw new Error(
      "Version 3 editor drafts require bounded external text representation metadata.",
    );
  }
  return {
    hasBom: value.hasBom,
    lineEndingKinds: value.lineEndingKinds,
    defaultLineEnding: value.defaultLineEnding,
  };
}

export function parseEditorDraft(value: unknown, expectedVaultId: string): PersistedEditorDraft {
  if (!sha256Pattern.test(expectedVaultId)) {
    throw new Error("Editor drafts require a lowercase SHA-256 vault identity.");
  }
  if (!isRecord(value)) {
    throw new Error(
      "Editor drafts require version 1, 2, or 3, exact vault and revision identities, content, selection, and an update time.",
    );
  }
  const version = value.version;
  if (
    (version !== 1 && version !== 2 && version !== 3) ||
    value.vaultId !== expectedVaultId ||
    typeof value.draftId !== "string" ||
    !draftIdPattern.test(value.draftId) ||
    typeof value.baseRevision !== "string" ||
    !sha256Pattern.test(value.baseRevision) ||
    typeof value.content !== "string" ||
    !isRecord(value.selection) ||
    !Number.isSafeInteger(value.selection.anchor) ||
    !Number.isSafeInteger(value.selection.head) ||
    typeof value.updatedAt !== "string"
  ) {
    throw new Error(
      "Editor drafts require version 1, 2, or 3, exact vault and revision identities, content, selection, and an update time.",
    );
  }
  const paneId = version === 1 ? "primary" : value.paneId;
  if (paneId !== "primary" && paneId !== "secondary") {
    throw new Error("Version 2 and 3 editor drafts require a workspace pane identity.");
  }

  const path = normalizeMarkdownPath(value.path);
  const contentBytes = Buffer.byteLength(value.content, "utf8");
  if (contentBytes > maximumEditorDraftBytes) {
    throw new Error(`Editor drafts cannot exceed ${maximumEditorDraftBytes} UTF-8 bytes.`);
  }
  const anchor = value.selection.anchor as number;
  const head = value.selection.head as number;
  if (anchor < 0 || head < 0 || anchor > value.content.length || head > value.content.length) {
    throw new Error("Editor draft selections must stay inside the draft content.");
  }
  const timestamp = new Date(value.updatedAt);
  if (Number.isNaN(timestamp.valueOf()) || timestamp.toISOString() !== value.updatedAt) {
    throw new Error("Editor draft update times must use canonical ISO-8601 UTC.");
  }
  if (version === 3 && value.content.includes("\r")) {
    throw new Error(
      "Version 3 editor draft content must use CodeMirror's logical LF representation; a literal U+FEFF is valid editor text.",
    );
  }
  const textRepresentation =
    version === 3 ? parseTextRepresentation(value.textRepresentation, value.content) : null;

  return {
    version: 3,
    draftId: value.draftId,
    vaultId: expectedVaultId,
    paneId,
    path,
    baseRevision: value.baseRevision,
    content: value.content,
    textRepresentation,
    selection: { anchor, head },
    updatedAt: value.updatedAt,
  };
}
