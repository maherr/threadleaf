import { type Dirent, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadVaultAppearance } from "./vault-appearance-loader";
import {
  type AppearanceWatchBackend,
  type AppearanceWatchEventListener,
  type AppearanceWatchHandle,
  type AppearanceWatchScheduler,
  VaultAppearanceWatcher,
} from "./vault-appearance-watcher";

class FakeHandle implements AppearanceWatchHandle {
  closed = false;
  readonly #errors = new Set<(error: unknown) => void>();
  readonly #listener: AppearanceWatchEventListener;

  constructor(listener: AppearanceWatchEventListener) {
    this.#listener = listener;
  }

  close(): void {
    this.closed = true;
  }

  on(_event: "error", listener: (error: unknown) => void): unknown {
    this.#errors.add(listener);
    return this;
  }

  emit(eventType: string, filename: string | null): void {
    this.#listener(eventType, filename);
  }

  emitError(error: unknown): void {
    for (const listener of this.#errors) {
      listener(error);
    }
  }
}

class FakeScheduler implements AppearanceWatchScheduler {
  readonly #callbacks = new Map<object, () => void>();

  get size(): number {
    return this.#callbacks.size;
  }

  setTimeout(callback: () => void, _delayMs: number): unknown {
    const token = {};
    this.#callbacks.set(token, callback);
    return token;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "object" && handle !== null) {
      this.#callbacks.delete(handle);
    }
  }

  runAll(): void {
    const callbacks = [...this.#callbacks.values()];
    this.#callbacks.clear();
    for (const callback of callbacks) {
      callback();
    }
  }
}

function fakeBackend(): {
  backend: AppearanceWatchBackend;
  handles: Map<string, FakeHandle[]>;
  latest(targetPath: string): FakeHandle;
} {
  const handles = new Map<string, FakeHandle[]>();
  return {
    backend: {
      realpath: (targetPath) => fs.realpath(targetPath),
      stat: (targetPath) => fs.stat(targetPath),
      readdir: (targetPath) =>
        fs.readdir(targetPath, { withFileTypes: true }) as Promise<Dirent<string>[]>,
      watch: (targetPath, listener) => {
        const handle = new FakeHandle(listener);
        const entries = handles.get(targetPath) ?? [];
        entries.push(handle);
        handles.set(targetPath, entries);
        return handle;
      },
    },
    handles,
    latest(targetPath) {
      const handle = handles.get(targetPath)?.at(-1);
      if (!handle) {
        throw new Error(`No fake watcher was registered for ${targetPath}.`);
      }
      return handle;
    },
  };
}

let sandboxPath: string;
let vaultPath: string;

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-appearance-watch-"));
  vaultPath = path.join(sandboxPath, "vault");
  await fs.mkdir(vaultPath);
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

async function writeTheme(folder: string, css: string): Promise<void> {
  const directory = path.join(vaultPath, ".obsidian", "themes", folder);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "theme.css"), css, "utf8");
}

async function writeSnippet(filename: string, css: string): Promise<void> {
  const directory = path.join(vaultPath, ".obsidian", "snippets");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, filename), css, "utf8");
}

