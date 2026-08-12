import type {
  AppUpdateDisabledReason,
  AppUpdatePhase,
  AppUpdateProgress,
  AppUpdateSnapshot,
} from "../shared/app-updates";

export interface UpdateCheckResult {
  available: boolean;
  version: string;
}

export interface AppUpdateProvider {
  checkForUpdates(): Promise<UpdateCheckResult>;
  downloadUpdate(): Promise<void>;
  quitAndInstall(): void;
  onChecking(listener: () => void): void;
  onAvailable(listener: (version: string) => void): void;
  onNotAvailable(listener: () => void): void;
  onDownloadProgress(listener: (progress: AppUpdateProgress) => void): void;
  onDownloaded(listener: (version: string) => void): void;
  onError(listener: (error: Error) => void): void;
}

interface AppUpdateControllerOptions {
  currentVersion: string;
  disabledReason?: AppUpdateDisabledReason;
  now?: () => Date;
  provider?: AppUpdateProvider;
  reportError?: (error: unknown) => void;
}

interface MutableUpdateState {
  phase: AppUpdatePhase;
  availableVersion: string | null;
  checkedAt: string | null;
  message: string;
  progress: AppUpdateProgress | null;
}

const disabledMessages: Record<AppUpdateDisabledReason, string> = {
  "development-build": "Updates are disabled in development builds.",
  "unsupported-platform": "Use your Linux package manager to update this installation.",
  "unsigned-package": "This unsigned contributor package cannot install updates.",
  "updater-unavailable": "The signed update service could not be initialized.",
};

export class AppUpdateController {
  readonly #currentVersion: string;
  readonly #disabledReason: AppUpdateDisabledReason | null;
  readonly #listeners = new Set<(snapshot: AppUpdateSnapshot) => void>();
  readonly #now: () => Date;
  readonly #provider: AppUpdateProvider | null;
  readonly #reportError: (error: unknown) => void;
  #operation: Promise<AppUpdateSnapshot> | null = null;
  #state: MutableUpdateState;

  constructor(options: AppUpdateControllerOptions) {
    this.#currentVersion = options.currentVersion;
    this.#provider = options.provider ?? null;
    const disabledReason = this.#provider ? null : (options.disabledReason ?? "development-build");
    this.#disabledReason = disabledReason;
    this.#now = options.now ?? (() => new Date());
    this.#reportError = options.reportError ?? (() => undefined);
    this.#state = this.#provider
      ? {
          phase: "idle",
          availableVersion: null,
          checkedAt: null,
          message: "Check manually when you want Threadleaf to contact the release service.",
          progress: null,
        }
      : {
          phase: "disabled",
          availableVersion: null,
          checkedAt: null,
          message: disabledMessages[disabledReason ?? "development-build"],
          progress: null,
        };
    this.#bindProvider();
  }

