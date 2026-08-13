/**
 * Global accessibility preferences.
 *
 * This document is deliberately separate from vault appearance and application
 * settings. It is global user state, not vault metadata, and its persisted
 * envelope is versioned independently so a future migration can never write
 * into a vault as a side effect of opening one.
 */

export const accessibilityPreferencesVersion = 1 as const;

export const accessibilityAccentChoices = ["blue", "teal", "orange"] as const;
export type AccessibilityAccent = (typeof accessibilityAccentChoices)[number];

/** null means "follow the operating-system preference". */
export type AccessibilityOverride = boolean | null;

export interface AccessibilityPreferences {
  version: typeof accessibilityPreferencesVersion;
  highContrast: AccessibilityOverride;
  accent: AccessibilityAccent;
  uiFontScale: number;
  textFontScale: number;
  editorFontSize: number;
  editorLineHeight: number;
  reducedMotion: AccessibilityOverride;
  reducedTransparency: AccessibilityOverride;
}

export interface AccessibilityPreferencesSnapshot {
  preferences: AccessibilityPreferences;
  warning: string | null;
}

export interface EffectiveAccessibilityPreferences {
  highContrast: boolean;
  accent: AccessibilityAccent;
  uiFontScale: number;
  textFontScale: number;
  editorFontSize: number;
  editorLineHeight: number;
  reducedMotion: boolean;
  reducedTransparency: boolean;
}

export const defaultAccessibilityPreferences: Readonly<AccessibilityPreferences> = {
  version: accessibilityPreferencesVersion,
  highContrast: null,
  accent: "blue",
  uiFontScale: 1,
  textFontScale: 1,
  editorFontSize: 15,
  editorLineHeight: 1.6,
  reducedMotion: null,
  reducedTransparency: null,
};

