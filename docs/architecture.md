# Architecture

The [alternatives landscape review](research/alternatives-landscape.md) is an input to these
decisions. It found that feature breadth is common, while migration continuity, watcher recovery,
plugin continuity, packaging, and contributor depth remain the adoption bottlenecks.

## Current decisions

### Desktop compatibility host

Threadleaf starts as an Electron and TypeScript desktop application. Existing plugins commonly
assume Chromium, the DOM, Node.js, and Electron behavior. Matching that environment reduces the
compatibility problem before optimization begins.

The renderer remains isolated with `contextIsolation`, no Node integration, and Chromium sandboxing.
The trusted compatibility runtime executes outside the renderer and exposes a narrow IPC surface.

### Filesystem authority

Markdown and attachments remain authoritative. Search indexes, metadata graphs, and caches must be
rebuildable from those files. Phase 0 has no user-vault write API.

Threadleaf uses an application-owned state root outside every vault. `.obsidian/` is read as
compatibility input when needed but is never Threadleaf's state directory. The vault kernel accepts
the state root through a port so tests can isolate it and each operating system can use its standard
application-data location.

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
Threadleaf restores that path without automatically loading compatibility plugins. An unavailable
or malformed saved selection falls back to the bundled fixture with a visible warning and does not
erase the saved path, so a temporarily unmounted vault can recover on a later launch.

Every editor draft carries the identity of the vault that produced its revision. The save boundary
rejects a draft after the active vault changes, even if a relative note path happens to exist in
both vaults. The renderer also blocks user-initiated switching while a note is unsaved. Explicit
development overrides take precedence without changing the persisted user selection and are
ignored by packaged builds.

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
Quoted text is one phrase. Ranking favors exact titles, then title, tag, heading, path, property, and
body evidence; results retain bounded contextual lines and source line numbers. Every response
carries the active vault ID and monotonic index generation. The renderer rejects a response that no
longer matches its current vault, query, or generation and immediately requests the current result.

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
explicit exit codes are first-class automation contracts. The initial `vault info`, `files`,
`read`, `search`, and recovery-backed `create` commands run without Electron and require an explicit
vault path.

Read-only kernel opening performs canonical path validation but creates no state directory, vault
identity, recovery journal, or watcher. The CLI note corpus uses the same exclusions and index as
the desktop workspace, so `.obsidian/`, `.git/`, and Threadleaf transaction artifacts do not leak
into file listing, direct note reads, or search.

An Obsidian-style compatibility facade may accept familiar public command names and arguments, but
it translates into Threadleaf's own typed command model. It does not make the GUI a hidden CLI
server, copy proprietary implementation details, or create a second mutation path. Every mutating
command uses the same containment, revision, recovery-journal, conflict, and watcher contracts as
the desktop application. See the [CLI guide](cli.md).

The desktop and CLI call one note-creation service. The CLI keeps journals in an
operating-system-owned state root and serializes its mutating invocations with a process-owned
lock, so one headless process never recovers another live process's transaction. The portable
no-clobber install remains the arbiter against desktop, external-editor, and sync-provider races.

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

## Phase 0 boundaries

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
- Behavior-import schema for hotkeys, themes, CSS, plugin settings, and workspace layout.
- Public benchmark corpora, target devices, and regression budgets.
- Packaging, signing, and update channels.
- Encrypted object format, key hierarchy, recovery model, and residual-metadata budget.
