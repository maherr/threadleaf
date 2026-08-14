const { MarkdownRenderChild, MarkdownPostProcessorContext, Notice, Plugin } = require("obsidian");

module.exports = class PortingFixture extends Plugin {
  static measuredContext = MarkdownPostProcessorContext;

  onload() {
    this.addCommand({
      id: "porting-fixture-smoke",
      name: "Porting fixture smoke",
      callback: () => new Notice("fixture"),
    });
    this.registerMarkdownPostProcessor(async (element, context) => {
      const _child = new MarkdownRenderChild(element);
      const _sourcePath = context.sourcePath;
      const _section = context.getSectionInfo(element);
      context.addChild(_child);
    });
  }
};
