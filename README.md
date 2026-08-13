# Threadleaf

> Your vault, on an open runtime.

Threadleaf is an early-stage, fully open, local-first knowledge workspace. Its central goal is to
open existing Markdown vaults without conversion and provide meaningful compatibility with the
community plugins people already depend on.

Threadleaf is not affiliated with or endorsed by Obsidian.

## Status

Threadleaf 0.1.0-beta.3 is ready for maintainer-led daily-drive testing. Its Phase 0 architecture
proof loads an unchanged CommonJS fixture
plugin, provides it with an independently implemented `obsidian` compatibility module, registers a
command, and exercises that command through a dedicated Electron compatibility renderer. The
primary application renderer remains sandboxed and has no Node integration. The fixture completes
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
derived state. The first window no longer waits for a complete restored-vault scan: it names the
target, shows indexing state, blocks bootstrap writes, and lets a user choose another vault while
the real runtime opens in the background. Revision-aware saves use the recoverable writer. If the
file changed externally, the original is left untouched and the local edit becomes a clearly
labeled conflict copy. Unsaved Markdown is also protected in a versioned, atomic, private draft
store outside the vault. Threadleaf retains the exact vault, note, base revision, bytes, and
selection, clears only the matching committed or reverted draft, and replaces a stopped main
renderer with a fresh window that restores that state. If the disk changed while the renderer was
down, recovery keeps the changed disk note untouched and routes a later save through the same
conflict-copy path. Core actions and dynamically registered compatibility-plugin commands share
a searchable, keyboard-navigable command palette. Versioned application settings now keep remappable
keyboard shortcuts outside every vault, reject collisions, and persist changes before activating
them. Compatibility plugins
in selected and restored vaults stay off by default. Live Preview is the fresh-install editing
default, with explicit Live, Source, and Read modes in each pane. It keeps canonical Markdown and
the existing CodeMirror undo, draft, save, and conflict paths, reveals exact source on cursor and
selection lines, renders common Markdown presentation elsewhere, and edits task markers through
normal source transactions. An explicit reading view renders the current editor draft through a
sanitized Markdown subset, keeps unsaved text off disk, resolves internal links through the derived
index, and provides source-line controls that return to the matching CodeMirror line. Sniffed local
PNG, JPEG, GIF, and WebP attachments now render through a
vault-scoped, size-bounded main-process service; PDFs, audio, video, common documents, text,
archives, and unknown bytes resolve to safe metadata cards by magic bytes. External, oversized,
unsupported, private, and out-of-vault targets stay explicit placeholders. Whole-note, heading, and
block-ID note embeds now
render recursively through a separate read-only service with exact source controls and explicit
cycle, depth, count, byte, containment, and stale-vault limits. A headless CLI now inspects vaults,
lists and reads notes, returns either ranked search paths or grep-style matching lines, and creates
notes through the recoverable writer with stable JSON and explicit exit codes, without requiring the
Electron application. Search supports folder, limit, case, count, and text/JSON controls. Read-only
graph commands report outgoing links, grouped backlinks, non-resolved links, orphans, syntax-level
dead ends, and line-aware outlines through the same metadata index as the desktop, with count and
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
neighbor; a stale revision or occupied trash path remains reviewable and changes nothing. Desktop
File Recovery lists recoverable Markdown notes without returning them to the ordinary corpus,
filters original and recovery paths, and restores the exact listed revision to its original path.
If that path is occupied or the recovery entry changed, both copies remain untouched and the
dialog explains the conflict; it intentionally offers no permanent-delete action.
Each vault also has an ordered private bookmark shelf outside the vault. The note toolbar,
command palette, native menu, and remappable hotkey target share one toggle action. Internal moves
remap bookmarked paths, externally missing notes remain visible for removal or later recovery, and
bookmarking never creates or changes `.obsidian/` or any other vault metadata.
The Export action, command palette, native File menu, and remappable hotkey target save the active
saved note as one standalone HTML document. Threadleaf sanitizes raw HTML, embeds bounded local
raster images and note transclusions, keeps safe web and email links active, and renders vault-only
links as visibly inert references. The result has no scripts, plugin code, vault path or identity,
private app state, or dependency on Threadleaf, Obsidian, an account, or a network connection. The
main process rechecks the active vault, note revision, and stable disk bytes after the Save dialog,
refuses a target inside the vault, and installs the export atomically with mode-0600 permissions.
Headless property commands list and read the current indexed projection, then set or remove typed
top-level YAML properties through a byte-preserving, revision-checked application service. The
writer handles text, list, number, checkbox, date, and datetime values, preserves unrelated
frontmatter and body bytes, and refuses complex YAML shapes instead of reserializing them blindly.
The nested property service adds dotted and indexed scalar paths and safe mapping additions through
the same recovery-backed preview and mutation boundary. It reports duplicate keys, anchors, tags,
multiline scalars, flow values, and syntax errors as read-only reasons rather than normalizing them.
The desktop right inspector presents those top-level properties in source order and uses the same
service for typed add, edit, and remove actions. Dirty notes, stale revisions, read-only vaults, and
unsupported complex values remain explicit no-write states instead of silently normalizing YAML.
Headless task commands scan ordinary Markdown list checkboxes across the vault or one targeted note,
filter complete, incomplete, and custom statuses, and address one task by its exact source line.
Toggle, done, todo, and custom-status mutations replace only the checkbox character through the
recoverable writer. Unrelated bytes remain exact, no-op requests do not write, and an external-edit
race keeps the proposed note as a conflict copy.
Headless alias and tag catalogs reuse the rebuildable metadata index. They can inspect the full
vault or one targeted note, retain frontmatter aliases with their source paths, distinguish unique tag
names from occurrence totals, and report every document carrying a requested tag.
The same headless surface now offers read-only community-plugin, theme, and CSS snippet catalogs
through the existing bounded desktop loaders. These familiar command names remain intentionally
narrow: they require an explicit vault, never execute plugin code or apply CSS, never read private
enablement or active selections, and never write `.obsidian/` or Threadleaf state.
Read-only file and folder commands inventory ordinary notes, attachments, Canvas documents, and
empty folders without exposing application-private trees. They support recursive folder and
extension filters, metadata and byte totals, explicit duplicate-name failures, and Unicode-aware
word and grapheme-character counts.
Runtime-owned panes keep one ordered entry per open note in each pane, reactivate an existing entry
instead of duplicating it, follow externally renamed notes, and remove externally deleted notes.
Each pane also has a stable leading pinned region. Pinning moves a tab to that region's end;
unpinning moves it to the beginning of the ordinary region. Pinned tabs use both a text marker and
an accessible Pin or Unpin control, cannot be closed or trashed until unpinned, and are available
through the command palette, native Workspace menu, and a remappable hotkey target. The workspace
can split right or down, move the active tab between panes, collapse back to one pane, and keep
independent CodeMirror selection, undo, and protected crash-draft state in both. Tabs can also be
reordered or transferred by pointer and keyboard without crossing the pinned boundary. The notes
and inspector docks collapse independently. A visible compatibility-plugin view can move into a
native window and return to the main workspace; a closed, crashed, stale, or vault-mismatched
window is reattached or reported explicitly instead of remaining a false live layout entry. Tab
order, pins, active notes, focused pane, split direction, docks, and safe window bounds restore per
vault from versioned private application data. The stored tab document also retains a validated
one-pane projection that the prior daily-driver build can read during rollback. An intentionally
empty workspace stays empty, missing notes are pruned on restore, and malformed state remains
available for diagnosis behind a visible warning without rewriting its bytes. Native application
menus dispatch the same saved-keybinding actions to the focused workspace. No workspace metadata
is written into the vault or `.obsidian/`.

