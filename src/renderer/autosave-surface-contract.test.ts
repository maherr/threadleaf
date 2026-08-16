import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rendererSource = readFileSync(new URL("./renderer.ts", import.meta.url), "utf8");
const graphSource = readFileSync(new URL("./graph-view.ts", import.meta.url), "utf8");
const rendererHtml = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const mainSource = readFileSync(new URL("../main/main.ts", import.meta.url), "utf8");

function functionSource(name: string): string {
  const marker = `function ${name}`;
  const start = rendererSource.indexOf(marker);
  if (start < 0) throw new Error(`Missing renderer function ${name}.`);
  const remainder = rendererSource.slice(start + marker.length);
  const next = remainder.search(/\n(?:async )?function [A-Za-z0-9_]+/);
  return rendererSource.slice(
    start,
    next < 0 ? rendererSource.length : start + marker.length + next,
  );
}

function expectOrdered(source: string, first: string, second: string): void {
  const firstIndex = source.indexOf(first);
  const secondIndex = source.indexOf(second);
  expect(firstIndex, `missing ${first}`).toBeGreaterThanOrEqual(0);
  expect(secondIndex, `missing ${second}`).toBeGreaterThan(firstIndex);
}

describe("continuous autosave surface contract", () => {
  it("removes manual save, revert, and save-first gates from the rendered surface", () => {
    expect(`${rendererSource}\n${graphSource}`).not.toContain("Save or revert");
    expect(rendererHtml).not.toMatch(/id="(?:save-note|revert-note)"/);
    expect(functionSource("openNewNoteDialog")).not.toMatch(/\b(?:dirty|saving)\b/);
    expect(functionSource("closeTab")).not.toMatch(/\bdirty\b/);
  });

  it("flushes each renderer transition before the transition action", () => {
    const expectations = [
      ["createNewNote", 'tryFlushAllPaneAutosaves("new-note")', "window.threadleaf.createNote("],
      [
        "openTodaysDailyNote",
        'tryFlushAllPaneAutosaves("daily-note")',
        "window.threadleaf.openDailyNote(",
      ],
      ["closeTab", 'tryFlushPaneAutosave(paneId, "tab-close")', "window.threadleaf.closeNote("],
      [
        "reorderTab",
        'tryFlushAllPaneAutosaves("tab-reorder")',
        "window.threadleaf.reorderWorkspaceTab(",
      ],
      ["openNote", 'tryFlushPaneAutosave(paneId, "note-switch")', "window.threadleaf.openNote("],
      [
        "navigateHistory",
        'tryFlushPaneAutosave(paneId, "note-switch")',
        "window.threadleaf.goBack(",
      ],
      ["chooseVault", 'tryFlushAllPaneAutosaves("vault-switch")', "window.threadleaf.chooseVault("],
      [
        "requestWorkspacePaneFocus",
        'tryFlushPaneAutosave(outgoingPaneId, "pane-switch")',
        "window.threadleaf.focusWorkspacePane(",
      ],
      [
        "splitWorkspace",
        'tryFlushAllPaneAutosaves("pane-split")',
        "window.threadleaf.splitWorkspace(",
      ],
      [
        "moveTabToOtherPane",
        'tryFlushAllPaneAutosaves("pane-move")',
        "window.threadleaf.moveNoteToWorkspacePane(",
      ],
      [
        "closeActiveWorkspacePane",
        'tryFlushAllPaneAutosaves("pane-close")',
        "window.threadleaf.closeWorkspacePane(",
      ],
      [
        "moveCurrentAttachment",
        'tryFlushAllPaneAutosaves("note-mutation")',
        "window.threadleaf.moveAttachment(",
      ],
      [
        "relinkCurrentAttachment",
        'tryFlushAllPaneAutosaves("note-mutation")',
        "window.threadleaf.relinkAttachment(",
      ],
      [
        "exportCurrentNoteAsHtml",
        'tryFlushPaneAutosave(paneId, "note-mutation")',
        "window.threadleaf.publishNote(",
      ],
    ] as const;
    for (const [functionName, flush, action] of expectations) {
      expectOrdered(functionSource(functionName), flush, action);
    }
  });

  it("awaits renderer flush acknowledgements for blur, window close, and app quit", () => {
    expect(mainSource).toContain('requestWindowAutosaveFlush(window, "window-blur")');
    expect(mainSource).toContain('requestWindowAutosaveFlush(window, "window-close")');
    expect(mainSource).toContain('requestWindowAutosaveFlush(mainWindow, "app-quit")');
    expect(rendererSource).toContain("onAutosaveFlushRequest");
    expect(rendererSource).toContain("completeAutosaveFlush");
    expect(rendererSource).not.toContain('addEventListener("beforeunload"');
  });

  it("takes Relink source provenance from the rendered action rather than the root note", () => {
    const actionSource = functionSource("activatePreviewAttachmentAction");
    expect(actionSource).toContain("actionButton.dataset.threadleafAttachmentSourceNotePath");
    expect(actionSource).not.toContain("const sourceNotePath = loadedNote?.path;");
  });
});
