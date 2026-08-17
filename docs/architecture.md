# Architecture

The [alternatives landscape review](research/alternatives-landscape.md) is an input to these
decisions. It found that feature breadth is common, while migration continuity, watcher recovery,
plugin continuity, packaging, and contributor depth remain the adoption bottlenecks.

## Current decisions

### Desktop compatibility host

Threadleaf starts as an Electron and TypeScript desktop application. Existing plugins commonly
assume Chromium, the DOM, Node.js, and Electron behavior. Matching that environment reduces the
compatibility problem before optimization begins.

The default isolated topology keeps the primary application renderer isolated with
`contextIsolation`, no Node integration, and Chromium sandboxing. DOM-dependent community plugins
run in their own explicitly trusted `WebContentsView` with Node integration, a unique transient
session partition, denied browser permissions, blocked navigation and popups, and
`connect-src 'none'` for browser requests. This does not sandbox Node-capable plugin I/O. The main
process communicates with each realm through
validated typed request and response messages, times out every operation, attributes renderer
exits, and never gives the primary renderer Node authority. A timeout, invalid protocol response,
failed send, or renderer exit is fatal only to the owning plugin process. Threadleaf forcibly
terminates that realm, creates a clean replacement, and retains the culprit as stopped diagnostic
state until the user explicitly reloads it. Healthy sibling plugins and the native workspace keep
running, and no plugin is replayed automatically after an unknown failure point. The current direct
gate exercises the unchanged Excalidraw 2.26.4 bundle in this production realm, where its registered
`ItemView` attached to a bounded visible workspace leaf. The plugin owns the
leaf content, filename header, action icons, modal content, and canvas lifecycle; Threadleaf owns
the surrounding layout and propagates its light/dark chrome. The normal Markdown header is not
mounted inside a plugin-owned view. Text-file reads cache the revision delivered by the main
process. A compatibility `Vault.modify` request must name a file from that vault and present the
cached revision; validated requests cross narrow IPC, bind to the still-active vault identity, and
enter the same workspace controller and recovery-backed writer as native edits. Conflicts leave the
original untouched and retain the plugin's proposed bytes as a labeled conflict file. Opening an
existing Excalidraw Markdown document, mutating its scene, explicitly saving, closing the drawing
leaf, and reopening the persisted scene are exercised as supporting behavior evidence. They do not
carry a current Level 4 claim until a dedicated controller finalizes a signed, verifier-accepted,
exact-build receipt. Creating
a new drawing now crosses separate create-folder and create-file IPC channels into the same
workspace controller and recovery-backed kernel used by native note creation. The kernel rejects
private paths, symlink traversal, and existing destinations; syncs created directories; and never
activates the new file in Threadleaf's native Markdown workspace on behalf of plugin code. The
compatibility runtime supplies Moment, Obsidian's loaded-plugin lifecycle flag, built-in Markdown
leaves, workspace layout snapshots, and split-leaf creation so the unchanged Excalidraw command can
create its standard folder and Markdown file, pass through a Markdown leaf, and promote that leaf
to the registered drawing view. The current gate also exercises creating a drawing, adding scene
elements, saving, closing, and reopening the exact scene as supporting evidence. Opening Threadleaf's
command palette now detaches only the child surface presentation, not the plugin leaf or renderer,
so a selected plugin command can act on the still-live Excalidraw view before the child surface is
reattached. The compatibility module also supplies frontmatter-entry lookup plus `Vault.createBinary`
and `Vault.modifyBinary`. Text and binary export requests cross separate validated IPC channels,
remain bound to the active vault and cached revision, and enter the recovery-backed writer without
UTF-8 conversion. Excalidraw's unchanged SVG-to-vault and PNG-to-vault actions both create and
overwrite valid exports; PNG verification checks the exact signature and decodes the resulting
803 by 549 image.

Compatibility construction is separate from installation and discovery. The main process admits
only a complete exact package identity with a checked-in reviewed authority profile and matching
full-identity grant. It captures and verifies the package closure once, publishes it into an
application-owned content-addressed read-only root, and loads JavaScript and CSS only from that
integrity-checked root. Grant and revocation history is append-only. Safe mode, vault-session
rotation, profile or package drift, history corruption, stale epochs, and mutable-source changes all
fail closed before construction or force unload during reconciliation. This is a same-user trust and
reproducibility boundary, not isolation from Node-capable plugin I/O.

### Trusted-workspace topology

Compatibility settings are per vault and have two orthogonal fields: `restricted | enabled`
mode and `isolated | trusted-workspace` topology. The product presents these as Off, Isolated
compatibility, and Full trusted compatibility; existing settings migrate to restricted/isolated.
The effective topology is trusted-workspace only when both fields permit it. A topology change or
vault switch across effective topologies settles editor autosaves, drains or rejects plugin work,
tears down owner-scoped compatibility resources, destroys the old `BrowserWindow`, and recreates
the main window before loading the target vault.

Full trusted compatibility uses a conditional main `BrowserWindow` with
`contextIsolation: true`, `nodeIntegration: true`, and `sandbox: false`. The preload remains
isolated and exposes the typed Threadleaf bridge, while native Threadleaf renderer code, the real
primary and secondary CodeMirror editors, and trusted plugin bundles execute in the page's main
world. Thus plugin `globalThis`, DOM constructors, callbacks, and editor extensions share one
JavaScript/DOM realm. This is an honest desktop escape, not per-plugin containment; the UI labels
that loss of process isolation and the default isolated topology remains the safer choice.

The trusted host receives a frozen renderer-owned table containing the exact in-memory namespace
instances for the approved CodeMirror and Lezer roots. Resolver calls for those roots return that
table only, never a second Node copy, facade, or serialized namespace. Function-bearing plugin
extensions enter a dedicated compatibility `Compartment` on every real primary and secondary
`EditorView`, ordered by active plugin and registration sequence. Unloading an owner removes only
its registrations; window replacement removes every owner and reconstructs them from fresh main
process construction decisions. Missing module-table entries and cross-instance extensions fail
closed with diagnostics.

Trusted construction consumes a main-process-captured, identity-verified package-byte closure.
The page does not scan plugin directories or become the authority for grants, policy, package
identity, vault bytes, or persistence. Trusted-mode-only page bootstrapping may enable
`unsafe-eval` for the CommonJS loader; the default isolated document CSP is unchanged. If the
trusted renderer dies, pending operations reject as renderer-dead, the main process preserves the
kernel and exact vault bytes, recreates the same topology, re-resolves every package grant, and
remounts the native editor extensions once.

### Filesystem authority

Markdown and attachments remain authoritative. Search indexes, metadata graphs, and caches must be
rebuildable from those files. Phase 0 has no user-vault write API.

Threadleaf uses an application-owned state root outside every vault. `.obsidian/` is read as
compatibility input when needed but is never Threadleaf's state directory. The vault kernel accepts
the state root through a port so tests can isolate it and each operating system can use its standard
application-data location.

### Visible physical inventory

