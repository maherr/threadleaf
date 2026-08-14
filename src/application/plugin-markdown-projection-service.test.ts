import { describe, expect, it, vi } from "vitest";
import type { RuntimeSnapshot } from "../shared/contracts";
import {
  type PluginMarkdownProjectionRuntime,
  renderPluginMarkdownProjection,
} from "./plugin-markdown-projection-service";

function baseSnapshot(vaultId: string): RuntimeSnapshot {
  return {
    vault: {
      id: vaultId,
      name: "Fixture",
      path: "/fixture",
      markdownFileCount: 1,
      mode: "kernel-backed",
      source: "direct",
      warning: null,
    },
    plugin: null,
    plugins: [],
    commands: [],
    actions: [],
    notices: [],
    events: [],
  };
}

function loadedCiteSnapshot(vaultId: string): RuntimeSnapshot {
  return {
    ...baseSnapshot(vaultId),
    plugin: {
      id: "cite",
      name: "CITE",
      version: "0.1.2",
      state: "loaded",
      compatibilityLevel: 3,
      stylesheetDiscovered: false,
      error: null,
    },
    plugins: [
      {
        id: "cite",
        name: "CITE",
        version: "0.1.2",
        state: "loaded",
        compatibilityLevel: 3,
        stylesheetDiscovered: false,
        error: null,
      },
    ],
  };
}

function fakeRuntime(
  vaultId: string,
  overrides: Partial<PluginMarkdownProjectionRuntime> = {},
): PluginMarkdownProjectionRuntime {
  return {
    vaultId,
    getSnapshot: () => Promise.resolve(loadedCiteSnapshot(vaultId)),
    renderMarkdownProjection: () =>
      Promise.resolve({
        ...loadedCiteSnapshot(vaultId),
        markdownProjection: {
          contentSha256: "a".repeat(64),
          html: "<p>settled</p>",
          pluginId: "cite",
          postProcessorCount: 1,
          sourcePath: "Notes/Fixture.md",
        },
      }),
    ...overrides,
  };
}

