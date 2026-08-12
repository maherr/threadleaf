import type { PluginEditorContext, RuntimeSnapshot } from "./contracts";

export const pluginRendererChannels = {
  ready: "threadleaf:plugin-renderer-ready",
  request: "threadleaf:plugin-renderer-request",
  response: "threadleaf:plugin-renderer-response",
  vaultCreate: "threadleaf:plugin-renderer-vault-create",
  vaultCreateBinary: "threadleaf:plugin-renderer-vault-create-binary",
  vaultCreateFolder: "threadleaf:plugin-renderer-vault-create-folder",
  vaultRename: "threadleaf:plugin-renderer-vault-rename",
  vaultTrash: "threadleaf:plugin-renderer-vault-trash",
  vaultWrite: "threadleaf:plugin-renderer-vault-write",
  vaultWriteBinary: "threadleaf:plugin-renderer-vault-write-binary",
} as const;

export interface PluginVaultCreateRequest {
  content: string;
  filePath: string;
  vaultPath: string;
}

export type PluginVaultCreateResponse =
  | { status: "committed"; path: string; revision: string; transactionId: string }
  | { status: "exists"; path: string; currentRevision: string }
  | {
      status: "conflict";
      path: string;
      currentRevision: string | null;
      conflictPath: string;
      transactionId: string;
    };

export interface PluginVaultCreateBinaryRequest {
  content: ArrayBuffer;
  filePath: string;
  vaultPath: string;
}

export type PluginVaultCreateBinaryResponse = PluginVaultCreateResponse;

export interface PluginVaultCreateFolderRequest {
  folderPath: string;
  vaultPath: string;
}

export interface PluginVaultCreateFolderResponse {
  created: boolean;
  path: string;
}

export interface PluginVaultWriteRequest {
  content: string;
  expectedRevision: string;
  filePath: string;
  vaultPath: string;
}

export type PluginVaultWriteResponse =
  | { status: "committed"; path: string; revision: string; transactionId: string }
  | {
      status: "conflict";
      path: string;
      currentRevision: string | null;
      conflictPath: string;
      transactionId: string;
    };

export interface PluginVaultWriteBinaryRequest {
  content: ArrayBuffer;
  expectedRevision: string;
  filePath: string;
  vaultPath: string;
}

export type PluginVaultWriteBinaryResponse = PluginVaultWriteResponse;

export interface PluginVaultRenameRequest {
  expectedRevision: string;
  sourcePath: string;
  targetPath: string;
  vaultPath: string;
}

export type PluginVaultRenameResponse =
  | { status: "committed"; from: string; to: string; transactionId: string }
  | { status: "conflict"; from: string; to: string; reason: string };

export interface PluginVaultTrashRequest {
  expectedRevision: string;
  filePath: string;
  vaultPath: string;
}

export type PluginVaultTrashResponse = PluginVaultRenameResponse;

export type PluginRendererOperation =
  | "close"
  | "close-view"
  | "get-snapshot"
  | "initialize"
  | "load-plugin"
  | "mark-layout-ready"
  | "open-settings"
  | "open-view"
  | "reload-plugin"
  | "run-command"
  | "unload-all"
  | "unload-plugin";

export interface PluginRendererRequest {
  id: string;
  operation: PluginRendererOperation;
  payload?: Record<string, unknown>;
}

export type PluginRendererResponse =
  | { id: string; ok: true; value: RuntimeSnapshot | null }
  | { id: string; ok: false; error: string };

const operations = new Set<PluginRendererOperation>([
  "close",
  "close-view",
  "get-snapshot",
  "initialize",
  "load-plugin",
  "mark-layout-ready",
  "open-settings",
  "open-view",
  "reload-plugin",
  "run-command",
  "unload-all",
  "unload-plugin",
]);

