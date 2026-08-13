/** The first native extension manifest shape. Bump only with a compatibility decision. */
export const nativeExtensionManifestVersion = 1 as const;
export const nativeExtensionApiVersion = "1.0" as const;

export const nativeExtensionCapabilityIds = [
  "vault.read",
  "vault.write",
  "network",
  "clipboard",
  "external-navigation",
  "editor-ui",
  "workspace-ui",
  "subprocess",
  "secrets",
  "dynamic-code",
] as const;

export type NativeExtensionCapabilityId = (typeof nativeExtensionCapabilityIds)[number];
export type NativeExtensionRuntime = "portable" | "desktop-trusted";
export type NativeExtensionBoundary = "capability-governed" | "trusted-desktop-escape";

export interface NativeExtensionCapabilityDefinition {
  readonly id: NativeExtensionCapabilityId;
  readonly label: string;
  readonly description: string;
  readonly availability: "portable" | "desktop-only";
  readonly boundary: NativeExtensionBoundary;
}

/**
 * This table is enforcement metadata, not display-only copy. The host checks availability and
 * boundary from the ID in this table before it calls a public port.
 */
export const nativeExtensionCapabilityDefinitions: Readonly<
  Record<NativeExtensionCapabilityId, NativeExtensionCapabilityDefinition>
> = {
  "vault.read": {
    id: "vault.read",
    label: "Read vault content",
    description: "Read Markdown paths and bounded text snapshots from the selected vault.",
    availability: "portable",
    boundary: "capability-governed",
  },
  "vault.write": {
    id: "vault.write",
    label: "Write vault content",
    description: "Write a revision-checked text file through the recoverable vault port.",
    availability: "portable",
    boundary: "capability-governed",
  },
  network: {
    id: "network",
    label: "Use the network",
    description: "Make requests through the host's explicit network port.",
    availability: "portable",
    boundary: "capability-governed",
  },
  clipboard: {
    id: "clipboard",
    label: "Read or change the clipboard",
    description: "Read or replace clipboard text through the host port.",
    availability: "portable",
    boundary: "capability-governed",
  },
  "external-navigation": {
    id: "external-navigation",
    label: "Open an external destination",
    description: "Ask the desktop to open an allowlisted external HTTP(S) destination.",
    availability: "desktop-only",
    boundary: "trusted-desktop-escape",
  },
  "editor-ui": {
    id: "editor-ui",
    label: "Use editor UI",
    description: "Read the active editor selection or request an editor insertion.",
    availability: "portable",
    boundary: "capability-governed",
  },
  "workspace-ui": {
    id: "workspace-ui",
    label: "Use workspace UI",
    description: "Request a bounded workspace notice or open a vault-relative file.",
    availability: "portable",
    boundary: "capability-governed",
  },
  subprocess: {
    id: "subprocess",
    label: "Run a host process",
    description: "Run a host process through an explicit desktop adapter.",
    availability: "desktop-only",
    boundary: "trusted-desktop-escape",
  },
  secrets: {
    id: "secrets",
    label: "Read named secrets",
    description: "Read a named secret through the host's secret provider.",
    availability: "desktop-only",
    boundary: "trusted-desktop-escape",
  },
  "dynamic-code": {
    id: "dynamic-code",
    label: "Evaluate dynamic code",
    description: "Ask a trusted desktop adapter to evaluate supplied code.",
    availability: "desktop-only",
    boundary: "trusted-desktop-escape",
  },
};

export interface NativeExtensionCapabilityDeclaration {
  id: NativeExtensionCapabilityId;
  /** Human explanation shown during review. It is never used as authority. */
  reason?: string;
}

export interface NativeExtensionManifest {
  manifestVersion: typeof nativeExtensionManifestVersion;
  apiVersion: typeof nativeExtensionApiVersion;
  id: string;
  name: string;
  version: string;
  entrypoint: string;
  portable: boolean;
  desktopOnly: boolean;
  capabilities: NativeExtensionCapabilityDeclaration[];
}

