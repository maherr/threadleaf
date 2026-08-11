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
