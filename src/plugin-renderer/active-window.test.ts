import { describe, expect, it } from "vitest";
import { installActiveWindowGlobal } from "./active-window";

describe("isolated activeWindow binding", () => {
  it("publishes the actual window as an immutable non-configurable global", () => {
    const rendererWindow = {} as Window;
    const target = {} as typeof globalThis;

    installActiveWindowGlobal(rendererWindow, target);

    expect((target as typeof globalThis & { activeWindow: Window }).activeWindow).toBe(
      rendererWindow,
    );
    expect(Object.getOwnPropertyDescriptor(target, "activeWindow")).toEqual({
      configurable: false,
      enumerable: true,
      value: rendererWindow,
      writable: false,
    });
    expect(() => installActiveWindowGlobal({} as Window, target)).toThrow("already occupied");
  });
});
