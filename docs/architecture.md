# Architecture

The [alternatives landscape review](research/alternatives-landscape.md) is an input to these
decisions. It found that feature breadth is common, while migration continuity, watcher recovery,
plugin continuity, packaging, and contributor depth remain the adoption bottlenecks.

## Current decisions

### Desktop compatibility host

Threadleaf starts as an Electron and TypeScript desktop application. Existing plugins commonly
assume Chromium, the DOM, Node.js, and Electron behavior. Matching that environment reduces the
compatibility problem before optimization begins.

The primary application renderer remains isolated with `contextIsolation`, no Node integration,
and Chromium sandboxing. DOM-dependent community plugins cannot execute in the main-process host or
inside that sanitized renderer. Each enabled community plugin runs in its own explicitly trusted
`WebContentsView` with Node integration, a unique transient session partition, denied browser
permissions, blocked navigation and popups, and `connect-src 'none'` for browser requests. This
does not sandbox Node-capable plugin I/O. The main process communicates with each realm through
validated typed request and response messages, times out every operation, attributes renderer
exits, and never gives the primary renderer Node authority. A timeout, invalid protocol response,
failed send, or renderer exit is fatal only to the owning plugin process. Threadleaf forcibly
terminates that realm, creates a clean replacement, and retains the culprit as stopped diagnostic
state until the user explicitly reloads it. Healthy sibling plugins and the native workspace keep
running, and no plugin is replayed automatically after an unknown failure point. The unchanged
Excalidraw 2.25.3 bundle activates in this production realm
and its registered `ItemView` now attaches to a bounded visible workspace leaf. The plugin owns the
leaf content, filename header, action icons, modal content, and canvas lifecycle; Threadleaf owns
the surrounding layout and propagates its light/dark chrome. The normal Markdown header is not
mounted inside a plugin-owned view. Text-file reads cache the revision delivered by the main
process. A compatibility `Vault.modify` request must name a file from that vault and present the
cached revision; validated requests cross narrow IPC, bind to the still-active vault identity, and
enter the same workspace controller and recovery-backed writer as native edits. Conflicts leave the
original untouched and retain the plugin's proposed bytes as a labeled conflict file. Opening an
existing Excalidraw Markdown document, mutating its scene, explicitly saving, closing the drawing
leaf, and reopening the persisted scene reaches measured level 4 for that named workflow. Creating
a new drawing now crosses separate create-folder and create-file IPC channels into the same
workspace controller and recovery-backed kernel used by native note creation. The kernel rejects
private paths, symlink traversal, and existing destinations; syncs created directories; and never
activates the new file in Threadleaf's native Markdown workspace on behalf of plugin code. The
compatibility runtime supplies Moment, Obsidian's loaded-plugin lifecycle flag, built-in Markdown
leaves, workspace layout snapshots, and split-leaf creation so the unchanged Excalidraw command can
create its standard folder and Markdown file, pass through a Markdown leaf, and promote that leaf
to the registered drawing view. Creating a drawing, adding scene elements, saving, closing, and
reopening the exact scene reaches measured level 4 for that named workflow. Opening Threadleaf's
command palette now detaches only the child surface presentation, not the plugin leaf or renderer,
so a selected plugin command can act on the still-live Excalidraw view before the child surface is
reattached. The compatibility module also supplies frontmatter-entry lookup plus `Vault.createBinary`
and `Vault.modifyBinary`. Text and binary export requests cross separate validated IPC channels,
remain bound to the active vault and cached revision, and enter the recovery-backed writer without
UTF-8 conversion. Excalidraw's unchanged SVG-to-vault and PNG-to-vault actions both create and
overwrite valid exports; PNG verification checks the exact signature and decodes the resulting
803 by 549 image.

### Filesystem authority

Markdown and attachments remain authoritative. Search indexes, metadata graphs, and caches must be
rebuildable from those files. Phase 0 has no user-vault write API.

Threadleaf uses an application-owned state root outside every vault. `.obsidian/` is read as
compatibility input when needed but is never Threadleaf's state directory. The vault kernel accepts
the state root through a port so tests can isolate it and each operating system can use its standard
application-data location.

### Behavior migration boundary

Migration is separate from vault opening and plugin discovery. A read-only main-process loader
inspects a fixed set of bounded `.obsidian` JSON sources through realpath containment, then returns
only typed summaries to the sandboxed application renderer. Plugin settings summaries contain byte
length, JSON root kind, and top-level entry count, never keys or values. Plugin JavaScript is not
loaded. Malformed parser details are reduced to generic diagnostics so source fragments cannot be
reflected into the UI.

The preview combines Obsidian-enabled plugin IDs with Threadleaf's independently discovered package
catalog and exact-version workflow evidence. Hotkeys, appearance, and workspace paths become
candidates only through reviewed mappings and contained file checks. Main-area Markdown and
Excalidraw note tabs are previewable; every unsupported workspace view remains an explicit count.
The loader has no write port, and the renderer exposes no Apply action. A future apply transaction
will write only Threadleaf's private versioned settings after per-item review. The full source,
candidate, and limit contract is documented in [Obsidian behavior migration](compatibility/migration.md).

