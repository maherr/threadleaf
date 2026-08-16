import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pluginCompatibilityRegistry } from "../generated/plugin-compatibility-registry";
import { isPathInside } from "../kernel/path-policy";
import {
  parsePluginPackageInspectionReceipt,
  verifyPluginPackageInspectionReceipt,
} from "../main/plugin-inspection-receipt";
import {
  defaultInspectionPlatform,
  exactInputFromDirectory,
  inspectionReceiptFromReport,
  inspectPluginPackage,
  type PluginPackageInspectionReport,
} from "../main/plugin-package-inspection";
import {
  type NativeExtensionCapabilityId,
  nativeExtensionCapabilityIds,
} from "../native-extension/manifest";
import type {
  PluginPackageInspectionProvenance,
  PluginPackageInspectionReceipt,
} from "../shared/plugin-packages";
import {
  type PluginCapabilityId,
  type PluginCapabilityReport,
  type PluginManifestData,
  parsePluginManifest,
  pluginCapabilityIds,
} from "../shared/plugins";

/** Bumped only when the porting report or scaffold contract changes meaning. */
export const extensionPortingSchemaVersion = 1 as const;
export const extensionPortingToolVersion = "1.0.0" as const;
export const measuredApiRegistryVersion = 1 as const;

const maxReportItems = 64;
const maxSourceIdentifierLength = 160;
const maxReportTextLength = 500;
const maxReceiptBytes = 256 * 1024;
const maxGeneratedFileBytes = 64 * 1024;
const supportedPackageEntries = new Set(["manifest.json", "main.js", "styles.css"]);

/**
 * Threadleaf's own running version, recorded on the report as inspection-run metadata only. This
 * is never compared against a plugin's declared `minAppVersion`, which names a minimum Obsidian
 * version: see the `PluginPackageInspectionOptions.appVersion` doc comment in
 * plugin-package-inspection.ts for why that comparison was removed there.
 */
const defaultPortingAppVersion = "0.1.0-beta.7";

export type PortingDiagnosticSeverity = "info" | "warning" | "error";

export interface PortingDiagnostic {
  code: string;
  severity: PortingDiagnosticSeverity;
  message: string;
  evidencePath: string;
}

export interface MeasuredApiMember {
  member: string;
  contract: string;
  tokens: readonly string[];
}

/**
 * This is intentionally a small registry. It is the public, executable slice documented in
 * open-plugin-api.md and the Phase 0 fixture contract, not a list of every Obsidian API name.
 */
export const measuredApiRegistry = {
  schemaVersion: measuredApiRegistryVersion,
  source: "docs/compatibility/open-plugin-api.md",
  members: [
    {
      member: "Plugin",
      contract: "docs/compatibility/contract.md#phase-0-fixture",
      tokens: ["Plugin"],
    },
    {
      member: "Notice",
      contract: "docs/compatibility/contract.md#phase-0-fixture",
      tokens: ["Notice"],
    },
    {
      member: "Plugin.addCommand",
      contract: "docs/compatibility/contract.md#phase-0-fixture",
      tokens: ["addCommand"],
    },
    {
      member: "Plugin.registerMarkdownPostProcessor",
      contract: "docs/compatibility/open-plugin-api.md#public-signatures",
      tokens: ["registerMarkdownPostProcessor"],
    },
    {
      member: "Plugin.registerMarkdownCodeBlockProcessor",
      contract: "docs/compatibility/open-plugin-api.md#public-signatures",
      tokens: ["registerMarkdownCodeBlockProcessor"],
    },
    {
      member: "MarkdownRenderChild",
      contract: "docs/compatibility/open-plugin-api.md#public-signatures",
      tokens: ["MarkdownRenderChild"],
    },
    {
      member: "MarkdownPostProcessorContext",
      contract: "docs/compatibility/open-plugin-api.md#public-signatures",
      tokens: ["MarkdownPostProcessorContext"],
    },
  ] satisfies readonly MeasuredApiMember[],
} as const;

type PortingApiStatus = "measured" | "unmeasured";

export interface PortingApiObservation {
  member: string;
  status: PortingApiStatus;
  contract: string | null;
  evidencePath: string;
}

export interface PortingApiDifference extends PortingDiagnostic {
  code: "unmeasured-api";
  member: string;
}

export interface PortingAuthorityMapping {
  sourceCapability: PluginCapabilityId;
  nativeCapability: NativeExtensionCapabilityId | null;
  availability: "portable" | "desktop-only" | "unmapped";
  boundary: "capability-governed" | "trusted-desktop-escape" | "unmapped";
  evidence: string[];
}

export interface PortingAuthorityDifference extends PortingDiagnostic {
  code: "unmapped-authority" | "desktop-authority";
  sourceCapability: PluginCapabilityId;
  nativeCapability: NativeExtensionCapabilityId | null;
}

export interface PortingCompatibilityEvidence {
  status: "verified" | "different-version" | "different-bundle" | "unverified";
  level: 0 | 1 | 2 | 3 | 4;
  testedVersion: string | null;
  testedThreadleafVersion: string | null;
  lastTested: string | null;
  evidenceMode: "direct" | "composed" | null;
  summary: string;
}

export interface PortingAssetEvidence {
  name: "manifest.json" | "main.js" | "styles.css";
  size: number;
  sha256: string;
}

export interface PortingPackageInspectionEvidence {
  schemaVersion: 1;
  overall: "pass" | "fail" | "blocked";
  provenance: PluginPackageInspectionProvenance;
  assets: PortingAssetEvidence[];
  entries: Array<{ path: string; kind: "file" | "directory" | "symlink" }>;
  unexpectedEntries: string[];
  platform: {
    appVersion: string;
    platform: string;
    workflowEvidence: Array<{
      id: string;
      status: "pass" | "fail" | "blocked" | "not-run";
      evidencePaths: string[];
    }>;
  };
  stages: Array<{
    id: string;
    status: "pass" | "fail" | "blocked" | "not-run";
    diagnostics: PortingDiagnostic[];
  }>;
  staticAuthority: PluginCapabilityReport | null;
  receipt: {
    status: "self-checked" | "verified" | "invalid" | "unavailable";
    source: "generated" | "provided" | "none";
    exactPackage: {
      id: string;
      version: string;
      bundleSha256: string;
      manifestSha256: string;
      stylesSha256: string | null;
      provenance: PluginPackageInspectionProvenance;
    } | null;
    compatibilityLevel: 0 | 1 | 2 | 3;
  };
  limitations: string[];
}

