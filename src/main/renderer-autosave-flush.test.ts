import { describe, expect, it, vi } from "vitest";
import type { AutosaveFlushRequest } from "../shared/autosave";
import { RendererAutosaveFlushCoordinator } from "./renderer-autosave-flush";

describe("RendererAutosaveFlushCoordinator", () => {
  it("waits for the matching renderer acknowledgement", async () => {
    let request: AutosaveFlushRequest | undefined;
    const coordinator = new RendererAutosaveFlushCoordinator({
      send: (_senderId, value) => {
        request = value;
      },
    });
    const result = coordinator.request(42, "window-close");
    expect(request?.reason).toBe("window-close");
    expect(coordinator.complete(7, { requestId: request!.requestId, status: "flushed" })).toBe(
      false,
    );
    expect(coordinator.complete(42, { requestId: request!.requestId, status: "flushed" })).toBe(
      true,
    );
    await expect(result).resolves.toBeUndefined();
  });

  it("rejects a renderer-reported write failure", async () => {
    let request: AutosaveFlushRequest | undefined;
    const coordinator = new RendererAutosaveFlushCoordinator({
      send: (_senderId, value) => {
        request = value;
      },
    });
    const result = coordinator.request(9, "app-quit");
    coordinator.complete(9, {
      requestId: request!.requestId,
      status: "failed",
      message: "disk full",
    });
    await expect(result).rejects.toThrow("disk full");
  });

  it("fails closed when the renderer never acknowledges", async () => {
    vi.useFakeTimers();
    const coordinator = new RendererAutosaveFlushCoordinator({ send: () => undefined, timeoutMs: 5 });
    const result = coordinator.request(9, "window-close");
    const assertion = expect(result).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(5);
    await assertion;
    vi.useRealTimers();
  });
});
