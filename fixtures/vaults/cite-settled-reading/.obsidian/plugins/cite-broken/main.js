const { Plugin } = require("obsidian");

// A deliberately broken sibling of the CITE fixture: its registered Markdown post processor
// always throws synchronously. Used only for explicit processor-error evidence in the settled
// Reading projection slice; never registered as a real compatibility claim.
module.exports = class CiteBrokenPlugin extends Plugin {
  onload() {
    this.registerMarkdownPostProcessor(() => {
      throw new Error("cite-broken always fails its registered Markdown post processor.");
    });
  }
};
