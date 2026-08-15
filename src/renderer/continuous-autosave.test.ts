import { describe, expect, it, vi } from "vitest";
import { autosaveFlushReasons } from "../shared/autosave";
import { ContinuousAutosave, continuousAutosaveDelayMs } from "./continuous-autosave";

describe("ContinuousAutosave", () => {
  it("debounces edits for 1.5 seconds and persists only the latest snapshot", async () => {
    vi.useFakeTimers();
    let content = "first";
    const persist = vi.fn(async (_value: string) => undefined);
    const autosave = new ContinuousAutosave({ capture: () => content, persist });

    autosave.changed();
    await vi.advanceTimersByTimeAsync(continuousAutosaveDelayMs - 1);
    expect(persist).not.toHaveBeenCalled();
    content = "second";
    autosave.changed();
    await vi.advanceTimersByTimeAsync(continuousAutosaveDelayMs);

    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith("second");
    expect(autosave.pending).toBe(false);
    vi.useRealTimers();
  });

  it.each(autosaveFlushReasons)("flushes immediately for %s", async (reason) => {
    vi.useFakeTimers();
    const persist = vi.fn(async (_value: string) => undefined);
    const autosave = new ContinuousAutosave({ capture: () => reason, persist });
    autosave.changed();

    await autosave.flush(reason);

    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith(reason);
    await vi.advanceTimersByTimeAsync(continuousAutosaveDelayMs);
    expect(persist).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("waits for an in-flight write and then persists edits made during that write", async () => {
    let content = "first";
    let releaseFirst: (() => void) | undefined;
    const persisted: string[] = [];
    const persist = vi.fn(
      (value: string) =>
        new Promise<void>((resolve) => {
          persisted.push(value);
          if (value === "first") releaseFirst = resolve;
          else resolve();
        }),
    );
    const autosave = new ContinuousAutosave({ capture: () => content, persist, delayMs: 0 });
    autosave.changed();
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
    content = "second";
    autosave.changed();

    const flushed = autosave.flush("tab-close");
    releaseFirst?.();
    await flushed;

    expect(persisted).toEqual(["first", "second"]);
    expect(autosave.pending).toBe(false);
  });

  it("does not write when capture reports a read-only editor", async () => {
    const persist = vi.fn(async (_value: string) => undefined);
    const autosave = new ContinuousAutosave<string>({ capture: () => null, persist });
    autosave.changed();

    await autosave.flush("window-blur");

    expect(persist).not.toHaveBeenCalled();
    expect(autosave.pending).toBe(false);
  });

  it("keeps a failed version pending for a later edit or transition retry", async () => {
    const persist = vi
      .fn<(value: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("writer unavailable"))
      .mockResolvedValue(undefined);
    const autosave = new ContinuousAutosave({ capture: () => "text", persist });
    autosave.changed();

    await expect(autosave.flush("note-switch")).rejects.toThrow("writer unavailable");
    expect(autosave.pending).toBe(true);
    expect(autosave.error?.message).toBe("writer unavailable");

    autosave.changed();
    await autosave.flush("note-switch");
    expect(persist).toHaveBeenCalledTimes(2);
    expect(autosave.pending).toBe(false);
  });
});
