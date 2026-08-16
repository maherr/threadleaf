import { loadVaultAppearance } from "../main/vault-appearance-loader";
import { discoverVaultPlugins } from "../main/vault-plugin-loader";
import {
  type AppearanceCatalogSourceState,
  createDefaultVaultAppearance,
} from "../shared/appearance";
import type { PluginCompatibilityEvidenceStatus, PluginPackageState } from "../shared/plugins";

export interface CliPluginCatalogEntry {
  id: string;
  name: string;
  version: string;
  state: PluginPackageState;
  stylesheetDiscovered: boolean;
  compatibilityLevel: 0 | 1 | 2 | 3 | 4;
  compatibilityStatus: PluginCompatibilityEvidenceStatus;
}

export interface CliPluginCatalog {
  sourceState: AppearanceCatalogSourceState;
  diagnostics: number;
  invalid: number;
  total: number;
  plugins: CliPluginCatalogEntry[];
}

export interface CliThemeCatalogEntry {
  id: string;
  name: string;
  version: string | null;
}

export interface CliSnippetCatalogEntry {
  id: string;
  name: string;
}

export interface CliAppearanceCatalog {
  themeSourceState: AppearanceCatalogSourceState;
  snippetSourceState: AppearanceCatalogSourceState;
  themeDiagnostics: number;
  snippetDiagnostics: number;
  themes: CliThemeCatalogEntry[];
  snippets: CliSnippetCatalogEntry[];
}

function isCatalogControlCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

export function safeCatalogText(value: string): string {
  const normalized = Array.from(value.normalize("NFC"))
    .map((character) => (/\s/u.test(character) ? " " : character))
    .filter((character) => !isCatalogControlCharacter(character))
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  return Array.from(normalized).slice(0, 200).join("");
}

export function catalogLookupKey(value: string): string {
  return safeCatalogText(value).toLocaleLowerCase("en-US");
}

export async function readCommunityPluginCatalog(vaultPath: string): Promise<CliPluginCatalog> {
  const discovery = await discoverVaultPlugins(vaultPath);
  const plugins = discovery.plugins.map(({ summary }) => ({
    id: summary.id,
    name: safeCatalogText(summary.name),
    version: safeCatalogText(summary.version),
    state: summary.packageState,
    stylesheetDiscovered: summary.stylesheetDiscovered,
    compatibilityLevel: summary.compatibility.level,
    compatibilityStatus: summary.compatibility.status,
  }));
  return {
    sourceState: discovery.sourceState,
    diagnostics: discovery.warnings.length,
    invalid: plugins.filter((plugin) => plugin.state === "invalid").length,
    total: plugins.length,
    plugins,
  };
}

export async function readAppearanceCatalog(
  vaultPath: string,
  vaultId: string,
): Promise<CliAppearanceCatalog> {
  const appearance = await loadVaultAppearance({
    vaultPath,
    vaultId,
    preference: createDefaultVaultAppearance(),
    safeMode: false,
  });
  return {
    themeSourceState: appearance.themeSourceState,
    snippetSourceState: appearance.snippetSourceState,
    themeDiagnostics: appearance.themeDiagnostics,
    snippetDiagnostics: appearance.snippetDiagnostics,
    themes: appearance.themes.map((theme) => ({
      id: theme.id,
      name: safeCatalogText(theme.name),
      version: theme.version === null ? null : safeCatalogText(theme.version),
    })),
    snippets: appearance.snippets.map((snippet) => ({
      id: snippet.id,
      name: safeCatalogText(snippet.name),
    })),
  };
}
