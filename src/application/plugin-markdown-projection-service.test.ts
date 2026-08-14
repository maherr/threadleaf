import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PluginMarkdownProjectionSnapshot, RuntimeSnapshot } from "../shared/contracts";
import { pluginDiagnosticError } from "../shared/plugin-diagnostics";
import {
  type PluginMarkdownProjectionRuntime,
  renderPluginMarkdownProjection,
} from "./plugin-markdown-projection-service";

const fixtureSourcePath = "Notes/Fixture.md";
const fixtureContent = "[cite: Doe 2024]";

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

function contentSha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** A correctly bound projection for the fixture's own path/content, so happy-path tests pass the
 * identity check by default; mutation tests override exactly one field away from this baseline. */
function matchingProjection(
  overrides: Partial<PluginMarkdownProjectionSnapshot> = {},
): PluginMarkdownProjectionSnapshot {
  return {
    contentSha256: contentSha256(fixtureContent),
    html: "<p>settled</p>",
    pluginId: "cite",
    postProcessorCount: 1,
    sourcePath: fixtureSourcePath,
    ...overrides,
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
        markdownProjection: matchingProjection(),
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
      fixtureSourcePath,
      fixtureContent,
      "vault-a",
    );
    expect(response).toEqual({
      status: "ready",
      vaultId: "vault-a",
      pluginId: "cite",
      sourcePath: fixtureSourcePath,
      contentSha256: contentSha256(fixtureContent),
      html: "<p>settled</p>",
      postProcessorCount: 1,
    });
  });

  it("refuses a request against a vault that has already changed", async () => {
    const runtime = fakeRuntime("vault-a");
    const response = await renderPluginMarkdownProjection(
      runtime,
      "cite",
      fixtureSourcePath,
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
        return { ...snapshot, markdownProjection: matchingProjection() };
      },
    };
    const response = await renderPluginMarkdownProjection(
      runtime,
      "cite",
      fixtureSourcePath,
      fixtureContent,
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
      fixtureSourcePath,
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
      fixtureSourcePath,
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
      fixtureSourcePath,
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
      fixtureSourcePath,
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

  it("distinguishes runtime-render-failed from runtime-render-too-large by code, not just diagnostic-message shape", async () => {
    // A realistic *different* diagnostic code, in the same reconstructed-message-after-IPC shape
    // as the too-large test above. If the classification only checked "looks like a diagnostic
    // message" rather than the specific code, this would be misreported as too-large.
    const ordinaryFailure = pluginDiagnosticError(
      "runtime-render-failed",
      { pluginId: "cite" },
      new Error("boom"),
    );
    const runtime = fakeRuntime("vault-a", {
      renderMarkdownProjection: () => Promise.reject(new Error(ordinaryFailure.message)),
    });
    const response = await renderPluginMarkdownProjection(
      runtime,
      "cite",
      fixtureSourcePath,
      "content",
      "vault-a",
    );
    expect(response).toMatchObject({ status: "unavailable", reason: "processor-error" });
  });

  it("reports too-large honestly when PluginHost's own outbound cap rejects the render", async () => {
    // Simulates exactly what crosses IPC in production: pluginDiagnosticError always throws its
    // stable per-code template, discarding the raw cause text, and only the reconstructed
    // message (not the non-enumerable code) survives serialization -- see
    // parsePluginDiagnosticMessage in plugin-diagnostics.ts and its usage in
    // plugin-markdown-projection-service.ts's catch block.
    const realisticError = pluginDiagnosticError(
      "runtime-render-too-large",
      { pluginId: "cite" },
      new Error("Settled Markdown projection is 9000000 bytes, exceeding the limit."),
    );
    const runtime = fakeRuntime("vault-a", {
      renderMarkdownProjection: () => Promise.reject(new Error(realisticError.message)),
    });
    const response = await renderPluginMarkdownProjection(
      runtime,
      "cite",
      fixtureSourcePath,
      "content",
      "vault-a",
    );
    expect(response).toEqual({
      status: "unavailable",
      vaultId: "vault-a",
      pluginId: "cite",
      reason: "too-large",
      message: "CITE's settled Markdown projection was too large to return.",
    });
  });

  it("refuses oversized inbound content before any round trip (too-large, inbound cap)", async () => {
    const getSnapshot = vi.fn();
    const renderMarkdownProjection = vi.fn();
    const runtime = fakeRuntime("vault-a", { getSnapshot, renderMarkdownProjection });
    const oversizedContent = "x".repeat(2 * 1024 * 1024 + 1);

    const response = await renderPluginMarkdownProjection(
      runtime,
      "cite",
      fixtureSourcePath,
      oversizedContent,
      "vault-a",
    );

    expect(response).toMatchObject({ status: "unavailable", reason: "too-large" });
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(renderMarkdownProjection).not.toHaveBeenCalled();
  });

  it("reports timeout honestly from the typed resourceDiagnostics signal, not a message guess", async () => {
    // RecoveringPluginRuntime absorbs a real operation-deadline breach and resolves from a fresh
    // replacement renderer (see its recover()); renderMarkdownProjection never rejects for this
    // case in production. The only reliable signal is the merged resourceDiagnostics entry.
    const runtime = fakeRuntime("vault-a", {
      renderMarkdownProjection: () =>
        Promise.resolve({
          ...loadedCiteSnapshot("vault-a"),
          resourceDiagnostics: [
            {
              pluginId: "cite",
              reason: "operation-deadline",
              metric: null,
              operation: "render-markdown",
              available: true,
              measuredValue: 15_000,
              configuredBudget: 15_000,
              unit: "milliseconds",
              sampleCount: null,
              startedAt: new Date(0).toISOString(),
              observedAt: new Date(0).toISOString(),
            },
          ],
        }),
    });
    const response = await renderPluginMarkdownProjection(
      runtime,
      "cite",
      fixtureSourcePath,
      fixtureContent,
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

  it("reports processor-error, not timeout, when a projection is simply missing with no deadline diagnostic", async () => {
    const runtime = fakeRuntime("vault-a", {
      renderMarkdownProjection: () => Promise.resolve(loadedCiteSnapshot("vault-a")),
    });
    const response = await renderPluginMarkdownProjection(
      runtime,
      "cite",
      fixtureSourcePath,
      "content",
      "vault-a",
    );
    expect(response).toMatchObject({ status: "unavailable", reason: "processor-error" });
  });

  it("mutation-proves the pluginId binding: a projection for a different plugin id is refused", async () => {
    const runtime = fakeRuntime("vault-a", {
      renderMarkdownProjection: () =>
        Promise.resolve({
          ...loadedCiteSnapshot("vault-a"),
          markdownProjection: matchingProjection({ pluginId: "not-cite" }),
        }),
    });
    const response = await renderPluginMarkdownProjection(
      runtime,
      "cite",
      fixtureSourcePath,
      fixtureContent,
      "vault-a",
    );
    expect(response).toMatchObject({ status: "unavailable", reason: "processor-error" });
  });

  it("mutation-proves the sourcePath binding: a projection for a different note is refused", async () => {
    const runtime = fakeRuntime("vault-a", {
      renderMarkdownProjection: () =>
        Promise.resolve({
          ...loadedCiteSnapshot("vault-a"),
          markdownProjection: matchingProjection({ sourcePath: "Notes/Different.md" }),
        }),
    });
    const response = await renderPluginMarkdownProjection(
      runtime,
      "cite",
      fixtureSourcePath,
      fixtureContent,
      "vault-a",
    );
    expect(response).toMatchObject({ status: "unavailable", reason: "processor-error" });
  });

  it("mutation-proves the contentSha256 binding: a projection for different content is refused", async () => {
    const runtime = fakeRuntime("vault-a", {
      renderMarkdownProjection: () =>
        Promise.resolve({
          ...loadedCiteSnapshot("vault-a"),
          markdownProjection: matchingProjection({
            contentSha256: contentSha256("a completely different note body"),
          }),
        }),
    });
    const response = await renderPluginMarkdownProjection(
      runtime,
      "cite",
      fixtureSourcePath,
      fixtureContent,
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
      fixtureSourcePath,
      "content",
      "vault-a",
    );
    expect(response).toMatchObject({ status: "unavailable", reason: "processor-error" });
    expect(getSnapshot).toHaveBeenCalledOnce();
  });
});
