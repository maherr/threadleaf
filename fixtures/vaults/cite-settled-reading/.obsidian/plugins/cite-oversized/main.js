const { Plugin } = require("obsidian");

// A deliberately oversized sibling of the CITE fixture: its registered Markdown post processor
// appends settled output past the compatibility host's outbound size cap
// (maxMarkdownProjectionHtmlBytes in src/runtime/plugin-host.ts). Used only for explicit
// too-large evidence; never registered as a real compatibility claim.
module.exports = class CiteOversizedPlugin extends Plugin {
  onload() {
    this.registerMarkdownPostProcessor((element) => {
      const doc = element.ownerDocument;
      const bloat = doc.createElement("p");
      // 9,000,000 bytes comfortably exceeds the 8 MiB (8,388,608 byte) outbound cap.
      bloat.textContent = "x".repeat(9_000_000);
      element.append(bloat);
    });
  }
};
