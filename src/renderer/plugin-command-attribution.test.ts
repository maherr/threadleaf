import { describe, expect, it } from "vitest";
import { commandsOwnedByPlugin } from "./plugin-command-attribution";

describe("plugin command attribution", () => {
  it("keeps only commands owned by the displayed plugin", () => {
    const commands = [
      { id: "obsidian-auto-link-title:paste", name: "Paste with title" },
      { id: "obsidian-excalidraw-plugin:new", name: "New drawing" },
      { id: "obsidian-auto-link-title:normal", name: "Normal paste" },
    ];
    expect(commandsOwnedByPlugin(commands, "obsidian-auto-link-title")).toEqual([
      commands[0],
      commands[2],
    ]);
  });

  it("does not attribute commands when no plugin is displayed", () => {
    expect(commandsOwnedByPlugin([{ id: "fixture:run" }], null)).toEqual([]);
  });
});
