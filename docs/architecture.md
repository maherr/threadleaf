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

### Watcher and index model

Filesystem notifications are hints, not truth. The watcher emits debounced batches with a stream
ID, monotonic sequence number, and explicit path-state or move operations. Split renames are paired
within a bounded window. Overflow, backend errors, ambiguous renames, and sequence gaps request a
subtree scan or full rebuild instead of guessing.

The metadata index is derived state. After every accepted mutation sequence, its externally visible
state must equal an index rebuilt from the current vault bytes. Tests compare incremental and clean
rebuild snapshots for additions, edits, deletions, renames, unresolved links, duplicates, and
recovery.

The Phase 1 Markdown parser deliberately covers a documented structural subset: headings, basic
frontmatter scalars and lists, tags, wiki links, embeds, and local Markdown links. Its link resolver
is provisional. Obsidian-equivalent edge semantics remain gated on the executable behavior corpus
in Phase 3 rather than being inferred from filenames or third-party compatibility claims.

### Write authority

Every mutation goes through one vault writer. It resolves and validates paths, compares a stable
content revision, stages durable bytes, records recovery intent outside the vault, installs the new
state, and only then retires the journal entry. Rename and multi-file link repair are recoverable
operations, not unrelated filesystem calls.

External changes are preserved. A stale writer never overwrites them silently; it returns a
conflict result and can create an explicit keep-both copy through the same writer. Watcher
suppression is operation-aware rather than a time-only ignore window.

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
- Editor architecture and source-to-preview mapping.
- Metadata schema and migration strategy.
- Packaging, signing, and update channels.
