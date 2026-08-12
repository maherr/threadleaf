import { autoUpdater, type ProgressInfo } from "electron-updater";
import type { AppUpdateProvider, UpdateCheckResult } from "../application/app-update-controller";

export function createElectronUpdateProvider(): AppUpdateProvider {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.autoRunAppAfterInstall = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.disableWebInstaller = true;

  return {
    async checkForUpdates(): Promise<UpdateCheckResult> {
      const result = await autoUpdater.checkForUpdates();
      if (!result) {
        throw new Error("The update provider returned no result.");
      }
      return {
        available: result.isUpdateAvailable,
        version: result.updateInfo.version,
      };
    },
    async downloadUpdate(): Promise<void> {
      await autoUpdater.downloadUpdate();
    },
    quitAndInstall(): void {
      autoUpdater.quitAndInstall(false, true);
    },
    onChecking(listener): void {
      autoUpdater.on("checking-for-update", listener);
    },
    onAvailable(listener): void {
      autoUpdater.on("update-available", (info) => listener(info.version));
    },
    onNotAvailable(listener): void {
      autoUpdater.on("update-not-available", listener);
    },
    onDownloadProgress(listener): void {
      autoUpdater.on("download-progress", (progress: ProgressInfo) => {
        listener({
          bytesPerSecond: progress.bytesPerSecond,
          percent: progress.percent,
          transferred: progress.transferred,
          total: progress.total,
        });
      });
    },
    onDownloaded(listener): void {
      autoUpdater.on("update-downloaded", (info) => listener(info.version));
    },
    onError(listener): void {
      autoUpdater.on("error", listener);
    },
  };
}
