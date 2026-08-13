import { pluginCompatibilityRegistry } from "../generated/plugin-compatibility-registry";

export const compatibilityModes = ["restricted", "enabled"] as const;
export const maxPluginBundleBytes = 16 * 1024 * 1024;
export const pluginCapabilityIds = [
  "vault-read",
  "vault-write",
  "network",
  "filesystem",
  "subprocess",
  "host-environment",
  "clipboard",
  "external-navigation",
  "editor-extension",
  "workspace-ui",
  "dynamic-code",
] as const;

export type CompatibilityMode = (typeof compatibilityModes)[number];
export type PluginCapabilityId = (typeof pluginCapabilityIds)[number];

export interface PluginCapabilityDefinition {
  label: string;
  description: string;
}

export const pluginCapabilityDefinitions: Readonly<
  Record<PluginCapabilityId, PluginCapabilityDefinition>
> = {
  "vault-read": {
    label: "Read vault content",
    description: "References APIs that can inspect notes, attachments, or vault metadata.",
  },
  "vault-write": {
    label: "Change vault content",
    description: "References APIs that can create, edit, move, rename, or delete vault files.",
  },
  network: {
    label: "Use the network",
    description: "References browser or Node networking APIs that can contact remote services.",
  },
  filesystem: {
    label: "Access the host filesystem",
    description: "References Node filesystem APIs outside Threadleaf's vault abstraction.",
  },
  subprocess: {
    label: "Run host processes",
    description: "References Node child-process APIs that can launch programs or shell commands.",
  },
  "host-environment": {
    label: "Inspect the host environment",
    description: "References environment, operating-system, or home-directory information.",
  },
  clipboard: {
    label: "Read or change the clipboard",
    description: "References browser or Electron clipboard APIs.",
  },
  "external-navigation": {
    label: "Open external destinations",
    description: "References APIs that can open a browser, application, or external URL.",
  },
  "editor-extension": {
    label: "Extend the editor",
    description: "References CodeMirror or Obsidian editor-extension APIs.",
  },
  "workspace-ui": {
    label: "Change workspace UI",
    description: "References commands, views, settings, ribbon, status, or Markdown render hooks.",
  },
  "dynamic-code": {
    label: "Evaluate dynamic code",
    description: "References runtime code evaluation or dynamically selected modules.",
  },
};

export interface PluginCapabilityFinding {
  capability: PluginCapabilityId;
  evidence: string[];
}

export interface PluginCapabilityReport {
  scannerVersion: 1;
  bundleSha256: string;
  capabilities: PluginCapabilityId[];
  findings: PluginCapabilityFinding[];
  staticOnly: true;
}

export interface PluginCapabilityGrant {
  bundleSha256: string;
  capabilities: PluginCapabilityId[];
}

export type PluginCapabilityGrantState = "unavailable" | "required" | "granted" | "stale";

export interface VaultPluginSettings {
  compatibilityMode: CompatibilityMode;
  enabledPluginIds: string[];
  capabilityGrantsByPlugin: Record<string, PluginCapabilityGrant>;
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
  testedThreadleafVersion: string | null;
  lastTested: string | null;
  summary: string;
}

export type PluginPackageState = "ready" | "invalid";

export interface PluginPackageSummary extends PluginManifestData {
  source: "obsidian-vault";
  packageState: PluginPackageState;
  stylesheetDiscovered: boolean;
  compatibility: PluginCompatibilityReport;
  capabilityReport: PluginCapabilityReport | null;
  capabilityGrantState: PluginCapabilityGrantState;
  error: string | null;
}

export interface PluginCatalogSnapshot {
  vaultId: string;
  preference: VaultPluginSettings;
  safeMode: boolean;
  plugins: PluginPackageSummary[];
  managedPackages: import("./plugin-packages").ManagedPluginPackageSummary[];
  warnings: string[];
  css: string;
}

export type PluginCatalogResponse =
  | { status: "ready"; catalog: PluginCatalogSnapshot }
  | { status: "stale-vault"; vaultId: string };

export const defaultVaultPluginSettings: Readonly<VaultPluginSettings> = {
  compatibilityMode: "restricted",
  enabledPluginIds: [],
  capabilityGrantsByPlugin: {},
};

const pluginIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

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
    throw new Error(
      "Plugin identifier must start with a letter or number and use only letters, numbers, dots, underscores, and hyphens.",
    );
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
  const candidates = pluginCompatibilityRegistry.entries.filter(
    (entry) => entry.plugin.id === manifest.id,
  );
  const evidence = candidates.find((entry) => entry.plugin.version === manifest.version);
  const reference = evidence ?? candidates.at(-1);
  if (evidence) {
    return {
      level: evidence.compatibilityLevel,
      status: "verified",
      testedVersion: evidence.plugin.version,
      testedThreadleafVersion: evidence.threadleafVersion,
      lastTested: evidence.lastTested,
      summary: `${evidence.summary} Verified with Threadleaf ${evidence.threadleafVersion} on ${evidence.lastTested}.`,
    };
  }
  if (!reference) {
    return {
      level: 0,
      status: "unverified",
      testedVersion: null,
      testedThreadleafVersion: null,
      lastTested: null,
      summary:
        "Package structure is valid. No production-path workflow is verified for this exact plugin version.",
    };
  }
  return {
    level: 0,
    status: "different-version",
    testedVersion: reference.plugin.version,
    testedThreadleafVersion: reference.threadleafVersion,
    lastTested: reference.lastTested,
    summary: `${reference.summary} Evidence applies to plugin ${reference.plugin.version} with Threadleaf ${reference.threadleafVersion}; installed ${manifest.version} remains unverified.`,
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
  const rawGrants = value.capabilityGrantsByPlugin ?? {};
  if (!isRecord(rawGrants) || Object.keys(rawGrants).length > 128) {
    throw new Error("Vault plugin settings may retain grants for at most 128 plugins.");
  }
  const capabilityGrantsByPlugin: Record<string, PluginCapabilityGrant> = {};
  for (const [rawPluginId, rawGrant] of Object.entries(rawGrants)) {
    const pluginId = parsePluginId(rawPluginId);
    if (
      !isRecord(rawGrant) ||
      typeof rawGrant.bundleSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(rawGrant.bundleSha256) ||
      !Array.isArray(rawGrant.capabilities) ||
      rawGrant.capabilities.length > pluginCapabilityIds.length
    ) {
      throw new Error(`Capability grant for ${pluginId} is malformed.`);
    }
    const capabilities = rawGrant.capabilities.map((capability) => {
      if (
        typeof capability !== "string" ||
        !pluginCapabilityIds.includes(capability as PluginCapabilityId)
      ) {
        throw new Error(`Capability grant for ${pluginId} contains an unknown authority.`);
      }
      return capability as PluginCapabilityId;
    });
    if (new Set(capabilities).size !== capabilities.length) {
      throw new Error(`Capability grant for ${pluginId} contains duplicate authorities.`);
    }
    capabilityGrantsByPlugin[pluginId] = {
      bundleSha256: rawGrant.bundleSha256,
      capabilities,
    };
  }
  return {
    compatibilityMode: value.compatibilityMode as CompatibilityMode,
    enabledPluginIds,
    capabilityGrantsByPlugin,
  };
}

export function createDefaultVaultPluginSettings(): VaultPluginSettings {
  return { compatibilityMode: "restricted", enabledPluginIds: [], capabilityGrantsByPlugin: {} };
}

export function pluginCapabilityGrantMatches(
  report: PluginCapabilityReport,
  grant: PluginCapabilityGrant | undefined,
): boolean {
  return (
    grant !== undefined &&
    grant.bundleSha256 === report.bundleSha256 &&
    grant.capabilities.length === report.capabilities.length &&
    grant.capabilities.every((capability, index) => capability === report.capabilities[index])
  );
}

export function pluginCapabilityGrantState(
  report: PluginCapabilityReport | null,
  grant: PluginCapabilityGrant | undefined,
): PluginCapabilityGrantState {
  if (!report) {
    return "unavailable";
  }
  if (!grant) {
    return "required";
  }
  return pluginCapabilityGrantMatches(report, grant) ? "granted" : "stale";
}
