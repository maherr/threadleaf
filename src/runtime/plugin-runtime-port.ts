import type { ActionRegistry } from "../application/action-registry";
import type { RuntimeSnapshot } from "../shared/contracts";

export interface PluginRuntimePort {
  getSnapshot(): Promise<RuntimeSnapshot>;
  loadPlugin(pluginDirectory: string): Promise<RuntimeSnapshot>;
  reloadPlugin(pluginId?: string): Promise<RuntimeSnapshot>;
  runCommand(commandId: string): Promise<RuntimeSnapshot>;
  unloadAllPlugins(): Promise<RuntimeSnapshot>;
  unloadPlugin(pluginId?: string): Promise<RuntimeSnapshot>;
  close(): Promise<void>;
}

export type PluginRuntimeFactory = (
  vaultPath: string,
  actions: ActionRegistry,
) => Promise<PluginRuntimePort>;
