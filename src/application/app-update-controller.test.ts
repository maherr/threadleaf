import { describe, expect, it } from "vitest";
import type { AppUpdateProgress } from "../shared/app-updates";
import {
  AppUpdateController,
  type AppUpdateProvider,
  type UpdateCheckResult,
} from "./app-update-controller";

class MemoryUpdateProvider implements AppUpdateProvider {
  checkResult: UpdateCheckResult = { available: false, version: "1.0.0" };
  checkCalls = 0;
  downloadCalls = 0;
  installCalls = 0;
  checkFailure: Error | null = null;
  downloadFailure: Error | null = null;
  readonly listeners = {
    checking: [] as Array<() => void>,
    available: [] as Array<(version: string) => void>,
    notAvailable: [] as Array<() => void>,
    progress: [] as Array<(progress: AppUpdateProgress) => void>,
    downloaded: [] as Array<(version: string) => void>,
    error: [] as Array<(error: Error) => void>,
  };

  async checkForUpdates(): Promise<UpdateCheckResult> {
    this.checkCalls += 1;
    this.emit(this.listeners.checking);
    if (this.checkFailure) throw this.checkFailure;
    if (this.checkResult.available) {
      this.emit(this.listeners.available, this.checkResult.version);
    } else {
      this.emit(this.listeners.notAvailable);
    }
    return this.checkResult;
  }

  async downloadUpdate(): Promise<void> {
    this.downloadCalls += 1;
    if (this.downloadFailure) throw this.downloadFailure;
  }

  quitAndInstall(): void {
    this.installCalls += 1;
  }

  onChecking(listener: () => void): void {
    this.listeners.checking.push(listener);
  }
  onAvailable(listener: (version: string) => void): void {
    this.listeners.available.push(listener);
  }
  onNotAvailable(listener: () => void): void {
    this.listeners.notAvailable.push(listener);
  }
  onDownloadProgress(listener: (progress: AppUpdateProgress) => void): void {
    this.listeners.progress.push(listener);
  }
  onDownloaded(listener: (version: string) => void): void {
    this.listeners.downloaded.push(listener);
  }
  onError(listener: (error: Error) => void): void {
    this.listeners.error.push(listener);
  }

  emit<T extends unknown[]>(listeners: Array<(...values: T) => void>, ...values: T): void {
    for (const listener of listeners) listener(...values);
  }
}

describe("AppUpdateController", () => {
  it("never contacts a provider when the package is ineligible", async () => {
    const controller = new AppUpdateController({
      currentVersion: "0.1.0-alpha.1",
      disabledReason: "unsigned-package",
    });
    expect(await controller.checkForUpdates()).toMatchObject({
      phase: "disabled",
      disabledReason: "unsigned-package",
      canCheck: false,
    });
  });

  it("checks only on demand and reports an up-to-date result", async () => {
    const provider = new MemoryUpdateProvider();
    const controller = new AppUpdateController({
      currentVersion: "1.0.0",
      provider,
      now: () => new Date("2026-08-12T14:00:00.000Z"),
    });
    expect(provider.checkCalls).toBe(0);
    expect(controller.getSnapshot()).toMatchObject({ phase: "idle", canCheck: true });

    expect(await controller.checkForUpdates()).toMatchObject({
      phase: "up-to-date",
      checkedAt: "2026-08-12T14:00:00.000Z",
      canCheck: true,
    });
    expect(provider.checkCalls).toBe(1);
  });

  it("requires explicit download and install actions", async () => {
    const provider = new MemoryUpdateProvider();
    provider.checkResult = { available: true, version: "1.1.0" };
    const controller = new AppUpdateController({ currentVersion: "1.0.0", provider });

    expect(await controller.downloadUpdate()).toMatchObject({ phase: "idle" });
    expect(controller.installUpdate()).toMatchObject({ phase: "idle" });
    expect(provider.downloadCalls).toBe(0);
    expect(provider.installCalls).toBe(0);

    expect(await controller.checkForUpdates()).toMatchObject({
      phase: "available",
      availableVersion: "1.1.0",
      canDownload: true,
    });
    expect(provider.downloadCalls).toBe(0);

    const download = controller.downloadUpdate();
    provider.emit(provider.listeners.progress, {
      bytesPerSecond: Number.NaN,
      percent: 141.5,
      transferred: 1_415,
      total: 1_000,
    });
    expect(controller.getSnapshot()).toMatchObject({
      phase: "downloading",
      progress: { bytesPerSecond: 0, percent: 100, transferred: 1_000, total: 1_000 },
    });
    await expect(download).resolves.toMatchObject({
      phase: "downloaded",
      availableVersion: "1.1.0",
      canInstall: true,
    });
    expect(provider.installCalls).toBe(0);

    expect(controller.installUpdate()).toMatchObject({ phase: "installing" });
    expect(provider.installCalls).toBe(1);
  });

  it("leaves the installed app unchanged and allows retry after an error", async () => {
    const provider = new MemoryUpdateProvider();
    provider.checkFailure = new Error("private network detail");
    const errors: unknown[] = [];
    const controller = new AppUpdateController({
      currentVersion: "1.0.0",
      provider,
      reportError: (error) => errors.push(error),
    });

    expect(await controller.checkForUpdates()).toMatchObject({
      phase: "error",
      canCheck: true,
      message: expect.not.stringContaining("private network detail"),
    });
    expect(errors).toHaveLength(1);
  });

  it("coalesces simultaneous checks into one provider request", async () => {
    let finish: ((value: UpdateCheckResult) => void) | undefined;
    const provider = new MemoryUpdateProvider();
    provider.checkForUpdates = () => {
      provider.checkCalls += 1;
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const controller = new AppUpdateController({ currentVersion: "1.0.0", provider });
    const first = controller.checkForUpdates();
    const second = controller.checkForUpdates();
    expect(first).toBe(second);
    expect(provider.checkCalls).toBe(0);
    await Promise.resolve();
    expect(provider.checkCalls).toBe(1);
    finish?.({ available: false, version: "1.0.0" });
    await expect(first).resolves.toMatchObject({ phase: "up-to-date" });
  });
});
