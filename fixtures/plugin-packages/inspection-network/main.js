const { Plugin } = require("obsidian");

module.exports = class InspectionNetworkFixture extends Plugin {
  async onload() {
    await fetch("fixture://inspection-network");
  }
};
