# Changelog

All notable changes to Threadleaf will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once public releases begin.

## [Unreleased]

### Added

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
- Explicit Ctrl/Cmd+E reading view that safely renders the current editor draft, sanitizes raw HTML,
  preserves source-line navigation, resolves internal links through indexed metadata, blocks dirty
  note navigation, and leaves unsupported external links and attachments inert.
- Headless `threadleaf` CLI with explicit vault selection, human and versioned JSON output,
  documented exit codes, `vault info`, `files`, `read`, and `search`, plus tested `file=` and
  `query=` argument compatibility without requiring a running Electron process.
- Headless graph and outline commands for ordered outgoing links, grouped backlinks with occurrence
  counts, unresolved and ambiguous links, orphans, syntax-level dead ends, and line-aware headings.
- State-free read-only kernel opening so CLI inspection creates no application or vault data.
- Ordered session tabs with deduplicated note activation, safe neighbor selection on close,
  external rename and deletion reconciliation, dirty-draft guards, remappable keyboard actions,
  accessible horizontal overflow, and no vault-owned workspace state.
- Versioned per-vault tab restoration in private application data, with atomic mode-0600 writes,
  exact order and active-note recovery, explicit empty workspaces, stale-path pruning, and visible
  malformed-state fallback without rewriting the invalid document.
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
- Headless `properties`, `property:read`, `property:set`, and `property:remove` commands, with typed
  scalar and list serialization, conservative byte-preserving frontmatter patches, idempotent
  removal, mutation locking, revision conflicts, stable JSON, and explicit complex-YAML refusal.
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