describe("renderPluginMarkdownProjection", () => {
  it("returns the settled projection for a loaded plugin", async () => {
    const runtime = fakeRuntime("vault-a");
    const response = await renderPluginMarkdownProjection(
      runtime,
      "cite",
      "Notes/Fixture.md",
      "[cite: Doe 2024]",
      "vault-a",
    );
    expect(response).toEqual({
      status: "ready",
      vaultId: "vault-a",
      pluginId: "cite",
      sourcePath: "Notes/Fixture.md",
      contentSha256: "a".repeat(64),
      html: "<p>settled</p>",
      postProcessorCount: 1,
    });
  });

  it("refuses a request against a vault that has already changed", async () => {
    const runtime = fakeRuntime("vault-a");
    const response = await renderPluginMarkdownProjection(
      runtime,
      "cite",
      "Notes/Fixture.md",
      "content",
      "vault-b",
    );
    expect(response).toEqual({ status: "stale-vault", vaultId: "vault-a" });
  });

  it("discards an in-flight render's result once the vault changes mid-flight (revision-staleness guard)", async () => {
    let currentVaultId = "vault-a";
    const runtime: PluginMarkdownProjectionRuntime = {
      get vaultId() {
        return currentVaultId;
      },
      getSnapshot: () => Promise.resolve(loadedCiteSnapshot(currentVaultId)),
      renderMarkdownProjection: async () => {
        // Simulate the active vault switching while the settled render was in flight.
        const snapshot = loadedCiteSnapshot(currentVaultId);
        currentVaultId = "vault-b";
        return {
          ...snapshot,
          markdownProjection: {
            contentSha256: "a".repeat(64),
            html: "<p>settled</p>",
            pluginId: "cite",
            postProcessorCount: 1,
            sourcePath: "Notes/Fixture.md",
          },
        };
      },
    };
    const response = await renderPluginMarkdownProjection(
      runtime,
      "cite",
      "Notes/Fixture.md",
      "[cite: Doe 2024]",
      "vault-a",
    );
    expect(response).toEqual({ status: "stale-vault", vaultId: "vault-b" });
  });

  it("refuses a request that has already gone stale before the snapshot check completes", async () => {
    let currentVaultId = "vault-a";
    const runtime: PluginMarkdownProjectionRuntime = {
      get vaultId() {
        return currentVaultId;
      },
      getSnapshot: async () => {
        const snapshot = loadedCiteSnapshot(currentVaultId);
        currentVaultId = "vault-b";
        return snapshot;
      },
      renderMarkdownProjection: () => {
        throw new Error("must not render once the vault has already changed");
      },
    };
    const response = await renderPluginMarkdownProjection(
      runtime,
      "cite",
      "Notes/Fixture.md",
      "content",
      "vault-a",
    );
    expect(response).toEqual({ status: "stale-vault", vaultId: "vault-b" });
  });

  it("reports an honest plugin-disabled reason when the plugin is not currently loaded", async () => {
    const runtime = fakeRuntime("vault-a", {
      getSnapshot: () =>
        Promise.resolve({
          ...baseSnapshot("vault-a"),
          plugins: [
            {
              id: "cite",
              name: "CITE",
              version: "0.1.2",
              state: "unloaded",
              compatibilityLevel: 1,
              stylesheetDiscovered: false,
              error: null,
            },
          ],
        }),
      renderMarkdownProjection: () => {
        throw new Error("must not attempt to render a plugin that is not loaded");
      },
    });
    const response = await renderPluginMarkdownProjection(
      runtime,
      "cite",
      "Notes/Fixture.md",
      "content",
      "vault-a",
    );
    expect(response).toEqual({
      status: "unavailable",
      vaultId: "vault-a",
      pluginId: "cite",
      reason: "plugin-disabled",
      message: "CITE is not currently active in the compatibility runtime.",
    });
  });

  it("reports plugin-disabled when the plugin is not installed at all", async () => {
    const runtime = fakeRuntime("vault-a", {
      getSnapshot: () => Promise.resolve(baseSnapshot("vault-a")),
      renderMarkdownProjection: () => {
        throw new Error("must not attempt to render an uninstalled plugin");
      },
    });
    const response = await renderPluginMarkdownProjection(
      runtime,
      "cite",
      "Notes/Fixture.md",
      "content",
      "vault-a",
    );
    expect(response).toMatchObject({ status: "unavailable", reason: "plugin-disabled" });
  });

  it("reports processor-error honestly when the registered processor throws", async () => {
    const runtime = fakeRuntime("vault-a", {
      renderMarkdownProjection: () => Promise.reject(new Error("processor failed")),
    });
    const response = await renderPluginMarkdownProjection(
      runtime,
      "cite",
      "Notes/Fixture.md",
      "content",
      "vault-a",
    );
    expect(response).toEqual({
      status: "unavailable",
      vaultId: "vault-a",
      pluginId: "cite",
      reason: "processor-error",
      message: "CITE's registered Markdown post processor failed while rendering this note.",
    });
  });

  it("reports timeout honestly when the operation deadline elapses", async () => {
    const runtime = fakeRuntime("vault-a", {
      renderMarkdownProjection: () =>
        Promise.reject(new Error("Plugin renderer operation timed out: render-markdown.")),
    });
    const response = await renderPluginMarkdownProjection(
      runtime,
      "cite",
      "Notes/Fixture.md",
      "content",
      "vault-a",
    );
    expect(response).toEqual({
      status: "unavailable",
      vaultId: "vault-a",
      pluginId: "cite",
      reason: "timeout",
      message: "CITE did not settle a Markdown projection before its operation deadline.",
    });
  });

  it("reports processor-error when the render returns a mismatched or missing projection", async () => {
    const runtime = fakeRuntime("vault-a", {
      renderMarkdownProjection: () => Promise.resolve(loadedCiteSnapshot("vault-a")),
    });
    const response = await renderPluginMarkdownProjection(
      runtime,
      "cite",
      "Notes/Fixture.md",
      "content",
      "vault-a",
    );
    expect(response).toMatchObject({ status: "unavailable", reason: "processor-error" });
  });

  it("never calls the runtime a second time when the first getSnapshot rejects", async () => {
    const getSnapshot = vi.fn().mockRejectedValue(new Error("renderer unavailable"));
    const runtime = fakeRuntime("vault-a", {
      getSnapshot,
      renderMarkdownProjection: () => {
        throw new Error("must not render once the snapshot fetch failed");
      },
    });
    const response = await renderPluginMarkdownProjection(
      runtime,
      "cite",
      "Notes/Fixture.md",
      "content",
      "vault-a",
    );
    expect(response).toMatchObject({ status: "unavailable", reason: "processor-error" });
    expect(getSnapshot).toHaveBeenCalledOnce();
  });
});