### Compatibility module

Existing plugin bundles request `require("obsidian")`. Threadleaf supplies an independently
implemented module at that boundary. The host loads `manifest.json`, `main.js`, and optional
`styles.css`, constructs the exported plugin class, and owns its lifecycle.

The first spike uses a trusted CommonJS execution host. It is not a security sandbox. Native
Threadleaf extensions will use a separate capability-based runtime.

### Application boundaries

The kernel and domain model do not import Electron, renderer code, or concrete operating-system
adapters. Filesystem, watcher, metadata, settings, plugin, and shell access cross explicit ports.
Concrete adapters compose those ports in the main process.

User intentions live in application services. State stores remain side-effect-free. Reactors own
automatic effects such as autosave, watcher reconciliation, index refresh, and persistence. A
single action registry dispatches each command from menus, hotkeys, the command palette, plugins,
and visible controls.

Features are vertical slices with an enforced dependency direction:

```text
UI -> action registry -> application service -> domain/kernel port -> adapter
```

The renderer may observe state and dispatch actions. It does not write vault files directly.

### Vault selection and runtime swaps

The main process owns vault selection. A native folder picker returns one absolute path through a
narrow preload contract. The candidate runtime must open successfully, produce a snapshot, and
persist its canonical path before the workspace controller adopts it. If validation or persistence
fails, Threadleaf closes the candidate and leaves the current runtime active.

The selection document lives in the operating system's application-data directory, outside every
vault. It is written atomically with private file permissions and a versioned shape. On startup,
Threadleaf opens a small plugin-free bootstrap runtime, registers IPC, and renders the first window
before it opens the configured or restored vault. A startup snapshot names the real target and
disables bootstrap writes and search while the target builds its derived index. Open vault remains
available. After the first bootstrap render, the sandboxed renderer sends a one-way shell-ready
signal; only then may the main process begin restored-vault activation. A generation guard prevents
a late restore from replacing a vault picked while it was opening. The target bootstrap reads each
visible Markdown file once and uses the same stable byte snapshots to seed both watcher state and
the derived metadata index. Metadata construction yields to the event loop at bounded intervals so
window and IPC work remain serviceable during a large build. The watcher starts from that exact
observation and reconciles later filesystem events instead of repeating the initial corpus read.
Environment overrides are never persisted. After adoption, Threadleaf reconciles only the plugins
explicitly selected in its private per-vault settings. A vault with no saved plugin preference
starts restricted. An unavailable or malformed saved selection falls back to the bundled fixture
with a visible warning and does not erase the saved path, so a temporarily unmounted vault can
recover on a later launch.

Every editor draft carries the identity of the vault that produced its revision. The save boundary
rejects a draft after the active vault changes, even if a relative note path happens to exist in
both vaults. The renderer also blocks user-initiated switching while a note is unsaved. Explicit
development overrides take precedence without changing the persisted user selection and are
ignored by packaged builds.

The active unsaved draft is also mirrored into a versioned document under the operating system's
application-data directory after a short debounce. That private document contains the exact vault
identity, normalized Markdown path, base revision, draft bytes, selection, draft identity, and
canonical update time. It is bounded, validated again in the main process, serialized with other
draft writes, and replaced atomically with mode-0600 permissions. Save and Revert clear only the
matching draft identity, so a delayed cleanup cannot delete a newer edit. Malformed recovery bytes
fail visibly and remain available for diagnosis.

CodeMirror gets a fresh editor state when the active document changes, preventing undo history from
crossing notes. A successful save adopts the new disk revision without replacing that state, so
selection and useful undo history remain. If the sandboxed main renderer stops, the main process
creates and loads a replacement window before retiring the failed window. The replacement restores
the exact private draft and selection. A changed or missing disk revision remains untouched and a
later save uses the ordinary conflict-copy boundary.

### Workspace panes, tabs, and draft ownership

The workspace runtime owns one or two panes. Each pane has an ordered, deduplicated list of open
Markdown paths and one active path; the layout also records the focused pane and a horizontal or
vertical split direction. Opening an existing entry reactivates it in that pane. Closing the active
entry selects the next entry to its right, then the nearest entry to its left. Tabs move explicitly
between panes, and closing the secondary pane transfers its remaining tabs without discarding an
unsaved draft. Incremental watcher moves remap open paths and deletions remove them, while every
published snapshot filters both lists against the current derived index. Each navigation request
carries the expected vault identity, so a delayed renderer action cannot target a similarly named
note after a vault switch.

Panes and tabs are derived workspace state stored per vault in a versioned document under the
operating system's application-data directory. The store keys documents by vault identity,
validates and normalizes every path, writes atomically with private file permissions, and never
writes layout files into the vault or `.obsidian/`. Its in-memory version 2 model restores exact tab
order, active notes, focused pane, and split direction. The on-disk document uses a version 1
envelope whose ordered tabs and active path are an exact projection of the focused pane, plus a
`layoutVersion: 2` extension containing the complete layout. This lets the previous daily-driver
build reopen the focused-pane projection during rollback while the current build rejects any
mismatched projection or malformed extension. Missing notes are pruned and repaired state is
persisted. An explicit empty document restores an empty workspace instead of falling back to the
first note. Malformed state fails visibly without rewriting the invalid bytes.

