import {
  accessibilityAccentChoices,
  type EffectiveAccessibilityPreferences,
} from "./accessibility-preferences";
import type { PluginEditorContext, RuntimeSnapshot } from "./contracts";
import { parseVaultNoteWorkflowSettings, type VaultNoteWorkflowSettings } from "./note-workflows";
import type { PluginConstructionDispatch } from "./plugins";

export interface PluginMutationWaitOptions {
  quietMs?: number;
  timeoutMs?: number;
}

/**
 * A complete replacement of the isolated compatibility renderer environment.
 * The main process owns these bytes and the renderer owns their DOM nodes.
 */
export interface PluginRendererEnvironment {
  vaultId: string;
  vaultGeneration: number;
  sequence: number;
  theme: "dark" | "light";
  appearanceCss: string;
  pluginCss: string;
  accessibilityCss: string;
  accessibility: EffectiveAccessibilityPreferences;
  noteWorkflows: VaultNoteWorkflowSettings;
}

export const pluginRendererEnvironmentLimits = {
  maxVaultIdLength: 128,
  maxCssStringBytes: 4 * 1024 * 1024,
  maxAccessibilityCssBytes: 256 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxGeneration: Number.MAX_SAFE_INTEGER,
  maxSequence: Number.MAX_SAFE_INTEGER,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(
  value: unknown,
  field: string,
  maximumBytes: number,
  allowEmpty = true,
): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(`Plugin renderer environment ${field} must be a string.`);
  }
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes > maximumBytes) {
    throw new Error(`Plugin renderer environment ${field} exceeds its byte limit.`);
  }
  return value;
}

