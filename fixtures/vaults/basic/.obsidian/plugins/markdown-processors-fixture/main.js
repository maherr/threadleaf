const { MarkdownRenderChild, Plugin } = require("obsidian");

class FixtureRenderChild extends MarkdownRenderChild {
  onload() {
    this.containerEl.dataset.fixtureChild = "loaded";
  }

  onunload() {
    this.containerEl.dataset.fixtureChild = "unloaded";
  }
}

module.exports = class MarkdownProcessorsFixture extends Plugin {
  onload() {
    this.registerMarkdownPostProcessor((element, context) => {
      element.dataset.fixturePost = `${context.sourcePath}|${context.frontmatter?.title ?? ""}`;
      context.addChild(new FixtureRenderChild(element));
    }, 20);

    this.registerMarkdownCodeBlockProcessor(
      "ThReAdLeAf",
      (source, element, context) => {
        element.dataset.fixtureCode = `${source}|${context.docId}`;
      },
      -20,
    );
  }
};