The renderer retains the complete ordered file projection for filtering and navigation, but mounts
only the visible fixed-height rows plus a small overscan window. Spacer geometry preserves native
scroll range, while each mounted row exposes its absolute position and total set size to assistive
technology. Active-note navigation moves the virtual window to the nearest required range rather
than creating one DOM node per vault file.

Pure navigation changes persist before the runtime adopts them, so a failed write cannot create
layout state that silently disappears after restart. A vault mutation that already committed
remains committed even if the following workspace-state update fails; the runtime adopts the real
vault result and reports the persistence warning instead of falsely reporting that the vault write
failed. The renderer owns one mounted CodeMirror editor and one private draft identity per pane,
rather than hidden unsaved drafts for every tab. A dirty pane therefore blocks actions that would
replace or discard that pane's active document, while the other pane retains independent
selection, history, and draft recovery. Vault switching remains blocked until every dirty pane is
saved or reverted. Closing an inactive tab remains safe because it cannot discard either mounted
draft.

The native application menu is constructed in the main process with platform roles for ordinary
editing and window behavior. Product commands and accelerators are derived from the same saved key
bindings as renderer controls, then dispatched over the narrow bridge to the focused workspace.
The menu therefore adds an operating-system entry point without creating a second command model.

### Application settings and key bindings

Threadleaf settings live in a versioned document under the operating system's application-data
directory, never in the active vault or `.obsidian/`. The store validates and normalizes the whole
document, writes it atomically with private file permissions, and only then lets the settings
controller publish and adopt the new snapshot. A failed write therefore cannot create active state
that disappears on restart.

Malformed settings fail visibly to a complete default snapshot without rewriting the invalid file.
This preserves the original bytes for diagnosis and lets a temporarily incompatible future file
recover after the application is updated. Unknown future binding IDs survive normalization, while
the narrow IPC mutation surface accepts only shortcut targets known by the running build.

Portable bindings use `Mod` for Ctrl on Windows and Linux and Command on macOS. Shared parsing,
normalization, event matching, display, and collision validation keep persistence and renderer
behavior on one contract. The settings surface records or clears one binding at a time, rejects
duplicates before persistence, and resets all bindings through the same durable path. Keyboard
events resolve to action IDs. Workspace and editor targets then use the same renderer command
catalog as visible controls and the command palette.

### Appearance boundary

Threadleaf treats a vault's Obsidian theme and snippet folders as read-only compatibility input.
The main process discovers `.obsidian/themes/<folder>/theme.css` plus optional `manifest.json`
metadata and `.obsidian/snippets/*.css`. It never uses those directories for Threadleaf state.
Per-vault color scheme, theme ID, and ordered snippet IDs live in the versioned application settings
document under a SHA-256 vault identity. Version 1 and 2 settings migrate to version 3 with empty
maps for any settings surface they predate.

The loader resolves real paths and requires every theme, manifest, and snippet to remain inside its
expected vault directory. Theme CSS is limited to 2 MiB, each snippet to 512 KiB, each manifest to
64 KiB, the combined active CSS to 4 MiB, and each catalog to 256 entries. Text must decode as
UTF-8. The loader rejects imports, direct external URLs, and legacy executable CSS constructs.
Embedded data and fragment URLs remain available; variable URLs remain subject to the renderer's
network-blocking content-security policy.

The renderer applies the base light or dark contract first, one selected theme second, and enabled
snippets in their persisted order last. It exposes common Obsidian variables and workspace class
aliases without giving custom CSS filesystem or script authority. Application startup can suppress
custom CSS with `THREADLEAF_SAFE_APPEARANCE=1` or `--safe-appearance`. The settings catalog remains
visible in safe mode, and a remappable recovery action clears the saved custom selection while
retaining the base color scheme. Missing and invalid assets produce visible warnings and leave the
rest of the workspace usable.

Discovery is explicit in this phase. The user reloads changed files from Settings or the command
palette; a future watcher must preserve the same containment, stale-vault, diagnostics, and safe
mode boundaries. See the [theme compatibility contract](compatibility/themes.md).

### Community plugin lifecycle boundary

Threadleaf treats `.obsidian/plugins/<id>/manifest.json`, `main.js`, and optional `styles.css` as
read-only compatibility input. Discovery validates identity, UTF-8 text, file type, realpath
containment, and byte limits before a package is eligible to run. Installed inventory does not
imply enablement. The enabled IDs, restricted-mode choice, and exact-bundle authority grants live in
version 4 private application settings under the vault identity. Version 3 settings migrate without
grants, so previously selected bundles remain blocked until reviewed.

Discovery also creates a pre-enablement report. It presents the manifest's minimum Obsidian API
version and desktop-only flag, explains that the standard package model bundles external
dependencies into `main.js` rather than declaring a cross-plugin dependency graph, and attaches
only exact-version workflow evidence. The same bounded read computes an exact raw-byte bundle
digest and a conservative static report over observed authority classes. A grant binds that digest
and report to one vault. Any bundle-byte change makes it stale. JavaScript and CSS remain blocked
without a current grant, and the main process enforces the gate independently of renderer controls.
The execution renderer re-hashes those bounded raw bytes immediately before compilation, closing
the path-replacement window between discovery and execution. A plugin or version without a
production-path fixture stays at level 0. Evidence from another release is shown as historical
context, not inherited as a compatibility claim.