function boundedPositiveInteger(value: unknown, field: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Plugin renderer environment ${field} must be a positive safe integer.`);
  }
  return value;
}

function parseEffectiveAccessibility(value: unknown): EffectiveAccessibilityPreferences {
  if (!isRecord(value)) {
    throw new Error("Plugin renderer environment accessibility state must be an object.");
  }
  const expected = new Set([
    "highContrast",
    "accent",
    "uiFontScale",
    "textFontScale",
    "editorFontSize",
    "editorLineHeight",
    "reducedMotion",
    "reducedTransparency",
  ]);
  if (Object.keys(value).some((key) => !expected.has(key))) {
    throw new Error("Plugin renderer environment accessibility state has unknown fields.");
  }
  if (
    typeof value.highContrast !== "boolean" ||
    typeof value.reducedMotion !== "boolean" ||
    typeof value.reducedTransparency !== "boolean" ||
    !accessibilityAccentChoices.includes(
      value.accent as EffectiveAccessibilityPreferences["accent"],
    )
  ) {
    throw new Error("Plugin renderer environment accessibility flags are malformed.");
  }
  const ranges: Record<string, [number, number]> = {
    uiFontScale: [0.8, 1.6],
    textFontScale: [0.8, 1.8],
    editorFontSize: [11, 32],
    editorLineHeight: [1.2, 2.4],
  };
  for (const [field, [minimum, maximum]] of Object.entries(ranges)) {
    const candidate = value[field];
    if (
      typeof candidate !== "number" ||
      !Number.isFinite(candidate) ||
      candidate < minimum ||
      candidate > maximum
    ) {
      throw new Error(`Plugin renderer environment accessibility ${field} is out of range.`);
    }
  }
  return {
    highContrast: value.highContrast,
    accent: value.accent as EffectiveAccessibilityPreferences["accent"],
    uiFontScale: value.uiFontScale as number,
    textFontScale: value.textFontScale as number,
    editorFontSize: value.editorFontSize as number,
    editorLineHeight: value.editorLineHeight as number,
    reducedMotion: value.reducedMotion,
    reducedTransparency: value.reducedTransparency,
  };
}

export function parsePluginRendererEnvironment(value: unknown): PluginRendererEnvironment {
  if (!isRecord(value)) {
    throw new Error("Plugin renderer environment must be an object.");
  }
  const expected = new Set([
    "vaultId",
    "vaultGeneration",
    "sequence",
    "theme",
    "appearanceCss",
    "pluginCss",
    "accessibilityCss",
    "accessibility",
    "noteWorkflows",
  ]);
  if (Object.keys(value).some((key) => !expected.has(key))) {
    throw new Error("Plugin renderer environment has unknown fields.");
  }
  const vaultId = boundedString(
    value.vaultId,
    "vaultId",
    pluginRendererEnvironmentLimits.maxVaultIdLength,
    false,
  );
  const vaultGeneration = boundedPositiveInteger(
    value.vaultGeneration,
    "vaultGeneration",
    pluginRendererEnvironmentLimits.maxGeneration,
  );
  const sequence = boundedPositiveInteger(
    value.sequence,
    "sequence",
    pluginRendererEnvironmentLimits.maxSequence,
  );
  if (value.theme !== "dark" && value.theme !== "light") {
    throw new Error("Plugin renderer environment theme must be dark or light.");
  }
  const appearanceCss = boundedString(
    value.appearanceCss,
    "appearanceCss",
    pluginRendererEnvironmentLimits.maxCssStringBytes,
  );
  const pluginCss = boundedString(
    value.pluginCss,
    "pluginCss",
    pluginRendererEnvironmentLimits.maxCssStringBytes,
  );
  const accessibilityCss = boundedString(
    value.accessibilityCss,
    "accessibilityCss",
    pluginRendererEnvironmentLimits.maxAccessibilityCssBytes,
  );
  const accessibility = parseEffectiveAccessibility(value.accessibility);
  const noteWorkflows = parseVaultNoteWorkflowSettings(value.noteWorkflows);
  const totalBytes = [
    vaultId,
    appearanceCss,
    pluginCss,
    accessibilityCss,
    JSON.stringify(noteWorkflows),
  ].reduce((total, item) => total + new TextEncoder().encode(item).byteLength, 0);
  if (totalBytes > pluginRendererEnvironmentLimits.maxTotalBytes) {
    throw new Error("Plugin renderer environment exceeds its total byte limit.");
  }
  return {
    vaultId,
    vaultGeneration,
    sequence,
    theme: value.theme,
    appearanceCss,
    pluginCss,
    accessibilityCss,
    accessibility,
    noteWorkflows,
  };
}

export const pluginRendererChannels = {
  ready: "threadleaf:plugin-renderer-ready",
  request: "threadleaf:plugin-renderer-request",
  response: "threadleaf:plugin-renderer-response",
  vaultCreate: "threadleaf:plugin-renderer-vault-create",
  vaultCreateBinary: "threadleaf:plugin-renderer-vault-create-binary",
  vaultCreateFolder: "threadleaf:plugin-renderer-vault-create-folder",
  openFile: "threadleaf:plugin-renderer-open-file",
  surfaceChanged: "threadleaf:plugin-renderer-surface-changed",
  vaultListMarkdownPaths: "threadleaf:plugin-renderer-vault-list-markdown-paths",
  vaultReadText: "threadleaf:plugin-renderer-vault-read-text",
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

export interface PluginSurfaceChangedRequest {
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

export interface PluginOpenFileRequest {
  filePath: string;
  vaultPath: string;
}

export interface PluginVaultListMarkdownPathsRequest {
  relativeDirectory?: string;
  vaultPath: string;
}

export interface PluginVaultReadTextRequest {
  filePath: string;
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

export function parsePluginVaultListMarkdownPathsRequest(
  value: unknown,
): PluginVaultListMarkdownPathsRequest {
  if (!value || typeof value !== "object") {
    throw new Error("Plugin vault Markdown-path request must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.vaultPath !== "string" ||
    candidate.vaultPath.length === 0 ||
    (candidate.relativeDirectory !== undefined && typeof candidate.relativeDirectory !== "string")
  ) {
    throw new Error("Plugin vault Markdown-path requests require a vault path and directory.");
  }
  return {
    vaultPath: candidate.vaultPath,
    ...(candidate.relativeDirectory === undefined
      ? {}
      : { relativeDirectory: candidate.relativeDirectory }),
  };
}

export function parsePluginVaultReadTextRequest(value: unknown): PluginVaultReadTextRequest {
  if (!value || typeof value !== "object") {
    throw new Error("Plugin vault text-read request must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.vaultPath !== "string" ||
    candidate.vaultPath.length === 0 ||
    typeof candidate.filePath !== "string" ||
    candidate.filePath.length === 0
  ) {
    throw new Error("Plugin vault text reads require vault and file paths.");
  }
  return { vaultPath: candidate.vaultPath, filePath: candidate.filePath };
}

export const pluginRendererOperations = [
  "close",
  "close-view",
  "get-snapshot",
  "initialize",
  "apply-environment",
  "load-plugin",
  "mark-layout-ready",
  "open-settings",
  "open-view",
  "reload-plugin",
  "render-markdown",
  "run-command",
  "run-editor-paste",
  "query-editor-suggest",
  "select-editor-suggest",
  "query-file-menu",
  "select-file-menu",
  "dismiss-file-menu",
  "notify-vault-rename",
  "seed-vault-markdown-paths",
  "unload-all",
  "unload-plugin",
  "wait-for-mutations",
] as const;

export type PluginRendererOperation = (typeof pluginRendererOperations)[number];

export interface PluginRendererRequest {
  id: string;
  operation: PluginRendererOperation;
  payload?: Record<string, unknown>;
}

export type PluginRendererResponse =
  | { id: string; ok: true; value: RuntimeSnapshot | null }
  | { id: string; ok: false; error: string };

const operations = new Set<PluginRendererOperation>(pluginRendererOperations);

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

export function requirePluginRendererEnvironment(
  request: PluginRendererRequest,
): PluginRendererEnvironment {
  return parsePluginRendererEnvironment(request.payload?.environment);
}

export function requirePluginConstructionDispatch(
  request: PluginRendererRequest,
): PluginConstructionDispatch {
  const value = request.payload?.dispatch;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>).pluginDirectory !== "string" ||
    !(value as Record<string, unknown>).policy ||
    typeof (value as Record<string, unknown>).policy !== "object" ||
    Array.isArray((value as Record<string, unknown>).policy)
  ) {
    throw new Error(`${request.operation} requires a main-process construction dispatch.`);
  }
  return structuredClone(value) as PluginConstructionDispatch;
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

export function requirePluginEditorContext(request: PluginRendererRequest): PluginEditorContext {
  return parsePluginEditorContext(request.payload?.editorContext);
}

export const maximumPluginClipboardTextBytes = 1024 * 1024;

export function requirePluginClipboardText(request: PluginRendererRequest): string {
  const value = requirePayloadContent(request, "clipboardText");
  if (new TextEncoder().encode(value).byteLength > maximumPluginClipboardTextBytes) {
    throw new Error("Plugin editor paste clipboard text exceeds its byte limit.");
  }
  return value;
}

export function requirePluginEditorSuggestSessionId(request: PluginRendererRequest): string {
  return boundedString(request.payload?.sessionId, "sessionId", 128, false);
}

export function requirePluginEditorSuggestItemIndex(request: PluginRendererRequest): number {
  const value = request.payload?.itemIndex;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= 20) {
    throw new Error("Plugin editor suggestion selection requires an item index from 0 through 19.");
  }
  return value as number;
}

export function requirePluginEditorSuggestShiftKey(request: PluginRendererRequest): boolean {
  const value = request.payload?.shiftKey;
  if (typeof value !== "boolean") {
    throw new Error("Plugin editor suggestion selection requires a boolean shiftKey value.");
  }
  return value;
}

function optionalMutationWaitDuration(
  request: PluginRendererRequest,
  key: keyof PluginMutationWaitOptions,
  minimum: number,
): number | undefined {
  const value = request.payload?.[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(
      `${request.operation} requires ${key} to be a safe integer of at least ${minimum}.`,
    );
  }
  return value;
}

export function optionalPluginMutationWaitOptions(
  request: PluginRendererRequest,
): PluginMutationWaitOptions | undefined {
  const quietMs = optionalMutationWaitDuration(request, "quietMs", 0);
  const timeoutMs = optionalMutationWaitDuration(request, "timeoutMs", 1);
  if (quietMs === undefined && timeoutMs === undefined) {
    return undefined;
  }
  return {
    ...(quietMs === undefined ? {} : { quietMs }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

export function parsePluginMutationWaitOptions(value: unknown): PluginMutationWaitOptions {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Plugin mutation wait options must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  const quietMs = candidate.quietMs;
  const timeoutMs = candidate.timeoutMs;
  if (
    (quietMs !== undefined &&
      (typeof quietMs !== "number" || !Number.isSafeInteger(quietMs) || quietMs < 0)) ||
    (timeoutMs !== undefined &&
      (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1))
  ) {
    throw new Error("Plugin mutation wait options require safe integer quiet and timeout values.");
  }
  return {
    ...(quietMs === undefined ? {} : { quietMs }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
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

export function parsePluginOpenFileRequest(value: unknown): PluginOpenFileRequest {
  if (!value || typeof value !== "object") {
    throw new Error("Plugin file-open request must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.vaultPath !== "string" ||
    candidate.vaultPath.length === 0 ||
    typeof candidate.filePath !== "string" ||
    candidate.filePath.length === 0
  ) {
    throw new Error("Plugin file-open requests require vault and file paths.");
  }
  return { vaultPath: candidate.vaultPath, filePath: candidate.filePath };
}

export function parsePluginSurfaceChangedRequest(value: unknown): PluginSurfaceChangedRequest {
  if (!value || typeof value !== "object") {
    throw new Error("Plugin surface-change request must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.vaultPath !== "string" || candidate.vaultPath.length === 0) {
    throw new Error("Plugin surface-change requests require a vault path.");
  }
  return { vaultPath: candidate.vaultPath };
}

export function requirePayloadString(request: PluginRendererRequest, key: string): string {
  const value = request.payload?.[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${request.operation} requires a non-empty ${key} string.`);
  }
  return value;
}

/**
 * Like {@link requirePayloadString}, but for a payload member such as note content that is a
 * required string yet may legitimately be empty (an empty note).
 */
export function requirePayloadContent(request: PluginRendererRequest, key: string): string {
  const value = request.payload?.[key];
  if (typeof value !== "string") {
    throw new Error(`${request.operation} requires a ${key} string.`);
  }
  return value;
}

export function requirePayloadStringArray(request: PluginRendererRequest, key: string): string[] {
  const value = request.payload?.[key];
  if (!Array.isArray(value) || value.length > 500_000) {
    throw new Error(`${request.operation} requires a bounded ${key} string array.`);
  }
  let totalBytes = 0;
  const strings = value.map((item) => {
    if (typeof item !== "string" || item.length === 0 || item.length > 4_096) {
      throw new Error(`${request.operation} requires valid ${key} strings.`);
    }
    totalBytes += new TextEncoder().encode(item).byteLength;
    if (totalBytes > 64 * 1024 * 1024) {
      throw new Error(`${request.operation} ${key} exceeds its byte limit.`);
    }
    return item;
  });
  return strings;
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
