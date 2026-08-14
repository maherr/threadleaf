import { describe, expect, it } from "vitest";
import {
  LatestPluginSurfacePropagation,
  type PluginSurfacePreferenceTarget,
} from "./plugin-surface-preferences";

class DelayedWebContents implements PluginSurfacePreferenceTarget {
  destroyed = false;
  readonly executed: string[] = [];
  readonly pending: Array<{
    script: string;
    resolve: () => void;
  }> = [];

  isDestroyed(): boolean {
    return this.destroyed;
  }

  executeJavaScript(script: string): Promise<void> {
    return new Promise<void>((resolve) => {
      this.pending.push({ script, resolve: () => resolve() });
    }).then(() => {
      this.executed.push(script);
    });
  }

  releaseNext(): void {
    const next = this.pending.shift();
    if (!next) throw new Error("No delayed WebContents operation is pending.");
    next.resolve();
  }
}

describe("latest plugin surface preference propagation", () => {
  it("serializes delayed theme and accessibility updates and leaves B last", async () => {
    const propagation = new LatestPluginSurfacePropagation<DelayedWebContents>();
    const target = new DelayedWebContents();

    const themeA = propagation.schedule(target, "theme", () => target.executeJavaScript("theme:A"));
    for (let attempt = 0; attempt < 10 && target.pending.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    expect(target.pending).toHaveLength(1);
    const accessibilityB = propagation.schedule(target, "accessibility", () =>
      target.executeJavaScript("accessibility:B"),
    );

    target.releaseNext();
    for (let attempt = 0; attempt < 10 && target.pending.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    expect(target.pending).toHaveLength(1);
    target.releaseNext();
    await Promise.all([themeA, accessibilityB]);

    expect(target.executed).toEqual(["theme:A", "accessibility:B"]);
  });

  it.each(["theme", "accessibility"] as const)(
    "drops superseded %s work and invalidates delayed work before view recreation",
    async (channel) => {
      const propagation = new LatestPluginSurfacePropagation<DelayedWebContents>();
      const oldView = new DelayedWebContents();
      const queuedA = propagation.schedule(oldView, channel, () =>
        oldView.executeJavaScript(`${channel}:A`),
      );
      const latestB = propagation.schedule(oldView, channel, () =>
        oldView.executeJavaScript(`${channel}:B`),
      );

      for (let attempt = 0; attempt < 10 && oldView.pending.length === 0; attempt += 1) {
        await Promise.resolve();
      }
      expect(oldView.pending).toHaveLength(1);
      oldView.releaseNext();
      await Promise.all([queuedA, latestB]);
      expect(oldView.executed).toEqual([`${channel}:B`]);
      expect(oldView.pending).toHaveLength(0);

      const delayedOldView = new DelayedWebContents();
      const delayedA = propagation.schedule(delayedOldView, channel, () =>
        delayedOldView.executeJavaScript(`${channel}:A`),
      );
      delayedOldView.destroyed = true;
      propagation.invalidate(delayedOldView);

      oldView.destroyed = true;
      propagation.invalidate(oldView);
      const newView = new DelayedWebContents();
      const recreated = propagation.schedule(newView, channel, () =>
        newView.executeJavaScript(`${channel}:B`),
      );
      for (let attempt = 0; attempt < 10 && newView.pending.length === 0; attempt += 1) {
        await Promise.resolve();
      }
      newView.releaseNext();
      await recreated;
      await delayedA;

      expect(oldView.executed).toEqual([`${channel}:B`]);
      expect(delayedOldView.executed).toEqual([]);
      expect(delayedOldView.pending).toHaveLength(0);
      expect(newView.executed).toEqual([`${channel}:B`]);
    },
  );
});