Package acquisition is a separate two-step boundary. A replaceable source adapter currently reads
the public compatibility registry and exact GitHub release assets, requires a repository license at
the same release tag, and stages bounded bytes in private application data. Preview is read-only to
the vault. Apply is bound to the reviewed vault, plugin, version, source digest, asset digests, and
the complete installed-tree revision observed before review. Rollback is additionally bound to the
full retained-package tree revision and every reviewed retained asset. The main process removes
that plugin from the private enabled set and unloads it before any package mutation. No install,
update, reinstall, rollback, uninstall, or restore operation executes the resulting bundle.

Each apply writes a private transaction journal before creating a transaction-owned staging
directory under `.obsidian/plugins`. Complete prior package and private metadata snapshots remain
available through four durable phases: intent, staged, package-mutated, and metadata-committed.
Directory replacement uses same-parent renames and keeps the old directory at a transaction-owned
rollback path until private receipt and inventory writes are durable. Startup recovery restores the
exact pre-operation directory and metadata for an earlier phase when its evidence still matches. A
metadata-committed journal keeps the reviewed result and only finishes cleanup. Recovery compares
full deterministic tree digests before moving or removing transaction paths; externally changed
bytes are preserved and the package remains disabled. Retained rollback history is pruned only
after commit.

Updates and reinstalls overlay reviewed code assets onto a complete copy of the prior directory, so
plugin data remains. Rollback overlays retained code and license assets onto current data.
Uninstall retains the complete directory before removal, and restore can recover it. Both the vault
receipt and its private counterpart cover the manifest, bundle, optional stylesheet, and retained
license. A mismatch blocks activation until a new review.

The main process serializes catalog and lifecycle operations so activation cannot race a vault
switch or another enablement change. Reconciliation unloads runtime instances that are no longer
selected, then activates each remaining selected package independently. One activation failure is
retained as diagnostic state and does not prevent later packages from loading. Reload performs a
clean unload before activation. Workspace shutdown unloads every instance.

Each compatibility plugin runs in its own isolated renderer and transient session partition. Every
request has a bounded deadline. If a request wedges, violates the protocol, fails to send, or loses
its renderer, Threadleaf terminates only that plugin process. A fresh renderer receives the same
vault boundary and surface policy when the user explicitly reloads the culprit. Healthy siblings
and the sandboxed native workspace continue running. Per-plugin CPU and memory budgets remain
future work.

Lifecycle ownership includes commands, event registrations, view and extension factories,
processors, editor suggestions, ribbons, status items, settings tabs, leaves, and transient modals
that retain a direct reference to their creating plugin. Targeted unload closes only that plugin's
owned modals and views before releasing its remaining registrations. Reload must reconstruct the
same inventory without duplicates; a second plugin's modal is an explicit negative control.

Plugin CSS crosses a separately bounded and CSP-constrained renderer channel. It is applied only
for selected packages while compatibility mode is enabled and the exact bundle grant is current.
Imports and legacy executable CSS are rejected. Other non-embedded asset URLs are replaced with
inert data URLs and reported before the remaining stylesheet is applied.
`THREADLEAF_SAFE_PLUGINS=1` and `--safe-plugins` suppress both JavaScript and CSS without changing
saved settings. Safe mode and restricted mode remain distinct: safe mode is a process recovery
boundary, while restricted mode is a persisted vault preference.

The current CommonJS hosts are trusted compatibility runtimes, not security sandboxes. Static
authority reporting makes trust reviewable and revocable but does not enforce runtime permissions.
The host exposes only the independently implemented API surface backed by executable fixtures.
Installed plugins outside that surface can fail during activation and are not claimed compatible
merely because discovery succeeds. See the
[community plugin compatibility contract](compatibility/plugins.md).

### Watcher and index model

Filesystem notifications are hints, not truth. The watcher emits debounced batches with a stream
ID, monotonic sequence number, and explicit path-state or move operations. Split renames are paired
within a bounded window. Overflow, backend errors, ambiguous renames, and sequence gaps request a
subtree scan or full rebuild instead of guessing.

Non-Markdown filesystem activity publishes an empty sequenced batch without hashing attachment
bytes. This invalidates reading-view asset requests while keeping binary files out of the metadata
index. The next image request performs its own stable, bounded read.

Ordinary discovery and watcher publication exclude every path containing a dot-prefixed segment,
including `.obsidian/`, `.git/`, and `.trash/`. Explicit compatibility APIs may still perform a
contained direct read of a named hidden resource when an enabled plugin requires it. That narrow
read does not add the resource to navigation, search, backlinks, or watcher-derived note state.

The metadata index is derived state. Its immutable snapshot and the workspace's maps, backlinks,
and file summaries are cached only for the current index generation. After every accepted mutation
sequence, its externally visible state must equal an index rebuilt from the current vault bytes.
Tests compare incremental and clean rebuild snapshots for additions, edits, deletions, renames,
unresolved links, duplicates, and recovery.

