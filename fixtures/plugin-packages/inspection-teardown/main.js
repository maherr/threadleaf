const { Plugin } = require("obsidian");

module.exports = class InspectionTeardownFixture extends Plugin {
  async onunload() {
    throw new Error("fixture teardown failed");
  }
};
