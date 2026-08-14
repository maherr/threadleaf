const fs = require("node:fs");
const { Plugin } = require("obsidian");

module.exports = class UnmeasuredFixture extends Plugin {
  onload() {
    this.addCommand({
      id: "unmeasured-fixture",
      name: "Unmeasured fixture",
      callback: () => fs.readFileSync(app.vault.cachedReadPath),
    });
  }
};