export function parsePluginRendererRequest(value: unknown): PluginRendererRequest {
  if (!value || typeof value !== "object") {
    throw new Error("Plugin renderer request must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    candidate.id.length === 0 ||
    typeof candidate.operation !== "string" ||
    !operations.has(candidate.operation as PluginRendererOperation) ||
    !(
      candidate.payload === undefined ||
      (candidate.payload !== null &&
        typeof candidate.payload === "object" &&
        !Array.isArray(candidate.payload))
    )
  ) {
    throw new Error("Plugin renderer request has an invalid id, operation, or payload.");
  }
  return {
    id: candidate.id,
    operation: candidate.operation as PluginRendererOperation,
    ...(candidate.payload ? { payload: candidate.payload as Record<string, unknown> } : {}),
  };
}

export function parsePluginRendererResponse(value: unknown): PluginRendererResponse {
  if (!value || typeof value !== "object") {
    throw new Error("Plugin renderer returned a non-object response.");
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string" || typeof candidate.ok !== "boolean") {
    throw new Error("Plugin renderer response is missing its request identity or status.");
  }
  if (candidate.ok) {
    if (!(candidate.value === null || (candidate.value && typeof candidate.value === "object"))) {
      throw new Error("Plugin renderer success response has an invalid value.");
    }
    return {
      id: candidate.id,
      ok: true,
      value: candidate.value as RuntimeSnapshot | null,
    };
  }
  if (typeof candidate.error !== "string") {
    throw new Error("Plugin renderer failure response has no error message.");
  }
  return { id: candidate.id, ok: false, error: candidate.error };
}

export function parsePluginEditorContext(value: unknown): PluginEditorContext {
  if (!value || typeof value !== "object") {
    throw new Error("Plugin editor context must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  const selection = candidate.selection;
  if (
    typeof candidate.path !== "string" ||
    candidate.path.length === 0 ||
    typeof candidate.content !== "string" ||
    typeof candidate.revision !== "string" ||
    !/^[0-9a-f]{64}$/.test(candidate.revision) ||
    !selection ||
    typeof selection !== "object" ||
    typeof (selection as Record<string, unknown>).anchor !== "number" ||
    !Number.isSafeInteger((selection as Record<string, unknown>).anchor) ||
    ((selection as Record<string, unknown>).anchor as number) < 0 ||
    typeof (selection as Record<string, unknown>).head !== "number" ||
    !Number.isSafeInteger((selection as Record<string, unknown>).head) ||
    ((selection as Record<string, unknown>).head as number) < 0
  ) {
    throw new Error(
      "Plugin editor context requires path, content, SHA-256 revision, and non-negative selection offsets.",
    );
  }
  const anchor = (selection as Record<string, unknown>).anchor as number;
  const head = (selection as Record<string, unknown>).head as number;
  if (anchor > candidate.content.length || head > candidate.content.length) {
    throw new Error("Plugin editor selection offsets must fit within the supplied content.");
  }
  return {
    path: candidate.path,
    content: candidate.content,
    revision: candidate.revision,
    selection: { anchor, head },
  };
}

export function optionalPluginEditorContext(
  request: PluginRendererRequest,
): PluginEditorContext | undefined {
  const value = request.payload?.editorContext;
  return value === undefined ? undefined : parsePluginEditorContext(value);
}

export function parsePluginVaultWriteRequest(value: unknown): PluginVaultWriteRequest {
  if (!value || typeof value !== "object") {
    throw new Error("Plugin vault write request must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.vaultPath !== "string" ||
    candidate.vaultPath.length === 0 ||
    typeof candidate.filePath !== "string" ||
    candidate.filePath.length === 0 ||
    typeof candidate.content !== "string" ||
    typeof candidate.expectedRevision !== "string" ||
    !/^[0-9a-f]{64}$/.test(candidate.expectedRevision)
  ) {
    throw new Error(
      "Plugin vault writes require vault, file, content, and SHA-256 revision strings.",
    );
  }
  return {
    vaultPath: candidate.vaultPath,
    filePath: candidate.filePath,
    content: candidate.content,
    expectedRevision: candidate.expectedRevision,
  };
}

export function parsePluginVaultWriteBinaryRequest(value: unknown): PluginVaultWriteBinaryRequest {
  if (!value || typeof value !== "object") {
    throw new Error("Plugin binary vault write request must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.vaultPath !== "string" ||
    candidate.vaultPath.length === 0 ||
    typeof candidate.filePath !== "string" ||
    candidate.filePath.length === 0 ||
    !(candidate.content instanceof ArrayBuffer) ||
    typeof candidate.expectedRevision !== "string" ||
    !/^[0-9a-f]{64}$/.test(candidate.expectedRevision)
  ) {
    throw new Error(
      "Plugin binary vault writes require vault, file, ArrayBuffer content, and a SHA-256 revision.",
    );
  }
  return {
    vaultPath: candidate.vaultPath,
    filePath: candidate.filePath,
    content: candidate.content,
    expectedRevision: candidate.expectedRevision,
  };
}

export function parsePluginVaultRenameRequest(value: unknown): PluginVaultRenameRequest {
  if (!value || typeof value !== "object") {
    throw new Error("Plugin vault rename request must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.vaultPath !== "string" ||
    candidate.vaultPath.length === 0 ||
    typeof candidate.sourcePath !== "string" ||
    candidate.sourcePath.length === 0 ||
    typeof candidate.targetPath !== "string" ||
    candidate.targetPath.length === 0 ||
    typeof candidate.expectedRevision !== "string" ||
    !/^[0-9a-f]{64}$/.test(candidate.expectedRevision)
  ) {
    throw new Error(
      "Plugin vault renames require vault, source, target, and SHA-256 revision strings.",
    );
  }
  return {
    vaultPath: candidate.vaultPath,
    sourcePath: candidate.sourcePath,
    targetPath: candidate.targetPath,
    expectedRevision: candidate.expectedRevision,
  };
}

export function parsePluginVaultTrashRequest(value: unknown): PluginVaultTrashRequest {
  if (!value || typeof value !== "object") {
    throw new Error("Plugin vault trash request must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.vaultPath !== "string" ||
    candidate.vaultPath.length === 0 ||
    typeof candidate.filePath !== "string" ||
    candidate.filePath.length === 0 ||
    typeof candidate.expectedRevision !== "string" ||
    !/^[0-9a-f]{64}$/.test(candidate.expectedRevision)
  ) {
    throw new Error("Plugin vault trash requires vault, file, and SHA-256 revision strings.");
  }
  return {
    vaultPath: candidate.vaultPath,
    filePath: candidate.filePath,
    expectedRevision: candidate.expectedRevision,
  };
}

export function parsePluginVaultCreateRequest(value: unknown): PluginVaultCreateRequest {
  if (!value || typeof value !== "object") {
    throw new Error("Plugin vault create request must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.vaultPath !== "string" ||
    candidate.vaultPath.length === 0 ||
    typeof candidate.filePath !== "string" ||
    candidate.filePath.length === 0 ||
    typeof candidate.content !== "string"
  ) {
    throw new Error("Plugin vault creates require vault, file, and content strings.");
  }
  return {
    vaultPath: candidate.vaultPath,
    filePath: candidate.filePath,
    content: candidate.content,
  };
}

export function parsePluginVaultCreateBinaryRequest(
  value: unknown,
): PluginVaultCreateBinaryRequest {
  if (!value || typeof value !== "object") {
    throw new Error("Plugin binary vault create request must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.vaultPath !== "string" ||
    candidate.vaultPath.length === 0 ||
    typeof candidate.filePath !== "string" ||
    candidate.filePath.length === 0 ||
    !(candidate.content instanceof ArrayBuffer)
  ) {
    throw new Error("Plugin binary vault creates require vault, file, and ArrayBuffer content.");
  }
  return {
    vaultPath: candidate.vaultPath,
    filePath: candidate.filePath,
    content: candidate.content,
  };
}

export function parsePluginVaultCreateFolderRequest(
  value: unknown,
): PluginVaultCreateFolderRequest {
  if (!value || typeof value !== "object") {
    throw new Error("Plugin vault folder create request must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.vaultPath !== "string" ||
    candidate.vaultPath.length === 0 ||
    typeof candidate.folderPath !== "string" ||
    candidate.folderPath.length === 0
  ) {
    throw new Error("Plugin vault folder creates require vault and folder strings.");
  }
  return { vaultPath: candidate.vaultPath, folderPath: candidate.folderPath };
}

export function requirePayloadString(request: PluginRendererRequest, key: string): string {
  const value = request.payload?.[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${request.operation} requires a non-empty ${key} string.`);
  }
  return value;
}

export function optionalPayloadString(
  request: PluginRendererRequest,
  key: string,
): string | undefined {
  const value = request.payload?.[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${request.operation} requires ${key} to be a non-empty string when set.`);
  }
  return value;
}
