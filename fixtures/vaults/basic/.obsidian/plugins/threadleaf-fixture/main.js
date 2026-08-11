const { Notice, Plugin } = require("obsidian");

module.exports = class ThreadleafFixturePlugin extends Plugin {
  async onload() {
    this.addCommand({
      id: "threadleaf-fixture-confirm",
      name: "Confirm compatibility bridge",
      callback: () => {
        new Notice("Fixture command crossed the compatibility bridge.");
      },
    });
  }
};
