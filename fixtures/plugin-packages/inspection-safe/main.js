const { ItemView, Notice, Plugin } = require("obsidian");

module.exports = class InspectionSafeFixture extends Plugin {
  async onload() {
    this.addCommand({
      id: "inspection-safe-command",
      name: "Run inspection fixture",
      callback: () => new Notice("Inspection fixture command ran."),
    });
    this.registerView("inspection-safe-view", (leaf) => new ItemView(leaf));
    this.registerMarkdownPostProcessor(() => {});
  }
};
