import { type Dirent, promises as fs } from "node:fs";
import path from "node:path";
import {
  createPluginCompatibilityReport,
  maxPluginBundleBytes,
  type PluginCatalogSnapshot,
  type PluginPackageSummary,
  parsePluginId,
  parsePluginManifest,
  parseVaultPluginSettings,
  pluginCapabilityGrantState,
  type VaultPluginSettings,
} from "../shared/plugins";
import { scanPluginCapabilities } from "./plugin-capability-scanner";
import { validateAppearanceCss } from "./vault-appearance-loader";

const maxManifestBytes = 64 * 1024;
const maxPluginStylesheetBytes = 2 * 1024 * 1024;
const maxCombinedPluginCssBytes = 4 * 1024 * 1024;
const maxCatalogEntries = 256;
const decoder = new TextDecoder("utf-8", { fatal: true });
const blockedAssetUrl =
  'url("data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==")';

export interface DiscoveredVaultPlugin {
  summary: PluginPackageSummary;
  directoryPath: string;
  mainPath: string | null;
  stylesheetPath: string | null;
}

export interface VaultPluginDiscovery {
  plugins: DiscoveredVaultPlugin[];
  warnings: string[];
}

interface VaultPluginLoaderOptions {
  vaultPath: string;
  vaultId: string;
  preference: VaultPluginSettings;
  safeMode: boolean;
  blockedPluginIds?: ReadonlySet<string>;
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isContained(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function canonicalContainedPath(rootPath: string, candidatePath: string): Promise<string> {
  const [canonicalRoot, canonicalCandidate] = await Promise.all([
    fs.realpath(rootPath),
    fs.realpath(candidatePath),
  ]);
  if (!isContained(canonicalRoot, canonicalCandidate)) {
    throw new Error("path resolves outside the vault plugin directory");
  }
  return canonicalCandidate;
}

async function readBoundedBytes(filePath: string, maxBytes: number): Promise<Buffer> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error("not a regular file");
  }
  if (stat.size > maxBytes) {
    throw new Error(`file exceeds the ${formatByteLimit(maxBytes)} limit`);
  }
  const bytes = await fs.readFile(filePath);
  if (bytes.byteLength > maxBytes) {
    throw new Error("file grew beyond its size limit while reading");
  }
  return bytes;
}

async function readBoundedText(filePath: string, maxBytes: number): Promise<string> {
  return decoder.decode(await readBoundedBytes(filePath, maxBytes));
}

function formatByteLimit(maxBytes: number): string {
  return maxBytes < 1024 * 1024
    ? `${Math.floor(maxBytes / 1024)} KiB`
    : `${Math.floor(maxBytes / (1024 * 1024))} MiB`;
}

function isCssNameCharacter(character: string | undefined): boolean {
  return character !== undefined && /[\w-]/u.test(character);
}

