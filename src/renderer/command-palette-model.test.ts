import { describe, expect, it } from "vitest";
import {
  filterPaletteCommands,
  firstEnabledPaletteIndex,
  movePaletteSelection,
  type PaletteCommandDescriptor,
  paletteCountLabel,
} from "./command-palette-model";

function command(
  id: string,
  label: string,
  options: Partial<PaletteCommandDescriptor> = {},
): PaletteCommandDescriptor {
  return {
    id,
    label,
    category: "Workspace",
    keywords: [],
    shortcut: null,
    enabled: true,
    disabledReason: null,
    ...options,
  };
}

describe("command palette model", () => {
  const commands = [
    command("editor.save", "Save current note", { category: "Editor", keywords: ["write"] }),
    command("workspace.open-vault", "Open another vault", { keywords: ["folder"] }),
    command("appearance.toggle-theme", "Switch to dark theme", {
      category: "Appearance",
      keywords: ["light", "color"],
    }),
  ];

  it("matches across labels, identifiers, categories, and keywords", () => {
    expect(filterPaletteCommands(commands, "save").map(({ id }) => id)).toEqual(["editor.save"]);
    expect(filterPaletteCommands(commands, "open folder").map(({ id }) => id)).toEqual([
      "workspace.open-vault",
    ]);
    expect(filterPaletteCommands(commands, "appearance color").map(({ id }) => id)).toEqual([
      "appearance.toggle-theme",
    ]);
  });

  it("ranks an exact or leading label match before a broader match", () => {
    const ranked = filterPaletteCommands(
      [command("other.open", "Another open action"), command("open", "Open")],
      "open",
    );

    expect(ranked.map(({ id }) => id)).toEqual(["open", "other.open"]);
  });

  it("places disabled matches after enabled matches at the same rank", () => {
    const ranked = filterPaletteCommands(
      [
        command("disabled", "Save disabled", { enabled: false }),
        command("enabled", "Save enabled"),
      ],
      "save",
    );

    expect(ranked.map(({ id }) => id)).toEqual(["enabled", "disabled"]);
  });

  it("selects and wraps across enabled commands while skipping disabled entries", () => {
    const choices = [
      command("first", "First"),
      command("disabled", "Disabled", { enabled: false }),
      command("last", "Last"),
    ];

    expect(firstEnabledPaletteIndex(choices)).toBe(0);
    expect(movePaletteSelection(choices, 0, 1)).toBe(2);
    expect(movePaletteSelection(choices, 2, 1)).toBe(0);
    expect(movePaletteSelection(choices, 0, -1)).toBe(2);
  });

  it("reports no selection when every match is disabled", () => {
    const choices = [command("disabled", "Disabled", { enabled: false })];

    expect(firstEnabledPaletteIndex(choices)).toBe(-1);
    expect(movePaletteSelection(choices, -1, 1)).toBe(-1);
  });

  it("labels total matches before the runnable subset", () => {
    expect(
      paletteCountLabel([
        command("enabled", "Enabled"),
        command("disabled", "Disabled", { enabled: false }),
      ]),
    ).toBe("2 results · 1 runnable");
    expect(paletteCountLabel([command("only", "Only")])).toBe("1 result · 1 runnable");
    expect(paletteCountLabel([])).toBe("0 results · 0 runnable");
  });
});