export interface PortingReport {
  schemaVersion: typeof extensionPortingSchemaVersion;
  tool: {
    id: "threadleaf-extension-porting";
    version: typeof extensionPortingToolVersion;
  };
  input: {
    kind: "unpacked-obsidian-plugin";
    manifest: {
      id: string;
      name: string;
      version: string;
      isDesktopOnly: boolean;
    } | null;
    provenance: PluginPackageInspectionProvenance;
    assets: PortingAssetEvidence[];
    packageEntryCount: number;
    contained: true;
  };
  packageInspection: PortingPackageInspectionEvidence;
  authorityReceipt: PluginPackageInspectionReceipt | null;
  compatibility: PortingCompatibilityEvidence;
  api: {
    registryVersion: typeof measuredApiRegistryVersion;
    source: string;
    observed: PortingApiObservation[];
    differences: PortingApiDifference[];
    notObserved: string[];
    limitations: string[];
  };
  authority: {
    registryVersion: 1;
    source: string;
    observed: PortingAuthorityMapping[];
    differences: PortingAuthorityDifference[];
    suggestedNativeRuntime: "portable" | "desktop-trusted";
    suggestedCapabilities: NativeExtensionCapabilityId[];
    limitations: string[];
  };
  ci: {
    commands: string[];
    variables: { pluginDirectory: "PLUGIN_DIR" };
    limitations: string[];
  };
  diagnostics: PortingDiagnostic[];
  limitations: string[];
}

export type PortingScaffoldKind = "native" | "compatibility";

export interface PortingInspectionOptions {
  /**
   * Receipt material is diagnostic input only. The public porting CLI never treats it as
   * authoritative, persisted, signed, or sufficient to raise compatibility.
   */
  receipt?: unknown;
  receiptPath?: string;
  appVersion?: string;
  platform?: string;
}

export interface PortingScaffoldOptions {
  /** Test-only failure injection. Production callers should leave this unset. */
  failureAfterFile?: number;
}

export interface PortingScaffoldResult {
  schemaVersion: typeof extensionPortingSchemaVersion;
  tool: {
    id: "threadleaf-extension-porting";
    version: typeof extensionPortingToolVersion;
  };
  kind: PortingScaffoldKind;
  files: string[];
  target: {
    id: string;
    version: string;
    runtime: "portable" | "desktop-trusted" | "trusted-compatibility";
    capabilities: NativeExtensionCapabilityId[];
  };
  commands: string[];
  limitations: string[];
}

export class ExtensionPortingError extends Error {
  constructor(
    readonly code: "input" | "containment" | "output",
    message: string,
  ) {
    super(message);
    this.name = "ExtensionPortingError";
  }
}

const authorityMapping: Readonly<
  Record<PluginCapabilityId, Omit<PortingAuthorityMapping, "sourceCapability" | "evidence">>
> = {
  "vault-read": {
    nativeCapability: "vault.read",
    availability: "portable",
    boundary: "capability-governed",
  },
  "vault-write": {
    nativeCapability: "vault.write",
    availability: "portable",
    boundary: "capability-governed",
  },
  network: {
    nativeCapability: "network",
    availability: "portable",
    boundary: "capability-governed",
  },
  filesystem: {
    nativeCapability: null,
    availability: "unmapped",
    boundary: "unmapped",
  },
  subprocess: {
    nativeCapability: "subprocess",
    availability: "desktop-only",
    boundary: "trusted-desktop-escape",
  },
  "host-environment": {
    nativeCapability: null,
    availability: "unmapped",
    boundary: "unmapped",
  },
  clipboard: {
    nativeCapability: "clipboard",
    availability: "portable",
    boundary: "capability-governed",
  },
  "external-navigation": {
    nativeCapability: "external-navigation",
    availability: "desktop-only",
    boundary: "trusted-desktop-escape",
  },
  "editor-extension": {
    nativeCapability: null,
    availability: "unmapped",
    boundary: "unmapped",
  },
  "workspace-ui": {
    nativeCapability: "workspace-ui",
    availability: "portable",
    boundary: "capability-governed",
  },
  "dynamic-code": {
    nativeCapability: "dynamic-code",
    availability: "desktop-only",
    boundary: "trusted-desktop-escape",
  },
};

const observedAppRoots = [
  "vault",
  "workspace",
  "metadataCache",
  "fileManager",
  "commands",
  "plugins",
  "setting",
  "keymap",
  "metadataTypeManager",
] as const;

const observedAppRootPattern = new RegExp(
  `\\b(?:app|this\\.app)\\.(${observedAppRoots.join("|")})(?:\\.[A-Za-z_$][\\w$]*)*`,
  "gu",
);

function diagnostic(
  code: string,
  severity: PortingDiagnosticSeverity,
  message: string,
  evidencePath: string,
): PortingDiagnostic {
  return { code, severity, message, evidencePath };
}

function boundedText(value: string, maxLength = maxReportTextLength): string {
  let result = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      result += " ";
    } else {
      result += character;
    }
    if (result.length >= maxLength) {
      break;
    }
  }
  return result.slice(0, maxLength);
}

function boundedIdentifier(value: string, maxLength = maxSourceIdentifierLength): string {
  return boundedText(value, maxLength).replace(/\s+/gu, " ").trim();
}

function uniqueSortedBounded(values: readonly string[], maxItems = maxReportItems): string[] {
  return [...new Set(values.map((value) => boundedIdentifier(value)).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, "en-US"))
    .slice(0, maxItems);
}

function boundedDiagnostic(item: {
  code: string;
  severity: PortingDiagnosticSeverity;
  message: string;
  evidencePath: string;
}): PortingDiagnostic {
  return {
    code: boundedIdentifier(item.code, 100),
    severity: item.severity,
    message: boundedText(item.message),
    evidencePath: boundedIdentifier(item.evidencePath, 200),
  };
}

