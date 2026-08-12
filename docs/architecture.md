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
inside that sanitized renderer. They run in a separate, explicitly trusted `WebContentsView` with
Node integration, a transient session partition, denied browser permissions, blocked navigation
and popups, and `connect-src 'none'` for browser requests. This does not sandbox Node-capable plugin
I/O. The main process communicates with that realm through validated typed request and response
messages, times out every operation, attributes renderer exits, and never gives the primary
renderer Node authority. A timeout, invalid protocol response, failed send, or renderer exit is a
fatal boundary for the shared compatibility process. Threadleaf force-terminates that realm,
creates a clean replacement, and retains every previously loaded plugin as stopped diagnostic
state until the user explicitly reloads it. No plugin is replayed automatically after an unknown
failure point. The unchanged Excalidraw 2.25.3 bundle activates in this production realm
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
available, and a generation guard prevents a late restore from replacing a vault picked while it
was opening. Environment overrides are never persisted. After adoption, Threadleaf reconciles only
the plugins explicitly selected in its private per-vault settings. A vault with no saved plugin
preference starts restricted. An unavailable or malformed saved selection falls back to the
bundled fixture with a visible warning and does not erase the saved path, so a temporarily
unmounted vault can recover on a later launch.

Every editor draft carries the identity of the vault that produced its revision. The save boundary
rejects a draft after the active vault changes, even if a relative note path happens to exist in
both vaults. The renderer also blocks user-initiated switching while a note is unsaved. Explicit
development overrides take precedence without changing the persisted user selection and are
ignored by packaged builds.

### Workspace tabs and draft ownership

The workspace runtime owns an ordered, deduplicated list of open Markdown paths and one active
path. Opening an existing entry reactivates it. Closing the active entry selects the next entry to
its right, then the nearest entry to its left. Incremental watcher moves remap open paths and
deletions remove them, while every published snapshot filters the list against the current derived
index. Each close request carries the expected vault identity, so a delayed renderer action cannot
close a similarly named note after a vault switch.

Tabs are derived workspace state stored per vault in a versioned document under the operating
system's application-data directory. The store keys documents by vault identity, validates and
normalizes every path, writes atomically with private file permissions, and never writes layout
files into the vault or `.obsidian/`. A valid document restores exact tab order and its active
path. Missing notes are pruned and the repaired state is persisted. An explicit empty document
restores an empty workspace instead of falling back to the first note. Malformed state fails
visibly without rewriting the invalid bytes.

Pure navigation changes persist before the runtime adopts them, so a failed write cannot create
tab state that silently disappears after restart. A vault mutation that already committed remains
committed even if the following workspace-state update fails; the runtime adopts the real vault
result and reports the persistence warning instead of falsely reporting that the vault write
failed. The renderer owns one CodeMirror draft rather than a hidden unsaved draft per tab. A dirty
active draft therefore blocks tab activation, active-tab closure, and vault switching until it is
saved or reverted. Closing an inactive tab remains safe because it cannot discard the current
draft.

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
imply enablement. The enabled IDs and restricted-mode choice live in version 3 private application
settings under the vault identity.

Discovery also creates a pre-enablement report. It presents the manifest's minimum Obsidian API
version and desktop-only flag, explains that the standard package model bundles external
dependencies into `main.js` rather than declaring a cross-plugin dependency graph, and attaches
only exact-version workflow evidence. A plugin or version without a production-path fixture stays
at level 0. Evidence from another release is shown as historical context, not inherited as a
compatibility claim.

The main process serializes catalog and lifecycle operations so activation cannot race a vault
switch or another enablement change. Reconciliation unloads runtime instances that are no longer
selected, then activates each remaining selected package independently. One activation failure is
retained as diagnostic state and does not prevent later packages from loading. Reload performs a
clean unload before activation. Workspace shutdown unloads every instance.

All compatibility plugins currently share one isolated renderer. Each request has a bounded
deadline. If a request wedges that renderer, the process is killed rather than merely rejecting a
timer while plugin code continues to run. A fresh renderer receives the same vault boundary and
surface policy; previously loaded plugins remain failed until explicit reload. Per-plugin process
isolation and CPU or memory budgets remain future work.

Lifecycle ownership includes commands, event registrations, view and extension factories,
processors, editor suggestions, ribbons, status items, settings tabs, leaves, and transient modals
that retain a direct reference to their creating plugin. Targeted unload closes only that plugin's
owned modals and views before releasing its remaining registrations. Reload must reconstruct the
same inventory without duplicates; a second plugin's modal is an explicit negative control.

Plugin CSS crosses a separately bounded and CSP-constrained renderer channel. It is applied only
for selected packages while compatibility mode is enabled. Imports and legacy executable CSS are
rejected. Other non-embedded asset URLs are replaced with inert data URLs and reported before the
remaining stylesheet is applied. `THREADLEAF_SAFE_PLUGINS=1` and `--safe-plugins` suppress both
JavaScript and CSS without changing saved settings. Safe mode and restricted mode remain distinct:
safe mode is a process recovery boundary, while restricted mode is a persisted vault preference.

The current CommonJS host is a trusted compatibility runtime, not a security sandbox. It exposes
only the independently implemented API surface backed by executable fixtures. Installed plugins
outside that surface can fail during activation and are not claimed compatible merely because
discovery succeeds. See the [community plugin compatibility contract](compatibility/plugins.md).

### Watcher and index model

