# Filesystem-truthful navigator and folder management

**Discovery date:** 2026-08-16
**Scope:** a bounded local-source and public-HTTPS review for representing the visible physical
vault in Threadleaf's Files navigator. No upstream repository was cloned, built, installed, or
executed. No upstream code is copied.

## Decision in one screen

**Add a contained, read-only physical inventory beside the Markdown metadata index.** The Files
navigator uses the physical inventory for folders, Markdown notes, JSON Canvas documents, and
ordinary files. Search, links, tags, note summaries, and the flat Notes view continue to use the
metadata index.

The inventory owns a separate opaque generation. A path-set change rotates that generation, while
a content-only Markdown edit does not. A scan builds its candidate outside the index mutation lock,
then publishes only if no newer invalidation won the race. A failed scan never publishes a partial
tree: Threadleaf retains the last complete projection, marks it degraded, and retries on the next
request.

This lane remains read-only except for the existing guarded New folder action. Generic preview,
rename, move, and trash are not inferred from note behavior and are not added here.

## Local invariants

| Seam | Decision | Proof obligation |
| --- | --- | --- |
| Authority | Keep physical inventory and Markdown metadata as separate projections | A non-Markdown file can rotate the Files generation without rotating the note index. A content-only note edit can rotate the note index without rotating Files. |
| Startup | Defer the first physical scan until the initial metadata census succeeds or fails | First paint remains non-blocking and reports Files as warming instead of hiding a synchronous second scan. |
| Concurrency | Scan outside `WorkspaceRuntime`'s index-state tail and publish through a short guarded section | Folder creation and other mutations remain available during a slow scan; an invalidated candidate cannot overwrite newer state. |
| Failure | Retain the last complete projection, expose a stable safe error, and retry | No partial arrays, invented empty vault, or stale-current claim may escape after a scan error. |
| Visibility | Reuse the kernel's broad visible-path policy | Every dot-prefixed segment, private transaction artifact, broken link, outside target, private target, directory symlink, and unsupported special file stays absent. A contained visible file symlink may appear as a file alias. |
| Shape | Model exactly `folder`, `note`, `canvas`, and `file` | Empty folders survive. Leaf rows expose only kind, path, and title. Folder rows additionally expose immediate visible child count. |
| Ordering | Use folder-first, locale-independent natural ordering | ASCII digit runs compare numerically. Accent and case folding is the primary key, normalized raw text is secondary, and raw code points break the final tie. Ambient locale APIs are not authority. |
| Renderer | Keep bounded immediate-child pages and the existing virtual projection | A 200,000-entry root does not become one renderer payload or one DOM node per entry. |
| Activation | Route notes and Canvas through the existing document action; keep ordinary files inert | An ordinary file is focusable and explains that preview is unavailable, but does not call `openNote`, create a tab, change selection, or become current. |
| Mutation | Keep New folder on the existing contained kernel path | An empty created folder appears after physical inventory convergence. No generic rename, move, or trash surface is introduced. |

## Coverage ledger