The Phase 1 Markdown parser deliberately covers a documented structural subset: headings, basic
frontmatter scalars and lists, tags, wiki links, embeds, and local Markdown links. Its link resolver
is provisional. Obsidian-equivalent edge semantics remain gated on the executable behavior corpus
in Phase 3 rather than being inferred from filenames or third-party compatibility claims.

### Full-text search

Full-text search is another disposable projection of saved vault bytes. It never writes a canonical
database and intentionally excludes dot-prefixed paths and Threadleaf transaction artifacts from
the note corpus. The same index reactor that maintains links updates search documents after
internal saves, external edits, moves, deletes, subtree rescans, and full rebuilds. An unsaved editor
draft does not appear until it crosses the recoverable save boundary, which the UI states plainly.

Queries are bounded to 256 characters, 12 distinct AND terms, and at most 100 returned documents.
Quoted text is one phrase. Exact folder scopes are applied before result limiting, and an explicit
case-sensitive mode selects NFC-normalized original text rather than the default case-folded index.
Ranking favors exact titles, then title, tag, heading, path, property, and body evidence; results
retain bounded contextual lines and source line numbers. Every response carries the active vault ID
and monotonic index generation. The renderer rejects a response that no longer matches its current
vault, query, or generation and immediately requests the current result.

The initial index is an in-memory normalized scan. That is the simplest correct implementation and
already clears the current interactive scale baseline. `pnpm benchmark:search` measures rebuild,
rare-query, and deliberately broad-query behavior over a deterministic 10,000-note corpus. A future
inverted or SQLite FTS index must be earned by those measurements and preserve the same rebuildable
contract, rather than adding canonical database state speculatively.

### Live Preview, Source, Reading, and source mapping

Live Preview and Source are two presentations of the same CodeMirror document. A fresh install
starts in Live Preview, while each pane retains its current mode and the preferred editing mode is
stored as private application state outside the vault. Switching modes reconfigures decorations;
it does not replace the document, write the vault, or reset undo history.

The Live Preview layer derives decorations from the CodeMirror syntax tree. Presentation markers
are hidden only on lines outside the cursor or selection. Every selected line exposes exact source,
and clicking a rendered token moves the cursor into its source range before revealing it. Common
headings, emphasis, links, tasks, lists, quotes, callouts, code blocks, tags, local raster images,
and source-backed note-embed cards are covered by an isolated virtual-input corpus. Frontmatter,
tables, HTML, math, malformed or ambiguous constructs, and unsupported nesting stay visible as
source rather than becoming a lossy rendering. Task controls dispatch an exact source transaction,
so dirty state, undo, drafts, saves, conflicts, and recovery remain one path.

Reading view is an explicit document mode, not an implicit write or a second source of truth. It
renders the current CodeMirror draft, including unsaved changes, without crossing the main-process
write boundary. Switching modes stores only an application preference outside the vault.

The first renderer uses Markdown-it for deterministic block parsing and DOMPurify with a narrow
element and attribute allowlist. Raw HTML is accepted only after sanitization. Scripts, event
handlers, forms, styles, media elements, and active URLs are removed. Markdown images and
Obsidian-style wiki embeds first become inert placeholders. A dedicated read-only image service may
replace raster placeholders with sniffed PNG, JPEG, GIF, or WebP bytes. A separate note-embed
service resolves indexed Markdown identities and extracts either the whole note, one heading
through its descendants, or one block ID. It returns exact path, revision, source range, content
bytes, and nested-link summaries. The renderer sanitizes every returned fragment through the same
Markdown pipeline, then recursively hydrates its nested notes and raster images.

Both services receive the source note, raw target, and expected vault identity. The main process
resolves note-relative and vault-rooted paths, follows symlinks only within the vault, excludes
`.obsidian/`, `.git/`, and transaction artifacts, rechecks the active runtime after asynchronous
reads, and never returns a filesystem URL. Image reads are stable and limited to 10 MiB each. One
preview accepts at most 128 images and 64 MiB of decoded image input. Note reads are limited to 2
MiB each, 32 expanded fragments, 8 MiB of returned Markdown, and four recursive levels. A
path-and-subpath ancestry set stops cycles while allowing finite same-note section embeds.
Oversized, missing, ambiguous, external, malformed, unsupported, stale-vault, and out-of-vault
targets remain labeled placeholders. SVG and unsupported non-note wiki embeds remain inert.
External links also stay inert during beta rather than broadening IPC for shell access prematurely.

Every rendered top-level block carries its source line. A visible line control switches back to
source mode and selects that CodeMirror line. Internal wiki and Markdown links carry normalized
identities, but the derived metadata index remains authoritative for resolution status and target
paths. Dirty-note navigation is blocked and preserves the draft; no preview action silently saves
or discards text.

Live Preview currently maps at source-token and line granularity. Fine-grained cursor mapping inside
aliases and other compound tokens, full inline note transclusion, and richer complex-syntax
projections remain later work. They must preserve the same exact-source, bounded-read, and
no-implicit-write guarantees.

