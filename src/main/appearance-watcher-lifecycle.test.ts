import { describe, expect, it, vi } from "vitest";
import { AppearanceWatcherLifecycle } from "./appearance-watcher-lifecycle";

interface FakeWatcher {
  invalidate: () => Promise<void>;
  closeCalls: () => number;
  close: () => void;
}

function flush(): Promise<void> {
  return Promise.resolve().then(() => Promise.resolve());
}

describe("AppearanceWatcherLifecycle", () => {
  it("supersedes a pending vault watcher before it can reload or remain open", async () => {
    const reload = vi.fn(async () => undefined);
    const created: FakeWatcher[] = [];
    const lifecycle = new AppearanceWatcherLifecycle({
      createWatcher: async (_target, onInvalidation) => {
        let closeCount = 0;
        const watcher: FakeWatcher = {
          closeCalls: () => closeCount,
          close: () => {
            closeCount += 1;
          },
          invalidate: () => Promise.resolve(onInvalidation({ reason: "filesystem-event" })),
        };
        created.push(watcher);
        return watcher;
      },
      reload,
    });

    lifecycle.reconcile({ vaultId: "vault-a", vaultPath: "/vault-a" });
    lifecycle.reconcile({ vaultId: "vault-b", vaultPath: "/vault-b" });
    await flush();

    expect(created).toHaveLength(2);
    expect(created[0]?.closeCalls()).toBe(1);
    await created[0]?.invalidate();
    expect(reload).not.toHaveBeenCalled();

    await created[1]?.invalidate();
    expect(reload).toHaveBeenCalledWith({ vaultId: "vault-b", vaultPath: "/vault-b" });
    await lifecycle.close();
    expect(created[1]?.closeCalls()).toBe(1);
  });

  it("keeps one watcher for repeated snapshots of the same real vault and stops it on shutdown", async () => {
    let closeCount = 0;
    const createWatcher = vi.fn(async (_target, onInvalidation) => {
      return {
        close: () => {
          closeCount += 1;
        },
        invalidate: () => Promise.resolve(onInvalidation({ reason: "overflow" })),
      };
    });
    const lifecycle = new AppearanceWatcherLifecycle({
      createWatcher,
      reload: vi.fn(async () => undefined),
    });

    lifecycle.reconcile({ vaultId: "vault", vaultPath: "/vault" });
    await flush();
    lifecycle.reconcile({ vaultId: "vault", vaultPath: "/vault" });
    await flush();
    expect(createWatcher).toHaveBeenCalledTimes(1);

    await lifecycle.close();
    expect(closeCount).toBe(1);
  });
});
