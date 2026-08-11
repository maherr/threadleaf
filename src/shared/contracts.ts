export type PluginRuntimeState = "empty" | "loaded" | "unloaded" | "failed";

export type RuntimeEventKind = "runtime" | "plugin" | "command" | "notice" | "error";

export interface RuntimeEvent {
  sequence: number;
  kind: RuntimeEventKind;
  message: string;
}

export interface CommandSummary {
  id: string;
  name: string;
}

export interface PluginSummary {
  id: string;
  name: string;
  version: string;
  state: PluginRuntimeState;
  compatibilityLevel: 0 | 1 | 2 | 3 | 4;
  stylesheetDiscovered: boolean;
}

export interface RuntimeSnapshot {
  vault: {
    name: string;
    markdownFileCount: number;
    mode: "synthetic-read-only";
  };
  plugin: PluginSummary | null;
  commands: CommandSummary[];
  notices: string[];
  events: RuntimeEvent[];
}

export interface ThreadleafBridge {
  getSnapshot(): Promise<RuntimeSnapshot>;
  runCommand(commandId: string): Promise<RuntimeSnapshot>;
  reloadPlugin(): Promise<RuntimeSnapshot>;
  unloadPlugin(): Promise<RuntimeSnapshot>;
}
