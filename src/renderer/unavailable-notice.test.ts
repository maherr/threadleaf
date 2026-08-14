import { describe, expect, it } from "vitest";
import {
  renderDocumentViewToolbarLabel,
  renderUnavailableNoticeToolbarLabel,
  unavailableNoticeText,
} from "./unavailable-notice";

describe("unavailableNoticeText", () => {
  it("invites a choice when no tab is selected", () => {
    expect(unavailableNoticeText(null)).toMatchObject({ heading: "Select a note" });
    expect(unavailableNoticeText(undefined).heading).toBe("Select a note");
  });

  it("says which file the selected tab is waiting for", () => {
    const notice = unavailableNoticeText({ path: "Boards/Overview.canvas", title: "Overview" });

    // The distinction the pane has to carry: a tab was clicked and it is coming,
    // rather than nothing having happened.
    expect(notice.heading).toBe("Waiting for Overview");
    expect(notice.detail).toContain("Boards/Overview.canvas");
    expect(notice.detail).toContain("The tab stays open");
    expect(notice.toolbarLabel).toBe("Waiting for Boards/Overview.canvas");
    expect(notice).not.toMatchObject(unavailableNoticeText(null));
  });

  it("keeps an available note path when the empty-notice render follows the note render", () => {
    const notePath: { textContent: string | null } = { textContent: "No note selected" };
    const renderNote = (path: string): void => {
      notePath.textContent = path;
    };

    renderNote("Welcome.md");
    renderUnavailableNoticeToolbarLabel(notePath, null);

    expect(notePath.textContent).toBe("Welcome.md");
    expect(notePath.textContent).not.toBe("No note selected");
  });

  it("writes a waiting label and keeps it through a document-view render", () => {
    const notePath: { textContent: string | null } = { textContent: "No note selected" };
    const unavailable = { path: "Syncing.md", title: "Syncing" };

    renderUnavailableNoticeToolbarLabel(notePath, unavailable);
    expect(notePath.textContent).toBe("Waiting for Syncing.md");

    renderDocumentViewToolbarLabel(notePath, {
      loadedPath: null,
      unavailable,
    });
    expect(notePath.textContent).toBe("Waiting for Syncing.md");
  });
});
