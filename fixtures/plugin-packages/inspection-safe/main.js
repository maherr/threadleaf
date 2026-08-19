const { ItemView, Notice, Plugin } = require("obsidian");
const { Buffer: NativeBuffer } = require("node:buffer");

module.exports = class InspectionSafeFixture extends Plugin {
  async onload() {
    if (
      Buffer.from("trusted-buffer-global", "utf8").toString("utf8") !== "trusted-buffer-global" ||
      NativeBuffer.from("trusted-buffer-module", "utf8").toString("utf8") !==
        "trusted-buffer-module"
    ) {
      throw new Error("Trusted workspace Node Buffer compatibility is incomplete.");
    }
    this.addCommand({
      id: "inspection-safe-command",
      name: "Run inspection fixture",
      callback: () => new Notice("Inspection fixture command ran."),
    });
    this.registerView("inspection-safe-view", (leaf) => new ItemView(leaf));
    this.registerMarkdownPostProcessor(() => {});
  }
};
