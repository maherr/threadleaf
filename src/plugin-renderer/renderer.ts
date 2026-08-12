import { ipcRenderer } from "electron";
import { installObsidianDomCompatibility } from "../runtime/obsidian-dom";
import {
  type PluginRendererResponse,
  type PluginVaultCreateBinaryResponse,
  type PluginVaultCreateFolderResponse,
  type PluginVaultCreateResponse,
  type PluginVaultWriteBinaryResponse,
  type PluginVaultWriteResponse,
  parsePluginRendererRequest,
  pluginRendererChannels,
} from "../shared/plugin-runtime-protocol";
import { PluginRendererService } from "./plugin-renderer-service";

installObsidianDomCompatibility(window, globalThis);

const service = new PluginRendererService({
  createBinary: (request) =>
    ipcRenderer.invoke(
      pluginRendererChannels.vaultCreateBinary,
      request,
    ) as Promise<PluginVaultCreateBinaryResponse>,
  createFolder: (request) =>
    ipcRenderer.invoke(
      pluginRendererChannels.vaultCreateFolder,
      request,
    ) as Promise<PluginVaultCreateFolderResponse>,
  createText: (request) =>
    ipcRenderer.invoke(
      pluginRendererChannels.vaultCreate,
      request,
    ) as Promise<PluginVaultCreateResponse>,
  writeBinary: (request) =>
    ipcRenderer.invoke(
      pluginRendererChannels.vaultWriteBinary,
      request,
    ) as Promise<PluginVaultWriteBinaryResponse>,
  writeText: (request) =>
    ipcRenderer.invoke(
      pluginRendererChannels.vaultWrite,
      request,
    ) as Promise<PluginVaultWriteResponse>,
});

ipcRenderer.on(pluginRendererChannels.request, async (_event, value: unknown) => {
  let response: PluginRendererResponse;
  let requestId = "invalid-request";
  try {
    const request = parsePluginRendererRequest(value);
    requestId = request.id;
    response = { id: request.id, ok: true, value: await service.handle(request) };
  } catch (error) {
    response = {
      id: requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  ipcRenderer.send(pluginRendererChannels.response, response);
});

window.addEventListener("beforeunload", () => {
  void service.close();
});

ipcRenderer.send(pluginRendererChannels.ready);
