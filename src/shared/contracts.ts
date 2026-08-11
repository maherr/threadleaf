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

export interface ActionSummary {
  id: string;
  name: string;
  source: "workspace" | "plugin" | "system";
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
    mode: "synthetic-read-only" | "kernel-backed-fixture";
  };
  plugin: PluginSummary | null;
  commands: CommandSummary[];
  actions: ActionSummary[];
  notices: string[];
  events: RuntimeEvent[];
  workspace?: WorkspaceSnapshot;
}

export interface WorkspaceFileSummary {
  path: string;
  title: string;
  tags: string[];
  backlinkCount: number;
  outgoingCount: number;
  unresolvedCount: number;
}

export interface WorkspaceLinkSummary {
  label: string;
  status: "resolved" | "unresolved" | "ambiguous";
  path?: string;
}

export interface WorkspaceNoteSnapshot {
  path: string;
  title: string;
  content: string;
  revision: string;
  tags: string[];
  headings: Array<{ level: number; text: string; line: number }>;
  outgoing: WorkspaceLinkSummary[];
  backlinks: string[];
}

export interface WorkspaceSnapshot {
  state: "ready" | "degraded";
  files: WorkspaceFileSummary[];
  activeNote: WorkspaceNoteSnapshot | null;
  recoveryActionCount: number;
  watcher: {
    lastSequence: number;
    lastRescanReason: string | null;
    error: string | null;
  };
}

export interface ThreadleafBridge {
  getSnapshot(): Promise<RuntimeSnapshot>;
  runCommand(commandId: string): Promise<RuntimeSnapshot>;
  reloadPlugin(): Promise<RuntimeSnapshot>;
  unloadPlugin(): Promise<RuntimeSnapshot>;
  openNote(path: string): Promise<RuntimeSnapshot>;
  onSnapshot(listener: (snapshot: RuntimeSnapshot) => void): () => void;
}
