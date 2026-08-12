import { createRequire } from "node:module";
import path from "node:path";
import { PluginHost } from "../runtime/plugin-host";
import {
  optionalPayloadString,
  type PluginRendererRequest,
  requirePayloadString,
} from "../shared/plugin-runtime-protocol";

export class PluginRendererService {
  private host: PluginHost | null = null;

  async handle(request: PluginRendererRequest) {
    switch (request.operation) {
      case "initialize": {
        const vaultPath = requirePayloadString(request, "vaultPath");
        const packageJsonPath = requirePayloadString(request, "packageJsonPath");
        if (!path.isAbsolute(vaultPath) || !path.isAbsolute(packageJsonPath)) {
          throw new Error("Plugin renderer initialization requires absolute paths.");
        }
        await this.close();
        this.host = new PluginHost(vaultPath, undefined, undefined, createRequire(packageJsonPath));
        return this.host.getSnapshot();
      }
      case "get-snapshot":
        return this.requireHost().getSnapshot();
      case "load-plugin":
        return this.requireHost().loadPlugin(requirePayloadString(request, "pluginDirectory"));
      case "reload-plugin":
        return this.requireHost().reloadPlugin(optionalPayloadString(request, "pluginId"));
      case "run-command":
        return this.requireHost().runCommand(requirePayloadString(request, "commandId"));
      case "unload-plugin":
        return this.requireHost().unloadPlugin(optionalPayloadString(request, "pluginId"));
      case "unload-all":
        return this.requireHost().unloadAllPlugins();
      case "mark-layout-ready":
        this.requireHost().app.workspace.markLayoutReady();
        return this.requireHost().getSnapshot();
      case "close":
        await this.close();
        return null;
    }
  }

  async close(): Promise<void> {
    const host = this.host;
    this.host = null;
    await host?.close();
  }

  private requireHost(): PluginHost {
    if (!this.host) {
      throw new Error("Plugin renderer has not been initialized.");
    }
    return this.host;
  }
}
