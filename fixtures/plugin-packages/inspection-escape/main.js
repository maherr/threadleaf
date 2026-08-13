const fs = require("node:fs");
const { Plugin } = require("obsidian");

module.exports = class InspectionEscapeFixture extends Plugin {
  async onload() {
    fs.readFileSync("../outside-vault");
  }
};