The desktop Files navigator has a read-only physical inventory separate from the Markdown metadata
index. Its complete projection represents visible physical folders, Markdown notes, JSON Canvas
documents, and ordinary files. It preserves explicit empty folders and gives folders an immediate
visible-child count. Search, tags, links, note summaries, and the flat Notes view remain projections
of saved Markdown metadata.

The inventory has its own opaque generation. A path-set change rotates that generation, while a
content-only Markdown edit does not. Initial inventory work waits until the first metadata census
succeeds or fails, then scans outside the index mutation lock. Publication is a short guarded step:
if a newer invalidation arrived, the candidate is discarded and rebuilt. A failed scan exposes a
degraded state while retaining the last complete projection, never a partial result or invented
empty vault, and the next request retries.

Visible inventory uses the kernel's contained broad path policy. Every dot-prefixed segment,
transaction artifact, private or outside target, broken link, folder symlink, and unsupported
special file remains excluded. A contained visible file symlink may appear as a leaf alias. Tree
pages and active-document locations bind the vault identity and inventory generation. The renderer
receives typed bounded rows, never raw filesystem access. Notes and Canvas use the existing document
action; an ordinary file row remains focusable and opens a transient inspector without creating a
tab or changing the active document. The request binds the exact visible path to the active vault
and inventory generation, caps the source read at 10 MiB, displays at most 64 KiB of valid UTF-8
text or a byte-sniffed PNG, JPEG, GIF, or WebP image, and keeps every other format metadata-only. A
vault or inventory identity change closes the inspector.

The existing guarded New folder route is the only mutation in this surface. Persistent generic
file tabs, OS Open or Reveal, rename, move, and trash require separate native capability,
no-clobber, link-impact, directory, and recovery contracts. The inventory research and disposition
record is
[filesystem-truthful navigator and folder management](research/filesystem-truthful-navigator-and-folder-management-2026-08-16.md).
The inspector boundary is recorded separately in
[ordinary file inspector](research/ordinary-file-inspector-2026-08-16.md).

### JSON Canvas editor

JSON Canvas documents remain ordinary JSON Canvas 1.0 files in the vault. The bounded loader
validates UTF-8, JSON structure, node and edge references, identifiers, geometry, and document
limits before enabling edits. Invalid or unsupported documents retain their parsed objects when
possible, surface path-specific diagnostics, and stay read-only without rewriting their original
bytes. Valid documents use a cloned plain-JSON model, so unknown document, node, and edge fields
survive every supported mutation and serialized round trip.

Canvas commits use the same revision-bound, recovery-backed writer as other native mutations. A
save based on a stale revision leaves the external winner at the original path and writes the local
proposal to an explicit conflict copy. While a local model is dirty, watcher snapshots for the same
path do not replace it; the old revision remains the save precondition that makes the race
recoverable. A successful commit advances that revision and returns the editor to a clean state.

Markdown and Canvas file nodes open through the typed workspace action. Other file nodes cross a
separate vault-bound attachment service that resolves contained targets, rejects private and
external paths, caps reads, and classifies content from magic bytes. The renderer receives either a
bounded raster data URL, escaped UTF-8 text, inert binary metadata, or an explicit unavailable
state. It never receives filesystem authority. External link nodes remain visible but inactive.

The desktop presents equivalent object-list navigation beside the spatial board, explicit controls
for supported text, file, link, group, geometry, and edge mutations, and keeps group containers
below ordinary nodes in the interaction stack. The isolated X11 behavior gate performs real
pointer and keyboard edits, saves and reloads exact bytes, exercises malformed and externally
changed files, and captures light, dark, high-DPI, zoomed, and two-pane surfaces.

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
The loader has no write port. The renderer exposes a separate reviewed apply transaction that
writes only Threadleaf's private versioned settings and workspace state outside the vault. Plans
bind exact source receipts and private-state revisions; stale evidence, unsupported candidates,
and missing exact plugin grants refuse the write. An atomic private journal retains before/after
snapshots, recovers unambiguous interruptions, and refuses rollback over newer private changes.
Initial vault activation withholds the writable workspace snapshot until transaction recovery has
completed or surfaced a conflict; migration preview performs the same recovery check as a fallback.
Migration IPC accepts only the active Threadleaf renderer. Apply and rollback do not reconcile or
execute compatibility plugins; changed runtime selection is deferred to an explicit reload or app
restart so the private transaction cannot cause plugin-authored vault writes.
The full source, candidate, apply, rollback, and limit contract is documented in [Obsidian behavior
migration](compatibility/migration.md).

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

Every pending editor write carries the identity of the vault and pane that produced its revision.
The save boundary rejects it after the active vault changes, even if a relative note path happens to
exist in both vaults. Each CodeMirror change schedules canonical autosave after 1.5 seconds of
inactivity. Note and history navigation, tab close and reorder, pane focus, split, move, and close,
new and daily note creation, vault switching, note-bound mutation and export, window blur and close,
and application quit explicitly await a flush first. A failed write leaves the editor and recovery
draft intact and keeps a cancelable transition from proceeding. Read-only vaults never produce a
write snapshot. Explicit development overrides take precedence without changing the persisted user
selection and are ignored by packaged builds.

The active pending edit is also mirrored into a versioned document under the operating system's
application-data directory after a shorter debounce. That private document contains the exact vault
identity, normalized Markdown path, base revision, draft bytes, selection, draft identity, and
canonical update time. It is bounded, validated again in the main process, serialized with other
draft writes, and replaced atomically with mode-0600 permissions. Successful canonical autosave
clears only the matching draft identity, so delayed cleanup cannot delete a newer edit. Malformed
recovery bytes fail visibly and remain available for diagnosis.

CodeMirror gets a fresh editor state when the active document changes, preventing undo history from
crossing notes. A successful autosave adopts the new disk revision without replacing that state, so
selection and useful undo history remain. Undo is the user-facing revert path. If the sandboxed main
renderer stops, the main process creates and loads a replacement window before retiring the failed
window. The replacement restores the exact private draft and selection as one CodeMirror
transaction, so Undo returns to the canonical disk bytes. A changed or missing disk revision remains
untouched and autosave uses the ordinary conflict-copy boundary.

### Workspace panes, tabs, and draft ownership

The workspace runtime owns one or two panes. Each pane has an ordered, deduplicated list of open
Markdown paths, an ordered pinned-path subset, and one active path; the layout also records the
focused pane and a horizontal or vertical split direction. Normalization emits the pinned subset
first, then ordinary tabs. Pinning moves a path to the end of that leading region; unpinning moves
it to the beginning of the ordinary region without disturbing the relative order of other tabs.
Opening an existing entry reactivates it in that pane after flushing the outgoing pane. Closing the
active entry flushes it before selecting the next entry to its right, then the nearest entry to its
left. A pinned tab is rejected before close or Markdown-trash work begins, so no draft or vault
bytes can be discarded through either route.
Tabs move explicitly between panes, retaining their pin even when the destination already owns the
path. Closing the secondary pane flushes both editors, then merges surviving pinned paths, incoming
pinned paths, and the two ordinary regions. Internal and watcher-driven renames remap
pins; deletes and missing-path reconciliation prune them. Every published snapshot makes pin state
explicit, and the narrow main-process toggle IPC validates the vault identity, pane ID, and current
pane membership before mutation. Each navigation request carries the expected vault identity, so a
delayed renderer action cannot target a similarly named note after a vault switch.

