/**
 * The public semantic theme contract.
 *
 * Theme authors may override these variables, but Threadleaf owns the state
 * semantics around them. A selected, current, warning, or error state must
 * remain discoverable through text, shape, border style, or an accessible DOM
 * state as well as color. The list is intentionally data-shaped so the public
 * specification can be generated from this source without importing renderer
 * code.
 */

export const themeContractVersion = 1 as const;
export const themeContractUri = "urn:threadleaf:theme:v1" as const;

export const themeContractTokens = [
  ["--background-primary", "surface"],
  ["--background-primary-alt", "surface-raised"],
  ["--background-secondary", "surface-sunken"],
  ["--background-secondary-alt", "surface-sunken-alt"],
  ["--background-modifier-border", "border"],
  ["--background-modifier-border-hover", "border-strong"],
  ["--background-modifier-hover", "surface-hover"],
  ["--background-modifier-error", "signal-soft"],
  ["--text-normal", "text-primary"],
  ["--text-muted", "text-secondary"],
  ["--text-faint", "text-muted"],
  ["--text-accent", "accent-strong"],
  ["--text-accent-hover", "accent-hover"],
  ["--text-error", "signal"],
  ["--icon-color", "icon"],
  ["--color-accent", "accent"],
  ["--interactive-accent", "accent"],
  ["--interactive-accent-hover", "accent-hover"],
  ["--canvas", "canvas"],
  ["--surface", "surface"],
  ["--surface-raised", "surface-raised"],
  ["--surface-sunken", "surface-sunken"],
  ["--ink", "text-primary"],
  ["--ink-soft", "text-secondary"],
  ["--ink-muted", "text-muted"],
  ["--line", "border"],
  ["--line-strong", "border-strong"],
  ["--accent", "accent"],
  ["--accent-strong", "accent-strong"],
  ["--accent-soft", "accent-soft"],
  ["--signal", "signal"],
  ["--signal-soft", "signal-soft"],
  ["--font-interface", "interface-font"],
  ["--font-text", "text-font"],
  ["--font-monospace", "monospace-font"],
  ["--file-margins", "file-margin"],
  ["--radius-s", "small-radius"],
  ["--radius-m", "medium-radius"],
  ["--radius-l", "large-radius"],
] as const;

export type ThemeContractTokenName = (typeof themeContractTokens)[number][0];
export type ThemeContractTokenRole = (typeof themeContractTokens)[number][1];

export const themeContractStateCues = [
  ["selected", "aria-current, aria-pressed, or an equivalent visible label plus a border or shape"],
  ["warning", "status text or an announced warning symbol plus a non-color border style"],
  ["error", "status text or an announced error symbol plus a non-color border style"],
  ["loading", "status text or an announced progress state, never color alone"],
] as const;

export type ThemeContractState = (typeof themeContractStateCues)[number][0];

/**
 * Rendered scheme families in the contract. Settings exposes only system,
 * light, and dark as color-scheme choices; the high-contrast entries are
 * derived variants selected by the accessibility layer.
 */
export const themeContractSchemes = [
  "light",
  "dark",
  "high-contrast-light",
  "high-contrast-dark",
] as const;
