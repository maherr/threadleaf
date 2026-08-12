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
out-of-vault targets stay explicit placeholders. A headless CLI now inspects vaults, lists and reads
notes, returns either ranked search paths or grep-style matching lines, and creates notes through the
recoverable writer with stable JSON and explicit exit codes, without requiring the Electron
application. Search supports folder, limit, case, count, and text/JSON controls. Read-only graph
commands report outgoing links, grouped backlinks, non-resolved links, orphans, syntax-level dead
ends, and line-aware outlines through the same metadata index as the desktop, with count and
structured output modes. The desktop New action,
Ctrl/Cmd+N, and the CLI share one no-overwrite creation service. Missing folders are created,
ordinary existing paths fail without mutation, and a path claimed during the final race window
preserves the proposed bytes as a labeled conflict note. Headless append and prepend commands also
use the recovery-backed writer. They require an existing note, preserve its line-ending convention,
and keep a full proposed conflict copy if an external edit wins the revision race. Headless move
and rename commands project the complete post-move index before writing. They preview exact
source-range-preserving target rewrites, refuse unresolved ambiguity, and prove the proposed bytes
against a final rebuilt index. `--update-links` applies the current CLI plan explicitly. The desktop
Move action and Ctrl/Cmd+Shift+M require a second confirmation bound to the exact preview. One parent
recovery journal coordinates every revision-checked rewrite, the final rename, reverse-order
rollback, and keep-both recovery when an external edit wins. Successful moves refresh affected
index entries and remap open tabs. Headless delete moves exact
bytes to the same path under vault-local `.trash/`; dedicated list and restore commands keep that
recovery content outside the ordinary corpus and never overwrite either side of a collision. The
desktop Trash action uses the same revision-bound service behind a confirmation that names both
paths and the indexed-link impact. A committed move closes the note tab and selects its surviving
neighbor; a stale revision or occupied trash path remains reviewable and changes nothing.
Headless property commands list and read the current indexed projection, then set or remove typed
top-level YAML properties through a byte-preserving, revision-checked application service. The
writer handles text, list, number, checkbox, date, and datetime values, preserves unrelated
frontmatter and body bytes, and refuses complex YAML shapes instead of reserializing them blindly.
Headless task commands scan ordinary Markdown list checkboxes across the vault or one targeted note,
filter complete, incomplete, and custom statuses, and address one task by its exact source line.
Toggle, done, todo, and custom-status mutations replace only the checkbox character through the
recoverable writer. Unrelated bytes remain exact, no-op requests do not write, and an external-edit
race keeps the proposed note as a conflict copy.
Headless alias and tag catalogs reuse the rebuildable metadata index. They can inspect the full
vault or one targeted note, retain frontmatter aliases with their source paths, distinguish unique tag
names from occurrence totals, and report every document carrying a requested tag.
Read-only file and folder commands inventory ordinary notes, attachments, Canvas documents, and
empty folders without exposing application-private trees. They support recursive folder and
extension filters, metadata and byte totals, explicit duplicate-name failures, and Unicode-aware
word and grapheme-character counts.
Runtime-owned tabs keep one
ordered entry per open note, reactivate an existing entry instead of duplicating it, follow
externally renamed notes, and remove externally deleted notes. Closing an active tab selects its
right neighbor, then its left neighbor. Their order and active note restore per vault from
versioned private application data. An intentionally empty workspace stays empty, missing notes
are pruned on restore, and malformed state remains available for diagnosis behind a visible
warning. No workspace metadata is written into the vault or `.obsidian/`.

Vault appearance support now discovers standard `.obsidian/themes/<name>/theme.css` packages and
`.obsidian/snippets/*.css` files without changing them. A per-vault selection, base color scheme,
and enabled snippet order are stored in Threadleaf's private application settings. Custom CSS is
size bounded, path contained, checked for network-capable and legacy executable constructs, and
applied under the renderer content-security policy. Missing or invalid selections degrade to the
default appearance with visible diagnostics. A startup safe mode and a recovery shortcut disable
custom CSS without preventing catalog inspection.