Daily notes and templates now use the same recovery-backed note-creation path as New. Settings can
choose a template folder, default date and time formats, daily-note folder and date format, and an
optional daily template for each vault without writing configuration into it. Desktop commands
open or create today's note, insert a selected template at the CodeMirror selection, and insert the
current date or time. Existing daily notes are opened without rewriting them. The native CLI offers
the same explicit template expansion and daily-note behavior for headless workflows.

The desktop now projects global and local vault graphs from the same disposable metadata index as
links, backlinks, search, and the CLI. Open Vault Graph and Open Local Graph are available in the
View menu and command palette. Global graphs can filter indexed notes by path, title, or tag and can
include unconnected notes. Local graphs keep the active note visible and traverse one to four link
steps. Direction arrows, zoom, pointer panning, keyboard panning, focusable nodes, and an equivalent
visible-note list keep the view useful without making color or precise pointer control the only way
to navigate. Projection limits and truncation are explicit, and opening or closing a graph never
writes to the vault.

Vault appearance support now discovers standard `.obsidian/themes/<name>/theme.css` packages and
`.obsidian/snippets/*.css` files without changing them. A per-vault selection, base color scheme,
and enabled snippet order are stored in Threadleaf's private application settings. Custom CSS is
size bounded, path contained, checked for network-capable and legacy executable constructs, and
applied under the renderer content-security policy. Missing or invalid selections degrade to the
default appearance with visible diagnostics. A startup safe mode and a recovery shortcut disable
custom CSS without preventing catalog inspection. While a real vault is active, Threadleaf also
watches the selected vault's theme and snippet sources. External edits, atomic saves, deletes, and
restorations are coalesced into a bounded reload without changing `.obsidian/` or private settings.

