import { type Dirent, promises as fs, watch } from "node:fs";
import path from "node:path";

export type AppearanceWatchInvalidationReason =
  | "filesystem-event"
  | "source-root-replaced"
  | "ambiguous-event"
  | "backend-error"
  | "overflow";

export interface AppearanceWatchInvalidation {
  reason: AppearanceWatchInvalidationReason;
}

export type AppearanceWatchEventListener = (
  eventType: string,
  filename: string | Buffer | null,
) => void;

export interface AppearanceWatchHandle {
  close(): void;
  on(event: "error", listener: (error: unknown) => void): unknown;
}

export interface AppearanceWatchBackend {
  realpath(targetPath: string): Promise<string>;
  stat(targetPath: string): Promise<{ isDirectory(): boolean }>;
  readdir(targetPath: string): Promise<Dirent<string>[]>;
  watch(targetPath: string, listener: AppearanceWatchEventListener): AppearanceWatchHandle;
}

export interface AppearanceWatchScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface VaultAppearanceWatcherOptions {
  vaultPath: string;
  debounceMs?: number;
  backend?: AppearanceWatchBackend;
  scheduler?: AppearanceWatchScheduler;
  onInvalidation: (invalidation: AppearanceWatchInvalidation) => void | Promise<void>;
  onError?: (error: unknown) => void;
}

type WatchRole = "vault" | "obsidian" | "themes" | "theme" | "snippets";

const defaultBackend: AppearanceWatchBackend = {
  realpath: (targetPath) => fs.realpath(targetPath),
  stat: (targetPath) => fs.stat(targetPath),
  readdir: (targetPath) => fs.readdir(targetPath, { withFileTypes: true }),
  watch: (targetPath, listener) => watch(targetPath, { persistent: false }, listener),
};

const defaultScheduler: AppearanceWatchScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : null;
}

