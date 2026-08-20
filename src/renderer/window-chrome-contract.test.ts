import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const renderer = readFileSync(new URL("./renderer.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("integrated desktop window chrome", () => {
  it("provides a titlebar host for the active pane and a directly reachable new-note control", () => {
    expect(html).toContain('class="titlebar-left-cluster"');
    expect(html).toContain('id="titlebar-tabs-host"');
    expect(html).toContain('id="titlebar-new-note"');
    expect(html).toContain('id="titlebar-left-dock"');
    expect(html.indexOf('id="titlebar-tabs-host"')).toBeLessThan(
      html.indexOf('class="topbar-actions"'),
    );
  });

  it("moves the active pane tab shell into the titlebar and restores the previous pane shell", () => {
    expect(renderer).toContain("function dockPaneTabsInTitlebar");
    expect(renderer).toContain("previousPane.workspacePane.prepend(previousShell)");
    expect(renderer).toContain("elements.titlebarTabsHost.append(nextShell)");
    expect(renderer).toContain('nextPane.workspacePane.dataset.tabsInTitlebar = "true"');
  });

  it("keeps the titlebar dock control synchronized with the real workspace dock", () => {
    expect(renderer).toContain(
      'elements.titlebarLeftDock.addEventListener("click", () => void toggleWorkspaceDock("left"))',
    );
    expect(renderer).toContain(
      'elements.titlebarLeftDock.setAttribute("aria-expanded", String(!leftCollapsed))',
    );
  });

  it("keeps the docked tab shell and editor body in explicit layout states", () => {
    expect(styles).toContain(".titlebar-tabs-host > .note-tabs-shell");
    expect(styles).toContain("flex: 0 0 clamp(156px, 16vw, 210px)");
    expect(styles).toContain("border-radius: 8px 8px 0 0");
    expect(styles).toContain(".pane-layout-icon");
    expect(styles).toContain('.workspace-pane[data-tabs-in-titlebar="true"]');
    expect(styles).toContain("grid-template-rows: 36px minmax(0, 1fr)");
  });
});
