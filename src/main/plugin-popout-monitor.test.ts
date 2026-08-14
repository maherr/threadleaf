import { describe, expect, it, vi } from "vitest";
import {
  clearPluginPopoutMonitor,
  isCurrentPluginPopoutMonitor,
  type PluginPopoutMonitorHandle,
} from "./plugin-popout-monitor";

describe("plugin pop-out monitor ownership", () => {
  it("keeps a delayed P1 callback from clearing P2's monitor", () => {
    const p1 = {};
    const p2 = {};
    const monitorP2: PluginPopoutMonitorHandle<object> = {
      owner: p2,
      generation: 2,
      timer: vi.fn() as unknown as NodeJS.Timeout,
    };

    expect(clearPluginPopoutMonitor(monitorP2, p1, 1)).toBe(monitorP2);
    expect(isCurrentPluginPopoutMonitor(monitorP2, p2, 2)).toBe(true);
  });

  it("clears a monitor only for its matching window generation", () => {
    const owner = {};
    const timer = vi.fn() as unknown as NodeJS.Timeout;
    const monitor: PluginPopoutMonitorHandle<object> = {
      owner,
      generation: 7,
      timer,
    };

    expect(clearPluginPopoutMonitor(monitor, owner, 7)).toBeUndefined();
    expect(timer).not.toHaveBeenCalled();
  });

  it.each([
    ["close delay", 1, 2],
    ["renderer crash", 1, 2],
    ["load failure cleanup", 1, 2],
    ["reattach", 1, 2],
    ["vault switch", 1, 2],
    ["rapid replacement", 1, 2],
  ])(
    "requires the matching window generation for %s",
    (_scenario, ownerGeneration, callbackGeneration) => {
      const owner = {};
      const monitor: PluginPopoutMonitorHandle<object> = {
        owner,
        generation: ownerGeneration,
        timer: vi.fn() as unknown as NodeJS.Timeout,
      };

      expect(isCurrentPluginPopoutMonitor(monitor, owner, callbackGeneration)).toBe(false);
      expect(isCurrentPluginPopoutMonitor(monitor, {}, ownerGeneration)).toBe(false);
    },
  );
});