Panes and tabs are derived workspace state stored per vault in a versioned document under the
operating system's application-data directory. The store keys documents by vault identity,
validates and normalizes every path, writes atomically with private file permissions, and never
writes layout files into the vault or `.obsidian/`. Its in-memory version 2 model restores exact tab
order, pin membership, active notes, focused pane, and split direction. The on-disk document uses a
version 1 envelope whose ordered tabs and active path are an exact projection of the focused pane,
plus a `layoutVersion: 2` extension containing the complete layout. Each layout pane adds an
optional `pinnedPaths` member. Older layout-version-2 documents migrate losslessly with an empty
pinned region, while earlier readers ignore that unknown pane member and retain the valid focused
pane projection. This lets the previous daily-driver build reopen the focused-pane projection during
rollback while the current build rejects any mismatched projection or malformed extension. Missing
notes are pruned and repaired state is persisted. An explicit empty document restores an empty
workspace instead of falling back to the first note. Malformed state fails visibly without rewriting
the invalid bytes.

The renderer retains the complete ordered file projection for filtering and navigation, but mounts
only the visible fixed-height rows plus a small overscan window. Spacer geometry preserves native
scroll range, while each mounted row exposes its absolute position and total set size to assistive
technology. Active-note navigation moves the virtual window to the nearest required range rather
than creating one DOM node per vault file.

Pure navigation changes persist before the runtime adopts them, so a failed write cannot create
layout state that silently disappears after restart. A vault mutation that already committed
remains committed even if the following workspace-state update fails; the runtime adopts the real
vault result and reports the persistence warning instead of falsely reporting that the vault write
failed. The renderer owns one mounted CodeMirror editor, one autosave coordinator, and one private
draft identity per pane rather than hidden edits for every tab. Any action that would replace or
discard a mounted document awaits its pane's latest autosave version. The other pane retains
independent selection, history, revision, and recovery state, and a background-pane write reconciles
that pane without stealing focus. Closing an inactive tab remains safe because it cannot discard
either mounted editor.

The native application menu is constructed in the main process with platform roles for ordinary
editing and window behavior. Product commands and accelerators are derived from the same saved key
bindings as renderer controls, then dispatched over the narrow bridge to the focused workspace.
The tab Pin or Unpin control, command palette, native Workspace entry, and remappable hotkey target
all dispatch the same action. The menu therefore adds an operating-system entry point without
creating a second command model.

The renderer also exposes pointer and keyboard tab reordering through one vault-bound runtime
operation. Its insertion model preserves the leading pinned region and permits explicit transfer
between the two existing panes without a transient duplicate or lost tab. The left navigator and
right inspector are stable docks whose collapsed state lives in a separate versioned, per-vault
layout document under private application data. That document also stores bounded main and plugin
window geometry. Display restoration clamps every window to a visible work area and minimum size.
The file store records the SHA-256 revision of each loaded layout and compares it before every
save. An external replacement, including a deletion or malformed edit, rejects the save and leaves
the external bytes untouched; reloading the vault establishes the new revision explicitly.
The vault workspace `restorePolicy` deliberately controls only the note panes and tabs in the
separate workspace-state document. `fresh` starts those panes from the indexed notes while still
restoring dock collapse, main-window bounds, and pop-out metadata from this layout document. A
persisted open pop-out is always reported as degraded after restart because its native window is
not live; its saved bounds remain available for the next explicit pop-out.

A supported compatibility-plugin `WebContentsView` can detach from the main window into a native
`BrowserWindow`; the view itself is reparented rather than recreated. Closing the window returns the
same view to the main workspace. A renderer crash, plugin unload, vault switch, or failed window
load also reattaches it and records a visible degraded warning. An abrupt application stop can leave
an `open` record on disk without a live native window, so activation converts that record to an
honest degraded snapshot and asks the user to reopen the plugin view. Only the active main renderer
may read or mutate this layout surface. Pop-out state and bounds never enter the vault or
`.obsidian/`.

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

### Private per-vault note bookmarks

Bookmarks are ordered visible Markdown paths stored outside the vault in one version 1 document
per SHA-256 vault identity. The separate store keeps the version 5 application-settings rollback
contract unchanged. It accepts at most 2,048 normalized paths, rejects hidden vault segments and
duplicates, serializes mutations per vault, and installs each update atomically with mode-0600 file
permissions. No bookmark operation writes `.obsidian/` or another vault-owned metadata file.

The renderer loads and mutates bookmarks through vault-identity-bound IPC. The note toolbar,
command palette, native menu, and remappable hotkey target all dispatch the same toggle. The left
shelf preserves insertion order. A path missing from the current derived index remains visible as
an explicitly labeled, non-openable row so external deletion does not silently erase user intent.
It can be removed directly or become live again after file recovery.

A committed internal note move serially remaps the old path before the IPC result returns and
deduplicates it if the destination was already bookmarked. The note move itself is authoritative:
if private bookmark persistence fails after that commit, the response reports the partial outcome
instead of misrepresenting the completed vault transaction as a failed move.

### Standalone published-note boundary

Publish export is deliberately a one-note snapshot, not a hidden hosted service or an implicit
whole-vault conversion. The renderer starts from the active note's exact saved content, runs the
same sanitized Markdown renderer and bounded image and note-embed hydration as Reading view, then
clones the detached result into a stricter export projection. Source controls and runtime data
attributes are removed. Safe HTTP, HTTPS, and email links become ordinary links; vault links become
visibly inert text with an explanatory title. Only embedded GIF, JPEG, PNG, and WebP data URLs can
remain as images. A second DOMPurify allowlist rejects scripts, event handlers, forms, remote images,
styles from note content, plugin surfaces, and unknown protocols.

The generated document contains fixed responsive and print CSS, a restrictive Content Security
Policy, automatic light and dark schemes, and no JavaScript. It carries the note title and rendered
content but no source path, vault name or identity, revision, plugin code, theme CSS, or private app
state. It is useful from `file://`, a static host, or an attachment without Threadleaf, Obsidian, an
account, or a network connection.

Only the sandboxed main renderer can request the save. The request is bound to the exact SHA-256
vault identity, normalized visible Markdown path, and source revision. The main process checks the
active runtime before showing the native Save dialog, canonicalizes and rejects direct or symlinked
destinations inside the vault, then checks the active note and stable disk revision again after the
dialog. A stale note produces no file. Valid output is capped at 96 MiB and atomically installed with
mode-0600 permissions. The isolated Electron gate drives both visible entry points with real virtual
input, proves pending editor bytes are flushed before export, inspects the generated security and
privacy boundary, and renders both color schemes.

### Appearance boundary

Threadleaf treats a vault's Obsidian theme and snippet folders as read-only compatibility input
during discovery, selection, and watcher operation. A separate package lifecycle manager can write
an explicitly reviewed package target, but never stores Threadleaf state in `.obsidian/`. The main
process discovers `.obsidian/themes/<folder>/theme.css` plus optional `manifest.json` metadata and
`.obsidian/snippets/*.css`. Per-vault color scheme, theme ID, and ordered snippet IDs live in the
versioned application settings document under a SHA-256 vault identity. Version 1 and 2 settings
migrate to version 3 with empty maps for any settings surface they predate.

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