function isContained(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function filenameSegments(filename: string | Buffer): string[] {
  return filename.toString().replaceAll("\\", "/").split("/").filter(Boolean);
}

function reasonPriority(reason: AppearanceWatchInvalidationReason): number {
  switch (reason) {
    case "backend-error":
      return 5;
    case "overflow":
      return 4;
    case "source-root-replaced":
      return 3;
    case "ambiguous-event":
      return 2;
    case "filesystem-event":
      return 1;
  }
}

/**
 * Watches only appearance source directories. Every accepted event is deliberately reduced to a
 * complete loader refresh; this class never reads CSS or attempts an incremental catalog diff.
 */
export class VaultAppearanceWatcher {
  readonly #vaultPath: string;
  readonly #debounceMs: number;
  readonly #backend: AppearanceWatchBackend;
  readonly #scheduler: AppearanceWatchScheduler;
  readonly #onInvalidation: VaultAppearanceWatcherOptions["onInvalidation"];
  readonly #onError: (error: unknown) => void;
  readonly #handles = new Map<string, AppearanceWatchHandle>();
  readonly #pendingReasons = new Set<AppearanceWatchInvalidationReason>();
  #canonicalVaultPath = "";
  #timer: unknown;
  #flushTail: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(options: VaultAppearanceWatcherOptions) {
    this.#vaultPath = options.vaultPath;
    this.#debounceMs = options.debounceMs ?? 80;
    this.#backend = options.backend ?? defaultBackend;
    this.#scheduler = options.scheduler ?? defaultScheduler;
    this.#onInvalidation = options.onInvalidation;
    this.#onError = options.onError ?? (() => undefined);
  }

  static async open(options: VaultAppearanceWatcherOptions): Promise<VaultAppearanceWatcher> {
    const watcher = new VaultAppearanceWatcher(options);
    try {
      watcher.#canonicalVaultPath = await watcher.#backend.realpath(options.vaultPath);
      if (!(await watcher.#backend.stat(watcher.#canonicalVaultPath)).isDirectory()) {
        throw new Error("The active vault is no longer a readable directory.");
      }
    } catch (error) {
      watcher.#onError(error);
      throw new Error("The active vault is no longer a readable directory.");
    }
    await watcher.#refreshHandles();
    return watcher;
  }

  reportOverflow(): void {
    this.#schedule("overflow");
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    if (this.#timer !== undefined) {
      this.#scheduler.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#pendingReasons.clear();
    this.#closeHandles();
    await this.#flushTail;
  }

  whenIdle(): Promise<void> {
    return this.#flushTail;
  }

  async #containedDirectory(targetPath: string, containmentRoot: string): Promise<string | null> {
    try {
      const canonicalPath = await this.#backend.realpath(targetPath);
      if (!isContained(containmentRoot, canonicalPath)) {
        throw new Error("appearance source resolves outside the active vault");
      }
      if (!(await this.#backend.stat(canonicalPath)).isDirectory()) {
        throw new Error("appearance source is not a directory");
      }
      return canonicalPath;
    } catch (error) {
      if (new Set(["ENOENT", "ENOTDIR"]).has(errorCode(error) ?? "")) {
        return null;
      }
      this.#onError(error);
      return null;
    }
  }

  async #refreshHandles(): Promise<void> {
    this.#closeHandles();
    if (this.#closed) {
      return;
    }

    this.#watch("vault", this.#canonicalVaultPath);
    const obsidianPath = await this.#containedDirectory(
      path.join(this.#canonicalVaultPath, ".obsidian"),
      this.#canonicalVaultPath,
    );
    if (!obsidianPath || this.#closed) {
      return;
    }
    this.#watch("obsidian", obsidianPath);

    const themesPath = await this.#containedDirectory(
      path.join(obsidianPath, "themes"),
      obsidianPath,
    );
    if (themesPath && !this.#closed) {
      this.#watch("themes", themesPath);
      await this.#watchThemeDirectories(themesPath);
    }

    const snippetsPath = await this.#containedDirectory(
      path.join(obsidianPath, "snippets"),
      obsidianPath,
    );
    if (snippetsPath && !this.#closed) {
      this.#watch("snippets", snippetsPath);
    }
  }

  async #watchThemeDirectories(themesPath: string): Promise<void> {
    try {
      const entries = await this.#backend.readdir(themesPath);
      for (const entry of entries) {
        if (this.#closed || !(entry.isDirectory() || entry.isSymbolicLink())) {
          continue;
        }
        const themeDirectory = await this.#containedDirectory(
          path.join(themesPath, entry.name),
          themesPath,
        );
        if (themeDirectory && !this.#handles.has(`theme:${themeDirectory}`)) {
          this.#watch("theme", themeDirectory);
        }
      }
    } catch (error) {
      this.#onError(error);
    }
  }

  #watch(role: WatchRole, targetPath: string): void {
    if (this.#closed || this.#handles.has(`${role}:${targetPath}`)) {
      return;
    }
    try {
      const handle = this.#backend.watch(targetPath, (eventType, filename) => {
        this.#onFilesystemEvent(role, eventType, filename);
      });
      handle.on("error", (error) => {
        if (this.#closed) {
          return;
        }
        this.#onError(error);
        this.#schedule("backend-error");
      });
      this.#handles.set(`${role}:${targetPath}`, handle);
    } catch (error) {
      this.#onError(error);
    }
  }

  #onFilesystemEvent(role: WatchRole, eventType: string, filename: string | Buffer | null): void {
    if (this.#closed) {
      return;
    }
    if (eventType === "overflow") {
      this.#schedule("overflow");
      return;
    }
    if (!filename) {
      this.#schedule("ambiguous-event");
      return;
    }
    const segments = filenameSegments(filename);
    const first = segments[0];
    if (!first) {
      this.#schedule("ambiguous-event");
      return;
    }
    if (role === "vault") {
      if (first === ".obsidian" && segments.length === 1) {
        this.#schedule("source-root-replaced");
      }
      return;
    }
    if (role === "obsidian") {
      if (first === "themes" || first === "snippets") {
        this.#schedule("source-root-replaced");
      }
      return;
    }
    if (role === "themes") {
      this.#schedule("filesystem-event");
      return;
    }
    if (role === "theme") {
      if (first === "theme.css" || first === "manifest.json") {
        this.#schedule("filesystem-event");
      }
      return;
    }
    if (first.toLocaleLowerCase("en-US").endsWith(".css")) {
      this.#schedule("filesystem-event");
    }
  }

  #schedule(reason: AppearanceWatchInvalidationReason): void {
    if (this.#closed) {
      return;
    }
    this.#pendingReasons.add(reason);
    if (this.#timer !== undefined) {
      return;
    }
    this.#timer = this.#scheduler.setTimeout(() => {
      this.#timer = undefined;
      const reasons = [...this.#pendingReasons];
      this.#pendingReasons.clear();
      this.#flushTail = this.#flushTail.then(() => this.#flush(reasons));
    }, this.#debounceMs);
  }

  async #flush(reasons: AppearanceWatchInvalidationReason[]): Promise<void> {
    if (this.#closed) {
      return;
    }
    try {
      await this.#refreshHandles();
      if (this.#closed) {
        return;
      }
      const reason = reasons.reduce<AppearanceWatchInvalidationReason>(
        (mostSevere, candidate) =>
          reasonPriority(candidate) > reasonPriority(mostSevere) ? candidate : mostSevere,
        "filesystem-event",
      );
      await this.#onInvalidation({ reason });
    } catch (error) {
      if (!this.#closed) {
        this.#onError(error);
        await Promise.resolve(this.#onInvalidation({ reason: "backend-error" })).catch(
          this.#onError,
        );
      }
    }
  }

  #closeHandles(): void {
    for (const handle of this.#handles.values()) {
      try {
        handle.close();
      } catch (error) {
        this.#onError(error);
      }
    }
    this.#handles.clear();
  }
}