Community-plugin management now discovers standard `.obsidian/plugins/<id>/manifest.json`,
`main.js`, and optional `styles.css` packages through bounded, path-contained reads. Threadleaf
keeps its enabled set and restricted-mode choice in private per-vault application settings, never
in `.obsidian/`. Multiple selected plugins reconcile independently at startup and after enable,
disable, or reload operations. A full Settings catalog reports invalid packages and runtime load
failures without hiding the rest of the inventory. Before enablement, each package reports its
declared Obsidian API baseline, desktop-only flag, standard bundled-dependency model, and measured
compatibility evidence. Evidence is exact to the tested plugin version: Excalidraw 2.25.3 reports
its named level 4 workflows, a different release remains unverified, and an unknown plugin starts
at discovered level 0. Each valid package also gets a conservative static authority report over
the exact raw `main.js` bytes. Threadleaf blocks both JavaScript and CSS until the user grants that
exact bundle for the current vault. Any byte change makes the grant stale; revocation disables and
unloads the plugin. The execution renderer re-hashes the raw bytes immediately before compilation,
so a file replacement after review is blocked too. This report is an explicit trust aid, not a
runtime permission sandbox. The same page searches the community package index without
downloading plugin code. Opening Review
fetches one exact GitHub release plus its repository license into
private, expiring staging and displays the pinned version, source, retained license, and complete
SHA-256 evidence before any vault write. Apply first removes the plugin from Threadleaf's enabled
set and unloads its runtime. Installs, updates, reinstalls, rollbacks, uninstalls, and restores all
remain disabled until separately enabled. Updates preserve package data, rollback restores reviewed
code assets while retaining current data, and uninstall keeps a complete private recovery snapshot.
Managed code, manifest, stylesheet, receipt, and license bytes are rechecked before every load;
changed bytes are visibly blocked until a reviewed reinstall. Every package mutation has a durable
private transaction journal and up to five retained package versions. Restart recovery either
restores the exact prior directory and private metadata or completes cleanup for an already
committed operation. The current source adapter reads the public `obsidian-releases` registry at
runtime but does not redistribute it or represent that unlicensed repository as Threadleaf's future
open directory. The source interface and review protocol are replaceable open code.

Native Threadleaf extensions use a separate version 1 capability host and SDK. The checked-in
portable fixture reads a note and writes a summary through public vault ports. Exact bundle bytes,
authority declarations, and private per-vault grants are reviewed before execution; stale grants,
revocation, safe mode, undeclared calls, unavailable ports, and cross-vault requests fail with typed
diagnostics. The first host reports `sandboxed: false`: it is an in-process capability boundary,
not an OS sandbox. Navigation, subprocesses, secrets, and dynamic code are explicitly labeled
trusted desktop escapes. See [Native extension capability contract](docs/compatibility/native-extensions.md).

Threadleaf's separate [generated compatibility registry](docs/compatibility/registry.md) publishes
exact plugin and Threadleaf versions, bundle digests, static authority classes, platform limits,
supported workflows, executable evidence gates, known failures, limitations, and last-tested
dates. Package discovery and compatibility evidence are deliberately different datasets.

