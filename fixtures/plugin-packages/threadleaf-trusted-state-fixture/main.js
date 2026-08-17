const { Plugin } = require("obsidian");
const { EditorState, StateField } = require("@codemirror/state");

function evidence() {
  const root = globalThis.__threadleafTrustedGate ?? {};
  globalThis.__threadleafTrustedGate = root;
  if (root.state) return root.state;
  root.state = {
    created: 0,
    destroyed: 0,
    loadCount: 0,
    transitions: 0,
  };
  return root.state;
}

const stateField = StateField.define({
  create() {
    const state = evidence();
    state.created += 1;
    return 0;
  },
  update(value, transaction) {
    if (transaction.docChanged) {
      const state = evidence();
      state.transitions += 1;
      state.lastDocument = transaction.newDoc.toString();
    }
    return value + (transaction.docChanged ? 1 : 0);
  },
});

module.exports = class ThreadleafTrustedStateFixture extends Plugin {
  async onload() {
    const state = evidence();
    const hostModules = globalThis.__threadleafTrustedHostModules;
    const hostState = hostModules?.["@codemirror/state"];
    state.loadCount += 1;
    state.realm = {
      globalIsWindow: globalThis === window,
      documentIsWindowDocument: document === window.document,
      namespaceIsHostTable: hostState === require("@codemirror/state"),
      editorStateIsHostTable: hostState?.EditorState === EditorState,
      stateFieldIsHostTable: hostState?.StateField === StateField,
    };
    document.documentElement.dataset.threadleafTrustedStateFixture = "loaded";
    this.register(() => {
      if (document.documentElement.dataset.threadleafTrustedStateFixture === "loaded") {
        delete document.documentElement.dataset.threadleafTrustedStateFixture;
      }
    });
    if (globalThis.__threadleafTrustedGate?.holdNextLoad === true) {
      globalThis.__threadleafTrustedGate.pendingLoadStarted = true;
      await new Promise(() => {});
    }
    this.registerEditorExtension(stateField);
  }

  onunload() {
    evidence().destroyed += 1;
  }
};