function dedupeDiagnostics(values: readonly PortingDiagnostic[]): PortingDiagnostic[] {
  const seen = new Set<string>();
  return values
    .map(boundedDiagnostic)
    .filter((item) => {
      const key = `${item.severity}\u0000${item.code}\u0000${item.evidencePath}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort((left, right) =>
      `${left.evidencePath}\u0000${left.code}`.localeCompare(
        `${right.evidencePath}\u0000${right.code}`,
        "en-US",
      ),
    )
    .slice(0, maxReportItems);
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source.charCodeAt(index) === 10) {
      line += 1;
    }
  }
  return line;
}

function sourceEvidencePath(name: string, source: string, offset: number | null): string {
  return boundedIdentifier(offset === null ? name : `${name}:${lineAt(source, offset)}`, 200);
}

function normalizeApiMember(value: string): string {
  return boundedIdentifier(value.replace(/^this\.app\./u, "app."));
}

function scanMeasuredApis(source: string): {
  observed: PortingApiObservation[];
  differences: PortingApiDifference[];
} {
  const observed = new Map<string, PortingApiObservation>();
  const add = (
    member: string,
    status: PortingApiStatus,
    contract: string | null,
    offset: number,
  ): void => {
    const normalized = normalizeApiMember(member);
    if (!normalized || observed.size >= maxReportItems) {
      return;
    }
    const current = observed.get(normalized);
    const candidate: PortingApiObservation = {
      member: normalized,
      status,
      contract,
      evidencePath: sourceEvidencePath("main.js", source, offset),
    };
    if (!current || (current.status === "unmeasured" && status === "measured")) {
      observed.set(normalized, candidate);
    }
  };

  for (const entry of measuredApiRegistry.members) {
    for (const token of entry.tokens) {
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      const match = new RegExp(`\\b${escaped}\\b`, "u").exec(source);
      if (match?.index !== undefined) {
        add(entry.member, "measured", entry.contract, match.index);
      }
    }
  }

  observedAppRootPattern.lastIndex = 0;
  let scannedUnmeasured = 0;
  for (const match of source.matchAll(observedAppRootPattern)) {
    if (scannedUnmeasured >= maxReportItems) {
      break;
    }
    scannedUnmeasured += 1;
    const member = normalizeApiMember(match[0] ?? "");
    if (member) {
      add(member, "unmeasured", null, match.index ?? 0);
    }
  }

  const observations = [...observed.values()]
    .sort((left, right) => left.member.localeCompare(right.member, "en-US"))
    .slice(0, maxReportItems);
  const differences = observations
    .filter((entry): entry is PortingApiObservation & { status: "unmeasured" } => {
      return entry.status === "unmeasured";
    })
    .map((entry) => ({
      code: "unmeasured-api" as const,
      severity: "warning" as const,
      member: entry.member,
      message: "This API reference is outside Threadleaf's measured Obsidian API registry.",
      evidencePath: entry.evidencePath,
    }))
    .slice(0, maxReportItems);
  return { observed: observations, differences };
}

function compatibilityEvidence(
  manifest: PluginManifestData | null,
  mainSha256: string | null,
  receiptStatus: string,
  receipt: PluginPackageInspectionReceipt | null,
): PortingCompatibilityEvidence {
  if (!manifest) {
    return {
      status: "unverified",
      level: 0,
      testedVersion: null,
      testedThreadleafVersion: null,
      lastTested: null,
      evidenceMode: null,
      summary: "Manifest evidence is unavailable; no compatibility level is inferred.",
    };
  }
  const entries = pluginCompatibilityRegistry.entries.filter(
    (entry) => entry.plugin.id === manifest.id,
  );
  const exact = entries.find(
    (entry) =>
      entry.plugin.version === manifest.version &&
      mainSha256 !== null &&
      entry.plugin.bundleSha256 === mainSha256,
  );
  const sameVersion = entries.find((entry) => entry.plugin.version === manifest.version);
  const reference = exact ?? entries.at(-1);
  if (exact && receiptStatus === "verified" && receipt?.overall === "pass" && mainSha256 !== null) {
    return {
      status: "verified",
      level: exact.compatibilityLevel,
      testedVersion: exact.plugin.version,
      testedThreadleafVersion: exact.threadleafVersion,
      lastTested: exact.lastTested,
      evidenceMode: exact.evidenceMode,
      summary: exact.summary,
    };
  }
  if (exact) {
    return {
      status: "unverified",
      level: 0,
      testedVersion: exact.plugin.version,
      testedThreadleafVersion: exact.threadleafVersion,
      lastTested: exact.lastTested,
      evidenceMode: exact.evidenceMode,
      summary:
        "The bundle matches a measured workflow, but no verified receipt binds its manifest, stylesheet, provenance, and package entries.",
    };
  }
  if (sameVersion) {
    return {
      status: "different-bundle",
      level: 0,
      testedVersion: sameVersion.plugin.version,
      testedThreadleafVersion: sameVersion.threadleafVersion,
      lastTested: sameVersion.lastTested,
      evidenceMode: sameVersion.evidenceMode,
      summary:
        "The plugin ID and version are known, but the exact bundle digest differs; evidence remains unverified.",
    };
  }
  if (reference) {
    return {
      status: "different-version",
      level: 0,
      testedVersion: reference.plugin.version,
      testedThreadleafVersion: reference.threadleafVersion,
      lastTested: reference.lastTested,
      evidenceMode: reference.evidenceMode,
      summary: `Evidence exists for plugin ${reference.plugin.version}; installed version ${manifest.version} remains unverified.`,
    };
  }
  return {
    status: "unverified",
    level: 0,
    testedVersion: null,
    testedThreadleafVersion: null,
    lastTested: null,
    evidenceMode: null,
    summary: "No production-path workflow is verified for this exact plugin version.",
  };
}

function authorityReport(
  staticAuthority: PluginCapabilityReport | null,
): PortingReport["authority"] {
  const observed = (staticAuthority?.findings ?? [])
    .map((finding) => {
      const mapping = authorityMapping[finding.capability];
      return {
        sourceCapability: finding.capability,
        nativeCapability: mapping.nativeCapability,
        availability: mapping.availability,
        boundary: mapping.boundary,
        evidence: uniqueSortedBounded(finding.evidence, 16),
      } satisfies PortingAuthorityMapping;
    })
    .sort((left, right) => {
      return (
        pluginCapabilityIds.indexOf(left.sourceCapability) -
        pluginCapabilityIds.indexOf(right.sourceCapability)
      );
    });
  const differences: PortingAuthorityDifference[] = [];
  for (const entry of observed) {
    if (entry.availability === "unmapped") {
      differences.push({
        code: "unmapped-authority",
        severity: "error",
        sourceCapability: entry.sourceCapability,
        nativeCapability: null,
        message: "No native Threadleaf capability represents this observed authority.",
        evidencePath: "analysis/static-authority.json",
      });
      continue;
    }
    if (entry.availability === "desktop-only") {
      differences.push({
        code: "desktop-authority",
        severity: "warning",
        sourceCapability: entry.sourceCapability,
        nativeCapability: entry.nativeCapability,
        message:
          "The closest native capability is a trusted desktop escape, not portable authority.",
        evidencePath: "analysis/static-authority.json",
      });
    }
  }
  const suggestedCapabilities = nativeExtensionCapabilityIds.filter((id) =>
    observed.some((entry) => entry.nativeCapability === id),
  );
  const suggestedNativeRuntime = observed.some((entry) => entry.availability === "desktop-only")
    ? "desktop-trusted"
    : "portable";
  return {
    registryVersion: 1,
    source: "src/shared/plugins.ts#pluginCapabilityIds",
    observed,
    differences,
    suggestedNativeRuntime,
    suggestedCapabilities,
    limitations: [
      "Static authority classes are conservative observations, not a sandbox or proof of safety.",
      "An unmapped source capability needs an independently authored native design or remains in the trusted compatibility host.",
    ],
  };
}

function ciCommands(): PortingReport["ci"] {
  return {
    commands: [
      'pnpm cli port inspect "$PLUGIN_DIR" --json',
      'pnpm cli port ci "$PLUGIN_DIR" --json',
      "pnpm exec vitest run src/extension-porting/porting-toolkit.test.ts",
      "pnpm run test:extension-porting-contract",
      "pnpm run typecheck",
      "pnpm check",
    ],
    variables: { pluginDirectory: "PLUGIN_DIR" },
    limitations: [
      "These commands inspect exact local bytes and run Threadleaf's offline gates; they do not execute the inspected plugin.",
      "A compatibility fixture needs a named workflow test before any compatibility level above discovery is claimed.",
    ],
  };
}

function uniqueSorted(values: readonly string[]): string[] {
  return uniqueSortedBounded(values);
}

function uniqueSortedText(
  values: readonly unknown[],
  maxLength: number,
  maxItems = maxReportItems,
): string[] {
  return [
    ...new Set(
      values
        .slice(0, maxItems)
        .filter((value): value is string => typeof value === "string")
        .map((value) => boundedIdentifier(value, maxLength))
        .filter(Boolean),
    ),
  ]
    .sort((left, right) => left.localeCompare(right, "en-US"))
    .slice(0, maxItems);
}

const provenanceTokenPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/u;
const provenancePluginIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const invalidReceiptDigest = "0".repeat(64);

function safeProvenanceToken(
  value: unknown,
  fallback: string,
  pattern = provenanceTokenPattern,
): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const token = boundedIdentifier(value, 100);
  return pattern.test(token) ? token : fallback;
}

function safeProvenanceUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const candidate = boundedText(value, 500).trim();
  if (
    candidate.length === 0 ||
    /[<>]/u.test(candidate) ||
    /(?:javascript|data|file|vbscript|about|blob):/iu.test(candidate) ||
    /(?:^|[\s"'])on[a-z]+\s*=/iu.test(candidate) ||
    /^(?:[\\/]|[A-Za-z]:[\\/]|\\\\)/u.test(candidate)
  ) {
    return null;
  }
  try {
    const url = new URL(candidate);
    if (!["https:", "http:", "fixture:"].includes(url.protocol)) {
      return null;
    }
    if (url.protocol === "fixture:") {
      return `fixture://${url.hostname || "package"}`;
    }
    return `${url.protocol}//${url.host}${url.pathname}`.slice(0, 500);
  } catch {
    return null;
  }
}

