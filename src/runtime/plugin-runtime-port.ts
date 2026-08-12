import type { ActionRegistry } from "../application/action-registry";
import type { PluginEditorContext, RuntimeSnapshot } from "../shared/contracts";

export interface PluginRuntimePort {
  closePluginView(): Promise<RuntimeSnapshot>;
  getSnapshot(): Promise<RuntimeSnapshot>;
  loadPlugin(pluginDirectory: string): Promise<RuntimeSnapshot>;
  markLayoutReady(): Promise<RuntimeSnapshot>;
  openPluginView(viewType: string, filePath?: string): Promise<RuntimeSnapshot>;
  reloadPlugin(pluginId?: string): Promise<RuntimeSnapshot>;
  runCommand(commandId: string, editorContext?: PluginEditorContext): Promise<RuntimeSnapshot>;
  unloadAllPlugins(): Promise<RuntimeSnapshot>;
  unloadPlugin(pluginId?: string): Promise<RuntimeSnapshot>;
  close(): Promise<void>;
}

export type PluginRuntimeFactory = (
  vaultPath: string,
  actions: ActionRegistry,
) => Promise<PluginRuntimePort>;
