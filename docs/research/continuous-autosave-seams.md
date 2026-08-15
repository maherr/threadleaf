# Continuous autosave seams

Threadleaf continuously autosaves a writable note after 1.5 seconds without another document
change. It also awaits the latest editor version before any transition that can replace a document,
change its vault or pane ownership, bind a note mutation to a revision, close a window, or quit the
application. This note records the upstream decision boundary and the local proof required to keep
that behavior safe.

## Upstream evidence and disposition

| Source | Authority | Finding | Disposition |
|---|---|---|---|
| [Electron BrowserWindow close event](https://www.electronjs.org/docs/latest/api/browser-window#event-close) | Official API | Window close is cancelable before the native window is destroyed. | Depend on `preventDefault()`, await the renderer acknowledgement, then close once. |
| [Electron app before-quit event](https://www.electronjs.org/docs/latest/api/app#event-before-quit) | Official API | Application quit can be delayed by preventing the event. | Depend on one fail-closed autosave preflight before runtime cleanup and final quit. |
| [CodeMirror transactions](https://codemirror.net/docs/ref/#state.Transaction) | Official API | Document replacement and selection can be represented as an editor transaction with ordinary history annotations. | Adapt recovery into one transaction so the recovered edit remains undoable. |
| [Zed pull request 36929](https://github.com/zed-industries/zed/pull/36929) | First-party merged implementation history | Delayed autosave must flush when a file closes or a confirmation can race the timer. | Extract the transition-flush invariant, not Zed's implementation. |
| Threadleaf's isolated Obsidian behavior lab | Local black-box reference | A synthetic edit persists after idle, exit, and reopen without a manual save gesture. | Benchmark the user-visible behavior with disposable state. No implementation material is read or copied. |

No generic autosave framework owns Threadleaf's revision, pane, recovery-journal, watcher, and
conflict-copy contracts together. The implementation therefore reuses the existing safe writer and
adds only a renderer-side debounce coordinator plus a narrow main-to-renderer flush handshake.

## Local invariants

- The canonical write path remains renderer to preload to validated main IPC to workspace runtime to
  the revision-aware recoverable writer.
- One coordinator belongs to each mounted pane. A background-pane save reconciles that pane without
  changing focus.
- A timer coalesces edits, but an explicit transition flush waits for any in-flight write and then
  persists every newer observed version.
- An external revision winner is never overwritten. The local proposal becomes a labeled conflict
  note through the existing writer.
- Read-only vaults never produce a write snapshot.
- The shorter private draft debounce remains a crash safety net. Canonical autosave clears only the
  matching draft identity.
- Renderer recovery applies the protected draft as one CodeMirror transaction. Undo returns to the
  canonical bytes; redo restores the recovered edit.
- Window close and application quit fail closed if the renderer reports a write failure or does not
  acknowledge before the bounded timeout.
- There is no manual Save or Revert surface, shortcut target, native menu item, dirty-navigation
  blocker, or prompt. Undo is revert.

## Executable proof

The unit contract covers debounce coalescing, edits during an in-flight write, every declared flush
reason, retry after failure, read-only no-write behavior, main-process acknowledgement identity and
timeout, background-pane reconciliation, external conflict copies, and the absence of retired UI
gates. The X11 production checks exercise idle autosave, edit then switch, new note while autosave is
pending, close tab mid-edit, crash-draft recovery, Undo as recovery revert, export after a pending
edit, and application close. The behavior lab compares exact edit, idle autosave, exit, and reopen
bytes against the isolated reference app. `pnpm run check` remains the repository-wide gate.
