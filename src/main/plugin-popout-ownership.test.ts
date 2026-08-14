import { describe, expect, it } from "vitest";
import { destroyedViewOwnsPluginPopout } from "./plugin-popout-ownership";

describe("plugin pop-out ownership", () => {
  it("does not close A's pop-out when an unrelated B view is destroyed", () => {
    const popout = {} as Electron.BrowserWindow;
    const mainWindow = {} as Electron.BrowserWindow;
    const viewA = {} as Electron.WebContentsView;
    const viewB = {} as Electron.WebContentsView;

    expect(destroyedViewOwnsPluginPopout(viewB, viewA, popout, popout)).toBe(false);
    expect(destroyedViewOwnsPluginPopout(viewA, viewA, popout, popout)).toBe(true);
    expect(destroyedViewOwnsPluginPopout(viewA, viewA, mainWindow, popout)).toBe(false);
  });
});
