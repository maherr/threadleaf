/**
 * Renderer-visible diagnostics for the compatibility plugin catalog.
 *
 * The catalog deliberately exposes a small, stable vocabulary instead of forwarding
 * filesystem, parser, or plugin-provided error text.  The original error may still be
 * attached as a cause for developer logging, but it must never be used as UI text.
 */

export const pluginDiagnosticCodes = [
  "catalog-source-unreadable",
  "invalid-plugin-folder",
  "package-path-escape",
  "package-unreadable",
  "manifest-invalid",
  "manifest-id-mismatch",
  "bundle-missing",
  "bundle-invalid",
  "stylesheet-invalid",
  "managed-package-changed",
  "authority-grant-required",
  "package-review-stale",
  "runtime-load-failed",
  "runtime-command-failed",
  "runtime-view-failed",
  "runtime-settings-failed",
  "runtime-unload-failed",
  "runtime-recovery-failed",
  "runtime-render-failed",
  "registry-index-invalid",
  "package-operation-failed",
  "package-inventory-invalid",
  "package-transaction-invalid",
  "package-inspection-activation-failed",
  "package-inspection-cleanup-failed",
] as const;

export type PluginDiagnosticCode = (typeof pluginDiagnosticCodes)[number];

export interface PluginDiagnosticSubject {
  /** A validated plugin identifier. Never pass an arbitrary path or exception message. */
  pluginId?: string;
  /** A fixed, user-owned relative package path such as `.obsidian/plugins`. */
  packagePath?: string;
}

export interface PluginDiagnostic {
  code: PluginDiagnosticCode;
  message: string;
}

const diagnosticDescriptions: Readonly<Record<PluginDiagnosticCode, string>> = {
  "catalog-source-unreadable": "The plugin catalog source could not be read.",
  "invalid-plugin-folder": "A plugin folder did not have a valid plugin identifier.",
  "package-path-escape": "The plugin package resolved outside its allowed vault directory.",
  "package-unreadable": "The plugin package could not be read.",
  "manifest-invalid": "The plugin manifest could not be validated.",
  "manifest-id-mismatch": "The plugin manifest identifier does not match its package folder.",
  "bundle-missing": "The plugin package does not contain a readable main.js bundle.",
  "bundle-invalid": "The plugin main.js bundle could not be validated.",
  "stylesheet-invalid": "The plugin stylesheet was not applied because it could not be validated.",
  "managed-package-changed":
    "The reviewed plugin package bytes changed and the package was blocked.",
  "authority-grant-required":
    "The plugin requires a current exact-bundle authority grant before it can be enabled.",
  "package-review-stale":
    "Installed plugin files changed after review, so no package change was applied.",
  "runtime-load-failed": "The plugin could not be loaded by the compatibility runtime.",
  "runtime-command-failed":
    "The plugin command could not be completed by the compatibility runtime.",
  "runtime-view-failed": "The plugin view could not be opened by the compatibility runtime.",
  "runtime-settings-failed":
    "The plugin settings view could not be opened by the compatibility runtime.",
  "runtime-unload-failed": "The plugin did not finish cleanup in the compatibility runtime.",
  "runtime-recovery-failed":
    "The compatibility runtime recovered with the plugin operation stopped.",
  "runtime-render-failed":
    "The plugin could not settle a Markdown post-processor projection in the compatibility runtime.",
  "registry-index-invalid": "The community package index could not be validated.",
  "package-operation-failed": "The community plugin package operation could not be completed.",
  "package-inventory-invalid": "The private community package inventory could not be validated.",
  "package-transaction-invalid": "A private community package transaction could not be validated.",
  "package-inspection-activation-failed":
    "Trusted package inspection could not activate the exact package.",
  "package-inspection-cleanup-failed":
    "Trusted package inspection could not clean up the exact package.",
};

const pluginIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const relativePackagePathPattern = /^(?:\.?\.?\/)?[A-Za-z0-9._/-]{1,160}$/u;
const pluginIdExpression = "[A-Za-z0-9][A-Za-z0-9._-]{0,127}";
const relativePackagePathExpression = "(?:\\.?\\.?\\/)?[A-Za-z0-9._\\/-]{1,160}";

function safePluginId(value: string | undefined): string | null {
  return value && pluginIdPattern.test(value) ? value : null;
}

function safePackagePath(value: string | undefined): string | null {
  if (!value || !relativePackagePathPattern.test(value)) {
    return null;
  }
  const segments = value.replaceAll("\\", "/").split("/");
  return segments.includes("..") || value.startsWith("/") ? null : value;
}

export function pluginDiagnosticMessage(
  code: PluginDiagnosticCode,
  subject: PluginDiagnosticSubject = {},
): string {
  const pluginId = safePluginId(subject.pluginId);
  const packagePath = safePackagePath(subject.packagePath);
  const owner = pluginId ? `Plugin ${pluginId}: ` : "";
  const location = packagePath ? ` Check ${packagePath}.` : "";
  return `${owner}${diagnosticDescriptions[code]}${location} [${code}].`;
}

export function createPluginDiagnostic(
  code: PluginDiagnosticCode,
  subject: PluginDiagnosticSubject = {},
): PluginDiagnostic {
  return { code, message: pluginDiagnosticMessage(code, subject) };
}

/**
 * Accept only a message produced by this module. IPC may preserve an Error message but not its
 * non-enumerable diagnostic code, so the renderer reconstitutes the canonical text instead of
 * trusting an arbitrary string that happens to end with a known code.
 */
export function parsePluginDiagnosticMessage(value: unknown): PluginDiagnostic | null {
  if (typeof value !== "string") {
    return null;
  }
  const codeMatch = value.match(/\[([a-z-]+)\]\.$/u);
  if (!codeMatch || !isPluginDiagnosticCode(codeMatch[1])) {
    return null;
  }
  const code = codeMatch[1];
  const pluginMatch = value.match(new RegExp(`^Plugin (${pluginIdExpression}): `, "u"));
  const packageMatch = value.match(
    new RegExp(` Check (${relativePackagePathExpression})\\. \\[${code}\\]\\.$`, "u"),
  );
  const subject: PluginDiagnosticSubject = {
    ...(pluginMatch ? { pluginId: pluginMatch[1] } : {}),
    ...(packageMatch ? { packagePath: packageMatch[1] } : {}),
  };
  const message = pluginDiagnosticMessage(code, subject);
  return message === value ? { code, message } : null;
}

export function pluginDiagnosticError(
  code: PluginDiagnosticCode,
  subject: PluginDiagnosticSubject = {},
  cause?: unknown,
): Error {
  const error = new Error(
    pluginDiagnosticMessage(code, subject),
    cause === undefined ? undefined : { cause },
  );
  return withPluginDiagnosticCode(error, code);
}

export function isPluginDiagnosticCode(value: unknown): value is PluginDiagnosticCode {
  return typeof value === "string" && (pluginDiagnosticCodes as readonly string[]).includes(value);
}

/**
 * Read only an explicitly attached code from an error. Never read or return its message.
 * Loader/runtime code uses this for stage-specific classification while keeping the raw
 * exception available only to developer-side `cause` logging.
 */
export function attachedPluginDiagnosticCode(error: unknown): PluginDiagnosticCode | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const candidate = (error as { pluginDiagnosticCode?: unknown }).pluginDiagnosticCode;
  return isPluginDiagnosticCode(candidate) ? candidate : null;
}

export function withPluginDiagnosticCode(
  error: Error,
  code: PluginDiagnosticCode,
): Error & { pluginDiagnosticCode: PluginDiagnosticCode } {
  Object.defineProperty(error, "pluginDiagnosticCode", {
    configurable: true,
    enumerable: false,
    value: code,
    writable: false,
  });
  return error as Error & { pluginDiagnosticCode: PluginDiagnosticCode };
}
