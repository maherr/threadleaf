import { describe, expect, it } from "vitest";
import { unavailableNoticeText } from "./unavailable-notice";

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
});