describe("VaultAppearanceWatcher", () => {
  it("filters non-appearance events and coalesces theme and snippet atomic-save events", async () => {
    await writeTheme("Selected", "body { --watch-theme: one; }");
    await writeSnippet("selected.css", "body { --watch-snippet: one; }");
    const scheduler = new FakeScheduler();
    const backend = fakeBackend();
    const invalidations: string[] = [];
    const watcher = await VaultAppearanceWatcher.open({
      vaultPath,
      backend: backend.backend,
      scheduler,
      onInvalidation: ({ reason }) => {
        invalidations.push(reason);
      },
    });

    backend.latest(vaultPath).emit("change", "Welcome.md");
    backend.latest(path.join(vaultPath, ".obsidian")).emit("change", "plugins");
    backend
      .latest(path.join(vaultPath, ".obsidian", "themes", "Selected"))
      .emit("rename", "theme.css");
    backend.latest(path.join(vaultPath, ".obsidian", "snippets")).emit("rename", "selected.css");

    expect(scheduler.size).toBe(1);
    scheduler.runAll();
    await watcher.whenIdle();
    expect(invalidations).toEqual(["filesystem-event"]);
    await watcher.close();
  });

  it("rescans after source-root replacement, backend errors, ambiguous events, and overflow", async () => {
    await writeTheme("Selected", "body { --watch-theme: one; }");
    await writeSnippet("selected.css", "body { --watch-snippet: one; }");
    const scheduler = new FakeScheduler();
    const backend = fakeBackend();
    const invalidations: string[] = [];
    const watcher = await VaultAppearanceWatcher.open({
      vaultPath,
      backend: backend.backend,
      scheduler,
      onInvalidation: ({ reason }) => {
        invalidations.push(reason);
      },
    });
    const previousThemeRoot = backend.latest(path.join(vaultPath, ".obsidian", "themes"));

    backend.latest(path.join(vaultPath, ".obsidian")).emit("rename", "themes");
    scheduler.runAll();
    await watcher.whenIdle();
    expect(invalidations).toEqual(["source-root-replaced"]);
    expect(previousThemeRoot.closed).toBe(true);

    backend.latest(path.join(vaultPath, ".obsidian", "snippets")).emitError(new Error("backend"));
    scheduler.runAll();
    await watcher.whenIdle();
    backend.latest(path.join(vaultPath, ".obsidian", "themes")).emit("rename", null);
    scheduler.runAll();
    await watcher.whenIdle();
    backend.latest(path.join(vaultPath, ".obsidian", "snippets")).emit("overflow", "ignored");
    scheduler.runAll();
    await watcher.whenIdle();

    expect(invalidations).toEqual([
      "source-root-replaced",
      "backend-error",
      "ambiguous-event",
      "overflow",
    ]);
    await watcher.close();
  });

  it("stops cleanly and cannot deliver a queued reload after close", async () => {
    await writeSnippet("selected.css", "body { --watch-snippet: one; }");
    const scheduler = new FakeScheduler();
    const backend = fakeBackend();
    const invalidations: string[] = [];
    const watcher = await VaultAppearanceWatcher.open({
      vaultPath,
      backend: backend.backend,
      scheduler,
      onInvalidation: ({ reason }) => {
        invalidations.push(reason);
      },
    });

    backend.latest(path.join(vaultPath, ".obsidian", "snippets")).emit("change", "selected.css");
    expect(scheduler.size).toBe(1);
    await watcher.close();
    scheduler.runAll();
    await watcher.whenIdle();

    expect(invalidations).toEqual([]);
    expect([...backend.handles.values()].flat().every((handle) => handle.closed)).toBe(true);
  });

  it("uses the existing loader seam for selected edits, unselected catalog changes, invalid files, deletion, restoration, and symlink containment", async () => {
    const selectedThemePath = path.join(vaultPath, ".obsidian", "themes", "Selected", "theme.css");
    const selectedSnippetPath = path.join(vaultPath, ".obsidian", "snippets", "selected.css");
    await writeTheme("Selected", "body { --watch-theme: one; }");
    await writeTheme("Unused", "body { --unused-theme: one; }");
    await writeSnippet("selected.css", "body { --watch-snippet: one; }");
    const preference = {
      colorScheme: "dark" as const,
      themeId: "obsidian-theme:Selected",
      enabledSnippetIds: ["obsidian-snippet:selected.css"],
    };
    let appearance = await loadVaultAppearance({
      vaultPath,
      vaultId: "a".repeat(64),
      preference,
      safeMode: false,
    });
    const scheduler = new FakeScheduler();
    const backend = fakeBackend();
    const watcher = await VaultAppearanceWatcher.open({
      vaultPath,
      backend: backend.backend,
      scheduler,
      onInvalidation: async () => {
        appearance = await loadVaultAppearance({
          vaultPath,
          vaultId: "a".repeat(64),
          preference,
          safeMode: false,
        });
      },
    });

    await fs.writeFile(selectedThemePath, "body { --watch-theme: two; }");
    backend
      .latest(path.dirname(selectedThemePath))
      .emit("rename", path.basename(selectedThemePath));
    scheduler.runAll();
    await watcher.whenIdle();
    expect(appearance.css).toContain("--watch-theme: two");

    const cssBeforeUnselectedChange = appearance.css;
    await writeSnippet("unselected.css", "body { --unselected: catalog-only; }");
    backend.latest(path.join(vaultPath, ".obsidian", "snippets")).emit("rename", "unselected.css");
    scheduler.runAll();
    await watcher.whenIdle();
    expect(appearance.css).toBe(cssBeforeUnselectedChange);
    expect(appearance.snippets.map((snippet) => snippet.id)).toContain(
      "obsidian-snippet:unselected.css",
    );

    await fs.writeFile(selectedSnippetPath, '@import url("https://example.test/blocked.css");');
    backend.latest(path.dirname(selectedSnippetPath)).emit("change", "selected.css");
    scheduler.runAll();
    await watcher.whenIdle();
    expect(appearance.preference).toEqual(preference);
    expect(appearance.activeSnippetIds).toEqual([]);
    expect(appearance.warnings.join("\n")).toContain("not applied");

    await fs.rm(selectedThemePath);
    backend.latest(path.dirname(selectedThemePath)).emit("rename", "theme.css");
    scheduler.runAll();
    await watcher.whenIdle();
    expect(appearance.preference.themeId).toBe("obsidian-theme:Selected");
    expect(appearance.activeThemeId).toBeNull();
    expect(appearance.warnings.join("\n")).toContain("selected custom theme");

    await fs.writeFile(selectedThemePath, "body { --watch-theme: restored; }");
    await fs.writeFile(selectedSnippetPath, "body { --watch-snippet: restored; }");
    backend.latest(path.dirname(selectedThemePath)).emit("rename", "theme.css");
    backend.latest(path.dirname(selectedSnippetPath)).emit("rename", "selected.css");
    scheduler.runAll();
    await watcher.whenIdle();
    expect(appearance.activeThemeId).toBe("obsidian-theme:Selected");
    expect(appearance.activeSnippetIds).toEqual(["obsidian-snippet:selected.css"]);
    expect(appearance.css).toContain("--watch-theme: restored");
    expect(appearance.css).toContain("--watch-snippet: restored");

    const outsideCssPath = path.join(sandboxPath, "outside.css");
    await fs.writeFile(outsideCssPath, "body { --escaped: true; }");
    await fs.symlink(outsideCssPath, path.join(vaultPath, ".obsidian", "snippets", "escaped.css"));
    backend.latest(path.dirname(selectedSnippetPath)).emit("rename", "escaped.css");
    scheduler.runAll();
    await watcher.whenIdle();
    expect(appearance.snippets.map((snippet) => snippet.id)).not.toContain(
      "obsidian-snippet:escaped.css",
    );
    expect(appearance.warnings.join("\n")).toContain("resolves outside its appearance directory");
    await watcher.close();
  });
});
