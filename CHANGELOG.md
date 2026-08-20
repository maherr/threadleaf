# Changelog

All notable changes to Threadleaf will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Expanded the per-vault Editor and files control center with default attachment placement, inline
  titles, readable line length, source line numbers, desktop spellcheck, tab width, and status-bar
  controls, all stored privately outside the vault with a one-click reset.
- Added a searchable, keyboard-navigable Settings window that indexes core controls and compatible
  plugin rows, restores focus across nested pages, and keeps form typography and density consistent.
- Added Obsidian 1.13-style declarative plugin settings support for common controls, validation,
  conditional visibility and disabled state, groups, lists, nested pages, add/delete/reorder
  actions, secret values, persistence, and the established imperative fallback.
- Added a full-screen reading-view image lightbox with filename and position, previous/next keyboard
  navigation, zoom, reset, wheel zoom, drag pan, Escape close, and focus restoration.
- Added a deterministic 18-case visual matrix entry for settings search and the image lightbox, plus
  two bounded image fixtures and direct lightbox state tests.
- Added a current primary-source research record for the Obsidian 1.13 settings and image seams,
  including explicit rights, reuse, and executable-proof boundaries.
- Added an exact-package workflow for the official Dataview 0.5.68 release, including reviewed Blob
  workers, the real CodeMirror 5 mode registry, frontmatter indexing, an in-place Reading-view
  table with contained native file links, both themes, and an explicit disabled-plugin fallback.
- Added an exact reviewed profile and restart-tested command-palette workflow for Advanced Tables
  0.22.1, including all 22 commands, its settings, toolbar view, ribbon action, and native editor
  integration in the combined trusted-workspace plugin matrix.
- Added exact reviewed profiles and a production editor-paste workflow for both the official and
  acceptance-vault Paste URL into Selection 1.11.4 package identities.
- Added a bounded two-phase native editor-suggestion bridge with keyboard and pointer navigation,
  revision-bound selection, isolated-plugin ownership, and visible light and dark evidence for the
  exact Natural Language Dates 0.6.2 `@to` workflow.
- Added exact installed-package workflows for Data Files Editor 1.3.0, Iconize 2.14.7, Minimal
  Theme Settings 8.2.3 with Minimal 8.2.0, and Omnisearch 1.30.1 in one isolated-renderer matrix.
- Added exact Calendar 2.0.0-beta.2 compatibility with a physical right-dock month grid, native
  Daily Notes settings, templated note creation, marker updates, both themes, and restart recovery.
- Added bounded reverse projections for plugin-authored native Files decorations, body classes, and
  CSS variables, including visible Iconize stars and Minimal's measured editor font setting.
- Added first-class `.base` files with native property tables, multiple views, bounded filtering,
  sorting, grouping, search, direct note navigation, and explicit unsupported-syntax diagnostics.

### Changed

- Kept trusted and isolated plugin surfaces alive by workspace region, so an Excalidraw document
  and Calendar sidebar can initialize, render, interact, and restore together. Trusted exact-bundle
  plugins now receive the inline style capability their real interfaces require without weakening
  the standard renderer policy.
- Applied workspace controls directly to both editor panes and the visible workbench, including
  attachment insertion defaults, without requiring an application restart or rewriting vault
  metadata.
- Refined the desktop chrome into one uninterrupted 48-pixel workbench rail with a real dock
  toggle, vault action group, full-width tab labels, overlaid tab actions, compact global controls,
  and native window controls in both themes and at the minimum supported width.
- Rebuilt Longstitch around neutral Paper and Graphite themes, compact 30-pixel explorer rows,
  coherent Hanken Grotesk interface and document typography, restrained violet interaction state,
  and less ornamental workspace chrome.
- Reworked the Files pane around consistent chevrons and file-type icons, compact header actions,
  and virtualized row geometry that scales with interface text. The default accent now matches
  Longstitch violet, while blue, teal, and orange remain explicit accessible choices.
- Made large-vault Files navigation permanently lazy: directory expansion and Reveal Active Note
  resolve only the required filesystem pages, while global inventory is reserved for operations
  that require vault-wide ambiguity resolution. A visible Markdown note not yet in the partial
  index can open through one bounded stable read without mutating that partial index; the completed
  census remains metadata authority.
- Added a private SQLite derived-index cache with per-note fingerprints, parsed metadata, search
  content, and projections. Warm startup hydrates it concurrently with a current filesystem scan,
  reparses only changed notes, and invalidates safely on schema or integrity failure.
- Replaced duplicate full-detail search persistence with a contentless, position-free trigram
  candidate index. The measured real-vault cache fell from 1.7 GiB to 553 MiB while exact cold and
  warm search pages remained equivalent, and app close now cancels an unfinished replacement
  transaction instead of waiting on optional derived work.
- Made plugin-surface environment propagation vault scoped so a candidate vault can validate its
  plugin runtime before the active vault retires its own environment bridge.
- Advanced the canonical Excalidraw packaged workflow to exercise visible authority grant and
  enablement, command-palette drawing creation, edit/save/reopen, embed insertion, PNG and SVG
  export, plugin settings, pop-out detach and recovery, plugin-renderer crash, vault switching,
  explicit reload, restart, and byte-manifest verification.
- Made trusted-workspace plugins execute in the renderer's real Node-enabled world, with literal
  Node builtins recorded and admitted only through the existing exact-package reviewed authority
  profile and package-bound grant.
- Extended the Excalidraw workflow to the trusted shared renderer, compound `.excalidraw.md`
  documents, native plugin-created leaves, visible hit-tested controls, settings in both themes,
  and scene-semantic persistence across vault switches and restarts.
- Scoped settled Markdown processing to the requested plugin, waited through live render-child
  loading before capture, and kept the captured projection behind the native Reading sanitizer.