export interface NativeExtensionManifestSummary {
  id: string;
  name: string;
  version: string;
  entrypoint: string;
  portable: boolean;
  desktopOnly: boolean;
  capabilities: NativeExtensionCapabilityId[];
  authorityDigest: string;
}

const extensionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const entrypointPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u;
const capabilityOrder = new Map(
  nativeExtensionCapabilityIds.map((capability, index) => [capability, index] as const),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new Error(`Native extension manifest requires ${field}.`);
  }
  const normalized = value
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`Native extension manifest ${field} is empty or too long.`);
  }
  return normalized;
}

function parseCapability(value: unknown): NativeExtensionCapabilityDeclaration {
  if (typeof value === "string") {
    if (!nativeExtensionCapabilityIds.includes(value as NativeExtensionCapabilityId)) {
      throw new Error(`Native extension declares unknown capability ${value}.`);
    }
    return { id: value as NativeExtensionCapabilityId };
  }
  if (!isRecord(value) || typeof value.id !== "string") {
    throw new Error("Native extension capability declarations require an ID.");
  }
  if (!nativeExtensionCapabilityIds.includes(value.id as NativeExtensionCapabilityId)) {
    throw new Error(`Native extension declares unknown capability ${value.id}.`);
  }
  if (value.reason !== undefined && typeof value.reason !== "string") {
    throw new Error(`Native extension capability ${value.id} reason must be a string.`);
  }
  const reason =
    value.reason === undefined ? undefined : requiredString(value.reason, "reason", 1_000);
  return {
    id: value.id as NativeExtensionCapabilityId,
    ...(reason === undefined ? {} : { reason }),
  };
}

export function parseNativeExtensionManifest(value: unknown): NativeExtensionManifest {
  if (!isRecord(value)) {
    throw new Error("Native extension manifest must be an object.");
  }
  if (value.manifestVersion !== nativeExtensionManifestVersion) {
    throw new Error(
      `Unsupported native extension manifest version ${String(value.manifestVersion)}.`,
    );
  }
  if (value.apiVersion !== nativeExtensionApiVersion) {
    throw new Error(`Unsupported native extension API version ${String(value.apiVersion)}.`);
  }
  if (typeof value.portable !== "boolean" || typeof value.desktopOnly !== "boolean") {
    throw new Error("Native extension manifest requires portable and desktopOnly flags.");
  }
  if (value.portable === value.desktopOnly) {
    throw new Error("Native extension manifest must choose exactly one runtime target.");
  }
  const entrypoint = requiredString(value.entrypoint, "entrypoint", 256);
  if (!entrypointPattern.test(entrypoint) || entrypoint.includes("..")) {
    throw new Error("Native extension entrypoint must be a contained relative path.");
  }
  if (
    !Array.isArray(value.capabilities) ||
    value.capabilities.length > nativeExtensionCapabilityIds.length
  ) {
    throw new Error("Native extension capabilities must be a bounded array.");
  }
  const capabilities = value.capabilities.map(parseCapability).sort((left, right) => {
    return (capabilityOrder.get(left.id) ?? 0) - (capabilityOrder.get(right.id) ?? 0);
  });
  if (new Set(capabilities.map(({ id }) => id)).size !== capabilities.length) {
    throw new Error("Native extension capabilities must be unique.");
  }
  if (
    value.portable &&
    capabilities.some(
      ({ id }) => nativeExtensionCapabilityDefinitions[id].availability === "desktop-only",
    )
  ) {
    throw new Error("Portable native extensions cannot declare a desktop-only capability.");
  }
  return {
    manifestVersion: nativeExtensionManifestVersion,
    apiVersion: nativeExtensionApiVersion,
    id: parseNativeExtensionId(value.id),
    name: requiredString(value.name, "name", 200),
    version: requiredString(value.version, "version", 100),
    entrypoint,
    portable: value.portable,
    desktopOnly: value.desktopOnly,
    capabilities,
  };
}

export function parseNativeExtensionId(value: unknown): string {
  if (typeof value !== "string" || !extensionIdPattern.test(value)) {
    throw new Error("Native extension ID is invalid.");
  }
  return value;
}