### Command-line boundary

Threadleaf exposes the same vault kernel and derived metadata behavior through a native headless
command-line interface. Human-readable output is the interactive default, while stable JSON and
explicit exit codes are first-class automation contracts. `vault info`, safe file and folder
inventory, Unicode word counts, `read`, `search`, and recovery-backed `create` run without Electron
and require an explicit vault path. Recovery-backed `append` and `prepend` extend that same headless
surface for existing notes. `links`, `backlinks`, `unresolved`, `orphans`, `deadends`, and `outline`
project the same rebuildable metadata snapshot used by the desktop. Their native JSON keeps link
resolution states and occurrence counts explicit instead of deriving a second graph model.
Compatibility output modes project that rich data into path-only search, grep-style context,
totals, counts, JSON, TSV, CSV, outline trees, and Markdown without changing index authority.

Recoverable `delete` moves exact note bytes to the same relative path under vault-local `.trash/`.
`trash list` exposes those entries without adding them to the ordinary note corpus, and `restore`
moves one back to its exact original path. Both directions use the kernel's revision-checked,
journaled rename. A collision at either path blocks without overwrite or an invented suffix, so the
trash path itself is sufficient recovery metadata. The CLI exposes no permanent-delete path.

Read-only kernel opening performs canonical path validation but creates no state directory, vault
identity, recovery journal, or watcher. The CLI has a broad visible-file inventory for ordinary
notes, attachments, Canvas documents, and empty folders, plus the narrower Markdown note corpus
used by the desktop index. Both exclude every dot-prefixed path segment and Threadleaf transaction
artifacts, including canonical targets reached through symlinks. File symlinks remain readable only
when their targets stay inside the visible boundary; recursive discovery does not traverse folder
symlink entries. Dedicated trash inspection is the only read-only exception.

An Obsidian-style compatibility facade may accept familiar public command names and arguments, but
it translates into Threadleaf's own typed command model. It does not make the GUI a hidden CLI
server, copy proprietary implementation details, or create a second mutation path. Every mutating
command uses the same containment, revision, recovery-journal, conflict, and watcher contracts as
the desktop application. See the [CLI guide](cli.md).

The desktop and CLI call one note-creation service. A shared bounded template reader layers exact
`title`, `date`, and `time` expansion over that service without changing Markdown authority. Daily
notes derive a contained Markdown path from per-vault folder and Moment-compatible date-format
settings, read it before mutation, and never rewrite an existing note. Desktop workflow settings
remain in private application state outside both the vault and `.obsidian/`; CLI invocations remain
explicit. The CLI keeps journals in an operating-system-owned state root and serializes its
mutating invocations with a process-owned lock, so one headless process never recovers another live
process's transaction. The portable no-clobber install remains the arbiter against desktop,
external-editor, and sync-provider races.

Append and prepend use a shared text-mutation service that reads a stable note snapshot, computes
the complete proposed file, and writes against the exact revision read. Prepend inserts after a
complete YAML frontmatter block. Default separators follow the note's LF or CRLF convention, while
inline mode inserts no separator. The kernel preserves the whole proposal as a conflict copy when
the source revision changes.

Property set and remove use a separate frontmatter-mutation service over the same revision-checked
writer. It patches one simple top-level mapping entry, preserves the BOM, line endings, unrelated
frontmatter lines, comments, order, and complete body, and removes an empty frontmatter envelope
after its final property is removed. Text and list members are always quoted when serialized;
number, checkbox, date, and datetime inputs are validated before a proposal exists. Duplicate keys,
quoted or spaced keys, JSON frontmatter, nested mappings, and block scalars fail closed in this
initial boundary. A revision race preserves the complete proposed file as a conflict copy.

The desktop property inspector derives an ordered presentation from the same authoritative note
snapshot. It classifies editable text, list, number, checkbox, date, and datetime values while
retaining unsupported or malformed YAML as visible read-only rows. Add, edit, and remove requests
cross IPC with the displayed vault identity, note path, and revision. The runtime rechecks all three
before invoking the shared mutation service, then reconciles the writer result through the normal
watcher and metadata-index path. Dirty drafts, read-only vaults, stale snapshots, unsupported values,
and concurrent mutations disable or reject the control without a renderer-owned filesystem path.

Task inspection uses a shared Markdown scanner over the authoritative note bytes. It recognizes
unordered and ordered list checkboxes, retains one-based source lines and exact status ranges, and
uses the link parser's masking pass to exclude fenced code, inline code, and HTML comments. A task
mutation replaces only that status range against the revision that was read. A matching requested
status returns without invoking the writer; a revision race preserves the complete proposed note
as a conflict copy.

The metadata index keeps both a sorted unique tag list for navigation and a per-document occurrence
map for compatibility output. Frontmatter tags are counted from their parsed property value, while
inline tags are counted only after the complete frontmatter block and outside fenced code, inline
code, and HTML comments. Alias and tag CLI projections are derived from that disposable index:
aliases retain their source path, tag totals sum occurrences, and verbose tag information lists
each carrying document once.

