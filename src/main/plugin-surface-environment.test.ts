import { describe, expect, it, vi } from "vitest";
import type { RuntimeSnapshot } from "../shared/contracts";
import type { PluginRendererEnvironment } from "../shared/plugin-runtime-protocol";
import { PluginSurfaceEnvironmentBridge } from "./plugin-surface-environment";

const sources = {
  theme: "dark" as const,
  appearanceCss: ".appearance { --appearance: 1; }",
  pluginCss: ".plugin { --plugin: 1; }",
  accessibilityCss: ":root { --accessibility: 1 !important; }",
  accessibility: {
    highContrast: false,
    accent: "blue" as const,
    uiFontScale: 1,
    textFontScale: 1,
    editorFontSize: 15,
    editorLineHeight: 1.6,
    reducedMotion: false,
    reducedTransparency: false,
  },
};

const baseSnapshot: RuntimeSnapshot = {
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
  pluginSurface: null,
};

function target(id: string, sequences: number[], destroyed = false) {
  return {
    id,
    isDestroyed: () => destroyed,
    applyEnvironment: vi.fn(async (environment: PluginRendererEnvironment) => {
      sequences.push(environment.sequence);
      return {
        ...baseSnapshot,
        pluginEnvironment: {
          status: "applied" as const,
          vaultId: environment.vaultId,
          vaultGeneration: environment.vaultGeneration,
          sequence: environment.sequence,
          cssChangeTriggered: environment.sequence > 1,
        },
      };
    }),
  };
}

describe("PluginSurfaceEnvironmentBridge", () => {
  it("acknowledges every live target, serializes updates, and removes destroyed targets", async () => {
    const bridge = new PluginSurfaceEnvironmentBridge(sources);
    const firstSequences: number[] = [];
    const secondSequences: number[] = [];
    const first = target("first", firstSequences);
    const second = target("second", secondSequences);
    await bridge.register(first, { vaultId: "a".repeat(64), vaultGeneration: 4 });
    await bridge.register(second, { vaultId: "a".repeat(64), vaultGeneration: 4 });
    expect(firstSequences).toEqual([1]);
    expect(secondSequences).toEqual([1]);

    const one = bridge.update({ pluginCss: ".plugin { --plugin: 2; }" });
    const two = bridge.update({ pluginCss: ".plugin { --plugin: 3; }" });
    await Promise.all([one, two]);
    expect(firstSequences).toEqual([1, 2, 3]);
    expect(secondSequences).toEqual([1, 2, 3]);
    expect(bridge.currentEnvironment).toMatchObject({ sequence: 3 });

    bridge.unregister("second");
    await bridge.update({ theme: "light" });
    expect(firstSequences).toEqual([1, 2, 3, 4]);
    expect(secondSequences).toEqual([1, 2, 3]);
  });

  it("fails closed on an acknowledged rejection and on a live vault identity change", async () => {
    const bridge = new PluginSurfaceEnvironmentBridge(sources);
    const sequences: number[] = [];
    const first = target("first", sequences);
    await bridge.register(first, { vaultId: "b".repeat(64), vaultGeneration: 1 });
    await expect(
      bridge.register(target("second", [], false), {
        vaultId: "c".repeat(64),
        vaultGeneration: 1,
      }),
    ).rejects.toThrow("different vault");

    first.applyEnvironment.mockRejectedValueOnce(new Error("renderer rejected"));
    await expect(bridge.update({ appearanceCss: ".broken {}" })).rejects.toThrow(
      "rejected environment sequence",
    );
    expect(bridge.currentEnvironment?.sequence).toBe(2);
  });
});