Filesystem notifications are hints, not truth. The watcher emits debounced batches with a stream
ID, monotonic sequence number, and explicit path-state or move operations. Split renames are paired
within a bounded window. Overflow, backend errors, ambiguous renames, and sequence gaps request a
subtree scan or full rebuild instead of guessing.

Non-Markdown filesystem activity publishes an empty sequenced batch without hashing attachment
bytes. This invalidates reading-view asset requests while keeping binary files out of the metadata
index. The next image request performs its own stable, bounded read.

The metadata index is derived state. After every accepted mutation sequence, its externally visible
state must equal an index rebuilt from the current vault bytes. Tests compare incremental and clean
rebuild snapshots for additions, edits, deletions, renames, unresolved links, duplicates, and
recovery.

The Phase 1 Markdown parser deliberately covers a documented structural subset: headings, basic
frontmatter scalars and lists, tags, wiki links, embeds, and local Markdown links. Its link resolver
is provisional. Obsidian-equivalent edge semantics remain gated on the executable behavior corpus
in Phase 3 rather than being inferred from filenames or third-party compatibility claims.

### Full-text search

Full-text search is another disposable projection of saved vault bytes. It never writes a canonical
database and intentionally excludes `.obsidian/`, `.git/`, and Threadleaf transaction artifacts
from the note corpus. The same index reactor that maintains links updates search documents after
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

### Reading view and source mapping

Reading view is an explicit document mode, not an implicit write or a second source of truth. It
renders the current CodeMirror draft, including unsaved changes, without crossing the main-process
write boundary. Switching modes stores only an application preference outside the vault.

The first renderer uses Markdown-it for deterministic block parsing and DOMPurify with a narrow
element and attribute allowlist. Raw HTML is accepted only after sanitization. Scripts, event
handlers, forms, styles, media elements, and active URLs are removed. Markdown images and wiki
embeds first become inert placeholders. A dedicated read-only service may then replace Markdown
image placeholders with sniffed PNG, JPEG, GIF, or WebP bytes. The renderer supplies the source
note, raw target, and expected vault identity; the main process resolves note-relative and
vault-rooted paths, follows symlinks only within the vault, excludes `.obsidian/`, `.git/`, and
transaction artifacts, rechecks the active runtime after asynchronous reads, and never returns a
filesystem URL. Reads are stable and limited to 10 MiB per image. One preview accepts at most 128
images and 64 MiB of decoded input. Oversized, missing, external, malformed, unsupported, and
out-of-vault targets remain labeled placeholders. SVG and wiki embeds remain inert. External links
also stay inert during pre-alpha rather than broadening IPC for shell access prematurely.

Every rendered top-level block carries its source line. A visible line control switches back to
source mode and selects that CodeMirror line. Internal wiki and Markdown links carry normalized
identities, but the derived metadata index remains authoritative for resolution status and target
paths. Dirty-note navigation is blocked and preserves the draft; no preview action silently saves
or discards text.

This is reading preview, not inline live preview. Precise cursor-to-decoration mapping inside one
mixed source/rendered editor remains later Phase 2 work and must preserve the same sanitizer,
source-line, and no-implicit-write guarantees.

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
used by the desktop index. Both exclude `.obsidian/`, `.git/`, `.trash/`, and Threadleaf transaction
artifacts, including canonical targets reached through symlinks. File symlinks remain readable only
when their targets stay inside the visible boundary; recursive discovery does not traverse folder
symlink entries. Dedicated trash inspection is the only read-only exception.

An Obsidian-style compatibility facade may accept familiar public command names and arguments, but
it translates into Threadleaf's own typed command model. It does not make the GUI a hidden CLI
server, copy proprietary implementation details, or create a second mutation path. Every mutating
command uses the same containment, revision, recovery-journal, conflict, and watcher contracts as
the desktop application. See the [CLI guide](cli.md).

The desktop and CLI call one note-creation service. The CLI keeps journals in an
operating-system-owned state root and serializes its mutating invocations with a process-owned
lock, so one headless process never recovers another live process's transaction. The portable
no-clobber install remains the arbiter against desktop, external-editor, and sync-provider races.

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
service snapshots the Markdown corpus, builds the current metadata index, projects the source at
its proposed destination, and builds the projected index from the same bytes. Every parsed wiki and
Markdown link must retain the same resolved, unresolved, or ambiguous meaning after remapping the
moved note's identity.

The shared link parser retains exact source and target ranges while excluding fenced code, inline
code, and HTML comments. When a currently resolved link would change meaning, the move planner
replaces only its target slice: wiki links receive an escaped vault path without `.md`, while
Markdown links receive an escaped path relative to the linking note's projected location. Anchors,
aliases, labels, titles, surrounding whitespace, BOM, line endings, and all unrelated bytes remain
untouched. Replacements are applied from the end of each file, then the complete projected vault is
indexed again. A proposal is valid only when every occurrence resolves to its original logical
target after remapping the moved note's identity. Unresolved or ambiguous links are never guessed.

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

- Long-term process isolation for trusted plugins.
- Native extension SDK license and capability vocabulary.
- Inline live-preview editor architecture and fine-grained cursor mapping.
- Metadata schema and migration strategy.
- Behavior-import apply, rollback, and conflict semantics for the existing preview schema.
- Public benchmark corpora, target devices, and regression budgets.
- Packaging, signing, and update channels.
- Encrypted object format, key hierarchy, recovery model, and residual-metadata budget.
