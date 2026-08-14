import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearPluginPopoutMonitor,
  isCurrentPluginPopoutMonitor,
  type PluginPopoutMonitorHandle,
} from "./plugin-popout-monitor";

describe("plugin pop-out monitor ownership", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps a delayed P1 callback from clearing P2's monitor", () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const p1 = {};
    const p2 = {};
    const timer = setInterval(() => {}, 1_000_000);
    const monitorP2: PluginPopoutMonitorHandle<object> = {
      owner: p2,
      generation: 2,
      timer,
    };

    expect(clearPluginPopoutMonitor(monitorP2, p1, 1)).toBe(monitorP2);
    expect(isCurrentPluginPopoutMonitor(monitorP2, p2, 2)).toBe(true);
    expect(clearIntervalSpy).not.toHaveBeenCalled();

    clearInterval(timer);
  });

  it("clears the registered timer only for its matching owner and generation", () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const owner = {};
    const timer = setInterval(() => {}, 1_000_000);
    const monitor: PluginPopoutMonitorHandle<object> = {
      owner,
      generation: 7,
      timer,
    };

    expect(clearPluginPopoutMonitor(monitor, owner, 7)).toBeUndefined();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
  });

  it.each([
    ["generation advanced past the callback's snapshot, same owner", 5, 2, true],
    ["generation rolled back below the callback's snapshot, same owner", 1, 9, true],
    ["matching generation but a different owner instance", 4, 4, false],
    ["unrelated stale callback: different owner and different generation", 1, 42, false],
  ] as const)("rejects a %s", (_scenario, ownerGeneration, callbackGeneration, sameOwner) => {
    const owner = {};
    const monitor: PluginPopoutMonitorHandle<object> = {
      owner,
      generation: ownerGeneration,
      timer: vi.fn() as unknown as NodeJS.Timeout,
    };
    const candidateOwner = sameOwner ? owner : {};

    expect(isCurrentPluginPopoutMonitor(monitor, candidateOwner, callbackGeneration)).toBe(false);
  });
});
