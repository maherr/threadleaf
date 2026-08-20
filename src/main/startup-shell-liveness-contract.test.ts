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
});
