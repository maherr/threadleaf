import type { VaultReadPort } from "../kernel/ports";
import type { CompatibilityVaultWritePort } from "../runtime/obsidian-compat";
import type { EditorCompatibilityFields } from "../runtime/obsidian-editor-compat";
import {
  PluginHost,
  type PluginHostOptions,
  type PluginModuleResolver,
} from "../runtime/plugin-host";

export interface TrustedPluginHostFactoryOptions {
  editorFields?: EditorCompatibilityFields;
  onEditorExtensionsChange?(extensions: readonly unknown[]): void;
  onOpenFile?(filePath: string): void | Promise<void>;
  pluginModuleResolver: PluginModuleResolver;
  reader?: VaultReadPort;
  vaultPath: string;
  writer?: CompatibilityVaultWritePort;
}

export function createTrustedPluginHost(options: TrustedPluginHostFactoryOptions): PluginHost {
  const hostOptions: PluginHostOptions = {
    ...(options.editorFields ? { compatibilityEditorFields: options.editorFields } : {}),
    ...(options.onEditorExtensionsChange
      ? { onEditorExtensionsChange: options.onEditorExtensionsChange }
      : {}),
    ...(options.onOpenFile ? { onOpenFile: options.onOpenFile } : {}),
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
