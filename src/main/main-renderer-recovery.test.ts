import { describe, expect, it, vi } from "vitest";
import { createMainRendererRecoveryHandler } from "./main-renderer-recovery";

describe("createMainRendererRecoveryHandler", () => {
  it("prepares and replaces the window after an abnormal renderer exit", () => {
    const recover = vi.fn();
    const prepare = vi.fn();
    const report = vi.fn();
    const scheduled: Array<() => void> = [];
    const handler = createMainRendererRecoveryHandler({
      prepare,
      recover,
      report,
      schedule: (operation) => scheduled.push(operation),
    });

    handler({ reason: "crashed", exitCode: 139 });
    expect(prepare).toHaveBeenCalledOnce();
    expect(scheduled).toHaveLength(1);
    scheduled[0]?.();
    expect(recover).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith("Threadleaf main renderer exited", {
      reason: "crashed",
      exitCode: 139,
    });
  });

  it("does not recover a clean exit", () => {
    const recover = vi.fn();
    const scheduled: Array<() => void> = [];
    const handler = createMainRendererRecoveryHandler({
      prepare: vi.fn(),
      recover,
      report: vi.fn(),
      schedule: (operation) => scheduled.push(operation),
    });

    handler({ reason: "clean-exit", exitCode: 0 });
    expect(scheduled).toHaveLength(0);
    expect(recover).not.toHaveBeenCalled();
  });

  it("bounds automatic recovery loops inside the configured window", () => {
    let currentTime = 1_000;
    const schedule = vi.fn();
    const report = vi.fn();
    const handler = createMainRendererRecoveryHandler({
      prepare: vi.fn(),
      recover: vi.fn(),
      report,
      schedule,
      now: () => currentTime,
      maximumAttempts: 2,
      attemptWindowMs: 1_000,
    });

    handler({ reason: "crashed", exitCode: 1 });
    handler({ reason: "crashed", exitCode: 1 });
    handler({ reason: "crashed", exitCode: 1 });
    expect(schedule).toHaveBeenCalledTimes(2);
    expect(report.mock.calls.at(-1)?.[0]).toContain("stopped automatic renderer recovery");

    currentTime = 2_001;
    handler({ reason: "crashed", exitCode: 1 });
    expect(schedule).toHaveBeenCalledTimes(3);
  });

  it("reports an asynchronous replacement failure", async () => {
    const report = vi.fn();
    const scheduled: Array<() => void> = [];
    const failure = new Error("replacement failed");
    const handler = createMainRendererRecoveryHandler({
      prepare: vi.fn(),
      recover: () => Promise.reject(failure),
      report,
      schedule: (operation) => scheduled.push(operation),
    });

    handler({ reason: "crashed", exitCode: 1 });
    scheduled[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(report).toHaveBeenCalledWith(
      "Threadleaf could not replace the stopped renderer",
      failure,
    );
  });
});
