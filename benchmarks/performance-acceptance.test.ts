import { describe, expect, it } from "vitest";
import {
  closeElectronGracefully,
  parsePerformanceAcceptanceOptions,
  performanceAcceptanceDefaultTimeoutMs,
  performanceAcceptanceHardTimeoutMs,
  performanceAcceptanceMinimumMemAvailableKiB,
} from "./performance-acceptance";

describe("performance acceptance options", () => {
  it("caps every leg's hard timeout at twenty-five minutes", () => {
    expect(performanceAcceptanceHardTimeoutMs).toBe(1_500_000);
    expect(performanceAcceptanceDefaultTimeoutMs).toBe(1_200_000);
    expect(parsePerformanceAcceptanceOptions([]).timeoutMs).toBe(
      performanceAcceptanceDefaultTimeoutMs,
    );
    expect(
      parsePerformanceAcceptanceOptions([
        "--timeout-ms",
        String(performanceAcceptanceHardTimeoutMs),
      ]).timeoutMs,
    ).toBe(performanceAcceptanceHardTimeoutMs);
    expect(() =>
      parsePerformanceAcceptanceOptions([
        "--timeout-ms",
        String(performanceAcceptanceHardTimeoutMs + 1),
      ]),
    ).toThrow("no greater");
  });

  it("uses the eight-gibibyte heavy-gate admission threshold", () => {
    expect(performanceAcceptanceMinimumMemAvailableKiB).toBe(8_388_608);
    expect(parsePerformanceAcceptanceOptions(["--require-heavy-gate"]).requireHeavyGate).toBe(true);
  });

  it("supports a deterministic smoke corpus and an explicit abort validation", () => {
    const options = parsePerformanceAcceptanceOptions([
      "--variant",
      "smoke",
      "--force-electron-timeout",
    ]);
    expect(options.variant).toBe("smoke");
    expect(options.forceElectronTimeout).toBe(true);
  });
});

describe("Electron timeout cleanup", () => {
  it("requests a graceful Browser.close and falls back silently on a dead CDP port", async () => {
    const requests: string[] = [];
    await closeElectronGracefully({
      async send(method) {
        requests.push(method);
        return {};
      },
    });
    await expect(
      closeElectronGracefully({
        async send() {
          throw new Error("CDP disconnected");
        },
      }),
    ).resolves.toBeUndefined();
    expect(requests).toEqual(["Browser.close"]);
  });
});