Appearance discovery remains available through Settings and the command palette, including an
explicit Reload command. A separate main-process appearance watcher starts only for a real,
kernel-backed active vault and is bound to that vault identity and path. It observes the theme and
snippet sources plus only the parent sentinels needed to notice source-root replacement, filtering
all unrelated vault and `.obsidian` activity. Relevant create, change, delete, and rename events
are debounced into one complete bounded loader rescan. Backend errors, unnamed or ambiguous events,
overflow, and source-root replacement take the same conservative full-rescan path rather than
guessing an incremental catalog change. Vault supersession and shutdown close every handle before a
late result can cross the active-vault boundary. The watcher has no write path and reloads through
the existing contained loader, then sends the existing typed appearance snapshot over IPC. An
unselected asset update refreshes the catalog without replacing unchanged active CSS, and no
read-only source edit writes private selection state. See the
[theme compatibility contract](compatibility/themes.md).

Package acquisition is a separate two-step boundary from compatibility discovery. An exact package
archive is bounded, inspected for path and symlink safety, checked for CSS hazards, and shown with
version, archive hash, provenance, asset hashes, and license/README evidence before any vault write.
Preview bytes stay in private application data. Apply is bound to the reviewed vault, package,
archive, and complete target revision; it writes a private durable journal, retains exact rollback
bytes, and uses a same-parent atomic swap. Updates preserve bytes outside the previously managed
assets. Uninstall, rollback, and restore retain recoverable history. Startup recovery restores only
matching revisions; external edits or changed recovery evidence remain in place and fail closed.
Receipts and inventory stay private, while an installed theme or snippet remains an ordinary
`.obsidian/` file or directory. Package lifecycle never changes the private selected theme or
snippet order.

### Vault-scoped accessibility preference overrides

Threadleaf's accessibility document (high contrast, accent, UI/text font scale, editor font size
and line height, reduced motion, reduced transparency) is global application state, versioned and
persisted independently of `AppSettings` so a future migration of either document can never touch
the other. A vault may additionally record its own override of that document. The override map is a
third, separate private file, keyed by the same lowercase SHA-256 vault identity every other private
per-vault document uses, so neither the global document nor `AppSettings` has to move version to add
per-vault accessibility.