### Fixed

- Exposed the public `Node.appendText()` DOM helper to compatibility plugins, allowing Advanced
  Tables 0.22.1 to render and persist its complete four-control Options surface.
- Kept one visible compatibility leaf per workspace region so a right-sidebar plugin no longer
  disappears when the Markdown editor has focus, and reasserted visible Electron surfaces after
  their host bounds become available.
- Carried main-document and right-dock plugin surfaces independently through isolated-runtime
  aggregation and Electron attachment, so Calendar stays visible beside Excalidraw and other
  plugin-owned documents instead of either surface replacing the other.

- Preserved a plugin view's requested file path when an unchanged plugin implements it as an
  `ItemView` rather than a `FileView`, preventing successful automatic view opens from entering a
  reopen loop after pane transfer or restart.
- Queued the latest navigator selection made during a short workspace mutation, exposed tab
  readiness through disabled controls, and kept a user's explicit return to source or live editing
  from being overridden by automatic plugin-view activation.
- Prevented a candidate vault from hanging during plugin activation behind the active vault's
  singleton plugin-environment lane.
- Prevented a recovered plugin renderer from silently re-executing plugin code after an unknown
  renderer exit; explicit reload is now required while native workspace state remains available.
- Refreshed recovered isolated runtime slots before snapshot publication, preserved fatal renderer
  exit codes, and broadcast the native workspace after plugin-surface failure.
- Preserved first-write workspace compare-and-save semantics for a deferred large-vault session
  without weakening malformed or unreadable private-state protection.
- Yielded large bootstrap and snapshot scans at bounded intervals so Electron window and IPC work
  remain serviceable during full-vault startup.
- Prevented inactive trusted-plugin leaves from invisibly covering the active canvas, even when a
  community plugin loads later CSS that forces every workspace leaf to display.
- Kept plugin-owned views and settings mounted in the visible workspace instead of leaving their
  real DOM surfaces detached behind a status placeholder.
- Preserved Dataview's strict vault-local file destinations as native Threadleaf links after generic
  projection sanitization, without restoring arbitrary plugin-authored click authority.
- Returned automatically to the active drawing after closing either Threadleaf Settings or a
  plugin-owned Options surface, while waiting for the prior child surface to detach before reopen.
- Prevented a hidden Wayland first window from deadlocking restored-vault activation when animation
  frames and `ready-to-show` were both suspended, using idempotent bounded shell-ready and window
  presentation fallbacks after the renderer document has loaded.
- Prevented an occluded Wayland window from leaving a drawing or plugin Options tab permanently
  busy by bounding the visual-frame wait before compatibility-surface attachment.
- Delivered registered compatibility `editor-paste` callbacks through revision-bound native editor
  context in isolated and trusted-workspace topologies, while preserving ordinary text paste when
  no plugin handles it or the compatibility call fails safely.
- Kept plugin editor suggestion context alive across consecutive keystrokes and placed active-menu
  navigation ahead of CodeMirror's ordinary Enter binding without changing Enter when no menu is
  open.
- Scoped callback-editor navigation suppression to host context construction so an Omnisearch
  result opened later on the same compatibility leaf reaches Threadleaf's native workspace.
- Matched the current file-explorer deferred-leaf API used by Iconize and reapplied persisted vault
  font size during compatibility startup, allowing installed plugin data, navigator decoration,
  native appearance, and Omnisearch navigation to reconstruct cleanly after an application restart.
- Matched Obsidian's check-callback execution semantics, exposed table ranges through the public
  metadata-cache section contract, and committed revision-bound plugin editor updates through the
  vault kernel before reporting command success.
- Prevented package inspection from treating module-like text inside JavaScript strings, comments,
  templates, or regular expressions as executable dependencies, while continuing to reject real
  dynamic imports, absolute module paths, and arbitrary dynamic evaluation.

## [0.1.0]

### Added

- Published the canonical open-source repository, first public Linux download path, verified
  application screenshot, private vulnerability-reporting channel, and exact version-bound release
  documentation.

- Added the exact reviewed Style Settings 1.0.9 appearance bridge and
  `style-settings.snippet-control-live-reload.v1` Linux workflow. The unchanged package can
  discover source-bearing appearance CSS, use the isolated renderer's immutable `activeWindow`,
  update class and variable controls live, and reconstruct saved state after snippet toggles,
  renderer replacement, and application restart. The registry records this as Level 3 supporting
  evidence; no Level 4 receipt or production issuer key was added.

### Changed

- Promoted the verified Linux x86_64 daily-driver lane from prerelease status to the stable 0.1.0
  release while keeping macOS and Windows packages unpublished until signing and notarization.
- Made a fresh install arrive on the read-only welcome note with an explicit **Open folder** action
  and file-ownership guidance, while restored user vaults still return to their private workspace.
- Put the recovery-backed **Create a note** action and its remappable shortcut directly in an empty
  writable pane, and made command-palette counts distinguish all results from runnable commands.

### Fixed

- Selected native visual-matrix controls by their exact option index instead of assuming the
  runner's select popup always advances one value on its first ArrowDown event.
- Bounded hosted Linux package acquisition, reused the runner's asserted RPM and Xvfb tools, and
  kept the real FUSE-mounted AppImage gate from being stranded by a stalled Ubuntu mirror.
- Made the reviewed-plugin acceptance harness set and restore its supported 860 by 640 viewport
  explicitly, so clean hosted runners exercise the intended minimum instead of inheriting the
  desktop window default.
- Prepared and asserted the development Electron runtime's exact root-owned Chromium helper before
  the reviewed-plugin end-to-end gate, without disabling or changing that gate's sandbox.
- Made packaged lifecycle acceptance deterministic by acknowledging the CDP close request before
  Electron tears down its renderer.
