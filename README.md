# Threadleaf

> Your vault, on an open runtime.

Threadleaf is an early-stage, fully open, local-first knowledge workspace. Its central goal is to
open existing Markdown vaults without conversion and provide meaningful compatibility with the
community plugins people already depend on.

Threadleaf is not affiliated with or endorsed by Obsidian.

## Status

Threadleaf is pre-alpha. Its Phase 0 architecture proof loads an unchanged CommonJS fixture
plugin, provides it with an independently implemented `obsidian` compatibility module, registers a
command, and exercises that command through an isolated Electron renderer. The fixture completes
the documented load, activation, integration, command, reload, and unload lifecycles.

Phase 1 is complete. The vault kernel proves canonical path containment,
durable recovery journals, external-edit conflict preservation, serialized writes, and recoverable
renames against filesystem fixtures. A sequenced live watcher and rebuildable metadata index now
converge across internal writes, external edits, renames, conflicts, event gaps, and backend
fallbacks. Multi-file operations durably retain every proposal and resume safely after interruption.

Phase 2 is in progress. The production runtime now composes that kernel, watcher, index, one shared
action registry, and the compatibility host. The Electron workspace can open an arbitrary local
Markdown folder, restore the last successful selection, edit through CodeMirror, inspect headings,
tags, links, and backlinks, search saved Markdown with contextual line matches, and reflect external
changes without giving the renderer filesystem access. Search results identify the vault and index
generation that produced them, so a late response cannot cross a vault switch or overwrite newer
derived state. Revision-aware saves use the recoverable writer. If the file changed externally, the
original is left untouched and the local edit becomes a clearly labeled conflict copy. Core actions
and dynamically registered compatibility-plugin commands share a searchable, keyboard-navigable
command palette. Versioned application settings now keep remappable keyboard shortcuts outside
every vault, reject collisions, and persist changes before activating them. Compatibility plugins
in selected and restored vaults stay off by default. An explicit reading view renders the current
editor draft through a sanitized Markdown subset, keeps unsaved text off disk, resolves internal
links through the derived index, and provides source-line controls that return to the matching
CodeMirror line. Sniffed local PNG, JPEG, GIF, and WebP attachments now render through a
vault-scoped, size-bounded main-process service; external, oversized, unsupported, private, and
out-of-vault targets stay explicit placeholders. A headless CLI now inspects vaults, lists and
reads notes, searches indexed content, and creates notes through the recoverable writer with stable
JSON and explicit exit codes, without requiring the Electron application. The desktop New action,
Ctrl/Cmd+N, and the CLI share one no-overwrite creation service. Missing folders are created,
ordinary existing paths fail without mutation, and a path claimed during the final race window
preserves the proposed bytes as a labeled conflict note. Headless append and prepend commands also
use the recovery-backed writer. They require an existing note, preserve its line-ending convention,
and keep a full proposed conflict copy if an external edit wins the revision race. Headless move
and rename commands project the complete post-move index before writing. They proceed only when
every wiki and Markdown link keeps the same resolution, and otherwise return exact blockers without
changing the vault. Runtime-owned tabs keep one ordered entry per open note, reactivate an existing
entry instead of duplicating it, follow externally renamed notes, and remove externally deleted
notes. Closing an active tab selects its right neighbor, then its left neighbor. Tab state is
session-local and does not write workspace metadata into the vault.

Do not use the current build with an important vault. The picker and recoverable writer are now
functional, but Threadleaf is still pre-alpha and has no inline live preview, wiki-embed rendering,
or release-grade backup and restore workflow.

## Product promises

- Open an existing Markdown vault without converting its content.
- Keep application state separate from `.obsidian/`.
- Make compatibility measurable instead of relying on vague claims.
- Treat the filesystem as authoritative and every index as rebuildable.
- Make every future write atomic, recoverable, and visible.
- Support existing trusted plugins while developing a safer capability-based native extension API.
- Remain useful offline without an account, subscription, or hosted service.
- Keep any future encrypted sync protocol and server open and self-hostable.
- Keep the native CLI headless, script-safe, and backed by the same vault kernel as the desktop app.

## Project map

- [Project charter](docs/charter.md)
- [Architecture](docs/architecture.md)
- [CLI guide](docs/cli.md)
- [Compatibility contract](docs/compatibility/contract.md)
- [Roadmap](docs/roadmap.md)
- [Performance baselines](docs/performance.md)
- [FOSS alternatives landscape review](docs/research/alternatives-landscape.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Development

Threadleaf currently requires Node.js 22 or newer and pnpm.

```sh
pnpm install
pnpm check
pnpm start
```

On first launch, the executable build opens the bundled synthetic vault. Use the Open control or
Ctrl/Cmd+O to select a Markdown folder. Threadleaf validates and persists a successful selection,
restores it on the next launch, and does not automatically run its compatibility plugins.
Ctrl/Cmd+K opens the command palette; Ctrl/Cmd+P searches saved content, paths, headings, tags, and
properties; Ctrl/Cmd+, opens keyboard settings. Search terms use AND semantics and quoted text is
matched as a phrase. Every listed shortcut can be reassigned or cleared, and Reset defaults
restores the portable built-in bindings. Threadleaf stores these preferences in private
application data, not in the vault or `.obsidian/`. Ctrl/Cmd+E switches between Markdown source and
reading view. Ctrl/Cmd+W closes the active clean tab; Alt+Left and Alt+Right move through open tabs.
Reading view previews the current draft without saving it; clicking a source-line control returns
to the exact source line. Relative and vault-rooted local raster images render without exposing
filesystem paths or general file access to the renderer. Ctrl/Cmd+N opens the New note dialog and
selects the resulting empty Markdown note for editing.

Development and verification runs can bypass the native picker with an isolated vault copy:

```sh
THREADLEAF_VAULT_PATH=/absolute/path/to/disposable-vault pnpm start
```

This non-packaged development override is not persisted and is ignored by packaged builds. The
`pnpm check` gate verifies the packaged Electron entry points and confirms that renderer assets
remain loadable over `file://`. It also executes the built CLI against the synthetic vault and
validates its versioned JSON envelope.

The development CLI requires an explicit vault and never consults the desktop application's saved
selection:

```sh
pnpm cli --vault /absolute/path/to/vault vault info
pnpm cli --vault /absolute/path/to/vault files
pnpm cli --vault /absolute/path/to/vault read "Folder/Note.md"
pnpm cli --vault /absolute/path/to/vault --json search "quoted phrase" --limit 20
pnpm cli --vault /absolute/path/to/vault create "Inbox/New thought"
pnpm cli --vault /absolute/path/to/vault create path="Projects/Brief" content="# Brief\n"
pnpm cli --vault /absolute/path/to/vault append path="Daily/Today" content="- [ ] Follow up"
pnpm cli --vault /absolute/path/to/vault prepend "Projects/Brief.md" --content="Draft context"
pnpm cli --vault /absolute/path/to/vault move "Inbox/Thought.md" --to "Archive/Thought.md"
pnpm cli --vault /absolute/path/to/vault rename path="Draft.md" name="Published"
```

See the [CLI guide](docs/cli.md) for the output contract, exit codes, and currently supported
Obsidian-style argument spellings.

Run `pnpm benchmark:search` for the deterministic 10,000-note search microbenchmark. It reports
measurements rather than enforcing machine-dependent timing thresholds.

## License

The application core is licensed under `AGPL-3.0-or-later`. A future standalone extension SDK may
use a permissive license so plugins can target Threadleaf without inheriting the application's
license.