Startup plugin safe mode preserves the saved selection while loading no community code or CSS.
Each compatibility host remains an explicitly trusted desktop runtime in a separate transient
Electron session with Node integration, a
browser `connect-src 'none'` policy, denied browser permissions, blocked popups and
navigation, typed lifecycle messages, operation deadlines, and renderer-exit attribution. Each
plugin gets its own renderer process and transient partition. A timed-out operation, available
memory breach, sustained CPU breach, invalid response, send failure, or renderer crash terminates
only the culprit process. The default guardrail is a 512 MiB renderer working-set ceiling and
sustained 60 percent CPU budget after a five-second startup quiet window and three consecutive
samples. If Electron cannot provide valid metrics, Threadleaf reports them as unavailable and does
not fabricate a measurement or kill the plugin. These are trusted-host guardrails, not OS
sandboxing or hard isolation from Node-capable plugin I/O. Threadleaf starts a clean renderer,
keeps healthy sibling plugins and the native workspace responsive, and marks the culprit for
explicit reload instead of assuming its in-memory state survived. The host's
independently implemented DOM and UI base APIs activate the unchanged Excalidraw 2.25.3 release
bundle in both a disposable DOM probe and the production compatibility renderer. Excalidraw
registers two views, its commands, a ribbon action, a settings tab, and a Markdown processor. An
existing Excalidraw Markdown document now opens through the production host as the plugin's real
loaded canvas in a visible workspace leaf, with its plugin-owned filename and action bar kept
distinct from ordinary Markdown editor chrome. The plugin can mutate an existing drawing, save it
through Threadleaf's revision-bound recoverable writer, close the drawing leaf, and reconstruct the
same persisted scene after reopening. That named edit, save, close, and reopen workflow is measured
level 4. New drawing creation, native-editor embed insertion, and SVG/PNG vault export are also
measured level 4 workflows. Full active-view unload and reload is measured too: plugin-owned
transient UI, the drawing leaf, all 69 commands, and every registered integration are removed, and
two reload cycles restore the exact command and integration counts without duplicates or runtime
errors. Compatibility plugins can also rename and recoverably trash revision-bound attachments
through public `Vault.rename`, `FileManager.renameFile`, and `FileManager.trashFile` APIs. The
unchanged Excalidraw plugin has moved and trashed real binary fixtures through those paths while
preserving their exact SHA-256 digests, and recovery fixtures cover interrupted renames plus
external-edit conflicts without replacing either side. The corresponding official Obsidian
same-vault roundtrip is still pending. The deterministic public-format corpus and isolated Electron
gate are documented in [Excalidraw round-trip boundary](docs/compatibility/excalidraw-roundtrip.md).
Untested export formats and universal plugin parity remain unsupported. Excalidraw's release-notes modal and Threadleaf
light/dark chrome also render, and its stylesheet is preserved while four remote font URLs are
replaced with inert embedded assets. The runtime is still trusted:
Node-capable plugin code can perform its own I/O.

Settings now includes a reviewed Migration flow for existing Obsidian behavior. It reports enabled
and installed plugins, private settings-file shape without keys or values, reviewed hotkey
candidates, appearance assets, and restorable note tabs through bounded contained reads. Refreshing
the preview starts no new source-driven migration. It does not load plugin code or write `.obsidian/`
or vault Markdown; before reading the source, it recovers any already-journaled explicit Apply, which
may persist its private workspace state or surface a conflict. After selecting one or more `ready`
candidates, Apply checked items commits only those reviewed candidates
to Threadleaf's private application state outside the vault, with receipt validation, interruption
recovery, and rollback of the latest committed apply. It never copies plugin setting values or
writes `.obsidian/` or vault Markdown; unsupported, missing, conflicting, and other non-ready
candidates, plus stale plans, remain blocked, and plugin runtime changes require an explicit reload
or restart.

The current Linux build has crossed the daily-drive beta handoff: real-scale copied-vault use,
editor and crash recovery, isolated compatibility plugins, unchanged Excalidraw workflows,
installable packages, privacy-safe feedback, and a distinct-package upgrade and rollback sequence
all pass. Keep an ordinary external backup while field testing. Live Preview now provides
fine-grained source/decorated cursor mapping and bounded source-backed inline note transclusion. It
deliberately keeps frontmatter, tables, HTML, malformed links, nested destinations, and other
unsupported or ambiguous constructs visible as source. Math is not rendered as math and has no
complete editing contract, so complex constructs may remain source or receive only narrower existing
decorations. Completing rendered and editable support for tables, math, diagrams, and large-document
editing beyond the current source fallback remains open.
Broad community-plugin compatibility remains measured per plugin rather than assumed.