Move and rename add a link-integrity preflight in front of the recoverable rename primitive. The
desktop service reuses the current generation-bound metadata snapshot; a standalone caller builds
that disposable index once. A lightweight projected resolver remaps the source path to its proposed
destination without cloning every note body or constructing another complete index. The planner
reads full bytes only for the source and documents whose indexed link meaning would change. Every
parsed wiki and Markdown link must retain the same resolved, unresolved, or ambiguous meaning after
remapping the moved note's identity.

The shared link parser retains exact source and target ranges while excluding fenced code, inline
code, and HTML comments. When a currently resolved link would change meaning, the move planner
replaces only its target slice: wiki links receive an escaped vault path without `.md`, while
Markdown links receive an escaped path relative to the linking note's projected location. Anchors,
aliases, labels, titles, surrounding whitespace, BOM, line endings, and all unrelated bytes remain
untouched. Replacements are applied from the end of each affected file. The projected resolver then
validates every indexed occurrence against its expected logical target. A proposal is valid only
when every occurrence preserves its meaning after remapping the moved note's identity. Unresolved
or ambiguous links are never guessed.

When rewrites are safe and necessary, the service hashes the source and destination, source
revision, exact rewrite preview, affected file revisions, and proposed content revisions into a
confirmation identity. Desktop confirmation must return that exact identity; if any affected file
changes, Threadleaf returns a refreshed preview instead of applying stale consent. The CLI changes
nothing on its first preview and requires `--update-links` to accept the plan rebuilt in that run.

The kernel stages both the before and proposed bytes for every rewrite before recording one parent
move journal. Child write journals apply revision-bound changes, then a child rename journal moves
the final source revision. Recovery validates every parent blob before touching any pending child,
recovers children before parents, and recognizes an already completed rename. A rewrite or
destination race rolls applied entries back in reverse order. An external winner is never
overwritten: Threadleaf preserves the losing proposal or original bytes as a conflict copy and
reports whether recovery committed, rolled back, or requires manual review.

The desktop Move action dispatches through the same service. It carries the active vault identity
and source revision across IPC, refuses dirty drafts, and keeps previews, blockers, and conflicts in
a reviewable dialog. Each rewrite names its document, source line, syntax, and exact target change;
each blocker retains before and after resolution evidence. After a committed move, the runtime
attributes the compound filesystem changes, refreshes every affected index entry, and remaps every
open tab from the old path to the new one before publishing its next snapshot.

The desktop Trash action calls the same recoverable deletion service as the CLI rather than a
renderer-owned filesystem path. Its request carries the active vault identity and exact source
revision. The confirmation names the source, canonical `.trash/` destination, and current indexed
backlink count; dirty drafts cannot open or submit it. A stale revision or occupied trash path is an
explicit no-write conflict. On commit, the runtime attributes the resulting corpus deletion to the
transaction, removes the note from the derived index, closes its tab, selects the entry to its right
then left, and persists that workspace state best effort. Failure to persist workspace metadata
cannot retroactively turn an already committed vault move into a failed deletion.

### Write authority

Every mutation goes through one vault writer. It resolves and validates paths, compares a stable
content revision, stages durable bytes, records recovery intent outside the vault, installs the new
state, and only then retires the journal entry. Rename and multi-file link repair are recoverable
operations, not unrelated filesystem calls.

External changes are preserved. A stale writer never overwrites them silently; it returns a
conflict result and can create an explicit keep-both copy through the same writer. Watcher
suppression is operation-aware rather than a time-only ignore window.

A write whose expected revision is `null` is a create transaction. On restart, a correctly staged
new file is installed at its requested path when that path remains absent. If another process has
claimed the name, recovery keeps both versions instead. A crash before durable staging rolls back
without inventing an empty note.

The portable writer favors no-clobber installation over an unchecked replace. It durably stages a
complete file beside its target, moves the old directory entry to a transaction-owned rollback
name, and links the staged inode into the target only while that name remains absent. A concurrent
external create therefore becomes a conflict instead of an overwrite. During that short operation,
another process can observe the target name as absent, but never observe partially written bytes.
The recovery journal restores or reconciles that state after interruption.

This protects against crashes and ordinary concurrent editors. It is not a security boundary
against a malicious process running as the same operating-system user, which can race filesystem
operations after validation. Symlink and canonical-path checks fail closed whenever such a change
is observed.

Multi-file edits are durable roll-forward transactions rather than a claim of cross-file atomicity
that portable filesystems cannot provide. Threadleaf stores and verifies every proposed version in
application state before applying the first entry. Progress is journaled after each child write.
Restart completes pending entries, recognizes versions already installed, and turns stale entries
into keep-both conflicts. Proposal blobs remain as recovery evidence until a later, explicit
retention policy can remove them.

### Packaging and first-run boundary

The desktop package has one stable application identity, `org.threadleaf.Threadleaf`, and contains
only built renderer and main-process output, package metadata, the Threadleaf license, and required
Electron resources. The source fixture used for first launch is copied to
`resources/bundled-vault` instead of being placed inside `app.asar`. Filesystem code therefore sees
an ordinary directory rather than an archive-backed path with incomplete watcher or stat behavior.