function safeProvenance(
  value: PluginPackageInspectionProvenance,
): PluginPackageInspectionProvenance {
  const kind = ["fixture", "local", "release"].includes(value.kind) ? value.kind : "local";
  return {
    kind,
    pluginId: safeProvenanceToken(value.pluginId, "<redacted>", provenancePluginIdPattern),
    version: safeProvenanceToken(value.version, "<redacted>"),
    releaseTag: safeProvenanceToken(value.releaseTag, "<redacted>"),
    sourceUrl: safeProvenanceUrl(value.sourceUrl),
    releaseUrl: safeProvenanceUrl(value.releaseUrl),
    indexUrl: safeProvenanceUrl(value.indexUrl),
    indexSha256:
      typeof value.indexSha256 === "string" && sha256Pattern.test(value.indexSha256)
        ? value.indexSha256
        : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeReceiptHash(value: unknown): string {
  return typeof value === "string" && sha256Pattern.test(value) ? value : invalidReceiptDigest;
}

function safeReceiptVersion(value: unknown): string {
  return safeProvenanceToken(value, "<redacted>");
}

function normalizeReceiptProvenance(
  value: unknown,
  packageId: string,
  packageVersion: string,
): PluginPackageInspectionProvenance {
  const raw = isRecord(value) ? value : {};
  return {
    kind: ["fixture", "local", "release"].includes(raw.kind as string)
      ? (raw.kind as PluginPackageInspectionProvenance["kind"])
      : "local",
    pluginId: safeProvenanceToken(raw.pluginId, packageId, provenancePluginIdPattern),
    version: safeReceiptVersion(raw.version ?? packageVersion),
    releaseTag: safeReceiptVersion(raw.releaseTag ?? packageVersion),
    sourceUrl: safeProvenanceUrl(raw.sourceUrl),
    releaseUrl: safeProvenanceUrl(raw.releaseUrl),
    indexUrl: safeProvenanceUrl(raw.indexUrl),
    indexSha256:
      safeReceiptHash(raw.indexSha256) === invalidReceiptDigest
        ? null
        : safeReceiptHash(raw.indexSha256),
  };
}

function normalizeReceiptAssets(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  const allowed = new Set(["manifest.json", "main.js", "styles.css"]);
  const seen = new Set<string>();
  const assets: Array<Record<string, unknown>> = [];
  for (const raw of value.slice(0, maxReportItems)) {
    if (!isRecord(raw) || typeof raw.filename !== "string" || !allowed.has(raw.filename)) {
      continue;
    }
    if (seen.has(raw.filename)) {
      continue;
    }
    seen.add(raw.filename);
    assets.push({
      filename: raw.filename,
      size: Number.isSafeInteger(raw.size) && (raw.size as number) >= 0 ? raw.size : 0,
      sha256: safeReceiptHash(raw.sha256),
    });
  }
  return assets;
}

function normalizeReceiptStaticAuthority(value: unknown): Record<string, unknown> {
  const raw = isRecord(value) ? value : {};
  const capabilities = uniqueSortedText((raw.capabilities as unknown[] | undefined) ?? [], 100)
    .filter((value): value is PluginCapabilityId =>
      pluginCapabilityIds.includes(value as PluginCapabilityId),
    )
    .slice(0, maxReportItems);
  const findingsByCapability = new Map<string, Record<string, unknown>>();
  if (Array.isArray(raw.findings)) {
    for (const finding of raw.findings.slice(0, maxReportItems)) {
      if (!isRecord(finding) || typeof finding.capability !== "string") {
        continue;
      }
      const capability = finding.capability;
      if (
        !pluginCapabilityIds.includes(capability as PluginCapabilityId) ||
        findingsByCapability.has(capability)
      ) {
        continue;
      }
      findingsByCapability.set(capability, {
        capability,
        evidence: uniqueSortedText(
          Array.isArray(finding.evidence) ? finding.evidence : [],
          maxReportTextLength,
        ),
      });
    }
  }
  return {
    scannerVersion: raw.scannerVersion,
    bundleSha256: safeReceiptHash(raw.bundleSha256),
    capabilities,
    findings: [...findingsByCapability.values()].sort((left, right) =>
      String(left.capability).localeCompare(String(right.capability), "en-US"),
    ),
    staticOnly: raw.staticOnly,
  };
}

/** Normalize untrusted receipt material before the canonical parser sees it. */
function normalizeReceiptCandidate(value: unknown): unknown {
  if (!isRecord(value)) {
    return null;
  }
  const rawExact = isRecord(value.exactPackage) ? value.exactPackage : {};
  const rawTool = isRecord(value.tool) ? value.tool : {};
  const packageId = safeProvenanceToken(rawExact.id, "<redacted>", provenancePluginIdPattern);
  const packageVersion = safeReceiptVersion(rawExact.version);
  return {
    schemaVersion: value.schemaVersion,
    tool: {
      id: typeof rawTool.id === "string" ? boundedIdentifier(rawTool.id, 100) : "<redacted>",
      version: safeReceiptVersion(rawTool.version),
    },
    overall: value.overall,
    exactPackage: {
      id: packageId,
      version: packageVersion,
      bundleSha256: safeReceiptHash(rawExact.bundleSha256),
      manifestSha256: safeReceiptHash(rawExact.manifestSha256),
      stylesSha256: rawExact.stylesSha256 === null ? null : safeReceiptHash(rawExact.stylesSha256),
      provenance: normalizeReceiptProvenance(rawExact.provenance, packageId, packageVersion),
    },
    assets: normalizeReceiptAssets(value.assets),
    staticAuthority: normalizeReceiptStaticAuthority(value.staticAuthority),
    compatibilityLevel: value.compatibilityLevel,
    limitations: uniqueSortedText(Array.isArray(value.limitations) ? value.limitations : [], 1_000),
  };
}

async function readReceiptValue(
  options: PortingInspectionOptions,
): Promise<{ value: unknown | undefined; error: string | null; supplied: boolean }> {
  if (options.receipt !== undefined) {
    return { value: options.receipt, error: null, supplied: true };
  }
  if (!options.receiptPath) {
    return { value: undefined, error: null, supplied: false };
  }
  try {
    const stat = await fs.stat(options.receiptPath);
    if (!stat.isFile() || stat.size > maxReceiptBytes) {
      return {
        value: undefined,
        error: "The supplied inspection receipt is not a bounded file.",
        supplied: true,
      };
    }
    return {
      value: normalizeReceiptCandidate(JSON.parse(await fs.readFile(options.receiptPath, "utf8"))),
      error: null,
      supplied: true,
    };
  } catch {
    return {
      value: undefined,
      error: "The supplied inspection receipt could not be read.",
      supplied: true,
    };
  }
}

function stageEvidence(
  report: PluginPackageInspectionReport,
): PortingPackageInspectionEvidence["stages"] {
  return report.stages.map((stage) => ({
    id: boundedIdentifier(stage.id, 100),
    status: stage.status,
    diagnostics: stage.status === "blocked" ? [] : dedupeDiagnostics(stage.diagnostics),
  }));
}

function receiptEvidence(
  status: PortingPackageInspectionEvidence["receipt"]["status"],
  source: PortingPackageInspectionEvidence["receipt"]["source"],
  receipt: PluginPackageInspectionReceipt | null,
): PortingPackageInspectionEvidence["receipt"] {
  return {
    status,
    source,
    exactPackage: receipt
      ? {
          id: boundedIdentifier(receipt.exactPackage.id, 100),
          version: boundedIdentifier(receipt.exactPackage.version, 100),
          bundleSha256: receipt.exactPackage.bundleSha256,
          manifestSha256: receipt.exactPackage.manifestSha256,
          stylesSha256: receipt.exactPackage.stylesSha256,
          provenance: safeProvenance(receipt.exactPackage.provenance),
        }
      : null,
    compatibilityLevel: receipt?.compatibilityLevel ?? 0,
  };
}

function packageShapeIsExact(input: Awaited<ReturnType<typeof exactInputFromDirectory>>): boolean {
  const entries = input.entries ?? [];
  const expected = input.assets.styles
    ? new Set(["manifest.json", "main.js", "styles.css"])
    : new Set(["manifest.json", "main.js"]);
  return (
    entries.length === expected.size &&
    entries.every((entry) => entry.kind === "file" && expected.has(entry.path))
  );
}

function packageInspectionEvidence(
  report: PluginPackageInspectionReport,
  input: Awaited<ReturnType<typeof exactInputFromDirectory>>,
  receipt: PortingPackageInspectionEvidence["receipt"],
  appVersion: string,
  platform: string,
): PortingPackageInspectionEvidence {
  const entries = [...(input.entries ?? [])]
    .map((entry) => ({
      path: boundedIdentifier(entry.path, 200),
      kind: entry.kind,
    }))
    .filter(
      (entry, index, values) =>
        values.findIndex(
          (candidate) =>
            `${candidate.path}\u0000${candidate.kind}` === `${entry.path}\u0000${entry.kind}`,
        ) === index,
    )
    .sort((left, right) =>
      `${left.path}\u0000${left.kind}`.localeCompare(`${right.path}\u0000${right.kind}`, "en-US"),
    )
    .slice(0, maxReportItems);
  const unexpectedEntries = uniqueSortedBounded(
    (input.entries ?? [])
      .filter((entry) => entry.kind !== "file" || !supportedPackageEntries.has(entry.path))
      .map((entry) => entry.path),
  );
  const assets = report.input.assets.map((asset) => ({
    name: asset.filename,
    size: asset.size,
    sha256: asset.sha256,
  }));
  const workflowStageIds = new Set(["activation", "registration-snapshot", "cleanup", "timeout"]);
  const workflowEvidence = report.stages
    .filter((stage) => workflowStageIds.has(stage.id))
    .map((stage) => ({
      id: stage.id,
      status: stage.status,
      evidencePaths: uniqueSortedBounded(stage.evidencePaths, 16),
    }));
  return {
    schemaVersion: 1,
    overall: report.overall,
    provenance: safeProvenance(report.input.provenance),
    assets,
    entries,
    unexpectedEntries,
    platform: {
      appVersion: boundedIdentifier(appVersion, 100),
      platform: boundedIdentifier(platform, 100),
      workflowEvidence,
    },
    stages: stageEvidence(report),
    staticAuthority: report.staticAuthority,
    receipt,
    limitations: uniqueSortedBounded([
      ...report.limitations,
      "Port inspection selects static-only canonical inspection; activation and workflow execution are not run.",
    ]),
  };
}

/** Inspect an unpacked plugin directory without importing or executing any input code. */
export async function inspectUnpackedPlugin(
  directoryPath: string,
  configuredOptions: PortingInspectionOptions = {},
): Promise<PortingReport> {
  const suppliedReceipt = await readReceiptValue(configuredOptions);
  let parsedReceipt: PluginPackageInspectionReceipt | null = null;
  let receiptError = suppliedReceipt.error;
  if (suppliedReceipt.value !== undefined && receiptError === null) {
    try {
      parsedReceipt = parsePluginPackageInspectionReceipt(
        normalizeReceiptCandidate(suppliedReceipt.value),
      );
    } catch {
      receiptError = "The supplied inspection receipt is malformed or uses an unsupported schema.";
    }
  }
  // Receipt identity may constrain diagnostics, but sanitized caller material never grants
  // authority and never becomes report provenance verbatim.
  const provenance = parsedReceipt
    ? {
        ...safeProvenance(parsedReceipt.exactPackage.provenance),
        // Caller provenance is never carried into the report; only sanitized identity is used
        // to produce exact-package mismatch diagnostics.
        sourceUrl: null,
        releaseUrl: null,
        indexUrl: null,
        indexSha256: null,
      }
    : {
        kind: "local" as const,
        sourceUrl: null,
        releaseUrl: null,
        indexUrl: null,
        indexSha256: null,
      };
  let packageInput: Awaited<ReturnType<typeof exactInputFromDirectory>>;
  try {
    packageInput = await exactInputFromDirectory(directoryPath, provenance);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Plugin package input is unavailable.";
    const code = /escapes|contained regular|symbolic link|root/iu.test(message)
      ? "containment"
      : "input";
    throw new ExtensionPortingError(code, boundedText(message));
  }
  const appVersion = configuredOptions.appVersion ?? defaultPortingAppVersion;
  const platform = configuredOptions.platform ?? defaultInspectionPlatform;
  const canonical = await inspectPluginPackage(packageInput, {
    appVersion,
    platform,
    networkMode: "denied",
    runActivation: false,
    evidenceRoot: "extension-porting",
  });
  let source: string | null = null;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(packageInput.assets.main);
  } catch {
    // The canonical package report owns the bounded UTF-8 diagnostic.
  }
  const apiResult = source
    ? scanMeasuredApis(source)
    : { observed: [], differences: [] as PortingApiDifference[] };
  const authority = authorityReport(canonical.staticAuthority);
  let manifestForVerification: PluginManifestData | null = null;
  if (canonical.manifest) {
    try {
      manifestForVerification = parsePluginManifest(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(packageInput.assets.manifest)),
      );
    } catch {
      manifestForVerification = {
        id: canonical.manifest.id,
        name: canonical.manifest.id,
        version: canonical.manifest.version,
        minAppVersion: canonical.manifest.minAppVersion,
        description: null,
        author: null,
        authorUrl: null,
        isDesktopOnly: canonical.manifest.isDesktopOnly,
      };
    }
  }
  let receiptStatus: PortingPackageInspectionEvidence["receipt"]["status"] = "unavailable";
  let receiptSource: PortingPackageInspectionEvidence["receipt"]["source"] = "none";
  let verifiedReceipt: PluginPackageInspectionReceipt | null = null;
  if (suppliedReceipt.supplied) {
    if (parsedReceipt && manifestForVerification) {
      const verification = packageShapeIsExact(packageInput)
        ? verifyPluginPackageInspectionReceipt(
            parsedReceipt,
            manifestForVerification.id,
            manifestForVerification,
            {
              manifest: packageInput.assets.manifest,
              main: packageInput.assets.main,
              styles: packageInput.assets.styles ?? null,
            },
          )
        : {
            receipt: null,
            error: "The supplied inspection receipt does not bind the exact package entries.",
          };
      receiptError = verification.error
        ? "The supplied inspection receipt does not bind the exact package bytes."
        : parsedReceipt.overall !== "pass"
          ? "The supplied inspection receipt is blocked or failed; only an authoritative persisted and signed full-inspection pass may be accepted."
          : "The supplied inspection receipt is untrusted; only an authoritative persisted and signed full-inspection pass may be accepted.";
    } else {
      receiptError ??=
        "The supplied inspection receipt could not be verified against the exact package.";
    }
    receiptStatus = "invalid";
    receiptSource = "provided";
  } else if (receiptError !== null) {
    receiptError ??=
      "The supplied inspection receipt could not be verified against the exact package.";
    receiptStatus = "invalid";
  } else if (canonical.staticAuthority && canonical.manifest && manifestForVerification) {
    try {
      const generated = parsePluginPackageInspectionReceipt(
        normalizeReceiptCandidate(inspectionReceiptFromReport(canonical)),
      );
      const verification = packageShapeIsExact(packageInput)
        ? verifyPluginPackageInspectionReceipt(
            generated,
            canonical.manifest.id,
            manifestForVerification,
            {
              manifest: packageInput.assets.manifest,
              main: packageInput.assets.main,
              styles: packageInput.assets.styles ?? null,
            },
          )
        : {
            receipt: null,
            error: "The generated inspection receipt does not bind the exact package entries.",
          };
      if (!verification.error) {
        verifiedReceipt = generated;
        receiptStatus = "self-checked";
        receiptSource = "generated";
      } else {
        receiptError = "The generated inspection receipt did not bind the exact package bytes.";
        receiptStatus = "invalid";
      }
    } catch {
      receiptStatus = "unavailable";
    }
  }
  const receipt = receiptEvidence(receiptStatus, receiptSource, verifiedReceipt);
  const assets = canonical.input.assets.map((asset) => ({
    name: asset.filename,
    size: asset.size,
    sha256: asset.sha256,
  }));
  const packageEvidence = packageInspectionEvidence(
    canonical,
    packageInput,
    receipt,
    appVersion,
    platform,
  );
  const canonicalDiagnostics = canonical.stages.flatMap((stage) =>
    stage.status === "blocked" ? [] : stage.diagnostics.map((item) => boundedDiagnostic(item)),
  );
  const receiptDiagnostics = receiptError
    ? [
        diagnostic(
          "inspection-receipt-invalid",
          "error",
          receiptError,
          "input/inspection-receipt.json",
        ),
      ]
    : [];
  const diagnostics = dedupeDiagnostics([
    ...canonicalDiagnostics,
    ...receiptDiagnostics,
    ...apiResult.differences,
    ...authority.differences,
  ]);
  const notObserved = measuredApiRegistry.members
    .map(({ member }) => member)
    .filter((member) => !apiResult.observed.some((entry) => entry.member === member));
  const inputManifest = canonical.manifest
    ? {
        id: canonical.manifest.id,
        name: boundedIdentifier(manifestForVerification?.name ?? canonical.manifest.id, 200),
        version: canonical.manifest.version,
        isDesktopOnly: canonical.manifest.isDesktopOnly,
      }
    : null;
  const safeInputProvenance = safeProvenance(canonical.input.provenance);
  const limitations = uniqueSorted([
    "Inspection is read-only and never imports, evaluates, or activates the inspected bundle.",
    "Static API, authority, and package-inspection reports are review evidence, not a security sandbox or universal compatibility claim.",
    "A compatibility level is inherited only when measured workflow evidence and a verified receipt bind the exact package.",
    ...authority.limitations,
    ...apiResult.differences.map((difference) => `Unmeasured API reference: ${difference.member}.`),
    ...packageEvidence.limitations,
  ]);
  return {
    schemaVersion: extensionPortingSchemaVersion,
    tool: { id: "threadleaf-extension-porting", version: extensionPortingToolVersion },
    input: {
      kind: "unpacked-obsidian-plugin",
      manifest: inputManifest,
      provenance: safeInputProvenance,
      assets,
      packageEntryCount: packageInput.entries?.length ?? 0,
      contained: true,
    },
    packageInspection: packageEvidence,
    authorityReceipt: receiptStatus === "self-checked" ? verifiedReceipt : null,
    compatibility: compatibilityEvidence(
      manifestForVerification,
      packageInput.hashes.mainSha256,
      receiptStatus,
      verifiedReceipt,
    ),
    api: {
      registryVersion: measuredApiRegistryVersion,
      source: measuredApiRegistry.source,
      observed: apiResult.observed,
      differences: apiResult.differences,
      notObserved,
      limitations: [
        "API detection is lexical and conservative; comments, generated code, and dynamic property selection are not resolved.",
        "An unmeasured reference is a review difference, not proof that the corresponding API is absent.",
      ],
    },
    authority,
    ci: ciCommands(),
    diagnostics,
    limitations,
  };
}

