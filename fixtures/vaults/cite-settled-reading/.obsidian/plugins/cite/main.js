const { MarkdownRenderChild, Plugin } = require("obsidian");

// Matches Threadleaf's own established "Exact CITE release fixture" identity (id "cite", name
// "CITE", version 0.1.2, minAppVersion 1.12.7; see src/main/plugin-package-inspection.test.ts and
// scripts/check-plugin-package-inspection-e2e.mjs). This bundle is independently written for the
// measured Markdown processor family (docs/compatibility/open-plugin-api.md); it is not copied
// from any real upstream plugin's source or bundled resources.
const CITATION_PATTERN = /\[cite:\s*([^\]]+?)\s*\]/g;

class CiteRenderChild extends MarkdownRenderChild {
  onload() {
    this.containerEl.dataset.citeSettled = "loaded";
  }

  onunload() {
    this.containerEl.dataset.citeSettled = "unloaded";
  }
}

/**
 * Replace every `[cite: Label]` occurrence in `root`'s text with a `.cite-citation` span,
 * preserving surrounding markup exactly. Returns the number of citations recognized.
 */
function decorateCitations(root) {
  const doc = root.ownerDocument;
  const textNodes = [];
  (function collect(node) {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        textNodes.push(child);
      } else if (child.nodeType === 1) {
        collect(child);
      }
    }
  })(root);

  let matches = 0;
  for (const textNode of textNodes) {
    const value = textNode.nodeValue || "";
    CITATION_PATTERN.lastIndex = 0;
    if (!CITATION_PATTERN.test(value)) {
      continue;
    }
    CITATION_PATTERN.lastIndex = 0;
    const fragment = doc.createDocumentFragment();
    let lastIndex = 0;
    let match = CITATION_PATTERN.exec(value);
    while (match !== null) {
      const whole = match[0];
      const label = match[1];
      if (match.index > lastIndex) {
        fragment.append(doc.createTextNode(value.slice(lastIndex, match.index)));
      }
      const mark = doc.createElement("span");
      mark.className = "cite-citation";
      mark.textContent = label.trim();
      fragment.append(mark);
      matches += 1;
      lastIndex = match.index + whole.length;
      match = CITATION_PATTERN.exec(value);
    }
    if (lastIndex < value.length) {
      fragment.append(doc.createTextNode(value.slice(lastIndex)));
    }
    textNode.replaceWith(fragment);
  }
  return matches;
}

module.exports = class CitePlugin extends Plugin {
  onload() {
    this.registerMarkdownPostProcessor((element, context) => {
      const matches = decorateCitations(element);
      const summary = element.ownerDocument.createElement("p");
      summary.className = "cite-citation-summary";
      summary.textContent =
        matches === 0
          ? "CITE found no citations in this note."
          : matches === 1
            ? "CITE recognized 1 citation."
            : `CITE recognized ${matches} citations.`;
      element.append(summary);
      context.addChild(new CiteRenderChild(element));
    });
  }
};
