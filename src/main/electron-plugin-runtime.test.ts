import type { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FatalPluginRuntimeError } from "../runtime/plugin-runtime-port";
import type { PluginSurfaceSnapshot, RuntimeSnapshot } from "../shared/contracts";

interface FakeWebContents extends EventEmitter {
  close: ReturnType<typeof vi.fn>;
  forcefullyCrashRenderer: ReturnType<typeof vi.fn>;
  isDestroyed(): boolean;
}

const electronMock = vi.hoisted(() => ({
  views: [] as Array<{ webContents: FakeWebContents }>,
}));

vi.mock("electron", async () => {
  const { EventEmitter: MockEventEmitter } = await import("node:events");
  const readyChannel = "threadleaf:plugin-renderer-ready";
  const responseChannel = "threadleaf:plugin-renderer-response";

  class MockWebContents extends MockEventEmitter {
    private destroyed = false;
    readonly close = vi.fn(() => {
      this.destroyed = true;
    });
    readonly forcefullyCrashRenderer = vi.fn();
    readonly session = {
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
    };
    readonly setWindowOpenHandler = vi.fn();
    readonly loadFile = vi.fn(async () => {
      queueMicrotask(() => this.emit("ipc-message", {}, readyChannel));
    });
    readonly send = vi.fn((_channel: string, request: { id: string; operation: string }) => {
      if (request.operation !== "initialize" && request.operation !== "open-view") {
        return;
      }
      const value = emptySnapshot(
        request.operation === "open-view"
          ? { displayText: "Drawing", filePath: "Drawing.md", viewType: "drawing" }
          : null,
      );
      queueMicrotask(() =>
        this.emit("ipc-message", {}, responseChannel, {
          id: request.id,
          ok: true,
          value,
        }),
      );
    });

    isDestroyed(): boolean {
      return this.destroyed;
    }
  }

  class WebContentsView {
    readonly webContents = new MockWebContents();

    constructor() {
      electronMock.views.push(this);
    }
  }

  return { WebContentsView };
});

import { ElectronPluginRuntime } from "./electron-plugin-runtime";

function emptySnapshot(pluginSurface: PluginSurfaceSnapshot | null): RuntimeSnapshot {
  return {
    vault: {
      id: null,
      name: "vault",
      path: "/vault",
      markdownFileCount: 0,
      mode: "synthetic-read-only",
      source: "direct",
      warning: null,
    },
    plugin: null,
    plugins: [],
    commands: [],
    actions: [],
    notices: [],
    events: [],
    pluginSurface,
  };
}

beforeEach(() => {
  electronMock.views.length = 0;
});

describe("ElectronPluginRuntime", () => {
  it("kills the isolated renderer when an operation times out", async () => {
    const visibility = vi.fn();
    const runtime = await ElectronPluginRuntime.open({
      hostHtmlPath: "/app/plugin-host.html",
      onSurfaceVisibilityChange: visibility,
      operationTimeoutMs: 10,
      packageJsonPath: "/app/package.json",
      vaultPath: "/vault",
    });
    await runtime.openPluginView("drawing", "Drawing.md");

    await expect(runtime.runCommand("hung-command")).rejects.toMatchObject({
      name: "FatalPluginRuntimeError",
      operation: "run-command",
    });

    const webContents = electronMock.views[0]?.webContents;
    expect(webContents?.forcefullyCrashRenderer).toHaveBeenCalledOnce();
    expect(webContents?.close).toHaveBeenCalledOnce();
    expect(visibility.mock.calls.map((call) => call[1])).toEqual([true, false]);
    await expect(runtime.getSnapshot()).rejects.toBeInstanceOf(FatalPluginRuntimeError);
  });

  it("closes a crashed renderer without trying to crash it again", async () => {
    const runtime = await ElectronPluginRuntime.open({
      hostHtmlPath: "/app/plugin-host.html",
      operationTimeoutMs: 10,
      packageJsonPath: "/app/package.json",
      vaultPath: "/vault",
    });
    const webContents = electronMock.views[0]?.webContents;

    webContents?.emit("render-process-gone", {}, { reason: "crashed", exitCode: 9 });

    expect(webContents?.forcefullyCrashRenderer).not.toHaveBeenCalled();
    expect(webContents?.close).toHaveBeenCalledOnce();
    await expect(runtime.getSnapshot()).rejects.toMatchObject({
      name: "FatalPluginRuntimeError",
      operation: "get-snapshot",
    });
  });
});
