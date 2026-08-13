import { afterEach, describe, expect, it, vi } from "vitest";
import { pluginRendererOperations } from "../shared/plugin-resource-policy";
import { PluginResourceMonitor, resourceDiagnosticForDeadline } from "./plugin-resource-policy";

interface FakeClock {
  clock: {
    now(): number;
    setTimeout(callback: () => void, delayMs: number): number;
    clearTimeout(handle: number): void;
    setInterval(callback: () => void, intervalMs: number): number;
    clearInterval(handle: number): void;
  };
  advance(milliseconds: number): void;
}

function fakeClock(): FakeClock {
  let now = 0;
  let nextId = 0;
  const intervals = new Map<number, { callback: () => void; intervalMs: number; nextAt: number }>();
  const clock: FakeClock = {
    clock: {
      now: () => now,
      setTimeout: (callback) => {
        const id = ++nextId;
        intervals.set(id, { callback, intervalMs: Number.POSITIVE_INFINITY, nextAt: now });
        return id;
      },
      clearTimeout: (id) => intervals.delete(id),
      setInterval: (callback, intervalMs) => {
        const id = ++nextId;
        intervals.set(id, { callback, intervalMs, nextAt: now + intervalMs });
        return id;
      },
      clearInterval: (id) => intervals.delete(id),
    },
    advance(milliseconds) {
      const end = now + milliseconds;
      while (now < end) {
        const next = [...intervals.values()]
          .filter(({ nextAt }) => nextAt <= end)
          .sort((left, right) => left.nextAt - right.nextAt)[0];
        if (!next) {
          now = end;
          break;
        }
        now = next.nextAt;
        for (const [id, candidate] of intervals) {
          if (candidate === next && candidate.nextAt <= now) {
            candidate.nextAt += candidate.intervalMs;
            candidate.callback();
            if (!Number.isFinite(candidate.intervalMs)) {
              intervals.delete(id);
            }
          }
        }
      }
    },
  };
  return clock;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PluginResourceMonitor", () => {
  it("keeps the real operation surface versioned, including startup and close", () => {
    const monitor = new PluginResourceMonitor();
    const snapshot = monitor.snapshot().policy;
    expect(snapshot.version).toBe(1);
    expect(Object.keys(snapshot.operationDeadlinesMs).sort()).toEqual(
      [...pluginRendererOperations].sort(),
    );
    expect(snapshot.operationDeadlinesMs.initialize).toBeGreaterThan(0);
    expect(snapshot.operationDeadlinesMs.close).toBeGreaterThan(0);
    expect(snapshot.operationDeadlinesMs.initialize).not.toBe(snapshot.operationDeadlinesMs.close);
  });

  it("never permits a one-sample CPU kill even when an override asks for one", () => {
    const monitor = new PluginResourceMonitor({ cpuConsecutiveSamples: 1 });
    expect(monitor.policy.cpuConsecutiveSamples).toBe(2);
  });

  it("reports unavailable metrics without fabricating a value or killing the renderer", async () => {
    const breach = vi.fn();
    const monitor = new PluginResourceMonitor(
      { cpuStartupQuietWindowMs: 0 },
      { metricsProvider: { sample: () => null }, onBreach: breach },
    );
    monitor.start(1234);
    await flush();

    const snapshot = monitor.snapshot();
    expect(snapshot.policy.state).toBe("monitoring");
    expect(snapshot.policy.metrics.memoryAvailable).toBe(false);
    expect(snapshot.policy.metrics.memoryBytes).toBeNull();
    expect(snapshot.policy.metrics.cpuAvailable).toBe(false);
    expect(snapshot.policy.metrics.cpuPercent).toBeNull();
    expect(
      snapshot.diagnostics.filter(({ reason }) => reason === "metrics-unavailable"),
    ).toHaveLength(2);
    expect(breach).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("enforces the memory ceiling only above the configured boundary", async () => {
    let memoryBytes = 100;
    const breach = vi.fn();
    const monitor = new PluginResourceMonitor(
      { memoryCeilingBytes: 100, cpuStartupQuietWindowMs: 0 },
      { metricsProvider: { sample: () => ({ memoryBytes }) }, onBreach: breach },
    );
    monitor.start(1234);
    await flush();
    expect(breach).not.toHaveBeenCalled();

    memoryBytes = 101;
    await monitor.sampleNow();
    expect(breach).toHaveBeenCalledOnce();
    expect(breach.mock.calls[0]?.[0]).toMatchObject({
      reason: "memory-ceiling",
      measuredValue: 101,
      configuredBudget: 100,
      unit: "bytes",
      available: true,
    });
  });

  it("requires the quiet window and consecutive CPU samples before enforcement", async () => {
    const fake = fakeClock();
    const breach = vi.fn();
    const monitor = new PluginResourceMonitor(
      {
        cpuBudgetPercent: 50,
        cpuConsecutiveSamples: 3,
        cpuSampleIntervalMs: 100,
        cpuStartupQuietWindowMs: 300,
      },
      {
        clock: fake.clock,
        metricsProvider: { sample: () => ({ cpuPercent: 90, memoryBytes: 10 }) },
        onBreach: breach,
      },
    );
    monitor.start(1234);
    await flush();
    fake.advance(100);
    await flush();
    fake.advance(100);
    await flush();
    expect(breach).not.toHaveBeenCalled();

    fake.advance(100);
    await flush();
    expect(breach).not.toHaveBeenCalled();
    fake.advance(100);
    await flush();
    expect(breach).not.toHaveBeenCalled();
    fake.advance(100);
    await flush();
    expect(breach).toHaveBeenCalledOnce();
    expect(breach.mock.calls[0]?.[0]).toMatchObject({
      reason: "cpu-budget",
      measuredValue: 90,
      configuredBudget: 50,
      sampleCount: 3,
      unit: "percent",
    });
  });

  it("resets sustained CPU enforcement after an under-budget sample", async () => {
    const cpuSamples = [90, 20, 90, 90, 90];
    const breach = vi.fn();
    const monitor = new PluginResourceMonitor(
      {
        cpuBudgetPercent: 50,
        cpuConsecutiveSamples: 3,
        cpuStartupQuietWindowMs: 0,
      },
      {
        metricsProvider: {
          sample: () => ({ cpuPercent: cpuSamples.shift() ?? 20, memoryBytes: 10 }),
        },
        onBreach: breach,
      },
    );

    monitor.start(1234);
    await flush();
    await monitor.sampleNow();
    await monitor.sampleNow();
    await monitor.sampleNow();
    expect(breach).not.toHaveBeenCalled();

    await monitor.sampleNow();
    expect(breach).toHaveBeenCalledOnce();
  });

  it("cleans the monitor on replacement and starts a fresh recovery window", async () => {
    const fake = fakeClock();
    let samples = 0;
    const monitor = new PluginResourceMonitor(
      { cpuStartupQuietWindowMs: 300, cpuSampleIntervalMs: 100, cpuConsecutiveSamples: 2 },
      {
        clock: fake.clock,
        metricsProvider: { sample: () => ({ cpuPercent: ++samples, memoryBytes: 1 }) },
      },
    );
    monitor.start(1234);
    await flush();
    monitor.stop();
    const stoppedSamples = samples;
    fake.advance(1_000);
    await flush();
    expect(samples).toBe(stoppedSamples);

    monitor.start(5678);
    await flush();
    expect(monitor.snapshot().policy.metrics.inStartupQuietWindow).toBe(true);
    monitor.stop();
  });

  it("keeps a replacement sample locked when a stale async sample finishes", async () => {
    const sampleResolvers: Array<(metrics: { cpuPercent: number; memoryBytes: number }) => void> =
      [];
    const sample = vi.fn(
      () =>
        new Promise<{ cpuPercent: number; memoryBytes: number }>((resolve) => {
          sampleResolvers.push(resolve);
        }),
    );
    const monitor = new PluginResourceMonitor(
      { cpuStartupQuietWindowMs: 0 },
      { metricsProvider: { sample } },
    );

    monitor.start(1234);
    monitor.start(5678);
    expect(sample).toHaveBeenCalledTimes(2);

    sampleResolvers[0]?.({ cpuPercent: 1, memoryBytes: 1 });
    await flush();
    await monitor.sampleNow();
    expect(sample).toHaveBeenCalledTimes(2);

    sampleResolvers[1]?.({ cpuPercent: 1, memoryBytes: 1 });
    await flush();
    const thirdSample = monitor.sampleNow();
    expect(sample).toHaveBeenCalledTimes(3);
    sampleResolvers[2]?.({ cpuPercent: 1, memoryBytes: 1 });
    await thirdSample;
    monitor.stop();
  });

  it("records a structured non-default deadline with measured elapsed time", () => {
    expect(
      resourceDiagnosticForDeadline(
        new PluginResourceMonitor().policy,
        "run-command",
        17,
        1_000,
        1_017,
      ),
    ).toMatchObject({
      reason: "operation-deadline",
      operation: "run-command",
      measuredValue: 17,
      configuredBudget: 30_000,
      unit: "milliseconds",
    });
  });
});
