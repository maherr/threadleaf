import type { RuntimeSnapshot } from "./contracts";

export const pluginRendererChannels = {
  ready: "threadleaf:plugin-renderer-ready",
  request: "threadleaf:plugin-renderer-request",
  response: "threadleaf:plugin-renderer-response",
} as const;

export type PluginRendererOperation =
  | "close"
  | "close-view"
  | "get-snapshot"
  | "initialize"
  | "load-plugin"
  | "mark-layout-ready"
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
