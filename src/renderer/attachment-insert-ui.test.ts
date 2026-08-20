import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rendererSource = readFileSync(new URL("./renderer.ts", import.meta.url), "utf8");
const rendererHtml = readFileSync(new URL("./index.html", import.meta.url), "utf8");

function functionSource(name: string): string {
  const marker = `function ${name}`;
  const start = rendererSource.indexOf(marker);
  if (start < 0) return "";
  const remainder = rendererSource.slice(start + marker.length);
  const next = remainder.search(/\n(?:async )?function [A-Za-z0-9_]+/u);
  return rendererSource.slice(
    start,
    next < 0 ? rendererSource.length : start + marker.length + next,
  );
}

describe("editor attachment insertion UI", () => {
  it("preserves ordinary paste, bridges registered text handlers, and owns file transfers", () => {
    const drop = functionSource("handleEditorAttachmentDrop");
    const paste = functionSource("handleEditorAttachmentPaste");
    expect(rendererSource).toContain("EditorView.domEventHandlers({");
    expect(drop.indexOf("hasAttachmentRestoreFileTransfer")).toBeGreaterThanOrEqual(0);
    expect(drop.indexOf("return false")).toBeGreaterThan(
      drop.indexOf("hasAttachmentRestoreFileTransfer"),
    );
    expect(drop.indexOf("event.preventDefault()")).toBeGreaterThan(drop.indexOf("return false"));
    expect(drop).toContain("event.stopPropagation()");
    expect(drop).toContain("view.posAtCoords");
    expect(paste).toContain('workspaceEvents?.includes("editor-paste")');
    expect(paste).toContain("capturePluginEditorPaste(paneId, view)");
    expect(paste).toContain("deliverPluginEditorPaste(paneId, view, captured, clipboardText)");
    expect(paste.indexOf("event.preventDefault()")).toBeGreaterThan(
      paste.indexOf("capturePluginEditorPaste"),
    );
    expect(paste).toContain("view.state.selection.main");
    expect(paste).toContain("selection.from");
    expect(paste).toContain("selection.to");
    expect(paste).toContain("stageEditorAttachmentInsertBatch");
    expect(functionSource("deliverPluginEditorPaste")).toContain(
      "window.threadleaf.runPluginEditorPaste(",
    );
    expect(functionSource("deliverPluginEditorPaste")).toContain("applyPlainTextPaste(");
  });

  it("stages bounded File bytes before autosave and opens a two-step proof dialog", () => {
    const stage = functionSource("stageEditorAttachmentInsert");
    const submit = functionSource("insertCurrentExternalAttachment");
    expect(stage.indexOf("stageAttachmentRestoreFile(selectedFile)")).toBeGreaterThanOrEqual(0);
    expect(stage.indexOf('tryFlushAllPaneAutosaves("note-mutation")')).toBeGreaterThan(
      stage.indexOf("stageAttachmentRestoreFile(selectedFile)"),
    );
    expect(stage).toContain("current.editorContent !== captured.editorContent");
    expect(stage).toContain("current.dirty");
    expect(submit).toContain("window.threadleaf.insertAttachment(");
    expect(submit).toContain("pending.bytes.slice(0)");
    expect(submit).toContain('response.outcome.status === "requires-confirmation"');
    expect(rendererHtml).toContain('id="attachment-insert-dialog"');
    expect(rendererHtml).toContain('id="attachment-insert-target"');
    expect(rendererHtml).toContain('id="attachment-insert-proof"');
  });

  it("does not request raw file paths, clipboard authority, or renderer IPC authority", () => {
    expect(rendererSource).not.toContain("selectedFile.path");
    expect(rendererSource).not.toContain("navigator.clipboard");
    expect(rendererSource).not.toContain("ipcRenderer");
  });
});
