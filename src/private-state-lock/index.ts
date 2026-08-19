import { existsSync, lstatSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";

export type StateLockCode =
  | "busy"
  | "closed"
  | "compromised"
  | "invalid"
  | "io"
  | "migration-required"
  | "release-error"
  | "unsupported";

export type StateLockPlatform = "posix" | "windows";
export type StateLockMechanism = "flock" | "LockFileEx";

export class StateLockError extends Error {
  readonly code: StateLockCode;
  readonly state: "quiescent" | undefined;

  constructor(
    code: StateLockCode,
    message: string,
    options: { state?: "quiescent"; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "StateLockError";
    this.code = code;
    this.state = options.state;
  }
}

export class StateLockBusyError extends StateLockError {
  constructor(cause?: unknown) {
    super("busy", "Another process holds the Threadleaf state lock.", { cause });
    this.name = "StateLockBusyError";
  }
}

export class StateLockMigrationRequiredError extends StateLockError {
  constructor(cause?: unknown) {
    super(
      "migration-required",
      "The state-lock path is an existing directory; quiesce legacy writers and migrate explicitly.",
      { cause, state: "quiescent" },
    );
    this.name = "StateLockMigrationRequiredError";
  }
}

export interface NativeStateLockHandle {
  close(): void;
  assertPathIdentity(): void;
}

export interface ThreadleafNativeBinding {
  acquire(lockPath: string): NativeStateLockHandle;
  renameNoReplace(sourcePath: string, targetPath: string): void;
  openDirectoryNoFollowAt(parentDirectoryFd: number, name: string): number;
  openFileNoFollowAt(directoryFd: number, name: string, create: boolean): number;
  renameNoReplaceAt(
    sourceDirectoryFd: number,
    sourceName: string,
    targetDirectoryFd: number,
    targetName: string,
  ): void;
  probeAnonymousPublishNoName(targetDirectoryFd: number): void;
  publishBufferNoReplace(targetDirectoryFd: number, targetName: string, bytes: Buffer): void;
  platform(): StateLockPlatform;
  mechanism(): StateLockMechanism;
  napiVersion(): string;
}

export interface StateLockMetadata {
  path: string;
  platform: StateLockPlatform;
  mechanism: StateLockMechanism;
}

export interface StateLock extends StateLockMetadata {
  /** Assert that the persistent pathname still names the opened lock file. */
  assertPathIdentity(): void;
  /** Release the kernel-held authority. Idempotent after a successful close. */
  close(): void;
}

export interface AcquireStateLockAsyncOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 25;
const NODE_TIMER_MAX_MS = 2_147_483_647;

let binding: ThreadleafNativeBinding | undefined;
const nativeRequire = createRequire(path.resolve(process.cwd(), "package.json"));

function packagedNativePath(): string | undefined {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (!resourcesPath) {
    return undefined;
  }
  return path.join(
    resourcesPath,
    "app.asar.unpacked",
    "dist",
    "native",
    "threadleaf-state-lock.node",
  );
}

function isPackagedRuntime(): boolean {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (!resourcesPath) {
    return false;
  }
  const defaultApp = (process as NodeJS.Process & { defaultApp?: boolean }).defaultApp;
  return defaultApp === false || existsSync(path.join(resourcesPath, "app.asar"));
}

function pathIsWithin(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function hasSymlinkInPath(candidatePath: string): boolean {
  const parsed = path.parse(candidatePath);
  let current = parsed.root;
  try {
    if (lstatSync(current).isSymbolicLink()) {
      return true;
    }
    for (const component of path.relative(parsed.root, candidatePath).split(path.sep)) {
      if (!component) {
        continue;
      }
      current = path.join(current, component);
      if (lstatSync(current).isSymbolicLink()) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

function isRegularNativeFile(candidatePath: string): boolean {
  try {
    return lstatSync(candidatePath).isFile() && !hasSymlinkInPath(candidatePath);
  } catch {
    return false;
  }
}

function isAuthorizedDevelopmentNativePath(candidatePath: string): boolean {
  if (
    !path.isAbsolute(candidatePath) ||
    path.extname(candidatePath).toLowerCase() !== ".node" ||
    candidatePath.includes("\u0000")
  ) {
    return false;
  }
  const normalizedCandidate = path.resolve(candidatePath);
  const authorizedRoot = path.resolve(process.cwd(), "dist", "native");
  return (
    pathIsWithin(authorizedRoot, normalizedCandidate) && isRegularNativeFile(normalizedCandidate)
  );
}

function candidateNativePaths(): string[] {
  if (isPackagedRuntime()) {
    const packaged = packagedNativePath();
    return packaged && isRegularNativeFile(packaged) ? [packaged] : [];
  }

  const override = process.env.THREADLEAF_STATE_LOCK_NATIVE;
  if (override !== undefined) {
    if (!isAuthorizedDevelopmentNativePath(override)) {
      throw new StateLockError(
        "invalid",
        "THREADLEAF_STATE_LOCK_NATIVE must be an absolute regular .node file under the development dist/native root with no symlink ancestors.",
      );
    }
    return [path.resolve(override)];
  }

  const candidates = [
    path.resolve(process.cwd(), "dist", "native", "threadleaf-state-lock.node"),
    typeof __dirname === "string"
      ? path.resolve(__dirname, "..", "native", "threadleaf-state-lock.node")
      : undefined,
  ];
  return [
    ...new Set(
      candidates.filter(
        (candidate): candidate is string =>
          typeof candidate === "string" && isRegularNativeFile(candidate),
      ),
    ),
  ];
}

/** @internal Shared by the separately typed native filesystem adapter. */
export function loadThreadleafNativeBindingForInternalUse(): ThreadleafNativeBinding {
  if (binding) {
    return binding;
  }
  const candidates = candidateNativePaths();
  for (const candidate of candidates) {
    try {
      const loaded = nativeRequire(candidate) as Partial<ThreadleafNativeBinding>;
      const napiVersion = loaded.napiVersion;
      if (
        typeof loaded.acquire === "function" &&
        typeof loaded.renameNoReplace === "function" &&
        typeof loaded.openDirectoryNoFollowAt === "function" &&
        typeof loaded.openFileNoFollowAt === "function" &&
        typeof loaded.renameNoReplaceAt === "function" &&
        typeof loaded.probeAnonymousPublishNoName === "function" &&
        typeof loaded.publishBufferNoReplace === "function" &&
        typeof loaded.platform === "function" &&
        typeof loaded.mechanism === "function" &&
        typeof napiVersion === "function" &&
        napiVersion() === "10"
      ) {
        binding = loaded as ThreadleafNativeBinding;
        return binding;
      }
    } catch {
      // Try the next candidate. A missing or incompatible addon is reported below.
    }
  }
  throw new StateLockError(
    "unsupported",
    `The Node-API state-lock addon is unavailable. Build it with pnpm run build:native.`,
  );
}

function errorCode(error: unknown): StateLockCode | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const value = (error as { code?: unknown }).code;
  if (
    value === "busy" ||
    value === "closed" ||
    value === "compromised" ||
    value === "invalid" ||
    value === "io" ||
    value === "migration-required" ||
    value === "release-error" ||
    value === "unsupported"
  ) {
    return value;
  }
  return undefined;
}

function normalizeNativeError(error: unknown): StateLockError {
  if (error instanceof StateLockError) {
    return error;
  }
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : "Native state-lock operation failed.";
  if (code === "busy") {
    return new StateLockBusyError(error);
  }
  if (code === "migration-required") {
    return new StateLockMigrationRequiredError(error);
  }
  const normalized = new StateLockError(code ?? "io", message, { cause: error });
  if (
    error &&
    typeof error === "object" &&
    typeof (error as { name?: unknown }).name === "string"
  ) {
    normalized.name = String((error as { name: string }).name);
  }
  return normalized;
}

function assertPathInput(lockPath: string): void {
  if (
    typeof lockPath !== "string" ||
    lockPath.length === 0 ||
    lockPath.length > 32_768 ||
    lockPath.includes("\u0000") ||
    !path.isAbsolute(lockPath)
  ) {
    throw new StateLockError(
      "invalid",
      "State-lock path must be an absolute path without NUL bytes.",
    );
  }
}

class StateLockHandle implements StateLock {
  readonly path: string;
  readonly platform: StateLockPlatform;
  readonly mechanism: StateLockMechanism;
  #native: NativeStateLockHandle | undefined;

  constructor(lockPath: string, nativeHandle: NativeStateLockHandle, metadata: StateLockMetadata) {
    this.path = lockPath;
    this.platform = metadata.platform;
    this.mechanism = metadata.mechanism;
    this.#native = nativeHandle;
  }

  assertPathIdentity(): void {
    const nativeHandle = this.#native;
    if (!nativeHandle) {
      throw new StateLockError("closed", "The Threadleaf state lock has already been closed.");
    }
    try {
      nativeHandle.assertPathIdentity();
    } catch (error) {
      throw normalizeNativeError(error);
    }
  }

  close(): void {
    const nativeHandle = this.#native;
    if (!nativeHandle) {
      return;
    }
    try {
      nativeHandle.close();
      this.#native = undefined;
    } catch (error) {
      throw normalizeNativeError(error);
    }
  }
}

export function acquireStateLock(lockPath: string): StateLock {
  assertPathInput(lockPath);
  const loaded = loadThreadleafNativeBindingForInternalUse();
  try {
    const nativeHandle = loaded.acquire(lockPath);
    return new StateLockHandle(lockPath, nativeHandle, {
      path: lockPath,
      platform: loaded.platform(),
      mechanism: loaded.mechanism(),
    });
  } catch (error) {
    throw normalizeNativeError(error);
  }
}

export async function acquireStateLockAsync(
  lockPath: string,
  options: AcquireStateLockAsyncOptions = {},
): Promise<StateLock> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 0 ||
    timeoutMs > NODE_TIMER_MAX_MS ||
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < 1 ||
    pollIntervalMs > NODE_TIMER_MAX_MS
  ) {
    throw new StateLockError(
      "invalid",
      "State-lock async timeout and poll interval must fit the Node timer limit; timeout must be non-negative and poll interval must be positive.",
    );
  }
  const deadline = performance.now() + timeoutMs;
  while (true) {
    try {
      return acquireStateLock(lockPath);
    } catch (error) {
      const normalized = normalizeNativeError(error);
      if (normalized.code !== "busy") {
        throw normalized;
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw normalized;
      }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(pollIntervalMs, remaining, NODE_TIMER_MAX_MS)),
      );
    }
  }
}

export async function withStateLock<T>(
  lockPath: string,
  operation: (lock: StateLock) => T | Promise<T>,
): Promise<T> {
  const lock = acquireStateLock(lockPath);
  let result: T | undefined;
  let operationError: unknown;
  let operationFailed = false;
  let releaseError: unknown;
  try {
    try {
      lock.assertPathIdentity();
      result = await operation(lock);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }
  } finally {
    try {
      lock.close();
    } catch (error) {
      releaseError = error;
    }
  }
  if (operationFailed) {
    throw operationError;
  }
  if (releaseError !== undefined) {
    throw releaseError;
  }
  return result as T;
}

export function nativeStateLockPlatform(): StateLockPlatform {
  return loadThreadleafNativeBindingForInternalUse().platform();
}

export function nativeStateLockMechanism(): StateLockMechanism {
  return loadThreadleafNativeBindingForInternalUse().mechanism();
}
