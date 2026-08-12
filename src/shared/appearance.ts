export const colorSchemePreferences = ["system", "light", "dark"] as const;

export type ColorSchemePreference = (typeof colorSchemePreferences)[number];
export type EffectiveColorScheme = Exclude<ColorSchemePreference, "system">;

export interface VaultAppearanceSettings {
  colorScheme: ColorSchemePreference;
  themeId: string | null;
  enabledSnippetIds: string[];
}

export interface AppearanceThemeSummary {
  id: string;
  name: string;
  version: string | null;
  author: string | null;
  source: "obsidian-vault";
}

export interface AppearanceSnippetSummary {
  id: string;
  name: string;
  source: "obsidian-vault";
}

export interface AppearanceSnapshot {
  vaultId: string;
  preference: VaultAppearanceSettings;
  safeMode: boolean;
  themes: AppearanceThemeSummary[];
  snippets: AppearanceSnippetSummary[];
  activeThemeId: string | null;
  activeSnippetIds: string[];
  css: string;
  warnings: string[];
}

export type AppearanceResponse =
  | { status: "ready"; appearance: AppearanceSnapshot }
  | { status: "stale-vault"; vaultId: string };

export const defaultVaultAppearance: Readonly<VaultAppearanceSettings> = {
  colorScheme: "system",
  themeId: null,
  enabledSnippetIds: [],
};

const appearanceAssetIdPatterns = {
  theme: /^obsidian-theme:[^\s\0]{1,1024}$/u,
  snippet: /^obsidian-snippet:[^\s\0]{1,1024}$/u,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isColorSchemePreference(value: unknown): value is ColorSchemePreference {
  return colorSchemePreferences.includes(value as ColorSchemePreference);
}

function parseAssetId(value: unknown, kind: keyof typeof appearanceAssetIdPatterns): string {
  if (typeof value !== "string" || !appearanceAssetIdPatterns[kind].test(value)) {
    throw new Error(
      `Vault appearance ${kind} identifier must be a bounded obsidian-${kind} identifier.`,
    );
  }
  return value;
}

export function parseVaultAppearanceSettings(value: unknown): VaultAppearanceSettings {
  if (!isRecord(value) || !isColorSchemePreference(value.colorScheme)) {
    throw new Error("Vault appearance must contain a system, light, or dark color scheme.");
  }
  if (value.themeId !== null && typeof value.themeId !== "string") {
    throw new Error("Vault appearance themeId must be a string or null.");
  }
  const themeId = value.themeId === null ? null : parseAssetId(value.themeId, "theme");
  if (!Array.isArray(value.enabledSnippetIds) || value.enabledSnippetIds.length > 128) {
    throw new Error("Vault appearance must contain at most 128 enabled snippet identifiers.");
  }
  const enabledSnippetIds = value.enabledSnippetIds.map((id) => parseAssetId(id, "snippet"));
  if (new Set(enabledSnippetIds).size !== enabledSnippetIds.length) {
    throw new Error("Vault appearance snippet identifiers must be unique.");
  }
  return {
    colorScheme: value.colorScheme,
    themeId,
    enabledSnippetIds,
  };
}

export function createDefaultVaultAppearance(): VaultAppearanceSettings {
  return {
    colorScheme: defaultVaultAppearance.colorScheme,
    themeId: null,
    enabledSnippetIds: [],
  };
}

export function effectiveColorScheme(
  preference: ColorSchemePreference,
  systemPrefersDark: boolean,
): EffectiveColorScheme {
  return preference === "system" ? (systemPrefersDark ? "dark" : "light") : preference;
}
