import { describe, expect, it } from "vitest";
import {
  createDefaultVaultAppearance,
  effectiveColorScheme,
  parseVaultAppearanceSettings,
} from "./appearance";

describe("vault appearance settings", () => {
  it("defaults to the operating-system color scheme without custom CSS", () => {
    expect(createDefaultVaultAppearance()).toEqual({
      colorScheme: "system",
      themeId: null,
      enabledSnippetIds: [],
    });
    expect(effectiveColorScheme("system", false)).toBe("light");
    expect(effectiveColorScheme("system", true)).toBe("dark");
    expect(effectiveColorScheme("light", true)).toBe("light");
  });

  it("normalizes bounded theme and snippet selections", () => {
    expect(
      parseVaultAppearanceSettings({
        colorScheme: "dark",
        themeId: "obsidian-theme:Minimal",
        enabledSnippetIds: ["obsidian-snippet:headings.css"],
      }),
    ).toEqual({
      colorScheme: "dark",
      themeId: "obsidian-theme:Minimal",
      enabledSnippetIds: ["obsidian-snippet:headings.css"],
    });
  });

  it("rejects unknown schemes, malformed ids, and duplicate snippets", () => {
    expect(() =>
      parseVaultAppearanceSettings({
        colorScheme: "sepia",
        themeId: null,
        enabledSnippetIds: [],
      }),
    ).toThrow("system, light, or dark");
    expect(() =>
      parseVaultAppearanceSettings({
        colorScheme: "light",
        themeId: "../theme.css",
        enabledSnippetIds: [],
      }),
    ).toThrow("obsidian-theme identifier");
    expect(() =>
      parseVaultAppearanceSettings({
        colorScheme: "light",
        themeId: "obsidian-snippet:not-a-theme.css",
        enabledSnippetIds: [],
      }),
    ).toThrow("obsidian-theme identifier");
    expect(() =>
      parseVaultAppearanceSettings({
        colorScheme: "light",
        themeId: null,
        enabledSnippetIds: ["obsidian-theme:not-a-snippet"],
      }),
    ).toThrow("obsidian-snippet identifier");
    expect(() =>
      parseVaultAppearanceSettings({
        colorScheme: "light",
        themeId: null,
        enabledSnippetIds: ["obsidian-snippet:a.css", "obsidian-snippet:a.css"],
      }),
    ).toThrow("unique");
  });
});