  getSnapshot(): AppUpdateSnapshot {
    const phase = this.#state.phase;
    return {
      phase,
      currentVersion: this.#currentVersion,
      availableVersion: this.#state.availableVersion,
      checkedAt: this.#state.checkedAt,
      disabledReason: this.#disabledReason,
      message: this.#state.message,
      progress: this.#state.progress ? { ...this.#state.progress } : null,
      canCheck: Boolean(this.#provider) && ["idle", "up-to-date", "error"].includes(phase),
      canDownload: Boolean(this.#provider) && phase === "available",
      canInstall: Boolean(this.#provider) && phase === "downloaded",
    };
  }

  onSnapshot(listener: (snapshot: AppUpdateSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  checkForUpdates(): Promise<AppUpdateSnapshot> {
    if (!this.#provider) {
      return Promise.resolve(this.getSnapshot());
    }
    if (this.#operation) {
      return this.#operation;
    }
    if (!["idle", "up-to-date", "error"].includes(this.#state.phase)) {
      return Promise.resolve(this.getSnapshot());
    }
    this.#transition({
      phase: "checking",
      availableVersion: null,
      message: "Checking the signed Threadleaf release channel.",
      progress: null,
    });
    return this.#run(async () => {
      const result = await this.#provider?.checkForUpdates();
      if (this.#state.phase === "checking" && result) {
        if (result.available) {
          this.#markAvailable(result.version);
        } else {
          this.#markNotAvailable();
        }
      }
    });
  }

  downloadUpdate(): Promise<AppUpdateSnapshot> {
    if (!this.#provider || this.#state.phase !== "available") {
      return Promise.resolve(this.getSnapshot());
    }
    const provider = this.#provider;
    if (this.#operation) {
      return this.#operation;
    }
    this.#transition({
      phase: "downloading",
      message: `Downloading Threadleaf ${this.#state.availableVersion ?? "update"}.`,
      progress: { bytesPerSecond: 0, percent: 0, transferred: 0, total: 0 },
    });
    const version = this.#state.availableVersion;
    return this.#run(async () => {
      await provider.downloadUpdate();
      if (version && this.#state.phase === "downloading") {
        this.#markDownloaded(version);
      }
    });
  }

  installUpdate(): AppUpdateSnapshot {
    if (!this.#provider || this.#state.phase !== "downloaded") {
      return this.getSnapshot();
    }
    this.#transition({
      phase: "installing",
      message: "Closing Threadleaf to install the verified update.",
      progress: null,
    });
    try {
      this.#provider.quitAndInstall();
    } catch (error) {
      this.#markError(error);
    }
    return this.getSnapshot();
  }

  #bindProvider(): void {
    const provider = this.#provider;
    if (!provider) {
      return;
    }
    provider.onChecking(() => {
      if (this.#state.phase !== "checking") {
        this.#transition({
          phase: "checking",
          availableVersion: null,
          message: "Checking the signed Threadleaf release channel.",
          progress: null,
        });
      }
    });
    provider.onAvailable((version) => this.#markAvailable(version));
    provider.onNotAvailable(() => this.#markNotAvailable());
    provider.onDownloadProgress((progress) => {
      this.#transition({
        phase: "downloading",
        message: `Downloading Threadleaf ${this.#state.availableVersion ?? "update"}.`,
        progress: normalizeProgress(progress),
      });
    });
    provider.onDownloaded((version) => this.#markDownloaded(version));
    provider.onError((error) => this.#markError(error));
  }

  #markAvailable(version: string): void {
    this.#transition({
      phase: "available",
      availableVersion: version,
      checkedAt: this.#now().toISOString(),
      message: `Threadleaf ${version} is available. Download starts only when you ask.`,
      progress: null,
    });
  }

  #markNotAvailable(): void {
    this.#transition({
      phase: "up-to-date",
      availableVersion: null,
      checkedAt: this.#now().toISOString(),
      message: `Threadleaf ${this.#currentVersion} is up to date.`,
      progress: null,
    });
  }

  #markDownloaded(version: string): void {
    if (this.#state.phase !== "downloading") {
      return;
    }
    this.#transition({
      phase: "downloaded",
      availableVersion: version,
      message: `Threadleaf ${version} is verified and ready to install.`,
      progress: null,
    });
  }

  #markError(error: unknown): void {
    this.#reportError(error);
    this.#transition({
      phase: "error",
      message: "The update operation failed. Your current installation was left unchanged.",
      progress: null,
    });
  }

  #run(operation: () => Promise<unknown> | undefined): Promise<AppUpdateSnapshot> {
    const running = Promise.resolve()
      .then(operation)
      .catch((error: unknown) => this.#markError(error))
      .then(() => this.getSnapshot())
      .finally(() => {
        if (this.#operation === running) {
          this.#operation = null;
        }
      });
    this.#operation = running;
    return running;
  }

  #transition(update: Partial<MutableUpdateState>): void {
    this.#state = { ...this.#state, ...update };
    const snapshot = this.getSnapshot();
    for (const listener of this.#listeners) {
      listener(snapshot);
    }
  }
}

function normalizeProgress(progress: AppUpdateProgress): AppUpdateProgress {
  const total = Math.max(0, finite(progress.total));
  const transferred = Math.min(
    total || Number.MAX_SAFE_INTEGER,
    Math.max(0, finite(progress.transferred)),
  );
  return {
    bytesPerSecond: Math.max(0, finite(progress.bytesPerSecond)),
    percent: Math.min(100, Math.max(0, finite(progress.percent))),
    transferred,
    total,
  };
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
