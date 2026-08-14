import type { WorkspaceUnavailableEntry } from "../shared/contracts";

export interface UnavailableNoticeText {
  heading: string;
  detail: string;
  toolbarLabel: string;
}

const noSelection: UnavailableNoticeText = {
  heading: "Select a note",
  detail: "The filesystem remains authoritative. This surface reads through the safe vault kernel.",
  toolbarLabel: "No note selected",
};

/**
 * What the empty pane says.
 *
 * A pane with no selection is inviting a choice. A pane whose selected tab has
 * no file in the vault right now is waiting for one, and offering "Select a
 * note" there reads as the click having been ignored - which is the whole
 * complaint about a tab that stays visible through an absence nobody has
 * confirmed. Both states render through the same element, so the difference has
 * to be in the words.
 */
export function unavailableNoticeText(
  entry: WorkspaceUnavailableEntry | null | undefined,
): UnavailableNoticeText {
  if (!entry) {
    return noSelection;
  }
  return {
    heading: `Waiting for ${entry.title}`,
    detail: `${entry.path} is not in the vault right now. The tab stays open, and this opens as soon as its file is back.`,
    toolbarLabel: `Waiting for ${entry.path}`,
  };
}