const maxDocumentBytes = 16 * 1024;
const decimalPattern = /^-?(?:\d+|\d*\.\d+)$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Accessibility ${field} must be a finite number.`);
  }
  return value;
}

function boundedNumber(value: unknown, field: string, minimum: number, maximum: number): number {
  const number = finiteNumber(value, field);
  if (number < minimum || number > maximum) {
    throw new Error(`Accessibility ${field} must be between ${minimum} and ${maximum}.`);
  }
  // Keeping two decimal places makes the on-disk document stable and avoids
  // values that cannot be represented faithfully by CSS custom properties.
  return Math.round(number * 100) / 100;
}

function parseOverride(value: unknown, field: string): AccessibilityOverride {
  if (value !== null && typeof value !== "boolean") {
    throw new Error(`Accessibility ${field} must be true, false, or null (system default).`);
  }
  return value;
}

function parseAccent(value: unknown): AccessibilityAccent {
  if (!accessibilityAccentChoices.includes(value as AccessibilityAccent)) {
    throw new Error(
      `Accessibility accent must be one of: ${accessibilityAccentChoices.join(", ")}.`,
    );
  }
  return value as AccessibilityAccent;
}

function parseCurrentAccessibilityPreferences(
  value: Record<string, unknown>,
): AccessibilityPreferences {
  return {
    version: accessibilityPreferencesVersion,
    highContrast: parseOverride(value.highContrast, "highContrast"),
    accent: parseAccent(value.accent),
    uiFontScale: boundedNumber(value.uiFontScale, "uiFontScale", 0.8, 1.6),
    textFontScale: boundedNumber(value.textFontScale, "textFontScale", 0.8, 1.8),
    editorFontSize: boundedNumber(value.editorFontSize, "editorFontSize", 11, 32),
    editorLineHeight: boundedNumber(value.editorLineHeight, "editorLineHeight", 1.2, 2.4),
    reducedMotion: parseOverride(value.reducedMotion, "reducedMotion"),
    reducedTransparency: parseOverride(value.reducedTransparency, "reducedTransparency"),
  };
}

/**
 * Upgrade the only older on-disk envelope we have shipped. Version zero was
 * intentionally a sparse preview shape, so absent fields inherit the current
 * defaults while present fields still go through the strict v1 validators.
 * Unknown/future versions are rejected rather than rewritten over.
 */
export function migrateAccessibilityPreferences(value: unknown): AccessibilityPreferences {
  if (!isRecord(value)) {
    throw new Error(
      `Accessibility preferences must use version ${accessibilityPreferencesVersion}.`,
    );
  }
  if (value.version === accessibilityPreferencesVersion) {
    return parseCurrentAccessibilityPreferences(value);
  }
  if (value.version === 0) {
    return parseCurrentAccessibilityPreferences({
      ...defaultAccessibilityPreferences,
      ...value,
      version: accessibilityPreferencesVersion,
    });
  }
  throw new Error(`Accessibility preferences must use version ${accessibilityPreferencesVersion}.`);
}

/** Parse without mutating or writing the persisted document. */
export function parseAccessibilityPreferences(value: unknown): AccessibilityPreferences {
  return migrateAccessibilityPreferences(value);
}

/** Return a fresh default object so callers cannot mutate shared defaults. */
export function createDefaultAccessibilityPreferences(): AccessibilityPreferences {
  return { ...defaultAccessibilityPreferences };
}

/**
 * Update a preference atomically at the domain boundary. This is intentionally
 * strict: malformed updates are rejected before the persistence port is called.
 */
export function normalizeAccessibilityPreferences(
  value: AccessibilityPreferences,
): AccessibilityPreferences {
  return parseAccessibilityPreferences(value);
}

export function effectiveAccessibilityOverride(
  override: AccessibilityOverride,
  systemValue: boolean,
): boolean {
  return override === null ? systemValue : override;
}

export function resolveAccessibilityPreferences(
  preferences: AccessibilityPreferences,
  system: {
    highContrast: boolean;
    reducedMotion: boolean;
    reducedTransparency: boolean;
  },
): EffectiveAccessibilityPreferences {
  const normalized = parseAccessibilityPreferences(preferences);
  return {
    highContrast: effectiveAccessibilityOverride(normalized.highContrast, system.highContrast),
    accent: normalized.accent,
    uiFontScale: normalized.uiFontScale,
    textFontScale: normalized.textFontScale,
    editorFontSize: normalized.editorFontSize,
    editorLineHeight: normalized.editorLineHeight,
    reducedMotion: effectiveAccessibilityOverride(normalized.reducedMotion, system.reducedMotion),
    reducedTransparency: effectiveAccessibilityOverride(
      normalized.reducedTransparency,
      system.reducedTransparency,
    ),
  };
}

/**
 * Validate and repair a user-facing draft. This is useful for a native form
 * that receives text input: only the constrained accent set is accepted and
 * numeric fields must be real, bounded values. It never silently repairs an
 * on-disk document; file loading uses parseAccessibilityPreferences instead.
 */
export function repairAccessibilityPreferences(
  value: Partial<Record<keyof AccessibilityPreferences, unknown>>,
): AccessibilityPreferences {
  const defaults = createDefaultAccessibilityPreferences();
  const candidate = {
    ...defaults,
    ...value,
    version: accessibilityPreferencesVersion,
  } as AccessibilityPreferences;
  return parseAccessibilityPreferences(candidate);
}

export function isAccessibilityPreferencesDocumentWithinLimit(bytes: number): boolean {
  return Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= maxDocumentBytes;
}

export const accessibilityPreferencesMaxDocumentBytes = maxDocumentBytes;

/**
 * Keep the accepted range explicit for settings controls and tests. The
 * parser is authoritative; these constants are presentation metadata only.
 */
export const accessibilityPreferenceRanges = {
  uiFontScale: { min: 0.8, max: 1.6, step: 0.05 },
  textFontScale: { min: 0.8, max: 1.8, step: 0.05 },
  editorFontSize: { min: 11, max: 32, step: 1 },
  editorLineHeight: { min: 1.2, max: 2.4, step: 0.05 },
} as const;

/**
 * A tiny helper used by diagnostics and tests when a form value arrives as a
 * string. It intentionally accepts only ordinary decimal notation.
 */
export function parseAccessibilityNumber(value: string, field: string): number {
  const trimmed = value.trim();
  if (!decimalPattern.test(trimmed)) {
    throw new Error(`Accessibility ${field} must be a decimal number.`);
  }
  return finiteNumber(Number(trimmed), field);
}
