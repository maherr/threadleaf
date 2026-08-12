import { type Dirent, promises as fs } from "node:fs";
import path from "node:path";
import type {
  AppearanceSnapshot,
  AppearanceSnippetSummary,
  AppearanceThemeSummary,
  VaultAppearanceSettings,
} from "../shared/appearance";
import { parseVaultAppearanceSettings } from "../shared/appearance";

const maxThemeBytes = 2 * 1024 * 1024;
const maxSnippetBytes = 512 * 1024;
const maxManifestBytes = 64 * 1024;
const maxCombinedCssBytes = 4 * 1024 * 1024;
const maxCatalogEntries = 256;
const decoder = new TextDecoder("utf-8", { fatal: true });

interface ThemeCandidate {
  summary: AppearanceThemeSummary;
  cssPath: string;
}

interface SnippetCandidate {
  summary: AppearanceSnippetSummary;
  cssPath: string;
}

interface VaultAppearanceLoaderOptions {
  vaultPath: string;
  vaultId: string;
  preference: VaultAppearanceSettings;
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

function oneLine(value: string, fallback: string): string {
  const normalized = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.slice(0, 200) || fallback;
}

function assetId(kind: "theme" | "snippet", name: string): string | null {
  const id = `obsidian-${kind}:${encodeURIComponent(name)}`;
  return id.length <= 1040 ? id : null;
}

async function canonicalContainedPath(rootPath: string, candidatePath: string): Promise<string> {
  const [canonicalRoot, canonicalCandidate] = await Promise.all([
    fs.realpath(rootPath),
    fs.realpath(candidatePath),
  ]);
  if (!isContained(canonicalRoot, canonicalCandidate)) {
    throw new Error("path resolves outside its appearance directory");
  }
  return canonicalCandidate;
}

async function readBoundedText(filePath: string, maxBytes: number): Promise<string> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error("not a regular file");
  }
  if (stat.size > maxBytes) {
    throw new Error(`file exceeds the ${Math.floor(maxBytes / 1024)} KiB limit`);
  }
  const bytes = await fs.readFile(filePath);
  if (bytes.byteLength > maxBytes) {
    throw new Error(`file grew beyond the ${Math.floor(maxBytes / 1024)} KiB limit while reading`);
  }
  return decoder.decode(bytes);
}

function optionalManifestField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? oneLine(value, "") : null;
}

async function readThemeManifest(
  themeDirectory: string,
  folderName: string,
  warnings: string[],
): Promise<{ name: string; version: string | null; author: string | null }> {
  const manifestPath = path.join(themeDirectory, "manifest.json");
  try {
    const containedPath = await canonicalContainedPath(themeDirectory, manifestPath);
    const parsed: unknown = JSON.parse(await readBoundedText(containedPath, maxManifestBytes));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("manifest root is not an object");
    }
    const manifest = parsed as Record<string, unknown>;
    return {
      name: typeof manifest.name === "string" ? oneLine(manifest.name, folderName) : folderName,
      version: optionalManifestField(manifest.version),
      author: optionalManifestField(manifest.author),
    };
  } catch (error) {
    if (!new Set(["ENOENT", "ENOTDIR"]).has(errorCode(error) ?? "")) {
      warnings.push(`Theme ${folderName} has an unreadable manifest: ${errorMessage(error)}`);
    }
    return { name: folderName, version: null, author: null };
  }
}