Community-plugin management now discovers standard `.obsidian/plugins/<id>/manifest.json`,
`main.js`, and optional `styles.css` packages through bounded, path-contained reads. Threadleaf
keeps its enabled set and restricted-mode choice in private per-vault application settings, never
in `.obsidian/`. Multiple selected plugins reconcile independently at startup and after enable,
disable, or reload operations. A full Settings catalog reports invalid packages and runtime load
failures without hiding the rest of the inventory. Startup plugin safe mode preserves the saved
selection while loading no community code or CSS. The compatibility host remains an explicitly
trusted, unsandboxed desktop runtime, and its API is still too small for general plugins such as
Excalidraw to complete their workflows.

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
- [Theme and CSS compatibility](docs/compatibility/themes.md)
- [Community plugin compatibility](docs/compatibility/plugins.md)
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
properties; Ctrl/Cmd+, opens application settings. Search terms use AND semantics and quoted text is
matched as a phrase. Every listed shortcut can be reassigned or cleared, and Reset defaults
restores the portable built-in bindings. Threadleaf stores these preferences in private
application data, not in the vault or `.obsidian/`. Ctrl/Cmd+E switches between Markdown source and
reading view. Ctrl/Cmd+W closes the active clean tab; Alt+Left and Alt+Right move through open tabs.
Open-tab order and the active note restore separately for each vault. Closing every tab is also a
persisted choice, while paths that no longer exist are removed from the saved workspace on the
next successful launch.
Reading view previews the current draft without saving it; clicking a source-line control returns
to the exact source line. Relative and vault-rooted local raster images render without exposing
filesystem paths or general file access to the renderer. Ctrl/Cmd+N opens the New note dialog and
selects the resulting empty Markdown note for editing. Ctrl/Cmd+Shift+M opens Move for the active
clean note. Threadleaf commits only when the projected whole-vault index preserves every internal
link resolution. It presents the exact rewrite count before enabling confirmation; for unusually
large moves, the dialog names the first 100 target updates and reports the full count. Unsafe
ambiguous changes stay visibly blocked and write nothing. Trash has no
default shortcut, but it is available from the note toolbar and command palette and can be assigned
one in keyboard settings. Its confirmation moves the exact current revision to
`.trash/<original-path>`, warns when indexed incoming links will become unresolved, and never
overwrites an earlier deletion. Restore through the native CLI or move the file back with another
filesystem tool.

The Appearance section follows the operating-system scheme by default and can pin light or dark.
It discovers community themes and CSS snippets from the active vault, applies a selected theme
before the enabled snippets, and exposes an explicit file reload. Ctrl/Cmd+Shift+L toggles the base
scheme. Ctrl/Cmd+Alt+L clears the current vault's custom theme and snippet selection while retaining
the base scheme. Start with `THREADLEAF_SAFE_APPEARANCE=1` or `--safe-appearance` to suppress all
custom CSS for that process while keeping the saved selection available for diagnosis.

The Community plugins section discovers installed packages without executing them. Restricted mode
is the default for a vault with no saved Threadleaf plugin preference. Turn it off, then enable only
packages you trust. Threadleaf persists that selection outside the vault and reloads it on the next
start. Start with `THREADLEAF_SAFE_PLUGINS=1` or `--safe-plugins` to suppress every community plugin
bundle and stylesheet for that process while keeping the catalog and saved selection visible.

Development and verification runs can bypass the native picker with an isolated vault copy:

```sh
THREADLEAF_VAULT_PATH=/absolute/path/to/disposable-vault pnpm start
```