Unsigned Linux x64 AppImage and RPM artifacts now exercise the real packaged application rather
than a development server. A fresh package opens an external, read-only demo vault, keeps the
license beside the application resources, rejects forged demo-vault mutations in the backend, and
ignores development-only vault overrides. The package checks launch the AppImage end to end,
inspect the RPM metadata and payload, and write SHA-256 checksums. A separate proof compares two
independent unpacked application trees and normalized archives byte for byte. Native macOS ARM64
ZIP and DMG packages have also passed executable, architecture, bundle, resource, archive, disk
image, and update-metadata verification on an M4 Mac. Pinned native CI and a manual fail-closed
signing workflow now cover Linux, macOS ARM64 and Intel, and Windows x64. The Intel Mac and Windows
jobs also carry an installer lifecycle gate that reuses one disposable vault and private state root
across install, interruption recovery, restart, upgrade, rollback, and removal. Those hosted
lifecycle jobs still need their first run. These are contributor artifacts, not a signed public
release.

Settings now has an About and updates page that performs no startup or background network check.
Only signed macOS and Windows release packages can initialize the updater, and checking,
downloading, and restarting to install are three explicit user actions. Development builds,
unsigned contributor packages, and Linux packages fail closed with a visible local policy; Linux
continues to use its system package manager until native package signing is complete. The signed
release feed still needs its first end-to-end rehearsal against published draft artifacts.

About and updates also exposes a privacy-safe support bundle. The same action is available as Save
privacy-safe support bundle in Ctrl/Cmd+K. It saves a mode-0600 Markdown feedback template and a
fixed allowlist of aggregate diagnostics outside the active vault. It never uploads anything and
does not include note text, filenames, vault paths or identifiers, hashes, plugin identities or
settings, raw errors, usernames, hostnames, network addresses, or locale.

For the Linux daily-drive handoff, keep the versioned AppImage as the rollback unit. Close
Threadleaf before changing versions, run the newer AppImage against the same vault and private app
data, and retain the prior AppImage until the new build has proved itself. Returning to the prior
AppImage needs no vault conversion. The automated release gate exercises this exact sequence in
both directions before an artifact is handed off.

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
- [Native extension capability contract](docs/compatibility/native-extensions.md)
- [Obsidian behavior migration](docs/compatibility/migration.md)
- [Release engineering](docs/releases.md)
- [Roadmap](docs/roadmap.md)
- [Performance baselines](docs/performance.md)
- [FOSS alternatives landscape review](docs/research/alternatives-landscape.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Beta feedback guide](docs/beta-feedback.md)

## Development

Threadleaf currently requires Node.js 22 or newer and pnpm.

```sh
pnpm install
pnpm check
pnpm start
```

On first launch, a packaged executable opens the bundled read-only demo. Use the Open control or
Ctrl/Cmd+O to select a Markdown folder. Threadleaf validates and persists a successful selection,
restores it on the next launch, and does not automatically run its compatibility plugins. The demo
is an external package resource rather than an archive-backed pseudo-filesystem, and both the
renderer and workspace runtime reject writes to it.
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
to the exact source line. Relative and vault-rooted Markdown images plus Obsidian-style raster wiki
embeds render without exposing filesystem paths or general file access to the renderer. Wiki and
Markdown note embeds can include a whole note, a heading and its descendants, or a block ID. Nested
embeds retain links, local raster images, passive attachment metadata cards, and source controls;
visible placeholders explain cycles, limits, missing targets, ambiguous targets, and unsafe paths.
Open and Reveal attachment affordances remain inert until a native capability is separately reviewed.
Ctrl/Cmd+N opens the New note dialog
and selects the resulting empty Markdown note for editing.
The Properties section in the right inspector lists top-level frontmatter in source order. Add,
Edit, and Remove support text, list, number, checkbox, date, and datetime values. Each mutation is
bound to the displayed note revision and preserves all unrelated Markdown bytes. Nested and complex
paths use the same lossless application service; unsupported normalization remains read-only with a
reason.
Ctrl/Cmd+Shift+M opens Move for the active clean note. Threadleaf commits only when the projected
vault resolver preserves every internal-link meaning. It presents the exact rewrite count before
enabling confirmation; for unusually large moves, the dialog names the first 100 target updates
and reports the full count. Unsafe ambiguous changes stay visibly blocked and write nothing. Trash has no
default shortcut, but it is available from the note toolbar and command palette and can be assigned
one in keyboard settings. Its confirmation moves the exact current revision to
`.trash/<original-path>`, warns when indexed incoming links will become unresolved, and never
overwrites an earlier deletion. Restore through the native CLI or move the file back with another
filesystem tool.