Resolution is pure and read-only: a stored override always wins; a vault with no stored override
reads the live global snapshot and is reported as being in the "global" scope, without ever writing
an entry for it. Looking up a vault therefore can never materialize a preference for it, and a
global preference change is immediately visible to every vault that has no override, with no extra
propagation step. Switching the active vault is just the next resolution naming a different vault
identity; there is no separate "current vault" state to fall out of sync. Deleting or renaming a
vault (which changes its SHA-256 identity, since the hash is over the vault's root path) requires an
explicit prune of its override so a reused identity can never resurrect a stale preference; pruning
one vault's entry never touches another vault's.

The vault-bound mutation seam re-checks the active vault's identity and kernel-backed mode around
every await, so a request that crosses a vault switch mid-flight resolves `stale-vault` instead of
being presented as a successful update for the vault it named, and a synthetic/read-only vault
(Threadleaf Demo) rejects before any persistence is attempted.

This subsystem is a foundation, not yet a user-facing feature: the mutation seam has no `main.ts`
IPC registration and no renderer consumer, and nothing calls the prune primitive from a real vault
lifecycle event yet. The adjacent `LatestPluginSurfacePropagation` helper is likewise fully tested
but unconsumed; its intended consumer is the propagation of resolved preferences into isolated
plugin renderer surfaces when that wiring lands.

### Community plugin lifecycle boundary

Threadleaf treats `.obsidian/plugins/<id>/manifest.json`, `main.js`, and optional `styles.css` as
read-only compatibility input. Discovery validates identity, UTF-8 text, file type, realpath
containment, and byte limits before a package is eligible to run. Installed inventory does not
imply enablement. The enabled IDs, restricted-mode choice, and exact-bundle authority grants live in
version 4 private application settings under the vault identity. Version 3 settings migrate without
grants, so previously selected bundles remain blocked until reviewed.

Discovery also creates a pre-enablement report. It presents the manifest's declared minimum
Obsidian version and desktop-only flag, explains that the standard package model bundles external
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
the community package index and exact GitHub release assets, requires a repository license at
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
request has a bounded deadline from the versioned `PluginRendererOperation` surface, including a
10-second `initialize` request budget and 1-second `close` shutdown budget. The main process owns
the conservative resource policy: a 512 MiB renderer working-set ceiling, a 60 percent CPU budget,
one-second samples, a five-second startup quiet window, and three consecutive over-budget samples
before CPU enforcement. An injectable metrics provider reports renderer process measurements when
the host can supply them. Missing or malformed CPU or memory measurements are explicitly marked
unavailable and never become fabricated zeros or a kill decision. A deadline, memory, or sustained
CPU breach records a structured diagnostic with its reason, operation where applicable, measured
value, configured budget, sample count, and timestamps, then terminates only the owning renderer.
The policy is a guardrail in the trusted compatibility host, not OS sandboxing or hard isolation
from Node-capable plugin I/O. Resource timers, listeners, and pending request deadlines are cleared
on close, renderer crash, replacement, and application shutdown. A fresh renderer receives the same
vault boundary and surface policy when the user explicitly reloads the culprit. Healthy siblings
and the native workspace continue running.

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

### Native extension capability boundary

Native extensions do not execute through the CommonJS compatibility host. Their version 1 manifest,
capability IDs, public ports, grant store, and lifecycle host live in `src/native-extension/` and
are documented in [Native extension capability contract](compatibility/native-extensions.md).
Registration is review-only: the host hashes exact bundle bytes and the authority declaration before
any entrypoint runs. Each grant is private to one vault and binds both hashes, the extension ID, and
the selected capabilities. A byte change, revoked grant, safe mode, vault identity mismatch, or
authority growth blocks the relevant execution or port call until explicit review.

The portable API is a narrow port contract for bounded vault reads, revision-checked writes, and
other explicitly supplied adapters. Missing adapters produce typed unavailable failures. Desktop
navigation, subprocess, secret, and dynamic-code adapters are labeled trusted desktop escapes.
Their inspection reports `sandboxed: false`: this first host enforces an in-process capability
boundary and does not claim OS-level sandboxing or protection against an extension that imports a
host module outside the SDK. The compatibility host remains a separate trusted runtime.

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
internal saves, external edits, moves, deletes, subtree rescans, and full rebuilds. A pending editor
change does not appear until continuous autosave crosses the recoverable write boundary, which the
UI states plainly.

Queries are bounded to 256 characters, 12 distinct AND terms, and at most 100 returned documents.
Quoted text is one phrase. Exact folder scopes are applied before result limiting. Both default and
case-sensitive modes use a derived key that removes canonical diacritics only from graphemes with a
Latin-script base; case-sensitive mode still preserves case. Script-specific marks such as Arabic,
Hebrew, and Indic marks remain significant even when attached to a Latin base, while ordinary Latin
accents fold. Ranking favors exact titles, then title, tag, heading, path, property, and body
evidence; results retain bounded contextual lines and source line numbers from the exact saved text.
Every response carries the active vault ID and monotonic index generation. The renderer rejects a
response that no longer matches its current vault, query, or generation and immediately requests the
current result.

Case folding uses a pinned Unicode 17 table generated by `scripts/generate-case-folding-table.mjs`
from the local Unicode Character Database and committed as `src/generated/case-folding-table.ts`, so
the runtime never fetches Unicode data over the network. Only Common and Simple status mappings are
applied. Full mappings that grow a string in length, such as sharp s to "ss", and Turkic dotted-I
remapping are excluded by design, so sharp s stays distinct from "ss" and dotted or dotless Turkish I
forms are never conflated with plain Latin I. Because this table is defined per code point rather
than by word position, Greek final and medial sigma fold to the same key, unlike
`String.prototype.toLowerCase`'s word-final Sigma rule. The `search:context` CLI surface returns
every "content" match as an exact, unclipped slice of the saved source line, including its original
whitespace; ranked `search` results keep a trimmed, match-anchored snippet sized for compact display.

The Quick Switcher and command palette retain their established compatibility projections. Their
NFKD-based ranking behavior is intentionally separate from vault full-text search so this policy
does not change existing picker matches for compatibility characters.

The initial index is an in-memory normalized scan. That is the simplest correct implementation and
already clears the current interactive scale baseline. `pnpm benchmark:search` measures rebuild,
rare-query, and deliberately broad-query behavior over a deterministic 10,000-note corpus. The
public `benchmarks/` module adds filesystem-backed smoke, standard, and large corpora with manifest
hashes, index/link correctness checks, watcher bursts, runtime activation, and opt-in relative
timing budgets. A future inverted or SQLite FTS index must be earned by those measurements and
preserve the same rebuildable contract, rather than adding canonical database state speculatively.

### Live Preview, Source, Reading, and source mapping

Live Preview and Source are two presentations of the same CodeMirror document. A fresh install
starts in Live Preview, while each pane retains its current mode and the preferred editing mode is
stored as private application state outside the vault. Switching modes reconfigures decorations;
it does not replace the document, write the vault, or reset undo history.

The Live Preview layer derives decorations from the CodeMirror syntax tree. Presentation markers
are hidden only on lines outside the cursor or selection. Every selected line exposes exact source,
and clicking a rendered token moves the cursor into its source range before revealing it. Common
headings, emphasis, links, tasks, lists, quotes, callouts, code blocks, tags, local raster images,
and source-backed note-embed cards are covered by an isolated virtual-input corpus. Standard
footnotes, valid GFM pipe tables, and bounded offline math are also mapped when their boundaries
are unambiguous. Frontmatter, raw HTML including script, style, textarea, and title contents,
malformed or ambiguous constructs, and unsupported nesting stay visible as source rather than
becoming a lossy rendering. Task controls dispatch an exact source transaction, so pending state,
undo, drafts, autosaves, conflicts, and recovery remain one path.

Reading view is an explicit document mode, not an implicit write or a second source of truth. It
renders the current CodeMirror document while the ordinary autosave coordinator remains active.
Switching modes stores only an application preference outside the vault.

The first renderer uses Markdown-it for deterministic block parsing and DOMPurify with a narrow
element and attribute allowlist. Raw HTML is accepted only after sanitization. Scripts, event
handlers, forms, styles, media elements, and active URLs are removed. Markdown images and
Obsidian-style wiki embeds first become inert placeholders. A dedicated read-only image service may
replace raster placeholders with sniffed PNG, JPEG, GIF, or WebP bytes. A separate attachment
service resolves local non-note embeds by contained path, bounded stable read, and magic bytes
instead of trusting a filename extension. PDF, audio, video, document, text, archive, and unknown
bytes become metadata cards with explicit native actions; no attachment payload is injected as
executable or inline media content. Reveal remains available for every safely inspected file. Open
requires agreement between byte-sniffed content and an allowlisted non-launcher suffix on both
the requested and canonical paths. A separate note-embed service resolves indexed Markdown identities
and extracts either the whole note, one heading through its descendants, or one block ID. It
returns exact path, revision, source range, content bytes, and nested-link summaries. The renderer
sanitizes every returned fragment through the same Markdown pipeline, then recursively hydrates its
nested notes, raster images, and passive attachment cards.

Passive attachment cards expose distinct revision-bound **Publish copy** and **Rename or move**
workbenches. The application attachment planner uses the same local-target parser as the attachment
loader, rewrites only resolved local wiki and Markdown references, preserves exact query and
fragment suffixes, and refuses case- or NFC-ambiguous source identities and basenames. Publish copy
commits source-retaining binary publication plus Markdown writes. Rename or move commits
source-removing binary rename plus allowed Markdown and JSON Canvas writes and preserves the
workspace's `always`, `ask`, or `never` automatic-link policy. The `never` policy moves only the
exact attachment bytes and does not rewrite either format.

An unresolved passive attachment card may expose **Relink** only when the rendered target maps to
exactly one supported embed token in one visible public Markdown source. The replacement must be an
existing, non-Markdown, non-hidden passive attachment named by its full vault-relative path. The
application performs a bounded stable read, then previews one exact target-token replacement. Its
confirmation binds the source revision, replacement revision, target spelling, resulting content,
and current index generation. The recovery-backed writer enters the kernel mutation lane and checks
the exact missing path, resolver-level missing identity, replacement namespace uniqueness,
replacement canonical identity, bounded revision, and containment both before staging and again at
the last no-source-mutation seam immediately before source move-aside or install. A failed final
check retires staged and recovery bytes, archives a rolled-back receipt, and leaves the source note
unchanged. This is an optimistic filesystem boundary, not a lock against an unrelated external
writer racing after the final check. A commit rewrites only the source note: it does not create the
missing path or copy, move, delete, decode, or overwrite attachment bytes. Query and fragment
suffixes, aliases, BOM, line endings, code, comments, and unrelated note bytes stay exact. Duplicate
occurrences, changed sources or candidates, returned or ambiguous missing targets, hidden or
outside-vault paths, oversized candidates, stale vaults, and changed workspace generations refuse.
A final source race preserves the proposed note as a named conflict copy and reports that path
instead of claiming no mutation.

The same authorized missing card may expose **Restore file**. File selection stays in the sandboxed
renderer: the bridge receives only the basename-safe selected name, a copied `ArrayBuffer`, source
note identity, raw missing target, and active vault identity. No selected absolute path or file URL
crosses IPC. The application accepts at most 16 MiB, requires one supported source token and the
same revision, resolves the exact missing path again, and returns a read-only preview containing the
target, byte count, and SHA-256 content revision. Confirmation binds those facts plus the index
generation. A matching second submission does not rewrite the note. It enters the kernel's shared
external-byte ingress authority with persisted authorization for the source revision, exact missing
path, and resolver target.

The ingress journal advances through `intent`, `staged`, `published`, and `committed`. The kernel
revalidates the source note, resolver-level absence, exact-path absence, contained existing parent,
public non-Markdown target, case and NFC namespace uniqueness, and strict publication capability at
the last pre-publication seam. Linux publication uses the same descriptor-contained unnamed-inode
and absent-name `linkat` boundary as other strict attachment publication. It then verifies the
published revision and complete normalized namespace before the durable commit receipt. A crash
before staged evidence rolls back. A staged recovery with an unexpected exact target, any
post-publication ambiguity, or an uncertain receipt preserves private evidence and reports manual
review rather than upgrading uncertainty to success. Only a durable terminal receipt permits blob
cleanup.

The authorized missing card adds two thin input adapters over that same authority. A card-local
drop accepts exactly one regular external file. **Paste file** accepts exactly one file-backed
clipboard event while its real button is focused. Both copy bounded bytes in the renderer and open
the unchanged Restore file preview; the card still supplies the exact destination, source note,
revision, raw missing target, and vault binding. The incoming basename remains display and
authorization metadata, never destination authority. Text, HTML, URLs, directories, multiple
files, unsafe names, unreadable inputs, and oversized inputs are refused. The handlers are bound to
authorized missing cards rather than the document or editor, so ordinary text paste and workspace
tab dragging remain outside the exact-path restore feature.

The editor has a separate one-file insertion adapter and compound transaction. File drop resolves a
CodeMirror position from the pointer; file paste captures and replaces the current selection. Text,
HTML, and URL transfers return to CodeMirror untouched. Directory-shaped and multi-file transfers
are owned, canceled, and refused before Chromium can navigate or a partial batch can begin. The
renderer copies at most 16 MiB from one safe-basename raster or passive attachment `File`, proposes
the source note's folder as the destination, and allows only an editable vault-relative path whose
visible parent already exists. It sends bytes and bounded metadata, never the selected absolute
path or a filesystem handle.

Pending pane saves flush before review. The application maps LF CodeMirror selection offsets back
to exact BOM and CRLF or CR-only source offsets, builds either the configured wiki embed or a
source-relative encoded Markdown embed, and binds the byte hash, target, source revision, selection,
generated reference, proposed note revision, and index generation into a read-only first response.
The target must remain absent under exact, case, and NFC identities; no folder is created and no
suffix is invented.

Confirmation enters a dedicated `attachment-insert` journal. Private evidence contains the exact
attachment and complete proposed note. The kernel rechecks source writability and revision, target
absence and namespace uniqueness, contained existing parent, supported suffix, and strict
publication capability before publishing the attachment. Only a verified durable publication may
advance to the revision-bound note write. If an external source edit wins after publication, the
complete proposed note becomes a named conflict copy that already points to the new attachment. An
uncertain publication receipt, post-publication target ambiguity, or unsafe source namespace keeps
both private blobs for manual review. Verified commit, rollback, and conflict receipts clean up
only after archival. Supported attachment targets are filtered out of the note-link inspector and
unresolved note-link totals.

Every publication preview binds the exact Markdown path set, every note revision, and the metadata
generation. For an `always` or `ask` rename, the reference corpus instead includes every visible
Markdown and JSON Canvas path and revision. Valid Canvas `nodes[i].file` and group
`nodes[i].background` references are rewritten by replacing only their complete JSON string tokens.
The strict scanner rejects comments, trailing commas, duplicate object keys, invalid UTF-8,
scanner/domain disagreement, and unsupported target spellings. Malformed, unreadable, oversized,
or otherwise unprovable Canvas files block source removal. Supported root and explicit relative
targets retain query and fragment suffixes, while BOM, line endings, whitespace, property order,
unknown fields, number spellings, and every unrelated byte remain exact. Direct write targets and
the source revision are checked in the mutation lane. The whole-corpus receipt is a conservative
preflight and post-mutation check, not an atomic lock against arbitrary external writers: a change
observed after the final preflight drives exact journaled rollback or a manual conflict, preserving
surviving bytes and never silently retiring a pending transaction. Attachment operations do not
remap note tabs or bookmarks, because those state entries identify Markdown notes rather than
attachment references. Open and Reveal cross one main-renderer-only, vault-identity- and
revision-bound native capability. It returns only vault-relative typed receipts: Open reports
success after Electron's result string is empty, while Reveal truthfully reports only that the file
manager request was dispatched because the OS API has no completion receipt.

Reference-style ordinary links and images share one source-evidence gate. A visible, single
definition that resolves to the source may be rewritten once. A source-only, opaque, unresolved,
ambiguous, or duplicate same-label definition with source evidence blocks publication instead.
CommonMark defines deterministic first-definition precedence, but Threadleaf deliberately keeps this
stricter safety policy rather than choosing a source-related duplicate. Dormant, unrelated, and
external definitions retain their exact bytes.
Definition destinations are intentionally parsed on one physical source line. A source-related
multiline destination remains opaque evidence and blocks publication rather than receiving a partial
rewrite; definitely unrelated continuations remain byte-identical and do not block a publication.

All three services receive the source note, raw target, and expected vault identity. The main
process resolves note-relative and vault-rooted paths, follows symlinks only within the vault,
excludes `.obsidian/`, `.git/`, and transaction artifacts, rechecks the active runtime after
asynchronous reads, and never returns a filesystem URL. Image reads are stable and limited to 10
MiB each; general attachment reads are bounded at 16 MiB. One preview accepts at most 128 images,
128 passive attachments, and 64 MiB of decoded image input. Note reads are limited to 2 MiB each,
32 expanded fragments, 8 MiB of returned Markdown, and four recursive levels. A path-and-subpath
ancestry set stops cycles while allowing finite same-note section embeds.
Oversized, missing, ambiguous, external, malformed, unsupported, stale-vault, and out-of-vault
targets remain labeled placeholders. SVG and unsupported non-note wiki embeds remain inert.
External links also stay inert during beta rather than broadening IPC for shell access prematurely.

Native attachment actions do not reuse external-link or generic shell authority. Their handler
accepts only the owned main renderer and one typed `{ action, path, expectedRevision,
expectedVaultId }` request. It canonicalizes the relative path inside the captured active vault,
rejects hidden/private paths and special files, repeats the 16 MiB stable read and exact revision
check, and rechecks the active vault immediately before dispatch. A contained leaf symlink is sent
as its canonical target; an outside or hidden target fails closed. No absolute path, file URL,
native error detail, or shell handle crosses back to the renderer. The final read is a conservative
preflight, not an atomic lock against an unrelated same-user writer replacing a path before an
external application consumes it. The research and proof record is
[vault-bound native attachment actions](research/native-attachment-actions-2026-08-16.md).
The missing-reference recovery boundary and packaged evidence are recorded in
[single-reference attachment relinking](research/attachment-relink-2026-08-16.md).
The external-byte recovery boundary and packaged evidence are recorded in
[exact-path attachment restoration](research/attachment-restore-2026-08-16.md).
The general editor insertion transaction and packaged evidence are recorded in
[recoverable editor attachment insertion](research/attachment-insert-2026-08-16.md).

Every rendered top-level block carries its source line. A visible line control switches back to
source mode and selects that CodeMirror line. Internal wiki and Markdown links carry normalized
identities, but the derived metadata index remains authoritative for resolution status and target
paths. Navigation awaits the pending autosave version before changing documents; no preview action
discards text or creates a second write path.

Live Preview exposes a disposable source/decorated mapping with half-open source ranges, rendered
ranges, explicit selection affinity, and a deterministic source fallback for malformed or
ambiguous tokens. Compound labels map to their owning source spans while hidden delimiters map to
source boundaries, so generated widgets never become a second editable document. Inline note
transclusion is locally resolved through bounded source-backed cards with path-plus-subpath cycle
tracking, depth/count/byte limits, and an owning source path/range on every result. Composition,
selection, undo, clipboard, and external-revision flows continue to operate on the one canonical
CodeMirror document. The pure mapping fixture and mounted jsdom corpus cover exact-source,
bounded-read, and no-implicit-write behavior for the local seam. The canonical Electron/Xvfb
workflow remains a separate gate and is not claimed as verified until it runs successfully.

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

The headless compatibility catalog family (`plugins`, `plugin`, `themes`, `theme`, and `snippets`)
uses the desktop's existing bounded contained plugin and appearance loaders, then projects only a
small safe catalog. It never evaluates plugin bundles, applies CSS, reads a private enablement,
appearance, hotkey, or workspace setting, or writes `.obsidian/` or Threadleaf state. The catalog
adapter drops vault identity, absolute paths, CSS, source code, private selections, raw hotkeys, and
loader error text before command output. Source state and numeric diagnostics remain explicit so a
missing, unreadable, invalid, or bounded-out source does not look like an empty healthy catalog.
`plugins filter=core`, active-theme lookup, catalog mutation, action or hotkey inventory, and
workspace or tab inspection stay omitted until a safe headless authority and executable contract
exist.

The desktop and CLI call one note-creation service. A shared bounded template reader layers exact
`title`, `date`, and `time` expansion over that service without changing Markdown authority. Daily
notes derive a contained Markdown path from per-vault folder and Moment-compatible date-format
settings, read it before mutation, and never rewrite an existing note. Desktop workflow settings
remain in private application state outside both the vault and `.obsidian/`; CLI invocations remain
explicit. The CLI keeps journals in an operating-system-owned state root and serializes its
mutating invocations with a process-owned lock, so one headless process never recovers another live
process's transaction. The portable no-clobber install remains the arbiter against desktop,
external-editor, and sync-provider races.

The reusable kernel-held private-state lock candidate is documented in [Private state lock](private-state-lock.md).
Existing CLI and application consumers migrate to it in separate quiesced changes; this primitive does not
silently reinterpret their current lock directories or takeover rules.

Append and prepend use a shared text-mutation service that reads a stable note snapshot, computes
the complete proposed file, and writes against the exact revision read. Prepend inserts after a
complete YAML frontmatter block. Default separators follow the note's LF or CRLF convention, while
inline mode inserts no separator. The kernel preserves the whole proposal as a conflict copy when
the source revision changes.

Property set and remove use frontmatter mutation services over the same revision-checked writer.
The original typed service handles the deliberately narrow top-level property contract. The complex
service adds dotted and indexed paths, nested scalar leaves, and safe mapping additions through
line-range patches, preserving the BOM, line endings, unrelated frontmatter lines, comments, order,
quoting, and complete body. It parses and reports duplicate keys, anchors, aliases, tags, block
scalars, flow collections, and syntax errors without normalizing them; a requested mutation that
would cross one of those opaque ranges is rejected with a reason. A revision-bound preview carries
the exact base revision and proposed bytes into the recoverable writer, so a race preserves the
complete proposal as a conflict copy. Nested mapping/list replacement, destructive normalization,
and absent list-index creation remain unsupported by design.

The desktop property inspector derives an ordered presentation from the same authoritative note
snapshot. It classifies editable text, list, number, checkbox, date, and datetime values while
retaining unsupported or malformed YAML as visible read-only rows. Add, edit, and remove requests
cross IPC with the displayed vault identity, note path, and revision. The runtime rechecks all three
before invoking the shared mutation service, then reconciles the writer result through the normal
watcher and metadata-index path. The renderer flushes pending editor bytes before binding this
revision. Read-only vaults, stale snapshots, unsupported values, and concurrent mutations disable or
reject the control without a renderer-owned filesystem path.

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

The shared link parser retains exact source and target ranges. Offset-preserving masks keep fenced
and indented code, inline code, HTML comments and blocks, valid autolinks and tags, and the
renderer-recognized bounded math blocks out of generic link scanning. Complete wiki spans and valid
reference-definition lines are parsed once, then made opaque to generic inline and reference scans;
frontmatter definitions remain source-only safety evidence. When a currently resolved link would
change meaning, the move planner replaces only its target slice: wiki links receive an escaped vault
path without `.md`, while Markdown links receive an escaped path relative to the linking note's
projected location. Anchors, aliases, labels, titles, surrounding whitespace, BOM, line endings, and
all unrelated bytes remain untouched. Replacements are applied from the end of each affected file.
The projected resolver then validates every indexed occurrence against its expected logical target.
A proposal is valid only when every occurrence preserves its meaning after remapping the moved
note's identity. Unresolved or ambiguous links are never guessed.

When rewrites are safe and necessary, the service hashes the source and destination, source
revision, exact rewrite preview, affected file revisions, and proposed content revisions into a
confirmation identity. Desktop confirmation must return that exact identity; if any affected file
changes, Threadleaf returns a refreshed preview instead of applying stale consent. The CLI changes
nothing on its first preview and requires `--update-links` to accept the plan rebuilt in that run.

The kernel stages both the before and proposed bytes for every rewrite before recording one parent
move journal. Ordinary note moves and source-removing attachment renames apply revision-bound child
writes, then a child rename moves the final source revision. Strict attachment publications publish
the exact destination first, retain the source, and apply link rewrites only after the publication
receipt. Scoped corpus identity is persisted in the journal, so startup recovery revalidates the
same Markdown-only or Markdown-plus-Canvas boundary chosen by the operation. Recovery validates
every parent blob before touching any pending child, recovers children before parents, and
recognizes an already completed rename or source-retained publication. A rewrite or destination
race rolls applied entries back in reverse order. An external winner is never overwritten:
Threadleaf preserves the losing proposal or original bytes as a conflict copy and reports
committed, published-source-retained, rolled back, or manual review truthfully.

The desktop actions dispatch through the same service. They flush pending editor bytes, then carry
the selected operation, active vault identity, source revision, and automatic-link policy across
IPC while keeping previews, blockers, and conflicts in a reviewable dialog. Each rewrite names its
document, source line, syntax, and exact target change; a Canvas rewrite also names its exact JSON
location. Each blocker names the unhandled evidence, including an exact JSON Canvas location when
available. After a committed rename or source-retained publication, the runtime attributes the
compound filesystem changes and refreshes every affected index entry before publishing its next
snapshot. A committed Canvas child write also advances the active-payload epoch so a snapshot that
captured the old Canvas bytes cannot publish after the rename. A successful Publish copy keeps the
attachment at its original path; a successful Rename or move reports the removed source path
explicitly. Note tabs and bookmarks are not remapped for attachment operations.

The desktop Trash action calls the same recoverable deletion service as the CLI rather than a
renderer-owned filesystem path. Its request carries the active vault identity and exact source
revision. The confirmation opens only after pending editor bytes flush, then names the source,
canonical `.trash/` destination, and current indexed backlink count. A stale revision or occupied
trash path is an explicit no-write conflict. On commit, the runtime attributes the resulting corpus
deletion to the transaction, removes the note from the derived index, closes its tab, selects the
entry to its right
then left, and persists that workspace state best effort. Failure to persist workspace metadata
cannot retroactively turn an already committed vault move into a failed deletion.

Desktop File Recovery is a vault-bound projection over that same trash service. It reads at most
500 recoverable Markdown entries per refresh, reports the full count when the catalog is larger,
and keeps every entry bound to the revision that was displayed. Restore crosses validated IPC with
the active vault identity, refuses a changed recovery source or occupied live destination, then
attributes the committed rename to the watcher and refreshes the restored path in the derived
index before publishing the next snapshot. The dialog filters original and `.trash/` paths,
surfaces collision evidence without changing either copy, and exposes no permanent-delete action.

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
complete file beside its target, materializes the target through an exclusive create into a fresh
inode, and keeps transaction-owned rollback and recovery bytes until the result is verified. A
concurrent external create therefore becomes a conflict instead of an overwrite. During that short
operation, another process can observe the target name as absent, but never observe partially
written bytes or an alias to the staged evidence. The recovery journal restores or reconciles that
state after interruption.

This protects against crashes and ordinary concurrent editors. It is not a security boundary
against a malicious process running as the same operating-system user, which can race filesystem
operations after validation. Symlink and canonical-path checks fail closed whenever such a change
is observed.

Attachment publication opts into a stricter transaction seam. The tested implementation is
Linux-only: each attachment ancestor and final name is reopened from held descriptor-relative
no-follow handles, and the exact source snapshot and revision are recorded in a private durable
journal and evidence blob. The native boundary creates an unnamed `O_TMPFILE` inode in the held
destination directory, writes the exact bytes with mode 0600, fsyncs the inode, and atomically links
it at the absent basename with `linkat`. It first uses `AT_EMPTY_PATH` and retains the documented
`/proc/self/fd` plus `AT_SYMLINK_FOLLOW` fallback for hosts that reject the empty-path form. The
directory is then fsynced and the published bytes are verified. No target-side staging pathname
exists for another process to replace before publication.

Vault open/create performs a non-mutating host-binding, descriptor-containment, and
filesystem-device preflight only. A strict destination parent must already exist and remain
contained. Before Threadleaf creates a transaction journal, evidence blob, target, or Markdown
change, it opens that exact target parent through a held descriptor and performs a no-name probe: it
creates an unnamed `O_TMPFILE` inode, writes one bounded byte, applies mode 0600, fsyncs the inode
and directory, and closes it. The probe establishes anonymous-inode create, write, and durability on
that exact target filesystem and directory while creating no vault pathname. It cannot prove `linkat`
at the requested basename without creating a visible name, so the final exact-basename `linkat` and
directory sync remain the authoritative no-overwrite publication checks before Markdown mutation.
For a publication that rewrites links, every rewritten note parent and the receipt-gated private
rollback-claim directory need the descriptor and same-device receipt, not the no-name probe, because
they do not publish the attachment. A cross-device layout is rejected before the destination copy is
published.

Strict publication also scans the complete non-hidden, non-private lexical vault namespace by NFC-
and case-folded full path. It records regular files, directories, symlinks without following them,
and special entry names; only an exact existing regular-file target is deferred to the ordinary
exact-target receipt. The scan runs at the final controlled pre-publication point, after exact
publication but before any Markdown write, and during source-retained recovery before a success
receipt is archived. A final scan after Markdown writes and before commit routes a newly observed
claimant through receipt-bound Markdown rollback while preserving the attachment names. An observed
equivalent claimant is a manual conflict: Threadleaf leaves the claimant and exact published target
in place and does not proceed with Markdown mutation. This is a detection barrier, not an atomic
normalized-name reservation. A same-UID process can race a pathname during or after a scan, while
descriptor-contained reads and writes still prevent that pathname race from redirecting a mutation.
Linux's native no-clobber link protects only the exact basename; that residual normalized-name race
remains outside the strict transaction guarantee.

There is no exclusive-copy fallback because a crash could expose a partial final target. Missing
`O_TMPFILE` or `linkat` support, `EXDEV`, durability failure, Windows sharing behavior, and
unsupported descriptor or reparse primitives are typed capability conflicts before Markdown
mutation. Failure before the final link closes the unnamed inode without creating a vault name. A
late native publication capability failure after durable intent returns
`attachment-publish-unavailable`, leaves the source and Markdown unchanged, and retains the private
journal and evidence for recovery or explicit manual review. It does not infer that the target is
absent: failure after `linkat` or its directory sync may leave the exact destination in place, so no
mutable target is deleted. The original source name is retained. Markdown rewrites begin only after
the target publication is verified, and the terminal result is `published-source-retained`, not a
rename. A destination claim, source replacement, parent symlink or reparse change, crash, sharing
error, or recovery mismatch preserves external bytes and private evidence and reports a conflict.
Other platforms, including Darwin and Windows, fail the strict attachment request before mutation
until an equivalent no-follow primitive and sharing contract is proven.
Ordinary private writers retain their cross-platform durability path. These guarantees protect
against crashes and ordinary editors, not a malicious same-UID process that races after a check;
that remains outside the threat model. Strict attachment claims never use a pathname unlink: they
move through no-clobber retention or remain as recoverable residue. Portable private writers retain
the narrower ordinary-editor cleanup path for high-entropy app-generated claims after exact
verification; a changed claimant is never removed under that documented boundary. Successful
ordinary writes clean that private claim, so they do not accumulate one full retained file per
write. The private `rollback-claims/<transaction-id>`
directory is removed only after that transaction's durable `committed` history receipt; startup
repeats this exact receipt-gated sweep after an interruption. Uncertain claims remain bounded to
the failed transaction's generated stage and are surfaced for explicit recovery, never
garbage-collected by pathname guesswork. Compound moves still expose recoverable progress and
published-source-retained, rolled-back, or manual-conflict states; they do not provide cross-file
atomicity.

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
- Remaining complex-syntax projections in Live Preview beyond the source-backed mapping and
  deterministic fallbacks documented above.
- Metadata schema and migration strategy.
- Behavior-import apply, rollback, and conflict semantics for the existing preview schema.
- Windows and macOS Electron-window, editor-latency, and plugin-activation benchmark seams; the
  Linux/Xvfb seam, headless kernel/index/watcher corpus, and relative budgets are now public.
- Signing, notarization, native-package reproducibility, and automatic-update channels.
- Encrypted object format, key hierarchy, recovery model, and residual-metadata budget.
