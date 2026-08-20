import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";

const maxLegacyPageBytes = 2 * 1024 * 1024;
const maxLegacyRedirects = 5;
const legacyLoadTimeoutMs = 10_000;

type LegacyEventListener = (...arguments_: unknown[]) => void;

export class ElectronCompatibilityActivity {
  private readonly pending = new Set<Promise<void>>();

  track(operation: Promise<void>): Promise<void> {
    this.pending.add(operation);
    void operation.then(
      () => this.pending.delete(operation),
      () => this.pending.delete(operation),
    );
    return operation;
  }

  async waitForIdle(timeoutMs = legacyLoadTimeoutMs + 1_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.pending.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error("Legacy Electron compatibility activity did not settle in time.");
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled([...this.pending]),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("Legacy Electron compatibility activity timed out.")),
              remaining,
            );
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  }
}

function decodedTitle(source: string): string {
  if (typeof DOMParser === "function") {
    const document = new DOMParser().parseFromString(source, "text/html");
    return document.querySelector("title")?.textContent?.trim() ?? "";
  }
  const match = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title\s*>/iu.exec(source);
  return (match?.[1] ?? "")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .trim();
}

async function loadRemoteTitle(rawUrl: string, redirectCount = 0): Promise<string> {
  if (rawUrl.length > 8_192) {
    throw new Error("Legacy Electron title requests are limited to 8,192 URL characters.");
  }
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Legacy Electron title requests support HTTP and HTTPS only.");
  }
  return new Promise<string>((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsGet : httpGet)(
      url,
      {
        headers: {
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
          "User-Agent": "Threadleaf compatibility title fetcher",
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location) {
          response.resume();
          if (redirectCount >= maxLegacyRedirects) {
            reject(new Error("Legacy Electron title request exceeded its redirect limit."));
            return;
          }
          void loadRemoteTitle(new URL(location, url).href, redirectCount + 1).then(
            resolve,
            reject,
          );
          return;
        }
        if (status >= 400 || status === 0) {
          response.resume();
          reject(new Error(`Legacy Electron title request failed with HTTP status ${status}.`));
          return;
        }
        const chunks: Buffer[] = [];
        let byteLength = 0;
        response.on("data", (chunk: Buffer) => {
          byteLength += chunk.byteLength;
          if (byteLength > maxLegacyPageBytes) {
            request.destroy(new Error("Legacy Electron title response exceeded 2 MiB."));
            return;
          }
          chunks.push(chunk);
        });
        response.once("end", () => {
          resolve(decodedTitle(Buffer.concat(chunks, byteLength).toString("utf8")));
        });
        response.once("error", reject);
      },
    );
    request.setTimeout(legacyLoadTimeoutMs, () => {
      request.destroy(new Error("Legacy Electron title request timed out."));
    });
    request.once("error", reject);
  });
}

class LegacyRemoteWebContents {
  private readonly listeners = new Map<string, Set<LegacyEventListener>>();
  private title = "";

  on(name: string, listener: LegacyEventListener): this {
    const listeners = this.listeners.get(name) ?? new Set<LegacyEventListener>();
    listeners.add(listener);
    this.listeners.set(name, listeners);
    return this;
  }

  emit(name: string, ...arguments_: unknown[]): void {
    for (const listener of this.listeners.get(name) ?? []) {
      listener(...arguments_);
    }
  }

  getTitle(): string {
    return this.title;
  }

  setAudioMuted(_muted: boolean): void {}

  async load(rawUrl: string): Promise<void> {
    try {
      this.title = await loadRemoteTitle(rawUrl);
      this.emit("did-finish-load", { url: rawUrl });
    } catch (error) {
      this.emit("did-fail-load", error);
    }
  }

  close(): void {
    this.listeners.clear();
  }
}

export class LegacyRemoteBrowserWindow {
  readonly webContents = new LegacyRemoteWebContents();
  private destroyed = false;

  constructor(
    _options?: unknown,
    private readonly activity?: ElectronCompatibilityActivity,
  ) {}

  loadURL(url: string): Promise<void> {
    if (this.destroyed) {
      return Promise.reject(new Error("Legacy Electron compatibility window is closed."));
    }
    const operation = this.webContents.load(url);
    return this.activity?.track(operation) ?? operation;
  }

  destroy(): void {
    this.destroyed = true;
    this.webContents.close();
  }
}

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

export function createElectronCompatibilityModule(
  nativeElectron: unknown,
  activity?: ElectronCompatibilityActivity,
): unknown {
  if (
    isObject(nativeElectron) &&
    isObject(nativeElectron.remote) &&
    typeof nativeElectron.remote.BrowserWindow === "function"
  ) {
    return nativeElectron;
  }
  const module = Object.create(isObject(nativeElectron) ? nativeElectron : null) as Record<
    PropertyKey,
    unknown
  >;
  const nativeRemote =
    isObject(nativeElectron) && isObject(nativeElectron.remote) ? nativeElectron.remote : null;
  const BrowserWindow = activity
    ? class TrackedLegacyRemoteBrowserWindow extends LegacyRemoteBrowserWindow {
        constructor(options?: unknown) {
          super(options, activity);
        }
      }
    : LegacyRemoteBrowserWindow;
  module.remote = Object.assign(Object.create(nativeRemote), {
    BrowserWindow,
  });
  return module;
}
