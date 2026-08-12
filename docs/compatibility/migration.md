# Obsidian behavior migration

Threadleaf opens the same Markdown vault without converting it. The remaining migration problem is
behavior: plugin selection, plugin settings, hotkeys, appearance, CSS snippets, and workspace tabs.
Settings includes a read-only Migration preview so those differences are visible before any future
import action exists.

There is currently no Apply or Import action. Refreshing the preview does not change Threadleaf
settings, `.obsidian/`, or vault files, and it does not load plugin code.

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
evidence. An enabled Obsidian plugin is never selected or executed automatically.

Hotkeys become candidates only when a command mapping has a behavior-tested Threadleaf target and
the source contains exactly one supported binding. The first reviewed mapping is
`command-palette:open` to `ui.command-palette`. All plugin commands and unknown core commands remain
review items.

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

The next migration step is an explicit, independently reviewable apply transaction stored in
Threadleaf's private application data. It must support per-item selection, conflict reporting, and
rollback without making `.obsidian/` Threadleaf's authority.
