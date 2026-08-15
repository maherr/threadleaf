import { describe, expect, it, vi } from "vitest";
import { createGracefulShutdownHandler } from "./graceful-shutdown";

describe("createGracefulShutdownHandler", () => {
  it("waits for cleanup, coalesces repeated quit events, and permits the final quit", async () => {
    let resolveClose: (() => void) | undefined;
    const close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveClose = resolve;
        }),
    );
    const prepare = vi.fn();
    const finalize = vi.fn();
    const quit = vi.fn();
    const firstEvent = { preventDefault: vi.fn() };
    const repeatedEvent = { preventDefault: vi.fn() };
    const finalEvent = { preventDefault: vi.fn() };
    const handleShutdown = createGracefulShutdownHandler({
      prepare,
      close,
      finalize,
      quit,
    });

    handleShutdown(firstEvent);
    handleShutdown(repeatedEvent);

    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(repeatedEvent.preventDefault).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(finalize).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();

    resolveClose?.();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());

    expect(finalize).toHaveBeenCalledOnce();
    handleShutdown(finalEvent);
    expect(finalEvent.preventDefault).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("reports cleanup failures and still performs the final quit", async () => {
    const prepareError = new Error("prepare failed");
    const closeError = new Error("close failed");
    const finalizeError = new Error("finalize failed");
    const reportError = vi.fn();
    const quit = vi.fn();
    const handleShutdown = createGracefulShutdownHandler({
      prepare: () => {
        throw prepareError;
      },
      close: async () => {
        throw closeError;
      },
      finalize: () => {
        throw finalizeError;
      },
      quit,
      reportError,
    });

    handleShutdown({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());

    expect(reportError.mock.calls).toEqual([[prepareError], [closeError], [finalizeError]]);
  });

  it("keeps the app open when the autosave preflight fails and permits a retry", async () => {
    const preflight = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("autosave failed"))
      .mockResolvedValue(undefined);
    const close = vi.fn(async () => undefined);
    const quit = vi.fn();
    const reportError = vi.fn();
    const handleShutdown = createGracefulShutdownHandler({ preflight, close, quit, reportError });

    handleShutdown({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(reportError).toHaveBeenCalledOnce());
    expect(close).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();

    handleShutdown({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
    expect(preflight).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
  });
});