- Rebuilt Live Preview decorations when CodeMirror advances a cold syntax tree, so an initially
  deferred callout or other parsed structure appears without requiring a user edit.
- Retried the bounded Windows delete-pending `EPERM` window around native-extension grant locks,
  while preserving persistent permission failures and serialized revoke/save semantics.
- Prevented restored startup from deadlocking when a plugin-catalog read and deferred vault
  activation arrived in either event order. Catalog readiness now waits outside the shared private
  mutation queue instead of holding that queue while activation waits behind it.
- Bounded every native lifecycle readiness observation, exercised the real macOS `before-quit`
  autosave path without racing it against last-window closure, and retained rendered progress
  evidence on failure.
- Split hosted Linux packaging at the unpacked-app boundary so CI repairs and verifies the exact
  root-owned Chromium helper Electron will launch before any packaged UI check runs.
- Kept Linux artifact creation on that already-verified unpacked tree, and made the AppImage native
  probe launch the mounted artifact instead of a user-owned extracted sandbox helper.
- Made startup plugin safe mode bypass compatibility-renderer construction entirely, so recovery
  launches can restore the selected vault even when a platform cannot start the hidden plugin
  surface.
- Made hidden compatibility-renderer style settlement independent of animation frames and timers,
  so native package startup and environment replacement cannot stall behind a hidden surface.
- Kept accent-insensitive search folding predictably linear on large NFC text while preserving
  canonical equivalence, dotted-I behavior, emoji clusters, and mixed scripts.
- Normalized native Windows version framing, queried Authenticode through hosted PowerShell, and
  made forced lifecycle cleanup stop the Electron root before tracking descendants through a quiet
  window, preventing recovery children from escaping into the next launch.
- Kept Linux package verification inside Chromium's user-namespace sandbox when the unpacked
  setuid helper is not root-owned.
- Prevented a rapid second theme toggle from being advertised while the first appearance change is
  still persisting, so an accepted click is never silently dropped.
- Kept Live Preview transclusion identity, source preview, and nested preview readable in a split
  pane instead of collapsing the source label into one-character columns.
- Kept native attachment Open responsive on Linux despite Electron 43's unresolved `openPath`
  promise, without exposing a packaged test receiver or weakening attachment containment checks.

## [0.1.0-beta.7]

### Added

- Added a filesystem-truthful Files navigator for visible folders, Markdown notes, JSON Canvas
  documents, and ordinary files, including explicit empty folders, typed activation, deterministic
  natural ordering, and immediate guarded folder creation.
- Added a transient read-only ordinary-file inspector with exact vault and inventory identity,
  bounded inert UTF-8 text, byte-sniffed raster images, metadata-only binary formats, responsive
  modal focus restoration, and no document, tab, history, shell, or renderer-filesystem authority.
- Added an explicit source-removing **Rename or move** action for passive attachments, with
  `always`, `ask`, and `never` link-update policy, exact rewrite previews, recoverable compound
  transactions, complete Markdown and JSON Canvas reference-corpus receipts, byte-local Canvas file
  and group-background reference rewrites, and visible refusal when Canvas safety cannot be proved.
- Added vault-bound native **Open** and **Reveal** attachment actions with owned-renderer IPC,
  canonical containment, exact-revision and bounded-read validation, byte-and-suffix Open approval,
  unknown-byte Reveal fallback, redacted native failures, and packaged main-receiver proof.
- Added a two-step **Relink** action for one missing passive attachment embed, with an exact target
  preview, source and candidate revision binding, final resolver-level namespace and containment
  checks, recoverable conflict copies, vault-switch-safe receipts, and packaged dark/light pointer
  and keyboard proof.
- Added exact-path **Restore file** for one missing passive attachment embed through a shared
  external-byte ingress authority, with renderer-owned file selection, byte-bound two-step review,
  source-note preservation, strict no-overwrite publication, crash recovery, retained uncertain
  evidence, and packaged dark/light exact-byte proof.
- Added card-scoped single-file drag-and-drop and file-backed **Paste file** recovery as thin
  adapters over the same Restore file preview and ingress transaction, with directory, multi-file,
  text, HTML, URL, unsafe-name, unreadable, and oversized-input refusal.
- Added one-file editor drop and file paste with pointer or selection placement, editable
  source-folder destination proposals, configured wiki or Markdown embeds, byte-and-note-bound
  two-step review, strict no-overwrite publication, restart recovery, conflict-copy preservation,
  and packaged dark/light exact-byte proof.

### Changed

- Advanced the canonical Excalidraw packaged workflow to the exact 2.26.4 release, preserving raw
  manifest bytes, binding manifest, main, stylesheet, package-tree, and reviewed-authority identity,
  and proving clean restart from persisted sealed authority without granting again.
- Decoupled the Files inventory generation from the Markdown metadata generation. Physical scans
  now run outside the index mutation lock, reject invalidated candidates, retain the last complete
  tree on failure, and retry without publishing partial state.
- Reused the physical inventory captured during restored startup and made stale tree pages
  single-flight an authoritative snapshot refresh.

### Fixed

- Aligned current release documentation and default extension-porting report metadata with
  `package.json` version 0.1.0-beta.6.
- Required the real Excalidraw canvas to be visible after detach, reattach, and pop-out crash
  recovery before accepting screenshots, eliminating placeholder-only visual false positives.
- Made the canonical Electron Live Preview gate wait for completed pane actions and explicitly
  prove the hidden restored-vault settings state before promoting its bounded public conformance
  record to verified.
- Retargeted the community-theme live cue probe and refreshed its 20 verified baselines for the
  typed Files tree while preserving deuteranomaly, non-color, minimum-viewport, high-contrast, and
  tampered-baseline controls.
