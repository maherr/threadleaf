import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { promises as fs } from "node:fs";
import { builtinModules } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { IsolatedPluginRuntime } from "../runtime/isolated-plugin-runtime";
import { PluginHost } from "../runtime/plugin-host";
import type { PluginRuntimePort } from "../runtime/plugin-runtime-port";
import type { PluginIntegrationSnapshot, RuntimeSnapshot } from "../shared/contracts";
import type { PluginPackageInspectionReceipt } from "../shared/plugin-packages";
import {
  maxPluginBundleBytes,
  type PluginCapabilityReport,
  type PluginManifestData,
  parsePluginId,
  parsePluginManifest,
} from "../shared/plugins";
import { scanPluginCapabilities } from "./plugin-capability-scanner";
import { parsePluginPackageInspectionReceipt } from "./plugin-inspection-receipt";

/** Bumped when the machine-readable inspection report changes shape or meaning. */
export const pluginPackageInspectionSchemaVersion = 1 as const;
export const pluginPackageInspectionToolVersion = "1.0.0" as const;
export const defaultInspectionTimeoutMs = 5_000;
export const defaultInspectionAppVersion = "0.1.0-beta.3";
export const defaultInspectionPlatform = "linux-x64-electron";

const maxManifestBytes = 64 * 1024;
const maxStylesheetBytes = 2 * 1024 * 1024;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/u;
const floatingVersionLabels = new Set(["current", "head", "latest", "main", "master", "stable"]);
const packageFileNames = new Set(["manifest.json", "main.js", "styles.css"]);
const nodeBuiltinNames = new Set(
  builtinModules.map((name) => (name.startsWith("node:") ? name.slice(5) : name)),
);
const compatibilityHostModules = [
  "@codemirror/",
  "@lezer/",
  "@zsviczian/excalidraw",
  "react",
  "react-dom",
] as const;

export type InspectionStageStatus = "pass" | "fail" | "blocked" | "not-run";
export type InspectionOverallStatus = "pass" | "fail" | "blocked";

export const pluginPackageInspectionStageIds = [
  "package-shape",
  "manifest-schema",
  "dependency-model",
  "minimum-app-platform",
  "static-authority",
  "banned-private-primitives",
  "activation",
  "registration-snapshot",
  "cleanup",
  "timeout",
] as const;

export type PluginPackageInspectionStageId = (typeof pluginPackageInspectionStageIds)[number];

export interface PluginPackageAssetBytes {
  manifest: Uint8Array;
  main: Uint8Array;
  styles?: Uint8Array | null;
}

export interface PluginPackageAssetHashes {
  manifestSha256: string;
  mainSha256: string;
  stylesSha256?: string | null;
}

export type PluginPackageProvenanceKind = "fixture" | "local" | "release";

/** Provenance contains identifiers and public URLs only. It never contains a host path. */
export interface PluginPackageProvenance {
  kind: PluginPackageProvenanceKind;
  pluginId: string;
  version: string;
  releaseTag: string;
  sourceUrl: string | null;
  releaseUrl: string | null;
  indexUrl: string | null;
  indexSha256: string | null;
}

export interface PluginPackageEntry {
  path: string;
  kind: "file" | "directory" | "symlink";
}

/** Exact bytes are required. A release label or a floating index entry is not an input. */
export interface ExactPluginPackageInput {
  assets: PluginPackageAssetBytes;
  hashes: PluginPackageAssetHashes;
  provenance: PluginPackageProvenance;
  /** Optional archive/directory listing used to check package shape. */
  entries?: readonly PluginPackageEntry[];
}

export interface PluginPackageInspectionOptions {
  appVersion?: string;
  platform?: string;
  timeoutMs?: number;
  networkMode?: "denied" | "deterministic-fixture";
  runtimeFactory?: PluginInspectionRuntimeFactory;
  /** A stable logical evidence root, never an absolute filesystem path. */
  evidenceRoot?: string;
}

export interface PluginInspectionRuntimeContext {
  vaultPath: string;
  pluginDirectory: string;
  expectedBundleSha256: string;
  networkMode: "denied" | "deterministic-fixture";
}

export type PluginInspectionRuntimeFactory = (
  context: PluginInspectionRuntimeContext,
) => Promise<PluginRuntimePort>;

export interface InspectionDiagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  evidencePath: string;
}

export interface PluginPackageInspectionStage {
  id: PluginPackageInspectionStageId;
  status: InspectionStageStatus;
  durationMs: number;
  toolVersion: typeof pluginPackageInspectionToolVersion;
  schemaVersion: typeof pluginPackageInspectionSchemaVersion;
  evidencePaths: string[];
  diagnostics: InspectionDiagnostic[];
  limitations: string[];
}

export interface PluginPackageAssetEvidence {
  filename: "manifest.json" | "main.js" | "styles.css";
  size: number;
  sha256: string;
}

export interface PluginPackageInspectionInputEvidence {
  pluginId: string;
  version: string;
  provenance: PluginPackageProvenance;
  assets: PluginPackageAssetEvidence[];
}

export interface PluginDependencyEvidence {
  module: string;
  kind:
    | "compatibility-host"
    | "obsidian-api"
    | "bundled-external"
    | "node-builtin"
    | "relative"
    | "unsafe-specifier";
}

export interface PluginPrimitiveEvidence {
  id: string;
  severity: "warning" | "blocked";
  evidencePath: string;
}

export interface PluginRegistrationSnapshot {
  commands: Array<{ id: string; name: string; ownerId: string }>;
  viewTypes: string[];
  extensions: Array<{ extension: string; viewType: string }>;
  markdownPostProcessors: number;
  editorSuggests: number;
  ribbonItems: number;
  statusBarItems: number;
  settingTabs: number;
}

export interface PluginVaultDiff {
  changedFileCount: number;
  createdFileCount: number;
  removedFileCount: number;
  outsideBoundaryCount: number;
}

export interface PluginPackageInspectionReport {
  schemaVersion: typeof pluginPackageInspectionSchemaVersion;
  tool: {
    id: "threadleaf-plugin-package-inspector";
    version: typeof pluginPackageInspectionToolVersion;
  };
  overall: InspectionOverallStatus;
  input: PluginPackageInspectionInputEvidence;
  manifest: {
    id: string;
    version: string;
    minAppVersion: string | null;
    isDesktopOnly: boolean;
  } | null;
  staticAuthority: PluginCapabilityReport | null;
  dependencies: PluginDependencyEvidence[];
  primitives: PluginPrimitiveEvidence[];
  registrations: PluginRegistrationSnapshot | null;
  vaultDiff: PluginVaultDiff | null;
  stages: PluginPackageInspectionStage[];
  limitations: string[];
  candidate: PluginPackageRegistryCandidate | null;
}

export interface PluginPackageRegistryCandidate {
  schemaVersion: 1;
  candidateKind: "automated-plugin-package-inspection";
  exactPackage: {
    id: string;
    version: string;
    bundleSha256: string;
    manifestSha256: string;
    stylesSha256: string | null;
    provenance: PluginPackageProvenance;
  };
  compatibilityLevel: 0 | 1 | 2 | 3 | 4;
  requiredCapabilities: string[];
  evidenceStatus: "all-required-gates-passed";
  limitations: string[];
}

