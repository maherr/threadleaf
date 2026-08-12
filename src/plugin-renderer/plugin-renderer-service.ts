import { createRequire } from "node:module";
import path from "node:path";
import moment from "moment";
import { PluginHost } from "../runtime/plugin-host";
import {
  optionalPayloadString,
  optionalPluginEditorContext,
  type PluginRendererRequest,
  type PluginVaultCreateFolderRequest,
  type PluginVaultCreateFolderResponse,
  type PluginVaultCreateRequest,
  type PluginVaultCreateResponse,
  type PluginVaultWriteRequest,
  type PluginVaultWriteResponse,
  requirePayloadString,
} from "../shared/plugin-runtime-protocol";

export interface PluginRendererVaultMutations {
  createFolder(request: PluginVaultCreateFolderRequest): Promise<PluginVaultCreateFolderResponse>;
  createText(request: PluginVaultCreateRequest): Promise<PluginVaultCreateResponse>;
  writeText(request: PluginVaultWriteRequest): Promise<PluginVaultWriteResponse>;
}

export class PluginRendererService {
  private host: PluginHost | null = null;
  private restoreCompatibilityGlobals: (() => void) | null = null;
  private readonly vaultMutations: PluginRendererVaultMutations | undefined;

  constructor(vaultMutations?: PluginRendererVaultMutations) {
    this.vaultMutations = vaultMutations;
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
        const vaultMutations = this.vaultMutations;
        this.host = new PluginHost(
          vaultPath,
          undefined,
          undefined,
          createRequire(packageJsonPath),
          vaultMutations
            ? {
                writeText: (filePath, content, expectedRevision) =>
                  vaultMutations.writeText({
                    vaultPath,
                    filePath,
                    content,
                    expectedRevision,
                  }),
                createText: (filePath, content) =>
                  vaultMutations.createText({ vaultPath, filePath, content }),
                createFolder: (folderPath) =>
                  vaultMutations.createFolder({ vaultPath, folderPath }),
              }
            : undefined,
        );
        this.restoreCompatibilityGlobals = this.installCompatibilityGlobals(this.host);
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
        return this.requireHost().runCommand(
          requirePayloadString(request, "commandId"),
          optionalPluginEditorContext(request),
        );
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
      this.restoreCompatibilityGlobals?.();
      this.restoreCompatibilityGlobals = null;
    }
  }

  private installCompatibilityGlobals(host: PluginHost): () => void {
    const targets: object[] = [globalThis];
    if (typeof window !== "undefined" && window !== globalThis) {
      targets.push(window);
    }
    const values = { app: host.app, moment } as const;
    const descriptors = targets.flatMap((target) =>
      Object.entries(values).map(([name, value]) => ({
        descriptor: Object.getOwnPropertyDescriptor(target, name),
        name,
        target,
        value,
      })),
    );
    for (const { name, target, value } of descriptors) {
      Object.defineProperty(target, name, {
        configurable: true,
        enumerable: true,
        value,
        writable: false,
      });
    }
    return () => {
      for (const { descriptor, name, target } of descriptors) {
        if (descriptor) {
          Object.defineProperty(target, name, descriptor);
        } else {
          Reflect.deleteProperty(target, name);
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