That bundled workspace is a demo, not a writable starter vault. The runtime classifies it as
`synthetic-read-only`, does not start a watcher, and rejects note, folder, binary, rename, trash,
save, and plugin-package mutations before they reach the filesystem. The renderer independently
marks the demo read-only, makes CodeMirror non-editable, and disables mutation controls. Package
smoke tests also call the preload mutation API directly, proving that a forged renderer request is
rejected by the backend and leaves the resource bytes unchanged.

### Support bundle privacy boundary

The support bundle is an allowlist projection, not a raw log followed by redaction. Its versioned
schema contains product, platform, state, count, and boolean fields constructed individually from
runtime snapshots. It never spreads or serializes a runtime, settings, update, plugin, file, or
note object. Unit fixtures populate every private field with canaries and require an exact aggregate
output shape, so adding a field to an upstream snapshot cannot silently add it to a report.

Only the sandboxed main renderer can request the native save operation. The user or an unpackaged
test override selects an absolute target, the main process canonicalizes the active vault and
target through existing ancestors, and any direct or symlinked target inside the vault is refused.
The report is atomically written with mode 0600 and the renderer receives only saved, cancelled, or
a generic failure message, never the chosen path. No network request or automatic upload exists.
The report itself includes a short bug and improvement template and names its exclusions so a user
can review it before sharing. The live Electron gate drives both the About and updates control and
the command-palette action, verifies private canaries are absent, and proves the vault is unchanged.

The initial Linux release lane produces unsigned x64 AppImage and RPM artifacts. It launches the
exact AppImage through the packaged smoke contract, inspects the RPM identity, dependencies, and
payload, and emits SHA-256 checksums for both. A separate reproducibility proof builds the unpacked
application twice, compares every file, symlink, mode, and hash, then produces byte-identical
normalized tar.xz archives from the two trees. It does not yet claim that electron-builder's native
AppImage or RPM containers are bit-for-bit reproducible. Signing, notarization, native container
reproducibility, and automatic update authorities remain later release gates.

### Cross-platform boundary

Desktop compatibility and portable product semantics are separate concerns. Electron and Node.js
are deliberate parts of the trusted desktop compatibility host, but vault revisions, link
resolution, action descriptors, extension capabilities, and the future sync protocol must not
depend on Electron renderer objects or desktop-only plugin globals.

Each public extension surface is classified before release as portable native, desktop
compatibility only, or unavailable on mobile. This prevents a later iOS or Android client from
silently promising an extension contract its storage sandbox or distribution rules cannot honor.
It does not pull mobile implementation ahead of the desktop safety and compatibility gates.

Native mobile clients remain a later product phase. They may use platform-specific storage and UI
adapters rather than sharing every desktop implementation detail, but they must preserve the same
canonical Markdown, revision, recovery, and sync semantics.

### Future encrypted sync boundary

Encrypted sync is an optional transport around the local-first vault, not a replacement for it.
Plain Markdown and attachments remain authoritative on each device, the desktop application stays
complete offline, and no account is required for local use.

The client will translate revisioned local changes into encrypted, versioned objects. A sync server
may route and retain those objects but must not need plaintext note bodies, filenames, paths,
attachments, or protected metadata. Account, billing, network, timing, and object-size metadata
cannot all be hidden by an ordinary hosted service; the threat model must state those limits rather
than treating "zero knowledge" as a slogan.

Threadleaf will use established cryptographic primitives and independently reviewed libraries, with
a versioned key hierarchy, authenticated device enrollment, recovery material, and explicit format
migrations. Novel cryptography is out of scope. Revision and keep-both conflict sync comes before
real-time collaboration or a CRDT.

The protocol and server remain open and self-hostable. A paid official service can fund maintenance
by offering reliable operation, encrypted history, backups, sharing, and later collaboration, but
it receives no proprietary file format or privileged protocol capability. A browser client may
offer reading and editing; arbitrary Node-capable compatibility plugins remain desktop-only unless
a separately sandboxed web extension contract proves safe.

## Initial component model

```text
Markdown vault
    |
    v
Vault kernel <----> recovery journal outside vault
    |
    +-----------> sequenced watcher ---> rebuildable metadata index
    |
    v
Ports <--- application services <--- action registry <--- isolated renderer
    |
    v
Compatibility module ---> trusted community plugin

Capability host ---> native Threadleaf extension
```

## Historical Phase 0 boundaries

- Synthetic fixture vault only.
- Read-only vault access.
- One plugin instance.
- Minimal `App`, `Vault`, `Plugin`, `Command`, and `Notice` behavior.
- Explicit lifecycle and event reporting in the renderer.
- No sync, rich editor, metadata database, package marketplace, or arbitrary vault picker.

## Decisions still to make

- Native extension SDK license and capability vocabulary.
- Fine-grained intra-token cursor mapping and complex-syntax projection in Live Preview.
- Metadata schema and migration strategy.
- Behavior-import apply, rollback, and conflict semantics for the existing preview schema.
- Public benchmark corpora, target devices, and regression budgets.
- Signing, notarization, native-package reproducibility, and automatic-update channels.
- Encrypted object format, key hierarchy, recovery model, and residual-metadata budget.
