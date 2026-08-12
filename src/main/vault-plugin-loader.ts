import { type Dirent, promises as fs } from "node:fs";
import path from "node:path";
import {
  maxPluginBundleBytes,
  type PluginCatalogSnapshot,
  type PluginPackageSummary,
  parsePluginId,
  parsePluginManifest,
  parseVaultPluginSettings,
  type VaultPluginSettings,
} from "../shared/plugins";
import { validateAppearanceCss } from "./vault-appearance-loader";

const maxManifestBytes = 64 * 1024;
const maxPluginStylesheetBytes = 2 * 1024 * 1024;
const maxCombinedPluginCssBytes = 4 * 1024 * 1024;
const maxCatalogEntries = 256;
const decoder = new TextDecoder("utf-8", { fatal: true });

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

async function readBoundedText(filePath: string, maxBytes: number): Promise<string> {
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
  return decoder.decode(bytes);
}

function formatByteLimit(maxBytes: number): string {
  return maxBytes < 1024 * 1024
    ? `${Math.floor(maxBytes / 1024)} KiB`
    : `${Math.floor(maxBytes / (1024 * 1024))} MiB`;
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
    .filter((candidate) => candidate.isDirectory() || candidate.isSymbolicLink())
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
    if (
      options.safeMode ||
      preference.compatibilityMode === "restricted" ||
      !plugin.stylesheetPath
    ) {
      continue;
    }
    try {
      const css = validateAppearanceCss(
        await readBoundedText(plugin.stylesheetPath, maxPluginStylesheetBytes),
      );
      const bytes = Buffer.byteLength(css, "utf8");
      if (cssBytes + bytes > maxCombinedPluginCssBytes) {
        throw new Error("enabled plugin CSS exceeds the combined 4 MiB limit");
      }
      cssBytes += bytes;
      cssParts.push(`/* Threadleaf compatibility plugin: ${pluginId} */\n${css}`);
    } catch (error) {
      warnings.push(`Plugin ${pluginId} stylesheet was not applied: ${errorMessage(error)}`);
    }
  }

  return {
    vaultId: options.vaultId,
    preference,
    safeMode: options.safeMode,
    plugins: discovery.plugins.map(({ summary }) => summary),
    warnings,
    css: cssParts.join("\n\n"),
  };
}
