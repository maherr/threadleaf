import { describe, expect, it, vi } from "vitest";
import { installMainWindowNavigationGuards } from "./navigation-policy";

describe("main-window navigation policy", () => {
  it("cancels renderer navigations and denies new windows", () => {
    let navigationListener: ((event: { preventDefault(): void }, url: string) => void) | undefined;
    const preventDefault = vi.fn();
    const setWindowOpenHandler = vi.fn();
    installMainWindowNavigationGuards({
      on: (_event, listener) => {
        navigationListener = listener;
      },
      setWindowOpenHandler,
    });

    navigationListener?.({ preventDefault }, "https://example.com/");
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(setWindowOpenHandler).toHaveBeenCalledOnce();
    expect(setWindowOpenHandler.mock.calls[0]?.[0]?.()).toEqual({ action: "deny" });
  });
});