- Returned the JSON Canvas Save control to its clean disabled state after a committed write, and
  kept group containers behind ordinary nodes so covered file and edit controls remain pointer
  reachable.
- Added truthful, type-specific keyboard instructions and shortcut metadata to Live Preview
  callouts while preserving Enter/Space exact-source reveal.
- Restored visible keyboard-focus frames around command palette and quick-switcher queries, and
  raised repeated note view and tab close controls to the WCAG 2.2 24px target-size floor.
- Kept the visible note census, paginated file total, and vault count synchronized after external
  note additions, deletions, and sync-style event bursts.
- Rejected traversal through a relative folder symlink at any path ancestor while retaining safe
  contained file aliases and excluding broken, private, outside-vault, and special-file targets.
- Kept supported attachment links and embeds out of the note-link inspector and unresolved
  note-link totals after insertion.

## [0.1.0-beta.6]

### Added

- First-class inline and frontmatter tags, including Reading and Live Preview pills, an incremental
  vault-wide index, a `tag:` search operator, and a keyboard-accessible navigator with hierarchical
  usage counts.
- Interactive Markdown task toggles in Live Preview and Reading view for open, completed,
  cancelled, question, nested, quoted, and custom marker states.
- Obsidian-compatible callouts in Reading view and Live Preview, including the 13 standard types,
  aliases, nested content, view-local folding, and strict malformed-input handling.
- Longstitch, Threadleaf's bespoke Pressroom and Lampside design language, with a canonical token
  source, self-hosted Literata, Hanken Grotesk, and JetBrains Mono variable fonts, OFL license
  files, design foundations, and an automated WCAG plus Machado/CIEDE color gate.

### Changed

- Continuous autosave now debounces Markdown writes, flushes before every data-loss transition,
  retries failed writes while keeping them pending, preserves external on-disk changes as conflict
  notes, and keeps Undo as the revert path.
- Removed manual "Save or revert" transition gates in favor of the recovery-backed continuous
  autosave model.
- GitHub package metadata fetches optionally authenticate only to `api.github.com` with
  `GITHUB_TOKEN` or `GH_TOKEN`; public-index and release-asset downloads remain unauthenticated.
- Reworked the knowledge workspace around warm paper and walnut materials, a sewn navigator spine,
  brass active-note knot, square foil-label tags, theme-specific headband and lamp-pool signatures,
  book-led note typography, a two-row navigator action header, and proportionally scaling reading
  headings.
- Callouts now use shared paper or walnut grounds plus a measured strong border and icon ink,
  distinct glyph, and visible title instead of relying on pale categorical tints.
- Completed, cancelled, question, open, nested, and custom Markdown tasks now retain distinct text,
  shape, and accessible-state treatments in Live Preview and Reading view.

### Fixed

- Graceful shutdown now flushes queued editor changes before exit.
- macOS native-target verification uses headless Electron Node and canonical temporary paths; build
  helpers preserve the `lipo` result required for universal-architecture verification.
- Frontmatter tag keys are case-insensitive, tag catalogs retry after a census transition, and leaf
  counts are labeled as uses.
- Live Preview callouts no longer disappear around protected inline content or unresolved
  frontmatter, and callout type identifiers reject Unicode lookalikes.
- Reserved native checkbox completion semantics for `x` and `X` tasks, so cancelled, question, and
  custom markers are no longer exposed as checked tasks.
- Restored visible table-header material, eliminated navigator New-action clipping, and raised
  callout border and focus contrast in both themes.

## [0.1.0-beta.5]

### Added

- Navigator folder tree with a virtualized tree from the workspace index, WAI-ARIA semantics and
  keyboard navigation, per-vault expansion persistence, reveal-active behavior, and guarded folder
  creation.

### Fixed

- Dot-folder containment and bounded-cache fixes for workspace navigation.

### Added

- Versioned main-process resource policy for compatibility renderers, with operation-specific
  startup and close deadlines, conservative 512 MiB memory and sustained 60 percent CPU
  guardrails, injectable deterministic metrics and clocks, explicit unavailable metrics, structured
  diagnostics, culprit-only recovery, lifecycle cleanup, support-bundle projection, and a built
  Xvfb deadline/isolation fixture. These are trusted-host guardrails, not OS sandboxing.
- Generated machine-readable and Markdown plugin compatibility registries with exact plugin and
  Threadleaf version binding, bundle digests, static authority classes, platform limits, named
  workflow gates, failures, limitations, deterministic drift checks, and a live exact-release
  verification path. Community package discovery is now labeled separately from compatibility
  evidence.
- Initial project charter, architecture, compatibility contract, and execution roadmap.
- Read-only synthetic Markdown vault fixture.
- Independently implemented compatibility API for plugin, vault, command, file, and notice behavior.
- Trusted CommonJS plugin host with observable load, command, unload, and reload lifecycles.
- Isolated Electron renderer with light and dark runtime-inspection surfaces.
- Tests proving the fixture remains byte-for-byte unchanged and rejecting plugin paths outside the
  active vault.
- Build verification for Electron entry points and relative `file://` renderer assets.
- Safe vault-kernel foundation with canonical path containment, stable content revisions,
  single-writer serialization, durable recovery journals, no-clobber writes, explicit conflict
  copies, recoverable renames, and interruption-matrix tests.
- Sequenced and debounced filesystem watcher with inode-based rename pairing, full or targeted
  subtree rescan requests, operation-aware attribution, and a live backend fixture.
- Rebuildable Markdown metadata index for headings, basic properties, tags, links, embeds,
  backlinks, duplicate names, and unresolved targets, with incremental-versus-clean equivalence
  tests across the real writer and watcher seam.