async function discoverThemes(vaultPath: string, warnings: string[]): Promise<ThemeCandidate[]> {
  const themesPath = path.join(vaultPath, ".obsidian", "themes");
  let canonicalThemesPath: string;
  let entries: Dirent<string>[];
  try {
    canonicalThemesPath = await canonicalContainedPath(vaultPath, themesPath);
    entries = await fs.readdir(canonicalThemesPath, { withFileTypes: true });
  } catch (error) {
    if (new Set(["ENOENT", "ENOTDIR"]).has(errorCode(error) ?? "")) {
      return [];
    }
    warnings.push(`Could not inspect .obsidian/themes: ${errorMessage(error)}`);
    return [];
  }

  const candidates: ThemeCandidate[] = [];
  for (const entry of entries
    .filter((candidate) => candidate.isDirectory() || candidate.isSymbolicLink())
    .sort((left, right) => left.name.localeCompare(right.name, "en-US", { numeric: true }))) {
    if (candidates.length >= maxCatalogEntries) {
      warnings.push(`Only the first ${maxCatalogEntries} vault themes are shown.`);
      break;
    }
    const id = assetId("theme", entry.name);
    if (!id) {
      warnings.push("A theme with an unusually long folder name was skipped.");
      continue;
    }
    try {
      const themeDirectory = await canonicalContainedPath(
        canonicalThemesPath,
        path.join(canonicalThemesPath, entry.name),
      );
      const cssPath = await canonicalContainedPath(
        themeDirectory,
        path.join(themeDirectory, "theme.css"),
      );
      const stat = await fs.stat(cssPath);
      if (!stat.isFile() || stat.size > maxThemeBytes) {
        throw new Error(
          stat.isFile()
            ? `theme.css exceeds the ${Math.floor(maxThemeBytes / 1024)} KiB limit`
            : "theme.css is not a regular file",
        );
      }
      const manifest = await readThemeManifest(themeDirectory, entry.name, warnings);
      candidates.push({
        summary: {
          id,
          name: manifest.name,
          version: manifest.version,
          author: manifest.author,
          source: "obsidian-vault",
        },
        cssPath,
      });
    } catch (error) {
      warnings.push(`Theme ${oneLine(entry.name, "Unnamed")} was skipped: ${errorMessage(error)}`);
    }
  }
  return candidates;
}

async function discoverSnippets(
  vaultPath: string,
  warnings: string[],
): Promise<SnippetCandidate[]> {
  const snippetsPath = path.join(vaultPath, ".obsidian", "snippets");
  let canonicalSnippetsPath: string;
  let entries: Dirent<string>[];
  try {
    canonicalSnippetsPath = await canonicalContainedPath(vaultPath, snippetsPath);
    entries = await fs.readdir(canonicalSnippetsPath, { withFileTypes: true });
  } catch (error) {
    if (new Set(["ENOENT", "ENOTDIR"]).has(errorCode(error) ?? "")) {
      return [];
    }
    warnings.push(`Could not inspect .obsidian/snippets: ${errorMessage(error)}`);
    return [];
  }

  const candidates: SnippetCandidate[] = [];
  for (const entry of entries
    .filter(
      (candidate) =>
        (candidate.isFile() || candidate.isSymbolicLink()) &&
        candidate.name.toLocaleLowerCase("en-US").endsWith(".css"),
    )
    .sort((left, right) => left.name.localeCompare(right.name, "en-US", { numeric: true }))) {
    if (candidates.length >= maxCatalogEntries) {
      warnings.push(`Only the first ${maxCatalogEntries} vault snippets are shown.`);
      break;
    }
    const id = assetId("snippet", entry.name);
    if (!id) {
      warnings.push("A snippet with an unusually long filename was skipped.");
      continue;
    }
    try {
      const cssPath = await canonicalContainedPath(
        canonicalSnippetsPath,
        path.join(canonicalSnippetsPath, entry.name),
      );
      const stat = await fs.stat(cssPath);
      if (!stat.isFile() || stat.size > maxSnippetBytes) {
        throw new Error(
          stat.isFile()
            ? `file exceeds the ${Math.floor(maxSnippetBytes / 1024)} KiB limit`
            : "not a regular file",
        );
      }
      candidates.push({
        summary: {
          id,
          name: oneLine(entry.name.slice(0, -4), entry.name),
          source: "obsidian-vault",
        },
        cssPath,
      });
    } catch (error) {
      warnings.push(
        `Snippet ${oneLine(entry.name, "Unnamed")} was skipped: ${errorMessage(error)}`,
      );
    }
  }
  return candidates;
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, " ");
}