function safeIdentifier(value: string | null, suffix: string): string {
  const base = boundedIdentifier(value ?? "plugin", 100)
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^[.-]+/u, "");
  const prefix = base || "plugin";
  return `${prefix.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
}

interface SafeOutputLocation {
  target: string;
  existed: boolean;
}

async function safeOutputLocation(
  outputPath: string,
  sourceDirectory: string,
): Promise<SafeOutputLocation> {
  const sourceRoot = await fs.realpath(path.resolve(sourceDirectory));
  const target = path.resolve(outputPath);
  if (isPathInside(sourceRoot, target) || isPathInside(target, sourceRoot)) {
    throw new ExtensionPortingError(
      "containment",
      "Scaffold output must not overlap the inspected plugin directory.",
    );
  }
  let current = target;
  while (true) {
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new ExtensionPortingError(
          "containment",
          "Scaffold output may not traverse a symbolic link.",
        );
      }
      break;
    } catch (error) {
      if (error instanceof ExtensionPortingError) {
        throw error;
      }
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw new ExtensionPortingError("output", "Scaffold output cannot be inspected.");
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw new ExtensionPortingError("output", "Scaffold output cannot be inspected.");
      }
      current = parent;
    }
  }
  let existed = false;
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ExtensionPortingError("output", "Scaffold output must be a new directory.");
    }
    if ((await fs.readdir(target)).length > 0) {
      throw new ExtensionPortingError("output", "Scaffold output directory must be empty.");
    }
    existed = true;
  } catch (error) {
    if (error instanceof ExtensionPortingError) {
      throw error;
    }
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw new ExtensionPortingError("output", "Scaffold output cannot be inspected.");
    }
    try {
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
    } catch {
      throw new ExtensionPortingError("output", "Scaffold output parent could not be created.");
    }
  }
  return { target, existed };
}

function nativeManifestFor(report: PortingReport): {
  id: string;
  manifest: Record<string, unknown>;
  runtime: "portable" | "desktop-trusted";
  capabilities: NativeExtensionCapabilityId[];
} {
  const capabilities = [...report.authority.suggestedCapabilities];
  const runtime = report.authority.suggestedNativeRuntime;
  const id = safeIdentifier(report.input.manifest?.id ?? null, "-threadleaf-native");
  return {
    id,
    runtime,
    capabilities,
    manifest: {
      manifestVersion: 1,
      apiVersion: "1.0",
      id,
      name: "Threadleaf native extension scaffold",
      version: "0.1.0",
      entrypoint: "src/index.ts",
      portable: runtime === "portable",
      desktopOnly: runtime === "desktop-trusted",
      capabilities: capabilities.map((capability) => ({
        id: capability,
        reason: `Review the source ${boundedIdentifier(report.authority.observed.find((entry) => entry.nativeCapability === capability)?.sourceCapability ?? "authority", 100)} mapping before implementation.`,
      })),
    },
  };
}

function nativeSource(
  manifest: Record<string, unknown>,
  runtime: "portable" | "desktop-trusted",
): string {
  const factory = runtime === "portable" ? "definePortableExtension" : "defineNativeExtension";
  return [
    `import { ${factory}, type NativeExtensionManifest } from "threadleaf/native-extension/sdk";`,
    "",
    `const manifest: NativeExtensionManifest = ${JSON.stringify(manifest, null, 2)};`,
    "",
    `export default ${factory}({`,
    "  manifest,",
    '  bundleBytes: new TextEncoder().encode("threadleaf-native-extension-scaffold-v1"),',
    "  entrypoint: async (_context, _input: unknown) => ({",
    '    status: "not-implemented",',
    '    message: "Replace this independently authored entrypoint and add a named workflow fixture.",',
    "  }),",
    "});",
    "",
  ].join("\n");
}

function compatibilityManifestFor(report: PortingReport): {
  id: string;
  manifest: Record<string, unknown>;
} {
  const id = safeIdentifier(report.input.manifest?.id ?? null, "-threadleaf-fixture");
  return {
    id,
    manifest: {
      id,
      name: "Threadleaf compatibility fixture",
      version: "0.1.0",
      description: "Independently authored fixture for a named Threadleaf compatibility workflow.",
      isDesktopOnly: true,
    },
  };
}

function compatibilitySource(): string {
  return [
    'const { Notice, Plugin } = require("obsidian");',
    "",
    "module.exports = class ThreadleafPortFixture extends Plugin {",
    "  onload() {",
    "    this.addCommand({",
    '      id: "porting-fixture-smoke",',
    '      name: "Porting fixture smoke",',
    '      callback: () => new Notice("Porting fixture command ran"),',
    "    });",
    "  }",
    "};",
    "",
  ].join("\n");
}

function scaffoldReadme(report: PortingReport, kind: PortingScaffoldKind): string {
  const target =
    kind === "native" ? "native Threadleaf extension" : "trusted compatibility fixture";
  const observedApis =
    report.api.observed.length > 0
      ? report.api.observed
          .slice(0, maxReportItems)
          .map((entry) => `- \`${boundedIdentifier(entry.member)}\` (${entry.status})`)
          .join("\n")
      : "- (none observed)";
  const authority =
    report.authority.observed.length > 0
      ? report.authority.observed
          .slice(0, maxReportItems)
          .map(
            (entry) =>
              `- \`${boundedIdentifier(entry.sourceCapability, 100)}\` -> ${boundedIdentifier(entry.nativeCapability ?? "unmapped", 100)}`,
          )
          .join("\n")
      : "- (none observed)";
  return [
    "# Threadleaf porting scaffold",
    "",
    `This is an independently authored ${target}. It intentionally does not contain source code,`,
    "assets, or runtime output copied from the inspected plugin. Replace the template with a named,",
    "reproducible workflow before making a compatibility claim.",
    "",
    "## Static review snapshot",
    "",
    "Observed API references:",
    observedApis,
    "",
    "Observed authority classes:",
    authority,
    "",
    "The source report was static and exact-byte bound. An unmeasured API is a review difference, not",
    "proof that the API is absent. Native capability declarations are suggestions for review, not an",
    "automatic grant.",
    "",
    "## Conformance",
    "",
    '`pnpm cli port ci "$PLUGIN_DIR" --json`',
    '`pnpm cli port inspect "$PLUGIN_DIR" --json`',
    "`pnpm run test:extension-porting-contract`",
    "`pnpm run typecheck`",
    "`pnpm check`",
    "",
    "Add a fixture that exercises the named user workflow through the production path. Do not run",
    "untrusted plugin code during static inspection.",
    "",
  ].join("\n");
}