This non-packaged development override is not persisted and is ignored by packaged builds. The
`pnpm check` gate verifies the packaged Electron entry points and confirms that renderer assets
remain loadable over `file://`. It also executes the built CLI against disposable synthetic-vault
copies, validates its versioned JSON envelope, proves an exact property set/read/remove round trip,
proves alias and tag catalog output, proves an exact task read/status/toggle round trip, and proves
exact-byte delete and restore behavior. It also resolves a packaged `file=` command by unique note
name so basename compatibility cannot pass only in source-level tests, and exercises visible-file
inventory plus Unicode word counting.

The development CLI requires an explicit vault and never consults the desktop application's saved
selection:

```sh
pnpm cli --vault /absolute/path/to/vault vault info
pnpm cli --vault /absolute/path/to/vault files
pnpm cli --vault /absolute/path/to/vault file file="cover.png"
pnpm cli --vault /absolute/path/to/vault files folder="Attachments" ext=png total
pnpm cli --vault /absolute/path/to/vault folder path="Projects" info=size
pnpm cli --vault /absolute/path/to/vault folders folder="Projects" total
pnpm cli --vault /absolute/path/to/vault wordcount file="Note" words
pnpm cli --vault /absolute/path/to/vault read "Folder/Note.md"
pnpm cli --vault /absolute/path/to/vault search query="quoted phrase" path="Projects" limit=20
pnpm cli --vault /absolute/path/to/vault search:context query="quoted phrase" format=json
pnpm cli --vault /absolute/path/to/vault links path="Folder/Note.md" total
pnpm cli --vault /absolute/path/to/vault backlinks file="Note" counts format=csv
pnpm cli --vault /absolute/path/to/vault unresolved counts verbose format=json
pnpm cli --vault /absolute/path/to/vault outline path="Folder/Note.md" format=md
pnpm cli --vault /absolute/path/to/vault create "Inbox/New thought"
pnpm cli --vault /absolute/path/to/vault create path="Projects/Brief" content="# Brief\n"
pnpm cli --vault /absolute/path/to/vault append path="Daily/Today" content="- [ ] Follow up"
pnpm cli --vault /absolute/path/to/vault prepend "Projects/Brief.md" --content="Draft context"
pnpm cli --vault /absolute/path/to/vault move "Inbox/Thought.md" --to "Archive/Thought.md" --update-links
pnpm cli --vault /absolute/path/to/vault rename path="Draft.md" name="Published" --update-links
pnpm cli --vault /absolute/path/to/vault delete path="Archive/Old thought.md"
pnpm cli --vault /absolute/path/to/vault trash list
pnpm cli --vault /absolute/path/to/vault restore path="Archive/Old thought.md"
pnpm cli --vault /absolute/path/to/vault properties path="Projects/Brief.md"
pnpm cli --vault /absolute/path/to/vault property:read path="Projects/Brief.md" name=status
pnpm cli --vault /absolute/path/to/vault property:set path="Projects/Brief.md" name=status value=review
pnpm cli --vault /absolute/path/to/vault property:set path="Projects/Brief.md" name=aliases 'value=["Brief","Overview"]' type=list
pnpm cli --vault /absolute/path/to/vault property:remove path="Projects/Brief.md" name=status
pnpm cli --vault /absolute/path/to/vault tasks todo verbose
pnpm cli --vault /absolute/path/to/vault task ref="Daily/Today.md:12" done
pnpm cli --vault /absolute/path/to/vault task path="Daily/Today.md" line=12 status="?"
pnpm cli --vault /absolute/path/to/vault aliases verbose
pnpm cli --vault /absolute/path/to/vault tags sort=count counts
pnpm cli --vault /absolute/path/to/vault tag name=project verbose
```

See the [CLI guide](docs/cli.md) for the output contract, exit codes, and currently supported
Obsidian-style argument spellings.

Run `pnpm benchmark:search` for the deterministic 10,000-note search microbenchmark. It reports
measurements rather than enforcing machine-dependent timing thresholds.

## License

The application core is licensed under `AGPL-3.0-or-later`. A future standalone extension SDK may
use a permissive license so plugins can target Threadleaf without inheriting the application's
license.
