import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const renderer = readFileSync(new URL("../renderer/renderer.ts", import.meta.url), "utf8");

describe("startup shell liveness contract", () => {
  it("does not make vault activation depend on a hidden window animation frame", () => {
    const snapshot = renderer.lastIndexOf("void window.threadleaf\n  .getSnapshot()");
    const callback = renderer.indexOf("const markShellReady = () =>", snapshot);
    const animationFrame = renderer.indexOf("requestAnimationFrame(markShellReady)", callback);
    const timerFallback = renderer.indexOf("setTimeout(markShellReady, 100)", callback);

    expect(snapshot).toBeGreaterThanOrEqual(0);
    expect(callback).toBeGreaterThan(snapshot);
    expect(animationFrame).toBeGreaterThan(callback);
    expect(timerFallback).toBeGreaterThan(animationFrame);
  });

  it("shows a loaded window even when ready-to-show never arrives", () => {
    const createWindow = main.indexOf("async function createWindow(");
    const loaded = main.indexOf('window.webContents.on("did-finish-load"', createWindow);
    const fallback = main.indexOf("showFallbackTimer = setTimeout(showWindow, 250)", loaded);
    const preferred = main.indexOf('window.once("ready-to-show", showWindow)', fallback);

    expect(createWindow).toBeGreaterThanOrEqual(0);
    expect(loaded).toBeGreaterThan(createWindow);
    expect(fallback).toBeGreaterThan(loaded);
    expect(preferred).toBeGreaterThan(fallback);
  });

  it("does not make plugin view attachment depend on an unoccluded animation frame", () => {
    const helper = renderer.indexOf("function waitForVisualFrameOrTimeout(");
    const timer = renderer.indexOf("window.setTimeout(finish, timeoutMs)", helper);
    const pluginView = renderer.indexOf("async function activatePluginView()", timer);
    const pluginViewWait = renderer.indexOf("await waitForVisualFrameOrTimeout()", pluginView);
    const pluginSettings = renderer.indexOf(
      "async function activatePluginSettings(",
      pluginViewWait,
    );
    const pluginSettingsWait = renderer.indexOf(
      "await waitForVisualFrameOrTimeout()",
      pluginSettings,
    );
    const automaticActivation = renderer.indexOf(
      "const activateWhenIdle = async (): Promise<void>",
      pluginSettingsWait,
    );
    const automaticWait = renderer.indexOf(
      "void waitForVisualFrameOrTimeout().then(activateWhenIdle)",
      automaticActivation,
    );

    expect(helper).toBeGreaterThanOrEqual(0);
    expect(timer).toBeGreaterThan(helper);
    expect(pluginView).toBeGreaterThan(timer);
    expect(pluginViewWait).toBeGreaterThan(pluginView);
    expect(pluginSettings).toBeGreaterThan(pluginViewWait);
    expect(pluginSettingsWait).toBeGreaterThan(pluginSettings);
    expect(automaticActivation).toBeGreaterThan(pluginSettingsWait);
    expect(automaticWait).toBeGreaterThan(automaticActivation);
  });
});