The Appearance section follows the operating-system scheme by default and can pin light or dark.
It discovers community themes and CSS snippets from the active vault, applies a selected theme
before the enabled snippets, and automatically reloads relevant external file changes. The explicit
Reload control remains available for recovery. Ctrl/Cmd+Shift+L toggles the base scheme.
Ctrl/Cmd+Alt+L clears the current vault's custom theme and snippet selection while retaining the
base scheme. Start with `THREADLEAF_SAFE_APPEARANCE=1` or `--safe-appearance` to suppress all custom
CSS for that process while keeping the saved selection available for diagnosis.

The Community plugins section discovers installed packages without executing them. Restricted mode
is the default for a vault with no saved Threadleaf plugin preference. Turn it off, then enable only
packages you trust. Threadleaf persists that selection outside the vault and reloads it on the next
start. Start with `THREADLEAF_SAFE_PLUGINS=1` or `--safe-plugins` to suppress every community plugin
bundle and stylesheet for that process while keeping the catalog and saved selection visible.
Search the Community package index to inspect metadata. Review install downloads a bounded exact
release into private staging and shows the full hashes and retained license. Only Apply reviewed
change writes the package. Review update, Review reinstall, Uninstall, and Review restore use the
same two-step contract. Every applied package stays disabled, and any later managed-byte change
locks its enable control until another reviewed install.
When a loaded plugin registers its own settings tab, an Options control opens that unchanged tab in
the compatibility surface. Closing it runs the plugin's normal settings cleanup and save lifecycle.

The Migration section reads known `.obsidian` metadata without loading community code. It shows what
could be carried into Threadleaf and what still needs review. Plugin settings values stay hidden,
Obsidian-enabled plugins are never loaded or selected automatically. Refreshing the preview starts
no new source-driven migration. It does not load plugin code or write `.obsidian/` or vault Markdown;
before reading the source, it recovers any already-journaled explicit Apply, which may persist its
private workspace state or surface a conflict. Select ready candidates and use Apply checked items to
write only private Threadleaf state outside the vault. Apply never writes `.obsidian/` or vault Markdown, and
changed plugin selection takes effect only after an explicit reload or restart. Roll back last apply
remains available unless newer private state creates a rollback conflict. See the [migration
contract](docs/compatibility/migration.md) for source limits and candidate rules.

Development and verification runs can bypass the native picker with an isolated vault copy:

```sh
THREADLEAF_VAULT_PATH=/absolute/path/to/disposable-vault pnpm start
```

This non-packaged development override is not persisted and is ignored by packaged builds. The
`pnpm check` gate verifies the packaged Electron entry points and confirms that renderer assets
remain loadable over `file://`. It also executes the built CLI against disposable synthetic-vault
copies, validates its versioned JSON envelope, proves plugin, theme, and snippet catalog output
without executing a fixture bundle or writing state, proves an exact property set/read/remove round
trip, proves alias and tag catalog output, proves an exact task read/status/toggle round trip, and
proves exact-byte delete and restore behavior. It also resolves a packaged `file=` command by unique
note name so basename compatibility cannot pass only in source-level tests, and exercises
visible-file inventory plus Unicode word counting.

The Linux editor reliability probe exercises the real Electron and CodeMirror path against a
disposable vault, including Unicode composition, undo and redo, cursor retention, dirty-navigation
guards, external-edit conflict preservation, abrupt main-renderer replacement, exact private-draft
recovery, and clean saved bytes:

```sh
pnpm run test:editor-reliability
```

