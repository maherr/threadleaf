export const autosaveFlushReasons = [
  "note-switch",
  "tab-close",
  "tab-reorder",
  "pane-switch",
  "pane-split",
  "pane-move",
  "pane-close",
  "vault-switch",
  "new-note",
  "daily-note",
  "note-mutation",
  "window-blur",
  "window-close",
  "app-quit",
] as const;

export type AutosaveFlushReason = (typeof autosaveFlushReasons)[number];

export interface AutosaveFlushRequest {
  requestId: string;
  reason: AutosaveFlushReason;
}

export type AutosaveFlushResult =
  | { requestId: string; status: "flushed" }
  | { requestId: string; status: "failed"; message: string };

export function isAutosaveFlushReason(value: unknown): value is AutosaveFlushReason {
  return autosaveFlushReasons.includes(value as AutosaveFlushReason);
}