export function validateAppearanceCss(css: string): string {
  const normalized = css
    .replace(/^\uFEFF/u, "")
    .replace(/^\s*@charset\s+(?:"[^"]*"|'[^']*')\s*;/iu, "");
  const inspectable = stripComments(normalized);
  if (/@import(?:\s|;|url|$)/iu.test(inspectable)) {
    throw new Error("network-capable @import rules are not supported");
  }
  if (/(?:expression\s*\(|-moz-binding\s*:|behavior\s*:)/iu.test(inspectable)) {
    throw new Error("legacy executable CSS constructs are not supported");
  }
  const urlPattern = /url\s*\(/giu;
  for (const match of inspectable.matchAll(urlPattern)) {
    const afterOpen = inspectable.slice((match.index ?? 0) + match[0].length).trimStart();
    const unquoted = afterOpen.replace(/^["']/u, "").trimStart();
    if (
      !unquoted.toLocaleLowerCase("en-US").startsWith("data:") &&
      !unquoted.startsWith("#") &&
      !unquoted.toLocaleLowerCase("en-US").startsWith("var(")
    ) {
      throw new Error("only embedded data, fragment, and variable CSS URLs are supported");
    }
  }
  return normalized;
}

function cssSection(label: string, css: string): string {
  return `/* Threadleaf appearance: ${label.replaceAll("*/", "* /")} */\n${css.trim()}\n`;
}

export async function loadVaultAppearance(
  options: VaultAppearanceLoaderOptions,
): Promise<AppearanceSnapshot> {
  const preference = parseVaultAppearanceSettings(options.preference);
  const themeWarnings: string[] = [];
  const snippetWarnings: string[] = [];
  const [themeCandidates, snippetCandidates] = await Promise.all([
    discoverThemes(options.vaultPath, themeWarnings),
    discoverSnippets(options.vaultPath, snippetWarnings),
  ]);
  const warnings = [...themeWarnings, ...snippetWarnings];
  const themes = themeCandidates.map((candidate) => candidate.summary);
  const snippets = snippetCandidates.map((candidate) => candidate.summary);

  if (options.safeMode) {
    if (preference.themeId || preference.enabledSnippetIds.length > 0) {
      warnings.unshift(
        "Custom theme and snippet CSS are disabled by Threadleaf appearance safe mode.",
      );
    }
    return {
      vaultId: options.vaultId,
      preference,
      safeMode: true,
      themes,
      snippets,
      activeThemeId: null,
      activeSnippetIds: [],
      css: "",
      warnings,
    };
  }

  const sections: string[] = [];
  let combinedBytes = 0;
  let activeThemeId: string | null = null;
  const activeSnippetIds: string[] = [];

  if (preference.themeId) {
    const theme = themeCandidates.find((candidate) => candidate.summary.id === preference.themeId);
    if (!theme) {
      warnings.push("The selected custom theme is not available in this vault.");
    } else {
      try {
        const css = validateAppearanceCss(await readBoundedText(theme.cssPath, maxThemeBytes));
        combinedBytes += Buffer.byteLength(css, "utf8");
        sections.push(cssSection(`theme ${theme.summary.name}`, css));
        activeThemeId = theme.summary.id;
      } catch (error) {
        warnings.push(`Theme ${theme.summary.name} was not applied: ${errorMessage(error)}`);
      }
    }
  }

  for (const snippetId of preference.enabledSnippetIds) {
    const snippet = snippetCandidates.find((candidate) => candidate.summary.id === snippetId);
    if (!snippet) {
      warnings.push(`An enabled CSS snippet is not available in this vault (${snippetId}).`);
      continue;
    }
    try {
      const css = validateAppearanceCss(await readBoundedText(snippet.cssPath, maxSnippetBytes));
      const nextBytes = combinedBytes + Buffer.byteLength(css, "utf8");
      if (nextBytes > maxCombinedCssBytes) {
        throw new Error(
          `combined custom CSS exceeds the ${Math.floor(maxCombinedCssBytes / 1024)} KiB limit`,
        );
      }
      combinedBytes = nextBytes;
      sections.push(cssSection(`snippet ${snippet.summary.name}`, css));
      activeSnippetIds.push(snippet.summary.id);
    } catch (error) {
      warnings.push(`Snippet ${snippet.summary.name} was not applied: ${errorMessage(error)}`);
    }
  }

  return {
    vaultId: options.vaultId,
    preference,
    safeMode: false,
    themes,
    snippets,
    activeThemeId,
    activeSnippetIds,
    css: sections.join("\n"),
    warnings,
  };
}
