import { describe, expect, it } from "vitest";
import {
  accessibilityPreferenceRanges,
  createDefaultAccessibilityPreferences,
  effectiveAccessibilityOverride,
  migrateAccessibilityPreferences,
  parseAccessibilityNumber,
  parseAccessibilityPreferences,
  repairAccessibilityPreferences,
  resolveAccessibilityPreferences,
} from "./accessibility-preferences";

describe("accessibility preferences", () => {
  it("starts with system defaults for media-query controlled preferences", () => {
    const defaults = createDefaultAccessibilityPreferences();
    expect(defaults.highContrast).toBeNull();
    expect(defaults.reducedMotion).toBeNull();
    expect(defaults.reducedTransparency).toBeNull();
    expect(
      resolveAccessibilityPreferences(defaults, {
        highContrast: true,
        reducedMotion: true,
        reducedTransparency: false,
      }),
    ).toMatchObject({
      highContrast: true,
      reducedMotion: true,
      reducedTransparency: false,
    });
  });

  it("keeps explicit overrides independent from system changes", () => {
    expect(effectiveAccessibilityOverride(null, true)).toBe(true);
    expect(effectiveAccessibilityOverride(false, true)).toBe(false);
    expect(effectiveAccessibilityOverride(true, false)).toBe(true);
  });

  it("validates bounded values and normalizes decimal precision", () => {
    const parsed = parseAccessibilityPreferences({
      ...createDefaultAccessibilityPreferences(),
      uiFontScale: 1.234,
      editorLineHeight: 1.678,
    });
    expect(parsed.uiFontScale).toBe(1.23);
    expect(parsed.editorLineHeight).toBe(1.68);
    expect(() =>
      parseAccessibilityPreferences({
        ...createDefaultAccessibilityPreferences(),
        editorFontSize: accessibilityPreferenceRanges.editorFontSize.max + 1,
      }),
    ).toThrow("editorFontSize");
    expect(() =>
      parseAccessibilityPreferences({
        ...createDefaultAccessibilityPreferences(),
        accent: "purple",
      }),
    ).toThrow("accent");
  });

  it("migrates the sparse version-zero envelope without persisting as a side effect", () => {
    expect(
      migrateAccessibilityPreferences({ version: 0, accent: "teal", editorFontSize: 18 }),
    ).toEqual({
      ...createDefaultAccessibilityPreferences(),
      accent: "teal",
      editorFontSize: 18,
    });
  });

  it("repairs a partial form draft from safe defaults", () => {
    expect(repairAccessibilityPreferences({ accent: "teal", reducedMotion: true })).toMatchObject({
      accent: "teal",
      reducedMotion: true,
      highContrast: null,
    });
  });

  it("parses only decimal form values", () => {
    expect(parseAccessibilityNumber(" 1.25 ", "textFontScale")).toBe(1.25);
    expect(() => parseAccessibilityNumber("auto", "textFontScale")).toThrow("decimal");
  });
});
