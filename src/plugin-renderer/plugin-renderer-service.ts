import { createRequire } from "node:module";
import path from "node:path";
import { PluginHost } from "../runtime/plugin-host";
import {
  optionalPayloadString,
  type PluginRendererRequest,
  type PluginVaultWriteRequest,
  type PluginVaultWriteResponse,
  requirePayloadString,
} from "../shared/plugin-runtime-protocol";

export type PluginRendererVaultWriter = (
  request: PluginVaultWriteRequest,
) => Promise<PluginVaultWriteResponse>;

export class PluginRendererService {
  private host: PluginHost | null = null;
  private restoreGlobalApp: (() => void) | null = null;
  private readonly writeVaultText: PluginRendererVaultWriter | undefined;

  constructor(writeVaultText?: PluginRendererVaultWriter) {
    this.writeVaultText = writeVaultText;
  }

  async handle(request: PluginRendererRequest) {
    switch (request.operation) {
      case "initialize": {
        const vaultPath = requirePayloadString(request, "vaultPath");
        const packageJsonPath = requirePayloadString(request, "packageJsonPath");
        if (!path.isAbsolute(vaultPath) || !path.isAbsolute(packageJsonPath)) {
          throw new Error("Plugin renderer initialization requires absolute paths.");
        }
        await this.close();
        const writeVaultText = this.writeVaultText;
        this.host = new PluginHost(
          vaultPath,
          undefined,
          undefined,
          createRequire(packageJsonPath),
          writeVaultText
            ? {
                writeText: (filePath, content, expectedRevision) =>
                  writeVaultText({
                    vaultPath,
                    filePath,
                    content,
                    expectedRevision,
                  }),
              }
            : undefined,
        );
        this.restoreGlobalApp = this.installGlobalApp(this.host);
        return this.host.getSnapshot();
      }
      case "get-snapshot":
        return this.requireHost().getSnapshot();
      case "load-plugin":
        await this.requireHost().closePluginView();
        return this.requireHost().loadPlugin(requirePayloadString(request, "pluginDirectory"));
      case "reload-plugin":
        await this.requireHost().closePluginView();
        return this.requireHost().reloadPlugin(optionalPayloadString(request, "pluginId"));
      case "run-command":
        return this.requireHost().runCommand(requirePayloadString(request, "commandId"));
      case "unload-plugin":
        return this.requireHost().unloadPlugin(optionalPayloadString(request, "pluginId"));
      case "unload-all":
        return this.requireHost().unloadAllPlugins();
      case "mark-layout-ready":
        return this.requireHost().markLayoutReady();
      case "open-view":
        return this.requireHost().openPluginView(
          requirePayloadString(request, "viewType"),
          optionalPayloadString(request, "filePath"),
        );
      case "close-view":
        return this.requireHost().closePluginView();
      case "close":
        await this.close();
        return null;
    }
  }

  async close(): Promise<void> {
    const host = this.host;
    this.host = null;
    try {
      await host?.close();
    } finally {
      this.restoreGlobalApp?.();
      this.restoreGlobalApp = null;
    }
  }

  private installGlobalApp(host: PluginHost): () => void {
    const targets: object[] = [globalThis];
    if (typeof window !== "undefined" && window !== globalThis) {
      targets.push(window);
    }
    const descriptors = targets.map((target) => ({
      descriptor: Object.getOwnPropertyDescriptor(target, "app"),
      target,
    }));
    for (const { target } of descriptors) {
      Object.defineProperty(target, "app", {
        configurable: true,
        enumerable: true,
        value: host.app,
        writable: false,
      });
    }
    return () => {
      for (const { descriptor, target } of descriptors) {
        if (descriptor) {
          Object.defineProperty(target, "app", descriptor);
        } else {
          Reflect.deleteProperty(target, "app");
        }
      }
    };
  }

  private requireHost(): PluginHost {
    if (!this.host) {
      throw new Error("Plugin renderer has not been initialized.");
    }
    return this.host;
  }
}
