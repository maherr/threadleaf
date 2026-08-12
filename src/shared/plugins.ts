export const compatibilityModes = ["restricted", "enabled"] as const;
export const maxPluginBundleBytes = 16 * 1024 * 1024;

export type CompatibilityMode = (typeof compatibilityModes)[number];

export interface VaultPluginSettings {
  compatibilityMode: CompatibilityMode;
  enabledPluginIds: string[];
}

export interface PluginManifestData {
  id: string;
  name: string;
  version: string;
  minAppVersion: string | null;
  description: string | null;
  author: string | null;
  authorUrl: string | null;
  isDesktopOnly: boolean;
}

export type PluginCompatibilityEvidenceStatus = "verified" | "different-version" | "unverified";

export interface PluginCompatibilityReport {
  level: 0 | 4;
  status: PluginCompatibilityEvidenceStatus;
  testedVersion: string | null;
  summary: string;
}

export type PluginPackageState = "ready" | "invalid";

export interface PluginPackageSummary extends PluginManifestData {
  source: "obsidian-vault";
  packageState: PluginPackageState;
  stylesheetDiscovered: boolean;
  compatibility: PluginCompatibilityReport;
  error: string | null;
}

export interface PluginCatalogSnapshot {
  vaultId: string;
  preference: VaultPluginSettings;
  safeMode: boolean;
  plugins: PluginPackageSummary[];
  warnings: string[];
  css: string;
}

export type PluginCatalogResponse =
  | { status: "ready"; catalog: PluginCatalogSnapshot }
  | { status: "stale-vault"; vaultId: string };

export const defaultVaultPluginSettings: Readonly<VaultPluginSettings> = {
  compatibilityMode: "restricted",
  enabledPluginIds: [],
};

const pluginIdPattern = /^[a-z0-9][a-z0-9-]{0,127}$/;

const verifiedPluginWorkflows: Readonly<Record<string, { version: string; workflow: string }>> = {
  "obsidian-excalidraw-plugin": {
    version: "2.25.3",
    workflow: "Open, create, embed, SVG and PNG export, unload, and reload",
  },
  "threadleaf-fixture": {
    version: "0.1.0",
    workflow: "Activation, command execution, notice delivery, and unload",
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneLine(value: string, field: string, maxLength: number): string {
  const normalized = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    throw new Error(`Plugin manifest requires a non-empty ${field}.`);
  }
  if (normalized.length > maxLength) {
    throw new Error(`Plugin manifest ${field} exceeds ${maxLength} characters.`);
  }
  return normalized;
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new Error(`Plugin manifest requires a non-empty ${field}.`);
  }
  return oneLine(value, field, maxLength);
}

function optionalString(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Plugin manifest ${field} must be a string when present.`);
  }
  return oneLine(value, field, maxLength);
}

export function parsePluginId(value: unknown): string {
  if (typeof value !== "string" || !pluginIdPattern.test(value)) {
    throw new Error("Plugin identifier must use lowercase letters, numbers, and hyphens.");
  }
  return value;
}

export function parsePluginManifest(value: unknown): PluginManifestData {
  if (!isRecord(value)) {
    throw new Error("Plugin manifest must be an object.");
  }
  if (value.isDesktopOnly !== undefined && typeof value.isDesktopOnly !== "boolean") {
    throw new Error("Plugin manifest isDesktopOnly must be a boolean when present.");
  }
  return {
    id: parsePluginId(value.id),
    name: requiredString(value.name, "name", 200),
    version: requiredString(value.version, "version", 100),
    minAppVersion: optionalString(value.minAppVersion, "minAppVersion", 100),
    description: optionalString(value.description, "description", 2_000),
    author: optionalString(value.author, "author", 200),
    authorUrl: optionalString(value.authorUrl, "authorUrl", 2_000),
    isDesktopOnly: value.isDesktopOnly ?? false,
  };
}

export function createPluginCompatibilityReport(
  manifest: Pick<PluginManifestData, "id" | "version">,
): PluginCompatibilityReport {
  const evidence = verifiedPluginWorkflows[manifest.id];
  if (!evidence) {
    return {
      level: 0,
      status: "unverified",
      testedVersion: null,
      summary:
        "Package structure is valid. No production-path workflow is verified for this exact plugin version.",
    };
  }
  if (evidence.version !== manifest.version) {
    return {
      level: 0,
      status: "different-version",
      testedVersion: evidence.version,
      summary: `${evidence.workflow} workflows passed on ${evidence.version}; installed ${manifest.version} remains unverified.`,
    };
  }
  return {
    level: 4,
    status: "verified",
    testedVersion: evidence.version,
    summary: `${evidence.workflow} workflows passed on this exact version.`,
  };
}

export function parseVaultPluginSettings(value: unknown): VaultPluginSettings {
  if (
    !isRecord(value) ||
    !compatibilityModes.includes(value.compatibilityMode as CompatibilityMode)
  ) {
    throw new Error("Vault plugin settings require restricted or enabled compatibility mode.");
  }
  if (!Array.isArray(value.enabledPluginIds) || value.enabledPluginIds.length > 128) {
    throw new Error("Vault plugin settings may enable at most 128 plugins.");
  }
  const enabledPluginIds = value.enabledPluginIds.map(parsePluginId);
  if (new Set(enabledPluginIds).size !== enabledPluginIds.length) {
    throw new Error("Enabled plugin identifiers must be unique.");
  }
  return {
    compatibilityMode: value.compatibilityMode as CompatibilityMode,
    enabledPluginIds,
  };
}

export function createDefaultVaultPluginSettings(): VaultPluginSettings {
  return { compatibilityMode: "restricted", enabledPluginIds: [] };
}
