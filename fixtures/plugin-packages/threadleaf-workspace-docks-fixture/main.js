const { ItemView, Plugin } = require("obsidian");

class DrawingView extends ItemView {
  getViewType() {
    return "excalidraw";
  }

  getDisplayText() {
    return "Drawing";
  }

  async onOpen() {
    this.containerEl.textContent = "Threadleaf drawing fixture";
  }
}

module.exports = class WorkspaceDocksFixture extends Plugin {
  onload() {
    this.registerView("excalidraw", (leaf) => new DrawingView(leaf));
  }
};
