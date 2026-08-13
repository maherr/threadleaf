# Obsidian behavior migration

Threadleaf opens the same Markdown vault without converting it. The remaining migration problem is
behavior: plugin selection, plugin settings, hotkeys, appearance, CSS snippets, and workspace tabs.
Settings includes a read-only Migration preview and an explicitly reviewed apply path. Refreshing
the preview never changes Threadleaf settings, `.obsidian/`, or vault files, and it never loads
plugin code. Apply writes only Threadleaf's private application state outside the vault.

Apply is transaction-like, not an import shortcut. Each plan records the active vault identity, a
SHA-256 source receipt for every inspected metadata file, installed plugin bundle file, and
selected appearance asset. Bounded files that cannot be hashed carry a filesystem revision. The
plan also records the private-state revision observed before review and a safe before/after
projection. The user checks
individual ready candidates. Missing packages, unsupported mappings, unresolved review items,
stale source receipts, private-state drift, duplicate selections, and capability-grant conflicts
are refused without a write. Threadleaf validates the receipts before journaling and again after the
prepared journal is durable; that second validation is the commit barrier for the reviewed source
generation. A later external source edit is a new generation for the next preview and does not
rewrite the committed private snapshot. Plugin settings values are never copied or returned.

The apply journal is atomically persisted in private application data before either settings or
workspace state is written. It records the before and after snapshots, phase, exact selection, and
recovery receipt. Initial vault activation gates the writable workspace on recovery and completes
only an unambiguous interrupted phase; a later preview repeats recovery as a fallback. Newer private
changes produce an explicit conflict before normal plugin activation. Rollback is offered for the
latest committed apply and refuses to overwrite any newer private revision. Neither apply nor
rollback writes `.obsidian/` or vault Markdown bytes. Plugin code is not loaded or reconciled inside
either transaction. A changed plugin selection takes effect only after an explicit plugin reload or
Threadleaf restart, and the committed response reports that requirement.

## Source boundary

The main process reads five known JSON files through realpath containment and fixed size limits:

| Source | Limit | Previewed behavior |
| --- | ---: | --- |
| `.obsidian/community-plugins.json` | 128 KiB | Obsidian-enabled plugin IDs |
| `.obsidian/appearance.json` | 256 KiB | Base scheme, community theme, and enabled snippets |
| `.obsidian/hotkeys.json` | 512 KiB | Command bindings and reviewed Threadleaf mappings |
| `.obsidian/workspace.json` | 4 MiB | Desktop note tabs, active note, and unsupported view counts |
| `.obsidian/workspace-mobile.json` | 4 MiB | Fallback workspace when the desktop layout is unavailable |

Each installed plugin's `.obsidian/plugins/<id>/data.json` is inspected separately with a 4 MiB
limit. The preview reports only byte length, JSON root kind, and top-level entry count. It never
returns a key or value to the application renderer. The file remains shared in place: previewing it
does not write, but a plugin that the user later enables can update its own settings through its
normal `saveData` lifecycle.

Missing files are valid. Malformed UTF-8, malformed JSON, oversized files, escaping symlinks, and
paths outside the active vault produce explicit diagnostics. JSON parser errors are deliberately
generic so malformed source fragments cannot be reflected into the UI.

## Candidate rules

Plugin rows combine Obsidian's enabled inventory with installed packages. They show whether a
plugin is already selected in Threadleaf, package validity, and exact-version compatibility
evidence. An enabled Obsidian plugin is never selected or executed automatically. Enablement is
locked until compatibility mode is already enabled, and plugins already selected are omitted as
no-ops.

Hotkeys become candidates only when a command mapping has a behavior-tested Threadleaf target and
the source contains exactly one supported binding. The first reviewed mapping is
`command-palette:open` to `ui.command-palette`. All plugin commands and unknown core commands remain
review items. A binding that collides with an existing Threadleaf shortcut is locked as a conflict,
and a binding already at the reviewed target is omitted.

Obsidian appearance modes map conservatively: `obsidian` to dark, `moonstone` to light, and
`system` to system-following. A community theme or snippet becomes a candidate only when its
contained package file is present. Missing assets stay visible instead of silently falling back.

Workspace preview walks a bounded layout tree. It proposes only existing main-area Markdown and
Excalidraw note paths, preserves their order, and identifies the restorable active note. Sidebars,
search, backlinks, bookmarks, and other view types are counted as unsupported rather than
translated speculatively. Desktop workspace state takes precedence; a valid mobile workspace is a
fallback.

## Evidence

Automated fixtures prove absent-state handling, candidate extraction, mobile fallback, malformed
and oversized input handling, symlink and traversal rejection, private-value non-disclosure, and
exact source-byte preservation. A production Electron fixture copied a real `.obsidian` directory,
rendered the preview in light and dark schemes, verified the active Excalidraw tab and exact-version
compatibility evidence, and confirmed all 28 metadata files remained byte-for-byte unchanged.

The Electron rehearsal covers preview, keyboard selection, conflict-locked plugin candidates,
apply, restart recovery, rollback, both schemes, a visual positive control, and byte equality for
the complete `.obsidian/` tree. Unit fixtures cover stale source, partial choice, malformed input,
interruption recovery, rollback conflict, and same-name vault identity separation.
