const { Plugin } = require("obsidian");
const { EditorView, ViewPlugin } = require("@codemirror/view");

function evidence() {
  const root = globalThis.__threadleafTrustedGate ?? {};
  globalThis.__threadleafTrustedGate = root;
  if (root.view) return root.view;
  root.view = {
    constructed: 0,
    destroyed: 0,
    updates: [],
  };
  return root.view;
}

const viewPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      const state = evidence();
      state.constructed += 1;
      state.updates.push({
        pane: view.dom.closest("[data-pane-id]")?.dataset.paneId ?? null,
        type: "create",
      });
      view.dom.classList.add("threadleaf-trusted-view-fixture");
      this.view = view;
    }

    update(update) {
      if (!update.docChanged) return;
      const state = evidence();
      state.updates.push({
        pane: update.view.dom.closest("[data-pane-id]")?.dataset.paneId ?? null,
        type: "doc-change",
      });
    }

    destroy() {
      evidence().destroyed += 1;
      this.view.dom.classList.remove("threadleaf-trusted-view-fixture");
    }
  },
  {
    eventHandlers: {},
  },
);

module.exports = class ThreadleafTrustedViewFixture extends Plugin {
  onload() {
    const state = evidence();
    const hostModules = globalThis.__threadleafTrustedHostModules;
    const hostView = hostModules?.["@codemirror/view"];
    state.loadCount = (state.loadCount ?? 0) + 1;
    state.realm = {
      globalIsWindow: globalThis === window,
      documentIsWindowDocument: document === window.document,
      namespaceIsHostTable: hostView === require("@codemirror/view"),
      editorViewIsHostTable: hostView?.EditorView === EditorView,
      viewPluginIsHostTable: hostView?.ViewPlugin === ViewPlugin,
    };
    this.registerEditorExtension(viewPlugin);
  }
};