- Mutation port and durable multi-file roll-forward transactions with prevalidated proposal blobs,
  per-entry keep-both conflicts, nested journal recovery, and operation-wide watcher attribution.
- Production workspace runtime that composes the kernel, watcher, metadata index, action registry,
  and compatibility host behind narrow Electron IPC.
- Three-pane knowledge workspace with note filtering, navigation, headings, tags, outgoing links,
  backlinks, external-change updates, and keyboard-first controls.
- CodeMirror Markdown source editing with explicit dirty state, Revert, Ctrl/Cmd+S, revision-aware
  recoverable saves, non-destructive external-edit warnings, and indexed conflict copies.
- Versioned private editor drafts with exact vault, note, base-revision, content, and selection
  binding; atomic mode-0600 persistence; exact-identity cleanup; note-scoped undo history; and
  automatic main-renderer replacement that restores unsaved bytes without overwriting a changed
  disk note.
- CSP-nonce integration for CodeMirror's generated styles and an isolated-vault development launch
  override for live save and conflict verification.
- Native local-folder picker with Ctrl/Cmd+O, private persisted selection, validated runtime swaps,
  startup restoration and fallback warnings, vault-bound save protection, and plugins kept off by
  default for selected vaults.
- Searchable Ctrl/Cmd+K command palette that routes visible controls and hotkeys through shared
  core and compatibility-plugin actions, skips unavailable commands during keyboard navigation,
  and explains disabled states.
- Versioned, app-owned keyboard settings with portable Ctrl/Cmd bindings, collision validation,
  per-command recording and clearing, atomic private persistence, reset-to-default behavior, and
  visible recovery from malformed settings without touching the vault or `.obsidian/`.
- Vault-wide saved-content search across paths, headings, tags, properties, fenced code, and body
  text, with AND terms, quoted phrases, ranked contextual matches, bounded work, line navigation,
  stale-response protection, and automatic convergence after saves and external filesystem edits.
- Deterministic 10,000-note search microbenchmark and scale fixtures for rebuild, rare-query, and
  broad-query behavior.
- Public deterministic benchmark corpus generator and manifest hashes for smoke, standard, and
  large vault shapes, with index/link correctness checks, watcher-burst and runtime-activation
  measurements, machine-readable results, reviewed relative regression budgets, and an explicit
  opt-in timing gate. Private vault paths and note content never enter benchmark output.
- Explicit Ctrl/Cmd+E reading view that safely renders the current editor draft, sanitizes raw HTML,
  preserves source-line navigation, resolves internal links through indexed metadata, blocks dirty
  note navigation, and leaves unsupported external links and attachments inert.
- Default Live Preview plus explicit Source and Read modes, with pane-local presentation state,
  exact source reveal on cursor and selection lines, common Markdown styling, contained raster
  images, source-backed note-embed cards, editable task markers, internal-link activation, and
  honest source fallback for unsupported syntax.
- Headless `threadleaf` CLI with explicit vault selection, human and versioned JSON output,
  documented exit codes, `vault info`, `files`, `read`, and `search`, plus tested `file=` and
  `query=` argument compatibility without requiring a running Electron process.
- Headless graph and outline commands for ordered outgoing links, grouped backlinks with occurrence
  counts, unresolved and ambiguous links, orphans, syntax-level dead ends, and line-aware headings.
- Read-only Obsidian-style `plugins`, `plugin`, `themes`, `theme`, and `snippets` catalog commands,
  backed by bounded contained desktop loaders with deterministic text and JSON, explicit source
  states, no plugin execution or writes, and private-state-safe projections.
- State-free read-only kernel opening so CLI inspection creates no application or vault data.
- Ordered session tabs with deduplicated note activation, safe neighbor selection on close,
  external rename and deletion reconciliation, dirty-draft guards, remappable keyboard actions,
  accessible horizontal overflow, and no vault-owned workspace state.
- Versioned per-vault tab restoration in private application data, with atomic mode-0600 writes,
  exact order and active-note recovery, explicit empty workspaces, stale-path pruning, and visible
  malformed-state fallback without rewriting the invalid document.
- Two independently focusable editor panes with horizontal or vertical splitting, pane-local tabs,
  CodeMirror state, selection, undo history, and crash drafts; explicit tab transfer and pane
  collapse; and persisted active-pane and split-direction recovery.
- A rollback-compatible workspace document that keeps a validated version 1 projection of the
  active pane beside the complete version 2 layout extension, allowing the previous daily-driver
  build to reopen and write the same private state without touching vault files.
- Ordered per-pane pinned workspace tabs with an explicit private `pinnedPaths` layout member,
  deterministic pin and unpin placement, close and Markdown-trash refusal, rename and watcher
  reconciliation, pane transfer and collapse preservation, and rollback-safe focused-pane
  projection. The visible Pin or Unpin tab control, command palette, native Workspace menu, and
  remappable hotkey target share one vault-bound action. Isolated X11 Electron coverage drives real
  pointer and keyboard input, verifies restart persistence and close refusal, and captures dark,
  light, minimum-width, and visual-positive-control evidence.
- Pointer and keyboard tab reordering within and across panes, persistent collapsible notes and
  inspector docks, and native compatibility-plugin pop-out windows with private bounds, explicit
  reattachment, vault-switch cleanup, stale-session detection, and crash recovery back into the
  main workspace. Layout IPC is restricted to the active Threadleaf renderer, and plugin windows
  never write layout metadata into the vault.
- Native desktop File, Edit, Workspace, View, and Help menus whose accelerators follow the saved
  key bindings and whose commands target the focused workspace through the shared action surface.
- Desktop move and rename through the whole-vault link-integrity preflight, with vault and revision
  binding, exact before/after blocker evidence, no-clobber conflicts, dirty-draft protection,
  remappable Ctrl/Cmd+Shift+M, and open-tab remapping after a successful move.
