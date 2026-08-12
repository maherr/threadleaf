import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { installObsidianDomCompatibility } from "../runtime/obsidian-dom";
import type { PluginRendererRequest } from "../shared/plugin-runtime-protocol";
import { PluginRendererService } from "./plugin-renderer-service";

const previousGlobals = new Map<string, PropertyDescriptor | undefined>();

function exposeDom(dom: JSDOM): void {
  for (const [name, value] of Object.entries({
    DocumentFragment: dom.window.DocumentFragment,
    Element: dom.window.Element,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    MouseEvent: dom.window.MouseEvent,
    SVGSVGElement: dom.window.SVGSVGElement,
    document: dom.window.document,
    window: dom.window,
  })) {
    previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
  }
}

afterEach(() => {
  for (const [name, descriptor] of previousGlobals) {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, name);
    }
  }
  previousGlobals.clear();
});

function request(
  operation: PluginRendererRequest["operation"],
  payload?: Record<string, unknown>,
): PluginRendererRequest {
  return { id: `${operation}-request`, operation, ...(payload ? { payload } : {}) };
}

describe("PluginRendererService", () => {
  it("owns a DOM plugin lifecycle behind the renderer protocol", async () => {
    const sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-renderer-service-"));
    const vaultPath = path.join(sandboxPath, "vault");
    const pluginPath = path.join(vaultPath, ".obsidian", "plugins", "renderer-fixture");
    const dom = new JSDOM("<!doctype html><body></body>", {
      url: "https://threadleaf.invalid/",
    });
    installObsidianDomCompatibility(dom.window);
    exposeDom(dom);
    try {
      await fs.mkdir(pluginPath, { recursive: true });
      await fs.writeFile(
        path.join(pluginPath, "manifest.json"),
        JSON.stringify({ id: "renderer-fixture", name: "Renderer fixture", version: "0.1.0" }),
        "utf8",
      );
      await fs.writeFile(
        path.join(pluginPath, "main.js"),
        `const { Notice, Plugin } = require("obsidian");
module.exports = class RendererFixture extends Plugin {
  async onload() {
    this.addRibbonIcon("leaf", "Renderer action", () => new Notice("Renderer action ran."));
    this.addCommand({ id: "renderer-command", name: "Renderer command", callback: () => new Notice("Renderer command ran.") });
  }
};
`,
        "utf8",
      );

      const service = new PluginRendererService();
      const initialized = await service.handle(
        request("initialize", {
          vaultPath,
          packageJsonPath: path.resolve("package.json"),
        }),
      );
      expect(initialized?.vault.path).toBe(path.resolve(vaultPath));

      const loaded = await service.handle(request("load-plugin", { pluginDirectory: pluginPath }));
      expect(loaded?.plugin).toMatchObject({
        id: "renderer-fixture",
        state: "loaded",
        compatibilityLevel: 3,
      });
      expect(loaded?.actions.map(({ id }) => id)).toEqual(["renderer-command"]);

      const ran = await service.handle(request("run-command", { commandId: "renderer-command" }));
      expect(ran?.notices).toContain("Renderer command ran.");
      expect(ran?.plugin?.compatibilityLevel).toBe(4);

      const unloaded = await service.handle(request("unload-all"));
      expect(unloaded?.plugin?.state).toBe("unloaded");
      expect(unloaded?.commands).toEqual([]);

      await service.handle(request("close"));
      await expect(service.handle(request("get-snapshot"))).rejects.toThrow(
        "has not been initialized",
      );
    } finally {
      dom.window.close();
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });
});