function planJson(report: PortingReport, kind: PortingScaffoldKind): string {
  const plan = {
    schemaVersion: extensionPortingSchemaVersion,
    kind,
    sourceBinding: {
      manifest: report.input.manifest,
      provenance: report.input.provenance,
      assets: report.input.assets,
      packageEntries: report.packageInspection.entries,
      unexpectedEntries: report.packageInspection.unexpectedEntries,
      receipt: report.packageInspection.receipt,
      platform: report.packageInspection.platform,
    },
    api: {
      registryVersion: report.api.registryVersion,
      observed: report.api.observed.slice(0, maxReportItems).map((entry) => ({
        member: boundedIdentifier(entry.member),
        status: entry.status,
      })),
      differences: report.api.differences.slice(0, maxReportItems).map((entry) => ({
        member: boundedIdentifier(entry.member),
        code: entry.code,
      })),
    },
    authority: {
      suggestedNativeRuntime: report.authority.suggestedNativeRuntime,
      suggestedCapabilities: report.authority.suggestedCapabilities,
      observed: report.authority.observed.slice(0, maxReportItems).map((entry) => ({
        sourceCapability: entry.sourceCapability,
        nativeCapability: entry.nativeCapability,
        availability: entry.availability,
      })),
    },
    ci: { commands: report.ci.commands, variables: report.ci.variables },
    limitations: uniqueSortedBounded(report.limitations),
  };
  return `${JSON.stringify(plan, null, 2)}\n`;
}