- Recoverable CLI delete, trash inspection, and restore with exact-path vault-local `.trash/`
  storage, revision and collision checks, crash recovery, exact-byte build smoke coverage, and
  exclusion from ordinary note, watcher, workspace, search, and image surfaces.
- Confirmation-gated desktop Trash action over the shared recoverable deletion service, with vault
  and revision binding, exact source and recovery paths, indexed-link impact, explicit collision
  errors, dirty-draft protection, command-palette and remappable-keyboard access, operation-aware
  watcher attribution, and deterministic neighbor selection after commit.
- Desktop File Recovery with a bounded vault-bound catalog, original and recovery path filtering,
  exact-revision restores, no-overwrite collision preservation, immediate watcher and index
  convergence, native menu and command access, focused conflict diagnostics, and isolated
  dark, light, narrow, and deuteranomaly verification.
- Ordered per-vault note bookmarks in private mode-0600 application state, with toolbar, command,
  native-menu, and remappable-hotkey access; serialized persistence; internal-move remapping;
  explicit missing-note rows; no vault metadata; restart coverage; and isolated real-input dark,
  light, narrow, and moderate-deuteranomaly verification.
- Standalone active-note HTML export through the toolbar, command palette, native File menu, and
  remappable hotkey target, with sanitized raw markup, embedded local raster images and note
  transclusions, inert vault-only links, safe external links, restrictive CSP, responsive light,
  dark, and print styling, exact revision and stable-disk checks, outside-vault mode-0600 atomic
  writes, dirty-draft refusal, and isolated real-input and rendered-document coverage.
- Headless `properties`, `property:read`, `property:set`, and `property:remove` commands, with typed
  scalar and list serialization, conservative byte-preserving frontmatter patches, idempotent
  removal, mutation locking, revision conflicts, stable JSON, and explicit complex-YAML refusal.
- Ordered desktop property inspection and typed add, edit, and remove controls for text, list,
  number, checkbox, date, and datetime values, backed by the same revision-bound mutation service,
  with dirty-note guards, explicit complex-value refusal, and packaged visual and exact-byte tests.
- Source-offset-preserving wiki and Markdown link parsing plus deterministic move-rewrite planning,
  including fenced and inline code exclusion, HTML-comment exclusion, alias and anchor retention,
  relative-path regeneration, ambiguity refusal, and final projected-index validation.
- UTF-8 BOM retention at the vault read boundary so revision-aware rewrites preserve BOM and CRLF
  bytes instead of silently normalizing them.
- Crash-recoverable compound note moves with exact rewrite previews, SHA-256-bound desktop
  confirmation, explicit CLI `--update-links`, child-first recovery, reverse rollback, conflict
  copies, affected-index refresh, and compound watcher attribution.
- Headless `tasks` and `task` commands with vault-wide or exact-note scanning, completed, incomplete,
  and custom-status filters, exact `path:line` addressing, source-range-only status mutation,
  no-op detection, recovery-backed conflicts, and code and comment exclusion.
- Headless `aliases`, `tags`, and `tag` commands with exact-note filtering, deterministic alias
  source paths, distinct tag names, raw occurrence totals, count sorting, and verbose carrying-file
  output from the rebuildable metadata index.
- Shared `file=` note-name resolution across existing-note CLI commands, with optional `.md`,
  case-insensitive NFC matching, canonical resolved paths, and explicit missing or duplicate-name
  failures instead of arbitrary selection.
- Headless `file`, `folder`, `folders`, and `wordcount` commands plus expanded `files` filters over a
  safe visible-file inventory, including attachments, recursive sizes, Unicode counts, private-tree
  exclusion, and contained file-symlink handling.
- Obsidian-style CLI search folder, limit, case, total, and text/JSON output controls plus a separate
  grep-style `search:context` command, backed by the same bounded rebuildable index.
- Graph and outline CLI totals, backlink and unresolved counts, verbose unresolved sources,
  JSON/TSV/CSV output, and tree/Markdown/JSON outline formats with deterministic empty output.
- Read-only discovery of standard vault community-plugin packages with bounded manifests, bundles,
  and stylesheets, realpath containment, deterministic catalogs, and invalid-package diagnostics.
- Version 3 private per-vault plugin preferences with restricted mode by default, explicit trusted
  enablement, immutable settings helpers, atomic persistence, and version 1 and 2 migrations.
- Multiple independent compatibility-plugin lifecycles with startup reconciliation, targeted and
  bulk reload, clean unload, retained activation failures, and one plugin failing without hiding or
  blocking the rest of the runtime inventory.
- Community-plugin Settings with installed-package search, runtime and package status, enable
  switches, recovery diagnostics, familiar normalized desktop geometry, small-window behavior,
  keyboard names and focus, and verified light, dark, and moderate-deuteranomaly states.
- Pre-enablement plugin reports with the declared minimum Obsidian version, desktop-only flag,
  standard bundled-dependency model, and exact-version compatibility evidence. Unknown versions
  remain visibly discovered at level 0 instead of inheriting another release's test result.
- Version 4 private plugin settings with conservative static authority reports and explicit
  per-vault grants bound to the exact raw `main.js` SHA-256 digest. Ungranted or byte-changed
  bundles and their stylesheets stay blocked, direct IPC enablement fails closed, and revocation
  disables and unloads the plugin. The execution renderer rechecks raw bytes immediately before
  compilation to close replacement races. Version 3 settings migrate without inherited grants.
- Reviewable plugin install, update, reinstall, rollback, uninstall, and restore through a
  replaceable package-source interface, with exact GitHub release pins, retained license and
  SHA-256 evidence, disabled-by-default apply, data-preserving updates, five-version private
  history, managed-byte lockout, and durable process-interruption recovery. The current adapter
  reads but does not redistribute the public unlicensed community package index.