The daily-note and template gate runs Electron on an isolated X11 virtual display with private app
state, a disposable vault, and CDP-routed pointer and keyboard input. It verifies settings
persistence, exact template/date/time insertion, draft-only insertion before save, recoverable
daily-note creation, no-rewrite reopening, layout containment, and light and dark captures:

```sh
pnpm run test:note-workflows
```

The packaged desktop gate opens both the bundled read-only demo and a disposable writable vault.
It drives typed property add, edit, and remove controls through the real Electron bridge, checks
exact unrelated Markdown bytes, verifies keyboard focus and command-palette reachability, and
captures dark, light, and compact layouts when a screenshot directory is supplied:

```sh
THREADLEAF_PROPERTY_SCREENSHOT_DIR=/tmp/threadleaf-property-visual pnpm run test:packaged
```

The packaged attachment gate uses an explicit X11 Xvfb display, a dedicated Electron profile and
fixture vault, and CDP to prove renderer argv, magic-byte metadata cards, exact Markdown and binary
bytes, and dark, light, and positive-control screenshots:

```sh
THREADLEAF_ATTACHMENT_SCREENSHOT_DIR=/tmp/threadleaf-attachment-visual pnpm run test:packaged-attachments
```

The representative-vault gate makes a private temporary copy, runs the packaged desktop behavior
against that copy, verifies the source bytes stayed unchanged, and prints aggregate counts and
timings without note names, content, paths, or hashes:

```sh
pnpm run test:representative-vault -- --source /absolute/path/to/vault
```

The support-bundle gate drives both visible export controls through Electron, proves the report
stays outside the vault with mode 0600, and rejects private canaries across the renderer, main
process, and generated Markdown:

```sh
pnpm run test:support-bundle
```

The publish-export gate uses a separate X11 virtual display and real CDP pointer and keyboard
input. It drives the toolbar and command palette, proves dirty drafts fail closed, verifies embedded
images and note transclusions, rejects executable markup and private-path canaries, checks exact
source-vault bytes, and renders the resulting offline page in light and dark modes:

```sh
pnpm run test:publish-export
```

The Linux upgrade gate builds a previous baseline and the current beta as byte-distinct AppImages,
then drives baseline, candidate, and rollback against one isolated vault and private-state root:

```sh
pnpm run test:upgrade-rollback
```

The native installer lifecycle contract is checked locally before hosted lanes are allowed to run:

```sh
pnpm run test:installer-lifecycle-config
```

On native x64 Windows or Intel macOS, the hosted-only package gate drives the real installer or DMG
copy path and retains failure evidence:

```sh
THREADLEAF_PACKAGE_ARCH=x64 pnpm run test:installer-lifecycle
```

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
pnpm cli --vault /absolute/path/to/vault create path="Projects/Brief" template="Templates/Project.md"
pnpm cli --vault /absolute/path/to/vault daily folder="Journal" format="YYYY/MMMM/YYYY-MM-DD" template="Templates/Daily.md"
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
pnpm cli --vault /absolute/path/to/vault plugins filter=community versions format=csv
pnpm cli --vault /absolute/path/to/vault plugin id=<plugin-id>
pnpm cli --vault /absolute/path/to/vault themes versions
pnpm cli --vault /absolute/path/to/vault theme name=<theme-name>
pnpm cli --vault /absolute/path/to/vault snippets
```

See the [CLI guide](docs/cli.md) for the output contract, exit codes, and currently supported
Obsidian-style argument spellings.

Run `pnpm benchmark:search` for the in-memory 10,000-note search microbenchmark. For the broader
public, filesystem-backed scale corpus use `pnpm benchmark:corpus` for deterministic integrity
checks or the opt-in `pnpm benchmark:scale -- --profile large` runner. The latter reports JSON for
metadata rebuild, runtime activation, watcher bursts, search, and a clearly labeled memory
observation; it does not print private paths or note content. `pnpm benchmark:scale:check` compares
p50 and robust p90 timings with the checked-in same-profile reference. These are relative
regression budgets, not universal machine-independent SLAs. See [Performance baselines](docs/performance.md)
for corpus profiles, result schema, limitations, and the reviewed baseline-update workflow.

## License

The application core is licensed under `AGPL-3.0-or-later`. A future standalone extension SDK may
use a permissive license so plugins can target Threadleaf without inheriting the application's
license.