interface MaterializedPackage {
  rootPath: string;
  vaultPath: string;
  pluginDirectory: string;
  initialVaultTree: Map<string, string>;
  initialSandboxTree: Map<string, string>;
}

interface RuntimeRun {
  runtime: PluginRuntimePort | null;
  activationSnapshot: RuntimeSnapshot | null;
  cleanupSnapshot: RuntimeSnapshot | null;
  timedOut: boolean;
  activationError: unknown | null;
  cleanupError: unknown | null;
  vaultDiff: PluginVaultDiff;
  globalMutationDetected: boolean;
}

class StageBuilder {
  readonly #started = performance.now();
  readonly diagnostics: InspectionDiagnostic[] = [];
  readonly evidencePaths = new Set<string>();
  readonly limitations = new Set<string>();

  constructor(readonly id: PluginPackageInspectionStageId) {}

  addEvidence(...paths: string[]): void {
    for (const evidencePath of paths) {
      this.evidencePaths.add(evidencePath);
    }
  }

  addDiagnostic(diagnostic: InspectionDiagnostic): void {
    this.diagnostics.push(diagnostic);
  }

  addLimitation(limitation: string): void {
    this.limitations.add(limitation);
  }

  finish(status: InspectionStageStatus): PluginPackageInspectionStage {
    return {
      id: this.id,
      status,
      durationMs: Math.max(0, Math.round(performance.now() - this.#started)),
      toolVersion: pluginPackageInspectionToolVersion,
      schemaVersion: pluginPackageInspectionSchemaVersion,
      evidencePaths: [...this.evidencePaths].sort(),
      diagnostics: [...this.diagnostics],
      limitations: [...this.limitations],
    };
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeUrl(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  try {
    const url = new URL(value);
    if (!new Set(["https:", "http:", "fixture:"]).has(url.protocol)) {
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

function safeProvenance(value: PluginPackageProvenance): PluginPackageProvenance {
  return {
    kind: value.kind,
    pluginId: value.pluginId,
    version: value.version,
    releaseTag: value.releaseTag,
    sourceUrl: safeUrl(value.sourceUrl),
    releaseUrl: safeUrl(value.releaseUrl),
    indexUrl: safeUrl(value.indexUrl),
    indexSha256:
      value.indexSha256 !== null && sha256Pattern.test(value.indexSha256)
        ? value.indexSha256
        : null,
  };
}

function diagnostic(
  code: string,
  severity: InspectionDiagnostic["severity"],
  message: string,
  evidencePath: string,
): InspectionDiagnostic {
  return { code, severity, message, evidencePath };
}

function containsControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function safeRegistrationText(value: string): string {
  if (
    value.length > 200 ||
    containsControlCharacters(value) ||
    /^(?:[A-Za-z]:[\\/]|[\\/])/u.test(value) ||
    /(?:^|[\\/])(?:home|Users|private|tmp|var)[\\/]/u.test(value) ||
    /\b(?:password|passphrase|secret|token|api[_ -]?key|cookie)\b/iu.test(value)
  ) {
    return "<redacted>";
  }
  return value;
}

function stageById(
  stages: readonly PluginPackageInspectionStage[],
  id: PluginPackageInspectionStageId,
): PluginPackageInspectionStage {
  const stage = stages.find((candidate) => candidate.id === id);
  if (!stage) {
    throw new Error(`Inspection stage is missing: ${id}`);
  }
  return stage;
}

function allPass(stages: readonly PluginPackageInspectionStage[], ids: readonly string[]): boolean {
  return ids.every((id) => stages.find((stage) => stage.id === id)?.status === "pass");
}

function parseVersion(value: string): number[] | null {
  if (!versionPattern.test(value)) {
    return null;
  }
  const core = value.split(/[+-]/u, 1)[0] ?? value;
  const numbers = core.split(".").map((part) => Number(part));
  if (numbers.some((part) => !Number.isSafeInteger(part) || part < 0)) {
    return null;
  }
  return numbers;
}

function compareVersions(left: string, right: string): number | null {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  if (!leftParts || !rightParts) {
    return null;
  }
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  return 0;
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function assetEvidence(input: ExactPluginPackageInput): PluginPackageAssetEvidence[] {
  const assets: PluginPackageAssetEvidence[] = [
    {
      filename: "manifest.json",
      size: input.assets.manifest.byteLength,
      sha256: sha256(input.assets.manifest),
    },
    {
      filename: "main.js",
      size: input.assets.main.byteLength,
      sha256: sha256(input.assets.main),
    },
  ];
  if (input.assets.styles) {
    assets.push({
      filename: "styles.css",
      size: input.assets.styles.byteLength,
      sha256: sha256(input.assets.styles),
    });
  }
  return assets;
}

function validateProvenance(input: ExactPluginPackageInput): InspectionDiagnostic[] {
  const diagnostics: InspectionDiagnostic[] = [];
  try {
    parsePluginId(input.provenance.pluginId);
  } catch {
    diagnostics.push(
      diagnostic(
        "invalid-provenance-plugin-id",
        "error",
        "Provenance plugin identifier is invalid.",
        "input/provenance",
      ),
    );
  }
  for (const [label, value] of [
    ["version", input.provenance.version],
    ["release tag", input.provenance.releaseTag],
  ] as const) {
    if (!versionPattern.test(value)) {
      diagnostics.push(
        diagnostic(
          "invalid-provenance-version",
          "error",
          `Provenance ${label} is not an exact version token.`,
          "input/provenance",
        ),
      );
    } else if (floatingVersionLabels.has(value.toLowerCase())) {
      diagnostics.push(
        diagnostic(
          "floating-release-label",
          "error",
          `Provenance ${label} is a floating release label, not an exact package version.`,
          "input/provenance",
        ),
      );
    }
  }
  if (input.provenance.version !== input.provenance.releaseTag) {
    diagnostics.push(
      diagnostic(
        "floating-release-label",
        "error",
        "Release tag must equal the exact package version; floating labels cannot carry evidence.",
        "input/provenance",
      ),
    );
  }
  if (input.provenance.indexSha256 !== null && !sha256Pattern.test(input.provenance.indexSha256)) {
    diagnostics.push(
      diagnostic(
        "invalid-index-digest",
        "error",
        "Index provenance digest must be a lowercase SHA-256 value.",
        "input/provenance",
      ),
    );
  }
  return diagnostics;
}

function packageShapeStage(input: ExactPluginPackageInput): PluginPackageInspectionStage {
  const stage = new StageBuilder("package-shape");
  stage.addEvidence("input/manifest.json", "input/main.js", "input/provenance");
  if (input.assets.styles) {
    stage.addEvidence("input/styles.css");
  }
  const diagnostics = validateProvenance(input);
  const actualHashes = assetEvidence(input);
  const expected: Array<[string, string | null | undefined, string]> = [
    ["manifest.json", input.hashes.manifestSha256, actualHashes[0]?.sha256 ?? ""],
    ["main.js", input.hashes.mainSha256, actualHashes[1]?.sha256 ?? ""],
    ["styles.css", input.hashes.stylesSha256, actualHashes[2]?.sha256 ?? ""],
  ];
  for (const [filename, declared, actual] of expected) {
    const present =
      filename !== "styles.css" ||
      (input.assets.styles !== null && input.assets.styles !== undefined);
    if (!present) {
      if (declared !== undefined && declared !== null) {
        diagnostics.push(
          diagnostic(
            "unexpected-stylesheet-digest",
            "error",
            "A stylesheet digest was supplied without stylesheet bytes.",
            "input/styles.css",
          ),
        );
      }
      continue;
    }
    if (typeof declared !== "string" || !sha256Pattern.test(declared)) {
      diagnostics.push(
        diagnostic(
          "invalid-asset-digest",
          "error",
          `${filename} requires a lowercase SHA-256 digest.`,
          `input/${filename}`,
        ),
      );
    } else if (declared !== actual) {
      diagnostics.push(
        diagnostic(
          "asset-digest-mismatch",
          "error",
          `${filename} bytes do not match the declared digest.`,
          `input/${filename}`,
        ),
      );
    }
  }
  if (
    input.assets.manifest.byteLength === 0 ||
    input.assets.manifest.byteLength > maxManifestBytes
  ) {
    diagnostics.push(
      diagnostic(
        "manifest-size-limit",
        "error",
        "manifest.json is empty or exceeds the bounded package limit.",
        "input/manifest.json",
      ),
    );
  }
  if (input.assets.main.byteLength === 0 || input.assets.main.byteLength > maxPluginBundleBytes) {
    diagnostics.push(
      diagnostic(
        "bundle-size-limit",
        "error",
        "main.js is empty or exceeds the bounded package limit.",
        "input/main.js",
      ),
    );
  }
  if (input.assets.styles && input.assets.styles.byteLength > maxStylesheetBytes) {
    diagnostics.push(
      diagnostic(
        "stylesheet-size-limit",
        "error",
        "styles.css exceeds the bounded package limit.",
        "input/styles.css",
      ),
    );
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(input.assets.manifest);
    new TextDecoder("utf-8", { fatal: true }).decode(input.assets.main);
    if (input.assets.styles) {
      new TextDecoder("utf-8", { fatal: true }).decode(input.assets.styles);
    }
  } catch {
    diagnostics.push(
      diagnostic(
        "invalid-utf8",
        "error",
        "Package text assets are not valid UTF-8.",
        "input/assets",
      ),
    );
  }
  if (input.entries) {
    const seen = new Set<string>();
    for (const entry of input.entries) {
      if (seen.has(entry.path)) {
        diagnostics.push(
          diagnostic(
            "duplicate-package-entry",
            "error",
            "Package shape contains a duplicate entry.",
            "input/package-entries",
          ),
        );
      }
      seen.add(entry.path);
      const normalized = entry.path.replaceAll("\\", "/");
      if (
        normalized.startsWith("/") ||
        normalized.split("/").includes("..") ||
        normalized.split("/").some((segment) => segment.length === 0)
      ) {
        diagnostics.push(
          diagnostic(
            "package-path-escape",
            "error",
            "Package entry leaves its disposable package root.",
            "input/package-entries",
          ),
        );
      }
      if (!packageFileNames.has(normalized)) {
        diagnostics.push(
          diagnostic(
            "unexpected-package-entry",
            "error",
            "Package contains an unsupported asset or directory entry.",
            "input/package-entries",
          ),
        );
      }
      if (entry.kind !== "file") {
        diagnostics.push(
          diagnostic(
            "non-file-package-entry",
            "error",
            "Package assets must be regular files; symlinks and directories are rejected.",
            "input/package-entries",
          ),
        );
      }
    }
    const expectedEntries = input.assets.styles
      ? ["main.js", "manifest.json", "styles.css"]
      : ["main.js", "manifest.json"];
    if (
      expectedEntries.some(
        (filename) =>
          !input.entries?.some((entry) => entry.path === filename && entry.kind === "file"),
      )
    ) {
      diagnostics.push(
        diagnostic(
          "missing-package-entry",
          "error",
          "Package shape is missing one of the exact required assets.",
          "input/package-entries",
        ),
      );
    }
  }
  for (const item of diagnostics) {
    stage.addDiagnostic(item);
  }
  return stage.finish(diagnostics.length === 0 ? "pass" : "fail");
}

function manifestStage(input: ExactPluginPackageInput): {
  stage: PluginPackageInspectionStage;
  manifest: PluginManifestData | null;
} {
  const stage = new StageBuilder("manifest-schema");
  stage.addEvidence("input/manifest.json");
  let manifest: PluginManifestData | null = null;
  const diagnostics: InspectionDiagnostic[] = [];
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(input.assets.manifest);
    manifest = parsePluginManifest(JSON.parse(text));
    if (manifest.id !== input.provenance.pluginId) {
      diagnostics.push(
        diagnostic(
          "manifest-id-mismatch",
          "error",
          "Manifest identifier does not match exact package provenance.",
          "input/manifest.json",
        ),
      );
    }
    if (manifest.version !== input.provenance.version) {
      diagnostics.push(
        diagnostic(
          "manifest-version-mismatch",
          "error",
          "Manifest version does not match exact package provenance.",
          "input/manifest.json",
        ),
      );
    }
  } catch {
    diagnostics.push(
      diagnostic(
        "manifest-schema-invalid",
        "error",
        "Manifest JSON or schema validation failed.",
        "input/manifest.json",
      ),
    );
  }
  for (const item of diagnostics) {
    stage.addDiagnostic(item);
  }
  return { stage: stage.finish(diagnostics.length === 0 ? "pass" : "fail"), manifest };
}

function extractDependencies(source: string): {
  dependencies: PluginDependencyEvidence[];
  dynamic: boolean;
} {
  const dependencies = new Map<string, PluginDependencyEvidence["kind"]>();
  const literalPatterns = [
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /\bfrom\s*["']([^"']+)["']/gu,
  ] as const;
  for (const pattern of literalPatterns) {
    for (const match of source.matchAll(pattern)) {
      const moduleName = match[1];
      if (!moduleName) {
        continue;
      }
      let kind: PluginDependencyEvidence["kind"] = "bundled-external";
      if (moduleName === "obsidian") {
        kind = "obsidian-api";
      } else if (moduleName.startsWith("./") || moduleName.startsWith("../")) {
        kind = "relative";
      } else if (
        moduleName.startsWith("/") ||
        /^[A-Za-z]:[\\/]/u.test(moduleName) ||
        moduleName.startsWith("file:") ||
        containsControlCharacters(moduleName)
      ) {
        // Keep absolute and control-bearing specifiers out of machine-readable evidence. They
        // may contain a host path or a secret-bearing URI, neither of which is useful to a
        // compatibility report.
        kind = "unsafe-specifier";
      } else if (nodeBuiltinNames.has(moduleName.replace(/^node:/u, ""))) {
        kind = "node-builtin";
      } else if (compatibilityHostModules.some((prefix) => moduleName.startsWith(prefix))) {
        kind = "compatibility-host";
      }
      dependencies.set(
        kind === "unsafe-specifier" ? "<unsafe-module-specifier>" : moduleName,
        kind,
      );
    }
  }
  const dynamic =
    /\b(?:require|import)\s*\(\s*(?!["'`])/u.test(source) ||
    /\bimport\s*\(\s*`[^`]*\$\{/u.test(source);
  return {
    dependencies: [...dependencies.entries()]
      .map(([module, kind]) => ({ module, kind }))
      .sort((left, right) => left.module.localeCompare(right.module, "en-US")),
    dynamic,
  };
}

function dependencyStage(input: ExactPluginPackageInput): {
  stage: PluginPackageInspectionStage;
  dependencies: PluginDependencyEvidence[];
} {
  const stage = new StageBuilder("dependency-model");
  stage.addEvidence("input/main.js", "analysis/dependencies.json");
  const diagnostics: InspectionDiagnostic[] = [];
  let source = "";
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(input.assets.main);
  } catch {
    diagnostics.push(
      diagnostic(
        "dependency-source-invalid",
        "error",
        "Dependency model could not decode main.js.",
        "input/main.js",
      ),
    );
  }
  const result = extractDependencies(source);
  for (const dependency of result.dependencies) {
    if (dependency.kind === "node-builtin") {
      diagnostics.push(
        diagnostic(
          "undeclared-host-dependency",
          "error",
          "The package references a Node builtin outside the compatibility API.",
          "analysis/dependencies.json",
        ),
      );
    }
    if (dependency.kind === "relative") {
      diagnostics.push(
        diagnostic(
          "unprovided-relative-dependency",
          "error",
          "The exact package input does not include a referenced relative asset.",
          "analysis/dependencies.json",
        ),
      );
    }
    if (dependency.kind === "unsafe-specifier") {
      diagnostics.push(
        diagnostic(
          "unsafe-module-specifier",
          "error",
          "The package references an absolute or otherwise unsafe module specifier.",
          "analysis/dependencies.json",
        ),
      );
    }
  }
  if (result.dynamic) {
    diagnostics.push(
      diagnostic(
        "dynamic-dependency",
        "error",
        "Dynamic module selection cannot be verified from exact package bytes.",
        "analysis/dependencies.json",
      ),
    );
  }
  if (result.dependencies.some((dependency) => dependency.kind === "bundled-external")) {
    stage.addLimitation(
      "External package dependencies are treated as bundled because manifest.json has no dependency graph; their transitive code is outside this exact three-asset scan.",
    );
  }
  for (const item of diagnostics) {
    stage.addDiagnostic(item);
  }
  return {
    stage: stage.finish(diagnostics.length === 0 ? "pass" : "fail"),
    dependencies: result.dependencies,
  };
}

function minimumPlatformStage(
  manifest: PluginManifestData | null,
  options: Required<Pick<PluginPackageInspectionOptions, "appVersion" | "platform">>,
): PluginPackageInspectionStage {
  const stage = new StageBuilder("minimum-app-platform");
  stage.addEvidence("input/manifest.json", "analysis/platform.json");
  if (!manifest) {
    stage.addDiagnostic(
      diagnostic(
        "manifest-unavailable",
        "error",
        "Minimum app and platform flags cannot be checked without a valid manifest.",
        "analysis/platform.json",
      ),
    );
    return stage.finish("blocked");
  }
  const diagnostics: InspectionDiagnostic[] = [];
  if (manifest.minAppVersion) {
    const comparison = compareVersions(options.appVersion, manifest.minAppVersion);
    if (comparison === null) {
      diagnostics.push(
        diagnostic(
          "unsupported-min-app-version",
          "error",
          "Minimum app version could not be compared with the current Threadleaf version.",
          "analysis/platform.json",
        ),
      );
    } else if (comparison < 0) {
      diagnostics.push(
        diagnostic(
          "minimum-app-version-unmet",
          "error",
          "Package requires a newer Threadleaf app version.",
          "analysis/platform.json",
        ),
      );
    }
  }
  if (manifest.isDesktopOnly && !options.platform.includes("electron")) {
    diagnostics.push(
      diagnostic(
        "desktop-only-package",
        "error",
        "Package is desktop-only and cannot be activated on the requested platform.",
        "analysis/platform.json",
      ),
    );
  }
  for (const item of diagnostics) {
    stage.addDiagnostic(item);
  }
  return stage.finish(diagnostics.length === 0 ? "pass" : "blocked");
}

interface PrimitiveRule {
  id: string;
  pattern: RegExp;
  severity: "warning" | "blocked";
}

const primitiveRules: readonly PrimitiveRule[] = [
  {
    id: "node-filesystem",
    pattern:
      /(?:require|import)\s*\(\s*["'](?:node:)?fs(?:\/promises)?["']|\bfrom\s*["'](?:node:)?fs(?:\/promises)?["']/u,
    severity: "blocked",
  },
  {
    id: "node-subprocess",
    pattern:
      /(?:require|import)\s*\(\s*["'](?:node:)?child_process["']|\bfrom\s*["'](?:node:)?child_process["']/u,
    severity: "blocked",
  },
  {
    id: "node-electron",
    pattern: /(?:require|import)\s*\(\s*["']electron["']|\bfrom\s*["']electron["']/u,
    severity: "blocked",
  },
  {
    id: "private-vault-adapter",
    pattern: /\b(?:app\s*\.\s*)?vault\s*\.\s*adapter\b|\bapp\s*\.\s*(?:internalPlugins|plugins)\b/u,
    severity: "blocked",
  },
  {
    id: "path-traversal",
    pattern: /(?:\.\.\s*[\\/]|%2e%2e|%252e)/iu,
    severity: "blocked",
  },
  {
    id: "global-mutation",
    pattern: /\b(?:globalThis|global|window)(?:\s*\.\s*[A-Za-z_$][\w$]*|\s*\[[^\]]+\])\s*=/u,
    severity: "warning",
  },
  {
    id: "dynamic-evaluation",
    pattern: /(?:^|[^.$\w])eval\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(\s*["'`]/u,
    severity: "blocked",
  },
];

function primitiveStage(input: ExactPluginPackageInput): {
  stage: PluginPackageInspectionStage;
  primitives: PluginPrimitiveEvidence[];
} {
  const stage = new StageBuilder("banned-private-primitives");
  stage.addEvidence("input/main.js", "analysis/primitives.json");
  let source = "";
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(input.assets.main);
  } catch {
    stage.addDiagnostic(
      diagnostic(
        "primitive-source-invalid",
        "error",
        "Primitive diagnostics could not decode main.js.",
        "analysis/primitives.json",
      ),
    );
    return { stage: stage.finish("blocked"), primitives: [] };
  }
  const primitives = primitiveRules
    .filter((rule) => rule.pattern.test(source))
    .map((rule) => ({
      id: rule.id,
      severity: rule.severity,
      evidencePath: "input/main.js",
    }));
  for (const primitive of primitives) {
    stage.addDiagnostic(
      diagnostic(
        primitive.id,
        primitive.severity === "blocked" ? "error" : "warning",
        primitive.severity === "blocked"
          ? "A banned or private primitive was observed; trusted activation is blocked."
          : "A global mutation primitive was observed; runtime mutation checks remain required.",
        primitive.evidencePath,
      ),
    );
  }
  stage.addLimitation(
    "Static primitive matching is conservative and cannot prove that a bundle is safe or that an unobserved code path is absent.",
  );
  stage.addLimitation(
    "Runtime global checks compare namespace keys only; mutations to existing objects and process-backed code outside this inspection remain outside coverage.",
  );
  return {
    stage: stage.finish(
      primitives.some((primitive) => primitive.severity === "blocked") ? "fail" : "pass",
    ),
    primitives,
  };
}

function registrationSnapshot(snapshot: RuntimeSnapshot | null): PluginRegistrationSnapshot | null {
  if (!snapshot) {
    return null;
  }
  const integrations: PluginIntegrationSnapshot = snapshot.integrations ?? {
    editorSuggests: 0,
    extensions: [],
    markdownPostProcessors: 0,
    ribbonItems: 0,
    settingTabs: 0,
    statusBarItems: 0,
    viewTypes: [],
  };
  return {
    commands: snapshot.commands.map(({ id, name, ownerId }) => ({
      id: safeRegistrationText(id),
      name: safeRegistrationText(name),
      ownerId: safeRegistrationText(ownerId),
    })),
    viewTypes: [...integrations.viewTypes].map(safeRegistrationText).sort(),
    extensions: integrations.extensions.map(({ extension, viewType }) => ({
      extension: safeRegistrationText(extension),
      viewType: safeRegistrationText(viewType),
    })),
    markdownPostProcessors: integrations.markdownPostProcessors,
    editorSuggests: integrations.editorSuggests,
    ribbonItems: integrations.ribbonItems,
    statusBarItems: integrations.statusBarItems,
    settingTabs: integrations.settingTabs,
  };
}

async function treeSnapshot(
  rootPath: string,
  excludedPrefix: string | null = null,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const pending = [rootPath];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(rootPath, absolute).split(path.sep).join("/");
      if (
        excludedPrefix !== null &&
        (relative === excludedPrefix || relative.startsWith(`${excludedPrefix}/`))
      ) {
        continue;
      }
      if (entry.isDirectory()) {
        pending.push(absolute);
      } else if (entry.isFile()) {
        const bytes = await fs.readFile(absolute);
        result.set(relative, sha256(bytes));
      } else if (entry.isSymbolicLink()) {
        result.set(relative, "symlink");
      }
    }
  }
  return result;
}

function changedEntryCount(before: Map<string, string>, after: Map<string, string>): number {
  let changed = 0;
  const keys = new Set([...before.keys(), ...after.keys()]);
  for (const key of keys) {
    if (before.get(key) !== after.get(key)) {
      changed += 1;
    }
  }
  return changed;
}

function vaultDiff(
  before: Map<string, string>,
  after: Map<string, string>,
  outsideBoundaryCount = 0,
): PluginVaultDiff {
  let createdFileCount = 0;
  let removedFileCount = 0;
  let changedFileCount = 0;
  const keys = new Set([...before.keys(), ...after.keys()]);
  for (const key of keys) {
    const prior = before.get(key);
    const next = after.get(key);
    if (prior === undefined && next !== undefined) {
      createdFileCount += 1;
    } else if (prior !== undefined && next === undefined) {
      removedFileCount += 1;
    } else if (prior !== next) {
      changedFileCount += 1;
    }
  }
  return { changedFileCount, createdFileCount, removedFileCount, outsideBoundaryCount };
}

async function materializePackage(input: ExactPluginPackageInput): Promise<MaterializedPackage> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-plugin-inspection-"));
  const vaultPath = path.join(rootPath, "vault");
  const pluginDirectory = path.join(vaultPath, ".obsidian", "plugins", input.provenance.pluginId);
  await fs.mkdir(pluginDirectory, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(vaultPath, "Inspection Fixture.md"),
    "# Disposable inspection vault\n",
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
  await fs.writeFile(
    path.join(pluginDirectory, "manifest.json"),
    cloneBytes(input.assets.manifest),
    {
      mode: 0o600,
    },
  );
  await fs.writeFile(path.join(pluginDirectory, "main.js"), cloneBytes(input.assets.main), {
    mode: 0o600,
  });
  if (input.assets.styles) {
    await fs.writeFile(path.join(pluginDirectory, "styles.css"), cloneBytes(input.assets.styles), {
      mode: 0o600,
    });
  }
  const initialVaultTree = await treeSnapshot(vaultPath);
  const initialSandboxTree = await treeSnapshot(rootPath);
  return { rootPath, vaultPath, pluginDirectory, initialVaultTree, initialSandboxTree };
}

class InspectionTimeoutError extends Error {
  constructor() {
    super("inspection operation timed out");
    this.name = "InspectionTimeoutError";
  }
}

function isInspectionTimeoutError(error: unknown): error is InspectionTimeoutError {
  return error instanceof InspectionTimeoutError;
}

async function runWithTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new InspectionTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function globalKeys(): Set<string> {
  return new Set(Object.getOwnPropertyNames(globalThis));
}

async function defaultRuntimeFactory(
  context: PluginInspectionRuntimeContext,
): Promise<PluginRuntimePort> {
  return IsolatedPluginRuntime.open({
    create: async () => new PluginHost(context.vaultPath),
  });
}

async function runTrustedRuntime(
  packageInput: ExactPluginPackageInput,
  materialized: MaterializedPackage,
  options: Required<Pick<PluginPackageInspectionOptions, "timeoutMs" | "networkMode">> & {
    runtimeFactory: PluginInspectionRuntimeFactory | undefined;
  },
): Promise<RuntimeRun> {
  const beforeGlobalKeys = globalKeys();
  const factory = options.runtimeFactory ?? defaultRuntimeFactory;
  const context: PluginInspectionRuntimeContext = {
    vaultPath: materialized.vaultPath,
    pluginDirectory: materialized.pluginDirectory,
    expectedBundleSha256: sha256(packageInput.assets.main),
    networkMode: options.networkMode,
  };
  let runtime: PluginRuntimePort | null = null;
  let activationSnapshot: RuntimeSnapshot | null = null;
  let cleanupSnapshot: RuntimeSnapshot | null = null;
  let timedOut = false;
  let activationError: unknown | null = null;
  let cleanupError: unknown | null = null;
  try {
    runtime = await runWithTimeout(() => factory(context), options.timeoutMs);
    activationSnapshot = await runWithTimeout(
      () =>
        runtime?.loadPlugin(
          materialized.pluginDirectory,
          context.expectedBundleSha256,
        ) as Promise<RuntimeSnapshot>,
      options.timeoutMs,
    );
  } catch (error) {
    timedOut = isInspectionTimeoutError(error);
    activationError = error;
  } finally {
    if (runtime) {
      try {
        cleanupSnapshot = await runWithTimeout(
          () => runtime?.unloadAllPlugins() as Promise<RuntimeSnapshot>,
          options.timeoutMs,
        );
      } catch (error) {
        timedOut ||= isInspectionTimeoutError(error);
        cleanupError = error;
      }
      try {
        await runWithTimeout(() => runtime?.close() as Promise<void>, options.timeoutMs);
      } catch (error) {
        timedOut ||= isInspectionTimeoutError(error);
        cleanupError ??= error;
      }
    }
  }
  const afterGlobalKeys = globalKeys();
  const globalMutationDetected =
    [...afterGlobalKeys].some((key) => !beforeGlobalKeys.has(key)) ||
    [...beforeGlobalKeys].some((key) => !afterGlobalKeys.has(key));
  const afterVaultTree = await treeSnapshot(materialized.vaultPath);
  const afterSandboxTree = await treeSnapshot(materialized.rootPath);
  const outsideBoundaryCount = changedEntryCount(
    new Map(
      [...materialized.initialSandboxTree.entries()].filter(
        ([key]) => key !== "vault" && !key.startsWith("vault/"),
      ),
    ),
    new Map(
      [...afterSandboxTree.entries()].filter(
        ([key]) => key !== "vault" && !key.startsWith("vault/"),
      ),
    ),
  );
  return {
    runtime,
    activationSnapshot,
    cleanupSnapshot,
    timedOut,
    activationError,
    cleanupError,
    vaultDiff: vaultDiff(materialized.initialVaultTree, afterVaultTree, outsideBoundaryCount),
    globalMutationDetected,
  };
}

function unavailableStage(
  id: PluginPackageInspectionStageId,
  reason: string,
): PluginPackageInspectionStage {
  const stage = new StageBuilder(id);
  stage.addDiagnostic(
    diagnostic("prerequisite-not-met", "error", reason, "analysis/pipeline.json"),
  );
  return stage.finish("blocked");
}

function buildCandidate(
  input: ExactPluginPackageInput,
  report: Omit<PluginPackageInspectionReport, "candidate">,
): PluginPackageRegistryCandidate | null {
  const required = [
    "package-shape",
    "manifest-schema",
    "dependency-model",
    "minimum-app-platform",
    "static-authority",
    "banned-private-primitives",
    "activation",
    "registration-snapshot",
    "cleanup",
    "timeout",
  ] as const;
  if (!allPass(report.stages, required)) {
    return null;
  }
  const manifest = report.manifest;
  if (!manifest || !report.staticAuthority) {
    return null;
  }
  return {
    schemaVersion: 1,
    candidateKind: "automated-plugin-package-inspection",
    exactPackage: {
      id: input.provenance.pluginId,
      version: input.provenance.version,
      bundleSha256: report.staticAuthority.bundleSha256,
      manifestSha256: sha256(input.assets.manifest),
      stylesSha256: input.assets.styles ? sha256(input.assets.styles) : null,
      provenance: safeProvenance(input.provenance),
    },
    // Activation plus an integration inventory reaches Level 3. This inspector does not run a
    // named end-to-end user workflow, so it must not manufacture a Level 4 claim.
    compatibilityLevel: 3,
    requiredCapabilities: [...report.staticAuthority.capabilities],
    evidenceStatus: "all-required-gates-passed",
    limitations: [
      "Static inspection is a review aid, not a sandbox or proof of safety.",
      "Trusted compatibility execution does not provide an OS security boundary for Node-capable plugin code.",
      ...report.limitations,
    ].filter((value, index, values) => values.indexOf(value) === index),
  };
}

/**
 * Inspect one exact package. The default runtime is the existing trusted fixture host; callers
 * can inject the Electron host or a deterministic fake runtime for CI and release checks.
 */
export async function inspectPluginPackage(
  input: ExactPluginPackageInput,
  configuredOptions: PluginPackageInspectionOptions = {},
): Promise<PluginPackageInspectionReport> {
  const options = {
    appVersion: configuredOptions.appVersion ?? defaultInspectionAppVersion,
    platform: configuredOptions.platform ?? defaultInspectionPlatform,
    timeoutMs:
      configuredOptions.timeoutMs &&
      Number.isFinite(configuredOptions.timeoutMs) &&
      configuredOptions.timeoutMs > 0
        ? Math.max(1, Math.round(configuredOptions.timeoutMs))
        : defaultInspectionTimeoutMs,
    networkMode: configuredOptions.networkMode ?? "denied",
    runtimeFactory: configuredOptions.runtimeFactory,
  } as const;
  const stages: PluginPackageInspectionStage[] = [];
  const shape = packageShapeStage(input);
  stages.push(shape);
  const inputEvidence: PluginPackageInspectionInputEvidence = {
    pluginId: input.provenance.pluginId,
    version: input.provenance.version,
    provenance: safeProvenance(input.provenance),
    assets: assetEvidence(input),
  };
  let manifest: PluginManifestData | null = null;
  if (shape.status === "pass") {
    const parsed = manifestStage(input);
    stages.push(parsed.stage);
    manifest = parsed.manifest;
  } else {
    stages.push(unavailableStage("manifest-schema", "Package shape did not pass."));
  }
  let dependencies: PluginDependencyEvidence[] = [];
  if (shape.status === "pass" && stageById(stages, "manifest-schema").status === "pass") {
    const result = dependencyStage(input);
    stages.push(result.stage);
    dependencies = result.dependencies;
  } else {
    stages.push(
      unavailableStage("dependency-model", "Manifest and package shape evidence is unavailable."),
    );
  }
  if (manifest) {
    stages.push(minimumPlatformStage(manifest, options));
  } else {
    stages.push(unavailableStage("minimum-app-platform", "Manifest evidence is unavailable."));
  }
  let staticAuthority: PluginCapabilityReport | null = null;
  if (shape.status === "pass") {
    const stage = new StageBuilder("static-authority");
    stage.addEvidence("input/main.js", "analysis/static-authority.json");
    try {
      staticAuthority = scanPluginCapabilities(input.assets.main);
      stage.addLimitation(
        "The static capability report records observed authority classes only; it is not a sandbox and does not prove safety.",
      );
      stages.push(stage.finish("pass"));
    } catch {
      stage.addDiagnostic(
        diagnostic(
          "static-scan-failed",
          "error",
          "Static authority scanning failed before producing a report.",
          "analysis/static-authority.json",
        ),
      );
      stages.push(stage.finish("fail"));
    }
  } else {
    stages.push(unavailableStage("static-authority", "Package shape did not pass."));
  }
  let primitives: PluginPrimitiveEvidence[] = [];
  if (shape.status === "pass") {
    const result = primitiveStage(input);
    stages.push(result.stage);
    primitives = result.primitives;
  } else {
    stages.push(unavailableStage("banned-private-primitives", "Package shape did not pass."));
  }
  const prerequisiteFailure = stages.some(
    (stage) =>
      [
        "package-shape",
        "manifest-schema",
        "dependency-model",
        "minimum-app-platform",
        "static-authority",
        "banned-private-primitives",
      ].includes(stage.id) && stage.status !== "pass",
  );
  let registrations: PluginRegistrationSnapshot | null = null;
  let vaultDiff: PluginVaultDiff | null = null;
  let materialized: MaterializedPackage | null = null;
  let runtimeRun: RuntimeRun | null = null;
  const hasNetworkAuthority = staticAuthority?.capabilities.includes("network") === true;
  const hasDeterministicNetworkRuntime =
    options.networkMode === "deterministic-fixture" && options.runtimeFactory !== undefined;
  const activationAllowed =
    !prerequisiteFailure &&
    staticAuthority !== null &&
    (!hasNetworkAuthority || hasDeterministicNetworkRuntime);
  if (activationAllowed) {
    materialized = await materializePackage(input);
    try {
      runtimeRun = await runTrustedRuntime(input, materialized, options);
      const activationStage = new StageBuilder("activation");
      activationStage.addEvidence("runtime/activation.json", "runtime/disposable-vault.json");
      if (hasNetworkAuthority) {
        activationStage.addLimitation(
          "Network authority was exercised only through the caller-supplied deterministic fixture runtime; this inspector does not prove that a production host enforces network denial.",
        );
      }
      if (runtimeRun.timedOut) {
        activationStage.addDiagnostic(
          diagnostic(
            "activation-timeout",
            "error",
            "Trusted compatibility activation exceeded its bounded deadline.",
            "runtime/activation.json",
          ),
        );
        stages.push(activationStage.finish("fail"));
      } else if (!runtimeRun.activationSnapshot) {
        activationStage.addDiagnostic(
          diagnostic(
            runtimeRun.activationError ? "activation-crash" : "activation-failed",
            "error",
            runtimeRun.activationError
              ? "Trusted compatibility runtime crashed or rejected the exact package during activation."
              : "Trusted compatibility activation failed without a snapshot.",
            "runtime/activation.json",
          ),
        );
        stages.push(activationStage.finish("fail"));
      } else {
        const summary = runtimeRun.activationSnapshot.plugin;
        if (summary?.state !== "loaded" || summary.error) {
          activationStage.addDiagnostic(
            diagnostic(
              runtimeRun.activationError ? "activation-crash" : "activation-not-loaded",
              "error",
              runtimeRun.activationError
                ? "Trusted compatibility runtime crashed or rejected the exact package during activation."
                : "Trusted compatibility runtime did not report a loaded plugin.",
              "runtime/activation.json",
            ),
          );
          stages.push(activationStage.finish("fail"));
        } else {
          stages.push(activationStage.finish("pass"));
        }
        registrations = registrationSnapshot(runtimeRun.activationSnapshot);
      }
      vaultDiff = runtimeRun.vaultDiff;
      const registrationStage = new StageBuilder("registration-snapshot");
      registrationStage.addEvidence("runtime/registration-snapshot.json");
      if (registrations && stages.at(-1)?.status === "pass") {
        registrationStage.addLimitation(
          "Registration names and counts come from the trusted compatibility runtime; they do not prove workflow correctness for every command or view.",
        );
        registrationStage.addLimitation(
          "Plugin-provided registration labels are bounded and scrub obvious path or secret shapes; arbitrary sensitive text embedded in a short label is outside static redaction coverage.",
        );
        stages.push(registrationStage.finish("pass"));
      } else {
        registrationStage.addDiagnostic(
          diagnostic(
            "registration-unavailable",
            "error",
            "Registration inventory was unavailable because activation did not complete.",
            "runtime/registration-snapshot.json",
          ),
        );
        stages.push(registrationStage.finish("blocked"));
      }
    } finally {
      if (materialized) {
        await fs.rm(materialized.rootPath, { recursive: true, force: true });
      }
    }
  } else {
    const reason = hasNetworkAuthority
      ? hasDeterministicNetworkRuntime
        ? "Static prerequisites did not pass."
        : options.networkMode === "denied"
          ? "Network-capable packages are blocked when network access is denied."
          : "A caller-supplied deterministic fixture runtime is required for network-capable packages."
      : "Static prerequisites did not pass.";
    stages.push(unavailableStage("activation", reason));
    stages.push(unavailableStage("registration-snapshot", "Activation did not run."));
  }
  const cleanupStage = new StageBuilder("cleanup");
  cleanupStage.addEvidence("runtime/cleanup.json", "runtime/disposable-vault.json");
  const cleanupSnapshot = runtimeRun?.cleanupSnapshot;
  const cleanupFailure =
    !runtimeRun ||
    runtimeRun.timedOut ||
    !cleanupSnapshot ||
    runtimeRun.globalMutationDetected ||
    runtimeRun.vaultDiff.outsideBoundaryCount > 0 ||
    runtimeRun.cleanupError !== null ||
    cleanupSnapshot.commands.length > 0 ||
    cleanupSnapshot.plugins?.some(
      (plugin) => plugin.state === "loaded" || plugin.error !== null,
    ) === true;
  if (runtimeRun?.globalMutationDetected) {
    cleanupStage.addDiagnostic(
      diagnostic(
        "global-mutation",
        "error",
        "Trusted compatibility execution changed the host global namespace.",
        "runtime/cleanup.json",
      ),
    );
  }
  if ((runtimeRun?.vaultDiff.outsideBoundaryCount ?? 0) > 0) {
    cleanupStage.addDiagnostic(
      diagnostic(
        "outside-boundary-write",
        "error",
        "Trusted compatibility execution changed files outside the disposable vault boundary.",
        "runtime/disposable-vault.json",
      ),
    );
  }
  if (runtimeRun?.cleanupError && !runtimeRun.timedOut) {
    cleanupStage.addDiagnostic(
      diagnostic(
        "teardown-failure",
        "error",
        "Trusted compatibility cleanup raised an error before the disposable runtime closed.",
        "runtime/cleanup.json",
      ),
    );
  }
  if (
    vaultDiff &&
    (vaultDiff.changedFileCount > 0 ||
      vaultDiff.createdFileCount > 0 ||
      vaultDiff.removedFileCount > 0)
  ) {
    cleanupStage.addLimitation(
      "Disposable vault writes are reported as counts and are not proof that a real user vault would remain unchanged.",
    );
  }
  cleanupStage.addLimitation(
    "The disposable diff observes files inside the temporary inspection root; writes to unrelated host paths are outside this report and require a process-backed sandbox to constrain.",
  );
  if (
    runtimeRun &&
    cleanupFailure &&
    !runtimeRun.globalMutationDetected &&
    !runtimeRun.cleanupError
  ) {
    cleanupStage.addDiagnostic(
      diagnostic(
        runtimeRun?.timedOut ? "cleanup-timeout" : "teardown-failure",
        "error",
        runtimeRun?.timedOut
          ? "Trusted compatibility cleanup exceeded its bounded deadline."
          : "Trusted compatibility runtime did not release all plugin-owned state cleanly.",
        "runtime/cleanup.json",
      ),
    );
  }
  stages.push(cleanupStage.finish(!runtimeRun ? "blocked" : cleanupFailure ? "fail" : "pass"));
  const timeoutStage = new StageBuilder("timeout");
  timeoutStage.addEvidence("runtime/activation.json", "runtime/cleanup.json");
  if (runtimeRun?.timedOut) {
    timeoutStage.addDiagnostic(
      diagnostic(
        "operation-timeout",
        "error",
        "At least one trusted runtime operation exceeded the configured timeout.",
        "runtime/activation.json",
      ),
    );
    stages.push(timeoutStage.finish("fail"));
  } else if (runtimeRun) {
    timeoutStage.addLimitation(
      "The trusted compatibility host cannot interrupt synchronous JavaScript in this process; process-backed hosts are required for hard kill coverage.",
    );
    stages.push(timeoutStage.finish("pass"));
  } else {
    stages.push(unavailableStage("timeout", "Activation did not run."));
  }
  const orderedStages = pluginPackageInspectionStageIds.map((id) => stageById(stages, id));
  const requiredStages = orderedStages.map((stage) => stage.status);
  const overall: InspectionOverallStatus = requiredStages.every((status) => status === "pass")
    ? "pass"
    : requiredStages.some((status) => status === "fail")
      ? "fail"
      : "blocked";
  const limitations = [
    "Static inspection and trusted compatibility execution are review evidence, not a sandbox or proof of safety.",
    "No live release network request is made by this offline inspection pipeline.",
    ...orderedStages.flatMap((stage) => stage.limitations),
  ].filter((value, index, values) => values.indexOf(value) === index);
  const reportWithoutCandidate: Omit<PluginPackageInspectionReport, "candidate"> = {
    schemaVersion: pluginPackageInspectionSchemaVersion,
    tool: {
      id: "threadleaf-plugin-package-inspector",
      version: pluginPackageInspectionToolVersion,
    },
    overall,
    input: inputEvidence,
    manifest: manifest
      ? {
          id: manifest.id,
          version: manifest.version,
          minAppVersion: manifest.minAppVersion,
          isDesktopOnly: manifest.isDesktopOnly,
        }
      : null,
    staticAuthority,
    dependencies,
    primitives,
    registrations,
    vaultDiff,
    stages: orderedStages,
    limitations,
  };
  return {
    ...reportWithoutCandidate,
    candidate: buildCandidate(input, reportWithoutCandidate),
  };
}

/** Convert a source adapter package to the exact input accepted by the inspector. */
export function exactInputFromPackage(value: {
  assets: Array<{
    filename: "manifest.json" | "main.js" | "styles.css";
    bytes: Uint8Array;
    sha256: string;
  }>;
  manifest: PluginManifestData;
  repository: string;
  releaseUrl: string;
  indexUrl: string;
  indexSha256: string;
  license?: unknown;
}): ExactPluginPackageInput {
  const byName = new Map(value.assets.map((asset) => [asset.filename, asset]));
  const manifestAsset = byName.get("manifest.json");
  const mainAsset = byName.get("main.js");
  if (!manifestAsset || !mainAsset) {
    throw new Error("Exact package conversion requires manifest.json and main.js assets.");
  }
  const stylesAsset = byName.get("styles.css");
  return {
    assets: {
      manifest: cloneBytes(manifestAsset.bytes),
      main: cloneBytes(mainAsset.bytes),
      styles: stylesAsset ? cloneBytes(stylesAsset.bytes) : null,
    },
    hashes: {
      manifestSha256: manifestAsset.sha256,
      mainSha256: mainAsset.sha256,
      stylesSha256: stylesAsset?.sha256 ?? null,
    },
    provenance: {
      kind: "release",
      pluginId: value.manifest.id,
      version: value.manifest.version,
      releaseTag: value.manifest.version,
      sourceUrl: value.repository,
      releaseUrl: value.releaseUrl,
      indexUrl: value.indexUrl,
      indexSha256: value.indexSha256,
    },
    entries: [
      { path: "manifest.json", kind: "file" },
      { path: "main.js", kind: "file" },
      ...(stylesAsset ? [{ path: "styles.css", kind: "file" as const }] : []),
    ],
  };
}

/** Convert a fixture/local package directory without retaining its absolute path in evidence. */
export async function exactInputFromDirectory(
  directoryPath: string,
  provenance: Omit<PluginPackageProvenance, "pluginId" | "version" | "releaseTag"> &
    Partial<Pick<PluginPackageProvenance, "pluginId" | "version" | "releaseTag">>,
): Promise<ExactPluginPackageInput> {
  const directoryEntries = await fs.readdir(directoryPath, { withFileTypes: true });
  const entries: PluginPackageEntry[] = directoryEntries.map((entry) => ({
    path: entry.name,
    kind: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "symlink",
  }));
  const requiredNames = ["manifest.json", "main.js"] as const;
  for (const filename of requiredNames) {
    const entry = directoryEntries.find((candidate) => candidate.name === filename);
    if (!entry?.isFile()) {
      throw new Error("Exact package assets must be present as regular files.");
    }
  }
  const manifest = await fs.readFile(path.join(directoryPath, "manifest.json"));
  const main = await fs.readFile(path.join(directoryPath, "main.js"));
  let styles: Buffer | null = null;
  try {
    const stylesEntry = directoryEntries.find((candidate) => candidate.name === "styles.css");
    if (stylesEntry && !stylesEntry.isFile()) {
      throw new Error("Exact package stylesheet must be a regular file.");
    }
    if (stylesEntry) {
      styles = await fs.readFile(path.join(directoryPath, "styles.css"));
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  const parsed = parsePluginManifest(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifest)),
  );
  const pluginId = provenance.pluginId ?? parsed.id;
  const version = provenance.version ?? parsed.version;
  return {
    assets: { manifest, main, styles },
    hashes: {
      manifestSha256: sha256(manifest),
      mainSha256: sha256(main),
      stylesSha256: styles ? sha256(styles) : null,
    },
    provenance: {
      kind: provenance.kind,
      pluginId,
      version,
      releaseTag: provenance.releaseTag ?? version,
      sourceUrl: provenance.sourceUrl,
      releaseUrl: provenance.releaseUrl,
      indexUrl: provenance.indexUrl,
      indexSha256: provenance.indexSha256,
    },
    entries,
  };
}

export function candidateFromInspection(
  report: PluginPackageInspectionReport,
): PluginPackageRegistryCandidate {
  if (!report.candidate || report.overall !== "pass") {
    const failed = report.stages
      .filter((stage) => stage.status !== "pass")
      .map((stage) => `${stage.id}:${stage.status}`)
      .join(", ");
    throw new Error(
      `Registry candidate requires every exact-package inspection gate to pass${failed ? ` (${failed})` : ""}.`,
    );
  }
  return structuredClone(report.candidate);
}

/**
 * Retain only the exact package authority needed by review, apply, and enablement. The receipt
 * deliberately carries the inspector's Level 3 ceiling and its static-inspection limitations.
 */
export function inspectionReceiptFromReport(
  report: PluginPackageInspectionReport,
): PluginPackageInspectionReceipt {
  if (!report.staticAuthority) {
    throw new Error("A package inspection receipt requires a static authority report.");
  }
  const candidate = report.candidate && report.overall === "pass" ? report.candidate : null;
  const asset = (filename: PluginPackageAssetEvidence["filename"]): PluginPackageAssetEvidence => {
    const evidence = report.input.assets.find((item) => item.filename === filename);
    if (!evidence) {
      throw new Error(`A package inspection receipt requires ${filename} evidence.`);
    }
    return evidence;
  };
  const main = asset("main.js");
  const manifest = asset("manifest.json");
  const styles = report.input.assets.find((item) => item.filename === "styles.css") ?? null;
  const overall = candidate ? "pass" : report.overall === "pass" ? "fail" : report.overall;
  const limitations = candidate
    ? candidate.limitations
    : [
        `Exact-package inspection did not pass all required gates (${overall}); no compatibility level is claimed.`,
        ...report.limitations,
        ...report.stages
          .filter((stage) => stage.status !== "pass")
          .map((stage) => `Inspection stage ${stage.id} did not pass.`),
      ];
  return parsePluginPackageInspectionReceipt({
    schemaVersion: 1,
    tool: report.tool,
    overall,
    exactPackage: candidate?.exactPackage ?? {
      id: report.input.pluginId,
      version: report.input.version,
      bundleSha256: main.sha256,
      manifestSha256: manifest.sha256,
      stylesSha256: styles?.sha256 ?? null,
      provenance: report.input.provenance,
    },
    assets: report.input.assets,
    staticAuthority: report.staticAuthority,
    compatibilityLevel: candidate?.compatibilityLevel ?? 0,
    limitations,
  });
}

/** Write a candidate only after the caller has an all-gates-passed inspection report. */
export async function writePluginPackageRegistryCandidate(
  report: PluginPackageInspectionReport,
  outputPath: string,
): Promise<PluginPackageRegistryCandidate> {
  const candidate = candidateFromInspection(report);
  await fs.writeFile(outputPath, `${JSON.stringify(candidate, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return candidate;
}