- Read-only Obsidian behavior migration preview for enabled and installed plugins, settings-file
  shape without private keys or values, reviewed hotkey candidates, appearance assets, and
  restorable note tabs, with bounded contained reads and exact source-byte preservation.
- Non-blocking initial window through a plugin-free bootstrap runtime, explicit target-indexing
  state, disabled bootstrap mutations and search, late-restore supersession, failure fallback, and
  an isolated production startup-readiness probe with optional dark and light captures.
- Single-read target activation that seeds watcher and metadata state from the same stable Markdown
  snapshots, excludes dot-prefixed trees from ordinary corpus activity, caches index-generation
  projections, and verifies both full-vault readiness and clean exit.
- Main-process live reloading for selected Obsidian-compatible themes and CSS snippets. The
  generation-bound watcher observes only appearance sources and their replacement sentinels,
  coalesces external save storms into bounded loader rescans, preserves private selections through
  missing or invalid files, and never writes `.obsidian/` or exposes filesystem authority to the
  renderer. An isolated X11 Electron fixture verifies live computed-style updates, diagnostics,
  restoration, source-byte preservation, and dark and light captures.
- Virtualized file navigation with a bounded overscan window, full scroll geometry, active-note
  reveal, and absolute accessible item positions for large vaults.
- Plugin startup safe mode through `THREADLEAF_SAFE_PLUGINS=1` or `--safe-plugins`, preserving the
  private selected set while loading no community JavaScript or CSS.
- One Electron renderer process and transient session partition per compatibility plugin, with Node
  integration isolated from the sandboxed main renderer, typed lifecycle IPC, denied permissions
  and navigation, operation timeouts, renderer-exit attribution, and production activation of the
  unchanged Excalidraw bundle.
- Culprit-only compatibility-renderer recovery for timed-out operations, invalid protocol
  responses, send failures, and renderer crashes. A production fixture proves the culprit PID is
  replaced while a healthy sibling plugin and the native workspace continue responding.
- Visible community-plugin `ItemView` attachment in a bounded child surface, including filename
  headers, plugin action icons, light/dark chrome propagation, view lifecycle, and layout snapshots.
- Compatibility implementations for workspace view factories, metadata and frontmatter caches,
  Markdown rendering, modal structure, and open Lucide icons, with executable synthetic fixtures.
- Baseline Obsidian-compatible settings controls, global DOM element factories, JavaScript utility
  aliases, component load state, accent-color lookup, and sanitized HTML-to-DOM conversion used by
  the unchanged Excalidraw bundle.
- Revision-bound compatibility-plugin writes for existing files, validated against the active vault
  and routed through the workspace controller and recovery-backed writer with explicit conflict
  retention.
- A measured level 4 workflow for opening an existing Excalidraw Markdown document, mutating its
  scene, saving it through the compatibility vault, closing its plugin-owned leaf, and reopening the
  exact persisted scene in the production Electron host.
- Recovery-backed compatibility-plugin folder and file creation through vault-bound IPC, with
  private-path, symlink, no-overwrite, durability, indexing, and native-workspace activation guards.
- Moment, loaded-plugin lifecycle, workspace-layout, split-leaf, and built-in Markdown-view
  compatibility required by Excalidraw's unchanged new-drawing workflow.
- A measured level 4 workflow for running Excalidraw's new-drawing command, opening the generated
  custom view, saving deterministic scene elements, fully closing it, and reopening the exact
  persisted scene in the production Electron host.
- Document-view selection and teardown rules that reserve Excalidraw views for supported files,
  keep ordinary Markdown in the native editor, and remove the child plugin surface on leaf close.
- Plugin stylesheet preservation with external asset URLs replaced by inert embedded data,
  explicit diagnostics, and live proof that Excalidraw CSS applies without network requests.
- Plugin-surface presentation control that lets Threadleaf's command palette overlay a live child
  view without closing its plugin leaf, losing command context, or destroying renderer state.
- Independently implemented `parseFrontMatterEntry`, `Vault.createBinary`, and
  `Vault.modifyBinary`, with validated active-vault IPC and recovery-backed exact-byte writes.
- Measured level 4 Excalidraw workflows for auto-creating a drawing and inserting its native-editor
  embed, plus SVG-to-vault and PNG-to-vault creation and overwrite with parsed-image verification.
- Public `Workspace.detachLeavesOfType` compatibility plus plugin-owned modal tracking, with a
  measured active-canvas Excalidraw unload and two clean reload cycles that remove and restore the
  exact command, view, processor, suggester, ribbon, settings, leaf, and transient-UI inventory.
- Public `Vault.rename` and `FileManager.renameFile` compatibility for revision-bound plugin files,
  routed through the active workspace's recovery journal, watcher suppression, index refresh, and
  open-path remapping with explicit stale-revision conflict retention.
- An executable Excalidraw byte-compatibility corpus covering real plugin Markdown, PNG, and SVG
  fixtures, external edits, interrupted writes and renames, conflict proposals, recovery, and exact
  SHA-256 preservation, plus a live unchanged-plugin attachment rename through Electron.
- Public `FileManager.trashFile` compatibility for revision-bound files, implemented as an
  active-vault-validated, recovery-journaled move into `.trash` with delete-event delivery, watcher
  attribution, index convergence, stale-edit conflict detection, and exact-byte live proof in the
  unchanged Excalidraw renderer.
- Per-plugin Options surfaces for registered `PluginSettingTab` instances, with typed Electron IPC,
  light and dark styling, no-note operation, save and reopen behavior, deterministic hide and
  unload cleanup, and live unchanged-Excalidraw verification across 200 setting rows.
