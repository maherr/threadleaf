export type AppUpdatePhase =
  | "disabled"
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "up-to-date"
  | "error";

export type AppUpdateDisabledReason =
  | "development-build"
  | "unsupported-platform"
  | "unsigned-package"
  | "updater-unavailable";

export interface AppUpdateProgress {
  bytesPerSecond: number;
  percent: number;
  transferred: number;
  total: number;
}

export interface AppUpdateSnapshot {
  phase: AppUpdatePhase;
  currentVersion: string;
  availableVersion: string | null;
  checkedAt: string | null;
  disabledReason: AppUpdateDisabledReason | null;
  message: string;
  progress: AppUpdateProgress | null;
  canCheck: boolean;
  canDownload: boolean;
  canInstall: boolean;
}
