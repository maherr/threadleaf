import CodeMirror from "codemirror5";
import "codemirror5/mode/javascript/javascript";

interface LegacyCodeMirrorWindow extends Window {
  CodeMirror?: typeof CodeMirror;
}

/**
 * Obsidian still exposes the CodeMirror 5 global for legacy mode registration even though its
 * editor is CodeMirror 6. Mature plugins use that narrow bridge for syntax modes, so expose the
 * real MIT CodeMirror 5 registry rather than a compatibility stub.
 */
export function installLegacyCodeMirror5Global(rendererWindow: Window): typeof CodeMirror {
  const target = rendererWindow as LegacyCodeMirrorWindow;
  if (target.CodeMirror) {
    if (
      typeof target.CodeMirror.defineMode !== "function" ||
      typeof target.CodeMirror.getMode !== "function"
    ) {
      throw new Error("The existing CodeMirror compatibility global is malformed.");
    }
    return target.CodeMirror;
  }
  Object.defineProperty(target, "CodeMirror", {
    configurable: false,
    enumerable: true,
    value: CodeMirror,
    writable: false,
  });
  return CodeMirror;
}
