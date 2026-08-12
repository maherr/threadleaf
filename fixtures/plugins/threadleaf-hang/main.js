const { Plugin } = require("obsidian");

module.exports = class ThreadleafHangFixture extends Plugin {
  async onload() {
    this.addCommand({
      id: "hang",
      name: "Hang compatibility renderer",
      callback() {
        for (;;) {
          // Deliberately block only the disposable compatibility renderer.
        }
      },
    });
  }
};
