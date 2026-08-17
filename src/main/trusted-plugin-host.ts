import type { VaultReadPort } from "../kernel/ports";
import type { CompatibilityVaultWritePort } from "../runtime/obsidian-compat";
import {
  PluginHost,
  type PluginHostOptions,
  type PluginModuleResolver,
} from "../runtime/plugin-host";

export interface TrustedPluginHostFactoryOptions {
  onEditorExtensionsChange?(extensions: readonly unknown[]): void;
  pluginModuleResolver: PluginModuleResolver;
  reader?: VaultReadPort;
  vaultPath: string;
  writer?: CompatibilityVaultWritePort;
}

export function createTrustedPluginHost(options: TrustedPluginHostFactoryOptions): PluginHost {
  const hostOptions: PluginHostOptions = {
    ...(options.onEditorExtensionsChange
      ? { onEditorExtensionsChange: options.onEditorExtensionsChange }
      : {}),
  };
  return new PluginHost(
    options.vaultPath,
    options.reader,
    undefined,
    options.pluginModuleResolver,
    options.writer,
    hostOptions,
  );
}