- Contained `Vault.getResourcePath` and read-only desktop `FileSystemAdapter` compatibility,
  including exact binary reads, hidden-file reads, internal-symlink support, external-symlink
  rejection, file URL helpers used by Excalidraw, and byte-exact public Base64 and hex codecs.
- Public `prepareFuzzySearch` with deterministic higher-is-better scoring and UTF-16 highlight
  ranges, plus DOM and string `htmlToMarkdown` conversion backed by the MIT-licensed Turndown
  library, both exercised through the unchanged CommonJS plugin bridge.
- Public desktop `Platform` flags, cancellable `debounce`, tooltip metadata, and accessible DOM
  `Menu` behavior with custom icons, labels, checked, disabled, warning, section, separator, click,
  outside-dismissal, Escape, and keyboard-focus states.
- Public `PopoverSuggest` and `AbstractInputSuggest` compatibility, including bounded asynchronous
  type-ahead results, pointer and keyboard selection, and the current Excalidraw release's vault
  path suggester superclass.
- Unsigned Linux x64 AppImage and RPM packaging with a stable application identity, desktop entry,
  scalable icon, complete project metadata, bundled AGPL license, and SHA-256 artifact checksums.
- A packaged first-run demo copied outside `app.asar`, classified as read-only by the backend and
  renderer, protected from development vault overrides, and smoke-tested against a forged preload
  mutation as well as visible light and dark states.
- Exact AppImage end-to-end smoke coverage, RPM metadata and payload inspection, installed-RPM
  verification, and a two-build reproducibility proof for unpacked application trees and normalized
  tar.xz archives with complete file manifests.
- Manual signed-release update support with no startup or background checks, explicit check,
  download, and restart-to-install actions, fail-closed package trust markers, sanitized errors,
  Linux package-manager guidance, and packaged light, dark, and minimum-viewport Settings proof.
- A privacy-safe representative-vault desktop gate that copies a real corpus into private
  temporary storage, exercises large-note editing, raster attachments, external and burst edits,
  link-updating rename, restart recovery, and source-byte preservation, then reports aggregates
  without note names, content, paths, or hashes.
- A one-command privacy-safe support bundle with an embedded beta feedback template, an exact
  aggregate-only schema, main-renderer authority, outside-vault and symlink containment, atomic
  mode-0600 writes, no upload path, private-field canary tests, and live About-page plus
  command-palette verification in light and dark themes.
- A reproducible Linux daily-drive handoff gate that builds byte-distinct baseline and candidate
  AppImages, drives baseline, upgrade, and rollback over one vault and private-state root, preserves
  exact note bytes, selection, hotkeys, appearance, and tabs, and proves the rollback stays writable.
- A renderer-to-main startup handshake that paints the opening workspace before restored-vault
  activation begins, plus cooperative metadata construction that yields during large corpus builds.
- Obsidian-style raster wiki-image embeds through the existing contained, MIME-sniffed, bounded
  preview authority.
- Read-only Markdown note transclusions in Reading view for whole notes, headings, and block IDs,
  including recursive rendering, exact source controls, index-resolved nested links, internal
  raster images, explicit unavailable states, and cycle, depth, count, byte, containment, and
  stale-vault guards.
- Bounded whole-vault move planning that reuses the current metadata snapshot and reads full bytes
  only for the source and documents whose links require rewriting.
- Recovery-backed daily notes and templates across the desktop and native CLI, with exact title,
  date, and time expansion; private per-vault workflow settings; no-rewrite opening of an existing
  daily note; insertion at the CodeMirror selection; native menus and commands; and isolated X11
  virtual-input verification in light and dark themes.
- Bounded global and local vault graphs derived from the rebuildable metadata index, with path,
  title, and tag filtering; optional orphan notes and direction arrows; one-to-four-step local
  traversal; deterministic layout; pointer and keyboard pan and zoom; focusable note nodes; an
  equivalent visible-note list; persisted private view preferences; stale-vault guards; and
  isolated X11 virtual-input verification in light, dark, and simulated deuteranomaly views.
- A published `--interactive` compat variable for community themes that read a bare accent source
  (e.g. Sanctum), and an unthemed `default` subject added to the community-theme visual matrix so
  Threadleaf's own baseline is measured against the same accessibility standard as every theme.

### Fixed

- Settings now opens during startup background scans, so a clickable Settings control cannot fail
  silently while plugin and appearance catalogs are still loading.
- Electron shutdown now starts watcher and plugin cleanup together, detaches watcher publication
  immediately, bounds a busy plugin renderer's courtesy close without deliberately crashing it,
  coalesces repeated quit events, and still reaches the final quit after errors.
- Compatibility views now await public `onOpen` and `onClose` hooks around state and component
  lifecycles, and still unload resources and detach their containers when close hooks fail.
- Plugin-surface CSS handoff now retains the stable Electron `WebContents` object, so replacing a
  crashed compatibility view cannot dereference Electron's invalidated view getter.
- Community-theme body-level design tokens (`--canvas`, `--surface*`, `--ink*`, `--line*`,
  `--accent-soft`, `--interactive`, `--signal*`, `--mono`) are now re-declared at `body`, where a
  community theme's own supporting constants actually reach, instead of staying inherited-only
  from `:root`; fixes Sanctum's categorical colours collapsing to black. `--accent-soft`'s accent
  mix widened from 14% to 25% and re-anchored to `--accent`, clearing a below-floor deuteranomaly
  contrast in Threadleaf's own default light scheme and staying pinned under the accessibility
  "Accent" preference. Reading-view body copy (`.note-preview`) now paints with `--ink` instead of
  `--ink-soft`, raising Minimal light's contrast from 4.23:1 to 17.58:1 and clearing the WCAG AA
  4.5:1 floor for normal text.
