const { Notice, Plugin } = require("obsidian");

module.exports = class ThreadleafVisualFixturePlugin extends Plugin {
  async onload() {
    this.addCommand({
      id: "threadleaf-visual-fixture-confirm",
      name: "Confirm visual compatibility fixture",
      callback: () => {
        new Notice("Visual fixture command crossed the compatibility bridge.");
      },
    });
  }
};