function nativeTestSource(): string {
  return [
    'import { readFile } from "node:fs/promises";',
    'import path from "node:path";',
    'import { describe, expect, it } from "vitest";',
    'import { parseNativeExtensionManifest } from "threadleaf/native-extension";',
    "",
    'describe("native extension scaffold", () => {',
    '  it("keeps its manifest inside the versioned native contract", async () => {',
    '    const bytes = await readFile(path.join(import.meta.dirname, "..", "manifest.json"), "utf8");',
    "    expect(parseNativeExtensionManifest(JSON.parse(bytes)).manifestVersion).toBe(1);",
    "  });",
    "});",
    "",
  ].join("\n");
}

function compatibilityTestSource(): string {
  return [
    'import { readFile } from "node:fs/promises";',
    'import path from "node:path";',
    'import { describe, expect, it } from "vitest";',
    "",
    'describe("compatibility fixture scaffold", () => {',
    '  it("contains only an independently authored CommonJS fixture", async () => {',
    '    const source = await readFile(path.join(import.meta.dirname, "..", "main.js"), "utf8");',
    "    expect(source).toContain('require(\"obsidian\")');",
    '    expect(source).toContain("porting-fixture-smoke");',
    "  });",
    "});",
    "",
  ].join("\n");
}

async function writeText(
  rootPath: string,
  relativePath: string,
  content: string,
  state: { written: number },
  options: PortingScaffoldOptions,
): Promise<void> {
  if (content.length > maxGeneratedFileBytes) {
    throw new ExtensionPortingError(
      "output",
      "Generated scaffold content exceeds its bounded limit.",
    );
  }
  const target = path.resolve(rootPath, ...relativePath.split("/"));
  if (!isPathInside(rootPath, target)) {
    throw new ExtensionPortingError(
      "output",
      "Generated scaffold path escapes its staging directory.",
    );
  }
  if (
    options.failureAfterFile !== undefined &&
    (!Number.isInteger(options.failureAfterFile) || options.failureAfterFile < 0)
  ) {
    throw new ExtensionPortingError("output", "Scaffold failure injection is invalid.");
  }
  if (options.failureAfterFile !== undefined && state.written >= options.failureAfterFile) {
    throw new ExtensionPortingError("output", "Forced scaffold write failure.");
  }
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
  await fs.writeFile(target, content, { encoding: "utf8", mode: 0o600 });
  state.written += 1;
}

