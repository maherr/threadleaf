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

export type VaultSelectionSource = "bundled" | "direct" | "environment" | "picked" | "restored";

export interface RuntimeSnapshot {
  vault: {
    id: string | null;
    name: string;
    path: string;
    markdownFileCount: number;
    mode: "synthetic-read-only" | "kernel-backed";
    source: VaultSelectionSource;
    warning: string | null;
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

export type NoteSaveOutcome =
  | {
      status: "committed";
      path: string;
      revision: string;
      transactionId: string;
    }
  | {
      status: "conflict";
      path: string;
      currentRevision: string | null;
      conflictPath: string;
      transactionId: string;
    };

export interface NoteSaveResponse {
  outcome: NoteSaveOutcome;
  snapshot: RuntimeSnapshot;
}

export type VaultOpenResponse =
  | { status: "cancelled"; snapshot: RuntimeSnapshot }
  | { status: "opened"; snapshot: RuntimeSnapshot }
  | { status: "failed"; message: string; snapshot: RuntimeSnapshot };

export interface ThreadleafBridge {
  getSnapshot(): Promise<RuntimeSnapshot>;
  chooseVault(): Promise<VaultOpenResponse>;
  runCommand(commandId: string): Promise<RuntimeSnapshot>;
  reloadPlugin(): Promise<RuntimeSnapshot>;
  unloadPlugin(): Promise<RuntimeSnapshot>;
  openNote(path: string): Promise<RuntimeSnapshot>;
  saveNote(
    path: string,
    content: string,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<NoteSaveResponse>;
  onSnapshot(listener: (snapshot: RuntimeSnapshot) => void): () => void;
}