function cssUrlEnd(css: string, openIndex: number): number | null {
  let depth = 1;
  let quote: '"' | "'" | null = null;
  for (let index = openIndex + 1; index < css.length; index += 1) {
    const character = css[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return null;
}

function cssUrlTarget(css: string, openIndex: number, closeIndex: number): string {
  const raw = css.slice(openIndex + 1, closeIndex).trim();
  if (
    raw.length >= 2 &&
    ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
  ) {
    return raw.slice(1, -1).trim();
  }
  return raw;
}

function isEmbeddedCssUrl(target: string): boolean {
  const normalized = target.toLocaleLowerCase("en-US");
  return normalized.startsWith("data:") || target.startsWith("#") || normalized.startsWith("var(");
}

function neutralizeExternalCssUrls(css: string): { css: string; blockedCount: number } {
  const replacements: Array<{ start: number; end: number }> = [];
  let index = 0;
  while (index < css.length) {
    if (css.startsWith("/*", index)) {
      const commentEnd = css.indexOf("*/", index + 2);
      index = commentEnd === -1 ? css.length : commentEnd + 2;
      continue;
    }
    if (css[index] === '"' || css[index] === "'") {
      const quote = css[index];
      index += 1;
      while (index < css.length) {
        if (css[index] === "\\") {
          index += 2;
          continue;
        }
        const character = css[index];
        index += 1;
        if (character === quote) {
          break;
        }
      }
      continue;
    }
    if (
      css.slice(index, index + 3).toLocaleLowerCase("en-US") !== "url" ||
      isCssNameCharacter(css[index - 1]) ||
      isCssNameCharacter(css[index + 3])
    ) {
      index += 1;
      continue;
    }
    let openIndex = index + 3;
    while (/\s/u.test(css[openIndex] ?? "")) {
      openIndex += 1;
    }
    if (css[openIndex] !== "(") {
      index += 3;
      continue;
    }
    const closeIndex = cssUrlEnd(css, openIndex);
    if (closeIndex === null) {
      break;
    }
    if (!isEmbeddedCssUrl(cssUrlTarget(css, openIndex, closeIndex))) {
      replacements.push({ start: index, end: closeIndex + 1 });
    }
    index = closeIndex + 1;
  }

  if (replacements.length === 0) {
    return { css, blockedCount: 0 };
  }
  let rewritten = "";
  let cursor = 0;
  for (const replacement of replacements) {
    rewritten += css.slice(cursor, replacement.start);
    rewritten += blockedAssetUrl;
    cursor = replacement.end;
  }
  rewritten += css.slice(cursor);
  return { css: rewritten, blockedCount: replacements.length };
}

function invalidSummary(folderId: string, message: string): PluginPackageSummary {
  return {
    id: folderId,
    name: folderId,
    version: "unknown",
    minAppVersion: null,
    description: null,
    author: null,
    authorUrl: null,
    isDesktopOnly: false,
    source: "obsidian-vault",
    packageState: "invalid",
    stylesheetDiscovered: false,
    compatibility: {
      level: 0,
      status: "unverified",
      testedVersion: null,
      testedThreadleafVersion: null,
      lastTested: null,
      summary: "Package validation failed before a compatibility workflow could run.",
    },
    capabilityReport: null,
    capabilityGrantState: "unavailable",
    error: message,
  };
}

async function optionalContainedFile(
  directoryPath: string,
  filename: string,
  maxBytes: number,
): Promise<string | null> {
  const candidate = path.join(directoryPath, filename);
  try {
    const contained = await canonicalContainedPath(directoryPath, candidate);
    const stat = await fs.stat(contained);
    if (!stat.isFile()) {
      throw new Error(`${filename} is not a regular file`);
    }
    if (stat.size > maxBytes) {
      throw new Error(`${filename} exceeds the ${formatByteLimit(maxBytes)} limit`);
    }
    return contained;
  } catch (error) {
    if (new Set(["ENOENT", "ENOTDIR"]).has(errorCode(error) ?? "")) {
      return null;
    }
    throw error;
  }
}

async function inspectPlugin(
  pluginRoot: string,
  entry: Dirent<string>,
): Promise<DiscoveredVaultPlugin> {
  const folderId = parsePluginId(entry.name);
  let directoryPath = path.join(pluginRoot, entry.name);
  try {
    directoryPath = await canonicalContainedPath(pluginRoot, directoryPath);
    const manifestPath = await canonicalContainedPath(
      directoryPath,
      path.join(directoryPath, "manifest.json"),
    );
    const manifest = parsePluginManifest(
      JSON.parse(await readBoundedText(manifestPath, maxManifestBytes)),
    );
    if (manifest.id !== folderId) {
      throw new Error(`manifest id ${manifest.id} does not match folder ${folderId}`);
    }
    const mainPath = await optionalContainedFile(directoryPath, "main.js", maxPluginBundleBytes);
    if (!mainPath) {
      throw new Error("main.js is missing");
    }
    const capabilityReport = scanPluginCapabilities(
      await readBoundedBytes(mainPath, maxPluginBundleBytes),
    );
    const stylesheetPath = await optionalContainedFile(
      directoryPath,
      "styles.css",
      maxPluginStylesheetBytes,
    );
    return {
      summary: {
        ...manifest,
        source: "obsidian-vault",
        packageState: "ready",
        stylesheetDiscovered: stylesheetPath !== null,
        compatibility: createPluginCompatibilityReport(manifest),
        capabilityReport,
        capabilityGrantState: "required",
        error: null,
      },
      directoryPath,
      mainPath,
      stylesheetPath,
    };
  } catch (error) {
    const message = errorMessage(error);
    return {
      summary: invalidSummary(folderId, message),
      directoryPath,
      mainPath: null,
      stylesheetPath: null,
    };
  }
}

export async function discoverVaultPlugins(vaultPath: string): Promise<VaultPluginDiscovery> {
  const pluginsPath = path.join(vaultPath, ".obsidian", "plugins");
  let canonicalPluginsPath: string;
  let entries: Dirent<string>[];
  try {
    canonicalPluginsPath = await canonicalContainedPath(vaultPath, pluginsPath);
    entries = await fs.readdir(canonicalPluginsPath, { withFileTypes: true });
  } catch (error) {
    if (new Set(["ENOENT", "ENOTDIR"]).has(errorCode(error) ?? "")) {
      return { plugins: [], warnings: [] };
    }
    return {
      plugins: [],
      warnings: [`Could not inspect .obsidian/plugins: ${errorMessage(error)}`],
    };
  }

  const plugins: DiscoveredVaultPlugin[] = [];
  const warnings: string[] = [];
  for (const entry of entries
    .filter(
      (candidate) =>
        !candidate.name.startsWith(".threadleaf-package-") &&
        (candidate.isDirectory() || candidate.isSymbolicLink()),
    )
    .sort((left, right) => left.name.localeCompare(right.name, "en-US", { numeric: true }))) {
    if (plugins.length >= maxCatalogEntries) {
      warnings.push(`Only the first ${maxCatalogEntries} installed plugins are shown.`);
      break;
    }
    try {
      const plugin = await inspectPlugin(canonicalPluginsPath, entry);
      plugins.push(plugin);
      if (plugin.summary.error) {
        warnings.push(`Plugin ${plugin.summary.id} is invalid: ${plugin.summary.error}`);
      }
    } catch (error) {
      warnings.push(`An invalid plugin folder was skipped: ${errorMessage(error)}`);
    }
  }
  return { plugins, warnings };
}

export async function loadVaultPluginCatalog(
  options: VaultPluginLoaderOptions,
): Promise<PluginCatalogSnapshot> {
  const preference = parseVaultPluginSettings(options.preference);
  const discovery = await discoverVaultPlugins(options.vaultPath);
  const warnings = [...discovery.warnings];
  const packagesById = new Map(discovery.plugins.map((plugin) => [plugin.summary.id, plugin]));
  const cssParts: string[] = [];
  let cssBytes = 0;

  if (options.safeMode) {
    warnings.unshift("Plugin safe mode is active. Saved compatibility plugins were not loaded.");
  }

  for (const pluginId of options.blockedPluginIds ?? []) {
    const plugin = packagesById.get(pluginId);
    if (!plugin) {
      continue;
    }
    plugin.summary = {
      ...plugin.summary,
      packageState: "invalid",
      error: "Threadleaf-managed package bytes changed after their recorded SHA-256 review.",
    };
    warnings.push(
      `Managed plugin ${pluginId} changed after installation and was blocked until reviewed again.`,
    );
  }

  for (const plugin of discovery.plugins) {
    plugin.summary = {
      ...plugin.summary,
      capabilityGrantState:
        plugin.summary.packageState === "ready"
          ? pluginCapabilityGrantState(
              plugin.summary.capabilityReport,
              preference.capabilityGrantsByPlugin[plugin.summary.id],
            )
          : "unavailable",
    };
  }

  for (const pluginId of preference.enabledPluginIds) {
    const plugin = packagesById.get(pluginId);
    if (!plugin) {
      warnings.push(`Enabled plugin ${pluginId} is not installed in this vault.`);
      continue;
    }
    if (plugin.summary.packageState !== "ready") {
      warnings.push(`Enabled plugin ${pluginId} has an invalid package and was not loaded.`);
      continue;
    }
    if (plugin.summary.capabilityGrantState !== "granted") {
      warnings.push(
        `Enabled plugin ${pluginId} was blocked because its exact bundle authority review is ${plugin.summary.capabilityGrantState === "stale" ? "stale" : "missing"}.`,
      );
      continue;
    }
    if (
      options.safeMode ||
      preference.compatibilityMode === "restricted" ||
      !plugin.stylesheetPath
    ) {
      continue;
    }
    try {
      const sanitized = neutralizeExternalCssUrls(
        await readBoundedText(plugin.stylesheetPath, maxPluginStylesheetBytes),
      );
      const css = validateAppearanceCss(sanitized.css);
      const bytes = Buffer.byteLength(css, "utf8");
      if (cssBytes + bytes > maxCombinedPluginCssBytes) {
        throw new Error("enabled plugin CSS exceeds the combined 4 MiB limit");
      }
      cssBytes += bytes;
      cssParts.push(`/* Threadleaf compatibility plugin: ${pluginId} */\n${css}`);
      if (sanitized.blockedCount > 0) {
        warnings.push(
          `Plugin ${pluginId} stylesheet was applied with ${sanitized.blockedCount} external asset URL${sanitized.blockedCount === 1 ? "" : "s"} blocked.`,
        );
      }
    } catch (error) {
      warnings.push(`Plugin ${pluginId} stylesheet was not applied: ${errorMessage(error)}`);
    }
  }

  return {
    vaultId: options.vaultId,
    preference,
    safeMode: options.safeMode,
    plugins: discovery.plugins.map(({ summary }) => summary),
    managedPackages: [],
    warnings,
    css: cssParts.join("\n\n"),
  };
}