async function publishStagedDirectory(
  stagePath: string,
  targetPath: string,
  targetExisted: boolean,
): Promise<void> {
  let backupPath: string | null = null;
  if (targetExisted) {
    const targetStat = await fs.lstat(targetPath);
    if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
      throw new ExtensionPortingError("output", "Scaffold output changed before publication.");
    }
    if ((await fs.readdir(targetPath)).length > 0) {
      throw new ExtensionPortingError("output", "Scaffold output directory must remain empty.");
    }
    backupPath = path.join(
      path.dirname(targetPath),
      `.${path.basename(targetPath)}.threadleaf-backup-${randomUUID()}`,
    );
    await fs.rename(targetPath, backupPath);
  }
  try {
    await fs.rename(stagePath, targetPath);
  } catch (error) {
    if (backupPath !== null) {
      await fs.rename(backupPath, targetPath).catch(() => undefined);
    }
    throw error;
  }
  if (backupPath !== null) {
    await fs.rm(backupPath, { recursive: true, force: true });
  }
}

/** Write a new independently authored native or compatibility fixture without reading code. */
export async function scaffoldPortingTemplate(
  report: PortingReport,
  kind: PortingScaffoldKind,
  outputDirectory: string,
  sourceDirectory: string,
  options: PortingScaffoldOptions = {},
): Promise<PortingScaffoldResult> {
  const blockingCodes = new Set([
    "asset-digest-mismatch",
    "invalid-asset-digest",
    "unexpected-stylesheet-digest",
    "manifest-id-mismatch",
    "manifest-version-mismatch",
    "manifest-schema-invalid",
    "unexpected-package-entry",
    "duplicate-package-entry",
    "non-file-package-entry",
    "package-path-escape",
    "missing-package-entry",
    "inspection-receipt-invalid",
  ]);
  if (
    report.diagnostics.some((item) => item.severity === "error" && blockingCodes.has(item.code))
  ) {
    throw new ExtensionPortingError(
      "input",
      "Cannot scaffold from a package with failed exact-byte or receipt diagnostics.",
    );
  }
  const output = await safeOutputLocation(outputDirectory, sourceDirectory);
  let stagePath: string | null = null;
  const files: string[] = ["PORTING_PLAN.json", "README.md", "tests/conformance.test.ts"];
  const writeState = { written: 0 };
  let target: PortingScaffoldResult["target"];
  try {
    stagePath = await fs.mkdtemp(
      path.join(
        path.dirname(output.target),
        `.${path.basename(output.target)}.threadleaf-staging-`,
      ),
    );
    if (kind === "native") {
      const native = nativeManifestFor(report);
      target = {
        id: native.id,
        version: "0.1.0",
        runtime: native.runtime,
        capabilities: native.capabilities,
      };
      await writeText(
        stagePath,
        "manifest.json",
        `${JSON.stringify(native.manifest, null, 2)}\n`,
        writeState,
        options,
      );
      await writeText(
        stagePath,
        "src/index.ts",
        nativeSource(native.manifest, native.runtime),
        writeState,
        options,
      );
      files.push("manifest.json", "src/index.ts");
      await writeText(
        stagePath,
        "tests/conformance.test.ts",
        nativeTestSource(),
        writeState,
        options,
      );
    } else {
      const compatibility = compatibilityManifestFor(report);
      target = {
        id: compatibility.id,
        version: "0.1.0",
        runtime: "trusted-compatibility",
        capabilities: [],
      };
      await writeText(
        stagePath,
        "manifest.json",
        `${JSON.stringify(compatibility.manifest, null, 2)}\n`,
        writeState,
        options,
      );
      await writeText(stagePath, "main.js", compatibilitySource(), writeState, options);
      files.push("manifest.json", "main.js");
      await writeText(
        stagePath,
        "tests/conformance.test.ts",
        compatibilityTestSource(),
        writeState,
        options,
      );
    }
    await writeText(stagePath, "README.md", scaffoldReadme(report, kind), writeState, options);
    await writeText(stagePath, "PORTING_PLAN.json", planJson(report, kind), writeState, options);
    await publishStagedDirectory(stagePath, output.target, output.existed);
    stagePath = null;
  } catch (error) {
    if (stagePath !== null) {
      await fs.rm(stagePath, { recursive: true, force: true });
    }
    if (error instanceof ExtensionPortingError) {
      throw error;
    }
    throw new ExtensionPortingError("output", "Scaffold output could not be published atomically.");
  }
  return {
    schemaVersion: extensionPortingSchemaVersion,
    tool: { id: "threadleaf-extension-porting", version: extensionPortingToolVersion },
    kind,
    files: uniqueSorted(files),
    target,
    commands: [...report.ci.commands],
    limitations: [
      "The scaffold is a starting point, not a compatibility result.",
      "No inspected plugin source, stylesheet, asset, or executable bundle bytes were copied.",
      "Native capability declarations require the ordinary per-vault grant and exact-bundle review.",
    ],
  };
}