| Seam | Source | Authority and useful claim | Disposition and boundary |
| --- | --- | --- | --- |
| Filesystem events | [Linux `inotify(7)`](https://man7.org/linux/man-pages/man7/inotify.7.html) | Primary platform documentation: watches are not a recursive inventory and event queues can overflow | **Adapt.** Events invalidate the projection; they never become the complete tree. Linux details do not define the cross-platform public contract. |
| Change clocks and fresh-instance boundaries | [Watchman clockspec](https://facebook.github.io/watchman/docs/clockspec) and [file query](https://facebook.github.io/watchman/docs/file-query) documentation | First-party watcher design: queries bind change observations to a clock and can require a fresh-instance response | **Extract.** Use opaque generations and explicit stale responses. Do not add Watchman or copy its protocol. |
| Event acceleration versus truth | [Git fsmonitor daemon](https://git-scm.com/docs/git-fsmonitor--daemon) | First-party Git documentation: filesystem monitoring accelerates discovery, while Git still owns worktree truth | **Adapt.** Keep watcher batches as hints and a complete contained scan as the Files authority. Do not make the Git index or fsmonitor a dependency. |
| Validators | [RFC 9110 conditional requests](https://www.rfc-editor.org/rfc/rfc9110.html#name-conditional-requests) | Normative validator model: a consumer can bind a request to a selected representation and reject stale state | **Extract.** Page and path requests carry one inventory generation. This is a local opaque token, not an HTTP ETag claim. |
| File provider shape | [VS Code FileService at `86b64aa`](https://github.com/microsoft/vscode/blob/86b64aa4bc0afb6973d9394f9044bd4fff29a088/src/vs/platform/files/common/files.ts), MIT | First-party implementation and public contract: stat, directory reads, change events, typed entries, no-overwrite moves, descendant rejection, and provider capabilities are separate concerns | **Extract and adapt behavior only.** Preserve typed rows, no-clobber requirements, and directory paging. No VS Code source or dependency enters Threadleaf. |
| Desktop file operations | [KDE KIO CopyJob](https://api.kde.org/kio-copyjob.html) and [FileUndoManager](https://api.kde.org/kio-fileundomanager.html), revision `v6.17.0-51-g00b8217fa`, LGPL-2.0-or-later | First-party API and source documentation: move, rename, mkdir, trash, operation serials, capability checks, and inverse operations need explicit semantics | **Extract for the deferred mutation contract.** Threadleaf requires its own restart-durable journal; it does not import KIO or treat process-memory undo as recovery. |
| Cross-platform file semantics | [Syncthing `v2.1.1`](https://github.com/syncthing/syncthing/releases/tag/v2.1.1), commit `6be1ff8`, MPL-2.0 | First-party watcher and scanner behavior: root containment, no symlink descent, overflow-to-root invalidation, watcher-error scans, and special-file exclusion | **Depend on the behavioral proof and adapt locally.** Test ordinary files, empty folders, contained and escaping symlinks, broken targets, external convergence, and no special files. No Syncthing code or database is used. |
| Durable publication | [restic `v0.19.1`](https://github.com/restic/restic/releases/tag/v0.19.1), commit `6aa3a51`, BSD-2-Clause | First-party local-backend design: temporary sibling, length check, file sync, close, rename, directory sync, cleanup, bounded locking, and interruption reconciliation | **Extract for future mutation recovery.** Reject restic's object/index graph as Files authority. No restic code is copied. |
| Negative authority model | [Joplin `v3.6.15`](https://github.com/laurent22/joplin/releases/tag/v3.6.15), commit `c615726`, AGPL-3.0-or-later | First-party sync design intentionally makes database and resource objects authoritative over ordinary user filenames; its local driver also lacks a reliable filesystem delta API | **Reject as the Files model.** Benchmark only the explicit model/resource separation. Physical visible entries remain authoritative in Threadleaf, and no AGPL source is reused. |
| Tree interaction | [WAI-ARIA APG tree view](https://www.w3.org/WAI/ARIA/apg/patterns/treeview/) | W3C authoring guidance for `tree`, `treeitem`, expanded state, roving focus, and keyboard navigation | **Depend on the behavior contract.** It does not choose inventory authority, path policy, or mutation semantics. |
| Existing scale seam | `src/renderer/navigator-tree.ts`, `src/renderer/virtual-list.ts`, and `benchmarks/navigator-tree-scale.ts` | Local architecture authority for sparse pages, retained-page bounds, and virtual DOM | **Depend.** Replace the tree's source generation, not its bounded renderer architecture. |

## Two independent expansion passes

### Pass 1: watchers, validators, and consistency

Linux, Watchman, and Git independently reject the idea that an event stream is a complete,
permanent directory model. Queue overflow, fresh watcher instances, missed ancestry, and external
writers all require a current observation. RFC validator semantics reinforce binding each consumer
request to one chosen representation.

This pass changed the candidate from a watcher-maintained delta tree to an invalidated complete
snapshot. It also split the physical generation from the metadata generation: the two projections
observe different facts and must not force unrelated churn onto each other.

### Pass 2: file providers, sync tools, and renderer behavior

VS Code and KIO require typed entries, explicit directory operations, capability checks, and
no-clobber semantics. Syncthing independently supplies the strongest scan and symlink evidence,
while restic supplies a future durable-publication pattern and Joplin provides the negative model
where an application database intentionally outranks ordinary filenames. The WAI-ARIA tree pattern
and Threadleaf's existing scale model then constrain presentation without changing authority.

This pass added explicit empty folders, ordinary files, JSON Canvas, immediate child counts, and a
contained file-symlink allowance. It rejected folder-symlink traversal and a note-only leaf model.
It did not justify a third-party tree dependency or broader write authority.

A post-synthesis independent review found no candidate that changed authority, disposition, risk,
proof, or implementation order. The upstream decision gate is therefore closed for this lane.

## Chosen local shape

1. `VaultPathPolicy.listVisiblePaths()` returns a complete typed visible observation. It checks a
   relative starting directory one lexical segment at a time before resolving it, so a caller
   cannot hide a directory symlink in any ancestor of the requested scan root.
2. `WorkspaceRuntime` converts that observation into one immutable inventory projection containing
   sorted file paths, sorted physical folder paths, a paged tree model, and a path-location index.
3. Every invalidation increments a private sequence. One scan may run at a time. Candidate work is
   outside the index lock; guarded publication accepts it only when its sequence still matches.
4. Equal file and folder path sets consume the invalidation without changing the public generation.
   This keeps content-only writes from invalidating the Files tree.
5. Tree page requests are `{ generation, parentPath, offset, limit }`. Missing physical parents are
   explicit. Tree path requests return the page locations required to reveal one current note or
   Canvas without a full renderer traversal.
6. Renderer rows use exact typed activation and labels. Generic files are inert, notes and Canvas
   use the established document path, and folders alone expose `aria-expanded`.
7. Existing flat search, tags, and Notes list remain metadata-indexed. The existing Canvas shelf
   remains available while Canvas also appears in Files.
8. A stale or degraded tree-page response clears the bounded renderer projection and single-flights
   one authoritative snapshot refresh. Restored nondeferred startup seeds the same immutable
   inventory from its restore observation instead of immediately scanning the physical root again.

## Required executable proof

- Unit-test exact row keys, explicit empty folders, immediate child counts, deterministic numeric,
  punctuation, case, accent, NFC, and NFD ordering, hidden-path filtering, and path locations.
- Test contained file aliases plus direct and ancestor directory aliases, broken, outside, private,
  and unsupported special-file exclusions through the real path policy.
- Pause an inventory scan, complete a mutation while it is paused, invalidate the candidate, and
  prove the retry publishes only the newer state.
- Force a scan failure after one good projection, prove the last good tree remains degraded, and
  prove the next request retries to current without generation churn.
- Drive real pointer and Enter activation for note, Canvas, and ordinary file rows in isolated X11;
  positively arm a bridge-function breakpoint and prove both ordinary-file paths make zero
  `openNote` calls in addition to leaving pane and tab state unchanged.
- Prove initial and created empty folders, WAI-ARIA coordinates, one roving tab stop, both themes,
  a 720-pixel viewport, a 1,001-child virtual folder, and a 128-level active reveal.
- Hash every source-vault directory, file byte stream, mode, and symlink target after deliberate
  fixture mutations, then require an identical manifest after browsing and restart.
- Run the 200,000-entry benchmark and the complete repository gate.

## Rejected candidates and deferred mutations

- **Rejected:** derive Files from the Markdown metadata index. It hides empty folders, Canvas, and
  ordinary attachments and assigns one generation to two different facts.
- **Rejected:** maintain the authoritative tree by replaying watcher deltas. Overflow, missed events,
  watcher restart, and external writers make that an optimization without a truth source.
- **Rejected:** expose raw filesystem access to the renderer. It would bypass containment, private
  path policy, vault identity, and bounded IPC.
- **Rejected:** traverse folder symlinks. A contained target can still introduce cycles, duplicate
  physical ancestry, and unstable parent identity. A contained file symlink is a bounded leaf alias.
- **Rejected:** add a third-party tree or file-provider dependency. Existing local paging, virtual
  list, path policy, and kernel ports already cover the required seams.
- **Deferred:** generic file preview and OS-open behavior. This lane names the boundary and keeps the
  row inert rather than quietly granting shell or attachment-read authority.
- **Deferred:** file and folder rename, move, and trash. The existing Markdown operations do not
  prove no-replace publication, recovery journaling, link impact, directory ancestry, symlink, and
  cross-type behavior for arbitrary filesystem entries. Those mutations require a separate native
  contract and interruption matrix before controls appear.
